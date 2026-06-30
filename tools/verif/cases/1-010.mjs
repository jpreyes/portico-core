// Caso de verificación 1-010 — Links / couplings (offset rígido tablero↔pila).
export default {
  id: '1-010',
  slug: '1-010_link_offset',
  title: 'Link rígido (offset) — tablero excéntrico sobre pila',
  capability: 'links/couplings: restricción cinemática rígida con brazo (offset) que transmite fuerza + momento entre nodos sin elemento intermedio',
  referenceText: 'Modelado de end offsets / insertion points (CSI *Software Verification*, 1-010/1-011); equilibrio de la carga excéntrica (estática elemental).',
  s3d: 'examples/verif_1-010_link_offset.s3d',
  analysis: 'static',
  lcId: 1,

  intro: 'Pila vertical de 5 m empotrada en la base. El eje del **tablero** (nodo 3) está desplazado **e = 2 m** del eje de la pila y se liga a la punta de la pila (nodo 2) con un **LINK RÍGIDO** (sigue al maestro como sólido, con brazo). Una carga vertical **P = 100 kN** aplicada en el tablero llega a la pila como **P + un momento M = P·e** (carga excéntrica): es el patrón típico de puente, con el tablero modelado arriba y acoplado a las vigas/pilas.',
  props: [
    ['Pila', 'vertical, H = 5 m, empotrada en la base'],
    ['Offset del tablero', 'e = 2 m (en X)'],
    ['Carga', 'P = 100 kN vertical (↓) en el tablero'],
    ['E·I', 'E=2·10⁸ kPa, I=10⁻⁴ m⁴ (rígida a corte)'],
    ['Momento base teórico', 'M = P·e = 200 kN·m'],
    ['Flecha lateral teórica', 'ux = M·H²/(2EI) = 0.125 m'],
  ],
  modelNotes: [
    'El nodo del tablero **no** tiene elemento propio: queda ligado a la punta de la pila por el **link rígido** (`model.links`), que transmite los 6 GDL con el brazo (penalización, como los diafragmas).',
    'La carga vertical excéntrica se convierte automáticamente en **axial + momento** en la pila gracias al brazo del link.',
    'Verificado equivalente a aplicar **Fz + My = P·e** directamente en la punta (`test_links.mjs`).',
  ],

  figure: { caption: () => 'Pila deformada bajo la carga del tablero excéntrico (×escala): el momento P·e flexiona la pila lateralmente.' },

  compare: {
    intro: 'Momento de empotramiento y flecha lateral de la punta, comparados con la estática elemental de la carga excéntrica.',
    unit: '—', decimals: 4, indexLabel: 'Cantidad',
    rows: [
      { idx: '1', desc: 'Momento base, nodo 1 · |My| [kN·m] = P·e', indep: 200.0, sap: 200.0 },
      { idx: '2', desc: 'Flecha lateral de la punta, nodo 2 · |ux| [m]', indep: 0.125, sap: 0.125 },
    ],
    portico: res => [Math.abs(res.getReaction(1)[4]), Math.abs(res.getNodeDisp(2)[0])],
  },

  extra: `### Por qué importa para puentes

El tablero de un puente se modela en su propio eje (más arriba que las vigas/pilas) y se **acopla** a ellas con links rígidos que respetan el brazo. Así una carga sobre el tablero genera el **momento de excentricidad** correcto en las vigas y pilas — imposible de capturar si se colapsa todo a un solo eje. El mismo mecanismo sirve para *end offsets* (1-010), *insertion points* (1-011) y apoyos excéntricos.

Verificado además en \`test_links.mjs\`: el link reproduce exactamente la carga equivalente Fz+My, cumple la cinemática rígida (uz_tablero = uz_pila − θy·e), el coupling simple iguala un GDL elegido, y todo sobrevive el round-trip \`.s3d\`.`,

  conclusion: 'El link rígido transmite la carga excéntrica del tablero a la pila como **P + M = P·e** con **0.0 %** de error (momento base 200 kN·m, flecha lateral 0.125 m), idéntico a la estática elemental y al modelo equivalente con Fz+My directos. **Capacidad de links/couplings verificada** — habilita el modelado realista de tableros de puente sobre vigas y pilas.',
};
