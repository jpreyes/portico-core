// ──────────────────────────────────────────────────────────────────────────────
// direct_integration.js — LINEAR DIRECT time integration (Newmark-β) of the FULL
// assembled system, complementary to the modal-superposition path (timehistory.js).
//
//     M·ü + C·u̇ + K·u = p(t) = −M·ι·a_g(t)        (uniform base excitation)
//
// Unlike modal superposition, this integrates the coupled physical system directly,
// so it needs NO mode truncation and admits NON-classical damping (a general C). It
// is the SAP2000/ETABS/OpenSees "direct integration" method with the implicit
// Newmark scheme (average acceleration γ=½, β=¼: unconditionally stable, no
// numerical dissipation).
//
// Performance (see tests/bench_direct_th.mjs): with constant Δt the effective
// matrix  K_eff = K + a1·M + b1·C  is CONSTANT, so it is factored ONCE and every step
// is a cheap back-substitution; for large models a preconditioned CG warm-started
// from the previous step (≈9 iterations, flat with size) avoids the factorization
// memory. `solver:'auto'` picks between them by size.
//
// SELF-CONTAINED: operates on CSR matrices and the repo's own linear-algebra kernels
// (no DOM), so it is verifiable in Node against analytic SDOF solutions AND, for the
// multi-DOF case, cross-checked against the existing modal time-history — a linear
// system with the SAME damping must give the SAME response by either method
// (test_direct_integration.mjs).
// ──────────────────────────────────────────────────────────────────────────────
import { csrMv, makeFactorCSR, permRCMcsr, csrLinComb } from './linsolve.js?v=7';
import { pcg, ic0 } from './pcg.js?v=7';
import { buildNodeIndex } from './assembler.js?v=7';
import { assembleSparseGlobal, extractFreeCSR } from './sparse.js?v=7';

export { csrLinComb };   // re-exported: csrLinComb now lives in linsolve.js

// ── Rayleigh damping coefficients: ζ at two circular frequencies w1, w2 ────────
// C = a0·M + a1·K gives EXACTLY ζ at w1 and w2, and ζ_i = a0/(2·w_i) + a1·w_i/2 elsewhere.
export function rayleigh(zeta, w1, w2) {
  return { a0: zeta * 2 * w1 * w2 / (w1 + w2), a1: zeta * 2 / (w1 + w2) };
}
export function rayleighZeta(a0, a1, w) { return a0 / (2 * w) + a1 * w / 2; }

// ── Newmark-β linear direct integration ───────────────────────────────────────
/**
 * @param {object} o
 *   K, M   CSR of the FREE-DOF system (n×n).
 *   C      CSR damping (optional). If absent, give {a0,a1} to form C = a0·M + a1·K.
 *   a0,a1  Rayleigh coefficients (used only when C is not given).
 *   ag     Float64Array   base accelerogram a_g(t) sampled at Δt (m/s²).
 *   dt     number         time step (s).
 *   iota   Float64Array(n) influence vector (1 in the excited direction per node).
 *   gamma,beta  Newmark parameters (default ½, ¼ — average acceleration).
 *   u0,v0  Float64Array(n) initial displacement / velocity (default 0 — from rest).
 *   record number[]        DOF indices whose full history to keep (default: none;
 *                          peaks are always returned for every DOF).
 *   solver 'auto'|'factor'|'pcg'   (default 'auto': factor if n ≤ factorMax else PCG).
 *   factorMax number       size threshold for 'auto' (default 5000).
 *   pcgTol number          relative tolerance for the PCG path (default 1e-8).
 * @returns {object}
 *   t Float64Array(nSteps) · nSteps · n · solver used · avgIters (PCG) ·
 *   peak Float64Array(n)   max |u| over time per DOF ·
 *   hist Map<dof,Float64Array>  full history of the requested DOFs ·
 *   uAt(step) → Float64Array(n)  (only if keepAll was set)
 */
