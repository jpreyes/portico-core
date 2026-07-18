// ──────────────────────────────────────────────────────────────────────────────
// io/formats/opensees.js — OpenSees adapter (.tcl) · #74, G18
//
// Reads/writes the model as an OpenSees Tcl SCRIPT: `model BasicBuilder -ndm 3 -ndf 6`,
// `node`, `fix`, `geomTransf Linear`, `element elasticBeamColumn` (with A,E,G,J,Iy,Iz
// inline + transformation tag) and `pattern Plain { … }` for the loads: nodal `load`,
// distributed `eleLoad -beamUniform`, and self-weight as a body force.  Since in OpenSees
// the elastic element carries the properties inline, on import one type (material +
// section) is created per distinct combination of (A,E,G,J,Iy,Iz).  Speaks only the
// NEUTRAL MODEL, like the rest of the adapters.
//
// Limitations, each warned rather than dropped silently: the `elasticBeamColumn` has no
// end releases; `-beamUniform` is uniform, so a trapezoidal load is exported at its mean
// intensity; area self-weight is not exported. Density travels as `-mass` (mass per unit
// length = ρ·A), which is mass — self-weight, a force, is ρ·A·g.
// ──────────────────────────────────────────────────────────────────────────────
import { registerFormat } from '../registry.js?v=3';

const num = (v) => { v = +v || 0; if (v === 0) return '0'; const a = Math.abs(v); return (a < 1e-4 || a >= 1e6) ? v.toExponential(6) : String(+v.toPrecision(9)); };

const G = 9.80665;   // m/s²
const _cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const _dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const _unit = (v) => { const n = Math.hypot(...v) || 1; return [v[0]/n, v[1]/n, v[2]/n]; };

// Element local triad, matching localAxes() in js/solver/timoshenko.js (VERT=0.9994,
// ez = ex×ref, ey = ez×ex). geomTransf's vecxz is ez.
function localFrame(ni, nj) {
  const ex = _unit([nj.x - ni.x, nj.y - ni.y, nj.z - ni.z]);
  const ref = Math.abs(ex[2]) > 0.9994 ? [1, 0, 0] : [0, 0, 1];
  const ez = _unit(_cross(ex, ref));
  const ey = _cross(ez, ex);
  return { ex, ey, ez };
}

// Local z axis same as PORTICO (global Z unless near-vertical member → global X).
function localZ(ni, nj) { return localFrame(ni, nj).ez; }

// A PORTICO distributed load {w, dir} → local intensities [Wx, Wy, Wz] for eleLoad.
// In PORTICO a positive `w` on 'gravity'/'globalZ' points DOWN (global −Z), matching
// _toLocalDistLoad() in the assembler; global/local dirs pass straight through.
function beamUniformLocal(ni, nj, w, dir) {
  if (dir === 'localX') return [w, 0, 0];
  if (dir === 'localY') return [0, w, 0];
  if (dir === 'localZ') return [0, 0, w];
  const g = dir === 'globalX' ? [w, 0, 0]
          : dir === 'globalY' ? [0, w, 0]
          : [0, 0, -w];   // 'gravity' and 'globalZ' → global −Z
  const { ex, ey, ez } = localFrame(ni, nj);
  return [_dot(g, ex), _dot(g, ey), _dot(g, ez)];
}

