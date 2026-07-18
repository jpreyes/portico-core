// test_tendon.mjs — verifica pretensado por tendones / cargas equivalentes (#60)
//
// Método de balanceo de carga (T.Y. Lin) en viga simplemente apoyada:
//   (1) tendón parabólico de sagita a, fuerza P → UDL equivalente w = 8Pa/L² (↑).
//   (2) sólo el tendón → contraflecha de centro = 5wL⁴/384EI (↑, viga simple).
//   (3) balanceo: añadir UDL externa ↓ de igual magnitud → flecha neta ≈ 0.
//   (4) axial uniforme = P (compresión) sin reacción horizontal en los apoyos.
//   (5) anclas excéntricas (a=0, e1=e2=e) → momento primario constante M = P·e.
import { Model } from '../js/model/model.js';
import { StaticSolver } from '../js/solver/static_solver.js';
import { tendonEquivalentLoads, tendonEcc, tendonForce } from '../js/solver/tendon.js';

let fails = 0;
const ok  = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-9, `${m}  (${a.toExponential(4)} vs ${b.toExponential(4)})`);

globalThis.window = globalThis;
await import('../lib/numeric.js');
globalThis.window.numeric = globalThis.numeric;

const E = 3e7, I = 0.1, A = 0.5, L = 20, NEL = 4;
const EI = E * I;
const P = 2000, a = 0.4;
const w_eq = 8 * P * a / (L * L);                  // 16 kN/m ↑
const camber = 5 * w_eq * L ** 4 / (384 * EI);     // contraflecha de centro

function makeBeam() {
  const m = new Model(); m.mode = '2D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'H', E, G: E / 2.4, nu: 0.2, rho: 0 });
  const sec = m.addSection({ name: 'G', A, Iy: I, Iz: I, J: 1e-3, Avy: 1e3, Avz: 1e3, kappay: 1, kappaz: 1 });
  const nodes = [];
  for (let i = 0; i <= NEL; i++) {
    const x = L * i / NEL;
    const r = i === 0 ? { ux: 1, uz: 1 } : i === NEL ? { uz: 1 } : {};   // pin + rodillo
    nodes.push(m.addNode(x, 0, 0, r));
  }
  const elems = [];
  for (let i = 0; i < NEL; i++) elems.push(m.addElement(nodes[i].id, nodes[i + 1].id, mat.id, sec.id));
  return { m, nodes, elems, mat, sec };
}

// ── (1) UDL equivalente ──────────────────────────────────────────────────────
console.log('\n── Carga equivalente del tendón parabólico ──────────────');
const B = makeBeam();
const tendon = { elems: B.elems.map(e => e.id), profile: 'parabola', P, e: { start: 0, mid: a, end: 0 } };
const { loads, weq } = tendonEquivalentLoads(B.m, tendon);
rel(weq, w_eq, 1e-9, 'w_eq = 8·P·a/L²');
ok(loads.filter(l => l.type === 'dist').every(l => Math.abs(l.w + w_eq) < 1e-6), 'cargas dist = −w_eq (hacia arriba)');

// ── (2) contraflecha sólo por el tendón ──────────────────────────────────────
const lc = B.m.addLoadCase('PT', false);
for (const ld of loads) B.m.addLoad(lc.id, ld);
const rPT = new StaticSolver().solve(B.m, lc.id, false);
const mid = B.nodes[NEL / 2].id;
console.log('\n── Contraflecha y axial del pretensado ──────────────────');
rel(rPT.getNodeDisp(mid)[2], camber, 0.01, 'contraflecha de centro = 5wL⁴/384EI (↑)');
rel(rPT.getElemForces(B.elems[0].id).N, -P, 1e-3, 'axial = −P (compresión uniforme)');
// Sin reacción horizontal (el axial del pretensado es interno autoequilibrado)
const Rx = rPT.getReaction(B.nodes[0].id)[0];
ok(Math.abs(Rx) < 1e-6 * P, `reacción horizontal en el apoyo ≈ 0  (${Rx.toExponential(2)})`);

// ── (3) balanceo de carga: tendón + UDL externa ↓ igual → flecha ≈ 0 ─────────
const C = makeBeam();
const lcB = C.m.addLoadCase('balance', false);
for (const ld of tendonEquivalentLoads(C.m, { elems: C.elems.map(e => e.id), profile: 'parabola', P, e: { start: 0, mid: a, end: 0 } }).loads)
  C.m.addLoad(lcB.id, ld);
for (const e of C.elems) C.m.addLoad(lcB.id, { type: 'dist', elemId: e.id, dir: 'gravity', w: w_eq });   // ↓ igual
const rBal = new StaticSolver().solve(C.m, lcB.id, false);
console.log('\n── Balanceo de carga (carga externa = w_eq) ─────────────');
ok(Math.abs(rBal.getNodeDisp(C.nodes[NEL / 2].id)[2]) < 1e-4 * camber + 1e-9,
   `flecha neta de centro ≈ 0  (${rBal.getNodeDisp(C.nodes[NEL / 2].id)[2].toExponential(2)} vs camber ${camber.toExponential(2)})`);

// ── (4) anclas excéntricas → momento primario constante P·e ──────────────────
console.log('\n── Anclas excéntricas: momento primario P·e ─────────────');
const D = makeBeam();
const e0 = 0.3;
const lcE = D.m.addLoadCase('ecc', false);
for (const ld of tendonEquivalentLoads(D.m, { elems: D.elems.map(e => e.id), profile: 'parabola', P, e: { start: e0, mid: e0, end: e0 } }).loads)
  D.m.addLoad(lcE.id, ld);
const rE = new StaticSolver().solve(D.m, lcE.id, false);
const Mmid = Math.abs(rE.getElemAtXi(D.elems[0].id, 0.0).Mz);   // momento en el extremo del 1er elem (= P·e constante)
rel(Mmid, P * e0, 0.02, 'momento primario = P·e (constante en viga simple)');

// ── (5) helpers de trazado y pérdidas ────────────────────────────────────────
console.log('\n── Trazado y pérdidas ───────────────────────────────────');
rel(tendonEcc({ e: { start: 0, mid: a, end: 0 } }, 0.5), a, 1e-9, 'e(0.5) = sagita a en el centro');
rel(tendonEcc({ e: { start: 0, mid: a, end: 0 } }, 0.0), 0, 1e-9, 'e(0) = 0 en el ancla');
const fr = tendonForce({ jack: 1000, friction: { mu: 0.2, k: 0.001 }, e: {} }, L, a);
ok(fr.Pend < fr.P0 && fr.Pavg < fr.P0 && fr.Pavg > fr.Pend, `pérdidas por fricción: P0=${fr.P0} > Pavg=${fr.Pavg.toFixed(1)} > Pend=${fr.Pend.toFixed(1)}`);

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
