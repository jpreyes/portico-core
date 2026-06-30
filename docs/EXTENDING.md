# Extending portico-core (upper layers)

**English** · [Español](EXTENDING.es.md)

**portico-core** is a **complete, self-contained** AGPL-3.0 application. The upper layers —e.g.
the Pro product **portico** (Nodex C++/WASM engine, white-label, company report) or derived
products— are built **on top of** core without forking `js/app.js`: they import the seam modules
and **register** their contributions at runtime.

> **Golden rule — one-way dependency:** the Pro layer depends on core; **core never imports
> anything from the Pro layer.**

> **Open-source honesty principle:** the `SolverBackend` interface declares **only** what core's
> JS actually implements. Capabilities exclusive to an upper backend (Nodex: 7-DOF warping, direct
> nonlinear TH, fiber, LTB with warping…) do not appear in core: they are added from the Pro layer
> via the extension hooks.

## Physical composition (no build step)

core loads via *importmap* in `index.html`. The Pro layer keeps its own `index.html`/importmap
that loads **core's modules + its own**, and registers its extensions before (or during) startup.
core can be consumed as a submodule/subtree.

---

## Seam 1 — Analysis engine (`js/solver/backend.js`)

The pre/post always consumes `solverRegistry`. All the analyses core's JS implements flow through
the registry; an upper backend replaces them without touching core.

### 1.1 Contract methods (what core's JS actually does)

| Method | Signature | Returns |
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

### 1.2 `capabilities()` per method + robust fallback

`capabilities()` is the **per-method source of truth**: the registry keeps a method→flag mapping
(`solveModal`→`modal`, `solveBuckling`→`buckling`, `solveNonlinearDC`→`nonlinearDC`,
`solveCorotBeam`→`corotBeam`, `solveTimeHistoryModal`→`timeHistoryModal`, …) and routes a method to
the active backend **only if it declares that flag**. This way a partial backend (e.g. Nodex: only
static) declares exactly what it implements and everything else falls back to `js` automatically.

For each call, `SolverRegistry._dispatch(method, args, canArgs)`:

1. Uses the **active** backend if `capabilities()[flag]` is `true` **and** (if it implements it)
   `canSolve(...canArgs).ok`; otherwise it uses `'js'`.
2. Wraps the execution in `try/catch`: if the chosen backend (≠ `'js'`) **throws** at runtime, it
   **retries in `'js'`**. `'js'` is the universal fallback; if `'js'` also throws, the error
   propagates.
3. Marks the result with `res._backend` (who solved it) and `res._fellBack` (whether there was a
   fallback).

`solveStatic` keeps its signature and its `canSolve(model, lcId, opts)`, aligned to the same
pattern. `JsSolverBackend.capabilities()` declares **all** the flags (it is the universal
fallback); the base `SolverBackend` returns `{}` (implements nothing → a backend that extends the
base and declares no capabilities is never selected, and core keeps working with `js`).

> An upper backend **does not need to implement every method**: it declares in `capabilities()`
> only the ones it covers; the registry routes the rest to `js` without the backend having to
> return `false` in `canSolve` or implement stubs.

### 1.3 Registering Nodex (C++/WASM)

A **partial** backend declares only what it covers; the registry routes the rest to `js`:

```js
import { solverRegistry, SolverBackend } from './js/solver/backend.js?v=214';

class NodexBackend extends SolverBackend {
  get name()  { return 'cpp'; }
  get label() { return 'Nodex (C++/WASM)'; }

  capabilities() {
    return {
      // What Nodex implements today (anything not declared falls back to 'js' automatically):
      static: true, modal: true, buckling: true,
      // Capabilities that ONLY Nodex has:
      warping: true, fiber: true, nlTimeHistoryDirect: true, ltbWarping: true,
    };
  }

  // canSolve is an optional secondary gate (e.g. a static one that inspects the model).
  canSolve(model, lcId, opts) { return { ok: true, reasons: [] }; }

  async solveStatic(model, lcId, opts) { /* … WASM … */ }
  async solveModal(model, nModes)      { /* … */ }
  async solveBuckling(o)               { /* … */ }
  // Does NOT implement spectrum/nonlinear/staged/… → the registry solves them with 'js'.
}

solverRegistry.register(new NodexBackend()).setActive('cpp');
// The registry uses Nodex for static/modal/buckling and falls back to 'js' for the rest;
// if Nodex throws at runtime, it also retries in 'js' (res._fellBack === true).
```

**`JsSolverBackend.capabilities()`** is the honest source of truth for what the JS implements (it
declares the 13 flags). `NodexBackend.capabilities()` declares its subset + what Nodex adds. There
is no need to implement stubs or return `false` in `canSolve` for uncovered methods: just **do not
declare** the flag.

---

## Seam 2 — UI and report (`js/ext/extensions.js`)

A single `extensions` singleton with four registration points.

