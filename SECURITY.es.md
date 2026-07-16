# Política de seguridad

[English](SECURITY.md) · **Español**

## Versiones soportadas

Se da soporte de seguridad a la **última versión menor publicada**. Al ser un proyecto
joven, recomendamos siempre usar la versión más reciente de `main` o de la última
*release*.

| Versión | Soporte             |
|---------|---------------------|
| 0.1.x   | ✅ Sí               |
| < 0.1   | ❌ No (pre-release) |

## Reportar una vulnerabilidad

**No abras un issue público** para vulnerabilidades de seguridad.

Repórtala de forma privada por alguna de estas vías:

- **Email:** jpreyes.c@gmail.com (asunto: `[SEGURIDAD] portico-core`)
- **GitHub:** pestaña *Security → Report a vulnerability* (avisos de seguridad
  privados), si está habilitada en el repositorio.

Incluye, en lo posible:

- Descripción del problema y su impacto.
- Pasos para reproducirlo (y un `.s3d`/CSV/IFC mínimo si aplica).
- Versión afectada y navegador/SO.

**Plazos orientativos:** acuse de recibo en un plazo de **72 horas** y una primera
evaluación dentro de **7 días**. Coordinaremos contigo la divulgación responsable una
vez exista una corrección.

## Modelo de amenaza

portico-core es una **aplicación de cliente** que corre íntegramente en el navegador.
La edición open **no incluye backend propio**: no hay servidor que procese datos del
usuario en core (`serve.py` es solo un servidor estático de desarrollo). Esto acota la
superficie de ataque, pero hay vectores relevantes a tener en cuenta:

- **Apertura de archivos no confiables** (`.s3d`, CSV, IFC): un modelo malicioso podría
  intentar inyectar contenido (p. ej. nombres de nodos/materiales/secciones/casos/
  diafragmas) que se renderiza en el DOM (XSS almacenado). El código debe **escapar**
  todo dato proveniente de archivos antes de insertarlo como HTML. El punto único de
  escape es **`js/utils/escape.js`** (`esc` / `escapeHtml`, que también escapa `"` para
  uso dentro de atributos `title="…"`/`value="…"`): impórtalo y envuelve con `esc(...)`
  cualquier dato del modelo que se interpole en `innerHTML`/template-literals. No
  redefinas helpers de escape inline. El caso `test_xss_escape.mjs` cubre esta garantía.
- **Service Worker** (`sw.js`): cachea recursos de la app. Un SW comprometido podría
  servir contenido obsoleto o malicioso; por eso es *network-first* y versionado.
- **Dependencias de terceros** (Three.js, numeric.js): se cargan por importmap. Conviene
  fijar versiones e idealmente verificar integridad (SRI) cuando se sirven desde CDN.

### Fuera de alcance

- La **exactitud de los resultados de ingeniería** no es un problema de seguridad: los
  resultados son orientativos y requieren la revisión de un ingeniero calculista (ver
  el aviso en el `README`). Errores de cálculo se reportan como *issues* normales con
  un caso de verificación.

## Divulgación

Practicamos **divulgación coordinada**: te pediremos no hacer público el detalle hasta
que haya una corrección disponible, y te daremos crédito en el aviso de seguridad si así
lo deseas.
