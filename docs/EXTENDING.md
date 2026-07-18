# Extending portico-core (upper layers)

**English** · [Español](EXTENDING.es.md)

**portico-core** is a **complete, self-contained** AGPL-3.0 application. Upper layers —a white-label
build, a company report, a domain product— are built **on top of** core without forking
`js/app.js`: they import the seam modules and **register** their contributions at runtime.

> **Golden rule — one-way dependency:** the overlay depends on core; **core never imports
> anything from the overlay.**

> **The engine is JavaScript, and there is only one.** Everything solves in the browser; there is
> no native, WASM or remote backend to plug in, and no abstraction pretending otherwise. Analyses
> core's JS does not implement (7-DOF warping, direct nonlinear TH, fiber, LTB with warping…)
> simply do not exist here — see [capabilities](capabilities.md).

## Physical composition (no build step)

core loads via *importmap* in `index.html`. An overlay keeps its own `index.html`/importmap that
loads **core's modules + its own**, and registers its extensions before (or during) startup.
core can be consumed as a submodule/subtree.

---

## Stability verdict

A `Results` object exposes a `warnings` array using one **shared vocabulary** so the UI shows the
same stability verdict for every analysis — see [`js/solver/stability.js`](../js/solver/stability.js).

- **Solver level** (which owns the factorization): `STABILITY_MECHANISM` (singular →
  structured `err.stability`) and `STABILITY_ILL_CONDITIONED` (near-singular pivot, best-effort —
  a penalty diaphragm can mask it).
- **Post sanity**: `assessStabilitySanity(model, res)`
  reads the **results** — inter-story drift (diaphragm floors + heights) and absolute displacement
  vs the model span — and emits `STABILITY_DRIFT` / `STABILITY_DISPLACEMENT`. This catches a
  near-mechanism that "solves" with garbage (e.g. roller bases rescued by a rigid diaphragm), which
  the matrix solve alone never reports. The app surfaces all of them in one prominent banner.

---

## Seam 1 — UI and report (`js/ext/extensions.js`)

A single `extensions` singleton with three registration points.

### 1.1 Sections of the ⚙ Settings dialog
```js
import { extensions } from './js/ext/extensions.js?v=2';

extensions.registerConfigSection({
  id: 'pro-report',
  render: (ctx) => `<fieldset><legend>Report — content (Pro)</legend>
     <textarea id="cfg-pro-desc">${ctx.esc(ctx.mm.descripcion || '')}</textarea></fieldset>`,
  bind:    (ctx) => { /* addEventListener on your inputs */ },
  collect: (ctx) => { ctx.mm.descripcion = document.getElementById('cfg-pro-desc').value; },
});
```
`ctx = { app, mm, an, sd, esc }` — `mm` is the working copy of the report (core persists it
per-project in the `.s3d` and as a global default on save); `an` is `config.analisis`; `sd` the
section modifiers; `esc` escapes attributes.

### 1.2 Top-bar badges
```js
extensions.registerBadge({ id: 'pro', html: '<span class="badge-pro">PRO</span>' });
```
They are painted into `#ext-badges` at startup (`App._initExtensions`).

### 1.3 Capability flags
```js
extensions.setFlag('memoriaBranding', true);   // enables company logo/footer/limitations
```
core reads `memoriaBranding` (via `App._brandingPro`) in the report generator; in core it is
`false` → the **standard template** is used (default footer and limitations).

### 1.4 White-label by configuration (`branding.default.json` + `js/branding.js`)

To change the name, tagline, description and logo **without touching code or forking**, edit
`branding.default.json`. `js/branding.js` reads it at startup (before starting the `App`, so the
i18n caches the already-"branded" text) and fills the elements marked with `data-brand` in
`index.html`:

```html
<span data-brand="appName">PORTICO</span>
<span data-brand="tagline">3D structural analysis & design</span>
<svg data-brand-logo ...></svg>          <!-- replaced by logos.primary if defined -->
<a data-brand-link="repo" href="#">…</a> <!-- href ← links.repo -->
```

