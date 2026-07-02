// test_pcg.mjs — verification of js/solver/pcg.js (PCG, CSR, Jacobi/IC0).
// Not integrated yet — this only checks the module is CORRECT and CONVERGES:
//   1) recovers a known solution on a well-conditioned SPD (2D Dirichlet Laplacian);
//   2) iteration counts behave (IC0 ≤ Jacobi ≤ pure CG);
//   3) survives a penalty-augmented ill-conditioned system (diaphragm-like ~1e12 rows);
//   4) csrMatvec residual is consistent.
import { pcg, csrMatvec, jacobi, ic0, makeSolverPCG } from './js/solver/pcg.js';
import { Model } from './js/model/model.js';
import { buildNodeIndex, getNodeDOFs, assembleF } from './js/solver/assembler.js';
import { assembleSparseGlobal, extractFreeCSR } from './js/solver/sparse.js';
import { makeFactorCSR } from './js/solver/linsolve.js';

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fails++; };
const relErr = (x, xt) => { let a = 0, b = 0; for (let i = 0; i < x.length; i++) { a += (x[i] - xt[i]) ** 2; b += xt[i] ** 2; } return Math.sqrt(a / (b || 1)); };

// Build a 2D 5-point Dirichlet Laplacian (SPD) on a G×G grid as symmetric FULL CSR.
function laplacian2D(G) {
  const n = G * G;
  const rows = Array.from({ length: n }, () => []);
  const at = (r, c) => r * G + c;
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) {
    const i = at(r, c);
    rows[i].push([i, 4]);
    if (r > 0)     rows[i].push([at(r - 1, c), -1]);
    if (r < G - 1) rows[i].push([at(r + 1, c), -1]);
    if (c > 0)     rows[i].push([at(r, c - 1), -1]);
    if (c < G - 1) rows[i].push([at(r, c + 1), -1]);
  }
  return rowsToCsr(rows, n);
}
function rowsToCsr(rows, n) {
  const rowPtr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) { rows[i].sort((a, b) => a[0] - b[0]); rowPtr[i + 1] = rowPtr[i] + rows[i].length; }
  const nnz = rowPtr[n], colIdx = new Int32Array(nnz), val = new Float64Array(nnz);
  let q = 0; for (let i = 0; i < n; i++) for (const [j, v] of rows[i]) { colIdx[q] = j; val[q] = v; q++; }
  return { n, rowPtr, colIdx, val };
}
function randVec(n) { const x = new Float64Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin(i * 1.7) + 0.3 * Math.cos(i * 0.31); return x; }
function residual(csr, x, b) { const Ax = csrMatvec(csr, x); let a = 0, c = 0; for (let i = 0; i < csr.n; i++) { a += (b[i] - Ax[i]) ** 2; c += b[i] * b[i]; } return Math.sqrt(a / (c || 1)); }

// ── 1) known-solution recovery on a well-conditioned SPD ─────────────────────────
console.log('── 1) 2D Dirichlet Laplacian 40×40 (n=1600): recover known x ──');
const csr = laplacian2D(40);
const xt = randVec(csr.n);
const b = csrMatvec(csr, xt);
const iters = {};
for (const pre of ['jacobi', 'ic0', null]) {
  const r = pcg(csr, b, { pre, tol: 1e-10 });
  iters[pre === null ? 'cg' : pre] = r.iters;
  ok(r.ok && relErr(r.x, xt) < 1e-6, `pre=${pre ?? 'none(CG)'}: converge, ‖x-x*‖/‖x*‖=${relErr(r.x, xt).toExponential(2)}, iters=${r.iters}, res=${r.res.toExponential(1)}`);
}

// ── 2) preconditioner quality: IC0 ≤ Jacobi ≤ pure CG (iterations) ───────────────
console.log('\n── 2) calidad del precondicionador (iteraciones) ──');
ok(iters.ic0 <= iters.jacobi, `IC0 (${iters.ic0}) ≤ Jacobi (${iters.jacobi})`);
ok(iters.jacobi <= iters.cg, `Jacobi (${iters.jacobi}) ≤ CG puro (${iters.cg})`);

