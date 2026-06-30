// ──────────────────────────────────────────────────────────────────────────────
// ModalResults — stores mode shapes and computes mass participation factors
// ──────────────────────────────────────────────────────────────────────────────

export class ModalResults {
  /**
   * @param {Model}         model
   * @param {Map}           nodeIndex     nodeId → 0-based sequential index
   * @param {number[]}      freeDOF       global indices of unconstrained DOFs
   * @param {{omega2,vec}[]} modes        sorted structural modes (ascending ω²)
   * @param {Float64Array}  M             global mass matrix (nDOF², row-major flat)
   * @param {number}        nDOF
   */
  constructor(model, nodeIndex, freeDOF, modes, M, nDOF) {
    this.model     = model;
    this.nodeIndex = nodeIndex;
    this.nDOF      = nDOF;
    this.nModes    = modes.length;

    this.omega2 = modes.map(m => m.omega2);
    this.omega  = modes.map(m => Math.sqrt(m.omega2));
    this.freq   = modes.map(m => Math.sqrt(m.omega2) / (2 * Math.PI));
    this.period = modes.map(m => (2 * Math.PI) / Math.sqrt(m.omega2));

    // ── Build full mode shape vectors (length nDOF) ───────────────────────────
    this.modeShapes = modes.map(m => {
      const phi = new Float64Array(nDOF);
      freeDOF.forEach((gi, i) => { phi[gi] = m.vec[i]; });
      return phi;
    });

    // Normalize so that max translational displacement amplitude = 1
    this.modeShapes.forEach(phi => {
      let maxTr = 0;
      for (const [id] of model.nodes) {
        const b  = nodeIndex.get(id) * 6;
        const tr = Math.hypot(phi[b], phi[b+1], phi[b+2]);
        if (tr > maxTr) maxTr = tr;
      }
      if (maxTr < 1e-30) {
        for (const v of phi) if (Math.abs(v) > maxTr) maxTr = Math.abs(v);
      }
      if (maxTr > 0) {
        for (let i = 0; i < phi.length; i++) phi[i] /= maxTr;
      }
    });

    // Generalized modal mass: phi_i^T · M · phi_i  (needed for spectral analysis AND participation)
    this.genMass = this.modeShapes.map(phi => {
      let gm = 0;
      for (let i = 0; i < nDOF; i++) {
        let row = 0;
        for (let j = 0; j < nDOF; j++) row += M[i*nDOF+j] * phi[j];
        gm += phi[i] * row;
      }
      return gm;
    });

    this._participation = this._computeParticipation(M, nDOF);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Returns Map<nodeId, [ux, uy, uz, rx, ry, rz]> for mode `modeIndex` (0-based).
   * Values are normalized so that max translational displacement = 1.
   */
  getModeShape(modeIndex) {
    const phi   = this.modeShapes[modeIndex];
    const shape = new Map();
    for (const [id] of this.model.nodes) {
      const b = this.nodeIndex.get(id) * 6;
      shape.set(id, [phi[b], phi[b+1], phi[b+2], phi[b+3], phi[b+4], phi[b+5]]);
    }
    return shape;
  }

  getParticipation() { return this._participation; }

  /**
   * Exports frequencies + participation factors to CSV string.
   */
  // `t` is an optional translator (UI passes i18n.t); defaults to identity so the
  // solver module stays neutral (no i18n dependency).
  toCSV(t = (s) => s) {
    const { rows } = this._participation;
    let csv = `${t('Modo')},${t('Freq.(Hz)')},${t('Periodo(s)')},Γ_X,Γ_Y,Γ_Rz,` +
              'meff_X(%),meff_Y(%),meff_Rz(%),Acum_X(%),Acum_Y(%),Acum_Rz(%)\n';
    for (const r of rows) {
      csv += [
        r.mode,
        r.freq.toFixed(4),   r.period.toFixed(4),
        r.gamma[0].toFixed(4), r.gamma[1].toFixed(4), r.gamma[2].toFixed(4),
        r.pct[0].toFixed(2), r.pct[1].toFixed(2), r.pct[2].toFixed(2),
        r.cumPct[0].toFixed(2), r.cumPct[1].toFixed(2), r.cumPct[2].toFixed(2)
      ].join(',') + '\n';
    }
    return csv;
  }

  // ── Mass participation ─────────────────────────────────────────────────────
  _computeParticipation(M, nDOF) {
    // ── Build influence vectors r_d for X, Y, Rz ──────────────────────────
    // X and Y: unit at all free UX / UY DOFs respectively.
    // Rz (torsion): the diaphragm mass is at TRANSLATIONAL DOFs (UX, UY),
    // NOT at RZ DOFs. A unit floor rotation about CR produces:
    //   ΔUX_i = −(yi − y_CR),   ΔUY_i = +(xi − x_CR)
    // at each floor node i. Using this rigid-body influence vector gives the
    // correct Γ_Rz = Σ mᵢ·rᵢ² instead of ≈0 from the unit-at-RZ approach.
    //
    // For nodes NOT on a diaphragm, keep the standard unit at RZ DOF
    // (element rotational mass is small but should not be discarded).

    const iota = [
      new Float64Array(nDOF),   // X
      new Float64Array(nDOF),   // Y
      new Float64Array(nDOF),   // Rz
    ];

    // Standard: unit at UX / UY / RZ for all model nodes
    for (const id of this.model.nodes.keys()) {
      const b = this.nodeIndex.get(id) * 6;
      iota[0][b]   = 1;   // UX
      iota[1][b+1] = 1;   // UY
      iota[2][b+5] = 1;   // RZ (element rotational inertia contribution)
    }

    // Override Rz for diaphragm floor nodes: rigid-body translational influence
    // ι_Rz[UX_i] = −(yi − y_CR),  ι_Rz[UY_i] = +(xi − x_CR)
    const diaphragmNodes = new Set();
    for (const d of this.model.diaphragms.values()) {
      const ref = d.cr ?? d.cm;              // CR preferred; fall back to CM
      if (!ref) continue;
      for (const nodeId of d.nodes) {
        const node = this.model.nodes.get(nodeId);
        if (!node) continue;
        const b = this.nodeIndex.get(nodeId) * 6;
        if (b == null) continue;
        iota[2][b]   = -(node.y - ref.y);   // UX contribution
        iota[2][b+1] =  (node.x - ref.x);   // UY contribution
        iota[2][b+5] = 0;                    // zero out the standard RZ entry
                                              // (element rotational mass here is
                                              //  negligible vs. translational term)
        diaphragmNodes.add(nodeId);
      }
    }

    const dirs = ['X', 'Y', 'Rz'];

    // Total activatable mass: r_dᵀ · M · r_d  (scalar per direction)
    const totalMass = iota.map(r => {
      let tot = 0;
      for (let i = 0; i < nDOF; i++) {
        if (r[i] === 0) continue;
        for (let j = 0; j < nDOF; j++) tot += r[i] * M[i*nDOF+j] * r[j];
      }
      return tot;
    });

    // Precompute M·r_d for each direction (vector length nDOF)
    const Mrd = iota.map(r => {
      const mr = new Float64Array(nDOF);
      for (let i = 0; i < nDOF; i++) {
        for (let j = 0; j < nDOF; j++) mr[i] += M[i*nDOF+j] * r[j];
      }
      return mr;
    });

    // For each mode: Γ_d = φᵀ·M·r_d,  m_eff = Γ²/M̄,  pct = m_eff/totalMass
    const rows = this.modeShapes.map((phi, mi) => {
      const genM = this.genMass[mi];
      const row = {
        mode:   mi + 1,
        freq:   this.freq[mi],
        period: this.period[mi],
        gamma:  [],
        meff:   [],
        pct:    [],
        cumPct: []
      };
      Mrd.forEach((mr, di) => {
        let Gamma = 0;
        for (let i = 0; i < nDOF; i++) Gamma += phi[i] * mr[i];
        const meff = genM > 1e-30 ? (Gamma * Gamma) / genM : 0;
        const pct  = totalMass[di] > 1e-30 ? meff / totalMass[di] * 100 : 0;
        row.gamma.push(Gamma);
        row.meff.push(meff);
        row.pct.push(pct);
      });
      return row;
    });

    const cum = [0, 0, 0];
    for (const row of rows) {
      row.cumPct = row.pct.map((p, di) => { cum[di] += p; return cum[di]; });
    }

    return { rows, dirs, totalMass };
  }
}
