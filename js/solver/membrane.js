// ──────────────────────────────────────────────────────────────────────────────
// membrane.js — 2D PLANE-STRESS/PLANE-STRAIN elements (membrane).
//
//   · CST  — constant-strain triangle (3 nodes, 2 DOF/node).
//   · QUAD — 4-node isoparametric quadrilateral (2×2 Gauss integration).
//
// Both with elastic material + TEMPERATURE LOAD (initial thermal strain
// ε₀ = α·ΔT). Plane stress or plane strain. Faithful to CST.m/QUAD.m from
// Chandrupatla & Belegundu. They work in the element's LOCAL 2D coordinates; the
// assembler transforms them to the global translational DOFs (any 3D plane).
//
// Verifiable in Node with a patch test. The BENDING (plate) term is provided by
// plate.js → a 'shell' area = membrane + plate.
// Local DOF convention: [u1,v1, u2,v2, ...] (x,y in the element plane).
// ──────────────────────────────────────────────────────────────────────────────

import { mitc4Plate, dktPlate, plateMoments, plateCurvatures, plateThermalLoad, plateD } from './plate.js?v=2';

// Constitutive plane matrix D (3×3). planeStrain=false → plane stress.
export function Dmatrix(E, nu, planeStrain = false) {
  if (planeStrain) {
    const c = E / ((1 + nu) * (1 - 2 * nu));
    return [[c * (1 - nu), c * nu, 0], [c * nu, c * (1 - nu), 0], [0, 0, c * (1 - 2 * nu) / 2]];
  }
  const c = E / (1 - nu * nu);
  return [[c, c * nu, 0], [c * nu, c, 0], [0, 0, c * (1 - nu) / 2]];
}

// Initial thermal strain ε₀ = α·ΔT·[1,1,0]  (plane stress).
// In plane strain it is amplified by (1+ν) (out-of-plane confinement).
function thermalStrain(alpha, dT, nu, planeStrain) {
  const e = alpha * dT * (planeStrain ? (1 + nu) : 1);
  return [e, e, 0];
}

// Accumulated Bᵀ·D·B (helper): adds w·(Bᵀ D B) to Ke (n×n) and w·(Bᵀ D ε₀) to fThermal.
function accumulateBDB(Ke, fT, B, D, e0, w, nDOF) {
  // DB = D·B (3×nDOF)
  const DB = [new Float64Array(nDOF), new Float64Array(nDOF), new Float64Array(nDOF)];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < nDOF; c++)
      DB[r][c] = D[r][0] * B[0][c] + D[r][1] * B[1][c] + D[r][2] * B[2][c];
  // Ke += w·Bᵀ·DB ;  fT += w·Bᵀ·(D·ε₀)
  const De0 = [D[0][0] * e0[0] + D[0][1] * e0[1] + D[0][2] * e0[2],
               D[1][0] * e0[0] + D[1][1] * e0[1] + D[1][2] * e0[2],
               D[2][0] * e0[0] + D[2][1] * e0[1] + D[2][2] * e0[2]];
  for (let i = 0; i < nDOF; i++) {
    for (let j = 0; j < nDOF; j++)
      Ke[i * nDOF + j] += w * (B[0][i] * DB[0][j] + B[1][i] * DB[1][j] + B[2][i] * DB[2][j]);
    fT[i] += w * (B[0][i] * De0[0] + B[1][i] * De0[1] + B[2][i] * De0[2]);
  }
}

// ── CST: constant-strain triangle ───────────────────────────────────────────
// coords = [[x1,y1],[x2,y2],[x3,y3]] (2D local). Returns { Ke(6×6 in-plane), fT(6),
// B(3×6), area }. fT = thermal load vector (ε₀ = α·ΔT).
export function cstElement(coords, D, t, e0 = [0, 0, 0]) {
  const [[x1, y1], [x2, y2], [x3, y3]] = coords;
  const b1 = y2 - y3, b2 = y3 - y1, b3 = y1 - y2;
  const c1 = x3 - x2, c2 = x1 - x3, c3 = x2 - x1;
  const det = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
  const area = Math.abs(det) / 2;
  const inv2A = 1 / (det);   // 1/(2A) with sign (det = oriented 2A)
  // B (3×6): rows εx, εy, γxy ; cols [u1,v1,u2,v2,u3,v3]
  const B = [
    [b1 * inv2A, 0, b2 * inv2A, 0, b3 * inv2A, 0],
    [0, c1 * inv2A, 0, c2 * inv2A, 0, c3 * inv2A],
    [c1 * inv2A, b1 * inv2A, c2 * inv2A, b2 * inv2A, c3 * inv2A, b3 * inv2A],
  ];
  const Ke = new Float64Array(36), fT = new Float64Array(6);
  accumulateBDB(Ke, fT, B, D, e0, t * area, 6);
  return { Ke, fT, B, area };
}

