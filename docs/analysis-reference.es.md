# Manual de Análisis

### portico-core — teoría del motor de análisis estructural

**portico-core · v0.2.0 · 2026-07-18**

[English](analysis-reference.md) · **Español**

<!-- pagebreak -->

## Sobre este manual

Este manual documenta la **teoría** detrás del motor de análisis de portico-core: las formulaciones
de los elementos, los algoritmos de ensamblaje y solución, los procedimientos dinámicos y no lineales,
y las verificaciones de diseño — **tal como están implementados en el código**, no como un texto
genérico. Cada sección nombra el módulo que la implementa, para que el manual y el código no se
desincronicen.

Es el compañero del [Manual de Verificación](verification-manual.es.md), que contrasta el mismo motor
contra soluciones analíticas, SAP2000 y OpenSees. Donde este manual dice *qué* y *por qué*, el Manual
de Verificación muestra *qué tan bien*.

portico-core es un motor de elementos finitos nativo del navegador (JavaScript vanilla en módulos ES,
Three.js para el visor, numeric.js y un solver bandeado propio para el álgebra lineal). Todo el solver
corre del lado del cliente — sin núcleo nativo, sin WASM, sin backend remoto — y eso es un objetivo de
diseño, no un accidente.

## 0. Convenciones

### 0.1 Sistema de coordenadas

El modelo usa un marco global **dextrógiro, con Z arriba (Z-up)**, la misma convención de SAP2000 y
ETABS: `X` e `Y` son horizontales, `Z` es vertical (la gravedad actúa según `−Z`). El visor mapea las
coordenadas del modelo a la escena Three.js (Y arriba) con `model(x, y, z) → three(x, z, y)`; ese mapeo
es un detalle de renderizado y nunca entra al solver, que trabaja íntegramente en el marco Z-up del
modelo.

### 0.2 Grados de libertad nodales

Cada nodo lleva **seis** grados de libertad, ordenados `[ ux, uy, uz, rx, ry, rz ]` — tres traslaciones
seguidas de tres rotaciones, respecto de los ejes globales. Una restricción fija un GDL (1 = fijo,
0 = libre). Los modelos bidimensionales restringen el conjunto fuera del plano — `uy, rx, rz` — de modo
que sólo queda activa la terna en el plano `ux, uz, ry`.

### 0.3 Grados de libertad del elemento

Un elemento de barra (línea) conecta dos nodos y por tanto tiene **doce** grados de libertad, los dos
conjuntos nodales concatenados:

```
[ ux1, uy1, uz1, rx1, ry1, rz1,  ux2, uy2, uz2, rx2, ry2, rz2 ]
```

Las **liberaciones de miembro** (releases) son un arreglo de 12 alineado con este orden (1 = liberado,
0 = continuo), así que una rótula de momento en el extremo *j* respecto del eje fuerte libera la entrada
11 antes de ensamblar la rigidez (una viga simplemente apoyada libera los índices 5 y 11).

### 0.4 Convenciones de signo y unidades

Desplazamientos y rotaciones siguen los ejes globales; reacciones y esfuerzos de miembro siguen la
regla de la mano derecha. El motor está escrito en **unidades consistentes** — no etiqueta las
magnitudes con un sistema de unidades — pero su conjunto canónico es **kN y m** (así que `E`, `G` y las
tensiones van en kN/m²), con masas nodales en **ton** e inercias rotacionales en **ton·m²**. Las
resistencias de diseño son la única excepción: se ingresan en **MPa** y se convierten internamente
(×1000) a kN/m². Cada tabla de este manual y del Manual de Verificación indica la unidad de cada
magnitud.

Para la convención de **eje fuerte/débil**, el código usa **z = eje fuerte (mayor), y = eje débil
(menor)**. El área de corte `Avy` se asocia al momento del eje fuerte `Mz` (lo resiste el alma) y `Avz`
al momento del eje débil `My` (las alas). El Eurocódigo 3, cuyo nombrado nativo está invertido, se mapea
internamente a esta convención.

### 0.5 Direcciones de carga distribuida

Una carga lineal distribuida lleva una etiqueta de dirección:

- `gravity` / `globalZ` — global **−Z** (una intensidad positiva actúa hacia abajo),
- `globalX`, `globalY` — según un eje global,
- `localX`, `localY`, `localZ` — según un eje local del elemento,

y puede ser **trapezoidal** (`w` al inicio, `w2` al final; uniforme si se omite `w2`). Las direcciones
globales se proyectan sobre los tres ejes locales del elemento, de modo que la gravedad sobre un miembro
inclinado o vertical produce las componentes axial y transversal correctas. Las cargas se convierten en
fuerzas de empotramiento (FEF) antes del ensamblaje (§2.2).

<!-- pagebreak -->

## 1. Biblioteca de elementos

El motor ensambla una rigidez global `K`, una matriz de masa `M` y — para estabilidad y dinámica — una
rigidez geométrica `Kg`, a partir de una biblioteca pequeña: una **barra** de Timoshenko de dos nodos,
una familia de elementos de **membrana** (tensión/deformación plana) triangulares y cuadriláteros, dos
elementos de **placa** a flexión, su superposición como **cáscara** (shell), y **links** y **diafragmas
rígidos** por penalti.

### 1.1 El elemento de barra (`js/solver/timoshenko.js`)

Un elemento de barra une dos nodos con los doce GDL de §0.3. Sus ejes locales se construyen a partir de
la geometría del miembro: el `x` local va del nodo *i* al nodo *j*; un vector de referencia (`Z` global,
o `X` global cuando el miembro está a ~2° de la vertical) fija la orientación de la sección:

```
ex = unit(n2 − n1)
ref = |ex·Z| > 0.9994 ? X : Z          # los miembros casi verticales cambian la referencia
ez = unit(ex × ref)
ey = ez × ex                            # terna local dextrógira
```

