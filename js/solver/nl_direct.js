// ──────────────────────────────────────────────────────────────────────────────
// nl_direct.js — NONLINEAR direct time integration (Newmark-β + Newton-Raphson) of
// a planar corotational frame. The dynamic capstone of the geometric-nonlinear path:
// it integrates the FULL physical system while re-forming the resisting force and the
// consistent tangent at every iteration, so LARGE displacements/rotations are carried
// through the time history (not just a linearized-about-the-origin response).
//
//     M·ü + C·u̇ + F_int(u) = p(t) = −M·ι·a_g(t)        (uniform base excitation)
//
// Unlike newmarkLinear (linear F_int = K·u, K_eff factored ONCE), here F_int(u) is the
// corotational internal force and the tangent K_t(u) = K_material + K_geometric changes
// every step, so each Newton iteration factors a fresh K_eff = K_t + a1·M + b1·C. The
// element force/tangent come from corotBeamForceTangent (rigid end zones included, #87),
// the exact same kernel the static corot solver (solveCorotBeam) and P-Δ trust — this
// is its dynamic sibling.
//
// PLANAR X–Z, 3 DOF/node [u=ux, w=uz, θ=ry]. Mass is LUMPED (diagonal): the physical
// translational mass ρ·A·L split half to each end, rotational inertia zero (standard;
// the massless rotational DOFs are condensed implicitly by K_eff, which stays regular
// because K_t carries rotational stiffness). Damping is Rayleigh C = a0·M + a1·K0 built
// once from the initial tangent K0.
//
// SELF-CONTAINED: CSR matrices + the repo's own kernels (no DOM). Verified in Node
// (test_nl_direct.mjs): (1) the linear-limit response matches newmarkLinear with the
// SAME lumped M and K0; (2) a slow load ramp converges to the static corot solution
// (geometric softening/stiffening captured dynamically); (3) undamped free vibration
// conserves energy (average-acceleration Newmark); (4) Rayleigh damping decays it.
// ──────────────────────────────────────────────────────────────────────────────
import { corotBeamForceTangent, corotPrep } from './corotbeam.js?v=7';
import { SparseSym, extractFreeCSR } from './sparse.js?v=7';
import { makeFactorCSR, permRCMcsr, csrMv, csrLinComb } from './linsolve.js?v=7';
import { buildCorotProblem } from './nl_frame.js?v=7';
import { rayleigh } from './direct_integration.js?v=7';

// Diagonal CSR from a per-DOF vector (the lumped mass). Zero entries are kept so the
// row structure is complete for csrLinComb (a zero rotational mass is legitimate).
function diagCSR(d) {
  const n = d.length;
  const rowPtr = new Int32Array(n + 1), colIdx = new Int32Array(n), val = new Float64Array(n);
  for (let i = 0; i < n; i++) { rowPtr[i] = i; colIdx[i] = i; val[i] = d[i]; }
  rowPtr[n] = n;
  return { n, rowPtr, colIdx, val };
}

// Assemble the corotational resisting force F_int(nF) and tangent K_t (CSR, nF×nF) over
// the free DOFs at the current full displacement `u` (3·nNode). Reuses the validated
// per-element kernel; the tangent is symmetric (material Bᵀ·Cl·B + geometric).
function assembleCorotFree(coords, u, elems, dofMap, nF, idMap) {
  const S = new SparseSym(nF);
  const Fint = new Float64Array(nF);
  for (const el of elems) {
    const { fint, Kt } = corotBeamForceTangent(coords, u, el);
    const gd = [3 * el.n1, 3 * el.n1 + 1, 3 * el.n1 + 2, 3 * el.n2, 3 * el.n2 + 1, 3 * el.n2 + 2];
    for (let a = 0; a < 6; a++) {
      const fa = dofMap[gd[a]]; if (fa < 0) continue;
      Fint[fa] += fint[a];
      for (let b = 0; b < 6; b++) { const fb = dofMap[gd[b]]; if (fb < 0) continue; S.add(fa, fb, Kt[a * 6 + b]); }
    }
  }
  return { Fint, csr: extractFreeCSR(S, idMap, nF).csr };
}

