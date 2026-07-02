# Licensing — PORTICO

**English** · *(Spanish companion `LICENSING.es.md` available on request)*

PORTICO is **open-core** software. This page explains how it is licensed, what the
open-source license requires, and when you might need a **commercial license**.

> **Try it first:** an academic build runs live at
> **https://portico.jpreyes-c.workers.dev** — no install, runs entirely in your
> browser.

---

## 1. The two editions

| Edition | What it is | License |
|---|---|---|
| **`portico-core`** (this repository) | The reusable base: 3D viewer + model + pre/post-processing + I/O + the `SolverBackend` interface + the **JavaScript solver**. A complete, self-contained structural-analysis application. | **AGPL-3.0-or-later** (free / open source) |
| **PORTICO Pro** | `portico-core` plus the **Nodex** high-fidelity solver (C++/WASM), advanced multi-code design, hosted projects, reporting and support. | **Commercial** (proprietary) |

The open core is genuinely useful on its own. The Pro edition adds the heavy,
high-fidelity engine and the conveniences that firms pay for. The boundary between them
is the documented `SolverBackend` seam — no forks, no hidden crippling of the core.

---

## 2. Using `portico-core` under the AGPL

You are free to **use, study, modify, and share** `portico-core` under the
**GNU Affero General Public License v3.0 or later**. In plain terms, the AGPL lets you
do almost anything, on two conditions:

1. **Copyleft:** if you distribute the software or a modified version, you must make the
   complete corresponding **source code** available under the AGPL.
2. **Network clause (§13) — the key one for web apps:** if you run a **modified**
   version and let users interact with it **over a network** (e.g. you host your own
   changed copy as a web service), you must offer **those users** the complete
   corresponding source of your modified version.

Practical reading for typical use:

- **An engineer using the public app or self-hosting it unmodified** — nothing extra to
  do. (The app already links to this source from its "About" screen, which satisfies
  §13 for an unmodified deployment.)
- **A firm modifying the code for internal use only**, without offering it to outside
  users over a network — generally fine under the AGPL.
- **Anyone hosting a *modified* version for others**, or **embedding `portico-core`
  inside a product they distribute** — the AGPL's copyleft applies to the whole work.
  That is exactly where the commercial license comes in.

The full text is in [`LICENSE`](LICENSE) and at
https://www.gnu.org/licenses/agpl-3.0.html.

---

## 3. When you need a Commercial License

The AGPL is the right choice for open, source-available use. A **commercial license**
exists for situations where the AGPL's obligations don't fit your business. You likely
need one if you want to:

- **Embed or bundle `portico-core` inside a closed-source / proprietary product** and
  distribute it without releasing your own source under the AGPL.
- **Offer a modified, hosted version as a service** (SaaS) **without** disclosing your
  modifications under AGPL §13.
- **White-label** PORTICO as part of your own commercial offering.
- Obtain a **warranty, indemnification, or formal support / SLA** that open-source
  licenses explicitly disclaim.

A commercial license grants you the same code under negotiated terms that **waive the
AGPL copyleft and network obligations**, so you can keep your derivative work or service
proprietary.

> **Dual licensing, in one line:** the public gets `portico-core` under the AGPL; if the
> AGPL doesn't work for your product, we license the *same* code to you commercially.

---

## 4. Contributions

External contributions are welcome. Because PORTICO is dual-licensed, contributors sign
a lightweight **Contributor License Agreement** ([`CLA.md`](CLA.md)) so that
contributed code can be offered under both the AGPL and the commercial terms.
Contributors keep the copyright to their work — the CLA is a license grant, not an
assignment. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow.

---

## 5. FAQ

**Can I use `portico-core` for free in my engineering practice?**
Yes. Use it, self-host it, modify it for your own work — the AGPL covers all of that at
no cost.

**Can I sell engineering services using PORTICO?**
Yes. Using the tool to produce calculations and deliverables is not "distributing the
software". You owe nothing and disclose nothing.

**I want to host my own customized version for my clients. What applies?**
If your hosted version is modified, AGPL §13 requires you to offer your clients the
source of your modifications. If you'd rather keep them private, take a commercial
license.

**I'm building a closed-source product and want PORTICO inside it.**
That needs a commercial license — the AGPL would otherwise require your whole product to
be AGPL.

**Is the Nodex solver covered by the AGPL?**
No. Nodex is the proprietary engine of PORTICO Pro and is not part of this repository.
The AGPL applies to `portico-core` (the open base and its JavaScript solver).

**Is this legal advice?**
No. This page summarizes the licensing model in good faith; the binding terms are in the
[`LICENSE`](LICENSE) file and in any commercial agreement you sign. For your specific
situation, consult a lawyer.

---

## 6. Contact

For commercial licensing, OEM / white-label terms, or support agreements:

**JP Reyes** — `jpreyes.c@gmail.com`
Repository: https://github.com/jpreyes/portico-core

© 2026 JP Reyes and PORTICO contributors. "PORTICO" and "Nodex" are names used by the
project for its open and proprietary editions, respectively.
