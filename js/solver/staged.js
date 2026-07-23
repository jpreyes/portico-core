// ──────────────────────────────────────────────────────────────────────────────
// staged.js — STAGED CONSTRUCTION analysis · #59
//
// A bridge built by successive cantilevers, launching or segments does not behave
// like the finished structure loaded all at once: each element is "born" in the
// deformed geometry of the moment it is activated and only accumulates forces from
// the stages in which it already exists. The key is that the STATE ACCUMULATES per
// stage.
//
// Incremental linear model (small displacements):
//   · The set of ACTIVE elements grows/shrinks per stage.
//   · At each stage K is assembled with the ACTIVE elements ONLY and the load
//     INCREMENT of that stage is solved:  Kactive · ΔU = ΔF.
//   · U and each element's forces ACCUMULATE by adding the increments of the stages
//     where the element was active. A newly activated element does NOT feel the prior
//     deformation (only the increments since its activation) → it starts stress-free,
//     as in SAP2000/CSiBridge (staged construction).
//
// Verifiable: a propped cantilever staged (load → prop → load) gives a deflection
// and moments DIFFERENT from the same structure loaded monolithically — and each
// matches the analytical beam solution (see test_staged.mjs).
//
// Deliberate limitation: frame (bar) elements only. Areas/diaphragms are ignored in
// the staged assembly (staged bridges are trusses/girders).
// ──────────────────────────────────────────────────────────────────────────────
import { buildNodeIndex, assembleK, assembleF, getNodeDOFs, selfWeightPerLength } from './assembler.js?v=7';
import { Results } from './postprocess.js?v=7';

// Numeric end-force fields that ACCUMULATE between stages.
const EF_KEYS = ['N','Vy1','Vz1','T','My1','Mz1','Vy2','Vz2','My2','Mz2',
                 'qy','qz','qy1','qy2','qz1','qz2'];

// Builds a lightweight model "view" with the ACTIVE elements ONLY and a synthetic
// incremental load case. Shares nodes/materials/sections by reference.
function makeView(model, activeIds, incLoads) {
  const elements = new Map();
  for (const id of activeIds) { const e = model.elements.get(id); if (e) elements.set(id, e); }
  const lc = { id: -1, name: '_stage', loads: incLoads, selfWeight: false, type: 'static', specDir: null };
  return {
    nodes: model.nodes, elements, areas: new Map(), diaphragms: new Map(),
    materials: model.materials, sections: model.sections,
    loadCases: new Map([[-1, lc]]), combinations: new Map(),
    mode: model.mode, units: model.units,
  };
}

