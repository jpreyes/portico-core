// ──────────────────────────────────────────────────────────────────────────────
// Results — post-processing: displacements, internal forces, reactions.
//
// Internal forces are computed by equilibrium integration:
//   V(x) = V(0) - ∫₀ˣ q(t) dt
//   M(x) = M(0) + ∫₀ˣ V(t) dt
// For UDL this reduces to the exact parabolic formula.
// Displacements at arbitrary xi use cubic Hermite shape functions.
// ──────────────────────────────────────────────────────────────────────────────
import { localAxes, stiffnessMatrix, transformMatrix, fixedEndForces, applyReleases, condenseFEF, recoverReleasedDisp, elemLocalK } from './timoshenko.js?v=5';
import { getNodeDOFs, selfWeightPerLength } from './assembler.js?v=5';
import { areaStress, areaBendingStress, areaStrain, areaCurvature, vonMises } from './membrane.js?v=5';

function _toLocalLoad(load, ex, ey, ez) {
  const w   = load.w;
  const w2  = (load.w2 == null) ? w : load.w2;   // trapezoidal: intensity at end j
  const dir = load.dir || 'gravity';
  if (dir === 'localY') return [{ d: 'y', w, w2 }];
  if (dir === 'localZ') return [{ d: 'z', w, w2 }];
  if (dir === 'localX') return [{ d: 'x', w, w2 }];
  const g = dir === 'globalX' ? [1,0,0]
          : dir === 'globalY' ? [0,1,0]
          : [0,0,-1];   // 'gravity' and legacy 'globalZ' both mean downward (positive w = ↓)
  const px = g[0]*ex[0] + g[1]*ex[1] + g[2]*ex[2];
  const py = g[0]*ey[0] + g[1]*ey[1] + g[2]*ey[2];
  const pz = g[0]*ez[0] + g[1]*ez[1] + g[2]*ez[2];
  const res = [];
  if (Math.abs(w*px) > 1e-14 || Math.abs(w2*px) > 1e-14) res.push({ d: 'x', w: w*px, w2: w2*px });
  if (Math.abs(w*py) > 1e-14 || Math.abs(w2*py) > 1e-14) res.push({ d: 'y', w: w*py, w2: w2*py });
  if (Math.abs(w*pz) > 1e-14 || Math.abs(w2*pz) > 1e-14) res.push({ d: 'z', w: w*pz, w2: w2*pz });
  return res;
}

// ──────────────────────────────────────────────────────────────────────────────
// REUSABLE POST-PROCESSING (solver-agnostic) — pure functions.
//
// The diagram/deflected-shape math lives ONCE here. The `Results` class delegates
// to it, so anything holding end forces + loads obtains IDENTICAL diagrams by
// calling these functions, without reimplementing anything.
// See docs/EXTENDING.md (§ "Reusable post-processing").
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Distributed load intensities of the element in the LOCAL FRAME, at both ends
 * (trapezoidal; uniform → q1==q2). This is the source-of-truth for M(x)/V(x): q is
 * never inferred from the end forces. `qy/qz` (end i) are kept for backward
 * compatibility (geometric stiffness, etc.).
 * @returns {{qy:number, qz:number, qy1:number, qy2:number, qz1:number, qz2:number}}
 */
export function actualLoadsLocal(model, lcId, selfWeight, elem, ex, ey, ez) {
  let qy1 = 0, qy2 = 0, qz1 = 0, qz2 = 0;
  const add = (load) => {
    for (const { d, w, w2 } of _toLocalLoad(load, ex, ey, ez)) {
      if (d === 'y')      { qy1 += w; qy2 += (w2 == null ? w : w2); }
      else if (d === 'z') { qz1 += w; qz2 += (w2 == null ? w : w2); }
    }
  };
  const lc = lcId ? model.loadCases.get(lcId) : null;
  if (lc) {
    for (const load of lc.loads) {
      if (load.type !== 'dist' || load.elemId !== elem.id) continue;
      add(load);
    }
  }
  if (selfWeight) {
    const mat = model.materials.get(elem.matId);
    const sec = model.sections.get(elem.secId);
    if (mat && sec && mat.rho > 0) add({ w: selfWeightPerLength(mat, sec), dir: 'gravity' });
  }
  return { qy: qy1, qz: qz1, qy1, qy2, qz1, qz2 };
}

