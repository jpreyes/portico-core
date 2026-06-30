// ──────────────────────────────────────────────────────────────────────────────
// timehistory.js — LINEAR dynamic TIME-HISTORY analysis by MODAL SUPERPOSITION
// (G12 · #48a).
//
// Excitation: UNIFORM base accelerogram a_g(t) (same motion at all supports). For
// each mode i (ωᵢ, participation factor Γᵢ = φᵢᵀM·r / φᵢᵀMφᵢ) the modal coordinate
// qᵢ(t) solves the SDOF
//
//     q̈ᵢ + 2ζωᵢ q̇ᵢ + ωᵢ² qᵢ = −Γᵢ · a_g(t)
//
// integrated with the DUHAMEL evaluated via the EXACT Nigam–Jennings recurrence
// (Chopra, "Dynamics of Structures", Table 5.4.1): exact when a_g(t) is piecewise
// linear (the natural interpolation of a record sampled at constant Δt) and
// unconditionally stable. The physical response is reconstructed by superposition:
//   u(t) = Σ φᵢ qᵢ(t).
//
// SELF-CONTAINED core (no dependencies) so it can be verified in Node against
// analytical SDOF solutions (step → DLF=2; harmonic → transfer function; free
// vibration → logarithmic decrement). See test_timehistory.mjs.
// ──────────────────────────────────────────────────────────────────────────────

// ── Coefficients of the exact Nigam–Jennings recurrence ───────────────────────
// For  ü + 2ζω u̇ + ω² u = p(t)  with p piecewise linear and constant step Δt:
//   u_{k+1} = A·u_k + B·u̇_k + C·p_k + D·p_{k+1}
//   u̇_{k+1} = A'·u_k + B'·u̇_k + C'·p_k + D'·p_{k+1}
// Valid for 0 ≤ ζ < 1. (Unit modal mass assumed: p is in acceleration units,
// like −Γ·a_g.)
export function njCoeffs(omega, zeta, dt) {
  const w1 = Math.sqrt(Math.max(1 - zeta * zeta, 1e-300));   // √(1−ζ²)
  const wd = omega * w1;                                       // damped ω
  const e = Math.exp(-zeta * omega * dt);
  const s = Math.sin(wd * dt), c = Math.cos(wd * dt);
  const zr = zeta / w1;                                        // ζ/√(1−ζ²)
  const w2 = omega * omega;
  const zod = 2 * zeta / (omega * dt);                         // 2ζ/(ωΔt)

  const A = e * (zr * s + c);
  const B = e * (s / wd);
  const C = (1 / w2) * (zod + e * (((1 - 2 * zeta * zeta) / (wd * dt) - zr) * s - (1 + zod) * c));
  const D = (1 / w2) * (1 - zod + e * (((2 * zeta * zeta - 1) / (wd * dt)) * s + zod * c));

  const Ap = -e * (omega / w1) * s;                            // −e·(ω/√(1−ζ²))·s
  const Bp = e * (c - zr * s);
  const Cp = (1 / w2) * (-1 / dt + e * ((omega / w1 + zr / dt) * s + (1 / dt) * c));
  const Dp = (1 / (w2 * dt)) * (1 - e * (zr * s + c));

  return { A, B, C, D, Ap, Bp, Cp, Dp };
}

// ── SDOF response to a load p[k] (piecewise linear) ───────────────────────────
// Solves ü + 2ζω u̇ + ω² u = p(t) and returns u (displacement) and v (velocity)
// at the same instants as p. u0/v0 = initial conditions (default at rest).
export function sdofResponse(omega, zeta, dt, p, u0 = 0, v0 = 0) {
  const n = p.length;
  const u = new Float64Array(n), v = new Float64Array(n);
  const { A, B, C, D, Ap, Bp, Cp, Dp } = njCoeffs(omega, zeta, dt);
  u[0] = u0; v[0] = v0;
  for (let k = 0; k < n - 1; k++) {
    u[k + 1] = A * u[k] + B * v[k] + C * p[k] + D * p[k + 1];
    v[k + 1] = Ap * u[k] + Bp * v[k] + Cp * p[k] + Dp * p[k + 1];
  }
  return { u, v };
}