### 2.1 Sections of the ⚙ Settings dialog
```js
import { extensions } from './js/ext/extensions.js?v=214';

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

### 2.2 Top-bar badges
```js
extensions.registerBadge({ id: 'pro', html: '<span class="badge-pro">PRO</span>' });
```
They are painted into `#ext-badges` at startup (`App._initExtensions`).

### 2.3 Capability flags
```js
extensions.setFlag('memoriaBranding', true);   // enables company logo/footer/limitations
```
core reads `memoriaBranding` (via `App._brandingPro`) in the report generator; in core it is
`false` → the **standard template** is used (default footer and limitations).

### 2.4 Additional analyses in the Hub (`registerAnalysis`)

Lets you add entries in the **analysis Hub** (Analysis Center) for capabilities that only the Pro
backend can run. core registers **zero** additional analyses; everything that arrives here comes
from an upper layer.

```js
import { extensions } from './js/ext/extensions.js?v=214';

extensions.registerAnalysis({
  id:    'nodex-nlth-direct',
  label: 'Direct nonlinear TH (Nodex)',
  menu:  'run-dynamic',       // Hub section where it appears
  group: 'Advanced (Pro)',    // visual group label (optional)
  handler: async (ctx) => {
    // ctx = { app, openModal, setStatus, refreshViewport, solverRegistry }
    const result = await ctx.solverRegistry.active.solveNlThDirect(ctx.app.model, opts);
    ctx.setStatus('Nonlinear TH OK');
    ctx.refreshViewport();
  },
});
```

**ctx** exposed to the handler:

| Property | Type | Description |
|---|---|---|
| `app` | `App` | central instance (access to `model`, `toast`, etc.) |
| `openModal(title, html)` | function | opens the standard modal with custom HTML |
| `setStatus(text)` | function | updates the status bar |
| `refreshViewport()` | function | redraws the 3D view |
| `solverRegistry` | `SolverRegistry` | active backend; the handler can call methods of the Pro backend |

### 2.5 White-label by configuration (`branding.default.json` + `js/branding.js`)

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

## Seam 3 — Post-processing reusable by backends (`js/solver/postprocess.js`)

The math of **N/V/M(x) diagrams and the deformed shape from end forces** lives in core ONCE, as
exported **pure functions**. This way a `solverRegistry` backend only needs to return end forces
(+ geometry and local loads) and obtains **diagrams identical** to the JS solver, without
reimplementing anything. The `Results` class (JS solver) delegates to these same functions.

```js
import { actualLoadsLocal, diagramFromForces, elemAtXiFromForces }
  from './js/solver/postprocess.js?v=214';
```

| Function | Signature | Returns |
|---|---|---|
| `actualLoadsLocal` | `(model, lcId, selfWeight, elem, ex, ey, ez)` | `{qy, qz, qy1, qy2, qz1, qz2}` — distributed-load intensities in the local frame (uniform + trapezoidal). Source of truth for `q(x)`; never infer it from the end forces. |
| `diagramFromForces` | `(f, n1, n2, type, nPts)` | `{pts, extremes, maxVal, minVal}` — diagram by equilibrium integration (exact for uniform/trapezoidal). `type ∈ 'N','Vy','Vz','T','My','Mz'`. |
| `elemAtXiFromForces` | `(f, xi)` | forces + interpolated displacement at `xi∈[0,1]` (equilibrium + Hermite with a load bubble). |

`f` is the RICH end-force object that `Results.getElemForces` produces (and that the backend must
replicate): `N, Vy1, Vz1, T, My1, Mz1, Vy2, Vz2, My2, Mz2, ex, ey, ez, L, qy, qz, qy1, qy2, qz1,
qz2, EIz, EIy, _ue, …`.

**Usage example from a backend** (e.g. Nodex's `WasmResults` in the Pro repo): it builds `f` with
the C++ end forces rotated to its local frame, completes it with `actualLoadsLocal(...)` (the same
loads as the JS solver) and draws with `diagramFromForces` / `elemAtXiFromForces`. Result: diagrams
and deformed shape identical to the JS solver's, validated to machine precision.

---

## What does NOT live in core

These pieces belong to the Pro layer and were removed from core in v0.1:

- **Professional token** validation (formerly `/api/assistant/pro` in the worker and the
  "Professional mode" UI). *AGPL note: a token over open-source code does not restrict use; the
  real protection is that the Pro code is not distributed.*
- Editable company report: **description, footer, limitations, logo, institution** → re-added via
  `registerConfigSection` + `setFlag('memoriaBranding')`.
- Alternative analysis engine and Nodex-exclusive analyses → via
  `solverRegistry.register(new NodexBackend())` + `registerAnalysis(…)`.
- Analyses that core's JS does NOT implement (7-DOF warping, direct nonlinear TH, fiber, LTB with
  warping, etc.) → **they do not appear in core's interface**. They are added exclusively from the
  Pro layer via `registerAnalysis`.
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