/**
 * N/V/M(x) diagram by equilibrium integration (exact for uniform and trapezoidal
 * loads). PURE function: independent of the solver, only of the end forces.
 * @param {object} f   RICH end-force object (see Results.getElemForces):
 *   N, Vy1, Vz1, T, My1, Mz1, Vy2, Vz2, My2, Mz2, L, qy/qz, qy1/qy2/qz1/qz2, …
 * @param {object} n1  node i (to interpolate the position of the points)
 * @param {object} n2  node j
 * @param {string} type  'N' | 'Vy' | 'Vz' | 'T' | 'My' | 'Mz'
 * @param {number} nPts  sample points (min. 20)
 * @returns {{pts:Array, extremes:Array, maxVal:number, minVal:number}}
 */
export function diagramFromForces(f, n1, n2, type, nPts = 20) {
  if (!f) return { pts: [], extremes: [], maxVal: 0, minVal: 0 };
  const L = f.L;

  const val1 = type === 'N'  ? f.N
             : type === 'Vy' ? f.Vy1
             : type === 'Vz' ? f.Vz1
             : type === 'T'  ? f.T
             : type === 'My' ? f.My1
             :                  f.Mz1;

  const val2 = type === 'N'  ? f.N
             : type === 'Vy' ? f.Vy2
             : type === 'Vz' ? f.Vz2
             : type === 'T'  ? f.T
             : type === 'My' ? -f.My2
             :                  -f.Mz2;

  const isMz = type === 'Mz';
  const isMy = type === 'My';
  const isVy = type === 'Vy';
  const isVz = type === 'Vz';
  const isMoment = isMz || isMy;
  const isShear  = isVy || isVz;

  // Use ACTUAL distributed load from element forces (not inferred from end shears).
  // Inferred q = (V1+V2)/L is wrong when nodal forces co-exist with dist. loads.
  // Trapezoidal: q(x) = q1 + (q2−q1)·x/L  (q1 at node i, q2 at node j).
  const q1 = (isMz || isVy) ? (f.qy1 ?? f.qy ?? 0) : (isMy || isVz) ? (f.qz1 ?? f.qz ?? 0) : 0;
  const q2 = (isMz || isVy) ? (f.qy2 ?? f.qy ?? 0) : (isMy || isVz) ? (f.qz2 ?? f.qz ?? 0) : 0;
  const dq = q2 - q1;                      // pendiente · L
  const V1 = isMz ? f.Vy1 : isMy ? f.Vz1 : isVy ? f.Vy1 : isVz ? f.Vz1 : 0;

  const N   = Math.max(nPts, 20);
  const pts = [];
  let maxVal = -Infinity, minVal = Infinity;

  for (let i = 0; i <= N; i++) {
    const xi  = i / N;
    const x   = xi * L;
    let v;
    if (isMoment) {
      // M(x) = M₀ − V₀·x − ½q₁x² − (Δq)x³/(6L)    (FEM sign: M' = −V)
      v = val1 - V1*x - 0.5*q1*x*x - dq*x*x*x/(6*L);
    } else if (isShear) {
      // V(x) = V₀ + q₁·x + (Δq)x²/(2L)
      v = V1 + q1*x + dq*x*x/(2*L);
    } else {
      v = val1*(1 - xi) + val2*xi;    // linear (axial, torsion)
    }
    const pos = {
      x: n1.x + xi*(n2.x-n1.x),
      y: n1.y + xi*(n2.y-n1.y),
      z: n1.z + xi*(n2.z-n1.z),
    };
    if (v > maxVal) maxVal = v;
    if (v < minVal) minVal = v;
    pts.push({ pos, val: v });
  }

  // Inner extreme for moments: x* where V(x*)=0.
  //   uniform: V1 + q1·x = 0 → x* = −V1/q1
  //   trapezoidal: (Δq/2L)x² + q1·x + V1 = 0  (quadratic)
  const Mx = (xS) => val1 - V1*xS - 0.5*q1*xS*xS - dq*xS*xS*xS/(6*L);
  const extremes = [];
  const roots = [];
  if (isMoment) {
    const aa = dq/(2*L), bb = q1, cc = V1;
    if (Math.abs(aa) < 1e-12) {                 // uniform / no slope
      if (Math.abs(bb) > 1e-12) roots.push(-cc/bb);
    } else {
      const disc = bb*bb - 4*aa*cc;
      if (disc >= 0) { const sd = Math.sqrt(disc); roots.push((-bb+sd)/(2*aa), (-bb-sd)/(2*aa)); }
    }
  }
  for (const xS of roots) {
    if (xS > L*1e-4 && xS < L*(1 - 1e-4)) {
      const xi  = xS / L;
      const vE  = Mx(xS);
      const pos = {
        x: n1.x + xi*(n2.x-n1.x),
        y: n1.y + xi*(n2.y-n1.y),
        z: n1.z + xi*(n2.z-n1.z),
      };
      extremes.push({ pos, val: vE, xi });
      if (vE > maxVal) maxVal = vE;
      if (vE < minVal) minVal = vE;
    }
  }

  return { pts, extremes, maxVal, minVal };
}

