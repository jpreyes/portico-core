// ──────────────────────────────────────────────────────────────────────────────
// report.js — calculation-report renderers (memoria de cálculo): HTML/PDF and Word.
//
// Pure string / Docx builders extracted from app.js. Each takes the App instance as
// `app` for read-only access to model/results/branding — no DOM writes, no this.*
// mutation. Orchestration (window.open, blob download, multi-model iteration) and the
// data-prep (_computeDesign/_computeBeamDeflections/_computeDrift/_captureReportViews)
// stay in app.js and call these. Bodies keep their original indentation so every
// template literal emits byte-identical output.
// ──────────────────────────────────────────────────────────────────────────────
import { esc } from '../utils/escape.js?v=6';
import { i18n } from '../i18n/i18n.js?v=6';

export function reportDocx(app, Docx, imgs, diseno, deflex, drift) {
    const d = new Docx();
    reportDocxCover(app, d);
    d.pageBreak();
    reportDocxBody(app, d, imgs, diseno, deflex, drift);
    return d;
  }

export function reportDocxCover(app, d, opts = {}) {
    const cm = app._report();
    const proyecto = (document.title || '').replace(/^●\s*/, '').replace(/\s*—\s*[^—]*$/, '').trim() || i18n.t('Modelo sin título');
    const fecha = new Date().toLocaleDateString(i18n.getLocale() === 'en' ? 'en-US' : 'es-CL', { year: 'numeric', month: 'long', day: 'numeric' });
    const U = app.model.units || 'kN-m';
    const tieneLogoPro = !!(app._brandingPro && cm.logoEmpresa);
    if (tieneLogoPro) d.image(cm.logoEmpresa, '', 2 * 914400);   // company logo (if PNG/JPEG)
    if (!tieneLogoPro)
      d.paragraph([{ text: cm.institucion || '', bold: true, color: '0A3A57', size: 13 }], { align: 'center' })
       .paragraph([{ text: cm.subInstitucion || '', color: '5C6A7D', size: 10 }], { align: 'center' });
    d.spacer();
    d.paragraph([{ text: cm.kicker || i18n.t('ANÁLISIS Y DISEÑO ESTRUCTURAL'), color: '0D9488', bold: true, size: 11 }], { align: 'center' });
    d.paragraph([{ text: cm.titulo || i18n.t('Memoria de Cálculo'), bold: true, color: '0A3A57', size: 26 }], { align: 'center' });
    d.paragraph([{ text: proyecto, size: 13 }], { align: 'center' });
    if (opts.nModelos > 1) d.paragraph([{ text: `${i18n.t('Proyecto de')} ${opts.nModelos} ${i18n.t('modelos')}`, color: '0D9488', size: 10 }], { align: 'center' });
    d.spacer();
    d.table(null, [
      [{ text: i18n.t('Proyecto'), bold: true }, proyecto],
      [{ text: i18n.t('Fecha'), bold: true }, fecha],
      [{ text: i18n.t('Unidades'), bold: true }, U.replace('-', ' · ')],
      [{ text: i18n.t('Proyectista'), bold: true }, cm.proyectista || ''],
      [{ text: i18n.t('Revisó'), bold: true }, cm.revisor || ''],
    ]);
    d.paragraph([{ text: i18n.t('Documento de carácter orientativo. Los resultados deben ser validados por un profesional competente antes de cualquier uso en obra.'), italic: true, color: '5C6A7D', size: 9 }], { align: 'center' });
    if (app._brandingPro && cm.descripcion) d.paragraph(cm.descripcion);
  }

