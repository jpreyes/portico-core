// ──────────────────────────────────────────────────────────────────────────────
// SpectrumSolver — modal response spectrum analysis (SRSS / CQC)
//
// Algorithm per mode i and seismic direction d:
//   1. Sa(Ti) from user spectrum (linear interp, 1/T extrapolation for T>Tmax)
//   2. Sd_i = Sa_i / ω_i²                   [spectral displacement, model length]
//   3. u_i = φ_i × (Γ_d_i / genMass_i) × Sd_i   [modal disp. vector]
//   4. Recover element forces from u_i via Ke_local × T × u_i_elem
//   5. SRSS: combine = √Σ val_i²
//      CQC:  combine = √ΣΣ ρ_ij × val_i × val_j
//            ρ_ij = 8ζ²(1+r)r^1.5 / ((1-r²)² + 4ζ²r(1+r)²)  r = ω_min/ω_max
// ──────────────────────────────────────────────────────────────────────────────
import { localAxes, stiffnessMatrix, transformMatrix } from './timoshenko.js?v=3';
import { getNodeDOFs } from './assembler.js?v=3';
import { SpectrumResults } from './spectrum_results.js?v=3';

// Indices match modal_results dirs: X=0, Y=1, Rz=2 (Z vertical removed)
const DIR_IDX = { X: 0, Y: 1 };

export class SpectrumSolver {
  /**
   * @param {ModalResults} mr      already-solved modal results
   * @param {Object}       params
   *   params.spectrum    [{T, Sa}]   sorted ascending by T (Sa in model accel. units)
   *   params.saFactor    number      multiply raw Sa by this to get model accel. (m/s²)
   *   params.direction   'X'|'Y'|'Z'
   *   params.zeta        damping ratio (default 0.05)
   *   params.method      'CQC'|'SRSS'
   */
  solve(mr, params) {
    const { spectrum, saFactor = 1, direction = 'X',
            zeta = 0.05, method = 'CQC' } = params;

    const dirIdx = DIR_IDX[direction];
    if (dirIdx === undefined) throw new Error('Dirección inválida: ' + direction);

    const { model, nodeIndex, modeShapes, omega, period, nModes, nDOF, genMass } = mr;
    const part = mr.getParticipation();

    // ── Modal spectral displacements ──────────────────────────────────────────
    const modalDisp = [];  // nModes × Float64Array(nDOF)

    for (let mi = 0; mi < nModes; mi++) {
      const T   = period[mi];
      const w   = omega[mi];
      const Sa  = _interpSa(spectrum, T) * saFactor;    // model accel. units
      const Sd  = Sa / (w * w);                         // spectral displacement
      const G   = part.rows[mi].gamma[dirIdx];          // Γ_d_i
      const Mn  = genMass[mi];                          // φ^T M φ
      const eff = Mn > 1e-30 ? G / Mn : 0;             // effective participation

      const u = new Float64Array(nDOF);
      const phi = modeShapes[mi];
      for (let dof = 0; dof < nDOF; dof++) u[dof] = phi[dof] * eff * Sd;
      modalDisp.push(u);
    }

    // ── CQC correlation matrix ────────────────────────────────────────────────
    const RHO = method === 'CQC'
      ? _buildCQC(omega, zeta)
      : _buildSRSS(nModes);       // SRSS = identity (ρ_ij = δ_ij)

    // ── Combine nodal displacements ───────────────────────────────────────────
    const U_combined = new Float64Array(nDOF);
    for (let dof = 0; dof < nDOF; dof++) {
      let sum = 0;
      for (let i = 0; i < nModes; i++) {
        for (let j = 0; j < nModes; j++) {
          sum += RHO[i][j] * modalDisp[i][dof] * modalDisp[j][dof];
        }
      }
      U_combined[dof] = Math.sqrt(Math.max(0, sum));
    }

    // ── Recover and combine element forces ────────────────────────────────────
    const modalEF  = modalDisp.map(u => _computeElemForces(model, nodeIndex, u, nDOF));
    const combined = _combineElemForces(modalEF, RHO, nModes);

    return new SpectrumResults(model, nodeIndex, U_combined, combined, {
      direction, method, nModes, zeta
    });
  }
}

