// ──────────────────────────────────────────────────────────────────────────────
// ModalSolver — Stodola inverse power iteration with M-orthogonal deflation
//
// Finds the first nModes natural modes of  K·φ = ω²·M·φ  without computing
// the full eigendecomposition of A = M⁻¹K.
//
// Why not numeric.eig?
//   The penalty method for rigid diaphragms makes K ill-conditioned
//   (condition ~ 1e8), causing numeric.eig to produce undefined eigenvector
//   rows for large matrices.  Inverse power iteration avoids this because:
//   · It only uses numeric.LU + LUsolve (stable direct factorisation).
//   · It naturally finds low-frequency structural modes first, skipping the
//     high-frequency penalty modes entirely.
//
// Algorithm per mode i:
//   1. Start: random vector x₀, M-normalised, M-orthogonal to found modes.
//   2. Inverse power step:  solve K·y = M·x   →   y ≈ φᵢ / ωᵢ²
//   3. M-orthogonalise y against found modes (deflation).
//   4. Update x ← y / ‖y‖_M ,  Rayleigh quotient ωᵢ² = xᵀKx.
//   5. Repeat until ‖Δω²‖/ω² < 1e-7.
// ──────────────────────────────────────────────────────────────────────────────
import { buildNodeIndex, assembleK, getNodeDOFs } from './assembler.js?v=2';
import { ModalResults } from './modal_results.js?v=2';

export class ModalSolver {
  /**
   * @param {Model}  model
   * @param {number} nModes   number of modes to extract (default 10)
   */
  solve(model, nModes = 10) {
    const nodeIndex = buildNodeIndex(model);
    const { K, M, nDOF } = assembleK(model, nodeIndex);

    // ── Free DOFs ─────────────────────────────────────────────────────────────
    const freeDOF = [];
    for (const node of model.nodes.values()) {
      const d = getNodeDOFs(nodeIndex, node.id);
      const r = node.restraints;
      [r.ux, r.uy, r.uz, r.rx, r.ry, r.rz].forEach((fixed, li) => {
        if (!fixed) freeDOF.push(d[li]);
      });
    }
    if (freeDOF.length === 0) throw new Error('No hay grados de libertad libres.');

    const nF = freeDOF.length;

    // ── Extract K_ff and M_ff ─────────────────────────────────────────────────
    const Kff = Array.from({length: nF}, (_, i) =>
      Array.from({length: nF}, (_, j) => K[freeDOF[i]*nDOF + freeDOF[j]])
    );
    const Mff = Array.from({length: nF}, (_, i) =>
      Array.from({length: nF}, (_, j) => M[freeDOF[i]*nDOF + freeDOF[j]])
    );

    const num = window.numeric;
    if (!num) throw new Error('numeric.js no disponible.');

    // ── Check that model has mass ─────────────────────────────────────────────
    let maxMd = 0;
    for (let i = 0; i < nF; i++) maxMd = Math.max(maxMd, Math.abs(Mff[i][i]));
    if (maxMd < 1e-30)
      throw new Error(
        'Matriz de masas nula. Asigne densidad ρ a los materiales ' +
        'o masa a los diafragmas.'
      );

    // ── #5: static condensation (Guyan) of the MASSLESS DOFs ──────────────────
    // DOFs with stiffness but ~zero mass (ρ=0 models, rotations without rotational
    // inertia, internal nodes without mass) generate SPURIOUS modes of very high
    // frequency / ill-conditioning. They are statically condensed before the modal
    // (exact when the DOF has no inertia). Only triggered if there are DOFs truly
    // without mass (< 1e-6 of the maximum) → normal models (consistent mass) untouched.
    const red = guyanReduce(Kff, Mff, nF, maxMd, num);
    const Kw = red ? red.Kr : Kff;
    const Mw = red ? red.Mr : Mff;
    const nW = red ? red.nM : nF;

    // Safety mass floor (only affects residually-null diagonals; on the
    // non-condensed path it reproduces the previous behavior).
    let maxW = 0; for (let i = 0; i < nW; i++) maxW = Math.max(maxW, Math.abs(Mw[i][i]));
    const eps = (maxW || maxMd) * 1e-8;
    for (let i = 0; i < nW; i++) if (Math.abs(Mw[i][i]) < eps) Mw[i][i] = eps;

    // ── Pre-factor once (reused across all inverse power steps) ───────────────
    let KLU;
    try { KLU = num.LU(Kw); } catch(e) {
      throw new Error('Factorización de K falló: ' + e.message +
                      '.  Verifique estabilidad del modelo.');
    }

    // ── Stodola inverse power iteration ──────────────────────────────────────
    const modesR = _stodola(Kw, KLU, Mw, nW, nModes, num);

    if (modesR.length === 0)
      throw new Error(
        'Sin modos estructurales. Verifique masa (ρ en material o diafragmas) y apoyos.'
      );

    // Re-expand the condensed modes to all free DOFs (φ_s = T_sm · φ_m).
    const modes = red ? modesR.map(m => ({ omega2: m.omega2, vec: red.expand(m.vec) })) : modesR;

    return new ModalResults(model, nodeIndex, freeDOF, modes, M, nDOF);
  }
}