export function reportDocxBody(app, d, imgs, diseno, deflex, drift) {
    const m = app.model;
    const cm = app._report();   // effective report: per-project + global defaults (#41)
    const fmt = (v, dec = 3) => (v == null || !isFinite(v)) ? '—'
      : (Math.abs(v) >= 1e5 || (Math.abs(v) > 0 && Math.abs(v) < 1e-3) ? (+v).toExponential(2) : (+v).toFixed(dec));
    const stripTags = s => String(s ?? '').replace(/<[^>]+>/g, '');

    // ── 1. Design basis ──
    d.heading(i18n.t('1. Bases de cálculo'), 1);
    const s = m.getStats();
    d.heading(i18n.t('1.1 Modelo estructural'), 2);
    d.table([i18n.t('Magnitud'), i18n.t('Cantidad')], [
      [i18n.t('Nodos'), String(s.nodes)], [i18n.t('Elementos (barras)'), String(s.elements)],
      [i18n.t('Áreas (membrana/placa/shell)'), String(m.areas?.size || 0)],
      [i18n.t('Materiales'), String(s.materials)], [i18n.t('Secciones'), String(s.sections)],
      [i18n.t('Diafragmas rígidos'), String(m.diaphragms?.size || 0)],
      [i18n.t('Casos de carga'), String(m.loadCases?.size || 0)], [i18n.t('Combinaciones'), String(m.combinations?.size || 0)],
    ]);

    d.heading(i18n.t('1.2 Materiales'), 2);
    d.table([i18n.t('Material'), 'E', 'G', 'ν', 'ρ'],
      [...m.materials.values()].map(mt => [mt.name, fmt(mt.E, 0), fmt(mt.G, 0), fmt(mt.nu, 2), fmt(mt.rho, 3)]));

    d.heading(i18n.t('1.3 Secciones'), 2);
    const secCount = new Map();
    for (const el of m.elements.values()) secCount.set(el.secId, (secCount.get(el.secId) || 0) + 1);
    d.table([i18n.t('Sección'), 'A', 'Iy', 'Iz', 'J', i18n.t('N° elem.')],
      [...m.sections.values()].map(sec => [sec.name, fmt(sec.A, 5), fmt(sec.Iy, 6), fmt(sec.Iz, 6), fmt(sec.J, 6), String(secCount.get(sec.id) || 0)]));

    // ── 2. Loads and combinations ──
    d.heading(i18n.t('2. Cargas y combinaciones'), 1);
    const dirLabel = { gravity: i18n.t('Gravedad (−Z)'), globalX: i18n.t('Global +X'), globalY: i18n.t('Global +Y'), globalZ: i18n.t('Global +Z'), localY: i18n.t('Local y'), localZ: i18n.t('Local z') };
    for (const lc of [...m.loadCases.values()].filter(l => l.type !== 'spectrum')) {
      d.heading(`${lc.name}${lc.selfWeight ? '  ' + i18n.t('(+ peso propio)') : ''}`, 3);
      const rows = (lc.loads || []).map(ld => {
        if (ld.type === 'nodal') { const F = ld.F || []; return [i18n.t('Puntual'), `${i18n.t('Nodo')} ${ld.nodeId}`, `F=(${fmt(F[0], 1)}, ${fmt(F[1], 1)}, ${fmt(F[2], 1)}) kN`]; }
        if (ld.type === 'temp') return [i18n.t('Temperatura'), `${i18n.t('Elem')} ${ld.elemId}`, `ΔT = ${fmt(ld.dT, 1)} °C`];
        return [i18n.t('Distribuida'), `${i18n.t('Elem')} ${ld.elemId}`, `w = ${fmt(ld.w, 2)} kN/m · ${dirLabel[ld.dir] || ld.dir || i18n.t('gravedad')}`];
      });
      if (rows.length) d.table([i18n.t('Tipo'), i18n.t('Aplicada en'), i18n.t('Valor')], rows);
      else d.paragraph([{ text: lc.selfWeight ? i18n.t('Solo peso propio.') : i18n.t('Sin cargas asignadas.'), italic: true, color: '5C6A7D' }]);
    }
    const lcName = id => m.loadCases.get(id)?.name || m.combinations?.get(id)?.name || `LC${id}`;
    if (m.combinations?.size) {
      d.heading(i18n.t('2.1 Combinaciones'), 2);
      d.table([i18n.t('Combinación'), i18n.t('Definición')],
        [...m.combinations.values()].map(c => [c.name, (c.factors || []).map(f => `${fmt(f.factor, 2)}·${lcName(f.lcId)}`).join('  +  ') || '—']));
    }

    // ── 3. Figures ──
    d.heading(i18n.t('3. Modelo y deformada'), 1);
    if (imgs.base) d.image(imgs.base, i18n.t('Modelo estructural (geometría base)'));
    if (imgs.deformada) d.image(imgs.deformada, i18n.t('Deformada (resultado estático)'));

    // ── 4. Modal analysis ──
    if (app._modalResults) {
      d.heading(i18n.t('4. Análisis modal'), 1);
      const { rows } = app._modalResults.getParticipation();
      d.paragraph(`${i18n.t('Modos extraídos:')} ${app._modalResults.nModes}.`);
      d.table([i18n.t('Modo'), 'f (Hz)', 'T (s)', 'Mx %', 'My %', 'Mrz %', 'ΣMx', 'ΣMy', 'ΣMrz'],
        rows.slice(0, 12).map(r => [String(r.mode), fmt(r.freq, 3), fmt(r.period, 3),
          fmt(r.pct[0], 1), fmt(r.pct[1], 1), fmt(r.pct[2], 1), fmt(r.cumPct[0], 1), fmt(r.cumPct[1], 1), fmt(r.cumPct[2], 1)]));
      for (const md of imgs.modos) d.image(md.img, `${i18n.t('Modo')} ${md.n} — f = ${fmt(md.freq, 3)} Hz · T = ${fmt(md.period, 3)} s`);
    }

    // ── 5. Strength verification (D/C) ──
    d.heading(i18n.t('5. Verificación de resistencia (D/C)'), 1);
    if (diseno?.filas?.length) {
      const f = diseno.filas;
      const colorR = r => r > 1 ? 'DC2626' : r > 0.9 ? 'B45309' : '15803D';
      const estado = r => r > 1 ? i18n.t('NO CUMPLE') : r > 0.9 ? i18n.t('ajustado') : i18n.t('cumple');
      const alcance = diseno.envolvente ? i18n.t('envolvente de las combinaciones') : `${i18n.t('el estado')} «${diseno.caso || i18n.t('activo')}»`;
      d.paragraph(`${i18n.t('Verificación por')} ${alcance}. ${i18n.t('La razón D/C = demanda/capacidad debe ser ≤ 1.0.')}`);
      d.table([i18n.t('Elem'), i18n.t('Sección'), i18n.t('Material'), 'N (kN)', 'M (kN·m)', 'V (kN)', i18n.t('D/C máx'), i18n.t('Gobierna'), i18n.t('Estado')],
        f.slice(0, 60).map(x => [
          `#${x.id}`, x.sec, x.mat, fmt(x.forces.N, 1),
          fmt(Math.max(x.forces.My, x.forces.Mz), 1), fmt(Math.max(x.forces.Vy, x.forces.Vz), 1),
          { text: fmt(x.ratioMax, 2), bold: true, color: colorR(x.ratioMax) },
          String(x.governs ?? '—'),
          { text: estado(x.ratioMax), color: colorR(x.ratioMax) },
        ]));
      const nNo = f.filter(x => x.ratioMax > 1).length, nAj = f.filter(x => x.ratioMax > 0.9 && x.ratioMax <= 1).length;
      const shown = f.length > 60 ? `${i18n.t('Se muestran los 60 elementos más solicitados de')} ${f.length}. ` : '';
      d.paragraph(`${shown}${i18n.t('Resumen:')} ${f.length - nNo - nAj} ${i18n.t('cumplen')} · ${nAj} ${i18n.t('ajustados')} · ${nNo} ${i18n.t('no cumplen')}.`);
    } else {
      d.paragraph([{ text: i18n.t('No hay resultados de análisis para verificar. Ejecute el análisis estático (F5) con sus combinaciones de carga antes de generar la memoria.'), italic: true, color: '5C6A7D' }]);
    }

    // ── 6. Service: beam deflections ──
    d.heading(i18n.t('6. Deformaciones de vigas (servicio)'), 1);
    if (deflex?.rows?.length) {
      const colorR = r => r > 1 ? 'DC2626' : r > 0.9 ? 'B45309' : '15803D';
      d.paragraph(`${i18n.t('Flecha de vigas bajo')} «${deflex.caso}» ${i18n.t('sin mayorar, respecto a la cuerda del vano.')} ${i18n.t('Límite de servicio')} L/${deflex.limSobre}.`);
      d.table([i18n.t('Viga'), i18n.t('Sección'), 'L (m)', 'δ (mm)', 'δ adm (mm)', 'δ/δadm', i18n.t('Estado')],
        deflex.rows.slice(0, 60).map(x => [
          `#${x.id}`, x.sec, fmt(x.L, 2), fmt(x.delta * 1000, 2), fmt(x.lim * 1000, 2),
          { text: fmt(x.ratio, 2), bold: true, color: colorR(x.ratio) },
          { text: x.ratio > 1 ? i18n.t('NO CUMPLE') : x.ratio > 0.9 ? i18n.t('ajustado') : i18n.t('cumple'), color: colorR(x.ratio) },
        ]));
    } else d.paragraph([{ text: stripTags(deflex?.note || i18n.t('Sin datos de deformaciones de vigas.')), italic: true, color: '5C6A7D' }]);

    // ── 7. Seismic drifts ──
    d.heading(i18n.t('7. Derivas sísmicas de entrepiso (NCh433)'), 1);
    if (drift?.dirs?.length) {
      for (const D of drift.dirs) {
        d.heading(`${i18n.t('Dirección sísmica')} ${D.dir}`, 3);
        d.table([i18n.t('Piso'), 'Z (m)', 'h (m)', 'δ/h (CM)', '·/0.002', 'δ/h (ext.)', '·/0.002'],
          D.stories.map(st => [String(st.piso), fmt(st.z, 2), fmt(st.h, 2),
            st.driftCM == null ? '—' : fmt(st.driftCM, 5), st.ratioCM == null ? '—' : fmt(st.ratioCM, 2),
            fmt(st.driftExt, 5), fmt(st.ratioExt, 2)]));
      }
      d.paragraph([{ text: i18n.t('Límite NCh433: 0.002 (2/1000·h). Calculada con los desplazamientos del espectro de respuesta.'), color: '5C6A7D', size: 9 }]);
    } else d.paragraph([{ text: stripTags(drift?.note || i18n.t('Sin datos de derivas sísmicas.')), italic: true, color: '5C6A7D' }]);

    // ── 8. Limitations ──
    d.heading(i18n.t('8. Alcances y limitaciones'), 1);
    const limits = (app._brandingPro && cm.limitaciones)
      ? cm.limitaciones.split('\n').map(x => x.trim()).filter(Boolean)
      : app._ACAD_LIMITS;
    for (const li of limits) d.paragraph([{ text: '• ' + stripTags(li), size: 9, color: '5C6A7D' }]);
    d.spacer();
    d.paragraph([{ text: (app._brandingPro && cm.footer) ? cm.footer : app._ACAD_FOOTER, italic: true, color: '5C6A7D', size: 9 }], { align: 'center' });
  }

