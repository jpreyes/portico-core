// ──────────────────────────────────────────────────────────────────────────────
// buckling_worker.js — LINEAR BUCKLING by subspace iteration, off the main thread
// (like modal_worker.js for the modal). Avoids the freeze of the dense
// `numeric.eig` O(n³) on the UI thread.
//
// Protocol:
//   Main → Worker: { Kff_flat, Kgff_flat, nF, nModes, dense }
//   Worker → Main: { modes: [{lambda, vec}] }  |  { error }
// ──────────────────────────────────────────────────────────────────────────────
import { solveBuckling } from './buckling.js?v=3';

self.onmessage = (e) => {
  const { Kff_flat, Kgff_flat, nF, nModes, dense } = e.data;
  try {
    const res = solveBuckling({ Kff_flat, Kgff_flat, nF, nModes, dense: !!dense });
    if (res.error) { self.postMessage({ error: res.error }); return; }
    // Float64Array → Array for structured postMessage
    self.postMessage({ modes: res.modes.map(m => ({ lambda: m.lambda, vec: Array.from(m.vec) })) });
  } catch (err) {
    self.postMessage({ error: (err && err.message) ? err.message : String(err) });
  }
};
