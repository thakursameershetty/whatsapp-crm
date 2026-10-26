// Send page: contact lists in a spreadsheet, the message set up in a side panel,
// and one bar to send. Several files, and every sheet of an Excel workbook, open
// as tabs at the bottom; ticked tabs are combined into one recipient list with
// duplicate numbers removed. Edits change what gets sent, never the original file.

(function () {
  const SP = {
    sheets: [], // { id, name, file, headers, rows: [{ cells, on, st, phone }], widths, filters, phoneName, included, dirty }
    active: -1,
    mapping: {}, // variable key -> { type: 'column' | 'fixed', value }
    panel: (() => { try { return localStorage.getItem('sendPanel') !== '0'; } catch { return true; } })(),
  };
  const current = () => SP.sheets[SP.active] || null;
  let nextId = 1;

  // Each file gets a colour, shared by all its sheets, kept for as long as the page is open.
  const PALETTE = 6;
  const fileColors = new Map();
  const colorOf = (sh) => {
    const key = sh.file || 'sheet:' + sh.id;
    if (!fileColors.has(key)) fileColors.set(key, fileColors.size % PALETTE);
    return `var(--file-${fileColors.get(key) + 1})`;
  };

  // --- Reading files into sheets ------------------------------------------------

  async function readWorkbook(file) {
    if (/\.xlsx?$/i.test(file.name)) {
      const XLSX = await loadXlsxLib();
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      return wb.SheetNames.map((name) => ({
        name,
        // raw: true keeps long phone numbers as digits instead of "9.19E+11".
        grid: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' }).map((r) => r.map((c) => (c == null ? '' : String(c)))),
      }));
    }
    return [{ name: '', grid: parseCsv(await file.text()) }];
  }

  // A first row with phone numbers in it is data, not column names.
  function toTable(grid) {
    const rows = grid.filter((r) => r.some((c) => String(c).trim()));
    if (!rows.length) return { headers: [], rows: [] };
    const hasHeader = !rows[0].some(looksLikePhone);
    const width = Math.max(...rows.map((r) => r.length));
    const headers = [];
    for (let i = 0; i < width; i++) {
      let h = (hasHeader ? String(rows[0][i] ?? '').trim() : '') || `Column ${Sheet.letter(i)}`;
      for (let k = 2; headers.includes(h); k++) h = `${h.replace(/ \(\d+\)$/, '')} (${k})`;
      headers.push(h);
    }
    const data = (hasHeader ? rows.slice(1) : rows).map((r) => headers.map((_, i) => String(r[i] ?? '').trim()));
    return { headers, rows: data };
  }

  const guessPhone = (headers, rows) => guessPhoneColumn(headers, rows);

  function autoWidths(headers, rows) {
    return headers.map((h, i) => {
      let len = h.length + 3;
      for (const r of rows.slice(0, 200)) len = Math.max(len, String(r[i] ?? '').length);
      return Math.max(90, Math.min(320, Math.round(len * 8.4 + 34)));
    });
  }

  function makeSheet({ name, file, headers, rows }) {
    const sh = {
      id: nextId++,
      name: name || file || 'Sheet',
      file: file || '',
      headers,
      rows: rows.map((cells) => ({ cells, on: true })),
      widths: autoWidths(headers, rows),
      filters: {},
      phoneName: guessPhone(headers, rows),
      included: true,
      dirty: false,
    };
    recheck(sh);
    return sh;
  }

  async function openFiles(list) {
    const files = [...list].filter((f) => /\.(csv|tsv|txt|xlsx|xls)$/i.test(f.name));
    if (!files.length) return toast('Choose CSV or Excel files (.csv, .tsv, .xlsx, .xls)', 'error');
    let added = 0, firstNew = SP.sheets.length;
    for (const file of files) {
      // The same file again usually means an updated copy: swap it in rather than opening duplicate tabs.
      const open = SP.sheets.filter((s) => s.file === file.name);
      if (open.length) {
        const edited = open.some((s) => s.dirty);
        const ok = await confirmDialog({
          title: `Replace ${esc(file.name)}?`,
          message: `It's already open${edited ? ', and your edits to it will be lost' : ''}. The new copy takes its place.`,
          confirmText: 'Replace',
        });
        if (!ok) continue;
        SP.sheets = SP.sheets.filter((s) => s.file !== file.name);
        firstNew = SP.sheets.length;
        grid.clearHistory();
      }
      try {
        const book = await readWorkbook(file);
        const filled = book.filter((b) => b.grid.some((r) => r.some((c) => String(c).trim())));
        if (!filled.length) { toast(`${file.name} is empty`, 'error'); continue; }
        for (const b of filled) {
          const t = toTable(b.grid);
          SP.sheets.push(makeSheet({ name: filled.length > 1 || book.length > 1 ? b.name : file.name, file: file.name, ...t }));
          added++;
        }
      } catch (e) {
        toast(`Couldn't read ${file.name}: ${e.message}`, 'error');
      }
    }
    if (!added) return;
    activate(firstNew);
    const rows = SP.sheets.slice(firstNew).reduce((n, s) => n + s.rows.length, 0);
    toast(`Opened ${added} sheet${added > 1 ? 's' : ''} · ${rows.toLocaleString()} rows`);
  }

  // --- Phone checks ----------------------------------------------------------------

  // Each row: st = 'empty' | 'invalid' | 'duplicate' | 'valid', phone = normalised number.
  function recheck(sh) {
    const col = sh.headers.indexOf(sh.phoneName);
    const seen = new Set();
    const counts = { valid: 0, invalid: 0, duplicate: 0, rows: 0 };
    for (const row of sh.rows) {
      if (row.cells.every((v) => !String(v ?? '').trim())) { row.st = 'empty'; row.phone = null; continue; }
      counts.rows++;
      const p = col >= 0 ? normalizePhone(row.cells[col]) : null;
      row.phone = p;
      row.st = !p ? 'invalid' : seen.has(p) ? 'duplicate' : (seen.add(p), 'valid');
      counts[row.st]++;
    }
    sh.counts = counts;
  }

  // --- The grid ----------------------------------------------------------------------

  // "Show" filter above the grid: only changes what you see, never who gets the message.
  const SHOW = {
    all: { label: 'All', test: () => true },
    valid: { label: 'Valid', test: (r) => r.st === 'valid' },
    invalid: { label: 'Invalid', test: (r) => r.st === 'invalid' },
    duplicate: { label: 'Duplicates', test: (r) => r.st === 'duplicate' },
    off: { label: 'Left out', test: (r) => !r.on && r.st !== 'invalid' && r.st !== 'empty' },
  };

  const grid = Sheet.create($('#spGrid'), {
    sheet: current,
    checkable: true,
    indexWidth: 72,
    rowFilter: (sh, r) => !sh.show || sh.show === 'all' || SHOW[sh.show].test(r),
    emptyText: (sh) => (sh.show && sh.show !== 'all' ? `No ${SHOW[sh.show].label.toLowerCase()} rows${Object.keys(sh.filters).length ? ' among the filtered rows' : ''}.` : ''),
    rowInfo(sh, row) {
      const can = row.st !== 'invalid' && row.st !== 'empty';
      return {
        cls: row.st === 'empty' ? 'empty' : row.on && can ? '' : 'off',
        checked: row.on && can,
        disabled: !can,
        checkTitle: row.st === 'invalid' ? "Can't send: not a valid phone number" : row.st === 'empty' ? '' : row.on ? 'Will be sent · click to leave out' : 'Left out · click to include',
      };
    },
    cellInfo(sh, row, c) {
      if (sh.headers[c] !== sh.phoneName || row.st === 'empty') return null;
      if (row.st === 'invalid') return { cls: 'ph bad', title: 'Not a valid phone number' };
      if (row.st === 'duplicate') return { cls: 'ph dup', title: `+${row.phone} appears earlier in this sheet; it's sent once` };
      return { cls: 'ph', title: `+${row.phone}` };
    },
    headerTag: (sh, c) => (sh.headers[c] === sh.phoneName ? `<span class="sg-tag" title="Phone column">${icon('phone', 11)}</span>` : ''),
    allChecked(sh) {
      const can = sh.view.filter((r) => r.st !== 'invalid' && r.st !== 'empty');
      if (!can.length) return false;
      const on = can.filter((r) => r.on).length;
      return on === can.length ? true : on ? null : false;
    },
    check(sh, rows, on) {
      rows.forEach((r) => { r.on = on; });
      renderChrome();
      renderPreview();
    },
    prepare: (sh) => sh && recheck(sh),
    changed(kind) {
      const sh = current();
      if (!sh) return;
      sh.dirty = true;
      if (kind === 'cols' || kind === 'rename' || kind === 'table') { renderPhoneSelect(); renderMapping(); }
      renderChrome();
    },
    selected: () => { SP.previewAt = null; renderPreview(); },
    activate: (sh) => activate(SP.sheets.indexOf(sh)),
    renamed(sh, from, to) {
      if (sh.phoneName === from) sh.phoneName = to;
      for (const m of Object.values(SP.mapping)) if (m.type === 'column' && m.value === from && !otherHas(sh, from)) m.value = to;
    },
    adoptTable(sh, block) {
      const t = toTable(block);
      Object.assign(sh, { headers: t.headers, rows: t.rows.map((cells) => ({ cells, on: true })), widths: autoWidths(t.headers, t.rows), filters: {}, phoneName: guessPhone(t.headers, t.rows) });
      recheck(sh);
      renderPhoneSelect();
      onTemplateChange();
      toast(`Pasted ${t.rows.length.toLocaleString()} rows${t.headers.length ? ` · columns: ${t.headers.slice(0, 4).join(', ')}${t.headers.length > 4 ? '…' : ''}` : ''}`);
    },
    columnMenuExtras: (sh, c) => [
      sh.headers[c] === sh.phoneName ? { label: 'This is the phone column', disabled: true } : { label: 'Use as phone column', action: () => setPhone(sh.headers[c]) },
      '-',
    ],
    rowMenuExtras: (sh, rows) => {
      const can = rows.filter((r) => r.st !== 'invalid' && r.st !== 'empty');
      if (!can.length) return [];
      return ['-', { label: can.every((r) => r.on) ? 'Leave out of the send' : 'Include in the send', action: () => { const on = !can.every((r) => r.on); can.forEach((r) => (r.on = on)); grid.redraw(); renderChrome(); } }];
    },
    find: () => openFind(),
    notify: (m) => toast(m),
  });
  const otherHas = (sh, name) => SP.sheets.some((x) => x !== sh && x.included && x.headers.includes(name));

  function setPhone(name) {
    const sh = current();
    sh.phoneName = name;
    recheck(sh);
    renderPhoneSelect();
    grid.redraw();
    renderChrome();
  }

  // --- Sheets and tabs ------------------------------------------------------------------

  function activate(i) {
    SP.active = Math.max(-1, Math.min(i, SP.sheets.length - 1));
    grid.render();
    renderPhoneSelect();
    onTemplateChange();
    renderChrome();
    grid.redraw(); // again now the grid is visible, so it can measure its width
    if (current()) grid.focus();
  }

  // Remove sheets (one tab, or every sheet of an uploaded file). Only asks when there are edits to lose.
  async function closeSheets(list, fileName = '') {
    if (!list.length) return;
    const edited = list.some((x) => x.dirty);
    const what = fileName ? `“${fileName}”${list.length > 1 ? ` (${list.length} sheets)` : ''}` : `“${list[0].name}”`;
    if (edited && !(await confirmDialog({ title: `Remove ${what}?`, message: 'Your edits will be lost. The original file on your computer is not changed.', confirmText: 'Remove', danger: true }))) return;
    const activeSheet = SP.sheets[SP.active];
    const firstIdx = SP.sheets.indexOf(list[0]);
    SP.sheets = SP.sheets.filter((x) => !list.includes(x));
    grid.clearHistory(); // undo steps may point at a removed sheet
    const keep = SP.sheets.indexOf(activeSheet);
    activate(keep >= 0 ? keep : Math.min(firstIdx, SP.sheets.length - 1));
    toast(`Removed ${what}`);
  }

  function renderTabs() {
    let html = '';
    SP.sheets.forEach((sh, i) => {
      const prev = SP.sheets[i - 1];
      const many = sh.file && SP.sheets.filter((x) => x.file === sh.file).length > 1;
      // A workbook with several sheets gets its name once, in front of its tabs.
      if (many && prev?.file !== sh.file) {
        html += `<span class="sp-group" style="--tab-c:${colorOf(sh)}" title="${esc(sh.file)}"><i></i>${esc(sh.file)}<button type="button" class="sp-tab-x sp-group-x" data-close-file="${esc(sh.file)}" aria-label="Remove ${esc(sh.file)} and all its sheets" title="Remove this file">×</button></span>`;
      }
      const label = many || !sh.file || sh.file === sh.name ? sh.name : `${sh.name} · ${sh.file}`;
      html += `
      <div class="sp-tab ${i === SP.active ? 'active' : ''} ${sh.included ? '' : 'excluded'} ${many ? 'grouped' : ''}" style="--tab-c:${colorOf(sh)}" role="tab" aria-selected="${i === SP.active}" data-tab="${i}" title="${esc(sh.file && sh.file !== sh.name ? `${sh.name} in ${sh.file}` : sh.name)}">
        <input type="checkbox" data-include="${i}" ${sh.included ? 'checked' : ''} title="${sh.included ? 'Included in the send · click to leave out' : 'Left out of the send · click to include'}" />
        <span class="sp-tab-name">${esc(label)}</span>
        <span class="sp-tab-n">${(sh.counts?.rows || 0).toLocaleString()}</span>
        <button type="button" class="sp-tab-x" data-close="${i}" aria-label="Close ${esc(sh.name)}">×</button>
      </div>`;
    });
    $('#spTabs').innerHTML = html + `<label class="sp-tab-add" title="Open more files">${icon('plus', 15)}<input type="file" class="spFileInput" multiple hidden accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv" /></label><button type="button" class="sp-tab-add" data-from-contacts title="Add contacts by tag">${icon('users', 15)}</button>`;
  }

  $('#spTabs').addEventListener('click', async (e) => {
    const close = e.target.closest('[data-close]');
    if (close) return closeSheets([SP.sheets[Number(close.dataset.close)]]);
    const closeFile = e.target.closest('[data-close-file]');
    if (closeFile) return closeSheets(SP.sheets.filter((x) => x.file === closeFile.dataset.closeFile), closeFile.dataset.closeFile);
    const inc = e.target.closest('[data-include]');
    if (inc) {
      SP.sheets[Number(inc.dataset.include)].included = inc.checked;
      renderMapping();
      renderChrome();
      renderPreview();
      return;
    }
    const tab = e.target.closest('[data-tab]');
    if (tab && Number(tab.dataset.tab) !== SP.active) activate(Number(tab.dataset.tab));
  });
  document.addEventListener('change', (e) => {
    if (!e.target.classList.contains('spFileInput')) return;
    openFiles(e.target.files);
    e.target.value = '';
  });

  // Drop files anywhere on the page while it's open.
  const tab = $('#tab-send');
  tab.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); tab.classList.add('dropping'); } });
  tab.addEventListener('dragleave', (e) => { if (!tab.contains(e.relatedTarget)) tab.classList.remove('dropping'); });
  tab.addEventListener('drop', (e) => {
    tab.classList.remove('dropping');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    openFiles(e.dataTransfer.files);
  });

  // Pick contacts by tag (any of the chosen tags; none chosen = everyone). Opted-out people never appear.
  async function contactsPicker() {
    const { contacts, tags } = await api('/contacts');
    state.contactTags = tags;
    const ok = contacts.filter((c) => !c.optOut);
    if (!ok.length) return toast(contacts.length ? 'Everyone in Contacts has opted out' : 'No contacts yet. Add or import some on the Contacts page.', 'error');
    const picked = new Set();
    const body = openModal('Send to contacts', `
      <p class="sub ib-modal-sub">Choose tags; people with any of them are added as a sheet. Leave all off for everyone. Opted-out contacts are always left out.</p>
      <div class="ct-pick" id="pkTags">${tags.map((t) => `<button type="button" class="ct-tag tag-${esc(t.color)}" data-pick="${t.id}"><i></i>${esc(t.name)} <span>${ok.filter((c) => c.tags.includes(t.id)).length}</span></button>`).join('') || '<span class="sub">No tags yet: everyone will be added.</span>'}</div>
      <div class="modal-actions"><span class="ci-summary" id="pkCount"></span><button class="btn quiet" id="pkCancel">Cancel</button><button class="btn primary" id="pkGo">Add</button></div>`);
    const chosen = () => (picked.size ? ok.filter((c) => c.tags.some((t) => picked.has(t))) : ok);
    const update = () => {
      const n = chosen().length;
      $('#pkCount', body).textContent = `${n.toLocaleString()} contact${n === 1 ? '' : 's'}${picked.size ? '' : ' (everyone)'}`;
      $('#pkGo', body).disabled = !n;
      $('#pkGo', body).textContent = `Add ${n.toLocaleString()}`;
    };
    update();
    $('#pkTags', body).addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      picked.has(b.dataset.pick) ? picked.delete(b.dataset.pick) : picked.add(b.dataset.pick);
      b.classList.toggle('active');
      update();
    });
    $('#pkCancel', body).onclick = closeModal;
    $('#pkGo', body).onclick = () => {
      const names = tags.filter((t) => picked.has(t.id)).map((t) => t.name);
      closeModal();
      openContacts(chosen(), names.length ? `Contacts · ${names.join(', ')}` : 'All contacts');
    };
  }
  $('#spFromContacts').addEventListener('click', () => guard(contactsPicker));
  $('#spTabs').addEventListener('click', (e) => { if (e.target.closest('[data-from-contacts]')) guard(contactsPicker); });

  $('#spBlank').addEventListener('click', () => {
    const headers = ['phone', 'name'];
    SP.sheets.push(makeSheet({ name: `Sheet ${SP.sheets.length + 1}`, headers, rows: Array.from({ length: 40 }, () => ['', '']) }));
    activate(SP.sheets.length - 1);
    grid.select(0, 0);
    toast('Blank sheet ready · type, or paste from Excel or Google Sheets');
  });
  $('#spSample').addEventListener('click', () => {
    const names = ['Ravi', 'Priya', 'Amit', 'Sneha', 'Karan', 'Pooja', 'Arjun', 'Neha', 'Vikram', 'Anjali', 'Rohit', 'Kavya'];
    const cities = ['Pune', 'Delhi', 'Mumbai', 'Bengaluru', 'Hyderabad'];
    const rows = [];
    for (let k = 0; k < 120; k++) rows.push([String(9800000000 + k * 7919), `${names[k % names.length]} ${String.fromCharCode(65 + (k % 26))}.`, cities[k % 5], ['Gold', 'Silver', 'Free'][k % 3], String((k * 37) % 50)]);
    rows.push(['12345', 'Bad number', 'Pune', 'Free', '0']);
    rows.push([rows[0][0], 'Duplicate of row 1', 'Delhi', 'Gold', '3']);
    SP.sheets.push(makeSheet({ name: 'sample-contacts.csv', file: 'sample-contacts.csv', headers: ['phone', 'name', 'city', 'plan', 'orders'], rows }));
    activate(SP.sheets.length - 1);
  });

  // --- Toolbar -------------------------------------------------------------------------

  function renderPhoneSelect() {
    const sh = current();
    $('#spPhone').innerHTML = sh ? `${sh.phoneName ? '' : '<option value="">— choose —</option>'}${sh.headers.map((h) => `<option ${h === sh.phoneName ? 'selected' : ''}>${esc(h)}</option>`).join('')}` : '';
  }
  $('#spPhone').addEventListener('change', (e) => setPhone(e.target.value));
  $('#spUndo').addEventListener('click', () => { grid.undo(); grid.focus(); });
  $('#spRedo').addEventListener('click', () => { grid.redo(); grid.focus(); });
  $('#spAddRow').addEventListener('click', () => { grid.insertRowsAt('below'); grid.focus(); });
  $('#spAddCol').addEventListener('click', () => { grid.insertColumn(); grid.focus(); });
  // Delete: what's selected (cells, rows, columns), or the sheet / file itself.
  $('#spDelRows').addEventListener('click', (e) => {
    const sh = current(); if (!sh) return;
    const r = e.currentTarget.getBoundingClientRect();
    const rows = grid.selectedRows().length, cols = grid.selectedCols().length;
    // Whole rows selected (every column): deleting columns isn't what's meant, and the other way round.
    const wholeRows = cols === sh.headers.length && sh.headers.length > 1, wholeCols = rows === sh.view.length && rows > 1 && !wholeRows;
    const fileSheets = sh.file ? SP.sheets.filter((x) => x.file === sh.file) : [];
    Sheet.Menu.open(r.left, r.bottom + 6, [
      { label: 'Clear selected cells', kbd: '⌫', action: () => { grid.clearSelection(); grid.focus(); } },
      ...(wholeCols ? [] : [{ label: `Delete ${rows > 1 ? rows + ' rows' : 'row'}`, action: () => { grid.deleteSelectedRows(); grid.focus(); } }]),
      ...(wholeRows ? [] : [{ label: `Delete ${cols > 1 ? cols + ' columns' : 'column'}`, action: () => { grid.deleteColumns(); grid.focus(); } }]),
      '-',
      { label: `Remove sheet “${sh.name}”`, danger: true, action: () => closeSheets([sh]) },
      ...(fileSheets.length > 1 ? [{ label: `Remove file “${sh.file}” (${fileSheets.length} sheets)`, danger: true, action: () => closeSheets(fileSheets, sh.file) }] : []),
    ]);
  });
  $('#spExport').addEventListener('click', () => {
    const sh = current();
    if (!sh) return;
    const q = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
    const lines = [sh.headers.map(q).join(','), ...sh.rows.filter((r) => r.st !== 'empty').map((r) => r.cells.map((v) => q(String(v ?? ''))).join(','))];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }));
    a.download = `${sh.name.replace(/\.(csv|tsv|txt|xlsx?|xls)$/i, '')}${sh.dirty ? ' (edited)' : ''}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#spPanelBtn').addEventListener('click', () => {
    SP.panel = !SP.panel;
    try { localStorage.setItem('sendPanel', SP.panel ? '1' : '0'); } catch {}
    renderChrome();
  });

  // --- Find & replace --------------------------------------------------------------------

  function openFind() {
    $('#spFindBar').classList.remove('hidden');
    const q = $('#spFindQ');
    q.focus();
    q.select();
    updateFindCount();
    fitSend();
  }
  function closeFind() {
    $('#spFindBar').classList.add('hidden');
    fitSend();
    grid.focus();
  }
  function updateFindCount(res) {
    const q = $('#spFindQ').value;
    const n = q && current() ? grid.matchCount(q) : 0;
    $('#spFindN').textContent = !q ? '' : n ? (res && res.index >= 0 ? `${res.index + 1} of ${n}` : `${n} found`) : 'No matches';
  }
  $('#spFind').addEventListener('click', openFind);
  $('#spFindClose').addEventListener('click', closeFind);
  $('#spFindQ').addEventListener('input', () => updateFindCount());
  $('#spFindQ').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); updateFindCount(grid.findNext(e.target.value, e.shiftKey ? -1 : 1)); }
    if (e.key === 'Escape') closeFind();
  });
  $('#spRepQ').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFind(); });
  $('#spFindNext').addEventListener('click', () => updateFindCount(grid.findNext($('#spFindQ').value, 1)));
  $('#spFindPrev').addEventListener('click', () => updateFindCount(grid.findNext($('#spFindQ').value, -1)));
  $('#spRepOne').addEventListener('click', () => { const q = $('#spFindQ').value; if (q) updateFindCount(grid.replaceOne(q, $('#spRepQ').value)); });
  $('#spRepAll').addEventListener('click', () => {
    const q = $('#spFindQ').value;
    if (!q) return;
    const n = grid.replaceAll(q, $('#spRepQ').value);
    toast(n ? `Replaced ${n} cell${n > 1 ? 's' : ''}` : 'Nothing to replace');
    updateFindCount();
  });

  // --- Who gets the message ------------------------------------------------------------

  // Columns the message can use: every column in the ticked sheets, by name.
  function columns() {
    const out = [];
    for (const sh of SP.sheets) if (sh.included) for (const h of sh.headers) if (!out.includes(h)) out.push(h);
    return out;
  }

  // Ticked rows with a valid number from ticked tabs (and shown by filters), duplicates removed across sheets.
  function recipients() {
    const vars = currentTemplate()?.variables || [];
    const seen = new Set();
    const out = [];
    const skip = { invalid: 0, duplicate: 0, unticked: 0, filtered: 0, missing: {} };
    let sheets = 0;
    for (const sh of SP.sheets) {
      if (!sh.included) continue;
      sheets++;
      const shown = new Set(sh.matching || sh.rows); // column filters limit the send; the Show filter doesn't
      for (const row of sh.rows) {
        if (row.st === 'empty') continue;
        if (!shown.has(row)) { skip.filtered++; continue; }
        if (row.st === 'invalid') { skip.invalid++; continue; }
        if (!row.on) { skip.unticked++; continue; }
        if (seen.has(row.phone)) { skip.duplicate++; continue; }
        const obj = {};
        sh.headers.forEach((h, i) => { obj[h] = String(row.cells[i] ?? '').trim(); });
        const miss = vars.find((v) => SP.mapping[v.key]?.type === 'column' && !obj[SP.mapping[v.key].value]);
        if (miss) { skip.missing[miss.key] = (skip.missing[miss.key] || 0) + 1; continue; }
        seen.add(row.phone);
        out.push({ sheet: sh, row, obj: { ...obj, __phone: row.phone } });
      }
    }
    return { list: out, skip, sheets };
  }

  // --- Message panel ---------------------------------------------------------------------

  const currentTemplate = () => state.templates.find((t) => t.id === $('#templateSelect').value);

  function renderTemplateSelect() {
    const sel = $('#templateSelect');
    const prev = sel.value;
    sel.innerHTML = state.templates.length
      ? `<option value="">— Choose a template —</option>` + state.templates.map((t) => `<option value="${t.id}">${esc(t.name)} · ${esc(t.language)}${t.status && t.status !== 'APPROVED' ? ` (${esc(t.status.toLowerCase())})` : ''}</option>`).join('')
      : `<option value="">No templates yet — add one under Templates</option>`;
    if (state.templates.some((t) => t.id === prev)) sel.value = prev;
    onTemplateChange();
  }
  $('#templateSelect').addEventListener('change', onTemplateChange);

  function autoMap(v) {
    const match = columns().find((h) => h.toLowerCase() === String(v.name).toLowerCase());
    return match ? { type: 'column', value: match } : { type: 'fixed', value: '' };
  }

  function onTemplateChange() {
    const t = currentTemplate();
    const next = {};
    for (const v of t?.variables || []) next[v.key] = SP.mapping[v.key] || autoMap(v);
    SP.mapping = next;
    renderMapping();
    renderPreview();
    renderSummary();
    renderTplPreview();
  }

  function renderSenderChecks() {
    const enabled = state.senders.filter((s) => s.enabled);
    $('#sendFromHint').textContent = enabled.length > 1 ? 'split evenly across the numbers you turn on' : enabled.length ? 'every message goes from this number' : '';
    $('#senderChecks').innerHTML = enabled.length
      ? enabled.map((s) => `<label class="toggle-item"><span><span class="ti-name">${esc(s.label)}</span><br/><span class="ti-meta">${esc(s.displayPhone || 'ID ' + s.phoneNumberId)}</span></span>${toggleHtml({ checked: state.selectedSenders.has(s.id), attrs: `value="${s.id}"`, size: 'sm' })}</label>`).join('')
      : `<div class="empty-note">No numbers yet. <a href="#" data-goto="numbers">Add one</a> to start sending.</div>`;
    renderSummary();
  }
  $('#senderChecks').addEventListener('change', (e) => {
    if (e.target.checked) state.selectedSenders.add(e.target.value);
    else state.selectedSenders.delete(e.target.value);
    renderSummary();
  });

  // The variable you're editing lights up in the preview, and its field lights up too.
  function flashVar(key) {
    $$('#preview [data-var]').forEach((s) => s.classList.toggle('focus', s.dataset.var === key));
    $$('#mapping .sp-map').forEach((r) => r.classList.toggle('focus', r.dataset.key === key));
  }
  $('#mapping').addEventListener('focusin', (e) => { const r = e.target.closest('.sp-map'); if (r) flashVar(r.dataset.key); });
  $('#mapping').addEventListener('focusout', () => setTimeout(() => { if (!$('#mapping').contains(document.activeElement)) flashVar(null); }, 0));

  function renderMapping() {
    const t = currentTemplate();
    const el = $('#mapping');
    if (!t) { el.innerHTML = '<p class="sub">Pick a template to see what you can personalise.</p>'; return; }
    if (!t.variables.length) { el.innerHTML = '<p class="sub">This template has no variables: everyone gets the same message.</p>'; return; }
    const cols = columns();
    // A column that went away (renamed, deleted, or its sheet unticked) can't be used any more.
    for (const v of t.variables) if (SP.mapping[v.key]?.type === 'column' && !cols.includes(SP.mapping[v.key].value)) SP.mapping[v.key] = autoMap(v);
    el.innerHTML = t.variables.map((v) => {
      const m = SP.mapping[v.key];
      const fixed = m.type !== 'column';
      const where = v.media ? 'header' : v.where.startsWith('button') ? 'button link' : v.where;
      return `<div class="sp-map" data-key="${esc(v.key)}">
        <div class="var-key">${esc(v.media ? v.media + ' URL' : `{{${v.name}}}`)}<small>${esc(where)}</small></div>
        <select class="m-src" aria-label="Value for ${esc(varLabel(v))}">
          ${cols.length ? `<optgroup label="Column">${cols.map((c) => `<option value="c:${esc(c)}" ${!fixed && c === m.value ? 'selected' : ''}>${esc(c)}</option>`).join('')}</optgroup>` : ''}
          <option value="fixed" ${fixed ? 'selected' : ''}>Same text for everyone…</option>
        </select>
        ${fixed ? `<input class="m-val" value="${esc(m.value)}" placeholder="${v.media ? 'https://…/image.jpg' : 'Type the text'}" aria-label="Text for ${esc(varLabel(v))}" />` : ''}
      </div>`;
    }).join('');
  }
  $('#mapping').addEventListener('input', (e) => {
    const row = e.target.closest('.sp-map');
    if (!row) return;
    const key = row.dataset.key;
    if (e.target.classList.contains('m-src')) {
      const v = e.target.value;
      SP.mapping[key] = v === 'fixed' ? { type: 'fixed', value: '' } : { type: 'column', value: v.slice(2) };
      renderMapping();
      if (v === 'fixed') $(`.sp-map[data-key="${CSS.escape(key)}"] .m-val`)?.focus();
    } else SP.mapping[key].value = e.target.value;
    renderPreview();
    flashVar(key);
    renderSummary();
  });

  const valuesFor = (obj) => {
    const out = {};
    for (const v of currentTemplate()?.variables || []) {
      const m = SP.mapping[v.key] || {};
      out[v.key] = m.type === 'column' ? obj?.[m.value] ?? '' : m.value || '';
    }
    return out;
  };

  // Preview the row the cursor is on when it's a recipient, otherwise the first recipient.
  // The ‹ › stepper picks a recipient directly; clicking a row in the grid goes back to "follow the cursor".
  function previewTarget() {
    const { list } = recipients();
    if (SP.previewAt != null && list.length) return list[Math.min(SP.previewAt, list.length - 1)];
    if (!current()) return list[0] || null; // no sheet open: the grid has no cursor to ask about
    const active = grid.activeRow();
    return list.find((x) => x.row === active) || list[0] || null;
  }

  // Setup shows the chosen template as written ({{1}} slots and all), then a button to the next step.
  function renderTplPreview() {
    const t = currentTemplate();
    $('#spTplSec').classList.toggle('hidden', !t);
    if (!t) return;
    $('#spTplPreview').innerHTML = bubbleHtml(t, {}, true);
    $('#spTplMeta').textContent = `${t.category ? t.category.toLowerCase() + ' · ' : ''}${t.variables.length ? `${t.variables.length} variable${t.variables.length > 1 ? 's' : ''} to fill in` : 'no variables'}`;
    $('#spNext').textContent = t.variables.length ? 'Next: Personalise →' : 'Preview →';
  }

  // Compose / Preview tabs in the message panel.
  function setPane(name) {
    SP.pane = name;
    $$('#spPaneSeg button').forEach((b) => { b.classList.toggle('active', b.dataset.pane === name); b.setAttribute('aria-selected', String(b.dataset.pane === name)); });
    $$('#spPanel .sp-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
    // Personalise widens the panel so the preview and the fields sit side by side.
    $('#tab-send').classList.toggle('pane-wide', name === 'preview');
    if (name === 'preview') renderPreview();
  }
  $('#spPaneSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-pane]'); if (b) setPane(b.dataset.pane); });
  $('#spPanel').addEventListener('click', (e) => {
    // Click a {{variable}} in the preview to jump to its field.
    const pv = e.target.closest('#preview [data-var]');
    if (pv) {
      const row = $(`.sp-map[data-key="${CSS.escape(pv.dataset.var)}"]`);
      if (row) { ($('.m-val', row) || $('.m-src', row)).focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); flashVar(pv.dataset.var); }
      return;
    }
    if (e.target.closest('[data-goto-pane]')) return setPane(e.target.closest('[data-goto-pane]').dataset.gotoPane);
    const st = e.target.closest('[data-step]');
    if (!st) return;
    const { list } = recipients();
    if (!list.length) return;
    const t = previewTarget();
    const cur = list.findIndex((x) => x.row === t?.row);
    SP.previewAt = (Math.max(0, cur) + Number(st.dataset.step) + list.length) % list.length;
    renderPreview();
  });

  function renderPreview() {
    const t = currentTemplate();
    const el = $('#preview');
    renderTplPreview();
    if (!t) { el.innerHTML = '<span class="muted">Pick a template in Setup to see the message here.</span>'; $('#previewNote').textContent = ''; $('#spStepper').classList.add('hidden'); return; }
    const target = previewTarget();
    el.innerHTML = bubbleHtml(t, valuesFor(target?.obj));
    const { list } = recipients();
    $('#spStepper').classList.toggle('hidden', list.length < 2);
    $('#spStepN').textContent = target ? `${list.findIndex((x) => x.row === target.row) + 1} / ${list.length.toLocaleString()}` : '';
    $('#previewNote').textContent = target
      ? `Row ${target.sheet.rows.indexOf(target.row) + 1}${SP.sheets.length > 1 ? ` of ${target.sheet.name}` : ''} · +${target.row.phone}. Click a row to preview it.`
      : 'No contacts open: variables show as they will be filled in. You can still send a test.';
  }

  // --- Chrome: toolbar state, tabs, summary ----------------------------------------------

  function renderChrome() {
    Draft.save();
    const sh = current();
    const has = Boolean(sh);
    $('#spEmpty').classList.toggle('hidden', has);
    $('#spGrid').classList.toggle('hidden', !has);
    $('#spTabs').classList.toggle('hidden', !has);
    $('#spStrip').classList.toggle('hidden', !has);
    // With no data the sheet tools hide, but the Message panel button stays.
    $('#spTools').classList.toggle('no-data', !has);
    $('#tab-send').classList.toggle('panel-off', !SP.panel);
    $('#spPanelBtn').setAttribute('aria-pressed', String(SP.panel));
    $('#spTitle').textContent = has ? sh.name : 'Send a campaign';
    if (has) {
      const c = sh.counts;
      const filtered = Object.keys(sh.filters).length;
      $('#spMeta').innerHTML = `${sh.file && sh.file !== sh.name ? `<span class="sp-file-dot" style="--tab-c:${colorOf(sh)}"></span>${esc(sh.file)} · ` : ''}${c.rows.toLocaleString()} rows · ${sh.headers.length} columns`;
      renderStrip(sh, filtered);
      $('#spUndo').disabled = !grid.canUndo();
      $('#spRedo').disabled = !grid.canRedo();
    } else $('#spMeta').textContent = 'Open a contact list to start';
    renderTabs();
    renderSummary();
  }

  // --- Shifted rows (detection and the fix live in app.js, shared with Contacts import) ----

  function findShifted(sh) {
    const groups = detectShiftedRows(sh.headers, sh.rows.map((r) => r.cells), sh.headers.indexOf(sh.phoneName));
    return groups.map((g) => ({ ...g, rows: g.idx.map((i) => sh.rows[i]) }));
  }

  // Move shifted rows back under the right headers, as one undo step.
  function fixShifted(sh, groups) {
    const saved = { headers: sh.headers.slice(), widths: sh.widths.slice(), cells: sh.rows.map((r) => r.cells.slice()), phone: sh.phoneName };
    const fixed = realignShiftedRows(saved.headers, saved.cells, groups);
    const widthOf = new Map(saved.headers.map((h, i) => [h, saved.widths[i]]));
    grid.apply({
      kind: 'cols',
      do() {
        sh.headers = fixed.headers.slice();
        sh.widths = fixed.headers.map((h) => widthOf.get(h) ?? 160);
        sh.rows.forEach((r, i) => { r.cells = fixed.rows[i].slice(); });
      },
      undo() {
        sh.headers = saved.headers.slice();
        sh.widths = saved.widths.slice();
        sh.rows.forEach((r, i) => { r.cells = saved.cells[i].slice(); });
        sh.phoneName = saved.phone;
      },
    });
  }

  function shiftHint(sh) {
    const groups = findShifted(sh);
    const n = groups.reduce((a, g) => a + g.rows.length, 0);
    if (!n) return '';
    const k = groups.length === 1 ? groups[0].k : null;
    return `<button type="button" class="link sp-phone-hint" data-fix-shift>${n} row${n > 1 ? 's look' : ' looks'} shifted: the number is ${k ? `${k} column${k > 1 ? 's' : ''}` : 'a few columns'} to the right. Fix ${n > 1 ? 'them' : 'it'}</button>`;
  }

  // When most numbers in the chosen column fail but another column is full of numbers, offer it.
  function phoneHint(sh) {
    if (!sh.counts.rows || sh.counts.valid / sh.counts.rows >= 0.3) return '';
    const better = guessPhoneColumn(sh.headers, sh.rows, (r, i) => r.cells[i]);
    return better && better !== sh.phoneName ? `<button type="button" class="link sp-phone-hint" data-use-phone="${esc(better)}">Numbers look like they're in “${esc(better)}”. Use it?</button>` : '';
  }
  function renderStrip(sh, filtered) {
    const off = sh.rows.filter(SHOW.off.test).length;
    const n = { all: sh.counts.rows, valid: sh.counts.valid, invalid: sh.counts.invalid, duplicate: sh.counts.duplicate, off };
    const cur = sh.show || 'all';
    const shown = sh.view.filter((r) => r.st !== 'empty').length;
    $('#spStrip').innerHTML = `
      <div class="seg sp-show" role="radiogroup" aria-label="Show rows">${Object.entries(SHOW).map(([k, v]) =>
        k !== 'all' && k !== 'valid' && !n[k] && cur !== k ? '' : `<button type="button" data-show="${k}" class="${cur === k ? 'active' : ''} st-${k}" role="radio" aria-checked="${cur === k}">${v.label} <span class="n">${n[k].toLocaleString()}</span></button>`).join('')}</div>
      ${filtered ? `<span class="sp-filtered">${shown.toLocaleString()} of ${sh.counts.rows.toLocaleString()} rows match the column filters · <button type="button" class="link" data-clear-filters>Clear</button></span>` : ''}
      ${!sh.phoneName ? '<span class="sp-alert">Choose the phone column in the toolbar</span>' : ''}
      ${phoneHint(sh)}${shiftHint(sh)}`;
    Motion.segs($('#spStrip'));
  }

  $('#spStrip').addEventListener('click', (e) => {
    const show = e.target.closest('[data-show]');
    if (show) {
      current().show = show.dataset.show;
      grid.refilter();
      renderChrome();
      return;
    }
    if (e.target.closest('[data-clear-filters]')) return grid.clearFilters();
    const b = e.target.closest('[data-use-phone]');
    if (b) { setPhone(b.dataset.usePhone); toast(`Phone column set to “${b.dataset.usePhone}”`); }
    if (e.target.closest('[data-fix-shift]')) {
      const sh = current(), groups = findShifted(sh);
      const n = groups.reduce((a, g) => a + g.rows.length, 0);
      fixShifted(sh, groups);
      toast(`Moved ${n} row${n > 1 ? 's' : ''} back under the right columns · ⌘Z to undo`);
    }
  });

  function renderSummary() {
    Draft.save();
    const { list, skip, sheets } = recipients();
    const count = list.length;
    const nums = state.selectedSenders.size;
    const t = currentTemplate();
    const emptyFixed = t?.variables.find((v) => { const m = SP.mapping[v.key]; return !m || (m.type !== 'column' && !String(m.value).trim()); });
    const missing = Object.entries(skip.missing);
    const missLabel = (key) => { const v = t?.variables.find((x) => x.key === key); return v ? (v.media ? v.media + ' URL' : `{{${v.name}}}`) : key; };

    const why =
      !SP.sheets.length ? 'Open a contact list' :
      !sheets ? 'Tick at least one sheet tab to send to' :
      !count && !missing.length ? 'No rows to send: tick rows that have a valid number' :
      !t ? 'Choose a template in the Message panel' :
      !nums ? 'Turn on at least one sender number' :
      emptyFixed ? `Fill in ${missLabel(emptyFixed.key)} in the Message panel` :
      !count ? `Every row is missing a value for ${missLabel(missing[0][0])}` : '';

    const notes = [
      sheets > 1 ? `from ${sheets} sheets` : '',
      skip.invalid ? `${skip.invalid.toLocaleString()} invalid` : '',
      skip.duplicate ? `${skip.duplicate.toLocaleString()} duplicate${skip.duplicate > 1 ? 's' : ''} skipped` : '',
      skip.unticked ? `${skip.unticked.toLocaleString()} left out` : '',
      skip.filtered ? `${skip.filtered.toLocaleString()} hidden by filters` : '',
      ...missing.map(([k, n]) => `${n.toLocaleString()} with no ${missLabel(k)}`),
    ].filter(Boolean).join(' · ');
    const detail = [nums ? `${nums} number${nums === 1 ? '' : 's'} · ~${Math.ceil(count / Math.max(1, nums)).toLocaleString()} each` : '', t ? `template ${esc(t.name)}` : ''].filter(Boolean).join(' · ');

    $('#sendSummary').innerHTML = `<strong>${count.toLocaleString()} recipient${count === 1 ? '' : 's'}</strong>${notes ? ` <span class="sp-notes">${esc(notes)}</span>` : ''}
      <div>${why ? `<span class="why">${esc(why)}</span>` : detail}</div>`;
    const scheduled = state.sendMode === 'schedule';
    $('#sendAll').innerHTML = `${icon(scheduled ? 'clock' : 'send', 17)}${scheduled ? 'Schedule' : 'Send'}${count ? ' ' + count.toLocaleString() : ''} message${count === 1 ? '' : 's'}`;
    $('#sendAll').disabled = Boolean(why);
  }

  // --- Send, test, schedule ---------------------------------------------------------------

  function defaultScheduleTime() {
    const d = new Date(Date.now() + 30 * 60 * 1000);
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    return toLocalInput(d);
  }
  const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  $('#sendMode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    state.sendMode = b.dataset.mode;
    $$('#sendMode button').forEach((x) => x.classList.toggle('active', x === b));
    const input = $('#scheduleAt');
    input.classList.toggle('hidden', state.sendMode !== 'schedule');
    if (state.sendMode === 'schedule') {
      input.min = toLocalInput(new Date());
      if (!input.value) input.value = defaultScheduleTime();
    }
    renderSummary();
  });

  // Send test: a small pop-up from the bottom bar, available at any step.
  try { $('#testPhone').value = localStorage.getItem('testPhone') || ''; } catch {}
  const closeTest = () => { $('#testPop').classList.add('hidden'); $('#testOpen').setAttribute('aria-expanded', 'false'); };
  $('#testOpen').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $('#testPop').classList.toggle('hidden') === false;
    $('#testOpen').setAttribute('aria-expanded', String(open));
    if (open) {
      const t = currentTemplate();
      $('#testNote').textContent = t ? `Sends “${t.name}” with the values of the recipient in the preview, from the first number you turned on.` : 'Choose a template first (Setup).';
      $('#testPhone').focus();
    }
  });
  // The same pop-up, opened from under the preview.
  $('#spPrevTest').addEventListener('click', (e) => { e.stopPropagation(); if ($('#testPop').classList.contains('hidden')) $('#testOpen').click(); else $('#testPhone').focus(); });
  $('#testPhone').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#testSend').click(); if (e.key === 'Escape') closeTest(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.sp-testwrap')) closeTest(); });

  $('#testSend').addEventListener('click', (e) =>
    guard(async () => {
      const t = currentTemplate();
      const senderId = [...state.selectedSenders][0];
      if (!t) throw new Error('Choose a template first');
      if (!senderId) throw new Error('Turn on a sender number first');
      // A quick test shouldn't need every variable filled in: empty ones go out as "test".
      const values = valuesFor(previewTarget()?.obj);
      const empty = t.variables.filter((v) => !values[v.key]);
      if (empty.some((v) => v.media)) throw new Error('Fill in the header media URL first (Personalise)');
      for (const v of empty) values[v.key] = 'test';
      const phone = $('#testPhone').value;
      if (phoneError(phone)) { $('#testPhone').focus(); throw new Error(phoneError(phone)); }
      try { localStorage.setItem('testPhone', phone); } catch {}
      const r = await api('/send/test', { method: 'POST', body: { senderId, templateId: t.id, phone, values } });
      toast(`${r.demo ? '(Demo) ' : ''}Test sent to +${r.to}${empty.length ? ` · ${empty.length} empty variable${empty.length > 1 ? 's' : ''} sent as “test”` : ''}`);
      closeTest();
    }, e.target)
  );

  $('#sendAll').addEventListener('click', (e) =>
    guard(async () => {
      const t = currentTemplate();
      const { list, sheets } = recipients();
      const nums = state.selectedSenders.size;
      let scheduledAt = null;
      if (state.sendMode === 'schedule') {
        const when = new Date($('#scheduleAt').value);
        if (isNaN(when)) throw new Error('Pick a date and time to schedule');
        if (when < Date.now()) throw new Error('That time is in the past');
        scheduledAt = when.toISOString();
      }
      const demo = state.settings.demoMode;
      const ok = await confirmDialog({
        title: scheduledAt ? `Schedule ${list.length.toLocaleString()} messages?` : `Send ${list.length.toLocaleString()} messages now?`,
        message: `Template <strong>${esc(t.name)}</strong> from ${nums} number${nums === 1 ? '' : 's'}${sheets > 1 ? `, to rows from ${sheets} sheets` : ''}${scheduledAt ? `, on <strong>${esc(new Date(scheduledAt).toLocaleString())}</strong>` : ''}.<br><br>${demo ? 'Demo mode: sending is simulated.' : '<strong>Live:</strong> real WhatsApp messages will be sent.'}`,
        confirmText: scheduledAt ? 'Schedule' : 'Send now',
        check: demo ? '' : 'These people agreed to get WhatsApp messages from my business, and can reply STOP to opt out.',
      });
      if (!ok) return;
      const c = await api('/campaigns', {
        method: 'POST',
        body: { name: $('#campaignName').value.trim(), templateId: t.id, senderIds: [...state.selectedSenders], rows: list.map((x) => x.obj), phoneColumn: '__phone', mapping: SP.mapping, scheduledAt, consent: true },
      });
      toast(scheduledAt ? `Scheduled ${c.total} messages for ${new Date(scheduledAt).toLocaleString()}` : `Campaign started — ${c.total} messages queued`);
      $('#campaignName').value = '';
      showTab('campaigns');
      openCampaign(c.id);
    }, e.target)
  );

  // --- Page size ----------------------------------------------------------------------------

  // On wide screens the page fills the window: the grid scrolls, the page doesn't.
  function fitSend() {
    const t = $('#tab-send');
    if (t.classList.contains('hidden')) return;
    if (innerWidth <= 900) { t.style.height = ''; return; }
    t.style.height = Math.max(480, innerHeight - (t.getBoundingClientRect().top + scrollY) - 12) + 'px';
    grid.redraw();
  }
  addEventListener('resize', fitSend);

  // --- Used by app.js ------------------------------------------------------------------------

  Object.assign(window, { currentTemplate, renderTemplateSelect, onTemplateChange, renderSenderChecks, renderSendSummary: renderSummary });
  // Open contacts (from the Contacts page or a tag) as a sheet tab, ready to send to.
  function openContacts(list, label) {
    const extras = [...new Set(list.flatMap((c) => Object.keys(c.extra || {})))];
    const tagName = (t) => state.contactTags?.find((x) => x.id === t)?.name || '';
    const headers = ['phone', 'name', 'email', 'company', 'tags', 'status', ...extras];
    const rows = list.map((c) => ['+' + c.phone, c.name, c.email, c.company, c.tags.map(tagName).filter(Boolean).join(', '), c.status, ...extras.map((k) => c.extra?.[k] ?? '')]);
    SP.sheets.push(makeSheet({ name: label, file: '', headers, rows }));
    showTab('send');
    activate(SP.sheets.length - 1);
    toast(`Opened ${list.length.toLocaleString()} contact${list.length === 1 ? '' : 's'} · opted-out people are left out`);
  }

  // Follow-ups from a campaign: these recipients, the same template, and each person's values as columns.
  function openRecipients(list, { label, templateId }) {
    const t = state.templates.find((x) => x.id === templateId);
    const vars = t?.variables || [];
    const headers = ['phone', 'name', ...vars.map(varLabel)];
    const rows = list.map((r) => ['+' + r.phone, r.name || '', ...vars.map((v) => r.values?.[v.key] ?? '')]);
    SP.sheets.push(makeSheet({ name: label, file: '', headers, rows }));
    showTab('send');
    activate(SP.sheets.length - 1);
    if (t) {
      SP.mapping = Object.fromEntries(vars.map((v) => [v.key, { type: 'column', value: varLabel(v) }]));
      $('#templateSelect').value = t.id;
      onTemplateChange();
    }
    toast(`${list.length.toLocaleString()} recipient${list.length === 1 ? '' : 's'} ready${t ? ` with ${t.name}` : ''}. Check, then send.`);
  }

  // --- Draft: the page's work survives switching tabs and reloading ------------------------------
  // Kept in this browser (IndexedDB), one draft per workspace: sheets with their edits, the phone
  // column, ticks, template, variables, numbers, campaign name and schedule. Saved shortly after
  // each change; restored once at start-up. Logging out clears it.
  const Draft = (() => {
    const DB = 'ws-drafts', STORE = 'send';
    let timer = 0, restoring = false, ready = false;
    const open = () => new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(STORE, mode); const out = fn(t.objectStore(STORE)); t.oncomplete = () => res(out?.result); t.onerror = () => rej(t.error); }); };
    const key = () => 'ws:' + (state.me?.workspace?.id || 'default');
    // Only what's needed to rebuild; checks (st/phone) and views are worked out again.
    const pack = () => ({
      v: 1, savedAt: Date.now(), active: SP.active, mapping: SP.mapping,
      sheets: SP.sheets.map((sh) => ({
        name: sh.name, file: sh.file, headers: sh.headers, widths: sh.widths, phoneName: sh.phoneName, included: sh.included, dirty: sh.dirty,
        rows: sh.rows.map((r) => [r.cells, r.on ? 1 : 0]),
        filters: Object.fromEntries(Object.entries(sh.filters || {}).map(([c, x]) => [c, { text: x.text || '', values: x.values ? [...x.values] : null }])),
      })),
      templateId: $('#templateSelect').value, senders: [...state.selectedSenders], name: $('#campaignName').value,
      mode: state.sendMode, at: $('#scheduleAt').value,
    });
    function save() {
      if (!ready || restoring) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const data = pack();
        const empty = !data.sheets.length && !data.templateId && !data.name;
        tx('readwrite', (st) => (empty ? st.delete(key()) : st.put(data, key()))).catch(() => {});
      }, 500);
    }
    async function restore() {
      let d = null;
      try { d = await tx('readonly', (st) => st.get(key())); } catch { /* private window etc.: start fresh */ }
      ready = true;
      if (!d || d.v !== 1) return false;
      restoring = true;
      try {
        SP.sheets = d.sheets.map((x) => {
          const sh = { id: nextId++, name: x.name, file: x.file, headers: x.headers, widths: x.widths, phoneName: x.phoneName, included: x.included, dirty: x.dirty,
            rows: x.rows.map(([cells, on]) => ({ cells, on: Boolean(on) })),
            filters: Object.fromEntries(Object.entries(x.filters || {}).map(([c, f]) => [c, { text: f.text, ...(f.values ? { values: new Set(f.values) } : {}) }])) };
          recheck(sh);
          return sh;
        });
        SP.mapping = d.mapping || {};
        if (state.templates.some((t) => t.id === d.templateId)) $('#templateSelect').value = d.templateId;
        const ids = new Set(state.senders.filter((x) => x.enabled).map((x) => x.id));
        const keep = (d.senders || []).filter((id) => ids.has(id));
        if (keep.length) state.selectedSenders = new Set(keep);
        $('#campaignName').value = d.name || '';
        if (d.mode === 'schedule' && d.at && new Date(d.at) > Date.now()) { $('#scheduleAt').value = d.at; $('#sendMode [data-mode=schedule]')?.click(); }
        renderSenderChecks();
        activate(Math.min(Math.max(0, d.active), SP.sheets.length - 1));
      } finally { restoring = false; }
      return SP.sheets.length > 0;
    }
    const clear = () => tx('readwrite', (st) => st.clear()).catch(() => {});
    return { save, restore, clear };
  })();
  $('#campaignName').addEventListener('input', () => Draft.save());
  $('#scheduleAt').addEventListener('change', () => Draft.save());
  // Logging out: don't leave anyone's contact lists in this browser.
  document.addEventListener('click', (e) => { if (e.target.closest('a[href="/logout"]')) Draft.clear(); }, true);

  window.SendPage = {
    restoreDraft: () => Draft.restore(),
    readWorkbook,
    toTable,
    openContacts,
    openRecipients,
    show() { fitSend(); renderChrome(); if (current()) grid.focus(); },
    // The default country code changes which numbers are valid.
    recheck() { SP.sheets.forEach(recheck); if (current()) grid.redraw(); renderChrome(); },
  };
  renderChrome();
})();
