// ──────────────────────────────────────────────────────────────────────────────
// geometric_analysis.js — geometric-nonlinear analyses (headless): linear buckling
// and P-Delta. Composition layer above the primitives it drives:
//   · assembleK / assembleF  (elastic K and the reference load)   — assembler.js
//   · assembleKg             (geometric stiffness from the axial state) — geometric.js
//   · solveBuckling          ((K+λ·Kg)φ=0 subspace eigensolver)   — buckling.js
//   · makeFactor             (banded/dense Cholesky)              — linsolve.js
//
// Both analyses were inlined in app.js's runBuckling/runPDelta, unreachable outside
// the DOM. Here they are pure functions of (model, opts) that return the modes / the
// amplified displacement field, or a structured refusal `reason` the caller maps to
// its own message. The dialogs, progress, toasts and overlay stay in app.js.
// ──────────────────────────────────────────────────────────────────────────────
import { buildNodeIndex, assembleK, assembleF, getNodeDOFs } from './assembler.js?v=7';
import { assembleKg, assembleKgInto } from './geometric.js?v=7';
import { solveBuckling, solveBucklingCSR } from './buckling.js?v=7';
import { makeFactor, makeFactorCSR, permRCMcsr, csrLinComb } from './linsolve.js?v=7';
import { SparseSym, assembleSparseGlobal, extractFreeCSR } from './sparse.js?v=7';

/**
 * Reference geometric problem shared by buckling and P-Delta: the full elastic K, the
 * combined reference load F (every static case at factor 1; spectral cases skipped),
 * and the free-DOF list (2D mode locks uy/rx/rz).
 * @returns {{nodeIndex:Map, K:Float64Array, nDOF:number, freeDOF:number[], F:Float64Array, nCasos:number}}
 */
// Free-DOF list + reference load (no K assembly). Shared by the dense buildGeomProblem
// and the sparse P-Delta path so they combine the load cases identically.
export function buildGeomLoads(model, contribs = null) {
  const nodeIndex = buildNodeIndex(model);
  const nDOF = nodeIndex.size * 6;
  const is2D = model.mode === '2D';
  const freeDOF = [];
  for (const node of model.nodes.values()) {
    const d = getNodeDOFs(nodeIndex, node.id), r = node.restraints;
    const rArr = [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz];
    d.forEach((gi, li) => { if (!rArr[li]) freeDOF.push(gi); });
  }
  // Reference load: an explicit `contribs` pattern (each case with its factor and
  // self-weight flag), or — when omitted — every static case at factor 1.
  const F = new Float64Array(nDOF);
  let nCasos = 0;
  if (contribs) {
    for (const c of contribs) {
      const lc = model.loadCases.get(c.lcId); if (!lc) continue;
      const Fi = assembleF(model, nodeIndex, c.lcId, !!c.selfWeight);
      for (let i = 0; i < nDOF; i++) F[i] += c.factor * Fi[i];
      nCasos++;
    }
  } else {
    for (const lc of model.loadCases.values()) {
      if (lc.type === 'spectrum') continue;
      const Fi = assembleF(model, nodeIndex, lc.id, !!lc.selfWeight);
      for (let i = 0; i < nDOF; i++) F[i] += Fi[i];
      nCasos++;
    }
  }
  return { nodeIndex, nDOF, freeDOF, F, nCasos };
}

export function buildGeomProblem(model, contribs = null) {
  const base = buildGeomLoads(model, contribs);
  const { K } = assembleK(model, base.nodeIndex);
  return { nodeIndex: base.nodeIndex, K, nDOF: base.nDOF, freeDOF: base.freeDOF, F: base.F, nCasos: base.nCasos };
}

// Largest translational displacement magnitude over the model's nodes.
export function maxTransDisp(u, model, nodeIndex) {
  let mx = 0;
  for (const node of model.nodes.values()) {
    const d = getNodeDOFs(nodeIndex, node.id);
    mx = Math.max(mx, Math.hypot(u[d[0]], u[d[1]], u[d[2]]));
  }
  return mx;
}

/**
 * Linear buckling: (K + λ·Kg)·φ = 0. Solves the reference state K·u = F (banded
 * Cholesky) to get the axial force for Kg, then extracts the smallest λcr in a block
 * by subspace iteration. Works for frame members (Nmax) and shells (membrane Kg).
 *
 * @param {Model}  model
 * @param {object} [o]
 * @param {number} [o.nModes=6]  modes to extract
 * @param {boolean}[o.dense=false] dense factorization instead of banded
 * @param {{lcId:number,factor:number,selfWeight:boolean}[]|null} [o.contribs]  reference
 *        load pattern; null (default) → every static case at factor 1.
 * @returns {{ok:false, reason:string, message?:string}
 *          | {ok:true, modes:{lambda:number,vec:Float64Array}[], Nby:Map, nCasos:number, nodeIndex:Map}}
 *   reason ∈ 'no-free-dof' | 'no-loads' | 'ref-singular' | 'no-kg' | 'solver-error' | 'no-modes'.
 */
