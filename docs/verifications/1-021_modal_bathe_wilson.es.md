# Verificación 1-021 — Análisis modal — pórtico Bathe-Wilson (10 vanos × 9 pisos)

[English](1-021_modal_bathe_wilson.md) · **Español**

**Capacidad verificada:** análisis modal de un pórtico plano grande (autovalores ω²).
**Referencia:** CSI *Software Verification — SAP2000*, Example 1-021; soluciones independientes de **Bathe & Wilson (1972)** y **Peterson (1981)**.
**Modelo Portico:** [`examples/verif_1-021_modal_bathe_wilson.s3d`](../../examples/verif_1-021_modal_bathe_wilson.s3d)

## Descripción del problema

Pórtico plano de **10 vanos × 9 pisos** (10 @ 20 ft = 200 ft de ancho, 9 @ 10 ft = 90 ft de alto), base empotrada — el benchmark clásico de Bathe & Wilson 1972. Se comparan los **tres primeros autovalores** (ω²). Se consideran deformaciones de **flexión y axial** (la deformación por corte se ignora, área de corte = 0).

| Propiedad | Valor |
| --- | --- |
| Geometría | 10 vanos @ 20 ft × 9 pisos @ 10 ft |
| Módulo E | 432 000 k/ft² |
| Área A | 3 ft² |
| Inercia I | 1 ft⁴ |
| Masa por unidad de longitud | 3 k·s²/ft² |
| Elementos | 189 (99 columnas + 90 vigas) |

## Modelo en Portico

- Modelo **2D** (un elemento por miembro), base empotrada.
- **`Avy = Avz = 0`** → sin deformación por corte (igual que el original); **axial incluido**.
- Masa por longitud = `ρ·A` con `ρ = 1`, `A = 3` → 3 k·s²/ft². Masa **consistente**.

![Modo 1 (ω² = 0.5899, T = 8.18 s) — primer modo de oscilación lateral del pórtico.](img/1-021_modal_bathe_wilson.svg)

*Figura 1. Modo 1 (ω² = 0.5899, T = 8.18 s) — primer modo de oscilación lateral del pórtico.*

## Resultados — comparación

Tres primeros autovalores ω². SAP2000 coincide exactamente con las soluciones independientes; la diferencia se calcula contra ese valor.

| Modo | Descripción | Independiente (ω²) | SAP2000 (ω²) | dif. SAP | **Portico (ω²)** | **dif. Portico** |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1er modo | 0.5895 | 0.5895 | 0 % | **0.5899** | **+0.05 %** |
| 2 | 2º modo | 5.5270 | 5.5270 | 0 % | **5.5524** | **+0.46 %** |
| 3 | 3er modo | 16.5879 | 16.5879 | 0 % | **16.7925** | **+1.23 %** |

## Conclusión

Portico reproduce el **primer autovalor con +0.05 %** (esencialmente exacto) y el 2º y 3º dentro de **+0.5 % y +1.2 %**. Las pequeñas diferencias en los modos superiores reflejan la formulación de **masa consistente** de Portico frente al modelo de masa del benchmark (la subdivisión adicional de los miembros no las reduce, confirmando que no son error de discretización). El solver modal por iteración de subespacio resuelve correctamente un pórtico plano grande (110 nodos). **Capacidad modal en pórticos verificada.**
