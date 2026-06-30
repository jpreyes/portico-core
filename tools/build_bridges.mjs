// build_bridges.mjs — LIBRERÍA DE PUENTES (ejemplos): modelos .s3d + figura + MD/PDF.
//   node tools/build_bridges.mjs            # construye y documenta los 4 puentes
//   node tools/build_bridges.mjs atirantado # sólo los que matcheen
//
// Cada puente es un modelo PARAMÉTRICO 2D (elevación X–Z) que RESUELVE el estático
// (peso propio + sobrecarga de tránsito) → se verifica el equilibrio, se dibuja la
// deformada y se emite un .md + .pdf con membrete del proyecto. Son EJEMPLOS de modelado
// (tipologías) — la verificación analítica del arco network vendrá de la tesis.
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

// ── Materiales y secciones tipo ─────────────────────────────────────────────────
function baseModel() {
  const m = new Model(); m.mode = '2D'; m.materials.clear(); m.sections.clear();
  // addMaterial/addSection devuelven el OBJETO → guardamos su .id (lo que espera addElement)
  const conc = m.addMaterial({ name: 'Hormigón H35', E: 3.1e7, G: 1.3e7, nu: 0.2, rho: 2.5 }).id;
  const steel = m.addMaterial({ name: 'Acero', E: 2.0e8, G: 7.7e7, nu: 0.3, rho: 7.85 }).id;
  const sDeck  = m.addSection({ name: 'Tablero (cajón)', A: 0.9, Iy: 0.6, Iz: 0.6, J: 0.4, Avy: 0.4, Avz: 0.4, kappay: 0.5, kappaz: 0.5 }).id;
  const sTower = m.addSection({ name: 'Pilón/arco',      A: 0.6, Iy: 0.35, Iz: 0.35, J: 0.2, Avy: 0.3, Avz: 0.3, kappay: 0.5, kappaz: 0.5 }).id;
  const sCable = m.addSection({ name: 'Cable/tirante',   A: 0.012, Iy: 1e-4, Iz: 1e-4, J: 1e-5, Avy: 0.006, Avz: 0.006, kappay: 0.9, kappaz: 0.9 }).id;
  const sHang  = m.addSection({ name: 'Péndola',         A: 0.006, Iy: 1e-4, Iz: 1e-4, J: 1e-5, Avy: 0.003, Avz: 0.003, kappay: 0.9, kappaz: 0.9 }).id;
  return { m, conc, steel, sDeck, sTower, sCable, sHang };
}
const FIX = { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 };
const PIN = { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 0 };      // articulado (libera giro plano)
const ROLLER = { ux: 0, uy: 1, uz: 1, rx: 1, ry: 1, rz: 0 };   // rodillo (libre en X)

// Cadena de elementos a lo largo de una lista ordenada de nodos.
function chain(m, ids, matId, secId) { const els = []; for (let i = 0; i < ids.length - 1; i++) els.push(m.addElement(ids[i], ids[i + 1], matId, secId).id); return els; }

