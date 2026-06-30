# Security policy

**English** · [Español](SECURITY.es.md)

## Supported versions

Security support is provided for the **latest published minor version**. As this is a
young project, we recommend always using the most recent version of `main` or the
latest release.

| Version | Supported           |
|---------|---------------------|
| 0.1.x   | ✅ Yes              |
| < 0.1   | ❌ No (pre-release) |

## Reporting a vulnerability

**Do not open a public issue** for security vulnerabilities.

Report it privately through one of these channels:

- **Email:** jpreyes.c@gmail.com (subject: `[SECURITY] portico-core`)
- **GitHub:** *Security → Report a vulnerability* tab (private security advisories),
  if enabled on the repository.

Please include, where possible:

- A description of the problem and its impact.
- Steps to reproduce (and a minimal `.s3d`/CSV/IFC if applicable).
- Affected version and browser/OS.

**Indicative timelines:** acknowledgement within **72 hours** and an initial assessment
within **7 days**. We will coordinate responsible disclosure with you once a fix exists.

## Threat model

portico-core is a **client-side application** that runs entirely in the browser. The
open edition **has no backend of its own**: there is no server processing user data in
core (`serve.py` is only a static development server). This narrows the attack surface,
but there are relevant vectors to keep in mind:

- **Opening untrusted files** (`.s3d`, CSV, IFC): a malicious model could try to inject
  content (e.g. node/material/section/load-case/diaphragm names) that gets rendered into
  the DOM (stored XSS). The code must **escape** any data coming from files before
  inserting it as HTML. The single escaping entry point is **`js/utils/escape.js`**
  (`esc` / `escapeHtml`, which also escapes `"` for use inside `title="…"`/`value="…"`
  attributes): import it and wrap any model data interpolated into
  `innerHTML`/template-literals with `esc(...)`. Do not redefine inline escape helpers.
  `test_xss_escape.mjs` covers this guarantee.
- **Service Worker** (`sw.js`): caches the app's resources. A compromised SW could serve
  stale or malicious content; that is why it is *network-first* and versioned.
- **Third-party dependencies** (Three.js, numeric.js): loaded via importmap. It is
  advisable to pin versions and, ideally, verify integrity (SRI) when served from a CDN.

### Out of scope

- The **heavy engine (Nodex, C++/WASM)** and the **Pro layer** are not part of this
  repo; their security is managed separately.
- The **accuracy of engineering results** is not a security issue: results are
  indicative and require review by a qualified structural engineer (see the notice in
  the `README`). Calculation errors are reported as normal *issues* with a verification
  case.

## Disclosure

We practice **coordinated disclosure**: we will ask you not to make the details public
until a fix is available, and we will credit you in the security advisory if you wish.