La transformación 12×12 `T` es la repetición bloque-diagonal de la rotación 3×3 `R = [ex; ey; ez]`; la
rigidez del elemento en ejes globales es `Ke = Tᵀ·Ke_local·T`.

**Rigidez con corte (Timoshenko).** Los bloques de flexión son de Timoshenko — incluyen deformación por
corte — gobernados por un parámetro de corte adimensional en cada plano:

```
Φy = 12·E·Iz / (G·Avy·L²)      fy = 1/(1 + Φy)     # flexión eje fuerte (respecto de z local)
Φz = 12·E·Iy / (G·Avz·L²)      fz = 1/(1 + Φz)     # flexión eje débil (respecto de y local)
```

Cuando un área de corte se deja efectivamente infinita (`Avy ≤ 1e-30`), el `Φ` correspondiente `→ 0` y
el bloque colapsa a la viga clásica de **Euler–Bernoulli** — un centinela deliberado que recupera el
límite rígido a corte. Con `by = 12EIz·fy/L³`, `cy = 6EIz·fy/L²`, `dy = (4+Φy)EIz·fy/L` y
`ey = (2−Φy)EIz·fy/L`, el bloque del eje fuerte sobre los GDL locales `[v1, θz1, v2, θz2]` es

```
        [  by   cy  −by   cy ]
K_XY =  [  cy   dy  −cy   ey ]
        [ −by  −cy   by  −cy ]
        [  cy   ey  −cy   dy ]
```

con axial `EA/L` y torsión `GJ/L` en sus propios pares de GDL. El bloque del eje débil es idéntico en
forma pero lleva el cambio de signo de la convención `dw/dx = −θy`. Los **modificadores de rigidez** de
sección (`sec.mod`, p. ej. un `0.35·Ig` fisurado de ACI en una viga) escalan la rigidez — y la fuerza
axial usada para `Kg` — pero *no* la masa, así que un análisis modal con sección fisurada conserva su
inercia real.

**Masa consistente.** La masa del elemento es la matriz consistente (Hermite cúbica), p. ej. el bloque
de traslación `ρAL/420 · [156, 22L, 54, −13L; …]`, calculada con el área de sección *sin modificar*. La
inercia torsional usa una masa polar aproximada `ρ·J·L`.

**Liberaciones de miembro.** Una liberación (§0.3) se aplica por **condensación estática (Guyan)**:
particionando el elemento en GDL retenidos y liberados, la rigidez retenida queda
`Kff* = Kff − Kfr·Krr⁻¹·Krf` y las filas/columnas liberadas se anulan. Las fuerzas de empotramiento se
condensan igual, y los desplazamientos liberados se recuperan después para dibujar bien el quiebre en la
rótula. Un `Krr` singular (miembro sobre-liberado) recae en la matriz sin condensar.

**Fuerzas de empotramiento.** Una carga distribuida se convierte en fuerzas de extremo trabajo-
equivalentes antes del ensamblaje. Una carga trapezoidal se separa en una parte uniforme (`w1`) más una
triangular (`g = w2 − w1`) cuyas reacciones empotrado-empotrado están precalculadas (`V1 = 3gL/20`,
`V2 = 7gL/20`, `M1 = gL²/30`, `M2 = gL²/20`).

**Zonas rígidas de extremo, fundación elástica, empotramiento parcial.** Tres refinamientos opcionales
comparten el elemento de barra. Una **zona rígida de extremo** (`rigidEnd {i, j}`) calcula la rigidez del
tramo flexible `Lf = L − oi − oj` (sin dejar nunca menos del 5% flexible) y la mapea a los nodos reales
por cinemática de brazo rígido `u(extremo') = u(nodo) + θ×r`. Una **viga sobre fundación elástica
(Winkler)** (`foundation {ky, kz}`) agrega una matriz de resorte distribuido consistente. Los **resortes
de extremo** (`endSprings {dof: k}`) modelan conexiones semirrígidas mediante un GDL interno condensado —
`k → ∞` recupera una conexión rígida, `k → 0` una rótula.

![Modelo de pórtico — el marco se ensambla con elementos de barra de Timoshenko de 12 GDL.](theory/img/frame-portal.svg)

*Figura 1.1. Un modelo de pórtico: columnas y vigas son elementos de dos nodos y 12 GDL de Timoshenko.*

### 1.2 Elementos de membrana (`js/solver/membrane.js`)

Los elementos de membrana (tensión o deformación plana) sólo llevan fuerzas en el plano. Su matriz
constitutiva plana es

```
tensión plana:      D = E/(1−ν²) · [[1, ν, 0], [ν, 1, 0], [0, 0, (1−ν)/2]]
deformación plana:  D = E/((1+ν)(1−2ν)) · [ … ]
```

y cada elemento se forma en un marco 2D local construido desde sus coordenadas de esquina
(`ex = unit(n1→n2)`, `ez` normal a la faceta, `ey = ez×ex`).

- **CST** — el triángulo de deformación constante de 3 nodos, 2 GDL/nodo `[u, v]`. Su matriz
  deformación–desplazamiento `B` es constante, así que `Ke = t·A·Bᵀ·D·B` en forma cerrada. Es exacto
  para estados de tensión constante (pasa el patch test) pero rígido a flexión — el bloqueo por corte
  estudiado en el caso de verificación 3-006.
- **QUAD** — el cuadrilátero isoparamétrico de 4 nodos, 2 GDL/nodo, integrado con **Gauss 2×2**
  (`Ke = Σ t·detJ·Bᵀ·D·B`), con tensiones recuperadas en el centro.
