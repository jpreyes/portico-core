// test_nl_direct.mjs — NONLINEAR direct time integration (HHT-α + Newton) of a planar
// corotational frame (js/solver/nl_direct.js), the dynamic sibling of the static corot
// solver and P-Δ.
//
//   (1) LINEAR LIMIT: at tiny amplitude with α=0 (average acceleration), F_int ≈ K0·u,
//       so the response must match newmarkLinear driven with the SAME lumped M, initial
//       tangent K0 and Rayleigh damping.
//   (2) QUASI-STATIC LIMIT: a slow, damped ramp of a base "load" settles to the STATIC
//       corotational equilibrium under the same nodal pattern (solveCorotBeam) — and
//       differs strongly from the linear (K0) prediction, so the geometry is genuinely
//       carried through the integration.
//   (3) ENERGY: undamped free vibration from a proper static deflected shape (α=0,
//       average acceleration) conserves energy — the peak amplitude equals the initial
//       one cycle after cycle, even at large drift.
//   (4) DAMPING: Rayleigh damping decays that free vibration substantially.
//   (5) DRIVER: end-to-end nlDirectTimeHistory on a real Model + structured refusal.
//
// Run:  node test_nl_direct.mjs
import { newmarkCorot, nlDirectTimeHistory } from '../js/solver/nl_direct.js';
import { newmarkLinear } from '../js/solver/direct_integration.js';
import { solveCorotBeam, corotBeamForceTangent } from '../js/solver/corotbeam.js';
import { SparseSym, extractFreeCSR } from '../js/solver/sparse.js';
import { Model } from '../js/model/model.js';

let failures = 0;
const check = (cond, msg, extra = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const rel = (a, b) => Math.abs(b) < 1e-30 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b);

// A planar cantilever column along Z (x=0), fixed base, nEl elements, tip lumped mass.
// Planar DOFs per node [u=ux, w=uz, θ=ry]. Bending about y under an X excitation.
const E = 2.1e8, A = 0.01, I = 8e-5, H = 4, nEl = 8, rho = 7.85;
function column(mtip) {
  const nNode = nEl + 1;
  const coords = new Float64Array(2 * nNode);
  for (let i = 0; i <= nEl; i++) { coords[2 * i] = 0; coords[2 * i + 1] = H * i / nEl; }
  const elems = [];
  for (let i = 0; i < nEl; i++) elems.push({ n1: i, n2: i + 1, EA: E * A, EI: E * I });
  const free = [];
  for (let i = 1; i <= nEl; i++) free.push(3 * i, 3 * i + 1, 3 * i + 2);   // base (node 0) fixed
  const nDOF = 3 * nNode;
  const Mlump = new Float64Array(nDOF);
  for (const el of elems) {
    const L = Math.hypot(coords[2 * el.n2] - coords[2 * el.n1], coords[2 * el.n2 + 1] - coords[2 * el.n1 + 1]);
    const half = rho * A * L / 2;
    Mlump[3 * el.n1] += half; Mlump[3 * el.n1 + 1] += half;
    Mlump[3 * el.n2] += half; Mlump[3 * el.n2 + 1] += half;
  }
  Mlump[3 * nEl] += mtip; Mlump[3 * nEl + 1] += mtip;
  const dofMap = new Int32Array(nDOF).fill(-1); let nF = 0; for (const d of free) dofMap[d] = nF++;
  return { coords, elems, free, nDOF, Mlump, dofMap, nF, top: nEl };
}

// Reduced initial tangent K0 (CSR) assembled from the corot kernel at u=0 — the
// independent oracle matrix for the linear cross-check.
function assembleK0(coords, elems, dofMap, nF) {
  const idMap = new Int32Array(nF); for (let i = 0; i < nF; i++) idMap[i] = i;
  const S = new SparseSym(nF); const u = new Float64Array(coords.length / 2 * 3);
  for (const el of elems) {
    const { Kt } = corotBeamForceTangent(coords, u, el);
    const gd = [3 * el.n1, 3 * el.n1 + 1, 3 * el.n1 + 2, 3 * el.n2, 3 * el.n2 + 1, 3 * el.n2 + 2];
    for (let a = 0; a < 6; a++) { const fa = dofMap[gd[a]]; if (fa < 0) continue; for (let b = 0; b < 6; b++) { const fb = dofMap[gd[b]]; if (fb < 0) continue; S.add(fa, fb, Kt[a * 6 + b]); } }
  }
  return extractFreeCSR(S, idMap, nF).csr;
}
const diagCSR = (d) => { const n = d.length, rowPtr = new Int32Array(n + 1), colIdx = new Int32Array(n), val = new Float64Array(n); for (let i = 0; i < n; i++) { rowPtr[i] = i; colIdx[i] = i; val[i] = d[i]; } rowPtr[n] = n; return { n, rowPtr, colIdx, val }; };

