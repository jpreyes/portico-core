// Rigid diaphragm (diaphragm.js) — center of rigidity + rigid in-plane constraint.
// The diaphragm penalty constraint and the CR formula drive every seismic model with
// floors, yet neither was contrasted directly.
import '../lib/numeric.js';
import { Model } from '../js/model/model.js';
import { StaticSolver } from '../js/solver/static_solver.js';
import { computeFloorCR } from '../js/solver/diaphragm.js';
globalThis.window = globalThis;

let failures = 0;
const check = (cond, msg, extra='') => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  '+extra : ''}`); if (!cond) failures++; };
const rel = (a, b) => Math.abs(a-b)/Math.abs(b);

const E = 2.1e8, h = 3.0;

// ── (1) Center of rigidity: stiffness-weighted column position ───────────────
// Two vertical columns at x=0 (Iy=3I) and x=6 (Iy=I): x_CR = Σ(Ky·x)/ΣKy with
// Ky ∝ Iy → x_CR = 6·I/(3I+I) = 1.5.
console.log('── (1) computeFloorCR: stiffness-weighted (Ky ∝ Iy) ──');
{
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name:'S', E, G:E/2.6, nu:0.3, rho:0 });
  const I = 1e-5;
  const sA = m.addSection({ name:'a', A:0.05, Iy:3*I, Iz:1e-5, J:1e-6 });   // stiff Y at x=0
  const sB = m.addSection({ name:'b', A:0.05, Iy:1*I, Iz:1e-5, J:1e-6 });   // soft  Y at x=6
  const b1 = m.addNode(0,0,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1});
  const t1 = m.addNode(0,0,h);
  const b2 = m.addNode(6,0,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1});
  const t2 = m.addNode(6,0,h);
  m.addElement(b1.id, t1.id, mat.id, sA.id);
  m.addElement(b2.id, t2.id, mat.id, sB.id);
  const cr = computeFloorCR(m, new Set([t1.id, t2.id]), h);
  check(cr != null && rel(cr.x, 1.5) < 1e-9, `x_CR = 6·I/(3I+I) = 1.5`, `(${cr?.x.toFixed(4)})`);
}

// ── (2) Rigid in-plane motion: pure lateral load → equal translation, no twist ─
// A symmetric one-story frame loaded through the diaphragm translates rigidly: all
// floor nodes share the same ux and develop ~0 relative drift (penalty tolerance).
console.log('\n── (2) Rigid diaphragm: pure lateral load → equal ux, no relative drift ──');
{
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name:'S', E, G:E/2.6, nu:0.3, rho:0 });
  const sec = m.addSection({ name:'c', A:0.09, Iy:6.75e-4, Iz:6.75e-4, J:1e-3 });
  // 4 corner columns of a 4×3 floor
  const corners = [[0,0],[4,0],[4,3],[0,3]];
  const tops = [];
  for (const [x,y] of corners) {
    const base = m.addNode(x,y,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1});
    const top  = m.addNode(x,y,h);
    m.addElement(base.id, top.id, mat.id, sec.id);
    tops.push(top);
  }
  const masterId = tops[0].id;
  m.addDiaphragm({ name:'F1', z:h, nodes: tops.map(t=>t.id), masterId,
                   cm:{x:2,y:1.5}, cr:{x:2,y:1.5}, mass:{m:0,Icm:0}, eccentricity:{ex:0,ey:0} });
  const lc = m.addLoadCase('V', false);
  // distribute a global-X shear over the 4 columns
  for (const t of tops) lc.loads.push({ type:'nodal', nodeId:t.id, F:[25,0,0,0,0,0] });
  const res = new StaticSolver().solve(m, lc.id, false);
  const ux = tops.map(t => res.getNodeDisp(t.id)[0]);
  const uy = tops.map(t => res.getNodeDisp(t.id)[1]);
  const rz = tops.map(t => res.getNodeDisp(t.id)[5]);
  const uxAvg = ux.reduce((a,b)=>a+b,0)/4;
  const spread = Math.max(...ux) - Math.min(...ux);
  console.log(`  ux = [${ux.map(v=>v.toExponential(3)).join(', ')}]`);
  check(uxAvg > 0, 'floor translates in +X');
  check(spread / Math.abs(uxAvg) < 1e-3, 'all floor nodes share the same ux (rigid translation)', `(spread ${(spread/Math.abs(uxAvg)*100).toExponential(2)}%)`);
  check(Math.max(...uy.map(Math.abs)) < 1e-3*Math.abs(uxAvg), 'no transverse drift (uy≈0)');
  check(Math.max(...rz.map(Math.abs)) < 1e-3*Math.abs(uxAvg), 'no floor rotation (rz≈0)');
}