- **Triángulo Allman con giro (drilling)** — un triángulo de 3 nodos con una rotación en el plano
  añadida en cada nodo, o sea **3 GDL/nodo `[u, v, ωz]`**. Se construye desde el triángulo de deformación
  lineal (LST) de seis nodos, reemplazando las traslaciones de medio-lado por las rotaciones de esquina
  (Allman 1984):

  ```
  u_med = ½(u_i + u_j) + ⅛(y_i − y_j)(ω_j − ω_i)
  v_med = ½(v_i + v_j) + ⅛(x_j − x_i)(ω_j − ω_i)
  ```

  e integrado en los tres puntos medios de los lados (exacto para el LST). El GDL de giro le permite
  representar la flexión en el plano mucho mejor que el CST (la convergencia del caso 3-006). Su único
  modo de energía nula (giro uniforme `ω1 = ω2 = ω3`) se elimina con un **resorte diagonal mínimo** sobre
  los GDL rotacionales, escalado por `γ = 1e-3` de la rigidez rotacional media — deliberadamente *no* una
  penalización de Hughes–Brezzi, que acoplaría las traslaciones y rigidizaría en exceso la flexión.

Los GDL nodales no cubiertos (por ejemplo el giro donde no llega ningún elemento con drilling) se
regularizan con un resorte diminuto (`1e-4` de una rigidez de referencia) para que la matriz global no
se vuelva singular sin perturbar la respuesta real.

![Muro de membrana — malla de 4×6 QUAD; se dibuja cada cara del elemento, no sólo los nodos de esquina.](theory/img/membrane-wall.svg)

*Figura 1.2. Un muro de corte en tensión plana discretizado en QUAD de membrana.*

### 1.3 Elementos de placa a flexión (`js/solver/plate.js`)

Los elementos de placa llevan flexión fuera del plano, con **3 GDL/nodo `[w, θx, θy]`** — una traslación
normal y dos rotaciones de flexión, elegidas (`θx = ∂w/∂y`, `θy = −∂w/∂x`) para que un nodo de placa
acople limpiamente con los GDL rotacionales de una barra o de una membrana con giro. La matriz
constitutiva de flexión es `Db = (t³/12)·Dp`.

- **MITC4** — un cuadrilátero de Mindlin–Reissner de 4 nodos (apto para placa gruesa). La flexión se
  integra con Gauss 2×2; el corte transversal usa la **interpolación de deformación asumida
  (Bathe–Dvorkin)**, que ata las deformaciones de corte covariantes en los puntos medios de los bordes y
  por eso **no bloquea por corte** al adelgazarse la placa. La rigidez de corte lleva el factor de
  corrección `κs = 5/6`.
- **DKT** — el Triángulo Discreto de Kirchhoff (placa delgada), integrado en los tres puntos medios de
  los lados. Su matriz `B` se mantiene en la misma convención de signo `[w, θx, θy]` que el MITC4 y las
  barras, para que una placa triangular que comparte GDL rotacionales con una viga o un quad acople
  correctamente — una regresión verificada explícitamente en la batería de tests.

Las cargas térmicas de placa producen un momento de flexión desde el gradiente de temperatura a través
del espesor (`κ0 = α·gradT/t`), y las tensiones de superficie se recuperan como `σ = ±6·M/t²`.

![Losa de placa — malla de 6×6 QUAD con bordes simplemente apoyados; se dibuja toda la malla de flexión.](theory/img/plate-slab.svg)

*Figura 1.3. Una losa a flexión discretizada en QUAD MITC4.*

### 1.4 Elementos de cáscara (shell)

Un elemento de **cáscara** es la superposición directa de una membrana y una placa sobre la misma
faceta: los GDL en el plano vienen del elemento de membrana y los GDL fuera del plano del elemento de
placa, así que el nodo usa los seis GDL globales. Se selecciona por área con `behavior = 'shell'` (frente
a `'membrane'` o `'plate'`). Para estabilidad, las cáscaras además aportan una **rigidez geométrica**
fuera del plano derivada de su estado tensional en el plano (§4.1), que es lo que permite captar el
pandeo de placa/cáscara.

![Cubierta de cáscara — malla de QUAD de placa plegada en 3D; membrana y placa se combinan en cada faceta.](theory/img/shell-roof.svg)

*Figura 1.4. Una cáscara (membrana + placa) de cubierta plegada; cada faceta QUAD 3D se dibuja como cara de malla.*

### 1.5 Links, acoplamientos y diafragmas (`js/solver/links.js`, `diaphragm.js`)

Las restricciones cinemáticas se imponen por el **método de penalti**: por cada ecuación de restricción
`g·u = 0` se agrega el término `α·gᵀg` a `K`, con `α = 1e5·max(diag K)`. Ese factor mantiene la
restricción con error menor a 0.001% conservando `K` suficientemente condicionada para que el
autosolucionador siga funcionando; un penalti mucho mayor (digamos `1e8`) sobre-condicionaría la matriz.

- **Link rígido** — el nodo esclavo sigue al maestro como cuerpo rígido, `u_s = u_m + θ_m×r` y
  `θ_s = θ_m`, donde `r` es el brazo de palanca; las tres ecuaciones de traslación llevan el brazo. Un
  **acoplamiento simple** en cambio iguala GDL seleccionados sin brazo.
- **Diafragma rígido** — un piso rígido en su plano. Cada esclavo se ata al maestro del piso (su **Centro
  de Rigidez**) mediante tres ecuaciones sobre los GDL en el plano `[ux, uy, rz]`:

  ```
  ux_s − ux_m + dy·rz_m = 0
  uy_s − uy_m − dx·rz_m = 0
  rz_s − rz_m = 0
  ```

  El Centro de Rigidez se calcula desde las columnas verticales del piso (`Kx = 12·E·Iz/h³`,
  `Ky = 12·E·Iy/h³`, `x_CR = ΣKy·x / ΣKy`, …). La masa del piso se reparte a sus nodos por área
  tributaria (de las vigas de piso conectadas), de modo que la excentricidad natural entre el centro de
  masa y el centro de rigidez — y cualquier **excentricidad accidental** que el usuario agregue — emerge
  automáticamente en la dinámica, sin una inercia rotacional dada explícitamente.

