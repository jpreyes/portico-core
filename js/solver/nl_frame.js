// ──────────────────────────────────────────────────────────────────────────────
// nl_frame.js — translate a Model into the reduced problems the geometric-nonlinear
// frame solvers consume, and map their results back to nodal form.
//
// The solve engines are already modular (solveNonlinear in nl_lite.js, run in a
// worker; solveCorotBeam in corotbeam.js). What lived inline in app.js's
// runNonlinear/runCorotBeam was the MODEL→PROBLEM translation: node indexing,
// element EA/EI/L0, the free-DOF list, and the reference-load lumping (nodal +
// distributed + self-weight, combined over every static case at factor 1). That
// translation was duplicated between the two drivers; it lives here now as pure
// functions of the Model, returning a structured refusal `reason` on empty inputs.
//
//   buildNLTrussProblem — 3 translational DOF/node truss/cable (large displacement)
//   buildCorotProblem   — planar 3 DOF/node beam [u,w,θ] (large rotation)
//   buildFormFindProblem— force-density network (anchors, branches, node loads)
//   remapCorotSteps     — corotational steps [u,w,θ] → nodal [ux,uy=0,uz=w] + axial N
//   lumpReferenceLoad3D — the shared 3D reference-load lumping (nodal+dist+self-weight)
// ──────────────────────────────────────────────────────────────────────────────
import { selfWeightPerLength } from './assembler.js?v=2';
import { corotBeamForceTangent } from './corotbeam.js?v=2';
import { solveNonlinear } from './nl_lite.js?v=2';

// gravity = −Z; the named global directions otherwise.
const dirVec = (dir) => dir === 'globalX' ? [1, 0, 0] : dir === 'globalY' ? [0, 1, 0] : dir === 'globalZ' ? [0, 0, 1] : [0, 0, -1];

/**
 * The 3D reference load, lumped to the nodes: nodal loads as-is, distributed loads split
 * half to each end along their direction, self-weight split half to each end along −Z.
 * Combined over a set of load cases at their factors — either an explicit `contribs`
 * PATTERN (from a combination / single case, each with its own factor and self-weight
 * flag) or, when omitted, every static case at factor 1 (spectral cases skipped). This
 * is the single copy the truss, form-finding and pushover builders share.
 *
 * @param {Model} model
 * @param {Map}   idxOf   node id → 0-based index (its size is the node count)
 * @param {{lcId:number,factor:number,selfWeight:boolean}[]|null} [contribs]  load pattern;
 *        null → all static cases at factor 1.
 * @returns {{F:Float64Array, nCasos:number, hasLoad:boolean}}  F is 3·nNode.
 */
export function lumpReferenceLoad3D(model, idxOf, contribs = null) {
  const nNode = idxOf.size;
  const F = new Float64Array(3 * nNode);
  const add = (id, fx, fy, fz) => { const i = idxOf.get(id); if (i == null) return; F[3 * i] += fx; F[3 * i + 1] += fy; F[3 * i + 2] += fz; };
  // Normalize both call styles to (load case, factor, include-self-weight) entries.
  const entries = contribs
    ? contribs.map(c => ({ lc: model.loadCases.get(c.lcId), factor: c.factor, selfWeight: c.selfWeight }))
    : [...model.loadCases.values()].filter(lc => lc.type !== 'spectrum').map(lc => ({ lc, factor: 1, selfWeight: lc.selfWeight }));
  let nCasos = 0, hasLoad = false;
  for (const { lc, factor, selfWeight } of entries) {
    if (!lc) continue;
    nCasos++;
    for (const load of (lc.loads || [])) {
      if (load.type === 'nodal') { add(load.nodeId, factor * (load.F[0] || 0), factor * (load.F[1] || 0), factor * (load.F[2] || 0)); hasLoad = true; }
      else if (load.type === 'dist') {
        const el = model.elements.get(load.elemId); if (!el) continue;
        const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2); if (!n1 || !n2) continue;
        const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z);
        const half = factor * (load.w || 0) * L / 2, g = dirVec(load.dir || 'gravity');
        add(el.n1, half * g[0], half * g[1], half * g[2]);
        add(el.n2, half * g[0], half * g[1], half * g[2]);
        hasLoad = true;
      }
    }
    if (selfWeight) for (const el of model.elements.values()) {   // self-weight lumped to the nodes (−Z)
      const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
      const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
      if (!n1 || !n2 || !mat || !sec) continue;
      const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z);
      const w = factor * selfWeightPerLength(mat, sec) * L / 2;   // half to each node
      add(el.n1, 0, 0, -w); add(el.n2, 0, 0, -w);
      hasLoad = true;
    }
  }
  return { F, nCasos, hasLoad };
}

