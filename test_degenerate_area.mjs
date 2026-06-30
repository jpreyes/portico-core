// Degenerate area guard — a collinear / zero-area (coincident-node) plate/shell must
// be SKIPPED, never build NaN element matrices that poison K/M and the stress recovery.
// (audit finding #3). The beam zero-length is already guarded; this does the same for areas.
import { Model } from './js/model/model.js';
import { areaLocalFrame } from './js/solver/membrane.js';
import { buildNodeIndex, assembleK } from './js/solver/assembler.js';
import { StaticSolver } from './js/solver/static_solver.js';
globalThis.window = globalThis;
await import('./lib/numeric.js');

let failures = 0;
const check = (cond, msg, extra='') => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  '+extra : ''}`); if (!cond) failures++; };
const anyNaN = (a) => { for (const v of a) if (!Number.isFinite(v)) return true; return false; };

// ── (1) areaLocalFrame flags degeneracy correctly ───────────────────────────
console.log('── (1) areaLocalFrame.degenerate ──');
check(areaLocalFrame([[0,0,0],[1,0,0],[0,1,0]]).degenerate === false, 'valid triangle → not degenerate');
check(areaLocalFrame([[0,0,0],[1,0,0],[0,1,0],[1,1,0]]).degenerate === false, 'valid quad → not degenerate');
check(areaLocalFrame([[0,0,0],[1,0,0],[2,0,0]]).degenerate === true, 'collinear triangle → degenerate');
check(areaLocalFrame([[0,0,0],[0,0,0],[1,1,0]]).degenerate === true, 'coincident nodes → degenerate');
check(areaLocalFrame([[0,0,0],[1,0,0],[1e-13,0,0]]).degenerate === true, 'near-collinear → degenerate');

// ── (2) Degenerate area is skipped → no NaN in K / M ────────────────────────
console.log('\n── (2) Assembly is NaN-safe with a degenerate area ──');
function model(withDegenArea) {
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name:'S', E:2.1e11, G:8e10, nu:0.3, rho:0 });
  const sec = m.addSection({ name:'C', A:0.01, Iy:8e-6, Iz:8e-6, J:1e-6, Avy:1e30, Avz:1e30 });
  const n1 = m.addNode(0,0,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1});
  const n2 = m.addNode(3,0,0,{});                                   // cantilever tip (free)
  m.addElement(n1.id, n2.id, mat.id, sec.id);
  if (withDegenArea) {
    // collinear shell area sharing the FREE tip node n2 → would poison its DOFs if not skipped
    const n3 = m.addNode(4,0,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1});
    const n4 = m.addNode(5,0,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1});
    m.addArea([n2.id, n3.id, n4.id], mat.id, { thickness:0.1, behavior:'shell' });
  }
  const lc = m.addLoadCase('L', false); lc.loads.push({ type:'nodal', nodeId:n2.id, F:[0,0,-1000] });
  return { m, n2, lc };
}
{
  const { m } = model(true);
  const ni = buildNodeIndex(m);
  const { K, M } = assembleK(m, ni);
  check(!anyNaN(K), 'K has no NaN/Inf with a degenerate area');
  check(!anyNaN(M), 'M has no NaN/Inf with a degenerate area');
}

// ── (3) Static solve stays finite (degenerate area ignored, not poisoning) ──
console.log('\n── (3) Static solve finite (cantilever + degenerate area) ──');
{
  const { m, n2, lc } = model(true);
  let res = null, err = null;
  try { res = new StaticSolver().solve(m, lc.id, false); } catch (e) { err = e; }
  check(!err, 'solve does not throw', err ? `(${err.message.slice(0,50)})` : '');
  if (res) {
    const tip = res.getNodeDisp(n2.id);
    check(!tip.some(v => !Number.isFinite(v)), 'tip displacement finite', `(uz=${tip[2].toExponential(3)})`);
    // matches the bare cantilever (the degenerate area contributes nothing)
    const ref = new StaticSolver().solve(model(false).m, lc.id, false).getNodeDisp(n2.id)[2];
    check(Math.abs(tip[2] - ref) < 1e-9 * Math.abs(ref), 'result == bare cantilever (area had zero effect)');
  }
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
