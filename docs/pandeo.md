# Linear buckling (eigenvalues, critical factor λcr)

**English** · [Español](pandeo.es.md)

> Analysis → (NL-lite) → **Linear Buckling** (or the button in the Analysis Center).
> Computes the **critical load factors** λcr and the **buckling modes** of the
> structure under the current load pattern.

## 1. What it is and what it is for

Linear buckling (or *eigenvalue buckling*) estimates the **load at which the structure
becomes unstable** due to loss of geometric stiffness (the effect of compression). It
answers: *how many times can I scale the current loads before the structure buckles?*
That answer is the **critical factor λcr**:

```
P_critical = λcr · P_applied
```

- `λcr > 1` → the structure resists the current loads with margin `λcr`.
- `λcr ≤ 1` → it buckles **before** reaching the applied loads (review!).

It is used for columns, frames, arches and compressed trusses, and to estimate the
**effective buckling length** by comparing λcr with the Euler formula.

## 2. The formulation (what the program solves)

The generalized eigenvalue problem is posed

```
(K + λ · Kg) · φ = 0
```

where:

- **K** is the elastic stiffness (the same as the static one),
- **Kg** is the **geometric stiffness**, proportional to the **axial stress state**
  of the reference static analysis (compression *softens*, tension *stiffens*),
- **λ** are the critical load factors (the smaller `λcr` are the ones that matter),
- **φ** is the **buckling shape** associated with each λ.

PORTICO solves the **smaller λcr by subspace iteration** (the same kernel as the modal
one), reducing with Cholesky over `Kᵣ` (SPD), since `−Kg` is indefinite. It is fast and
scales to large models (replacing the dense `eig` O(n³)).

## 3. How to run it in the app

1. Define the **load pattern** (the loads you want to scale) and, if you want accuracy
   in the deformed shape/diagrams, enable **Auto-disc.** (subdivides the bars).
2. Open **Analysis → NL-lite → Linear Buckling** (or the Analysis Center).
3. Choose the **number of buckling modes** to extract (a few by default; the smaller
   λcr are the critical ones). The computation runs in a **Web Worker** (does not freeze
   the UI).
4. In the results overlay: a **buckling mode + λcr** selector, the shape **scale**, and
   the **buckling load per element** (`N_cr = λcr · N_ref`, highlighting the most
   compressed bars).

## 4. Example: pin-ended column → Euler

1. Model a pin-ended **vertical column** (hinged at the bottom and top for rotation in
   the buckling plane), subdivided into ~8 elements (Auto-disc.).
2. Apply a unit **axial compression load** at the end.
3. Run **Linear Buckling** with 2–3 modes.
4. The first `λcr` gives `P_cr = λcr · P`, which must match **Euler**
   `P_cr = π²·E·I / (K·L)²` (pin-ended → `K = 1`). The mode-1 shape is the classic
   sinusoidal half-wave.

> Numerical verification: `node tests/test_buckling.mjs` (pin-ended column: λ₁ −0.28 %,
> λ₂ −1.1 % vs Euler; degenerate pairs). Documented case equivalent to Euler.

## 5. Tips and limits

- Linear buckling **overestimates** the real load of imperfect or very slender
  structures (it includes neither imperfections nor plasticity). To capture the
  sensitivity to imperfections use **P-Delta** (NL-lite) with an initial imperfection,
  or a pushover.
- `Kg` depends on the **reference state**: if you change the loads, run it again.
- Pure tension does not buckle (λcr → ∞); the critical mode appears where there is
  **compression**.
- Related: **Modal with Kg** (geometric stiffness in the frequencies) and **P-Delta**
  (second-order amplification) share the `Kg` assembly.

## Reference

Bathe, K.-J. (1996). *Finite Element Procedures.* Prentice Hall — subspace iteration for
`(K + λKg)φ = 0`. Timoshenko & Gere, *Theory of Elastic Stability*.
