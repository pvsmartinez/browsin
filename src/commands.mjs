import { existsSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { bringToFront, connect, launch, shutdown, shutdownAll, status as browserStatus } from './browser.mjs';
import { SNAPSHOT } from './query.mjs';
import { HEAVY_TIMEOUT_MS, cdpHttp } from './cdp.mjs';
import { buildLoginNoteHtml, loginGuideLines } from './login-note.mjs';
import { gc, listSessions } from './gc.mjs';
import { afterAction, cancelRecording, startRecording, statusRecording, stopRecording } from './recording.mjs';
import { readState, writeState, findBinary, SHOTS, DOWNLOADS, PROFILE, BROWSERS, BASE, SESSION, TTL_MIN, MAX_SESSIONS, ensureDirs } from './paths.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ helpers */

export const resolveTarget = (input) => {
  if (!input) return null;
  if (/^(https?|file|data|about|chrome):/.test(input)) return input;
  const asPath = resolvePath(input);
  if (existsSync(asPath)) return `file://${asPath}`;
  // `page.html#section` / `page.html?x=1`: the file exists, the suffix is the
  // URL's, not part of the name.
  const suffixed = /^([^#?]+)([#?].*)$/.exec(input);
  if (suffixed && existsSync(resolvePath(suffixed[1]))) return `file://${resolvePath(suffixed[1])}${suffixed[2]}`;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/.test(input)) return `http://${input}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(input)) return `http://${input}`;
  // A path-shaped argument that does not exist is a typo or a wrong cwd, never
  // a hostname. Guessing https:// there turns it into a confusing DNS error.
  if (/^[.~/]/.test(input) || /\/.*\.(html?|pdf|svg|md|txt|json)$/i.test(input)) {
    throw new Error(`no such file: ${input} (cwd ${process.cwd()})`);
  }
  return `https://${input}`;
};

/**
 * A `--name` is a file name inside the session's shots/, never a path: a
 * route like `experiments/detail` used as a name must not need a directory
 * that does not exist, nor climb out with `..`.
 */
const shotName = (name, fallback) => String(name || fallback).replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '') || fallback;

/** PNG dimensions straight from the IHDR chunk — no image library needed. */
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

const drainLogs = async (cdp) => {
  const raw = await cdp.eval('window.__browsin ? JSON.stringify(window.__browsin.drain()) : "[]"').catch(() => '[]');
  try { return JSON.parse(raw); } catch { return []; }
};

const NOISE = /^(log|info|debug)$/;

const renderLogs = (logs, { all = false } = {}) => {
  const shown = all ? logs : logs.filter((l) => !NOISE.test(l.kind));
  const hidden = logs.length - shown.length;
  const lines = shown.map((l) => `  [${l.kind}] ${l.msg}`);
  if (hidden > 0) lines.push(`  (+${hidden} log/info/debug — browsin logs --all)`);
  return lines;
};

/** Headline plus detail, so a clean page costs exactly one line of output. */
const logSummary = (logs) => {
  const problems = logs.filter((l) => !NOISE.test(l.kind));
  const quiet = logs.length - problems.length;
  if (!problems.length) return [`logs  clean${quiet ? ` (+${quiet} log/info/debug)` : ''}`];
  return [`logs  ${problems.length} problem(s):`, ...renderLogs(logs)];
};

const waitForExpression = async (cdp, expr, timeout) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ok = await cdp.eval(`!!(${expr})`).catch(() => false);
    if (ok) return true;
    await sleep(100);
  }
  return false;
};

/**
 * `--wait` after an action (reload, click, key): a condition that never held
 * must say so — silence read as "the flow worked" (the recipe that confirms a
 * login with `key Enter --wait 'location.pathname !== "/"'`).
 */
const waitNotes = async (cdp, expr, timeout) =>
  (await waitForExpression(cdp, expr, timeout)) ? [] : [`note  --wait never became true: ${expr}`];

/**
 * Resolves a selector through the in-page helper, so every command inherits
 * `text=` matching and shadow-DOM piercing. Returns the box in viewport
 * coordinates, ready for synthetic input.
 */
const findEl = async (cdp, sel, { nth = 0, scroll = false } = {}) => {
  const raw = await cdp.eval(`(() => {
    const q = window.__bq(${JSON.stringify(sel)}, ${Number(nth)});
    if (!q.el) return JSON.stringify({ found: false, matches: q.matches, visibleMatches: q.visibleMatches });
    ${scroll ? "q.el.scrollIntoView({ block: 'center', inline: 'center' });" : ''}
    const r = q.el.getBoundingClientRect();
    return JSON.stringify({
      found: true, matches: q.matches, visibleMatches: q.visibleMatches,
      tag: q.el.tagName.toLowerCase(),
      inFrame: q.ox !== 0 || q.oy !== 0,
      x: r.x + q.ox + r.width / 2, y: r.y + q.oy + r.height / 2,
      w: r.width, h: r.height, top: r.y + q.oy, left: r.x + q.ox,
      docX: r.x + q.ox + scrollX, docY: r.y + q.oy + scrollY,
    });
  })()`);
  const box = JSON.parse(raw);
  if (!box.found) throw noMatchError(sel, box);
  return box;
};

/**
 * No-match errors teach the next attempt instead of just reporting: `text=`
 * when nothing matched at all (address by what the user reads), `--nth` when
 * several elements share the selector. Same exit code, just a better message.
 */
const noMatchError = (sel, box) => {
  const base = `no match for ${sel} (${box.matches} in DOM, ${box.visibleMatches} visible)`;
  if (Number(box.matches) === 0)
    return new Error(`${base}\nhint  if it is on screen, address it by the visible label: 'text=<text>'`);
  if (Number(box.matches) > 1)
    return new Error(`${base}\nhint  ${box.matches} elements match — pick one with --nth N (0-based)`);
  return new Error(base);
};

/** A live element handle, for the CDP calls that need one (file inputs). */
const objectIdFor = async (cdp, sel, nth = 0) => {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `window.__bq(${JSON.stringify(sel)}, ${Number(nth)}).el`,
    returnByValue: false,
  });
  if (!r.result?.objectId) throw new Error(`no match for ${sel}`);
  return r.result.objectId;
};

/**
 * Records real requests at the protocol level for the duration of a navigation.
 * The in-page collector cannot see the document, scripts or stylesheets — those
 * are fetched before any page script exists.
 */
const recordNetwork = async (cdp) => {
  // One record per request, keyed by requestId, so a failure keeps the URL it
  // was for (loadingFailed carries none) and a request still in flight is
  // visible. Events for a requestId this recording never saw start (the
  // previous page's requests, canceled by the navigation) are not ours.
  const reqs = new Map();
  let committed = false;
  const mainFrame = await cdp.send('Page.getFrameTree').then((t) => t.frameTree.frame.id).catch(() => null);
  await cdp.send('Network.enable', { maxTotalBufferSize: 1_000_000 });
  const off = cdp.on((m) => {
    const p = m.params;
    if (m.method === 'Runtime.executionContextsCleared' && !committed) {
      // The navigation committed: what the previous document requested in
      // the meantime (a poll, a late call, an iframe it reloaded) is its own,
      // not this page's. The main frame's documents (the navigation and its
      // redirects) stay.
      committed = true;
      for (const [id, r] of reqs) if (!(r.type === 'Document' && r.frameId === mainFrame)) reqs.delete(id);
      return;
    }
    if (m.method === 'Network.requestWillBeSent') {
      // A CORS preflight (OPTIONS) has its own requestId and names the real
      // request as its initiator. Its fate is the real request's: when the
      // page aborts that one mid-preflight (React StrictMode's first fetch),
      // Chromium reports nothing more for the preflight — no response, no
      // finish, no failure — and it would hold the settle to the timeout.
      const preflightFor = p.initiator?.type === 'preflight' ? p.initiator.requestId : null;
      // A redirect reuses the requestId: the same request, now at the new URL.
      reqs.set(p.requestId, { method: p.request.method, url: p.request.url, type: p.type || 'Other', frameId: p.frameId,
        status: null, error: null, canceled: false, done: !!reqs.get(preflightFor)?.done, preflightFor });
      return;
    }
    const r = p && reqs.get(p.requestId);
    if (!r) return;
    if (m.method === 'Network.responseReceived') {
      r.status = p.response.status; r.type = p.type || r.type;
      // A preflight is its headers: the answer is in, nothing else is coming.
      if (r.type === 'Preflight') r.done = true;
    } else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') {
      r.done = true;
      if (m.method === 'Network.loadingFailed') { r.error = p.errorText; r.canceled = !!p.canceled; }
      for (const q of reqs.values()) if (q.preflightFor === p.requestId) q.done = true;
    }
  });
  const stop = () => { off(); return [...reqs.values()]; };
  // EventSource and WebSocket stay open by design; they are never "in flight".
  stop.inflight = () => [...reqs.values()].filter((r) => !r.done && r.type !== 'EventSource' && r.type !== 'WebSocket');
  return stop;
};