export function linearBuckling(model, { nModes = 6, dense = false, contribs = null } = {}) {
  const base = buildGeomLoads(model, contribs);
  const { nodeIndex, nDOF, freeDOF, F, nCasos } = base;
  if (!freeDOF.length) return { ok: false, reason: 'no-free-dof' };
  if (!nCasos) return { ok: false, reason: 'no-loads' };
  const nF = freeDOF.length;
  const Ff = new Float64Array(nF); for (let i = 0; i < nF; i++) Ff[i] = F[freeDOF[i]];

  let buckResult, Nby;

  if (dense) {
    // ── Dense path (legacy; small models) ──
    const { K } = assembleK(model, nodeIndex);
    const Kff_flat = new Float64Array(nF * nF);
    for (let i = 0; i < nF; i++) { const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) Kff_flat[i * nF + j] = K[ri + freeDOF[j]]; }
    const fac = makeFactor(Kff_flat, nF, true);
    if (!fac.ok) return { ok: false, reason: 'ref-singular' };
    const u = new Float64Array(nDOF); { const ufA = fac.solve(Ff); for (let i = 0; i < nF; i++) u[freeDOF[i]] = ufA[i]; }
    const kg = assembleKg(model, nodeIndex, u); Nby = kg.Nby;
    const Kgff_flat = new Float64Array(nF * nF);
    let kgMax = 0;
    for (let i = 0; i < nF; i++) { const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) { const v = kg.Kg[ri + freeDOF[j]]; Kgff_flat[i * nF + j] = v; if (Math.abs(v) > kgMax) kgMax = Math.abs(v); } }
    if (kgMax < 1e-12) return { ok: false, reason: 'no-kg' };
    buckResult = solveBuckling({ Kff_flat, Kgff_flat, nF, nModes, dense: true });
  } else {
    // ── Sparse path (default; no dense nF²) ──
    const freeMap = new Int32Array(nDOF).fill(-1); for (let i = 0; i < nF; i++) freeMap[freeDOF[i]] = i;
    const { S: Ks } = assembleSparseGlobal(model, nodeIndex);
    const Kcsr = extractFreeCSR(Ks, freeMap, nF).csr;

    // Reference state K·u = F (banded Cholesky from CSR) → axial force for Kg.
    const fac = makeFactorCSR(Kcsr, permRCMcsr(Kcsr));
    if (!fac.ok) return { ok: false, reason: 'ref-singular' };
    const u = new Float64Array(nDOF); { const ufA = fac.solve(Ff); for (let i = 0; i < nF; i++) u[freeDOF[i]] = ufA[i]; }

    const Kgs = new SparseSym(nDOF);
    const kg = assembleKgInto(Kgs.writer(), model, nodeIndex, u); Nby = kg.Nby;
    const Kgcsr = extractFreeCSR(Kgs, freeMap, nF).csr;
    let kgMax = 0; for (const v of Kgcsr.val) if (Math.abs(v) > kgMax) kgMax = Math.abs(v);
    if (kgMax < 1e-12) return { ok: false, reason: 'no-kg' };
    buckResult = solveBucklingCSR({ Kcsr, Kgcsr, nF, nModes });
  }
  if (buckResult.error) return { ok: false, reason: 'solver-error', message: buckResult.error };

  // Expand each mode (vec in free DOFs) to the global vector indexed by nDOF.
  const modes = buckResult.modes.map(m => {
    const vec = new Float64Array(nDOF);
    for (let i = 0; i < nF; i++) vec[freeDOF[i]] = m.vec[i];
    return { lambda: m.lambda, vec };
  });
  if (!modes.length) return { ok: false, reason: 'no-modes' };

  return { ok: true, modes, Nby, nCasos, nodeIndex };   // Nby = reference axial force per element
}

/**
 * P-Delta: solves the geometrically-nonlinear (K + Kg(u))·u = F by fixed-point
 * iteration on the tangent (frames). Returns the amplified field and the linear vs
 * P-Delta peak displacement so the caller can report the amplification.
 *
 * @param {Model}  model
 * @param {object} [o]
 * @param {boolean}[o.dense=false]   dense factorization instead of banded
 * @param {number} [o.maxIter=25]    iteration cap
 * @param {number} [o.tol=1e-6]      relative-displacement convergence tolerance
 * @returns {{ok:false, reason:string}
 *          | {ok:true, u:Float64Array, dLin:number, dPD:number, amp:number,
 *             conv:boolean, it:number, nodeIndex:Map}}
 *   reason ∈ 'no-free-dof' | 'no-loads' | 'linear-singular' | 'linear-nan'
 *          | 'tangent-singular' | 'diverged'.
 */