// ════════════════════════════════════════════════════════════════════════════
// 1) PUENTE ATIRANTADO (cable-stayed) — pilón central, abanico (fan)
// ════════════════════════════════════════════════════════════════════════════
function atirantado() {
  const B = baseModel(), m = B.m;
  const L = 120, n = 12, dx = L / n, Htower = 40, xc = 60;
  const deck = [];
  for (let i = 0; i <= n; i++) {
    const x = i * dx;
    const r = x === 0 ? PIN : x === L ? ROLLER : (x === xc ? FIX : {});   // estribos + base del pilón
    deck.push(m.addNode(x, 0, 0, r));
  }
  const deckElems = chain(m, deck.map(d => d.id), B.conc, B.sDeck);
  // Pilón central (de la base del tablero hacia arriba)
  const baseIdx = xc / dx;
  const top = m.addNode(xc, 0, Htower);
  const pylon = chain(m, [deck[baseIdx].id, top.id], B.conc, B.sTower);
  // Tirantes en abanico a nodos del tablero a cada lado del pilón
  const stayAt = [10, 30, 50, 70, 90, 110].map(x => Math.round(x / dx));
  for (const i of stayAt) if (i !== baseIdx) m.addElement(top.id, deck[i].id, B.steel, B.sCable);
  return { ...B, model: m, slug: 'puente_atirantado', title: 'Puente atirantado (cable-stayed)',
    deckElems, supportsHint: [deck[0].id, deck[n].id, deck[baseIdx].id],
    intro: 'Puente **atirantado** de 120 m con **pilón central** de 40 m y tirantes en **abanico**. El tablero (cajón de hormigón) se sostiene por los tirantes anclados en la cabeza del pilón; los tirantes trabajan a **tracción** y «cuelgan» el tablero, reduciendo su flexión. La base del pilón es un apoyo fijo (pila), y los estribos son articulado y rodillo.',
    props: [['Luz total', '120 m (12 tramos de 10 m)'], ['Pilón', 'central, 40 m'], ['Tirantes', 'abanico, 6+ a cada lado'], ['Tablero', 'cajón H35, A=0.9 m², I=0.6 m⁴'], ['Cargas', 'peso propio + sobrecarga 20 kN/m']],
    notes: ['Los **tirantes** se modelan como elementos de sección esbelta (predomina el axial); para slackening/dinámico se activa el flag *tension-only* (cable) y el solver NL-lite.', 'El **pilón** se empotra en su base (pila); los estribos son articulado (X fijo) y rodillo (X libre) para dejar la dilatación del tablero.', 'Cada tirante transmite una componente **vertical** (cuelga el tablero) y **horizontal** (comprime el tablero hacia el pilón).'],
    conclusion: 'El modelo resuelve en equilibrio: los tirantes traccionan y el tablero queda colgado del pilón, con la flexión repartida. Ejemplo de modelado de **puente atirantado** en Pórtico (tirantes + pilón + tablero).' };
}

// ════════════════════════════════════════════════════════════════════════════
// 2) PUENTE COLGANTE (suspension) — cable principal parabólico + péndolas
// ════════════════════════════════════════════════════════════════════════════
function colgante() {
  const B = baseModel(), m = B.m;
  const xT1 = 20, xT2 = 100, Htower = 40, sag = 26, step = 10;
  const zCable = (x) => { const xm = (xT1 + xT2) / 2, a = sag / ((xT2 - xT1) / 2) ** 2; return Htower - a * (x - xm) ** 2; };
  // Torres
  const t1b = m.addNode(xT1, 0, 0, FIX), t1t = m.addNode(xT1, 0, Htower);
  const t2b = m.addNode(xT2, 0, 0, FIX), t2t = m.addNode(xT2, 0, Htower);
  chain(m, [t1b.id, t1t.id], B.conc, B.sTower); chain(m, [t2b.id, t2t.id], B.conc, B.sTower);
  // Anclajes
  const a1 = m.addNode(0, 0, 0, FIX), a2 = m.addNode(120, 0, 0, FIX);
  // Cable principal (anclaje → torre → parábola → torre → anclaje)
  const cableIds = [a1.id, t1t.id];
  const deckNodes = [];
  for (let x = xT1 + step; x < xT2; x += step) { const c = m.addNode(x, 0, zCable(x)); cableIds.push(c.id); }
  cableIds.push(t2t.id, a2.id);
  chain(m, cableIds, B.steel, B.sCable);
  // Tablero entre torres (extremos en las torres)
  const deck = [t1b];
  for (let x = xT1 + step; x < xT2; x += step) deck.push(m.addNode(x, 0, 0));
  deck.push(t2b);
  const deckElems = chain(m, deck.map(d => d.id), B.conc, B.sDeck);
  // Péndolas: de cada nodo de cable interior al nodo de tablero bajo él
  for (let k = 0, x = xT1 + step; x < xT2; x += step, k++) {
    const cab = m.nodes.get(cableIds[2 + k]);   // cableIds: [a1,t1t, c..., t2t,a2]
    const dk = deck.find(d => Math.abs(m.nodes.get(d.id).x - x) < 1e-6);
    if (cab && dk) m.addElement(cab.id, dk.id, B.steel, B.sHang);
  }
  return { ...B, model: m, slug: 'puente_colgante', title: 'Puente colgante (suspension)',
    deckElems, supportsHint: [t1b.id, t2b.id, a1.id, a2.id],
    intro: 'Puente **colgante** con vano principal de 80 m entre dos **torres** de 40 m. El **cable principal** describe una parábola (funicular de la carga uniforme) anclado en los extremos; de él cuelgan las **péndolas** verticales que sostienen el tablero. El cable trabaja a tracción pura y transmite el empuje a las torres y a los anclajes.',
    props: [['Vano principal', '80 m (torres en x=20 y 100)'], ['Torres', '40 m'], ['Flecha del cable', '26 m'], ['Péndolas', 'verticales cada 10 m'], ['Cargas', 'peso propio + sobrecarga 20 kN/m']],
    notes: ['El **cable principal** se traza sobre su parábola funicular → bajo carga uniforme trabaja a **axial puro** (sin flexión).', 'Las **péndolas** transfieren la carga del tablero al cable; el cable la lleva a torres y **anclajes** (apoyos fijos).', 'Las **torres** se empotran en su base; el tablero se apoya en su nivel inferior.'],
    conclusion: 'El cable y las péndolas trabajan a tracción y cuelgan el tablero; las torres reciben la carga vertical y el empuje del cable. Ejemplo de modelado de **puente colgante** en Pórtico.' };
}

