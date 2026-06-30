// test_f9f10.mjs — chequeos AISC F9 (tee) y F10 (ángulo) en flexión (#67)
//   node test_f9f10.mjs
import { checkElement } from './js/design/design.js';
import { fromShape } from './js/design/section_props.js';

let fails = 0;
const ok = (name, got, exp, tol) => { const e = Math.abs(got - exp) / (Math.abs(exp) || 1); const p = e <= tol; if (!p) fails++; console.log(`${p ? '✓' : '✗'} ${name}: got=${got.toFixed(3)} exp=${exp.toFixed(3)} err=${(e * 100).toFixed(2)}%`); };
const assert = (name, c, info = '') => { if (!c) fails++; console.log(`${c ? '✓' : '✗'} ${name}${info ? ' · ' + info : ''}`); };

const Fy = 355e3;                                    // kN/m²
const acero = { design: { family: 'steel', Fy: 355, Fu: 490 }, E: 2.1e8, G: 8.1e7, rho: 7.85 };
const teeDims = { d: 0.2, bf: 0.15, tf: 0.012, tw: 0.008 };
const angDims = { d: 0.1, b: 0.1, t: 0.01 };
const mk = (shape, dims) => ({ A: 0, Iz: 0, Iy: 0, J: 0, design: { shape, dims } });
const Mcap = (shape, dims, Lb) => checkElement({ forces: { Mz: 1, L: Lb }, sec: mk(shape, dims), mat: acero, codeId: 'AISC360-16:LRFD', member: { Lb } }).bending.capacity;

// (1) Tee F9: a Lb corto Mn = φ·min(Fy·Zz, 1.6·Fy·Sz).
{
  const g = fromShape('tee', teeDims);
  const Myield = Math.min(Fy * g.Zz, 1.6 * Fy * g.Sz);
  ok('1. Tee F9 fluencia (Lb corto) = φ·min(Fy·Zz,1.6·Fy·Sz)', Mcap('tee', teeDims, 0.5), 0.90 * Myield, 1e-3);
}
// (2) Tee F9: la LTB reduce Mn a Lb largo.
{
  const m1 = Mcap('tee', teeDims, 0.5), m2 = Mcap('tee', teeDims, 12);
  assert('2. Tee LTB reduce Mn a Lb largo', m2 < 0.7 * m1, `Lb0.5=${m1.toFixed(1)} Lb12=${m2.toFixed(1)}`);
}
// (3) Ángulo F10: Mn ≤ φ·1.5·My (My=Fy·Sz).
{
  const g = fromShape('angle', angDims);
  const cap = Mcap('angle', angDims, 0.3);
  assert('3. Ángulo F10 Mn ≤ φ·1.5·My', cap <= 0.90 * 1.5 * Fy * g.Sz * 1.001, `cap=${cap.toFixed(3)} φ1.5My=${(0.90*1.5*Fy*g.Sz).toFixed(3)}`);
}
// (4) Ángulo F10: LTB muy marcada (los ángulos son débiles a LTB).
{
  const m1 = Mcap('angle', angDims, 0.5), m2 = Mcap('angle', angDims, 8);
  assert('4. Ángulo LTB fuerte a Lb largo', m2 < 0.3 * m1, `Lb0.5=${m1.toFixed(2)} Lb8=${m2.toFixed(2)}`);
}
// (5) Las etiquetas indican F9/F10.
{
  const rT = checkElement({ forces: { Mz: 10, L: 4 }, sec: mk('tee', teeDims), mat: acero, codeId: 'AISC360-16:LRFD', member: { Lb: 4 } });
  const rA = checkElement({ forces: { Mz: 3, L: 3 }, sec: mk('angle', angDims), mat: acero, codeId: 'AISC360-16:LRFD', member: { Lb: 3 } });
  assert('5a. tee → formula F9', /F9/.test(rT.bending.formula), rT.bending.formula);
  assert('5b. ángulo → formula F10', /F10/.test(rA.bending.formula), rA.bending.formula);
}

console.log(fails === 0 ? '\nTODO OK ✓' : `\n${fails} FALLO(S) ✗`);
process.exit(fails ? 1 : 0);
