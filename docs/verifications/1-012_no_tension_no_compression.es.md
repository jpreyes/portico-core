# Verificación 1-012 — Reticulado arriostrado — límites de tracción / compresión

[English](1-012_no_tension_no_compression.md) · **Español**

**Capacidad verificada:** miembros con límite de tracción (compression-only / puntal) y de compresión (tension-only / cable) en el solver NL-lite.
**Referencia:** CSI *Software Verification — SAP2000*, Example 1-012; independiente por el método de la carga unitaria + estática (Cook & Young 1985).
**Modelo Pórtico:** [`examples/verif_1-012c_no_tension.s3d`](../../examples/verif_1-012c_no_tension.s3d)

## Descripción del problema

Marco arriostrado de un vano y un piso (120 × 120 in) con dos diagonales (aspa, no conectadas en el cruce), bajo una carga horizontal de 100 k en la esquina superior. Viga y diagonales con extremos articulados (reticulado axial). Se prueban los **límites de tracción/compresión** por miembro en tres modelos: **A** sin límites (lineal), **B** sin compresión en la diagonal comprimida (miembro 5 → **cable**, tension-only), **C** sin tracción en la diagonal traccionada (miembro 4 → **puntal**, compression-only, #56). Se comparan el desplazamiento horizontal de la esquina cargada y las reacciones de los apoyos.

| Propiedad | Valor |
| --- | --- |
| Geometría | marco 120 × 120 in, aspa de 2 diagonales |
| Módulo E · Área | E = 30 000 k/in² · A = 8 in² |
| Carga | 100 k horizontal en el nodo 2 (esquina superior izq.) |
| Miembro 4 (diag. 1-4) | traccionada — sin tracción en Model C (puntal) |
| Miembro 5 (diag. 2-3) | comprimida — sin compresión en Model B (cable) |

## Modelo en Pórtico

- Todos los miembros como **barras axiales** (reticulado corotacional NL-lite). El límite «sin tracción» = **`compressionOnly`** (#56); el límite «sin compresión» = **`cable`** (tension-only).
- Los tres modelos se resuelven con el **mismo solver NL-lite**; A en 1 paso (lineal), B y C incrementales (la diagonal limitada se afloja → N=0).
- Apoyos articulados en los nodos 1 y 3. La figura muestra el Model C (puntal): la diagonal traccionada queda suelta y el aspa trabaja sólo a compresión.

![Model C (puntal): deformada bajo la carga horizontal (×escala). La diagonal traccionada se afloja (N=0); el marco resiste por la diagonal comprimida y las columnas.](img/1-012_no_tension_no_compression.svg)

*Figura 1. Model C (puntal): deformada bajo la carga horizontal (×escala). La diagonal traccionada se afloja (N=0); el marco resiste por la diagonal comprimida y las columnas.*

## Resultados — comparación

Desplazamiento horizontal U_x del nodo 2 y reacciones F_x, F_z de los apoyos 1 y 3, para los tres modelos. La referencia independiente coincide exactamente con SAP2000.

| Modelo | Descripción | Independiente (in · kip) | SAP2000 (in · kip) | dif. SAP | **Pórtico (in · kip)** | **dif. Pórtico** |
| --- | --- | --- | --- | --- | --- | --- |
| A | U_x(2) — sin límites (lineal) | 0.1068 | 0.1068 | 0 % | **0.1068** | **0 %** |
| A | F_x(1) | -44.2240 | -44.2240 | 0 % | **-44.2917** | **+0.15 %** |
| A | F_x(3) | -55.7760 | -55.7760 | 0 % | **-55.7083** | **-0.12 %** |
| B | U_x(2) — sin compresión (cable, miembro 5) | 0.2414 | 0.2414 | 0 % | **0.2415** | **+0.05 %** |
| B | F_x(1) | -100.0000 | -100.0000 | 0 % | **-100.1597** | **+0.16 %** |
| B | F_x(3) | 0.0000 | 0.0000 | ≈0 | **0.1597** | **≈0** |
| C | U_x(2) — sin tracción (puntal, miembro 4) | 0.1914 | 0.1914 | 0 % | **0.1913** | **-0.05 %** |
| C | F_x(1) | 0.0000 | 0.0000 | ≈0 | **-0.1594** | **≈0** |
| C | F_x(3) | -100.0000 | -100.0000 | 0 % | **-99.8406** | **-0.16 %** |

### Verticales y equilibrio

En los tres modelos F_z(1) = −100 kip y F_z(3) = +100 kip (la carga horizontal genera un par resistido por las columnas), reproducidos exactamente. Las pequeñas diferencias (<0.6 %) en las reacciones horizontales provienen de la **no linealidad geométrica corotacional** del solver NL-lite frente al análisis de pequeños desplazamientos del original; el desplazamiento y el reparto de fuerzas entre diagonales coinciden.

## Conclusión

Pórtico reproduce los tres modelos del Example 1-012 con **diferencia ≤ 0.6 %**: el reticulado lineal (A), la diagonal **sin compresión** (cable, B → la diagonal comprimida se afloja y la traccionada toma 100√2) y la diagonal **sin tracción** (puntal `compressionOnly`, C → la diagonal traccionada se afloja y la comprimida toma −100√2). Los **límites de tracción/compresión por miembro** (#56) quedan validados contra el manual CSI. **Capacidad de miembros compression-only / tension-only verificada.**
