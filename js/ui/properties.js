// ──────────────────────────────────────────────────────────────────────────────
// PropertiesPanel — right-side panel: node/element properties + mat/sec tabs
// ──────────────────────────────────────────────────────────────────────────────
import { computeFloorCR, computeFloorCM, computeTributaryWeights } from '../solver/diaphragm.js?v=7';
import { localAxes } from '../solver/timoshenko.js?v=7';
import { esc } from '../utils/escape.js?v=7';
import { i18n } from '../i18n/i18n.js?v=7';

export class PropertiesPanel {
  constructor(panelEl, app) {
    this.panel = panelEl;
    this.app   = app;

    // ── Vertical super-tabs (Modelo / Resultados) ──────────────────────────
    this._vtabBtns = [...panelEl.querySelectorAll('.vtab')];
    this._vpanels  = {
      model:     document.getElementById('vpanel-model'),
      results:   document.getElementById('vpanel-results'),
      design:    document.getElementById('vpanel-design'),
      assistant: document.getElementById('vpanel-assistant'),
      temp:      document.getElementById('vpanel-temp'),
    };
    this._currentVTab = 'model';

    // ── Horizontal sub-tabs (inside Model) ─────────────────────────────────
    this._tabBtns    = [...panelEl.querySelectorAll('#panel-tabs .ptab')];
    this._tabContents = {
      sel:   document.getElementById('ptab-sel'),
      nodos: document.getElementById('ptab-nodos'),
      elems: document.getElementById('ptab-elems'),
      mat:   document.getElementById('ptab-mat'),
      sec:   document.getElementById('ptab-sec'),
      dia:   document.getElementById('ptab-dia'),
      cargas: document.getElementById('ptab-cargas'),
    };
    this._currentTab = 'sel';

    // ── Result sub-tabs (inside Results) ───────────────────────────────────
    this._rtabBtns    = [...panelEl.querySelectorAll('.rtab')];
    this._rtabContents = {
      modal:    document.getElementById('rtab-modal'),
      estatico: document.getElementById('rtab-estatico'),
      plastico: document.getElementById('rtab-plastico'),
      th:       document.getElementById('rtab-th'),
      dc:       document.getElementById('rtab-dc'),
      buck:     document.getElementById('rtab-buck'),
      nl:       document.getElementById('rtab-nl'),
      ml:       document.getElementById('rtab-ml'),
      nlth:     document.getElementById('rtab-nlth'),
    };
    this._currentRTab = 'modal';

    this._init();
  }

  _init() {
    this._vtabBtns.forEach(btn =>
      btn.addEventListener('click', () => {
        // El panel arranca colapsado (sólo el riel de pestañas). Clic en una pestaña
        // lo despliega; clic en la pestaña YA activa mientras está desplegado lo colapsa.
        const collapsed = document.getElementById('main')?.classList.contains('panel-collapsed');
        if (!collapsed && this._currentVTab === btn.dataset.vtab) { this.app.setPanelCollapsed(true); return; }
        this.app.setPanelCollapsed(false);
        this._switchVTab(btn.dataset.vtab);
      })
    );
    this._tabBtns.forEach(btn =>
      btn.addEventListener('click', () => this._switchTab(btn.dataset.tab))
    );
    this._rtabBtns.forEach(btn =>
      btn.addEventListener('click', () => this._switchRTab(btn.dataset.rtab))
    );

    document.getElementById('btn-add-mat')?.addEventListener('click',    () => this._addMaterial());
    document.getElementById('btn-add-sec')?.addEventListener('click',    () => this._addSection());
    document.getElementById('btn-section-calc')?.addEventListener('click', () => this._sectionCalculatorDialog());
    document.getElementById('btn-add-dia')?.addEventListener('click',    () => this.app.addDiaphragmManual());
    document.getElementById('btn-detect-dia')?.addEventListener('click', () => this.app.autoDetectDiaphragms());
    document.getElementById('btn-add-combo')?.addEventListener('click',  () => this._addCombination());
    document.getElementById('btn-add-lc-panel')?.addEventListener('click', () => this.app.newCaseDialog());
    document.getElementById('btn-combos-norma')?.addEventListener('click', () => this.app.createCodeCasesAndCombos());
    document.getElementById('btn-add-node-row')?.addEventListener('click', () => this._addNodeRow());
    document.getElementById('btn-verificar-diseno')?.addEventListener('click', () => this.renderDesign());
    document.getElementById('btn-asis-side-gen')?.addEventListener('click', () => {
      const txt = document.getElementById('asis-nl-side')?.value.trim();
      if (!txt) { this.app.toast('Escribe una descripción del modelo', 'warn'); return; }
      this.app.assistantFromText(txt);
    });
    // Keyboard-runnable example: Tab fills the example, Enter generates it immediately.
    this.app._wireAsisExample('asis-nl-side', (t) => this.app.assistantFromText(t));
    document.getElementById('btn-asis-side-ficha')?.addEventListener('click', () => this.app.assistantDialog());
    document.getElementById('btn-asis-side-mod')?.addEventListener('click', () => {
      const txt = document.getElementById('asis-mod-nl')?.value.trim();
      if (!txt) { this.app.toast('Escribe qué cambio hacer', 'warn'); return; }
      this.app.modifyModelFromText(txt);
    });
    document.getElementById('btn-temp-clear')?.addEventListener('click', () => this.app.clearAllTemporales());
  }

  _switchVTab(vtab) {
    this._currentVTab = vtab;
    this._vtabBtns.forEach(b => b.classList.toggle('active', b.dataset.vtab === vtab));
    Object.entries(this._vpanels).forEach(([k, el]) =>
      el?.classList.toggle('active', k === vtab)
    );
    if (vtab === 'results') this._switchRTab(this._currentRTab);
    if (vtab === 'design') this.renderDesign();
    if (vtab === 'temp') this.app.renderTemporales?.();
  }

  // Design check (bending/shear/axial) in the side panel.
  async renderDesign() {
    const body = document.getElementById('design-body');
    if (!body) return;
    if (!this.app._results || typeof this.app._computeDesign !== 'function') {
      body.innerHTML = '<p class="panel-hint">Ejecute el análisis estático (F5). Para verificar la combinación última, selecciónela como resultado mostrado y vuelva a verificar.</p>';
      return;
    }
    body.innerHTML = '<p class="panel-hint">Calculando…</p>';
    const codeSelHTML = await this._designCodeSelectorHTML();
    const dis = await this.app._computeDesign();
    if (!dis || !dis.filas || !dis.filas.length) {
      body.innerHTML = '<p class="panel-hint">No hay resultados para verificar.</p>';
      return;
    }
    const f = dis.filas;
    const malo = x => x.ratioMax > 1;
    const aj   = x => !malo(x) && x.ratioMax > 0.9;
    const nNo = f.filter(malo).length;
    const nAj = f.filter(aj).length;
    const nOk = f.length - nNo - nAj;
    const cls = r => r > 1 ? 'dc-bad' : r > 0.9 ? 'dc-warn' : 'dc-ok';
    const fmt = v => (v == null || !isFinite(v)) ? '—' : (+v).toFixed(2);
    // element δmax = maximum |displacement| of its end nodes (m → mm)
    const dispOf = (id) => {
      try {
        const el = this.app.model.elements.get(id); if (!el) return null;
        const r = this.app._results; if (!r) return null;
        let mx = 0;
        for (const nid of [el.n1, el.n2]) { const d = r.getNodeDisp(nid); mx = Math.max(mx, Math.hypot(d[0], d[1], d[2])); }
        return mx;
      } catch { return null; }
    };
    const fmtmm = v => (v == null || !isFinite(v)) ? '—' : (v * 1000).toFixed(2);
    const rows = f.map(x => `<tr class="dis-row" data-elem="${x.id}" title="${esc(x.combo||'')} — flexión ${fmt(x.bending.ratio)} · corte ${fmt(x.shear.ratio)} · axial ${fmt(x.axial.ratio)} · interacción ${fmt(x.interaction?.ratio)}">
      <td>#${x.id}</td><td>${esc(x.sec)}</td><td>${x.governs}</td>
      <td class="${cls(x.ratioMax)}"><b>${fmt(x.ratioMax)}</b></td>
      <td style="text-align:right;font-family:var(--font-mono);font-size:10px">${fmtmm(dispOf(x.id))}</td>
      <td class="${malo(x) ? 'dc-bad' : aj(x) ? 'dc-warn' : 'dc-ok'}">${malo(x) ? '✗' : aj(x) ? '!' : '✓'}</td></tr>`).join('');
    body.innerHTML = `
      ${codeSelHTML}
      <div class="dis-actions" style="display:flex;gap:6px;margin:4px 0 8px">
        <button id="btn-predim" class="btn-secondary" style="flex:1;font-size:11px" title="Predimensionar (antes del análisis): propone una sección inicial por reglas simples.">⚡ Predimensionar</button>
        <button id="btn-autodiseno" class="btn-secondary" style="flex:1;font-size:11px" title="Diseñar (después del análisis): elige del catálogo el perfil de acero más liviano que cumple D/C≤1.">🧮 Diseñar (auto)</button>
      </div>
      <div class="dis-actions" style="display:flex;gap:6px;margin:0 0 8px">
        <button id="btn-scwb" class="btn-secondary" style="flex:1;font-size:11px" title="Nudos columna fuerte–viga débil (ACI 18.7.3 / AISC 341): resalta en el modelo los nudos donde ΣMnc < γ·ΣMnb (no cumplen).">🏛️ Nudos SCWB</button>
        <button id="btn-design-report" class="btn-secondary" style="flex:1;font-size:11px" title="Exporta un reporte de diseño (CSV): por elemento, sección, esfuerzos, D/C por chequeo (flexión/corte/axial/interacción) y el que gobierna.">📄 Reporte (CSV)</button>
      </div>
      <div class="dis-summary">Estados: <b>${esc(dis.caso || 'activo')}</b><br>
        <span class="dc-ok">${nOk} ${i18n.t('cumplen')}</span> · <span class="dc-warn">${nAj} ${i18n.t('ajustados')}</span> · <span class="dc-bad">${nNo} ${i18n.t('no cumplen')}</span></div>
      <div style="max-height:58vh;overflow:auto;border:1px solid var(--border,#334);border-radius:5px">
        <table class="dis-table"><thead><tr><th>Elem</th><th>Sec.</th><th>Gob.</th><th>D/C</th><th>|δ| mm</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      </div>
      <p class="panel-hint" style="margin-top:6px">D/C = resistencia (flexión/corte/axial/interacción) ≤ 1. <b>|δ|</b> = desplazamiento máx. de los nodos del elemento en el caso/combo mostrado. Las flechas de servicio y derivas se documentan en <b>Análisis → Memoria</b>.</p>`;
    body.querySelectorAll('.dis-row').forEach(tr => tr.addEventListener('click', () => {
      const id = +tr.dataset.elem;
      if (this.app.viewport.selectElements) this.app.viewport.selectElements([id]);
    }));
    body.querySelector('#btn-predim')?.addEventListener('click', () => this.app.predimensionarDialog());
    body.querySelector('#btn-autodiseno')?.addEventListener('click', () => this.app.autoDesignDialog(dis));
    body.querySelector('#btn-scwb')?.addEventListener('click', () => this.app.runSCWB());
    body.querySelector('#btn-design-report')?.addEventListener('click', () => this.app.exportDesignReportCSV(dis));
    this._bindDesignCodeSelector(body);
  }

  // Design CODE selector per family present in the model (steel/concrete/timber).
  // Changing it sets model.designSettings.codeByFamily and re-checks.
  async _designCodeSelectorHTML() {
    try {
      const mod = this._designMod || (this._designMod = await import('../design/design.js?v=7'));
      const fams = new Set();
      for (const m of this.app.model.materials.values()) {
        const fam = (m.design?.family) || mod.clasificarMaterial(m.name);
        if (['steel', 'concrete', 'timber', 'aluminum'].includes(fam)) fams.add(fam === 'aluminum' ? 'steel' : fam);
      }
      if (!fams.size) return '';
      const lab = { steel: 'Acero', concrete: 'Hormigón', timber: 'Madera' };
      const sett = this.app.model.designSettings?.codeByFamily || {};
      const rows = [...fams].map(fam => {
        const codes = mod.listDesignCodes(fam);
        if (!codes.length) return '';
        const cur = sett[fam] || '';
        const opts = `<option value="">(por defecto)</option>` + codes.map(c => `<option value="${c.id}" ${cur === c.id ? 'selected' : ''}>${c.label}</option>`).join('');
        return `<div class="prop-field" style="margin-bottom:4px"><label style="font-size:11px">${i18n.t('Código ' + lab[fam])}</label><select class="dz-code" data-fam="${fam}">${opts}</select></div>`;
      }).join('');
      return `<div class="prop-section" style="margin-bottom:6px"><div class="prop-title" title="Norma de diseño por familia (como SAP2000). Ver docs/design.md.">Código de diseño</div>${rows}</div>`;
    } catch { return ''; }
  }

  _bindDesignCodeSelector(body) {
    body.querySelectorAll('.dz-code').forEach(sel => sel.addEventListener('change', () => {
      const fam = sel.dataset.fam, id = sel.value;
      const ds = this.app.model.designSettings || { codeByFamily: {} };
      ds.codeByFamily = ds.codeByFamily || {};
      if (id) ds.codeByFamily[fam] = id; else delete ds.codeByFamily[fam];
      this.app.model.designSettings = ds;
      this.app.markDirty();
      this.renderDesign();
    }));
  }

  _switchTab(tab) {
    this._currentTab = tab;
    this._tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    Object.entries(this._tabContents).forEach(([k, el]) =>
      el?.classList.toggle('active', k === tab)
    );
    if (tab === 'mat')   this.renderMaterials();
    if (tab === 'sec')   this.renderSections();
    if (tab === 'dia')   this.renderDiaphragms();
    if (tab === 'nodos') this.renderNodesGrid();
    if (tab === 'elems') this.renderElemsGrid();
    if (tab === 'cargas') { this.renderLoadCases(); this.renderCombinations(); }
  }

  _switchRTab(rtab) {
    this._currentRTab = rtab;
    this._rtabBtns.forEach(b => b.classList.toggle('active', b.dataset.rtab === rtab));
    Object.entries(this._rtabContents).forEach(([k, el]) =>
      el?.classList.toggle('active', k === rtab)
    );
    if (rtab === 'modal')    this.renderModalResults();
    if (rtab === 'estatico') this.renderStaticResults();
    if (rtab === 'plastico') this.renderPlasticResults();
    if (rtab === 'th')       this.app._thRenderPanel?.();
    if (rtab === 'dc')       this.app._dcRenderPanel?.();
    if (rtab === 'buck')     this.app._buckRenderPanel?.();
    if (rtab === 'nl')       this.app._nlRenderPanel?.();
    if (rtab === 'ml')       this.app._movingRenderPanel?.();
    if (rtab === 'nlth')     this.app._nlthRenderPanel?.();
  }

