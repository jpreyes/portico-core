// test_timehistory.mjs — verificación del motor de time-history modal (G12 #48a)
// contra soluciones ANALÍTICAS SDOF y una integración directa NEWMARK
// independiente (otro método → comprobación cruzada del caso multi-GDL).
//
//   node test_timehistory.mjs
//
import { sdofResponse, modalTimeHistory } from '../js/solver/timehistory.js';

let fails = 0;
const ok = (name, got, exp, tol) => {
  const err = Math.abs(got - exp) / (Math.abs(exp) || 1);
  const pass = err <= tol;
  if (!pass) fails++;
  console.log(`${pass ? '✓' : '✗'} ${name}: got=${got.toExponential(5)} exp=${exp.toExponential(5)} err=${(err*100).toFixed(3)}%`);
};

// ── 1. Escalón (undamped): a_g constante ⇒ DLF=2 ──────────────────────────────
// ü + ω²u = −a  ⇒  u(t) = −(a/ω²)(1−cos ωt),  |u|máx = 2a/ω².
{
  const omega = 8, a = 3.0, dt = 1e-4, T = 2 * Math.PI / omega;
  const n = Math.round(4 * T / dt);
  const p = new Float64Array(n).fill(-a);            // p = −a_g
  const { u } = sdofResponse(omega, 0, dt, p);
  let umax = 0; for (const v of u) umax = Math.max(umax, Math.abs(v));
  ok('1. SDOF escalón |u|máx = 2a/ω²', umax, 2 * a / (omega * omega), 1e-4);
}

// ── 2. Armónico amortiguado: amplitud de régimen = a0/√((ω²−Ω²)²+(2ζωΩ)²) ─────
{
  const omega = 10, zeta = 0.05, Omega = 6.5, a0 = 2.0, dt = 1e-4;
  const ncyc = 80, n = Math.round(ncyc * (2 * Math.PI / Omega) / dt);
  const p = new Float64Array(n);
  for (let k = 0; k < n; k++) p[k] = -a0 * Math.sin(Omega * k * dt);   // p = −a_g
  const { u } = sdofResponse(omega, zeta, dt, p);
  // amplitud de régimen: máximo del último 20 % (transitorio ya disipado)
  let amp = 0; for (let k = Math.floor(0.8 * n); k < n; k++) amp = Math.max(amp, Math.abs(u[k]));
  const exp = a0 / Math.sqrt((omega*omega - Omega*Omega)**2 + (2*zeta*omega*Omega)**2);
  ok('2. SDOF armónico amplitud de régimen', amp, exp, 5e-3);
}

// ── 3. Vibración libre: decremento logarítmico δ = 2πζ/√(1−ζ²) ────────────────
{
  const omega = 12, zeta = 0.04, dt = 1e-4;
  const Td = 2 * Math.PI / (omega * Math.sqrt(1 - zeta*zeta));
  const n = Math.round(10 * Td / dt);
  const p = new Float64Array(n);                     // sin carga
  const { u } = sdofResponse(omega, zeta, dt, p, 1.0, 0.0);   // u0=1, reposo
  // picos sucesivos (separados ~Td)
  const peaks = [];
  for (let k = 1; k < n - 1; k++) if (u[k] > u[k-1] && u[k] > u[k+1] && u[k] > 0) peaks.push(u[k]);
  const delta = Math.log(peaks[0] / peaks[1]);
  ok('3. SDOF decremento logarítmico', delta, 2*Math.PI*zeta/Math.sqrt(1-zeta*zeta), 5e-3);
}

