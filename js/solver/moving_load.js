// ──────────────────────────────────────────────────────────────────────────────
// moving_load.js — MOVING LOADS and INFLUENCE LINES · #61
//
// A load train (truck, railway axle) travels along a "lane" over the structure.
// For each position the static problem is solved and the response of interest is
// recorded (reaction, moment/shear at a section). The sweep yields:
//   · INFLUENCE LINE: response to a moving UNIT load, as a function of the load
//     position → R(s). (For a simple beam, IL of the left reaction = 1 − x/L;
//     IL of the midspan moment = triangle with peak L/4.)
//   · ENVELOPE: maxima and minima of the response over all positions of the train
//     → deck design for traffic.
//
// Optimization: the K matrix is CONSTANT (the structure does not change); it is
// factored ONCE (LU) and only the load vector F is rebuilt per position → fast sweeps.
//
// Convention: the train load is VERTICAL downward (−Z); its magnitude P>0.
// The point load is distributed to the nodes of the element that contains it via
// Hermite shape functions (consistent nodal forces and moments → exact response).
// ──────────────────────────────────────────────────────────────────────────────
import { buildNodeIndex, assembleK, assembleF, getNodeDOFs } from './assembler.js?v=6';
import { Results } from './postprocess.js?v=6';

const NUM = () => (typeof window !== 'undefined' && window.numeric) || (typeof globalThis !== 'undefined' && globalThis.numeric);

// ── Lane: ordered path of collinear/contiguous elements ─────────────────────────
/**
 * @param {Model} model
 * @param {number[]} elemIds  elements in order along the lane.
 * @returns lane = { elems, lens, L, accum }  (accum[i] = distance to the start of elem i)
 */
export function buildLane(model, elemIds) {
  const elems = elemIds.map(id => model.elements.get(id)).filter(Boolean);
  if (!elems.length) throw new Error('pista (lane) vacía');
  const lens = elems.map(e => {
    const a = model.nodes.get(e.n1), b = model.nodes.get(e.n2);
    return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  });
  const accum = []; let s = 0; for (const l of lens) { accum.push(s); s += l; }
  return { elems, lens, accum, L: s };
}

// Model loads (consistent nodal) of a vertical load P (↓, P>0) at distance x from
// the start of the lane. Cubic Hermite → nodal forces + moments.
export function laneLoadAt(model, lane, x, P) {
  if (x < -1e-9 || x > lane.L + 1e-9) return [];          // outside the lane
  let idx = 0; while (idx < lane.elems.length - 1 && x > lane.accum[idx] + lane.lens[idx] + 1e-9) idx++;
  const el = lane.elems[idx], Le = lane.lens[idx];
  const xi = Math.min(Math.max((x - lane.accum[idx]) / Le, 0), 1);
  const N1 = 1 - 3 * xi * xi + 2 * xi ** 3, N2 = 3 * xi * xi - 2 * xi ** 3;
  const Hb1 = Le * (xi - 2 * xi * xi + xi ** 3), Hb2 = Le * (-xi * xi + xi ** 3);
  const Fz = -P;                                           // ↓
  const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
  // Bending moment in the X–Z plane associated with the vertical load → My.
  return [
    { type: 'nodal', nodeId: n1.id, F: [0, 0, Fz * N1, 0, -Fz * Hb1, 0] },
    { type: 'nodal', nodeId: n2.id, F: [0, 0, Fz * N2, 0, -Fz * Hb2, 0] },
  ];
}

// ── Prepared linear solver (K factored once) ────────────────────────────────────
function prepare(model) {
  const num = NUM(); if (!num) throw new Error('numeric.js no está disponible');
  const ni = buildNodeIndex(model);
  const nDOF = ni.size * 6;
  const { K } = assembleK(model, ni);
  const is2D = model.mode === '2D';
  const freeDOF = [], fixedDOF = [];
  const dofNames = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'];
  for (const node of model.nodes.values()) {
    const d = getNodeDOFs(ni, node.id), r = node.restraints, pd = node.prescDisp;
    const rArr = [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz];
    d.forEach((gi, li) => { (rArr[li] || (pd && (+pd[dofNames[li]] || 0) !== 0)) ? fixedDOF.push(gi) : freeDOF.push(gi); });
  }
  if (!freeDOF.length) throw new Error('modelo sin GDL libres');
  const nF = freeDOF.length;
  const Kff = Array.from({ length: nF }, (_, i) => { const row = new Array(nF), ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) row[j] = K[ri + freeDOF[j]]; return row; });
  const lu = num.LU(Kff);
  return { num, ni, nDOF, K, freeDOF, fixedDOF, lu };
}

