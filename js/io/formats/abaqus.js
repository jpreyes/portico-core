// ──────────────────────────────────────────────────────────────────────────────
// io/formats/abaqus.js — Abaqus / CalculiX adapter (.inp) · #74, G18
//
// Reads/writes Abaqus/CalculiX's KEYWORD format (`*NODE`, `*ELEMENT`,
// `*BEAM GENERAL SECTION`, `*BOUNDARY`, `*CLOAD`, `*STEP`).  Its syntax is radically
// different from VECTOR's fixed field → it shows the format registry is agnostic: both
// speak only the NEUTRAL MODEL.  Covers PORTICO's subset: members (B31), general
// sections (A, I11=Iz, I22=Iy, J + E, G), supports and per-step nodal loads.
// ──────────────────────────────────────────────────────────────────────────────
import { registerFormat } from '../registry.js?v=7';

const fmt = (v) => { v = +v || 0; if (v === 0) return '0.'; const a = Math.abs(v); return (a < 1e-3 || a >= 1e7) ? v.toExponential(6) : (+v.toPrecision(8)).toString(); };
const DOF = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'];   // Abaqus dof 1..6 == PORTICO order

// ── EXPORT ────────────────────────────────────────────────────────────────────
function write(neutral) {
  const matById = new Map(neutral.materials.map(m => [m.id, m]));
  const secById = new Map(neutral.sections.map(s => [s.id, s]));
  const L = [];
  L.push('*HEADING');
  L.push(` ${neutral.meta.name || 'PORTICO'} - exportado por PORTICO`);
  L.push('*NODE');
  for (const n of neutral.nodes) L.push(`${n.id}, ${fmt(n.x)}, ${fmt(n.y)}, ${fmt(n.z)}`);

  // group members by (material, section) → one ELSET per group
  const gk = new Map(); const groups = [];
  for (const e of neutral.members) { const k = `${e.mat}|${e.sec}`; if (!gk.has(k)) { gk.set(k, groups.length); groups.push({ mat: e.mat, sec: e.sec, els: [] }); } groups[gk.get(k)].els.push(e); }

  groups.forEach((g, gi) => {
    L.push(`*ELEMENT, TYPE=B31, ELSET=SEC${gi + 1}`);
    for (const e of g.els) L.push(`${e.id}, ${e.ni}, ${e.nj}`);
  });
  groups.forEach((g, gi) => {
    const s = secById.get(g.sec) || {}, m = matById.get(g.mat) || {};
    const E = m.E || 2e8, G = m.G || (E / 2.6);
    L.push(`*BEAM GENERAL SECTION, ELSET=SEC${gi + 1}, SECTION=GENERAL`);
    L.push(`${fmt(s.A)}, ${fmt(s.Iz)}, 0., ${fmt(s.Iy)}, ${fmt(s.J)}`);   // A, I11=Iz, I12, I22=Iy, J
    L.push('0., 0., -1.');                                                // n1-axis orientation
    L.push(`${fmt(E)}, ${fmt(G)}`);
  });

  // supports
  const bnd = [];
  for (const n of neutral.nodes) { const r = n.restraints || {}; DOF.forEach((k, i) => { if (r[k]) bnd.push(`${n.id}, ${i + 1}, ${i + 1}`); }); }
  if (bnd.length) { L.push('*BOUNDARY'); L.push(...bnd); }

  // nodal loads: one *STEP per case with loads
  for (const lc of (neutral.loadCases || [])) {
    const nl = (lc.loads || []).filter(l => l.type === 'nodal');
    if (!nl.length) continue;
    L.push(`*STEP, NAME=${(lc.name || 'LC').replace(/[, ]/g, '_')}`);
    L.push('*STATIC');
    L.push('*CLOAD');
    for (const ld of nl) { const F = ld.F || []; for (let d = 0; d < 6; d++) if (F[d]) L.push(`${ld.node}, ${d + 1}, ${fmt(F[d])}`); }
    L.push('*END STEP');
  }
  return L.join('\n') + '\n';
}

