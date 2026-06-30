// ──────────────────────────────────────────────────────────────────────────────
// aisc360.js — STEEL design per AISC 360-16 (LRFD and ASD).
//
//   · D2  tension (gross-area yielding, φt·Fy·Ag)
//   · E3  compression (flexural buckling, Fcr)
//   · F2  strong-axis bending of compact I profiles, with LATERAL-TORSIONAL BUCKLING
//         (Lp, Lr, Cb); F6 weak axis; closed/solid sections → Mp
//   · G2  shear (Vn = 0.6·Fy·Aw·Cv)
//   · H1.1 axial-flexural interaction
//
// LRFD: strength = φ·Rn.  ASD: strength = Rn/Ω.  Units: kN, m, kN/m².
// Equivalent to SAP2000's steel check (AISC360-16) for the covered modes. For
// tabulated profiles, supply the real dimensions in sec.design.
// ──────────────────────────────────────────────────────────────────────────────

const ratObj = (D, C, extra = {}) => ({
  demand: +(+D).toFixed(4), capacity: +(+C).toFixed(4),
  ratio: C > 1e-12 ? +(D / C).toFixed(4) : Infinity, ...extra,
});

// strength factor: LRFD → φ·Rn ; ASD → Rn/Ω
function makeFactor(method, phi, omega) {
  return method === 'ASD' ? (Rn) => Rn / omega : (Rn) => phi * Rn;
}

