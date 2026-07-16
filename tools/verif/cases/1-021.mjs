// Caso de verificación 1-021 — Modal (autovalores) del pórtico Bathe-Wilson.
export default {
  id: '1-021',
  slug: '1-021_modal_bathe_wilson',
  title: 'Análisis modal — pórtico Bathe-Wilson (10 vanos × 9 pisos)',
  capability: 'análisis modal de un pórtico plano grande (autovalores ω²)',
  referenceText: 'CSI *Software Verification — SAP2000*, Example 1-021; soluciones independientes de **Bathe & Wilson (1972)** y **Peterson (1981)**.',
  s3d: 'examples/verif_1-021_modal_bathe_wilson.s3d',
  analysis: 'modal',
  nModes: 3,

  intro: 'Pórtico plano de **10 vanos × 9 pisos** (10 @ 20 ft = 200 ft de ancho, 9 @ 10 ft = 90 ft de alto), base empotrada — el benchmark clásico de Bathe & Wilson 1972. Se comparan los **tres primeros autovalores** (ω²). Se consideran deformaciones de **flexión y axial** (la deformación por corte se ignora, área de corte = 0).',
  props: [
    ['Geometría', '10 vanos @ 20 ft × 9 pisos @ 10 ft'],
    ['Módulo E', '432 000 k/ft²'],
    ['Área A', '3 ft²'],
    ['Inercia I', '1 ft⁴'],
    ['Masa por unidad de longitud', '3 k·s²/ft²'],
    ['Elementos', '189 (99 columnas + 90 vigas)'],
  ],
  modelNotes: [
    'Modelo **2D** (un elemento por miembro), base empotrada.',
    '**`Avy = Avz = 0`** → sin deformación por corte (igual que el original); **axial incluido**.',
    'Masa por longitud = `ρ·A` con `ρ = 1`, `A = 3` → 3 k·s²/ft². Masa **consistente**.',
  ],

  figure: { mode: 1, caption: res => `Modo 1 (ω² = ${res.omega2[0].toFixed(4)}, T = ${res.period[0].toFixed(2)} s) — primer modo de oscilación lateral del pórtico.` },

  compare: {
    intro: 'Tres primeros autovalores ω². SAP2000 coincide exactamente con las soluciones independientes; la diferencia se calcula contra ese valor.',
    unit: 'ω²', decimals: 4,
    rows: [
      { desc: '1er modo', indep: 0.589541, sap: 0.589541 },
      { desc: '2º modo', indep: 5.52696, sap: 5.52696 },
      { desc: '3er modo', indep: 16.5879, sap: 16.5879 },
    ],
    portico: res => res.omega2.slice(0, 3),
    opensees: r => r.omega2.slice(0, 3),
  },

  conclusion: 'Pórtico reproduce el **primer autovalor con +0.05 %** (esencialmente exacto) y el 2º y 3º dentro de **+0.5 % y +1.2 %**. Las pequeñas diferencias en los modos superiores reflejan la formulación de **masa consistente** de Pórtico frente al modelo de masa del benchmark (la subdivisión adicional de los miembros no las reduce, confirmando que no son error de discretización). El solver modal por iteración de subespacio resuelve correctamente un pórtico plano grande (110 nodos). **Capacidad modal en pórticos verificada.**',
};
