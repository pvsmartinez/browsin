import { spawn } from 'node:child_process';
import { existsSync, linkSync, appendFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BASE } from './paths.mjs';
import { browsersOnDisk, gc, isAlive, listSessions, runsProfile, sessionProfile } from './gc.mjs';

/**
 * The GC only runs when a CLI invocation does. If the last command to launch a
 * browser belongs to a harness that dies (a pi run, a Claude session, a lost
 * terminal), nobody calls `gc` again and the headless browser — ~150 MB — stays
 * up for days. This is the janitor: a detached Node process spawned by
 * `launch`, which re-runs the *same* gc() on a timer and exits by itself when
 * no managed session has a live browser.
 *
 * Constraints it lives under:
 *  - One per browsin base (state root). The lock at `<BASE>/.janitor-lock` is
 *    created atomically with link(2) and its content is the holder pid, so a
 *    loser exits and a holder that died is detected and stolen — same scheme as
 *    the per-session lock, and safe across users too (isAlive treats EPERM as
 *    "exists, foreign").
 *  - It is a per-base janitor, not machine-wide: BROWSIN_DIR isolation is
 *    inherited through the environment, it never installs anything global, and
 *    the ps sweep it inherits from gc() only matches browsin profiles.
 *  - It reuses gc()'s semantics verbatim (TTL, MAX_SESSIONS, orphan grace, the
 *    sibling-base sweep). Its only additions: it protects no session of its own
 *    (own: '') and it refuses to reap a session whose per-session lock is held
 *    by a live process — a command mid-flight is exactly the "active session"
 *    that must never be killed.
 *  - Survives the CLI that spawned it: detached + unref, stdio ignored. Opt
 *    out with BROWSIN_JANITOR=off; debug log via BROWSIN_JANITOR_LOG.
 */

const LOCK_FILE = join(BASE, '.janitor-lock');

const DEFAULT_INTERVAL_S = 10 * 60; // ceiling by design: at most every 10 min
const MAX_INTERVAL_S = 10 * 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (line) => {
  const file = process.env.BROWSIN_JANITOR_LOG;
  if (!file) return;
  try { appendFileSync(file, `${new Date().toISOString()} ${line}\n`); } catch { /* best effort */ }
};

const owner = () => {
  try { return Number(readFileSync(LOCK_FILE, 'utf8')); } catch { return 0; }
};

/** Live janitor pid for this base, if any. */
export const janitorPid = () => {
  const pid = owner();
  return isAlive(pid) ? pid : 0;
};

/** Remove the lock only if it is still ours (a stolen lock belongs to someone else). */
const releaseLock = () => {
  try { if (owner() === process.pid) unlinkSync(LOCK_FILE); } catch { /* gone */ }
};

/**
 * Non-blocking acquisition. Returns false when a live janitor holds the base;
 * steals only a lock whose holder is dead (killed -9, machine reboot).
 */
const acquireLock = () => {
  const tmp = join(BASE, `.janitor-${process.pid}.tmp`);
  for (let i = 0; i < 5; i++) {
    try {
      writeFileSync(tmp, String(process.pid));
      linkSync(tmp, LOCK_FILE); // EEXIST if a lock is already visible
      unlinkSync(tmp);
      return true;
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* fine */ }
      if (err?.code !== 'EEXIST') return false;
    }
    const pid = owner();
    if (isAlive(pid)) return false; // live holder, even a foreign one: not ours to steal
    // Dead holder: atomic steal via rename — exactly one contender wins.
    const grave = `${LOCK_FILE}.stale-${process.pid}-${Date.now()}`;
    try { renameSync(LOCK_FILE, grave); } catch { continue; }
    try { unlinkSync(grave); } catch { /* already gone */ }
  }
  return false;
};

/**
 * Sessions a live command is currently driving (its session lock is held).
 * gc() reads lastUsed, which a running command only rewrites at attach — a
 * stuck dialog or a slow recording could otherwise look idle past the TTL.
 */
const lockedByLiveCommand = () => {
  const out = [];
  for (const s of listSessions()) {
    let pid = 0;
    try { pid = Number(readFileSync(join(s.dir, '.lock'), 'utf8')); } catch { continue; }
    if (isAlive(pid)) out.push(s.name);
  }
  return out;
};

const tick = () => gc({ own: '', protect: lockedByLiveCommand(), selfSlot: false });

/**
 * True while any managed session still has a browser up. A state pid is only a
 * hint — a reused pid (or a ps-blind tick) would either keep the janitor alive
 * forever or strand a browser. The truth is the ps view: any main browser under
 * this base, or a state pid that still proves it runs this base's profile. If
 * ps is unavailable, stay alive — exiting blind could strand browsers.
 */
const hasLiveSessions = () => {
  const disk = browsersOnDisk();
  if (!disk.ok) return true; // cannot verify: assume the worst and keep sweeping
  if (disk.byName.size > 0) return true;
  return listSessions().some((s) => s.alive && runsProfile(s.pid, sessionProfile(s)));
};

export const runLoop = async ({ intervalS, maxTicks = 0 } = {}) => {
  if (!existsSync(BASE)) return 0; // nothing to manage; do not recreate the base
  if (!acquireLock()) { log(`another janitor holds ${BASE}`); return 0; }
  const intervalMs = Math.min(Math.max(intervalS ?? DEFAULT_INTERVAL_S, 1), MAX_INTERVAL_S) * 1000;
  log(`janitor ${process.pid} on ${BASE} every ${intervalMs / 1000}s`);
  try {
    for (let n = 1; ; n++) {
      let actions = [];
      try { actions = await tick(); } catch (err) { log(`tick failed: ${err?.message ?? err}`); }
      if (actions.length) log(actions.join('; '));
      if (!hasLiveSessions()) { log('no live session remains — exiting'); return n; }
      if (maxTicks && n >= maxTicks) return n;
      await sleep(intervalMs);
    }
  } finally {
    releaseLock();
  }
};

/**
 * Called at the top of `launch`: if no janitor owns this base yet, spawn a
 * detached one. Opt out with BROWSIN_JANITOR=off (the test suite does, to stay
 * hermetic — a background gc between suite steps would be a race).
 */
export const spawnJanitor = () => {
  if (process.env.BROWSIN_JANITOR === 'off') return false;
  if (janitorPid()) return false;
  try {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'janitor.mjs')], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
};

const argvVal = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/* CLI entry: `node src/janitor.mjs [--interval-s N] [--max-ticks N]`. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const intervalS = Number(argvVal('--interval-s') ?? process.env.BROWSIN_JANITOR_INTERVAL_S);
  runLoop({ intervalS: Number.isFinite(intervalS) ? intervalS : undefined, maxTicks: Number(argvVal('--max-ticks') || 0) })
    .catch((err) => { log(`janitor crashed: ${err?.stack ?? err}`); process.exitCode = 1; });
}
