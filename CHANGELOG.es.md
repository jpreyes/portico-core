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

- **Veredicto de estabilidad unificado** (core JS ↔ backend enchufable, p.ej. Nodex):
  veredicto estructurado de mecanismo / casi-singular en `Results.warnings` y
  `err.stability`, más una sanity de deriva / desplazamiento agnóstica al backend en el
  post que caza el casi-mecanismo que "resuelve" con basura (p.ej. bases en rodillo
  rescatadas por un diafragma rígido). Se muestra en un banner prominente, idéntico sea
  cual sea el backend activo. Vocabulario compartido en
  [`NODEX-CONTRACT.md`](NODEX-CONTRACT.md) y `js/solver/stability.js`.

### Corregido

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
