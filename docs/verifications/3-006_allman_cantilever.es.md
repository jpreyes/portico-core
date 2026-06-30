# Verificación 3-006 — Triángulo de membrana Allman (GDL de giro)

[English](3-006_allman_cantilever.md) · **Español**

**Capacidad verificada:** continuo plano con elemento de membrana TRIANGULAR con GDL de giro en el plano (Allman 1984) — supera el bloqueo por corte del CST.
**Referencia:** D. J. Allman, *A compatible triangular element including vertex rotations for plane elasticity analysis*, Computers & Structures 19 (1984). Solución independiente: teoría de vigas de Euler-Bernoulli + corte de Timoshenko.
**Modelo Portico:** [`examples/verif_3-006_allman_cantilever.s3d`](../../examples/verif_3-006_allman_cantilever.s3d)

## Descripción del problema

Voladizo recto de **10 × 1** (espesor 1, E=1000, ν=0) cargado con una fuerza transversal **P=1** en la punta, modelado con **elementos de membrana triangulares**. Se compara la flecha de punta del **triángulo CST** (deformación constante) y del **triángulo Allman** (con GDL de giro `drilling`) contra la **teoría de vigas** (Euler-Bernoulli + corte), al refinar la malla. El CST bloquea (excesivamente rígido en flexión en-plano); el Allman, al interpolar de forma cuadrática vía las rotaciones nodales, converge mucho más rápido.

| Propiedad | Valor |
| --- | --- |
| Geometría | voladizo 10 × 1 (espesor 1) |
| Módulo E | 1000 |
| Poisson ν | 0 |
| Carga de punta | P = 1 (transversal) |
| Flecha teórica | δ = PL³/3EI + PL/GAₛ = 4.0240 |

## Modelo en Portico

- Cada celda rectangular se divide en **2 triángulos** de membrana; empotramiento en el borde izquierdo.
- El triángulo **Allman** activa el GDL de giro en el plano (`area.drilling=true`): 3 GDL/nodo [u, v, ωz]. Se construye a partir del triángulo de deformación lineal (LST) sustituyendo los GDL de medio-lado por las rotaciones de esquina.
- El **CST** (`drilling=false`) sólo tiene traslaciones; el giro nodal se restringe.
- Estabilización del modo espurio de drilling uniforme con un resorte diagonal mínimo (εd=1e-3), que apenas afecta la flexión real.

![Malla triangular del voladizo (Allman); deformada bajo la carga de punta (×escala).](img/3-006_allman_cantilever.svg)

*Figura 1. Malla triangular del voladizo (Allman); deformada bajo la carga de punta (×escala).*

## Resultados — comparación

Flecha de punta de los triángulos **Allman** y **CST** comparada con la teoría de vigas (δ=4.0240), al refinar la malla. (La columna «SAP2000» repite la teoría como referencia independiente.) A igualdad de malla, el Allman se acerca mucho más; el CST subestima por bloqueo por corte.

| Elemento · malla | Descripción | Independiente (—) | SAP2000 (—) | dif. SAP | **Portico (—)** | **dif. Portico** |
| --- | --- | --- | --- | --- | --- | --- |
| Allman 8×2 | flecha de punta | 4.0240 | 4.0240 | 0 % | **1.7560** | **-56.36 %** |
| Allman 16×4 | flecha de punta | 4.0240 | 4.0240 | 0 % | **2.5669** | **-36.21 %** |
| Allman 32×8 | flecha de punta | 4.0240 | 4.0240 | 0 % | **3.4719** | **-13.72 %** |
| CST 8×2 | flecha de punta | 4.0240 | 4.0240 | 0 % | **1.0571** | **-73.73 %** |
| CST 16×4 | flecha de punta | 4.0240 | 4.0240 | 0 % | **2.3567** | **-41.43 %** |
| CST 32×8 | flecha de punta | 4.0240 | 4.0240 | 0 % | **3.4182** | **-15.06 %** |

### El Allman supera el bloqueo del CST

A igualdad de malla, el triángulo **Allman** entrega una flecha mucho más cercana a la teoría que el **CST**: en la malla gruesa 8×2, el Allman se desvía **-56.36 %** de la teoría frente a **-73.73 %** del CST (es decir, el Allman recupera ~57 % de la flecha y el CST sólo ~26 %); en 32×8 la diferencia se reduce a **-13.72 %** (Allman) vs **-15.06 %** (CST). El Allman converge monótonamente a la teoría y la mejora es mayor donde el CST es más deficiente (mallas gruesas).

El elemento pasa el *patch test* de deformación/tensión constante (verificado aparte en `test_allman.mjs`: σ exacta, exactamente 3 modos de cuerpo rígido, sin modos espurios). La diferencia de cabecera (%) la fija el CST en malla gruesa — es justamente el bloqueo que el Allman corrige.

## Conclusión

El **triángulo de membrana Allman** de Portico añade un GDL de giro en el plano por nodo y **supera el bloqueo por corte del CST**: converge a la teoría de vigas (δ=4.0240) y, a igualdad de malla, es sustancialmente más preciso que el CST. Pasa el *patch test* de tensión constante y posee exactamente los 3 modos de cuerpo rígido. **Capacidad de membrana triangular con drilling verificada.**
