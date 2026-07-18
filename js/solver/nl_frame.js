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
//   remapCorotSteps     — corotational steps [u,w,θ] → nodal [ux,uy=0,uz=w] + axial N
// ──────────────────────────────────────────────────────────────────────────────
import { selfWeightPerLength } from './assembler.js?v=2';
import { corotBeamForceTangent } from './corotbeam.js?v=2';

// gravity = −Z; the named global directions otherwise.
const dirVec = (dir) => dir === 'globalX' ? [1, 0, 0] : dir === 'globalY' ? [0, 1, 0] : dir === 'globalZ' ? [0, 0, 1] : [0, 0, -1];

/**
 * Reduced truss/cable problem for the large-DISPLACEMENT solver (solveNonlinear).
 * Every element is a two-force member; «cable»/«compressionOnly» flags pass through.
 * Prestress via natural length L0 = L0factor·L. 3 translational DOF per node (2D locks uy).
 *
 * @returns {{ok:false, reason:'no-elements'|'no-free-dof'}
 *          | {ok:true, X:Float64Array, elems:object[], free:number[], nodeIds:number[],
 *             idxOf:Map, elemIds:number[], Fref:Float64Array, nCasos:number}}
 */
export function buildNLTrussProblem(model) {
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

  // Reference load: combines all static cases at factor 1
  const Fref = new Float64Array(3 * nNode);
  const addNode = (id, fx, fy, fz) => { const i = idxOf.get(id); if (i == null) return; Fref[3 * i] += fx; Fref[3 * i + 1] += fy; Fref[3 * i + 2] += fz; };
  let nCasos = 0;
  for (const lc of model.loadCases.values()) {
    if (lc.type === 'spectrum') continue;
    nCasos++;
    for (const load of (lc.loads || [])) {
      if (load.type === 'nodal') addNode(load.nodeId, load.F[0] || 0, load.F[1] || 0, load.F[2] || 0);
      else if (load.type === 'dist') {
        const el = model.elements.get(load.elemId);
        if (!el) continue;
        const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
        if (!n1 || !n2) continue;
        const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z);
        const half = (load.w || 0) * L / 2;
        const g = dirVec(load.dir || 'gravity');
        addNode(el.n1, half * g[0], half * g[1], half * g[2]);
        addNode(el.n2, half * g[0], half * g[1], half * g[2]);
      }
    }
    if (lc.selfWeight) {   // self-weight lumped to the nodes (−Z)
      for (const el of model.elements.values()) {
        const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
        const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
        if (!n1 || !n2 || !mat || !sec) continue;
        const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z);
        const w = selfWeightPerLength(mat, sec) * L / 2;   // half to each node
        addNode(el.n1, 0, 0, -w); addNode(el.n2, 0, 0, -w);
      }
    }
  }

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
