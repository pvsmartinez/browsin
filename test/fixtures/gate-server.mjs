/**
 * HTTP fixture for the `check --fail-on` (QA gate) cases: real status codes,
 * late API failures, aborted and never-ending requests — none of which a
 * file:// page can produce. Listens on an ephemeral port on 127.0.0.1 and
 * prints it as the first line of stdout. Runs until signaled.
 *
 * Every page mounts like a SPA: #root is empty until a timer fills it, so the
 * gate's --wait condition (`#root` has children) is the React mount.
 */
import { createServer } from 'node:http';

const page = (title, afterMount = '', head = '') => `<!doctype html><meta charset=utf-8><title>${title}</title>${head}
<div id=root></div>
<script>
  setTimeout(() => {
    document.getElementById('root').innerHTML = '<p>montou ${title}</p>';
    ${afterMount}
  }, 150);
</script>`;

const PAGES = {
  '/clean': page('clean', "fetch('/api/ok');"),
  // The API answers 500 after 1.2 s, after the mount: only a settle window that
  // waits for in-flight requests sees it, and the render that throws on it.
  '/late': page('late', `fetch('/api/slow500').then((r) => {
    if (!r.ok) { console.error('api falhou ' + r.status); setTimeout(() => { throw new Error('late boom'); }); }
  });`),
  '/noise': page('noise', '', '<img src="/noise.png">'),
  '/abort': page('abort', `const c = new AbortController();
    fetch('/api/slowok', { signal: c.signal }).catch(() => {}); c.abort();`),
  // Port 1 is on Chrome's unsafe list: the request fails in the network layer, no status.
  '/netfail': page('netfail', "fetch('http://127.0.0.1:1/recusado').catch(() => {});"),
  '/stream': page('stream', "fetch('/api/stream');"),
  // Logs and throws, then replaces itself before the mount: the errors belong
  // to a document that is gone by the time anyone could drain it.
  '/redirect': `<!doctype html><meta charset=utf-8><title>redirect</title><script>
    console.error('erro antes do redirect');
    setTimeout(() => { throw new Error('boom antes do redirect'); });
    setTimeout(() => location.replace('/clean'), 30);
  </script>`,
  // A rejection handled late is revoked: not an error.
  '/handled': page('handled', `const p = Promise.reject(new Error('tratada depois'));
    setTimeout(() => p.catch(() => {}), 50);`),
  // 404 headers arrive, then the page aborts the body: the server did answer 404.
  '/abort404': page('abort404', `const c = new AbortController();
    fetch('/api/slowbody404', { signal: c.signal }).then(() => c.abort()).catch(() => {});`),
  // The previous route: logs an error every 20 ms, forever.
  '/noisy': page('noisy', "setInterval(() => console.error('rota anterior'), 20);"),
  // The previous route: reloads an iframe that 404s, every 20 ms.
  '/iframeloop': page('iframeloop', `const f = document.createElement('iframe');
    document.body.appendChild(f);
    setInterval(() => { f.src = '/sumiu?' + Math.random(); }, 20);`),
  '/nomount': '<!doctype html><meta charset=utf-8><title>nomount</title><div id=root></div>',
};

const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (PAGES[path]) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGES[path]); return; }
  if (path === '/doc500') { res.writeHead(500, { 'content-type': 'text/html' }); res.end('<title>doc500</title>quebrou'); return; }
  if (path === '/api/ok') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (path === '/api/slow500') {
    setTimeout(() => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); }, 1200);
    return;
  }
  if (path === '/api/slowok') {
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }, 800);
    return;
  }
  if (path === '/api/slowbody404') {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.write('x');
    setTimeout(() => res.end('y'), 1000);
    return;
  }
  // The next document answers slowly, so the previous one keeps running meanwhile.
  if (path === '/slowdoc') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGES['/clean']); }, 300); return; }
  // Headers now, body never: a request that stays in flight.
  if (path === '/api/stream') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('a'); return; }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(0, '127.0.0.1', () => {
  console.log(server.address().port);
});
