// test_componly.mjs — verifica miembros «compression-only» (#56, G14)
// Espejo del cable tension-only: un puntal sólo resiste compresión, N=0 en tracción.
import { solveNonlinear } from '../js/solver/nl_lite.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  OK ' : 'FAIL '} ${msg}`); if (!cond) fails++; };
const close = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}  (${a.toFixed(4)} vs ${b.toFixed(4)})`);

// Una barra horizontal entre nodo 0 (fijo) y nodo 1 (libre en x).
// EA = 1000, L0 = L = 2.  Empujamos el nodo 1 con Fx.
const EA = 1000, L = 2;
function run(Fx, flags) {
  const X = new Float64Array([0, 0, 0, L, 0, 0]);
  const elems = [{ n1: 0, n2: 1, EA, L0: L, ...flags }];
  // nodo 0 fijo; nodo 1 libre sólo en x (y,z fijos para evitar mecanismo lateral)
  const free = [3];                 // gdl x del nodo 1
  const Fref = new Float64Array(6); Fref[3] = Fx;
  const r = solveNonlinear({ X, elems, free, Fref, nSteps: 10, maxIter: 60 });
  return r.steps[r.steps.length - 1];
}

console.log('\n── Puntal compression-only ──────────────────────────────');
// 1) Tracción (Fx>0 aleja el nodo): el puntal NO resiste → N≈0, se desplaza libre
{
  const s = run(+50, { compressionOnly: true });
  close(s.N[0], 0, 1e-6, 'tracción: N ≈ 0 (puntal suelto)');
  ok(s.taut[0] === false, 'tracción: marcado suelto (taut=false)');
}
// 2) Compresión (Fx<0 acerca el nodo): el puntal SÍ resiste → N<0 = Fx (equilibrio)
{
  const s = run(-50, { compressionOnly: true });
  ok(s.N[0] < 0, 'compresión: N < 0 (resiste)');
  close(s.N[0], -50, 0.5, 'compresión: N ≈ −Fx (equilibrio axial)');
  ok(s.taut[0] === true, 'compresión: activo (taut=true)');
}
// 3) Control: barra normal en tracción SÍ resiste (sin flag)
{
  const s = run(+50, {});
  close(s.N[0], +50, 0.5, 'barra normal: N ≈ +Fx en tracción');
}

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
