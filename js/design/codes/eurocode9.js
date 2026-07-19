// ──────────────────────────────────────────────────────────────────────────────
// eurocode9.js — ALUMINUM design per Eurocode 9 (EN 1999-1-1).
//
// Aluminum is NOT steel: modulus E ≈ 70 GPa (≈ ⅓ of steel), reference strength =
// 0.2 % proof stress `fo` (not fy), its own partial factors (γM1=1.10 member
// buckling, γM2=1.25 net section) and different buckling curves. This implementation
// covers:
//
//   · 6.2.3 tension         No,Rd = A·fo/γM1   (gross section; net with fu/γM2)
//   · 6.3.1 compression     Nb,Rd = κ·χ·A·fo/γM1  (κ = HAZ/local factor, def. 1)
//   · 6.2.5/6.3.2 bending   Mc,Rd = α·Wel·fo/γM1 (α = shape factor by class) + LTB
//   · 6.2.6 shear           Vo,Rd = Av·fo/(√3·γM1)
//   · 6.3.3 interaction     conservative linear (refinement with the ξ/η/γ exponents
//                           of EN 1999-1-1 pending)
//
// EC9 buckling curves (Table 6.6): class A (heat-treated alloys) α=0.20, λ̄0=0.10;
// class B (non-heat-treated/welded) α=0.32, λ̄0=0.0. Default A.
//
// `fo` is taken from the resolved material (mat.Fy in kN/m², which for aluminum IS
// the 0.2 % proof stress); `E` from the material (must be ≈70 GPa for aluminum).
// Units: kN, m, kN/m².
// ──────────────────────────────────────────────────────────────────────────────

import { finalize } from './aisc360.js?v=4';

const CURVES = { A: { alpha: 0.20, l0: 0.10 }, B: { alpha: 0.32, l0: 0.0 } };
const ratObj = (D, C, extra = {}) => ({
  demand: +(+D).toFixed(4), capacity: +(+C).toFixed(4),
  ratio: C > 1e-12 ? +(D / C).toFixed(4) : Infinity, ...extra,
});

function chi(lambdaBar, { alpha, l0 }) {
  const Phi = 0.5 * (1 + alpha * (lambdaBar - l0) + lambdaBar * lambdaBar);
  return Math.min(1, 1 / (Phi + Math.sqrt(Math.max(Phi * Phi - lambdaBar * lambdaBar, 0))));
}

