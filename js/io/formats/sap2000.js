// ──────────────────────────────────────────────────────────────────────────────
// io/formats/sap2000.js — SAP2000 adapter (.s2k / .$2k) · #74, G18
//
// Reads/writes SAP2000's text TABLE format (`TABLE:  "NAME"` followed by rows of
// `Key=Value` pairs).  PORTICO's subset: joints + supports, materials, frame sections
// (Shape=General → A, I33=Iz, I22=Iy, TorsConst=J), connectivity and section
// assignment, end releases (12 DOF, 1:1 mapping — lossless), and per-pattern nodal
// loads.  Like the other adapters, it speaks only the NEUTRAL MODEL.
//
// A SAP section references ONE material → on export one SAP section is created per
// (material, section) pair in use; on import one material and one section are created
// per SAP section used.  Exchange units: KN, m, C.
// ──────────────────────────────────────────────────────────────────────────────
import { registerFormat } from '../registry.js?v=2';

const G_ACC = 9.80665;   // specific weight = density · g  (UnitWeight ↔ UnitMass)
const RF = ['PI', 'V2I', 'V3I', 'TI', 'M2I', 'M3I', 'PJ', 'V2J', 'V3J', 'TJ', 'M2J', 'M3J'];  // releases (local 12-DOF order)
const num = (v) => { v = +v || 0; if (v === 0) return '0'; const a = Math.abs(v); return (a < 1e-4 || a >= 1e6) ? v.toExponential(6) : String(+v.toPrecision(9)); };
const q = (s) => `"${String(s).replace(/"/g, '')}"`;
const yn = (b) => (b ? 'Yes' : 'No');

// ── EXPORT ────────────────────────────────────────────────────────────────────
function write(neutral) {
  const W = neutral.meta.exportWarnings = neutral.meta.exportWarnings || [];
  const secById = new Map(neutral.sections.map(s => [s.id, s]));
  const matName = new Map(); neutral.materials.forEach((m, i) => matName.set(m.id, `MAT${i + 1}`));

  // (material, section) types used → one SAP section per type
  const typeKey = new Map(); const types = [];
  for (const e of neutral.members) { const k = `${e.mat}|${e.sec}`; if (!typeKey.has(k)) { typeKey.set(k, types.length + 1); types.push({ mat: e.mat, sec: e.sec, name: `SEC${types.length + 1}` }); } }

  for (const lc of (neutral.loadCases || [])) if ((lc.loads || []).some(l => l.type === 'dist')) { W.push('Cargas distribuidas de frame aún no exportadas a SAP2000 (sólo cargas nodales)'); break; }

  const L = [];
  L.push('TABLE:  "PROGRAM CONTROL"');
  L.push(`   ProgramName=SAP2000   Version=24.0.0   CurrUnits="KN, m, C"   ModelName=${q(neutral.meta.name || 'PORTICO')}`);
  L.push('');
  L.push('TABLE:  "JOINT COORDINATES"');
  for (const n of neutral.nodes) L.push(`   Joint=${n.id}   CoordSys=GLOBAL   CoordType=Cartesian   XorR=${num(n.x)}   Y=${num(n.y)}   Z=${num(n.z)}`);
  L.push('');
  const rj = neutral.nodes.filter(n => Object.values(n.restraints || {}).some(v => v));
  if (rj.length) {
    L.push('TABLE:  "JOINT RESTRAINT ASSIGNMENTS"');
    for (const n of rj) { const r = n.restraints; L.push(`   Joint=${n.id}   U1=${yn(r.ux)}   U2=${yn(r.uy)}   U3=${yn(r.uz)}   R1=${yn(r.rx)}   R2=${yn(r.ry)}   R3=${yn(r.rz)}`); }
    L.push('');
  }
  L.push('TABLE:  "MATERIAL PROPERTIES 01 - GENERAL"');
  for (const m of neutral.materials) L.push(`   Material=${q(matName.get(m.id))}   Type=Other   UnitWeight=${num((m.rho || 0) * G_ACC)}   UnitMass=${num(m.rho || 0)}`);
  L.push('');
  L.push('TABLE:  "MATERIAL PROPERTIES 02 - BASIC MECHANICAL PROPERTIES"');
  for (const m of neutral.materials) L.push(`   Material=${q(matName.get(m.id))}   E1=${num(m.E)}   G12=${num(m.G || 0)}   U12=${num(m.nu ?? 0.2)}   A1=${num(m.alpha ?? 1e-5)}`);
  L.push('');
  L.push('TABLE:  "FRAME SECTION PROPERTIES 01 - GENERAL"');
  for (const t of types) { const s = secById.get(t.sec) || {}; L.push(`   SectionName=${q(t.name)}   Material=${q(matName.get(t.mat))}   Shape=General   Area=${num(s.A)}   TorsConst=${num(s.J)}   I33=${num(s.Iz)}   I22=${num(s.Iy)}   AS2=${num(s.Avy || 0)}   AS3=${num(s.Avz || 0)}`); }
  L.push('');
  L.push('TABLE:  "CONNECTIVITY - FRAME"');
  for (const e of neutral.members) L.push(`   Frame=${e.id}   JointI=${e.ni}   JointJ=${e.nj}   IsCurved=No`);
  L.push('');
  L.push('TABLE:  "FRAME SECTION ASSIGNMENTS"');
  for (const e of neutral.members) { const t = typeKey.get(`${e.mat}|${e.sec}`) || 1; L.push(`   Frame=${e.id}   AnalSect=${q(types[t - 1].name)}`); }
  L.push('');
  const relFrames = neutral.members.filter(e => (e.releases || []).some(Boolean));
  if (relFrames.length) {
    L.push('TABLE:  "FRAME RELEASE ASSIGNMENTS 1 - GENERAL"');
    for (const e of relFrames) { const r = e.releases; L.push(`   Frame=${e.id}   ` + RF.map((k, i) => `${k}=${yn(r[i])}`).join('   ')); }
    L.push('');
  }
  const cases = neutral.loadCases || [];
  L.push('TABLE:  "LOAD PATTERN DEFINITIONS"');
  if (cases.length) for (const lc of cases) L.push(`   LoadPat=${q(lc.name)}   DesignType=OTHER   SelfWtMult=${lc.selfWeight ? 1 : 0}`);
  else L.push('   LoadPat="DEAD"   DesignType=DEAD   SelfWtMult=1');
  L.push('');
  const jl = [];
  for (const lc of cases) for (const ld of (lc.loads || [])) if (ld.type === 'nodal') jl.push({ node: ld.node, pat: lc.name, F: ld.F || [] });
  if (jl.length) {
    L.push('TABLE:  "JOINT LOADS - FORCE"');
    for (const j of jl) { const F = j.F; L.push(`   Joint=${j.node}   LoadPat=${q(j.pat)}   CoordSys=GLOBAL   F1=${num(F[0] || 0)}   F2=${num(F[1] || 0)}   F3=${num(F[2] || 0)}   M1=${num(F[3] || 0)}   M2=${num(F[4] || 0)}   M3=${num(F[5] || 0)}`); }
    L.push('');
  }
  L.push('END TABLE DATA');
  return L.join('\n') + '\n';
}

