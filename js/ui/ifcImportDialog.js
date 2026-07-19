// ──────────────────────────────────────────────────────────────────────────────
// ui/ifcImportDialog.js — IFC import floating window · #77, G19
//
// Large modal window with THREE zones:
//   • summary   → schema, units and count by type (columns/beams/walls…).
//   • table     → one row per element: import (yes/no) · type · name · level ·
//                 material · section · status · warnings.  With filters.
//   • preview   → side-by-side comparison IFC ↔ PORTICO (ifcSideBySidePreview).
// Does NOT modify the model: returns the selection (Promise) and it is `app.importIFC`
// that builds and confirms (with snapshot → undo).  Robust: the non-importable ones
// are listed disabled, never break.  STANDALONE except for Three (via the preview).
// ──────────────────────────────────────────────────────────────────────────────
import { IfcPreview } from './ifcSideBySidePreview.js?v=6';
import { itemsToNeutral } from '../io/ifc/ifcToPortico.js?v=6';
import { KIND_LABEL } from '../io/ifc/ifcClassifier.js?v=6';
import { esc } from '../utils/escape.js?v=6';
import { i18n } from '../i18n/i18n.js?v=6';

const STATUS = {
  ok:            { txt: 'Importable', color: 'var(--success)' },
  'no-geom':     { txt: 'Sin geometría', color: 'var(--danger)' },
  unsupported:   { txt: 'No soportado', color: 'var(--text-muted)' },
};

/**
 * Opens the IFC import window.
 * @param {{ fileName:string, analysis:object }} arg  analysis = output of analyzeIFC
 * @returns {Promise<{ selected:Set<number>, items:Array } | null>}  null if cancelled
 */
