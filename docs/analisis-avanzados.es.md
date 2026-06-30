# Análisis avanzados — guía rápida (qué hace, cómo se ejecuta, ejemplo)

[English](analisis-avanzados.md) · **Español**

Índice de los análisis de PORTICO más allá del estático. Para cada uno: **qué hace**,
**teoría mínima**, **cómo ejecutarlo** y un **ejemplo característico**. Los que tienen
documento propio se enlazan. Todos se lanzan desde **Análisis** (menú o Centro de
análisis); los pesados corren en **Web Workers** y no congelan la UI.

> Convenciones: Z hacia arriba (como SAP2000/ETABS). GDL por nodo
> `[ux,uy,uz,rx,ry,rz]`. Resultados reutilizables (badge ✓ y botón **Ver**).

---

## Lineales

### Modal (frecuencias y formas modales)
- **Qué**: resuelve `(K − ω²M)φ = 0` → períodos `T = 2π/ω`, formas modales y
  **masas modales participantes** por dirección.
- **Cómo**: Análisis → Modal. Elige N° de modos y método (**iteración de subespacio**
  de Bathe, recomendado, o Stodola). Opción **incluir Kg (P-Δ)** para pre-esfuerzo.
- **Ejemplo**: edificio con diafragmas rígidos → T₁ y % de masa del modo fundamental.

### Espectro de respuesta (NCh433 / DS61, etc.)
- **Qué**: respuesta máxima probable combinando modos (CQC/SRSS) bajo un **espectro**
  de diseño; entrega cortes basales, derivas y esfuerzos de envolvente.
- **Cómo**: Análisis → Espectro (requiere modal). Define la curva (zona/suelo) y la
  dirección. Hereda la discretización del modal.
- **Ejemplo**: edificio Zona 2 / Suelo D → corte basal modal vs estático vs mínimo.

### Time-history lineal (modal, Duhamel)
- **Qué**: respuesta **en el tiempo** ante un acelerograma en la base, por
  **superposición modal** con la integral de **Duhamel** (recurrencia exacta de
  Nigam–Jennings). Monitor de **nodo** (u/θ), **elemento** (N/V/M) o **área**
  (von Mises σ(t) y componentes).
- **Cómo**: Análisis → Time-history. Dirección X/Y/Z, ζ, N° de modos y acelerograma
  (demo sintético o pegar/cargar un registro). Overlay con historia + animación + CSV.
- **Ejemplo**: pórtico con diafragmas → u(t) del techo; muro shell → σ(t) de un panel.

### Pandeo lineal (λcr) → [`pandeo.md`](pandeo.md)
- Factores de carga crítica y modos de pandeo, `(K + λKg)φ = 0` por subespacio.

---

## No lineales (NL-lite)

### P-Delta (segundo orden)
- **Qué**: amplificación por la **rigidez geométrica** del estado de carga
  (compresión ablanda). `(K + Kg)·u = F` iterado.
- **Cómo**: Análisis → NL-lite → P-Delta. Define cargas; opcional imperfección.
- **Ejemplo**: voladizo con `P/Pcr ≈ 0.27` → amplificación ≈ 1.37 (≡ teoría).

### No lineal — cables / solo-tracción / solo-compresión
- **Qué**: Newton corotacional con elementos **cable** (tracción), **puntal**
  (compresión) y grandes desplazamientos.
- **Cómo**: Análisis → NL-lite → No Lineal. **No** uses auto-disc en reticulados.
- **Ejemplo**: red de cables pretensados; arco-puntal solo-compresión.

### Rótulas plásticas / pushover → [`pushover.md`](pushover.md)
- **Qué**: formación incremental de **rótulas** (dúctil / con caída / frágil) en
  N/V/M, curva λ–δ y secuencia de colapso; pushover por control de carga o de
  desplazamiento.
- **Cómo**: Análisis → NL-lite → Rótulas plásticas (o Pushover-DC). Elige Mp/Np/Vp,
  comportamiento y patrón de carga (caso/combo).
- **Ejemplo**: portal 2D → 4 rótulas, mecanismo a λc.

### Form-finding (FDM) → [`form-finding.md`](form-finding.md)
- Geometría de equilibrio de redes de cable/funiculares por densidades de fuerza.

### Time-history NO LINEAL (rótulas, integración directa)
- **Qué**: integración directa **Newmark-β + Newton** con rótulas histeréticas
  (bilineal, endurecimiento cinemático) y amortiguamiento de Rayleigh. Hoy reduce a
  **edificio de corte** editable; el modelo completo con rótulas por extremo de barra
  es una funcionalidad futura.
- **Cómo**: Análisis → NL-lite → Time-history NL. Tabla de pisos editable, dir X/Y, ζ,
  endurecimiento α, acelerograma. Overlay con historia + diagrama «stick» animado.

---

## Para puentes (motores específicos)

- **Etapas constructivas**: análisis incremental por fases (activar elementos/apoyos,
  acumular estado) — cada dovela «nace» sin tensión. Análisis → Puentes → Etapas.
- **Pretensado por tendones**: trazado parabólico/poligonal, pérdidas por
  fricción/ondulación → cargas equivalentes de balanceo. Análisis → Puentes → Tendón.
- **Cargas móviles / líneas de influencia**: barrido de carga o tren multi-eje,
  envolventes de esfuerzos/reacciones. Análisis → Puentes → Cargas móviles.

---

## Diseño y verificación

- **Diseño multinorma** (AISC 360, EC3, ACI 318/EC2, NCh1198, EC9 aluminio):
  pestaña **Diseño** → D/C por elemento, predimensionar, auto-diseño desde catálogo,
  **reporte CSV** y **nudos columna fuerte–viga débil**. Ver [`design.md`](design.md).
- **Verificaciones documentadas**: casos contra solución analítica / referencias publicadas
  en la [lista de verificaciones](README.md#verificaciones).
- **Capacidades del programa** (completas/parciales/ausentes):
  [`capabilities.md`](capabilities.md).
- **API pública** (Node + navegador): [`api.md`](api.md).

---

## Consejos generales

- Corre el **estático** primero; muchos análisis (espectro, P-Delta, pandeo, diseño)
  parten de su estado o lo necesitan como referencia.
- **Disc. auto** mejora deformadas y diagramas en barras a flexión; **no** la uses en
  reticulados puros (nodos internos sin rigidez transversal → mecanismo).
- Si un análisis falla por **singular/mecanismo**, usa **Diagnosticar estabilidad**
  (resalta los GDL sin rigidez).