// CST stress: σ = D·(B·u − ε₀). u = [u1,v1,u2,v2,u3,v3] (local).
export function cstStress(B, D, u, e0 = [0, 0, 0]) {
  const eps = [0, 0, 0];
  for (let r = 0; r < 3; r++) { let s = 0; for (let c = 0; c < 6; c++) s += B[r][c] * u[c]; eps[r] = s - e0[r]; }
  return [
    D[0][0] * eps[0] + D[0][1] * eps[1] + D[0][2] * eps[2],
    D[1][0] * eps[0] + D[1][1] * eps[1] + D[1][2] * eps[2],
    D[2][0] * eps[0] + D[2][1] * eps[1] + D[2][2] * eps[2],
  ];
}

// ── ALLMAN: membrane triangle with in-plane ROTATIONAL DOFs (drilling) ───────
// 3-node triangle with 3 DOF/node [u, v, ωz]. Built from the linear-strain
// triangle (LST, 6 nodes) by replacing the mid-side translational DOFs with the
// corner rotations (Allman 1984):
//   u_mid = (u_i+u_j)/2 + (1/8)(y_i−y_j)(ω_j−ω_i)
//   v_mid = (v_i+v_j)/2 + (1/8)(x_j−x_i)(ω_j−ω_i)
// It is much less stiff than the CST in in-plane bending. The only non-rigid
// zero-energy mode (uniform drilling ω₁=ω₂=ω₃) is removed with a MINIMAL diagonal
// spring on the rotational DOFs (εd≪1), which barely affects the real bending.
// Local DOF grouped per node: [u1,v1,ω1, u2,v2,ω2, u3,v3,ω3].
const ALLMAN_GAMMA = 1e-3;   // εd: diagonal drilling spring (fraction of the rotational stiffness)

// B (3×12) of the LST in area coordinates (ζ1,ζ2,ζ3). Cols [u1,v1,…,u6,v6]
// (nodes 4,5,6 = mid-side 1-2, 2-3, 3-1). Also returns det=2A.
function bMatrixLST(coords, z1, z2, z3) {
  const [[x1, y1], [x2, y2], [x3, y3]] = coords;
  const b = [y2 - y3, y3 - y1, y1 - y2];   // b_i = y_j − y_k
  const c = [x3 - x2, x1 - x3, x2 - x1];   // c_i = x_k − x_j
  const det = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);   // 2A
  const z = [z1, z2, z3];
  // ∂N/∂ζ_k for the 6 LST nodes
  const dNdz = [   // [node][k]
    [4 * z[0] - 1, 0, 0], [0, 4 * z[1] - 1, 0], [0, 0, 4 * z[2] - 1],
    [4 * z[1], 4 * z[0], 0], [0, 4 * z[2], 4 * z[1]], [4 * z[2], 0, 4 * z[0]],
  ];
  const B = [new Float64Array(12), new Float64Array(12), new Float64Array(12)];
  for (let n = 0; n < 6; n++) {
    let dNdx = 0, dNdy = 0;
    for (let k = 0; k < 3; k++) { dNdx += dNdz[n][k] * b[k]; dNdy += dNdz[n][k] * c[k]; }
    dNdx /= det; dNdy /= det;
    B[0][2 * n] = dNdx;
    B[1][2 * n + 1] = dNdy;
    B[2][2 * n] = dNdy; B[2][2 * n + 1] = dNdx;
  }
  return { B, det };
}

// Transformation matrix T (12×9): LST DOFs = T · [u,v,ω]×3 (Allman 1984).
function allmanT(coords) {
  const [[x1, y1], [x2, y2], [x3, y3]] = coords;
  const T = Array.from({ length: 12 }, () => new Float64Array(9));
  // corners (identity): LST 0,1=node1 ; 2,3=node2 ; 4,5=node3
  T[0][0] = 1; T[1][1] = 1; T[2][3] = 1; T[3][4] = 1; T[4][6] = 1; T[5][7] = 1;
  // mid-side 4 (1-2): u₄=½(u₁+u₂)+⅛(y₁−y₂)(ω₂−ω₁); v₄=½(v₁+v₂)+⅛(x₂−x₁)(ω₂−ω₁)
  T[6][0] = 0.5; T[6][3] = 0.5; T[6][2] = -(y1 - y2) / 8; T[6][5] = (y1 - y2) / 8;
  T[7][1] = 0.5; T[7][4] = 0.5; T[7][2] = -(x2 - x1) / 8; T[7][5] = (x2 - x1) / 8;
  // mid-side 5 (2-3): ⅛(y₂−y₃)(ω₃−ω₂), ⅛(x₃−x₂)(ω₃−ω₂)
  T[8][3] = 0.5; T[8][6] = 0.5; T[8][5] = -(y2 - y3) / 8; T[8][8] = (y2 - y3) / 8;
  T[9][4] = 0.5; T[9][7] = 0.5; T[9][5] = -(x3 - x2) / 8; T[9][8] = (x3 - x2) / 8;
  // mid-side 6 (3-1): ⅛(y₃−y₁)(ω₁−ω₃), ⅛(x₁−x₃)(ω₁−ω₃)
  T[10][6] = 0.5; T[10][0] = 0.5; T[10][8] = -(y3 - y1) / 8; T[10][2] = (y3 - y1) / 8;
  T[11][7] = 0.5; T[11][1] = 0.5; T[11][8] = -(x1 - x3) / 8; T[11][2] = (x1 - x3) / 8;
  return T;
}

