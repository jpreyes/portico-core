// test_plastic.mjs — the event-by-event plastic-hinge pushover (js/solver/plastic.js)
// against CLOSED-FORM rigid-plastic collapse loads. Now that the solver lives outside
// app.js it can be validated on its own; before, this engine ran only behind the DOM.
//
// Rigid-plastic collapse multipliers are independent of EI, so the checks pin the
// COLLAPSE MULTIPLIER λc (reference load × λc = collapse load) and the hinge sequence:
//
//   (1) Cantilever, tip load P0, span L:   1 hinge at the root → λc = Mp/(P0·L)
//   (2) Propped cantilever (fixed–roller), central load P0, span L:
//         first hinge at the fixed end at λ1 = Mp/(3·P0·L/16),
//         mechanism at λc = 6·Mp/(P0·L)   (two hinges: fixed end + under the load)
//
// Run:  node test_plastic.mjs
import { solvePlastic } from './js/solver/plastic.js';
import { Model } from './js/model/model.js';

let failures = 0;
const check = (cond, msg, extra = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const rel = (a, b) => Math.abs(b) < 1e-15 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b);

// Planar (x–z) model factory: material, rigid-shear section, 2D mode (uy,rx,rz locked).
function planar() {
  const m = new Model(); m.mode = '2D';
  m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'S', E: 2.1e8, G: 8.0e7, nu: 0.3125, rho: 0 });
  const sec = m.addSection({ name: 'C', A: 0.01, Iy: 8e-5, Iz: 8e-5, J: 1e-6,
    Avy: 1e30, Avz: 1e30, kappay: 1, kappaz: 1 });
  return { m, mat: mat.id, sec: sec.id };
}
// Moment hinges only (Mp on My/Mz); axial/shear never yield.
const momentCaps = (m, Mp) => {
  const cap = new Map();
  for (const el of m.elements.values()) cap.set(el.id, { N: Infinity, Vy: Infinity, Vz: Infinity, My: Mp, Mz: Mp });
  return cap;
};

// ── (1) Cantilever, tip load: first yield IS collapse ─────────────────────────
console.log('── (1) cantilever + tip load → λc = Mp/(P0·L) ──');
{
  const L = 3, P0 = 10, Mp = 100;
  const { m, mat, sec } = planar();
  const A = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const B = m.addNode(L, 0, 0);
  m.addElement(A.id, B.id, mat, sec);
  const lc = m.addLoadCase('P');
  m.addLoad(lc.id, { type: 'nodal', nodeId: B.id, F: [0, 0, -P0, 0, 0, 0] });

  const res = solvePlastic(m, {
    capByElem: momentCaps(m, Mp),
    contribs: [{ lcId: lc.id, factor: 1, selfWeight: false }],
  });
  check(res.ok, 'solver returned a result', res.ok ? '' : `(reason ${res.reason})`);
  check(res.collapsed, 'mechanism reached (cantilever hinge = mechanism)');
  check(rel(res.lambda, Mp / (P0 * L)) < 1e-6, 'λc = Mp/(P0·L) = 3.333', `(${res.lambda?.toFixed(5)})`);
  check(res.events.length === 1, 'exactly one hinge', `(${res.events.length})`);
  check(res.events[0].nodeId === A.id && /^M[yz]$/.test(res.events[0].axis),
    'a moment hinge forms at the fixed end', `(${res.events[0].axis})`);
}

// ── (2) Propped cantilever, central load: two-hinge redistribution ────────────
console.log('\n── (2) propped cantilever + central load → λc = 6·Mp/(P0·L) ──');
{
  const L = 4, P0 = 10, Mp = 100;
  const { m, mat, sec } = planar();
  const A = m.addNode(0,   0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });   // fixed
  const C = m.addNode(L/2, 0, 0);                                                  // load point
  const B = m.addNode(L,   0, 0, { uz: 1 });                                       // vertical roller
  m.addElement(A.id, C.id, mat, sec);
  m.addElement(C.id, B.id, mat, sec);
  const lc = m.addLoadCase('P');
  m.addLoad(lc.id, { type: 'nodal', nodeId: C.id, F: [0, 0, -P0, 0, 0, 0] });

  const res = solvePlastic(m, {
    capByElem: momentCaps(m, Mp),
    contribs: [{ lcId: lc.id, factor: 1, selfWeight: false }],
  });
  check(res.ok, 'solver returned a result', res.ok ? '' : `(reason ${res.reason})`);
  check(res.collapsed, 'mechanism reached');
  check(rel(res.lambda, 6 * Mp / (P0 * L)) < 1e-4, 'λc = 6·Mp/(P0·L) = 15', `(${res.lambda?.toFixed(5)})`);
  // First hinge at the fixed end (M_A = 3PL/16 is the largest elastic moment).
  check(res.events[0].nodeId === A.id, 'first hinge at the fixed end (before the load point)');
  check(rel(res.events[0].lambda, Mp / (3 * P0 * L / 16)) < 1e-4,
    'first hinge at λ1 = Mp/(3·P0·L/16) = 13.333', `(${res.events[0].lambda?.toFixed(4)})`);
  check(res.events.some(e => e.nodeId === C.id), 'a later hinge forms under the load');
}

// ── (3) Diagnostics: the solver names why it cannot run ───────────────────────
console.log('\n── (3) structured refusals (no toast layer) ──');
{
  const { m, mat, sec } = planar();
  const A = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const B = m.addNode(3, 0, 0);
  m.addElement(A.id, B.id, mat, sec);
  const cap = momentCaps(m, 100);

  const noLoads = solvePlastic(m, { capByElem: cap, contribs: [] });
  check(!noLoads.ok && noLoads.reason === 'no-loads', 'empty pattern → reason "no-loads"', `(${noLoads.reason})`);

  const emptyLc = m.addLoadCase('empty');   // a case that carries no loads
  const nullPat = solvePlastic(m, { capByElem: cap, contribs: [{ lcId: emptyLc.id, factor: 1, selfWeight: false }] });
  check(!nullPat.ok && nullPat.reason === 'null-pattern', 'zero-load pattern → reason "null-pattern"', `(${nullPat.reason})`);
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
