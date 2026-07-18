// test_concrete_pm.mjs — verificación del diagrama de interacción P–M (#65)
//
// Columna rectangular 0.40×0.40 m, f'c=30 MPa, fy=420 MPa, ρ=0.02 (As total).
// Se valida contra puntos de control calculados a mano (ACI 318-19):
//  (1) compresión pura ≤ tope φPn,max = 0.80·0.65·Po,
//  (2) flexión pura: ratio Mu/φMn0 (el punto M con P=0 del diagrama),
//  (3) un punto INTERIOR del diagrama tiene D/C<1 y uno EXTERIOR >1,
//  (4) monotonía: a igual e, más demanda ⇒ mayor D/C (escala radial).
//
//   node test_concrete_pm.mjs
//
import { aci318 } from '../js/design/codes/concrete.js';
import { checkElement } from '../js/design/design.js';

let fails = 0;
const ok = (name, got, exp, tol) => { const err = Math.abs(got - exp) / (Math.abs(exp) || 1); const pass = err <= tol; if (!pass) fails++; console.log(`${pass ? '✓' : '✗'} ${name}: got=${(+got).toFixed(4)} exp=${(+exp).toFixed(4)} err=${(err * 100).toFixed(2)}%`); };
const assert = (name, cond, info = '') => { if (!cond) fails++; console.log(`${cond ? '✓' : '✗'} ${name}${info ? ' · ' + info : ''}`); };

const fc = 30e3, fy = 420e3;                     // kN/m²
const b = 0.40, h = 0.40, A = b * h, rho = 0.02, cover = 0.04;
const mat = { fc, fyRebar: fy };
const sec = { A, b, h, design: { rebar: { rho, cover_mm: 40 } } };
const run = (N, Mz) => aci318.check({ demands: { N, Mz, Vy: 0, My: 0 }, mat, sec, member: {}, options: {} });

// Tope de compresión pura (ACI): φPn,max = 0.80·0.65·(0.85 f'c (Ag−Ast)+fy·Ast)
const Ast = rho * A, Po = 0.85 * fc * (A - Ast) + fy * Ast, Pmax = 0.80 * 0.65 * Po;
console.log(`Po=${Po.toFixed(0)} kN · φPn,max=${Pmax.toFixed(0)} kN`);

// (1) Demanda de compresión pura igual al tope → D/C ≈ 1.
{
  const r = run(-Pmax, 0.001);
  ok('1. compresión ~pura en el tope → D/C≈1', r.interaction.ratio, 1, 0.05);
}
// (2) Flexión pura moderada → D/C<1, y el doble de momento ~duplica el D/C (radial).
{
  const r1 = run(0, 80), r2 = run(0, 160);
  assert('2a. flexión pura D/C<1 a Mu=80', r1.interaction.ratio < 1, `D/C=${r1.interaction.ratio}`);
  ok('2b. D/C escala ~lineal con Mu (radial)', r2.interaction.ratio, 2 * r1.interaction.ratio, 0.08);
}
// (3) Punto interior (poca demanda) seguro; punto muy exterior falla.
{
  const inside = run(-500, 40), outside = run(-Pmax * 1.3, 120);
  assert('3a. demanda baja → D/C<1', inside.interaction.ratio < 1, `D/C=${inside.interaction.ratio}`);
  assert('3b. demanda excesiva → D/C>1', outside.interaction.ratio > 1, `D/C=${outside.interaction.ratio}`);
}
// (4) La "nariz" del diagrama (flexión máx) ocurre cerca del punto balanceado:
//     a P de compresión moderada el φMn es MAYOR que en flexión pura.
{
  const diag = run(-600, 50).diagrama.pts;
  const Mflex0 = Math.max(...diag.filter(p => Math.abs(p.P) < 200).map(p => p.M));
  const Mbal = Math.max(...diag.map(p => p.M));
  assert('4. φMn máx (balanceado) > φMn de flexión pura', Mbal > Mflex0 * 1.05, `Mmax=${Mbal.toFixed(1)} vs Mflex0=${Mflex0.toFixed(1)} kN·m`);
}