function makeView(model, loads) {
  const lc = { id: -1, name: '_ml', loads, selfWeight: false, type: 'static', specDir: null };
  return { nodes: model.nodes, elements: model.elements, areas: model.areas, diaphragms: model.diaphragms,
           materials: model.materials, sections: model.sections, loadCases: new Map([[-1, lc]]),
           combinations: new Map(), mode: model.mode, units: model.units };
}

// Solves for a given set of loads, reusing the LU factorization.
function solveLoads(prep, model, loads) {
  const { num, ni, nDOF, K, freeDOF, fixedDOF, lu } = prep;
  const view = makeView(model, loads);
  const F = assembleF(view, ni, -1, false);
  const Ff = freeDOF.map(d => F[d]);
  const uf = num.LUsolve(lu, Ff);
  const u = new Float64Array(nDOF);
  freeDOF.forEach((d, i) => { u[d] = uf[i]; });
  const reactions = new Float64Array(nDOF);
  for (const gi of fixedDOF) { let s = 0; const ri = gi * nDOF; for (let j = 0; j < nDOF; j++) s += K[ri + j] * u[j]; reactions[gi] = s - F[gi]; }
  return new Results(view, ni, u, reactions, F, -1, false);
}

/**
 * Influence line of a response to a moving unit load (↓).
 * @param {Model} model
 * @param {object} lane     buildLane(...)
 * @param {(res)=>number} response  evaluator (see responseXXX helpers)
 * @param {object} opts     { nPos = 41, P = 1 }
 * @returns { s:[…], value:[…], max, min, sMax, sMin }
 */
export function influenceLine(model, lane, response, opts = {}) {
  const nPos = opts.nPos || 41, P = opts.P ?? 1;
  const prep = prepare(model);
  const s = [], value = [];
  let max = -Infinity, min = Infinity, sMax = 0, sMin = 0;
  for (let i = 0; i < nPos; i++) {
    const x = lane.L * i / (nPos - 1);
    const loads = laneLoadAt(model, lane, x, P);
    const v = loads.length ? response(solveLoads(prep, model, loads)) : 0;
    s.push(x); value.push(v);
    if (v > max) { max = v; sMax = x; }
    if (v < min) { min = v; sMin = x; }
  }
  return { s, value, max, min, sMax, sMin };
}

/**
 * Envelope of one or several responses to a moving load TRAIN.
 * @param {Model} model
 * @param {object} lane
 * @param {Array}  train   axles: [{ offset, P }]  (offset = distance to the
 *                         reference axle, m; P = load ↓, kN)
 * @param {Object<string,(res)=>number>} responses  name→evaluator map
 * @param {object} opts    { nPos = 81, x0 = -trainLen, x1 = lane.L }
 * @returns { positions:[…], series:{name:[…]}, env:{name:{max,min,atMax,atMin}} }
 */
