# Roadmap — portico-core

[English](ROADMAP.md) · **Español**

Estado: ⬜ pendiente · 🟡 en curso · ✅ hecho.

Este documento resume el estado público de **portico-core**, la edición open source
(AGPL-3.0) de PORTICO: pre/post-procesador + visor 3D + solver JS.

---

## v0.1 — primer corte open source

Objetivo: publicar una base limpia, profesional y reutilizable.

- ✅ De-branding total: sin marca institucional ni logos de terceros.
- ✅ Branding como configuración (`branding.default.json`) para white-label.
- ✅ Nomenclatura de hormigón **grado G** (NCh170:2016), con compatibilidad hacia atrás del legado «H».
- ✅ Interfaz `SolverBackend` (`js/solver/backend.js`): costura para motores enchufables (solo motor JS en open).
- ✅ Costura de extensión de UI/memoria (`js/ext/extensions.js`): secciones de configuración,
  insignias y flags que las capas superiores registran sin forkear `app.js`. Ver [`EXTENDING.md`](EXTENDING.md).
- ✅ Modo profesional / token fuera de core (vive en la capa Pro): core es funcional sin token.
- ✅ Licencia AGPL-3.0 y README orientado a open-core.
- ✅ Repositorio sin binarios ni material de terceros con copyright.
- ✅ **Estático cableado por el `SolverRegistry`**: `App._solveStaticCases` consulta el backend
  activo (hook guardado; por defecto `'js'` sin cambios) → un backend externo (Nodex) resuelve
  con fallback transparente a JS. Post-proceso (diagramas/deformada) reutilizable por backends.

## Próximos hitos

- ✅ **Internacionalización (ES/EN)**: motor i18n por string-fuente (`js/i18n/`) con selector de
  idioma y fallback a español. Cubre menús, header, portada, **panel de propiedades, barra de
  herramientas (tooltips), diálogos y toasts**; el motor traduce además atributos
  (`title`/`aria-label`/`placeholder`) y auto-traduce los paneles que se re-renderizan.
- ✅ **Loader de branding**: `js/branding.js` lee `branding.default.json` al iniciar (antes de la App)
  y rellena nombre/tagline/descripción/logo de la UI vía atributos `data-brand`. White-label sin forks.
- ✅ **Registry para todos los análisis JS**: estático, modal, espectro, pandeo, P-Δ, no lineal,
  pushover, time-history modal, etapas, cargas móviles, tendón y form-finding pasan por el
  `SolverBackend` con *fallback* a JS. Hook `registerAnalysis` para análisis de capas superiores.
- ✅ **Suite de verificación**: 18 casos documentados en `docs/verifications` contra solución
  analítica / referencias publicadas, con figuras generadas por `tools/` (sin depender de PDFs externos).
- ✅ **Documentación de la API** (`docs/api.md`) y ejemplos mínimos de integración.
- ✅ **Documentación canónica en inglés**: comentarios de código, README, CHANGELOG, CONTRIBUTING,
  SECURITY y CODE_OF_CONDUCT en inglés (`.md`), con el español conservado como `*.es.md`.
- ✅ **Perfil de comunidad + CI**: plantillas de issue/PR en `.github/` y un workflow de GitHub
  Actions que corre la batería de tests en cada push/PR.
- ⬜ Empaquetado de portico-core como dependencia consumible por productos derivados.

## Arquitectura

Pre/post-procesador y solver JS conviven en este repo. El motor pesado (C++/WASM) **no**
vive aquí: se enchufa a través de `SolverBackend` en los productos Pro. Detalles de
arquitectura y convenciones de ingeniería en [`EXTENDING.md`](EXTENDING.md) y al inicio de cada módulo.

## Cómo contribuir

- Issues y discusiones en el repositorio.
- Valida cualquier cambio del solver contra un caso analítico (patrón `test_*.mjs` en la raíz).
- Strings-fuente de la UI en español; **comentarios de código y mensajes de commit en inglés**;
  documentación en inglés (canónica) con `*.es.md` en español.