// Returns { Ke(9×9), fT(9), area, T(12×9), Bc(3×12 at the centroid) }.
// Local DOF [u1,v1,ω1, u2,v2,ω2, u3,v3,ω3]. e0 = thermal ε₀.
export function allmanElement(coords, D, t, e0 = [0, 0, 0], gamma = ALLMAN_GAMMA) {
  const T = allmanT(coords);
  const area = Math.abs(bMatrixLST(coords, 1 / 3, 1 / 3, 1 / 3).det) / 2;
  // K_LST and f_LST (12) by 3-point integration (mid-side) — exact for the LST.
  const KL = new Float64Array(144), fL = new Float64Array(12);
  const GPT = [[0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]];
  for (const [z1, z2, z3] of GPT) {
    const { B } = bMatrixLST(coords, z1, z2, z3);
    accumulateBDB(KL, fL, B, D, e0, t * area / 3, 12);
  }
  // Ke = Tᵀ·K_LST·T ; fT = Tᵀ·f_LST
  const Ke = new Float64Array(81), fT = new Float64Array(9);
  for (let i = 0; i < 9; i++) {
    for (let p = 0; p < 12; p++) {
      const tpi = T[p][i]; if (!tpi) continue;
      fT[i] += tpi * fL[p];
      for (let j = 0; j < 9; j++) {
        let s = 0; for (let q = 0; q < 12; q++) s += KL[p * 12 + q] * T[q][j];
        Ke[i * 9 + j] += tpi * s;
      }
    }
  }
  // ── Stabilization of the spurious mode (uniform drilling) ──────────────────
  // The only non-rigid zero-energy mode is ω₁=ω₂=ω₃ with null translations. I
  // remove it with a MINIMAL diagonal spring on the rotational DOFs, scaled to the
  // genuine rotational stiffness (εd≪1). A Hughes-Brezzi penalty on (ω−ω_continuous)
  // would couple the translations and stiffen the real bending; this diagonal spring
  // barely affects it and keeps K non-singular. εd=1e-3 leaves the Allman WELL below
  // the CST stiffness (verified in test_allman.mjs).
  let kdrill = 0;
  for (const i of [2, 5, 8]) kdrill += Ke[i * 9 + i];
  kdrill = gamma * kdrill / 3;
  for (const i of [2, 5, 8]) Ke[i * 9 + i] += kdrill;
  const Bc = bMatrixLST(coords, 1 / 3, 1 / 3, 1 / 3).B;
  return { Ke, fT, area, T, Bc };
}

// Allman stress at the CENTROID. d9 = [u1,v1,ω1,…] (local). e0 thermal.
export function allmanStress(T, Bc, D, d9, e0 = [0, 0, 0]) {
  const dL = new Float64Array(12);
  for (let p = 0; p < 12; p++) { let s = 0; for (let i = 0; i < 9; i++) s += T[p][i] * d9[i]; dL[p] = s; }
  const eps = [0, 0, 0];
  for (let r = 0; r < 3; r++) { let s = 0; for (let cc = 0; cc < 12; cc++) s += Bc[r][cc] * dL[cc]; eps[r] = s - e0[r]; }
  return [
    D[0][0] * eps[0] + D[0][1] * eps[1] + D[0][2] * eps[2],
    D[1][0] * eps[0] + D[1][1] * eps[1] + D[1][2] * eps[2],
    D[2][0] * eps[0] + D[2][1] * eps[1] + D[2][2] * eps[2],
  ];
}

// ── QUAD: 4-node isoparametric quadrilateral (2×2 Gauss) ─────────────────────
const G = 1 / Math.sqrt(3);
const GP = [[-G, -G], [G, -G], [G, G], [-G, G]];   // Gauss points (w=1 each)

// Bilinear shape functions and their derivatives at (ξ,η).
function shapeQ4(xi, eta) {
  const N = [(1 - xi) * (1 - eta) / 4, (1 + xi) * (1 - eta) / 4, (1 + xi) * (1 + eta) / 4, (1 - xi) * (1 + eta) / 4];
  const dNdxi = [-(1 - eta) / 4, (1 - eta) / 4, (1 + eta) / 4, -(1 + eta) / 4];
  const dNdeta = [-(1 - xi) / 4, -(1 + xi) / 4, (1 + xi) / 4, (1 - xi) / 4];
  return { N, dNdxi, dNdeta };
}

