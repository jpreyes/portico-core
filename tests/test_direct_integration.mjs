// test_direct_integration.mjs — LINEAR direct time integration (Newmark-β, full
// assembled system · direct_integration.js). Verified three ways:
//   (1) SDOF analytic: step → DLF=2, harmonic → steady-state amplitude.
//   (2) Δt convergence: halving Δt shrinks the error ~4× (2nd-order accurate).
//   (3) Multi-DOF CROSS-CHECK vs the existing modal time-history: a linear system
//       with the SAME damping must give the SAME response by either method. This is
//       the strong test — two independent methods (physical direct vs modal) agree.
//   (4) The 'factor' and 'pcg' solver paths give the same answer.
import { newmarkLinear, directTimeHistory, rayleigh, rayleighZeta } from '../js/solver/direct_integration.js';
import { modalTimeHistory } from '../js/solver/timehistory.js';
import { Model } from '../js/model/model.js';
import { ModalSolver } from '../js/solver/modal_solver.js';

globalThis.window = globalThis;
await import('../lib/numeric.js');
globalThis.window.numeric = globalThis.numeric;

let fails = 0;
const ok  = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * (Math.abs(b) || 1), `${m}  (${(+a).toExponential(5)} vs ${(+b).toExponential(5)})`);

// dense (rows) → CSR with ascending columns (as extractFreeCSR produces)
function denseToCSR(A) {
  const n = A.length, rowPtr = new Int32Array(n + 1), colIdx = [], val = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) if (A[i][j] !== 0) { colIdx.push(j); val.push(A[i][j]); }
    rowPtr[i + 1] = colIdx.length;
  }
  return { n, rowPtr, colIdx: Int32Array.from(colIdx), val: Float64Array.from(val) };
}
const scalarCSR = (v) => ({ n: 1, rowPtr: Int32Array.from([0, 1]), colIdx: Int32Array.from([0]), val: Float64Array.from([v]) });

// ── (1) SDOF: step → DLF=2, harmonic → steady-state ──────────────────────────
console.log('── (1) SDOF analítico ──');
{
  const k = 64, m = 1, w = Math.sqrt(k / m), dt = 1e-4, T = 2 * Math.PI / w;
  const a = 3.0;
  // Step: a_g = const → u = −(a/ω²)(1−cos ωt), |u|máx = 2a/ω²
  const nStep = Math.round(4 * T / dt);
  const agStep = new Float64Array(nStep).fill(a);
  const rS = newmarkLinear({ K: scalarCSR(k), M: scalarCSR(m), a0: 0, a1: 0, ag: agStep, dt, iota: Float64Array.from([1]), solver: 'factor', record: [0] });
  rel(rS.peak[0], 2 * a / (w * w), 1e-3, 'escalón: |u|máx = 2a/ω² (DLF=2)');

  // Harmonic: a_g = a0·sin(Ωt), steady amplitude a0/√((ω²−Ω²)²+(2ζωΩ)²)
  const zeta = 0.05, Om = 5.0, a0h = 2.0;
  const { a0, a1 } = rayleigh(zeta, w, w * 1.0000001);      // ~constant ζ near ω for an SDOF
  const nH = Math.round(120 * (2 * Math.PI / Om) / dt);
  const agH = new Float64Array(nH); for (let i = 0; i < nH; i++) agH[i] = a0h * Math.sin(Om * i * dt);
  const rH = newmarkLinear({ K: scalarCSR(k), M: scalarCSR(m), a0, a1, ag: agH, dt, iota: Float64Array.from([1]), solver: 'factor', record: [0] });
  let amp = 0; for (let i = Math.floor(0.8 * nH); i < nH; i++) amp = Math.max(amp, Math.abs(rH.hist.get(0)[i]));
  const expAmp = a0h / Math.sqrt((w * w - Om * Om) ** 2 + (2 * zeta * w * Om) ** 2);
  rel(amp, expAmp, 8e-3, 'armónico: amplitud de régimen');
}

// ── (2) Convergencia 2º orden en Δt ──────────────────────────────────────────
console.log('\n── (2) Convergencia O(Δt²) ──');
{
  const k = 100, m = 1, w = Math.sqrt(k), a = 2.0, tEnd = 1.0;
  const uExact = (t) => -(a / (w * w)) * (1 - Math.cos(w * t));   // undamped step, exact
  const errAt = (dt) => {
    const n = Math.round(tEnd / dt) + 1;
    const ag = new Float64Array(n).fill(a);
    const r = newmarkLinear({ K: scalarCSR(k), M: scalarCSR(m), a0: 0, a1: 0, ag, dt, iota: Float64Array.from([1]), solver: 'factor', record: [0] });
    return Math.abs(r.hist.get(0)[n - 1] - uExact((n - 1) * dt));
  };
  const e1 = errAt(2e-3), e2 = errAt(1e-3);
  ok(e2 < e1 && e1 / e2 > 3.2, `error cae ~4× al halvar Δt  (${e1.toExponential(2)} → ${e2.toExponential(2)}, ratio ${(e1 / e2).toFixed(1)})`);
}

