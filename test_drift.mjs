// test_drift.mjs — the interstory-drift primitive. Pure geometry, code-agnostic.
// Anchors on hand-computed drifts and on the drift-vs-limit split (the limit comes from
// serviceability.js, never from this module).
//
// Run:  node test_drift.mjs
import { interstoryDrifts, buildStoryLevels } from './js/solver/drift.js';
import { driftLimit, checkDrift } from './js/design/serviceability.js';
import { Model } from './js/model/model.js';

let failures = 0;
const check = (cond, msg, extra = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const rel = (a, b) => Math.abs(b) < 1e-15 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b);

// ── (1) Hand-computed drifts from a displacement series ───────────────────────
console.log('── (1) drift = |Δu|/h between consecutive levels ──');
{
  // 3 floors at z = 3, 6, 9; lateral disp u = 0.006, 0.015, 0.021 (base u=0 at z=0).
  //   story1: |0.006-0|/3    = 0.002
  //   story2: |0.015-0.006|/3 = 0.003
  //   story3: |0.021-0.015|/3 = 0.002
  const levels = [{ z: 3, u: 0.006 }, { z: 6, u: 0.015 }, { z: 9, u: 0.021 }];
  const d = interstoryDrifts(levels);
  check(d.length === 3, 'three stories', `(${d.length})`);
  check(rel(d[0].drift, 0.002) < 1e-12, 'story 1 drift = 0.002', `(${d[0].drift})`);
  check(rel(d[1].drift, 0.003) < 1e-12, 'story 2 drift = 0.003', `(${d[1].drift})`);
  check(rel(d[2].drift, 0.002) < 1e-12, 'story 3 drift = 0.002', `(${d[2].drift})`);
  check(d[0].h === 3 && d[1].h === 3, 'heights taken from z differences');
}

// ── (2) Order independence + negative displacements ───────────────────────────
console.log('\n── (2) unsorted input, signed displacements ──');
{
  const shuffled = [{ z: 6, u: -0.015 }, { z: 3, u: -0.006 }, { z: 9, u: -0.021 }];
  const d = interstoryDrifts(shuffled);
  check(d.map(s => s.z).join(',') === '3,6,9', 'sorted by z internally');
  check(rel(d[1].drift, 0.003) < 1e-12, 'drift uses |Δu| (sign-agnostic)', `(${d[1].drift})`);
}

// ── (3) The primitive carries no limit; the code layer supplies it ────────────
console.log('\n── (3) primitive has no code knowledge; serviceability.js has the limit ──');
{
  const d = interstoryDrifts([{ z: 3, u: 0.009 }]);   // drift = 0.003
  check(!('limit' in d[0]) && !('ok' in d[0]) && !('ratio' in d[0]),
    'drift result carries no limit/ok/ratio');
  // The caller checks against a code — NCh433 fails 0.003 > 0.002, ASCE7 passes.
  const nch = checkDrift({ drift: d[0].du, h: d[0].h, code: 'NCh433' });
  const asce = checkDrift({ drift: d[0].du, h: d[0].h, code: 'ASCE7' });
  check(driftLimit('NCh433') === 0.002, 'driftLimit(NCh433) = 0.002 (from serviceability.js)');
  check(nch.ratio > 1, 'NCh433: 0.003 exceeds 0.002 (ratio>1)', `(${nch.ratio})`);
  check(asce.ratio < 1, 'ASCE7: 0.003 within 0.020 (ratio<1)', `(${asce.ratio})`);
}

// ── (4) buildStoryLevels: CM (diaphragm master) vs external nodes ─────────────
console.log('\n── (4) levels from a model: CM master vs external nodes ──');
{
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'S', E: 2.1e8, G: 8e7, nu: 0.3, rho: 0 });
  // two floors; each floor a master node + one offset node.
  const b = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const m1 = m.addNode(0, 0, 3), e1 = m.addNode(5, 0, 3);
  const m2 = m.addNode(0, 0, 6), e2 = m.addNode(5, 0, 6);
  m.addDiaphragm({ name: 'Piso 1', z: 3, nodes: [m1.id, e1.id], masterId: m1.id });
  m.addDiaphragm({ name: 'Piso 2', z: 6, nodes: [m2.id, e2.id], masterId: m2.id });
  // fake displacement field: master smaller, external larger (torsion).
  const U = { [m1.id]: 0.003, [e1.id]: 0.006, [m2.id]: 0.009, [e2.id]: 0.015, [b.id]: 0 };
  const dispOf = id => U[id] ?? 0;

  const cm  = interstoryDrifts(buildStoryLevels(m, dispOf, { mode: 'cm' }));
  const ext = interstoryDrifts(buildStoryLevels(m, dispOf, { mode: 'ext' }));
  check(rel(cm[0].drift, 0.001) < 1e-12, 'CM story1 = |0.003|/3 = 0.001', `(${cm[0].drift})`);
  check(rel(ext[0].drift, 0.002) < 1e-12, 'EXT story1 = |0.006|/3 = 0.002', `(${ext[0].drift})`);
  check(cm[0].drift < ext[0].drift, 'external drift ≥ CM drift (same drift, different point)');
  // auto picks CM because diaphragms exist
  const auto = interstoryDrifts(buildStoryLevels(m, dispOf, { mode: 'auto' }));
  check(rel(auto[0].drift, cm[0].drift) < 1e-15, "auto = CM when diaphragms exist");
}

// ── (5) buildStoryLevels falls back to nodes-by-z with no diaphragms ──────────
console.log('\n── (5) no diaphragms → group nodes by z ──');
{
  const m = new Model(); m.materials.clear(); m.sections.clear();
  m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1 });
  const a = m.addNode(0, 0, 4), c = m.addNode(3, 0, 4);
  const U = { [a.id]: 0.004, [c.id]: 0.012 };
  const lv = buildStoryLevels(m, id => U[id] ?? 0, { mode: 'auto' });
  check(lv.length === 1 && Math.abs(lv[0].z - 4) < 1e-9, 'one level at z=4 (base skipped)');
  check(rel(lv[0].u, 0.012) < 1e-12, 'level u = worst node (0.012)', `(${lv[0].u})`);
  const d = interstoryDrifts(lv);
  check(rel(d[0].drift, 0.003) < 1e-12, 'drift = 0.012/4 = 0.003', `(${d[0].drift})`);
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