/**
 * Forces + interpolated displacement at xi ∈ [0,1]. PURE function.
 * Forces by equilibrium integration (exact for UDL); displacements by cubic Hermite
 * + distributed-load bubble (exact for a Bernoulli beam).
 * @param {object} f   rich end-force object (incl. `_ue`, `ex/ey/ez`, `EIz/EIy`)
 * @returns {{N,Vy,Vz,T,My,Mz,ux,uy,uz:number}|null}
 */
export function elemAtXiFromForces(f, xi) {
  if (!f) return null;

  const L   = f.L;
  const x   = xi * L;

  // ── Forces by equilibrium (use stored actual loads, not inferred from ends) ──
  // Trapezoidal q(x) = q1 + (Δq)·x/L.
  const qy1 = f.qy1 ?? f.qy ?? 0, qy2 = f.qy2 ?? f.qy ?? 0, dqy = qy2 - qy1;
  const qz1 = f.qz1 ?? f.qz ?? 0, qz2 = f.qz2 ?? f.qz ?? 0, dqz = qz2 - qz1;
  // Deflection bubble: the exact particular solution is for UDL; for trapezoidal
  // we use the average q (2nd-order approx., only affects the curve drawn between
  // nodes — the nodes and the forces are exact).
  const qy  = 0.5*(qy1+qy2), qz = 0.5*(qz1+qz2);

  const N_val  = f.N;
  const T_val  = f.T;
  const Vy_val = f.Vy1 + qy1*x + dqy*x*x/(2*L);                       // V(x)
  const Vz_val = f.Vz1 + qz1*x + dqz*x*x/(2*L);
  const Mz_val = f.Mz1 - f.Vy1*x - 0.5*qy1*x*x - dqy*x*x*x/(6*L);     // M(x)
  const My_val = f.My1 - f.Vz1*x - 0.5*qz1*x*x - dqz*x*x*x/(6*L);

  // ── Displacements by Hermite interpolation ────────────────────────────
  const ue = f._ue;   // local DOFs stored by _computeElemForces
  let ux = 0, uy = 0, uz = 0;

  if (ue) {
    const t  = xi;
    const H1 = 1 - 3*t*t + 2*t*t*t;
    const H2 = t - 2*t*t + t*t*t;     // multiplied by L below
    const H3 = 3*t*t - 2*t*t*t;
    const H4 = -t*t + t*t*t;           // multiplied by L below

    // Local displacements
    const ux_l = ue[0]*(1-t) + ue[6]*t;
    let uy_l = H1*ue[1] + H2*L*ue[5] + H3*ue[7] + H4*L*ue[11];
    let uz_l = H1*ue[2] - H2*L*ue[4] + H3*ue[8] - H4*L*ue[10];

    // Particular solution for the distributed load (UDL): exact bubble
    //   w_p(ξ) = q·L⁴/(24EI) · ξ²(1−ξ)²
    // The cubic Hermite only interpolates the homogeneous solution; without this the
    // shape between nodes underestimates the (quartic) deflection of the loaded span.
    const bub = t * t * (1 - t) * (1 - t);
    if (bub > 0) {
      const EIz = f.EIz, EIy = f.EIy;
      if (qy && EIz > 0) uy_l += (qy * L * L * L * L / (24 * EIz)) * bub;
      if (qz && EIy > 0) uz_l += (qz * L * L * L * L / (24 * EIy)) * bub;
    }

    // Transform back to global: u_global = T^T · u_local (only translational part)
    const ex = f.ex, ey = f.ey, ez = f.ez;
    // T^T for the translational block: col vectors are ex, ey, ez
    ux = ex[0]*ux_l + ey[0]*uy_l + ez[0]*uz_l;
    uy = ex[1]*ux_l + ey[1]*uy_l + ez[1]*uz_l;
    uz = ex[2]*ux_l + ey[2]*uy_l + ez[2]*uz_l;
  }

  return { N: N_val, Vy: Vy_val, Vz: Vz_val, T: T_val, My: My_val, Mz: Mz_val, ux, uy, uz };
}

