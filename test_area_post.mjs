// Verificación del POSTPROCESO de elementos de área (G10 #49):
//  (1) las áreas entran en el ensamblaje/solución (la deformada existe);
//  (2) Results.getAreaStress devuelve tensiones correctas (membrana uniaxial
//      analítica: σx = F/(b·t)); getNodalAreaVM produce un campo nodal;
//  (3) en un shell con flexión, getAreaStress entrega momentos de placa (Mx…).
//  (4) equilibrio global: ΣReacciones = ΣCargas.
import { buildNodeIndex, assembleK, getNodeDOFs } from './js/solver/assembler.js?v=118';
import { Results } from './js/solver/postprocess.js?v=118';

const E = 2.1e11, nu = 0.3, t = 0.01;

// solver denso (Gauss con pivoteo) sobre Float64Array plano nDOF×nDOF
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

function emptyModel(nodes, areas) {
  return {
    nodes, areas,
    materials: new Map([[1, { id: 1, E, nu, alpha: 0, density: 0 }]]),
    sections: new Map(), elements: new Map(),
    loadCases: new Map(), combinations: new Map(), diaphragms: new Map(),
  };
}

// ── (2) Membrana: tracción uniaxial en una sola QUAD 1×1 (plano XY) ──────────
function membraneUniaxial() {
  const b = 1.0, h = 1.0, Ftot = 1000;     // N total en el borde +x
  const nodes = new Map([
    [1, { id: 1, x: 0, y: 0, z: 0, restraints: { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } }],
    [2, { id: 2, x: b, y: 0, z: 0, restraints: { ux: 0, uy: 0, uz: 1, rx: 1, ry: 1, rz: 1 } }],
    [3, { id: 3, x: b, y: h, z: 0, restraints: { ux: 0, uy: 0, uz: 1, rx: 1, ry: 1, rz: 1 } }],
    [4, { id: 4, x: 0, y: h, z: 0, restraints: { ux: 1, uy: 0, uz: 1, rx: 1, ry: 1, rz: 1 } }],
  ]);
  const areas = new Map([[1, { id: 1, nodes: [1, 2, 3, 4], matId: 1, thickness: t, planeStrain: false, behavior: 'membrane', kind: 'QUAD' }]]);
  const model = emptyModel(nodes, areas);
  const nodeIndex = buildNodeIndex(model);
  const nDOF = nodeIndex.size * 6;
  const { K } = assembleK(model, nodeIndex);
  const Korig = K.slice();   // sin penalizar → reacciones = Korig·u − F

  // BC por penalización + cargas
  let kmax0 = 0; for (let i = 0; i < nDOF; i++) kmax0 = Math.max(kmax0, Math.abs(K[i * nDOF + i]));
  const big = 1e12 * kmax0;
  const F = new Float64Array(nDOF);
  for (const node of nodes.values()) {
    const d = getNodeDOFs(nodeIndex, node.id), r = node.restraints;
    [r.ux, r.uy, r.uz, r.rx, r.ry, r.rz].forEach((fx, i) => { if (fx) K[d[i] * nDOF + d[i]] += big; });
  }
  F[getNodeDOFs(nodeIndex, 2)[0]] = Ftot / 2;
  F[getNodeDOFs(nodeIndex, 3)[0]] = Ftot / 2;

  const u = solveDense(K, F, nDOF);
  // reacciones = Korig·u − F (sólo significativas en los GDL restringidos)
  const reac = new Float64Array(nDOF);
  for (let i = 0; i < nDOF; i++) { let s = 0; for (let j = 0; j < nDOF; j++) s += Korig[i * nDOF + j] * u[j]; reac[i] = s - F[i]; }

  const res = new Results(model, nodeIndex, u, reac, F, null, false);
  const s = res.getAreaStress(1);
  const nodal = res.getNodalAreaVM();
  const sigmaTeo = Ftot / (h * t);   // 1e5 Pa
  console.log('── (2) Membrana uniaxial 1×1 ──');
  console.log(`  σx solver = ${s.sx.toExponential(4)}  | teórico = ${sigmaTeo.toExponential(4)}  err ${((s.sx - sigmaTeo) / sigmaTeo * 100).toFixed(2)}%`);
  console.log(`  σy ≈ 0 ? ${s.sy.toExponential(3)} · τxy ≈ 0 ? ${s.txy.toExponential(3)}`);
  console.log(`  von Mises = ${s.vm.toExponential(4)} (≈ σx)`);
  console.log(`  Mx (membrana → debe ser undefined): ${s.Mx}`);
  // Deformaciones: estado uniaxial de TENSIÓN (σy=0) ⇒ εx=σx/E, εy=−ν·σx/E
  const exTeo = sigmaTeo / E, eyTeo = -nu * sigmaTeo / E;
  console.log(`  εx solver = ${s.ex.toExponential(4)} | teórico σx/E = ${exTeo.toExponential(4)}  err ${((s.ex - exTeo) / exTeo * 100).toFixed(2)}%`);
  console.log(`  εy solver = ${s.ey.toExponential(4)} | teórico −ν·σx/E = ${eyTeo.toExponential(4)}`);
  console.log(`  γxy ≈ 0 ? ${s.gxy.toExponential(3)} · ε₁=${s.e1.toExponential(3)} ε₂=${s.e2.toExponential(3)}`);
  console.log(`  campo nodal vM: ${nodal.size} nodos (esperado 4)`);

  // equilibrio: ΣRx de apoyos = −ΣFx aplicada
  let Rx = 0; for (const node of nodes.values()) Rx += reac[getNodeDOFs(nodeIndex, node.id)[0]];
  console.log(`  ΣRx reacciones = ${Rx.toFixed(3)} N  | ΣFx cargas = ${Ftot} N  → suma=${(Rx + Ftot).toExponential(2)} (≈0)`);
  const ok = Math.abs(s.sx - sigmaTeo) / sigmaTeo < 0.02 && Math.abs(s.vm - sigmaTeo) / sigmaTeo < 0.05
    && Math.abs(Rx + Ftot) < 1e-3 * Ftot && s.Mx == null && nodal.size === 4
    && Math.abs(s.ex - exTeo) / Math.abs(exTeo) < 0.02 && Math.abs(s.ey - eyTeo) / Math.abs(eyTeo) < 0.05
    && Math.abs(s.gxy) < 1e-9 * Math.abs(s.ex);
  console.log('  →', ok ? 'OK' : 'FALLO');
  return ok;
}

