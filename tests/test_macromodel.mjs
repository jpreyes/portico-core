// Verificación — macromodelo de muro de relleno (puntal diagonal equivalente, #86).
// (1) ancho del puntal de Mainstone vs cálculo a mano.
// (2) inserción: 2 puntales diagonales solo-compresión con A = w·t.
// (3) comportamiento: bajo carga lateral, la diagonal COMPRIMIDA trabaja y la
//     TRACCIONADA se afloja (N=0); y el panel rigidiza el marco.
import { Model } from '../js/model/model.js';
import { mainstoneStrut, insertInfill } from '../js/model/macromodel.js';
import { solveNonlinear, barState } from '../js/solver/nl_lite.js';

let ok = true;
const chk = (name, got, exp, tol) => { const e = Math.abs(got - exp) / (Math.abs(exp) || 1); const p = e <= tol; ok = p && ok; console.log(`${p ? 'OK ' : 'XX '} ${name}: ${(+got).toPrecision(5)} vs ${(+exp).toPrecision(5)} (${(e*100).toFixed(2)}%)`); };
const flag = (name, c) => { ok = c && ok; console.log(`${c ? 'OK ' : 'XX '} ${name}`); };

// ── (1) Mainstone a mano ────────────────────────────────────────────────────
const hm = 2.7, Lm = 4, t = 0.2, Em = 3e6, EcIcol = 2.5e7 * (0.3 ** 4 / 12), hcol = 2.7;
const s = mainstoneStrut({ hm, Lm, t, Em, EcIcol, hcol });
const theta = Math.atan2(hm, Lm), dm = Math.hypot(hm, Lm);
const lambda = Math.pow((Em * t * Math.sin(2 * theta)) / (4 * EcIcol * hm), 0.25);
const wHand = 0.175 * Math.pow(lambda * hcol, -0.4) * dm;
chk('ancho puntal w (Mainstone)', s.w, wHand, 1e-9);
chk('área puntal A = w·t', s.area, wHand * t, 1e-9);
console.log(`   θ=${(theta*180/Math.PI).toFixed(1)}° · d=${dm.toFixed(3)} m · λ=${lambda.toFixed(4)} · w=${s.w.toFixed(3)} m · A=${s.area.toFixed(4)} m²`);

// ── (2)+(3) Marco con relleno ───────────────────────────────────────────────
function buildPortal() {
  const m = new Model(); m.mode = '2D';
  const matF = m._firstKey('materials');                     // hormigón por defecto
  const sec = m.addSection({ name: 'col', A: 0.09, Iz: 6.75e-4, Iy: 6.75e-4, J: 1.14e-3, Avy: 0.075, Avz: 0.075 }).id;
  const bl = m.addNode(0, 0, 0, { ux: 1, uz: 1 });           // base izq (pin)
  const br = m.addNode(Lm, 0, 0, { ux: 1, uz: 1 });          // base der (pin)
  const tl = m.addNode(0, 0, hm);                            // sup izq
  const tr = m.addNode(Lm, 0, hm);                           // sup der
  // marco como barras (columnas + viga)
  for (const [a, b] of [[bl, tl], [br, tr], [tl, tr]]) m.addElement(a.id, b.id, matF, sec);
  return { m, bl, br, tl, tr, matF, sec };
}

