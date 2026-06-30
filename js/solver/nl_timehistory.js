// ──────────────────────────────────────────────────────────────────────────────
// nl_timehistory.js — NONLINEAR TIME-HISTORY (plastic hinges) · #48b
//
// The LINEAR time-history (timehistory.js, G12) uses modal superposition with the
// per-mode Duhamel integral, valid only while the system is linear. As soon as
// plastic hinges form, the modal basis changes step by step and superposition is
// no longer valid; the rigorous procedure is the step-by-step DIRECT INTEGRATION
// of the nonlinear system:
//
//     M·ü + C·u̇ + r(u) = −M·ι·a_g(t)
//
// where r(u) is the nonlinear RESISTING FORCE (linear-elastic except at the hinges,
// which follow a hysteretic law). It is integrated with NEWMARK-β (constant average
// acceleration, γ=½, β=¼: unconditionally stable, no numerical dissipation) and,
// since r(u) is nonlinear, NEWTON–RAPHSON is iterated within each step with the
// tangent stiffness Kt of the current state. Damping is Rayleigh
// C = a₀·M + a₁·K₀ (initial stiffness), as in SAP2000/ETABS by default.
//
// The hinges are modeled as BILINEAR SPRINGS with kinematic hardening (perfectly
// plastic if α=0): elastic up to the yield Fy and with post-yield stiffness α·k₀
// afterwards, with elastic unloading and kinematic hysteresis (no degradation) —
// the standard Clough/elastoplastic hysteretic model.
//
// The core is SELF-CONTAINED (verifiable in Node, no DOM): it receives M, the
// resisting model `resist` (which encapsulates its own plastic history), the
// accelerogram and the influence vector. A constructor is included for the
// canonical test bench —the elastoplastic SHEAR BUILDING (interstory springs)—
// against which it is validated (test_nl_timehistory.mjs): the elastic limit
// reproduces the analytical SDOF, and the elastoplastic case matches an
// independent CENTRAL-DIFFERENCE integration (cross-check).
// ──────────────────────────────────────────────────────────────────────────────

// ── Small dense solver (Gaussian elimination with partial pivoting) ──────────────
// A is Float64Array(n*n) by rows; b Float64Array(n). Returns x (overwrites b).
export function denseSolve(A, b, n) {
  const M = A.slice();                     // working copy
  const x = b.slice();
  for (let k = 0; k < n; k++) {
    // partial pivoting
    let p = k, max = Math.abs(M[k * n + k]);
    for (let i = k + 1; i < n; i++) { const v = Math.abs(M[i * n + k]); if (v > max) { max = v; p = i; } }
    if (max < 1e-300) throw new Error('matriz efectiva singular en el paso no lineal');
    if (p !== k) { for (let j = 0; j < n; j++) { const t = M[k * n + j]; M[k * n + j] = M[p * n + j]; M[p * n + j] = t; } const t = x[k]; x[k] = x[p]; x[p] = t; }
    const piv = M[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const f = M[i * n + k] / piv; if (f === 0) continue;
      for (let j = k; j < n; j++) M[i * n + j] -= f * M[k * n + j];
      x[i] -= f * x[k];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i]; for (let j = i + 1; j < n; j++) s -= M[i * n + j] * x[j];
    x[i] = s / M[i * n + i];
  }
  return x;
}

