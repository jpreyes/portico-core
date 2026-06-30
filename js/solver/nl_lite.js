// ──────────────────────────────────────────────────────────────────────────────
// nl_lite.js — "lite" geometric NONLINEAR analysis (accessible to everyone).
//
// PHASE 1:
//   · 3D corotational BAR/CABLE element (exact geometric nonlinearity).
//   · "tension-only" cable: if it goes into compression it goes slack (N = 0).
//   · "compression-only" strut: if it goes into tension it goes loose (N = 0).
//   · Prestress via NATURAL LENGTH L0 (if L0 < geometric length → tension at rest;
//     the initial equilibrium already includes the pretension).
//   · INCREMENTAL-ITERATIVE solver (Newton-Raphson) with load control.
//   · Step-by-step recording of the deflected shape (for animation).
//
// The core is SELF-CONTAINED (its own dense linear solver) so it can be verified
// in Node without dependencies and serve as the base of the next phases (P-Delta,
// buckling, form-finding, plastic hinges, displacement control).
//
// Convention: 3 translational DOFs per node. X = reference coords
// (Float64Array 3·nNode). u = displacements (same size). global dof = 3·node+c.
// ──────────────────────────────────────────────────────────────────────────────

// ── Dense linear solver (Gauss with partial pivoting) ─────────────────────────
export function solveDense(A, b, n) {
  const M = new Float64Array(n * n); M.set(A);
  const x = new Float64Array(n); x.set(b);
  for (let k = 0; k < n; k++) {
    // partial pivoting
    let p = k, mx = Math.abs(M[k * n + k]);
    for (let i = k + 1; i < n; i++) { const v = Math.abs(M[i * n + k]); if (v > mx) { mx = v; p = i; } }
    if (mx < 1e-300) return null;   // singular
    if (p !== k) {
      for (let j = 0; j < n; j++) { const t = M[k * n + j]; M[k * n + j] = M[p * n + j]; M[p * n + j] = t; }
      const t = x[k]; x[k] = x[p]; x[p] = t;
    }
    const piv = M[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const f = M[i * n + k] / piv;
      if (f === 0) continue;
      for (let j = k; j < n; j++) M[i * n + j] -= f * M[k * n + j];
      x[i] -= f * x[k];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let j = i + 1; j < n; j++) s -= M[i * n + j] * x[j];
    x[i] = s / M[i * n + i];
  }
  return x;
}

// ── Corotational state of a bar/cable element ─────────────────────────────────
// Returns N (axial), l (current length), n (unit vector i→j), taut (bool).
// slack = relative residual axial stiffness when the cable is slack (stabilizes the
// tangent without altering the equilibrium because N=0).
export function barState(X, u, el) {
  const i = el.n1, j = el.n2;
  const xi = X[3 * i] + u[3 * i], yi = X[3 * i + 1] + u[3 * i + 1], zi = X[3 * i + 2] + u[3 * i + 2];
  const xj = X[3 * j] + u[3 * j], yj = X[3 * j + 1] + u[3 * j + 1], zj = X[3 * j + 2] + u[3 * j + 2];
  let dx = xj - xi, dy = yj - yi, dz = zj - zi;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-300;
  const n = [dx / l, dy / l, dz / l];
  const L0 = el.L0;
  let N = el.EA * (l - L0) / L0;       // axial force (engineering strain)
  let taut = true;
  if (el.cable && N < 0) { N = 0; taut = false; }            // slack cable (tension only)
  else if (el.compressionOnly && N > 0) { N = 0; taut = false; }  // loose strut (compression only)
  return { N, l, n, L0, taut };
}

// Nodal internal force g (6) and tangent kt (6×6) of the element, in order
// [i_x,i_y,i_z, j_x,j_y,j_z]. g = ∂U/∂u, kt = ∂g/∂u.
export function barForceTangent(X, u, el, slack = 1e-6) {
  const st = barState(X, u, el);
  const { N, l, n, L0, taut } = st;
  const EAeff = taut ? el.EA : el.EA * slack;     // slack cable: residual stiffness
  const km = EAeff / L0;                           // material coefficient
  const kg = l > 0 ? N / l : 0;                    // geometric coefficient

  // 3×3 block  K = km·nnᵀ + kg·(I − nnᵀ)
  const K = new Float64Array(9);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
    const nn = n[a] * n[b];
    K[a * 3 + b] = km * nn + kg * ((a === b ? 1 : 0) - nn);
  }
  // kt = [[K,−K],[−K,K]]
  const kt = new Float64Array(36);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
    const v = K[a * 3 + b];
    kt[a * 6 + b] = v; kt[a * 6 + (b + 3)] = -v;
    kt[(a + 3) * 6 + b] = -v; kt[(a + 3) * 6 + (b + 3)] = v;
  }
  // g_i = −N·n , g_j = +N·n (internal force from axial N)
  const g = new Float64Array(6);
  for (let a = 0; a < 3; a++) { g[a] = -N * n[a]; g[a + 3] = N * n[a]; }
  return { g, kt, N, l, taut };
}