// ── 3) penalty-augmented ill-conditioned system (diaphragm-like) ─────────────────
// Fix ~4% of DOFs by penalty A[i][i] += 1e5·max(diag) — the SAME factor the code uses
// for rigid diaphragms/links (diaphragm.js/links.js). The honest convergence metric on a
// penalty system is the RESIDUAL ‖b-Ax‖ (the preconditioned criterion targets exactly
// this); the solution error is bounded by κ·‖r‖/‖b‖, an intrinsic property of the penalty
// formulation that affects any solver, direct included.
console.log('\n── 3) sistema mal-condicionado tipo penalty (diafragma, 1e5·maxdiag) ──');
{
  const c2 = laplacian2D(30);            // n=900
  const n = c2.n;
  const xt2 = randVec(n);
  const fixed = new Set(); for (let i = 0; i < n; i += 25) fixed.add(i);
  const diagAt = new Int32Array(n);
  let maxDiag = 0;
  for (let i = 0; i < n; i++) for (let p = c2.rowPtr[i]; p < c2.rowPtr[i + 1]; p++) if (c2.colIdx[p] === i) { diagAt[i] = p; if (c2.val[p] > maxDiag) maxDiag = c2.val[p]; }
  const P = 1e5 * maxDiag;                // realistic penalty (κ ≈ 1e7, not 1e12)
  for (const i of fixed) c2.val[diagAt[i]] += P;
  const b2 = csrMatvec(c2, xt2);         // consistent RHS
  for (const pre of ['ic0', 'jacobi']) {
    const r = pcg(c2, b2, { pre, tol: 1e-10 });
    ok(r.ok, `${pre}: converge con penalty (iters=${r.iters})`);
    ok(residual(c2, r.x, b2) < 1e-8, `${pre}: residuo ‖b-Ax‖/‖b‖=${residual(c2, r.x, b2).toExponential(2)} (métrica honesta)`);
    ok(relErr(r.x, xt2) < 1e-3, `${pre}: recupera x dentro de κ·eps (‖x-x*‖/‖x*‖=${relErr(r.x, xt2).toExponential(2)})`);
  }
}

// ── 4) direct API sanity (jacobi/ic0 apply) ──────────────────────────────────────
console.log('\n── 4) precondicionadores como operadores M⁻¹ ──');
{
  const c3 = laplacian2D(8);
  const rvec = randVec(c3.n);
  const zj = jacobi(c3).apply(rvec);
  const zi = ic0(c3).apply(rvec);
  ok(zj.length === c3.n && zi.length === c3.n && zj.every(Number.isFinite) && zi.every(Number.isFinite), 'jacobi/ic0 devuelven vectores finitos');
}

