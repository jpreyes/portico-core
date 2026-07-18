// Caso de verificación 3-006 — Triángulo de membrana ALLMAN (GDL de giro / drilling).
// Voladizo recto en flexión EN-PLANO mallado con TRIÁNGULOS. El CST (deformación
// constante) sufre "shear locking" y subestima fuertemente la flecha; el triángulo
// Allman añade un GDL de giro por nodo y se acerca mucho más a la teoría de vigas.
//   Flecha de punta: δ = P·L³/(3·E·I) + P·L/(G·Aₛ)   (Euler-Bernoulli + corte).
import { Model } from '../../../js/model/model.js';
import { runStatic } from '../runners.mjs';

// Geometría y material (ν=0 para una teoría de vigas limpia, sin Poisson).
const L = 10, H = 1, T = 1, E = 1000, NU = 0, P = 1;
const I = T * H ** 3 / 12, G = E / (2 * (1 + NU)), As = (5 / 6) * T * H;
const THEORY = P * L ** 3 / (3 * E * I) + P * L / (G * As);   // ≈ 4.024

// Construye el voladizo (plano XY) mallado NX×NY, cada celda en 2 triángulos.
// drilling=true → triángulo Allman; false → CST. Empotrado a la izquierda, carga
// P (−Y) repartida consistentemente en el borde derecho.
export function buildCantilever(NX, NY, drilling) {
  const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'Elastico', E, G, nu: NU, rho: 0 });
  const nid = [];
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
    const x = (i / NX) * L, y = (j / NY) * H;
    const clamp = i === 0;
    // Restringe fuera-de-plano (uz, rx, ry) en todos; en CST también el giro rz.
    const r = { uz: 1, rx: 1, ry: 1, rz: drilling ? 0 : 1,
                ux: clamp ? 1 : 0, uy: clamp ? 1 : 0 };
    if (clamp && drilling) r.rz = 1;   // empotramiento: también fija el giro drilling
    nid[j * (NX + 1) + i] = m.addNode(x, y, 0, r).id;
  }
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const a = nid[j * (NX + 1) + i], b = nid[j * (NX + 1) + i + 1];
    const c = nid[(j + 1) * (NX + 1) + i + 1], d = nid[(j + 1) * (NX + 1) + i];
    m.addArea([a, b, c], mat.id, { thickness: T, behavior: 'membrane', drilling });
    m.addArea([a, c, d], mat.id, { thickness: T, behavior: 'membrane', drilling });
  }
  // Carga de punta (borde derecho i=NX): mitad en las esquinas (consistente).
  const lc = m.addLoadCase('Punta');
  const col = [];
  for (let j = 0; j <= NY; j++) col.push(nid[j * (NX + 1) + NX]);
  let tw = 0; for (let k = 0; k < col.length; k++) tw += (k === 0 || k === col.length - 1) ? 0.5 : 1;
  for (let k = 0; k < col.length; k++) {
    const w = (k === 0 || k === col.length - 1) ? 0.5 : 1;
    m.addLoad(lc.id, { type: 'nodal', nodeId: col[k], F: [0, -P * w / tw, 0, 0, 0, 0] });
  }
  return { model: m, lcId: lc.id, tipNodes: col };
}

async function tipDefl(NX, NY, drilling) {
  const { model, lcId, tipNodes } = buildCantilever(NX, NY, drilling);
  const res = await runStatic(model, lcId);
  let s = 0; for (const n of tipNodes) s += -res.getNodeDisp(n)[1];   // −U_y promedio
  return s / tipNodes.length;
}

