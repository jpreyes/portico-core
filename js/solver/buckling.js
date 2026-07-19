// ──────────────────────────────────────────────────────────────────────────────
// buckling.js — LINEAR BUCKLING by SUBSPACE ITERATION (Bathe), reusing the same
// engine as modal analysis.
//
// Problem:  (K + λ·Kg)·φ = 0   ⇔   K·φ = λ·(−Kg)·φ
//   with K symmetric POSITIVE DEFINITE (stable structure) and Kg the geometric
//   stiffness (indefinite; only the compressed members reduce the stiffness).
//   λcr = critical factor → buckling load = λcr × reference load.
//
// The subspace iteration over  X ← K⁻¹·(−Kg)·X  amplifies the components with the
// LARGEST |1/λ|, i.e. it converges to the SMALLEST |λcr| (as a block). At each step
// it reduces to Rayleigh-Ritz and solves the small q×q problem with `smallGenEig`,
// doing the Cholesky reduction on Kᵣ = XᵀKX (which IS SPD; −Kg is not).
// Since `smallGenEig(A,B)` solves A·v=ν·B·v with B SPD, we call
//   smallGenEig((−Kg)ᵣ, Kᵣ)  ⇒  ν = 1/λ.  The largest |ν| ⇒ the smallest |λcr|.
//
// SELF-CONTAINED except for linsolve.js (banded factorization) and subspace.js (core
// shared with the modal solver). Reusable in Node + browser + Worker.
// ──────────────────────────────────────────────────────────────────────────────
import { makeFactor, rowBands, permRCM } from './linsolve.js?v=4';
import { smallGenEig, mvBand, dot } from './subspace.js?v=4';

/**
 * @param {object} o
 *   Kff_flat   Float64Array(nF·nF)  elastic stiffness of the free DOFs (SPD)
 *   Kgff_flat  Float64Array(nF·nF)  geometric stiffness of the free DOFs (Kg)
 *   nF         number               number of free DOFs
 *   nModes     number               number of buckling modes to extract
 *   dense      boolean              true = dense Cholesky (no reordering)
 * @returns { modes:[{lambda, vec}] } | { error }
 *   vec in the ORIGINAL order of the free DOFs (length nF).
 */
export function solveBuckling(o) {
  const { Kff_flat, Kgff_flat, nF, nModes, dense = false } = o;
  if (nF === 0) return { error: 'Sin GDL libres.' };
  const p = Math.max(1, Math.min(nModes, nF));

  // ── Reorder K and −Kg to banded form (RCM on K) once ────────────────────────
  // In banded form the factorization, the solve and the matrix·vector products are
  // O(n·b). We work in the permuted space; the modes are un-permuted at the end.
  const negKg = new Float64Array(nF * nF);
  for (let i = 0; i < nF * nF; i++) negKg[i] = -Kgff_flat[i];

  let Kp = Kff_flat, Bp = negKg, perm = null, facPerm = null;
  if (!dense) {
    perm = permRCM(Kff_flat, nF);
    facPerm = new Int32Array(nF); for (let i = 0; i < nF; i++) facPerm[i] = i;
    Kp = new Float64Array(nF * nF); Bp = new Float64Array(nF * nF);
    for (let i = 0; i < nF; i++) {
      const pi = perm[i] * nF, oi = i * nF;
      for (let j = 0; j < nF; j++) { const pj = perm[j]; Kp[oi + j] = Kff_flat[pi + pj]; Bp[oi + j] = negKg[pi + pj]; }
    }
  }

  const fac = makeFactor(Kp, nF, !!dense, facPerm);
  if (!fac.ok) return { error: 'Factorización de K falló (¿estructura inestable / sin apoyos?).' };

  const KB = rowBands(Kp, nF), BB = rowBands(Bp, nF);
  const mvK = (x) => mvBand(Kp, x, nF, KB.lo, KB.hi);
  const mvB = (x) => mvBand(Bp, x, nF, BB.lo, BB.hi);   // product with (−Kg)
  const solveK = (b) => fac.solve(b);

  const modes = _subspaceBuckling(mvK, mvB, solveK, nF, p);
  if (!modes.length) return { error: 'No se hallaron modos de pandeo (la carga de referencia no produce compresión). Revise su sentido.' };

  // Un-permute the vectors back to the original order
  if (perm) for (const md of modes) {
    const v = new Float64Array(nF); for (let i = 0; i < nF; i++) v[perm[i]] = md.vec[i]; md.vec = v;
  }
  return { modes };
}

