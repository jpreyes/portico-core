# Pushover y análisis incremental no lineal (NL-lite)

[English](pushover.md) · **Español**

PORTICO tiene **dos** análisis tipo *pushover* (carga progresiva hasta el colapso),
para dos físicas distintas. Ambos están bajo **Análisis → (NL-lite)** y requieren
activar **«Análisis no lineal (NL-lite)»** en ⚙ Configuración.

| Análisis | Físca | Para qué |
|---|---|---|
| **Pushover — control de desplazamiento** | geométrica (barras/cables, *truss*) | cables, membranas tensadas, **snap-through**, post-pandeo |
| **Rótulas plásticas — colapso** | plástica (marcos, momento Mp) | factor de **colapso plástico** de pórticos, secuencia de rótulas |

> Carga de referencia: ambos usan la **combinación de todos los casos de carga
> estáticos** (a factor 1) como **patrón** de carga. El resultado es un **factor λ**:
> la carga aplicada es `λ × patrón`. Define al menos un caso de carga antes de correr.

---

## A. Pushover por control de desplazamiento

**Análisis → Pushover (control δ).** Resuelve el equilibrio no lineal **controlando
un desplazamiento** (no la carga), lo que permite **pasar los puntos límite** y
trazar la curva carga–desplazamiento completa, incluido el **snap-through**
(tramos de pendiente negativa que el control de carga no puede seguir).

### Cómo se ejecuta

1. Activa **NL-lite** en ⚙ Configuración.
2. Modela la estructura, los **apoyos** y **un caso de carga** (el patrón).
3. **Análisis → Pushover (control δ).**
4. Diálogo **«Imperfección inicial»**: amplitud en metros.
   - `0` → estructura perfecta.
   - `> 0` → se añade una imperfección con la **forma de la respuesta lineal**
     (normalizada) para **disparar** inestabilidades de bifurcación (una columna o
     arco perfectos no pandean numéricamente sin un detonante).
5. Se traza la trayectoria y se abre la **curva carga–desplazamiento**.

### Qué decide el programa por ti

- **GDL de control**: automáticamente el grado de libertad con **mayor
  desplazamiento** en la respuesta lineal (el más representativo del modo). La
  etiqueta indica «nodo N · eje X/Y/Z».
- **Objetivo y pasos**: empuja hasta **25 ×** el desplazamiento lineal de control
  en **60 pasos**, suficiente para recorrer el snap-through completo.

### Cómo se leen los resultados

- **Curva λ–δ**: eje horizontal = desplazamiento del GDL de control; vertical =
  factor de carga **λ**. El **pico de λ** es la **carga límite** (carga máxima que
  resiste = `λ_máx × patrón`).
- **Deslizador / ▶**: recorre o anima los pasos; el modelo muestra la **deformada**
  de cada paso (cables flojos en otro color).
- **Tramo descendente** tras el pico = **snap-through** (la estructura "salta" a
  otra configuración de equilibrio).

### Ejemplo: snap-through de una cercha rebajada (von Mises)

Dos barras inclinadas que se juntan en una cúspide poco peralta, cargada hacia
abajo en la cúspide:

1. Nodos: apoyos en `(0,0,0)` y `(2,0,0)` (fijos), cúspide en `(1,0,0.2)`
   (peralte bajo → propenso a snap-through).
2. Dos barras: apoyo-izq → cúspide y apoyo-der → cúspide (mismo material/sección).
3. Carga **nodal** hacia abajo (−Z) en la cúspide; restringe el desplazamiento
   lateral de la cúspide si quieres el modo simétrico puro.
4. Pushover (control δ), imperfección `0`.
5. La curva sube hasta un **pico** (carga límite), **baja** (snap-through, las
   barras pasan de compresión a tracción al invertirse la cúspide) y vuelve a subir.
   El pico λ × la carga aplicada es la **carga crítica de snap-through**.

---

## B. Rótulas plásticas (pushover plástico de pórticos)

**Análisis → Rótulas plásticas.** Análisis incremental **evento a evento** con
material elasto-perfectamente-plástico: cada extremo de barra forma una **rótula**
al alcanzar su **momento plástico Mp**; el momento queda fijo en Mp y se libera ese
giro. El **colapso** ocurre al formarse un **mecanismo** (la matriz de rigidez se
vuelve singular).

### Cómo se ejecuta

1. Activa **NL-lite**; define apoyos y **un caso de carga** (patrón).
2. *(Opcional, #27b)* **selecciona** los elementos a los que quieras dar un Mp
   distinto.
3. **Análisis → Rótulas plásticas.**
4. Diálogo:
   - **Mp por defecto** [kN·m] (capacidad del resto de elementos).
   - Con selección: **Mp de los seleccionados** y casilla **«sólo la selección
     puede rotular»** (el resto permanece elástico).
5. Resultados en la pestaña **Resultados → «Rótulas»** (respeta el tema):
   - **factor de colapso λc** (si se forma mecanismo) = `λc × patrón`;
   - **secuencia de rótulas** (orden, elemento, nodo, eje, λ de formación, Mp,
     desplazamiento de control);
   - la **deformada del mecanismo** en el visor.

### Lectura

- **λc** es la **carga de colapso plástico** en factores del patrón. Si no se forma
  mecanismo, se informa «sin mecanismo» (la carga no agota la estructura).
- El **orden** de las rótulas indica dónde plastifica primero la estructura → guía
  para redimensionar.

---

## Notas y límites

- El pushover DC trata los elementos como **barras/cables** (sin rigidez a flexión):
  apropiado para celosías, cables y estructuras tensadas; para marcos a flexión usa
  **Rótulas plásticas**.
- Para el **factor crítico de pandeo elástico** (lineal, sin recorrer la
  trayectoria) usa **Pandeo lineal** (ver el problema `(K+λKg)φ=0`).
- Todos los NL-lite parten de la **misma carga de referencia** (suma de casos
  estáticos); ajusta los casos para fijar el patrón de empuje.
