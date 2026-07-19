// ──────────────────────────────────────────────────────────────────────────────
// SpectrumResults — wraps CQC/SRSS combined displacements and element forces.
// Exposes the same API as static Results so the viewport can reuse
// showDeformed / showForceDiagram without modification.
// ──────────────────────────────────────────────────────────────────────────────
import { getNodeDOFs } from './assembler.js?v=5';

export class SpectrumResults {
  /**
   * @param {Model}      model
   * @param {Map}        nodeIndex   nodeId → 0-based sequential index
   * @param {Float64Array} U         combined nodal displacement envelope (nDOF)
   * @param {Map}        elemForces  elemId → {N,Vy1,Vz1,T,My1,Mz1,Vy2,Vz2,My2,Mz2,ex,ey,ez,L}
   * @param {Object}     meta        {direction, method, nModes, zeta}
   */
  constructor(model, nodeIndex, U, elemForces, meta) {
    this.model      = model;
    this.nodeIndex  = nodeIndex;
    this.U          = U;
    this._ef        = elemForces;
    this.meta       = meta;
  }

  // ── Same API as static Results ─────────────────────────────────────────────

  /** [ux, uy, uz, rx, ry, rz] combined envelope (all positive, as envelope) */
  getNodeDisp(nodeId) {
    const d = getNodeDOFs(this.nodeIndex, nodeId);
    return d.map(i => this.U[i]);
  }

  /** Deformed coordinates using combined displacements */
  getDeformedCoords(nodeId, scale = 1) {
    const node = this.model.nodes.get(nodeId);
    const d    = this.getNodeDisp(nodeId);
    return {
      x: node.x + scale * d[0],
      y: node.y + scale * d[1],
      z: node.z + scale * d[2]
    };
  }

  /** Max translational displacement for auto-scale */
  getMaxDisp() {
    let mx = 0;
    for (const id of this.model.nodes.keys()) {
      const d = this.getNodeDisp(id);
      const m = Math.sqrt(d[0]**2 + d[1]**2 + d[2]**2);
      if (m > mx) mx = m;
    }
    return mx;
  }

  /** {N, Vy1, Vz1, T, My1, Mz1, Vy2, Vz2, My2, Mz2, ex, ey, ez, L} */
  getElemForces(elemId) { return this._ef.get(elemId); }

  /**
   * [{pos:{x,y,z}, val}] along element — linear between end values (spectral envelope).
   * For N: constant. For shear: constant within span. For moment: linear.
   */
  getDiagramData(elemId, type, nPts = 10) {
    const f = this._ef.get(elemId);
    if (!f) return [];
    const elem = this.model.elements.get(elemId);
    const n1   = this.model.nodes.get(elem.n1);
    const n2   = this.model.nodes.get(elem.n2);

    // Since forces are absolute envelopes, we use magnitude at both ends
    const val1 = type === 'N'  ? f.N
               : type === 'Vy' ? f.Vy1
               : type === 'Vz' ? f.Vz1
               : type === 'T'  ? f.T
               : type === 'My' ? f.My1
               : /* Mz */        f.Mz1;

    const val2 = type === 'N'  ? f.N
               : type === 'Vy' ? f.Vy2
               : type === 'Vz' ? f.Vz2
               : type === 'T'  ? f.T
               : type === 'My' ? f.My2
               : /* Mz */        f.Mz2;

    const pts = [];
    for (let i = 0; i <= nPts; i++) {
      const xi = i / nPts;
      pts.push({
        pos: {
          x: n1.x + xi*(n2.x-n1.x),
          y: n1.y + xi*(n2.y-n1.y),
          z: n1.z + xi*(n2.z-n1.z)
        },
        val: val1*(1-xi) + val2*xi
      });
    }
    return pts;
  }

  /**
   * Estado en una fracción xi∈[0,1] del elemento — misma API que Results
   * estático, para que el viewport reutilice la deformada y el inspector.
   * Los resultados espectrales son ENVOLVENTES (valores absolutos combinados):
   * fuerzas y desplazamientos se interpolan linealmente entre extremos.
   * @returns {{N,Vy,Vz,T,My,Mz,ux,uy,uz}|null}
   */
  getElemAtXi(elemId, xi) {
    const f = this._ef.get(elemId);
    if (!f) return null;
    const elem = this.model.elements.get(elemId);
    const d1 = this.getNodeDisp(elem.n1);
    const d2 = this.getNodeDisp(elem.n2);
    const lerp = (a, b) => a * (1 - xi) + b * xi;
    return {
      N:  f.N,
      Vy: lerp(f.Vy1, f.Vy2),
      Vz: lerp(f.Vz1, f.Vz2),
      T:  f.T ?? f.T_ ?? 0,
      My: lerp(f.My1, f.My2),
      Mz: lerp(f.Mz1, f.Mz2),
      ux: lerp(d1[0], d2[0]),
      uy: lerp(d1[1], d2[1]),
      uz: lerp(d1[2], d2[2]),
    };
  }

  /** Summary for toast notification */
  getSummary() {
    let maxU = 0, maxUNode = null;
    let maxN = 0, maxV = 0, maxM = 0;
    let maxNElem = null;

    for (const id of this.model.nodes.keys()) {
      const d = this.getNodeDisp(id);
      const m = Math.sqrt(d[0]**2+d[1]**2+d[2]**2);
      if (m > maxU) { maxU = m; maxUNode = id; }
    }
    for (const [id, f] of this._ef) {
      if (!f) continue;
      if (f.Nabs > maxN) { maxN = f.Nabs; maxNElem = id; }
      if (f.Vmax > maxV)  maxV = f.Vmax;
      if (f.Mmax > maxM)  maxM = f.Mmax;
    }
    return { maxU, maxUNode, maxN, maxNElem, maxV, maxM };
  }

  getReaction() { return [0,0,0,0,0,0]; }  // not applicable for spectrum

  // `t` is an optional translator (UI passes i18n.t); defaults to identity so the
  // solver module stays neutral (no i18n dependency).
  toCSV(t = (s) => s) {
    const { direction, method, nModes, zeta } = this.meta;
    const lines = [
      '# PORTICO — ' + t('Resultados Espectro de Respuesta'),
      `# ${t('Dirección:')} ${direction}  ${t('Método:')} ${method}  ${t('Modos:')} ${nModes}  ζ: ${zeta}`,
      '#',
      '# ' + t('DESPLAZAMIENTOS COMBINADOS (envolvente)'),
      '# NodeID, Ux, Uy, Uz, Rx, Ry, Rz'
    ];
    for (const id of this.model.nodes.keys()) {
      const d = this.getNodeDisp(id);
      lines.push(`${id}, ${d.map(v=>v.toExponential(6)).join(', ')}`);
    }
    lines.push('#');
    lines.push('# ' + t('FUERZAS INTERNAS COMBINADAS (envolvente)'));
    lines.push('# ElemID, N, Vy1, Vz1, T, My1, Mz1, Vy2, Vz2, My2, Mz2');
    for (const [id, f] of this._ef) {
      if (!f) continue;
      lines.push([id, f.N, f.Vy1, f.Vz1, f.T||f.T_, f.My1, f.Mz1,
                      f.Vy2, f.Vz2, f.My2, f.Mz2]
        .map((v, i) => i===0 ? v : (+v).toExponential(6)).join(', '));
    }
    return lines.join('\r\n');
  }
}