// ── (3) Multi-DOF: Newmark directo vs TH MODAL (mismo amortiguamiento) ────────
// Edificio de corte de 4 GDL, m=1, K tridiagonal. La respuesta a un accelerograma
// base debe coincidir integrada directamente (físico) o por superposición modal.
console.log('\n── (3) Cross-check directo vs modal ──');
{
  const N = 4, kk = 120, dt = 5e-4;
  const Kd = Array.from({ length: N }, () => Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    Kd[i][i] += kk; if (i + 1 < N) { Kd[i][i] += kk; Kd[i][i + 1] -= kk; Kd[i + 1][i] -= kk; }
  }
  const Md = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i === j ? 1 : 0)));

  // Modes (M=I → standard eigenproblem)
  const eig = numeric.eig(Kd);
  const lambda = eig.lambda.x, V = eig.E.x;                 // V columns = eigenvectors
  const idx = lambda.map((l, i) => [l, i]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
  const r = Array(N).fill(1);
  const modes = idx.map(ci => {
    const phi = V.map(row => row[ci]);
    let L = 0, mm = 0; for (let i = 0; i < N; i++) { L += phi[i] * r[i]; mm += phi[i] * phi[i]; }
    return { omega: Math.sqrt(Math.max(lambda[ci], 0)), gamma: L / mm, phi: Float64Array.from(phi) };
  });

  // Rayleigh damping fixed at the 1st and last mode → per-mode ζ for the modal run
  const w1 = modes[0].omega, wN = modes[N - 1].omega;
  const { a0, a1 } = rayleigh(0.05, w1, wN);
  const perZeta = modes.map(md => rayleighZeta(a0, a1, md.omega));

  // Accelerogram
  const dur = 5, n = Math.round(dur / dt);
  const ag = new Float64Array(n); for (let i = 0; i < n; i++) { const t = i * dt; ag[i] = 1.6 * Math.sin(5 * t) + 0.9 * Math.sin(13 * t); }

  const modal = modalTimeHistory({ modes, ag, dt, zeta: perZeta });
  const uModalTop = modal.nodalDOF(N - 1);

  const dir = newmarkLinear({ K: denseToCSR(Kd), M: denseToCSR(Md), a0, a1, ag, dt, iota: Float64Array.from(r), solver: 'factor', record: [N - 1] });
  const uDirTop = dir.hist.get(N - 1);

  // Compare full histories: peak and RMS relative to the modal peak
  let peakM = 0, sse = 0, sref = 0;
  for (let i = 0; i < n; i++) { peakM = Math.max(peakM, Math.abs(uModalTop[i])); const d = uDirTop[i] - uModalTop[i]; sse += d * d; sref += uModalTop[i] * uModalTop[i]; }
  let peakD = 0; for (let i = 0; i < n; i++) peakD = Math.max(peakD, Math.abs(uDirTop[i]));
  rel(peakD, peakM, 5e-3, 'pico de la punta coincide con la modal');
  ok(Math.sqrt(sse / sref) < 5e-3, `historia completa RMS coincide  (RMS rel = ${(Math.sqrt(sse / sref) * 100).toFixed(3)}%)`);
}

// ── (4) Camino 'factor' == camino 'pcg' ──────────────────────────────────────
console.log('\n── (4) Solvers factor vs PCG dan lo mismo ──');
{
  const N = 6, kk = 80, dt = 1e-3;
  const Kd = Array.from({ length: N }, () => Array(N).fill(0));
  for (let i = 0; i < N; i++) { Kd[i][i] += kk; if (i + 1 < N) { Kd[i][i] += kk; Kd[i][i + 1] -= kk; Kd[i + 1][i] -= kk; } }
  const Md = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i === j ? 2 : 0)));
  const { a0, a1 } = rayleigh(0.05, 3, 20);
  const n = 2000, ag = new Float64Array(n); for (let i = 0; i < n; i++) ag[i] = Math.sin(7 * i * dt);
  const common = { K: denseToCSR(Kd), M: denseToCSR(Md), a0, a1, ag, dt, iota: new Float64Array(N).fill(1), record: [N - 1] };
  const rf = newmarkLinear({ ...common, solver: 'factor' });
  const rp = newmarkLinear({ ...common, solver: 'pcg', pcgTol: 1e-10 });
  let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(rf.hist.get(N - 1)[i] - rp.hist.get(N - 1)[i]));
  let sc = 0; for (let i = 0; i < n; i++) sc = Math.max(sc, Math.abs(rf.hist.get(N - 1)[i]));
  ok(mx / sc < 1e-6, `factor y PCG coinciden  (dif rel máx = ${(mx / sc).toExponential(2)}, PCG solver=${rp.solver})`);
}

