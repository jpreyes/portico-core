# Contribuir a portico-core

[English](CONTRIBUTING.md) · **Español**

¡Gracias por tu interés! **portico-core** es la edición open source (AGPL-3.0) de
PORTICO: un pre/post-procesador + visor 3D + solver JS de análisis estructural por
elementos finitos, que corre íntegramente en el navegador. Esta guía explica cómo
montar el entorno, las convenciones del proyecto y cómo enviar tus cambios.

> **Idioma del proyecto:** los strings-fuente de la interfaz van en **español** (la UI se
> traduce al vuelo con el motor i18n, ver más abajo); los **comentarios de código y los
> mensajes de commit van en inglés**. La documentación está en inglés (canónica) y
> español (`*.es.md`).

---

## 1. Montar el entorno

No hay build step, ni bundler, ni `package.json`, ni dependencias que instalar.
Solo necesitas:

- **Python 3** (para el servidor estático de desarrollo).
- **Node.js 18+** (para correr la suite de verificación y los syntax-checks).
- Un navegador moderno (Chrome, Edge o Firefox).

```bash
# 1. Clonar tu fork
git clone https://github.com/<tu-usuario>/portico-core.git
cd portico-core

# 2. Levantar el servidor de desarrollo (puerto 8765 por defecto)
python serve.py
#    → abrir http://localhost:8765
```

`serve.py` es un servidor estático **sin caché** con los MIME correctos (UTF-8,
`.webmanifest`). La app NO funciona abriéndola como `file://` — debe servirse por HTTP.

---

## 2. Antes de abrir un Pull Request

> **¿Qué es un Pull Request (PR)?** Es la forma de proponer cambios: haces un *fork*
> del repo, creas una rama con tus cambios, y abres un PR pidiendo que se fusionen a
> `main`. El mantenedor revisa, comenta y fusiona. Nada entra a `main` sin pasar por
> un PR revisado.

Flujo recomendado:

```bash
git checkout -b fix/descripcion-corta   # rama <tipo>/<descripción> (nunca en main)
# … editar …
node --input-type=module --check < js/ruta/archivo.js   # syntax-check ESM
node tests/test_<lo-que-tocaste>.mjs                            # verificación
git commit -m "Descripción clara en inglés"
git push origin fix/descripcion-corta
# → abrir el PR en GitHub
```

Checklist antes de enviar:

- [ ] **Syntax-check** de cada módulo ESM tocado:
      `node --input-type=module --check < js/ruta/archivo.js`
      (NO uses `node --check archivo.js` — trata los `.js` como CommonJS y falla.)
- [ ] **Tests de verificación** pasan (ver §4). Si tocaste el solver, valida contra
      una solución analítica o el equilibrio global (ΣReacciones = ΣCargas).
- [ ] **Cache-busting** subido si cambiaste JS/CSS (ver §3).
- [ ] El cambio no reintroduce branding institucional (ver §5).
- [ ] Comentarios de código y mensaje de commit en inglés.

---

## 3. Versionado de imports (cache-busting)

Cada import interno lleva un sufijo `?v=NNN` (versión global de caché). Cuando cambies
cualquier JS o CSS, **sube la versión en TODOS los archivos a la vez**:

```bash
# Sube de v2 a v3 en todo el repo (ajusta los números al bump actual).
# Ancla en "?v=" (con el ?) para no tocar matemática como (v=1) en comentarios.
files=$(grep -rlF "?v=2" --include=*.js --include=*.html js index.html sw.js)
for f in $files; do sed -i 's/?v=2/?v=3/g' "$f"; done
```

Además, `sw.js` (service worker, *network-first*) tiene su propio `CACHE_VERSION` —
súbelo también en cada release.

> En Windows usa `sed` o las herramientas de edición; **no** uses PowerShell
> `Get-Content`/`Set-Content` para edición masiva: corrompe los acentos UTF-8.

---

## 4. Verificación (tests)

No hay framework de testing ni runner. Cada `tests/test_*.mjs` es un script Node
autónomo que es su propio *entry point*. Validan contra solución analítica o equilibrio
global.

```bash
node tests/test_plate.mjs        # placa (MITC4/DKT) vs solución analítica
node tests/test_shell.mjs        # cáscara
node tests/test_buckling.mjs     # pandeo lineal vs Euler
node tests/test_modal_kg.mjs     # modal con rigidez geométrica
# … hay 40+ tests; córrelos todos antes de un cambio amplio del solver
```

