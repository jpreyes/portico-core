// build_arch_showcase.mjs — CASO COMPLETO en un puente en ARCO (bowstring 3D):
//   (1) análisis ESTÁTICO LINEAL,
//   (2) PANDEO LATERAL del arco (autovalores λcr, fuera del plano),
//   (3) ETAPAS CONSTRUCTIVAS (arco → tablero+péndolas → sobrecarga).
// Emite .s3d + 3 figuras + .md/.pdf.   node tools/build_arch_showcase.mjs
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { Model } from '../js/model/model.js';
import { Serializer } from '../js/model/serializer.js';
import { StaticSolver } from '../js/solver/static_solver.js';
import { StagedSolver } from '../js/solver/staged.js';
import { ensureNumeric } from './verif/runners.mjs';
import { buildNodeIndex, assembleK, assembleF, getNodeDOFs } from '../js/solver/assembler.js';
import { assembleKg } from '../js/solver/geometric.js';
import { solveBuckling } from '../js/solver/buckling.js';
import { renderModelSVG } from './verif/figure.mjs';

const ROOT = process.cwd();
const LOGOS = '';
const L = 100, N = 10, dx = L / N, rise = 20;
const zArch = (x) => rise * (1 - ((x - L / 2) / (L / 2)) ** 2);

// Apoyos: arranques con ux,uy,uz,rx fijos (articulación en el plano + restricción
// lateral-torsional); tablero interior con uy fijo (arriostramiento lateral del
// tablero) → el ARCO puede pandear fuera del plano (lateral).
const SPRING = { ux: 1, uy: 1, uz: 1, rx: 1 };
const DECK_LAT = { uy: 1 };

function build() {
  const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
  const st = m.addMaterial({ name: 'Acero', E: 2.0e8, G: 7.7e7, nu: 0.3, rho: 7.85 }).id;
  // arco: rígido en el plano (Iy grande), MÁS FLEXIBLE fuera del plano (Iz menor) → gobierna el pandeo lateral
  const sArch = m.addSection({ name: 'Arco (cajón)', A: 0.30, Iy: 0.12, Iz: 0.030, J: 0.05, Avy: 0.15, Avz: 0.15, kappay: 0.6, kappaz: 0.6 }).id;
  const sDeck = m.addSection({ name: 'Tablero (tirante)', A: 0.40, Iy: 0.05, Iz: 0.25, J: 0.10, Avy: 0.2, Avz: 0.2, kappay: 0.5, kappaz: 0.5 }).id;
  const sHang = m.addSection({ name: 'Péndola', A: 0.006, Iy: 1e-4, Iz: 1e-4, J: 1e-5, Avy: 0.003, Avz: 0.003, kappay: 0.9, kappaz: 0.9 }).id;
  // nodos
  const deck = [], arch = [];
  for (let i = 0; i <= N; i++) deck.push(m.addNode(i * dx, 0, 0, i === 0 || i === N ? SPRING : DECK_LAT));
  for (let i = 0; i <= N; i++) arch.push(i === 0 ? deck[0] : i === N ? deck[N] : m.addNode(i * dx, 0, zArch(i * dx)));
  const archEls = [], deckEls = [], hangEls = [];
  for (let i = 0; i < N; i++) archEls.push(m.addElement(arch[i].id, arch[i + 1].id, st, sArch).id);
  for (let i = 0; i < N; i++) deckEls.push(m.addElement(deck[i].id, deck[i + 1].id, st, sDeck).id);
  for (let i = 1; i < N; i++) hangEls.push(m.addElement(arch[i].id, deck[i].id, st, sHang).id);
  return { m, st, sArch, sDeck, sHang, deck, arch, archEls, deckEls, hangEls };
}

const fmt = (x, d = 2) => Number(x).toFixed(d);
const mdTable = (h, rows) => `| ${h.join(' | ')} |\n| ${h.map(() => '---').join(' | ')} |\n` + rows.map(r => `| ${r.join(' | ')} |`).join('\n') + '\n';