<!-- pagebreak -->

## 2. Ensamblaje y solución lineal

### 2.1 Ensamblaje global (`js/solver/assembler.js`)

Los nodos se numeran en orden de inserción; el nodo *i* posee los GDL globales `6·i … 6·i+5`.
`assembleK` construye la rigidez `K` y la masa `M` densas como `Float64Array(nDOF²)` fila-mayor,
`nDOF = 6·nNodos`. Por cada elemento, la rigidez local (incluida cualquier zona rígida de extremo,
fundación y resortes de extremo) se condensa por liberaciones si hace falta, se transforma a ejes
globales y se dispersa en los dos bloques de GDL nodales. Luego, en orden: apoyos elásticos nodales
(`springs` diagonales, o una `springK` 6×6 acoplada), rigidez y masa concentrada de áreas
(membrana/placa/cáscara), restricciones de penalti de **diafragmas** y **links** (§1.5), masas de
diafragma, masas puntuales nodales, y la **fuente de masa sísmica** — la componente gravitatoria de los
casos elegidos convertida en masa traslacional `m = |Fz|/g` concentrada por igual en UX, UY, UZ
(`g = 9.80665 m/s²`).

### 2.2 Cargas y fuerzas de empotramiento

`assembleF` construye el vector de carga sobre los GDL libres. Las cargas nodales entran directamente.
Las cargas distribuidas se vuelven fuerzas de empotramiento (§1.1), transformadas a ejes globales y
condensadas por liberaciones. Un cambio uniforme de temperatura agrega una fuerza axial de empotramiento
`Nt = EA·α·ΔT`; un gradiente de placa agrega un momento térmico. El peso propio se aplica como carga
distribuida `gravity` `w = ρ·A·g` en las barras y como reparto nodal por igual en las áreas.

### 2.3 La solución lineal (`js/solver/static_solver.js`)

El problema estático es `K_ff · u_f = F_f` sobre los GDL libres. Los modelos 2D auto-restringen los GDL
fuera del plano (§0.2); un **desplazamiento de apoyo prescrito** `up` (un asentamiento) se pasa al lado
derecho, `F_f ← F_f − K_fp·up`.

El sistema se resuelve por **factorización LU** explícita (`num.LU` y luego `num.LUsolve`, no la caja
negra `num.solve`) para poder inspeccionar los pivotes de la diagonal: la razón entre el pivote menor y
el mayor es una **métrica de cuasi-singularidad**, y un valor bajo `1e-12` levanta una advertencia de que
el modelo está cerca de un mecanismo (una solución no finita lanza un error de mecanismo directamente).
Dos gauges adicionales marcan un resultado "absurdo" — una deriva de entrepiso mayor a 1/20, o un
desplazamiento mayor al 15% del vano del modelo.

### 2.4 Apoyos más allá del caso lineal

Tres tipos de apoyo hacen insuficiente una única solución lineal y se tratan con iteración local:

- **Resortes unilaterales** (sólo compresión o sólo tracción) se resuelven con un bucle de **conjunto
  activo**: el resorte se ensambla bilateral, luego a todo resorte cuyo signo esté mal se le quita la
  rigidez de la diagonal y se re-resuelve, hasta que el conjunto activo deja de cambiar.
- **Resortes de suelo no lineales** (curvas p-y / t-z / q-z dadas como tablas fuerza–desplazamiento) se
  resuelven por **iteración de Newton** sobre la tangente, convergiendo cuando el residuo cae por debajo
  de `1e-9` de la carga aplicada.
- **Desplazamientos prescritos** se manejan en el lado derecho como arriba.

### 2.5 Reacciones, esfuerzos y diagramas (`js/solver/postprocess.js`)

Las reacciones se recuperan como `R = K·u − F`; en apoyos elásticos la reacción del GDL libre es `−k·u`
(cero para un resorte unilateral despegado). Las fuerzas de extremo del elemento son
`f = Ke_eff·(T·u) + fef`, usando la misma rigidez consciente de zonas rígidas/fundación que el
ensamblaje, con la convención de signo `N = −f[0]`, etc.

Los diagramas internos se construyen por **integración de equilibrio**, exacta para una carga trapezoidal
`q(x) = q1 + (q2−q1)·x/L`:

```
M(x) = M0 − V0·x − ½·q1·x² − (q2−q1)·x³/(6L)
V(x) = V0 + q1·x + (q2−q1)·x²/(2L)
```

con el extremo del momento donde `V(x) = 0`. Las intensidades distribuidas se llevan desde la carga,
nunca se infieren de los cortes de extremo, así que los diagramas son exactos entre nodos. Los
desplazamientos puntuales a lo largo de un miembro usan interpolación Hermite cúbica más la burbuja
exacta de deflexión por carga uniforme. Los resultados de área y cáscara entregan tensiones en el plano
(`σx, σy, τxy`, von Mises, principales), momentos y curvaturas de placa, y tensiones de superficie
`σ = membrana ± 6M/t²`, con promediado nodal opcional.

<!-- pagebreak -->

## 3. Dinámica

### 3.1 Análisis modal (`js/solver/modal_solver.js`)

El problema de vibración libre es el autoproblema generalizado `K·φ = ω²·M·φ`, resuelto para los
`nModes` menores (por defecto 10). Como los diafragmas rígidos se imponen por penalti (§1.5) que vuelve
`K` mal condicionada (número de condición ~1e8), un autosolucionador denso de caja negra devolvería
autovectores corruptos. Por eso el motor usa **iteración de potencia inversa de Stodola con deflación
M-ortogonal**, que sólo necesita una factorización LU de `K` reutilizada en todos los modos:

