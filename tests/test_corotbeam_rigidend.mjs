// test_corotbeam_rigidend.mjs — CACHO RÍGIDO en la viga corotacional 2D (#87 × 1-029).
//
// En grandes rotaciones el brazo rígido GIRA con el nodo, así que la cinemática deja
// de ser una matriz constante:  p' = p + R(θ)·r ,  θ' = θ.  Eso obliga a
//     f_nodo = Aᵀ·f'        K_nodo = Aᵀ·K'·A + G
// con A = ∂q'/∂q (depende de θ) y G = ∂²q'/∂θ² contraído con f'. Este test ataca las
// dos piezas por separado:
//
//   (1) La TANGENTE contra diferencias finitas de fint — es lo único que prueba G.
//       Un Aᵀ·K'·A sin G sigue convergiendo (más lento) al resultado correcto, así
//       que la elástica sola no delataría que falta.
//   (2) La ELÁSTICA exacta: voladizo bajo momento de punta con un cacho `a` en el
//       EXTREMO LIBRE. El material flexible mide Lf y el arco es de curvatura
//       κ = M/EI; el brazo rígido transmite el momento intacto (no lleva fuerza) y
//       después arrastra al nodo de punta girado θ = κ·Lf:
//           x_N = sin(θ)/κ + a·cos θ      z_N = (1−cos θ)/κ + a·sin θ
import { solveCorotBeam, corotPrep, corotBeamForceTangent } from '../js/solver/corotbeam.js';

let fails = 0;
const ok  = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * (Math.abs(b) || 1), `${m}  (${(+a).toFixed(6)} vs ${(+b).toFixed(6)})`);

const EI = 19372.5, EA = 2.583e6;

// ── (1) Tangente analítica vs diferencias finitas ───────────────────────────
// Estado deformado GENÉRICO (rotaciones grandes en ambos nodos, traslaciones no
// nulas): si A o G estuvieran mal, la discrepancia aparece justo en las columnas de
// rotación, que son las únicas que el brazo rígido toca.
console.log('── (1) Tangente consistente (K = ∂fint/∂q) ──');
{
  const coords = new Float64Array([0, 0, 3, 0]);
  const el = { n1: 0, n2: 1, EA, EI, oi: 0.4, oj: 0.7 };
  corotPrep(coords, [el]);
  rel(el.L0, 3 - 0.4 - 0.7, 1e-12, 'L0 = L − oi − oj (el elemento ES la luz flexible)');

  const u0 = new Float64Array([0.03, -0.05, 0.35, 0.11, 0.09, -0.27]);
  const { Kt } = corotBeamForceTangent(coords, u0, el);

  const h = 1e-7;
  let worst = 0, worstAt = '';
  for (let q = 0; q < 6; q++) {
    const up = Float64Array.from(u0), um = Float64Array.from(u0);
    up[q] += h; um[q] -= h;
    const fp = corotBeamForceTangent(coords, up, el).fint;
    const fm = corotBeamForceTangent(coords, um, el).fint;
    for (let p = 0; p < 6; p++) {
      const fd = (fp[p] - fm[p]) / (2 * h);
      const an = Kt[p * 6 + q];
      const err = Math.abs(fd - an) / (Math.abs(fd) + Math.abs(an) + 1e3);
      if (err > worst) { worst = err; worstAt = `K[${p}][${q}] fd=${fd.toFixed(3)} an=${an.toFixed(3)}`; }
    }
  }
  ok(worst < 1e-6, `K coincide con ∂fint/∂q en todo el 6×6 (peor ${worst.toExponential(2)} en ${worstAt})`);
}