// ── Assembly of the global internal force and the tangent (over free DOFs) ────
// dofMap: Int32Array(3·nNode) with free index 0..nF−1 or −1 if fixed.
function assembleNL(X, u, elems, dofMap, nF, slack) {
  const Fint = new Float64Array(nF);
  const Kt = new Float64Array(nF * nF);
  const Ndata = new Array(elems.length);
  for (let e = 0; e < elems.length; e++) {
    const el = elems[e];
    const { g, kt, N, taut } = barForceTangent(X, u, el, slack);
    Ndata[e] = { N, taut };
    const gd = [3 * el.n1, 3 * el.n1 + 1, 3 * el.n1 + 2, 3 * el.n2, 3 * el.n2 + 1, 3 * el.n2 + 2];
    for (let a = 0; a < 6; a++) {
      const fa = dofMap[gd[a]]; if (fa < 0) continue;
      Fint[fa] += g[a];
      for (let b = 0; b < 6; b++) {
        const fb = dofMap[gd[b]]; if (fb < 0) continue;
        Kt[fa * nF + fb] += kt[a * 6 + b];
      }
    }
  }
  return { Fint, Kt, Ndata };
}

// ── Incremental-iterative nonlinear solver (Newton-Raphson, load control) ──
/**
 * @param {object} o
 *   X       Float64Array(3·nNode)  reference coords
 *   u0      Float64Array(3·nNode)  initial displacement (optional, def. 0)
 *   elems   [{n1,n2,EA,L0,cable}]   bar/cable elements
 *   free    Int32Array | number[]   free global DOFs (3·node+c)
 *   Fref    Float64Array(3·nNode)   external reference load (at λ=1)
 *   nSteps  number of load increments (def. 10)
 *   maxIter Newton iterations per step (def. 50)
 *   tol     relative residual tolerance (def. 1e-8)
 *   slack   residual stiffness of a slack cable (def. 1e-6)
 * @returns { converged, steps:[{lambda,u,N,iters,resid}], reactions, nF }
 */
export function solveNonlinear(o) {
  const X = o.X;
  const nNode = X.length / 3;
  const nDOF = nNode * 3;
  const elems = o.elems;
  const nSteps = o.nSteps || 10;
  const maxIter = o.maxIter || 50;
  const tol = o.tol ?? 1e-8;
  const slack = o.slack ?? 1e-6;

  const dofMap = new Int32Array(nDOF).fill(-1);
  let nF = 0;
  for (const d of o.free) dofMap[d] = nF++;

  const Fref = o.Fref || new Float64Array(nDOF);
  const FrefF = new Float64Array(nF);
  for (let d = 0; d < nDOF; d++) if (dofMap[d] >= 0) FrefF[dofMap[d]] = Fref[d];

  const u = o.u0 ? Float64Array.from(o.u0) : new Float64Array(nDOF);
  const steps = [];
  let converged = true;

  for (let s = 1; s <= nSteps; s++) {
    const lambda = s / nSteps;
    let it = 0, resid = Infinity, ok = false;
    for (; it < maxIter; it++) {
      const { Fint, Kt } = assembleNL(X, u, elems, dofMap, nF, slack);
      // residual r = λ·Fref − Fint   (over free DOFs)
      const r = new Float64Array(nF);
      let rn = 0, fn = 0;
      for (let i = 0; i < nF; i++) { r[i] = lambda * FrefF[i] - Fint[i]; rn += r[i] * r[i]; fn += (lambda * FrefF[i]) ** 2; }
      rn = Math.sqrt(rn); fn = Math.sqrt(fn) || 1;
      resid = rn / fn;
      if (resid < tol) { ok = true; break; }
      const du = solveDense(Kt, r, nF);
      if (!du) { ok = false; break; }   // singular tangent → mechanism
      for (let i = 0; i < nDOF; i++) { const fi = dofMap[i]; if (fi >= 0) u[i] += du[fi]; }
    }
    const { Ndata } = assembleNL(X, u, elems, dofMap, nF, slack);
    steps.push({ lambda, u: Float64Array.from(u), N: Ndata.map(d => d.N), taut: Ndata.map(d => d.taut), iters: it + 1, resid });
    if (!ok) { converged = false; break; }
  }

  // Reactions: at the fixed DOFs, R = Fint(fixed) − Fext(fixed)
  const { Fint: FintAll } = assembleNLfull(X, u, elems, nDOF, slack);
  const reactions = new Float64Array(nDOF);
  for (let d = 0; d < nDOF; d++) if (dofMap[d] < 0) reactions[d] = FintAll[d] - (Fref[d] || 0);

  return { converged, steps, reactions, nF, u };
}

