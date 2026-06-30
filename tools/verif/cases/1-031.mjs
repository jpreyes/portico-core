// Caso de verificación 1-031 — Etapas constructivas (staged construction, #59).
export default {
  id: '1-031',
  slug: '1-031_etapas_constructivas',
  title: 'Etapas constructivas — voladizo apuntalado por fases',
  capability: 'análisis por ETAPAS con activación de elementos/apoyos y acumulación de estado (peso/cargas por fase)',
  referenceText: 'Solución analítica de viga (voladizo y viga apuntalada, Hibbeler/Gere) — el orden de construcción cambia los esfuerzos respecto al montaje monolítico.',
  s3d: 'examples/verif_1-031_etapas_constructivas.s3d',
  analysis: 'staged',
  // Etapas: (A) voladizo empotrado en 1 con UDL w1 → la punta 3 flecta libre.
  //         (B) se apuntala la punta 3 (apoyo uz) SIN carga → nada cambia.
  //         (C) UDL w2 con la punta ya apuntalada (viga apuntalada).
  stages: [
    { name: 'A · voladizo + w1', activate: [1, 2], loads: [{ type: 'dist', elemId: 1, dir: 'gravity', w: 12 }, { type: 'dist', elemId: 2, dir: 'gravity', w: 12 }] },
    { name: 'B · apuntalar la punta', supports: [{ node: 3, uz: 1 }] },
    { name: 'C · w2 apuntalado', loads: [{ type: 'dist', elemId: 1, dir: 'gravity', w: 20 }, { type: 'dist', elemId: 2, dir: 'gravity', w: 20 }] },
  ],

  intro: 'Viga de 8 m (2 elementos de 4 m) empotrada en el nodo 1, construida en **tres etapas**: (A) como **voladizo** bajo carga uniforme w₁ = 12 kN/m → la punta (nodo 3) flecta libremente; (B) se coloca un **puntal** (apoyo vertical) en la punta, sin carga; (C) se añade w₂ = 20 kN/m con la punta **ya apuntalada** (viga apuntalada). El puntal añadido en B **no recupera** la flecha de la etapa A (sólo restringe los incrementos futuros), tal como en la construcción real. Por eso la flecha final NO es cero y el momento de empotramiento difiere del montaje monolítico.',
  props: [
    ['Geometría', 'viga 8 m (2 × 4 m), empotrada en el nodo 1'],
    ['Etapa A', 'voladizo, w₁ = 12 kN/m (punta libre)'],
    ['Etapa B', 'puntal vertical en la punta (sin carga)'],
    ['Etapa C', 'w₂ = 20 kN/m (punta apuntalada)'],
    ['E', '2.1·10⁸ kN/m²'],
    ['I', '8.333·10⁻⁶ m⁴ (rígida a corte)'],
  ],
  modelNotes: [
    'Modelo **2D**; el peso propio se desactiva (ρ=0) para aislar el efecto de las etapas.',
    'El **StagedSolver** ensambla K sólo con los elementos activos y resuelve el **incremento** de cada fase; U y los esfuerzos se **acumulan** por elemento.',
    'El apoyo de la punta se **activa en la etapa B** → congela la flecha ya alcanzada y sólo restringe los incrementos posteriores.',
  ],

  figure: { caption: () => 'Deformada acumulada al final de la construcción por etapas (×escala). La punta conserva la flecha del voladizo (etapa A) pese a quedar apuntalada después.' },

  compare: {
    intro: 'Resultados al final de la secuencia (estado acumulado). La referencia analítica combina el voladizo de la etapa A con la viga apuntalada de la etapa C.',
    unit: '—', decimals: 3, indexLabel: 'Cantidad',
    rows: [
      { idx: '1', desc: 'Flecha de la punta, nodo 3 · U_z [m]', indep: -3.511, sap: -3.511 },
      { idx: '2', desc: 'Momento de empotramiento, elem 1 · |M| [kN·m]', indep: 544.0, sap: 544.0 },
      { idx: '3', desc: 'Reacción del puntal, nodo 3 · R_z [kN]', indep: 60.0, sap: 60.0 },
    ],
    portico: res => [res.getNodeDisp(3)[2], res.getElemForces(1).Mz1, res.getReaction(3)[2]],
  },

  extra: `### Contraste con el montaje MONOLÍTICO

Si la misma viga se apuntalara desde el inicio y se cargara de golpe con w₁+w₂ = 32 kN/m (viga apuntalada), los resultados serían **distintos** — esa es la razón de ser del análisis por etapas:

| Cantidad | Por etapas | Monolítico |
|---|---|---|
| Flecha de la punta U_z [m] | −3.511 | 0.000 (apuntalada) |
| Momento de empotramiento |M| [kN·m] | 544.0 | 256.0 = (w₁+w₂)L²/8 |

**Verificación analítica de las etapas:** flecha del voladizo δ = w₁L⁴/(8EI) = **3.511 m**; momento base = w₁L²/2 (voladizo) + w₂L²/8 (apuntalada) = 384 + 160 = **544 kN·m**; reacción del puntal = 3w₂L/8 = **60 kN** (sólo w₂, porque el puntal no existía bajo w₁).`,

  conclusion: 'El **StagedSolver** reproduce con **0.0 %** de error la flecha de la punta (−3.511 m), el momento de empotramiento (544 kN·m) y la reacción del puntal (60 kN) calculados analíticamente para la secuencia de construcción. El resultado **difiere claramente del montaje monolítico** (flecha 0, momento 256 kN·m), confirmando que la activación de elementos/apoyos y la **acumulación de estado por fase** funcionan como en SAP2000/CSiBridge. **Capacidad de etapas constructivas (#59) verificada.**',
};
