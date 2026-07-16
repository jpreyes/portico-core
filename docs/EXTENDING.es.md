# Extender portico-core (capas superiores)

[English](EXTENDING.md) · **Español**

**portico-core** es una aplicación AGPL-3.0 **completa y autónoma**. Las capas
superiores —p. ej. el producto Pro **portico** (motor Nodex C++/WASM, white-label,
memoria de empresa) o productos derivados— se construyen **encima** de core sin
forkear `js/app.js`: importan los módulos de costura y **registran** sus aportes en
runtime.

> **Regla de oro — dependencia unidireccional:** la capa Pro depende de core;
> **core nunca importa nada de la capa Pro.**

> **Principio de honestidad open source:** la interfaz `SolverBackend` declara
> **solo** lo que el JS de core realmente implementa. Las capacidades exclusivas de
> un backend superior (Nodex: alabeo 7-GDL, TH no lineal directa, fiber, LTB con
> warping…) no aparecen en core: se añaden desde la capa Pro vía los hooks de
> extensión.

## Composición física (sin build step)

core carga por *importmap* en `index.html`. La capa Pro mantiene su propio
`index.html`/importmap que carga **los módulos de core + los suyos**, y registra sus
extensiones antes (o durante) el arranque. core se puede consumir como submódulo/subtree.

---

## Costura 1 — Motor de análisis (`js/solver/backend.js`)

El pre/post consume siempre `solverRegistry`. Todos los análisis que el JS de core
implementa fluyen por el registry; un backend superior los reemplaza sin tocar core.

### 1.1 Métodos del contrato (lo que el JS de core realmente hace)

| Método | Firma | Devuelve |
|---|---|---|
| `solveStatic` | `(model, lcId, opts)` | `Results` |
| `solveModal` | `(model, nModes)` | `ModalResults` |
| `solveSpectrum` | `(mr, params)` | `SpectrumResults` |
| `solveBuckling` | `({ Kff_flat, Kgff_flat, nF, nModes, dense })` | `{ modes, error? }` |
| `solveNonlinear` | `(o)` | `{ converged, steps, reactions, u }` |
| `solveNonlinearDC` | `(o)` | `{ ok, path, note }` |
| `solveCorotBeam` | `(o)` | `{ converged, steps, u }` |
| `solvePushover` | `(o)` | `{ ok, path, note }` |
| `solveTimeHistoryModal` | `(o)` | `{ t, q, nSteps, … }` |
| `solveStaged` | `(model, stages)` | `StagedResult` |
| `solveMovingLoads` | `(model, lane, train, responses, opts)` | `{ positions, series, env }` |
| `solveTendon` | `(model, tendon)` | `{ loads, P, weq, L }` |
| `solveFormFind` | `(o)` | `{ ok, coords, freeIdx, note }` |

### 1.2 `capabilities()` por método + fallback robusto

`capabilities()` es la **fuente de verdad por método**: el registry mantiene un mapeo
método→flag (`solveModal`→`modal`, `solveBuckling`→`buckling`, `solveNonlinearDC`→
`nonlinearDC`, `solveCorotBeam`→`corotBeam`, `solveTimeHistoryModal`→`timeHistoryModal`,
…) y rutea un método al backend activo **solo si declara ese flag**. Así un backend
parcial (p. ej. Nodex: solo estático) declara exactamente lo que implementa y todo lo
demás cae a `js` automáticamente.

Para cada llamada, `SolverRegistry._dispatch(method, args, canArgs)`:

1. Usa el backend **activo** si `capabilities()[flag]` es `true` **y** (si lo implementa)
   `canSolve(...canArgs).ok`; si no, usa `'js'`.
2. Envuelve la ejecución en `try/catch`: si el backend elegido (≠ `'js'`) **lanza** en
   runtime, **reintenta en `'js'`**. `'js'` es el fallback universal; si `'js'` también
   lanza, el error se propaga.
3. Marca el resultado con `res._backend` (quién resolvió) y `res._fellBack` (si hubo
   fallback).

`solveStatic` conserva su firma y su `canSolve(model, lcId, opts)`, alineado al mismo
patrón. `JsSolverBackend.capabilities()` declara **todos** los flags (es el fallback
universal); `SolverBackend` base devuelve `{}` (no implementa nada → un backend que
extiende la base y no declara capacidades nunca se selecciona, y core sigue funcionando
con `js`).

> Un backend superior **no necesita implementar todos los métodos**: declara en
> `capabilities()` solo los que cubre; el registry enruta el resto a `js` sin que el
> backend tenga que devolver `false` en `canSolve` ni implementar stubs.

### 1.3 Registrar Nodex (C++/WASM)

Un backend **parcial** declara solo lo que cubre; el registry enruta lo demás a `js`:

