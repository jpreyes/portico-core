# Registro de cambios

[English](CHANGELOG.md) · **Español**

Todos los cambios notables de **portico-core** se documentan en este archivo.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el proyecto sigue [Versionado Semántico](https://semver.org/lang/es/).

> Tipos de cambio: **Añadido** (nuevo), **Cambiado** (en funcionalidad existente),
> **Obsoleto** (a punto de eliminarse), **Eliminado**, **Corregido**, **Seguridad**.

---

## [Sin publicar]

### Añadido

- **Veredicto de estabilidad unificado**: veredicto estructurado de mecanismo /
  casi-singular en `Results.warnings` y `err.stability`, más una sanity de deriva /
  desplazamiento en el post que caza el casi-mecanismo que "resuelve" con basura (p.ej.
  bases en rodillo rescatadas por un diafragma rígido). Se muestra en un banner
  prominente. Vocabulario en `js/solver/stability.js`.
- **Exportador `.ndx`** (`js/io/formats/ndx.js`): serializa el modelo al DSL de texto
  NODEX — mismo patrón de adaptador *downstream* que OpenSees/Abaqus/SAP2000. Cubre el
  subconjunto L1/L2 (nodos, apoyos, materiales, secciones, barras con liberaciones, masas
  nodales, cargas nodales / distribuidas y la intención `solve`), con un *escape hatch*
  crudo para los `analysis.kind` avanzados. Test de round-trip: `test_ndx.mjs`.
- **Solver iterativo (PCG) para mallas grandes** (`js/solver/pcg.js`): un Gradiente
  Conjugado Precondicionado matrix-free (Jacobi / IC0 Cholesky incompleto) para `K·u = F`
  en CSR, alternativa al Cholesky en banda cuando el factor de banda choca con el muro de
  memoria/tiempo. El worker estático disperso lo elige automáticamente para **mallas
  grandes sin restricciones de penalti** (sin diafragmas/links rígidos, cuyo penalti infla
  el número de condición y ahoga al CG); el resto mantiene el factor directo, y el worker
  cae a él si PCG se estanca. Verificado contra el solver directo sobre una matriz de
  rigidez real de marco+shell+diafragma (`test_pcg.mjs`).
- **Importación IFC: fallback de geometría B-rep (malla)** (`js/io/ifc/ifcGeometrySimplifier.js`):
  los elementos exportados como mallas facetadas (`IfcFacetedBrep`/`SurfaceModel`, p.ej. el
  "SurfaceGeometryAddOnView" de Archicad) — sin `IfcExtrudedAreaSolid` ni `Axis` 3D — ahora
  se importan aproximando cada elemento por el bounding box de su malla: un eje dominante →
  **barra** (eje + sección rectangular, o circular por nombre); un eje delgado → **panel**
  (superficie media + espesor; `IfcWall` → membrana, losa/placa/otros → shell); las tres
  dimensiones parecidas → **bloque 3D**, omitido con aviso. Antes estos archivos no importaban
  nada. Verificado con `test_ifc_brep.mjs`.

### Eliminado

- **`SolverBackend` / `SolverRegistry`** (`js/solver/backend.js`): portico-core lleva un
  solo motor, en JavaScript, corriendo en el navegador. Con un único backend el registry
  solo podía despachar a sí mismo — `_supports()` cortocircuitaba y `_dispatch()` no tenía
  a dónde caer — y las marcas `res._backend` / `res._fellBack` que producía no las leía
  nadie. Ahora `app.js` llama directo a los módulos del solver, como ya hacía
  `js/api/portico.js`. Ningún análisis cambió de comportamiento.

### Corregido

- **Áreas de corte que escalan con A**: `Model.addSection` aplicaba un default fijo
  `Avy = Avz = 0.075` (el valor de la sección base) cuando una sección se creaba solo con
  `A`, dejando mal la rigidez de corte Timoshenko de secciones a medida (p.ej. `A = 0.16`
  mantenía `0.075` en vez de `≈ 0.133`). Ahora se derivan como `A·κ` cuando no se dan
  explícitas (las que sí se pasan —p.ej. desde el catálogo de perfiles— se respetan).
  Verificado con `test_shear_area.mjs`.
- **Robustez de importación**: un `.s3d` corrupto / editado a mano (un top-level que no es
  objeto, o una colección como `nodes`/`elements`/`materials`/`areas` que no es lista) ahora
  falla con un mensaje claro *"Archivo .s3d inválido"* en vez de un `TypeError` críptico.
- **Validación de material / sección**: propiedades inválidas (E ≤ 0, G ≤ 0, A ≤ 0,
  Iy/Iz ≤ 0, Poisson ν fuera de [0, 0.5], ν = 0.5 con áreas en deformación plana) se reportan
  como un error claro que bloquea el análisis, en vez de aparecer como un "mecanismo" engañoso.
- **Elementos de área degenerados**: una placa/cáscara colineal o de área cero (nodos
  coincidentes) ahora se detecta y se omite en el ensamblaje y la recuperación de tensiones
  (sin NaN), avisando al usuario, en vez de envenenar K/M con NaN en silencio.
- **Ejemplo `examples/portico_simple.s3d`**: los apoyos de base eran inconsistentes (tres
  rodillos verticales + uno empotrado + uno articulado) y formaban un casi-mecanismo
  lateral que el diafragma rígido enmascaraba (~426 mm de deriva sísmica). Las cuatro bases
  ahora están empotradas — un pórtico de dos pisos estable.

---

## [0.1.0] — 2026-06-30

Primer corte open source de PORTICO: una base limpia, profesional y reutilizable del
pre/post-procesador + visor 3D + solver JS.

### Añadido

- **Aplicación completa y autónoma** de análisis estructural 3D (FEM) en el navegador:
  modelado de barras (Timoshenko, 12 GDL) y áreas (membrana/placa/cáscara), mallado
  libre y mapeado.
- **Análisis:** estático, modal (Stodola inversa), espectro de respuesta (CQC/SRSS),
  P-Δ, pandeo lineal, no lineal geométrico (cables, gran rotación corotacional),
  pushover, time-history modal, etapas constructivas, cargas móviles / líneas de
  influencia, pretensado por tendón y form-finding por densidades de fuerza.
- **Diseño multinorma:** acero (AISC/EC3/NCh), hormigón (ACI/EC2), madera y aluminio
  (EC9), con auto-diseño, reporte y verificación de derivas.
- **Interfaz `SolverBackend`** (`js/solver/backend.js`): costura para motores
  enchufables, con un método async por cada análisis que el JS de core implementa y
  *fallback* transparente al motor JS. El registry despacha el análisis al backend
  activo. (En la edición open solo va el motor JS.)
- **Hooks de extensión** (`js/ext/extensions.js`): `registerConfigSection`,
  `registerBadge`, `setFlag`/`flag` y `registerAnalysis`, para que las capas
  superiores aporten UI, memoria y análisis sin forkear `app.js`. Core registra cero
  análisis adicionales.
- **Post-proceso reutilizable** (`js/solver/postprocess.js`): la matemática de
  diagramas N/V/M(x) y deformada vive una sola vez como funciones puras; cualquier
  backend obtiene diagramas idénticos devolviendo solo fuerzas de extremo.
- **API pública** (`js/api/portico.js`): fachada estable para consumir el pre/solver/
  post desde código, igual en Node y en el navegador.
- **Internacionalización (ES/EN):** motor i18n por string-fuente (`js/i18n/`) con
  fallback a español; diccionario inglés (`dict.en.js`) que cubre menús, portada,
  modales, toasts, el panel de propiedades, los tooltips de la barra y los diálogos.
  El motor también traduce atributos de texto (`title`/`aria-label`/`placeholder`) y
  auto-traduce los paneles que se re-renderizan dinámicamente.
- **Diseño responsive:** la UI es usable en móvil/tablet (panel derecho como *drawer*
  con botón flotante y *scrim*) y el panel derecho ya no recorta su contenido en
  pantallas de escritorio.
- **White-label por configuración** (`branding.default.json` + `js/branding.js`): un loader
  lee el JSON al iniciar (antes de la App) y rellena nombre, tagline, descripción, logo y
  enlaces de la UI vía atributos `data-brand`. White-label sin tocar código ni forkear.
- **Interoperabilidad:** formato `.s3d` (JSON) con round-trip, importación CSV,
  IFC/BIM y asistente para generar modelos desde texto.
- **Suite de verificación** (`test_*.mjs`): 40+ scripts Node autónomos que validan
  contra solución analítica o equilibrio global.
- **Documentación:** `README.md`, `docs/EXTENDING.md` (costuras de extensión),
  `docs/api.md`, `docs/ROADMAP.md`, `CONTRIBUTING.md` y `SECURITY.md`.

### Cambiado

- **De-branding total:** se retiró todo el branding institucional (logos, "material
  docente", referencias académicas). El branding pasó a ser configuración.
- **Nomenclatura de hormigón** a **grado G** (NCh170:2016), con compatibilidad hacia
  atrás del legado «H».
- **El asistente IA es ahora «trae tu propio endpoint» (BYO):** se eliminó el endpoint
  LLM por defecto (`/api/asistente`); el campo de endpoint arranca vacío. Sin endpoint,
  el generador determinista (pegar/editar una ficha JSON) sigue plenamente usable.
- **Normativa agnóstica + presets por jurisdicción:** `assistant/rules.json`,
  `design_params.json` y `live_loads.csv` pasaron a traer tablas de **ejemplo**
  genéricas; la normativa real de cada país vive como **preset opt-in** en `presets/`
  (incluye `presets/chile/` con NCh431/432/433/1537). `assistant/loads.js` **degrada con
  elegancia** si falta una tabla. Ver [`presets/README.md`](presets/README.md).

- **Nombres internacionales (inglés):** se renombró todo a inglés sin romper la app —
  carpetas (`asistente/`→`assistant/`, `docs/ejemplos/`→`docs/examples/`), archivos
  (`reglas.json`→`rules.json`, `cargas.js`→`loads.js`, `generador.js`→`generator.js`,
  `diseno.js`→`design.js`, …), funciones (`generarModelo`→`generateModel`,
  `cargaNieveNCh431`→`snowLoad`, …), claves de datos de la ficha/reglas/diseño
  (`geometria`→`geometry`, `vigas`→`beams`, `acero`→`steel`, …), IDs del DOM
  (`data-vtab`, `vpanel-*`) y valores enum (`empotrado`→`fixed`, `marco`→`frame`, …).
  El formato `.s3d` ya estaba en inglés (no cambia). El generador acepta entradas en
  cualquier idioma (el LLM traduce intención→ficha).

### Eliminado

- **Modo profesional / validación de token:** vive ahora en la capa Pro; core es
  plenamente funcional sin token.
- **Memoria de empresa editable** (descripción, pie, limitaciones, logo, institución):
  se reintroduce desde una capa superior vía `registerConfigSection` +
  `setFlag('memoriaBranding')`.
- **Backend privado del asistente IA:** el Cloudflare Worker (SYSTEM prompt, cascada de
  modelos, API key), el corpus RAG curado y el flujo n8n viven fuera del repo público.
  En core queda solo el generador determinista, el esquema, las bibliotecas de
  perfiles/materiales y ejemplos genéricos en inglés.

[Sin publicar]: https://github.com/jpreyes/portico-core/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jpreyes/portico-core/releases/tag/v0.1.0
