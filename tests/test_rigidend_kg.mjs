// test_rigidend_kg.mjs — el CACHO RÍGIDO en la rigidez GEOMÉTRICA (Kg) y en el
// espectro. Un tramo rígido no puede pandear ni deformarse axialmente, así que:
//
//   · Kg se arma sobre la luz flexible Lf y se lleva a los nodos por el mismo
//     brazo rígido que K y M.
//   · El axial N sale de EA·Δ/Lf (no /L): es la misma rigidez axial que ensambla
//     elemLocalK, y es lo que fija la ESCALA del factor de pandeo λcr.
//
// Caso analítico: columna en voladizo (empotrada abajo, libre arriba) de largo
// total L con un cacho `oi` en la base. El tramo flexible queda empotrado a la
// altura oi → columna de Euler con extremo libre:
//     Pcr = π²·E·I / (4·Lf²)      con Lf = L − oi
//     λcr = Pcr / P0
// Si N se calculara con L en vez de Lf, λcr saldría L/Lf veces MAYOR (inseguro)
// aunque el Pcr por elemento (λcr·N) siguiera pareciendo correcto.
import { Model } from '../js/model/model.js';
import { buildNodeIndex, assembleK } from '../js/solver/assembler.js';
import { assembleKg } from '../js/solver/geometric.js';

let fails = 0;
const ok  = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-12, `${m}  (${(+a).toExponential(5)} vs ${(+b).toExponential(5)})`);

globalThis.window = globalThis;
await import('../lib/numeric.js');
globalThis.window.numeric = globalThis.numeric;

// Gauss denso sólo para el estado de referencia K·u = F
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

const E = 2.1e8, b = 0.1, L = 3.0, P0 = 1.0e3;       // kN, m
const A = b * b, I = b ** 4 / 12, J = 0.1406 * b ** 4, As = (5 / 6) * A;

function lambdaCr(oi) {
  const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'M', E, G: E / 2.6, nu: 0.3, rho: 0 });
  const sec = m.addSection({ name: 'S', A, Iy: I, Iz: I, J, Avy: As, Avz: As });
  const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });   // base empotrada
  const n2 = m.addNode(0, 0, L);                                                  // tope libre
  const el = m.addElement(n1.id, n2.id, mat.id, sec.id);
  if (oi) m.updateElement(el.id, { rigidEnd: { i: oi, j: 0 } });

  const nodeIndex = buildNodeIndex(m);
  const { K, nDOF } = assembleK(m, nodeIndex);
  const fixed = new Set([0, 1, 2, 3, 4, 5].map(d => 6 * nodeIndex.get(n1.id) + d));
  const freeDOF = []; for (let d = 0; d < nDOF; d++) if (!fixed.has(d)) freeDOF.push(d);
  const nF = freeDOF.length;

  const F = new Float64Array(nDOF); F[6 * nodeIndex.get(n2.id) + 2] = -P0;   // compresión
  const Kff = freeDOF.map(gi => freeDOF.map(gj => K[gi * nDOF + gj]));
  const uf  = solveDense(Kff, freeDOF.map(gi => F[gi]), nF);
  const u   = new Float64Array(nDOF); freeDOF.forEach((gi, i) => u[gi] = uf[i]);

  const { Kg, Nby } = assembleKg(m, nodeIndex, u);

  // Autovalores del plano de flexión XZ: los únicos GDL libres que participan son
  // ux y ry del tope. Con 2×2 el problema det(K + λ·Kg) = 0 es una cuadrática, así
  // que se resuelve exacto — sin depender del iterador de subespacio (que necesita
  // más GDL de los que tiene un voladizo de un solo elemento).
  const t = 6 * nodeIndex.get(n2.id);
  const d = [t + 0, t + 4];                       // ux, ry
  const g = (M, i, j) => M[d[i] * nDOF + d[j]];
  const K00 = g(K, 0, 0), K01 = g(K, 0, 1), K10 = g(K, 1, 0), K11 = g(K, 1, 1);
  const G00 = g(Kg, 0, 0), G01 = g(Kg, 0, 1), G10 = g(Kg, 1, 0), G11 = g(Kg, 1, 1);
  const qa = G00 * G11 - G01 * G10;
  const qb = K00 * G11 + G00 * K11 - K01 * G10 - G01 * K10;
  const qc = K00 * K11 - K01 * K10;
  const disc = Math.sqrt(qb * qb - 4 * qa * qc);
  const roots = [(-qb + disc) / (2 * qa), (-qb - disc) / (2 * qa)].filter(r => r > 0);
  return { lambda: Math.min(...roots), N: Nby.get(el.id) };
}

// ── 1) El axial N ve la luz flexible ─────────────────────────────────────────
// La barra está en serie con un tramo rígido: la carga es P0 de compresión, así
// que N = −P0 SIEMPRE (equilibrio), independientemente del cacho. Lo que cambia
// es el acortamiento; si N se dedujera con L en vez de Lf, saldría −P0·Lf/L.
console.log('── 1) Axial N bajo el cacho (equilibrio) ──');
for (const oi of [0, 0.75, 1.5]) {
  const { N } = lambdaCr(oi);
  rel(N, -P0, 1e-9, `oi=${oi}: N = −P0 (no escalado por Lf/L)`);
}

// ── 2) Pandeo de Euler sobre la luz flexible ─────────────────────────────────
console.log('\n── 2) λcr = π²EI/(4·Lf²)/P0 ──');
for (const oi of [0, 0.75, 1.5]) {
  const Lf = L - oi;
  const { lambda } = lambdaCr(oi);
  const lamEuler = (Math.PI ** 2 * E * I / (4 * Lf * Lf)) / P0;
  // 1 solo elemento (el cacho es propiedad del elemento, no se puede subdividir):
  // el Kg consistente sobreestima ~1% el modo fundamental del voladizo.
  rel(lambda, lamEuler, 2e-2, `oi=${oi}: λcr (Lf=${Lf})`);
}

// ── 3) Monotonía: más cacho → más carga crítica ──────────────────────────────
console.log('\n── 3) Monotonía ──');
{
  const a = lambdaCr(0).lambda, c = lambdaCr(1.5).lambda;
  ok(c > a, `el cacho aumenta λcr (${c.toFixed(2)} > ${a.toFixed(2)})`);
}

console.log(fails ? `\n${fails} FALLO(S)` : '\nTODO OK ✓');
process.exit(fails ? 1 : 0);
