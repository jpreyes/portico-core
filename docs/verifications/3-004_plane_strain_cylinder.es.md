# Verificación 3-004 — Cilindro de pared gruesa — deformación plana (plane-strain)

[English](3-004_plane_strain_cylinder.md) · **Español**

**Capacidad verificada:** continuo plano en DEFORMACIÓN PLANA (plane-strain) — elemento de membrana con confinamiento fuera del plano.
**Referencia:** CSI *Software Verification — SAP2000*, Example 3-004 (Timoshenko 1956, *Strength of Materials* Part II §44; MacNeal & Harder 1985).
**Modelo Portico:** [`examples/verif_3-004_plane_strain_cylinder.s3d`](../../examples/verif_3-004_plane_strain_cylinder.s3d)

## Descripción del problema

Cilindro de pared gruesa (radio interior 3 in, exterior 9 in, espesor 1 in) bajo **presión interna de 1 ksi**, en **deformación plana** (cilindro largo, ε_z = 0). Se modela un **cuarto de cilindro** con simetría alineada a los ejes (el borde θ=0 restringe U_z y el borde θ=90° restringe U_x), con la malla radial de 5 bandas del original (radios 3 · 3.5 · 4.2 · 5.2 · 6.75 · 9). Se compara el **desplazamiento radial en la cara interna** con la solución analítica de Timoshenko.

| Propiedad | Valor |
| --- | --- |
| Geometría | cuarto de cilindro, r_int = 3 in, r_ext = 9 in, t = 1 in |
| Malla | 5 bandas radiales × 9 segmentos (10°) de QUAD membrana |
| Módulo E | 1 000 k/in² |
| Poisson ν | 0.3 (deformación plana) |
| Carga | presión interna P = 1 ksi (fuerzas radiales nodales) |

## Modelo en Portico

- Elemento de **membrana en deformación plana** (`planeStrain:true`, #58): la constitutiva incluye el confinamiento fuera del plano (ε_z = 0), `D = E/((1+ν)(1−2ν))·[...]`.
- Simetría sin apoyos sesgados: el cuarto de cilindro coloca los bordes radiales sobre los ejes globales → la simetría se impone con restricciones **alineadas a los ejes** (U_z en θ=0, U_x en θ=90°).
- Presión interna como fuerzas **radiales** nodales (P·t·arco tributario) en la cara interna; cara externa libre.

![Cuarto de cilindro (malla radial×circunferencial); deformada por la presión interna (×escala) — la pared se expande radialmente.](img/3-004_plane_strain_cylinder.svg)

*Figura 1. Cuarto de cilindro (malla radial×circunferencial); deformada por la presión interna (×escala) — la pared se expande radialmente.*

## Resultados — comparación

Desplazamiento radial en la cara interna (r = 3 in), nodo sobre el eje X (radial = U_x). Referencia analítica de Timoshenko (deformación plana, ν=0.3).

| Parámetro | Descripción | Independiente (in) | SAP2000 (in) | dif. SAP | **Portico (in)** | **dif. Portico** |
| --- | --- | --- | --- | --- | --- | --- |
| U_r | Desplazamiento radial cara interna (plane-strain) | 0.004582 | 0.004539 | -0.94 % | **0.004541** | **-0.91 %** |

### Solución analítica (Timoshenko 1956, §44)

Con `U = a·r + b/r`, `b = −P(1+ν)/(E(1/r₂²−1/r₁²))` y `a = (1−2ν)·b/r₂²`. Para P=1, E=1000, r₁=3, r₂=9, ν=0.3: b=0.0131625, a=6.5×10⁻⁵, y **U_r(3) = a·3 + b/3 = 0.004582 in**.

### Cuasi-incompresibilidad (ν → 0.5)

Para ν=0.49–0.4999 el QUAD estándar de Portico sufre **bloqueo volumétrico** en deformación plana (subestima ~15 %), un efecto conocido de los elementos de desplazamiento sin tratamiento especial (B-bar / modos incompatibles, que SAP2000 sí incluye). Para ν habituales (≤0.3) el resultado es correcto. La **tensión plana** del mismo cilindro (verificada aparte) no sufre este bloqueo.

## Conclusión

Portico reproduce el desplazamiento radial del cilindro de pared gruesa en **deformación plana** con **diferencia −0.9 %** (U_r = 0.004541 in vs 0.004582 in analítico), prácticamente idéntico al resultado de SAP2000 (0.004539 in, −1 %) con la misma malla radial. La constitutiva **plane-strain** (#58), con el confinamiento fuera del plano, queda validada contra la solución de Timoshenko. **Capacidad de deformación plana verificada.**
