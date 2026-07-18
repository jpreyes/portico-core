// Nodal mass — all six DOFs, dense AND sparse assembly paths must agree.
// Guards against the class of bug where imposed nodal mass is only honoured in some
// directions (e.g. translational X/Y/Z but not rotational, or a rotation-only mass
// dropped because the translational components are zero).
import '../lib/numeric.js';
import { Model } from '../js/model/model.js';
import { buildNodeIndex, assembleK, getNodeDOFs } from '../js/solver/assembler.js';
import { assembleSparseGlobal } from '../js/solver/sparse.js';
globalThis.window = globalThis;

let failures = 0;
const check = (cond, msg, extra='') => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  '+extra : ''}`); if (!cond) failures++; };
const rel = (a, b) => Math.abs(a-b)/Math.abs(b);

const E = 2.1e11, G = 8e10;
function model() {
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name:'S', E, G, nu:0.3125, rho:1e-9 });
  const sec = m.addSection({ name:'C', A:0.01, Iy:8e-6, Iz:8e-6, J:1e-6, Avy:1e30, Avz:1e30, kappay:1, kappaz:1 });
  return { m, mat, sec };
}

// ── (1) All six components land on their own DOF — dense path ────────────────
console.log('── (1) Dense assembly: mass in every DOF (mx,my,mz,irx,iry,irz) ──');
const want = { mx:10, my:20, mz:30, irx:4, iry:5, irz:6 };
{
  const { m, mat, sec } = model();
  const a = m.addNode(0,0,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1});
  const b = m.addNode(3,0,0,{});
  m.addElement(a.id, b.id, mat.id, sec.id);
  m.updateNode(b.id, { nodeMass: { ...want } });
  const ni = buildNodeIndex(m); const { M, nDOF } = assembleK(m, ni);
  const d = getNodeDOFs(ni, b.id);
  const got = d.map(g => M[g*nDOF + g]);
  const exp = [want.mx, want.my, want.mz, want.irx, want.iry, want.irz];
  ['mx','my','mz','irx','iry','irz'].forEach((k,i) =>
    check(rel(got[i], exp[i]) < 1e-9, `${k} → DOF ${i} = ${exp[i]}`, `(got ${got[i].toFixed(3)})`));
}

// ── (2) Sparse assembly must match the dense path exactly ────────────────────
console.log('\n── (2) Sparse assembly agrees with dense on all six DOFs ──');
{
  const { m, mat, sec } = model();
  const a = m.addNode(0,0,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1});
  const b = m.addNode(3,0,0,{});
  m.addElement(a.id, b.id, mat.id, sec.id);
  m.updateNode(b.id, { nodeMass: { ...want } });
  const ni = buildNodeIndex(m);
  const { M } = assembleSparseGlobal(m, ni, { withMass: true });
  const base = 6 * ni.get(b.id);
  const got = [0,1,2,3,4,5].map(i => M.diag(base + i));
  const exp = [want.mx, want.my, want.mz, want.irx, want.iry, want.irz];
  ['mx','my','mz','irx','iry','irz'].forEach((k,i) =>
    check(rel(got[i], exp[i]) < 1e-9, `sparse ${k} = ${exp[i]}`, `(got ${got[i].toFixed(3)})`));
}

// ── (3) A rotation-only nodal mass must not be skipped ───────────────────────
// Regression: the sparse path used to `continue` when mx=my=mz=0, dropping a node
// that carries only rotational inertia (e.g. a lumped Irz on a torsional DOF).
console.log('\n── (3) Rotation-only mass (Irz, no translation) is included ──');
{
  const { m, mat, sec } = model();
  const a = m.addNode(0,0,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1});
  const b = m.addNode(3,0,0,{});
  m.addElement(a.id, b.id, mat.id, sec.id);
  m.updateNode(b.id, { nodeMass: { mx:0, my:0, mz:0, irx:0, iry:0, irz:7 } });
  const ni = buildNodeIndex(m);
  const { M: Md, nDOF } = assembleK(m, ni);
  const { M: Ms } = assembleSparseGlobal(m, ni, { withMass: true });
  const base = 6 * ni.get(b.id);
  check(rel(Md[(base+5)*nDOF + (base+5)], 7) < 1e-9, `dense: Irz present (=7)`);
  check(rel(Ms.diag(base+5), 7) < 1e-9, `sparse: Irz present (=7) — not skipped`);
}

// ── (4) End-to-end: a mass imposed in Y vs Z drives the correct modal freq ───
// Documents the verified-correct behaviour: the dense modal path honours the mass
// in whichever direction it is imposed (cantilever w/ Iy=Iz → same freq in Y or Z).
console.log('\n── (4) Modal: imposed Y-mass and Z-mass each give the right frequency ──');
{
  const freqWith = (dir) => {
    const { m, mat, sec } = model();
    const a = m.addNode(0,0,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1});
    const b = m.addNode(3,0,0,{});
    m.addElement(a.id, b.id, mat.id, sec.id);
    m.updateNode(b.id, { nodeMass: { [dir]: 100 } });
    // analytical: guided/free cantilever tip mass, k=3EI/L³, f=√(k/m)/2π
    const k = 3*E*8e-6/27;
    return { f: Math.sqrt(k/100)/(2*Math.PI), model: m };
  };
  // (compute via real modal solver, compare Y vs Z)
  const ModalSolver = (await import('../js/solver/modal_solver.js')).ModalSolver;
  const fY = (() => { const r = freqWith('my'); return new ModalSolver().solve(r.model, 1).freq[0]; })();
  const fZ = (() => { const r = freqWith('mz'); return new ModalSolver().solve(r.model, 1).freq[0]; })();
  const fAnalytic = Math.sqrt(3*E*8e-6/27/100)/(2*Math.PI);
  check(rel(fY, fAnalytic) < 0.01, `Y-mass → f = √(3EI/L³/m)/2π`, `(${fY.toFixed(3)} vs ${fAnalytic.toFixed(3)})`);
  check(rel(fZ, fAnalytic) < 0.01, `Z-mass → same frequency (symmetry)`, `(${fZ.toFixed(3)})`);
  check(rel(fY, fZ) < 1e-6, `Y and Z masses treated identically`);
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