export class Results {
  /**
   * @param {object|null} precomputedElemForces  Map<elemId, ef> — used for combinations
   *   to avoid re-deriving FEFs from a combined u vector (which would be wrong).
   *   When set, _computeAllElemForces is skipped.
   */
  constructor(model, nodeIndex, u, reactions, F_ext, lcId = null, selfWeight = false, precomputedElemForces = null) {
    this.model      = model;
    this.nodeIndex  = nodeIndex;
    this.u          = u;
    this.reactions  = reactions;
    this.F_ext      = F_ext;
    this.lcId       = lcId;
    this.selfWeight = selfWeight;

    // Structured stability warnings (vocabulary in js/solver/stability.js). The solver
    // pushes near-singular / ill-conditioning here; the app post adds drift/displacement
    // sanity. Default [].
    this.warnings   = [];

    this._elemForces = new Map();
    this._diagCache  = null;   // filled by precomputeDiagrams()
    if (precomputedElemForces) {
      this._elemForces = precomputedElemForces;
    } else {
      this._computeAllElemForces();
    }
  }

  // ── Node displacements ───────────────────────────────────────────────────────
  getNodeDisp(nodeId) {
    const d = getNodeDOFs(this.nodeIndex, nodeId);
    return d.map(i => this.u[i]);
  }

  getReaction(nodeId) {
    const d = getNodeDOFs(this.nodeIndex, nodeId);
    return d.map(i => this.reactions[i]);
  }

  getDeformedCoords(nodeId, scale = 1) {
    const node = this.model.nodes.get(nodeId);
    const d    = this.getNodeDisp(nodeId);
    return { x: node.x + scale*d[0], y: node.y + scale*d[1], z: node.z + scale*d[2] };
  }

  getMaxDisp() {
    let maxD = 0;
    for (const id of this.model.nodes.keys()) {
      const d   = this.getNodeDisp(id);
      const mag = Math.sqrt(d[0]**2 + d[1]**2 + d[2]**2);
      if (mag > maxD) maxD = mag;
    }
    return maxD;
  }

  // ── Element internal forces ──────────────────────────────────────────────────
  getElemForces(elemId) { return this._elemForces.get(elemId); }

