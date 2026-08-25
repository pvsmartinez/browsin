import { homedir } from 'node:os';
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

/** Where browsin keeps the two Chromium builds it owns. */
export const BROWSERS = process.env.BROWSIN_BROWSERS || join(homedir(), 'Library/Caches/browsin');

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
    const app = readdirSync(chromiumDir).find((n) => n.endsWith('.app'));
    if (app) {
      const bin = join(chromiumDir, app, 'Contents/MacOS', app.replace(/\.app$/, ''));
      if (existsSync(bin)) return { path: bin, shell: false };
    }
  }

  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(chrome)) return { path: chrome, shell: false, fallback: true };

  throw new Error(
    `no Chromium found in ${BROWSERS} — run productivity-tools/browsin/scripts/install-browsers.sh`,
  );
};
