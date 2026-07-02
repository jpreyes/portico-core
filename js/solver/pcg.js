// ──────────────────────────────────────────────────────────────────────────────
// pcg.js — Preconditioned Conjugate Gradient (PCG) for K·x = b, SPD, in CSR.
//
// ITERATIVE alternative to the banded Cholesky of linsolve.js. For a large 2D mesh
// (Poisson-type operator) the banded Cholesky costs O(n·b²) time and O(n·b) memory
// with b≈√n → O(n²)/O(n^1.5): the wall of big meshes. PCG is matrix-free in memory
// (only the non-zeros of A + the incomplete factor) and, with a good preconditioner,
// converges in few iterations.
//
// Preconditioners:
//   · Jacobi   M = diag(A)                     — cheap, robust, ~O(√N) iterations.
//   · IC0      incomplete Cholesky (pattern of A) — the one that scales on 2D Poisson.
//
// This is the REFERENCE for the C++/WASM port (vector-cplus): same algorithm, same
// arithmetic. The matrix arrives as a symmetric FULL CSR (both triangles):
//   csr = { n, rowPtr:Int32Array(n+1), colIdx:Int32Array(nnz), val:Float64Array(nnz) }
// ──────────────────────────────────────────────────────────────────────────────

// Product y = A·x with A in CSR (O(nnz)).
export function csrMatvec(csr, x, out) {
  const { n, rowPtr, colIdx, val } = csr;
  const y = out || new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) s += val[p] * x[colIdx[p]];
    y[i] = s;
  }
  return y;
}

// ── Jacobi preconditioner ─────────────────────────────────────────────────────
// Returns apply(r,z): z = M⁻¹r with M = diag(A).
export function jacobi(csr) {
  const { n, rowPtr, colIdx, val } = csr;
  const inv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) if (colIdx[p] === i) { d = val[p]; break; }
    inv[i] = d !== 0 ? 1 / d : 0;
  }
  return {
    apply(r, z) { const o = z || new Float64Array(n); for (let i = 0; i < n; i++) o[i] = inv[i] * r[i]; return o; }
  };
}

// ── IC0 preconditioner (incomplete Cholesky, no fill-in) ──────────────────────
// Extracts the lower triangle (j≤i) of A in CSR and computes L (pattern of A) such
// that A ≈ L·Lᵀ. Applies M⁻¹r by solving L·y=r and then Lᵀ·z=y.
export function ic0(csr) {
  const { n, rowPtr, colIdx, val } = csr;
  // 1) lower triangle (diagonal included), by rows, columns ascending.
  const Lp = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) { let c = 0; for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) if (colIdx[p] <= i) c++; Lp[i + 1] = Lp[i] + c; }
  const nnzL = Lp[n];
  const Lj = new Int32Array(nnzL), Lx = new Float64Array(nnzL);
  const diagPtr = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    // collect columns ≤ i with their value, sorted
    const cols = [];
    for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) { const j = colIdx[p]; if (j <= i) cols.push([j, val[p]]); }
    cols.sort((a, b) => a[0] - b[0]);
    let q = Lp[i];
    for (const [j, v] of cols) { Lj[q] = j; Lx[q] = v; if (j === i) diagPtr[i] = q; q++; }
  }
  // value of L at (row r, col c) by binary search in the pattern, or -1.
  const findL = (r, c) => { let lo = Lp[r], hi = Lp[r + 1] - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (Lj[m] === c) return m; if (Lj[m] < c) lo = m + 1; else hi = m - 1; } return -1; };

  // 2) incomplete factorization (same pattern as L). Left-looking, row by row.
  for (let i = 0; i < n; i++) {
    for (let p = Lp[i]; p <= diagPtr[i]; p++) {
      const j = Lj[p];
      let sum = Lx[p];
      // sum -= Σ_{k<j, pattern} L[i][k]·L[j][k]
      for (let pk = Lp[i]; pk < p; pk++) {
        const k = Lj[pk];
        if (k >= j) break;
        const pjk = findL(j, k);
        if (pjk >= 0) sum -= Lx[pk] * Lx[pjk];
      }
      if (j === i) {
        Lx[p] = sum > 0 ? Math.sqrt(sum) : Math.sqrt(Math.abs(sum) || 1e-12); // SPD safeguard
      } else {
        Lx[p] = sum / Lx[diagPtr[j]];
      }
    }
  }

  const y = new Float64Array(n);
  return {
    apply(r, z) {
      const o = z || new Float64Array(n);
      // L·y = r  (forward substitution)
      for (let i = 0; i < n; i++) {
        let s = r[i];
        for (let p = Lp[i]; p < diagPtr[i]; p++) s -= Lx[p] * y[Lj[p]];
        y[i] = s / Lx[diagPtr[i]];
      }
      // Lᵀ·z = y  (back substitution)
      for (let i = 0; i < n; i++) o[i] = y[i];
      for (let i = n - 1; i >= 0; i--) {
        o[i] /= Lx[diagPtr[i]];
        for (let p = Lp[i]; p < diagPtr[i]; p++) o[Lj[p]] -= Lx[p] * o[i];
      }
      return o;
    },
    _L: { Lp, Lj, Lx, diagPtr }
  };
}

