// ──────────────────────────────────────────────────────────────────────────────
// nl_worker.js — "lite" NONLINEAR solvers (corotational Newton) off the main
// thread, like modal_worker.js / buckling_worker.js. Keeps the UI from freezing on
// large models: the core of `nl_lite.js` uses a DENSE solver (`solveDense` O(n³))
// per Newton iteration × load steps (#44).
//
// Protocol:
//   Main → Worker: { kind: 'nl' | 'dc' | 'corot' | 'shear', opts }
//     'nl'    → solveNonlinear(opts)     (load control; Nonlinear truss/cable)
//     'dc'    → solveNonlinearDC(opts)   (displacement control; Pushover)
//     'corot' → solveCorotBeam(opts)     (large-rotation corotational beam, 1-029)
//     'shear' → runShearHistory(opts)    (elastoplastic shear-building NL time-history)
//   Worker → Main: { res }  |  { error }
//
// `opts` (X/coords, Fref, elems, stories, ag…) and the result (steps/U with
// Float64Array) travel via structured clone, which preserves the typed arrays.
// ──────────────────────────────────────────────────────────────────────────────
import { solveNonlinear, solveNonlinearDC } from './nl_lite.js?v=7';
import { solveCorotBeam } from './corotbeam.js?v=7';
import { runShearHistory } from './shear_building.js?v=7';

self.onmessage = (e) => {
  const { kind, opts } = e.data;
  try {
    let res;
    if (kind === 'shear') {
      res = runShearHistory(opts);
      delete res.springs;   // bilinear-spring objects carry methods → not clone-safe (and unused downstream)
    } else {
      res = kind === 'corot' ? solveCorotBeam(opts)
          : kind === 'dc'    ? solveNonlinearDC(opts)
          :                    solveNonlinear(opts);
    }
    self.postMessage({ res });
  } catch (err) {
    self.postMessage({ error: (err && err.message) ? err.message : String(err) });
  }
};
