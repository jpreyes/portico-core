# PORTICO — 3D Structural Analysis & Design

**English** · [Español](README.es.md)

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![No build](https://img.shields.io/badge/build-not%20required-success)
![Stack](https://img.shields.io/badge/stack-Vanilla%20JS%20%C2%B7%20Three.js-informational)
[![CI](https://github.com/jpreyes/portico-core/actions/workflows/ci.yml/badge.svg)](https://github.com/jpreyes/portico-core/actions/workflows/ci.yml)
[![Try it live](https://img.shields.io/badge/demo-live-brightgreen)](https://jpreyes.github.io/portico-core/)

### 🚀 Try it live: **[jpreyes.github.io/portico-core](https://jpreyes.github.io/portico-core/)** &nbsp;·&nbsp; mirror: [portico.jpreyes-c.workers.dev](https://portico.jpreyes-c.workers.dev)

![PORTICO — 3D viewer and analysis in the browser](docs/img/portico-hero.gif)

**portico-core** is the **open-source (AGPL-3.0)** core of PORTICO: a browser-based
finite-element tool for 3D structural analysis and design.

It models frame and area elements; runs static, modal, response-spectrum, P-Δ,
buckling, nonlinear, pushover and time-history analysis; checks designs against several
codes; and draws the forces, deformed shapes and mode shapes. Everything runs
client-side — no install, no build step, no bundler, no framework; just a modern
browser (Chrome, Edge, Firefox).

It is the reusable base for the Pro product **portico** (portico-core + the C++/WASM
solver **Nodex**) and other derived tools.

---

## Capabilities

- **Modeling:** 3D Timoshenko frame elements (12 DOF) and area elements
  (membrane/plate/shell); free and mapped meshing.
- **Supports and connections:** fixed/pinned, springs, releases, links, rigid end
  zones, rigid diaphragms and nodal masses.
- **Loads:** nodal, uniform and trapezoidal distributed, thermal and self-weight;
  load cases and combinations.
- **Analysis:** static, modal, response spectrum (CQC/SRSS), P-Δ, linear buckling,
  nonlinear (cables, large rotation), pushover and time-history.
- **Multi-code design:** steel (AISC/EC3/NCh), concrete (ACI/EC2), timber and aluminum
  (EC9), with auto-design, reporting and drift checks.
- **Interoperability:** `.s3d` format (JSON), CSV import, IFC/BIM, and an AI assistant
  to generate models from text (bring-your-own LLM endpoint).
- **Code-agnostic + presets:** core ships generic **example** tables (loads, spectrum,
  design parameters); each country's real code is an **opt-in preset** under
  [`presets/`](presets/) that is copied over `assistant/`. Includes `presets/chile/` (NCh).

> Design results are indicative and require the review and judgment of a qualified
> structural engineer. Always verify against an analytical solution or reference
> software before using them in real projects.

---

## Verification

The solver is checked against closed-form solutions and published benchmarks, not just
"it runs". The suite covers **18 documented cases** — cantilever and taut-string modal
frequencies, the Bathe–Wilson frame eigenvalues, thick-cylinder Lamé stresses, plate
patch tests, an Allman membrane, prescribed support settlement, staged construction,
influence lines — plus a global equilibrium check (ΣReactions = ΣLoads) on every model.

Each case lives in [`docs/verifications/`](docs/verifications/) with its model and the
reference it is compared to. Run the battery yourself:

```bash
node test_plate.mjs        # one case
for f in test_*.mjs; do node "$f"; done   # all of them
```

---

## Screenshots

| 3D viewer & analysis | Section calculator (prestressed beam) | Design check (D/C) |
|:---:|:---:|:---:|
| ![3D viewer](docs/img/screenshot-viewport.png) | ![Section designer](docs/img/screenshot-section.png) | ![Design check](docs/img/screenshot-design.png) |

---

## Running the application

**Option A — Local server (recommended):**

```bash
# In the project folder:
python serve.py        # port 8765 by default; accepts: python serve.py 9000
```

Then open **http://localhost:8765** in the browser.

> `serve.py` is a no-cache static server with the correct MIME types (UTF-8,
> `.webmanifest`). As an alternative: `python -m http.server 8765`.
> On Windows you can use the Command Prompt or PowerShell. Python 3 ships preinstalled
> on most machines; if not, download it from python.org.

**Option B — Live demo (nothing to install):**

Open **[portico.jpreyes-c.workers.dev](https://portico.jpreyes-c.workers.dev)** directly
in the browser. It is the same app, deployed as a static site.

---

## Coordinate convention

The program uses the same system as SAP2000 and ETABS:

| Axis | Direction |
|------|-----------|
| **X** | East – West |
| **Y** | North – South |
| **Z** | Vertical (up) |

---

## User interface

```
┌─────────────────────────────────────────────────────────────┐
│  Menu:  File  Edit  View  Analysis              Units        │
├──────┬──────────────────────────────────────┬───────────────┤
│      │                                      │               │
│ Tool │           3D window                  │  Right panel  │
│ bar  │                                      │  Sel. / Mat.  │
│      │   (rotate: right mouse button)       │  Sec. / Diaph.│
│      │   (zoom:   wheel)                     │               │
│      │   (pan:    middle button)            │               │
├──────┴──────────────────────────────────────┴───────────────┤
│  Mode: Select   │  Coords  │  Selection  │  Model           │
└─────────────────────────────────────────────────────────────┘
```

### Toolbar (left)

| Button | Key | Action |
|--------|-----|--------|
| Sel. | `S` | Select nodes and elements |
| Node | `N` | Create a node by clicking on the grid |
| Elem. | `E` | Create an element (click start node → end node) |
| Support | `R` | Assign restraints to a node |
| Ext. | `Home` | Zoom to fit the whole model |
| ▶ | `F5` | Run static analysis |

---

## Building the model

### 1. Define materials

In the right panel, **Mat.** tab:
- Click **＋ Add Material**
- Enter: name, E (elastic modulus), G (shear modulus), ν (Poisson), ρ (density)

Concrete G30 example (kN-m):

| E | G | ν | ρ |
|---|---|---|---|
| 28 700 000 | 11 960 000 | 0.20 | 2.5 |

### 2. Define sections

**Sec.** tab → **＋ Add Section**
Enter the numeric geometric properties:

| Property | Description |
|----------|-------------|
| A | Section area [m²] |
| Iz | Moment of inertia about z [m⁴] |
| Iy | Moment of inertia about y [m⁴] |
| J | Torsion constant [m⁴] |
| Avy | Shear area in y (= κy × A) [m²] |
| Avz | Shear area in z (= κz × A) [m²] |

**30×30 cm column** (example):
`A=0.09, Iz=6.75e-4, Iy=6.75e-4, J=1.13e-4, Avy=0.075, Avz=0.075`

**30×50 cm beam** (example):
`A=0.15, Iz=3.125e-3, Iy=5.625e-4, J=1.30e-4, Avy=0.125, Avz=0.075`

### 3. Create nodes

Activate **Node** mode (`N`).
Use the **Z floor** field (top-left corner) to set the insertion level.
Click on the grid to create the node at that position.

> The **Snap** field controls the snapping grid size (default 0.5 m).

### 4. Create elements

Activate **Elem.** mode (`E`).
Click the **start node** → click the **end node**.
The program automatically assigns the first available material and section; you then
edit them in the panel.

> Press `Esc` to cancel creation midway.

### 5. Assign supports

Activate **Support** mode (`R`) and click the node.
The panel shows the 6 degrees of freedom (✓ = restrained):

| DOF | Meaning |
|-----|---------|
| Ux, Uy, Uz | Translations |
| Rx, Ry, Rz | Rotations |

Quick buttons:
- **Fixed** → all 6 DOF restrained (red)
- **Pin** → translations only restrained (orange)
- **Free** → no restraints (blue)

---

## Loads

When you select a **node** in Select mode, the loads section appears:
Enter Fx, Fy, Fz, Mx, My, Mz and click **Apply**.

When you select an **element**, you can assign a distributed load:
Choose the direction (globalZ, localY, etc.) and enter the magnitude `w` [kN/m].

Loads are assigned to the **active load case** (selector in the top-right corner of the
window). To add cases, click **＋** next to the selector.

---

## Static analysis

**`F5`** → Run analysis (active load case)
**Analysis → Run + Self-weight** → adds the elements' self-weight

After running:
- The model shows the amplified **deformed shape**
- Use the **View** selector to switch between: Deformed / N / Vy / Vz / T / My / Mz
- The **Scale** control adjusts the visual amplification
- Click a node or element to see the values in the right panel

---

## Rigid diaphragms

They represent rigid floor slabs at each story (in-plane motion moves together).

**Diaph.** tab in the right panel:

1. Click **⚡ Auto-detect Floors** — groups nodes automatically by Z level
2. For each diaphragm, assign:
   - **Mass m** [ton]: translational floor mass
   - **Icm** [ton·m²]: mass moment of inertia about the CM
   - **CM (x, y)**: center-of-mass coordinates
   - **ex, ey**: accidental eccentricity (for seismic analysis)

The floor CM appears in the 3D view as an orange marker.

---

## Modal analysis

**`F6`** → Modal Analysis

When you press F6, the program asks for the **number of modes** to extract (default 10).

**Results in the window:**
- Mode selector → shows the deformed shape of the selected mode
- Frequency `f` [Hz] and period `T` [s] of the mode
- **▶ Play** → animates the oscillation
- **Speed** slider → animation speed
- **Amp.** field → visual amplitude

**Participation table** (button in the overlay):

| Column | Meaning |
|--------|---------|
| f [Hz] | Natural frequency |
| T [s] | Natural period |
| meff X (%) | Effective mass in the X direction |
| Cum X | Cumulative — should reach ≥ 90% |

> **Seismic criterion:** the sum of participating masses must be ≥ 90% in each analysis
> direction. Green cells indicate the threshold was reached.

---

## Response spectrum (CQC / SRSS)

**`F7`** → Response Spectrum
*(Requires running the modal analysis first)*

A dialog opens with the following parameters:

| Field | Description |
|-------|-------------|
| Seismic direction | X, Y or Z |
| Combination | **CQC** (recommended) or SRSS |
| Damping ζ | Critical fraction (default 0.05 = 5%) |
| Sa units | g, m/s², cm/s², ft/s² |
| Spectrum table | T [s], Sa [unit] pairs — one pair per line |

**Spectrum format:**
```
0.00, 0.20
0.10, 0.45
0.50, 0.40
1.00, 0.28
2.00, 0.14
4.00, 0.07
```

Results appear as envelopes (absolute values). You can view the N, V, M force diagrams
with the normal view selector.

---

## Importing a model from CSV

**File → Import CSV…**

Single-table format with a TYPE column:

```csv
TYPE,      ID,  name,        E,          G,        nu,    rho
MATERIAL,   1,  Concrete,    28700000,   11960000, 0.20,  2.5

TYPE,      ID,  name,     A,     Iz,      Iy,      J,       Avy,   Avz
SECTION,    1,  Col30,    0.09,  6.75e-4, 6.75e-4, 1.13e-4, 0.075, 0.075

TYPE,  ID,  x,    y,    z,    ux, uy, uz, rx, ry, rz
NODE,   1,  0.0,  0.0,  0.0,   1,  1,  1,  1,  1,  1
NODE,   2,  5.0,  0.0,  0.0,   1,  1,  1,  1,  1,  1
NODE,   3,  0.0,  0.0,  3.5,   0,  0,  0,  0,  0,  0
NODE,   4,  5.0,  0.0,  3.5,   0,  0,  0,  0,  0,  0

# No releases (release columns omitted → all 0):
TYPE,     ID,  n1, n2, matId, secId
ELEMENT,   1,   1,  3,     1,     1
ELEMENT,   2,   2,  4,     1,     1

# With Mz releases at both ends (DOF r5 and r11 = rz1 and rz2):
# TYPE,    ID,  n1, n2, matId, secId, r0,r1,r2,r3,r4,r5, r6,r7,r8,r9,r10,r11
ELEMENT,   3,   3,  4,     1,     1,  0, 0, 0, 0, 0, 1,  0, 0, 0, 0,  0,  1
```

**Order of the 12 release DOFs:** `[ux1, uy1, uz1, rx1, ry1, rz1, ux2, uy2, uz2, rx2, ry2, rz2]`
`1 = releases that degree of freedom (hinge), 0 = fixed`

Common cases:
- Mz hinge at end 1: column 6 = 1 → `…, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0`
- Mz hinge at end 2: column 12 = 1 → `…, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1`
- Beam pinned at both ends (Mz at both): → `…, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1`

The release columns are **optional** — if omitted, the element is fixed-fixed.

Download a template: **File → Download CSV Template**

---

## Saving and loading models

| Action | Key |
|--------|-----|
| New | `Ctrl+N` |
| Open | `Ctrl+O` |
| Save | `Ctrl+S` |
| Save as | — |

Files are saved with the `.s3d` extension (JSON format).

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `S` | Select mode |
| `N` | Node mode |
| `E` | Element mode |
| `R` | Support mode |
| `F5` | Run static analysis |
| `F6` | Modal analysis |
| `F7` | Response spectrum |
| `Del` | Delete selection |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Home` | Zoom to fit |
| `I` | Isometric view |
| `T` | Top view (XY) |
| `F` | Front view (XZ) |
| `L` | Side view (YZ) |
| `G` | Toggle grid |

---

## Available units

Selectable in the top-right corner:

| System | Force | Length | Notes |
|--------|-------|--------|-------|
| **kN-m** | kN | m | Standard for design in Chile |
| ton-m | ton | m | |
| kip-ft | kip | ft | Imperial system |

> The unit system affects how the entered values are interpreted. Keep it consistent
> with the material and section properties.

---

## FAQ

**Why doesn't the page load?**
The app must be served over HTTP. It does not work when opened directly as a file
(`file://`). Use `python serve.py`.

**The analysis says "unstable model"?**
The model must have at least one fully restrained node (fixed, or with the three
translations restrained). Check that you have assigned supports.

**The modal analysis finds no modes?**
The model needs mass. Define density (ρ) in the materials **or** assign masses to the
floor diaphragms.

**How do I compute the floor Icm?**
For a rectangular floor of dimensions `a × b` with total mass `m`:
`Icm = m × (a² + b²) / 12`

**Which ζ value should I use?**
For reinforced-concrete structures: **5%** (ζ = 0.05).
For steel structures: **2–3%** (ζ = 0.02–0.03).

---

## Seismic workflow summary

```
1. Define geometry (nodes, elements, materials, sections)
2. Assign supports
3. Define floor diaphragms with masses (⚡ Auto-detect)
4. [Optional] Gravity loads (D, L) and static analysis → F5
5. Modal analysis → F6
   └─ Check ≥ 90% participation in X and Y
6. Response spectrum → F7
   └─ Enter spectrum, direction X, CQC, ζ=0.05
   └─ Repeat for direction Y
7. Export results → Analysis → Export...
```

---

## License

Distributed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. See
[`LICENSE`](LICENSE).

Copyright (C) 2026 JP Reyes.

The AGPL requires, in addition to the GPL conditions, that if the software is offered as
a network service, the corresponding source code be made available to its users.

## Project conventions

Engineering conventions — Z-up coordinates (like SAP2000/ETABS), the 12 element DOFs and
the neutral solver contract — are documented at the top of the relevant modules and in
[`docs/EXTENDING.md`](docs/EXTENDING.md). Status and upcoming milestones are in
[`docs/ROADMAP.md`](docs/ROADMAP.md). To build layers on top of core (pluggable engines,
white-label) without forking, see [`docs/EXTENDING.md`](docs/EXTENDING.md).
