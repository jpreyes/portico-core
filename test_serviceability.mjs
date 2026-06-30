// test_serviceability.mjs — verificación de los límites de servicio (#68)
//   node test_serviceability.mjs
import { checkDeflection, checkDrift, deflectionDivisor, driftLimit } from './js/design/serviceability.js';

let fails = 0;
const ok = (name, got, exp, tol) => { const e = Math.abs(got - exp) / (Math.abs(exp) || 1); const p = e <= tol; if (!p) fails++; console.log(`${p ? '✓' : '✗'} ${name}: got=${got} exp=${exp} err=${(e * 100).toFixed(2)}%`); };
const assert = (name, c, info = '') => { if (!c) fails++; console.log(`${c ? '✓' : '✗'} ${name}${info ? ' · ' + info : ''}`); };

// (1) AISC sobrecarga L/360: viga 6 m, δ=15 mm → límite=16.67 mm, ratio=0.9.
{
  const r = checkDeflection({ delta: 0.015, L: 6, code: 'AISC360-16:LRFD', use: 'live' });
  ok('1a. límite L/360 (6 m)', r.limit, 6 / 360, 1e-4);
  ok('1b. ratio δ/límite', r.ratio, 0.015 / (6 / 360), 1e-3);
}
// (2) Voladizo: luz efectiva 2L.
{
  const r = checkDeflection({ delta: 0.02, L: 3, code: 'AISC360-16:LRFD', use: 'live', cantilever: true });
  ok('2. voladizo límite 2L/360', r.limit, (2 * 3) / 360, 1e-4);
  assert('2b. luz efectiva = 2L', Math.abs(r.luzEfectiva - 6) < 1e-9);
}
// (3) EC3 total L/250 vs AISC total L/240.
{
  assert('3a. EC3 total = L/250', deflectionDivisor('EN1993-1-1', 'total') === 250);
  assert('3b. AISC total = L/240', deflectionDivisor('AISC360-16:LRFD', 'total') === 240);
}
// (4) Deriva NCh433 = 0.002; ASCE7 = 0.020.
{
  assert('4a. límite NCh433 Δ/h=0.002', driftLimit('NCh433') === 0.002);
  assert('4b. límite ASCE7 Δ/h=0.020', driftLimit('ASCE7') === 0.020);
}
// (5) Deriva: Δ=9 mm, h=3 m → Δ/h=0.003 > 0.002 (NCh) → ratio 1.5 (no cumple).
{
  const r = checkDrift({ drift: 0.009, h: 3, code: 'NCh433' });
  ok('5a. Δ/h demanda', r.demand, 0.003, 1e-6);
  ok('5b. ratio vs NCh433 (0.002)', r.ratio, 0.003 / 0.002, 1e-3);
  assert('5c. no cumple (ratio>1)', r.ratio > 1);
}
// (6) Misma deriva con ASCE7 (0.020) → cumple.
{
  const r = checkDrift({ drift: 0.009, h: 3, code: 'ASCE7' });
  assert('6. misma deriva cumple con ASCE7', r.ratio < 1, `ratio=${r.ratio}`);
}
// (7) Override de límite admisible.
{
  const r = checkDrift({ drift: 0.006, h: 3, allow: 0.001 });
  ok('7. allow override', r.ratio, (0.006 / 3) / 0.001, 1e-3);
}

console.log(fails === 0 ? '\nTODO OK ✓' : `\n${fails} FALLO(S) ✗`);
process.exit(fails ? 1 : 0);
