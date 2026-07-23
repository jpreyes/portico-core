// ──────────────────────────────────────────────────────────────────────────────
// i18n.js — internationalization (ES/EN) of portico-core. Vanilla, no build.
//
// APPROACH (low-risk retrofit): SOURCE-STRING translation (gettext-style).
// The engine walks the DOM TEXT NODES and translates only those that EXACTLY match
// (trimmed) an entry of the EN dictionary. It does not restructure the HTML nor
// touch handlers:
//   · Icons/emojis are part of the source string (neutral → left as-is).
//   · <kbd> (shortcuts), <script>, <style>, <input>/<textarea> are SKIPPED.
//   · Spanish is the SOURCE (the text already in the DOM). Only the EN dictionary
//     is written; switching back to 'es' restores the original (cached per node).
//
// For text generated dynamically in JS, use t('spanish text') → returns the
// translation if it exists, or the same text (fallback). And call translate() again
// on the freshly created subtree if needed.
// ──────────────────────────────────────────────────────────────────────────────
import { EN } from './dict.en.js?v=7';

const LS_KEY = 'portico_lang';
const SUPPORTED = ['es', 'en'];
const SKIP_TAGS = new Set(['KBD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'CODE']);
// UI attributes with visible text (tooltips, accessible labels, placeholders).
// The base engine only translates text nodes; these attributes are translated apart.
const I18N_ATTRS = ['title', 'aria-label', 'placeholder'];

const _orig = new WeakMap();   // text node → original Spanish value (for restoring)
const _origAttr = new WeakMap(); // element → { attr: original Spanish value }

function _initialLocale() {
  try { const s = localStorage.getItem(LS_KEY); if (SUPPORTED.includes(s)) return s; } catch (e) {}
  const nav = (typeof navigator !== 'undefined' && navigator.language || 'es').slice(0, 2);
  return nav === 'en' ? 'en' : 'es';   // Spanish by default
}

let _locale = _initialLocale();

// Looks up `original` in the dictionary and returns the translated string with the
// SAME leading/trailing whitespace, or null if there is no entry. Two passes:
//   1) exact trimmed match (fast path; back-compatible with single-line keys).
//   2) ASCII-whitespace-normalized match: collapse runs of [ \t\r\n] to one space.
//      This makes multi-line / indented text nodes (e.g. wrapped <p>/<li> in the
//      help dialog) translatable without embedding newlines in the dictionary key.
//        (&nbsp;) is intentionally NOT collapsed so keys relying on it still match.
function _lookup(original) {
  const trimmed = original.trim();
  let tr = EN[trimmed];
  if (tr != null) return original.replace(trimmed, tr);
  const lead = (original.match(/^[ \t\r\n]*/) || [''])[0];
  const trail = (original.match(/[ \t\r\n]*$/) || [''])[0];
  const core = original.slice(lead.length, original.length - trail.length);
  const norm = core.replace(/[ \t\r\n]+/g, ' ');
  if (norm !== trimmed) { tr = EN[norm]; if (tr != null) return lead + tr + trail; }
  return null;
}

/** Translation of a single string (text generated in JS). Fallback: the same text. */
export function t(es) {
  if (_locale === 'es') return es;
  const tr = _lookup(String(es));   // preserves surrounding whitespace
  return tr == null ? es : tr;
}

/** Applies the current locale to all text nodes under `root`. Idempotent. */
export function translate(root = document.body) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = node.parentNode;
      if (p && SKIP_TAGS.has(p.nodeName)) return NodeFilter.FILTER_REJECT;
      if (p && p.closest && p.closest('[data-i18n-skip]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  for (const node of nodes) {
    if (!_orig.has(node)) _orig.set(node, node.nodeValue);
    const original = _orig.get(node);
    if (_locale === 'es') { if (node.nodeValue !== original) node.nodeValue = original; continue; }
    const tr = _lookup(original);
    if (tr != null) node.nodeValue = tr;
  }
  _translateAttrs(root);
}

/** Translates the text attributes (title/aria-label/placeholder) under `root`. */
function _translateAttrs(root) {
  if (!root.querySelectorAll) return;
  const SEL = I18N_ATTRS.map(a => `[${a}]`).join(',');
  const list = [];
  if (root.nodeType === 1 && I18N_ATTRS.some(a => root.hasAttribute(a))) list.push(root);
  for (const el of root.querySelectorAll(SEL)) list.push(el);
  for (const el of list) {
    if (el.closest && el.closest('[data-i18n-skip]')) continue;
    let store = _origAttr.get(el);
    for (const attr of I18N_ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      if (!store) { store = {}; _origAttr.set(el, store); }
      if (!(attr in store)) store[attr] = el.getAttribute(attr);
      const original = store[attr];
      if (_locale === 'es') { if (el.getAttribute(attr) !== original) el.setAttribute(attr, original); continue; }
      const tr = _lookup(original);
      if (tr != null) el.setAttribute(attr, tr);
    }
  }
}

/** Installs a MutationObserver that re-translates `root` when new HTML is injected
 *  (panels/dialogs that re-render). No-op in Spanish → no cost in the default case.
 *  Returns the observer (so it can be disconnected if needed). */
export function observe(root) {
  if (!root || typeof MutationObserver === 'undefined') return null;
  const obs = new MutationObserver(() => { if (_locale !== 'es') translate(root); });
  obs.observe(root, { childList: true, subtree: true, characterData: false });
  return obs;
}

export function getLocale() { return _locale; }

/** Changes the locale, persists it and re-translates the document. */
export function setLocale(loc) {
  if (!SUPPORTED.includes(loc)) return;
  _locale = loc;
  try { localStorage.setItem(LS_KEY, _locale); } catch (e) {}
  if (typeof document !== 'undefined') document.documentElement.lang = _locale;
  translate(document.body);
  try { window.dispatchEvent(new CustomEvent('localechange', { detail: { locale: _locale } })); } catch (e) {}
}

/** Initializes: sets <html lang> and translates once. Call after building the DOM. */
export function init(root = document.body) {
  if (typeof document !== 'undefined') document.documentElement.lang = _locale;
  translate(root);
}

export const i18n = { t, translate, observe, getLocale, setLocale, init, SUPPORTED };
export default i18n;
