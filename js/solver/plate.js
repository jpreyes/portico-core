// ──────────────────────────────────────────────────────────────────────────────
// plate.js — PLATE BENDING elements.  Shell = membrane + plate.
//
//   · MITC4 — 4-node Mindlin-Reissner quadrilateral with ASSUMED shear
//             interpolation (Bathe-Dvorkin 1985) → NO shear locking (thin & thick).
//   · DKT   — Discrete Kirchhoff Triangle of 3 nodes (Batoz 1980), thin plate.
//
// Local DOF convention per node:  [w, θx, θy]
//   w  = transverse translation (along the element plane's normal ez)
//   θx = rotation about the local x axis (ex)
//   θy = rotation about the local y axis (ey)
//   → consistent with the frames' rotational DOFs, so a node shared between a plate
//     and a bar couples correctly.
//
//   Displacement field:  u = z·θy ,  v = −z·θx ,  w = w   (ω×r, ω=(θx,θy,0))
//   Curvatures:  κ = [∂θy/∂x ; −∂θx/∂y ; ∂θy/∂y − ∂θx/∂x]
//   Shear:       γ = [∂w/∂x + θy ; ∂w/∂y − θx]
//
// SELF-CONTAINED (no dependencies) → verifiable in Node (square simply-supported/clamped plate).
// ──────────────────────────────────────────────────────────────────────────────

// Plate bending constitutive Db (3×3) = (t³/12)·Dp, with Dp plane stress.
// Also returns Ds (shear, 2×2) = κs·G·t·I.
export function plateD(E, nu, t) {
  const cp = E / (1 - nu * nu);
  const f = t * t * t / 12;
  const Db = [[cp * f, cp * nu * f, 0], [cp * nu * f, cp * f, 0], [0, 0, cp * (1 - nu) / 2 * f]];
  const G = E / (2 * (1 + nu));
  const ks = 5 / 6;
  const Ds = [[ks * G * t, 0], [0, ks * G * t]];
  return { Db, Ds };
}

// ── MITC4 ────────────────────────────────────────────────────────────────────
const G1 = 1 / Math.sqrt(3);
const GP4 = [[-G1, -G1], [G1, -G1], [G1, G1], [-G1, G1]];

// Bilinear shape functions and natural derivatives at (ξ,η).
function shapeQ4(xi, eta) {
  const N = [(1 - xi) * (1 - eta) / 4, (1 + xi) * (1 - eta) / 4, (1 + xi) * (1 + eta) / 4, (1 - xi) * (1 + eta) / 4];
  const dNdxi = [-(1 - eta) / 4, (1 - eta) / 4, (1 + eta) / 4, -(1 + eta) / 4];
  const dNdeta = [-(1 - xi) / 4, -(1 + xi) / 4, (1 + xi) / 4, (1 - xi) / 4];
  return { N, dNdxi, dNdeta };
}

// Jacobian J = [[∂x/∂ξ,∂y/∂ξ],[∂x/∂η,∂y/∂η]] and its inverse.
function jacQ4(coords, dNdxi, dNdeta) {
  let J00 = 0, J01 = 0, J10 = 0, J11 = 0;
  for (let i = 0; i < 4; i++) {
    J00 += dNdxi[i] * coords[i][0]; J01 += dNdxi[i] * coords[i][1];
    J10 += dNdeta[i] * coords[i][0]; J11 += dNdeta[i] * coords[i][1];
  }
  const detJ = J00 * J11 - J01 * J10;
  const iJ = [[J11 / detJ, -J01 / detJ], [-J10 / detJ, J00 / detJ]];
  return { J: [[J00, J01], [J10, J11]], iJ, detJ };
}

