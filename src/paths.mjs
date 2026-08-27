import { homedir, platform } from 'node:os';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Everything browsin owns is disposable and lives outside the user's Chrome. */
export const ROOT = process.env.BROWSIN_DIR || '/tmp/browsin';
export const PROFILE = join(ROOT, 'profile');
export const SHOTS = join(ROOT, 'shots');
export const DOWNLOADS = join(ROOT, 'downloads');
export const STATE_FILE = join(ROOT, 'state.json');
export const PORT = Number(process.env.BROWSIN_PORT || 9377);

export const ensureDirs = () => {
  for (const d of [ROOT, SHOTS, DOWNLOADS]) mkdirSync(d, { recursive: true });
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
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
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