const norm2 = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s); };

// ── Newmark-β + Newton-Raphson core ───────────────────────────────────────────
/**
 * @param {object} o
 *   coords  Float64Array(2·nNode)   reference (x,z) of the plane.
 *   elems   [{n1,n2,EA,EI,oi,oj}]   corotational elements (L0/beta0 set here).
 *   free    number[]                free global DOFs (3·node + {0:u,1:w,2:θ}).
 *   Mlump   Float64Array(3·nNode)   lumped mass per global DOF (diagonal).
 *   ag      Float64Array            base accelerogram a_g(t) at Δt (m/s²).
 *   dt      number                  time step (s).
 *   iota    Float64Array(nF)        influence vector on the free DOFs (1 in the
 *                                   excited translational DOF of each node).
 *   a0,a1   numbers                 Rayleigh coefficients (C = a0·M + a1·K0). Default 0.
 *   gamma,beta  Newmark params (default ½, ¼ — average acceleration, unconditionally stable).
 *   u0,v0   Float64Array(3·nNode)   initial displacement/velocity (default rest).
 *   maxIter number                  Newton iterations per step (default 30).
 *   tol     number                  relative residual tolerance (default 1e-8).
 *   record  number[]                free DOF indices whose full history to keep.
 *   keepAll boolean                 store the whole nSteps×nF displacement field.
 * @returns {object}
 *   t, nSteps, n(=nF), peak(nF), hist Map<freeIdx,Float64Array>,
 *   U (nSteps×nF, free) if keepAll · uAt(step) → subarray ·
 *   avgNewton, maxNewton, notConverged (count of steps that hit maxIter), ok.
 */
