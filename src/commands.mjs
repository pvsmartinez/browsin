import { existsSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { connect, launch, shutdown, shutdownAll, status as browserStatus } from './browser.mjs';
import { SNAPSHOT } from './query.mjs';
import { gc, listSessions } from './gc.mjs';
import { afterAction, cancelRecording, startRecording, statusRecording, stopRecording } from './recording.mjs';
import { readState, writeState, findBinary, SHOTS, DOWNLOADS, PROFILE, BROWSERS, BASE, SESSION, ensureDirs } from './paths.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ helpers */

export const resolveTarget = (input) => {
  if (!input) return null;
  if (/^(https?|file|data|about|chrome):/.test(input)) return input;
  const asPath = resolvePath(input);
  if (existsSync(asPath)) return `file://${asPath}`;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/.test(input)) return `http://${input}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(input)) return `http://${input}`;
  // A path-shaped argument that does not exist is a typo or a wrong cwd, never
  // a hostname. Guessing https:// there turns it into a confusing DNS error.
  if (/^[.~/]/.test(input) || /\/.*\.(html?|pdf|svg|md|txt|json)$/i.test(input)) {
    throw new Error(`no such file: ${input} (cwd ${process.cwd()})`);
  }
  return `https://${input}`;
};

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
  if (!box.found) throw new Error(`no match for ${sel} (${box.matches} in DOM, ${box.visibleMatches} visible)`);
  return box;
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
  const events = [];
  await cdp.send('Network.enable', { maxTotalBufferSize: 1_000_000 });
  const off = cdp.on((m) => {
    if (m.method === 'Network.responseReceived') {
      const { response, type } = m.params;
      events.push({ status: response.status, type, url: response.url, fromCache: response.fromDiskCache });
    } else if (m.method === 'Network.loadingFailed') {
      events.push({ status: 0, type: m.params.type, url: null, error: m.params.errorText });
    }
  });
  return () => { off(); return events; };
};

const renderNetwork = (events, { all = false } = {}) => {
  const bad = events.filter((e) => e.status === 0 || e.status >= 400);
  if (!all) {
    if (!bad.length) return [`net   ${events.length} request(s), all ok`];
    return [`net   ${bad.length} of ${events.length} request(s) failed:`,
      ...bad.map((e) => `  [${e.status || e.error}] ${e.type} ${e.url || ''}`.trimEnd())];
  }
  return [`net   ${events.length} request(s):`,
    ...events.map((e) => `  [${e.status || e.error}] ${e.type} ${e.url || ''}`.trimEnd())];
};