// ── Response spectrum from an accelerogram ────────────────────────────────────
// For each period T in `periods`, integrates the SDOF of frequency ω=2π/T with
// damping ζ under a_g(t) and returns the max Sd, Sv (pseudo), Sa (pseudo).
// (Verification helper and for future use.)
export function responseSpectrum(ag, dt, periods, zeta = 0.05) {
  return periods.map(T => {
    const w = 2 * Math.PI / T;
    const p = new Float64Array(ag.length);
    for (let k = 0; k < ag.length; k++) p[k] = -ag[k];   // ü + … = −a_g
    const { u } = sdofResponse(w, zeta, dt, p);
    let Sd = 0; for (let k = 0; k < u.length; k++) Sd = Math.max(Sd, Math.abs(u[k]));
    return { T, w, Sd, Sv: w * Sd, Sa: w * w * Sd };
  });
}

// ── Full modal time-history ───────────────────────────────────────────────────
/**
 * @param {object} o
 *   modes  [{ omega, gamma, phi }]   ω (rad/s), Γ participation in the excitation
 *                                    direction, phi = mode shape (Float64Array nDOF)
 *   ag     Float64Array              base accelerogram (m/s²) sampled at Δt
 *   dt     number                    record time step (s)
 *   zeta   number | number[]         damping (scalar or per mode, default 0.05)
 * @returns {object}
 *   t       Float64Array(nSteps)     instants
 *   q       Float64Array[nModes]     modal coordinate qᵢ(t)
 *   nSteps, nModes
 *   nodalDOF(dof)        → Float64Array(nSteps)   history of one global DOF
 *   uAt(step)           → Float64Array(nDOF)      displacements at one instant
 *   peakModal           Float64Array(nModes)      max |qᵢ| per mode
 */
export function modalTimeHistory(o) {
  const modes = o.modes, ag = o.ag, dt = o.dt;
  const nSteps = ag.length, nModes = modes.length;
  const zArr = Array.isArray(o.zeta) ? o.zeta : modes.map(() => (o.zeta ?? 0.05));

  const t = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) t[k] = k * dt;

  const q = [];
  const peakModal = new Float64Array(nModes);
  for (let i = 0; i < nModes; i++) {
    const G = modes[i].gamma;
    const p = new Float64Array(nSteps);
    for (let k = 0; k < nSteps; k++) p[k] = -G * ag[k];     // −Γ·a_g
    const { u } = sdofResponse(modes[i].omega, zArr[i], dt, p);
    q.push(u);
    let pk = 0; for (let k = 0; k < nSteps; k++) pk = Math.max(pk, Math.abs(u[k]));
    peakModal[i] = pk;
  }

  const nDOF = modes.length ? modes[0].phi.length : 0;
  return {
    t, q, nSteps, nModes, peakModal,
    // History of one global DOF by superposition:  u_dof(t) = Σ φᵢ[dof]·qᵢ(t)
    nodalDOF(dof) {
      const h = new Float64Array(nSteps);
      for (let i = 0; i < nModes; i++) {
        const c = modes[i].phi[dof], qi = q[i];
        if (c === 0) continue;
        for (let k = 0; k < nSteps; k++) h[k] += c * qi[k];
      }
      return h;
    },
    // Full displacement vector at step `step`.
    uAt(step) {
      const u = new Float64Array(nDOF);
      for (let i = 0; i < nModes; i++) {
        const qi = q[i][step], phi = modes[i].phi;
        if (qi === 0) continue;
        for (let d = 0; d < nDOF; d++) u[d] += phi[d] * qi;
      }
      return u;
    }
  };
}
