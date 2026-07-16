# Changelog

**English** · [Español](CHANGELOG.es.md)

All notable changes to **portico-core** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project follows [Semantic Versioning](https://semver.org/).

> Change types: **Added** (new), **Changed** (in existing functionality),
> **Deprecated** (about to be removed), **Removed**, **Fixed**, **Security**.

---

## [Unreleased]

### Added

- **Unified stability verdict** (core JS ↔ pluggable backend, e.g. Nodex): a structured
  mechanism / near-singular verdict on `Results.warnings` and `err.stability`, plus a
  backend-agnostic drift / displacement sanity in the post that catches a near-mechanism
  which "solves" with garbage (e.g. roller bases rescued by a rigid diaphragm). Surfaced
  as one prominent banner, identical whatever the active backend. Shared vocabulary in
  [`NODEX-CONTRACT.md`](NODEX-CONTRACT.md) and `js/solver/stability.js`.
- **`.ndx` exporter** (`js/io/formats/ndx.js`): serializes the model to the NODEX text
  DSL consumed by the (private) nodex-compiler layer for complex analysis — same
  downstream-adapter pattern as OpenSees/Abaqus/SAP2000. Covers the L1/L2 subset (nodes,
  supports, materials, sections, bars with releases, nodal masses, nodal / distributed
  loads, and `solve` intent), with a raw escape hatch for advanced `analysis.kind`s. The
  grammar is provisional pending nodex-compiler. Round-trip test: `test_ndx.mjs`.
- **Iterative solver (PCG) for large meshes** (`js/solver/pcg.js`): a matrix-free
  Preconditioned Conjugate Gradient (Jacobi / IC0 incomplete-Cholesky) for `K·u = F` in
  CSR, an alternative to the banded Cholesky when the band factor hits the memory/time
  wall. The static sparse worker auto-selects it for **large meshes without penalty
  constraints** (no rigid diaphragms/links, whose penalty inflates the condition number
  and cripples CG); everything else keeps the direct factor, and the worker falls back to
  it if PCG ever stalls. Verified against the direct solver on a real frame+shell+diaphragm
  stiffness matrix (`test_pcg.mjs`).
- **IFC import: B-rep (mesh) geometry fallback** (`js/io/ifc/ifcGeometrySimplifier.js`):
  elements exported as faceted meshes (`IfcFacetedBrep`/`SurfaceModel`, e.g. Archicad's
  "SurfaceGeometryAddOnView") — with no `IfcExtrudedAreaSolid` and no 3D `Axis` — are now
  imported by approximating each element from its mesh bounding box: one dominant axis →
  **bar** (axis + rectangular, or circular-by-name, section); one thin axis → **panel**
  (mid-surface + thickness; `IfcWall` → membrane, slab/plate/other → shell); all-comparable
  → **3D block**, skipped with a warning. Previously these files imported nothing. Verified
  with `test_ifc_brep.mjs`.

### Removed

- **`extensions.registerAnalysis`** (`js/ext/extensions.js`): the hook accepted specs and
  stored them, but nothing ever read the collection — a registered analysis could never
  reach the Hub and its handler was never invoked. It was a seam for analyses core's JS
  cannot run, which `CONTRIBUTING`'s open-source-honesty rule already forbids, plus half a
  page in `EXTENDING` §2.4 documenting a `ctx` that was never built. Its sibling seams
  (`registerConfigSection`, `registerBadge`, `setFlag`) are consumed and unaffected.
  Unrelated to `Portico.registerAnalysis` / `Portico.run()` in `js/api/portico.js`, which
  works and stays.

### Fixed

- **Section shear areas scale with A**: `Model.addSection` used to apply a fixed default
  `Avy = Avz = 0.075` (the base section's value) whenever a section was created from `A`
  alone, so a custom section's Timoshenko shear stiffness was wrong (e.g. `A = 0.16` kept
  `0.075` instead of `≈ 0.133`). Shear areas are now derived as `A·κ` when not given
  explicitly (values passed in — e.g. from the profile catalog — are respected). Verified
  by `test_shear_area.mjs`.
- **Import robustness**: a corrupt / hand-edited `.s3d` (a top-level non-object, or a
  collection like `nodes`/`elements`/`materials`/`areas` that is not a list) now fails with
  a clear *"Archivo .s3d inválido"* message instead of a cryptic `TypeError`.
- **Material / section validation**: invalid properties (E ≤ 0, G ≤ 0, A ≤ 0, Iy/Iz ≤ 0,
  Poisson ν outside [0, 0.5], ν = 0.5 with plane-strain areas) are reported as a clear
  blocking error before the analysis, instead of surfacing as a misleading "mechanism".
- **Degenerate area elements**: a collinear / zero-area (coincident-node) plate/shell is now
  detected and skipped in the assembly and stress recovery (no NaN), and flagged with a
  warning, instead of silently poisoning K/M with NaN.
- **Example `examples/portico_simple.s3d`**: the base supports were inconsistent (three
  vertical rollers + one fixed + one pinned) and formed a lateral near-mechanism that the
  rigid diaphragm masked (~426 mm seismic drift). All four bases are now fixed — a stable
  two-story frame.

---

## [0.1.0] — 2026-06-30

First open source cut of PORTICO: a clean, professional and reusable base of the
pre/post-processor + 3D viewer + JS solver.

### Added

- **Complete, self-contained 3D structural analysis (FEM) application** in the browser:
  member modeling (Timoshenko, 12 DOF) and area elements (membrane/plate/shell), free
  and mapped meshing.
- **Analyses:** static, modal (inverse Stodola), response spectrum (CQC/SRSS), P-Δ,
  linear buckling, geometric nonlinear (cables, large-rotation corotational), pushover,
  modal time-history, construction stages, moving loads / influence lines, tendon
  prestress and force-density form-finding.
- **Multi-code design:** steel (AISC/EC3/NCh), concrete (ACI/EC2), timber and aluminum
  (EC9), with auto-design, reporting and drift checks.
- **`SolverBackend` interface** (`js/solver/backend.js`): a seam for pluggable engines,
  with one async method per analysis that core's JS implements and transparent
  *fallback* to the JS engine. The registry dispatches the analysis to the active
  backend. (The open edition ships only the JS engine.)
- **Extension hooks** (`js/ext/extensions.js`): `registerConfigSection`,
  `registerBadge`, `setFlag`/`flag` and `registerAnalysis`, so upper layers can
  contribute UI, reports and analyses without forking `app.js`. Core registers zero
  extra analyses.
- **Reusable post-processing** (`js/solver/postprocess.js`): the math for N/V/M(x)
  diagrams and deflected shape lives once as pure functions; any backend gets identical
  diagrams by returning only end forces.
- **Public API** (`js/api/portico.js`): a stable façade to consume pre/solver/post from
  code, identical in Node and in the browser.
- **Internationalization (ES/EN):** source-string i18n engine (`js/i18n/`) with
  fallback to Spanish; English dictionary (`dict.en.js`) covering menus, splash,
  modals, toasts, the properties panel, toolbar tooltips and dialogs. The engine also
  translates text attributes (`title`/`aria-label`/`placeholder`) and auto-translates
  dynamically re-rendered panels.
- **Responsive design:** the UI is usable on mobile/tablet (right panel as a *drawer*
  with a floating button and *scrim*) and the right panel no longer clips its content
  on desktop screens.
- **White-label by configuration** (`branding.default.json` + `js/branding.js`): a loader
  reads the JSON at startup (before the App) and fills the UI's name, tagline, description,
  logo and links via `data-brand` attributes. White-label without touching code or forking.
- **Interoperability:** `.s3d` (JSON) format with round-trip, CSV import, IFC/BIM and a
  text-to-model assistant.
- **Verification suite** (`test_*.mjs`): 40+ standalone Node scripts validating against
  an analytical solution or global equilibrium.
- **Documentation:** `README.md`, `docs/EXTENDING.md` (extension seams), `docs/api.md`,
  `docs/ROADMAP.md`, `CONTRIBUTING.md` and `SECURITY.md`.

### Changed

- **Full de-branding:** all institutional branding was removed (logos, "teaching
  material", academic references). Branding became configuration.
- **Concrete grade nomenclature** moved to **grade G** (NCh170:2016), with backward
  compatibility for the legacy "H".
- **AI assistant is now bring-your-own-endpoint (BYO):** the LLM endpoint default
  (`/api/asistente`) was removed; the endpoint field starts empty. Without an endpoint,
  the deterministic generator (paste/edit a JSON spec) remains fully usable.
- **Agnostic code data + per-jurisdiction presets:** `assistant/rules.json`,
  `design_params.json` and `live_loads.csv` now ship generic **example** tables;
  each country's real code lives as an **opt-in preset** under `presets/` (includes
  `presets/chile/` with NCh431/432/433/1537). `assistant/loads.js` **degrades gracefully**
  if a table is missing. See [`presets/README.md`](presets/README.md).

- **International names (English):** everything renamed to English without breaking the
  app — folders (`asistente/`→`assistant/`, `docs/ejemplos/`→`docs/examples/`), files
  (`reglas.json`→`rules.json`, `cargas.js`→`loads.js`, `generador.js`→`generator.js`,
  `diseno.js`→`design.js`, …), functions (`generarModelo`→`generateModel`,
  `cargaNieveNCh431`→`snowLoad`, …), spec/rules/design data keys (`geometria`→`geometry`,
  `vigas`→`beams`, `acero`→`steel`, …), DOM IDs (`data-vtab`, `vpanel-*`) and enum values
  (`empotrado`→`fixed`, `marco`→`frame`, …). The `.s3d` format was already in English (no
  change). The generator accepts input in any language (the LLM maps intent→spec).

### Removed

- **Professional mode / token validation:** now lives in the Pro layer; core is fully
  functional without a token.
- **Editable company report content** (description, footer, limitations, logo,
  institution): reintroduced from an upper layer via `registerConfigSection` +
  `setFlag('memoriaBranding')`.
- **AI assistant private backend:** the Cloudflare Worker (SYSTEM prompt, model
  cascade, API key), the curated RAG corpus and the n8n flow live outside the public
  repo. Core keeps only the deterministic generator, the schema, the profile/material
  libraries and generic English examples.

[Unreleased]: https://github.com/jpreyes/portico-core/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jpreyes/portico-core/releases/tag/v0.1.0
