// ──────────────────────────────────────────────────────────────────────────────
// modal_worker.js — Stodola inverse iteration for the modal analysis, off the main
// thread. MODULE worker: uses the in-house solver (banded Cholesky with a single
// factorization) instead of numeric.js, and matrix·vector products ONLY within the
// band (O(n·b) instead of O(n²)). Much faster on large models.
//
// Protocol:
//   Main → Worker: { Kff_flat, Mff_flat, nF, nModes, dense }
//   Worker → Main: { modes: [{omega2, vec}] }  |  { error }
// ──────────────────────────────────────────────────────────────────────────────
import { makeFactor, rowBands, permRCM } from './linsolve.js?v=4';

// Product A·x using the per-row extent (variable band) → O(n·b)
function _mvBand(A, x, n, lo, hi) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0; const off = i * n, a = lo[i], b = hi[i];
    for (let j = a; j <= b; j++) s += A[off + j] * x[j];
    y[i] = s;
  }
  return y;
}
function _dot(a, b, n) { let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }
function _mNorm(x, mvM, n) {
  const Mx = mvM(x);
  const norm = Math.sqrt(Math.max(_dot(x, Mx, n), 0));
  if (norm < 1e-30) return x;
  for (let i = 0; i < n; i++) x[i] /= norm;
  return x;
}
function _mOrtho(x, found, mvM, n) {
  for (const { vec: phi } of found) {
    const Mphi = mvM(phi);
    const c = _dot(x, Mphi, n);
    for (let i = 0; i < n; i++) x[i] -= c * phi[i];
  }
}

// Stodola with M-orthogonal deflation. solveK(b) solves K·y = b.
function _stodola(mvK, mvM, solveK, nF, nModes) {
  const found = [];
  for (let modeNum = 0; modeNum < nModes; modeNum++) {
    let bestOmega2 = Infinity, bestVec = null, lastConv = null, agree = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const phase = (modeNum + 1 + attempt * 7) * 0.7 + attempt * 0.41;
      let x = new Float64Array(nF);
      for (let i = 0; i < nF; i++) x[i] = Math.sin(phase * (i + 1)) + Math.cos((attempt + 1) * (i + 0.5) * 1.1) * 0.5 + 0.1;
      _mOrtho(x, found, mvM, nF);
      const n0 = Math.sqrt(Math.max(_dot(x, mvM(x), nF), 0));
      if (n0 < 1e-10) continue;
      _mNorm(x, mvM, nF);

      let omega2 = 0, converged = false;
      for (let iter = 0; iter < 150; iter++) {
        const Mx = mvM(x);
        const y = solveK(Mx);            // K y = M x
        _mOrtho(y, found, mvM, nF);
        const My = mvM(y);
        const yn = Math.sqrt(Math.max(_dot(y, My, nF), 0));
        if (yn < 1e-30) break;
        const xNew = y.slice();
        _mNorm(xNew, mvM, nF);
        const Kx = mvK(xNew);
        const w2 = _dot(xNew, Kx, nF);
        if (!isFinite(w2) || w2 < 0) break;
        const relChange = Math.abs(w2 - omega2) / Math.max(w2, 1e-10);
        omega2 = w2; x = xNew;
        if (relChange < 1e-7 && iter >= 4) { converged = true; break; }
        if (relChange < 1e-4 && iter >= 20) { converged = true; break; }
      }
      if (converged && isFinite(omega2) && omega2 >= 0 && omega2 < 1e12) {
        if (omega2 < bestOmega2) { bestOmega2 = omega2; bestVec = Array.from(x); }
        // early exit: two attempts converging to the SAME ω² → enough
        if (lastConv !== null && Math.abs(omega2 - lastConv) / Math.max(omega2, 1e-12) < 1e-3) { agree++; }
        lastConv = omega2;
        if (agree >= 1) break;
      }
    }
    if (!bestVec) break;
    found.push({ omega2: bestOmega2, vec: new Float64Array(bestVec) });
  }
  return found.map(m => ({ omega2: m.omega2, vec: Array.from(m.vec) }));
}

