// test_nl_timehistory.mjs — verificación del time-history NO LINEAL (#48b)
//
// Integración directa Newmark-β con rótulas bilineales (elastoplásticas). Se valida:
//  (1) límite ELÁSTICO del SDOF ≡ solución analítica (escalón DLF=2; armónico),
//  (2) caso ELASTOPLÁSTICO SDOF: Newmark ≡ diferencia central fina (cross-check),
//  (3) la fluencia REDUCE el pico y deja DERIVA RESIDUAL,
//  (4) MDOF elastoplástico (2 pisos): Newmark ≡ diferencia central,
//  (5) equilibrio dinámico (residuo de Newton ≈ 0),
//  (6) amortiguamiento de Rayleigh: SDOF amortiguado ≡ analítico.
//
//   node test_nl_timehistory.mjs
//
import { shearBuilding, newmarkNonlinear, centralDifferenceNonlinear, rayleighDamping } from './js/solver/nl_timehistory.js';

let fails = 0;
const ok = (name, got, exp, tol) => {
  const err = Math.abs(got - exp) / (Math.abs(exp) || 1);
  const pass = err <= tol;
  if (!pass) fails++;
  console.log(`${pass ? '✓' : '✗'} ${name}: got=${got.toExponential(5)} exp=${exp.toExponential(5)} err=${(err * 100).toFixed(3)}%`);
};
const assert = (name, cond, info = '') => { if (!cond) fails++; console.log(`${cond ? '✓' : '✗'} ${name}${info ? ' · ' + info : ''}`); };

// ── 1. SDOF elástico, escalón: |u|máx = 2a/ω² (DLF=2) ─────────────────────────
{
  const m = 1, omega = 10, k = omega * omega * m, a = 2.0;
  const dt = (2 * Math.PI / omega) / 400, n = 1200;
  const ag = new Float64Array(n).fill(a);
  const { resist, M } = shearBuilding({ m: [m], k: [k], Fy: [Infinity], alpha: [0] });
  const r = newmarkNonlinear({ M, resist, ag, dt });
  ok('1. SDOF elástico escalón |u|máx = 2a/ω²', r.peak, 2 * a / (omega * omega), 2e-3);
}

// ── 2. SDOF elástico, armónico no amortiguado: waveform completa vs analítica ──
// ü + ω²u = −a0·sin(Ωt), reposo  ⇒  u(t) = −a0/(ω²−Ω²)·[sin Ωt − (Ω/ω) sin ωt].
{
  const m = 1, omega = 12, k = omega * omega * m, a0 = 1.5, Omega = 7.0;
  const dt = (2 * Math.PI / omega) / 400, ncyc = 6, n = Math.round(ncyc * (2 * Math.PI / Omega) / dt);
  const ag = new Float64Array(n); for (let i = 0; i < n; i++) ag[i] = a0 * Math.sin(Omega * i * dt);
  const { resist, M } = shearBuilding({ m: [m], k: [k], Fy: [Infinity], alpha: [0] });
  const r = newmarkNonlinear({ M, resist, ag, dt, store: 'monitor', monitorDof: 0 });
  const A = -a0 / (omega * omega - Omega * Omega);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const t = i * dt; const ex = A * (Math.sin(Omega * t) - (Omega / omega) * Math.sin(omega * t)); num += (r.mon[i] - ex) ** 2; den += ex * ex; }
  ok('2. SDOF elástico armónico waveform RMS vs analítica', Math.sqrt(num / den), 0, 1e-2);
}

// ── 3. SDOF ELASTOPLÁSTICO: Newmark ≡ diferencia central (cross-check) ─────────
{
  const m = 1, omega = 10, k = omega * omega * m, Fy = 6.0, a0 = 12.0, Omega = 9.0;
  const T = 2 * Math.PI / omega, dtN = T / 120, n = Math.round(8 * T / dtN);
  const ag = new Float64Array(n); for (let i = 0; i < n; i++) ag[i] = a0 * Math.sin(Omega * i * dtN);
  const sb1 = shearBuilding({ m: [m], k: [k], Fy: [Fy], alpha: [0] });
  const rN = newmarkNonlinear({ M: sb1.M, resist: sb1.resist, ag, dt: dtN });
  // Diferencia central con Δt fino sobre el mismo registro re-muestreado.
  const fac = 16, dtC = dtN / fac, nC = (n - 1) * fac + 1;
  const agC = new Float64Array(nC); for (let i = 0; i < nC; i++) agC[i] = a0 * Math.sin(Omega * i * dtC);
  const sb2 = shearBuilding({ m: [m], k: [k], Fy: [Fy], alpha: [0] });
  const rC = centralDifferenceNonlinear({ M: sb2.M, resist: sb2.resist, ag: agC, dt: dtC });
  assert('3a. SDOF elastoplástico fluye', rN.anyYield);
  ok('3b. SDOF elastoplástico pico Newmark ≡ dif. central', rN.peak, rC.peak, 3e-2);
}

