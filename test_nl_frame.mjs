// test_nl_frame.mjs — the Model→problem translation extracted from app.js's
// runNonlinear/runCorotBeam (js/solver/nl_frame.js), exercised end-to-end through
// the already-modular solvers (solveNonlinear, solveCorotBeam) against closed form.
//
//   (1) Pretensioned two-bar cable, central point load P: the midspan drop δ solves
//         2·EA·(ℓ−L0)/L0 · (δ/ℓ) = P ,  ℓ = √(a²+δ²)   — solved here independently.
//   (2) Cantilever under a tip MOMENT M (Euler elastica, inextensible): the beam curls
//         into a circular arc of radius R = EI/M, rotation θ = M·L/EI, so the tip lands
//         at (R·sinθ, R·(1−cosθ)).
//
// Run:  node test_nl_frame.mjs
import { buildNLTrussProblem, buildCorotProblem, remapCorotSteps } from './js/solver/nl_frame.js';
import { solveNonlinear } from './js/solver/nl_lite.js';
import { solveCorotBeam } from './js/solver/corotbeam.js';
import { Model } from './js/model/model.js';

let failures = 0;
const check = (cond, msg, extra = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const rel = (a, b) => Math.abs(b) < 1e-15 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b);

// ── (1) Pretensioned cable with a central load ────────────────────────────────
console.log('── (1) buildNLTrussProblem + solveNonlinear: cable central load ──');
{
  const a = 1, EA = 2.1e4, L0 = 0.99, P = 420;   // L0 < a → pretension (non-singular start)
  // Independent closed form: Newton on 2·EA·(ℓ−L0)/L0·(δ/ℓ) − P = 0.
  const g = d => { const l = Math.hypot(a, d); return 2 * EA * (l - L0) / L0 * (d / l) - P; };
  let dExact = 0.2;
  for (let k = 0; k < 200; k++) {
    const h = 1e-8, df = (g(dExact + h) - g(dExact)) / h;
    const dn = dExact - g(dExact) / df;
    if (Math.abs(dn - dExact) < 1e-15) { dExact = dn; break; }
    dExact = dn;
  }

  const m = new Model(); m.mode = '2D';
  m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'S', E: 2.1e8, G: 8e7, nu: 0.3, rho: 0 });
  const sec = m.addSection({ name: 'B', A: 1e-4, Iy: 1e-6, Iz: 1e-6, J: 1e-7 });   // EA = 2.1e4
  const A = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const M = m.addNode(a, 0, 0);
  const B = m.addNode(2 * a, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const e1 = m.addElement(A.id, M.id, mat.id, sec.id);
  const e2 = m.addElement(M.id, B.id, mat.id, sec.id);
  m.elements.get(e1.id).L0factor = L0 / a;   // natural length 0.99·L
  m.elements.get(e2.id).L0factor = L0 / a;
  const lc = m.addLoadCase('P');
  m.addLoad(lc.id, { type: 'nodal', nodeId: M.id, F: [0, 0, -P, 0, 0, 0] });

  const prob = buildNLTrussProblem(m);
  check(prob.ok, 'problem built', prob.ok ? '' : `(reason ${prob.reason})`);
  check(prob.elems.length === 2 && prob.nCasos === 1, 'two bars, one load case');
  check(prob.free.length === 2, 'midspan has 2 free DOFs (ux,uz in 2D)', `(${prob.free.length})`);

  const res = solveNonlinear({ X: prob.X, elems: prob.elems, free: prob.free, Fref: prob.Fref, nSteps: 20, maxIter: 60, tol: 1e-10, slack: 1e-6 });
  check(res.converged, 'Newton load-control converged', `(${res.steps.length} steps)`);
  const uLast = res.steps[res.steps.length - 1].u;
  const iM = 1;   // node M is index 1
  const uz = uLast[3 * iM + 2], ux = uLast[3 * iM];
  check(Math.abs(ux) < 1e-6, 'midspan does not move horizontally (symmetry)', `(${ux.toExponential(2)})`);
  check(rel(Math.abs(uz), dExact) < 1e-4, 'midspan drop matches the closed form',
    `(${Math.abs(uz).toFixed(5)} vs ${dExact.toFixed(5)})`);
}

