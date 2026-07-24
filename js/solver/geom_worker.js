// ──────────────────────────────────────────────────────────────────────────────
// geom_worker.js — geometric-nonlinear analyses (P-Delta, linear buckling, plastic
// pushover) off the main thread. Unlike the direct/spectrum workers, these RE-ASSEMBLE
// inside their own loop (Kg depends on u; the plastic tangent changes each hinge
// event), so they need the whole Model — it travels as a serialized .s3d string and is
// reconstructed here. Now that their assemblies are sparse (Phase 2, items 1–3) the
// solves scale, and running them here keeps the UI responsive.
//
// Protocol:
//   Main → Worker: { kind: 'pdelta' | 'buckling' | 'plastic', modelJSON, opts }
//   Worker → Main: { res }  |  { error }
// The results (u/vec Float64Array, events array, Nby/nodeIndex Map<number,number>)
// are all structured-clone-safe.
// ──────────────────────────────────────────────────────────────────────────────
import { Serializer } from '../model/serializer.js?v=7';
import { pDelta, linearBuckling } from './geometric_analysis.js?v=7';
import { solvePlastic } from './plastic.js?v=7';

self.onmessage = (e) => {
  const { kind, modelJSON, opts } = e.data;
  try {
    const model = new Serializer().fromJSON(modelJSON);
    const res = kind === 'pdelta'   ? pDelta(model, opts)
              : kind === 'buckling' ? linearBuckling(model, opts)
              : kind === 'plastic'  ? solvePlastic(model, opts)
              : (() => { throw new Error('kind desconocido: ' + kind); })();
    self.postMessage({ res });
  } catch (err) {
    self.postMessage({ error: (err && err.message) ? err.message : String(err) });
  }
};