/**
 * Reduced truss/cable problem for the large-DISPLACEMENT solver (solveNonlinear).
 * Every element is a two-force member; «cable»/«compressionOnly» flags pass through.
 * Prestress via natural length L0 = L0factor·L. 3 translational DOF per node (2D locks uy).
 *
 * @param {Model}  model
 * @param {object} [o]
 * @param {{lcId:number,factor:number,selfWeight:boolean}[]|null} [o.contribs]  reference
 *        load pattern; null (default) → every static case at factor 1.
 * @returns {{ok:false, reason:'no-elements'|'no-free-dof'}
 *          | {ok:true, X:Float64Array, elems:object[], free:number[], nodeIds:number[],
 *             idxOf:Map, elemIds:number[], Fref:Float64Array, nCasos:number}}
 */
export function buildNLTrussProblem(model, { contribs = null } = {}) {
  const nodeIds = [...model.nodes.keys()];
  const idxOf = new Map(nodeIds.map((id, i) => [id, i]));
  const nNode = nodeIds.length;
  const X = new Float64Array(3 * nNode);
  nodeIds.forEach((id, i) => { const n = model.nodes.get(id); X[3 * i] = n.x; X[3 * i + 1] = n.y; X[3 * i + 2] = n.z; });

  const elems = [], elemIds = [];
  for (const el of model.elements.values()) {
    const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
    const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
    if (!n1 || !n2 || !mat || !sec) continue;
    const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z);
    if (L < 1e-12) continue;
    const L0 = (el.L0factor || 1) * L;
    elems.push({ n1: idxOf.get(el.n1), n2: idxOf.get(el.n2), EA: mat.E * sec.A, L0, cable: !!el.cable, compressionOnly: !!el.compressionOnly });
    elemIds.push(el.id);
  }
  if (!elems.length) return { ok: false, reason: 'no-elements' };

  // Free DOFs (translations only; in 2D, uy fixed)
  const is2D = model.mode === '2D';
  const free = [];
  nodeIds.forEach((id, i) => {
    const r = model.nodes.get(id).restraints;
    const fix = [r.ux, is2D ? 1 : r.uy, r.uz];
    for (let c = 0; c < 3; c++) if (!fix[c]) free.push(3 * i + c);
  });
  if (!free.length) return { ok: false, reason: 'no-free-dof' };

  const { F: Fref, nCasos } = lumpReferenceLoad3D(model, idxOf, contribs);   // pattern, or all cases at factor 1
  return { ok: true, X, elems, free, nodeIds, idxOf, elemIds, Fref, nCasos };
}

/**
 * Reduced planar problem for the large-ROTATION corotational beam (solveCorotBeam).
 * PLANAR X–Z: 3 DOF per node [u=ux, w=uz, θ=ry]. Distributed/self-weight lumped as a
 * transverse −Z force at the ends (approx.). Returns both the 2·N in-plane `coords`
 * (solver input) and the 3·N `X` (display remap input).
 *
 * @returns {{ok:false, reason:'no-elements'|'no-free-dof'}
 *          | {ok:true, coords:Float64Array, X:Float64Array, elems:object[], free:number[],
 *             nodeIds:number[], idxOf:Map, elemIds:number[], Fref:Float64Array, nCasos:number}}
 */
