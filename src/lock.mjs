import { linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, ensureDirs } from './paths.mjs';

/**
 * Per-session, cross-process mutex. browsin is one browser per session, and two
 * commands driving it at the same time is a race with no good outcome:
 *
 *  - cold start: both probe the port as free and both spawn a browser — a
 *    second `chrome-headless-shell` on the same profile and port. One of them
 *    is never recorded in state.json, so `down` leaves it behind.
 *  - warm: both attach to the one browser and interleave navigation and
 *    observation, so a command can read (or screenshot) the page the other
 *    just opened. Whichever won the race is what comes out.
 *
 * Every browser-driving command holds this lock from `launch` until its process
 * exits, so parallel invocations queue instead of fighting. `status`/`doctor`/
 * `gc`/`down` never take it — inspecting and resetting a stuck session must
 * never block on the session it is resetting.
 *
 * The lock is a file whose *content* is the owner pid, created atomically with
 * link(2) so it never appears empty. A holder that dies without releasing is
 * detected by its pid and stolen; the steal uses rename(2), so exactly one
 * waiter can take over.
 */
const LOCK_FILE = join(ROOT, '.lock');
const HARD_STALE_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const owner = () => {
  try { return Number(readFileSync(LOCK_FILE, 'utf8')); } catch { return 0; }
};

/**
 * Acquires the session lock, returning the release function. Waits for a live
 * holder; steals the lock when its pid is dead (a crashed command) or when it is
 * absurdly old. On timeout it fails loudly instead of spawning a second browser.
 */
export const acquireSessionLock = async ({ timeoutMs = 180_000, pollMs = 50 } = {}) => {
  ensureDirs();
  const tmp = join(ROOT, `.lock-tmp-${process.pid}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // link(2) fails with EEXIST if the lock already exists, and the pid is in
    // the file before it becomes visible — no transient empty lock.
    writeFileSync(tmp, String(process.pid));
    try {
      linkSync(tmp, LOCK_FILE);
      unlinkSync(tmp);
      return () => {
        // Only remove our own lock: a stolen lock belongs to someone else.
        try { if (owner() === process.pid) unlinkSync(LOCK_FILE); } catch { /* gone */ }
      };
    } catch (err) {
      unlinkSync(tmp);
      if (err?.code !== 'EEXIST') throw err;
    }

    const pid = owner();
    let old = false;
    try { old = Date.now() - statSync(LOCK_FILE).mtimeMs > HARD_STALE_MS; } catch { continue; }
    if (!isAlive(pid) || old) {
      // Atomic steal: rename(2) lets exactly one waiter move the dead lock out.
      const grave = join(ROOT, `.lock-stale-${process.pid}-${Date.now()}`);
      try { renameSync(LOCK_FILE, grave); }
      catch { continue; } // another waiter stole it first
      try { unlinkSync(grave); } catch { /* already reaped */ }
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error("another browsin command is using this session's browser — retry, or `browsin down` to reset it");
    }
    await sleep(pollMs);
  }
};
