// ──────────────────────────────────────────────────────────────────────────────
// concrete.js — REINFORCED CONCRETE design (ACI 318-19 / EN 1992-1-1).
//
// Model sections are generic (A, I); the reinforcement is described by a
// longitudinal ratio ρ and a cover (sec.design.rebar) or default values. The f'c
// and rebar fy strengths are taken from the resolved MATERIAL (kN/m²). φ per ACI
// (bending 0.90, shear 0.75, compression 0.65).
//
// Units: kN, m, kN/m². √f'c uses f'c in MPa (kN/m² ÷ 1000).
// ──────────────────────────────────────────────────────────────────────────────

import { finalize } from './aisc360.js?v=6';

const ratObj = (D, C, extra = {}) => ({
  demand: +(+D).toFixed(4), capacity: +(+C).toFixed(4),
  ratio: C > 1e-12 ? +(D / C).toFixed(4) : Infinity, ...extra,
});

const ES_REBAR = 200e6;   // modulus of the reinforcing steel (kN/m²)

// Area of a bar of diameter φ (mm) → m².
const barArea = dia => Math.PI * (dia / 1000) ** 2 / 4;

// Reinforcement layers {As, dy} (dy = distance from the compression fiber) and total Ast.
// Supports (a) explicit layers reb.layers:[{n,dia,d}], (b) reb.{nTop,nBot,dia},
// (c) ratio ρ (2 symmetric layers As/2). h = depth in the bending direction.
function rebarLayers(reb, h, b, cover, rho) {
  if (Array.isArray(reb.layers) && reb.layers.length) {
    const layers = reb.layers.map(L => ({ As: L.As != null ? +L.As : (+L.n || 0) * barArea(+L.dia || 0), dy: +L.d }))
      .filter(L => L.As > 0 && Number.isFinite(L.dy));
    if (layers.length) return { layers, Ast: layers.reduce((s, L) => s + L.As, 0), nBars: reb.layers.reduce((s, L) => s + (+L.n || 0), 0) };
  }
  const dia = +reb.dia_mm || +reb.dia || 0;
  if (dia > 0 && ((+reb.nTop || 0) + (+reb.nBot || 0)) > 0) {
    const Ab = barArea(dia);
    const layers = [];
    if (+reb.nTop) layers.push({ As: reb.nTop * Ab, dy: cover });
    if (+reb.nBot) layers.push({ As: reb.nBot * Ab, dy: h - cover });
    return { layers, Ast: layers.reduce((s, L) => s + L.As, 0), nBars: (+reb.nTop || 0) + (+reb.nBot || 0) };
  }
  // Fallback ρ: 2 symmetric layers As/2.
  const Ast = rho * b * h;
  return { layers: [{ As: Ast / 2, dy: h - cover }, { As: Ast / 2, dy: cover }], Ast, nBars: null };
}

// ── REAL P–M interaction diagram of a rectangular section ────────────────────────
// (#65/#70) Strain compatibility + Whitney block (ACI 318-19): εcu=0.003, a=β1·c,
// elastoplastic steel (±fy). `layers` = reinforcement layers {As, dy} (dy from the
// compression fiber); `Ast` total. Variable φ (0.65→0.90). Returns the (M,P) points
// of the φ·diagram (P compression +).
//   b,h: width and depth in the bending direction (m); fc,fy in kN/m².
function pmDiagram(b, h, fc, fy, layers, Ast, npts = 40) {
  const ecu = 0.003, ey = fy / ES_REBAR;
  const fcMPa = fc / 1000;
  let beta1 = 0.85 - 0.05 * (fcMPa - 28) / 7; beta1 = Math.min(0.85, Math.max(0.65, beta1));
  const Po = 0.85 * fc * (b * h - Ast) + fy * Ast;       // nominal pure axial
  const phiOf = et => et >= 0.005 ? 0.90 : et <= ey ? 0.65 : 0.65 + (et - ey) * 0.25 / (0.005 - ey);
  // c from very large (pure compression) to small (tension): sweeps the diagram.
  const pts = [];
  const cList = [];
  for (let i = 0; i <= npts; i++) cList.push(3 * h * Math.pow(1 - i / npts, 1.4) + 1e-4);
  for (const c of cList) {
    const a = Math.min(beta1 * c, h);
    const Cc = 0.85 * fc * a * b;                         // concrete compression
    let Pn = Cc, Mn = Cc * (h / 2 - a / 2);
    let etTens = 0;
    for (const L of layers) {
      const es = ecu * (c - L.dy) / c;                    // + compression
      let fs = Math.max(-fy, Math.min(fy, ES_REBAR * es));
      if (es > 0 && L.dy <= a) fs -= 0.85 * fc;           // subtract displaced concrete
      Pn += fs * L.As; Mn += fs * L.As * (h / 2 - L.dy);
      const etL = -es;                                     // tension +
      if (etL > etTens) etTens = etL;
    }
    const phi = phiOf(etTens);
    pts.push({ P: phi * Pn, M: phi * Math.abs(Mn) });
  }
  // Pure-tension point (φ=0.90): P=−fy·Ast, M≈0.
  pts.push({ P: -0.90 * fy * Ast, M: 0 });
  const Pmax = 0.80 * 0.65 * Po;                           // ACI 22.4.2 cap
  // Clips the compression branch to the Pn,max cap.
  for (const p of pts) if (p.P > Pmax) p.P = Pmax;
  return { pts, Pmax, Po, beta1 };
}

