# Adding a feature to portico-core

**English** · [Español](adding-a-feature.es.md)

Where new code goes, and in what order to write it. For extending core from an **upper
layer** without touching it, see [`EXTENDING.md`](EXTENDING.md) instead. For conventions,
the PR process and the CLA, see [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Which kind of feature is it?

| Feature | Touches core? | Where |
|---|---|---|
| A **design code** (AISC, EC, NCh…) | No | `js/design/codes/` + one line in a registry |
| An **I/O format** (an engine, a text format) | No | `js/io/formats/` + one import line |
| An **analysis** (a new solver) | Yes | `js/solver/` + a test + wiring |
| **UI / report** from an overlay | No | [`EXTENDING.md`](EXTENDING.md) |

The first two are registries: you declare an object and register it. Core never learns
your name. If your feature fits one of them, stop reading after that section.

---

## 1. A design code

A code is a plain object with a `check` function. Create `js/design/codes/<code>.js`:

```js
export const nch427 = {
  id: 'NCh427', family: 'steel', label: 'NCh427 (steel)',
  check: ({ demands, mem, P, M, options }) => ({
    checks:   { axial: {...}, shear: {...}, flexion: {...}, interaccion: {...} },
    ratioMax: 0.87,
    gobierna: 'interaccion',
    estado:   'OK',
    metodo:   'LRFD',
  }),
};
```

`family` is one of `steel | concrete | timber | aluminum`; it decides which material
resolves to your code. Then add it to the array in `registerBuiltinCodes()`
([`js/design/design.js`](../js/design/design.js)), and — if it should be the default for
its family — `setDefaultCode('steel', 'NCh427')`.

Strengths come from the **material** (`mat.design`, resolved by `material_props.js`) and
the design geometry from the **section shape** (`section_props.js`), so a code never
hardcodes either. Copy [`aisc360.js`](../js/design/codes/aisc360.js) — it is the most
complete reference.

Third parties can also register a code at runtime through the public API
(`Portico.registerDesignCode`), with no fork.

## 2. An I/O format

Create `js/io/formats/<format>.js` with `write(neutral)` and `read(text)`, speaking only
the **neutral model** ([`neutral.js`](../js/io/neutral.js)) — never `Model` directly. Register it at the bottom
of the file:

```js
registerFormat({ id: 'myformat', name: 'MyEngine (.ext)', ext: 'ext', write, read });
```

Then add one import line to [`js/io/index.js`](../js/io/index.js) so the module registers by side effect. It
now appears in the import/export menus automatically.

**Never drop data in silence.** If your format cannot represent something, push a warning:
`neutral.meta.exportWarnings.push('…')`. A silently emptied model is worse than a refused
one — an exporter that skips loads without a word is a bug that looks like a solver bug.

Copy [`sap2000.js`](../js/io/formats/sap2000.js) or [`etabs.js`](../js/io/formats/etabs.js); both handle their warnings correctly.

---

## 3. An analysis

This one touches core. Write it in this order — the first two steps give you a verified,
isolated feature, and everything after is wiring.

### Step 1 — the pure module

`js/solver/<my_analysis>.js`: one exported function, an object in, an object out.

**It must import nothing outside `js/solver/`.** That rule is why the folder is healthy:
35 files, none over 650 lines, no cycles. Do not reach for `Model`, the DOM, or the app.

Open with a header comment stating the method and its source —
[`formfind.js`](../js/solver/formfind.js) cites Schek 1974, [`corotbeam.js`](../js/solver/corotbeam.js) cites Crisfield. This is the
house style and it is what makes the solver readable by a student.

### Step 2 — the test

`test_<my_analysis>.mjs` **in the repo root**, a standalone entry point:

```js
// test_my_analysis.mjs — <what it validates, against which closed-form solution>
//   delta = P·L³/(3·E·I)   [Timoshenko & Gere, Ex. 5-2]
import { myAnalysis } from './js/solver/my_analysis.js';

globalThis.window = globalThis;          // solvers that read window.numeric
await import('./lib/numeric.js');        // must be loaded BEFORE importing them

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// … build, solve, check …

process.exit(failures ? 1 : 0);
```

State the analytical anchor in the header, with its reference. **Validate against a
closed-form solution or against global equilibrium (ΣReactions = ΣLoads)** — not against
"what the code printed yesterday". Modules that read `window.numeric` must be imported
*dynamically*, after `lib/numeric.js` has defined the global.

There is no runner and no framework: every file is its own entry point and runs with
`node test_my_analysis.mjs`. That is deliberate — a student can read one file and see
what it proves. CI runs them all.

> Tests import **without** `?v=`. The cache-busting query is for the browser, and the
> bump procedure does not touch the root tests — which is why the 13 that still carry one
> have drifted to `?v=88`…`?v=207`. Do not copy them.

### Step 3 — the wiring

Six touch points. Trace `form-finding` through the tree; it is the cleanest example.

| File | What |
|---|---|
| `js/app.js` (imports) | `import { myAnalysis } from './solver/my_analysis.js?v=2';` |
| `js/app.js` | the `runMyAnalysis()` driver + its dialog |
| `js/app.js` (Analysis Hub) | the checkbox state, the Hub row, and the batch dispatch entry |
| `js/ui/menu.js` | `case 'run-myanalysis': a.runMyAnalysis(); break;` |
| `index.html` | `<li data-action="run-myanalysis">▶ …</li>` |
| `js/i18n/dict.en.js` | the English for every Spanish string you added |

Heavy solves belong in a Web Worker (`js/solver/*_worker.js`) so the UI does not freeze.

> Five of those six are in `app.js`. That is not your fault, and it is worth knowing
> before you start: the maths is the small part, the wiring is the large one. Splitting
> the domain out of `app.js` is tracked work.

---

## Conventions that will bite you

- **`?v=` on every internal import under `js/`.** Miss it and the service worker serves you
  the old module while you debug the new one. Bump it repo-wide, all files at once — see
  [`CONTRIBUTING.md`](../CONTRIBUTING.md#3-import-versioning-cache-busting).
- **Syntax check:** `node --input-type=module --check < js/solver/my_analysis.js`.
  `node --check file.js` is wrong: it parses `.js` as CommonJS and will report false errors.
- **Comments in English. UI strings in Spanish**, wrapped in `i18n.t('…')`, translated in
  `dict.en.js`. File, folder, function and enum names in English.
- **Coordinates are Z-up** (as in SAP2000/ETABS). Three.js mapping: `model(x,y,z) → three(x, z, y)`.
- **Element DOF order (12):** `[ux1,uy1,uz1,rx1,ry1,rz1, ux2,…]`.
- Run the app with `python serve.py 8765` — a no-cache static server with correct UTF-8 MIME types.

## Before the PR

```bash
node --input-type=module --check < js/solver/my_analysis.js
node test_my_analysis.mjs
for t in test_*.mjs; do node "$t" || echo "FAIL $t"; done
```

If you touched the solver, also run the verification suite — it compares against
closed-form solutions, against SAP2000's published values and, in five cases, against
OpenSees:

```bash
node tools/run_verifs.mjs
```
