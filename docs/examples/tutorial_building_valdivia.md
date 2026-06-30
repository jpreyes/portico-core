# Tutorial — 5-story reinforced-concrete building in Valdivia

**English** · [Español](tutorial_building_valdivia.es.md)

**Type:** step-by-step tutorial (modeling + seismic analysis in PORTICO).
**Model:** [`examples/tutorial_building_valdivia.s3d`](../../examples/tutorial_building_valdivia.s3d)
**Codes:** NCh433 (seismic design) + DS61, NCh1537 (loads), NCh3171 (combinations).

> ⚠️ **Educational tutorial.** The seismic-zone and soil-type values must be confirmed for the
> exact site and municipality per the current version of NCh433 (there is an **NCh433:2026**
> update). Valdivia has **soft soils** (fluvial deposits; the 1960 earthquake produced
> subsidence/liquefaction): the soil type is defined by the project's **soil mechanics**; parts of
> the city can be **D, E or even F (special study)**.

## 1. Goal and scope

Model and seismically analyze a **5-story reinforced-concrete building** (space frames with rigid
slabs) located in **Valdivia**, illustrating the full flow in PORTICO: geometry →
materials/sections → loads → seismic masses → diaphragms → **modal** → **response spectrum**
(NCh433/DS61) → base shears → drifts → design.

## 2. Site background (Valdivia)

| Parameter | Value | Source |
| --- | --- | --- |
| Seismic zone | Zone 2 | NCh433 (zoning by municipality) |
| Effective acceleration A₀ | 0.30·g | NCh433 (Zone 2) |
| Soil type (assumed) | D | soil mechanics (confirm; Valdivia is usually D/E/F) |
| Category / importance I | II / I=1.0 | NCh433 (residential-office) |
| R / R₀ | 7 / 11 | NCh433 Table 5.1 (RC) |

## 3. Geometry and model in PORTICO

- **3×3 bay** plan (6 m in X, 5 m in Y → 18×15 m), **5 stories** of **3.0 m** (total height 15.0 m).
  The **rectangular** plan separates the X and Y periods (clean modes).
- **Step by step in PORTICO:** (1) create the grid (axes every 6 m in X and 5 m in Y, levels every
  3.0 m); (2) **Element** mode → vertical columns and beams in X and Y per story (the magnet reuses
  nodes); (3) **Support** mode → fix the 16 base nodes; (4) Analysis → **auto-detect diaphragms**
  (creates a rigid diaphragm per story at its center of rigidity).
- The resulting model: **96 nodes**, **200 elements**, **5 diaphragms**.

![Building and first mode](img/tutorial_building_valdivia.svg)

*Figure. 3D frame of the building and its **first mode** of vibration (×scale).*

## 4. Materials and sections

| Element | Section | Properties |
| --- | --- | --- |
| Material | Concrete H30 | E = 4700√f'c = 2.57·10⁷ kPa, ν=0.2 |
| Columns | 50×50 cm | A=0.25 m², I=5.21·10⁻³ m⁴ |
| Beams | 30×60 cm | A=0.18 m², I_z=5.40·10⁻³ m⁴ |

*In PORTICO you can apply **stiffness modifiers** (ACI cracked section: beams 0.35·Ig, columns
0.70·Ig) in `sec.mod`.*

## 5. Loads and seismic mass (NCh1537 / NCh433)

- Dead load **D = 6.0 kN/m²** (slab + finishes + partitions), live load **L = 2.0 kN/m²**.
- **Seismic weight** per story = (D + 0.25·L)·A = (6.0+0.25·2.0)·270 = **1755 kN** → mass **178.9
  ton/story**.
- **Total seismic weight P = 8775 kN**. The mass is assigned to each story's **diaphragm** (PORTICO
  distributes it by tributary area and assembles the rotational inertia).

## 6. NCh433 + DS61 design spectrum

Soil **D** parameters (DS61): S=1.20, T₀=0.75 s, T'=0.85 s, n=1.80, p=1.0.

