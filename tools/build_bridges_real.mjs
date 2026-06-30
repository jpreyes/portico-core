// build_bridges_real.mjs — PUENTES REALES (geometría investigada): Salginatobel,
// Golden Gate, Severin (Severinsbrücke) y Cau Cau (Treng Treng / Kay Kay, Valdivia).
// Modelos 2D paramétricos que resuelven en equilibrio → .s3d + figura + .md/.pdf.
//   node tools/build_bridges_real.mjs [patrón]
//
// Fuentes de dimensiones (ver el .md de cada puente): Wikipedia/Structurae/MOP.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { Model } from '../js/model/model.js';
import { Serializer } from '../js/model/serializer.js';
import { runStatic } from './verif/runners.mjs';
import { renderModelSVG } from './verif/figure.mjs';

const ROOT = process.cwd();
const LOGOS = '';
const pat = process.argv[2] || '';

function baseModel() {
  const m = new Model(); m.mode = '2D'; m.materials.clear(); m.sections.clear();
  const conc  = m.addMaterial({ name: 'Hormigón', E: 3.0e7, G: 1.25e7, nu: 0.2, rho: 2.5 }).id;
  const steel = m.addMaterial({ name: 'Acero', E: 2.0e8, G: 7.7e7, nu: 0.3, rho: 7.85 }).id;
  const sDeck  = m.addSection({ name: 'Tablero',      A: 1.0, Iy: 2.0, Iz: 2.0, J: 0.8, Avy: 0.4, Avz: 0.4, kappay: 0.5, kappaz: 0.5 }).id;
  const sArch  = m.addSection({ name: 'Arco/torre',   A: 0.7, Iy: 0.4, Iz: 0.4, J: 0.25, Avy: 0.35, Avz: 0.35, kappay: 0.5, kappaz: 0.5 }).id;
  // Cables grandes (A realista de puentes de gran luz) + algo de I transversal para
  // estabilidad del análisis LINEAL (un cable real toma rigidez transversal de la
  // tracción → análisis geométrico/NL; aquí se modela lineal con I moderada).
  const sCable = m.addSection({ name: 'Cable',        A: 0.6, Iy: 400, Iz: 400, J: 8, Avy: 0.25, Avz: 0.25, kappay: 0.9, kappaz: 0.9 }).id;
  const sHang  = m.addSection({ name: 'Péndola',      A: 0.03, Iy: 5e-3, Iz: 5e-3, J: 1e-3, Avy: 0.015, Avz: 0.015, kappay: 0.9, kappaz: 0.9 }).id;
  return { m, conc, steel, sDeck, sArch, sCable, sHang };
}
// Apoyos 2D (uy, rx, rz los fija el modo 2D):
const PINF = { ux: 1, uz: 1, ry: 1 };   // empotrado en el plano
const PIN  = { ux: 1, uz: 1 };          // articulado (ry libre)
const ROLL = { uz: 1 };                 // rodillo (ux, ry libres)
const chain = (m, ids, mat, sec) => { const e = []; for (let i = 0; i < ids.length - 1; i++) e.push(m.addElement(ids[i], ids[i + 1], mat, sec).id); return e; };
const hinge = (m, eid, atJ) => { const e = m.elements.get(eid); const o = atJ ? 6 : 0; e.releases[o + 3] = 1; e.releases[o + 4] = 1; e.releases[o + 5] = 1; };

