import { homedir, platform } from 'node:os';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/** Everything browsin owns is disposable and lives outside the user's Chrome. */
export const BASE = process.env.BROWSIN_DIR || '/tmp/browsin';

/**
 * One browser per caller, not one per machine. A shared singleton was the old
 * design and the old bug: two agents on the same port fight over the same tab,
 * the same viewport state and the same state.json.
 *
 * Inside pi, PI_SESSION_ID namespaces the session automatically — every
 * subagent run has its own id, so parallel agents stop colliding with zero
 * configuration. Claude Code exports CLAUDE_CODE_SESSION_ID, so a `login` there
 * lives in that conversation's profile only — not in every later session that
 * reuses the terminal tab. Other harnesses (codex, plain shells) have no
 * session id, but a terminal tab usually does: TERM_SESSION_ID keeps two
 * agents in different tabs apart. BROWSIN_SESSION overrides when the caller
 * knows better. An explicit BROWSIN_DIR means the caller already owns the
 * namespace (the kit's per-run isolation, a test, a scratch run): it keeps the
 * flat layout it always had, and `gc` reaps it like any other session once it
 * goes idle.
 */
const explicitDir = !!process.env.BROWSIN_DIR;
const rawSession =
  process.env.BROWSIN_SESSION ||
  (explicitDir ? '' : process.env.PI_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || process.env.TERM_SESSION_ID || '') ||
  'default';
export const SESSION =
  rawSession.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) ||
  'default';

/** "default" stays flat (BASE/profile, BASE/state.json); named sessions nest. */
export const ROOT = SESSION === 'default' ? BASE : join(BASE, SESSION);
export const PROFILE = join(ROOT, 'profile');
export const SHOTS = join(ROOT, 'shots');
export const DOWNLOADS = join(ROOT, 'downloads');
export const STATE_FILE = join(ROOT, 'state.json');

/**
 * Deterministic per session, so a session always comes back to its own port.
 * Collisions between two sessions are resolved at launch by walking forward;
 * the chosen port is recorded in state.json. BROWSIN_PORT pins it by hand.
 */
const BASE_PORT = 9377;
const hashPort = (name) => {
  let h = 5381;
  for (const ch of name) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return BASE_PORT + (h % 500);
};
export const PORT = Number(process.env.BROWSIN_PORT || (SESSION === 'default' ? BASE_PORT : hashPort(SESSION)));

/** GC: sessions idle past this are reaped; if more than this many are alive, oldest first. */
export const TTL_MIN = Number(process.env.BROWSIN_TTL_MIN || 60);
export const MAX_SESSIONS = Number(process.env.BROWSIN_MAX_SESSIONS || 8);

export const ensureDirs = () => {
  for (const d of [BASE, ROOT, SHOTS, DOWNLOADS]) mkdirSync(d, { recursive: true });
};

export const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
};

export const writeState = (patch) => {
  ensureDirs();
  const next = { ...readState(), ...patch };
  // Atomic: a reader (or a racing writer that slipped past the session lock)
  // must never see a half-written state.json, and a crash mid-write must not
  // corrupt it. Write beside it, then rename — rename(2) is atomic.
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, STATE_FILE);
  return next;
};

const MAC = platform() === 'darwin';

/** Where browsin keeps the two Chromium builds it owns. */
export const BROWSERS =
  process.env.BROWSIN_BROWSERS ||
  (MAC
    ? join(homedir(), 'Library/Caches/browsin')
    : join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'browsin'));

/**
 * Chrome builds a machine is likely to already have. macOS is the supported
 * install target; the others exist so a Linux checkout is usable by pointing at
 * a system Chrome, without pretending the installer covers that platform.
 */
const FALLBACKS = MAC
  ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
     '/Applications/Chromium.app/Contents/MacOS/Chromium']
  : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
     '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];

/**
 * Finds a Chromium to drive. Order matters: `chrome-headless-shell` has no UI
 * layer at all, so it physically cannot appear on screen or touch a real
 * profile — that is the default. `login` needs a window and asks for the full
 * build instead.
 *
 * Both live under BROWSERS because browsin owns them; they were lifted out of
 * the Playwright cache when that was deleted. Install them with
 * `scripts/install-browsers.sh`. The user's own Chrome is a last resort, and
 * even then it runs on browsin's throwaway profile, never theirs.
 */
export const findBinary = ({ needsWindow = false } = {}) => {
  if (process.env.BROWSIN_CHROME) return { path: process.env.BROWSIN_CHROME, shell: false };

  const shell = join(BROWSERS, 'headless-shell/chrome-headless-shell');
  if (!needsWindow && existsSync(shell)) return { path: shell, shell: true };

  const chromiumDir = join(BROWSERS, 'chromium');
  if (existsSync(chromiumDir)) {
    if (MAC) {
      const app = readdirSync(chromiumDir).find((n) => n.endsWith('.app'));
      if (app) {
        const bin = join(chromiumDir, app, 'Contents/MacOS', app.replace(/\.app$/, ''));
        if (existsSync(bin)) return { path: bin, shell: false };
      }
    } else if (existsSync(join(chromiumDir, 'chrome'))) {
      return { path: join(chromiumDir, 'chrome'), shell: false };
    }
  }

  // Last resort: whatever Chrome the machine already has. It still runs on
  // browsin's throwaway profile, never the user's — but `doctor` shouts, because
  // a silent fallback makes a broken install look like a working one.
  for (const chrome of FALLBACKS) {
    if (existsSync(chrome)) return { path: chrome, shell: false, fallback: true };
  }

  throw new Error(
    `no Chromium found in ${BROWSERS} — run scripts/install-browsers.sh (macOS), ` +
      'or point BROWSIN_CHROME at a Chromium binary',
  );
};
