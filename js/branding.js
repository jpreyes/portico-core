// ──────────────────────────────────────────────────────────────────────────────
// branding.js — WHITE-LABEL by configuration (no forks).
//
// Reads `branding.default.json` at startup and fills the UI brand text/logo:
//   appName     → <title>, header, splash, apple-mobile-web-app-title
//   tagline     → header and splash subtitle
//   description → splash footer
//   logos.primary → replaces the header SVG mark with an image (if defined)
//   links.repo  → repository link (if some element declares it)
//
// Elements to fill are marked in index.html with `data-brand="<field>"`. The DOM's
// Spanish text IS the default: if the JSON doesn't change a field (or fails to load),
// the UI stays the same and i18n translates it normally. Applied BEFORE booting the
// App so the i18n engine caches the already-"branded" text as the original.
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  appName: 'PORTICO',
  tagline: 'Análisis y diseño estructural 3D',
  description: 'PORTICO — plataforma open source de análisis y diseño estructural 3D.',
  logos: { primary: null, institutional: [] },
  showInstitutional: false,
  links: { academic: '', professional: '', repo: '' },
};

// Effective branding currently in use (after loading the JSON). Consumed by the App,
// e.g. to compose the per-model <title> with the configured appName.
let _current = DEFAULTS;

/** Effective branding in use (DEFAULTS until loadBranding() resolves). */
export function getBranding() { return _current; }

/** Loads branding.default.json (falls back to DEFAULTS) and applies it to the DOM. */
export async function loadBranding(version = '') {
  let b = DEFAULTS;
  try {
    const r = await fetch('branding.default.json' + version, { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      b = { ...DEFAULTS, ...j, logos: { ...DEFAULTS.logos, ...(j.logos || {}) }, links: { ...DEFAULTS.links, ...(j.links || {}) } };
    }
  } catch (e) { /* no file or no network → DEFAULTS (the UI already ships the Spanish text) */ }
  _current = b;
  try { applyBranding(b); } catch (e) { console.warn('branding: could not apply', e); }
  return b;
}

/** Applies the branding values to the elements marked with data-brand. */
export function applyBranding(b) {
  if (typeof document === 'undefined') return;

  // Text fields: each [data-brand="field"] gets the value (if present and non-empty).
  const setField = (campo, valor) => {
    if (valor == null || valor === '') return;
    for (const el of document.querySelectorAll(`[data-brand="${campo}"]`)) el.textContent = valor;
  };
  setField('appName', b.appName);
  setField('tagline', b.tagline);
  setField('description', b.description);

  // <title> and app meta (not markable text nodes).
  if (b.appName) {
    document.title = b.tagline ? `${b.appName} · ${b.tagline}` : b.appName;
    const m = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (m) m.setAttribute('content', b.appName);
  }

  // Primary logo: if defined, replaces the header SVG mark with an image.
  if (b.logos && b.logos.primary) {
    for (const mark of document.querySelectorAll('[data-brand-logo]')) {
      const img = document.createElement('img');
      img.src = b.logos.primary;
      img.alt = b.appName || '';
      img.className = mark.className;
      img.style.height = '1.4em';
      mark.replaceWith(img);
    }
  }

  // Links (e.g. repository): [data-brand-link="repo"] → href.
  if (b.links) {
    for (const key of Object.keys(b.links)) {
      const url = b.links[key];
      if (!url) continue;
      for (const a of document.querySelectorAll(`[data-brand-link="${key}"]`)) a.setAttribute('href', url);
    }
  }
}

export default { loadBranding, applyBranding, getBranding };