```
repetir:  y = K⁻¹ · (M·x)          # paso de potencia inversa
          y ← y − Σ (yᵀ M φk) φk    # deflación contra los modos hallados
          x = y / ‖y‖_M             # normalización en M
          ω² = xᵀ K x               # cociente de Rayleigh
hasta |Δω²|/ω² < 1e-7
```

Los GDL sin masa (rotaciones sin inercia, `ρ = 0`) se eliminan primero por **reducción de Guyan** — los
GDL con `|M_ii| ≤ 1e-6·máx` pasan a esclavos condensados estáticamente — y las formas modales se expanden
después. Cada modo se reintenta desde varios vectores semilla determinísticos, y se acepta una tolerancia
relajada (`1e-4`) para sistemas tercos condicionados por penalti.

### 3.2 Participación y masa efectiva (`js/solver/modal_results.js`)

Las formas modales se normalizan para que la mayor traslación sea la unidad. Para cada modo la masa
generalizada es `M̄ = φᵀMφ`; para cada dirección `d` (X, Y y torsión Rz) el factor de participación, la
masa efectiva y el porcentaje son

```
Γ_d = φᵀ · M · ι_d       m_eff = Γ_d² / M̄       %_d = m_eff / total_d
```

donde `ι_d` es el vector de influencia de cuerpo rígido. Como la masa de diafragma vive en los GDL
traslacionales, la influencia torsional se arma como una rotación rígida en torno al Centro de Rigidez,
`ι_Rz[UXi] = −(yi − y_CR)`, `ι_Rz[UYi] = +(xi − x_CR)`. El resultado lleva los períodos `T = 2π/ω`, las
frecuencias, las formas modales y la tabla de participación acumulada.

### 3.3 Espectro de respuesta (`js/solver/spectrum_solver.js`)

Para un espectro de entrada `Sa(T)` y una dirección horizontal, el desplazamiento espectral de cada modo
es `u_i = φ_i · (Γ_d/M̄) · Sd` con `Sd = Sa/ω²`. Las respuestas modales se combinan por GDL, sea por
**SRSS** o por **CQC** con el coeficiente de correlación de Der Kiureghian

```
ρ_ij = 8ζ²(1+r)·r^1.5 / ((1−r²)² + 4ζ²·r·(1+r)²),     r = ω_min/ω_max
```

(amortiguamiento por defecto `ζ = 0.05`). El desplazamiento combinado es `U = √(ΣΣ ρ_ij·u_i·u_j)`, y los
esfuerzos de miembro se combinan igual. El espectro se interpola linealmente, con una cola `1/T` más allá
del último punto. El espectro en sí es agnóstico al código: se puede suministrar cualquier tabla
`[{T, Sa}]`.

### 3.4 El espectro de diseño NCh433 (`js/design/nch433_spectrum.js`)

El espectro de diseño chileno NCh433/DS61 se provee como fuente única de verdad (antes existía como
cuatro copias desincronizadas):

```
Sa(T) = S · Ao · I · α(T) / R*                         [g]
α(T)  = (1 + 4.5·(T/To)^p) / (1 + (T/To)³)
R*    = 1 + T* / (0.10·To + T*/Ro)        (T* ≤ 0 → R* = 1, elástico)
```

con tablas de suelo A–E `{S, To, Tp, n, p}`, aceleraciones de zona sísmica `Ao ∈ {0.20, 0.30, 0.40}·g`,
factores de importancia `I ∈ {0.6, 1.0, 1.2}` y `Ro` (por defecto 11.0). Las tablas son sobreescribibles,
así que se puede enchufar un preset de otro país. El factor de reducción `R*` puede devolverse aparte
para que el llamador lo aplique como `Sa·g/R*`.

<!-- pagebreak -->

## 4. No linealidad geométrica

### 4.1 Rigidez geométrica (`js/solver/geometric.js`)

La fuerza axial cambia la rigidez transversal de un miembro: la tracción lo rigidiza, la compresión lo
ablanda (y, en un valor crítico, lo pandea). Esto se captura con una **rigidez geométrica** `Kg`
construida desde la fuerza axial actual `N` (positiva en tracción, `N = EA·(alargamiento)/L`):

```
Kg_local = (N/L) · [ a=6/5, b=L/10, d=2L²/15, e=−L²/30 ]     (consistente, Przemieniecki)
```

aplicada a ambos planos de flexión; los términos geométricos axial y torsional se desprecian (sólo
pandeo por flexión). Los elementos de cáscara agregan una rigidez geométrica fuera del plano desde su
estado tensional en el plano, que es lo que permite el pandeo de placa/cáscara.

### 4.2 Pandeo lineal (`js/solver/geometric_analysis.js`, `buckling.js`)

El pandeo lineal (por autovalores) resuelve `(K + λ·Kg)·φ = 0` para los menores factores de carga `λ`. El
estado axial de referencia viene de una solución lineal de la carga aplicada, `Kg` se ensambla desde él,
y el autoproblema se resuelve por **iteración de subespacio** (Bathe): un bloque pequeño de vectores se
lleva repetidamente por `K⁻¹·(−Kg)` — que amplifica el menor `|λ|` — y se reduce a un problema denso de
Rayleigh–Ritz resuelto por rotaciones de Jacobi, convergiendo cuando los factores dominantes se estabilizan
a `1e-6`. El solver SPD bandeado factoriza `K` una vez. El factor crítico `λ₁` escala la carga de
referencia hasta la carga de pandeo.

### 4.3 P-Delta (`js/solver/geometric_analysis.js`)

