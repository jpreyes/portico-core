// build_valdivia_walls.mjs — TUTORIAL 2: edificio 5 pisos en Valdivia basado en
// MUROS de hormigón (elementos MEMBRANA/shell) con LOSAS de entrepiso (elementos
// PLACA/shell). Construye el .s3d, corre el MODAL headless (con áreas), calcula el
// espectro NCh433/DS61 y emite el tutorial .md → .pdf.
//   node tools/build_valdivia_walls.mjs
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { Model } from '../js/model/model.js';
import { Serializer } from '../js/model/serializer.js';
import { runModal } from './verif/runners.mjs';
import { renderModelSVG } from './verif/figure.mjs';

const ROOT = process.cwd();
const LOGOS = '';

// ── Geometría ─────────────────────────────────────────────────────────────────
const NX = 6, NY = 5, NS = 5, dxg = 3, dyg = 3, H = 3;   // planta 18×15 m, 5 pisos de 3 m
const Lx = NX * dxg, Ly = NY * dyg;
const tSlab = 0.20, tWall = 0.25;
const E = 2.57e7, rho = 2.5;   // H30
const Dsup = 3.0, Lvar = 2.0;  // sobrecarga muerta (terminaciones) + viva [kN/m²]

// ── Espectro NCh433/DS61 (Valdivia, Zona 2, Suelo D) ────────────────────────────
const A0 = 0.30, SOIL = { tipo: 'D', S: 1.20, T0: 0.75, Tp: 0.85, n: 1.80, p: 1.0 }, R = 7, R0 = 11, I = 1.0;
const alpha = (T) => (1 + 4.5 * (T / SOIL.T0) ** SOIL.p) / (1 + (T / SOIL.T0) ** 3);
const Rstar = (T) => 1 + T / (0.10 * SOIL.T0 + T / R0);
const Sa = (T) => SOIL.S * A0 * alpha(T) / Rstar(T);

const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
// Material de las áreas con rho=0 (sin masa) → la masa sísmica se concentra en los
// diafragmas de piso (modos laterales limpios; práctica habitual de masa por piso).
const mat = m.addMaterial({ name: 'Hormigón H30', E, G: E / 2.4, nu: 0.2, rho: 0 }).id;

// ── Nodos: base sólo perímetro (apoyos); pisos 1..NS, malla completa ────────────
const id = (i, j, k) => `${i},${j},${k}`;
const nid = new Map();
const isPerim = (i, j) => i === 0 || i === NX || j === 0 || j === NY;
for (let k = 0; k <= NS; k++) for (let i = 0; i <= NX; i++) for (let j = 0; j <= NY; j++) {
  if (k === 0 && !isPerim(i, j)) continue;   // base: sólo bajo los muros (perímetro)
  const r = k === 0 ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } : {};
  nid.set(id(i, j, k), m.addNode(i * dxg, j * dyg, k * H, r).id);
}
// ── MUROS perimetrales: elementos MEMBRANA (rigidez en su plano = corte) ─────────
let nWall = 0;
for (let k = 0; k < NS; k++) {
  for (let i = 0; i < NX; i++) {   // muros en planos y=0 y y=Ly
    for (const j of [0, NY]) { m.addArea([nid.get(id(i, j, k)), nid.get(id(i + 1, j, k)), nid.get(id(i + 1, j, k + 1)), nid.get(id(i, j, k + 1))], mat, { thickness: tWall, behavior: 'membrane' }); nWall++; }
  }
  for (let j = 0; j < NY; j++) {   // muros en planos x=0 y x=Lx
    for (const i of [0, NX]) { m.addArea([nid.get(id(i, j, k)), nid.get(id(i, j + 1, k)), nid.get(id(i, j + 1, k + 1)), nid.get(id(i, j, k + 1))], mat, { thickness: tWall, behavior: 'membrane' }); nWall++; }
  }
}
// ── LOSAS de entrepiso: elementos PLACA (flexión vertical) en niveles 1..NS ──────
let nSlab = 0;
for (let k = 1; k <= NS; k++) for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
  m.addArea([nid.get(id(i, j, k)), nid.get(id(i + 1, j, k)), nid.get(id(i + 1, j + 1, k)), nid.get(id(i, j + 1, k))], mat, { thickness: tSlab, behavior: 'plate' }); nSlab++;
}
// ── Diafragma rígido por piso + masa sísmica (sobrecarga; el hormigón de muros/losas
//    aporta su masa propia vía las áreas). Da modos laterales limpios. ─────────────
const planArea = Lx * Ly;
const Mtot = { v: 0 };
for (let k = 1; k <= NS; k++) {
  const flNodes = []; for (let i = 0; i <= NX; i++) for (let j = 0; j <= NY; j++) flNodes.push(nid.get(id(i, j, k)));
  const wStruct = 25 * tSlab + 2.5;   // peso propio losa (25·t) + aporte de muros [kN/m²]
  const mFloor = (wStruct + Dsup + 0.25 * Lvar) * planArea / 9.81;   // ton/piso (masa concentrada)
  m.addDiaphragm({ name: `Piso ${k}`, z: k * H, nodes: flNodes, mass: { m: mFloor, Icm: 0 }, eccentricity: { ex: 0, ey: 0 } });
  Mtot.v += mFloor;
}