// ════════════════════════════════════════════════════════════════════════════
// 1) SALGINATOBEL (Maillart, 1930) — arco de H.A. de TRES RÓTULAS
//    Luz 90 m, flecha 13 m, tablero 3.5 m; cajón hueco en la zona central.
// ════════════════════════════════════════════════════════════════════════════
function salginatobel() {
  const B = baseModel(), m = B.m;
  const L = 90, n = 12, dx = L / n, rise = 13, zd = 13;
  const zArch = (x) => rise * (1 - ((x - L / 2) / (L / 2)) ** 2);
  const arch = [], deck = [];
  for (let i = 0; i <= n; i++) arch.push(m.addNode(i * dx, 0, zArch(i * dx), i === 0 || i === n ? PIN : {}));  // rótulas de arranque = articuladas
  for (let i = 0; i <= n; i++) deck.push(m.addNode(i * dx, 0, zd));
  const aEl = chain(m, arch.map(a => a.id), B.conc, B.sArch);
  chain(m, deck.map(d => d.id), B.conc, B.sDeck);
  // montantes (spandrel) tablero↔arco donde hay separación
  for (let i = 0; i <= n; i++) if (zd - zArch(i * dx) > 0.3) m.addElement(deck[i].id, arch[i].id, B.conc, B.sArch);
  // RÓTULA de clave: liberar el momento en el extremo j del elemento que llega a la clave
  hinge(m, aEl[n / 2 - 1], true);
  // apoyos del tablero en los estribos (sobre las rótulas de arranque, vía montante)
  return { ...B, model: m, slug: 'salginatobel', title: 'Puente Salginatobel (Maillart, 1930) — arco de hormigón de tres rótulas',
    deckElems: chain.length ? null : null, deckChain: deck.map(d => d.id), supportsHint: [arch[0].id, arch[n].id],
    udlElems: 'deck',
    intro: 'El **Salginatobel** (Robert Maillart, 1930, Suiza) es un **arco de hormigón armado de tres rótulas** (rótulas en los dos arranques y en la clave) de **90 m de luz** y **13 m de flecha**, con tablero de 3.5 m de ancho. Sobre la zona central el arco y el tablero se funden en una **viga cajón hueca**; hacia los extremos, montantes (spandrels) conectan el tablero con el arco. Es una obra maestra del hormigón y Monumento Histórico de la Ingeniería (ASCE).',
    props: [['Luz del arco', '90 m'], ['Flecha', '13 m'], ['Longitud total', '133 m'], ['Ancho del tablero', '3.5 m'], ['Tipo', 'arco H.A. de tres rótulas (cajón hueco central)'], ['Año / autor', '1930 / Robert Maillart']],
    notes: ['Las **tres rótulas** (dos arranques + clave) se modelan: arranques como **apoyos articulados** (giro libre) y la clave **liberando el momento** en el extremo de un elemento del arco.', 'Los **montantes** transfieren la carga del tablero al arco; en el centro arco y tablero se unen (cajón).', 'El arco trabaja esencialmente a **compresión**; el tablero reparte la sobrecarga.'],
    conclusion: 'El arco de tres rótulas reproduce la forma y el comportamiento del Salginatobel: compresión dominante en el arco, montantes que cuelgan/apoyan el tablero, y rótulas que lo hacen isostático en su esquema básico. Ejemplo de **arco de hormigón** en Pórtico.' };
}