El análisis de segundo orden (P-Δ) resuelve `(K + Kg(u))·u = F`. Como `Kg` depende del estado axial, que
depende de `u`, el motor itera un esquema **secante / punto fijo**: resuelve lineal, reensambla `Kg(u)`,
re-resuelve la carga completa, y repite hasta que el cambio de desplazamiento cae bajo `1e-6` (por defecto
25 iteraciones). La salida reporta las deflexiones lineal y de segundo orden y su amplificación
`dPD/dLin`. Es una iteración secante sobre la tangente, no un esquema de Newton sobre el residuo.

### 4.4 Barra y cable en grandes desplazamientos (`js/solver/nl_lite.js`)

Cables y puntales se resuelven con una **barra corotacional** (3 GDL traslacionales/nodo) cuya fuerza
axial es `N = EA·(l − L0)/L0` sobre la longitud deformada `l`, con una longitud natural `L0` que puede
llevar pretensado. Un cable de sólo tracción recorta `N < 0` a flojo; un puntal de sólo compresión
recorta `N > 0`. La tangente del elemento agrega un término geométrico `kg = N/l` al material
`km = EA/L0`. El sistema global se resuelve por **Newton–Raphson bajo control de carga** (por defecto 10
pasos), convergiendo con un residuo relativo de `1e-8`. Para snap-through pasado un punto límite, una
variante de **control de desplazamiento** aumenta el sistema para resolver el factor de carga
prescribiendo un incremento del GDL de control.

### 4.5 Viga corotacional (`js/solver/corotbeam.js`)

Para pórticos en grandes desplazamientos, una **viga corotacional** plana (Crisfield) separa la rotación
rígida de la cuerda de las deformaciones locales `ubar = ln − L0`, `θ̄1`, `θ̄2`, dando fuerzas locales
`N = EA·ubar/L0` y `M = EI/L0·(4θ̄ + 2θ̄')`. La tangente combina una parte material con una parte
geométrica `(N/ln)·zzᵀ + …`, y el sistema se resuelve por Newton bajo control de carga.

### 4.6 Form finding (`js/solver/formfind.js`)

Las estructuras traccionadas (redes de cables, membranas) se forman con el **Método de la Densidad de
Fuerza** (Schek 1974). Con una densidad de fuerza `q = N/L` asignada a cada rama, la forma de equilibrio
es la solución de un único sistema lineal por eje coordenado, `D·x_free = p`, donde `D` es el Laplaciano
de la red ponderado por `q` (SPD para `q` positiva). El método es lineal y no iterativo, y requiere al
menos dos anclajes. Muta las coordenadas de los nodos a la forma hallada.

<!-- pagebreak -->

## 5. No linealidad material

### 5.1 Pushover plástico evento a evento (`js/solver/plastic.js`)

El colapso inelástico de un pórtico se traza **evento a evento**. Dado un conjunto de capacidades por
elemento (`N, Vy, Vz, My, Mz`) y un patrón de carga de referencia, el solver:

1. ensambla `K` honrando las rótulas ya formadas y resuelve la respuesta unitaria `u = K⁻¹·F`;
2. para cada componente halla el incremento de factor de carga `Δλ` que primero alcanza una capacidad,
   `Δλ = mín (±cap − M_acumulado) / tasa`, con la tasa plástica medida respecto de la cuerda del miembro;
3. avanza `λ`, inserta una rótula (fija el GDL de liberación) y redistribuye;
4. repite hasta que `K` se vuelve singular — un **mecanismo de colapso**.

El comportamiento post-fluencia puede ser perfectamente plástico, dúctil con caída a una capacidad
residual tras una rotación última `θu`/desplazamiento `δu`, o frágil (cae al fluir); una caída descarga
una carga auto-equilibrada y puede disparar una cascada. La salida es la secuencia ordenada de rótulas,
el multiplicador de colapso y el campo de desplazamientos — la curva pushover numérica.

### 5.2 Historia temporal no lineal (`js/solver/shear_building.js`, `nl_timehistory.js`)

Para la historia temporal sísmica se integra directamente la ecuación de movimiento
`M·ü + C·u̇ + r(u) = −M·ι·a_g(t)`. La implementación actual reduce la estructura a un **edificio de corte**
— un piso por diafragma rígido, la rigidez de entrepiso `k = V/Δ` obtenida de un análisis lateral
estático, y un cortante de fluencia semilla — y lo integra con:

- una **rótula bilineal** con endurecimiento cinemático (una plasticidad J2 / return-mapping 1-D:
  recarga/descarga elástica, `kt = α·k0` tras fluir, endurecimiento `H = α/(1−α)·k0`);
- **amortiguamiento de Rayleigh** `C = a0·M + a1·K0` anclado a `ζ` en la primera y la última frecuencia
  modal (proporcional a la rigidez inicial, el default de SAP/ETABS);
- el esquema de **Newmark-β** con `γ = ½, β = ¼` (aceleración media constante — incondicionalmente
  estable, sin amortiguamiento numérico), con una corrección de Newton–Raphson en cada paso sobre la
  tangente efectiva `Keff = Kt + (γ/βΔt)·C + (1/βΔt²)·M`, convergiendo con `‖R‖ ≤ 1e-8·‖p‖`.

Se conserva un integrador de diferencias centrales independiente como verificación cruzada. La salida es
la historia de desplazamientos, la deriva pico, y la verificación de deriva de entrepiso contra el límite
del código (§6.8).

<!-- pagebreak -->

## 6. Verificaciones de diseño

### 6.1 El marco de diseño (`js/design/`)

