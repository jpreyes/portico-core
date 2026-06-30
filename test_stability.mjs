// Unified stability verdict — backend-agnostic sanity (drift/displacement) + the
// solver's structured mechanism/near-singular verdict. Guards the blind spot where a
// near-mechanism "solves" with garbage (rescued by a rigid diaphragm) without warning.
import fs from 'node:fs';
import { Model } from './js/model/model.js';
import { Serializer } from './js/model/serializer.js';
import { StaticSolver } from './js/solver/static_solver.js';
import { assessStabilitySanity, nearSingularWarning, STABILITY, STABILITY_LIMITS } from './js/solver/stability.js';
globalThis.window = globalThis;
await import('./lib/numeric.js');

let failures = 0;
const check = (cond, msg, extra='') => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  '+extra : ''}`); if (!cond) failures++; };

// ── (1) Drift sanity catches the rescued near-mechanism (the headline case) ──
console.log('── (1) Drift sanity: rescued near-mechanism vs well-restrained ──');
function loadPortico(bad) {
  const m = new Serializer().fromJSON(fs.readFileSync('./examples/portico_simple.s3d', 'utf8'));
  if (bad) for (const n of m.nodes.values()) {
    if (n.id === 1 || n.id === 2) n.restraints = { ux:0, uy:0, uz:1, rx:0, ry:0, rz:0 };  // vertical roller
    if (n.id === 5) n.restraints = { ux:1, uy:1, uz:1, rx:0, ry:0, rz:0 };                // pinned
  }
  return m;
}
{
  const bad = loadPortico(true), good = loadPortico(false);
  const rb = new StaticSolver().solve(bad, 3, false);   // Seismic X
  const rg = new StaticSolver().solve(good, 3, false);
  const wb = assessStabilitySanity(bad, rb), wg = assessStabilitySanity(good, rg);
  check(wb.some(w => w.code === STABILITY.DRIFT), 'BAD bases (3 rollers) → DRIFT warning', `(${wb.map(w=>w.code).join(',')||'none'})`);
  check(wg.length === 0, 'GOOD bases (all fixed) → no warning (no false positive)', `(${wg.map(w=>w.code).join(',')||'none'})`);
  const dw = wb.find(w => w.code === STABILITY.DRIFT);
  check(dw && dw.params.ratio > STABILITY_LIMITS.driftRatio, 'drift ratio exceeds H/20 limit', `(H/${(1/dw.params.ratio).toFixed(0)})`);
}

// ── (2) Near-singular pivot helper (PART 1, solver-level) ────────────────────
console.log('\n── (2) nearSingularWarning(pivotRatio) ──');
check(nearSingularWarning(1e-15)?.code === STABILITY.ILL_CONDITIONED, 'ratio 1e-15 → ILL_CONDITIONED');
check(nearSingularWarning(1e-6) === null, 'ratio 1e-6 → null (well conditioned)');
check(nearSingularWarning(STABILITY_LIMITS.pivotRatio) === null, 'ratio == limit → null (strict <)');

// ── (3) Hard mechanism → structured error verdict (vocabulary shared w/ Nodex) ─
console.log('\n── (3) Hard mechanism → structured err.stability ──');
{
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name:'S', E:2.1e11, G:8e10, nu:0.3125, rho:0 });
  const sec = m.addSection({ name:'C', A:0.01, Iy:8e-6, Iz:8e-6, J:1e-6, Avy:1e30, Avz:1e30 });
  const a = m.addNode(0,0,0,{});   // NO supports → rigid-body mechanism
  const b = m.addNode(3,0,0,{});
  m.addElement(a.id, b.id, mat.id, sec.id);
  const lc = m.addLoadCase('L', false); lc.loads.push({ type:'nodal', nodeId:b.id, F:[0,0,-1000] });
  let err = null;
  try { new StaticSolver().solve(m, lc.id, false); } catch (e) { err = e; }
  check(!!err, 'unsupported model throws');
  check(err && err.stability && err.stability.code === STABILITY.MECHANISM, 'err.stability.code === STABILITY_MECHANISM', `(${err?.stability?.code})`);
  check(err && err.stability.severity === 'error', 'severity === error');
}

// ── (4) Healthy model: no warnings (solver + sanity) ─────────────────────────
console.log('\n── (4) Healthy cantilever: clean (no false positives) ──');
{
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name:'S', E:2.1e11, G:8e10, nu:0.3125, rho:0 });
  const sec = m.addSection({ name:'C', A:0.01, Iy:8e-6, Iz:8e-6, J:1e-6, Avy:1e30, Avz:1e30 });
  const a = m.addNode(0,0,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1});
  const b = m.addNode(3,0,0,{});
  m.addElement(a.id, b.id, mat.id, sec.id);
  const lc = m.addLoadCase('L', false); lc.loads.push({ type:'nodal', nodeId:b.id, F:[0,0,-1000] });
  const res = new StaticSolver().solve(m, lc.id, false);
  check(res.warnings.length === 0, 'solver warnings empty', `(${res.warnings.map(w=>w.code).join(',')||'none'})`);
  check(assessStabilitySanity(m, res).length === 0, 'sanity warnings empty');
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
