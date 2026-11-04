#!/usr/bin/env node
/**
 * Resilience tests for the CDP boundary, with no browser involved: a couple of
 * throwaway `127.0.0.1` servers stand in for the wedged browser. They cover the
 * failures that used to be silent hangs —
 *
 *  - `send` had no deadline: a renderer stuck in a page script parked the
 *    command forever, and with it the session lock (only released on exit);
 *  - a browser that died mid-command closed the socket and left every pending
 *    `send` unresolved;
 *  - the control endpoint (`/json/list`, `/json/new`, `/json/close`) was fetched
 *    without a signal, so a port that accepted and never answered hung too, and
 *    `/json/close` (200 `Target is closing`, not JSON) looked like a failure;
 *  - an event wait (`once`) stayed pending after the socket died, so `await loaded`
 *    learned about the dead browser only at its own flow timeout.
 *
 * Each case asserts both the error and the *time*, because "rejects" after a
 * 60s default would still be a hang in practice. Run: node test/resilience.mjs
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { CDP, cdpHttp } from '../src/cdp.mjs';

let pass = 0;
const failed = [];

const test = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed.push(name);
    console.log(`  FAIL ${name}\n       ${String(err.message).split('\n')[0]}`);
  }
};

/** Accepts the WebSocket handshake by hand — zero deps, and no framing needed. */
const acceptWs = (req, socket) => {
  const accept = createHash('sha1')
    .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
};

const startServer = ({ onRequest = (req, res) => res.end('{}'), onUpgrade } = {}) => new Promise((resolve) => {
  const sockets = new Set();
  const server = createServer(onRequest);
  if (onUpgrade) server.on('upgrade', (req, socket) => { sockets.add(socket); onUpgrade(req, socket); });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    url: `ws://127.0.0.1:${server.address().port}/devtools/page/fixture`,
    close() { for (const s of sockets) s.destroy(); server.close(); },
  }));
});

/** A server-side text frame; unmasked, which is what the client expects back. */
const wsTextFrame = (text) => {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const head = Buffer.alloc(4);
  head[0] = 0x81; head[1] = 126; head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
};

