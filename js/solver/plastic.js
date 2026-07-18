// ──────────────────────────────────────────────────────────────────────────────
// plastic.js — event-by-event incremental plastic-hinge pushover (headless).
//
// Elastic-perfectly-plastic (or with a post-yield DROP) frame collapse analysis,
// extracted from app.js so it can run without the DOM and be validated on its own
// (test_plastic.mjs). Each element END forms a hinge on a component (N, Vy, Vz, My,
// Mz) when its force reaches the given capacity; that local DOF is released and its
// force is held at the capacity. Collapse = a MECHANISM forms (K goes singular).
//
// Behavior per component:
//   · perfecto      → ∞ plateau (thetaU=deltaU=Infinity, residual=1)
//   · ductil_caida  → plateau up to θu/δu, then sheds to `residual`·capacity
//   · fragil        → drops immediately on yield (θu=δu=0)
//
// The solver is capacity- and load-agnostic: the caller hands it a per-element
// capacity map and a reference load pattern (contribs), and it returns the collapse
// multiplier λ and the ordered hinge sequence. The dialogs, selection, meshing,
// toasts and overlay that used to wrap this stay in app.js.
// ──────────────────────────────────────────────────────────────────────────────
import { buildNodeIndex, assembleF, getNodeDOFs } from './assembler.js?v=3';
import { makeFactor } from './linsolve.js?v=3';
import { localAxes, stiffnessMatrix, transformMatrix, globalStiffness, applyReleases } from './timoshenko.js?v=3';
import { applyDiaphragmConstraints } from './diaphragm.js?v=3';

// Assemble the (conditioned) global K for the current release state, returning the
// per-element data (element DOFs, transform, condensed local Ke, length) the event
// loop needs. Same assembly as assembleK, but honoring per-element `releasesByElem`
// (the hinges formed so far) and keeping the diaphragm penalty so master nodes are
// not spuriously singular.
function plasticAssemble(model, nodeIndex, releasesByElem) {
  const nDOF = nodeIndex.size * 6;
  const K = new Float64Array(nDOF * nDOF);
  const elems = [];
  for (const el of model.elements.values()) {
    const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
    const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
    if (!n1 || !n2 || !mat || !sec) continue;
    const { ex, ey, ez, L } = localAxes(n1, n2);
    let Ke = stiffnessMatrix(L, mat, sec);
    const rel = releasesByElem.get(el.id);
    const relBool = rel ? rel.map(r => !!r) : null;
    if (relBool && relBool.some(Boolean)) Ke = applyReleases(Ke, relBool);
    const T = transformMatrix(ex, ey, ez);
    const KG = globalStiffness(Ke, T);
    const ed = [...getNodeDOFs(nodeIndex, el.n1), ...getNodeDOFs(nodeIndex, el.n2)];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) K[ed[i] * nDOF + ed[j]] += KG[i][j];
    elems.push({ id: el.id, ed, T, KeCond: Ke, L });
  }
  // Rigid-diaphragm constraints (penalty), like assembleK: without this the master
  // nodes (without elements) have zero stiffness → singular K → false «mechanism
  // from the start» in models with diaphragms.
  applyDiaphragmConstraints(K, model, nodeIndex, nDOF);
  return { K, nDOF, elems };
}

/**
 * Run the event-by-event plastic pushover.
 *
 * @param {Model}  model
 * @param {object} o
 * @param {Map<number,{N,Vy,Vz,My,Mz}>} o.capByElem  per-element component capacities
 *        (Infinity = that component doesn't yield). Missing element → all Infinity.
 * @param {{lcId:number,factor:number,selfWeight:boolean}[]} o.contribs  reference load
 *        pattern; the collapse multiplier λ is measured against this combination.
 * @param {number} [o.residual=1]        fraction of capacity retained after a drop.
 * @param {number} [o.thetaU=Infinity]   ultimate rotation of MOMENT hinges (rad).
 * @param {number} [o.deltaU=Infinity]   ultimate displacement of N/V hinges (m).
 * @returns {{ok:false, reason:string, collapsed?:boolean}
 *          | {ok:true, events:object[], lambda:number, collapsed:boolean,
 *             u:Float64Array, nodeIndex:Map, nCasos:number}}
 *   reason ∈ 'no-free-dof' | 'no-loads' | 'null-pattern' | 'no-hinges'.
 */
