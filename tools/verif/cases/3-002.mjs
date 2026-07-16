// Caso de verificación 3-002 — Viga recta modelada con elementos PLANE-STRESS (#58).
// MacNeal-Harder 1985 / CSI Example 3-002. Voladizo 6×0.2 in, malla 6×1 de QUADs
// membrana, 3 casos de carga (axial, corte+flexión, momento) en la punta.
const TIP = [7, 14];   // nodos de la punta (malla 6×1)
const avg = (res, comp) => TIP.reduce((s, j) => s + res.getNodeDisp(j)[comp], 0) / TIP.length;
const avgAbs = (res, comp) => TIP.reduce((s, j) => s + Math.abs(res.getNodeDisp(j)[comp]), 0) / TIP.length;

export default {
  id: '3-002',
  slug: '3-002_plane_stress_beam',
  title: 'Viga recta con elementos plane-stress (membrana)',
  capability: 'continuo plano en TENSIÓN PLANA (plane-stress) — elemento de membrana QUAD',
  referenceText: 'CSI *Software Verification — SAP2000*, Example 3-002 (MacNeal & Harder 1985); independiente por el método de la carga unitaria (Cook & Young 1985).',
  s3d: 'examples/verif_3-002_plane_stress.s3d',
  analysis: 'static',
  lcIds: [1, 2, 3],

  intro: 'Voladizo recto de 6 in de largo × 0.2 in de canto × 0.1 in de espesor, modelado con **elementos de membrana en tensión plana** (malla 6×1 de cuadriláteros). Se aplican tres cargas en la punta, cada una en un caso: **(1)** extensión axial (F_x), **(2)** corte+flexión en el plano (F_z), **(3)** momento en el plano (par de F_x). Se comparan los **desplazamientos de la punta** con la teoría de vigas (independiente) y con SAP2000. El empotramiento se modela según el original: la junta inferior fija U_x,U_z y la superior sólo U_x, evitando el efecto Poisson local.',
  props: [
    ['Geometría', 'voladizo 6 × 0.2 in (espesor 0.1 in)'],
    ['Malla', '6×1 cuadriláteros membrana (tensión plana)'],
    ['Módulo E', '10 000 000 lb/in²'],
    ['Poisson ν', '0.3'],
    ['Cargas (punta)', 'CC1 F_x=1 · CC2 F_z=1 · CC3 M=1 (par F_x)'],
  ],
  modelNotes: [
    'Elemento de **membrana en tensión plana** (`planeStrain:false`, #58): sólo GDL en-plano U_x, U_z activos; resto restringido en todos los nodos (como el modelo CSI).',
    'Empotramiento sin efecto Poisson: nodo inferior izquierdo fija U_x,U_z; nodos izquierdos superiores sólo U_x. En CC2 se añade la reacción de −½ en el nodo superior izquierdo (igual que el original).',
    'El QUAD de Pórtico es un cuadrilátero isoparamétrico **estándar (sin modos incompatibles de flexión)**; reproduce el elemento plano de SAP2000 «sin modos incompatibles».',
  ],

  figure: { mode: 1, caption: () => 'Malla de membrana 6×1 del voladizo; deformada bajo la extensión axial (CC1, ×escala).' },

  compare: {
    intro: 'Desplazamientos de la punta (promedio de las juntas 7 y 14). La columna SAP2000 corresponde al **elemento plano sin modos incompatibles** (malla 6×1), del mismo tipo que el QUAD de Pórtico.',
    unit: 'in', decimals: 6, indexLabel: 'Caso',
    rows: [
      { idx: 'CC1', desc: 'Extensión axial · U_x = PL/EA', indep: 3.000e-5, sap: 3.000e-5 },
      { idx: 'CC2', desc: 'Corte+flexión · U_z (malla 6×1)', indep: 0.108090, sap: 0.0101 },
      { idx: 'CC3', desc: 'Momento · |U_x| (malla 6×1)', indep: 9.000e-4, sap: 0.840e-4 },
    ],
    portico: (_res, out) => {
      const r1 = out.resById.get(1), r2 = out.resById.get(2), r3 = out.resById.get(3);
      return [avg(r1, 0), avg(r2, 2), avgAbs(r3, 0)];
    },
  },

  extra: `### Tensión plana (CC1): exacta

La extensión axial U_x = PL/EA = 1·6/(10⁷·0.2·0.1) = **3.000×10⁻⁵ in**, reproducida por Pórtico con **diferencia 0.000 %** e **independiente de la malla** — la constitutiva de **tensión plana** (#58) del elemento de membrana es exacta.

### Flexión (CC2/CC3): elemento ≡ SAP2000 y convergencia

En malla 6×1, el QUAD estándar (sin modos incompatibles) subestima la flexión por bloqueo — **igual que el elemento plano de SAP2000 «sin modos incompatibles»** (0.0101 in y 0.840×10⁻⁴ in), que Pórtico reproduce a <0.5 %. Es una característica documentada del elemento, no un error: con refinamiento de malla converge a la teoría de vigas (0.10809 / 9.0×10⁻⁴):

| Malla | CC2 U_z [in] (→ 0.10809) | CC3 |U_x| [in] (→ 9.0×10⁻⁴) |
|---|---|---|
| 6×1   | 0.01009 | 8.40×10⁻⁵ |
| 24×4  | 0.06724 | 3.36×10⁻⁴ |
| 48×8  | 0.09383 | 4.34×10⁻⁴ |`,

  conclusion: 'Pórtico reproduce el comportamiento de **tensión plana** con la **extensión axial exacta** (U_x = 3.000×10⁻⁵ in, **0.000 %**) e independiente de la malla, validando la constitutiva plane-stress (#58). En corte+flexión, el QUAD estándar de Pórtico **coincide con el elemento plano de SAP2000 «sin modos incompatibles»** (<0.5 %) y **converge a la teoría de vigas con el refinamiento de malla**, tal como documenta el propio manual CSI. **Capacidad de membrana en tensión plana verificada.**',
};
