// ──────────────────────────────────────────────────────────────────────────────
// geometric.js — GEOMETRIC stiffness of frames (NL-lite Phase 2).
//
// The geometric stiffness matrix Kg(N) captures the effect of the axial force N on
// the transverse stiffness (P-Δ effect and buckling). Added to the elastic one:
//   · P-Delta:   (K + Kg)·u = F   → amplified displacements.
//   · Buckling:  (K + λ·Kg)·φ = 0 → critical factor λcr and buckling mode φ.
//
// Sign convention IDENTICAL to timoshenko.js (local DOF
// [u1,v1,w1,rx1,ry1,rz1, u2,v2,w2,rx2,ry2,rz2], XZ plane with dw/dx = −θy).
// N positive in TENSION (compression N<0 → reduces stiffness → buckling).
// ──────────────────────────────────────────────────────────────────────────────
import { localAxes, transformMatrix, globalStiffness } from './timoshenko.js?v=3';
import { assembleAreasKgInto } from './membrane.js?v=3';

// Local 12×12 geometric matrix from the axial N (tension +) and the length L.
// Consistent form (Przemieniecti) for bending in both planes; the geometric axial
// and torsional terms are neglected (standard for flexural buckling).
export function geometricMatrixLocal(N, L) {
  const Kg = Array.from({ length: 12 }, () => Array(12).fill(0));
  const c = N / L;
  const a = 6 / 5, b = L / 10, d = 2 * L * L / 15, e = -L * L / 30;

  // XY plane (bending about z): DOF [v1=1, θz1=5, v2=7, θz2=11]
  const xy = [1, 5, 7, 11];
  const Gxy = [
    [ a,  b, -a,  b],
    [ b,  d, -b,  e],
    [-a, -b,  a, -b],
    [ b,  e, -b,  d],
  ];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) Kg[xy[i]][xy[j]] = c * Gxy[i][j];

  // XZ plane (bending about y): DOF [w1=2, θy1=4, w2=8, θy2=10]
  // dw/dx = −θy ⇒ the translation–rotation couplings are flipped (as in KXZ).
  const xz = [2, 4, 8, 10];
  const Gxz = [
    [ a, -b, -a, -b],
    [-b,  d,  b,  e],
    [-a,  b,  a,  b],
    [-b,  e,  b,  d],
  ];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) Kg[xz[i]][xz[j]] = c * Gxz[i][j];

  return Kg;
}

// Global DOFs (0-based) of a node
function dofs(nodeIndex, id) {
  const b = 6 * nodeIndex.get(id);
  return [b, b + 1, b + 2, b + 3, b + 4, b + 5];
}

// Assembles the global geometric stiffness (dense, nDOF×nDOF) from the displacement
// field uGlobal: for each element it computes its axial N from the local elongation
// (N = EA·Δ/L, tension +) and builds Kg = Tᵀ·Kg_local·T.
// Returns { Kg, Nmax, Nby } (Nmax = max |N|, for diagnostics; Nby = Map
// elemId → axial N under uGlobal, tension +, used e.g. for the per-element buckling
// load = λcr·N).
export function assembleKg(model, nodeIndex, uGlobal) {
  const nDOF = nodeIndex.size * 6;
  const Kg = new Float64Array(nDOF * nDOF);
  const Nby = new Map();
  let Nmax = 0;

  for (const elem of model.elements.values()) {
    const n1 = model.nodes.get(elem.n1), n2 = model.nodes.get(elem.n2);
    const mat = model.materials.get(elem.matId), sec = model.sections.get(elem.secId);
    if (!n1 || !n2 || !mat || !sec) continue;

    const { ex, ey, ez, L } = localAxes(n1, n2);
    const T  = transformMatrix(ex, ey, ez);
    const ed = [...dofs(nodeIndex, elem.n1), ...dofs(nodeIndex, elem.n2)];

    // Axial N from the local elongation: u_local = T·u_global; Δ = u_local[6]−u_local[0]
    const ug = ed.map(g => uGlobal[g] || 0);
    let ul0 = 0, ul6 = 0;
    for (let j = 0; j < 12; j++) { ul0 += T[0][j] * ug[j]; ul6 += T[6][j] * ug[j]; }
    const mA = sec.mod?.A ?? 1;
    const EA = mat.E * sec.A * mA;
    const N = EA * (ul6 - ul0) / L;       // tension positive
    Nby.set(elem.id, N);
    if (Math.abs(N) > Nmax) Nmax = Math.abs(N);

    const KgG = globalStiffness(geometricMatrixLocal(N, L), T);
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++)
        Kg[ed[i] * nDOF + ed[j]] += KgG[i][j];
  }
  // Membrane/shell geometric stiffness (shell buckling, 2-016/2-017): the in-plane
  // stress state of the areas stiffens/softens the transverse bending.
  if (model.areas?.size) assembleAreasKgInto({ add: (i, j, v) => { Kg[i * nDOF + j] += v; } }, model, nodeIndex, uGlobal);
  return { Kg, Nmax, Nby };
}