// Radial D/C: intersection of the ray origin→(Mu,Pu) with the diagram polyline.
function pmRatio(diagram, Pu, Mu) {
  const pts = diagram.pts;
  if (Mu < 1e-9 && Math.abs(Pu) < 1e-9) return 0;
  // Walks consecutive segments looking for the crossing with the ray t·(Mu,Pu), t>0.
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], bpt = pts[i + 1];
    // Solves  [dMx −Mu; dPx −Pu]·[s;t] = [−a.M; −a.P]  (Cramer).
    const dMx = bpt.M - a.M, dPx = bpt.P - a.P;
    const det = -dMx * Pu + dPx * Mu;
    if (Math.abs(det) < 1e-30) continue;
    const s = (a.M * Pu - Mu * a.P) / det;            // position along the segment [0,1]
    const t = (dPx * a.M - dMx * a.P) / det;          // position along the ray (t=1 → demand)
    if (s >= -1e-6 && s <= 1 + 1e-6 && t > 1e-9) best = Math.min(best, 1 / t);
  }
  return Number.isFinite(best) ? best : Infinity;
}

// Moment capacity of the diagram at a given axial Pu (M on the envelope at the
// level P=Pu; 0 if Pu exceeds the compression cap). For the biaxial load-contour
// method (#65).
function pmMomentAt(diag, Pu) {
  const pts = diag.pts; let M = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if ((a.P - Pu) * (b.P - Pu) <= 0 && a.P !== b.P) {
      const t = (Pu - a.P) / (b.P - a.P);
      M = Math.max(M, a.M + t * (b.M - a.M));
    }
  }
  return M;
}

