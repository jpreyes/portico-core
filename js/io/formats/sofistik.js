// ──────────────────────────────────────────────────────────────────────────────
// io/formats/sofistik.js — SOFISTIK adapter (.dat) · #74, G18
//
// Reads/writes SOFISTIK's text input organized into `+PROG … END` MODULES:
//   · AQUA      → materials (`MAT`) and sections by values (`SVAL` with A/IY/IZ/IT + MNO).
//   · SOFIMSHA  → geometry: `NODE` (X/Y/Z + literal `FIX`) and `BEAM` (NA/NE/NCS).
//   · SOFILOAD  → loads: `LC` + `NODE TYPE … P …` (PXX/PYY/PZZ/MXX/MYY/MZZ).
// Each record is `KEYWORD key value …`.  A SOFISTIK section references a material
// (`MNO`) → one `SVAL` is created per (material, section) pair.  Speaks only the NEUTRAL MODEL.
//
// Limitations: end releases and distributed loads are not exported (they are warned).
// ──────────────────────────────────────────────────────────────────────────────
import { registerFormat } from '../registry.js?v=5';

const G_ACC = 9.80665;   // GAM (specific weight) = ρ·g
const num = (v) => { v = +v || 0; if (v === 0) return '0'; const a = Math.abs(v); return (a < 1e-4 || a >= 1e6) ? v.toExponential(6) : String(+v.toPrecision(9)); };
const FIXMAP = [['ux', 'PX'], ['uy', 'PY'], ['uz', 'PZ'], ['rx', 'MX'], ['ry', 'MY'], ['rz', 'MZ']];
const LOADDIR = ['PXX', 'PYY', 'PZZ', 'MXX', 'MYY', 'MZZ'];   // index = component of F
// tokenizes respecting single/double quotes (titles)
const tok = (line) => (line.match(/'[^']*'|"[^"]*"|\S+/g) || []).map(t => ((t[0] === "'" || t[0] === '"') ? t.slice(1, -1) : t));
const kv = (t, from) => { const o = {}; for (let i = from; i + 1 < t.length; i += 2) o[t[i].toUpperCase()] = t[i + 1]; return o; };

// ── EXPORT ────────────────────────────────────────────────────────────────────
function write(neutral) {
  const W = neutral.meta.exportWarnings = neutral.meta.exportWarnings || [];
  const secById = new Map(neutral.sections.map(s => [s.id, s]));
  const matNo = new Map(); neutral.materials.forEach((m, i) => matNo.set(m.id, i + 1));
  const typeKey = new Map(); const types = [];
  for (const e of neutral.members) { const k = `${e.mat}|${e.sec}`; if (!typeKey.has(k)) { typeKey.set(k, types.length + 1); types.push({ mat: e.mat, sec: e.sec }); } }
  if (neutral.members.some(e => (e.releases || []).some(Boolean))) W.push('SOFISTIK: liberaciones de extremo no exportadas (se ignoran)');
  for (const lc of (neutral.loadCases || [])) if ((lc.loads || []).some(l => l.type === 'dist')) { W.push('SOFISTIK: cargas distribuidas no exportadas (sólo nodales)'); break; }

  const L = [];
  L.push('$ SOFISTIK — exportado por PORTICO');
  L.push('+PROG AQUA');
  L.push('HEAD MATERIALES Y SECCIONES');
  L.push('UNIT 5');                       // kN, m system
  for (const m of neutral.materials) L.push(`MAT NO ${matNo.get(m.id)} E ${num(m.E)} MUE ${num(m.nu ?? 0.2)} G ${num(m.G || 0)} GAM ${num((m.rho || 0) * G_ACC)}`);
  types.forEach((t, i) => { const s = secById.get(t.sec) || {}; L.push(`SVAL NO ${i + 1} MNO ${matNo.get(t.mat)} A ${num(s.A)} IY ${num(s.Iy)} IZ ${num(s.Iz)} IT ${num(s.J)}`); });
  L.push('END');

  L.push('+PROG SOFIMSHA');
  L.push('HEAD GEOMETRIA');
  L.push('SYST SPAC');                    // 3D spatial system
  for (const n of neutral.nodes) {
    const r = n.restraints || {}; let code = ''; for (const [k, c] of FIXMAP) if (r[k]) code += c;
    L.push(`NODE NO ${n.id} X ${num(n.x)} Y ${num(n.y)} Z ${num(n.z)}` + (code ? ` FIX ${code}` : ''));
  }
  for (const e of neutral.members) { const t = typeKey.get(`${e.mat}|${e.sec}`) || 1; L.push(`BEAM NO ${e.id} NA ${e.ni} NE ${e.nj} NCS ${t}`); }
  L.push('END');

  const withLoads = (neutral.loadCases || []).filter(lc => (lc.loads || []).some(l => l.type === 'nodal'));
  if (withLoads.length) {
    L.push('+PROG SOFILOAD');
    L.push('HEAD CARGAS');
    withLoads.forEach((lc, i) => {
      L.push(`LC ${i + 1} TITL '${(lc.name || 'LC').replace(/'/g, '')}'`);
      for (const ld of lc.loads) { if (ld.type !== 'nodal') continue; const F = ld.F || []; for (let d = 0; d < 6; d++) if (F[d]) L.push(`    NODE NO ${ld.node} TYPE ${LOADDIR[d]} P ${num(F[d])}`); }
    });
    L.push('END');
  }
  return L.join('\n') + '\n';
}

// ── IMPORT ──────────────────────────────────────────────────────────────────
function read(text) {
  const warnings = [];
  const mats = new Map(), svals = new Map();
  const nodes = [], rawBeams = [];
  const loadCases = []; let curLC = null;
  let prog = '';                                  // current module (AQUA / SOFIMSHA / SOFILOAD)

  const parseFix = (code) => {
    const r = { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 }; const c = (code || '').toUpperCase();
    if (c.includes('F') && !c.includes('FX')) { return { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 }; }   // F = all
    if (c.includes('PP')) { r.ux = r.uy = r.uz = 1; }
    if (c.includes('MM')) { r.rx = r.ry = r.rz = 1; }
    for (const [k, lit] of FIXMAP) if (c.includes(lit)) r[k] = 1;
    return r;
  };

  for (const line of text.split(/\r?\n/)) {
    const s = line.trim(); if (!s || s[0] === '$' || s[0] === '!') continue;
    const t = tok(line); const kw = (t[0] || '').toUpperCase();
    if (kw === '+PROG') { prog = (t[1] || '').toUpperCase(); continue; }
    if (kw === 'END') { prog = ''; continue; }
    if (kw === 'HEAD' || kw === 'UNIT' || kw === 'SYST' || kw === 'NORM') continue;

    if (prog === 'AQUA') {
      if (kw === 'MAT' || kw === 'MATE') { const o = kv(t, 1); mats.set(+o.NO, { E: +o.E || 0, G: +o.G || 0, nu: +o.MUE || 0.2, rho: o.GAM != null ? +o.GAM / G_ACC : 0 }); }
      else if (kw === 'SVAL') { const o = kv(t, 1); svals.set(+o.NO, { A: +o.A || 0, Iy: +o.IY || 0, Iz: +o.IZ || 0, J: +o.IT || 0, mno: +o.MNO || 0 }); }
    } else if (prog === 'SOFIMSHA') {
      if (kw === 'NODE') { const o = kv(t, 1); nodes.push({ id: +o.NO, x: +o.X || 0, y: +o.Y || 0, z: +o.Z || 0, restraints: o.FIX ? parseFix(o.FIX) : { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 }, mass: null }); }
      else if (kw === 'BEAM') { const o = kv(t, 1); rawBeams.push({ id: +o.NO, ni: +o.NA, nj: +o.NE, ncs: +o.NCS || 1 }); }
    } else if (prog === 'SOFILOAD') {
      if (kw === 'LC') { const o = kv(t, 1); curLC = { id: loadCases.length + 1, name: o.TITL || `LC${o.NO}`, selfWeight: false, type: 'static', loads: [] }; loadCases.push(curLC); }
      else if (kw === 'NODE' && curLC) {
        const o = kv(t, 1); const node = +o.NO, P = +o.P || 0, d = LOADDIR.indexOf((o.TYPE || '').toUpperCase());
        if (d >= 0) { let ld = curLC.loads.find(l => l.node === node); if (!ld) { ld = { type: 'nodal', node, F: [0, 0, 0, 0, 0, 0] }; curLC.loads.push(ld); } ld.F[d] += P; }
      }
    }
  }

  // types: one SVAL section → (material MNO + props)
  const typeBySval = new Map(); const materials = [], sections = [];
  const ensureType = (ncs) => {
    if (typeBySval.has(ncs)) return typeBySval.get(ncs);
    const id = sections.length + 1; const sv = svals.get(ncs) || {}; const mt = mats.get(sv.mno) || {};
    materials.push({ id, name: `Mat ${id}`, E: mt.E || 2e8, G: mt.G || 0, nu: mt.nu ?? 0.2, rho: mt.rho || 0, alpha: 1e-5 });
    sections.push({ id, name: `Sec ${id}`, A: sv.A || 0, Iz: sv.Iz || 0, Iy: sv.Iy || 0, J: sv.J || 0 });
    typeBySval.set(ncs, id); return id;
  };
  const members = rawBeams.map(b => { const t = ensureType(b.ncs); return { id: b.id, ni: b.ni, nj: b.nj, mat: t, sec: t, releases: Array(12).fill(0), beta: 0 }; });

  if (!nodes.length) throw new Error('SOFISTIK: sin nodos (módulo SOFIMSHA → NODE)');
  return { units: { length: 'm', force: 'kN' }, meta: { name: 'SOFISTIK', source: 'sofistik', warnings }, nodes, materials, sections, members, loadCases };
}

registerFormat({ id: 'sofistik', name: 'SOFISTIK (.dat)', ext: 'dat', write, read });
