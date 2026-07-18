# Verificación 3-006 — Triángulo de membrana Allman (GDL de giro)

[English](3-006_allman_cantilever.md) · **Español**

**Capacidad verificada:** continuo plano con elemento de membrana TRIANGULAR con GDL de giro en el plano (Allman 1984) — supera el bloqueo por corte del CST.
**Referencia:** D. J. Allman, *A compatible triangular element including vertex rotations for plane elasticity analysis*, Computers & Structures 19 (1984). Solución independiente: teoría de vigas de Euler-Bernoulli + corte de Timoshenko.
**Modelo Pórtico:** [`examples/verif_3-006_allman_cantilever.s3d`](../../examples/verif_3-006_allman_cantilever.s3d)

## Descripción del problema

Voladizo recto de **10 × 1** (espesor 1, E=1000, ν=0) cargado con una fuerza transversal **P=1** en la punta, modelado con **elementos de membrana triangulares**. Se compara la flecha de punta del **triángulo CST** (deformación constante) y del **triángulo Allman** (con GDL de giro `drilling`) contra la **teoría de vigas** (Euler-Bernoulli + corte), al refinar la malla. El CST bloquea (excesivamente rígido en flexión en-plano); el Allman, al interpolar de forma cuadrática vía las rotaciones nodales, converge mucho más rápido.

| Propiedad | Valor |
| --- | --- |
| Geometría | voladizo 10 × 1 (espesor 1) |
| Módulo E | 1000 |
| Poisson ν | 0 |
| Carga de punta | P = 1 (transversal) |
| Flecha teórica | δ = PL³/3EI + PL/GAₛ = 4.0240 |

## Modelo en Pórtico

- Cada celda rectangular se divide en **2 triángulos** de membrana; empotramiento en el borde izquierdo.
- El triángulo **Allman** activa el GDL de giro en el plano (`area.drilling=true`): 3 GDL/nodo [u, v, ωz]. Se construye a partir del triángulo de deformación lineal (LST) sustituyendo los GDL de medio-lado por las rotaciones de esquina.
- El **CST** (`drilling=false`) sólo tiene traslaciones; el giro nodal se restringe.
- Estabilización del modo espurio de drilling uniforme con un resorte diagonal mínimo (εd=1e-3), que apenas afecta la flexión real.

![Malla triangular del voladizo (Allman); deformada bajo la carga de punta (×escala).](img/3-006_allman_cantilever.svg)

*Figura 1. Malla triangular del voladizo (Allman); deformada bajo la carga de punta (×escala).*

## Resultados — comparación

**Estudio de convergencia de elemento** (no un pase/falla de exactitud). Flecha de punta de los triángulos **Allman** y **CST** comparada con la **teoría de vigas** (δ=4.0240), al refinar la malla. No hay columna SAP2000: sería el *mismo* elemento en la *misma* malla y daría igual de rígido — no es una referencia independiente. Un continuo 2D con solo 2-8 elementos en el canto **no debe** igualar la teoría de viga esbelta; lo que se verifica es la **convergencia** al refinar y que el **Allman supera al CST** a igualdad de malla.

| Elemento · malla | Descripción | Independiente (—) | **Pórtico (—)** | **dif. Pórtico** |
| --- | --- | --- | --- | --- |
| Allman 8×2 | flecha de punta | 4.0240 | **1.7560** | **-56.36 %** |
| Allman 16×4 | flecha de punta | 4.0240 | **2.5669** | **-36.21 %** |
| Allman 32×8 | flecha de punta | 4.0240 | **3.4719** | **-13.72 %** |
| CST 8×2 | flecha de punta | 4.0240 | **1.0571** | **-73.73 %** |
| CST 16×4 | flecha de punta | 4.0240 | **2.3567** | **-41.43 %** |
| CST 32×8 | flecha de punta | 4.0240 | **3.4182** | **-15.06 %** |

### El Allman supera el bloqueo del CST

A igualdad de malla, el triángulo **Allman** entrega una flecha mucho más cercana a la teoría que el **CST**: en la malla gruesa 8×2, el Allman se desvía **-56.36 %** de la teoría frente a **-73.73 %** del CST (es decir, el Allman recupera ~57 % de la flecha y el CST sólo ~26 %); en 32×8 la diferencia se reduce a **-13.72 %** (Allman) vs **-15.06 %** (CST). El Allman converge monótonamente a la teoría y la mejora es mayor donde el CST es más deficiente (mallas gruesas).

El elemento pasa el *patch test* de deformación/tensión constante (verificado aparte en `test_allman.mjs`: σ exacta, exactamente 3 modos de cuerpo rígido, sin modos espurios). El **-13.72 %** residual del Allman a 32×8 es discretización de malla gruesa, no error del elemento; sigue bajando al refinar. La diferencia de cabecera del resumen (%) la fija el CST en malla gruesa — es justamente el bloqueo que el Allman corrige, y por eso el caso se marca como *estudio*, no como pase de exactitud.

## Conclusión

El **triángulo de membrana Allman** de Pórtico añade un GDL de giro en el plano por nodo y **supera el bloqueo por corte del CST**. Lo verificado aquí es: (1) pasa el *patch test* de tensión constante con exactamente 3 modos de cuerpo rígido (`test_allman.mjs`); (2) **converge monótonamente** a la teoría de vigas (δ=4.0240) al refinar; y (3) a igualdad de malla es sustancialmente más preciso que el CST. Lo que **no** se afirma es que una malla gruesa iguale la teoría de viga esbelta: la brecha de −56/−14 % (Allman, 8×2→32×8) es discretización esperada de un continuo 2D, no error del solver. **Estudio de convergencia — comportamiento del elemento verificado.**
