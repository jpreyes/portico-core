# Tutorial 1 — Edificio de 3 niveles en Valdivia (NCh433)

### portico-core — análisis y diseño de un edificio de hormigón armado con caja de escalera, suelo D

**portico-core · v0.2.0 · 2026-07-18**

[English](01-valdivia-nch433.md) · **Español**

<!-- pagebreak -->

## Qué vas a construir

Un **edificio de hormigón armado de 3 niveles** en **Valdivia, Chile**: planta de 15 × 15 m sobre una
grilla de pilares de 5 m, una **caja de escalera central** construida con elementos de muro **shell**,
**losas** modeladas con elementos **placa**, y **pórticos** (vigas y pilares). Lo analizamos para
gravedad y para el espectro sísmico **NCh433 / DS61** en **suelo D**, luego diseñamos las vigas y
pilares según **ACI 318-19** y verificamos la deriva de entrepiso contra el límite NCh433.

| Propiedad | Valor |
| --- | --- |
| Planta | 15 × 15 m, grilla de pilares 5 m (4 × 4 pilares) |
| Niveles | 3 (altura 3 m → techo en +9 m) |
| Caja de escalera | caja central 5 × 5 m, muros **shell**, t = 0.20 m |
| Losas | elementos **placa**, t = 0.15 m, vano de escalera al centro |
| Pilares / vigas | 50 × 50 cm (8Φ25) / 30 × 50 cm (3Φ22 sup+inf) |
| Hormigón | H30 (E = 28.7 GPa) |
| Sismo | NCh433 / DS61 — **suelo D**, zona 3 (Valdivia, costa), categoría II |
| Cargas | peso propio + 2.0 kN/m² permanente + 2.0 kN/m² sobrecarga |

El modelo se entrega como [`examples/tutorial1_valdivia.s3d`](../../examples/tutorial1_valdivia.s3d) y
es reproducible con [`tools/examples/build_valdivia.mjs`](../../tools/examples/build_valdivia.mjs).
Cada paso muestra el estado final en el visor.

<!-- pagebreak -->

## Paso 1 — Abrir el modelo

**Archivo → Abrir** y elige `examples/tutorial1_valdivia.s3d`. Activa la vista extruida de secciones
(el botón *extruido* de la barra) para ver los miembros como sólidos. Obtienes la estructura desnuda:
16 pilares, las vigas de piso, las tres losas placa (con el vano central de la escalera) y la caja
shell.

![El pórtico de 3 niveles: pilares y vigas (sólidos), tres losas placa y la caja central shell.](img/t1-01-geometry.png)

*Figura 1. El modelo — pórticos, losas placa y la caja de escalera central shell.*

## Paso 2 — Revisar las cargas de gravedad

Selecciona el caso de carga **CM** (permanente sobreimpuesta) en el selector de casos y activa las
flechas de carga. La carga de piso de 2.0 kN/m² se aplica a los nodos de la losa por área tributaria;
el caso de sobrecarga **CV** lleva otros 2.0 kN/m². El peso propio se maneja automáticamente desde la
densidad del hormigón (el caso **PP**).

![Flechas de carga de gravedad (permanente) en los tres pisos.](img/t1-04-loads.png)

*Figura 2. Las cargas de gravedad sobre las losas.*

El peso propio total es de unos **5 300 kN** (≈ 7.85 kN/m²) más la carga permanente sobreimpuesta —
unos ~9.6 kN/m² típicos de un edificio de hormigón armado.

<!-- pagebreak -->

## Paso 3 — Análisis modal (F6)

Corre **Análisis → Modal** (F6). El edificio es rígido — dominado por la caja shell — así que los
períodos son cortos:

| Modo | Período | Frecuencia | Forma |
| --- | --- | --- | --- |
| 1 | **0.160 s** | 6.26 Hz | **torsión** (89.6 % de la masa torsional) |
| 2, 3 | **0.120 s** | 8.34 Hz | traslación X, Y |

El **modo fundamental es torsional**. Esa es la firma de un edificio de **caja central**: la caja le
da enorme rigidez *traslacional* (sus muros están cerca del centro, así que casi no resiste el giro),
mientras que la resistencia *torsional* queda a cargo de los pórticos perimetrales — que son más
blandos. Conviene tenerlo presente al diseñar para torsión.

![Modo 1 — torsión: las losas rotan en planta (deformada en wireframe).](img/t1-05-mode1-torsion.png)

*Figura 3. Modo 1 (T = 0.160 s) — torsión.*

![Modo 2 — traslación: el edificio se desplaza lateralmente; la caja central es visible al centro.](img/t1-06-mode2-translation.png)

*Figura 4. Modo 2 (T = 0.120 s) — traslación lateral.*

<!-- pagebreak -->

## Paso 4 — Análisis de gravedad (F5)