/**
 * A request canceled before any response (an AbortController, a navigation
 * away, a lazy image dropped) is the page's own decision, not a failure: React
 * StrictMode aborts every first fetch of an effect in dev, and a gate that
 * counted those would never pass. A response with an HTTP error status still
 * counts when the page then aborts reading its body: the server did answer 4xx/5xx.
 */
const requestFailed = (r) => (r.status !== null && r.status >= 400) || (!!r.error && !r.canceled);

/** A console argument (a CDP RemoteObject) as the text the console would show. */
const remoteText = (o) => {
  if (o.type === 'string') return o.value;
  if (o.type === 'undefined') return 'undefined';
  if ('value' in o) return typeof o.value === 'object' ? JSON.stringify(o.value) : String(o.value);
  return o.unserializableValue || o.description || o.type;
};

/**
 * Console errors and uncaught exceptions from the protocol. The in-page buffer
 * lives in the document, so a page that logs and then redirects
 * (`location.replace`, an auth bounce) took its errors with it before anyone
 * drained it; this stream outlives the document. Messages older than the
 * recording are dropped: `Runtime.enable` (in connect) replays the console
 * history of the page the previous command left — today that replay lands
 * before this subscription, and the timestamp keeps it out if the order ever
 * changes. An exception later handled (`exceptionRevoked`: a rejection caught
 * late) is not an error.
 *
 * `navigation` (open, reload, check): the window starts a new page, so what
 * the previous document logged while the navigation was pending is dropped at
 * the first commit. An action (click, key, js…) keeps it: the error a click
 * handler logs right before the browser follows the link is the click's.
 */
const recordConsole = (cdp, { navigation = true } = {}) => {
  const t0 = Date.now();
  let entries = [];
  const byId = new Map();
  let committed = false;
  const off = cdp.on((m) => {
    const p = m.params;
    if (m.method === 'Runtime.executionContextsCleared') {
      // The first commit replaces the previous route's document: what it
      // logged while the navigation was pending is not this page's. Later
      // ones (a redirect of this page) keep everything — that is the case
      // this stream exists for.
      if (!committed) { committed = true; if (navigation) entries = []; }
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      if ((p.type !== 'error' && p.type !== 'assert') || p.timestamp < t0) return;
      entries.push({ kind: 'error', msg: (p.args || []).map(remoteText).join(' ').slice(0, 600) });
    } else if (m.method === 'Runtime.exceptionThrown') {
      if (p.timestamp < t0) return;
      const d = p.exceptionDetails;
      const what = (d.exception?.description || '').split('\n')[0];
      const where = d.url ? ` @ ${d.url}:${(d.lineNumber ?? 0) + 1}` : '';
      const e = { kind: /in promise/.test(d.text || '') ? 'rejection' : 'exception',
        msg: `${d.text || 'Uncaught'}${what ? ` ${what}` : ''}${where}`.slice(0, 600) };
      byId.set(d.exceptionId, e);
      entries.push(e);
    } else if (m.method === 'Runtime.exceptionRevoked') {
      const e = byId.get(p.exceptionId);
      if (e) e.revoked = true;
    }
  });
  const stop = () => { off(); return entries.filter((e) => !e.revoked); };
  // Drops what arrived so far: called, in message order, at the boundary a
  // command takes when it starts (see recordLogs).
  stop.cut = () => { entries = []; };
  return stop;
};

const EXCEPTION_KINDS = new Set(['exception', 'rejection']);
/** Kinds the protocol stream reports; the in-page copy of these is a duplicate. */
const fromProtocol = (l) => EXCEPTION_KINDS.has(l.kind) || l.kind === 'error';

/**
 * What the page reported during one command — every command that reports
 * logs goes through here. Exceptions and console errors come from the protocol
 * (`recordConsole`), which outlives the document: what a page logs right before
 * it replaces itself (a redirect, the link a click followed, the form an Enter
 * submitted) is still reported. The rest — warn/log/info, a resource that
 * failed, the collector's http/neterr — comes from the in-page buffer.
 *
 * The buffer is split at a mark taken at the start, never drained there, so a
 * command that fails before its own drain (no match, a `js` that throws) leaves
 * it whole for `logs`. The protocol stream is cut at the same point: at the
 * mark's reply, in message order (`onReply`). The browser sends a renderer's
 * events in the order they happened, so an error the stream received before
 * that reply was emitted before mark() ran, and its in-page copy sits before
 * the mark — one side of the boundary for both streams, never counted twice.
 * Without a mark (no collector) nothing is cut and the buffer's errors are
 * left to the stream. What the page logged before the mark (between commands)
 * is reported whole by an action, as it always was, and dropped by a
 * navigation (`navigation: true`), whose window is the new page. `stop.pull()`
 * drains mid-window (check's settle loop), so a document replaced later does
 * not take its warnings with it.
 */
const recordLogs = async (cdp, { navigation = false } = {}) => {
  const stopConsole = recordConsole(cdp, { navigation });
  const take = async (expr) => {
    try { return JSON.parse(await cdp.eval(expr)); } catch { return null; }
  };
  let start = null;
  await cdp.eval('window.__browsin && window.__browsin.mark ? JSON.stringify(window.__browsin.mark()) : "null"', {
    onReply: (msg) => {
      try { start = JSON.parse(msg.result?.result?.value); } catch { start = null; }
      if (start) stopConsole.cut();
    },
  }).catch(() => {});
  const earlier = [];
  const page = [];
  const pull = async () => {
    const got = await take(`window.__browsin ? JSON.stringify({ mark: window.__browsin.mark ? window.__browsin.mark() : null,
      entries: window.__browsin.drain() }) : "null"`);
    if (!got) return;
    const sameDoc = !!(start && got.mark && got.mark.doc === start.doc);
    for (const l of got.entries) {
      if (sameDoc && l.seq <= start.seq) { if (!navigation) earlier.push(l); }
      else if (!fromProtocol(l)) page.push(l);
    }
  };
  const stop = async () => {
    await pull();
    return [...earlier, ...stopConsole(), ...page];
  };
  stop.pull = pull;
  stop.off = () => { stopConsole(); };
  return stop;
};

const requestLabel = (r) => {
  if (r.status !== null && r.status >= 400) return String(r.status);
  if (r.error) return r.canceled ? 'canceled' : r.error;
  return r.status !== null ? String(r.status) : 'pending';
};

const renderNetwork = (records, { all = false } = {}) => {
  const line = (r) => `  [${requestLabel(r)}] ${r.type} ${r.url}`;
  if (!all) {
    const bad = records.filter(requestFailed);
    if (!bad.length) return [`net   ${records.length} request(s), all ok`];
    return [`net   ${bad.length} of ${records.length} request(s) failed:`, ...bad.map(line)];
  }
  return [`net   ${records.length} request(s):`, ...records.map(line)];
};

/**
 * Best-effort mount wait: an SPA that paints after `load` would otherwise be
 * photographed/examined blank. Cheap when the page already has content; bounded
 * when it does not, so a canvas-only or genuinely empty page is not delayed for
 * long. `--wait '<expr>'` overrides it, `--no-wait` disables it.
 */
const waitForMount = async (cdp, { timeout = 1500 } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const ready = await cdp.eval(`(() => {
      const b = document.body;
      if (b && b.innerText.trim().length) return true;
      const root = document.querySelector('#root, #app, #__next, [data-reactroot]');
      return !!(root && root.children.length);
    })()`).catch(() => true); // an eval failure must never block
    if (ready) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
};

