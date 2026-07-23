// ──────────────────────────────────────────────────────────────────────────────
// shear_building.js — reduce a 3D model to an elastoplastic SHEAR BUILDING and run
// its nonlinear time-history. Composition layer over the primitives:
//   · StaticSolver          (a lateral static analysis gives the interstory stiffness)
//   · shearBuilding / rayleighDamping / newmarkNonlinear   (nl_timehistory.js engine)
//   · checkDrift (serviceability.js) · accStats (accelerograms.js)
//
// This was inlined in app.js's runNLTimeHistory: the model→stories reduction
// (_nlthBuildStories), the shear-building frequencies (_shearFreqs) and the
// Newmark orchestration with the drift/yield post-processing. Here they are pure
// functions; the dialogs, progress, toasts and overlay stay in app.js.
//
// Note: buildShearStories and shearFreqs need `window.numeric` (the static solve and
// the symmetric eigenproblem), like the rest of the linear-algebra layer.
// ──────────────────────────────────────────────────────────────────────────────
import { StaticSolver } from './static_solver.js?v=7';
import { shearBuilding, rayleighDamping, newmarkNonlinear } from './nl_timehistory.js?v=7';
import { checkDrift } from '../design/serviceability.js?v=7';
import { accStats, G as GACC } from './accelerograms.js?v=7';

/**
 * Reduce the model to a shear building: one story per rigid diaphragm (sorted by z),
 * diaphragm mass per story, and interstory stiffness k = V/Δ from a static lateral
 * analysis with a mass-proportional load. Vy seeds a base-shear coefficient Cy=0.15.
 *
 * @param {Model}  model
 * @param {string} dir   'X' or 'Y' — lateral direction
 * @returns {{z:number, m:number, k:number, Vy:number, label:string, nodes:number[]}[]}
 */
export function buildShearStories(model, dir) {
  const dias = [...model.diaphragms.values()].filter(d => (d.nodes || []).length).sort((a, b) => a.z - b.z);
  if (!dias.length) return [];
  const ci = dir === 'Y' ? 1 : 0;
  const g = GACC || 9.80665;
  // Mass per story (from the diaphragm).
  const masses = dias.map(d => +d.mass?.m || 0);
  // Lateral load ∝ mass, distributed over the diaphragm's nodes.
  const lc = { id: -9, name: '_nlth', selfWeight: false, type: 'static', specDir: null, loads: [] };
  dias.forEach((d, i) => {
    const p = masses[i] || 1; const per = p / d.nodes.length;
    for (const nid of d.nodes) { const F = [0, 0, 0, 0, 0, 0]; F[ci] = per; lc.loads.push({ type: 'nodal', nodeId: nid, F }); }
  });
  const view = { nodes: model.nodes, elements: model.elements, areas: model.areas, diaphragms: model.diaphragms,
    materials: model.materials, sections: model.sections, links: model.links,
    loadCases: new Map([[-9, lc]]), combinations: new Map(), mode: model.mode, units: model.units };
  let R; try { R = new StaticSolver().solve(view, -9, false); } catch (e) { R = null; }
  // Lateral displacement of each story = average of its nodes in the direction.
  const uFloor = dias.map(d => {
    if (!R) return 0; let s = 0, c = 0;
    for (const nid of d.nodes) { const u = R.getNodeDisp(nid); if (u) { s += u[ci]; c++; } }
    return c ? s / c : 0;
  });
  // Story shear (accumulated from the top) and interstory stiffness k=V/Δ.
  const stories = [];
  for (let i = 0; i < dias.length; i++) {
    let V = 0; for (let j = i; j < dias.length; j++) V += (masses[j] || 1);   // ∝ mass
    const uPrev = i > 0 ? uFloor[i - 1] : 0;
    const drift = uFloor[i] - uPrev;
    const k = (drift > 1e-12) ? V / drift : 0;
    const massAbove = masses.slice(i).reduce((a, b) => a + b, 0);
    const Vy = 0.15 * g * massAbove;                  // seed: Cy=0.15 · accumulated weight
    stories.push({ z: dias[i].z, m: masses[i], k, Vy, label: `Piso ${i + 1} (z=${dias[i].z.toFixed(2)})`, nodes: dias[i].nodes });
  }
  return stories;
}