export function openIfcImportDialog({ fileName, analysis }) {
  return new Promise(resolve => {
    const { items, counts, schema, unit, levels } = analysis;
    const selected = new Set(items.filter(i => i.status === 'ok').map(i => i.ifcId));

    // ── DOM scaffolding ────────────────────────────────────────────────────────
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center';
    const win = document.createElement('div');
    win.style.cssText = 'width:92vw;height:88vh;max-width:1500px;display:flex;flex-direction:column;background:var(--glass);backdrop-filter:blur(8px);border:1px solid var(--border);border-radius:var(--radius,10px);box-shadow:0 16px 48px rgba(0,0,0,.5);overflow:hidden;font-size:12px;color:var(--text)';
    ov.appendChild(win);

    const plural = (lbl, n) => n === 1 ? lbl : (/[aeiouáéíóú]$/i.test(lbl) ? lbl + 's' : lbl + 'es');
    const countTxt = Object.entries(counts).map(([k, n]) => `${n} ${plural(KIND_LABEL[k] || k, n)}`).join(' · ') || 'sin elementos';
    win.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border)">
        <div style="font-size:15px;font-weight:600">🏗️ Importar IFC</div>
        <div style="color:var(--text-muted);font-size:11px">${esc(fileName)} · ${esc(schema)} · ${esc(unit.name)} · ${esc(countTxt)}</div>
        <button id="ifc-x" style="margin-left:auto;background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;line-height:1">×</button>
      </div>
      <div style="display:flex;flex:1;min-height:0">
        <div style="width:46%;display:flex;flex-direction:column;border-right:1px solid var(--border);min-width:0">
          <div style="display:flex;gap:14px;align-items:center;padding:8px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap">
            <label style="display:flex;gap:5px;align-items:center;cursor:pointer"><input type="checkbox" id="ifc-all" checked> <span>Todos los importables</span></label>
            <label style="display:flex;gap:5px;align-items:center;cursor:pointer;color:var(--text-muted)"><input type="checkbox" id="ifc-hide-unsup"> <span>Ocultar no soportados</span></label>
          </div>
          <div style="flex:1;overflow:auto"><table style="width:100%;border-collapse:collapse" id="ifc-tbl"></table></div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;min-width:0">
          <div style="display:flex;flex:1;min-height:0">
            <div style="flex:1;display:flex;flex-direction:column;border-right:1px solid var(--border);min-width:0">
              <div style="padding:5px 10px;color:var(--accent);font-weight:600;border-bottom:1px solid var(--border)">IFC original</div>
              <div id="ifc-pvL" style="flex:1;min-height:0"></div>
            </div>
            <div style="flex:1;display:flex;flex-direction:column;min-width:0">
              <div style="padding:5px 10px;color:#4fc3f7;font-weight:600;border-bottom:1px solid var(--border)">PORTICO (a crear)</div>
              <div id="ifc-pvR" style="flex:1;min-height:0"></div>
            </div>
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid var(--border)">
        <div id="ifc-stats" style="color:var(--text-muted)"></div>
        <div style="margin-left:auto;display:flex;gap:8px">
          <button id="ifc-cancel" style="padding:7px 16px;background:var(--bg4);border:1px solid var(--border);border-radius:6px;color:var(--text);cursor:pointer">Cancelar</button>
          <button id="ifc-ok" style="padding:7px 18px;background:var(--accent);border:none;border-radius:6px;color:#06121c;font-weight:600;cursor:pointer">Importar selección</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    i18n.translate(ov);   // floating window (body) → not observed; translate explicitly

    // ── table ──────────────────────────────────────────────────────────────────────
    const tbl = win.querySelector('#ifc-tbl');
    const thStyle = 'text-align:left;padding:6px 8px;position:sticky;top:0;background:var(--bg4);font-weight:600;border-bottom:1px solid var(--border);z-index:1';
    const buildRows = () => {
      const hideUnsup = win.querySelector('#ifc-hide-unsup').checked;
      let html = `<thead><tr>
        <th style="${thStyle};width:30px"></th>
        <th style="${thStyle}">Tipo</th><th style="${thStyle}">Nombre</th><th style="${thStyle}">Nivel</th>
        <th style="${thStyle}">Material</th><th style="${thStyle}">Sección</th><th style="${thStyle}">Estado</th><th style="${thStyle}">Avisos</th>
      </tr></thead><tbody>`;
      for (const it of items) {
        if (hideUnsup && !it.supported) continue;
        const st = STATUS[it.status] || STATUS.unsupported;
        const importable = it.status === 'ok';
        const warn = it.warnings.list.length ? `<span title="${esc(it.warnings.list.join('\n'))}" style="color:var(--warn);cursor:help">⚠ ${it.warnings.list.length}</span>` : '';
        html += `<tr data-id="${it.ifcId}" style="border-bottom:1px solid var(--border)${importable ? '' : ';opacity:.55'}">
          <td style="padding:5px 8px;text-align:center"><input type="checkbox" class="ifc-cb" data-id="${it.ifcId}" ${selected.has(it.ifcId) ? 'checked' : ''} ${importable ? '' : 'disabled'}></td>
          <td style="padding:5px 8px">${esc(it.kindLabel)}</td>
          <td style="padding:5px 8px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(it.name)}">${esc(it.name)}</td>
          <td style="padding:5px 8px">${esc(it.levelName)}</td>
          <td style="padding:5px 8px">${esc(it.matName || '—')}</td>
          <td style="padding:5px 8px">${esc(it.secName || '—')}${it.secApprox ? ' <span style="color:var(--warn)" title="aproximada">≈</span>' : ''}</td>
          <td style="padding:5px 8px;color:${st.color}">${st.txt}</td>
          <td style="padding:5px 8px">${warn}</td>
        </tr>`;
      }
      tbl.innerHTML = html + '</tbody>';
      i18n.translate(tbl);   // re-rendered on filter → re-translate headers/status
      tbl.querySelectorAll('.ifc-cb').forEach(cb => cb.addEventListener('change', () => {
        const id = +cb.dataset.id;
        cb.checked ? selected.add(id) : selected.delete(id);
        refresh();
      }));
    };

    // ── preview + statistics ────────────────────────────────────────────────────────
    const preview = new IfcPreview(win.querySelector('#ifc-pvL'), win.querySelector('#ifc-pvR'));
    preview.setData(items);
    const statsEl = win.querySelector('#ifc-stats');
    const refresh = () => {
      preview.updateSelection(selected);
      const { stats } = itemsToNeutral(items, selected);
      const nada = stats.members === 0 && stats.areas === 0;
      statsEl.textContent = `${i18n.t('Se crearán')} ${stats.members} ${i18n.t('barra(s)')}, ${stats.areas} ${i18n.t('área(s)')}, ${stats.nodes} ${i18n.t('nodo(s)')}, ${stats.sections} ${i18n.t('sección(es)')}, ${stats.materials} ${i18n.t('material(es)')}.`;
      win.querySelector('#ifc-ok').disabled = nada;
      win.querySelector('#ifc-ok').style.opacity = nada ? .5 : 1;
    };

    buildRows(); refresh();
    setTimeout(() => preview._resize(), 30);

    // ── events ───────────────────────────────────────────────────────────────────────
    win.querySelector('#ifc-all').addEventListener('change', e => {
      selected.clear();
      if (e.target.checked) for (const it of items) if (it.status === 'ok') selected.add(it.ifcId);
      buildRows(); refresh();
    });
    win.querySelector('#ifc-hide-unsup').addEventListener('change', buildRows);

    const close = (result) => { preview.dispose(); ov.remove(); resolve(result); };
    win.querySelector('#ifc-x').addEventListener('click', () => close(null));
    win.querySelector('#ifc-cancel').addEventListener('click', () => close(null));
    win.querySelector('#ifc-ok').addEventListener('click', () => { if (selected.size) close({ selected, items }); });
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(null); });
    document.addEventListener('keydown', function onKey(ev) { if (ev.key === 'Escape') { document.removeEventListener('keydown', onKey); close(null); } });
  });
}