// ════════════════════════════════════════════════════════════════════════════
// 2) GOLDEN GATE (1937) — puente COLGANTE
//    Vano principal 1280 m, vanos laterales 343 m, torres ~152 m sobre tablero,
//    flecha del cable ~143 m, ancho 27 m.
// ════════════════════════════════════════════════════════════════════════════
function goldenGate() {
  const B = baseModel(), m = B.m;
  const Lc = 1280, Ls = 343, Ht = 152, sag = 143, step = 80;
  const xL = Ls, xR = Ls + Lc;               // torres
  // Cable COLGANTE: alto (Ht) en las torres, mínimo (Ht−sag) en el centro → parábola
  // cóncava hacia arriba (cuelga). z(x) = Ht − sag·(1 − ((x−xm)/(Lc/2))²).
  const zCable = (x) => { const xm = (xL + xR) / 2; return Ht - sag * (1 - ((x - xm) / (Lc / 2)) ** 2); };
  // Torres (de tablero z=0 hacia arriba; base bajo el tablero empotrada)
  const tLb = m.addNode(xL, 0, -20, PINF), tLt = m.addNode(xL, 0, Ht);
  const tRb = m.addNode(xR, 0, -20, PINF), tRt = m.addNode(xR, 0, Ht);
  chain(m, [tLb.id, m.addNode(xL, 0, 0).id, tLt.id], B.conc, B.sArch);
  chain(m, [tRb.id, m.addNode(xR, 0, 0).id, tRt.id], B.conc, B.sArch);
  // Anclajes del cable
  const aL = m.addNode(0, 0, 0, PINF), aR = m.addNode(xR + Ls, 0, 0, PINF);
  // Cable principal: anclaje → torre → parábola del vano central → torre → anclaje
  const cab = [aL.id, tLt.id];
  for (let x = xL + step; x < xR; x += step) cab.push(m.addNode(x, 0, zCable(x)).id);
  cab.push(tRt.id, aR.id);
  chain(m, cab, B.steel, B.sCable);
  return finishSuspension(B, m, { xL, xR, Ht, step, zCable, cab, tLt, tRt, tLb, tRb },
    'puente_golden_gate', 'Puente Golden Gate (1937) — colgante',
    'El **Golden Gate** (San Francisco, 1937) es un **puente colgante** de **1280 m de vano principal** y vanos laterales de **343 m**, con **torres de ~152 m sobre el tablero** y **cable principal** de flecha ~143 m. Dos cables principales sostienen el tablero (ancho ~27 m) por péndolas verticales y transmiten el empuje a torres y **anclajes** masivos.',
    [['Vano principal', '1280 m'], ['Vanos laterales', '343 m c/u'], ['Altura de torres', '~227 m sobre el agua (~152 m sobre el tablero)'], ['Flecha del cable', '~143 m'], ['Ancho', '27 m'], ['Año', '1937']],
    'Ejemplo del puente colgante de mayor luz de su época: cable funicular a tracción, péndolas que cuelgan el tablero, torres y anclajes.');
}
// helper de colgantes (Golden Gate): arma el tablero entre torres + péndolas
function finishSuspension(B, m, P, slug, title, intro, props, conclusion) {
  const { xL, xR, step, zCable, cab, tLt, tRt, tLb, tRb } = P;
  const deck = [];
  for (let x = xL; x <= xR + 1e-6; x += step) deck.push(m.addNode(x, 0, 0, x === xL || x === xR ? {} : {}));
  // apoyar el tablero en las bases de torre (a nivel tablero) en los extremos
  const deckIds = deck.map(d => d.id);
  // unir extremos del tablero a las torres (a nivel z=0): elemento corto vertical a la torre
  const deckElems = chain(m, deckIds, B.conc, B.sDeck);
  // péndolas: de cada nodo de cable interior al nodo de tablero bajo él
  // cab = [aL, tLt, c1..ck, tRt, aR]; los interiores c están en x=xL+step..xR-step
  let k = 2;
  for (let x = xL + step; x < xR - 1e-6; x += step, k++) {
    const cabNode = cab[k];
    const dk = deck.find(d => Math.abs(m.nodes.get(d.id).x - x) < 1e-6);
    if (cabNode != null && dk) m.addElement(cabNode, dk.id, B.steel, B.sHang);
  }
  // soporte del tablero: articulado en un extremo (fija X) y rodillo en el otro
  m.updateNode(deckIds[0], { restraints: PIN });
  m.updateNode(deckIds[deckIds.length - 1], { restraints: ROLL });
  // conectar extremos del tablero a la base de la torre (rigidez vertical/horizontal)
  m.addElement(deckIds[0], tLb.id, B.conc, B.sArch);
  m.addElement(deckIds[deckIds.length - 1], tRb.id, B.conc, B.sArch);
  return { ...B, model: m, slug, title, deckChain: deckIds, udlElems: 'deck', supportsHint: [tLb.id, tRb.id],
    intro, props,
    notes: ['El **cable principal** sigue su parábola funicular (tracción pura bajo carga uniforme) y se ancla en los extremos.', 'Las **péndolas** verticales cuelgan el tablero del cable; las **torres** llevan la carga a las fundaciones.', 'En 2D se modela un plano; el puente real tiene dos cables/planos.', '⚠️ **Modelo lineal:** un cable real toma su rigidez transversal de la **tracción** (rigidización geométrica). Aquí el cable se modela con rigidez a flexión para un análisis lineal estable; para resultados precisos use el **análisis geométrico/no lineal** (Kg / NL-lite) de Pórtico — las flechas del modelo lineal son mayores que las reales.'],
    conclusion };
}