// ── Small generalized eigenproblem (q×q):  K·v = λ·M·v ────────────────────────
// Cholesky reduction M=L·Lᵀ → standard problem A·y=λ·y with A=L⁻¹K L⁻ᵀ, then
// classical Jacobi. Returns { vals (ascending), vecs (columns, M-orthonormal) }.
function _smallGenEig(K, M, n) {
  // Cholesky of M (SPD after regularization)
  const L = []; for (let i = 0; i < n; i++) L.push(new Float64Array(n));
  for (let j = 0; j < n; j++) {
    let s = M[j][j]; for (let k = 0; k < j; k++) s -= L[j][k] * L[j][k];
    L[j][j] = Math.sqrt(Math.max(s, 1e-300));
    for (let i = j + 1; i < n; i++) {
      let t = M[i][j]; for (let k = 0; k < j; k++) t -= L[i][k] * L[j][k];
      L[i][j] = t / L[j][j];
    }
  }
  const fwd = b => { const y = new Float64Array(n); for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; } return y; };
  const bwd = b => { const y = new Float64Array(n); for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * y[k]; y[i] = s / L[i][i]; } return y; };
  // A = L⁻¹ K L⁻ᵀ : column by column, A = fwd(K·(L⁻ᵀ e_j)) — symmetrized at the end
  const A = []; for (let i = 0; i < n; i++) A.push(new Float64Array(n));
  for (let j = 0; j < n; j++) {
    const ej = new Float64Array(n); ej[j] = 1;
    const w = bwd(ej);                                  // w = L⁻ᵀ e_j
    const Kw = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < n; k++) s += K[i][k] * w[k]; Kw[i] = s; }
    const col = fwd(Kw);                                // A[:,j]
    for (let i = 0; i < n; i++) A[i][j] = col[i];
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const m = 0.5 * (A[i][j] + A[j][i]); A[i][j] = A[j][i] = m; }
  // Standard symmetric Jacobi → eigenvalues in diag(A), eigenvectors in V
  const V = []; for (let i = 0; i < n; i++) { V.push(new Float64Array(n)); V[i][i] = 1; }
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0; for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-18) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const tt = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(tt * tt + 1), s = tt * c;
      for (let i = 0; i < n; i++) { const aip = A[i][p], aiq = A[i][q]; A[i][p] = c * aip - s * aiq; A[i][q] = s * aip + c * aiq; }
      for (let i = 0; i < n; i++) { const api = A[p][i], aqi = A[q][i]; A[p][i] = c * api - s * aqi; A[q][i] = s * api + c * aqi; }
      for (let i = 0; i < n; i++) { const vip = V[i][p], viq = V[i][q]; V[i][p] = c * vip - s * viq; V[i][q] = s * vip + c * viq; }
    }
  }
  // eigenvectors of the generalized problem: v = L⁻ᵀ y  (y = columns of V)
  const pairs = [];
  for (let j = 0; j < n; j++) {
    const y = new Float64Array(n); for (let i = 0; i < n; i++) y[i] = V[i][j];
    pairs.push({ lam: A[j][j], v: bwd(y) });
  }
  pairs.sort((a, b) => a.lam - b.lam);
  return { vals: pairs.map(p => p.lam), vecs: pairs.map(p => p.v) };
}

