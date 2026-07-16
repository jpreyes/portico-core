// ──────────────────────────────────────────────────────────────────────────────
// nch433_spectrum.js — NCh433/DS61 design spectrum, in ONE place.
//
// The spectrum lived in four copies that had drifted apart: the interactive dialog in
// app.js (tables inline, R* baked into Sa, dT=0.05), a second copy in the same dialog's
// `gather()` that recomputed R*, assistant/loads.js (tables from rules.json, R* applied
// separately, dT=0.02), and the tables again in assistant/rules.json. This module is the
// single source of truth they should all call.
//
// The SHAPE of the spectrum — the α and R* formulas — is fixed by NCh433/DS61 and is
// Chilean, not jurisdiction-agnostic. The TABLE VALUES (soil S/To/Tp/n/p, zone Ao,
// category I) are what a country preset would override, so buildSpectrum() accepts a
// `tables` override; omitting it uses the DS61 defaults embedded here (complete, with the
// Tp and n columns the app.js copy used to drop).
//
//   Sa(T) = S · Ao · I · α(T) / R*        [g]
//   α(T)  = (1 + 4.5·(T/To)^p) / (1 + (T/To)^3)
//   R*    = 1 + T* / (0.10·To + T*/Ro)     (T* from the modal; T*≤0 → R*=1, elastic)
// ──────────────────────────────────────────────────────────────────────────────

// Soil classes A–E: S, To[s], Tp[s], n, p. DS61 example values.
export const NCH433_SOILS = {
  A: { S: 0.90, To: 0.15, Tp: 0.20, n: 1.00, p: 2.0 },
  B: { S: 1.00, To: 0.30, Tp: 0.35, n: 1.33, p: 1.5 },
  C: { S: 1.05, To: 0.40, Tp: 0.45, n: 1.40, p: 1.6 },
  D: { S: 1.20, To: 0.75, Tp: 0.85, n: 1.80, p: 1.0 },
  E: { S: 1.30, To: 1.20, Tp: 1.35, n: 1.80, p: 1.0 },
};

// Seismic zone → effective acceleration Ao [g].
export const NCH433_ZONES = { 1: 0.20, 2: 0.30, 3: 0.40 };

// Building category → importance factor I.
export const NCH433_CATEGORIES = { I: 0.6, II: 1.0, III: 1.2, IV: 1.2 };

export const NCH433_RO_DEFAULT = 11.0;   // reduction reference R0

// Spectral shape factor α(T).
export function alphaNCh433(T, To, p) {
  return (1 + 4.5 * Math.pow(T / To, p)) / (1 + Math.pow(T / To, 3));
}

// Reduction factor R* from the fundamental period T*. T*≤0 (or null) → 1 (elastic).
export function rStar(Tstar, To, Ro = NCH433_RO_DEFAULT) {
  return (Tstar > 0) ? 1 + Tstar / (0.10 * To + Tstar / Ro) : 1;
}

/**
 * Build the NCh433/DS61 design spectrum.
 *
 * @param {object}  o
 * @param {string}  o.soil       soil class key ('A'…'E')
 * @param {string|number} o.zone seismic zone key (1,2,3)
 * @param {string}  o.category   building category ('I'…'IV')
 * @param {number} [o.Ro]        reduction reference R0 (default 11)
 * @param {number} [o.Tstar]     fundamental period T* from the modal; null → elastic
 * @param {number} [o.Tmax]      max period sampled (default 3.0 s)
 * @param {number} [o.dT]        sampling step (default 0.05 s)
 * @param {boolean}[o.applyRstar] divide Sa by R* (default true). false → elastic Sa and
 *                                R* returned for the caller to apply as saFactor = g/R*.
 * @param {object} [o.tables]    { soils, zones, categories } override (e.g. from a preset).
 * @returns {{ curve:{T,Sa}[], text:string, Rstar:number, Sa0:number, params:object }}
 */
export function buildSpectrum({
  soil = 'D', zone = 2, category = 'II', Ro = NCH433_RO_DEFAULT, Tstar = null,
  Tmax = 3.0, dT = 0.05, applyRstar = true, tables = null,
} = {}) {
  const soils = tables?.soils || NCH433_SOILS;
  const zones = tables?.zones || NCH433_ZONES;
  const cats  = tables?.categories || NCH433_CATEGORIES;

  const su = soils[soil];
  if (!su) throw new Error(`nch433_spectrum: soil class "${soil}" not in table`);
  const Ao = zones[zone] ?? zones[String(zone)];
  if (Ao == null) throw new Error(`nch433_spectrum: zone "${zone}" not in table`);
  const I = cats[category];
  if (I == null) throw new Error(`nch433_spectrum: category "${category}" not in table`);

  const { S, To, Tp, n, p } = su;
  const R = rStar(Tstar, To, Ro);
  const div = applyRstar ? R : 1;

  const curve = [];
  for (let T = 0; T <= Tmax + 1e-9; T += dT) {
    const Tr = +T.toFixed(4);
    curve.push({ T: Tr, Sa: +(S * Ao * I * alphaNCh433(Tr, To, p) / div).toFixed(6) });
  }
  const text = curve.map(q => `${Tr2(q.T)}, ${q.Sa.toFixed(4)}`).join('\n');

  return {
    curve, text, Rstar: R,
    Sa0: +(S * Ao * I / div).toFixed(6),   // Sa at T=0 (α(0)=1)
    // Shaped to match what app.js's gather() persists onto lc.spec.
    params: {
      zona: String(zone), suelo: soil, cat: category,
      Ao, I, S, To, Tp, n, p, Ro,
      Tstar: Tstar > 0 ? Tstar : null, Rstar: R,
    },
  };
}

const Tr2 = (t) => (+t).toFixed(2);
