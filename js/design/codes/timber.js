// ──────────────────────────────────────────────────────────────────────────────
// timber.js — TIMBER design by modified allowable stresses (NCh1198/NDS).
//
// Base strengths Fb, Fv, Fc, Ft (kN/m²) and the modification factor kmod (product
// of Ki) come from the resolved MATERIAL. Compression uses the column stability
// factor CP (Ylinen). Units: kN, m, kN/m² (reported in MPa).
// ──────────────────────────────────────────────────────────────────────────────

import { finalize } from './aisc360.js?v=6';

const MPA = 1000;
const ratObj = (D, C, extra = {}) => ({
  demand: +(+D).toFixed(4), capacity: +(+C).toFixed(4),
  ratio: C > 1e-12 ? +(D / C).toFixed(4) : Infinity, ...extra,
});

function checkTimber({ demands, mat, sec, member, options = {} }) {
  const k = mat.kmod ?? 1;
  const E = mat.E, Fb = mat.Fb * k, Fv = mat.Fv * k, Fc = mat.Fc * k, Ft = mat.Ft * k;
  const { A, Sz, Sy, dmin } = sec;
  const L = member.L || 1, K = member.K ?? member.Kz ?? 1;

  const F = {
    N: demands.N || 0, Nsign: Math.sign(demands.N || 0) || 1,
    Vy: Math.abs(demands.Vy || 0), Vz: Math.abs(demands.Vz || 0),
    My: Math.abs(demands.My || 0), Mz: Math.abs(demands.Mz || 0),
  };
  const Nabs = Math.abs(F.N);

  const fb = Math.max(F.Mz / Sz, F.My / Sy);
  const bending = ratObj(fb / MPA, Fb / MPA, { unidad: 'MPa', kmod: +k.toFixed(3),
    formula: "f_b = M/S ≤ F'b = Fb·∏Ki" });

  const fv = 1.5 * Math.max(F.Vy, F.Vz) / A;
  const shear = ratObj(fv / MPA, Fv / MPA, { unidad: 'MPa', formula: "f_v = 1.5·V/A ≤ F'v" });

  let axial, interaction;
  const fa = Nabs / A;
  if (F.Nsign >= 0) {
    axial = ratObj(fa / MPA, Ft / MPA, { modo: 'tracción', unidad: 'MPa', formula: "f_t = N/A ≤ F't" });
    interaction = ratObj(fa / Ft + fb / Fb, 1, { adim: true, formula: "f_t/F't + f_b/F'b" });
  } else {
    const le = K * L, lod = le / Math.max(dmin, 1e-4);
    const FcE = 0.822 * E / (lod * lod);
    const c = 0.8, alpha = FcE / Fc, t = (1 + alpha) / (2 * c);
    const CP = t - Math.sqrt(Math.max(t * t - alpha / c, 0));
    const Fcc = Fc * CP;
    axial = ratObj(fa / MPA, Fcc / MPA, { modo: 'compresión', CP: +CP.toFixed(3), unidad: 'MPa',
      formula: "f_c = N/A ≤ F'c·CP (Ylinen)" });
    const amp = (fa < FcE) ? (1 - fa / FcE) : 1e-6;
    interaction = ratObj(Math.pow(fa / Fcc, 2) + fb / (Fb * amp), 1, { adim: true,
      formula: "(f_c/F'c)² + f_b/[F'b·(1−f_c/F_cE)]" });
  }

  return finalize({ material: 'madera', metodo: 'Tensiones admisibles (NCh1198)', bending, shear, axial, interaction }, options);
}

export const timber_nch1198 = {
  id: 'NCh1198', family: 'timber', label: 'NCh1198 (tensiones admisibles)',
  check: checkTimber,
};
