// test_buckling.mjs — verificación del motor de PANDEO LINEAL por iteración de
// subespacio (js/solver/buckling.js) contra la solución ANALÍTICA de Euler.
//
//   Columna biarticulada (pinned-pinned), compresión axial de referencia P0.
//   Euler:  Pcr_n = n²·π²·E·I / L²    ⇒   λcr_n = Pcr_n / P0
//
// Sección CUADRADA (Iy = Iz) ⇒ los modos se emparejan por plano: λ1≈λ2 (n=1),
// λ3≈λ4 (n=2). Comparamos λ1·P0 con π²EI/L² y λ3·P0 con 4π²EI/L².
//
// Ejecutar:  node test_buckling.mjs
import { buildNodeIndex, assembleK } from './js/solver/assembler.js?v=106';
import { assembleKg } from './js/solver/geometric.js?v=106';
import { solveBuckling } from './js/solver/buckling.js?v=106';

// ── Solver denso (Gauss) sólo para el estado de referencia K·u = F ────────────
function solveDense(A, b, n) {
  const M = A.map(r => Array.from(r)); const x = Array.from(b);
  for (let k = 0; k < n; k++) {
    let p = k; for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    [M[k], M[p]] = [M[p], M[k]]; [x[k], x[p]] = [x[p], x[k]];
    for (let i = k + 1; i < n; i++) { const f = M[i][k] / M[k][k]; for (let j = k; j < n; j++) M[i][j] -= f * M[k][j]; x[i] -= f * x[k]; }
  }
  for (let k = n - 1; k >= 0; k--) { let s = x[k]; for (let j = k + 1; j < n; j++) s -= M[k][j] * x[j]; x[k] = s / M[k][k]; }
  return x;
}

const E = 2.1e11, nu = 0.3, b = 0.1, L = 3.0, P0 = 1.0e6;   // SI (N, m)
const A = b * b, I = b ** 4 / 12, J = 0.1406 * b ** 4, As = (5 / 6) * A;
const G = E / (2 * (1 + nu));

function buildColumn(nEl) {
  const nodes = new Map(), elements = new Map(), materials = new Map(), sections = new Map();
  materials.set(1, { id: 1, E, nu, G, rho: 0, alpha: 0 });
  sections.set(1, { id: 1, A, Iy: I, Iz: I, J, Avy: As, Avz: As });
  for (let i = 0; i <= nEl; i++) nodes.set(i, { id: i, x: 0, y: 0, z: i * L / nEl, restraints: {}, springs: null });
  for (let i = 0; i < nEl; i++) elements.set(i, { id: i, n1: i, n2: i + 1, matId: 1, secId: 1, releases: null });
  return { nodes, elements, materials, sections, areas: new Map(), diaphragms: new Map(), loadCases: new Map() };
}

function lambdasFor(nEl) {
  const model = buildColumn(nEl);
  const nodeIndex = buildNodeIndex(model);
  const { K, nDOF } = assembleK(model, nodeIndex);

  // BC: columna biarticulada en el plano de flexión.
  //   base (z=0): ux=uy=uz fijos, rotaciones de flexión libres, torsión rz fija.
  //   tope (z=L): ux=uy fijos, uz LIBRE (toma la carga axial), rz fijo.
  const top = model.nodes.size - 1;
  const fixed = new Set();
  const fix = (node, dof) => fixed.add(6 * nodeIndex.get(node) + dof);
  fix(0, 0); fix(0, 1); fix(0, 2); fix(0, 5);     // base pin + sin torsión
  fix(top, 0); fix(top, 1); fix(top, 5);          // tope: lateral + torsión
  const freeDOF = [];
  for (let d = 0; d < nDOF; d++) if (!fixed.has(d)) freeDOF.push(d);
  const nF = freeDOF.length;

  // Carga de referencia: P0 de compresión (−Z) en el tope.
  const F = new Float64Array(nDOF); F[6 * nodeIndex.get(top) + 2] = -P0;

  // Estado de referencia: K_ff·u = F_ff
  const Kff2 = freeDOF.map(gi => freeDOF.map(gj => K[gi * nDOF + gj]));
  const Ff = freeDOF.map(gi => F[gi]);
  const uf = solveDense(Kff2, Ff, nF);
  const u = new Float64Array(nDOF); freeDOF.forEach((gi, i) => u[gi] = uf[i]);

  const { Kg } = assembleKg(model, nodeIndex, u);

  const Kff_flat = new Float64Array(nF * nF), Kgff_flat = new Float64Array(nF * nF);
  for (let i = 0; i < nF; i++) for (let j = 0; j < nF; j++) {
    Kff_flat[i * nF + j] = K[freeDOF[i] * nDOF + freeDOF[j]];
    Kgff_flat[i * nF + j] = Kg[freeDOF[i] * nDOF + freeDOF[j]];
  }

  const res = solveBuckling({ Kff_flat, Kgff_flat, nF, nModes: 4 });
  if (res.error) throw new Error(res.error);
  return res.modes.map(m => m.lambda);
}

const Pcr1 = Math.PI ** 2 * E * I / (L * L);     // n=1
const lamEuler1 = Pcr1 / P0, lamEuler2 = 4 * Pcr1 / P0;

console.log('Pandeo lineal — columna biarticulada (subespacio vs Euler)');
console.log(`  Euler: λcr(n=1) = ${lamEuler1.toFixed(4)} · λcr(n=2) = ${lamEuler2.toFixed(4)}\n`);

let allOk = true;
for (const nEl of [4, 8, 16]) {
  const lam = lambdasFor(nEl);
  const e1 = (lam[0] - lamEuler1) / lamEuler1 * 100;
  // primer modo del 2º par (n=2): el 3er λ distinto (saltando el par n=1)
  const lam3 = lam[2] ?? NaN;
  const e2 = (lam3 - lamEuler2) / lamEuler2 * 100;
  const ok1 = Math.abs(e1) < 1.0, ok2 = !isFinite(lam3) || Math.abs(e2) < 5.0;
  allOk = allOk && ok1 && ok2;
  console.log(`  ${String(nEl).padStart(2)} elem · λ1=${lam[0].toFixed(4)} (err ${e1.toFixed(2)}%) ${ok1 ? '✓' : '✗'}` +
              ` · λ3=${isFinite(lam3) ? lam3.toFixed(4) : '—'} (err ${isFinite(lam3) ? e2.toFixed(2) + '%' : 'n/a'}) ${ok2 ? '✓' : '✗'}` +
              `   [${lam.map(l => l.toFixed(3)).join(', ')}]`);
}

console.log('\n' + (allOk ? '✅ PASA — el subespacio reproduce Euler (≡ equivalente).' : '❌ FALLA — revisar el motor de pandeo.'));
process.exit(allOk ? 0 : 1);