export function movingLoadEnvelope(model, lane, train, responses, opts = {}) {
  const prep = prepare(model);
  const offsets = train.map(t => t.offset || 0);
  const trainLen = Math.max(...offsets) - Math.min(...offsets);
  const nPos = opts.nPos || 81;
  const x0 = opts.x0 ?? -Math.min(...offsets);
  const x1 = opts.x1 ?? (lane.L - Math.max(...offsets));
  const names = Object.keys(responses);
  const series = {}; names.forEach(n => series[n] = []);
  const env = {}; names.forEach(n => env[n] = { max: -Infinity, min: Infinity, atMax: 0, atMin: 0 });
  const positions = [];

  for (let i = 0; i < nPos; i++) {
    const ref = x0 + (x1 - x0) * i / (nPos - 1);
    const loads = [];
    for (const ax of train) {
      const x = ref + (ax.offset || 0);
      if (x < -1e-9 || x > lane.L + 1e-9) continue;        // axle off the bridge
      for (const l of laneLoadAt(model, lane, x, ax.P)) loads.push(l);
    }
    positions.push(ref);
    if (!loads.length) { names.forEach(n => series[n].push(0)); continue; }
    const res = solveLoads(prep, model, loads);
    for (const n of names) {
      const v = responses[n](res);
      series[n].push(v);
      const e = env[n];
      if (v > e.max) { e.max = v; e.atMax = ref; }
      if (v < e.min) { e.min = v; e.atMin = ref; }
    }
  }
  return { positions, series, env, trainLen };
}

// ── Response evaluators (helpers) ────────────────────────────────────────────────
const COMP = { Fx: 0, Fy: 1, Fz: 2, Mx: 3, My: 4, Mz: 5 };
// Reaction at a support (component Fx..Mz).
export const responseReaction = (nodeId, comp = 'Fz') => (res) => res.getReaction(nodeId)[COMP[comp]];
// End force of an element (key N, Vy1, Mz1, …).
export const responseElemForce = (elemId, key) => (res) => res.getElemForces(elemId)?.[key] ?? 0;
// Force at an interior section of the element (xi∈[0,1]): N|Vy|Vz|T|My|Mz.
export const responseSection = (elemId, xi, key) => (res) => res.getElemAtXi(elemId, xi)?.[key] ?? 0;
// Nodal displacement (component).
export const responseDisp = (nodeId, comp = 'uz') => {
  const map = { ux: 0, uy: 1, uz: 2, rx: 3, ry: 4, rz: 5 };
  return (res) => res.getNodeDisp(nodeId)[map[comp]];
};

/**
 * Compose a full moving-load analysis from a resolved config: build the lane, pick the
 * response probe (a support reaction or a section force), then run either the influence
 * line (unit load sweep) or the train envelope, and shape the flat result the plot
 * consumes. Headless — the dialog and the chart stay in the caller (app.js). This is the
 * composition runMovingLoad performed inline; the primitives above are unchanged.
 *
 * @param {Model}  model
 * @param {object} cfg
 * @param {number[]} cfg.laneIds        lane element ids, in travel order
 * @param {'il'|'env'} cfg.mode         influence line or train envelope
 * @param {number}  cfg.nPos            sweep positions
 * @param {'reaction'|'section'} cfg.respType
 * @param {number} [cfg.nodeId] @param {string} [cfg.comp]           (reaction)
 * @param {number} [cfg.elemId] @param {number} [cfg.xi] @param {string} [cfg.key]  (section)
 * @param {string}  cfg.label @param {string} cfg.unit
 * @param {{offset:number,P:number}[]} [cfg.train]   (env mode)
 * @returns {{mode, lane, label, unit, xs:number[], ys:number[], max, min, sMax, sMin, trainLen?}}
 */
export function computeMovingLoad(model, cfg) {
  const lane = buildLane(model, cfg.laneIds);
  const resp = cfg.respType === 'reaction'
    ? responseReaction(cfg.nodeId, cfg.comp)
    : responseSection(cfg.elemId, cfg.xi, cfg.key);
  if (cfg.mode === 'il') {
    const il = influenceLine(model, lane, resp, { nPos: cfg.nPos, P: 1 });
    return { mode: 'il', lane, label: cfg.label, unit: cfg.unit, xs: il.s, ys: il.value, max: il.max, min: il.min, sMax: il.sMax, sMin: il.sMin };
  }
  const env = movingLoadEnvelope(model, lane, cfg.train, { [cfg.label]: resp }, { nPos: cfg.nPos });
  const e = env.env[cfg.label];
  return { mode: 'env', lane, label: cfg.label, unit: cfg.unit, xs: env.positions, ys: env.series[cfg.label], max: e.max, min: e.min, sMax: e.atMax, sMin: e.atMin, trainLen: env.trainLen };
}