const modal = await runModal(m, 6);
const part = modal.getParticipation().rows;
const T1 = modal.period[0];
let domX = 0, best = -1; part.forEach((r, i) => { if (r.pct[0] > best) { best = r.pct[0]; domX = i; } });
const Tx = modal.period[domX], SaT = Sa(Tx);

// figura (áreas + 1er modo)
const nodes = new Map(), elements = [], supports = new Set();
for (const nd of m.nodes.values()) { nodes.set(nd.id, [nd.x, nd.y, nd.z]); const r = nd.restraints; if (r && (r.ux || r.uy || r.uz)) supports.add(nd.id); }
const areas = [...m.areas.values()].map(a => a.nodes);
let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (const c of nodes.values()) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], c[k]); mx[k] = Math.max(mx[k], c[k]); }
const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
const shape = modal.getModeShape(domX); let maxT = 0; const defo = new Map();
for (const idn of nodes.keys()) { const s = shape.get(idn) || [0, 0, 0]; defo.set(idn, s); maxT = Math.max(maxT, Math.hypot(s[0], s[1], s[2])); }
const amp = maxT > 0 ? 0.15 * diag / maxT : 0; const deformed = new Map();
for (const [idn, c] of nodes) { const d = defo.get(idn); deformed.set(idn, [c[0] + amp * d[0], c[1] + amp * d[1], c[2] + amp * d[2]]); }
fs.mkdirSync(path.join(ROOT, 'docs/examples/img'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/examples/img/tutorial_edificio_muros_valdivia.svg'), renderModelSVG({ nodes, elements, areas, deformed, supports, width: 820 }), 'utf8');
fs.writeFileSync(path.join(ROOT, 'examples', 'tutorial_edificio_muros_valdivia.s3d'), new Serializer().toJSON(m), 'utf8');

const fmt = (x, d = 2) => Number(x).toFixed(d);
const mdTable = (h, rows) => `| ${h.join(' | ')} |\n| ${h.map(() => '---').join(' | ')} |\n` + rows.map(r => `| ${r.join(' | ')} |`).join('\n') + '\n';
const md = `# Tutorial 2 — Edificio de 5 pisos de MUROS de hormigón en Valdivia (muros = membrana, losas = placa)

**Tipo:** tutorial de modelado con **elementos de área** · **Modelo:** [\`examples/tutorial_edificio_muros_valdivia.s3d\`](../../examples/tutorial_edificio_muros_valdivia.s3d)
**Normas:** NCh433 + DS61 (sísmico), NCh1537 (cargas).

> ⚠️ Tutorial educativo. Confirmar zona/suelo para el sitio (Valdivia: suelos blandos; ver el tutorial de pórticos). Muros modelados **sin aberturas** (puertas/ventanas) por simplicidad.

## 1. Objetivo

Variante del edificio de Valdivia resuelto con **muros de corte** en vez de pórticos: los **muros** se modelan con **elementos MEMBRANA/shell** (rigidez en su plano = corte + axial) y las **losas de entrepiso** con **elementos PLACA/shell** (flexión + acción de diafragma). Ilustra el uso de elementos de área para estructuras de muros.

## 2. Geometría y modelo

- Planta **${Lx}×${Ly} m**, **${NS} pisos** de ${H} m. Muros en el **perímetro** (4 caras), losa en cada piso.
- **Muros** (${nWall} paneles shell, t=${tWall} m): paneles verticales entre niveles → rigidez de **corte** en su plano.
- **Losas** (${nSlab} paneles shell, t=${tSlab} m): malla horizontal por piso → **flexión** vertical + **diafragma** en su plano.
- Base: nodos de arranque de los muros **empotrados**. Modelo: **${m.nodes.size} nodos**, **${m.areas.size} elementos de área**.

![Edificio de muros y primer modo](img/tutorial_edificio_muros_valdivia.svg)

*Figura. Edificio de muros (paneles) y su **primer modo** (×escala).*

## 3. Materiales, cargas y masa

- Hormigón H30 (E=${fmt(E / 1e7, 2)}·10⁷ kPa). Espesores: muros ${tWall} m, losas ${tSlab} m.
- **Masa sísmica:** toda la masa sísmica se **concentra en los diafragmas rígidos de piso** — una masa concentrada por nivel (${fmt(Mtot.v / NS, 2)} ton/piso, ${fmt(Mtot.v, 0)} ton total). Reúne el peso propio de losas y muros (${fmt(25 * tSlab + 2.5, 1)} kN/m²), la sobrecarga muerta (${fmt(Dsup, 1)} kN/m²) y la fracción sísmica de la sobrecarga viva (0.25·L = ${fmt(0.25 * Lvar, 1)} kN/m²), cada una por el área en planta. Al material de las áreas se le da a propósito **ρ = 0**, de modo que los shells no aportan masa distribuida y no hay masa nodal: concentrar la masa de piso en el diafragma es práctica habitual y da modos laterales limpios.

## 4. Análisis modal (Pórtico, con elementos de área)

${mdTable(['Modo', 'T [s]', 'f [Hz]', '% masa X', '% masa Y'], part.slice(0, 6).map(r => [r.mode, fmt(r.period, 3), fmt(r.freq, 2), fmt(r.pct[0], 1), fmt(r.pct[1], 1)]))}
**Período fundamental T₁ = ${fmt(T1, 3)} s.** Un edificio de muros es **mucho más rígido** que el de pórticos (período más corto) → mayor aceleración espectral pero menores derivas.

## 5. Espectro de diseño NCh433/DS61 (Zona 2, Suelo ${SOIL.tipo})

$$ S_a(T)=\\frac{S\\,A_0\\,\\alpha(T)}{R^*} $$

${mdTable(['T [s]', 'Sa(T) [g]'], [0.1, 0.2, T1, 0.5].map(T => [fmt(T, 3), fmt(Sa(T), 3)]))}
Para T₁ = ${fmt(Tx, 3)} s → **Sa = ${fmt(SaT, 3)} g** (espectro de diseño con R*=${fmt(Rstar(Tx), 2)}).

## 6. Comentarios de diseño

- Los **muros** concentran la rigidez lateral; las **losas-diafragma** reparten la fuerza sísmica entre muros. Verificar **tensiones de von Mises** en los muros (postproceso de áreas de Pórtico) y el **corte** en la base de cada muro.
- En Pórtico el contorno de tensiones de áreas y el panel de cada elemento entregan σ de membrana/superficie; las combinaciones NCh3171 y la memoria \`.docx\` documentan el diseño.

## 7. Conclusión

El edificio de **muros (membrana) + losas (placa)** modela como un conjunto de elementos de área; el modal entrega T₁ = ${fmt(T1, 3)} s (mucho más rígido que el de pórticos, T₁≈0.65 s) y el espectro NCh433/DS61 da la demanda. Demuestra el uso de **elementos de área para muros de corte y losas de entrepiso** en Pórtico. *(Modelo sin aberturas; el análisis real incluye huecos, acoplamiento de muros y verificación de tensiones.)*
`;
const mdPath = path.join(ROOT, 'docs/examples/tutorial_edificio_muros_valdivia.md');
fs.writeFileSync(mdPath, md, 'utf8');
execFileSync('node', ['tools/md2pdf.mjs', path.relative(ROOT, mdPath), '--logos', LOGOS], { cwd: ROOT, stdio: 'ignore' });
console.log(`✓ tutorial_edificio_muros_valdivia  ·  ${m.nodes.size} nodos, ${m.areas.size} áreas (${nWall} muro + ${nSlab} losa)`);
console.log(`  T1=${fmt(T1, 3)}s · domX modo ${domX + 1} (${fmt(best, 0)}% masa X) · Sa(T1)=${fmt(SaT, 3)}g`);
