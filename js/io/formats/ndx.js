// ──────────────────────────────────────────────────────────────────────────────
// io/formats/ndx.js — NODEX (.ndx) adapter · open→Pro handoff
//
// Bridges the neutral model ↔ the `.ndx` text DSL of the nodex engine family
// (compiled by nodex-compiler). Speaks only the NEUTRAL MODEL (`neutral.js`).
//
// GRAMMAR — this adapter now targets the ACTUAL nodex authoring grammar (the one
// documented by the engine's `dsl_syntax`/`ndx_reference`, not the old provisional
// portico dialect). Both directions are aligned so a deck exported here is valid
// nodex, and a deck the nodex agent writes imports back with its supports and loads
// (not just geometry). Covered subset (authoring / round-trip):
//   material <name> E=<v> <unit>, nu=<v>, rho=<v> <unit>   | material <name> grade <G>
//   section  <name> profile <PROF>                          | section <name> A=.. <u>, Iy=.. <u>, Iz=.. <u>, J=.. <u>
//   node <name> at (x,y,z)                                  | column <name> at (x,y) height <H> <mat> <sec>
//   beam <name> from <a> to <b> <mat> <sec> [div N] [pin i|j|both]
//   fix (coord)|<node>                                      | support (coord)|<node> <dof…>
//   mass <name> at (coord) mx=.. …
//   load <case> nodal <node> fx=.. …                        | load <case> line <w>[ <u>] on <members>  | line <w1> to <w2> on <m>
//   solve <kind> …   (emitted as an escape-hatch line; ignored on import)
// NOT yet covered (import warns, never silently drops): slabs/walls/areas/solids,
// cables/arches, combinations, prescribed disp, springs, temperature/pressure loads.
//
// AXIS CONVENTION — nodex and the portico neutral model BOTH use Iz = STRONG (major)
// and Iy = WEAK (minor). Properties map straight across; never transpose them.
//
// UNITS — the model header is `model units kN, m`. nodex carries per-value unit
// suffixes (GPa, cm2, cm4, t/m3, kN, kN/m); we convert to/from consistent kN·m here.
// ──────────────────────────────────────────────────────────────────────────────
import { registerFormat } from '../registry.js?v=2';
import { profileToSection } from '../../design/profiles.js?v=2';

// Compact, lossless number formatting (same policy as the sibling adapters).
const num = (v) => {
  v = +v || 0;
  if (v === 0) return '0';
  const a = Math.abs(v);
  return (a < 1e-4 || a >= 1e6) ? v.toExponential(6) : String(+v.toPrecision(9));
};

const DOF = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'];
const cmt = (s) => (s ? `   // ${String(s).replace(/\s+/g, ' ').trim()}` : '');

// ── Unit conversion to consistent model units (kN, m) ─────────────────────────
const STRESS = { gpa: 1e6, mpa: 1e3, kpa: 1, pa: 1e-3, 'kn/m2': 1, 'n/m2': 1e-3, 'n/mm2': 1e3 };   // → kN/m²
const AREA   = { m2: 1, cm2: 1e-4, mm2: 1e-6 };                                                     // → m²
const INER   = { m4: 1, cm4: 1e-8, mm4: 1e-12 };                                                    // → m⁴
const DENS   = { 't/m3': 1, 'kg/m3': 1e-3 };                                                        // → t/m³
const FORCE  = { kn: 1, n: 1e-3, mn: 1e3, kgf: 9.80665e-3, tf: 9.80665 };                           // → kN
const conv = (table, v, unit) => v * (table[String(unit || '').toLowerCase()] ?? 1);