// ── (3) Rigid rotation: torque → nodes follow ux=−dy·rz, uy=+dx·rz about master ─
console.log('\n── (3) Rigid diaphragm: applied torque → rigid-body rotation ──');
{
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name:'S', E, G:E/2.6, nu:0.3, rho:0 });
  const sec = m.addSection({ name:'c', A:0.09, Iy:6.75e-4, Iz:6.75e-4, J:1e-3 });
  const corners = [[0,0],[4,0],[4,3],[0,3]];
  const tops = [];
  for (const [x,y] of corners) {
    const base = m.addNode(x,y,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1});
    const top  = m.addNode(x,y,h);
    m.addElement(base.id, top.id, mat.id, sec.id);
    tops.push(top);
  }
  const master = tops[0];
  m.addDiaphragm({ name:'F1', z:h, nodes: tops.map(t=>t.id), masterId: master.id,
                   cm:{x:2,y:1.5}, cr:{x:2,y:1.5}, mass:{m:0,Icm:0}, eccentricity:{ex:0,ey:0} });
  const lc = m.addLoadCase('T', false);
  // a couple about Z: +X at the top edge, −X at the bottom edge
  lc.loads.push({ type:'nodal', nodeId: tops[3].id, F:[ 50,0,0,0,0,0] });  // (0,3)
  lc.loads.push({ type:'nodal', nodeId: tops[2].id, F:[ 50,0,0,0,0,0] });  // (4,3)
  lc.loads.push({ type:'nodal', nodeId: tops[0].id, F:[-50,0,0,0,0,0] });  // (0,0)
  lc.loads.push({ type:'nodal', nodeId: tops[1].id, F:[-50,0,0,0,0,0] });  // (4,0)
  const res = new StaticSolver().solve(m, lc.id, false);
  const rz = tops.map(t => res.getNodeDisp(t.id)[5]);
  const rzAvg = rz.reduce((a,b)=>a+b,0)/4;
  const rzSpread = Math.max(...rz) - Math.min(...rz);
  check(Math.abs(rzAvg) > 0, 'floor rotates about Z');
  check(rzSpread / Math.abs(rzAvg) < 1e-3, 'all nodes share the same rz (rigid body)', `(spread ${(rzSpread/Math.abs(rzAvg)*100).toExponential(2)}%)`);
  // rigid-body kinematics relative to the master: uy_s − uy_m = +dx·rz
  const dm = res.getNodeDisp(master.id);
  let worst = 0;
  tops.forEach(t => {
    const d = res.getNodeDisp(t.id);
    const dx = t.x - master.x, dy = t.y - master.y;
    const exX = (dm[0] - dy*rzAvg);   // ux_s = ux_m − dy·rz
    const exY = (dm[1] + dx*rzAvg);   // uy_s = uy_m + dx·rz
    worst = Math.max(worst, Math.abs(d[0]-exX), Math.abs(d[1]-exY));
  });
  const refU = Math.max(...tops.map(t=>Math.abs(res.getNodeDisp(t.id)[0])));
  check(worst/refU < 1e-3, 'node translations satisfy rigid-body kinematics about master', `(resid ${(worst/refU*100).toExponential(2)}%)`);
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
