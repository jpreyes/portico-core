// test_selfweight.mjs — self-weight is a FORCE: w = rho·A·g, not rho·A.
//
// `rho` is a MASS density (t/m³ in the kN-m system): massMatrix() spends it as
// `rho*A*L = total element mass`, and verification 1-014 validates the periods that come
// out of it against a closed form. Turning it into a weight needs ×g — and for a long
// time it did not, which made every self-weight 9.81× too light. Nothing caught it: no
// verification case sets `selfWeight`, and no test anchored it to a physical value.
//
// So this test anchors on facts that cannot drift:
//   (1) a rolled profile whose weight is published in a table (IPE300 = 0.422 kN/m),
//   (2) global equilibrium: ΣR = ρ·A·g·L,
//   (3) the closed form δ = 5wL⁴/384EI for a simply supported beam under its own weight,
//   (4) the diagram integrator agreeing with the reactions — postprocess.js recomputes
//       self-weight on its own path, so it can drift from the assembler independently,
//   (5) a horizontal vs vertical member: gravity is global −Z, so a column carries its
//       weight as AXIAL load, not bending.
//
// Run:  node test_selfweight.mjs
import { Model } from '../js/model/model.js';
globalThis.window = globalThis;
await import('../lib/numeric.js');
const { StaticSolver } = await import('../js/solver/static_solver.js');
const { selfWeightPerLength, G_ACC } = await import('../js/solver/assembler.js');

let failures = 0;
const check = (cond, msg, extra = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

// ── IPE300, EN 10365: A = 53.8 cm², mass 42.2 kg/m → weight 0.4139 kN/m ──────
const E = 210e6, RHO = 7.85, A_IPE = 5.38e-3, IZ = 8.36e-5;
const w_expected = RHO * A_IPE * G_ACC;        // 0.4139 kN/m

function beam({ L, N, vertical = false, A = A_IPE, Iz = IZ }) {
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'S355', E, G: 80.77e6, nu: 0.3, rho: RHO });
  const sec = m.addSection({ name: 'IPE300', A, Iz, Iy: Iz, J: 2.01e-7, Avy: 1e30, Avz: 1e30 });
  const nodes = [];
  for (let i = 0; i <= N; i++) {
    const t = i * L / N;
    const pos = vertical ? [0, 0, t] : [t, 0, 0];
    let r = null;
    if (vertical) r = i === 0 ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } : { uy: 1, rx: 1 };
    else          r = i === 0 ? { ux: 1, uy: 1, uz: 1, rx: 1 } : (i === N ? { uy: 1, uz: 1, rx: 1 } : { uy: 1, rx: 1 });
    nodes.push(m.addNode(pos[0], pos[1], pos[2], r));
  }
  for (let i = 0; i < N; i++) m.addElement(nodes[i].id, nodes[i + 1].id, mat.id, sec.id);
  const lc = m.addLoadCase('PP', true, 'static');
  const res = new StaticSolver().solve(m, lc.id, true);
  return { m, res, nodes, mat, sec, lc };
}

// ── (1) The helper against the published table value ──────────────────────────
console.log('\n── (1) w = rho·A·g against the EN 10365 table ──');
{
  const mat = { rho: RHO }, sec = { A: A_IPE };
  const w = selfWeightPerLength(mat, sec);
  check(rel(w, w_expected) < 1e-12, 'selfWeightPerLength = rho·A·g', `(${w.toFixed(4)} kN/m)`);
  check(Math.abs(w - 0.414) < 0.005,
    'IPE300 weighs ~0.414 kN/m (table: 42.2 kg/m)', `(${w.toFixed(4)})`);
  // The bug this test exists for: rho·A alone is exactly g times too light.
  check(rel(w / (RHO * A_IPE), G_ACC) < 1e-12,
    'rho·A alone is exactly g times too light (the old bug)',
    `(ratio ${(w / (RHO * A_IPE)).toFixed(4)})`);
}

// ── (2) Global equilibrium: ΣR = w·L ─────────────────────────────────────────
console.log('\n── (2) Global equilibrium ──');
{
  const L = 6, { res, nodes } = beam({ L, N: 10 });
  let sumRz = 0;
  for (const n of nodes) sumRz += res.getReaction(n.id)[2];
  check(rel(sumRz, w_expected * L) < 1e-9, 'ΣReactions = rho·A·g·L',
    `(${sumRz.toFixed(6)} vs ${(w_expected * L).toFixed(6)} kN)`);
}

// ── (3) Closed form: δ = 5wL⁴/384EI ──────────────────────────────────────────
console.log('\n── (3) Simply supported beam under its own weight ──');
{
  const L = 6, N = 20, { res, nodes } = beam({ L, N });
  const uz = res.getNodeDisp(nodes[N / 2].id)[2];
  const teo = -5 * w_expected * L ** 4 / (384 * E * IZ);
  check(rel(uz, teo) < 2e-3, 'δ_mid = 5wL⁴/384EI',
    `(${uz.toExponential(5)} vs ${teo.toExponential(5)} m)`);
}