// COVARIANT shear component at a point:  γ_ξ or γ_η  (12-vector over the DOFs).
//   γ_ξ = ∂w/∂ξ + θy·∂x/∂ξ − θx·∂y/∂ξ ;  γ_η analogous with ∂/∂η.
// Returns rows {gXi, gEta} (Float64Array(12)) in terms of the DOFs [w,θx,θy]×4.
function covariantShearRows(coords, xi, eta) {
  const { dNdxi, dNdeta, N } = shapeQ4(xi, eta);
  const { J } = jacQ4(coords, dNdxi, dNdeta);
  const dxdxi = J[0][0], dydxi = J[0][1], dxdeta = J[1][0], dydeta = J[1][1];
  const gXi = new Float64Array(12), gEta = new Float64Array(12);
  for (let i = 0; i < 4; i++) {
    const c = 3 * i;
    // γ_ξ : ∂w/∂ξ + θy·∂x/∂ξ − θx·∂y/∂ξ
    gXi[c] = dNdxi[i];                       // w
    gXi[c + 1] = -N[i] * dydxi;              // θx
    gXi[c + 2] = N[i] * dxdxi;               // θy
    // γ_η
    gEta[c] = dNdeta[i];
    gEta[c + 1] = -N[i] * dydeta;
    gEta[c + 2] = N[i] * dxdeta;
  }
  return { gXi, gEta };
}

// Bending Bb (3×12) at a Gauss point.  κ = [∂θy/∂x ; −∂θx/∂y ; ∂θy/∂y−∂θx/∂x].
function bBendingQ4(coords, xi, eta) {
  const { dNdxi, dNdeta } = shapeQ4(xi, eta);
  const { iJ, detJ } = jacQ4(coords, dNdxi, dNdeta);
  const Bb = [new Float64Array(12), new Float64Array(12), new Float64Array(12)];
  for (let i = 0; i < 4; i++) {
    const dNdx = iJ[0][0] * dNdxi[i] + iJ[0][1] * dNdeta[i];
    const dNdy = iJ[1][0] * dNdxi[i] + iJ[1][1] * dNdeta[i];
    const c = 3 * i;
    Bb[0][c + 2] = dNdx;            // ∂θy/∂x
    Bb[1][c + 1] = -dNdy;           // −∂θx/∂y
    Bb[2][c + 2] = dNdy;            // ∂θy/∂y
    Bb[2][c + 1] = -dNdx;           // −∂θx/∂x
  }
  return { Bb, detJ };
}

// ASSUMED MITC4 shear Bs (2×12) at a point (ξ,η).
// γ_ξ tied at A(0,−1),C(0,1) (linear in η); γ_η at B(1,0),D(−1,0) (linear in ξ).
// Cartesian [γxz;γyz] = J⁻¹·[γ_ξ;γ_η].
function bShearMITC4(coords, xi, eta) {
  const A = covariantShearRows(coords, 0, -1).gXi;   // γ_ξ at A
  const C = covariantShearRows(coords, 0, 1).gXi;    // γ_ξ at C
  const B = covariantShearRows(coords, 1, 0).gEta;   // γ_η at B
  const D = covariantShearRows(coords, -1, 0).gEta;  // γ_η at D
  const gXi = new Float64Array(12), gEta = new Float64Array(12);
  for (let k = 0; k < 12; k++) {
    gXi[k] = 0.5 * (1 - eta) * A[k] + 0.5 * (1 + eta) * C[k];
    gEta[k] = 0.5 * (1 + xi) * B[k] + 0.5 * (1 - xi) * D[k];
  }
  const { dNdxi, dNdeta } = shapeQ4(xi, eta);
  const { iJ } = jacQ4(coords, dNdxi, dNdeta);
  const Bs = [new Float64Array(12), new Float64Array(12)];
  for (let k = 0; k < 12; k++) {
    Bs[0][k] = iJ[0][0] * gXi[k] + iJ[0][1] * gEta[k];   // γxz
    Bs[1][k] = iJ[1][0] * gXi[k] + iJ[1][1] * gEta[k];   // γyz
  }
  return Bs;
}

