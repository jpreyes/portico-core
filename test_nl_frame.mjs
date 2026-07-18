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
import { buildNLTrussProblem, buildCorotProblem, remapCorotSteps, buildFormFindProblem, lumpReferenceLoad3D, setupPushoverControl } from './js/solver/nl_frame.js';
import { solveNonlinear } from './js/solver/nl_lite.js';
import { solveCorotBeam } from './js/solver/corotbeam.js';
import { formFind } from './js/solver/formfind.js';
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

// ── (3) Form-finding: equal force densities, no load → node at the midpoint ────
console.log('\n── (3) buildFormFindProblem + formFind: min-length net ──');
{
  // A free node pulled off the A–B line by two equal-density cables and no load
  // relaxes to the q-weighted average of its anchors = the midpoint (1,0,0).
  const m = new Model();   // 3D
  m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'S', E: 2.1e8, G: 8e7, nu: 0.3, rho: 0 });
  const sec = m.addSection({ name: 'B', A: 1e-4, Iy: 1e-6, Iz: 1e-6, J: 1e-7 });
  const A = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const M = m.addNode(1, 0, 5);                                         // off the line
  const B = m.addNode(2, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  m.addElement(A.id, M.id, mat.id, sec.id);
  m.addElement(M.id, B.id, mat.id, sec.id);

  const prob = buildFormFindProblem(m, []);
  check(prob.ok, 'problem built', prob.ok ? '' : `(reason ${prob.reason})`);
  check(prob.branches.length === 2, 'two branches');
  check(JSON.stringify(prob.fixed) === JSON.stringify([true, false, true]), 'A,B anchored, M free');
  check(prob.loads === null && prob.hasLoad === false, 'no external load → loads null');

  const res = formFind({ coords: prob.coords, fixed: prob.fixed, branches: prob.branches, q: prob.branches.map(() => 10), loads: prob.loads, axes: [0, 1, 2] });
  check(res.ok, 'formFind solved', res.ok ? '' : `(${res.note})`);
  const iM = 1;
  check(rel(res.coords[3 * iM], 1) < 1e-9 && Math.abs(res.coords[3 * iM + 1]) < 1e-9 && Math.abs(res.coords[3 * iM + 2]) < 1e-9,
    'free node relaxes to the midpoint (1,0,0)',
    `(${res.coords[3 * iM].toFixed(3)}, ${res.coords[3 * iM + 1].toFixed(3)}, ${res.coords[3 * iM + 2].toFixed(3)})`);
}

// ── (4) Anti-drift: truss Fref and form-find loads share ONE lumping ──────────
console.log('\n── (4) lumpReferenceLoad3D is the single source for both builders ──');
{
  // A model exercising all three load kinds (nodal + distributed + self-weight); the
  // per-node load must be identical whether read from the truss Fref or the form-find
  // loads — that identity is the whole point of unifying the lumping.
  const m = new Model();   // 3D
  m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'S', E: 2.1e8, G: 8e7, nu: 0.3, rho: 3.0 });   // rho≠0 → self-weight
  const sec = m.addSection({ name: 'B', A: 2e-3, Iy: 1e-6, Iz: 1e-6, J: 1e-7 });
  const A = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const C = m.addNode(2, 0, 0);
  const B = m.addNode(4, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const e1 = m.addElement(A.id, C.id, mat.id, sec.id);
  m.addElement(C.id, B.id, mat.id, sec.id);
  const lc = m.addLoadCase('mix', true);                                   // selfWeight = true
  m.addLoad(lc.id, { type: 'nodal', nodeId: C.id, F: [10, -3, -20, 0, 0, 0] });
  m.addLoad(lc.id, { type: 'dist', elemId: e1.id, w: 5, dir: 'gravity' });

  const truss = buildNLTrussProblem(m);
  const ff = buildFormFindProblem(m, []);
  check(truss.ok && ff.ok, 'both builders succeed');
  let worst = 0;
  for (let i = 0; i < truss.nodeIds.length; i++)
    for (let c = 0; c < 3; c++)
      worst = Math.max(worst, Math.abs(truss.Fref[3 * i + c] - ff.loads[i][c]));
  check(worst === 0, 'truss Fref and form-find loads agree exactly', `(máx Δ ${worst})`);
  // and the standalone helper matches the truss Fref too
  const { F, hasLoad } = lumpReferenceLoad3D(m, truss.idxOf);
  check(hasLoad && F.every((v, k) => v === truss.Fref[k]), 'lumpReferenceLoad3D == truss Fref');
}