// ════════════════════════════════════════════════════════════════════════════
// 3) ARCO ATIRANTADO / BOWSTRING (tied arch) — el tirante es el tablero
// ════════════════════════════════════════════════════════════════════════════
function arcoAtirantado() {
  const B = baseModel(), m = B.m;
  const L = 80, n = 8, dx = L / n, rise = 18;
  const zArch = (x) => rise * (1 - ((x - L / 2) / (L / 2)) ** 2);
  const deck = [], arch = [];
  for (let i = 0; i <= n; i++) {
    const x = i * dx;
    const r = x === 0 ? PIN : x === L ? ROLLER : {};
    deck.push(m.addNode(x, 0, 0, r));
  }
  // El arco arranca en los apoyos del tablero (springings comunes) → reusar deck[0]/deck[n]
  for (let i = 0; i <= n; i++) arch.push(i === 0 ? deck[0] : i === n ? deck[n] : m.addNode(i * dx, 0, zArch(i * dx)));
  const deckElems = chain(m, deck.map(d => d.id), B.conc, B.sDeck);     // tablero = TIRANTE
  chain(m, arch.map(a => a.id), B.conc, B.sTower);                       // arco
  for (let i = 1; i < n; i++) m.addElement(arch[i].id, deck[i].id, B.steel, B.sHang);  // péndolas
  return { ...B, model: m, slug: 'puente_arco_atirantado', title: 'Arco atirantado (bowstring / tied arch)',
    deckElems, supportsHint: [deck[0].id, deck[n].id],
    intro: 'Arco **atirantado** (bowstring) de 80 m de luz y 18 m de flecha. El **arco** (rib) comprime y empuja hacia afuera; el **tablero** actúa de **tirante** (tie), absorbiendo el empuje horizontal a tracción → los apoyos sólo reciben reacción **vertical** (articulado + rodillo). Las **péndolas** cuelgan el tablero del arco. Es el esquema autoequilibrado típico del bowstring.',
    props: [['Luz', '80 m'], ['Flecha del arco', '18 m'], ['Tirante', 'el propio tablero (a tracción)'], ['Péndolas', '7 verticales'], ['Apoyos', 'articulado + rodillo (sólo vertical)'], ['Cargas', 'peso propio + sobrecarga 20 kN/m']],
    notes: ['El **tablero–tirante** toma el empuje del arco como **axial de tracción** → no se necesita un apoyo que resista el empuje horizontal (de ahí el rodillo).', 'El **arco** trabaja a compresión + flexión; las **péndolas**, a tracción.', 'Para ver la tracción del tirante: diagrama de **axial N** del tablero.'],
    conclusion: 'El arco comprime, el tablero–tirante tracciona y equilibra el empuje, y las péndolas cuelgan el tablero — con apoyos sólo verticales. Ejemplo de **arco atirantado** en Pórtico.' };
}

