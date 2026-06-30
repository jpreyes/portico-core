// Caso de verificación 1-017 — Vibración de una cuerda tensa (modal con Kg, #55).
// CSI Example 1-017. Cuerda de 100 in tensada a 0.5 k; las 3 primeras frecuencias
// salen de un modal sobre K+Kg (rigidización por tracción), no de la flexión.
export default {
  id: '1-017',
  slug: '1-017_cuerda_tensa',
  title: 'Vibración de una cuerda bajo tensión (modal con rigidez geométrica)',
  capability: 'análisis modal con rigidez geométrica Kg desde un estado de referencia (rigidización por tracción / pre-esfuerzo)',
  referenceText: 'CSI *Software Verification — SAP2000*, Example 1-017; independiente por la teoría de cuerda vibrante (Kreyszig 1983, pp. 506-510).',
  s3d: 'examples/verif_1-017_cuerda_tensa.s3d',
  analysis: 'modalKg',
  refLcId: 1,
  nModes: 3,

  intro: 'Una cuerda flexible de 100 in, anclada en ambos extremos y **tensada a 0.5 k**, vibra lateralmente. Las tres primeras frecuencias provienen de la **rigidez geométrica por tracción** (la cuerda casi no tiene rigidez a flexión: alambre de 1/16"). Se modela como una barra discretizada en 10 elementos; la tensión se aplica con una carga estática (0.5 k axial en el extremo móvil) que genera el **estado de referencia para Kg**, y el modal se corre sobre **K + Kg(estado)** (#55). Se comparan f₁, f₂, f₃ con la teoría de cuerda vibrante.',
  props: [
    ['Geometría', 'cuerda de 100 in, 10 elementos'],
    ['Sección', 'alambre 1/16" Ø, A = 0.00306796 in²'],
    ['Módulo E', '30 000 k/in²'],
    ['Masa por volumen', '7.324×10⁻⁷ k·s²/in⁴'],
    ['Tensión', 'T = 0.5 k (carga axial de referencia)'],
  ],
  modelNotes: [
    'La **tensión** se introduce con un caso estático (F_x = 0.5 k en el extremo libre axialmente) → estado de referencia con N = +0.5 k uniforme.',
    'El modal corre sobre **K + Kg** con el toggle «incluir rigidez geométrica P-Δ» (#55): la tracción rigidiza los modos laterales. Sin Kg, la cuerda (EI≈0) no tendría rigidez transversal.',
    'Frecuencia analítica de cuerda: f_n = (n/2L)·√(T/μ), con μ = ρ·A la masa por unidad de longitud.',
  ],

  figure: { mode: 1, caption: () => 'Primer modo lateral de la cuerda tensa (×escala) — media onda senoidal, rigidez aportada íntegramente por la tracción (Kg).' },

  compare: {
    intro: 'Tres primeras frecuencias de la cuerda tensa. La referencia independiente es la teoría de cuerda vibrante (Kreyszig). El modal de Pórtico usa K+Kg del estado tensado.',
    unit: 'Hz', decimals: 3, indexLabel: 'Modo',
    rows: [
      { idx: 'f₁', desc: 'Primer modo (media onda)', indep: 74.586, sap: 74.579 },
      { idx: 'f₂', desc: 'Segundo modo (onda completa)', indep: 149.17, sap: 148.93 },
      { idx: 'f₃', desc: 'Tercer modo (1½ onda)', indep: 223.76, sap: 222.06 },
    ],
    portico: res => res.freq.slice(0, 3),
  },

  extra: `### Rigidización por tracción (Kg)

La cuerda casi no resiste flexión (EI del alambre de 1/16" ≈ 0); toda la rigidez lateral proviene de la **tracción**: la matriz Kg (ensamblada con N = +0.5 k del estado de referencia) se suma a K antes del modal. Es el mecanismo de **modal con rigidez geométrica** (#55), análogo al «modal sobre un caso no lineal con P-Δ» de SAP2000.

La frecuencia teórica f_n = (n/2L)·√(T/μ) = 74.586·n Hz da 74.586 / 149.17 / 223.76 Hz.

### Masa consistente vs concentrada

Con sólo 10 elementos y **masa consistente**, Pórtico alcanza la solución analítica (dif ≤ 0.02 %), superando al Model A de SAP2000 (10 elementos, masa **concentrada**: f₃ −0.76 %) e igualando su Model B (100 elementos). El refinamiento a 100 elementos no cambia el resultado de Pórtico.`,

  conclusion: 'Pórtico reproduce las tres primeras frecuencias de la cuerda tensa con **diferencia ≤ 0.02 %** (74.587 / 149.18 / 223.80 Hz vs 74.586 / 149.17 / 223.76 Hz analíticos), con sólo 10 elementos. El **modal con rigidez geométrica Kg** (#55) —donde la rigidez lateral proviene íntegramente de la tracción del estado de referencia— queda validado contra la teoría de cuerda vibrante. **Capacidad de modal con Kg / pre-esfuerzo verificada.**',
};