Corre el análisis estático (F5). En la pestaña **RESULTADOS** selecciona la combinación de gravedad
**1.2·CM + 1.6·CV** y el tipo de resultado *deformada*. Las losas placa muestran su campo de flexión —
máximo al centro de cada paño entre pilares, mínimo en los pilares y alrededor de la caja rígida.

![Resultado de gravedad — las losas placa coloreadas por su campo de flexión bajo 1.2CM + 1.6CV.](img/t1-07-gravity-deformed.png)

*Figura 5. Deformada de gravedad y flexión de las losas.*

## Paso 5 — Espectro de respuesta NCh433 (suelo D)

Corre **Análisis → Espectro** (F7). Usa el botón **NCh433** para construir el espectro de diseño para
**suelo D**, **zona 3** (Valdivia está en la costa) y **categoría II**. El motor lee el período
fundamental para calcular el factor de reducción:

```
Sa(T) = S · Ao · I · α(T) / R*                    (NCh433 / DS61)
suelo D: S = 1.20, To = 0.75 s     zona 3: Ao = 0.40 g     categoría II: I = 1.0
R* = 1 + T* / (0.10·To + T*/Ro)  = 2.4     (T* = 0.12 s, Ro = 11)
Sa(0) = S·Ao·I / R* = 1.20·0.40·1.0 / 2.4 = 0.20 g
```

El factor de reducción `R* = 2.4` es **bajo a propósito**: el edificio es tan rígido (`T* = 0.12 s`,
muy por debajo de `To = 0.75 s`) que NCh433 le concede poca reducción — las estructuras de período
corto atraen más fuerza. Aun así, el desplazamiento espectral de techo es de solo **1.6 mm**, porque
la caja mantiene el edificio muy rígido. El espectro se combina por **CQC** (ζ = 5 %) en ambas
direcciones.

![Resultado sísmico — respuesta espectral (NCh433, suelo D) en X.](img/t1-08-spectrum-x.png)

*Figura 6. Respuesta espectral NCh433, dirección X.*

<!-- pagebreak -->

## Paso 6 — Diseño de vigas y pilares

Abre la pestaña **DISEÑO**. El motor verifica cada miembro de pórtico según **ACI 318-19** sobre las
combinaciones de ELU, tomando en cuenta la armadura de la sección (pilares 8Φ25, vigas 3Φ22 sup+inf),
y reporta la razón demanda/capacidad (D/C):

| Miembro | Sección · armadura | cantidad | max D/C | Gobierna | Estado |
| --- | --- | --- | --- | --- | --- |
| Pilares | 50 × 50 · 8Φ25 | 48 | **0.34** | interacción P–M | ✓ cumple |
| Vigas | 30 × 50 · 3Φ22 | 72 | **0.17** | corte | ✓ cumple |

Todos los miembros están muy por debajo de su capacidad (pilares D/C ≤ 0.34 en interacción
axial–flexión, vigas ≤ 0.17 en corte). El mapa de color es uniformemente verde — todas las vigas y
pilares cumplen holgadamente. La caja rígida mantiene baja la demanda sísmica, así que las demandas
están dominadas por la gravedad.

![Mapa D/C de diseño — todos los miembros en verde (D/C ≤ 0.34): el diseño cumple.](img/t1-09-design-dc.png)

*Figura 7. Mapa demanda/capacidad — vigas y pilares holgadamente dentro de capacidad.*

## Paso 7 — Deriva de entrepiso

Por último, verifica la deriva contra el límite NCh433 **Δ/h ≤ 0.002** (en el centro de masa):

| Piso | Δ/h (X) | % del límite 0.002 | Estado |
| --- | --- | --- | --- |
| 1 | 0.00015 | 7.7 % | ✓ |
| 2 | 0.00020 | 10.0 % | ✓ |
| 3 | 0.00017 | 8.3 % | ✓ |

Todos los pisos cumplen con amplio margen (~10 % del límite) — de nuevo, la consecuencia de un
edificio rígido de muros.

## Qué aprendimos

- Una **caja de escalera central** hace un edificio de hormigón **muy rígido traslacionalmente** pero
  **más blando en torsión**, así que el *modo fundamental es torsión*. El diseño debe considerar esa
  torsión aunque las derivas traslacionales sean mínimas.
- En **suelo D** con un edificio de período corto, el `R*` de NCh433 es bajo (2.4 aquí): la rigidez no
  significa automáticamente una fuerza sísmica pequeña, pero aquí los desplazamientos quedan chicos de
  todas formas.
- Los miembros de pórtico quedan holgadamente diseñados (pilares D/C ≤ 0.34 en interacción P–M, vigas
  ≤ 0.17 en corte) y las derivas son ~10 % del límite NCh433.

<sub>Modelo: `examples/tutorial1_valdivia.s3d` (construido por `tools/examples/build_valdivia.mjs`). Ver
el [Manual de Análisis](../analysis-reference.es.md) para la teoría y el
[Manual de Verificación](../verification-manual.es.md) para la validación del motor.</sub>
