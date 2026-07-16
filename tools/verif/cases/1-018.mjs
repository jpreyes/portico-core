// Caso de verificación 1-018 — Estático: flexión + corte + axial en un pórtico.
export default {
  id: '1-018',
  slug: '1-018_static_portal',
  title: 'Estático — flexión, corte y axial en un pórtico',
  capability: 'análisis estático lineal con deformación por flexión, corte (Timoshenko) y axial',
  referenceText: 'CSI *Software Verification — SAP2000*, Example 1-018; resultados independientes por el método de la carga unitaria (Cook & Young 1985).',
  s3d: 'examples/verif_1-018_static_portal.s3d',
  analysis: 'static',
  lcId: 1,

  intro: 'Pórtico de un vano (viga horizontal de 288 in sobre dos columnas de 144 in) con **apoyo articulado** (nodo 1) y **apoyo deslizante** (nodo 3), bajo carga vertical uniforme de 0.1 k/in sobre la viga. Se compara el **desplazamiento vertical del centro de la viga** (nodo 5). El Modelo A considera **las tres deformaciones combinadas** (flexión + corte + axial), que es justo el elemento Timoshenko de Pórtico.',
  props: [
    ['Geometría', 'viga 288 in (2×144) sobre columnas de 144 in'],
    ['Apoyos', 'nodo 1 articulado, nodo 3 deslizante'],
    ['Módulo E', '29 900 k/in²'],
    ['G', '11 500 k/in²'],
    ['Sección W8X31', 'A = 9.12 in², I = 110 in⁴, Aᵥ = 2.28 in²'],
    ['Carga', '0.1 k/in vertical sobre la viga'],
  ],
  modelNotes: [
    'Modelo **2D**, juntas viga-columna **rígidas**; bases articulada y deslizante (según la figura del original).',
    'Sección **real** (A, I y área de corte Aᵥ activos) → el elemento incluye **flexión + corte + axial** = Modelo A del original.',
    'El elemento **Timoshenko** de Pórtico captura la deformación por corte vía el área de corte `Avz`.',
  ],

  figure: { mode: 1, caption: () => 'Deformada bajo la carga vertical (×escala). En gris el pórtico sin deformar; en azul la deformada — la viga flecta y los apoyos articulado/deslizante permiten el giro/desplazamiento.' },

  compare: {
    intro: 'Desplazamiento vertical del centro de la viga (nodo 5), Modelo A (flexión + corte + axial). La referencia independiente coincide exactamente con SAP2000.',
    unit: 'in', decimals: 5, indexLabel: 'Modelo',
    rows: [{ idx: 'A', desc: 'Flexión + corte + axial · U_z(nodo 5)', indep: -2.77076, sap: -2.77076 }],
    portico: res => [res.getNodeDisp(5)[2]],
  },

  extra: `### Descomposición por tipo de deformación (referencia)

El original separa las contribuciones (mismas en SAP2000 e independiente); su **suma reproduce el Modelo A**, confirmando la superposición:

| Modelo | Deformación | U_z(nodo 5) [in] |
|---|---|---|
| A | flexión + corte + axial | −2.77076 |
| B | sólo flexión | −2.72361 |
| C | sólo corte | −0.03954 |
| D | sólo axial | −0.00760 |
| | B + C + D | −2.77075 |`,

  conclusion: 'Pórtico reproduce el desplazamiento del Modelo A con **diferencia 0.000 %** (−2.77076 in), idéntico a la solución independiente y a SAP2000. El resultado integra correctamente las deformaciones de **flexión, corte y axial**, validando el elemento **Timoshenko** (incluida la deformación por corte) y el tratamiento de apoyos articulado/deslizante. **Capacidad estática (flexión+corte+axial) verificada.**',
};