```json
{ "appName": "ACME Structural", "tagline": "FEM in the browser",
  "description": "…", "logos": { "primary": "assets/acme.svg" },
  "links": { "repo": "https://github.com/acme/…" } }
```

Supported text fields: `data-brand="appName|tagline|description"`. If a field is missing or the
JSON does not load, the UI keeps its default text (Spanish) and the i18n translates it normally.
The `App` uses `getBranding().appName` for the per-model `<title>`.

---

## Seam 2 — Reusable post-processing (`js/solver/postprocess.js`)

The math of **N/V/M(x) diagrams and the deformed shape from end forces** lives in core ONCE, as
exported **pure functions**. Anything holding end forces (+ geometry and local loads) obtains
**identical diagrams** by calling them, without reimplementing anything. The `Results` class
delegates to these same functions.

```js
import { actualLoadsLocal, diagramFromForces, elemAtXiFromForces }
  from './js/solver/postprocess.js?v=2';
```

| Function | Signature | Returns |
|---|---|---|
| `actualLoadsLocal` | `(model, lcId, selfWeight, elem, ex, ey, ez)` | `{qy, qz, qy1, qy2, qz1, qz2}` — distributed-load intensities in the local frame (uniform + trapezoidal). Source of truth for `q(x)`; never infer it from the end forces. |
| `diagramFromForces` | `(f, n1, n2, type, nPts)` | `{pts, extremes, maxVal, minVal}` — diagram by equilibrium integration (exact for uniform/trapezoidal). `type ∈ 'N','Vy','Vz','T','My','Mz'`. |
| `elemAtXiFromForces` | `(f, xi)` | forces + interpolated displacement at `xi∈[0,1]` (equilibrium + Hermite with a load bubble). |

`f` is the RICH end-force object that `Results.getElemForces` produces: `N, Vy1, Vz1, T, My1, Mz1,
Vy2, Vz2, My2, Mz2, ex, ey, ez, L, qy, qz, qy1, qy2, qz1, qz2, EIz, EIy, _ue, …`.

**Usage**: build `f` with end forces in the element's local frame, complete it with
`actualLoadsLocal(...)` and draw with `diagramFromForces` / `elemAtXiFromForces`.

---

## What does NOT live in core

These pieces are not part of core and were removed in v0.1:

- **Professional token** validation (formerly `/api/assistant/pro` in the worker and the
  "Professional mode" UI). *AGPL note: a token over open-source code does not restrict use; the
  real protection is that the closed code is not distributed.*
- Editable company report: **description, footer, limitations, logo, institution** → re-added via
  `registerConfigSection` + `setFlag('memoriaBranding')`.
- Analyses the JS solver does NOT implement (7-DOF warping, direct nonlinear TH, fiber, LTB with
  warping, etc.) → they are simply **not available**.
- **AI assistant backend** (the Cloudflare Worker with the SYSTEM prompt, the model cascade and the
  API key, plus the curated RAG corpus and the n8n flow) → it lives outside the public repo. In
  core there remains **only** the deterministic generator (`assistant/generator.js`: JSON spec →
  model, no AI), the schema, the profile/material libraries and **generic examples in English**.
  The LLM endpoint is **"bring your own service" (BYO)**: the assistant dialog's endpoint field
  starts empty; with no endpoint configured, the "Ask the assistant for a spec" button warns and
  the app stays usable with the deterministic generator (paste/edit a JSON spec). An upper layer
  can register its own endpoint and serve the backend.
- **A jurisdiction's code.** core is **agnostic**: `assistant/rules.json`,
  `assistant/design_params.json` and `assistant/live_loads.csv` ship generic **example** tables
  (loads, spectrum, design parameters), not any country's code. The real code lives as an **opt-in
  preset** in `presets/<country>/` (see [`presets/README.md`](../presets/README.md)): it is copied
  over `assistant/` (same keys). The engine (`assistant/loads.js`, `generator.js`) is agnostic and
  **degrades gracefully** if a table is missing. To contribute your country's code, create
  `presets/<country>/` and open a PR.
