// ── Minimal, SELF-CONTAINED .docx generator (no dependencies, no build) ──────
// A .docx is a ZIP of XML (OOXML / WordprocessingML). Here it is built by hand:
//   • the ZIP is written with the STORED method (no compression) → only CRC32 is
//     needed, avoiding a DEFLATE library. Word opens STORED-zips without problems.
//   • the content is built from paragraphs, headings, tables and PNG images.
// Used by the "Memoria de cálculo" (app.generateReportDocx). Reusable in the
// browser (download Blob).

const EMU_PER_PX = 9525;            // 1 px (96 dpi) = 9525 EMU
const CONTENT_W_EMU = 6 * 914400;   // usable width ≈ 6" (letter with 1.25" margins)

// ── CRC32 (tabla) ────────────────────────────────────────────────────────────
let _crcTable = null;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const enc = new TextEncoder();
const utf8 = s => enc.encode(s);

// ── ZIP (STORED) ─────────────────────────────────────────────────────────────
// entries: [{ name, data:Uint8Array }]
function buildZip(entries) {
  const recs = entries.map(e => {
    const name = utf8(e.name);
    return { name, data: e.data, crc: crc32(e.data), offset: 0 };
  });
  // Total size: local headers + data + central directory + EOCD
  let size = 0;
  for (const r of recs) size += 30 + r.name.length + r.data.length;
  let cdSize = 0;
  for (const r of recs) cdSize += 46 + r.name.length;
  const total = size + cdSize + 22;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;
  const u16 = v => { dv.setUint16(p, v, true); p += 2; };
  const u32 = v => { dv.setUint32(p, v >>> 0, true); p += 4; };
  const bytes = b => { out.set(b, p); p += b.length; };

  // Local headers + data
  for (const r of recs) {
    r.offset = p;
    u32(0x04034b50); u16(20); u16(0x0800); u16(0);   // sig, ver, flags(UTF-8), STORED method
    u16(0); u16(0);                                   // time/date
    u32(r.crc); u32(r.data.length); u32(r.data.length);
    u16(r.name.length); u16(0);                       // namelen, extralen
    bytes(r.name); bytes(r.data);
  }
  // Central directory
  const cdStart = p;
  for (const r of recs) {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0);
    u16(0); u16(0);
    u32(r.crc); u32(r.data.length); u32(r.data.length);
    u16(r.name.length); u16(0); u16(0);               // name/extra/comment len
    u16(0); u16(0); u32(0);                           // disk, attrs int/ext
    u32(r.offset);
    bytes(r.name);
  }
  // EOCD
  u32(0x06054b50); u16(0); u16(0);
  u16(recs.length); u16(recs.length);
  u32(cdSize); u32(cdStart); u16(0);
  return out;
}

// ── Utilities ────────────────────────────────────────────────────────────────
// Escapes for XML and drops invalid control characters (no control literals in the
// source code: they are filtered by code point).
function xmlEsc(s) {
  s = String(s ?? '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) continue;
    const ch = s[i];
    out += ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch;
  }
  return out;
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// data URL "data:image/png;base64,..." → { bytes, ext, w, h }
function decodeDataUrl(dataUrl) {
  const m = /^data:image\/(png|jpeg|jpg);base64,(.*)$/i.exec(dataUrl || '');
  if (!m) return null;
  const bytes = b64ToBytes(m[2]);
  const isPng = /png/i.test(m[1]);
  let w = 0, h = 0;
  if (isPng) {                                   // IHDR: width/height in bytes 16..23
    const dv = new DataView(bytes.buffer);
    w = dv.getUint32(16); h = dv.getUint32(20);
  } else {                                        // JPEG: find the SOF marker
    let i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        h = (bytes[i + 5] << 8) | bytes[i + 6]; w = (bytes[i + 7] << 8) | bytes[i + 8]; break;
      }
      i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    }
  }
  return { bytes, ext: isPng ? 'png' : 'jpeg', w, h };
}

// ── Builder ──────────────────────────────────────────────────────────────────
export class Docx {
  constructor() {
    this._body = [];        // XML fragments of the body
    this._media = [];        // { name, data } for word/media/
    this._imgRels = [];      // { id, target } image relationships
    this._relSeq = 10;       // rId<10 are reserved for styles/numbering
  }

  _runProps(o = {}) {
    let r = '';
    if (o.bold) r += '<w:b/>';
    if (o.italic) r += '<w:i/>';
    if (o.color) r += `<w:color w:val="${o.color}"/>`;
    if (o.size) r += `<w:sz w:val="${o.size * 2}"/>`;   // half-points
    return r ? `<w:rPr>${r}</w:rPr>` : '';
  }

