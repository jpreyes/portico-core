// ──────────────────────────────────────────────────────────────────────────────
// Model — central data store for the structural model
// Convention: Z-up  (X east, Y north, Z vertical) — SAP2000 / ETABS style
// ──────────────────────────────────────────────────────────────────────────────

export class Model {
  constructor() {
    // Maps: id (int) → object
    this.nodes      = new Map();
    this.elements   = new Map();
    this.areas      = new Map();   // 2D area elements (CST/QUAD membrane)
    this.materials  = new Map();
    this.sections   = new Map();
    this.diaphragms   = new Map();
    this.loadCases    = new Map();
    this.combinations = new Map();
    this.links        = new Map();   // links/couplings between nodes (deck↔beam, offsets)

    this._cnt = { nodes: 0, elements: 0, areas: 0, materials: 0,
                  sections: 0, diaphragms: 0, loadCases: 0, combinations: 0, links: 0 };

    this.units = 'kN-m';

    // Project mode, defined WHEN CREATING the model (File → New):
    //  '3D' = three-dimensional structure.
    //  '2D' = planar X–Z frame: all nodes with Y=0, out-of-plane DOFs
    //         (uy, rx, rz) automatically restrained in the analysis.
    this.mode = '3D';

    // Grid axes (SAP/ETABS style): coordinates per global direction.
    // x: axes A,B,C…  y: axes 1,2,3…  z: floor levels.
    this.grids = { x: [], y: [], z: [] };

    // PER-PROJECT data that travels in the .s3d (not in the app's global config):
    //  memoria        → report header/designer/description (#41)
    //  analysisParams → run parameters (number of modes, method, Mp, auto-disc…) (#39)
    // null = use the app defaults (compatibility with old files).
    this.report        = null;
    this.analysisParams = null;
    // Design settings: code per material family (steel/concrete/timber).
    // null = use each family's default code (AISC 360 LRFD, ACI 318…).
    this.designSettings = null;   // { codeByFamily: { steel:'EN1993-1-1', ... } }

    // Seismic mass source (#mass-source): convert load patterns into translational
    // mass for the modal/spectrum/time-history analyses (ETABS/SAP "mass source").
    // null = no conversion; mass comes only from material ρ, nodal masses and
    // diaphragm masses. { enabled, g, selfWeight, entries:[{lcId, factor}] }.
    this.massSource = null;

    this._initDefaults();
  }

  _next(type) { return ++this._cnt[type]; }

  // ── Default material & section ─────────────────────────────────────────────
  _initDefaults() {
    this.addMaterial({ name: 'Hormigón G30', E: 2.87e7, G: 1.19e7, nu: 0.2, rho: 2.5 });
    this.addSection({
      name: 'Col 30×30',
      A: 0.09, Iz: 6.75e-4, Iy: 6.75e-4, J: 1.14e-3,   // St. Venant 0.30x0.30 (0.1406 a^4); previously 1.13e-4 (10x low)
      Avy: 0.075, Avz: 0.075, kappay: 0.833, kappaz: 0.833
    });
  }

  // ── Nodes ──────────────────────────────────────────────────────────────────
  addNode(x, y, z, restraints = {}) {
    const id = this._next('nodes');
    const node = {
      id,
      x: +x, y: +y, z: +z,
      restraints: { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0, ...restraints },
      // Nodal mass: translational (mx/my/mz, ton) + rotational inertia (irx/iry/irz,
      // ton·m²) on the rotational DOFs Rx/Ry/Rz (#6).
      nodeMass:   { mx: 0, my: 0, mz: 0, irx: 0, iry: 0, irz: 0 },
      // Elastic support: spring stiffness per global DOF
      // (kux/kuy/kuz in kN/m; krx/kry/krz in kN·m/rad). 0 = no spring.
      springs:    { kux: 0, kuy: 0, kuz: 0, krx: 0, kry: 0, krz: 0 },
    };
    this.nodes.set(id, node);
    return node;
  }