// ── (5) Structured refusals ───────────────────────────────────────────────────
console.log('\n── (5) structured refusals ──');
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

// ── (6) Pushover: pattern-weighted lumping + control-DOF setup ────────────────
console.log('\n── (6) buildNLTrussProblem(contribs) + setupPushoverControl ──');
{
  const m = new Model(); m.mode = '2D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'S', E: 2.1e8, G: 8e7, nu: 0.3, rho: 0 });
  const sec = m.addSection({ name: 'B', A: 1e-3, Iy: 1e-6, Iz: 1e-6, J: 1e-7 });
  const A = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const B = m.addNode(2, 0, 0, { uz: 1 });   // slide only along the bar (axial) → stable truss
  m.addElement(A.id, B.id, mat.id, sec.id);
  const lc = m.addLoadCase('H');
  m.addLoad(lc.id, { type: 'nodal', nodeId: B.id, F: [100, 0, 0, 0, 0, 0] });   // axial tip load
  const iB = 1;

  // The reference load scales linearly with the pattern factor.
  const P1 = buildNLTrussProblem(m, { contribs: [{ lcId: lc.id, factor: 1, selfWeight: false }] });
  const P2 = buildNLTrussProblem(m, { contribs: [{ lcId: lc.id, factor: 2, selfWeight: false }] });
  check(P1.Fref[3 * iB] === 100, 'nodal load enters Fref at factor 1');
  check(rel(P2.Fref[3 * iB], 2 * P1.Fref[3 * iB]) < 1e-12, 'contribs factor scales Fref linearly',
    `(${P2.Fref[3 * iB]} vs ${2 * P1.Fref[3 * iB]})`);

  // The linear probe picks the tip axial DOF as the control DOF.
  const setup = setupPushoverControl(P1, 0);
  check(setup.ok, 'setup ok', setup.ok ? '' : `(reason ${setup.reason})`);
  check(setup.cDOF === 3 * iB, 'control DOF is the tip axial DOF (ux)', `(${setup.cDOF})`);
  check(setup.target > 0 && setup.linCtrl > 0 && rel(setup.target, 25 * setup.linCtrl) < 1e-12,
    'target = 25·linCtrl, past the limit point');
  const setupImp = setupPushoverControl(P1, 0.01);
  check(setupImp.Ximp[3 * iB] !== P1.X[3 * iB], 'imperfection perturbs the control geometry',
    `(Δ=${(setupImp.Ximp[3 * iB] - P1.X[3 * iB]).toExponential(2)})`);
}

// ── (7) Pushover refusals ─────────────────────────────────────────────────────
console.log('\n── (7) pushover structured refusals ──');
{
  const mk = () => {
    const m = new Model(); m.mode = '2D'; m.materials.clear(); m.sections.clear();
    const mat = m.addMaterial({ name: 'S', E: 2.1e8, G: 8e7, nu: 0.3, rho: 0 });
    const sec = m.addSection({ name: 'B', A: 1e-3, Iy: 1e-6, Iz: 1e-6, J: 1e-7 });
    const A = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
    const B = m.addNode(1, 0, 0);
    m.addElement(A.id, B.id, mat.id, sec.id);
    return { m, B };
  };
  // Transverse load on an axial-only bar → singular linear probe → no response.
  const t = mk();
  const lcT = t.m.addLoadCase('T'); t.m.addLoad(lcT.id, { type: 'nodal', nodeId: t.B.id, F: [0, 0, -50, 0, 0, 0] });
  const Pt = buildNLTrussProblem(t.m, { contribs: [{ lcId: lcT.id, factor: 1, selfWeight: false }] });
  check(setupPushoverControl(Pt, 0).reason === 'no-response', 'transverse load on a truss bar → "no-response"');
  // A referenced case that carries no loads → null pattern.
  const z = mk();
  const lcE = z.m.addLoadCase('empty');
  const Pe = buildNLTrussProblem(z.m, { contribs: [{ lcId: lcE.id, factor: 1, selfWeight: false }] });
  check(setupPushoverControl(Pe, 0).reason === 'null-pattern', 'no load in the pattern → "null-pattern"');
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
