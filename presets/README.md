# Presets de normativa (por jurisdicción)

[English below ↓](#english)

El **core de portico-core es agnóstico**: los archivos de `assistant/` traen tablas
de **ejemplo genéricas** (cargas, espectro, parámetros de diseño), no la normativa de
ningún país. Así la base no impone una jurisdicción.

Cada carpeta aquí es un **preset opt-in** con las tablas reales de un código nacional.
Para usarlo, **copia sus archivos sobre `assistant/`** (mismos nombres → reemplazan los
de ejemplo):

```bash
# Ejemplo: aplicar el preset de Chile
cp presets/chile/rules.json            assistant/rules.json
cp presets/chile/design_params.json     assistant/design_params.json
cp presets/chile/live_loads.csv assistant/live_loads.csv
```

Recarga la app y el generador/diseño usarán esa normativa. Para volver a la base
agnóstica, restaura los archivos de ejemplo (control de versiones: `git checkout assistant/`).

> **El motor es agnóstico; solo estos datos definen la jurisdicción.** `assistant/loads.js`
> y `assistant/generator.js` leen las **mismas claves** en todos los presets. Si una tabla
> falta, las cargas correspondientes se degradan con elegancia (no rompen).

## Aportar un preset

¿Tu país usa otro código (España, México, EE. UU., …)? Crea
`presets/<pais>/` con los mismos archivos y estructura de claves, un `README.md` que
liste las normas cubiertas, y abre un Pull Request. Ver [`CONTRIBUTING.md`](../CONTRIBUTING.md).

Presets disponibles:

- [`chile/`](chile/) — NCh431 (nieve), NCh432 (viento), NCh433/DS61 (sísmica),
  NCh1537 (cargas de uso), parámetros de diseño (AISC/ACI/EC/NCh).

---

<a name="english"></a>
## English

The **core of portico-core is agnostic**: the files in `assistant/` ship **generic
example tables** (loads, spectrum, design parameters), not any country's code. The base
imposes no jurisdiction.

Each folder here is an **opt-in preset** with the real tables of a national code. To use
it, **copy its files over `assistant/`** (same names → they replace the example ones):

```bash
# Example: apply the Chile preset
cp presets/chile/rules.json            assistant/rules.json
cp presets/chile/design_params.json     assistant/design_params.json
cp presets/chile/live_loads.csv assistant/live_loads.csv
```

Reload the app and the generator/design will use that code. To return to the agnostic
base, restore the example files (`git checkout assistant/`).

> **The engine is agnostic; only this data defines the jurisdiction.** All presets use
> the **same keys**, which `assistant/loads.js` and `assistant/generator.js` read. If a
> table is missing, the corresponding loads degrade gracefully (no crash).

To contribute a preset for your country, create `presets/<country>/` with the same files
and key structure, a `README.md` listing the covered codes, and open a Pull Request.