// ── (4) The diagram integrator must agree with the assembler ─────────────────
// postprocess.js rebuilds self-weight on its own path (actualLoadsLocal); if only the
// assembler were fixed, reactions and diagrams would disagree and both would look right.
console.log('\n── (4) Diagrams agree with the reactions ──');
{
  const L = 6, N = 4, { m, res } = beam({ L, N });
  const eid = [...m.elements.keys()][0];
  const el = m.elements.get(eid);
  const mat = m.materials.get(el.matId), sec = m.sections.get(el.secId);
  const { localAxes } = await import('../js/solver/timoshenko.js');
  const { actualLoadsLocal } = await import('../js/solver/postprocess.js');
  const n1 = m.nodes.get(el.n1), n2 = m.nodes.get(el.n2);
  const { ex, ey, ez } = localAxes(n1, n2);
  const q = actualLoadsLocal(m, res.lcId, true, el, ex, ey, ez);
  // Beam runs along +X, gravity is global −Z → the whole intensity lands on local y.
  check(rel(Math.abs(q.qy), w_expected) < 1e-9,
    'actualLoadsLocal returns rho·A·g on the transverse axis',
    `(|qy| = ${Math.abs(q.qy).toFixed(6)} kN/m)`);
}

// ── (5) A column carries its weight as AXIAL load ───────────────────────────
console.log('\n── (5) Vertical member: weight is axial, not bending ──');
{
  const L = 4, N = 4, { res, nodes } = beam({ L, N, vertical: true });
  const R = res.getReaction(nodes[0].id);
  check(rel(R[2], w_expected * L) < 1e-9, 'base reaction Fz = rho·A·g·L',
    `(${R[2].toFixed(6)} kN)`);
  check(Math.abs(R[4]) < 1e-6 && Math.abs(R[3]) < 1e-6,
    'no base moment: gravity is parallel to the member', `(|My| = ${Math.abs(R[4]).toExponential(2)})`);
}

// ── (6) Areas weigh: W = rho·t·A·g ──────────────────────────────────────────
// A slab or wall modelled with area elements used to contribute nothing at all, so a
// shear-wall building had a self-weight of exactly zero with the box ticked.
console.log('\n── (6) Area elements carry their weight ──');
{
  const RHO_C = 2.5, T = 0.20, LX = 4, LY = 3;      // 4×3 m slab, 20 cm, concrete
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'H30', E: 28.7e6, nu: 0.2, rho: RHO_C });
  const fix = { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 };
  const n = [
    m.addNode(0, 0, 0, fix), m.addNode(LX, 0, 0, fix), m.addNode(LX, LY, 0, fix),
    m.addNode(0, LY, 0, { rz: 1 }),   // free; rz is inert for a flat QUAD shell (no drilling)
  ];
  m.addArea(n.map(x => x.id), mat.id, { thickness: T, behavior: 'shell' });
  const lc = m.addLoadCase('PP', true, 'static');
  const res = new StaticSolver().solve(m, lc.id, true);
  // The free corner's share travels through the element into the supports, so the
  // restrained nodes must still carry the whole slab.
  let sumRz = 0;
  for (const x of n) sumRz += res.getReaction(x.id)[2];
  const W = RHO_C * T * LX * LY * G_ACC;
  check(rel(sumRz, W) < 1e-9, 'slab: ΣReactions = rho·t·A·g',
    `(${sumRz.toFixed(6)} vs ${W.toFixed(6)} kN)`);
  check(sumRz > 0, 'a slab does not weigh zero', `(${sumRz.toFixed(3)} kN)`);
}

// ── (7) An area's weight and its mass must describe the same body ───────────
// Both integrate rho·t·A and lump one nN-th per node; the only difference is ×g. If the
// two paths ever drift, a building's seismic mass stops matching its dead load.
console.log('\n── (7) Area weight = area mass × g ──');
{
  const { areaSelfWeightContribs, assembleAreasMassInto } = await import('../js/solver/membrane.js');
  const { buildNodeIndex } = await import('../js/solver/assembler.js');
  const RHO_C = 2.5, T = 0.15;
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'H30', E: 28.7e6, nu: 0.2, rho: RHO_C });
  const n = [m.addNode(0, 0, 0), m.addNode(3, 0, 0), m.addNode(3, 2.5, 0), m.addNode(0, 2.5, 0)];
  const area = m.addArea(n.map(x => x.id), mat.id, { thickness: T, behavior: 'shell' });
  const ni = buildNodeIndex(m);

  let massTot = 0;
  assembleAreasMassInto({ add: (i, j, v) => { if (i === j && i % 6 === 2) massTot += v; } }, m, ni);
  const wTot = areaSelfWeightContribs(area, m, ni, G_ACC).reduce((s, c) => s + Math.abs(c.val), 0);

  check(rel(wTot, massTot * G_ACC) < 1e-12, 'Σweight = Σmass × g',
    `(${wTot.toFixed(6)} kN vs ${(massTot * G_ACC).toFixed(6)})`);
  check(rel(massTot, RHO_C * T * 3 * 2.5) < 1e-12, 'Σmass = rho·t·A', `(${massTot.toFixed(6)} t)`);
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