  updateNode(id, props) {
    const n = this.nodes.get(id);
    if (!n) return null;
    if (props.x !== undefined) n.x = +props.x;
    if (props.y !== undefined) n.y = +props.y;
    if (props.z !== undefined) n.z = +props.z;
    if (props.restraints) Object.assign(n.restraints, props.restraints);
    if (props.nodeMass) {
      if (!n.nodeMass) n.nodeMass = { mx: 0, my: 0, mz: 0, irx: 0, iry: 0, irz: 0 };
      Object.assign(n.nodeMass, props.nodeMass);
    }
    if (props.springs) {
      if (!n.springs) n.springs = { kux: 0, kuy: 0, kuz: 0, krx: 0, kry: 0, krz: 0 };
      Object.assign(n.springs, props.springs);
    }
    // UNILATERAL spring per DOF (#3): '' / 'c' (compression-only, acts with u≤0) /
    // 't' (tension-only, acts with u≥0). The spring deactivates when the support
    // lifts off (uplift/gap), solved by active set in the static solver.
    if (props.springUni) {
      if (!n.springUni) n.springUni = { ux: '', uy: '', uz: '', rx: '', ry: '', rz: '' };
      Object.assign(n.springUni, props.springUni);
      if (!Object.values(n.springUni).some(v => v === 'c' || v === 't')) delete n.springUni;
    }
    // COUPLED 6×6 spring matrix (#2): inclined springs / cross soil-structure
    // stiffness. `null`/empty array = no coupling (only the `springs` diagonal is used).
    if (props.springK !== undefined) {
      n.springK = (Array.isArray(props.springK) && props.springK.length === 36 && props.springK.some(v => v)) ? props.springK.map(Number) : null;
    }
    // NONLINEAR SOIL spring (#4): per DOF, tabulated force–displacement curve
    // [[d,F],…] monotonic (p-y lateral / t-z shaft / q-z tip). The static solver
    // resolves it by Newton. Outside the tabulated range it saturates (ultimate force). null/[] = no curve.
    if (props.soilSpring !== undefined) {
      const ss = props.soilSpring || {};
      const out = {};
      for (const d of ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'])
        if (Array.isArray(ss[d]) && ss[d].length >= 2) out[d] = ss[d].map(p => [+p[0], +p[1]]);
      n.soilSpring = Object.keys(out).length ? out : null;
    }
    // Prescribed displacement (support settlement/rotation). Values in m / rad.
    // A DOF with value ≠ 0 is imposed as a support with that displacement (#54).
    if (props.prescDisp) {
      if (!n.prescDisp) n.prescDisp = { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 };
      Object.assign(n.prescDisp, props.prescDisp);
      // If everything ended up zero, drop the object to keep the .s3d clean.
      if (!Object.values(n.prescDisp).some(v => v)) delete n.prescDisp;
    }
    return n;
  }

  // 6×6 matrix (row-major, 36) of an INCLINED support spring of stiffness `k` (kN/m)
  // along the direction `dir` (normalized): translational block k·(d⊗d) (#2).
  // Useful for inclined supports / on planes not aligned with the global axes.
  static inclinedSpringK(k, dir) {
    const L = Math.hypot(dir[0] || 0, dir[1] || 0, dir[2] || 0) || 1;
    const d = [(dir[0] || 0) / L, (dir[1] || 0) / L, (dir[2] || 0) / L];
    const KS = new Array(36).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) KS[i * 6 + j] = k * d[i] * d[j];
    return KS;
  }

  removeNode(id) {
    if (!this.nodes.has(id)) return false;
    // Remove connected elements (and their orphan dist/temp loads)
    for (const [eid, el] of this.elements) {
      if (el.n1 === id || el.n2 === id) { this.elements.delete(eid); this._purgeElemLoads(eid); }
    }
    this._purgeNodeLoads(id);   // nodal loads that pointed to the deleted node
    for (const [lid, lk] of this.links) if (lk.master === id || lk.slave === id) this.links.delete(lid);
    this.nodes.delete(id);
    return true;
  }

  // Removes from ALL load cases the loads referencing a deleted node/element, so no
  // orphan arrows remain in the view or in the solver.
  _purgeNodeLoads(nodeId) {
    for (const lc of this.loadCases.values())
      if (lc.loads?.length) lc.loads = lc.loads.filter(l => !(l.type === 'nodal' && l.nodeId === nodeId));
  }
  _purgeElemLoads(elemId) {
    for (const lc of this.loadCases.values())
      if (lc.loads?.length) lc.loads = lc.loads.filter(l => !((l.type === 'dist' || l.type === 'temp') && l.elemId === elemId));
  }

  // ── Elements ───────────────────────────────────────────────────────────────
  addElement(n1, n2, matId, secId) {
    if (!this.nodes.has(n1) || !this.nodes.has(n2)) return null;
    if (n1 === n2) return null;
    const id = this._next('elements');
    const elem = {
      id, n1, n2,
      matId: matId ?? this._firstKey('materials'),
      secId: secId ?? this._firstKey('sections'),
      releases: Array(12).fill(0)
    };
    this.elements.set(id, elem);
    return elem;
  }