```js
import { solverRegistry, SolverBackend } from './js/solver/backend.js?v=2';

class NodexBackend extends SolverBackend {
  get name()  { return 'cpp'; }
  get label() { return 'Nodex (C++/WASM)'; }

  capabilities() {
    return {
      // Lo que Nodex implementa hoy (lo no declarado cae a 'js' automáticamente):
      static: true, modal: true, buckling: true,
      // Capacidades que SOLO Nodex tiene:
      warping: true, fiber: true, nlTimeHistoryDirect: true, ltbWarping: true,
    };
  }

  // canSolve es un gate secundario opcional (p. ej. estático que mira el modelo).
  canSolve(model, lcId, opts) { return { ok: true, reasons: [] }; }

  async solveStatic(model, lcId, opts) { /* … WASM … */ }
  async solveModal(model, nModes)      { /* … */ }
  async solveBuckling(o)               { /* … */ }
  // NO implementa spectrum/nonlinear/staged/… → el registry los resuelve con 'js'.
}

solverRegistry.register(new NodexBackend()).setActive('cpp');
// El registry usa Nodex para static/modal/buckling y cae a 'js' en el resto;
// si Nodex lanza en runtime, también reintenta en 'js' (res._fellBack === true).
```

**`JsSolverBackend.capabilities()`** es la fuente de verdad honesta de lo que el JS
implementa (declara los 13 flags). `NodexBackend.capabilities()` declara su subconjunto
+ lo que Nodex suma. No hace falta implementar stubs ni devolver `false` en `canSolve`
para los métodos no cubiertos: basta con **no declarar** el flag.

### 1.4 Veredicto de estabilidad (agnóstico al backend)

Todo objeto de resultados (`Results`, `WasmResults`) expone un array `warnings` con un **vocabulario
compartido** para que la UI muestre el mismo veredicto sea cual sea el backend — ver
[`NODEX-CONTRACT.md`](../NODEX-CONTRACT.md) y [`js/solver/stability.js`](../js/solver/stability.js).

- **Nivel solver** (el backend que factoriza): `STABILITY_MECHANISM` (singular → `err.stability`
  estructurado) y `STABILITY_ILL_CONDITIONED` (casi-singular por pivote, best-effort — un diafragma
  por penalti puede enmascararlo).
- **Sanity en el post** (en PÓRTICO, idéntico para cualquier backend): `assessStabilitySanity(model, res)`
  lee los **resultados** — deriva de entrepiso (niveles de diafragma + alturas) y desplazamiento
  absoluto vs el tamaño del modelo — y emite `STABILITY_DRIFT` / `STABILITY_DISPLACEMENT`. Esto caza
  el casi-mecanismo que "resuelve" con basura (p.ej. bases en rodillo rescatadas por un diafragma
  rígido), invisible para la sola resolución matricial. La app los muestra todos en un banner prominente.

---

## Costura 2 — UI y memoria (`js/ext/extensions.js`)

Un único singleton `extensions` con tres puntos de registro.

### 2.1 Secciones del diálogo ⚙ Configuración
```js
import { extensions } from './js/ext/extensions.js?v=2';

extensions.registerConfigSection({
  id: 'pro-memoria',
  render: (ctx) => `<fieldset><legend>Memoria — contenido (Pro)</legend>
     <textarea id="cfg-pro-desc">${ctx.esc(ctx.mm.descripcion || '')}</textarea></fieldset>`,
  bind:    (ctx) => { /* addEventListener a tus inputs */ },
  collect: (ctx) => { ctx.mm.descripcion = document.getElementById('cfg-pro-desc').value; },
});
```
`ctx = { app, mm, an, sd, esc }` — `mm` es la copia de trabajo de la memoria (core la
persiste por-proyecto en el `.s3d` y como default global al guardar); `an` es
`config.analisis`; `sd` los modificadores de sección; `esc` escapa atributos.

### 2.2 Insignias de la barra superior
```js
extensions.registerBadge({ id: 'pro', html: '<span class="badge-pro">PRO</span>' });
```
Se pintan en `#ext-badges` al iniciar (`App._initExtensions`).

### 2.3 Flags de capacidad
```js
extensions.setFlag('memoriaBranding', true);   // habilita logo/pie/limitaciones de empresa
```
core lee `memoriaBranding` (vía `App._brandingPro`) en el generador de memoria; en
core es `false` → se usa la **plantilla estándar** (pie y limitaciones por defecto).

### 2.4 White-label por configuración (`branding.default.json` + `js/branding.js`)

Para cambiar nombre, lema, descripción y logo **sin tocar código ni forkear**, edita
`branding.default.json`. `js/branding.js` lo lee al iniciar (antes de arrancar la `App`,
para que el i18n cachee el texto ya «branded») y rellena los elementos marcados con
`data-brand` en `index.html`:

```html
<span data-brand="appName">PORTICO</span>
<span data-brand="tagline">Análisis y diseño estructural 3D</span>
<svg data-brand-logo ...></svg>          <!-- se reemplaza por logos.primary si se define -->
<a data-brand-link="repo" href="#">…</a> <!-- href ← links.repo -->
```

```json
{ "appName": "ACME Structural", "tagline": "FEM in the browser",
  "description": "…", "logos": { "primary": "assets/acme.svg" },
  "links": { "repo": "https://github.com/acme/…" } }
```

