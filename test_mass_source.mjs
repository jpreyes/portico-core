// Seismic mass source (load patterns → mass) — the ETABS/SAP "mass source" feature.
// Verifies the gravity weight of chosen load cases (× factors) becomes translational
// mass on UX, UY and UZ (all three directions), in both the dense and sparse paths,
// and that the modal analysis then reflects it.
import './lib/numeric.js';
import { Model } from './js/model/model.js';
import { buildNodeIndex, assembleK, getNodeDOFs } from './js/solver/assembler.js';
import { assembleSparseGlobal } from './js/solver/sparse.js';
globalThis.window = globalThis;
const { ModalSolver } = await import('./js/solver/modal_solver.js');

let failures = 0;
const check = (cond, msg, extra='') => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  '+extra : ''}`); if (!cond) failures++; };
const rel = (a, b) => Math.abs(a-b)/Math.abs(b);
const G = 9.80665;
const E = 2.1e11, Gs = 8e10;

function frame() {
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name:'S', E, G:Gs, nu:0.3125, rho:1e-9 });   // ~massless: mass only from the source
  const sec = m.addSection({ name:'C', A:0.01, Iy:8e-6, Iz:8e-6, J:1e-6, Avy:1e30, Avz:1e30, kappay:1, kappaz:1 });
  const a = m.addNode(0,0,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1});
  const b = m.addNode(3,0,0,{});
  m.addElement(a.id, b.id, mat.id, sec.id);
  return { m, a, b };
}

// ── (1) Nodal gravity load → mass in UX, UY, UZ (dense = sparse) ─────────────
console.log('── (1) Nodal load W → mass W/g on UX, UY, UZ ──');
{
  const { m, b } = frame();
  const W = 100;                                   // kN downward
  const lc = m.addLoadCase('D', false);
  lc.loads.push({ type:'nodal', nodeId: b.id, F:[0,0,-W,0,0,0] });
  m.massSource = { enabled:true, g:G, selfWeight:false, entries:[{ lcId: lc.id, factor:1 }] };
  const ni = buildNodeIndex(m);
  const { M, nDOF } = assembleK(m, ni);
  const { M: Ms } = assembleSparseGlobal(m, ni, { withMass:true });
  const d = getNodeDOFs(ni, b.id), base = 6*ni.get(b.id);
  const mExp = W / G;
  ['UX','UY','UZ'].forEach((k,i) => {
    check(rel(M[d[i]*nDOF + d[i]], mExp) < 1e-9, `dense ${k} = W/g`, `(${M[d[i]*nDOF+d[i]].toFixed(4)} vs ${mExp.toFixed(4)})`);
    check(rel(Ms.diag(base+i), mExp) < 1e-9, `sparse ${k} = W/g`);
  });
}

// ── (2) Combination D + 0.25·L with per-case factors ─────────────────────────
console.log('\n── (2) Mass source D + 0.25·L (factors) ──');
{
  const { m, b } = frame();
  const D = 80, L = 40;
  const lcD = m.addLoadCase('D', false); lcD.loads.push({ type:'nodal', nodeId:b.id, F:[0,0,-D,0,0,0] });
  const lcL = m.addLoadCase('L', false); lcL.loads.push({ type:'nodal', nodeId:b.id, F:[0,0,-L,0,0,0] });
  m.massSource = { enabled:true, g:G, selfWeight:false, entries:[{lcId:lcD.id,factor:1},{lcId:lcL.id,factor:0.25}] };
  const ni = buildNodeIndex(m); const { M, nDOF } = assembleK(m, ni);
  const d = getNodeDOFs(ni, b.id);
  const mExp = (D + 0.25*L) / G;
  check(rel(M[d[0]*nDOF + d[0]], mExp) < 1e-9, `UX mass = (D + 0.25L)/g`, `(${M[d[0]*nDOF+d[0]].toFixed(4)} vs ${mExp.toFixed(4)})`);
}

// ── (3) Distributed load lumped to nodes (tributary), then to mass ──────────
console.log('\n── (3) Distributed gravity load → tributary nodal mass ──');
{
  const { m, a, b } = frame();
  const w = 30, Lspan = 3;                          // kN/m over the 3 m element
  const el = [...m.elements.keys()][0];
  const lc = m.addLoadCase('D', false); lc.loads.push({ type:'dist', elemId: el, w, dir:'gravity' });
  m.massSource = { enabled:true, g:G, selfWeight:false, entries:[{lcId:lc.id, factor:1}] };
  const ni = buildNodeIndex(m); const { M, nDOF } = assembleK(m, ni);
  const db = getNodeDOFs(ni, b.id);
  // half the total weight (w·L/2) lumps to the free end → mass (w·L/2)/g
  const mExp = (w*Lspan/2) / G;
  check(rel(M[db[2]*nDOF + db[2]], mExp) < 1e-6, `free-end UZ mass = (wL/2)/g`, `(${M[db[2]*nDOF+db[2]].toFixed(4)} vs ${mExp.toFixed(4)})`);
}

// ── (4) Modal frequency reflects the source mass; disabled → no mass ────────
console.log('\n── (4) Modal uses the source mass (and respects enabled flag) ──');
{
  const { m, b } = frame();
  const W = 100;
  const lc = m.addLoadCase('D', false); lc.loads.push({ type:'nodal', nodeId:b.id, F:[0,0,-W,0,0,0] });
  m.massSource = { enabled:true, g:G, selfWeight:false, entries:[{lcId:lc.id, factor:1}] };
  const mr = new ModalSolver().solve(m, 1);
  // cantilever tip mass m=W/g, lateral k=3EI/L³ → f=√(k/m)/2π
  const k = 3*E*8e-6/27, mass = W/G;
  const fExp = Math.sqrt(k/mass)/(2*Math.PI);
  check(rel(mr.freq[0], fExp) < 0.02, `f = √(3EI/L³ / (W/g))/2π`, `(${mr.freq[0].toFixed(3)} vs ${fExp.toFixed(3)})`);

  // disabled → massless model → solver must report no structural mass
  m.massSource.enabled = false;
  let threw = false;
  try { new ModalSolver().solve(m, 1); } catch { threw = true; }
  check(threw, 'disabled mass source → no mass (massless model rejected)');
}

// ── (5) Serializer round-trip preserves the mass source ─────────────────────
console.log('\n── (5) .s3d round-trip preserves massSource ──');
{
  const { Serializer } = await import('./js/model/serializer.js');
  const { m, b } = frame();
  const lc = m.addLoadCase('D', false); lc.loads.push({ type:'nodal', nodeId:b.id, F:[0,0,-100,0,0,0] });
  m.massSource = { enabled:true, g:9.81, selfWeight:true, entries:[{lcId:lc.id, factor:1.1}] };
  const round = new Serializer().fromJSON(new Serializer().toJSON(m));
  const ms = round.massSource;
  check(!!ms && ms.enabled === true && ms.selfWeight === true && rel(ms.g, 9.81) < 1e-9
        && ms.entries?.length === 1 && ms.entries[0].lcId === lc.id && rel(ms.entries[0].factor, 1.1) < 1e-9,
        'massSource survives toJSON → fromJSON', `(${JSON.stringify(ms)})`);
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
