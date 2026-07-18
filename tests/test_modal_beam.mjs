// ModalSolver end-to-end — analytical contrast of the production modal pipeline
// (consistent mass + Stodola inverse iteration + M-orthogonal deflation + mode
// ordering + participation). test_guyan covers the massless-DOF condensation and
// test_modal_kg the Kg coupling, but the eigenfrequencies of ModalSolver.solve()
// itself were never checked against a closed-form solution.
//
// Cantilever (Euler-Bernoulli):  fn = (βnL)²/(2π) · √(EI/ρA) / L²
//   βnL = 1.875104, 4.694091, 7.854757   (modes 1..3)
import { Model } from '../js/model/model.js';
globalThis.window = globalThis;
await import('../lib/numeric.js');
const { ModalSolver } = await import('../js/solver/modal_solver.js');

let failures = 0;
const check = (cond, msg, extra='') => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  '+extra : ''}`); if (!cond) failures++; };
const rel = (a, b) => Math.abs(a-b)/Math.abs(b);

const E = 2.1e11, G = 8.0e10, rho = 7850;
const A = 0.01, Iz = 8e-6, Iy = 8e-6, J = 1e-6, L = 4.0, nEl = 12;

const m = new Model();
m.materials.clear(); m.sections.clear();
const mat = m.addMaterial({ name: 'Steel', E, G, nu: 0.3125, rho });
// Euler beam: huge shear areas (no shear deformation) so it matches Euler-Bernoulli.
const sec = m.addSection({ name: 'B', A, Iy, Iz, J, Avy: 1e30, Avz: 1e30, kappay: 1, kappaz: 1 });

// Cantilever along X, bending in the global XY plane (free uy & rz → transverse in Y,
// so mass participation lands in the Y direction that ModalResults reports).
const nodes = [];
for (let k = 0; k <= nEl; k++) {
  const nd = m.addNode((L/nEl)*k, 0, 0, { ux:1, uz:1, rx:1, ry:1 });   // only uy, rz free
  nodes.push(nd);
}
m.updateNode(nodes[0].id, { restraints: { ux:1, uy:1, uz:1, rx:1, ry:1, rz:1 } });   // clamped root
for (let k = 0; k < nEl; k++) m.addElement(nodes[k].id, nodes[k+1].id, mat.id, sec.id);

const res = new ModalSolver().solve(m, 3);

// ── (1) Natural frequencies vs Euler-Bernoulli ───────────────────────────────
console.log('── (1) Cantilever natural frequencies vs Euler-Bernoulli ──');
const betaL = [1.875104, 4.694091, 7.854757];
const fa = betaL.map(b => b*b/(2*Math.PI) * Math.sqrt(E*Iz/(rho*A)) / (L*L));
const tol = [0.01, 0.02, 0.04];   // higher modes need a finer mesh → looser tol
for (let i = 0; i < 3; i++) {
  const f = res.freq[i];
  check(rel(f, fa[i]) < tol[i], `f${i+1} = ${f.toFixed(3)} Hz`, `(analytic ${fa[i].toFixed(3)}, err ${(rel(f,fa[i])*100).toFixed(2)}%)`);
}
// frequencies must be strictly ascending (mode ordering / deflation correctness)
check(res.freq[0] < res.freq[1] && res.freq[1] < res.freq[2], 'frequencies strictly ascending (ordering OK)');

// ── (2) M-orthogonality of the recovered modes (deflation correctness) ───────
console.log('\n── (2) Modes are M-orthogonal (Stodola deflation) ──');
// φiᵀ M φj ≈ 0 for i≠j, via the stored mode shapes and a re-assembled mass matrix.
const { buildNodeIndex, assembleK } = await import('../js/solver/assembler.js');
const ni = buildNodeIndex(m);
const { M, nDOF: nd2 } = assembleK(m, ni);
const phi = res.modeShapes;
function MO(a, b) { let s=0; for (let i=0;i<nd2;i++){ let r=0; for(let j=0;j<nd2;j++) r+=M[i*nd2+j]*b[j]; s+=a[i]*r; } return s; }
const m11 = MO(phi[0],phi[0]), m22 = MO(phi[1],phi[1]);
const m12 = MO(phi[0],phi[1]), m13 = MO(phi[0],phi[2]), m23 = MO(phi[1],phi[2]);
const scale = Math.sqrt(m11*m22);
check(Math.abs(m12)/scale < 1e-4, `φ1ᵀMφ2 / ‖‖ = ${(m12/scale).toExponential(2)}`);
check(Math.abs(m13)/Math.sqrt(m11*MO(phi[2],phi[2])) < 1e-4, `φ1ᵀMφ3 ≈ 0`);
check(Math.abs(m23)/Math.sqrt(m22*MO(phi[2],phi[2])) < 1e-4, `φ2ᵀMφ3 ≈ 0`);

// ── (3) Mass participation: cumulative effective mass grows toward the total ──
console.log('\n── (3) Mass participation (Y direction) ──');
const part = res.getParticipation();
const cumY = part.rows[2].cumPct[1];   // cumulative Y % after 3 modes
const p1Y = part.rows[0].pct[1];
console.log(`  mode %Y = [${part.rows.map(r => r.pct[1].toFixed(1)).join(', ')}]  cum=${cumY.toFixed(1)}%`);
check(rel(p1Y, 61.0) < 0.06, `1st mode ≈ 61% of cantilever mass`, `(${p1Y.toFixed(1)}%)`);
check(cumY > 85 && cumY <= 100.5, `3 modes capture >85% of mass`, `(${cumY.toFixed(1)}%)`);
check(part.rows[0].pct[1] > part.rows[1].pct[1] && part.rows[1].pct[1] > part.rows[2].pct[1], 'participation decreasing with mode number');

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
