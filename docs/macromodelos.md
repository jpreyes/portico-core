# Macro-models — integration guide and roadmap (`#86`)

**English** · [Español](macromodelos.es.md)

A **macro-model** resolves a complex structural subsystem with **a few calibrated elements**
(bars / cables / springs / nonlinear links) instead of a fine mesh. The user selects a few nodes
(e.g., the 4 corners of a panel) and the engine **expands** it into its already-calibrated
internal network.

> **Division of labor (agreed).** The **theoretical development** of each macro-model (equivalent
> geometry, stiffnesses, constitutive / hysteresis laws, calibration) is done **separately**.
> Here the **integration is already solved**: register the macro-model and write its `expand(...)`
> that builds the calibrated elements in the model. This guide is the contract that makes
> plugging in a new macro-model a small, mechanical task.

---

## Architecture

```
UI (node selection + auto-generated dialog)
        │  app.insertMacroFromSelection(id)
        ▼
macro_registry.js   registerMacro({id,name,nodes,params,expand}) · insertMacro(model,id,nodeIds,props)
        │  expand(model, nodeIds, props)
        ▼
Model               creates calibrated materials/sections + elements (bars/cables/links)
        │           marks each: el.macro=<no.>, el.macroType=<id>; registers in model.macros
        ▼
Solver              solves them as normal elements (incl. compressionOnly, releases,
                    cable, links, P-Δ, nonlinear…) — the macro-model needs NO solver of its own
```

- **`js/model/macro_registry.js`** — the pluggable registry: `registerMacro`, `getMacro`,
  `listMacros`, `insertMacro`. Same pattern as the **design-code** registry
  (`js/design/registry.js`) and the **interchange-format** one (`js/io/registry.js`).
- **`js/model/macromodel.js`** — the concrete macro-models (today: `infill`), each self-registers
  at the end of the file.
- **`app.insertMacroFromSelection(id)`** — **generic** UI: validates nodes/mode, builds the
  parameter dialog from `def.params` and runs the `expand`. **A new macro-model needs no dialog
  of its own.**

---

## Contract of a new macro-model

```js
import { registerMacro } from './macro_registry.js?v=NNN';

registerMacro({
  id:        'shearwall',                       // unique
  name:      'Shear wall — wide column',        // menu/dialog
  desc:      'RC wall → wide column + shear springs (theoretical reference).',
  nodes:     2,                                 // no. of nodes to select
  nodesHint: 'the 2 end nodes of the wall (base and top)',
  dims:      '2D',                              // '2D' | '3D' | null (both)
  params: [                                     // → auto-generated dialog
    { key: 'fc',  label: "f'c (kN/m²)",      default: 25000, step: 1000, min: 1 },
    { key: 't',   label: 'Thickness (m)',    default: 0.20,  step: 0.05, min: 0.01 },
    { key: 'lw',  label: 'Wall length (m)',  default: 3.0,   step: 0.1,  min: 0.1 },
  ],

  // THEORY ALREADY SOLVED by the author → here it is only BUILT in the model.
  expand(model, nodeIds, props) {
    // 1) validate geometry; return { error } if something is missing
    // 2) create calibrated material(s) and section(s) (model.addMaterial / addSection)
    // 3) create the elements (model.addElement / addLink …) with their NL properties
    //    (el.compressionOnly, el.cable, el.releases, links, node springs…)
    // 4) MARK each created element:  el.macro = macroId;  el.macroType = 'shearwall';
    // 5) register the macro in model.macros (to identify/delete it as a block)
    // 6) return { macroId, elemIds:[…], … }   (or { error })
  },
});
```

**Responsibilities of `expand` (the only case-by-case part):**

1. **Validate** the input (the node count is already checked by `insertMacro`; validate the
   geometry).
