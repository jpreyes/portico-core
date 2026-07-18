// test_thermal_gradient.mjs — verifica el GRADIENTE térmico en áreas (#57, G14).
// Un gradiente ΔT a través del espesor impone una curvatura térmica κ₀ = α·ΔT/t.
// Patch test: una placa MITC4/DKT mínimamente apoyada (sin modos de cuerpo rígido)
// adopta la curvatura térmica κ₀ con momento interno ≈ 0 → el vector de carga
// térmica de flexión es consistente con la rigidez.
import { mitc4Plate, dktPlate, plateThermalLoad, plateCurvatures, plateMoments, plateD } from '../js/solver/plate.js';

globalThis.window = globalThis;
await import('../lib/numeric.js');
const num = globalThis.numeric;

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-9, `${m}  (${a.toExponential(4)} vs ${b.toExponential(4)})`);

const E = 2.0e8, nu = 0.3, t = 0.1, alpha = 1.2e-5, gradT = 40;   // T_sup−T_inf = 40°
const k0 = alpha * gradT / t;   // curvatura térmica objetivo

function patch(coords, Ke, nN) {
  const nD = 3 * nN;
  const f = plateThermalLoad(coords, E, nu, t, [k0, k0, 0]);
  // Quita modos de cuerpo rígido fijando los 3 GDL del nodo 0 [w,θx,θy]
  const fixed = new Set([0, 1, 2]);
  const free = []; for (let i = 0; i < nD; i++) if (!fixed.has(i)) free.push(i);
  const nF = free.length;
  const Kff = [], ff = [];
  for (let i = 0; i < nF; i++) { ff.push(f[free[i]]); const row = []; for (let j = 0; j < nF; j++) row.push(Ke[free[i] * nD + free[j]]); Kff.push(row); }
  const uf = num.solve(Kff, ff);
  const d = new Float64Array(nD); for (let i = 0; i < nF; i++) d[free[i]] = uf[i];
  // Momento MECÁNICO = Db·(κ − κ₀): descuenta el momento térmico (#57).
  const { Db } = plateD(E, nu, t);
  const M = plateMoments(coords, E, nu, t, d);
  M[0] -= (Db[0][0] + Db[0][1]) * k0;
  M[1] -= (Db[1][0] + Db[1][1]) * k0;
  M[2] -= (Db[2][0] + Db[2][1]) * k0;
  return { kappa: plateCurvatures(coords, d), M };
}

console.log('\n── Gradiente térmico: curvatura térmica libre κ₀ = α·ΔT/t ──');

// QUAD (MITC4)
{
  const coords = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const { kappa, M } = patch(coords, mitc4Plate(coords, E, nu, t), 4);
  rel(kappa[0], k0, 0.02, 'MITC4: κx = κ₀');
  rel(kappa[1], k0, 0.02, 'MITC4: κy = κ₀');
  ok(Math.abs(M[0]) < 1e-3 * Math.abs((E * t * t * t / 12) * k0) + 1e-9, `MITC4: momento ≈ 0 (libre)  (Mx=${M[0].toExponential(2)})`);
}

// TRI (DKT)
{
  const coords = [[0, 0], [1, 0], [0, 1]];
  const { kappa, M } = patch(coords, dktPlate(coords, E, nu, t), 3);
  rel(kappa[0], k0, 0.05, 'DKT: κx = κ₀');
  rel(kappa[1], k0, 0.05, 'DKT: κy = κ₀');
  ok(Math.abs(M[0]) < 1e-2 * Math.abs((E * t * t * t / 12) * k0) + 1e-9, `DKT: momento ≈ 0 (libre)  (Mx=${M[0].toExponential(2)})`);
}

// Momento térmico TOTALMENTE RESTRINGIDO (κ=0): M = Db·κ₀ (referencia analítica)
{
  const cp = E / (1 - nu * nu), f = t * t * t / 12;
  const M_restr = cp * f * (1 + nu) * k0;   // Db00+Db01 = cp·f·(1+ν)
  const sigma = 6 * M_restr / (t * t);
  const sigma_an = E * alpha * gradT / (2 * (1 - nu));
  rel(sigma, sigma_an, 1e-6, 'σ restringido = E·α·ΔT/(2(1−ν))');
}

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
