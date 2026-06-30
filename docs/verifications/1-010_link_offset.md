# Verification 1-010 — Rigid link (offset) — eccentric deck over a pier

**English** · [Español](1-010_link_offset.es.md)

**Verified capability:** links/couplings: rigid kinematic constraint with an arm (offset) that transmits force + moment between nodes with no intermediate element.
**Reference:** end-offset / insertion-point modeling (CSI *Software Verification*, 1-010/1-011); equilibrium of the eccentric load (elementary statics).
**PORTICO model:** [`examples/verif_1-010_link_offset.s3d`](../../examples/verif_1-010_link_offset.s3d)

## Problem description

Vertical 5 m pier fixed at the base. The **deck** axis (node 3) is offset **e = 2 m** from
the pier axis and is tied to the pier top (node 2) with a **RIGID LINK** (follows the master
as a solid body, with an arm). A vertical load **P = 100 kN** applied at the deck reaches the
pier as **P plus a moment M = P·e** (eccentric load): the typical bridge pattern, with the
deck modeled above and coupled to the girders/piers.

| Property | Value |
| --- | --- |
| Pier | vertical, H = 5 m, fixed at the base |
| Deck offset | e = 2 m (in X) |
| Load | P = 100 kN vertical (↓) at the deck |
| E·I | E=2·10⁸ kPa, I=10⁻⁴ m⁴ (shear-rigid) |
| Theoretical base moment | M = P·e = 200 kN·m |
| Theoretical lateral drift | ux = M·H²/(2EI) = 0.125 m |

## PORTICO model

- The deck node has **no** element of its own: it is tied to the pier top by the **rigid link** (`model.links`), which transmits all 6 DOF with the arm (penalty, like diaphragms).
- The eccentric vertical load is automatically converted into **axial + moment** in the pier thanks to the link arm.
- Verified equivalent to applying **Fz + My = P·e** directly at the top (`test_links.mjs`).

![Pier deformed under the eccentric deck load (×scale): the moment P·e bends the pier laterally.](img/1-010_link_offset.svg)

*Figure 1. Pier deformed under the eccentric deck load (×scale): the moment P·e bends the pier laterally.*

## Results — comparison

Base fixed-end moment and tip lateral drift, compared with the elementary statics of the
eccentric load.

| Quantity | Description | Independent (—) | SAP2000 (—) | diff. SAP | **PORTICO (—)** | **diff. PORTICO** |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Base moment, node 1 · |My| [kN·m] = P·e | 200.0000 | 200.0000 | 0 % | **200.0000** | **0 %** |
| 2 | Tip lateral drift, node 2 · |ux| [m] | 0.1250 | 0.1250 | 0 % | **0.1250** | **0 %** |

### Why it matters for bridges

A bridge deck is modeled on its own axis (higher than the girders/piers) and **coupled** to
them with rigid links that respect the arm. This way a load on the deck generates the correct
**eccentricity moment** in the girders and piers — impossible to capture if everything is
collapsed onto a single axis. The same mechanism serves *end offsets* (1-010), *insertion
points* (1-011) and eccentric supports.

Also verified in `test_links.mjs`: the link reproduces exactly the equivalent Fz+My load,
satisfies the rigid kinematics (uz_deck = uz_pier − θy·e), the simple coupling equates a
chosen DOF, and everything survives the `.s3d` round-trip.

## Conclusion

The rigid link transmits the eccentric deck load to the pier as **P + M = P·e** with **0.0 %**
error (base moment 200 kN·m, lateral drift 0.125 m), identical to elementary statics and to
the equivalent model with direct Fz+My. **Links/couplings capability verified** — it enables
realistic modeling of bridge decks over girders and piers.
