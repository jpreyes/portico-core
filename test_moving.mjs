// test_moving.mjs — verifica cargas móviles y líneas de influencia (#61)
//
// Viga simplemente apoyada, luz L.  Líneas de influencia clásicas (exactas):
//   · Reacción del apoyo izquierdo:  R(x) = 1 − x/L   (recta de 1 a 0).
//   · Momento en el centro de luz:   triángulo, pico L/4 en x = L/2,
//     M(x) = x/2 (x≤L/2),  (L−x)/2 (x≥L/2).
// Y la envolvente de un eje unitario móvil reproduce el pico de la LI.
import { Model } from './js/model/model.js';
import { buildLane, influenceLine, movingLoadEnvelope, responseReaction, responseSection, computeMovingLoad } from './js/solver/moving_load.js';

let fails = 0;
const ok  = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-6, `${m}  (${a.toFixed(4)} vs ${b.toFixed(4)})`);

globalThis.window = globalThis;
await import('./lib/numeric.js');
globalThis.window.numeric = globalThis.numeric;

const E = 3e7, I = 0.05, A = 0.4, L = 12, NEL = 6;

function makeBeam() {
  const m = new Model(); m.mode = '2D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'H', E, G: E / 2.4, nu: 0.2, rho: 0 });
  const sec = m.addSection({ name: 'V', A, Iy: I, Iz: I, J: 1e-3, Avy: 1e3, Avz: 1e3, kappay: 1, kappaz: 1 });
  const nodes = [];
  for (let i = 0; i <= NEL; i++) {
    const r = i === 0 ? { ux: 1, uz: 1 } : i === NEL ? { uz: 1 } : {};
    nodes.push(m.addNode(L * i / NEL, 0, 0, r));
  }
  const elems = [];
  for (let i = 0; i < NEL; i++) elems.push(m.addElement(nodes[i].id, nodes[i + 1].id, mat.id, sec.id));
  return { m, nodes, elems };
}

const M = makeBeam();
const lane = buildLane(M.m, M.elems.map(e => e.id));
ok(Math.abs(lane.L - L) < 1e-9, `pista de luz L = ${lane.L}`);

// ── LI de la reacción izquierda ──────────────────────────────────────────────
console.log('\n── Línea de influencia: reacción izquierda ──────────────');
const ilR = influenceLine(M.m, lane, responseReaction(M.nodes[0].id, 'Fz'), { nPos: 25 });
rel(ilR.value[0], 1, 1e-3, 'R(0) = 1 (carga sobre el apoyo)');
rel(ilR.value[ilR.value.length - 1], 0, 1e-3, 'R(L) = 0');
// linealidad: comparar cada muestra con 1 − x/L
let maxErr = 0; ilR.s.forEach((x, i) => { maxErr = Math.max(maxErr, Math.abs(ilR.value[i] - (1 - x / L))); });
ok(maxErr < 2e-3, `LI reacción ≡ 1 − x/L  (máx error ${maxErr.toExponential(2)})`);

// ── LI del momento en el centro de luz ───────────────────────────────────────
console.log('\n── Línea de influencia: momento en el centro ────────────');
// Momento en el centro (nodo x=L/2). Una carga puntual representada por cargas
// nodales consistentes contamina el momento DENTRO del elemento cargado (cupla
// consistente), inflándolo; el elemento contiguo NO cargado da el valor nodal
// exacto. Tomando la menor magnitud de los dos elementos adyacentes se elige
// siempre la lectura del lado no cargado → línea de influencia exacta.
const leftElem = M.elems[NEL / 2 - 1].id, rightElem = M.elems[NEL / 2].id;
const Mmid = (res) => { const a = res.getElemAtXi(leftElem, 1.0).Mz, b = res.getElemAtXi(rightElem, 0.0).Mz; return Math.abs(a) <= Math.abs(b) ? a : b; };
const ilM = influenceLine(M.m, lane, (res) => Math.abs(Mmid(res)), { nPos: 25 });
rel(ilM.max, L / 4, 0.02, 'pico de la LI de momento = L/4');
rel(ilM.sMax, L / 2, 0.05, 'el pico ocurre en x = L/2');
// forma triangular: en x=L/4 el valor teórico es L/8
const i14 = ilM.s.findIndex(x => Math.abs(x - L / 4) < 1e-6);
if (i14 >= 0) rel(ilM.value[i14], L / 8, 0.03, 'LI de momento en x=L/4 vale L/8 (rama lineal)');

// ── Envolvente de un eje unitario móvil ──────────────────────────────────────
console.log('\n── Envolvente (eje unitario móvil) ──────────────────────');
const env = movingLoadEnvelope(M.m, lane, [{ offset: 0, P: 1 }],
  { Mmid: (res) => Mmid(res), Rizq: responseReaction(M.nodes[0].id, 'Fz') },
  { nPos: 49 });
rel(Math.max(Math.abs(env.env.Mmid.max), Math.abs(env.env.Mmid.min)), L / 4, 0.03, 'envolvente |M_centro| máx = L/4');
rel(env.env.Rizq.max, 1, 1e-3, 'envolvente reacción máx = 1');

// ── Tren de 2 ejes: la respuesta escala y supera al eje único ────────────────
console.log('\n── Tren de 2 ejes (carga real) ──────────────────────────');
const env2 = movingLoadEnvelope(M.m, lane, [{ offset: 0, P: 100 }, { offset: 3, P: 100 }],
  { Mmid: (res) => Math.abs(Mmid(res)) }, { nPos: 81 });
ok(env2.env.Mmid.max > 100 * L / 4, `tren de 2 ejes da más momento que un eje  (${env2.env.Mmid.max.toFixed(1)} > ${(100 * L / 4).toFixed(1)})`);

// ── computeMovingLoad: la composición cfg→resultado que usa runMovingLoad ─────
// La misma física de arriba, pero por la ruta headless (build lane + probe + IL/env
// + moldeo del resultado), reproduciendo el shape que consume el panel.
console.log('\n── computeMovingLoad (composición headless) ─────────────');
{
  const laneIds = M.elems.map(e => e.id);
  // (a) IL de reacción por config → recta 1→0, pico 1 al inicio.
  const rIL = computeMovingLoad(M.m, { mode: 'il', nPos: 25, respType: 'reaction',
    nodeId: M.nodes[0].id, comp: 'Fz', label: 'RFz', unit: 'kN', laneIds });
  ok(rIL.mode === 'il' && rIL.xs.length === rIL.ys.length, 'IL: devuelve xs/ys alineados');
  rel(rIL.ys[0], 1, 1e-3, 'compute IL reacción: R(0)=1');
  rel(rIL.max, 1, 1e-3, 'compute IL reacción: máx=1');
  // (b) envolvente de un eje unitario sobre el momento del centro → pico L/4.
  const eEnv = computeMovingLoad(M.m, { mode: 'env', nPos: 49, respType: 'section',
    elemId: rightElem, xi: 0.0, key: 'Mz', label: 'Mmid', unit: 'kN·m',
    train: [{ offset: 0, P: 1 }], laneIds });
  ok(eEnv.mode === 'env' && Number.isFinite(eEnv.trainLen), 'env: incluye trainLen');
  rel(Math.max(Math.abs(eEnv.max), Math.abs(eEnv.min)), L / 4, 0.03, 'compute env |M_centro| máx = L/4');
}

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
