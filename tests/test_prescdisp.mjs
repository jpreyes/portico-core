// test_prescdisp.mjs — verifica desplazamiento prescrito de nodo/apoyo (#54, G14)
// Caso analítico: voladizo (empotrado en la base) con desplazamiento de punta δ
// impuesto y GIRO de punta LIBRE → cortante V = 3EIδ/L³ y momento base M = 3EIδ/L².
import { Model } from '../js/model/model.js';
import { StaticSolver } from '../js/solver/static_solver.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * Math.abs(b), `${m}  (${a.toFixed(5)} vs ${b.toFixed(5)})`);

// shim numeric (como el harness headless)
globalThis.window = globalThis;
await import('../lib/numeric.js');
globalThis.window.numeric = globalThis.numeric;

const E = 2.1e8, Iy = 8.333e-6, L = 4, delta = 0.01;
const EI = E * Iy;
const V_an = 3 * EI * delta / (L * L * L);
const M_an = 3 * EI * delta / (L * L);

const m = new Model();
m.materials.clear(); m.sections.clear();
const mat = m.addMaterial({ name: 'Acero', E, G: E / 2.6, nu: 0.3, rho: 7.85 });
// sección rígida a cortante (Avz enorme) para comparar con Euler-Bernoulli
const sec = m.addSection({ name: 'Vtest', A: 0.01, Iy, Iz: Iy, J: 1e-6, Avy: 1e3, Avz: 1e3, kappay: 1, kappaz: 1 });
const n0 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });   // empotrado
const n1 = m.addNode(L, 0, 0, { ux: 1, uy: 1, uz: 0, rx: 1, ry: 0, rz: 1 });   // uz prescrito, ry libre
m.addElement(n0.id, n1.id, mat.id, sec.id);
m.updateNode(n1.id, { prescDisp: { uz: -delta } });   // desplazamiento de punta descendente

const res = new StaticSolver().solve(m, null, false);

console.log('\n── Voladizo con desplazamiento de punta prescrito ───────');
const u1 = res.getNodeDisp(n1.id);   // [ux,uy,uz,rx,ry,rz]
rel(u1[2], -delta, 1e-6, 'uz del nodo impuesto = −δ');

// Reacción vertical en la punta = cortante V; momento ry en la base = M
const R1 = res.getReaction(n1.id);
const R0 = res.getReaction(n0.id);
rel(Math.abs(R1[2]), V_an, 0.01, 'reacción vertical punta |Rz| = 3EIδ/L³');
rel(Math.abs(R0[4]), M_an, 0.01, 'momento de empotramiento base |My| = 3EIδ/L²');

// Equilibrio global: ΣFz de reacciones ≈ 0 (no hay carga externa)
ok(Math.abs(R0[2] + R1[2]) < 1e-6 * V_an + 1e-9, `ΣFz reacciones ≈ 0  (${(R0[2] + R1[2]).toExponential(2)})`);

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
