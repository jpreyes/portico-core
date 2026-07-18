// test_links.mjs — verifica links / couplings (restricciones cinemáticas)
//
// Caso analítico (tablero excéntrico sobre pila): columna vertical empotrada en la
// base (1) con la punta libre (2). Un nodo de TABLERO (3) está desplazado e=2 m en X
// del eje de la pila, a la altura de la punta, y ligado a (2) con un LINK RÍGIDO.
// Una carga vertical P en el tablero (3) llega a la pila como P + momento M=P·e
// (carga excéntrica) → momento base M=P·e y flecha lateral M·H²/(2EI).
// Se compara: (A) modelo con link  vs  (B) modelo equivalente con Fz+My directos en (2).
import { Model } from '../js/model/model.js';
import { StaticSolver } from '../js/solver/static_solver.js';
import { Serializer } from '../js/model/serializer.js';

let fails = 0;
const ok  = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-9, `${m}  (${(+a).toExponential(4)} vs ${(+b).toExponential(4)})`);

globalThis.window = globalThis;
await import('../lib/numeric.js');
globalThis.window.numeric = globalThis.numeric;

const E = 2e8, Iy = 1e-4, A = 0.02, H = 5, e = 2, P = 100;
const EI = E * Iy;
const M_an = P * e;                         // momento base por excentricidad
const ux_an = M_an * H * H / (2 * EI);      // flecha lateral de la punta (cantilever con M)

function pier() {
  const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'H', E, G: E / 2.4, nu: 0.2, rho: 0 });
  // sección rígida a corte para comparar con Euler-Bernoulli
  const sec = m.addSection({ name: 'P', A, Iy, Iz: Iy, J: 1e-4, Avy: 1e3, Avz: 1e3, kappay: 1, kappaz: 1 });
  const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });   // base empotrada
  const n2 = m.addNode(0, 0, H);                                                  // punta de la pila
  m.addElement(n1.id, n2.id, mat.id, sec.id);
  return { m, mat, sec, n1, n2 };
}

// ── (A) con LINK rígido y carga en el tablero excéntrico ──────────────────────
const A1 = pier();
const n3 = A1.m.addNode(e, 0, H);                       // nodo de tablero, offset +e en X
A1.m.addLink({ master: A1.n2.id, slave: n3.id, rigid: true });
const lcA = A1.m.addLoadCase('deck', false);
A1.m.addLoad(lcA.id, { type: 'nodal', nodeId: n3.id, F: [0, 0, -P, 0, 0, 0] });   // P vertical ↓
const rA = new StaticSolver().solve(A1.m, lcA.id, false);

console.log('\n── (A) Carga vertical en tablero excéntrico (link rígido) ──');
const R1 = rA.getReaction(A1.n1.id);   // [Fx,Fy,Fz,Mx,My,Mz]
rel(Math.abs(R1[4]), M_an, 0.01, 'momento base |My| = P·e');
rel(R1[2], P, 0.01, 'reacción vertical base Fz = P');
const u2 = rA.getNodeDisp(A1.n2.id);
rel(Math.abs(u2[0]), ux_an, 0.02, 'flecha lateral de la punta ux = M·H²/(2EI)');

// rigidez del link: el esclavo sigue al maestro como sólido → uz_3 = uz_2 − θy_2·e
const u3 = rA.getNodeDisp(n3.id);
const thy2 = u2[4];   // giro ry de la punta
rel(u3[2], u2[2] - thy2 * e, 0.01, 'cinemática rígida: uz(tablero) = uz(pila) − θy·e');
rel(u3[0], u2[0], 0.01, 'ux(tablero) = ux(pila) (offset en X, sin θz)');

// ── (B) modelo EQUIVALENTE: Fz + My directos en la punta (sin link) ───────────
const B1 = pier();
const lcB = B1.m.addLoadCase('eq', false);
B1.m.addLoad(lcB.id, { type: 'nodal', nodeId: B1.n2.id, F: [0, 0, -P, 0, +P * e, 0] });
const rB = new StaticSolver().solve(B1.m, lcB.id, false);

console.log('\n── (B) Equivalente Fz+My directo vs (A) ─────────────────');
rel(rA.getNodeDisp(A1.n2.id)[0], rB.getNodeDisp(B1.n2.id)[0], 0.01, 'ux punta: link ≡ equivalente directo');
rel(rA.getReaction(A1.n1.id)[4], rB.getReaction(B1.n1.id)[4], 0.01, 'My base: link ≡ equivalente directo');

// ── (C) COUPLING simple (sin brazo): iguala un GDL ────────────────────────────
console.log('\n── (C) Coupling simple (uz igualado) ────────────────────');
const C = pier();
const c3 = C.m.addNode(e, 0, H);                          // nodo suelto
C.m.addNode;
C.m.addLink({ master: C.n2.id, slave: c3.id, rigid: false, dofs: { ux: 0, uy: 0, uz: 1, rx: 0, ry: 0, rz: 0 } });
// fijar los GDL no acoplados del nodo suelto para que no quede singular
C.m.updateNode(c3.id, { restraints: { ux: 1, uy: 1, uz: 0, rx: 1, ry: 1, rz: 1 } });
const lcC = C.m.addLoadCase('c', false);
C.m.addLoad(lcC.id, { type: 'nodal', nodeId: C.n2.id, F: [0, 0, -P, 0, 0, 0] });   // carga en la pila
const rC = new StaticSolver().solve(C.m, lcC.id, false);
rel(rC.getNodeDisp(c3.id)[2], rC.getNodeDisp(C.n2.id)[2], 0.01, 'uz(esclavo) = uz(maestro) por coupling');

// ── (D) round-trip serializer ─────────────────────────────────────────────────
console.log('\n── (D) round-trip .s3d del link ─────────────────────────');
const json = new Serializer().toJSON(A1.m);
const m2 = new Serializer().fromJSON(json);
ok(m2.links.size === 1, 'el link sobrevive el round-trip JSON');
const lk = [...m2.links.values()][0];
ok(lk.master === A1.n2.id && lk.slave === n3.id && lk.rigid === true, 'link conserva master/slave/rigid');
const rA2 = new StaticSolver().solve(m2, [...m2.loadCases.keys()][0], false);
rel(Math.abs(rA2.getReaction(A1.n1.id)[4]), M_an, 0.01, 'tras round-trip, momento base = P·e');

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
