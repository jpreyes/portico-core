// Caso de verificación 2-014 — Gradiente térmico a través del espesor de cáscara (#57).
// Roark & Young 1975 / CSI Example 2-014. Placa anular empotrada en el borde
// exterior, gradiente de 100°F a través del espesor (cara inferior más caliente).
export default {
  id: '2-014',
  slug: '2-014_gradiente_termico_placa',
  title: 'Gradiente térmico a través del espesor (placa anular)',
  capability: 'gradiente de temperatura a través del espesor de placa/cáscara → momento térmico de flexión',
  referenceText: 'CSI *Software Verification — SAP2000*, Example 2-014 (Roark & Young 1975, Tabla 24, ítem 8e).',
  s3d: 'examples/verif_2-014_gradiente_termico.s3d',
  analysis: 'static',
  lcId: 1,

  intro: 'Placa **anular** plana (radio interior 3 in, exterior 30 in, espesor 1 in) **empotrada en el perímetro exterior** y libre en el interior. Se aplica un **gradiente de temperatura de 100 °F a través del espesor** (la cara inferior 100 °F más caliente que la superior), con α = 6.5×10⁻⁶/°F. El gradiente induce una **curvatura térmica** que levanta el borde interno libre. Se comparan el **desplazamiento vertical U_z** y la **rotación R₂** (tangencial) del borde interno con la solución analítica de Roark & Young.',
  props: [
    ['Geometría', 'placa anular r_int=3, r_ext=30, t=1 in'],
    ['Malla', '18×32 (radial × tangencial) de cuadriláteros shell'],
    ['Módulo E', '29 000 k/in²'],
    ['Poisson ν', '0.3 · α = 6.5×10⁻⁶/°F'],
    ['Carga', 'gradiente 100 °F (cara inferior más caliente)'],
  ],
  modelNotes: [
    'Áreas con comportamiento **shell** (membrana + placa MITC4). El gradiente se ingresa como **temperatura por cara** (#57): cara inferior (−z) +100 °F, cara superior (+z) 0 °F.',
    'La diferencia entre caras genera una **curvatura térmica** κ₀ = α·ΔT/t → momento de flexión; la media (50 °F) sólo dilata en el plano (sin efecto al estar la placa restringida).',
    'Empotramiento perfecto del anillo exterior (6 GDL). La cara más caliente abajo levanta el borde interno (+z), como en el original.',
  ],

  figure: { mode: 1, caption: () => 'Placa anular (empotrada en el borde exterior); deformada por el gradiente térmico (×escala) — el borde interno libre se levanta por la curvatura térmica.' },

  compare: {
    intro: 'Desplazamiento y rotación del borde interno (malla 18×32, refinamiento de la malla 9×16 «Model A» del original). Referencia analítica de Roark & Young.',
    unit: 'in · rad', decimals: 5, indexLabel: 'Parámetro',
    rows: [
      { idx: 'U_z', desc: 'Desplazamiento vertical del borde interno', indep: 0.01931, sap: 0.01922 },
      { idx: 'R₂', desc: 'Rotación tangencial del borde interno', indep: 0.00352, sap: 0.00351 },
    ],
    portico: res => { const d = res.getNodeDisp(1); return [d[2], Math.abs(d[4])]; },
  },

  extra: `### Curvatura térmica (#57)

El gradiente impone una curvatura κ₀ = α·ΔT/t = 6.5×10⁻⁶·100/1 = 6.5×10⁻⁴ 1/in. Como la placa está empotrada afuera y libre adentro, esa curvatura levanta el borde interno. La solución de Roark (Tabla 24, 8e, b/a=0.1): U_z = K_y·α·ΔT·a²/t con K_y=0.0330 → **0.01931 in**; R₂ = K_θ·α·ΔT·a/t con K_θ=−0.1805 → **0.00352 rad**.

### Convergencia de malla

El elemento MITC4 (placa gruesa de Mindlin) converge al refinar, como el propio manual CSI documenta (su Model B 28×32 da U_z −2 % / R₂ −1 %):

| Malla | U_z [in] (→0.01931) | R₂ [rad] (→0.00352) |
|---|---|---|
| 9×16  | 0.01859 (−3.7 %) | 0.00320 (−9 %) |
| 18×32 | 0.01905 (−1.3 %) | 0.00342 (−2.8 %) |`,

  conclusion: 'Pórtico reproduce la respuesta de la placa anular al **gradiente térmico a través del espesor** (#57): U_z = 0.01905 in (−1.3 %) y R₂ = 0.00342 rad (−2.8 %) en el borde interno, en línea con la solución analítica (0.01931 / 0.00352) y con SAP2000. La **curvatura térmica de flexión** (momento térmico de placa) queda validada, incluido el **signo físico** (la cara más caliente se alarga y la placa curva hacia ella). **Capacidad de gradiente térmico en áreas verificada.**',
};