export function buildCorotProblem(model) {
  const nodeIds = [...model.nodes.keys()];
  const idxOf = new Map(nodeIds.map((id, i) => [id, i]));
  const nNode = nodeIds.length;
  const coords = new Float64Array(2 * nNode);   // (x, z) of the plane
  const X = new Float64Array(3 * nNode);        // (x, y, z) for the nodal-display remap
  nodeIds.forEach((id, i) => {
    const n = model.nodes.get(id);
    coords[2 * i] = n.x; coords[2 * i + 1] = n.z;
    X[3 * i] = n.x; X[3 * i + 1] = n.y; X[3 * i + 2] = n.z;
  });

  const elems = [], elemIds = [];
  for (const el of model.elements.values()) {
    const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
    const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
    if (!n1 || !n2 || !mat || !sec) continue;
    if (Math.hypot(n2.x - n1.x, n2.z - n1.z) < 1e-12) continue;
    const mod = sec.mod || {};
    elems.push({ n1: idxOf.get(el.n1), n2: idxOf.get(el.n2), EA: mat.E * sec.A * (mod.A ?? 1), EI: mat.E * sec.Iz * (mod.Iz ?? 1) });
    elemIds.push(el.id);
  }
  if (!elems.length) return { ok: false, reason: 'no-elements' };

  // Free DOFs: 3/node (u=ux, w=uz, θ=ry)
  const free = [];
  nodeIds.forEach((id, i) => {
    const r = model.nodes.get(id).restraints;
    const fix = [r.ux, r.uz, r.ry];
    for (let c = 0; c < 3; c++) if (!fix[c]) free.push(3 * i + c);
  });
  if (!free.length) return { ok: false, reason: 'no-free-dof' };

  // Reference load: Fx→u, Fz→w, My→θ ; dist/self-weight lumped (transverse −Z)
  const Fref = new Float64Array(3 * nNode);
  const add = (id, fu, fw, fm) => { const i = idxOf.get(id); if (i == null) return; Fref[3 * i] += fu; Fref[3 * i + 1] += fw; Fref[3 * i + 2] += fm; };
  let nCasos = 0;
  for (const lc of model.loadCases.values()) {
    if (lc.type === 'spectrum') continue;
    nCasos++;
    for (const load of (lc.loads || [])) {
      if (load.type === 'nodal') add(load.nodeId, load.F[0] || 0, load.F[2] || 0, load.F[4] || 0);   // Fx, Fz, My
      else if (load.type === 'dist') {
        const el = model.elements.get(load.elemId); if (!el) continue;
        const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2); if (!n1 || !n2) continue;
        const L = Math.hypot(n2.x - n1.x, n2.z - n1.z); const half = (load.w || 0) * L / 2;
        add(el.n1, 0, -half, 0); add(el.n2, 0, -half, 0);   // transverse −Z lumping (approx.)
      }
    }
    if (lc.selfWeight) for (const el of model.elements.values()) {
      const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
      const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
      if (!n1 || !n2 || !mat || !sec) continue;
      const w = selfWeightPerLength(mat, sec) * Math.hypot(n2.x - n1.x, n2.z - n1.z) / 2;
      add(el.n1, 0, -w, 0); add(el.n2, 0, -w, 0);
    }
  }

  return { ok: true, coords, X, elems, free, nodeIds, idxOf, elemIds, Fref, nCasos };
}

/**
 * Remap corotational solver steps to the «Nonlinear» tab format: each step's planar
 * DOF [u,w,θ] → nodal displacement [ux, uy=0, uz=w], plus the axial force N per element
 * (all reported as taut, no cable slack in the beam model).
 *
 * @param {{coords:Float64Array, elems:object[], steps:object[], nNode:number}} o
 * @returns {{lambda:number, u:Float64Array, N:number[], taut:boolean[], iters:number, resid:number}[]}
 */
export function remapCorotSteps({ coords, elems, steps, nNode }) {
  return steps.map(s => {
    const u3 = new Float64Array(3 * nNode);
    for (let i = 0; i < nNode; i++) { u3[3 * i] = s.u[3 * i]; u3[3 * i + 1] = 0; u3[3 * i + 2] = s.u[3 * i + 1]; }
    const N = elems.map(el => corotBeamForceTangent(coords, s.u, el).N);
    return { lambda: s.lambda, u: u3, N, taut: N.map(() => true), iters: s.iters, resid: s.resid };
  });
}

/**
 * Force-density (FDM) network for form-finding. If `selEls` is non-empty only those
 * elements form the network; a node is an ANCHOR when it is translation-restrained OR
 * touches a NON-participating element (so, e.g., only a beam is formed and the columns
 * survive). Otherwise the whole model is formed. Node loads reuse lumpReferenceLoad3D.
 *
 * @param {Model}    model
 * @param {number[]} [selEls]  selected element ids (empty → whole model)
 * @returns {{ok:false, reason:'few-anchors'|'no-branches'}
 *          | {ok:true, coords:Float64Array, fixed:boolean[], branches:number[][],
 *             nodeIds:number[], idxOf:Map, loads:number[][]|null, hasLoad:boolean, hasSel:boolean}}
 */