// B (3×8) and det(J) at a Gauss point. coords = [[x,y]×4].
export function bMatrixQ4(coords, xi, eta) {
  const { dNdxi, dNdeta } = shapeQ4(xi, eta);
  let J00 = 0, J01 = 0, J10 = 0, J11 = 0;
  for (let i = 0; i < 4; i++) {
    J00 += dNdxi[i] * coords[i][0]; J01 += dNdxi[i] * coords[i][1];
    J10 += dNdeta[i] * coords[i][0]; J11 += dNdeta[i] * coords[i][1];
  }
  const detJ = J00 * J11 - J01 * J10;
  const iJ00 = J11 / detJ, iJ01 = -J01 / detJ, iJ10 = -J10 / detJ, iJ11 = J00 / detJ;
  const B = [new Float64Array(8), new Float64Array(8), new Float64Array(8)];
  for (let i = 0; i < 4; i++) {
    const dNdx = iJ00 * dNdxi[i] + iJ01 * dNdeta[i];
    const dNdy = iJ10 * dNdxi[i] + iJ11 * dNdeta[i];
    B[0][2 * i] = dNdx;            // εx
    B[1][2 * i + 1] = dNdy;        // εy
    B[2][2 * i] = dNdy; B[2][2 * i + 1] = dNdx;   // γxy
  }
  return { B, detJ };
}

// Returns { Ke(8×8 in-plane), fT(8), area }. e0 = thermal ε₀.
export function quadElement(coords, D, t, e0 = [0, 0, 0]) {
  const Ke = new Float64Array(64), fT = new Float64Array(8);
  let area = 0;
  for (const [xi, eta] of GP) {
    const { B, detJ } = bMatrixQ4(coords, xi, eta);
    area += detJ;
    accumulateBDB(Ke, fT, B, D, e0, t * detJ, 8);
  }
  return { Ke, fT, area };
}

// QUAD stress at the CENTER (ξ=η=0). u = [u1,v1,...,u4,v4] (local).
export function quadStressCenter(coords, D, u, e0 = [0, 0, 0]) {
  const { B } = bMatrixQ4(coords, 0, 0);
  const eps = [0, 0, 0];
  for (let r = 0; r < 3; r++) { let s = 0; for (let c = 0; c < 8; c++) s += B[r][c] * u[c]; eps[r] = s - e0[r]; }
  return [
    D[0][0] * eps[0] + D[0][1] * eps[1] + D[0][2] * eps[2],
    D[1][0] * eps[0] + D[1][1] * eps[1] + D[1][2] * eps[2],
    D[2][0] * eps[0] + D[2][1] * eps[1] + D[2][2] * eps[2],
  ];
}

// von Mises stress (plane): √(σx²−σxσy+σy²+3τxy²).
export function vonMises([sx, sy, txy]) { return Math.sqrt(sx * sx - sx * sy + sy * sy + 3 * txy * txy); }

export { thermalStrain };

// ── 3D integration: membrane on any plane in space ──────────────────────────
const _sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const _cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const _dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const _nrm = a => Math.sqrt(_dot(a, a));

// Element local 2D frame from its 3D coords: ex (node1→node2), ez (normal =
// ex×(node1→node3)), ey = ez×ex. Returns {ex,ey,ez, local:[[x,y]…]}.
export function areaLocalFrame(coords3d) {
  const p0 = coords3d[0];
  const e1 = _sub(coords3d[1], p0);
  const e2 = _sub(coords3d[2], p0);
  const L1 = _nrm(e1), L2 = _nrm(e2);
  const ex = e1.map(v => v / (L1 || 1));
  const z  = _cross(e1, e2);
  const nz = _nrm(z);                                 // = 2·area of the first triangle
  // Degenerate: the first three nodes are (near-)collinear / coincident, so the plane
  // normal vanishes and the element area is ~0. Building it would divide by zero and
  // poison K/M and the stress recovery with NaN → flag it so consumers skip it.
  const degenerate = !(nz > 1e-9 * (L1 * L2 || 1));
  const ez = z.map(v => v / (nz || 1));
  const ey = _cross(ez, ex);
  const local = coords3d.map(p => { const d = _sub(p, p0); return [_dot(d, ex), _dot(d, ey)]; });
  return { ex, ey, ez, local, degenerate };
}