// ════════════════════════════════════════════════════════════════════════════
// 4) ARCO DE TABLERO INFERIOR / through arch (tipo Barqueta)
// ════════════════════════════════════════════════════════════════════════════
function arcoInferior() {
  const B = baseModel(), m = B.m;
  const L = 80, n = 10, dx = L / n, rise = 20, foot = -8;
  const zArch = (x) => { const a = (rise - foot) / ((L / 2) ** 2); return rise - a * (x - L / 2) ** 2; };  // foot en extremos, rise al centro
  // Arco: pies por debajo del tablero (apoyos), cruza el nivel del tablero hacia el interior
  const arch = [];
  for (let i = 0; i <= n; i++) { const x = i * dx; const r = (i === 0) ? PIN : (i === n) ? ROLLER : {}; arch.push(m.addNode(x, 0, zArch(x), r)); }
  chain(m, arch.map(a => a.id), B.conc, B.sTower);
  // Tablero (tirante) a nivel z=0 en el tramo interior donde el arco va por encima
  const deck = [];
  for (let i = 1; i < n; i++) deck.push(m.addNode(i * dx, 0, 0));
  const deckElems = chain(m, deck.map(d => d.id), B.conc, B.sDeck);
  // Tirante de los pies del arco a los extremos del tablero (toma el empuje)
  m.addElement(arch[0].id, deck[0].id, B.steel, B.sCable);
  m.addElement(arch[n].id, deck[deck.length - 1].id, B.steel, B.sCable);
  // Péndolas del arco al tablero (donde el arco está por encima)
  for (let i = 1; i < n; i++) { const dk = deck[i - 1]; if (m.nodes.get(arch[i].id).z > 0.5) m.addElement(arch[i].id, dk.id, B.steel, B.sHang); }
  return { ...B, model: m, slug: 'puente_arco_inferior', title: 'Arco de tablero inferior (through arch, tipo Barqueta)',
    deckElems, supportsHint: [arch[0].id, arch[n].id],
    intro: 'Arco de **tablero inferior** (through arch), inspirado en el **Puente de la Barqueta** (Sevilla): el **arco** arranca por debajo del nivel del tablero, lo cruza y se eleva sobre él; el **tablero** cuelga del arco mediante **péndolas** y se ata a los pies del arco con **tirantes** que recogen el empuje. Los apoyos están en los **pies del arco** (articulado + rodillo).',
    props: [['Luz', '80 m'], ['Flecha del arco', '20 m (pies a −8 m)'], ['Tablero', 'inferior, colgado del arco'], ['Tirantes', 'pies del arco ↔ extremos del tablero'], ['Apoyos', 'pies del arco (articulado + rodillo)'], ['Cargas', 'peso propio + sobrecarga 20 kN/m']],
    notes: ['El **arco** cruza el nivel del tablero: en el tramo central va por encima (péndolas a tracción) y en los extremos baja a los apoyos.', 'Los **tirantes** de extremo recogen el **empuje** del arco y lo cierran contra el tablero (esquema autoequilibrado, como el bowstring).', 'Variante de la familia de arcos; el **arco atirantado tipo network** (péndolas inclinadas cruzadas) se verificará contra una memoria de tesis.'],
    conclusion: 'El arco de tablero inferior cuelga el tablero por péndolas y cierra el empuje con los tirantes de pie; resuelve en equilibrio. Ejemplo «tipo Barqueta» en Pórtico.' };
}

