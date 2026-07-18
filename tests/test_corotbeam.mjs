// Verificación — viga corotacional 2D (gran rotación, 1-029).
// Voladizo bajo MOMENTO DE PUNTA: solución exacta = arco circular de curvatura
// κ=M/EI constante. Rotación de punta θ=κ·L (exacta, independiente de la malla);
// posición de punta x=sin(κL)/κ, z=(1−cos(κL))/κ (converge con la malla).
import { solveCorotBeam } from '../js/solver/corotbeam.js';

const L = 2, EI = 19372.5, EA = 2.583e6;   // sección/material por defecto (0.30², H30)
const phi = 1.5;                            // rotación total deseada (rad) — GRANDE
const kappa = phi / L, M = EI * kappa;      // momento que produce ese arco

const N = 24;                               // nº de elementos
const coords = new Float64Array(2 * (N + 1));
for (let i = 0; i <= N; i++) coords[2 * i] = i * L / N;     // z=0
const elems = [];
for (let i = 0; i < N; i++) elems.push({ n1: i, n2: i + 1, EA, EI });

// GDL libres: todos menos el nodo 0 (empotrado u,w,θ)
const free = [];
for (let n = 1; n <= N; n++) { free.push(3*n, 3*n+1, 3*n+2); }

const Fref = new Float64Array(3 * (N + 1));
Fref[3 * N + 2] = M;                        // momento en θ del nodo punta

const res = solveCorotBeam({ coords, elems, free, Fref, nSteps: 30, maxIter: 80, tol: 1e-10 });
const u = res.u;
const tip = N;
const uTip = u[3*tip], wTip = u[3*tip+1], thTip = u[3*tip+2];
const xTip = coords[2*tip] + uTip, zTip = coords[2*tip+1] + wTip;

// Analítico (arco)
const thExact = kappa * L;
const xExact = Math.sin(kappa * L) / kappa;
const zExact = (1 - Math.cos(kappa * L)) / kappa;

let ok = true;
const chk = (name, got, exp, tol) => {
  const err = Math.abs(got - exp) / (Math.abs(exp) || 1);
  const pass = err <= tol; ok = pass && ok;
  console.log(`${pass ? 'OK ' : 'XX '} ${name}: ${got.toFixed(6)} vs ${exp.toFixed(6)}  (${(err*100).toFixed(3)}%)`);
};

console.log(`converged=${res.converged}  φ=${phi} rad (${(phi*180/Math.PI).toFixed(0)}°)  M=${M.toFixed(1)} kN·m  N=${N} elem`);
chk('θ punta = κL (exacta)', thTip, thExact, 1e-6);
chk('x punta → sin(κL)/κ', xTip, xExact, 5e-3);
chk('z punta → (1−cos κL)/κ', zTip, zExact, 5e-3);

// Sanidad: en pequeñas rotaciones debe coincidir con la viga lineal (w = ML²/2EI)
{
  const Msmall = EI * 0.001 / L;            // φ≈0.001 → lineal
  const Fs = new Float64Array(3*(N+1)); Fs[3*N+2] = Msmall;
  const r2 = solveCorotBeam({ coords, elems, free, Fref: Fs, nSteps: 1, maxIter: 30, tol: 1e-12 });
  const wLin = r2.u[3*N+1], wLinExact = Msmall * L * L / (2 * EI);
  chk('límite lineal w = ML²/2EI', wLin, wLinExact, 1e-3);
}

console.log(ok ? '\n✅ TODO OK' : '\n❌ FALLÓ');
process.exit(ok ? 0 : 1);