export function reportHTML(app, imgs, diseno, deflex, drift) {
    const m = app.model;
    const fmt = (v, d = 3) => (v == null || !isFinite(v)) ? '—'
      : (Math.abs(v) >= 1e5 || (Math.abs(v) > 0 && Math.abs(v) < 1e-3) ? (+v).toExponential(2) : (+v).toFixed(d));
    const proyecto = (document.title || '').replace(/^●\s*/, '').replace(/\s*—\s*[^—]*$/, '').trim() || i18n.t('Modelo sin título');
    const fecha = new Date().toLocaleDateString(i18n.getLocale() === 'en' ? 'en-US' : 'es-CL', { year:'numeric', month:'long', day:'numeric' });
    const U = m.units || 'kN-m';
    const cm = app._report();   // effective report: per-project + global defaults (#41)
    const clasif = (n) => { n = String(n||'').toLowerCase();
      if (/(horm|concret|h\s*\d|fc)/.test(n)) return 'concrete';
      if (/(mader|pino|wood|gl\b|lvl|conif)/.test(n)) return 'timber';
      return 'steel'; };
    const dp = diseno?.params || null;

    // ── Materials ───────────────────────────────────────────────────────────
    const matRows = [...m.materials.values()].map(mt => `<tr>
      <td>${esc(mt.name)}</td><td>${fmt(mt.E,0)}</td><td>${fmt(mt.G,0)}</td>
      <td>${fmt(mt.nu,2)}</td><td>${fmt(mt.rho,3)}</td></tr>`).join('') || `<tr><td colspan="5">${i18n.t('Sin materiales')}</td></tr>`;

    // ── Sections (with count of elements using each) ────────────────────────
    const secCount = new Map();
    for (const el of m.elements.values()) secCount.set(el.secId, (secCount.get(el.secId) || 0) + 1);
    const modTxt = (md) => { const o = md || {}; const a=o.A??1,iy=o.Iy??1,iz=o.Iz??1,j=o.J??1;
      return (a===1&&iy===1&&iz===1&&j===1) ? '—' : `A·${a} Iy·${iy} Iz·${iz} J·${j}`; };
    const secRows = [...m.sections.values()].map(s => `<tr>
      <td>${esc(s.name)}</td><td>${fmt(s.A,5)}</td><td>${fmt(s.Iy,6)}</td><td>${fmt(s.Iz,6)}</td>
      <td>${fmt(s.J,6)}</td><td>${fmt(s.Avy,5)}</td><td>${fmt(s.Avz,5)}</td>
      <td>${modTxt(s.mod)}</td><td>${secCount.get(s.id) || 0}</td></tr>`).join('') || `<tr><td colspan="9">${i18n.t('Sin secciones')}</td></tr>`;

    // ── Classification of cases and loads ───────────────────────────────────
    const tipoCaso = (lc) => {
      if (lc.type === 'spectrum') return i18n.t('Sísmica (espectro)');
      const n = (lc.name || '').toLowerCase();
      if (/vient|wind/.test(n)) return i18n.t('Viento');
      if (/niev|snow/.test(n)) return i18n.t('Nieve');
      if (/sism|seism|\bsx\b|\bsy\b|\beq\b/.test(n)) return i18n.t('Sísmica');
      if (/sobre|live|\bcv\b|uso/.test(n)) return i18n.t('Sobrecarga de uso');
      if (/event|acc/.test(n)) return i18n.t('Eventual');
      if (/perm|muert|\bcm\b|dead|propio/.test(n) || lc.selfWeight) return i18n.t('Permanente');
      return i18n.t('Carga');
    };
    const dirLabel = { gravity:i18n.t('Gravedad ↓ (−Z)'), globalX:i18n.t('Global +X'), globalY:i18n.t('Global +Y'),
      globalZ:i18n.t('Global +Z'), localY:i18n.t('Local y'), localZ:i18n.t('Local z'), x:i18n.t('Global +X'), y:i18n.t('Global +Y'), z:i18n.t('Global +Z') };

    const casosStatic = [...m.loadCases.values()].filter(lc => lc.type !== 'spectrum');
    const cargasHTML = casosStatic.map(lc => {
      const loadRows = (lc.loads || []).map(ld => {
        if (ld.type === 'nodal') {
          const [Fx,Fy,Fz,Mx,My,Mz] = ld.F || [];
          return `<tr><td>${i18n.t('Puntual')}</td><td>${i18n.t('Nodo')} ${ld.nodeId}</td><td>—</td>
            <td>F=(${fmt(Fx,2)}, ${fmt(Fy,2)}, ${fmt(Fz,2)}) kN · M=(${fmt(Mx,2)}, ${fmt(My,2)}, ${fmt(Mz,2)}) kN·m</td></tr>`;
        }
        if (ld.type === 'temp') {
          return `<tr><td>${i18n.t('Temperatura')}</td><td>${i18n.t('Elem')} ${ld.elemId}</td><td>${i18n.t('Uniforme')}</td><td>ΔT = ${fmt(ld.dT,1)} °C</td></tr>`;
        }
        return `<tr><td>${i18n.t('Distribuida')}</td><td>${i18n.t('Elem')} ${ld.elemId}</td>
          <td>${esc(dirLabel[ld.dir] || ld.dir || i18n.t('Gravedad'))}</td><td>w = ${fmt(ld.w,2)} kN/m</td></tr>`;
      }).join('');
      const cuerpo = loadRows || `<tr><td colspan="4" class="muted">${lc.selfWeight ? i18n.t('Solo peso propio') : i18n.t('Sin cargas asignadas')}</td></tr>`;
      return `<h3>${esc(lc.name)} <span class="tag">${tipoCaso(lc)}</span>${lc.selfWeight ? ` <span class="tag tag-pp">${i18n.t('+ peso propio')}</span>` : ''}</h3>
        <table><thead><tr><th>${i18n.t('Tipo')}</th><th>${i18n.t('Aplicada en')}</th><th>${i18n.t('Dirección')}</th><th>${i18n.t('Valor')}</th></tr></thead>
        <tbody>${cuerpo}</tbody></table>`;
    }).join('') || `<p class="muted">${i18n.t('No hay casos de carga estáticos definidos.')}</p>`;

    // ── Seismic (spectra with their NCh433/DS61 parameters) ─────────────────
    let sismoHTML = '';
    const espectros = [...app._spectrumResults.values()].filter(e => e?.params);
    if (espectros.length) {
      sismoHTML = espectros.map(({ params: p }) => {
        const k = p.nch433 || {};
        const tabla = `<table><tbody>
          <tr><th>${i18n.t('Dirección sísmica')}</th><td>${esc(p.direction)}</td><th>${i18n.t('Método combinación')}</th><td>${esc(p.method)}</td></tr>
          <tr><th>${i18n.t('Zona sísmica')}</th><td>${esc(k.zona ?? '—')} (A₀ = ${fmt(k.Ao,2)} g)</td><th>${i18n.t('Tipo de suelo')}</th><td>${esc(k.suelo ?? '—')} (S=${fmt(k.S,2)}, T₀=${fmt(k.To,2)}, p=${fmt(k.p,2)})</td></tr>
          <tr><th>${i18n.t('Categoría de importancia')}</th><td>${esc(k.cat ?? '—')} (I = ${fmt(k.I,2)})</td><th>${i18n.t('Amortiguamiento ζ')}</th><td>${fmt(p.zeta,2)}</td></tr>
          <tr><th>R₀</th><td>${fmt(k.Ro,1)}</td><th>R* / T*</th><td>R*=${fmt(k.Rstar,3)} ${k.Tstar ? `(T*=${fmt(k.Tstar,3)} s)` : `(${i18n.t('elástico')})`}</td></tr>
        </tbody></table>`;
        return `<h3>${i18n.t('Espectro de respuesta — dirección')} ${esc(p.direction)}</h3>
          ${tabla}
          <div class="spec-graph">${reportSpectrumSVG(p.spectrum)}</div>
          <p class="muted">Sa(T) = S·A₀·I·α(T)/R* (NCh433 / DS61). ${i18n.t('Unidad de Sa:')} ${esc(k.unidadSa || 'g')}.</p>`;
      }).join('');
    } else {
      sismoHTML = `<p class="muted">${i18n.t('No se ha ejecutado un análisis de espectro de respuesta. Ejecute «Análisis → Espectro de Respuesta (F7)» para documentar zona sísmica, suelo, importancia y el espectro de diseño.')}</p>`;
    }

    // ── Modal (3 modes) ─────────────────────────────────────────────────────
    let modalHTML = '';
    if (app._modalResults) {
      const { rows } = app._modalResults.getParticipation();
      const partRows = rows.slice(0, Math.max(3, Math.min(rows.length, 12))).map(r => `<tr>
        <td>${r.mode}</td><td>${fmt(r.freq,3)}</td><td>${fmt(r.period,3)}</td>
        <td>${fmt(r.pct[0],1)}</td><td>${fmt(r.pct[1],1)}</td><td>${fmt(r.pct[2],1)}</td>
        <td>${fmt(r.cumPct[0],1)}</td><td>${fmt(r.cumPct[1],1)}</td><td>${fmt(r.cumPct[2],1)}</td></tr>`).join('');
      const modeImgs = imgs.modos.map(md => `<figure>
        <img src="${md.img}" alt="${i18n.t('Modo')} ${md.n}">
        <figcaption>${i18n.t('Modo')} ${md.n} — f = ${fmt(md.freq,3)} Hz · T = ${fmt(md.period,3)} s</figcaption></figure>`).join('');
      modalHTML = `
        <p>${i18n.t('Modos extraídos:')} ${app._modalResults.nModes}. ${i18n.t('Frecuencias y períodos de los primeros modos:')}</p>
        <table><thead><tr><th>${i18n.t('Modo')}</th><th>f (Hz)</th><th>T (s)</th>
          <th>Mx (%)</th><th>My (%)</th><th>Mrz (%)</th><th>ΣMx</th><th>ΣMy</th><th>ΣMrz</th></tr></thead>
          <tbody>${partRows}</tbody></table>
        <p class="muted">${i18n.t('Mx/My/Mrz = masa modal participante (%). Σ = acumulada.')}</p>
        ${modeImgs ? `<div class="figrow">${modeImgs}</div>` : ''}`;
    } else {
      modalHTML = `<p class="muted">${i18n.t('No se ha ejecutado el análisis modal. Ejecute «Análisis → Análisis Modal (F6)» para documentar los modos de vibrar.')}</p>`;
    }

    // ── Model images ────────────────────────────────────────────────────────
    const idsNota = cm.mostrarIds ? ' — ' + i18n.t('con IDs de nodos y elementos') : '';
    const figBase = imgs.base ? `<figure><img src="${imgs.base}" alt="${i18n.t('Modelo base')}"><figcaption>${i18n.t('Modelo estructural (geometría base')}${idsNota})</figcaption></figure>` : '';
    const figDef  = imgs.deformada ? `<figure><img src="${imgs.deformada}" alt="${i18n.t('Deformada')}"><figcaption>${i18n.t('Deformada (resultado estático')}${idsNota})</figcaption></figure>`
      : `<p class="muted">${i18n.t('Deformada no disponible — ejecute el análisis estático (F5).')}</p>`;

    const s = m.getStats();

    // ── Design methods (only materials present) ─────────────────────────────
    const tipos = new Set([...m.materials.values()].map(mt => clasif(mt.name)));
    const nombreTipo = { steel:i18n.t('Acero estructural'), concrete:i18n.t('Hormigón armado'), timber:i18n.t('Madera') };
    const metodosHTML = dp ? [...tipos].map(t => {
      const p = dp[t] || {};
      let det = '';
      if (t === 'steel')    det = `Fy = ${fmt(p.Fy_MPa,0)} MPa · Fu = ${fmt(p.Fu_MPa,0)} MPa · E = ${fmt(p.E_MPa,0)} MPa · φ_b=${p.phi?.bending} φ_v=${p.phi?.shear} φ_c=${p.phi?.axial_compresion}`;
      if (t === 'concrete') det = `f′c = ${fmt(p.fc_MPa,0)} MPa · fy = ${fmt(p.fy_rebar_MPa,0)} MPa · cuantía ρ = ${fmt(p.long_reinf_ratio,3)} · rec. = ${fmt(p.cover_mm,0)} mm · φ_b=${p.phi?.bending} φ_v=${p.phi?.shear}`;
      if (t === 'timber')   det = `Fb = ${fmt(p.Fb_MPa,1)} · Fv = ${fmt(p.Fv_MPa,1)} · Fc = ${fmt(p.Fc_MPa,1)} · Ft = ${fmt(p.Ft_MPa,1)} MPa · ∏Ki = ${fmt(Object.values(p.modification_factors||{}).reduce((a,b)=>a*b,1),2)}`;
      return `<tr><th>${nombreTipo[t]}</th><td>${esc(p.method||'—')}<br><span class="muted">${det}</span></td></tr>`;
    }).join('') : `<tr><td colspan="2" class="muted">${i18n.t('Parámetros de diseño no disponibles.')}</td></tr>`;

    // ── Standards and codes ─────────────────────────────────────────────────
    const normas = [
      [i18n.t('Acción sísmica'), 'NCh433.Of96 Mod.2009 · DS61 (espectro de diseño)'],
      [i18n.t('Cargas y sobrecargas'), 'NCh1537.Of2009 (permanentes y sobrecargas de uso)'],
      [i18n.t('Combinaciones de carga'), 'NCh3171.Of2010 (disposiciones generales)'],
      [i18n.t('Viento'), 'NCh432.Of2010'],
      [i18n.t('Nieve'), 'NCh431.Of2010'],
      [i18n.t('Acero estructural'), 'NCh427/1 · ANSI/AISC 360-16 (LRFD)'],
      [i18n.t('Hormigón armado'), 'NCh430 · ACI 318'],
      [i18n.t('Madera estructural'), 'NCh1198 (tensiones admisibles modificadas)'],
    ].map(([a,b]) => `<tr><th>${a}</th><td>${esc(b)}</td></tr>`).join('');

    // ── Model load combinations ─────────────────────────────────────────────
    const lcName = id => m.loadCases.get(id)?.name || m.combinations?.get(id)?.name || `LC${id}`;
    const comboRows = [...(m.combinations?.values() || [])].map(c =>
      `<tr><td>${esc(c.name)}</td><td>${(c.factors||[]).map(f => `${fmt(f.factor,2)}·${esc(lcName(f.lcId))}`).join('  +  ') || '—'}</td></tr>`).join('')
      || `<tr><td colspan="2" class="muted">${i18n.t('No hay combinaciones definidas.')}</td></tr>`;

    // ── Allowable deflections ───────────────────────────────────────────────
    const fl = dp?.deflection_limits || {};
    const flechasHTML = `<table><tbody>
      <tr><th>${i18n.t('Viga — carga total')}</th><td>L / ${fl.beam_total_load_L_over ?? 300}</td>
          <th>${i18n.t('Viga — sobrecarga')}</th><td>L / ${fl.beam_live_load_L_over ?? 360}</td></tr>
      <tr><th>${i18n.t('Voladizo')}</th><td>L / ${fl.cantilever_L_over ?? 150}</td>
          <th>${i18n.t('δ máx del modelo')}</th><td>${app._results?.getMaxDisp ? fmt(app._results.getMaxDisp(),5)+' m' : '—'}</td></tr>
    </tbody></table>
    <p class="muted">${i18n.t('Límites como fracción de la luz L. La verificación de flecha por elemento debe contrastarse con la luz libre de cada vano.')}</p>`;

    // ── Element design: STRENGTH verification bending/shear/axial ──
    // (the service DEFLECTIONS go in their own section, not here).
    let disenoHTML;
    const rClass = r => r > 1.0 ? 'r-bad' : r > 0.9 ? 'r-warn' : 'r-ok';
    if (diseno && diseno.filas && diseno.filas.length) {
      const f = diseno.filas;
      const malo = x => x.ratioMax > 1;
      const aj   = x => !malo(x) && x.ratioMax > 0.9;
      const nNo = f.filter(malo).length;
      const nAj = f.filter(aj).length;
      const nOk = f.length - nNo - nAj;
      const top = f.slice(0, 60);
      const rows = top.map(x => `<tr>
        <td>#${x.id}</td><td>${esc(x.sec)}</td><td>${esc(x.mat)}</td><td title="${esc(x.combo||'')}">${esc((x.combo||'').slice(0,14))}</td>
        <td>${fmt(x.forces.N,1)}</td><td>${fmt(Math.max(x.forces.My,x.forces.Mz),1)}</td><td>${fmt(Math.max(x.forces.Vy,x.forces.Vz),1)}</td>
        <td class="${rClass(x.bending.ratio)}">${fmt(x.bending.ratio,2)}</td>
        <td class="${rClass(x.shear.ratio)}">${fmt(x.shear.ratio,2)}</td>
        <td class="${rClass(x.axial.ratio)}">${fmt(x.axial.ratio,2)}</td>
        <td class="${rClass(x.interaction?.ratio)}">${fmt(x.interaction?.ratio,2)}</td>
        <td>${x.governs}</td>
        <td class="${rClass(x.ratioMax)}"><b>${fmt(x.ratioMax,2)}</b></td>
        <td class="${malo(x)?'r-bad':aj(x)?'r-warn':'r-ok'}">${malo(x)?i18n.t('NO CUMPLE'):aj(x)?i18n.t('ajustado'):i18n.t('cumple')}</td></tr>`).join('');
      const alcance = diseno.envolvente ? i18n.t('envolvente de las combinaciones de carga') : `${i18n.t('el estado')} «${esc(diseno.caso||i18n.t('activo'))}»`;
      const shown = f.length > 60 ? `${i18n.t('Se muestran los 60 elementos más solicitados de')} ${f.length}. ` : '';
      disenoHTML = `
        <p>${i18n.t('Verificación de')} <b>${i18n.t('resistencia')}</b> ${i18n.t('por')} <b>${alcance}</b>:
        ${i18n.t('para cada elemento se reporta la combinación más desfavorable. La razón')} <b>D/C = ${i18n.t('demanda/capacidad')}</b> ${i18n.t('debe ser ≤ 1.0.')}
        ${i18n.t('Las deformaciones (servicio) se verifican en la sección de deformaciones de vigas. Parámetros en')} <code>assistant/design_params.json</code>.</p>
        <table style="font-size:9.5px"><thead><tr>
          <th>${i18n.t('Elem')}</th><th>${i18n.t('Sección')}</th><th>${i18n.t('Material')}</th><th>${i18n.t('Combo')}</th><th>N (kN)</th><th>M (kN·m)</th><th>V (kN)</th>
          <th>${i18n.t('flex.')}</th><th>${i18n.t('corte')}</th><th>${i18n.t('axial')}</th><th>${i18n.t('interac.')}</th><th>${i18n.t('Gobierna')}</th><th>${i18n.t('D/C máx')}</th><th>${i18n.t('Estado')}</th>
        </tr></thead><tbody>${rows}</tbody></table>
        <p class="muted">${shown}
        ${i18n.t('Resumen:')} <b class="r-ok">${nOk} ${i18n.t('cumplen')}</b> · <b class="r-warn">${nAj} ${i18n.t('ajustados')}</b> · <b class="r-bad">${nNo} ${i18n.t('no cumplen')}</b>.
        ${i18n.t('D/C: flexión/corte/axial e interacción flexo-axial. Colores: verde ≤ 0.90 · ámbar 0.90–1.00 · rojo > 1.00.')}</p>`;
    } else {
      disenoHTML = `<p class="muted">${i18n.t('No hay resultados de análisis para verificar. Ejecute el análisis estático (F5) con sus combinaciones de carga antes de generar la memoria.')}</p>`;
    }

    // ── Beam deflections (service · unfactored live load) ───────────────────
    let deflexHTML;
    if (deflex && deflex.rows && deflex.rows.length) {
      const dr = deflex.rows.slice(0, 60);
      const rows = dr.map(x => `<tr>
        <td>#${x.id}</td><td>${esc(x.sec)}</td><td>${fmt(x.L,2)}</td>
        <td>${fmt(x.delta*1000,2)}</td><td>L/${deflex.limSobre} = ${fmt(x.lim*1000,2)}</td>
        <td class="${rClass(x.ratio)}"><b>${fmt(x.ratio,2)}</b></td>
        <td class="${x.ratio>1?'r-bad':x.ratio>0.9?'r-warn':'r-ok'}">${x.ratio>1?i18n.t('NO CUMPLE'):x.ratio>0.9?i18n.t('ajustado'):i18n.t('cumple')}</td></tr>`).join('');
      const nNo = deflex.rows.filter(x => x.ratio > 1).length;
      const shown = deflex.rows.length > 60 ? `${i18n.t('Se muestran las 60 vigas más deformadas de')} ${deflex.rows.length}. ` : '';
      const resumen = nNo ? `<b class="r-bad">${nNo} ${i18n.t('viga(s) superan el límite.')}</b> ` : i18n.t('Todas cumplen el límite de servicio.') + ' ';
      deflexHTML = `
        <p>${i18n.t('Flecha de las')} <b>${i18n.t('vigas')}</b> ${i18n.t('(elementos casi horizontales) bajo el caso de')} <b>${i18n.t('sobrecarga de uso')} «${esc(deflex.caso)}» ${i18n.t('sin mayorar')}</b>
        ${i18n.t('(factor 1.0), medida respecto a la cuerda recta del vano. Límite de servicio')} L/${deflex.limSobre}.</p>
        <table style="font-size:9.5px"><thead><tr>
          <th>${i18n.t('Viga')}</th><th>${i18n.t('Sección')}</th><th>L (m)</th><th>δ (mm)</th><th>${i18n.t('δ admisible (mm)')}</th><th>δ/δadm</th><th>${i18n.t('Estado')}</th>
        </tr></thead><tbody>${rows}</tbody></table>
        <p class="muted">${shown}
        ${resumen}
        ${i18n.t('δ = flecha relativa máxima en el vano por sobrecarga de uso (sin mayorar).')}</p>`;
    } else {
      deflexHTML = `<p class="muted">${esc(deflex?.note || i18n.t('Sin datos de deformaciones de vigas.'))}</p>`;
    }

    // ── Seismic story drifts (NCh433) ─────────────────────────────────────────
    let driftHTML;
    if (drift && drift.dirs && drift.dirs.length) {
      const cls = ok => ok === false ? 'r-bad' : ok === true ? 'r-ok' : '';
      const lblOk = ok => ok === false ? i18n.t('NO CUMPLE') : ok === true ? i18n.t('cumple') : '—';
      const cell = (v, d = 5) => v == null ? '—' : fmt(v, d);
      driftHTML = drift.dirs.map(D => {
        const rows = D.stories.map(s => `<tr>
          <td>${s.piso}</td><td>${fmt(s.z,2)}</td><td>${fmt(s.h,2)}</td>
          <td>${cell(s.driftCM)}</td><td class="${cls(s.okCM)}">${cell(s.ratioCM,2)}</td><td class="${cls(s.okCM)}">${lblOk(s.okCM)}</td>
          <td>${cell(s.driftExt)}</td><td class="${cls(s.okExt)}">${cell(s.ratioExt,2)}</td><td class="${cls(s.okExt)}">${lblOk(s.okExt)}</td></tr>`).join('');
        return `<h3>${i18n.t('Dirección sísmica')} ${esc(D.dir)}</h3>
        <table style="font-size:9.5px"><thead><tr>
          <th>${i18n.t('Piso')}</th><th>Z (m)</th><th>h (m)</th>
          <th>δ/h (CM)</th><th>·/0.002</th><th>${i18n.t('Estado CM')}</th>
          <th>δ/h (ext.)</th><th>·/0.002</th><th>${i18n.t('Estado ext.')}</th>
        </tr></thead><tbody>${rows || `<tr><td colspan="9" class="muted">${i18n.t('Sin entrepisos.')}</td></tr>`}</tbody></table>`;
      }).join('');
      driftHTML += `<p class="muted">${i18n.t('Deriva de entrepiso δ/h = desplazamiento relativo entre pisos consecutivos ÷ altura de entrepiso.')}
        <b>${i18n.t('Límite NCh433: 0.002')}</b> ${i18n.t('(2/1000) tanto entre')} <b>${i18n.t('centros de masa')}</b> (Art. 5.9.2) ${i18n.t('como entre')} <b>${i18n.t('nodos externos')}</b> ${i18n.t('del piso (Art. 5.9.3).')}
        ${i18n.t('Calculada con los desplazamientos del espectro de respuesta.')}${drift.hasCM ? '' : ` <i>${i18n.t('Sin diafragmas: se reporta solo la deriva entre nodos externos.')}</i>`}</p>`;
    } else {
      driftHTML = `<p class="muted">${esc(drift?.note || i18n.t('Sin datos de derivas sísmicas.'))}</p>`;
    }

    // ── Cover page (configurable per project) ───────────────────────────────
    // The logo/institution come from the report configuration (empty by default
    // in the open edition). The company logo (PRO) is shown if loaded.
    const tieneLogoPro = !!(app._brandingPro && cm.logoEmpresa);
    const logosAcad = '';
    const logoEmp = tieneLogoPro ? `<div class="cover-logo-emp"><img src="${esc(cm.logoEmpresa)}" alt="${i18n.t('Empresa')}"></div>` : '';
    const portada = `<section class="cover">
      ${logoEmp}${logosAcad}
      <div class="cover-inst">${esc(cm.institucion || '')}<br><span>${esc(cm.subInstitucion || '')}</span></div>
      <svg class="cover-frame" viewBox="0 0 360 200" aria-hidden="true">
        <path d="M60 175 V55 H300 V175" fill="none" stroke="#0a3a57" stroke-width="4" stroke-linecap="round"/>
        <path d="M46 188 L74 188 L60 175 Z" fill="#0d9488"/><path d="M286 188 L314 188 L300 175 Z" fill="#0d9488"/>
        <path d="M44 188 H76 M284 188 H316" stroke="#0a3a57" stroke-width="2"/>
        <circle cx="60" cy="55" r="5" fill="#0e7fc0"/><circle cx="300" cy="55" r="5" fill="#0e7fc0"/>
      </svg>
      <div class="cover-kicker">${esc(cm.kicker || i18n.t('ANÁLISIS Y DISEÑO ESTRUCTURAL'))}</div>
      <h1 class="cover-title">${esc(cm.titulo || i18n.t('Memoria de Cálculo'))}</h1>
      <div class="cover-proj">${esc(proyecto)}</div>
      ${tieneLogoPro ? '' : `<div class="cover-badge">${i18n.t('Generado con PORTICO — análisis estructural 3D')}</div>`}
      <table class="cover-meta"><tbody>
        <tr><th>${i18n.t('Proyecto')}</th><td>${esc(proyecto)}</td></tr>
        <tr><th>${i18n.t('Fecha')}</th><td>${esc(fecha)}</td></tr>
        <tr><th>${i18n.t('Unidades')}</th><td>${esc(U.replace('-',' · '))}</td></tr>
        <tr><th>${i18n.t('Proyectista')}</th><td>${esc(cm.proyectista) || '&nbsp;'}</td></tr>
        <tr><th>${i18n.t('Revisó')}</th><td>${esc(cm.revisor) || '&nbsp;'}</td></tr>
      </tbody></table>
      <p class="cover-note">${i18n.t('Documento de carácter orientativo. Los resultados deben ser validados por un profesional competente antes de cualquier uso en obra.')}</p>
    </section>`;
    const descripcionHTML = (app._brandingPro && cm.descripcion) ? `<p>${esc(cm.descripcion)}</p>` : '';
    // Footer and limitations: academic by default; editable only with a professional token.
    const footerTxt = (app._brandingPro && cm.footer) ? cm.footer : app._ACAD_FOOTER;
    const limitItems = (app._brandingPro && cm.limitaciones)
      ? cm.limitaciones.split('\n').map(s => s.trim()).filter(Boolean).map(esc)
      : app._ACAD_LIMITS;
    const limitHTML = limitItems.map(li => `<li>${li}</li>`).join('');

    return `<!DOCTYPE html><html lang="${i18n.getLocale()}"><head><meta charset="utf-8">
<base href="${esc(location.origin)}/">
<title>${esc(cm.titulo || i18n.t('Memoria de Cálculo'))} — ${esc(proyecto)}</title>
<style>
  :root{--ink:#1b2533;--mut:#5c6a7d;--bd:#cdd6e3;--ac:#0e7fc0;--head:#0a3a57;--teal:#0d9488;}
  *{box-sizing:border-box;}
  body{font-family:'Segoe UI',system-ui,sans-serif;color:var(--ink);margin:0;padding:30px 40px 64px;font-size:12px;line-height:1.5;}
  h1{font-size:22px;color:var(--head);margin:0 0 2px;}
  h2{font-size:15px;color:var(--head);border-bottom:2px solid var(--ac);padding-bottom:3px;margin:24px 0 10px;}
  h3{font-size:13px;color:var(--head);margin:15px 0 6px;}
  .sub{color:var(--mut);font-size:12px;margin:0 0 4px;}
  table{width:100%;border-collapse:collapse;margin:6px 0 12px;font-size:11px;}
  th,td{border:1px solid var(--bd);padding:4px 7px;text-align:left;vertical-align:top;}
  th{background:#eef3f9;color:var(--head);font-weight:600;}
  td{font-variant-numeric:tabular-nums;}
  code{background:#eef3f9;padding:0 4px;border-radius:3px;font-size:11px;}
  .muted{color:var(--mut);}
  .tag{display:inline-block;background:var(--ac);color:#fff;font-size:9px;padding:1px 7px;border-radius:9px;vertical-align:middle;font-weight:600;}
  .tag-pp{background:#15803d;}
  figure{margin:8px 0;text-align:center;}
  img{max-width:100%;border:1px solid var(--bd);border-radius:6px;background:#f6f8fb;}
  figcaption{color:var(--mut);font-size:10px;margin-top:3px;}
  .figrow{display:flex;flex-wrap:wrap;gap:10px;}
  .figrow figure{flex:1 1 30%;min-width:200px;margin:4px 0;}
  .spec-graph{border:1px solid var(--bd);border-radius:6px;padding:6px;background:#f6f8fb;max-width:480px;}
  .r-ok{background:#e8f6ed;color:#15803d;} .r-warn{background:#fdf3e2;color:#b45309;} .r-bad{background:#fde8e8;color:#dc2626;font-weight:700;}
  .print-btn{position:fixed;top:12px;right:12px;background:var(--ac);color:#fff;border:none;padding:8px 16px;border-radius:6px;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2);z-index:10;}
  .page-footer{position:fixed;bottom:0;left:0;right:0;height:42px;display:flex;align-items:center;justify-content:space-between;
    padding:0 40px;font-size:9px;color:var(--mut);border-top:1px solid var(--bd);background:#fff;}
  .page-footer b{color:var(--head);}
  .cover{min-height:88vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;page-break-after:always;}
  .cover-logos{display:flex;gap:22px;align-items:center;justify-content:center;margin-bottom:10px;flex-wrap:wrap;}
  .cover-logos img{height:46px;width:auto;border:none;background:none;border-radius:0;}
  .cover-logo-emp{margin-bottom:8px;} .cover-logo-emp img{height:54px;width:auto;border:none;background:none;}
  .cover-inst{font-size:12px;letter-spacing:.5px;color:var(--head);font-weight:600;margin-bottom:6px;}
  .cover-inst span{display:block;font-weight:400;color:var(--mut);font-size:10px;letter-spacing:0;}
  .cover-frame{width:240px;height:auto;margin:14px 0;}
  .cover-kicker{letter-spacing:3px;font-size:12px;color:var(--teal);font-weight:600;}
  .cover-title{font-size:38px;color:var(--head);margin:4px 0 2px;letter-spacing:1px;}
  .cover-proj{font-size:16px;color:var(--ink);margin-bottom:14px;}
  .cover-badge{max-width:480px;font-size:11px;color:var(--mut);border:1px dashed var(--bd);border-radius:8px;padding:8px 12px;margin-bottom:18px;}
  .cover-meta{max-width:420px;font-size:12px;} .cover-meta th{width:120px;}
  .cover-note{max-width:480px;font-size:10px;color:var(--mut);margin-top:16px;font-style:italic;}
  @media print{.print-btn{display:none;} h2{break-after:avoid;} table,figure{break-inside:avoid;} body{padding:0 40px 64px;}}
</style></head><body>
<button class="print-btn" onclick="window.print()">${i18n.t('🖨 Imprimir / Guardar PDF')}</button>
<div class="page-footer"><span><b>PORTICO</b> · ${esc(cm.titulo || i18n.t('Memoria de Cálculo'))} — ${esc(proyecto)}</span>
  <span>${esc(footerTxt)}</span>
  <span>${esc(fecha)}</span></div>

${portada}

<h2>${i18n.t('1. Bases de cálculo')}</h2>

<h3>${i18n.t('1.1 Descripción del modelo')}</h3>
${descripcionHTML}
<table><tbody>
  <tr><th>${i18n.t('Nodos')}</th><td>${s.nodes}</td><th>${i18n.t('Elementos')}</th><td>${s.elements}</td></tr>
  <tr><th>${i18n.t('Materiales')}</th><td>${s.materials}</td><th>${i18n.t('Secciones')}</th><td>${s.sections}</td></tr>
  <tr><th>${i18n.t('Modo del proyecto')}</th><td>${esc(m.mode || '3D')}</td><th>${i18n.t('Casos de carga')}</th><td>${m.loadCases.size}</td></tr>
</tbody></table>
${figBase}

<h3>${i18n.t('1.2 Métodos de diseño')}</h3>
<table><tbody>${metodosHTML}</tbody></table>

<h3>${i18n.t('1.3 Normas y códigos')}</h3>
<table><tbody>${normas}</tbody></table>

<h3>${i18n.t('1.4 Materiales y propiedades mecánicas')}</h3>
<table><thead><tr><th>${i18n.t('Material')}</th><th>E (kN/m²)</th><th>G (kN/m²)</th><th>ν</th><th>ρ (t/m³)</th></tr></thead>
<tbody>${matRows}</tbody></table>

<h3>${i18n.t('1.5 Secciones')}</h3>
<table><thead><tr><th>${i18n.t('Sección')}</th><th>A (m²)</th><th>Iy (m⁴)</th><th>Iz (m⁴)</th><th>J (m⁴)</th><th>Avy (m²)</th><th>Avz (m²)</th><th>${i18n.t('Modif. rigidez')}</th><th>${i18n.t('# elem')}</th></tr></thead>
<tbody>${secRows}</tbody></table>

<h3>${i18n.t('1.6 Cargas y sobrecargas')}</h3>
${cargasHTML}

<h3>${i18n.t('1.7 Acción sísmica')}</h3>
${sismoHTML}

<h3>${i18n.t('1.8 Combinaciones de carga')}</h3>
<table><thead><tr><th>${i18n.t('Combinación')}</th><th>${i18n.t('Factores')}</th></tr></thead><tbody>${comboRows}</tbody></table>

<h3>${i18n.t('1.9 Flechas admisibles')}</h3>
${flechasHTML}

<h2>${i18n.t('2. Análisis estructural')}</h2>
<h3>${i18n.t('2.1 Modelo deformado')}</h3>
${figDef}
<h3>${i18n.t('2.2 Análisis modal — modos de vibrar')}</h3>
${modalHTML}

<h2>${i18n.t('3. Diseño de elementos (resistencia)')}</h2>
${disenoHTML}

<h2>${i18n.t('4. Verificaciones de servicio')}</h2>
<h3>${i18n.t('4.1 Deformaciones de vigas — sobrecarga de uso (sin mayorar)')}</h3>
${deflexHTML}
<h3>${i18n.t('4.2 Derivas sísmicas de entrepiso — NCh433 (límite 2/1000·h)')}</h3>
${driftHTML}

<h2>${i18n.t('5. Limitaciones y alcances')}</h2>
<ul style="font-size:11px;line-height:1.6">${limitHTML}</ul>
</body></html>`;
  }

