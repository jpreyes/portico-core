# API pública de Portico

[English](api.md) · **Español**

`js/api/portico.js` expone una fachada estable para consumir Portico desde código:
**pre-proceso** (construir/importar el modelo), **solver** (estático, modal,
pandeo, etapas) y **post-proceso** (desplazamientos, reacciones, esfuerzos,
diagramas y **diseño multinorma**). Es **extensible** y funciona igual en Node y en
el navegador (las unidades son kN, m; las resistencias de diseño en MPa).

```js
import { Portico } from './js/api/portico.js';
```

## Construcción

| Método | Devuelve | Descripción |
|---|---|---|
| `new Portico(model?)` | `Portico` | envuelve un `Model` (o crea uno vacío) |
| `Portico.fromS3D(json)` | `Portico` | carga desde un `.s3d` (string u objeto) |
| `Portico.from(model)` | `Portico` | envuelve un `Model` existente |
| `p.toS3D()` | `string` | serializa a `.s3d` |
| `p.model` | `Model` | modelo crudo (acceso total) |

## Pre-proceso (construir el modelo)

```js
const ac = p.material({ name:'Acero', E:2e8, G:7.7e7, nu:0.3, design:{ family:'steel', Fy:355 } });
const sc = p.section({ name:'IPE300', A:5.38e-3, Iz:8.36e-5, Iy:6.04e-6, J:2e-7,
                       design:{ shape:'I', d:.3, bf:.15, tf:.0107, tw:.0071 } });
const a  = p.node(0,0,0, { ux:1,uy:1,uz:1,rx:1,ry:1,rz:1 });   // empotrado
const b  = p.node(5,0,0);
const e  = p.element(a, b, { mat: ac, sec: sc, design:{ Lb:5, Cb:1 } });
const lc = p.loadCase('Q');
p.nodalLoad(lc, b, { fz:-20 });          // o p.load(lc, {type:'nodal',nodeId:b,F:[...]})
p.distLoad(lc, e, { dir:'gravity', w:10 });
p.combo({ name:'1.2D+1.6L', factors:[...] });
p.link({ master:a, slave:b, rigid:true });
p.set2D(true);                           // modo 2D (restringe uy/rx/rz)
p.designSettings({ codeByFamily:{ steel:'EN1993-1-1' } });
```

Todos los `add*` devuelven el **id** (entero). `p.model` da acceso al `Model`
completo si se necesita algo no expuesto.

## Solver (async)

| Método | Devuelve | |
|---|---|---|
| `await p.solveStatic(lcId?, {selfWeight})` | `Results` | estático lineal |
| `await p.solveModal(nModes)` | `ModalResults` | modal |
| `await p.solveModalKg(refLcId, nModes)` | `ModalResults` | modal con rigidez geométrica |
| `await p.solveBuckling(refLcId?, nModes)` | `{factors, modes}` | pandeo lineal (K+λKg)φ=0 |
| `await p.solveStaged(stages)` | `Results` | etapas constructivas |

## Post-proceso

```js
p.displacement(nodeId)      // [ux,uy,uz,rx,ry,rz]
p.reaction(nodeId)          // [Fx,Fy,Fz,Mx,My,Mz]
p.elementForces(elemId)     // {N,Vy,Vz,My,Mz,T,L,...}
p.diagram(elemId,'Mz',12)   // {pts:[{x,val}], extremes:[...]}
p.maxDisplacement()         // |u| máximo nodal
p.period(mode) / p.frequency(mode) / p.modeShape(mode)
p.bucklingFactor(mode)
```

## Diseño multinorma

```js
await p.solveStatic(lc);
const rows = p.design({ codeId:'AISC360-16:LRFD' });
// → [{ elemId, material, sec, code, governs, ratioMax, state,
//      bending:{demand,capacity,ratio,...}, shear, axial, interaction }]

// con envolvente de varios estados:
p.design({ resultsSets:[{name:'C1', res:r1}, {name:'C2', res:r2}] });

// chequeo de UN elemento sin análisis (fuerzas dadas):
p.checkMember({ forces:{N:-300, Mz:50, L:4}, matId:ac, secId:sc, codeId:'EN1993-1-1' });

// inspección de propiedades resueltas:
p.resolvedMaterial(ac);   // {family, E, Fy, ...} en kN/m²
p.resolvedSection(sc);    // {A, Iz, Sz, Zz, rz, Cw, ...} en m

// catálogo de códigos:
Portico.listDesignCodes();          // todos
Portico.listDesignCodes('steel');   // por familia
```

Ver [docs/design.md](design.md) para los códigos y los datos `mat.design`/`sec.design`.

## Extensibilidad

```js
// análisis personalizado (recibe el Model y devuelve lo que quieras)
Portico.registerAnalysis('miAnalisis', async (model, opts, api) => { /* ... */ });
const r = await p.run('miAnalisis', { /* opts */ });

// código de diseño personalizado (ver docs/design.md)
Portico.registerDesignCode({ id:'MI-NORMA', family:'steel', label:'...', check(input){ /* ... */ } });
```

## Ejemplo completo (Node)

```js
import { Portico } from './js/api/portico.js';
const p = new Portico(); p.set2D(true);
const ac = p.material({ name:'Acero', E:2e8, G:7.7e7, nu:0.3, design:{ family:'steel', Fy:250 } });
const sc = p.section({ name:'IPE300', A:5.38e-3, Iz:8.356e-5, Iy:6.04e-6, J:2e-7,
                       design:{ shape:'I', d:.3, bf:.15, tf:.0107, tw:.0071 } });
const A = p.node(0,0,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1}), B = p.node(5,0,0);
p.element(A,B,{mat:ac,sec:sc});
const lc = p.loadCase('Q'); p.nodalLoad(lc,B,{fz:-10});
await p.solveStatic(lc);
console.log('flecha de punta', p.displacement(B)[2]);
console.log('diseño', p.design({codeId:'AISC360-16:LRFD'})[0]);
```

Pruebas de la API en `test_api.mjs` (raíz).