// ── (5) Driver a nivel de MODELO: pórtico real (ensambla + integra) ──────────
// Voladizo vertical (columna a lo largo de Z), base empotrada. Excitación basal en
// X. Verifica que el driver ensambla, integra y responde de forma física: lineal,
// cero-entrada→cero-salida, y respuesta acotada en la dirección excitada.
console.log('\n── (5) Driver directTimeHistory sobre un modelo real ──');
{
  const E = 2.1e8, G = 8.1e7, rho = 7.85;              // acero (kN, m, t)
  const A = 0.02, Iy = 1.2e-4, Iz = 1.2e-4, J = 1e-5, H = 3, nEl = 6;
  const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'S', E, G, nu: 0.3, rho });
  const sec = m.addSection({ name: 'C', A, Iy, Iz, J, Avy: 1e3, Avz: 1e3 });
  const nodes = [];
  for (let k = 0; k <= nEl; k++) nodes.push(m.addNode(0, 0, k * H / nEl, k === 0 ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } : undefined));
  for (let k = 0; k < nEl; k++) m.addElement(nodes[k].id, nodes[k + 1].id, mat.id, sec.id);
  const tip = nodes[nEl].id;

  const mr = new ModalSolver().solve(m, 3);
  const w1 = Math.sqrt(mr.omega2[0]);
  ok(w1 > 0 && isFinite(w1), `1ª frecuencia del voladizo válida (ω₁=${w1.toFixed(2)} rad/s)`);

  const dt = 0.0005, n = 4000;                          // fino: ~80 pasos por ciclo en ω₁
  const peakOf = (h) => { let p = 0; for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(h[i])); return p; };
  const mkAg = (s, Om) => { const ag = new Float64Array(n); for (let i = 0; i < n; i++) ag[i] = s * Math.sin(Om * i * dt); return ag; };
  const opt = { dt, direction: 'X', zeta: 0.05, rayleighFreqs: [w1, 8 * w1], record: [{ node: tip, dof: 0 }] };

  const r1 = directTimeHistory(m, { ...opt, ag: mkAg(1.0, w1) });     // en resonancia
  const h1 = r1.histAt(tip, 0);
  let allFinite = true; for (let i = 0; i < n; i++) if (!isFinite(h1[i])) allFinite = false;
  const pk1 = peakOf(h1);
  ok(allFinite && pk1 > 0 && pk1 < 1e3, `respuesta de punta finita, no nula y acotada (pico=${pk1.toExponential(3)} m, solver=${r1.solver})`);

  // Amplificación dinámica: excitación base → el desplazamiento RELATIVO se amplifica
  // en resonancia y tiende a cero a muy baja frecuencia (la estructura sigue al suelo).
  const rLo = directTimeHistory(m, { ...opt, ag: mkAg(1.0, 0.08 * w1) });
  const pkLo = peakOf(rLo.histAt(tip, 0));
  ok(pk1 > 3 * pkLo, `resonancia amplifica vs cuasi-estático (${pk1.toExponential(2)} > 3·${pkLo.toExponential(2)})`);

  // Linealidad: 2×a_g → 2×respuesta
  const r2 = directTimeHistory(m, { ...opt, ag: mkAg(2.0, w1) });
  const pk2 = peakOf(r2.histAt(tip, 0));
  rel(pk2, 2 * pk1, 1e-9, 'sistema lineal: 2·a_g → 2·respuesta');

  // Cero entrada → cero salida
  const r0 = directTimeHistory(m, { ...opt, ag: new Float64Array(n) });
  let pk0 = 0; const h0 = r0.histAt(tip, 0); for (let i = 0; i < n; i++) pk0 = Math.max(pk0, Math.abs(h0[i]));
  ok(pk0 === 0, 'cero excitación → cero respuesta');

  // peakNodal entrega el pico por GDL del nodo
  const pn = r1.peakNodal(tip);
  ok(pn[0] === pk1, 'peakNodal(tip)[ux] coincide con la historia registrada');
}

console.log(fails ? `\n${fails} FALLO(S)` : '\nTODO OK ✓');
process.exit(fails ? 1 : 0);