export function solvePlastic(model, {
  capByElem, contribs,
  residual = 1, thetaU = Infinity, deltaU = Infinity,
} = {}) {
  const capOf = (eid, axis) => (capByElem.get(eid) || {})[axis] ?? Infinity;
  // yield components per element (local DOF, axis, rotational?)
  const COMPS = [
    { end: 1, dl: 0, axis: 'N', rot: false }, { end: 1, dl: 1, axis: 'Vy', rot: false }, { end: 1, dl: 2, axis: 'Vz', rot: false },
    { end: 1, dl: 4, axis: 'My', rot: true }, { end: 1, dl: 5, axis: 'Mz', rot: true },
    { end: 2, dl: 7, axis: 'Vy', rot: false }, { end: 2, dl: 8, axis: 'Vz', rot: false },
    { end: 2, dl: 10, axis: 'My', rot: true }, { end: 2, dl: 11, axis: 'Mz', rot: true },
  ];
  const dropMode = (thetaU !== Infinity || deltaU !== Infinity);   // there is a drop (brittle or ductile-with-drop)

  // Plastic deformation of the hinge RELATIVE TO THE CHORD of the element (not the
  // raw deformation of the released DOF, which includes the rigid-body
  // rotation/translation of the span). ul = LOCAL element displacements (12), L = length.
  //   · Moment (Mz): nodal rotation − chord rotation in the x-y plane = θz − (uy2−uy1)/L
  //   · Moment (My): θy + (uz2−uz1)/L  (sign of the local frame [ux,uy,uz,rx,ry,rz])
  //   · Axial (N):    relative elongation ux2−ux1
  //   · Shear (V):    relative transverse slip uy2−uy1 / uz2−uz1
  const plasticRate = (ul, c, L) => {
    switch (c.axis) {
      case 'N':  return ul[6] - ul[0];
      case 'Vy': return ul[7] - ul[1];
      case 'Vz': return ul[8] - ul[2];
      case 'Mz': return ul[c.dl] - (ul[7] - ul[1]) / L;
      case 'My': return ul[c.dl] + (ul[8] - ul[2]) / L;
      default:   return ul[c.dl];
    }
  };

  const nodeIndex = buildNodeIndex(model);
  const nDOF = nodeIndex.size * 6;
  const is2D = model.mode === '2D';
  const freeDOF = [];
  for (const node of model.nodes.values()) {
    const d = getNodeDOFs(nodeIndex, node.id), r = node.restraints;
    const rArr = [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz];
    d.forEach((gi, li) => { if (!rArr[li]) freeDOF.push(gi); });
  }
  if (!freeDOF.length) return { ok: false, reason: 'no-free-dof' };
  const nF = freeDOF.length;

  // Reference load per the chosen pattern (#45): all / one case / one combo.
  const F = new Float64Array(nDOF);
  let nCasos = 0;
  for (const c of contribs) {
    const Fi = assembleF(model, nodeIndex, c.lcId, c.selfWeight);
    for (let i = 0; i < nDOF; i++) F[i] += c.factor * Fi[i];
    nCasos++;
  }
  if (!nCasos) return { ok: false, reason: 'no-loads' };
  // Null load pattern → no moment grows with λ → "no hinges form" would be
  // misleading (the loads are the problem, not Mp). Clear diagnosis (#46).
  let Fnorm = 0; for (let i = 0; i < nDOF; i++) Fnorm += F[i] * F[i]; Fnorm = Math.sqrt(Fnorm);
  if (Fnorm < 1e-12) return { ok: false, reason: 'null-pattern' };

  const releasesByElem = new Map();
  for (const el of model.elements.values()) releasesByElem.set(el.id, (el.releases || Array(12).fill(0)).slice());
  const Macc = new Map(), hinged = new Set();
  const thetaP = new Map(), dropped = new Set();   // plastic deformation of each hinge + already-dropped hinges
  let lambda = 0; const u = new Float64Array(nDOF);
  const events = []; let collapsed = false;
  const maxEvents = 12 * model.elements.size + 24;

  // Applies the DROP of a set of hinges: sheds the retained moment/force
  // −(1−ε)·X_form, redistributes and forms IN CASCADE those that exceed capacity
  // (brittle → drop immediately). Returns true if a mechanism forms.
  const applyDrops = (queue0) => {
    let queue = queue0, guard2 = 0;
    while (queue.length && guard2++ < 600) {
      const { K: Kd, elems: elemsD } = plasticAssemble(model, nodeIndex, releasesByElem);
      const eb = new Map(elemsD.map(e => [e.id, e]));
      const Kffd = new Float64Array(nF * nF);
      for (let i = 0; i < nF; i++) { const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) Kffd[i * nF + j] = Kd[ri + freeDOF[j]]; }
      const facd = makeFactor(Kffd, nF, false);
      if (!facd.ok) return true;   // mechanism after the drop
      const G = new Float64Array(nDOF);
      for (const c of queue) {
        const e = eb.get(c.elemId); if (!e) continue;
        const shed = -(1 - residual) * c.M_form;
        for (let i = 0; i < 12; i++) G[e.ed[i]] += e.T[c.dofLocal][i] * shed;   // T^T: local→global
        Macc.set(c.key, residual * c.M_form); dropped.add(c.key);
      }
      const Gf = new Float64Array(nF); for (let i = 0; i < nF; i++) Gf[i] = G[freeDOF[i]];
      const duf = facd.solve(Gf);
      const duJ = new Float64Array(nDOF); for (let i = 0; i < nF; i++) duJ[freeDOF[i]] = duf[i];
      for (let i = 0; i < nDOF; i++) u[i] += duJ[i];
      const over = [];
      for (const e of elemsD) {
        const ue = e.ed.map(d => duJ[d]);
        const ul = new Array(12).fill(0); for (let i = 0; i < 12; i++) { let s = 0; for (let j = 0; j < 12; j++) s += e.T[i][j] * ue[j]; ul[i] = s; }
        const fl = new Array(12).fill(0); for (let i = 0; i < 12; i++) { let s = 0; for (let j = 0; j < 12; j++) s += e.KeCond[i][j] * ul[j]; fl[i] = s; }
        for (const c of COMPS) {
          const key = `${e.id}:${c.end}:${c.axis}`;
          if (hinged.has(key)) { if (!dropped.has(key)) thetaP.set(key, (thetaP.get(key) || 0) + plasticRate(ul, c, e.L)); continue; }
          const cap = capOf(e.id, c.axis); if (!isFinite(cap)) continue;
          const M1 = (Macc.get(key) || 0) + fl[c.dl]; Macc.set(key, M1);
          if (Math.abs(M1) > cap * (1 + 1e-6)) over.push({ key, elemId: e.id, dofLocal: c.dl, end: c.end, axis: c.axis, rot: c.rot, M_form: Math.sign(M1) * cap });
        }
      }
      let dctrl2 = 0; for (const node of model.nodes.values()) { const d = getNodeDOFs(nodeIndex, node.id); dctrl2 = Math.max(dctrl2, Math.hypot(u[d[0]], u[d[1]], u[d[2]])); }
      const next = [];
      for (const o of over) {
        releasesByElem.get(o.elemId)[o.dofLocal] = 1; hinged.add(o.key); thetaP.set(o.key, 0);
        const nd = model.elements.get(o.elemId);
        events.push({ lambda, elemId: o.elemId, nodeId: o.end === 1 ? nd.n1 : nd.n2, axis: o.axis, dctrl: dctrl2, cascade: true });
        Macc.set(o.key, o.M_form);
        if ((o.rot ? thetaU : deltaU) === 0) next.push({ key: o.key, elemId: o.elemId, dofLocal: o.dofLocal, end: o.end, axis: o.axis, M_form: o.M_form });   // brittle → drops instantly
      }
      queue = next;
    }
    return false;
  };

  for (let k = 0; k < maxEvents; k++) {
    const { K, elems } = plasticAssemble(model, nodeIndex, releasesByElem);
    const Kff = new Float64Array(nF * nF);
    for (let i = 0; i < nF; i++) { const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) Kff[i * nF + j] = K[ri + freeDOF[j]]; }
    const fac = makeFactor(Kff, nF, false);
    if (!fac.ok) { collapsed = true; break; }   // mechanism → collapse

    const Ff = new Float64Array(nF); for (let i = 0; i < nF; i++) Ff[i] = F[freeDOF[i]];
    const uf = fac.solve(Ff);
    const uUnit = new Float64Array(nDOF); for (let i = 0; i < nF; i++) uUnit[freeDOF[i]] = uf[i];

    // Forces/rates per COMPONENT (N, Vy, Vz, My, Mz) at non-hinged ends + plastic
    // deformation of the already-formed (not dropped) hinges.
    const rates = [], hingeDef = [];
    for (const e of elems) {
      const ue = e.ed.map(d => uUnit[d]);
      const ul = new Array(12).fill(0);
      for (let i = 0; i < 12; i++) { let s = 0; for (let j = 0; j < 12; j++) s += e.T[i][j] * ue[j]; ul[i] = s; }
      const fl = new Array(12).fill(0);
      for (let i = 0; i < 12; i++) { let s = 0; for (let j = 0; j < 12; j++) s += e.KeCond[i][j] * ul[j]; fl[i] = s; }
      for (const c of COMPS) {
        const key = `${e.id}:${c.end}:${c.axis}`;
        if (hinged.has(key)) { if (!dropped.has(key)) hingeDef.push({ key, dl: c.dl, rot: c.rot, vrate: plasticRate(ul, c, e.L) }); continue; }
        const cap = capOf(e.id, c.axis); if (!isFinite(cap)) continue;   // no capacity → doesn't yield
        rates.push({ key, elemId: e.id, end: c.end, axis: c.axis, dofLocal: c.dl, rot: c.rot, mr: fl[c.dl], cap });
      }
    }

    // Δλ to the next YIELD (the force reaches ±cap of the component)
    let dlam = Infinity;
    const cand = [];
    for (const r of rates) {
      if (Math.abs(r.mr) < 1e-12) continue;
      const M0 = Macc.get(r.key) || 0;
      let best = Infinity;
      for (const tgt of [r.cap, -r.cap]) { const dl = (tgt - M0) / r.mr; if (dl > 1e-9 && dl < best) best = dl; }
      if (isFinite(best)) { cand.push({ r, dl: best }); if (best < dlam) dlam = best; }
    }
    // Δλ to the next DROP (plastic deformation reaches θu/δu) — ductile-with-drop
    if (dropMode) for (const h of hingeDef) {
      const defCap = h.rot ? thetaU : deltaU; if (!isFinite(defCap) || defCap === 0) continue;
      if (Math.abs(h.vrate) < 1e-15) continue;
      const dl = (defCap - Math.abs(thetaP.get(h.key) || 0)) / Math.abs(h.vrate);
      if (dl < dlam) dlam = Math.max(0, dl);
    }
    if (!isFinite(dlam)) break;   // no more yielding or drops → done

    lambda += dlam;
    for (const r of rates) Macc.set(r.key, (Macc.get(r.key) || 0) + dlam * r.mr);
    for (const h of hingeDef) thetaP.set(h.key, (thetaP.get(h.key) || 0) + dlam * h.vrate);
    for (let i = 0; i < nDOF; i++) u[i] += dlam * uUnit[i];
    let dctrl = 0;
    for (const node of model.nodes.values()) { const d = getNodeDOFs(nodeIndex, node.id); dctrl = Math.max(dctrl, Math.hypot(u[d[0]], u[d[1]], u[d[2]])); }
    const tol = Math.max(1e-9, dlam * 1e-6);

    // FORM the components that yield at this λ (N/V/M hinge)
    const fragilNow = [];
    for (const c of cand) {
      if (c.dl > dlam + tol) continue;
      releasesByElem.get(c.r.elemId)[c.r.dofLocal] = 1; hinged.add(c.r.key); thetaP.set(c.r.key, 0);
      const nd = model.elements.get(c.r.elemId);
      events.push({ lambda, elemId: c.r.elemId, nodeId: c.r.end === 1 ? nd.n1 : nd.n2, axis: c.r.axis, dctrl });
      if ((c.r.rot ? thetaU : deltaU) === 0) fragilNow.push({ key: c.r.key, elemId: c.r.elemId, dofLocal: c.r.dofLocal, end: c.r.end, axis: c.r.axis, M_form: Macc.get(c.r.key) || 0 });
    }
    // DROPS from reaching ultimate deformation (ductile-with-drop)
    const reached = [];
    if (dropMode) for (const h of hingeDef) {
      const defCap = h.rot ? thetaU : deltaU; if (!isFinite(defCap) || defCap === 0) continue;
      if (Math.abs(thetaP.get(h.key) || 0) >= defCap - 1e-9) { const p = h.key.split(':'); reached.push({ key: h.key, elemId: +p[0], dofLocal: h.dl, end: +p[1], axis: p[2], M_form: Macc.get(h.key) || 0 }); }
    }
    // Process the drops (brittle-immediate + θu/δu-reached) with cascade
    const dq = fragilNow.concat(reached);
    if (dq.length && applyDrops(dq)) { collapsed = true; break; }
  }

  if (!events.length) return { ok: false, reason: 'no-hinges', collapsed };
  return { ok: true, events, lambda, collapsed, u, nodeIndex, nCasos };
}