  updateElement(id, props) {
    const el = this.elements.get(id);
    if (!el) return null;
    if (props.n1     !== undefined) el.n1     = +props.n1;
    if (props.n2     !== undefined) el.n2     = +props.n2;
    if (props.matId  !== undefined) el.matId  = +props.matId;
    if (props.secId  !== undefined) el.secId  = +props.secId;
    if (props.releases) el.releases = [...props.releases];
    // NL-lite (Phase 1): "tension-only" cable + prestress via natural length.
    // L0factor = natural length / geometric length (1 = no prestress, <1 = prestressed).
    if (props.cable    !== undefined) {
      el.cable = !!props.cable;
      if (el.cable) el.compressionOnly = false;   // mutually exclusive
    }
    if (props.compressionOnly !== undefined) {
      el.compressionOnly = !!props.compressionOnly;
      if (el.compressionOnly) el.cable = false;    // mutually exclusive
    }
    if (props.L0factor !== undefined) el.L0factor = +props.L0factor || 1;
    // Rigid end zone / end offset (#87): lengths (m) per end.
    if (props.rigidEnd !== undefined) {
      const re = props.rigidEnd;
      const oi = Math.max(0, +(re?.i) || 0), oj = Math.max(0, +(re?.j) || 0);
      if (oi <= 0 && oj <= 0) delete el.rigidEnd;
      else el.rigidEnd = { i: oi, j: oj };
    }
    // End spring / partial fixity (1-008): { [dof 0..11]: k>0 } (kN·m/rad or kN/m).
    if (props.endSprings !== undefined) {
      const es = {};
      for (const k of Object.keys(props.endSprings || {})) {
        const v = +props.endSprings[k];
        if (v > 0 && isFinite(v)) es[+k] = v;
      }
      if (Object.keys(es).length) el.endSprings = es; else delete el.endSprings;
    }
    // Beam on elastic foundation / line spring (1-013): { ky, kz } kN/m per m.
    if (props.foundation !== undefined) {
      const f = props.foundation || {};
      const ky = +f.ky || 0, kz = +f.kz || 0;
      const fo = {};
      if (ky > 0) fo.ky = ky;
      if (kz > 0) fo.kz = kz;
      if (Object.keys(fo).length) el.foundation = fo; else delete el.foundation;
    }
    return el;
  }

  removeElement(id) {
    const ok = this.elements.delete(id);
    if (ok) this._purgeElemLoads(id);   // orphan dist/temp loads
    return ok;
  }

  // ── Area elements (2D membrane: CST 3 nodes / QUAD 4 nodes) ─────────────────
  addArea(nodes, matId, opts = {}) {
    const ns = (nodes || []).map(Number);
    if (ns.length !== 3 && ns.length !== 4) return null;
    if (ns.some(n => !this.nodes.has(n))) return null;
    if (new Set(ns).size !== ns.length) return null;
    const id = this._next('areas');
    const area = {
      id, nodes: ns,
      matId: matId ?? this._firstKey('materials'),
      thickness: opts.thickness ?? 0.2,
      planeStrain: !!opts.planeStrain,
      // 'membrane' (in-plane only) | 'plate' (bending only) | 'shell' (membrane+plate)
      behavior: opts.behavior ?? 'membrane',
      // Membrane triangle with in-plane rotational DOFs (Allman) — less stiff than
      // the CST in bending. Only applies to 3-node areas.
      drilling: !!opts.drilling,
      kind: ns.length === 3 ? 'CST' : 'QUAD',
    };
    this.areas.set(id, area);
    return area;
  }

  updateArea(id, props) {
    const a = this.areas.get(id);
    if (!a) return null;
    if (props.matId      !== undefined) a.matId = +props.matId;
    if (props.thickness  !== undefined) a.thickness = +props.thickness;
    if (props.planeStrain !== undefined) a.planeStrain = !!props.planeStrain;
    if (props.behavior   !== undefined) a.behavior = props.behavior;
    if (props.drilling   !== undefined) a.drilling = !!props.drilling;
    if (props.nodes) { a.nodes = props.nodes.map(Number); a.kind = a.nodes.length === 3 ? 'CST' : 'QUAD'; }
    return a;
  }

  removeArea(id) { return this.areas.delete(id); }

  // ── Materials ──────────────────────────────────────────────────────────────
  addMaterial(props) {
    const id = this._next('materials');
    const mat = {
      id, name: 'Material',
      E: 2.87e7, G: 1.19e7, nu: 0.2, rho: 2.5,
      alpha: 1e-5,   // thermal expansion coef. [1/°C] (concrete ~1e-5, steel ~1.2e-5)
      ...props
    };
    this.materials.set(id, mat);
    return mat;
  }