// ── Nonlinear solver with DISPLACEMENT CONTROL (Phase 5) ───────────────────────
// Prescribes the increment of the control DOF and finds the load factor λ; traces
// the COMPLETE equilibrium path, even passing through limit points (snap-through)
// where load control fails. Augmented system [Δu; Δλ] (robust at the limit point,
// where Kt is singular but the augmented one is not).
/**
 * @param {object} o  like solveNonlinear + { controlDOF, targetDisp }
 *   controlDOF  global control DOF (3·node+c) — must be free
 *   targetDisp  target control displacement (reached in nSteps steps)
 * @returns { ok, path:[{lambda,disp,u,N}], note }
 */
export function solveNonlinearDC(o) {
  const X = o.X, nNode = X.length / 3, nDOF = nNode * 3;
  const elems = o.elems, slack = o.slack ?? 1e-6, maxIter = o.maxIter || 60, tol = o.tol ?? 1e-9;
  const nSteps = o.nSteps || 40;
  const dofMap = new Int32Array(nDOF).fill(-1); let nF = 0;
  for (const d of o.free) dofMap[d] = nF++;
  const Fref = o.Fref || new Float64Array(nDOF);
  const FrefF = new Float64Array(nF);
  for (let d = 0; d < nDOF; d++) if (dofMap[d] >= 0) FrefF[dofMap[d]] = Fref[d];
  const cF = dofMap[o.controlDOF];
  if (cF < 0) return { ok: false, path: [], note: 'El GDL de control no es libre.' };

  const dq = o.targetDisp / nSteps;
  const u = o.u0 ? Float64Array.from(o.u0) : new Float64Array(nDOF);
  let lambda = 0;
  const snap = () => ({ lambda, disp: u[o.controlDOF], u: Float64Array.from(u), N: assembleNL(X, u, elems, dofMap, nF, slack).Ndata.map(d => d.N) });
  const path = [snap()];
  const m = nF + 1;

  for (let s = 0; s < nSteps; s++) {
    let ok = false;
    for (let it = 0; it < maxIter; it++) {
      const { Fint, Kt } = assembleNL(X, u, elems, dofMap, nF, slack);
      const r = new Float64Array(nF);
      let rn = 0; for (let i = 0; i < nF; i++) { r[i] = lambda * FrefF[i] - Fint[i]; rn += r[i] * r[i]; }
      if (it > 0 && Math.sqrt(rn) < tol * (1 + Math.abs(lambda))) { ok = true; break; }
      // augmented system: [Kt  −Fref; e_c  0]·[Δu; Δλ] = [r; (it==0?dq:0)]
      const Aug = new Float64Array(m * m), rhs = new Float64Array(m);
      for (let i = 0; i < nF; i++) {
        const off = i * m, ko = i * nF;
        for (let j = 0; j < nF; j++) Aug[off + j] = Kt[ko + j];
        Aug[off + nF] = -FrefF[i]; rhs[i] = r[i];
      }
      for (let j = 0; j < nF; j++) Aug[nF * m + j] = (j === cF ? 1 : 0);
      Aug[nF * m + nF] = 0; rhs[nF] = (it === 0 ? dq : 0);
      const sol = solveDense(Aug, rhs, m);
      if (!sol) return { ok: false, path, note: 'Sistema aumentado singular (¿GDL de control inadecuado?).' };
      const dlam = sol[nF];
      lambda += dlam;
      for (let i = 0; i < nDOF; i++) { const fi = dofMap[i]; if (fi >= 0) u[i] += sol[fi]; }
    }
    path.push(snap());
    if (!ok) return { ok: false, path, note: `No convergió en el paso ${s + 1}.` };
  }
  return { ok: true, path, note: '' };
}

// Internal force at ALL DOFs (for reactions).
function assembleNLfull(X, u, elems, nDOF, slack) {
  const Fint = new Float64Array(nDOF);
  for (const el of elems) {
    const { g } = barForceTangent(X, u, el, slack);
    const gd = [3 * el.n1, 3 * el.n1 + 1, 3 * el.n1 + 2, 3 * el.n2, 3 * el.n2 + 1, 3 * el.n2 + 2];
    for (let a = 0; a < 6; a++) Fint[gd[a]] += g[a];
  }
  return { Fint };
}
