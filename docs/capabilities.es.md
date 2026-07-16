# Capacidades de PORTICO

[English](capabilities.md) · **Español**

Mapa honesto de **qué hace PORTICO**, qué hace **parcialmente** y qué queda **fuera de
alcance** del núcleo open source. Muchas capacidades están contrastadas contra soluciones
analíticas o la suite de verificación de CSI/SAP2000 (ver la
[lista de verificaciones](README.md#verifications)).

Estado: ✅ completo · 🟡 parcial · ⛔ fuera de alcance del core.

---

## ✅ Capacidades completas

**Análisis de barras**
- **Estático lineal** de pórticos 3D: barra/viga/columna **Timoshenko** (flexión + corte +
  axial + torsión). *(Verif. 1-018, 0.00 %.)*
- **Cargas:** nodales, distribuidas uniformes y **trapezoidales**, **térmicas** y peso propio;
  proyección con ejes locales rotados.
- **Liberaciones de extremo** (rótulas), **resorte de extremo** (fijación parcial), **cachos
  rígidos / end offsets**, **links rígidos / couplings** con brazo. *(Verif. 1-010.)*
- **Resortes nodales**, **fundación elástica de línea** (Winkler) y **diafragma rígido** (masa
  y centro de rigidez de piso).
- **Desplazamiento prescrito / asentamiento de apoyo.** *(Verif. 1-005.)*
- Miembros **tension-only (cable)** y **compression-only (puntal)**. *(Verif. 1-012.)*

**Dinámica**
- **Modal** (iteración de subespacio de Bathe o Stodola): períodos, formas modales, masa
  participante. *(Verif. 1-014, 1-021.)*
- **Modal con rigidez geométrica Kg** (pre-esfuerzo / cuerda tensa). *(Verif. 1-017.)*
- **Espectro de respuesta** (CQC / SRSS).
- **Time-history modal lineal** (Duhamel / Nigam-Jennings) y **time-history no lineal**
  (edificio de corte con rótulas).

**No lineal (NL-lite)**
- **P-Delta**, **pandeo lineal** de barras y cáscaras (autovalores K+λKg). *(Verif. buckling.)*
- **Cables** (tension-only) y **pretensado por tendón** (balanceo de carga). *(Verif. 1-009.)*
- **Viga corotacional** (gran rotación con flexión), **form-finding** (densidades de fuerza),
  **rótulas plásticas / pushover** (control de carga y de desplazamiento).

**Procesos**
- **Etapas constructivas** (activación de elementos/apoyos, acumulación de estado).
  *(Verif. 1-031.)*
- **Cargas móviles / líneas de influencia** y envolventes. *(Verif. 1-030.)*

**Elementos de área**
- Membrana **CST / QUAD** en **tensión plana** y **deformación plana**. *(Verif. 3-002, 3-004.)*
- Triángulo **Allman** con GDL de giro (drilling). *(Verif. 3-006.)*
- Placa **MITC4 / DKT**, **cáscara** (membrana + placa), tensiones de von Mises;
  **gradiente térmico** a través del espesor. *(Verif. 2-014.)*
- **Mallado** transfinito (Coons) y **libre** (ear-clipping + Delaunay + recombinación a quad).
  *(Verif. 3-001, 3-005.)*

**Diseño y verificación**
- **Diseño multinorma:** acero (AISC 360 / EC3 / NCh), hormigón (ACI 318 / EC2), madera
  (NCh1198) y aluminio (EC9): razones D/C, auto-diseño desde catálogo, reporte, verificación
  de **derivas** y nudos **columna fuerte–viga débil (SCWB)**. *(Verif. 4-001.)*

**Interoperabilidad**
- Formato `.s3d` (JSON), importación CSV, **IFC/BIM** y asistente para generar modelos desde
  texto; exportación a otros motores (SAP2000, ETABS, OpenSees, SOFiSTiK, Abaqus).

---

## 🟡 Capacidades parciales

| Tema | Qué hay | Límite |
|---|---|---|
| **Insertion / cardinal point** | excentricidad vía **link rígido** con brazo | sin un "punto cardinal" de sección dedicado |
| **Pushover por control de δ** | idealiza **reticulado** (axial) | para flexión usar las **rótulas plásticas** (control de carga/δ) |
| **Deformación plana cuasi-incompresible** (ν→0.5) | correcto para ν ≤ 0.3 | **bloqueo volumétrico** del QUAD estándar (sin B-bar) |

---

## ⛔ Fuera de alcance del core open source

- **Secciones no prismáticas** (variación de A/I a lo largo del elemento).
- **Elementos LINK especiales:** amortiguadores (lineales / no lineales), aisladores (goma,
  péndulo de fricción), **gap** (sólo compresión) / **hook** (sólo tracción) como links, Wen
  plástico, links dependientes de frecuencia.
- **Materiales ortótropos.**
- **No linealidad geométrica de área** (grandes desplazamientos de cáscara) y **pretensado de
  área**.
- **Presión de poros / acoplamiento** hidromecánico.

> La lista de arriba es lo que el solver JavaScript **no** cubre hoy. portico-core lleva un solo
> motor, en JS, corriendo en el navegador — no hay un solver nativo ni WASM por detrás.

---

## Resumen

El core open de PORTICO cubre con solidez el **análisis estático, modal, espectral y
time-history** (lineal y no lineal), un amplio set **NL-lite** (cables, corotacional, rótulas,
pushover, pandeo, P-Δ, form-finding), **elementos de área** (membrana/placa/cáscara con mallado
propio) y **diseño multinorma**, todo verificado contra soluciones analíticas y referencias
publicadas. Las brechas se concentran en **elementos especiales** (links/aisladores/
amortiguadores), **secciones no prismáticas**, **no linealidad de área** y **acoplamientos
multifísicos**.
