/**
 * Minimal Chrome DevTools Protocol client. No dependencies: Node 22+ ships a
 * global WebSocket, which is the only thing a CDP client actually needs.
 */
export class CDP {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Set();

  static async attach(wsUrl, { timeout = 10000 } = {}) {
    const cdp = new CDP();
    const ws = new WebSocket(wsUrl);
    cdp.#ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timed out')), timeout);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`cannot reach ${wsUrl}`)); };
    });
    ws.onmessage = (ev) => cdp.#dispatch(ev.data);
    return cdp;
  }

  #dispatch(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    for (const fn of [...this.#listeners]) fn(msg);
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Registers an event listener; returns the unsubscribe function. */
  on(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Resolves on the next occurrence of `event`, or rejects after `timeout`. */
  once(event, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const off = this.on((m) => {
        if (m.method !== event) return;
        off();
        clearTimeout(timer);
        resolve(m.params);
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${event}`));
      }, timeout);
    });
  }

  /**
   * Evaluates an expression in the page and returns its value. Awaits promises,
   * and turns a page-side throw into a real rejection instead of a silent
   * `undefined` — the failure mode that makes hand-rolled CDP feel flaky.
   */
  async eval(expression, { returnByValue = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'page threw');
    }
    return r.result?.value;
  }

  close() { try { this.#ws.close(); } catch { /* already gone */ } }
}