  heading(text, level = 1) {
    const sz = { 1: 16, 2: 13, 3: 12 }[level] || 12;
    this._body.push(
      `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>` +
      `<w:r>${this._runProps({ bold: true, size: sz, color: '0A3A57' })}` +
      `<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`);
    return this;
  }

  // text can be a string or an array of {text, ...props} for mixed formatting
  paragraph(text, opts = {}) {
    const align = opts.align ? `<w:jc w:val="${opts.align}"/>` : '';
    const runs = Array.isArray(text) ? text : [{ text, ...opts }];
    const body = runs.map(r =>
      `<w:r>${this._runProps(r)}<w:t xml:space="preserve">${xmlEsc(r.text)}</w:t></w:r>`).join('');
    this._body.push(`<w:p><w:pPr>${align}</w:pPr>${body}</w:p>`);
    return this;
  }

  spacer() { this._body.push('<w:p/>'); return this; }
  pageBreak() { this._body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>'); return this; }

  // headers: [str], rows: [[str|{text,...props}]]
  table(headers, rows) {
    const cell = (content, head) => {
      const runs = Array.isArray(content) ? content : [{ text: content }];
      const shade = head ? '<w:shd w:val="clear" w:fill="EEF3F9"/>' : '';
      const p = `<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>` +
        runs.map(r => `<w:r>${this._runProps({ bold: head, ...r })}` +
          `<w:t xml:space="preserve">${xmlEsc(r.text)}</w:t></w:r>`).join('') + '</w:p>';
      return `<w:tc><w:tcPr>${shade}</w:tcPr>${p}</w:tc>`;
    };
    const bd = '<w:tblBorders>' +
      ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s =>
        `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="CDD6E3"/>`).join('') + '</w:tblBorders>';
    let tbl = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${bd}` +
      '<w:tblLook w:firstRow="1"/></w:tblPr>';
    if (headers?.length) tbl += '<w:tr>' + headers.map(h => cell(h, true)).join('') + '</w:tr>';
    for (const row of rows) tbl += '<w:tr>' + row.map(c => cell(c, false)).join('') + '</w:tr>';
    tbl += '</w:tbl><w:p/>';
    this._body.push(tbl);
    return this;
  }

  // Inserts an image from a data URL (PNG/JPEG). caption optional.
  image(dataUrl, caption, maxWidthEmu = CONTENT_W_EMU) {
    const img = decodeDataUrl(dataUrl);
    if (!img || !img.w || !img.h) return this;
    const id = this._relSeq++;
    const name = `image${this._media.length + 1}.${img.ext}`;
    this._media.push({ name, data: img.bytes });
    this._imgRels.push({ id, target: `media/${name}` });
    let w = img.w * EMU_PER_PX, h = img.h * EMU_PER_PX;
    if (w > maxWidthEmu) { h = Math.round(h * maxWidthEmu / w); w = maxWidthEmu; }
    const drawing =
      `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${w}" cy="${h}"/><wp:docPr id="${id}" name="${name}"/>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="rId${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
      `</a:graphicData></a:graphic></wp:inline></w:drawing>`;
    this._body.push(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r>${drawing}</w:r></w:p>`);
    if (caption) this.paragraph([{ text: caption, italic: true, color: '5C6A7D', size: 9 }], { align: 'center' });
    return this;
  }

  _documentXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
      `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
      `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<w:body>${this._body.join('')}` +
      `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
      `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>` +
      `</w:sectPr></w:body></w:document>`;
  }

  _stylesXml() {
    const h = (n, sz) =>
      `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/>` +
      `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
      `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>` +
      `<w:rPr><w:b/><w:color w:val="0A3A57"/><w:sz w:val="${sz}"/></w:rPr></w:style>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>` +
      `<w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>` +
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
      h(1, 32) + h(2, 26) + h(3, 24) + `</w:styles>`;
  }

  _contentTypes() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="png" ContentType="image/png"/>` +
      `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
      `</Types>`;
  }

  _rootRels() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`;
  }

  _docRels() {
    const imgRels = this._imgRels.map(r =>
      `<Relationship Id="rId${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${r.target}"/>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      imgRels + `</Relationships>`;
  }

  blob() {
    const entries = [
      { name: '[Content_Types].xml', data: utf8(this._contentTypes()) },
      { name: '_rels/.rels', data: utf8(this._rootRels()) },
      { name: 'word/document.xml', data: utf8(this._documentXml()) },
      { name: 'word/styles.xml', data: utf8(this._stylesXml()) },
      { name: 'word/_rels/document.xml.rels', data: utf8(this._docRels()) },
      ...this._media.map(m => ({ name: `word/media/${m.name}`, data: m.data })),
    ];
    return new Blob([buildZip(entries)],
      { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }
}