const navigate = async (cdp, url, { waitExpr, timeout = 15000, noWait = false } = {}) => {
  const notes = [];
  const loaded = cdp.once('Page.loadEventFired', { timeout }).catch(() => null);
  const nav = await cdp.send('Page.navigate', { url });
  if (nav.errorText) throw Object.assign(new Error(`${url} — ${nav.errorText}`), { navError: nav.errorText });
  // No loaderId = a same-document navigation (only the #fragment changed):
  // there is no load event to wait for, and waiting cost the full timeout.
  if (nav.loaderId && (await loaded) === null) notes.push('load event never fired (timeout)');
  await waitForExpression(cdp, 'document.readyState === "complete"', 3000);
  // `notes.waitOk` carries the --wait outcome to the callers that judge it
  // (check --fail-on); null when there was no --wait.
  notes.waitOk = null;
  if (waitExpr) {
    notes.waitOk = await waitForExpression(cdp, waitExpr, timeout);
    if (!notes.waitOk) notes.push(`--wait never became true: ${waitExpr}`);
  } else if (!noWait && !(await waitForMount(cdp, { timeout: Math.min(timeout, 1500) }))) {
    notes.push('body still empty after waiting for mount — pass --wait with an app-specific condition');
  }
  // Two frames of settle time: enough for a mounted framework to paint.
  await settle(cdp);
  return notes;
};

const settle = (cdp) =>
  cdp.eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => {});

const pageHead = async (cdp) =>
  await cdp.eval('JSON.stringify({ title: document.title, url: location.href })').then(JSON.parse);

const dialogLines = (dialogs) => dialogs.map((d) => `dial  auto-accepted ${d}`);

/* ------------------------------------------------------------ page lifecycle */

export const cmdOpen = async (args) => {
  const url = resolveTarget(args._[0]);
  if (!url) throw new Error('usage: browsin open <url|file>');
  const { cdp, viewport, dialogs } = await connect();
  const stopLogs = await recordLogs(cdp, { navigation: true });
  const stopNet = await recordNetwork(cdp);
  const notes = await navigate(cdp, url, { waitExpr: args.wait, timeout: Number(args.timeout || 15000), noWait: !!args['no-wait'] });
  const head = await pageHead(cdp);
  const logs = await stopLogs();
  const net = stopNet();
  await afterAction(cdp);
  cdp.close();

  return [`open  ${head.url}`, `title ${head.title || '(untitled)'}`,
    `view  ${viewport.width}x${viewport.height} @${viewport.dpr}x`,
    ...notes.map((n) => `note  ${n}`), ...dialogLines(dialogs),
    ...renderNetwork(net, { all: !!args.net }), ...logSummary(logs)].join('\n');
};

/* --------------------------------------------------------------- QA gate */

/** What `check --fail-on` can fail on; `errors` is all of them. */
const FAIL_ON = ['exceptions', 'console', 'network', 'wait'];

const parseFailOn = (v) => {
  if (v === undefined) return null;
  if (v === true) return [...FAIL_ON];
  const out = new Set();
  for (const w of String(v).split(',').map((s) => s.trim()).filter(Boolean)) {
    if (w === 'errors') FAIL_ON.forEach((c) => out.add(c));
    else if (FAIL_ON.includes(w)) out.add(w);
    else throw new Error(`--fail-on: unknown category "${w}" (errors, ${FAIL_ON.join(', ')})`);
  }
  if (!out.size) throw new Error(`--fail-on needs a category (errors, ${FAIL_ON.join(', ')})`);
  return [...out];
};

const parseIgnore = (v) => [].concat(v ?? []).map((p) => {
  if (typeof p !== 'string' || !p) throw new Error(`--ignore needs a regex, e.g. --ignore 'favicon\\.ico$'`);
  try { return new RegExp(p); } catch (err) { throw new Error(`--ignore: invalid regex ${p} (${err.message})`); }
});