// ── Bilinear spring with kinematic hardening (1D hinge) ─────────────────────────
// One-dimensional J2 plasticity with back-stress (return mapping):
//   f_tr = k0·(d − ep);  X = H·ep;  φ = |f_tr − X| − Fy
//   φ≤0 → elastic (kt=k0);  φ>0 → Δγ=φ/(k0+H), ep+=Δγ·sgn, kt=α·k0
// with H = α/(1−α)·k0 (α = hardening ratio; α=0 ⇒ perfectly plastic).
export function makeBilinear(k0, Fy, alpha = 0) {
  const H = alpha >= 1 ? Infinity : alpha / (1 - alpha) * k0;
  return {
    k0, Fy, alpha, ep: 0, _epTrial: 0,
    // Force and tangent for a trial deformation (does NOT commit the state).
    eval(d) {
      const ftr = k0 * (d - this.ep);
      const X = (H === Infinity ? 0 : H * this.ep);
      const phi = Math.abs(ftr - X) - this.Fy;
      if (phi <= 0 || k0 === 0) { this._epTrial = this.ep; return { f: ftr, kt: k0 }; }
      const dgam = phi / (k0 + (H === Infinity ? k0 * 1e12 : H));
      const sgn = Math.sign(ftr - X) || 1;
      this._epTrial = this.ep + dgam * sgn;
      const f = k0 * (d - this._epTrial);
      const kt = (H === Infinity) ? k0 : k0 * H / (k0 + H);   // = α·k0
      return { f, kt };
    },
    commit() { this.ep = this._epTrial; },
    yielded() { return Math.abs(this.ep) > 1e-14; },
  };
}

// ── Constructor: elastoplastic SHEAR BUILDING ────────────────────────────────────
// Stories i=0..N−1; spring i connects DOF i−1 (ground=0 fixed) with DOF i.
//   m[i]  story mass  ·  k[i] interstory stiffness  ·  Fy[i] yield shear
//   alpha[i] post-yield hardening ratio.
// Returns { n, M (diag), resist, springs } ready for newmarkNonlinear.
export function shearBuilding({ m, k, Fy, alpha }) {
  const n = m.length;
  const M = Float64Array.from(m);
  const springs = k.map((ki, i) => makeBilinear(ki, (Fy && Fy[i] != null) ? Fy[i] : Infinity, (alpha && alpha[i]) || 0));
  // drift of spring i = u[i] − u[i−1]   (u[-1] = ground = 0)
  const resist = {
    springs,
    internal(u) {
      const f = new Float64Array(n);
      const Kt = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        const di = u[i] - (i > 0 ? u[i - 1] : 0);
        const { f: si, kt } = springs[i].eval(di);
        f[i] += si; if (i > 0) f[i - 1] -= si;
        Kt[i * n + i] += kt;
        if (i > 0) { Kt[(i - 1) * n + (i - 1)] += kt; Kt[i * n + (i - 1)] -= kt; Kt[(i - 1) * n + i] -= kt; }
      }
      return { f, Kt };
    },
    commit() { for (const s of springs) s.commit(); },
    // Initial stiffness (for Rayleigh and the reference modal).
    K0() {
      const Kt = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        const kt = springs[i].k0;
        Kt[i * n + i] += kt;
        if (i > 0) { Kt[(i - 1) * n + (i - 1)] += kt; Kt[i * n + (i - 1)] -= kt; Kt[(i - 1) * n + i] -= kt; }
      }
      return Kt;
    },
  };
  return { n, M, resist, springs };
}

// Rayleigh damping C = a₀·M + a₁·K₀ that gives ζ at two frequencies.
//   M diag (Float64Array n), K0 Float64Array(n*n).
export function rayleighDamping(M, K0, n, zeta, w1, w2) {
  // a0, a1 from ζ = ½(a0/ω + a1·ω) at ω1, ω2.
  const a1 = (w1 === w2) ? zeta / w1 : 2 * zeta / (w1 + w2);
  const a0 = (w1 === w2) ? zeta * w1 : 2 * zeta * w1 * w2 / (w1 + w2);
  const C = new Float64Array(n * n);
  for (let i = 0; i < n; i++) { C[i * n + i] += a0 * M[i]; for (let j = 0; j < n; j++) C[i * n + j] += a1 * K0[i * n + j]; }
  return { C, a0, a1 };
}