Campos de texto soportados: `data-brand="appName|tagline|description"`. Si un campo
falta o el JSON no carga, la UI conserva su texto por defecto (español) y el i18n lo
traduce normalmente. La `App` usa `getBranding().appName` para el `<title>` por modelo.

---

## Costura 3 — Post-proceso reutilizable por backends (`js/solver/postprocess.js`)

La matemática de **diagramas N/V/M(x) y deformada a partir de fuerzas de extremo** vive
UNA sola vez en core, como **funciones puras** exportadas. Así un backend del
`solverRegistry` solo necesita devolver fuerzas de extremo (+ geometría y cargas locales)
y obtiene **diagramas idénticos** al solver JS, sin reimplementar nada. La clase `Results`
(solver JS) delega en estas mismas funciones.

```js
import { actualLoadsLocal, diagramFromForces, elemAtXiFromForces }
  from './js/solver/postprocess.js?v=2';
```

| Función | Firma | Devuelve |
|---|---|---|
| `actualLoadsLocal` | `(model, lcId, selfWeight, elem, ex, ey, ez)` | `{qy, qz, qy1, qy2, qz1, qz2}` — intensidades de carga distribuida en marco local (uniforme + trapecial). Fuente de verdad de `q(x)`; nunca inferir de las fuerzas de extremo. |
| `diagramFromForces` | `(f, n1, n2, type, nPts)` | `{pts, extremes, maxVal, minVal}` — diagrama por integración de equilibrio (exacto para uniforme/trapecial). `type ∈ 'N','Vy','Vz','T','My','Mz'`. |
| `elemAtXiFromForces` | `(f, xi)` | fuerzas + desplazamiento interpolado en `xi∈[0,1]` (equilibrio + Hermite con burbuja de carga). |

`f` es el objeto RICO de fuerzas de extremo que produce `Results.getElemForces` (y que el
backend debe replicar): `N, Vy1, Vz1, T, My1, Mz1, Vy2, Vz2, My2, Mz2, ex, ey, ez, L,
qy, qz, qy1, qy2, qz1, qz2, EIz, EIy, _ue, …`.

**Ejemplo de uso desde un backend** (p. ej. el `WasmResults` de Nodex en el repo Pro):
arma `f` con las fuerzas de extremo del C++ rotadas a su marco local, lo completa con
`actualLoadsLocal(...)` (mismas cargas que el solver JS) y dibuja con `diagramFromForces` /
`elemAtXiFromForces`. Resultado: diagramas y deformada idénticos a los del solver JS,
validado a precisión de máquina.

---

## Qué NO vive en core

Estas piezas pertenecen a la capa Pro y se quitaron de core en v0.1:

- Validación de **token profesional** (antes `/api/assistant/pro` en el worker y la
  UI de "Modo profesional"). *Nota AGPL: un token sobre código abierto no restringe
  el uso; la protección real es que el código Pro no se distribuye.*
- Memoria de empresa editable: **descripción, pie, limitaciones, logo, institución**
  → se re-añaden vía `registerConfigSection` + `setFlag('memoriaBranding')`.
- Motor de análisis alternativo y análisis exclusivos de Nodex
  → vía `solverRegistry.register(new NodexBackend())`.
- Análisis que el JS de core NO implementa (alabeo 7-GDL, TH no lineal directa,
  fiber, LTB con warping, etc.) → **no aparecen en la interfaz de core**. Una capa
  superior que implemente alguno registra su backend y lo expone desde su propia UI.
- **Backend del asistente IA** (el Cloudflare Worker con el SYSTEM prompt, la
  cascada de modelos y la API key, más el corpus RAG curado y el flujo n8n) →
  vive fuera del repo público. En core queda **solo** el generador determinista
  (`assistant/generator.js`: ficha JSON → modelo, sin IA), el esquema, las
  bibliotecas de perfiles/materiales y **ejemplos genéricos en inglés**. El
  endpoint LLM es **«trae tu propio servicio» (BYO)**: el campo de endpoint del
  diálogo del asistente arranca vacío; sin un endpoint configurado, el botón
  «Pedir ficha al asistente» avisa y la app sigue usable con el generador
  determinista (pegar/editar una ficha JSON). Una capa superior puede registrar
  su propio endpoint y servir el backend.
- **Normativa de una jurisdicción.** El core es **agnóstico**: `assistant/rules.json`,
  `assistant/design_params.json` y `assistant/live_loads.csv` traen tablas de
  **ejemplo** genéricas (cargas, espectro, parámetros de diseño), no el código de ningún
  país. La normativa real vive como **preset opt-in** en `presets/<pais>/` (ver
  [`presets/README.md`](../presets/README.md)): se copia sobre `assistant/` (mismas claves).
  El motor (`assistant/loads.js`, `generator.js`) es agnóstico y **degrada con elegancia**
  si una tabla falta. Para aportar el código de tu país, crea `presets/<pais>/` y abre un PR.