// Builds {D, el(local Ke/fT), ex,ey,ez, gdof, nN} of an area (geometry + material).
function _areaSetup(area, model, nodeIndex, e0) {
  const coords3d = area.nodes.map(id => { const n = model.nodes.get(id); return n ? [n.x, n.y, n.z] : null; });
  const mat = model.materials.get(area.matId);
  if (coords3d.some(c => !c) || !mat) return null;
  const frame = areaLocalFrame(coords3d);
  if (frame.degenerate) return null;   // collinear / zero-area → skip (no NaN); flagged by _validateModel
  const { ex, ey, ez, local } = frame;
  const D = Dmatrix(mat.E, mat.nu, area.planeStrain);
  const nN = area.nodes.length;
  // Triangle with rotational DOFs (Allman) if the area requests it and has membrane.
  const useAllman = nN === 3 && area.drilling === true && (area.behavior ?? 'membrane') !== 'plate';
  const el = useAllman ? { ...allmanElement(local, D, area.thickness, e0), allman: true }
           : nN === 3 ? cstElement(local, D, area.thickness, e0)
                      : quadElement(local, D, area.thickness, e0);
  const gdof = area.nodes.map(id => 6 * nodeIndex.get(id));   // global base DOF (translations gdof+0..2)
  return { D, el, ex, ey, ez, gdof, nN, local, mat };
}

// Does the area include membrane / plate behavior according to its 'behavior'?
const hasMembrane = a => (a.behavior ?? 'membrane') !== 'plate';
const hasPlate = a => { const b = a.behavior ?? 'membrane'; return b === 'plate' || b === 'shell'; };

// Assembles the stiffness of ALL areas into the writer {add(i,j,v)} (dense or sparse).
//   · Membrane: transforms the 2 local in-plane DOFs (ex,ey) → 3 global
//     translational DOFs.
//   · Plate:    transforms the 3 local DOFs [w,θx,θy] → normal translation (w·ez) and
//     global rotations (θx·ex + θy·ey).
// Regularizes ONLY the DOF directions not covered (avoids singularity without
// stiffening the real response): normal translation if no plate; bending rotations
// if no plate; ALWAYS the "drilling" rotation (about ez).
export function assembleAreasInto(writer, model, nodeIndex, opts = {}) {
  const regN = opts.regN ?? 1e-4, regR = opts.regR ?? 1e-4;
  for (const area of model.areas.values()) {
    const S = _areaSetup(area, model, nodeIndex, [0, 0, 0]);
    if (!S) continue;
    const { el, ex, ey, ez, gdof, nN, local, mat } = S;
    const mem = hasMembrane(area), pla = hasPlate(area);
    let kref = 0;

    if (mem && el.allman) {          // ── Allman membrane (with drilling) ──────
      // Local DOF per node [u,v,ω] → global 6 DOF: u·ex, v·ey (translation), ω·ez
      // (rotation). Nodal transform 6×3 Ta (cols [u,v,ω] → [tx,ty,tz,rx,ry,rz]).
      const Ke = el.Ke, m = 9;
      const Ta = [[ex[0], ey[0], 0], [ex[1], ey[1], 0], [ex[2], ey[2], 0],
                  [0, 0, ez[0]], [0, 0, ez[1]], [0, 0, ez[2]]];
      for (let a = 0; a < nN; a++) for (let b = 0; b < nN; b++)
        for (let r = 0; r < 6; r++) for (let s = 0; s < 6; s++) {
          let v = 0;
          for (let p = 0; p < 3; p++) { const tap = Ta[r][p]; if (!tap) continue;
            for (let q = 0; q < 3; q++) v += tap * Ke[(3 * a + p) * m + (3 * b + q)] * Ta[s][q]; }
          if (v !== 0) writer.add(gdof[a] + r, gdof[b] + s, v);
        }
      for (let i = 0; i < m; i++) kref = Math.max(kref, Ke[i * m + i]);
    } else if (mem) {                // ── CST/QUAD membrane (in-plane) ─────────
      const Ke = el.Ke, m = 2 * nN, R = [ex, ey];
      for (let a = 0; a < nN; a++) for (let b = 0; b < nN; b++)
        for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) {
          let v = 0;
          for (let p = 0; p < 2; p++) for (let q = 0; q < 2; q++) v += R[p][r] * Ke[(2 * a + p) * m + (2 * b + q)] * R[q][s];
          if (v !== 0) writer.add(gdof[a] + r, gdof[b] + s, v);
        }
      for (let i = 0; i < m; i++) kref = Math.max(kref, Ke[i * m + i]);
    }

    if (pla) {                       // ── plate (bending) ─────────────────────
      const Kp = nN === 3 ? dktPlate(local, mat.E, mat.nu, area.thickness)
                          : mitc4Plate(local, mat.E, mat.nu, area.thickness);
      // Nodal transform 6×3: cols [w,θx,θy] → rows [tx,ty,tz,rx,ry,rz].
      const Tn = [[ez[0], 0, 0], [ez[1], 0, 0], [ez[2], 0, 0],
                  [0, ex[0], ey[0]], [0, ex[1], ey[1]], [0, ex[2], ey[2]]];
      const m = 3 * nN;
      for (let a = 0; a < nN; a++) for (let b = 0; b < nN; b++)
        for (let r = 0; r < 6; r++) for (let s = 0; s < 6; s++) {
          let v = 0;
          for (let p = 0; p < 3; p++) { const tap = Tn[r][p]; if (!tap) continue;
            for (let q = 0; q < 3; q++) v += tap * Kp[(3 * a + p) * m + (3 * b + q)] * Tn[s][q]; }
          if (v !== 0) writer.add(gdof[a] + r, gdof[b] + s, v);
        }
      for (let i = 0; i < m; i++) kref = Math.max(kref, Kp[i * m + i]);
    }

    // ── Regularization of uncovered DOFs ────────────────────────────────────
    const kn = regN * kref, kr = regR * kref;
    for (let a = 0; a < nN; a++) {
      if (!mem)                       // uncovered in-plane translations (ex,ey)
        for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) { const v = kn * (ex[r] * ex[s] + ey[r] * ey[s]); if (v !== 0) writer.add(gdof[a] + r, gdof[a] + s, v); }
      if (!pla)                       // uncovered normal translation (ez)
        for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) { const v = kn * ez[r] * ez[s]; if (v !== 0) writer.add(gdof[a] + r, gdof[a] + s, v); }
      if (pla) {                      // plate covers bending: regularize ONLY drilling (ez)
        for (let r = 3; r < 6; r++) for (let s = 3; s < 6; s++) { const v = kr * ez[r - 3] * ez[s - 3]; if (v !== 0) writer.add(gdof[a] + r, gdof[a] + s, v); }
      } else {                        // no plate: regularize the 3 rotations
        for (let r = 3; r < 6; r++) writer.add(gdof[a] + r, gdof[a] + r, kr);
      }
    }
  }
}