// ── (1) Linear limit vs newmarkLinear ─────────────────────────────────────────
console.log('── (1) tiny amplitude, α=0 → matches newmarkLinear (same M, K0, C) ──');
{
  const { coords, elems, free, Mlump, dofMap, nF, top } = column(5);
  const K0 = assembleK0(coords, elems, dofMap, nF);
  const Mfree = new Float64Array(nF); for (const d of free) Mfree[dofMap[d]] = Mlump[d];
  const Mcsr = diagCSR(Mfree);
  const iota = new Float64Array(nF); for (const d of free) if (d % 3 === 0) iota[dofMap[d]] = 1;
  const a0 = 0.3, a1 = 0.002;

  const dt = 0.01, nSteps = 400;
  const ag = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) ag[k] = 1e-4 * Math.sin(2 * Math.PI * 1.5 * k * dt);   // tiny → linear

  const tipU = dofMap[3 * top];
  const lin = newmarkLinear({ K: K0, M: Mcsr, a0, a1, ag, dt, iota, record: [tipU] });
  const nl = newmarkCorot({ coords, elems, free, Mlump, ag, dt, iota, a0, a1, record: [tipU], alpha: 0 });

  const hl = lin.hist.get(tipU), hn = nl.hist.get(tipU);
  let num = 0, den = 0, pl = 0, pn = 0;
  for (let k = 0; k < nSteps; k++) { num += (hl[k] - hn[k]) ** 2; den += hl[k] ** 2; pl = Math.max(pl, Math.abs(hl[k])); pn = Math.max(pn, Math.abs(hn[k])); }
  const rms = Math.sqrt(num / (den || 1));
  check(nl.ok, 'nonlinear integrator ran', `(avgNewton=${nl.avgNewton.toFixed(2)}, notConv=${nl.notConverged})`);
  check(rms < 1e-4, 'tip history ≡ newmarkLinear in the linear limit', `(RMS=${(rms * 100).toExponential(2)}%)`);
  check(rel(pn, pl) < 1e-3, 'peak tip displacement matches', `(${pn.toExponential(3)} vs ${pl.toExponential(3)})`);
  check(nl.avgNewton <= 3, 'Newton converges in ~2 iterations when linear', `(avg ${nl.avgNewton.toFixed(2)} iter)`);
}

// ── (2) Quasi-static limit → static corotational equilibrium ──────────────────
console.log('\n── (2) slow damped ramp → static corot solution (geometry carried) ──');
{
  const { coords, elems, free, nDOF, Mlump, dofMap, nF, top } = column(50);
  const iota = new Float64Array(nF); for (const d of free) if (d % 3 === 0) iota[dofMap[d]] = 1;

  const Ag = 50;                       // steady base accel → tip-mass inertial load
  const dt = 0.02, nSteps = 4000;
  const ag = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) ag[k] = Ag * Math.min(1, k * dt / 10);   // 10 s ramp, then hold

  const tipU = dofMap[3 * top];
  const nl = newmarkCorot({ coords, elems, free, Mlump, ag, dt, iota, a0: 3.0, a1: 0.03, record: [tipU] });
  const hn = nl.hist.get(tipU);
  let uDyn = 0; for (let k = nSteps - 100; k < nSteps; k++) uDyn += hn[k]; uDyn /= 100;

  // Static corot under the SAME nodal load pattern  F = −M·ι·Ag
  const Fref = new Float64Array(nDOF);
  for (const d of free) Fref[d] = -Mlump[d] * iota[dofMap[d]] * Ag;
  const st = solveCorotBeam({ coords: Float64Array.from(coords), elems: elems.map(e => ({ ...e })), free, Fref, nSteps: 20, maxIter: 80, tol: 1e-10 });
  const uStat = st.u[3 * top];

  // Linear (small-displacement) prediction, for contrast: K0·uLin = Fref
  const K0 = assembleK0(coords, elems, dofMap, nF);
  const { makeFactorCSR, permRCMcsr } = await import('../js/solver/linsolve.js');
  const fac = makeFactorCSR(K0, permRCMcsr(K0));
  const bLin = new Float64Array(nF); for (const d of free) bLin[dofMap[d]] = Fref[d];
  const xLin = new Float64Array(nF); fac.solve(bLin, xLin);
  const uLin = xLin[tipU];

  check(st.converged, 'static corot converged', `(uStat=${uStat.toFixed(4)} m)`);
  check(nl.ok && nl.notConverged === 0, 'dynamic ramp integrated (all steps converged)');
  check(rel(uDyn, uStat) < 0.02, 'settled dynamic tip ≡ static corot (within 2%)', `(${uDyn.toFixed(4)} vs ${uStat.toFixed(4)} m)`);
  check(rel(uStat, uLin) > 0.2, 'geometry matters strongly (static ≠ linear)', `(nl ${uStat.toFixed(3)} vs lin ${uLin.toFixed(3)} m)`);
}

