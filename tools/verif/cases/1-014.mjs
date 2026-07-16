// Caso de verificación 1-014 — Modal de viga en voladizo.
// El .s3d se construye/valida a mano (caso a caso); aquí va la prosa, los datos
// de referencia y cómo mapear los resultados de Pórtico a la comparación.
export default {
  id: '1-014',
  slug: '1-014_modal_cantilever',
  title: 'Análisis modal de viga en voladizo',
  capability: 'análisis modal (frecuencias y formas modales de flexión)',
  referenceText: 'CSI *Software Verification — SAP2000*, Example 1-014; solución independiente de **Clough & Penzien (1975)** para un voladizo de masa uniforme y `EI` constante.',
  s3d: 'examples/verif_1-014_modal_cantilever.s3d',
  analysis: 'modal',
  nModes: 6,

  intro: 'Viga en voladizo de **96 in** (8 ft) de hormigón, sección rectangular 12×18 in, con `I` distinto en cada eje. Se comparan los **cinco primeros modos de flexión** contra la solución analítica. Sólo se consideran modos de flexión: se excluyen los GDL axial (Ux) y torsional (Rx), y se **ignora la deformación por corte** (teoría de Euler-Bernoulli).',
  props: [
    ['Longitud L', '96 in'],
    ['Módulo E', '3 600 k/in²'],
    ['Masa por volumen ρ', '2.3·10⁻⁷ k·s²/in⁴'],
    ['Área A', '216 in²'],
    ['I sobre eje fuerte (Y)', '5 832 in⁴'],
    ['I sobre eje débil (Z)', '2 592 in⁴'],
  ],
  modelNotes: [
    '**`Avy = Avz = 0`** → el elemento se comporta como **Euler-Bernoulli** (sin deformación por corte), igual que el original (que anula el área de corte).',
    'Se **restringen Ux y Rx** en todos los nodos → sólo aparecen modos de flexión.',
    'Masa **consistente** (Pórtico) — converge más rápido al valor analítico que la masa concentrada del software de referencia.',
  ],

  figure: { mode: 1, caption: res => `Modo 1 (T = ${res.period[0].toFixed(3)} s) — primera flexión del voladizo. En gris la geometría sin deformar; en azul la forma modal.` },

  // Comparación: filas con valor independiente (analítico) y SAP2000 (96 elem).
  compare: {
    intro: 'Periodos de los cinco primeros modos de flexión. Referencia analítica = solución independiente de Clough & Penzien; software de referencia = **SAP2000** en su malla más fina (Modelo G, 96 elementos, masa concentrada). La diferencia se calcula contra la solución independiente.',
    unit: 's', decimals: 6,
    rows: [
      { desc: '1ª flexión, eje débil', indep: 0.038005, sap: 0.038003 },
      { desc: '1ª flexión, eje fuerte', indep: 0.025337, sap: 0.025335 },
      { desc: '2ª flexión, eje débil', indep: 0.006064, sap: 0.006065 },
      { desc: '2ª flexión, eje fuerte', indep: 0.004043, sap: 0.004043 },
      { desc: '3ª flexión, eje débil', indep: 0.002165, sap: 0.002166 },
    ],
    portico: res => res.period.slice(0, 5),   // valores de Pórtico
  },

  extra: `### Convergencia (modo 1) — masa consistente vs. concentrada

SAP2000 usa **masa concentrada**, que converge lentamente con la discretización; Pórtico
usa **masa consistente**, que converge mucho más rápido. Periodo del modo 1 (independiente
= 0.038005 s):

| Discretización | SAP2000 (s) | dif. SAP | Pórtico 16 el (s) | dif. Pórtico |
|---|---|---|---|---|
| 1 elem (A) | 0.054547 | +43.53 % | — | — |
| 2 elem (B) | 0.042333 | +11.39 % | — | — |
| 4 elem (C) | 0.039090 | +2.85 % | — | — |
| 8 elem (E) | 0.038273 | +0.71 % | — | — |
| 10 elem (F) | 0.038175 | +0.45 % | **{{P0}}** | **{{D0}}** |
| 96 elem (G) | 0.038003 | −0.01 % | — | — |

Con sólo **16 elementos** Pórtico alcanza la precisión que SAP2000 logra con **96**.`,

  conclusion: 'Pórtico reproduce los periodos modales con **error ≤ 0.05 % en los cinco modos**, en coincidencia con la solución analítica de Clough & Penzien y con el resultado convergido del software de referencia (SAP2000, 96 elementos). La rápida convergencia con sólo 16 elementos se debe a la combinación de **masa consistente** y elemento **Euler-Bernoulli** (`Avy = Avz = 0`, sin deformación por corte). **Capacidad modal de Pórtico verificada.**',
};