  // ── Plastic hinges (event-by-event plastic pushover) ───────────────────────
  // Reads app._plasticResult and paints the hinge sequence + collapse factor.
  // Lives in the Results tab → respects the theme (light/dark) by using the panel's
  // classes/variables, unlike the old floating window.
  renderPlasticResults() {
    const body = document.getElementById('res-plastic-body');
    const hint = document.getElementById('res-plastic-hint');
    const pr = this.app._plasticResult;
    if (!body) return;
    if (!pr) { if (hint) hint.style.display = ''; body.innerHTML = ''; return; }
    if (hint) hint.style.display = 'none';

    const { events, lambda, collapsed, Mp } = pr;
    const mut = 'color:var(--text-muted)';
    // capacity of the COMPONENT (N/Vy/Vz/My/Mz) of each event
    const cap = (e) => { const c = pr.capByElem && pr.capByElem.get(e.elemId); const v = c ? c[e.axis] : Mp; return isFinite(v) ? v : Mp; };
    const rows = events.map((e, i) =>
      `<tr><td>${i + 1}${e.cascade ? '↯' : ''}</td><td>#${e.elemId}</td><td>${e.nodeId}</td><td>${e.axis}</td>` +
      `<td>${e.lambda.toFixed(3)}</td><td>${cap(e).toFixed(0)}</td><td>${e.dctrl.toExponential(1)}</td></tr>`).join('');
    // constitutive curve of the hinge model used (N / V / M)
    const mode = pr.hingeMode || 'perfecto', caida = mode !== 'perfecto';
    const lab = mode === 'fragil' ? `frágil (caída inmediata a ${((pr.residual ?? 0) * 100).toFixed(2)}%)`
      : mode === 'ductil_caida' ? `dúctil con caída (meseta hasta θu=${pr.thetaU}/δu=${pr.deltaU}, luego ${((pr.residual ?? 0) * 100).toFixed(2)}%)`
      : 'dúctil — perfectamente plástica (meseta ∞)';
    const caps = `Mp=${pr.Mp}` + (isFinite(pr.Np) && pr.Np ? ` · Np=${pr.Np}` : '') + (isFinite(pr.Vp) && pr.Vp ? ` · Vp=${pr.Vp}` : '');
    const curve = this.app._hingeBackboneSVG ? this.app._hingeBackboneSVG(mode, (pr.residual ?? 1) * 100, 220, 130) : '';
    const modeBox = `<div style="padding:6px 10px;border-radius:6px;background:var(--bg4);margin-top:8px">
        <b>Rótula:</b> ${lab}<br><span style="${mut};font-size:10px">capacidades: ${caps}</span>
        <div style="text-align:center;margin-top:6px">${curve}</div>
        <div style="${mut};font-size:10px;text-align:center">Curva constitutiva (N/V/M)${caida ? ' · ↯ = rótula en cascada por la caída' : ''}</div>
      </div>`;

    const box = 'padding:8px 10px;border-radius:6px;background:var(--bg4);margin-bottom:4px';
    const estado = collapsed
      ? `<div style="${box};border-left:3px solid var(--success,#34d399)"><b>Colapso · λc = ${lambda.toFixed(3)}</b><br>
           <span style="${mut}">Carga de colapso = ${lambda.toFixed(3)} × carga de referencia.</span></div>`
      : `<div style="${box};border-left:3px solid var(--warn,#fbbf24)"><b>Sin mecanismo</b><br>
           <span style="${mut}">${events.length} ${i18n.t('rótulas; la carga no completa un mecanismo')} (λ = ${lambda.toFixed(3)}).</span></div>`;

    body.innerHTML = `
      ${estado}
      ${modeBox}
      <table class="res-table" style="width:100%;border-collapse:collapse;font-size:11px;margin-top:8px">
        <thead><tr style="${mut}">
          <th>#</th><th>Elem</th><th>Nodo</th><th>Eje</th><th>λ</th><th>Mp</th><th>δctrl</th>
        </tr></thead><tbody>${rows}</tbody></table>
      <p class="panel-hint" style="margin-top:8px">Secuencia de formación de rótulas (λ = factor de carga). Mp = capacidad de cada rótula [kN·m]. δctrl = desplazamiento máximo.</p>`;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  showDiaphragm(dId, showCM = false) {
    this._switchVTab('model');
    this._switchTab('dia');
    setTimeout(() => {
      const card = document.querySelector(`#dia-list .mat-card[data-id="${dId}"]`);
      if (card && !card.classList.contains('open')) card.classList.add('open');
      card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
    // Show CM displacements in sel tab if results exist
    if (showCM || this.app._results) {
      const d = this.app.model.diaphragms.get(dId);
      const res = this.app._results;
      if (d && res) {
        const masterId = d.masterId || d.nodes[0];
        const masterNode = this.app.model.nodes.get(masterId);
        if (masterNode) {
          this._switchVTab('model');
          this._switchTab('sel');
          const disp = res.getNodeDisp(masterId);
          const fv = v => `<span style="font-family:var(--font-mono);color:${Math.abs(v)<1e-10?'var(--text-muted)':v>0?'#ef5350':'#42a5f5'}">${Math.abs(v)<1e-10?'—':v.toExponential(4)}</span>`;
          this._tabContents.sel.innerHTML = `
            <div class="prop-id" style="color:#ff7043">⊕ CM Diafragma #${dId}</div>
            <div class="prop-section" style="border:1px solid #ff7043;border-radius:4px;padding:8px">
              <div class="prop-title" style="color:#ff7043">Desplazamientos Nodo Master #${masterId}</div>
              <table class="results-table">
                <tr><th>DOF</th><th>Valor</th></tr>
                ${['Ux','Uy','Uz','Rx','Ry','Rz'].map((n,i)=>`<tr><td>${n}</td><td>${fv(disp[i])}</td></tr>`).join('')}
              </table>
            </div>`;
        }
      }
    }
  }

  showSelection(items) {
    this.app.setPanelCollapsed(false);   // seleccionar en la vista 3D despliega el panel
    this._switchVTab('model');
    this._switchTab('sel');
    const res  = this.app._results;
    const elems = items.filter(i => i.type === 'elem');
    const nodes = items.filter(i => i.type === 'node');
    const areas = items.filter(i => i.type === 'area');

    // colour helper: sign-based for individual values, amber for aggregates
    const fv = (v, amber = false) => {
      const zero = Math.abs(v) < 1e-10;
      const col  = amber ? '#ffc107'
                 : zero  ? 'var(--text-muted)'
                 : v > 0 ? '#ef5350' : '#42a5f5';
      return `<td style="font-family:var(--font-mono);text-align:right;font-size:10px;color:${col}">${zero && !amber ? '—' : v.toExponential(3)}</td>`;
    };

    let html = `<div class="prop-id" style="color:var(--warn)">${items.length} objetos seleccionados</div>
      <p class="panel-hint" style="margin-bottom:6px">Ctrl+clic: añadir/quitar &nbsp;|&nbsp; Clic vacío: deseleccionar</p>`;

    // ── Elements ────────────────────────────────────────────────────────────
    if (elems.length > 0) {
      if (!res) {
        html += `<p class="panel-hint">${elems.length} elemento(s) — ejecute el análisis para ver fuerzas.</p>`;
      } else {
        const sum = { N:0, Vy:0, Vz:0, T:0, My:0, Mz:0,
                      maxN:0, maxVy:0, maxVz:0, maxMy:0, maxMz:0 };
        let rowsHtml = '';
        for (const { id } of elems) {
          const f = res.getElemForces(id);
          if (!f) continue;
          const Vy = Math.abs(f.Vy1) > Math.abs(f.Vy2) ? f.Vy1 : f.Vy2;
          const Vz = Math.abs(f.Vz1) > Math.abs(f.Vz2) ? f.Vz1 : f.Vz2;
          const My = Math.abs(f.My1) > Math.abs(f.My2) ? f.My1 : f.My2;
          const Mz = Math.abs(f.Mz1) > Math.abs(f.Mz2) ? f.Mz1 : f.Mz2;
          const T  = f.T || 0;
          sum.N  += f.N;  sum.maxN  = Math.max(sum.maxN,  Math.abs(f.N));
          sum.Vy += Vy;   sum.maxVy = Math.max(sum.maxVy, Math.abs(Vy));
          sum.Vz += Vz;   sum.maxVz = Math.max(sum.maxVz, Math.abs(Vz));
          sum.My += My;   sum.maxMy = Math.max(sum.maxMy, Math.abs(My));
          sum.Mz += Mz;   sum.maxMz = Math.max(sum.maxMz, Math.abs(Mz));
          sum.T  += T;
          rowsHtml += `<tr>
            <td style="color:var(--text-muted);font-size:10px;font-family:var(--font-mono)">${id}</td>
            ${fv(f.N)}${fv(Vy)}${fv(Vz)}${fv(T)}${fv(My)}${fv(Mz)}
          </tr>`;
        }
        const sepStyle = 'border-top:1px solid var(--warn)';
        rowsHtml += `<tr style="${sepStyle}">
          <td style="font-size:10px;color:var(--warn);font-weight:700">Σ</td>
          ${fv(sum.N,true)}${fv(sum.Vy,true)}${fv(sum.Vz,true)}${fv(sum.T,true)}${fv(sum.My,true)}${fv(sum.Mz,true)}
        </tr>
        <tr>
          <td style="font-size:10px;color:#ffc107">max|·|</td>
          ${fv(sum.maxN,true)}${fv(sum.maxVy,true)}${fv(sum.maxVz,true)}<td>—</td>${fv(sum.maxMy,true)}${fv(sum.maxMz,true)}
        </tr>`;
        html += `<div style="border:1px solid var(--warn);border-radius:4px;padding:8px;margin-bottom:8px;overflow-x:auto">
          <div class="res-section-title" style="color:var(--warn);margin-top:0">${elems.length} Elementos — Fuerzas Internas (valor dominante en extremos)</div>
          <table class="res-table"><thead>
            <tr><th>El.</th><th>N</th><th>Vy</th><th>Vz</th><th>T</th><th>My</th><th>Mz</th></tr>
          </thead><tbody>${rowsHtml}</tbody></table>
        </div>`;
      }
    }

    // ── Nodes ───────────────────────────────────────────────────────────────
    if (nodes.length > 0) {
      if (!res) {
        html += `<p class="panel-hint">${nodes.length} nodo(s) — ejecute el análisis para ver desplazamientos.</p>`;
      } else {
        let rowsHtml = '';
        for (const { id } of nodes) {
          const d   = res.getNodeDisp(id);
          const mag = Math.hypot(d[0], d[1], d[2]);
          rowsHtml += `<tr>
            <td style="color:var(--text-muted);font-size:10px;font-family:var(--font-mono)">${id}</td>
            ${fv(d[0])}${fv(d[1])}${fv(d[2])}${fv(mag, true)}
          </tr>`;
        }
        html += `<div style="border:1px solid var(--node-col);border-radius:4px;padding:8px;overflow-x:auto">
          <div class="res-section-title" style="color:var(--node-col);margin-top:0">${nodes.length} Nodos — Desplazamientos</div>
          <table class="res-table"><thead>
            <tr><th>Nd.</th><th>Ux</th><th>Uy</th><th>Uz</th><th>|δ|</th></tr>
          </thead><tbody>${rowsHtml}</tbody></table>
        </div>`;
      }
    }

    // ── Áreas ─────────────────────────────────────────────────────────────────
    if (areas.length > 0) html += this._areaActionsHTML(areas);

    // ── Acciones masivas ──────────────────────────────────────────────────────
    if (elems.length > 0) html += this._selActionsHTML(elems);
    if (nodes.length > 0) html += this._nodeActionsHTML(nodes);
    html += this._transformHTML(items.length);
    html += this._groupsHTML();

    this._tabContents.sel.innerHTML = html;
    if (elems.length > 0) this._bindSelActions(elems.map(e => e.id));
    if (nodes.length > 0) this._bindNodeActions();
    if (areas.length > 0) this._bindAreaActions();
    this._bindTransform();
    this._bindGroups();
  }

  _areaActionsHTML(areas) {
    const mats = [...this.app.model.materials.values()].map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    return `
      <div class="prop-section" style="border:1px solid var(--area-col,#3b82f6);border-radius:6px;padding:8px;margin-top:8px">
        <div class="prop-title" style="color:var(--area-col,#3b82f6);margin-top:0">Áreas · ${areas.length} seleccionada(s)</div>
        <div class="prop-row" style="gap:6px;align-items:flex-end">
          <div class="prop-field"><label>Comportamiento</label>
            <select id="ar-beh">
              <option value="">—</option>
              <option value="membrane">Membrana</option>
              <option value="plate">Placa</option>
              <option value="shell">Shell</option>
            </select></div>
          <button class="btn-secondary" id="ar-beh-apply" style="flex:0 0 auto;font-size:11px">Aplicar</button>
        </div>
        <div class="prop-row" style="gap:6px;align-items:flex-end;margin-top:6px">
          <div class="prop-field"><label>Espesor t (m)</label><input type="number" id="ar-t" value="0.2" min="0.001" step="0.05"></div>
          <button class="btn-secondary" id="ar-t-apply" style="flex:0 0 auto;font-size:11px">Aplicar</button>
        </div>
        <div class="prop-row" style="gap:6px;align-items:flex-end;margin-top:6px">
          <div class="prop-field"><label>Material</label><select id="ar-mat"><option value="">—</option>${mats}</select></div>
          <button class="btn-secondary" id="ar-mat-apply" style="flex:0 0 auto;font-size:11px">Aplicar</button>
        </div>
        <div class="prop-row" style="gap:6px;align-items:flex-end;margin-top:6px">
          <div class="prop-field"><label>Giro en el plano (triáng. Allman)</label>
            <select id="ar-drill"><option value="">—</option><option value="1">Activar</option><option value="0">Desactivar</option></select></div>
          <button class="btn-secondary" id="ar-drill-apply" style="flex:0 0 auto;font-size:11px" title="Triángulo Allman: añade GDL de giro en-plano (supera el bloqueo del CST). Solo afecta áreas de 3 nodos.">Aplicar</button>
        </div>
        <div class="prop-row" style="margin-top:8px">
          <button class="btn-danger" id="ar-del" style="width:100%;font-size:11px">${i18n.t('Eliminar')} ${areas.length} ${i18n.t('área(s)')}</button>
        </div>
      </div>`;
  }
  _bindAreaActions() {
    const sel = this._tabContents.sel;
    sel.querySelector('#ar-beh-apply')?.addEventListener('click', () => {
      const v = sel.querySelector('#ar-beh').value; if (v) this.app.setAreasProps({ behavior: v });
    });
    sel.querySelector('#ar-t-apply')?.addEventListener('click', () => {
      const t = parseFloat(sel.querySelector('#ar-t').value); if (t > 0) this.app.setAreasProps({ thickness: t });
    });
    sel.querySelector('#ar-mat-apply')?.addEventListener('click', () => {
      const m = +sel.querySelector('#ar-mat').value; if (m) this.app.setAreasProps({ matId: m });
    });
    sel.querySelector('#ar-drill-apply')?.addEventListener('click', () => {
      const v = sel.querySelector('#ar-drill').value; if (v !== '') this.app.setAreasProps({ drilling: v === '1' });
    });
    sel.querySelector('#ar-del')?.addEventListener('click', () => this.app.deleteSelected());
  }

  _nodeActionsHTML(nodes) {
    return `
      <div class="prop-section" style="border:1px solid var(--node-col);border-radius:6px;padding:8px;margin-top:8px">
        <div class="prop-title" style="color:var(--node-col);margin-top:0">Apoyo · ${nodes.length} nodo(s)</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn-secondary nod-sup" data-p="empotrado" style="flex:1;font-size:11px" title="Fija las 6 GDL">Empotrado</button>
          <button class="btn-secondary nod-sup" data-p="rotulado" style="flex:1;font-size:11px" title="Fija traslaciones, libera giros">Rótula</button>
          <button class="btn-secondary nod-sup" data-p="rodillo" style="flex:1;font-size:11px" title="Solo vertical (Uz)">Rodillo</button>
          <button class="btn-secondary nod-sup" data-p="libre" style="flex:1;font-size:11px" title="Sin apoyo">Libre</button>
        </div>
      </div>
      <div class="load-section prop-section" style="border:1px solid var(--node-col);border-radius:6px;padding:8px;margin-top:8px">
        <div class="prop-title load-title-row" style="color:var(--node-col);margin-top:0">Carga Nodal · ${nodes.length} nodo(s) ${this._lcSelectHTML('loads-lc-multinode')}</div>
        <div class="prop-row cols3">
          <div class="prop-field"><label>Fx</label><input type="number" data-mlf="0" value="0" step="1"></div>
          <div class="prop-field"><label>Fy</label><input type="number" data-mlf="1" value="0" step="1"></div>
          <div class="prop-field"><label>Fz</label><input type="number" data-mlf="2" value="0" step="1"></div>
        </div>
        <div class="prop-row cols3">
          <div class="prop-field"><label>Mx</label><input type="number" data-mlf="3" value="0" step="0.1"></div>
          <div class="prop-field"><label>My</label><input type="number" data-mlf="4" value="0" step="0.1"></div>
          <div class="prop-field"><label>Mz</label><input type="number" data-mlf="5" value="0" step="0.1"></div>
        </div>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="btn-primary" id="btn-apply-load-multi" style="flex:1;font-size:11px" title="Asigna la misma carga nodal a TODOS los nodos seleccionados">Aplicar a todos</button>
          <button class="btn-secondary" id="btn-clear-load-multi" style="flex:1;font-size:11px" title="Quita la carga nodal de los nodos seleccionados">Limpiar todos</button>
        </div>
      </div>`;
  }
  _bindNodeActions() {
    const sel = this._tabContents.sel;
    sel.querySelectorAll('.nod-sup').forEach(b => b.addEventListener('click', () => this.app.setSupportSelectedNodes(b.dataset.p)));
    const lcId = () => +(sel.querySelector('#loads-lc-multinode')?.value) || this.app._activeLcId;
    sel.querySelector('#btn-apply-load-multi')?.addEventListener('click', () => {
      const F = [0,1,2,3,4,5].map(i => parseFloat(sel.querySelector(`[data-mlf="${i}"]`)?.value) || 0);
      this.app.setNodalLoadSelected(F, lcId());
    });
    sel.querySelector('#btn-clear-load-multi')?.addEventListener('click', () => this.app.setNodalLoadSelected(null, lcId()));
  }

  // Move / Copy (linear array) — works for nodes and elements.
  _transformHTML(n) {
    return `
      <div class="prop-section" style="border:1px solid var(--teal);border-radius:6px;padding:8px;margin-top:8px">
        <div class="prop-title" style="color:var(--teal);margin-top:0">Mover / Copiar selección</div>
        <div class="prop-row cols3" style="margin-bottom:6px">
          <div class="prop-field"><label>dX (m)</label><input type="number" id="tr-dx" value="0" step="0.5"></div>
          <div class="prop-field"><label>dY (m)</label><input type="number" id="tr-dy" value="0" step="0.5"></div>
          <div class="prop-field"><label>dZ (m)</label><input type="number" id="tr-dz" value="0" step="0.5"></div>
        </div>
        <div class="prop-row" style="align-items:flex-end;gap:6px">
          <div class="prop-field" style="width:96px"><label>Repeticiones</label><input type="number" id="tr-rep" value="1" min="1" step="1"></div>
          <button class="btn-secondary" id="tr-copy" style="flex:1;font-size:11px" title="Crea copias desplazadas (array)">Copiar ×N</button>
          <button class="btn-secondary" id="tr-move" style="flex:1;font-size:11px" title="Desplaza la selección">Mover</button>
        </div>
        <details style="margin-top:6px">
          <summary style="cursor:pointer;font-size:11px;color:var(--text-muted)">2ª dirección (array 2D) y espejar</summary>
          <div class="prop-row cols3" style="gap:6px;margin:6px 0">
            <div class="prop-field"><label>dX₂</label><input type="number" id="tr-dx2" value="0" step="0.5"></div>
            <div class="prop-field"><label>dY₂</label><input type="number" id="tr-dy2" value="0" step="0.5"></div>
            <div class="prop-field"><label>dZ₂</label><input type="number" id="tr-dz2" value="0" step="0.5"></div>
          </div>
          <div class="prop-row" style="align-items:flex-end;gap:6px;margin-bottom:8px">
            <div class="prop-field" style="width:96px"><label>Repeticiones₂</label><input type="number" id="tr-rep2" value="0" min="0" step="1"></div>
            <span class="panel-hint" style="flex:1">Array 2D = grilla rep × rep₂ (usa "Copiar ×N").</span>
          </div>
          <div class="prop-row" style="align-items:flex-end;gap:6px">
            <div class="prop-field"><label>Espejar plano</label>
              <select id="tr-mir"><option value="X">X = c</option><option value="Y">Y = c</option><option value="Z">Z = c</option></select></div>
            <div class="prop-field" style="width:70px"><label>c (m)</label><input type="number" id="tr-mirc" value="0" step="0.5"></div>
            <button class="btn-secondary" id="tr-mirror" style="flex:1;font-size:11px" title="Crea una copia reflejada de la selección">Espejar</button>
          </div>
        </details>
        <p class="panel-hint" style="margin:6px 0 0">Ej.: dX=5, rep=10 → 10 copias cada 5 m. Con dY₂ y rep₂ se hace grilla 2D. Copias coincidentes se fusionan.</p>
      </div>`;
  }
  _bindTransform() {
    const $ = (i) => this._tabContents.sel.querySelector(i);
    const num = (i) => parseFloat($(i).value) || 0;
    $('#tr-copy')?.addEventListener('click', () => this.app.copySelection(num('#tr-dx'), num('#tr-dy'), num('#tr-dz'), parseInt($('#tr-rep').value, 10), num('#tr-dx2'), num('#tr-dy2'), num('#tr-dz2'), parseInt($('#tr-rep2').value, 10)));
    $('#tr-move')?.addEventListener('click', () => this.app.moveSelection(num('#tr-dx'), num('#tr-dy'), num('#tr-dz')));
    $('#tr-mirror')?.addEventListener('click', () => this.app.mirrorSelection($('#tr-mir').value, num('#tr-mirc')));
  }

  // HTML for bulk actions on N selected elements.
  _selActionsHTML(elems) {
    const mats = [...this.app.model.materials.values()].map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    const secs = [...this.app.model.sections.values()].map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    const lcs = [...this.app.model.loadCases.values()].filter(l => l.type !== 'spectrum')
      .map(l => `<option value="${l.id}" ${l.id === this.app._activeLcId ? 'selected' : ''}>${esc(l.name)}${l.selfWeight ? ' ⊕PP' : ''}</option>`).join('');
    const n = elems.length;
    return `
      <div class="prop-section" style="border:1px solid var(--accent);border-radius:6px;padding:8px;margin-top:8px">
        <div class="prop-title" style="color:var(--accent);margin-top:0">Acciones · ${n} elemento(s)</div>
        <div class="prop-row" style="align-items:flex-end;gap:6px;margin-bottom:6px">
          <div class="prop-field" style="flex:1"><label>Material a todos</label>
            <select id="sel-mat"><option value="">—</option>${mats}</select></div>
          <button class="btn-secondary" id="sel-mat-go" style="font-size:11px">Aplicar</button>
        </div>
        <div class="prop-row" style="align-items:flex-end;gap:6px;margin-bottom:6px">
          <div class="prop-field" style="flex:1"><label>Sección a todos</label>
            <select id="sel-sec"><option value="">—</option>${secs}</select></div>
          <button class="btn-secondary" id="sel-sec-go" style="font-size:11px">Aplicar</button>
        </div>
        <div class="prop-row" style="align-items:flex-end;gap:6px;margin-bottom:8px">
          <div class="prop-field" style="flex:1"><label>Discretizar (nº tramos c/u)</label>
            <input type="number" id="sel-disc" value="4" min="2" step="1"></div>
          <button class="btn-secondary" id="sel-disc-go" style="font-size:11px">Dividir</button>
        </div>
        <div style="border-top:1px dashed var(--border2);margin:4px 0 8px;padding-top:8px">
          <div class="prop-row cols3" style="gap:6px;margin-bottom:6px">
            <div class="prop-field"><label>Carga w (kN/m)</label><input type="number" id="sel-w" value="10" step="1"></div>
            <div class="prop-field"><label>Dirección</label>
              <select id="sel-wdir">
                <option value="gravity">Gravedad ↓</option>
                <option value="globalX">Global +X</option>
                <option value="globalY">Global +Y</option>
                <option value="localY">Local y</option>
                <option value="localZ">Local z</option>
              </select></div>
            <div class="prop-field"><label>Caso</label><select id="sel-wlc">${lcs}</select></div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn-secondary" id="sel-w-go" style="flex:1;font-size:11px" title="Asigna la misma carga distribuida a todos (reemplaza la previa en ese caso)">Aplicar carga</button>
            <button class="btn-secondary" id="sel-w-clr" style="flex:1;font-size:11px" title="Quita las cargas distribuidas de estos elementos en el caso elegido">Quitar carga</button>
          </div>
          <div class="prop-row" style="margin-top:6px">
            <div class="prop-field"><label>Temperatura ΔT (°C)</label><input type="number" id="sel-dt" value="20" step="5" title="Cambio uniforme de temperatura. Usa α del material → carga axial térmica."></div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn-secondary" id="sel-dt-go" style="flex:1;font-size:11px" title="Asigna ΔT uniforme a los elementos (reemplaza la previa en ese caso)">Aplicar ΔT</button>
            <button class="btn-secondary" id="sel-dt-clr" style="flex:1;font-size:11px" title="Quita las cargas de temperatura de estos elementos en el caso elegido">Quitar ΔT</button>
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
          <button class="btn-secondary" id="sel-join" style="flex:1;font-size:11px" title="Une tramos colineales en una sola barra">Unir colineales</button>
          ${n === 2 ? `<button class="btn-secondary" id="sel-inter" style="flex:1;font-size:11px" title="Crea un nodo común en el cruce de los 2 elementos">Cortar en intersección</button>` : ''}
          <button class="btn-secondary" id="sel-hide" style="flex:1;font-size:11px" title="Oculta los elementos (Vista → Mostrar todo para revertir)">Ocultar</button>
        </div>
        <div class="prop-row" style="align-items:flex-end;gap:6px">
          <div class="prop-field" style="flex:1"><label>Crear grupo (nombre)</label>
            <input type="text" id="sel-grp" placeholder="ej. Cordón superior"></div>
          <button class="btn-secondary" id="sel-grp-go" style="font-size:11px">Agrupar</button>
        </div>
      </div>`;
  }

  _bindSelActions(ids) {
    const $ = (i) => this._tabContents.sel.querySelector(i);
    $('#sel-mat-go')?.addEventListener('click', () => { const v = $('#sel-mat').value; if (v) this.app.setMaterialSelected(v); });
    $('#sel-sec-go')?.addEventListener('click', () => { const v = $('#sel-sec').value; if (v) this.app.setSectionSelected(v); });
    $('#sel-disc-go')?.addEventListener('click', () => this.app.discretizeSelected(parseInt($('#sel-disc').value, 10)));
    $('#sel-w-go')?.addEventListener('click', () => this.app.setDistLoadSelected(parseFloat($('#sel-w').value), $('#sel-wdir').value, $('#sel-wlc').value));
    $('#sel-w-clr')?.addEventListener('click', () => this.app.setDistLoadSelected(0, $('#sel-wdir').value, $('#sel-wlc').value));
    $('#sel-dt-go')?.addEventListener('click', () => this.app.setTempLoadSelected(parseFloat($('#sel-dt').value), $('#sel-wlc').value));
    $('#sel-dt-clr')?.addEventListener('click', () => this.app.setTempLoadSelected(0, $('#sel-wlc').value));
    $('#sel-join')?.addEventListener('click', () => this.app.joinSelectedElements());
    $('#sel-inter')?.addEventListener('click', () => this.app.joinIntersection());
    $('#sel-hide')?.addEventListener('click', () => this.app.hideSelected());
    $('#sel-grp-go')?.addEventListener('click', () => this.app.createGroup($('#sel-grp').value));
  }

  // Lista de groups guardados (seleccionar / ocultar / mostrar / eliminar).
  _groupsHTML() {
    const g = this.app.groups?.() ;
    if (!g || !g.size) return '';
    let rows = '';
    for (const [nombre, set] of g) {
      rows += `<div class="prop-row" style="align-items:center;gap:4px;margin-bottom:4px">
        <span style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${nombre}">${nombre} <span style="color:var(--text-muted)">(${set.size})</span></span>
        <button class="btn-secondary grp-sel" data-g="${nombre}" style="font-size:10px;padding:3px 6px" title="Seleccionar">◉</button>
        <button class="btn-secondary grp-hide" data-g="${nombre}" style="font-size:10px;padding:3px 6px" title="Ocultar">🚫</button>
        <button class="btn-secondary grp-show" data-g="${nombre}" style="font-size:10px;padding:3px 6px" title="Mostrar">👁</button>
        <button class="btn-secondary grp-del" data-g="${nombre}" style="font-size:10px;padding:3px 6px" title="Eliminar grupo">✕</button>
      </div>`;
    }
    return `<div class="prop-section" style="border:1px solid var(--border2);border-radius:6px;padding:8px;margin-top:8px">
      <div class="prop-title" style="margin-top:0">Grupos</div>${rows}</div>`;
  }

  _bindGroups() {
    const root = this._tabContents.sel;
    root.querySelectorAll('.grp-sel').forEach(b => b.addEventListener('click', () => this.app.selectGroup(b.dataset.g)));
    root.querySelectorAll('.grp-hide').forEach(b => b.addEventListener('click', () => this.app.hideGroup(b.dataset.g)));
    root.querySelectorAll('.grp-show').forEach(b => b.addEventListener('click', () => this.app.showGroup(b.dataset.g)));
    root.querySelectorAll('.grp-del').forEach(b => b.addEventListener('click', () => this.app.deleteGroup(b.dataset.g)));
  }

  showNothing() {
    const sel = this._tabContents.sel;
    if (sel) {
      const ocultos = this.app.viewport?.hiddenCount?.() || 0;
      sel.innerHTML = '<p class="panel-hint">Haga clic en un nodo, elemento o área para editar sus propiedades. Ctrl+clic para seleccionar varios.</p>'
        + (ocultos ? `<p class="panel-hint" style="color:var(--warn)">${ocultos} elemento(s) oculto(s) · Vista → Mostrar todo</p>` : '')
        + this._groupsHTML();
      this._bindGroups();
    }
    this._switchVTab('model');
    this._switchTab('sel');
  }

  showNode(node, focusSupports = false) {
    if (!node) { this.showNothing(); return; }
    this._switchVTab('model');
    this._switchTab('sel');
    const results = this.app._results;
    let diaphHTML = '';
    try { diaphHTML = this._nodeDiaphragmHTML(node); } catch (e) { console.warn('nodeDiaphragmHTML:', e); }
    this._tabContents.sel.innerHTML = this._nodeHTML(node)
      + diaphHTML
      + (results ? this._nodeResultsHTML(node, results) : '')
      + this._nodeLoadsHTML(node)
      + this._allLoadsHTML('node', node.id);
    this._bindNodeEvents(node);
    this._bindNodeLoadsEvents(node);
    if (focusSupports) {
      const el = this._tabContents.sel.querySelector('.restraints-section');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  showElement(elem) {
    if (!elem) { this.showNothing(); return; }
    this._switchVTab('model');
    this._switchTab('sel');
    const results = this.app._results;
    const one = [{ type: 'elem', id: elem.id }];
    this._tabContents.sel.innerHTML = this._elemHTML(elem)
      + (results ? this._elemResultsHTML(elem, results) : '')
      + this._elemLoadsHTML(elem)
      + this._allLoadsHTML('elem', elem.id)
      + this._selActionsHTML(one)   // Actions (material/section/load/group…) also with 1 element
      + this._transformHTML(1);       // Move / Copy also with 1 element
    this._bindElemEvents(elem);
    this._bindElemLoadsEvents(elem);
    this._bindSelActions([elem.id]);
    this._bindTransform();
  }

  // ── AREA element (membrane / plate / shell) ────────────────────────────────
  showArea(area) {
    if (!area) { this.showNothing(); return; }
    this._switchVTab('model');
    this._switchTab('sel');
    this._tabContents.sel.innerHTML = this._areaHTML(area) + this._areaResultsHTML(area);
    this._bindAreaEvents(area);
  }

  _areaHTML(area) {
    const model = this.app.model;
    const matOptions = [...model.materials.values()].map(m =>
      `<option value="${m.id}" ${m.id === area.matId ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    const beh = area.behavior || 'membrane';
    const behOpt = (v, lbl) => `<option value="${v}" ${beh === v ? 'selected' : ''}>${lbl}</option>`;
    const kind = area.kind || (area.nodes.length === 3 ? 'CST' : 'QUAD');
    const elemTipo = area.nodes.length === 3 ? 'DKT' : 'MITC4';
    return `
      <div class="prop-id">Área #${area.id} · ${kind} (${area.nodes.length} nodos)</div>

      <div class="prop-section">
        <div class="prop-title">Nodos</div>
        <p class="panel-hint" style="font-family:var(--font-mono)">${area.nodes.join(' · ')}</p>
      </div>

      <div class="prop-section">
        <div class="prop-title">Material y espesor</div>
        <div class="prop-row cols1">
          <div class="prop-field"><label>Material</label><select id="a-mat">${matOptions}</select></div>
        </div>
        <div class="prop-row">
          <div class="prop-field"><label>Espesor t (m)</label><input type="number" id="a-t" value="${area.thickness}" min="0.001" step="0.05"></div>
        </div>
      </div>

      <div class="prop-section">
        <div class="prop-title">Comportamiento</div>
        <div class="prop-row cols1">
          <div class="prop-field"><label>Tipo</label>
            <select id="a-beh" title="Membrana = solo en-plano · Placa = solo flexión · Shell = membrana + placa (flexión)">
              ${behOpt('membrane', 'Membrana (en-plano)')}
              ${behOpt('plate', 'Placa (flexión)')}
              ${behOpt('shell', 'Shell (membrana + placa)')}
            </select>
          </div>
        </div>
        <p class="rel-hint">Flexión con elemento <b>${elemTipo}</b>. La membrana resiste cargas en su plano; la placa/shell resiste flexión fuera del plano.</p>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;margin-top:6px" title="Deformación plana (ε_z=0) en vez de tensión plana (σ_z=0). Solo afecta la parte de membrana.">
          <input type="checkbox" id="a-pstrain" ${area.planeStrain ? 'checked' : ''}> Deformación plana (membrana)
        </label>
        ${area.nodes.length === 3 ? `
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;margin-top:6px" title="Triángulo Allman: añade un GDL de giro en el plano por nodo. Menos rígido que el CST en flexión en-plano (supera el bloqueo por corte).">
          <input type="checkbox" id="a-drill" ${area.drilling ? 'checked' : ''}> Giro en el plano (Allman, ↓rigidez del CST)
        </label>` : ''}
      </div>

      ${this._areaThermalHTML(area)}

      <div class="delete-btn-row">
        <button class="btn-danger" id="btn-del-area" style="width:100%;">Eliminar Área #${area.id}</button>
      </div>
    `;
  }

  // Area thermal load (#57): temperature per face (red = +z, blue = −z) Abaqus-style.
  // The mean → membrane dilation; the gradient → bending moment.
  _areaThermalHTML(area) {
    const model = this.app.model;
    const lcs = [...model.loadCases.values()].filter(lc => lc.type !== 'spectrum');
    if (!lcs.length) return '';
    const lcId = this.app._activeLcId && model.loadCases.get(this.app._activeLcId)?.type !== 'spectrum'
      ? this.app._activeLcId : lcs[0].id;
    const lcOpts = lcs.map(lc => `<option value="${lc.id}" ${lc.id === lcId ? 'selected' : ''}>${esc(lc.name)}</option>`).join('');
    // Prefill with the area's existing thermal load in that case
    const cur = (model.loadCases.get(lcId)?.loads || []).find(l => l.type === 'temp' && l.areaId === area.id);
    const top = cur?.dTtop ?? (cur?.dT ?? 0), bot = cur?.dTbot ?? (cur?.dT ?? 0);
    return `
      <div class="prop-section">
        <div class="prop-title">Carga térmica (por cara, #57)</div>
        <div class="prop-row cols1">
          <div class="prop-field"><label>Caso de carga</label><select id="a-dt-lc">${lcOpts}</select></div>
        </div>
        <div class="prop-row">
          <div class="prop-field"><label style="color:#e23">🟥 Cara +Z, ΔT (°C)</label>
            <input type="number" id="a-dt-top" value="${top}" step="5" title="Temperatura de la cara superior (+z local, roja)."></div>
          <div class="prop-field"><label style="color:#2563eb">🟦 Cara −Z, ΔT (°C)</label>
            <input type="number" id="a-dt-bot" value="${bot}" step="5" title="Temperatura de la cara inferior (−z local, azul)."></div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn-secondary" id="a-dt-go" style="flex:1;font-size:11px" title="Asigna la temperatura por cara a esta área (reemplaza la previa en ese caso). Media → membrana; diferencia → momento térmico de flexión.">Aplicar ΔT</button>
          <button class="btn-secondary" id="a-dt-clr" style="flex:1;font-size:11px" title="Quita la carga térmica de esta área en el caso elegido">Quitar ΔT</button>
        </div>
        <p class="rel-hint">Caras iguales → dilatación uniforme (membrana). Caras distintas → gradiente a través del espesor = momento de flexión (placa/shell).</p>
      </div>`;
  }

  // Stresses (von Mises and invariants), plate moments and nodal displacements
  // of the area if there are results.
  _areaResultsHTML(area) {
    const res = this.app._results;
    if (!res || typeof res.getAreaStress !== 'function') return '';
    let s = null; try { s = res.getAreaStress(area.id); } catch { /* no valid results */ }
    // Displacements of the area's nodes (always available if there is u).
    let dispRows = '';
    if (typeof res.getNodeDisp === 'function') {
      const fd = v => (v == null || !isFinite(v)) ? '—' : (+v).toExponential(2);
      for (const nid of area.nodes) {
        let d = null; try { d = res.getNodeDisp(nid); } catch { /* node without DOF */ }
        if (!d) continue;
        dispRows += `<tr><td>#${nid}</td><td style="text-align:right;font-family:var(--font-mono);font-size:10px">${fd(d[0])}, ${fd(d[1])}, ${fd(d[2])}</td></tr>`;
      }
    }
    if (!s && !dispRows) return '';
    const f = v => (v == null || !isFinite(v)) ? '—' : (+v).toExponential(3);
    const stressBlock = s ? `
        <div class="prop-title" style="color:var(--warn);margin-top:0">Tensiones (centro)</div>
        <table class="res-table"><tbody>
          <tr><td>von Mises${s.vmSurf != null ? ' (superficie)' : ' (membrana)'}</td><td style="text-align:right;font-family:var(--font-mono)">${f(s.vm)}</td></tr>
          ${s.vmSurf != null ? `<tr><td>· membrana</td><td style="text-align:right;font-family:var(--font-mono);color:var(--text-muted)">${f(s.vmMembrane)}</td></tr>
          <tr><td>· cara sup / inf</td><td style="text-align:right;font-family:var(--font-mono);font-size:10px;color:var(--text-muted)">${f(s.vmTop)} / ${f(s.vmBot)}</td></tr>` : ''}
          <tr><td>σ₁ (principal, membrana)</td><td style="text-align:right;font-family:var(--font-mono)">${f(s.s1)}</td></tr>
          <tr><td>σ₂ (principal, membrana)</td><td style="text-align:right;font-family:var(--font-mono)">${f(s.s2)}</td></tr>
          <tr><td>σx, σy, τxy (membrana, local)</td><td style="text-align:right;font-family:var(--font-mono);font-size:10px">${f(s.sx)}, ${f(s.sy)}, ${f(s.txy)}</td></tr>
        </tbody></table>` : '';
    const momentBlock = (s && s.Mx != null) ? `
        <div class="prop-title" style="margin-top:8px">Momentos de placa (kN·m/m, centro, local)</div>
        <table class="res-table"><tbody>
          <tr><td>Mx, My, Mxy</td><td style="text-align:right;font-family:var(--font-mono);font-size:11px">${f(s.Mx)}, ${f(s.My)}, ${f(s.Mxy)}</td></tr>
        </tbody></table>` : '';
    const strainBlock = (s && s.ex != null) ? `
        <div class="prop-title" style="margin-top:8px">Deformaciones de membrana (ε, centro, local)</div>
        <table class="res-table"><tbody>
          <tr><td>εx, εy, γxy</td><td style="text-align:right;font-family:var(--font-mono);font-size:10px">${f(s.ex)}, ${f(s.ey)}, ${f(s.gxy)}</td></tr>
          <tr><td>ε₁, ε₂ (principales)</td><td style="text-align:right;font-family:var(--font-mono);font-size:11px">${f(s.e1)}, ${f(s.e2)}</td></tr>
        </tbody></table>` : '';
    const curvBlock = (s && s.kx != null) ? `
        <div class="prop-title" style="margin-top:8px">Curvaturas de flexión (κ, 1/m, centro, local)</div>
        <table class="res-table"><tbody>
          <tr><td>κx, κy, κxy</td><td style="text-align:right;font-family:var(--font-mono);font-size:10px">${f(s.kx)}, ${f(s.ky)}, ${f(s.kxy)}</td></tr>
        </tbody></table>` : '';
    const dispBlock = dispRows ? `
        <div class="prop-title" style="margin-top:8px">Desplazamientos nodales (δx, δy, δz)</div>
        <table class="res-table"><tbody>${dispRows}</tbody></table>` : '';
    return `
      <div class="prop-section" style="border:1px solid var(--warn);border-radius:6px;padding:8px">
        ${stressBlock}${strainBlock}${momentBlock}${curvBlock}${dispBlock}
      </div>`;
  }

  _bindAreaEvents(area) {
    const sel = this._tabContents.sel;
    const save = () => {
      this.app.snapshot();
      this.app.model.updateArea(area.id, {
        matId: +sel.querySelector('#a-mat').value,
        thickness: parseFloat(sel.querySelector('#a-t').value),
        behavior: sel.querySelector('#a-beh').value,
        planeStrain: sel.querySelector('#a-pstrain').checked,
        ...(sel.querySelector('#a-drill') ? { drilling: sel.querySelector('#a-drill').checked } : {}),
      });
      this.app.viewport.addAreaMesh(this.app.model.areas.get(area.id));
      this.app.viewport._setAreaHL(area.id, 0xffc107);   // keep highlighted
      this.app.markDirty();
    };
    sel.querySelectorAll('#a-mat, #a-t, #a-beh, #a-pstrain, #a-drill').forEach(inp => inp.addEventListener('change', save));
    // Thermal load per face (#57)
    const $ = q => sel.querySelector(q);
    $('#a-dt-go')?.addEventListener('click', () => {
      this.app.setTempLoadArea(area.id, parseFloat($('#a-dt-top').value), parseFloat($('#a-dt-bot').value), $('#a-dt-lc').value);
    });
    $('#a-dt-clr')?.addEventListener('click', () => {
      this.app.setTempLoadArea(area.id, 0, 0, $('#a-dt-lc').value);
      $('#a-dt-top').value = 0; $('#a-dt-bot').value = 0;
    });
    sel.querySelector('#btn-del-area')?.addEventListener('click', () => this.app.deleteArea(area.id));
  }

  // Lists ALL the loads (from all cases) on an element/node + the combinations
  // that include each case (with its factor).
  _allLoadsHTML(tipo, id) {
    const m = this.app.model;
    const f = (v) => (v == null || !isFinite(v)) ? '—' : (+v).toFixed(2);
    const dir = { gravity:'Gravedad ↓', globalX:'+X', globalY:'+Y', globalZ:'+Z', localY:'local y', localZ:'local z' };
    const combosOf = (lcId) => [...(m.combinations?.values() || [])]
      .filter(c => (c.factors || []).some(fa => fa.lcId === lcId))
      .map(c => { const fa = c.factors.find(x => x.lcId === lcId); return `${esc(c.name)} (×${f(fa.factor)})`; });
    const rows = [];
    for (const lc of m.loadCases.values()) {
      const loads = (lc.loads || []).filter(ld => tipo === 'elem'
        ? (ld.type === 'dist' && ld.elemId === id)
        : (ld.type === 'nodal' && ld.nodeId === id));
      if (!loads.length) continue;
      const desc = loads.map(ld => ld.type === 'dist'
        ? `w = ${f(ld.w)} kN/m (${dir[ld.dir] || ld.dir || 'grav'})`
        : `F=(${f(ld.F[0])}, ${f(ld.F[1])}, ${f(ld.F[2])}) kN${(ld.F[3]||ld.F[4]||ld.F[5]) ? `<br>M=(${f(ld.F[3])}, ${f(ld.F[4])}, ${f(ld.F[5])})` : ''}`).join('<br>');
      const cmb = combosOf(lc.id);
      rows.push(`<tr><td>${esc(lc.name)}${lc.selfWeight ? ' <span class="muted">+pp</span>' : ''}</td><td>${desc}</td><td>${cmb.length ? cmb.join('<br>') : '<span class="muted">—</span>'}</td></tr>`);
    }
    const cuerpo = rows.length ? rows.join('')
      : `<tr><td colspan="3" class="muted">${i18n.t(tipo === 'elem' ? 'Sin cargas asignadas a este elemento en ningún caso.' : 'Sin cargas asignadas a este nodo en ningún caso.')}</td></tr>`;
    return `<details class="loads-all"${rows.length ? ' open' : ''}>
      <summary>Cargas en todos los casos${rows.length ? ` (${rows.length})` : ''}</summary>
      <table class="loads-all-tbl"><thead><tr><th>Caso</th><th>Carga</th><th>En combinaciones</th></tr></thead><tbody>${cuerpo}</tbody></table>
    </details>`;
  }

  refresh(model) {
    if (this._currentTab === 'mat')   this.renderMaterials();
    if (this._currentTab === 'sec')   this.renderSections();
    if (this._currentTab === 'dia')   this.renderDiaphragms();
    if (this._currentTab === 'nodos') this.renderNodesGrid();
    if (this._currentVTab === 'resultados') this._switchRTab(this._currentRTab);
    if (this._currentVTab === 'diseno') this.renderDesign();
    if (this._currentTab === 'elems') this.renderElemsGrid();
  }

  // ── Node grid ──────────────────────────────────────────────────────────────
  // ── Pegar desde Excel (grids tipo hoja de cálculo) ──────────────────────────
  // Separa una fila en celdas tolerando TAB (copiado de Excel), «;», espacios o «,».
  _splitRow(line) {
    if (line.includes('\t')) return line.split('\t');
    if (line.includes(';'))  return line.split(';');
    if (/\s/.test(line.trim())) return line.trim().split(/\s+/);
    return line.split(',');
  }
  // Número con coma decimal (locale es-CL) o punto: "6,5" → 6.5, "6.5" → 6.5.
  _numCell(c) {
    c = String(c == null ? '' : c).trim();
    if (/^[-+]?\d*,\d+$/.test(c)) c = c.replace(',', '.');
    return parseFloat(c);
  }
  // Texto pegado → filas de celdas; descarta una fila de encabezado (1ª celda no numérica).
  _parseGrid(text) {
    const rows = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim(); if (!line) continue;
      rows.push(this._splitRow(line).map(c => c.trim()));
    }
    if (rows.length && !isFinite(this._numCell(rows[0][0]))) rows.shift();
    return rows;
  }

  // Alta en bloque de nodos desde texto tabular (pegado directo o lista). Sin diálogo.
  _bulkAddNodes(text) {
    const rows = this._parseGrid(text);
    const dof = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'];
    let added = 0, bad = 0;
    this.app.snapshot();
    for (const r of rows) {
      const x = this._numCell(r[0]), y = this._numCell(r[1]), z = this._numCell(r[2]);
      if (![x, y, z].every(isFinite)) { bad++; continue; }
      const restraints = {};
      for (let i = 0; i < 6; i++) if (r[3 + i] != null && r[3 + i] !== '') restraints[dof[i]] = this._numCell(r[3 + i]) ? 1 : 0;
      this.app.model.addNode(x, y, z, restraints); added++;
    }
    if (added) {
      this.app.viewport.renderModel(this.app.model);
      this.app.markDirty(); this.app._updateStats?.(); this.app.viewport.zoomExtents?.();
      this.renderNodesGrid();
    }
    this.app.toast(`${added} nodo(s) creado(s)${bad ? ` · ${bad} fila(s) inválida(s)` : ''}`, bad ? 'warn' : 'ok');
  }

  // Alta en bloque de elementos desde texto tabular. Material/sección por nombre o número.
  _bulkAddElements(text) {
    if (this.app.model.materials.size === 0 || this.app.model.sections.size === 0) {
      this.app.toast('Cree al menos un material y una sección antes de pegar elementos', 'warn'); return;
    }
    const rows = this._parseGrid(text);
    const mats = [...this.app.model.materials.values()];
    const secs = [...this.app.model.sections.values()];
    const refId = (list, ref) => {
      if (ref == null || ref === '') return undefined;
      const n = this._numCell(ref); if (isFinite(n) && list.some(o => o.id === n)) return n;
      const o = list.find(o => String(o.name).toLowerCase() === String(ref).toLowerCase());
      return o ? o.id : undefined;
    };
    let added = 0, bad = 0;
    this.app.snapshot();
    for (const r of rows) {
      const n1 = Math.round(this._numCell(r[0])), n2 = Math.round(this._numCell(r[1]));
      if (!isFinite(n1) || !isFinite(n2)) { bad++; continue; }
      const el = this.app.model.addElement(n1, n2, refId(mats, r[2]), refId(secs, r[3]));
      el ? added++ : bad++;
    }
    if (added) {
      this.app.viewport.renderModel(this.app.model);
      this.app.markDirty(); this.app._updateStats?.();
      this.renderElemsGrid();
    }
    this.app.toast(`${added} elemento(s) creado(s)${bad ? ` · ${bad} fila(s) inválida(s)/omitida(s)` : ''}`, bad ? 'warn' : 'ok');
  }

  // Pegado TSV/CSV multi-fila directo en el grid (Ctrl+V), sin diálogo. Un valor
  // simple (sin TAB ni salto de línea) deja el pegado normal dentro de la celda.
  _wireGridPaste(wrap, bulk) {
    wrap.addEventListener('paste', (e) => {
      const txt = (e.clipboardData || window.clipboardData)?.getData('text') || '';
      if (!/[\t\n]/.test(txt)) return;
      e.preventDefault();
      bulk(txt);
    });
  }

  renderNodesGrid() {
    const wrap = document.getElementById('nodes-grid-wrap');
    if (!wrap) return;
    const model = this.app.model;
    const dofs = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'];

    let tbody = '';
    for (const node of model.nodes.values()) {
      const r = node.restraints;
      const cbs = dofs.map(d => `<td class="ng-cb"><input type="checkbox" data-nid="${node.id}" data-dof="${d}" ${r[d] ? 'checked' : ''}></td>`).join('');
      tbody += `<tr data-nid="${node.id}">
        <td class="ng-id">${node.id}</td>
        <td class="ng-coord"><input class="ng-x" type="number" value="${+node.x.toFixed(4)}" step="0.1" data-nid="${node.id}" data-f="x"></td>
        <td class="ng-coord"><input class="ng-y" type="number" value="${+node.y.toFixed(4)}" step="0.1" data-nid="${node.id}" data-f="y"></td>
        <td class="ng-coord"><input class="ng-z" type="number" value="${+node.z.toFixed(4)}" step="0.1" data-nid="${node.id}" data-f="z"></td>
        ${cbs}
        <td class="ng-del"><button data-nid="${node.id}" title="Eliminar">×</button></td>
      </tr>`;
    }
    // Fila NUEVA: escribe X Y Z (+ apoyos) y Enter/salir → crea el nodo al instante.
    const newCbs = dofs.map(d => `<td class="ng-cb"><input type="checkbox" data-dof="${d}"></td>`).join('');
    tbody += `<tr class="ng-new">
      <td class="ng-id">＋</td>
      <td class="ng-coord"><input class="ng-nx" type="number" step="0.1" placeholder="X"></td>
      <td class="ng-coord"><input class="ng-ny" type="number" step="0.1" placeholder="Y"></td>
      <td class="ng-coord"><input class="ng-nz" type="number" step="0.1" placeholder="Z"></td>
      ${newCbs}
      <td></td>
    </tr>`;

    wrap.innerHTML = `<table class="nodes-grid">
      <thead><tr>
        <th>#</th><th>X</th><th>Y</th><th>Z</th>
        <th>Ux</th><th>Uy</th><th>Uz</th><th>Rx</th><th>Ry</th><th>Rz</th><th></th>
      </tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <p class="panel-hint" style="margin:6px 2px 0">Escribe <b>X Y Z</b> en la última fila y <b>Enter</b> para crear un nodo; o <b>pega</b> una lista desde Excel (Ctrl+V). Apoyos con las casillas.</p>`;

    // Editar coordenadas de filas existentes
    wrap.querySelectorAll('input[data-f][data-nid]').forEach(inp => {
      inp.addEventListener('change', () => {
        const id = +inp.dataset.nid, field = inp.dataset.f, val = this._numCell(inp.value) || 0;
        this.app.snapshot();
        this.app.model.updateNode(id, { [field]: val });
        const node = this.app.model.nodes.get(id);
        if (node) this.app.viewport.refreshNode(node);
        this.app.markDirty();
      });
    });
    // Apoyos de filas existentes
    wrap.querySelectorAll('input[data-dof][data-nid]').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = +cb.dataset.nid, dof = cb.dataset.dof;
        this.app.snapshot();
        const node = this.app.model.nodes.get(id);
        if (node) { node.restraints[dof] = cb.checked ? 1 : 0; this.app.viewport.refreshNode(node); this.app.markDirty(); }
      });
    });
    // Eliminar
    wrap.querySelectorAll('.ng-del button').forEach(btn => {
      btn.addEventListener('click', () => { this.app.deleteNode(+btn.dataset.nid); this.renderNodesGrid(); });
    });

    // Fila nueva: commit al presionar Enter o al salir de la fila con X,Y,Z válidos.
    const newRow = wrap.querySelector('tr.ng-new');
    const commitNew = () => {
      const x = this._numCell(newRow.querySelector('.ng-nx').value);
      const y = this._numCell(newRow.querySelector('.ng-ny').value);
      const z = this._numCell(newRow.querySelector('.ng-nz').value);
      if (![x, y, z].every(isFinite)) return false;
      const restraints = {};
      newRow.querySelectorAll('input[data-dof]').forEach(cb => { if (cb.checked) restraints[cb.dataset.dof] = 1; });
      this.app.snapshot();
      const node = this.app.model.addNode(x, y, z, restraints);
      this.app.viewport.addNodeMesh(node); this.app.markDirty(); this.app._updateStats?.();
      this.renderNodesGrid();
      setTimeout(() => document.querySelector('#nodes-grid-wrap tr.ng-new .ng-nx')?.focus(), 0);
      return true;
    };
    newRow.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitNew(); } });
    newRow.addEventListener('focusout', (e) => { if (!newRow.contains(e.relatedTarget)) commitNew(); });

    this._wireGridPaste(wrap, (t) => this._bulkAddNodes(t));
  }

  _addNodeRow() {
    this.app.snapshot();
    const b = this.app.model.getBounds();
    const node = this.app.model.addNode(b.center.x, b.center.y, 0);
    this.app.viewport.addNodeMesh(node);
    this.app.markDirty();
    this.renderNodesGrid();
    setTimeout(() => {
      const row = document.querySelector(`#nodes-grid-wrap tr[data-nid="${node.id}"]`);
      row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      row?.querySelector('.ng-x')?.focus();
    }, 60);
  }

  // ── Elements grid ──────────────────────────────────────────────────────────
  renderElemsGrid() {
    const wrap = document.getElementById('elems-grid-wrap');
    if (!wrap) return;
    const model = this.app.model;
    const res   = this.app._results;

    const mats = [...model.materials.values()];
    const secs = [...model.sections.values()];
    if (mats.length === 0 || secs.length === 0) {
      wrap.innerHTML = '<p class="panel-hint">Cree al menos un material y una sección (pestañas Mat. y Sec.) para agregar elementos.</p>';
      return;
    }

    const matOpts = id => mats.map(m => `<option value="${m.id}" ${m.id === id ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    const secOpts = id => secs.map(s => `<option value="${s.id}" ${s.id === id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');

    const fCol = (f, key1, key2 = null) => {
      if (!f) return '<td class="eg-f">—</td>';
      const v = key2 ? (Math.abs(f[key1]) > Math.abs(f[key2]) ? f[key1] : f[key2]) : f[key1];
      const col = Math.abs(v) < 1e-10 ? '' : v > 0 ? ' style="color:#ef5350"' : ' style="color:#42a5f5"';
      return `<td class="eg-f"${col}>${Math.abs(v) < 1e-10 ? '—' : v.toExponential(2)}</td>`;
    };

    let tbody = '';
    for (const el of model.elements.values()) {
      const f = res ? res.getElemForces(el.id) : null;
      tbody += `<tr data-eid="${el.id}">
        <td class="eg-id">${el.id}</td>
        <td class="eg-node"><input type="number" class="eg-n1" value="${el.n1}" min="1" data-eid="${el.id}" data-f="n1"></td>
        <td class="eg-node"><input type="number" class="eg-n2" value="${el.n2}" min="1" data-eid="${el.id}" data-f="n2"></td>
        <td class="eg-sel"><select class="eg-mat" data-eid="${el.id}">${matOpts(el.matId)}</select></td>
        <td class="eg-sel"><select class="eg-sec" data-eid="${el.id}">${secOpts(el.secId)}</select></td>
        ${res ? `${fCol(f,'N')}${fCol(f,'Vy1','Vy2')}${fCol(f,'My1','My2')}${fCol(f,'Mz1','Mz2')}` : ''}
        <td class="ng-del"><button data-eid="${el.id}" title="Eliminar">×</button></td>
      </tr>`;
    }
    // Fila NUEVA: escribe N1 N2 (Mat/Sec por defecto) y Enter → crea la barra.
    tbody += `<tr class="eg-new">
      <td class="eg-id">＋</td>
      <td class="eg-node"><input type="number" class="eg-nn1" min="1" placeholder="N1"></td>
      <td class="eg-node"><input type="number" class="eg-nn2" min="1" placeholder="N2"></td>
      <td class="eg-sel"><select class="eg-nmat">${matOpts(mats[0].id)}</select></td>
      <td class="eg-sel"><select class="eg-nsec">${secOpts(secs[0].id)}</select></td>
      ${res ? '<td></td><td></td><td></td><td></td>' : ''}
      <td></td>
    </tr>`;

    const resHeader = res ? '<th class="eg-f">N</th><th class="eg-f">Vy</th><th class="eg-f">My</th><th class="eg-f">Mz</th>' : '';
    wrap.innerHTML = `<table class="elems-grid">
      <thead><tr>
        <th>#</th><th>N1</th><th>N2</th><th>Mat.</th><th>Sec.</th>${resHeader}<th></th>
      </tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <p class="panel-hint" style="margin:6px 2px 0">Escribe <b>N1 N2</b> en la última fila y <b>Enter</b> para crear una barra; o <b>pega</b> una lista (Ctrl+V). N1/N2 = números de la columna «#».</p>`;

    // Editar filas existentes (nodos)
    wrap.querySelectorAll('input[data-f][data-eid]').forEach(inp => {
      inp.addEventListener('change', () => {
        const id = +inp.dataset.eid, field = inp.dataset.f, val = parseInt(inp.value) || 1;
        this.app.snapshot();
        this.app.model.updateElement(id, { [field]: val });
        this.app.viewport.refreshElem(this.app.model.elements.get(id));
        this.app.markDirty();
      });
    });
    wrap.querySelectorAll('.eg-mat[data-eid]').forEach(sel => {
      sel.addEventListener('change', () => { const id = +sel.dataset.eid; this.app.snapshot(); this.app.model.updateElement(id, { matId: +sel.value }); this.app.markDirty(); });
    });
    wrap.querySelectorAll('.eg-sec[data-eid]').forEach(sel => {
      sel.addEventListener('change', () => { const id = +sel.dataset.eid; this.app.snapshot(); this.app.model.updateElement(id, { secId: +sel.value }); this.app.markDirty(); });
    });
    wrap.querySelectorAll('.ng-del button').forEach(btn => {
      btn.addEventListener('click', () => { this.app.deleteElement(+btn.dataset.eid); this.renderElemsGrid(); });
    });

    // Fila nueva de elemento
    const newRow = wrap.querySelector('tr.eg-new');
    const commitNew = () => {
      const n1 = Math.round(this._numCell(newRow.querySelector('.eg-nn1').value));
      const n2 = Math.round(this._numCell(newRow.querySelector('.eg-nn2').value));
      if (!isFinite(n1) || !isFinite(n2)) return false;
      const matId = +newRow.querySelector('.eg-nmat').value || undefined;
      const secId = +newRow.querySelector('.eg-nsec').value || undefined;
      this.app.snapshot();
      const el = this.app.model.addElement(n1, n2, matId, secId);
      if (!el) { this.app.toast(`No se pudo crear la barra ${n1}–${n2} (¿nodo inexistente o N1=N2?)`, 'warn'); return false; }
      this.app.viewport.renderModel(this.app.model); this.app.markDirty(); this.app._updateStats?.();
      this.renderElemsGrid();
      setTimeout(() => document.querySelector('#elems-grid-wrap tr.eg-new .eg-nn1')?.focus(), 0);
      return true;
    };
    newRow.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitNew(); } });
    newRow.addEventListener('focusout', (e) => { if (!newRow.contains(e.relatedTarget)) commitNew(); });

    this._wireGridPaste(wrap, (t) => this._bulkAddElements(t));
  }

  // ── Diaphragm membership + tributary mass for a node ──────────────────────
  _nodeDiaphragmHTML(node) {
    const model = this.app.model;
    const rows  = [];

    for (const d of model.diaphragms.values()) {
      if (!d.nodes.includes(node.id)) continue;

      const isMaster = (d.masterId === node.id) ||
                       (!d.masterId && d.nodes[0] === node.id);
      const floorNodes = d.nodes.map(id => model.nodes.get(id)).filter(Boolean);
      let massRow = '';

      if (d.mass?.m > 0 && floorNodes.length >= 1) {
        const weights = computeTributaryWeights(floorNodes, model, d.z);
        const w       = weights.get(node.id) ?? 0;
        const mNode   = w * d.mass.m;
        massRow = `<div class="prop-row">
          <div class="prop-field"><label>Masa tributaria</label>
            <span class="prop-val">${mNode.toFixed(3)} ton
              (${(w*100).toFixed(1)} % de ${d.mass.m} ton)</span>
          </div>
        </div>`;
      }

      rows.push(`
        <div class="prop-section" style="border-top:1px solid #00bcd433;margin-top:6px;padding-top:6px">
          <div class="prop-title" style="color:#00bcd4">
            Diafragma #${d.id} — ${esc(d.name)}${isMaster ? ' &nbsp;<span style="color:#00e5ff;font-weight:bold">[Nodo CR]</span>' : ''}
          </div>
          <div class="prop-row">
            <div class="prop-field"><label>Z piso</label>
              <span class="prop-val">${d.z} m</span>
            </div>
            <div class="prop-field"><label>CM</label>
              <span class="prop-val">(${+(d.cm?.x??0).toFixed(3)}, ${+(d.cm?.y??0).toFixed(3)})</span>
            </div>
            <div class="prop-field"><label>CR</label>
              <span class="prop-val">(${+(d.cr?.x??0).toFixed(3)}, ${+(d.cr?.y??0).toFixed(3)})</span>
            </div>
          </div>
          ${massRow}
        </div>`);
    }

    if (rows.length === 0) return '';
    return `<div class="prop-group">${rows.join('')}</div>`;
  }

  // ── Node form ──────────────────────────────────────────────────────────────
  _nodeHTML(node) {
    const r  = node.restraints;
    const nm = node.nodeMass || { mx: 0, my: 0, mz: 0, irx: 0, iry: 0, irz: 0 };
    const sp = node.springs  || { kux: 0, kuy: 0, kuz: 0, krx: 0, kry: 0, krz: 0 };
    const hasSp = Object.values(sp).some(k => k > 0);
    const hasSK = Array.isArray(node.springK) && node.springK.length === 36;   // resorte acoplado (#2)
    const su = node.springUni || {};   // resorte unilateral (#3)
    const uniMode = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'].map(d => su[d]).find(v => v === 'c' || v === 't') || '';
    const pd = node.prescDisp || { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 };
    const hasPD = Object.values(pd).some(v => v);
    const is2D = this.app.model.mode === '2D';
    const outOfPlane = new Set(['uy', 'rx', 'rz']);   // restringidos auto en 2D
    const dof = ['ux','uy','uz','rx','ry','rz'];
    const labels = ['UX','UY','UZ','RX','RY','RZ'];
    const checks = dof.map((d, i) => {
      const dis = is2D && outOfPlane.has(d);
      return `<div class="restraint-cell" ${dis ? 'style="opacity:0.4" title="Modelo 2D: este GDL fuera del plano se restringe automáticamente"' : ''}>
        <input type="checkbox" data-dof="${d}" ${(r[d] || dis) ? 'checked' : ''} ${dis ? 'disabled' : ''}>
        <span>${labels[i]}</span>
      </div>`;
    }).join('');

    const hasNM = nm.mx > 0 || nm.my > 0 || nm.mz > 0 || nm.irx > 0 || nm.iry > 0 || nm.irz > 0;

    return `
      <div class="prop-id">Nodo #${node.id}</div>

      <div class="prop-section">
        <div class="prop-title">Coordenadas</div>
        <div class="prop-row cols3">
          <div class="prop-field"><label>X</label><input type="number" id="n-x" value="${+node.x.toFixed(6)}" step="0.01"></div>
          <div class="prop-field"><label>Y</label><input type="number" id="n-y" value="${is2D ? 0 : +node.y.toFixed(6)}" step="0.01" ${is2D ? 'disabled title="Modelo 2D: todos los nodos están en el plano Y=0"' : ''}></div>
          <div class="prop-field"><label>Z</label><input type="number" id="n-z" value="${+node.z.toFixed(6)}" step="0.01"></div>
        </div>
      </div>

      <div class="prop-section restraints-section">
        <div class="prop-title">Restricciones (1 = fijo)</div>
        <div class="restraint-grid">${checks}</div>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">
          <button class="btn-secondary" id="btn-fix-all" style="font-size:11px;" title="Fija las 6 GDL (3 traslaciones + 3 giros): empotramiento, resiste fuerzas y momentos.">Fijar Todo (empotramiento total)</button>
          <div style="display:flex;gap:6px;">
            <button class="btn-secondary" id="btn-free-all" style="flex:1;font-size:11px;">Liberar Todo</button>
            <button class="btn-secondary" id="btn-pin" style="flex:1;font-size:11px;" title="Apoyo articulado: fija traslaciones, libera giros (no resiste momentos).">Pin (rótula)</button>
          </div>
        </div>
      </div>

      <div class="prop-section">
        <div class="prop-title" style="${hasSp ? 'color:var(--teal)' : ''}">
          Apoyo Elástico — Resortes${hasSp ? ' ●' : ''}
        </div>
        <div class="prop-row cols3">
          <div class="prop-field"><label>kUX (kN/m)</label>
            <input type="number" id="ns-kux" value="${sp.kux ?? 0}" step="100" min="0">
          </div>
          <div class="prop-field"><label>kUY (kN/m)</label>
            <input type="number" id="ns-kuy" value="${sp.kuy ?? 0}" step="100" min="0">
          </div>
          <div class="prop-field"><label>kUZ (kN/m)</label>
            <input type="number" id="ns-kuz" value="${sp.kuz ?? 0}" step="100" min="0">
          </div>
        </div>
        <div class="prop-row cols3">
          <div class="prop-field"><label>kRX (kN·m/rad)</label>
            <input type="number" id="ns-krx" value="${sp.krx ?? 0}" step="100" min="0">
          </div>
          <div class="prop-field"><label>kRY (kN·m/rad)</label>
            <input type="number" id="ns-kry" value="${sp.kry ?? 0}" step="100" min="0">
          </div>
          <div class="prop-field"><label>kRZ (kN·m/rad)</label>
            <input type="number" id="ns-krz" value="${sp.krz ?? 0}" step="100" min="0">
          </div>
        </div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px">
          Apoyo parcial: resorte en GDL global <b>libre</b> (no marque la
          restricción rígida de ese GDL). k = 0 → sin resorte. La reacción
          del resorte aparece al mostrar Reacciones.
        </div>
        <div class="prop-row" style="margin-top:6px">
          <div class="prop-field" style="flex:1">
            <label title="Apoyo UNILATERAL: el resorte se desactiva cuando el nodo se despega (uplift/gap). Solo-compresión = no toma tracción (fundaciones que se levantan). Se resuelve por conjunto activo en el análisis estático (#3).">Unilateral (a los GDL con resorte)</label>
            <select id="ns-uni" style="width:100%">
              <option value="" ${uniMode === '' ? 'selected' : ''}>Bilateral (normal)</option>
              <option value="c" ${uniMode === 'c' ? 'selected' : ''}>Solo-compresión (uplift)</option>
              <option value="t" ${uniMode === 't' ? 'selected' : ''}>Solo-tracción</option>
            </select>
          </div>
        </div>
        <div class="prop-row cols4" style="margin-top:6px">
          <div class="prop-field"><label title="Rigidez del resorte a lo largo de la dirección dada">k incl. (kN/m)</label>
            <input type="number" id="ns-incl-k" value="0" step="100" min="0"></div>
          <div class="prop-field"><label>dx</label><input type="number" id="ns-incl-dx" value="1" step="0.1"></div>
          <div class="prop-field"><label>dy</label><input type="number" id="ns-incl-dy" value="0" step="0.1"></div>
          <div class="prop-field"><label>dz</label><input type="number" id="ns-incl-dz" value="0" step="0.1"></div>
        </div>
        <div style="display:flex;gap:6px;margin-top:4px">
          <button class="btn-secondary" id="btn-incl-spring" style="flex:1;font-size:11px" title="Resorte de apoyo INCLINADO: rigidez k a lo largo de (dx,dy,dz). Genera una matriz de resorte ACOPLADA 6×6 (términos fuera de la diagonal) y se ensambla completa (#2).">↗ Aplicar resorte inclinado${hasSK ? ' ●' : ''}</button>
          <button class="btn-secondary" id="btn-clear-sk" style="font-size:11px" title="Quitar la matriz de resorte acoplada">✕</button>
        </div>
      </div>

      <div class="prop-section">
        <div class="prop-title" style="${hasPD ? 'color:var(--teal)' : ''}">
          Desplazamiento prescrito${hasPD ? ' ●' : ''}
        </div>
        <div class="prop-row cols3">
          <div class="prop-field"><label>UX (m)</label>
            <input type="number" id="np-ux" value="${pd.ux || 0}" step="0.001">
          </div>
          <div class="prop-field"><label>UY (m)</label>
            <input type="number" id="np-uy" value="${pd.uy || 0}" step="0.001" ${is2D ? 'disabled' : ''}>
          </div>
          <div class="prop-field"><label>UZ (m)</label>
            <input type="number" id="np-uz" value="${pd.uz || 0}" step="0.001">
          </div>
        </div>
        <div class="prop-row cols3">
          <div class="prop-field"><label>RX (rad)</label>
            <input type="number" id="np-rx" value="${pd.rx || 0}" step="0.0005" ${is2D ? 'disabled' : ''}>
          </div>
          <div class="prop-field"><label>RY (rad)</label>
            <input type="number" id="np-ry" value="${pd.ry || 0}" step="0.0005">
          </div>
          <div class="prop-field"><label>RZ (rad)</label>
            <input type="number" id="np-rz" value="${pd.rz || 0}" step="0.0005" ${is2D ? 'disabled' : ''}>
          </div>
        </div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px">
          Asentamiento / giro de apoyo impuesto (#54). El GDL con valor ≠ 0 se
          impone como soporte con ese desplazamiento; la reacción aparece en
          Reacciones. Valor 0 = sin prescribir.
        </div>
      </div>

      <div class="prop-section">
        <div class="prop-title" style="${hasNM ? 'color:#ffd54f' : ''}">
          Masa Nodal Concentrada${hasNM ? ' ●' : ''}
        </div>
        <div class="prop-row cols3">
          <div class="prop-field"><label>mx (ton)</label>
            <input type="number" id="nm-mx" value="${nm.mx ?? 0}" step="0.1" min="0">
          </div>
          <div class="prop-field"><label>my (ton)</label>
            <input type="number" id="nm-my" value="${nm.my ?? 0}" step="0.1" min="0">
          </div>
          <div class="prop-field"><label>mz (ton)</label>
            <input type="number" id="nm-mz" value="${nm.mz ?? 0}" step="0.1" min="0">
          </div>
        </div>
        <div class="prop-row cols3">
          <div class="prop-field"><label>Irx (ton·m²)</label>
            <input type="number" id="nm-irx" value="${nm.irx ?? 0}" step="0.1" min="0" title="Inercia rotacional concentrada en el GDL de giro Rx">
          </div>
          <div class="prop-field"><label>Iry (ton·m²)</label>
            <input type="number" id="nm-iry" value="${nm.iry ?? 0}" step="0.1" min="0" title="Inercia rotacional concentrada en el GDL de giro Ry">
          </div>
          <div class="prop-field"><label>Irz (ton·m²)</label>
            <input type="number" id="nm-irz" value="${nm.irz ?? 0}" step="0.1" min="0" title="Inercia rotacional concentrada en el GDL de giro Rz">
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:4px">
          <button class="btn-secondary" id="btn-nm-iso" style="flex:1;font-size:11px;">
            Copiar mx → my, mz
          </button>
        </div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px">
          Entra en matriz M (análisis modal). W [kN] → m = W/9.81 ton · Irx/Iry/Irz = inercia rotacional (modos torsionales).
        </div>
      </div>

      <div class="delete-btn-row">
        <button class="btn-danger" id="btn-del-node" style="width:100%;">Eliminar Nodo #${node.id}</button>
      </div>
    `;
  }

  _bindNodeEvents(node) {
    const sel = this._tabContents.sel;

    const numVal = id => parseFloat(sel.querySelector(id)?.value) || 0;

    const save = () => {
      this.app.snapshot();
      const x = numVal('#n-x'), y = numVal('#n-y'), z = numVal('#n-z');
      const restraints = {};
      sel.querySelectorAll('[data-dof]').forEach(cb => {
        restraints[cb.dataset.dof] = cb.checked ? 1 : 0;
      });
      const nodeMass = {
        mx: numVal('#nm-mx'),
        my: numVal('#nm-my'),
        mz: numVal('#nm-mz'),
        irx: numVal('#nm-irx'),
        iry: numVal('#nm-iry'),
        irz: numVal('#nm-irz'),
      };
      const springs = {
        kux: numVal('#ns-kux'), kuy: numVal('#ns-kuy'), kuz: numVal('#ns-kuz'),
        krx: numVal('#ns-krx'), kry: numVal('#ns-kry'), krz: numVal('#ns-krz'),
      };
      const prescDisp = {
        ux: numVal('#np-ux'), uy: numVal('#np-uy'), uz: numVal('#np-uz'),
        rx: numVal('#np-rx'), ry: numVal('#np-ry'), rz: numVal('#np-rz'),
      };
      // Unilateral spring (#3): the chosen mode applies to the DOFs that have a spring (k>0).
      const uniSel = sel.querySelector('#ns-uni')?.value || '';
      const springUni = {};
      [['ux', springs.kux], ['uy', springs.kuy], ['uz', springs.kuz], ['rx', springs.krx], ['ry', springs.kry], ['rz', springs.krz]]
        .forEach(([d, kk]) => springUni[d] = (uniSel && kk > 0) ? uniSel : '');
      this.app.model.updateNode(node.id, { x, y, z, restraints, nodeMass, springs, prescDisp, springUni });
      this.app.viewport.refreshNode(this.app.model.nodes.get(node.id));
      this.app.markDirty();
    };

    sel.querySelectorAll('input[type=number]').forEach(inp =>
      inp.addEventListener('change', save)
    );
    sel.querySelectorAll('[data-dof]').forEach(cb =>
      cb.addEventListener('change', save)
    );
    sel.querySelector('#ns-uni')?.addEventListener('change', save);   // unilateral spring (#3)

    // Quick presets
    sel.querySelector('#btn-fix-all')?.addEventListener('click', () => {
      sel.querySelectorAll('[data-dof]').forEach(cb => cb.checked = true);
      save();
    });
    sel.querySelector('#btn-free-all')?.addEventListener('click', () => {
      sel.querySelectorAll('[data-dof]').forEach(cb => cb.checked = false);
      save();
    });
    sel.querySelector('#btn-pin')?.addEventListener('click', () => {
      // Fix translations, free rotations
      ['ux','uy','uz'].forEach(d => { sel.querySelector(`[data-dof="${d}"]`).checked = true; });
      ['rx','ry','rz'].forEach(d => { sel.querySelector(`[data-dof="${d}"]`).checked = false; });
      save();
    });

    // Isotropic shortcut: copy mx to my and mz
    sel.querySelector('#btn-nm-iso')?.addEventListener('click', () => {
      const mxEl = sel.querySelector('#nm-mx');
      const val  = mxEl?.value ?? '0';
      sel.querySelector('#nm-my').value = val;
      sel.querySelector('#nm-mz').value = val;
      save();
    });

    // INCLINED support spring → coupled 6×6 matrix (#2)
    sel.querySelector('#btn-incl-spring')?.addEventListener('click', () => {
      const k = numVal('#ns-incl-k');
      const dir = [numVal('#ns-incl-dx'), numVal('#ns-incl-dy'), numVal('#ns-incl-dz')];
      if (k <= 0 || !dir.some(v => v)) { this.app.toast('Indique k > 0 y una dirección (dx,dy,dz)', 'warn'); return; }
      this.app.snapshot();
      this.app.model.updateNode(node.id, { springK: this.app.model.constructor.inclinedSpringK(k, dir) });
      this.app.markDirty();
      this.app.toast('Resorte inclinado (acoplado) aplicado', 'ok');
      this.app.viewport.refreshNode(this.app.model.nodes.get(node.id)); this.showNode(this.app.model.nodes.get(node.id), true);
    });
    sel.querySelector('#btn-clear-sk')?.addEventListener('click', () => {
      if (!(Array.isArray(node.springK) && node.springK.length === 36)) return;
      this.app.snapshot();
      this.app.model.updateNode(node.id, { springK: null });
      this.app.markDirty();
      this.app.toast('Resorte acoplado quitado', 'ok');
      this.app.viewport.refreshNode(this.app.model.nodes.get(node.id)); this.showNode(this.app.model.nodes.get(node.id), true);
    });

    sel.querySelector('#btn-del-node')?.addEventListener('click', () => {
      this.app.deleteNode(node.id);
    });
  }

  // ── Element form ───────────────────────────────────────────────────────────
  _elemHTML(elem) {
    const model = this.app.model;
    const matOptions = [...model.materials.values()].map(m =>
      `<option value="${m.id}" ${m.id === elem.matId ? 'selected' : ''}>${esc(m.name)}</option>`
    ).join('');
    const secOptions = [...model.sections.values()].map(s =>
      `<option value="${s.id}" ${s.id === elem.secId ? 'selected' : ''}>${esc(s.name)}</option>`
    ).join('');

    // Releases labeled by FORCE (matching the result diagrams): releasing Mz ⇒ the
    // moment Mz is 0 at that end, etc.
    const relDefs = [
      { i: 0, lbl: 'N',  tip: 'fuerza axial' },
      { i: 1, lbl: 'Vy', tip: 'corte local y' },
      { i: 2, lbl: 'Vz', tip: 'corte local z' },
      { i: 3, lbl: 'T',  tip: 'torsión' },
      { i: 4, lbl: 'My', tip: 'flexión en plano local x–z' },
      { i: 5, lbl: 'Mz', tip: 'flexión en plano local x–y' },
    ];

    // Orientation hint: which GLOBAL direction each bending corresponds to
    // (depends on the element's orientation — local ≠ global)
    let orientHint = '';
    {
      const n1 = model.nodes.get(elem.n1);
      const n2 = model.nodes.get(elem.n2);
      if (n1 && n2) {
        try {
          const { ey, ez } = localAxes(n1, n2);
          const gname = v => {
            const ax = ['X', 'Y', 'Z']; let b = 0;
            for (let k = 1; k < 3; k++) if (Math.abs(v[k]) > Math.abs(v[b])) b = k;
            return ax[b] + (b === 2 ? ' (gravedad)' : '');
          };
          orientHint = `<b>Mz</b> = flexión por cargas según <b>${gname(ey)}</b> global &nbsp;·&nbsp; <b>My</b> = por cargas según <b>${gname(ez)}</b> global`;
        } catch { /* degenerate element */ }
      }
    }

    const relHalf = (label, offset) => {
      const boxes = relDefs.map(d =>
        `<div class="releases-cell" title="Liberar ${d.lbl} (${d.tip}): el esfuerzo ${d.lbl} vale 0 en este extremo">
          <input type="checkbox" data-rel="${offset + d.i}" ${elem.releases[offset + d.i] ? 'checked' : ''}>
          <span>${d.lbl}</span>
        </div>`
      ).join('');
      return `<div class="releases-half">
        <div class="releases-half-title">${label}
          <span class="rel-presets">
            <button type="button" class="rel-btn" data-rel-pin="${offset}" title="Rótula clásica: libera My y Mz en este extremo">Rótula</button>
            <button type="button" class="rel-btn" data-rel-clear="${offset}" title="Quitar todas las liberaciones de este extremo">Limpiar</button>
          </span>
        </div>
        <div class="releases-grid">${boxes}</div>
      </div>`;
    };

    return `
      <div class="prop-id">Elemento #${elem.id}</div>

      <div class="prop-section">
        <div class="prop-title">Nodos</div>
        <div class="prop-row">
          <div class="prop-field"><label>Nodo 1</label><input type="number" id="e-n1" value="${elem.n1}" min="1"></div>
          <div class="prop-field"><label>Nodo 2</label><input type="number" id="e-n2" value="${elem.n2}" min="1"></div>
        </div>
      </div>

      <div class="prop-section">
        <div class="prop-title">Material</div>
        <div class="prop-row cols1">
          <div class="prop-field"><label>Material</label>
            <select id="e-mat">${matOptions}</select>
          </div>
        </div>
      </div>

      <div class="prop-section">
        <div class="prop-title">Sección</div>
        <div class="prop-row cols1">
          <div class="prop-field"><label>Sección</label>
            <select id="e-sec">${secOptions}</select>
          </div>
        </div>
      </div>

      <div class="prop-section">
        <div class="prop-title">Liberaciones (rótulas)</div>
        ${orientHint ? `<p class="rel-hint">${orientHint}</p>` : ''}
        ${relHalf(`Extremo 1 — nodo ${elem.n1}`, 0)}
        ${relHalf(`Extremo 2 — nodo ${elem.n2}`, 6)}
        <p class="rel-warn">⚠ Liberar en exceso crea mecanismos (estructura inestable): el análisis lo detectará y avisará.</p>
      </div>

      <div class="prop-section">
        <div class="prop-title">Cable / No lineal (NL-lite)</div>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer" title="El elemento se comporta como cable: solo resiste tracción (queda flojo en compresión, N=0). Para el análisis no lineal.">
          <input type="checkbox" id="e-cable" ${elem.cable ? 'checked' : ''}> Cable (solo tracción)
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer" title="El elemento solo resiste compresión (puntal/contacto): queda suelto en tracción (N=0). Excluyente con «Cable». Para el análisis no lineal.">
          <input type="checkbox" id="e-componly" ${elem.compressionOnly ? 'checked' : ''}> Puntal (solo compresión)
        </label>
        <div class="prop-row cols1">
          <div class="prop-field"><label title="Longitud natural (sin tensión) ÷ longitud geométrica. 1 = sin pretensar. Menor que 1 = pretensado (tracción en reposo).">L₀ / L (pretensado si &lt;1)</label>
            <input type="number" id="e-l0f" value="${(elem.L0factor ?? 1)}" min="0.5" max="1.5" step="0.005">
          </div>
        </div>
        <p class="rel-warn" style="color:var(--text-muted)">Se usa en <b>Análisis → No lineal</b> (actívalo en ⚙ Configuración). El análisis lineal (F5) ignora estos campos.</p>
      </div>

      <div class="prop-section">
        <div class="prop-title" title="Cacho rígido / zona rígida de extremo (end length offset, como SAP2000/ETABS): tramo rígido en cada extremo de la barra. Acorta la luz flexible → más rigidez. En metros; 0 = sin cacho.">Cacho rígido (zona rígida de extremo)</div>
        <div class="prop-row">
          <div class="prop-field"><label title="Longitud del tramo rígido en el extremo del nodo 1 (m).">Cacho i — nodo ${elem.n1} (m)</label>
            <input type="number" id="e-rig-i" value="${(elem.rigidEnd?.i ?? 0)}" min="0" step="0.05"></div>
          <div class="prop-field"><label title="Longitud del tramo rígido en el extremo del nodo 2 (m).">Cacho j — nodo ${elem.n2} (m)</label>
            <input type="number" id="e-rig-j" value="${(elem.rigidEnd?.j ?? 0)}" min="0" step="0.05"></div>
        </div>
        <p class="rel-warn" style="color:var(--text-muted)">Condensa un brazo rígido en cada extremo dentro de K/M (la luz flexible = L − cacho_i − cacho_j). Afecta el análisis lineal (F5). Útil para el ancho del nudo viga-columna.</p>
      </div>

      <div class="prop-section">
        <div class="prop-title" title="Resorte de extremo / fijación parcial (conexión semi-rígida, como «partial fixity» de SAP2000): rigidez ROTACIONAL kN·m/rad entre la barra y el nodo. Vacío = rígido; el solver lo condensa (k→∞ rígido, k→0 rótula). Afecta el análisis lineal (F5). My/Mz como en las liberaciones de arriba.">Resorte de extremo (fijación parcial)</div>
        <div class="prop-row">
          <div class="prop-field"><label title="Resorte rotacional My (flexión plano local x–z) en el extremo i.">My·i (kN·m/rad)</label>
            <input type="number" id="e-spr-myi" value="${elem.endSprings?.[4] ?? ''}" min="0" step="100" placeholder="rígido"></div>
          <div class="prop-field"><label title="Resorte rotacional Mz (flexión plano local x–y) en el extremo i.">Mz·i (kN·m/rad)</label>
            <input type="number" id="e-spr-mzi" value="${elem.endSprings?.[5] ?? ''}" min="0" step="100" placeholder="rígido"></div>
        </div>
        <div class="prop-row">
          <div class="prop-field"><label title="Resorte rotacional My (flexión plano local x–z) en el extremo j.">My·j (kN·m/rad)</label>
            <input type="number" id="e-spr-myj" value="${elem.endSprings?.[10] ?? ''}" min="0" step="100" placeholder="rígido"></div>
          <div class="prop-field"><label title="Resorte rotacional Mz (flexión plano local x–y) en el extremo j.">Mz·j (kN·m/rad)</label>
            <input type="number" id="e-spr-mzj" value="${elem.endSprings?.[11] ?? ''}" min="0" step="100" placeholder="rígido"></div>
        </div>
        <p class="rel-warn" style="color:var(--text-muted)">Conexión semi-rígida miembro↔nodo (vacío = rígido). Condensado en K (análisis lineal F5). Combinable con liberaciones (no en el mismo GDL).</p>
      </div>

      <div class="prop-section">
        <div class="prop-title" title="Viga sobre fundación elástica / resorte de LÍNEA (modelo de Winkler): módulo de balasto distribuido a lo largo de la barra, kN/m por metro (= kN/m²). Resiste la traslación transversal del miembro (suelo bajo una viga de fundación, pilote lateral…). Matriz consistente sumada a K. Afecta el análisis lineal (F5).">Fundación elástica (resorte de línea, Winkler)</div>
        <div class="prop-row">
          <div class="prop-field"><label title="Módulo de balasto en la dirección transversal local y (kN/m por m de longitud).">k·y (kN/m/m)</label>
            <input type="number" id="e-found-ky" value="${elem.foundation?.ky ?? ''}" min="0" step="100" placeholder="0"></div>
          <div class="prop-field"><label title="Módulo de balasto en la dirección transversal local z (kN/m por m de longitud).">k·z (kN/m/m)</label>
            <input type="number" id="e-found-kz" value="${elem.foundation?.kz ?? ''}" min="0" step="100" placeholder="0"></div>
        </div>
        <p class="rel-warn" style="color:var(--text-muted)">Balasto = (módulo de subrasante k_s) × (ancho de contacto). Vacío/0 = sin fundación. Σreacción del suelo = k·δ por unidad de longitud.</p>
      </div>

      <div class="prop-section">
        <div class="prop-title">Herramientas Didácticas</div>
        <button class="btn-add" id="btn-elem-matrices" style="width:100%"
          title="Ver Ke local, T, Ke global y Me de este elemento — para comparar con el cálculo manual del curso">
          Σ Ver Matrices (Ke · T · Me)
        </button>
        <button class="btn-add" id="btn-elem-dcl" style="width:100%;margin-top:4px"
          title="Diagrama de cuerpo libre: fuerzas de extremo que actúan sobre el elemento + verificación ΣF=0 ΣM=0 (requiere análisis F5)">
          ⊟ Ver DCL del elemento
        </button>
      </div>

      <div class="prop-section">
        <div class="prop-title">Discretizar</div>
        <div class="prop-row">
          <div class="prop-field"><label>Nº de partes</label>
            <input type="number" id="disc-n" value="4" min="2" step="1">
          </div>
          <div class="prop-field" style="justify-content:flex-end">
            <button class="btn-add" id="btn-disc-n" style="width:100%" title="Divide este elemento en N tramos iguales">Dividir en N</button>
          </div>
        </div>
        <div class="prop-row">
          <div class="prop-field"><label>Tramo (m)</label>
            <input type="number" id="disc-len" value="0.5" min="0.01" step="0.25">
          </div>
          <div class="prop-field" style="justify-content:flex-end">
            <button class="btn-add" id="btn-disc-len" style="width:100%" title="Divide este elemento en tramos de ≈ esta longitud">Dividir c/L</button>
          </div>
        </div>
        <p class="rel-warn" style="color:var(--text-muted)">Para volver a unir: seleccione los tramos con Ctrl+clic y use Editar → Unir Elementos Seleccionados (o Ctrl+Z).</p>
      </div>

      <div class="delete-btn-row">
        <button class="btn-danger" id="btn-del-elem" style="width:100%;">Eliminar Elemento #${elem.id}</button>
      </div>
    `;
  }

  _bindElemEvents(elem) {
    const sel = this._tabContents.sel;

    const save = () => {
      this.app.snapshot();
      const n1    = +sel.querySelector('#e-n1').value;
      const n2    = +sel.querySelector('#e-n2').value;
      const matId = +sel.querySelector('#e-mat').value;
      const secId = +sel.querySelector('#e-sec').value;
      const releases = Array(12).fill(0);
      sel.querySelectorAll('[data-rel]').forEach(cb => {
        releases[+cb.dataset.rel] = cb.checked ? 1 : 0;
      });
      const cable    = sel.querySelector('#e-cable')?.checked || false;
      const compressionOnly = sel.querySelector('#e-componly')?.checked || false;
      const L0factor = parseFloat(sel.querySelector('#e-l0f')?.value) || 1;
      const rigidEnd = { i: parseFloat(sel.querySelector('#e-rig-i')?.value) || 0, j: parseFloat(sel.querySelector('#e-rig-j')?.value) || 0 };
      // End spring / partial fixity (1-008): My/Mz per end → DOF 4/5/10/11.
      const endSprings = {};
      const addSpr = (id, dof) => { const v = parseFloat(sel.querySelector(id)?.value); if (v > 0 && isFinite(v)) endSprings[dof] = v; };
      addSpr('#e-spr-myi', 4); addSpr('#e-spr-mzi', 5); addSpr('#e-spr-myj', 10); addSpr('#e-spr-mzj', 11);
      // Elastic foundation / line spring (1-013): local subgrade moduli y/z.
      const foundation = { ky: parseFloat(sel.querySelector('#e-found-ky')?.value) || 0, kz: parseFloat(sel.querySelector('#e-found-kz')?.value) || 0 };
      this.app.model.updateElement(elem.id, { n1, n2, matId, secId, releases, cable, compressionOnly, L0factor, rigidEnd, endSprings, foundation });
      this.app.viewport.refreshElem(this.app.model.elements.get(elem.id));
      this.app.markDirty();
    };

    sel.querySelectorAll('input[type=number]:not(#disc-n):not(#disc-len), select').forEach(inp =>
      inp.addEventListener('change', save)
    );
    sel.querySelectorAll('[data-rel]').forEach(cb =>
      cb.addEventListener('change', save)
    );
    const cb_cable = sel.querySelector('#e-cable');
    const cb_comp  = sel.querySelector('#e-componly');
    cb_cable?.addEventListener('change', () => { if (cb_cable.checked && cb_comp) cb_comp.checked = false; save(); });
    cb_comp ?.addEventListener('change', () => { if (cb_comp.checked && cb_cable) cb_cable.checked = false; save(); });

    // Element matrices viewer
    sel.querySelector('#btn-elem-matrices')?.addEventListener('click', () => {
      this.app.showElementMatrices(elem.id);
    });
    // Element FBD (requires results)
    sel.querySelector('#btn-elem-dcl')?.addEventListener('click', () => {
      this.app.showElementDCL(elem.id);
    });

    // Element discretization
    sel.querySelector('#btn-disc-n')?.addEventListener('click', () => {
      const n = parseInt(sel.querySelector('#disc-n')?.value) || 0;
      if (n >= 2) this.app.discretizeElement(elem.id, { parts: n });
      else this.app.toast('Ingrese 2 o más partes', 'warn');
    });
    sel.querySelector('#btn-disc-len')?.addEventListener('click', () => {
      const l = parseFloat(sel.querySelector('#disc-len')?.value) || 0;
      if (l > 0) this.app.discretizeElement(elem.id, { length: l });
      else this.app.toast('Ingrese una longitud válida', 'warn');
    });

    // Release presets per end
    sel.querySelectorAll('[data-rel-pin]').forEach(btn =>
      btn.addEventListener('click', () => {
        const off = +btn.dataset.relPin;
        [4, 5].forEach(i => {           // classic hinge: My + Mz
          const cb = sel.querySelector(`[data-rel="${off + i}"]`);
          if (cb) cb.checked = true;
        });
        save();
      })
    );
    sel.querySelectorAll('[data-rel-clear]').forEach(btn =>
      btn.addEventListener('click', () => {
        const off = +btn.dataset.relClear;
        for (let i = 0; i < 6; i++) {
          const cb = sel.querySelector(`[data-rel="${off + i}"]`);
          if (cb) cb.checked = false;
        }
        save();
      })
    );

    sel.querySelector('#btn-del-elem')?.addEventListener('click', () => {
      this.app.deleteElement(elem.id);
    });
  }

  // ── Load input for nodes ───────────────────────────────────────────────────
  // Embedded load-case selector — avoids going to the viewport overlay
  _lcSelectHTML(domId) {
    const opts = [...this.app.model.loadCases.values()].map(l => {
      const label = l.type === 'spectrum'
        ? `〜 ${esc(l.name)} [esp]`
        : esc(l.name) + (l.selfWeight ? ' ⊕PP' : '');
      return `<option value="${l.id}" ${l.id === this.app._activeLcId ? 'selected' : ''}>${label}</option>`;
    }).join('');
    return `<select id="${domId}" class="lc-inline-select" title="Caso de carga al que se asigna esta carga (⊕PP = incluye peso propio; 〜 = espectral, no admite cargas)">${opts}</select>`;
  }

  // Note shown when the active case is spectral (does not accept loads)
  _spectralLoadNote(domId) {
    return `<div class="load-section">
      <div class="prop-title load-title-row">Cargas ${this._lcSelectHTML(domId)}</div>
      <p class="rel-hint" style="margin-top:6px">〜 Caso <b>espectral</b>: no admite cargas
        asignadas. Su resultado (envolvente sísmica) se calcula con Análisis Modal (F6)
        + Espectro de Respuesta (F7). Cambie a un caso estático para asignar cargas.</p>
    </div>`;
  }

  _nodeLoadsHTML(node) {
    const lcId = this.app._activeLcId;
    const lc   = this.app.model.loadCases.get(lcId);
    if (lc?.type === 'spectrum') return this._spectralLoadNote('loads-lc-node');
    const ex   = lc ? lc.loads.find(l => l.type === 'nodal' && l.nodeId === node.id) : null;
    const F    = ex ? ex.F : [0,0,0,0,0,0];
    return `<div class="load-section">
      <div class="prop-title load-title-row">Cargas Nodales ${this._lcSelectHTML('loads-lc-node')}</div>
      <div class="prop-row cols3">
        <div class="prop-field"><label>Fx</label><input type="number" data-lf="0" value="${F[0]}" step="1"></div>
        <div class="prop-field"><label>Fy</label><input type="number" data-lf="1" value="${F[1]}" step="1"></div>
        <div class="prop-field"><label>Fz</label><input type="number" data-lf="2" value="${F[2]}" step="1"></div>
      </div>
      <div class="prop-row cols3">
        <div class="prop-field"><label>Mx</label><input type="number" data-lf="3" value="${F[3]}" step="0.1"></div>
        <div class="prop-field"><label>My</label><input type="number" data-lf="4" value="${F[4]}" step="0.1"></div>
        <div class="prop-field"><label>Mz</label><input type="number" data-lf="5" value="${F[5]}" step="0.1"></div>
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="btn-primary" id="btn-apply-load" style="flex:1;font-size:11px;">Aplicar Carga</button>
        <button class="btn-secondary" id="btn-clear-load" style="flex:1;font-size:11px;">Limpiar</button>
      </div>
    </div>`;
  }

  _bindNodeLoadsEvents(node) {
    const sel = this._tabContents.sel;
    sel.querySelector('#loads-lc-node')?.addEventListener('change', e => {
      this.app._activeLcId = +e.target.value;
      this.app._renderLcSelector();
      this.app.refreshLoads();
      this.showNode(node);   // re-renders with the loads of the chosen case
    });
    sel.querySelector('#btn-apply-load')?.addEventListener('click', () => {
      this.app.snapshot();
      const lc = this.app.model.loadCases.get(this.app._activeLcId);
      if (!lc) { this.app.toast('No hay caso de carga activo', 'warn'); return; }
      const F = [0,1,2,3,4,5].map(i => parseFloat(sel.querySelector(`[data-lf="${i}"]`)?.value) || 0);
      const idx = lc.loads.findIndex(l => l.type === 'nodal' && l.nodeId === node.id);
      const load = { type: 'nodal', nodeId: node.id, F };
      if (idx >= 0) lc.loads[idx] = load; else lc.loads.push(load);
      this.app.markDirty();
      this.app.refreshLoads();
      this.app.toast('Carga aplicada', 'ok');
    });
    sel.querySelector('#btn-clear-load')?.addEventListener('click', () => {
      this.app.snapshot();
      const lc = this.app.model.loadCases.get(this.app._activeLcId);
      if (!lc) return;
      lc.loads = lc.loads.filter(l => !(l.type === 'nodal' && l.nodeId === node.id));
      [0,1,2,3,4,5].forEach(i => { const inp = sel.querySelector(`[data-lf="${i}"]`); if (inp) inp.value = 0; });
      this.app.markDirty();
      this.app.refreshLoads();
      this.app.toast('Carga eliminada', '');
    });
  }

  _elemLoadsHTML(elem) {
    const lcId = this.app._activeLcId;
    const lc   = this.app.model.loadCases.get(lcId);
    if (lc?.type === 'spectrum') return this._spectralLoadNote('loads-lc-elem');
    const ex   = lc ? lc.loads.find(l => l.type === 'dist' && l.elemId === elem.id) : null;
    return `<div class="load-section">
      <div class="prop-title load-title-row">Carga Distribuida ${this._lcSelectHTML('loads-lc-elem')}</div>
      <div class="prop-row">
        <div class="prop-field"><label>Dirección</label>
          <select id="dist-dir">
            <option value="gravity" ${(ex?.dir==='gravity'||ex?.dir==='globalZ'||!ex?.dir)?'selected':''}>Gravedad ↓ (w&gt;0 = abajo)</option>
            <option value="globalX" ${ex?.dir==='globalX'?'selected':''}>Global +X</option>
            <option value="globalY" ${ex?.dir==='globalY'?'selected':''}>Global +Y</option>
            <option value="localY"  ${ex?.dir==='localY' ?'selected':''}>Local y</option>
            <option value="localZ"  ${ex?.dir==='localZ' ?'selected':''}>Local z</option>
          </select>
        </div>
        <div class="prop-field"><label>w en i (kN/m)</label>
          <input type="number" id="dist-w" value="${ex?.w ?? 0}" step="1">
        </div>
        <div class="prop-field"><label>w en j (kN/m)</label>
          <input type="number" id="dist-w2" value="${ex?.w2 ?? ''}" step="1" placeholder="= w (uniforme)">
        </div>
      </div>
      <small style="color:var(--text-muted);display:block;margin-top:2px">Deja <b>w en j</b> vacío para carga uniforme; complétalo para una carga <b>trapecial</b> (w en el nodo i → w en el nodo j).</small>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="btn-primary" id="btn-apply-dist" style="flex:1;font-size:11px;">Aplicar</button>
        <button class="btn-secondary" id="btn-clear-dist" style="flex:1;font-size:11px;">Limpiar</button>
      </div>
    </div>`;
  }

  _bindElemLoadsEvents(elem) {
    const sel = this._tabContents.sel;
    sel.querySelector('#loads-lc-elem')?.addEventListener('change', e => {
      this.app._activeLcId = +e.target.value;
      this.app._renderLcSelector();
      this.app.refreshLoads();
      this.showElement(elem);   // re-renders with the loads of the chosen case
    });
    sel.querySelector('#btn-apply-dist')?.addEventListener('click', () => {
      this.app.snapshot();
      const lc = this.app.model.loadCases.get(this.app._activeLcId);
      if (!lc) { this.app.toast('No hay caso de carga activo', 'warn'); return; }
      const w   = parseFloat(sel.querySelector('#dist-w')?.value) || 0;
      const w2raw = sel.querySelector('#dist-w2')?.value;
      const dir = sel.querySelector('#dist-dir')?.value || 'globalZ';
      const idx = lc.loads.findIndex(l => l.type === 'dist' && l.elemId === elem.id);
      const load = { type: 'dist', elemId: elem.id, dir, w };
      // w2 only if filled in and differing from w → trapezoidal load
      if (w2raw != null && w2raw !== '' && isFinite(+w2raw) && +w2raw !== w) load.w2 = +w2raw;
      if (idx >= 0) lc.loads[idx] = load; else lc.loads.push(load);
      this.app.markDirty();
      this.app.refreshLoads();
      this.app.toast(load.w2 != null ? 'Carga trapecial aplicada' : 'Carga distribuida aplicada', 'ok');
    });
    sel.querySelector('#btn-clear-dist')?.addEventListener('click', () => {
      this.app.snapshot();
      const lc = this.app.model.loadCases.get(this.app._activeLcId);
      if (!lc) return;
      lc.loads = lc.loads.filter(l => !(l.type === 'dist' && l.elemId === elem.id));
      this.app.markDirty();
      this.app.refreshLoads();
    });
  }

  _nodeResultsHTML(node, results) {
    const d  = results.getNodeDisp(node.id);
    const rx = results.getReaction(node.id);
    const hasReact = Object.values(node.restraints).some(v=>v);
    const fv = v => `<span class="result-val ${Math.abs(v)<1e-10?'zero':v>0?'pos':'neg'}">${v.toExponential(4)}</span>`;
    let html = `<div class="prop-section" style="border:1px solid var(--success);border-radius:4px;padding:8px;margin-bottom:8px;">
      <div class="prop-title" style="color:var(--success)">Desplazamientos</div>
      <table class="results-table">
        <tr><th>DOF</th><th>Valor</th></tr>
        ${['Ux','Uy','Uz','Rx','Ry','Rz'].map((n,i)=>`<tr><td>${n}</td><td>${fv(d[i])}</td></tr>`).join('')}
      </table>`;
    if (hasReact) {
      html += `<div class="prop-title" style="color:var(--danger);margin-top:8px;">Reacciones</div>
      <table class="results-table">
        <tr><th>DOF</th><th>Valor</th></tr>
        ${['Rx','Ry','Rz','Rmx','Rmy','Rmz'].map((n,i)=>`<tr><td>${n}</td><td>${fv(rx[i])}</td></tr>`).join('')}
      </table>`;
    }
    return html + '</div>';
  }

  _elemResultsHTML(elem, results) {
    const f = results.getElemForces(elem.id);
    if (!f) return '';
    const fv = v => `<td class="${Math.abs(v)<1e-6?'':''}${v>0?'pos':'neg'}">${v.toExponential(4)}</td>`;
    return `<div class="prop-section" style="border:1px solid var(--success);border-radius:4px;padding:8px;margin-bottom:8px;">
      <div class="prop-title" style="color:var(--success)">Fuerzas Internas</div>
      <table class="results-table">
        <tr><th>Fuerza</th><th>Nodo 1</th><th>Nodo 2</th></tr>
        <tr><td>N</td>${fv(f.N)}<td>—</td></tr>
        <tr><td>Vy</td>${fv(f.Vy1)}${fv(f.Vy2)}</tr>
        <tr><td>Vz</td>${fv(f.Vz1)}${fv(f.Vz2)}</tr>
        <tr><td>T</td>${fv(f.T)}<td>—</td></tr>
        <tr><td>My</td>${fv(f.My1)}${fv(f.My2)}</tr>
        <tr><td>Mz</td>${fv(f.Mz1)}${fv(f.Mz2)}</tr>
      </table>
    </div>`;
  }

  // ── Materials tab ──────────────────────────────────────────────────────────
  renderMaterials() {
    const container = document.getElementById('mat-list');
    container.innerHTML = '';
    // Preloaded library (#69): insert a standard material from the catalog.
    const pick = document.createElement('div');
    pick.className = 'prop-row'; pick.style.cssText = 'gap:6px;margin-bottom:6px;align-items:flex-end';
    pick.innerHTML = `<div class="prop-field" style="flex:1"><label style="font-size:11px">Insertar material estándar</label>
      <select id="mat-catalog"><option value="">— catálogo —</option></select></div>
      <button id="mat-catalog-add" class="btn-secondary" style="white-space:nowrap;font-size:11px">＋ Insertar</button>`;
    container.appendChild(pick);
    import('../design/materials_catalog.js?v=7').then(({ MATERIAL_FAMILIES, getMaterialDef }) => {
      const sel = pick.querySelector('#mat-catalog');
      sel.innerHTML = '<option value="">— catálogo —</option>' +
        Object.entries(MATERIAL_FAMILIES).map(([fam, names]) => `<optgroup label="${fam}">` + names.map(n => `<option value="${n}">${n}</option>`).join('') + '</optgroup>').join('');
      pick.querySelector('#mat-catalog-add').addEventListener('click', () => {
        const name = sel.value; if (!name) return;
        const def = getMaterialDef(name); if (!def) return;
        this.app.snapshot();
        this.app.model.addMaterial(def);
        this.app.markDirty();
        this.renderMaterials();
        this.app.toast(`Material «${name}» agregado del catálogo`, 'ok');
      });
    }).catch(() => {});
    for (const mat of this.app.model.materials.values()) {
      container.appendChild(this._matCard(mat));
    }
  }

  _matCard(mat) {
    const card = document.createElement('div');
    card.className = 'mat-card';
    card.dataset.id = mat.id;
    card.innerHTML = `
      <div class="mat-card-head">
        <span class="mat-card-id">${mat.id}</span>
        <span class="mat-card-name">${esc(mat.name)}</span>
        <span class="mat-card-chevron">▶</span>
      </div>
      <div class="mat-card-body">
        <div class="prop-row">
          <div class="prop-field"><label>Nombre</label><input type="text" data-f="name" value="${esc(mat.name)}"></div>
          <div class="prop-field"><label>ρ (ton/m³)</label><input type="number" data-f="rho" value="${mat.rho}" step="0.01"></div>
        </div>
        <div class="prop-row">
          <div class="prop-field"><label>E (kN/m²)</label><input type="number" data-f="E" value="${mat.E}" step="1e5"></div>
          <div class="prop-field"><label>G (kN/m²)</label><input type="number" data-f="G" value="${mat.G}" step="1e5"></div>
        </div>
        <div class="prop-row">
          <div class="prop-field"><label>ν</label><input type="number" data-f="nu" value="${mat.nu}" step="0.01" min="0" max="0.5"></div>
          <div class="prop-field"><label>α (1/°C)</label><input type="number" data-f="alpha" value="${mat.alpha ?? 1e-5}" step="1e-6" title="Coef. de dilatación térmica (hormigón ~1e-5, acero ~1.2e-5). Para cargas de temperatura ΔT."></div>
        </div>
        ${this._matDesignHTML(mat)}
        <div class="card-actions">
          <button class="btn-danger btn-del-mat" style="flex:1;">Eliminar</button>
        </div>
      </div>
    `;
    card.querySelector('.mat-card-head').addEventListener('click', () => {
      card.classList.toggle('open');
    });
    card.querySelectorAll('[data-f]').forEach(inp => {
      inp.addEventListener('change', () => {
        this.app.snapshot();
        const updates = {};
        card.querySelectorAll('[data-f]').forEach(i => {
          updates[i.dataset.f] = i.type === 'number' ? +i.value : i.value;
        });
        this.app.model.updateMaterial(mat.id, updates);
        // Update card name
        card.querySelector('.mat-card-name').textContent = updates.name || mat.name;
        this.app.markDirty();
      });
    });
    card.querySelector('.btn-del-mat').addEventListener('click', () => {
      const res = this.app.model.removeMaterial(mat.id);
      if (res.ok === false) { this.app.toast(res.reason, 'warn'); return; }
      this.app.markDirty();
      this.renderMaterials();
    });
    this._bindMatDesign(card, mat);
    return card;
  }

  // Strength fields per family (MPa) for the material card.
  _matStrengthHTML(family, d = {}) {
    const f = (k, lbl, def) => `<div class="prop-field"><label>${lbl} (MPa)</label><input type="number" data-d="${k}" value="${d[k] ?? def}" step="1"></div>`;
    if (family === 'steel' || family === 'aluminum')
      return `<div class="prop-row">${f('Fy', 'Fy fluencia', 250)}${f('Fu', 'Fu rotura', 400)}</div>`;
    if (family === 'concrete')
      return `<div class="prop-row">${f('fc', "f'c", 25)}${f('fyRebar', 'fy refuerzo', 420)}</div>`;
    if (family === 'timber')
      return `<div class="prop-row">${f('Fb', 'Fb flexión', 10)}${f('Fv', 'Fv corte', 1.2)}</div>
              <div class="prop-row">${f('Fc', 'Fc compr.', 8)}${f('Ft', 'Ft tracción', 7)}</div>`;
    return `<p class="panel-hint">Familia «auto»: se clasifica por el nombre y se usan las resistencias del respaldo (design_params.json).</p>`;
  }

  _matDesignHTML(mat) {
    const fam = mat.design?.family || '';
    const opt = (v, l) => `<option value="${v}" ${fam === v ? 'selected' : ''}>${l}</option>`;
    return `
      <div class="prop-section" style="margin-top:6px">
        <div class="prop-title" title="Familia y resistencias para la verificación de diseño (AISC 360, Eurocódigo 3, ACI 318, NCh1198). Ver docs/design.md.">Diseño</div>
        <div class="prop-row cols1">
          <div class="prop-field"><label>Familia</label>
            <select class="md-family">
              ${opt('', 'auto (por nombre)')}${opt('steel', 'Acero')}${opt('concrete', 'Hormigón')}${opt('timber', 'Madera')}${opt('aluminum', 'Aluminio')}
            </select></div>
        </div>
        <div class="md-strengths">${this._matStrengthHTML(fam, mat.design || {})}</div>
      </div>`;
  }

  _bindMatDesign(card, mat) {
    const famSel = card.querySelector('.md-family');
    const strBox = card.querySelector('.md-strengths');
    if (!famSel) return;
    const saveDesign = () => {
      const family = famSel.value;
      const design = { ...(mat.design || {}) };
      if (family) design.family = family; else delete design.family;
      strBox.querySelectorAll('[data-d]').forEach(i => { const v = parseFloat(i.value); if (i.value !== '' && !isNaN(v)) design[i.dataset.d] = v; });
      this.app.snapshot();
      this.app.model.updateMaterial(mat.id, { design });
      this.app.markDirty();
    };
    famSel.addEventListener('change', () => {
      strBox.innerHTML = this._matStrengthHTML(famSel.value, mat.design || {});
      strBox.querySelectorAll('[data-d]').forEach(i => i.addEventListener('change', saveDesign));
      saveDesign();
    });
    strBox.querySelectorAll('[data-d]').forEach(i => i.addEventListener('change', saveDesign));
  }

  _addMaterial() {
    this.app.snapshot();
    this.app.model.addMaterial({ name: 'Nuevo Material' });
    this.app.markDirty();
    this.renderMaterials();
  }

  // ── Load cases (LC) — list in the «Casos y combos» tab ──────────────────────
  // Each case with a ✎ button that reuses the editCaseDialog (name/self-weight/delete).
  renderLoadCases() {
    const box = document.getElementById('lc-list');
    if (!box) return;
    box.innerHTML = '';
    for (const lc of this.app.model.loadCases.values()) {
      const isSpec = lc.type === 'spectrum';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;margin-bottom:4px;font-size:12px;color:var(--text)';
      const tag = isSpec ? ` <span style="color:var(--teal)">[esp ${lc.specDir}]</span>`
                         : (lc.selfWeight ? ' <span style="color:var(--text-muted)">⊕PP</span>' : '');
      const ltLabel = this.app._loadTypeLabel(lc.loadType || (isSpec ? 'seismic' : (lc.selfWeight ? 'dead' : 'other')));
      const ltBadge = ` <span style="color:var(--text-muted);font-size:10px">· ${ltLabel}</span>`;
      row.innerHTML = `
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${isSpec ? '〜 ' : ''}${esc(lc.name)}${tag}${ltBadge}</span>
        <button title="Editar caso (nombre, peso propio, eliminar)" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;line-height:1">✎</button>`;
      row.querySelector('button').addEventListener('click', () => {
        this.app._activeLcId = lc.id;
        this.app._renderLcSelector();   // reflects the active case in the toolbar
        this.app.editCaseDialog();
      });
      box.appendChild(row);
    }
  }

  // ── Combinations tab ───────────────────────────────────────────────────────
  renderCombinations() {
    const container = document.getElementById('combo-list');
    if (!container) return;
    container.innerHTML = '';
    for (const c of this.app.model.combinations.values()) {
      container.appendChild(this._comboCard(c));
    }
  }

  _comboCard(combo) {
    const card = document.createElement('div');
    card.className = 'combo-card';
    card.dataset.id = combo.id;

    const head = document.createElement('div');
    head.className = 'combo-card-head';
    head.innerHTML = `
      <span class="mat-card-id" style="background:rgba(210,153,34,0.2);color:var(--warn)">${combo.id}</span>
      <span style="flex:1;font-size:13px;font-weight:600;color:var(--warn)">${esc(combo.name)}</span>
      <span class="mat-card-chevron">▶</span>`;
    head.addEventListener('click', () => card.classList.toggle('open'));

    const body = document.createElement('div');
    body.className = 'combo-card-body';

    const render = () => {
      body.innerHTML = '';

      // Name field
      body.insertAdjacentHTML('beforeend', `
        <div class="prop-row cols1" style="margin-bottom:8px">
          <div class="prop-field">
            <label>Nombre</label>
            <input type="text" class="combo-name-inp" value="${esc(combo.name)}">
          </div>
        </div>`);
      body.querySelector('.combo-name-inp').addEventListener('change', e => {
        combo.name = e.target.value;
        head.querySelector('span:nth-child(2)').textContent = combo.name;
        this.app.markDirty();
      });

      // Factor rows — includes static load cases AND available spectral results
      const lcs = [...this.app.model.loadCases.values()];
      const specEntries = [...(this.app._spectrumResults?.entries() || [])].map(([key, { params }]) => ({
        id: key,
        name: `[ESP] Dir-${params.direction} ${params.method}`
      }));
      body.insertAdjacentHTML('beforeend',
        '<div class="prop-title" style="margin-bottom:6px">Factores</div>');
      const factorsDiv = document.createElement('div');
      body.appendChild(factorsDiv);

      const renderFactors = () => {
        factorsDiv.innerHTML = '';
        combo.factors.forEach((fac, idx) => {
          const row = document.createElement('div');
          row.className = 'combo-factor-row';
          const staticOpts = lcs.map(lc =>
            `<option value="${lc.id}" ${String(lc.id) === String(fac.lcId) ? 'selected' : ''}>${esc(lc.name)}${lc.selfWeight ? ' ⊕PP' : ''}</option>`
          ).join('');
          const specOpts = specEntries.length
            ? `<optgroup label="── Espectral ──">${specEntries.map(s =>
                `<option value="${s.id}" ${s.id === fac.lcId ? 'selected' : ''}>${esc(s.name)}</option>`
              ).join('')}</optgroup>`
            : '';
          // Self-weight is no longer marked by factor: it's a property of the load
          // case (editable with ✎ next to the case selector).
          row.innerHTML = `
            <select class="fac-lc">${staticOpts}${specOpts}</select>
            <input type="number" class="fac-val" value="${fac.factor}" step="0.1" placeholder="factor">
            <button class="combo-del-factor" title="Eliminar">×</button>`;
          row.querySelector('.fac-lc').addEventListener('change', e => {
            const v = e.target.value;
            combo.factors[idx].lcId = /^\d+$/.test(v) ? parseInt(v) : v;
            this.app.markDirty();
          });
          row.querySelector('.fac-val').addEventListener('change', e => {
            combo.factors[idx].factor = parseFloat(e.target.value) || 0;
            this.app.markDirty();
          });
          row.querySelector('.combo-del-factor').addEventListener('click', () => {
            combo.factors.splice(idx, 1);
            renderFactors();
            this.app.markDirty();
          });
          factorsDiv.appendChild(row);
        });
      };
      renderFactors();

      // Add factor button
      const addBtn = document.createElement('button');
      addBtn.className = 'btn-add';
      addBtn.style.marginTop = '4px';
      addBtn.textContent = '＋ Agregar Factor';
      addBtn.addEventListener('click', () => {
        const firstId = lcs[0] ? lcs[0].id : (specEntries[0] ? specEntries[0].id : null);
        combo.factors.push({ lcId: firstId, factor: 1.0 });
        renderFactors();
        this.app.markDirty();
      });
      body.appendChild(addBtn);

      // Run + Delete buttons
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      actions.style.marginTop = '10px';
      actions.innerHTML = `
        <button class="combo-run-btn" style="flex:1">▶ Ejecutar</button>
        <button class="btn-danger" style="flex:1">Eliminar</button>`;
      actions.querySelector('.combo-run-btn').addEventListener('click', () => {
        this.app.runCombination(combo.id);
      });
      actions.querySelector('.btn-danger').addEventListener('click', () => {
        this.app.snapshot();
        this.app.model.removeCombination(combo.id);
        this.app.markDirty();
        this.renderCombinations();
        this.app._renderLcSelector();
      });
      body.appendChild(actions);
    };

    render();
    card.appendChild(head);
    card.appendChild(body);
    return card;
  }

  _addCombination() {
    this.app.snapshot();
    this.app.model.addCombination({ name: `Combo ${this.app.model.combinations.size + 1}` });
    this.app.markDirty();
    this.renderCombinations();
    this.app._renderLcSelector();
  }

  // ── Sections tab ───────────────────────────────────────────────────────────
  renderSections() {
    const container = document.getElementById('sec-list');
    container.innerHTML = '';
    for (const sec of this.app.model.sections.values()) {
      container.appendChild(this._secCard(sec));
    }
  }

  _secCard(sec) {
    const card = document.createElement('div');
    card.className = 'sec-card';
    card.dataset.id = sec.id;

    const fld = (label, key, step = '0.0001') =>
      `<div class="prop-field"><label>${label}</label><input type="number" data-f="${key}" value="${sec[key]}" step="${step}"></div>`;

    card.innerHTML = `
      <div class="sec-card-head">
        <span class="sec-card-id">${sec.id}</span>
        <span class="sec-card-name">${esc(sec.name)}</span>
        <span class="sec-card-chevron">▶</span>
      </div>
      <div class="sec-card-body">
        <div class="prop-row cols1">
          <div class="prop-field"><label>Nombre</label><input type="text" data-f="name" value="${esc(sec.name)}"></div>
        </div>
        <div class="prop-row cols1">
          <div class="prop-field"><label title="Clasifica la sección para el diseño: permite recorrer y diseñar sólo los pilares (o sólo las vigas). «Genérico» = sin filtrar.">Tipo de elemento (diseño)</label>
            <select data-f="role">
              <option value="generico" ${(sec.role || 'generico') === 'generico' ? 'selected' : ''}>Genérico</option>
              <option value="pilar" ${sec.role === 'pilar' ? 'selected' : ''}>🟦 Pilar / columna</option>
              <option value="viga" ${sec.role === 'viga' ? 'selected' : ''}>🟩 Viga</option>
            </select></div>
        </div>
        <div class="prop-row">
          ${fld('A (m²)', 'A')}
          ${fld('J (m⁴)', 'J')}
        </div>
        <div class="prop-row">
          ${fld('Iz (m⁴)', 'Iz')}
          ${fld('Iy (m⁴)', 'Iy')}
        </div>
        <div class="prop-row">
          ${fld('Avy (m²)', 'Avy')}
          ${fld('Avz (m²)', 'Avz')}
        </div>
        <div class="prop-row">
          ${fld('κy', 'kappay', '0.001')}
          ${fld('κz', 'kappaz', '0.001')}
        </div>
        <div class="prop-field" style="margin-top:6px"><label style="color:var(--text-muted);font-size:11px">Modificadores de rigidez (× A, I, J — p.ej. sección agrietada ACI)</label></div>
        <div class="prop-row">
          <div class="prop-field"><label>×A</label><input type="number" data-m="A" value="${sec.mod?.A ?? 1}" step="0.05" min="0.01"></div>
          <div class="prop-field"><label>×J</label><input type="number" data-m="J" value="${sec.mod?.J ?? 1}" step="0.05" min="0.01"></div>
        </div>
        <div class="prop-row">
          <div class="prop-field"><label>×Iz</label><input type="number" data-m="Iz" value="${sec.mod?.Iz ?? 1}" step="0.05" min="0.01"></div>
          <div class="prop-field"><label>×Iy</label><input type="number" data-m="Iy" value="${sec.mod?.Iy ?? 1}" step="0.05" min="0.01"></div>
        </div>
        ${this._secDesignHTML(sec)}
        <div class="card-actions">
          <button class="btn-danger btn-del-sec" style="flex:1;">Eliminar</button>
        </div>
      </div>
    `;
    card.querySelector('.sec-card-head').addEventListener('click', () => {
      card.classList.toggle('open');
    });
    card.querySelectorAll('[data-f]').forEach(inp => {
      inp.addEventListener('change', () => {
        this.app.snapshot();
        const updates = {};
        card.querySelectorAll('[data-f]').forEach(i => {
          updates[i.dataset.f] = i.type === 'number' ? +i.value : i.value;
        });
        this.app.model.updateSection(sec.id, updates);
        card.querySelector('.sec-card-name').textContent = updates.name || sec.name;
        this.app.markDirty();
      });
    });
    // Stiffness modifiers (data-m): update sec.mod
    card.querySelectorAll('[data-m]').forEach(inp => {
      inp.addEventListener('change', () => {
        this.app.snapshot();
        const mod = {};
        card.querySelectorAll('[data-m]').forEach(i => { mod[i.dataset.m] = +i.value || 1; });
        this.app.model.updateSection(sec.id, { mod });
        this.app.markDirty();
        this.app.toast('Modificador de sección aplicado — recalcule el análisis (F5)', 'ok');
      });
    });
    card.querySelector('.btn-del-sec').addEventListener('click', () => {
      const res = this.app.model.removeSection(sec.id);
      if (res.ok === false) { this.app.toast(res.reason, 'warn'); return; }
      this.app.markDirty();
      this.renderSections();
    });
    this._bindSecDesign(card, sec);
    return card;
  }

  // Dimensions by shape (mm in the UI, meters internally) for the section card.
  _secDimHTML(shape, d = {}) {
    // Dimensions are entered in mm (engineering convention) but stored internally
    // in meters. m→mm here on display; mm→m on save (see _bindSecDesign.saveDesign).
    const mm = v => (v === undefined || v === null || v === '') ? '' : +(v * 1000).toFixed(4);
    const f = (k, lbl) => `<div class="prop-field"><label>${lbl} (mm)</label><input type="number" data-sd="${k}" value="${mm(d[k])}" step="1"></div>`;
    if (shape === 'I')      return `<div class="prop-row">${f('d', 'd canto')}${f('bf', 'bf ala')}</div><div class="prop-row">${f('tf', 'tf ala')}${f('tw', 'tw alma')}</div>`;
    if (shape === 'rect')   return `<div class="prop-row">${f('b', 'b ancho')}${f('h', 'h canto')}</div>`;
    if (shape === 'circle') return `<div class="prop-row">${f('D', 'D diámetro')}</div>`;
    if (shape === 'pipe')   return `<div class="prop-row">${f('D', 'D exterior')}${f('t', 't espesor')}</div>`;
    if (shape === 'box')    return `<div class="prop-row">${f('b', 'b ancho')}${f('h', 'h canto')}</div><div class="prop-row">${f('t', 't espesor')}</div>`;
    if (shape === 'channel') return `<div class="prop-row">${f('d', 'd canto')}${f('bf', 'bf ala')}</div><div class="prop-row">${f('tf', 'tf ala')}${f('tw', 'tw alma')}</div>`;
    if (shape === 'angle')  return `<div class="prop-row">${f('d', 'd ala vert.')}${f('b', 'b ala horiz.')}</div><div class="prop-row">${f('t', 't espesor')}</div>`;
    if (shape === 'tee')    return `<div class="prop-row">${f('d', 'd canto')}${f('bf', 'bf ala')}</div><div class="prop-row">${f('tf', 'tf ala')}${f('tw', 'tw alma')}</div>`;
    if (shape === 'polygon') {
      const pts = a => (a || []).map(p => `${mm(p[0])}, ${mm(p[1])}`).join('\n');
      const holes = (d.holes || []).map(h => pts(h)).join('\n\n');
      return `<div class="prop-row cols1"><div class="prop-field"><label>Vértices del contorno «x, y» por línea (mm)</label>
          <textarea data-sd-poly="outline" rows="5" style="width:100%;font-family:var(--font-mono);font-size:11px" placeholder="0, 0\n300, 0\n300, 500\n0, 500">${pts(d.outline)}</textarea></div></div>
        <div class="prop-row cols1"><div class="prop-field">
          <label style="display:flex;justify-content:space-between;align-items:center">Editor gráfico del contorno
            <span style="font-size:9px;color:var(--text-muted)">clic = agregar · arrastrar = mover · doble clic = borrar</span></label>
          <div data-sd-poly-editor style="border:1px solid var(--border,#334);border-radius:6px;background:var(--bg3,#0b1220);touch-action:none"></div></div></div>
        <div class="prop-row cols1"><div class="prop-field"><label>Huecos (lazos separados por línea en blanco, opcional)</label>
          <textarea data-sd-poly="holes" rows="3" style="width:100%;font-family:var(--font-mono);font-size:11px">${holes}</textarea></div></div>
        <p class="panel-hint" style="font-size:10px">Calcula A, Iz, Iy, Iyz, ejes principales, S y Z plástico. Pulse «Calcular A, I, J».</p>`;
    }
    return `<p class="panel-hint">Genérica: el diseño usa un rectángulo equivalente a partir de A, I.</p>`;
  }

  _secDesignHTML(sec) {
    const sh = sec.design?.shape || 'generic';
    const opt = (v, l) => `<option value="${v}" ${sh === v ? 'selected' : ''}>${l}</option>`;
    const reb = sec.design?.rebar || {};
    return `
      <div class="prop-section" style="margin-top:6px">
        <div class="prop-title" title="Forma del perfil para el diseño: deriva módulos plásticos, esbelteces, etc. Ver docs/design.md.">Forma (diseño)</div>
        <div class="prop-row cols1">
          <div class="prop-field"><label>Perfil tabulado (catálogo)</label>
            <select class="sd-catalog"><option value="">— elegir perfil comercial —</option></select></div>
        </div>
        <div class="prop-row cols1">
          <div class="prop-field"><label>Forma</label>
            <select class="sd-shape">
              ${opt('generic', 'Genérica (A, I)')}${opt('I', 'Doble T (I)')}${opt('rect', 'Rectángulo macizo')}${opt('circle', 'Círculo macizo')}${opt('pipe', 'Tubo circular')}${opt('box', 'Tubo rectangular')}${opt('channel', 'Canal (C/U)')}${opt('angle', 'Angular (L)')}${opt('tee', 'Tee (T)')}${opt('polygon', 'Polígono libre / con huecos')}
            </select></div>
        </div>
        <div class="sd-dims">${this._secDimHTML(sh, sec.design || {})}</div>
        <div class="prop-row">
          <div class="prop-field"><label>ρ armadura (H.A.)</label><input type="number" data-rb="rho" value="${reb.rho ?? ''}" step="0.002" title="Cuantía longitudinal (fallback si no se dan barras explícitas)"></div>
          <div class="prop-field"><label>recubr. (mm)</label><input type="number" data-rb="cover_mm" value="${reb.cover_mm ?? ''}" step="5"></div>
        </div>
        <div class="prop-row" title="Barras longitudinales explícitas para el diagrama P-M (#70). Tienen prioridad sobre ρ.">
          <div class="prop-field"><label>n sup.</label><input type="number" data-rb="nTop" value="${reb.nTop ?? ''}" step="1" min="0"></div>
          <div class="prop-field"><label>n inf.</label><input type="number" data-rb="nBot" value="${reb.nBot ?? ''}" step="1" min="0"></div>
          <div class="prop-field"><label>φ barra (mm)</label><input type="number" data-rb="dia_mm" value="${reb.dia_mm ?? ''}" step="2"></div>
        </div>
        <div class="prop-row" title="Estribos para el shear: φVn = φ(Vc+Vs), Vs=Av·fy·d/s (#70).">
          <div class="prop-field"><label>estribo φ (mm)</label><input type="number" data-rb="estribo_dia_mm" value="${reb.estribo_dia_mm ?? ''}" step="2"></div>
          <div class="prop-field"><label>sep. s (mm)</label><input type="number" data-rb="estribo_s_mm" value="${reb.estribo_s_mm ?? ''}" step="10"></div>
        </div>
        <button class="btn-secondary sd-calc" style="width:100%;font-size:11px;margin-top:4px" title="Calcula A, Iz, Iy, J, Av desde las dimensiones y los escribe en la sección (para el análisis y el diseño).">↻ Calcular A, I, J desde la forma</button>
      </div>`;
  }

  _bindSecDesign(card, sec) {
    const shapeSel = card.querySelector('.sd-shape');
    const dimsBox = card.querySelector('.sd-dims');
    if (!shapeSel) return;
    // Catalog of tabulated profiles (#66): populate and apply on selection.
    const catSel = card.querySelector('.sd-catalog');
    if (catSel) import('../design/profiles.js?v=7').then(({ catalogFamilies, catalogNames, profileToSection }) => {
      let html = '<option value="">— elegir perfil comercial —</option>';
      for (const fam of catalogFamilies()) html += `<optgroup label="${fam}">` + catalogNames(fam).map(n => `<option value="${n}" ${sec.design?.profile === n ? 'selected' : ''}>${n}</option>`).join('') + '</optgroup>';
      catSel.innerHTML = html;
      catSel.addEventListener('change', () => {
        const name = catSel.value; if (!name) return;
        const props = profileToSection(name); if (!props) { this.app.toast('Perfil no encontrado', 'warn'); return; }
        this.app.snapshot();
        this.app.model.updateSection(sec.id, props);
        this.app.markDirty();
        this.renderSections();
        this.app.toast(`Perfil ${name} aplicado (A, I, J y forma). Recalcule el análisis (F5).`, 'ok');
      });
    }).catch(() => {});
    const saveDesign = () => {
      const shape = shapeSel.value;
      const design = { ...(sec.design || {}) };
      design.shape = shape;
      // Inputs are in mm; store internally in meters (mm→m).
      dimsBox.querySelectorAll('[data-sd]').forEach(i => { const v = parseFloat(i.value); if (i.value !== '' && !isNaN(v)) design[i.dataset.sd] = v / 1000; });
      // Free polygon / with holes: parses the vertices (mm) from the textareas → m.
      if (shape === 'polygon') {
        const parsePts = txt => txt.split(/\n/).map(l => l.trim()).filter(Boolean)
          .map(l => l.split(/[,\s]+/).map(Number)).filter(p => p.length >= 2 && p.slice(0, 2).every(Number.isFinite)).map(p => [p[0] / 1000, p[1] / 1000]);
        const outEl = dimsBox.querySelector('[data-sd-poly="outline"]');
        const holEl = dimsBox.querySelector('[data-sd-poly="holes"]');
        if (outEl) design.outline = parsePts(outEl.value);
        if (holEl) design.holes = holEl.value.split(/\n\s*\n/).map(blk => parsePts(blk)).filter(h => h.length >= 3);
      }
      const reb = { ...(design.rebar || {}) };
      card.querySelectorAll('[data-rb]').forEach(i => { const v = parseFloat(i.value); if (i.value !== '' && !isNaN(v)) reb[i.dataset.rb] = v; });
      if (Object.keys(reb).length) design.rebar = reb;
      this.app.snapshot();
      this.app.model.updateSection(sec.id, { design });
      this.app.markDirty();
    };
    shapeSel.addEventListener('change', () => {
      dimsBox.innerHTML = this._secDimHTML(shapeSel.value, sec.design || {});
      dimsBox.querySelectorAll('[data-sd]').forEach(i => i.addEventListener('change', saveDesign));
      dimsBox.querySelectorAll('[data-sd-poly]').forEach(i => i.addEventListener('change', saveDesign));
      this._bindPolyEditor(dimsBox, saveDesign);
      saveDesign();
    });
    dimsBox.querySelectorAll('[data-sd]').forEach(i => i.addEventListener('change', saveDesign));
    dimsBox.querySelectorAll('[data-sd-poly]').forEach(i => i.addEventListener('change', saveDesign));
    this._bindPolyEditor(dimsBox, saveDesign);
    card.querySelectorAll('[data-rb]').forEach(i => i.addEventListener('change', saveDesign));
    card.querySelector('.sd-calc')?.addEventListener('click', async () => {
      saveDesign();
      const s = this.app.model.sections.get(sec.id);
      if (!s.design?.shape || s.design.shape === 'generic') { this.app.toast('Elija una forma con dimensiones primero', 'warn'); return; }
      try {
        const { fromShape } = await import('../design/section_props.js?v=7');
        const g = fromShape(s.design.shape, s.design);
        if (!g) { this.app.toast('Faltan dimensiones de la forma', 'warn'); return; }
        this.app.snapshot();
        this.app.model.updateSection(sec.id, { A: g.A, Iz: g.Iz, Iy: g.Iy, J: g.J, Avy: g.Avz_web, Avz: g.Avy_flange });
        this.app.markDirty();
        this.renderSections();
        this.app.toast(`A, I, J calculados desde la forma ${s.design.shape}. Recalcule el análisis (F5).`, 'ok');
      } catch (e) { this.app.toast('No se pudo calcular: ' + e.message, 'warn'); }
    });
  }

  // ── Graphic polygon-vertex editor (#70) ─────────────────────────────────────
  // Interactive SVG synced with the «outline» textarea: click = add vertex (on the
  // nearest side), drag a vertex = move it, double-click = delete it.
  // Each edit rewrites the textarea and calls saveDesign() (which parses and saves).
  _bindPolyEditor(dimsBox, saveDesign) {
    const host = dimsBox.querySelector('[data-sd-poly-editor]');
    const ta = dimsBox.querySelector('[data-sd-poly="outline"]');
    if (!host || !ta) return;
    const W = 248, H = 180, m = 18, r4 = v => Math.round(v * 1e4) / 1e4;
    const parse = () => ta.value.split(/\n/).map(l => l.trim()).filter(Boolean)
      .map(l => l.split(/[,\s]+/).map(Number)).filter(p => p.length >= 2 && isFinite(p[0]) && isFinite(p[1])).map(p => [p[0], p[1]]);
    let pts = parse();
    const writeBack = () => { ta.value = pts.map(p => `${r4(p[0])}, ${r4(p[1])}`).join('\n'); saveDesign(); };
    // Transform model↔px (fixed during a drag; recomputed on re-render).
    let tf = null;
    const calcTf = () => {
      if (!pts.length) { tf = { ox: 0, oy: 0, s: 1 }; return; }
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const dx = x1 - x0 || 1, dy = y1 - y0 || 1;
      const s = Math.min((W - 2 * m) / dx, (H - 2 * m) / dy);
      tf = { x0, y0, s, cx: (W - dx * s) / 2, cy: (H - dy * s) / 2 };
    };
    const toPx = ([x, y]) => [tf.cx + (x - tf.x0) * tf.s, H - tf.cy - (y - tf.y0) * tf.s];
    const toMd = (px, py) => [tf.x0 + (px - tf.cx) / tf.s, tf.y0 + (H - tf.cy - py) / tf.s];
    const svgPt = (e) => { const rc = host.firstChild.getBoundingClientRect(); if (!(rc.width > 0 && rc.height > 0)) return null; return [(e.clientX - rc.left) * W / rc.width, (e.clientY - rc.top) * H / rc.height]; };
    const render = () => {
      calcTf();
      const pp = pts.map(toPx);
      const poly = pp.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      const dots = pp.map((p, i) => `<circle data-i="${i}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="5" fill="var(--accent,#38bdf8)" stroke="#fff" stroke-width="1" style="cursor:grab"/>`).join('');
      host.innerHTML = `<svg width="100%" viewBox="0 0 ${W} ${H}" style="display:block">
        ${pts.length >= 2 ? `<polygon points="${poly}" fill="rgba(56,189,248,.14)" stroke="var(--accent,#38bdf8)" stroke-width="1.3"/>` : ''}
        ${dots}
        ${pts.length === 0 ? `<text x="${W/2}" y="${H/2}" fill="var(--text-muted,#94a3b8)" font-size="11" text-anchor="middle">clic para agregar vértices</text>` : ''}
      </svg>`;
    };
    let drag = null, moved = false;
    host.addEventListener('pointerdown', (e) => {
      const t = e.target;
      if (t.tagName === 'circle') {                 // drag vertex
        drag = +t.dataset.i; moved = false; t.setPointerCapture?.(e.pointerId); t.style.cursor = 'grabbing'; e.preventDefault();
      }
    });
    host.addEventListener('pointermove', (e) => {
      if (drag == null) return;
      const sp = svgPt(e); if (!sp) return;
      moved = true;
      pts[drag] = toMd(sp[0], sp[1]).map(r4);
      const c = host.querySelector(`circle[data-i="${drag}"]`);
      const [cx, cy] = toPx(pts[drag]); if (c) { c.setAttribute('cx', cx.toFixed(1)); c.setAttribute('cy', cy.toFixed(1)); }
      const polel = host.querySelector('polygon'); if (polel) polel.setAttribute('points', pts.map(p => { const q = toPx(p); return `${q[0].toFixed(1)},${q[1].toFixed(1)}`; }).join(' '));
    });
    host.addEventListener('pointerup', () => { if (drag != null) { writeBack(); render(); drag = null; } });
    host.addEventListener('click', (e) => {
      if (drag != null || moved) { moved = false; return; }
      if (e.target.tagName === 'circle') return;     // (deletion is via dblclick)
      const sp = svgPt(e); if (!sp) return;
      const [px, py] = sp; const np = toMd(px, py).map(r4);
      if (!isFinite(np[0]) || !isFinite(np[1])) return;
      // insert on the nearest side (or at the end if there are <2 points)
      if (pts.length < 2) { pts.push(np); }
      else {
        let bi = pts.length, bd = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const a = toPx(pts[i]), b = toPx(pts[(i + 1) % pts.length]);
          const d = this._distSeg([px, py], a, b);
          if (d < bd) { bd = d; bi = i + 1; }
        }
        pts.splice(bi, 0, np);
      }
      writeBack(); render();
    });
    host.addEventListener('dblclick', (e) => {
      if (e.target.tagName !== 'circle') return;
      if (pts.length <= 3) { this.app.toast('El polígono necesita al menos 3 vértices', 'warn'); return; }
      pts.splice(+e.target.dataset.i, 1); writeBack(); render();
    });
    // Keep the editor in sync if the user edits the textarea by hand.
    ta.addEventListener('input', () => { pts = parse(); render(); });
    render();
  }

  // Distance from a point P to segment AB (in px), to insert a vertex on the correct side.
  _distSeg(p, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1], wx = p[0] - a[0], wy = p[1] - a[1];
    const c1 = vx * wx + vy * wy, c2 = vx * vx + vy * vy;
    const t = c2 > 1e-9 ? Math.max(0, Math.min(1, c1 / c2)) : 0;
    return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
  }

  // ── P3-9: Section calculator dialog ───────────────────────────────────────
  _sectionCalculatorDialog() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Calculadora de Sección';
    document.getElementById('modal-cancel').style.display = '';

    // Standard section database (values in SI: A [m²], Iz/Iy [m⁴], J [m⁴])
    const IPE = {
      'IPE100':{A:10.3e-4,Iz:171e-8,  Iy:15.9e-8, J:1.20e-8},
      'IPE120':{A:13.2e-4,Iz:318e-8,  Iy:27.7e-8, J:1.74e-8},
      'IPE140':{A:16.4e-4,Iz:541e-8,  Iy:44.9e-8, J:2.45e-8},
      'IPE160':{A:20.1e-4,Iz:869e-8,  Iy:68.3e-8, J:3.60e-8},
      'IPE180':{A:23.9e-4,Iz:1317e-8, Iy:100.9e-8,J:4.79e-8},
      'IPE200':{A:28.5e-4,Iz:1943e-8, Iy:142e-8,  J:6.98e-8},
      'IPE220':{A:33.4e-4,Iz:2772e-8, Iy:205e-8,  J:9.07e-8},
      'IPE240':{A:39.1e-4,Iz:3892e-8, Iy:284e-8,  J:12.7e-8},
      'IPE270':{A:45.9e-4,Iz:5790e-8, Iy:420e-8,  J:15.9e-8},
      'IPE300':{A:53.8e-4,Iz:8356e-8, Iy:604e-8,  J:20.1e-8},
      'IPE330':{A:62.6e-4,Iz:11770e-8,Iy:788e-8,  J:28.2e-8},
      'IPE360':{A:72.7e-4,Iz:16270e-8,Iy:1043e-8, J:37.3e-8},
      'IPE400':{A:84.5e-4,Iz:23130e-8,Iy:1318e-8, J:51.1e-8},
      'IPE450':{A:98.8e-4,Iz:33740e-8,Iy:1676e-8, J:66.9e-8},
      'IPE500':{A:116e-4, Iz:48200e-8,Iy:2142e-8, J:89.3e-8},
    };
    const HEB = {
      'HEB100':{A:26.0e-4,Iz:450e-8,  Iy:167e-8,  J:9.25e-8},
      'HEB120':{A:34.0e-4,Iz:864e-8,  Iy:318e-8,  J:13.8e-8},
      'HEB140':{A:43.0e-4,Iz:1509e-8, Iy:550e-8,  J:20.1e-8},
      'HEB160':{A:54.3e-4,Iz:2492e-8, Iy:889e-8,  J:31.2e-8},
      'HEB180':{A:65.3e-4,Iz:3831e-8, Iy:1363e-8, J:42.2e-8},
      'HEB200':{A:78.1e-4,Iz:5696e-8, Iy:2003e-8, J:59.3e-8},
      'HEB220':{A:91.0e-4,Iz:8091e-8, Iy:2843e-8, J:76.6e-8},
      'HEB240':{A:106e-4, Iz:11260e-8,Iy:3923e-8, J:102e-8},
      'HEB260':{A:118e-4, Iz:14920e-8,Iy:5135e-8, J:124e-8},
      'HEB280':{A:131e-4, Iz:19270e-8,Iy:6595e-8, J:144e-8},
      'HEB300':{A:149e-4, Iz:25170e-8,Iy:8563e-8, J:185e-8},
    };

    const ipeOpts = Object.keys(IPE).map(k=>`<option value="${k}">${k}</option>`).join('');
    const hebOpts = Object.keys(HEB).map(k=>`<option value="${k}">${k}</option>`).join('');

    document.getElementById('modal-body').innerHTML = `
      <div class="prop-row cols1" style="margin-bottom:8px">
        <div class="prop-field">
          <label>Forma de sección</label>
          <select id="sc-shape">
            <option value="rect">Rectangular (b × h)</option>
            <option value="circ">Circular sólida (D)</option>
            <option value="hrect">Rectangular hueca</option>
            <option value="hcirc">Tubular circular</option>
            <option value="ipe">Perfil IPE (tabla)</option>
            <option value="heb">Perfil HEB (tabla)</option>
          </select>
        </div>
      </div>
      <div id="sc-inputs" style="margin-bottom:8px"></div>
      <div id="sc-results" style="background:rgba(255,255,255,0.03);padding:8px;
          border-radius:4px;font-size:11px;font-family:monospace;color:var(--text)">
        — Selecciona una forma —
      </div>`;

    overlay.classList.remove('hidden');

    const shapeEl   = document.getElementById('sc-shape');
    const inputsEl  = document.getElementById('sc-inputs');
    const resEl     = document.getElementById('sc-results');
    let   lastData  = null;

    const shapes = {
      rect: `
        <div class="prop-row">
          <div class="prop-field"><label>b (mm)</label>
            <input type="number" id="sc-b" value="300" step="10" min="1"></div>
          <div class="prop-field"><label>h (mm)</label>
            <input type="number" id="sc-h" value="500" step="10" min="1"></div>
        </div>`,
      circ: `
        <div class="prop-row cols1">
          <div class="prop-field"><label>D (mm)</label>
            <input type="number" id="sc-D" value="400" step="10" min="1"></div>
        </div>`,
      hrect: `
        <div class="prop-row">
          <div class="prop-field"><label>b (mm)</label>
            <input type="number" id="sc-b" value="400" step="10" min="10"></div>
          <div class="prop-field"><label>h (mm)</label>
            <input type="number" id="sc-h" value="600" step="10" min="10"></div>
          <div class="prop-field"><label>t espesor (mm)</label>
            <input type="number" id="sc-t" value="60" step="5" min="1"></div>
        </div>`,
      hcirc: `
        <div class="prop-row">
          <div class="prop-field"><label>D ext (mm)</label>
            <input type="number" id="sc-D" value="400" step="10" min="10"></div>
          <div class="prop-field"><label>t espesor (mm)</label>
            <input type="number" id="sc-t" value="20" step="5" min="1"></div>
        </div>`,
      ipe:  `<div class="prop-field"><label>Perfil IPE</label>
               <select id="sc-ipe">${ipeOpts}</select></div>`,
      heb:  `<div class="prop-field"><label>Perfil HEB</label>
               <select id="sc-heb">${hebOpts}</select></div>`,
    };

    const g = id => parseFloat(document.getElementById(id)?.value) || 0;
    const gm = id => g(id) / 1000;   // length inputs are in mm → meters
    const kappa = 5 / 6;

    const calc = () => {
      const shape = shapeEl.value;
      let A, Iz, Iy, J, Avy, Avz, name;

      if (shape === 'rect') {
        const b = gm('sc-b'), h = gm('sc-h');
        A = b * h; Iz = b * h ** 3 / 12; Iy = h * b ** 3 / 12;
        // St. Venant torsion constant (Roark series, a=long side, t=short side):
        // J = a·t³·[1/3 − 0.21·(t/a)·(1 − (t/a)⁴/12)]  (≈0.1406·a⁴ for a square)
        { const a = Math.max(b, h), t = Math.min(b, h), r = t / a;
          J = a * t ** 3 * (1 / 3 - 0.21 * r * (1 - r ** 4 / 12)); }
        Avy = kappa * b * h; Avz = kappa * b * h;
        name = `Rect ${(b*100).toFixed(0)}×${(h*100).toFixed(0)}cm`;
      } else if (shape === 'circ') {
        const r = gm('sc-D') / 2;
        A = Math.PI * r ** 2; Iz = Iy = Math.PI * r ** 4 / 4;
        J = Math.PI * r ** 4 / 2; Avy = Avz = 0.9 * A;
        name = `Circ Ø${(r*200).toFixed(0)}cm`;
      } else if (shape === 'hrect') {
        const b = gm('sc-b'), h = gm('sc-h'), t = gm('sc-t');
        const bi = b-2*t, hi = h-2*t;
        A = b*h - bi*hi; Iz = (b*h**3 - bi*hi**3)/12; Iy = (h*b**3 - hi*bi**3)/12;
        J = 2*t*(b-t)**2*(h-t)**2/(b+h-2*t);
        Avy = Avz = 2*h*t;
        name = `Rect ${(b*100).toFixed(0)}×${(h*100).toFixed(0)}×${(t*100).toFixed(1)}cm`;
      } else if (shape === 'hcirc') {
        const D = gm('sc-D'), t = gm('sc-t'), ro = D/2, ri = D/2 - t;
        A = Math.PI*(ro**2 - ri**2); Iz = Iy = Math.PI*(ro**4 - ri**4)/4;
        J = Math.PI*(ro**4 - ri**4)/2; Avy = Avz = A * 0.5;
        name = `Tubo Ø${(D*100).toFixed(0)}×${(t*100).toFixed(1)}cm`;
      } else if (shape === 'ipe') {
        const p = document.getElementById('sc-ipe')?.value || 'IPE200';
        const d = IPE[p]; if (!d) return;
        ({A,Iz,Iy,J} = d); Avy = Avz = A * 0.5; name = p;
      } else if (shape === 'heb') {
        const p = document.getElementById('sc-heb')?.value || 'HEB200';
        const d = HEB[p]; if (!d) return;
        ({A,Iz,Iy,J} = d); Avy = Avz = A * 0.5; name = p;
      }

      if (!A || A <= 0) { resEl.innerHTML = '<span style="color:var(--warn)">⚠ Dimensiones inválidas</span>'; return; }
      lastData = { name, A, Iz, Iy, J, Avy: Avy||kappa*A, Avz: Avz||kappa*A, kappay: kappa, kappaz: kappa };

      resEl.innerHTML = `<table style="width:100%;border-collapse:collapse">
        ${[
          ['Nombre', `<b>${name}</b>`],
          ['A  (m²)', A.toExponential(4)],
          ['Iz (m⁴)', Iz.toExponential(4)],
          ['Iy (m⁴)', Iy.toExponential(4)],
          ['J  (m⁴)', J.toExponential(4)],
          ['Avy (m²)', (Avy||kappa*A).toExponential(4)],
          ['Avz (m²)', (Avz||kappa*A).toExponential(4)],
        ].map(([l,v]) =>
          `<tr><td style="color:var(--text-muted);padding:2px 8px 2px 0">${l}</td>
               <td>${v}</td></tr>`
        ).join('')}
      </table>`;
    };

    const rebind = () => {
      inputsEl.querySelectorAll('input,select').forEach(el => el.addEventListener('input', calc));
      calc();
    };

    inputsEl.innerHTML = shapes[shapeEl.value] || '';
    rebind();
    shapeEl.addEventListener('change', () => {
      inputsEl.innerHTML = shapes[shapeEl.value] || '';
      rebind();
    });

    overlay._resolve = () => {
      if (!lastData) return;
      this.app.snapshot();
      this.app.model.addSection(lastData);
      this.app.markDirty();
      this.renderSections();
      this._switchTab('sec');
      this.app.toast(`Sección "${lastData.name}" creada`, 'ok');
    };
    overlay._reject = () => {};
  }

  _addSection() {
    this.app.snapshot();
    this.app.model.addSection({ name: 'Nueva Sección' });
    this.app.markDirty();
    this.renderSections();
  }

  // ── Results tabs ───────────────────────────────────────────────────────────
  renderResults() {
    this.renderModalResults();
    this.renderStaticResults();
  }

  renderModalResults() {
    const body = document.getElementById('res-modal-body');
    const hint = document.getElementById('res-modal-hint');
    if (!body) return;
    const modal = this.app._modalResults;
    if (!modal) {
      body.innerHTML = '';
      if (hint) hint.style.display = '';
      return;
    }
    if (hint) hint.style.display = 'none';
    body.innerHTML = '';

    body.insertAdjacentHTML('beforeend', '<div class="res-section-title">Participación de masas (%)</div>');
    const th = '<tr><th>M.</th><th>f(Hz)</th><th>T(s)</th>' +
               '<th>%X</th><th>%Y</th><th>%Rz</th>' +
               '<th>ΣX%</th><th>ΣY%</th><th>ΣRz%</th></tr>';
    let rows = '';
    const { rows: prows } = modal.getParticipation();
    for (const r of prows) {
      const okX = r.cumPct[0] >= 90, okY = r.cumPct[1] >= 90, okRz = r.cumPct[2] >= 90;
      const cx  = okX  ? 'cum-ok' : r.cumPct[0] > 60 ? 'cum-warn' : '';
      const cy  = okY  ? 'cum-ok' : r.cumPct[1] > 60 ? 'cum-warn' : '';
      const crz = okRz ? 'cum-ok' : r.cumPct[2] > 60 ? 'cum-warn' : '';
      rows += `<tr>
        <td>${r.mode}</td>
        <td>${r.freq.toFixed(3)}</td>
        <td>${r.period.toFixed(3)}</td>
        <td>${r.pct[0].toFixed(1)}</td>
        <td>${r.pct[1].toFixed(1)}</td>
        <td>${r.pct[2].toFixed(1)}</td>
        <td class="${cx}">${r.cumPct[0].toFixed(1)}</td>
        <td class="${cy}">${r.cumPct[1].toFixed(1)}</td>
        <td class="${crz}">${r.cumPct[2].toFixed(1)}</td>
      </tr>`;
    }
    body.insertAdjacentHTML('beforeend',
      `<table class="res-table"><thead>${th}</thead><tbody>${rows}</tbody></table>`);
  }

  renderStaticResults() {
    const body = document.getElementById('res-static-body');
    const hint = document.getElementById('res-static-hint');
    if (!body) return;
    const res = this.app._results;
    if (!res) {
      body.innerHTML = '';
      if (hint) hint.style.display = '';
      return;
    }
    if (hint) hint.style.display = 'none';
    body.innerHTML = '';

    // Show spectral header when result is a SpectrumResults (has .meta)
    const meta = res.meta;
    if (meta) {
      body.insertAdjacentHTML('beforeend',
        `<div class="res-section-title" style="color:var(--accent);margin-bottom:6px">
          Espectro Dir-${meta.direction} | ${meta.method} | ζ=${(meta.zeta * 100).toFixed(0)}% | ${meta.nModes} modos
        </div>`);
    }

    const fv = v => {
      if (v == null || !isFinite(v)) return '<td>—</td>';
      const a = Math.abs(v);
      const cls = a < 1e-10 ? '' : v > 0 ? ' vp' : ' vn';
      return `<td class="${cls.trim()}">${a < 1e-10 ? '—' : v.toExponential(3)}</td>`;
    };

    body.insertAdjacentHTML('beforeend', '<div class="res-section-title">Fuerzas en Elementos</div>');
    const thE = '<tr><th>El.</th><th>N</th><th>Vy</th><th>Vz</th><th>T</th><th>My</th><th>Mz</th></tr>';
    let rowsE = '';
    for (const elem of this.app.model.elements.values()) {
      const f = res.getElemForces(elem.id);
      if (!f) continue;
      const Vy = Math.abs(f.Vy1) > Math.abs(f.Vy2) ? f.Vy1 : f.Vy2;
      const Vz = Math.abs(f.Vz1) > Math.abs(f.Vz2) ? f.Vz1 : f.Vz2;
      const My = Math.abs(f.My1) > Math.abs(f.My2) ? f.My1 : f.My2;
      const Mz = Math.abs(f.Mz1) > Math.abs(f.Mz2) ? f.Mz1 : f.Mz2;
      rowsE += `<tr><td>${elem.id}</td>${fv(f.N)}${fv(Vy)}${fv(Vz)}${fv(f.T)}${fv(My)}${fv(Mz)}</tr>`;
    }
    body.insertAdjacentHTML('beforeend',
      `<table class="res-table"><thead>${thE}</thead><tbody>${rowsE}</tbody></table>`);

    body.insertAdjacentHTML('beforeend', '<div class="res-section-title">Desplazamientos Nodales</div>');
    const thN = '<tr><th>Nd.</th><th>Ux</th><th>Uy</th><th>Uz</th><th>|δ|</th></tr>';
    let rowsN = '';
    for (const node of this.app.model.nodes.values()) {
      const d = res.getNodeDisp(node.id);
      const mag = Math.hypot(d[0], d[1], d[2]);
      rowsN += `<tr><td>${node.id}</td>${fv(d[0])}${fv(d[1])}${fv(d[2])}${fv(mag)}</tr>`;
    }
    body.insertAdjacentHTML('beforeend',
      `<table class="res-table"><thead>${thN}</thead><tbody>${rowsN}</tbody></table>`);
  }

  // ── Diaphragms tab ─────────────────────────────────────────────────────────
  renderDiaphragms() {
    const container = document.getElementById('dia-list');
    if (!container) return;
    container.innerHTML = '';

    if (this.app.model.diaphragms.size === 0) {
      container.innerHTML = '<p class="panel-hint">No hay diafragmas definidos. Use "Auto-detectar Pisos" o agregue uno manualmente.</p>';
      return;
    }

    // Sort by Z
    const sorted = [...this.app.model.diaphragms.values()].sort((a,b) => a.z - b.z);
    for (const d of sorted) container.appendChild(this._diaCard(d));
  }

  _diaCard(d) {
    const card = document.createElement('div');
    card.className = 'mat-card'; // reuse mat-card styles
    card.dataset.id = d.id;

    const nodeCount  = d.nodes.length;
    const masterNode = this.app.model.nodes.get(d.masterId || d.nodes[0]);
    const hasMass    = d.mass && (d.mass.m > 0 || d.mass.Icm > 0);

    card.innerHTML = `
      <div class="mat-card-head">
        <span class="mat-card-id" style="background:rgba(0,188,212,0.2);color:#00bcd4">${d.id}</span>
        <span class="mat-card-name" style="color:#00bcd4">${esc(d.name)}</span>
        <span style="font-size:10px;color:var(--text-muted);margin-left:auto">${nodeCount} nodos | Z=${d.z}</span>
        <span class="mat-card-chevron">▶</span>
      </div>
      <div class="mat-card-body">
        <div class="prop-row cols1">
          <div class="prop-field"><label>Nombre</label>
            <input type="text" data-df="name" value="${esc(d.name)}">
          </div>
        </div>
        <div class="prop-row">
          <div class="prop-field"><label>Z piso (m)</label>
            <input type="number" data-df="z" value="${d.z}" step="0.1">
          </div>
          <div class="prop-field"><label>Nodo CR (master) ID</label>
            <input type="number" data-df="masterId" value="${d.masterId || d.nodes[0]}" step="1" min="1">
          </div>
        </div>
        <div class="prop-title" style="margin-top:8px;">Centro de Rigidez (CR) — calculado</div>
        <div class="prop-row">
          <div class="prop-field"><label>CR x (m)</label>
            <input type="number" data-df="cr.x" value="${+(d.cr?.x ?? 0).toFixed(4)}" step="0.01" readonly style="opacity:.6">
          </div>
          <div class="prop-field"><label>CR y (m)</label>
            <input type="number" data-df="cr.y" value="${+(d.cr?.y ?? 0).toFixed(4)}" step="0.01" readonly style="opacity:.6">
          </div>
        </div>
        <div class="prop-title" style="margin-top:8px;">Centro de Masa (CM) — calculado</div>
        <div class="prop-row">
          <div class="prop-field"><label>CM x (m)</label>
            <input type="number" data-df="cm.x" value="${+(d.cm?.x ?? 0).toFixed(4)}" step="0.01" readonly style="opacity:.6">
          </div>
          <div class="prop-field"><label>CM y (m)</label>
            <input type="number" data-df="cm.y" value="${+(d.cm?.y ?? 0).toFixed(4)}" step="0.01" readonly style="opacity:.6">
          </div>
        </div>
        <div class="prop-title" style="margin-top:8px;">Masa Concentrada</div>
        <div class="prop-row">
          <div class="prop-field"><label>m (ton)</label>
            <input type="number" data-df="mass.m" value="${d.mass?.m ?? 0}" step="1" min="0">
          </div>
          <div class="prop-field"><label>Icm (ton·m²)</label>
            <input type="number" data-df="mass.Icm" value="${d.mass?.Icm ?? 0}" step="1" min="0">
          </div>
        </div>
        <div class="prop-title" style="margin-top:8px;">Excentricidad Accidental</div>
        <div class="prop-row">
          <div class="prop-field"><label>eₓ (m)</label>
            <input type="number" data-df="ecc.ex" value="${d.eccentricity?.ex ?? 0}" step="0.01">
          </div>
          <div class="prop-field"><label>eᵧ (m)</label>
            <input type="number" data-df="ecc.ey" value="${d.eccentricity?.ey ?? 0}" step="0.01">
          </div>
        </div>
        <div class="prop-title" style="margin-top:8px;">Nodos del Piso</div>
        <div class="prop-row cols1">
          <div class="prop-field">
            <label>IDs (separados por coma)</label>
            <input type="text" data-df="nodes" value="${d.nodes.join(', ')}">
          </div>
        </div>
        <div class="card-actions">
          <button class="btn-recalc-dia" style="flex:1">⟳ Recalcular CM/CR</button>
          <button class="btn-danger btn-del-dia" style="flex:1">Eliminar</button>
        </div>
      </div>
    `;

    // Toggle expand
    card.querySelector('.mat-card-head').addEventListener('click', () => card.classList.toggle('open'));

    // ── helpers ────────────────────────────────────────────────────────────
    const get    = sel => card.querySelector(`[data-df="${sel}"]`)?.value;
    const getNum = sel => parseFloat(get(sel)) || 0;
    const setVal = (sel, v) => {
      const el = card.querySelector(`[data-df="${sel}"]`);
      if (el) el.value = typeof v === 'number' ? +v.toFixed(4) : v;
    };

    // Recompute CM and CR from current node list; update read-only fields
    const recalcCMCR = (nodeIds, floorZ) => {
      const model      = this.app.model;
      const floorNodes = nodeIds.map(id => model.nodes.get(id)).filter(Boolean);
      if (floorNodes.length < 2) return {};

      const weights = computeTributaryWeights(floorNodes, model, floorZ);
      const cm      = computeFloorCM(floorNodes, weights);
      const cr      = computeFloorCR(model, new Set(nodeIds), floorZ);

      setVal('cm.x', cm.x); setVal('cm.y', cm.y);
      if (cr) { setVal('cr.x', cr.x); setVal('cr.y', cr.y); }
      return { cm, cr };
    };

    // ── Save on any field change ────────────────────────────────────────────
    const saveCard = () => {
      this.app.snapshot();
      const nodesStr = get('nodes') || '';
      const nodeIds  = nodesStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      const floorZ   = getNum('z');

      this.app.model.diaphragms.set(d.id, {
        ...d,
        name:         get('name') || d.name,
        z:            floorZ,
        masterId:     parseInt(get('masterId')) || nodeIds[0],
        cm:           { x: getNum('cm.x'), y: getNum('cm.y') },
        cr:           { x: getNum('cr.x'), y: getNum('cr.y') },
        mass:         { m: getNum('mass.m'), Icm: getNum('mass.Icm') },
        eccentricity: { ex: getNum('ecc.ex'), ey: getNum('ecc.ey') },
        nodes:        nodeIds,
      });
      this.app.viewport.refreshDiaphragms();
      this.app.markDirty();
    };

    // Auto-recalc CM/CR when the nodes list changes
    card.querySelector('[data-df="nodes"]').addEventListener('change', () => {
      const nodesStr = get('nodes') || '';
      const nodeIds  = nodesStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      recalcCMCR(nodeIds, getNum('z'));
      saveCard();
    });

    // Other inputs just save
    card.querySelectorAll('input:not([data-df="nodes"])').forEach(inp =>
      inp.addEventListener('change', saveCard)
    );

    // Recalculate button
    card.querySelector('.btn-recalc-dia').addEventListener('click', () => {
      const nodesStr = get('nodes') || '';
      const nodeIds  = nodesStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      const { cm, cr } = recalcCMCR(nodeIds, getNum('z'));
      if (!cm) { this.app.toast('Necesitas ≥ 2 nodos válidos', 'warn'); return; }
      saveCard();
      this.app.toast('CM y CR recalculados', 'ok');
    });

    card.querySelector('.btn-del-dia').addEventListener('click', () => {
      this.app.snapshot();
      this.app.model.removeDiaphragm(d.id);
      this.app.viewport.refreshDiaphragms();
      this.app.markDirty();
      this.renderDiaphragms();
    });

    return card;
  }
}
