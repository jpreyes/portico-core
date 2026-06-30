# Verification 1-009 — Prestressing by a parabolic tendon — load balancing

**English** · [Español](1-009_tendon_prestress.es.md)

**Verified capability:** prestressing by tendons with a parabolic profile → equivalent loads (load balancing) and prestress axial.
**Reference:** equivalent-load / load-balancing method (T.Y. Lin, *Design of Prestressed Concrete Structures*); simply-supported beam solution.
**PORTICO model:** [`examples/verif_1-009_prestress.s3d`](../../examples/verif_1-009_prestress.s3d)

## Problem description

Simply-supported 20 m beam (4 elements) with a **parabolic tendon** of effective force
P = 2000 kN and a **sag a = 0.4 m** at midspan (anchored at the centroid at the ends). By
the **equivalent-load** method, the tendon exerts on the concrete a uniform **upward** load
w = 8·P·a/L² = **16 kN/m** and a **uniform axial compression** P. The midspan **camber**
(5wL⁴/384EI) and the prestress **axial** are verified.

| Property | Value |
| --- | --- |
| Span | L = 20 m (4 × 5 m) |
| Tendon force | P = 2000 kN (effective) |
| Profile | parabola, sag a = 0.4 m (e=0 at anchors) |
| E | 3.0·10⁷ kN/m² |
| I | 0.1 m⁴ |
| Equivalent load | w = 8Pa/L² = 16 kN/m (↑) |

## PORTICO model

- **2D** model, simple beam (pinned + roller); self-weight disabled to isolate the prestress.
- The tendon is translated into **equivalent loads** (upward UDL + anchor axial) with `tendonEquivalentLoads`, which the linear static solver handles normally.
- The **camber** (upward) confirms the sign and magnitude of the equivalent load; the **axial** confirms the uniform prestress compression.

![Deformed shape under prestress only (×scale): the beam arches UPWARD (camber), the characteristic effect of a parabolic tendon.](img/1-009_tendon_prestress.svg)

*Figure 1. Deformed shape under prestress only (×scale): the beam arches UPWARD (camber), the characteristic effect of a parabolic tendon.*

## Results — comparison

Prestress acting alone (no external load). Midspan camber and first-element axial.

| Quantity | Description | Independent (—) | SAP2000 (—) | diff. SAP | **PORTICO (—)** | **diff. PORTICO** |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Midspan camber, node 3 · U_z [m] (↑) | 0.01111 | 0.01111 | 0 % | **0.01111** | **+0.01 %** |
| 2 | Prestress axial, elem 1 · N [kN] (− = compression) | -2000.00000 | -2000.00000 | 0 % | **-2000.00000** | **0 %** |

### Load balancing

The essence of the method: if a **downward** external load of 16 kN/m (equal to the
tendon's equivalent) is added, the beam's net deflection is **≈ 0** — the prestress exactly
"balances" the load, leaving only a uniform axial compression. This property is verified in
`test_tendon.mjs` (net deflection < 10⁻⁴·camber).

**Analytical verification:** w = 8Pa/L² = 8·2000·0.4/20² = **16 kN/m**; camber =
5wL⁴/(384EI) = 5·16·20⁴/(384·3·10⁶) = **0.01111 m**; axial = **−P = −2000 kN** (no
horizontal reaction, self-equilibrated prestress).

## Conclusion

The prestressing module reproduces, with **0.0 %** error, the midspan camber (0.01111 m
upward) and the prestress axial (−2000 kN) of the equivalent-load method. **Load balancing**
is confirmed (zero net deflection when the equivalent external load is added). **Tendon
prestressing capability (#60) verified.**
