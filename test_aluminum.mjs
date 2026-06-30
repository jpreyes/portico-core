// test_aluminum.mjs — verificación del módulo de ALUMINIO Eurocódigo 9 (#63)
//   node test_aluminum.mjs
import { eurocode9 } from './js/design/codes/eurocode9.js';
import { checkElement } from './js/design/design.js';
import { resolveSectionProps } from './js/design/section_props.js';

let fails = 0;
const ok = (name, got, exp, tol) => { const e = Math.abs(got - exp) / (Math.abs(exp) || 1); const p = e <= tol; if (!p) fails++; console.log(`${p ? '✓' : '✗'} ${name}: got=${(+got).toFixed(3)} exp=${(+exp).toFixed(3)} err=${(e * 100).toFixed(2)}%`); };
const assert = (name, c, info = '') => { if (!c) fails++; console.log(`${c ? '✓' : '✗'} ${name}${info ? ' · ' + info : ''}`); };

// Sección rectangular maciza 0.10×0.10 m (aluminio extruido). fo=160 MPa, fu=215, E=70 GPa.
const secRaw = { A: 0.01, Iz: 0.01 ** 4 / 12 * 0 + (0.1 * 0.1 ** 3) / 12, Iy: (0.1 * 0.1 ** 3) / 12, J: 0,
  design: { shape: 'rect', dims: { b: 0.1, h: 0.1 } } };
const sec = resolveSectionProps(secRaw);
const fo = 160e3, fu = 215e3, E = 70e6, gM1 = 1.10;          // kN/m²
const mat = { Fy: fo, Fu: fu, E, G: E / 2.6 };
const chk = (demands, member = {}, options = {}) => eurocode9.check({ demands, mat, sec, member: { L: 3, K: 1, ...member }, options });

// (1) Tracción: No,Rd = mín(A·fo/γM1, 0.9·A·fu/γM2).
{
  const r = chk({ N: 100 });
  const exp = Math.min(sec.A * fo / gM1, 0.9 * sec.A * fu / 1.25);
  ok('1. tracción No,Rd', r.axial.capacity, exp, 1e-3);
}
// (2) Compresión: χ de la curva A para la esbeltez calculada (chequeo de la fórmula χ).
{
  const r = chk({ N: -50 }, { L: 3, K: 1 });
  const Ncr = Math.PI ** 2 * E * sec.Iy / 3 ** 2;
  const lam = Math.sqrt(sec.A * fo / Ncr);
  const Phi = 0.5 * (1 + 0.20 * (lam - 0.10) + lam * lam);
  const chiExp = Math.min(1, 1 / (Phi + Math.sqrt(Phi * Phi - lam * lam)));
  ok('2a. λ̄ compresión', r.axial.lambdaBar, lam, 1e-2);
  ok('2b. χ (curva EC9 clase A)', r.axial.chi, chiExp, 1e-2);
  ok('2c. Nb,Rd = χ·A·fo/γM1', r.axial.capacity, chiExp * sec.A * fo / gM1, 2e-2);
}
// (3) Flexión (clase 1, rect → Wpl=Zz): Mc,Rd = Zz·fo/γM1.
{
  const r = chk({ Mz: 5 });
  ok('3. flexión Mc,Rd = Zz·fo/γM1', r.bending.capacity, sec.Zz * fo / gM1, 1e-2);
}
// (4) Corte: Vo,Rd = Av·fo/(√3·γM1).
{
  const r = chk({ Vy: 30 });
  ok('4. corte Vo,Rd', r.shear.capacity, sec.Avy * fo / (Math.sqrt(3) * gM1), 1e-2);
}
// (5) HAZ: factor κ<1 reduce Nb,Rd proporcionalmente.
{
  const r1 = chk({ N: -50 }), r2 = chk({ N: -50 }, {}, { haz: 0.7 });
  ok('5. HAZ κ=0.7 reduce Nb,Rd ×0.7', r2.axial.capacity, 0.7 * r1.axial.capacity, 1e-6);
}
// (6) El orquestador enruta family=aluminum → Eurocódigo 9 por defecto.
{
  const matAl = { design: { family: 'aluminum', Fy: 160, Fu: 215, E: 70000 }, E, Fy: fo, Fu: fu };
  const r = checkElement({ forces: { N: -50, Mz: 3, L: 3 }, sec: secRaw, mat: matAl, member: { L: 3, K: 1 } });
  assert('6. default aluminio = Eurocódigo 9', /1999/.test(r.code) || /EN1999/.test(r.codigoLabel) || /Eurocódigo 9/.test(r.metodo), r.metodo);
}
// (7) Aluminio MÁS esbelto que acero (E menor) → χ menor para misma geometría/esbeltez axial.
{
  const rAl = chk({ N: -50 }, { L: 5 });
  // acero ficticio con E=210 GPa, mismo fo, misma sección
  const matSt = { Fy: fo, Fu: fu, E: 210e6, G: 210e6 / 2.6 };
  const rSt = eurocode9.check({ demands: { N: -50 }, mat: matSt, sec, member: { L: 5, K: 1 }, options: {} });
  assert('7. menor E (aluminio) → menor χ que con E acero', rAl.axial.chi < rSt.axial.chi, `Al χ=${rAl.axial.chi} < acero χ=${rSt.axial.chi}`);
}

console.log(fails === 0 ? '\nTODO OK ✓' : `\n${fails} FALLO(S) ✗`);
process.exit(fails ? 1 : 0);