// (5) Barras EXPLÍCITAS ≈ cuantía ρ equivalente (#70). 4φ32 ≈ ρ=0.02 en 0.4×0.4.
{
  const secRho  = { A, b, h, design: { rebar: { rho: 0.02, cover_mm: 40 } } };
  const secBars = { A, b, h, design: { rebar: { nTop: 2, nBot: 2, dia_mm: 32, cover_mm: 40 } } };
  const cu = (s) => aci318.check({ demands: { N: -600, Mz: 120, Vy: 0, My: 0 }, mat, sec: s, member: {}, options: {} });
  const rR = cu(secRho), rB = cu(secBars);
  ok('5a. barras explícitas ≈ ρ equivalente', rB.interaction.ratio, rR.interaction.ratio, 0.06);
  assert('5b. reporta el nº de barras', /4 barras/.test(rB.interaction.reinforcement || ''), rB.interaction.reinforcement);
}
// (6) Estribos aumentan la capacidad de corte (#70).
{
  const secNo = { A, b, h, design: { rebar: { rho: 0.02, cover_mm: 40 } } };
  const secSt = { A, b, h, design: { rebar: { rho: 0.02, cover_mm: 40, stirrups: { dia: 10, s: 150, legs: 2 } } } };
  const cv = (s) => aci318.check({ demands: { Vy: 200, N: 0, Mz: 0 }, mat, sec: s, member: {}, options: {} });
  const rN = cv(secNo), rS = cv(secSt);
  assert('6. estribos suben la capacidad de corte', rS.shear.capacity > rN.shear.capacity * 1.3, `con=${rS.shear.capacity.toFixed(0)} sin=${rN.shear.capacity.toFixed(0)} kN`);
}

// (7) Por la ruta REAL (checkElement → resolveSectionProps → código): las
//     barras y estribos deben PROPAGARSE (no caer al fallback ρ). #70
{
  const matM = { name: 'H30', design: { family: 'concrete', fc: 30, fyRebar: 420 }, E: 2.57e7 };
  const secM = { A: 0.16, Iz: 0, Iy: 0, J: 0, b: 0.4, h: 0.4,
    design: { shape: 'rect', dims: { b: 0.4, h: 0.4 }, rebar: { cover_mm: 40, nTop: 3, nBot: 3, dia_mm: 25, estribo_dia_mm: 10, estribo_s_mm: 150 } } };
  const r = checkElement({ forces: { N: -600, Mz: 150, Vy: 180, L: 5 }, sec: secM, mat: matM });
  assert('7a. armado explícito propagado (6 barras, no ρ)', /6 barras/.test(r.interaction.reinforcement || ''), r.interaction.reinforcement);
  assert('7b. estribos en el corte (no «sin estribos»)', /Vs/.test(r.shear.formula), r.shear.formula);
}

// (8) Flexión BIAXIAL por contorno de carga (#65). Columna 0.4×0.4 simétrica.
{
  const bi = (Mz, My, al) => aci318.check({ demands: { N: -600, Mz, My }, mat, sec, member: {}, options: al ? { biaxialAlpha: al } : {} }).interaction;
  const u = bi(120, 0).ratio;                 // uniaxial (radial)
  const both = bi(120, 120, 1);               // biaxial α=1
  assert('8a. biaxial (Mz+My) más exigente que uniaxial', both.ratio > u * 1.5, `bi=${both.ratio} uni=${u}`);
  assert('8b. modo biaxial', /biaxial/.test(both.modo), both.modo);
  ok('8c. simétrica α=1: ratio ≈ 2× uniaxial-contorno', both.ratio, 2 * bi(120, 0.0001, 1).ratio, 0.05);
  const a2 = bi(120, 120, 2).ratio;           // α=2 menos conservador
  assert('8d. α mayor → ratio menor (contorno menos conservador)', a2 < both.ratio, `α2=${a2} α1=${both.ratio}`);
}

console.log(fails === 0 ? '\nTODO OK ✓' : `\n${fails} FALLO(S) ✗`);
process.exit(fails ? 1 : 0);
