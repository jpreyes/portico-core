// ──────────────────────────────────────────────────────────────────────────────
// extensions.js — EXTENSION POINTS (hooks) of portico-core.
//
// portico-core (open, AGPL) is a COMPLETE, self-contained app. Upper layers —e.g. a
// white-label build or a company report— do NOT fork `app.js`: they import this
// module and REGISTER their contributions at runtime. Core never imports anything
// from the upper layers → unidirectional dependency (core ⇠ overlay).
//
// Available seams:
//   • Extra sections of the ⚙ Settings dialog      (registerConfigSection)
//   • Top-bar badges                                (registerBadge)
//   • Opt-in capability flags                       (setFlag / flag)
//   • Additional analyses in the Hub               (registerAnalysis)
// ──────────────────────────────────────────────────────────────────────────────

class Extensions {
  constructor() {
    this._configSections = [];
    this._badges = [];
    this._flags = {};
    this._analyses = [];
  }

  // ── Settings dialog (⚙) ────────────────────────────────────────────────────
  // spec: {
  //   id,
  //   render(ctx) -> htmlString,   // HTML of the <fieldset> to inject
  //   bind?(ctx),                  // listeners, after inserting the HTML
  //   collect?(ctx)                // dump values into ctx.mm / ctx.an on save
  // }
  // ctx = { app, mm, an, sd, esc }
  //   mm = working copy of the effective report metadata (persisted on save)
  //   an = config.analisis ; sd = config.seccion_mod_default
  //   esc = HTML attribute escaper
  registerConfigSection(spec) { this._configSections.push(spec); return this; }
  get configSections() { return this._configSections.slice(); }

  // ── Top-bar badges ──────────────────────────────────────────────────────────
  // spec: { id, html } | { id, render() -> htmlString }
  registerBadge(spec) { this._badges.push(spec); return this; }
  get badges() { return this._badges.slice(); }

  // ── Capability flags (opt-in by upper layers) ─────────────────────────────────
  // e.g. extensions.setFlag('memoriaBranding') enables company logo/footer/limitations
  // in the report. In core they are false → standard template.
  setFlag(name, value = true) { this._flags[name] = !!value; return this; }
  flag(name) { return !!this._flags[name]; }

  // ── Additional analyses in the analysis Hub ───────────────────────────────────
  // spec: {
  //   id       string     unique identifier (e.g. 'fiber-section')
  //   label    string     Hub item text (e.g. 'Fiber section analysis')
  //   menu     string     menu section where the quick access appears
  //                       (e.g. 'run-nonlinear', 'run-dynamic', 'run-advanced')
  //   group?   string     visual group label in the Hub (optional)
  //   handler  function   async handler(ctx) — ctx = { app, openModal, setStatus,
  //                         refreshViewport }
  // }
  // core registers ZERO additional analyses. Only upper layers use this hook.
  registerAnalysis(spec) {
    if (!spec || !spec.id || typeof spec.handler !== 'function')
      throw new Error('registerAnalysis: spec must have {id, handler}');
    if (this._analyses.find(a => a.id === spec.id))
      throw new Error(`registerAnalysis: an analysis with id '${spec.id}' already exists`);
    this._analyses.push(spec);
    return this;
  }
  get analyses() { return this._analyses.slice(); }
}

export const extensions = new Extensions();
export default extensions;
