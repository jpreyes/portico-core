// sub_mesh.js — expands each original element into nDiv sub-elements for the solver.
// Internal nodes have no restraints and are hidden from the display.
// Original element IDs and node IDs are preserved; sub-elements/nodes use IDs ≥ 1_000_000.

const NODE_OFFSET = 1_000_000;
const ELEM_OFFSET = 1_000_000;

/**
 * Builds a sub-model where each original element is replaced by nDiv sub-elements.
 *
 * Returns:
 *   subModel  — model-like object for assembler.js (subNodes + subElements + inherited props)
 *   origToSub — Map<origElemId, [subElemId, …]>  (nDiv entries per original element)
 *   subToOrig — Map<subElemId,  {origId, idx}>    (0-based index within subdivision)
 */
export function buildSubModel(model, nDiv = 10) {
  let nextNode = NODE_OFFSET;
  let nextElem = ELEM_OFFSET;

  // Copy all original nodes (same IDs, deep-copy restraints)
  const subNodes = new Map();
  for (const [id, n] of model.nodes) {
    subNodes.set(id, {
      ...n,
      restraints: { ...n.restraints },
      nodeMass:   { ...(n.nodeMass || { mx: 0, my: 0, mz: 0 }) }
    });
  }

  const subElements = new Map();
  const origToSub   = new Map();
  const subToOrig   = new Map();

  for (const [origId, elem] of model.elements) {
    const n1 = model.nodes.get(elem.n1);
    const n2 = model.nodes.get(elem.n2);
    if (!n1 || !n2) continue;

    // Build node sequence: [n1, int1, int2, …, intN-1, n2]
    const nodeSeq = [elem.n1];
    for (let i = 1; i < nDiv; i++) {
      const t  = i / nDiv;
      const id = nextNode++;
      subNodes.set(id, {
        id,
        x: n1.x + t * (n2.x - n1.x),
        y: n1.y + t * (n2.y - n1.y),
        z: n1.z + t * (n2.z - n1.z),
        restraints: { ux: false, uy: false, uz: false, rx: false, ry: false, rz: false },
        nodeMass:   { mx: 0, my: 0, mz: 0 }
      });
    }
    nodeSeq.push(elem.n2);

    // Create nDiv sub-elements
    const subIds = [];
    for (let i = 0; i < nDiv; i++) {
      const id       = nextElem++;
      const releases = Array(12).fill(0);

      // Propagate releases only at the original element's outer boundary nodes
      if (i === 0)        for (let k = 0; k < 6; k++) releases[k]     = elem.releases[k];
      if (i === nDiv - 1) for (let k = 0; k < 6; k++) releases[6 + k] = elem.releases[6 + k];

      subElements.set(id, {
        id,
        n1:     nodeSeq[i],
        n2:     nodeSeq[i + 1],
        matId:  elem.matId,
        secId:  elem.secId,
        releases
      });
      subIds.push(id);
      subToOrig.set(id, { origId, idx: i });
    }
    origToSub.set(origId, subIds);
  }

  // Distribute load cases — dist loads are copied to every sub-element of an original element
  const subLoadCases = new Map();
  for (const [lcId, lc] of model.loadCases) {
    const loads = [];
    for (const load of lc.loads) {
      if (load.type === 'nodal') {
        loads.push(load);   // nodal loads stay on their original node (still present in subNodes)
      } else if (load.type === 'dist') {
        const subs = origToSub.get(load.elemId);
        if (subs) for (const subId of subs) loads.push({ ...load, elemId: subId });
      }
    }
    subLoadCases.set(lcId, { ...lc, loads });
  }

  const subModel = {
    nodes:        subNodes,
    elements:     subElements,
    materials:    model.materials,
    sections:     model.sections,
    loadCases:    subLoadCases,
    diaphragms:   model.diaphragms,
    combinations: model.combinations,
    units:        model.units,
  };

  return { subModel, origToSub, subToOrig };
}
