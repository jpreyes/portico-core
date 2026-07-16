// test_nch433_spectrum.mjs — the unified NCh433/DS61 spectrum reproduces every copy it
// replaces, exactly. The point of this module is to be a drop-in for four drifted copies,
// so the test computes each copy's formula INDEPENDENTLY here and demands equality.
//
//   app.js dialog : Sa = S·Ao·I·α(T)/R*   , dT=0.05   (R* baked in)
//   assistant/loads.js : Sa = S·Ao·I·α(T) , dT=0.02   (R* applied separately)
//   R* = 1 + T*/(0.10·To + T*/Ro)   , T*≤0 → 1 (elastic)
//   α(T) = (1 + 4.5·(T/To)^p) / (1 + (T/To)^3)
//
// Run:  node test_nch433_spectrum.mjs
import {
  buildSpectrum, alphaNCh433, rStar,
  NCH433_SOILS, NCH433_ZONES, NCH433_CATEGORIES,
} from './js/design/nch433_spectrum.js';

let failures = 0;
const check = (cond, msg, extra = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const rel = (a, b) => Math.abs(b) < 1e-15 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b);

// Independent reference formulas (NOT importing the module's internals).
const alphaRef = (T, To, p) => (1 + 4.5 * (T / To) ** p) / (1 + (T / To) ** 3);
const rStarRef = (Ts, To, Ro) => (Ts > 0) ? 1 + Ts / (0.10 * To + Ts / Ro) : 1;

// ── (1) α and R* against independent formulas ────────────────────────────────
console.log('\n── (1) α(T) and R* ──');
{
  check(rel(alphaNCh433(0.5, 0.75, 1.0), alphaRef(0.5, 0.75, 1.0)) < 1e-12, 'α matches the reference');
  check(alphaNCh433(0, 0.75, 1.0) === 1, 'α(0) = 1');
  const R = rStar(0.5, 0.75, 11);
  check(rel(R, rStarRef(0.5, 0.75, 11)) < 1e-12, 'R* matches the reference', `(${R.toFixed(4)})`);
  check(rStar(0, 0.75, 11) === 1, 'T*=0 → R*=1 (elastic)');
  check(rStar(null, 0.75, 11) === 1, 'T*=null → R*=1 (elastic)');
}

// ── (2) Reproduce the app.js dialog exactly (R* baked, dT=0.05) ───────────────
console.log('\n── (2) app.js dialog: Sa = S·Ao·I·α/R*, dT=0.05 ──');
{
  const soil = 'D', zone = 2, cat = 'II', Ro = 11, Tstar = 0.5;
  const su = NCH433_SOILS[soil], Ao = NCH433_ZONES[zone], I = NCH433_CATEGORIES[cat];
  const R = rStarRef(Tstar, su.To, Ro);
  const { curve, Rstar, Sa0 } = buildSpectrum({ soil, zone, category: cat, Ro, Tstar });
  check(rel(Rstar, R) < 1e-12, 'R* returned matches', `(${Rstar.toFixed(4)})`);
  check(rel(curve[1].T - curve[0].T, 0.05) < 1e-9, 'dT = 0.05', `(${(curve[1].T - curve[0].T).toFixed(3)})`);
  let worst = 0;
  for (const { T, Sa } of curve) {
    const ref = +(su.S * Ao * I * alphaRef(T, su.To, su.p) / R).toFixed(6);
    worst = Math.max(worst, Math.abs(Sa - ref));
  }
  check(worst < 1e-9, 'every Sa(T) equals S·Ao·I·α(T)/R*', `(máx Δ ${worst.toExponential(1)})`);
  check(Sa0 === +(su.S * Ao * I / R).toFixed(6), 'Sa(0) = S·Ao·I/R*', `(${Sa0.toFixed(4)} g)`);
}

// ── (3) Reproduce assistant/loads.js exactly (elastic, dT=0.02) ──────────────
console.log('\n── (3) assistant/loads.js: Sa = S·Ao·I·α (elastic), dT=0.02 ──');
{
  const soil = 'C', zone = 3, cat = 'III';
  const su = NCH433_SOILS[soil], Ao = NCH433_ZONES[zone], I = NCH433_CATEGORIES[cat];
  const { curve } = buildSpectrum({ soil, zone, category: cat, applyRstar: false, dT: 0.02 });
  check(rel(curve[1].T - curve[0].T, 0.02) < 1e-9, 'dT = 0.02');
  let worst = 0;
  for (const { T, Sa } of curve) {
    const ref = +(su.S * Ao * I * alphaRef(T, su.To, su.p)).toFixed(6);
    worst = Math.max(worst, Math.abs(Sa - ref));
  }
  check(worst < 1e-9, 'every Sa(T) equals S·Ao·I·α(T) (no R*)', `(máx Δ ${worst.toExponential(1)})`);
}

// ── (4) The tables the app.js copy used to drop ──────────────────────────────
console.log('\n── (4) Tp and n survive (app.js dropped them) ──');
{
  const { params } = buildSpectrum({ soil: 'D', zone: 2, category: 'II' });
  check(params.Tp === 0.85 && params.n === 1.80, 'soil D carries Tp=0.85, n=1.80',
    `(Tp=${params.Tp}, n=${params.n})`);
  check(Object.keys(NCH433_SOILS).length === 5, 'five soil classes A–E');
  check(NCH433_ZONES[1] === 0.20 && NCH433_ZONES[3] === 0.40, 'zones 1..3 → Ao 0.20..0.40');
}

// ── (5) The persisted params shape (app.js gather() drop-in) ─────────────────
console.log('\n── (5) params shape matches app.js gather() ──');
{
  const { params } = buildSpectrum({ soil: 'D', zone: 2, category: 'II', Ro: 11, Tstar: 0.4 });
  for (const k of ['zona', 'suelo', 'cat', 'Ao', 'I', 'S', 'To', 'p', 'Ro', 'Tstar', 'Rstar']) {
    check(k in params, `params has "${k}"`);
  }
  check(params.zona === '2' && params.suelo === 'D' && params.cat === 'II', 'keys carry the inputs back');
}

// ── (6) A bad input fails loudly ─────────────────────────────────────────────
console.log('\n── (6) invalid inputs throw ──');
{
  let threw = false;
  try { buildSpectrum({ soil: 'Z', zone: 2, category: 'II' }); } catch { threw = true; }
  check(threw, 'unknown soil class throws');
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
