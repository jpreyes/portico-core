import { mitc4Plate, dktPlate, plateD } from '../js/solver/plate.js';

// ── mini álgebra densa ───────────────────────────────────────────────────────
function solve(A, b, n) {
  // eliminación gaussiana con pivoteo parcial
  const M = A.map(r => r.slice()); const x = b.slice();
  for (let k = 0; k < n; k++) {
    let p = k; for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    [M[k], M[p]] = [M[p], M[k]]; [x[k], x[p]] = [x[p], x[k]];
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / M[k][k];
      for (let j = k; j < n; j++) M[i][j] -= f * M[k][j];
      x[i] -= f * x[k];
    }
  }
  for (let k = n - 1; k >= 0; k--) { let s = x[k]; for (let j = k + 1; j < n; j++) s -= M[k][j] * x[j]; x[k] = s / M[k][k]; }
  return x;
}

// potencia inversa para el menor autovalor (chequeo de modos rígidos)
function smallestEigs(K, n, count) {
  // cuenta autovalores ~0 vía diagonalización por Jacobi (matrices pequeñas)
  const A = K.map(r => r.slice());
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-15) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const tt = Math.sign(th) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(tt * tt + 1), s = tt * c;
      for (let i = 0; i < n; i++) {
        const aip = A[i][p], aiq = A[i][q];
        A[i][p] = c * aip - s * aiq; A[i][q] = s * aip + c * aiq;
      }
      for (let i = 0; i < n; i++) {
        const api = A[p][i], aqi = A[q][i];
        A[p][i] = c * api - s * aqi; A[q][i] = s * api + c * aqi;
      }
    }
  }
  const ev = []; for (let i = 0; i < n; i++) ev.push(A[i][i]);
  ev.sort((a, b) => a - b);
  return ev.slice(0, count);
}

function toDense(Ke, n) { const M = []; for (let i = 0; i < n; i++) { M.push([]); for (let j = 0; j < n; j++) M[i].push(Ke[i * n + j]); } return M; }

// ── 1) Modos rígidos (3 ceros esperados) ─────────────────────────────────────
const E = 2.1e11, nu = 0.3, t = 0.01;
{
  const q = mitc4Plate([[0, 0], [1, 0], [1, 1], [0, 1]], E, nu, t);
  const kref = Math.max(...[...Array(12)].map((_, i) => q[i * 12 + i]));
  const ev = smallestEigs(toDense(q, 12), 12, 5).map(v => v / kref);
  console.log('MITC4 menores autovalores (norm.):', ev.map(v => v.toExponential(2)).join(', '));
  const zeros = ev.filter(v => Math.abs(v) < 1e-9).length;
  console.log('  modos rígidos =', zeros, zeros === 3 ? 'OK (esperado 3)' : 'FALLO');
}
{
  const tr = dktPlate([[0, 0], [1, 0], [0, 1]], E, nu, t);
  const kref = Math.max(...[...Array(9)].map((_, i) => tr[i * 9 + i]));
  const ev = smallestEigs(toDense(tr, 9), 9, 5).map(v => v / kref);
  console.log('DKT menores autovalores (norm.):', ev.map(v => v.toExponential(2)).join(', '));
  const zeros = ev.filter(v => Math.abs(v) < 1e-9).length;
  console.log('  modos rígidos =', zeros, zeros === 3 ? 'OK (esperado 3)' : 'FALLO');
}

// ── 2) Placa cuadrada: deflexión central bajo carga puntual P ────────────────
// SS:  w = 0.01160 P L²/D ; Empotrada: w = 0.00560 P L²/D ;  D = E t³/12(1-ν²)
function squarePlate(kind, nx, bc) {
  const L = 1.0, P = 1000;
  const D = E * t * t * t / (12 * (1 - nu * nu));
  const nodes = [], idx = (i, j) => i * (nx + 1) + j;
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nx; j++) nodes.push([i * L / nx, j * L / nx]);
  const nN = nodes.length, nDOF = 3 * nN;
  const K = []; for (let i = 0; i < nDOF; i++) K.push(new Float64Array(nDOF));
  const addElem = (Ke, ng, gnodes) => {
    for (let a = 0; a < gnodes.length; a++) for (let b = 0; b < gnodes.length; b++)
      for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++)
        K[3 * gnodes[a] + r][3 * gnodes[b] + s] += Ke[(3 * a + r) * ng + (3 * b + s)];
  };
  for (let i = 0; i < nx; i++) for (let j = 0; j < nx; j++) {
    const n1 = idx(i, j), n2 = idx(i + 1, j), n3 = idx(i + 1, j + 1), n4 = idx(i, j + 1);
    if (kind === 'quad') {
      addElem(mitc4Plate([nodes[n1], nodes[n2], nodes[n3], nodes[n4]], E, nu, t), 12, [n1, n2, n3, n4]);
    } else {
      addElem(dktPlate([nodes[n1], nodes[n2], nodes[n3]], E, nu, t), 9, [n1, n2, n3]);
      addElem(dktPlate([nodes[n1], nodes[n3], nodes[n4]], E, nu, t), 9, [n1, n3, n4]);
    }
  }
  // BC
  const fixed = new Set();
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nx; j++) {
    const onB = i === 0 || j === 0 || i === nx || j === nx;
    if (onB) {
      fixed.add(3 * idx(i, j));                 // w=0 (SS y empotrada)
      if (bc === 'clamped') { fixed.add(3 * idx(i, j) + 1); fixed.add(3 * idx(i, j) + 2); }
    }
  }
  const F = new Float64Array(nDOF);
  const cN = idx(nx / 2, nx / 2); F[3 * cN] = P;
  // penalización para fijos
  const big = 1e30;
  for (const d of fixed) K[d][d] += big;
  const Kd = K.map(r => Array.from(r));
  const u = solve(Kd, Array.from(F), nDOF);
  const wc = u[3 * cN];
  const coef = wc * D / (P * L * L);
  return coef;
}

console.log('\nPlaca cuadrada — coeficiente w_c·D/(P·L²):');
for (const bc of ['ss', 'clamped']) {
  const ref = bc === 'ss' ? 0.01160 : 0.00560;
  for (const kind of ['quad', 'tri']) {
    const c = squarePlate(kind, 8, bc);
    const err = (c - ref) / ref * 100;
    console.log(`  ${kind.padEnd(4)} ${bc.padEnd(8)} = ${c.toFixed(5)}  (ref ${ref}, err ${err.toFixed(1)}%)`);
  }
}
