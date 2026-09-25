/**
 * Pure HTML for the `login --note` interstitial: a plain page that tells the
 * human why a browser window just opened on their screen, before any target
 * site loads. No dependencies, no side effects — trivially testable.
 */
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export const buildLoginNoteHtml = (note, url) => `<!doctype html>
<html><head><meta charset=utf-8><title>browsin login</title><style>
 body{font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;margin:0;color:#1a1a1a;background:#fafafa}
 main{max-width:34rem;margin:18vh auto 0;padding:0 24px}
 p{margin:0 0 24px}
 a{display:inline-block;font-size:16px;padding:10px 18px;border-radius:8px;
   border:1px solid #bbb;background:#f0f0f0;color:#1a1a1a;text-decoration:none}
</style></head><body><main>
 <p><strong>browsin login</strong></p>
 <p>${escapeHtml(note)}</p>
 ${url
    ? `<p><a href="${escapeHtml(url)}">Continue to ${escapeHtml(url)}</a></p>`
    : '<p>Close this window when done.</p>'}
</main></body></html>`;