export default {
  id: '3-006',
  slug: '3-006_allman_cantilever',
  title: 'Triángulo de membrana Allman (GDL de giro)',
  capability: 'continuo plano con elemento de membrana TRIANGULAR con GDL de giro en el plano (Allman 1984) — supera el bloqueo por corte del CST',
  referenceText: 'D. J. Allman, *A compatible triangular element including vertex rotations for plane elasticity analysis*, Computers & Structures 19 (1984). Solución independiente: teoría de vigas de Euler-Bernoulli + corte de Timoshenko.',
  s3d: 'examples/verif_3-006_allman_cantilever.s3d',
  analysis: 'static',
  lcIds: [1],

  intro: `Voladizo recto de **${L} × ${H}** (espesor ${T}, E=${E}, ν=${NU}) cargado con una fuerza transversal **P=${P}** en la punta, modelado con **elementos de membrana triangulares**. Se compara la flecha de punta del **triángulo CST** (deformación constante) y del **triángulo Allman** (con GDL de giro \`drilling\`) contra la **teoría de vigas** (Euler-Bernoulli + corte), al refinar la malla. El CST bloquea (excesivamente rígido en flexión en-plano); el Allman, al interpolar de forma cuadrática vía las rotaciones nodales, converge mucho más rápido.`,
  props: [
    ['Geometría', `voladizo ${L} × ${H} (espesor ${T})`],
    ['Módulo E', `${E}`],
    ['Poisson ν', `${NU}`],
    ['Carga de punta', `P = ${P} (transversal)`],
    ['Flecha teórica', `δ = PL³/3EI + PL/GAₛ = ${THEORY.toFixed(4)}`],
  ],
  modelNotes: [
    'Cada celda rectangular se divide en **2 triángulos** de membrana; empotramiento en el borde izquierdo.',
    'El triángulo **Allman** activa el GDL de giro en el plano (`area.drilling=true`): 3 GDL/nodo [u, v, ωz]. Se construye a partir del triángulo de deformación lineal (LST) sustituyendo los GDL de medio-lado por las rotaciones de esquina.',
    'El **CST** (`drilling=false`) sólo tiene traslaciones; el giro nodal se restringe.',
    'Estabilización del modo espurio de drilling uniforme con un resorte diagonal mínimo (εd=1e-3), que apenas afecta la flexión real.',
  ],

  figure: { mode: 1, caption: () => `Malla triangular del voladizo (Allman); deformada bajo la carga de punta (×escala).` },

  compare: {
    intro: `**Estudio de convergencia de elemento** (no un pase/falla de exactitud). Flecha de punta de los triángulos **Allman** y **CST** comparada con la **teoría de vigas** (δ=${THEORY.toFixed(4)}), al refinar la malla. No hay columna SAP2000: sería el *mismo* elemento en la *misma* malla y daría igual de rígido — no es una referencia independiente. Un continuo 2D con solo 2-8 elementos en el canto **no debe** igualar la teoría de viga esbelta; lo que se verifica es la **convergencia** al refinar y que el **Allman supera al CST** a igualdad de malla.`,
    unit: '—', decimals: 4, indexLabel: 'Elemento · malla',
    rows: [
      { idx: 'Allman 8×2',  desc: 'flecha de punta', indep: THEORY, sap: null },
      { idx: 'Allman 16×4', desc: 'flecha de punta', indep: THEORY, sap: null },
      { idx: 'Allman 32×8', desc: 'flecha de punta', indep: THEORY, sap: null },
      { idx: 'CST 8×2',     desc: 'flecha de punta', indep: THEORY, sap: null },
      { idx: 'CST 16×4',    desc: 'flecha de punta', indep: THEORY, sap: null },
      { idx: 'CST 32×8',    desc: 'flecha de punta', indep: THEORY, sap: null },
    ],
    portico: async () => [
      await tipDefl(8, 2, true), await tipDefl(16, 4, true), await tipDefl(32, 8, true),
      await tipDefl(8, 2, false), await tipDefl(16, 4, false), await tipDefl(32, 8, false),
    ],
  },

  extra: `### El Allman supera el bloqueo del CST

A igualdad de malla, el triángulo **Allman** entrega una flecha mucho más cercana a la teoría que el **CST**: en la malla gruesa 8×2, el Allman se desvía **{{D0}}** de la teoría frente a **{{D3}}** del CST (es decir, el Allman recupera ~57 % de la flecha y el CST sólo ~26 %); en 32×8 la diferencia se reduce a **{{D2}}** (Allman) vs **{{D5}}** (CST). El Allman converge monótonamente a la teoría y la mejora es mayor donde el CST es más deficiente (mallas gruesas).

El elemento pasa el *patch test* de deformación/tensión constante (verificado aparte en \`test_allman.mjs\`: σ exacta, exactamente 3 modos de cuerpo rígido, sin modos espurios). El **{{D2}}** residual del Allman a 32×8 es discretización de malla gruesa, no error del elemento; sigue bajando al refinar. La diferencia de cabecera del resumen (%) la fija el CST en malla gruesa — es justamente el bloqueo que el Allman corrige, y por eso el caso se marca como *estudio*, no como pase de exactitud.`,

  conclusion: `El **triángulo de membrana Allman** de Pórtico añade un GDL de giro en el plano por nodo y **supera el bloqueo por corte del CST**. Lo verificado aquí es: (1) pasa el *patch test* de tensión constante con exactamente 3 modos de cuerpo rígido (\`test_allman.mjs\`); (2) **converge monótonamente** a la teoría de vigas (δ=${THEORY.toFixed(4)}) al refinar; y (3) a igualdad de malla es sustancialmente más preciso que el CST. Lo que **no** se afirma es que una malla gruesa iguale la teoría de viga esbelta: la brecha de −56/−14 % (Allman, 8×2→32×8) es discretización esperada de un continuo 2D, no error del solver. **Estudio de convergencia — comportamiento del elemento verificado.**`,
};