// ════════════════════════════════════════════════════════════════════════════
// 3) SEVERIN / Severinsbrücke (Colonia, 1959) — ATIRANTADO asimétrico, pilón en A
//    Vano principal 302 m, pilón ~77 m sobre el tablero, abanico (fan).
// ════════════════════════════════════════════════════════════════════════════
function severin() {
  const B = baseModel(), m = B.m;
  const Lmain = 302, Lback = 151, Hp = 77, step = 302 / 14;   // ~21.6 m
  const x0 = 0;                          // pilón en una orilla
  // tablero desde el anclaje posterior (-Lback) hasta el final del vano principal (+Lmain)
  const xs = [];
  for (let x = -Lback; x <= Lmain + 1e-6; x += step) xs.push(+x.toFixed(3));
  if (xs[xs.length - 1] < Lmain - 1e-6) xs.push(Lmain);
  const deck = xs.map((x, i) => m.addNode(x, 0, 0, x <= -Lback + 1e-6 ? PIN : (Math.abs(x - Lmain) < 1e-6 ? ROLL : {})));
  const deckElems = chain(m, deck.map(d => d.id), B.conc, B.sDeck);
  // pilón en A: en 2D un mástil sobre el tablero, base empotrada bajo el tablero
  const pBase = m.addNode(x0, 0, -15, PINF);
  const pTop = m.addNode(x0, 0, Hp);
  const pierTop = deck.find(d => Math.abs(m.nodes.get(d.id).x - x0) < step / 2) || deck[0];
  chain(m, [pBase.id, pierTop.id, pTop.id], B.conc, B.sArch);
  // tirantes en abanico (fan) a ambos lados del pilón
  for (const d of deck) {
    const x = m.nodes.get(d.id).x;
    if (Math.abs(x - x0) < step / 2) continue;
    if (x > x0 + step || x < x0 - step) m.addElement(pTop.id, d.id, B.steel, B.sCable);
  }
  return { ...B, model: m, slug: 'puente_severin', title: 'Puente Severin / Severinsbrücke (Colonia, 1959) — atirantado en abanico',
    deckChain: deck.map(d => d.id), udlElems: 'deck', supportsHint: [deck[0].id, pBase.id, deck[deck.length - 1].id],
    intro: 'La **Severinsbrücke** (Colonia, 1959) fue el primer puente **atirantado con pilón en forma de A** y, en su época, el de mayor vano principal (**302 m**). El **pilón** se eleva ~77 m sobre el tablero en una orilla; los **tirantes** parten de su cabeza en **abanico (fan)** sosteniendo el tablero del vano principal, con un vano posterior anclado que equilibra.',
    props: [['Vano principal', '302 m'], ['Vano posterior', '~151 m (equilibrio)'], ['Pilón (A)', '~77 m sobre el tablero'], ['Sistema', 'atirantado en abanico (fan), asimétrico'], ['Longitud total', '691 m'], ['Año', '1959']],
    notes: ['Asimétrico: el **vano posterior anclado** equilibra el tirón del vano principal sobre el pilón.', 'El **pilón en A** se representa en 2D como un mástil; los tirantes nacen de su cabeza.', 'Los **tirantes** trabajan a tracción y «cuelgan» el tablero reduciendo su flexión.', '⚠️ **Modelo lineal:** los tirantes se modelan con rigidez a flexión para estabilidad lineal; para precisión use el análisis **geométrico/no lineal** (Kg / NL-lite) de Pórtico.'],
    conclusion: 'El modelo reproduce el esquema atirantado asimétrico de la Severinsbrücke: pilón alto en una orilla, abanico de tirantes sobre el vano principal y vano posterior de equilibrio. Ejemplo de **atirantado en abanico** en Pórtico.' };
}

