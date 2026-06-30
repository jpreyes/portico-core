# Advanced analyses — quick guide (what it does, how to run it, example)

**English** · [Español](analisis-avanzados.es.md)

Index of PORTICO's analyses beyond the static one. For each: **what it does**, **minimal
theory**, **how to run it** and a **characteristic example**. Those with their own document are
linked. All are launched from **Analysis** (menu or Analysis Center); the heavy ones run in
**Web Workers** and do not freeze the UI.

> Conventions: Z up (like SAP2000/ETABS). DOF per node `[ux,uy,uz,rx,ry,rz]`. Reusable results
> (✓ badge and **View** button).

---

## Linear

### Modal (frequencies and mode shapes)
- **What**: solves `(K − ω²M)φ = 0` → periods `T = 2π/ω`, mode shapes and **participating modal
  masses** per direction.
- **How**: Analysis → Modal. Choose the number of modes and the method (Bathe **subspace
  iteration**, recommended, or Stodola). Option to **include Kg (P-Δ)** for pre-stress.
- **Example**: building with rigid diaphragms → T₁ and % mass of the fundamental mode.

### Response spectrum (NCh433 / DS61, etc.)
- **What**: probable maximum response combining modes (CQC/SRSS) under a design **spectrum**;
  gives base shears, drifts and envelope forces.
- **How**: Analysis → Spectrum (requires modal). Define the curve (zone/soil) and the direction.
  Inherits the discretization from the modal.
- **Example**: Zone 2 / Soil D building → modal vs static vs minimum base shear.

### Linear time-history (modal, Duhamel)
- **What**: response **in time** to a base accelerogram, by **modal superposition** with the
  **Duhamel** integral (exact Nigam–Jennings recurrence). Monitor a **node** (u/θ), an
  **element** (N/V/M) or an **area** (von Mises σ(t) and components).
- **How**: Analysis → Time-history. Direction X/Y/Z, ζ, number of modes and accelerogram
  (synthetic demo or paste/load a record). Overlay with history + animation + CSV.
- **Example**: frame with diaphragms → roof u(t); shell wall → σ(t) of a panel.

### Linear buckling (λcr) → [`pandeo.md`](pandeo.md)
- Critical load factors and buckling modes, `(K + λKg)φ = 0` by subspace.

---

## Nonlinear (NL-lite)

### P-Delta (second order)
- **What**: amplification by the **geometric stiffness** of the load state (compression
  softens). `(K + Kg)·u = F` iterated.
- **How**: Analysis → NL-lite → P-Delta. Define loads; optional imperfection.
- **Example**: cantilever with `P/Pcr ≈ 0.27` → amplification ≈ 1.37 (≡ theory).

### Nonlinear — cables / tension-only / compression-only
- **What**: corotational Newton with **cable** (tension), **strut** (compression) elements and
  large displacements.
- **How**: Analysis → NL-lite → Nonlinear. Do **not** use auto-disc on trusses.
- **Example**: prestressed cable net; compression-only strut-arch.

### Plastic hinges / pushover → [`pushover.md`](pushover.md)
- **What**: incremental formation of **hinges** (ductile / with drop / brittle) in N/V/M, λ–δ
  curve and collapse sequence; pushover by load or displacement control.
- **How**: Analysis → NL-lite → Plastic hinges (or Pushover-DC). Choose Mp/Np/Vp, behavior and
  load pattern (case/combo).
- **Example**: 2D portal → 4 hinges, mechanism at λc.

### Form-finding (FDM) → [`form-finding.md`](form-finding.md)
- Equilibrium geometry of cable/funicular networks by force densities.

### NONLINEAR time-history (hinges, direct integration)
- **What**: direct integration **Newmark-β + Newton** with hysteretic hinges (bilinear,
  kinematic hardening) and Rayleigh damping. Today it reduces to an editable **shear building**;
  the full model with per-bar-end hinges is a future feature.
- **How**: Analysis → NL-lite → NL Time-history. Editable story table, dir X/Y, ζ, hardening α,
  accelerogram. Overlay with history + animated "stick" diagram.

---

## For bridges (specific engines)

- **Construction stages**: incremental phased analysis (activate elements/supports, accumulate
  state) — each segment is "born" stress-free. Analysis → Bridges → Stages.
- **Tendon prestressing**: parabolic/polygonal profile, friction/wobble losses → equivalent
  balancing loads. Analysis → Bridges → Tendon.
- **Moving loads / influence lines**: load sweep or multi-axle train, force/reaction envelopes.
  Analysis → Bridges → Moving loads.

---

## Design and verification

- **Multi-code design** (AISC 360, EC3, ACI 318/EC2, NCh1198, EC9 aluminum): the **Design** tab
  → D/C per element, pre-sizing, auto-design from a catalog, **CSV report** and **strong-column–
  weak-beam joints**. See [`design.md`](design.md).
- **Documented verifications**: cases against analytical solutions / published references in the
  [verification list](README.md#verifications).
- **Program capabilities** (complete/partial/missing): [`capabilities.md`](capabilities.md).
- **Public API** (Node + browser): [`api.md`](api.md).

---

## General tips

- Run the **static** analysis first; many analyses (spectrum, P-Delta, buckling, design) start
  from its state or need it as a reference.
- **Auto-disc.** improves deformed shapes and diagrams on bending bars; do **not** use it on
  pure trusses (interior nodes without transverse stiffness → mechanism).
- If an analysis fails due to **singular/mechanism**, use **Diagnose stability** (highlights the
  DOF without stiffness).
