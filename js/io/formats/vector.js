// ──────────────────────────────────────────────────────────────────────────────
// io/formats/vector.js — VECTOR adapter (.dat) · #74, G18
//
// Reads/writes VECTOR's FIXED-FIELD text format (a nonlinear 3D frame program,
// Fortran style).  Based on the SPECIFICATION of the reference parser in C
// (`referencias/vector_parser.c`) but adapted to what PORTICO handles TODAY: 6 DOF per
// node (no warping ω), solid sections (no strip integration IEIN=1), consistent SI
// units (IEIN=0 → kN/m, no conversion).  A VECTOR «section type» fuses geometry +
// material; on export one type is created per (material, section) pair in use, and on
// import one material and one section are created per type.
//
// .dat sections: 1 title · 2 constants · 3 nodes · 4 properties · 5 members ·
// 8 nodal loads · 9 control · 10 output.  Registered in the `registry`.
// ──────────────────────────────────────────────────────────────────────────────
import { registerFormat } from '../registry.js?v=1';

// ── fixed-field helpers ───────────────────────────────────────────────────────
// Positive integer right-justified (in BZ, spaces count as 0).
const ri = (n, w) => String(Math.max(0, Math.round(n))).padStart(w, ' ');
// Real LEFT-justified with a decimal point: this way the filler blanks land AFTER the
// decimal (BZ→0, value intact) and the «−» sign goes first (BZ does not eat it).
function lf(v, w) {
  v = +v || 0;
  for (let d = 6; d >= 0; d--) { let s = v.toFixed(d); if (!s.includes('.')) s += '.'; if (s.length <= w) return s.padEnd(w, ' '); }
  return v.toExponential(2).slice(0, w).padEnd(w, ' ');
}
// BZ read: blanks → '0', then parse (same criterion as the reference C parser).
const bzInt = (line, start, len) => { const s = (line.substr(start, len) || '').padEnd(len, '0').replace(/[ \t]/g, '0'); return parseInt(s, 10) || 0; };
const bzFloat = (line, start, len) => { const s = (line.substr(start, len) || '').padEnd(len, '0').replace(/[ \t]/g, '0'); return parseFloat(s) || 0; };

