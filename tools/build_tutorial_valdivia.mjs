// build_tutorial_valdivia.mjs — TUTORIAL: edificio 5 pisos de hormigón armado en
// Valdivia (Chile). Construye el .s3d, corre el MODAL headless, calcula el espectro
// de diseño NCh433/DS61 y emite el tutorial .md → .pdf con membrete del proyecto.
//   node tools/build_tutorial_valdivia.mjs
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { Model } from '../js/model/model.js';
import { Serializer } from '../js/model/serializer.js';
import { runModal } from './verif/runners.mjs';
import { renderModelSVG } from './verif/figure.mjs';

const ROOT = process.cwd();
const LOGOS = '';

// ── Parámetros del edificio ─────────────────────────────────────────────────────
const NB = 3, BAYX = 6, BAYY = 5, NS = 5, H = 3.0;  // 3×3 vanos (6 m en X, 5 m en Y) → planta rectangular
const fc = 30, E = 4700 * Math.sqrt(fc) * 1000;  // E≈4700√f'c [MPa]→kPa (ACI) ≈ 2.57e7
const rho = 2.5;                                  // peso específico (convención app)
const D = 6.0, L = 2.0;                            // cargas de servicio [kN/m²] (NCh1537)
const planArea = (NB * BAYX) * (NB * BAYY);       // 18×15 = 270 m² (rectangular → modos X/Y separados)
const Wfloor = (D + 0.25 * L) * planArea;         // peso sísmico por piso [kN] (D + 0.25L)
const Mfloor = Wfloor / 9.81;                     // masa por piso [ton]
const Ptot = NS * Wfloor;                          // peso sísmico total [kN]

// ── Espectro de diseño NCh433 + DS61 (Suelo D, Zona 2) ──────────────────────────
const A0 = 0.30;                 // aceleración efectiva / g — Valdivia, Zona 2
const SOIL = { tipo: 'D', S: 1.20, T0: 0.75, Tp: 0.85, n: 1.80, p: 1.0 };  // DS61 Tabla 6.3
const R = 7, R0 = 11, I = 1.0;   // HA pórtico/muro (NCh433 Tabla 5.1) · importancia cat. II
const alpha = (T) => (1 + 4.5 * (T / SOIL.T0) ** SOIL.p) / (1 + (T / SOIL.T0) ** 3);   // amplificación dinámica
const Rstar = (T) => 1 + T / (0.10 * SOIL.T0 + T / R0);                                 // reducción efectiva
const Sa = (T) => SOIL.S * A0 * alpha(T) / Rstar(T);                                    // espectro de diseño [g]
const Cstatic = (T) => {                                                                 // coef. sísmico estático
  let C = 2.75 * A0 * SOIL.S / R * (SOIL.Tp / T) ** SOIL.n;
  const Cmin = A0 * SOIL.S / 6;                                                          // cota inferior
  return Math.max(C, Cmin);
};

// ── Construcción del modelo ─────────────────────────────────────────────────────
function build() {
  const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: `Hormigón H${fc}`, E, G: E / 2.4, nu: 0.2, rho }).id;
  const col = m.addSection({ name: 'Columna 50×50', A: 0.25, Iy: 0.005208, Iz: 0.005208, J: 0.0088, Avy: 0.208, Avz: 0.208, kappay: 0.833, kappaz: 0.833 }).id;
  const beam = m.addSection({ name: 'Viga 30×60', A: 0.18, Iy: 0.00135, Iz: 0.0054, J: 0.0029, Avy: 0.15, Avz: 0.15, kappay: 0.833, kappaz: 0.833 }).id;
  // Nodos: grilla (NB+1)×(NB+1) en planta × (NS+1) niveles
  const id = (i, j, k) => `${i},${j},${k}`;
  const nodeId = new Map();
  for (let k = 0; k <= NS; k++) for (let i = 0; i <= NB; i++) for (let j = 0; j <= NB; j++) {
    const r = k === 0 ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } : {};   // base empotrada
    nodeId.set(id(i, j, k), m.addNode(i * BAYX, j * BAYY, k * H, r).id);
  }
  // Columnas
  for (let k = 0; k < NS; k++) for (let i = 0; i <= NB; i++) for (let j = 0; j <= NB; j++)
    m.addElement(nodeId.get(id(i, j, k)), nodeId.get(id(i, j, k + 1)), mat, col);
  // Vigas en X y en Y por piso
  for (let k = 1; k <= NS; k++) {
    for (let j = 0; j <= NB; j++) for (let i = 0; i < NB; i++) m.addElement(nodeId.get(id(i, j, k)), nodeId.get(id(i + 1, j, k)), mat, beam);
    for (let i = 0; i <= NB; i++) for (let j = 0; j < NB; j++) m.addElement(nodeId.get(id(i, j, k)), nodeId.get(id(i, j + 1, k)), mat, beam);
  }
  // Diafragma rígido + masa por piso
  for (let k = 1; k <= NS; k++) {
    const nodes = [];
    for (let i = 0; i <= NB; i++) for (let j = 0; j <= NB; j++) nodes.push(nodeId.get(id(i, j, k)));
    m.addDiaphragm({ name: `Piso ${k}`, z: k * H, nodes, mass: { m: Mfloor, Icm: 0 }, eccentricity: { ex: 0, ey: 0 } });
  }
  return m;
}

