// ──────────────────────────────────────────────────────────────────────────────
// nl_worker.js — "lite" NONLINEAR solvers (corotational Newton) off the main
// thread, like modal_worker.js / buckling_worker.js. Keeps the UI from freezing on
// large models: the core of `nl_lite.js` uses a DENSE solver (`solveDense` O(n³))
// per Newton iteration × load steps (#44).
//
// Protocol:
//   Main → Worker: { kind: 'nl' | 'dc', opts }
//     'nl' → solveNonlinear(opts)      (load control; Nonlinear)
//     'dc' → solveNonlinearDC(opts)    (displacement control; Pushover)
//   Worker → Main: { res }  |  { error }
//
// `opts` (X, Fref, elems, free…) and the result (steps/path with Float64Array)
// travel via structured clone, which preserves the typed arrays.
// ──────────────────────────────────────────────────────────────────────────────
import { solveNonlinear, solveNonlinearDC } from './nl_lite.js?v=2';

self.onmessage = (e) => {
  const { kind, opts } = e.data;
  try {
    const res = kind === 'dc' ? solveNonlinearDC(opts) : solveNonlinear(opts);
    self.postMessage({ res });
  } catch (err) {
    self.postMessage({ error: (err && err.message) ? err.message : String(err) });
  }
};