// MITC4 Ke(12×12).  DOF per node [w,θx,θy].
export function mitc4Plate(coords, E, nu, t) {
  const { Db, Ds } = plateD(E, nu, t);
  const Ke = new Float64Array(144);
  for (const [xi, eta] of GP4) {
    const { Bb, detJ } = bBendingQ4(coords, xi, eta);
    const Bs = bShearMITC4(coords, xi, eta);
    // Kb += detJ·Bbᵀ Db Bb
    const DB = [new Float64Array(12), new Float64Array(12), new Float64Array(12)];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 12; c++) DB[r][c] = Db[r][0] * Bb[0][c] + Db[r][1] * Bb[1][c] + Db[r][2] * Bb[2][c];
    // Ks += detJ·Bsᵀ Ds Bs
    const DS = [new Float64Array(12), new Float64Array(12)];
    for (let r = 0; r < 2; r++) for (let c = 0; c < 12; c++) DS[r][c] = Ds[r][0] * Bs[0][c] + Ds[r][1] * Bs[1][c];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
      let v = 0;
      for (let r = 0; r < 3; r++) v += Bb[r][i] * DB[r][j];
      for (let r = 0; r < 2; r++) v += Bs[r][i] * DS[r][j];
      Ke[i * 12 + j] += detJ * v;
    }
  }
  return Ke;
}

// ── DKT (Batoz) ──────────────────────────────────────────────────────────────
// Builder of the DKT B matrix (3×9) and the area, shared by the stiffness
// (dktPlate) and the moment recovery (plateMoments).  Authoritative serendipity
// construction (a,b,c,d,e) from Batoz–Bathe–Ho (1980).
function _dktBMat(coords) {
  const [[x1, y1], [x2, y2], [x3, y3]] = coords;
  const x23 = x2 - x3, x31 = x3 - x1, x12 = x1 - x2;
  const y23 = y2 - y3, y31 = y3 - y1, y12 = y1 - y2;
  const A2 = x31 * y12 - x12 * y31;                // = 2·Area (oriented)
  const Ar = Math.abs(A2) / 2;
  const L = { 4: x23 * x23 + y23 * y23, 5: x31 * x31 + y31 * y31, 6: x12 * x12 + y12 * y12 };
  const xij = { 4: x23, 5: x31, 6: x12 }, yij = { 4: y23, 5: y31, 6: y12 };
  const a = {}, b = {}, c = {}, d = {}, e = {};
  for (const k of [4, 5, 6]) {
    a[k] = -xij[k] / L[k];
    b[k] = 0.75 * xij[k] * yij[k] / L[k];
    c[k] = (0.25 * xij[k] * xij[k] - 0.5 * yij[k] * yij[k]) / L[k];
    d[k] = -yij[k] / L[k];
    e[k] = (0.25 * yij[k] * yij[k] - 0.5 * xij[k] * xij[k]) / L[k];
  }

  // Derivatives of the serendipity N at (ξ,η).  L1=1-ξ-η, L2=ξ, L3=η.
  function dN(xi, eta) {
    const l1 = 1 - xi - eta;
    return {
      dxi: [(4 * l1 - 1) * -1, 4 * xi - 1, 0, 4 * eta, -4 * eta, 4 * (1 - 2 * xi - eta)],
      det: [(4 * l1 - 1) * -1, 0, 4 * eta - 1, 4 * xi, 4 * (1 - xi - 2 * eta), -4 * xi],
    };
  }
  // Hx, Hy (9-vectors) and their derivatives ∂/∂ξ, ∂/∂η (linear combinations of dN).
  function HxHy(xi, eta) {
    const { dxi, det } = dN(xi, eta);
    const N1x = dxi[0], N2x = dxi[1], N3x = dxi[2], N4x = dxi[3], N5x = dxi[4], N6x = dxi[5];
    const N1e = det[0], N2e = det[1], N3e = det[2], N4e = det[3], N5e = det[4], N6e = det[5];
    const Hxxi = [
      1.5 * (a[6] * N6x - a[5] * N5x), b[5] * N5x + b[6] * N6x, N1x - c[5] * N5x - c[6] * N6x,
      1.5 * (a[4] * N4x - a[6] * N6x), b[4] * N4x + b[6] * N6x, N2x - c[4] * N4x - c[6] * N6x,
      1.5 * (a[5] * N5x - a[4] * N4x), b[4] * N4x + b[5] * N5x, N3x - c[4] * N4x - c[5] * N5x];
    const Hxeta = [
      1.5 * (a[6] * N6e - a[5] * N5e), b[5] * N5e + b[6] * N6e, N1e - c[5] * N5e - c[6] * N6e,
      1.5 * (a[4] * N4e - a[6] * N6e), b[4] * N4e + b[6] * N6e, N2e - c[4] * N4e - c[6] * N6e,
      1.5 * (a[5] * N5e - a[4] * N4e), b[4] * N4e + b[5] * N5e, N3e - c[4] * N4e - c[5] * N5e];
    const Hyxi = [
      1.5 * (d[6] * N6x - d[5] * N5x), -N1x + e[5] * N5x + e[6] * N6x, -b[5] * N5x - b[6] * N6x,
      1.5 * (d[4] * N4x - d[6] * N6x), -N2x + e[4] * N4x + e[6] * N6x, -b[4] * N4x - b[6] * N6x,
      1.5 * (d[5] * N5x - d[4] * N4x), -N3x + e[4] * N4x + e[5] * N5x, -b[4] * N4x - b[5] * N5x];
    const Hyeta = [
      1.5 * (d[6] * N6e - d[5] * N5e), -N1e + e[5] * N5e + e[6] * N6e, -b[5] * N5e - b[6] * N6e,
      1.5 * (d[4] * N4e - d[6] * N6e), -N2e + e[4] * N4e + e[6] * N6e, -b[4] * N4e - b[6] * N6e,
      1.5 * (d[5] * N5e - d[4] * N4e), -N3e + e[4] * N4e + e[5] * N5e, -b[4] * N4e - b[5] * N5e];
    return { Hxxi, Hyxi, Hxeta, Hyeta };
  }

  // B (3×9) at (ξ,η).  κ = [∂βx/∂x ; ∂βy/∂y ; ∂βx/∂y+∂βy/∂x], chained with J⁻¹.
  function bMat(xi, eta) {
    const { Hxxi, Hyxi, Hxeta, Hyeta } = HxHy(xi, eta);
    const B = [new Float64Array(9), new Float64Array(9), new Float64Array(9)];
    for (let k = 0; k < 9; k++) {
      B[0][k] = (y31 * Hxxi[k] + y12 * Hxeta[k]) / A2;
      B[1][k] = (-x31 * Hyxi[k] - x12 * Hyeta[k]) / A2;
      B[2][k] = (-x31 * Hxxi[k] - x12 * Hxeta[k] + y31 * Hyxi[k] + y12 * Hyeta[k]) / A2;
    }
    return B;
  }
  return { bMat, Ar };
}

