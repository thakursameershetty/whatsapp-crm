// Send page: contact lists in a spreadsheet, the message set up in a side panel,
// and one bar to send. Several files, and every sheet of an Excel workbook, open
// as tabs at the bottom; ticked tabs are combined into one recipient list with
// duplicate numbers removed. Edits change what gets sent, never the original file.

(function () {
  const SP = {
    sheets: [], // { id, name, file, headers, rows: [{ cells, on, st, phone }], widths, filters, phoneName, included, dirty }
    active: -1,
    mapping: {}, // variable key -> { type: 'column' | 'fixed', value }
    campaign: null, // the draft campaign this page is setting up ({ id, name, templateId, ai }); made with New campaign
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
      // A cell can hold several numbers: the first is suggested, and the tag on the cell lets you pick others.
      row.phones = col >= 0 ? phoneCandidates(row.cells[col]) : [];
      const picked = (row.pick || []).filter((p) => row.phones.includes(p));
      row.send = picked.length ? picked : row.phones.slice(0, 1);
      row.phone = row.send[0] || null;
      row.st = !row.phone ? 'invalid' : row.send.every((p) => seen.has(p)) ? 'duplicate' : (row.send.forEach((p) => seen.add(p)), 'valid');
      counts[row.st]++;
      if (row.phones.length > 1) counts.multi = (counts.multi || 0) + 1;
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
    multi: { label: 'Several numbers', test: (r) => (r.phones?.length || 0) > 1 },
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
      const multi = row.phones.length > 1
        ? { badge: `<button type="button" class="sp-multi ${row.pick?.length ? 'chosen' : ''}" tabindex="-1" title="${row.phones.length} numbers in this cell · click to choose">${row.send.length > 1 ? `${row.send.length} of ${row.phones.length}` : `${row.phones.length} numbers`}</button>` }
        : {};
      const sending = row.send.map((p) => '+' + p).join(' and ');
      if (row.st === 'duplicate') return { cls: `ph dup${multi.badge ? ' multi' : ''}`, title: `${sending} appears earlier in this sheet; it's sent once`, ...multi };
      return { cls: `ph${multi.badge ? ' multi' : ''}`, title: row.phones.length > 1 ? `Sending to ${sending}${row.pick?.length ? '' : ' (the first number, suggested)'}` : `+${row.phone}`, ...multi };
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
      autoPhone(sh);
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
      Object.assign(sh, { headers: t.headers, rows: t.rows.map((cells) => ({ cells, on: true })), widths: autoWidths(t.headers, t.rows), wraps: [], filters: {}, phoneName: guessPhone(t.headers, t.rows) });
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
      const withPhone = rows.filter((r) => r.phone);
      return ['-', { label: can.every((r) => r.on) ? 'Leave out of the send' : 'Include in the send', action: () => { const on = !can.every((r) => r.on); can.forEach((r) => (r.on = on)); grid.redraw(); renderChrome(); } },
        ...(withPhone.length ? [{ label: `Save ${withPhone.length === 1 ? 'as a contact' : withPhone.length.toLocaleString() + ' as contacts'}`, action: () => saveContacts(withPhone) }] : [])];
    },
    find: () => openFind(),
    notify: (m) => toast(m),
  });
  const otherHas = (sh, name) => SP.sheets.some((x) => x !== sh && x.included && x.headers.includes(name));

  // The phone column follows the data until someone picks it: as numbers are typed or pasted into a column, that
  // column becomes the phone column (the picker flashes and says so). No column that looks like numbers yet, with data
  // in the sheet: the picker asks for one. Picking it yourself (the picker, or a column's menu) ends the guessing.
  function autoPhone(sh) {
    if (sh.phonePicked) return;
    const rows = sh.rows.map((r) => r.cells);
    const g = guessPhone(sh.headers, rows);
    const hasData = rows.some((r) => r.some((v) => String(v ?? '').trim()));
    if (g && g !== sh.phoneName) {
      sh.phoneName = g;
      recheck(sh);
      renderPhoneSelect();
      grid.redraw();
      const pick = $('#spPhone').closest('.sp-phone');
      pick.classList.remove('flash'); void pick.offsetWidth; pick.classList.add('flash');
      toast(`Phone numbers found in “${g}”: sending to that column`);
    }
    $('#spPhone').closest('.sp-phone').classList.toggle('needs', hasData && !sh.phoneName);
  }

  function setPhone(name) {
    const sh = current();
    sh.phonePicked = Boolean(name);
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
    $('#spTabs').innerHTML = html + `<button type="button" class="sp-tab-add" data-tab-add aria-haspopup="menu" title="Add a sheet: blank, or from a file">${icon('plus', 15)}</button><input type="file" class="spFileInput" id="spTabFile" multiple hidden accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv" /><button type="button" class="sp-tab-add" data-from-contacts title="Add contacts by tag">${icon('users', 15)}</button>`;
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
  $('#spTabs').addEventListener('click', (e) => {
    if (e.target.closest('[data-from-contacts]')) return guard(contactsPicker);
    // +: a blank sheet, or open a file (CSV / Excel)
    const add = e.target.closest('[data-tab-add]');
    if (add) {
      const r = add.getBoundingClientRect();
      Sheet.Menu.open(r.left, r.top - 8, [
        { label: 'Blank sheet', action: () => $('#spBlank').click() },
        { label: 'Upload a file…', action: () => $('#spTabFile').click() },
      ]);
    }
  });

  $('#spBlank').addEventListener('click', () => {
    const headers = ['phone', 'name'];
    const sh = makeSheet({ name: `Sheet ${SP.sheets.length + 1}`, headers, rows: Array.from({ length: 40 }, () => ['', '']) });
    sh.phoneName = 'phone'; // by its title until there's data (then it follows the numbers: autoPhone)
    SP.sheets.push(sh);
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
    const pick = $('#spPhone').closest('.sp-phone');
    pick.classList.toggle('needs', Boolean(sh && !sh.phoneName && sh.rows.some((r) => r.st !== 'empty')));
    pick.title = pick.classList.contains('needs') ? 'Choose the column with the WhatsApp numbers' : 'The column with the WhatsApp numbers';
  }
  $('#spPhone').addEventListener('change', (e) => setPhone(e.target.value));
  $('#spUndo').addEventListener('click', () => { grid.undo(); grid.focus(); });
  $('#spRedo').addEventListener('click', () => { grid.redo(); grid.focus(); });
  // + Row / + Column: where to insert, next to the selection (as many as are selected).
  $('#spAddRow').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect(), { rows: n, hasRows } = grid.selectionSize();
    if (!hasRows) { grid.insertRowsAt('below'); return grid.focus(); } // an empty sheet: just add one
    const what = n > 1 ? `${n} rows` : 'row';
    Sheet.Menu.open(r.left, r.bottom + 6, [
      { label: `Insert ${what} above`, action: () => { grid.insertRowsAt('above'); grid.focus(); } },
      { label: `Insert ${what} below`, action: () => { grid.insertRowsAt('below'); grid.focus(); } },
    ]);
  });
  $('#spAddCol').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect(), { cols: n } = grid.selectionSize();
    const what = n > 1 ? `${n} columns` : 'column';
    Sheet.Menu.open(r.left, r.bottom + 6, [
      { label: `Insert ${what} left`, action: () => { grid.insertColumnAt('left'); grid.focus(); } },
      { label: `Insert ${what} right`, action: () => { grid.insertColumnAt('right'); grid.focus(); } },
    ]);
  });
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
      { label: 'Clear all data', action: () => { if (grid.clearAll()) toast('Cleared every cell · ⌘Z to undo'); grid.focus(); } },
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
    // nothing to download: say so, instead of saving a file with just the column names
    if (!sh.rows.some((r) => r.st !== 'empty')) return; // (the button is disabled then: nothing to download)
    const q = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
    const lines = [sh.headers.map(q).join(','), ...sh.rows.filter((r) => r.st !== 'empty').map((r) => r.cells.map((v) => q(String(v ?? ''))).join(','))];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }));
    a.download = `${sh.name.replace(/\.(csv|tsv|txt|xlsx?|xls)$/i, '')}${sh.dirty ? ' (edited)' : ''}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  // --- Save as contacts -----------------------------------------------------------------
  // The people on this sheet into Contacts (matched by number, so saving again updates them): everyone who'll get the
  // message, every valid number, or just the rows picked. Name / email / company from the matching columns, the
  // rest as extra details if wanted, and tags for everyone saved.
  async function saveContacts(picked = null) {
    const sh = current();
    if (!sh) return;
    const book = await api('/contacts');
    const existing = new Set(book.contacts.map((c) => c.phone));
    const guess = (re, not) => sh.headers.find((h) => re.test(h) && !(not && not.test(h))) || '';
    const map = {
      name: guess(/^(full[ _-]?)?name$|contact name|customer|^name\b/i) || guess(/name/i, /company|business|file|user ?name|campaign|ad|form/i),
      email: guess(/e-?mail/i),
      company: guess(/^(company|company[ _-]?name|business[ _-]?name|organi[sz]ation|firm|brand|shop[ _-]?name)$/i),
    };
    const sets = {
      send: sh.rows.filter((r) => r.phone && r.on && (r.st === 'valid' || r.st === 'duplicate')),
      valid: sh.rows.filter((r) => r.phone),
      ...(picked ? { picked } : {}),
    };
    const S = { which: picked ? 'picked' : 'send', extra: true, tags: new Set() };
    const label = { send: 'Getting this message', valid: 'Every valid number', picked: 'Selected rows' };
    const uniq = (rows) => [...new Map(rows.map((r) => [r.phone, r])).values()];
    const body = openModal('Save as contacts', `
      <p class="sub ib-modal-sub">From <b>${esc(sh.name)}</b>. People are matched by number, so anyone already in Contacts is updated, not duplicated.</p>
      <div class="field-label">Who to save</div>
      <div class="seg sc-which" id="scWhich" role="radiogroup" aria-label="Who to save">${Object.keys(sets).map((k) => `<button type="button" data-which="${k}" class="${k === S.which ? 'active' : ''}" role="radio" aria-checked="${k === S.which}">${label[k]} <span class="opt">${uniq(sets[k]).length.toLocaleString()}</span></button>`).join('')}</div>
      <div class="ci-map">${['name', 'email', 'company'].map((k) => `<label>${k[0].toUpperCase() + k.slice(1)}<select data-map="${k}"><option value="">—</option>${sh.headers.filter((h) => h !== sh.phoneName).map((h) => `<option ${h === map[k] ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`).join('')}</div>
      <label class="ci-check"><input type="checkbox" class="cb" id="scExtra" checked /> Keep other columns as extra details</label>
      <div class="field-label">Tag everyone saved</div>
      <div class="ct-pick" id="scTags">${book.tags.map((t) => `<button type="button" class="ct-tag tag-${esc(t.color)}" data-pick="${t.id}"><i></i>${esc(t.name)}</button>`).join('')}</div>
      <input id="scNewTags" placeholder="New tags, separated by commas (e.g. ${esc(sh.name.replace(/\.(csv|tsv|txt|xlsx?)$/i, ''))})" />
      <div class="modal-actions"><span class="ci-summary" id="scSummary"></span><button class="btn quiet" id="scCancel">Cancel</button><button class="btn primary" id="scGo">Save</button></div>`);
    body.closest('.modal-box').classList.add('ci-box');
    const collect = () => {
      const at = (h) => sh.headers.indexOf(h);
      const used = new Set([sh.phoneName, ...Object.values(map)].filter(Boolean));
      return uniq(sets[S.which]).map((r) => {
        const get = (k) => (map[k] ? String(r.cells[at(map[k])] ?? '').trim() : '');
        const extra = S.extra ? Object.fromEntries(sh.headers.filter((h) => !used.has(h) && String(r.cells[at(h)] ?? '').trim()).map((h) => [h, String(r.cells[at(h)]).trim()])) : {};
        return { phone: r.phone, name: get('name'), email: get('email'), company: get('company'), extra };
      });
    };
    const summary = () => {
      const rows = collect(), fresh = rows.filter((r) => !existing.has(r.phone)).length;
      $('#scSummary', body).textContent = rows.length ? `${rows.length.toLocaleString()} people · ${fresh.toLocaleString()} new, ${(rows.length - fresh).toLocaleString()} already saved` : 'Nobody with a valid number here';
      $('#scGo', body).disabled = !rows.length;
      $('#scGo', body).textContent = rows.length ? `Save ${rows.length.toLocaleString()}` : 'Save';
    };
    body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.map) map[t.dataset.map] = t.value;
      if (t.id === 'scExtra') S.extra = t.checked;
      summary();
    });
    $('#scWhich', body).addEventListener('click', (e) => {
      const b = e.target.closest('[data-which]');
      if (!b) return;
      S.which = b.dataset.which;
      $$('#scWhich [data-which]', body).forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-checked', String(x === b)); });
      summary();
    });
    Motion.segs(body);
    $('#scTags', body).addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      S.tags.has(b.dataset.pick) ? S.tags.delete(b.dataset.pick) : S.tags.add(b.dataset.pick);
      b.classList.toggle('active');
    });
    $('#scCancel', body).onclick = closeModal;
    $('#scGo', body).onclick = (e) => guard(async () => {
      const newTags = $('#scNewTags', body).value.split(',').map((x) => x.trim()).filter(Boolean);
      const r = await api('/contacts/import', { method: 'POST', body: { rows: collect(), tags: [...S.tags], newTags } });
      closeModal();
      toast(`Saved to Contacts: ${r.added.toLocaleString()} new, ${r.updated.toLocaleString()} updated${r.invalid ? `, ${r.invalid} skipped` : ''}`);
    }, e.currentTarget);
    summary();
  }
  // --- Ask AI: tidy the sheet(s) in the Assistant ---------------------------------------
  // The sheets going into this send (or just this one), as they are now with your edits, are attached in the Assistant
  // with a prompt drafted for you to check and send. The Assistant builds a clean sheet (build_sheet) and asks when
  // it isn't sure what counts as valid; its result opens back here with "Open in Send".
  $('#spAskAi').addEventListener('click', () => {
    const sh = current();
    if (!sh || !window.Assistant?.attachTables) return;
    const list = SP.sheets.filter((x) => (x === sh || x.included) && x.rows.some((r) => r.st !== 'empty'));
    if (!list.length) return toast('Nothing to tidy yet: this sheet has no rows. Paste or open a contact list first.', 'error');
    const tables = list.map((x) => ({
      file: x.file || x.name, sheet: x.file && x.file !== x.name ? x.name : '', name: x.file && x.file !== x.name ? `${x.file} · ${x.name}` : x.name,
      headers: x.headers.slice(), rows: x.rows.filter((r) => r.st !== 'empty').map((r) => r.cells.map((v) => String(v ?? ''))), phone: x.phoneName || '',
    }));
    const many = tables.length > 1;
    const prompt = `Clean up ${many ? `these ${tables.length} sheets and combine them into one` : 'this sheet'} so it's ready to send: keep only real contacts with a valid WhatsApp number, tidy the names and other columns, drop junk rows (titles, notes, test entries, blanks) and merge duplicates. Before you build it, ask me anything you're unsure about, like which column has the numbers or which rows count as valid.`;
    showTab('assistant');
    window.Assistant.attachTables(tables, prompt);
  });

  $('#spSaveContacts').addEventListener('click', () => {
    const sh = current();
    if (!sh) return;
    if (!sh.rows.some((r) => r.phone)) return; // (the button is disabled then: no numbers to save)
    // several rows selected in the grid: offer just those too
    const sel = grid.selectedRows().filter((r) => r.phone);
    guard(() => saveContacts(sel.length > 1 ? sel : null));
  });

  $('#spPanelBtn').addEventListener('click', () => {
    SP.panel = !SP.panel;
    try { localStorage.setItem('sendPanel', SP.panel ? '1' : '0'); } catch { }
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
        const nums = row.send.filter((p) => !seen.has(p));
        if (!nums.length) { skip.duplicate++; continue; }
        const obj = {};
        sh.headers.forEach((h, i) => { obj[h] = String(row.cells[i] ?? '').trim(); });
        // A column value that's empty or a placeholder ("Not Captured") uses the variable's fallback, if it has one.
        const miss = vars.find((v) => { const m = SP.mapping[v.key]; return m?.type === 'column' && !cellValue(m, obj[m.value]) && !String(m.fallback || '').trim(); });
        if (miss) { skip.missing[miss.key] = (skip.missing[miss.key] || 0) + 1; continue; }
        // One message per chosen number (usually one: the suggested first number).
        for (const p of nums) { seen.add(p); out.push({ sheet: sh, row, obj: { ...obj, __phone: p } }); }
      }
    }
    return { list: out, skip, sheets };
  }

  // --- Message panel ---------------------------------------------------------------------

  const currentTemplate = () => state.templates.find((t) => t.id === $('#templateSelect').value);

  function renderTemplateSelect() {
    const sel = $('#templateSelect');
    const prev = sel.value;
    // Templates Meta hasn't approved show, but can't be picked.
    const opt = (t) => `<option value="${t.id}" data-tag="${esc(catLabel(t.category))}"${tplSendBlock(t) ? ' disabled' : ''}>${esc(t.name)} · ${esc(t.language)}${t.status && t.status !== 'APPROVED' ? ` (${esc(TPL_STATUS[String(t.status).toUpperCase()] || t.status).toLowerCase()})` : ''}</option>`;
    // With numbers in different Business Accounts, group the templates by the number(s) that can send them.
    const accounts = [...new Set(state.senders.map((x) => x.wabaId).filter(Boolean))];
    const grouped = accounts.length > 1
      ? accounts.map((w) => { const ts = state.templates.filter((t) => t.wabaId === w); return ts.length ? `<optgroup label="${esc(accountLabel(w))}">${ts.map(opt).join('')}</optgroup>` : ''; }).join('')
      + (state.templates.some((t) => !accounts.includes(t.wabaId)) ? `<optgroup label="Other">${state.templates.filter((t) => !accounts.includes(t.wabaId)).map(opt).join('')}</optgroup>` : '')
      : state.templates.map(opt).join('');
    sel.innerHTML = state.templates.length
      ? `<option value="">— Choose a template —</option>` + grouped
      : `<option value="">No templates yet — add one under Templates</option>`;
    if (state.templates.some((t) => t.id === prev && !tplSendBlock(t))) sel.value = prev;
    onTemplateChange();
  }
  $('#templateSelect').addEventListener('change', onTemplateChange);

  // --- Choosing a template: a window with every template as a preview card, to search, filter, sort and pick ---
  function renderTplPickBtn() {
    const t = currentTemplate(), b = $('#tplPickBtn');
    b.innerHTML = t
      ? `${icon('file-text', 16)}<span class="tp-btn-main"><b title="${esc(t.name)}">${esc(t.name)}</b><small>${esc(t.language)} · ${esc(catLabel(t.category).toLowerCase())}${t.variables.length ? ` · ${t.variables.length} variable${t.variables.length > 1 ? 's' : ''}` : ''}</small></span><span class="tp-btn-act">Change</span>`
      : `${icon('file-text', 16)}<span class="tp-btn-main"><b>${state.templates.length ? 'Choose a template' : 'No templates yet'}</b><small>${state.templates.length ? `${state.templates.filter((x) => !tplSendBlock(x)).length} ready to send` : 'Add one under Templates'}</small></span>${icon('chevron-down', 15)}`;
    b.classList.toggle('empty', !t);
  }
  const TP = { q: '', cat: '', status: 'ready', num: '', sort: 'name' };
  const TP_SORTS = { name: ['Name A–Z', (a, b) => a.name.localeCompare(b.name)], new: ['Newest', (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))], cat: ['Category', (a, b) => catLabel(a.category).localeCompare(catLabel(b.category)) || a.name.localeCompare(b.name)] };
  function openTemplatePicker() {
    if (!state.templates.length) { showTab('templates'); return toast('Add or sync a template first'); }
    templatePicker({
      selected: $('#templateSelect').value || '',
      onUse: (id) => { $('#templateSelect').value = id; $('#templateSelect').dispatchEvent(new Event('change')); },
    });
  }
  // The template window, shared with the Inbox (window.TemplatePicker). selected: the one picked now; block(t): why a
  // template can't be picked here, or null (default: not approved); nums: the numbers for the number filter; firstWaba:
  // the Business Account listed first; onUse(id): what picking does. It returns true when it opened another window in
  // this one's place (so this one doesn't close under it).
  // multi: pick several (selectedIds; onUse gets the list); only(t): which templates are offered at all; stacked: open
  // over the current popup instead of replacing it (the playbook editor).
  // extra(t): more lines on a card (e.g. how it was delivered); valuesOf(t): the values its preview shows; statusFilter:
  // false hides the status filter and shows every template (the unavailable ones greyed, with why).
  function templatePicker({ selected = '', block = tplSendBlock, nums = state.senders.filter((x) => x.enabled), firstWaba = '', title = 'Choose a template', useText = 'Use this template', onUse, multi = false, selectedIds = [], only = () => true, stacked = false, extra = null, valuesOf = null, statusFilter = true }) {
    let pick = selected;
    let openW = null; // which numbers' sections are open (set on the first draw)
    const picks = new Set(selectedIds);
    const isOn = (id) => (multi ? picks.has(id) : id === pick);
    const html = `
      <div class="tp-bar">
        <div class="search-wrap" data-icon="search" data-icon-size="15"><input data-1p-ignore data-lpignore="true" data-form-type="other" class="search" id="tpQ" placeholder="Search name or message" autocomplete="off" /></div>
        <select id="tpCat" aria-label="Category"></select>
        <select id="tpStatus" aria-label="Status"><option value="ready">Ready to send</option><option value="">Any status</option><option value="PENDING">In review</option><option value="REJECTED">Rejected</option></select>
        ${nums.length > 1 ? `<select id="tpNum" aria-label="Number"><option value="">All numbers</option>${nums.map((x) => `<option value="${x.id}">${esc(x.label)}</option>`).join('')}</select>` : ''}
        <button type="button" class="ct-sortbtn tp-sort" id="tpSort" aria-haspopup="menu"></button>
      </div>
      <div class="tp-grid" id="tpGrid"></div>
      <div class="tp-foot"><button type="button" class="btn quiet tp-manage" id="tpManage" title="Create, edit or sync templates on the Templates page">${icon('settings', 15)}Manage templates</button><span class="tp-count" id="tpCount"></span><button class="btn quiet" id="tpCancel">Cancel</button><button class="btn primary" id="tpUse" disabled>${esc(useText)}</button></div>`;
    const layer = stacked ? layerModal('tplPickModal', title, html, 'wide tp-box') : null;
    const body = layer ? layer.body : openModal(title, html);
    if (!layer) $('#modal .modal-box').classList.add('wide', 'tp-box');
    const close = layer ? layer.close : closeModal;
    LA.hydrate(body);
    $('#tpQ', body).value = TP.q;
    if (!statusFilter) $('#tpStatus', body).remove();
    const shown = () => {
      const q = TP.q.trim().toLowerCase();
      const n = nums.length > 1 && state.senders.find((x) => x.id === TP.num); // (no number filter shown: none applies)
      return state.templates.filter((t) => only(t) && (!TP.cat || catLabel(t.category) === TP.cat)
        && (!statusFilter || (TP.status === 'ready' ? !block(t) : !TP.status || String(t.status).toUpperCase() === TP.status))
        && (!n || templateSenders(t, [n]).length)
        && (!q || [t.name, t.language, ...(t.components || []).map((c) => c.text || '')].join(' ').toLowerCase().includes(q))).sort(TP_SORTS[TP.sort][1]);
    };
    const draw = () => {
      const cats = [...new Set(state.templates.filter(only).map((t) => catLabel(t.category)))].sort();
      $('#tpCat', body).innerHTML = `<option value="">All categories</option>${cats.map((c) => `<option ${c === TP.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}`;
      if ($('#tpStatus', body)) $('#tpStatus', body).value = TP.status;
      if ($('#tpNum', body)) $('#tpNum', body).value = TP.num;
      $('#tpSort', body).innerHTML = `${icon('arrow-up-down', 14)}<span>${TP_SORTS[TP.sort][0]}</span>${icon('chevron-down', 14)}`;
      const list = shown();
      $('#tpCount', body).textContent = `${list.length} template${list.length === 1 ? '' : 's'}${multi ? ` · ${picks.size} selected` : ''}`;
      const card = (t) => {
        const why = block(t);
        const st = String(t.status || '').toUpperCase();
        return `<div class="tp-card ${isOn(t.id) ? 'on' : ''} ${why ? 'off' : ''} ${multi ? 'multi' : ''}" data-id="${t.id}" role="option" aria-selected="${isOn(t.id)}" tabindex="${why ? -1 : 0}" ${why ? `title="${esc(why)}"` : ''}>
          <div class="tp-card-head">${multi ? `<span class="np-check">${TICK_SVG}</span>` : ''}<b title="${esc(t.name)}">${esc(t.name)}</b><span class="pill ${esc(st)}">${esc(TPL_STATUS[st] || t.status || '')}</span></div>
          <div class="tp-card-meta">${esc(t.language)} · ${esc(catLabel(t.category).toLowerCase())} · ${t.variables.length ? `${t.variables.length} variable${t.variables.length > 1 ? 's' : ''}` : 'no variables'}</div>
          ${extra ? extra(t) : ''}
          <div class="tpl-chat tp-prev"><div class="bubble">${bubbleHtml(t, valuesOf ? valuesOf(t) || {} : {}, true)}</div></div>
          ${why ? `<div class="tp-why">${icon('badge-alert', 13)}<span>${esc(why)}</span></div>` : ''}
        </div>`;
      };
      // In sections by number, as in the dropdown: numbers in different WhatsApp Business Accounts send different
      // templates. One account: a single grid.
      const accounts = [...new Set((multi ? nums : state.senders).map((x) => x.wabaId).filter(Boolean))].sort((a, b) => (b === firstWaba) - (a === firstWaba));
      const sections = accounts.length > 1
        ? [...accounts.map((w) => ({ w, ts: list.filter((t) => t.wabaId === w) })), { w: '', ts: list.filter((t) => !accounts.includes(t.wabaId)) }].filter((x) => x.ts.length)
        : [{ w: null, ts: list }];
      // Each number as on the Templates page: its profile header (photo, name, number, quality, how many templates, arrow),
      // collapsible. The number you're sending from (or the first) starts open; a search or filter opens every number
      // with a match. (tplGroupHead is the Templates page's own header, from app.js.)
      const filtering = Boolean(TP.q.trim() || TP.cat || TP.num || (TP.status && TP.status !== 'ready'));
      if (!openW) openW = new Set([sections[0]?.w ?? '']);
      $('#tpGrid', body).innerHTML = list.length ? sections.map((sec) => {
        if (sec.w === null) return `<section class="tp-group"><div class="tp-cards">${sec.ts.map(card).join('')}</div></section>`;
        const open = filtering || openW.has(sec.w);
        const head = tplGroupHead(sec.w, sec.ts, null, false).replace(/aria-expanded="[^"]*"/, `aria-expanded="${open}"`);
        return `<section class="tp-group tpl-group tp-num-sec ${open ? 'open' : ''}" data-w="${esc(sec.w)}">${head}<div class="tp-cards"${open ? '' : ' hidden'}>${sec.ts.map(card).join('')}</div></section>`;
      }).join('') : `<div class="tp-none">${emptyState({ icon: 'search', title: 'No templates match', text: 'Try another word or filter.', actions: '<button class="btn" data-tp-clear>Clear filters</button>' })}</div>`;
      LA.hydrate($('#tpGrid', body));
      $('#tpUse', body).disabled = multi ? false : !pick || Boolean(block(state.templates.find((t) => t.id === pick) || {}));
    };
    draw();
    const use = () => {
      if (multi) { onUse(state.templates.filter((t) => picks.has(t.id) && only(t)).map((t) => t.id)); return close(); }
      if (!pick) return;
      if (!onUse(pick)) close();
    };
    const choose = (c) => {
      if (multi) { picks.has(c.dataset.id) ? picks.delete(c.dataset.id) : picks.add(c.dataset.id); c.classList.toggle('on', picks.has(c.dataset.id)); c.setAttribute('aria-selected', String(picks.has(c.dataset.id))); $('#tpCount', body).textContent = $('#tpCount', body).textContent.replace(/· \d+ selected$/, `· ${picks.size} selected`); return; }
      pick = c.dataset.id;
      $$('.tp-card', body).forEach((x) => { x.classList.toggle('on', x === c); x.setAttribute('aria-selected', String(x === c)); });
      $('#tpUse', body).disabled = false;
    };
    $('#tpQ', body).oninput = (e) => { TP.q = e.target.value; draw(); };
    $('#tpCat', body).onchange = (e) => { TP.cat = e.target.value; draw(); };
    if ($('#tpStatus', body)) $('#tpStatus', body).onchange = (e) => { TP.status = e.target.value; draw(); };
    if ($('#tpNum', body)) $('#tpNum', body).onchange = (e) => { TP.num = e.target.value; draw(); };
    $('#tpSort', body).onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); Sheet.Menu.open(r.left, r.bottom + 6, Object.entries(TP_SORTS).map(([k, [label]]) => ({ label, checked: k === TP.sort, action: () => { TP.sort = k; draw(); } }))); };
    $('#tpGrid', body).addEventListener('click', (e) => {
      const hd = e.target.closest('.tp-num-sec > .tpl-num-h');
      if (hd) {
        // One number open at a time: opening one closes the rest. Those above it close at once, with the list scrolled
        // to match, so the header you clicked stays where it is; those below slide shut.
        const sec = hd.parentElement, open = !sec.classList.contains('open'), grid = $('#tpGrid', body);
        const setOpen = (x, on, animate) => {
          const cards = x.querySelector('.tp-cards'), h0 = x.querySelector('.tpl-num-h');
          on ? openW.add(x.dataset.w) : openW.delete(x.dataset.w);
          x.classList.toggle('open', on);
          h0.setAttribute('aria-expanded', on);
          x.__anim?.cancel();
          if (on) cards.hidden = false;
          if (!animate || Motion.reduce()) { cards.hidden = !on; cards.style.overflow = ''; return; }
          const h = cards.scrollHeight;
          cards.style.overflow = 'hidden';
          x.__anim = cards.animate(on ? [{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }] : [{ height: h + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: Math.min(380, 200 + h / 10), easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
          x.__anim.onfinish = () => { cards.style.overflow = ''; if (!on) cards.hidden = true; x.__anim = null; };
        };
        if (open) {
          const before = hd.getBoundingClientRect().top;
          for (const o of grid.querySelectorAll('.tp-num-sec.open')) if (o !== sec) setOpen(o, false, Boolean(sec.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING));
          grid.scrollTop += hd.getBoundingClientRect().top - before;
        }
        setOpen(sec, open, true);
        return;
      }
      if (e.target.closest('[data-tp-clear]')) { Object.assign(TP, { q: '', cat: '', status: 'ready', num: '' }); $('#tpQ', body).value = ''; return draw(); }
      const c = e.target.closest('.tp-card');
      if (c?.classList.contains('off')) return c.title && toast(c.title, 'error'); // greyed: say why
      if (!c) return;
      choose(c);
    });
    $('#tpGrid', body).addEventListener('dblclick', (e) => { const c = e.target.closest('.tp-card:not(.off)'); if (c && !multi) { pick = c.dataset.id; use(); } });
    $('#tpGrid', body).addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.tp-num-sec > .tpl-num-h')) { e.preventDefault(); return e.target.click(); } const c = e.target.closest('.tp-card:not(.off)'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (multi) choose(c); else { pick = c.dataset.id; use(); } } });
    $('#tpCancel', body).onclick = close;
    $('#tpManage', body).onclick = () => { close(); if (layer) closeModal(); showTab('templates'); };
    $('#tpUse', body).onclick = use;
    // the chosen one in view; otherwise the search
    requestAnimationFrame(() => { const on = $('.tp-card.on', body); if (on) on.scrollIntoView({ block: 'nearest' }); else $('#tpQ', body).focus(); });
  }
  $('#tplPickBtn').addEventListener('click', openTemplatePicker);
  window.TemplatePicker = templatePicker;

  // A "Visit website" button whose link is …/go/{{1}} (see goCode on the server) takes a full link.
  const goButton = (t, v) => {
    const i = /^button(\d+)$/.exec(v.where)?.[1];
    const b = i != null && comp(t, 'BUTTONS')?.buttons?.[Number(i)];
    return Boolean(b && b.type === 'URL' && /\/go\/{{\s*\w+\s*}}$/.test(b.url || ''));
  };
  function autoMap(v) {
    const match = columns().find((h) => h.toLowerCase() === String(v.name).toLowerCase());
    if (match) return { type: 'column', value: match };
    // Such a button usually opens the same link as the message: reuse the body variable whose sample (from
    // Meta's review) is a link, or the only body variable there is.
    const t = currentTemplate(), body = (t?.variables || []).filter((x) => x.where === 'body');
    // A website button starts with the link typed in the template (change it here for this campaign).
    const saved = t?.linkDefaults?.[/^button(\d+)$/.exec(v.where)?.[1]];
    if (saved) return { type: 'fixed', value: saved };
    if (t && goButton(t, v)) {
      const samples = comp(t, 'BODY')?.example?.body_text?.[0] || [];
      const linkVar = body.find((x) => /^https?:\/\//i.test(String(samples[Number(x.name) - 1] || '')));
      if (linkVar || body.length === 1) return { type: 'same', value: (linkVar || body[0]).key };
    }
    return { type: 'fixed', value: '' };
  }

  function onTemplateChange() {
    renderTplPickBtn();
    const t = currentTemplate();
    const next = {};
    for (const v of t?.variables || []) next[v.key] = SP.mapping[v.key] || autoMap(v);
    if (SP.mapping['header.filename'] && t?.variables.some((v) => v.media === 'document')) next['header.filename'] = SP.mapping['header.filename'];
    SP.mapping = next;
    renderSenderChecks(); // the numbers that can send this template
    renderMapping();
    renderPreview();
    renderSummary();
    renderTplPreview();
  }

  function renderSenderChecks() {
    // Only the numbers that can send the chosen template (same Business Account); the others can't.
    const t = currentTemplate();
    const all = state.senders.filter((s) => s.enabled);
    const enabled = t ? templateSenders(t, all) : all;
    const ok = new Set(enabled.map((s) => s.id));
    for (const id of [...state.selectedSenders]) if (!ok.has(id)) state.selectedSenders.delete(id);
    if (!state.selectedSenders.size) enabled.forEach((s) => state.selectedSenders.add(s.id));
    $('#sendFromHint').textContent = enabled.length > 1 ? 'split evenly across the numbers you pick' : enabled.length ? 'every message goes from this number' : '';
    $('#senderChecks').innerHTML = enabled.length
      ? enabled.map((s) => {
        const on = state.selectedSenders.has(s.id), many = enabled.length > 1;
        return `<button type="button" class="sf-item ${on ? 'on' : ''} ${many ? 'pick' : ''}" data-sid="${s.id}" ${many ? `aria-pressed="${on}" title="${on ? 'Sending from this number. Click to leave it out.' : 'Click to send from this number too'}"` : 'tabindex="-1"'}>${senderPhotoHtml(s)}<span class="sf-who"><b>${esc(s.verifiedName || s.label)}</b><small>${esc(s.displayPhone || 'ID ' + s.phoneNumberId)}</small></span>${many ? `<span class="sf-tick">${on ? icon('check-one', 14) : ''}</span>` : ''}</button>`;
      }).join('')
      : all.length ? `<div class="empty-note">None of your numbers can send this template: it belongs to another WhatsApp Business Account.</div>`
        : `<div class="empty-note">No numbers yet. <a href="#" data-goto="numbers">Add one</a> to start sending.</div>`;
    renderSummary();
  }
  $('#senderChecks').addEventListener('click', (e) => {
    const b = e.target.closest('.sf-item.pick');
    if (!b) return;
    const id = b.dataset.sid;
    if (state.selectedSenders.has(id)) {
      if (state.selectedSenders.size === 1) return toast('Send from at least one number', 'error');
      state.selectedSenders.delete(id);
    } else state.selectedSenders.add(id);
    renderSenderChecks();
  });

  // The variable you're editing lights up in the preview, and its field lights up too.
  function flashVar(key) {
    $$('#preview [data-var]').forEach((s) => s.classList.toggle('focus', s.dataset.var === key));
    $$('#mapping .sp-map').forEach((r) => r.classList.toggle('focus', r.dataset.key === key));
  }
  $('#mapping').addEventListener('focusin', (e) => { const r = e.target.closest('.sp-map'); if (r) flashVar(r.dataset.key); });
  $('#mapping').addEventListener('focusout', () => setTimeout(() => { if (!$('#mapping').contains(document.activeElement)) flashVar(null); }, 0));

  // The file name when a link is one of our uploads (…/u/<name>), so Remove can delete it.
  const uploadedName = (url) => String(url || '').match(new RegExp(`^${location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/u/([0-9a-f]{32}\\.[a-z0-9]{2,4})(/[^/]*)?$`))?.[1] || '';
  // The header link box's example, for the kind of file the template takes.
  const MEDIA_EXAMPLE = { image: 'https://…/photo.jpg (JPG or PNG)', video: 'https://…/video.mp4', document: 'https://…/brochure.pdf' };
  // What the header upload button lets you pick, per header type.
  const UPLOAD_ACCEPT = { image: 'image/jpeg,image/png', video: 'video/mp4,video/3gpp', document: 'application/pdf' };
  // the Inbox's "Send a template" fills a template the same way
  window.TplFill = { uploadedName, UPLOAD_ACCEPT, MEDIA_EXAMPLE, goButton };

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
      const fixed = m.type === 'fixed';
      const where = v.media ? 'header' : v.where.startsWith('button') ? 'button link' : v.where;
      const go = goButton(t, v);
      const sameOpts = go ? t.variables.filter((x) => x.where === 'body').map((x) => `<option value="s:${esc(x.key)}" ${m.type === 'same' && m.value === x.key ? 'selected' : ''}>Same link as {{${esc(x.name)}}} in the message</option>`).join('') : '';
      return `<div class="sp-map" data-key="${esc(v.key)}">
        <div class="var-key">${esc(v.media ? v.media + ' URL' : `{{${v.name}}}`)}<small>${esc(where)}</small></div>
        <select class="m-src" aria-label="Value for ${esc(varLabel(v))}">
          ${sameOpts}
          ${cols.length ? `<optgroup label="Column">${cols.map((c) => `<option value="c:${esc(c)}" ${m.type === 'column' && c === m.value ? 'selected' : ''}>${esc(c)}</option>`).join('')}</optgroup>` : ''}
          <option value="fixed" ${fixed ? 'selected' : ''}>${go ? 'Paste a link for everyone…' : 'Same text for everyone…'}</option>
        </select>
        ${fixed ? `<input class="m-val" value="${esc(m.value)}" placeholder="${v.media ? MEDIA_EXAMPLE[v.media] || 'https://…' : go ? 'https://… (any full link)' : 'Type the text'}" aria-label="Text for ${esc(varLabel(v))}" />` : ''}
        ${fixed && v.media ? `<div class="m-upload-row"><label class="btn sm m-upload" title="Upload a ${esc(v.media)} from this computer">${icon('upload', 14)}${uploadedName(m.value) ? 'Replace' : 'Upload'} ${esc(v.media)}<input type="file" hidden accept="${esc(UPLOAD_ACCEPT[v.media] || '')}" /></label>${m.value ? `<button type="button" class="btn sm quiet m-unupload" title="Take this ${esc(v.media)} out of the message">${icon('delete', 14)}Remove</button>` : ''}</div>` : ''}
        ${m.type === 'column' && !v.media ? fallbackHtml(v, m) : ''}
      </div>${v.media === 'document' ? fileNameRow() : ''}`;
    }).join('');
    markLinks();
  }
  // A typed value with a link problem gets a red note right under it (sending is blocked in the summary too).
  function markLinks() {
    const t = currentTemplate();
    for (const inp of $$('#mapping .sp-map .m-val')) {
      const v = t?.variables.find((x) => x.key === inp.closest('.sp-map').dataset.key);
      const bad = v ? linkProblem(inp.value, Boolean(v.media) || /^button/.test(v.where)) : '';
      inp.classList.toggle('bad', Boolean(bad));
      let note = inp.nextElementSibling?.classList.contains('m-err') ? inp.nextElementSibling : null;
      if (bad && !note) { note = document.createElement('small'); note.className = 'm-err'; inp.after(note); }
      if (note) { note.textContent = bad ? `This ${bad}. Write the full link, e.g. https://example.com` : ''; if (!bad) note.remove(); }
    }
  }
  // Rows about to be sent whose cell in `col` is empty or a placeholder ("Not Captured", "N/A"…).
  // A column's value for a variable: placeholders like "Not Captured" or "N/A" count as empty unless that's turned off
  // for the variable (keepFiller), e.g. when "Na" is someone's real name. Same rule on the server.
  const cellValue = (m, v) => (m?.keepFiller ? String(v ?? '').trim() : cleanCell(v));
  function blankRows(col, m = Object.values(SP.mapping).find((x) => x?.type === 'column' && x.value === col)) {
    const out = [];
    for (const sh of SP.sheets) {
      if (!sh.included) continue;
      const i = sh.headers.indexOf(col);
      if (i < 0) continue;
      for (const row of sh.rows) if (row.st === 'valid' && row.on && !cellValue(m, row.cells[i])) out.push({ sh, row, c: i });
    }
    return out;
  }
  // "Show": jump to the next row with no value in that column and select the cell (each click goes to the next one).
  const blankAt = {};
  $('#mapping').addEventListener('click', (e) => {
    const b = e.target.closest('[data-show-blank]');
    if (!b) return;
    const col = b.dataset.showBlank, list = blankRows(col, SP.mapping[b.closest('.sp-map').dataset.key]);
    if (!list.length) return renderMapping();
    const k = (blankAt[col] = ((blankAt[col] ?? -1) + 1) % list.length);
    const { sh, row, c } = list[k];
    if (current() !== sh) activate(SP.sheets.indexOf(sh));
    if (!sh.view.includes(row)) { sh.show = 'all'; grid.refilter(); renderChrome(); }
    grid.select(sh.view.indexOf(row), c);
    b.querySelector('span').textContent = list.length > 1 ? `Next · ${k + 1} of ${list.length}` : 'Showing it';
  });
  // What a column variable says when the cell has nothing usable, e.g. "your organisation" for a company.
  function fallbackHtml(v, m) {
    const n = blankRows(m.value, m).length;
    // Rows whose cell has a placeholder ("Not Captured", "N/A", "Na"…) rather than nothing at all.
    const filler = blankRows(m.value, { ...m, keepFiller: false }).length - blankRows(m.value, { ...m, keepFiller: true }).length;
    const toggle = filler || m.keepFiller
      ? `<label class="m-keep"><input type="checkbox" data-keep-filler ${m.keepFiller ? '' : 'checked'} /><span>Treat “Not Captured”, “N/A”, “Na”… as empty <i>${filler.toLocaleString()} row${filler === 1 ? '' : 's'}</i></span></label>`
      : '';
    return `<input class="m-fb" value="${esc(m.fallback || '')}" placeholder="${m.keepFiller ? 'If empty, use…' : 'If empty or “Not Captured”, use…'}" aria-label="Fallback for ${esc(varLabel(v))}" />
      ${toggle}
      <small class="m-hint">${n ? `${n.toLocaleString()} row${n > 1 ? 's have' : ' has'} no value here${m.keepFiller ? ' (empty cells)' : ' (empty, “Not Captured”, “N/A”…)'}. <span class="m-fb-what">${m.fallback ? 'They get the text above.' : 'Without text above, they’re left out.'}</span> <button type="button" class="m-show" data-show-blank="${esc(m.value)}">${icon('eye', 13)}<span>${n > 1 ? `Show the ${n.toLocaleString()} rows` : 'Show the row'}</span></button>` : `Every row has a value here${m.keepFiller && filler ? ', including placeholders like “N/A”, sent as written' : ''}.`}</small>`;
  }
  // The name WhatsApp shows on a PDF header (without one it says "Untitled"). Upload fills in the original name.
  function fileNameRow() {
    SP.mapping['header.filename'] ||= { type: 'fixed', value: '' };
    return `<div class="sp-map" data-key="header.filename">
      <div class="var-key">file name<small>header</small></div>
      <input class="m-val" value="${esc(SP.mapping['header.filename'].value)}" placeholder="e.g. Brochure.pdf" maxlength="100" aria-label="File name customers see" />
      <small class="m-hint">What customers see on the PDF. Leave empty to use the uploaded file's name.</small>
    </div>`;
  }
  // Header image/video/document from the computer: the server keeps it and gives back a public link,
  // which goes in the field like a pasted one.
  $('#mapping').addEventListener('change', async (e) => {
    if (!e.target.matches('.m-upload input[type=file]')) return;
    const file = e.target.files[0], row = e.target.closest('.sp-map'), btn = e.target.closest('.m-upload');
    e.target.value = '';
    if (!file || !row) return;
    btn.classList.add('busy');
    try {
      const res = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || (res.status === 413 ? 'That file is too big for WhatsApp' : `Upload failed (${res.status})`));
      SP.mapping[row.dataset.key] = { type: 'fixed', value: json.url };
      if (json.fileName && row.dataset.key === 'header.media' && file.type === 'application/pdf') SP.mapping['header.filename'] = { type: 'fixed', value: json.fileName };
      renderMapping();
      renderPreview();
      renderSummary();
      toast(`Uploaded ${file.name}`);
    } catch (err) { toast(err.message, 'error'); btn.classList.remove('busy'); }
  });
  // Remove: clears the field, and deletes the file too when it's one uploaded here (the server keeps it if
  // a campaign already used it).
  $('#mapping').addEventListener('click', (e) => {
    const b = e.target.closest('.m-unupload');
    if (!b) return;
    const key = b.closest('.sp-map').dataset.key, file = uploadedName(SP.mapping[key]?.value);
    SP.mapping[key] = { type: 'fixed', value: '' };
    if (key === 'header.media' && SP.mapping['header.filename']) SP.mapping['header.filename'].value = '';
    renderMapping();
    renderPreview();
    renderSummary();
    if (file) api('/uploads/' + file, { method: 'DELETE' }).catch(() => { });
  });
  // Placeholders as empty, or sent as written (e.g. "Na" is a real name here).
  $('#mapping').addEventListener('change', (e) => {
    if (!e.target.matches('[data-keep-filler]')) return;
    SP.mapping[e.target.closest('.sp-map').dataset.key].keepFiller = !e.target.checked;
    renderMapping();
    renderPreview();
    renderSummary();
  });
  $('#mapping').addEventListener('input', (e) => {
    if (e.target.type === 'file' || e.target.type === 'checkbox') return;
    const row = e.target.closest('.sp-map');
    if (!row) return;
    const key = row.dataset.key;
    if (e.target.classList.contains('m-fb')) {
      SP.mapping[key].fallback = e.target.value;
      const hint = e.target.nextElementSibling;
      const what = hint?.querySelector('.m-fb-what');
      if (what) what.textContent = e.target.value.trim() ? 'They get the text above.' : 'Without text above, they’re left out.';
    } else if (e.target.classList.contains('m-src')) {
      const v = e.target.value;
      SP.mapping[key] = v === 'fixed' ? { type: 'fixed', value: '' } : v.startsWith('s:') ? { type: 'same', value: v.slice(2) } : { type: 'column', value: v.slice(2) };
      renderMapping();
      if (v === 'fixed') $(`.sp-map[data-key="${CSS.escape(key)}"] .m-val`)?.focus();
    } else { SP.mapping[key].value = e.target.value; markLinks(); }
    renderPreview();
    flashVar(key);
    renderSummary();
  });

  const valuesFor = (obj) => {
    const out = {};
    for (const v of currentTemplate()?.variables || []) {
      const m = SP.mapping[v.key] || {};
      out[v.key] = m.type === 'column' ? cellValue(m, obj?.[m.value]) || String(m.fallback || '').trim() : m.type === 'same' ? '' : m.value || '';
    }
    for (const v of currentTemplate()?.variables || []) if (SP.mapping[v.key]?.type === 'same') out[v.key] = out[SP.mapping[v.key].value] ?? '';
    if (SP.mapping['header.filename']?.value) out['header.filename'] = SP.mapping['header.filename'].value;
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
  }

  // Compose / Preview tabs in the message panel.
  function setPane(name) {
    SP.pane = name;
    $$('#spPaneSeg button').forEach((b) => { b.classList.toggle('active', b.dataset.pane === name); b.setAttribute('aria-selected', String(b.dataset.pane === name)); });
    $$('#spPanel .sp-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
    // Personalise widens the panel so the preview and the fields sit side by side.
    $('#tab-send').classList.toggle('pane-wide', name === 'preview');
    // …and makes room by shrinking the sidebar to icons (Setup brings it back).
    if (state.sendWide !== (name === 'preview')) { state.sendWide = name === 'preview'; state.sendNavOpen = false; syncNav(); }
    if (name === 'preview') renderPreview();
    renderSummary(); // the send bar's button: "Next" on Setup, "Send" on Personalise
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

  // The campaign this page is for, at the top of Setup: its name, template and AI replies, with Edit (CampaignSetup).
  function renderCamp() {
    const c = SP.campaign, el = $('#spCamp');
    if (!el) return;
    el.classList.toggle('hidden', !c);
    if (!c) return;
    const t = state.templates.find((x) => x.id === c.templateId);
    const ai = state.me?.ai ? (c.ai?.on ? (c.ai.auto ? 'AI replies on its own' : 'AI drafts replies') : 'No AI replies') : '';
    const from = state.senders.filter((x) => state.selectedSenders.has(x.id));
    const fromText = from.length === 1 ? from[0].verifiedName || from[0].label : from.length ? `${from.length} numbers` : 'No number';
    el.innerHTML = `<div class="sp-camp-main"><span class="sp-camp-k">Campaign · draft</span><b title="${esc(c.name)}">${esc(c.name)}</b>${c.description ? `<span class="sp-camp-desc" title="${esc(c.description)}">${esc(c.description)}</span>` : ''}
        <small><span>${icon('file-text', 13)}${esc(t?.name || c.templateName || 'No template')}</span><span title="${esc(from.map((x) => `${x.label} ${x.displayPhone || ''}`).join(', '))}">${icon('phone', 13)}${esc(fromText)}</span>${ai ? `<span>${icon('sparkles', 13)}${esc(ai)}</span>` : ''}</small></div>
      <button type="button" class="btn sm" id="spCampEdit">${icon('settings', 14)}Edit</button>`;
  }
  $('#spCamp')?.addEventListener('click', (e) => {
    if (!e.target.closest('#spCampEdit') || !SP.campaign) return;
    window.CampaignSetup.open({ draft: SP.campaign, onSaved: (d) => useCampaign(d) });
  });
  $('#spBack')?.addEventListener('click', () => showTab('campaigns'));
  // The campaign's details changed (or it was just opened): its template and name drive the page.
  function useCampaign(d) {
    SP.campaign = d;
    $('#campaignName').value = d.name;
    // the numbers chosen with the campaign (older drafts without them: every number that can send it, as before)
    state.selectedSenders = new Set((d.senderIds || []).filter((x) => state.senders.some((s) => s.id === x && s.enabled)));
    if ($('#templateSelect').value !== d.templateId) {
      if (![...$('#templateSelect').options].some((o) => o.value === d.templateId)) renderTemplateSelect();
      $('#templateSelect').value = d.templateId;
      onTemplateChange();
    } else renderSenderChecks();
    renderChrome();
  }

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
    $('#spTitle').textContent = has ? sh.name : SP.campaign ? 'Add the people to send to' : 'Send a campaign';
    renderCamp();
    if (has) {
      const c = sh.counts;
      const filtered = Object.keys(sh.filters).length;
      $('#spMeta').innerHTML = `${sh.file && sh.file !== sh.name ? `<span class="sp-file-dot" style="--tab-c:${colorOf(sh)}"></span>${esc(sh.file)} · ` : ''}${c.rows.toLocaleString()} rows · ${sh.headers.length} columns`;
      renderStrip(sh, filtered);
      // Export and Save contacts are disabled (not clickable) until there's something to export or save; the tooltip
      // says what's needed, so nobody gets an error for trying
      const ex = $('#spExport'), none = !sh.rows.some((r) => r.st !== 'empty');
      ex.disabled = none;
      ex.title = none ? 'Add some rows to export this sheet' : 'Download this sheet, with your edits, as CSV';
      const sv = $('#spSaveContacts'), noPhones = !sh.rows.some((r) => r.phone);
      sv.disabled = noPhones;
      sv.title = noPhones ? 'Add a valid phone number to save contacts' : 'Save the people on this sheet to Contacts';
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
    const saved = { headers: sh.headers.slice(), widths: sh.widths.slice(), wraps: (sh.wraps || []).slice(), cells: sh.rows.map((r) => r.cells.slice()), phone: sh.phoneName };
    const fixed = realignShiftedRows(saved.headers, saved.cells, groups);
    const widthOf = new Map(saved.headers.map((h, i) => [h, saved.widths[i]]));
    const wrapOf = new Map(saved.headers.map((h, i) => [h, Boolean(saved.wraps[i])])); // wrap follows the column by name
    grid.apply({
      kind: 'cols',
      do() {
        sh.headers = fixed.headers.slice();
        sh.widths = fixed.headers.map((h) => widthOf.get(h) ?? 160);
        sh.wraps = fixed.headers.map((h) => wrapOf.get(h) || false);
        sh.rows.forEach((r, i) => { r.cells = fixed.rows[i].slice(); });
      },
      undo() {
        sh.headers = saved.headers.slice();
        sh.widths = saved.widths.slice();
        sh.wraps = saved.wraps.slice();
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
    const n = { all: sh.counts.rows, valid: sh.counts.valid, invalid: sh.counts.invalid, duplicate: sh.counts.duplicate, off, multi: sh.counts.multi || 0 };
    const cur = sh.show || 'all';
    const shown = sh.view.filter((r) => r.st !== 'empty').length;
    $('#spStrip').innerHTML = `
      <div class="seg sp-show" role="radiogroup" aria-label="Show rows">${Object.entries(SHOW).map(([k, v]) =>
      k !== 'all' && k !== 'valid' && !n[k] && cur !== k ? '' : `<button type="button" data-show="${k}" class="${cur === k ? 'active' : ''} st-${k}" role="radio" aria-checked="${cur === k}">${v.label} <span class="n">${n[k].toLocaleString()}</span></button>`).join('')}</div>
      ${filtered ? `<span class="sp-filtered">${shown.toLocaleString()} of ${sh.counts.rows.toLocaleString()} rows match the column filters · <button type="button" class="link" data-clear-filters>Clear</button></span>` : ''}
      ${!sh.phoneName ? '<span class="sp-alert">Choose the phone column in the toolbar</span>' : ''}
      ${phoneHint(sh)}${shiftHint(sh)}${n.multi && cur !== 'multi' ? `<button type="button" class="link sp-phone-hint" data-show="multi">${n.multi.toLocaleString()} row${n.multi > 1 ? 's have' : ' has'} more than one number: the first one is used. Review</button>` : ''}`;
    Motion.segs($('#spStrip'));
  }

  // The tag on a phone cell with several numbers: choose which to send to (one, or all of them).
  // (Pressing it mustn't select the cell: that redraws the row and the click would be lost.)
  $('#spGrid').addEventListener('mousedown', (e) => { if (e.target.closest('.sp-multi')) e.stopPropagation(); }, true);
  $('#spGrid').addEventListener('click', (e) => {
    const tag = e.target.closest('.sp-multi');
    if (!tag) return;
    e.stopPropagation();
    e.preventDefault();
    const sh = current(), row = sh.view[Number(tag.closest('tr').dataset.r)];
    if (!row) return;
    const set = (pick) => { row.pick = pick; recheck(sh); grid.render(); renderChrome(); };
    const r = tag.getBoundingClientRect();
    const isOnly = (p) => row.send.length === 1 && row.send[0] === p;
    Sheet.Menu.open(r.left, r.bottom + 4, [
      ...row.phones.map((p, i) => ({ label: `+${p}`, checked: isOnly(p), kbd: i === 0 ? 'suggested' : '', action: () => set(i === 0 ? undefined : [p]) })),
      '-',
      { label: `Send to all ${row.phones.length} numbers`, checked: row.send.length === row.phones.length, action: () => set([...row.phones]) },
    ]);
  }, true); // before the grid's own click handling
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


  // "This is a test": suggested (switched on) for a handful of people or a name with "test" in it, until you set it
  let testTouched = false;
  function suggestTest(count) {
    const name = $('#campaignName').value, few = count > 0 && count <= 5, named = /test/i.test(name);
    if (!testTouched) $('#spTest').checked = few || named;
    // (the switch sits in the top bar; its tooltip says what a test is, and why it was switched on for you)
    const why = !testTouched && (few || named) ? `Switched on for you: ${named ? 'the name says test' : `only ${count} ${count === 1 ? 'person' : 'people'}`}. ` : '';
    $('#spTestWrap').title = `${why}A test send is tagged “Test” and left out of the Overview’s numbers, so trying a template on yourself or your team doesn’t skew your stats. It still really sends.`;
    $('#spTestWrap').classList.toggle('suggested', Boolean(why));
  }
  $('#spTest').addEventListener('change', () => { testTouched = true; suggestTest(recipients().list.length); });
  $('#campaignName').addEventListener('input', () => suggestTest(recipients().list.length));

  function renderSummary() {
    Draft.save();
    const { list, skip, sheets } = recipients();
    const count = list.length;
    suggestTest(count);
    const nums = state.selectedSenders.size;
    const t = currentTemplate();
    const emptyFixed = t?.variables.find((v) => { const m = SP.mapping[v.key]; return !m || (m.type === 'fixed' && !String(m.value).trim()); });
    const missing = Object.entries(skip.missing);
    const missLabel = (key) => { const v = t?.variables.find((x) => x.key === key); return v ? (v.media ? v.media + ' URL' : `{{${v.name}}}`) : key; };

    // A link typed (or in a column) without https://, or a broken one, would reach people untappable: stop here.
    let badLink = '';
    if (t) for (const r of list) {
      const vals = valuesFor(r.obj);
      for (const v of t.variables) {
        const bad = linkProblem(vals[v.key], Boolean(v.media) || /^button/.test(v.where));
        if (bad) { badLink = `${v.media ? `Header ${v.media} link` : /^button/.test(v.where) ? 'Button link' : `{{${v.name}}}`} ${bad}${SP.mapping[v.key]?.type === 'column' ? ` (row with +${r.obj.__phone})` : ''}`; break; }
      }
      if (badLink) break;
    }
    const why =
      !SP.sheets.length ? 'Open a contact list' :
        !sheets ? 'Tick at least one sheet tab to send to' :
          !count && !missing.length ? 'No rows to send: tick rows that have a valid number' :
            !t ? 'Choose a template in the Message panel' :
              !nums ? 'Turn on at least one sender number' :
                emptyFixed ? `Fill in ${missLabel(emptyFixed.key)} in the Message panel` :
                  badLink ? badLink :
                    !count ? `Every row is missing a value for ${missLabel(missing[0][0])}` :
                      window.Credits?.short(t, count) || ''; // not enough credits (billing.js)

    const notes = [
      sheets > 1 ? `from ${sheets} sheets` : '',
      skip.invalid ? `${skip.invalid.toLocaleString()} invalid` : '',
      skip.duplicate ? `${skip.duplicate.toLocaleString()} duplicate${skip.duplicate > 1 ? 's' : ''} skipped` : '',
      skip.unticked ? `${skip.unticked.toLocaleString()} left out` : '',
      skip.filtered ? `${skip.filtered.toLocaleString()} hidden by filters` : '',
      ...missing.map(([k, n]) => `${n.toLocaleString()} with no ${missLabel(k)}`),
    ].filter(Boolean).join(' · ');
    const detail = [nums ? `${nums} number${nums === 1 ? '' : 's'} · ~${Math.ceil(count / Math.max(1, nums)).toLocaleString()} each` : '', t ? `template ${esc(t.name)}` : '', window.Credits?.costText(t, count) || ''].filter(Boolean).join(' · ');

    $('#sendSummary').innerHTML = `<strong>${count.toLocaleString()} recipient${count === 1 ? '' : 's'}</strong>${notes ? ` <span class="sp-notes">${esc(notes)}</span>` : ''}
      <div>${why ? `<span class="why">${esc(why)}</span>` : detail}</div>`;
    const scheduled = state.sendMode === 'schedule';
    // On Setup, with a template chosen, this button is the way on to Personalise (sending isn't possible before the
    // variables are filled in anyway); on Personalise it sends.
    const next = Boolean(t) && SP.pane !== 'preview';
    $('#sendAll').classList.toggle('sp-go-next', next);
    if (next) {
      $('#sendAll').innerHTML = `${t.variables.length ? 'Next: Personalise' : 'Next: Preview'}${icon('arrow-right', 17)}`;
      $('#sendAll').disabled = false;
      $('#sendAll').title = t.variables.length ? 'Fill in the template’s variables and preview the message' : 'Preview the message';
      return;
    }
    $('#sendAll').title = '';
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
      // choosing Later goes straight to picking the date and time (a real click, not a page restoring a draft)
      if (e.isTrusted) requestAnimationFrame(() => input._dt?.click());
    }
    renderSummary();
  });

  // Send a test (under the preview): to your own number (remembered), or to the person shown in the preview, with
  // their values: exactly the message they'd get.
  let myTestPhone = '';
  try { myTestPhone = localStorage.getItem('testPhone') || ''; } catch { }
  let testWho = 'me';
  const leadOf = () => {
    const x = previewTarget();
    if (!x?.obj?.__phone) return null;
    const nameKey = Object.keys(x.obj).find((k) => /^(full[ _-]?)?name$|^name\b|contact name|customer/i.test(k)) || Object.keys(x.obj).find((k) => /name/i.test(k) && !/company|business|file|user ?name/i.test(k));
    return { phone: x.obj.__phone, name: nameKey ? x.obj[nameKey] : '' };
  };
  function renderTest() {
    const t = currentTemplate(), lead = leadOf(), input = $('#testPhone');
    $$('#testWho button').forEach((b) => {
      const on = b.dataset.who === testWho;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      if (b.dataset.who === 'lead') b.disabled = !lead;
    });
    Motion.segs($('#testPop'));
    if (testWho === 'lead' && lead) {
      input.value = '+' + lead.phone;
      input.readOnly = true;
      $('#testNote').innerHTML = !t ? 'Choose a template first (Setup).' : `Sends “${esc(t.name)}” to <b>${esc(lead.name || '+' + lead.phone)}</b> with their values, from the first number you turned on. <span class="sp-test-real">This is a real message to them.</span>`;
    } else {
      input.readOnly = false;
      if (input.value.startsWith('+') && lead && input.value === '+' + lead.phone) input.value = myTestPhone;
      if (!input.value) input.value = myTestPhone;
      $('#testNote').textContent = t ? `Sends “${t.name}” as the person in the preview would get it, from the first number you turned on.` : 'Choose a template first (Setup).';
    }
  }
  const closeTest = () => { $('#testPop').classList.add('hidden'); $('#spPrevTest').setAttribute('aria-expanded', 'false'); };
  $('#spPrevTest').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $('#testPop').classList.toggle('hidden') === false;
    $('#spPrevTest').setAttribute('aria-expanded', String(open));
    if (open) { renderTest(); if (testWho === 'me') $('#testPhone').focus(); else $('#testSend').focus(); }
  });
  $('#testWho').addEventListener('click', (e) => {
    const b = e.target.closest('[data-who]');
    if (!b || b.disabled) return;
    if (testWho === 'me') myTestPhone = $('#testPhone').value;
    testWho = b.dataset.who;
    renderTest();
  });
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
      if (testWho === 'me') { myTestPhone = phone; try { localStorage.setItem('testPhone', phone); } catch { } }
      const r = await api('/send/test', { method: 'POST', body: { senderId, templateId: t.id, phone, values } });
      toast(`${r.demo ? '(Demo) ' : ''}Test sent to +${r.to}${empty.length ? ` · ${empty.length} empty variable${empty.length > 1 ? 's' : ''} sent as “test”` : ''}`);
      closeTest();
    }, e.target)
  );

  // The numbers it sends from, as the confirmation shows them (photo, name, number).
  function fromHtml() {
    const list = state.senders.filter((x) => state.selectedSenders.has(x.id));
    return `<div class="cf-from"><span class="cf-from-l">From</span>${list.map((x) => `<span class="cf-num">${senderPhotoHtml(x)}<span><b>${esc(x.verifiedName || x.label)}</b><small>${esc(x.displayPhone || '')}</small></span></span>`).join('')}</div>`;
  }
  $('#sendAll').addEventListener('click', (e) => {
    if (e.currentTarget.classList.contains('sp-go-next')) {
      if (!SP.panel) { SP.panel = true; try { localStorage.setItem('sendPanel', '1'); } catch { } renderChrome(); }
      return setPane('preview');
    }
    return guard(async () => {
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
        message: `${fromHtml()}Template <strong>${esc(t.name)}</strong> from ${nums} number${nums === 1 ? '' : 's'}${sheets > 1 ? `, to rows from ${sheets} sheets` : ''}${scheduledAt ? `, on <strong>${esc(new Date(scheduledAt).toLocaleString())}</strong>` : ''}.<br><br>${demo ? 'Demo mode: sending is simulated.' : '<strong>Live:</strong> real WhatsApp messages will be sent.'}${window.Credits?.confirmText(t, list.length) || ''}`,
        confirmText: scheduledAt ? 'Schedule' : 'Send now',
        check: demo ? '' : 'These people agreed to get WhatsApp messages from my business, and can reply STOP to opt out.',
        safe: true,
      });
      if (!ok) return;
      const c = await api('/campaigns', {
        method: 'POST',
        // "Send now" waits 5 seconds on the server, so it can be undone (it still goes if this page is closed)
        body: { draftId: SP.campaign?.id, name: $('#campaignName').value.trim(), templateId: t.id, senderIds: [...state.selectedSenders], rows: list.map((x) => x.obj), phoneColumn: '__phone', mapping: SP.mapping, scheduledAt, consent: true, test: $('#spTest').checked, ...(scheduledAt ? {} : { hold: 5 }) },
      });
      if (!scheduledAt && !(await undoToast({ title: `Sending ${c.total.toLocaleString()} message${c.total === 1 ? '' : 's'}`, msg: t.name }))) {
        try {
          await api(`/campaigns/${c.id}/undo`, { method: 'POST' });
          return toast('Nothing was sent', '', { title: 'Undone', icon: 'undo-2' });
        } catch (err) { toast(err.message, 'error'); } // too late: it's sending, so show it
      }
      resetAfterSend(); // it went: the next campaign starts from a clean page, so nobody wonders whether this one was sent
      if (state.tab !== 'send') { // moved on during the countdown: don't pull them back
        return toast(scheduledAt ? 'Campaign scheduled' : `Campaign started — ${c.total} messages`, '', { onClick: () => { showTab('campaigns'); openCampaign(c.id); } });
      }
      toast(scheduledAt ? `Scheduled ${c.total} messages for ${new Date(scheduledAt).toLocaleString()}` : `Campaign started — ${c.total} messages queued`);
      showTab('campaigns');
      openCampaign(c.id);
    }, e.target);
  });

  // After a campaign is created: empty the page (lists, template, name, schedule, test flag) and drop the saved
  // draft. The chosen sender numbers stay, since the next campaign usually goes out from the same ones.
  function resetAfterSend({ keepCampaign = false } = {}) {
    const sentId = SP.campaign?.id;
    if (!keepCampaign) { Draft.flush(); SP.campaign = null; if (sentId) Draft.drop(sentId); }
    SP.sheets = [];
    SP.mapping = {};
    grid.clearHistory();
    if (!keepCampaign) { $('#templateSelect').value = ''; $('#campaignName').value = ''; }
    $('#scheduleAt').value = '';
    $('#sendMode [data-mode=now]')?.click();
    $('#spTest').checked = false;
    testTouched = false;
    closeTest();
    setPane('compose');
    if (keepCampaign) onTemplateChange();
    activate(-1);
    Draft.save(); // an empty page deletes the stored draft
  }
  // The toolbar's Start over: the same clean page, on purpose (asks first; the files on the computer aren't touched).
  $('#spReset').addEventListener('click', async () => {
    const n = SP.sheets.length;
    const ok = await confirmDialog({
      title: 'Start over?',
      message: `This closes ${n === 1 ? 'the sheet' : `all ${n} sheets`} and clears the variables and schedule. The campaign keeps its name, template and AI settings. Your original files and saved Contacts aren't changed.`,
      confirmText: 'Start over', danger: true,
    });
    if (!ok) return;
    resetAfterSend({ keepCampaign: Boolean(SP.campaign) });
    toast('Cleared. Ready for a new campaign');
  });

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
  // From the campaigns calendar's "Schedule a campaign": the Send page, set to send later on that day (10 AM, or
  // half an hour from now when that's later), with the picker open to adjust it.
  window.scheduleOn = (k) => window.CampaignSetup.create({ then: () => scheduleFor(k) });
  function scheduleFor(k) {
    const [y, m, d] = k.split('-').map(Number);
    let when = new Date(y, m - 1, d, 10, 0);
    const soon = new Date(Date.now() + 30 * 60000);
    soon.setMinutes(Math.ceil(soon.getMinutes() / 15) * 15, 0, 0);
    if (when < soon) when = soon;
    $('#scheduleAt').value = toLocalInput(when);
    $('#sendMode [data-mode=schedule]').click();
    toast(`Set to send later: ${when.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}. Now add the people to send to.`, '', { icon: 'clock' });
  }
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
  function openRecipients(list, opts) {
    window.CampaignSetup.create({ name: opts.label, templateId: opts.templateId, then: () => addRecipients(list, opts) });
  }
  function addRecipients(list, { label, templateId }) {
    const t = state.templates.find((x) => x.id === templateId);
    const vars = t?.variables || [];
    const headers = ['phone', 'name', ...vars.map(varLabel)];
    const rows = list.map((r) => ['+' + r.phone, r.name || '', ...vars.map((v) => r.values?.[v.key] ?? '')]);
    SP.sheets.push(makeSheet({ name: label, file: '', headers, rows }));
    showTab('send');
    activate(SP.sheets.length - 1);
    if (t && SP.campaign?.templateId === t.id) {
      SP.mapping = Object.fromEntries(vars.map((v) => [v.key, { type: 'column', value: varLabel(v) }]));
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
    // one draft per campaign; 'ws:<id>' is the single draft from before campaigns were set up first (legacy)
    const legacyKey = () => 'ws:' + (state.me?.workspace?.id || 'default');
    const keyOf = (cid) => legacyKey() + ':c:' + cid;
    const key = () => (SP.campaign ? keyOf(SP.campaign.id) : null);
    // Only what's needed to rebuild; checks (st/phone) and views are worked out again.
    const pack = () => ({
      v: 1, savedAt: Date.now(), active: SP.active, mapping: SP.mapping,
      sheets: SP.sheets.map((sh) => ({
        name: sh.name, file: sh.file, headers: sh.headers, widths: sh.widths, wraps: sh.wraps, phoneName: sh.phoneName, included: sh.included, dirty: sh.dirty,
        rows: sh.rows.map((r) => (r.pick?.length ? [r.cells, r.on ? 1 : 0, r.pick] : [r.cells, r.on ? 1 : 0])),
        filters: Object.fromEntries(Object.entries(sh.filters || {}).map(([c, x]) => [c, { text: x.text || '', values: x.values ? [...x.values] : null }])),
      })),
      templateId: $('#templateSelect').value, senders: [...state.selectedSenders], name: $('#campaignName').value,
      mode: state.sendMode, at: $('#scheduleAt').value,
    });
    let pending = null; // the key a save is waiting to write
    const write = () => {
      const k = pending;
      pending = null;
      if (!k || k !== key()) return; // (the campaign changed: flush() wrote it already)
      const data = pack();
      const empty = !data.sheets.length;
      tx('readwrite', (st) => (empty ? st.delete(k) : st.put(data, k))).catch(() => { });
    };
    function save() {
      if (!ready || restoring || !key()) return;
      clearTimeout(timer);
      pending = key();
      timer = setTimeout(write, 500);
    }
    // Write a waiting save now (before switching to another campaign).
    function flush() { clearTimeout(timer); if (pending) write(); }
    const drop = (cid) => tx('readwrite', (st) => st.delete(keyOf(cid))).catch(() => { });
    // The open campaign's sheets and settings, as it was left in this browser.
    async function restore() {
      let d = null;
      ready = true;
      clearTimeout(timer); pending = null; // (an empty page drawn while opening must not overwrite what's stored)
      if (!key()) return false;
      try {
        d = await tx('readonly', (st) => st.get(key()));
        // the old Send page's single draft (from before campaigns were set up first): a new campaign starts empty, so drop it
        if (!d) tx('readwrite', (st) => st.delete(legacyKey())).catch(() => { });
      } catch { /* private window etc.: start fresh */ }
      if (!d || d.v !== 1) return false;
      restoring = true;
      try {
        SP.sheets = d.sheets.map((x) => {
          const sh = {
            id: nextId++, name: x.name, file: x.file, headers: x.headers, widths: x.widths, wraps: x.wraps || [], phoneName: x.phoneName, included: x.included, dirty: x.dirty,
            rows: x.rows.map(([cells, on, pick]) => ({ cells, on: Boolean(on), ...(pick ? { pick } : {}) })),
            filters: Object.fromEntries(Object.entries(x.filters || {}).map(([c, f]) => [c, { text: f.text, ...(f.values ? { values: new Set(f.values) } : {}) }]))
          };
          recheck(sh);
          return sh;
        });
        SP.mapping = d.mapping || {};
        if (d.mode === 'schedule' && d.at && new Date(d.at) > Date.now()) { $('#scheduleAt').value = d.at; $('#sendMode [data-mode=schedule]')?.click(); }
        onTemplateChange();
        activate(Math.min(Math.max(0, d.active), SP.sheets.length - 1));
      } finally { restoring = false; }
      return SP.sheets.length > 0;
    }
    const clear = () => tx('readwrite', (st) => st.clear()).catch(() => { });
    return { save, restore, clear, flush, drop };
  })();
  $('#scheduleAt').addEventListener('change', () => Draft.save());
  // Logging out: don't leave anyone's contact lists in this browser.
  document.addEventListener('click', (e) => { if (e.target.closest('a[href="/logout"]')) Draft.clear(); }, true);

  // Open the page for a draft campaign: its own sheets and settings (another one's are saved first).
  async function openDraftPage(d, { show = true } = {}) {
    if (SP.campaign?.id !== d.id) {
      Draft.flush();
      SP.campaign = null; // (so clearing the page doesn't touch the other campaign's saved draft)
      SP.sheets = [];
      SP.mapping = {};
      grid.clearHistory();
      $('#scheduleAt').value = '';
      $('#sendMode [data-mode=now]')?.click();
      $('#spTest').checked = false;
      testTouched = false;
      closeTest();
      setPane('compose');
      useCampaign(d);
      activate(-1);
      await Draft.restore();
    } else useCampaign(d);
    if (show) showTab('send');
  }
  // New campaign first, then this (people from Contacts, a sheet the Assistant made): a page always sends one campaign.
  const thenNew = (fn, opts = {}) => window.CampaignSetup.create({ ...opts, then: fn });

  window.SendPage = {
    // At start-up: /send?c=<draft> opens that draft again (a sent one shows on Campaigns).
    async restoreDraft() {
      const cid = location.pathname.replace(/\/+$/, '') === '/send' && new URLSearchParams(location.search).get('c');
      if (!cid) return false;
      try { await openDraftPage(await api('/drafts/' + cid), { show: false }); return true; } catch { history.replaceState({ tab: 'campaigns' }, '', '/campaigns?c=' + encodeURIComponent(cid)); return false; }
    },
    openCampaign: openDraftPage,
    campaignId: () => SP.campaign?.id || null,
    // A draft was deleted: drop its saved sheets (and leave its page if it's open).
    forgetCampaign(cid) {
      Draft.drop(cid);
      if (SP.campaign?.id !== cid) return;
      SP.campaign = null;
      resetAfterSend();
      if (state.tab === 'send') showTab('campaigns');
    },
    refresh: () => renderSummary(), // e.g. when the credit balance changes (billing.js)
    readWorkbook,
    toTable,
    openContacts: (list, label) => thenNew(() => openContacts(list, label)),
    openRecipients,
    // A finished table (e.g. one the Assistant built) as a new tab, with its phone column set.
    openSheet(name, headers, rows, phoneName) {
      thenNew(() => {
        const sh = makeSheet({ name, file: '', headers, rows });
        if (phoneName && headers.includes(phoneName)) { sh.phoneName = phoneName; recheck(sh); }
        SP.sheets.push(sh);
        activate(SP.sheets.length - 1);
      });
    },
    loadXlsx: () => loadXlsxLib(),
    show() { fitSend(); renderChrome(); if (current()) grid.focus(); },
    // The default country code changes which numbers are valid.
    recheck() { SP.sheets.forEach(recheck); if (current()) grid.redraw(); renderChrome(); },
  };
  renderChrome();
})();