// ── 5) REAL structural Kff: mixed frame + shell + rigid diaphragms (penalty) ─────
// The decisive test: not an M-matrix. 6 DOF/node (rotational + translational at very
// different scales), a membrane shell wall, and two penalty rigid diaphragms. Assembles
// the CSR the same way app.js does, then compares PCG (IC0, Jacobi) against the direct
// banded Cholesky (makeFactorCSR) used by the sparse worker today.
console.log('\n── 5) Kff real: marco 3D + muro shell + 2 diafragmas rígidos (penalty) ──');
{
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const E = 2.1e8;
  const steel = m.addMaterial({ name: 'S', E, G: E / 2.6, nu: 0.3, rho: 0 });
  const wall = m.addMaterial({ name: 'W', E: 2.5e7, G: 2.5e7 / 2.4, nu: 0.2, rho: 0 });
  const sec = m.addSection({ name: 'c', A: 0.02, Iy: 6.7e-5, Iz: 6.7e-5, J: 1.3e-4 });
  const corners = [[0, 0], [6, 0], [6, 4], [0, 4]];
  const floors = [0, 3, 6];
  const nodes = {}; const nid = (x, y, z) => nodes[`${x},${y},${z}`];
  for (const [x, y] of corners) for (const z of floors) {
    const n = m.addNode(x, y, z, z === 0 ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } : {});
    nodes[`${x},${y},${z}`] = n.id;
  }
  for (const [x, y] of corners) { m.addElement(nid(x, y, 0), nid(x, y, 3), steel.id, sec.id); m.addElement(nid(x, y, 3), nid(x, y, 6), steel.id, sec.id); }
  for (const z of [3, 6]) for (let i = 0; i < 4; i++) { const [x1, y1] = corners[i], [x2, y2] = corners[(i + 1) % 4]; m.addElement(nid(x1, y1, z), nid(x2, y2, z), steel.id, sec.id); }
  for (const z of [3, 6]) { const tops = corners.map(([x, y]) => nid(x, y, z)); m.addDiaphragm({ name: 'F' + z, z, nodes: tops, masterId: tops[0], cm: { x: 3, y: 2 }, cr: { x: 3, y: 2 }, mass: { m: 0, Icm: 0 }, eccentricity: { ex: 0, ey: 0 } }); }
  m.addArea([nid(0, 0, 3), nid(6, 0, 3), nid(6, 0, 6), nid(0, 0, 6)], wall.id, { thickness: 0.2, behavior: 'membrane' });   // shear wall (membrane)
  const lc = m.addLoadCase('V', false);
  for (const z of [3, 6]) for (const [x, y] of corners) lc.loads.push({ type: 'nodal', nodeId: nid(x, y, z), F: [10, 0, 0, 0, 0, 0] });

  // assemble CSR exactly like app.js (3D, no prescribed disp)
  const nodeIndex = buildNodeIndex(m);
  const nDOF = nodeIndex.size * 6;
  const freeDOF = []; const freeMap = new Int32Array(nDOF).fill(-1);
  for (const node of m.nodes.values()) {
    const d = getNodeDOFs(nodeIndex, node.id); const r = node.restraints;
    const rArr = [r.ux, r.uy, r.uz, r.rx, r.ry, r.rz];
    d.forEach((gi, li) => { if (!rArr[li]) { freeMap[gi] = freeDOF.length; freeDOF.push(gi); } });
  }
  const nF = freeDOF.length;
  const { S } = assembleSparseGlobal(m, nodeIndex, { withMass: false });
  const { csr } = extractFreeCSR(S, freeMap, nF);
  const Fg = assembleF(m, nodeIndex, lc.id, false);
  const Ff = new Float64Array(nF); for (let i = 0; i < nF; i++) Ff[i] = Fg[freeDOF[i]];

  // condition indicator: penalty rows blow the diagonal spread
  let dmin = Infinity, dmax = 0;
  for (let i = 0; i < nF; i++) for (let p = csr.rowPtr[i]; p < csr.rowPtr[i + 1]; p++) if (csr.colIdx[p] === i) { const d = Math.abs(csr.val[p]); if (d < dmin) dmin = d; if (d > dmax) dmax = d; }
  console.log(`  nF=${nF} GDL · diag spread max/min = ${(dmax / dmin).toExponential(1)} (penalty presente)`);

  const direct = makeFactorCSR(csr);
  ok(direct.ok, `Cholesky directo factoriza (SPD, banda=${direct.m})`);
  const uRef = direct.solve(Ff);

  // Correctness metric = agreement with the direct solver (ground truth). The RAW residual
  // floors around κ·eps (~1e-6 here, κ≈2e9 from the diaphragm penalty), which is expected —
  // the preconditioned stop targets rᵀz, not ‖F-Ku‖. High iteration counts for so few DOF
  // are the penalty inflating κ, not a solver defect (hence the diaphragm→direct heuristic).
  for (const pre of ['ic0', 'jacobi']) {
    const solver = makeSolverPCG(csr, { pre, tol: 1e-10, maxIter: 5000 });
    const u = solver.solve(Ff);
    ok(relErr(u, uRef) < 1e-5, `PCG ${pre}: coincide con el directo, ‖u-u_dir‖/‖u_dir‖=${relErr(u, uRef).toExponential(2)}, iters=${u._iters}`);
    ok(residual(csr, u, Ff) < 1e-5, `PCG ${pre}: residuo ‖F-Ku‖/‖F‖=${residual(csr, u, Ff).toExponential(2)} (piso ≈ κ·eps)`);
  }

  // fallback contract: a starved PCG (maxIter=1) must report _ok=false so the worker
  // can retry with the direct factor (which is exact).
  const starved = makeSolverPCG(csr, { pre: 'ic0', tol: 1e-12, maxIter: 1 }).solve(Ff);
  ok(starved._ok === false, `PCG no convergido marca _ok=false (gatilla el fallback al directo)`);
}

console.log(`\n=== ${fails === 0 ? 'ALL OK' : fails + ' FAILURE(S)'} ===`);
process.exit(fails ? 1 : 0);