// ── 4. Modal multi-GDL: edificio de corte 2-GDL vs Newmark directo ────────────
// M = I, K = [[2k,−k],[−k,k]], excitación basal uniforme r = [1,1].
{
  const k = 100, m = 1, zeta = 0.05, dt = 5e-4;
  const Kmat = [[2*k, -k], [-k, k]], Mvec = [m, m], r = [1, 1];

  // Autovalores/vectores analíticos (2×2 simétrico, M=I)
  const lam1 = (3 - Math.sqrt(5)) / 2 * k, lam2 = (3 + Math.sqrt(5)) / 2 * k;
  const mkMode = (lam) => { const v = [1, 2 - lam/k]; return v; };
  const modesRaw = [{ lam: lam1, v: mkMode(lam1) }, { lam: lam2, v: mkMode(lam2) }];

  // Γ = (φᵀ M r)/(φᵀ M φ);  phi extendido a "nDOF"=2
  const modes = modesRaw.map(({ lam, v }) => {
    let L = 0, mm = 0;
    for (let i = 0; i < 2; i++) { L += v[i]*Mvec[i]*r[i]; mm += v[i]*Mvec[i]*v[i]; }
    return { omega: Math.sqrt(lam), gamma: L/mm, phi: Float64Array.from(v) };
  });

  // Acelerograma de prueba: dos senos (contenido en banda) durante 6 s
  const dur = 6, n = Math.round(dur/dt);
  const ag = new Float64Array(n);
  for (let i = 0; i < n; i++) { const tt = i*dt; ag[i] = 1.5*Math.sin(6*tt) + 0.8*Math.sin(14*tt); }

  const th = modalTimeHistory({ modes, ag, dt, zeta });
  const uModal0 = th.nodalDOF(0), uModal1 = th.nodalDOF(1);

  // ── Newmark directo (aceleración promedio, incondicionalmente estable) ──────
  // M ü + C u̇ + K u = −M r a_g,  C = a0 M + a1 K (Rayleigh con ζ en ambos modos).
  const w1 = modes[0].omega, w2 = modes[1].omega;
  const a1c = 2*zeta/(w1+w2);            // Rayleigh: ζ igual en w1 y w2
  const a0c = a1c*w1*w2;
  const C = [[a0c*Mvec[0] + a1c*Kmat[0][0], a1c*Kmat[0][1]],
             [a1c*Kmat[1][0], a0c*Mvec[1] + a1c*Kmat[1][1]]];
  const beta = 0.25, gamma = 0.5;
  // matrices 2×2 helpers
  const matInv2 = (A) => { const d = A[0][0]*A[1][1]-A[0][1]*A[1][0]; return [[A[1][1]/d,-A[0][1]/d],[-A[1][0]/d,A[0][0]/d]]; };
  const mv2 = (A,x) => [A[0][0]*x[0]+A[0][1]*x[1], A[1][0]*x[0]+A[1][1]*x[1]];
  const Mmat = [[Mvec[0],0],[0,Mvec[1]]];
  // Keff = K + (γ/(βΔt))C + (1/(βΔt²))M
  const c1 = 1/(beta*dt*dt), c2 = gamma/(beta*dt);
  const Keff = [[Kmat[0][0]+c2*C[0][0]+c1*Mmat[0][0], Kmat[0][1]+c2*C[0][1]+c1*Mmat[0][1]],
                [Kmat[1][0]+c2*C[1][0]+c1*Mmat[1][0], Kmat[1][1]+c2*C[1][1]+c1*Mmat[1][1]]];
  const KeffInv = matInv2(Keff);
  let u = [0,0], v = [0,0];
  // a0 = M⁻¹(F0 − Cv − Ku)
  const MinvN = matInv2(Mmat);
  const F = (kstep) => { const ai = -ag[kstep]; return [Mmat[0][0]*r[0]*ai, Mmat[1][1]*r[1]*ai]; };
  let acc = mv2(MinvN, [F(0)[0]-C[0][0]*v[0]-C[0][1]*v[1]-(Kmat[0][0]*u[0]+Kmat[0][1]*u[1]),
                        F(0)[1]-C[1][0]*v[0]-C[1][1]*v[1]-(Kmat[1][0]*u[0]+Kmat[1][1]*u[1])]);
  const uN0 = new Float64Array(n), uN1 = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    uN0[s] = u[0]; uN1[s] = u[1];
    if (s === n-1) break;
    const Fn = F(s+1);
    // rhs = Fn + M(c1 u + c1*dt v + (1/(2β)−1)a) + C(c2 u + (γ/β−1)v + dt(γ/(2β)−1)a)
    const mTerm = [
      Mmat[0][0]*(c1*u[0] + (1/(beta*dt))*v[0] + (1/(2*beta)-1)*acc[0]),
      Mmat[1][1]*(c1*u[1] + (1/(beta*dt))*v[1] + (1/(2*beta)-1)*acc[1])
    ];
    const cv = [c2*u[0] + (gamma/beta-1)*v[0] + dt*(gamma/(2*beta)-1)*acc[0],
                c2*u[1] + (gamma/beta-1)*v[1] + dt*(gamma/(2*beta)-1)*acc[1]];
    const cTerm = mv2(C, cv);
    const rhs = [Fn[0]+mTerm[0]+cTerm[0], Fn[1]+mTerm[1]+cTerm[1]];
    const uNew = mv2(KeffInv, rhs);
    const aNew = [c1*(uNew[0]-u[0]) - (1/(beta*dt))*v[0] - (1/(2*beta)-1)*acc[0],
                  c1*(uNew[1]-u[1]) - (1/(beta*dt))*v[1] - (1/(2*beta)-1)*acc[1]];
    const vNew = [v[0] + dt*((1-gamma)*acc[0] + gamma*aNew[0]),
                  v[1] + dt*((1-gamma)*acc[1] + gamma*aNew[1])];
    u = uNew; v = vNew; acc = aNew;
  }

  // comparar picos de desplazamiento de cada GDL
  const peak = (arr) => { let mx = 0; for (const x of arr) mx = Math.max(mx, Math.abs(x)); return mx; };
  ok('4a. GDL1 pico modal vs Newmark', peak(uModal0), peak(uN0), 5e-3);
  ok('4b. GDL2 pico modal vs Newmark', peak(uModal1), peak(uN1), 5e-3);
  // y el error punto a punto (RMS relativo) en el GDL2
  let num = 0, den = 0;
  for (let s = 0; s < n; s++) { num += (uModal1[s]-uN1[s])**2; den += uN1[s]**2; }
  ok('4c. GDL2 RMS(modal−Newmark)/RMS', Math.sqrt(num/den), 0, 8e-3);
}

console.log(fails ? `\n${fails} prueba(s) FALLARON` : '\nTODAS las pruebas OK');
process.exit(fails ? 1 : 0);