// ── 4. La fluencia REDUCE el pico y deja deriva residual ──────────────────────
{
  const m = 1, omega = 10, k = omega * omega * m, a0 = 12.0, Omega = 9.0;
  const T = 2 * Math.PI / omega, dt = T / 200, n = Math.round(8 * T / dt);
  const ag = new Float64Array(n); for (let i = 0; i < n; i++) ag[i] = a0 * Math.sin(Omega * i * dt);
  const elas = shearBuilding({ m: [m], k: [k], Fy: [Infinity], alpha: [0] });
  const re = newmarkNonlinear({ M: elas.M, resist: elas.resist, ag, dt, store: 'full' });
  const plas = shearBuilding({ m: [m], k: [k], Fy: [5.0], alpha: [0] });
  const rp = newmarkNonlinear({ M: plas.M, resist: plas.resist, ag, dt, store: 'full' });
  assert('4a. fluencia reduce el pico vs elástico', rp.peak < re.peak, `plás=${rp.peak.toExponential(3)} elás=${re.peak.toExponential(3)}`);
  const uResid = Math.abs(rp.U[rp.U.length - 1][0]);
  assert('4b. deja deriva residual (ep≠0)', plas.springs[0].yielded() && uResid > 1e-4, `u_resid=${uResid.toExponential(3)}`);
}

// ── 5. Equilibrio dinámico: residuo de Newton ≈ 0 al final ────────────────────
{
  const m = 1, omega = 10, k = omega * omega * m;
  const dt = (2 * Math.PI / omega) / 200, n = 800;
  const ag = new Float64Array(n); for (let i = 0; i < n; i++) ag[i] = 8 * Math.sin(8 * i * dt);
  const sb = shearBuilding({ m: [m], k: [k], Fy: [4.0], alpha: [0.05] });
  const r = newmarkNonlinear({ M: sb.M, resist: sb.resist, ag, dt });
  assert('5. residuo de equilibrio ≈ 0', Math.abs(r.residual[0]) < 1e-6, `|R|=${Math.abs(r.residual[0]).toExponential(2)}`);
}

// ── 6. MDOF elastoplástico (2 pisos): Newmark ≡ diferencia central ─────────────
{
  const m = [1, 1], k = [200, 120], Fy = [9, 6], alpha = [0, 0];
  const w1 = 6.0; const dtN = (2 * Math.PI / 14) / 60, n = 700;
  const ag = new Float64Array(n); for (let i = 0; i < n; i++) ag[i] = 9 * Math.sin(w1 * i * dtN) * Math.exp(-0.15 * i * dtN);
  const sbN = shearBuilding({ m, k, Fy, alpha });
  const rN = newmarkNonlinear({ M: sbN.M, resist: sbN.resist, ag, dt: dtN, store: 'monitor', monitorDof: 1 });
  const fac = 20, dtC = dtN / fac, nC = (n - 1) * fac + 1;
  const agC = new Float64Array(nC); for (let i = 0; i < nC; i++) agC[i] = 9 * Math.sin(w1 * i * dtC) * Math.exp(-0.15 * i * dtC);
  const sbC = shearBuilding({ m, k, Fy, alpha });
  const rC = centralDifferenceNonlinear({ M: sbC.M, resist: sbC.resist, ag: agC, dt: dtC, monitorDof: 1 });
  assert('6a. MDOF 2 pisos fluye', rN.anyYield);
  ok('6b. MDOF pico techo Newmark ≡ dif. central', rN.peak, rC.peak, 4e-2);
}

// ── 7. SDOF amortiguado (Rayleigh) armónico de régimen vs analítico ───────────
{
  const m = 1, omega = 10, k = omega * omega * m, zeta = 0.05, a0 = 1.0, Omega = 6.0;
  const { C } = rayleighDamping(Float64Array.from([m]), Float64Array.from([k]), 1, zeta, omega, omega);
  const dt = (2 * Math.PI / Omega) / 300, ncyc = 80, n = Math.round(ncyc * (2 * Math.PI / Omega) / dt);
  const ag = new Float64Array(n); for (let i = 0; i < n; i++) ag[i] = a0 * Math.sin(Omega * i * dt);
  const sb = shearBuilding({ m: [m], k: [k], Fy: [Infinity], alpha: [0] });
  const r = newmarkNonlinear({ M: sb.M, resist: sb.resist, C, ag, dt, store: 'monitor' });
  let amp = 0; for (let i = Math.floor(0.7 * n); i < n; i++) amp = Math.max(amp, Math.abs(r.mon[i]));
  const exp = a0 / Math.sqrt((omega * omega - Omega * Omega) ** 2 + (2 * zeta * omega * Omega) ** 2);
  ok('7. SDOF amortiguado armónico amplitud de régimen', amp, exp, 1.5e-2);
}

console.log(fails === 0 ? '\nTODO OK ✓' : `\n${fails} FALLO(S) ✗`);
process.exit(fails ? 1 : 0);
