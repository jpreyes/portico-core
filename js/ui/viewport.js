// ──────────────────────────────────────────────────────────────────────────────
// Viewport — Three.js 3D scene, interaction, rendering
// Coordinate convention:
//   Model:     X east, Y north, Z up  (SAP2000 / ETABS)
//   Three.js:  X east, Y up,  Z south (Y-up default)
//   Transform: m2t(x,y,z) → (x, z, y)   t2m(v) → {x:v.x, y:v.z, z:v.y}
// ──────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { i18n } from '../i18n/i18n.js?v=2';

const COL = {
  BG:          0x0a0e1a,
  GRID_MAIN:   0x334,
  GRID_CENTER: 0x445577,
  NODE:        0x4fc3f7,
  NODE_HOVER:  0xff9800,
  NODE_SEL:    0xffc107,
  NODE_FIXED:  0xef5350,
  NODE_PIN:    0xff7043,
  ELEM:        0x607d8b,
  ELEM_HOVER:  0xff9800,
  ELEM_SEL:    0xffc107,
  AREA:        0x3b82f6,
  AREA_HOVER:  0xff9800,
  AREA_SEL:    0xffc107,
  PREVIEW:     0x64b5f6,
  AXIS_X:      0xff4444,
  AXIS_Y:      0x44cc44,
  AXIS_Z:      0x4488ff,
};
const NODE_R      = 0.08;   // VISUAL node radius (the selection area is larger, see _pickNodes)
const NODE_SEG    = 8;
const SNAP_PX     = 22;   // screen-space snap radius in pixels

export class Viewport {
  constructor(container, app) {
    this.container = container;
    this.app = app;
    this.mode = 'select';

    // Node dragging (#79) + work plane (#28): the "Plano" selector (xy|xz|yz) is
    // both the drag plane AND the plane where new nodes/bars land in 3D.
    this._dragPlane = 'xy';
    this._dragLock  = false;   // #79 anti-drag safety (kept as its own checkbox)
    // Work-plane offset along the plane normal (grid-free modeling, #28):
    //   xy → model Z (= _floorZ),  xz → model Y,  yz → model X.
    this._planeYOff = 0;       // offset for the XZ work plane (model Y)
    this._planeXOff = 0;       // offset for the YZ work plane (model X)
    this._planeLock = false;   // "Fijar": lock camera to the work plane (true 2D)
    // Meshing by mode (#78): outline nodes in progress + type (free|panel).
    this._meshPick  = [];
    this._meshKind  = 'free';

    this._renderer = null;
    this._scene    = null;
    this._camera   = null;
    this._controls = null;

    this._nodeMeshes  = new Map();  // nodeId  → THREE.Mesh
    this._elemLines   = new Map();  // elemId  → THREE.Line
    this._areaMeshes  = new Map();  // areaId  → THREE.Group (fill + border)
    this._suppGroups  = new Map();  // nodeId  → THREE.Group
    this._diaGroups   = new Map();  // diaphragmId → THREE.Group
    this._linkGroups  = new Map();  // linkId   → THREE.Group

    this._selected = new Set();     // 'node:id' | 'elem:id'
    this._hiddenElems = new Set();  // hidden elemId(s) (view state)
    this._hovered  = null;          // {type, id} | null

    this._addElemFirst = null;      // nodeId of first endpoint
    this._previewSphere = null;
    this._previewLine   = null;
    this._floorZ   = 0;
    this._snapSize = 0.5;

    this._mouse       = new THREE.Vector2(-999, -999);
    this._raycaster   = new THREE.Raycaster();
    this._raycaster.params.Line  = { threshold: 0.18 };
    this._raycaster.params.Points = { threshold: 0.18 };

    this._ptrDownPos  = null;       // for distinguishing click vs drag
    this._grid        = null;
    this._axesGroup   = null;

    // Mode shape animation state
    this._animFn         = null;    // callback called each frame (null = no animation)
    this._animT          = 0;
    this._animMeshNodes  = [];      // [{mesh, pbase, dp}]
    this._animLineElems  = [];      // [{geo, p1base, p2base, dp1, dp2}]

    // Load visualization
    this._loadObjects = [];         // THREE objects for load arrows

    // P2-6: node/element ID sprites
    this._showIds   = false;
    this._idSprites = [];

    // P4-13: extruded section objects
    this._showExtruded    = false;
    this._extrudedObjects = [];
    this._extrusionLight  = null;

    // P3-10: node drag state
    this._dragNode     = null;
    this._dragStartPos = null;
    this._isDragging   = false;

    // Results state
    this._results             = null;
    this._currentDiagramType  = null;

    // Inspector panel
    this._inspPanel  = null;
    this._inspElemId = null;
    this._inspXi     = 0.5;
    this._inspType   = 'Mz';
    this._inspDragOffset = null;

    this._init();
  }

  // ── Coordinate transforms ──────────────────────────────────────────────────
  m2t(x, y, z) { return new THREE.Vector3(x, z, y); }
  t2m(v)       { return { x: v.x, y: v.z, z: v.y }; }

  // ── Initialization ─────────────────────────────────────────────────────────
  _init() {
    // Renderer
    this._renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setClearColor(COL.BG, 1);
    this.container.appendChild(this._renderer.domElement);

    // Cameras: perspective (free 3D) and orthographic (true 2D / elevations)
    this._cameraPersp = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
    this._cameraPersp.position.set(12, 10, 12);
    this._cameraPersp.lookAt(0, 0, 0);
    this._cameraOrtho = new THREE.OrthographicCamera(-10, 10, 10, -10, -1e5, 1e5);
    this._camera = this._cameraPersp;
    this._elevation = null;   // active 2D elevation {axis, coord, name} | null

    // Scene
    this._scene = new THREE.Scene();
    this._scene.add(new THREE.AmbientLight(0xffffff, 1));

    // Controls
    this._controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._controls.enableDamping  = true;
    this._controls.dampingFactor  = 0.08;
    this._controls.screenSpacePanning = true;
    this._controls.zoomSpeed      = 1.4;
    this._controls.enableZoom     = true;
    this._controls.enablePan      = true;
    // 3D: left=orbit, right=pan, middle=zoom. (In 2D the left button switches to pan.)
    this._MB_3D = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this._MB_2D = { LEFT: THREE.MOUSE.PAN,    MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this._controls.mouseButtons   = this._MB_3D;

    // Grid (Three.js XZ plane = model XY floor)
    this._buildGrid();

    // Axis arrows
    this._buildAxes();

    // Invisible floor plane for raycasting
    this._floorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1e6, 1e6),
      new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
    );
    this._floorMesh.rotation.x = -Math.PI / 2;
    this._scene.add(this._floorMesh);

    // Preview objects
    this._buildPreview();

