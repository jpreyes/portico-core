// ─────────────────────────────────────────────────────────────────────────────
// 2D COROTATIONAL beam — large-rotation/displacement geometric nonlinearity
// (1-029). Crisfield's formulation: the rigid-body motion (chord rotation α) is
// separated from the small LOCAL deformation (ū axial, θ̄1, θ̄2 rotations relative to
// the chord). The local forces use the linear beam stiffness in the corotated frame;
// the tangent adds the geometric terms from the frame rotation.
//
// DOF per node (X–Z plane): [u, w, θ]  (3). coords = Float64Array(2·nNode) [x,z].
// Verified against the exact elastica of a cantilever under a tip moment (circular
// arc): test_corotbeam.mjs.
// ─────────────────────────────────────────────────────────────────────────────

const TWO_PI = 2 * Math.PI;
function wrap(a) {            // → (−π, π]
  a %= TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a <= -Math.PI) a += TWO_PI;
  return a;
}

// Solves K·x = b (dense, Gauss with partial pivoting). Returns null if singular.
export function solveDense(K, b, n) {
  const A = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) A[i * (n + 1) + j] = K[i * n + j]; A[i * (n + 1) + n] = b[i]; }
  const w = n + 1;
  for (let col = 0; col < n; col++) {
    let piv = col, mx = Math.abs(A[col * w + col]);
    for (let r = col + 1; r < n; r++) { const v = Math.abs(A[r * w + col]); if (v > mx) { mx = v; piv = r; } }
    if (mx < 1e-300) return null;
    if (piv !== col) for (let j = 0; j <= n; j++) { const t = A[col * w + j]; A[col * w + j] = A[piv * w + j]; A[piv * w + j] = t; }
    const d = A[col * w + col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r * w + col] / d;
      if (f === 0) continue;
      for (let j = col; j <= n; j++) A[r * w + j] -= f * A[col * w + j];
    }
  }
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = A[i * w + n] / A[i * w + i];
  return x;
}

// Original chord angle of each element (cached in el.beta0).
export function corotPrep(coords, elems) {
  for (const el of elems) {
    const i = el.n1, j = el.n2;
    const dx = coords[2*j] - coords[2*i], dz = coords[2*j+1] - coords[2*i+1];
    el.L0 = Math.hypot(dx, dz);
    el.beta0 = Math.atan2(dz, dx);
  }
}

// Global internal force (6) and tangent (6×6) of the corotational element, in order
// [u1,w1,θ1, u2,w2,θ2]. Requires el.{EA, EI, L0, beta0}.
export function corotBeamForceTangent(coords, u, el) {
  const i = el.n1, j = el.n2;
  const x1 = coords[2*i]   + u[3*i],   z1 = coords[2*i+1] + u[3*i+1], t1 = u[3*i+2];
  const x2 = coords[2*j]   + u[3*j],   z2 = coords[2*j+1] + u[3*j+1], t2 = u[3*j+2];
  const dx = x2 - x1, dz = z2 - z1;
  const ln = Math.hypot(dx, dz) || 1e-300;
  const c = dx / ln, s = dz / ln;
  const beta = Math.atan2(dz, dx);
  const alpha = wrap(beta - el.beta0);            // rigid chord rotation

  // Local deformations
  const ubar = ln - el.L0;
  const tb1 = wrap(t1 - alpha), tb2 = wrap(t2 - alpha);

  // Local forces (linear beam in the corotated frame)
  const ka = el.EA / el.L0, kb = el.EI / el.L0;
  const N  = ka * ubar;
  const M1 = kb * (4 * tb1 + 2 * tb2);
  const M2 = kb * (2 * tb1 + 4 * tb2);

  // Kinematic vectors (6): a = ∂ln/∂d , z = ln·∂β/∂d
  const a = [-c, -s, 0,  c,  s, 0];
  const z = [ s, -c, 0, -s,  c, 0];
  const e3 = [0,0,1,0,0,0], e6 = [0,0,0,0,0,1];
  // Rows of B (3×6): B0=a ; B1=e3 − z/ln ; B2=e6 − z/ln
  const B0 = a;
  const B1 = e3.map((v, k) => v - z[k] / ln);
  const B2 = e6.map((v, k) => v - z[k] / ln);

  // Global internal force  fint = N·B0 + M1·B1 + M2·B2
  const fint = new Float64Array(6);
  for (let k = 0; k < 6; k++) fint[k] = N * B0[k] + M1 * B1[k] + M2 * B2[k];

  // Material tangent  Bᵀ·Cl·B  with Cl = [[ka,0,0],[0,4kb,2kb],[0,2kb,4kb]]
  const Cl = [[ka, 0, 0], [0, 4*kb, 2*kb], [0, 2*kb, 4*kb]];
  const Brows = [B0, B1, B2];
  const Kt = new Float64Array(36);
  for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) {
    const cpq = Cl[p][q]; if (!cpq) continue;
    const Bp = Brows[p], Bq = Brows[q];
    for (let r = 0; r < 6; r++) { const br = cpq * Bp[r]; if (!br) continue; for (let col = 0; col < 6; col++) Kt[r*6+col] += br * Bq[col]; }
  }
  // Geometric tangent  (N/ln)·z zᵀ + ((M1+M2)/ln²)·(a zᵀ + z aᵀ)
  const g1 = N / ln, g2 = (M1 + M2) / (ln * ln);
  for (let r = 0; r < 6; r++) for (let col = 0; col < 6; col++) {
    Kt[r*6+col] += g1 * z[r] * z[col] + g2 * (a[r] * z[col] + z[r] * a[col]);
  }
  return { fint, Kt, N, M1, M2, alpha };
}