const parseMs = (v, flag) => {
  const n = Number(v);
  if (v === true || v === '' || !Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a number of milliseconds (>= 0)`);
  return n;
};

const isInflight = (r) => !r.done && r.type !== 'EventSource' && r.type !== 'WebSocket';

/**
 * The settle window: errors that arrive after the mount (an API call that
 * 500s, the render that throws on its response) are what a gate exists to
 * catch. Watch for `settleMs`, then until no request is in flight (bounded by
 * `timeout`), draining the page's log buffer on every tick (`pull`) so a
 * document replaced mid-window (a redirect) does not take its warnings with it.
 */
const observe = async (cdp, stopNet, pull, { settleMs, timeout, ignore = [] }) => {
  // An ignored request (a stream the gate was told about) is not waited for.
  const waitingOn = () => stopNet.inflight().filter((r) => !ignore.some((re) => re.test(r.url)));
  const t0 = Date.now();
  const minEnd = t0 + settleMs;
  const hardEnd = minEnd + timeout;
  let waitedForNet = false;
  for (;;) {
    await pull();
    const now = Date.now();
    if (now >= hardEnd || (now >= minEnd && !waitingOn().length)) break;
    if (now >= minEnd) waitedForNet = true;
    await sleep(100);
  }
  // A response that just landed renders on the next frames; let it throw now.
  if (waitedForNet) { await settle(cdp); await pull(); }
  return Date.now() - t0;
};

/**
 * The verdict, as data. Network problems come from the protocol (status and
 * URL of every request, including the document and scripts the in-page
 * collector never sees), so the collector's own http/neterr/resource entries
 * are not counted twice. `--ignore` matches a request URL, or the message of
 * an exception or console error.
 */
export const gateVerdict = ({ logs, net, waitOk = null, navError = null, failOn = null, ignore = [] }) => {
  const ignored = { exceptions: 0, consoleErrors: 0, failedRequests: 0, pending: 0 };
  const keep = (bucket, text) => {
    if (!ignore.some((re) => re.test(text))) return true;
    ignored[bucket]++;
    return false;
  };
  const exceptions = logs.filter((l) => EXCEPTION_KINDS.has(l.kind))
    .map((l) => ({ kind: l.kind, message: l.msg })).filter((e) => keep('exceptions', e.message));
  const consoleErrors = logs.filter((l) => l.kind === 'error')
    .map((l) => ({ message: l.msg })).filter((e) => keep('consoleErrors', e.message));
  const req = (r) => ({ method: r.method, url: r.url, type: r.type, status: r.status, error: r.error });
  const failedRequests = net.filter(requestFailed).filter((r) => keep('failedRequests', r.url)).map(req);
  const pending = net.filter(isInflight).filter((r) => keep('pending', r.url))
    .map(({ method, url, type }) => ({ method, url, type }));
  const counted = failOn || FAIL_ON;
  const counts = { exceptions: exceptions.length, console: consoleErrors.length,
    network: failedRequests.length, wait: waitOk === false ? 1 : 0 };
  const failing = counted.filter((c) => counts[c] > 0);
  return { ok: !navError && !failing.length, failing, counted, counts,
    exceptions, consoleErrors, failedRequests, pending, ignored };
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const gateLine = (v, navError) => {
  const ign = Object.values(v.ignored).reduce((a, b) => a + b, 0);
  const tail = ign ? ` (${ign} ignored)` : '';
  if (v.ok) return `gate  ok${tail}`;
  const parts = [];
  if (navError) parts.push(`navigation failed: ${navError}`);
  const say = { exceptions: plural(v.counts.exceptions, 'exception'),
    console: plural(v.counts.console, 'console error'),
    network: plural(v.counts.network, 'failed request'), wait: '--wait never true' };
  for (const c of v.failing) parts.push(say[c]);
  return `gate  FAIL — ${parts.join(' · ')}${tail}`;
};

/**
 * One call that answers "is the page fine?" — navigate, problems, pixels.
 * With `--fail-on`, it is also a QA gate: exit 2 when the page has problems in
 * those categories (0 when clean, 1 when browsin itself could not run), and
 * `--json` prints the verdict for a machine.
 */
export const cmdCheck = async (args) => {
  const url = resolveTarget(args._[0]);
  if (!url) throw new Error('usage: browsin check <url|file>');
  const failOn = parseFailOn(args.failOn);
  const ignore = parseIgnore(args.ignore);
  const timeout = args.timeout === undefined ? 15000 : parseMs(args.timeout, '--timeout');
  const settleMs = args.settle !== undefined ? parseMs(args.settle, '--settle') : (failOn ? 1000 : 0);
  const json = !!args.json;
  const t0 = Date.now();

  const { cdp, viewport, dialogs } = await connect();
  // What the previous page left undrained is not this route's problem.
  const stopLogs = await recordLogs(cdp, { navigation: true });
  const stopNet = await recordNetwork(cdp);
  let notes;
  try {
    notes = await navigate(cdp, url, { waitExpr: args.wait, timeout, noWait: !!args['no-wait'] });
  } catch (err) {
    // Unreachable page: without --fail-on it stays an error (exit 1); as a gate
    // it is the verdict — the route did not load.
    if (!failOn || !err.navError) throw err;
    stopNet();
    stopLogs.off();
    cdp.close();
    const v = gateVerdict({ logs: [], net: [], navError: err.navError, failOn, ignore });
    if (json) {
      return { out: JSON.stringify({ ok: false, target: url, url: null, title: null, failOn: v.counted,
        wait: args.wait ? { expr: args.wait, ok: null } : null, error: err.navError,
        exceptions: [], consoleErrors: [], failedRequests: [], pending: [], ignored: v.ignored,
        requests: 0, warnings: [], notes: [], dialogs, timing: { totalMs: Date.now() - t0, settleMs: 0 }, shot: null },
      null, 2), code: 2 };
    }
    return { out: [`check ${url}`, `error ${err.navError}`, gateLine(v, err.navError)].join('\n'), code: 2 };
  }
  const settledMs = settleMs ? await observe(cdp, stopNet, stopLogs.pull, { settleMs, timeout, ignore }) : 0;
  const head = await pageHead(cdp);
  // Exceptions and console errors from the protocol stream (it survives a
  // redirect); the rest (warn, resource, the collector's http/neterr) from the page.
  const logs = await stopLogs();
  const net = stopNet();
  const stats = JSON.parse(await cdp.eval(`JSON.stringify({
    nodes: document.querySelectorAll('*').length,
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    scrollHeight: document.documentElement.scrollHeight,
    emptyBody: document.body ? document.body.innerText.trim().length === 0 : true
  })`));
  await afterAction(cdp);
  cdp.close();

  const v = gateVerdict({ logs, net, waitOk: notes.waitOk, failOn, ignore });
  const code = failOn && !v.ok ? 2 : 0;
  const warnings = [];
  if (stats.emptyBody) warnings.push('body renders no text');
  if (stats.overflowX) warnings.push('horizontal overflow at this viewport');

  let shot = null;
  let snapText = null;
  if (!args['no-snap']) {
    shot = join(SHOTS, `${shotName(args.name, 'check')}.png`);
    snapText = await cmdSnap({ _: [], clip: args.clip, full: args.full, o: shot, dpr: args.dpr });
  }

  if (json) {
    return { out: JSON.stringify({ ok: v.ok, target: url, url: head.url, title: head.title, failOn: v.counted,
      wait: args.wait ? { expr: args.wait, ok: notes.waitOk } : null, error: null,
      exceptions: v.exceptions, consoleErrors: v.consoleErrors, failedRequests: v.failedRequests,
      pending: v.pending, ignored: v.ignored, requests: net.length, warnings, notes: [...notes], dialogs,
      timing: { totalMs: Date.now() - t0, settleMs: settledMs }, shot }, null, 2), code };
  }

  const out = [`check ${head.url}`, `title ${head.title || '(untitled)'}`,
    `view  ${viewport.width}x${viewport.height} @${viewport.dpr}x · ${stats.nodes} nodes · page ${stats.scrollHeight}px tall`,
    ...notes.map((n) => `note  ${n}`), ...dialogLines(dialogs)];
  if (stats.emptyBody) out.push(`warn  body renders no text — app may not have mounted; retry with --wait, e.g. browsin check <url> --wait 'document.querySelector("#root")?.children.length > 0'`);
  if (stats.overflowX) out.push('warn  horizontal overflow at this viewport');
  out.push(...renderNetwork(net, { all: !!args.net }), ...logSummary(logs));
  if (settleMs && v.pending.length) {
    out.push(`note  ${plural(v.pending.length, 'request')} still in flight after settling:`,
      ...v.pending.slice(0, 5).map((r) => `  [pending] ${r.type} ${r.url}`));
  }
  if (failOn) out.push(gateLine(v, null));
  if (snapText) out.push('', snapText);
  return failOn ? { out: out.join('\n'), code } : out.join('\n');
};

export const cmdReload = async (args) => {
  const { cdp, dialogs } = await connect();
  const stopLogs = await recordLogs(cdp, { navigation: true });
  const stopNet = await recordNetwork(cdp);
  const loaded = cdp.once('Page.loadEventFired', { timeout: Number(args.timeout || 15000) }).catch(() => null);
  await cdp.send('Page.reload', { ignoreCache: !!args.hard });
  await loaded;
  await waitForExpression(cdp, 'document.readyState === "complete"', 3000);
  const waited = args.wait ? await waitNotes(cdp, args.wait, Number(args.timeout || 15000)) : [];
  await settle(cdp);
  const head = await pageHead(cdp);
  const logs = await stopLogs();
  const net = stopNet();
  await afterAction(cdp);
  cdp.close();
  return [`reload ${head.url}${args.hard ? ' (cache bypassed)' : ''}`, ...waited, ...dialogLines(dialogs),
    ...renderNetwork(net, { all: !!args.net }), ...logSummary(logs)].join('\n');
};

export const cmdBack = async () => {
  const { cdp } = await connect();
  const { currentIndex, entries } = await cdp.send('Page.getNavigationHistory');
  if (currentIndex <= 0) { cdp.close(); return 'back  no earlier entry in history'; }
  await cdp.send('Page.navigateToHistoryEntry', { entryId: entries[currentIndex - 1].id });
  await waitForExpression(cdp, 'document.readyState === "complete"', 5000);
  await settle(cdp);
  const head = await pageHead(cdp);
  await afterAction(cdp);
  cdp.close();
  return `back  ${head.url}`;
};

/* -------------------------------------------------------------- observation */

/**
 * The cheap answer to "what is on the screen?". Every row carries a selector
 * that `click`/`type` accept, so a snapshot is directly actionable.
 */
export const cmdSnapshot = async (args) => {
  const { cdp, viewport } = await connect();
  const data = JSON.parse(await cdp.eval(SNAPSHOT));
  cdp.close();

  const limit = Number(args.limit || 60);
  const rows = args.onscreen ? data.rows.filter((r) => r.onScreen) : data.rows;
  const shown = rows.slice(0, limit);
  const out = [
    `page  ${data.url}`,
    `title ${data.title || '(untitled)'} · ${viewport.width}x${viewport.height} · scroll ${data.scroll}/${data.pageHeight}px`,
  ];
  // A selector that matches several rows is a trap: annotate the ordinal so the
  // line can be pasted into `click`/`type` and still hit what the agent read.
  const tally = {};
  for (const r of shown) tally[r.sel] = (tally[r.sel] || 0) + 1;
  const ordinal = {};
  for (const r of shown) {
    const bits = [`[${r.role}]`];
    if (r.name) bits.push(JSON.stringify(r.name));
    if (tally[r.sel] > 1) {
      const n = ordinal[r.sel] = (ordinal[r.sel] ?? -1) + 1;
      bits.push(`· ${r.sel} --nth ${n}`);
    } else bits.push(`· ${r.sel}`);
    bits.push(`· y${r.y} ${r.w}x${r.h}`);
    if (r.value) bits.push(`· value=${JSON.stringify(r.value)}`);
    if (r.disabled) bits.push('· disabled');
    if (!r.onScreen) bits.push('· offscreen');
    out.push('  ' + bits.join(' '));
  }
  if (rows.length > shown.length) out.push(`  (+${rows.length - shown.length} more — --limit N)`);
  return out.join('\n');
};

export const cmdDom = async (args) => {
  const sel = args._[0];
  if (!sel) throw new Error('usage: browsin dom <selector>');
  const { cdp } = await connect();
  const limit = Number(args.html || 1200);
  const raw = await cdp.eval(`(() => {
    const q = window.__bq(${JSON.stringify(sel)}, ${Number(args.nth || 0)});
    if (!q.el) return JSON.stringify({ matches: q.matches, visibleMatches: q.visibleMatches });
    const el = q.el;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const keys = ['display','position','visibility','opacity','overflow','color','backgroundColor',
      'fontSize','fontWeight','fontFamily','flexDirection','gridTemplateColumns','zIndex','transform','border','padding'];
    const styles = {};
    for (const k of keys) if (cs[k] && cs[k] !== 'none' && cs[k] !== 'normal') styles[k] = cs[k];
    const html = el.outerHTML;
    return JSON.stringify({
      matches: q.matches, visibleMatches: q.visibleMatches,
      selector: window.__bsel(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: typeof el.className === 'string' && el.className ? el.className : undefined,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      visible: window.__bvisible(el),
      inViewport: r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0,
      text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 300) || undefined,
      styles,
      html: html.length > ${limit} ? html.slice(0, ${limit}) + ' …(' + html.length + ' chars)' : html
    }, null, 2);
  })()`);
  cdp.close();
  const data = JSON.parse(raw);
  if (!data.tag) return `dom   no match for ${sel} (${data.matches} in DOM, ${data.visibleMatches} visible)`;
  return raw;
};

/**
 * innerText of an element, whitespace normalised (blank lines collapse away)
 * and capped — the token-cheap way to read a page. Default selector: body.
 */
export const cmdText = async (args) => {
  const sel = args._[0] || 'body';
  const { cdp } = await connect();
  const raw = await cdp.eval(`(() => {
    const q = window.__bq(${JSON.stringify(sel)}, ${Number(args.nth || 0)});
    if (!q.el) return JSON.stringify({ matches: q.matches, visibleMatches: q.visibleMatches });
    return JSON.stringify({ tag: q.el.tagName.toLowerCase(), text: q.el.innerText });
  })()`);
  cdp.close();
  const data = JSON.parse(raw);
  if (!data.tag) throw noMatchError(sel, data);
  const text = (data.text || '')
    .replace(/[ \t\r]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n+/g, '\n').trim();
  const limit = Number(args.limit ?? 2000);
  if (limit > 0 && text.length > limit)
    return `${text.slice(0, limit)} … (${text.length - limit} more chars)`;
  return text;
};

export const cmdJs = async (args) => {
  const expr = args._.join(' ');
  if (!expr) throw new Error("usage: browsin js '<expression>'");
  const { cdp } = await connect();
  const stopLogs = await recordLogs(cdp);
  let value;
  try {
    value = await cdp.eval(expr);
  } catch (err) {
    // An expression that returns a Window, a DOM node or a circular object ran
    // fine, but returnByValue cannot ship it over CDP. Report that instead of a
    // protocol error the agent cannot act on — and do NOT re-evaluate (side
    // effects like window.open must happen once).
    if (/Object reference chain is too long|Could not be cloned|Return value|not serializable/i.test(err.message)) {
      value = '(valor não serializável — a expressão rodou; retorne um primitivo ou use `void`)';
    } else throw err;
  }
  const logs = await stopLogs();
  await afterAction(cdp);
  cdp.close();
  const out = [typeof value === 'string' ? value : JSON.stringify(value, null, 2)];
  if (logs.length) out.push('--- logs ---', ...renderLogs(logs, { all: true }));
  return out.join('\n');
};

/**
 * What the page logged between commands, from the in-page buffer — the only
 * copy that outlives the CLI process that saw it happen (no daemon). Each
 * command reports its own window through `recordLogs`; this is what lands
 * after it returned, as long as the document that logged it is still there.
 */
export const cmdLogs = async (args) => {
  const { cdp } = await connect();
  const logs = await drainLogs(cdp);
  cdp.close();
  if (!logs.length) return 'logs  clean';
  return [`logs  ${logs.length} entr(ies):`, ...renderLogs(logs, { all: !!args.all })].join('\n');
};

export const cmdNetwork = async (args) => {
  const url = args._[0] ? resolveTarget(args._[0]) : null;
  const { cdp } = await connect();
  const stopNet = await recordNetwork(cdp);
  if (url) await navigate(cdp, url, { waitExpr: args.wait, timeout: Number(args.timeout || 15000), noWait: !!args['no-wait'] });
  else await cmdReloadInline(cdp, args);
  const net = stopNet();
  cdp.close();
  return renderNetwork(net, { all: args.failed ? false : true }).join('\n');
};

const cmdReloadInline = async (cdp, args) => {
  const loaded = cdp.once('Page.loadEventFired', { timeout: 15000 }).catch(() => null);
  await cdp.send('Page.reload', { ignoreCache: true });
  await loaded;
  await waitForExpression(cdp, 'document.readyState === "complete"', 3000);
  if (args.wait) await waitForExpression(cdp, args.wait, Number(args.timeout || 15000));
  await settle(cdp);
};

/* ------------------------------------------------------------------- pixels */

export const cmdSnap = async (args) => {
  const { cdp, viewport } = await connect();
  // Output density, defaulting to 1 to keep the image cheap in tokens. CDP
  // multiplies clip.scale by the emulated deviceScaleFactor, so divide it back
  // out: asking for 1x on a @2x mobile viewport must not yield a 4x image.
  const outDpr = Number(args.dpr || 1);
  const scale = outDpr / (viewport.dpr || 1);
  // Only a region that can extend past the viewport (`--clip`, `--full`) needs
  // captureBeyondViewport: it makes Chrome relayout to render the hidden area,
  // firing a resize event that reflows resize-reactive pages (canvas, Blockly).
  // The default shot is exactly the visible area, so it captures with `false`
  // and leaves the page's layout untouched.
  const params = { format: args.jpeg ? 'jpeg' : 'png', captureBeyondViewport: !!(args.clip || args.full) };
  if (args.jpeg) params.quality = Number(args.quality || 80);
  let truncated = null;

  if (args.clip) {
    const box = await findEl(cdp, args.clip, { nth: Number(args.nth || 0), scroll: true });
    if (box.w < 1 || box.h < 1) { cdp.close(); throw new Error(`--clip element has no size: ${args.clip}`); }
    const pad = Number(args.pad || 0);
    params.clip = { x: box.docX - box.w / 2 - pad, y: box.docY - box.h / 2 - pad,
      width: box.w + pad * 2, height: box.h + pad * 2, scale };
  } else if (args.full) {
    const cap = Number(args.maxHeight || 4000);
    const doc = JSON.parse(await cdp.eval(`JSON.stringify({
      w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })`));
    params.clip = { x: 0, y: 0, width: Math.min(doc.w, viewport.width), height: Math.min(doc.h, cap), scale };
    if (doc.h > cap) truncated = doc.h;
  } else {
    params.clip = { x: 0, y: 0, width: viewport.width, height: viewport.height, scale };
  }

  const shot = await cdp.send('Page.captureScreenshot', params, { timeout: HEAVY_TIMEOUT_MS });
  const buf = Buffer.from(shot.data, 'base64');
  ensureDirs();
  const ext = args.jpeg ? 'jpg' : 'png';
  const out = args.o || args.out || join(SHOTS, `${shotName(args.name, 'shot')}.${ext}`);
  writeFileSync(out, buf);
  cdp.close();

  // JPEG has no cheap header to read, so fall back to the clip we asked for.
  const dims = args.jpeg
    ? { w: Math.round(params.clip.width * params.clip.scale), h: Math.round(params.clip.height * params.clip.scale) }
    : pngSize(buf);
  const lines = [`snap  ${out}`,
    `size  ${dims.w}x${dims.h}px · ${(buf.length / 1024).toFixed(0)} KB · ${outDpr}x`];
  if (truncated) lines.push(`note  page is ${truncated}px tall, cut at ${params.clip.height}px (--max-height to raise)`);
  return lines.join('\n');
};

/**
 * Print to PDF. `@page`, `print` media queries and page breaks are honoured, so
 * a proposal or prototype built for print comes out paginated as designed.
 */
export const cmdPdf = async (args) => {
  const target = args._[0] ? resolveTarget(args._[0]) : null;
  const { cdp, dialogs } = await connect();
  const stopLogs = await recordLogs(cdp, { navigation: !!target });
  if (target) await navigate(cdp, target, { waitExpr: args.wait, timeout: Number(args.timeout || 20000), noWait: !!args['no-wait'] });

  const PAPER = {
    a4: [8.27, 11.69], a3: [11.69, 16.54], letter: [8.5, 11], legal: [8.5, 14], tabloid: [11, 17],
  };
  const fmt = String(args.format || 'a4').toLowerCase();
  const paper = PAPER[fmt];
  if (!paper) { cdp.close(); throw new Error(`unknown --format ${fmt} (${Object.keys(PAPER).join(', ')})`); }
  const margin = args.margin === undefined ? 0.4 : Number(args.margin);

  // The viewport emulation that screenshots depend on makes printToPDF rasterise
  // every text run into a bitmap (hundreds of /Image objects, no embedded font,
  // visibly wrong word spacing). Print has its own page box, so drop the
  // override first — this is what keeps a proposal PDF real, selectable text.
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await settle(cdp);

  const res = await cdp.send('Page.printToPDF', {
    paperWidth: paper[0],
    paperHeight: paper[1],
    landscape: !!args.landscape,
    printBackground: !args['no-background'],
    preferCSSPageSize: !!args.cssPageSize,
    scale: Number(args.scale || 1),
    marginTop: margin, marginBottom: margin, marginLeft: margin, marginRight: margin,
    displayHeaderFooter: false,
  }, { timeout: HEAVY_TIMEOUT_MS });
  const buf = Buffer.from(res.data, 'base64');
  ensureDirs();
  const out = args.o || args.out || join(SHOTS, `${shotName(args.name, 'page')}.pdf`);
  writeFileSync(out, buf);
  const logs = await stopLogs();
  cdp.close();

  // The page count lives in the PDF's own /Count, cheaper than parsing properly.
  const m = /\/Type\s*\/Pages[\s\S]{0,200}?\/Count\s+(\d+)/.exec(buf.toString('latin1'));
  return [`pdf   ${out}`,
    `size  ${(buf.length / 1024).toFixed(0)} KB · ${fmt.toUpperCase()}${args.landscape ? ' landscape' : ''}${m ? ` · ${m[1]} page(s)` : ''}`,
    ...dialogLines(dialogs), ...(logs.length ? logSummary(logs) : [])].join('\n');
};

/* -------------------------------------------------------------- interaction */

export const cmdClick = async (args) => {
  const sel = args._[0];
  if (!sel) throw new Error('usage: browsin click <selector>');
  const { cdp, dialogs } = await connect();
  const stopLogs = await recordLogs(cdp);
  const box = await findEl(cdp, sel, { nth: Number(args.nth || 0), scroll: true });
  if (box.w < 1 || box.h < 1) { cdp.close(); throw new Error(`click target has no size: ${sel}`); }

  // Real compositor input, so overlays and iframes behave like they do for a user.
  const base = { x: box.x, y: box.y, button: 'left', clickCount: Number(args.count || 1) };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });

  const waited = args.wait ? await waitNotes(cdp, args.wait, Number(args.timeout || 5000)) : (await sleep(250), []);
  await settle(cdp);
  const head = await pageHead(cdp);
  const logs = await stopLogs();
  await afterAction(cdp);
  cdp.close();
  return [`click ${sel} (${box.tag}) at ${Math.round(box.x)},${Math.round(box.y)}`, `url   ${head.url}`,
    ...waited, ...dialogLines(dialogs), ...renderLogs(logs)].join('\n');
};

export const cmdHover = async (args) => {
  const sel = args._[0];
  if (!sel) throw new Error('usage: browsin hover <selector>');
  const { cdp } = await connect();
  const box = await findEl(cdp, sel, { nth: Number(args.nth || 0), scroll: true });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await sleep(Number(args.settle || 350));
  await settle(cdp);
  await afterAction(cdp);
  cdp.close();
  return `hover ${sel} at ${Math.round(box.x)},${Math.round(box.y)}`;
};

export const cmdType = async (args) => {
  const [sel, ...rest] = args._;
  const text = rest.join(' ');
  if (!sel || !text) throw new Error('usage: browsin type <selector> <text>');
  const { cdp } = await connect();
  const stopLogs = await recordLogs(cdp);
  const focused = JSON.parse(await cdp.eval(`(() => {
    const q = window.__bq(${JSON.stringify(sel)}, ${Number(args.nth || 0)});
    if (!q.el) return JSON.stringify({ ok: false, matches: q.matches, visibleMatches: q.visibleMatches });
    q.el.scrollIntoView({ block: 'center' });
    q.el.focus();
    if (!${!!args.append} && 'value' in q.el) {
      q.el.value = '';
      q.el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return JSON.stringify({ ok: document.activeElement === q.el || q.el.contains(document.activeElement) });
  })()`));
  if (!focused.ok) {
    cdp.close();
    throw focused.matches === undefined
      ? `type could not focus: ${sel}`
      : noMatchError(sel, focused);
  }
  await cdp.send('Input.insertText', { text });
  if (args.enter) await pressKey(cdp, 'Enter');
  await settle(cdp);
  const value = await cdp.eval(`(() => {
    const el = window.__bq(${JSON.stringify(sel)}, ${Number(args.nth || 0)}).el;
    return 'value' in el ? el.value : el.textContent;
  })()`);
  const logs = await stopLogs();
  await afterAction(cdp);
  cdp.close();
  return [`type  ${sel} = ${JSON.stringify(String(value).slice(0, 200))}${args.enter ? ' + Enter' : ''}`,
    ...renderLogs(logs)].join('\n');
};

const KEYS = {
  Enter: [13, '\r'], Tab: [9, null], Escape: [27, null], Backspace: [8, null], Delete: [46, null],
  ArrowUp: [38, null], ArrowDown: [40, null], ArrowLeft: [37, null], ArrowRight: [39, null],
  Home: [36, null], End: [35, null], PageUp: [33, null], PageDown: [34, null], Space: [32, ' '],
};

const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

const pressKey = async (cdp, key, modText = '') => {
  const modifiers = String(modText || '')
    .split(/[,+]/).filter(Boolean)
    .reduce((acc, m) => acc | (MODS[m.trim().toLowerCase()] || 0), 0);
  const known = KEYS[key];
  const code = known ? known[0] : key.toUpperCase().charCodeAt(0);
  const text = known ? known[1] : key.length === 1 ? key : null;
  const common = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
  await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...common, ...(text ? { text } : {}) });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
};

export const cmdKey = async (args) => {
  const key = args._[0];
  if (!key) throw new Error(`usage: browsin key <Enter|Tab|Escape|ArrowDown|…> [--mod cmd,shift]`);
  const { cdp, dialogs } = await connect();
  const stopLogs = await recordLogs(cdp);
  if (args.on) {
    await cdp.eval(`(() => { const q = window.__bq(${JSON.stringify(args.on)}); if (q.el) q.el.focus(); })()`);
  }
  await pressKey(cdp, key, args.mod);
  const waited = args.wait ? await waitNotes(cdp, args.wait, Number(args.timeout || 5000)) : (await sleep(200), []);
  await settle(cdp);
  const head = await pageHead(cdp);
  const logs = await stopLogs();
  await afterAction(cdp);
  cdp.close();
  return [`key   ${args.mod ? args.mod + '+' : ''}${key}`, `url   ${head.url}`,
    ...waited, ...dialogLines(dialogs), ...renderLogs(logs)].join('\n');
};

export const cmdSelect = async (args) => {
  const [sel, ...rest] = args._;
  const value = rest.join(' ');
  if (!sel || !value) throw new Error('usage: browsin select <selector> <value|label>');
  const { cdp } = await connect();
  const result = await cdp.eval(`(() => {
    const el = window.__bq(${JSON.stringify(sel)}, ${Number(args.nth || 0)}).el;
    if (!el) return JSON.stringify({ ok: false, reason: 'no match' });
    if (el.tagName !== 'SELECT') return JSON.stringify({ ok: false, reason: 'not a <select>: ' + el.tagName });
    const want = ${JSON.stringify(value)}.trim().toLowerCase();
    const opt = [...el.options].find((o) =>
      o.value.toLowerCase() === want || o.textContent.trim().toLowerCase() === want);
    if (!opt) return JSON.stringify({ ok: false, reason: 'no option matches',
      options: [...el.options].map((o) => o.textContent.trim()).slice(0, 20) });
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ ok: true, value: el.value, label: opt.textContent.trim() });
  })()`).then(JSON.parse);
  await settle(cdp);
  await afterAction(cdp);
  cdp.close();
  if (!result.ok) throw new Error(`select ${sel}: ${result.reason}${result.options ? ` — options: ${result.options.join(', ')}` : ''}`);
  return `sel   ${sel} = ${JSON.stringify(result.value)} (${result.label})`;
};

export const cmdUpload = async (args) => {
  const [sel, ...files] = args._;
  if (!sel || !files.length) throw new Error('usage: browsin upload <selector> <file> [file…]');
  const paths = files.map((f) => {
    const abs = resolvePath(f);
    if (!existsSync(abs)) throw new Error(`no such file: ${f}`);
    return abs;
  });
  const { cdp } = await connect();
  const stopLogs = await recordLogs(cdp);
  await cdp.send('DOM.enable');
  const objectId = await objectIdFor(cdp, sel, Number(args.nth || 0));
  await cdp.send('DOM.setFileInputFiles', { files: paths, objectId });
  await settle(cdp);
  const logs = await stopLogs();
  await afterAction(cdp);
  cdp.close();
  return [`up    ${sel} ← ${paths.length} file(s): ${paths.map((p) => p.split('/').pop()).join(', ')}`,
    ...renderLogs(logs)].join('\n');
};

/** Mouse-path drag, for canvas surfaces where no DOM drop target exists. */
export const cmdDrag = async (args) => {
  const [from, to] = args._;
  if (!from || (!to && !args.by)) throw new Error('usage: browsin drag <fromSel> <toSel> | browsin drag <fromSel> --by dx,dy');
  const { cdp } = await connect();
  const stopLogs = await recordLogs(cdp);
  const a = await findEl(cdp, from, { nth: Number(args.nth || 0), scroll: true });
  let target;
  if (args.by) {
    const [dx, dy] = String(args.by).split(',').map(Number);
    target = { x: a.x + (dx || 0), y: a.y + (dy || 0) };
  } else {
    const b = await findEl(cdp, to);
    target = { x: b.x, y: b.y };
  }

  const steps = Number(args.steps || 12);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left', buttons: 1,
      x: a.x + ((target.x - a.x) * i) / steps,
      y: a.y + ((target.y - a.y) * i) / steps,
    });
    await sleep(12);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await sleep(200);
  await settle(cdp);
  const logs = await stopLogs();
  await afterAction(cdp);
  cdp.close();
  return [`drag  ${Math.round(a.x)},${Math.round(a.y)} → ${Math.round(target.x)},${Math.round(target.y)} in ${steps} steps`,
    ...renderLogs(logs)].join('\n');
};

export const cmdScroll = async (args) => {
  const where = args._[0];
  if (where === undefined) throw new Error('usage: browsin scroll <y|bottom|top|selector>');
  const { cdp } = await connect();
  let expr;
  if (where === 'bottom') expr = 'scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" })';
  else if (where === 'top') expr = 'scrollTo({ top: 0, behavior: "instant" })';
  else if (/^[-+]?\d+$/.test(where)) expr = `scrollTo({ top: ${Number(where)}, behavior: "instant" })`;
  else expr = `(() => { const q = window.__bq(${JSON.stringify(where)}); if (!q.el) throw new Error('no match'); q.el.scrollIntoView({ block: '${args.block || 'center'}', behavior: 'instant' }); })()`;

  await cdp.eval(expr);
  await sleep(Number(args.settle || 250));
  await settle(cdp);
  const pos = JSON.parse(await cdp.eval('JSON.stringify({ y: Math.round(scrollY), h: document.documentElement.scrollHeight })'));
  await afterAction(cdp);
  cdp.close();
  return `scrl  y=${pos.y} / ${pos.h}px`;
};

/* --------------------------------------------------------------- management */

export const cmdViewport = async (args) => {
  const spec = args._[0];
  const PRESETS = {
    desktop: '1440x900', laptop: '1280x800', wide: '1920x1080',
    iphone: '390x844', 'iphone-max': '430x932', ipad: '820x1180', mobile: '390x844',
  };
  if (!spec) {
    const vp = readState().viewport || { width: 1280, height: 800, dpr: 1 };
    return `view  ${vp.width}x${vp.height} @${vp.dpr}x${vp.mobile ? ' mobile' : ''}\npresets ${Object.keys(PRESETS).join(', ')}`;
  }
  const resolved = PRESETS[spec] || spec;
  const m = /^(\d+)x(\d+)$/.exec(resolved);
  if (!m) throw new Error(`usage: browsin viewport <width>x<height>|${Object.keys(PRESETS).join('|')} [--dpr N] [--mobile]`);
  const isPhone = /iphone|mobile|ipad/.test(spec);
  const viewport = {
    width: Number(m[1]), height: Number(m[2]),
    dpr: Number(args.dpr || (isPhone ? 2 : 1)),
    mobile: args.mobile !== undefined ? !!args.mobile : isPhone,
  };
  writeState({ viewport });
  const { cdp } = await connect();
  await afterAction(cdp);
  cdp.close();
  return `view  ${viewport.width}x${viewport.height} @${viewport.dpr}x${viewport.mobile ? ' mobile' : ''} (persisted)`;
};

export const cmdStatus = async () => {
  const s = await browserStatus();
  const doc = cmdDoctor();
  const others = listSessions().filter((x) => x.alive && x.name !== s.session).map((x) => x.name);
  const sessLine = `sess  ${s.session}${others.length ? ` · também vivas: ${others.join(', ')}` : ''}`;
  if (!s.up) return [`down  no browser running`, sessLine, doc].join('\n');
  const vp = s.viewport || { width: 1280, height: 800, dpr: 1 };
  // An adopted browser (state.json gone, browser alive) knows its pid from the
  // OS but not which binary started it — say so instead of printing `undefined`.
  const bin = s.binary
    ? `${s.binary}${s.headlessShell ? ' (headless shell — no UI layer)' : ''}`
    : 'adopted from the port — binary unknown (headless shell by default)';
  return [`up    ${s.browser} on port ${s.port} (pid ${s.pid ?? 'unknown'})`,
    sessLine,
    `bin   ${bin}`,
    `view  ${vp.width}x${vp.height} @${vp.dpr}x`,
    `prof  ${PROFILE} (cookies persist until --fresh, the idle TTL or the session cap)`,
    doc].join('\n');
};

/**
 * Which binaries browsin would actually use. Worth its own output because the
 * last-resort fallback still *works* — so a failed install looks like success
 * until you notice it is driving the user's own Chrome build.
 */
export const cmdDoctor = () => {
  const lines = [];
  let headless;
  try { headless = findBinary(); } catch (err) { return `ERR   ${err.message}`; }
  const headed = (() => { try { return findBinary({ needsWindow: true }); } catch { return null; } })();
  lines.push(`brow  ${BROWSERS}${existsSync(BROWSERS) ? '' : ' (missing)'}`);
  lines.push(`  headless  ${headless.path}${headless.shell ? '' : ' — NOT the headless shell'}`);
  lines.push(`  login     ${headed ? headed.path : 'unavailable'}`);
  if (headless.fallback || headed?.fallback) {
    lines.push(`  WARN  falling back to the user's own Chrome build. Run`);
    lines.push(`        scripts/install-browsers.sh (from the browsin checkout)`);
  }
  return lines.join('\n');
};