// ── EXPORT: neutral model → .dat text ─────────────────────────────────────────
function write(neutral) {
  const W = neutral.meta.exportWarnings = neutral.meta.exportWarnings || [];
  const nodes = neutral.nodes, members = neutral.members;
  const matById = new Map(neutral.materials.map(m => [m.id, m]));
  const secById = new Map(neutral.sections.map(s => [s.id, s]));

  // VECTOR types = (material, section) pairs in use by the members
  const typeKey = new Map(); const types = [];
  for (const e of members) {
    const k = `${e.mat}|${e.sec}`;
    if (!typeKey.has(k)) { typeKey.set(k, types.length + 1); types.push({ mat: e.mat, sec: e.sec }); }
  }
  if (!types.length && neutral.sections.length) { types.push({ mat: neutral.materials[0]?.id ?? 1, sec: neutral.sections[0].id }); }

  // nodal loads (flattened from all cases → a single VECTOR set)
  const nodalLoads = [];
  for (const lc of (neutral.loadCases || [])) for (const ld of (lc.loads || [])) {
    if (ld.type === 'nodal') nodalLoads.push(ld);
    else if (ld.type === 'dist') W.push('Carga distribuida no representable en VECTOR (sólo cargas nodales)');
  }

  if (nodes.length > 999) W.push('VECTOR limita a 999 nodos (campo I3); se truncará la numeración');
  if (types.length > 99) W.push('VECTOR limita a 99 tipos de sección (campo I2)');

  const L = [];
  // 1. TITLE (A70)
  L.push((neutral.meta.name || 'PORTICO').slice(0, 70));
  // 2. CONSTANTS  FORMAT(BZ,I2,I3,5I5,I2,I3,I5): N1,NS,NP,NT,N6,N9,IEIN,N88,N8,N7
  const N6 = nodalLoads.length;
  L.push(ri(0, 2) + ri(members.length, 3) + ri(nodes.length, 5) + ri(types.length, 5) +
         ri(N6, 5) + ri(0, 5) + ri(0, 5) + ri(0, 2) + ri(0, 3) + ri(0, 5));
  // 3. NODES  FORMAT(BZ,3F10.0,7I1): X,Y,Z + [ω,θx,θy,θz,ux,uy,uz]
  for (const n of nodes) {
    const r = n.restraints || {};
    L.push(lf(n.x, 10) + lf(n.y, 10) + lf(n.z, 10) +
           `0${r.rx ? 1 : 0}${r.ry ? 1 : 0}${r.rz ? 1 : 0}${r.ux ? 1 : 0}${r.uy ? 1 : 0}${r.uz ? 1 : 0}`);
  }
  // 4. PROPERTIES (IEIN=0, 2 lines per type, space-separated)
  //    L1: A It Iy Iz E   ·   L2: G eccY eccZ Cw
  for (const ty of types) {
    const s = secById.get(ty.sec) || {}, m = matById.get(ty.mat) || {};
    const A = s.A || 1e-4, It = s.J || 1e-6, Iy = s.Iy || 1e-6, Iz = s.Iz || 1e-6;
    const E = m.E || 2e8, G = m.G || (E / 2.6);
    L.push(`${A} ${It} ${Iy} ${Iz} ${E}`);
    L.push(`${G} 0 0 0`);
  }
  // 5. MEMBERS  FORMAT(BZ,2I3,2I1,3I2,F10.0): ni,nj,LM,LN,type,ITYP,KTYP,gamma
  for (const e of members) {
    const ty = typeKey.get(`${e.mat}|${e.sec}`) || 1;
    const rel = e.releases || [];
    const lm = (rel[3] || rel[4] || rel[5]) ? 0 : 1;   // 1 = rigid, 0 = hinge (end i)
    const ln = (rel[9] || rel[10] || rel[11]) ? 0 : 1; // end j
    L.push(ri(e.ni, 3) + ri(e.nj, 3) + ri(lm, 1) + ri(ln, 1) + ri(ty, 2) + ri(0, 2) + ri(0, 2) + lf(e.beta || 0, 10));
  }
  // 8. NODAL LOADS (N6 groups, 3 lines each)
  for (const ld of nodalLoads) {
    const F = ld.F || [];
    L.push(`${ld.node} 0`);                                       // node, exponent
    L.push(`${F[3] || 0} ${F[4] || 0} ${F[5] || 0} ${F[0] || 0} ${F[1] || 0} ${F[2] || 0}`); // Mx My Mz Fx Fy Fz
    L.push('0 0 0');                                              // eccentricity
  }
  // 9. CONTROL: CN(1..4), ITMAX   ·   10. OUTPUT: IZ(2,10)
  L.push('1 0.5 0.001 1 50');
  L.push('0 0 0 0 0 0 0 0 0 0');
  L.push('0 0 0 0 0 0 0 0 0 0');
  return L.join('\n') + '\n';
}