// ── Figura (frame 3D + primer modo) ─────────────────────────────────────────────
function figure(model, modal) {
  const nodes = new Map(), elements = [], supports = new Set();
  for (const nd of model.nodes.values()) { nodes.set(nd.id, [nd.x, nd.y, nd.z]); const r = nd.restraints; if (r && ((r.ux ? 1 : 0) + (r.uy ? 1 : 0) + (r.uz ? 1 : 0)) >= 2) supports.add(nd.id); }
  for (const e of model.elements.values()) elements.push({ n1: e.n1, n2: e.n2 });
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const c of nodes.values()) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], c[k]); mx[k] = Math.max(mx[k], c[k]); }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  const shape = modal.getModeShape(0); let maxT = 0; const defo = new Map();
  for (const idn of nodes.keys()) { const s = shape.get(idn) || [0, 0, 0]; defo.set(idn, s); maxT = Math.max(maxT, Math.hypot(s[0], s[1], s[2])); }
  let deformed = null;
  if (maxT > 0) { const amp = 0.18 * diag / maxT; deformed = new Map(); for (const [idn, c] of nodes) { const d = defo.get(idn); deformed.set(idn, [c[0] + amp * d[0], c[1] + amp * d[1], c[2] + amp * d[2]]); } }
  return renderModelSVG({ nodes, elements, supports, deformed, width: 820 });
}

const fmt = (x, d = 2) => Number(x).toFixed(d);
const mdTable = (h, rows) => `| ${h.join(' | ')} |\n| ${h.map(() => '---').join(' | ')} |\n` + rows.map(r => `| ${r.join(' | ')} |`).join('\n') + '\n';