/**
 * Natural frequencies of the shear building (tridiagonal K, diagonal M) via the
 * symmetric eigenproblem A = D^{-1/2}·K·D^{-1/2}. Returns ascending ω. Needs numeric.
 */
export function shearFreqs(m, k) {
  const n = m.length;
  const num = window.numeric;
  const K = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) { K[i][i] += k[i]; if (i > 0) { K[i - 1][i - 1] += k[i]; K[i][i - 1] -= k[i]; K[i - 1][i] -= k[i]; } }
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => K[i][j] / Math.sqrt(m[i] * m[j])));
  let ev;
  try { ev = num.eig(A).lambda.x.slice(); } catch (e) { ev = [Math.min(...k) / Math.max(...m)]; }
  return ev.map(l => Math.sqrt(Math.max(l, 1e-12))).sort((a, b) => a - b);
}

/**
 * Run the nonlinear time-history of the shear building and derive the drift / yield
 * post-processing. Newmark-β direct integration (bilinear interstory springs), Rayleigh
 * damping anchored at ω₁ and ω_N. Assumes each story already has mass and stiffness > 0.
 *
 * @param {object} o
 * @param {object[]} o.stories   from buildShearStories (or an edited table)
 * @param {string}  o.dir
 * @param {number}  o.zeta       damping ratio
 * @param {number}  o.alpha      post-yield stiffness ratio
 * @param {number[]} o.ag        ground acceleration series
 * @param {number}  o.dt         time step
 * @param {string}  [o.agName]
 * @param {string}  [o.driftCode='NCh433']  code for the interstory-drift limit
 * @returns {object}  the full _nlthResult shape (stories echoed + computed fields).
 */
export function runShearHistory({ stories, dir, zeta, alpha, ag, dt, agName, driftCode = 'NCh433' }) {
  const st = stories;
  const m = st.map(s => s.m), k = st.map(s => s.k), Vy = st.map(s => s.Vy);
  const n = st.length;

  const ws = shearFreqs(m, k);                 // frequencies of the shear building
  const w1 = ws[0], wN = ws[n - 1] || ws[0];
  const sb = shearBuilding({ m, k, Fy: Vy, alpha: m.map(() => alpha) });
  const { C } = rayleighDamping(sb.M, sb.resist.K0(), n, zeta, w1, wN);
  const res = newmarkNonlinear({ M: sb.M, resist: sb.resist, C, ag, dt, store: 'full', monitorDof: n - 1 });

  // Per-story derived: yield drift dy=Vy/k, peak drift, yielded flag.
  const dy = st.map((s, i) => s.Vy / s.k);
  const driftPeak = new Array(n).fill(0);
  for (const u of res.U) for (let i = 0; i < n; i++) { const d = Math.abs(u[i] - (i > 0 ? u[i - 1] : 0)); if (d > driftPeak[i]) driftPeak[i] = d; }
  const yielded = st.map((s, i) => driftPeak[i] > dy[i] * 1.0001);
  // Interstory drift Δ/h vs code limit (NCh433 by default, #68).
  let worstDrift = { ratio: 0, story: 0, dr: 0 };
  for (let i = 0; i < n; i++) {
    const h = st[i].z - (i > 0 ? st[i - 1].z : 0);
    const c = checkDrift({ drift: driftPeak[i], h, code: driftCode });
    if (c.ratio > worstDrift.ratio) worstDrift = { ratio: c.ratio, story: i, dr: c.demand, limit: c.limit };
  }
  const stats = accStats(ag, dt);
  const T1 = 2 * Math.PI / w1;

  return { stories: st, dir, zeta, alpha, ag, dt, agName, nSteps: res.U.length, U: res.U,
    monDof: n - 1, peak: res.peak, peakStep: res.peakStep, dy, driftPeak, yielded, stats, T1, w1, springs: sb.springs,
    driftCode, worstDrift };
}
