/**
 * Pure HTML for the `login --note` interstitial: a plain page that tells the
 * human why a browser window just opened on their screen, before any target
 * site loads. No dependencies, no external resources (a `<link>`/favicon would
 * leak an href into the no-URL case the tests check), no side effects —
 * trivially testable.
 */
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export const buildLoginNoteHtml = (note, url) => `<!doctype html>
<html lang="en"><head><meta charset=utf-8>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>browsin login</title>
<style>
 :root{color-scheme:light dark;--fg:#16181d;--muted:#5b6472;--bg:#f6f7f9;--card:#fff;--line:#e4e7ec;--accent:#2f6fed;--accent-fg:#fff}
 @media (prefers-color-scheme:dark){:root{--fg:#e8eaed;--muted:#9aa4b2;--bg:#0f1115;--card:#171a20;--line:#262b33;--accent:#5b8cff}}
 *{box-sizing:border-box}
 body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
   font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
   color:var(--fg);background:var(--bg)}
 main{width:100%;max-width:34rem;background:var(--card);border:1px solid var(--line);
   border-radius:16px;padding:32px;box-shadow:0 12px 40px rgba(0,0,0,.10)}
 .tag{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;
   letter-spacing:.02em;color:var(--muted);text-transform:uppercase}
 .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 18%,transparent)}
 h1{font-size:20px;margin:12px 0 8px}
 p{margin:0 0 20px;color:var(--fg)}
 .note{font-size:17px}
 a.go{display:inline-block;font-size:16px;font-weight:600;padding:11px 20px;border-radius:10px;
   background:var(--accent);color:var(--accent-fg);text-decoration:none}
 a.go:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 40%,transparent);outline-offset:2px}
 .hint{font-size:13px;color:var(--muted);margin:16px 0 0}
 code{font-size:13px;color:var(--muted)}
</style></head><body><main>
 <span class="tag"><span class="dot"></span>browsin login</span>
 <h1>One sign-in, by hand</h1>
 <p class="note">${escapeHtml(note)}</p>
 ${url
    ? `<p><a class="go" href="${escapeHtml(url)}">Continue to ${escapeHtml(url)}</a></p>
 <p class="hint">Sign in on the next screen. Closing the window does not log you out —
 cookies live on disk, so the next headless command is already authenticated.</p>`
    : `<p class="hint">Close this window when done.</p>`}
</main></body></html>`;
