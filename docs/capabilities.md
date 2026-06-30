# PORTICO capabilities

**English** · [Español](capabilities.es.md)

An honest map of **what PORTICO does**, what it does **partially**, and what is **out of
scope** for the open-source core. Many capabilities are checked against analytical solutions
or the CSI/SAP2000 verification suite (see the
[verification list](README.md#verifications)).

Status: ✅ complete · 🟡 partial · ⛔ out of core scope.

---

## ✅ Complete capabilities

**Frame analysis**
- **Linear static** of 3D frames: **Timoshenko** bar/beam/column (bending + shear + axial +
  torsion). *(Verif. 1-018, 0.00 %.)*
- **Loads:** nodal, uniform and **trapezoidal** distributed, **thermal** and self-weight;
  projection with rotated local axes.
- **End releases** (hinges), **end spring** (partial fixity), **rigid end zones / end
  offsets**, **rigid links / couplings** with an arm. *(Verif. 1-010.)*
- **Nodal springs**, **elastic line foundation** (Winkler) and **rigid diaphragm** (floor mass
  and center of rigidity).
- **Prescribed displacement / support settlement.** *(Verif. 1-005.)*
- **Tension-only (cable)** and **compression-only (strut)** members. *(Verif. 1-012.)*

**Dynamics**
- **Modal** (Bathe subspace iteration or Stodola): periods, mode shapes, participating mass.
  *(Verif. 1-014, 1-021.)*
- **Modal with geometric stiffness Kg** (pre-stress / taut string). *(Verif. 1-017.)*
- **Response spectrum** (CQC / SRSS).
- **Linear modal time-history** (Duhamel / Nigam-Jennings) and **nonlinear time-history**
  (shear building with hinges).

**Nonlinear (NL-lite)**
- **P-Delta**, **linear buckling** of bars and shells (K+λKg eigenvalues). *(Verif. buckling.)*
- **Cables** (tension-only) and **tendon prestressing** (load balancing). *(Verif. 1-009.)*
- **Corotational beam** (large rotation with bending), **form-finding** (force densities),
  **plastic hinges / pushover** (load and displacement control).

**Processes**
- **Construction stages** (element/support activation, state accumulation). *(Verif. 1-031.)*
- **Moving loads / influence lines** and envelopes. *(Verif. 1-030.)*

**Area elements**
- **CST / QUAD** membrane in **plane stress** and **plane strain**. *(Verif. 3-002, 3-004.)*
- **Allman** triangle with drilling DOF. *(Verif. 3-006.)*
- **MITC4 / DKT** plate, **shell** (membrane + plate), von Mises stresses; **through-thickness
  thermal gradient**. *(Verif. 2-014.)*
- **Meshing**: transfinite (Coons) and **free** (ear-clipping + Delaunay + quad recombination).
  *(Verif. 3-001, 3-005.)*

**Design and verification**
- **Multi-code design:** steel (AISC 360 / EC3 / NCh), concrete (ACI 318 / EC2), timber
  (NCh1198) and aluminum (EC9): D/C ratios, auto-design from a catalog, reporting, **drift**
  checks and **strong-column–weak-beam (SCWB)** joints. *(Verif. 4-001.)*

**Interoperability**
- `.s3d` format (JSON), CSV import, **IFC/BIM** and an assistant to generate models from text;
  export to other engines (SAP2000, ETABS, OpenSees, SOFiSTiK, Abaqus).

---

## 🟡 Partial capabilities

| Topic | What there is | Limit |
|---|---|---|
| **Insertion / cardinal point** | eccentricity via a **rigid link** with an arm | no dedicated section "cardinal point" |
| **Displacement-control pushover** | idealizes a **truss** (axial) | for bending use the **plastic hinges** (load/δ control) |
| **Quasi-incompressible plane strain** (ν→0.5) | correct for ν ≤ 0.3 | **volumetric locking** of the standard QUAD (no B-bar) |

---

## ⛔ Out of the open-source core scope

- **Non-prismatic sections** (variation of A/I along the element).
- **Special LINK elements:** dampers (linear / nonlinear), isolators (rubber, friction
  pendulum), **gap** (compression-only) / **hook** (tension-only) as links, plastic Wen,
  frequency-dependent links.
- **Orthotropic materials.**
- **Area geometric nonlinearity** (large-displacement shells) and **area prestress**.
- **Pore pressure / hydromechanical coupling.**

> The high-performance **C++/WASM solver Nodex** and the advanced Pro design do not live in the
> open core: they plug into the private product **portico** through the `SolverBackend`
> interface (see [EXTENDING](EXTENDING.md)).

---

## Summary

PORTICO's open core solidly covers **static, modal, spectral and time-history** analysis
(linear and nonlinear), a broad **NL-lite** set (cables, corotational, hinges, pushover,
buckling, P-Δ, form-finding), **area elements** (membrane/plate/shell with an in-house mesher)
and **multi-code design**, all verified against analytical solutions and published references.
The gaps concentrate on **special elements** (links/isolators/dampers), **non-prismatic
sections**, **area nonlinearity** and **multiphysics coupling**.