2. **Create** calibrated materials/sections and the **elements** of the equivalent network.
   Reuse everything the solver already understands: `el.compressionOnly` (#56), `el.cable`,
   `el.releases` (hinges), `el.rigidEnd` (rigid end zone), `model.addLink` (coupling/rigid),
   node springs (`node.springs`), prestress via `L0factor`, etc.
3. **Mark** each element: `el.macro = <numeric id>`, `el.macroType = '<def id>'`.
4. **Register** in `model.macros` (Map) `{ id, type, corners/nodes, elemIds, props, … }`.
5. **Return** `{ macroId, … }` or `{ error: '…' }`.

The macro-model **needs no solver of its own**: once expanded, they are normal elements that the
static / modal / nonlinear / P-Δ solvers handle. If the theory requires a new constitutive law
(e.g., pinched hysteresis), that is added to the NL solver as a reusable capability and the
`expand` only **references** it by flag.

**Reference example:** `insertInfill` in `js/model/macromodel.js` (infill wall → 2 compression-
only diagonal struts of Mainstone/FEMA 356) — follow that pattern.

---

## How to plug in a new one (checklist)

1. Write `expand(...)` in `js/model/macromodel.js` (or a new file `macros/<id>.js`).
2. `registerMacro({ … })` at the end of the file.
3. Make sure the file is imported (`macromodel.js` is already imported; if it is new, add the
   import).
4. Add a menu entry **Edit → Macro-models → "…"** that calls
   `app.insertMacroFromSelection('<id>')`. *(The dialog UI is automatic.)*
5. (Optional) Verification `test_macromodel.mjs`: check the equivalent geometry/areas against the
   hand calculation and the **stability** (the static analysis gives no mechanism).
6. Version bump + document the theory/calibration in this file.

---

## Roadmap of macro-models to integrate

> The author delivers the **theory/calibration**; the integration follows the contract above.
> Suggested priority (from most used / simplest to most complex):

| Status | Macro-model | Nodes | Equivalent / theory | Integration notes |
|---|---|---|---|---|
| ✅ | **Infill wall** | 4 corners | Mainstone diagonal strut / FEMA 356 §7.5.2 | Done (`infill`). Theory pending: cyclic degradation + tension. |
| ⬜ | **Shear wall** | 2–4 | Wide column + rigid arms + shear springs | Reuses `rigidEnd` + springs; key for RC buildings. |
| ⬜ | **Concentric brace** | 2 | Bar with buckling/post-buckling (fiber or phenomenological) | Reuses `compressionOnly` or NL; buckling hysteresis = new NL capability. |
| ⬜ | **Semi-rigid connection (panel zone / joint)** | 1 joint | Rotational M–θ spring (Richard-Abbott / bilinear) | Rotational link between beam and column; M–θ law. |
| ⬜ | **Seismic isolator / elastomeric bearing** | 1–2 | Horizontal bilinear spring (Bouc-Wen) + vertical | NL link/spring at the base interface; hysteresis. |
| ⬜ | **Damper (dissipator) viscous/hysteretic** | 2 | Force-velocity (viscous) or force-displacement (metallic) element | Only in nonlinear dynamics; per-element damping capability. |
| ⬜ | **Soil / soil-structure interaction** | n base | Calibrated Winkler springs (p–y, t–z) | Reuses `node.springs`; nonlinear curves as an NL capability. |
| ⬜ | **Partition / non-structural infill** | 4 | Reduced equivalent strut (partial stiffness) | Calibrated variant of `infill`. |

*(When the author delivers the theory of one, it moves to ✅ following the checklist.)*

## Cross-cutting NL capabilities that may be needed

Some theories require a reusable **constitutive law**; it is best to add it to the NL solver
once and have several macro-models reference it by flag:

- **Bouc-Wen** hysteresis (isolators, metallic dampers).
- **Pinched** hysteresis (RC walls/connections).
- Bar **buckling/post-buckling** (braces).
- Velocity-dependent **viscous** springs (dampers) — only in nonlinear time-history.

These integrate into the existing NL engine (`nl_lite.js` / nonlinear time-history) as reusable
element/material types; the macro-model's `expand` only **activates** them.
