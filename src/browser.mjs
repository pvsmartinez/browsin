import { spawn, execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { CDP } from './cdp.mjs';
import { COLLECTOR } from './collector.mjs';
import { QUERY } from './query.mjs';
import { ensureDirs, findBinary, readState, writeState, PORT, PROFILE, ROOT } from './paths.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const endpoint = (path) => `http://127.0.0.1:${PORT}${path}`;

const probe = async () => {
  try {
    const res = await fetch(endpoint('/json/version'), { signal: AbortSignal.timeout(700) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

const isAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * The pid listening on the CDP port, asked of the OS instead of of state.json.
 *
 * State is disposable by design (`/tmp`), so a browser can outlive the file
 * that remembers it — a cleaned `/tmp`, a second BROWSIN_DIR, a `down` that
 * raced. Before this existed, such a browser was unkillable through browsin:
 * `down` had no pid to signal, deleted the state anyway, and reported success
 * while a headless shell kept serving the port forever.
 */
const portOwner = () => {
  for (const args of [['-t', '-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN'], ['-t', `-i:${PORT}`]]) {
    try {
      const out = execFileSync('lsof', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const pid = Number(out.trim().split(/\s+/)[0]);
      if (pid) return pid;
    } catch { /* lsof missing, or nobody listening */ }
  }
  return null;
};

/** Starts the headless shell if it is not already listening. Idempotent. */
export const launch = async ({ headed = false } = {}) => {
  const running = await probe();
  if (running) {
    // Adopting a browser we did not spawn: re-record the pid, or `down` will
    // never be able to stop it.
    if (!isAlive(readState().pid)) {
      const pid = portOwner();
      if (pid) writeState({ pid, adopted: true });
    }
    return { started: false, version: running.Browser };
  }

  ensureDirs();
  const bin = findBinary({ needsWindow: headed });
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    'about:blank',
  ];
  // A full Chromium build would otherwise open a real window on the user's screen.
  if (!bin.shell && !headed) args.unshift('--headless=new');

  const child = spawn(bin.path, args, { detached: true, stdio: 'ignore' });
  // Without this, an unspawnable binary throws an unhandled 'error' event and
  // the user gets a Node stack trace instead of the actual problem.
  child.on('error', () => {});
  child.unref();
  writeState({ pid: child.pid, binary: bin.path, headlessShell: bin.shell, headed, injectedIds: [] });

  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const v = await probe();
    if (v) return { started: true, version: v.Browser, binary: bin.path, shell: bin.shell };
    if (child.exitCode !== null || child.signalCode) break;
  }
  throw new Error(`${bin.path} did not open a CDP port on ${PORT} — is it a Chromium binary?`);
};

/** Reuses the single page target so navigation state survives between calls. */
const pageTarget = async () => {
  const list = await (await fetch(endpoint('/json/list'))).json();
  const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (page) return page;
  const created = await (await fetch(endpoint('/json/new?about:blank'), { method: 'PUT' })).json();
  return created;
};

/**
 * Brings up the browser, attaches, and restores the state CDP drops when the
 * previous CLI process detached: the viewport override and the log collector.
 */
export const connect = async ({ headed = false } = {}) => {
  await launch({ headed });
  const target = await pageTarget();
  const cdp = await CDP.attach(target.webSocketDebuggerUrl);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const state = readState();
  const vp = state.viewport || { width: 1280, height: 800, dpr: 1 };
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: vp.dpr,
    mobile: !!vp.mobile,
  });

  // Replace the previous registration instead of stacking one per invocation.
  for (const id of state.injectedIds || []) {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }).catch(() => {});
  }
  const injectedIds = [];
  for (const source of [COLLECTOR, QUERY]) {
    const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
    injectedIds.push(identifier);
  }
  writeState({ injectedIds });

  // The document already loaded is not covered by the hook above.
  for (const source of [COLLECTOR, QUERY]) await cdp.eval(source).catch(() => {});

  // An unanswered confirm()/alert() blocks the renderer forever, and a headless
  // browser has nobody to click it. Always answer, and record that we did.
  const dialogs = [];
  cdp.on((m) => {
    if (m.method !== 'Page.javascriptDialogOpening') return;
    dialogs.push(`${m.params.type}: ${m.params.message}`);
    cdp.send('Page.handleJavaScriptDialog', { accept: true, promptText: '' }).catch(() => {});
  });

  return { cdp, target, viewport: vp, dialogs };
};

export const shutdown = async () => {
  // state.json is a hint, not the truth: ask the OS who owns the port too.
  const pid = isAlive(readState().pid) ? readState().pid : portOwner();
  let killed = false;
  if (isAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); killed = true; } catch { /* raced */ }
  }
  await sleep(300);
  if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(`${ROOT}/state.json`, { force: true });
  return killed;
};

export const status = async () => {
  const state = readState();
  const version = await probe();
  // A browser up without a pid in state is the orphan case; resolve it so the
  // report names a process the user (and `down`) can actually act on.
  const pid = isAlive(state.pid) ? state.pid : (version ? portOwner() : null);
  return { ...state, pid, up: !!version, browser: version?.Browser || null, port: PORT };
};