// ════════════════════════════════════════════════════════════════════════════
// 4) TRENG TRENG – KAY KAY (Temuco, río Cautín) — ATIRANTADO asimétrico, mástil único
//    240 m en 5 vanos 23/27/140/27/23; vano atirantado central 140 m; mástil 70 m.
// ════════════════════════════════════════════════════════════════════════════
function trengTreng() {
  const B = baseModel(), m = B.m;
  const spans = [23, 27, 140, 27, 23];
  const xs = [0]; for (const s of spans) xs.push(xs[xs.length - 1] + s);   // 0,23,50,190,217,240
  const xMast = xs[2];   // 50 — el mástil arranca al inicio del vano atirantado de 140 m
  const Hp = 70;
  // nodos de tablero: pilas + nodos intermedios (anclaje de tirantes en el vano de 140 m)
  const set = new Set(xs);
  for (let x = xs[2] + 14; x < xs[3]; x += 14) set.add(+x.toFixed(2));   // anclajes ~cada 14 m en el vano principal
  for (const x of [11.5, 36.5, 203.5, 228.5]) set.add(x);                 // un nodo medio en los vanos de aproximación
  const uniq = [...set].sort((a, b) => a - b);
  const node = new Map();
  for (const x of uniq) {
    const isPier = xs.some(p => Math.abs(p - x) < 1e-6);
    const r = isPier ? (Math.abs(x) < 1e-6 ? PIN : ROLL) : {};   // pilas: apoyos verticales
    node.set(x, m.addNode(x, 0, 0, r).id);
  }
  const ids = uniq.map(x => node.get(x));
  chain(m, ids, B.conc, B.sDeck);
  // mástil único en x=50 (base empotrada bajo el tablero → cabeza a 70 m)
  const mBase = m.addNode(xMast, 0, -12, PINF);
  const mTop = m.addNode(xMast, 0, Hp);
  chain(m, [mBase.id, node.get(xMast), mTop.id], B.conc, B.sArch);
  // tirantes en abanico: al vano principal (x>50) y retenidas al vano de aproximación (x<50)
  for (const x of uniq) {
    if (x <= xMast + 7) continue;                     // saltar el propio mástil y el vecino
    if (x > xMast && x <= xs[3]) m.addElement(mTop.id, node.get(x), B.steel, B.sCable);   // abanico del vano principal
  }
  for (const x of [0, 23, 36.5]) if (node.has(x)) m.addElement(mTop.id, node.get(x), B.steel, B.sCable);   // retenidas (back-stays)
  return { ...B, model: m, slug: 'puente_treng_treng', title: 'Puente Treng Treng – Kay Kay (Temuco) — atirantado asimétrico de mástil único',
    deckChain: ids, udlElems: 'deck', supportsHint: [node.get(0), mBase.id, node.get(240)],
    intro: 'El **Puente Treng Treng – Kay Kay** (Temuco, sobre el **río Cautín**) es un **puente atirantado asimétrico** con un **único mástil de 70 m** que sostiene el vano atirantado central de **140 m**. Tiene **240 m** en 5 vanos (23 / 27 / **140** / 27 / 23 m) y tablero de hormigón pretensado de 27 m de ancho. La forma quebrada del mástil evoca la leyenda mapuche de las serpientes **Treng Treng** y **Kay Kay**. Los tirantes parten de la cabeza del mástil en **abanico** sobre el vano principal, con **retenidas** (back-stays) hacia los vanos de aproximación que equilibran.',
    props: [['Longitud total', '240 m (5 vanos)'], ['Vanos', '23 / 27 / 140 / 27 / 23 m'], ['Vano atirantado', '140 m'], ['Mástil', '70 m (único, asimétrico)'], ['Tablero', 'hormigón pretensado, 27 m de ancho'], ['Ubicación', 'Temuco, río Cautín, Chile (2023)']],
    notes: ['Atirantado **asimétrico**: los tirantes del vano principal se equilibran con **retenidas** ancladas en los vanos de aproximación (sobre las pilas).', 'El **mástil único** (en 2D un mástil; en realidad dos columnas quebradas unidas en la cabeza) ancla todos los tirantes en su coronación.', 'Las pilas de aproximación son **apoyos verticales**; el mástil se empotra en su base.', 'Los **tirantes** trabajan a tracción y cuelgan el tablero del vano de 140 m.'],
    conclusion: 'El modelo reproduce el esquema atirantado asimétrico del Treng Treng – Kay Kay de Temuco: mástil único, abanico de tirantes sobre el vano de 140 m y retenidas de equilibrio. Ejemplo de **atirantado asimétrico** (ícono de La Araucanía) en Pórtico.' };
}

// ── Driver ──────────────────────────────────────────────────────────────────────
const mdTable = (h, rows) => `| ${h.join(' | ')} |\n| ${h.map(() => '---').join(' | ')} |\n` + rows.map(r => `| ${r.join(' | ')} |`).join('\n') + '\n';

