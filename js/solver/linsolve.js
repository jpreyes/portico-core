// ──────────────────────────────────────────────────────────────────────────────
// linsolve.js — linear solver for K·u = F, symmetric positive-definite (SPD).
//
//   · Reverse Cuthill–McKee (RCM) reordering → minimizes the bandwidth.
//   · BANDED Cholesky factorization (profile storage) → O(n·b²) in time and
//     O(n·b) in memory, instead of the dense solver's O(n³)/O(n²).
//   · Factor ONCE and solve MANY right-hand sides (several load cases).
//
// Meant to run inside a Web Worker (does not block the UI). If the matrix is NOT
// SPD (mechanism/instability → pivot ≤ 0), it returns { ok:false } so the caller
// can use a fallback path (dense solver) and/or warn about instability.
// ──────────────────────────────────────────────────────────────────────────────

// Reverse Cuthill–McKee. adj: adjacency list (neighbors per node).
// Returns perm: perm[newIndex] = originalIndex.
export function rcm(n, adj) {
  const visited = new Uint8Array(n);
  const deg = new Int32Array(n);
  for (let i = 0; i < n; i++) deg[i] = adj[i].length;
  const order = new Int32Array(n);
  let oc = 0;
  while (oc < n) {
    // start: unvisited node of lowest degree (simple, robust heuristic)
    let start = -1, md = Infinity;
    for (let i = 0; i < n; i++) if (!visited[i] && deg[i] < md) { md = deg[i]; start = i; }
    if (start < 0) break;
    // BFS, ordering neighbors by ascending degree
    const queue = [start]; visited[start] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi];
      order[oc++] = v;
      const nb = [];
      for (const u of adj[v]) if (!visited[u]) nb.push(u);
      nb.sort((a, b) => deg[a] - deg[b]);
      for (const u of nb) { visited[u] = 1; queue.push(u); }
    }
  }
  // in case isolated nodes were left unreached
  for (let i = 0; i < n && oc < n; i++) if (!visited[i]) { visited[i] = 1; order[oc++] = i; }
  // reverse
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = order[n - 1 - i];
  return perm;
}

// Builds adjacency from the dense matrix (Float64Array n×n, row-major).
function adjacencyFromDense(K, n) {
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const off = i * n;
    for (let j = 0; j < n; j++) if (i !== j && K[off + j] !== 0) adj[i].push(j);
  }
  return adj;
}

// RCM permutation from the dense matrix (to reorder K and M into banded form).
export function permRCM(Kff, n) { return rcm(n, adjacencyFromDense(Kff, n)); }

// Factors Kff (dense, SPD) with RCM + banded Cholesky. Returns a reusable factor
// object for many right-hand sides (bandSolve). { ok, L, w, m, perm }.
//   permIn: permutation to use (if null, RCM is computed; if the identity is
//   passed, Kff is factored as-is — useful when it already comes reordered).
export function bandFactor(Kff, n, permIn = null) {
  if (n === 0) return { ok: true, L: new Float64Array(0), w: 1, m: 0, perm: new Int32Array(0) };

  const perm = permIn || rcm(n, adjacencyFromDense(Kff, n));
  const pos = new Int32Array(n);
  for (let i = 0; i < n; i++) pos[perm[i]] = i;

  // semibandwidth after the reordering
  let m = 0;
  for (let i = 0; i < n; i++) {
    const off = i * n, pi = pos[i];
    for (let j = 0; j < n; j++) if (Kff[off + j] !== 0) { const d = Math.abs(pi - pos[j]); if (d > m) m = d; }
  }

  const w = m + 1;
  const L = new Float64Array(n * w);
  for (let i = 0; i < n; i++) {
    const pi = perm[i];
    const j0 = i - m < 0 ? 0 : i - m;
    for (let j = j0; j <= i; j++) L[i * w + (j - i + m)] = Kff[pi * n + perm[j]];
  }
  if (!_choleskyBand(L, n, w, m)) return { ok: false, m };   // not SPD
  return { ok: true, L, w, m, perm, n };
}

