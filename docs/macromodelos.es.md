# Macromodelos — guía de integración y roadmap (`#86`)

[English](macromodelos.md) · **Español**

Un **macromodelo** resuelve un subsistema estructural complejo con **pocos elementos
calibrados** (barras / cables / resortes / links no lineales) en vez de un mallado fino.
El usuario selecciona unos nodos (p.ej. las 4 esquinas de un panel) y el motor lo
**expande** a su red interna ya calibrada.

> **División de trabajo (acordada).** El **desarrollo teórico** de cada macromodelo
> (geometría equivalente, rigideces, leyes constitutivas / histéresis, calibración) se
> hace **aparte**. Aquí la **integración ya está resuelta**: registrar el macromodelo y
> escribir su `expand(...)` que construye los elementos calibrados en el modelo. Esta
> guía es el contrato para que enchufar un macromodelo nuevo sea una tarea pequeña y
> mecánica.

---

## Arquitectura

```
UI (selección de nodos + diálogo auto-generado)
        │  app.insertMacroFromSelection(id)
        ▼
macro_registry.js   registerMacro({id,name,nodes,params,expand}) · insertMacro(model,id,nodeIds,props)
        │  expand(model, nodeIds, props)
        ▼
Model               crea materiales/secciones + elementos (barras/cables/links) calibrados
        │           marca cada uno: el.macro=<nº>, el.macroType=<id>; registra en model.macros
        ▼
Solver              los resuelve como elementos normales (incl. compressionOnly, releases,
                    cable, links, P-Δ, no lineal…) — el macromodelo NO necesita solver propio
```

- **`js/model/macro_registry.js`** — el registro conectable: `registerMacro`, `getMacro`,
  `listMacros`, `insertMacro`. Mismo patrón que el registro de **códigos de diseño**
  (`js/design/registry.js`) y el de **formatos de intercambio** (`js/io/registry.js`).
- **`js/model/macromodel.js`** — los macromodelos concretos (hoy: `infill`), cada uno se
  auto-registra al final del archivo.
- **`app.insertMacroFromSelection(id)`** — UI **genérica**: valida nodos/modo, arma el
  diálogo de parámetros desde `def.params` y ejecuta el `expand`. **Un macromodelo nuevo
  no necesita diálogo propio.**

---

## Contrato de un macromodelo nuevo

```js
import { registerMacro } from './macro_registry.js?v=NNN';

registerMacro({
  id:        'shearwall',                       // único
  name:      'Muro de corte — columna ancha',   // menú/diálogo
  desc:      'Muro de H.A. → columna ancha + resortes de corte (referencia teórica).',
  nodes:     2,                                 // nº de nodos a seleccionar
  nodesHint: 'los 2 nodos extremos del muro (base y cabeza)',
  dims:      '2D',                              // '2D' | '3D' | null (ambos)
  params: [                                     // → diálogo auto-generado
    { key: 'fc',  label: "f'c (kN/m²)",      default: 25000, step: 1000, min: 1 },
    { key: 't',   label: 'Espesor (m)',      default: 0.20,  step: 0.05, min: 0.01 },
    { key: 'lw',  label: 'Largo del muro (m)', default: 3.0, step: 0.1,  min: 0.1 },
  ],

  // TEORÍA YA RESUELTA por el autor → aquí sólo se CONSTRUYE en el modelo.
  expand(model, nodeIds, props) {
    // 1) validar geometría; devolver { error } si algo falta
    // 2) crear material(es) y sección(es) calibradas (model.addMaterial / addSection)
    // 3) crear los elementos (model.addElement / addLink …) con sus propiedades NL
    //    (el.compressionOnly, el.cable, el.releases, links, resortes de nodo…)
    // 4) MARCAR cada elemento creado:  el.macro = macroId;  el.macroType = 'shearwall';
    // 5) registrar el macro en model.macros (para identificarlo/borrarlo en bloque)
    // 6) return { macroId, elemIds:[…], … }   (o { error })
  },
});
```

**Responsabilidades del `expand` (lo único caso-a-caso):**

