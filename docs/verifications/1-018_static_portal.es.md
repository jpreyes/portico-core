# Verificación 1-018 — Estático — flexión, corte y axial en un pórtico

[English](1-018_static_portal.md) · **Español**

**Capacidad verificada:** análisis estático lineal con deformación por flexión, corte (Timoshenko) y axial.
**Referencia:** CSI *Software Verification — SAP2000*, Example 1-018; resultados independientes por el método de la carga unitaria (Cook & Young 1985).
**Modelo Portico:** [`examples/verif_1-018_static_portal.s3d`](../../examples/verif_1-018_static_portal.s3d)

## Descripción del problema

Portico de un vano (viga horizontal de 288 in sobre dos columnas de 144 in) con **apoyo articulado** (nodo 1) y **apoyo deslizante** (nodo 3), bajo carga vertical uniforme de 0.1 k/in sobre la viga. Se compara el **desplazamiento vertical del centro de la viga** (nodo 5). El Modelo A considera **las tres deformaciones combinadas** (flexión + corte + axial), que es justo el elemento Timoshenko de Portico.

| Propiedad | Valor |
| --- | --- |
| Geometría | viga 288 in (2×144) sobre columnas de 144 in |
| Apoyos | nodo 1 articulado, nodo 3 deslizante |
| Módulo E | 29 900 k/in² |
| G | 11 500 k/in² |
| Sección W8X31 | A = 9.12 in², I = 110 in⁴, Aᵥ = 2.28 in² |
| Carga | 0.1 k/in vertical sobre la viga |

## Modelo en Portico

- Modelo **2D**, juntas viga-columna **rígidas**; bases articulada y deslizante (según la figura del original).
- Sección **real** (A, I y área de corte Aᵥ activos) → el elemento incluye **flexión + corte + axial** = Modelo A del original.
- El elemento **Timoshenko** de Portico captura la deformación por corte vía el área de corte `Avz`.

![Deformada bajo la carga vertical (×escala). En gris el pórtico sin deformar; en azul la deformada — la viga flecta y los apoyos articulado/deslizante permiten el giro/desplazamiento.](img/1-018_static_portal.svg)

*Figura 1. Deformada bajo la carga vertical (×escala). En gris el pórtico sin deformar; en azul la deformada — la viga flecta y los apoyos articulado/deslizante permiten el giro/desplazamiento.*

## Resultados — comparación

Desplazamiento vertical del centro de la viga (nodo 5), Modelo A (flexión + corte + axial). La referencia independiente coincide exactamente con SAP2000.

| Modelo | Descripción | Independiente (in) | SAP2000 (in) | dif. SAP | **Portico (in)** | **dif. Portico** |
| --- | --- | --- | --- | --- | --- | --- |
| A | Flexión + corte + axial · U_z(nodo 5) | -2.77076 | -2.77076 | 0 % | **-2.77076** | **0 %** |

### Descomposición por tipo de deformación (referencia)

El original separa las contribuciones (mismas en SAP2000 e independiente); su **suma reproduce el Modelo A**, confirmando la superposición:

| Modelo | Deformación | U_z(nodo 5) [in] |
|---|---|---|
| A | flexión + corte + axial | −2.77076 |
| B | sólo flexión | −2.72361 |
| C | sólo corte | −0.03954 |
| D | sólo axial | −0.00760 |
| | B + C + D | −2.77075 |

## Conclusión

Portico reproduce el desplazamiento del Modelo A con **diferencia 0.000 %** (−2.77076 in), idéntico a la solución independiente y a SAP2000. El resultado integra correctamente las deformaciones de **flexión, corte y axial**, validando el elemento **Timoshenko** (incluida la deformación por corte) y el tratamiento de apoyos articulado/deslizante. **Capacidad estática (flexión+corte+axial) verificada.**
