import { spawn, execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { CDP } from './cdp.mjs';
import { COLLECTOR } from './collector.mjs';
import { QUERY } from './query.mjs';
import { ensureDirs, findBinary, readState, writeState, PORT, PROFILE, STATE_FILE, SESSION } from './paths.mjs';
import { gc, isAlive, listSessions } from './gc.mjs';
import { acquireSessionLock } from './lock.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const endpoint = (port, path) => `http://127.0.0.1:${port}${path}`;

/**
 * One browser per session means two commands must not drive it at once: in a
 * cold start both would spawn a browser (the "two browsers" bug), and even warm
 * they would interleave navigation and screenshots. Every browser command takes
 * this lock on its first `launch` and holds it until the process exits, so a
 * parallel invocation queues. Reentrant within the process — `check` opens two
 * connections, `connect` is called by every command.
 */
let lockRelease = null;
const ensureSessionLock = async () => {
  if (lockRelease) return;
  lockRelease = await acquireSessionLock();
  process.once('exit', () => { try { lockRelease?.(); } catch { /* exiting */ } });
};

const probe = async (port) => {
  try {
    const res = await fetch(endpoint(port, '/json/version'), { signal: AbortSignal.timeout(700) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

/** The pid listening on a CDP port, asked of the OS instead of of state.json. */
const portOwner = (port) => {
  for (const args of [['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], ['-t', `-i:${port}`]]) {
    try {
      const out = execFileSync('lsof', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const pid = Number(out.trim().split(/\s+/)[0]);
      if (pid) return pid;
    } catch { /* lsof missing, or nobody listening */ }
  }
  return null;
};

/** This session's port: the one state.json remembers, else the deterministic one. */
const homePort = () => readState().port || PORT;

/**
 * Does this pid belong to *this* session — i.e. is it a Chrome running on our
 * throwaway profile? Hashed ports can collide between sessions, and adopting
 * (or killing) by port alone would bring the old shared-browser bug back in
 * miniature. Same verification the kit's disposeBrowser performs.
 */
const isOurs = (pid) => {
  if (!pid) return false;
  try {
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return args.includes(`--user-data-dir=${PROFILE}`);
  } catch { return false; }
};

/**
 * Starts the headless shell if it is not already listening. Idempotent within
 * the session; two sessions never adopt each other, because each probes its
 * own port. Runs the GC first — spawning is exactly when a dead session's
 * memory matters.
 */
export const launch = async ({ headed = false } = {}) => {
  await ensureSessionLock();
  await gc();

  const state = readState();
  const home = state.port || PORT;
  let running = await probe(home);
  if (running && isAlive(state.pid)) {
    if (!headed && state.headed) {
      // A window opened by `login` must not silently drive a normal command.
      // Close it and fall through to a headless relaunch on the same profile:
      // cookies persist, the user's screen is freed, and a plain command is
      // actually headless.
      await shutdown();
      running = null;
    } else {
      // Our own record of a browser we spawned.
      return { started: false, port: home, version: running.Browser };
    }
  }
  if (running) {
    // State may have vanished while the browser lived: re-record the pid, or
    // `down` and the GC will never be able to account for it. But only if the
    // port really is held by a browser on OUR profile — a colliding session's
    // browser must never be adopted.
    const owner = portOwner(home);
    if (isOurs(owner)) {
      writeState({ pid: owner, port: home, adopted: true });
      return { started: false, port: home, version: running.Browser };
    }
    // Foreign browser on our deterministic port — walk forward for a free one.
  }

  ensureDirs();
  const bin = findBinary({ needsWindow: headed });
  // Another session may already hold our deterministic port — walk forward.
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = home + attempt;
    if ((await probe(port)) || portOwner(port)) continue;

    const args = [
      `--remote-debugging-port=${port}`,
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
    writeState({
      pid: child.pid, port, binary: bin.path, headlessShell: bin.shell, headed,
      injectedIds: [], startedAt: Date.now(), lastUsed: Date.now(),
    });

    for (let i = 0; i < 60; i++) {
      await sleep(100);
      const v = await probe(port);
      if (v) return { started: true, port, version: v.Browser, binary: bin.path, shell: bin.shell };
      if (child.exitCode !== null || child.signalCode) break;
    }
    // The child died. If someone else grabbed the port meanwhile it was a race
    // between sessions — try the next one. If the port is still free the binary
    // itself is broken and more ports will not help.
    if (!portOwner(port)) break;
  }
  throw new Error(`${bin.path} did not open a CDP port near ${home} — is it a Chromium binary?`);
};

/**
 * Which page target a command drives. By default the first page in
 * `/json/list` (newest-first in practice), so a link that opened a tab is where
 * the next command lands. `tabs use N` pins a target id in state.json, which
 * wins while it exists; a pin whose tab vanished falls back to auto and clears
 * itself. `/json/new` only runs when the browser has no page at all.
 */
const pageTarget = async (port) => {
  const list = await (await fetch(endpoint(port, '/json/list'))).json();
  const pages = list.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  const pinned = readState().targetId;
  if (pinned) {
    const hit = pages.find((t) => t.id === pinned);
    if (hit) return hit;
    writeState({ targetId: null }); // the pinned tab is gone
  }
  if (pages.length) return pages[0];
  const created = await (await fetch(endpoint(port, '/json/new?about=blank'), { method: 'PUT' })).json();
  return created;
};

/**
 * Brings up the browser, attaches, and restores the state CDP drops when the
 * previous CLI process detached: the viewport override and the log collector.
 */
export const connect = async ({ headed = false } = {}) => {
  const { port } = await launch({ headed });
  const target = await pageTarget(port);
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
  // lastUsed is what the GC's idle TTL reads — every command is activity.
  writeState({ injectedIds, lastUsed: Date.now() });

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
  // state.json is a hint, not the truth: ask the OS who owns the port too —
  // but only kill a port owner that is running OUR profile, never a foreign
  // session that happened to collide onto the same hashed port.
  const port = homePort();
  const state = readState();
  const pid = isAlive(state.pid) ? state.pid : (isOurs(portOwner(port)) ? portOwner(port) : null);
  let killed = false;
  if (isAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); killed = true; } catch { /* raced */ }
  }
  await sleep(300);
  if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(STATE_FILE, { force: true });
  return killed;
};

/** `down --all`: every session's browser, not just ours. Returns session names. */
export const shutdownAll = async () => {
  const victims = [];
  for (const s of listSessions()) {
    const pid = s.alive ? s.pid : (s.state?.port ? portOwner(s.state.port) : null);
    if (pid && isAlive(pid)) {
      try { process.kill(pid, 'SIGTERM'); victims.push(s.name); } catch { /* raced */ }
    }
    rmSync(s.stateFile, { force: true });
  }
  await sleep(300);
  for (const s of listSessions()) {
    const pid = s.pid || (s.state?.port ? portOwner(s.state.port) : null);
    if (pid && isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  return victims;
};

export const status = async () => {
  const state = readState();
  const port = state.port || PORT;
  const version = await probe(port);
  // A browser up without a pid in state is the orphan case; resolve it so the
  // report names a process the user (and `down`) can actually act on.
  const owner = portOwner(port);
  const ours = isAlive(state.pid) || isOurs(owner);
  const pid = isAlive(state.pid) ? state.pid : (ours ? owner : null);
  return { ...state, pid, up: !!version && ours, browser: version?.Browser || null, port, session: SESSION };
};