// ── EXPORT ────────────────────────────────────────────────────────────────────
function write(neutral) {
  const W = neutral.meta.exportWarnings = neutral.meta.exportWarnings || [];
  const L = [];

  L.push('// PORTICO → .ndx  (nodex authoring grammar)');
  L.push(`// Source model: ${(neutral.meta && neutral.meta.name) || 'PORTICO'}`);
  L.push('model units kN, m');
  L.push('');

  // Materials: E in GPa, rho in t/m³. Identifier m<id>; human name as a comment.
  for (const m of neutral.materials) {
    const E = (+m.E || 0) / STRESS.gpa;   // kN/m² → GPa
    L.push(`material m${m.id} E=${num(E)} GPa, nu=${num(m.nu != null ? m.nu : 0.3)}, rho=${num(m.rho || 0)} t/m3${cmt(m.name)}`);
  }
  L.push('');

  // Sections: A in cm², Iy/Iz/J in cm⁴ (Iz strong — same as nodex). Identifier s<id>.
  for (const s of neutral.sections) {
    L.push(`section s${s.id} A=${num((+s.A || 0) / AREA.cm2)} cm2, Iy=${num((+s.Iy || 0) / INER.cm4)} cm4, Iz=${num((+s.Iz || 0) / INER.cm4)} cm4, J=${num((+s.J || 0) / INER.cm4)} cm4${cmt(s.name)}`);
  }
  L.push('');

  // Nodes
  for (const n of neutral.nodes) L.push(`node N${n.id} at (${num(n.x)}, ${num(n.y)}, ${num(n.z)})`);
  L.push('');

  // Supports: full → `fix`, partial → `support <dofs>`
  for (const n of neutral.nodes) {
    const r = n.restraints || {};
    const on = DOF.filter((k) => r[k]);
    if (on.length === 6) L.push(`fix N${n.id}`);
    else if (on.length) L.push(`support N${n.id} ${on.join(' ')}`);
  }
  L.push('');

  // Members (bars): `beam B<id> from N.. to N.. m<mat> s<sec> [pin ..]`
  for (const e of neutral.members) {
    let line = `beam B${e.id} from N${e.ni} to N${e.nj} m${e.mat} s${e.sec}`;
    const rel = e.releases || [];
    const i = rel.slice(0, 6).some(Boolean), j = rel.slice(6, 12).some(Boolean);
    if (i && j) line += ' pin both'; else if (i) line += ' pin i'; else if (j) line += ' pin j';
    L.push(line);
  }
  L.push('');

  // Nodal masses
  const masses = neutral.nodes.filter((n) => n.mass);
  for (const n of masses) {
    const m = n.mass;
    const f = ['mx', 'my', 'mz'].filter((k) => m[k]).map((k) => `${k}=${num(m[k])}`).join(' ');
    if (f) L.push(`mass MS${n.id} at (${num(n.x)}, ${num(n.y)}, ${num(n.z)}) ${f}`);
  }
  if (masses.length) L.push('');

  // Loads, grouped by case id (nodex references case ids inline; no `case` verb).
  const kinds = new Set();
  for (const lc of (neutral.loadCases || [])) {
    kinds.add(lc.type === 'spectrum' ? 'spectrum' : 'static');
    if (lc.name) L.push(`// case ${lc.id}: ${lc.name}${lc.selfWeight ? ' (selfweight)' : ''}`);
    for (const ld of (lc.loads || [])) {
      if (ld.type === 'nodal') {
        const F = ld.F || [];
        const comps = ['fx', 'fy', 'fz', 'mx', 'my', 'mz'].map((k, i) => (F[i] ? `${k}=${num(F[i])}` : null)).filter(Boolean).join(' ');
        if (comps) L.push(`load ${lc.id} nodal N${ld.node} ${comps}`);
      } else if (ld.type === 'dist') {
        let line = (ld.w2 != null && ld.w2 !== ld.w)
          ? `load ${lc.id} line ${num(ld.w)} to ${num(ld.w2)} on B${ld.member}`
          : `load ${lc.id} line ${num(ld.w)} on B${ld.member}`;
        if (ld.dir && ld.dir !== 'gravity') line += ` dir ${ld.dir}`;
        L.push(line);
      }
    }
  }
  L.push('');

  // Analysis intent (escape hatch; ignored on import — portico decides its own runs).
  if (kinds.has('static') || kinds.size === 0) L.push('solve linear_static');
  if (kinds.has('spectrum')) { L.push('solve modal modes 12'); L.push('solve spectrum'); }

  if ((neutral.areas || []).length) W.push('.ndx: los elementos de área (shell/slab/solid) aún no se exportan a la gramática nodex; se omitieron.');

  return L.join('\n') + '\n';
}

