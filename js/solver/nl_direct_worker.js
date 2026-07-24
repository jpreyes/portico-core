// ──────────────────────────────────────────────────────────────────────────────
// nl_direct_worker.js — NONLINEAR direct time integration (HHT-α + Newton, planar
// corotational) off the main thread. Like geom_worker, it RE-ASSEMBLES the tangent
// and internal force every Newton iteration, so it needs the whole Model — it travels
// as a serialized .s3d string and is reconstructed here.
//
// Protocol:
//   Main → Worker: { modelJSON, opts }   (opts: ag, dt, direction, a0, a1, alpha)
//   Worker → Main: { U, peak, nF, nSteps, freeMap3, nodeIds, avgNewton, notConverged, ok }
//                  | { error }  |  { ok:false, reason }
// U is the full nSteps×nF planar free-DOF field (kept for the overlay/animation); the
// main thread wraps it into a 6-DOF result view (ux←u, uz←w, ry←θ).
// ──────────────────────────────────────────────────────────────────────────────
import { Serializer } from '../model/serializer.js?v=7';
import { nlDirectTimeHistory } from './nl_direct.js?v=7';

self.onmessage = (e) => {
  const { modelJSON, opts } = e.data;
  try {
    const model = new Serializer().fromJSON(modelJSON);
    const res = nlDirectTimeHistory(model, { ...opts, keepAll: true });
    if (!res.ok) { self.postMessage({ ok: false, reason: res.reason }); return; }

    // Free-index → global planar DOF map, so the main thread can rebuild a 6-DOF freeMap.
    const out = {
      ok: true, U: res.U, peak: res.peak, nF: res.nF, nSteps: res.nSteps,
      freeMap3: res.freeMap, nodeIds: res.nodeIds,
      avgNewton: res.avgNewton, notConverged: res.notConverged,
    };
    const transfer = [res.U.buffer, res.peak.buffer];   // large buffers, zero-copy
    self.postMessage(out, transfer);
  } catch (err) {
    self.postMessage({ error: (err && err.message) ? err.message : String(err) });
  }
};
