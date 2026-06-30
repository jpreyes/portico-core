// Caso de verificación 3-005 — Patch test en MALLA LIBRE (planta en L) · #52 (Fase 3).
export default {
  id: '3-005',
  slug: '3-005_malla_libre_L',
  title: 'Malla libre de una planta en L — patch test de membrana',
  capability: 'mallador LIBRE (ear-clipping + Delaunay + refinamiento + recombinación a quad) de un polígono cóncavo arbitrario → malla conforme que pasa el patch test',
  referenceText: 'Patch test de elementos finitos (Irons & Razzaque; MacNeal-Harder): reproducción exacta de un estado de deformación constante en una malla no estructurada.',
  s3d: 'examples/verif_3-005_malla_libre_L.s3d',
  analysis: 'static',
  lcId: null,

  intro: 'Planta en **L** (cóncava, 3 m²) mallada de forma **LIBRE** (sin descomponer en bloques): ear-clipping → flips de Delaunay → refinamiento → **recombinación a cuadriláteros** (malla QUAD-dominante con algún triángulo). Se impone en el borde el campo lineal u = (εₓ·x, −ν·εₓ·y), εₓ = 10⁻⁴ (desplazamiento prescrito #54). Si la malla libre es **conforme** y los elementos están bien construidos, el interior reproduce el campo **exacto** y la tensión es la **constante** teórica (σ₁ = E·εₓ, σ₂ = 0), pese al vértice reentrante y a la mezcla QUAD/triángulo.',
  props: [
    ['Geometría', 'planta en L (cóncava), área 3 m²'],
    ['Malla', 'libre: 10 celdas (6 QUAD + 4 triángulos), h≈1 m'],
    ['E', '2.1·10¹¹ Pa'],
    ['ν', '0.3'],
    ['Campo impuesto', 'u = (εₓ·x, −ν·εₓ·y), εₓ = 10⁻⁴'],
    ['Estado teórico', 'σ₁ = E·εₓ = 2.1·10⁷ Pa, σ₂ = 0'],
  ],
  modelNotes: [
    'La malla la genera `meshPolygonIntoModel` (mesh_free.js): triangulación por **ear-clipping** del polígono cóncavo, **flips de Delaunay**, refinamiento al tamaño h y **recombinación a quad**; luego **suavizado Laplaciano** de los nodos interiores.',
    'El polígono se proyecta a su plano (Newell), se malla en 2D y se mapea de vuelta — sirve para cáscaras inclinadas.',
    'Tensión por sus **invariantes** (σ₁, σ₂): el patch test exige que sean la constante teórica en TODAS las celdas, sean QUAD o triángulo.',
  ],

  figure: { caption: () => 'Planta en L mallada libremente (QUAD-dominante) deformada bajo el campo lineal impuesto (×escala).' },

  compare: {
    intro: 'Tensiones principales de una celda (todas dan el mismo valor constante). El patch test pasa si coinciden con el estado uniaxial teórico.',
    unit: 'Pa', decimals: 1, indexLabel: 'Cantidad',
    rows: [
      { idx: '1', desc: 'σ₁ (principal mayor) = E·εₓ', indep: 2.1e7, sap: 2.1e7 },
      { idx: '2', desc: 'σ₂ (principal menor) ≈ 0', indep: 0.0, sap: 0.0 },
    ],
    portico: res => { const s = res.getAreaStress(1); return [s.s1, s.s2]; },
  },

  extra: `### Por qué valida la malla LIBRE

Un polígono cóncavo con un vértice reentrante no se puede mallar con un solo bloque estructurado. El mallador libre lo triangula, mejora los ángulos (Delaunay), refina al tamaño objetivo y **recombina** pares de triángulos en cuadriláteros. Que el patch test se cumpla **a precisión de máquina** sobre la malla mixta QUAD/triángulo demuestra que todas las celdas son conformes y están bien construidas (numeración, Jacobiano positivo, nodos soldados).

Verificado además en \`test_mesh_free.mjs\`: conservación de área (cuadrado=4, L=3), sin elementos invertidos, los flips de Delaunay no empeoran el ángulo mínimo, el suavizado Laplaciano sube la calidad sin invertir, y el patch test en una L más fina (142 celdas) da σ₁=E·εₓ con error < 10⁻¹⁴.`,

  conclusion: 'El mallador libre genera una malla QUAD-dominante de una planta cóncava en L que **pasa el patch test de membrana a precisión de máquina** (σ₁ = E·εₓ = 2.1·10⁷ Pa, σ₂ ≈ 0) pese al vértice reentrante y a la mezcla QUAD/triángulo. **Malla libre de áreas (#52, Fase 3) verificada.** Con la Fase 2 (métricas + suavizado) el mallador propio liviano queda cerrado para geometrías irregulares simples.',
};