// ── Subspace iteration (Bathe) — extracts the p lowest modes in a block ───────
function _subspace(mvK, mvM, solveK, nF, nModes) {
  const p = nModes;
  const q = Math.min(nF, Math.max(p + 8, 2 * p));   // subspace size
  let X = [];
  for (let c = 0; c < q; c++) {
    const v = new Float64Array(nF);
    for (let i = 0; i < nF; i++) v[i] = Math.sin((c + 1) * 0.7 * (i + 1)) + 0.3 * Math.cos((c + 1) * (i + 0.5)) + (c === 0 ? 1 : 0);
    X.push(v);
  }
  let prev = null, lastVals = null;
  for (let iter = 0; iter < 40; iter++) {
    const Xb = X.map(col => solveK(mvM(col)));         // K⁻¹ M X (block)
    const KXb = Xb.map(col => mvK(col)), MXb = Xb.map(col => mvM(col));
    const Kr = [], Mr = [];
    for (let a = 0; a < q; a++) { Kr.push(new Float64Array(q)); Mr.push(new Float64Array(q));
      for (let b = 0; b < q; b++) { Kr[a][b] = _dot(Xb[a], KXb[b], nF); Mr[a][b] = _dot(Xb[a], MXb[b], nF); } }
    const { vals, vecs } = _smallGenEig(Kr, Mr, q);
    const Xnew = [];
    for (let c = 0; c < q; c++) {
      const v = new Float64Array(nF);
      for (let k = 0; k < q; k++) { const qc = vecs[c][k], xk = Xb[k]; if (qc) for (let i = 0; i < nF; i++) v[i] += qc * xk[i]; }
      Xnew.push(v);
    }
    X = Xnew; lastVals = vals;
    if (prev) { let ok = true; for (let i = 0; i < p; i++) if (Math.abs(vals[i] - prev[i]) / Math.max(Math.abs(vals[i]), 1e-12) > 1e-6) { ok = false; break; } if (ok && iter >= 2) break; }
    prev = vals.slice(0, p);
  }
  const out = [];
  for (let i = 0; i < p && i < q; i++) if (isFinite(lastVals[i]) && lastVals[i] >= 0) out.push({ omega2: lastVals[i], vec: Array.from(X[i]) });
  return out;
}

self.onmessage = (e) => {
  const { Kff_flat, Mff_flat, nF, nModes, dense, method } = e.data;
  try {
    // Regularize the diagonal of M (zero masses → small positive)
    let maxMd = 0;
    for (let i = 0; i < nF; i++) maxMd = Math.max(maxMd, Math.abs(Mff_flat[i * nF + i]));
    if (maxMd < 1e-30) { self.postMessage({ error: 'Matriz de masas nula. Asigne densidad ρ a los materiales o masa a los diafragmas.' }); return; }
    const eps = maxMd * 1e-8;
    for (let i = 0; i < nF; i++) if (Math.abs(Mff_flat[i * nF + i]) < eps) Mff_flat[i * nF + i] = eps;

    // REORDER K and M into banded form (RCM) once: this way the factorization, the
    // solve AND the matrix·vector products stay in O(n·b). In the banded path we
    // operate in the permuted space; the modes are un-permuted at the end. In the
    // dense path no reordering is needed (operated as-is).
    let Kp = Kff_flat, Mp = Mff_flat, perm = null, facPerm = null;
    if (!dense) {
      perm = permRCM(Kff_flat, nF);
      facPerm = new Int32Array(nF); for (let i = 0; i < nF; i++) facPerm[i] = i;
      Kp = new Float64Array(nF * nF); Mp = new Float64Array(nF * nF);
      for (let i = 0; i < nF; i++) {
        const pi = perm[i] * nF, oi = i * nF;
        for (let j = 0; j < nF; j++) { const pj = perm[j]; Kp[oi + j] = Kff_flat[pi + pj]; Mp[oi + j] = Mff_flat[pi + pj]; }
      }
    }

    const fac = makeFactor(Kp, nF, !!dense, facPerm);
    if (!fac.ok) { self.postMessage({ error: 'Factorización de K falló (¿estructura inestable / sin apoyos?).' }); return; }

    // Matrix·vector products only within the band (of the reordered matrix)
    const KB = rowBands(Kp, nF), MB = rowBands(Mp, nF);
    const mvK = (x) => _mvBand(Kp, x, nF, KB.lo, KB.hi);
    const mvM = (x) => _mvBand(Mp, x, nF, MB.lo, MB.hi);
    const solveK = (b) => fac.solve(b);

    const modes = (method === 'subspace')
      ? _subspace(mvK, mvM, solveK, nF, nModes)
      : _stodola(mvK, mvM, solveK, nF, nModes);
    if (!modes.length) { self.postMessage({ error: 'Sin modos estructurales. Verifique masa (ρ en material o diafragmas) y apoyos.' }); return; }
    // Un-permute the mode vectors back to the original order
    if (perm) for (const md of modes) {
      const v = new Float64Array(nF); for (let i = 0; i < nF; i++) v[perm[i]] = md.vec[i]; md.vec = Array.from(v);
    }
    self.postMessage({ modes });
  } catch (err) {
    self.postMessage({ error: (err && err.message) ? err.message : String(err) });
  }
};