const navigate = async (cdp, url, { waitExpr, timeout = 15000 } = {}) => {
  const notes = [];
  const loaded = cdp.once('Page.loadEventFired', { timeout }).catch(() => null);
  const nav = await cdp.send('Page.navigate', { url });
  if (nav.errorText) throw new Error(`${url} — ${nav.errorText}`);
  if ((await loaded) === null) notes.push('load event never fired (timeout)');
  await waitForExpression(cdp, 'document.readyState === "complete"', 3000);
  if (waitExpr && !(await waitForExpression(cdp, waitExpr, timeout))) {
    notes.push(`--wait never became true: ${waitExpr}`);
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
  const stopNet = await recordNetwork(cdp);
  const notes = await navigate(cdp, url, { waitExpr: args.wait, timeout: Number(args.timeout || 15000) });
  const head = await pageHead(cdp);
  const logs = await drainLogs(cdp);
  const net = stopNet();
  await afterAction(cdp);
  cdp.close();

  return [`open  ${head.url}`, `title ${head.title || '(untitled)'}`,
    `view  ${viewport.width}x${viewport.height} @${viewport.dpr}x`,
    ...notes.map((n) => `note  ${n}`), ...dialogLines(dialogs),
    ...renderNetwork(net, { all: !!args.net }), ...logSummary(logs)].join('\n');
};

/** One call that answers "is the page fine?" — navigate, problems, pixels. */
export const cmdCheck = async (args) => {
  const url = resolveTarget(args._[0]);
  if (!url) throw new Error('usage: browsin check <url|file>');
  const { cdp, viewport, dialogs } = await connect();
  const stopNet = await recordNetwork(cdp);
  const notes = await navigate(cdp, url, { waitExpr: args.wait, timeout: Number(args.timeout || 15000) });
  const head = await pageHead(cdp);
  const logs = await drainLogs(cdp);
  const net = stopNet();
  const stats = JSON.parse(await cdp.eval(`JSON.stringify({
    nodes: document.querySelectorAll('*').length,
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    scrollHeight: document.documentElement.scrollHeight,
    emptyBody: document.body ? document.body.innerText.trim().length === 0 : true
  })`));
  await afterAction(cdp);
  cdp.close();

  const out = [`check ${head.url}`, `title ${head.title || '(untitled)'}`,
    `view  ${viewport.width}x${viewport.height} @${viewport.dpr}x · ${stats.nodes} nodes · page ${stats.scrollHeight}px tall`,
    ...notes.map((n) => `note  ${n}`), ...dialogLines(dialogs)];
  if (stats.emptyBody) out.push('warn  body renders no text — app may not have mounted');
  if (stats.overflowX) out.push('warn  horizontal overflow at this viewport');
  out.push(...renderNetwork(net, { all: !!args.net }), ...logSummary(logs));

  if (!args['no-snap']) {
    out.push('', await cmdSnap({ _: [], clip: args.clip, full: args.full, name: args.name || 'check', dpr: args.dpr }));
  }
  return out.join('\n');
};

export const cmdReload = async (args) => {
  const { cdp, dialogs } = await connect();
  const stopNet = await recordNetwork(cdp);
  const loaded = cdp.once('Page.loadEventFired', { timeout: Number(args.timeout || 15000) }).catch(() => null);
  await cdp.send('Page.reload', { ignoreCache: !!args.hard });
  await loaded;
  await waitForExpression(cdp, 'document.readyState === "complete"', 3000);
  if (args.wait) await waitForExpression(cdp, args.wait, Number(args.timeout || 15000));
  await settle(cdp);
  const head = await pageHead(cdp);
  const logs = await drainLogs(cdp);
  const net = stopNet();
  await afterAction(cdp);
  cdp.close();
  return [`reload ${head.url}${args.hard ? ' (cache bypassed)' : ''}`, ...dialogLines(dialogs),
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

export const cmdJs = async (args) => {
  const expr = args._.join(' ');
  if (!expr) throw new Error("usage: browsin js '<expression>'");
  const { cdp } = await connect();
  const value = await cdp.eval(expr);
  const logs = await drainLogs(cdp);
  await afterAction(cdp);
  cdp.close();
  const out = [typeof value === 'string' ? value : JSON.stringify(value, null, 2)];
  if (logs.length) out.push('--- logs ---', ...renderLogs(logs, { all: true }));
  return out.join('\n');
};

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
  if (url) await navigate(cdp, url, { waitExpr: args.wait, timeout: Number(args.timeout || 15000) });
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
  const params = { format: args.jpeg ? 'jpeg' : 'png', captureBeyondViewport: true };
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

  const shot = await cdp.send('Page.captureScreenshot', params);
  const buf = Buffer.from(shot.data, 'base64');
  ensureDirs();
  const ext = args.jpeg ? 'jpg' : 'png';
  const out = args.o || args.out || join(SHOTS, `${args.name || 'shot'}.${ext}`);
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
  if (target) await navigate(cdp, target, { waitExpr: args.wait, timeout: Number(args.timeout || 20000) });

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
  });
  const buf = Buffer.from(res.data, 'base64');
  ensureDirs();
  const out = args.o || args.out || join(SHOTS, `${args.name || 'page'}.pdf`);
  writeFileSync(out, buf);
  const logs = await drainLogs(cdp);
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
  const box = await findEl(cdp, sel, { nth: Number(args.nth || 0), scroll: true });
  if (box.w < 1 || box.h < 1) { cdp.close(); throw new Error(`click target has no size: ${sel}`); }

  // Real compositor input, so overlays and iframes behave like they do for a user.
  const base = { x: box.x, y: box.y, button: 'left', clickCount: Number(args.count || 1) };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });

  if (args.wait) await waitForExpression(cdp, args.wait, Number(args.timeout || 5000));
  else await sleep(250);
  await settle(cdp);
  const head = await pageHead(cdp);
  const logs = await drainLogs(cdp);
  await afterAction(cdp);
  cdp.close();
  return [`click ${sel} (${box.tag}) at ${Math.round(box.x)},${Math.round(box.y)}`, `url   ${head.url}`,
    ...dialogLines(dialogs), ...renderLogs(logs)].join('\n');
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
  const focused = await cdp.eval(`(() => {
    const q = window.__bq(${JSON.stringify(sel)}, ${Number(args.nth || 0)});
    if (!q.el) return false;
    q.el.scrollIntoView({ block: 'center' });
    q.el.focus();
    if (!${!!args.append} && 'value' in q.el) {
      q.el.value = '';
      q.el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return document.activeElement === q.el || q.el.contains(document.activeElement);
  })()`);
  if (!focused) { cdp.close(); throw new Error(`type could not focus: ${sel}`); }
  await cdp.send('Input.insertText', { text });
  if (args.enter) await pressKey(cdp, 'Enter');
  await settle(cdp);
  const value = await cdp.eval(`(() => {
    const el = window.__bq(${JSON.stringify(sel)}, ${Number(args.nth || 0)}).el;
    return 'value' in el ? el.value : el.textContent;
  })()`);
  const logs = await drainLogs(cdp);
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
  if (args.on) {
    await cdp.eval(`(() => { const q = window.__bq(${JSON.stringify(args.on)}); if (q.el) q.el.focus(); })()`);
  }
  await pressKey(cdp, key, args.mod);
  if (args.wait) await waitForExpression(cdp, args.wait, Number(args.timeout || 5000));
  else await sleep(200);
  await settle(cdp);
  const head = await pageHead(cdp);
  const logs = await drainLogs(cdp);
  await afterAction(cdp);
  cdp.close();
  return [`key   ${args.mod ? args.mod + '+' : ''}${key}`, `url   ${head.url}`,
    ...dialogLines(dialogs), ...renderLogs(logs)].join('\n');
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
  await cdp.send('DOM.enable');
  const objectId = await objectIdFor(cdp, sel, Number(args.nth || 0));
  await cdp.send('DOM.setFileInputFiles', { files: paths, objectId });
  await settle(cdp);
  const logs = await drainLogs(cdp);
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
  const logs = await drainLogs(cdp);
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
    `prof  ${PROFILE} (cookies persist here until --fresh)`,
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
  const logs = await drainLogs(cdp);
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
  const state = readState();
  if (!state.headed) await shutdown();
  await launch({ headed: true });
  const { cdp } = await connect({ headed: true });
  if (url) await navigate(cdp, url, { timeout: Number(args.timeout || 30000) }).catch(() => {});
  const head = await pageHead(cdp);
  await afterAction(cdp);
  cdp.close();
  return [
    `login window open (headed chromium) — ${head.url}`,
    'The USER signs in by hand in that visible window. Never type credentials via headless',
    'commands, never ask for them in chat — just tell the user why the window is open and',
    'WAIT until they confirm. You cannot see a headed window; do not guess they are done.',
    'Closing the window does NOT log out: cookies live on disk in browsin\'s profile, not in',
    'the window. Your next headless command relaunches on the same profile, already',
    'authenticated — the task continues exactly where it stopped.',
    'Cookies survive until `browsin down --fresh` (plain `down`, `gc` and idle TTL keep them).',
  ].join('\n');
};
