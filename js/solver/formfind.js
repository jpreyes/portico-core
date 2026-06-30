// ──────────────────────────────────────────────────────────────────────────────
// formfind.js — Form-finding via the FORCE DENSITY METHOD (FDM, Schek 1974).
//
// Given a network of bars/cables with a FORCE DENSITY q = N/L per branch
// (N = axial force, L = length), fixed ANCHOR nodes and FREE nodes, the equilibrium
// shape is obtained by solving a LINEAR system (three times, one per coordinate) —
// without iterating:
//
//   Equilibrium at each free node i:  Σ_(branch i-j) q·(x_j − x_i) + p_i = 0
//   ⇒  D·x_free = p + (anchor contributions)
//   with D = a Laplacian-type matrix weighted by q (SPD if q>0 and the network
//   reaches the anchors). Same D for x, y, z.
//
// It is the basis for designing tensile roofs, cable nets and funicular shapes
// (with external loads → funicular shape of the load; no loads and uniform q →
// minimal-length network, soap-film-like).
//
// SELF-CONTAINED (its own dense SPD solver) so it can be verified in Node.
// ──────────────────────────────────────────────────────────────────────────────

// Dense Cholesky for D (SPD). Solves D·x = b. Returns null if not SPD.
function solveSPD(D, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = D[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) { if (s <= 0 || !isFinite(s)) return null; L[i * n + i] = Math.sqrt(s); }
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let j = 0; j < i; j++) s -= L[i * n + j] * y[j]; y[i] = s / L[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let j = i + 1; j < n; j++) s -= L[j * n + i] * x[j]; x[i] = s / L[i * n + i]; }
  return x;
}

/**
 * @param {object} o
 *   coords    Float64Array(3·nNode)  current coordinates (seed)
 *   fixed     boolean[nNode]          true = anchor node (does not move)
 *   branches  [[i,j], ...]            branches (node indices) — cables/bars
 *   q         number[]                force density per branch (>0 = tension)
 *   loads     [[px,py,pz], ...]|null  external load per node (optional)
 *   axes      number[]|null           coordinates to SOLVE for (0=x,1=y,2=z).
 *                                     Default [0,1,2] (3D). Those not listed keep
 *                                     their seed value → this lets you constrain the
 *                                     form-finding to the vertical (axes=[2]) without
 *                                     redistributing the spans in plan.
 * @returns { ok, coords, freeIdx, note }
 *   coords = new equilibrium coordinates (anchors stay the same).
 */
export function formFind(o) {
  const { coords, fixed, branches, q, loads, axes } = o;
  const solveAxes = Array.isArray(axes) && axes.length ? axes : [0, 1, 2];
  const n = fixed.length;
  const map = new Int32Array(n).fill(-1);
  const freeIdx = [];
  for (let i = 0; i < n; i++) if (!fixed[i]) { map[i] = freeIdx.length; freeIdx.push(i); }
  const nf = freeIdx.length;
  if (nf === 0) return { ok: false, coords: Float64Array.from(coords), freeIdx, note: 'No hay nodos libres (todos son anclas).' };

  const D = new Float64Array(nf * nf);
  const rhs = [new Float64Array(nf), new Float64Array(nf), new Float64Array(nf)];

  for (let b = 0; b < branches.length; b++) {
    const i = branches[b][0], j = branches[b][1];
    const qb = q[b];
    if (!(qb > 0) && !(qb < 0)) continue;   // q=0 → inactive branch
    const fi = map[i], fj = map[j];
    if (fi >= 0) D[fi * nf + fi] += qb;
    if (fj >= 0) D[fj * nf + fj] += qb;
    if (fi >= 0 && fj >= 0) { D[fi * nf + fj] -= qb; D[fj * nf + fi] -= qb; }
    // anchor contributions → right-hand side
    if (fi >= 0 && fj < 0) for (let c = 0; c < 3; c++) rhs[c][fi] += qb * coords[3 * j + c];
    if (fj >= 0 && fi < 0) for (let c = 0; c < 3; c++) rhs[c][fj] += qb * coords[3 * i + c];
  }
  // external loads at free nodes
  if (loads) for (let i = 0; i < n; i++) {
    const fi = map[i]; if (fi < 0 || !loads[i]) continue;
    for (let c = 0; c < 3; c++) rhs[c][fi] += loads[i][c] || 0;
  }

  const out = Float64Array.from(coords);
  for (const c of solveAxes) {
    const x = solveSPD(D, rhs[c], nf);
    if (!x) return { ok: false, coords: out, freeIdx, note: 'La red no es estable con estas densidades (¿nodos libres sin conexión a anclas, o q ≤ 0?).' };
    for (let k = 0; k < nf; k++) out[3 * freeIdx[k] + c] = x[k];
  }
  return { ok: true, coords: out, freeIdx, note: '' };
}
