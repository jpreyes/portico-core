// test_design.mjs — Verificación del motor de diseño generalizado (AISC/EC3/ACI/madera).
import { resolveSectionProps } from './js/design/section_props.js?v=137';
import { resolveMaterial } from './js/design/material_props.js?v=137';
import { checkElement } from './js/design/design.js?v=137';

let fails = 0;
const approx = (a, b, tol, msg) => {
  const ok = Math.abs(a - b) <= tol * Math.abs(b || 1);
  console.log(`${ok ? '✓' : '✗'} ${msg}: ${(+a).toPrecision(5)} vs ${(+b).toPrecision(5)} (tol ${(tol * 100).toFixed(0)}%)`);
  if (!ok) fails++;
};

console.log('── 1. section_props vs IPE300 tabulado ──');
const ipe300 = { A: 0, Iz: 0, Iy: 0, J: 0, design: { shape: 'I', d: 0.300, bf: 0.150, tf: 0.0107, tw: 0.0071 } };
const P = resolveSectionProps(ipe300);
approx(P.A, 5.38e-3, 0.06, 'A [m²]');               // real 53.8 cm²
approx(P.Iz, 8.356e-5, 0.06, 'Iz fuerte [m⁴]');     // real 8356 cm⁴
approx(P.Sz, 5.57e-4, 0.06, 'Sz=Wel [m³]');         // real 557 cm³
approx(P.Zz, 6.284e-4, 0.06, 'Zz=Wpl [m³]');        // real 628 cm³
approx(P.rz, 0.1246, 0.06, 'rz [m]');               // real 12.46 cm
approx(P.ry, 0.0335, 0.08, 'ry [m]');               // real 3.35 cm

console.log('\n── 2. AISC 360 LRFD — tracción y flexión (cálculo de manual) ──');
const acero = { name: 'Acero S250', E: 2e8, G: 7.7e7, nu: 0.3, design: { family: 'steel', Fy: 250, Fu: 400 } };
const Fy = 250e3;   // kN/m²
// Tracción pura N=+500 kN, L=3m
let r = checkElement({ forces: { N: 500, Vy: 0, Vz: 0, My: 0, Mz: 0, L: 3 }, sec: ipe300, mat: acero, codeId: 'AISC360-16:LRFD' });
approx(r.axial.capacity, 0.9 * Fy * P.A, 0.01, 'φPn tracción = 0.9·Fy·Ag');
// Flexión eje fuerte con Lb pequeño (sin LTB) → φMn = 0.9·Fy·Zz
r = checkElement({ forces: { N: 0, Mz: 50, L: 6 }, sec: ipe300, mat: acero, codeId: 'AISC360-16:LRFD', member: { Lb: 0.2 } });
approx(r.bending.capacity, 0.9 * Fy * P.Zz, 0.02, 'φMn compacto Lb≤Lp = 0.9·Fy·Zz');
// LTB: con Lb grande la capacidad debe BAJAR respecto a Mp
const rLTB = checkElement({ forces: { N: 0, Mz: 50, L: 8 }, sec: ipe300, mat: acero, codeId: 'AISC360-16:LRFD', member: { Lb: 8 } });
console.log(`✓ LTB reduce φMn: Lb=8m → ${rLTB.bending.capacity.toFixed(1)} < Lb≈0 → ${(0.9 * Fy * P.Zz).toFixed(1)} kN·m (${rLTB.bending.ltb})`);
if (!(rLTB.bending.capacity < 0.9 * Fy * P.Zz)) { fails++; console.log('✗ LTB no redujo'); }
// Corte: φVn = 0.9·0.6·Fy·Aw
r = checkElement({ forces: { N: 0, Vy: 100, L: 3 }, sec: ipe300, mat: acero, codeId: 'AISC360-16:LRFD' });
approx(r.shear.capacity, 0.9 * 0.6 * Fy * P.Avy, 0.02, 'φVn = 0.9·0.6·Fy·Aw');