  updateMaterial(id, props) {
    const m = this.materials.get(id);
    if (!m) return null;
    Object.assign(m, props);
    if (props.E !== undefined) m.E = +props.E;
    if (props.G !== undefined) m.G = +props.G;
    if (props.nu !== undefined) m.nu = +props.nu;
    if (props.rho !== undefined) m.rho = +props.rho;
    if (props.alpha !== undefined) m.alpha = +props.alpha;
    return m;
  }

  removeMaterial(id) {
    for (const el of this.elements.values()) {
      if (el.matId === id) return { ok: false, reason: 'Material en uso por elemento(s)' };
    }
    this.materials.delete(id);
    return { ok: true };
  }

  // ── Sections ───────────────────────────────────────────────────────────────
  addSection(props) {
    const id = this._next('sections');
    const sec = {
      id, name: 'Sección',
      A: 0.09, Iz: 6.75e-4, Iy: 6.75e-4, J: 1.14e-3,   // St. Venant 0.30x0.30 (0.1406 a^4); previously 1.13e-4 (10x low)
      kappay: 0.833, kappaz: 0.833,
      mod: { A: 1, Iy: 1, Iz: 1, J: 1 },   // stiffness modifiers (cracked section, etc.)
      ...props
    };
    // Timoshenko shear areas: when not given explicitly, derive them from A·κ so they
    // SCALE with the section area. Otherwise a section defined by A alone would keep the
    // base section's shear area (0.09·0.833 ≈ 0.075) regardless of A, mis-stating the shear
    // stiffness. Avy/Avz passed in props are respected as-is (e.g. the profile catalog).
    if (props.Avy === undefined) sec.Avy = sec.A * sec.kappay;
    if (props.Avz === undefined) sec.Avz = sec.A * sec.kappaz;
    if (!sec.mod) sec.mod = { A: 1, Iy: 1, Iz: 1, J: 1 };
    this.sections.set(id, sec);
    return sec;
  }

  updateSection(id, props) {
    const s = this.sections.get(id);
    if (!s) return null;
    if (props.mod) { s.mod = { ...(s.mod || { A:1, Iy:1, Iz:1, J:1 }), ...props.mod }; delete props.mod; }
    Object.assign(s, props);
    const nums = ['A','Iz','Iy','J','Avy','Avz','kappay','kappaz'];
    nums.forEach(k => { if (props[k] !== undefined) s[k] = +props[k]; });
    if (!s.mod) s.mod = { A:1, Iy:1, Iz:1, J:1 };
    return s;
  }

  removeSection(id) {
    for (const el of this.elements.values()) {
      if (el.secId === id) return { ok: false, reason: 'Sección en uso por elemento(s)' };
    }
    this.sections.delete(id);
    return { ok: true };
  }

  // ── Diaphragms ─────────────────────────────────────────────────────────────
  addDiaphragm(props) {
    const id = this._next('diaphragms');
    const d = {
      id, z: 0, nodes: [],
      cm: { x: 0, y: 0 },
      mass: { m: 0, Icm: 0 },
      eccentricity: { ex: 0, ey: 0 },
      ...props
    };
    // Geometric centroid of the nodes as the default CM: avoids drawing the CM at a
    // corner (origin) when not specified (e.g. from the assistant). The CR/master is
    // left UNSET → the drawing places it at the centroid and the physics uses
    // nodes[0] as the rigid-body master (indistinct for the result).
    const ns = (d.nodes || []).map(nid => this.nodes.get(nid)).filter(Boolean);
    if (ns.length && (!props.cm || (props.cm.x === 0 && props.cm.y === 0))) {
      d.cm = { x: ns.reduce((s, n) => s + n.x, 0) / ns.length,
               y: ns.reduce((s, n) => s + n.y, 0) / ns.length };
    }
    this.diaphragms.set(id, d);
    return d;
  }

  removeDiaphragm(id) { return this.diaphragms.delete(id); }

