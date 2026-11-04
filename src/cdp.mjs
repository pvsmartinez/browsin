/**
 * Minimal Chrome DevTools Protocol client. No dependencies: Node 22+ ships a
 * global WebSocket, which is the only thing a CDP client actually needs.
 */

/**
 * Per-`send` deadline. A browser (or a renderer busy in a page script) that
 * accepts a command and never answers used to hang the command forever — and
 * with it the session lock, since the CLI only releases it on exit. Any single
 * CDP round trip that takes this long is a wedge, not work in progress.
 * `BROWSIN_CDP_TIMEOUT_MS` raises/lowers it (`0` disables the deadline).
 */
export const DEFAULT_SEND_TIMEOUT_MS = 60_000;

/** Picking the tab and opening one are browser-side bookkeeping, not rendering. */
export const CONTROL_TIMEOUT_MS = 5000;

/** Rasterising/printing a large document is legitimately slow — no 60s cap. */
export const HEAVY_TIMEOUT_MS = 180_000;

const sendTimeoutFromEnv = () => {
  const raw = process.env.BROWSIN_CDP_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_SEND_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SEND_TIMEOUT_MS;
};

/**
 * Turns an abort/fetch failure into a message that names the deadline *and* the
 * knob: a legitimately slow page is the one case where the fix is the env var,
 * not reload/down, and this message is where the user learns it exists.
 */
const timeoutError = (what, ms, configurable = false) =>
  new Error(`${what} timed out after ${ms}ms — the browser is not answering (\`browsin reload\` if the page is stuck, \`browsin down\` to reset${configurable ? ', or raise BROWSIN_CDP_TIMEOUT_MS if it is just slow' : ''})`);

/**
 * The HTTP half of the CDP endpoint (`/json/version`, `/json/list`, `/json/new`,
 * `/json/close`). `fetch` has no deadline of its own: a port that accepts the
 * connection and never answers parks the command forever. Every call here is
 * short bookkeeping, so it gets a short deadline of its own.
 *
 * `parse: 'text'` is for endpoints that answer **200 with plain text**: Chrome
 * sends `Target is closing` (and `Target activated`) with a JSON content-type but
 * a non-JSON body, so `res.json()` threw on a close that had actually worked.
 */
export const cdpHttp = async (port, path, { method = 'GET', timeout = CONTROL_TIMEOUT_MS, parse = 'json' } = {}) => {
  const what = `CDP ${path}`;
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw timeoutError(what, timeout);
    throw new Error(`${what} failed: ${err.message}`);
  }
  if (!res.ok) throw new Error(`${what} returned HTTP ${res.status}`);
  let body;
  try {
    // The body read is under the same signal: a server that sends headers and
    // then stalls fails here, not above.
    body = await res.text();
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw timeoutError(what, timeout);
    throw new Error(`${what} returned no body: ${err.message}`);
  }
  if (parse === 'text') return body.trim();
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`${what} returned no JSON: ${err.message}`);
  }
};

export class CDP {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Set();
  #closed = false;
  #closeReason = 'CDP connection closed';
  #timeout;
  #closeHandlers = new Set();

  constructor({ timeout = sendTimeoutFromEnv() } = {}) {
    this.#timeout = timeout;
  }