// ── (2) Elástica exacta con cacho en el extremo LIBRE ───────────────────────
console.log('\n── (2) Voladizo con cacho en la punta, momento de punta ──');
{
  const Ltot = 2.5, a = 0.5, Lf = Ltot - a;     // 20% del largo es rígido
  const phi = 1.5;                               // rotación total (rad) — 86°, muy grande
  const kappa = phi / Lf, M = EI * kappa;

  // N elementos de igual luz FLEXIBLE; el último carga además el cacho `a`.
  const N = 24, dl = Lf / N;
  const coords = new Float64Array(2 * (N + 1));
  for (let i = 0; i < N; i++) coords[2 * i] = i * dl;
  coords[2 * N] = Lf + a;                        // el nodo de punta está tras el cacho
  const elems = [];
  for (let i = 0; i < N; i++) elems.push({ n1: i, n2: i + 1, EA, EI, oi: 0, oj: i === N - 1 ? a : 0 });

  const free = [];
  for (let n = 1; n <= N; n++) free.push(3*n, 3*n+1, 3*n+2);
  const Fref = new Float64Array(3 * (N + 1));
  Fref[3 * N + 2] = M;

  const res = solveCorotBeam({ coords, elems, free, Fref, nSteps: 30, maxIter: 80, tol: 1e-10 });
  ok(res.converged, 'Newton converge con la tangente del brazo rígido');

  const u = res.u;
  const xTip = coords[2*N] + u[3*N], zTip = coords[2*N+1] + u[3*N+1], thTip = u[3*N+2];
  const th = kappa * Lf;
  rel(thTip, th, 1e-6,  'θ punta = κ·Lf (el cacho no aporta flexibilidad)');
  rel(xTip, Math.sin(th)/kappa + a*Math.cos(th), 5e-3, 'x punta = sinθ/κ + a·cosθ');
  rel(zTip, (1-Math.cos(th))/kappa + a*Math.sin(th), 5e-3, 'z punta = (1−cosθ)/κ + a·sinθ');

  // El brazo rígido gira MUCHO: la punta acaba lejos de donde caería sin él.
  const xNoArm = Math.sin(th)/kappa, zNoArm = (1-Math.cos(th))/kappa;
  ok(Math.hypot(xTip - xNoArm, zTip - zNoArm) > 0.4,
     `el brazo arrastra la punta (${Math.hypot(xTip-xNoArm, zTip-zNoArm).toFixed(3)} m del extremo flexible)`);
}

// ── (3) Límite lineal: el cacho sólo acorta la luz ──────────────────────────
// Con rotaciones pequeñas R(θ)≈I y todo debe reducirse a la viga lineal con luz Lf:
// θ = M·Lf/EI y w = M·Lf²/2EI + a·θ (el brazo rígido, ya casi recto, sólo traslada).
console.log('\n── (3) Límite de rotación pequeña ──');
{
  const Ltot = 2.5, a = 0.5, Lf = Ltot - a;
  const N = 12, dl = Lf / N;
  const coords = new Float64Array(2 * (N + 1));
  for (let i = 0; i < N; i++) coords[2 * i] = i * dl;
  coords[2 * N] = Lf + a;
  const elems = [];
  for (let i = 0; i < N; i++) elems.push({ n1: i, n2: i + 1, EA, EI, oi: 0, oj: i === N - 1 ? a : 0 });
  const free = []; for (let n = 1; n <= N; n++) free.push(3*n, 3*n+1, 3*n+2);
  const M = EI * 0.001 / Lf;
  const Fref = new Float64Array(3 * (N + 1)); Fref[3*N+2] = M;

  const r = solveCorotBeam({ coords, elems, free, Fref, nSteps: 1, maxIter: 30, tol: 1e-12 });
  const th = M * Lf / EI;
  rel(r.u[3*N+2], th, 1e-6, 'θ = M·Lf/EI');
  rel(r.u[3*N+1], M * Lf * Lf / (2 * EI) + a * th, 1e-4, 'w = M·Lf²/2EI + a·θ');
}

console.log(fails ? `\n${fails} FALLO(S)` : '\nTODO OK ✓');
process.exit(fails ? 1 : 0);