/**
 * Integración directa NEWMARK-β no lineal (Newton–Raphson por paso).
 *
 * @param {object} o
 *   M       Float64Array(n)        masa concentrada (diagonal).
 *   resist  { internal(u)->{f,Kt}, commit() }   modelo resistente no lineal.
 *   C       Float64Array(n*n)|null amortiguamiento (Rayleigh); null = 0.
 *   ag      Float64Array           accelerogram a_g(t) (m/s²), uniform Δt.
 *   dt      number                 time step (s).
 *   infl    Float64Array(n)|null   influence vector ι (def. 1 for all).
 *   gamma,beta  Newmark (def. ½, ¼).
 *   tol     residual tolerance (def. 1e-8 relative to |p|).
 *   maxIter Newton (def. 30).
 *   u0,v0   initial state (def. at rest).
 *   store   'full' stores u per step (def.) | 'monitor' only monitorDof.
 *   monitorDof  DOF index to record if store='monitor'.
 * @returns { n, nSteps, dt, U?:Float64Array[], mon?:Float64Array, peak, peakStep,
 *            residual:Float64Array(n), driftMax, anyYield }
 */
export function newmarkNonlinear(o) {
  const { M, resist, ag, dt } = o;
  const n = M.length;
  const C = o.C || null;
  const infl = o.infl || Float64Array.from({ length: n }, () => 1);
  const gamma = o.gamma ?? 0.5, beta = o.beta ?? 0.25;
  const tol = o.tol ?? 1e-8, maxIter = o.maxIter ?? 30;
  const nSteps = ag.length;

  let u = o.u0 ? Float64Array.from(o.u0) : new Float64Array(n);
  let v = o.v0 ? Float64Array.from(o.v0) : new Float64Array(n);
  // Initial acceleration: a0 = M⁻¹(p0 − C·v0 − r(u0))
  const a = new Float64Array(n);
  {
    const { f } = resist.internal(u);
    for (let i = 0; i < n; i++) {
      let cv = 0; if (C) for (let j = 0; j < n; j++) cv += C[i * n + j] * v[j];
      a[i] = (-M[i] * infl[i] * ag[0] - cv - f[i]) / M[i];
    }
  }

  const store = o.store || 'full';
  const U = store === 'full' ? [Float64Array.from(u)] : null;
  const mon = store === 'monitor' ? new Float64Array(nSteps) : null;
  const monDof = o.monitorDof || 0;
  if (mon) mon[0] = u[monDof];

  const c1 = 1 / (beta * dt * dt), c2 = gamma / (beta * dt);
  const c3 = 1 / (beta * dt), c4 = 1 / (2 * beta) - 1;
  const c5 = dt * (1 - gamma), c6 = dt * gamma;

  let peak = Math.abs(u[monDof]), peakStep = 0, driftMax = 0, anyYield = false;
  const un = new Float64Array(n), an = new Float64Array(n), vn = new Float64Array(n);
  const R = new Float64Array(n), Keff = new Float64Array(n * n);
  let lastResidual = new Float64Array(n);

  for (let k = 1; k < nSteps; k++) {
    const agk = ag[k];
    // Predictor: u_{k+1} = u_k (Newton starts from the last converged state).
    for (let i = 0; i < n; i++) un[i] = u[i];
    let it = 0, conv = false;
    let pnorm = 0; for (let i = 0; i < n; i++) pnorm += (M[i] * infl[i] * agk) ** 2; pnorm = Math.sqrt(pnorm) || 1;
    for (; it < maxIter; it++) {
      // Newmark kinematics in terms of un.
      for (let i = 0; i < n; i++) {
        an[i] = c1 * (un[i] - u[i]) - c3 * v[i] - c4 * a[i];
        vn[i] = v[i] + c5 * a[i] + c6 * an[i];
      }
      const { f, Kt } = resist.internal(un);
      // Residual R = p − M·a − C·v − f
      for (let i = 0; i < n; i++) {
        let cv = 0; if (C) for (let j = 0; j < n; j++) cv += C[i * n + j] * vn[j];
        R[i] = -M[i] * infl[i] * agk - M[i] * an[i] - cv - f[i];
      }
      let rnorm = 0; for (let i = 0; i < n; i++) rnorm += R[i] * R[i]; rnorm = Math.sqrt(rnorm);
      if (rnorm <= tol * pnorm && it > 0) { conv = true; break; }
      // Keff = Kt + c2·C + c1·M (effective dynamic tangent)
      for (let i = 0; i < n * n; i++) Keff[i] = Kt[i] + (C ? c2 * C[i] : 0);
      for (let i = 0; i < n; i++) Keff[i * n + i] += c1 * M[i];
      const du = denseSolve(Keff, R, n);
      for (let i = 0; i < n; i++) un[i] += du[i];
      if (it === 0) {
        // second check: if Δu is tiny, we are done
        let dn = 0; for (let i = 0; i < n; i++) dn += du[i] * du[i];
        if (Math.sqrt(dn) < 1e-14) { conv = true; }
      }
    }
    if (!conv && it >= maxIter) {
      // Recompute kinematics/residual of the last un for reporting.
      for (let i = 0; i < n; i++) { an[i] = c1 * (un[i] - u[i]) - c3 * v[i] - c4 * a[i]; vn[i] = v[i] + c5 * a[i] + c6 * an[i]; }
    }
    // Commit the plastic state of the converged step and advance.
    resist.internal(un); resist.commit();
    for (let i = 0; i < n; i++) { u[i] = un[i]; v[i] = vn[i]; a[i] = an[i]; lastResidual[i] = R[i]; }
    if (U) U.push(Float64Array.from(u));
    if (mon) mon[k] = u[monDof];
    const am = Math.abs(u[monDof]); if (am > peak) { peak = am; peakStep = k; }
    // max (interstory) drift if the resist exposes springs.
    if (resist.springs) for (let i = 0; i < n; i++) { const d = Math.abs(u[i] - (i > 0 ? u[i - 1] : 0)); if (d > driftMax) driftMax = d; }
  }
  if (resist.springs) anyYield = resist.springs.some(s => s.yielded());

  return { n, nSteps, dt, U, mon, peak, peakStep, residual: lastResidual, driftMax, anyYield };
}