// ── #5: static Guyan reduction of the massless DOFs ───────────────────────────
// Partitions the free DOFs into MASTERS (with mass) and SLAVES (~zero mass) and
// condenses the slaves: Kr = Kmm − Kms·Kss⁻¹·Ksm,  Mr = Tᵀ M T  with  T=[I ; −Kss⁻¹Ksm].
// Returns { Kr, Mr, nM, expand(φm)→φfree, nCondensed } or null if there is nothing to
// condense (or Kss is singular → the normal path is kept).
export function guyanReduce(Kff, Mff, nF, maxMd, num) {
  if (!(maxMd > 0)) return null;
  const thr = maxMd * 1e-6;
  const master = [], slave = [];
  for (let i = 0; i < nF; i++) (Math.abs(Mff[i][i]) > thr ? master : slave).push(i);
  if (!slave.length || !master.length) return null;   // nothing to condense

  const sub = (A, rows, cols) => rows.map(i => cols.map(j => A[i][j]));
  const Kss = sub(Kff, slave, slave);
  let Kssi;
  try { Kssi = num.inv(Kss); } catch { return null; }
  if (!Kssi || Kssi.some(r => r.some(v => !isFinite(v)))) return null;

  const Ksm = sub(Kff, slave, master);
  const Kms = sub(Kff, master, slave);
  const Tsm = num.neg(num.dot(Kssi, Ksm));            // slaves = Tsm · masters  (nS×nM)

  // Kr = Kmm + Kms·Tsm
  const Kr = num.add(sub(Kff, master, master), num.dot(Kms, Tsm));
  // Mr = Mmm + Mms·Tsm + Tsmᵀ·Msm + Tsmᵀ·Mss·Tsm   (full Guyan mass)
  const Mmm = sub(Mff, master, master), Mms = sub(Mff, master, slave);
  const Msm = sub(Mff, slave, master),  Mss = sub(Mff, slave, slave);
  const TsmT = num.transpose(Tsm);
  let Mr = num.add(Mmm, num.dot(Mms, Tsm));
  Mr = num.add(Mr, num.dot(TsmT, Msm));
  Mr = num.add(Mr, num.dot(TsmT, num.dot(Mss, Tsm)));

  const nM = master.length, nS = slave.length;
  for (let i = 0; i < nM; i++) for (let j = i + 1; j < nM; j++) {   // symmetrize
    const k = 0.5 * (Kr[i][j] + Kr[j][i]); Kr[i][j] = Kr[j][i] = k;
    const m = 0.5 * (Mr[i][j] + Mr[j][i]); Mr[i][j] = Mr[j][i] = m;
  }
  const expand = (vM) => {
    const vF = new Array(nF).fill(0);
    for (let a = 0; a < nM; a++) vF[master[a]] = vM[a];
    for (let s = 0; s < nS; s++) { let acc = 0; const row = Tsm[s]; for (let a = 0; a < nM; a++) acc += row[a] * vM[a]; vF[slave[s]] = acc; }
    return vF;
  };
  return { Kr, Mr, nM, expand, nCondensed: nS };
}