// ── GEOMETRIC stiffness of membrane/shell (shell buckling, 2-016/2-017) ──────────
// Under an in-plane stress state (σx, σy, τxy) the areas contribute a geometric
// stiffness to the TRANSVERSE translation (out-of-plane, the element's ez direction):
//   Kg_w[i][j] = ∫ (∂Ni·S·∂Nj) t dA,  S = [[σx,τxy],[τxy,σy]],  ∂N = [∂N/∂x, ∂N/∂y].
// In-plane tension stiffens (stabilizes), compression softens → buckling.
// The local transverse DOF w = u·ez is projected onto the global block (ez⊗ez) of the
// translations. CST: constant gradients (exact); QUAD: gradients at the center
// (1 Gauss point). `uGlobal` = displacement of the reference state.
export function assembleAreasKgInto(writer, model, nodeIndex, uGlobal) {
  for (const area of model.areas.values()) {
    if (!hasMembrane(area)) continue;             // a pure plate has no in-plane stress
    const coords3d = area.nodes.map(id => { const n = model.nodes.get(id); return n ? [n.x, n.y, n.z] : null; });
    const mat = model.materials.get(area.matId);
    if (coords3d.some(c => !c) || !mat) continue;
    const frame = areaLocalFrame(coords3d);
    if (frame.degenerate) continue;               // collinear / zero-area → skip (no NaN)
    const { ex, ey, ez, local } = frame;
    const D = Dmatrix(mat.E, mat.nu, area.planeStrain);
    const nN = area.nodes.length;
    const gdof = area.nodes.map(id => 6 * nodeIndex.get(id));
    // Local in-plane displacements per node: [u·ex, u·ey]
    const uloc = new Array(2 * nN);
    for (let a = 0; a < nN; a++) {
      const g = gdof[a]; const ux = uGlobal[g] || 0, uy = uGlobal[g + 1] || 0, uz = uGlobal[g + 2] || 0;
      uloc[2*a]   = ux*ex[0] + uy*ex[1] + uz*ex[2];
      uloc[2*a+1] = ux*ey[0] + uy*ey[1] + uz*ey[2];
    }
    // Membrane stress + shape gradients (∂N/∂x, ∂N/∂y) and area
    let sx, sy, txy, A; const gx = [], gy = [];
    if (nN === 3) {
      const cs = cstElement(local, D, area.thickness);
      [sx, sy, txy] = cstStress(cs.B, D, uloc); A = cs.area;
      for (let i = 0; i < 3; i++) { gx.push(cs.B[0][2*i]); gy.push(cs.B[1][2*i+1]); }
    } else {
      const { B } = bMatrixQ4(local, 0, 0);
      [sx, sy, txy] = quadStressCenter(local, D, uloc);
      // quadrilateral area (shoelace in local coords)
      A = 0; for (let i = 0; i < nN; i++) { const j = (i+1)%nN; A += local[i][0]*local[j][1] - local[j][0]*local[i][1]; }
      A = Math.abs(A) / 2;
      for (let i = 0; i < nN; i++) { gx.push(B[0][2*i]); gy.push(B[1][2*i+1]); }
    }
    const tA = (area.thickness || 0) * A;
    for (let a = 0; a < nN; a++) for (let b = 0; b < nN; b++) {
      const kw = tA * (gx[a]*sx*gx[b] + gy[a]*sy*gy[b] + txy*(gx[a]*gy[b] + gy[a]*gx[b]));
      if (!kw) continue;
      for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) { const v = kw * ez[r] * ez[s]; if (v) writer.add(gdof[a] + r, gdof[b] + s, v); }
    }
  }
}

