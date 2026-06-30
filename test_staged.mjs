// test_staged.mjs — verifica etapas constructivas (staged construction, #59)
//
// Caso analítico: voladizo apuntalado CONSTRUIDO POR ETAPAS vs. monolítico.
//   Etapa A: voladizo (empotrado en 1, punta 2 libre) con UDL w1  → flecha de punta
//            δ_A = w1·L⁴/(8EI), momento base M_A = −w1·L²/2.
//   Etapa B: se añade un puntal (uz fijo) en la punta 2, SIN carga → nada cambia.
//   Etapa C: UDL w2 con la punta YA apuntalada (viga apuntalada)  → la punta no se
//            mueve (ΔU=0), momento base ΔM = −w2·L²/8, reacción del puntal 3w2L/8.
// Resultado por etapas:  δ_punta = w1·L⁴/8EI (NO cero),  M_base = −w1L²/2 − w2L²/8.
// Monolítico (puntal desde el inicio, w1+w2 de golpe): δ_punta = 0,
//            M_base = −(w1+w2)L²/8.  → Difieren: ahí está el valor del análisis staged.
import { Model } from './js/model/model.js';
import { StaticSolver } from './js/solver/static_solver.js';
import { StagedSolver } from './js/solver/staged.js';

let fails = 0;
const ok  = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-9, `${m}  (${a.toExponential(4)} vs ${b.toExponential(4)})`);

globalThis.window = globalThis;
await import('./lib/numeric.js');
globalThis.window.numeric = globalThis.numeric;

const E = 2.1e8, I = 8.333e-6, L = 8, w1 = 12, w2 = 20;
const EI = E * I;
const dA   = w1 * L ** 4 / (8 * EI);                 // flecha etapa A (cantilever UDL)
// Momento base (magnitud) en la convención Mz1 del elemento (signo + para el
// empotramiento bajo carga gravitatoria en esta orientación).
const Mbase_staged = (w1 * L * L / 2) + (w2 * L * L / 8);
const Mbase_mono   = (w1 + w2) * L * L / 8;
const Rprop_staged = 3 * w2 * L / 8;

function makeBeam() {
  const m = new Model(); m.mode = '2D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'Acero', E, G: E / 2.6, nu: 0.3, rho: 0 });   // rho=0: sin peso propio
  const sec = m.addSection({ name: 'V', A: 0.02, Iy: I, Iz: I, J: 1e-6, Avy: 1e3, Avz: 1e3, kappay: 1, kappaz: 1 });
  const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });    // empotrado
  const n2 = m.addNode(L, 0, 0);                                                   // punta libre
  const e1 = m.addElement(n1.id, n2.id, mat.id, sec.id);
  return { m, n1, n2, e1 };
}

// ── Por ETAPAS ──────────────────────────────────────────────────────────────
const A = makeBeam();
const staged = new StagedSolver().solve(A.m, [
  { name: 'A: voladizo + w1', activate: [A.e1.id], loads: [{ type: 'dist', elemId: A.e1.id, dir: 'gravity', w: w1 }] },
  { name: 'B: apuntalar punta', supports: [{ node: A.n2.id, uz: 1 }] },
  { name: 'C: w2 apuntalado', loads: [{ type: 'dist', elemId: A.e1.id, dir: 'gravity', w: w2 }] },
]);

console.log('\n── Construcción por etapas ──────────────────────────────');
rel(staged.getNodeDisp(A.n2.id)[2], -dA, 0.01, 'flecha de punta = −w1L⁴/8EI (la del voladizo, NO cero)');
rel(staged.getElemForces(A.e1.id).Mz1, Mbase_staged, 0.01, 'momento base = −w1L²/2 − w2L²/8');
rel(staged.getReaction(A.n2.id)[2], Rprop_staged, 0.02, 'reacción del puntal = 3w2L/8 (sólo w2)');

// Equilibrio: ΣFz reacciones = carga total (w1+w2)·L
const sumFz = staged.getReaction(A.n1.id)[2] + staged.getReaction(A.n2.id)[2];
rel(sumFz, (w1 + w2) * L, 0.001, 'ΣFz reacciones = (w1+w2)·L  (equilibrio)');

// ── MONOLÍTICO (mismo total, puntal desde el inicio) ─────────────────────────
const B = makeBeam();
B.m.updateNode(B.n2.id, { restraints: { uz: 1 } });    // apuntalado desde el inicio
const lc = B.m.addLoadCase('todo', false);
B.m.addLoad(lc.id, { type: 'dist', elemId: B.e1.id, dir: 'gravity', w: w1 + w2 });
const mono = new StaticSolver().solve(B.m, lc.id, false);

console.log('\n── Monolítico (referencia de contraste) ─────────────────');
rel(mono.getNodeDisp(B.n2.id)[2], 0, 1e-6, 'flecha de punta monolítica ≈ 0 (apuntalada)');
rel(mono.getElemForces(B.e1.id).Mz1, Mbase_mono, 0.01, 'momento base monolítico = −(w1+w2)L²/8');
ok(Math.abs(staged.getElemForces(A.e1.id).Mz1 - mono.getElemForces(B.e1.id).Mz1) > 0.1 * Math.abs(Mbase_mono),
   'el momento base por etapas DIFIERE del monolítico (efecto staged)');

// ── Sanidad: misma estructura, carga partida en 2 etapas = monolítico ────────
const C = makeBeam();
C.m.updateNode(C.n2.id, { restraints: { uz: 1 } });
const split = new StagedSolver().solve(C.m, [
  { name: '1', activate: [C.e1.id], loads: [{ type: 'dist', elemId: C.e1.id, dir: 'gravity', w: (w1 + w2) / 2 }] },
  { name: '2', loads: [{ type: 'dist', elemId: C.e1.id, dir: 'gravity', w: (w1 + w2) / 2 }] },
]);
console.log('\n── Sanidad: estructura fija, carga en 2 mitades = monolítico ──');
rel(split.getElemForces(C.e1.id).Mz1, Mbase_mono, 1e-4, 'momento base (2 mitades) = monolítico');

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