export function pDelta(model, { dense = false, maxIter = 25, tol = 1e-6 } = {}) {
  const { nodeIndex, nDOF, freeDOF, F, nCasos } = buildGeomLoads(model);
  if (!freeDOF.length) return { ok: false, reason: 'no-free-dof' };
  if (!nCasos) return { ok: false, reason: 'no-loads' };
  const nF = freeDOF.length;
  const Ff = new Float64Array(nF); for (let i = 0; i < nF; i++) Ff[i] = F[freeDOF[i]];

  // ── Dense path (small models / exact legacy behaviour) ──────────────────────
  if (dense) {
    const { K } = assembleK(model, nodeIndex);
    const Kff = new Float64Array(nF * nF);
    for (let i = 0; i < nF; i++) { const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) Kff[i * nF + j] = K[ri + freeDOF[j]]; }
    const fac0 = makeFactor(Kff, nF, true);
    if (!fac0.ok) return { ok: false, reason: 'linear-singular' };
    const uf = fac0.solve(Ff);
    if (!uf || uf.some(v => !isFinite(v))) return { ok: false, reason: 'linear-nan' };
    let u = new Float64Array(nDOF); for (let i = 0; i < nF; i++) u[freeDOF[i]] = uf[i];
    const dLin = maxTransDisp(u, model, nodeIndex);
    let conv = false, it = 0;
    for (it = 0; it < maxIter; it++) {
      const { Kg } = assembleKg(model, nodeIndex, u);
      const KT = new Float64Array(nF * nF);
      for (let i = 0; i < nF; i++) { const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) KT[i * nF + j] = Kff[i * nF + j] + Kg[ri + freeDOF[j]]; }
      const fac = makeFactor(KT, nF, true);
      if (!fac.ok) return { ok: false, reason: 'tangent-singular' };
      const uf2 = fac.solve(Ff);
      if (!uf2 || uf2.some(v => !isFinite(v))) return { ok: false, reason: 'diverged' };
      const uNew = new Float64Array(nDOF); for (let i = 0; i < nF; i++) uNew[freeDOF[i]] = uf2[i];
      let dn = 0, de = 0; for (let i = 0; i < nDOF; i++) { dn += (uNew[i] - u[i]) ** 2; de += uNew[i] ** 2; }
      u = uNew;
      if (de > 0 && Math.sqrt(dn / de) < tol) { conv = true; it++; break; }
    }
    const dPD = maxTransDisp(u, model, nodeIndex);
    return { ok: true, u, dLin, dPD, amp: dLin > 1e-12 ? dPD / dLin : 1, conv, it, nodeIndex };
  }

  // ── Sparse path (default; no dense nDOF² matrix → scales) ────────────────────
  // Elastic K (CSR over the free DOFs); the tangent Kt = K + Kg(u) is re-formed and
  // re-factored (banded Cholesky) each iteration. Same fixed-point iteration as the
  // dense path, just without ever materializing an nDOF² matrix.
  const freeMap = new Int32Array(nDOF).fill(-1); for (let i = 0; i < nF; i++) freeMap[freeDOF[i]] = i;
  const { S: Ks } = assembleSparseGlobal(model, nodeIndex);
  const Kcsr = extractFreeCSR(Ks, freeMap, nF).csr;

  const fac0 = makeFactorCSR(Kcsr, permRCMcsr(Kcsr));
  if (!fac0.ok) return { ok: false, reason: 'linear-singular' };
  const uf = fac0.solve(Ff);
  if (!uf || uf.some(v => !isFinite(v))) return { ok: false, reason: 'linear-nan' };
  let u = new Float64Array(nDOF); for (let i = 0; i < nF; i++) u[freeDOF[i]] = uf[i];
  const dLin = maxTransDisp(u, model, nodeIndex);

  let conv = false, it = 0;
  for (it = 0; it < maxIter; it++) {
    const Kgs = new SparseSym(nDOF);
    assembleKgInto(Kgs.writer(), model, nodeIndex, u);
    const Kgcsr = extractFreeCSR(Kgs, freeMap, nF).csr;
    const Ktcsr = csrLinComb(Kcsr, 1, Kgcsr, 1);
    const fac = makeFactorCSR(Ktcsr, permRCMcsr(Ktcsr));
    if (!fac.ok) return { ok: false, reason: 'tangent-singular' };
    const uf2 = fac.solve(Ff);
    if (!uf2 || uf2.some(v => !isFinite(v))) return { ok: false, reason: 'diverged' };
    const uNew = new Float64Array(nDOF); for (let i = 0; i < nF; i++) uNew[freeDOF[i]] = uf2[i];
    let dn = 0, de = 0; for (let i = 0; i < nDOF; i++) { dn += (uNew[i] - u[i]) ** 2; de += uNew[i] ** 2; }
    u = uNew;
    if (de > 0 && Math.sqrt(dn / de) < tol) { conv = true; it++; break; }
  }
  const dPD = maxTransDisp(u, model, nodeIndex);
  return { ok: true, u, dLin, dPD, amp: dLin > 1e-12 ? dPD / dLin : 1, conv, it, nodeIndex };
}