// Area mass for the modal analysis: total mass m = ρ·t·A split equally among the
// nodes (lumped), applied to each node's 3 translational DOFs.
export function assembleAreasMassInto(writer, model, nodeIndex) {
  for (const area of model.areas.values()) {
    const S = _areaSetup(area, model, nodeIndex, [0, 0, 0]);
    if (!S) continue;
    const { el, gdof, nN, mat } = S;
    const m = (mat.rho || 0) * (area.thickness || 0) * (el.area || 0);
    if (!(m > 0)) continue;
    const mn = m / nN;
    for (let a = 0; a < nN; a++)
      for (let r = 0; r < 3; r++) writer.add(gdof[a] + r, gdof[a] + r, mn);
  }
}

// Thermal load contributions of an area to F (list of {dof, val}).
// dT = mean temperature (membrane). gradT = T_top − T_bot (gradient through the
// thickness → thermal bending moment in plate/shell, #57).
export function areaThermalContribs(area, model, nodeIndex, dT, gradT = 0) {
  const mat = model.materials.get(area.matId); if (!mat) return [];
  const e0 = thermalStrain(mat.alpha ?? 0, dT || 0, mat.nu, area.planeStrain);
  const S = _areaSetup(area, model, nodeIndex, e0); if (!S) return [];
  const { el, ex, ey, ez, gdof, nN, local, mat: m } = S;
  const out = [];
  // ── Membrane (in-plane): mean dilation ──────────────────────────────────────
  if (hasMembrane(area)) {
    if (el.allman) {   // fT per node [fu,fv,fω] → translations (ex,ey) + rotation (ez)
      for (let a = 0; a < nN; a++) {
        const fu = el.fT[3 * a], fv = el.fT[3 * a + 1], fw = el.fT[3 * a + 2];
        for (let r = 0; r < 3; r++) out.push({ dof: gdof[a] + r, val: ex[r] * fu + ey[r] * fv });
        for (let r = 0; r < 3; r++) if (fw) out.push({ dof: gdof[a] + 3 + r, val: ez[r] * fw });
      }
    } else {
      const fT = el.fT, R = [ex, ey];
      for (let a = 0; a < nN; a++)
        for (let r = 0; r < 3; r++) out.push({ dof: gdof[a] + r, val: R[0][r] * fT[2 * a] + R[1][r] * fT[2 * a + 1] });
    }
  }
  // ── Plate (bending): thermal moment from the gradient ──────────────────────
  if (gradT && hasPlate(area)) {
    const t = area.thickness || 1;
    const k0 = (m.alpha ?? 0) * gradT / t;            // thermal curvature
    const fL = plateThermalLoad(local, m.E, m.nu, t, [k0, k0, 0]);   // local DOFs [w,θx,θy]
    const Tn = [[ez[0], 0, 0], [ez[1], 0, 0], [ez[2], 0, 0],
                [0, ex[0], ey[0]], [0, ex[1], ey[1]], [0, ex[2], ey[2]]];
    for (let a = 0; a < nN; a++)
      for (let r = 0; r < 6; r++) {
        const v = Tn[r][0] * fL[3 * a] + Tn[r][1] * fL[3 * a + 1] + Tn[r][2] * fL[3 * a + 2];
        if (v) out.push({ dof: gdof[a] + r, val: v });
      }
  }
  return out;
}

