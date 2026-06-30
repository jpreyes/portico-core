# README / docs images

These assets are referenced by name from the [README](../../README.md) (already wired in):

| File | Content | Used in |
|---|---|---|
| `portico-hero.gif` | Short GIF: model → analyze → view deflected shape / forces | README hero |
| `screenshot-viewport.png` | 3D viewer with a model and results (deflected shape or forces) | "Screenshots" table |
| `screenshot-section.png` | Section calculator with a **prestressed beam** (bridge I-section) | "Screenshots" table |
| `screenshot-design.png` | **Design** panel with per-element D/C ratios | "Screenshots" table |

**Capture in English:** open the app (`python serve.py`), use the **language selector** (top right)
→ *English*, then capture. The code is bilingual even if the deployed demo is in Spanish.

**GIF (Windows):** [ScreenToGif](https://www.screentogif.com/) (free). On macOS: screen recording →
convert. Keep the hero **under ~3–4 MB** and ~1000 px wide so it does not bloat the repo history or
slow down the README — optimize with [gifsicle](https://www.lcdf.org/gifsicle/)
(`gifsicle -O3 --colors 128 --lossy=80 --resize-width 960 in.gif -o out.gif`) or
[ezgif.com](https://ezgif.com/optimize). Optimize large PNGs with [pngquant](https://pngquant.org/)
or [tinypng.com](https://tinypng.com/).