// Thin Kirchhoff triangle.  DOF per node [w,θx,θy] (θx=rot x, θy=rot y).
// 3-point integration at the mid-points of the sides.
export function dktPlate(coords, E, nu, t) {
  const { bMat, Ar } = _dktBMat(coords);
  const cp = E / (1 - nu * nu), f = t * t * t / 12;
  const Db = [[cp * f, cp * nu * f, 0], [cp * nu * f, cp * f, 0], [0, 0, cp * (1 - nu) / 2 * f]];

  const Ke = new Float64Array(81);
  const gp = [[0.5, 0], [0.5, 0.5], [0, 0.5]];   // side mid-points, weight A/3
  for (const [xi, eta] of gp) {
    const B = bMat(xi, eta);
    const DB = [new Float64Array(9), new Float64Array(9), new Float64Array(9)];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) DB[r][c] = Db[r][0] * B[0][c] + Db[r][1] * B[1][c] + Db[r][2] * B[2][c];
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) {
      let v = 0; for (let r = 0; r < 3; r++) v += B[r][i] * DB[r][j];
      Ke[i * 9 + j] += (Ar / 3) * v;
    }
  }
  // The serendipity construction in _dktBMat already yields B in the SAME convention
  // as MITC4 and the frames: local DOFs [w, θx, θy] with θx=∂w/∂y, θy=−∂w/∂x, i.e. the
  // global rotation vector decomposed on (ex,ey). NO rotational sign flip is applied —
  // flipping would place DKT in the opposite (Batoz) convention, which is invisible in
  // a pure-triangle mesh under transverse load (w is sign-independent) but corrupts any
  // model where a triangle shares rotational DOFs with another element: mixed quad+tri
  // meshes, a beam framed into a triangular shell node, or applied nodal moments. The
  // moment/curvature recovery and thermal load below use the same raw convention.
  // Regression: test_dkt_distorted.mjs (constant-curvature patch + mixed quad/tri mesh).
  return Ke;
}