function checkEC9({ demands, mat, sec, member, options = {} }) {
  const fo = mat.Fy, fu = mat.Fu, E = mat.E, G = mat.G || E / 2.6;
  const gM1 = options.gammaM1 ?? 1.10, gM2 = options.gammaM2 ?? 1.25;
  const curve = CURVES[options.bucklingCurve || 'A'] || CURVES.A;
  const curveLT = CURVES[options.ltCurve || 'A'] || CURVES.A;
  const kHaz = options.haz ?? member.haz ?? 1.0;          // heat-affected-zone reduction (≤1)
  const L = member.L || 1, Lb = member.Lb || L, K = member.K ?? 1;
  const C1 = member.C1 ?? member.Cb ?? 1.0;
  const { A, Sz, Sy, Zz, Zy, Iy, Cw, J, Avy, Avz, shape, lambdaFlange, lambdaWeb } = sec;

  const F = {
    N: demands.N || 0, Nsign: Math.sign(demands.N || 0) || 1,
    Vy: Math.abs(demands.Vy || 0), Vz: Math.abs(demands.Vz || 0),
    My: Math.abs(demands.My || 0), Mz: Math.abs(demands.Mz || 0),
  };
  const Nabs = Math.abs(F.N);

  // Classification (EN 1999-1-1 6.1.4, ε=√(250/fo[MPa])). Approximated with EC3 limits.
  const eps = Math.sqrt(250 / (fo / 1000));
  let clase = 1;
  if (shape === 'I') {
    const flCls = lambdaFlange <= 9 * eps ? 1 : lambdaFlange <= 10 * eps ? 2 : lambdaFlange <= 14 * eps ? 3 : 4;
    const wbCls = lambdaWeb <= 72 * eps ? 1 : lambdaWeb <= 83 * eps ? 2 : lambdaWeb <= 124 * eps ? 3 : 4;
    clase = Math.max(flCls, wbCls);
  }
  const plastico = clase <= 2;
  const Wz = plastico ? Zz : Sz, Wy = plastico ? Zy : Sy;

  // ── tension / compression ─────────────────────────────────────────────────────
  let axial, Nrd, axMode;
  if (F.Nsign >= 0) {
    const Ngross = A * fo / gM1, Nnet = 0.9 * A * fu / gM2;   // no holes: Anet=A
    Nrd = Math.min(Ngross, Nnet); axMode = 'tracción';
    axial = ratObj(Nabs, Nrd, { modo: 'tracción', formula: 'No,Rd = mín(A·fo/γM1, 0.9·Anet·fu/γM2)' });
  } else {
    const Ncrz = Math.PI ** 2 * E * sec.Iz / (K * L) ** 2;
    const Ncry = Math.PI ** 2 * E * Iy / (K * L) ** 2;
    const lamBar = Math.sqrt(A * fo / Math.min(Ncrz, Ncry));
    const chiC = chi(lamBar, curve);
    Nrd = kHaz * chiC * A * fo / gM1; axMode = 'compresión';
    axial = ratObj(Nabs, Nrd, { modo: 'compresión', lambdaBar: +lamBar.toFixed(3), chi: +chiC.toFixed(3),
      kHaz, formula: 'Nb,Rd = κ·χ·A·fo/γM1 (6.3.1, curva EC9)' });
  }

  // ── bending + LTB (strong axis) ──────────────────────────────────────────────
  let Mbz = Wz * fo / gM1, ltb = 'sin LTB';
  if (shape === 'I' && Iy > 0 && Cw > 0) {
    const Mcr = C1 * Math.PI ** 2 * E * Iy / Lb ** 2 * Math.sqrt(Cw / Iy + Lb ** 2 * G * J / (Math.PI ** 2 * E * Iy));
    const lamLT = Math.sqrt(Wz * fo / Mcr);
    const chiLT = chi(lamLT, curveLT);
    Mbz = chiLT * Wz * fo / gM1;
    ltb = `λ̄LT=${lamLT.toFixed(3)}, χLT=${chiLT.toFixed(3)}`;
  }
  const Mcy = Wy * fo / gM1;
  const rbz = Mbz > 1e-12 ? F.Mz / Mbz : 0, rby = Mcy > 1e-12 ? F.My / Mcy : 0;
  const bending = rbz >= rby
    ? ratObj(F.Mz, Mbz, { eje: 'fuerte (Mz)', clase, ltb, formula: 'Mb,Rd = χLT·α·Wel·fo/γM1 (6.3.2)' })
    : ratObj(F.My, Mcy, { eje: 'débil (My)', clase, formula: 'Mc,Rd = α·Wel·fo/γM1 (6.2.5)' });

  // ── shear ──────────────────────────────────────────────────────────────────────
  const Vrdz = Avy * fo / (Math.sqrt(3) * gM1), Vrdy = Avz * fo / (Math.sqrt(3) * gM1);
  const rvz = Vrdz > 1e-12 ? F.Vy / Vrdz : 0, rvy = Vrdy > 1e-12 ? F.Vz / Vrdy : 0;
  const shear = rvz >= rvy
    ? ratObj(F.Vy, Vrdz, { dir: 'Vy (alma)', formula: 'Vo,Rd = Av·fo/(√3·γM1) (6.2.6)' })
    : ratObj(F.Vz, Vrdy, { dir: 'Vz (alas)', formula: 'Vo,Rd = Av·fo/(√3·γM1) (6.2.6)' });

  // ── interaction (conservative linear) ────────────────────────────────────────
  const H = (Nrd > 1e-12 ? Nabs / Nrd : 0) + (Mbz > 1e-12 ? F.Mz / Mbz : 0) + (Mcy > 1e-12 ? F.My / Mcy : 0);
  const interaction = ratObj(H, 1, { adim: true, modo: axMode,
    formula: 'NEd/Nb,Rd + My/Mb,Rd + Mz/Mc,z,Rd ≤ 1 (6.3.3, lineal conserv.)' });

  return finalize({ material: 'aluminio', metodo: 'Eurocódigo 9 (EN 1999-1-1)', bending, shear, axial, interaction }, options);
}

export const eurocode9 = {
  id: 'EN1999-1-1', family: 'aluminum', label: 'Eurocódigo 9 (EN 1999-1-1)',
  check: checkEC9,
};
