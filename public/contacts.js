// Contacts page: the address book. Search, filter by tag and status, tag people in bulk,
// edit a contact, import from Excel / CSV (every sheet, merged by phone number) and export.
// Uses helpers from app.js and send.js (SendPage.readWorkbook / toTable / openContacts).

(function () {
  const CT = { contacts: [], tags: [], counts: {}, q: '', tag: '', status: '', page: 0, selected: new Set(), chats: new Map(), loaded: false };
  const PAGE = 100;
  const STATUS = {
    new: { label: 'New', cls: '' },
    interested: { label: 'Interested', cls: 'sent' },
    qualified: { label: 'Qualified', cls: 'scheduled' },
    won: { label: 'Won', cls: 'delivered' },
    lost: { label: 'Not interested', cls: 'cancelled' },
  };
  const COLORS = ['blue', 'green', 'violet', 'orange', 'teal', 'pink', 'gray'];
  const tagById = (id) => CT.tags.find((t) => t.id === id);
  const fmtPhone = (p) => { const m = /^91(\d{5})(\d{5})$/.exec(p); return m ? `+91 ${m[1]} ${m[2]}` : '+' + p; };
  const tagChip = (t, extra = '') => `<span class="tag-chip tag-${esc(t.color)}" title="${esc(t.name)}" ${extra}>${esc(t.name)}</span>`;

  async function load() {
    const [r, inbox] = await Promise.all([api('/contacts'), api('/inbox').catch(() => ({ conversations: [] }))]);
    Object.assign(CT, { contacts: r.contacts, tags: r.tags, counts: r.counts, loaded: true });
    state.contactTags = r.tags;
    CT.chats = new Map(inbox.conversations.map((c) => [c.wa, c.key]));
    for (const id of [...CT.selected]) if (!CT.contacts.some((c) => c.id === id)) CT.selected.delete(id);
  }

  // --- List ---------------------------------------------------------------

  function filtered() {
    const q = CT.q.toLowerCase();
    return CT.contacts
      .filter((c) => {
        if (CT.tag === 'none' ? c.tags.length : CT.tag && !c.tags.includes(CT.tag)) return false;
        if (CT.status === 'optout' ? !c.optOut : CT.status && c.status !== CT.status) return false;
        if (q && ![c.name, c.phone, fmtPhone(c.phone), c.email, c.company, c.lead?.summary].some((v) => String(v || '').toLowerCase().includes(q))) return false;
        return true;
      })
      .sort(compare);
  }

  // --- Sorting -------------------------------------------------------------------
  // key → [label, default direction, value(c)]. Contacts with no value (no tag, no company,
  // never messaged) always sort last, whichever way you sort.
  const STATUS_RANK = { new: 0, interested: 1, qualified: 2, won: 3, lost: 4 };
  const firstTag = (c) => c.tags.map(tagById).filter(Boolean).map((t) => t.name).sort((a, b) => a.localeCompare(b))[0] || '';
  const SORTS = {
    name: ['Name', 'asc', (c) => (c.name || '').trim() && letterOf(c) !== '#' ? nameOf(c) : ''],
    added: ['Date added', 'desc', (c) => c.createdAt || ''],
    message: ['Last message', 'desc', (c) => c.lastMessageAt || ''],
    status: ['Status', 'asc', (c) => (c.optOut ? 5 : STATUS_RANK[c.status] ?? 0)],
    tags: ['Tags', 'asc', firstTag],
    lead: ['Lead', 'desc', (c) => (c.lead?.summary ? c.lead.updatedAt || '1' : '')],
    company: ['Company', 'asc', (c) => (c.company || '').trim()],
  };
  const sortPref = () => { try { const [k, d] = (localStorage.getItem('ctSort') || '').split(':'); return SORTS[k] ? { key: k, dir: d === 'desc' ? 'desc' : 'asc' } : null; } catch { return null; } };
  CT.sort = sortPref() || { key: 'name', dir: 'asc' };
  function setSort(key, dir) {
    CT.sort = { key, dir: dir || SORTS[key][1] };
    try { localStorage.setItem('ctSort', `${key}:${CT.sort.dir}`); } catch {}
    CT.page = 0;
    CT.enter = true;
    render();
  }
  function compare(a, b) {
    const val = SORTS[CT.sort.key][2];
    const x = val(a), y = val(b);
    const blank = (v) => v === '' || v == null;
    if (blank(x) !== blank(y)) return blank(x) ? 1 : -1;
    const d = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { sensitivity: 'base', numeric: true });
    return (CT.sort.dir === 'desc' ? -d : d) || nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' });
  }
  // Card view sections follow the sort: letters for names, otherwise the value itself.
  function dateBucket(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((day(now) - day(d)) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return 'This week';
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 'Earlier this month';
    return d.toLocaleDateString('en-IN', { month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }
  function groupOf(c) {
    switch (CT.sort.key) {
      case 'name': return letterOf(c);
      case 'added': return dateBucket(c.createdAt) || 'Date unknown';
      case 'message': return dateBucket(c.lastMessageAt) || 'No messages yet';
      case 'status': return c.optOut ? 'Opted out' : STATUS[c.status]?.label || 'New';
      case 'tags': return firstTag(c) || 'No tag';
      case 'lead': return c.lead?.summary ? 'With lead notes' : 'No lead notes yet';
      case 'company': return (c.company || '').trim() || 'No company';
    }
  }

  const viewPref = () => { try { return localStorage.getItem('ctView') || 'cards'; } catch { return 'cards'; } };
  CT.view = viewPref();
  CT.openId = null;

  // Avatars: initials on a colour picked from the name, like a phone's contacts app.
  const nameOf = (c) => c.name || fmtPhone(c.phone);
  function avatar(c, cls = '') {
    const key = c.name || c.phone;
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const parts = (c.name || '').trim().split(/\s+/).filter(Boolean);
    const text = parts.length ? esc((parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()) : icon('users', 18);
    return `<span class="ct-av ${cls}" style="--av:var(--file-${(h % 6) + 1})">${text}</span>`;
  }
  const statusPill = (c) => (c.optOut ? '<span class="pill failed">Opted out</span>' : `<span class="pill ${STATUS[c.status]?.cls || ''}">${esc(STATUS[c.status]?.label || c.status)}</span>`);
  const letterOf = (c) => { const ch = (c.name || '').trim()[0]?.toUpperCase() || '#'; return /[A-Z]/.test(ch) ? ch : '#'; };
  const STATS = [['', 'All', () => true], ...Object.entries(STATUS).map(([k, v]) => [k, v.label, (c) => !c.optOut && c.status === k]), ['optout', 'Opted out', (c) => c.optOut]];

  function render() {
    let list = filtered();
    // The grid reads like a phone's address book, A to Z; the table puts recent activity first.
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    CT.page = Math.min(CT.page, pages - 1);
    const slice = list.slice(CT.page * PAGE, CT.page * PAGE + PAGE);
    CT.slice = slice;
    const opted = CT.contacts.filter((c) => c.optOut).length;
    $('#ctSub').textContent = `${CT.contacts.length.toLocaleString()} contact${CT.contacts.length === 1 ? '' : 's'}${opted ? ` · ${opted} opted out` : ''}`;

    Motion.patch($('#ctStats'), STATS.map(([k, label, fn]) => {
      const n = CT.contacts.filter(fn).length;
      return `<button type="button" class="ct-stat ${CT.status === k ? 'active' : ''} ${k ? 'st-' + k : ''}" data-status="${k}"><span>${label}</span><b>${n.toLocaleString()}</b></button>`;
    }).join(''));

    const untagged = CT.contacts.filter((c) => !c.tags.length).length;
    Motion.patch($('#ctTags'), `
      <button type="button" class="ct-tag ${!CT.tag ? 'active' : ''}" data-tag="">All tags</button>
      ${CT.tags.map((t) => `<button type="button" class="ct-tag tag-${esc(t.color)} ${CT.tag === t.id ? 'active' : ''}" data-tag="${t.id}" title="${esc(t.name)}"><i></i><span class="ct-tag-name">${esc(t.name)}</span> <span>${(CT.counts[t.id] || 0).toLocaleString()}</span><b class="ct-tag-edit" data-edit-tag="${t.id}" title="Rename, recolour or delete" role="button" aria-label="Edit ${esc(t.name)}">⋯</b></button>`).join('')}
      ${untagged && CT.tags.length ? `<button type="button" class="ct-tag ${CT.tag === 'none' ? 'active' : ''}" data-tag="none">No tag <span>${untagged.toLocaleString()}</span></button>` : ''}
      <button type="button" class="ct-tag ct-tag-new" id="ctNewTag">${icon('plus', 13)} New tag</button>`);

    // Patched, not replaced, so the switcher's thumb slides between Cards and Table.
    Motion.patch($('#ctView'), [['cards', 'Cards', 'layout-grid'], ['table', 'Table', 'list']].map(([k, label, ic]) =>
      `<button data-view="${k}" class="${CT.view === k ? 'active' : ''}" title="${label}" aria-label="${label}" aria-checked="${CT.view === k}" role="radio">${icon(ic, 15)}</button>`).join(''));

    const empty = CT.contacts.length
      ? emptyState({ icon: 'search', title: 'No contacts match', text: 'Try another search, tag or status.', actions: '<button class="btn" data-empty="clear">Clear filters</button>' })
      : emptyState({ icon: 'users', title: 'No contacts yet', text: 'Import a spreadsheet or add someone by hand. People who message you on WhatsApp appear here too.', actions: '<button class="btn" data-empty="import" data-icon="upload">Import</button><button class="btn primary" data-empty="add" data-icon="plus">Add contact</button>' });
    const box = $('#ctList');
    box.innerHTML = CT.view === 'cards' ? gridHtml(slice, empty) : tableHtml(slice, empty);
    box.classList.toggle('ct-scroll-grid', CT.view === 'cards');
    // After a filter or search, the results fade up in a quick stagger.
    if (CT.enter && !Motion.reduce()) {
      box.classList.remove('ct-enter');
      void box.offsetWidth;
      box.classList.add('ct-enter');
      clearTimeout(box.__enterT);
      box.__enterT = setTimeout(() => box.classList.remove('ct-enter'), 900);
    }
    CT.enter = false;
    placeAz();

    $('#ctFoot').innerHTML = list.length > PAGE
      ? `<span>${(CT.page * PAGE + 1).toLocaleString()}–${Math.min(list.length, CT.page * PAGE + PAGE).toLocaleString()} of ${list.length.toLocaleString()}</span>
         <div class="seg"><button data-page="-1" ${CT.page ? '' : 'disabled'}>‹</button><span>Page ${CT.page + 1} / ${pages}</span><button data-page="1" ${CT.page < pages - 1 ? '' : 'disabled'}>›</button></div>`
      : `<span>${list.length.toLocaleString()} shown</span>`;
    renderSelection(list);
    renderSelectAll(list);
    renderSortMenu();
    renderPanel();
    LA.hydrate($('#tab-contacts'));
  }

  function tableHtml(slice, empty) {
    const allOn = slice.length && slice.every((c) => CT.selected.has(c.id));
    return `<table class="data-table ct-table"><thead><tr class="heads"><th class="sel"><input type="checkbox" class="cb" id="ctAll" ${allOn ? 'checked' : ''} aria-label="Select all shown" /></th>${[['name', 'Name', ''], ['company', 'Company', 'ct-c-co'], ['tags', 'Tags', ''], ['status', 'Status', ''], ['lead', 'Lead', 'ct-c-lead'], ['message', 'Last message', 'ct-c-last']].map(([k, label, cls]) => {
      const on = CT.sort.key === k;
      return `<th class="${cls} ct-sortable ${on ? 'on' : ''}" aria-sort="${on ? (CT.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${k}" title="Sort by ${label.toLowerCase()}">${label}<i class="ct-arrow ${on ? CT.sort.dir : ''}" aria-hidden="true"></i></button></th>`;
    }).join('')}</tr></thead><tbody>
      ${slice.length
        ? slice.map((c, i) => `<tr data-id="${c.id}" style="--vt:ct-${c.id};--i:${i}" class="${CT.selected.has(c.id) ? 'selected' : ''} ${c.optOut ? 'ct-opted' : ''} ${CT.openId === c.id ? 'open' : ''}">
          <td class="sel"><input type="checkbox" class="cb" ${CT.selected.has(c.id) ? 'checked' : ''} aria-label="Select ${esc(nameOf(c))}" /></td>
          <td><div class="ct-who">${avatar(c, 'sm')}<div class="ct-name"><b>${esc(nameOf(c))}</b><span>${c.name ? esc(fmtPhone(c.phone)) : ''}${c.email ? `${c.name ? ' · ' : ''}${esc(c.email)}` : ''}</span></div></div></td>
          <td class="ct-c-co">${esc(c.company || '')}</td>
          <td><div class="ct-chips">${c.tags.map(tagById).filter(Boolean).map((t) => tagChip(t)).join('')}</div></td>
          <td>${statusPill(c)}</td>
          <td class="ct-lead ct-c-lead" title="${esc(c.lead?.summary || '')}">${esc(c.lead?.summary || '')}</td>
          <td class="muted ct-c-last">${c.lastMessageAt ? relTime(c.lastMessageAt) : '—'}</td>
        </tr>`).join('')
        : `<tr><td colspan="7" class="ct-empty">${empty}</td></tr>`}</tbody></table>`;
  }

  // Phone-style address book: letter sections, round avatars, and an A–Z rail to jump.
  function gridHtml(slice, empty) {
    if (!slice.length) return `<div class="ct-empty">${empty}</div>`;
    const groups = new Map();
    for (const c of slice) { const l = groupOf(c); if (!groups.has(l)) groups.set(l, []); groups.get(l).push(c); }
    const byName = CT.sort.key === 'name';
    let n = 0;
    const card = (c) => `<div class="ct-person ${CT.selected.has(c.id) ? 'selected' : ''} ${c.optOut ? 'ct-opted' : ''} ${CT.openId === c.id ? 'open' : ''}" data-id="${c.id}" style="--vt:ct-${c.id};--i:${n++}" role="button" tabindex="0" aria-label="${esc(nameOf(c))}">
        <label class="ct-pcheck" title="Select"><input type="checkbox" class="cb" ${CT.selected.has(c.id) ? 'checked' : ''} aria-label="Select ${esc(nameOf(c))}" /></label>
        ${avatar(c, 'lg')}
        <b>${esc(nameOf(c))}</b>
        <span class="ct-psub">${esc(c.company || (c.name ? fmtPhone(c.phone) : c.email || ''))}</span>
        <span class="ct-pmeta">${statusPill(c)}${c.tags.map(tagById).filter(Boolean).slice(0, 3).map((t) => `<i class="tag-${esc(t.color)}" title="${esc(t.name)}"></i>`).join('')}</span>
      </div>`;
    const first = groups.keys().next().value;
    // A–Z index down the right, like a phone's contacts: tap or drag along it to jump.
    return `<div class="ct-book">
        ${[...groups].map(([l, list], i) => `<section class="ct-letter" data-letter="${byName ? l : 'g' + i}"><h3>${esc(l)}${byName ? '' : ` <span>${list.length.toLocaleString()}</span>`}</h3><div class="ct-grid">${list.map(card).join('')}</div></section>`).join('')}
      </div>
      ${byName && groups.size > 1 ? `<nav class="ct-az" aria-label="Jump to letter"><i class="ct-az-thumb" aria-hidden="true"></i>${[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'].map((l) => `<button type="button" data-jump="${l}" ${groups.has(l) ? `aria-label="Jump to ${l === '#' ? 'other' : l}"` : 'disabled aria-hidden="true"'} class="${l === first ? 'on' : ''}">${l}</button>`).join('')}<span class="ct-az-bubble" aria-hidden="true"></span></nav>` : ''}`;
  }

  function renderSelection(list = filtered()) {
    const n = CT.selected.size;
    const bar = $('#ctSel');
    bar.classList.toggle('hidden', !n);
    if (!n) return;
    const shown = list.filter((c) => CT.selected.has(c.id)).length;
    bar.innerHTML = `<b>${n.toLocaleString()} selected</b>${shown < n ? ` <span class="muted">(${n - shown} not shown)</span>` : ''}
      <span class="ct-sel-actions">
        <button class="btn sm" data-act="tag" data-icon="plus" data-icon-size="13">Add tag</button>
        <button class="btn sm" data-act="untag">Remove tag</button>
        <button class="btn sm" data-act="send" data-icon="send" data-icon-size="13">Send a message</button>
        <button class="btn sm quiet danger" data-act="delete" data-icon="delete" data-icon-size="13">Delete</button>
        <button class="btn sm quiet" data-act="clear">Clear</button>
      </span>`;
    LA.hydrate(bar);
  }

  // Sort menu in the toolbar (the table's column headers sort too).
  function renderSortMenu() {
    const opts = [['name:asc', 'Name A → Z'], ['name:desc', 'Name Z → A'], ['added:desc', 'Newest added'], ['added:asc', 'Oldest added'], ['message:desc', 'Last message'], ['status:asc', 'Status'], ['tags:asc', 'Tags'], ['lead:desc', 'Lead notes first'], ['company:asc', 'Company A → Z']];
    const cur = `${CT.sort.key}:${CT.sort.dir}`;
    const known = opts.some(([v]) => v === cur);
    const label = known ? '' : `<option value="${cur}" selected>${SORTS[CT.sort.key][0]} (${CT.sort.dir === 'asc' ? 'ascending' : 'descending'})</option>`;
    Motion.patch($('#ctSort'), label + opts.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join(''));
    $('#ctSort').value = cur;
  }
  $('#ctSort').addEventListener('change', (e) => { const [k, d] = e.target.value.split(':'); setSort(k, d); });

  // "Select all" in the toolbar: everyone the current search, tag and status show (every page).
  function renderSelectAll(list) {
    const btn = $('#ctSelAll');
    const on = list.filter((c) => CT.selected.has(c.id)).length;
    const all = list.length > 0 && on === list.length;
    btn.classList.toggle('hidden', !list.length);
    const cb = $('input', btn);
    cb.checked = all;
    cb.indeterminate = on > 0 && !all;
    $('span', btn).textContent = all ? `All selected (${list.length.toLocaleString()})` : `Select all (${list.length.toLocaleString()})`;
    btn.title = all ? 'Clear the selection' : `Select all ${list.length.toLocaleString()} shown`;
    btn.setAttribute('aria-pressed', String(all));
  }
  $('#ctSelAll').addEventListener('click', () => {
    const list = filtered();
    const all = list.length && list.every((c) => CT.selected.has(c.id));
    list.forEach((c) => (all ? CT.selected.delete(c.id) : CT.selected.add(c.id)));
    render();
  });

  function toggleSelect(id) { CT.selected.has(id) ? CT.selected.delete(id) : CT.selected.add(id); render(); }

  // Same morph as Campaigns: each contact keeps a view-transition name in both views.
  function morph(swap) {
    if (!document.startViewTransition || Motion.reduce()) return swap();
    const root = document.documentElement;
    root.classList.add('vt-ct');
    document.startViewTransition(swap).finished.finally(() => root.classList.remove('vt-ct'));
  }

  let searchT;
  $('#ctSearch').addEventListener('input', (e) => { clearTimeout(searchT); searchT = setTimeout(() => { CT.q = e.target.value.trim(); CT.page = 0; CT.enter = true; render(); }, 120); });
  $('#ctStats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (b && b.dataset.status !== CT.status) { CT.status = b.dataset.status; CT.page = 0; CT.enter = true; render(); }
  });
  $('#ctView').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b || b.dataset.view === CT.view) return;
    try { localStorage.setItem('ctView', b.dataset.view); } catch {}
    morph(() => { CT.view = b.dataset.view; render(); });
  });
  $('#ctTags').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit-tag]');
    if (edit) { e.stopPropagation(); return tagModal(tagById(edit.dataset.editTag)); }
    if (e.target.closest('#ctNewTag')) return tagModal(null);
    const b = e.target.closest('[data-tag]');
    if (b && b.dataset.tag !== CT.tag) { CT.tag = b.dataset.tag; CT.page = 0; CT.enter = true; render(); }
  });
  $('#ctFoot').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (b) { CT.page += Number(b.dataset.page); CT.enter = true; render(); toListTop(); }
  });
  $('#ctList').addEventListener('click', (e) => {
    if (e.target.id === 'ctAll') {
      const on = e.target.checked;
      CT.slice.forEach((c) => (on ? CT.selected.add(c.id) : CT.selected.delete(c.id)));
      return render();
    }
    const emptyAct = e.target.closest('[data-empty]')?.dataset.empty;
    if (emptyAct === 'clear') { CT.q = ''; CT.tag = ''; CT.status = ''; $('#ctSearch').value = ''; CT.enter = true; return render(); }
    if (emptyAct === 'import') return importModal();
    if (emptyAct === 'add') return open(null);
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) { const k = sortBtn.dataset.sort; return setSort(k, CT.sort.key === k ? (CT.sort.dir === 'asc' ? 'desc' : 'asc') : null); }
    const jump = e.target.closest('[data-jump]');
    // Pointer taps are handled on pointerdown (so dragging works); this is the keyboard path.
    if (jump) { if (e.detail === 0) jumpTo(jump.dataset.jump, true); return; }
    const item = e.target.closest('[data-id]');
    if (!item) return;
    if (e.target.closest('td.sel, .ct-pcheck')) { e.preventDefault(); return toggleSelect(item.dataset.id); }
    showPanel(item.dataset.id);
  });
  // --- A–Z index -------------------------------------------------------------------

  function jumpTo(letter, smooth) {
    const sec = $(`#ctList .ct-letter[data-letter="${letter}"]`);
    if (!sec) return;
    CT.jumpTo = letter;
    CT.jumpAt = Date.now();
    window.scrollTo({ top: sec.getBoundingClientRect().top + window.scrollY - 12, behavior: smooth && !Motion.reduce() ? 'smooth' : 'auto' });
    placeAz(letter);
  }
  // Slide the index's highlight to the current letter.
  function placeAz(letter) {
    const bar = $('#ctList .ct-az');
    if (!bar) return;
    if (letter) bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.jump === letter));
    const on = $('button.on', bar), th = $('.ct-az-thumb', bar);
    if (on && th) th.style.transform = `translateY(${on.offsetTop}px)`;
  }
  // The bubble beside the index shows which letter you're on while hovering or dragging.
  function bubble(btn) {
    const bar = btn?.closest('.ct-az'), bub = bar && $('.ct-az-bubble', bar);
    if (!bub) return;
    bub.textContent = btn.dataset.jump;
    bub.style.transform = `translateY(${btn.offsetTop + btn.offsetHeight / 2}px)`;
    bar.classList.add('peek');
  }
  const letterAt = (bar, y) => {
    let best = null, dist = Infinity;
    for (const b of bar.querySelectorAll('button:not(:disabled)')) {
      const r = b.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - y);
      if (d < dist) { dist = d; best = b; }
    }
    return best;
  };
  $('#ctList').addEventListener('pointerdown', (e) => {
    const bar = e.target.closest('.ct-az');
    if (!bar || e.button) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('scrub');
    const go = (ev, smooth) => { const b = letterAt(bar, ev.clientY); if (b && b.dataset.jump !== bar.__at) { bar.__at = b.dataset.jump; bubble(b); jumpTo(b.dataset.jump, smooth); } };
    bar.__at = null;
    go(e, true);
    const move = (ev) => go(ev, false);
    const up = () => { bar.classList.remove('scrub', 'peek'); bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up); };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });
  $('#ctList').addEventListener('pointerover', (e) => {
    const b = e.target.closest('.ct-az button:not(:disabled)');
    if (b) bubble(b);
  });
  $('#ctList').addEventListener('pointerout', (e) => {
    const bar = e.target.closest('.ct-az');
    if (bar && !bar.contains(e.relatedTarget) && !bar.classList.contains('scrub')) bar.classList.remove('peek');
  });

  // Light up the letter whose section is at the top of the list.
  function toListTop() {
    const top = $('#ctLayout').getBoundingClientRect().top + window.scrollY - 12;
    if (window.scrollY > top) window.scrollTo({ top });
  }
  window.addEventListener('scroll', () => {
    if ($('#tab-contacts').classList.contains('hidden')) return;
    const box = $('#ctList');
    const bar = $('.ct-az', box);
    if (!bar || bar.classList.contains('scrub')) return;
    const top = 72;
    let cur = null;
    for (const sec of box.querySelectorAll('.ct-letter')) { if (sec.getBoundingClientRect().top <= top) cur = sec.dataset.letter; else break; }
    cur ||= box.querySelector('.ct-letter')?.dataset.letter;
    // Near the end the page can't scroll a short section to the top; keep the letter you picked lit while it's in view.
    const picked = CT.jumpTo && $(`.ct-letter[data-letter="${CT.jumpTo}"]`, box)?.getBoundingClientRect().top;
    if (picked != null && (Date.now() - CT.jumpAt < 1200 || (picked >= 0 && picked < innerHeight / 2))) cur = CT.jumpTo;
    else CT.jumpTo = null;
    if (cur !== $('button.on', bar)?.dataset.jump) placeAz(cur);
  }, { passive: true });
  $('#ctList').addEventListener('keydown', (e) => {
    const item = e.target.closest('.ct-person[data-id]');
    if (item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showPanel(item.dataset.id); }
  });

  // --- Side panel: one contact at a glance, with quick edits -----------------------

  // The panel slides in, cross-fades when you pick someone else, and slides out on close.
  function showPanel(id) {
    if (CT.openId === id) return closePanel();
    const switching = Boolean(CT.openId);
    CT.openId = id;
    render();
    const panel = $('#ctPanel');
    panel.classList.remove('swap', 'leaving');
    if (switching && !Motion.reduce()) {
      void panel.offsetWidth;
      panel.classList.add('swap');
      clearTimeout(panel.__swapT);
      panel.__swapT = setTimeout(() => panel.classList.remove('swap'), 400);
    }
  }
  function closePanel() {
    if (!CT.openId) return;
    const panel = $('#ctPanel');
    if (Motion.reduce()) { CT.openId = null; return render(); }
    panel.classList.add('leaving');
    $('#ctLayout').classList.remove('has-panel');
    document.querySelectorAll('#ctList .open').forEach((x) => x.classList.remove('open'));
    clearTimeout(panel.__t);
    panel.__t = setTimeout(() => { panel.classList.remove('leaving'); CT.openId = null; render(); }, 300);
  }

  function renderPanel() {
    const panel = $('#ctPanel');
    const c = CT.openId && CT.contacts.find((x) => x.id === CT.openId);
    if (!c) CT.openId = null;
    panel.classList.toggle('hidden', !c);
    $('#ctLayout').classList.toggle('has-panel', Boolean(c));
    if (!c) return;
    const chatKey = CT.chats.get(c.phone);
    const lead = c.lead || {};
    const details = [['Phone', fmtPhone(c.phone)], ['Email', c.email], ['Company', c.company], ['Last message', c.lastMessageAt && relTime(c.lastMessageAt)], ['Added', c.createdAt && `${new Date(c.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}${c.source ? ` · ${c.source === 'inbox' ? 'from the Inbox' : c.source === 'import' ? 'imported' : 'added by hand'}` : ''}`], ...Object.entries(c.extra || {})].filter(([, v]) => v);
    panel.innerHTML = `
      <button type="button" class="ct-pclose" id="ctPClose" title="Close" aria-label="Close">${icon('x', 16)}</button>
      <div class="ct-phead">
        ${avatar(c, 'xl')}
        <h2>${esc(nameOf(c))}</h2>
        <p>${esc([c.name ? fmtPhone(c.phone) : '', c.company].filter(Boolean).join(' · '))}</p>
      </div>
      <div class="ct-pacts">
        <button type="button" class="ct-pact" data-pact="send" ${c.optOut ? 'disabled title="Opted out"' : ''}>${icon('send', 17)}<span>Message</span></button>
        <button type="button" class="ct-pact" data-pact="chat" ${chatKey ? '' : 'disabled title="No chat yet"'}>${icon('message-circle', 17)}<span>Chat</span></button>
        <button type="button" class="ct-pact" data-pact="edit">${icon('square-pen', 17)}<span>Edit</span></button>
        <button type="button" class="ct-pact" data-pact="delete">${icon('delete', 17)}<span>Delete</span></button>
      </div>
      <div class="ct-psec">
        <div class="field-label">Status</div>
        <div class="ct-pstatus">${Object.entries(STATUS).map(([k, v]) => `<button type="button" class="ct-tag ${c.status === k ? 'active' : ''}" data-set-status="${k}">${v.label}</button>`).join('')}</div>
        <label class="ct-poptout"><span>Opted out <span class="opt">never message them</span></span>${toggleHtml({ checked: c.optOut, attrs: 'id="ctPOpt"', size: 'sm' })}</label>
      </div>
      <div class="ct-psec">
        <div class="field-label">Tags</div>
        <div class="ct-pick">${CT.tags.map((t) => `<button type="button" class="ct-tag tag-${esc(t.color)} ${c.tags.includes(t.id) ? 'active' : ''}" data-ptag="${t.id}" title="${esc(t.name)}"><i></i><span class="ct-tag-name">${esc(t.name)}</span></button>`).join('')}<button type="button" class="ct-tag ct-tag-new" data-ptag="+">${icon('plus', 13)} New</button></div>
      </div>
      ${lead.summary || lead.need || lead.budget || lead.timeline ? `<div class="ct-leadbox"><div class="pc-label">From the lead assistant</div>
        ${lead.summary ? `<p>${esc(lead.summary)}</p>` : ''}
        <dl>${[['Need', lead.need], ['Budget', lead.budget], ['Timeline', lead.timeline]].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>` : ''}
      <div class="ct-psec"><div class="field-label">Details</div><dl class="ct-pdl">${details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>
      <label class="ct-psec ct-pnotes"><span class="field-label">Notes</span><textarea id="ctPNotes" rows="3" placeholder="Anything to remember about them">${esc(c.notes || '')}</textarea></label>`;
  }

  async function patch(c, body, msg) {
    await guard(async () => { await api('/contacts/' + c.id, { method: 'PUT', body }); await refresh(); if (msg) toast(msg); });
  }

  $('#ctPanel').addEventListener('click', async (e) => {
    const c = CT.contacts.find((x) => x.id === CT.openId);
    if (!c) return;
    if (e.target.closest('#ctPClose')) return closePanel();
    const st = e.target.closest('[data-set-status]');
    if (st && st.dataset.setStatus !== c.status) return patch(c, { status: st.dataset.setStatus });
    const tg = e.target.closest('[data-ptag]');
    if (tg) {
      if (tg.dataset.ptag === '+') return tagModal(null, (t) => patch(c, { tags: [...c.tags, t.id] }));
      const id = tg.dataset.ptag;
      return patch(c, { tags: c.tags.includes(id) ? c.tags.filter((x) => x !== id) : [...c.tags, id] });
    }
    const act = e.target.closest('[data-pact]')?.dataset.pact;
    if (act === 'send') return SendPage.openContacts([c], nameOf(c));
    if (act === 'chat') { showTab('inbox'); return window.Inbox?.open(CT.chats.get(c.phone)); }
    if (act === 'edit') return open(c.id);
    if (act === 'delete') {
      if (!(await confirmDialog({ title: 'Delete this contact?', message: 'Their chats and campaign history stay.', confirmText: 'Delete', danger: true }))) return;
      await guard(async () => { await api('/contacts/delete', { method: 'POST', body: { ids: [c.id] } }); CT.openId = null; await refresh(); });
    }
  });
  $('#ctPanel').addEventListener('change', (e) => {
    const c = CT.contacts.find((x) => x.id === CT.openId);
    if (c && e.target.id === 'ctPOpt') patch(c, { optOut: e.target.checked }, e.target.checked ? 'Opted out: they won’t be messaged' : 'They can be messaged again');
  });
  $('#ctPanel').addEventListener('focusout', (e) => {
    const c = CT.contacts.find((x) => x.id === CT.openId);
    if (c && e.target.id === 'ctPNotes' && e.target.value !== (c.notes || '')) patch(c, { notes: e.target.value }, 'Notes saved');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !CT.openId || $('#tab-contacts').classList.contains('hidden') || !$('#modal').classList.contains('hidden')) return;
    if (e.target.closest?.('input, textarea, select')) return;
    closePanel();
  });

  $('#ctSel').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const ids = [...CT.selected];
    const act = b.dataset.act;
    if (act === 'clear') { CT.selected.clear(); return render(); }
    if (act === 'send') {
      const list = CT.contacts.filter((c) => CT.selected.has(c.id) && !c.optOut);
      if (!list.length) return toast('Everyone selected has opted out', 'error');
      return SendPage.openContacts(list, `${list.length} selected contacts`);
    }
    if (act === 'delete') {
      const ok = await confirmDialog({ title: `Delete ${ids.length} contact${ids.length > 1 ? 's' : ''}?`, message: 'Their chats and campaign history stay; only the contact details and tags are removed.', confirmText: 'Delete', danger: true });
      if (!ok) return;
      return guard(async () => { await api('/contacts/delete', { method: 'POST', body: { ids } }); CT.selected.clear(); await refresh(); toast('Deleted'); });
    }
    // Add / remove a tag: pick from a menu (or make a new one when adding).
    const r = b.getBoundingClientRect();
    const items = CT.tags.map((t) => ({ label: t.name, action: () => bulkTags(ids, act === 'tag' ? { add: [t.id] } : { remove: [t.id] }) }));
    if (act === 'tag') items.push('-', { label: 'New tag…', action: () => tagModal(null, (t) => bulkTags(ids, { add: [t.id] })) });
    if (!items.length) return toast('Create a tag first', 'error');
    Sheet.Menu.open(r.left, r.bottom + 4, items);
  });

  function bulkTags(ids, body) {
    return guard(async () => {
      const r = await api('/contacts/tags', { method: 'POST', body: { ids, ...body } });
      await refresh();
      toast(`${body.add ? 'Tagged' : 'Untagged'} ${r.updated.toLocaleString()} contact${r.updated === 1 ? '' : 's'}`);
    });
  }

  async function refresh() { await load(); render(); }

  // --- Tags ------------------------------------------------------------------

  function tagModal(t, onCreate) {
    const body = openModal(t ? 'Edit tag' : 'New tag', `
      <label>Name<input id="tgName" value="${esc(t?.name || '')}" maxlength="40" placeholder="e.g. Clients, Designers, Developers" /></label>
      <div class="field-label">Colour</div>
      <div class="tg-colors">${COLORS.map((c) => `<label class="tg-color tag-${c}"><input type="radio" name="tgColor" value="${c}" ${(t?.color || COLORS[CT.tags.length % COLORS.length]) === c ? 'checked' : ''} /><i></i></label>`).join('')}</div>
      <div class="modal-actions">${t ? `<button class="btn quiet danger" id="tgDel" style="margin-right:auto">Delete tag</button>` : ''}<button class="btn quiet" id="tgCancel">Cancel</button><button class="btn primary" id="tgSave">${t ? 'Save' : 'Create tag'}</button></div>`);
    $('#tgName', body).focus();
    $('#tgCancel', body).onclick = closeModal;
    const saveIt = (e) => guard(async () => {
      const data = { name: $('#tgName', body).value, color: $('input[name=tgColor]:checked', body)?.value };
      const saved = t ? await api('/tags/' + t.id, { method: 'PUT', body: data }) : await api('/tags', { method: 'POST', body: data });
      closeModal();
      await refresh();
      onCreate?.(saved);
    }, e?.currentTarget);
    $('#tgSave', body).onclick = saveIt;
    $('#tgName', body).addEventListener('keydown', (e) => e.key === 'Enter' && saveIt());
    if (t) $('#tgDel', body).onclick = async () => {
      closeModal();
      const ok = await confirmDialog({ title: `Delete “${esc(t.name)}”?`, message: `It's removed from ${(CT.counts[t.id] || 0).toLocaleString()} contact(s). The contacts stay.`, confirmText: 'Delete', danger: true });
      if (!ok) return;
      await guard(async () => { await api('/tags/' + t.id, { method: 'DELETE' }); if (CT.tag === t.id) CT.tag = ''; await refresh(); });
    };
  }

  // --- One contact ---------------------------------------------------------------

  function open(contactId) {
    const c = contactId ? CT.contacts.find((x) => x.id === contactId) : null;
    if (contactId && !c) return toast('Contact not found', 'error');
    const chatKey = c && CT.chats.get(c.phone);
    const tags = new Set(c?.tags || []);
    const lead = c?.lead || {};
    const body = openModal(c ? c.name || fmtPhone(c.phone) : 'Add contact', `
      <form id="ctForm" class="ct-form">
        <div class="row"><label>Name<input name="name" value="${esc(c?.name || '')}" /></label>
          <label>Phone<input name="phone" value="${esc(c ? '+' + c.phone : '')}" required inputmode="tel" placeholder="98765 43210 or +91 98765 43210" /></label></div>
        <div class="row"><label>Email<input name="email" type="email" value="${esc(c?.email || '')}" /></label>
          <label>Company<input name="company" value="${esc(c?.company || '')}" /></label></div>
        <div class="row"><label>Status<select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${c?.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
          <label class="ct-optout"><span>Opted out <span class="opt">never message them</span></span>${toggleHtml({ checked: c?.optOut, attrs: 'name="optOut"', size: 'sm' })}</label></div>
        <div class="field-label">Tags</div>
        <div class="ct-pick" id="ctPick">${CT.tags.map((t) => `<button type="button" class="ct-tag tag-${esc(t.color)} ${tags.has(t.id) ? 'active' : ''}" data-pick="${t.id}"><i></i>${esc(t.name)}</button>`).join('') || '<span class="sub">No tags yet. Create one on the Contacts page.</span>'}</div>
        <label>Notes<textarea name="notes" rows="3">${esc(c?.notes || '')}</textarea></label>
        ${lead.summary || lead.need || lead.budget || lead.timeline ? `<div class="ct-leadbox"><div class="pc-label">From the lead assistant</div>
          ${lead.summary ? `<p>${esc(lead.summary)}</p>` : ''}
          <dl>${[['Need', lead.need], ['Budget', lead.budget], ['Timeline', lead.timeline]].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>` : ''}
        ${c && Object.keys(c.extra || {}).length ? `<details class="ct-extra"><summary>Other details (${Object.keys(c.extra).length})</summary><dl>${Object.entries(c.extra).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>` : ''}
        <div class="modal-actions">
          ${c ? `<button type="button" class="btn quiet danger" id="ctDel" style="margin-right:auto">Delete</button>` : ''}
          ${chatKey ? `<button type="button" class="btn quiet" id="ctChat" data-icon="message-circle">Open chat</button>` : ''}
          <button type="button" class="btn quiet" id="ctCancel">Cancel</button>
          <button class="btn primary">${c ? 'Save' : 'Add contact'}</button>
        </div>
      </form>`);
    LA.hydrate(body);
    $('#ctPick', body).addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      tags.has(b.dataset.pick) ? tags.delete(b.dataset.pick) : tags.add(b.dataset.pick);
      b.classList.toggle('active');
    });
    $('#ctCancel', body).onclick = closeModal;
    if (chatKey) $('#ctChat', body).onclick = () => { closeModal(); showTab('inbox'); window.Inbox?.open(chatKey); };
    if (c) $('#ctDel', body).onclick = async () => {
      closeModal();
      if (!(await confirmDialog({ title: 'Delete this contact?', message: 'Their chats and campaign history stay.', confirmText: 'Delete', danger: true }))) return;
      await guard(async () => { await api('/contacts/delete', { method: 'POST', body: { ids: [c.id] } }); await refresh(); });
    };
    $('#ctForm', body).addEventListener('submit', (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      const data = { name: d.name, phone: d.phone, email: d.email, company: d.company, status: d.status, notes: d.notes, optOut: Boolean(e.target.optOut.checked), tags: [...tags] };
      guard(async () => {
        if (c) await api('/contacts/' + c.id, { method: 'PUT', body: data });
        else {
          const r = await api('/contacts', { method: 'POST', body: data });
          if (!r.created) toast('That number was already saved; its details were updated');
        }
        closeModal();
        await refresh();
        toast(c ? 'Saved' : 'Contact added');
      }, $('button.primary', e.target));
    });
  }

  // --- Import -----------------------------------------------------------------------

  const guessCol = (headers, re, avoid) => headers.find((h) => re.test(h) && !(avoid && avoid.test(h))) || '';

  function importModal() {
    const IM = { sheets: [], tags: new Set(), keepExtra: true };
    const body = openModal('Import contacts', `
      <p class="sub ib-modal-sub">CSV or Excel. Every sheet of a workbook is listed; people are matched by phone number, so importing again updates them instead of making duplicates.</p>
      <label class="ci-drop" id="ciDrop">${icon('cloud-upload', 22)}<span><b>Choose files</b> or drop them here</span>
        <input type="file" id="ciFiles" multiple hidden accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv" /></label>
      <div id="ciSheets" class="ci-sheets"></div>
      <div id="ciOptions" class="ci-opts hidden">
        <label class="ci-check"><input type="checkbox" class="cb" id="ciExtra" checked /> Keep other columns as extra details</label>
        <div class="field-label">Tag everyone imported</div>
        <div class="ct-pick" id="ciTags">${CT.tags.map((t) => `<button type="button" class="ct-tag tag-${esc(t.color)}" data-pick="${t.id}"><i></i>${esc(t.name)}</button>`).join('')}</div>
        <input id="ciNewTags" placeholder="New tags, separated by commas (e.g. Designers, Feb leads)" />
      </div>
      <div class="modal-actions"><span class="ci-summary" id="ciSummary"></span><button class="btn quiet" id="ciCancel">Cancel</button><button class="btn primary" id="ciGo" disabled>Import</button></div>`);
    body.closest('.modal-box').classList.add('ci-box');

    const existing = new Set(CT.contacts.map((c) => c.phone));
    const sheetRows = (s) => (s.fix && s.groups.length ? realignShiftedRows(s.headers, s.rows, s.groups) : { headers: s.headers, rows: s.rows });
    // Everything that would be imported, merged by phone.
    function collect() {
      const out = new Map();
      for (const s of IM.sheets) {
        if (!s.include) continue;
        const { headers, rows } = sheetRows(s);
        const at = (h) => headers.indexOf(h);
        const used = new Set(Object.values(s.map).filter(Boolean));
        for (const r of rows) {
          const phone = normalizePhone(r[at(s.map.phone)]);
          if (!phone) continue;
          const get = (k) => (s.map[k] ? String(r[at(s.map[k])] ?? '').trim() : '');
          const extra = IM.keepExtra ? Object.fromEntries(headers.filter((h) => !used.has(h) && String(r[at(h)] ?? '').trim()).map((h) => [h, String(r[at(h)]).trim()])) : {};
          const prev = out.get(phone) || {};
          out.set(phone, { phone, name: get('name') || prev.name || '', email: get('email') || prev.email || '', company: get('company') || prev.company || '', extra: { ...prev.extra, ...extra } });
        }
      }
      return [...out.values()];
    }
    function summary() {
      const rows = collect();
      const added = rows.filter((r) => !existing.has(r.phone)).length;
      $('#ciSummary', body).textContent = rows.length ? `${rows.length.toLocaleString()} people · ${added.toLocaleString()} new, ${(rows.length - added).toLocaleString()} already saved` : IM.sheets.length ? 'No valid numbers in the chosen sheets' : '';
      $('#ciGo', body).disabled = !rows.length;
      $('#ciGo', body).textContent = rows.length ? `Import ${rows.length.toLocaleString()}` : 'Import';
    }
    function renderSheets() {
      $('#ciOptions', body).classList.toggle('hidden', !IM.sheets.length);
      $('#ciSheets', body).innerHTML = IM.sheets.map((s, i) => {
        const pc = s.headers.indexOf(s.map.phone);
        const valid = s.rows.filter((r) => normalizePhone(r[pc])).length;
        const shifted = s.groups.reduce((n, g) => n + g.idx.length, 0);
        const sel = (k, label) => `<label>${label}<select data-map="${k}" data-i="${i}"><option value="">—</option>${s.headers.map((h) => `<option ${h === s.map[k] ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`;
        return `<div class="ci-sheet ${s.include ? '' : 'off'}">
          <div class="ci-sheet-head"><label class="ci-check"><input type="checkbox" class="cb" data-inc="${i}" ${s.include ? 'checked' : ''} /> <b>${esc(s.label)}</b></label>
            <span class="muted">${s.rows.length.toLocaleString()} rows · ${(valid + (s.fix ? shifted : 0)).toLocaleString()} with a valid number</span></div>
          <div class="ci-map">${sel('phone', 'Phone')}${sel('name', 'Name')}${sel('email', 'Email')}${sel('company', 'Company')}</div>
          ${shifted ? `<label class="ci-check ci-fix"><input type="checkbox" class="cb" data-fix="${i}" ${s.fix ? 'checked' : ''} /> Fix ${shifted} shifted row${shifted > 1 ? 's' : ''} (their number is a few columns to the right)</label>` : ''}
        </div>`;
      }).join('');
      summary();
    }
    async function addFiles(list) {
      for (const file of [...list]) {
        try {
          const book = (await SendPage.readWorkbook(file)).filter((b) => b.grid.some((r) => r.some((c) => String(c).trim())));
          for (const b of book) {
            const t = SendPage.toTable(b.grid);
            if (!t.headers.length) continue;
            const phone = guessPhoneColumn(t.headers, t.rows);
            const s = {
              label: book.length > 1 ? `${file.name} · ${b.name}` : file.name, headers: t.headers, rows: t.rows, include: true, fix: true,
              map: {
                phone,
                name: guessCol(t.headers, /^(full[ _-]?)?name$|contact name|customer|^name\b/i) || guessCol(t.headers, /name/i, /company|business|file|user ?name|campaign|ad|form/i),
                email: guessCol(t.headers, /e-?mail/i),
                company: guessCol(t.headers, /^(company|company[ _-]?name|business[ _-]?name|organi[sz]ation|firm|brand|shop[ _-]?name)$/i),
              },
            };
            s.groups = detectShiftedRows(s.headers, s.rows, s.headers.indexOf(phone));
            IM.sheets.push(s);
          }
        } catch (e) {
          toast(`Couldn't read ${file.name}: ${e.message}`, 'error');
        }
      }
      renderSheets();
    }

    $('#ciFiles', body).addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    const drop = $('#ciDrop', body);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
    $('#ciSheets', body).addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.inc) IM.sheets[t.dataset.inc].include = t.checked;
      if (t.dataset.fix) IM.sheets[t.dataset.fix].fix = t.checked;
      if (t.dataset.map) {
        const s = IM.sheets[t.dataset.i];
        s.map[t.dataset.map] = t.value;
        if (t.dataset.map === 'phone') s.groups = detectShiftedRows(s.headers, s.rows, s.headers.indexOf(t.value));
      }
      renderSheets();
    });
    $('#ciExtra', body).addEventListener('change', (e) => { IM.keepExtra = e.target.checked; summary(); });
    $('#ciTags', body).addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      IM.tags.has(b.dataset.pick) ? IM.tags.delete(b.dataset.pick) : IM.tags.add(b.dataset.pick);
      b.classList.toggle('active');
    });
    $('#ciCancel', body).onclick = closeModal;
    $('#ciGo', body).onclick = (e) => guard(async () => {
      const rows = collect();
      const newTags = $('#ciNewTags', body).value.split(',').map((x) => x.trim()).filter(Boolean);
      const r = await api('/contacts/import', { method: 'POST', body: { rows, tags: [...IM.tags], newTags } });
      closeModal();
      await refresh();
      toast(`Imported: ${r.added.toLocaleString()} new, ${r.updated.toLocaleString()} updated${r.invalid ? `, ${r.invalid} skipped` : ''}`);
    }, e.currentTarget);
  }
  $('#ctImport').addEventListener('click', importModal);
  $('#ctAdd').addEventListener('click', () => open(null));

  // --- Export -------------------------------------------------------------------------

  function exportRows() {
    const list = CT.selected.size ? CT.contacts.filter((c) => CT.selected.has(c.id)) : filtered();
    const extras = [...new Set(list.flatMap((c) => Object.keys(c.extra || {})))];
    const head = ['name', 'phone', 'email', 'company', 'tags', 'status', 'opted_out', 'lead_summary', 'need', 'budget', 'timeline', 'notes', 'last_message', ...extras];
    const rows = list.map((c) => [c.name, '+' + c.phone, c.email, c.company, c.tags.map((t) => tagById(t)?.name).filter(Boolean).join(', '), c.optOut ? 'opted out' : STATUS[c.status]?.label || c.status, c.optOut ? 'yes' : 'no', c.lead?.summary, c.lead?.need, c.lead?.budget, c.lead?.timeline, c.notes, c.lastMessageAt || '', ...extras.map((k) => c.extra?.[k] ?? '')]);
    return { head, rows, n: list.length };
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('#ctExport').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const label = CT.selected.size ? `${CT.selected.size} selected` : CT.tag || CT.status || CT.q ? 'the filtered list' : 'everyone';
    const date = new Date().toISOString().slice(0, 10);
    Sheet.Menu.open(r.left, r.bottom + 4, [
      { label: `CSV · ${label}`, action: () => {
        const { head, rows } = exportRows();
        const q = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
        download(new Blob(['﻿' + [head, ...rows].map((r) => r.map(q).join(',')).join('\n')], { type: 'text/csv' }), `contacts-${date}.csv`);
      } },
      { label: `Excel · ${label}`, action: () => guard(async () => {
        const XLSX = await loadXlsxLib();
        const { head, rows } = exportRows();
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...rows]), 'Contacts');
        XLSX.writeFile(wb, `contacts-${date}.xlsx`);
      }) },
    ]);
  });

  window.Contacts = {
    async show() {
      if (!CT.loaded) $('#ctList').innerHTML = CT.view === 'cards' ? Skel.person(12) : Skel.table(8);
      await guard(load);
      render();
    },
    open: async (id) => { if (!CT.loaded) await load(); open(id); },
    byPhone: (phone) => CT.contacts.find((c) => c.phone === phone),
    tags: () => CT.tags,
    refresh: () => (CT.loaded ? refresh() : load()),
  };
  // Tags are needed by the Send page and Inbox even before this page is opened.
  load().catch(() => {});
})();
