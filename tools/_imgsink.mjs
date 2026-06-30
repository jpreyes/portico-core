// Sink HTTP efímero: recibe un dataURL PNG por POST y lo escribe al repo.
// Uso interno para capturar el viewport de Pórtico a un archivo (verificaciones).
//   node tools/_imgsink.mjs   → escucha en :8799, POST /?name=ruta.png  body=dataURL
import http from 'http';
import fs from 'fs';
import path from 'path';
const PORT = 8799;
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return res.end('imgsink ok');
  const name = new URL(req.url, 'http://x').searchParams.get('name') || 'out.png';
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    try {
      const b64 = body.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      fs.mkdirSync(path.dirname(name), { recursive: true });
      fs.writeFileSync(name, buf);
      res.end('saved ' + name + ' ' + buf.length + ' bytes');
      console.log('saved', name, buf.length);
    } catch (e) { res.statusCode = 500; res.end('err ' + e.message); }
  });
}).listen(PORT, () => console.log('imgsink on ' + PORT));
