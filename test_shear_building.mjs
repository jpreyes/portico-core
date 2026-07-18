// test_shear_building.mjs — the shear-building reduction + nonlinear time-history that
// used to live inside app.js's runNLTimeHistory (js/solver/shear_building.js).
//
//   (1) shearFreqs vs the CLOSED FORM of a uniform N-story shear building:
//         ω_r = 2·√(k/m)·sin( (2r−1)·π / (2(2N+1)) )   (Chopra)
//   (2) buildShearStories: a diaphragm model reduces to stories with the right mass,
//       ascending z, a positive interstory stiffness and the Cy=0.15 base-shear seed.
//   (3) runShearHistory (elastic): T₁ matches the closed-form fundamental and, with a
//       huge yield force, no story yields.
//
// Run:  node test_shear_building.mjs
import './lib/numeric.js';
import { buildShearStories, shearFreqs, runShearHistory } from './js/solver/shear_building.js';
import { G as GACC } from './js/solver/accelerograms.js';
import { Model } from './js/model/model.js';
globalThis.window = globalThis;

let failures = 0;
const check = (cond, msg, extra = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const rel = (a, b) => Math.abs(b) < 1e-15 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b);

// ── (1) shearFreqs vs the uniform-building closed form ────────────────────────
console.log('── (1) shearFreqs = 2√(k/m)·sin((2r−1)π/(2(2N+1))) ──');
{
  const N = 3, m = 1, k = 10;
  const w = shearFreqs(Array(N).fill(m), Array(N).fill(k));       // ascending ω
  const wExact = r => 2 * Math.sqrt(k / m) * Math.sin((2 * r - 1) * Math.PI / (2 * (2 * N + 1)));
  check(w.length === N, 'three frequencies');
  for (let r = 1; r <= N; r++)
    check(rel(w[r - 1], wExact(r)) < 1e-9, `ω${r} matches the closed form`, `(${w[r - 1].toFixed(5)} vs ${wExact(r).toFixed(5)})`);
  check(w[0] < w[1] && w[1] < w[2], 'returned ascending');
}

// ── (2) buildShearStories: model → stories ────────────────────────────────────
console.log('\n── (2) buildShearStories reduces a diaphragm model ──');
{
  const m = new Model(); m.mode = '2D';
  m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'S', E: 2.1e8, G: 8e7, nu: 0.3, rho: 0 });
  const sec = m.addSection({ name: 'C', A: 0.02, Iy: 4e-4, Iz: 4e-4, J: 1e-5 });
  const N0 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });   // fixed base
  const N1 = m.addNode(0, 0, 3);
  const N2 = m.addNode(0, 0, 6);
  m.addElement(N0.id, N1.id, mat.id, sec.id);   // column, cantilever line
  m.addElement(N1.id, N2.id, mat.id, sec.id);
  const m1 = 120, m2 = 90;
  m.addDiaphragm({ name: 'P1', z: 3, nodes: [N1.id], mass: { m: m1, Icm: 0 } });
  m.addDiaphragm({ name: 'P2', z: 6, nodes: [N2.id], mass: { m: m2, Icm: 0 } });

  const st = buildShearStories(m, 'X');
  check(st.length === 2, 'two stories', `(${st.length})`);
  check(st[0].z === 3 && st[1].z === 6, 'sorted by z ascending');
  check(st[0].m === m1 && st[1].m === m2, 'mass taken from the diaphragms');
  check(st[0].k > 0 && st[1].k > 0, 'positive interstory stiffness from the static solve',
    `(k=${st[0].k.toFixed(0)}, ${st[1].k.toFixed(0)})`);
  const g = GACC || 9.80665;
  check(rel(st[0].Vy, 0.15 * g * (m1 + m2)) < 1e-9, 'Vy₁ = 0.15·g·Σm above', `(${st[0].Vy.toFixed(1)})`);
  check(rel(st[1].Vy, 0.15 * g * m2) < 1e-9, 'Vy₂ = 0.15·g·m₂');
}

// ── (3) runShearHistory (elastic): T₁ closed form, no yielding ────────────────
console.log('\n── (3) runShearHistory: elastic response ──');
{
  // Uniform 2-story building, huge yield force → stays elastic; T₁ = 2π/ω₁.
  const N = 2, mm = 1, kk = 100, Vy = 1e12;
  const w1Exact = 2 * Math.sqrt(kk / mm) * Math.sin(Math.PI / (2 * (2 * N + 1)));
  const T1Exact = 2 * Math.PI / w1Exact;
  const stories = [
    { z: 3, m: mm, k: kk, Vy, label: '1', nodes: [] },
    { z: 6, m: mm, k: kk, Vy, label: '2', nodes: [] },
  ];
  // Small synthetic ground motion (a decaying sine), well within the elastic range.
  const dt = 0.02, ns = 300, f = 1.5;
  const ag = Array.from({ length: ns }, (_, i) => 0.05 * Math.sin(2 * Math.PI * f * i * dt) * Math.exp(-i * dt / 3));

  const res = runShearHistory({ stories, dir: 'X', zeta: 0.05, alpha: 0.03, ag, dt, agName: 'test', driftCode: 'NCh433' });
  check(rel(res.T1, T1Exact) < 1e-6, 'T₁ = 2π/ω₁ (closed form)', `(${res.T1.toFixed(5)} vs ${T1Exact.toFixed(5)})`);
  check(res.yielded.length === 2 && res.yielded.every(y => y === false), 'no story yields (huge Vy)');
  check(res.U.length > 0 && Number.isFinite(res.peak), 'produced a response history', `(${res.U.length} steps, peak ${res.peak.toExponential(2)})`);
  check(res.driftPeak.length === 2 && Number.isFinite(res.worstDrift.ratio), 'per-story peak drift + code ratio computed');
  check(res.stats && Number.isFinite(res.stats.pga ?? res.stats.PGA ?? NaN) || res.stats != null, 'accelerogram stats attached');
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