// ── EXPORT ────────────────────────────────────────────────────────────────────
function write(neutral) {
  const W = neutral.meta.exportWarnings = neutral.meta.exportWarnings || [];
  const matById = new Map(neutral.materials.map(m => [m.id, m]));
  const secById = new Map(neutral.sections.map(s => [s.id, s]));
  const nodeById = new Map(neutral.nodes.map(n => [n.id, n]));
  const memById = new Map(neutral.members.map(e => [e.id, e]));
  const L = [];
  L.push('# OpenSees — exportado por PORTICO');
  L.push('wipe');
  L.push('model BasicBuilder -ndm 3 -ndf 6');
  L.push('# --- nodos ---');
  for (const n of neutral.nodes) L.push(`node ${n.id} ${num(n.x)} ${num(n.y)} ${num(n.z)}`);
  L.push('# --- apoyos (ux uy uz rx ry rz; 1=fijo) ---');
  for (const n of neutral.nodes) { const r = n.restraints || {}; if (['ux', 'uy', 'uz', 'rx', 'ry', 'rz'].some(k => r[k])) L.push(`fix ${n.id} ${r.ux ? 1 : 0} ${r.uy ? 1 : 0} ${r.uz ? 1 : 0} ${r.rx ? 1 : 0} ${r.ry ? 1 : 0} ${r.rz ? 1 : 0}`); }
  L.push('# --- elementos (elasticBeamColumn: A E G J Iy Iz transfTag) ---');
  let warnedRel = false;
  for (const e of neutral.members) {
    const s = secById.get(e.sec) || {}, m = matById.get(e.mat) || {};
    const ni = nodeById.get(e.ni), nj = nodeById.get(e.nj); if (!ni || !nj) continue;
    if (!warnedRel && (e.releases || []).some(Boolean)) { W.push('OpenSees elasticBeamColumn no soporta liberaciones de extremo (se ignoran)'); warnedRel = true; }
    const lz = localZ(ni, nj);
    L.push(`geomTransf Linear ${e.id} ${num(lz[0])} ${num(lz[1])} ${num(lz[2])}`);
    const massPerL = (m.rho || 0) * (s.A || 0);
    L.push(`element elasticBeamColumn ${e.id} ${e.ni} ${e.nj} ${num(s.A)} ${num(m.E)} ${num(m.G || 0)} ${num(s.J)} ${num(s.Iy)} ${num(s.Iz)} ${e.id}` + (massPerL > 0 ? ` -mass ${num(massPerL)}` : ''));
  }
  let pat = 0, warnedTrap = false;
  for (const lc of (neutral.loadCases || [])) {
    const nl = (lc.loads || []).filter(l => l.type === 'nodal');
    const dl = (lc.loads || []).filter(l => l.type === 'dist');
    const sw = !!lc.selfWeight;
    // A case with only distributed loads used to be dropped here — the `continue` fired
    // before anything was written and before any warning. Emit a pattern whenever the
    // case carries ANY load, self-weight included.
    if (!nl.length && !dl.length && !sw) continue;
    pat++;
    L.push(`# caso de carga: ${lc.name}${sw && !/propio|self.?weight/i.test(lc.name || '') ? ' (+ peso propio)' : ''}`);
    L.push(`pattern Plain ${pat} Linear {`);
    for (const ld of nl) { const F = ld.F || []; L.push(`    load ${ld.node} ${num(F[0] || 0)} ${num(F[1] || 0)} ${num(F[2] || 0)} ${num(F[3] || 0)} ${num(F[4] || 0)} ${num(F[5] || 0)}`); }
    for (const ld of dl) {
      const e = memById.get(ld.member); if (!e) continue;
      const ni = nodeById.get(e.ni), nj = nodeById.get(e.nj); if (!ni || !nj) continue;
      // Trapezoidal (w2 ≠ w) has no eleLoad -beamUniform form; warn and use the mean.
      let w = +ld.w || 0;
      if (ld.w2 != null && +ld.w2 !== w) {
        if (!warnedTrap) { W.push('OpenSees eleLoad -beamUniform es uniforme: la carga trapecial se exportó con su intensidad media'); warnedTrap = true; }
        w = 0.5 * (w + (+ld.w2 || 0));
      }
      const [wx, wy, wz] = beamUniformLocal(ni, nj, w, ld.dir || 'gravity');
      // 3D -beamUniform argument order is Wy Wz Wx (local).
      L.push(`    eleLoad -ele ${e.id} -type -beamUniform ${num(wy)} ${num(wz)} ${num(wx)}`);
    }
    if (sw) {
      // Self-weight as a global −Z body force: rho*A*g per length on every member,
      // projected to local axes exactly as the JS solver does (assembler.js).
      for (const e of neutral.members) {
        const s = secById.get(e.sec) || {}, mm = matById.get(e.mat) || {};
        const q = (mm.rho || 0) * (s.A || 0) * G;   // force/length, downward
        if (!(q > 0)) continue;
        const ni = nodeById.get(e.ni), nj = nodeById.get(e.nj); if (!ni || !nj) continue;
        const [wx, wy, wz] = beamUniformLocal(ni, nj, q, 'gravity');
        L.push(`    eleLoad -ele ${e.id} -type -beamUniform ${num(wy)} ${num(wz)} ${num(wx)}`);
      }
      if ((neutral.areas || []).length) W.push('El peso propio de los elementos de área no se exporta a OpenSees (sólo el de las barras)');
    }
    L.push('}');
  }
  return L.join('\n') + '\n';
}

