# Pandeo lineal (autovalores, factor crítico λcr)

[English](pandeo.md) · **Español**

> Análisis → (NL-lite) → **Pandeo Lineal** (o el botón en el Centro de análisis).
> Calcula los **factores de carga crítica** λcr y los **modos de pandeo** de la
> estructura bajo el patrón de cargas actual.

## 1. Qué es y para qué sirve

El pandeo lineal (o *eigenvalue buckling*) estima la **carga a la que la estructura
se vuelve inestable** por pérdida de rigidez geométrica (efecto de la compresión).
Responde a: *¿cuántas veces puedo escalar las cargas actuales antes de que la
estructura pandee?* Esa respuesta es el **factor crítico λcr**:

```
P_crítica = λcr · P_aplicada
```

- `λcr > 1` → la estructura resiste las cargas actuales con margen `λcr`.
- `λcr ≤ 1` → pandea **antes** de alcanzar las cargas aplicadas (¡revisar!).

Sirve para columnas, marcos, arcos y reticulados comprimidos, y para estimar la
**longitud de pandeo efectiva** comparando λcr con la fórmula de Euler.

## 2. La formulación (qué resuelve el programa)

Se plantea el problema de autovalores generalizado

```
(K + λ · Kg) · φ = 0
```

donde:

- **K** es la rigidez elástica (la misma del estático),
- **Kg** es la **rigidez geométrica**, proporcional al **estado de esfuerzo axial**
  del análisis estático de referencia (la compresión *ablanda*, la tracción
  *rigidiza*),
- **λ** son los factores de carga crítica (los `λcr` menores son los que importan),
- **φ** es la **forma de pandeo** asociada a cada λ.

PORTICO resuelve los **λcr menores por iteración de subespacio** (el mismo núcleo
del modal), reduciendo con Cholesky sobre `Kᵣ` (SPD), ya que `−Kg` es indefinida.
Es rápido y escala a modelos grandes (reemplaza al `eig` denso O(n³)).

## 3. Cómo ejecutarlo en la app

1. Define el **patrón de cargas** (las cargas que quieres escalar) y, si quieres
   precisión en la deformada/diagramas, activa **Disc. auto** (subdivide las barras).
2. Abre **Análisis → NL-lite → Pandeo Lineal** (o el Centro de análisis).
3. Elige el **N° de modos** de pandeo a extraer (por defecto unos pocos; los menores
   λcr son los críticos). El cálculo corre en un **Web Worker** (no congela la UI).
4. En el overlay de resultados: selector de **modo de pandeo + λcr**, **escala** de
   la forma, y la **carga de pandeo por elemento** (`N_cr = λcr · N_ref`, resaltando
   las barras más comprimidas).

## 4. Ejemplo: columna biarticulada → Euler

1. Modela una **columna vertical** biarticulada (rótula abajo y arriba para el giro
   en el plano de pandeo), subdividida en ~8 elementos (Disc. auto).
2. Aplica una **carga axial de compresión** unitaria en el extremo.
3. Corre **Pandeo Lineal** con 2–3 modos.
4. El primer `λcr` da `P_cr = λcr · P` que debe coincidir con **Euler**
   `P_cr = π²·E·I / (K·L)²` (biarticulada → `K = 1`). La forma del modo 1 es la
   semionda senoidal clásica.

> Verificación numérica: `node test_buckling.mjs` (columna biarticulada: λ₁ −0.28 %,
> λ₂ −1.1 % vs Euler; pares degenerados). Caso documentado equivalente a Euler.

## 5. Consejos y límites

- El pandeo lineal **sobrestima** la carga real de estructuras imperfectas o muy
  esbeltas (no incluye imperfecciones ni plasticidad). Para captar la sensibilidad a
  imperfecciones usa **P-Delta** (NL-lite) con una imperfección inicial, o un
  pushover.
- `Kg` depende del **estado de referencia**: si cambias las cargas, vuelve a correr.
- Tracción pura no pandea (λcr → ∞); el modo crítico aparece donde hay **compresión**.
- Relacionado: **Modal con Kg** (rigidez geométrica en las frecuencias) y **P-Delta**
  (amplificación de segundo orden) comparten el ensamble de `Kg`.

## Referencia

Bathe, K.-J. (1996). *Finite Element Procedures.* Prentice Hall — iteración de
subespacio para `(K + λKg)φ = 0`. Timoshenko & Gere, *Theory of Elastic Stability*.