    // Bind events
    const el = this._renderer.domElement;
    el.addEventListener('pointermove', e => this._onMove(e));
    el.addEventListener('pointerdown', e => this._onDown(e));
    el.addEventListener('pointerup',   e => this._onUp(e));
    el.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('resize',  () => this._onResize());
    // True responsiveness: follow the CONTAINER's size (side panel, layout…),
    // not just the window resize.
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this._onResize());
      this._ro.observe(this.container);
    }
    this._onResize();

    // Offset field (#28): reused as the offset of the ACTIVE work plane. Its value
    // means model Z when the plane is XY, model Y when XZ, model X when YZ.
    document.getElementById('floor-z').addEventListener('input', e => {
      const v = parseFloat(e.target.value) || 0;
      const p = this._dragPlane || 'xy';
      if (p === 'xz')      this._planeYOff = v;
      else if (p === 'yz') this._planeXOff = v;
      else {
        this._floorZ = v;
        this._floorMesh.position.y = this._floorZ;
        if (this._grid) this._grid.position.y = this._floorZ;
      }
    });
    document.getElementById('snap-size').addEventListener('input', e => {
      this._snapSize = Math.max(0, parseFloat(e.target.value) || 0);
    });
    // Snap-to-node magnet when creating elements (on by default).
    this._magnetSnap = true;
    document.getElementById('magnet-snap')?.addEventListener('change', e => {
      this._magnetSnap = e.target.checked;
    });
    // Anti-drag safety (#79): impede mover nodos al arrastrarlos.
    document.getElementById('drag-lock')?.addEventListener('change', e => {
      this._dragLock = e.target.checked;
    });
    // Work plane (#28): the "Plano" selector drives both drag and node insertion.
    document.getElementById('drag-plane')?.addEventListener('change', e => {
      this.setWorkPlane(e.target.value);   // 'xy' | 'xz' | 'yz'
    });
    // "Fijar" (#28): lock the camera to the work plane → draw in true 2D on it.
    document.getElementById('plane-lock')?.addEventListener('change', e => {
      this._applyPlaneLock(e.target.checked);
    });
    this._updatePlaneOffsetLabel();

    // Escape cancels addelem
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (this._addElemFirst !== null) {
          this._refreshColor('node', this._addElemFirst);
          this._addElemFirst = null;
          this._previewLine.visible = false;
          document.getElementById('sb-sel').textContent = i18n.t('Sin selección');
        }
        if (this.mode === 'addarea' && this._areaPick?.length) {
          this._cancelAreaPick();
          document.getElementById('sb-sel').textContent = i18n.t('Área: selección reiniciada');
        }
        if (this.mode === 'meshpick' && this._meshPick?.length) {
          this._cancelMeshPick();
          document.getElementById('sb-sel').textContent = i18n.t('Mallado: selección reiniciada');
        }
        // Cancel a rubber-band in progress (#80).
        if (this._rubber) { this._hideRubberBox(); this._rubber = null; this._controls.enabled = true; }
      }
      if (e.key === 'Enter' && this.mode === 'addarea')  { e.preventDefault(); this._finishArea(); }
      if (e.key === 'Enter' && this.mode === 'meshpick') { e.preventDefault(); this._finishMeshPick(); }
    });

    this._animate();
  }

  _buildGrid(center = COL.GRID_CENTER, minor = COL.GRID_MAIN) {
    this._grid = new THREE.Group();
    const main = new THREE.GridHelper(200, 200, center, minor);
    main.material.transparent = true;
    main.material.opacity = 0.38;   // faint grid → not confused with the elements
    this._grid.add(main);
    this._scene.add(this._grid);
  }

  /** Light/dark theme: adjusts the canvas background and the grid. */
  setTheme(isLight) {
    // Light: muted blue-gray (not pure white) so as not to dazzle.
    this._renderer?.setClearColor(isLight ? 0xd6dbe4 : COL.BG, 1);
    if (this._grid) {
      this._scene.remove(this._grid);
      this._grid.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    }
    this._buildGrid(isLight ? 0x8b9cb2 : COL.GRID_CENTER, isLight ? 0xbcc6d5 : COL.GRID_MAIN);
  }

  _buildAxes() {
    this._axesGroup = new THREE.Group();
    const len = 2.5, hw = 0.5, hr = 0.15;

    const axesDef = [
      { dir: new THREE.Vector3(1, 0, 0), col: COL.AXIS_X, label: 'X' },  // model X → Three.js +X
      { dir: new THREE.Vector3(0, 0, 1), col: COL.AXIS_Y, label: 'Y' },  // model Y → Three.js +Z
      { dir: new THREE.Vector3(0, 1, 0), col: COL.AXIS_Z, label: 'Z' },  // model Z(up) → Three.js +Y
    ];
    for (const { dir, col, label } of axesDef) {
      this._axesGroup.add(new THREE.ArrowHelper(dir, new THREE.Vector3(0,0,0), len, col, hw, hr));
      const cssCol = '#' + col.toString(16).padStart(6, '0');
      const sp = this._makeAxisLabel(label, cssCol);
      sp.position.copy(dir.clone().multiplyScalar(len + 0.48));
      this._axesGroup.add(sp);
    }
    this._scene.add(this._axesGroup);
  }

  _makeAxisLabel(text, cssColor) {
    const canvas = document.createElement('canvas');
    canvas.width = 48; canvas.height = 48;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 48, 48);
    ctx.font = 'bold 32px sans-serif';
    ctx.fillStyle = cssColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 24, 26);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sp  = new THREE.Sprite(mat);
    sp.scale.set(0.55, 0.55, 1);
    return sp;
  }

  /** Canvas-based sprite label for diagram max/min values */
  _makeDiagramLabel(text, pos) {
    const W = 140, H = 30;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(10,14,26,0.72)';
    ctx.fillRect(0, 0, W, H);
    ctx.font = 'bold 17px sans-serif';
    ctx.fillStyle = '#ffee58';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, H / 2);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sp  = new THREE.Sprite(mat);
    sp.scale.set(1.4, 0.3, 1);
    sp.position.copy(pos);
    return sp;
  }

  _buildPreview() {
    // Ghost sphere (addnode / addelem)
    this._previewSphere = new THREE.Mesh(
      new THREE.SphereGeometry(NODE_R * 1.3, NODE_SEG, NODE_SEG),
      new THREE.MeshBasicMaterial({ color: COL.PREVIEW, transparent: true, opacity: 0.55, depthTest: false })
    );
    this._previewSphere.visible = false;
    this._scene.add(this._previewSphere);

    // Ghost line (addelem after first node)
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this._previewLine = new THREE.Line(geo,
      new THREE.LineBasicMaterial({ color: COL.PREVIEW, transparent: true, opacity: 0.5, depthTest: false })
    );
    this._previewLine.visible = false;
    this._scene.add(this._previewLine);
  }

  // ── Render loop ────────────────────────────────────────────────────────────
  _animate() {
    requestAnimationFrame(() => this._animate());
    if (this._animFn) this._animFn();
    this._controls.update();
    this._renderer.render(this._scene, this._camera);
  }

  _onResize() {
    const w = this.container.clientWidth  || 800;
    const h = this.container.clientHeight || 600;
    this._renderer.setSize(w, h, false);
    this._cameraPersp.aspect = w / h;
    this._cameraPersp.updateProjectionMatrix();
    if (this._cameraOrtho) {
      const halfH = (this._cameraOrtho.top - this._cameraOrtho.bottom) / 2;
      this._cameraOrtho.left  = -halfH * (w / h);
      this._cameraOrtho.right =  halfH * (w / h);
      this._cameraOrtho.updateProjectionMatrix();
    }
  }

  // ── Model rendering ────────────────────────────────────────────────────────
  renderModel(model) {
    // Model swap must not leave the PREVIOUS model's results overlay (deformed
    // shape / diagrams / contours) floating on screen (#32). Some load paths
    // (newFile, openFile) call renderModel without a prior clearResults(), so we
    // drop that layer here — stop the animation and exit results mode defensively.
    if (this._resultObjects && this._resultObjects.length) {
      for (const obj of this._resultObjects) this._scene.remove(obj);
    }
    this._resultObjects = [];
    this._animFn = null;
    this._animMeshNodes = [];
    this._animLineElems = [];
    if (this._inResultsMode) {
      this._inResultsMode = false;
      this._currentDiagramType = null;
      document.getElementById('results-banner')?.classList.remove('visible');
      document.getElementById('results-overlay')?.classList.add('hidden');
      document.getElementById('modal-analysis-overlay')?.classList.add('hidden');
      const cbw = document.getElementById('colorbar-wrap');
      if (cbw) cbw.style.display = 'none';
    }

    // Clear all model objects
    for (const m of this._nodeMeshes.values()) this._scene.remove(m);
    for (const l of this._elemLines.values())  this._scene.remove(l);
    for (const g of this._areaMeshes.values())  this._scene.remove(g);
    for (const g of this._suppGroups.values())  this._scene.remove(g);
    if (this._hingeSprites) {
      for (const g of this._hingeSprites.values()) this._scene.remove(g);
      this._hingeSprites.clear();
    }
    if (this._springSymbols) {
      for (const g of this._springSymbols.values()) this._scene.remove(g);
      this._springSymbols.clear();
    }
    this.clearReactions();
    this._nodeMeshes.clear();
    this._elemLines.clear();
    this._areaMeshes.clear();
    this._scwbMarked = null;   // SCWB markers (#68) — rebuilt on re-check
    this._suppGroups.clear();
    this._selected.clear();
    this._hovered = null;
    this._addElemFirst = null;
    this._previewLine.visible   = false;
    this._previewSphere.visible = false;

    this._recomputeMeshNodeSet(model);   // classifies mesh nodes (#81) before drawing
    for (const n of model.nodes.values())    this.addNodeMesh(n);
    for (const e of model.elements.values()) this.addElemLine(e);
    for (const a of (model.areas?.values() || [])) this.addAreaMesh(a);
    this.refreshDiaphragms();
    this.refreshLinks();
    this.refreshGridAxes();
    this.refreshElevationOptions();
    if (this._elevation) this._applyElevationFilter();
    // Refresh ID sprites if they were visible
    if (this._showIds) { this._showIds = false; this.toggleIds(); }
  }

  // Set of "mesh" nodes (#81): used by areas but by no member.
  // Recomputed on each renderModel; nodes created afterwards (point editing) are not
  // mesh nodes, and the next render reclassifies them if they become so.
  _recomputeMeshNodeSet(model) {
    const beam = new Set();
    for (const e of model.elements.values()) { beam.add(e.n1); beam.add(e.n2); }
    const mesh = new Set();
    for (const a of (model.areas?.values() || [])) {
      for (const nid of (a.nodes || [])) if (!beam.has(nid)) mesh.add(nid);
    }
    this._meshNodeIds = mesh;
  }

  addNodeMesh(node) {
    if (this._nodeMeshes.has(node.id)) {
      this._scene.remove(this._nodeMeshes.get(node.id));
    }
    // Nodes generated by meshing (#81): drawn a bit smaller than "model" nodes so as
    // not to clutter the view. A node is a "mesh" node if used by areas but NO member
    // (corner nodes shared with members stay large).
    const r = (this._meshNodeIds && this._meshNodeIds.has(node.id)) ? NODE_R * 0.55 : NODE_R;
    const geo  = new THREE.SphereGeometry(r, NODE_SEG, NODE_SEG);
    const mat  = new THREE.MeshBasicMaterial({ color: this._nodeColor(node) });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(this.m2t(node.x, node.y, node.z));
    mesh.userData = { type: 'node', id: node.id };
    this._scene.add(mesh);
    this._nodeMeshes.set(node.id, mesh);

    // Support symbol
    if (this._hasAnyRestraint(node)) this._buildSuppSymbol(node);
    else {
      const g = this._suppGroups.get(node.id);
      if (g) { this._scene.remove(g); this._suppGroups.delete(node.id); }
    }
    // Spring (elastic support) symbol
    this._buildSpringSymbol(node);
  }

  removeNodeMesh(nodeId) {
    const m = this._nodeMeshes.get(nodeId);
    if (m) { this._scene.remove(m); this._nodeMeshes.delete(nodeId); }
    const g = this._suppGroups.get(nodeId);
    if (g) { this._scene.remove(g); this._suppGroups.delete(nodeId); }
    const sg = this._springSymbols?.get(nodeId);
    if (sg) { this._scene.remove(sg); this._springSymbols.delete(nodeId); }
    // Also remove element lines connected to this node
    for (const [eid, line] of this._elemLines) {
      if (line.userData.n1 === nodeId || line.userData.n2 === nodeId) {
        this._scene.remove(line);
        this._elemLines.delete(eid);
        this._removeHingeMarkers(eid);
      }
    }
    this._selected.delete(`node:${nodeId}`);
  }

  addElemLine(elem) {
    if (this._elemLines.has(elem.id)) this._scene.remove(this._elemLines.get(elem.id));
    const n1 = this.app.model.nodes.get(elem.n1);
    const n2 = this.app.model.nodes.get(elem.n2);
    if (!n1 || !n2) return;

    const geo  = new THREE.BufferGeometry().setFromPoints([
      this.m2t(n1.x, n1.y, n1.z), this.m2t(n2.x, n2.y, n2.z)
    ]);
    const mat  = new THREE.LineBasicMaterial({ color: COL.ELEM });
    const line = new THREE.Line(geo, mat);
    line.userData = { type: 'elem', id: elem.id, n1: elem.n1, n2: elem.n2 };
    if (this._hiddenElems.has(elem.id)) line.visible = false;   // respects hidden ones on re-render
    this._scene.add(line);
    this._elemLines.set(elem.id, line);
    this._buildHingeMarkers(elem);
  }

  // ── Area elements (CST/QUAD membrane) ─────────────────────────────────────
  addAreaMesh(area, color = null) {
    this.removeAreaMesh(area.id);
    const pts = area.nodes.map(id => { const n = this.app.model.nodes.get(id); return n ? this.m2t(n.x, n.y, n.z) : null; });
    if (pts.some(p => !p)) return;
    const grp = new THREE.Group();
    // fill (triangulated): tri = [0,1,2]; quad = [0,1,2, 0,2,3]
    const idx = pts.length === 3 ? [0, 1, 2] : [0, 1, 2, 0, 2, 3];
    const pos = []; for (const k of idx) pos.push(pts[k].x, pts[k].y, pts[k].z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: color ?? 0x3b82f6, transparent: true, opacity: color != null ? 0.85 : 0.22,
      side: THREE.DoubleSide, depthWrite: false,
    }));
    fill.userData = { type: 'area', id: area.id };
    grp.add(fill);
    // border
    const loop = [...pts, pts[0]];
    const edge = new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop),
      new THREE.LineBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.7 }));
    edge.userData = { type: 'area', id: area.id };
    grp.add(edge);
    grp.userData = { type: 'area', id: area.id };
    this._scene.add(grp);
    this._areaMeshes.set(area.id, grp);
  }

  removeAreaMesh(areaId) {
    const g = this._areaMeshes.get(areaId);
    if (g) { this._scene.remove(g); this._areaMeshes.delete(areaId); }
  }

  // Colors the area elements by von Mises with NODAL SMOOTHING (BESTFIT):
  // per-vertex color = averaged nodal vM → continuous interpolated contour.
  // dispScale > 0 draws the faces in their DEFORMED position (nodes move with the
  // result displacements); 0 = original geometry.
  colorAreasByVM(results, dispScale = 0) {
    const model = this.app.model;
    if (!model.areas || model.areas.size === 0 || !results || typeof results.getNodalAreaVM !== 'function') return;
    const nodal = results.getNodalAreaVM();
    this._areaVMnodal = nodal;   // #36: cached for the hover min/max tooltip
    let mn = Infinity, mx = -Infinity;
    for (const v of nodal.values()) { if (v < mn) mn = v; if (v > mx) mx = v; }
    if (!isFinite(mn)) return;
    const span = (mx - mn) || 1;
    // Position (deformed or not) of a node in Three.js coords.
    const dispFn = (dispScale && typeof results.getDeformedCoords === 'function')
      ? (id => { const c = results.getDeformedCoords(id, dispScale); return this.m2t(c.x, c.y, c.z); })
      : null;
    for (const a of model.areas.values()) this.addAreaMeshSmooth(a, nodal, mn, span, dispFn);
    this._areaVMrange = [mn, mx];
    this._drawColorbar(mn, mx);   // von Mises color bar (overwrites the δ one)
  }

  // Same as addAreaMesh but with per-vertex color (nodal smoothing).
  // dispFn(nodeId) → THREE.Vector3 already in Three.js coords (deformed); if null
  // the node's original position is used.
  addAreaMeshSmooth(area, nodal, mn, span, dispFn = null) {
    this.removeAreaMesh(area.id);
    const pts = area.nodes.map(id => {
      if (dispFn) return dispFn(id);
      const n = this.app.model.nodes.get(id); return n ? this.m2t(n.x, n.y, n.z) : null;
    });
    if (pts.some(p => !p)) return;
    const cols = area.nodes.map(id => new THREE.Color(_dispColor(((nodal.get(id) ?? mn) - mn) / span)));
    const idx = pts.length === 3 ? [0, 1, 2] : [0, 1, 2, 0, 2, 3];
    const pos = [], col = [];
    for (const k of idx) { pos.push(pts[k].x, pts[k].y, pts[k].z); col.push(cols[k].r, cols[k].g, cols[k].b); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const grp = new THREE.Group();
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    fill.userData = { type: 'area', id: area.id };
    grp.add(fill);
    const loop = [...pts, pts[0]];
    grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop), new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.5 })));
    grp.userData = { type: 'area', id: area.id };
    this._scene.add(grp);
    this._areaMeshes.set(area.id, grp);
  }

  resetAreaColors() {
    const model = this.app.model;
    if (model.areas) for (const a of model.areas.values()) this.addAreaMesh(a);
    this._areaVMrange = null;
    this._areaVMnodal = null;
  }

  removeElemLine(elemId) {
    const l = this._elemLines.get(elemId);
    if (l) { this._scene.remove(l); this._elemLines.delete(elemId); }
    this._removeHingeMarkers(elemId);
    this._selected.delete(`elem:${elemId}`);
  }

  // ── Release markers (hinges) ────────────────────────────────────────────────
  // Green circle  = released rotation (moment hinge: T/My/Mz)
  // Amber square  = released translation (N/Vy/Vz)
  // Drawn near the corresponding end of the element.
  _hingeTexture(kind) {
    if (!this._hingeTexCache) this._hingeTexCache = {};
    if (this._hingeTexCache[kind]) return this._hingeTexCache[kind];
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.lineWidth = 7;
    if (kind === 'rot') {
      g.strokeStyle = '#4ade80';
      g.fillStyle = 'rgba(7,10,15,0.92)';
      g.beginPath(); g.arc(32, 32, 23, 0, Math.PI * 2); g.fill(); g.stroke();
    } else {
      g.strokeStyle = '#fbbf24';
      g.fillStyle = 'rgba(7,10,15,0.92)';
      g.fillRect(12, 12, 40, 40); g.strokeRect(12, 12, 40, 40);
    }
    const tex = new THREE.CanvasTexture(c);
    this._hingeTexCache[kind] = tex;
    return tex;
  }

  _removeHingeMarkers(elemId) {
    const g = this._hingeSprites?.get(elemId);
    if (g) { this._scene.remove(g); this._hingeSprites.delete(elemId); }
  }

  _buildHingeMarkers(elem) {
    if (!this._hingeSprites) this._hingeSprites = new Map();
    this._removeHingeMarkers(elem.id);
    const rel = elem.releases;
    if (!rel || !rel.some(r => r)) return;
    const n1 = this.app.model.nodes.get(elem.n1);
    const n2 = this.app.model.nodes.get(elem.n2);
    if (!n1 || !n2) return;

    const p1 = this.m2t(n1.x, n1.y, n1.z);
    const p2 = this.m2t(n2.x, n2.y, n2.z);
    const group = new THREE.Group();
    const L3 = p1.distanceTo(p2);
    const s  = Math.min(Math.max(L3 * 0.08, 0.14), 0.5);

    const addMark = (t, kind, lift) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._hingeTexture(kind), depthTest: false, transparent: true
      }));
      sp.position.copy(p1.clone().lerp(p2, t));
      if (lift) sp.position.y += s * 1.05;   // separates symbols if they coincide
      sp.scale.set(s, s, 1);
      sp.renderOrder = 5;
      group.add(sp);
    };

    const endRot   = off => rel.slice(off + 3, off + 6).some(r => r);
    const endTrans = off => rel.slice(off,     off + 3).some(r => r);
    if (endRot(0))   addMark(0.12, 'rot',   false);
    if (endTrans(0)) addMark(0.12, 'trans', endRot(0));
    if (endRot(6))   addMark(0.88, 'rot',   false);
    if (endTrans(6)) addMark(0.88, 'trans', endRot(6));

    this._scene.add(group);
    this._hingeSprites.set(elem.id, group);
  }

  // ── Support reactions (arrows + values) ─────────────────────────────────────
  clearReactions() {
    for (const o of this._reactionObjects || []) this._scene.remove(o);
    this._reactionObjects = [];
  }

  showReactions(results) {
    this.clearReactions();
    if (!results) return;
    const model = this.app.model;

    // nodes with a rigid support or spring
    const suppNodes = [...model.nodes.values()].filter(n =>
      Object.values(n.restraints || {}).some(v => v) ||
      (n.springs && Object.values(n.springs).some(k => k > 0)));
    if (!suppNodes.length) return;

    // maximum magnitudes to scale the arrows
    const data = suppNodes.map(n => ({ n, r: results.getReaction(n.id) }));
    let maxF = 0, maxM = 0;
    for (const { r } of data) {
      for (let i = 0; i < 3; i++) maxF = Math.max(maxF, Math.abs(r[i]));
      for (let i = 3; i < 6; i++) maxM = Math.max(maxM, Math.abs(r[i]));
    }
    if (maxF < 1e-9 && maxM < 1e-9) return;

    const b = model.getBounds();
    const span = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, 1);
    const baseLen = span * 0.18;
    const TOL_F = Math.max(maxF * 1e-4, 1e-6);
    const TOL_M = Math.max(maxM * 1e-4, 1e-6);

    // model axes → Three.js (x→x, y→z, z→y)
    const AXES3 = [
      new THREE.Vector3(1, 0, 0),   // model X
      new THREE.Vector3(0, 0, 1),   // model Y
      new THREE.Vector3(0, 1, 0),   // model Z
    ];
    const F_LBL = ['Rx', 'Ry', 'Rz'], M_LBL = ['Mx', 'My', 'Mz'];
    const fmt = v => Math.abs(v) >= 1000 ? v.toFixed(0) : +v.toPrecision(4);

    for (const { n, r } of data) {
      const origin = this.m2t(n.x, n.y, n.z);

      // Forces (orange) — arrow pointing toward the node (as a reaction)
      for (let i = 0; i < 3; i++) {
        if (Math.abs(r[i]) < TOL_F) continue;
        const dir = AXES3[i].clone().multiplyScalar(Math.sign(r[i]));
        const len = Math.max(0.25, baseLen * Math.abs(r[i]) / (maxF || 1));
        const tail = origin.clone().addScaledVector(dir, -len);
        const arrow = new THREE.ArrowHelper(dir, tail, len, 0xffa726, len * 0.3, len * 0.14);
        this._scene.add(arrow);
        this._reactionObjects.push(arrow);
        const lbl = this._makeValSprite(`${F_LBL[i]}=${fmt(r[i])}`, '#ffa726');
        lbl.position.copy(tail).addScaledVector(dir, -0.12).add(new THREE.Vector3(0, 0.16, 0));
        this._scene.add(lbl);
        this._reactionObjects.push(lbl);
      }

      // Moments (violet) — double-headed arrow along the moment axis
      for (let i = 3; i < 6; i++) {
        if (Math.abs(r[i]) < TOL_M) continue;
        const ax = i - 3;
        const dir = AXES3[ax].clone().multiplyScalar(Math.sign(r[i]));
        const len = Math.max(0.22, baseLen * 0.8 * Math.abs(r[i]) / (maxM || 1));
        const tail = origin.clone().addScaledVector(dir, -len);
        const a1 = new THREE.ArrowHelper(dir, tail, len, 0xce93d8, len * 0.26, len * 0.12);
        const a2 = new THREE.ArrowHelper(dir, tail, len * 0.82, 0xce93d8, len * 0.26, len * 0.12);
        this._scene.add(a1); this._scene.add(a2);
        this._reactionObjects.push(a1, a2);
        const lbl = this._makeValSprite(`${M_LBL[ax]}=${fmt(r[i])}`, '#ce93d8');
        lbl.position.copy(tail).addScaledVector(dir, -0.12).add(new THREE.Vector3(0, -0.16, 0));
        this._scene.add(lbl);
        this._reactionObjects.push(lbl);
      }
    }
  }

  // Text sprite for numeric values (wider than the ID one)
  _makeValSprite(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 36;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(7,10,15,0.85)';
    ctx.fillRect(0, 0, 160, 36);
    ctx.font = 'bold 17px monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, 80, 25);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.5, 0.34, 1);
    sprite.renderOrder = 6;
    return sprite;
  }

  // ── Elastic support symbol (zigzag spring below the node) ──────────────────
  _buildSpringSymbol(node) {
    if (!this._springSymbols) this._springSymbols = new Map();
    const prev = this._springSymbols.get(node.id);
    if (prev) { this._scene.remove(prev); this._springSymbols.delete(node.id); }

    const sp = node.springs;
    if (!sp || !Object.values(sp).some(k => k > 0)) return;

    const s = 0.45;          // symbol size
    const col = 0x2dd4bf;
    const group = new THREE.Group();
    const abajo = new THREE.Vector3(0, -1, 0);   // the base zig-zag is drawn toward −Y

    // Builds a spring (zig-zag + plate) oriented from the node toward 'dir'.
    const mkResorte = (dir) => {
      const pts = [
        [0, 0], [0, -0.18], [0.5, -0.30], [-0.5, -0.46], [0.5, -0.62],
        [-0.5, -0.78], [0, -0.90], [0, -1.05],
      ].map(([x, y]) => new THREE.Vector3(x * s * 0.5, y * s, 0));
      const basePts = [new THREE.Vector3(-s * 0.4, -1.05 * s, 0), new THREE.Vector3(s * 0.4, -1.05 * s, 0)];
      const g = new THREE.Group();
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col })));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(basePts), new THREE.LineBasicMaterial({ color: col })));
      g.quaternion.setFromUnitVectors(abajo, dir.clone().normalize());   // rotates −Y → dir
      group.add(g);
    };

    // One spring per translation direction with stiffness (model→Three: X→X, Y→Z, Z→Y).
    if (sp.kuz > 0) mkResorte(new THREE.Vector3(0, -1, 0));   // vertical (Z) — as before
    if (sp.kux > 0) mkResorte(new THREE.Vector3(-1, 0, 0));   // horizontal in X
    if (sp.kuy > 0) mkResorte(new THREE.Vector3(0, 0, -1));   // horizontal in Y
    // If there are only rotational springs, show a vertical one as an indicator.
    if (!group.children.length && (sp.krx > 0 || sp.kry > 0 || sp.krz > 0)) mkResorte(new THREE.Vector3(0, -1, 0));
    if (!group.children.length) return;

    group.position.copy(this.m2t(node.x, node.y, node.z));
    this._scene.add(group);
    this._springSymbols.set(node.id, group);
  }

  refreshNode(node) {
    // Update after property edit (position or restraints changed)
    this.addNodeMesh(node);
    // Re-colour any connected element endpoints
    for (const [eid, line] of this._elemLines) {
      if (line.userData.n1 === node.id || line.userData.n2 === node.id) {
        const elem = this.app.model.elements.get(eid);
        if (elem) this.addElemLine(elem);
      }
    }
    // Restore selection highlight if still selected
    if (this._selected.has(`node:${node.id}`)) {
      const mesh = this._nodeMeshes.get(node.id);
      if (mesh) mesh.material.color.set(COL.NODE_SEL);
    }
  }

  refreshElem(elem) {
    this.addElemLine(elem);
    if (this._selected.has(`elem:${elem.id}`)) {
      const line = this._elemLines.get(elem.id);
      if (line) line.material.color.set(COL.ELEM_SEL);
    }
  }

  // ── Support symbol — 3D cones / boxes pointing downward (−Y in Three.js) ──
  _buildSuppSymbol(node) {
    const existing = this._suppGroups.get(node.id);
    if (existing) this._scene.remove(existing);

    const r = node.restraints;
    const transCount = (r.ux ? 1 : 0) + (r.uy ? 1 : 0) + (r.uz ? 1 : 0);
    const rotCount   = (r.rx ? 1 : 0) + (r.ry ? 1 : 0) + (r.rz ? 1 : 0);
    if (transCount === 0 && rotCount === 0) { this._suppGroups.delete(node.id); return; }

    const allFixed   = transCount === 3 && rotCount === 3;
    const transFixed = transCount === 3;
    const partial    = transCount > 0 && !transFixed;

    const grp = new THREE.Group();
    const s = 0.32;

    const addMesh = (geo, col, opacity = 0.85, wireframe = false) => {
      const m = new THREE.Mesh(geo,
        new THREE.MeshBasicMaterial({ color: col, transparent: opacity < 1, opacity, wireframe }));
      grp.add(m);
      return m;
    };
    const addLine = (pts, col, opacity = 1) => {
      const mat = new THREE.LineBasicMaterial({ color: col, transparent: opacity < 1, opacity });
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    };

    if (allFixed) {
      // ── Full fixity (6 DOF): CUBE — RED. Different from the pyramids of the
      //    pinned/roller supports to avoid confusion. ─────────────────────────
      const col = COL.NODE_FIXED;
      const c = s * 1.4;
      const solido = addMesh(new THREE.BoxGeometry(c, c, c), col, 0.3);       // translucent cube
      solido.position.y = -c / 2;
      const wire = addMesh(new THREE.BoxGeometry(c, c, c), col, 0.95, true);  // marked edges
      wire.position.y = -c / 2;

    } else if (transFixed) {
      // ── Pin / Articulado (3 trans): wireframe pyramid + hatch — ORANGE ───
      const col = COL.NODE_PIN;
      const cH  = s * 1.7;
      const cone = addMesh(new THREE.ConeGeometry(s * 0.72, cH, 4, 1), col, 0.75, true);
      cone.rotation.y = Math.PI / 4;
      cone.position.y = -cH / 2;
      const bY = -cH;
      // Horizontal base line (in both X and Z planes)
      addLine([new THREE.Vector3(-s*0.95, bY, 0), new THREE.Vector3(s*0.95, bY, 0)], col);
      addLine([new THREE.Vector3(0, bY, -s*0.95), new THREE.Vector3(0, bY, s*0.95)], col, 0.45);
      // Diagonal hatch below base
      for (let i = 0; i < 5; i++) {
        const t = -s * 0.8 + i * s * 0.4;
        addLine([new THREE.Vector3(t, bY, 0), new THREE.Vector3(t - s*0.24, bY - s*0.42, 0)], col, 0.55);
      }

    } else if (partial) {
      // ── Roller (1–2 trans): pyramid + TWO parallel LINES along each FREE
      //    (sliding) direction, to see what is released. ────────────────────
      const col = 0x00bcd4;
      const cH  = s * 1.1;
      const cone = addMesh(new THREE.ConeGeometry(s * 0.5, cH, 4, 1), col, 0.75, true);
      cone.rotation.y = Math.PI / 4;
      cone.position.y = -cH / 2;
      // FREE translation directions (model → Three.js: X→X, Y→Z, Z→Y)
      const libres = [];
      if (!r.ux) libres.push(new THREE.Vector3(1, 0, 0));   // free in X
      if (!r.uy) libres.push(new THREE.Vector3(0, 0, 1));   // free in Y
      if (!r.uz) libres.push(new THREE.Vector3(0, 1, 0));   // free in Z (vertical)
      const bY = -cH;
      for (const d of libres) {
        // perpendicular offset (to the sides) for the two parallel lines
        let off = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0));
        if (off.lengthSq() < 1e-6) off = new THREE.Vector3(1, 0, 0);   // vertical d
        off.normalize().multiplyScalar(s * 0.55);
        const half = d.clone().multiplyScalar(s * 1.0);
        const base = new THREE.Vector3(0, bY, 0);
        for (const sgn of [1, -1]) {
          const c = off.clone().multiplyScalar(sgn).add(base);
          addLine([c.clone().sub(half), c.clone().add(half)], col, 0.95);
        }
      }

    } else {
      // ── Solo rotaciones: anillo plano — YELLOW ────────────────────────────
      const col = 0xd29922;
      const ring = addMesh(new THREE.TorusGeometry(s * 0.38, s * 0.075, 6, 20), col, 0.85);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -s * 0.05;
    }

    // ── Tooltip label showing which DOFs are fixed ────────────────────────
    const dofLabel = [
      r.ux ? 'Ux' : '', r.uy ? 'Uy' : '', r.uz ? 'Uz' : '',
      r.rx ? 'Rx' : '', r.ry ? 'Ry' : '', r.rz ? 'Rz' : '',
    ].filter(Boolean).join(' ');
    grp.userData = { type: 'support', nodeId: node.id, dofLabel };

    grp.position.copy(this.m2t(node.x, node.y, node.z));
    this._scene.add(grp);
    this._suppGroups.set(node.id, grp);
  }

  // ── Pointer helpers ────────────────────────────────────────────────────────
  _ndc(e) {
    const r = this._renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
       (e.clientX - r.left) / r.width  * 2 - 1,
      -(e.clientY - r.top)  / r.height * 2 + 1
    );
  }

  // Snap of a model coordinate: first to a nearby grid axis (if axes are defined),
  // otherwise rounding to the normal snap grid.
  _snapCoord(v, gridCoords) {
    if (gridCoords && gridCoords.length) {
      let best = null, bd = Infinity;
      for (const g of gridCoords) {
        const d = Math.abs(v - g);
        if (d < bd) { bd = d; best = g; }
      }
      if (best !== null && bd <= Math.max(this._snapSize, 0.3)) return best;
    }
    return this._snapSize > 0 ? Math.round(v / this._snapSize) * this._snapSize : v;
  }

  _floorPoint() {
    const grids = this.app.model.grids || { x: [], y: [], z: [] };
    const pt = new THREE.Vector3();
    const is2D = this.app.model.mode === '2D';
    const elev = this._elevation;

    if (is2D || (elev && elev.axis === 'y')) {
      // Model X–Z plane at y = coord (2D project: y=0; N-axis elevation)
      const yPlane = is2D ? 0 : elev.coord;
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -yPlane);  // three z = model y
      this._raycaster.ray.intersectPlane(plane, pt);
      if (!pt || isNaN(pt.x)) return null;
      pt.x = this._snapCoord(pt.x, grids.x);   // model X
      pt.y = this._snapCoord(pt.y, grids.z);   // three Y = model Z → levels
      pt.z = yPlane;                            // three Z = model Y (fixed to the plane)
      return pt;
    }

    if (elev && elev.axis === 'x') {
      // Model Y–Z plane at x = coord (A/B/C-axis elevation)
      const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -elev.coord);
      this._raycaster.ray.intersectPlane(plane, pt);
      if (!pt || isNaN(pt.x)) return null;
      pt.x = elev.coord;                        // model X fixed to the plane
      pt.y = this._snapCoord(pt.y, grids.z);    // model Z → levels
      pt.z = this._snapCoord(pt.z, grids.y);    // model Y
      return pt;
    }

    // ── Work plane (#28): free 3D modeling on a chosen plane (no grid axes) ──────
    // The "Plano" selector picks where new nodes/bars land. Offset along the plane
    // normal comes from the reused "Z piso" field.
    const wp = this._dragPlane || 'xy';
    if (wp === 'xz') {
      // Model X–Z plane at model Y = offset (three z = model y).
      const off = this._planeYOff || 0;
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -off);
      this._raycaster.ray.intersectPlane(plane, pt);
      if (!pt || isNaN(pt.x)) return null;
      pt.x = this._snapCoord(pt.x, grids.x);   // three X = model X
      pt.y = this._snapCoord(pt.y, grids.z);   // three Y = model Z (levels)
      pt.z = off;                              // three Z = model Y (fixed to plane)
      return pt;
    }
    if (wp === 'yz') {
      // Model Y–Z plane at model X = offset (three x = model x).
      const off = this._planeXOff || 0;
      const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -off);
      this._raycaster.ray.intersectPlane(plane, pt);
      if (!pt || isNaN(pt.x)) return null;
      pt.x = off;                              // three X = model X (fixed to plane)
      pt.y = this._snapCoord(pt.y, grids.z);   // three Y = model Z (levels)
      pt.z = this._snapCoord(pt.z, grids.y);   // three Z = model Y
      return pt;
    }

    // Default: horizontal XY plane at floor Z.
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this._floorZ);
    this._raycaster.ray.intersectPlane(plane, pt);
    if (!pt || isNaN(pt.x)) return null;
    pt.x = this._snapCoord(pt.x, grids.x);     // model X
    pt.z = this._snapCoord(pt.z, grids.y);     // three Z = model Y
    return pt;
  }

  // ── Orthographic / perspective projection ─────────────────────────────────────
  // The TRUE 2D view uses an orthographic camera: no perspective, no depth.
  _setProjection(kind) {
    if (kind === 'ortho') {
      if (!this._cameraOrtho) {
        this._cameraOrtho = new THREE.OrthographicCamera(-10, 10, 10, -10, -1e5, 1e5);
      }
      this._camera = this._cameraOrtho;
    } else {
      this._camera = this._cameraPersp;
    }
    this._controls.object = this._camera;
    this._onResize();
    this._controls.update();
  }

  // Frames the orthographic camera looking at the given plane.
  // axis: 'y' → looks along model −Y (X–Z elevation, the view of a planar frame);
  //       'x' → looks along model −X (Y–Z elevation);
  //       'z' → looks DOWN model +Z (plan / top view, X–Y).
  _fitOrtho(axis, coord = 0) {
    const b = this.app.model.getBounds();
    const dx = b.max.x - b.min.x, dy = b.max.y - b.min.y, dz = b.max.z - b.min.z;
    const c = this.m2t(b.center.x, b.center.y, b.center.z);
    const cam = this._cameraOrtho;
    const aspect = (this.container.clientWidth || 800) / (this.container.clientHeight || 600);
    // Fit to the REAL bounding box in the view plane (width × height), not to a
    // max(span) cube: this way a flat/wide structure (truss, bridge) fills the
    // screen instead of looking like a line.
    const W = (axis === 'x' ? dy : dx);        // horizontal width in the plane
    const H = (axis === 'z' ? dy : dz);        // vertical height in the plane
    const margin = 1.12;
    const half = Math.max((W / aspect) / 2, H / 2, 1) * margin;
    cam.left = -half * aspect; cam.right = half * aspect;
    cam.top  =  half;          cam.bottom = -half;
    cam.zoom = 1;
    const d = Math.max(dx, dy, dz, 8) * 4;
    if (axis === 'x') {
      // look at the Y–Z plane from +X
      cam.position.set(c.x + d, c.y, c.z);
      cam.up.set(0, 1, 0);
    } else if (axis === 'z') {
      // plan/top view: look straight down (model +Z = three +Y); model X to the
      // right, model Y up on screen.
      cam.position.set(c.x, c.y + d, c.z);
      cam.up.set(0, 0, -1);
    } else {
      // look at the X–Z plane from model +Y (= three +Z): front view with global
      // X to the RIGHT and Z (height) up — same as "Frente XZ".
      cam.position.set(c.x, c.y, c.z + d);
      cam.up.set(0, 1, 0);
    }
    cam.lookAt(c);
    cam.updateProjectionMatrix();
    this._controls.target.copy(c);
    this._controls.update();
  }

  // ── Project mode (defined when the model is created) ─────────────────────────
  // 2D: fixed front orthographic camera (true 2D), nodes in the X–Z plane.
  // 3D: free perspective camera (unless an elevation is active).
  applyProjectMode() {
    const is2D = this.app.model.mode === '2D';
    const badge = document.getElementById('mode-badge');
    if (badge) {
      badge.textContent = is2D ? '2D' : '3D';
      badge.title = is2D
        ? 'Modelo 2D: pórtico plano X–Z (cámara ortográfica fija; uy/rx/rz restringidos automáticamente). El modo se elige en Archivo → Nuevo.'
        : 'Modelo 3D: estructura tridimensional. El modo se elige en Archivo → Nuevo.';
      badge.classList.toggle('badge-2d', is2D);
    }
    if (is2D) {
      this._elevation = null;
      this._setProjection('ortho');
      this._fitOrtho('y', 0);
      this._controls.enableRotate = false;
      this._controls.mouseButtons = this._MB_2D;   // drag with left = pan
    } else if (!this._elevation) {
      this._setProjection('persp');
      this._controls.enableRotate = true;
      this._controls.mouseButtons = this._MB_3D;
    }
    this.refreshElevationOptions();
  }

  // ── Elevations by structural axis (true 2D view of an axis, in 3D models) ───
  // spec = { axis:'y'|'x', coord, name } | null (back to free 3D).
  // axis 'y': plane y=coord (axes 1,2,3…) seen from the front (X–Z).
  // axis 'x': plane x=coord (axes A,B,C…) seen from the side (Y–Z).
  setElevation(spec) {
    if (this.app.model.mode === '2D') return;   // does not apply in 2D
    this._elevation = spec || null;
    if (this._elevation) {
      this._setProjection('ortho');
      this._fitOrtho(this._elevation.axis === 'x' ? 'x' : 'y', this._elevation.coord);
      this._controls.enableRotate = false;
      this._controls.mouseButtons = this._MB_2D;   // pan with left in planar view
      this.app.toast(
        `Elevación ${this._elevation.name}: solo se muestra ese plano; los nodos nuevos caen en él. Seleccione "Vista 3D" para volver.`, 'ok');
    } else {
      this._setProjection('persp');
      this._controls.enableRotate = true;
      this._controls.mouseButtons = this._MB_3D;
      this.setView('iso');
    }
    this._applyElevationFilter();
  }

  // Hides everything not belonging to the active elevation plane.
  _applyElevationFilter() {
    const e = this._elevation;
    const TOL = 0.051;
    const onPlane = (n) => !e ||
      (e.axis === 'y' ? Math.abs(n.y - e.coord) <= TOL : Math.abs(n.x - e.coord) <= TOL);

    for (const [id, mesh] of this._nodeMeshes) {
      const n = this.app.model.nodes.get(id);
      const vis = !!n && onPlane(n);
      mesh.visible = vis;
      const sg = this._suppGroups.get(id);    if (sg) sg.visible = vis;
      const sp = this._springSymbols?.get(id); if (sp) sp.visible = vis;
    }
    for (const [eid, line] of this._elemLines) {
      const el = this.app.model.elements.get(eid);
      const n1 = el && this.app.model.nodes.get(el.n1);
      const n2 = el && this.app.model.nodes.get(el.n2);
      const vis = !!(n1 && n2 && onPlane(n1) && onPlane(n2));
      line.visible = vis;
      const hg = this._hingeSprites?.get(eid); if (hg) hg.visible = vis;
    }
  }

  // Fills the elevation selector with the defined grid axes.
  refreshElevationOptions() {
    const sel = document.getElementById('elev-select');
    if (!sel) return;
    const is2D = this.app.model.mode === '2D';
    sel.style.display = is2D ? 'none' : '';
    document.getElementById('elev-label')?.style.setProperty('display', is2D ? 'none' : '');
    if (is2D) return;
    const g = this.app.model.grids || { x: [], y: [] };
    const cur = this._elevation;
    const letter = i => String.fromCharCode(65 + (i % 26));
    let html = `<option value="">Vista 3D</option>`;
    (g.y || []).forEach((c, i) =>
      html += `<option value="y:${c}" ${cur && cur.axis==='y' && cur.coord===c ? 'selected':''}>Eje ${i + 1} (Y=${c})</option>`);
    (g.x || []).forEach((c, i) =>
      html += `<option value="x:${c}" ${cur && cur.axis==='x' && cur.coord===c ? 'selected':''}>Eje ${letter(i)} (X=${c})</option>`);
    sel.innerHTML = html;
  }

  // ── Grid axes (SAP/ETABS style) ──────────────────────────────────────────────
  refreshGridAxes() {
    if (this._gridAxesGroup) { this._scene.remove(this._gridAxesGroup); this._gridAxesGroup = null; }
    const grids = this.app.model.grids;
    if (!grids) return;
    const xs = grids.x || [], ys = grids.y || [], zs = grids.z || [];
    if (!xs.length && !ys.length && !zs.length) return;

    const g = new THREE.Group();
    const b = this.app.model.getBounds();
    const xLo = Math.min(...(xs.length ? xs : [b.min.x]), b.min.x);
    const xHi = Math.max(...(xs.length ? xs : [b.max.x]), b.max.x);
    const yLo = Math.min(...(ys.length ? ys : [b.min.y]), b.min.y);
    const yHi = Math.max(...(ys.length ? ys : [b.max.y]), b.max.y);
    const zLo = zs.length ? Math.min(...zs) : 0;
    const zHi = Math.max(...(zs.length ? zs : [b.max.z]), b.max.z);
    const mX = Math.max((xHi - xLo) * 0.08, 0.8);
    const mY = Math.max((yHi - yLo) * 0.08, 0.8);

    // Sizes PROPORTIONAL to the model: grid labels and the axis triad stop looking
    // gigantic on small/flat structures (trusses, beams).
    const span = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, 1);
    const ls   = Math.min(Math.max(span * 0.028, 0.16), 0.9);   // label height
    const off  = ls * 1.4;                                       // label–line spacing
    this._axesGroup?.scale.setScalar(Math.min(Math.max(span * 0.10, 0.9), 5) / 2.5);

    const lineMat = new THREE.LineDashedMaterial({ color: 0x44506a, dashSize: 0.35, gapSize: 0.22 });
    const addLine = (p1, p2) => {
      const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
      const ln = new THREE.Line(geo, lineMat);
      ln.computeLineDistances();
      g.add(ln);
    };
    const addLbl = (text, pos) => {
      const sp = this._makeIdSprite(text, '#9ab2d4');
      sp.position.copy(pos);
      sp.scale.set(ls * 2.2, ls, 1);
      g.add(sp);
    };
    const letter = i => {
      let s = ''; i += 1;
      while (i > 0) { s = String.fromCharCode(64 + ((i - 1) % 26) + 1) + s; i = Math.floor((i - 1) / 26); }
      return s;
    };

    // X axes (A, B, C…): lines parallel to global Y in plan (z = zLo)
    xs.forEach((x, i) => {
      addLine(this.m2t(x, yLo - mY, zLo), this.m2t(x, yHi + mY, zLo));
      addLbl(letter(i), this.m2t(x, yLo - mY - off, zLo));
    });
    // Y axes (1, 2, 3…): lines parallel to global X in plan
    ys.forEach((y, i) => {
      addLine(this.m2t(xLo - mX, y, zLo), this.m2t(xHi + mX, y, zLo));
      addLbl(String(i + 1), this.m2t(xLo - mX - off, y, zLo));
    });
    // Z levels: horizontal lines in the X–Z plane (y = yLo) + elevation label
    zs.forEach(z => {
      addLine(this.m2t(xLo - mX, yLo, z), this.m2t(xHi + mX, yLo, z));
      addLbl(`+${+z.toFixed(2)}`, this.m2t(xLo - mX - off, yLo, z));
    });

    this._scene.add(g);
    this._gridAxesGroup = g;
  }

  // Find nearest node within SNAP_PX screen pixels; returns {id} or null
  _nearestNodeSnap() {
    const el   = this._renderer.domElement;
    const W = el.clientWidth, H = el.clientHeight;
    const mx = (this._mouse.x + 1) / 2 * W;
    const my = (1 - (this._mouse.y + 1) / 2) * H;
    let best = null, bestDist = SNAP_PX;

    for (const [id, mesh] of this._nodeMeshes) {
      if (!mesh.visible) continue;   // hidden by elevation: cannot be snapped to
      const p = mesh.position.clone().project(this._camera);
      const sx = (p.x + 1) / 2 * W;
      const sy = (1 - (p.y + 1) / 2) * H;
      const d  = Math.hypot(sx - mx, sy - my);
      if (d < bestDist) { bestDist = d; best = { id }; }
    }
    return best;
  }

  // ── Pointer events ─────────────────────────────────────────────────────────
  _onMove(e) {
    if (e.buttons & 2 || e.buttons & 4) return;

    // Box selection (#80): while dragging with Alt, update the box.
    if (this._rubber && (e.buttons & 1)) {
      this._rubber.x1 = e.clientX; this._rubber.y1 = e.clientY;
      this._updateRubberBox();
      return;
    }

    this._mouse.copy(this._ndc(e));
    this._raycaster.setFromCamera(this._mouse, this._camera);

    // P3-10: Node drag handling ───────────────────────────────────────────────
    if (this._dragNode !== null && (e.buttons & 1)) {
      if (!this._isDragging) {
        // Require minimum mouse movement to start a drag
        if (this._ptrDownPos) {
          const ddx = e.clientX - this._ptrDownPos[0];
          const ddy = e.clientY - this._ptrDownPos[1];
          if (Math.hypot(ddx, ddy) < 4) return;
        }
        this._isDragging = true;
        this.app.snapshot();   // save state once, before first move
        this._renderer.domElement.style.cursor = 'move';
      }
      const node = this.app.model.nodes.get(this._dragNode);
      if (node) {
        // Drag plane (#79). m2t: model(x,y,z) → three(x, z, y).
        //   xy → fixes Z (horizontal plane),  xz → fixes Y,  yz → fixes X.
        let plane;
        if (this._dragPlane === 'xz')      plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -node.y);
        else if (this._dragPlane === 'yz') plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -node.x);
        else                               plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -node.z);
        const pt = new THREE.Vector3();
        this._raycaster.ray.intersectPlane(plane, pt);
        if (pt && isFinite(pt.x)) {
          const snap = v => (this._snapSize > 0 ? Math.round(v / this._snapSize) * this._snapSize : v);
          // pt in three coords → model: x=pt.x, y=pt.z, z=pt.y.
          if (this._dragPlane === 'xz')      { node.x = snap(pt.x); node.z = snap(pt.y); }
          else if (this._dragPlane === 'yz') { node.y = snap(pt.z); node.z = snap(pt.y); }
          else                               { node.x = snap(pt.x); node.y = snap(pt.z); }
          const mesh = this._nodeMeshes.get(this._dragNode);
          if (mesh) mesh.position.copy(this.m2t(node.x, node.y, node.z));
          // Update connected element geometries live
          for (const [eid, line] of this._elemLines) {
            if (line.userData.n1 === this._dragNode || line.userData.n2 === this._dragNode) {
              const elem = this.app.model.elements.get(eid);
              if (elem) this.addElemLine(elem);
            }
          }
          document.getElementById('sb-coords').textContent =
            `X: ${node.x.toFixed(3)}  Y: ${node.y.toFixed(3)}  Z: ${node.z.toFixed(3)}  [plano ${this._dragPlane.toUpperCase()}]`;
        }
      }
      return; // skip normal hover/preview while dragging
    }

    // Update coord display (normal move)
    const fp = this._floorPoint();
    if (fp) {
      const mc = this.t2m(fp);
      document.getElementById('sb-coords').textContent =
        `X: ${mc.x.toFixed(3)}  Y: ${mc.y.toFixed(3)}  Z: ${mc.z.toFixed(3)}`;
    }

    switch (this.mode) {
      case 'select':     this._hoverUpdate(e); break;
      case 'addnode':    this._previewAddNode(fp); break;
      case 'addelem':    this._previewAddElem(fp); break;
      case 'addsupport': this._hoverUpdate(e); break;
    }
  }

  _onDown(e) {
    if (e.button !== 0) return;
    this._ptrDownPos = [e.clientX, e.clientY];

    // Box selection (rubber-band, #80): Alt + drag in select mode, or any drag in
    // the dedicated «Cuadro» mode (#89, no modifier).
    // Takes priority over node dragging (Alt disables the drag).
    if (!this._inResultsMode && (this.mode === 'boxselect' || (this.mode === 'select' && e.altKey))) {
      const r = this._renderer.domElement.getBoundingClientRect();
      this._rubber = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY,
                       rect: r, add: e.ctrlKey || e.metaKey };
      this._controls.enabled = false;
      this._showRubberBox();
      return;
    }

    // P3-10: Prepare node drag when clicking a selected node in select mode.
    // Not armed with the lock on (#79) nor while viewing results (avoids moving a
    // node over the deformed shape and leaving it "ghosted").
    if (this.mode === 'select' && !this._inResultsMode && !this._dragLock) {
      this._mouse.copy(this._ndc(e));
      this._raycaster.setFromCamera(this._mouse, this._camera);
      const hits = this._pickNodes();   // screen magnet (same as selection)
      if (hits.length) {
        const id = hits[0].object.userData.id;
        if (this._selected.has(`node:${id}`)) {
          this._dragNode     = id;
          const node         = this.app.model.nodes.get(id);
          if (node) this._dragStartPos = { x: node.x, y: node.y, z: node.z };
          this._controls.enabled = false; // prevent orbit while dragging
        }
      }
    }
  }

  _onUp(e) {
    if (e.button !== 0) return;

    // Box selection (#80): on release, selects what falls inside the box.
    if (this._rubber) {
      this._commitRubberBox();
      this._hideRubberBox();
      this._rubber = null;
      this._controls.enabled = true;
      this._ptrDownPos = null;
      return;
    }

    // P3-10: Commit or cancel node drag ──────────────────────────────────────
    if (this._isDragging) {
      const id = this._dragNode;
      const node = this.app.model.nodes.get(id);
      if (node) {
        this.refreshNode(node);          // sync support symbol, connected elems
        // Keep the node SELECTED and its mesh alive after moving it (#79): a node
        // without elements is still a real, selectable node; it isn't left "ghosted".
        if (!this._nodeMeshes.has(id)) this.addNodeMesh(node);
        this._selected.add(`node:${id}`);
        this._setColor('node', id, COL.NODE_SEL, null);
        this.app.markDirty();
        if (this.app.panel._currentTab === 'sel') this.app.panel.showNode(node);
      }
      this._isDragging   = false;
      this._dragNode     = null;
      this._dragStartPos = null;
      this._controls.enabled = true;
      this._ptrDownPos   = null;
      this._renderer.domElement.style.cursor = 'default';
      return;
    }
    // Cancel drag prep if no movement
    if (this._dragNode !== null) {
      this._dragNode     = null;
      this._dragStartPos = null;
      this._controls.enabled = true;
    }

    if (!this._ptrDownPos) return;
    const dx = e.clientX - this._ptrDownPos[0];
    const dy = e.clientY - this._ptrDownPos[1];
    this._ptrDownPos = null;
    if (Math.hypot(dx, dy) > 6) return; // was an orbit drag

    this._mouse.copy(this._ndc(e));
    this._raycaster.setFromCamera(this._mouse, this._camera);

    if (this._inResultsMode) {
      this._clickResults(e);
      return;
    }

    switch (this.mode) {
      case 'select':     this._clickSelect(e.ctrlKey || e.metaKey); break;
      case 'addnode':    this._clickAddNode();     break;
      case 'addelem':    this._clickAddElem();     break;
      case 'addarea':    this._clickAddArea();      break;
      case 'meshpick':   this._clickMeshPick();     break;
      case 'addsupport': this._clickAddSupport(e);  break;
    }
  }

  // ── Select mode ────────────────────────────────────────────────────────────
  // Node picking with a screen "magnet" (like a coin's enlarged collider in a game):
  // first the precise ray against the sphere; if it misses, grab the nearest VISIBLE
  // node to the cursor within a pixel radius. This way the node can be drawn small but
  // still be easy to select.
  _pickNodes() {
    const hits = this._raycaster.intersectObjects([...this._nodeMeshes.values()]);
    if (hits.length) return hits;
    const rect = this._renderer.domElement.getBoundingClientRect();
    const mx = (this._mouse.x + 1) / 2 * rect.width;
    const my = (1 - this._mouse.y) / 2 * rect.height;
    const PICK_PX = 13;                       // "magnet" radius in pixels
    let best = null, bestD = PICK_PX * PICK_PX;
    const v = new THREE.Vector3();
    for (const mesh of this._nodeMeshes.values()) {
      if (!mesh.visible) continue;
      v.copy(mesh.position).project(this._camera);
      if (v.z > 1) continue;                  // behind the camera
      const px = (v.x + 1) / 2 * rect.width, py = (1 - v.y) / 2 * rect.height;
      const d = (px - mx) ** 2 + (py - my) ** 2;
      if (d < bestD) { bestD = d; best = { object: mesh, distance: mesh.position.distanceTo(this._camera.position) }; }
    }
    return best ? [best] : [];
  }

  _hoverUpdate(e = null) {
    const prev = this._hovered;
    const nodeHits = this._pickNodes();
    const elemHits = this._raycaster.intersectObjects([...this._elemLines.values()].filter(l => l.visible));
    const diaPlanes = [...this._diaGroups.values()]
      .map(g => g.children.find(c => c.userData.type === 'diaphragm')).filter(Boolean);
    const cmSpheres = [...this._diaGroups.values()]
      .map(g => g.children.find(c => c.userData.type === 'cm-sphere')).filter(Boolean);
    const diaHits  = this._raycaster.intersectObjects(diaPlanes);
    const cmHits   = this._raycaster.intersectObjects(cmSpheres);
    const areaHits = this._raycaster.intersectObjects(this._areaFills());

    let next = null;
    if (nodeHits.length)      next = { type: 'node',      id: nodeHits[0].object.userData.id };
    else if (elemHits.length) next = { type: 'elem',      id: elemHits[0].object.userData.id };
    else if (cmHits.length)   next = { type: 'cm-sphere', id: cmHits[0].object.userData.diaId };
    else if (diaHits.length)  next = { type: 'diaphragm', id: diaHits[0].object.userData.id };
    else if (areaHits.length) next = { type: 'area',      id: areaHits[0].object.userData.id };

    if (prev && (!next || prev.type !== next.type || prev.id !== next.id)) {
      if (prev.type !== 'diaphragm' && !this._selected.has(`${prev.type}:${prev.id}`))
        this._refreshColor(prev.type, prev.id);
      if (prev.type === 'diaphragm') this._setDiaHighlight(prev.id, false);
    }
    if (next && (!prev || prev.type !== next.type || prev.id !== next.id)) {
      if (next.type === 'diaphragm') this._setDiaHighlight(next.id, true);
      else if (!this._selected.has(`${next.type}:${next.id}`))
        this._setColor(next.type, next.id, COL.NODE_HOVER, COL.ELEM_HOVER);
    }
    this._hovered = next;
    this._renderer.domElement.style.cursor = next ? 'pointer' : 'default';

    // #36: en modo resultados, tooltip con mín/máx del resultado activo al hover.
    if (this._inResultsMode && e && next &&
        (next.type === 'elem' || next.type === 'node' || next.type === 'area')) {
      const key = `${next.type}:${next.id}:${this._currentDiagramType}`;
      if (key !== this._tipKey) { this._tipKey = key; this._tipHtml = this._buildResultTip(next.type, next.id); }
      if (this._tipHtml) this._showResultTip(this._tipHtml, e.clientX, e.clientY);
      else this._hideResultTip();
    } else {
      this._tipKey = null;
      this._hideResultTip();
    }
  }

  // ── Results hover tooltip (#36) ───────────────────────────────────────────────
  // Lightweight min/max readout of the ACTIVE result under the cursor.
  _buildResultTip(type, id) {
    if (!this._inResultsMode || !this._results) return '';
    const model = this.app.model;
    const [fU = 'kN', lU = 'm'] = (model.units || 'kN-m').split('-');
    const unitFor = t => (t === 'N' || t === 'Vy' || t === 'Vz') ? fU
      : (t === 'T' || t === 'My' || t === 'Mz') ? `${fU}·${lU}` : lU;

    if (type === 'elem') {
      const t = this._currentDiagramType;
      const FORCE = ['N', 'Vy', 'Vz', 'T', 'My', 'Mz'];
      if (FORCE.includes(t) && typeof this._results.getDiagramData === 'function') {
        const d = this._results.getDiagramData(id, t, 20) || {};
        let mn = d.minVal, mx = d.maxVal;
        if (mn == null || mx == null) {
          mn = Infinity; mx = -Infinity;
          for (const p of (d.pts || []))      { if (p.val < mn) mn = p.val; if (p.val > mx) mx = p.val; }
          for (const e of (d.extremes || [])) { if (e.val < mn) mn = e.val; if (e.val > mx) mx = e.val; }
        }
        if (isFinite(mn) && isFinite(mx))
          return `<b>Elem #${id}</b> · ${t}<br>mín <b>${_fmt(mn)}</b> · máx <b>${_fmt(mx)}</b> ${unitFor(t)}`;
      }
      // Deformada / tensiones: rango de δ entre los extremos del elemento.
      const elem = model.elements.get(id);
      if (elem && typeof this._results.getNodeDisp === 'function') {
        const mag = nid => { const u = this._results.getNodeDisp(nid) || [0, 0, 0]; return Math.hypot(u[0], u[1], u[2]); };
        const a = mag(elem.n1), b = mag(elem.n2);
        return `<b>Elem #${id}</b> · δ<br>mín <b>${_fmt(Math.min(a, b))}</b> · máx <b>${_fmt(Math.max(a, b))}</b> ${lU}`;
      }
      return '';
    }

    if (type === 'node') {
      if (typeof this._results.getNodeDisp !== 'function') return '';
      const u = this._results.getNodeDisp(id) || [0, 0, 0];
      const mag = Math.hypot(u[0], u[1], u[2]);
      let html = `<b>Nodo #${id}</b> · δ = <b>${_fmt(mag)}</b> ${lU}<br>`
               + `δx ${_fmt(u[0])} · δy ${_fmt(u[1])} · δz ${_fmt(u[2])}`;
      const node = model.nodes.get(id);
      const isSup = node && node.restraints && Object.values(node.restraints).some(Boolean);
      if (isSup && typeof this._results.getReaction === 'function') {
        const r = this._results.getReaction(id) || [0, 0, 0, 0, 0, 0];
        html += `<br>R = <b>${_fmt(Math.hypot(r[0], r[1], r[2]))}</b> ${fU}`;
      }
      return html;
    }

    if (type === 'area' && this._areaVMnodal) {
      const area = model.areas.get(id);
      if (!area) return '';
      let mn = Infinity, mx = -Infinity;
      for (const nid of area.nodes) { const v = this._areaVMnodal.get(nid); if (v == null) continue; if (v < mn) mn = v; if (v > mx) mx = v; }
      if (isFinite(mn)) return `<b>Área #${id}</b> · σVM<br>mín <b>${_fmt(mn)}</b> · máx <b>${_fmt(mx)}</b> ${fU}/${lU}²`;
    }
    return '';
  }

  _ensureResultTip() {
    if (this._resultTip) return this._resultTip;
    const d = document.createElement('div');
    d.className = 'result-hover-tip';
    d.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;display:none;'
      + 'background:rgba(15,20,30,0.92);color:#e6edf3;border:1px solid #33415a;'
      + 'border-radius:6px;padding:5px 8px;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;'
      + 'white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,0.45)';
    document.body.appendChild(d);
    this._resultTip = d;
    return d;
  }

  _showResultTip(html, x, y) {
    const d = this._ensureResultTip();
    d.innerHTML = html;
    d.style.display = 'block';
    const pad = 16, w = d.offsetWidth, h = d.offsetHeight;
    let left = x + pad, top = y + pad;
    if (left + w > window.innerWidth  - 4) left = x - w - pad;
    if (top  + h > window.innerHeight - 4) top  = y - h - pad;
    d.style.left = Math.max(4, left) + 'px';
    d.style.top  = Math.max(4, top)  + 'px';
  }

  _hideResultTip() { if (this._resultTip) this._resultTip.style.display = 'none'; }

  _clickSelect(ctrlHeld = false) {
    const nodeHits = this._pickNodes();
    const elemHits = this._raycaster.intersectObjects([...this._elemLines.values()].filter(l => l.visible));
    const diaPlanes = [...this._diaGroups.values()]
      .map(g => g.children.find(c => c.userData.type === 'diaphragm')).filter(Boolean);
    const cmSpheres = [...this._diaGroups.values()]
      .map(g => g.children.find(c => c.userData.type === 'cm-sphere')).filter(Boolean);
    const diaHits  = this._raycaster.intersectObjects(diaPlanes);
    const cmHits   = this._raycaster.intersectObjects(cmSpheres);
    const areaHits = this._raycaster.intersectObjects(this._areaFills());

    if (nodeHits.length) {
      const id = nodeHits[0].object.userData.id;
      if (ctrlHeld) {
        this._toggleMulti('node', id);
        this._notifyMultiSelection();
      } else {
        this._selectSingle('node', id);
      }
    } else if (elemHits.length) {
      const id = elemHits[0].object.userData.id;
      if (ctrlHeld) {
        this._toggleMulti('elem', id);
        this._notifyMultiSelection();
      } else {
        this._selectSingle('elem', id);
      }
    } else if (areaHits.length) {
      const id = areaHits[0].object.userData.id;
      if (ctrlHeld) { this._toggleMulti('area', id); this._notifyMultiSelection(); }
      else this._selectSingle('area', id);
    } else if (cmHits.length) {
      // CM sphere clicked → show diaphragm + CM displacements
      const dId = cmHits[0].object.userData.diaId;
      this.clearSelection();
      this._selected.add(`diaphragm:${dId}`);
      this._setDiaHighlight(dId, true);
      document.getElementById('sb-sel').textContent = `CM Diafragma #${dId}`;
      this.app.panel.showDiaphragm(dId, true);
    } else if (diaHits.length) {
      const dId = diaHits[0].object.userData.id;
      this.clearSelection();
      this._selected.add(`diaphragm:${dId}`);
      this._setDiaHighlight(dId, true);
      document.getElementById('sb-sel').textContent = `Diafragma #${dId} seleccionado`;
      this.app.panel.showDiaphragm(dId);
    } else {
      this.clearSelection();
      this.app.panel.showNothing();
    }
  }

  _toggleMulti(type, id) {
    const key = `${type}:${id}`;
    if (this._selected.has(key)) {
      this._selected.delete(key);
      this._refreshColor(type, id);
    } else {
      this._selected.add(key);
      this._setColor(type, id, COL.NODE_SEL, COL.ELEM_SEL);
    }
    const count = this._selected.size;
    document.getElementById('sb-sel').textContent =
      count === 0 ? 'Sin selección' : `${count} objeto(s) seleccionado(s)  [Ctrl+clic para añadir]`;
  }

  _notifyMultiSelection() {
    const items = this.getSelected();
    if (items.length === 0) { this.app.panel.showNothing(); return; }
    if (items.length === 1) {
      const { type, id } = items[0];
      if (type === 'node')      this.app.panel.showNode(this.app.model.nodes.get(id));
      else if (type === 'area') this.app.panel.showArea(this.app.model.areas.get(id));
      else                      this.app.panel.showElement(this.app.model.elements.get(id));
    } else {
      this.app.panel.showSelection(items);
    }
  }

  _setDiaHighlight(dId, on) {
    const grp = this._diaGroups.get(dId);
    if (!grp) return;
    const plane = grp.children.find(c => c.userData.type === 'diaphragm');
    if (plane) plane.material.opacity = on ? 0.18 : 0.06;
  }

  _selectSingle(type, id) {
    this.clearSelection();
    this._selected.add(`${type}:${id}`);
    this._setColor(type, id, COL.NODE_SEL, type === 'area' ? COL.AREA_SEL : COL.ELEM_SEL);
    const lbl = type === 'node' ? `Nodo #${id}` : type === 'area' ? `Área #${id}` : `Elemento #${id}`;
    document.getElementById('sb-sel').textContent = `${lbl} seleccionado`;
    if (type === 'node')      this.app.panel.showNode(this.app.model.nodes.get(id));
    else if (type === 'area') this.app.panel.showArea(this.app.model.areas.get(id));
    else                      this.app.panel.showElement(this.app.model.elements.get(id));
  }

  clearSelection() {
    for (const key of this._selected) {
      const [t, sid] = key.split(':');
      if (t === 'diaphragm') this._setDiaHighlight(+sid, false);
      else this._refreshColor(t, +sid);
    }
    // restore the size of nodes flagged by the stability diagnosis
    if (this._flaggedNodes) {
      for (const id of this._flaggedNodes) { const m = this._nodeMeshes.get(id); if (m) m.scale.setScalar(1); }
      this._flaggedNodes = null;
    }
    this._selected.clear();
    document.getElementById('sb-sel').textContent = 'Sin selección';
  }

  getSelected() {
    return [...this._selected].map(k => {
      const [type, id] = k.split(':');
      return { type, id: +id };
    });
  }

  selectAll() {
    for (const id of this._nodeMeshes.keys()) {
      this._selected.add(`node:${id}`);
      this._nodeMeshes.get(id).material.color.set(COL.NODE_SEL);
    }
    for (const id of this._elemLines.keys()) {
      this._selected.add(`elem:${id}`);
      this._elemLines.get(id).material.color.set(COL.ELEM_SEL);
    }
    for (const id of this._areaMeshes.keys()) {
      this._selected.add(`area:${id}`);
      this._setAreaHL(id, COL.AREA_SEL);
    }
  }

  // Highlights and selects a set of nodes (stability diagnosis) and centers the
  // view on them so they are easy to find.
  flagNodes(ids) {
    this.clearSelection();
    for (const id of ids) {
      const m = this._nodeMeshes.get(id);
      if (m) { m.material.color.set(0xff2d55); m.scale.setScalar(1.8); this._selected.add(`node:${id}`); }
    }
    document.getElementById('sb-sel').textContent = `${ids.length} ${i18n.t('nodo(s) inestables resaltados')}`;
    // restore the scale on deselect
    this._flaggedNodes = ids.slice();
    // center the camera on the centroid of the flagged nodes
    if (ids.length) {
      const c = new THREE.Vector3();
      let k = 0;
      for (const id of ids) { const m = this._nodeMeshes.get(id); if (m) { c.add(m.position); k++; } }
      if (k) { c.multiplyScalar(1 / k); this._controls.target.copy(c); this._controls.update(); }
    }
  }

  // Centers the camera on a specific node (without changing the zoom).
  centerOnNode(id) {
    const m = this._nodeMeshes.get(id);
    if (m) { this._controls.target.copy(m.position); this._controls.update(); }
  }

  // ── Strong-column–weak-beam joints (SCWB, #68) ──────────────────────────────
  // Colors the nodes of the checked joints: RED = fails, GREEN = passes, and
  // enlarges the failing ones. Saves the state to restore it with clearSCWB.
  showSCWB(res) {
    this.clearSCWB();
    this._scwbMarked = [];
    let worst = null, worstR = -1;
    for (const r of res) {
      const m = this._nodeMeshes.get(r.node); if (!m) continue;
      this._scwbMarked.push(r.node);
      m.material.color.set(r.cumple ? 0x22c55e : 0xff2d55);
      m.scale.setScalar(r.cumple ? 1.3 : 1.9);
      if (!r.cumple && r.ratio > worstR) { worstR = r.ratio; worst = m; }
    }
    if (worst) { this._controls.target.copy(worst.position); this._controls.update(); }
  }
  clearSCWB() {
    if (!this._scwbMarked) return;
    for (const id of this._scwbMarked) {
      const m = this._nodeMeshes.get(id);
      if (m) { m.scale.setScalar(1); this._refreshColor('node', id); }
    }
    this._scwbMarked = null;
  }

  // ── Element visibility (view state, not model state) ────────────────────────
  hideElements(ids) {
    for (const id of ids) {
      this._hiddenElems.add(id);
      const l = this._elemLines.get(id); if (l) l.visible = false;
      this._selected.delete(`elem:${id}`);
    }
  }
  showElements(ids) {
    for (const id of ids) { this._hiddenElems.delete(id); const l = this._elemLines.get(id); if (l) l.visible = true; }
  }
  showAllElements() {
    this._hiddenElems.clear();
    for (const l of this._elemLines.values()) l.visible = true;
  }
  clearHidden() { this._hiddenElems.clear(); }
  hiddenCount() { return this._hiddenElems.size; }

  /** Selects exactly this set of elements (e.g. a group). */
  selectElements(ids) {
    this.clearSelection();
    for (const id of ids) {
      if (!this._elemLines.has(id)) continue;
      this._selected.add(`elem:${id}`);
      this._elemLines.get(id).material.color.set(COL.ELEM_SEL);
    }
    const n = this._selected.size;
    document.getElementById('sb-sel').textContent = n ? `${n} seleccionado(s)` : 'Sin selección';
  }

  selectNodes(ids) {
    this.clearSelection();
    for (const id of ids) {
      if (!this._nodeMeshes.has(id)) continue;
      this._selected.add(`node:${id}`);
      this._setColor('node', id, COL.NODE_SEL, null);
    }
    const n = this._selected.size;
    document.getElementById('sb-sel').textContent = n ? `${n} seleccionado(s)` : 'Sin selección';
  }

  // ── Add Node mode ──────────────────────────────────────────────────────────
  _previewAddNode(fp) {
    this._renderer.domElement.style.cursor = 'crosshair';
    if (fp) {
      this._previewSphere.position.copy(fp);
      this._previewSphere.visible = true;
    } else {
      this._previewSphere.visible = false;
    }
  }

  _clickAddNode() {
    const fp = this._floorPoint();
    if (!fp) return;
    const mc = this.t2m(fp);
    // P3-12: Show coordinate confirmation popup instead of placing immediately
    this._showNodeCoordPopup(mc);
  }

  /** P3-12: Mini popup to confirm / adjust node coordinates before placing. */
  _showNodeCoordPopup(mc) {
    document.getElementById('node-coord-popup')?.remove();

    const popup = document.createElement('div');
    popup.id = 'node-coord-popup';
    popup.style.cssText = [
      'position:absolute', 'bottom:44px', 'left:50%', 'transform:translateX(-50%)',
      'background:var(--bg3,#21262d)', 'border:1px solid var(--accent,#388bfd)',
      'border-radius:6px', 'padding:8px 12px', 'z-index:20',
      'display:flex', 'gap:6px', 'align-items:center',
      'box-shadow:0 4px 20px rgba(0,0,0,0.6)', 'pointer-events:all',
    ].join(';');

    const inp = (id, val, locked = false) =>
      `<input type="number" id="${id}" value="${val.toFixed(3)}" step="0.1" ${locked ? 'disabled' : ''}
         style="width:60px;font-size:11px;background:var(--bg4,#30363d);
                border:1px solid var(--border2,#484f58);color:var(--text,#c9d1d9);
                padding:3px 5px;border-radius:3px;font-family:monospace${locked ? ';opacity:0.45' : ''}">`;

    // Coordinate fixed to the active plane (2D project or elevation)
    const is2D  = this.app.model.mode === '2D';
    const elev  = this._elevation;
    const lockY = is2D || (elev && elev.axis === 'y');
    const lockX = !!(elev && elev.axis === 'x');

    popup.innerHTML = `
      <span style="color:var(--text-muted);font-size:11px;white-space:nowrap">Nuevo nodo:</span>
      <label style="font-size:11px;color:var(--text-muted)">X</label>${inp('np-x', mc.x, lockX)}
      <label style="font-size:11px;color:var(--text-muted)">Y</label>${inp('np-y', mc.y, lockY)}
      <label style="font-size:11px;color:var(--text-muted)">Z</label>${inp('np-z', mc.z)}
      <button id="np-ok"
        style="background:var(--accent,#388bfd);color:#fff;border:none;
               padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px">✓</button>
      <button id="np-cancel"
        style="background:transparent;color:var(--text-muted);
               border:1px solid var(--border2,#484f58);
               padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px">✕</button>`;

    const vpWrap = document.getElementById('viewport-wrap') || this.container.parentElement;
    vpWrap.appendChild(popup);
    i18n.translate(popup);   // not inside an observed container → translate explicitly
    const xEl = document.getElementById('np-x');
    xEl?.focus(); xEl?.select();

    const confirm = () => {
      const x = parseFloat(document.getElementById('np-x')?.value);
      const y = parseFloat(document.getElementById('np-y')?.value);
      const z = parseFloat(document.getElementById('np-z')?.value);
      popup.remove();
      if (isFinite(x) && isFinite(y) && isFinite(z)) this.app.addNode(x, y, z);
    };
    document.getElementById('np-ok')?.addEventListener('click', confirm);
    document.getElementById('np-cancel')?.addEventListener('click', () => popup.remove());
    popup.addEventListener('keydown', ev => {
      if (ev.key === 'Enter')  confirm();
      if (ev.key === 'Escape') popup.remove();
      ev.stopPropagation();
    });
  }

  // ── Add Element mode ───────────────────────────────────────────────────────
  // With the magnet on, it snaps to the nearby node (highlighting it). Without the
  // magnet or a nearby node, it uses the grid point (a new node is created on click).
  _previewAddElem(fp) {
    this._renderer.domElement.style.cursor = 'crosshair';
    const snap = this._magnetSnap ? this._nearestNodeSnap() : null;
    const snapPos = snap ? this._nodeMeshes.get(snap.id).position : fp;

    if (snapPos) {
      this._previewSphere.position.copy(snapPos);
      this._previewSphere.visible = true;
    }

    if (this._addElemFirst !== null) {
      const p1 = this._nodeMeshes.get(this._addElemFirst)?.position;
      if (p1 && snapPos) {
        this._previewLine.geometry.setFromPoints([p1, snapPos]);
        this._previewLine.geometry.needsUpdate = true;
        this._previewLine.visible = true;
      }
    }
  }

  // Resolves an element endpoint: existing node (magnet) or NEW node on the grid
  // (created on the fly with mesh). Returns a node id, or null.
  _resolveElemEndpoint() {
    const snap = this._magnetSnap ? this._nearestNodeSnap() : null;
    if (snap) return snap.id;
    const fp = this._floorPoint();
    if (!fp) return null;
    const mc = this.t2m(fp);
    return this.app.addNode(mc.x, mc.y, mc.z).id;   // creates node + mesh + undo
  }

  _clickAddElem() {
    const id = this._resolveElemEndpoint();
    if (id == null) { this.app.toast('Haga clic dentro del área de trabajo', 'warn'); return; }
    if (this._addElemFirst === null) {
      // First click: creates the node (if needed) and is ready as the initial endpoint,
      // without requiring a second click on the just-created node.
      this._addElemFirst = id;
      this._setColor('node', id, COL.NODE_SEL, null);
      document.getElementById('sb-sel').textContent = `${i18n.t('Nodo')} #${id} ${i18n.t('→ clic para el destino (o grilla) · Esc para terminar')}`;
    } else {
      const n1 = this._addElemFirst, n2 = id;
      if (n1 === n2) { this.app.toast('Los nodos deben ser distintos', 'warn'); return; }
      this.app.addElement(n1, n2);
      // Continuous chain: the just-created endpoint starts the next element, so a
      // polyline is drawn with one click per span. Esc to finish.
      this._refreshColor('node', n1);
      this._addElemFirst = n2;
      this._previewLine.visible = false;
      this._setColor('node', n2, COL.NODE_SEL, null);
      document.getElementById('sb-sel').textContent = `${i18n.t('Nodo')} #${n2} ${i18n.t('→ clic para encadenar otro tramo · Esc para terminar')}`;
    }
  }

  // ── Add Area mode ──────────────────────────────────────────────────────────
  // Pick 3 (CST) or 4 (QUAD) nodes by clicking; Enter creates, Esc resets, the 4th
  // node creates the QUAD automatically. Re-clicking a node removes it from the selection.
  _clickAddArea() {
    const snap = this._nearestNodeSnap();
    if (!snap) { this.app.toast('Clic sobre un nodo (las áreas se forman con nodos)', 'warn'); return; }
    if (!this._areaPick) this._areaPick = [];
    const i = this._areaPick.indexOf(snap.id);
    if (i >= 0) { this._areaPick.splice(i, 1); this._refreshColor('node', snap.id); }
    else {
      if (this._areaPick.length >= 4) { this.app.toast('Máximo 4 nodos. Enter para crear o Esc para reiniciar.', 'warn'); return; }
      this._areaPick.push(snap.id); this._setColor('node', snap.id, COL.NODE_SEL, null);
    }
    const n = this._areaPick.length;
    document.getElementById('sb-sel').textContent =
      n >= 3 ? `Área: ${n} nodo(s) · Enter para crear (${n === 3 ? 'CST' : 'QUAD'})` : `Área: ${n} nodo(s) · faltan ${3 - n}`;
    if (n === 4) this._finishArea();
  }

  _finishArea() {
    const ids = (this._areaPick || []);
    if (ids.length < 3) { this.app.toast('Seleccione 3 (CST) o 4 (QUAD) nodos', 'warn'); return; }
    const copy = ids.slice();
    this._cancelAreaPick();
    this.app.createAreaFromNodes(copy);
  }

  _cancelAreaPick() {
    for (const id of (this._areaPick || [])) this._refreshColor('node', id);
    this._areaPick = [];
  }

  // ── Meshing by MODE (#78): activate the mode then click the outline nodes
  //    (like the Area mode), Enter to mesh, Esc to reset.
  //    kind: 'free' (free region N nodes) | 'panel' (4-corner transfinite).
  startMeshPick(kind = 'free') {
    this._meshKind = (kind === 'panel') ? 'panel' : 'free';
    // If there are already selected nodes, they carry into the outline (the
    // «select and mesh» shortcut is kept); otherwise clicking starts from scratch (#78).
    const sel = [...this._selected].filter(k => k.startsWith('node:')).map(k => +k.split(':')[1]);
    this.clearSelection();
    this._meshPick = (kind === 'panel') ? sel.slice(0, 4) : sel;
    this.setMode('meshpick');
    for (const id of this._meshPick) this._setColor('node', id, COL.NODE_SEL, null);
    if (this._meshPick.length) {
      const n = this._meshPick.length;
      document.getElementById('sb-sel').textContent = (this._meshKind === 'panel')
        ? `Mallar panel: ${n}/4 esquinas` : `Mallar región: ${n} nodos · Enter para mallar`;
    }
  }

  _clickMeshPick() {
    const snap = this._nearestNodeSnap();
    if (!snap) { this.app.toast('Clic sobre un nodo del contorno a mallar', 'warn'); return; }
    if (!this._meshPick) this._meshPick = [];
    const i = this._meshPick.indexOf(snap.id);
    if (i >= 0) { this._meshPick.splice(i, 1); this._refreshColor('node', snap.id); }
    else {
      if (this._meshKind === 'panel' && this._meshPick.length >= 4) {
        this.app.toast('El panel transfinito usa 4 esquinas. Enter para mallar o Esc para reiniciar.', 'warn'); return;
      }
      this._meshPick.push(snap.id); this._setColor('node', snap.id, COL.NODE_SEL, null);
    }
    const n = this._meshPick.length;
    const sb = document.getElementById('sb-sel');
    if (this._meshKind === 'panel')
      sb.textContent = `Mallar panel: ${n}/4 esquinas` + (n === 4 ? ' · Enter para mallar' : '');
    else
      sb.textContent = n >= 3 ? `Mallar región: ${n} nodos · Enter para mallar` : `Mallar región: ${n} nodos · faltan ${3 - n}`;
    if (this._meshKind === 'panel' && n === 4) this._finishMeshPick();
  }

  _finishMeshPick() {
    const ids = (this._meshPick || []).slice();
    const kind = this._meshKind;
    if (kind === 'panel' && ids.length !== 4) { this.app.toast('El panel transfinito necesita 4 nodos esquina', 'warn'); return; }
    if (kind !== 'panel' && ids.length < 3)   { this.app.toast('La región libre necesita ≥3 nodos de contorno', 'warn'); return; }
    this._cancelMeshPick();
    if (kind === 'panel') this.app.meshPanelSelection(ids);
    else                  this.app.mallarRegionLibre(ids);
  }

  _cancelMeshPick() {
    for (const id of (this._meshPick || [])) this._refreshColor('node', id);
    this._meshPick = [];
  }

  // ── Box / rubber-band selection (#80): DOM box over the viewport ─────────────
  _showRubberBox() {
    let box = this._rubberEl;
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;border:1px solid var(--accent,#38bdf8);background:rgba(56,189,248,.14);pointer-events:none;z-index:50;display:none';
      (document.getElementById('viewport-wrap') || document.body).appendChild(box);
      this._rubberEl = box;
    }
    box.style.display = 'block';
    this._updateRubberBox();
  }
  _updateRubberBox() {
    const b = this._rubber, box = this._rubberEl;
    if (!b || !box) return;
    const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1);
    box.style.left = x + 'px'; box.style.top = y + 'px';
    box.style.width = Math.abs(b.x1 - b.x0) + 'px'; box.style.height = Math.abs(b.y1 - b.y0) + 'px';
  }
  _hideRubberBox() { if (this._rubberEl) this._rubberEl.style.display = 'none'; }

  _commitRubberBox() {
    const b = this._rubber; if (!b) return;
    const r = b.rect;
    // A click without a real drag → normal point selection (not rubber-band).
    if (Math.hypot(b.x1 - b.x0, b.y1 - b.y0) < 5) {
      this._mouse.set(((b.x1 - r.left) / r.width) * 2 - 1, -((b.y1 - r.top) / r.height) * 2 + 1);
      this._raycaster.setFromCamera(this._mouse, this._camera);
      this._clickSelect(b.add);
      return;
    }
    const xmin = Math.min(b.x0, b.x1), xmax = Math.max(b.x0, b.x1);
    const ymin = Math.min(b.y0, b.y1), ymax = Math.max(b.y0, b.y1);
    const W = r.width, H = r.height;
    const toScreen = (p) => {                       // world → screen px (client)
      const v = p.clone().project(this._camera);
      return [r.left + (v.x + 1) / 2 * W, r.top + (1 - (v.y + 1) / 2) * H];
    };
    const inBox = (sx, sy) => sx >= xmin && sx <= xmax && sy >= ymin && sy <= ymax;
    if (!b.add) this.clearSelection();
    // Nodes: by their center.
    for (const [id, mesh] of this._nodeMeshes) {
      if (!mesh.visible) continue;
      const [sx, sy] = toScreen(mesh.position);
      if (inBox(sx, sy) && !this._selected.has(`node:${id}`)) {
        this._selected.add(`node:${id}`); this._setColor('node', id, COL.NODE_SEL, null);
      }
    }
    // Elements: both endpoints inside the box.
    for (const [id, line] of this._elemLines) {
      if (!line.visible) continue;
      const el = this.app.model.elements.get(id); if (!el) continue;
      const n1 = this.app.model.nodes.get(el.n1), n2 = this.app.model.nodes.get(el.n2);
      if (!n1 || !n2) continue;
      const [a, b1] = toScreen(this.m2t(n1.x, n1.y, n1.z));
      const [c, d]  = toScreen(this.m2t(n2.x, n2.y, n2.z));
      if (inBox(a, b1) && inBox(c, d) && !this._selected.has(`elem:${id}`)) {
        this._selected.add(`elem:${id}`); this._elemLines.get(id).material.color.set(COL.ELEM_SEL);
      }
    }
    const n = this._selected.size;
    document.getElementById('sb-sel').textContent = n ? `${n} objeto(s) seleccionado(s)  [Alt+arrastrar = cuadro]` : 'Sin selección';
    this._notifyMultiSelection();
  }

  // ── Add Support mode ───────────────────────────────────────────────────────
  _clickAddSupport(e) {
    const hits = this._raycaster.intersectObjects([...this._nodeMeshes.values()]);
    if (!hits.length) { this._hideSupportPopup(); return; }
    const id = hits[0].object.userData.id;
    this._selectSingle('node', id);
    this._showSupportPopup(id, e);
  }

  /** Floating window with support presets (Fixed/Pin/Free) and DOFs. */
  _showSupportPopup(nodeId, e) {
    this._hideSupportPopup();
    const node = this.app.model.nodes.get(nodeId);
    if (!node) return;
    const is2D = this.app.model.mode === '2D';
    const outOfPlane = new Set(['uy', 'rx', 'rz']);   // auto-restrained in 2D

    const pop = document.createElement('div');
    pop.className = 'support-popup';
    pop.style.cssText =
      `position:fixed;z-index:9999;background:var(--bg-elev,#1b2230);color:var(--text,#e6edf3);` +
      `border:1px solid var(--border,#334);border-radius:8px;padding:10px;` +
      `box-shadow:0 6px 24px rgba(0,0,0,.45);font-size:12px;min-width:208px;user-select:none`;
    const px = e ? e.clientX : window.innerWidth / 2;
    const py = e ? e.clientY : window.innerHeight / 2;
    pop.style.left = Math.min(px + 8, window.innerWidth - 230) + 'px';
    pop.style.top = Math.min(py + 8, window.innerHeight - 230) + 'px';

    const apply = (r) => {
      this.app.snapshot();
      this.app.model.updateNode(nodeId, { restraints: r });
      this.refreshNode(this.app.model.nodes.get(nodeId));
      this.app.markDirty();
      render();
      // refresh the side panel if it is showing this node
      if (this.app.panel?._currentTab === 'sel') this.app.panel.showNode(this.app.model.nodes.get(nodeId));
    };
    const preset = (obj) => () => apply({ ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0, ...obj });

    const dofs = [['ux', 'UX'], ['uy', 'UY'], ['uz', 'UZ'], ['rx', 'RX'], ['ry', 'RY'], ['rz', 'RZ']];

    const render = () => {
      const r = this.app.model.nodes.get(nodeId).restraints;
      const chip = (dof, lbl) => {
        const dis = is2D && outOfPlane.has(dof);
        const fijo = !!r[dof];
        return `<button data-dof="${dof}" ${dis ? 'disabled' : ''}
          title="${fijo ? 'Fijo (clic = liberar)' : 'Libre (clic = fijar)'}"
          style="flex:1;min-width:42px;padding:5px 0;border-radius:5px;cursor:${dis ? 'not-allowed' : 'pointer'};
          border:1px solid ${fijo ? 'var(--accent,#4ea1ff)' : 'var(--border,#334)'};
          background:${fijo ? 'var(--accent,#4ea1ff)' : 'transparent'};
          color:${fijo ? '#08111f' : 'var(--text-muted,#9aa)'};opacity:${dis ? 0.35 : 1};font-weight:600">${lbl}</button>`;
      };
      pop.innerHTML =
        `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
           <b>${i18n.t('Apoyo nodo')} #${nodeId}</b>
           <span data-close style="cursor:pointer;color:var(--text-muted,#9aa);font-size:15px;line-height:1">×</span>
         </div>
         <div style="display:flex;gap:5px;margin-bottom:6px">
           <button data-preset="emp" title="Empotramiento total: fija las 6 GDL (resiste fuerzas y momentos)." style="flex:1;padding:6px 0;border-radius:5px;cursor:pointer;border:1px solid var(--border,#334);background:transparent;color:var(--text,#e6edf3);font-weight:600">Empotrado (fijar todo)</button>
           <button data-preset="pin" title="Apoyo articulado: fija traslaciones, libera giros (no resiste momentos)." style="flex:1;padding:6px 0;border-radius:5px;cursor:pointer;border:1px solid var(--border,#334);background:transparent;color:var(--text,#e6edf3);font-weight:600">Rótula (Pin)</button>
         </div>
         <div style="display:flex;gap:5px;margin-bottom:8px">
           <button data-preset="rollz" style="flex:1;padding:6px 0;border-radius:5px;cursor:pointer;border:1px solid var(--border,#334);background:transparent;color:var(--text,#e6edf3);font-weight:600">Rodillo (libre X,Y)</button>
           <button data-preset="lib" style="flex:1;padding:6px 0;border-radius:5px;cursor:pointer;border:1px solid var(--border,#334);background:transparent;color:var(--text-muted,#9aa)">Libre</button>
         </div>
         <div style="color:var(--text-muted,#9aa);margin-bottom:4px">Traslaciones · clic = fijar/liberar</div>
         <div style="display:flex;gap:5px;margin-bottom:6px">${chip('ux','UX')}${chip('uy','UY')}${chip('uz','UZ')}</div>
         <div style="color:var(--text-muted,#9aa);margin-bottom:4px">Giros</div>
         <div style="display:flex;gap:5px">${chip('rx','RX')}${chip('ry','RY')}${chip('rz','RZ')}</div>`;
      i18n.translate(pop);   // floating popup (body) → not observed; translate explicitly

      pop.querySelector('[data-close]').onclick = () => this._hideSupportPopup();
      pop.querySelector('[data-preset="emp"]').onclick = preset({ ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
      pop.querySelector('[data-preset="pin"]').onclick = preset({ ux: 1, uy: 1, uz: 1 });
      pop.querySelector('[data-preset="rollz"]').onclick = preset({ uz: 1 });
      pop.querySelector('[data-preset="lib"]').onclick = preset({});
      pop.querySelectorAll('[data-dof]').forEach((b) => {
        if (b.disabled) return;
        b.onclick = () => {
          const r2 = { ...this.app.model.nodes.get(nodeId).restraints };
          const d = b.dataset.dof; r2[d] = r2[d] ? 0 : 1;
          apply(r2);
        };
      });
    };

    render();
    document.body.appendChild(pop);
    this._supportPopup = pop;
    // close on click outside (on the next tick so as not to catch this click)
    setTimeout(() => {
      this._supportPopupOutside = (ev) => { if (!pop.contains(ev.target)) this._hideSupportPopup(); };
      document.addEventListener('pointerdown', this._supportPopupOutside, true);
    }, 0);
  }

  _hideSupportPopup() {
    if (this._supportPopupOutside) {
      document.removeEventListener('pointerdown', this._supportPopupOutside, true);
      this._supportPopupOutside = null;
    }
    if (this._supportPopup) { this._supportPopup.remove(); this._supportPopup = null; }
  }

  // ── Color helpers ──────────────────────────────────────────────────────────
  _setColor(type, id, nc, ec) {
    if (type === 'area') { this._setAreaHL(id, ec ?? COL.AREA_SEL); return; }
    if (type === 'node') {
      const m = this._nodeMeshes.get(id);
      if (m && nc != null) m.material.color.set(nc);
    } else {
      const l = this._elemLines.get(id);
      if (l && ec != null) l.material.color.set(ec);
    }
  }

  _refreshColor(type, id) {
    if (type === 'area') { this._setAreaHL(id, null); return; }
    if (type === 'node') {
      const node = this.app.model.nodes.get(id);
      if (node) this._setColor('node', id, this._nodeColor(node), null);
    } else {
      this._setColor('elem', id, null, COL.ELEM);
    }
  }

  // Highlights (colors) an area; col=null restores the default style.
  _setAreaHL(id, col) {
    const g = this._areaMeshes.get(id); if (!g) return;
    const fill = g.children.find(c => c.type === 'Mesh');
    const edge = g.children.find(c => c.type === 'Line');
    // Results contour (von Mises) meshes paint the face with PER-VERTEX colors:
    // touching material.color/opacity there would tint away the contour on hover or
    // selection (#34). In that case keep the fill intact and highlight only the edge.
    const isContour = !!(fill && fill.material && fill.material.vertexColors);
    if (fill && !isContour) { fill.material.color.set(col ?? COL.AREA); fill.material.opacity = col ? 0.42 : 0.22; }
    if (edge) {
      if (isContour) { edge.material.color.set(col ?? 0x334155); edge.material.opacity = col ? 1 : 0.5; }
      else           { edge.material.color.set(col ?? 0x60a5fa); edge.material.opacity = col ? 1 : 0.7; }
    }
  }

  // Fill meshes of the areas (for selection raycasting).
  _areaFills() {
    const out = [];
    for (const g of this._areaMeshes.values()) { const f = g.children.find(c => c.type === 'Mesh'); if (f && f.visible) out.push(f); }
    return out;
  }

  _nodeColor(node) {
    const r = node.restraints;
    if (r.ux && r.uy && r.uz && r.rx && r.ry && r.rz) return COL.NODE_FIXED;
    if (r.ux || r.uy || r.uz || r.rx || r.ry || r.rz)  return COL.NODE_PIN;
    return COL.NODE;
  }

  _hasAnyRestraint(node) {
    const r = node.restraints;
    return r.ux || r.uy || r.uz || r.rx || r.ry || r.rz;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  setMode(mode) {
    // If a MODELING tool is chosen while viewing results, leave results mode:
    // otherwise _onPointerUp intercepts the click (_clickResults) and the tool
    // (e.g. Support) "does nothing".
    if (this._inResultsMode && (mode === 'addnode' || mode === 'addelem' || mode === 'addarea' || mode === 'meshpick' || mode === 'addsupport')) {
      this.clearResults();
      this.app?.toast?.('Resultados ocultos para editar el modelo', 'info');
    }
    this.mode = mode;
    if (mode !== 'addelem' && this._addElemFirst !== null) {
      this._refreshColor('node', this._addElemFirst);
      this._addElemFirst = null;
      this._previewLine.visible = false;
    }
    if (mode !== 'addnode' && mode !== 'addelem') {
      this._previewSphere.visible = false;
    }
    if (mode !== 'addarea' && this._areaPick?.length) this._cancelAreaPick();
    if (mode !== 'meshpick' && this._meshPick?.length) this._cancelMeshPick();
    // PAN (hand): dragging with the left button pans instead of orbiting. On leaving
    // the mode, orbit is restored (except in 2D/elevation view, which already pans).
    if (mode === 'pan') {
      this._controls.enableRotate = false;
      this._controls.mouseButtons = this._MB_2D;
    } else if (this.app.model.mode !== '2D' && !this._elevation && !this._planeLock) {
      this._controls.enableRotate = true;
      this._controls.mouseButtons = this._MB_3D;
    }
    // Toolbar highlight
    document.querySelectorAll('.tool[data-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === mode)
    );
    // Status bar mode
    const names = {
      select:     'Seleccionar',
      boxselect:  'Selección por cuadro',
      pan:        'Mover vista (PAN)',
      addnode:    'Agregar Nodo',
      addelem:    'Agregar Elemento',
      addarea:    'Agregar Área',
      meshpick:   this._meshKind === 'panel' ? 'Mallar panel (4 esquinas)' : 'Mallar región',
      addsupport: 'Asignar Apoyo'
    };
    document.getElementById('sb-mode').textContent = `${i18n.t('Modo:')} ${i18n.t(names[mode] || mode)}`;
    // Hint overlay
    const hints = {
      boxselect:  'Arrastra con la izquierda para dibujar un recuadro  ·  selecciona nodos y elementos dentro  ·  Ctrl al soltar añade  ·  Esc cancela',
      pan:        'Arrastra con el botón izquierdo para mover la vista',
      addnode:    'Clic en la grilla para crear nodo',
      addelem:    'Clic en un nodo o en la grilla (crea nodo) → destino  ·  Imán: pega a nodo cercano  ·  Esc cancela',
      addarea:    'Clic en 3 nodos (CST) o 4 (QUAD) → Enter para crear  ·  Esc reinicia',
      meshpick:   this._meshKind === 'panel'
                    ? 'Clic en las 4 esquinas del panel → se malla solo al 4º nodo  ·  Esc reinicia'
                    : 'Clic en los nodos del contorno → Enter para mallar  ·  Esc reinicia',
      addsupport: 'Clic en un nodo para editar sus restricciones'
    };
    const el = document.getElementById('vp-hint');
    el.textContent = hints[mode] ? i18n.t(hints[mode]) : '';
    el.classList.toggle('visible', !!hints[mode]);
    // Cursor
    const cur = (mode === 'addnode' || mode === 'addelem' || mode === 'addarea' || mode === 'meshpick') ? 'crosshair'
              : mode === 'pan' ? 'grab' : 'default';
    this._renderer.domElement.style.cursor = cur;
  }

  setView(view) {
    // In a 2D project or with an active elevation the view is fixed (true 2D):
    // re-frame instead of rotating.
    if (this.app.model.mode === '2D') { this._fitOrtho('y', 0); return; }
    if (this._elevation) { this._fitOrtho(this._elevation.axis === 'x' ? 'x' : 'y', this._elevation.coord); return; }
    const b = this.app.model.getBounds();
    // Centre in Three.js coords (m2t of model center)
    const tc = this.m2t(b.center.x, b.center.y, b.center.z);
    const span = Math.max(
      b.max.x - b.min.x,
      b.max.y - b.min.y,
      b.max.z - b.min.z,
      10
    );
    const d = span * 1.8;
    this._controls.target.copy(tc);

    const positions = {
      iso:   [tc.x + d*0.7, tc.y + d*0.6, tc.z + d*0.7],
      top:   [tc.x,         tc.y + d*1.5,  tc.z],
      front: [tc.x,         tc.y,           tc.z + d],
      side:  [tc.x + d,     tc.y,           tc.z]
    };
    const p = positions[view] || positions.iso;
    this._camera.position.set(...p);
    this._camera.lookAt(tc);
    this._controls.update();
  }

  zoomExtents() { this.setView('iso'); }

  // ── Work plane (#28) ─────────────────────────────────────────────────────────
  // The "Plano" selector (xy|xz|yz) sets where new nodes/bars land in 3D and the
  // drag plane. Sets the descriptive offset label and re-frames if locked.
  setWorkPlane(plane) {
    if (plane !== 'xy' && plane !== 'xz' && plane !== 'yz') return;
    this._dragPlane = plane;
    const sel = document.getElementById('drag-plane');
    if (sel && sel.value !== plane) sel.value = plane;
    this._updatePlaneOffsetLabel();
    if (this._planeLock) this._applyPlaneLock(true);
  }

  // Re-label + reload the shared offset field so it always reflects the active
  // work plane: Z piso (XY), Y plano (XZ), X plano (YZ).
  _updatePlaneOffsetLabel() {
    const p   = this._dragPlane || 'xy';
    const lbl = document.getElementById('floor-z-label');
    const inp = document.getElementById('floor-z');
    if (p === 'xz') {
      if (lbl) lbl.textContent = 'Y plano';
      if (inp) { inp.value = this._planeYOff || 0;
        inp.title = 'Plano de trabajo vertical XZ (Frente): los nodos nuevos caen en la coordenada Y = este valor.'; }
    } else if (p === 'yz') {
      if (lbl) lbl.textContent = 'X plano';
      if (inp) { inp.value = this._planeXOff || 0;
        inp.title = 'Plano de trabajo vertical YZ (Lateral): los nodos nuevos caen en la coordenada X = este valor.'; }
    } else {
      if (lbl) lbl.textContent = 'Z piso';
      if (inp) { inp.value = this._floorZ || 0;
        inp.title = 'Plano de trabajo horizontal XY (Planta): los nodos nuevos caen en la coordenada Z = este valor.'; }
    }
  }

  // "Fijar": lock the camera to the work plane (true 2D drawing, no orbit). Off →
  // free 3D orbit (nodes still land on the work plane). 2D projects and active
  // elevations own the camera, so this is a no-op there.
  _applyPlaneLock(on) {
    this._planeLock = on;
    const chk = document.getElementById('plane-lock');
    if (chk && chk.checked !== on) chk.checked = on;
    if (this.app.model.mode === '2D' || this._elevation) return;
    if (on) {
      const axis = this._dragPlane === 'yz' ? 'x' : this._dragPlane === 'xz' ? 'y' : 'z';
      this._setProjection('ortho');
      this._fitOrtho(axis);
      this._controls.enableRotate = false;
      this._controls.mouseButtons = this._MB_2D;   // left drag = pan
    } else {
      this._setProjection('persp');
      this._controls.enableRotate = true;
      this._controls.mouseButtons = this._MB_3D;
      this.setView('iso');
    }
  }

  // Menú Vista: preset de cámara que además fija el plano de trabajo.
  //   top→XY, front→XZ, side→YZ (con "Fijar" activado)  ·  iso→3D libre.
  setStandardView(view) {
    // In a 2D project or active elevation, keep the legacy re-frame behavior.
    if (this.app.model.mode === '2D' || this._elevation) { this.setView(view); return; }
    if (view === 'iso') { this._applyPlaneLock(false); return; }
    const PLANE = { top: 'xy', front: 'xz', side: 'yz' };
    const plane = PLANE[view];
    if (!plane) { this.setView(view); return; }
    this.setWorkPlane(plane);
    this._applyPlaneLock(true);
  }

  // Render the current scene and return it as a PNG data URL (for the calc report).
  snapshot() {
    this._renderer.render(this._scene, this._camera);
    return this._renderer.domElement.toDataURL('image/png');
  }

  toggleGrid()  { this._grid.visible = !this._grid.visible; }
  toggleAxes()  { this._axesGroup.visible = !this._axesGroup.visible; }

  // ── Diaphragm visualization ────────────────────────────────────────────────
  refreshDiaphragms() {
    // Remove old
    for (const grp of this._diaGroups.values()) this._scene.remove(grp);
    this._diaGroups.clear();
    // Build new
    for (const d of this.app.model.diaphragms.values()) {
      const grp = this._buildDiaphragmViz(d);
      if (grp) {
        this._scene.add(grp);
        this._diaGroups.set(d.id, grp);
      }
    }
  }

  // ── Link / coupling visualization ───────────────────────────────────────────
  refreshLinks() {
    for (const grp of this._linkGroups.values()) this._scene.remove(grp);
    this._linkGroups.clear();
    for (const lk of (this.app.model.links?.values() || [])) {
      const grp = this._buildLinkViz(lk);
      if (grp) { this._scene.add(grp); this._linkGroups.set(lk.id, grp); }
    }
  }

  _buildLinkViz(lk) {
    const nm = this.app.model.nodes.get(lk.master);
    const ns = this.app.model.nodes.get(lk.slave);
    if (!nm || !ns) return null;

    const grp = new THREE.Group();
    const COL = lk.rigid ? 0x111111 : 0x9c27b0;  // black=rigid (don't confuse with loads), purple=coupling
    const pm = this.m2t(nm.x, nm.y, nm.z);
    const ps = this.m2t(ns.x, ns.y, ns.z);

    // Master→slave line: solid if rigid, dashed if partial coupling.
    const geo = new THREE.BufferGeometry().setFromPoints([pm, ps]);
    let line;
    if (lk.rigid) {
      line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: COL }));
    } else {
      line = new THREE.Line(geo, new THREE.LineDashedMaterial(
        { color: COL, dashSize: 0.15, gapSize: 0.1 }));
      line.computeLineDistances();
    }
    line.userData = { type: 'link', id: lk.id };
    line.renderOrder = 3;
    grp.add(line);

    // Square marker at the master node (origin of the rigid offset).
    const s = 0.12;
    const sq = [
      this.m2t(nm.x - s, nm.y - s, nm.z), this.m2t(nm.x + s, nm.y - s, nm.z),
      this.m2t(nm.x + s, nm.y + s, nm.z), this.m2t(nm.x - s, nm.y + s, nm.z),
      this.m2t(nm.x - s, nm.y - s, nm.z),
    ];
    grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(sq),
      new THREE.LineBasicMaterial({ color: COL })));

    // Arrow (cone) toward the slave to mark the coupling direction.
    const dir = ps.clone().sub(pm);
    const len = dir.length();
    if (len > 1e-6) {
      dir.normalize();
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.08, 0.22, 8),
        new THREE.MeshBasicMaterial({ color: COL }));
      const mid = pm.clone().addScaledVector(dir, len * 0.55);
      cone.position.copy(mid);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      grp.add(cone);
    }

    grp.userData = { type: 'link', id: lk.id };
    return grp;
  }

  // Andrew's monotone chain — returns convex hull of [{x,y}] in CCW order
  _convexHull(pts) {
    if (pts.length < 3) return pts.slice();
    const sorted = [...pts].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
    const cross = (o, a, b) =>
      (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [], upper = [];
    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0)
        lower.pop();
      lower.push(p);
    }
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0)
        upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    return [...lower, ...upper];
  }

  _buildDiaphragmViz(d) {
    const nodes = d.nodes
      .map(id => this.app.model.nodes.get(id))
      .filter(Boolean);
    if (nodes.length < 2) return null;

    const grp    = new THREE.Group();
    const DIA_COL = 0x00bcd4;  // cyan  — diaphragm outline
    const CM_COL  = 0xff7043;  // orange — CM marker
    const CR_COL  = 0x00e5ff;  // bright cyan — CR / master marker

    // ── Convex-hull floor shape ────────────────────────────────────────────
    const PAD  = 0.25;
    const hull = this._convexHull(nodes.map(n => ({ x: n.x, y: n.y })));

    // Expand slightly outward from hull centroid
    const hcx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
    const hcy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
    const padded = hull.map(p => ({
      x: p.x + (p.x >= hcx ? PAD : -PAD),
      y: p.y + (p.y >= hcy ? PAD : -PAD),
    }));

    // Filled polygon (click target).
    // m2t: model(x,y,z)→Three(x,z,y).  ShapeGeometry in XY + rotation.x=+π/2
    // gives local(x,y)→world(x, d.z, y)  ✓
    const shape = new THREE.Shape(padded.map(p => new THREE.Vector2(p.x, p.y)));
    const planeMat = new THREE.MeshBasicMaterial({
      color: DIA_COL, transparent: true, opacity: 0.07,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const plane = new THREE.Mesh(new THREE.ShapeGeometry(shape), planeMat);
    plane.position.set(0, d.z, 0);
    plane.rotation.x = Math.PI / 2;
    plane.userData = { type: 'diaphragm', id: d.id };
    grp.add(plane);

    // Polygon outline
    const outlinePts = [...padded, padded[0]].map(p => this.m2t(p.x, p.y, d.z));
    grp.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(outlinePts),
      new THREE.LineBasicMaterial({ color: DIA_COL, transparent: true, opacity: 0.75 }),
    ));

    // ── CM and CR markers ──────────────────────────────────────────────────
    // REAL centroid of the diaphragm's nodes (not the padded hull's) — used as a
    // fallback for CM/CR when undefined, so they're not drawn in a corner.
    const ncx = nodes.reduce((s, n) => s + n.x, 0) / nodes.length;
    const ncy = nodes.reduce((s, n) => s + n.y, 0) / nodes.length;
    const masterId = d.masterId || d.nodes[0];
    const master   = this.app.model.nodes.get(masterId);
    if (master) {
      // CR: master if defined; otherwise the centroid. CM: the mass one if present,
      // if it is (0,0)/absent it falls back to the centroid. Both avoid the corner.
      const crx = d.masterId ? master.x : ncx, cry = d.masterId ? master.y : ncy;
      const cmSet = d.cm && (d.cm.x !== 0 || d.cm.y !== 0);
      const cmx = (cmSet ? d.cm.x : ncx) + (d.eccentricity?.ex ?? 0);
      const cmy = (cmSet ? d.cm.y : ncy) + (d.eccentricity?.ey ?? 0);

      // Line CR → CM
      grp.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          this.m2t(crx, cry, d.z), this.m2t(cmx, cmy, d.z)
        ]),
        new THREE.LineBasicMaterial({ color: CM_COL, transparent: true, opacity: 0.5 }),
      ));

      // CM marker: cross + circle (orange)
      const s = 0.25, R = 0.35, nSeg = 16;
      const cmMat = new THREE.LineBasicMaterial({ color: CM_COL });
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [this.m2t(cmx-s, cmy, d.z), this.m2t(cmx+s, cmy, d.z)]), cmMat));
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [this.m2t(cmx, cmy-s, d.z), this.m2t(cmx, cmy+s, d.z)]), cmMat));
      const circPts = [];
      for (let i = 0; i <= nSeg; i++) {
        const a = (i / nSeg) * Math.PI * 2;
        circPts.push(this.m2t(cmx + R*Math.cos(a), cmy + R*Math.sin(a), d.z));
      }
      grp.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(circPts),
        new THREE.LineBasicMaterial({ color: CM_COL, transparent: true, opacity: 0.8 }),
      ));
      // Invisible click sphere at CM
      const cmSphere = new THREE.Mesh(
        new THREE.SphereGeometry(R * 1.1, 8, 8),
        new THREE.MeshBasicMaterial({ color: CM_COL, transparent: true, opacity: 0.0 }),
      );
      cmSphere.position.copy(this.m2t(cmx, cmy, d.z));
      cmSphere.userData = { type: 'cm-sphere', diaId: d.id };
      grp.add(cmSphere);

      // CR marker: square outline (bright cyan) at master node position
      const hs = 0.32;  // half-side
      const crMat = new THREE.LineBasicMaterial({ color: CR_COL });
      const sqPts = [
        this.m2t(crx-hs, cry-hs, d.z), this.m2t(crx+hs, cry-hs, d.z),
        this.m2t(crx+hs, cry+hs, d.z), this.m2t(crx-hs, cry+hs, d.z),
        this.m2t(crx-hs, cry-hs, d.z),
      ];
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(sqPts), crMat));
      // Diagonal cross inside square
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [this.m2t(crx-hs, cry-hs, d.z), this.m2t(crx+hs, cry+hs, d.z)]), crMat));
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [this.m2t(crx+hs, cry-hs, d.z), this.m2t(crx-hs, cry+hs, d.z)]), crMat));
    }

    grp.userData = { type: 'diaphragm', id: d.id };
    return grp;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // RESULTS VISUALIZATION
  // ════════════════════════════════════════════════════════════════════════════

  clearResults() {
    // Stop animation
    this._animFn = null;
    this._animMeshNodes = [];
    this._animLineElems = [];

    if (!this._resultObjects) return;
    for (const obj of this._resultObjects) this._scene.remove(obj);
    this._resultObjects = [];
    for (const [id, mesh] of this._nodeMeshes) {
      const node = this.app.model.nodes.get(id);
      if (node) mesh.material.color.set(this._nodeColor(node));
      mesh.visible = true;
    }
    for (const [, line] of this._elemLines) {
      line.material.color.set(COL.ELEM);
      line.material.opacity = 1; line.material.transparent = false;   // undo the modal ghost
      line.visible = true;
    }
    for (const [, grp] of this._suppGroups) grp.visible = true;
    this.resetAreaColors();
    this._inResultsMode = false;
    this._results = null;
    this._currentDiagramType = null;
    this._hideInspector();
    this._hideResultTip();   // #36: quitar el tooltip de mín/máx del hover
    document.getElementById('results-banner').classList.remove('visible');
    document.getElementById('results-overlay').classList.add('hidden');
    document.getElementById('modal-analysis-overlay')?.classList.add('hidden');
    const lco = document.getElementById('lc-overlay');
    if (lco) lco.style.display = '';
    document.getElementById('btn-clear-results').style.display = 'none';
    // Hide colorbar
    const cbw = document.getElementById('colorbar-wrap');
    if (cbw) cbw.style.display = 'none';
  }

  // factor = RELATIVE multiplier over the auto-normalized scale (1 = automatic fit;
  // null/undefined also = 1). The deformed shape is ALWAYS normalized to ~span/50 of
  // on-screen size, regardless of the real magnitude of δ.
  showDeformed(results, factor) {
    this.clearLoads();
    this.clearResults();
    this._resultObjects = [];
    this._inResultsMode = true;
    this._results = results;
    this._currentDiagramType = null;

    const maxD = results.getMaxDisp();
    const b = this.app.model.getBounds();
    const span = Math.max(b.max.x-b.min.x, b.max.y-b.min.y, b.max.z-b.min.z, 1);
    const autoBase = maxD > 1e-12 ? span / 50 / maxD : 100;   // normalizes: δmax → span/50
    this._autoScaleBase = autoBase;
    const f = (factor == null || !isFinite(factor) || factor <= 0) ? 1 : factor;
    const scale = autoBase * f;
    document.getElementById('result-scale').value = +f.toPrecision(3);

    // Ghost original model
    for (const [, line] of this._elemLines) line.material.color.set(0x222840);
    for (const [, mesh] of this._nodeMeshes) mesh.visible = false;
    for (const [, grp]  of this._suppGroups)  grp.visible  = false;

    // Hermite cubic interpolation — smooth deformed shape (8 pts per element)
    const NPTS = 8;
    for (const elem of this.app.model.elements.values()) {
      const n1  = this.app.model.nodes.get(elem.n1);
      const n2  = this.app.model.nodes.get(elem.n2);
      const pts = [];
      for (let k = 0; k <= NPTS; k++) {
        const xi = k / NPTS;
        const d  = results.getElemAtXi(elem.id, xi);
        if (!d) break;
        pts.push(this.m2t(
          n1.x + xi*(n2.x - n1.x) + scale*d.ux,
          n1.y + xi*(n2.y - n1.y) + scale*d.uy,
          n1.z + xi*(n2.z - n1.z) + scale*d.uz
        ));
      }
      if (pts.length < 2) continue;
      const dmid = results.getElemAtXi(elem.id, 0.5);
      const tmid = (maxD > 1e-12 && dmid)
        ? Math.hypot(dmid.ux, dmid.uy, dmid.uz) / maxD : 0;
      const geo  = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: _dispColor(tmid) }));
      this._scene.add(line);
      this._resultObjects.push(line);
    }
    for (const node of this.app.model.nodes.values()) {
      const dc   = results.getDeformedCoords(node.id, scale);
      const dmag = Math.hypot(...results.getNodeDisp(node.id).slice(0,3));
      const t    = maxD > 1e-12 ? dmag/maxD : 0;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(NODE_R*0.8, 6, 6),
        new THREE.MeshBasicMaterial({ color: _dispColor(t) })
      );
      mesh.position.copy(this.m2t(dc.x, dc.y, dc.z));
      this._scene.add(mesh);
      this._resultObjects.push(mesh);
    }
    this._showResultsUI(`Deformada ×${_fmt(scale)} (factor ×${+f.toPrecision(3)}) | δmax=${_fmt(maxD)}`);
    this._drawColorbar(0, maxD);
    // The faces deform with the nodes and are colored by von Mises (if there are areas).
    this.colorAreasByVM(results, scale);
  }

  // ── Area STRESS contour (von Mises) ─────────────────────────────────────────
  // Dedicated view: members in gray (ghost) and faces colored by the smoothed nodal
  // von Mises over the real (undeformed) geometry. For shells it is the surface
  // envelope; for membranes, the in-plane von Mises.
  showAreaStress(results) {
    this.clearLoads();
    this.clearResults();
    this._resultObjects = [];
    this._inResultsMode = true;
    this._results = results;
    this._currentDiagramType = 'vm';

    const model = this.app.model;
    const hasAreas = model.areas && model.areas.size > 0;
    // Members and nodes ghosted so the faces stand out.
    for (const [, line] of this._elemLines) line.material.color.set(0x222840);
    for (const [, mesh] of this._nodeMeshes) mesh.visible = false;
    for (const [, grp]  of this._suppGroups)  grp.visible  = false;

    this.colorAreasByVM(results, 0);   // von Mises contour over real geometry
    const [mn, mx] = this._areaVMrange || [0, 0];
    this._showResultsUI(hasAreas
      ? `von Mises (áreas) | máx = ${_fmt(mx)}`
      : 'Tensiones: el modelo no tiene elementos de área');
  }

  // ── NONLINEAR deformed shape (NL-lite): nodal displacements only ───────────
  // Draws the elements as straight lines between the deformed nodes (member/cable are
  // two-force → straight). Colors: slack cable = dashed gray, tension = teal,
  // compression = orange. uByNode: Map(id → [ux,uy,uz]); elemState:
  // Map(elemId → {taut,N,cable}); relative factor over the auto scale.
  // hinges (optional, #47): [{ nodeId, color }] → marks each plastic hinge at the
  // deformed position of its node, colored by formation order (gradient→red).
  showNLDeformed(uByNode, elemState, factor, infoText, hinges = null, opts = {}) {
    this.clearLoads();
    this.clearResults();
    this._resultObjects = [];
    this._inResultsMode = true;
    this._currentDiagramType = null;

    let maxD = 0;
    for (const u of uByNode.values()) maxD = Math.max(maxD, Math.hypot(u[0], u[1], u[2]));
    const b = this.app.model.getBounds();
    const span = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, 1);
    // By default it auto-scales (span/50) to amplify the small displacements of
    // cables/trusses. With `trueScale` (large corotational rotation) it is shown at
    // REAL SCALE: the displacement is already physical and large.
    const autoBase = opts.trueScale ? 1 : (maxD > 1e-12 ? span / 50 / maxD : 1);
    const f = (factor == null || !isFinite(factor) || factor <= 0) ? 1 : factor;
    const scale = autoBase * f;
    const sc = document.getElementById('result-scale'); if (sc) sc.value = +f.toPrecision(3);

    // Ghost of the original model
    for (const [, line] of this._elemLines) line.material.color.set(0x222840);
    for (const [, mesh] of this._nodeMeshes) mesh.visible = false;
    for (const [, grp]  of this._suppGroups)  grp.visible  = false;

    const defPos = (node) => {
      const u = uByNode.get(node.id) || [0, 0, 0];
      return this.m2t(node.x + scale * u[0], node.y + scale * u[1], node.z + scale * u[2]);
    };

    for (const elem of this.app.model.elements.values()) {
      const n1 = this.app.model.nodes.get(elem.n1);
      const n2 = this.app.model.nodes.get(elem.n2);
      if (!n1 || !n2) continue;
      const st = elemState?.get(elem.id) || {};
      let color = 0x38bdf8, dashed = false;          // tension (teal)
      if ((st.cable || st.compressionOnly) && st.taut === false) { color = 0x64748b; dashed = true; }   // slack cable / loose strut
      else if (st.N < 0)                 { color = 0xf59e0b; }                   // compression (orange)
      const geo = new THREE.BufferGeometry().setFromPoints([defPos(n1), defPos(n2)]);
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: 0.15, gapSize: 0.1 })
        : new THREE.LineBasicMaterial({ color });
      const line = new THREE.Line(geo, mat);
      if (dashed) line.computeLineDistances();
      this._scene.add(line);
      this._resultObjects.push(line);
    }
    for (const node of this.app.model.nodes.values()) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(NODE_R * 0.8, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
      );
      mesh.position.copy(defPos(node));
      this._scene.add(mesh);
      this._resultObjects.push(mesh);
    }
    // Plastic hinges: colored ring at the node's deformed position (#47).
    if (hinges && hinges.length) {
      const rNode = this.app.model.nodes;
      let drawn = 0;
      for (const h of hinges) {
        const node = rNode.get(h.nodeId); if (!node) continue;
        const mk = new THREE.Mesh(
          new THREE.SphereGeometry(NODE_R * 1.6, 10, 10),
          new THREE.MeshBasicMaterial({ color: h.color ?? 0xef4444, transparent: true, opacity: 0.9, depthTest: false })
        );
        mk.position.copy(defPos(node));
        mk.renderOrder = 6;
        this._scene.add(mk);
        this._resultObjects.push(mk);
        drawn++;
      }
      void drawn;
    }
    this._showResultsUI(infoText || `Deformada no lineal ×${_fmt(scale)} | δmax=${_fmt(maxD)}`);
  }

  // factor = RELATIVE multiplier over the auto-normalized scale (1 = automatic fit).
  // The diagram is ALWAYS normalized to ~15% of the span, regardless of the force
  // magnitude (N in kN vs M in kN·m, etc.).
  showForceDiagram(results, type, factor) {
    this.clearLoads();
    this.clearResults();
    this._resultObjects = [];
    this._inResultsMode = true;
    this._results = results;
    this._currentDiagramType = type;

    // ── normalise getDiagramData return (supports old array format too) ──────
    const _normDiagram = raw => Array.isArray(raw)
      ? { pts: raw, extremes: [] }
      : (raw && raw.pts ? raw : { pts: [], extremes: [] });

    // ── Pass 1: find global max absolute value (includes analytical extrema) ──
    let maxVal = 0;
    for (const elem of this.app.model.elements.values()) {
      const d = _normDiagram(results.getDiagramData(elem.id, type, 2));
      for (const p of d.pts)      if (Math.abs(p.val)   > maxVal) maxVal = Math.abs(p.val);
      for (const e of d.extremes) if (Math.abs(e.val)   > maxVal) maxVal = Math.abs(e.val);
    }
    const b = this.app.model.getBounds();
    const span = Math.max(b.max.x-b.min.x, b.max.y-b.min.y, b.max.z-b.min.z, 1);
    const autoBase = maxVal > 1e-12 ? span * 0.15 / maxVal : 1;   // normalizes: max → 15% of span
    this._autoScaleBase = autoBase;
    const f = (factor == null || !isFinite(factor) || factor <= 0) ? 1 : factor;
    const scale = autoBase * f;
    document.getElementById('result-scale').value = +f.toPrecision(3);

    for (const [, line] of this._elemLines) line.material.color.set(0x222840);
    const useLocalZ = (type === 'My' || type === 'Vz');

    // ── Pass 2: draw diagrams ──────────────────────────────────────────────
    for (const elem of this.app.model.elements.values()) {
      const f = results.getElemForces(elem.id);
      if (!f) continue;
      const { pts, extremes } = _normDiagram(results.getDiagramData(elem.id, type, 20));

      // Perpendicular direction for diagram offset (in Three.js coords)
      const perpDir = useLocalZ
        ? new THREE.Vector3(f.ez[0], f.ez[2], f.ez[1])
        : new THREE.Vector3(f.ey[0], f.ey[2], f.ey[1]);

      const linePoints = [];
      const fillVerts  = [];

      for (const { pos, val } of pts) {
        const baseP = this.m2t(pos.x, pos.y, pos.z);
        const diagP = baseP.clone().addScaledVector(perpDir, val * scale);
        linePoints.push(diagP);
        fillVerts.push(baseP.x, baseP.y, baseP.z, diagP.x, diagP.y, diagP.z);
      }
      // Close polygon back to baseline
      const last = pts[pts.length-1];
      linePoints.push(this.m2t(last.pos.x, last.pos.y, last.pos.z));
      for (let i = pts.length-1; i >= 0; i--) {
        const { pos } = pts[i];
        linePoints.push(this.m2t(pos.x, pos.y, pos.z));
      }

      const avgAbs = pts.reduce((s,p)=>s+Math.abs(p.val),0)/pts.length;
      const col = maxVal > 1e-12 ? _forceColor(avgAbs/maxVal) : 0xffc107;

      const outlineGeo = new THREE.BufferGeometry().setFromPoints(linePoints);
      const outline = new THREE.Line(outlineGeo, new THREE.LineBasicMaterial({ color: col }));
      this._scene.add(outline);
      this._resultObjects.push(outline);

      const fillGeo = new THREE.BufferGeometry();
      fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(fillVerts, 3));
      const fill = new THREE.LineSegments(fillGeo,
        new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.3 })
      );
      this._scene.add(fill);
      this._resultObjects.push(fill);

      // ── Inner-extreme markers (zero-shear peak for moment diagrams) ──────
      for (const ext of extremes) {
        if (Math.abs(ext.val) < maxVal * 0.005) continue;  // skip noise
        const baseP = this.m2t(ext.pos.x, ext.pos.y, ext.pos.z);
        const tipP  = baseP.clone().addScaledVector(perpDir, ext.val * scale);

        // Small yellow dot at diagram peak
        const dotGeo = new THREE.SphereGeometry(0.06, 6, 4);
        const dot    = new THREE.Mesh(dotGeo,
          new THREE.MeshBasicMaterial({ color: 0xffee58, depthTest: false }));
        dot.position.copy(tipP);
        this._scene.add(dot);
        this._resultObjects.push(dot);

        // Vertical tick line from baseline to peak
        const tickGeo = new THREE.BufferGeometry().setFromPoints([baseP, tipP]);
        const tick    = new THREE.Line(tickGeo,
          new THREE.LineBasicMaterial({ color: 0xffee58, transparent: true, opacity: 0.7 }));
        this._scene.add(tick);
        this._resultObjects.push(tick);

        // Value label offset slightly beyond the peak
        const labelPos = tipP.clone().addScaledVector(
          perpDir, ext.val >= 0 ? 0.28 : -0.28);
        const sp = this._makeDiagramLabel(_fmt(ext.val), labelPos);
        this._scene.add(sp);
        this._resultObjects.push(sp);
      }
    }
    this._showResultsUI(`${type} | máx = ${_fmt(maxVal)} (factor ×${+f.toPrecision(3)})`);
    this._drawColorbar(0, maxVal);
  }

  _showResultsUI(summary) {
    document.getElementById('results-overlay').classList.remove('hidden');
    document.getElementById('result-summary').textContent = summary;
    document.getElementById('results-banner').classList.add('visible');
    document.getElementById('btn-clear-results').style.display = '';
  }

  // ════════════════════════════════════════════════════════════════════════════
  // RESULTS-MODE CLICK & FLOATING INSPECTOR PANEL
  // ════════════════════════════════════════════════════════════════════════════

  _clickResults(e) {
    const elemHits = this._raycaster.intersectObjects([...this._elemLines.values()].filter(l => l.visible));
    const nodeHits = this._raycaster.intersectObjects([...this._nodeMeshes.values()]);
    const areaHits = this._raycaster.intersectObjects(this._areaFills());

    if (elemHits.length) {
      const elemId = elemHits[0].object.userData.id;
      if (this._results) this._showElemInspector(elemId, e.clientX, e.clientY);
    } else if (nodeHits.length) {
      const nodeId = nodeHits[0].object.userData.id;
      if (this._results) this._showNodeInspector(nodeId, e.clientX, e.clientY);
    } else if (areaHits.length) {
      // Areas have no floating inspector: they are shown in the right panel
      // (stresses, plate moments and nodal displacements).
      const areaId = areaHits[0].object.userData.id;
      const area = this.app.model.areas.get(areaId);
      if (area) { this._hideInspector(); this.app.panel.showArea(area); }
    } else {
      this._hideInspector();
    }
  }

  // ── Inspector panel creation (lazy, one panel reused) ─────────────────────
  _ensureInspPanel() {
    if (this._inspPanel) return;

    const div = document.createElement('div');
    div.className = 'elem-inspector hidden';
    div.innerHTML = `
      <div class="insp-header">
        <span class="insp-title">—</span>
        <button class="insp-close" title="Cerrar">×</button>
      </div>
      <div class="insp-meta"></div>
      <div class="insp-tabs">
        <button class="insp-tab active" data-type="Mz">Mz</button>
        <button class="insp-tab" data-type="My">My</button>
        <button class="insp-tab" data-type="Vy">Vy</button>
        <button class="insp-tab" data-type="Vz">Vz</button>
        <button class="insp-tab" data-type="N">N</button>
        <button class="insp-tab" data-type="T">T</button>
      </div>
      <div class="insp-svg-wrap">
        <svg class="insp-svg" viewBox="0 0 260 70" preserveAspectRatio="none"></svg>
      </div>
      <div class="insp-slider-row">
        <span class="insp-xi-label">ξ = <b class="insp-xi-val">0.50</b></span>
        <input class="insp-xi-slider" type="range" min="0" max="200" value="100">
      </div>
      <div class="insp-forces">
        <div class="ifr"><span>N</span><span class="ifv" data-key="N">—</span></div>
        <div class="ifr"><span>Vy</span><span class="ifv" data-key="Vy">—</span></div>
        <div class="ifr"><span>Vz</span><span class="ifv" data-key="Vz">—</span></div>
        <div class="ifr"><span>T</span><span class="ifv" data-key="T">—</span></div>
        <div class="ifr"><span>My</span><span class="ifv" data-key="My">—</span></div>
        <div class="ifr"><span>Mz</span><span class="ifv" data-key="Mz">—</span></div>
        <div class="ifr ifr-disp"><span>δx</span><span class="ifv" data-key="ux">—</span></div>
        <div class="ifr ifr-disp"><span>δy</span><span class="ifv" data-key="uy">—</span></div>
        <div class="ifr ifr-disp"><span>δz</span><span class="ifv" data-key="uz">—</span></div>
      </div>`;

    document.body.appendChild(div);
    i18n.translate(div);   // floating inspector (body) → not observed; translate explicitly
    this._inspPanel = div;

    // Close button
    div.querySelector('.insp-close').addEventListener('click', () => this._hideInspector());

    // Drag via header
    const hdr = div.querySelector('.insp-header');
    hdr.addEventListener('mousedown', ev => {
      const rect = div.getBoundingClientRect();
      this._inspDragOffset = { dx: ev.clientX - rect.left, dy: ev.clientY - rect.top };
      ev.preventDefault();
    });
    document.addEventListener('mousemove', ev => {
      if (!this._inspDragOffset) return;
      div.style.left = (ev.clientX - this._inspDragOffset.dx) + 'px';
      div.style.top  = (ev.clientY - this._inspDragOffset.dy) + 'px';
    });
    document.addEventListener('mouseup', () => { this._inspDragOffset = null; });

    // Slider
    const slider = div.querySelector('.insp-xi-slider');
    slider.addEventListener('input', () => {
      this._inspXi = slider.value / 200;
      div.querySelector('.insp-xi-val').textContent = this._inspXi.toFixed(2);
      this._updateInspectorForces();
      this._drawInspDiagram();
    });

    // Tabs
    div.querySelectorAll('.insp-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        div.querySelectorAll('.insp-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._inspType = btn.dataset.type;
        this._drawInspDiagram();
      });
    });
  }

  _showElemInspector(elemId, screenX, screenY) {
    this._ensureInspPanel();
    this._inspElemId = elemId;
    this._inspXi     = 0.5;

    const elem = this.app.model.elements.get(elemId);
    const mat  = this.app.model.materials.get(elem?.matId);
    const sec  = this.app.model.sections.get(elem?.secId);
    const f    = this._results.getElemForces(elemId);

    // Position panel near click, keeping it within viewport bounds
    const pw  = 284, ph = 360;
    let left  = screenX + 14;
    let top   = screenY + 14;
    if (left + pw > window.innerWidth  - 4) left = screenX - pw - 14;
    if (top  + ph > window.innerHeight - 4) top  = screenY - ph - 14;
    if (left < 4) left = 4;
    if (top  < 4) top  = 4;
    this._inspPanel.style.left = left + 'px';
    this._inspPanel.style.top  = top  + 'px';

    // Title & meta
    const L = f ? f.L.toFixed(2) : '—';
    this._inspPanel.querySelector('.insp-title').textContent = `${i18n.t('Elemento')} #${elemId}`;
    this._inspPanel.querySelector('.insp-meta').textContent  =
      `L=${L}m  |  ${mat?.name || '—'}  |  ${sec?.name || '—'}`;

    // Reset slider to midspan
    const slider = this._inspPanel.querySelector('.insp-xi-slider');
    slider.value = 100;
    this._inspPanel.querySelector('.insp-xi-val').textContent = '0.50';

    // Set active tab to current diagram type (or Mz if deformed)
    const activeType = this._currentDiagramType || 'Mz';
    this._inspType = activeType;
    this._inspPanel.querySelectorAll('.insp-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.type === activeType);
    });

    this._updateInspectorForces();
    this._drawInspDiagram();
    this._inspPanel.classList.remove('hidden');
  }

  _showNodeInspector(nodeId, screenX, screenY) {
    this._ensureInspPanel();
    this._inspElemId = null;

    const d = this._results.getNodeDisp(nodeId);
    const r = this._results.getReaction(nodeId);

    const pw  = 284, ph = 280;
    let left  = screenX + 14;
    let top   = screenY + 14;
    if (left + pw > window.innerWidth  - 4) left = screenX - pw - 14;
    if (top  + ph > window.innerHeight - 4) top  = screenY - ph - 14;
    if (left < 4) left = 4;
    if (top  < 4) top  = 4;
    this._inspPanel.style.left = left + 'px';
    this._inspPanel.style.top  = top  + 'px';

    this._inspPanel.querySelector('.insp-title').textContent = `${i18n.t('Nodo')} #${nodeId}`;
    this._inspPanel.querySelector('.insp-meta').textContent  = '';

    const vals = {
      N: 'Rx: ' + _fmt(r[0]), Vy: 'Ry: ' + _fmt(r[1]), Vz: 'Rz: ' + _fmt(r[2]),
      T: 'Rmx: '+ _fmt(r[3]), My: 'Rmy: '+ _fmt(r[4]), Mz: 'Rmz: '+ _fmt(r[5]),
      ux: _fmt(d[0]), uy: _fmt(d[1]), uz: _fmt(d[2])
    };
    this._inspPanel.querySelectorAll('.ifv').forEach(el => {
      const k = el.dataset.key;
      el.textContent = vals[k] ?? '—';
    });

    // Clear SVG and slider for node mode
    this._inspPanel.querySelector('.insp-svg').innerHTML = '';
    this._inspPanel.querySelector('.insp-xi-slider').value = 100;

    this._inspPanel.classList.remove('hidden');
  }

  _updateInspectorForces() {
    if (!this._inspElemId || !this._results) return;
    const r = this._results.getElemAtXi(this._inspElemId, this._inspXi);
    if (!r) return;
    this._inspPanel.querySelectorAll('.ifv').forEach(el => {
      const k = el.dataset.key;
      el.textContent = r[k] !== undefined ? _fmt(r[k]) : '—';
    });
  }

  _drawInspDiagram() {
    if (!this._inspElemId || !this._results) return;
    const svg  = this._inspPanel.querySelector('.insp-svg');
    const type = this._inspType;

    const data = this._results.getDiagramData(this._inspElemId, type, 20);
    if (!data.pts.length) { svg.innerHTML = ''; return; }

    const W = 260, H = 70, pad = 4;
    const absMax = Math.max(Math.abs(data.maxVal), Math.abs(data.minVal), 1e-12);
    const yw = (H - pad*2) / 2;
    const baseline = H / 2;
    const N = data.pts.length;

    const xOf = i => pad + (i / (N - 1)) * (W - pad*2);
    const yOf = v => baseline - (v / absMax) * yw;

    // Build SVG path
    let d = `M ${xOf(0).toFixed(1)} ${yOf(data.pts[0].val).toFixed(1)}`;
    for (let i = 1; i < N; i++) {
      d += ` L ${xOf(i).toFixed(1)} ${yOf(data.pts[i].val).toFixed(1)}`;
    }

    // Close back along baseline
    d += ` L ${xOf(N-1).toFixed(1)} ${baseline}`;
    d += ` L ${xOf(0).toFixed(1)} ${baseline} Z`;

    // Current xi marker
    const mx = (pad + this._inspXi * (W - pad*2)).toFixed(1);

    // Extreme markers
    let extDots = '';
    for (const ext of data.extremes) {
      const ex = (pad + ext.xi * (W - pad*2)).toFixed(1);
      const ey = yOf(ext.val).toFixed(1);
      extDots += `<circle cx="${ex}" cy="${ey}" r="3" fill="#ffe082"/>`;
    }

    // Value at xi
    const atXi = this._results.getElemAtXi(this._inspElemId, this._inspXi);
    const vAtXi = atXi ? (type === 'N' ? atXi.N : type === 'Vy' ? atXi.Vy : type === 'Vz' ? atXi.Vz : type === 'T' ? atXi.T : type === 'My' ? atXi.My : atXi.Mz) : null;
    const labelY = vAtXi !== null ? yOf(vAtXi).toFixed(1) : baseline;
    const labelTxt = vAtXi !== null ? _fmt(vAtXi) : '';

    svg.innerHTML = `
      <line x1="${pad}" y1="${baseline}" x2="${W-pad}" y2="${baseline}" stroke="#334" stroke-width="1"/>
      <path d="${d}" fill="rgba(100,180,255,0.18)" stroke="#4fc3f7" stroke-width="1.5"/>
      ${extDots}
      <line x1="${mx}" y1="${pad}" x2="${mx}" y2="${H-pad}" stroke="#ff7043" stroke-width="1.5" stroke-dasharray="3,2"/>
      <circle cx="${mx}" cy="${labelY}" r="3.5" fill="#ff7043"/>
      <text x="${+mx+5}" y="${+labelY-3}" font-size="9" fill="#ff7043">${labelTxt}</text>
      <text x="${W-pad}" y="${pad+8}" font-size="8" fill="#90a4ae" text-anchor="end">${type}</text>`;
  }

  _hideInspector() {
    if (this._inspPanel) this._inspPanel.classList.add('hidden');
    this._inspElemId = null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MODAL / DYNAMIC VISUALIZATION
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Display a single mode shape (static snapshot at factor=1).
   * Sets up _animMeshNodes and _animLineElems for live animation updates.
   * @param {ModalResults} modalResults
   * @param {number}       modeIndex   0-based
   * @param {number}       scale       visual amplitude in model units
   */
  showModeShape(modalResults, modeIndex, scale = 1.0) {
    this.clearResults();
    this._resultObjects = [];
    this._inResultsMode = true;
    this._animMeshNodes = [];
    this._animLineElems = [];

    // ORIGINAL structure as a faint ghost (translucent gray) to identify the mode's
    // motion without competing with it visually.
    for (const [, line] of this._elemLines) {
      line.material.color.set(0x8a9bb0);
      line.material.transparent = true;
      line.material.opacity = 0.28;
    }
    for (const [, mesh] of this._nodeMeshes) mesh.visible = false;
    for (const [, grp]  of this._suppGroups) grp.visible  = false;

    const shape = modalResults.getModeShape(modeIndex);

    // ── Deformed elements ────────────────────────────────────────────────────
    for (const elem of this.app.model.elements.values()) {
      const n1 = this.app.model.nodes.get(elem.n1);
      const n2 = this.app.model.nodes.get(elem.n2);
      if (!n1 || !n2) continue;

      const d1 = shape.get(elem.n1) || _zeroDisp;
      const d2 = shape.get(elem.n2) || _zeroDisp;

      const p1base = this.m2t(n1.x, n1.y, n1.z);
      const p2base = this.m2t(n2.x, n2.y, n2.z);
      // Displacement vectors in Three.js coords (same m2t transform)
      const dp1 = new THREE.Vector3(d1[0], d1[2], d1[1]);
      const dp2 = new THREE.Vector3(d2[0], d2[2], d2[1]);

      const geo = new THREE.BufferGeometry().setFromPoints([
        p1base.clone().addScaledVector(dp1, scale),
        p2base.clone().addScaledVector(dp2, scale)
      ]);
      const mat  = new THREE.LineBasicMaterial({ color: 0x4fc3f7 });
      const line = new THREE.Line(geo, mat);
      this._scene.add(line);
      this._resultObjects.push(line);
      this._animLineElems.push({ geo, p1base, p2base, dp1, dp2 });
    }

    // ── Deformed nodes ───────────────────────────────────────────────────────
    for (const node of this.app.model.nodes.values()) {
      const d     = shape.get(node.id) || _zeroDisp;
      const pbase = this.m2t(node.x, node.y, node.z);
      const dp    = new THREE.Vector3(d[0], d[2], d[1]);

      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(NODE_R * 0.85, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0x4fc3f7 })
      );
      mesh.position.copy(pbase.clone().addScaledVector(dp, scale));
      this._scene.add(mesh);
      this._resultObjects.push(mesh);
      this._animMeshNodes.push({ mesh, pbase, dp });
    }

    // Hide LC overlay, show clear button, keep modal overlay visible
    const lco = document.getElementById('lc-overlay');
    if (lco) lco.style.display = 'none';
    document.getElementById('btn-clear-results').style.display = '';
    document.getElementById('results-banner').classList.add('visible');
    document.getElementById('results-banner').textContent =
      'MODO DINÁMICO — haga clic sobre nodos y elementos para ver valores';
    document.getElementById('modal-analysis-overlay')?.classList.remove('hidden');
  }

  /**
   * Update geometry positions with the given amplitude factor (−1…+1).
   * Called each animation frame.
   */
  _applyModeShapeScale(scale, factor) {
    const s = scale * factor;
    for (const { mesh, pbase, dp } of this._animMeshNodes) {
      mesh.position.copy(pbase).addScaledVector(dp, s);
    }
    for (const { geo, p1base, p2base, dp1, dp2 } of this._animLineElems) {
      const pos = geo.attributes.position;
      const p1  = p1base.clone().addScaledVector(dp1, s);
      const p2  = p2base.clone().addScaledVector(dp2, s);
      pos.setXYZ(0, p1.x, p1.y, p1.z);
      pos.setXYZ(1, p2.x, p2.y, p2.z);
      pos.needsUpdate = true;
    }
  }

  /**
   * Start oscillating animation of the currently shown mode shape.
   * @param {number} scale  visual amplitude (model units)
   * @param {number} speed  multiplier on angular speed (1 = normal)
   */
  startModeAnimation(scale, speed = 1.0) {
    this._animT = 0;
    this._animFn = () => {
      this._animT += 0.045 * speed;
      this._applyModeShapeScale(scale, Math.sin(this._animT));
    };
  }

  /** Pause animation and show mode at full positive amplitude. */
  stopAnimation(scale) {
    this._animFn = null;
    this._applyModeShapeScale(scale, 1.0);
  }

  // ── P2-4: Color legend bar ────────────────────────────────────────────────
  _drawColorbar(minVal, maxVal) {
    const canvas = document.getElementById('colorbar-canvas');
    const wrap   = document.getElementById('colorbar-wrap');
    if (!canvas || !wrap) return;

    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    // blue → cyan → green → yellow → red  (matches _dispColor)
    grad.addColorStop(0,    '#0000ff');
    grad.addColorStop(0.25, '#00ffff');
    grad.addColorStop(0.5,  '#00ff00');
    grad.addColorStop(0.75, '#ffff00');
    grad.addColorStop(1,    '#ff0000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    wrap.style.display = '';
    document.getElementById('cb-min').textContent = _fmt(minVal);
    document.getElementById('cb-mid').textContent = _fmt((minVal + maxVal) / 2);
    document.getElementById('cb-max').textContent = _fmt(maxVal);
  }

  // ── P2-6: Node / element ID sprites ──────────────────────────────────────
  toggleIds() {
    this._showIds = !this._showIds;
    for (const s of this._idSprites) this._scene.remove(s);
    this._idSprites = [];

    const btn = document.getElementById('btn-toggle-ids');
    if (btn) btn.classList.toggle('active', this._showIds);
    if (!this._showIds) return;

    const model = this.app.model;
    const addSprite = (text, col, pos, scaleX = 0.9) => {
      const sp = this._makeIdSprite(text, col);
      sp.position.copy(pos);
      sp.scale.set(scaleX, 0.38, 1);
      this._scene.add(sp);
      this._idSprites.push(sp);
    };

    // Node IDs — cyan, above node
    for (const [id, mesh] of this._nodeMeshes) {
      addSprite(`N${id}`, '#4fc3f7',
        mesh.position.clone().add(new THREE.Vector3(0, 0.34, 0)));
    }

    // Element IDs — orange, at midpoint offset slightly upward
    for (const [id] of this._elemLines) {
      const elem = model.elements.get(id);
      if (!elem) continue;
      const nA = model.nodes.get(elem.n1 ?? elem.nodeA);
      const nB = model.nodes.get(elem.n2 ?? elem.nodeB);
      if (!nA || !nB) continue;
      const mid = this.m2t(
        (nA.x + nB.x) / 2,
        (nA.y + nB.y) / 2,
        (nA.z + nB.z) / 2
      ).add(new THREE.Vector3(0, 0.22, 0));
      addSprite(`E${id}`, '#ffb74d', mid, 0.82);
    }

    // Diaphragm IDs — purple, at master node (CR) raised higher to avoid overlap
    for (const [id, d] of model.diaphragms) {
      const masterId = d.masterId ?? d.nodes?.[0];
      if (!masterId) continue;
      const master = model.nodes.get(masterId);
      if (!master) continue;
      const pos = this.m2t(master.x, master.y, master.z)
        .add(new THREE.Vector3(0, 0.62, 0));
      addSprite(`Dia${id}`, '#ce93d8', pos, 1.15);
    }
  }

  _makeIdSprite(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 28;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(10,14,26,0.75)';
    ctx.fillRect(0, 0, 64, 28);
    ctx.font = 'bold 14px monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, 32, 20);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.9, 0.4, 1);
    return sprite;
  }

  // ── P4-13: Extruded section rendering ─────────────────────────────────────
  toggleExtruded() {
    this._showExtruded = !this._showExtruded;
    const btn = document.getElementById('btn-toggle-extrude');
    if (btn) btn.classList.toggle('active', this._showExtruded);

    // Remove previous extrusions
    for (const obj of (this._extrudedObjects || [])) this._scene.remove(obj);
    this._extrudedObjects = [];

    // Restore line visibility
    for (const [, line] of this._elemLines) line.visible = true;

    if (!this._showExtruded) {
      if (this._extrusionLight) this._extrusionLight.visible = false;
      return;
    }

    // Add directional light for 3D shading
    if (!this._extrusionLight) {
      this._extrusionLight = new THREE.DirectionalLight(0xffffff, 0.8);
      this._extrusionLight.position.set(10, 20, 10);
      this._scene.add(this._extrusionLight);
    }
    this._extrusionLight.visible = true;

    const model = this.app.model;
    for (const elem of model.elements.values()) {
      const n1  = model.nodes.get(elem.n1);
      const n2  = model.nodes.get(elem.n2);
      const sec = model.sections.get(elem.secId);
      if (!n1 || !n2 || !sec) continue;

      // Estimate rectangular b×h from A and Iz:  h=sqrt(12*Iz/A), b=A/h
      const A  = sec.A  || 0.09;
      const Iz = sec.Iz || 6.75e-4;
      const h  = Math.sqrt(12 * Iz / A) || 0.3;
      const b  = A / h;

      const shape = new THREE.Shape();
      shape.moveTo(-b / 2, -h / 2);
      shape.lineTo( b / 2, -h / 2);
      shape.lineTo( b / 2,  h / 2);
      shape.lineTo(-b / 2,  h / 2);
      shape.closePath();

      // Element length
      const dx = n2.x - n1.x, dy = n2.y - n1.y, dz = n2.z - n1.z;
      const L  = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (L < 1e-9) continue;

      const geo = new THREE.ExtrudeGeometry(shape, { depth: L, bevelEnabled: false });
      const mat = new THREE.MeshPhongMaterial({
        color: 0x90caf9, transparent: true, opacity: 0.75, side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(geo, mat);

      // Orient mesh so ExtrudeGeometry +Z points along the element axis
      const axis = new THREE.Vector3(dx / L, dz / L, dy / L); // model→Three.js
      const ref  = Math.abs(axis.y) < 0.99
        ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const side = new THREE.Vector3().crossVectors(axis, ref).normalize();
      const up   = new THREE.Vector3().crossVectors(side, axis).normalize();
      const rm   = new THREE.Matrix4().makeBasis(side, up, axis);
      mesh.applyMatrix4(rm);
      mesh.position.copy(this.m2t(n1.x, n1.y, n1.z));

      this._scene.add(mesh);
      this._extrudedObjects.push(mesh);

      // Dim the wire
      const line = this._elemLines.get(elem.id);
      if (line) line.visible = false;
    }
  }

  // ── Load visualization ────────────────────────────────────────────────────
  clearLoads() {
    for (const obj of this._loadObjects) this._scene.remove(obj);
    this._loadObjects = [];
  }

  // Show / hide the load arrows (toggle from the UI).
  setLoadsVisible(v) {
    this._loadsVisible = !!v;
    this.app.refreshLoads?.();
    return this._loadsVisible;
  }
  toggleLoads() { return this.setLoadsVisible(!(this._loadsVisible !== false)); }

  showLoads(model, lcId) {
    this.clearLoads();
    if (this._loadsVisible === false) return;     // hidden by the user
    const lc = model.loadCases.get(lcId);
    if (!lc || lc.loads.length === 0) return;

    const b    = model.getBounds();
    const span = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, 1);
    // PROPORTIONAL, bounded arrow length: never more than ~7% of the model, so they
    // don't cover the structure (0.28·span used to make them gigantic in trusses).
    const maxLen = span * 0.07;
    const minLen = span * 0.02;

    // Find max force magnitude for proportional scaling
    let maxF = 0, nDist = 0;
    for (const ld of lc.loads) {
      if (ld.type === 'nodal') {
        const mag = Math.hypot(ld.F[0], ld.F[1], ld.F[2]);
        if (mag > maxF) maxF = mag;
      } else if (ld.type === 'dist') {
        nDist++;
        if (Math.abs(ld.w) > maxF) maxF = Math.abs(ld.w);
      }
    }
    if (maxF < 1e-30) return;

    const addArrow = (dir3, origin, frac, color) => {
      const len = Math.min(maxLen, Math.max(minLen, maxLen * frac));
      const hl  = len * 0.30;
      const hw  = len * 0.16;
      const arrow = new THREE.ArrowHelper(dir3.clone().normalize(), origin, len, color, hl, hw);
      this._scene.add(arrow);
      this._loadObjects.push(arrow);
    };
    // Arrow density per element adapted to the number of loads (avoids the clutter
    // when many elements are loaded, e.g. after discretizing or in trusses).
    const perElem = nDist > 30 ? 1 : nDist > 12 ? 2 : 4;

    // Model-direction → Three.js direction (m2t for vectors: x→x, y→z, z→y)
    const dirMap = {
      gravity: new THREE.Vector3( 0, -1, 0),  // downward (structural -Z = Three.js -Y)
      globalZ: new THREE.Vector3( 0, -1, 0),  // legacy alias for gravity — same direction
      globalX: new THREE.Vector3( 1, 0, 0),
      globalY: new THREE.Vector3( 0, 0, 1),
    };

    for (const ld of lc.loads) {
      if (ld.type === 'nodal') {
        const node = model.nodes.get(ld.nodeId);
        if (!node) continue;
        const origin = this.m2t(node.x, node.y, node.z);
        // Fx, Fy, Fz components
        const comps = [
          { f: ld.F[0], dir: new THREE.Vector3( 1, 0, 0) },
          { f: ld.F[1], dir: new THREE.Vector3( 0, 0, 1) },
          { f: ld.F[2], dir: new THREE.Vector3( 0, 1, 0) },
        ];
        for (const { f, dir } of comps) {
          if (Math.abs(f) < 1e-12) continue;
          addArrow(dir.multiplyScalar(Math.sign(f)), origin, Math.abs(f) / maxF, 0xffc107);
        }

      } else if (ld.type === 'dist') {
        const elem = model.elements.get(ld.elemId);
        if (!elem) continue;
        const n1 = model.nodes.get(elem.n1);
        const n2 = model.nodes.get(elem.n2);
        if (!n1 || !n2) continue;
        const p1 = this.m2t(n1.x, n1.y, n1.z);
        const p2 = this.m2t(n2.x, n2.y, n2.z);

        let dir3 = (dirMap[ld.dir] || dirMap.gravity).clone();
        dir3.multiplyScalar(Math.sign(ld.w || -1));
        const frac = Math.abs(ld.w) / maxF;

        // perElem centered arrows (without duplicating at shared endpoints)
        for (let k = 0; k < perElem; k++) {
          const t = (k + 0.5) / perElem;
          const o = p1.clone().lerp(p2, t);
          addArrow(dir3, o, frac, 0x4ade80);
        }
      }
    }
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────────
const _zeroDisp = [0, 0, 0, 0, 0, 0];

// ── Color helpers ────────────────────────────────────────────────────────────
// t ∈ [0,1] → blue→cyan→green→yellow→red
function _dispColor(t) {
  const r = Math.min(1, t * 2);
  const b = Math.max(0, 1 - t * 2);
  const g = t < 0.5 ? t * 2 : (1 - t) * 2;
  return new THREE.Color(r, g, b);
}
function _forceColor(t) {
  return _dispColor(t);
}
function _fmt(v) {
  if (Math.abs(v) < 1e-12) return '0';
  if (Math.abs(v) < 0.001 || Math.abs(v) >= 1e5) return v.toExponential(3);
  return v.toPrecision(4);
}

