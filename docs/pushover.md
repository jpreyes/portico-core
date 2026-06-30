# Pushover and incremental nonlinear analysis (NL-lite)

**English** · [Español](pushover.es.md)

PORTICO has **two** *pushover*-type analyses (progressive load up to collapse), for two
different physics. Both are under **Analysis → (NL-lite)** and require enabling **"Nonlinear
analysis (NL-lite)"** in ⚙ Settings.

| Analysis | Physics | What for |
|---|---|---|
| **Pushover — displacement control** | geometric (bars/cables, *truss*) | cables, tensioned membranes, **snap-through**, post-buckling |
| **Plastic hinges — collapse** | plastic (frames, moment Mp) | **plastic collapse** factor of frames, hinge sequence |

> Reference load: both use the **combination of all static load cases** (at factor 1) as the
> load **pattern**. The result is a **factor λ**: the applied load is `λ × pattern`. Define at
> least one load case before running.

---

## A. Displacement-control pushover

**Analysis → Pushover (δ control).** Solves the nonlinear equilibrium by **controlling a
displacement** (not the load), which makes it possible to **pass the limit points** and trace
the full load–displacement curve, including **snap-through** (negative-slope segments that load
control cannot follow).

### How it runs

1. Enable **NL-lite** in ⚙ Settings.
2. Model the structure, the **supports** and **one load case** (the pattern).
3. **Analysis → Pushover (δ control).**
4. **"Initial imperfection"** dialog: amplitude in meters.
   - `0` → perfect structure.
   - `> 0` → an imperfection with the **shape of the linear response** (normalized) is added to
     **trigger** bifurcation instabilities (a perfect column or arch does not buckle numerically
     without a trigger).
5. The path is traced and the **load–displacement curve** opens.

### What the program decides for you

- **Control DOF**: automatically the degree of freedom with the **largest displacement** in the
  linear response (the most representative of the mode). The label shows "node N · axis X/Y/Z".
- **Target and steps**: pushes up to **25 ×** the linear control displacement in **60 steps**,
  enough to traverse the full snap-through.

### How to read the results

- **λ–δ curve**: horizontal axis = displacement of the control DOF; vertical = load factor
  **λ**. The **peak of λ** is the **limit load** (maximum load it resists = `λ_max × pattern`).
- **Slider / ▶**: steps through or animates the steps; the model shows the **deformed shape** of
  each step (slack cables in a different color).
- **Descending branch** after the peak = **snap-through** (the structure "jumps" to another
  equilibrium configuration).

### Example: snap-through of a shallow truss (von Mises)

Two inclined bars meeting at a shallow apex, loaded downward at the apex:

1. Nodes: supports at `(0,0,0)` and `(2,0,0)` (fixed), apex at `(1,0,0.2)` (low rise → prone to
   snap-through).
2. Two bars: left-support → apex and right-support → apex (same material/section).
3. **Nodal** load downward (−Z) at the apex; restrain the apex's lateral displacement if you
   want the pure symmetric mode.
4. Pushover (δ control), imperfection `0`.
5. The curve rises to a **peak** (limit load), **drops** (snap-through, the bars go from
   compression to tension as the apex inverts) and rises again. The peak λ × the applied load
   is the **snap-through critical load**.

---

## B. Plastic hinges (plastic frame pushover)

**Analysis → Plastic hinges.** Incremental **event-by-event** analysis with elastic-perfectly-
plastic material: each bar end forms a **hinge** when it reaches its **plastic moment Mp**; the
moment is fixed at Mp and that rotation is released. **Collapse** occurs when a **mechanism**
forms (the stiffness matrix becomes singular).

### How it runs

1. Enable **NL-lite**; define supports and **one load case** (pattern).
2. *(Optional, #27b)* **select** the elements you want to give a different Mp.
3. **Analysis → Plastic hinges.**
4. Dialog:
   - **Default Mp** [kN·m] (capacity of the rest of the elements).
   - With a selection: **Mp of the selected** and a **"only the selection can hinge"** checkbox
     (the rest stays elastic).
5. Results in the **Results → "Hinges"** tab (respects the theme):
   - **collapse factor λc** (if a mechanism forms) = `λc × pattern`;
   - **hinge sequence** (order, element, node, axis, formation λ, Mp, control displacement);
   - the **mechanism deformed shape** in the viewer.

### Reading

- **λc** is the **plastic collapse load** in pattern factors. If no mechanism forms, "no
  mechanism" is reported (the load does not exhaust the structure).
- The **order** of the hinges shows where the structure yields first → a guide for resizing.

---

## Notes and limits

- The DC pushover treats the elements as **bars/cables** (no bending stiffness): appropriate for
  trusses, cables and tensioned structures; for bending frames use **Plastic hinges**.
- For the **elastic buckling critical factor** (linear, without tracing the path) use **Linear
  buckling** (see the `(K+λKg)φ=0` problem).
- All NL-lite analyses start from the **same reference load** (sum of static cases); adjust the
  cases to set the push pattern.