console.log('\n── 3. Compresión AISC E3 (acotada por Euler) ──');
r = checkElement({ forces: { N: -300, L: 4 }, sec: ipe300, mat: acero, codeId: 'AISC360-16:LRFD', member: { K: 1 } });
const Fe = Math.PI ** 2 * 2e8 * P.Iy / (P.A * 4 ** 2);   // pandeo eje débil
console.log(`  φPn compresión = ${r.axial.capacity.toFixed(1)} kN (esbeltez ${r.axial.slenderness}); Fcr ≤ Fy·0.9·A=${(0.9 * Fy * P.A).toFixed(0)}`);
if (!(r.axial.capacity > 0 && r.axial.capacity < 0.9 * Fy * P.A)) { fails++; console.log('✗ compresión fuera de rango'); }

console.log('\n── 4. Eurocódigo 3 — tracción Npl,Rd = A·fy/γM0 ──');
r = checkElement({ forces: { N: 500, L: 3 }, sec: ipe300, mat: acero, codeId: 'EN1993-1-1' });
approx(r.axial.capacity, P.A * Fy / 1.0, 0.01, 'Npl,Rd = A·fy/γM0');
// Flexión EC3 clase 1 Lb pequeño → Wpl·fy
r = checkElement({ forces: { Mz: 50, L: 6 }, sec: ipe300, mat: acero, codeId: 'EN1993-1-1', member: { Lb: 0.2 } });
approx(r.bending.capacity, P.Zz * Fy, 0.05, 'Mc,Rd clase1 = Wpl·fy/γM0');

console.log('\n── 5. AISC vs EC3 deben ser comparables (compresión) ──');
const ra = checkElement({ forces: { N: -300, L: 4 }, sec: ipe300, mat: acero, codeId: 'AISC360-16:LRFD' });
const re = checkElement({ forces: { N: -300, L: 4 }, sec: ipe300, mat: acero, codeId: 'EN1993-1-1' });
console.log(`  AISC φPn=${ra.axial.capacity.toFixed(0)} kN · EC3 Nb,Rd=${re.axial.capacity.toFixed(0)} kN (curva b)`);
approx(ra.axial.capacity, re.axial.capacity, 0.25, 'AISC vs EC3 compresión (orden de magnitud)');

console.log('\n── 6. Hormigón ACI 318 y madera (sanidad) ──');
const horm = { name: 'H30', E: 2.5e7, nu: 0.2, design: { family: 'concrete', fc: 30, fyRebar: 420 } };
const secRect = { A: 0.09, Iz: 6.75e-4, Iy: 6.75e-4, J: 1e-3, design: { shape: 'rect', b: 0.3, h: 0.3, rebar: { rho: 0.01, cover_mm: 40 } } };
r = checkElement({ forces: { Mz: 50, N: -200, Vy: 40, L: 3 }, sec: secRect, mat: horm });
console.log(`  H30 código=${r.code}: flexión r=${r.bending.ratio}, axial r=${r.axial.ratio}, gobierna ${r.governs}, ${r.state}`);
if (r.code !== 'ACI318-19') { fails++; console.log('✗ no eligió ACI por familia'); }
const mad = { name: 'Pino', E: 1e7, nu: 0.3, design: { family: 'timber', Fb: 11, Fv: 1.5, Fc: 9, Ft: 8 } };
r = checkElement({ forces: { Mz: 8, N: -20, Vy: 5, L: 3 }, sec: secRect, mat: mad });
console.log(`  Pino código=${r.code}: flexión r=${r.bending.ratio} (${r.bending.unidad}), gobierna ${r.governs}, ${r.state}`);
if (r.familia !== 'timber') { fails++; console.log('✗ no clasificó madera'); }

console.log('\n── 7. Generalización: material con propiedades ARBITRARIAS ──');
const custom = { name: 'AceroEspecial', E: 2.1e8, G: 8.1e7, nu: 0.3, design: { family: 'steel', Fy: 690, Fu: 760 } };
r = checkElement({ forces: { N: 800, L: 3 }, sec: ipe300, mat: custom, codeId: 'AISC360-16:LRFD' });
approx(r.axial.capacity, 0.9 * 690e3 * P.A, 0.01, 'φPn con Fy=690 MPa (material custom)');

console.log(`\n${fails === 0 ? '✅ TODOS PASAN' : '❌ ' + fails + ' fallos'}`);
process.exit(fails ? 1 : 0);
