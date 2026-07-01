// ──────────────────────────────────────────────────────────────────────────────
// io/formats/ndx.js — NODEX (.ndx) adapter · #6 — open→Pro handoff
//
// Serializes the neutral model to the `.ndx` text DSL consumed by the (private)
// **nodex-compiler** layer, which drives the complex analysis (parametric sweeps,
// load sequences, K reuse, multi-step nonlinear, advanced dynamics — the ~32
// `analysis.kind` of the nodex engine). portico-core CONSUMES nodex-compiler (does
// not contain it): this is only the OUTGOING bridge, same pattern as the other
// downstream adapters (opensees.js / abaqus.js / sap2000.js / …). Speaks only the
// NEUTRAL MODEL (`neutral.js`).
//
// GRAMMAR STATUS — the final `.ndx` grammar is being defined on the nodex-compiler
// side (its roadmap step 5). This adapter targets a PROVISIONAL, whitespace-tokenized
// dialect chosen to be (a) lossless for the L1/L2 subset (nodes, supports, materials,
// sections, bars, masses, loads, basic `solve`) and (b) trivially parseable, so the
// export round-trips (see test_ndx.mjs). Details will be reconciled when the grammar
// stabilizes; the advanced `solve <kind>` verbs are emitted as a raw escape hatch.
//
// Units: consistent model units — `model units kN, m`. Every numeric value is emitted
// in those units WITHOUT per-value unit suffixes (E in kN/m², A in m², I in m⁴, ρ and
// nodal mass in t, t/m³), which keeps the deck unambiguous and lossless. Human names
// travel as trailing `# comments`; identifiers are M/S/N/B + id.
// ──────────────────────────────────────────────────────────────────────────────
import { registerFormat } from '../registry.js?v=2';

// Compact, lossless number formatting (same policy as the sibling adapters).
const num = (v) => {
  v = +v || 0;
  if (v === 0) return '0';
  const a = Math.abs(v);
  return (a < 1e-4 || a >= 1e6) ? v.toExponential(6) : String(+v.toPrecision(9));
};

const DOF = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'];
const cmt = (s) => (s ? `   # ${String(s).replace(/\s+/g, ' ').trim()}` : '');