/**
 * Tabs, for the flows where one page is not enough: a `target=_blank` link, an
 * OAuth popup, a docs tab opened in the background. `list` shows them, `use N`
 * pins one for the next commands, `close N` drops one, `auto` unpins and goes
 * back to following the first page. The pin lives in state.json as `targetId`
 * and is read by `pageTarget`, so it survives between CLI invocations.
 */
export const cmdTabs = async (args) => {
  const [sub = 'list', value] = args._;
  const s = await browserStatus();
  if (!s.up) return 'tabs  no browser running';
  const list = await cdpHttp(s.port, '/json/list');
  const pages = list.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  const pinned = readState().targetId;
  const current = pinned && pages.some((p) => p.id === pinned) ? pinned : pages[0]?.id;

  if (sub === 'auto') { writeState({ targetId: null }); return 'tabs  auto — segue a primeira aba'; }

  if (sub !== 'list') {
    const idx = Number(value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= pages.length) {
      throw new Error(`tabs ${sub}: índice fora de 0..${Math.max(0, pages.length - 1)} — veja \`browsin tabs\``);
    }
    const target = pages[idx];
    if (sub === 'use') {
      writeState({ targetId: target.id });
      return `tabs  usando ${idx}: ${target.title || '(untitled)'} · ${target.url}\nnote  comandos seguintes ficam nesta aba; \`browsin tabs auto\` volta a seguir a primeira`;
    }
    if (sub === 'close') {
      // `/json/close/<id>` answers 200 with the plain text `Target is closing`
      // (JSON content-type, non-JSON body): parsing it as JSON turned every real
      // close into "sem confirmação". A 200 here *is* the browser's confirmation —
      // an unknown/gone id comes back as HTTP 404 and `cdpHttp` throws.
      let confirmed = false;
      try {
        const body = await cdpHttp(s.port, `/json/close/${target.id}`, { timeout: 2000, parse: 'text' });
        // Empty 200 counts too: an older/build-variant endpoint answers with no body.
        confirmed = body === '' || /closing/i.test(body);
      } catch { confirmed = false; }
      if (pinned === target.id) writeState({ targetId: null });
      return `tabs  fechou ${idx}: ${target.title || '(untitled)'}${confirmed ? '' : ' (sem confirmação do browser)'}`;
    }
    throw new Error('usage: browsin tabs [list] | tabs use <n> | tabs close <n> | tabs auto');
  }

  const lines = [`tabs  ${pages.length} aba(s)`];
  pages.forEach((p, i) => {
    lines.push(` ${String(i).padStart(2)}${p.id === current ? ' *' : '  '} ${p.title || '(untitled)'} · ${p.url}`);
  });
  if (pinned) lines.push('note  fixada com `tabs use`; `browsin tabs auto` volta a seguir a primeira');
  return lines.join('\n');
};

