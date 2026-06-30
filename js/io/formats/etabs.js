// ──────────────────────────────────────────────────────────────────────────────
// io/formats/etabs.js — ETABS adapter (.e2k / .$et) · #74, G18
//
// Reads/writes ETABS's text format, organized into `$ NAME` SECTIONS and
// `KEYWORD "name" ...` records.  Unlike SAP2000 (a flat 3D model), ETABS is a
// BUILDING-BY-STORY model: the points are PLAN coordinates (X,Y) and the Z level is
// given by the story elevation (STORY).  Lines are classified into COLUMN (vertical),
// BEAM (same story) and BRACE (inclined) and assigned to a story (`LINEASSIGN`).
//
// Mapping to PORTICO (general 3D frame):
//  · STORIES  = unique Z levels of the nodes (the lowest = BASE).
//  · POINT    = unique plan positions (X,Y).   node = (point, story).
//  · column   → same point on adjacent stories;  beam → two points on the same story;
//    brace    → two points on adjacent stories.  (NON-adjacent spans → warning.)
//  · an ETABS section references a material → one section per (material, section) pair.
// Round-trip verified for buildings (nodes at levels, standard columns/beams).
// ──────────────────────────────────────────────────────────────────────────────
import { registerFormat } from '../registry.js?v=1';

