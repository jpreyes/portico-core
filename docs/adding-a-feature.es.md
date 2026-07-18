# Agregar un feature a portico-core

[English](adding-a-feature.md) · **Español**

Dónde va el código nuevo, y en qué orden escribirlo. Para extender el core desde una
**capa superior** sin tocarlo, ver [`EXTENDING.md`](EXTENDING.es.md). Para convenciones,
proceso de PR y CLA, ver [`CONTRIBUTING.md`](../CONTRIBUTING.es.md).

## ¿Qué tipo de feature es?

| Feature | ¿Toca el core? | Dónde |
|---|---|---|
| Un **código de diseño** (AISC, EC, NCh…) | No | `js/design/codes/` + una línea en un registry |
| Un **formato de IO** (un motor, un formato de texto) | No | `js/io/formats/` + una línea de import |
| Un **análisis** (un solver nuevo) | Sí | `js/solver/` + un test + cableado |
| **UI / memoria** desde una capa superior | No | [`EXTENDING.md`](EXTENDING.es.md) |

Los dos primeros son registries: declaras un objeto y lo registras. El core nunca se
entera de tu nombre. Si tu feature entra en uno de ellos, deja de leer después de esa
sección.

---

## 1. Un código de diseño

Un código es un objeto plano con una función `check`. Crea `js/design/codes/<codigo>.js`:

```js
export const nch427 = {
  id: 'NCh427', family: 'steel', label: 'NCh427 (acero)',
  check: ({ demands, mem, P, M, options }) => ({
    checks:   { axial: {...}, shear: {...}, flexion: {...}, interaccion: {...} },
    ratioMax: 0.87,
    gobierna: 'interaccion',
    estado:   'OK',
    metodo:   'LRFD',
  }),
};
```

`family` es uno de `steel | concrete | timber | aluminum`; decide qué material resuelve a
tu código. Después agrégalo al array de `registerBuiltinCodes()`
([`js/design/design.js`](../js/design/design.js)) y —si debe ser el default de su familia—
`setDefaultCode('steel', 'NCh427')`.

Las resistencias vienen del **material** (`mat.design`, resuelto por `material_props.js`) y
la geometría de diseño de la **forma de la sección** (`section_props.js`), así que un
código nunca hardcodea ninguna de las dos. Copia [`aisc360.js`](../js/design/codes/aisc360.js) — es la referencia más
completa.

Un tercero también puede registrar un código en runtime por la API pública
(`Portico.registerDesignCode`), sin forkear.

## 2. Un formato de IO

Crea `js/io/formats/<formato>.js` con `write(neutral)` y `read(text)`, hablando solo el
**modelo neutral** ([`neutral.js`](../js/io/neutral.js)) — nunca `Model` directo. Regístralo al final del archivo:

```js
registerFormat({ id: 'miformato', name: 'MiMotor (.ext)', ext: 'ext', write, read });
```

Después agrega una línea de import en [`js/io/index.js`](../js/io/index.js) para que el módulo se registre por
efecto colateral. Ya aparece solo en los menús de importar/exportar.

**Nunca descartes datos en silencio.** Si tu formato no puede representar algo, empuja un
aviso: `neutral.meta.exportWarnings.push('…')`. Un modelo vaciado calladamente es peor que
uno rechazado — un exportador que se salta las cargas sin decir nada es un bug que parece
un bug del solver.

Copia [`sap2000.js`](../js/io/formats/sap2000.js) o [`etabs.js`](../js/io/formats/etabs.js); ambos manejan bien sus avisos.

---

## 3. Un análisis

Este sí toca el core. Escríbelo en este orden — los dos primeros pasos te dejan el feature
verificado y aislado, y todo lo demás es cableado.

### Paso 1 — el módulo puro

`js/solver/<mi_analisis>.js`: una función exportada, entra un objeto, sale un objeto.

**No debe importar nada fuera de `js/solver/`.** Esa regla es la razón de que la carpeta
esté sana: 35 archivos, ninguno sobre 650 líneas, sin ciclos. No busques `Model`, ni el
DOM, ni la app.