export const cmdDown = async (args) => {
  // A recording must never outlive its browser: drop the frames and the state.
  const wasRecording = cancelRecording();
  const recNote = wasRecording ? ' · active recording canceled (frames discarded)' : '';
  if (args.all) {
    const victims = await shutdownAll();
    if (args.fresh) rmSync(BASE, { recursive: true, force: true });
    const what = victims.length ? `stopped: ${victims.join(', ')}` : 'nothing was running';
    return `down  ${what} (all sessions)${recNote}${args.fresh ? ' · everything wiped' : ''}`;
  }
  const stopped = await shutdown();
  if (args.fresh) {
    rmSync(PROFILE, { recursive: true, force: true });
    return `down  ${stopped ? 'browser stopped' : 'nothing was running'} · profile wiped (logged out everywhere)${recNote}`;
  }
  return `down  ${stopped ? 'browser stopped' : 'nothing was running'}${recNote}`;
};

/**
 * `browsin record` — daemon-free screen recording. Frames are captured by the
 * ordinary commands themselves (afterAction); this only dispatches the subcommand.
 */
export const cmdRecord = async (args) => {
  const [sub] = args._;
  if (sub === 'start') return startRecording(args);
  if (sub === 'status') return statusRecording();
  if (sub === 'stop') return stopRecording(args);
  if (sub === 'cancel') return cancelRecording() ? 'rec   canceled — frames discarded' : 'rec   nothing to cancel';
  throw new Error('usage: browsin record <start|status|stop|cancel>');
};

