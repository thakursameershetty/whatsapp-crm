// Contacts page: the address book. Search, filter by tag and status, tag people in bulk,
// edit a contact, import from Excel / CSV (every sheet, merged by phone number) and export.
// Collections: named lists of contacts (picked from the selection bar); viewing one narrows the page to it, and
// Export / Send then work on that collection.
// Uses helpers from app.js and send.js (SendPage.readWorkbook / toTable / openContacts).

(function () {
  // The list comes from the server one page at a time (search, filters and sorting happen there). CT.contacts: the
  // page shown; CT.cache: every contact fetched so far, by id (the panel and editor can show one from another page).
  const PER_OPTS = [25, 50, 100, 200, 0]; // as on Campaigns; 0 = show all
  const perPref = () => { try { const v = localStorage.getItem('ctPer'); return v != null && PER_OPTS.includes(Number(v)) ? Number(v) : 100; } catch { return 100; } };
  // fs: the Filters panel's picks, one set per section (any of a section's picks; every section with picks must match)
  const CT = { contacts: [], cache: new Map(), total: 0, all: 0, pages: 1, per: perPref(), facets: {}, facetTotals: {}, tags: [], counts: {}, q: '', fs: { stage: new Set(), delivery: new Set(), num: new Set(), tag: new Set(), source: new Set() }, page: 0, selected: new Set(), chats: new Map(), loaded: false, collections: [], col: null };
  const STATUS = {
    new: { label: 'New', cls: '' },
    interested: { label: 'Interested', cls: 'sent' },
    qualified: { label: 'Qualified', cls: 'scheduled' },
    won: { label: 'Won', cls: 'delivered' },
    lost: { label: 'Not interested', cls: 'cancelled' },
  };
  const COLORS = ['blue', 'green', 'violet', 'orange', 'teal', 'pink', 'gray', 'red', 'amber', 'lime', 'sky', 'indigo', 'fuchsia', 'brown'];
  const tagById = (id) => CT.tags.find((t) => t.id === id);
  const fmtPhone = (p) => { const m = /^91(\d{5})(\d{5})$/.exec(p); return m ? `+91 ${m[1]} ${m[2]}` : '+' + p; };
  const tagChip = (t, extra = '') => `<span class="tag-chip tag-${esc(t.color)}" title="${esc(t.name)}" ${extra}>${esc(t.name)}</span>`;

  // The current search, sort, filters and page as the API's query
  function listQuery(extra = {}) {
    const p = new URLSearchParams({ page: CT.page, per: CT.per, sort: CT.sort.key, dir: CT.sort.dir, ...(CT.q ? { q: CT.q } : {}) });
    for (const [sec, set] of Object.entries(CT.fs)) if (set.size) p.set(sec, [...set].join(','));
    if (CT.col) p.set('col', CT.col);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  }
  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    const [r, inbox] = await Promise.all([api('/contacts?' + listQuery()), CT.chatsLoaded ? null : api('/inbox').catch(() => ({ conversations: [] }))]);
    if (seq !== loadSeq) return false; // a newer request (typing, another filter) has taken over
    Object.assign(CT, { contacts: r.contacts, tags: r.tags, counts: r.counts, total: r.total, all: r.all, opted: r.opted, untagged: r.untagged, pages: r.pages, page: r.page, facets: r.facets, facetTotals: r.facetTotals, collections: r.collections || [], loaded: true });
    if (CT.col && !CT.collections.some((x) => x.id === CT.col)) CT.col = null; // deleted (here or in another tab)
    for (const c of r.contacts) CT.cache.set(c.id, c);
    state.contactTags = r.tags;
    if (inbox) { CT.chats = new Map(inbox.conversations.map((c) => [c.wa, c.key])); CT.chatsLoaded = true; }
    return true;
  }
  // A new page of results (after a search, filter, sort or page change), then draw it
  async function reload() { if (await guard(load)) render(); }
  // A contact by id: from the page or the cache, else from the server
  async function getContact(id) {
    if (CT.cache.has(id)) return CT.cache.get(id);
    const c = await api('/contacts/' + encodeURIComponent(id)).catch(() => null);
    if (c) CT.cache.set(c.id, c);
    return c;
  }

  // --- List ---------------------------------------------------------------

  // The page shown (already searched, filtered and sorted by the server)
  function filtered() { return CT.contacts; }

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
    reload();
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

  // Opens as the list (table); a choice made since the list became the default is remembered (ctView2).
  const viewPref = () => { try { return localStorage.getItem('ctView2') || 'table'; } catch { return 'table'; } };
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
    // Auto-added contacts (they messaged you; the AI assistant handles the chat) wear the AI sphere on their photo.
    const ai = c.source === 'inbox'
      ? `<i class="ct-av-ai" title="Auto-added when they messaged you${aiFilled(c) ? '. The AI assistant filled in their details' : ''}"><svg class="orb-icon" data-orb-icon="${{ sm: 10, lg: 15, xl: 18 }[cls] || 10}"></svg></i>`
      : '';
    return `<span class="ct-av ${cls}" style="--av:var(--file-${(h % 6) + 1})">${text}${ai}</span>`;
  }
  // How their latest campaign message went (contact.delivery, kept by the server).
  const DELIVERY = { sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not delivered' };
  // A Meta error as its code chip (hover or focus: the dark card explaining it, from the Error codes list)
  const errCode = (err) => { const t = String(err || ''); return (t.match(/^(\d{1,6}):/) || t.match(/\(#(\d+)\)/) || t.match(/\b(1\d{5})\b/) || [])[1] || ''; };
  const errChip = (err) => {
    const code = errCode(err);
    if (!code) return err ? `<span class="ct-errtxt" title="${esc(err)}">Not delivered</span>` : '';
    const e = window.MetaErrors?.byCode[code];
    return `<span class="ct-errline">${e ? `<span class="ct-errline-t">${esc(e.title)}</span>` : ''}<code class="cd-ecode" tabindex="0" data-ecode="${esc(code)}">${esc(code)}</code></span>`;
  };
  // Not delivered in any campaign (not only the latest)
  const failedIn = (c) => (c.campaigns || []).filter((x) => x.status === 'failed');
  const everFailed = (c) => failedIn(c).length > 0 || c.delivery?.status === 'failed';
  // Reached: delivered (or read) in at least one campaign
  const everDelivered = (c) => (c.campaigns || []).some((x) => x.status === 'delivered' || x.status === 'read') || ['delivered', 'read'].includes(c.delivery?.status);
  const deliveryText = (c) => (c.delivery ? `${c.delivery.campaign || 'A campaign'} · ${DELIVERY[c.delivery.status] || c.delivery.status}${c.delivery.error ? ` (${c.delivery.error})` : ''}${c.delivery.at ? ` · ${relTime(c.delivery.at)}` : ''}` : '');
  const undelivered = (c) => { const f = failedIn(c); return everFailed(c) ? ` <span class="pill failed" title="${esc(`Not delivered: ${(f.length ? f.map((x) => x.name) : [c.delivery?.campaign || 'a campaign']).join(', ')}`)}">Not delivered${f.length > 1 ? ` ×${f.length}` : ''}</span>` : ''; };
  const statusPill = (c) => (c.optOut ? '<span class="pill failed">Opted out</span>' : `<span class="pill ${STATUS[c.status]?.cls || ''}">${esc(STATUS[c.status]?.label || c.status)}</span>`) + (c.phoneProblem ? ` <span class="pill failed" title="${esc(c.phoneProblem)}">Fix number</span>` : '') + undelivered(c);
  const letterOf = (c) => { const ch = (c.name || '').trim()[0]?.toUpperCase() || '#'; return /[A-Z]/.test(ch) ? ch : '#'; };
  const senderName = (id) => state.senders.find((s) => s.id === id)?.label || 'A removed number';
  // --- Filters (the panel opened by the Filters button) ------------------------------------------
  // Sections and what each option matches. Within a section: any of the picks; across sections: all of them.
  const SOURCES = [['manual', 'Added by you'], ['import', 'Imported'], ['inbox', 'Messaged you first'], ['campaign', 'From campaigns']];
  const FILTERS = {
    stage: { title: 'Stage', match: (c, k) => !c.optOut && c.status === k },
    delivery: { title: 'Delivery', match: (c, k) => (k === 'delivered' ? everDelivered(c) : k === 'undelivered' ? everFailed(c) : c.optOut) },
    num: { title: 'Added by number', match: (c, k) => (c.via || 'none') === k },
    tag: { title: 'Tags', match: (c, k) => (k === 'none' ? !c.tags.length : c.tags.includes(k)) },
    source: { title: 'Who added them', match: (c, k) => (c.source || 'manual') === k },
  };
  // A contact passes when every section with picks matches (skip: leave one section out, for that section's counts)
  const passes = (c, skip = '') => Object.entries(CT.fs).every(([sec, set]) => sec === skip || !set.size || [...set].some((k) => FILTERS[sec].match(c, k)));
  const filterCount = () => Object.values(CT.fs).reduce((n, set) => n + set.size, 0);
  const clearFilters = () => Object.values(CT.fs).forEach((set) => set.clear());
  // The options of each section, as [key, label, leading html, hover text]
  function filterOptions() {
    const dot = (cls) => `<i class="ct-lab-dot ${cls}"></i>`;
    const gone = Object.keys(CT.facets.num || {}).filter((v) => v !== 'none' && !state.senders.some((x) => x.id === v));
    return {
      stage: Object.entries(STATUS).map(([k, v]) => [k, v.label, dot('st-' + k)]),
      delivery: [['delivered', 'Delivered', dot('st-won'), 'Delivered in at least one campaign'], ['undelivered', 'Not delivered', dot('st-bad'), 'Not delivered in at least one campaign'], ['optout', 'Opted out', dot('st-optout')]],
      num: state.senders.length ? [...state.senders.map((x) => [x.id, x.label, `<span class="fpx-ph">${senderPhotoHtml(x)}</span>`, x.displayPhone]), ...gone.map((v) => [v, senderName(v), `<span class="fpx-ic">${icon('phone', 14)}</span>`]), ['none', 'By hand or import', `<span class="fpx-ic">${icon('upload', 14)}</span>`]] : [],
      tag: [...CT.tags.map((t) => [t.id, t.name, `<i class="ct-dot tag-${esc(t.color)}"></i>`]), ...(CT.tags.length ? [['none', 'No tag', dot('')]] : [])],
      source: SOURCES.map(([k, l]) => [k, l, `<span class="fpx-ic">${icon(k === 'import' ? 'upload' : k === 'inbox' ? 'message-circle' : k === 'campaign' ? 'send' : 'user', 14)}</span>`]),
    };
  }
  const optLabel = (sec, k) => filterOptions()[sec].find(([x]) => x === k)?.[1] || k;

  // The Filters button (with how many are on) and, under the toolbar, the active filters as chips with the result
  // count and Select all.
  function renderFilterBar(list) {
    renderNumBtn();
    const n = filterCount();
    const b = $('#ctFilterBtn');
    b.innerHTML = `${icon('sliders-horizontal', 16)}${n ? `<b class="ct-fbadge">${n}</b>` : ''}`; // just the icon (and how many are on)
    b.classList.toggle('on', n > 0);
    b.setAttribute('aria-label', n ? `Filters, ${n} on` : 'Filters');
    b.title = n ? `Filters (${n} on)` : 'Filters: stage, delivery, number, tag or who added them';
    const bar = $('#ctActive');
    const all = CT.total > 0 && CT.selected.size >= CT.total && list.every((c) => CT.selected.has(c.id));
    const chips = Object.entries(CT.fs).flatMap(([sec, set]) => [...set].map((k) => `<span class="ct-chip"><span class="ct-chip-s">${esc(FILTERS[sec].title)}:</span>${esc(optLabel(sec, k))}<button type="button" data-unf="${sec}" data-k="${esc(k)}" aria-label="Remove ${esc(optLabel(sec, k))}">${icon('x', 12)}</button></span>`));
    const shown = n || CT.q ? `${CT.total.toLocaleString()} of ${CT.all.toLocaleString()}` : `${CT.all.toLocaleString()} contact${CT.all === 1 ? '' : 's'}`;
    bar.classList.toggle('hidden', !n);
    bar.innerHTML = n ? `${chips.join('')}<button type="button" class="ct-clear" data-unf="all">Clear all</button><span class="ct-count">${shown}</span>` : '';
    if ($('#ctFilters') && !$('#ctFilters').classList.contains('hidden')) drawFilters(); // e.g. a tag added from the panel
  }

  // The panel: slides over the page from the right. Picks apply at once (the list behind updates); each option shows
  // how many contacts it would give with the other sections' picks.
  function openFilters() {
    let el = $('#ctFilters');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ctFilters';
      el.className = 'ct-fpanel-wrap hidden';
      el.innerHTML = '<div class="ct-fpanel" role="dialog" aria-modal="true" aria-label="Filters"></div>';
      document.body.append(el);
      el.addEventListener('click', (e) => {
        if (e.target === el || e.target.closest('[data-fclose]')) return closeFilters();
        if (e.target.closest('[data-fclear]')) { clearFilters(); return applyFilters(); }
        const one = e.target.closest('[data-fclearsec]'); // just this section
        if (one) { CT.fs[one.dataset.fclearsec].clear(); return applyFilters(); }
        const newTag = e.target.closest('[data-fnewtag]');
        if (newTag) return tagModal(null);
        const editTag = e.target.closest('[data-fedit]');
        if (editTag) { e.preventDefault(); return tagModal(tagById(editTag.dataset.fedit)); }
      });
      el.addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-fsec]');
        if (!cb) return;
        const set = CT.fs[cb.dataset.fsec];
        cb.checked ? set.add(cb.value) : set.delete(cb.value);
        applyFilters();
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.classList.contains('hidden') && $('#modal').classList.contains('hidden')) { e.stopPropagation(); closeFilters(); } }, true);
    }
    drawFilters();
    el.classList.remove('hidden', 'closing');
    requestAnimationFrame(() => el.querySelector('input, button')?.focus({ preventScroll: true }));
  }
  function closeFilters() { const el = $('#ctFilters'); if (el) hideOverlay(el); $('#ctFilterBtn').focus({ preventScroll: true }); }
  function applyFilters() { CT.page = 0; CT.enter = true; reload(); }
  function drawFilters() {
    const box = $('#ctFilters .ct-fpanel');
    if (!box) return;
    const opts = filterOptions();
    const results = CT.total;
    const sec = (key) => {
      if (!opts[key].length && key !== 'tag') return '';
      const rows = opts[key].map(([k, label, lead, tip]) => {
        const n = CT.facets[key]?.[k] || 0;
        const on = CT.fs[key].has(k);
        return `<label class="fpx-opt ${on ? 'on' : ''} ${!n && !on ? 'zero' : ''}" ${tip ? `title="${esc(tip)}"` : ''}><input type="checkbox" class="cb" data-fsec="${key}" value="${esc(k)}" ${on ? 'checked' : ''} />${lead}<span class="fpx-t">${esc(label)}</span>${key === 'tag' && k !== 'none' ? `<button type="button" class="fpx-edit" data-fedit="${esc(k)}" title="Edit tag" aria-label="Edit ${esc(label)}">${icon('square-pen', 13)}</button>` : ''}<b>${n.toLocaleString()}</b></label>`;
      }).join('');
      return `<section class="fpx-sec"><div class="fpx-h"><span>${FILTERS[key].title}</span>${CT.fs[key].size ? `<span class="fpx-n">${CT.fs[key].size}</span><button type="button" class="fpx-clr" data-fclearsec="${key}" title="Clear ${esc(FILTERS[key].title)}">Clear</button>` : ''}${key === 'tag' ? '<button type="button" class="fpx-add" data-fnewtag>+ New tag</button>' : ''}</div>${rows || '<p class="fpx-none">No tags yet.</p>'}</section>`;
    };
    const keep = box.querySelector('.fpx-body')?.scrollTop || 0;
    box.innerHTML = `<header class="fpx-head"><h2>Filters</h2><button type="button" class="icon-btn" data-fclose aria-label="Close">${icon('x', 18)}</button></header>
      <div class="fpx-body">${['stage', 'delivery', 'num', 'tag', 'source'].map(sec).join('')}</div>
      <footer class="fpx-foot"><button type="button" class="btn quiet" data-fclear ${filterCount() ? '' : 'disabled'}>Clear all</button><button type="button" class="btn primary" data-fclose>Show ${results.toLocaleString()} contact${results === 1 ? '' : 's'}</button></footer>`;
    box.querySelector('.fpx-body').scrollTop = keep;
  }

  // How a contact got here: you added it, it was imported, or it was added automatically when the person messaged
  // one of your numbers (shown with the AI sphere on their photo). aiFilled: the assistant filled in their details.
  const aiFilled = (c) => Boolean(c.lead?.updatedAt);

  function render() {
    const list = filtered(), slice = list, pages = CT.pages;
    CT.slice = slice;
    const opted = CT.opted || 0;
    // "Contacts (2,218)": how many the current search and filters show (the whole book when there are none), rolling like
    // the Campaigns numbers whenever it changes
    $('#ctTotal').classList.toggle('hidden', !CT.loaded);
    rollNum($('#ctTotalN'), CT.total);
    $('#ctTotal').title = CT.total === CT.all ? `${CT.all.toLocaleString()} contacts` : `${CT.total.toLocaleString()} of ${CT.all.toLocaleString()} contacts match the search and filters`;
    $('#ctSub').textContent = `Everyone you message, with tags. ${CT.all.toLocaleString()} contact${CT.all === 1 ? '' : 's'}${opted ? ` · ${opted} opted out` : ''}`;


    renderFilterBar(list);
    renderCollection();

    // Patched, not replaced, so the switcher's thumb slides between Cards and Table.
    Motion.patch($('#ctView'), [['table', 'List', 'list'], ['cards', 'Cards', 'layout-grid']].map(([k, label, ic]) =>
      `<button data-view="${k}" class="${CT.view === k ? 'active' : ''}" title="${label}" aria-label="${label}" aria-checked="${CT.view === k}" role="radio">${icon(ic, 15)}</button>`).join(''));

    const empty = CT.all
      ? emptyState({ icon: 'search', title: 'No contacts match', text: 'Try another search, or change the filters.', actions: '<button class="btn" data-empty="clear">Clear filters</button>' })
      : emptyState({ icon: 'users', title: 'No contacts yet', text: 'Import a spreadsheet or add someone by hand. People who message you on WhatsApp appear here too.', actions: '<button class="btn" data-empty="import" data-icon="upload">Import</button><button class="btn primary" data-empty="add" data-icon="plus">Add contact</button>' });
    const box = $('#ctList');
    box.innerHTML = CT.view === 'cards' ? gridHtml(slice, empty) : tableHtml(slice, empty);
    box.classList.toggle('ct-scroll-grid', CT.view === 'cards');
    requestAnimationFrame(() => window.markStuck?.()); // the table's headings join the pinned header (app.js)
    const hs = $('#ctHScroll'), hd = $('#ctHeadScroll');
    if (hs && hd) {
      hs.scrollLeft = CT.hx || 0;
      hd.scrollLeft = hs.scrollLeft;
      hs.addEventListener('scroll', () => { hd.scrollLeft = CT.hx = hs.scrollLeft; }, { passive: true });
      // a sideways swipe over the headings scrolls the rows (the headings' strip has no scrollbar of its own)
      hd.addEventListener('wheel', (e) => { if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { hs.scrollLeft += e.deltaX; e.preventDefault(); } }, { passive: false });
    }
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

    // Pages, as on Campaigns: "101–200 of 2,218" and ← Page 2 of 23 → (only when there's more than one page); how many a
    // page shows is chosen in the toolbar.
    const from = CT.per ? CT.page * CT.per : 0;
    $('#ctFoot').classList.toggle('hidden', pages <= 1);
    $('#ctFoot').innerHTML = pages > 1 ? `<div class="cp-pager ct-pager">
        <span>${(from + 1).toLocaleString()}–${(from + list.length).toLocaleString()} of ${CT.total.toLocaleString()}</span>
        <div class="seg"><button type="button" data-page="-1" ${CT.page ? '' : 'disabled'} aria-label="Previous page">${icon('arrow-left', 14)}</button><span>Page ${CT.page + 1} of ${pages}</span><button type="button" data-page="1" ${CT.page < pages - 1 ? '' : 'disabled'} aria-label="Next page">${icon('arrow-right', 14)}</button></div>
      </div>` : '';
    $('#ctPer').innerHTML = PER_OPTS.map((n) => `<option value="${n}" ${n === CT.per ? 'selected' : ''}>${n ? `${n} / page` : 'Show all'}</option>`).join('');
    renderSelection(list);
    renderSortMenu();
    renderPanel();
    LA.hydrate($('#tab-contacts'));
    Orb.hydrate($('#tab-contacts'));
  }

  function tableHtml(slice, empty) {
    const allOn = slice.length && slice.every((c) => CT.selected.has(c.id));
    // Two tables with the same fixed column widths: the headings in their own pinned strip, the rows in a box that
    // scrolls sideways (a sideways-scrolling box can't pin a heading to the page). The strip follows the rows' scroll.
    const cols = `<colgroup>${[48, 250, 190, 240, 170, 280, 140].map((w) => `<col style="width:${w}px">`).join('')}</colgroup>`;
    return `<div class="ct-thead-wrap" id="ctHeadWrap"><div class="ct-thead-scroll" id="ctHeadScroll"><table class="data-table ct-table ct-cols">${cols}<thead><tr class="heads"><th class="sel"><input type="checkbox" class="cb" id="ctAll" ${allOn ? 'checked' : ''} aria-label="Select all shown" /></th>${[['name', 'Name', ''], ['company', 'Company', 'ct-c-co'], ['tags', 'Tags', ''], ['status', 'Status', ''], ['lead', 'Lead', 'ct-c-lead'], ['message', 'Last message', 'ct-c-last']].map(([k, label, cls]) => {
      const on = CT.sort.key === k;
      return `<th class="${cls} ct-sortable ${on ? 'on' : ''}" aria-sort="${on ? (CT.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${k}" title="Sort by ${label.toLowerCase()}">${label}<i class="ct-arrow ${on ? CT.sort.dir : ''}" aria-hidden="true"></i></button></th>`;
    }).join('')}</tr></thead></table></div></div><div class="ct-hscroll" id="ctHScroll"><table class="data-table ct-table ct-cols">${cols}<tbody>
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
        : `<tr><td colspan="7" class="ct-empty">${empty}</td></tr>`}</tbody></table></div>`;
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
    const everyone = CT.total > 0 && n >= CT.total;
    bar.innerHTML = `<b>${n.toLocaleString()} selected</b>${shown < n ? ` <span class="muted">(${(n - shown).toLocaleString()} on other pages or filtered out)</span>` : ''}${!everyone && CT.total > list.filter((c) => CT.selected.has(c.id)).length ? ` <button type="button" class="ct-selall-link" data-selall>Select all ${CT.total.toLocaleString()}</button>` : ''}
      <span class="ct-sel-actions">
        <button class="btn sm" data-act="tag" data-icon="plus" data-icon-size="13">Add tag</button>
        <button class="btn sm" data-act="untag">Remove tag</button>
        <button class="btn sm" data-act="collect" data-icon="layers" data-icon-size="13">Add to collection</button>
        ${CT.col ? '<button class="btn sm" data-act="uncollect">Remove from collection</button>' : ''}
        <button class="btn sm" data-act="send" data-icon="send" data-icon-size="13">Send a message</button>
        <button class="btn sm quiet danger" data-act="delete" data-icon="delete" data-icon-size="13">Delete</button>
        <button class="btn sm quiet" data-act="clear">Clear</button>
      </span>`;
    LA.hydrate(bar);
  }

  // Sort menu in the toolbar (the table's column headers sort too).
  // Sort: a compact button showing the current order; it opens a small menu (same as the filter menus).
  const SORT_OPTS = [['name:asc', 'Name A → Z'], ['name:desc', 'Name Z → A'], '-', ['added:desc', 'Newest added'], ['added:asc', 'Oldest added'], ['message:desc', 'Last message'], '-', ['status:asc', 'Status'], ['tags:asc', 'Tags'], ['lead:desc', 'Lead notes first'], ['company:asc', 'Company A → Z']];
  const sortLabel = () => {
    const cur = `${CT.sort.key}:${CT.sort.dir}`;
    return SORT_OPTS.find((o) => o[0] === cur)?.[1] || `${SORTS[CT.sort.key][0]} ${CT.sort.dir === 'asc' ? '↑' : '↓'}`;
  };
  function renderSortMenu() {
    const b = $('#ctSortBtn');
    b.innerHTML = `${icon('arrow-up-down', 14)}<span>${esc(sortLabel())}</span>${icon('chevron-down', 14)}`;
    b.title = `Sorted by ${sortLabel()}. Click to change.`;
  }
  $('#ctSortBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const cur = `${CT.sort.key}:${CT.sort.dir}`;
    Sheet.Menu.open(r.left, r.bottom + 6, SORT_OPTS.map((o) => (o === '-' ? '-' : { label: o[1], checked: o[0] === cur, action: () => { const [k, d] = o[0].split(':'); setSort(k, d); } })));
  });

  // "Select all" (in the bar under the toolbar): everyone the current search and filters show (every page).
  $('#ctActive').addEventListener('click', (e) => {
    const un = e.target.closest('[data-unf]');
    if (un) { if (un.dataset.unf === 'all') clearFilters(); else CT.fs[un.dataset.unf].delete(un.dataset.k); return applyFilters(); }
    if (!e.target.closest('[data-selall]')) return;
    const all = CT.total > 0 && CT.selected.size >= CT.total && CT.contacts.every((c) => CT.selected.has(c.id));
    if (all) { CT.selected.clear(); return render(); }
    guard(async () => { const r = await api('/contacts?' + listQuery({ ids: 1, per: 10 })); r.ids.forEach((id) => CT.selected.add(id)); render(); });
  });
  $('#ctFilterBtn').addEventListener('click', openFilters);
  // The selection bar's height (with its gap), for the table headings that pin below it (0 while it's hidden)
  new ResizeObserver(() => {
    const bar = $('#ctSel');
    $('#tab-contacts').style.setProperty('--ct-sel-h', bar.classList.contains('hidden') ? '0px' : bar.getBoundingClientRect().height + 10 + 'px');
    window.markStuck?.();
  }).observe($('#ctSel'));

  // "Added by" in the toolbar: a quick way to the Filters panel's "Added by number" section (the same choice, kept in
  // sync both ways). Picking here shows one number; several picked in the panel read "2 numbers" here.
  function renderNumBtn() {
    const b = $('#ctNumBtn'), set = CT.fs.num;
    b.classList.toggle('hidden', !state.senders.length);
    const one = set.size === 1 ? [...set][0] : '';
    const s = one && one !== 'none' ? state.senders.find((x) => x.id === one) : null;
    const label = !set.size ? 'Added by anyone' : set.size > 1 ? `${set.size} numbers` : one === 'none' ? 'By hand or import' : s ? s.label : senderName(one);
    b.innerHTML = `${s ? `<span class="ct-numbtn-ph">${senderPhotoHtml(s)}</span>` : icon(one === 'none' ? 'upload' : 'phone', 14)}<span>${esc(label)}</span>${icon('chevron-down', 14)}`;
    b.classList.toggle('on', set.size > 0);
  }
  $('#ctNumBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect(), set = CT.fs.num;
    const pick = (k) => { set.clear(); if (k) set.add(k); applyFilters(); };
    Sheet.Menu.open(r.left, r.bottom + 6, [
      { label: 'Added by anyone', kbd: (CT.facetTotals.num || 0).toLocaleString(), checked: !set.size, pre: `<span class="mi-ic">${icon('users', 15)}</span>`, action: () => pick('') },
      '-',
      ...filterOptions().num.map(([k, label, lead]) => ({ label, kbd: (CT.facets.num?.[k] || 0).toLocaleString(), checked: set.has(k), pre: `<span class="mi-ph">${lead}</span>`, action: () => pick(k) })),
    ]);
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
  $('#ctSearch').addEventListener('input', (e) => { clearTimeout(searchT); searchT = setTimeout(() => { CT.q = e.target.value.trim(); CT.page = 0; CT.enter = true; reload(); }, 200); });
  $('#ctView').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b || b.dataset.view === CT.view) return;
    try { localStorage.setItem('ctView2', b.dataset.view); } catch {}
    morph(() => { CT.view = b.dataset.view; render(); });
  });
  $('#ctPer').addEventListener('change', (e) => {
    CT.per = Number(e.target.value);
    try { localStorage.setItem('ctPer', CT.per); } catch {}
    CT.page = 0; CT.enter = true; reload();
  });
  $('#ctFoot').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (b && !b.disabled) { CT.page += Number(b.dataset.page); CT.enter = true; reload().then(toListTop); }
  });
  $('#ctList').addEventListener('click', (e) => {
    if (e.target.id === 'ctAll') {
      const on = e.target.checked;
      CT.slice.forEach((c) => (on ? CT.selected.add(c.id) : CT.selected.delete(c.id)));
      return render();
    }
    const emptyAct = e.target.closest('[data-empty]')?.dataset.empty;
    if (emptyAct === 'clear') { CT.q = ''; clearFilters(); $('#ctSearch').value = ''; CT.enter = true; return render(); }
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
    const c = CT.openId && CT.cache.get(CT.openId);
    if (!c) CT.openId = null;
    panel.classList.toggle('hidden', !c);
    $('#ctLayout').classList.toggle('has-panel', Boolean(c));
    if (!c) return;
    const chatKey = CT.chats.get(c.phone);
    const lead = c.lead || {};
    const details = [['Phone', fmtPhone(c.phone) + (c.phoneProblem ? ` · ${c.phoneProblem}` : '')], ['Email', c.email], ['Company', c.company], ['Last message', c.lastMessageAt && relTime(c.lastMessageAt)], ['Added', c.createdAt && `${new Date(c.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}${c.source ? ` · ${c.source === 'inbox' ? 'automatically, when they messaged you' : c.source === 'import' ? 'imported' : c.source === 'campaign' ? 'automatically, when a campaign messaged them' : 'by you'}` : ''}`], ['Added by number', c.via && `${senderName(c.via)}${state.senders.find((s) => s.id === c.via)?.displayPhone ? ' · ' + state.senders.find((s) => s.id === c.via).displayPhone : ''}`], ['Details', aiFilled(c) && `filled in by the AI assistant · ${relTime(c.lead.updatedAt)}`], ...Object.entries(c.extra || {})].filter(([, v]) => v);
    panel.innerHTML = `
      <button type="button" class="ct-pclose" id="ctPClose" title="Close" aria-label="Close">${icon('x', 16)}</button>
      <div class="ct-phead">
        ${avatar(c, 'xl')}
        <h2>${esc(nameOf(c))}</h2>
        <p>${esc([c.name ? fmtPhone(c.phone) : '', c.company].filter(Boolean).join(' · '))}</p>
      </div>
      <div class="ct-pacts">
        <button type="button" class="ct-pact" data-pact="send" ${c.optOut ? 'disabled title="Opted out"' : ''}>${icon('send', 17)}<span>Message</span></button>
        <button type="button" class="ct-pact" data-pact="chat" title="Their chats, by number">${icon('message-circle', 17)}<span>Chat</span></button>
        <button type="button" class="ct-pact" data-pact="edit">${icon('square-pen', 17)}<span>Edit</span></button>
        <button type="button" class="ct-pact" data-pact="delete">${icon('delete', 17)}<span>Delete</span></button>
      </div>
      <div class="ct-psec">
        <div class="ct-pstrow"><span class="field-label">Status</span><button type="button" class="ct-pst-btn" data-pstatus-menu aria-haspopup="menu" title="Change their stage"><i class="ct-lab-dot st-${esc(c.status)}"></i><span>${esc(STATUS[c.status]?.label || c.status)}</span>${icon('chevron-down', 14)}</button></div>
        <label class="ct-poptout"><span>Opted out <span class="opt">never message them</span></span>${toggleHtml({ checked: c.optOut, attrs: 'id="ctPOpt"', size: 'sm' })}</label>
      </div>
      <div class="ct-psec">
        <div class="ct-pstrow ct-ptags-h"><span class="field-label">Tags</span><button type="button" class="ct-ptag-edit" data-ptag-menu aria-haspopup="dialog" title="Add or remove tags">${icon('square-pen', 14)}<span>Edit</span></button></div>
        <div class="ct-ptags">${c.tags.map(tagById).filter(Boolean).map((t) => `<span class="tag-chip tag-${esc(t.color)} ct-ptag">${esc(t.name)}<button type="button" data-ptag-rm="${esc(t.id)}" aria-label="Remove ${esc(t.name)}" title="Remove">${icon('x', 11)}</button></span>`).join('')}${c.tags.length ? '' : '<span class="ct-ptags-none">No tags</span>'}</div>
      </div>
      ${lead.summary || lead.need || lead.budget || lead.timeline ? `<div class="ct-leadbox"><div class="pc-label">From the lead assistant</div>
        ${lead.summary ? `<p>${esc(lead.summary)}</p>` : ''}
        <dl>${[['Need', lead.need], ['Budget', lead.budget], ['Timeline', lead.timeline]].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>` : ''}
      ${campaignsHtml(c)}
      <div class="ct-psec"><div class="field-label">Details</div><dl class="ct-pdl">${details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>
      <label class="ct-psec ct-pnotes"><span class="field-label">Notes</span><textarea id="ctPNotes" rows="3" placeholder="Anything to remember about them">${esc(c.notes || '')}</textarea></label>`;
    Orb.hydrate(panel);
  }

  // Chat: the template window (the one the Inbox opens to send a template), showing only the templates this contact was
  // sent, grouped by number. Each card says how it went (and the error code, explained on hover); picking one opens the
  // chat with the number that sent it. A number they never replied to has no chat yet (until they write back, WhatsApp
  // allows only templates there), so its templates are greyed with that reason.
  const DELIV = { sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not delivered', pending: 'Waiting' };
  async function chatWindow(c) {
    const r = await guard(() => api('/contacts/' + encodeURIComponent(c.id) + '/threads'));
    if (!r) return;
    if (!r.threads.length) return toast(`None of your numbers has messaged ${nameOf(c)} yet, and they haven't written to you`, 'error');
    // each template: its sends (newest first), with the number that sent it and whether they replied there
    const sends = new Map();
    for (const t of r.threads) for (const x of t.sends) (sends.get(x.templateId) || sends.set(x.templateId, []).get(x.templateId)).push({ ...x, senderId: t.senderId, key: t.key, replied: t.replied, lastInAt: t.lastInAt });
    for (const list of sends.values()) list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const sender = (id) => state.senders.find((s) => s.id === id);
    const openable = (id) => (sends.get(id) || []).filter((x) => x.replied).sort((a, b) => String(b.lastInAt).localeCompare(String(a.lastInAt)))[0];
    const replied = r.threads.find((t) => t.replied);
    if (!sends.size) { // they wrote in, but nothing was sent to them as a template: straight to that chat
      if (replied) { showTab('inbox'); return window.Inbox?.open(replied.key); }
      return toast(`No templates were sent to ${nameOf(c)} yet`, 'error');
    }
    window.TemplatePicker?.({
      title: `Chats with ${nameOf(c)}`,
      useText: 'Open chat',
      statusFilter: false,
      only: (t) => sends.has(t.id),
      nums: r.threads.map((t) => sender(t.senderId)).filter(Boolean),
      firstWaba: sender((replied || r.threads[0]).senderId)?.wabaId || '',
      selected: replied ? [...sends.keys()].find((id) => openable(id)?.key === replied.key) || '' : '',
      block: (t) => {
        if (openable(t.id)) return null;
        const s = sender(sends.get(t.id)?.[0]?.senderId);
        return `${nameOf(c)} hasn't replied to ${s ? s.label : 'this number'} yet, so there's no chat to open. Until they write back, WhatsApp only lets you send them a template.`;
      },
      valuesOf: (t) => sends.get(t.id)?.[0]?.values,
      extra: (t) => {
        const list = sends.get(t.id) || [], x = list[0];
        if (!x) return '';
        const s = sender(x.senderId);
        return `<div class="chx-line"><span class="pill ${esc(x.status === 'failed' ? 'failed' : x.status || '')}">${esc(DELIV[x.status] || x.status || '')}</span><span class="chx-sub">${esc([s?.label, x.campaign || 'From the Inbox', x.at && relTime(x.at)].filter(Boolean).join(' · '))}${list.length > 1 ? ` · sent ${list.length}×` : ''}</span></div>${x.error ? `<div class="chx-err">${errChip(x.error)}</div>` : ''}`;
      },
      onUse: (id) => {
        const x = openable(id);
        if (!x) return false;
        closeModal();
        showTab('inbox');
        window.Inbox?.open(x.key);
        return true;
      },
    });
  }

  // The contact panel's Campaigns: a quiet timeline, newest first, in WhatsApp's own marks (one grey tick sent, two
  // delivered, two blue read, a red ! not delivered). A summary line on top; the latest few, then "Show all". A name the
  // app made ("template — 26/10/2026, 11:38 AM") shows without its date, which the row already gives.
  const CAMP_SHOW = 4;
  // A campaign row → the chat with the number that sent it, once they've written back to that number (until then there's
  // no conversation: WhatsApp only allows templates there)
  async function openCampChat(c, senderId, fromWindow = false) {
    const r = await guard(() => api('/contacts/' + encodeURIComponent(c.id) + '/threads'));
    const t = r?.threads.find((x) => x.senderId === senderId);
    if (!r) return;
    if (!t?.replied) return toast(`${nameOf(c)} hasn't replied to ${senderName(senderId)} yet, so there's no chat to open. Until they write back, WhatsApp only lets you send them a template.`, 'error');
    if (fromWindow) closeModal();
    showTab('inbox');
    window.Inbox?.open(t.key);
  }
  const campName = (n) => String(n || 'Campaign').replace(/\s+—\s+\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}.*$/, '');
  // A campaign's folder, in its colour from the Campaigns page (colorIndex: its place by creation date, from the server)
  const campFolder = (x) => `<span class="cp-ficon ctl-folder" style="--c:${x.colorIndex >= 0 && window.folderColorAt ? window.folderColorAt(x.colorIndex) : 'oklch(var(--fl) var(--fc) 250)'}" aria-hidden="true"><i class="cf-tab"></i><i class="cf-paper"></i><i class="cf-body"></i></span>`;
  // One campaign row (the panel's list and the All campaigns window): its folder; the name and when; the number and how
  // it went, with WhatsApp's mark; for a failed one, the reason and its code
  const campRow = (x) => `<li class="ctl-row ${esc(x.status)}" data-camp-sender="${esc(x.senderId || '')}" role="button" tabindex="0" title="${esc(`${x.name || 'Campaign'}\n${DELIVERY[x.status] || x.status}${x.at ? ' · ' + new Date(x.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : ''}\nClick to open the chat with ${senderName(x.senderId)}`)}">
      ${campFolder(x)}
      <div class="ctl-body"><div class="ctl-top"><b>${esc(campName(x.name))}</b><time>${esc(x.at ? relTime(x.at) : '')}</time></div>
      <div class="ctl-sub"><span class="ctl-sub-l">${esc(senderName(x.senderId))} · <span class="ctl-st">${waMark(x.status)}${esc(DELIVERY[x.status] || x.status)}</span></span>${x.error ? (errCode(x.error) ? `<code class="cd-ecode ctl-code" tabindex="0" data-ecode="${esc(errCode(x.error))}">${esc(errCode(x.error))}</code>` : `<span class="ctl-code ctl-code-txt" title="${esc(x.error)}">error</span>`) : ''}</div></div></li>`;
  const campSummary = (list) => {
    const n = (st) => list.filter((x) => x.status === st).length;
    return [['read', 'read'], ['delivered', 'delivered'], ['sent', 'sent'], ['failed', 'not delivered']].filter(([st]) => n(st)).map(([st, w]) => `<span class="ctl-sum-i ${st}">${waMark(st)}${n(st).toLocaleString()} ${w}</span>`).join('');
  };
  function campaignsHtml(c) {
    const list = [...(c.campaigns || [])].reverse();
    if (!list.length) return '';
    return `<div class="ct-psec"><div class="field-label ctl-h">Campaigns <span class="opt">${list.length}</span></div>
      <div class="ctl-sum">${campSummary(list)}</div>
      <ol class="ctl">${list.slice(0, CAMP_SHOW).map(campRow).join('')}</ol>
      ${list.length > CAMP_SHOW ? `<button type="button" class="ctl-more" data-camps-all>Show all ${list.length.toLocaleString()} campaigns</button>` : ''}</div>`;
  }
  // Show all: every campaign that messaged them, in a window: search, a filter by how it went, and the same rows
  // (a row opens that number's chat)
  function campaignsWindow(c) {
    const list = [...(c.campaigns || [])].reverse();
    let q = '', st = '';
    const body = openModal(`Campaigns · ${nameOf(c)}`, `<div class="ctw">
      <div class="ctw-bar"><div class="search-wrap" data-icon="search" data-icon-size="14"><input data-1p-ignore data-lpignore="true" data-form-type="other" autocomplete="off" class="search" id="ctwQ" placeholder="Search campaigns or numbers" /></div>
        <button type="button" class="ct-sortbtn ctw-stbtn" id="ctwSt" aria-haspopup="menu" title="Show by how it went"></button></div>
      <div class="ctw-sum ctl-sum">${campSummary(list)}</div>
      <ol class="ctl ctw-list" id="ctwList"></ol></div>`);
    $('#modal .modal-box').classList.add('wide', 'ctw-box');
    LA.hydrate(body);
    const STS = [['', 'All'], ['read', 'Read'], ['delivered', 'Delivered'], ['sent', 'Sent'], ['failed', 'Not delivered']].filter(([k]) => !k || list.some((x) => x.status === k));
    const draw = () => {
      const cur = STS.find(([k]) => k === st) || STS[0];
      $('#ctwSt', body).innerHTML = `${st ? waMark(st) : icon('sliders-horizontal', 14)}<span>${esc(cur[1])}</span><span class="ctw-n">${(st ? list.filter((x) => x.status === st).length : list.length).toLocaleString()}</span>${icon('chevron-down', 14)}`;
      $('#ctwSt', body).classList.toggle('on', Boolean(st));
      const qq = q.trim().toLowerCase();
      const shown = list.filter((x) => (!st || x.status === st) && (!qq || [x.name, senderName(x.senderId), x.error].some((v) => String(v || '').toLowerCase().includes(qq))));
      $('#ctwList', body).innerHTML = shown.map(campRow).join('') || '<p class="ctw-none">No campaigns match.</p>';
    };
    draw();
    $('#ctwQ', body).addEventListener('input', (e) => { q = e.target.value; draw(); });
    // How it went: a dropdown (each choice with WhatsApp's mark and its count)
    $('#ctwSt', body).addEventListener('click', (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      Sheet.Menu.open(r.left, r.bottom + 6, STS.map(([k, label]) => ({ label, checked: st === k, kbd: (k ? list.filter((x) => x.status === k).length : list.length).toLocaleString(), pre: `<span class="mi-ic">${k ? waMark(k) : icon('list', 14)}</span>`, action: () => { st = k; draw(); } })));
    });
    $('#ctwList', body).addEventListener('click', (e) => { const r = e.target.closest('[data-camp-sender]'); if (r && !e.target.closest('[data-ecode]')) openCampChat(c, r.dataset.campSender, true); });
    $('#ctwList', body).addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-camp-sender]')) { e.preventDefault(); e.target.click(); } });
    $('#ctwQ', body).focus();
  }

  // Tags dropdown (the contact panel): a search box with + beside it, then every tag with a tick box; several can be
  // ticked, each change saves at once. + (or Enter on a name that isn't a tag yet) makes that tag and puts it on them.
  function tagPicker(c, anchor, { set = null, onChange = null } = {}) {
    const sel = set || new Set(c?.tags || []);
    const r = anchor.getBoundingClientRect();
    const pop = Sheet.Menu.panel(r.left, r.bottom + 6, `<div class="ptm">
      <div class="ptm-top"><div class="search-wrap" data-icon="search" data-icon-size="14"><input data-1p-ignore data-lpignore="true" data-form-type="other" autocomplete="off" class="search" placeholder="Search or name a new tag" aria-label="Search tags" /></div>
        <button type="button" class="ptm-add" title="Make a new tag with this name" aria-label="New tag">${icon('plus', 16)}</button></div>
      <div class="ptm-list" role="listbox" aria-multiselectable="true"></div></div>`);
    LA.hydrate(pop);
    const input = $('input', pop), list = $('.ptm-list', pop);
    const save = () => (onChange ? onChange(sel) : patch(c, { tags: [...sel] }));
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const shown = CT.tags.filter((t) => !q || t.name.toLowerCase().includes(q));
      const exact = CT.tags.some((t) => t.name.toLowerCase() === q);
      list.innerHTML = shown.map((t) => `<label class="ptm-row ${sel.has(t.id) ? 'on' : ''}"><input type="checkbox" class="cb" value="${esc(t.id)}" ${sel.has(t.id) ? 'checked' : ''} /><i class="ct-dot tag-${esc(t.color)}"></i><span>${esc(t.name)}</span></label>`).join('')
        + (q && !exact ? `<button type="button" class="ptm-new" data-ptm-new>${icon('plus', 14)}<span>New tag “${esc(input.value.trim())}”</span></button>` : '')
        + (!shown.length && !q ? '<p class="ptm-none">No tags yet: type a name and press +.</p>' : '');
      Sheet.Menu.fit(pop, r);
    };
    const create = () => guard(async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return toast('Type the new tag’s name first'); }
      const had = CT.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
      const t = had || await api('/tags', { method: 'POST', body: { name } });
      if (!had) CT.tags.push(t);
      sel.add(t.id);
      input.value = '';
      draw();
      await save();
    });
    list.addEventListener('change', (e) => { const cb = e.target.closest('input[type=checkbox]'); if (!cb) return; cb.checked ? sel.add(cb.value) : sel.delete(cb.value); cb.closest('.ptm-row').classList.toggle('on', cb.checked); save(); });
    list.addEventListener('click', (e) => { if (e.target.closest('[data-ptm-new]')) create(); });
    $('.ptm-add', pop).addEventListener('click', create);
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = input.value.trim().toLowerCase();
      const match = CT.tags.filter((t) => t.name.toLowerCase().includes(q));
      const one = CT.tags.find((t) => t.name.toLowerCase() === q) || (match.length === 1 ? match[0] : null);
      if (!q) return;
      if (one) { sel.has(one.id) ? sel.delete(one.id) : sel.add(one.id); input.value = ''; draw(); save(); } else create();
    });
    draw();
    input.focus();
  }

  async function patch(c, body, msg) {
    await guard(async () => { await api('/contacts/' + c.id, { method: 'PUT', body }); await refresh(); if (msg) toast(msg); });
  }

  $('#ctPanel').addEventListener('click', async (e) => {
    const c = CT.cache.get(CT.openId);
    if (!c) return;
    if (e.target.closest('#ctPClose')) return closePanel();
    const st = e.target.closest('[data-set-status]');
    if (st && st.dataset.setStatus !== c.status) return patch(c, { status: st.dataset.setStatus });
    // Stage: a dropdown (each stage with its colour; the current one ticked)
    const stBtn = e.target.closest('[data-pstatus-menu]');
    if (stBtn) {
      e.stopPropagation();
      const r = stBtn.getBoundingClientRect();
      return Sheet.Menu.open(r.left, r.bottom + 6, Object.entries(STATUS).map(([k, v]) => ({ label: v.label, checked: c.status === k, pre: `<span class="mi-ic"><i class="ct-lab-dot st-${k}"></i></span>`, action: () => { if (k !== c.status) patch(c, { status: k }); } })));
    }
    const campRow = e.target.closest('[data-camp-sender]');
    if (campRow && !e.target.closest('[data-ecode]')) return openCampChat(c, campRow.dataset.campSender);
    if (e.target.closest('[data-camps-all]')) return campaignsWindow(c);
    const rm = e.target.closest('[data-ptag-rm]');
    if (rm) return patch(c, { tags: c.tags.filter((x) => x !== rm.dataset.ptagRm) });
    const tm = e.target.closest('[data-ptag-menu]');
    if (tm) { e.stopPropagation(); return tagPicker(c, tm); }
    const act = e.target.closest('[data-pact]')?.dataset.pact;
    if (act === 'send') return SendPage.openContacts([c], nameOf(c));
    if (act === 'chat') return chatWindow(c);
    if (act === 'edit') return open(c.id);
    if (act === 'delete') {
      if (!(await confirmDialog({ title: 'Delete this contact?', message: 'Their chats and campaign history stay.', confirmText: 'Delete', danger: true }))) return;
      await guard(async () => { await api('/contacts/delete', { method: 'POST', body: { ids: [c.id] } }); CT.openId = null; await refresh(); });
    }
  });
  $('#ctPanel').addEventListener('change', (e) => {
    const c = CT.cache.get(CT.openId);
    if (c && e.target.id === 'ctPOpt') patch(c, { optOut: e.target.checked }, e.target.checked ? 'Opted out: they won’t be messaged' : 'They can be messaged again');
  });
  $('#ctPanel').addEventListener('focusout', (e) => {
    const c = CT.cache.get(CT.openId);
    if (c && e.target.id === 'ctPNotes' && e.target.value !== (c.notes || '')) patch(c, { notes: e.target.value }, 'Notes saved');
  });
  $('#ctPanel').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-camp-sender]')) { e.preventDefault(); e.target.click(); } });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !CT.openId || $('#tab-contacts').classList.contains('hidden') || !$('#modal').classList.contains('hidden')) return;
    if (e.target.closest?.('input, textarea, select')) return;
    closePanel();
  });

  $('#ctSel').addEventListener('click', async (e) => {
    if (e.target.closest('[data-selall]')) return guard(async () => { const r = await api('/contacts?' + listQuery({ ids: 1, per: 10 })); r.ids.forEach((id) => CT.selected.add(id)); render(); });
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const ids = [...CT.selected];
    const act = b.dataset.act;
    if (act === 'clear') { CT.selected.clear(); return render(); }
    if (act === 'uncollect') return collectionUpdate(colById(CT.col), { remove: ids }, true);
    if (act === 'collect') {
      const r = b.getBoundingClientRect();
      return Sheet.Menu.open(r.left, r.bottom + 4, [
        ...CT.collections.filter((x) => x.id !== CT.col).map((x) => ({ label: x.name, kbd: x.count.toLocaleString(), pre: `<span class="mi-ic">${colFolder(x, 'xs')}</span>`, action: () => collectionUpdate(x, { add: ids }) })),
        ...(CT.collections.some((x) => x.id !== CT.col) ? ['-'] : []),
        { label: 'New collection…', action: () => collectionModal(null, ids) },
      ]);
    }
    if (act === 'send') {
      const list = (await guard(() => api('/contacts/by-ids', { method: 'POST', body: { ids } })))?.contacts.filter((c) => !c.optOut) || [];
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

  async function refresh() { if (await load()) render(); }

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
      await guard(async () => { await api('/tags/' + t.id, { method: 'DELETE' }); CT.fs.tag.delete(t.id); await refresh(); });
    };
  }

  // --- One contact ---------------------------------------------------------------

  // opts.onSaved: called after the form saves or deletes (e.g. the Inbox's Contact info refreshing itself).
  function open(contactId, opts = {}) {
    const c = contactId ? CT.cache.get(contactId) : null;
    if (contactId && !c) return getContact(contactId).then((x) => (x ? open(contactId, opts) : toast('Contact not found', 'error')));
    const chatKey = c && CT.chats.get(c.phone);
    const tags = new Set(c?.tags || []);
    const lead = c?.lead || {};
    // A contact page you edit in place, not a form: the name is the title, details read as text until you point at them,
    // the stage is chips, opting out is a quiet row at the end. (The fields keep their names: the save below reads them.)
    const MAIL = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>';
    const ORG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>';
    const row = (ico, input, label) => `<label class="cte-row"><span class="cte-ico" title="${label}">${ico}</span>${input}</label>`;
    const status = c?.status || 'new';
    const body = openModal(c ? 'Edit contact' : 'Add contact(s)', `
      <form id="ctForm" class="cte">
        ${c ? '' : `<button type="button" class="cte-imp" data-cte-import>${icon('upload', 18)}<span><b>Adding many?</b><small>Import them from an Excel or CSV sheet: every sheet, merged by phone number.</small></span><span class="cte-imp-go">Import${icon('arrow-right', 15)}</span></button>
        <div class="cte-or"><span>or add one</span></div>`}
        <div class="cte-head">
          ${c ? avatar(c, 'xl') : `<span class="ct-av xl cte-av-new">${icon('user', 26)}</span>`}
          <div class="cte-id">
            <input class="cte-name" name="name" value="${esc(c?.name || '')}" placeholder="Their name" aria-label="Name" autocomplete="off" />
            <span class="cte-sub">${c ? esc([fmtPhone(c.phone), c.createdAt && 'added ' + new Date(c.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })].filter(Boolean).join(' · ')) : 'A new contact'}</span>
          </div>
        </div>

        <div class="cte-sec">
          <div class="cte-label">Details</div>
          <div class="cte-rows">
            ${row(icon('phone', 16), `<input name="phone" value="${esc(c ? '+' + c.phone : '')}" required inputmode="tel" maxlength="22" autocomplete="tel" placeholder="Phone, e.g. +91 98765 43210" aria-label="Phone" />`, 'Phone')}
            ${row(MAIL, `<input name="email" type="email" value="${esc(c?.email || '')}" placeholder="Add email" aria-label="Email" autocomplete="off" />`, 'Email')}
            ${row(ORG, `<input name="company" value="${esc(c?.company || '')}" placeholder="Add company" aria-label="Company" autocomplete="off" />`, 'Company')}
          </div>
        </div>

        <div class="cte-sec">
          <div class="cte-label">Stage</div>
          <div class="cte-chips" role="radiogroup" aria-label="Stage">${Object.entries(STATUS).map(([k, v]) => `<label class="ct-tag cte-chip"><input type="radio" name="status" value="${k}" ${status === k ? 'checked' : ''} /><span>${v.label}</span></label>`).join('')}</div>
        </div>

        <div class="cte-sec">
          <div class="cte-label cte-label-row">Tags<button type="button" class="cte-tag-add" id="ctTagAdd" title="Add or remove tags" aria-label="Add or remove tags" aria-haspopup="dialog">${icon('plus', 15)}</button></div>
          <div class="ct-ptags cte-tags" id="ctPick"></div>
        </div>

        <div class="cte-sec">
          <div class="cte-label">Notes</div>
          <textarea class="cte-notes" name="notes" rows="3" placeholder="Anything to remember about them">${esc(c?.notes || '')}</textarea>
        </div>

        ${lead.summary || lead.need || lead.budget || lead.timeline ? `<div class="ct-leadbox cte-sec"><div class="pc-label">From the lead assistant</div>
          ${lead.summary ? `<p>${esc(lead.summary)}</p>` : ''}
          <dl>${[['Need', lead.need], ['Budget', lead.budget], ['Timeline', lead.timeline]].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>` : ''}
        ${c && Object.keys(c.extra || {}).length ? `<details class="ct-extra cte-sec"><summary>Other details (${Object.keys(c.extra).length})</summary><dl>${Object.entries(c.extra).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>` : ''}

        <label class="cte-optout"><span class="cte-ico">${icon('ban', 16)}</span><span class="cte-optout-t"><b>Opted out</b><small>They’re never messaged while this is on.</small></span>${toggleHtml({ checked: c?.optOut, attrs: 'name="optOut"', size: 'sm' })}</label>

        <div class="modal-actions cte-actions">
          ${c ? `<button type="button" class="btn quiet danger" id="ctDel" style="margin-right:auto">Delete</button>` : ''}
          <button type="button" class="btn quiet" id="ctCancel">Cancel</button>
          <button class="btn primary">${c ? 'Save' : 'Add contact'}</button>
        </div>
      </form>`);
    LA.hydrate(body);
    const drawPick = () => {
      $('#ctPick', body).innerHTML = [...tags].map(tagById).filter(Boolean).map((t) => `<span class="tag-chip tag-${esc(t.color)} ct-ptag">${esc(t.name)}<button type="button" data-pick-rm="${esc(t.id)}" aria-label="Remove ${esc(t.name)}" title="Remove">${icon('x', 11)}</button></span>`).join('') || '<span class="ct-ptags-none">No tags</span>';
    };
    drawPick();
    $('#ctPick', body).addEventListener('click', (e) => { const b = e.target.closest('[data-pick-rm]'); if (b) { tags.delete(b.dataset.pickRm); drawPick(); } });
    $('#ctTagAdd', body).addEventListener('click', (e) => { e.stopPropagation(); tagPicker(c, e.currentTarget, { set: tags, onChange: drawPick }); });
    $('#ctCancel', body).onclick = closeModal;
    $('#modal .modal-box').classList.add('cte-box');
    if (!c) $('.cte-name', body).focus();
    if (c) $('#ctDel', body).onclick = async () => {
      closeModal();
      if (!(await confirmDialog({ title: 'Delete this contact?', message: 'Their chats and campaign history stay.', confirmText: 'Delete', danger: true }))) return;
      await guard(async () => { await api('/contacts/delete', { method: 'POST', body: { ids: [c.id] } }); await refresh(); opts.onSaved?.(); });
    };
    $('[data-cte-import]', body)?.addEventListener('click', () => importModal()); // Add contact(s): the sheet import, from the same window
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
        opts.onSaved?.();
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

    let existing = new Set();
    api('/contacts?phones=1').then((r) => { existing = new Set(r.phones); }).catch(() => {});
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
  $('#ctAdd').addEventListener('click', () => open(null));

  // --- Collections --------------------------------------------------------------------
  // A collection is a named list of contacts. The toolbar's Collections button switches the page between everyone
  // and one collection; while one is shown, the bar under the toolbar names it (rename, send, export, delete).

  const colById = (cid) => CT.collections.find((x) => x.id === cid) || null;
  // A collection shows as a folder, coloured like the Campaigns folders by its place in creation order
  const colFolder = (col, size = '') => {
    const i = CT.collections.indexOf(col);
    const c = i >= 0 && window.folderColorAt ? window.folderColorAt(i) : 'oklch(var(--fl) var(--fc) 250)';
    return `<span class="cp-ficon ${size}" style="--c:${c}" aria-hidden="true"><i class="cf-tab"></i><i class="cf-paper"></i><i class="cf-body"></i></span>`;
  };
  const fileBase = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'collection';
  function showCollection(cid) {
    CT.col = cid || null;
    CT.selected.clear();
    CT.page = 0;
    CT.enter = true;
    reload();
  }
  function renderCollection() {
    const col = colById(CT.col);
    const b = $('#ctColBtn');
    b.innerHTML = `${col ? colFolder(col, 'xs') : icon('layers', 14)}<span>${esc(col ? col.name : 'All contacts')}</span>${icon('chevron-down', 14)}`;
    b.classList.toggle('on', Boolean(col));
    b.title = col ? `Showing the collection “${col.name}”. Click to switch.` : 'Collections: named lists of contacts you put together';
    const bar = $('#ctColBar');
    bar.classList.toggle('hidden', !col);
    bar.innerHTML = col ? `${colFolder(col)}
      <span class="ct-colbar-t"><b>${esc(col.name)}</b><span class="muted">${col.count.toLocaleString()} contact${col.count === 1 ? '' : 's'}</span></span>
      <span class="ct-sel-actions">
        <button class="btn sm" data-col="send" data-icon="send" data-icon-size="13" ${col.count ? '' : 'disabled'}>Send a message</button>
        <button class="btn sm" data-col="export" data-icon="download" data-icon-size="13" ${col.count ? '' : 'disabled'}>Export</button>
        <button class="btn sm quiet" data-col="rename" data-icon="square-pen" data-icon-size="13">Rename</button>
        <button class="btn sm quiet danger" data-col="delete" data-icon="delete" data-icon-size="13">Delete</button>
        <button class="btn sm quiet" data-col="close" title="Back to all contacts" aria-label="Back to all contacts">${icon('x', 14)}</button>
      </span>` : '';
    LA.hydrate(bar);
  }
  $('#ctColBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    Sheet.Menu.open(r.left, r.bottom + 6, [
      { label: 'All contacts', kbd: (CT.all || 0).toLocaleString(), checked: !CT.col, pre: `<span class="mi-ic">${icon('users', 15)}</span>`, action: () => showCollection(null) },
      ...(CT.collections.length ? ['-'] : []),
      ...CT.collections.map((x) => ({ label: x.name, kbd: x.count.toLocaleString(), checked: CT.col === x.id, pre: `<span class="mi-ic">${colFolder(x, 'xs')}</span>`, action: () => showCollection(x.id) })),
      '-',
      { label: CT.selected.size ? `New collection from ${CT.selected.size.toLocaleString()} selected…` : 'New collection…', pre: `<span class="mi-ic">${icon('plus', 15)}</span>`, action: () => collectionModal(null, [...CT.selected]) },
    ]);
  });
  $('#ctColBar').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-col]');
    const col = colById(CT.col);
    if (!b || !col) return;
    const act = b.dataset.col;
    if (act === 'close') return showCollection(null);
    if (act === 'rename') return collectionModal(col);
    if (act === 'export') return $('#ctExport').click();
    if (act === 'send') {
      const list = (await guard(() => api('/contacts?' + new URLSearchParams({ col: col.id, per: 0, page: 0 }))))?.contacts.filter((c) => !c.optOut) || [];
      if (!list.length) return toast('Everyone in this collection has opted out', 'error');
      return SendPage.openContacts(list, col.name);
    }
    if (act === 'delete') {
      const ok = await confirmDialog({ title: `Delete “${esc(col.name)}”?`, message: 'Only the collection goes. Its contacts stay in Contacts.', confirmText: 'Delete', danger: true });
      if (!ok) return;
      return guard(async () => { await api('/collections/' + col.id, { method: 'DELETE' }); toast('Collection deleted'); showCollection(null); });
    }
  });
  // Put contacts in (add) or take them out (remove); cleared: drop the selection afterwards (they've left the view)
  function collectionUpdate(col, body, cleared = false) {
    if (!col) return;
    return guard(async () => {
      const r = await api('/collections/' + col.id, { method: 'PUT', body });
      if (cleared) CT.selected.clear();
      await refresh();
      const n = body.add ? r.added : r.removed, s = n === 1 ? '' : 's';
      toast(body.add ? (n ? `Added ${n.toLocaleString()} contact${s} to “${r.name}”` : `They're already in “${r.name}”`) : `Removed ${n.toLocaleString()} contact${s} from “${r.name}”`);
    });
  }
  // New (with these contacts in it) or rename
  function collectionModal(col, ids = []) {
    const body = openModal(col ? 'Rename collection' : 'New collection', `
      <label>Name<input id="clName" value="${esc(col?.name || '')}" maxlength="60" placeholder="e.g. Diwali offer list, Hyderabad clinics" /></label>
      ${col ? '' : `<p class="muted" style="margin:0">${ids.length ? `${ids.length.toLocaleString()} selected contact${ids.length === 1 ? '' : 's'} will be put in it.` : 'It starts empty: select contacts and choose “Add to collection”.'}</p>`}
      <div class="modal-actions"><button class="btn quiet" id="clCancel">Cancel</button><button class="btn primary" id="clSave">${col ? 'Save' : 'Create collection'}</button></div>`);
    $('#clName', body).focus();
    $('#clCancel', body).onclick = closeModal;
    const saveIt = (e) => guard(async () => {
      const name = $('#clName', body).value;
      const saved = col ? await api('/collections/' + col.id, { method: 'PUT', body: { name } }) : await api('/collections', { method: 'POST', body: { name, ids } });
      closeModal();
      if (col) { await refresh(); return toast('Renamed'); }
      toast(saved.added ? `Created “${saved.name}” with ${saved.added.toLocaleString()} contact${saved.added === 1 ? '' : 's'}` : `Created “${saved.name}”`);
      showCollection(saved.id); // show it straight away
    }, e?.currentTarget);
    $('#clSave', body).onclick = saveIt;
    $('#clName', body).addEventListener('keydown', (e) => e.key === 'Enter' && saveIt());
  }

  // --- Export -------------------------------------------------------------------------

  async function exportRows() {
    const list = CT.selected.size ? (await api('/contacts/by-ids', { method: 'POST', body: { ids: [...CT.selected] } })).contacts : (await api('/contacts?' + listQuery({ per: 0, page: 0 }))).contacts;
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
    const col = colById(CT.col);
    const label = CT.selected.size ? `${CT.selected.size} selected` : col ? (filterCount() || CT.q ? `“${col.name}”, filtered` : `“${col.name}”`) : filterCount() || CT.q ? 'the filtered list' : 'everyone';
    const date = new Date().toISOString().slice(0, 10);
    const base = col ? fileBase(col.name) : 'contacts';
    Sheet.Menu.open(r.left, r.bottom + 4, [
      { label: `CSV · ${label}`, action: () => guard(async () => {
        const { head, rows } = await exportRows();
        const q = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
        download(new Blob(['﻿' + [head, ...rows].map((r) => r.map(q).join(',')).join('\n')], { type: 'text/csv' }), `${base}-${date}.csv`);
      }) },
      { label: `Excel · ${label}`, action: () => guard(async () => {
        const XLSX = await loadXlsxLib();
        const { head, rows } = await exportRows();
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...rows]), col ? col.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) : 'Contacts');
        XLSX.writeFile(wb, `${base}-${date}.xlsx`);
      }) },
    ]);
  });

  window.Contacts = {
    async show() {
      if (!CT.loaded) $('#ctList').innerHTML = CT.view === 'cards' ? Skel.person(12) : Skel.table(8);
      await guard(load);
      render();
    },
    open: async (id, opts) => { if (!CT.loaded) await load(); open(id, opts); },
    byPhone: (phone) => [...CT.cache.values()].find((c) => c.phone === phone),
    tags: () => CT.tags,
    refresh: () => (CT.loaded ? refresh() : load()),
  };
  // Tags are needed by the Send page and Inbox even before this page is opened.
  load().catch(() => {});
})();