  // ── Area element stresses (membrane) ────────────────────────────────────────
  // Area ΔT in this load case ('temp' loads with areaId).
  _areaDT(areaId) {
    const lc = this.lcId ? this.model.loadCases.get(this.lcId) : null;
    if (!lc) return 0;
    let dT = 0;
    for (const l of (lc.loads || [])) if (l.type === 'temp' && l.areaId === areaId) dT += (l.dT || 0);
    return dT;
  }
  getAreaStress(areaId) {
    if (!this._areaStress) this._areaStress = new Map();
    if (this._areaStress.has(areaId)) return this._areaStress.get(areaId);
    const area = this.model.areas?.get(areaId);
    let res = null;
    if (area) {
      const s = areaStress(area, this.model, this.nodeIndex, this.u, this._areaDT(areaId));
      if (s) {
        // σx,σy,τxy are in the element's LOCAL frame (ex=node1→node2). The
        // invariants (von Mises, principal σ1≥σ2) do NOT depend on the frame → they
        // are the magnitudes to compare/contour across elements.
        const [sx, sy, txy] = s;
        const c = (sx + sy) / 2, r = Math.hypot((sx - sy) / 2, txy);
        res = { sx, sy, txy, vm: vonMises(s), s1: c + r, s2: c - r };
        // Membrane strains ε = [εx, εy, γxy] + principal (ε₁≥ε₂). Mohr's circle
        // uses γ/2 for the shear term.
        const e = areaStrain(area, this.model, this.nodeIndex, this.u);
        if (e) {
          const [ex, ey, gxy] = e;
          const ec = (ex + ey) / 2, er = Math.hypot((ex - ey) / 2, gxy / 2);
          res.ex = ex; res.ey = ey; res.gxy = gxy; res.e1 = ec + er; res.e2 = ec - er;
        }
        // Bending (plate/shell): surface stress = membrane ± 6M/t².  The envelope
        // max(vM top face, vM bottom face) does NOT depend on the sign of M.
        const sb = areaBendingStress(area, this.model, this.nodeIndex, this.u);
        if (sb) {
          const top = [sx - sb[0], sy - sb[1], txy - sb[2]];
          const bot = [sx + sb[0], sy + sb[1], txy + sb[2]];
          res.vmTop = vonMises(top); res.vmBot = vonMises(bot);
          res.vmMembrane = res.vm;
          res.vmSurf = Math.max(res.vmTop, res.vmBot);   // surface envelope
          res.vm = res.vmSurf;                            // the contour uses the envelope
          // Plate moments per unit width (center): σ_surface = 6·M/t² → M = σ·t²/6.
          const t2_6 = (area.thickness * area.thickness) / 6;
          res.Mx = sb[0] * t2_6; res.My = sb[1] * t2_6; res.Mxy = sb[2] * t2_6;
          // Bending curvatures [κx, κy, κxy] (plate/shell deformation).
          const k = areaCurvature(area, this.model, this.nodeIndex, this.u);
          if (k) { res.kx = k[0]; res.ky = k[1]; res.kxy = k[2]; }
        }
      }
    }
    this._areaStress.set(areaId, res);
    return res;
  }

  // NODAL stress smoothing (BESTFIT style): averages the von Mises of the area
  // elements connected to each node → CONTINUOUS nodal field for smooth contours.
  // Returns Map(nodeId → averageVM).
  getNodalAreaVM() {
    if (this._nodalAreaVM) return this._nodalAreaVM;
    const sum = new Map(), cnt = new Map();
    for (const area of (this.model.areas?.values() || [])) {
      const s = this.getAreaStress(area.id); if (!s) continue;
      for (const nid of area.nodes) { sum.set(nid, (sum.get(nid) || 0) + s.vm); cnt.set(nid, (cnt.get(nid) || 0) + 1); }
    }
    const out = new Map();
    for (const [nid, sv] of sum) out.set(nid, sv / (cnt.get(nid) || 1));
    this._nodalAreaVM = out;
    return out;
  }

  _computeAllElemForces() {
    for (const elem of this.model.elements.values()) {
      this._elemForces.set(elem.id, this._computeElemForces(elem));
    }
  }