  static async attach(wsUrl, { timeout = 10000, sendTimeout = sendTimeoutFromEnv() } = {}) {
    const cdp = new CDP({ timeout: sendTimeout });
    const ws = new WebSocket(wsUrl);
    cdp.#ws = ws;
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(() => {
        done(reject, new Error(`CDP connect timed out after ${timeout}ms`));
        try { ws.close(); } catch { /* never opened */ }
      }, timeout);
      ws.onopen = () => done(resolve);
      ws.onerror = () => done(reject, new Error(`cannot reach ${wsUrl}`));
      // A browser that dies between `/json/list` and this attach closes the
      // socket instead of erroring it; without this case it waited the timeout.
      ws.onclose = () => done(reject, new Error(`CDP socket closed before opening ${wsUrl}`));
    });
    ws.onmessage = (ev) => cdp.#dispatch(ev.data);
    // A dead browser must fail the in-flight commands, not leave them pending:
    // `send` promises are awaited all the way up to the CLI's exit code.
    ws.onclose = () => cdp.#abort('CDP socket closed');
    ws.onerror = () => cdp.#abort('CDP socket error');
    return cdp;
  }

  /** Rejects everything in flight with one reason; makes the client unusable. */
  #abort(reason) {
    // First reason wins: `close()` on an already-dead socket must not rewrite
    // "socket closed" as "connection closed" for whoever is waiting.
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    for (const [id, p] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(`${reason} before ${p.method} answered`));
    }
    for (const fn of [...this.#closeHandlers]) {
      this.#closeHandlers.delete(fn);
      try { fn(reason); } catch { /* a waiter must not break the abort */ }
    }
  }

  /**
   * Runs `fn(reason)` when the socket dies, once; returns the unsubscribe. An
   * event wait (`once`) that outlives the socket would otherwise stay pending
   * forever, and the caller awaits it as if the event were still coming.
   */
  onClose(fn) {
    // Already dead: answer on the next tick, so a caller that registers before
    // binding its own `off`/timer does not hit the TDZ.
    if (this.#closed) { queueMicrotask(() => fn(this.#closeReason)); return () => {}; }
    this.#closeHandlers.add(fn);
    return () => this.#closeHandlers.delete(fn);
  }

  #dispatch(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && this.#pending.has(msg.id)) {
      const { resolve, reject, timer } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    for (const fn of [...this.#listeners]) fn(msg);
  }

  /**
   * Sends a command and waits for its reply. `timeout` (default from
   * `BROWSIN_CDP_TIMEOUT_MS`, 0 to wait indefinitely) bounds the wait so a
   * wedged page/browser becomes an error instead of a hang.
   */
  send(method, params = {}, { timeout = this.#timeout } = {}) {
    if (this.#closed || !this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP connection closed before ${method}`));
    }
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method, timer: null };
      if (timeout > 0) {
        entry.timer = setTimeout(() => {
          if (!this.#pending.delete(id)) return;
          reject(timeoutError(`CDP ${method}`, timeout, timeout === this.#timeout));
        }, timeout);
      }
      this.#pending.set(id, entry);
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        // A socket that closed between the readyState check and the write.
        this.#pending.delete(id);
        clearTimeout(entry.timer);
        reject(new Error(`CDP ${method} could not be sent: ${err.message}`));
      }
    });
  }

  /** Registers an event listener; returns the unsubscribe function. */
  on(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * Resolves on the next occurrence of `event`, or rejects after `timeout` — or
   * as soon as the socket closes, naming the event: a browser that died
   * mid-navigation will never emit `Page.loadEventFired`.
   */
  once(event, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        off();
        offClose();
        clearTimeout(timer);
        fn(arg);
      };
      const off = this.on((m) => { if (m.method === event) done(resolve, m.params); });
      const offClose = this.onClose((reason) => done(reject, new Error(`${reason} before ${event} arrived`)));
      timer = setTimeout(() => done(reject, new Error(`timed out waiting for ${event}`)), timeout);
    });
  }

  /**
   * Evaluates an expression in the page and returns its value. Awaits promises,
   * and turns a page-side throw into a real rejection instead of a silent
   * `undefined` — the failure mode that makes hand-rolled CDP feel flaky.
   */
  async eval(expression, { returnByValue = true, timeout } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: true,
    }, timeout === undefined ? {} : { timeout });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'page threw');
    }
    return r.result?.value;
  }

  /** Closes the socket; pending commands and event waits reject like on a crash. */
  close() {
    this.#abort('CDP connection closed');
    try { this.#ws?.close(); } catch { /* already gone */ }
  }
}
