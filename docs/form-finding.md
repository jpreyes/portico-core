# Form-finding (force density method, FDM)

**English** · [Español](form-finding.es.md)

> Analysis → (NL-lite) → **Form-finding**. Finds the **equilibrium shape** of a bar/cable
> network and repositions the nodes to that geometry (Ctrl+Z undoes it).

## 1. What it is and what it is for

*Form-finding* seeks the geometry that is in **pure equilibrium of axial forces** for a given
distribution of loads and stresses. It is the basis for designing:

- **tensioned roofs and cable nets** (without loads, it gives the minimal-length network —
  soap-film type);
- **funicular forms and arches** (with loads, it gives the directrix that works only in
  tension/compression, with no bending).

PORTICO uses the **force density method** (Schek, 1974), which turns the problem into **a linear
system** (no iteration): fast and robust.

## 2. The force density Q (the key parameter)

Each branch (bar/cable) has a **force density**

```
q = N / L      [force / length]
```

where `N` is the axial force and `L` the branch length. The equilibrium of each free node `i`
is

```
Σ_(branches i-j)  q · (x_j − x_i)  +  p_i  =  0
```

with `p_i` the external load at the node. Grouping, it becomes `D · x = b`, where `D` is a
**Laplacian weighted by q** (a stiffness-like matrix of the network). The **same** `D` serves
the three coordinates; only the right-hand side changes.

Practical interpretation of `q`:

- **large q** → very "taut" branches → a flatter/**straighter** shape (the network approaches
  the line between anchors).
- **small q** → "slacker" branches → the shape **hangs more** under the load.
- **uniform q with no load** → **minimal-length network** (geodesic of the mesh).

In the app `q` is uniform (a single value for all branches).

## 3. Anchors and target nodes (what moves and what does not)

- **Anchors** (do not move): they are the **reference** of the shape. A node is an anchor if
  - it has a **translation restraint** (a support), **or**
  - it is a **boundary** of the selection: it touches an element that does **not** participate.
- **Target nodes** (move): the free nodes of the participating branches.

> **Bound the network to the target elements.** If you select elements before running, **only
> those** form the network; the rest of the structure stays fixed and its shared nodes act as
> anchors. This way you can form **just one beam** without touching the columns. **With no
> selection, the whole model is formed** — appropriate for a complete cable net, but in a
> **frame** it would collapse the free nodes onto the plane of the supports (the columns would
> be "erased"). For frames: **select the elements to form first.**

## 4. Coordinates to adjust (axes)

The dialog lets you choose which coordinates the FDM solves:

- **Vertical only (Z)** *(recommended)*: keeps the **plan spans** (x, y) and only adjusts the
  height. This is the correct choice for funicular beams/arches: the nodes do not "bunch up"
  horizontally.
- **3D (x, y, z)**: also redistributes in plan. Useful for **cable nets and meshes** where the
  plan position of the interior nodes is also free.

## 5. Example: loaded beam → funicular directrix (and arch upon inversion)

Goal of the example: a **loaded beam** that, instead of bending, adopts the shape that works
**without bending** (funicular of that load). By **inverting** the load, that same directrix is
an **arch** that works in pure compression.

1. Model the frame: two columns and a beam **subdivided** into several elements (Auto-discretize)
   — the interior nodes are the ones that will move.
2. Apply the load on the beam (e.g., distributed gravity, or nodal at the interior nodes).
3. **Select only the beam elements.** The column tops will act as anchors (reference) and the
   columns stay intact.
4. Run **Form-finding**. Choose `q` (start with 10) and **Vertical only (Z)**.
5. Result: the interior nodes drop forming the **funicular** (it hangs under the load). Uniform
   gravity load → parabola; point loads → funicular polygon.
6. **To get the arch**: invert the load direction (upward load) and repeat — the directrix rises
   and the equivalent **arch** remains, which under the real original load would work in
   **compression** with no bending.

> Numerical verification of the bounding and the funicular: `node test_formfind.mjs` (columns
> intact, beam with symmetric sag, plan spans preserved).

## 6. Tips and limits

- The result is saved as the model's **base geometry**; **Ctrl+Z** restores it.
- The network must be **connected to the anchors**; if a free node is isolated or if `q ≤ 0`,
  the system is not stable and a warning is shown.
- A uniform `q` is enough for most cases; per-branch (non-uniform) densities would allow tuning
  zones, but today the UI uses a single `q`.
- After forming, **re-analyze** (static) to confirm the bending was reduced relative to the
  original straight geometry.

## Reference

Schek, H.-J. (1974). *The force density method for form finding and computation of general
networks.* Computer Methods in Applied Mechanics and Engineering, 3(1), 115–134.
