// ──────────────────────────────────────────────────────────────────────────────
// serviceability.js — SERVICEABILITY limit states by code (#68).
//
// DEFLECTION and DRIFT (interstory drift) limits per the design code. Independent of
// the analysis: it receives the computed deflection or drift and compares it with the
// code limit, returning the demand/limit ratio.
//
//   · Deflection:  limit = L / divisor   (cantilever → effective span 2·L)
//       IBC/AISC (Table 1604.3): live L/360, total D+L L/240, roof L/180
//       EN 1990 (A1.4):          δmax (total) L/250, δ2 (variable) L/300
//       NCh (practice):          live L/360, total L/300
//   · Allowable drift (Δ/h):
//       NCh433/DS61: 0.002 (at the c.m.)      · ASCE7/IBC: 0.020 (Cat. II)
//       Eurocode 8: 0.010 (non-structural decoupled)
//
// Units: lengths in m (consistent); the ratios are dimensionless.
// ──────────────────────────────────────────────────────────────────────────────

// deflection divisor (limit = L/divisor) by code and use.
const DEFLECTION = {
  'AISC360-16:LRFD': { live: 360, total: 240, roof: 180 },
  'AISC360-16:ASD':  { live: 360, total: 240, roof: 180 },
  'IBC':             { live: 360, total: 240, roof: 180 },
  'EN1993-1-1':      { live: 300, total: 250, roof: 250 },
  'EN1999-1-1':      { live: 300, total: 250, roof: 250 },
  'EN1992-1-1':      { live: 300, total: 250, roof: 250 },
  'ACI318-19':       { live: 360, total: 240, roof: 240 },
  'NCh1198':         { live: 300, total: 300, roof: 300 },
  'NCh':             { live: 360, total: 300, roof: 300 },
  _default:          { live: 360, total: 240, roof: 240 },
};

// allowable story drift (Δ/h) by code.
const DRIFT = {
  'NCh433':   0.002,   // DS61, relative to the center of mass
  'ASCE7':    0.020,   // Risk Category II (the most common)
  'IBC':      0.020,
  'EN1998':   0.010,   // EC8, non-structural decoupled
  'EC8':      0.010,
  _default:   0.020,
};

// Deflection divisor (limit = L/divisor) for a code and use.
export function deflectionDivisor(code, use = 'live') {
  const t = DEFLECTION[code] || DEFLECTION._default;
  return t[use] ?? t.live;
}

/**
 * Serviceability deflection check.
 * @param {object} o { delta (m, actual deflection), L (m, span), code, use='live'|'total'|'roof',
 *                     cantilever=false, divisor (direct override) }
 * @returns { demand, limit, ratio, divisor, luzEfectiva, formula }
 */
export function checkDeflection({ delta, L, code, use = 'live', cantilever = false, divisor }) {
  const div = divisor || deflectionDivisor(code, use);
  const Lef = cantilever ? 2 * L : L;          // cantilever: effective span 2L
  const limit = Lef / div;
  const d = Math.abs(delta);
  return {
    demand: +d.toFixed(6), limit: +limit.toFixed(6),
    ratio: limit > 1e-12 ? +(d / limit).toFixed(4) : Infinity,
    divisor: div, luzEfectiva: +Lef.toFixed(4),
    formula: `δ ≤ ${cantilever ? '2·L' : 'L'}/${div} (servicio ${use}, ${code || 'def.'})`,
  };
}

// Allowable story drift (Δ/h) by code.
export function driftLimit(code) { return DRIFT[code] ?? DRIFT._default; }

/**
 * Story drift check.
 * @param {object} o { drift (m, relative drift), h (m, story height),
 *                     code='NCh433'|'ASCE7'|'EC8', allow (Δ/h limit override) }
 * @returns { demand (Δ/h), limit (Δ/h), ratio, formula }
 */
export function checkDrift({ drift, h, code = 'NCh433', allow }) {
  const lim = allow ?? driftLimit(code);
  const ratio = h > 1e-12 ? Math.abs(drift) / h : 0;
  return {
    demand: +ratio.toFixed(5), limit: +lim.toFixed(5),
    ratio: lim > 1e-12 ? +(ratio / lim).toFixed(4) : Infinity,
    formula: `Δ/h ≤ ${lim} (${code})`,
  };
}