function checkConcrete({ demands, mat, sec, member, options = {} }, codeLabel) {
  const fc = mat.fc, fy = mat.fyRebar;
  const reb = sec.rebar || (sec.design && sec.design.rebar) || {};
  const rho = reb.rho ?? options.long_reinf_ratio ?? 0.012;
  const cover = (reb.cover_mm ?? options.cover_mm ?? 40) / 1000;
  const phi = options.phi || {};
  const b = sec.b, h = sec.h, A = sec.A;
  const d = Math.max(h - cover, 0.5 * h);
  // Longitudinal reinforcement: explicit layers (bars) or ratio ρ (#70).
  const { layers: rebarL, Ast, nBars } = rebarLayers(reb, h, b, cover, rho);
  const stir = reb.stirrups || (reb.estribo_dia_mm ? { dia: reb.estribo_dia_mm, s: reb.estribo_s_mm } : null);

  const F = {
    N: demands.N || 0, Nsign: Math.sign(demands.N || 0) || 1,
    Vy: Math.abs(demands.Vy || 0), Vz: Math.abs(demands.Vz || 0),
    My: Math.abs(demands.My || 0), Mz: Math.abs(demands.Mz || 0),
  };
  const Nabs = Math.abs(F.N), Mmax = Math.max(F.My, F.Mz), Vmax = Math.max(F.Vy, F.Vz);

  // Bending: As=ρ·b·d ; a=As·fy/(0.85 f'c b) ; φMn=φ·As·fy·(d−a/2)
  const As = rho * b * d;
  const a = As * fy / (0.85 * fc * b);
  const Mn = (phi.bending ?? 0.90) * As * fy * (d - a / 2);
  const bending = ratObj(Mmax, Mn, { rho, b: +b.toFixed(3), d: +d.toFixed(3),
    formula: 'φMn = φ·As·fy·(d−a/2), As=ρ·b·d' });

  // Shear: φVn = φ·(Vc + Vs). Vc = 0.17·√f'c·b·d (ACI 22.5, f'c in MPa). With
  // stirrups (#70): Vs = Av·fy·d/s ≤ 0.66·√f'c·b·d (ACI 22.5.1.2 cap).
  const phiV = phi.shear ?? 0.75;
  const Vc0 = 0.17 * Math.sqrt(fc / 1000) * 1000 * b * d;
  let Vs0 = 0, corteFormula = 'φVc = φ·0.17·√f′c·b·d (sin estribos)';
  if (stir && +stir.dia > 0 && +stir.s > 0) {
    const Av = (+stir.legs || 2) * barArea(+stir.dia);
    Vs0 = Math.min(Av * fy * d / (+stir.s / 1000), 0.66 * Math.sqrt(fc / 1000) * 1000 * b * d);
    corteFormula = `φ(Vc+Vs), Vs=Av·fy·d/s (φ${(+stir.dia)}@${(+stir.s)}mm)`;
  }
  const shear = ratObj(Vmax, phiV * (Vc0 + Vs0), { formula: corteFormula });

  // Axial
  let axial, Pc;
  if (F.Nsign < 0) {
    Pc = (phi.axial_compresion ?? 0.65) * 0.80 * (0.85 * fc * (A - Ast) + fy * Ast);
    axial = ratObj(Nabs, Pc, { modo: 'compresión', formula: 'φPn = φ·0.80·(0.85·f′c·(Ag−Ast)+fy·Ast)' });
  } else {
    Pc = (phi.bending ?? 0.90) * fy * Ast;
    axial = ratObj(Nabs, Pc, { modo: 'tracción', formula: 'φPn = φ·fy·As (tracción → armadura)' });
  }

  // P–M interaction via the REAL DIAGRAM (#65): strain compatibility + Whitney
  // block, variable φ. Bending axis = that of the dominant moment.
  // Compression P POSITIVE (in the model N<0 = compression).
  const Pu = -F.N;                                          // compression +
  const bendStrong = F.Mz >= F.My;                          // Mz → depth h, width b
  const bb = bendStrong ? b : h, hh = bendStrong ? h : b;
  const Mu = Math.max(F.My, F.Mz);
  const biaxial = F.My > 1e-9 && F.Mz > 1e-9;
  let interaction, diagrama = null;
  try {
    // Layers in the bending geometry (bb,hh); explicit bars or ρ.
    const rl = rebarLayers(reb, hh, bb, cover, rho);
    const diag = pmDiagram(bb, hh, fc, fy, rl.layers, rl.Ast);
    if (biaxial) {
      // LOAD-CONTOUR method (#65): (Mz/Mnz)^α + (My/Mny)^α ≤ 1, with Mnz, Mny =
      // uniaxial capacity at axial Pu on each axis; α (def. 1, conservative).
      const diagZ = pmDiagram(b, h, fc, fy, rebarLayers(reb, h, b, cover, rho).layers, rl.Ast);
      const diagY = pmDiagram(h, b, fc, fy, rebarLayers(reb, b, h, cover, rho).layers, rl.Ast);
      const Mnz = pmMomentAt(diagZ, Pu), Mny = pmMomentAt(diagY, Pu);
      const al = options.biaxialAlpha ?? 1.0;
      const r = (Mnz > 1e-12 ? Math.pow(F.Mz / Mnz, al) : Infinity) + (Mny > 1e-12 ? Math.pow(F.My / Mny, al) : Infinity);
      diagrama = { pts: diag.pts, Pu, Mz: F.Mz, My: F.My, Mnz, Mny, biaxial: true, nBars: rl.nBars };
      interaction = ratObj(r, 1, { adim: true, modo: 'flexocompresión biaxial',
        reinforcement: nBars ? `${nBars} barras` : `ρ=${rho}`,
        formula: `(Mz/Mnz)^${al}+(My/Mny)^${al} ≤ 1 (contorno de carga, Mnz/Mny al axial Pu)` });
    } else {
      const r = pmRatio(diag, Pu, Mu);
      diagrama = { pts: diag.pts, Pu, Mu, axis: bendStrong ? 'Mz' : 'My', nBars: rl.nBars };
      interaction = ratObj(r, 1, { adim: true, modo: Pu >= 0 ? 'flexocompresión' : 'flexotracción',
        reinforcement: nBars ? `${nBars} barras` : `ρ=${rho}`,
        formula: 'Diagrama P–M (compatibilidad de deformaciones + bloque de Whitney' + (nBars ? ', barras explícitas' : ', ρ') + ')' });
    }
  } catch (e) {
    const H = (Pc > 1e-12 ? Nabs / Pc : 0) + (Mn > 1e-12 ? Mmax / Mn : 0);
    interaction = ratObj(H, 1, { adim: true, formula: 'Pu/φPn + Mu/φMn (lineal, respaldo)' });
  }

  return finalize({ material: 'concrete', method: codeLabel, bending, shear, axial, interaction, diagrama }, options);
}

export const aci318 = {
  id: 'ACI318-19', family: 'concrete', label: 'ACI 318-19',
  check: (input) => checkConcrete(input, 'Resistencia última (ACI 318-19)'),
};
// EC2 shares the same simplified procedure here (same rectangular-block formulas);
// it is distinguished by label. For rigorous EC2 use γc, γs and the
// parabola-rectangle diagram.
export const eurocode2 = {
  id: 'EN1992-1-1', family: 'concrete', label: 'Eurocódigo 2 (EN 1992-1-1, simplificado)',
  check: (input) => checkConcrete(input, 'Resistencia última (EN 1992-1-1, simplificado)'),
};
