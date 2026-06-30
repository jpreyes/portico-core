// ──────────────────────────────────────────────────────────────────────────────
// io/ifc/ifcWarnings.js — collector of IFC import WARNINGS (#76, G19)
//
// Centralizes the non-blocking warnings (generic material, approximate section,
// segmented curve, etc.).  G19's philosophy is ROBUST: the import is never aborted
// because of a missing or not-understood datum; instead a warning is left and it
// continues with a reasonable generic value.  Warnings are shown per element (in the
// dialog table) and aggregated (global summary).  STANDALONE (Node + browser).
// ──────────────────────────────────────────────────────────────────────────────

/** Small warning accumulator with a count of duplicates (for the global summary). */
export class Warnings {
  constructor() { this.list = []; this._counts = new Map(); }

  /** Adds a warning (free text). Returns `this` for chaining. */
  add(msg) {
    if (!msg) return this;
    this.list.push(msg);
    this._counts.set(msg, (this._counts.get(msg) || 0) + 1);
    return this;
  }

  get length() { return this.list.length; }
  get empty()  { return this.list.length === 0; }

  /** Plain text of all the warnings (for `_alert`). */
  toText() { return this.list.join('\n'); }

  /** Grouped summary «(×N) message», sorted by descending frequency. */
  summary() {
    return [...this._counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([m, c]) => (c > 1 ? `(×${c}) ${m}` : m));
  }
}