function checkAISC(method, { demands, mat, sec, member, options = {} }) {
  const Fy = mat.Fy, Fu = mat.Fu, E = mat.E, G = mat.G || E / 2.6;
  const L = member.L || 1, Lb = member.Lb || L, Kz = member.Kz ?? member.K ?? 1, Ky = member.Ky ?? member.K ?? 1;
  const Cb = member.Cb ?? 1.0;
  const { A, Sz, Sy, Zz, Zy, rz, ry, Iy, Cw, J, Avy, Avz, h, b, shape, lambdaFlange, lambdaWeb } = sec;

  const F = {
    N: demands.N || 0, Nsign: Math.sign(demands.N || 0) || 1,
    Vy: Math.abs(demands.Vy || 0), Vz: Math.abs(demands.Vz || 0),
    My: Math.abs(demands.My || 0), Mz: Math.abs(demands.Mz || 0),
  };
  const Nabs = Math.abs(F.N);

  // ── E3 compression / D2 tension ─────────────────────────────────────────────
  let axial, Pc, axMode;
  if (F.Nsign >= 0) {            // tension → gross-area yielding (D2a)
    const fac = makeFactor(method, 0.90, 1.67);
    Pc = fac(Fy * A); axMode = 'tracción';
    axial = ratObj(Nabs, Pc, { modo: 'tracción', formula: method === 'ASD' ? 'Pn/Ω = Fy·Ag/1.67' : 'φPn = 0.90·Fy·Ag' });
  } else {                       // compression (E3)
    const slz = Kz * L / rz, sly = Ky * L / ry;
    const slend = Math.max(slz, sly);
    const Fe = Math.PI ** 2 * E / (slend * slend);
    const Fcr = (Fy / Fe <= 2.25) ? Math.pow(0.658, Fy / Fe) * Fy : 0.877 * Fe;
    const fac = makeFactor(method, 0.90, 1.67);
    Pc = fac(Fcr * A); axMode = 'compresión';
    axial = ratObj(Nabs, Pc, { modo: 'compresión', slenderness: +slend.toFixed(0),
      formula: method === 'ASD' ? 'Pn/Ω = Fcr·Ag/1.67 (E3)' : 'φPn = 0.90·Fcr·Ag (E3)' });
  }

  // ── F2/F6 bending with LTB (strong axis) ────────────────────────────────────
  const facB = makeFactor(method, 0.90, 1.67);
  const Mpz = Fy * Zz, Mpy = Math.min(Fy * Zy, 1.6 * Fy * Sy);   // F6: Mp_y ≤ 1.6 Fy Sy
  let Mnz = Mpz, ltb = 'Lb≤Lp (sin LTB)';
  if (shape === 'I' && Cw > 0 && Sz > 0) {
    const ho = member.ho || sec.ho || 0.95 * h;                 // distance between flange centroids
    const rts = Math.sqrt(Math.sqrt(Iy * Cw) / Sz);
    const c = 1;                                                            // bisymmetric I
    const Lp = 1.76 * ry * Math.sqrt(E / Fy);
    const term = (J * c) / (Sz * ho);
    const Lr = 1.95 * rts * (E / (0.7 * Fy)) * Math.sqrt(term + Math.sqrt(term * term + 6.76 * (0.7 * Fy / E) ** 2));
    if (Lb <= Lp) { Mnz = Mpz; ltb = `Lb≤Lp=${Lp.toFixed(2)}m`; }
    else if (Lb <= Lr) {
      Mnz = Math.min(Cb * (Mpz - (Mpz - 0.7 * Fy * Sz) * (Lb - Lp) / (Lr - Lp)), Mpz);
      ltb = `Lp<Lb≤Lr (Cb=${Cb})`;
    } else {
      const Fcr = (Cb * Math.PI ** 2 * E / (Lb / rts) ** 2) * Math.sqrt(1 + 0.078 * term * (Lb / rts) ** 2);
      Mnz = Math.min(Fcr * Sz, Mpz); ltb = `Lb>Lr=${Lr.toFixed(2)}m (pandeo elástico)`;
    }
  } else if (shape === 'tee' && Sz > 0) {
    // F9 — Tees and double-angles (bending in the plane of symmetry). The web is
    // usually in tension (compression flange on top): member.teeStem='compression' flips it.
    const stemTension = member.teeStem !== 'compression';
    const My = Fy * Sz;                                           // yield moment
    const Myield = stemTension ? Math.min(Fy * Zz, 1.6 * My) : My;   // F9.1
    let Mcr = Infinity;                                           // F9.2 LTB
    if (Lb > 0 && Iy > 0 && J > 0) {
      const B = (stemTension ? 1 : -1) * 2.3 * (h / Lb) * Math.sqrt(Iy / J);
      Mcr = (1.95 * E / Lb) * Math.sqrt(Iy * J) * (B + Math.sqrt(1 + B * B));
    }
    Mnz = Math.min(Myield, Mcr);
    ltb = `F9 tee (alma ${stemTension ? 'traccionada' : 'comprimida'}), Mcr=${isFinite(Mcr) ? Mcr.toFixed(1) : '∞'}`;
  } else if (shape === 'angle' && Sz > 0) {
    // F10 — Single angle, bending about the geometric axis (conservative, leg in
    // compression). F10.1 yielding Mn≤1.5·My; F10.2 LTB with Me=0.46·E·b⁴·t·Cb/Lb².
    const My = Fy * Sz, legB = Math.max(h, b), t = lambdaFlange > 0 ? legB / lambdaFlange : 0;
    const Myield = 1.5 * My;
    let Mn10 = Myield;
    if (Lb > 0 && t > 0) {
      const Me = 0.46 * E * legB ** 4 * t * Cb / (Lb * Lb);
      Mn10 = Me <= My ? (0.92 - 0.17 * Me / My) * Me : Math.min((1.58 - 0.83 * Math.sqrt(My / Me)) * My, Myield);
    }
    Mnz = Math.min(Myield, Mn10);
    ltb = 'F10 ángulo (eje geométrico, conservador)';
  }
  const Mcz = facB(Mnz), Mcy = facB(Mpy);
  const rbz = Mcz > 1e-12 ? F.Mz / Mcz : 0, rby = Mcy > 1e-12 ? F.My / Mcy : 0;
  const fForm = shape === 'tee' ? 'Mn por F9 (tee)' : shape === 'angle' ? 'Mn por F10 (ángulo)' : 'Mn=Mp con LTB (F2)';
  const bending = rbz >= rby
    ? ratObj(F.Mz, Mcz, { eje: 'fuerte (Mz)', ltb, formula: fForm })
    : ratObj(F.My, Mcy, { eje: 'débil (My)', formula: 'Mn=Mp≤1.6FySy (F6)' });

  // ── G2 shear ──────────────────────────────────────────────────────────────────
  const facV = makeFactor(method, 0.90, 1.67);
  const cvLim = 2.24 * Math.sqrt(E / Fy);
  const Cv = (shape === 'I' && lambdaWeb > cvLim) ? cvLim / lambdaWeb : 1.0;   // simplified
  const Vnz = 0.6 * Fy * Avy * Cv, Vny = 0.6 * Fy * Avz * Cv;   // Avy=web(→Mz), Avz=flanges(→My)
  const Vcz = facV(Vnz), Vcy = facV(Vny);
  const rvz = Vcz > 1e-12 ? F.Vy / Vcz : 0, rvy = Vcy > 1e-12 ? F.Vz / Vcy : 0;
  const shear = rvz >= rvy
    ? ratObj(F.Vy, Vcz, { dir: 'Vy (alma)', formula: 'Vn=0.6·Fy·Aw·Cv (G2)' })
    : ratObj(F.Vz, Vcy, { dir: 'Vz (alas)', formula: 'Vn=0.6·Fy·Af·Cv (G2)' });

  // ── H1.1 axial-flexural interaction ─────────────────────────────────────────
  const pr = Pc > 1e-12 ? Nabs / Pc : 0;
  const mm = (Mcz > 1e-12 ? F.Mz / Mcz : 0) + (Mcy > 1e-12 ? F.My / Mcy : 0);
  const H = pr >= 0.2 ? pr + (8 / 9) * mm : pr / 2 + mm;
  const interaction = ratObj(H, 1, { adim: true, modo: axMode,
    formula: pr >= 0.2 ? 'Pr/Pc + 8/9·(Mrz/Mcz+Mry/Mcy) (H1-1a)' : 'Pr/2Pc + (Mrz/Mcz+Mry/Mcy) (H1-1b)' });

  return finalize({ material: 'acero', metodo: `AISC 360-16 (${method})`, bending, shear, axial, interaction }, options);
}

// Status/governing case from the ratios.
export function finalize(r, options = {}) {
  const items = [['flexión', r.bending], ['corte', r.shear], ['axial', r.axial], ['interacción', r.interaction]]
    .filter(([, v]) => v);
  let iMax = 0; for (let i = 1; i < items.length; i++) if (items[i][1].ratio > items[iMax][1].ratio) iMax = i;
  r.ratioMax = items[iMax][1].ratio;
  r.governs = items[iMax][0];
  const aviso = options.ratio_warning ?? 0.90, falla = options.ratio_fail ?? 1.0;
  r.state = r.ratioMax > falla ? 'NO CUMPLE' : r.ratioMax > aviso ? 'ajustado' : 'cumple';
  return r;
}

export const aisc360_lrfd = {
  id: 'AISC360-16:LRFD', family: 'steel', label: 'AISC 360-16 (LRFD)',
  check: (input) => checkAISC('LRFD', input),
};
export const aisc360_asd = {
  id: 'AISC360-16:ASD', family: 'steel', label: 'AISC 360-16 (ASD)',
  check: (input) => checkAISC('ASD', input),
};
