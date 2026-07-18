# Form-finding (método de densidades de fuerza, FDM)

[English](form-finding.md) · **Español**

> Análisis → (NL-lite) → **Form-finding**. Halla la **forma de equilibrio** de una
> red de barras/cables y reposiciona los nodos a esa geometría (Ctrl+Z deshace).

## 1. Qué es y para qué sirve

El *form-finding* busca la geometría que está en **equilibrio puro de fuerzas
axiales** para una distribución de cargas y de tensiones dada. Es la base del
diseño de:

- **cubiertas tensadas y mallas de cable** (sin cargas, da la red de longitud
  mínima — tipo película de jabón);
- **formas funiculares y arcos** (con cargas, da la directriz que trabaja sólo a
  tracción/compresión, sin flexión).

PORTICO usa el **método de densidades de fuerza** (Schek, 1974), que convierte el
problema en **un sistema lineal** (no itera): rápido y robusto.

## 2. La densidad de fuerza Q (el parámetro clave)

Cada rama (barra/cable) tiene una **densidad de fuerza**

```
q = N / L      [fuerza / longitud]
```

donde `N` es la fuerza axial y `L` la longitud de la rama. El equilibrio de cada
nodo libre `i` es

```
Σ_(ramas i-j)  q · (x_j − x_i)  +  p_i  =  0
```

con `p_i` la carga externa en el nodo. Agrupando, queda `D · x = b`, donde `D` es
un **Laplaciano ponderado por q** (una matriz tipo rigidez de la red). La **misma**
`D` sirve para las tres coordenadas; sólo cambia el lado derecho.

Interpretación práctica de `q`:

- **q grande** → ramas muy "tensas" → forma más **recta/plana** (la red se acerca
  a la línea entre anclas).
- **q pequeño** → ramas más "flojas" → la forma **se cuelga más** bajo la carga.
- **q uniforme y sin carga** → **red de longitud mínima** (geodésica de la malla).

En la app `q` es uniforme (un único valor para todas las ramas).

## 3. Anclas y nodos objetivo (qué se mueve y qué no)

- **Anclas** (no se mueven): son la **referencia** de la forma. Un nodo es ancla si
  - tiene **restricción de traslación** (un apoyo), **o**
  - es **frontera** de la selección: toca un elemento que **no** participa.
- **Nodos objetivo** (se mueven): los nodos libres de las ramas participantes.

> **Acotar la red a los elementos objetivo.** Si seleccionas elementos antes de
> ejecutar, **sólo esos** forman la red; el resto de la estructura queda fijo y sus
> nodos compartidos actúan de ancla. Así puedes formar **sólo una viga** sin tocar
> los pilares. **Sin selección se forma todo el modelo** — apropiado para una red
> de cable completa, pero en un **marco** colapsaría los nodos libres sobre el
> plano de los apoyos (los pilares se "borrarían"). Para marcos: **selecciona
> primero los elementos a formar.**

## 4. Coordenadas a ajustar (ejes)

El diálogo permite elegir qué coordenadas resuelve el FDM:

- **Sólo vertical (Z)** *(recomendado)*: mantiene las **luces en planta** (x, y) y
  sólo ajusta la altura. Es lo correcto para vigas/arcos funiculares: los nodos no
  se "amontonan" horizontalmente.
- **3D (x, y, z)**: redistribuye también en planta. Útil para **mallas y redes de
  cable** donde la posición en planta de los nodos interiores también es libre.

## 5. Ejemplo: viga cargada → directriz funicular (y arco al invertir)

Objetivo del ejemplo: una **viga cargada** que, en vez de flectar, adopte la forma
que trabaja **sin flexión** (funicular de esa carga). Al **invertir** la carga, esa
misma directriz es un **arco** que trabaja a compresión pura.

1. Modela el marco: dos pilares y una viga **subdividida** en varios elementos
   (Auto-discretizar) — los nodos interiores son los que se moverán.
2. Aplica la carga sobre la viga (p.ej. distribuida gravitatoria, o nodal en los
   nodos interiores).
3. **Selecciona sólo los elementos de la viga.** Los topes de pilar quedarán como
   anclas (referencia) y los pilares intactos.
4. Ejecuta **Form-finding**. Elige `q` (empieza con 10) y **Sólo vertical (Z)**.
5. Resultado: los nodos interiores bajan formando la **funicular** (cuelga bajo la
   carga). Carga gravitatoria uniforme → parábola; cargas puntuales → polígono
   funicular.
6. **Para obtener el arco**: invierte el sentido de la carga (carga hacia arriba) y
   repite — la directriz se levanta y queda el **arco** equivalente, que bajo la
   carga original real trabajaría a **compresión** sin flexión.

> Verificación numérica del acotamiento y la funicular: `node tests/test_formfind.mjs`
> (pilares intactos, viga con sag simétrico, luces en planta preservadas).

## 6. Consejos y límites

- El resultado se guarda como **geometría base** del modelo; **Ctrl+Z** restaura.
- La red debe estar **conectada a las anclas**; si un nodo libre queda aislado o si
  `q ≤ 0`, el sistema no es estable y se avisa.
- `q` uniforme es suficiente para la mayoría de casos; densidades por rama (no
  uniformes) permitirían afinar zonas, pero hoy la UI usa un único `q`.
- Tras formar, **re-analiza** (estático) para comprobar que la flexión se redujo
  respecto a la geometría recta original.

## Referencia

Schek, H.-J. (1974). *The force density method for form finding and computation of
general networks.* Computer Methods in Applied Mechanics and Engineering, 3(1),
115–134.