async function main() {
  const model = build();
  const modal = await runModal(model, 6);
  const part = modal.getParticipation().rows;
  const T1 = modal.period[0];
  // modo dominante en X (mayor participación traslacional X)
  let domX = 0, best = -1; part.forEach((r, i) => { if (r.pct[0] > best) { best = r.pct[0]; domX = i; } });
  const Tx = modal.period[domX];
  const SaT = Sa(Tx), Cst = Cstatic(Tx);
  const Qmodal = SaT * Ptot;          // corte basal espectral (modo dominante, aprox.)
  const Qstatic = Cst * I * Ptot;     // corte basal estático
  const Qmin = (A0 * SOIL.S / 6) * I * Ptot;
  // desplazamiento espectral del modo dominante (aprox.) y deriva de techo
  const g = 9.81; const Sd = SaT * g * (Tx / (2 * Math.PI)) ** 2;   // [m]
  const gammaX = part[domX].gamma[0], genM = (gammaX * gammaX) / (part[domX].meff[0] || 1);
  const roofShape = modal.getModeShape(domX).get([...model.nodes.keys()].find(k => model.nodes.get(k).z === NS * H));
  const phiRoof = roofShape ? Math.abs(roofShape[0]) : 0;
  const uRoof = Math.abs(gammaX) / (genM || 1) * phiRoof * Sd;   // u = Γ/M̄·φ·Sd
  const driftAvg = uRoof / (NS * H);

  fs.writeFileSync(path.join(ROOT, 'examples', 'tutorial_edificio_valdivia.s3d'), new Serializer().toJSON(model), 'utf8');
  fs.mkdirSync(path.join(ROOT, 'docs/examples/img'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs/examples/img/tutorial_edificio_valdivia.svg'), figure(model, modal), 'utf8');

  const md = `# Tutorial — Edificio de 5 pisos de hormigón armado en Valdivia

**Tipo:** tutorial paso a paso (modelado + análisis sísmico en Pórtico).
**Modelo:** [\`examples/tutorial_edificio_valdivia.s3d\`](../../examples/tutorial_edificio_valdivia.s3d)
**Normas:** NCh433 (diseño sísmico) + DS61, NCh1537 (cargas), NCh3171 (combinaciones).

> ⚠️ **Tutorial educativo.** Los valores de zona sísmica y tipo de suelo deben confirmarse para el sitio y la comuna exactos según la versión vigente de NCh433 (existe la actualización **NCh433:2026**). Valdivia tiene **suelos blandos** (depósitos fluviales; el terremoto de 1960 produjo subsidencia/licuefacción): el tipo de suelo lo define la **mecánica de suelos** del proyecto; partes de la ciudad pueden ser **D, E o incluso F (estudio especial)**.

## 1. Objetivo y alcance

Modelar y analizar sísmicamente un **edificio de 5 pisos de hormigón armado** (pórticos espaciales con losas rígidas) emplazado en **Valdivia**, ilustrando el flujo completo en Pórtico: geometría → materiales/secciones → cargas → masas sísmicas → diafragmas → **modal** → **espectro de respuesta** (NCh433/DS61) → cortes basales → derivas → diseño.

## 2. Antecedentes del sitio (Valdivia)

${mdTable(['Parámetro', 'Valor', 'Fuente'], [
    ['Zona sísmica', 'Zona 2', 'NCh433 (zonificación por comuna)'],
    ['Aceleración efectiva A₀', `${fmt(A0, 2)}·g`, 'NCh433 (Zona 2)'],
    ['Tipo de suelo (asumido)', `${SOIL.tipo}`, 'mecánica de suelos (confirmar; Valdivia suele D/E/F)'],
    ['Categoría / importancia I', `II / I=${fmt(I, 1)}`, 'NCh433 (vivienda-oficina)'],
    ['R / R₀', `${R} / ${R0}`, 'NCh433 Tabla 5.1 (H.A.)'],
  ])}
## 3. Geometría y modelo en Pórtico

- Planta **${NB}×${NB} vanos** (${BAYX} m en X, ${BAYY} m en Y → ${NB * BAYX}×${NB * BAYY} m), **${NS} pisos** de **${fmt(H, 1)} m** (altura total ${fmt(NS * H, 1)} m). La planta **rectangular** separa los períodos en X e Y (modos limpios).
- **Paso a paso en Pórtico:** (1) crear la grilla (ejes cada ${BAYX} m en X y ${BAYY} m en Y, niveles cada ${fmt(H, 1)} m); (2) modo **Elemento** → columnas verticales y vigas en X e Y por piso (el imán reutiliza nodos); (3) modo **Apoyo** → empotrar los ${(NB + 1) ** 2} nodos de la base; (4) Análisis → **autodetectar diafragmas** (crea un diafragma rígido por piso en su centro de rigidez).
- El modelo resultante: **${model.nodes.size} nodos**, **${model.elements.size} elementos**, **${NS} diafragmas**.

![Edificio y primer modo](img/tutorial_edificio_valdivia.svg)

*Figura. Pórtico 3D del edificio y su **primer modo** de vibración (×escala).*

## 4. Materiales y secciones

${mdTable(['Elemento', 'Sección', 'Propiedades'], [
    ['Material', `Hormigón H${fc}`, `E = 4700√f'c = ${fmt(E / 1e7, 2)}·10⁷ kPa, ν=0.2`],
    ['Columnas', '50×50 cm', 'A=0.25 m², I=5.21·10⁻³ m⁴'],
    ['Vigas', '30×60 cm', 'A=0.18 m², I_z=5.40·10⁻³ m⁴'],
  ])}
