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
  const RH = 30; // row height in px: one line. Rows with wrapped text are taller (see geom); only visible rows are drawn
  const LH = 18, WRAP_MAX = 8; // a wrapped line's height, and the most lines a row grows to
  // How many lines some text takes in a column of this width (word by word, as the browser wraps it). Cached.
  let mctx = null;
  const lineCache = new Map();
  function linesFor(text, width) {
    text = String(text ?? '');
    if (!text) return 1;
    const key = width + '|' + text;
    const hit = lineCache.get(key);
    if (hit) return hit;
    mctx ||= document.createElement('canvas').getContext('2d');
    mctx.font = '13px Inter, sans-serif';
    const avail = Math.max(20, width - 18);
    let n = 0;
    for (const para of text.split('\n')) {
      n++;
      let line = 0;
      for (const word of para.split(/(\s+)/)) {
        if (!word) continue;
        const w = mctx.measureText(word).width;
        if (line + w <= avail) { line += w; continue; }
        if (/^\s+$/.test(word)) continue; // a space where the line breaks
        if (w > avail) { n += Math.ceil((line + w) / avail) - 1; line = (line + w) % avail; continue; } // a long word breaks too
        n++; line = w;
      }
    }
    if (lineCache.size > 50000) lineCache.clear();
    lineCache.set(key, n);
    return n;
  }
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
      if (!sh) return { ar: 0, ac: 0, fr: 0, fc: 0 }; // the last sheet was just closed
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
    // Cmd/Ctrl+click adds more ranges (like Sheets/Excel): s.extra holds the earlier ones, the current
    // range is still anchor→focus. ranges() is all of them; inSel() asks whether a cell is in any.
    const norm = (x) => ({ r1: Math.min(x.ar, x.fr), r2: Math.max(x.ar, x.fr), c1: Math.min(x.ac, x.fc), c2: Math.max(x.ac, x.fc) });
    const ranges = () => [...(S().extra || []).map(norm), range()];
    const inSel = (r, c) => ranges().some((g) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2);
    const rowOn = (r) => ranges().some((g) => r >= g.r1 && r <= g.r2);
    const colOn = (c) => ranges().some((g) => c >= g.c1 && c <= g.c2);
    // Every selected row (view indexes) and column, deduplicated and in order.
    const selRows = () => [...new Set(ranges().flatMap((g) => Array.from({ length: g.r2 - g.r1 + 1 }, (_, i) => g.r1 + i)))].sort((a, b) => a - b);
    const selCols = () => [...new Set(ranges().flatMap((g) => Array.from({ length: g.c2 - g.c1 + 1 }, (_, i) => g.c1 + i)))].sort((a, b) => a - b);
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
      if (kind !== 'cells') S().extra = []; // rows/columns moved: the other ranges no longer point at the same cells
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

    function insertCol(at, name) { run(insertColOp(at, name)); }
    // Several columns as one step (one undo): the ops run in order and are undone in reverse.
    function insertCols(at, n) {
      const ops = [];
      run({ kind: 'cols', do: () => { for (let k = 0; k < n; k++) { const op = insertColOp(at + k); ops.push(op); op.do(); } }, undo: () => { for (const op of [...ops].reverse()) op.undo(); ops.length = 0; } });
    }
    // Wrap flags per column (sh.wraps), kept the same length as the headers so they move with their columns.
    const wraps = (sh) => { sh.wraps ||= []; while (sh.wraps.length < sh.headers.length) sh.wraps.push(false); return sh.wraps; };
    function insertColOp(at, name) {
      const sh = sheet();
      const nm = uniqueName(sh, name || `Column ${letter(sh.headers.length)}`);
      const shiftFilters = (d) => { const f = {}; for (const [c, v] of Object.entries(sh.filters)) f[+c >= at ? +c + d : c] = v; sh.filters = f; };
      return ({
        kind: 'cols',
        do: () => {
          wraps(sh).splice(at, 0, false);
          sh.headers.splice(at, 0, nm);
          sh.widths.splice(at, 0, 140);
          sh.rows.forEach((r) => r.cells.splice(at, 0, ''));
          shiftFilters(1);
          hooks.colsMoved?.(sh, at, 1);
        },
        undo: () => {
          wraps(sh).splice(at, 1);
          sh.headers.splice(at, 1);
          sh.widths.splice(at, 1);
          sh.rows.forEach((r) => r.cells.splice(at, 1));
          shiftFilters(-1);
          hooks.colsMoved?.(sh, at, -1);
        },
      });
    }

    // Move rows (as shown: a..b, filtered or not) to just before shown row t; and columns a..b to just before column t.
    // Each is one step in the history.
    function moveRows(a, b, t) {
      const sh = sheet(), v = sh.view, block = v.slice(a, b + 1), inBlock = new Set(block);
      const before = sh.rows.slice(), next = sh.rows.filter((r) => !inBlock.has(r));
      const anchor = t < v.length ? v[t] : null;
      next.splice(anchor ? next.indexOf(anchor) : next.indexOf(v[v.length - 1]) + 1, 0, ...block);
      run({ kind: 'rows', label: 'Move rows', do: () => sh.rows.splice(0, sh.rows.length, ...next), undo: () => sh.rows.splice(0, sh.rows.length, ...before) });
    }
    function moveCols(a, b, t) {
      const sh = sheet(), n = sh.headers.length, idx = [...Array(n).keys()];
      const block = idx.slice(a, b + 1), perm = idx.filter((i) => i < a || i > b);
      perm.splice(t > b ? t - block.length : t, 0, ...block); // new column k is old column perm[k]
      const inv = []; perm.forEach((old, k) => { inv[old] = k; });
      const apply = (p) => {
        const ap = (arr) => p.map((i) => arr[i]);
        wraps(sh);
        sh.headers = ap(sh.headers); sh.widths = ap(sh.widths); sh.wraps = ap(sh.wraps);
        sh.rows.forEach((r) => { const c = r.cells; while (c.length < n) c.push(''); r.cells = [...ap(c), ...c.slice(n)]; });
        const f = {}; for (const [c, val] of Object.entries(sh.filters)) f[p.indexOf(+c)] = val; sh.filters = f;
      };
      run({ kind: 'cols', label: 'Move columns', do: () => apply(perm), undo: () => apply(inv) });
    }

    function deleteCol(at) {
      if (sheet().headers.length <= 1) return hooks.notify?.("A sheet needs at least one column");
      run(deleteColOp(at));
    }
    function deleteCols(c1, c2) {
      const sh = sheet(), n = c2 - c1 + 1;
      if (sh.headers.length - n < 1) return hooks.notify?.("A sheet needs at least one column, so not every column can go");
      const ops = [];
      run({ kind: 'cols', do: () => { for (let c = c2; c >= c1; c--) { const op = deleteColOp(c); ops.push(op); op.do(); } }, undo: () => { for (const op of [...ops].reverse()) op.undo(); ops.length = 0; } });
    }
    function deleteColSet(list) {
      const sh = sheet();
      if (sh.headers.length - list.length < 1) return hooks.notify?.("A sheet needs at least one column, so not every column can go");
      const ops = [], desc = [...list].sort((a, b) => b - a);
      run({ kind: 'cols', do: () => { for (const c of desc) { const op = deleteColOp(c); ops.push(op); op.do(); } }, undo: () => { for (const op of [...ops].reverse()) op.undo(); ops.length = 0; } });
    }
    function deleteColOp(at) {
      const sh = sheet();
      const name = sh.headers[at], width = sh.widths[at], vals = sh.rows.map((r) => r.cells[at] ?? ''), filter = sh.filters[at], wrapped = Boolean(sh.wraps?.[at]);
      // Filters are keyed by column index: drop this column's, shift the ones after it.
      const remove = () => { const f = {}; for (const [c, v] of Object.entries(sh.filters)) if (+c !== at) f[+c > at ? +c - 1 : c] = v; sh.filters = f; };
      const restore = () => { const f = {}; for (const [c, v] of Object.entries(sh.filters)) f[+c >= at ? +c + 1 : c] = v; if (filter) f[at] = filter; sh.filters = f; };
      return ({
        kind: 'cols',
        do: () => {
          wraps(sh).splice(at, 1);
          sh.headers.splice(at, 1);
          sh.widths.splice(at, 1);
          sh.rows.forEach((r) => r.cells.splice(at, 1));
          remove();
          hooks.colsMoved?.(sh, at, -1, name);
        },
        undo: () => {
          wraps(sh).splice(at, 0, wrapped);
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
          return `<th data-name="${c}" class="${inCols(c) ? 'on' : ''}" title="${escHtml(h)} · click to select (copy, paste or type to rename), double-click to edit">${tag}<span class="sg-hname">${escHtml(h)}</span>${filtered}</th>`;
        }).join('')}</tr>`;
      const corner = thead.querySelector('.sg-all');
      if (corner) corner.indeterminate = all === null;
      renderBody();
    }
    const inCols = (c) => colOn(c);
    // The columns keep their widths; a filler column takes whatever space is left.
    // The grid's room changes (the sidebar folds, the window resizes, the panel opens): fill it again.
    new ResizeObserver(() => { if (sheet()) { sizeTable(); renderBody(); } }).observe(root);
    function sizeTable() {
      const sh = sheet();
      const w = (hooks.indexWidth || 64) + sh.widths.reduce((a, b) => a + b, 0);
      table.style.width = Math.max(w, root.clientWidth) + 'px';
    }

    // Where each row sits: every row one line high, unless a column wraps; then a row is as tall as its longest
    // wrapped cell (up to WRAP_MAX lines), and rows are found by their running total.
    function geom(sh) {
      const v = sh.view, wc = (sh.wraps || []).map((w, c) => (w && c < sh.headers.length ? c : -1)).filter((c) => c >= 0);
      if (!wc.length) return { wrap: false, h: () => RH, top: (r) => r * RH, total: v.length * RH, at: (y) => Math.floor(y / RH) };
      const off = new Float64Array(v.length + 1);
      for (let r = 0; r < v.length; r++) {
        let L = 1;
        for (const c of wc) L = Math.max(L, linesFor(v[r].cells[c], sh.widths[c]));
        off[r + 1] = off[r] + (L > 1 ? Math.min(L, WRAP_MAX) * LH + 12 : RH);
      }
      return {
        wrap: true, h: (r) => off[r + 1] - off[r], top: (r) => off[r], total: off[v.length],
        at: (y) => { let lo = 0, hi = v.length; while (lo < hi) { const m = (lo + hi) >> 1; if (off[m + 1] <= y) lo = m + 1; else hi = m; } return lo; },
      };
    }

    function renderBody() {
      const sh = sheet();
      if (!sh) return;
      const v = sh.view;
      const headH = thead.offsetHeight || 2 * RH;
      const top = Math.max(0, root.scrollTop - headH);
      const G = geom(sh);
      const first = Math.max(0, G.at(top) - OVERSCAN);
      const last = Math.min(v.length, G.at(top + root.clientHeight) + 1 + OVERSCAN);
      const rg = range(), s = S();
      let html = `<tr class="sg-spacer" style="height:${G.top(first)}px"><td colspan="${nCols() + 2}"></td></tr>`;
      for (let r = first; r < last; r++) {
        const row = v[r];
        const rowSel = rowOn(r);
        const meta = hooks.rowInfo?.(sh, row) || {};
        const tall = G.wrap && G.h(r) > RH;
        html += `<tr data-r="${r}" class="${meta.cls || ''}${tall ? ' tall' : ''}"${G.wrap ? ` style="height:${G.h(r)}px"` : ''}><th class="sg-rh ${rowSel ? 'on' : ''}">${hooks.checkable ? `<input type="checkbox" class="cb sg-check" ${meta.checked ? 'checked' : ''} ${meta.disabled ? 'disabled' : ''} tabindex="-1" title="${escHtml(meta.checkTitle || '')}" />` : ''}<span>${(sh.index.get(row) ?? r) + 1}</span></th>`;
        for (let c = 0; c < sh.headers.length; c++) {
          const val = row.cells[c] ?? '';
          const sel = rowSel && inSel(r, c);
          const act = r === s.fr && c === s.fc;
          const cell = hooks.cellInfo?.(sh, row, c) || {};
          const wrapC = sh.wraps?.[c];
          html += `<td data-c="${c}" class="${sel ? 'sel' : ''}${act ? ' act' : ''}${wrapC ? ' wrap' : ''}${cell.cls ? ' ' + cell.cls : ''}"${cell.title ? ` title="${escHtml(cell.title)}"` : ''}>${wrapC ? `<div class="sg-wt">${escHtml(val)}</div>` : escHtml(val)}${cell.badge || ''}</td>`;
        }
        html += '<td class="sg-fill"></td></tr>';
      }
      html += `<tr class="sg-spacer" style="height:${G.total - G.top(last)}px"><td colspan="${nCols() + 2}"></td></tr>`;
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
      const sh = sheet(), G = geom(sh), y = headH + G.top(r), h = G.h(r);
      if (y < root.scrollTop + headH) root.scrollTop = y - headH;
      else if (y + h > root.scrollTop + root.clientHeight) root.scrollTop = y + h - root.clientHeight;
      const iw = hooks.indexWidth || 64;
      let x = iw;
      for (let k = 0; k < c; k++) x += sh.widths[k];
      const w = sh.widths[c];
      if (x < root.scrollLeft + iw) root.scrollLeft = x - iw;
      else if (x + w > root.scrollLeft + root.clientWidth) root.scrollLeft = x + w - root.clientWidth;
    }

    // The column names row can be selected like cells (s.hdr = { a, f }: anchor and focus columns), to copy names,
    // paste over them (renames) or type a new one. Any cell selection leaves it.
    const hdr = () => S().hdr || null;
    const hdrRange = () => { const h = hdr(); return h ? { c1: Math.min(h.a, h.f), c2: Math.max(h.a, h.f) } : null; };
    function selectHeader(a, f = a) {
      const s = S(), n = nCols() - 1;
      s.hdr = { a: Math.max(0, Math.min(a, n)), f: Math.max(0, Math.min(f, n)) };
      s.fc = s.hdr.f; s.ac = s.hdr.a; s.extra = [];
      scrollToCell(0, s.hdr.f);
      renderSelection();
      hooks.selected?.();
    }
    function select(ar, ac, fr = ar, fc = ac, { scroll = true, keep = false, add = false } = {}) {
      const s = S();
      s.hdr = null;
      if (add) s.extra = [...(s.extra || []), { ar: s.ar, ac: s.ac, fr: s.fr, fc: s.fc }];
      else if (!keep) s.extra = [];
      Object.assign(s, { ar, ac, fr, fc });
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
        const rowSel = rowOn(r);
        tr.firstElementChild.classList.toggle('on', rowSel);
        for (const td of tr.children) {
          if (td.tagName !== 'TD') continue;
          const c = Number(td.dataset.c);
          td.classList.toggle('sel', rowSel && inSel(r, c));
          td.classList.toggle('act', r === s.fr && c === s.fc);
        }
      }
      const hr = hdrRange();
      thead.querySelectorAll('th[data-c], th[data-name]').forEach((th) => th.classList.toggle('on', !hr && inCols(Number(th.dataset.c ?? th.dataset.name))));
      thead.querySelectorAll('th[data-name]').forEach((th) => {
        const c = Number(th.dataset.name);
        th.classList.toggle('hsel', Boolean(hr) && c >= hr.c1 && c <= hr.c2);
        th.classList.toggle('hact', Boolean(hr) && c === s.hdr.f);
      });
      if (hr) for (const td of tbody.querySelectorAll('td.sel, td.act')) td.classList.remove('sel', 'act');
    }

    // --- Editing ----------------------------------------------------------------

    function startEdit(initial = null, r = S().fr, c = S().fc) {
      const sh = sheet();
      if (!sh || hooks.readOnly) return;
      const td = r === -1 ? thead.querySelector(`th[data-name="${c}"]`) : tbody.querySelector(`tr[data-r="${r}"] td[data-c="${c}"]`);
      if (!td) { scrollToCell(r, c); renderBody(); return startEdit(initial, r, c); }
      // As in Google Sheets: typing on a cell replaces it, and the arrows then save and move on ("quick" entry);
      // Enter, F2 or a double-click opens what's there, and the arrows move the caret inside it instead.
      editing = { r, c, quick: initial != null };
      const rr = td.getBoundingClientRect(), base = root.getBoundingClientRect();
      editing.minW = rr.width;
      Object.assign(editor.style, { left: rr.left - base.left + root.scrollLeft + 'px', top: rr.top - base.top + root.scrollTop + 'px', width: rr.width + 'px', height: rr.height + 'px' });
      editor.classList.remove('hidden');
      editor.value = initial ?? (r === -1 ? sh.headers[c] : sh.view[r].cells[c] ?? '');
      fitEditor();
      editor.focus({ preventScroll: true });
      // opened on what's there: the caret goes to the end (select-all only for a column name, to rename it)
      if (initial == null) { if (r === -1) editor.select(); else editor.setSelectionRange(editor.value.length, editor.value.length); }
    }
    // Longer text than the cell: the editor grows to the right to show it, as a spreadsheet's does.
    function fitEditor() {
      if (!editing) return;
      editor.style.width = editing.minW + 'px';
      editor.style.width = Math.max(editing.minW, Math.min(editor.scrollWidth + 4, root.clientWidth - parseFloat(editor.style.left) + root.scrollLeft - 8)) + 'px';
    }
    editor.addEventListener('input', fitEditor);
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
      const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (e.key === 'Enter') { e.preventDefault(); commitEdit(editing.r === -1 ? null : [e.shiftKey ? -1 : 1, 0]); }
      else if (e.key === 'Tab') { e.preventDefault(); commitEdit([0, e.shiftKey ? -1 : 1]); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
      // typed straight into a cell: an arrow saves it and moves to the next cell (not in a column name)
      else if (arrows[e.key] && editing.quick && editing.r !== -1 && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); commitEdit(arrows[e.key]); }
      // F2 switches between the two, as in Sheets: arrows move the caret, or move between cells
      else if (e.key === 'F2') { e.preventDefault(); editing.quick = !editing.quick; }
    });
    editor.addEventListener('blur', () => editing && commitEdit());

    // --- Insert between: a small + on the line between two row numbers, or two column letters, under the pointer.
    // A click puts an empty row (or column) right there; ⌘Z takes it back like any edit.
    const ins = document.createElement('button');
    ins.type = 'button';
    ins.className = 'sg-ins hidden';
    ins.tabIndex = -1;
    ins.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    root.append(ins);
    const EDGE = 7; // px either side of the line
    const hideIns = () => { ins.classList.add('hidden'); ins.removeAttribute('data-kind'); };
    root.addEventListener('pointermove', (e) => {
      if (hooks.readOnly || e.buttons || editing || !sheet()) return hideIns();
      if (e.target === ins || ins.contains(e.target)) return;
      // a grab hand over the header of a whole selected row / column: it can be dragged to move
      {
        const rg = range(), one = !(S().extra || []).length, rhh = e.target.closest('th.sg-rh'), thh = e.target.closest('th[data-name], th[data-c]');
        let can = false;
        if (one && rhh) { const r = Number(rhh.parentElement.dataset.r); can = rg.c1 === 0 && rg.c2 === nCols() - 1 && r >= rg.r1 && r <= rg.r2; }
        else if (one && thh && !e.target.closest('.sg-rz, .sg-menu')) { const c = Number(thh.dataset.name ?? thh.dataset.c); can = rg.r1 === 0 && rg.r2 === Math.max(0, view().length - 1) && view().length > 0 && c >= rg.c1 && c <= rg.c2; }
        root.classList.toggle('can-move', can);
      }
      const base = root.getBoundingClientRect();
      const put = (kind, at, x, y, label) => {
        Object.assign(ins.dataset, { kind, at });
        ins.style.left = x - base.left + root.scrollLeft + 'px';
        ins.style.top = y - base.top + root.scrollTop + 'px';
        ins.title = label;
        ins.setAttribute('aria-label', label);
        ins.classList.remove('hidden');
      };
      const rh = e.target.closest('th.sg-rh');
      if (rh) {
        const r = rh.getBoundingClientRect(), vr = Number(rh.parentElement.dataset.r);
        if (e.clientY - r.top < EDGE) return put('row', vr, r.left + r.width / 2, r.top, 'Insert a row here');
        if (r.bottom - e.clientY < EDGE) return put('row', vr + 1, r.left + r.width / 2, r.bottom, 'Insert a row here');
      }
      const th = e.target.closest('tr.sg-letters th[data-c]');
      if (th) {
        const r = th.getBoundingClientRect(), c = Number(th.dataset.c);
        // only on the letters row's upper half: the rest of the line, down through the names row, is the column's
        // resize handle (drag) and fit (double-click)
        const y = r.top + 10, near = e.clientY - r.top < r.height * 0.55; // fully inside the top row (the grid clips its edge)
        if (near && e.clientX - r.left < EDGE && c > 0) return put('col', c, r.left, y, 'Insert a column here');
        if (near && r.right - e.clientX < EDGE + 2) return put('col', c + 1, r.right, y, 'Insert a column here');
      }
      hideIns();
    });
    root.addEventListener('pointerleave', hideIns);
    ins.addEventListener('pointerdown', (e) => e.stopPropagation()); // not the start of a selection drag
    ins.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const sh = sheet(), at = Number(ins.dataset.at), kind = ins.dataset.kind;
      hideIns();
      if (!sh || !kind) return;
      if (kind === 'row') {
        const v = view();
        const idx = at < v.length ? sh.rows.indexOf(v[at]) : v.length ? sh.rows.indexOf(v[v.length - 1]) + 1 : sh.rows.length;
        insertRows(idx, 1);
        select(Math.min(at, view().length - 1), S().fc);
      } else {
        insertCol(at);
        select(S().fr, at);
      }
      root.focus({ preventScroll: true });
    });

    function moveBy(dr, dc, extend) {
      const s = S();
      const r = Math.min(Math.max(s.fr + dr, 0), Math.max(0, view().length - 1));
      const c = Math.min(Math.max(s.fc + dc, 0), Math.max(0, nCols() - 1));
      if (extend) select(s.ar, s.ac, r, c, { keep: true });
      else select(r, c);
    }

    function clearRange() {
      const sh = sheet(), changes = [], seen = new Set();
      for (const rg of ranges()) for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
        const k = r + ':' + c;
        if (sh.view[r] && !seen.has(k)) { seen.add(k); changes.push({ row: sh.view[r], c, v: '' }); }
      }
      setCells(changes, 'Clear');
    }
    // Every cell in the sheet, filtered-out rows too; the column names stay. Undoable like any edit.
    function clearAll() {
      const changes = [];
      for (const row of sheet()?.rows || []) row.cells.forEach((v, c) => { if (v !== '' && v != null) changes.push({ row, c, v: '' }); });
      if (changes.length) setCells(changes, 'Clear all');
      return changes.length;
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
      // Pressing a row number / column header inside a whole-row or whole-column selection grabs it, to move it
      // (Sheets-style); a plain click without moving still just selects (see mouseup).
      const rgm = range(), one = !(S().extra || []).length, plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !hooks.readOnly;
      if (plain && one && rh && view().length) {
        const r = Number(rh.parentElement.dataset.r);
        if (rgm.c1 === 0 && rgm.c2 === nCols() - 1 && r >= rgm.r1 && r <= rgm.r2) { e.preventDefault(); root.focus({ preventScroll: true }); moving = { kind: 'rows', a: rgm.r1, b: rgm.r2, x: e.clientX, y: e.clientY, at: r }; return; }
      }
      if (plain && one && name && name.dataset.c != null && view().length) {
        const c = Number(name.dataset.c);
        if (rgm.r1 === 0 && rgm.r2 === last && c >= rgm.c1 && c <= rgm.c2) { e.preventDefault(); root.focus({ preventScroll: true }); moving = { kind: 'cols', a: rgm.c1, b: rgm.c2, x: e.clientX, y: e.clientY, at: c }; return; }
      }
      if (hit) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        const add = e.metaKey || e.ctrlKey;
        if (e.shiftKey) select(S().ar, S().ac, hit.r, hit.c, { scroll: false, keep: true });
        else select(hit.r, hit.c, hit.r, hit.c, { scroll: false, add });
        dragging = true;
      } else if (rh) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        const r = Number(rh.parentElement.dataset.r);
        select(e.shiftKey ? S().ar : r, 0, r, nCols() - 1, { scroll: false, keep: e.shiftKey, add: !e.shiftKey && (e.metaKey || e.ctrlKey) });
        dragging = 'rows';
      } else if (name && name.dataset.name != null) {
        // a column name: select it (shift-click: from the selected name to this one)
        e.preventDefault();
        root.focus({ preventScroll: true });
        const c = Number(name.dataset.name);
        selectHeader(e.shiftKey && hdr() ? hdr().a : c, c);
        dragging = 'names';
      } else if (name) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        const c = Number(name.dataset.c);
        select(0, e.shiftKey ? S().ac : c, last, c, { scroll: false, keep: e.shiftKey, add: !e.shiftKey && (e.metaKey || e.ctrlKey) });
        dragging = 'cols';
      }
    });
    // --- Moving rows / columns: a line shows where they'll land; the grid scrolls when you drag to its edge.
    let moving = null;
    const dropLine = document.createElement('div');
    dropLine.className = 'sg-drop hidden';
    root.append(dropLine);
    function moveTarget(e) {
      const el = document.elementFromPoint(e.clientX, e.clientY), base = root.getBoundingClientRect();
      if (moving.kind === 'rows') {
        const tr = el?.closest?.('tr[data-r]');
        if (!tr || !root.contains(tr)) return null;
        const r = tr.getBoundingClientRect(), i = Number(tr.dataset.r), lower = e.clientY > r.top + r.height / 2;
        return { t: lower ? i + 1 : i, pos: (lower ? r.bottom : r.top) - base.top + root.scrollTop };
      }
      const th = el?.closest?.('th[data-c], th[data-name], td[data-c]');
      if (!th || !root.contains(th)) return null;
      const r = th.getBoundingClientRect(), i = Number(th.dataset.c ?? th.dataset.name), right = e.clientX > r.left + r.width / 2;
      return { t: right ? i + 1 : i, pos: (right ? r.right : r.left) - base.left + root.scrollLeft };
    }
    document.addEventListener('mousemove', (e) => {
      if (!moving) return;
      if (!moving.started) {
        if (Math.hypot(e.clientX - moving.x, e.clientY - moving.y) < 5) return;
        moving.started = true;
        root.classList.add('sg-moving');
        hideIns();
      }
      // near an edge: scroll that way
      const b = root.getBoundingClientRect();
      if (moving.kind === 'rows') { if (e.clientY > b.bottom - 24) root.scrollTop += 14; else if (e.clientY < b.top + thead.offsetHeight + 16) root.scrollTop -= 14; }
      else { if (e.clientX > b.right - 24) root.scrollLeft += 14; else if (e.clientX < b.left + (hooks.indexWidth || 64) + 16) root.scrollLeft -= 14; }
      const tg = moveTarget(e);
      if (!tg) return;
      moving.t = tg.t;
      const inside = tg.t >= moving.a && tg.t <= moving.b + 1; // dropping where it already is: no line
      dropLine.classList.toggle('hidden', inside);
      dropLine.classList.toggle('col', moving.kind === 'cols');
      Object.assign(dropLine.style, moving.kind === 'rows'
        ? { top: tg.pos - 1 + 'px', left: root.scrollLeft + 'px', width: root.clientWidth + 'px', height: '3px' }
        : { left: tg.pos - 1 + 'px', top: root.scrollTop + 'px', height: root.clientHeight + 'px', width: '3px' });
    });
    document.addEventListener('mouseup', () => {
      if (!moving) return;
      const m = moving;
      moving = null;
      root.classList.remove('sg-moving');
      dropLine.classList.add('hidden');
      const last = Math.max(0, view().length - 1);
      if (!m.started) { // just a click: select that one row / column, as before
        if (m.kind === 'rows') select(m.at, 0, m.at, nCols() - 1, { scroll: false });
        else select(0, m.at, last, m.at, { scroll: false });
        return;
      }
      if (m.t == null || (m.t >= m.a && m.t <= m.b + 1)) return;
      const n = m.b - m.a + 1, start = m.t > m.b ? m.t - n : m.t;
      if (m.kind === 'rows') { moveRows(m.a, m.b, m.t); select(start, 0, start + n - 1, nCols() - 1, { scroll: false }); }
      else { moveCols(m.a, m.b, m.t); select(0, start, Math.max(0, view().length - 1), start + n - 1, { scroll: false }); }
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || !root.contains(el)) return;
      if (dragging === 'rows') {
        const tr = el.closest('tr[data-r]');
        if (tr) select(S().ar, 0, Number(tr.dataset.r), nCols() - 1, { scroll: false, keep: true });
        return;
      }
      if (dragging === 'names') { // dragging along the column names: select from the first one to here
        const th = el.closest('th[data-name]');
        if (th && hdr() && Number(th.dataset.name) !== hdr().f) selectHeader(hdr().a, Number(th.dataset.name));
        return;
      }
      if (dragging === 'cols') {
        const th = el.closest('th[data-c], th[data-name], td[data-c]');
        const c = th && Number(th.dataset.c ?? th.dataset.name);
        if (th && !Number.isNaN(c) && c !== S().fc) select(0, S().ac, Math.max(0, view().length - 1), c, { scroll: false, keep: true });
        return;
      }
      const hit = cellAt(el);
      if (hit && (hit.r !== S().fr || hit.c !== S().fc)) select(S().ar, S().ac, hit.r, hit.c, { scroll: false, keep: true });
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
      // the new width is one step in the history: ⌘Z puts the old one back
      const up = () => {
        h.removeEventListener('pointermove', move);
        const w1 = sh.widths[c];
        if (w1 !== w0) run({ kind: 'layout', label: 'Resize', do: () => { sh.widths[c] = w1; }, undo: () => { sh.widths[c] = w0; } });
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up, { once: true });
    });
    // Double-click a column's edge: fit it to its text (as in Sheets).
    root.addEventListener('dblclick', (e) => {
      const h = e.target.closest('.sg-rz');
      if (!h) return;
      e.preventDefault(); e.stopPropagation();
      const c = Number(h.dataset.rz);
      fitCols(colOn(c) ? selCols() : [c]);
    }, true);

    // The width a column needs for its name and its longest value (looking at up to 3,000 rows), within limits.
    function fitWidth(sh, c) {
      mctx ||= document.createElement('canvas').getContext('2d');
      mctx.font = '600 13px Inter, sans-serif';
      let w = mctx.measureText(String(sh.headers[c] ?? '')).width + 46; // the name, its icons and the menu
      mctx.font = '13px Inter, sans-serif';
      for (const row of sh.rows.slice(0, 3000)) {
        const t = String(row.cells[c] ?? '');
        if (t) w = Math.max(w, Math.max(...t.split('\n').map((p) => mctx.measureText(p).width)) + 20);
      }
      return Math.round(Math.min(480, Math.max(56, w)));
    }
    function fitCols(list) {
      const sh = sheet(), before = list.map((k) => sh.widths[k]), next = list.map((k) => fitWidth(sh, k));
      if (next.every((w, i) => w === before[i])) return;
      run({ kind: 'layout', label: 'Fit', do: () => list.forEach((k, i) => { sh.widths[k] = next[i]; }), undo: () => list.forEach((k, i) => { sh.widths[k] = before[i]; }) });
      root.focus({ preventScroll: true }); // back to the grid, so ⌘Z works straight away
    }
    function setWrap(list, on) {
      const sh = sheet(), before = list.map((k) => Boolean(sh.wraps?.[k]));
      run({ kind: 'layout', label: on ? 'Wrap' : 'Unwrap', do: () => list.forEach((k) => { wraps(sh)[k] = on; }), undo: () => list.forEach((k, i) => { wraps(sh)[k] = before[i]; }) });
      root.focus({ preventScroll: true });
    }

    root.addEventListener('contextmenu', (e) => {
      const hit = cellAt(e.target), rh = e.target.closest('th.sg-rh'), name = e.target.closest('th[data-name], th[data-c]');
      if (!hit && !rh && !name) return;
      e.preventDefault();
      if (name) return columnMenu(Number(name.dataset.name ?? name.dataset.c), e.clientX, e.clientY);
      const r = hit ? hit.r : Number(rh.parentElement.dataset.r);
      if (hit ? !inSel(r, hit.c) : !rowOn(r)) select(r, hit ? hit.c : 0, r, hit ? hit.c : nCols() - 1, { scroll: false });
      rowMenu(e.clientX, e.clientY);
    });

    // --- Menus -----------------------------------------------------------------

    function rowMenu(x, y) {
      const sh = sheet(), rg = range(), single = !(S().extra || []).length;
      const rowIdx = selRows(), rows = rowIdx.map((r) => sh.view[r]).filter(Boolean), n = rows.length;
      const cells = ranges().reduce((t, g) => t + (g.r2 - g.r1 + 1) * (g.c2 - g.c1 + 1), 0);
      const at = (r) => sh.rows.indexOf(sh.view[r]);
      const rowsWord = n > 1 ? n + ' rows' : 'row';
      if (hooks.readOnly) return Menu.open(x, y, [{ label: 'Copy', kbd: '⌘C', action: () => document.execCommand('copy') }, ...(hooks.rowMenuExtras?.(sh, rows) || [])]);
      Menu.open(x, y, [
        ...(single ? [{ label: 'Cut', kbd: '⌘X', action: () => document.execCommand('cut') }, { label: 'Copy', kbd: '⌘C', action: () => document.execCommand('copy') }] : []),
        { label: cells > 1 ? `Clear ${cells} cells` : 'Clear cell', kbd: '⌫', action: clearRange },
        '-',
        // Inserting next to several separate ranges has no single place to go, so only for one range.
        ...(single ? [
          { label: `Insert ${rowsWord} above`, action: () => { insertRows(at(rg.r1), n); select(rg.r1, S().fc); } },
          { label: `Insert ${rowsWord} below`, action: () => { insertRows(at(rg.r2) + 1, n); select(rg.r2 + 1, S().fc); } },
        ] : []),
        { label: `Delete ${rowsWord}`, danger: true, action: () => deleteRows(rows) },
        ...(hooks.rowMenuExtras?.(sh, rows) || []),
      ]);
    }

    function columnMenu(c, x, y) {
      const sh = sheet();
      // Several columns selected (in one range or several) and this is one of them: act on all of them.
      const chosen = colOn(c) ? selCols() : [c], many = chosen.length > 1, n = chosen.length;
      const contiguous = chosen[n - 1] - chosen[0] === n - 1, c1 = chosen[0], c2 = chosen[n - 1];
      const cols = (w) => (n === 1 ? `column${w ? ' ' + w : ''}` : `${n} columns${w ? ' ' + w : ''}`);
      const names = contiguous ? (n > 1 ? `${letter(c1)}–${letter(c2)}` : letter(c1)) : chosen.map(letter).join(', ');
      const clearCols = () => { const sh2 = sheet(), ch = []; for (const row of sh2.view) for (const k of chosen) ch.push({ row, c: k, v: '' }); setCells(ch, 'Clear'); };
      Menu.open(x, y, [
        ...(hooks.columnMenuExtras?.(sh, c) || []),
        { label: 'Sort A → Z', action: () => sortBy(c, 1) },
        { label: 'Sort Z → A', action: () => sortBy(c, -1) },
        { label: sh.filters[c] ? 'Edit filter…' : 'Filter…', action: () => filterPopover(c, x, y) },
        ...(sh.filters[c] ? [{ label: 'Clear filter', action: () => { delete sh.filters[c]; after('filter'); } }] : []),
        ...(hooks.readOnly ? [] : ['-',
        ...(many ? [] : [{ label: 'Rename', action: () => startEdit(null, -1, c) }]),
        // size and wrap, for every chosen column (one step each in the history)
        { label: n === 1 ? 'Fit to content' : `Fit ${n} columns to content`, action: () => fitCols(chosen) },
        (() => { const all = chosen.every((k) => sh.wraps?.[k]); return { label: all ? (n === 1 ? 'Unwrap text' : `Unwrap text in ${n} columns`) : (n === 1 ? 'Wrap text' : `Wrap text in ${n} columns`), action: () => setWrap(chosen, !all) }; })(),
        '-',
        { label: many ? `Clear ${n} columns` : 'Clear column', action: clearCols },
        ...(contiguous ? [
          { label: `Insert ${cols('left')}`, action: () => (many ? insertCols(c1, n) : insertCol(c)) },
          { label: `Insert ${cols('right')}`, action: () => (many ? insertCols(c2 + 1, n) : insertCol(c + 1)) },
        ] : []),
        { label: many ? `Delete ${n} columns (${names})` : 'Delete column', danger: true, action: () => (many ? deleteColSet(chosen) : deleteCol(c)) }]),
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
        <input data-1p-ignore data-lpignore="true" data-form-type="other" autocomplete="off" class="sg-pop-search" placeholder="Search values" />
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
      // In the names row: arrows move along it (shift to extend), down goes into the cells; typing, Enter or F2 renames.
      if (hdr()) {
        const h = hdr();
        if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Tab') {
          e.preventDefault();
          const d = (k === 'ArrowLeft' || (k === 'Tab' && e.shiftKey)) ? -1 : 1;
          const f = meta ? (d < 0 ? 0 : nCols() - 1) : h.f + d;
          return e.shiftKey && k !== 'Tab' ? selectHeader(h.a, f) : selectHeader(f);
        }
        if (k === 'ArrowDown') { e.preventDefault(); if (view().length) select(0, h.f); return; }
        if (k === 'ArrowUp' || k === 'Escape') { e.preventDefault(); if (k === 'Escape') selectHeader(h.f); return; }
        if (k === 'Enter' || k === 'F2') { e.preventDefault(); if (!hooks.readOnly) startEdit(null, -1, h.f); return; }
        if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); hooks.notify?.('A column needs a name: type a new one to rename it'); return; }
        if (k.length === 1 && !meta && !e.altKey && !hooks.readOnly) { e.preventDefault(); startEdit(k, -1, h.f); return; }
        if (meta && k.toLowerCase() === 'a') { e.preventDefault(); selectHeader(0, nCols() - 1); return; }
        return;
      }
      // up from the first row: into the column names
      if (k === 'ArrowUp' && !e.shiftKey && !meta && s.fr === 0 && nCols()) { e.preventDefault(); selectHeader(s.fc); return; }
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
      const hr = hdrRange();
      if (hr) { // the column names, tab-separated (one row)
        e.clipboardData.setData('text/plain', sh.headers.slice(hr.c1, hr.c2 + 1).map((h) => tsvCell(String(h))).join('\t'));
        e.preventDefault();
        hooks.notify?.(`Copied ${hr.c2 > hr.c1 ? `${hr.c2 - hr.c1 + 1} column names` : 'column name'}`);
        return;
      }
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
      if (hdr()) return; // names can't be emptied (copy works, then type or paste over them)
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
      if (hdr()) pasteNames(parseTsv(text));
      else paste(parseTsv(text));
    });

    // Paste over the column names: the first line renames from the selected name on (new columns if it runs past
    // the last); any more lines fill the cells below, from the first row. One undo step.
    function pasteNames(block) {
      const sh = sheet(), c0 = hdrRange().c1;
      if (!block.length || !block[0].length) return;
      const names = block[0], rest = block.slice(1);
      const width = Math.max(...block.map((b) => b.length));
      const needCols = c0 + width - sh.headers.length;
      const beforeHeaders = sh.headers.slice(), beforeWidths = sh.widths.slice(), beforeRows = sh.rows.slice(), beforeCells = sh.rows.map((r) => r.cells.slice());
      const renames = [];
      run({
        kind: 'paste',
        do: () => {
          renames.length = 0;
          for (let k = 0; k < needCols; k++) { sh.headers.push(uniqueName(sh, `Column ${letter(sh.headers.length)}`)); sh.widths.push(140); sh.rows.forEach((r) => r.cells.push('')); }
          names.forEach((v, j) => {
            const c = c0 + j, old = sh.headers[c], nm = String(v).trim() ? uniqueName(sh, String(v).trim(), c) : old;
            if (nm !== old) { sh.headers[c] = nm; renames.push([old, nm]); hooks.renamed?.(sh, old, nm); }
          });
          if (rest.length) {
            const viewRows = sh.view.slice(0);
            const needRows = rest.length - viewRows.length;
            if (needRows > 0) {
              const made = Array.from({ length: needRows }, () => ({ cells: Array.from({ length: sh.headers.length }, () => ''), on: true }));
              sh.rows.push(...made);
              viewRows.push(...made);
            }
            rest.forEach((line, i) => line.forEach((v, j) => { viewRows[i].cells[c0 + j] = v; }));
          }
        },
        undo: () => {
          for (const [old, nm] of [...renames].reverse()) hooks.renamed?.(sh, nm, old);
          sh.headers = beforeHeaders.slice();
          sh.widths = beforeWidths.slice();
          sh.rows = beforeRows.slice();
          sh.rows.forEach((r, i) => { r.cells = beforeCells[i].slice(); });
        },
      });
      selectHeader(c0, c0 + names.length - 1);
      hooks.notify?.(rest.length ? `Pasted ${names.length} name${names.length === 1 ? '' : 's'} and ${rest.length} row${rest.length === 1 ? '' : 's'}` : `Renamed ${names.length} column${names.length === 1 ? '' : 's'}`);
    }

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
      selectedRows() { return selRows().map((r) => view()[r]).filter(Boolean); },
      selectedCols: () => selCols(),
      clearSelection: () => clearRange(),
      clearAll,
      deleteColumns: (list) => deleteColSet(list ?? selCols()),
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
      // left / right of the selection, as many columns as are selected (like the column menu)
      insertColumnAt(where) {
        const rg = range(), n = rg.c2 - rg.c1 + 1;
        const at = where === 'left' ? rg.c1 : rg.c2 + 1;
        if (n > 1) insertCols(at, n); else insertCol(at);
        select(S().fr, at);
      },
      // how many rows and columns are selected (for the toolbar's Insert menus)
      selectionSize() { const rg = range(); return { rows: rg.r2 - rg.r1 + 1, cols: rg.c2 - rg.c1 + 1, hasRows: sheet().view.length > 0 }; },
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
      // A choice menu (any item with `checked`): a check column on the left, the chosen item marked.
      const choice = items.some((it) => it && typeof it.checked === 'boolean');
      el.classList.toggle('choice', choice);
      const TICK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
      items.filter(Boolean).forEach((it) => {
        if (it === '-') return el.insertAdjacentHTML('beforeend', '<hr />');
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', choice ? 'menuitemradio' : 'menuitem');
        if (choice) b.setAttribute('aria-checked', String(Boolean(it.checked)));
        b.className = `${it.danger ? 'danger' : ''} ${it.checked ? 'on' : ''}`.trim();
        b.disabled = Boolean(it.disabled);
        b.innerHTML = `${choice ? `<i class="mi-check">${it.checked ? TICK : ''}</i>` : ''}${it.pre || ''}<span>${escHtml(it.label)}</span>${it.kbd ? `<kbd>${escHtml(it.kbd)}</kbd>` : ''}`;
        b.addEventListener('click', () => { close(); it.action?.(); });
        el.append(b);
      });
      place(el, x, y);
      openedAt = Date.now();
      (el.querySelector('button.on:not(:disabled)') || el.querySelector('button:not(:disabled)'))?.focus({ preventScroll: true });
    }
    function panel(x, y, html) {
      close();
      el = document.createElement('div');
      el.className = 'sg-menu-pop sg-pop';
      el.innerHTML = html;
      place(el, x, y);
      openedAt = Date.now();
      return el;
    }
    // Re-places a panel once its contents are in (a panel filled after it opens was measured nearly empty): below the
    // anchor when it fits, above it when there's room there instead, and never off screen; taller than the window, it
    // scrolls inside itself.
    function fit(node, anchor, gap = 6) {
      node.style.maxHeight = innerHeight - 16 + 'px';
      node.style.overflowY = 'auto';
      const { width: w, height: h } = node.getBoundingClientRect();
      const below = anchor.bottom + gap, above = anchor.top - gap - h;
      if (below + h <= innerHeight - 8 || above < 8) {
        node.style.bottom = '';
        node.style.top = (below + h <= innerHeight - 8 ? below : Math.max(8, innerHeight - h - 8)) + 'px';
      } else {
        // above its button: held by its bottom edge, so when its content gets shorter or taller it stays on the button
        node.style.top = 'auto';
        node.style.bottom = innerHeight - (anchor.top - gap) + 'px';
      }
      // the page's width without its scrollbar; a panel that doesn't fit to the right of its button lines up with the
      // button's right edge instead (so it opens leftward, as a menu at the end of a toolbar should)
      const vw = document.documentElement.clientWidth;
      const left = anchor.left + w <= vw - 12 ? anchor.left : (anchor.right ?? anchor.left) - w;
      node.style.left = Math.max(12, Math.min(left, vw - w - 12)) + 'px';
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
    // (The first moments after opening don't count: the page may still be easing into place.)
    let openedAt = 0;
    addEventListener('scroll', (e) => { if (el && Date.now() - openedAt > 400 && !(e.target instanceof Node && el.contains(e.target))) close(); }, { capture: true, passive: true });
    // Swap what a panel shows (days ↔ months, say) as one movement: its height glides from the old size to the new,
    // and the new content zooms in ('out': from a little larger, as when stepping back to a wider view; 'in': from a
    // little smaller, as when stepping into one).
    function morph(node, render, { zoom = 'out', part = null } = {}) {
      if (window.Motion?.reduce?.()) return render();
      const h0 = node.getBoundingClientRect().height;
      render();
      const h1 = node.getBoundingClientRect().height;
      const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
      if (Math.abs(h1 - h0) > 1) {
        const ov = node.style.overflowY;
        node.style.overflowY = 'hidden';
        node.animate([{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: 280, easing: ease }).finished.finally(() => { node.style.overflowY = ov; });
      }
      const target = typeof part === 'string' ? node.querySelector(part) : part || node.firstElementChild;
      target?.animate([{ opacity: 0, transform: `scale(${zoom === 'out' ? 1.06 : 0.94})`, filter: 'blur(2px)' }, { opacity: 1, transform: 'none', filter: 'none' }], { duration: 260, easing: ease });
    }
    return { open, panel, close, fit, morph };
  })();

  window.Sheet = { create, letter, parseTsv, Menu };
})();
