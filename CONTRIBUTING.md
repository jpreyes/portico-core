# Contributing to portico-core

**English** · [Español](CONTRIBUTING.es.md)

Thanks for your interest! **portico-core** is the open source edition (AGPL-3.0) of
PORTICO: a pre/post-processor + 3D viewer + JS solver for structural finite-element
analysis, running entirely in the browser. This guide explains how to set up the
environment, the project conventions, and how to submit your changes.

> **Project language:** the UI source strings are in **Spanish** (the UI is translated on
> the fly by the i18n engine — see below); **code comments and commit messages are in
> English**. Documentation is available in English (canonical) and Spanish (`*.es.md`).

---

## 1. Set up the environment

There is no build step, no bundler, no `package.json`, and no dependencies to install.
You only need:

- **Python 3** (for the static development server).
- **Node.js 18+** (to run the verification suite and syntax checks).
- A modern browser (Chrome, Edge or Firefox).

```bash
# 1. Clone your fork
git clone https://github.com/<your-user>/portico-core.git
cd portico-core

# 2. Start the development server (port 8765 by default)
python serve.py
#    → open http://localhost:8765
```

`serve.py` is a **no-cache** static server with the correct MIME types (UTF-8,
`.webmanifest`). The app does NOT work when opened as `file://` — it must be served over HTTP.

---

## 2. Before opening a Pull Request

> **What is a Pull Request (PR)?** It is how you propose changes: you *fork* the repo,
> create a branch with your changes, and open a PR asking to merge them into `main`.
> The maintainer reviews, comments and merges. Nothing reaches `main` without going
> through a reviewed PR.

Recommended flow:

```bash
git checkout -b fix/short-description   # <type>/<description> branch (never on main)
# … edit …
node --input-type=module --check < js/path/file.js   # ESM syntax check
node test_<what-you-touched>.mjs                       # verification
git commit -m "Clear description in English"
git push origin my-change
# → open the PR on GitHub
```

Checklist before submitting:

- [ ] **Syntax check** of every ESM module you touched:
      `node --input-type=module --check < js/path/file.js`
      (Do NOT use `node --check file.js` — it treats `.js` as CommonJS and fails.)
- [ ] **Verification tests** pass (see §4). If you touched the solver, validate against
      an analytical solution or global equilibrium (ΣReactions = ΣLoads).
- [ ] **Cache-busting** bumped if you changed JS/CSS (see §3).
- [ ] The change does not reintroduce institutional branding (see §5).
- [ ] Code comments and commit message in English.

---

## 3. Import versioning (cache-busting)

Every internal import carries a `?v=NNN` suffix (global cache version). When you change
any JS or CSS, **bump the version in ALL files at once**:

```bash
# Bump from v2 to v3 across the whole repo (adjust the numbers to the current bump).
# Anchor on "?v=" (with the ?) so you don't touch math like (v=1) in comments.
files=$(grep -rlF "?v=2" --include=*.js --include=*.html js index.html sw.js)
for f in $files; do sed -i 's/?v=2/?v=3/g' "$f"; done
```

Also, `sw.js` (the *network-first* service worker) has its own `CACHE_VERSION` — bump
it as well on each release.

> On Windows use `sed` or the editing tools; do **not** use PowerShell
> `Get-Content`/`Set-Content` for bulk editing: it corrupts UTF-8 accents.

---

## 4. Verification (tests)

There is no testing framework or runner. Each `test_*.mjs` in the root is a standalone
Node script that is its own *entry point*. They validate against an analytical solution
or global equilibrium.

```bash
node test_plate.mjs        # plate (MITC4/DKT) vs analytical solution
node test_shell.mjs        # shell
node test_buckling.mjs     # linear buckling vs Euler
node test_modal_kg.mjs     # modal with geometric stiffness
# … there are 40+ tests; run them all before a broad solver change
```

**Solver golden rule:** any change in `js/solver/` must be validated against a case
with a known solution (`test_*.mjs` pattern). If you add a new solver capability,
**add its test** following the same pattern.

---

## 5. Code conventions

- **Vanilla JS, ES modules**, no framework. Dependencies that require a build step or
  `node_modules` at runtime are not accepted.
- **Z-up** (like SAP2000/ETABS). Mapping to Three.js: `model(x,y,z) → three(x, z, y)`.
- **Element DOFs (12):** `[ux1,uy1,uz1,rx1,ry1,rz1, ux2,…]`. `releases` = array of
  12 (1 = released).
- **No institutional branding.** Branding is **configuration**
  (`branding.default.json`), not code. Do not reintroduce logos, "teaching material",
  university references, etc.
- **Build on top without forking:** upper layers (pluggable engines, white-label) use
  the extension seams (`js/solver/backend.js` and `js/ext/extensions.js`). Core
  **never** imports anything from an upper layer. See [`docs/EXTENDING.md`](docs/EXTENDING.md).
- **Open source honesty:** core only declares and exposes what its own JS solver
  actually runs. Do not leave methods, capability flags or UI items for analyses that
  core's JS cannot run.

### Internationalization (i18n)

Spanish is the source language (it lives in the DOM and in the JS strings). The i18n
engine (`js/i18n/`) translates on the fly. To translate:

- Dynamic JS strings: wrap them in `i18n.t('texto en español')`.
- Dynamically created DOM subtrees: call `i18n.translate(root)`.
- Add the Spanish→target pair to the corresponding dictionary
  (`js/i18n/dict.en.js` for English).

---

## 6. Git

- **Branch naming:** `<type>/<short-kebab-description>`, where `<type>` is one of
  `feat`, `fix`, `docs`, `refactor`, `test`, `chore` (also `perf`, `ci`). Examples:
  `fix/dkt-rotation-convention`, `feat/seismic-mass-source`, `docs/branch-naming`.
  One branch per change; never work directly on `main`.
- Commits in **English**, clear, in imperative or descriptive form.
- Do **not** use `git add -A` blindly: `excel/`, `referencias/` and `node_modules/`
  are **not** versioned.

---

## 7. Reporting bugs and proposing ideas

- **Bugs:** open an *issue* describing what you expected, what happened, and how to
  reproduce it. If you can, attach the minimal `.s3d` that triggers the problem.
- **Security vulnerabilities:** do **not** open a public issue. Follow
  [`SECURITY.md`](SECURITY.md).
- **Ideas and discussions:** open a *discussion*-type issue or comment on the
  [`ROADMAP`](docs/ROADMAP.md).

---

## 8. License of your contributions

By contributing, you agree that your contribution is distributed under the **AGPL-3.0**,
the same license as the project. See [`LICENSE`](LICENSE).