  _computeElemForces(elem) {
    const n1  = this.model.nodes.get(elem.n1);
    const n2  = this.model.nodes.get(elem.n2);
    const mat = this.model.materials.get(elem.matId);
    const sec = this.model.sections.get(elem.secId);
    if (!n1 || !n2 || !mat || !sec) return null;

    const { ex, ey, ez, L } = localAxes(n1, n2);
    const Ke_local = elemLocalK(elem, mat, sec, L);   // includes rigid end zone (#87)
    const T        = transformMatrix(ex, ey, ez);

    const d1 = getNodeDOFs(this.nodeIndex, elem.n1);
    const d2 = getNodeDOFs(this.nodeIndex, elem.n2);
    const ue_global = [...d1, ...d2].map(i => this.u[i]);

    let ue_local = Array(12).fill(0);
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++)
        ue_local[i] += T[i][j] * ue_global[j];

    // For elements with end releases (hinges), use the condensed stiffness so
    // that recovered end forces automatically satisfy the release condition
    // (e.g. zero moment at a pinned end). The FEF is still computed for the
    // full fixed-fixed case; any residual at released DOFs is zeroed below.
    const hasRel  = elem.releases && elem.releases.some(r => r);
    const relBool = hasRel ? elem.releases.map(r => r !== 0) : null;
    const Ke_eff = hasRel
      ? applyReleases(Ke_local, relBool)
      : Ke_local;

    // Total uncondensed FEF (load-case loads + self-weight)
    const fefT = this._collectFEF(elem, ex, ey, ez, L);

    // At released DOFs the element's REAL rotation/displacement differs from the
    // nodal one (it was condensed out): recover it so the deflected shape shows the
    // hinge kink. It does not affect fe (Ke_eff has null columns there).
    if (hasRel) ue_local = recoverReleasedDisp(Ke_local, relBool, ue_local, fefT);