export function newmarkLinear(o) {
  const { K, M, ag, dt } = o;
  const n = K.n;
  const gamma = o.gamma ?? 0.5, beta = o.beta ?? 0.25;
  const nSteps = ag.length;

  // Damping matrix (explicit C, or Rayleigh from a0/a1)
  let C = o.C;
  if (!C) {
    const a0 = o.a0 ?? 0, a1 = o.a1 ?? 0;
    C = csrLinComb(M, a0, K, a1);
  }

  // Newmark average-acceleration integration constants (Chopra Table 5.4.2)
  const a1c = 1 / (beta * dt * dt), a2c = 1 / (beta * dt), a3c = 1 / (2 * beta) - 1;   // M terms
  const b1c = gamma / (beta * dt), b2c = gamma / beta - 1, b3c = dt * (gamma / (2 * beta) - 1); // C terms

  // K_eff = K + a1c·M + b1c·C   (constant → factor/precondition once)
  const Keff = csrLinComb(csrLinComb(K, 1, M, a1c), 1, C, b1c);

  // Solver selection
  const factorMax = o.factorMax ?? 5000;
  const mode = o.solver === 'factor' || o.solver === 'pcg' ? o.solver
             : (n <= factorMax ? 'factor' : 'pcg');
  let fac = null, pre = null;
  if (mode === 'factor') {
    fac = makeFactorCSR(Keff, permRCMcsr(Keff));
    if (!fac.ok) { pre = ic0(Keff); }                 // fall back to PCG if not factorable
  } else pre = ic0(Keff);
  const usePcg = mode === 'pcg' || (fac && !fac.ok);

  // Constant load direction  p_k = −a_g[k]·(M·ι)
  const iota = o.iota;
  const Miota = new Float64Array(n); csrMv(M, iota, Miota);

  // State
  const u = o.u0 ? Float64Array.from(o.u0) : new Float64Array(n);
  const v = o.v0 ? Float64Array.from(o.v0) : new Float64Array(n);
  const acc = new Float64Array(n);
  // a₀ from M·a₀ = p₀ − C·v₀ − K·u₀. From rest (u₀=v₀=0): a₀ = −ι·a_g[0].
  if (!o.u0 && !o.v0) { for (let i = 0; i < n; i++) acc[i] = -iota[i] * ag[0]; }
  else {
    const rhs0 = new Float64Array(n), Cv = new Float64Array(n), Ku = new Float64Array(n);
    csrMv(C, v, Cv); csrMv(K, u, Ku);
    for (let i = 0; i < n; i++) rhs0[i] = -Miota[i] * ag[0] - Cv[i] - Ku[i];
    const r = pcg(M, rhs0, { pre: 'jacobi', tol: 1e-10 });  // M·a₀ = rhs0
    acc.set(r.x);
  }

  // Buffers (no allocation inside the loop)
  const w = new Float64Array(n), Mw = new Float64Array(n), Cw = new Float64Array(n);
  const peff = new Float64Array(n), uNew = new Float64Array(n);

  // Outputs
  const t = new Float64Array(nSteps);
  const peak = new Float64Array(n);
  const recDofs = o.record || [];
  const hist = new Map(recDofs.map(d => [d, new Float64Array(nSteps)]));
  const keepAll = !!o.keepAll;
  const U = keepAll ? new Float64Array(nSteps * n) : null;

  const store = (k) => {
    t[k] = k * dt;
    for (let i = 0; i < n; i++) { const a = Math.abs(u[i]); if (a > peak[i]) peak[i] = a; }
    for (const d of recDofs) hist.get(d)[k] = u[d];
    if (keepAll) U.set(u, k * n);
  };
  store(0);

  let itersSum = 0;
  for (let k = 0; k < nSteps - 1; k++) {
    // p_eff = p_{k+1} + M(a1c·u + a2c·v + a3c·a) + C(b1c·u + b2c·v + b3c·a)
    const p1 = -ag[k + 1];
    for (let i = 0; i < n; i++) w[i] = a1c * u[i] + a2c * v[i] + a3c * acc[i];
    csrMv(M, w, Mw);
    for (let i = 0; i < n; i++) w[i] = b1c * u[i] + b2c * v[i] + b3c * acc[i];
    csrMv(C, w, Cw);
    for (let i = 0; i < n; i++) peff[i] = p1 * Miota[i] + Mw[i] + Cw[i];

    // Solve K_eff·u_{k+1} = p_eff
    if (usePcg) {
      const r = pcg(Keff, peff, { pre, x0: u, tol: o.pcgTol ?? 1e-8 });
      uNew.set(r.x); itersSum += r.iters;
    } else fac.solve(peff, uNew);

    // Newmark state update
    for (let i = 0; i < n; i++) {
      const du = uNew[i] - u[i];
      const aN = a1c * du - a2c * v[i] - a3c * acc[i];
      const vN = v[i] + dt * ((1 - gamma) * acc[i] + gamma * aN);
      u[i] = uNew[i]; v[i] = vN; acc[i] = aN;
    }
    store(k + 1);
  }

  return {
    t, nSteps, n, peak, hist,
    solver: usePcg ? 'pcg' : 'factor',
    avgIters: usePcg ? itersSum / Math.max(1, nSteps - 1) : 0,
    U: keepAll ? U : undefined,                         // raw nSteps×n buffer (transferable)
    uAt: keepAll ? (s) => U.subarray(s * n, s * n + n) : undefined,
  };
}