Abre con un comentario de cabecera que declare el método y su fuente —
[`formfind.js`](../js/solver/formfind.js) cita a Schek 1974, [`corotbeam.js`](../js/solver/corotbeam.js) cita a Crisfield. Ese es el estilo
de la casa y es lo que hace que un estudiante pueda leer el solver.

### Paso 2 — el test

`test_<mi_analisis>.mjs` **en la raíz del repo**, entry point autónomo:

```js
// test_mi_analisis.mjs — <qué valida, contra qué solución cerrada>
//   delta = P·L³/(3·E·I)   [Timoshenko & Gere, Ej. 5-2]
import { miAnalisis } from './js/solver/mi_analisis.js';

globalThis.window = globalThis;          // solvers que leen window.numeric
await import('./lib/numeric.js');        // hay que cargarlo ANTES de importarlos

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// … construir, resolver, check …

process.exit(failures ? 1 : 0);
```

Declara el ancla analítica en la cabecera, con su referencia. **Valida contra una solución
cerrada o contra equilibrio global (ΣReacciones = ΣCargas)** — no contra "lo que el código
imprimió ayer". Los módulos que leen `window.numeric` se importan *dinámicamente*, después
de que `lib/numeric.js` haya definido el global.

No hay runner ni framework: cada archivo es su propio entry point y corre con
`node tests/test_mi_analisis.mjs`. Es deliberado — un estudiante puede leer un archivo y ver qué
demuestra. CI los corre todos.

> Los tests importan **sin** `?v=`. El query de cache-busting es para el navegador, y el
> procedimiento de bump no toca los tests de la raíz — por eso los 13 que todavía lo
> llevan derivaron a `?v=88`…`?v=207`. No los copies.

### Paso 3 — el cableado

Seis puntos de contacto. Rastrea `form-finding` por el árbol; es el ejemplo más limpio.

| Archivo | Qué |
|---|---|
| `js/app.js` (imports) | `import { miAnalisis } from './solver/mi_analisis.js?v=2';` |
| `js/app.js` | el driver `runMiAnalisis()` + su diálogo |
| `js/app.js` (Hub de análisis) | el estado del checkbox, la fila del Hub y la entrada del despacho batch |
| `js/ui/menu.js` | `case 'run-mianalisis': a.runMiAnalisis(); break;` |
| `index.html` | `<li data-action="run-mianalisis">▶ …</li>` |
| `js/i18n/dict.en.js` | el inglés de cada string en español que agregaste |

Los solves pesados van en un Web Worker (`js/solver/*_worker.js`) para no congelar la UI.

> Cinco de esos seis son en `app.js`. No es culpa tuya, y conviene saberlo antes de
> empezar: la matemática es la parte chica, el cableado la grande. Sacar el dominio de
> `app.js` es trabajo pendiente registrado.

---

## Convenciones que te van a morder

- **`?v=` en cada import interno bajo `js/`.** Si lo olvidas, el service worker te sirve el
  módulo viejo mientras depuras el nuevo. Súbela en todo el repo, todos los archivos a la
  vez — ver [`CONTRIBUTING.md`](../CONTRIBUTING.es.md).
- **Syntax check:** `node --input-type=module --check < js/solver/mi_analisis.js`.
  `node --check archivo.js` está mal: parsea el `.js` como CommonJS y reporta errores falsos.
- **Comentarios en inglés. Strings de UI en español**, envueltos en `i18n.t('…')`,
  traducidos en `dict.en.js`. Nombres de archivos, carpetas, funciones y enums en inglés.
- **Coordenadas Z-up** (como SAP2000/ETABS). Mapeo Three.js: `model(x,y,z) → three(x, z, y)`.
- **Orden de GDL de elemento (12):** `[ux1,uy1,uz1,rx1,ry1,rz1, ux2,…]`.
- Corre la app con `python serve.py 8765` — server estático no-cache con MIME UTF-8 correctos.

## Antes del PR

```bash
node --input-type=module --check < js/solver/mi_analisis.js
node tests/test_mi_analisis.mjs
for t in tests/test_*.mjs; do node "$t" || echo "FAIL $t"; done
```

Si tocaste el solver, corre además la suite de verificación — compara contra soluciones
cerradas, contra los valores publicados de SAP2000 y, en cinco casos, contra OpenSees:

```bash
node tools/run_verifs.mjs
```
