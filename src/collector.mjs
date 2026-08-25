/**
 * Runs inside the page, before any page script. It buffers console output,
 * exceptions and failed requests into `window.__browsin` so that `browsin logs`
 * can drain them later — which is what keeps browsin daemon-free: the buffer
 * lives in the page, not in a background process the CLI would have to talk to.
 *
 * Idempotent on purpose: it is injected on every navigation and on every attach.
 */
export const COLLECTOR = `(() => {
  if (window.__browsin) return;
  const MAX = 200;
  const buf = [];
  const push = (kind, msg) => {
    buf.push({ kind, msg: String(msg).slice(0, 600) });
    if (buf.length > MAX) buf.shift();
  };
  window.__browsin = { drain: () => buf.splice(0, buf.length), peek: () => buf.slice() };

  const fmt = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.message;
    try { return JSON.stringify(v); } catch { return String(v); }
  };

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level] && console[level].bind(console);
    if (!orig) continue;
    console[level] = (...args) => { push(level, args.map(fmt).join(' ')); orig(...args); };
  }

  addEventListener('error', (e) => {
    const el = e.target;
    if (el && el !== window && el.tagName) push('resource', el.tagName + ' failed to load: ' + (el.src || el.href || '?'));
    else push('exception', (e.message || 'error') + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0));
  }, true);

  addEventListener('unhandledrejection', (e) => {
    push('rejection', (e.reason && e.reason.message) || fmt(e.reason));
  });

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '?';
      try {
        const res = await origFetch(...args);
        if (!res.ok) push('http', res.status + ' ' + url);
        return res;
      } catch (err) {
        push('neterr', url + ' — ' + err.message);
        throw err;
      }
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.addEventListener('load', () => { if (this.status >= 400) push('http', this.status + ' ' + url); });
    this.addEventListener('error', () => push('neterr', String(url)));
    return origOpen.call(this, method, url, ...rest);
  };
})()`;
