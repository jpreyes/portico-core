// ──────────────────────────────────────────────────────────────────────────────
// direct_worker.js — runs the LINEAR direct time integration (Newmark-β) off the
// main thread. The model-dependent assembly happens on the main thread
// (assembleDirectSystem); this worker receives only plain, transferable data — the
// CSR matrices K/M, the influence vector, the accelerogram and the parameters — and
// returns the recorded histories, the per-DOF peaks and (optionally) the full
// displacement buffer for playback. All large arrays are transferred zero-copy.
//
// Contract:
//   in  : { K, M, iota, ag, dt, a0, a1, recordIdx, keepAll, solver, factorMax, pcgTol,
//           gamma, beta }
//         K/M are CSR { n, rowPtr, colIdx, val }.
//   out : { peak, histEntries:[[idx, Float64Array]], U?, nSteps, n, solver, avgIters }
//         (error → { error }).
// ──────────────────────────────────────────────────────────────────────────────
import { newmarkLinear } from './direct_integration.js?v=7';

self.onmessage = (ev) => {
  try {
    const d = ev.data;
    const res = newmarkLinear({
      K: d.K, M: d.M, iota: d.iota, ag: d.ag, dt: d.dt,
      a0: d.a0, a1: d.a1, record: d.recordIdx || [],
      keepAll: !!d.keepAll, solver: d.solver, factorMax: d.factorMax,
      pcgTol: d.pcgTol, gamma: d.gamma, beta: d.beta,
    });

    // hist is a Map<idx, Float64Array>; flatten to transferable entries.
    const histEntries = [...(res.hist || new Map()).entries()];
    const transfer = [res.peak.buffer, ...histEntries.map(([, h]) => h.buffer)];
    if (res.U) transfer.push(res.U.buffer);

    self.postMessage({
      peak: res.peak, histEntries, U: res.U, nSteps: res.nSteps, n: res.n,
      solver: res.solver, avgIters: res.avgIters,
    }, transfer);
  } catch (err) {
    self.postMessage({ error: err.message || String(err) });
  }
};