function figureFrom(m, dispOf, slug, amp01 = 0.12) {
  const nodes = new Map(), elements = [], supports = new Set();
  for (const nd of m.nodes.values()) { nodes.set(nd.id, [nd.x, nd.y, nd.z]); const r = nd.restraints; if (r && ((r.ux ? 1 : 0) + (r.uy ? 1 : 0) + (r.uz ? 1 : 0)) >= 2) supports.add(nd.id); }
  for (const e of m.elements.values()) elements.push({ n1: e.n1, n2: e.n2 });
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const c of nodes.values()) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], c[k]); mx[k] = Math.max(mx[k], c[k]); }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  let maxT = 0; const defo = new Map();
  for (const id of nodes.keys()) { const d = dispOf(id) || [0, 0, 0]; defo.set(id, d); maxT = Math.max(maxT, Math.hypot(d[0], d[1], d[2])); }
  const amp = maxT > 0 ? amp01 * diag / maxT : 0; const deformed = new Map();
  for (const [id, c] of nodes) { const d = defo.get(id); deformed.set(id, [c[0] + amp * d[0], c[1] + amp * d[1], c[2] + amp * d[2]]); }
  fs.mkdirSync(path.join(ROOT, 'docs/examples/img'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs/examples/img', `${slug}.svg`), renderModelSVG({ nodes, elements, deformed, supports, width: 900 }), 'utf8');
}

await ensureNumeric();
const num = globalThis.numeric;
const B = build(), m = B.m;

// ── (1) ESTÁTICO LINEAL ─────────────────────────────────────────────────────────
const lc = m.addLoadCase('PP + sobrecarga', true);
const wDeck = 60;   // kN/m sobre el tablero
for (const eid of B.deckEls) m.addLoad(lc.id, { type: 'dist', elemId: eid, dir: 'gravity', w: wDeck });
const resL = new StaticSolver().solve(m, lc.id, true);
const umaxL = resL.getMaxDisp();
let Narch = 0; for (const eid of B.archEls) { const f = resL.getElemForces(eid); if (f && f.N < Narch) Narch = f.N; }   // más comprimido
figureFrom(m, (id) => resL.getNodeDisp(id).slice(0, 3), 'arco_showcase_lineal');

// ── (2) PANDEO LATERAL (autovalores λcr) ────────────────────────────────────────
const ni = buildNodeIndex(m), nDOF = ni.size * 6;
const { K } = assembleK(m, ni);
const F = assembleF(m, ni, lc.id, true);
const freeDOF = [];
for (const nd of m.nodes.values()) { const d = getNodeDOFs(ni, nd.id), r = nd.restraints; [r.ux, r.uy, r.uz, r.rx, r.ry, r.rz].forEach((fx, li) => { if (!fx) freeDOF.push(d[li]); }); }
const nF = freeDOF.length;
const Kff2 = freeDOF.map(gi => freeDOF.map(gj => K[gi * nDOF + gj]));
const uf = num.solve(Kff2, freeDOF.map(gi => F[gi]));
const uRef = new Float64Array(nDOF); freeDOF.forEach((gi, i) => { uRef[gi] = uf[i]; });
const { Kg } = assembleKg(m, ni, uRef);
const Kff_flat = new Float64Array(nF * nF), Kgff_flat = new Float64Array(nF * nF);
for (let i = 0; i < nF; i++) for (let j = 0; j < nF; j++) { Kff_flat[i * nF + j] = K[freeDOF[i] * nDOF + freeDOF[j]]; Kgff_flat[i * nF + j] = Kg[freeDOF[i] * nDOF + freeDOF[j]]; }
const buck = solveBuckling({ Kff_flat, Kgff_flat, nF, nModes: 4 });
if (buck.error) throw new Error('Pandeo: ' + buck.error);
const lam1 = buck.modes[0].lambda;
// vector del 1er modo → desplazamientos nodales; ¿es lateral (uy domina)?
const phi = new Float64Array(nDOF); freeDOF.forEach((gi, i) => { phi[gi] = buck.modes[0].vec[i]; });
let maxUy = 0, maxUz = 0; for (const nd of m.nodes.values()) { const d = getNodeDOFs(ni, nd.id); maxUy = Math.max(maxUy, Math.abs(phi[d[1]])); maxUz = Math.max(maxUz, Math.abs(phi[d[2]])); }
const esLateral = maxUy > maxUz;
const Pcr = lam1 * Math.abs(Narch);   // carga axial crítica del arco (≈ λcr · N de referencia)
figureFrom(m, (id) => { const d = getNodeDOFs(ni, id); return [phi[d[0]], phi[d[1]], phi[d[2]]]; }, 'arco_showcase_pandeo', 0.18);

// ── (3) ETAPAS CONSTRUCTIVAS ────────────────────────────────────────────────────
// Etapa 1: se erige el ARCO (toma su peso propio). Etapa 2: se cuelgan el TABLERO y
// las PÉNDOLAS (nacen libres de tensión → no sienten la deformación del arco).
// Etapa 3: SOBRECARGA de tránsito.
const staged = new StagedSolver().solve(m, [
  { name: '1 · Arco (peso propio)', activate: B.archEls },
  { name: '2 · Tablero + péndolas', activate: [...B.deckEls, ...B.hangEls] },
  { name: '3 · Sobrecarga', loads: B.deckEls.map(eid => ({ type: 'dist', elemId: eid, dir: 'gravity', w: wDeck })) },
]);
const umaxS = staged.getMaxDisp();
let NarchS = 0; for (const eid of B.archEls) { const f = staged.getElemForces(eid); if (f && f.N < NarchS) NarchS = f.N; }
figureFrom(m, (id) => staged.getNodeDisp(id).slice(0, 3), 'arco_showcase_etapas');

// ── Guardar modelo + documento ──────────────────────────────────────────────────
fs.writeFileSync(path.join(ROOT, 'examples', 'puente_arco_showcase.s3d'), new Serializer().toJSON(m), 'utf8');
const md = `# Puente en arco — caso completo: lineal + pandeo lateral + etapas constructivas

**Tipo:** caso de estudio (3 análisis sobre un mismo arco) · **Modelo:** [\`examples/puente_arco_showcase.s3d\`](../../examples/puente_arco_showcase.s3d)

## Estructura

Arco atirantado (bowstring) **3D** de **${L} m de luz** y **${rise} m de flecha**: un **arco** (cajón de acero) del que cuelga un **tablero-tirante** por **péndolas** verticales. El arco es rígido en su plano (I_y grande) y **más flexible fuera del plano** (I_z menor), de modo que el modo crítico es el **pandeo lateral**. El tablero está **arriostrado lateralmente** (u_y fijo), así que el arco pandea fuera del plano sin que las péndolas (verticales) lo impidan.

## 1) Análisis estático lineal

Bajo peso propio + sobrecarga de ${wDeck} kN/m sobre el tablero:

${mdTable(['Magnitud', 'Valor'], [
  ['Desplazamiento máx. |u|', `${(umaxL * 1000).toFixed(1)} mm`],
  ['Axial máx. de compresión en el arco', `${Narch.toFixed(0)} kN`],
])}
![Deformada lineal](img/arco_showcase_lineal.svg)

*Figura 1. Deformada estática lineal (×escala): el arco comprime, el tablero-tirante tracciona y las péndolas cuelgan el tablero.*

## 2) Pandeo LATERAL del arco (autovalores λcr)

Sobre el estado de referencia anterior se ensambla la **rigidez geométrica** \`Kg\` y se resuelve el problema de autovalores **(K + λ·Kg)·φ = 0** (iteración de subespacio). El primer modo:

${mdTable(['Magnitud', 'Valor'], [
  ['Factor crítico de pandeo λcr', `${fmt(lam1, 2)}`],
  ['Naturaleza del 1er modo', esLateral ? '**LATERAL** (fuera del plano, u_y domina) ✔' : 'en el plano'],
  ['Carga axial crítica del arco P_cr ≈ λcr·N', `${Pcr.toFixed(0)} kN`],
  ['Modos calculados (λ)', buck.modes.map(b => fmt(b.lambda, 2)).join(', ')],
])}
![Modo de pandeo lateral](img/arco_showcase_pandeo.svg)

*Figura 2. Primer modo de pandeo: el arco se desplaza **fuera de su plano** (pandeo lateral). λcr indica cuántas veces la carga de referencia lleva al arco al pandeo. Un arco real necesita **arriostramiento lateral** entre arcos/vientos para subir λcr.*

## 3) Etapas constructivas

Secuencia de montaje (el estado se **acumula** por fase; los elementos nacen libres de tensión al activarse):

1. **Arco** — se erige y toma su **peso propio**.
2. **Tablero + péndolas** — se cuelgan (nacen en la geometría deformada del arco, sin tensión previa) y aportan su peso.
3. **Sobrecarga** de tránsito.

${mdTable(['Magnitud', 'Por etapas', 'Monolítico (lineal)'], [
  ['Desplazamiento máx. |u|', `${(umaxS * 1000).toFixed(1)} mm`, `${(umaxL * 1000).toFixed(1)} mm`],
  ['Axial máx. de compresión en el arco', `${NarchS.toFixed(0)} kN`, `${Narch.toFixed(0)} kN`],
])}
![Deformada por etapas](img/arco_showcase_etapas.svg)

*Figura 3. Estado acumulado al final de la construcción por etapas. Difiere del montaje monolítico porque el tablero/péndolas no participan del peso propio del arco (nacen después).*

## Conclusión

Un mismo puente en arco se analiza en **tres niveles**: (1) **estático lineal** (esfuerzos y deformaciones de servicio), (2) **pandeo lateral** (λcr = ${fmt(lam1, 2)}, modo fuera del plano → dimensiona el arriostramiento del arco), y (3) **etapas constructivas** (el orden de montaje cambia el estado final). Combina los motores de **estático**, **pandeo (Kg)** y **staged** de Pórtico en un caso realista.
`;
const mdPath = path.join(ROOT, 'docs/examples/puente_arco_showcase.md');
fs.writeFileSync(mdPath, md, 'utf8');
execFileSync('node', ['tools/md2pdf.mjs', path.relative(ROOT, mdPath), '--logos', LOGOS], { cwd: ROOT, stdio: 'ignore' });
console.log(`✓ puente_arco_showcase  ·  lineal umax=${(umaxL * 1000).toFixed(1)}mm Narch=${Narch.toFixed(0)}kN`);
console.log(`  pandeo λcr=${fmt(lam1, 2)} (${esLateral ? 'LATERAL' : 'en plano'}), λ=[${buck.modes.map(b => fmt(b.lambda, 2)).join(', ')}]`);
console.log(`  etapas umax=${(umaxS * 1000).toFixed(1)}mm Narch=${NarchS.toFixed(0)}kN`);
