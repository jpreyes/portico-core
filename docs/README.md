# PORTICO documentation

Documentation home for **portico-core**. Most documents are currently in Spanish and are
being translated to English; the UI is bilingual (ES/EN) and code comments are in English.

> ▶ **Live demo:** [portico.jpreyes-c.workers.dev](https://portico.jpreyes-c.workers.dev)
> · To run locally, see the main [README](../README.md).

---

## Getting started

- [Main README](../README.md) — what it is, how to open the app, coordinate convention.
- [PORTICO capabilities](capabilities.md) — overview of what can be modeled and analyzed.
- [Contributing guide](../CONTRIBUTING.md) · [Code of Conduct](../CODE_OF_CONDUCT.md)

## Analysis

- [Advanced analyses](analisis-avanzados.md) — modal, spectrum, P-Δ, nonlinear, time-history.
- [Linear buckling](pandeo.md)
- [Pushover (displacement control)](pushover.md)
- [Form-finding](form-finding.md)
- [Macro-models](macromodelos.md)

## Design

- [Multi-code design](design.md) — steel (AISC/EC3/NCh), concrete (ACI/EC2), timber, aluminum (EC9).

## For developers

- [API](api.md) — the headless `Portico` facade: pre-processing, solvers, post-processing, design.
- [Extending (Pro / white-label layers)](EXTENDING.md)
- [Roadmap](ROADMAP.md)

## Tutorials

- [Building (Valdivia)](examples/tutorial_building_valdivia.md)
- [Building with shear walls (Valdivia)](examples/tutorial_shear_wall_building_valdivia.md)

## Verifications

Each case compares PORTICO against an **analytical solution, a published reference, or
global equilibrium**. The `.s3d` models live in [`examples/`](../examples/) and appear in
the app under **Help (F1) → Guided Examples**.

| Case | Verified capability |
|------|---------------------|
| [1-005](verifications/1-005_support_settlement.md) | Support settlement (prescribed displacement) |
| [1-009](verifications/1-009_tendon_prestress.md) | Prestressing by a parabolic tendon (load balancing) |
| [1-010](verifications/1-010_link_offset.md) | Rigid link (offset) — eccentric deck |
| [1-012](verifications/1-012_no_tension_no_compression.md) | Cables and struts (tension-only / compression-only) |
| [1-014](verifications/1-014_modal_cantilever.md) | Modal — cantilever beam |
| [1-017](verifications/1-017_taut_string.md) | Modal with geometric stiffness — taut string |
| [1-018](verifications/1-018_static_portal.md) | Static — bending, shear and axial in a frame |
| [1-021](verifications/1-021_modal_bathe_wilson.md) | Modal — Bathe-Wilson frame (10×9) |
| [1-030](verifications/1-030_influence_lines.md) | Influence lines and moving load |
| [1-031](verifications/1-031_construction_stages.md) | Construction stages |
| [2-014](verifications/2-014_thermal_gradient_plate.md) | Thermal gradient through the thickness (plate) |
| [3-001](verifications/3-001_patch_test_mesh.md) | Patch test — distorted transfinite mesh |
| [3-002](verifications/3-002_plane_stress_beam.md) | Membrane in plane stress |
| [3-004](verifications/3-004_plane_strain_cylinder.md) | Plane strain — thick-walled cylinder |
| [3-005](verifications/3-005_free_mesh_L.md) | Free mesh of an L-shaped floor |
| [3-006](verifications/3-006_allman_cantilever.md) | Allman triangular membrane (drilling DOF) |
| [4-001](verifications/4-001_steel_design.md) | Steel design AISC 360-16 (LRFD) |
| [Network arch](verifications/verif_network_arch_bs.md) | Modal of a network arch (Brunn & Schanack) |
