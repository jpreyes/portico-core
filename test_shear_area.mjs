// test_shear_area.mjs — Model.addSection shear-area default (Avy/Avz).
//
// A section defined by area alone must get shear areas that SCALE with A (Avy = A·κ),
// not the base section's fixed 0.075. Otherwise the Timoshenko shear stiffness is wrong
// for any custom section. Two levels:
//   A) unit — addSection derives Avy/Avz = A·κ, respects explicit values, default intact.
//   B) physics — a short/thick cantilever whose section is defined by A only reproduces
//      the Timoshenko tip deflection δ = PL³/3EI + PL/(G·A·κ), which differs from what the
//      old fixed 0.075 would give (so the fix is load-bearing, not cosmetic).
import { Model } from './js/model/model.js';
import { localAxes, stiffnessMatrix, transformMatrix, globalStiffness } from './js/solver/timoshenko.js';

let failures = 0;
const check = (cond, msg, extra = '') => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  ' + extra : ''}`); if (!cond) failures++; };
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

// dense Gauss solve (same helper as test_beam_element)
function solve(K, f, n) {
  const M = K.map(r => r.slice()), x = f.slice();
  for (let k = 0; k < n; k++) { let p = k; for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    [M[k], M[p]] = [M[p], M[k]]; [x[k], x[p]] = [x[p], x[k]];
    for (let i = k + 1; i < n; i++) { const c = M[i][k] / M[k][k]; for (let j = k; j < n; j++) M[i][j] -= c * M[k][j]; x[i] -= c * x[k]; } }
  for (let k = n - 1; k >= 0; k--) { let s = x[k]; for (let j = k + 1; j < n; j++) s -= M[k][j] * x[j]; x[k] = s / M[k][k]; }
  return x;
}

const m = new Model();

// ── A) unit-level: shear areas scale with A ─────────────────────────────────────
console.log('── A) addSection: Avy/Avz derivadas de A·κ ──');
const sA = m.addSection({ name: 'A-only', A: 0.16, Iy: 2.133e-3, Iz: 2.133e-3, J: 3.6e-3 });
check(rel(sA.Avy, 0.16 * 0.833) < 1e-12, 'A=0.16 → Avy = A·κ', `(${sA.Avy.toFixed(5)} vs ${(0.16 * 0.833).toFixed(5)})`);
check(rel(sA.Avz, 0.16 * 0.833) < 1e-12, 'A=0.16 → Avz = A·κ', `(${sA.Avz.toFixed(5)})`);
check(Math.abs(sA.Avy - 0.075) > 1e-3, 'Avy ya NO es el 0.075 fijo (escala con A)', `(${sA.Avy.toFixed(5)} ≠ 0.075)`);

const sExp = m.addSection({ name: 'explicit', A: 0.16, Avy: 0.05, Avz: 0.06, Iy: 1e-3, Iz: 1e-3, J: 1e-3 });
check(sExp.Avy === 0.05 && sExp.Avz === 0.06, 'Avy/Avz explícitas se respetan', `(${sExp.Avy}, ${sExp.Avz})`);

const sDef = m.addSection({});
check(rel(sDef.Avy, 0.09 * 0.833) < 1e-12, 'sección por defecto: Avy ≈ 0.075 (sin cambios)', `(${sDef.Avy.toFixed(5)})`);

const sK = m.addSection({ A: 0.2, kappay: 0.5, kappaz: 0.9 });
check(rel(sK.Avy, 0.2 * 0.5) < 1e-12 && rel(sK.Avz, 0.2 * 0.9) < 1e-12, 'usa la κ provista (Avy=A·κy, Avz=A·κz)', `(${sK.Avy}, ${sK.Avz})`);

// ── B) physics: Timoshenko cantilever with a section defined by A only ──────────
console.log('\n── B) voladizo Timoshenko: δ = PL³/3EI + PL/(G·A·κ) ──');
const E = 2.1e8, G = 2.1e8 / 2.6;                 // kN/m², consistent
const Lt = 1.0, P = 1000;                          // short/thick → shear ≈ 50% of δ
const Iz = 2.133e-3, kappa = 0.833, A = 0.16;
const secByArea = m.addSection({ name: 'col', A, Iy: Iz, Iz, J: 3.6e-3 });   // Avy derived
const Avy = secByArea.Avy;                          // = A·κ

// single 2-node Timoshenko element cantilever, tip load along local y (global Z)
const n1 = { id: 1, x: 0, y: 0, z: 0 }, n2 = { id: 2, x: Lt, y: 0, z: 0 };
const { ex, ey, ez, L } = localAxes(n1, n2);
const Kg = globalStiffness(stiffnessMatrix(L, { E, G }, secByArea), transformMatrix(ex, ey, ez));
const free = [6, 7, 8, 9, 10, 11];
const Kff = free.map(i => free.map(j => Kg[i][j]));
const u = solve(Kff, [0, 0, P, 0, 0, 0], 6);        // load along local y → free idx 2

const dBend = P * Lt ** 3 / (3 * E * Iz);
const dTimo = dBend + P * Lt / (G * Avy);           // correct: A·κ
const dOld  = dBend + P * Lt / (G * 0.075);         // what the old fixed 0.075 would give
check(rel(u[2], dTimo) < 1e-6, 'δ_FE = Euler + corte con A·κ', `(${u[2].toExponential(5)} vs ${dTimo.toExponential(5)})`);
check(rel(dTimo, dOld) > 0.05, 'el fix cambia la deflexión de corte vs el 0.075 viejo (>5%)', `(${dTimo.toExponential(4)} vs ${dOld.toExponential(4)})`);
check(u[2] > dBend, 'el corte aumenta la deflexión vs Euler');

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