// ── PCG ──────────────────────────────────────────────────────────────────────
// Solves A·x = b (A SPD in CSR). opts:
//   pre: 'ic0' (def) | 'jacobi' | object {apply(r,z)} | null (plain CG)
//   tol: ||r||/||b|| relative (def 1e-8) · maxIter (def 4·√n+50) · x0 (seed)
// Returns { x, iters, res, ok }.
export function pcg(csr, b, opts = {}) {
  const n = csr.n;
  const tol = opts.tol != null ? opts.tol : 1e-8;
  const maxIter = opts.maxIter || Math.round(4 * Math.sqrt(n) + 50);
  let M = opts.pre;
  if (M === 'jacobi') M = jacobi(csr);
  else if (M === 'ic0' || M === undefined) M = ic0(csr);
  else if (M === null) M = { apply: (r, z) => { const o = z || new Float64Array(n); o.set(r); return o; } };

  const x = new Float64Array(n); if (opts.x0) x.set(opts.x0);
  const r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
  // r = b - A·x
  csrMatvec(csr, x, Ap);
  let bnorm = 0; for (let i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; bnorm += b[i] * b[i]; }
  bnorm = Math.sqrt(bnorm) || 1;
  M.apply(r, z);
  p.set(z);
  let rz = 0; for (let i = 0; i < n; i++) rz += r[i] * z[i];
  // Stopping test: PRECONDITIONED residual rᵀz relative to the initial one. With
  // Dirichlet-by-penalty (diagonal ~1e12) the raw ‖r‖ is dominated by those rows and
  // the interior does not converge; M⁻¹ de-weights the stiff rows and measures the
  // interior.
  const rz0 = rz || 1;
  const stop = tol * tol * rz0;

  let iter = 0, res = 0;
  for (iter = 0; iter < maxIter; iter++) {
    csrMatvec(csr, p, Ap);
    let pAp = 0; for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (!(Math.abs(pAp) > 0)) break;
    const alpha = rz / pAp;
    let rnorm = 0;
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; rnorm += r[i] * r[i]; }
    res = Math.sqrt(rnorm) / bnorm;
    M.apply(r, z);
    let rzNew = 0; for (let i = 0; i < n; i++) rzNew += r[i] * z[i];
    if (rzNew < stop) { iter++; rz = rzNew; break; }
    const beta = rzNew / rz; rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return { x, iters: iter, res, ok: rz < stop };
}

// makeFactorCSR-style wrapper (linsolve.js) so PCG is swappable in the sparse worker.
// makeSolverPCG(csr).solve(b) → Float64Array (with _iters/_ok/_res attached, so the
// caller can fall back to a direct factor when PCG does not converge). The
// preconditioner is built once and reused across solves.
export function makeSolverPCG(csr, opts = {}) {
  return {
    ok: true, kind: 'pcg-' + (opts.pre || 'ic0'),
    solve(b, out) {
      const r = pcg(csr, b, opts);
      const o = out || new Float64Array(csr.n);
      o.set(r.x); o._iters = r.iters; o._ok = r.ok; o._res = r.res;
      return o;
    }
  };
}
