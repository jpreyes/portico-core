// ──────────────────────────────────────────────────────────────────────────────
// spectrum_worker.js — response-spectrum combination (SRSS / CQC) off the main
// thread. The model-dependent per-element kinematics are precomputed on the main
// thread (buildSpectrumElemData); this worker receives only plain data — the flat
// Ke/T per element, the modal shapes and the spectrum — runs the O(nModes·nElem)
// force recovery + CQC combination, and returns U and the element forces.
//
// Contract:
//   in  : { elemData, phi, omega, period, genMass, gamma, nDOF, nModes,
//           spectrum, saFactor, zeta, method }
//   out : { U:Float64Array, forces:[[id, forceObj]] }  |  { error }
// ──────────────────────────────────────────────────────────────────────────────
import { spectrumCombine } from './spectrum_solver.js?v=7';

self.onmessage = (e) => {
  try {
    const { U, forces } = spectrumCombine(e.data);
    self.postMessage({ U, forces }, [U.buffer]);   // U zero-copy; forces structured-cloned
  } catch (err) {
    self.postMessage({ error: (err && err.message) ? err.message : String(err) });
  }
};
