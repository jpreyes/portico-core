# PORTICO public API

**English** · [Español](api.es.md)

`js/api/portico.js` exposes a stable facade to consume PORTICO from code: **pre-processing**
(build/import the model), **solver** (static, modal, buckling, stages) and **post-processing**
(displacements, reactions, forces, diagrams and **multi-code design**). It is **extensible** and
works the same in Node and in the browser (units are kN, m; design strengths in MPa).

```js
import { Portico } from './js/api/portico.js';
```

## Construction

| Method | Returns | Description |
|---|---|---|
| `new Portico(model?)` | `Portico` | wraps a `Model` (or creates an empty one) |
| `Portico.fromS3D(json)` | `Portico` | loads from a `.s3d` (string or object) |
| `Portico.from(model)` | `Portico` | wraps an existing `Model` |
| `p.toS3D()` | `string` | serializes to `.s3d` |
| `p.model` | `Model` | raw model (full access) |

## Pre-processing (build the model)

```js
const ac = p.material({ name:'Steel', E:2e8, G:7.7e7, nu:0.3, design:{ family:'steel', Fy:355 } });
const sc = p.section({ name:'IPE300', A:5.38e-3, Iz:8.36e-5, Iy:6.04e-6, J:2e-7,
                       design:{ shape:'I', d:.3, bf:.15, tf:.0107, tw:.0071 } });
const a  = p.node(0,0,0, { ux:1,uy:1,uz:1,rx:1,ry:1,rz:1 });   // fixed
const b  = p.node(5,0,0);
const e  = p.element(a, b, { mat: ac, sec: sc, design:{ Lb:5, Cb:1 } });
const lc = p.loadCase('Q');
p.nodalLoad(lc, b, { fz:-20 });          // or p.load(lc, {type:'nodal',nodeId:b,F:[...]})
p.distLoad(lc, e, { dir:'gravity', w:10 });
p.combo({ name:'1.2D+1.6L', factors:[...] });
p.link({ master:a, slave:b, rigid:true });
p.set2D(true);                           // 2D mode (restrains uy/rx/rz)
p.designSettings({ codeByFamily:{ steel:'EN1993-1-1' } });
```

All `add*` methods return the **id** (integer). `p.model` gives access to the full `Model` if
something not exposed is needed.

## Solver (async)

| Method | Returns | |
|---|---|---|
| `await p.solveStatic(lcId?, {selfWeight})` | `Results` | linear static |
| `await p.solveModal(nModes)` | `ModalResults` | modal |
| `await p.solveModalKg(refLcId, nModes)` | `ModalResults` | modal with geometric stiffness |
| `await p.solveBuckling(refLcId?, nModes)` | `{factors, modes}` | linear buckling (K+λKg)φ=0 |
| `await p.solveStaged(stages)` | `Results` | construction stages |

## Post-processing

```js
p.displacement(nodeId)      // [ux,uy,uz,rx,ry,rz]
p.reaction(nodeId)          // [Fx,Fy,Fz,Mx,My,Mz]
p.elementForces(elemId)     // {N,Vy,Vz,My,Mz,T,L,...}
p.diagram(elemId,'Mz',12)   // {pts:[{x,val}], extremes:[...]}
p.maxDisplacement()         // max nodal |u|
p.period(mode) / p.frequency(mode) / p.modeShape(mode)
p.bucklingFactor(mode)
```

## Multi-code design

```js
await p.solveStatic(lc);
const rows = p.design({ codeId:'AISC360-16:LRFD' });
// → [{ elemId, material, sec, code, governs, ratioMax, state,
//      bending:{demand,capacity,ratio,...}, shear, axial, interaction }]

// with an envelope of several states:
p.design({ resultsSets:[{name:'C1', res:r1}, {name:'C2', res:r2}] });

// check ONE element without analysis (given forces):
p.checkMember({ forces:{N:-300, Mz:50, L:4}, matId:ac, secId:sc, codeId:'EN1993-1-1' });

// inspection of resolved properties:
p.resolvedMaterial(ac);   // {family, E, Fy, ...} in kN/m²
p.resolvedSection(sc);    // {A, Iz, Sz, Zz, rz, Cw, ...} in m

// code catalog:
Portico.listDesignCodes();          // all
Portico.listDesignCodes('steel');   // by family
```

> See [docs/design.md](design.md) for the codes and the `mat.design`/`sec.design` data.

## Extensibility

```js
// custom analysis (receives the Model and returns whatever you want)
Portico.registerAnalysis('myAnalysis', async (model, opts, api) => { /* ... */ });
const r = await p.run('myAnalysis', { /* opts */ });

// custom design code (see docs/design.md)
Portico.registerDesignCode({ id:'MY-CODE', family:'steel', label:'...', check(input){ /* ... */ } });
```

## Complete example (Node)

```js
import { Portico } from './js/api/portico.js';
const p = new Portico(); p.set2D(true);
const ac = p.material({ name:'Steel', E:2e8, G:7.7e7, nu:0.3, design:{ family:'steel', Fy:250 } });
const sc = p.section({ name:'IPE300', A:5.38e-3, Iz:8.356e-5, Iy:6.04e-6, J:2e-7,
                       design:{ shape:'I', d:.3, bf:.15, tf:.0107, tw:.0071 } });
const A = p.node(0,0,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1}), B = p.node(5,0,0);
p.element(A,B,{mat:ac,sec:sc});
const lc = p.loadCase('Q'); p.nodalLoad(lc,B,{fz:-10});
await p.solveStatic(lc);
console.log('tip deflection', p.displacement(B)[2]);
console.log('design', p.design({codeId:'AISC360-16:LRFD'})[0]);
```

API tests in `test_api.mjs` (root).