// ── Subspace iteration for buckling — extracts the p SMALLEST |λcr| as a block ─
function _subspaceBuckling(mvK, mvB, solveK, nF, p) {
  const q = Math.min(nF, Math.max(p + 8, 2 * p));   // subspace size
  // Deterministic seed (identical shape to the modal one)
  let X = [];
  for (let c = 0; c < q; c++) {
    const v = new Float64Array(nF);
    for (let i = 0; i < nF; i++) v[i] = Math.sin((c + 1) * 0.7 * (i + 1)) + 0.3 * Math.cos((c + 1) * (i + 0.5)) + (c === 0 ? 1 : 0);
    X.push(v);
  }

  let prevLam = null, lastModes = null;
  for (let iter = 0; iter < 60; iter++) {
    const Xb = X.map(col => solveK(mvB(col)));        // K⁻¹ (−Kg) X
    const KXb = Xb.map(col => mvK(col)), BXb = Xb.map(col => mvB(col));
    const Kr = [], Br = [];
    for (let a = 0; a < q; a++) {
      Kr.push(new Float64Array(q)); Br.push(new Float64Array(q));
      for (let b = 0; b < q; b++) { Kr[a][b] = dot(Xb[a], KXb[b], nF); Br[a][b] = dot(Xb[a], BXb[b], nF); }
    }
    // (−Kg)ᵣ·v = ν·Kᵣ·v, Kᵣ SPD ⇒ ν = 1/λ.  vals ascending, vecs Kᵣ-orthonormal.
    const { vals: nu, vecs } = smallGenEig(Br, Kr, q);

    // Sort by |ν| DESCENDING (largest |ν| = smallest |λcr|, the iteration's dominant).
    const order = Array.from({ length: q }, (_, k) => k).sort((a, b) => Math.abs(nu[b]) - Math.abs(nu[a]));

    // Rebuild the subspace (all directions, reordered by dominance).
    const Xnew = [];
    for (let c = 0; c < q; c++) {
      const k = order[c], v = new Float64Array(nF);
      for (let r = 0; r < q; r++) { const qc = vecs[k][r], xr = Xb[r]; if (qc) for (let i = 0; i < nF; i++) v[i] += qc * xr[i]; }
      Xnew.push(v);
    }
    X = Xnew;

    // Candidate modes = the q in dominance order, with λ = 1/ν.
    lastModes = order.map((k, c) => ({ lambda: nu[k] !== 0 ? 1 / nu[k] : Infinity, vec: X[c] }));

    // Convergence on the |λ| of the p dominant modes with finite ν ≠ 0.
    const lamP = lastModes.slice(0, p).map(m => m.lambda);
    if (prevLam) {
      let ok = true;
      for (let i = 0; i < p; i++) {
        const a = lamP[i], b = prevLam[i];
        if (!isFinite(a) || !isFinite(b)) continue;
        if (Math.abs(a - b) / Math.max(Math.abs(a), 1e-12) > 1e-6) { ok = false; break; }
      }
      if (ok && iter >= 2) break;
    }
    prevLam = lamP.slice();
  }

  // Filter λ > 0 (compression → buckling under the applied load in its direction),
  // finite, and sort ascending. Keep the first p.
  return lastModes
    .filter(m => isFinite(m.lambda) && m.lambda > 1e-9)
    .sort((a, b) => a.lambda - b.lambda)
    .slice(0, p)
    .map(m => ({ lambda: m.lambda, vec: m.vec }));
}