// ── (3) Shell con flexión: voladizo de una franja, comprobar Mx no nulo ──────
function shellBending() {
  // franja 2×1 (2 elementos en x) en voladizo, carga puntual hacia −z en la punta
  const L = 1.0, w = 1.0, P = 100;
  const nodes = new Map();
  const fix = { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 };
  const free = { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 };
  let id = 1; const grid = [];
  for (let i = 0; i <= 2; i++) { grid.push([]); for (let j = 0; j <= 1; j++) {
    const x = i * L / 2, y = j * w;
    nodes.set(id, { id, x, y, z: 0, restraints: i === 0 ? { ...fix } : { ...free } });
    grid[i].push(id); id++;
  } }
  const areas = new Map();
  let aid = 1;
  for (let i = 0; i < 2; i++) areas.set(aid, { id: aid++, nodes: [grid[i][0], grid[i + 1][0], grid[i + 1][1], grid[i][1]], matId: 1, thickness: t, planeStrain: false, behavior: 'shell', kind: 'QUAD' });
  const model = emptyModel(nodes, areas);
  const nodeIndex = buildNodeIndex(model);
  const nDOF = nodeIndex.size * 6;
  const { K } = assembleK(model, nodeIndex);
  const Korig = K.slice();
  let kmax = 0; for (let i = 0; i < nDOF; i++) kmax = Math.max(kmax, Math.abs(K[i * nDOF + i]));
  const big = 1e12 * kmax;
  const F = new Float64Array(nDOF);
  for (const node of nodes.values()) {
    const d = getNodeDOFs(nodeIndex, node.id), r = node.restraints;
    [r.ux, r.uy, r.uz, r.rx, r.ry, r.rz].forEach((fx, i) => { if (fx) K[d[i] * nDOF + d[i]] += big; });
  }
  // punta: −z en los dos nodos del borde libre
  F[getNodeDOFs(nodeIndex, grid[2][0])[2]] = -P / 2;
  F[getNodeDOFs(nodeIndex, grid[2][1])[2]] = -P / 2;
  const u = solveDense(K, F, nDOF);
  const reac = new Float64Array(nDOF);
  for (let i = 0; i < nDOF; i++) { let s = 0; for (let j = 0; j < nDOF; j++) s += Korig[i * nDOF + j] * u[j]; reac[i] = s - F[i]; }
  const res = new Results(model, nodeIndex, u, reac, F, null, false);
  const sBase = res.getAreaStress(1);   // elemento en el empotramiento
  const wTip = res.getNodeDisp(grid[2][0])[2];
  console.log('\n── (3) Shell voladizo (flexión) ──');
  console.log(`  deformada punta wz = ${wTip.toExponential(3)} m (≠0 ⇒ las áreas se deforman)`);
  console.log(`  Mx (placa) en la base = ${sBase.Mx == null ? 'undefined' : sBase.Mx.toExponential(3)} kN·m/m`);
  console.log(`  κx (curvatura) en la base = ${sBase.kx == null ? 'undefined' : sBase.kx.toExponential(3)} 1/m`);
  console.log(`  vM superficie = ${sBase.vmSurf?.toExponential(3)} · membrana = ${sBase.vmMembrane?.toExponential(3)}`);
  // ΣRz de apoyos = P
  let Rz = 0; for (const node of nodes.values()) Rz += reac[getNodeDOFs(nodeIndex, node.id)[2]];
  console.log(`  ΣRz = ${Rz.toFixed(3)} N  | P = ${P} N → suma=${(Rz - P).toExponential(2)} (≈0)`);
  const ok = wTip < 0 && sBase.Mx != null && isFinite(sBase.Mx) && Math.abs(sBase.Mx) > 0
    && sBase.kx != null && isFinite(sBase.kx) && Math.abs(sBase.kx) > 0
    && sBase.vmSurf != null && Math.abs(Rz - P) < 1e-2 * P;
  console.log('  →', ok ? 'OK' : 'FALLO');
  return ok;
}

const r1 = membraneUniaxial();
const r2 = shellBending();
console.log('\n=== RESULTADO:', (r1 && r2) ? 'TODO OK' : 'HAY FALLOS', '===');
process.exit(r1 && r2 ? 0 : 1);
