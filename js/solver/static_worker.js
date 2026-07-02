// ──────────────────────────────────────────────────────────────────────────────
// static_worker.js — solves K·u = F for ALL static cases off the main thread (the
// UI does not freeze). Module worker (imports linsolve.js as ESM).
//
//   Main → Worker: { Kflat: Float64Array(nDOF²), nDOF, freeDOF: Int32Array, Flist: [Float64Array(nDOF)] }
//   Worker → Main: { progress, done, total }   (progress)
//                  { ok:true, uList, reactionsList, bandwidth }   (success)
//                  { ok:false, error? }   (not SPD / unstable → the main uses a fallback)
//
// Strategy: extract K_ff, factor ONCE (banded Cholesky with RCM) and solve each
// right-hand side. Reactions = K·u − F (in the worker, non-blocking).
// ──────────────────────────────────────────────────────────────────────────────
import { makeFactor, makeFactorCSR } from './linsolve.js?v=2';
import { makeSolverPCG } from './pcg.js?v=2';

self.onmessage = (e) => {
  // SPARSE path: K_ff arrives in CSR + fixed–free coupling (cf). The dense matrix
  // is never materialized.
  if (e.data && e.data.csr) { _solveSparse(e.data); return; }

  const { Kflat, nDOF, freeDOF, Flist, dense } = e.data;
  try {
    const nF = freeDOF.length;
    if (nF === 0) { self.postMessage({ ok: false, error: 'sin GDL libres' }); return; }

    // Extract K_ff (free–free)
    const Kff = new Float64Array(nF * nF);
    for (let i = 0; i < nF; i++) {
      const rowK = freeDOF[i] * nDOF, rowF = i * nF;
      for (let j = 0; j < nF; j++) Kff[rowF + j] = Kflat[rowK + freeDOF[j]];
    }
    // Reduce each F to the free DOFs
    const FfList = Flist.map(F => { const ff = new Float64Array(nF); for (let i = 0; i < nF; i++) ff[i] = F[freeDOF[i]]; return ff; });

    self.postMessage({ progress: 'factorizando', done: 0, total: Flist.length });
    const fac = makeFactor(Kff, nF, !!dense);   // dense (academic) or banded (fast)
    if (!fac.ok) { self.postMessage({ ok: false }); return; }   // not SPD → fallback in the main

    const uList = [], reactionsList = [];
    for (let c = 0; c < Flist.length; c++) {
      const uf = fac.solve(FfList[c]);
      const u = new Float64Array(nDOF);
      for (let i = 0; i < nF; i++) u[freeDOF[i]] = uf[i];
      // reacciones = K·u − F
      const F = Flist[c];
      const reac = new Float64Array(nDOF);
      for (let i = 0; i < nDOF; i++) {
        let s = 0; const off = i * nDOF;
        for (let j = 0; j < nDOF; j++) s += Kflat[off + j] * u[j];
        reac[i] = s - F[i];
      }
      uList.push(u); reactionsList.push(reac);
      self.postMessage({ progress: 'resolviendo', done: c + 1, total: Flist.length });
    }
    self.postMessage({ ok: true, uList, reactionsList, bandwidth: fac.m, kind: fac.kind });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};

// ── Resolution via the SPARSE path ────────────────────────────────────────────
//   { csr:{n,rowPtr,colIdx,val}, cf:{rowDof,ptr,freeIdx,val}, nDOF, freeDOF, Flist, pcg? }
// `pcg` (set by the main thread) requests the iterative solver instead of the direct
// banded Cholesky. The main thread only turns it on for LARGE meshes WITHOUT penalty
// constraints (no rigid diaphragms/links) — where the penalty would inflate κ and
// cripple CG convergence. If the iterative solver fails to converge on any RHS, the
// worker falls back to the direct banded Cholesky here (still sparse), so a bad PCG
// run never returns a wrong answer.
function _solveSparse(data) {
  const { csr, cf, nDOF, freeDOF, Flist } = data;
  let usePcg = !!data.pcg;
  try {
    const nF = freeDOF.length;
    if (nF === 0) { self.postMessage({ ok: false, error: 'sin GDL libres' }); return; }

    // Reduce each RHS to the free DOFs once.
    const FfList = Flist.map(F => { const ff = new Float64Array(nF); for (let i = 0; i < nF; i++) ff[i] = F[freeDOF[i]]; return ff; });

    for (let attempt = 0; ; attempt++) {
      self.postMessage({ progress: 'factorizando', done: 0, total: Flist.length });
      const fac = usePcg ? makeSolverPCG(csr, { pre: 'ic0' }) : makeFactorCSR(csr);   // RCM+banded Cholesky, or PCG (matrix-free)
      if (!fac.ok) { self.postMessage({ ok: false }); return; }   // direct not SPD → fallback in the main

      const uList = [], reactionsList = [];
      let diverged = false;
      for (let c = 0; c < Flist.length; c++) {
        const F = Flist[c];
        const uf = fac.solve(FfList[c]);
        if (usePcg && uf._ok === false) { diverged = true; break; }   // PCG stalled → retry direct

        const u = new Float64Array(nDOF);
        for (let i = 0; i < nF; i++) u[freeDOF[i]] = uf[i];

        // Reactions ONLY at fixed DOFs with coupling: reac = K[fixed,free]·u_f − F
        const reac = new Float64Array(nDOF);
        const { rowDof, ptr, freeIdx, val } = cf;
        for (let r = 0; r < rowDof.length; r++) {
          let s = 0;
          for (let p = ptr[r]; p < ptr[r + 1]; p++) s += val[p] * uf[freeIdx[p]];
          reac[rowDof[r]] = s - F[rowDof[r]];
        }

        uList.push(u); reactionsList.push(reac);
        self.postMessage({ progress: 'resolviendo', done: c + 1, total: Flist.length });
      }

      if (diverged) { usePcg = false; continue; }   // one retry with the direct factor
      self.postMessage({ ok: true, uList, reactionsList, bandwidth: fac.m || 0, kind: usePcg ? fac.kind : 'banda·dispersa' });
      return;
    }
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
}
