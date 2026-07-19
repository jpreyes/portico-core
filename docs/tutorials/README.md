# portico-core — Tutorials

Step-by-step, hands-on walkthroughs. Each builds a real model, runs the analysis in the viewer, and
shows the final state at every step. Available in English and Spanish; each compiles to a PDF
(regenerate with `tools/md2pdf.mjs`).

| # | Tutorial | Topic |
| --- | --- | --- |
| 1 | [3-storey building in Valdivia (NCh433)](01-valdivia-nch433.md) · [ES](01-valdivia-nch433.es.md) | RC building — shell stair core, plate slabs, frames; modal, NCh433 spectrum (soil D), ACI design, drift |
| 2 | [Pushover to collapse](02-pushover-collapse.md) · [ES](02-pushover-collapse.es.md) | 5-storey steel moment frame — event-to-event plastic hinges to a beam-sway collapse mechanism |
| 3 | [Performance-based assessment](03-performance-based.md) · [ES](03-performance-based.es.md) | Target displacement (ASCE 41 coefficient method) and performance level (IO/LS/CP) on the capacity curve |

The models live in [`examples/`](../../examples/) and are reproducible with the builders in
[`tools/examples/`](../../tools/examples/). See also the
[Analysis Reference Manual](../analysis-reference.md) (theory) and the
[Verification Manual](../verification-manual.md) (engine validation).
