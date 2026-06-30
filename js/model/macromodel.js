// ─────────────────────────────────────────────────────────────────────────────
// macromodel.js — MACROMODELS (#86): nonlinear subsystems solved with a few
// calibrated elements instead of a fine mesh. The user inserts a "panel" and the
// engine EXPANDS it into its internal network of bars/cables/springs.
//
// First: masonry INFILL WALL → EQUIVALENT DIAGONAL STRUT
// (Mainstone 1971 / FEMA 356 §7.5.2). The panel is replaced by 2 COMPRESSION-ONLY
// diagonal struts (one per diagonal): under lateral load, the compressed diagonal
// works and the tensioned one goes slack (N=0) — reuses `el.compressionOnly` (G14 #56).
//
// To ADD more macromodels: register them in `macro_registry.js` (see the `infill`
// registration at the end of this file and the guide `docs/macromodelos.md`).
// ─────────────────────────────────────────────────────────────────────────────
import { registerMacro } from './macro_registry.js?v=2';

/**
 * Width of the equivalent diagonal strut (Mainstone / FEMA 356).
 *   λ₁ = [ E_m·t·sin(2θ) / (4·E_c·I_col·h_m) ]^(1/4)   (frame-infill relative stiffness, 1/L)
 *   a  = 0.175·(λ₁·h_col)^(−0.4)·d_m                    (strut width)
 *   A  = a·t                                            (area, material E_m)
 * @param {object} o { hm, Lm, t, Em, EcIcol, hcol }  (m, kN/m²)
 *   hm=panel height, Lm=panel length, t=thickness, Em=masonry modulus,
 *   EcIcol=bending stiffness of the frame column, hcol=column height.
 * @returns { theta, dm, lambda, w, area }
 */
export function mainstoneStrut({ hm, Lm, t, Em, EcIcol, hcol }) {
  const theta = Math.atan2(hm, Lm);
  const dm = Math.hypot(hm, Lm);
  const lambda = Math.pow((Em * t * Math.sin(2 * theta)) / (4 * EcIcol * hm), 0.25);
  const w = 0.175 * Math.pow(lambda * hcol, -0.4) * dm;
  return { theta, dm, lambda, w, area: w * t };
}

// Orders the 4 corners of a ~rectangular panel by angle around the centroid and
// returns the indices of the 2 DIAGONALS (pairs of opposite corners).
function panelDiagonals(corners) {
  const cx = corners.reduce((s, c) => s + c.x, 0) / 4;
  const cz = corners.reduce((s, c) => s + c.z, 0) / 4;
  const order = corners.map((c, i) => ({ i, a: Math.atan2(c.z - cz, c.x - cx) }))
    .sort((p, q) => p.a - q.a).map(p => p.i);
  // after ordering CCW, the diagonals are (0,2) and (1,3)
  return [[order[0], order[2]], [order[1], order[3]]];
}

/**
 * Inserts an infill wall into the model: creates the masonry material, the strut
 * section (A=w·t) and 2 pin-ended COMPRESSION-ONLY diagonal struts.
 * @param {Model} model
 * @param {number[]} cornerIds  4 panel corner nodes (any order)
 * @param {object} props { Em, t, EcIcol, rho?, name?, fm? }
 * @returns { error } | { strutIds, matId, secId, strut, macroId }
 */
export function insertInfill(model, cornerIds, props = {}) {
  const corners = cornerIds.map(id => model.nodes.get(id));
  if (corners.length !== 4 || corners.some(c => !c)) return { error: 'Se requieren 4 nodos de esquina válidos.' };

  // Panel geometry from the bounding box of the 4 nodes (X–Z plane).
  const xs = corners.map(c => c.x), zs = corners.map(c => c.z);
  const Lm = Math.max(...xs) - Math.min(...xs);
  const hm = Math.max(...zs) - Math.min(...zs);
  if (Lm < 1e-6 || hm < 1e-6) return { error: 'El panel es degenerado (largo o alto nulo).' };

  const t = +props.t || 0.2;
  const Em = +props.Em || 3.0e6;              // kN/m² (≈3 GPa masonry)
  const EcIcol = +props.EcIcol || (2.5e7 * (0.3 ** 4 / 12));   // default col 30×30 G25
  const s = mainstoneStrut({ hm, Lm, t, Em, EcIcol, hcol: hm });
  if (!(s.area > 0) || !isFinite(s.area)) return { error: 'No se pudo calcular el puntal (revise propiedades).' };

  const mat = model.addMaterial({ name: props.name ? `Albañilería ${props.name}` : 'Albañilería (relleno)', E: Em, G: Em / (2 * (1 + 0.2)), nu: 0.2, rho: +props.rho || 1.8 });
  // Strut section: area only (axial); inertia ~0 → pin-ended bar (truss).
  const sec = model.addSection({ name: `Puntal ${(s.w * 100).toFixed(0)}×${(t * 100).toFixed(0)} cm`, A: s.area, Iz: 1e-9, Iy: 1e-9, J: 1e-9, Avy: s.area, Avz: s.area });

  const macroId = (model._nextMacroId = (model._nextMacroId || 0) + 1);
  const strutIds = [];
  for (const [a, b] of panelDiagonals(corners)) {
    const el = model.addElement(corners[a].id, corners[b].id, mat.id, sec.id);
    if (!el) continue;
    el.compressionOnly = true;
    el.releases = [0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1];   // pin-ended (releases T, My, Mz at both ends)
    el.macro = macroId; el.macroType = 'infill';
    strutIds.push(el.id);
  }
  if (strutIds.length < 2) return { error: 'No se pudieron crear los puntales (nodos coincidentes).' };

  // Macro registration (to identify/delete it as a single entity).
  if (!model.macros) model.macros = new Map();
  model.macros.set(macroId, { id: macroId, type: 'infill', corners: cornerIds.map(Number), strutIds, matId: mat.id, secId: sec.id, props: { Em, t, EcIcol }, w: s.w });

  return { strutIds, matId: mat.id, secId: sec.id, strut: s, macroId };
}

// ── Registration of the "infill wall" macromodel (#86) ──────────────────────────
// Pattern to follow for the next macromodels (see docs/macromodelos.md).
registerMacro({
  id: 'infill',
  name: 'Muro de relleno — puntal diagonal',
  desc: 'Albañilería de relleno → 2 puntales diagonales solo-compresión (Mainstone/FEMA 356).',
  nodes: 4,
  nodesHint: 'las 4 esquinas del panel (marco)',
  dims: '2D',
  params: [
    { key: 'Em', label: 'E albañilería (kN/m²)', default: 3.0e6, step: 1e5, min: 1 },
    { key: 't', label: 'Espesor del muro (m)', default: 0.2, step: 0.05, min: 0.01 },
    { key: 'EcIcol', label: 'EcIcol columna del marco (kN·m²)', default: Math.round(2.5e7 * (0.3 ** 4 / 12)), step: 1000, min: 1 },
  ],
  expand: (model, nodeIds, props) => insertInfill(model, nodeIds, props),
});