    const fe = Array(12).fill(0);
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++)
        fe[i] += Ke_eff[i][j] * ue_local[j];

    // Condensed FEF (condensation is linear: condensing the sum ≡ summing condensed)
    const fefC = hasRel ? condenseFEF(Ke_local, relBool, fefT) : fefT;
    for (let i = 0; i < 12; i++) fe[i] += fefC[i];

    // Enforce release conditions: zero released force components
    // (handles any FEF residual that survived for distributed-load cases)
    if (hasRel) {
      for (let i = 0; i < 12; i++) {
        if (elem.releases[i]) fe[i] = 0;
      }
    }

    // Actual distributed load intensities (local y, z) — needed for correct M(x), V(x)
    const { qy, qz, qy1, qy2, qz1, qz2 } = this._computeActualLoads(elem, ex, ey, ez);

    return {
      N:    -fe[0],
      Vy1:   fe[1],
      Vz1:   fe[2],
      T:     fe[3],
      My1:   fe[4],
      Mz1:   fe[5],
      Vy2:  -fe[7],
      Vz2:  -fe[8],
      My2:  -fe[10],
      Mz2:  -fe[11],
      Vmax:  Math.max(Math.abs(fe[1]), Math.abs(fe[7]), Math.abs(fe[2]), Math.abs(fe[8])),
      Mmax:  Math.max(Math.abs(fe[5]), Math.abs(fe[11]), Math.abs(fe[4]), Math.abs(fe[10])),
      Nabs:  Math.abs(fe[0]),
      qy, qz,             // intensity at end i (compat. — geometric stiffness, etc.)
      qy1, qy2, qz1, qz2, // intensity at both ends (trapezoidal) — source of M(x)/V(x)
      ex, ey, ez, L,
      EIz: mat.E * sec.Iz,   // for the distributed-load deflection bubble
      EIy: mat.E * sec.Iy,
      _ue: ue_local,
    };
  }

  // Total UNcondensed element FEF (load-case distributed loads + self-weight)
  _collectFEF(elem, ex, ey, ez, L) {
    const fef = Array(12).fill(0);
    const lc = this.lcId ? this.model.loadCases.get(this.lcId) : null;
    if (lc) {
      for (const load of lc.loads) {
        if (load.type === 'dist' && load.elemId === elem.id) {
          for (const { d, w, w2 } of _toLocalLoad(load, ex, ey, ez)) {
            const f = fixedEndForces(L, { dir: d, w, w2 });
            for (let i = 0; i < 12; i++) fef[i] += f[i];
          }
        }
        // Uniform temperature → axial FEF (same convention as in assembleF):
        // recovers the correct N (heated fixed-fixed bar → N=−EA·α·ΔT).
        if (load.type === 'temp' && load.elemId === elem.id) {
          const mat = this.model.materials.get(elem.matId);
          const sec = this.model.sections.get(elem.secId);
          if (mat && sec) {
            const Nt = mat.E * sec.A * (sec.mod?.A ?? 1) * (mat.alpha ?? 0) * (load.dT || 0);
            fef[0] += Nt; fef[6] -= Nt;
          }
        }
      }
    }

    if (this.selfWeight) {
      const mat = this.model.materials.get(elem.matId);
      const sec = this.model.sections.get(elem.secId);
      if (mat && sec && mat.rho > 0) {
        const w_sw = selfWeightPerLength(mat, sec);
        for (const { d, w, w2 } of _toLocalLoad({ w: w_sw, dir: 'gravity' }, ex, ey, ez)) {
          const f = fixedEndForces(L, { dir: d, w, w2 });
          for (let i = 0; i < 12; i++) fef[i] += f[i];
        }
      }
    }
    return fef;
  }

  // Returns actual distributed load intensities at BOTH ends in local coords:
  // {qy1,qy2, qz1,qz2} (trapezoidal). For uniform loads q1==q2.
  // This is the source-of-truth for M(x)/V(x) — never infer q from end forces.
  // qy/qz (start-end) kept for backward compatibility (geometric stiffness, etc.).
  _computeActualLoads(elem, ex, ey, ez) {
    return actualLoadsLocal(this.model, this.lcId, this.selfWeight, elem, ex, ey, ez);
  }

  // ── Global summary ───────────────────────────────────────────────────────────
  getSummary() {
    let maxU = 0, maxUNode = null;
    let maxN = 0, maxV = 0, maxM = 0;
    let maxNElem = null, maxVElem = null, maxMElem = null;

    for (const node of this.model.nodes.values()) {
      const d   = this.getNodeDisp(node.id);
      const mag = Math.sqrt(d[0]**2 + d[1]**2 + d[2]**2);
      if (mag > maxU) { maxU = mag; maxUNode = node.id; }
    }

    for (const [id, f] of this._elemForces) {
      if (!f) continue;
      if (f.Nabs > maxN) { maxN = f.Nabs; maxNElem = id; }
      if (f.Vmax > maxV) { maxV = f.Vmax; maxVElem = id; }
      if (f.Mmax > maxM) { maxM = f.Mmax; maxMElem = id; }
    }

    return { maxU, maxUNode, maxN, maxNElem, maxV, maxVElem, maxM, maxMElem };
  }

  // ── Diagram pre-computation (sub-element sampling) ───────────────────────────
  /**
   * Pre-computes and caches diagram data for all elements × all force types.
   * Subsequent getDiagramData calls return instantly from cache.
   * Call this after the main solve; it is called in chunks by App._precomputeDiagramsAsync.
   * @param {string[]} types  Force type keys to cache
   * @param {number}   nPts   Sample points per element (default 20)
   */
  precomputeDiagrams(types = ['N','Vy','Vz','T','My','Mz'], nPts = 20) {
    if (!this._diagCache) this._diagCache = new Map();
    for (const elemId of this.model.elements.keys()) {
      const ec = {};
      for (const t of types) ec[t] = this._computeDiagramData(elemId, t, nPts);
      this._diagCache.set(elemId, ec);
    }
  }

  // Pre-computes a chunk of elements (start…start+count-1) for chunked async use.
  // Returns the next start index (equals total when done).
  precomputeChunk(elemKeys, types, nPts, start, count) {
    if (!this._diagCache) this._diagCache = new Map();
    const end = Math.min(start + count, elemKeys.length);
    for (let i = start; i < end; i++) {
      const elemId = elemKeys[i];
      const ec = {};
      for (const t of types) ec[t] = this._computeDiagramData(elemId, t, nPts);
      this._diagCache.set(elemId, ec);
    }
    return end;
  }

  // ── Diagram data ─────────────────────────────────────────────────────────────
  /**
   * Returns { pts, extremes, maxVal, minVal } for force diagram rendering.
   * Uses cache when pre-computed; otherwise computes analytically on-demand.
   * Equilibrium integration is exact for UDL.
   */
  getDiagramData(elemId, type, nPts = 20) {
    if (this._diagCache) {
      const cached = this._diagCache.get(elemId)?.[type];
      if (cached) return cached;
    }
    return this._computeDiagramData(elemId, type, nPts);
  }

  _computeDiagramData(elemId, type, nPts = 20) {
    const f    = this.getElemForces(elemId);
    const elem = this.model.elements.get(elemId);
    const n1   = elem ? this.model.nodes.get(elem.n1) : null;
    const n2   = elem ? this.model.nodes.get(elem.n2) : null;
    return diagramFromForces(f, n1, n2, type, nPts);
  }

  // ── Force + displacement at arbitrary xi ─────────────────────────────────────
  /**
   * Returns { N, Vy, Vz, T, My, Mz, ux, uy, uz } at xi ∈ [0,1].
   * Forces use equilibrium integration (exact for UDL).
   * Displacements use cubic Hermite interpolation (exact for Bernoulli beam).
   */
  getElemAtXi(elemId, xi) {
    return elemAtXiFromForces(this.getElemForces(elemId), xi);
  }

  // ── CSV export ───────────────────────────────────────────────────────────────
  // `t` is an optional translator (UI passes i18n.t); defaults to identity so the
  // solver module stays neutral (no i18n dependency).
  toCSV(t = (s) => s) {
    const lines = ['# PORTICO — ' + t('Resultados del Análisis Estático')];
    const u = this.model.units;

    lines.push('#');
    lines.push(`# ${t('DESPLAZAMIENTOS NODALES')} [${u}]`);
    lines.push('# NodeID, Ux, Uy, Uz, Rx, Ry, Rz');
    for (const node of this.model.nodes.values()) {
      const d = this.getNodeDisp(node.id);
      lines.push(`${node.id}, ${d.map(v=>v.toExponential(6)).join(', ')}`);
    }

    lines.push('#');
    lines.push(`# ${t('REACCIONES')} [${u}]`);
    lines.push('# NodeID, Rx, Ry, Rz, Rmx, Rmy, Rmz');
    for (const node of this.model.nodes.values()) {
      const r = node.restraints;
      const hasSpring = node.springs && Object.values(node.springs).some(k => k > 0);
      if (!Object.values(r).some(v=>v) && !hasSpring) continue;
      const rx = this.getReaction(node.id);
      lines.push(`${node.id}, ${rx.map(v=>v.toExponential(6)).join(', ')}`);
    }

    lines.push('#');
    lines.push(`# ${t('FUERZAS INTERNAS EN EXTREMOS')} [${u}]`);
    lines.push('# ElemID, N, Vy1, Vz1, T, My1, Mz1, Vy2, Vz2, My2, Mz2');
    for (const [id, f] of this._elemForces) {
      if (!f) continue;
      lines.push([id, f.N, f.Vy1, f.Vz1, f.T, f.My1, f.Mz1, f.Vy2, f.Vz2, f.My2, f.Mz2]
        .map((v,i)=> i===0 ? v : v.toExponential(6)).join(', '));
    }

    return lines.join('\r\n');
  }
}

