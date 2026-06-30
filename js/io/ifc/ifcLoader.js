// ──────────────────────────────────────────────────────────────────────────────
// io/ifc/ifcLoader.js — IFC file reader (STEP / ISO-10303-21) · #75, G19
//
// .ifc files are TEXT (IFC-SPF, ISO-10303-21), not binary.  For structural members
// (the axis of IfcBeam/IfcColumn/IfcMember) parsing the text is enough: the full
// geometry engine (web-ifc/WASM) is not needed.  This parser is PURE JS, no
// dependencies, so it runs offline in the browser and in Node (pattern `test_*.mjs`),
// and fits into `io/` (text → model), like the other adapters.
//
// Result: an `IfcModel` with a Map  id → { id, type, args }  where each `arg` is:
//   { ref:N }        reference to another instance (#N)
//   "text"           string (already unescaped from '' and \X2\…\X0\)
//   123.4            number
//   "BEAM"           enumeration (.BEAM. → 'BEAM')   ── string, told apart by context
//   null             $ (no value) or * (derived)
//   [ … ]            list/aggregate (recursive)
//   { type, value }  typed value (e.g. IFCBOOLEAN(.T.))
//
// Only the DATA section is interpreted; from the HEADER the schema (IFC2X3/IFC4) is kept.
// STANDALONE (Node + browser).
// ──────────────────────────────────────────────────────────────────────────────

/** Parsed IFC model: instances indexed by id + dereferencing utilities. */
export class IfcModel {
  constructor() {
    this.entities = new Map();   // id → { id, type, args }
    this.byType = new Map();     // 'IFCBEAM' → [entity, …]
    this.schema = 'IFC4';
    this.header = {};
  }

  /** Instance by id (accepts number or {ref:N}). `null` if it does not exist. */
  get(ref) {
    const id = (ref && typeof ref === 'object' && 'ref' in ref) ? ref.ref : ref;
    return this.entities.get(id) || null;
  }

  /** All instances of a type (uppercase, e.g. 'IFCBEAM'). */
  ofType(type) { return this.byType.get(type) || []; }

  /** Is `arg` a #N reference? */
  isRef(a) { return a && typeof a === 'object' && 'ref' in a; }
}

// ── Decoding of IFC strings (ISO-10303-21 + IFC's \X2\ extension) ─────────────────
function decodeIfcString(s) {
  // '' → '  (STEP's own single-quote escape)
  let out = s.replace(/''/g, "'");
  if (out.indexOf('\\') < 0) return out;
  // \S\c  → character c with the high bit set (Latin-1 +128); rare, approximated to c.
  out = out.replace(/\\S\\(.)/g, (_, c) => String.fromCharCode(c.charCodeAt(0) + 128));
  // \X\HH → one hex byte
  out = out.replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // \X2\HHHH…\X0\ → sequence of UTF-16 units (accents, etc.)
  out = out.replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) => {
    let r = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) r += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
    return r;
  });
  return out;
}

// ── Parser of an instance's argument list ─────────────────────────────────────────
// Walks `s` from index `pos.i`, assuming `s[pos.i]` is '(' and returns the array of
// values up to the closing ')' (recursive for nested lists).
function parseList(s, pos) {
  const arr = [];
  pos.i++; // skip '('
  skipWs(s, pos);
  if (s[pos.i] === ')') { pos.i++; return arr; }
  for (;;) {
    arr.push(parseValue(s, pos));
    skipWs(s, pos);
    const c = s[pos.i];
    if (c === ',') { pos.i++; skipWs(s, pos); continue; }
    if (c === ')') { pos.i++; break; }
    // tolerant: if something is odd, stop so we don't hang
    if (c === undefined) break;
    pos.i++;
  }
  return arr;
}

function skipWs(s, pos) {
  for (;;) {
    const c = s[pos.i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { pos.i++; continue; }
    // comment /* … */
    if (c === '/' && s[pos.i + 1] === '*') {
      const end = s.indexOf('*/', pos.i + 2);
      pos.i = end < 0 ? s.length : end + 2;
      continue;
    }
    break;
  }
}

function parseValue(s, pos) {
  skipWs(s, pos);
  const c = s[pos.i];
  if (c === '#') {                                   // reference #N
    let j = pos.i + 1; while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
    const id = parseInt(s.slice(pos.i + 1, j), 10); pos.i = j;
    return { ref: id };
  }
  if (c === "'") {                                   // string '…'  (with internal '')
    let j = pos.i + 1, buf = '';
    for (;;) {
      if (j >= s.length) break;
      if (s[j] === "'") {
        if (s[j + 1] === "'") { buf += "''"; j += 2; continue; }  // escaped quote
        break;
      }
      buf += s[j]; j++;
    }
    pos.i = j + 1;
    return decodeIfcString(buf);
  }
  if (c === '(') return parseList(s, pos);           // nested list
  if (c === '$' || c === '*') { pos.i++; return null; } // no value / derived
  if (c === '.') {                                   // enumeration .NAME.
    const end = s.indexOf('.', pos.i + 1);
    const name = s.slice(pos.i + 1, end < 0 ? s.length : end);
    pos.i = end < 0 ? s.length : end + 1;
    return name;
  }
  if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) { // number
    let j = pos.i; while (j < s.length && /[0-9+\-.eE]/.test(s[j])) j++;
    const num = parseFloat(s.slice(pos.i, j)); pos.i = j;
    return Number.isFinite(num) ? num : 0;
  }
  // identifier: either a typed value TYPE(args), or a bare word
  let j = pos.i; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
  const ident = s.slice(pos.i, j); pos.i = j;
  skipWs(s, pos);
  if (s[pos.i] === '(') { const value = parseList(s, pos); return { type: ident.toUpperCase(), value }; }
  return ident;                                      // e.g. integers without a dot, already covered above
}