/**
 * Manual run of the collector that `launch` already runs opportunistically.
 * Exists so the user can see and force it — and so a cron or routine can run
 * it without opening any browser.
 */
export const cmdGc = async () => {
  const actions = await gc({ force: true });
  const alive = listSessions().filter((s) => s.alive);
  const now = alive.map((s) => `${s.name} (pid ${s.pid}, idle ${Math.round(s.idleMin)}m)`).join(', ');
  return [
    actions.length ? actions.map((a) => `gc    ${a}`).join('\n') : 'gc    nothing to reap',
    `alive ${alive.length ? now : 'no live session'}`,
  ].join('\n');
};

/**
 * Clicks something that produces a file and waits for the bytes to land. A
 * headless browser silently drops downloads unless the behaviour is set first,
 * which is why "the button does nothing" is the usual symptom.
 */
export const cmdDownload = async (args) => {
  const sel = args._[0];
  if (!sel) throw new Error('usage: browsin download <selector> [--dir path]');
  const dir = args.dir ? resolvePath(args.dir) : DOWNLOADS;
  ensureDirs();
  const { cdp, dialogs } = await connect();
  const stopLogs = await recordLogs(cdp);

  const finished = [];
  const started = [];
  cdp.on((m) => {
    if (m.method === 'Browser.downloadWillBegin') started.push(m.params);
    else if (m.method === 'Browser.downloadProgress' && m.params.state !== 'inProgress') finished.push(m.params);
  });
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: dir, eventsEnabled: true,
  }).catch(async () => {
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
  });

  const box = await findEl(cdp, sel, { nth: Number(args.nth || 0), scroll: true });
  const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });

  const deadline = Date.now() + Number(args.timeout || 15000);
  while (Date.now() < deadline && !finished.length) await sleep(150);
  const logs = await stopLogs();
  cdp.close();

  if (!finished.length) {
    const hint = started.length
      ? `download started (${started[0].suggestedFilename}) but never completed`
      : 'the click produced no download — is it really a download control?';
    throw new Error(`${sel}: ${hint}`);
  }
  const done = finished[0];
  const name = started.find((s) => s.guid === done.guid)?.suggestedFilename;
  const path = name ? join(dir, name) : join(dir, done.guid);
  const size = existsSync(path) ? `${(statSync(path).size / 1024).toFixed(0)} KB` : 'file not found on disk';
  return [`down  ${path}`, `size  ${size} · ${done.state}`,
    ...dialogLines(dialogs), ...renderLogs(logs)].join('\n');
};

