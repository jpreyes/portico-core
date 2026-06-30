// Diagram recovery (postprocess.js) — analytical contrast of the N/V/M integration
// that CLAUDE.md calls "the source of truth for the diagrams". diagramFromForces and
// elemAtXiFromForces are pure equilibrium integrators; they drive every diagram the
// UI draws yet had no direct analytical test. Plus one end-to-end pass through the
// full StaticSolver chain.
import './lib/numeric.js';
import { Model } from './js/model/model.js';
import { StaticSolver } from './js/solver/static_solver.js';
import { diagramFromForces, elemAtXiFromForces } from './js/solver/postprocess.js';
globalThis.window = globalThis;

let failures = 0;
const check = (cond, msg, extra='') => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  '+extra : ''}`); if (!cond) failures++; };
const rel = (a, b) => Math.abs(a-b)/Math.abs(b);

const n1 = { x:0, y:0, z:0 }, n2 = { x:1, y:0, z:0 };

// ── (1) Simply-supported beam under UDL: M peaks at wL²/8, V is linear ±wL/2 ──
// FEM sign of the diagram integrator: M(x)=Mz1 − Vy1·x − ½q1x²; for a SS beam with
// pinned ends (Mz1=Mz2=0) and reactions wL/2, that means Vy1=−wL/2, q1=w.
console.log('── (1) SS beam, UDL: M=wL²/8 at center, V=±wL/2 ──');
{
  const L = 6, w = 5;
  const f = { L, N:0, T:0, Mz1:0, Mz2:0, My1:0, My2:0,
              Vy1:-w*L/2, Vy2:w*L/2, Vz1:0, Vz2:0, qy1:w, qy2:w, qy:w, qz1:0, qz2:0 };
  const dM = diagramFromForces(f, n1, n2, 'Mz', 40);
  const dV = diagramFromForces(f, n1, n2, 'Vy', 40);
  check(rel(dM.maxVal, w*L*L/8) < 1e-9, `M_max = wL²/8`, `(${dM.maxVal.toFixed(3)} vs ${(w*L*L/8).toFixed(3)})`);
  check(dM.extremes.length === 1 && Math.abs(dM.extremes[0].xi - 0.5) < 1e-6, `M extreme at midspan`);
  check(Math.abs(dM.pts[0].val) < 1e-9 && Math.abs(dM.pts[dM.pts.length-1].val) < 1e-9, `M=0 at the pinned ends`);
  check(rel(Math.abs(dV.pts[0].val), w*L/2) < 1e-9 && rel(Math.abs(dV.pts[dV.pts.length-1].val), w*L/2) < 1e-9, `V=±wL/2 at supports`);
  check(Math.abs(dV.pts[20].val) < 1e-9, `V=0 at midspan (sign change)`);
  // pure-point cross-check via elemAtXiFromForces
  const mid = elemAtXiFromForces(f, 0.5);
  check(rel(mid.Mz, w*L*L/8) < 1e-9 && Math.abs(mid.Vy) < 1e-9, `elemAtXi(0.5): Mz=wL²/8, Vy=0`);
}

// ── (2) SS beam under a triangular load 0→w0: max M at x=L/√3 = 0.5774 L ──────
// Reactions w0L/6 (left) and w0L/3 (right); max moment w0L²/(9√3) at L/√3.
console.log('\n── (2) SS beam, triangular load: extreme at L/√3 ──');
{
  const L = 6, w0 = 9;
  const f = { L, N:0, T:0, Mz1:0, Mz2:0, My1:0, My2:0,
              Vy1:-w0*L/6, Vy2:w0*L/3, Vz1:0, Vz2:0, qy1:0, qy2:w0, qy:w0/2, qz1:0, qz2:0 };
  const dM = diagramFromForces(f, n1, n2, 'Mz', 60);
  const xstar = 1/Math.sqrt(3), Mstar = w0*L*L/(9*Math.sqrt(3));
  const ext = dM.extremes.filter(e => e.xi > 0 && e.xi < 1);
  check(ext.length >= 1, 'an interior moment extreme exists');
  const e = ext.reduce((a,b) => Math.abs(b.val) > Math.abs(a.val) ? b : a, ext[0]);
  check(rel(e.xi, xstar) < 1e-4, `extreme at xi=L/√3=0.5774`, `(${e.xi.toFixed(4)})`);
  check(rel(e.val, Mstar) < 1e-4, `M_max = w0L²/(9√3)`, `(${e.val.toFixed(4)} vs ${Mstar.toFixed(4)})`);
}

// ── (3) End-to-end: cantilever under UDL via StaticSolver ────────────────────
// Base moment wL²/2, base shear wL, both zero at the free tip.
console.log('\n── (3) Cantilever UDL through the full StaticSolver chain ──');
{
  const L = 4, w = 3, E = 2.1e8, I = 6.75e-4;
  const m = new Model(); m.mode = '2D';
  const matId = m._firstKey('materials');
  const sec = m.addSection({ name:'sq', A:0.09, Iz:I, Iy:I, J:1.14e-3, Avy:1e8, Avz:1e8 });
  const a = m.addNode(0, 0, 0, { ux:1, uy:1, uz:1, rx:1, ry:1, rz:1 });
  const b = m.addNode(L, 0, 0);
  const el = m.addElement(a.id, b.id, matId, sec.id);
  const lc = m.addLoadCase('q', false);
  lc.loads.push({ type:'dist', elemId: el.id, w, dir:'gravity' });   // w kN/m, −Z
  const res = new StaticSolver().solve(m, lc.id, false);
  const base = res.getElemAtXi(el.id, 0), tip = res.getElemAtXi(el.id, 1);
  check(rel(Math.abs(base.Mz), w*L*L/2) < 1e-3, `base |Mz| = wL²/2`, `(${Math.abs(base.Mz).toFixed(3)} vs ${(w*L*L/2).toFixed(3)})`);
  check(rel(Math.abs(base.Vy), w*L) < 1e-3, `base |Vy| = wL`, `(${Math.abs(base.Vy).toFixed(3)} vs ${(w*L).toFixed(3)})`);
  check(Math.abs(tip.Mz) < 1e-3*w*L*L && Math.abs(tip.Vy) < 1e-3*w*L, `tip M≈0 and V≈0`);
  // global equilibrium: vertical reaction = total load wL
  const R = res.getReaction ? res.getReaction(a.id) : null;
  if (R) check(rel(Math.abs(R[2]), w*L) < 1e-3, `support reaction = wL (equilibrium)`, `(${Math.abs(R[2]).toFixed(3)})`);
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