// ── Stodola with M-orthogonal deflation ───────────────────────────────────────
function _stodola(K, KLU, M, nF, nModes, num) {
  const found = [];

  for (let modeNum = 0; modeNum < nModes; modeNum++) {
    let bestOmega2 = Infinity, bestVec = null;

    // Try up to 6 different start vectors per mode to survive M-deflation degeneracy
    for (let attempt = 0; attempt < 6; attempt++) {
      // Deterministic but different seeds per attempt
      const phase = (modeNum + 1 + attempt * 7) * 0.7 + attempt * 0.41;
      let x = Array.from({length: nF}, (_, i) =>
        Math.sin(phase * (i + 1)) + Math.cos((attempt + 1) * (i + 0.5) * 1.1) * 0.5 + 0.1
      );
      _mOrtho(x, found, M, nF);

      // Skip if near-zero after M-deflation (start vector ≈ span of found modes)
      const Mx0 = _mv(M, x, nF);
      const n0  = Math.sqrt(Math.max(_dot(x, Mx0, nF), 0));
      if (n0 < 1e-10) continue;

      x = _mNorm(x, M, nF);

      let omega2 = 0, converged = false;

      for (let iter = 0; iter < 150; iter++) {
        const Mx = _mv(M, x, nF);
        const y  = num.LUsolve(KLU, Mx);

        _mOrtho(y, found, M, nF);

        // Abort if deflated vector is trivial
        const My  = _mv(M, y, nF);
        const yn  = Math.sqrt(Math.max(_dot(y, My, nF), 0));
        if (yn < 1e-30) break;

        const xNew = _mNorm([...y], M, nF);
        const Kx   = _mv(K, xNew, nF);
        const w2   = _dot(xNew, Kx, nF);

        if (!isFinite(w2) || w2 < 0) break;

        const relChange = Math.abs(w2 - omega2) / Math.max(w2, 1e-10);
        omega2 = w2;
        x      = xNew;

        if (relChange < 1e-7 && iter >= 4) { converged = true; break; }
        // Fallback: accept near-converged result for ill-conditioned penalty systems
        if (relChange < 1e-4 && iter >= 20) { converged = true; break; }
      }

      if (converged && isFinite(omega2) && omega2 >= 0 && omega2 < 1e12) {
        // Keep the attempt that gives the smallest ω² (lowest frequency)
        if (omega2 < bestOmega2) { bestOmega2 = omega2; bestVec = [...x]; }
      }
    }

    if (!bestVec) break;   // none of the attempts converged → stop
    found.push({ omega2: bestOmega2, vec: bestVec });
  }

  return found;
}

// ── Dense matrix / vector helpers ─────────────────────────────────────────────
function _mv(A, x, n) {
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const Ai = A[i];
    let s = 0;
    for (let j = 0; j < n; j++) s += Ai[j] * x[j];
    y[i] = s;
  }
  return y;
}

function _dot(a, b, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function _mNorm(x, M, n) {
  const Mx   = _mv(M, x, n);
  const norm = Math.sqrt(Math.max(_dot(x, Mx, n), 0));
  if (norm < 1e-30) return x;
  for (let i = 0; i < n; i++) x[i] /= norm;
  return x;
}

function _mOrtho(x, found, M, n) {
  for (const { vec: phi } of found) {
    const Mphi = _mv(M, phi, n);
    const c    = _dot(x, Mphi, n);   // xᵀ M φ
    for (let i = 0; i < n; i++) x[i] -= c * phi[i];
  }
}
