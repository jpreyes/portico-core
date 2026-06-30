# Stability verdict contract (core JS ↔ pluggable backend)

PÓRTICO must show the **same stability verdict** whatever backend is active — the JS
solver in `portico-core` or a C++/WASM engine (Nodex) plugged in via the
[`SolverBackend`](js/solver/backend.js) seam. This file is the **shared vocabulary**;
both backends emit it and the UI renders it uniformly.

Single source of truth in code: [`js/solver/stability.js`](js/solver/stability.js)
(`STABILITY`, `STABILITY_LIMITS`, `assessStabilitySanity`).

## Categories

| Code (`STABILITY.*`) | Severity | Meaning | Who detects |
|---|---|---|---|
| `STABILITY_OK` | — | No stability issue. | — |
| `STABILITY_INERT_DOF` | `info` | Legitimate inert DOF (membrane drilling, 2D out-of-plane). **Not** instability. | regularized in assembly; reported as info only |
| `STABILITY_MECHANISM` | `error` | Singular matrix / rigid-body mechanism. Results are **not** valid. | solver (factorization fails / non-SPD / non-finite) |
| `STABILITY_ILL_CONDITIONED` | `warning` | Near-singular: relative pivot below `STABILITY_LIMITS.pivotRatio` (`1e-12`). Best-effort. | solver (pivot ratio of the reduced matrix) |
| `STABILITY_DRIFT` | `warning` | Inter-story drift Δ/h above `STABILITY_LIMITS.driftRatio` (`1/20`). | **post sanity** (from results) |
| `STABILITY_DISPLACEMENT` | `warning` | \|u\|max above `STABILITY_LIMITS.dispFrac` (`0.15`) of the model span. | **post sanity** (from results) |

## Warning object

Both `Results.warnings` (JS) and `WasmResults.warnings` (Nodex bridge) are arrays of:

```js
{ code, severity: 'info'|'warning'|'error', params: {…}, message /* Spanish fallback */ }
```

The UI localizes by `code` + `params` (see `app._stabilityMsg`); `message` is only a
fallback for non-i18n consumers.

## Where each check lives (and why)

- **Solver level (PART 1)** — `STABILITY_MECHANISM` and `STABILITY_ILL_CONDITIONED`:
  the backend that owns the factorization detects these. The JS `StaticSolver` reads
  the LU pivot ratio (`min|U_ii| / max|U_ii|`) and throws a structured
  `err.stability = { code: STABILITY_MECHANISM, … }` on a true mechanism. Nodex emits
  the equivalent in its `resultJson`.
  **Caveat:** a penalty rigid diaphragm inflates the largest pivot (~`1e5·kmax`), so a
  near-mechanism can be **masked** in the pivot ratio. The solver-level near-singular
  signal is therefore best-effort — the robust catch is PART 2.

- **Post sanity (PART 2, backend-agnostic)** — `STABILITY_DRIFT` / `STABILITY_DISPLACEMENT`:
  computed from the **results** (`assessStabilitySanity(model, res)`), so it is
  identical for JS and Nodex. PÓRTICO knows the domain (diaphragm floor levels,
  heights, geometry), which is why this lives in the post. This is what catches a
  near-mechanism that "solves" with garbage (e.g. 3 roller bases rescued by a rigid
  diaphragm → ~H/13 drift): the matrix solve alone never warns; the drift sanity does.

## Backend implementation checklist (Nodex side)

1. Expose `warnings: [{code, severity, params, message}]` on the results object.
2. Emit `STABILITY_MECHANISM` (error) when the system is singular; emit
   `STABILITY_ILL_CONDITIONED` (warning) for a near-singular factorization.
3. Do **not** flag inert DOFs (drilling / out-of-plane in 2D) as instability.
4. The `STABILITY_DRIFT` / `STABILITY_DISPLACEMENT` checks are NOT duplicated in the
   backend — PÓRTICO runs `assessStabilitySanity` on the returned results.