// ── BENDING thermal load (gradient through the thickness) ──────────────────────
// A linear temperature gradient ΔT_grad = T_top − T_bot through the thickness
// imposes an initial thermal curvature κ₀ = α·ΔT_grad/t · [1,1,0]. The equivalent
// nodal load vector is f = ∫ Bbᵀ·Db·κ₀ dA (same point/quadrature as Ke); when
// solving K·d = f a free plate adopts κ = κ₀ with zero moment.
// Returns the local vector (3·nN) in DOFs [w,θx,θy] (OUR convention).
export function plateThermalLoad(coords, E, nu, t, kappa0) {
  const { Db } = plateD(E, nu, t);
  const Mt = [   // M_T = Db·κ₀
    Db[0][0] * kappa0[0] + Db[0][1] * kappa0[1] + Db[0][2] * kappa0[2],
    Db[1][0] * kappa0[0] + Db[1][1] * kappa0[1] + Db[1][2] * kappa0[2],
    Db[2][0] * kappa0[0] + Db[2][1] * kappa0[1] + Db[2][2] * kappa0[2],
  ];
  const nN = coords.length;
  const f = new Float64Array(3 * nN);
  if (nN === 4) {
    for (const [xi, eta] of GP4) {
      const { Bb, detJ } = bBendingQ4(coords, xi, eta);
      for (let i = 0; i < 12; i++) f[i] += detJ * (Bb[0][i] * Mt[0] + Bb[1][i] * Mt[1] + Bb[2][i] * Mt[2]);
    }
  } else {
    const { bMat, Ar } = _dktBMat(coords);
    const gp = [[0.5, 0], [0.5, 0.5], [0, 0.5]];   // same points as dktPlate
    for (const [xi, eta] of gp) {
      const B = bMat(xi, eta);
      for (let i = 0; i < 9; i++) f[i] += (Ar / 3) * (B[0][i] * Mt[0] + B[1][i] * Mt[1] + B[2][i] * Mt[2]);
    }
    // Same [w,θx,θy] convention as dktPlate (θx=∂w/∂y, θy=−∂w/∂x); the raw B needs
    // no rotational sign flip — see the note in dktPlate.
  }
  return f;
}

// ── Plate moment recovery ─────────────────────────────────────────────────────
// Moments per unit length [Mx, My, Mxy] at the element center, from the local DOFs
// dLocal = [w,θx,θy]×nN (OUR convention).  Used for the surface-fiber stress
// σ = ±6·M/t².
// Plate curvatures [κx, κy, κxy] at the center (centroid in DKT). They only depend
// on the geometry and the local DOFs [w,θx,θy] per node, not on the material.
export function plateCurvatures(coords, dLocal) {
  const nN = coords.length;
  let B, nD, d = dLocal;
  if (nN === 4) {
    B = bBendingQ4(coords, 0, 0).Bb;   // center (ξ=η=0)
    nD = 12;
  } else {
    // Raw B is already in OUR [w,θx,θy] convention (see dktPlate) — no DOF sign flip.
    B = _dktBMat(coords).bMat(1 / 3, 1 / 3);   // centroid
    nD = 9;
  }
  const kappa = [0, 0, 0];
  for (let r = 0; r < 3; r++) { let s = 0; for (let k = 0; k < nD; k++) s += B[r][k] * d[k]; kappa[r] = s; }
  return kappa;
}

export function plateMoments(coords, E, nu, t, dLocal) {
  const { Db } = plateD(E, nu, t);
  const kappa = plateCurvatures(coords, dLocal);
  return [
    Db[0][0] * kappa[0] + Db[0][1] * kappa[1] + Db[0][2] * kappa[2],
    Db[1][0] * kappa[0] + Db[1][1] * kappa[1] + Db[1][2] * kappa[2],
    Db[2][0] * kappa[0] + Db[2][1] * kappa[1] + Db[2][2] * kappa[2],
  ];
}
