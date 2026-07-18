// test_ec3_interaction.mjs — verificación de la interacción EC3 6.3.3 (#64)
// Anexo B (Método 2): factores kyy/kzz/kyz/kzy y eqs. 6.61/6.62.
//   node test_ec3_interaction.mjs
import { eurocode3 } from '../js/design/codes/eurocode3.js';

let fails = 0;
const ok = (name, got, exp, tol) => { const e = Math.abs(got - exp) / (Math.abs(exp) || 1); const p = e <= tol; if (!p) fails++; console.log(`${p ? '✓' : '✗'} ${name}: got=${(+got).toFixed(4)} exp=${(+exp).toFixed(4)} err=${(e * 100).toFixed(2)}%`); };
const assert = (name, c, info = '') => { if (!c) fails++; console.log(`${c ? '✓' : '✗'} ${name}${info ? ' · ' + info : ''}`); };

// IPE300 (m): props del modelo + forma I para Z/Cw.
const sec = { A: 5.38e-3, Iz: 8.356e-5, Iy: 6.04e-6, J: 2.01e-7,
  design: { shape: 'I', dims: { d: 0.30, bf: 0.15, tf: 0.0107, tw: 0.0071 } } };
const mat = { design: { family: 'steel', Fy: 275, Fu: 430, E: 210000 }, E: 210e9, Fy: 275e6, G: 81e9 };
const run = (N, Mz, My, member = {}) => eurocode3.check({ demands: { N, Mz, My }, mat: { Fy: 275e3, E: 210e6, G: 81e6 }, sec: resolve(sec), member: { L: 4, Lb: 4, K: 1, ...member }, options: {} });

// Resolver props de sección (igual que el orquestador).
import { resolveSectionProps } from '../js/design/section_props.js';
function resolve(s) { return resolveSectionProps(s); }

// (1) Compresión pura → interacción ≡ ratio axial (sin momento).
{
  const r = run(-400, 0, 0);
  ok('1. compresión pura: interacción ≡ axial', r.interaction.ratio, r.axial.ratio, 1e-6);
  assert('1b. usa eqs. 6.61/6.62 (Anexo B)', /6\.61\/6\.62/.test(r.interaction.formula));
}
// (2) Relación exacta kyz = 0.6·kzz.
{
  const r = run(-400, 60, 20);
  ok('2. kyz = 0.6·kzz (kij redondeados a 3 dec.)', r.interaction.kyz, 0.6 * r.interaction.kzz, 3e-3);
}
// (3) kij en rango: Cmy ≤ kyy ≤ Cmy·(1+0.8·n) con Cmy=0.9 (default) y compresión.
{
  const r = run(-600, 80, 0);
  assert('3a. kyy ≥ Cmy (0.9)', r.interaction.kyy >= 0.9 - 1e-9, `kyy=${r.interaction.kyy}`);
  assert('3b. kzy ≤ 1 (reductor)', r.interaction.kzy <= 1 + 1e-9, `kzy=${r.interaction.kzy}`);
}
// (4) Monotonía: añadir momento mayor (Mz) sube el ratio sobre la compresión sola.
{
  const r0 = run(-600, 0, 0), r1 = run(-600, 80, 0), r2 = run(-600, 160, 0);
  assert('4a. M>0 sube el ratio sobre N solo', r1.interaction.ratio > r0.interaction.ratio, `${r1.interaction.ratio} > ${r0.interaction.ratio}`);
  assert('4b. más M → más ratio', r2.interaction.ratio > r1.interaction.ratio, `${r2.interaction.ratio} > ${r1.interaction.ratio}`);
}
// (5) Tracción + flexión usa la rama lineal (no eqs. 6.61/6.62).
{
  const r = run(+300, 50, 0);
  assert('5. tracción → rama lineal', /lineal/.test(r.interaction.formula), r.interaction.formula);
}
// (6) Cmy menor (diagrama de momento favorable) reduce kyy y el ratio.
{
  const rHi = run(-500, 100, 0, { Cmy: 0.95 });
  const rLo = run(-500, 100, 0, { Cmy: 0.4 });
  assert('6. Cmy menor → menor ratio', rLo.interaction.ratio < rHi.interaction.ratio, `Cmy0.4=${rLo.interaction.ratio} < Cmy0.95=${rHi.interaction.ratio}`);
}

console.log(fails === 0 ? '\nTODO OK ✓' : `\n${fails} FALLO(S) ✗`);
process.exit(fails ? 1 : 0);