// ── EXPORT ──────────────────────────────────────────────────────────────────────
function write(neutral) {
  const W = neutral.meta.exportWarnings = neutral.meta.exportWarnings || [];
  const L = [];

  L.push('# PORTICO → .ndx  (nodex-compiler handoff)');
  L.push('# Provisional grammar (nodex-compiler roadmap step 5). Values in consistent model units.');
  L.push(`# Source model: ${(neutral.meta && neutral.meta.name) || 'PORTICO'}`);
  L.push('model units kN, m');
  L.push('');

  // ── Materials: E (kN/m²), nu, rho (t/m³) ────────────────────────────────────
  L.push('# materials: E nu rho   (kN/m2, -, t/m3)');
  for (const m of neutral.materials) {
    L.push(`material M${m.id} E=${num(m.E)} nu=${num(m.nu)} rho=${num(m.rho)}${cmt(m.name)}`);
  }
  L.push('');

  // ── Sections: A (m²), Iy Iz J (m⁴) ──────────────────────────────────────────
  L.push('# sections: A Iy Iz J   (m2, m4)');
  for (const s of neutral.sections) {
    let line = `section S${s.id} A=${num(s.A)} Iy=${num(s.Iy)} Iz=${num(s.Iz)} J=${num(s.J)}`;
    if (s.Avy != null) line += ` Avy=${num(s.Avy)}`;
    if (s.Avz != null) line += ` Avz=${num(s.Avz)}`;
    L.push(line + cmt(s.name));
  }
  L.push('');

  // ── Nodes: at (x, y, z) in m ────────────────────────────────────────────────
  L.push('# nodes: at (x, y, z)   (m)');
  for (const n of neutral.nodes) L.push(`node N${n.id} at (${num(n.x)}, ${num(n.y)}, ${num(n.z)})`);
  L.push('');

  // ── Supports: fix <node> ux uy uz rx ry rz   (1 = fixed) ────────────────────
  const fixed = neutral.nodes.filter(n => DOF.some(k => (n.restraints || {})[k]));
  if (fixed.length) {
    L.push('# supports: fix <node> ux uy uz rx ry rz   (1 = fixed)');
    for (const n of fixed) {
      const r = n.restraints || {};
      L.push(`fix N${n.id} ${DOF.map(k => (r[k] ? 1 : 0)).join(' ')}`);
    }
    L.push('');
  }

  // ── Members (bars): beam <name> from <ni> to <nj> mat <M> sec <S> [beta ..] [rel ..] ─
  L.push('# members: beam <name> from <ni> to <nj> mat <M> sec <S> [beta <deg>] [rel <12>]');
  for (const e of neutral.members) {
    let line = `beam B${e.id} from N${e.ni} to N${e.nj} mat M${e.mat} sec S${e.sec}`;
    if (e.beta) line += ` beta ${num(e.beta)}`;
    if ((e.releases || []).some(Boolean)) line += ` rel ${e.releases.map(v => (v ? 1 : 0)).join(',')}`;
    L.push(line);
  }
  L.push('');

  // ── Nodal masses: mass <node> mx my mz   (t) ────────────────────────────────
  const masses = neutral.nodes.filter(n => n.mass);
  if (masses.length) {
    L.push('# nodal masses: mass <node> mx my mz   (t)');
    for (const n of masses) L.push(`mass N${n.id} ${num(n.mass.mx)} ${num(n.mass.my)} ${num(n.mass.mz)}`);
    L.push('');
  }

  // ── Areas (shells): provisional — not part of the L1/L2 bar grammar ─────────
  if (neutral.areas && neutral.areas.length) {
    W.push('.ndx: los elementos de área (shell) usan una sintaxis provisional; revisar al fijar la gramática.');
    L.push('# areas (shell, provisional): shell <name> nodes N.. mat <M> t <thickness> <behavior>');
    for (const a of neutral.areas) {
      const nodes = a.nodes.map(id => `N${id}`).join(' ');
      let line = `shell A${a.id} nodes ${nodes} mat M${a.mat} t ${num(a.thickness)} ${a.behavior || 'membrane'}`;
      if (a.drilling) line += ' drilling';
      if (a.planeStrain) line += ' planeStrain';
      L.push(line);
    }
    L.push('');
  }

  // ── Load cases + loads ──────────────────────────────────────────────────────
  const kinds = new Set();
  for (const lc of (neutral.loadCases || [])) {
    L.push(`case "${lc.name}"${lc.selfWeight ? ' selfweight' : ''}`);
    kinds.add(lc.type === 'spectrum' ? 'spectrum' : 'static');
    for (const ld of (lc.loads || [])) {
      if (ld.type === 'nodal') {
        const F = ld.F || [];
        L.push(`    load N${ld.node} F ${[0, 1, 2, 3, 4, 5].map(i => num(F[i] || 0)).join(' ')}`);
      } else if (ld.type === 'dist') {
        let line = `    line B${ld.member} w ${num(ld.w)}`;
        if (ld.w2 != null && ld.w2 !== ld.w) line += ` w2 ${num(ld.w2)}`;
        line += ` dir ${ld.dir || 'gravity'}`;
        L.push(line);
      }
    }
    L.push('');
  }

  // ── Analysis intent (`solve`) ───────────────────────────────────────────────
  // Derived from the load-case types; advanced kinds (buckling / pushover /
  // nonlinear / direct_dynamics / …) are appended by hand — this is the escape hatch.
  L.push('# analysis (escape hatch for advanced kinds: solve buckling | pushover | nonlinear | ...)');
  if (kinds.has('static') || kinds.size === 0) L.push('solve static');
  if (kinds.has('spectrum')) { L.push('solve modal modes 12'); L.push('solve spectrum'); }

  return L.join('\n') + '\n';
}

