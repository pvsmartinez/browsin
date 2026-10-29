import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { BASE, SESSION, TTL_MIN, MAX_SESSIONS } from './paths.mjs';
import { tryAcquireAt } from './lock.mjs';

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
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code === 'EPERM'; } // EPERM: exists, owned by another user
};

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The ps sweep lists every user's processes on a shared machine; kill by pid
// would be attempted on another user's browser if one ever pointed at a browsin
// profile (EPERM — but only after confusing actions). Never look at them.
const MY_UID = typeof process.getuid === 'function' ? process.getuid() : null;
const otherUsersProcess = (line) => {
  if (MY_UID === null) return false;
  const m = /^\s*\d+\s+(\d+)\s/.exec(line);
  return !!m && Number(m[1]) !== MY_UID;
};

const escPath = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ps must never hang the collector; bounded, and a failure is never fatal. */
const PS_TIMEOUT_MS = 5000;
const readPs = () => {
  try {
    return execFileSync('ps', ['-axo', 'pid=,uid=,args='], { encoding: 'utf8', timeout: PS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
};

/** pid -> {uid, args}. null when ps is unavailable: "cannot verify" must be
 *  read as "cannot kill", never as "trust the pid in state.json". */
const psTable = () => {
  const out = readPs();
  if (out === null) return null;
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) map.set(Number(m[1]), { uid: Number(m[2]), args: m[3] });
  }
  return map;
};

/** The profile dir a session's browser is launched with (flat layout included). */
export const sessionProfile = (s) => join(s.dir, 'profile');

/**
 * True only when pid is this user's *main* browser process (helpers carry
 * `--type=`) running exactly this profile dir. Everything else — a reused pid
 * now belonging to an unrelated process, a foreign user's process, ps
 * unavailable — is false, and false means "never kill".
 */
export const runsProfile = (pid, profileDir) => {
  const table = psTable();
  if (!table) return false;
  const e = table.get(Number(pid));
  if (!e) return false;
  if (MY_UID !== null && e.uid !== MY_UID) return false;
  if (/--type=/.test(e.args)) return false;
  return new RegExp(`(^|\\s)--user-data-dir=${escPath(profileDir)}(\\s|$)`).test(e.args);
};

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

  // The flat default layout lives directly in BASE. Its own dirs (`profile/`,
  // `shots/`…) are part of that session, not sibling sessions — without this,
  // a BROWSIN_DIR that is itself a session directory (a caller pointing at the
  // wrong level) would have its profile and shots reaped as stale sessions.
  const flat = existsSync(join(BASE, 'state.json')) || existsSync(join(BASE, 'profile'));
  const RESERVED = new Set(['profile', 'shots', 'downloads', 'record']);
  if (flat) {
    entry('default', BASE, [...RESERVED, 'state.json'].map((n) => join(BASE, n)));
  }
  let dirs = [];
  try {
    // Dot-dirs are browsin's own bookkeeping (the session lock and its stale
    // graveyard), never a session. Reserved names are the flat layout's own
    // dirs when that layout is present.
    dirs = readdirSync(BASE, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .filter((d) => !(flat && RESERVED.has(d.name)))
      .map((d) => d.name);
  } catch { return out; }
  for (const name of dirs) entry(name, join(BASE, name), [join(BASE, name)]);
  return out;
};

const STAMP = () => join(BASE, '.gc-stamp');
const SWEEP_EVERY_MS = 5 * 60 * 1000;

/**
 * Browsers living under a *different* browsin base — the pi kit's per-run
 * `browsin-run-*` dirs, a test dir, a manual run — are invisible to the
 * per-BASE collector above. That is how a machine accumulates days-old
 * `chrome-headless-shell` processes. When the ps sweep is due, also reap any
 * main browser under a sibling `browsin*` base whose session no longer records
 * it as a live pid.
 *
 * Foreign *files* are never deleted: the kit deliberately keeps a run's
 * `shots/` after disposing its browser, so only the leaked process is killed.
 * A grace period protects a browser that was just spawned before its
 * `state.json` was written (env-overridable, for the tests).
 */
/** `ps -o etime` is `[[dd-]hh:]mm:ss` (macOS has no `etimes`). */
const etimeSeconds = (s) => {
  const [d, rest] = String(s).includes('-') ? String(s).split('-') : [0, s];
  const hms = String(rest).trim().split(':').map(Number);
  const [h, m, sec] = hms.length === 3 ? hms : hms.length === 2 ? [0, ...hms] : [0, 0, hms[0] || 0];
  return ((Number(d) * 24 + h) * 60 + m) * 60 + sec;
};

const reapForeignOrphans = async (actions) => {
  const prefix = join(dirname(BASE), 'browsin');
  const ownDir = SESSION === 'default' ? BASE : join(BASE, SESSION);
  const graceS = Number(process.env.BROWSIN_ORPHAN_GRACE_S ?? 300);
  let ps;
  try { ps = execFileSync('ps', ['-axo', 'pid=,uid=,etime=,args='], { encoding: 'utf8', timeout: PS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return; }
  for (const line of ps.split('\n')) {
    if (/--type=/.test(line)) continue; // renderer/GPU helper, not the browser
    if (otherUsersProcess(line)) continue; // another user's browser: never ours
    const m = /^\s*(\d+)\s+\d+\s+(\S+)\s+\S.*--user-data-dir=(\S+?)(?:\s|$)/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ageS = etimeSeconds(m[2]);
    const profile = m[3];
    if (!profile.endsWith('/profile')) continue;
    // Siblings are named `browsin`, `browsin-run-*`, `browsin-suite.*`…, so the
    // match is a plain string prefix, not a path segment (`/tmp/browsin/` would
    // miss every `browsin-*` dir).
    if (!profile.startsWith(prefix)) continue;
    if (profile.startsWith(`${BASE}/`)) continue; // our base: handled above
    const sessionDir = dirname(profile);
    if (sessionDir === ownDir) continue;
    let owner = 0;
    try { owner = Number(JSON.parse(readFileSync(join(sessionDir, 'state.json'), 'utf8')).pid); } catch { /* no state */ }
    if (owner === pid && isAlive(pid)) continue; // live and accounted for
    if (ageS < graceS) continue; // just spawned, state.json not written yet
    // Same rules as every kill point: a command holding this session's lock
    // (mid-launch, state.json not written yet) must not see its browser die,
    // and the pid must prove it is the browser of this exact profile.
    const release = existsSync(sessionDir) ? tryAcquireAt(sessionDir) : null;
    if (existsSync(sessionDir) && !release) continue;
    try {
      if (await terminateBrowser(pid, profile)) actions.push(`kill órfão pid ${pid} (base ${basename(sessionDir)}, sem state que o reconheça)`);
    } finally { release?.(); }
  }
};

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
export const browsersOnDisk = () => {
  const byName = new Map();
  const ps = readPs();
  if (ps === null) return { byName, ok: false };
  const esc = BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`^\\s*(\\d+)\\s+\\d+\\s+\\S.*--user-data-dir=${esc}/([^/ ]+)/profile(?:\\s|$)`);
  const flat = new RegExp(`^\\s*(\\d+)\\s+\\d+\\s+\\S.*--user-data-dir=${esc}/profile(?:\\s|$)`);
  for (const line of ps.split('\n')) {
    // Renderer/GPU helpers inherit --user-data-dir too; killing one would crash
    // the page of a perfectly live browser. Only the main process counts.
    if (/--type=/.test(line)) continue;
    if (otherUsersProcess(line)) continue; // another user's browser: never ours
    const m = named.exec(line);
    if (m) { byName.set(m[2], [...(byName.get(m[2]) || []), Number(m[1])]); continue; }
    const f = flat.exec(line);
    if (f) byName.set('default', [...(byName.get('default') || []), Number(f[1])]);
  }
  return { byName, ok: true };
};

/**
 * Kill point with identity verification: a state pid can have been reused by
 * an unrelated process since it was written, so before any signal the pid must
 * prove it is this session's own browser. An already-dead pid needs no proof.
 * Returns false when the kill was skipped (unverified) — the caller keeps the
 * session for the next run instead of killing blind.
 */
const terminateBrowser = async (pid, profileDir) => {
  if (!isAlive(pid)) return true;
  if (!runsProfile(pid, profileDir)) return false;
  await terminate(pid);
  return true;
};

/**
 * Reaps dead, idle and excess sessions. `own` is never touched — a session must
 * not collect the browser it is about to drive. Returns what it did.
 */
export const gc = async ({ force = false, own = SESSION, ttlMin = TTL_MIN, maxSessions = MAX_SESSIONS, protect = [], selfSlot = true } = {}) => {
  const actions = [];
  const sessions = listSessions();
  const due = force || sweepDue();
  // `protect` extends the single-`own` exemption to sessions a live command is
  // driving (the janitor passes every session whose lock is held) — a session
  // mid-command must never be judged idle by a collector.
  const exempt = (s) => s.name === own || protect.includes(s.name);
  const stale = sessions.filter((s) => !exempt(s) && s.idleMin > ttlMin);
  // A stale session whose browser is still up needs the ps view to be judged.
  const disk = due || stale.some((s) => !s.alive) ? browsersOnDisk() : { byName: new Map(), ok: false };

  const reap = async (s, live, why) => {
    // Kill-time lock check — closes the janitor's snapshot TOCTOU: a command
    // that acquired the session lock after the protect list was taken must not
    // see its browser die, and a command arriving during the kill waits.
    const release = existsSync(s.dir) ? tryAcquireAt(s.dir) : null;
    if (existsSync(s.dir) && !release) {
      actions.push(`keep ${s.name} (${why}) — comando ativo no lock da sessão`);
      return;
    }
    try {
      let killed = true;
      for (const pid of live) {
        if (!(await terminateBrowser(pid, sessionProfile(s)))) { killed = false; break; }
      }
      if (!killed) {
        actions.push(`keep ${s.name} (${why}) — pid não verificado como browser da sessão; nunca matar às cegas`);
        return;
      }
      const gone = s.paths.every(drop);
      if (gone) actions.push(`reap ${s.name} (${why})`);
      else actions.push(`keep ${s.name} (${why}) — o browser ainda está saindo; varre no próximo gc`);
    } finally { release?.(); }
  };

  for (const s of stale) {
    if (s.alive) { await reap(s, [s.pid], `idle ${Math.round(s.idleMin)} min > ${ttlMin}`); continue; }
    const live = disk.byName.get(s.name) || [];
    if (live.length) { await reap(s, live, `parada mas com browser de pé há ${Math.round(s.idleMin)} min`); continue; }
    // A command mid-launch holds the session lock with no browser up yet:
    // never remove the files from under it.
    const release = existsSync(s.dir) ? tryAcquireAt(s.dir) : null;
    if (existsSync(s.dir) && !release) {
      actions.push(`keep ${s.name} (parada há ${Math.round(s.idleMin)} min) — comando ativo no lock da sessão`);
      continue;
    }
    try { if (s.paths.every(drop)) actions.push(`rm ${s.name} (parada há ${Math.round(s.idleMin)} min)`); }
    finally { release?.(); }
  }

  // Re-list: the stale pass just terminated some of these browsers, and the cap
  // must count what is actually alive now, not what was alive a moment ago.
  const alive = listSessions()
    .filter((s) => s.alive && !exempt(s))
    .sort((a, b) => b.idleMin - a.idleMin); // most idle first
  const excess = alive.length + (selfSlot ? 1 : 0) - maxSessions; // +1: the session asking counts too
  for (const s of alive.slice(0, Math.max(0, excess))) await reap(s, [s.pid], `acima do cap de ${maxSessions} sessões`);

  if (due) {
    for (const s of sessions) {
      if (exempt(s)) continue;
      for (const pid of disk.byName.get(s.name) || []) {
        if (Number(s.state?.pid) === pid) continue;
        // A browser the state does not know may be a command mid-launch (its
        // state.json not written yet): with the session lock held, back off.
        const release = existsSync(s.dir) ? tryAcquireAt(s.dir) : null;
        if (existsSync(s.dir) && !release) continue;
        try {
          if (await terminateBrowser(pid, sessionProfile(s))) actions.push(`kill órfão pid ${pid} (sessão ${s.name}, sem state que o reconheça)`);
        } finally { release?.(); }
      }
    }
    for (const [name, pids] of disk.byName) {
      if (name === own || sessions.some((s) => s.name === name)) continue;
      for (const pid of pids) {
        if (await terminateBrowser(pid, join(BASE, name, 'profile'))) actions.push(`kill órfão pid ${pid} (sessão ${name}, sem diretório)`);
      }
    }
    await reapForeignOrphans(actions);
  }
  return actions;
};