/**
 * The one thing a headless browser cannot do for itself: authenticate as the
 * user. Opens a *visible* Chromium on browsin's own throwaway profile so the
 * person can sign in by hand; the cookies then live in that profile and every
 * later headless command inherits them. The user's real Chrome, and every
 * account already signed in there, stays untouched.
 */
export const cmdLogin = async (args) => {
  const url = args._[0] ? resolveTarget(args._[0]) : null;
  const note = args.note ? String(args.note) : null;
  const state = readState();
  if (!state.headed) await shutdown();
  await launch({ headed: true });
  const { cdp } = await connect({ headed: true });
  // With --note the visible window opens on a plain interstitial explaining to
  // the human why it just appeared; "Continue" then takes the tab to the URL.
  const start = note
    ? `data:text/html;charset=utf-8,${encodeURIComponent(buildLoginNoteHtml(note, url))}`
    : url;
  if (start) await navigate(cdp, start, { timeout: Number(args.timeout || 30000) }).catch(() => {});
  await cdp.send('Page.bringToFront').catch(() => {});
  const shown = bringToFront(readState().pid);
  const head = await pageHead(cdp);
  await afterAction(cdp);
  cdp.close();
  const where = head.url.startsWith('data:') ? `interstitial → ${url || '(no url)'}` : head.url;
  return [
    `login window open (headed chromium) — ${where}`,
    ...(shown || process.platform !== 'darwin' ? [] : ['warn  could not bring the window to front — tell the user to look for "Google Chrome for Testing" in the Dock']),
    ...(note ? [`note  interstitial shown first: "${note}" — the user reads the why before the site loads`] : []),
    ...loginGuideLines({ ttlMin: TTL_MIN, maxSessions: MAX_SESSIONS }),
  ].join('\n');
};