export function reportSpectrumSVG(pts) {
    if (!Array.isArray(pts) || pts.length < 2) return `<p class="muted">${i18n.t('Sin curva.')}</p>`;
    const W = 460, H = 220, ml = 46, mr = 12, mt = 12, mb = 30;
    const Tmax = Math.max(...pts.map(p => p.T)) || 1;
    const Smax = Math.max(...pts.map(p => p.Sa)) || 1;
    const sx = t => ml + (t / Tmax) * (W - ml - mr);
    const sy = s => H - mb - (s / Smax) * (H - mt - mb);
    const poly = pts.map(p => `${sx(p.T).toFixed(1)},${sy(p.Sa).toFixed(1)}`).join(' ');
    const gx = [0,0.25,0.5,0.75,1].map(f => { const t=+(f*Tmax).toFixed(2);
      return `<line x1="${sx(t)}" y1="${mt}" x2="${sx(t)}" y2="${H-mb}" stroke="#dde5ef"/><text x="${sx(t)}" y="${H-10}" fill="#5c6a7d" font-size="9" text-anchor="middle">${t}</text>`; }).join('');
    const gy = [0,0.25,0.5,0.75,1].map(f => { const sv=+(f*Smax).toFixed(3);
      return `<line x1="${ml}" y1="${sy(sv)}" x2="${W-mr}" y2="${sy(sv)}" stroke="#dde5ef"/><text x="${ml-5}" y="${sy(sv)+3}" fill="#5c6a7d" font-size="9" text-anchor="end">${sv}</text>`; }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
      ${gy}${gx}
      <polyline points="${poly}" fill="none" stroke="#0e7fc0" stroke-width="2"/>
      <text x="${ml}" y="${mt-1}" fill="#5c6a7d" font-size="9">Sa</text>
      <text x="${W-mr}" y="${H-2}" fill="#5c6a7d" font-size="9" text-anchor="end">T (s)</text>
    </svg>`;
  }
