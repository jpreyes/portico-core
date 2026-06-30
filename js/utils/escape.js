// ──────────────────────────────────────────────────────────────────────────────
// escape — utilidades de escape para insertar datos del modelo en HTML.
//
// SEGURIDAD: todo dato que provenga de un archivo cargado (.s3d JSON, CSV, IFC)
// — nombres de materiales, secciones, casos de carga, diafragmas, etc. — DEBE
// pasar por escapeHtml() antes de interpolarse en innerHTML / template-literals,
// para evitar XSS almacenado. Ver SECURITY.md.
// ──────────────────────────────────────────────────────────────────────────────

// Escapa &, <, >, " — sirve tanto para contenido de texto como para atributos
// entre comillas dobles (title="...", value="...").
export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));

// Alias corto para mantener el uso histórico `esc(...)` en las plantillas.
export const esc = escapeHtml;
