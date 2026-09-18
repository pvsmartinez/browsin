import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, SESSION, TTL_MIN, MAX_SESSIONS } from './paths.mjs';

/**
 * Garbage collection for session browsers. There is no daemon — every CLI
 * invocation is a short-lived process — so collection is opportunistic: it
 * runs at the top of `launch`, costs a readdir plus a few kill(pid, 0), and is
 * what keeps "one browser per session" from becoming "one leak per agent".
 *
 * A session is collected when it is older than TTL_MIN and nothing is using it:
 *  1. browser alive          -> SIGTERM, remove the session files
 *  2. browser gone           -> remove the session files (state, profile, shots)
 *  3. too many alive         -> reap the most idle ones beyond MAX_SESSIONS
 * Plus, every few minutes, a `ps` sweep for what state.json cannot cover: a
 * browser whose state file vanished while it kept serving its port.
 *
 * Age comes from lastUsed in state.json, falling back to the directory mtime.
 * The fallback matters: `down` deletes state.json, and without it that
 * directory — profile included — would become invisible to the collector and
 * live forever.
 */

export const isAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * SIGTERM, wait for it to actually die, then SIGKILL. The wait matters: Chrome
 * keeps writing to its profile while it shuts down, and `rm -rf` on a directory
 * a dying browser is still writing to fails with ENOTEMPTY — which used to
 * abort the whole collection run.
 */
const terminate = async (pid, timeoutMs = 3000) => {
  if (!isAlive(pid)) return true;
  try { process.kill(pid, 'SIGTERM'); } catch { return true; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) await sleep(50);
  if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { return true; } }
  for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(50);
  return !isAlive(pid);
};

/**
 * Removes a directory (or file). Best effort on purpose: if it fails, the
 * session is left as it was, so the next run still sees it and retries —
 * self-healing instead of a silent leak.
 */
const drop = (path) => {
  try { rmSync(path, { recursive: true, force: true }); return true; } catch { return false; }
};

/**
 * Every session under BASE. Two layouts coexist: the "default" session is the
 * flat one (state.json, profile/, shots/ directly under BASE — what a caller
 * with its own BROWSIN_DIR has always had), and named sessions get a
 * subdirectory of their own. Each entry carries the files that removal means
 * for it, so collection never deletes a sibling session's data.
 */
export const listSessions = () => {
  const now = Date.now();
  const out = [];
  const entry = (name, dir, paths) => {
    const state = readJson(join(dir, 'state.json'));
    let mtime = 0;
    try { mtime = statSync(dir).mtimeMs; } catch { /* raced with a gc */ }
    const alive = isAlive(state?.pid);
    out.push({
      name, dir, state, paths, alive,
      stateFile: join(dir, 'state.json'),
      pid: alive ? state.pid : null,
      // state.json is authoritative when it exists; the directory mtime covers
      // the session it no longer describes (`down` deletes the file).
      idleMin: (now - (state?.lastUsed || state?.startedAt || mtime)) / 60000,
    });
  };

  if (existsSync(join(BASE, 'state.json')) || existsSync(join(BASE, 'profile'))) {
    entry('default', BASE, ['profile', 'shots', 'downloads', 'record', 'state.json'].map((n) => join(BASE, n)));
  }
  let dirs = [];
  try {
    dirs = readdirSync(BASE, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return out; }
  for (const name of dirs) entry(name, join(BASE, name), [join(BASE, name)]);
  return out;
};

const STAMP = () => join(BASE, '.gc-stamp');
const SWEEP_EVERY_MS = 5 * 60 * 1000;

/** The ps sweep is the expensive part; run it at most every 5 min unless forced. */
const sweepDue = () => {
  try {
    if (Date.now() - statSync(STAMP()).mtimeMs < SWEEP_EVERY_MS) return false;
  } catch { /* no stamp yet */ }
  try { mkdirSync(BASE, { recursive: true }); writeFileSync(STAMP(), String(Date.now())); } catch { /* /tmp race */ }
  return true;
};

/**
 * Browsers found by their `--user-data-dir` instead of by state.json. Renderer
 * and GPU helpers inherit the flag too, so only the main process (no `--type=`)
 * counts. Both layouts are recognised: `<BASE>/profile` is the default session,
 * `<BASE>/<sessão>/profile` a named one.
 */
const browsersOnDisk = () => {
  const byName = new Map();
  let ps;
  try { ps = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return { byName, ok: false }; }
  const esc = BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`^\\s*(\\d+)\\s+\\S.*--user-data-dir=${esc}/([^/ ]+)/profile(?:\\s|$)`);
  const flat = new RegExp(`^\\s*(\\d+)\\s+\\S.*--user-data-dir=${esc}/profile(?:\\s|$)`);
  for (const line of ps.split('\n')) {
    // Renderer/GPU helpers inherit --user-data-dir too; killing one would crash
    // the page of a perfectly live browser. Only the main process counts.
    if (/--type=/.test(line)) continue;
    const m = named.exec(line);
    if (m) { byName.set(m[2], [...(byName.get(m[2]) || []), Number(m[1])]); continue; }
    const f = flat.exec(line);
    if (f) byName.set('default', [...(byName.get('default') || []), Number(f[1])]);
  }
  return { byName, ok: true };
};

