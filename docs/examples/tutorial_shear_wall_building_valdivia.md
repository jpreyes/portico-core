# Tutorial 2 — 5-story concrete SHEAR-WALL building in Valdivia (walls = membrane, slabs = plate)

**English** · [Español](tutorial_shear_wall_building_valdivia.es.md)

**Type:** modeling tutorial with **area elements** · **Model:** [`examples/tutorial_shear_wall_building_valdivia.s3d`](../../examples/tutorial_shear_wall_building_valdivia.s3d)
**Codes:** NCh433 + DS61 (seismic), NCh1537 (loads).

> ⚠️ Educational tutorial. Confirm zone/soil for the site (Valdivia: soft soils; see the frames
> tutorial). Walls modeled **without openings** (doors/windows) for simplicity.

## 1. Goal

A variant of the Valdivia building solved with **shear walls** instead of frames: the **walls** are
modeled with **MEMBRANE/shell elements** (in-plane stiffness = shear + axial) and the **floor slabs**
with **PLATE/shell elements** (bending + diaphragm action). It illustrates the use of area elements
for wall structures.

## 2. Geometry and model

- **18×15 m** plan, **5 stories** of 3 m. Walls on the **perimeter** (4 faces), a slab on each story.
- **Walls** (110 shell panels, t=0.25 m): vertical panels between levels → in-plane **shear**
  stiffness.
- **Slabs** (150 shell panels, t=0.2 m): horizontal mesh per story → vertical **bending** + in-plane
  **diaphragm**.
- Base: the wall starter nodes are **fixed**. Model: **232 nodes**, **260 area elements**.

![Shear-wall building and first mode](img/tutorial_shear_wall_building_valdivia.svg)

*Figure. Shear-wall building (panels) and its **first mode** (×scale).*

## 3. Materials, loads and mass

- Concrete H30 (E=2.57·10⁷ kPa). Thicknesses: walls 0.25 m, slabs 0.2 m.
- **Seismic mass:** self-weight of walls and slabs (the areas contribute ρ·t·A to the modal
  automatically) **plus** the live load (D_sup + 0.25·L) = (3.0+0.25·2.0) kN/m² applied as **nodal
  mass** by tributary area (additional total 1514 ton).

## 4. Modal analysis (PORTICO, with area elements)

| Mode | T [s] | f [Hz] | % mass X | % mass Y |
| --- | --- | --- | --- | --- |
| 1 | 0.086 | 11.66 | 0.0 | 83.7 |
| 2 | 0.077 | 13.04 | 84.3 | 0.0 |
| 3 | 0.043 | 23.52 | 0.0 | 0.0 |
| 4 | 0.028 | 35.11 | 0.0 | 12.4 |
| 5 | 0.026 | 39.06 | 11.9 | 0.0 |
| 6 | 0.017 | 59.71 | 0.0 | 2.9 |

**Fundamental period T₁ = 0.086 s.** A shear-wall building is **much stiffer** than the frame one
(shorter period) → higher spectral acceleration but smaller drifts.

## 5. NCh433/DS61 design spectrum (Zone 2, Soil D)

$$ S_a(T)=\frac{S\,A_0\,\alpha(T)}{R^*} $$

| T [s] | Sa(T) [g] |
| --- | --- |
| 0.100 | 0.262 |
| 0.200 | 0.247 |
| 0.086 | 0.267 |
| 0.500 | 0.216 |

For T₁ = 0.077 s → **Sa = 0.271 g** (design spectrum with R*=1.94).

## 6. Design comments

- The **walls** concentrate the lateral stiffness; the **slab-diaphragms** distribute the seismic
  force among walls. Check the **von Mises stresses** in the walls (PORTICO's area post-processing)
  and the **shear** at the base of each wall.
- In PORTICO the area stress contour and each element's panel give membrane/surface σ; the NCh3171
  combinations and the `.docx` report document the design.

## 7. Conclusion

The **walls (membrane) + slabs (plate)** building is modeled as a set of area elements; the modal
gives T₁ = 0.086 s (much stiffer than the frame one, T₁≈0.65 s) and the NCh433/DS61 spectrum gives
the demand. It demonstrates the use of **area elements for shear walls and floor slabs** in PORTICO.
*(Model without openings; the real analysis includes openings, wall coupling and stress
verification.)*