**Regla de oro del solver:** cualquier cambio en `js/solver/` debe validarse contra
un caso con solución conocida (patrón `test_*.mjs`). Si añades una capacidad nueva al
solver, **añade su test** siguiendo el mismo patrón.

---

## 5. Convenciones de código

- **Vanilla JS, ES modules**, sin framework. No se admiten dependencias que requieran
  build step ni `node_modules` en runtime.
- **Z-up** (como SAP2000/ETABS). Mapeo a Three.js: `model(x,y,z) → three(x, z, y)`.
- **GDL de elemento (12):** `[ux1,uy1,uz1,rx1,ry1,rz1, ux2,…]`. `releases` = array de
  12 (1 = liberado).
- **Sin branding institucional.** El branding es **configuración**
  (`branding.default.json`), no código. No reintroduzcas logos, "material docente",
  referencias a universidades, etc.
- **Construir encima sin forkear:** las capas superiores (motores enchufables,
  white-label) usan las costuras de extensión (`js/solver/backend.js` y
  `js/ext/extensions.js`). Core **nunca** importa nada de una capa superior. Ver
  [`docs/EXTENDING.md`](docs/EXTENDING.md).
- **Honestidad open source:** core solo declara y expone lo que su propio solver JS
  realmente ejecuta. No dejes métodos, flags de capacidad ni ítems de UI para
  análisis que el JS de core no puede correr.

### Internacionalización (i18n)

El español es el idioma fuente (está en el DOM y en los strings de JS). El motor de
i18n (`js/i18n/`) traduce sobre la marcha. Para traducir:

- Strings dinámicos de JS: envuélvelos en `i18n.t('texto en español')`.
- Subárboles del DOM creados dinámicamente: llama a `i18n.translate(root)`.
- Añade el par español→destino en el diccionario correspondiente
  (`js/i18n/dict.en.js` para inglés).

---

## 6. Git

- **Nombres de rama:** `<tipo>/<descripción-kebab>`, donde `<tipo>` es uno de
  `feat`, `fix`, `docs`, `refactor`, `test`, `chore` (también `perf`, `ci`). Ejemplos:
  `fix/dkt-rotation-convention`, `feat/seismic-mass-source`, `docs/branch-naming`.
  Una rama por cambio; nunca trabajes directamente en `main`.
- Commits en **inglés**, claros y en imperativo o descriptivo.
- **No** uses `git add -A` a ciegas: `excel/`, `referencias/` y `node_modules/` **no**
  se versionan.

---

## 7. Reportar bugs y proponer ideas

- **Bugs:** abre un *issue* describiendo qué esperabas, qué pasó, y cómo reproducirlo.
  Si puedes, adjunta el `.s3d` mínimo que dispara el problema.
- **Vulnerabilidades de seguridad:** **no** abras un issue público. Sigue
  [`SECURITY.md`](SECURITY.md).
- **Ideas y discusiones:** abre un issue de tipo *discusión* o comenta en el
  [`ROADMAP`](docs/ROADMAP.md).

---

## 8. Licencia de tus contribuciones (CLA)

PORTICO es **open-core** y de **licenciamiento dual**: `portico-core` se publica bajo la
**AGPL-3.0** *y* el mismo código puede ofrecerse bajo términos comerciales separados para
la edición Pro (ver [`LICENSING.md`](LICENSING.md)). Para que el código aportado pueda
distribuirse bajo ambos, los contribuyentes aceptan un **Acuerdo de Licencia de
Contribuyente** liviano ([`CLA.md`](CLA.md)).

- **Conservas el copyright** de tu trabajo — el CLA es una concesión de licencia, no una
  cesión. Sigues libre de usar tu propia contribución como quieras.
- **Cómo firmar:** en tu primer pull request, el bot de CLA-assistant te pide confirmar la
  aceptación una vez (tu identidad de GitHub es tu firma). En [`CLA.md`](CLA.md) se describe
  una alternativa manual por email.
- **¿Contribuyes en nombre de una empresa?** Un representante autorizado también debe
  aceptar un CLA corporativo — escribe a `jpreyes.c@gmail.com`.

Al enviar una contribución también certificas el
[Developer Certificate of Origin 1.1](https://developercertificate.org): que la escribiste
(o tienes derecho a enviarla) y que puede distribuirse bajo las licencias del proyecto. Ver
[`LICENSE`](LICENSE) para el texto de la AGPL.