// ── Incremental-iterative solver (Newton-Raphson, load control) ───────────────
/**
 * @param {object} o
 *   coords  Float64Array(2·nNode)   reference coords [x,z]
 *   elems   [{n1,n2,EA,EI}]         (L0/beta0 computed in corotPrep)
 *   free    number[]|Int32Array     free global DOFs (3·node + {0:u,1:w,2:θ})
 *   Fref    Float64Array(3·nNode)   external reference load (at λ=1)
 *   nSteps  number of increments (def. 20)  ·  maxIter (def. 60)  ·  tol (def. 1e-9)
 * @returns { converged, steps:[{lambda,u,iters,resid}], nF }
 */
export function solveCorotBeam(o) {
  const coords = o.coords;
  const nNode = coords.length / 2;
  const nDOF = nNode * 3;
  const elems = o.elems;
  corotPrep(coords, elems);
  const nSteps = o.nSteps || 20, maxIter = o.maxIter || 60, tol = o.tol ?? 1e-9;

  const dofMap = new Int32Array(nDOF).fill(-1);
  let nF = 0;
  for (const d of o.free) dofMap[d] = nF++;
  const Fref = o.Fref || new Float64Array(nDOF);
  const FrefF = new Float64Array(nF);
  for (let d = 0; d < nDOF; d++) if (dofMap[d] >= 0) FrefF[dofMap[d]] = Fref[d];

  const u = o.u0 ? Float64Array.from(o.u0) : new Float64Array(nDOF);
  const steps = [];
  let converged = true;

  for (let st = 1; st <= nSteps; st++) {
    const lambda = st / nSteps;
    let it = 0, resid = Infinity, ok = false;
    for (; it < maxIter; it++) {
      // Assemble Fint and Kt over the free DOFs
      const Fint = new Float64Array(nF), Kt = new Float64Array(nF * nF);
      for (const el of elems) {
        const { fint, Kt: ke } = corotBeamForceTangent(coords, u, el);
        const gd = [3*el.n1, 3*el.n1+1, 3*el.n1+2, 3*el.n2, 3*el.n2+1, 3*el.n2+2];
        for (let aa = 0; aa < 6; aa++) {
          const fa = dofMap[gd[aa]]; if (fa < 0) continue;
          Fint[fa] += fint[aa];
          for (let bb = 0; bb < 6; bb++) { const fb = dofMap[gd[bb]]; if (fb < 0) continue; Kt[fa*nF+fb] += ke[aa*6+bb]; }
        }
      }
      const r = new Float64Array(nF);
      let rn = 0, fn = 0;
      for (let k = 0; k < nF; k++) { r[k] = lambda * FrefF[k] - Fint[k]; rn += r[k]*r[k]; fn += (lambda*FrefF[k])**2; }
      rn = Math.sqrt(rn); fn = Math.sqrt(fn) || 1;
      resid = rn / fn;
      if (resid < tol) { ok = true; break; }
      const du = solveDense(Kt, r, nF);
      if (!du) { ok = false; break; }
      for (let d = 0; d < nDOF; d++) { const f = dofMap[d]; if (f >= 0) u[d] += du[f]; }
    }
    steps.push({ lambda, u: Float64Array.from(u), iters: it + 1, resid });
    if (!ok) { converged = false; break; }
  }
  return { converged, steps, nF, u };
}
