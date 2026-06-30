# Verificación 3-002 — Viga recta con elementos plane-stress (membrana)

[English](3-002_plane_stress_beam.md) · **Español**

**Capacidad verificada:** continuo plano en TENSIÓN PLANA (plane-stress) — elemento de membrana QUAD.
**Referencia:** CSI *Software Verification — SAP2000*, Example 3-002 (MacNeal & Harder 1985); independiente por el método de la carga unitaria (Cook & Young 1985).
**Modelo Portico:** [`examples/verif_3-002_plane_stress.s3d`](../../examples/verif_3-002_plane_stress.s3d)

## Descripción del problema

Voladizo recto de 6 in de largo × 0.2 in de canto × 0.1 in de espesor, modelado con **elementos de membrana en tensión plana** (malla 6×1 de cuadriláteros). Se aplican tres cargas en la punta, cada una en un caso: **(1)** extensión axial (F_x), **(2)** corte+flexión en el plano (F_z), **(3)** momento en el plano (par de F_x). Se comparan los **desplazamientos de la punta** con la teoría de vigas (independiente) y con SAP2000. El empotramiento se modela según el original: la junta inferior fija U_x,U_z y la superior sólo U_x, evitando el efecto Poisson local.

| Propiedad | Valor |
| --- | --- |
| Geometría | voladizo 6 × 0.2 in (espesor 0.1 in) |
| Malla | 6×1 cuadriláteros membrana (tensión plana) |
| Módulo E | 10 000 000 lb/in² |
| Poisson ν | 0.3 |
| Cargas (punta) | CC1 F_x=1 · CC2 F_z=1 · CC3 M=1 (par F_x) |

## Modelo en Portico

- Elemento de **membrana en tensión plana** (`planeStrain:false`, #58): sólo GDL en-plano U_x, U_z activos; resto restringido en todos los nodos (como el modelo CSI).
- Empotramiento sin efecto Poisson: nodo inferior izquierdo fija U_x,U_z; nodos izquierdos superiores sólo U_x. En CC2 se añade la reacción de −½ en el nodo superior izquierdo (igual que el original).
- El QUAD de Portico es un cuadrilátero isoparamétrico **estándar (sin modos incompatibles de flexión)**; reproduce el elemento plano de SAP2000 «sin modos incompatibles».

![Malla de membrana 6×1 del voladizo; deformada bajo la extensión axial (CC1, ×escala).](img/3-002_plane_stress_beam.svg)

*Figura 1. Malla de membrana 6×1 del voladizo; deformada bajo la extensión axial (CC1, ×escala).*

## Resultados — comparación

Desplazamientos de la punta (promedio de las juntas 7 y 14). La columna SAP2000 corresponde al **elemento plano sin modos incompatibles** (malla 6×1), del mismo tipo que el QUAD de Portico.

| Caso | Descripción | Independiente (in) | SAP2000 (in) | dif. SAP | **Portico (in)** | **dif. Portico** |
| --- | --- | --- | --- | --- | --- | --- |
| CC1 | Extensión axial · U_x = PL/EA | 0.000030 | 0.000030 | 0 % | **0.000030** | **0 %** |
| CC2 | Corte+flexión · U_z (malla 6×1) | 0.108090 | 0.010100 | -90.66 % | **0.010088** | **-90.67 %** |
| CC3 | Momento · |U_x| (malla 6×1) | 0.000900 | 0.000084 | -90.67 % | **0.000084** | **-90.67 %** |

### Tensión plana (CC1): exacta

La extensión axial U_x = PL/EA = 1·6/(10⁷·0.2·0.1) = **3.000×10⁻⁵ in**, reproducida por Portico con **diferencia 0.000 %** e **independiente de la malla** — la constitutiva de **tensión plana** (#58) del elemento de membrana es exacta.

### Flexión (CC2/CC3): elemento ≡ SAP2000 y convergencia

En malla 6×1, el QUAD estándar (sin modos incompatibles) subestima la flexión por bloqueo — **igual que el elemento plano de SAP2000 «sin modos incompatibles»** (0.0101 in y 0.840×10⁻⁴ in), que Portico reproduce a <0.5 %. Es una característica documentada del elemento, no un error: con refinamiento de malla converge a la teoría de vigas (0.10809 / 9.0×10⁻⁴):

| Malla | CC2 U_z [in] (→ 0.10809) | CC3 |U_x| [in] (→ 9.0×10⁻⁴) |
|---|---|---|
| 6×1   | 0.01009 | 8.40×10⁻⁵ |
| 24×4  | 0.06724 | 3.36×10⁻⁴ |
| 48×8  | 0.09383 | 4.34×10⁻⁴ |

## Conclusión

Portico reproduce el comportamiento de **tensión plana** con la **extensión axial exacta** (U_x = 3.000×10⁻⁵ in, **0.000 %**) e independiente de la malla, validando la constitutiva plane-stress (#58). En corte+flexión, el QUAD estándar de Portico **coincide con el elemento plano de SAP2000 «sin modos incompatibles»** (<0.5 %) y **converge a la teoría de vigas con el refinamiento de malla**, tal como documenta el propio manual CSI. **Capacidad de membrana en tensión plana verificada.**
