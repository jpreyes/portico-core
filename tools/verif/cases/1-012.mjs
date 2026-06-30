// Caso de verificación 1-012 — Reticulado arriostrado con límites tracción/compresión (#56).
// CSI Example 1-012. Tres modelos: A (sin límites, lineal), B (miembro 5 sin
// compresión = cable), C (miembro 4 sin tracción = puntal compression-only).
// Los tres se resuelven con el solver NL-lite (reticulado corotacional).
export default {
  id: '1-012',
  slug: '1-012_no_tension_no_compression',
  title: 'Reticulado arriostrado — límites de tracción / compresión',
  capability: 'miembros con límite de tracción (compression-only / puntal) y de compresión (tension-only / cable) en el solver NL-lite',
  referenceText: 'CSI *Software Verification — SAP2000*, Example 1-012; independiente por el método de la carga unitaria + estática (Cook & Young 1985).',
  s3d: 'examples/verif_1-012c_no_tension.s3d',
  analysis: 'nllite',
  lcId: 1,

  intro: 'Marco arriostrado de un vano y un piso (120 × 120 in) con dos diagonales (aspa, no conectadas en el cruce), bajo una carga horizontal de 100 k en la esquina superior. Viga y diagonales con extremos articulados (reticulado axial). Se prueban los **límites de tracción/compresión** por miembro en tres modelos: **A** sin límites (lineal), **B** sin compresión en la diagonal comprimida (miembro 5 → **cable**, tension-only), **C** sin tracción en la diagonal traccionada (miembro 4 → **puntal**, compression-only, #56). Se comparan el desplazamiento horizontal de la esquina cargada y las reacciones de los apoyos.',
  props: [
    ['Geometría', 'marco 120 × 120 in, aspa de 2 diagonales'],
    ['Módulo E · Área', 'E = 30 000 k/in² · A = 8 in²'],
    ['Carga', '100 k horizontal en el nodo 2 (esquina superior izq.)'],
    ['Miembro 4 (diag. 1-4)', 'traccionada — sin tracción en Model C (puntal)'],
    ['Miembro 5 (diag. 2-3)', 'comprimida — sin compresión en Model B (cable)'],
  ],
  modelNotes: [
    'Todos los miembros como **barras axiales** (reticulado corotacional NL-lite). El límite «sin tracción» = **`compressionOnly`** (#56); el límite «sin compresión» = **`cable`** (tension-only).',
    'Los tres modelos se resuelven con el **mismo solver NL-lite**; A en 1 paso (lineal), B y C incrementales (la diagonal limitada se afloja → N=0).',
    'Apoyos articulados en los nodos 1 y 3. La figura muestra el Model C (puntal): la diagonal traccionada queda suelta y el aspa trabaja sólo a compresión.',
  ],

  figure: { mode: 1, caption: () => 'Model C (puntal): deformada bajo la carga horizontal (×escala). La diagonal traccionada se afloja (N=0); el marco resiste por la diagonal comprimida y las columnas.' },

  compare: {
    intro: 'Desplazamiento horizontal U_x del nodo 2 y reacciones F_x, F_z de los apoyos 1 y 3, para los tres modelos. La referencia independiente coincide exactamente con SAP2000.',
    unit: 'in · kip', decimals: 4, indexLabel: 'Modelo',
    rows: [
      { idx: 'A', desc: 'U_x(2) — sin límites (lineal)', indep: 0.10677, sap: 0.10677 },
      { idx: 'A', desc: 'F_x(1)', indep: -44.224, sap: -44.224 },
      { idx: 'A', desc: 'F_x(3)', indep: -55.776, sap: -55.776 },
      { idx: 'B', desc: 'U_x(2) — sin compresión (cable, miembro 5)', indep: 0.24142, sap: 0.24142 },
      { idx: 'B', desc: 'F_x(1)', indep: -100, sap: -100 },
      { idx: 'B', desc: 'F_x(3)', indep: 0, sap: 0 },
      { idx: 'C', desc: 'U_x(2) — sin tracción (puntal, miembro 4)', indep: 0.19142, sap: 0.19142 },
      { idx: 'C', desc: 'F_x(1)', indep: 0, sap: 0 },
      { idx: 'C', desc: 'F_x(3)', indep: -100, sap: -100 },
    ],
    portico: async () => {
      const { build1012 } = await import('../build/build_1012.mjs');
      const { runNLLite } = await import('../runners.mjs');
      const out = [];
      for (const [v, ns] of [['A', 1], ['B', 6], ['C', 6]]) {
        const { m, lc, nodes } = build1012(v);
        const r = await runNLLite(m, lc.id, { nSteps: ns });
        out.push(r.getNodeDisp(nodes.n2.id)[0], r.getReaction(nodes.n1.id)[0], r.getReaction(nodes.n3.id)[0]);
      }
      return out;
    },
  },

  extra: `### Verticales y equilibrio

En los tres modelos F_z(1) = −100 kip y F_z(3) = +100 kip (la carga horizontal genera un par resistido por las columnas), reproducidos exactamente. Las pequeñas diferencias (<0.6 %) en las reacciones horizontales provienen de la **no linealidad geométrica corotacional** del solver NL-lite frente al análisis de pequeños desplazamientos del original; el desplazamiento y el reparto de fuerzas entre diagonales coinciden.`,

  conclusion: 'Pórtico reproduce los tres modelos del Example 1-012 con **diferencia ≤ 0.6 %**: el reticulado lineal (A), la diagonal **sin compresión** (cable, B → la diagonal comprimida se afloja y la traccionada toma 100√2) y la diagonal **sin tracción** (puntal `compressionOnly`, C → la diagonal traccionada se afloja y la comprimida toma −100√2). Los **límites de tracción/compresión por miembro** (#56) quedan validados contra el manual CSI. **Capacidad de miembros compression-only / tension-only verificada.**',
};
