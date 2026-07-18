# Verificación 1-030 — Líneas de influencia y carga móvil — viga simple

[English](1-030_influence_lines.md) · **Español**

**Capacidad verificada:** cargas móviles: barrido de posiciones, líneas de influencia y envolventes de esfuerzos/reacciones.
**Referencia:** Líneas de influencia clásicas de la viga simplemente apoyada (Hibbeler, *Structural Analysis*); base de CSiBridge para tránsito.
**Modelo Pórtico:** [`examples/verif_1-030_influence_lines.s3d`](../../examples/verif_1-030_influence_lines.s3d)

## Descripción del problema

Viga simplemente apoyada de 24 m (6 elementos). Una **carga unitaria móvil** recorre la pista (los 6 elementos) y se registran las **líneas de influencia** de la **reacción del apoyo izquierdo** y del **momento en el centro de luz**. Para la viga simple ambas tienen forma exacta conocida: la reacción es la recta R(x) = 1 − x/L (de 1 a 0) y el momento de centro es un **triángulo** de pico **L/4** en el centro. Es la base del análisis de puentes a tránsito (CSiBridge).

| Propiedad | Valor |
| --- | --- |
| Luz | L = 24 m (6 × 4 m) |
| Apoyos | articulado (nodo 1) + rodillo (nodo 7) |
| Carga | unitaria móvil (↓) sobre la pista |
| LI reacción izq. | R(x) = 1 − x/L |
| LI momento centro | triángulo, pico L/4 = 6.0 en x = L/2 |

## Modelo en Pórtico

- Modelo **2D**; la carga puntual móvil se reparte a los nodos del elemento que la contiene por **funciones de forma consistentes** (Hermite) → respuesta nodal exacta.
- K se **factoriza una vez** (constante) y sólo se rearma el vector de carga por posición → barrido eficiente.
- El momento de centro se lee en el nodo central tomando la **menor magnitud** de los dos elementos contiguos (lado no cargado = exacto).

![Viga simplemente apoyada y su pista de carga (6 elementos). La carga unitaria recorre la pista para construir las líneas de influencia.](img/1-030_influence_lines.svg)

*Figura 1. Viga simplemente apoyada y su pista de carga (6 elementos). La carga unitaria recorre la pista para construir las líneas de influencia.*

## Resultados — comparación

Valores característicos de las líneas de influencia, comparados con la solución exacta de la viga simple.

| Cantidad | Descripción | Independiente (—) | SAP2000 (—) | dif. SAP | **Pórtico (—)** | **dif. Pórtico** |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | LI reacción izquierda con la carga sobre el apoyo (x=0) | 1.0000 | 1.0000 | 0 % | **1.0000** | **0 %** |
| 2 | Pico de la LI de momento en el centro (= L/4) [kN·m·] | 6.0000 | 6.0000 | 0 % | **6.0000** | **0 %** |

### Forma completa de las líneas de influencia

| Posición de la carga | LI reacción izq. (exacta 1−x/L) | LI momento centro (exacta) |
|---|---|---|
| x = 0 (apoyo izq.) | 1.000 | 0.0 |
| x = L/4 | 0.750 | L/8 = 3.0 |
| x = L/2 (centro) | 0.500 | **L/4 = 6.0** (pico) |
| x = L (apoyo der.) | 0.000 | 0.0 |

Verificado en `test_moving.mjs`: la LI de reacción coincide con 1−x/L (error < 10⁻¹⁴), el pico de la LI de momento ocurre exactamente en x = L/2 y vale L/4, y la **envolvente** de un tren de 2 ejes supera a la de un eje único (la carga móvil real produce mayor momento).

## Conclusión

El barrido de cargas móviles reproduce con **0.0 %** de error las líneas de influencia exactas de la viga simple: reacción izquierda = 1 (carga sobre el apoyo) y pico de momento de centro = L/4 = 6.0 kN·m en x = L/2. El motor calcula además **envolventes** de trenes de cargas multi-eje. **Capacidad de cargas móviles / líneas de influencia (#61) verificada.**