$$ S_a(T) = \frac{S\,A_0\,\alpha(T)}{R^*},\quad \alpha(T)=\frac{1+4.5(T/T_0)^p}{1+(T/T_0)^3},\quad R^*=1+\frac{T}{0.10\,T_0 + T/R_0} $$

| T [s] | α(T) | R*(T) | Sa(T) [g] |
| --- | --- | --- | --- |
| 0.2 | 2.16 | 3.15 | 0.247 |
| 0.5 | 3.09 | 5.15 | 0.216 |
| 1.0 | 2.08 | 7.03 | 0.106 |
| 1.5 | 1.11 | 8.10 | 0.049 |
| 2.0 | 0.65 | 8.79 | 0.027 |

## 7. Modal analysis (PORTICO results)

Run with **subspace iteration** (6 modes). Periods and mass participation:

| Mode | T [s] | f [Hz] | % mass X | % mass Y |
| --- | --- | --- | --- | --- |
| 1 | 0.648 | 1.54 | 81.5 | 0.4 |
| 2 | 0.620 | 1.61 | 0.4 | 81.8 |
| 3 | 0.543 | 1.84 | 0.0 | 0.0 |
| 4 | 0.204 | 4.90 | 10.4 | 0.1 |
| 5 | 0.197 | 5.09 | 0.1 | 10.4 |
| 6 | 0.172 | 5.80 | 0.0 | 0.0 |

**Fundamental period T₁ = 0.648 s.** Dominant mode in X: mode 1 (T = 0.648 s, 81.5 % of mass).

## 8. Seismic analysis — base shear

| Quantity | Value | Comment |
| --- | --- | --- |
| Design Sa(T₁) | 0.183 g | DS61 spectrum at the dominant mode |
| Spectral base shear Q (≈ dom. mode) | 1607 kN | Sa·P (dominant-mode estimate) |
| Static seismic coefficient C | 0.230 | 2.75·A₀·S/R·(T'/T*)ⁿ capped |
| Static base shear Q₀ | 2021 kN | C·I·P |
| Minimum base shear | 527 kN | A₀·S/6·I·P (NCh433 lower bound) |

> The real **response-spectrum** analysis (**CQC** combination of all modes) is run in PORTICO from
> the Analysis Center (X/Y spectral case); the modal base shear is **scaled to the NCh433 minimum**
> if it comes out lower. The table above uses the dominant mode as a reference.

## 9. Story drifts

NCh433 limits the **story drift** to **0.002·h** (between centers of mass, with displacements from
the analysis ×R₀ or per the method). Estimate with the dominant mode:

| Quantity | Value |
| --- | --- |
| Spectral displacement Sd (dom. mode) | 19.1 mm |
| Roof displacement (approx.) | 24.4 mm |
| Mean story drift (approx.) | 1.62 ‰ (limit 2 ‰ = 0.002) |

*Dominant-mode estimate; the formal check uses the per-story drifts from the (CQC) spectral analysis
in PORTICO.*

## 10. Combinations and design

- **NCh3171/ASCE-7** combinations (PORTICO creates them automatically): 1.4D; 1.2D+1.6L;
  1.2D+L±1.4E_x; 1.2D+L±1.4E_y; 0.9D±1.4E. Optional ASD set.
- With the per-combination forces, PORTICO's **design table** gives D/C per element; the
  **calculation report** (.docx) documents the basis, modal, shears, drifts and design.

## 11. Conclusion and limitations

The 5-story building is modeled as a **space RC frame with rigid diaphragms**; the modal gives
T₁ = 0.648 s and consistent participations, and the NCh433/DS61 spectrum (Zone 2, Soil D) gives the
design base shears and drifts. **Limitations:** the zone/soil values must be confirmed for the site
(Valdivia: soft soils, possibly D/E/F with a special study); the drifts and shear shown are
dominant-mode estimates — the final check uses the **CQC response spectrum** and the combinations in
PORTICO.