// ── (2) Cantilever under a tip moment: Euler elastica arc ─────────────────────
console.log('\n── (2) buildCorotProblem + solveCorotBeam: tip-moment elastica ──');
{
  const E = 2.1e8, Iz = 8e-5, L = 2, theta = 1.0;   // total rotation θ = M·L/EI
  const EI = E * Iz, R = L / theta, Mtip = EI * theta / L;
  const xTip = R * Math.sin(theta), zTip = R * (1 - Math.cos(theta));
  const uxExact = xTip - L, uzExact = zTip;          // foreshortening + rise

  const nEl = 16;
  const m = new Model(); m.mode = '2D';
  m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'S', E, G: 8e7, nu: 0.3125, rho: 0 });
  const sec = m.addSection({ name: 'C', A: 0.01, Iy: Iz, Iz, J: 1e-6 });
  const nodes = [];
  for (let i = 0; i <= nEl; i++) {
    const r = i === 0 ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } : {};
    nodes.push(m.addNode(L * i / nEl, 0, 0, r));
  }
  for (let i = 0; i < nEl; i++) m.addElement(nodes[i].id, nodes[i + 1].id, mat.id, sec.id);
  const lc = m.addLoadCase('M');
  m.addLoad(lc.id, { type: 'nodal', nodeId: nodes[nEl].id, F: [0, 0, 0, 0, Mtip, 0] });   // My at the tip

  const prob = buildCorotProblem(m);
  check(prob.ok, 'problem built', prob.ok ? '' : `(reason ${prob.reason})`);
  check(prob.elems.length === nEl, `${nEl} planar beam elements`);

  const res = solveCorotBeam({ coords: prob.coords, elems: prob.elems, free: prob.free, Fref: prob.Fref, nSteps: 20, maxIter: 80, tol: 1e-9 });
  check(res.steps.length > 0, 'corotational produced steps');
  const steps2 = remapCorotSteps({ coords: prob.coords, elems: prob.elems, steps: res.steps, nNode: prob.nodeIds.length });
  const u3 = steps2[steps2.length - 1].u;
  const iTip = nEl;   // last node
  const ux = u3[3 * iTip], uz = u3[3 * iTip + 2];
  check(u3[3 * iTip + 1] === 0, 'remap zeroes the out-of-plane (uy) component');
  check(rel(ux, uxExact) < 0.02, 'tip foreshortening ux = R·sinθ − L',
    `(${ux.toFixed(4)} vs ${uxExact.toFixed(4)})`);
  check(rel(Math.abs(uz), uzExact) < 0.02, 'tip rise |uz| = R·(1−cosθ)',
    `(${Math.abs(uz).toFixed(4)} vs ${uzExact.toFixed(4)})`);
}

// ── (3) Structured refusals ───────────────────────────────────────────────────
console.log('\n── (3) structured refusals ──');
{
  const m = new Model(); m.mode = '2D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'S', E: 2.1e8, G: 8e7, nu: 0.3, rho: 0 });
  const sec = m.addSection({ name: 'B', A: 1e-4, Iy: 1e-6, Iz: 1e-6, J: 1e-7 });
  // two fully-restrained nodes + one element → no free DOF
  const A = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const B = m.addNode(1, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  m.addElement(A.id, B.id, mat.id, sec.id);
  check(buildNLTrussProblem(m).reason === 'no-free-dof', 'all-restrained truss → "no-free-dof"');
  check(buildCorotProblem(m).reason === 'no-free-dof', 'all-restrained corot → "no-free-dof"');

  const empty = new Model(); empty.mode = '2D'; empty.materials.clear(); empty.sections.clear();
  empty.addNode(0, 0, 0);
  check(buildNLTrussProblem(empty).reason === 'no-elements', 'no elements → "no-elements"');
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