// ── IMPORT: .dat text → neutral model ─────────────────────────────────────────
function read(text) {
  const warnings = [];
  // lines: strip comments (* at start, / or ; inline) and blanks like the C parser
  const raw = text.split(/\r?\n/);
  const lines = [];
  for (let s of raw) {
    s = s.replace(/[\/;].*$/, '').replace(/\s+$/, '');
    if (s.replace(/^﻿/, '').trim() === '') continue;
    if (s.trimStart().startsWith('*')) continue;
    lines.push(s.replace(/^﻿/, ''));
  }
  let p = 0;
  const next = () => (p < lines.length ? lines[p++] : null);

  next();                                            // 1. title
  const hdr = next(); if (hdr == null) throw new Error('VECTOR: archivo vacío');
  const ws = [2, 3, 5, 5, 5, 5, 5, 2, 3, 5]; let col = 0; const H = [];
  for (const w of ws) { H.push(bzInt(hdr, col, w)); col += w; }
  const NS = H[1], NP = H[2], NT = H[3], N6 = H[4], IEIN = H[6];
  if (NP <= 0) throw new Error('VECTOR: sin nodos (NP=0)');

  // 3. nodes (cols 31-37 = [ω,θx,θy,θz,ux,uy,uz] in Fortran order)
  const nodes = [];
  for (let i = 0; i < NP; i++) {
    const ln = next(); if (ln == null) throw new Error('VECTOR: nodos incompletos');
    nodes.push({
      id: i + 1, x: bzFloat(ln, 0, 10), y: bzFloat(ln, 10, 10), z: bzFloat(ln, 20, 10),
      restraints: { ux: bzInt(ln, 34, 1), uy: bzInt(ln, 35, 1), uz: bzInt(ln, 36, 1), rx: bzInt(ln, 31, 1), ry: bzInt(ln, 32, 1), rz: bzInt(ln, 33, 1) },
      mass: null,
    });
  }

  // 4. properties (IEIN 0/2; cm→m if IEIN=2). IEIN=1 (strips) not supported.
  const materials = [], sections = [];
  if (IEIN === 1) warnings.push('VECTOR IEIN=1 (sección por tiras) no soportado; se ignoran las propiedades');
  for (let i = 0; i < NT; i++) {
    if (IEIN === 1) { next(); while (true) { const sl = next(); if (sl == null || !sl.trim() || Math.abs(parseFloat(sl) || 0) < 1e-20) break; } continue; }
    const l1 = (next() || '').trim().split(/\s+/).map(Number);   // A It Iy Iz E
    const l2 = (next() || '').trim().split(/\s+/).map(Number);   // G eccY eccZ Cw
    let A = l1[0] || 0, It = l1[1] || 0, Iy = l1[2] || 0, Iz = l1[3] || 0, E = l1[4] || 0, G = l2[0] || 0;
    if (IEIN === 2) { A /= 1e4; It /= 1e8; Iy /= 1e8; Iz /= 1e8; E *= 1e4; G *= 1e4; }
    materials.push({ id: i + 1, name: `Mat ${i + 1}`, E, G, nu: G ? Math.max(0, E / (2 * G) - 1) : 0.2, rho: 0 });
    sections.push({ id: i + 1, name: `Sec ${i + 1}`, A, Iz, Iy, J: It });
  }

  // 5. members
  const members = [];
  for (let i = 0; i < NS; i++) {
    const ln = next(); if (ln == null) throw new Error('VECTOR: barras incompletas');
    const ni = bzInt(ln, 0, 3), nj = bzInt(ln, 3, 3), lm = bzInt(ln, 6, 1), lnr = bzInt(ln, 7, 1), ty = bzInt(ln, 8, 2);
    const releases = Array(12).fill(0);
    if (lm !== 1) { releases[3] = releases[4] = releases[5] = 1; }     // hinge at i
    if (lnr !== 1) { releases[9] = releases[10] = releases[11] = 1; }  // hinge at j
    members.push({ id: i + 1, ni, nj, mat: ty || 1, sec: ty || 1, releases, beta: bzFloat(ln, 14, 10) });
  }

  // 8. nodal loads
  const loads = [];
  for (let i = 0; i < N6; i++) {
    const h = (next() || '').trim().split(/\s+/).map(Number); const node = h[0] || 0;
    const v = (next() || '').trim().split(/\s+/).map(Number);   // Mx My Mz Fx Fy Fz
    next();                                                     // eccentricity (discard)
    if (node) loads.push({ type: 'nodal', node, F: [v[3] || 0, v[4] || 0, v[5] || 0, v[0] || 0, v[1] || 0, v[2] || 0] });
  }
  const loadCases = loads.length ? [{ id: 1, name: 'Cargas VECTOR', selfWeight: false, type: 'static', loads }] : [];

  return { units: { length: 'm', force: 'kN' }, meta: { name: 'VECTOR', source: 'vector', warnings }, nodes, materials, sections, members, loadCases };
}

registerFormat({ id: 'vector', name: 'VECTOR (.dat)', ext: 'dat', write, read });