// In-place banded Cholesky over the profile storage L[i*w + (j-i+m)] (semibandwidth
// m, width w=m+1). Returns true if SPD, false if a pivot ≤ 0.
// Shared by the dense→band and the CSR→band factorizations.
function _choleskyBand(L, n, w, m) {
  for (let i = 0; i < n; i++) {
    const j0 = i - m < 0 ? 0 : i - m;
    for (let j = j0; j <= i; j++) {
      let s = L[i * w + (j - i + m)];
      const k0 = Math.max(j0, j - m);
      for (let k = k0; k < j; k++) s -= L[i * w + (k - i + m)] * L[j * w + (k - j + m)];
      if (i === j) {
        if (s <= 0 || !isFinite(s)) return false;   // not SPD
        L[i * w + m] = Math.sqrt(s);
      } else {
        L[i * w + (j - i + m)] = s / L[j * w + m];
      }
    }
  }
  return true;
}

// Solves K·x = b using a bandFactor factor. Returns Float64Array(n).
export function bandSolve(F, b, out) {
  const { L, w, m, perm, n } = F;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[perm[i]];
    const j0 = i - m < 0 ? 0 : i - m;
    for (let j = j0; j < i; j++) s -= L[i * w + (j - i + m)] * y[j];
    y[i] = s / L[i * w + m];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    const jmax = i + m > n - 1 ? n - 1 : i + m;
    for (let j = i + 1; j <= jmax; j++) s -= L[j * w + (i - j + m)] * x[j];
    x[i] = s / L[i * w + m];
  }
  const u = out || new Float64Array(n);
  for (let i = 0; i < n; i++) u[perm[i]] = x[i];
  return u;
}

// ── DENSE Cholesky (academic exploration) ───────────────────────────────────
// Full O(n³) factorization over the dense matrix, without reordering or
// compressing: slower, but transparent (the stiffness matrix is used as-is). { ok, L, n }.
export function denseFactor(Kff, n) {
  const L = new Float64Array(n * n);   // lower triangular
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = Kff[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (s <= 0 || !isFinite(s)) return { ok: false };
        L[i * n + i] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }
  return { ok: true, L, n };
}
export function denseSolve(F, b, out) {
  const { L, n } = F;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; const off = i * n; for (let j = 0; j < i; j++) s -= L[off + j] * y[j]; y[i] = s / L[off + i]; }
  const x = out || new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let j = i + 1; j < n; j++) s -= L[j * n + i] * x[j]; x[i] = s / L[i * n + i]; }
  return x;
}
// Forward substitution: solves L·y = b (L lower triangular from denseFactor).
export function triForward(F, b) {
  const { L, n } = F; const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; const off = i * n; for (let j = 0; j < i; j++) s -= L[off + j] * y[j]; y[i] = s / L[off + i]; }
  return y;
}
// Backward substitution: solves Lᵀ·x = b.
export function triBackward(F, b) {
  const { L, n } = F; const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= L[j * n + i] * x[j]; x[i] = s / L[i * n + i]; }
  return x;
}

// Selector: factors Kff with the chosen method and returns { ok, solve(b,out), kind, m }.
//   dense=false (default) → banded Cholesky (fast). dense=true → dense.
export function makeFactor(Kff, n, dense = false, perm = null) {
  if (dense) {
    const f = denseFactor(Kff, n);
    if (!f.ok) return { ok: false, kind: 'densa' };
    return { ok: true, kind: 'densa', m: n, solve: (b, out) => denseSolve(f, b, out) };
  }
  const f = bandFactor(Kff, n, perm);
  if (!f.ok) return { ok: false, kind: 'banda' };
  return { ok: true, kind: 'banda', m: f.m, solve: (b, out) => bandSolve(f, b, out) };
}

// ── SPARSE path (CSR) ───────────────────────────────────────────────────────
// The symmetric matrix arrives in full CSR format (both triangles):
//   csr = { n, rowPtr:Int32Array(n+1), colIdx:Int32Array(nnz), val:Float64Array(nnz) }
// This avoids materializing the dense n×n matrix: assembly, RCM reordering, banded
// factorization and matrix·vector products work only over the non-zeros (O(nnz)).

// Adjacency (neighbors per row, without the diagonal) from CSR — for RCM.
export function adjacencyFromCSR(csr) {
  const { n, rowPtr, colIdx } = csr;
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) {
      const j = colIdx[p];
      if (j !== i) adj[i].push(j);
    }
  }
  return adj;
}

// RCM permutation directly from CSR.
export function permRCMcsr(csr) { return rcm(csr.n, adjacencyFromCSR(csr)); }

