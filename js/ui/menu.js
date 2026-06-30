// ──────────────────────────────────────────────────────────────────────────────
// MenuBar — top menu + left toolbar wiring
// ──────────────────────────────────────────────────────────────────────────────

export class MenuBar {
  constructor(menuEl, app) {
    this.menu = menuEl;
    this.app  = app;
    this._init();
  }

  _init() {
    // ── Dropdown menu actions ─────────────────────────────────────────────────
    this.menu.querySelectorAll('[data-action]').forEach(item => {
      item.addEventListener('click', e => {
        e.stopPropagation();
        const action = e.currentTarget.dataset.action;
        this._handleAction(action);
        // Close dropdown
        document.querySelectorAll('.menu-root').forEach(r => r.classList.remove('open'));
      });
    });

    // Open / close dropdowns on click (for mobile / accessibility)
    this.menu.querySelectorAll('.menu-root').forEach(root => {
      root.querySelector('.menu-label')?.addEventListener('click', () => {
        const isOpen = root.classList.contains('open');
        document.querySelectorAll('.menu-root').forEach(r => r.classList.remove('open'));
        if (!isOpen) root.classList.add('open');
      });
    });

    // Close on outside click
    document.addEventListener('click', () => {
      document.querySelectorAll('.menu-root').forEach(r => r.classList.remove('open'));
    });

    // ── Left toolbar ──────────────────────────────────────────────────────────
    document.querySelectorAll('.tool[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.app.viewport.setMode(btn.dataset.mode);
      });
    });

    document.getElementById('btn-zoomext')?.addEventListener('click', () => {
      this.app.viewport.zoomExtents();
    });

    // ── Unit selector ─────────────────────────────────────────────────────────
    document.getElementById('unit-select').addEventListener('change', e => {
      this.app.model.units = e.target.value;
      document.getElementById('sb-units').textContent = e.target.value.replace('-', ' — ');
      this.app.markDirty();
    });
  }

  _handleAction(action) {
    const a = this.app;
    switch (action) {
      case 'new':         a.newFile();        break;
      case 'open':        a.openFile();       break;
      case 'save':        a.saveFile();       break;
      case 'saveas':      a.saveFileAs();     break;
      case 'manage-autosaves': a.manageAutosavesDialog(); break;
      case 'importcsv':   a.importCSV();      break;
      case 'exportcsv':   a.exportCSV();      break;
      case 'import-interop': a.importInterop(); break;
      case 'export-interop': a.exportInterop(); break;
      case 'import-ifc':     a.importIFC();     break;
      case 'export-ifc':     a.exportIFC();     break;
      case 'template':    a.downloadTemplate(); break;
      case 'undo':        a.undo();           break;
      case 'redo':        a.redo();           break;
      case 'selectall':   a.viewport.selectAll(); break;
      case 'delete':      a.deleteSelected(); break;
      case 'disc-all':    a.discretizeAllDialog();    break;
      case 'join-elems':  a.joinSelectedElements();   break;
      case 'inter-elems': a.joinIntersection();       break;
      case 'crear-area':  a.createAreaFromSelection();     break;
      case 'mallar-panel':  a.viewport.startMeshPick('panel'); break;   // #78: modo → clic en nodos
      case 'mallar-region': a.viewport.startMeshPick('free');  break;
      case 'suavizar-malla': a.suavizarMalla();       break;
      case 'crear-link':   a.createLinkFromSelection();    break;
      case 'muro-relleno': a.createInfillWallFromSelection(); break;
      case 'grids':       a.defineGridsDialog();      break;
      case 'global-matrices': a.showGlobalMatrices(); break;
      case 'help-guia':     a.openHelp('guia');     break;
      case 'help-signos':   a.openHelp('signos');   break;
      case 'help-ejemplos': a.openHelp('ejemplos'); break;
      case 'help-acerca':   a.openHelp('acerca');   break;
      case 'view-iso':    a.viewport.setView('iso');   break;
      case 'view-top':    a.viewport.setView('top');   break;
      case 'view-front':  a.viewport.setView('front'); break;
      case 'view-side':   a.viewport.setView('side');  break;
      case 'toggle-grid':    a.viewport.toggleGrid();        break;
      case 'toggle-axes':    a.viewport.toggleAxes();        break;
      case 'zoom-extents':   a.viewport.zoomExtents();       break;
      case 'hide-sel':       a.hideSelected();               break;
      case 'show-all':       a.showAllElements();            break;
      case 'toggle-loads':   a.viewport.toggleLoads();       break;
      case 'run':            a.runAnalysis();                break;
      case 'run-force':      a.runAnalysis(true);            break;
      case 'run-modal':      a.runModal();                   break;
      case 'run-spectrum':   a.runSpectrum();                break;
      case 'run-timehistory': a.runTimeHistory();            break;
      case 'run-nonlinear':  a._runByAction('run-nonlinear'); break;
      case 'run-corotbeam':  a._runByAction('run-corotbeam'); break;
      case 'run-pdelta':     a._runByAction('run-pdelta');    break;
      case 'run-buckling':   a._runByAction('run-buckling');  break;
      case 'run-formfind':   a.runFormFinding();             break;
      case 'run-plastic':    a.runPlastic();                 break;
      case 'run-pushover-dc': a.runPushoverDC();             break;
      case 'run-nlth':       a.runNLTimeHistory();           break;
      case 'run-staged':     a.runStaged();                  break;
      case 'run-tendon':     a.runTendon();                  break;
      case 'run-moving':     a.runMovingLoad();              break;
      case 'combos':         a.openCombosTab();              break;
      case 'combos-norma':   a.createCodeCasesAndCombos();     break;
      case 'diag-estabilidad': a.runStabilityDiagnosis();    break;
      case 'assistant':      a.assistantDialog();            break;
      case 'res-deformed':   a.setResultType('deformed');    break;
      case 'res-N':          a.setResultType('N');           break;
      case 'res-Vy':         a.setResultType('Vy');          break;
      case 'res-Vz':         a.setResultType('Vz');          break;
      case 'res-T':          a.setResultType('T');           break;
      case 'res-My':         a.setResultType('My');          break;
      case 'res-Mz':         a.setResultType('Mz');          break;
      case 'res-vm':         a.setResultType('vm');          break;
      case 'export-results': a.exportResults();              break;
      case 'export-modal':   a.exportModalResults();         break;
      case 'export-spectrum': a.exportSpectrumResults();     break;
      case 'bases-calculo':  a.generateCalcBasis();        break;
      case 'memoria-docx':   a.generateReportDocx();         break;
      case 'clear-results':  a.clearResultsConfirm();        break;
    }
  }
}