export function newmarkCorot(o) {
  const { coords, elems, ag, dt } = o;
  const nNode = coords.length / 2, nDOF = 3 * nNode;
  // HHT-α time integration (Hilber–Hughes–Taylor). α = 0 recovers the average-acceleration
  // Newmark (no numerical dissipation — used for the linear cross-check). A small α < 0
  // (default −0.05) adds high-frequency dissipation, which is what stabilizes the NONLINEAR
  // response: the average-acceleration rule is only stable for *linear* systems, and the
  // massless rotational DOFs inject infinite-frequency content that the undamped scheme
  // cannot control. With α set, γ and β follow the second-order-accurate, unconditionally
  // stable choice γ = (1−2α)/2, β = (1−α)²/4 unless overridden.
  const alpha = Math.max(-1 / 3, Math.min(0, o.alpha ?? -0.05));
  const gamma = o.gamma ?? (1 - 2 * alpha) / 2, beta = o.beta ?? (1 - alpha) ** 2 / 4;
  const nSteps = ag.length;
  const maxIter = o.maxIter ?? 30, tol = o.tol ?? 1e-6;
  corotPrep(coords, elems);

  // Free-DOF map and reduced constant data
  const dofMap = new Int32Array(nDOF).fill(-1);
  const freeList = Array.from(o.free);
  let nF = 0; for (const d of freeList) dofMap[d] = nF++;
  const idMap = new Int32Array(nF); for (let i = 0; i < nF; i++) idMap[i] = i;

  const Mfree = new Float64Array(nF);
  for (let i = 0; i < nF; i++) Mfree[i] = o.Mlump[freeList[i]];
  const Mcsr = diagCSR(Mfree);
  const iota = o.iota;
  const Miota = new Float64Array(nF);
  for (let i = 0; i < nF; i++) Miota[i] = Mfree[i] * iota[i];   // p = −a_g·(M·ι)

  // Newmark integration constants (Chopra Table 5.4.2)
  const a1c = 1 / (beta * dt * dt), a2c = 1 / (beta * dt), a3c = 1 / (2 * beta) - 1;
  const b1c = gamma / (beta * dt), b2c = gamma / beta - 1, b3c = dt * (gamma / (2 * beta) - 1);

  // State (u full 3·nNode so the corot kernel can read every end; v,a on free DOFs).
  const u = o.u0 ? Float64Array.from(o.u0) : new Float64Array(nDOF);
  const uk = Float64Array.from(u);
  const vF = new Float64Array(nF), aF = new Float64Array(nF);
  if (o.v0) for (let i = 0; i < nF; i++) vF[i] = o.v0[freeList[i]];

  // Initial tangent K0 (at u0) → Rayleigh C = a0·M + a1·K0 (built once).
  const { Fint: Fint0, csr: K0 } = assembleCorotFree(coords, u, elems, dofMap, nF, idMap);
  const a0 = o.a0 ?? 0, a1 = o.a1 ?? 0;
  const Ccsr = csrLinComb(Mcsr, a0, K0, a1);

  // a₀ from M·a₀ = p₀ − C·v₀ − F_int(u₀). Diagonal M → per-DOF divide; zero-mass
  // (rotational) DOFs get 0 (their inertia never enters M·a).
  {
    const Cv = new Float64Array(nF); csrMv(Ccsr, vF, Cv);
    for (let i = 0; i < nF; i++) {
      const rhs = -Miota[i] * ag[0] - Cv[i] - Fint0[i];
      aF[i] = Mfree[i] > 0 ? rhs / Mfree[i] : 0;
    }
  }

  // Characteristic force for the convergence floor: the largest of the initial
  // internal force, the peak base shear, and a tiny guard. It gives the residual test
  // an absolute floor (absFloor) so a step whose predictor is already balanced (r0 ≈ 0)
  // converges at once instead of chasing round-off — scale-free across the whole record.
  let normMiota = 0; for (let i = 0; i < nF; i++) normMiota += Miota[i] * Miota[i]; normMiota = Math.sqrt(normMiota);
  let maxAg = 0; for (let k = 0; k < nSteps; k++) { const a = Math.abs(ag[k]); if (a > maxAg) maxAg = a; }
  const Fchar = Math.max(norm2(Fint0), normMiota * maxAg, 1e-30);
  const absFloor = 1e-9 * Fchar;

  // Outputs
  const t = new Float64Array(nSteps);
  const peak = new Float64Array(nF);
  const recDofs = o.record || [];
  const hist = new Map(recDofs.map(d => [d, new Float64Array(nSteps)]));
  const keepAll = !!o.keepAll;
  const U = keepAll ? new Float64Array(nSteps * nF) : null;
  const store = (k) => {
    t[k] = k * dt;
    for (let i = 0; i < nF; i++) { const av = Math.abs(u[freeList[i]]); if (av > peak[i]) peak[i] = av; }
    for (const d of recDofs) hist.get(d)[k] = u[freeList[d]];
    if (keepAll) for (let i = 0; i < nF; i++) U[k * nF + i] = u[freeList[i]];
  };
  store(0);

  // Reusable buffers
  const du = new Float64Array(nF), aN = new Float64Array(nF), vN = new Float64Array(nF);
  const Minert = new Float64Array(nF), Cdamp = new Float64Array(nF), R = new Float64Array(nF), δ = new Float64Array(nF);

  let newtonSum = 0, newtonMax = 0, notConverged = 0, ok = true;

  const opa = 1 + alpha;                         // (1+α) weight on the "new" terms
  const CvkArr = new Float64Array(nF);           // C·v_n (constant during a step)
  for (let k = 0; k < nSteps - 1; k++) {
    // "Old"-state contributions (evaluated at u_n, v_n): p_n, F_int(u_n), C·v_n. HHT-α
    // blends them with the new state by −α : opa.
    const p0 = -ag[k], p1 = -ag[k + 1];
    csrMv(Ccsr, vF, CvkArr);
    let it = 0, converged = false, fac = null, Fint = null, Kt = null, Fintk = null, r0 = 0;
    for (; it < maxIter; it++) {
      ({ Fint, csr: Kt } = assembleCorotFree(coords, u, elems, dofMap, nF, idMap));
      if (it === 0) Fintk = Fint;                // F_int(u_n): first iterate has u = u_n
      // Newmark kinematics from du = u − u_n
      for (let i = 0; i < nF; i++) {
        du[i] = u[freeList[i]] - uk[freeList[i]];
        aN[i] = a1c * du[i] - a2c * vF[i] - a3c * aF[i];
        vN[i] = b1c * du[i] - b2c * vF[i] + b3c * aF[i];
      }
      csrMv(Mcsr, aN, Minert);
      csrMv(Ccsr, vN, Cdamp);
      // HHT-α residual  R = (1+α)p₁ − α·p₀ − M·a − (1+α)(C·v + F_int) + α(C·v_n + F_int_n)
      for (let i = 0; i < nF; i++)
        R[i] = (opa * p1 - alpha * p0) * Miota[i] - Minert[i]
             - opa * (Cdamp[i] + Fint[i]) + alpha * (CvkArr[i] + Fintk[i]);
      const rn = norm2(R);
      if (it === 0) r0 = rn;
      // Convergence relative to the magnitude of the forces being balanced (inertia +
      // internal). Those large terms cancel to ~1e-7 of themselves in double precision,
      // so scaling the tolerance by them — rather than by r0, which can itself sit near
      // that floor at velocity peaks — makes 1e-6 both achievable and consistent across
      // the whole record. absFloor catches an already-balanced predictor (r0 ≈ 0).
      const refScale = Math.max(r0, norm2(Minert) + norm2(Fint), Fchar);
      if (rn <= tol * refScale || rn <= absFloor) { converged = true; break; }

      // K_eff = a1c·M + (1+α)(K_t + b1c·C)  → factor and solve K_eff·δ = R
      const Keff = csrLinComb(Mcsr, a1c, csrLinComb(Kt, 1, Ccsr, b1c), opa);
      fac = makeFactorCSR(Keff, permRCMcsr(Keff));
      if (!fac.ok) { ok = false; break; }
      fac.solve(R, δ);
      for (let i = 0; i < nF; i++) u[freeList[i]] += δ[i];
    }
    if (!ok) break;
    if (!converged) notConverged++;
    newtonSum += it + 1; if (it + 1 > newtonMax) newtonMax = it + 1;

    // Commit Newmark state for the converged u_{k+1}
    for (let i = 0; i < nF; i++) {
      du[i] = u[freeList[i]] - uk[freeList[i]];
      const an = a1c * du[i] - a2c * vF[i] - a3c * aF[i];
      const vn = b1c * du[i] - b2c * vF[i] + b3c * aF[i];
      vF[i] = vn; aF[i] = an;
    }
    for (const d of freeList) uk[d] = u[d];
    store(k + 1);
  }

  return {
    t, nSteps, n: nF, peak, hist,
    avgNewton: newtonSum / Math.max(1, nSteps - 1), maxNewton: newtonMax,
    notConverged, ok,
    U: keepAll ? U : undefined,
    uAt: keepAll ? (s) => U.subarray(s * nF, s * nF + nF) : undefined,
  };
}