// ── IMPORT (parses the subset this adapter emits → round-trip) ──────────────────
function read(text) {
  const warnings = [];
  const nodes = [], materials = [], sections = [], members = [], areas = [];
  const loadCases = [];
  const nodeById = new Map();
  let cur = null;                                   // current load case

  const idOf = (tok) => +String(tok).replace(/^[A-Za-z]+/, '');   // "N12" → 12

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();     // strip comments
    if (!line) continue;
    const t = line.split(/\s+/);
    const kw = t[0];

    if (kw === 'model' || kw === 'solve') continue;  // units / analysis intent: no model change

    if (kw === 'material') {
      const kv = kvPairs(t.slice(2));
      materials.push({ id: idOf(t[1]), name: t[1], E: +kv.E || 0, nu: +kv.nu || 0.3, rho: +kv.rho || 0, G: undefined, alpha: 1e-5 });
    } else if (kw === 'section') {
      const kv = kvPairs(t.slice(2));
      sections.push({ id: idOf(t[1]), name: t[1], A: +kv.A || 0, Iy: +kv.Iy || 0, Iz: +kv.Iz || 0, J: +kv.J || 0, Avy: kv.Avy != null ? +kv.Avy : undefined, Avz: kv.Avz != null ? +kv.Avz : undefined });
    } else if (kw === 'node') {
      // node N1 at (x, y, z)
      const nums = line.match(/\(([^)]*)\)/);
      const [x, y, z] = (nums ? nums[1].split(',') : []).map(v => +v || 0);
      const n = { id: idOf(t[1]), x: x || 0, y: y || 0, z: z || 0, restraints: { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 }, mass: null };
      nodes.push(n); nodeById.set(n.id, n);
    } else if (kw === 'fix') {
      const n = nodeById.get(idOf(t[1])); if (!n) continue;
      DOF.forEach((k, i) => { n.restraints[k] = +t[2 + i] ? 1 : 0; });
    } else if (kw === 'beam') {
      // beam B1 from N1 to N2 mat M1 sec S1 [beta d] [rel a,b,...]
      const g = (key) => { const i = t.indexOf(key); return i >= 0 ? t[i + 1] : null; };
      const relTok = g('rel');
      members.push({
        id: idOf(t[1]), ni: idOf(g('from')), nj: idOf(g('to')),
        mat: idOf(g('mat')), sec: idOf(g('sec')),
        beta: +g('beta') || 0,
        releases: relTok ? relTok.split(',').map(v => +v ? 1 : 0) : Array(12).fill(0),
      });
    } else if (kw === 'mass') {
      const n = nodeById.get(idOf(t[1])); if (!n) continue;
      n.mass = { mx: +t[2] || 0, my: +t[3] || 0, mz: +t[4] || 0 };
    } else if (kw === 'shell') {
      // shell A1 nodes N.. mat M t <thk> <behavior> [drilling] [planeStrain]
      const mi = t.indexOf('mat');
      const ns = t.slice(t.indexOf('nodes') + 1, mi).map(idOf);
      areas.push({ id: idOf(t[1]), nodes: ns, mat: idOf(t[mi + 1]), thickness: +t[t.indexOf('t') + 1] || 0.2, behavior: t[t.indexOf('t') + 2] || 'membrane', drilling: t.includes('drilling'), planeStrain: t.includes('planeStrain') });
    } else if (kw === 'case') {
      const name = (line.match(/"([^"]*)"/) || [, `Case ${loadCases.length + 1}`])[1];
      cur = { id: loadCases.length + 1, name, selfWeight: /\bselfweight\b/.test(line), type: 'static', loads: [] };
      loadCases.push(cur);
    } else if (kw === 'load' && cur) {
      const F = [0, 1, 2, 3, 4, 5].map(i => +t[3 + i] || 0);   // load N<id> F Fx..Mz
      cur.loads.push({ type: 'nodal', node: idOf(t[1]), F });
    } else if (kw === 'line' && cur) {
      const g = (key) => { const i = t.indexOf(key); return i >= 0 ? t[i + 1] : null; };
      cur.loads.push({ type: 'dist', member: idOf(t[1]), w: +g('w') || 0, w2: g('w2') != null ? +g('w2') : undefined, dir: g('dir') || 'gravity' });
    } else {
      warnings.push(`.ndx: línea no reconocida omitida: "${line.slice(0, 60)}"`);
    }
  }

  if (!nodes.length) throw new Error('.ndx: sin nodos (node …)');
  return { units: { length: 'm', force: 'kN' }, meta: { name: 'NODEX', source: 'ndx', warnings }, nodes, materials, sections, members, areas, loadCases };
}

// "E=210" / "A=5.3e-3" → { E:'210', A:'5.3e-3' }
function kvPairs(tokens) {
  const o = {};
  for (const tk of tokens) { const m = tk.match(/^([A-Za-z]+)=(.+)$/); if (m) o[m[1]] = m[2]; }
  return o;
}

registerFormat({ id: 'ndx', name: 'NODEX (.ndx)', ext: 'ndx', write, read });