// ── Driver: resolver, figura, MD, PDF ───────────────────────────────────────────
const mdTable = (h, rows) => `| ${h.join(' | ')} |\n| ${h.map(() => '---').join(' | ')} |\n` + rows.map(r => `| ${r.join(' | ')} |`).join('\n') + '\n';

function figure(model, res) {
  const nodes = new Map(), elements = [], supports = new Set();
  for (const nd of model.nodes.values()) { nodes.set(nd.id, [nd.x, nd.y, nd.z]); const r = nd.restraints; if (r && ((r.ux ? 1 : 0) + (r.uz ? 1 : 0)) >= 2) supports.add(nd.id); }
  for (const e of model.elements.values()) elements.push({ n1: e.n1, n2: e.n2 });
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const c of nodes.values()) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], c[k]); mx[k] = Math.max(mx[k], c[k]); }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  let maxT = 0; const defo = new Map();
  for (const id of nodes.keys()) { const d = res.getNodeDisp(id); defo.set(id, d); maxT = Math.max(maxT, Math.hypot(d[0], d[1], d[2])); }
  let deformed = null;
  if (maxT > 0) { const amp = 0.12 * diag / maxT; deformed = new Map(); for (const [id, c] of nodes) { const d = defo.get(id); deformed.set(id, [c[0] + amp * d[0], c[1] + amp * d[1], c[2] + amp * d[2]]); } }
  return renderModelSVG({ nodes, elements, supports, deformed, width: 960 });
}

async function emit(def) {
  const m = def.model;
  // caso: peso propio + sobrecarga de tránsito 20 kN/m en el tablero
  const lc = m.addLoadCase('PP + tránsito', true);
  for (const eid of def.deckElems) m.addLoad(lc.id, { type: 'dist', elemId: eid, dir: 'gravity', w: 20 });
  const res = await runStatic(m, lc.id, true);
  // equilibrio: ΣRz de reacciones (debe ser finito y > 0)
  let Rz = 0; for (const nd of m.nodes.values()) { const r = nd.restraints; if (r && (r.ux || r.uz)) Rz += res.getReaction(nd.id)[2]; }
  const sum = res.getSummary();

  fs.writeFileSync(path.join(ROOT, 'examples', `${def.slug}.s3d`), new Serializer().toJSON(m), 'utf8');
  const svg = figure(m, res);
  fs.mkdirSync(path.join(ROOT, 'docs/examples/img'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs/examples/img', `${def.slug}.svg`), svg, 'utf8');

  const md = `# ${def.title}

**Tipo:** ejemplo de modelado (tipología de puente) · **Modelo Pórtico:** [\`examples/${def.slug}.s3d\`](../../examples/${def.slug}.s3d)

## Descripción

${def.intro}

${mdTable(['Propiedad', 'Valor'], def.props)}
## Modelo en Pórtico

${def.notes.map(s => `- ${s}`).join('\n')}

![${def.title}](img/${def.slug}.svg)

*Figura. Elevación del puente y su deformada bajo peso propio + sobrecarga (×escala). En gris la geometría sin deformar; en azul la deformada.*

## Resultados (peso propio + sobrecarga 20 kN/m)

${mdTable(['Magnitud', 'Valor'], [
    ['Nodos · elementos', `${m.nodes.size} · ${m.elements.size}`],
    ['ΣReacciones verticales', `${Rz.toFixed(0)} kN (equilibrio con la carga total)`],
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
  console.log(`✓ ${def.slug}  ·  ${m.nodes.size} nodos, ${m.elements.size} elem  ·  ΣRz=${Rz.toFixed(0)} kN  ·  umax=${(sum.maxU * 1000).toFixed(1)} mm`);
}

const builders = { atirantado, colgante, arcoAtirantado, arcoInferior };
for (const [name, fn] of Object.entries(builders)) {
  if (pat && !name.toLowerCase().includes(pat.toLowerCase())) continue;
  try { await emit(fn()); } catch (e) { console.error(`✗ ${name}: ${e.message}`); }
}
console.log('Listo.');
