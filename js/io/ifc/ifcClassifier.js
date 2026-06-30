// ──────────────────────────────────────────────────────────────────────────────
// io/ifc/ifcClassifier.js — classification of IFC elements · #75, G19
//
// Walks an `IfcModel` and classifies the building elements according to what PORTICO
// can import TODAY (only MEMBERS):
//   • members → IfcBeam / IfcColumn / IfcMember (and their *StandardCase)  ── supported
//   • walls   → IfcWall                                                    ── not supported yet
//   • slabs   → IfcSlab                                                    ── not supported yet
//   • plates  → IfcPlate                                                   ── not supported yet
// (Walls/slabs/plates are LISTED as «not supported» so the user can see what's in the
//  file; they will be enabled once real area import exists.)
//
// It also resolves the useful RELATIONS: which LEVEL each element belongs to
// (IfcRelContainedInSpatialStructure) and which MATERIAL/PROFILE it has associated
// (IfcRelAssociatesMaterial).  STANDALONE (Node + browser).
// ──────────────────────────────────────────────────────────────────────────────

// IFC type → PORTICO class + whether it is importable today
const KIND = new Map([
  ['IFCBEAM', 'beam'], ['IFCBEAMSTANDARDCASE', 'beam'],
  ['IFCCOLUMN', 'column'], ['IFCCOLUMNSTANDARDCASE', 'column'],
  ['IFCMEMBER', 'member'], ['IFCMEMBERSTANDARDCASE', 'member'],
  ['IFCWALL', 'wall'], ['IFCWALLSTANDARDCASE', 'wall'], ['IFCWALLELEMENTEDCASE', 'wall'],
  ['IFCSLAB', 'slab'], ['IFCSLABSTANDARDCASE', 'slab'], ['IFCSLABELEMENTEDCASE', 'slab'],
  ['IFCPLATE', 'plate'], ['IFCPLATESTANDARDCASE', 'plate'],
  ['IFCFOOTING', 'footing'], ['IFCPILE', 'pile'],
]);
// members → IfcBeam/Column/Member; areas → IfcWall/Slab/Plate (3–4 nodes in PORTICO)
const SUPPORTED = new Set(['beam', 'column', 'member', 'wall', 'slab', 'plate']);
const AREA_KINDS = new Set(['wall', 'slab', 'plate']);

/** Human-readable label (es) per class, for the UI. */
export const KIND_LABEL = { beam: 'Viga', column: 'Pilar', member: 'Barra', wall: 'Muro', slab: 'Losa', plate: 'Placa', footing: 'Zapata', pile: 'Pilote' };

/**
 * Clasifica los elementos del `IfcModel`.
 * @returns {{
 *   elements: Array<{id,ifcType,kind,supported,name,predefined,storeyId,materialRef}>,
 *   levels:   Array<{id,name,elevation}>,
 *   counts:   Record<string,number>
 * }}
 */
export function classify(model) {
  // ── levels (IfcBuildingStorey) ──
  const levels = model.ofType('IFCBUILDINGSTOREY').map(s => ({
    id: s.id,
    name: (s.args[2] || s.args[7] || `Nivel ${s.id}`).toString(),
    elevation: +s.args[9] || 0,
  })).sort((a, b) => a.elevation - b.elevation);

  // ── spatial containment: element → level ──
  const storeyOf = new Map();
  for (const rel of model.ofType('IFCRELCONTAINEDINSPATIALSTRUCTURE')) {
    const structure = rel.args[5];                 // RelatingStructure
    const sid = model.isRef(structure) ? structure.ref : null;
    for (const o of (rel.args[4] || [])) if (model.isRef(o)) storeyOf.set(o.ref, sid);
  }

  // ── material/profile association: element → RelatingMaterial ──
  const matOf = new Map();
  for (const rel of model.ofType('IFCRELASSOCIATESMATERIAL')) {
    const mat = rel.args[5];                        // RelatingMaterial
    for (const o of (rel.args[4] || [])) if (model.isRef(o)) matOf.set(o.ref, mat);
  }

  // ── elements ──
  const elements = [];
  const counts = {};
  for (const [type, kind] of KIND) {
    for (const e of model.ofType(type)) {
      counts[kind] = (counts[kind] || 0) + 1;
      elements.push({
        id: e.id, ifcType: type, kind, supported: SUPPORTED.has(kind), isArea: AREA_KINDS.has(kind),
        name: (e.args[2] || `${KIND_LABEL[kind] || kind} ${e.id}`).toString(),
        predefined: (typeof e.args[8] === 'string' ? e.args[8] : '') || '',
        storeyId: storeyOf.get(e.id) ?? null,
        materialRef: matOf.get(e.id) ?? null,
      });
    }
  }

  return { elements, levels, counts };
}

export { SUPPORTED, AREA_KINDS, KIND };