// ── Walks the text and splits the `#id=TYPE(...);` statements ─────────────────────
// Scans respecting strings and comments to find each statement's closing ';' (the ';'
// inside '…' or /*…*/ do not count).
function* statements(body) {
  let i = 0; const n = body.length;
  while (i < n) {
    // skip spaces / comments between statements
    while (i < n) {
      const c = body[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
      if (c === '/' && body[i + 1] === '*') { const e = body.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      break;
    }
    if (i >= n) break;
    const start = i;
    let inStr = false;
    while (i < n) {
      const c = body[i];
      if (inStr) {
        if (c === "'") { if (body[i + 1] === "'") { i += 2; continue; } inStr = false; }
        i++; continue;
      }
      if (c === "'") { inStr = true; i++; continue; }
      if (c === '/' && body[i + 1] === '*') { const e = body.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === ';') break;
      i++;
    }
    const stmt = body.slice(start, i).trim();
    i++; // saltar ';'
    if (stmt) yield stmt;
  }
}

/**
 * Parses IFC-SPF text into an `IfcModel`.
 * @param {string} text  contents of the .ifc
 * @returns {IfcModel}
 */
export function parseIFC(text) {
  if (typeof text !== 'string' || !text.length) throw new Error('IFC: archivo vacío');
  if (text.indexOf('ISO-10303-21') < 0 && text.indexOf('IFC') < 0)
    throw new Error('IFC: no parece un archivo IFC (falta cabecera ISO-10303-21)');

  const model = new IfcModel();

  // Schema from the HEADER's FILE_SCHEMA(('IFC4')).
  const sch = text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
  if (sch) model.schema = sch[1].toUpperCase();

  // Only the DATA section contains instances.
  const dStart = text.indexOf('DATA;');
  const dEnd = text.indexOf('ENDSEC', dStart >= 0 ? dStart : 0);
  const body = text.slice(dStart >= 0 ? dStart + 5 : 0, dEnd >= 0 ? dEnd : text.length);

  for (const stmt of statements(body)) {
    // #id = TYPE ( … )
    const eq = stmt.indexOf('=');
    if (stmt[0] !== '#' || eq < 0) continue;
    const id = parseInt(stmt.slice(1, eq), 10);
    if (!Number.isFinite(id)) continue;
    const rest = stmt.slice(eq + 1).trimStart();
    // type name up to the '('
    const paren = rest.indexOf('(');
    if (paren < 0) continue;
    const type = rest.slice(0, paren).trim().toUpperCase();
    const pos = { i: paren };
    let args;
    try { args = parseList(rest, pos); }
    catch { args = []; }
    const ent = { id, type, args };
    model.entities.set(id, ent);
    if (!model.byType.has(type)) model.byType.set(type, []);
    model.byType.get(type).push(ent);
  }

  if (model.entities.size === 0) throw new Error('IFC: no se encontraron instancias en la sección DATA');
  return model;
}

// ── Units: length factor to METERS from IfcUnitAssignment ─────────────────────────
const SI_PREFIX = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9 };

/**
 * Factor to convert the file's lengths to METERS and the unit name.
 * Looks for the IFCSIUNIT of type LENGTHUNIT (or IFCCONVERSIONBASEDUNIT for feet/inches).
 * @returns {{ factor:number, name:string }}
 */
export function lengthUnit(model) {
  for (const u of model.ofType('IFCSIUNIT')) {
    // IfcSIUnit(Dimensions, UnitType, Prefix, Name)
    const unitType = u.args[1];           // .LENGTHUNIT.
    if (unitType !== 'LENGTHUNIT') continue;
    const prefix = u.args[2];             // .MILLI. | null
    const f = prefix ? (SI_PREFIX[prefix] || 1) : 1;
    return { factor: f, name: (prefix ? prefix.toLowerCase() : '') + 'metre' };
  }
  for (const u of model.ofType('IFCCONVERSIONBASEDUNIT')) {
    // IfcConversionBasedUnit(Dimensions, UnitType, Name, ConversionFactor)
    if (u.args[1] !== 'LENGTHUNIT') continue;
    const name = (u.args[2] || '').toString().toLowerCase();
    const mr = model.get(u.args[3]);      // IfcMeasureWithUnit(ValueComponent, UnitComponent)
    let f = 1;
    if (mr && typeof mr.args[0] === 'object' && mr.args[0].value) f = +mr.args[0].value[0] || 1;
    else if (/foot|feet/.test(name)) f = 0.3048;
    else if (/inch/.test(name)) f = 0.0254;
    return { factor: f, name };
  }
  return { factor: 1, name: 'metre (asumido)' };
}
