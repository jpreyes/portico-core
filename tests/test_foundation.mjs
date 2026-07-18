// Verificación — viga sobre fundación elástica / resorte de línea (Winkler, 1-013).
// Caso exacto: barra libre-libre (sin apoyos) sobre fundación ky, bajo carga uniforme w.
// La carga uniforme y la reacción uniforme del balasto se equilibran SIN flexión →
// asentamiento UNIFORME y = w/ky, giros = 0, M = 0. Σreacción del balasto = w·L (equilibrio).
import '../lib/numeric.js';
import { Model } from '../js/model/model.js';
import { StaticSolver } from '../js/solver/static_solver.js';
globalThis.window = globalThis;

const L = 4, w = 10, ky = 5000;     // m, kN/m, kN/m²
let ok = true;
const chk = (name, got, exp, tol) => {
  const err = Math.abs(got - exp) / (Math.abs(exp) || 1);
  const pass = err <= tol; ok = pass && ok;
  console.log(`${pass ? 'OK ' : 'XX '} ${name}: ${got.toExponential(5)} vs ${exp.toExponential(5)}  (${(err*100).toFixed(4)}%)`);
};

// ── Caso 1: barra libre-libre sobre fundación, carga uniforme → asentamiento uniforme
{
  const m = new Model(); m.mode = '2D';
  const sec = m.addSection({ name: 'sq', A: 0.09, Iz: 6.75e-4, Iy: 6.75e-4, J: 1.14e-3, Avy: 1e8, Avz: 1e8 });
  // Restringir sólo el axial (ux) para quitar el cuerpo rígido axial; uz y ry libres
  // (la fundación los soporta). Membrana fuera de plano fijada por el modo 2D.
  const n1 = m.addNode(0, 0, 0, { ux: 1 });
  const n2 = m.addNode(L, 0, 0, { ux: 1 });
  const el = m.addElement(n1.id, n2.id, m._firstKey('materials'), sec.id);
  el.foundation = { ky };                                  // local y = global Z (barra en X)
  const lc = m.addLoadCase('w', false);
  lc.loads.push({ type: 'dist', elemId: el.id, dir: 'gravity', w });   // global −Z, w>0 abajo
  const res = new StaticSolver().solve(m, lc.id, false);
  const u1 = res.getNodeDisp(n1.id), u2 = res.getNodeDisp(n2.id);
  chk('asentamiento nodo1 = w/ky', Math.abs(u1[2]), w / ky, 1e-6);
  chk('asentamiento nodo2 = w/ky', Math.abs(u2[2]), w / ky, 1e-6);
  const rotMax = Math.max(Math.abs(u1[4]), Math.abs(u2[4]));
  console.log(`${rotMax < 1e-9 ? 'OK ' : 'XX '} giros ≈ 0 (sin flexión): ${rotMax.toExponential(2)}`);
  if (rotMax >= 1e-9) ok = false;
}

// ── Caso 2: la fundación RIGIDIZA una viga simplemente apoyada (flecha central menor)
{
  const mk = (withFound) => {
    const m = new Model(); m.mode = '2D';
    const sec = m.addSection({ name: 'sq', A: 0.09, Iz: 6.75e-4, Iy: 6.75e-4, J: 1.14e-3, Avy: 1e8, Avz: 1e8 });
    const N = 8, nodes = [];
    for (let i = 0; i <= N; i++) {
      const r = (i === 0) ? { ux: 1, uz: 1 } : (i === N ? { uz: 1 } : {});
      nodes.push(m.addNode(i * L / N, 0, 0, r));
    }
    const lc = m.addLoadCase('w', false);
    for (let i = 0; i < N; i++) {
      const el = m.addElement(nodes[i].id, nodes[i + 1].id, m._firstKey('materials'), sec.id);
      if (withFound) el.foundation = { ky };
      lc.loads.push({ type: 'dist', elemId: el.id, dir: 'gravity', w });
    }
    const res = new StaticSolver().solve(m, lc.id, false);
    return Math.abs(res.getNodeDisp(nodes[N / 2].id)[2]);
  };
  const d0 = mk(false), dF = mk(true);
  console.log(`${dF < d0 ? 'OK ' : 'XX '} fundación reduce la flecha central: sin=${d0.toExponential(3)} con=${dF.toExponential(3)}`);
  if (!(dF < d0)) ok = false;
}

console.log(ok ? '\n✅ TODO OK' : '\n❌ FALLÓ');
process.exit(ok ? 0 : 1);