// ── Model-level driver ─────────────────────────────────────────────────────────
/**
 * Full-model nonlinear direct time-history from a Model, planar corotational, with
 * uniform base excitation. Builds the reduced corot problem (buildCorotProblem), lumps
 * the mass, forms Rayleigh damping and integrates with newmarkCorot.
 *
 * @param {Model} model
 * @param {object} o
 *   ag        Float64Array   base accelerogram (m/s²) at Δt.
 *   dt        number         time step (s).
 *   direction 'X'|'Z'        in-plane excitation direction (default 'X').
 *   zeta      number         target damping ratio (default 0.05).
 *   rayleighFreqs [w1,w2]    circular frequencies anchoring Rayleigh ζ (from a modal solve).
 *   a0,a1     numbers        explicit Rayleigh coefficients (override rayleighFreqs).
 *   record    [{node,dof}]   node id + planar dof (0=ux,1=uz,2=ry) histories to keep.
 *   alpha     number         HHT-α numerical dissipation (default −0.05; 0 = none).
 *   maxIter, tol, keepAll, gamma, beta   forwarded to newmarkCorot.
 * @returns {{ok:false, reason}} on an empty/ill-posed model, else the newmarkCorot
 *   result plus: nodeIds, idxOf, freeMap, nF,
 *   histAt(node,dof) → Float64Array|null,  peakNodal(node) → [ux,uz,ry].
 */
