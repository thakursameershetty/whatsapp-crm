// Spreadsheet grid: a virtualised table that edits like Google Sheets. Click,
// shift-click or drag to select; type or double-click to edit; copy and paste
// tab-separated cells (what Excel and Sheets put on the clipboard); undo / redo;
// insert and delete rows and columns; sort, filter and find & replace.
//
// It knows nothing about WhatsApp. The page hands it a sheet object and hooks
// for row ticks and cell styling (the phone column), and hears about every edit.
//
//   sheet = { headers: [names], rows: [{ cells: [strings], on: true }], widths: [px],
//             filters: { [col]: { values?: Set, text?: string } }, sel?: {...} }
//   Sheet.create(rootEl, hooks) → grid API (see the bottom of create()).

(function () {
  const RH = 30; // row height in px; rows are fixed height so only visible ones are drawn
  const OVERSCAN = 12;
  const MAX_UNDO = 200;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Spreadsheet column letters: A … Z, AA, AB, …
  function letter(i) {
    let s = '';
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  // Clipboard text from Excel / Sheets: tab-separated, quoted cells may contain tabs or newlines.
  function parseTsv(text) {
    text = String(text).replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const delim = text.includes('\t') ? '\t' : null;
    if (!delim) return text.split('\n').map((l) => [l]);
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    row.push(cell);
    rows.push(row);
    return rows;
  }
  const tsvCell = (v) => (/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

  function create(root, hooks) {
    root.classList.add('sg-root');
    root.tabIndex = 0;
    root.innerHTML = '<table class="sg"><colgroup></colgroup><thead></thead><tbody></tbody></table><input class="sg-edit hidden" spellcheck="false" autocomplete="off" />';
    const table = root.querySelector('table');
    const colgroup = table.querySelector('colgroup');
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    const editor = root.querySelector('.sg-edit');
    let history = [], future = [];
    let editing = null; // { r, c } while the editor is open (r = -1 is the header row)
    let dragging = false;
    let raf = 0;

    const sheet = () => hooks.sheet();
    const S = () => {
      const sh = sheet();
      sh.sel ||= { ar: 0, ac: 0, fr: 0, fc: 0 }; // anchor and focus, in view rows
      return sh.sel;
    };
    const nCols = () => sheet()?.headers.length || 0;
    const view = () => sheet()?.view || [];

    // --- Model helpers -------------------------------------------------------

    function passes(sh, row) {
      for (const [c, f] of Object.entries(sh.filters || {})) {
        const v = String(row.cells[c] ?? '');
        if (f.values && !f.values.has(v)) return false;
        if (f.text && !v.toLowerCase().includes(f.text.toLowerCase())) return false;
      }
      return true;
    }
    function computeView(sh = sheet()) {
      if (!sh) return;
      sh.filters ||= {};
      sh.index = new Map(sh.rows.map((r, i) => [r, i]));
      // matching: rows the column filters let through. view: what's drawn, which the page can narrow
      // further (e.g. "show only invalid numbers") without changing what matches.
      sh.matching = sh.rows.filter((r) => passes(sh, r));
      sh.view = hooks.rowFilter ? sh.matching.filter((r) => hooks.rowFilter(sh, r)) : sh.matching;
    }
    const range = () => {
      const s = S();
      return { r1: Math.min(s.ar, s.fr), r2: Math.max(s.ar, s.fr), c1: Math.min(s.ac, s.fc), c2: Math.max(s.ac, s.fc) };
    };
    function clampSel() {
      const s = S(), maxR = Math.max(0, view().length - 1), maxC = Math.max(0, nCols() - 1);
      s.ar = Math.min(Math.max(s.ar, 0), maxR); s.fr = Math.min(Math.max(s.fr, 0), maxR);
      s.ac = Math.min(Math.max(s.ac, 0), maxC); s.fc = Math.min(Math.max(s.fc, 0), maxC);
    }
    function emptyRow(n = nCols()) {
      return { cells: Array.from({ length: n }, () => ''), on: true };
    }
    const uniqueName = (sh, name, skip = -1) => {
      let n = String(name).trim() || `Column ${letter(sh.headers.length)}`;
      const base = n;
      for (let k = 2; sh.headers.some((h, i) => i !== skip && h === n); k++) n = `${base} (${k})`;
      return n;
    };

    // --- History: every change is an op with do/undo, so undo works across everything ---

    function run(op) {
      op.sheet = sheet();
      op.do();
      history.push(op);
      if (history.length > MAX_UNDO) history.shift();
      future = [];
      after(op.kind);
    }
    function undo() {
      const op = history.pop();
      if (!op) return;
      if (op.sheet !== sheet()) hooks.activate?.(op.sheet);
      op.undo();
      future.push(op);
      after(op.kind);
    }
    function redo() {
      const op = future.pop();
      if (!op) return;
      if (op.sheet !== sheet()) hooks.activate?.(op.sheet);
      op.do();
      history.push(op);
      after(op.kind);
    }
    function after(kind) {
      hooks.prepare?.(sheet(), kind); // e.g. re-check phone numbers, before deciding what to show
      computeView();
      clampSel();
      hooks.changed?.(kind);
      render();
    }

    // Set many cells at once. changes: [{ row, c, v }]; grows columns as needed.
    function setCells(changes, label = 'Edit') {
      const real = changes.filter((x) => String(x.row.cells[x.c] ?? '') !== String(x.v));
      if (!real.length) return;
      const before = real.map((x) => x.row.cells[x.c] ?? '');
      run({
        kind: 'cells',
        label,
        do: () => real.forEach((x) => { x.row.cells[x.c] = String(x.v); }),
        undo: () => real.forEach((x, i) => { x.row.cells[x.c] = before[i]; }),
      });
    }

    function insertRows(at, count = 1, rows = null) {
      const sh = sheet();
      const made = rows || Array.from({ length: count }, () => emptyRow());
      run({
        kind: 'rows',
        do: () => sh.rows.splice(at, 0, ...made),
        undo: () => sh.rows.splice(at, made.length),
      });
      return made;
    }

    function deleteRows(rowObjs) {
      const sh = sheet();
      if (!rowObjs.length) return;
      const idx = rowObjs.map((r) => sh.rows.indexOf(r)).filter((i) => i >= 0).sort((a, b) => a - b);
      const saved = idx.map((i) => sh.rows[i]);
      run({
        kind: 'rows',
        do: () => { for (let k = idx.length - 1; k >= 0; k--) sh.rows.splice(idx[k], 1); },
        undo: () => idx.forEach((i, k) => sh.rows.splice(i, 0, saved[k])),
      });
    }

    function insertCol(at, name) {
      const sh = sheet();
      const nm = uniqueName(sh, name || `Column ${letter(sh.headers.length)}`);
      const shiftFilters = (d) => { const f = {}; for (const [c, v] of Object.entries(sh.filters)) f[+c >= at ? +c + d : c] = v; sh.filters = f; };
      run({
        kind: 'cols',
        do: () => {
          sh.headers.splice(at, 0, nm);
          sh.widths.splice(at, 0, 140);
          sh.rows.forEach((r) => r.cells.splice(at, 0, ''));
          shiftFilters(1);
          hooks.colsMoved?.(sh, at, 1);
        },
        undo: () => {
          sh.headers.splice(at, 1);
          sh.widths.splice(at, 1);
          sh.rows.forEach((r) => r.cells.splice(at, 1));
          shiftFilters(-1);
          hooks.colsMoved?.(sh, at, -1);
        },
      });
    }

    function deleteCol(at) {
      const sh = sheet();
      if (sh.headers.length <= 1) return hooks.notify?.("A sheet needs at least one column");
      const name = sh.headers[at], width = sh.widths[at], vals = sh.rows.map((r) => r.cells[at] ?? ''), filter = sh.filters[at];
      // Filters are keyed by column index: drop this column's, shift the ones after it.
      const remove = () => { const f = {}; for (const [c, v] of Object.entries(sh.filters)) if (+c !== at) f[+c > at ? +c - 1 : c] = v; sh.filters = f; };
      const restore = () => { const f = {}; for (const [c, v] of Object.entries(sh.filters)) f[+c >= at ? +c + 1 : c] = v; if (filter) f[at] = filter; sh.filters = f; };
      run({
        kind: 'cols',
        do: () => {
          sh.headers.splice(at, 1);
          sh.widths.splice(at, 1);
          sh.rows.forEach((r) => r.cells.splice(at, 1));
          remove();
          hooks.colsMoved?.(sh, at, -1, name);
        },
        undo: () => {
          sh.headers.splice(at, 0, name);
          sh.widths.splice(at, 0, width);
          sh.rows.forEach((r, i) => r.cells.splice(at, 0, vals[i]));
          restore();
          hooks.colsMoved?.(sh, at, 1, name);
        },
      });
    }

    function renameCol(c, name) {
      const sh = sheet();
      const old = sh.headers[c], nm = uniqueName(sh, name, c);
      if (nm === old) return;
      run({
        kind: 'rename',
        do: () => { sh.headers[c] = nm; hooks.renamed?.(sh, old, nm); },
        undo: () => { sh.headers[c] = old; hooks.renamed?.(sh, nm, old); },
      });
    }

    function sortBy(c, dir) {
      const sh = sheet();
      const before = sh.rows.slice();
      // Empty cells go last either way, like Sheets.
      const after = sh.rows.slice().sort((a, b) => {
        const x = String(a.cells[c] ?? ''), y = String(b.cells[c] ?? '');
        if (!x !== !y) return x ? -1 : 1;
        return dir * collator.compare(x, y);
      });
      run({ kind: 'sort', do: () => { sh.rows = after.slice(); }, undo: () => { sh.rows = before.slice(); } });
    }

    // --- Rendering ------------------------------------------------------------

    function render() {
      const sh = sheet();
      if (!sh) { thead.innerHTML = tbody.innerHTML = colgroup.innerHTML = ''; return; }
      if (!sh.view) computeView(sh);
      sh.widths ||= [];
      while (sh.widths.length < sh.headers.length) sh.widths.push(140);
      colgroup.innerHTML = `<col style="width:${hooks.indexWidth || 64}px">` + sh.headers.map((_, c) => `<col style="width:${sh.widths[c]}px">`).join('') + '<col class="sg-fill-col">';
      sizeTable();
      const all = hooks.allChecked?.(sh);
      thead.innerHTML = `
        <tr class="sg-letters"><th class="sg-corner" rowspan="2">${hooks.checkable ? `<input type="checkbox" class="cb sg-all" title="Tick or untick every row shown" ${all === true ? 'checked' : ''} />` : ''}</th>
          ${sh.headers.map((_, c) => `<th data-c="${c}" class="${inCols(c) ? 'on' : ''}"><span>${letter(c)}</span><button class="sg-menu" data-menu="${c}" tabindex="-1" aria-label="Column ${letter(c)} options">▾</button><span class="sg-rz" data-rz="${c}"></span></th>`).join('')}<th class="sg-fill" rowspan="2"></th></tr>
        <tr class="sg-names">${sh.headers.map((h, c) => {
          const tag = hooks.headerTag?.(sh, c) || '';
          const filtered = sh.filters[c] ? '<span class="sg-filtered" title="Filtered">⚲</span>' : '';
          return `<th data-name="${c}" class="${inCols(c) ? 'on' : ''}" title="${escHtml(h)} · double-click to rename">${tag}<span class="sg-hname">${escHtml(h)}</span>${filtered}</th>`;
        }).join('')}</tr>`;
      const corner = thead.querySelector('.sg-all');
      if (corner) corner.indeterminate = all === null;
      renderBody();
    }
    const inCols = (c) => { const r = range(); return c >= r.c1 && c <= r.c2; };
    // The columns keep their widths; a filler column takes whatever space is left.
    function sizeTable() {
      const sh = sheet();
      const w = (hooks.indexWidth || 64) + sh.widths.reduce((a, b) => a + b, 0);
      table.style.width = Math.max(w, root.clientWidth) + 'px';
    }

    function renderBody() {
      const sh = sheet();
      if (!sh) return;
      const v = sh.view;
      const headH = thead.offsetHeight || 2 * RH;
      const top = Math.max(0, root.scrollTop - headH);
      const first = Math.max(0, Math.floor(top / RH) - OVERSCAN);
      const last = Math.min(v.length, Math.ceil((top + root.clientHeight) / RH) + OVERSCAN);
      const rg = range(), s = S();
      let html = `<tr class="sg-spacer" style="height:${first * RH}px"><td colspan="${nCols() + 2}"></td></tr>`;
      for (let r = first; r < last; r++) {
        const row = v[r];
        const rowSel = r >= rg.r1 && r <= rg.r2;
        const meta = hooks.rowInfo?.(sh, row) || {};
        html += `<tr data-r="${r}" class="${meta.cls || ''}"><th class="sg-rh ${rowSel ? 'on' : ''}">${hooks.checkable ? `<input type="checkbox" class="cb sg-check" ${meta.checked ? 'checked' : ''} ${meta.disabled ? 'disabled' : ''} tabindex="-1" title="${escHtml(meta.checkTitle || '')}" />` : ''}<span>${(sh.index.get(row) ?? r) + 1}</span></th>`;
        for (let c = 0; c < sh.headers.length; c++) {
          const val = row.cells[c] ?? '';
          const sel = rowSel && c >= rg.c1 && c <= rg.c2;
          const act = r === s.fr && c === s.fc;
          const cell = hooks.cellInfo?.(sh, row, c) || {};
          html += `<td data-c="${c}" class="${sel ? 'sel' : ''}${act ? ' act' : ''}${cell.cls ? ' ' + cell.cls : ''}"${cell.title ? ` title="${escHtml(cell.title)}"` : ''}>${escHtml(val)}</td>`;
        }
        html += '<td class="sg-fill"></td></tr>';
      }
      html += `<tr class="sg-spacer" style="height:${(v.length - last) * RH}px"><td colspan="${nCols() + 2}"></td></tr>`;
      tbody.innerHTML = html;
      if (!v.length) tbody.insertAdjacentHTML('afterbegin', `<tr><td class="sg-none" colspan="${nCols() + 2}">${escHtml(hooks.emptyText?.(sh) || (Object.keys(sh.filters).length ? 'No rows match the filters.' : 'No rows yet. Paste or type data, or add a row.'))}</td></tr>`);
    }

    // The editor sits inside the scrolling area, so it moves with its cell: no need to close it on scroll.
    root.addEventListener('scroll', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(renderBody);
    });

    function scrollToCell(r, c) {
      const headH = thead.offsetHeight;
      const y = headH + r * RH;
      if (y < root.scrollTop + headH) root.scrollTop = y - headH;
      else if (y + RH > root.scrollTop + root.clientHeight) root.scrollTop = y + RH - root.clientHeight;
      const sh = sheet();
      const iw = hooks.indexWidth || 64;
      let x = iw;
      for (let k = 0; k < c; k++) x += sh.widths[k];
      const w = sh.widths[c];
      if (x < root.scrollLeft + iw) root.scrollLeft = x - iw;
      else if (x + w > root.scrollLeft + root.clientWidth) root.scrollLeft = x + w - root.clientWidth;
    }

    function select(ar, ac, fr = ar, fc = ac, { scroll = true } = {}) {
      Object.assign(S(), { ar, ac, fr, fc });
      clampSel();
      if (scroll) scrollToCell(S().fr, S().fc);
      renderSelection();
      hooks.selected?.();
    }
    // Selection changes only need classes swapped, not a full redraw.
    function renderSelection() {
      const rg = range(), s = S();
      for (const tr of tbody.children) {
        const r = Number(tr.dataset.r);
        if (Number.isNaN(r)) continue;
        const rowSel = r >= rg.r1 && r <= rg.r2;
        tr.firstElementChild.classList.toggle('on', rowSel);
        for (const td of tr.children) {
          if (td.tagName !== 'TD') continue;
          const c = Number(td.dataset.c);
          td.classList.toggle('sel', rowSel && c >= rg.c1 && c <= rg.c2);
          td.classList.toggle('act', r === s.fr && c === s.fc);
        }
      }
      thead.querySelectorAll('th[data-c], th[data-name]').forEach((th) => th.classList.toggle('on', inCols(Number(th.dataset.c ?? th.dataset.name))));
    }

    // --- Editing ----------------------------------------------------------------

    function startEdit(initial = null, r = S().fr, c = S().fc) {
      const sh = sheet();
      if (!sh || hooks.readOnly) return;
      const td = r === -1 ? thead.querySelector(`th[data-name="${c}"]`) : tbody.querySelector(`tr[data-r="${r}"] td[data-c="${c}"]`);
      if (!td) { scrollToCell(r, c); renderBody(); return startEdit(initial, r, c); }
      editing = { r, c };
      const rr = td.getBoundingClientRect(), base = root.getBoundingClientRect();
      Object.assign(editor.style, { left: rr.left - base.left + root.scrollLeft + 'px', top: rr.top - base.top + root.scrollTop + 'px', width: Math.max(rr.width, 120) + 'px', height: rr.height + 'px' });
      editor.classList.remove('hidden');
      editor.value = initial ?? (r === -1 ? sh.headers[c] : sh.view[r].cells[c] ?? '');
      editor.focus({ preventScroll: true });
      if (initial == null) editor.select();
    }
    function commitEdit(move = null) {
      if (!editing) return;
      const { r, c } = editing;
      editing = null;
      editor.classList.add('hidden');
      const val = editor.value;
      const sh = sheet();
      if (r === -1) renameCol(c, val);
      else if (sh.view[r]) setCells([{ row: sh.view[r], c, v: val }]);
      root.focus({ preventScroll: true });
      if (move) moveBy(...move, false);
    }
    function cancelEdit() {
      editing = null;
      editor.classList.add('hidden');
      root.focus({ preventScroll: true });
    }
    editor.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitEdit(editing.r === -1 ? null : [e.shiftKey ? -1 : 1, 0]); }
      else if (e.key === 'Tab') { e.preventDefault(); commitEdit([0, e.shiftKey ? -1 : 1]); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });
    editor.addEventListener('blur', () => editing && commitEdit());

    function moveBy(dr, dc, extend) {
      const s = S();
      const r = Math.min(Math.max(s.fr + dr, 0), Math.max(0, view().length - 1));
      const c = Math.min(Math.max(s.fc + dc, 0), Math.max(0, nCols() - 1));
      if (extend) select(s.ar, s.ac, r, c);
      else select(r, c);
    }

    function clearRange() {
      const sh = sheet(), rg = range(), changes = [];
      for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) if (sh.view[r]) changes.push({ row: sh.view[r], c, v: '' });
      setCells(changes, 'Clear');
    }

    // --- Mouse ----------------------------------------------------------------

    const cellAt = (el) => {
      const td = el.closest?.('td[data-c]');
      const tr = td?.parentElement;
      return td && tr?.dataset.r != null ? { r: Number(tr.dataset.r), c: Number(td.dataset.c) } : null;
    };

    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target === editor) return;
      if (editing) commitEdit();
      if (e.target.closest('.sg-check, .sg-all, .sg-menu, .sg-rz')) return;
      const hit = cellAt(e.target);
      const rh = e.target.closest('th.sg-rh');
      const name = e.target.closest('th[data-name], th[data-c]');
      const last = Math.max(0, view().length - 1);
      if (hit) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        if (e.shiftKey) select(S().ar, S().ac, hit.r, hit.c, { scroll: false });
        else select(hit.r, hit.c, hit.r, hit.c, { scroll: false });
        dragging = true;
      } else if (rh) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        const r = Number(rh.parentElement.dataset.r);
        select(e.shiftKey ? S().ar : r, 0, r, nCols() - 1, { scroll: false });
        dragging = 'rows';
      } else if (name) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        const c = Number(name.dataset.name ?? name.dataset.c);
        select(0, e.shiftKey ? S().ac : c, last, c, { scroll: false });
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || !root.contains(el)) return;
      if (dragging === 'rows') {
        const tr = el.closest('tr[data-r]');
        if (tr) select(S().ar, 0, Number(tr.dataset.r), nCols() - 1, { scroll: false });
        return;
      }
      const hit = cellAt(el);
      if (hit && (hit.r !== S().fr || hit.c !== S().fc)) select(S().ar, S().ac, hit.r, hit.c, { scroll: false });
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    root.addEventListener('dblclick', (e) => {
      const hit = cellAt(e.target);
      if (hit && hooks.readOnly) return hooks.open?.(view()[hit.r]);
      if (hit) return startEdit(null, hit.r, hit.c);
      const name = e.target.closest('th[data-name]');
      if (name) startEdit(null, -1, Number(name.dataset.name));
    });

    // Row ticks: click one, shift-click to tick a range; the corner box ticks every shown row.
    let lastCheck = null;
    root.addEventListener('click', (e) => {
      const cb = e.target.closest('.sg-check');
      if (cb) {
        const r = Number(cb.closest('tr').dataset.r);
        const sh = sheet();
        const rows = e.shiftKey && lastCheck != null ? sh.view.slice(Math.min(lastCheck, r), Math.max(lastCheck, r) + 1) : [sh.view[r]];
        hooks.check?.(sh, rows, cb.checked);
        lastCheck = r;
        render();
        return;
      }
      if (e.target.closest('.sg-all')) {
        const sh = sheet();
        hooks.check?.(sh, sh.view, e.target.checked);
        render();
        return;
      }
      const m = e.target.closest('.sg-menu');
      if (m) {
        const r = m.getBoundingClientRect();
        columnMenu(Number(m.dataset.menu), r.left, r.bottom + 4);
      }
    });

    // Drag a column's right edge to resize it.
    root.addEventListener('pointerdown', (e) => {
      const h = e.target.closest('.sg-rz');
      if (!h) return;
      e.preventDefault();
      const c = Number(h.dataset.rz), sh = sheet(), start = e.clientX, w0 = sh.widths[c];
      const col = colgroup.children[c + 1];
      h.setPointerCapture(e.pointerId);
      const move = (ev) => {
        sh.widths[c] = Math.max(56, Math.round(w0 + ev.clientX - start));
        col.style.width = sh.widths[c] + 'px';
        sizeTable();
      };
      const up = () => { h.removeEventListener('pointermove', move); };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up, { once: true });
    });

    root.addEventListener('contextmenu', (e) => {
      const hit = cellAt(e.target), rh = e.target.closest('th.sg-rh'), name = e.target.closest('th[data-name], th[data-c]');
      if (!hit && !rh && !name) return;
      e.preventDefault();
      if (name) return columnMenu(Number(name.dataset.name ?? name.dataset.c), e.clientX, e.clientY);
      const r = hit ? hit.r : Number(rh.parentElement.dataset.r);
      const rg = range();
      if (r < rg.r1 || r > rg.r2) select(r, hit ? hit.c : 0, r, hit ? hit.c : nCols() - 1, { scroll: false });
      rowMenu(e.clientX, e.clientY);
    });

    // --- Menus -----------------------------------------------------------------

    function rowMenu(x, y) {
      const rg = range(), n = rg.r2 - rg.r1 + 1, sh = sheet();
      const rows = sh.view.slice(rg.r1, rg.r2 + 1);
      const at = (r) => sh.rows.indexOf(sh.view[r]);
      if (hooks.readOnly) return Menu.open(x, y, [{ label: 'Copy', kbd: '⌘C', action: () => document.execCommand('copy') }, ...(hooks.rowMenuExtras?.(sh, rows) || [])]);
      Menu.open(x, y, [
        { label: 'Copy', kbd: '⌘C', action: () => document.execCommand('copy') },
        { label: 'Clear cells', kbd: '⌫', action: clearRange },
        '-',
        { label: `Insert ${n > 1 ? n + ' rows' : 'row'} above`, action: () => { insertRows(at(rg.r1), n); select(rg.r1, S().fc); } },
        { label: `Insert ${n > 1 ? n + ' rows' : 'row'} below`, action: () => { insertRows(at(rg.r2) + 1, n); select(rg.r2 + 1, S().fc); } },
        { label: `Delete ${n > 1 ? n + ' rows' : 'row'}`, danger: true, action: () => deleteRows(rows) },
        ...(hooks.rowMenuExtras?.(sh, rows) || []),
      ]);
    }

    function columnMenu(c, x, y) {
      const sh = sheet();
      Menu.open(x, y, [
        ...(hooks.columnMenuExtras?.(sh, c) || []),
        { label: 'Sort A → Z', action: () => sortBy(c, 1) },
        { label: 'Sort Z → A', action: () => sortBy(c, -1) },
        { label: sh.filters[c] ? 'Edit filter…' : 'Filter…', action: () => filterPopover(c, x, y) },
        ...(sh.filters[c] ? [{ label: 'Clear filter', action: () => { delete sh.filters[c]; after('filter'); } }] : []),
        ...(hooks.readOnly ? [] : ['-',
        { label: 'Rename', action: () => startEdit(null, -1, c) },
        { label: 'Insert column left', action: () => insertCol(c) },
        { label: 'Insert column right', action: () => insertCol(c + 1) },
        { label: 'Delete column', danger: true, action: () => deleteCol(c) }]),
      ]);
    }

    // Filter by values (tick boxes, like Sheets) or by text a cell contains.
    function filterPopover(c, x, y) {
      const sh = sheet();
      const counts = new Map();
      for (const r of sh.rows) { const v = String(r.cells[c] ?? ''); counts.set(v, (counts.get(v) || 0) + 1); }
      const values = [...counts.keys()].sort(collator.compare).slice(0, 500);
      const cur = sh.filters[c] || {};
      const pop = Menu.panel(x, y, `
        <div class="sg-pop-title">Filter “${escHtml(sh.headers[c])}”</div>
        <input class="sg-pop-text" placeholder="Cell contains…" value="${escHtml(cur.text || '')}" />
        <div class="sg-pop-sub"><span>By value</span><span><button type="button" data-all>All</button> · <button type="button" data-none>None</button></span></div>
        <input class="sg-pop-search" placeholder="Search values" />
        <div class="sg-pop-list">${values.map((v) => `<label data-v="${escHtml(v.toLowerCase())}"><input type="checkbox" value="${escHtml(v)}" ${!cur.values || cur.values.has(v) ? 'checked' : ''} /><span>${v === '' ? '<i>(empty)</i>' : escHtml(v)}</span><small>${counts.get(v)}</small></label>`).join('')}</div>
        ${counts.size > values.length ? `<div class="sg-pop-sub">Showing ${values.length} of ${counts.size} values</div>` : ''}
        <div class="sg-pop-actions"><button type="button" class="btn sm quiet" data-clear>Clear</button><button type="button" class="btn sm primary" data-apply>Apply</button></div>`);
      pop.querySelector('.sg-pop-search').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        pop.querySelectorAll('.sg-pop-list label').forEach((l) => l.classList.toggle('hidden', !l.dataset.v.includes(q)));
      });
      pop.addEventListener('click', (e) => {
        const boxes = [...pop.querySelectorAll('.sg-pop-list input')];
        if (e.target.closest('[data-all]')) boxes.forEach((b) => (b.checked = true));
        if (e.target.closest('[data-none]')) boxes.forEach((b) => (b.checked = false));
        if (e.target.closest('[data-clear]')) { delete sh.filters[c]; Menu.close(); after('filter'); }
        if (e.target.closest('[data-apply]')) {
          const text = pop.querySelector('.sg-pop-text').value.trim();
          const allOn = boxes.every((b) => b.checked) && counts.size === values.length;
          const f = {};
          if (text) f.text = text;
          if (!allOn) f.values = new Set(boxes.filter((b) => b.checked).map((b) => b.value));
          if (f.text || f.values) sh.filters[c] = f;
          else delete sh.filters[c];
          Menu.close();
          S().ar = S().fr = 0;
          after('filter');
        }
      });
      pop.querySelector('.sg-pop-text').focus();
    }

    // --- Keyboard ---------------------------------------------------------------

    root.addEventListener('keydown', (e) => {
      if (editing || e.target !== root) return;
      const meta = e.metaKey || e.ctrlKey, s = S();
      const k = e.key;
      if (meta && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (meta && k.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (meta && k.toLowerCase() === 'a') { e.preventDefault(); select(0, 0, view().length - 1, nCols() - 1, { scroll: false }); return; }
      if (meta && k.toLowerCase() === 'f') { e.preventDefault(); hooks.find?.(); return; }
      const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (arrows[k]) {
        e.preventDefault();
        let [dr, dc] = arrows[k];
        if (meta) { dr *= 1e9; dc *= 1e9; } // jump to the edge
        moveBy(dr, dc, e.shiftKey);
        return;
      }
      if (k === 'PageDown' || k === 'PageUp') { e.preventDefault(); moveBy((k === 'PageDown' ? 1 : -1) * Math.floor(root.clientHeight / RH), 0, e.shiftKey); return; }
      if (k === 'Home') { e.preventDefault(); select(meta ? 0 : s.fr, 0); return; }
      if (k === 'End') { e.preventDefault(); select(meta ? view().length - 1 : s.fr, nCols() - 1); return; }
      if (k === 'Tab') { e.preventDefault(); moveBy(0, e.shiftKey ? -1 : 1, false); return; }
      if (!view().length) {
        // An empty sheet: typing starts a first row.
        if (k.length === 1 && !meta && !hooks.readOnly) { e.preventDefault(); insertRows(0, 1); select(0, 0); startEdit(k); }
        return;
      }
      if (k === 'Enter' || k === 'F2') { e.preventDefault(); if (e.shiftKey && k === 'Enter') moveBy(-1, 0); else startEdit(); return; }
      if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); if (!hooks.readOnly) clearRange(); return; }
      if (k === 'Escape') { select(s.fr, s.fc); return; }
      if (k.length === 1 && !meta && !e.altKey && !hooks.readOnly) { e.preventDefault(); startEdit(k); }
    });

    // --- Clipboard: plain tab-separated text, so it round-trips with Excel and Sheets ---

    const active = () => document.activeElement === root && !editing;
    document.addEventListener('copy', (e) => {
      if (!active()) return;
      const sh = sheet(), rg = range();
      const lines = [];
      for (let r = rg.r1; r <= rg.r2; r++) {
        const row = sh.view[r];
        if (!row) continue;
        const out = [];
        for (let c = rg.c1; c <= rg.c2; c++) out.push(tsvCell(String(row.cells[c] ?? '')));
        lines.push(out.join('\t'));
      }
      e.clipboardData.setData('text/plain', lines.join('\n'));
      e.preventDefault();
      hooks.notify?.(`Copied ${lines.length > 1 || rg.c2 > rg.c1 ? `${lines.length} × ${rg.c2 - rg.c1 + 1} cells` : 'cell'}`);
    });
    document.addEventListener('cut', (e) => {
      if (!active() || hooks.readOnly) return;
      const sh = sheet(), rg = range(), lines = [];
      for (let r = rg.r1; r <= rg.r2; r++) {
        const row = sh.view[r];
        if (!row) continue;
        const out = [];
        for (let c = rg.c1; c <= rg.c2; c++) out.push(tsvCell(String(row.cells[c] ?? '')));
        lines.push(out.join('\t'));
      }
      e.clipboardData.setData('text/plain', lines.join('\n'));
      e.preventDefault();
      clearRange();
    });
    document.addEventListener('paste', (e) => {
      if (!active() || hooks.readOnly) return;
      const text = e.clipboardData.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      paste(parseTsv(text));
    });

    // Paste a block at the active cell, adding rows and columns if it runs past the edge.
    // Pasting a whole table into an empty sheet takes its first row as the column names.
    function paste(block) {
      const sh = sheet();
      if (!block.length) return;
      const blank = sh.rows.every((r) => r.cells.every((v) => !String(v).trim()));
      if (blank && block.length > 1 && hooks.adoptTable) {
        hooks.adoptTable(sh, block);
        history = []; future = [];
        computeView(); select(0, 0); after('table');
        return;
      }
      const s = S(), r0 = sh.view.length ? Math.min(s.ar, s.fr) : 0, c0 = sh.view.length ? Math.min(s.ac, s.fc) : 0;
      const width = Math.max(...block.map((b) => b.length));
      const needCols = c0 + width - sh.headers.length;
      const needRows = r0 + block.length - sh.view.length;
      // One undo step for the whole paste.
      const beforeHeaders = sh.headers.slice(), beforeWidths = sh.widths.slice(), beforeRows = sh.rows.slice(), beforeCells = sh.rows.map((r) => r.cells.slice());
      run({
        kind: 'paste',
        do: () => {
          for (let k = 0; k < needCols; k++) {
            sh.headers.push(uniqueName(sh, `Column ${letter(sh.headers.length)}`));
            sh.widths.push(140);
            sh.rows.forEach((r) => r.cells.push(''));
          }
          // New rows go right after the last row the paste covers (or at the end).
          const viewRows = sh.view.slice(r0);
          if (needRows > 0) {
            const last = viewRows.length ? viewRows[viewRows.length - 1] : sh.rows[sh.rows.length - 1];
            const at = last ? sh.rows.indexOf(last) + 1 : sh.rows.length;
            const made = Array.from({ length: needRows }, () => ({ cells: Array.from({ length: sh.headers.length }, () => ''), on: true }));
            sh.rows.splice(at, 0, ...made);
            viewRows.push(...made);
          }
          block.forEach((line, i) => line.forEach((v, j) => { viewRows[i].cells[c0 + j] = v; }));
        },
        undo: () => {
          sh.headers = beforeHeaders.slice();
          sh.widths = beforeWidths.slice();
          sh.rows = beforeRows.slice();
          sh.rows.forEach((r, i) => { r.cells = beforeCells[i].slice(); });
        },
      });
      select(r0, c0, r0 + block.length - 1, c0 + width - 1);
      hooks.notify?.(`Pasted ${block.length} × ${width} cells`);
    }

    // --- Find & replace ----------------------------------------------------------

    function matches(q) {
      const sh = sheet(), out = [];
      if (!q) return out;
      const needle = q.toLowerCase();
      sh.view.forEach((row, r) => row.cells.forEach((v, c) => { if (String(v).toLowerCase().includes(needle)) out.push({ r, c }); }));
      return out;
    }
    function findNext(q, dir = 1) {
      const list = matches(q);
      if (!list.length) return { count: 0, index: -1 };
      const s = S();
      const pos = list.findIndex((m) => (dir > 0 ? m.r > s.fr || (m.r === s.fr && m.c > s.fc) : false));
      let i;
      if (dir > 0) i = pos === -1 ? 0 : pos;
      else {
        const before = list.filter((m) => m.r < s.fr || (m.r === s.fr && m.c < s.fc));
        i = before.length ? list.indexOf(before[before.length - 1]) : list.length - 1;
      }
      select(list[i].r, list[i].c);
      return { count: list.length, index: i };
    }
    const escRe = (q) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    function replaceOne(q, rep) {
      const sh = sheet(), s = S(), row = sh.view[s.fr];
      if (row && String(row.cells[s.fc] ?? '').toLowerCase().includes(q.toLowerCase())) {
        setCells([{ row, c: s.fc, v: String(row.cells[s.fc]).replace(new RegExp(escRe(q), 'i'), rep) }], 'Replace');
      }
      return findNext(q, 1);
    }
    function replaceAll(q, rep) {
      const sh = sheet(), re = new RegExp(escRe(q), 'gi');
      const changes = matches(q).map(({ r, c }) => ({ row: sh.view[r], c, v: String(sh.view[r].cells[c]).replace(re, rep) }));
      setCells(changes, 'Replace all');
      return changes.length;
    }

    // --- API ----------------------------------------------------------------------

    return {
      render() { computeView(); clampSel(); render(); },
      redraw: render,
      focus: () => root.focus({ preventScroll: true }),
      undo, redo,
      canUndo: () => history.length > 0,
      canRedo: () => future.length > 0,
      clearHistory() { history = []; future = []; },
      select,
      range,
      selectedRows() { const rg = range(); return view().slice(rg.r1, rg.r2 + 1); },
      activeRow: () => view()[S().fr] || null,
      insertRowsAt(where) {
        const sh = sheet(), rg = range(), n = rg.r2 - rg.r1 + 1;
        if (!sh.view.length) { insertRows(sh.rows.length, 1); select(0, 0); return; }
        const at = where === 'above' ? sh.rows.indexOf(sh.view[rg.r1]) : sh.rows.indexOf(sh.view[rg.r2]) + 1;
        insertRows(at, where === 'end' ? 1 : n);
        select(where === 'above' ? rg.r1 : rg.r2 + 1, S().fc);
      },
      addRowAtEnd() { const sh = sheet(); insertRows(sh.rows.length, 1); computeView(); select(sh.view.length - 1, 0); },
      deleteSelectedRows() { deleteRows(this.selectedRows()); },
      insertColumn: (at) => insertCol(at ?? range().c2 + 1),
      deleteColumn: (c) => deleteCol(c ?? S().fc),
      sortBy,
      clearFilters() { sheet().filters = {}; after('filter'); },
      refilter() { computeView(); S().ar = S().fr = 0; clampSel(); render(); },
      findNext, replaceOne, replaceAll,
      matchCount: (q) => matches(q).length,
      paste,
      // A change made by the page, recorded so ⌘Z undoes it like any edit: { do(), undo(), kind }.
      apply: (op) => run(op),
    };
  }

  // --- Floating menus and panels, shared by every grid -----------------------------

  const Menu = (() => {
    let el = null;
    function close() {
      el?.remove();
      el = null;
    }
    function place(node, x, y) {
      document.body.append(node);
      const r = node.getBoundingClientRect();
      node.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
      node.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
    }
    function open(x, y, items) {
      close();
      el = document.createElement('div');
      el.className = 'sg-menu-pop';
      el.setAttribute('role', 'menu');
      items.filter(Boolean).forEach((it) => {
        if (it === '-') return el.insertAdjacentHTML('beforeend', '<hr />');
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.className = it.danger ? 'danger' : '';
        b.disabled = Boolean(it.disabled);
        b.innerHTML = `<span>${escHtml(it.label)}</span>${it.kbd ? `<kbd>${escHtml(it.kbd)}</kbd>` : ''}`;
        b.addEventListener('click', () => { close(); it.action?.(); });
        el.append(b);
      });
      place(el, x, y);
      el.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    }
    function panel(x, y, html) {
      close();
      el = document.createElement('div');
      el.className = 'sg-menu-pop sg-pop';
      el.innerHTML = html;
      place(el, x, y);
      return el;
    }
    document.addEventListener('mousedown', (e) => { if (el && !el.contains(e.target)) close(); }, true);
    document.addEventListener('keydown', (e) => {
      if (!el) return;
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (el.classList.contains('sg-pop')) return;
      const items = [...el.querySelectorAll('button:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    }, true);
    addEventListener('resize', close);
    // A popup is pinned to where it opened; if the page scrolls underneath it, close it rather than leave it floating.
    addEventListener('scroll', (e) => { if (el && !(e.target instanceof Node && el.contains(e.target))) close(); }, { capture: true, passive: true });
    return { open, panel, close };
  })();

  window.Sheet = { create, letter, parseTsv, Menu };
})();
