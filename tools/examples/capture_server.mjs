// capture_server.mjs — tiny local sink for tutorial screenshots.
// The running portico page (served on :8767) POSTs a canvas PNG data-URL here and
// this writes it to docs/tutorials/img/<name>.png. Keeps the (large) base64 out of the
// agent's context — the browser talks to disk directly.
//   node tools/examples/capture_server.mjs        # listens on :8768
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 8768;
const OUT = 'docs/tutorials/img';
fs.mkdirSync(OUT, { recursive: true });

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405).end('POST only'); return; }
  const name = decodeURIComponent((req.url.match(/[?&]name=([^&]+)/) || [])[1] || '');
  if (!/^[\w.-]+$/.test(name)) { res.writeHead(400).end('bad name'); return; }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const b64 = body.replace(/^data:image\/png;base64,/, '');
    const file = path.join(OUT, name.endsWith('.png') ? name : name + '.png');
    try {
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      console.log('✓ %s  (%d KB)', file, Math.round(fs.statSync(file).size / 1024));
      res.writeHead(200).end('ok');
    } catch (e) { console.error('✗', name, e.message); res.writeHead(500).end(e.message); }
  });
}).listen(PORT, () => console.log('capture sink on http://localhost:%d → %s/', PORT, OUT));