// ── Independent CENTRAL-DIFFERENCE integrator (for verification only) ────────────
// Explicit: u_{k+1} from M̂·u_{k+1} = p_k − (K_secant via resist)·… — here the
// resisting force is evaluated with the current state (without iterating), which is
// why it requires a fine Δt. Serves as a cross-check of the nonlinear Newmark
// (a different time scheme).
export function centralDifferenceNonlinear(o) {
  const { M, resist, ag, dt } = o;
  const n = M.length;
  const C = o.C || null;
  const infl = o.infl || Float64Array.from({ length: n }, () => 1);
  const nSteps = ag.length;
  let u = new Float64Array(n), uPrev = new Float64Array(n), v = new Float64Array(n);
  // a0
  const a0 = new Float64Array(n);
  { const { f } = resist.internal(u); resist.commit(); for (let i = 0; i < n; i++) a0[i] = (-M[i] * infl[i] * ag[0] - f[i]) / M[i]; }
  for (let i = 0; i < n; i++) uPrev[i] = u[i] - dt * v[i] + 0.5 * dt * dt * a0[i];
  const monDof = o.monitorDof || 0;
  const mon = new Float64Array(nSteps); mon[0] = u[monDof];
  let peak = Math.abs(u[monDof]), peakStep = 0;
  const uNext = new Float64Array(n);
  for (let k = 1; k < nSteps; k++) {
    const { f } = resist.internal(u); resist.commit();
    for (let i = 0; i < n; i++) {
      // central velocity for the damping
      let cv = 0; if (C) for (let j = 0; j < n; j++) cv += C[i * n + j] * (u[j] - uPrev[j]) / (2 * dt);
      const p = -M[i] * infl[i] * ag[k];
      // M (u_{k+1} − 2u_k + u_{k−1})/dt² = p − C·v − f
      uNext[i] = (p - cv - f[i]) * dt * dt / M[i] + 2 * u[i] - uPrev[i];
    }
    for (let i = 0; i < n; i++) { uPrev[i] = u[i]; u[i] = uNext[i]; }
    mon[k] = u[monDof];
    const am = Math.abs(u[monDof]); if (am > peak) { peak = am; peakStep = k; }
  }
  return { mon, peak, peakStep };
}
