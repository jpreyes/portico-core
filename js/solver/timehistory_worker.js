// ──────────────────────────────────────────────────────────────────────────────
// timehistory_worker.js — Integrates the modal coordinates qᵢ(t) of the
// time-history off the main thread (#48a/#48d), like modal_worker/buckling_worker.
// The expensive part is the per-mode SDOF recurrence × steps; the spatial
// superposition (u = Σ φᵢ qᵢ) is done by the main thread (cheap) with the mode
// shapes it already has, so the φ need not be sent to the worker.
//
// Protocol:
//   Main → Worker: { modes:[{omega, gamma}], ag:Float64Array, dt, zeta }
//   Worker → Main: { q:[Float64Array]·nModes, peakModal:Float64Array }  |  { error }
// ──────────────────────────────────────────────────────────────────────────────
import { sdofResponse } from './timehistory.js?v=6';

self.onmessage = (e) => {
  const { modes, ag, dt, zeta } = e.data;
  try {
    const nSteps = ag.length, nModes = modes.length;
    const zArr = Array.isArray(zeta) ? zeta : modes.map(() => (zeta ?? 0.05));
    const q = [];
    const peakModal = new Float64Array(nModes);
    for (let i = 0; i < nModes; i++) {
      const G = modes[i].gamma, p = new Float64Array(nSteps);
      for (let k = 0; k < nSteps; k++) p[k] = -G * ag[k];     // −Γ·a_g (modal load)
      const { u } = sdofResponse(modes[i].omega, zArr[i], dt, p);
      q.push(u);
      let pk = 0; for (let k = 0; k < nSteps; k++) pk = Math.max(pk, Math.abs(u[k]));
      peakModal[i] = pk;
    }
    self.postMessage({ q, peakModal });
  } catch (err) {
    self.postMessage({ error: (err && err.message) ? err.message : String(err) });
  }
};