// Area stress (at the center) from the global field u and ΔT.
export function areaStress(area, model, nodeIndex, u, dT = 0) {
  const mat = model.materials.get(area.matId); if (!mat) return null;
  const e0 = thermalStrain(mat.alpha ?? 0, dT || 0, mat.nu, area.planeStrain);
  const S = _areaSetup(area, model, nodeIndex, e0); if (!S) return null;
  const { D, el, ex, ey, ez, gdof, nN, local } = S;
  // Allman: includes the nodal rotation (ωz·ez) in the centroid stress.
  if (el.allman) {
    const d9 = [];
    for (let a = 0; a < nN; a++) {
      const U = [u[gdof[a]] || 0, u[gdof[a] + 1] || 0, u[gdof[a] + 2] || 0];
      const Rr = [u[gdof[a] + 3] || 0, u[gdof[a] + 4] || 0, u[gdof[a] + 5] || 0];
      d9.push(_dot(ex, U), _dot(ey, U), _dot(ez, Rr));
    }
    return allmanStress(el.T, el.Bc, D, d9, e0);
  }
  // local in-plane u per node: ul = R·U_global
  const ul = [];
  for (let a = 0; a < nN; a++) {
    const U = [u[gdof[a]] || 0, u[gdof[a] + 1] || 0, u[gdof[a] + 2] || 0];
    ul.push(_dot(ex, U), _dot(ey, U));
  }
  return nN === 3 ? cstStress(cstElement(local, D, area.thickness).B, D, ul, e0)
                  : quadStressCenter(local, D, ul, e0);
}

// MEMBRANE strain (at the center) from the global field u:
// ε = B·ul = [εx, εy, γxy] in the local frame. It is the total geometric strain
// (it does NOT subtract the thermal ε₀ → it is what the material actually strains).
export function areaStrain(area, model, nodeIndex, u) {
  if (!hasMembrane(area)) return null;
  const S = _areaSetup(area, model, nodeIndex, [0, 0, 0]); if (!S) return null;
  const { D, ex, ey, gdof, nN, local } = S;
  const ul = [];
  for (let a = 0; a < nN; a++) {
    const U = [u[gdof[a]] || 0, u[gdof[a] + 1] || 0, u[gdof[a] + 2] || 0];
    ul.push(_dot(ex, U), _dot(ey, U));
  }
  const eps = [0, 0, 0];
  if (nN === 3) {
    const B = cstElement(local, D, area.thickness).B;
    for (let r = 0; r < 3; r++) { let s = 0; for (let c = 0; c < 6; c++) s += B[r][c] * ul[c]; eps[r] = s; }
  } else {
    const B = bMatrixQ4(local, 0, 0).B;
    for (let r = 0; r < 3; r++) { let s = 0; for (let c = 0; c < 8; c++) s += B[r][c] * ul[c]; eps[r] = s; }
  }
  return eps;
}

// BENDING curvatures (plate/shell) at the center: [κx, κy, κxy] in the local
// frame. Returns null if the area has no bending (pure membrane).
export function areaCurvature(area, model, nodeIndex, u) {
  if (!hasPlate(area)) return null;
  const S = _areaSetup(area, model, nodeIndex, [0, 0, 0]); if (!S) return null;
  const { ex, ey, ez, gdof, nN, local } = S;
  const dLocal = [];
  for (let a = 0; a < nN; a++) {
    const Ut = [u[gdof[a]] || 0, u[gdof[a] + 1] || 0, u[gdof[a] + 2] || 0];
    const Ur = [u[gdof[a] + 3] || 0, u[gdof[a] + 4] || 0, u[gdof[a] + 5] || 0];
    dLocal.push(_dot(ez, Ut), _dot(ex, Ur), _dot(ey, Ur));   // [w, θx, θy]
  }
  return plateCurvatures(local, dLocal);
}

// BENDING stress at the surface fiber (plate/shell): σ = 6·M/t²
// [σx,σy,τxy] in the local frame, from the plate moments at the center.
// Returns null if the area has no bending (pure membrane).
export function areaBendingStress(area, model, nodeIndex, u, gradT = 0) {
  if (!hasPlate(area)) return null;
  const S = _areaSetup(area, model, nodeIndex, [0, 0, 0]); if (!S) return null;
  const { ex, ey, ez, gdof, nN, local, mat } = S;
  const dLocal = [];
  for (let a = 0; a < nN; a++) {
    const Ut = [u[gdof[a]] || 0, u[gdof[a] + 1] || 0, u[gdof[a] + 2] || 0];
    const Ur = [u[gdof[a] + 3] || 0, u[gdof[a] + 4] || 0, u[gdof[a] + 5] || 0];
    dLocal.push(_dot(ez, Ut), _dot(ex, Ur), _dot(ey, Ur));   // [w, θx, θy]
  }
  const t = area.thickness;
  const M = plateMoments(local, mat.E, mat.nu, t, dLocal);
  // #57: subtract the thermal moment M_T = Db·κ₀ (κ₀ = α·gradT/t) → mechanical moment.
  if (gradT) {
    const k0 = (mat.alpha ?? 0) * gradT / t;
    const { Db } = plateD(mat.E, mat.nu, t);
    M[0] -= Db[0][0] * k0 + Db[0][1] * k0;
    M[1] -= Db[1][0] * k0 + Db[1][1] * k0;
    M[2] -= Db[2][0] * k0 + Db[2][1] * k0;
  }
  const c = 6 / (t * t);
  return [c * M[0], c * M[1], c * M[2]];   // surface stress (bottom fiber)
}
