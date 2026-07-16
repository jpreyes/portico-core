// ──────────────────────────────────────────────────────────────────────────────
// stability.js — UNIFIED STABILITY VERDICT.
//
// PÓRTICO must show the SAME stability verdict for every analysis. Three categories:
//
//   (1) INERT_DOF      — legitimate inert DOF (membrane drilling, 2D out-of-plane).
//                        INFO, NOT instability.
//   (2) MECHANISM      — singular matrix / rigid-body mechanism. ERROR (blocks results).
//   (3) ILL_CONDITIONED— near-singular (solver-level relative pivot below a threshold).
//                        WARNING. NOTE: a penalty diaphragm inflates the largest pivot
//                        (~1e5·kmax) and MASKS near-mechanisms in the pivot ratio, so
//                        this solver-level signal is best-effort; the robust catch is
//                        the DRIFT / DISPLACEMENT sanity below, which reads the RESULTS.
//
// This module is solver-NEUTRAL (no i18n, no DOM): it returns structured warnings
// `{ code, severity, params, message }` (message = Spanish fallback). The UI layer
// localizes by `code` + `params`.
// ──────────────────────────────────────────────────────────────────────────────

// Vocabulary of stability codes.
export const STABILITY = {
  OK:              'STABILITY_OK',
  MECHANISM:       'STABILITY_MECHANISM',        // singular → error, no valid results
  ILL_CONDITIONED: 'STABILITY_ILL_CONDITIONED',  // near-singular pivot (best-effort)
  DRIFT:           'STABILITY_DRIFT',            // excessive inter-story drift (post sanity)
  DISPLACEMENT:    'STABILITY_DISPLACEMENT',     // absurd absolute displacement (post sanity)
  INERT_DOF:       'STABILITY_INERT_DOF',        // legitimate inert DOF (info, not instability)
};

// Thresholds (single source of truth).
export const STABILITY_LIMITS = {
  driftRatio:  1 / 20,   // inter-story drift Δ/h above this → "absurd" (instability hint)
  dispFrac:    0.15,     // |u|_max above this fraction of the model span → absurd
  pivotRatio:  1e-12,    // relative pivot (min/max) below this → near-singular (solver)
};

// Largest bounding-box dimension of the model (for the displacement sanity).
export function modelSpan(model) {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity;
  for (const n of model.nodes.values()) {
    if (n.x < xmin) xmin = n.x; if (n.x > xmax) xmax = n.x;
    if (n.y < ymin) ymin = n.y; if (n.y > ymax) ymax = n.y;
    if (n.z < zmin) zmin = n.z; if (n.z > zmax) zmax = n.z;
  }
  if (!isFinite(xmin)) return 0;
  return Math.max(xmax - xmin, ymax - ymin, zmax - zmin, 0);
}

// Build the near-singular warning from a relative pivot ratio (solver-level, PART 1).
// Returns null if the matrix is well enough conditioned.
export function nearSingularWarning(pivotRatio) {
  if (!(pivotRatio >= 0) || pivotRatio >= STABILITY_LIMITS.pivotRatio) return null;
  return {
    code: STABILITY.ILL_CONDITIONED, severity: 'warning',
    params: { pivotRatio },
    message: `Matriz casi singular (pivote relativo ${pivotRatio.toExponential(1)}): el modelo está cerca de un mecanismo; los resultados pueden ser poco fiables. Revise apoyos y liberaciones.`,
  };
}

// ── PART 2 — sanity from the RESULTS ──────────────────────────────────────────
// `res` is any Results-like object exposing getNodeDisp(nodeId) and (optionally)
// getMaxDisp(). Returns a list of structured warnings (drift / displacement).
export function assessStabilitySanity(model, res, opts = {}) {
  const driftLimit = opts.driftRatio ?? STABILITY_LIMITS.driftRatio;
  const dispFrac   = opts.dispFrac   ?? STABILITY_LIMITS.dispFrac;
  const warnings = [];

  // (a) Inter-story drift from diaphragm floor levels (lateral X–Y motion / height).
  const floors = [...model.diaphragms.values()]
    .map(d => ({ z: d.z, master: d.masterId ?? (d.nodes && d.nodes[0]) }))
    .filter(f => f.master != null && model.nodes.has(f.master))
    .sort((a, b) => a.z - b.z);
  if (floors.length) {
    let prevZ = 0, prevX = 0, prevY = 0;   // base reference at z=0, no displacement
    let worst = 0, info = null;
    for (const f of floors) {
      const d = res.getNodeDisp(f.master);
      const dh = Math.hypot((d[0] || 0) - prevX, (d[1] || 0) - prevY);
      const h = f.z - prevZ;
      if (h > 1e-9) { const ratio = dh / h; if (ratio > worst) { worst = ratio; info = { drift: dh, h, z: f.z }; } }
      prevZ = f.z; prevX = d[0] || 0; prevY = d[1] || 0;
    }
    if (info && worst > driftLimit) {
      warnings.push({
        code: STABILITY.DRIFT, severity: 'warning',
        params: { drift: info.drift, h: info.h, ratio: worst, z: info.z },
        message: `Deriva de entrepiso excesiva: ${(info.drift * 1000).toFixed(0)} mm en h=${info.h} m (H/${(1 / worst).toFixed(0)}). Posible inestabilidad o modelo mal restringido.`,
      });
    }
  }

  // (b) Absurd absolute displacement vs the model span (catches non-diaphragm cases too).
  const span = modelSpan(model);
  const maxU = typeof res.getMaxDisp === 'function' ? res.getMaxDisp() : 0;
  if (span > 0 && maxU > dispFrac * span) {
    warnings.push({
      code: STABILITY.DISPLACEMENT, severity: 'warning',
      params: { maxU, span, frac: maxU / span },
      message: `Desplazamiento máximo desproporcionado: ${(maxU * 1000).toFixed(0)} mm (${(100 * maxU / span).toFixed(0)}% del tamaño del modelo). Posible inestabilidad o modelo mal restringido.`,
    });
  }

  return warnings;
}

// Overall verdict from a list of warnings (for a uniform banner header).
export function stabilityVerdict(warnings) {
  if (!warnings || !warnings.length) return STABILITY.OK;
  if (warnings.some(w => w.severity === 'error')) return STABILITY.MECHANISM;
  return warnings.some(w => w.code === STABILITY.ILL_CONDITIONED) ? STABILITY.ILL_CONDITIONED
       : (warnings[0].code || STABILITY.DRIFT);
}