  // ── Links / couplings ───────────────────────────────────────────────────────
  // Links a SLAVE node to a MASTER node (with no element between them).
  //  rigid=true  → rigid link (follows the master as a solid, with arm/offset):
  //                u_s = u_m + θ_m×r, θ_s = θ_m.  Transmits force+moment.
  //  rigid=false → simple coupling: equalizes the marked DOFs (no arm).
  //  dofs = {ux,uy,uz,rx,ry,rz} (1=linked) — restricts which slave DOFs are linked.
  addLink(props = {}) {
    const id = this._next('links');
    const link = {
      id, name: props.name || `Link ${id}`,
      master: props.master ?? null, slave: props.slave ?? null,
      rigid: props.rigid !== false,   // rigid by default
      dofs: { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1, ...(props.dofs || {}) },
    };
    this.links.set(id, link);
    return link;
  }
  updateLink(id, props) {
    const l = this.links.get(id); if (!l) return null;
    if (props.master !== undefined) l.master = +props.master;
    if (props.slave  !== undefined) l.slave  = +props.slave;
    if (props.rigid  !== undefined) l.rigid  = !!props.rigid;
    if (props.dofs) Object.assign(l.dofs, props.dofs);
    if (props.name  !== undefined) l.name = props.name;
    return l;
  }
  removeLink(id) { return this.links.delete(id); }

  // ── Load Cases ─────────────────────────────────────────────────────────────
  // selfWeight: if true, this case's analysis includes the self-weight of all
  // elements (typical of the CM / dead-load case).
  // type: 'static' (assigned loads, F5) or 'spectrum' (seismic by response
  // spectrum, F7). A spectral case admits no loads; specDir = 'X' | 'Y'.
  addLoadCase(name, selfWeight = false, type = 'static', specDir = null, loadType = null) {
    const id = this._next('loadCases');
    const lc = {
      id, name: name || `LC${id}`, loads: [],
      selfWeight: !!selfWeight,
      type: type === 'spectrum' ? 'spectrum' : 'static',
      specDir: type === 'spectrum' ? (specDir || 'X') : null,
      // Load category (for automatic combinations and design): dead/live/
      // wind/seismic/snow/temperature/other.  Inferred from the case by default.
      loadType: loadType || (type === 'spectrum' ? 'seismic' : (selfWeight ? 'dead' : 'other')),
    };
    this.loadCases.set(id, lc);
    return lc;
  }

  // ── Load Combinations ──────────────────────────────────────────────────────
  addCombination(props) {
    const id = this._next('combinations');
    const combo = { id, name: `Combo ${id}`, factors: [], ...props };
    this.combinations.set(id, combo);
    return combo;
  }

  updateCombination(id, props) {
    const c = this.combinations.get(id);
    if (!c) return null;
    Object.assign(c, props);
    return c;
  }

  removeCombination(id) { return this.combinations.delete(id); }

  addLoad(caseId, load) {
    const lc = this.loadCases.get(caseId);
    if (!lc) return null;
    lc.loads.push(load);
    return load;
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  _firstKey(mapName) {
    return this[mapName].keys().next().value ?? null;
  }

  getStats() {
    return {
      nodes:      this.nodes.size,
      elements:   this.elements.size,
      materials:  this.materials.size,
      sections:   this.sections.size,
      diaphragms: this.diaphragms.size
    };
  }

  // Bounding box of all nodes {min:{x,y,z}, max:{x,y,z}, center:{x,y,z}}
  getBounds() {
    if (this.nodes.size === 0) {
      return { min:{x:0,y:0,z:0}, max:{x:10,y:10,z:10}, center:{x:5,y:5,z:5} };
    }
    let xMin=Infinity, yMin=Infinity, zMin=Infinity;
    let xMax=-Infinity, yMax=-Infinity, zMax=-Infinity;
    for (const n of this.nodes.values()) {
      if (n.x < xMin) xMin = n.x; if (n.x > xMax) xMax = n.x;
      if (n.y < yMin) yMin = n.y; if (n.y > yMax) yMax = n.y;
      if (n.z < zMin) zMin = n.z; if (n.z > zMax) zMax = n.z;
    }
    return {
      min: {x:xMin, y:yMin, z:zMin},
      max: {x:xMax, y:yMax, z:zMax},
      center: {x:(xMin+xMax)/2, y:(yMin+yMax)/2, z:(zMin+zMax)/2}
    };
  }

  // Reset data but keep materials and sections
  clear() {
    this.nodes.clear();
    this.elements.clear();
    this.diaphragms.clear();
    this.loadCases.clear();
    this.combinations.clear();
    this.links.clear();
    this._cnt.nodes = 0;
    this._cnt.elements = 0;
    this._cnt.diaphragms = 0;
    this._cnt.loadCases = 0;
    this._cnt.combinations = 0;
    this._cnt.links = 0;
  }

  // Full reset including materials and sections
  reset() {
    this.clear();
    this.materials.clear();
    this.sections.clear();
    this._cnt.materials = 0;
    this._cnt.sections = 0;
    this._initDefaults();
  }
}