/**
 * Reaps dead, idle and excess sessions. `own` is never touched — a session must
 * not collect the browser it is about to drive. Returns what it did.
 */
export const gc = async ({ force = false, own = SESSION, ttlMin = TTL_MIN, maxSessions = MAX_SESSIONS } = {}) => {
  const actions = [];
  const sessions = listSessions();
  const due = force || sweepDue();
  const stale = sessions.filter((s) => s.name !== own && s.idleMin > ttlMin);
  // A stale session whose browser is still up needs the ps view to be judged.
  const disk = due || stale.some((s) => !s.alive) ? browsersOnDisk() : { byName: new Map(), ok: false };

  const reap = async (s, live, why) => {
    for (const pid of live) await terminate(pid);
    const gone = s.paths.every(drop);
    if (gone) actions.push(`reap ${s.name} (${why})`);
    else actions.push(`keep ${s.name} (${why}) — o browser ainda está saindo; varre no próximo gc`);
  };

  for (const s of stale) {
    if (s.alive) { await reap(s, [s.pid], `idle ${Math.round(s.idleMin)} min > ${ttlMin}`); continue; }
    const live = disk.byName.get(s.name) || [];
    if (live.length) { await reap(s, live, `parada mas com browser de pé há ${Math.round(s.idleMin)} min`); continue; }
    if (s.paths.every(drop)) actions.push(`rm ${s.name} (parada há ${Math.round(s.idleMin)} min)`);
  }

  // Re-list: the stale pass just terminated some of these browsers, and the cap
  // must count what is actually alive now, not what was alive a moment ago.
  const alive = listSessions()
    .filter((s) => s.alive && s.name !== own)
    .sort((a, b) => b.idleMin - a.idleMin); // most idle first
  const excess = alive.length + 1 - maxSessions; // +1: the session asking counts too
  for (const s of alive.slice(0, Math.max(0, excess))) await reap(s, [s.pid], `acima do cap de ${maxSessions} sessões`);

  if (due) {
    for (const s of sessions) {
      if (s.name === own) continue;
      for (const pid of disk.byName.get(s.name) || []) {
        if (Number(s.state?.pid) !== pid) {
          if (await terminate(pid)) actions.push(`kill órfão pid ${pid} (sessão ${s.name}, sem state que o reconheça)`);
        }
      }
    }
    for (const [name, pids] of disk.byName) {
      if (name === own || sessions.some((s) => s.name === name)) continue;
      for (const pid of pids) if (await terminate(pid)) actions.push(`kill órfão pid ${pid} (sessão ${name}, sem diretório)`);
    }
  }
  return actions;
};