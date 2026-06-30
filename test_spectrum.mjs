// SpectrumSolver — response-spectrum (CQC/SRSS) analytical contrast. The whole
// spectral pipeline (Sa interpolation, modal→spectral scaling Γ/M·Sd, force
// recovery, CQC/SRSS combination) had no direct test.
//
// Anchor: a single-DOF oscillator. For an SDOF the spectral displacement is exactly
// Sd = Sa(T)/ω² and the base shear is m_eff·Sa = M̄·Sa. These pin the core scaling
// and the element-force recovery independently of any combination rule.
import { Model } from './js/model/model.js';
globalThis.window = globalThis;
await import('./lib/numeric.js');
const { ModalSolver }    = await import('./js/solver/modal_solver.js');
const { SpectrumSolver } = await import('./js/solver/spectrum_solver.js');

let failures = 0;
const check = (cond, msg, extra='') => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  '+extra : ''}`); if (!cond) failures++; };
const rel = (a, b) => Math.abs(a-b)/Math.abs(b);

const E = 2.1e11, G = 8.0e10, rho = 7850;
const A = 0.02, Iy = 1.2e-5, Iz = 1.2e-5, J = 1e-6;

// Build a vertical cantilever (along global Z) of `nEl` elements. Free DOFs: ux and
// ry per node (sway in the global-X / vertical plane), root fully clamped. A vertical
// element's local axes put global X on the local bending plane, so a global-X seismic
// excitation maps cleanly to the element's Vy/Mz. `rhoEl` lets a test go massless
// (lumped-mass SDOF) by passing ~0.
function column(nEl, H, free = { uy:1, uz:1, rx:1, rz:1 }, rhoEl = rho) {
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name:'Steel', E, G, nu:0.3125, rho: rhoEl });
  const sec = m.addSection({ name:'C', A, Iy, Iz, J, Avy:1e30, Avz:1e30, kappay:1, kappaz:1 });
  const nodes = [];
  for (let k = 0; k <= nEl; k++) nodes.push(m.addNode(0, 0, (H/nEl)*k, { ...free }));
  m.updateNode(nodes[0].id, { restraints: { ux:1, uy:1, uz:1, rx:1, ry:1, rz:1 } });
  for (let k = 0; k < nEl; k++) m.addElement(nodes[k].id, nodes[k+1].id, mat.id, sec.id);
  return { m, nodes, mat, sec };
}

const flatSa = 4.0;                              // constant spectral acceleration
const flatSpectrum = [{ T: 0.001, Sa: flatSa }, { T: 100, Sa: flatSa }];

// ── (1) SDOF spectral displacement = Sa/ω² and base shear = M̄·Sa ────────────
console.log('── (1) SDOF: spectral displacement Sa/ω² and base shear m_eff·Sa ──');
{
  // 1-element guided column, massless (rho≈0) with a LUMPED mass at the tip → a clean
  // single-DOF oscillator (consistent mass would couple the tip to the support and
  // spoil the textbook u=Sd identity — that is correct physics, just not an SDOF).
  const { m, nodes } = column(1, 3.0, { uy:1, uz:1, rx:1, ry:1, rz:1 }, 1e-9);
  m.updateNode(nodes[1].id, { restraints: { uy:1, uz:1, rx:1, ry:1, rz:1 }, nodeMass: { mx: 50, my: 50, mz: 50 } });   // only ux free, lumped mass
  const mr = new ModalSolver().solve(m, 1);
  const w2 = mr.omega2[0], Mbar = mr.genMass[0];
  const sr = new SpectrumSolver().solve(mr, { spectrum: flatSpectrum, direction:'X', method:'SRSS', zeta:0.05 });
  const uTip = sr.getNodeDisp(nodes[1].id)[0];   // ux
  const Sd = flatSa / w2;
  check(rel(uTip, Sd) < 1e-6, `tip ux = Sa/ω²`, `(${uTip.toExponential(5)} vs ${Sd.toExponential(5)})`);
  // base shear: the element's local-y shear (global X for a vertical member) = M̄·Sa
  const ef = sr.getElemForces([...m.elements.keys()][0]);
  const Vbase = Math.abs(ef.Vy1);
  check(rel(Vbase, Mbar * flatSa) < 1e-6, `base shear = m_eff·Sa`, `(${Vbase.toExponential(5)} vs ${(Mbar*flatSa).toExponential(5)})`);
}

