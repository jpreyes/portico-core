// test_ndx.mjs — NODEX (.ndx) exporter (#6): open→Pro handoff.
//
//  A) The adapter is registered and reachable through the same io API.
//  B) The emitted deck carries the provisional grammar tokens (model/material/section/
//     node/fix/beam/mass/case/load/line/solve).
//  C) Round-trip model → .ndx → model preserves geometry, connectivity, section /
//     material properties, supports, nodal loads, distributed loads, end releases and
//     nodal mass (values in consistent kN, m, t units).
import { Model } from './js/model/model.js';
import { exportModel, importModel, listFormats } from './js/io/index.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };

// ── test model: 2-bay portal frame, 2 materials / 2 sections, fixed bases, a beam
//    with an end release, a nodal mass, a self-weight static case (nodal + dist load)
//    and a spectrum case (to exercise `solve modal` / `solve spectrum`). ────────────
function buildModel() {
  const m = new Model(); m.materials.clear(); m.sections.clear();
  // G set to E/(2(1+nu)) so the derived G after round-trip matches (the .ndx material
  // is E/nu/rho, like the provisional grammar — G is recomputed on import).
  const steel = m.addMaterial({ name: 'Acero A36', E: 2.1e8, G: 2.1e8 / 2.6, nu: 0.3, rho: 7.85 });
  const conc  = m.addMaterial({ name: 'Hormigon G25', E: 2.5e7, G: 2.5e7 / 2.4, nu: 0.2, rho: 2.5 });
  const col  = m.addSection({ name: 'Col 40x40', A: 0.16, Iz: 2.133e-3, Iy: 2.133e-3, J: 3.6e-3 });
  const beam = m.addSection({ name: 'IPE300', A: 5.38e-3, Iz: 6.04e-6, Iy: 8.36e-5, J: 2.01e-7 });
  const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const n2 = m.addNode(0, 0, 4);
  const n3 = m.addNode(6, 0, 4);
  const n4 = m.addNode(6, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  m.addElement(n1.id, n2.id, conc.id, col.id);           // column (concrete)
  const vig = m.addElement(n2.id, n3.id, steel.id, beam.id); // beam (steel)
  m.addElement(n4.id, n3.id, conc.id, col.id);           // column (concrete)
  const rel = Array(12).fill(0); rel[11] = 1;            // release rz at end j of the beam
  m.updateElement(vig.id, { releases: rel });
  m.updateNode(n3.id, { nodeMass: { mx: 1.2, my: 1.2, mz: 0 } });
  const lc = m.addLoadCase('Dead', true, 'static');
  m.addLoad(lc.id, { type: 'nodal', nodeId: n2.id, F: [50, 0, -10, 0, 0, 0] });
  m.addLoad(lc.id, { type: 'dist', elemId: vig.id, w: -10, dir: 'gravity' });
  m.addLoadCase('Sismo', false, 'spectrum');
  return m;
}

const byXYZ = (mm, x, y, z) => [...mm.nodes.values()].find(n => Math.abs(n.x - x) < 1e-6 && Math.abs(n.y - y) < 1e-6 && Math.abs(n.z - z) < 1e-6);

// ── A) registration ─────────────────────────────────────────────────────────────
console.log('\n── A) adaptador registrado ──────────────────────────────');
ok(listFormats().some(f => f.id === 'ndx'), 'NODEX (.ndx) registrado en el registry');

// ── B) grammar tokens present ────────────────────────────────────────────────────
console.log('\n── B) tokens de la gramática provisional ────────────────');
const { text } = exportModel(buildModel(), 'ndx');
const has = (t, label) => ok(text.includes(t), `emite «${label}»`);
has('model units kN, m', 'model units');
has('material M1 E=', 'material');
has('section S1 A=', 'section');
has('node N1 at (', 'node at (x,y,z)');
has('fix N1 1 1 1 1 1 1', 'fix (empotrado 6 GDL)');
has('beam B', 'beam from/to');
ok(/beam B\d+ .*rel 0,0,0,0,0,0,0,0,0,0,0,1/.test(text), 'liberación de extremo en el deck (rel …,1)');
has('mass N', 'nodal mass');
has('case "Dead" selfweight', 'case selfweight');
ok(/load N\d+ F 50 0 -10 0 0 0/.test(text), 'carga nodal F Fx..Mz');
ok(/line B\d+ w -10 dir gravity/.test(text), 'carga distribuida line w dir');
has('solve static', 'solve static');
has('solve modal modes', 'solve modal (por caso spectrum)');
has('solve spectrum', 'solve spectrum');

// ── C) round-trip model → .ndx → model ───────────────────────────────────────────
console.log('\n── C) round-trip model → .ndx → model ───────────────────');
const m0 = buildModel();
const deck = exportModel(m0, 'ndx').text;
const { model: m1 } = importModel(deck, 'ndx');

ok(m1.nodes.size === m0.nodes.size, `nº de nodos (${m1.nodes.size} = ${m0.nodes.size})`);
ok(m1.elements.size === m0.elements.size, `nº de barras (${m1.elements.size} = ${m0.elements.size})`);

// coordinates
let maxd = 0; for (const n of m0.nodes.values()) { const q = byXYZ(m1, n.x, n.y, n.z); maxd = Math.max(maxd, q ? 0 : 1); }
ok(maxd === 0, 'coordenadas de todos los nodos preservadas');

// supports
const b1 = byXYZ(m1, 0, 0, 0), r = b1.restraints;
ok(r.ux && r.uy && r.uz && r.rx && r.ry && r.rz, 'base (0,0,0) sigue empotrada (6 GDL)');
ok(Object.values(byXYZ(m1, 0, 0, 4).restraints).every(v => !v), 'nodo superior sigue libre');

// connectivity + section/material by connectivity
const key = (mm, e) => { const a = mm.nodes.get(e.n1), b = mm.nodes.get(e.n2); const p = q => `${+q.x.toFixed(4)},${+q.y.toFixed(4)},${+q.z.toFixed(4)}`; return [p(a), p(b)].sort().join('|'); };
const m1ByConn = new Map(); for (const e of m1.elements.values()) m1ByConn.set(key(m1, e), e);
let okSec = true, okMat = true;
for (const e of m0.elements.values()) {
  const q = m1ByConn.get(key(m0, e)); if (!q) { okSec = false; continue; }
  const sa = m0.sections.get(e.secId), sb = m1.sections.get(q.secId);
  const ma = m0.materials.get(e.matId), mb = m1.materials.get(q.matId);
  if (Math.max(Math.abs(sa.A - sb.A), Math.abs(sa.Iz - sb.Iz), Math.abs(sa.Iy - sb.Iy), Math.abs(sa.J - sb.J)) > 1e-9 * Math.max(1, sa.A)) okSec = false;
  if (Math.abs(ma.E - mb.E) > 1e-3 * ma.E || Math.abs(ma.G - mb.G) > 2e-3 * Math.max(1, ma.G)) okMat = false;
}
ok(okSec, 'A/Iy/Iz/J + conectividad por barra preservados');
ok(okMat, 'E y G (derivado de E,ν) por barra preservados');

// end release survives (beam: both nodes at z=4)
const vig1 = [...m1.elements.values()].find(e => { const a = m1.nodes.get(e.n1), b = m1.nodes.get(e.n2); return Math.abs(a.z - 4) < 1e-9 && Math.abs(b.z - 4) < 1e-9; });
ok(vig1 && vig1.releases.some(Boolean), `liberación de extremo preservada (rel=[${vig1 ? vig1.releases.join('') : '—'}])`);

// nodal mass survives
const nm = byXYZ(m1, 6, 0, 4);
ok(nm && nm.nodeMass && Math.abs(nm.nodeMass.mx - 1.2) < 1e-9 && Math.abs(nm.nodeMass.my - 1.2) < 1e-9, `masa nodal preservada (mx=${nm && nm.nodeMass ? nm.nodeMass.mx : '—'})`);

// loads survive
let nLoad = 0, dLoad = 0;
for (const lc of m1.loadCases.values()) for (const l of (lc.loads || [])) { if (l.type === 'nodal') nLoad++; if (l.type === 'dist') dLoad++; }
ok(nLoad === 1, `carga nodal preservada (${nLoad})`);
ok(dLoad === 1, `carga distribuida preservada (${dLoad})`);
const dead = [...m1.loadCases.values()].find(c => c.name === 'Dead');
ok(dead && dead.selfWeight, 'caso "Dead" conserva self-weight');

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
