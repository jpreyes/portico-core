// Verificación — resorte de extremo / fijación parcial (1-008).
// Voladizo con conexión semi-rígida (resorte rotacional k) en la base.
// El resorte añade una rotación de cuerpo rígido φ = M/k = P·L/k → flecha extra
// en la punta = φ·L = P·L²/k (INDEPENDIENTE del corte/Timoshenko).
//   δ(k) − δ(rígido) = P·L²/k ;  k→∞ ⇒ rígido (incremento→0).
import './lib/numeric.js';                 // setea global.numeric (efecto lateral)
import { Model } from './js/model/model.js';
import { StaticSolver } from './js/solver/static_solver.js';
globalThis.window = globalThis;            // StaticSolver usa window.numeric

const L = 3, P = 10;            // m, kN (hacia −Z)
const E = 2.87e7, I = 6.75e-4;  // material/sección por defecto (square 0.30)

const mk = (k) => {
  const m = new Model();
  m.mode = '2D';                                  // plano X–Z: GDL ux, uz, ry
  const matId = m._firstKey('materials');
  // Sección sin deformación por corte (Avy/Avz enormes → Euler puro) para que
  // δ_rígido = P·L³/(3EI) exacto; el incremento del resorte no depende de esto.
  const sec = m.addSection({ name: 'sq', A: 0.09, Iz: I, Iy: I, J: 1.14e-3, Avy: 1e8, Avz: 1e8 });
  const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const n2 = m.addNode(L, 0, 0);
  const el = m.addElement(n1.id, n2.id, matId, sec.id);
  // Carga en global Z → flexión en el plano local x–y (ey=global Z); el giro de la
  // base es θz local = GDL 5 en el extremo i. Resorte ahí.
  if (k != null) el.endSprings = { 5: k };
  const lc = m.addLoadCase('P', false);
  lc.loads.push({ type: 'nodal', nodeId: n2.id, F: [0, 0, -P, 0, 0, 0] });
  const res = new StaticSolver().solve(m, lc.id, false);
  return Math.abs(res.getNodeDisp(n2.id)[2]);      // |uz| en la punta
};

const dRig = mk(null);                  // conexión rígida
const dEuler = P * L ** 3 / (3 * E * I);
let ok = true;
const chk = (name, got, exp, tol) => {
  const err = Math.abs(got - exp) / (Math.abs(exp) || 1);
  const pass = err <= tol; ok = pass && ok;
  console.log(`${pass ? 'OK ' : 'XX '} ${name}: ${got.toExponential(5)} vs ${exp.toExponential(5)}  (${(err*100).toFixed(3)}%)`);
};

chk('δ rígido = PL³/3EI', dRig, dEuler, 1e-4);

for (const k of [1e6, 1e5, 2e4]) {
  const d = mk(k);
  const inc = d - dRig;                 // incremento de flecha por el resorte
  chk(`incremento (k=${k.toExponential(0)}) = PL²/k`, inc, P * L ** 2 / k, 1e-3);
}

// Monotonía + límite: k muy grande → casi rígido
const dStiff = mk(1e9);
console.log(`${dStiff - dRig < dEuler * 1e-3 ? 'OK ' : 'XX '} k=1e9 ≈ rígido (incremento despreciable): ${(dStiff - dRig).toExponential(3)}`);
if (dStiff - dRig >= dEuler * 1e-3) ok = false;

console.log(ok ? '\n✅ TODO OK' : '\n❌ FALLÓ');
process.exit(ok ? 0 : 1);