export class StagedSolver {
  /**
   * @param {Model}  model
   * @param {Array}  stages  — ordered list of stages:
   *    { name, activate:[elemId…], deactivate:[elemId…], loads:[…], selfWeightNew:bool }
   *    `loads`         = loads ADDED in this stage (they persist), model format
   *                      ({type:'nodal',nodeId,F} | {type:'dist',elemId,dir,w[,w2]}).
   *    `selfWeightNew` = apply the self-weight of the newly activated elements
   *                      (typical: each segment brings its weight when cast). Default true.
   * @returns adapter with getNodeDisp/getReaction/getElemForces + .stages[]
   */
  solve(model, stages) {
    const num = (typeof window !== 'undefined' && window.numeric) || (typeof globalThis !== 'undefined' && globalThis.numeric);
    if (!num) throw new Error('numeric.js no está disponible');

    const ni   = buildNodeIndex(model);
    const nDOF = ni.size * 6;
    const is2D = model.mode === '2D';

    const U         = new Float64Array(nDOF);   // accumulated displacement
    const Racc      = new Float64Array(nDOF);   // accumulated reactions
    const efAcc     = new Map();                 // elemId → accumulated forces
    const active    = new Set();                 // active elements
    const everActive= new Set();                 // to detect "newly activated"
    const stageOut  = [];

    // EFFECTIVE per-node restraints (mutable copy). A stage can ADD or REMOVE
    // supports (falsework, props, formwork) via stage.supports. When a support is
    // added in a later stage, the node's already-accumulated displacement is
    // "frozen" (only future increments are restrained), as in reality.
    const restr = new Map();
    for (const node of model.nodes.values()) restr.set(node.id, { ...node.restraints });

    for (const stage of stages) {
      for (const sp of (stage.supports || [])) {
        const r = restr.get(sp.node ?? sp.nodeId); if (!r) continue;
        for (const k of ['ux','uy','uz','rx','ry','rz']) if (sp[k] !== undefined) r[k] = sp[k] ? 1 : 0;
      }
      for (const id of (stage.deactivate || [])) active.delete(id);
      const newlyActive = [];
      for (const id of (stage.activate || [])) {
        if (model.elements.has(id)) { active.add(id); if (!everActive.has(id)) { newlyActive.push(id); everActive.add(id); } }
      }

      // Incremental loads of the stage = declared loads + self-weight of the newly
      // activated elements (as explicit dist gravity).
      const incLoads = [...(stage.loads || [])];
      const swNew = stage.selfWeightNew !== false;
      if (swNew) for (const id of newlyActive) {
        const el = model.elements.get(id);
        const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
        if (mat && sec && mat.rho > 0) incLoads.push({ type: 'dist', elemId: id, dir: 'gravity', w: selfWeightPerLength(mat, sec) });
      }

      const view = makeView(model, active, incLoads);
      const { K } = assembleK(view, ni);
      const F = assembleF(view, ni, -1, false);

      // Nodes "connected" to the active structure (ends of some active element).
      const activeNodes = new Set();
      for (const id of active) { const e = model.elements.get(id); activeNodes.add(e.n1); activeNodes.add(e.n2); }

      // DOF classification: free only if the node is active and the DOF is not
      // restrained (nor out-of-plane in 2D). DOFs of inactive nodes stay fixed
      // (ΔU=0) — they do not exist yet in this stage.
      const freeDOF = [], fixedDOF = [];
      for (const node of model.nodes.values()) {
        const d = getNodeDOFs(ni, node.id), r = restr.get(node.id);
        const isActiveNode = activeNodes.has(node.id);
        const rArr = [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz];
        d.forEach((gi, li) => { (isActiveNode && !rArr[li]) ? freeDOF.push(gi) : fixedDOF.push(gi); });
      }
      if (!freeDOF.length) { stageOut.push({ name: stage.name, dU: 0, active: new Set(active) }); continue; }

      const nF = freeDOF.length;
      const Kff = Array.from({ length: nF }, (_, i) => { const row = new Float64Array(nF), ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) row[j] = K[ri + freeDOF[j]]; return [...row]; });
      const Ff  = freeDOF.map(di => F[di]);

      let duf;
      try { duf = num.solve(Kff, Ff); }
      catch (e) { throw new Error(`Etapa «${stage.name}»: el solver falló (${e.message}). ¿La subestructura activa es estable?`); }
      if (!duf || duf.some(v => !Number.isFinite(v)))
        throw new Error(`Etapa «${stage.name}»: subestructura INESTABLE (mecanismo). Revise apoyos/elementos activos.`);

      const dU = new Float64Array(nDOF);
      freeDOF.forEach((gi, i) => { dU[gi] = duf[i]; });

      // Incremental reactions = K·ΔU − ΔF at the restrained DOFs.
      const dR = new Float64Array(nDOF);
      for (const gi of fixedDOF) { let s = 0; const ri = gi * nDOF; for (let j = 0; j < nDOF; j++) s += K[ri + j] * dU[j]; dR[gi] = s - F[gi]; }

      // Accumulate displacements and reactions.
      for (let i = 0; i < nDOF; i++) { U[i] += dU[i]; Racc[i] += dR[i]; }

      // Incremental forces of the active elements (includes FEF of this stage's
      // loads) → accumulate. A newly activated element only receives its increments
      // from now on (born stress-free).
      const incRes = new Results(view, ni, dU, dR, F, -1, false);
      let dUmax = 0; for (const gi of freeDOF) dUmax = Math.max(dUmax, Math.abs(dU[gi]));
      for (const id of active) {
        const ef = incRes.getElemForces(id); if (!ef) continue;
        let acc = efAcc.get(id);
        if (!acc) { acc = { ex: ef.ex, ey: ef.ey, ez: ef.ez, L: ef.L, EIz: ef.EIz, EIy: ef.EIy }; for (const k of EF_KEYS) acc[k] = 0; efAcc.set(id, acc); }
        for (const k of EF_KEYS) acc[k] += (ef[k] || 0);
      }
      stageOut.push({ name: stage.name, dUmax, active: new Set(active), newlyActive: [...newlyActive] });
    }

    // Derived quantities from the accumulated forces (Vmax/Mmax/Nabs) for getSummary-like.
    for (const acc of efAcc.values()) {
      acc.Vmax = Math.max(Math.abs(acc.Vy1), Math.abs(acc.Vy2), Math.abs(acc.Vz1), Math.abs(acc.Vz2));
      acc.Mmax = Math.max(Math.abs(acc.Mz1), Math.abs(acc.Mz2), Math.abs(acc.My1), Math.abs(acc.My2));
      acc.Nabs = Math.abs(acc.N);
    }

    return {
      model, nodeIndex: ni, u: U, reactions: Racc, stages: stageOut,
      getNodeDisp: (id) => getNodeDOFs(ni, id).map(i => U[i]),
      getReaction: (id) => getNodeDOFs(ni, id).map(i => Racc[i]),
      getElemForces: (id) => efAcc.get(id) || null,
      getMaxDisp: () => { let m = 0; for (const id of model.nodes.keys()) { const d = getNodeDOFs(ni, id).map(i => U[i]); m = Math.max(m, Math.hypot(d[0], d[1], d[2])); } return m; },
    };
  }
}