// ── IMPORT ──────────────────────────────────────────────────────────────────
function read(text) {
  const warnings = [];
  const parseRow = (line) => { const o = {}; const re = /([A-Za-z][\w]*)=("[^"]*"|\S+)/g; let m; while ((m = re.exec(line))) { let v = m[2]; if (v[0] === '"') v = v.slice(1, -1); o[m[1]] = v; } return o; };
  const tables = new Map(); let table = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('TABLE:')) { const mm = t.match(/"([^"]+)"/); table = mm ? mm[1] : null; if (table && !tables.has(table)) tables.set(table, []); continue; }
    if (t.startsWith('END TABLE')) { table = null; continue; }
    if (table) tables.get(table).push(parseRow(line));
  }
  const get = (name) => tables.get(name) || [];
  if (!tables.size) throw new Error('SAP2000: no se encontró ninguna TABLE');

  // materials (by name)
  const matByName = new Map();
  for (const r of get('MATERIAL PROPERTIES 02 - BASIC MECHANICAL PROPERTIES')) matByName.set(r.Material, { E: +r.E1 || 0, G: +r.G12 || 0, nu: +r.U12 || 0.2, alpha: +r.A1 || 1e-5, rho: 0 });
  for (const r of get('MATERIAL PROPERTIES 01 - GENERAL')) { const m = matByName.get(r.Material) || { E: 0, G: 0, nu: 0.2, alpha: 1e-5, rho: 0 }; m.rho = +r.UnitMass || (r.UnitWeight ? +r.UnitWeight / G_ACC : 0); matByName.set(r.Material, m); }

  // frame sections (by name)
  const secByName = new Map();
  for (const r of get('FRAME SECTION PROPERTIES 01 - GENERAL')) secByName.set(r.SectionName, { A: +r.Area || 0, Iz: +r.I33 || 0, Iy: +r.I22 || 0, J: +r.TorsConst || 0, Avy: +r.AS2 || 0, Avz: +r.AS3 || 0, mat: r.Material });

  // joints + supports
  const nodes = [], nodeById = new Map();
  for (const r of get('JOINT COORDINATES')) { const n = { id: +r.Joint, x: +(r.XorR ?? r.GlobalX) || 0, y: +(r.Y ?? r.GlobalY) || 0, z: +(r.Z ?? r.GlobalZ) || 0, restraints: { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 }, mass: null }; nodes.push(n); nodeById.set(n.id, n); }
  for (const r of get('JOINT RESTRAINT ASSIGNMENTS')) { const n = nodeById.get(+r.Joint); if (n) n.restraints = { ux: r.U1 === 'Yes' ? 1 : 0, uy: r.U2 === 'Yes' ? 1 : 0, uz: r.U3 === 'Yes' ? 1 : 0, rx: r.R1 === 'Yes' ? 1 : 0, ry: r.R2 === 'Yes' ? 1 : 0, rz: r.R3 === 'Yes' ? 1 : 0 }; }

  // frames: connectivity + section + releases (keyed by the Frame id, string)
  const secAssign = new Map(); for (const r of get('FRAME SECTION ASSIGNMENTS')) secAssign.set(r.Frame, r.AnalSect || r.SectionProperty || r.AnalysisSection);
  const relAssign = new Map(); for (const r of get('FRAME RELEASE ASSIGNMENTS 1 - GENERAL')) relAssign.set(r.Frame, r);

  const typeByName = new Map(); const materials = [], sections = [];
  const ensureType = (secName) => {
    if (typeByName.has(secName)) return typeByName.get(secName);
    const id = sections.length + 1; const sp = secByName.get(secName) || {}; const mp = matByName.get(sp.mat) || {};
    materials.push({ id, name: sp.mat || `Mat ${id}`, E: mp.E || 2e8, G: mp.G || 0, nu: mp.nu ?? 0.2, rho: mp.rho || 0, alpha: mp.alpha ?? 1e-5 });
    sections.push({ id, name: secName || `Sec ${id}`, A: sp.A || 0, Iz: sp.Iz || 0, Iy: sp.Iy || 0, J: sp.J || 0, Avy: sp.Avy, Avz: sp.Avz });
    typeByName.set(secName, id); return id;
  };
  const members = [];
  for (const r of get('CONNECTIVITY - FRAME')) {
    const sn = secAssign.get(r.Frame); const t = ensureType(sn);
    const rr = relAssign.get(r.Frame);
    const releases = rr ? RF.map(k => (rr[k] === 'Yes' ? 1 : 0)) : Array(12).fill(0);
    members.push({ id: +r.Frame, ni: +r.JointI, nj: +r.JointJ, mat: t, sec: t, releases, beta: 0 });
  }

  // load patterns + nodal loads
  const lcByPat = new Map(); const loadCases = [];
  for (const r of get('LOAD PATTERN DEFINITIONS')) { const lc = { id: loadCases.length + 1, name: r.LoadPat, selfWeight: (+r.SelfWtMult || 0) > 0, type: 'static', loads: [] }; lcByPat.set(r.LoadPat, lc); loadCases.push(lc); }
  for (const r of get('JOINT LOADS - FORCE')) {
    let lc = lcByPat.get(r.LoadPat);
    if (!lc) { lc = { id: loadCases.length + 1, name: r.LoadPat || 'DEAD', selfWeight: false, type: 'static', loads: [] }; lcByPat.set(r.LoadPat, lc); loadCases.push(lc); }
    lc.loads.push({ type: 'nodal', node: +r.Joint, F: [+r.F1 || 0, +r.F2 || 0, +r.F3 || 0, +r.M1 || 0, +r.M2 || 0, +r.M3 || 0] });
  }
  // patterns without nodal loads do not contribute to the PORTICO model (kept as is)

  if (!nodes.length) throw new Error('SAP2000: sin juntas (JOINT COORDINATES)');
  return { units: { length: 'm', force: 'kN' }, meta: { name: 'SAP2000', source: 'sap2000', warnings }, nodes, materials, sections, members, loadCases };
}

registerFormat({ id: 'sap2000', name: 'SAP2000 (.s2k)', ext: 's2k', write, read });
