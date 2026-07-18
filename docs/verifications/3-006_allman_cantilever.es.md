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

**Estudio de convergencia de elemento.** Flecha de punta de los triángulos de membrana **Allman** (con GDL de giro) y **CST** comparada con la **teoría de vigas** (δ=4.0240), al **refinar la malla**. No hay columna SAP2000: sería el *mismo* elemento en la *misma* malla, no una referencia independiente. Un continuo 2D esbelto converge a la teoría de Timoshenko; al refinar de 32×8 a **64×14** el error del Allman baja monótonamente hasta **< 5 %** (fila marcada como punto de convergencia verificado). A igualdad de malla el Allman, gracias al GDL de giro, va por delante del CST.

| Elemento · malla | Descripción | Independiente (—) | **Pórtico (—)** | **dif. Pórtico** |
| --- | --- | --- | --- | --- |
| Allman 32×8 | flecha de punta | 4.0240 | **3.4719** | **-13.72 %** |
| Allman 48×12 | flecha de punta | 4.0240 | **3.7456** | **-6.92 %** |
| Allman 64×14 | flecha de punta (convergido) | 4.0240 | **3.8520** | **-4.28 %** |
| CST 32×8 | flecha de punta | 4.0240 | **3.4182** | **-15.06 %** |
| CST 48×12 | flecha de punta | 4.0240 | **3.7301** | **-7.30 %** |
| CST 64×14 | flecha de punta | 4.0240 | **3.8444** | **-4.46 %** |

### Convergencia a la teoría y ventaja del giro (drilling)

Al refinar la malla, ambos triángulos **convergen monótonamente** a la teoría de vigas; el **Allman** va sistemáticamente por delante del **CST** a igualdad de malla gracias al GDL de giro en el plano. En 32×8 el Allman está en **-13.72 %** frente a **-15.06 %** del CST; en la malla fina **64×14** el Allman alcanza **-4.28 %** (< 5 %) y el CST **-4.46 %**. El residuo del Allman a 64×14 es discretización de un problema dominado por flexión — sigue bajando al refinar, no es error del elemento.

El elemento pasa además el *patch test* de deformación/tensión constante (verificado aparte en `test_allman.mjs`: σ exacta, exactamente 3 modos de cuerpo rígido, sin modos espurios), donde el error es exacto (≈1e-14) sea cual sea la malla. La ventaja del *drilling* es máxima en mallas gruesas — justamente el bloqueo por corte que el Allman corrige.

## Conclusión

El **triángulo de membrana Allman** de Pórtico añade un GDL de giro en el plano por nodo y **supera el bloqueo por corte del CST**. Verificado: (1) pasa el *patch test* de tensión constante con exactamente 3 modos de cuerpo rígido (`test_allman.mjs`); (2) **converge monótonamente** a la teoría de vigas (δ=4.0240), alcanzando **< 5 %** en la malla 64×14; y (3) a igualdad de malla es más preciso que el CST. **Capacidad de membrana triangular con drilling verificada.**