export function nlDirectTimeHistory(model, o = {}) {
  const P = buildCorotProblem(model);
  if (!P.ok) return { ok: false, reason: P.reason };
  const { coords, elems, free, idxOf, nodeIds } = P;
  const nNode = nodeIds.length, nDOF = 3 * nNode;

  // Lumped mass per global planar DOF: ρ·A·L split half to each end (u,w); rotational 0.
  const Mlump = new Float64Array(nDOF);
  for (const el of model.elements.values()) {
    const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
    const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
    if (!n1 || !n2 || !mat || !sec) continue;
    const L = Math.hypot(n2.x - n1.x, n2.z - n1.z);   // in-plane length
    const half = (mat.rho || 0) * sec.A * L / 2;
    const i = idxOf.get(el.n1), j = idxOf.get(el.n2);
    Mlump[3 * i] += half; Mlump[3 * i + 1] += half;
    Mlump[3 * j] += half; Mlump[3 * j + 1] += half;
  }
  for (const nd of model.nodes.values()) {                // nodal point masses (planar)
    const nm = nd.nodeMass; if (!nm) continue;
    const i = idxOf.get(nd.id);
    Mlump[3 * i]     += nm.mx  || 0;   // ux
    Mlump[3 * i + 1] += nm.mz  || 0;   // uz
    Mlump[3 * i + 2] += nm.iry || 0;   // ry
  }

  // Free-DOF map + influence vector on the free DOFs
  const dofMap = new Int32Array(nDOF).fill(-1);
  let nF = 0; for (const d of free) dofMap[d] = nF++;
  let totalMass = 0; for (const d of free) totalMass += Mlump[d];
  if (totalMass <= 0) return { ok: false, reason: 'no-mass' };

  const dir = (o.direction || 'X').toUpperCase();
  const dirLocal = dir === 'Z' ? 1 : 0;                    // 0=ux, 1=uz
  const iota = new Float64Array(nF);
  for (const d of free) if (d % 3 === dirLocal) iota[dofMap[d]] = 1;

  // Damping: explicit a0/a1, else Rayleigh from the two anchor frequencies.
  let a0 = o.a0, a1 = o.a1;
  if (a0 == null || a1 == null) {
    const [w1, w2] = o.rayleighFreqs || [];
    if (!(w1 > 0) || !(w2 > 0)) return { ok: false, reason: 'no-damping' };
    ({ a0, a1 } = rayleigh(o.zeta ?? 0.05, w1, w2));
  }

  const recPairs = (o.record || []).map(({ node, dof }) => ({ node, dof, gi: dofMap[3 * idxOf.get(node) + dof] }))
                                    .filter(p => p.gi >= 0);
  const res = newmarkCorot({
    coords, elems, free, Mlump, ag: o.ag, dt: o.dt, iota, a0, a1,
    record: recPairs.map(p => p.gi), keepAll: o.keepAll,
    maxIter: o.maxIter, tol: o.tol, gamma: o.gamma, beta: o.beta, alpha: o.alpha,
  });

  const recKey = new Map(recPairs.map(p => [`${p.node}:${p.dof}`, p.gi]));
  return {
    ...res, ok: true, nodeIds, idxOf, freeMap: dofMap, nF,
    histAt(node, dof) { const gi = recKey.get(`${node}:${dof}`); return gi != null && res.hist ? res.hist.get(gi) : null; },
    peakNodal(node) {
      const out = new Float64Array(3), b = 3 * idxOf.get(node);
      for (let d = 0; d < 3; d++) { const gi = dofMap[b + d]; out[d] = gi >= 0 ? res.peak[gi] : 0; }
      return out;
    },
  };
}