1. **Validar** la entrada (nº de nodos ya lo chequea `insertMacro`; valida la geometría).
2. **Crear** materiales/secciones calibrados y los **elementos** de la red equivalente.
   Reusa todo lo que el solver ya entiende: `el.compressionOnly` (#56), `el.cable`,
   `el.releases` (rótulas), `el.rigidEnd` (cacho rígido), `model.addLink` (coupling/rígido),
   resortes de nodo (`node.springs`), pretensado por `L0factor`, etc.
3. **Marcar** cada elemento: `el.macro = <id numérico>`, `el.macroType = '<id del def>'`.
4. **Registrar** en `model.macros` (Map) `{ id, type, corners/nodes, elemIds, props, … }`.
5. **Devolver** `{ macroId, … }` o `{ error: '…' }`.

El macromodelo **no necesita solver propio**: una vez expandido, son elementos normales
que el estático / modal / no lineal / P-Δ resuelven. Si la teoría exige una ley
constitutiva nueva (p.ej. histéresis pinchada), eso se añade al solver NL como una
capacidad reusable y el `expand` sólo la **referencia** por flag.

**Ejemplo de referencia:** `insertInfill` en `js/model/macromodel.js` (muro de relleno →
2 puntales diagonales solo-compresión de Mainstone/FEMA 356) — seguir ese patrón.

---

## Cómo enchufar uno nuevo (checklist)

1. Escribir `expand(...)` en `js/model/macromodel.js` (o un archivo nuevo `macros/<id>.js`).
2. `registerMacro({ … })` al final del archivo.
3. Asegurar que el archivo se importa (ya se importa `macromodel.js`; si es nuevo, añadir el import).
4. Añadir una entrada de menú **Editar → Macromodelos → «…»** que llame a
   `app.insertMacroFromSelection('<id>')`. *(La UI del diálogo es automática.)*
5. (Opcional) Verificación `test_macromodel.mjs`: comprobar la geometría/áreas equivalentes
   contra el cálculo a mano y la **estabilidad** (el estático no da mecanismo).
6. Bump de versión + documentar la teoría/calibración en este archivo.

---

## Roadmap de macromodelos a integrar

> El autor entrega la **teoría/calibración**; la integración sigue el contrato de arriba.
> Prioridad sugerida (de más usado / más simple a más complejo):

| Estado | Macromodelo | Nodos | Equivalente / teoría | Notas de integración |
|---|---|---|---|---|
| ✅ | **Muro de relleno (infill)** | 4 esquinas | Puntal diagonal de Mainstone / FEMA 356 §7.5.2 | Hecho (`infill`). Pendiente teórico: degradación cíclica + tracción. |
| ⬜ | **Muro de corte (shear wall)** | 2–4 | Columna ancha (wide-column) + brazos rígidos + resortes de corte | Reusa `rigidEnd` + resortes; clave para edificios de H.A. |
| ⬜ | **Arriostramiento concéntrico (brace)** | 2 | Barra con pandeo/post-pandeo (modelo de fibra o fenomenológico) | Reusa `compressionOnly` o NL; histéresis de pandeo = capacidad NL nueva. |
| ⬜ | **Conexión semirrígida (panel zone / nudo)** | 1 nudo | Resorte rotacional M–θ (Richard-Abbott / bilineal) | Link rotacional entre viga y columna; ley M–θ. |
| ⬜ | **Aislador sísmico / apoyo elastomérico** | 1–2 | Resorte horizontal bilineal (Bouc-Wen) + vertical | Link/resorte NL en la interfaz base; histéresis. |
| ⬜ | **Disipador (amortiguador) viscoso/histerético** | 2 | Elemento fuerza-velocidad (viscoso) o fuerza-desp. (metálico) | Sólo en dinámico NL; capacidad de amortiguamiento por elemento. |
| ⬜ | **Suelo / interacción suelo-estructura** | n base | Resortes de Winkler (p–y, t–z) calibrados | Reusa `node.springs`; curvas no lineales como capacidad NL. |
| ⬜ | **Tabique / partición no estructural** | 4 | Puntal equivalente reducido (rigidez parcial) | Variante calibrada de `infill`. |

*(Cuando el autor entregue la teoría de uno, se mueve a ✅ siguiendo el checklist.)*

## Capacidades NL transversales que pueden hacer falta

Algunas teorías exigen una **ley constitutiva** reusable; conviene añadirla al solver NL
una vez y que varios macromodelos la referencien por flag:

- Histéresis **Bouc-Wen** (aisladores, disipadores metálicos).
- Histéresis **pinchada** (muros/conexiones de H.A.).
- **Pandeo/post-pandeo** de barra (arriostramientos).
- Resortes **viscosos** dependientes de la velocidad (amortiguadores) — sólo en time-history NL.

Estas se integran al motor NL existente (`nl_lite.js` / time-history NL) como tipos de
elemento/material reusables; el `expand` del macromodelo sólo las **activa**.
