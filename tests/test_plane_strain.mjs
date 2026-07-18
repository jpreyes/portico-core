// test_plane_strain.mjs — verifica TENSIÓN PLANA vs DEFORMACIÓN PLANA (#58, G14).
// Membrana cuadrada en tracción uniaxial (σy=0). Deformaciones analíticas:
//   plane-stress:  εx = σx/E ,            εy = −ν·σx/E
//   plane-strain:  εx = σx(1−ν²)/E ,      εy = −ν·σx(1+ν)/E   (εz=0 → σz=ν·σx)
import { buildNodeIndex, assembleK, getNodeDOFs } from '../js/solver/assembler.js';
import { Results } from '../js/solver/postprocess.js';

const E = 2.1e11, nu = 0.3, t = 0.01;
let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-30, `${m}  (${a.toExponential(4)} vs ${b.toExponential(4)})`);

function solveDense(Kflat, F, n) {
  const M = []; for (let i = 0; i < n; i++) { const r = new Float64Array(n); for (let j = 0; j < n; j++) r[j] = Kflat[i * n + j]; M.push(r); }
  const x = Float64Array.from(F);
  for (let k = 0; k < n; k++) {
    let p = k; for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    [M[k], M[p]] = [M[p], M[k]]; const tx = x[k]; x[k] = x[p]; x[p] = tx;
    for (let i = k + 1; i < n; i++) { const f = M[i][k] / M[k][k]; if (!f) continue; for (let j = k; j < n; j++) M[i][j] -= f * M[k][j]; x[i] -= f * x[k]; }
  }
  for (let k = n - 1; k >= 0; k--) { let s = x[k]; for (let j = k + 1; j < n; j++) s -= M[k][j] * x[j]; x[k] = s / M[k][k]; }
  return x;
}
const emptyModel = (nodes, areas) => ({
  nodes, areas,
  materials: new Map([[1, { id: 1, E, nu, alpha: 0, density: 0 }]]),
  sections: new Map(), elements: new Map(), loadCases: new Map(), combinations: new Map(), diaphragms: new Map(),
});

function uniaxial(planeStrain) {
  const b = 1.0, h = 1.0, Ftot = 1000;
  const nodes = new Map([
    [1, { id: 1, x: 0, y: 0, z: 0, restraints: { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } }],
    [2, { id: 2, x: b, y: 0, z: 0, restraints: { ux: 0, uy: 0, uz: 1, rx: 1, ry: 1, rz: 1 } }],
    [3, { id: 3, x: b, y: h, z: 0, restraints: { ux: 0, uy: 0, uz: 1, rx: 1, ry: 1, rz: 1 } }],
    [4, { id: 4, x: 0, y: h, z: 0, restraints: { ux: 1, uy: 0, uz: 1, rx: 1, ry: 1, rz: 1 } }],
  ]);
  const areas = new Map([[1, { id: 1, nodes: [1, 2, 3, 4], matId: 1, thickness: t, planeStrain, behavior: 'membrane', kind: 'QUAD' }]]);
  const model = emptyModel(nodes, areas);
  const ni = buildNodeIndex(model), nDOF = ni.size * 6;
  const { K } = assembleK(model, ni); const Korig = K.slice();
  let kmax = 0; for (let i = 0; i < nDOF; i++) kmax = Math.max(kmax, Math.abs(K[i * nDOF + i]));
  const big = 1e12 * kmax; const F = new Float64Array(nDOF);
  for (const node of nodes.values()) { const d = getNodeDOFs(ni, node.id), r = node.restraints; [r.ux, r.uy, r.uz, r.rx, r.ry, r.rz].forEach((fx, i) => { if (fx) K[d[i] * nDOF + d[i]] += big; }); }
  F[getNodeDOFs(ni, 2)[0]] = Ftot / 2; F[getNodeDOFs(ni, 3)[0]] = Ftot / 2;
  const u = solveDense(K, F, nDOF);
  const reac = new Float64Array(nDOF);
  for (let i = 0; i < nDOF; i++) { let s = 0; for (let j = 0; j < nDOF; j++) s += Korig[i * nDOF + j] * u[j]; reac[i] = s - F[i]; }
  const res = new Results(model, ni, u, reac, F, null, false);
  return { s: res.getAreaStress(1), sigma: Ftot / (h * t) };
}

console.log('\n── #58 Tensión plana vs Deformación plana (membrana uniaxial) ──');
// plane-stress (referencia conocida)
{
  const { s, sigma } = uniaxial(false);
  rel(s.ex, sigma / E, 0.02, 'plane-stress: εx = σx/E');
  rel(s.ey, -nu * sigma / E, 0.05, 'plane-stress: εy = −ν·σx/E');
}
// plane-strain (rigidiza por confinamiento fuera del plano)
{
  const { s, sigma } = uniaxial(true);
  rel(s.ex, sigma * (1 - nu * nu) / E, 0.02, 'plane-strain: εx = σx(1−ν²)/E');
  rel(s.ey, -nu * (1 + nu) * sigma / E, 0.05, 'plane-strain: εy = −ν(1+ν)σx/E');
  // sanidad: la deformación plana es MÁS rígida (εx menor) que la tensión plana
  const ps = uniaxial(false);
  ok(s.ex < ps.s.ex, `plane-strain más rígida: εx(pε)=${s.ex.toExponential(3)} < εx(pσ)=${ps.s.ex.toExponential(3)}`);
}

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