// Factors an SPD matrix in CSR with RCM + banded Cholesky, WITHOUT densifying it.
// permIn: permutation to use (if null, RCM). Returns { ok, L, w, m, perm, n }
// compatible with bandSolve.
export function bandFactorCSR(csr, permIn = null) {
  const { n, rowPtr, colIdx, val } = csr;
  if (n === 0) return { ok: true, L: new Float64Array(0), w: 1, m: 0, perm: new Int32Array(0), n: 0 };

  const perm = permIn || rcm(n, adjacencyFromCSR(csr));
  const pos = new Int32Array(n);
  for (let i = 0; i < n; i++) pos[perm[i]] = i;

  // semibandwidth after the reordering (over the non-zeros)
  let m = 0;
  for (let i = 0; i < n; i++) {
    const pi = pos[i];
    for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) {
      const d = Math.abs(pi - pos[colIdx[p]]);
      if (d > m) m = d;
    }
  }

  const w = m + 1;
  const L = new Float64Array(n * w);
  // Fill the lower triangle in the permuted space from the non-zeros.
  for (let origI = 0; origI < n; origI++) {
    const ni = pos[origI];
    for (let p = rowPtr[origI]; p < rowPtr[origI + 1]; p++) {
      const nj = pos[colIdx[p]];
      if (nj <= ni) L[ni * w + (nj - ni + m)] = val[p];
    }
  }
  if (!_choleskyBand(L, n, w, m)) return { ok: false, m };
  return { ok: true, L, w, m, perm, n };
}

// CSR selector: factors and returns { ok, solve(b,out), kind, m }.
export function makeFactorCSR(csr, perm = null) {
  const f = bandFactorCSR(csr, perm);
  if (!f.ok) return { ok: false, kind: 'banda' };
  return { ok: true, kind: 'banda', m: f.m, solve: (b, out) => bandSolve(f, b, out) };
}

// Product y = A·x with A in CSR (O(nnz)). Used by the sparse modal solver.
export function csrMv(csr, x, out) {
  const { n, rowPtr, colIdx, val } = csr;
  const y = out || new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) s += val[p] * x[colIdx[p]];
    y[i] = s;
  }
  return y;
}

// Linear combination α·A + β·B of two CSR matrices (union of sparsity patterns).
// Each row's columns must be ascending (as extractFreeCSR produces). Used to form
// tangent/effective matrices like K + Kg or K + a1·M + b1·C without densifying.
export function csrLinComb(A, alpha, B, beta) {
  const n = A.n;
  if (B.n !== n) throw new Error('csrLinComb: size mismatch');
  const rowPtr = new Int32Array(n + 1);
  const colTmp = [], valTmp = [];
  for (let i = 0; i < n; i++) {
    let pa = A.rowPtr[i], pb = B.rowPtr[i];
    const ea = A.rowPtr[i + 1], eb = B.rowPtr[i + 1];
    while (pa < ea || pb < eb) {
      const ca = pa < ea ? A.colIdx[pa] : Infinity;
      const cb = pb < eb ? B.colIdx[pb] : Infinity;
      if (ca === cb) { colTmp.push(ca); valTmp.push(alpha * A.val[pa] + beta * B.val[pb]); pa++; pb++; }
      else if (ca < cb) { colTmp.push(ca); valTmp.push(alpha * A.val[pa]); pa++; }
      else { colTmp.push(cb); valTmp.push(beta * B.val[pb]); pb++; }
    }
    rowPtr[i + 1] = colTmp.length;
  }
  return { n, rowPtr, colIdx: Int32Array.from(colTmp), val: Float64Array.from(valTmp) };
}

// Per-row sparsity extent (variable band): lo[i]/hi[i] = first and last non-zero
// column of row i. Enables matrix·vector products in O(n·b).
export function rowBands(K, n) {
  const lo = new Int32Array(n), hi = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const off = i * n; let a = i, b = i;
    for (let j = 0; j < n; j++) if (K[off + j] !== 0) { if (j < a) a = j; if (j > b) b = j; }
    lo[i] = a; hi[i] = b;
  }
  return { lo, hi };
}

// Factors Kff (dense, SPD) with RCM + banded Cholesky and solves each RHS in
// rhsList. Returns { ok, uList:[Float64Array], bandwidth }.
export function factorSolveMany(Kff, n, rhsList) {
  if (n === 0) return { ok: true, uList: rhsList.map(() => new Float64Array(0)), bandwidth: 0 };
  const F = bandFactor(Kff, n);
  if (!F.ok) return { ok: false, bandwidth: F.m };
  const uList = rhsList.map(b => bandSolve(F, b));
  return { ok: true, uList, bandwidth: F.m };
}