// ── Element force recovery ────────────────────────────────────────────────────
function _computeElemForces(model, nodeIndex, u, nDOF) {
  const forces = new Map();
  for (const elem of model.elements.values()) {
    const n1  = model.nodes.get(elem.n1);
    const n2  = model.nodes.get(elem.n2);
    const mat = model.materials.get(elem.matId);
    const sec = model.sections.get(elem.secId);
    if (!n1 || !n2 || !mat || !sec) continue;

    const { ex, ey, ez, L } = localAxes(n1, n2);
    const Ke = stiffnessMatrix(L, mat, sec);
    const T  = transformMatrix(ex, ey, ez);

    const d1 = getNodeDOFs(nodeIndex, elem.n1);
    const d2 = getNodeDOFs(nodeIndex, elem.n2);
    const uG = [...d1, ...d2].map(i => u[i]);

    // u_local = T · u_global
    const uL = Array(12).fill(0);
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++) uL[i] += T[i][j] * uG[j];

    // f_local = Ke · u_local
    const f = Array(12).fill(0);
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++) f[i] += Ke[i][j] * uL[j];

    forces.set(elem.id, {
      N:    -f[0],
      Vy1:   f[1],  Vz1:  f[2],  T_:  f[3],
      My1:   f[4],  Mz1:  f[5],
      Vy2:  -f[7],  Vz2: -f[8],
      My2:  -f[10], Mz2: -f[11],
      ex, ey, ez, L
    });
  }
  return forces;
}

// ── SRSS/CQC combination of element forces ────────────────────────────────────
const FORCE_KEYS = ['N', 'Vy1', 'Vz1', 'T_', 'My1', 'Mz1', 'Vy2', 'Vz2', 'My2', 'Mz2'];

function _combineElemForces(modalEF, RHO, nModes) {
  const combined = new Map();
  for (const [elemId] of modalEF[0]) {
    const out = { ex: null, ey: null, ez: null, L: 0 };
    for (const k of FORCE_KEYS) out[k] = 0;

    for (let i = 0; i < nModes; i++) {
      const fi = modalEF[i].get(elemId);
      if (!fi) continue;
      if (!out.ex) { out.ex = fi.ex; out.ey = fi.ey; out.ez = fi.ez; out.L = fi.L; }

      for (let j = 0; j < nModes; j++) {
        const fj = modalEF[j].get(elemId);
        if (!fj) continue;
        const rho = RHO[i][j];
        for (const k of FORCE_KEYS) {
          out[k] += rho * fi[k] * fj[k];
        }
      }
    }
    // Take sqrt of sums-of-products → combined envelope
    for (const k of FORCE_KEYS) out[k] = Math.sqrt(Math.max(0, out[k]));

    // Add convenience summary fields
    out.Vmax = Math.max(out.Vy1, out.Vz1, out.Vy2, out.Vz2);
    out.Mmax = Math.max(out.Mz1, out.My1, out.Mz2, out.My2);
    out.Nabs = out.N;
    // Alias T_ → T for compatibility with postprocess.js consumers
    out.T    = out.T_;
    combined.set(elemId, out);
  }
  return combined;
}

// ── CQC / SRSS matrices ───────────────────────────────────────────────────────
function _buildCQC(omega, zeta) {
  const n = omega.length;
  const R = Array.from({length: n}, () => new Array(n).fill(0));
  const z2 = zeta * zeta;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) { R[i][j] = 1; continue; }
      const r = omega[i] < omega[j]
        ? omega[i] / omega[j]
        : omega[j] / omega[i];   // r ≤ 1
      const num = 8 * z2 * (1 + r) * Math.pow(r, 1.5);
      const dif = 1 - r*r;
      const den = dif*dif + 4*z2*r*(1+r)*(1+r);
      R[i][j] = den > 1e-30 ? num / den : 0;
    }
  }
  return R;
}

function _buildSRSS(n) {
  return Array.from({length: n}, (_, i) =>
    Array.from({length: n}, (_, j) => (i === j ? 1 : 0))
  );
}

// ── Spectrum interpolation ────────────────────────────────────────────────────
function _interpSa(pts, T) {
  if (pts.length === 0) return 0;
  if (T <= pts[0].T) return pts[0].Sa;
  if (T >= pts[pts.length-1].T) {
    // 1/T extrapolation for long periods
    const last = pts[pts.length-1];
    return last.Sa * last.T / T;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i], p1 = pts[i+1];
    if (T >= p0.T && T <= p1.T) {
      const t = (T - p0.T) / (p1.T - p0.T);
      return p0.Sa + t * (p1.Sa - p0.Sa);
    }
  }
  return 0;
}