/** Reads one masked client frame (the request) out of a raw socket buffer. */
const readClientFrame = (buf) => {
  if (buf.length < 2) return null;
  const short = buf[1] & 0x7f;
  let off = 2;
  let len = short;
  if (short === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (short === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  if (buf.length < off + 4 + len) return null;
  const mask = buf.subarray(off, off + 4);
  const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
  return { text: data.toString('utf8'), bytes: off + 4 + len };
};

/** Milliseconds a rejection took — a deadline that fires late is still a hang. */
const elapsed = async (fn) => {
  const t0 = Date.now();
  await fn();
  return Date.now() - t0;
};

// A rejection nobody handles is the other half of 'pending forever': it kills
// the process of whoever embeds this client. Any leak here fails the run.
const unhandled = [];
process.on('unhandledRejection', (err) => { unhandled.push(err); });

console.log('— resiliência da fronteira CDP —');

await test('send sem resposta falha no deadline configurado', async () => {
  const srv = await startServer({ onUpgrade: acceptWs });
  const cdp = await CDP.attach(srv.url, { sendTimeout: 300 });
  try {
    const ms = await elapsed(() => assert.rejects(
      cdp.send('Runtime.evaluate', { expression: '1' }),
      /CDP Runtime\.evaluate timed out after 300ms/,
    ));
    assert.ok(ms < 3000, `levou ${ms}ms`);
    // The socket survives a timed-out command: a late/missing reply must not
    // poison the connection, and a per-call deadline overrides the instance one.
    const ms2 = await elapsed(() => assert.rejects(
      cdp.send('Page.enable', {}, { timeout: 150 }),
      /CDP Page\.enable timed out after 150ms/,
    ));
    assert.ok(ms2 < 3000, `levou ${ms2}ms`);
  } finally { cdp.close(); srv.close(); }
});

await test('browser morre no meio: pendente rejeita, não fica pendurado', async () => {
  const srv = await startServer({
    onUpgrade: (req, socket) => {
      acceptWs(req, socket);
      // First frame arrives, then the "browser" dies.
      socket.once('data', () => socket.destroy());
    },
  });
  // Deadline deliberately huge: only the close can settle this.
  const cdp = await CDP.attach(srv.url, { sendTimeout: 60_000 });
  try {
    const ms = await elapsed(() => assert.rejects(
      cdp.send('Page.navigate', { url: 'about:blank' }),
      /CDP socket closed before Page\.navigate answered|CDP socket error before Page\.navigate answered/,
    ));
    assert.ok(ms < 3000, `levou ${ms}ms`);
  } finally { cdp.close(); srv.close(); }
});

await test('send depois de close rejeita na hora', async () => {
  const srv = await startServer({ onUpgrade: acceptWs });
  const cdp = await CDP.attach(srv.url, { sendTimeout: 60_000 });
  cdp.close();
  const ms = await elapsed(() => assert.rejects(
    cdp.send('Page.enable'),
    /CDP connection closed before Page\.enable/,
  ));
  assert.ok(ms < 500, `levou ${ms}ms`);
  srv.close();
});

await test('attach não espera o timeout quando o socket fecha sem abrir', async () => {
  const srv = await startServer({ onUpgrade: (req, socket) => socket.destroy() });
  try {
    const ms = await elapsed(() => assert.rejects(
      CDP.attach(srv.url, { timeout: 5000 }),
      /CDP socket closed before opening|cannot reach/,
    ));
    assert.ok(ms < 3000, `levou ${ms}ms`);
  } finally { srv.close(); }
});

await test('attach respeita o deadline do handshake', async () => {
  // Accepts the connection and never answers the upgrade: the wedged-browser shape.
  const srv = await startServer({ onUpgrade: () => {} });
  try {
    const ms = await elapsed(() => assert.rejects(
      CDP.attach(srv.url, { timeout: 300 }),
      /CDP connect timed out after 300ms/,
    ));
    assert.ok(ms < 3000, `levou ${ms}ms`);
  } finally { srv.close(); }
});

await test('cdpHttp: resposta normal passa, /json/list mudo falha no deadline', async () => {
  const srv = await startServer({
    onRequest: (req, res) => {
      if (req.url === '/json/version') { res.setHeader('content-type', 'application/json'); res.end('{"Browser":"fixture"}'); return; }
      if (req.url === '/json/boom') { res.statusCode = 500; res.end('nope'); return; }
      // Anything else (e.g. /json/list) accepts and never answers.
    },
  });
  try {
    assert.deepEqual(await cdpHttp(srv.port, '/json/version', { timeout: 700 }), { Browser: 'fixture' });
    const ms = await elapsed(() => assert.rejects(
      cdpHttp(srv.port, '/json/list', { timeout: 300 }),
      /CDP \/json\/list timed out after 300ms/,
    ));
    assert.ok(ms < 3000, `levou ${ms}ms`);
    await assert.rejects(cdpHttp(srv.port, '/json/boom', { timeout: 700 }), /CDP \/json\/boom returned HTTP 500/);
  } finally { srv.close(); }
});

await test("once rejeita quando o socket fecha (não fica pendente)", async () => {
  const srv = await startServer({ onUpgrade: acceptWs });
  const cdp = await CDP.attach(srv.url, { sendTimeout: 60_000 });
  try {
    // Sem isso, `await loaded` de um reload com browser morto esperava o timeout
    // de fluxo para descobrir o que o close já sabia.
    const waited = cdp.once('Page.loadEventFired', { timeout: 60_000 });
    const ms = await elapsed(async () => {
      const t0 = Date.now();
      cdp.close();
      await assert.rejects(waited, /CDP connection closed before Page\.loadEventFired arrived/);
      assert.ok(Date.now() - t0 < 500, 'close não settleou o evento na hora');
    });
    assert.ok(ms < 2000, `levou ${ms}ms`);
  } finally { cdp.close(); srv.close(); }
});

await test('once pendente + socket morto: chamador com .catch não gera unhandled', async () => {
  const srv = await startServer({
    onUpgrade: (req, socket) => {
      acceptWs(req, socket);
      socket.once('data', () => socket.destroy());
    },
  });
  const cdp = await CDP.attach(srv.url, { sendTimeout: 60_000 });
  try {
    // A forma exata dos chamadores de `navigate`/`reload` em commands.mjs:
    // o evento nasce com .catch antes do send que pode falhar.
    const loaded = cdp.once('Page.loadEventFired', { timeout: 60_000 }).catch(() => null);
    await assert.rejects(
      cdp.send('Page.navigate', { url: 'about:blank' }),
      /socket closed before Page\.navigate answered|socket error before Page\.navigate answered/,
    );
    assert.equal(await loaded, null);
  } finally { cdp.close(); srv.close(); }
});

await test('deadline desligado (0): nenhum timer, e o close ainda settleia', async () => {
  const srv = await startServer({ onUpgrade: acceptWs }); // nunca responde
  const cdp = await CDP.attach(srv.url, { sendTimeout: 0 });
  try {
    let outcome = 'pending';
    const p = cdp.send('Page.enable').then(
      () => { outcome = 'resolved'; },
      (err) => { outcome = `rejected: ${err.message}`; },
    );
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(outcome, 'pending', `BROWSIN_CDP_TIMEOUT_MS=0 devia esperar, veio: ${outcome}`);
    cdp.close();
    await p;
    assert.match(outcome, /^rejected: CDP connection closed before Page\.enable/);
  } finally { srv.close(); }
});

await test('cdpHttp: 200 com texto puro (/json/close) é sucesso, 404 não é', async () => {
  // Chrome responde `/json/close/<id>` com `Target is closing` e content-type JSON:
  // parsear como JSON transformava todo close que funcionou em "sem confirmação".
  const srv = await startServer({
    onRequest: (req, res) => {
      res.setHeader('content-type', 'application/json; charset=UTF-8');
      if (req.url === '/json/close/OK') { res.end('Target is closing'); return; }
      if (req.url === '/json/close/GONE') { res.statusCode = 404; res.end('No such target id: GONE'); return; }
      res.statusCode = 500; res.end('nope');
    },
  });
  try {
    await assert.rejects(cdpHttp(srv.port, '/json/close/OK', { timeout: 700 }), /returned no JSON/);
    assert.equal(
      await cdpHttp(srv.port, '/json/close/OK', { timeout: 700, parse: 'text' }),
      'Target is closing',
    );
    await assert.rejects(
      cdpHttp(srv.port, '/json/close/GONE', { timeout: 700, parse: 'text' }),
      /CDP \/json\/close\/GONE returned HTTP 404/,
    );
  } finally { srv.close(); }
});

if (unhandled.length) {
  for (const err of unhandled) console.log(`  FAIL unhandledRejection: ${String(err?.message || err)}`);
  failed.push('unhandledRejection');
}

console.log(`\nRESULTADO: ${pass} ok, ${failed.length} falhas`);
if (failed.length) console.log(`falharam: ${failed.join(', ')}`);
process.exit(failed.length ? 1 : 0);