function figure(model, res) {
  const nodes = new Map(), elements = [], supports = new Set();
  for (const nd of model.nodes.values()) { nodes.set(nd.id, [nd.x, nd.y, nd.z]); const r = nd.restraints; if (r && ((r.ux ? 1 : 0) + (r.uz ? 1 : 0)) >= 1 && (r.ux || r.uz)) { if ((r.ux ? 1 : 0) + (r.uz ? 1 : 0) >= 1) supports.add(nd.id); } }
  for (const e of model.elements.values()) elements.push({ n1: e.n1, n2: e.n2 });
  const areas = [...model.areas.values()].map(a => a.nodes);
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const c of nodes.values()) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], c[k]); mx[k] = Math.max(mx[k], c[k]); }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  let maxT = 0; const defo = new Map();
  for (const id of nodes.keys()) { const d = res.getNodeDisp(id); defo.set(id, d); maxT = Math.max(maxT, Math.hypot(d[0], d[1], d[2])); }
  let deformed = null;
  if (maxT > 0) { const amp = 0.10 * diag / maxT; deformed = new Map(); for (const [id, c] of nodes) { const d = defo.get(id); deformed.set(id, [c[0] + amp * d[0], c[1] + amp * d[1], c[2] + amp * d[2]]); } }
  return renderModelSVG({ nodes, elements, areas, deformed, supports, width: 980 });
}

async function emit(def) {
  const m = def.model;
  const lc = m.addLoadCase('PP + sobrecarga', true);
  // UDL de sobrecarga sobre el tablero
  if (def.udlElems === 'deck' && def.deckChain) {
    const set = new Set(def.deckChain);
    for (const e of m.elements.values()) if (set.has(e.n1) && set.has(e.n2)) m.addLoad(lc.id, { type: 'dist', elemId: e.id, dir: 'gravity', w: 30 });
  }
  for (const nl of (def.nodalLoads || [])) m.addLoad(lc.id, { type: 'nodal', nodeId: nl.nodeId, F: [0, 0, nl.Fz, 0, 0, 0] });
  let res, Rz = 0;
  try { res = await runStatic(m, lc.id, true); } catch (e) { console.error(`✗ ${def.slug}: ${e.message}`); return; }
  for (const nd of m.nodes.values()) { const r = nd.restraints; if (r && (r.ux || r.uz)) Rz += res.getReaction(nd.id)[2]; }
  const sum = res.getSummary();

  fs.writeFileSync(path.join(ROOT, 'examples', `${def.slug}.s3d`), new Serializer().toJSON(m), 'utf8');
  fs.mkdirSync(path.join(ROOT, 'docs/examples/img'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs/examples/img', `${def.slug}.svg`), figure(m, res), 'utf8');

  const md = `# ${def.title}

**Tipo:** ejemplo de modelado con **geometría real** · **Modelo:** [\`examples/${def.slug}.s3d\`](../../examples/${def.slug}.s3d)

## Descripción

${def.intro}

${mdTable(['Propiedad', 'Valor'], def.props)}
## Modelo en Pórtico

${def.notes.map(s => `- ${s}`).join('\n')}

![${def.title}](img/${def.slug}.svg)

*Figura. Elevación y deformada bajo peso propio + sobrecarga (×escala). Gris: sin deformar; azul: deformada.*

## Resultados (peso propio + sobrecarga)

${mdTable(['Magnitud', 'Valor'], [
    ['Nodos · elementos · áreas', `${m.nodes.size} · ${m.elements.size} · ${m.areas.size}`],
    ['ΣReacciones verticales', `${Rz.toFixed(0)} kN`],
    ['Desplazamiento máx. |u|', `${(sum.maxU * 1000).toFixed(1)} mm`],
    ['Axial máx. |N|', `${sum.maxN.toFixed(0)} kN`],
    ['Momento máx. |M|', `${sum.maxM.toFixed(0)} kN·m`],
  ])}
## Conclusión

${def.conclusion}
`;
  const mdPath = path.join(ROOT, 'docs/examples', `${def.slug}.md`);
  fs.writeFileSync(mdPath, md, 'utf8');
  execFileSync('node', ['tools/md2pdf.mjs', path.relative(ROOT, mdPath), '--logos', LOGOS], { cwd: ROOT, stdio: 'ignore' });
  console.log(`✓ ${def.slug}  ·  ${m.nodes.size} nodos, ${m.elements.size} elem  ·  ΣRz=${Rz.toFixed(0)} kN  ·  umax=${(sum.maxU * 1000).toFixed(1)} mm  ·  Nmax=${sum.maxN.toFixed(0)} kN`);
}

const builders = { salginatobel, goldenGate, severin, trengTreng };
for (const [name, fn] of Object.entries(builders)) {
  if (pat && !name.toLowerCase().includes(pat.toLowerCase())) continue;
  try { await emit(fn()); } catch (e) { console.error(`✗ ${name}: ${e.message}`); }
}
console.log('Listo.');