*En Pórtico se pueden aplicar **modificadores de rigidez** (sección agrietada ACI: vigas 0.35·Ig, columnas 0.70·Ig) en \`sec.mod\`.*

## 5. Cargas y masa sísmica (NCh1537 / NCh433)

- Carga muerta **D = ${fmt(D, 1)} kN/m²** (losa + terminaciones + tabiquería), sobrecarga **L = ${fmt(L, 1)} kN/m²**.
- **Peso sísmico** por piso = (D + 0.25·L)·A = (${fmt(D, 1)}+0.25·${fmt(L, 1)})·${planArea} = **${fmt(Wfloor, 0)} kN** → masa **${fmt(Mfloor, 1)} ton/piso**.
- **Peso sísmico total P = ${fmt(Ptot, 0)} kN**. La masa se asigna al **diafragma** de cada piso (Pórtico la reparte por área tributaria y arma la inercia rotacional).

## 6. Espectro de diseño NCh433 + DS61

Parámetros del suelo **${SOIL.tipo}** (DS61): S=${fmt(SOIL.S, 2)}, T₀=${fmt(SOIL.T0, 2)} s, T'=${fmt(SOIL.Tp, 2)} s, n=${fmt(SOIL.n, 2)}, p=${fmt(SOIL.p, 1)}.

$$ S_a(T) = \\frac{S\\,A_0\\,\\alpha(T)}{R^*},\\quad \\alpha(T)=\\frac{1+4.5(T/T_0)^p}{1+(T/T_0)^3},\\quad R^*=1+\\frac{T}{0.10\\,T_0 + T/R_0} $$

${mdTable(['T [s]', 'α(T)', 'R*(T)', 'Sa(T) [g]'], [0.2, 0.5, 1.0, 1.5, 2.0].map(T => [fmt(T, 1), fmt(alpha(T), 2), fmt(Rstar(T), 2), fmt(Sa(T), 3)]))}
## 7. Análisis modal (resultados de Pórtico)

Corrido con la **iteración de subespacio** (6 modos). Períodos y participación de masa:

${mdTable(['Modo', 'T [s]', 'f [Hz]', '% masa X', '% masa Y'], part.slice(0, 6).map(r => [r.mode, fmt(r.period, 3), fmt(r.freq, 2), fmt(r.pct[0], 1), fmt(r.pct[1], 1)]))}
**Período fundamental T₁ = ${fmt(T1, 3)} s.** Modo dominante en X: modo ${domX + 1} (T = ${fmt(Tx, 3)} s, ${fmt(best, 1)} % de masa).

## 8. Análisis sísmico — corte basal

${mdTable(['Magnitud', 'Valor', 'Comentario'], [
    ['Sa(T₁) de diseño', `${fmt(SaT, 3)} g`, 'espectro DS61 en el modo dominante'],
    ['Corte basal espectral Q (≈ modo dom.)', `${fmt(Qmodal, 0)} kN`, 'Sa·P (estimación del modo dominante)'],
    ['Coef. sísmico estático C', `${fmt(Cst, 3)}`, '2.75·A₀·S/R·(T\'/T*)ⁿ acotado'],
    ['Corte basal estático Q₀', `${fmt(Qstatic, 0)} kN`, 'C·I·P'],
    ['Corte basal mínimo', `${fmt(Qmin, 0)} kN`, 'A₀·S/6·I·P (cota inferior NCh433)'],
  ])}
> El análisis de **espectro de respuesta** real (combinación **CQC** de todos los modos) se ejecuta en Pórtico desde el Centro de análisis (caso espectral X/Y); el corte basal modal se **escala al mínimo** de NCh433 si resulta menor. La tabla anterior usa el modo dominante como referencia.

## 9. Derivas de entrepiso

NCh433 limita la **deriva de entrepiso** a **0.002·h** (entre centros de masa, con desplazamientos del análisis ×R₀ o según el método). Estimación con el modo dominante:

${mdTable(['Magnitud', 'Valor'], [
    ['Desplazamiento espectral Sd (modo dom.)', `${fmt(Sd * 1000, 1)} mm`],
    ['Desplazamiento de techo (aprox.)', `${fmt(uRoof * 1000, 1)} mm`],
    ['Deriva media de entrepiso (aprox.)', `${fmt(driftAvg * 1000, 2)} ‰ (límite 2 ‰ = 0.002)`],
  ])}
*Estimación del modo dominante; la verificación formal usa las derivas por piso del análisis espectral (CQC) en Pórtico.*

## 10. Combinaciones y diseño

- Combinaciones **NCh3171/ASCE-7** (Pórtico las crea automáticamente): 1.4D; 1.2D+1.6L; 1.2D+L±1.4E_x; 1.2D+L±1.4E_y; 0.9D±1.4E. Set ASD opcional.
- Con los esfuerzos por combinación, la **tabla de diseño** de Pórtico entrega D/C por elemento; la **memoria de cálculo** (.docx) documenta bases, modal, cortes, derivas y diseño.

## 11. Conclusión y limitaciones

El edificio de 5 pisos modela como **pórtico espacial de H.A. con diafragmas rígidos**; el modal entrega T₁ = ${fmt(T1, 3)} s y participaciones coherentes, y el espectro NCh433/DS61 (Zona 2, Suelo ${SOIL.tipo}) da los cortes basales y derivas de diseño. **Limitaciones:** los valores de zona/suelo deben confirmarse para el sitio (Valdivia: suelos blandos, posible D/E/F con estudio especial); las derivas y el corte mostrados son estimaciones del modo dominante — la verificación final usa el **espectro de respuesta CQC** y las combinaciones en Pórtico.
`;
  const mdPath = path.join(ROOT, 'docs/examples/tutorial_edificio_valdivia.md');
  fs.writeFileSync(mdPath, md, 'utf8');
  execFileSync('node', ['tools/md2pdf.mjs', path.relative(ROOT, mdPath), '--logos', LOGOS], { cwd: ROOT, stdio: 'ignore' });
  console.log(`✓ tutorial_edificio_valdivia  ·  ${model.nodes.size} nodos, ${model.elements.size} elem, ${NS} diafragmas`);
  console.log(`  T1=${fmt(T1, 3)}s · Tx(dom)=${fmt(Tx, 3)}s (${fmt(best, 0)}% masa X) · Sa=${fmt(SaT, 3)}g · Qstat=${fmt(Qstatic, 0)}kN · Qmin=${fmt(Qmin, 0)}kN`);
}
main();