// ── IMPORT ──────────────────────────────────────────────────────────────────
// Parse `key=value [unit]` fields separated by commas (or spaces): E=210 GPa, nu=0.3
function parseFields(s) {
  const out = {};
  for (const part of String(s).split(',')) {
    const m = part.trim().match(/^([A-Za-z]\w*)\s*=\s*([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s*(\S+)?$/);
    if (m) out[m[1]] = { v: +m[2], unit: m[3] || '' };
  }
  return out;
}
const coordsIn = (line) => { const m = line.match(/\(([^)]*)\)/); return m ? m[1].split(',').map((v) => +v || 0) : null; };
const gradeProps = (g) => {
  const G = String(g).toUpperCase();
  if (/^S\d/.test(G) || /STEEL/.test(G)) return { E: 2.1e8, nu: 0.3, rho: 7.85 };
  if (/^C\d/.test(G) || /CONCRETE|HORMIG/.test(G)) return { E: 3.0e7, nu: 0.2, rho: 2.5 };
  if (/^(GL|C1|C2|D\d)/.test(G) || /TIMBER|MADERA|PINO/.test(G)) return { E: 1.1e7, nu: 0.3, rho: 0.5 };
  return null;
};

function read(text) {
  const warnings = [];
  const nodes = [], materials = [], sections = [], members = [], areas = [];
  const loadCases = [];
  const matByName = new Map(), secByName = new Map(), nodeByName = new Map(), nodeByCoord = new Map(), memByName = new Map();
  const caseById = new Map();
  let nId = 0, mId = 0, sId = 0, bId = 0;

  const key = (x, y, z) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
  function nodeAt(x, y, z) {
    const k = key(x, y, z);
    if (nodeByCoord.has(k)) return nodeByCoord.get(k);
    const n = { id: ++nId, x, y, z, restraints: { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 }, mass: null };
    nodes.push(n); nodeByCoord.set(k, n); return n;
  }
  const caseOf = (id) => {
    id = String(id);
    if (!caseById.has(id)) { const c = { id: caseById.size + 1, name: `Caso ${id}`, selfWeight: false, type: 'static', loads: [] }; caseById.set(id, c); loadCases.push(c); }
    return caseById.get(id);
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').replace(/#.*$/, '').trim();   // strip // and # comments
    if (!line) continue;
    const t = line.split(/\s+/);
    const kw = t[0];

    if (kw === 'model' || kw === 'solve' || kw === 'combination' || kw === 'spectrum' || kw === 'accelerogram') continue;

    if (kw === 'material') {
      const name = t[1];
      let E = 0, nu = 0.3, rho = 0;
      if (t[2] === 'grade') { const p = gradeProps(t[3]); if (p) ({ E, nu, rho } = p); else warnings.push(`.ndx: grade desconocido "${t[3]}" en material ${name} — usé acero por defecto.`), (E = 2.1e8); }
      else { const f = parseFields(line.replace(/^material\s+\S+\s*/, '')); if (f.E) E = conv(STRESS, f.E.v, f.E.unit); if (f.nu) nu = f.nu.v; if (f.rho) rho = conv(DENS, f.rho.v, f.rho.unit); }
      const m = { id: ++mId, name, E, nu, rho, alpha: 1e-5 };
      materials.push(m); matByName.set(name, m);
    } else if (kw === 'section') {
      const name = t[1];
      let sec;
      if (t[2] === 'profile') {
        try { const p = profileToSection(t[3]); sec = { id: ++sId, name, A: p.A, Iy: p.Iy, Iz: p.Iz, J: p.J }; }
        catch { warnings.push(`.ndx: perfil desconocido "${t[3]}" en section ${name} — omitida.`); continue; }
      } else {
        const f = parseFields(line.replace(/^section\s+\S+\s*/, ''));
        sec = { id: ++sId, name, A: f.A ? conv(AREA, f.A.v, f.A.unit) : 0, Iy: f.Iy ? conv(INER, f.Iy.v, f.Iy.unit) : 0, Iz: f.Iz ? conv(INER, f.Iz.v, f.Iz.unit) : 0, J: f.J ? conv(INER, f.J.v, f.J.unit) : 0 };
      }
      sections.push(sec); secByName.set(name, sec);
    } else if (kw === 'node') {
      const [x, y, z] = coordsIn(line) || [0, 0, 0];
      const n = nodeAt(x, y, z); nodeByName.set(t[1], n);
    } else if (kw === 'column') {
      // column <name> at (x,y) height <H> <mat> <sec>
      const c = coordsIn(line) || [0, 0]; const hi = t.indexOf('height'); const H = hi >= 0 ? +t[hi + 1] || 0 : 0;
      const base = nodeAt(c[0], c[1], 0), top = nodeAt(c[0], c[1], H);
      nodeByName.set(t[1], base); nodeByName.set(`${t[1]}.bot`, base); nodeByName.set(`${t[1]}.top`, top);
      const mat = matByName.get(t[hi + 2]), sec = secByName.get(t[hi + 3]);
      const mem = { id: ++bId, name: t[1], ni: base.id, nj: top.id, mat: mat ? mat.id : 0, sec: sec ? sec.id : 0, beta: 0, releases: Array(12).fill(0) };
      members.push(mem); memByName.set(t[1], mem);
    } else if (kw === 'beam') {
      const iTo = t.indexOf('to');
      const a = nodeByName.get(t[t.indexOf('from') + 1]), b = nodeByName.get(t[iTo + 1]);
      if (!a || !b) { warnings.push(`.ndx: beam ${t[1]} referencia un nodo no definido — omitida.`); continue; }
      const mat = matByName.get(t[iTo + 2]), sec = secByName.get(t[iTo + 3]);
      const rel = Array(12).fill(0); const pi = t.indexOf('pin');
      if (pi >= 0) { const w = t[pi + 1]; if (w === 'i' || w === 'both') for (let k = 3; k < 6; k++) rel[k] = 1; if (w === 'j' || w === 'both') for (let k = 9; k < 12; k++) rel[k] = 1; }
      const mem = { id: ++bId, name: t[1], ni: a.id, nj: b.id, mat: mat ? mat.id : 0, sec: sec ? sec.id : 0, beta: 0, releases: rel };
      members.push(mem); memByName.set(t[1], mem);
    } else if (kw === 'fix' || kw === 'support') {
      const c = coordsIn(line);
      const n = c ? nodeAt(c[0], c[1] ?? 0, c[2] ?? 0) : nodeByName.get(t[1]);
      if (!n) { warnings.push(`.ndx: ${kw} referencia un nodo/coord no definido — omitido.`); continue; }
      if (kw === 'fix') DOF.forEach((k) => { n.restraints[k] = 1; });
      else t.slice(c ? 0 : 2).filter((tk) => DOF.includes(tk)).forEach((k) => { n.restraints[k] = 1; });
    } else if (kw === 'mass') {
      const c = coordsIn(line); const n = c ? nodeAt(c[0], c[1] ?? 0, c[2] ?? 0) : nodeByName.get(t[1]);
      if (!n) continue; const f = parseFields(line.replace(/^mass\s+\S+\s+at\s*\([^)]*\)\s*/, ''));
      n.mass = { mx: f.mx ? f.mx.v : 0, my: f.my ? f.my.v : 0, mz: f.mz ? f.mz.v : 0 };
    } else if (kw === 'load') {
      const c = caseOf(t[1]);
      if (t[2] === 'nodal') {
        const n = nodeByName.get(t[3]); if (!n) { warnings.push(`.ndx: load nodal a nodo no definido "${t[3]}" — omitida.`); continue; }
        const f = parseFields(line.replace(/^load\s+\S+\s+nodal\s+\S+\s*/, ''));
        const F = ['fx', 'fy', 'fz', 'mx', 'my', 'mz'].map((k) => f[k] ? conv(FORCE, f[k].v, f[k].unit) : 0);
        c.loads.push({ type: 'nodal', node: n.id, F });
      } else if (t[2] === 'line') {
        // load <c> line <w> [unit] [to <w2>] on <members>
        const onI = t.indexOf('on'); if (onI < 0) { warnings.push(`.ndx: load line sin 'on' — omitida.`); continue; }
        const toI = t.indexOf('to');
        const w = +t[3] || 0; const w2 = (toI > 0 && toI < onI) ? (+t[toI + 1] || 0) : null;
        const dirI = t.indexOf('dir'); const dir = dirI > onI ? t[dirI + 1] : 'gravity';
        const memTokens = t.slice(onI + 1, dirI > onI ? dirI : undefined).join(' ').split(',').map((s) => s.trim()).filter(Boolean);
        for (const mt of memTokens) { const mem = memByName.get(mt); if (mem) c.loads.push({ type: 'dist', member: mem.id, w, w2: w2 != null && w2 !== w ? w2 : undefined, dir }); else warnings.push(`.ndx: load line sobre miembro no definido "${mt}" — omitida.`); }
      }
    } else if (kw === 'slab' || kw === 'wall' || kw === 'area' || kw === 'solid') {
      warnings.push(`.ndx: '${kw}' (superficie/sólido) aún no se importa — omitido.`);
    } else if (['cable', 'arch', 'spring', 'diaphragm', 'bolt', 'weld', 'contact', 'rigid', 'couple', 'link', 'prescribe', 'hinge', 'nonlinear', 'fiber', 'usermat', 'uel'].includes(kw)) {
      warnings.push(`.ndx: '${kw}' aún no se importa — omitido.`);
    } else {
      warnings.push(`.ndx: línea no reconocida omitida: "${line.slice(0, 60)}"`);
    }
  }

  if (!nodes.length) throw new Error('.ndx: sin nodos (node …)');
  return { units: { length: 'm', force: 'kN' }, meta: { name: 'NODEX', source: 'ndx', warnings }, nodes, materials, sections, members, areas, loadCases };
}

registerFormat({ id: 'ndx', name: 'NODEX (.ndx)', ext: 'ndx', write, read });
