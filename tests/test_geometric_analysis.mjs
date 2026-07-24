// test_geometric_analysis.mjs — the geometric-nonlinear analyses now living outside
// app.js (js/solver/geometric_analysis.js): linear buckling and P-Delta.
//
//   (1) Cantilever Euler buckling:   Pcr = π²·E·I / (4·L²)   ⇒  λcr = Pcr/P0
//   (2) P-Delta amplification of the SAME cantilever under axial P + lateral H:
//         δ_PD / δ_lin ≈ 1 / (1 − P/Pcr)   (self-consistent with (1)'s Pcr)
//
// Both were unreachable outside the DOM; this pins them to closed-form structural
// mechanics and cross-checks the two functions against each other.
//
// Run:  node test_geometric_analysis.mjs
import { linearBuckling, pDelta } from '../js/solver/geometric_analysis.js';
import { Model } from '../js/model/model.js';

let failures = 0;
const check = (cond, msg, extra = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const rel = (a, b) => Math.abs(b) < 1e-15 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b);

const E = 2.1e8, I = 8e-5, L = 4;   // planar column, bending about y (Iy)

// Vertical cantilever along Z, fixed at the base, meshed into nEl elements. 2D mode
// (uy,rx,rz locked) → in-plane x–z buckling/bending about y.
function column(nEl) {
  const m = new Model(); m.mode = '2D';
  m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'S', E, G: 8.0e7, nu: 0.3125, rho: 0 });
  const sec = m.addSection({ name: 'C', A: 0.01, Iy: I, Iz: I, J: 1e-6,
    Avy: 1e30, Avz: 1e30, kappay: 1, kappaz: 1 });
  const nodes = [];
  for (let i = 0; i <= nEl; i++) {
    const r = i === 0 ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } : {};
    nodes.push(m.addNode(0, 0, L * i / nEl, r));
  }
  for (let i = 0; i < nEl; i++) m.addElement(nodes[i].id, nodes[i + 1].id, mat.id, sec.id);
  return { m, top: nodes[nEl].id };
}

// ── (1) Cantilever Euler buckling ─────────────────────────────────────────────
console.log('── (1) linearBuckling → Pcr = π²·E·I/(4·L²) (cantilever) ──');
const PcrEuler = Math.PI ** 2 * E * I / (4 * L * L);
let PcrModel;
{
  const P0 = 100;
  const { m, top } = column(10);
  const lc = m.addLoadCase('axial');
  m.addLoad(lc.id, { type: 'nodal', nodeId: top, F: [0, 0, -P0, 0, 0, 0] });   // compression

  const res = linearBuckling(m, { nModes: 2 });
  check(res.ok, 'solver returned modes', res.ok ? '' : `(reason ${res.reason})`);
  PcrModel = res.modes[0].lambda * P0;
  check(rel(PcrModel, PcrEuler) < 0.02, 'Pcr within 2% of the Euler load',
    `(${PcrModel.toFixed(1)} vs ${PcrEuler.toFixed(1)})`);
  check(res.modes[0].lambda > 0, 'λcr > 0 for a compressed reference', `(λcr=${res.modes[0].lambda.toFixed(3)})`);
  check(res.Nby && res.Nby.size > 0, 'per-element reference axial force returned');

  // Default SPARSE buckling (solveBucklingCSR, no dense nF²) must match the dense one.
  const den = linearBuckling(m, { nModes: 2, dense: true });
  check(den.ok && rel(res.modes[0].lambda, den.modes[0].lambda) < 1e-9,
    'sparse buckling λcr ≡ dense to machine precision',
    `(${res.modes[0].lambda.toFixed(6)} vs ${den.modes[0].lambda.toFixed(6)})`);
}

// ── (2) P-Delta amplification, self-consistent with (1) ───────────────────────
console.log('\n── (2) pDelta → δ_PD/δ_lin ≈ 1/(1 − P/Pcr) ──');
{
  const Pax = 0.5 * PcrModel;          // half the critical load → amplification ≈ 2
  const H = 50;                        // lateral tip load (linear regime; amp is H-independent)
  const { m, top } = column(10);
  const axial = m.addLoadCase('axial');
  m.addLoad(axial.id, { type: 'nodal', nodeId: top, F: [0, 0, -Pax, 0, 0, 0] });
  const lat = m.addLoadCase('lateral');
  m.addLoad(lat.id, { type: 'nodal', nodeId: top, F: [H, 0, 0, 0, 0, 0] });

  const res = pDelta(m, {});
  check(res.ok, 'P-Delta converged to a field', res.ok ? '' : `(reason ${res.reason})`);
  check(res.conv, 'fixed-point iteration converged', `(${res.it} iter)`);
  check(res.dPD > res.dLin, 'P-Delta amplifies the linear displacement',
    `(${res.dLin.toExponential(3)} → ${res.dPD.toExponential(3)})`);
  const ampExpected = 1 / (1 - Pax / PcrModel);   // = 2.0
  check(rel(res.amp, ampExpected) < 0.05, 'amplification ≈ 1/(1−P/Pcr) = 2.0',
    `(${res.amp.toFixed(3)} vs ${ampExpected.toFixed(3)})`);

  // The default SPARSE path (no dense nDOF² matrix) must equal the dense one to
  // machine precision — same fixed-point iteration, same banded factorization.
  const den = pDelta(m, { dense: true });
  let maxDiff = 0; for (let i = 0; i < res.u.length; i++) maxDiff = Math.max(maxDiff, Math.abs(res.u[i] - den.u[i]));
  check(den.ok && maxDiff < 1e-9, 'sparse P-Delta ≡ dense to machine precision',
    `(maxDiff=${maxDiff.toExponential(2)}, sparse ${res.it} it / dense ${den.it} it)`);
}

// ── (3) Structured refusals (no toast layer) ──────────────────────────────────
console.log('\n── (3) structured refusals ──');
{
  const { m } = column(4);   // geometry but no loads
  const b = linearBuckling(m, {});
  check(!b.ok && b.reason === 'no-loads', 'buckling with no load case → "no-loads"', `(${b.reason})`);
  const p = pDelta(m, {});
  check(!p.ok && p.reason === 'no-loads', 'P-Delta with no load case → "no-loads"', `(${p.reason})`);

  // A tension-only reference produces no compression → no geometric stiffness effect.
  const { m: mt, top } = column(4);
  const lc = mt.addLoadCase('tension');
  mt.addLoad(lc.id, { type: 'nodal', nodeId: top, F: [0, 0, +100, 0, 0, 0] });   // pulls up
  const bt = linearBuckling(mt, {});
  check(!bt.ok, 'pure tension → no buckling modes (refused)', `(${bt.reason})`);
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