// ── Model-level driver: assemble + integrate ──────────────────────────────────
/**
 * Full-model linear direct time-history from a Model, with uniform base excitation.
 * Assembles the sparse K/M, forms Rayleigh damping and integrates with newmarkLinear.
 *
 * @param {Model} model
 * @param {object} o
 *   ag        Float64Array   base accelerogram (m/s²) at Δt.
 *   dt        number         time step (s).
 *   direction 'X'|'Y'|'Z'    excitation direction (default 'X').
 *   zeta      number         target damping ratio (default 0.05).
 *   rayleighFreqs [w1,w2]    circular frequencies (rad/s) anchoring Rayleigh ζ.
 *                            (Typically the 1st mode and a higher significant mode;
 *                            pass them from a prior modal solve. Or give a0/a1 / C.)
 *   a0,a1     numbers        explicit Rayleigh coefficients (override rayleighFreqs).
 *   record    [{node,dof}]   node id + local dof (0=ux..5=rz) histories to keep.
 *   solver, factorMax, pcgTol, keepAll   forwarded to newmarkLinear.
 * @returns newmarkLinear result, plus:
 *   nodeIndex, freeMap, nF,
 *   histAt(node,dof) → Float64Array | null,
 *   peakNodal(node)  → Float64Array(6)  peak |u| per local dof.
 */
// ── Assembly step (MAIN thread) ───────────────────────────────────────────────
// Splits the model-dependent assembly out of directTimeHistory so it can run on the
// main thread and the heavy integration can be handed to a Web Worker with only
// plain, transferable data (CSR typed arrays + iota). Returns everything the worker
// needs plus the maps the main thread keeps to interpret the result.
export function assembleDirectSystem(model, o = {}) {
  const nodeIndex = buildNodeIndex(model);
  const nDOF = nodeIndex.size * 6;
  const freeMap = new Int32Array(nDOF).fill(-1);
  const is2D = model.mode === '2D';   // planar: lock uy, rx, rz (as the rest of the solver)
  let nF = 0;
  for (const nd of model.nodes.values()) {
    const b = 6 * nodeIndex.get(nd.id), r = nd.restraints || {};
    const rr = [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz];
    for (let d = 0; d < 6; d++) if (!rr[d]) freeMap[b + d] = nF++;
  }
  if (!nF) throw new Error('directTimeHistory: el modelo no tiene GDL libres');

  const { S: Ks, M: Ms } = assembleSparseGlobal(model, nodeIndex, { withMass: true });
  const K = extractFreeCSR(Ks, freeMap, nF).csr;
  const M = extractFreeCSR(Ms, freeMap, nF).csr;

  // Influence vector ι: unit ground motion in `direction` → 1 on the matching
  // translational free DOF of every node.
  const dirOff = { X: 0, Y: 1, Z: 2 }[(o.direction || 'X').toUpperCase()] ?? 0;
  const iota = new Float64Array(nF);
  for (const nd of model.nodes.values()) {
    const g = 6 * nodeIndex.get(nd.id) + dirOff;
    if (freeMap[g] >= 0) iota[freeMap[g]] = 1;
  }
  return { K, M, iota, nodeIndex, freeMap, nF };
}

// Wraps a newmarkLinear result with node-level accessors, given the maps kept on the
// main thread. Works whether newmarkLinear ran here or inside a worker (pass the
// result reconstructed from the worker's transferred buffers).
export function directResultView(res, nodeIndex, freeMap, recPairs = []) {
  const recKey = new Map(recPairs.map(p => [`${p.node}:${p.dof}`, p.gi]));
  return {
    ...res, nodeIndex, freeMap,
    histAt(node, dof) { const gi = recKey.get(`${node}:${dof}`); return gi != null && res.hist ? res.hist.get(gi) : null; },
    peakNodal(node) {
      const out = new Float64Array(6);
      for (let d = 0; d < 6; d++) { const gi = freeMap[6 * nodeIndex.get(node) + d]; out[d] = gi >= 0 ? res.peak[gi] : 0; }
      return out;
    },
  };
}

export function directTimeHistory(model, o) {
  const { K, M, iota, nodeIndex, freeMap, nF } = assembleDirectSystem(model, o);

  // Damping: explicit a0/a1, else Rayleigh from the two anchor frequencies.
  let a0 = o.a0, a1 = o.a1;
  if (a0 == null || a1 == null) {
    const [w1, w2] = o.rayleighFreqs || [];
    if (!(w1 > 0) || !(w2 > 0)) throw new Error('directTimeHistory: falta amortiguamiento (a0/a1, C o rayleighFreqs)');
    ({ a0, a1 } = rayleigh(o.zeta ?? 0.05, w1, w2));
  }

  const recPairs = (o.record || []).map(({ node, dof }) => ({ node, dof, gi: freeMap[6 * nodeIndex.get(node) + dof] }))
                                    .filter(p => p.gi >= 0);
  const res = newmarkLinear({
    K, M, C: o.C, a0, a1, ag: o.ag, dt: o.dt, iota,
    record: recPairs.map(p => p.gi),
    solver: o.solver, factorMax: o.factorMax, pcgTol: o.pcgTol, keepAll: o.keepAll,
    gamma: o.gamma, beta: o.beta,
  });
  return directResultView(res, nodeIndex, freeMap, recPairs);
}