// ── IMPORT ──────────────────────────────────────────────────────────────────
function read(text) {
  const warnings = [];
  const nodes = [], rawEls = [];
  const restr = new Map();
  const loadCases = []; let curPat = null;
  for (let line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    if (curPat) {                                   // inside a pattern { … }
      if (s.startsWith('}')) { if (curPat.loads.length) loadCases.push(curPat); curPat = null; continue; }
      const t = s.split(/\s+/);
      if (t[0] === 'load') { const node = +t[1]; const F = [0, 0, 0, 0, 0, 0]; for (let d = 0; d < 6; d++) F[d] = +t[2 + d] || 0; curPat.loads.push({ type: 'nodal', node, F }); }
      else if (t[0] === 'eleLoad') {
        // eleLoad -ele E -type -beamUniform Wy Wz [Wx]  → a local distributed load. We
        // keep it in the element's local frame (localY/Z/X); reconstructing a global dir
        // would need the geometry and is lossy, so the round-trip stays local.
        const ei = t.indexOf('-ele'), bi = t.indexOf('-beamUniform');
        if (ei >= 0 && bi >= 0) {
          const member = +t[ei + 1];
          const wy = +t[bi + 1] || 0, wz = +t[bi + 2] || 0, wx = +t[bi + 3] || 0;
          if (wy) curPat.loads.push({ type: 'dist', member, w: wy, dir: 'localY' });
          if (wz) curPat.loads.push({ type: 'dist', member, w: wz, dir: 'localZ' });
          if (wx) curPat.loads.push({ type: 'dist', member, w: wx, dir: 'localX' });
        }
      }
      continue;
    }
    const t = s.split(/\s+/);
    if (t[0] === 'node') nodes.push({ id: +t[1], x: +t[2] || 0, y: +t[3] || 0, z: +t[4] || 0, restraints: { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 }, mass: null });
    else if (t[0] === 'fix') { const id = +t[1]; restr.set(id, { ux: +t[2] ? 1 : 0, uy: +t[3] ? 1 : 0, uz: +t[4] ? 1 : 0, rx: +t[5] ? 1 : 0, ry: +t[6] ? 1 : 0, rz: +t[7] ? 1 : 0 }); }
    else if (t[0] === 'element' && t[1] === 'elasticBeamColumn') {
      const mi = t.indexOf('-mass');
      rawEls.push({ id: +t[2], ni: +t[3], nj: +t[4], A: +t[5] || 0, E: +t[6] || 0, G: +t[7] || 0, J: +t[8] || 0, Iy: +t[9] || 0, Iz: +t[10] || 0, mass: mi >= 0 ? +t[mi + 1] || 0 : 0 });
    } else if (t[0] === 'pattern' && t[1] === 'Plain') {
      curPat = { id: loadCases.length + 1, name: `Pattern ${t[2]}`, selfWeight: false, type: 'static', loads: [] };
    }
  }
  for (const n of nodes) { const r = restr.get(n.id); if (r) n.restraints = r; }

  // types by (A,E,G,J,Iy,Iz)
  const typeKey = new Map(); const materials = [], sections = [];
  const ensureType = (el) => {
    const k = `${el.A}|${el.E}|${el.G}|${el.J}|${el.Iy}|${el.Iz}`;
    if (typeKey.has(k)) return typeKey.get(k);
    const id = sections.length + 1;
    materials.push({ id, name: `Mat ${id}`, E: el.E, G: el.G, nu: el.G ? Math.max(0, el.E / (2 * el.G) - 1) : 0.2, rho: el.A ? el.mass / el.A : 0, alpha: 1e-5 });
    sections.push({ id, name: `Sec ${id}`, A: el.A, Iz: el.Iz, Iy: el.Iy, J: el.J });
    typeKey.set(k, id); return id;
  };
  const members = rawEls.map(el => { const t = ensureType(el); return { id: el.id, ni: el.ni, nj: el.nj, mat: t, sec: t, releases: Array(12).fill(0), beta: 0 }; });

  if (!nodes.length) throw new Error('OpenSees: sin nodos (node …)');
  return { units: { length: 'm', force: 'kN' }, meta: { name: 'OpenSees', source: 'opensees', warnings }, nodes, materials, sections, members, loadCases };
}

registerFormat({ id: 'opensees', name: 'OpenSees (.tcl)', ext: 'tcl', write, read });