El motor de diseño es un verificador multinorma enchufable. `checkElement` resuelve el material y la
sección, elige un código (explícito, por defecto por familia, o fallback de familia), arma el conjunto de
demandas `{N, Vy, Vz, My, Mz, T}` (con `N > 0` en tracción) y los datos del miembro `{L, Lb, K, Cb, ho}`,
y llama al `check` del código. Cada verificación devuelve razones de utilización por estado límite; la
razón gobernante fija el estado (`cumple` ≤ 0.90, `ajustado` ≤ 1.0, `NO CUMPLE` > 1.0). Los códigos
registrados son AISC 360-16 (LRFD y ASD), Eurocódigo 3, ACI 318-19, Eurocódigo 2, Eurocódigo 9 y NCh1198
(madera).

### 6.2 Acero — AISC 360-16 (`codes/aisc360.js`)

Una resistencia LRFD/ASD es `φ·Rn` o `Rn/Ω`. Estados límite implementados:

- **Tracción (D2)** — fluencia en sección bruta, `φPn = 0.90·Fy·Ag` (la rotura en sección neta no se
  verifica).
- **Compresión (E3)** — pandeo por flexión con la curva de columna
  `Fcr = 0.658^(Fy/Fe)·Fy` para `Fy/Fe ≤ 2.25`, si no `Fcr = 0.877·Fe`, `Fe = π²E/λ²`,
  `λ = máx(KL/r)`. El pandeo de elementos esbeltos (E7) y el torsional no se verifican.
- **Flexión (F2/F6/F9/F10)** — momento plástico `Mpz = Fy·Zz`, con **pandeo lateral-torsional** para
  perfiles I (la triple rama `Lp`, `Lr`, `Cb` de F2), más las reglas de tee (F9) y ángulo simple (F10).
- **Corte (G2)** — `Vn = 0.6·Fy·Aw·Cv` (un `Cv` simplificado de una sola rama).
- **Axial + flexión combinados (H1.1)** — la interacción bilineal `Pr/Pc ≥ 0.2` (H1-1a/H1-1b).

### 6.3 Acero — Eurocódigo 3 (`codes/eurocode3.js`)

EN 1993-1-1 con `γM0 = γM1 = 1.0` (sobreescribible). **Clasifica la sección** (clase 1–4 desde los límites
`9ε/10ε/14ε` de ala y `72ε/83ε/124ε` de alma, `ε = √(235/fy)`) y usa el módulo plástico o elástico según
corresponda. El pandeo usa las curvas europeas `χ = 1/(Φ + √(Φ²−λ̄²))`; los miembros se verifican a
tracción (6.2.3), compresión (6.3.1), flexión con LTB (6.3.2, `Mcr` para I bisimétrica), corte (6.2.6), y
la **interacción 6.3.3** con los factores `kij` del Anexo B (Método 2).

### 6.4 Hormigón — ACI 318-19 / Eurocódigo 2 (`codes/concrete.js`)

El hormigón armado usa el bloque rectangular equivalente (Whitney). La flexión es
`φMn = φ·As·fy·(d − a/2)` con `a = As·fy/(0.85 f'c b)`, `φ = 0.90`. El corte es `φVn = 0.75·(Vc + Vs)` con
`Vc = 0.17·√f'c·b·d`. La **interacción axial–flexión es un diagrama P–M real**: compatibilidad de
deformaciones con `εcu = 0.003`, el factor de bloque `β1`, acero elastoplástico y un `φ` variable
(0.65 → 0.90) generan la poligonal de interacción, y la utilización es la intersección radial del rayo de
demanda con ella; la demanda biaxial usa la regla de contorno de carga
`(Mz/Mnz)^α + (My/Mny)^α ≤ 1`. El Eurocódigo 2 reutiliza por ahora este procedimiento de bloque
rectangular como alias etiquetado (ver §8).

### 6.5 Aluminio — Eurocódigo 9 (`codes/eurocode9.js`)

EN 1999-1-1 con `γM1 = 1.10`, `γM2 = 1.25`, la tensión de prueba al `0.2%` como `fo`, y las curvas de
pandeo EC9. Tracción, compresión (`Nb,Rd = κ·χ·A·fo/γM1`), flexión con LTB y corte están implementadas;
la interacción combinada es por ahora la **suma lineal conservadora** (los exponentes refinados están
pendientes — §8).

### 6.6 Madera — NCh1198 (`codes/timber.js`)

Diseño por tensiones admisibles con el producto de factores de modificación `kmod`. Flexión y corte son
`f ≤ F' = F·kmod`; la tracción axial se combina linealmente con la flexión; la compresión usa el **factor
de columna de Ylinen** `CP` con `FcE = 0.822·E/(le/d)²` y `c = 0.8`, y su interacción parabólica.

### 6.7 Diseño sísmico por capacidad (`js/design/seismic.js`)

La regla **columna fuerte / viga débil** (ACI 318-19 §18.7.3.2 / AISC 341) verifica `ΣMnc ≥ γ·ΣMnb` en
cada nudo, con `γ = 1.2` por defecto; los miembros se clasifican columna/viga/riostra por verticalidad.

### 6.8 Servicio — deriva y deflexión (`js/design/serviceability.js`)

La deriva de entrepiso es una primitiva puramente geométrica, `Δ/h` entre niveles consecutivos (en el
centro de masa, el peor nodo, o automáticamente). El límite depende del código: **NCh433 = 0.002**,
ASCE7/IBC = 0.020, Eurocódigo 8 = 0.010. Los límites de deflexión de miembro son los usuales `L/divisor`
(p. ej. `L/360` viva, `L/240` total), tomando los voladizos un vano efectivo de `2L`.

<!-- pagebreak -->

## 7. Modelo, datos y API

### 7.1 El modelo (`js/model/model.js`)

