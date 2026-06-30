# Verification — Railway network arch (Brunn & Schanack, TU Dresden)

**English** · [Español](verif_network_arch_bs.es.md)

**Verified capability:** modal analysis of a **network arch** (crossed inclined hangers) against a published thesis.
**Reference:** Brunn, B. & Schanack, F. (2003), *Calculation of a double track railway network arch bridge applying the European standards*, Diploma Thesis, TU Dresden.
**PORTICO model:** [`examples/verif_network_arch_bs.s3d`](../../examples/verif_network_arch_bs.s3d)

## Problem description

**Double-track railway** bridge of the **network arch** type (an arch with inclined hangers
that cross several times), of **100 m span** and **17 m rise** (f/s = 0.17). The thesis
analyzes it per the European standards and reports, for the EN1991-3 dynamic check, a **first
bending frequency n₀ = 2.34 Hz** under permanent loads.

| Property | Value (thesis) |
| --- | --- |
| Span | 100 m |
| Rise | 17 m (f/s=0.17) |
| Hangers per plane | 44 (inclined, crossed = network) |
| Arch | W 360×410×990 (≈ W14×665), steel |
| Bottom chord (tie) | C50/60 concrete slab, arches at 10.15 m |
| Dead load g_k | 125 kN/m (deck 62 + track 52.5 + arch 10.4) |
| 1st bending frequency n₀ | 2.34 Hz |

## PORTICO model

- **2D single-plane** arch model: the vertical bending mode of the two planes is equivalent to a single plane with **half the mass and half the stiffness** → same frequency.
- **Circular arch** (R = 82.0 m) discretized into 22 panels; **36 inclined crossed hangers** (network) between arch and tie; **tie** = bottom chord (slab) with the dead mass distributed as nodal mass (g_k/2 per plane).
- **Modal analysis** by subspace iteration; the first mode whose SHAPE is vertical-dominant (bending) is taken.

![Bending mode of the network arch](img/verif_network_arch_bs.svg)

*Figure 1. First vertical bending mode of the network arch (×scale). The dense net of crossed hangers stiffens the system (near beam-like behavior).*

## Results — comparison

| Quantity | Thesis (Brunn & Schanack) | PORTICO | diff. |
| --- | --- | --- | --- |
| 1st bending frequency [Hz] | 2.34 | 2.53 | +8.0 % |

**EN1991-3 admissible window** for L=100 m: 1.54 Hz < n₀ < 3.02 Hz. PORTICO's value (2.53 Hz)
falls **within** the window, just like the thesis.

## Conclusion

PORTICO's network-arch model reproduces the **first bending frequency** of the Brunn & Schanack
thesis railway bridge with a difference of **8.0 %** (2.53 Hz vs 2.34 Hz). The dense **net of
crossed hangers** is captured correctly and stiffens the system, giving a natural frequency in
the range of a 100 m network arch. *(Residual differences from: 2D single-plane model,
idealized slab tie, distributed dead mass and discretization; the thesis uses a detailed 3D FEM
with transverse prestressing and the optimized hanger arrangement.)* **Modal analysis of
network arches verified against a published reference.**