export function buildFormFindProblem(model, selEls = []) {
  const hasSel = selEls.length > 0;
  const partSet = new Set(hasSel ? selEls : [...model.elements.keys()]);
  const boundary = new Set();
  if (hasSel) for (const el of model.elements.values()) {
    if (!partSet.has(el.id)) { boundary.add(el.n1); boundary.add(el.n2); }
  }

  const nodeIds = [...model.nodes.keys()];
  const idxOf = new Map(nodeIds.map((id, i) => [id, i]));
  const n = nodeIds.length;
  const coords = new Float64Array(3 * n);
  const fixed = [];
  nodeIds.forEach((id, i) => {
    const nd = model.nodes.get(id);
    coords[3 * i] = nd.x; coords[3 * i + 1] = nd.y; coords[3 * i + 2] = nd.z;
    const r = nd.restraints;
    // anchor = translation restraint OR boundary with non-participating structure
    fixed.push(!!(r.ux || r.uy || r.uz) || boundary.has(id));
  });
  if (fixed.filter(Boolean).length < 2) return { ok: false, reason: 'few-anchors' };

  const branches = [];
  for (const id of partSet) {
    const el = model.elements.get(id); if (!el) continue;
    const i = idxOf.get(el.n1), j = idxOf.get(el.n2);
    if (i != null && j != null) branches.push([i, j]);
  }
  if (!branches.length) return { ok: false, reason: 'no-branches' };

  const { F, hasLoad } = lumpReferenceLoad3D(model, idxOf);
  const loads = hasLoad ? Array.from({ length: n }, (_, i) => [F[3 * i], F[3 * i + 1], F[3 * i + 2]]) : null;
  return { ok: true, coords, fixed, branches, nodeIds, idxOf, loads, hasLoad, hasSel };
}

/**
 * Pushover displacement-control setup. A single linear probe (Newton, 1 step / 1 iter
 * from rest) gives the elastic shape under the reference load; the CONTROL DOF is the
 * free DOF that moves most, the optional imperfection seeds that scaled shape into the
 * geometry, and the target control displacement is set well past the limit point so the
 * subsequent displacement-control solve traces the full snap-through. Pure given P.
 *
 * @param {object} P     buildNLTrussProblem result ({X, elems, free, Fref, …})
 * @param {number} [imp=0] imperfection amplitude [m] (0 = perfect)
 * @returns {{ok:false, reason:'null-pattern'|'no-response'}
 *          | {ok:true, cDOF:number, Ximp:Float64Array, target:number, linCtrl:number}}
 *   null-pattern = the reference load is zero; no-response = load applied but the truss
 *   idealization (axial/cables only) produces no displacement (a bending-only frame).
 */
export function setupPushoverControl(P, imp = 0) {
  // Linear response (1 step, 1 iteration from u=0) → control DOF + imperfection shape
  const lin = solveNonlinear({ X: P.X, elems: P.elems, free: P.free, Fref: P.Fref, nSteps: 1, maxIter: 1, tol: 1e-30 });
  const uLin = lin.steps[0]?.u || new Float64Array(P.X.length);
  let cDOF = P.free[0], best = -1;
  for (const d of P.free) { const v = Math.abs(uLin[d]); if (v > best) { best = v; cDOF = d; } }
  if (best < 1e-30) {
    let frefN = 0; for (const d of P.free) frefN += P.Fref[d] * P.Fref[d]; frefN = Math.sqrt(frefN);
    return { ok: false, reason: frefN < 1e-12 ? 'null-pattern' : 'no-response' };
  }
  const Ximp = Float64Array.from(P.X);
  if (imp > 0) {
    let nrm = 0; for (const d of P.free) nrm += uLin[d] * uLin[d]; nrm = Math.sqrt(nrm) || 1;
    for (const d of P.free) Ximp[d] += imp * uLin[d] / nrm;
  }
  const linCtrl = uLin[cDOF] || 1e-3;
  return { ok: true, cDOF, Ximp, target: linCtrl * 25, linCtrl };   // target pushes past limit points
}