El modelo en memoria es un conjunto de `Map` indexados por id entero: `nodes`, `elements`, `areas`,
`materials`, `sections`, `diaphragms`, `loadCases`, `combinations`, `links`, más grillas y ajustes por
proyecto (reporte, parámetros de análisis, ajustes de diseño, fuente de masa). Un **nodo** lleva sus
restricciones, masa puntual opcional y resortes (diagonal, 6×6 acoplado, unilateral, suelo tabulado, o un
asentamiento prescrito). Un **elemento** lleva sus dos nodos, material, sección y el arreglo de 12
liberaciones, más flags opcionales de cable/puntal, pretensado, zonas rígidas, resortes de extremo y
fundación. Un **área** es una membrana/placa/cáscara de 3 o 4 nodos con un espesor y un flag de giro
(drilling). Los **materiales** llevan `E, G, ν, ρ, α` y un bloque de diseño opcional; las **secciones**
llevan `A, Iy, Iz, J, Avy, Avz`, los factores de corte, y modificadores de rigidez opcionales.

### 7.2 El archivo `.s3d` (`js/model/serializer.js`)

Un modelo hace round-trip a `.s3d`, un documento JSON plano (`version, units, mode, nodes[], elements[],
areas[], materials[], sections[], diaphragms[], links[], loadCases[], combinations[], grids,
massSource`). El importador valida formas, rellena valores por defecto y recomputa los contadores de id,
así que archivos editados a mano o antiguos cargan de forma segura. También hay round-trip a CSV.

### 7.3 La API pública (`js/api/portico.js`)

`Portico` es la fachada headless: se construye un modelo con los helpers de pre-proceso (`material,
section, node, element, area, loadCase, load, combo, link, …`), se corre un análisis, y se leen
resultados neutrales. Los métodos de análisis son `solveStatic`, `solveModal`, `solveSpectrum`,
`solveModalKg`, `solveBuckling`, `solveStaged`, y la familia no lineal/inelástica `plasticHinge, pDelta,
nonlinearStatic, corotational, pushover, timeHistoryNL, movingLoad, formFinding`. El post-proceso expone
`displacement, reaction, elementForces, diagram, period, frequency, modeShape, bucklingFactor`; el diseño
expone `design, checkMember, checkDeflection, checkDrift, storyDrifts, seismicSCWB`. Se pueden registrar
nuevos análisis y códigos de diseño desde afuera.

<!-- pagebreak -->

## 8. Alcance y limitaciones

El motor es deliberadamente explícito sobre qué cubre y qué no. Tal como está implementado en v0.2.0:

- **Los códigos de diseño son parciales por diseño.** La tracción de AISC 360 es sólo fluencia bruta (sin
  rotura en sección neta); la compresión es sólo pandeo por flexión E3 (sin elementos esbeltos E7, sin
  pandeo torsional/flexo-torsional); el `Cv` de corte es una aproximación de una sola rama. El
  **Eurocódigo 2** es un alias etiquetado del procedimiento de bloque rectangular de ACI — todavía no usa
  los factores parciales de EC2 ni la ley parábola–rectángulo. La interacción combinada del **Eurocódigo
  9** es la suma lineal conservadora; los exponentes refinados están pendientes.
- La **rigidez geométrica** captura sólo pandeo por flexión (los términos geométricos axial y torsional
  se desprecian). **P-Delta** es una iteración secante / punto fijo que converge sobre el cambio de
  desplazamiento, no un esquema de Newton sobre el residuo.
- La **historia temporal no lineal** es un modelo reducido de edificio de corte, no una integración de
  pórtico con plasticidad distribuida.
- Los **esfuerzos espectrales de miembro** se recuperan con la rigidez de elemento simple (sin zonas
  rígidas de extremo ni fundación), una inconsistencia menor frente a la recuperación estática en los
  miembros que usan esas características.
- En el **espectro NCh433**, el parámetro de suelo `n` está tabulado pero no lo consume la fórmula de
  `α(T)` tal como está codificada; confirme que coincide con la formulación NCh433 que pretende antes de
  apoyarse en él.
- Los elementos de área usan una **masa traslacional concentrada** (sin masa rotacional ni consistente de
  área), y la inercia torsional de barra usa una masa polar aproximada.

Ninguna de estas está oculta: cada una es una decisión acotada y documentada, y cada análisis se valida
contra un benchmark de forma cerrada o de motor independiente en el Manual de Verificación.

## Referencias

- D. J. Allman, *A compatible triangular element including vertex rotations for plane elasticity
  analysis*, Computers & Structures 19 (1984).
- K. J. Bathe, *Finite Element Procedures*, Prentice Hall (iteración de subespacio; placa MITC).
- E. N. Dvorkin, K. J. Bathe, *A continuum mechanics based four-node shell element for general nonlinear
  analysis*, Eng. Comput. 1 (1984).
- J. L. Batoz, K. J. Bathe, L. W. Ho, *A study of three-node triangular plate bending elements*, IJNME 15
  (1980) — DKT.
- M. A. Crisfield, *Non-linear Finite Element Analysis of Solids and Structures*, Wiley — viga
  corotacional.
- H.-J. Schek, *The force density method for form finding and computation of general networks*, CMAME 3
  (1974).
- J. S. Przemieniecki, *Theory of Matrix Structural Analysis*, McGraw-Hill — matrices geométrica y de masa
  consistente.
- N. M. Newmark, *A method of computation for structural dynamics*, ASCE (1959).
- A. Der Kiureghian, *A response spectrum method for random vibration analysis of MDF systems*,
  Earthquake Eng. Struct. Dyn. 9 (1981) — CQC.
- ANSI/AISC 360-16; EN 1993-1-1; ACI 318-19; EN 1992-1-1; EN 1999-1-1; NCh433/DS61; NCh1198.

<sub>Este manual documenta el código en v0.2.0. Ver el [Manual de Verificación](verification-manual.es.md)
para la validación cuantitativa. Regenerar las figuras con `node tools/theory_figures.mjs`.</sub>
