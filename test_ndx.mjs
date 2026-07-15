// test_ndx.mjs — NODEX (.ndx) adapter round-trip (nodex authoring grammar).
//
//  A) The adapter is registered and reachable through the same io API.
//  B) The emitted deck uses the ACTUAL nodex grammar tokens (units-suffixed material/
//     section, fix/support, beam m/s + pin, nodal/line loads, solve).
//  C) Round-trip model → .ndx → model preserves geometry, connectivity, section /
//     material properties (through the unit conversions), supports, nodal loads,
//     distributed + trapezoidal loads, end releases and nodal mass.
//  D) Import of a hand-written nodex deck (named mat/sec, units, profile, partial
//     support, line load) yields physically correct values in kN·m.
import { Model } from './js/model/model.js';
import { exportModel, importModel, listFormats } from './js/io/index.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };

// ── test model: 2-bay portal frame, 2 materials / 2 sections, fixed bases, a beam
//    with an end release, a nodal mass, a self-weight static case (nodal + dist +
//    trapezoidal loads) and a spectrum case. ─────────────────────────────────────
function buildModel() {
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const steel = m.addMaterial({ name: 'Acero A36', E: 2.1e8, nu: 0.3, rho: 7.85 });
  const conc  = m.addMaterial({ name: 'Hormigon G25', E: 2.5e7, nu: 0.2, rho: 2.5 });
  const col  = m.addSection({ name: 'Col 40x40', A: 0.16, Iz: 2.133e-3, Iy: 2.133e-3, J: 3.6e-3 });
  const beam = m.addSection({ name: 'IPE300', A: 5.38e-3, Iz: 8.36e-5, Iy: 6.04e-6, J: 2.01e-7 });
  const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const n2 = m.addNode(0, 0, 4);
  const n3 = m.addNode(6, 0, 4);
  const n4 = m.addNode(6, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const col1 = m.addElement(n1.id, n2.id, conc.id, col.id);  // column (concrete)
  const vig = m.addElement(n2.id, n3.id, steel.id, beam.id);  // beam (steel)
  m.addElement(n4.id, n3.id, conc.id, col.id);                // column (concrete)
  const rel = Array(12).fill(0); rel[9] = rel[10] = rel[11] = 1;   // pin end j of the beam
  m.updateElement(vig.id, { releases: rel });
  m.updateNode(n3.id, { nodeMass: { mx: 1.2, my: 1.2, mz: 0 } });
  const lc = m.addLoadCase('Dead', true, 'static');
  m.addLoad(lc.id, { type: 'nodal', nodeId: n2.id, F: [50, 0, -10, 0, 0, 0] });
  m.addLoad(lc.id, { type: 'dist', elemId: vig.id, w: -10, dir: 'gravity' });            // uniform
  m.addLoad(lc.id, { type: 'dist', elemId: col1.id, w: -8, w2: -4, dir: 'globalX' });    // trapezoidal, non-gravity dir
  m.addLoadCase('Sismo', false, 'spectrum');
  return m;
}

const byXYZ = (mm, x, y, z) => [...mm.nodes.values()].find(n => Math.abs(n.x - x) < 1e-6 && Math.abs(n.y - y) < 1e-6 && Math.abs(n.z - z) < 1e-6);

// ── A) registration ─────────────────────────────────────────────────────────────
console.log('\n── A) adaptador registrado ──────────────────────────────');
ok(listFormats().some(f => f.id === 'ndx'), 'NODEX (.ndx) registrado en el registry');

// ── B) grammar tokens present (nodex authoring grammar) ───────────────────────────
console.log('\n── B) tokens de la gramática nodex ──────────────────────');
const { text, warnings: expW } = exportModel(buildModel(), 'ndx');
const has = (t, label) => ok(text.includes(t), `emite «${label}»`);
has('model units kN, m', 'model units');
ok(/material m\d+ E=\S+ GPa, nu=\S+, rho=\S+ t\/m3/.test(text), 'material con E [GPa], ν, ρ [t/m3]');
ok(/section s\d+ A=\S+ cm2, Iy=\S+ cm4, Iz=\S+ cm4, J=\S+ cm4/.test(text), 'section con A [cm2], Iy/Iz/J [cm4]');
has('node N1 at (', 'node at (x,y,z)');
has('fix N1', 'fix (empotrado)');
ok(/beam B\d+ from N\d+ to N\d+ m\d+ s\d+/.test(text), 'beam from/to m/s');
ok(/beam B\d+ .* pin j/.test(text), 'liberación de extremo (pin j)');
ok(/mass MS\d+ at \(/.test(text), 'masa nodal');
ok(/load 1 nodal N\d+ fx=50 fz=-10/.test(text), 'carga nodal fx/fz');
ok(/load 1 line -10 on B\d+/.test(text), 'carga distribuida uniforme (line … on)');
ok(/load 1 line -8 to -4 on B\d+ dir globalX/.test(text), 'carga trapecial (w1 to w2) + dir no-gravedad');
has('solve linear_static', 'solve linear_static');

// ── C) round-trip model → .ndx → model ───────────────────────────────────────────
console.log('\n── C) round-trip model → .ndx → model ───────────────────');
const m0 = buildModel();
const deck = exportModel(m0, 'ndx').text;
const { model: m1 } = importModel(deck, 'ndx');

ok(m1.nodes.size === m0.nodes.size, `nº de nodos (${m1.nodes.size} = ${m0.nodes.size})`);
ok(m1.elements.size === m0.elements.size, `nº de barras (${m1.elements.size} = ${m0.elements.size})`);

let maxd = 0; for (const n of m0.nodes.values()) { const q = byXYZ(m1, n.x, n.y, n.z); maxd = Math.max(maxd, q ? 0 : 1); }
ok(maxd === 0, 'coordenadas de todos los nodos preservadas');

const b1 = byXYZ(m1, 0, 0, 0), r = b1.restraints;
ok(r.ux && r.uy && r.uz && r.rx && r.ry && r.rz, 'base (0,0,0) sigue empotrada (6 GDL)');
ok(Object.values(byXYZ(m1, 0, 0, 4).restraints).every(v => !v), 'nodo superior sigue libre');

const key = (mm, e) => { const a = mm.nodes.get(e.n1), b = mm.nodes.get(e.n2); const p = q => `${+q.x.toFixed(4)},${+q.y.toFixed(4)},${+q.z.toFixed(4)}`; return [p(a), p(b)].sort().join('|'); };
const m1ByConn = new Map(); for (const e of m1.elements.values()) m1ByConn.set(key(m1, e), e);
let okSec = true, okMat = true;
for (const e of m0.elements.values()) {
  const q = m1ByConn.get(key(m0, e)); if (!q) { okSec = false; continue; }
  const sa = m0.sections.get(e.secId), sb = m1.sections.get(q.secId);
  const ma = m0.materials.get(e.matId), mb = m1.materials.get(q.matId);
  if (Math.max(Math.abs(sa.A - sb.A), Math.abs(sa.Iz - sb.Iz), Math.abs(sa.Iy - sb.Iy), Math.abs(sa.J - sb.J)) > 1e-9 * Math.max(1, sa.A)) okSec = false;
  if (Math.abs(ma.E - mb.E) > 1e-3 * ma.E) okMat = false;
}
ok(okSec, 'A/Iy/Iz/J + conectividad por barra preservados (a través de cm2/cm4)');
ok(okMat, 'E por barra preservado (a través de GPa)');

const vig1 = [...m1.elements.values()].find(e => { const a = m1.nodes.get(e.n1), b = m1.nodes.get(e.n2); return Math.abs(a.z - 4) < 1e-9 && Math.abs(b.z - 4) < 1e-9; });
ok(vig1 && vig1.releases.some(Boolean), `liberación de extremo preservada (rel=[${vig1 ? vig1.releases.join('') : '—'}])`);

const nm = byXYZ(m1, 6, 0, 4);
ok(nm && nm.nodeMass && Math.abs(nm.nodeMass.mx - 1.2) < 1e-9, `masa nodal preservada (mx=${nm && nm.nodeMass ? nm.nodeMass.mx : '—'})`);

let nLoad = 0, dLoad = 0, trap = null;
for (const lc of m1.loadCases.values()) for (const l of (lc.loads || [])) { if (l.type === 'nodal') nLoad++; if (l.type === 'dist') { dLoad++; if (l.w2 != null) trap = l; } }
ok(nLoad === 1, `carga nodal preservada (${nLoad})`);
ok(dLoad === 2, `cargas distribuidas preservadas (${dLoad})`);
ok(trap && Math.abs(trap.w + 8) < 1e-9 && Math.abs(trap.w2 + 4) < 1e-9 && trap.dir === 'globalX', `trapecial + dir no-gravedad preservados (w=${trap ? trap.w : '—'}, w2=${trap ? trap.w2 : '—'}, dir=${trap ? trap.dir : '—'})`);

// ── D) import a hand-written nodex deck (units, profile, partial support, line load) ─
console.log('\n── D) import de deck nodex escrito a mano ────────────────');
const hand = `model units kN, m
material acero E=210 GPa, nu=0.3, rho=7.85 t/m3
section s1 profile IPE300
node A at (0,0,0)
node B at (6,0,0)
beam V from A to B acero s1
fix A
support B uy uz
load 1 line -10 kN/m on V
solve linear_static
`;
const { model: mh, warnings: wh } = importModel(hand, 'ndx');
const sh = [...mh.sections.values()][0], mmh = [...mh.materials.values()][0];
ok(Math.abs(mmh.E - 2.1e8) < 1, `E 210 GPa → 2.1e8 kN/m² (${mmh.E.toExponential(3)})`);
// profile IPE300 resolves portico's COMPUTED catalog (I-shape from d,bf,tw,tf; no root
// fillets), so A≈5.19e-3, Iz≈8.0e-5 — near the tabulated values. Check physical bounds
// + the axis convention (Iz strong > Iy weak) rather than exact tabulated numbers.
ok(sh.A > 4.8e-3 && sh.A < 5.6e-3 && sh.Iz > 7e-5 && sh.Iz < 9e-5 && sh.Iz > sh.Iy * 5, `profile IPE300 → A≈5.2e-3, Iz≈8.0e-5, Iz≫Iy (A=${sh.A.toExponential(3)}, Iz=${sh.Iz.toExponential(3)}, Iy=${sh.Iy.toExponential(3)})`);
const nb = byXYZ(mh, 6, 0, 0);
ok(nb && nb.restraints.uy && nb.restraints.uz && !nb.restraints.ux && !nb.restraints.rx, 'support parcial B uy uz (no ux/rx)');
let dh = 0; for (const lc of mh.loadCases.values()) for (const l of (lc.loads || [])) if (l.type === 'dist') dh++;
ok(dh === 1, `line load importada (${dh})`);
ok(wh.length === 0, `sin warnings al importar (${wh.length})`);

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
