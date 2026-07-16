# Extender portico-core (capas superiores)

[English](EXTENDING.md) · **Español**

**portico-core** es una aplicación AGPL-3.0 **completa y autónoma**. Las capas
superiores —un build white-label, una memoria de empresa, un producto de dominio— se
construyen **encima** de core sin forkear `js/app.js`: importan los módulos de costura
y **registran** sus aportes en runtime.

> **Regla de oro — dependencia unidireccional:** la capa superior depende de core;
> **core nunca importa nada de la capa superior.**

> **El motor es JavaScript, y es uno solo.** Todo resuelve en el navegador: no hay
> backend nativo, WASM ni remoto que enchufar, ni una abstracción que finja lo
> contrario. Los análisis que el JS de core no implementa (alabeo 7-GDL, TH no lineal
> directa, fiber, LTB con warping…) sencillamente no existen aquí — ver
> [capacidades](capabilities.es.md).

## Composición física (sin build step)

core carga por *importmap* en `index.html`. La capa superior mantiene su propio
`index.html`/importmap que carga **los módulos de core + los suyos**, y registra sus
extensiones antes (o durante) el arranque. core se puede consumir como submódulo/subtree.

---

## Veredicto de estabilidad

Un objeto `Results` expone un array `warnings` con un **vocabulario compartido** para que la UI
muestre el mismo veredicto en cualquier análisis — ver [`js/solver/stability.js`](../js/solver/stability.js).

- **Nivel solver** (el que factoriza): `STABILITY_MECHANISM` (singular → `err.stability`
  estructurado) y `STABILITY_ILL_CONDITIONED` (casi-singular por pivote, best-effort — un diafragma
  por penalti puede enmascararlo).
- **Sanity en el post**: `assessStabilitySanity(model, res)`
  lee los **resultados** — deriva de entrepiso (niveles de diafragma + alturas) y desplazamiento
  absoluto vs el tamaño del modelo — y emite `STABILITY_DRIFT` / `STABILITY_DISPLACEMENT`. Esto caza
  el casi-mecanismo que "resuelve" con basura (p.ej. bases en rodillo rescatadas por un diafragma
  rígido), invisible para la sola resolución matricial. La app los muestra todos en un banner prominente.

---

## Costura 1 — UI y memoria (`js/ext/extensions.js`)

Un único singleton `extensions` con tres puntos de registro.

### 1.1 Secciones del diálogo ⚙ Configuración
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

### 1.2 Insignias de la barra superior
```js
extensions.registerBadge({ id: 'pro', html: '<span class="badge-pro">PRO</span>' });
```
Se pintan en `#ext-badges` al iniciar (`App._initExtensions`).

### 1.3 Flags de capacidad
```js
extensions.setFlag('memoriaBranding', true);   // habilita logo/pie/limitaciones de empresa
```
core lee `memoriaBranding` (vía `App._brandingPro`) en el generador de memoria; en
core es `false` → se usa la **plantilla estándar** (pie y limitaciones por defecto).

### 1.4 White-label por configuración (`branding.default.json` + `js/branding.js`)

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

## Costura 2 — Post-proceso reutilizable (`js/solver/postprocess.js`)

La matemática de **diagramas N/V/M(x) y deformada a partir de fuerzas de extremo** vive
UNA sola vez en core, como **funciones puras** exportadas. Cualquiera que tenga fuerzas de
extremo (+ geometría y cargas locales) obtiene **diagramas idénticos** llamándolas, sin
reimplementar nada. La clase `Results` delega en estas mismas funciones.

```js
import { actualLoadsLocal, diagramFromForces, elemAtXiFromForces }
  from './js/solver/postprocess.js?v=2';
```

| Función | Firma | Devuelve |
|---|---|---|
| `actualLoadsLocal` | `(model, lcId, selfWeight, elem, ex, ey, ez)` | `{qy, qz, qy1, qy2, qz1, qz2}` — intensidades de carga distribuida en marco local (uniforme + trapecial). Fuente de verdad de `q(x)`; nunca inferir de las fuerzas de extremo. |
| `diagramFromForces` | `(f, n1, n2, type, nPts)` | `{pts, extremes, maxVal, minVal}` — diagrama por integración de equilibrio (exacto para uniforme/trapecial). `type ∈ 'N','Vy','Vz','T','My','Mz'`. |
| `elemAtXiFromForces` | `(f, xi)` | fuerzas + desplazamiento interpolado en `xi∈[0,1]` (equilibrio + Hermite con burbuja de carga). |

`f` es el objeto RICO de fuerzas de extremo que produce `Results.getElemForces`:
`N, Vy1, Vz1, T, My1, Mz1, Vy2, Vz2, My2, Mz2, ex, ey, ez, L, qy, qz, qy1, qy2, qz1,
qz2, EIz, EIy, _ue, …`.

**Uso**: arma `f` con las fuerzas de extremo en el marco local del elemento, complétalo
con `actualLoadsLocal(...)` y dibuja con `diagramFromForces` / `elemAtXiFromForces`.

---

## Qué NO vive en core

Estas piezas no son parte de core y se quitaron en v0.1:

- Validación de **token profesional** (antes `/api/assistant/pro` en el worker y la
  UI de "Modo profesional"). *Nota AGPL: un token sobre código abierto no restringe
  el uso; la protección real es que el código cerrado no se distribuye.*
- Memoria de empresa editable: **descripción, pie, limitaciones, logo, institución**
  → se re-añaden vía `registerConfigSection` + `setFlag('memoriaBranding')`.
- Análisis que el solver JS NO implementa (alabeo 7-GDL, TH no lineal directa,
  fiber, LTB con warping, etc.) → sencillamente **no están disponibles**.
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