const RF = ['PI', 'V2I', 'V3I', 'TI', 'M2I', 'M3I', 'PJ', 'V2J', 'V3J', 'TJ', 'M2J', 'M3J'];
const RMAP = { UX: 'ux', UY: 'uy', UZ: 'uz', RX: 'rx', RY: 'ry', RZ: 'rz' };
const G_ACC = 9.80665;
const num = (v) => { v = +v || 0; if (v === 0) return '0'; const a = Math.abs(v); return (a < 1e-4 || a >= 1e6) ? v.toExponential(6) : String(+v.toPrecision(9)); };
const q = (s) => `"${String(s).replace(/"/g, '')}"`;
const zk = (z) => (+z).toFixed(6);
const pk = (x, y) => `${(+x).toFixed(6)},${(+y).toFixed(6)}`;
// tokenizes a line respecting quotes; returns tokens without quotes
const tok = (line) => (line.match(/"[^"]*"|\S+/g) || []).map(t => (t[0] === '"' ? t.slice(1, -1) : t));
// key/value pairs starting from token `from`
const kv = (t, from) => { const o = {}; for (let i = from; i + 1 < t.length; i += 2) o[t[i].toUpperCase()] = t[i + 1]; return o; };

// ── EXPORT ────────────────────────────────────────────────────────────────────
function write(neutral) {
  const W = neutral.meta.exportWarnings = neutral.meta.exportWarnings || [];
  const nodes = neutral.nodes, nodeById = new Map(nodes.map(n => [n.id, n]));
  const secById = new Map(neutral.sections.map(s => [s.id, s]));
  const matName = new Map(); neutral.materials.forEach((m, i) => matName.set(m.id, `MAT${i + 1}`));

  // stories = unique Z levels (asc; the lowest = BASE)
  const zlevels = [...new Set(nodes.map(n => +zk(n.z)))].sort((a, b) => a - b);
  const storyByZ = new Map(); zlevels.forEach((z, i) => storyByZ.set(zk(z), i === 0 ? 'BASE' : `STORY${i}`));
  const storiesAsc = zlevels.map(z => storyByZ.get(zk(z)));
  const belowOf = (s) => { const i = storiesAsc.indexOf(s); return i > 0 ? storiesAsc[i - 1] : null; };
  // unique plan points (X,Y)
  const planName = new Map(); const planList = [];
  for (const n of nodes) { const k = pk(n.x, n.y); if (!planName.has(k)) { const nm = `P${planList.length + 1}`; planName.set(k, nm); planList.push({ name: nm, x: n.x, y: n.y }); } }
  const nStory = (n) => storyByZ.get(zk(n.z));
  const nPlan = (n) => planName.get(pk(n.x, n.y));

  // (material, section) types → one ETABS section per type
  const typeKey = new Map(); const types = [];
  for (const e of neutral.members) { const k = `${e.mat}|${e.sec}`; if (!typeKey.has(k)) { typeKey.set(k, types.length + 1); types.push({ mat: e.mat, sec: e.sec, name: `SEC${types.length + 1}` }); } }

  for (const lc of (neutral.loadCases || [])) if ((lc.loads || []).some(l => l.type === 'dist')) { W.push('Cargas distribuidas de frame aún no exportadas a ETABS (sólo cargas nodales)'); break; }

  const L = [];
  L.push('$ PROGRAM INFORMATION');
  L.push('  PROGRAM "ETABS"  VERSION "18.0.0"');
  L.push('$ CONTROLS');
  L.push('  UNITS "KN" "M" "C"');
  L.push(`  TITLE1 ${q(neutral.meta.name || 'PORTICO')}`);
  L.push('$ STORIES - IN SEQUENCE FROM TOP');
  for (let i = zlevels.length - 1; i >= 0; i--) { const z = zlevels[i], nm = storyByZ.get(zk(z)); L.push(i === 0 ? `  STORY ${q(nm)}  ELEV ${num(z)}` : `  STORY ${q(nm)}  HEIGHT ${num(z - zlevels[i - 1])}`); }
  L.push('$ POINT COORDINATES');
  for (const p of planList) L.push(`  POINT ${q(p.name)}  ${num(p.x)} ${num(p.y)}`);
  L.push('$ POINT ASSIGNS');
  for (const n of nodes) {
    const r = n.restraints || {}; const on = Object.keys(RMAP).filter(K => r[RMAP[K]]);
    L.push(`  POINTASSIGN ${q(nPlan(n))} ${q(nStory(n))}` + (on.length ? `  RESTRAINT ${q(on.join(' '))}` : ''));
  }
  L.push('$ MATERIAL PROPERTIES');
  for (const m of neutral.materials) {
    L.push(`  MATERIAL ${q(matName.get(m.id))}  TYPE "General"  WEIGHTPERVOLUME ${num((m.rho || 0) * G_ACC)}`);
    L.push(`  MATERIAL ${q(matName.get(m.id))}  SYMTYPE "Isotropic"  E ${num(m.E)}  U ${num(m.nu ?? 0.2)}  G ${num(m.G || 0)}  A ${num(m.alpha ?? 1e-5)}`);
  }
  L.push('$ FRAME SECTIONS');
  for (const t of types) { const s = secById.get(t.sec) || {}; L.push(`  FRAMESECTION ${q(t.name)}  MATERIAL ${q(matName.get(t.mat))}  SHAPE "General"  AREA ${num(s.A)}  TORSCONST ${num(s.J)}  I33 ${num(s.Iz)}  I22 ${num(s.Iy)}  AS2 ${num(s.Avy || 0)}  AS3 ${num(s.Avz || 0)}`); }

  // lines: one LINE + one LINEASSIGN per member (classified by geometry)
  const conn = [], assign = [];
  neutral.members.forEach((e, idx) => {
    const ni = nodeById.get(e.ni), nj = nodeById.get(e.nj); if (!ni || !nj) return;
    const pI = nPlan(ni), pJ = nPlan(nj), sI = nStory(ni), sJ = nStory(nj);
    const name = `L${idx + 1}`; const tname = types[(typeKey.get(`${e.mat}|${e.sec}`) || 1) - 1].name;
    const rel = e.releases || []; const relStr = RF.filter((_, i) => rel[i]).join(' ');
    const relTok = relStr ? `  RELEASE ${q(relStr)}` : '';
    let type, a, b, story;
    if (pI === pJ && sI !== sJ) {                       // COLUMN
      type = 'COLUMN'; a = pI; b = pI;
      const up = (zlevels.indexOf(+zk(ni.z)) > zlevels.indexOf(+zk(nj.z))) ? sI : sJ; story = up;
      const low = up === sI ? sJ : sI; if (belowOf(up) !== low) W.push(`Columna ${name}: vano no adyacente (geometría aprox. al exportar a ETABS)`);
    } else if (sI === sJ) {                             // BEAM
      type = 'BEAM'; a = pI; b = pJ; story = sI;
    } else {                                            // BRACE (diagonal)
      type = 'BRACE';
      const iUp = zlevels.indexOf(+zk(ni.z)) > zlevels.indexOf(+zk(nj.z));
      a = iUp ? pI : pJ; b = iUp ? pJ : pI; story = iUp ? sI : sJ;
      const low = iUp ? sJ : sI; if (belowOf(story) !== low) W.push(`Diagonal ${name}: vano no adyacente (geometría aprox. al exportar a ETABS)`);
    }
    conn.push(`  LINE ${q(name)}  ${type} ${q(a)} ${q(b)} 1`);
    assign.push(`  LINEASSIGN ${q(name)} ${q(story)}  SECTION ${q(tname)}${relTok}`);
  });
  L.push('$ LINE CONNECTIVITIES'); L.push(...conn);
  L.push('$ LINE ASSIGNS'); L.push(...assign);

  // load patterns + nodal loads
  const cases = neutral.loadCases || [];
  L.push('$ LOAD PATTERNS');
  if (cases.length) for (const lc of cases) L.push(`  LOADPATTERN ${q(lc.name)}  TYPE "Other"  SELFWEIGHT ${lc.selfWeight ? 1 : 0}`);
  else L.push('  LOADPATTERN "DEAD"  TYPE "Dead"  SELFWEIGHT 1');
  const pl = [];
  for (const lc of cases) for (const ld of (lc.loads || [])) if (ld.type === 'nodal') { const n = nodeById.get(ld.node); if (n) { const F = ld.F || []; pl.push(`  POINTLOAD ${q(nPlan(n))} ${q(nStory(n))}  LC ${q(lc.name)}  FX ${num(F[0] || 0)}  FY ${num(F[1] || 0)}  FZ ${num(F[2] || 0)}  MX ${num(F[3] || 0)}  MY ${num(F[4] || 0)}  MZ ${num(F[5] || 0)}`); } }
  if (pl.length) { L.push('$ POINT OBJECT LOADS'); L.push(...pl); }
  L.push('$ END');
  return L.join('\n') + '\n';
}

// ── IMPORT ──────────────────────────────────────────────────────────────────
function read(text) {
  const warnings = [];
  const rec = {};   // keyword → array of token-arrays
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim(); if (!t || t[0] === '$') continue;
    const tk = tok(line); if (!tk.length) continue;
    (rec[tk[0].toUpperCase()] ||= []).push(tk);
  }
  const get = (k) => rec[k] || [];

  // stories → elevations (the records come from top to bottom)
  const storyRecs = get('STORY').map(t => { const o = kv(t, 2); return { name: t[1], height: o.HEIGHT != null ? +o.HEIGHT : null, elev: o.ELEV != null ? +o.ELEV : null }; });
  const storyElev = new Map();
  const bottomUp = storyRecs.slice().reverse();
  let elev = bottomUp.length ? (bottomUp[0].elev ?? 0) : 0;
  bottomUp.forEach((s, i) => { if (i > 0) elev += (s.height ?? 0); storyElev.set(s.name, s.elev != null ? s.elev : elev); });
  const storiesAsc = [...storyElev.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]);
  const belowOf = (s) => { const i = storiesAsc.indexOf(s); return i > 0 ? storiesAsc[i - 1] : null; };

  // plan points
  const planXY = new Map(); for (const t of get('POINT')) planXY.set(t[1], [+t[2] || 0, +t[3] || 0]);

  // materials (two records per material: general + mechanical)
  const matByName = new Map();
  for (const t of get('MATERIAL')) { const o = kv(t, 2); const m = matByName.get(t[1]) || { E: 0, G: 0, nu: 0.2, alpha: 1e-5, rho: 0 }; if (o.E != null) m.E = +o.E; if (o.G != null) m.G = +o.G; if (o.U != null) m.nu = +o.U; if (o.A != null) m.alpha = +o.A; if (o.WEIGHTPERVOLUME != null) m.rho = +o.WEIGHTPERVOLUME / G_ACC; matByName.set(t[1], m); }
  // frame sections
  const secByName = new Map();
  for (const t of get('FRAMESECTION')) { const o = kv(t, 2); secByName.set(t[1], { A: +o.AREA || 0, Iz: +o.I33 || 0, Iy: +o.I22 || 0, J: +o.TORSCONST || 0, Avy: +o.AS2 || 0, Avz: +o.AS3 || 0, mat: o.MATERIAL }); }

  // nodes = (point, story) on demand
  const nodes = [], nodeByKey = new Map();
  const ensureNode = (p, s) => { const k = `${p}|${s}`; if (nodeByKey.has(k)) return nodeByKey.get(k); const xy = planXY.get(p) || [0, 0]; const n = { id: nodes.length + 1, x: xy[0], y: xy[1], z: storyElev.get(s) ?? 0, restraints: { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 }, mass: null }; nodes.push(n); nodeByKey.set(k, n); return n; };
  for (const t of get('POINTASSIGN')) { const n = ensureNode(t[1], t[2]); const o = kv(t, 3); if (o.RESTRAINT) for (const r of o.RESTRAINT.split(/\s+/)) if (RMAP[r]) n.restraints[RMAP[r]] = 1; }

  // (material+section) types per used section name
  const typeByName = new Map(); const materials = [], sections = [];
  const ensureType = (secName) => {
    if (typeByName.has(secName)) return typeByName.get(secName);
    const id = sections.length + 1; const sp = secByName.get(secName) || {}; const mp = matByName.get(sp.mat) || {};
    materials.push({ id, name: sp.mat || `Mat ${id}`, E: mp.E || 2e8, G: mp.G || 0, nu: mp.nu ?? 0.2, rho: mp.rho || 0, alpha: mp.alpha ?? 1e-5 });
    sections.push({ id, name: secName || `Sec ${id}`, A: sp.A || 0, Iz: sp.Iz || 0, Iy: sp.Iy || 0, J: sp.J || 0, Avy: sp.Avy, Avz: sp.Avz });
    typeByName.set(secName, id); return id;
  };

  // line connectivity + assignments (one member per LINEASSIGN)
  const lineConn = new Map(); for (const t of get('LINE')) lineConn.set(t[1], { type: (t[2] || 'BEAM').toUpperCase(), pI: t[3], pJ: t[4] });
  const members = [];
  for (const t of get('LINEASSIGN')) {
    const c = lineConn.get(t[1]); if (!c) continue;
    const o = kv(t, 3); const story = t[2]; const tIdx = ensureType(o.SECTION);
    let A, B;
    if (c.type === 'COLUMN') { A = ensureNode(c.pI, story); const lo = belowOf(story); if (!lo) { warnings.push(`Columna ${t[1]} sin piso inferior; omitida`); continue; } B = ensureNode(c.pI, lo); }
    else if (c.type === 'BRACE') { A = ensureNode(c.pI, story); const lo = belowOf(story); if (!lo) { warnings.push(`Diagonal ${t[1]} sin piso inferior; omitida`); continue; } B = ensureNode(c.pJ, lo); }
    else { A = ensureNode(c.pI, story); B = ensureNode(c.pJ, story); }   // BEAM (same story)
    const releases = Array(12).fill(0); if (o.RELEASE) for (const r of o.RELEASE.split(/\s+/)) { const i = RF.indexOf(r); if (i >= 0) releases[i] = 1; }
    members.push({ id: members.length + 1, ni: A.id, nj: B.id, mat: tIdx, sec: tIdx, releases, beta: 0 });
  }

  // load patterns + nodal loads
  const lcByPat = new Map(); const loadCases = [];
  for (const t of get('LOADPATTERN')) { const o = kv(t, 2); const lc = { id: loadCases.length + 1, name: t[1], selfWeight: (+o.SELFWEIGHT || 0) > 0, type: 'static', loads: [] }; lcByPat.set(t[1], lc); loadCases.push(lc); }
  for (const t of get('POINTLOAD')) {
    const o = kv(t, 3); const n = ensureNode(t[1], t[2]); const pat = o.LC || 'DEAD';
    let lc = lcByPat.get(pat); if (!lc) { lc = { id: loadCases.length + 1, name: pat, selfWeight: false, type: 'static', loads: [] }; lcByPat.set(pat, lc); loadCases.push(lc); }
    lc.loads.push({ type: 'nodal', node: n.id, F: [+o.FX || 0, +o.FY || 0, +o.FZ || 0, +o.MX || 0, +o.MY || 0, +o.MZ || 0] });
  }

  if (!nodes.length) throw new Error('ETABS: sin puntos/pisos reconocibles');
  return { units: { length: 'm', force: 'kN' }, meta: { name: 'ETABS', source: 'etabs', warnings }, nodes, materials, sections, members, loadCases };
}

registerFormat({ id: 'etabs', name: 'ETABS (.e2k)', ext: 'e2k', write, read });