// elems para el solver NL desde el modelo (EA, L0, compressionOnly)
function nlElems(m) {
  const ids = [...m.nodes.keys()], idx = new Map(ids.map((id, i) => [id, i]));
  const elems = [];
  for (const el of m.elements.values()) {
    const n1 = m.nodes.get(el.n1), n2 = m.nodes.get(el.n2), mat = m.materials.get(el.matId), sc = m.sections.get(el.secId);
    const L = Math.hypot(n2.x - n1.x, n2.z - n1.z);
    elems.push({ n1: idx.get(el.n1), n2: idx.get(el.n2), EA: mat.E * sc.A, L0: L, compressionOnly: !!el.compressionOnly, _id: el.id });
  }
  // coords X en 3D (nl_lite usa 3 GDL traslación; aquí plano X–Z → y=0)
  const X = new Float64Array(3 * ids.length);
  ids.forEach((id, i) => { const n = m.nodes.get(id); X[3*i] = n.x; X[3*i+1] = n.y; X[3*i+2] = n.z; });
  // Modelo 2D X–Z: uy (fuera de plano) SIEMPRE fijo (si no, mecanismo).
  const free = []; ids.forEach((id, i) => { const r = m.nodes.get(id).restraints; if (!r.ux) free.push(3*i); if (!r.uz) free.push(3*i+2); });
  return { elems, X, free, idx, ids };
}

// Marco CON relleno
const { m, bl, br, tl, tr } = buildPortal();
const ins = insertInfill(m, [bl.id, br.id, tl.id, tr.id], { Em, t, EcIcol });
flag('inserción: 2 puntales creados', ins.strutIds?.length === 2);
const struts = ins.strutIds.map(id => m.elements.get(id));
flag('puntales solo-compresión', struts.every(e => e.compressionOnly));
chk('área del puntal en el modelo', m.sections.get(ins.secId).A, s.area, 1e-9);

// Carga lateral en la esquina superior izquierda (empuja a la derecha, +X)
const P = 500;   // kN
const { elems, X, free, idx } = nlElems(m);
const Fref = new Float64Array(X.length); Fref[3 * idx.get(tl.id)] = P;
const res = solveNonlinear({ X, elems, free, Fref, nSteps: 12, maxIter: 60, tol: 1e-8 });
flag('NL convergió', res.converged);
const uFinal = res.steps[res.steps.length - 1].u;
// N de cada puntal en el estado final
const sN = struts.map(e => { const ge = elems.find(x => x._id === e.id); return barState(X, uFinal, ge).N; });
const nCompres = sN.filter(n => n < -1e-6).length, nSlack = sN.filter(n => Math.abs(n) < 1e-6).length;
console.log(`   N puntales = [${sN.map(n => n.toFixed(1)).join(', ')}] kN`);
flag('una diagonal COMPRIMIDA (activa)', nCompres === 1);
flag('la otra diagonal FLOJA (N≈0)', nSlack === 1);

// Rigidez lateral: con relleno la deriva del tope debe ser MENOR que sin relleno
const drift = (mdl) => { const e = nlElems(mdl); const F = new Float64Array(e.X.length); F[3 * e.idx.get(tl.id)] = P;
  // ojo: tl.id es del modelo con relleno; para el bare reconstruyo
  return null; };
// bare frame
const bare = buildPortal();
{
  const e = nlElems(bare.m); const F = new Float64Array(e.X.length); F[3 * e.idx.get(bare.tl.id)] = P;
  // el portal de barras sin diagonal es un mecanismo en truss → usar una diagonal rígida ficticia no; en su lugar comparamos magnitud del desplazamiento del tope
  const r2 = solveNonlinear({ X: e.X, elems: e.elems, free: e.free, Fref: F, nSteps: 1, maxIter: 60, tol: 1e-6 });
  const driftBare = r2.converged ? Math.abs(r2.steps[0].u[3 * e.idx.get(bare.tl.id)]) : Infinity;
  const driftInf = Math.abs(uFinal[3 * idx.get(tl.id)]);
  console.log(`   deriva tope: con relleno=${driftInf.toExponential(3)} m · sin relleno (truss)=${driftBare === Infinity ? '∞ (mecanismo)' : driftBare.toExponential(3)}`);
  flag('el relleno aporta rigidez lateral (deriva finita y menor)', driftInf < driftBare);
}

console.log(ok ? '\n✅ TODO OK' : '\n❌ FALLÓ');
process.exit(ok ? 0 : 1);
