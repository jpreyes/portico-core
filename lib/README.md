# Dependencias de terceros (vendored)

portico-core **no usa CDN ni gestor de paquetes**: las dependencias de terceros se
incluyen aquí (*vendored*), con versión fija. Así la app es **reproducible, funciona
offline (PWA) y no depende de que una CDN siga en línea** o cambie una versión.

| Archivo | Librería | Versión | Licencia | Origen |
|---|---|---|---|---|
| `three/three.module.js` | **Three.js** | **r164** | MIT | https://github.com/mrdoob/three.js |
| `three/addons/controls/OrbitControls.js` | Three.js — OrbitControls | r164 | MIT | (mismo repo, `examples/jsm/controls/`) |
| `numeric.js` | **numeric.js** | **1.2.6** | MIT | https://github.com/sloisel/numeric |

Three.js se resuelve por el *importmap* de [`index.html`](../index.html)
(`"three": "./lib/three/three.module.js"`); `numeric.js` se carga con un `<script>` y
expone `window.numeric`.

## Cómo actualizar una dependencia

1. Descarga la versión nueva desde el origen oficial (la build ESM en el caso de Three.js:
   `three.module.js` + los addons que uses, p. ej. `OrbitControls.js`).
2. Reemplaza el/los archivo(s) aquí **conservando la ruta** (el importmap apunta a ella).
3. Actualiza la **versión y la fila** de la tabla de arriba.
4. Sube el **cache-busting** `?v=NNN` en todo el repo (ver [`CONTRIBUTING.md`](../CONTRIBUTING.md) §3).
5. Corre la suite de verificación (`node test_*.mjs`) y prueba el visor 3D en el navegador.

> **Compatibilidad de Three.js:** las APIs cambian entre revisiones mayores. Tras
> actualizar, revisa el viewport (`js/ui/viewport.js`) y `OrbitControls`. Fija una
> revisión concreta; no uses rangos.

## Licencias

Three.js y numeric.js se distribuyen bajo licencia **MIT** (compatible con la AGPL-3.0 de
portico-core). Sus textos de licencia y avisos de copyright acompañan a cada librería en
su repositorio de origen; consérvalos al actualizar.