// ── IMPORT ──────────────────────────────────────────────────────────────────
function read(text) {
  const warnings = [];
  const nodes = [], rawMembers = [], elsetProps = new Map();
  const restr = new Map();   // nodeId → restraints
  const loadCases = []; let curStep = null;
  let kw = '', params = {}, pending = null;   // pending = beam section in progress

  const flush = () => {
    if (!pending) return;
    const d0 = (pending.data[0] || '').split(',').map(s => parseFloat(s));
    const d2 = (pending.data[2] || '').split(',').map(s => parseFloat(s));
    elsetProps.set(pending.elset, { A: d0[0] || 0, Iz: d0[1] || 0, Iy: d0[3] || 0, J: d0[4] || 0, E: d2[0] || 0, G: d2[1] || 0 });
    pending = null;
  };
  const parseKw = (line) => {
    const body = line.slice(1);
    const comma = body.indexOf(',');
    const head = (comma < 0 ? body : body.slice(0, comma)).trim().toUpperCase().replace(/\s+/g, ' ');
    const par = {};
    if (comma >= 0) for (const tok of body.slice(comma + 1).split(',')) { const eq = tok.indexOf('='); if (eq >= 0) par[tok.slice(0, eq).trim().toUpperCase()] = tok.slice(eq + 1).trim(); }
    return { head, par };
  };

  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+$/, '');
    if (!line.trim() || line.startsWith('**')) continue;
    if (line.startsWith('*')) {
      flush();
      const { head, par } = parseKw(line);
      kw = head; params = par;
      if (kw === 'STEP') curStep = { name: par.NAME || `Step ${loadCases.length + 1}`, loads: [] };
      else if (kw === 'END STEP') { if (curStep && curStep.loads.length) loadCases.push(curStep); curStep = null; }
      else if (kw === 'BEAM GENERAL SECTION' || kw === 'BEAM SECTION') pending = { elset: (par.ELSET || '').toUpperCase(), data: [] };
      continue;
    }
    const cells = line.split(',').map(s => s.trim());
    if (kw === 'NODE') nodes.push({ id: +cells[0], x: +cells[1] || 0, y: +cells[2] || 0, z: +cells[3] || 0, restraints: { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 }, mass: null });
    else if (kw === 'ELEMENT') { const ty = (params.TYPE || '').toUpperCase(); if (ty.startsWith('B')) rawMembers.push({ id: +cells[0], ni: +cells[1], nj: +cells[2], elset: (params.ELSET || '').toUpperCase() }); else warnings.push(`Elemento tipo ${ty} no soportado (sólo barras B*)`); }
    else if (pending) pending.data.push(line);
    else if (kw === 'BOUNDARY') { const id = +cells[0], d1 = +cells[1], d2 = +cells[2] || d1; const r = restr.get(id) || { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 }; for (let d = d1; d <= d2 && d <= 6; d++) r[DOF[d - 1]] = 1; restr.set(id, r); }
    else if (kw === 'CLOAD' && curStep) { const id = +cells[0], dof = +cells[1], mag = +cells[2] || 0; let L = curStep.loads.find(l => l.node === id); if (!L) { L = { type: 'nodal', node: id, F: [0, 0, 0, 0, 0, 0] }; curStep.loads.push(L); } if (dof >= 1 && dof <= 6) L.F[dof - 1] += mag; }
  }
  flush();
  if (curStep && curStep.loads.length) loadCases.push(curStep);

  // apply supports to the nodes
  for (const n of nodes) { const r = restr.get(n.id); if (r) n.restraints = r; }

  // types (material+section) per ELSET, in order of appearance
  const typeByElset = new Map(); const materials = [], sections = [];
  const ensureType = (elset) => {
    if (typeByElset.has(elset)) return typeByElset.get(elset);
    const id = materials.length + 1; const p = elsetProps.get(elset) || {};
    materials.push({ id, name: elset || `Mat ${id}`, E: p.E || 2e8, G: p.G || 0, nu: (p.E && p.G) ? Math.max(0, p.E / (2 * p.G) - 1) : 0.2, rho: 0 });
    sections.push({ id, name: elset || `Sec ${id}`, A: p.A || 0, Iz: p.Iz || 0, Iy: p.Iy || 0, J: p.J || 0 });
    typeByElset.set(elset, id); return id;
  };
  const members = rawMembers.map(e => { const t = ensureType(e.elset); return { id: e.id, ni: e.ni, nj: e.nj, mat: t, sec: t, releases: Array(12).fill(0), beta: 0 }; });
  const lcs = loadCases.map((s, i) => ({ id: i + 1, name: s.name, selfWeight: false, type: 'static', loads: s.loads }));

  return { units: { length: 'm', force: 'kN' }, meta: { name: 'Abaqus', source: 'abaqus', warnings }, nodes, materials, sections, members, loadCases: lcs };
}

registerFormat({ id: 'abaqus', name: 'Abaqus / CalculiX (.inp)', ext: 'inp', write, read });
