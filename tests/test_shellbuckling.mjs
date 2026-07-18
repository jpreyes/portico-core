// Verificación — pandeo de cáscara (placa de Bryan, 2-016/2-017).
// Placa cuadrada SIMPLEMENTE APOYADA (w=0 en los 4 bordes) bajo compresión uniaxial
// uniforme Nx. Carga crítica de Bryan: Nx_cr = k·π²·D/a², k=4 (cuadrada), D=Et³/12(1−ν²).
// La rigidez geométrica de membrana (assembleAreasKgInto) debe reproducirla.
import '../lib/numeric.js';
import { Model } from '../js/model/model.js';
import { buildNodeIndex, assembleK, getNodeDOFs } from '../js/solver/assembler.js';
import { assembleKg } from '../js/solver/geometric.js';
import { solveBuckling } from '../js/solver/buckling.js';
import { StaticSolver } from '../js/solver/static_solver.js';
globalThis.window = globalThis;

const a = 1, t = 0.01, E = 2.1e8, nu = 0.3;          // m, kN/m² (kPa)
const D = E * t**3 / (12 * (1 - nu*nu));
const NxCr = 4 * Math.PI**2 * D / (a*a);             // Bryan k=4
const Nx = 1000;                                     // compresión aplicada (kN/m)
const n = 12;                                        // malla n×n quads

const m = new Model();
const matId = m.addMaterial({ name: "pl", E, G: E/(2*(1+nu)), nu, rho: 0 }).id;
const id = [];
for (let i = 0; i <= n; i++) { id.push([]); for (let j = 0; j <= n; j++) id[i].push(m.addNode(i*a/n, j*a/n, 0).id); }
for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
  m.addArea([id[i][j], id[i+1][j], id[i+1][j+1], id[i][j+1]], matId, { thickness: t, behavior: 'shell' });

const lc = m.addLoadCase('cx', false);
const P = Nx * a / n;                                // fuerza por tramo del borde x=a
for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
  const onL = i === 0, onR = i === n, onB = j === 0, onT = j === n, onEdge = onL||onR||onB||onT;
  const r = {};
  if (onL) r.ux = 1;        // ux=0 en x=0
  if (onB) r.uy = 1;        // uy=0 en y=0 (quita RB en Y; deja expandir por Poisson)
  if (onEdge) r.uz = 1;     // w=0 SS en los 4 bordes
  m.updateNode(id[i][j], { restraints: r });
  if (onR) lc.loads.push({ type: 'nodal', nodeId: id[i][j], F: [-((onB||onT) ? P/2 : P), 0, 0, 0, 0, 0] });
}

// Estado de referencia: estático bajo la compresión en el plano
const ni = buildNodeIndex(m), nDOF = ni.size * 6;
const res = new StaticSolver().solve(m, lc.id, false);
const u = new Float64Array(nDOF);
for (const nd of m.nodes.values()) { const d = getNodeDOFs(ni, nd.id), dz = res.getNodeDisp(nd.id); for (let k = 0; k < 6; k++) u[d[k]] = dz[k]; }

const { K } = assembleK(m, ni);
const { Kg } = assembleKg(m, ni, u);   // ahora incluye la cáscara

const free = [];
for (const nd of m.nodes.values()) { const d = getNodeDOFs(ni, nd.id), r = nd.restraints;
  const fix = [r.ux, r.uy, r.uz, r.rx, r.ry, r.rz];
  for (let k = 0; k < 6; k++) if (!fix[k]) free.push(d[k]); }
const nF = free.length;
const Kff = new Float64Array(nF*nF), Kgff = new Float64Array(nF*nF);
for (let i = 0; i < nF; i++) { const ri = free[i]*nDOF; for (let j = 0; j < nF; j++) { Kff[i*nF+j] = K[ri+free[j]]; Kgff[i*nF+j] = Kg[ri+free[j]]; } }

const buck = solveBuckling({ Kff_flat: Kff, Kgff_flat: Kgff, nF, nModes: 4, dense: true });
if (buck.error) { console.log('XX solveBuckling:', buck.error); process.exit(1); }
const lcr = buck.modes[0].lambda;
const NxCrFE = lcr * Nx;
const err = (NxCrFE / NxCr - 1) * 100;

console.log(`D=${D.toFixed(3)} kN·m · Bryan Nx_cr = ${NxCr.toFixed(1)} kN/m`);
console.log(`FE: λcr=${lcr.toFixed(4)} → Nx_cr = ${NxCrFE.toFixed(1)} kN/m  (${err.toFixed(1)}% vs Bryan, malla ${n}×${n})`);
const ok = lcr > 0 && Math.abs(err) <= 12;   // malla gruesa sobreestima ~algunos %
console.log(`${lcr > 0 ? 'OK ' : 'XX '} λcr > 0 (modo de compresión)`);
console.log(`${Math.abs(err) <= 12 ? 'OK ' : 'XX '} dentro de 12% de Bryan`);
console.log(ok ? '\n✅ TODO OK' : '\n❌ FALLÓ');
process.exit(ok ? 0 : 1);