// ── (2) Sa interpolation through the SDOF (ramp + long-period 1/T tail) ───────
console.log('\n── (2) Sa(T) interpolation reaches the modal period correctly ──');
{
  // Spectrum: ramp 0.2→0.6 between T=0.1 and T=0.5, then 1/T tail beyond T=0.5.
  const spec = [{ T: 0.05, Sa: 0.2 }, { T: 0.1, Sa: 0.2 }, { T: 0.5, Sa: 0.6 }, { T: 1.0, Sa: 0.3 }];
  const interp = (T) => {                         // reference implementation
    if (T <= spec[0].T) return spec[0].Sa;
    const last = spec[spec.length-1]; if (T >= last.T) return last.Sa * last.T / T;
    for (let i=0;i<spec.length-1;i++){ const a=spec[i],b=spec[i+1]; if (T>=a.T&&T<=b.T) return a.Sa + (T-a.T)/(b.T-a.T)*(b.Sa-a.Sa); }
    return 0;
  };
  // a flexible massless column + tip lumped mass so T1 lands in the ramp/tail region
  const { m, nodes } = column(1, 6.0, { uy:1, uz:1, rx:1, ry:1, rz:1 }, 1e-9);
  m.updateNode(nodes[1].id, { restraints: { uy:1, uz:1, rx:1, ry:1, rz:1 }, nodeMass: { mx: 80, my: 80, mz: 80 } });
  const mr = new ModalSolver().solve(m, 1);
  const T1 = mr.period[0], w2 = mr.omega2[0];
  const sr = new SpectrumSolver().solve(mr, { spectrum: spec, direction:'X', method:'SRSS', zeta:0.05 });
  const uTip = sr.getNodeDisp(nodes[1].id)[0];
  const SaExpected = interp(T1);
  console.log(`  T1=${T1.toFixed(3)} s → Sa=${SaExpected.toFixed(4)}`);
  check(rel(uTip, SaExpected / w2) < 1e-6, `tip ux = Sa(T1)/ω² (interp used correctly)`, `(${uTip.toExponential(4)} vs ${(SaExpected/w2).toExponential(4)})`);
}

// ── (3) CQC vs SRSS on a multi-mode cantilever ───────────────────────────────
// Well-separated modes (cantilever) → CQC ≈ SRSS. Both must be positive envelopes
// and bounded above by the absolute modal sum. Mismatch reveals a CQC bug.
console.log('\n── (3) CQC vs SRSS (multi-mode cantilever) ──');
{
  const { m, nodes } = column(6, 6.0);            // ux & ry free → flexural sway modes
  const mr = new ModalSolver().solve(m, 3);
  const tip = nodes[nodes.length-1].id;
  const srss = new SpectrumSolver().solve(mr, { spectrum: flatSpectrum, direction:'X', method:'SRSS', zeta:0.05 });
  const cqc  = new SpectrumSolver().solve(mr, { spectrum: flatSpectrum, direction:'X', method:'CQC',  zeta:0.05 });
  const uS = srss.getNodeDisp(tip)[0], uC = cqc.getNodeDisp(tip)[0];
  console.log(`  freqs = [${mr.freq.slice(0,3).map(f=>f.toFixed(2)).join(', ')}] Hz`);
  console.log(`  tip ux  SRSS=${uS.toExponential(4)}  CQC=${uC.toExponential(4)}  Δ=${(rel(uC,uS)*100).toFixed(2)}%`);
  check(uS > 0 && uC > 0, 'both combinations give a positive envelope');
  check(rel(uC, uS) < 0.05, 'CQC ≈ SRSS for well-separated modes');
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
