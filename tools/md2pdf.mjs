// md2pdf.mjs — convierte un Markdown a PDF distribuible usando Chrome/Edge headless.
//   node tools/md2pdf.mjs entrada.md [--out salida.pdf] [--logos a.svg,b.svg,c.svg]
//                                    [--membrete "Texto del proyecto"]
//
// MD→HTML mínimo (encabezados, tablas, listas, **negrita**, `código`, enlaces,
// imágenes incrustadas como data-URI) → HTML temporal con CSS de impresión A4 →
// `chrome --headless --print-to-pdf`. Sin dependencias externas. Con --logos
// agrega un membrete del proyecto (logos + texto) al inicio de la primera página.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import os from 'os';

// ── argumentos (posicional + flags) ──────────────────────────────────────────
const argv = process.argv.slice(2);
const mdPath = argv.find(a => !a.startsWith('--'));
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
if (!mdPath) { console.error('uso: node tools/md2pdf.mjs entrada.md [--out s.pdf] [--logos a,b,c] [--membrete "..."]'); process.exit(1); }
const outPdf = flag('--out') || mdPath.replace(/\.md$/i, '.pdf');
const logos = (flag('--logos') || '').split(',').map(s => s.trim()).filter(Boolean);
const membrete = flag('--membrete') || 'PÓRTICO — Análisis estructural 3D';
const baseDir = path.dirname(path.resolve(mdPath));
const md = fs.readFileSync(mdPath, 'utf8');

// imagen de archivo → data-URI (con MIME correcto para SVG)
function imgDataURI(p) {
  const ext = path.extname(p).slice(1).toLowerCase() || 'png';
  const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
}

// ── inline: negrita, código, imágenes, enlaces ───────────────────────────────
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s) {
  // imagen ![alt](src) → data-URI incrustado
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    try { return `<img alt="${esc(alt)}" src="${imgDataURI(path.resolve(baseDir, src.trim()))}">`; }
    catch { return `[imagen no encontrada: ${esc(src)}]`; }
  });
  let out = '', i = 0;
  // separa los <img ...> ya generados del resto para escapar sólo el texto
  for (const part of s.split(/(<img[^>]*>)/g)) {
    if (part.startsWith('<img')) { out += part; continue; }
    let t = esc(part);
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, url) => `<a href="${url}">${txt}</a>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    out += t;
  }
  return out;
}

// ── bloque: line-by-line con agrupación de tablas y listas ───────────────────
const lines = md.split(/\r?\n/);
let html = '', i = 0;
const isTableRow = l => /^\s*\|.*\|\s*$/.test(l);
while (i < lines.length) {
  const l = lines[i];
  if (/^\s*$/.test(l)) { i++; continue; }
  if (/^#{1,6}\s/.test(l)) { const lvl = l.match(/^#+/)[0].length; html += `<h${lvl}>${inline(l.replace(/^#+\s/, ''))}</h${lvl}>\n`; i++; continue; }
  if (/^\s*---+\s*$/.test(l)) { html += '<hr>\n'; i++; continue; }
  if (/^\s*>\s?/.test(l)) { html += `<blockquote>${inline(l.replace(/^\s*>\s?/, ''))}</blockquote>\n`; i++; continue; }
  if (isTableRow(l)) {
    const block = []; while (i < lines.length && isTableRow(lines[i])) block.push(lines[i++]);
    const rows = block.map(r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
    const sep = rows[1] && rows[1].every(c => /^:?-{1,}:?$/.test(c));
    html += '<table>\n';
    rows.forEach((cells, ri) => {
      if (sep && ri === 1) return;
      const tag = (ri === 0 && sep) ? 'th' : 'td';
      html += '<tr>' + cells.map(c => `<${tag}>${inline(c)}</${tag}>`).join('') + '</tr>\n';
    });
    html += '</table>\n';
    continue;
  }
  if (/^\s*[-*]\s/.test(l)) {
    html += '<ul>\n'; while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) { html += `<li>${inline(lines[i].replace(/^\s*[-*]\s/, ''))}</li>\n`; i++; } html += '</ul>\n';
    continue;
  }
  // párrafo (junta líneas hasta el próximo vacío/bloque)
  const para = []; while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^#{1,6}\s|^\s*---+\s*$|^\s*>|^\s*[-*]\s/.test(lines[i]) && !isTableRow(lines[i])) para.push(lines[i++]);
  html += `<p>${inline(para.join(' '))}</p>\n`;
}

// Membrete del proyecto (logos opcionales + texto) — sólo si se pasaron logos.
let letterhead = '';
if (logos.length) {
  const imgs = logos.filter(p => fs.existsSync(path.resolve(p)))
    .map(p => `<img alt="logo" src="${imgDataURI(path.resolve(p))}">`).join('');
  letterhead = `<div class="membrete">${imgs}<div class="lh-txt">${esc(membrete)}</div></div>`;
}

const doc = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><style>
@page { size: A4; margin: 18mm 16mm; }
:root { color-scheme: light; }
html, body { background: #ffffff; }
body { font: 11pt/1.5 "Segoe UI", Arial, sans-serif; color: #1a1a1a; }
h1 { font-size: 19pt; border-bottom: 2px solid #2563eb; padding-bottom: 4px; color: #1e3a8a; }
h2 { font-size: 14pt; color: #1e3a8a; margin-top: 18px; }
h3 { font-size: 12pt; color: #334155; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 10pt; }
th, td { border: 1px solid #cbd5e1; padding: 5px 8px; text-align: left; }
th { background: #eff6ff; }
tr:nth-child(even) td { background: #f8fafc; }
img { max-width: 100%; display: block; margin: 10px auto; border: 1px solid #e2e8f0; border-radius: 4px; }
blockquote { border-left: 3px solid #94a3b8; margin: 8px 0; padding: 2px 12px; color: #475569; background: #f8fafc; font-size: 10pt; }
code { background: #f1f5f9; padding: 1px 4px; border-radius: 3px; font-family: Consolas, monospace; font-size: 9.5pt; }
hr { border: none; border-top: 1px solid #e2e8f0; margin: 14px 0; }
a { color: #2563eb; text-decoration: none; }
strong { color: #0f172a; }
.membrete { display: flex; align-items: center; justify-content: center; gap: 22px; padding-bottom: 8px; border-bottom: 2px solid #1e3a8a; margin-bottom: 4px; }
.membrete img { height: 40px; width: auto; border: none; margin: 0; }
.membrete .lh-txt { font-size: 8.5pt; color: #475569; text-align: center; max-width: 220px; line-height: 1.3; }
</style></head><body>${letterhead}${html}</body></html>`;

const tmpHtml = path.join(os.tmpdir(), `md2pdf_${Date.now()}.html`);
fs.writeFileSync(tmpHtml, doc, 'utf8');
const keepHtml = flag('--html');
if (keepHtml) { fs.writeFileSync(keepHtml, doc, 'utf8'); console.log('HTML:', path.resolve(keepHtml)); }

const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const chrome = candidates.find(p => fs.existsSync(p));
if (!chrome) { console.error('No se encontró Chrome ni Edge.'); process.exit(1); }

const absPdf = path.resolve(outPdf);
execFileSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--no-pdf-header-footer',
  `--print-to-pdf=${absPdf}`,
  'file:///' + tmpHtml.replace(/\\/g, '/'),
], { stdio: 'inherit' });
fs.unlinkSync(tmpHtml);
console.log('PDF generado:', absPdf, '·', fs.statSync(absPdf).size, 'bytes');