// ── (3) Energy: undamped free vibration conserves amplitude ───────────────────
console.log('\n── (3) undamped free vibration (α=0) → energy conserved (stable amplitude) ──');
{
  const { coords, elems, free, nDOF, Mlump, dofMap, top } = column(5);
  // Proper deflected shape: static corot solve under a tip load (all of u,w,θ consistent).
  const Fref = new Float64Array(nDOF); Fref[3 * top] = 500;
  const u0 = solveCorotBeam({ coords: Float64Array.from(coords), elems: elems.map(e => ({ ...e })), free, Fref, nSteps: 1, maxIter: 60, tol: 1e-12 }).u;
  const nF2 = Math.max(...free.map(d => dofMap[d])) + 1;
  const zero = new Float64Array(nF2);   // no excitation
  const dt = 0.005, nSteps = 2000, ag = new Float64Array(nSteps);
  const tipU = dofMap[3 * top];
  const nl = newmarkCorot({ coords, elems, free, Mlump, ag, dt, iota: zero, a0: 0, a1: 0, u0, record: [tipU], alpha: 0 });
  const h = nl.hist.get(tipU);
  let pe = 0, pl = 0;
  for (let k = 0; k < 500; k++) pe = Math.max(pe, Math.abs(h[k]));
  for (let k = nSteps - 500; k < nSteps; k++) pl = Math.max(pl, Math.abs(h[k]));
  check(nl.ok, 'undamped run completed', `(u0tip=${u0[3 * top].toFixed(4)} m, ${(u0[3 * top] / H * 100).toFixed(0)}% drift)`);
  check(rel(pl, pe) < 0.02, 'amplitude stable early→late (energy conserved)', `(${pe.toFixed(5)} → ${pl.toFixed(5)} m)`);
}

// ── (4) Rayleigh damping decays the free vibration ────────────────────────────
console.log('\n── (4) Rayleigh damping → decaying free vibration ──');
{
  const { coords, elems, free, nDOF, Mlump, dofMap, top } = column(5);
  const Fref = new Float64Array(nDOF); Fref[3 * top] = 50;
  const u0 = solveCorotBeam({ coords: Float64Array.from(coords), elems: elems.map(e => ({ ...e })), free, Fref, nSteps: 1, maxIter: 60, tol: 1e-12 }).u;
  const nF2 = Math.max(...free.map(d => dofMap[d])) + 1;
  const dt = 0.005, nSteps = 2000, ag = new Float64Array(nSteps);
  const tipU = dofMap[3 * top];
  const nl = newmarkCorot({ coords, elems, free, Mlump, ag, dt, iota: new Float64Array(nF2), a0: 0.6, a1: 0.003, u0, record: [tipU] });
  const h = nl.hist.get(tipU);
  let pe = 0, pl = 0;
  for (let k = 0; k < 500; k++) pe = Math.max(pe, Math.abs(h[k]));
  for (let k = nSteps - 500; k < nSteps; k++) pl = Math.max(pl, Math.abs(h[k]));
  check(nl.ok, 'damped run completed');
  check(pl < 0.5 * pe, 'amplitude decays substantially under damping', `(${pe.toFixed(5)} → ${pl.toFixed(5)} m)`);
}

// ── (5) Driver end-to-end + structured refusal ────────────────────────────────
console.log('\n── (5) driver (nlDirectTimeHistory) ──');
{
  // A real planar Model: 2-storey column, base fixed, X base excitation.
  const m = new Model(); m.mode = '2D';
  m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'S', E, G: 8e7, nu: 0.3, rho });
  const sec = m.addSection({ name: 'C', A, Iy: I, Iz: I, J: 1e-6, Avy: 1e30, Avz: 1e30, kappay: 1, kappaz: 1 });
  const n0 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const n1 = m.addNode(0, 0, 2); const n2 = m.addNode(0, 0, 4);
  m.addElement(n0.id, n1.id, mat.id, sec.id); m.addElement(n1.id, n2.id, mat.id, sec.id);
  n1.nodeMass = { mx: 8, mz: 8 }; n2.nodeMass = { mx: 8, mz: 8 };

  const dt = 0.02, nSteps = 500, ag = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) ag[k] = 2 * Math.sin(2 * Math.PI * 1.0 * k * dt);   // 1 Hz, ±2 m/s²
  const r = nlDirectTimeHistory(m, { ag, dt, direction: 'X', rayleighFreqs: [8, 40], zeta: 0.05, record: [{ node: n2.id, dof: 0 }] });
  check(r.ok, 'driver ran end-to-end', r.ok ? `(nF=${r.nF}, avgNewton=${r.avgNewton.toFixed(2)})` : `(${r.reason})`);
  if (r.ok) {
    const hist = r.histAt(n2.id, 0), peak = r.peakNodal(n2.id);
    check(hist && hist.length === nSteps, 'recorded tip history returned', `(len ${hist?.length})`);
    check(peak[0] > 0 && isFinite(peak[0]), 'peak tip ux finite and non-zero', `(${peak[0].toExponential(3)} m)`);
    check(r.notConverged === 0, 'all steps converged');
  }

  const empty = nlDirectTimeHistory(new Model(), { ag, dt, rayleighFreqs: [10, 40] });
  check(!empty.ok, 'empty model → structured refusal', `(${empty.reason})`);
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
