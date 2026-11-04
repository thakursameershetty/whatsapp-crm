// Campaigns page. The list: a 30-day summary, live and scheduled sends pinned on top, then
// a compact table you can search, filter and sort. A campaign: what was sent, the funnel
// from sent to leads, deliveries over time, failures by reason, follow-ups, and every
// recipient in a read-only sheet. Uses helpers from app.js, sheet.js and send.js.

(function () {
  const CP = {
    list: [], filter: 'all', sort: 'new', q: '', detail: null, show: 'all', sample: 0, chartTable: false, date: null, calMonth: null, calOpen: null,
    view: (() => { try { return localStorage.getItem('campView') || 'cards'; } catch { return 'cards'; } })(),
    // how many campaigns a page shows (0 = all), chosen in the header; the page resets when the filters change
    per: (() => { try { const n = localStorage.getItem('campPer'); return n == null ? 50 : Number(n) || 0; } catch { return 50; } })(),
    page: 0, pageSig: '',
  };
  const PER_PAGE = [25, 50, 100, 200, 0];
  // Auto-made names end in the date ("name_msg — 10/16/2026, 2:06:04 PM"); the date is shown anyway.
  const displayName = (c) => String(c.name).replace(/\s+—\s+\d{1,2}\/\d{1,2}\/\d{2,4},.*$/, '') || c.name;
  // Campaigns using the same template share a folder colour.
  const folderColors = new Map();
  // Each campaign gets its own pastel from the whole colour wheel: campaigns are numbered by
  // creation date and each one steps the golden angle (137.5°) from the last, so neighbours
  // always differ. OKLCH keeps every hue at the same perceived lightness; yellows and greens
  // get a touch more light so they don't turn muddy. --fl / --fc are set per theme in style.css.
  function folderColorAt(i) {
    const hue = Math.round(20 + i * 137.508) % 360;
    const lift = hue >= 70 && hue <= 150 ? 0.06 : hue >= 220 && hue <= 290 ? -0.01 : 0;
    return `oklch(calc(var(--fl) + ${lift}) var(--fc) ${hue})`;
  }
  function assignColors(list) {
    const order = [...list].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    order.forEach((c, i) => folderColors.set(c.id, folderColorAt(i)));
  }
  // The overview's Recent campaigns uses the same colours and names (the server sends each campaign's colorIndex).
  window.folderColorAt = folderColorAt;
  window.campaignDisplayName = displayName;
  const colorOf = (c) => folderColors.get(c.id) || 'oklch(var(--fl) var(--fc) 250)';
  let pollTimer = null;
  const stop = () => { clearTimeout(pollTimer); pollTimer = null; };

  const sentOf = (s = {}) => (s.sent || 0) + (s.delivered || 0) + (s.read || 0);
  const deliveredOf = (s = {}) => (s.delivered || 0) + (s.read || 0);
  const live = (c) => c.status === 'running' || c.status === 'queued';
  const pctOf = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  // A share that's never shown as 0% when there's something there: one decimal under 10% (0.4%), "under 0.1%" below
  // that, whole numbers above (43%). For the results card's headline and hover card.
  const shareOf = (a, b) => {
    if (!b || !a) return '0%';
    const p = (100 * a) / b;
    return p < 0.1 ? 'under 0.1%' : p < 10 ? p.toFixed(1).replace(/\.0$/, '') + '%' : Math.round(p) + '%';
  };

  function shortDate(d) {
    if (!d) return '—';
    const t = new Date(d), now = new Date();
    const time = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const days = Math.round((new Date(now.toDateString()) - new Date(t.toDateString())) / 86400000);
    if (days === 0) return `Today ${time}`;
    if (days === 1) return `Yesterday ${time}`;
    if (days === -1) return `Tomorrow ${time}`;
    return t.toLocaleDateString([], { day: 'numeric', month: 'short', ...(t.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  }
  const fullDate = (d) => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const STATUS_LABEL = { running: 'Sending', queued: 'Starting', scheduled: 'Scheduled', completed: 'Completed', stopped: 'Stopped', cancelled: 'Cancelled' };

  // --- List --------------------------------------------------------------------

  // The page asks the server for just what it shows: one page (or the calendar's month) after search, status, number,
  // dates and sort, with the counts, the sending/scheduled cards and the 30-day summary. (GET /api/campaigns?page=…)
  let loadSeq = 0;
  // The request for a view ('calendar' asks for its month, cards and table for the page).
  function listUrl(view = CP.view) {
    const p = new URLSearchParams({ q: CP.q, filter: CP.filter, sender: CP.sender || '', sort: CP.sort, tz: String(new Date().getTimezoneOffset()) });
    if (CP.date) p.set('dates', JSON.stringify(CP.date));
    if (view === 'calendar') {
      p.set('view', 'calendar');
      if (CP.calMonth) p.set('month', `${CP.calMonth.getFullYear()}-${String(CP.calMonth.getMonth() + 1).padStart(2, '0')}`);
    } else { p.set('page', String(CP.page)); p.set('per', String(CP.per)); }
    return '/campaigns?' + p;
  }
  // Answers kept by request, so switching between the list and the calendar is instant (and then refreshed).
  const listCache = new Map();
  function useRes(r) {
    CP.res = r;
    if (r.page != null) CP.page = r.page;
    if (r.month) { const [y, m] = r.month.split('-').map(Number); CP.calMonth = new Date(y, m - 1, 1); }
    CP.list = [...r.pinned, ...r.items];
    for (const c of CP.list) folderColors.set(c.id, folderColorAt(c.colorIndex ?? 0));
  }
  async function fetchList() {
    const seq = ++loadSeq, url = listUrl();
    const r = await api(url);
    listCache.set(url, r);
    if (listCache.size > 20) listCache.delete(listCache.keys().next().value);
    if (seq !== loadSeq) return false; // a newer request is on its way
    useRes(r);
    return true;
  }
  // Quietly get the other view ready (the calendar's month while on the list, the page while on the calendar).
  let prefetchT = 0;
  function prefetchOther() {
    clearTimeout(prefetchT);
    prefetchT = setTimeout(() => {
      const url = listUrl(CP.view === 'calendar' ? 'cards' : 'calendar');
      if (!listCache.has(url)) api(url).then((r) => listCache.set(url, r)).catch(() => {});
    }, 600);
  }
  async function load() {
    if (!(await fetchList())) return;
    if (CP.detail) return open(CP.detail);
    renderList();
    prefetchOther();
    stop();
    if (CP.res.live || CP.res.scheduled) pollTimer = setTimeout(() => load().catch(() => {}), CP.res.live ? 2000 : 15000);
  }
  // a filter, search, sort or date changed: back to the first page
  const refilter = () => { CP.page = 0; return load().catch((e) => toast(e.message, 'error')); };
  let searchT = 0;

  const FILTERS = [
    ['all', 'All', () => true],
    ['completed', 'Completed', (c) => c.status === 'completed'],
    ['stopped', 'Stopped', (c) => c.status === 'stopped' || c.status === 'cancelled'],
    ['tests', 'Tests', (c) => Boolean(c.test)], // shown only when there are some
  ];
  const TEST_PILL = '<span class="pill test" title="A test send: left out of the Overview’s numbers">Test</span>';
  const SORTS = {
    new: ['Newest', (a, b) => String(b.startedAt || b.createdAt).localeCompare(String(a.startedAt || a.createdAt))],
    old: ['Oldest', (a, b) => String(a.startedAt || a.createdAt).localeCompare(String(b.startedAt || b.createdAt))],
    size: ['Most recipients', (a, b) => b.total - a.total],
    read: ['Best read rate', (a, b) => pctOf(b.stats?.read || 0, deliveredOf(b.stats)) - pctOf(a.stats?.read || 0, deliveredOf(a.stats))],
    replies: ['Most replies', (a, b) => (b.replies || 0) - (a.replies || 0)],
  };

  // A campaign's day, for the date filter and the calendar: when it went out, or is scheduled to, or was made.
  const dayOf = (c) => c.startedAt || c.scheduledAt || c.createdAt;

  // Time left for a live send, from its pace so far.
  function eta(c) {
    const s = c.stats || {};
    const done = sentOf(s) + (s.failed || 0);
    const left = c.total - done;
    if (!c.startedAt || !done || left <= 0) return '';
    const secs = ((Date.now() - new Date(c.startedAt)) / done) * left / 1000;
    return secs < 60 ? 'under a minute left' : secs < 3600 ? `about ${Math.round(secs / 60)} min left` : `about ${Math.round(secs / 3600)} h left`;
  }

  function renderList() {
    const el = $('#campaignList');
    el.classList.remove('hidden');
    $('#campaignDetail').classList.add('hidden');
    const R = CP.res || { any: 0 };
    if (!R.any) {
      // Same header as when there are campaigns, so the page always says where you are.
      el.innerHTML = `<div class="section-head"><div><h1>Campaigns</h1><p class="sub">Every bulk send you make, with its delivery, reads, replies and leads.</p></div><button class="btn primary" data-goto="send">${icon('plus', 16)}New campaign</button></div>` + emptyState({ icon: 'send', title: 'No campaigns yet', text: 'Every bulk send shows up here: delivery, reads, replies and the leads they bring in.', actions: `<button class="btn primary" data-goto="send">${icon('plus', 16)}Create a campaign</button>` });
      return;
    }
    const pinned = R.pinned;
    const filter = FILTERS.find((f) => f[0] === CP.filter) || FILTERS[0];
    const q = CP.q.toLowerCase();
    // (one page from the server; the calendar gets its month)
    const shown = CP.view === 'calendar' ? [] : R.items;
    const total = R.total;
    const pages = R.pages || 1;
    const from = R.per ? CP.page * R.per : 0;
    const pager = pages > 1 && CP.view !== 'calendar' ? `<div class="cp-pager">
        <span>${(from + 1).toLocaleString()}–${(from + shown.length).toLocaleString()} of ${total.toLocaleString()}</span>
        <div class="seg"><button type="button" data-cp-page="-1" ${CP.page ? '' : 'disabled'} aria-label="Previous page">${icon('arrow-left', 14)}</button><span>Page ${CP.page + 1} of ${pages}</span><button type="button" data-cp-page="1" ${CP.page < pages - 1 ? '' : 'disabled'} aria-label="Next page">${icon('arrow-right', 14)}</button></div>
      </div>` : '';
    // the calendar shows sending and scheduled campaigns too, on their days (the server sends the month's)
    const calRows = CP.view === 'calendar' ? R.items : [];
    // The last 30 days, in the current mode, tests left out (as on the Overview): worked out by the server.
    const T = R.summary, testsOut = T.testsOut;

    // (kept from the last draw, so a redraw doesn't flicker between one and two rows; fitHead corrects it right after)
    const wasBelow = $('#campaignList > .section-head')?.classList.contains('tools-below');
    const statusCount = (fn) => R.counts[FILTERS.find((f) => f[2] === fn)[0]] || 0;
    el.innerHTML = `
      <div class="section-head has-tools${wasBelow ? ' tools-below' : ''}"><div><h1>Campaigns</h1>
        <p class="sub cp-summary" title="Last 30 days: ${T.sent.toLocaleString()} sent, ${pctOf(T.del, T.sent)}% delivered, ${pctOf(T.read, T.del)}% read, ${T.rep.toLocaleString()} replies, ${T.leads.toLocaleString()} leads${testsOut ? ` (${testsOut} test${testsOut === 1 ? '' : 's'} not counted)` : ''}">Last 30 days · <b>${T.sent.toLocaleString()}</b> sent · <b>${pctOf(T.del, T.sent)}%</b> delivered · <b>${pctOf(T.read, T.del)}%</b> read · <b>${T.rep.toLocaleString()}</b> repl${T.rep === 1 ? 'y' : 'ies'} · <b>${T.leads.toLocaleString()}</b> lead${T.leads === 1 ? '' : 's'}${testsOut ? ` <span class="cp-tests-out">· ${testsOut} test${testsOut === 1 ? '' : 's'} not counted</span>` : ''}</p></div>
        <div class="in-head cp-tools">
        <div class="search-wrap" data-icon="search" data-icon-size="15"><input data-1p-ignore data-lpignore="true" data-form-type="other" autocomplete="off" class="search" id="cpSearch" placeholder="Search campaigns" title="Search by campaign or template name" value="${esc(CP.q)}" aria-label="Search campaigns" /></div>
        <select id="cpFilter" aria-label="Status" title="Status">${FILTERS.filter(([k, , fn]) => k !== 'tests' || k === filter[0] || statusCount(fn)).map(([k, label, fn]) => `<option value="${k}" ${k === filter[0] ? 'selected' : ''}>${k === 'all' ? 'All campaigns' : label} (${statusCount(fn)})</option>`).join('')}</select>
        ${DateFilter.button(CP.date, 'cpDate')}
        ${state.senders.length > 1 ? `<select id="cpSender" aria-label="Number" title="Sent from"><option value="">All numbers</option>${state.senders.map((x) => `<option value="${x.id}" ${x.id === CP.sender ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>` : ''}
        <button type="button" class="ct-sortbtn cp-display-start" id="cpSortBtn" aria-haspopup="menu" title="Sorted by ${esc(SORTS[CP.sort][0])}. Click to change.">${icon('arrow-up-down', 14)}<span>${esc(SORTS[CP.sort][0])}</span>${icon('chevron-down', 14)}</button>
        ${CP.view === 'calendar' ? '' : `<select id="cpPer" aria-label="Campaigns per page" title="How many campaigns a page shows">${PER_PAGE.map((n) => `<option value="${n}" ${n === CP.per ? 'selected' : ''}>${n ? `${n} / page` : 'Show all'}</option>`).join('')}</select>`}
        <div class="seg seg-icons cp-view" id="cpView" role="radiogroup" aria-label="View">
          <button data-view="cards" class="${CP.view === 'cards' ? 'active' : ''}" title="Cards" aria-label="Cards" aria-checked="${CP.view === 'cards'}" role="radio">${icon('layout-grid', 15)}</button>
          <button data-view="table" class="${CP.view === 'table' ? 'active' : ''}" title="Table" aria-label="Table" aria-checked="${CP.view === 'table'}" role="radio">${icon('list', 15)}</button>
          <button data-view="calendar" class="${CP.view === 'calendar' ? 'active' : ''}" title="Calendar" aria-label="Calendar" aria-checked="${CP.view === 'calendar'}" role="radio">${icon('calendar-days', 15)}</button>
        </div>
      </div>
        <div class="row tight cp-head-actions"><button class="btn primary" data-goto="send">${icon('plus', 16)}New campaign</button></div></div>
      ${pinned.length ? `<div class="cp-pinned">${pinned.map(pinnedCard).join('')}</div>` : ''}
      ${CP.view === 'calendar' ? calendarHtml(calRows) : CP.view === 'cards'
        ? `<div class="cp-folders">${shown.map(folderHtml).join('')}</div>${!total ? `<p class="sub cp-none">${q || CP.date || CP.sender || CP.filter !== 'all' ? 'No campaigns match.' : 'Nothing here yet.'}</p>` : ''}${pager}`
        : `<div class="card cp-card">
        <table class="data-table cp-table">
          <thead><tr class="heads"><th>Campaign</th><th class="num">Recipients</th><th>Delivered</th><th class="num">Read</th><th class="num">Replies</th><th class="num">Leads</th><th>Date</th></tr></thead>
          <tbody>${total ? shown.map(rowHtml).join('') : `<tr><td colspan="7" class="table-empty">${q ? 'No campaigns match.' : 'Nothing here yet.'}</td></tr>`}</tbody>
        </table>
      </div>${pager}`}`;
    LA.hydrate(el);
    Motion.segs(el);
    window.fitHead?.($('#campaignList > .section-head'));
    $('#cpFilter').onchange = (e) => { CP.filter = e.target.value; refilter(); };
    const search = $('#cpSearch');
    // (asks the server after a short pause in typing; the box keeps focus and caret across the redraw)
    search.oninput = () => { CP.q = search.value.trim(); clearTimeout(searchT); searchT = setTimeout(async () => { const pos = $('#cpSearch')?.selectionStart; await refilter(); const s2 = $('#cpSearch'); if (s2 && pos != null) { s2.focus(); s2.setSelectionRange(pos, pos); } }, 250); };
    $('#cpSortBtn').onclick = (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      Sheet.Menu.open(r.left, r.bottom + 6, Object.entries(SORTS).map(([k, [label]]) => ({ label, checked: k === CP.sort, action: () => { CP.sort = k; refilter(); } })));
    };
    if ($('#cpPer')) $('#cpPer').onchange = (e) => { CP.per = Number(e.target.value) || 0; try { localStorage.setItem('campPer', String(CP.per)); } catch {} refilter(); };
    if ($('#cpSender')) $('#cpSender').onchange = (e) => { CP.sender = e.target.value; refilter(); };
    $('#cpDate').onclick = (e) => {
      if (e.target.closest('[data-df-clear]')) { CP.date = null; return refilter(); }
      const marks = new Map(Object.entries(R.days || {}));
      DateFilter.open(e.currentTarget, { value: CP.date, marks, onChange: (v) => {
        CP.date = v;
        // the calendar follows the choice to its month
        if (v) { const k = v.days ? v.days.at(-1) : v.to; const [y, m] = k.split('-').map(Number); CP.calMonth = new Date(y, m - 1, 1); }
        refilter();
      } });
    };
  }

  // ── Calendar view: the month, each campaign a small folder chip on its day (sent, sending or scheduled). Switching
  // views morphs each folder (or row) into its chip: they share a view-transition name (--vt). Up to three chips a day;
  // "+N more" opens the day.
  function calendarHtml(list) {
    const byDay = new Map();
    for (const c of list) { const k = DateFilter.keyOf(new Date(dayOf(c))); (byDay.get(k) || byDay.set(k, []).get(k)).push(c); }
    for (const cs of byDay.values()) cs.sort((a, b) => String(dayOf(a)).localeCompare(String(dayOf(b))));
    if (!CP.calMonth) CP.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1); // (the server picks the month)
    const m = CP.calMonth, today = DateFilter.keyOf(new Date());
    const first = new Date(m.getFullYear(), m.getMonth(), 1 - m.getDay()); // the Sunday on or before the 1st
    const weeks = Math.ceil((m.getDay() + new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()) / 7);
    const inMonth = list.filter((c) => { const d = new Date(dayOf(c)); return d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth(); }).length;
    const chip = (c) => {
      const s = c.stats || {}, del = deliveredOf(s);
      const note = live(c) ? 'Sending' : c.status === 'scheduled' ? new Date(c.scheduledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : del ? pctOf(s.read || 0, del) + '% read' : (STATUS_LABEL[c.status] || c.status);
      return `<button type="button" class="cp-cal-chip ${c.status}${c.test ? ' is-test' : ''}" data-open="${c.id}" style="--vt:cp-${c.id};--c:${colorOf(c)}" title="${esc(c.name)} · ${c.total.toLocaleString()} recipients">${miniFolder(c)}<span class="cp-cal-t"><b>${esc(displayName(c))}</b><small>${c.test ? 'Test · ' : ''}${esc(note)}</small></span></button>`;
    };
    let cells = '';
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i), k = DateFilter.keyOf(d);
      const cs = byDay.get(k) || [], shown = cs.slice(0, 3);
      cells += `<div class="cp-cal-day ${d.getMonth() !== m.getMonth() ? 'out' : ''} ${k === today ? 'today' : ''}" data-day="${k}" title="Open ${esc(d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}">
        <span class="cp-cal-n">${d.getDate()}</span>
        ${shown.map(chip).join('')}
        ${cs.length > 3 ? `<button type="button" class="cp-cal-more" data-calday="${k}">+${cs.length - 3} more</button>` : ''}
      </div>`;
    }
    return `<div class="card cp-cal">
      <div class="cp-cal-head">
        <button type="button" class="dt-nav" data-calnav="-1" aria-label="Previous month">‹</button>
        <button type="button" class="sch-title cp-cal-title" data-calpick aria-label="Choose the month and year">${esc(m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}${icon('chevron-down', 14)}</button>
        <button type="button" class="dt-nav" data-calnav="1" aria-label="Next month">›</button>
        <span class="sub">${inMonth ? inMonth + ' campaign' + (inMonth === 1 ? '' : 's') + ' this month' : 'No campaigns this month'}</span>
        <button type="button" class="btn sm quiet" data-calnav="0">Today</button>
      </div>
      <div class="cp-cal-week">${[...Array(7)].map((_, i) => `<span>${esc(new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }))}</span>`).join('')}</div>
      <div class="cp-cal-grid">${cells}</div>
    </div>`;
  }
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('#campaignList [data-calnav]');
    if (nav) {
      const n = Number(nav.dataset.calnav), m = CP.calMonth || new Date();
      CP.calMonth = n ? new Date(m.getFullYear(), m.getMonth() + n, 1) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      CP.calOpen = null;
      return load().catch((err) => toast(err.message, 'error')); // that month's campaigns
    }
    // the month name: a month / year grid to jump to (months with campaigns are underlined)
    const title = e.target.closest('#campaignList [data-calpick]');
    if (title) {
      const r = title.getBoundingClientRect();
      let y = (CP.calMonth || new Date()).getFullYear();
      const busy = new Set(Object.keys(CP.res?.days || {}).map((k) => k.slice(0, 7)));
      const el = Sheet.Menu.panel(r.left, r.bottom + 6, '<div class="cp-mpick"></div>');
      el.classList.add('cp-mpick-pop');
      const draw = () => {
        const cur = CP.calMonth || new Date(), now = new Date();
        const month = (k) => `<button type="button" class="sch-month ${y === cur.getFullYear() && k === cur.getMonth() ? 'on' : ''} ${y === now.getFullYear() && k === now.getMonth() ? 'today' : ''} ${busy.has(`${y}-${String(k + 1).padStart(2, '0')}`) ? 'has' : ''}" data-m="${k}">${esc(new Date(y, k, 1).toLocaleDateString(undefined, { month: 'short' }))}</button>`;
        el.querySelector('.cp-mpick').innerHTML = `<div class="dt-head"><button type="button" class="dt-nav" data-y="-1" aria-label="Previous year">${icon('chevron-down', 15)}</button><b>${y}</b><button type="button" class="dt-nav" data-y="1" aria-label="Next year">${icon('chevron-down', 15)}</button></div><div class="sch-months">${[...Array(12).keys()].map(month).join('')}</div>`;
      };
      draw();
      Sheet.Menu.fit(el, r);
      el.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        if (b.dataset.y) { y += Number(b.dataset.y); return draw(); }
        if (b.dataset.m) { CP.calMonth = new Date(y, Number(b.dataset.m), 1); CP.calOpen = null; Sheet.Menu.close(); load().catch((err) => toast(err.message, 'error')); }
      });
      return;
    }
    // "+N more", or anywhere on a day that isn't a campaign: that day, hour by hour
    const more = e.target.closest('#campaignList [data-calday]');
    const cell = more ? more.closest('.cp-cal-day') : !e.target.closest('[data-open]') && e.target.closest('#campaignList .cp-cal-day[data-day]');
    if (cell) openDay(cell.dataset.day, cell);
  });

  // ── A day of the calendar: every campaign that day by the hour (sent, sending or scheduled), morphing out of its
  // cell. ‹ › go to the days around it; an empty day offers to schedule one.
  const dayKeyOf = (c) => DateFilter.keyOf(new Date(dayOf(c)));
  const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  function dayHtml(k) {
    const cs = (CP.res?.items || []).filter((c) => dayKeyOf(c) === k).sort((a, b) => String(dayOf(a)).localeCompare(String(dayOf(b))));
    const d = fromKey(k), today = DateFilter.keyOf(new Date()), past = k < today;
    const title = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
    const nav = `<div class="cd-day-nav"><button type="button" class="dt-nav" data-dayn="-1" aria-label="Previous day">‹</button><button type="button" class="dt-nav" data-dayn="1" aria-label="Next day">›</button></div>`;
    const headTxt = `<div class="cd-day-head"><div><b>${esc(title)}</b><small>${k === today ? 'Today · ' : ''}${cs.length ? `${cs.length} campaign${cs.length === 1 ? '' : 's'}` : 'No campaigns'}</small></div>${nav}</div>`;
    if (!cs.length) {
      return headTxt + `<div class="cd-day-empty">
        <span class="cd-day-art" aria-hidden="true"><svg viewBox="0 0 96 96"><rect class="a1" x="14" y="20" width="68" height="62" rx="14"/><rect class="a2" x="14" y="20" width="68" height="18" rx="9"/><path class="a3" d="M32 12v14M64 12v14"/><circle class="a4" cx="48" cy="60" r="12"/><path class="a5" d="M48 54v6l4 3"/></svg></span>
        <b>${past ? 'Nothing was sent this day' : 'Nothing scheduled yet'}</b>
        <p>${past ? 'No campaigns went out on this day.' : 'Pick contacts and a template, and it goes out at the time you choose.'}</p>
        ${past ? `<button type="button" class="btn" data-day-new>${icon('plus', 15)}New campaign</button>` : `<button type="button" class="btn primary" data-day-schedule="${k}">${icon('clock', 15)}Schedule a campaign</button>`}
      </div>`;
    }
    const hourOf = (c) => new Date(dayOf(c)).getHours();
    const hrs = cs.map(hourOf);
    const from = Math.min(9, ...hrs), to = Math.max(18, ...hrs);
    const nowH = k === today ? new Date().getHours() : -1;
    const fmtH = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
    let rows = '';
    for (let h = from; h <= to; h++) {
      const at = cs.filter((c) => hourOf(c) === h);
      rows += `<div class="cd-hour ${at.length ? 'has' : ''} ${h === nowH ? 'now' : ''}"><span class="cd-hour-l">${esc(fmtH(h))}</span><div class="cd-hour-items">${at.map((c) => {
        const s = c.stats || {}, del = deliveredOf(s);
        const note = live(c) ? 'Sending now' : c.status === 'scheduled' ? 'Scheduled' : del ? `${pctOf(s.read || 0, del)}% read · ${pctOf(del, sentOf(s) + (s.failed || 0))}% delivered` : (STATUS_LABEL[c.status] || c.status);
        return `<button type="button" class="cd-ev ${c.status}${c.test ? ' is-test' : ''}" data-day-open="${c.id}" style="--c:${colorOf(c)}">${miniFolder(c)}<span class="cd-ev-main"><b>${esc(displayName(c))}</b><small>${esc(c.templateName || '')} · ${c.total.toLocaleString()} recipient${c.total === 1 ? '' : 's'}</small></span><span class="cd-ev-side"><time>${esc(new Date(dayOf(c)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</time><small>${c.test ? 'Test · ' : ''}${esc(note)}</small></span></button>`;
      }).join('')}</div></div>`;
    }
    return headTxt + `<div class="cd-day-tl">${rows}</div>${past ? '' : `<div class="cd-day-foot"><button type="button" class="btn" data-day-schedule="${k}">${icon('plus', 15)}Schedule another</button></div>`}`;
  }
  // the morph: the cell and the window share a view-transition name for the change
  const vtSwap = (fromEl, swap, getTo) => {
    if (!document.startViewTransition || Motion.reduce() || !fromEl) return swap();
    fromEl.style.viewTransitionName = 'cp-day';
    document.documentElement.classList.add('vt-day');
    const vt = document.startViewTransition(() => { fromEl.style.viewTransitionName = ''; swap(); const to = getTo(); if (to) to.style.viewTransitionName = 'cp-day'; });
    vt.finished.finally(() => { document.documentElement.classList.remove('vt-day'); const to = getTo(); if (to) to.style.viewTransitionName = ''; });
  };
  function openDay(k, cell) {
    let day = k;
    const box = () => $('#modal .modal-box');
    const draw = () => {
      const body = $('#modalBody');
      body.innerHTML = dayHtml(day);
      LA.hydrate(body);
      const d = fromKey(day);
      $('#modalTitle').textContent = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
    };
    // closing morphs back into the day's cell (when it's on screen)
    const back = () => {
      const target = $(`#campaignList .cp-cal-day[data-day="${day}"]`);
      const m = $('#modal');
      if (!document.startViewTransition || Motion.reduce() || !target) return hideOverlay(m);
      box().style.viewTransitionName = 'cp-day';
      document.documentElement.classList.add('vt-day');
      const vt = document.startViewTransition(() => { box().style.viewTransitionName = ''; m.classList.add('hidden'); target.style.viewTransitionName = 'cp-day'; });
      vt.finished.finally(() => { document.documentElement.classList.remove('vt-day'); target.style.viewTransitionName = ''; });
    };
    vtSwap(cell, () => {
      openModal('Day', '');
      box().classList.add('cd-day-box');
      draw();
      setModalBack(back);
    }, box);
    $('#modalBody').onclick = (e) => {
      const n = e.target.closest('[data-dayn]');
      if (n) {
        const d = fromKey(day); d.setDate(d.getDate() + Number(n.dataset.dayn));
        const next = DateFilter.keyOf(d), sameMonth = next.slice(0, 7) === day.slice(0, 7);
        day = next;
        if (sameMonth) return draw();
        // another month: its campaigns first (the calendar behind follows)
        CP.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
        return load().then(draw).catch((err) => toast(err.message, 'error'));
      }
      const ev = e.target.closest('[data-day-open]');
      if (ev) { setModalBack(null); hideOverlay($('#modal')); return open(ev.dataset.dayOpen); }
      const sch = e.target.closest('[data-day-schedule]');
      if (sch) { setModalBack(null); hideOverlay($('#modal')); return window.scheduleOn?.(sch.dataset.daySchedule); }
      if (e.target.closest('[data-day-new]')) { setModalBack(null); hideOverlay($('#modal')); showTab('send'); }
    };
  }

  // Folders ↔ rows: each campaign keeps a view-transition name in both views, so the browser
  // morphs every folder into its row and back. Without support (or with reduced motion) it just swaps.
  // Only what's on screen morphs (each named element is a snapshot: 50 folders off screen would only slow it down).
  function markVisible() {
    const h = innerHeight;
    for (const el of $$('#campaignList [data-open]')) { const box = el.getBoundingClientRect(); el.classList.toggle('vt-on', box.bottom > -40 && box.top < h + 40); }
  }
  function morph(swap) {
    if (!document.startViewTransition || Motion.reduce()) return swap();
    const root = document.documentElement;
    markVisible();
    root.classList.add('vt-camp');
    const vt = document.startViewTransition(() => { swap(); markVisible(); });
    vt.finished.finally(() => root.classList.remove('vt-camp'));
  }

  // A small folder in the campaign's colour, the same one its card uses in the list.
  const miniFolder = (c) => `<span class="cp-pin-folder" style="--c:${colorOf(c)}" aria-hidden="true"><svg viewBox="0 0 40 32"><path class="f-back" d="M3 6a3 3 0 0 1 3-3h9l4 4h15a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/><rect class="f-paper" x="8" y="9" width="24" height="12" rx="2"/><path class="f-front" d="M3 13a3 3 0 0 1 3-3h28a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/></svg></span>`;
  // The numbers a campaign sends from, as their profile photos (or first letters), overlapping slightly.
  const numberFaces = (c) => {
    const ss = (c.senderIds || []).map((id) => state.senders.find((x) => x.id === id)).filter(Boolean);
    if (!ss.length) return '';
    return `<span class="cp-pin-faces" title="From ${esc(ss.map((x) => x.label).join(', '))}">${ss.slice(0, 3).map((x) => senderPhotoHtml(x)).join('')}<span>${ss.length === 1 ? esc(ss[0].label) : `${ss.length} numbers`}</span></span>`;
  };
  function pinnedCard(c) {
    const s = c.stats || {};
    const done = sentOf(s) + (s.failed || 0);
    const isLive = live(c);
    return `<div class="cp-pin ${isLive ? 'is-live' : 'is-scheduled'}" data-open="${c.id}" style="--c:${colorOf(c)}">
      ${miniFolder(c)}
      <div class="cp-pin-main">
        <span class="cp-pin-state">${isLive ? '<span class="cp-dot"></span>Sending now' : `${icon('clock', 12)}Scheduled`}${c.demo ? '<span class="pill demo">demo</span>' : ''}${c.test ? TEST_PILL : ''}</span>
        <b title="${esc(c.name)}">${esc(c.name)}</b>
        <span class="cp-pin-sub">${icon('file-text', 13)}<span title="${esc(c.templateName)}">${esc(c.templateName)}</span></span>
      </div>
      <div class="cp-pin-who"><b>${c.total.toLocaleString()}</b><span>recipient${c.total === 1 ? '' : 's'}</span>${numberFaces(c)}</div>
      ${isLive
        ? `<div class="cp-pin-progress"><div class="pc-progress"><span style="width:${pctOf(done, c.total)}%"></span></div><span>${done.toLocaleString()} of ${c.total.toLocaleString()} · ${esc(eta(c))}</span></div>
           <div class="cp-pin-acts"><button class="btn sm danger" data-act="stop" data-id="${c.id}">Stop</button></div>`
        : `<div class="cp-pin-when"><b>${esc(relTime(c.scheduledAt))}</b><span>${esc(fullDate(c.scheduledAt))}</span></div>
           <div class="cp-pin-acts"><button class="btn sm quiet" data-act="open" data-id="${c.id}">Open</button><button class="btn sm primary" data-act="now" data-id="${c.id}">${icon('send', 14)}Send now</button></div>`}
    </div>`;
  }

  // "Send now" on a scheduled campaign: a confirmation that says exactly what goes out, from where, to how many.
  async function confirmSendNow(c) {
    const ss = (c.senderIds || []).map((id) => state.senders.find((x) => x.id === id)).filter(Boolean);
    const n = c.total || (c.recipients || []).length || 0;
    return confirmDialog({
      title: 'Send this campaign now?',
      message: `<div class="sn-sum">
          ${miniFolder(c)}
          <div><b>${esc(c.name)}</b><span>${esc(c.templateName || '')}</span></div>
        </div>
        <dl class="sn-facts">
          <dt>To</dt><dd><b>${n.toLocaleString()}</b> ${n === 1 ? 'person' : 'people'}</dd>
          ${ss.length ? `<dt>From</dt><dd class="sn-from">${ss.map((x) => `<span>${senderPhotoHtml(x)}${esc(x.label)}</span>`).join('')}</dd>` : ''}
          ${c.scheduledAt ? `<dt>Was set for</dt><dd>${esc(fullDate(c.scheduledAt))} <span class="muted">(${esc(relTime(c.scheduledAt))})</span></dd>` : ''}
        </dl>
        <p class="sn-note">It starts sending straight away instead. You can stop it while it's sending.</p>`.replace(/\n\s*/g, ''),
      confirmText: `Send to ${n.toLocaleString()} ${n === 1 ? 'person' : 'people'} now`,
    });
  }

  // A campaign as a folder: tab and paper on top, name and numbers at the bottom.
  function folderHtml(c) {
    const s = c.stats || {};
    const sent = sentOf(s), del = deliveredOf(s);
    return `<button type="button" class="cp-folder" data-open="${c.id}" style="--c:${colorOf(c)};--vt:cp-${c.id}" title="${esc(c.name)}">
      <span class="cf-tab"></span><span class="cf-paper"></span><span class="cf-body"></span>
      <span class="cp-folder-top">${c.status !== 'completed' ? `<span class="pill ${c.status}">${esc(STATUS_LABEL[c.status] || c.status)}</span>` : ''}${c.demo ? '<span class="pill demo">demo</span>' : ''}${c.test ? TEST_PILL : ''}${c.leads ? `<span class="cp-folder-leads">${c.leads} lead${c.leads > 1 ? 's' : ''}</span>` : ''}</span>
      <span class="cp-folder-body">
        <b>${esc(displayName(c))}</b>
        <small>${esc(c.templateName)} · ${esc(shortDate(c.startedAt || c.createdAt))}</small>
      </span>
      ${folderBar(c)}
      <span class="cf-stats">
        <span><b>${c.total.toLocaleString()}</b>Recipient${c.total === 1 ? '' : 's'}</span>
        <span title="${del.toLocaleString()} of ${(sent + (s.failed || 0)).toLocaleString()} delivered${s.failed ? ` · ${s.failed.toLocaleString()} failed` : ''}"><b>${sent + (s.failed || 0) ? pctOf(del, sent + (s.failed || 0)) + '%' : '—'}</b>Delivered</span>
        <span class="${c.replies ? 'has' : ''}"><b>${(c.replies || 0).toLocaleString()}</b>Repl${c.replies === 1 ? 'y' : 'ies'}</span>
      </span>
    </button>`;
  }

  // Where every message ended up, as one bar in the folder's colour: read, delivered, on its way, failed.
  function folderBar(c) {
    const s = c.stats || {};
    const total = Math.max(c.total, 1);
    const parts = [['read', s.read || 0, 'read'], ['del', s.delivered || 0, 'delivered, not read yet'], ['sent', s.sent || 0, 'sent, not delivered yet'], ['fail', s.failed || 0, 'failed']].filter(([, n]) => n);
    const tip = parts.map(([, n, label]) => `${n.toLocaleString()} ${label}`).join(' · ') || 'Nothing sent yet';
    return `<span class="cf-bar" title="${esc(tip)}">${parts.map(([k, n]) => `<i class="cf-${k}" style="width:${(100 * n) / total}%"></i>`).join('')}</span>`;
  }

  function rowHtml(c) {
    const s = c.stats || {};
    const sent = sentOf(s), del = deliveredOf(s), tried = sent + (s.failed || 0); // delivered out of everyone tried: failures count
    return `<tr data-open="${c.id}" style="--vt:cp-${c.id};--c:${colorOf(c)}">
      <td><div class="cp-who"><span class="cp-ficon" aria-hidden="true"><i class="cf-tab"></i><i class="cf-paper"></i><i class="cf-body"></i></span><div class="cp-name"><b title="${esc(c.name)}">${esc(displayName(c))}</b><span>${esc(c.templateName)}${c.demo ? ' · <span class="pill demo">demo</span>' : ''}${c.test ? ' · ' + TEST_PILL : ''}${c.status !== 'completed' ? ` · <span class="pill ${c.status}">${esc(STATUS_LABEL[c.status] || c.status)}</span>` : ''}</span></div></div></td>
      <td class="num">${c.total.toLocaleString()}</td>
      <td><div class="cp-bar" title="${del.toLocaleString()} of ${tried.toLocaleString()} delivered${s.failed ? ` · ${s.failed.toLocaleString()} failed` : ''}"><span><i style="width:${pctOf(del, tried)}%"></i></span><b>${tried ? pctOf(del, tried) + '%' : '—'}</b></div></td>
      <td class="num">${del ? pctOf(s.read || 0, del) + '%' : '—'}</td>
      <td class="num">${c.replies ? c.replies.toLocaleString() : '<span class="muted">0</span>'}</td>
      <td class="num">${c.leads ? `<b class="cp-leads">${c.leads}</b>` : '<span class="muted">0</span>'}</td>
      <td class="cp-date" title="${esc(fullDate(c.startedAt || c.createdAt))}">${esc(shortDate(c.startedAt || c.createdAt))}</td>
    </tr>`;
  }

  $('#campaignList').addEventListener('click', async (e) => {
    const pg = e.target.closest('[data-cp-page]');
    if (pg) {
      CP.page += Number(pg.dataset.cpPage);
      await load(); // that page, from the server
      // back to the top of the list, under the pinned header and toolbar
      // (measured from the list itself: the toolbar is pinned, so its own position says nothing about where the list starts)
      const list = $('#campaignList .cp-folders, #campaignList .cp-card');
      const pinned = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stick-top')) || 0) + ($('#campaignList > .section-head')?.offsetHeight || 0);
      if (list) scrollTo({ top: Math.max(0, list.getBoundingClientRect().top + scrollY - pinned - 12), behavior: Motion.reduce() ? 'auto' : 'smooth' });
      return;
    }
    const v = e.target.closest('#cpView [data-view]');
    if (v) {
      if (v.dataset.view === CP.view) return;
      try { localStorage.setItem('campView', v.dataset.view); } catch {}
      // the calendar asks for a month, the others for a page: get it first, then morph to the new view
      // (ready from the cache when it was fetched ahead; otherwise fetched first, then the morph)
      const next = v.dataset.view, needs = (next === 'calendar') !== (CP.view === 'calendar');
      if (needs) {
        const hit = listCache.get(listUrl(next));
        if (hit) useRes(hit);
        else { const was = CP.view; CP.view = next; try { await fetchList(); } finally { CP.view = was; } }
        morph(() => { CP.view = next; renderList(); });
        if (hit) setTimeout(() => load().catch(() => {}), 450); // refresh after the morph
        return;
      }
      return morph(() => { CP.view = next; renderList(); });
    }
    const a = e.target.closest('[data-act]');
    if (a) {
      e.stopPropagation();
      return guard(async () => {
        if (a.dataset.act === 'stop') { await api(`/campaigns/${a.dataset.id}/stop`, { method: 'POST' }); toast('Stopping…'); }
        if (a.dataset.act === 'open') return open(a.dataset.id);
        if (a.dataset.act === 'now') {
          const camp = CP.list.find((x) => x.id === a.dataset.id);
          if (!(await confirmSendNow(camp || { id: a.dataset.id, name: 'This campaign' }))) return;
          await api(`/campaigns/${a.dataset.id}/resume`, { method: 'POST', body: {} });
        }
        await load();
      }, a);
    }
    const item = e.target.closest('[data-open]');
    if (item) open(item.dataset.open);
  });

  // --- One campaign -------------------------------------------------------------

  // Meta error codes in plain words, and whether trying again can help.
  const REASONS = {
    131026: ['Not on WhatsApp, or their app can’t receive it', false],
    131049: ['Meta held it back (too many marketing messages to this person)', true],
    131047: ['More than 24 hours since they wrote: needs a template', false],
    131056: ['Too many messages to this person in a short time', true],
    130429: ['Sending too fast (rate limit)', true],
    131048: ['Spam limit: too many people blocked or reported recently', false],
    131000: ['Something went wrong at Meta', true],
    131016: ['WhatsApp was briefly unavailable', true],
    131053: ['The image or video couldn’t be uploaded', true],
    132000: ['The template’s variables didn’t match', false],
    132001: ['Template not found (check its name and language)', false],
    132012: ['A variable was in the wrong format', false],
    132015: ['The template is paused', false],
    132016: ['The template is disabled', false],
    131042: ['Payment problem on the WhatsApp account', false],
    131031: ['The WhatsApp account is locked', false],
    368: ['The number is temporarily blocked by Meta', false],
    190: ['The access token expired: update it under Numbers', false],
  };
  function reasonOf(error = '') {
    const code = String(error).match(/^(\d{2,6}):/)?.[1];
    if (code) {
      const [label, retry] = REASONS[code] || [String(error).replace(/^\d+:\s*/, ''), true];
      return { key: code, code, label, retry };
    }
    const msg = String(error).replace(/^\(demo\)\s*/i, '').replace(/^Simulated failure:\s*/i, '') || 'Unknown error';
    if (/not on whatsapp/i.test(msg)) return { key: String(error), group: '131026', code: '', label: REASONS[131026][0], retry: false };
    return { key: String(error), code: '', label: msg[0].toUpperCase() + msg.slice(1), retry: true };
  }

  // One grid for every campaign: its element moves into each detail view.
  const grid = { sheet: null, api: null, root: document.createElement('div') };
  grid.root.className = 'cd-grid-root';

  // Opening a campaign from the list remembers where the list was scrolled, and adds a browser history step, so
  // Back (the page's or the browser's) returns to the same spot in the list, with that campaign briefly highlighted.
  async function open(cid) {
    stop();
    if (!CP.detail && !$('#campaignList').classList.contains('hidden')) {
      CP.listScroll = scrollY;
      CP.lastOpened = cid;
      if (state.tab === 'campaigns' && !history.state?.cid) { history.pushState({ tab: 'campaigns', cid }, '', `/campaigns?c=${encodeURIComponent(cid)}`); CP.pushed = true; }
    }
    CP.detail = cid;
    let c;
    try {
      c = await api('/campaigns/' + cid);
      if (c.colorIndex >= 0) folderColors.set(c.id, folderColorAt(c.colorIndex)); // opened from a link: its folder colour too
    } catch (e) {
      CP.detail = null;
      toast(e.message, 'error');
      return renderList();
    }
    if (CP.detail !== cid) return;
    const el = $('#campaignDetail');
    const fresh = el.dataset.cid !== cid || el.classList.contains('hidden');
    $('#campaignList').classList.add('hidden');
    el.classList.remove('hidden');
    if (fresh) {
      scrollTo(0, 0);
      el.dataset.cid = cid;
      CP.show = 'all';
      CP.sample = 0;
      el.innerHTML = `
        <div class="cd-head sticky-head" id="cdHead"></div>
        <div id="cdWhy"></div>
        <div class="cd-top">
          <div class="card cd-msg" id="cdMsg"></div>
          <div class="card cd-funnel" id="cdFunnel"><div id="cdFunnelBody"></div><div class="cd-chart-in" id="cdChart"></div></div>
        </div>
        <div class="card cd-fail hidden" id="cdFail"></div>
        <div class="card cd-recips">
          <div class="cd-recips-head"><h2>Recipients</h2><div class="seg" id="cdShow"></div></div>
          <div class="cd-grid" id="cdGrid"></div>
          <p class="sub cd-grid-note">Double-click someone who replied to open the chat.</p>
        </div>`;
      Motion.enter(el);
      $('#cdGrid').append(grid.root);
    }
    CP.c = c;
    renderHead(c);
    renderMessage(c);
    renderFunnel(c);
    renderChart(c);
    renderFailures(c);
    renderRecipients(c, fresh);
    const running = live(c);
    const recent = c.finishedAt && Date.now() - new Date(c.finishedAt) < 5 * 60 * 1000;
    if (running || recent || c.status === 'scheduled') pollTimer = setTimeout(() => CP.detail === cid && open(cid), running ? 1500 : 5000);
  }

  // The page's Back: undo the history step if we added one (popstate below then closes the campaign).
  function back() {
    if (CP.pushed && history.state?.cid) { history.back(); return; }
    closeDetail();
  }
  function closeDetail() {
    stop();
    CP.detail = null;
    CP.pushed = false;
    $('#campaignDetail').classList.add('hidden');
    const y = CP.listScroll, cid = CP.lastOpened;
    load().then(() => {
      if (y == null) return;
      requestAnimationFrame(() => {
        scrollTo({ top: y, behavior: 'instant' });
        const card = $(`#campaignList [data-open="${CSS.escape(cid || '')}"]`);
        if (card) { card.classList.remove('cp-back-hl'); void card.offsetWidth; card.classList.add('cp-back-hl'); }
      });
    }).catch((e) => toast(e.message, 'error'));
  }
  addEventListener('popstate', () => {
    if (state.tab !== 'campaigns') return;
    const cid = history.state?.cid || new URLSearchParams(location.search).get('c');
    if (!cid && CP.detail) closeDetail();
    else if (cid && CP.detail !== cid) open(cid);
  });

  function renderHead(c) {
    const s = c.stats || {};
    const running = live(c);
    const canResume = !running && c.status !== 'scheduled' && s.pending;
    const primary = running
      ? `<button class="btn danger" data-cd="stop">${icon('badge-alert', 16)}Stop</button>`
      : c.status === 'scheduled' ? `<button class="btn primary" data-cd="now">${icon('send', 16)}Send now</button>`
      : canResume ? `<button class="btn primary" data-cd="resume">${icon('send', 16)}${c.status === 'cancelled' ? 'Send now' : 'Resume'}</button>` : '';
    const nums = c.senderIds.map((id) => state.senders.find((x) => x.id === id)?.label).filter(Boolean);
    const when = c.status === 'scheduled' ? `sends ${relTime(c.scheduledAt)} (${fullDate(c.scheduledAt)})` : c.startedAt ? `started ${fullDate(c.startedAt)}${c.finishedAt ? ` · took ${duration(c.startedAt, c.finishedAt)}` : ''}` : `created ${fullDate(c.createdAt)}`;
    // Why it stopped (auto-pause, or a server restart) and what to do, right under the title.
    const why = c.status === 'stopped' && c.pausedReason ? `<div class="cd-why">${icon('badge-alert', 16)}<div><b>Why it stopped</b><span>${esc(c.pausedReason)}</span></div></div>` : '';
    $('#cdHead').innerHTML = `
      <div class="cd-title">
        <div class="cd-name"><button type="button" class="icon-btn cd-back" data-cd="back" title="Back to campaigns" aria-label="Back to campaigns">${icon('arrow-left', 22)}</button>${miniFolder(c)}<div><h1>${esc(c.name)} <span class="pill ${c.status}">${esc(STATUS_LABEL[c.status] || c.status)}</span>${c.demo ? ' <span class="pill demo">demo</span>' : ''}${c.test ? ' ' + TEST_PILL : ''}</h1>
          <p class="sub">Template <code>${esc(c.templateName)}</code> · ${nums.length ? esc(nums.join(', ')) : `${c.senderIds.length} number(s)`} · ${esc(when)}</p></div></div>
        <div class="cd-actions">${primary}
          <button class="btn" data-cd="follow" ${sentOf(s) || s.failed ? '' : 'disabled'}>Follow up ${icon('chevron-down', 14)}</button>
          <button class="btn quiet cd-more" data-cd="more" aria-label="More actions">⋯</button></div>
      </div>`;
    // Why it stopped sits under the pinned header, not in it, so the header stays one height.
    $('#cdWhy').innerHTML = why;
    LA.hydrate($('#cdHead'));
    window.setupSticky?.();
  }
  function duration(a, b) {
    const s = Math.max(0, (new Date(b) - new Date(a)) / 1000);
    return s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
  }

  // What went out, with each person's values. Flip through a few recipients.
  function renderMessage(c) {
    const t = state.templates.find((x) => x.id === c.templateId);
    const people = c.recipients.filter((r) => r.values).slice(0, 20);
    const r = people[Math.min(CP.sample, people.length - 1)];
    $('#cdMsg').innerHTML = `
      <div class="cd-label">Message ${people.length > 1 ? `<span class="cd-flip"><button class="icon-btn" data-cd="prev" aria-label="Previous recipient">‹</button>${CP.sample + 1} / ${people.length}<button class="icon-btn" data-cd="next" aria-label="Next recipient">›</button></span>` : ''}</div>
      <div class="phone ${CP.msgOpen ? 'open' : ''}"><div class="bubble">${t ? bubbleHtml(t, r?.values || {}) : `<span class="muted">Template “${esc(c.templateName)}” was removed</span>`}</div></div>
      <div class="cd-msg-foot"><p class="sub">${r ? `As sent to <b>${esc(r.name || '+' + r.phone)}</b>` : ''}</p><button type="button" class="btn sm quiet cd-msg-more hidden" data-cd="msgmore">${CP.msgOpen ? 'Show less' : 'Show full message'}</button></div>`;
    // Long messages are shown cut to the height of the results beside them; the button shows the rest.
    const ph = $('#cdMsg .phone');
    requestAnimationFrame(() => $('#cdMsg .cd-msg-more')?.classList.toggle('hidden', !CP.msgOpen && ph.scrollHeight <= ph.clientHeight + 2));
  }

  // ── Results: where every message ended up ─────────────────────────────────────────────────
  // Every message is counted once, at the furthest it got: a lead, else replied, else read, delivered, sent, failed or
  // still to send. So the bar is a true split (its pieces add up to the campaign), not steps inside steps, which is
  // what made "sent 230, delivered 218, read 139" hard to read. Expand shows the same split as a field of dots, one per
  // message, with every piece explained.
  // Built like the app's other charts: D3 joins and its easing (750ms, cubic out), the app's chart colours (strengths
  // of ink for how far a message got, the app's good/info/danger for leads, replies and failures), the WhatsApp marks
  // people know, and the shared chart tooltip (#chartTip, showTip/hideTip) with the same hover rule: what's under the
  // pointer lights, the rest fades, and moving off clears it at once.
  const TICK = (two, cls = '') => '<svg class="cd-tick ' + cls + '" viewBox="0 0 16 11" width="16" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (two ? 'M1 5.8 4.2 9 11 1.8M7.6 8.4l.6.6L15 1.8' : 'M1 5.8 4.2 9 11 1.8') + '"/></svg>';
  const KINDS = [
    { id: 'lead', name: 'Leads', mark: () => icon('users', 14), what: 'Replied, and are now a qualified lead or a won deal.', todo: 'Follow up from the Inbox while it’s warm.' },
    { id: 'replied', name: 'Replied', mark: () => icon('reply', 14), what: 'Wrote back to this message.', todo: 'Answer them in the Inbox. The lead assistant can draft it.' },
    { id: 'read', name: 'Read', mark: () => TICK(true, 'blue'), what: 'Opened it (blue ticks), and haven’t replied yet.', todo: 'Nothing urgent. A follow-up in a few days can nudge them.' },
    { id: 'delivered', name: 'Delivered', mark: () => TICK(true), what: 'On their phone (two grey ticks), not opened yet. People who turned off read receipts stay here even after reading.', todo: 'Give it time. Follow up → “Send again to people who didn’t read” if it stays here.' },
    { id: 'sent', name: 'Sent', mark: () => TICK(false), what: 'Accepted by WhatsApp (one grey tick), but not on their phone yet: it’s off or offline. WhatsApp keeps trying for up to 30 days.', todo: 'Wait: most arrive once the phone is back online.' },
    { id: 'failed', name: 'Failed', mark: () => '<span class="cd-x">!</span>', what: 'Didn’t reach them. Each one has a reason from Meta.', todo: 'See “Why it failed” below, and retry the ones that can go through.' },
    { id: 'pending', name: 'Still to send', mark: () => icon('clock', 14), what: 'Waiting in the queue to go out.', todo: 'They go out at the campaign’s safe pace.' },
  ];
  const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k]));
  const kindOf = (r) => {
    if (r.status === 'failed') return 'failed';
    if (r.status === 'pending' || r.status === 'queued' || !r.status) return 'pending';
    if (r.replied) return ['qualified', 'won'].includes(r.contactStatus) ? 'lead' : 'replied';
    return { read: 'read', delivered: 'delivered' }[r.status] || 'sent';
  };
  const split = (c) => {
    const n = Object.fromEntries(KINDS.map((k) => [k.id, 0]));
    for (const r of c.recipients || []) n[kindOf(r)]++;
    return n;
  };
  const num = (v) => Number(v || 0).toLocaleString();
  const DUR = () => (Motion.reduce() ? 0 : 750);

  // The big number, as an odometer: a digit that changes rises (or drops, when the number shrinks) out of a slight blur,
  // left to right 70ms apart; a digit that didn't change stays still. Places count from the right, so a new leading
  // digit doesn't shift the rest.
  const roll = rollNum; // the odometer number (app.js)

  // Light one kind (or none, to clear) in a results card or the Expand window.
  function light(scope, id, c) {
    const n = split(c), total = (c.recipients || []).length;
    if (scope.dataset.hot === (id || '') && scope.dataset.lit) return;
    scope.dataset.hot = id || '';
    scope.dataset.lit = '1';
    scope.classList.toggle('hovering', Boolean(id));
    scope.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('on', x.dataset.kind === id));
    const big = scope.querySelector('.cx-num'), of = scope.querySelector('.cx-of');
    if (big) roll(big, id ? n[id] : total);
    if (of) of.innerHTML = id ? '<span class="cx-of-k">' + KIND[id].mark() + esc(KIND[id].name) + '</span><span class="cx-of-pct">' + shareOf(n[id], total) + ' of ' + num(total) + '</span>' : (total === 1 ? 'message in this campaign' : 'messages in this campaign');
  }
  // The shared chart tooltip, in its usual layout: a title, rows, a note.
  function tipFor(id, c) {
    const n = split(c), total = (c.recipients || []).length, k = KIND[id];
    return '<div class="tt-title">' + esc(c.name) + '</div>' +
      '<div class="tt-row cur"><span><i class="cx-sw" data-sw="' + id + '"></i><span class="cx-mk">' + k.mark() + '</span>' + esc(k.name) + '</span><b>' + num(n[id]) + ' <span class="tt-unit">' + (n[id] === 1 ? 'message' : 'messages') + '</span></b></div>' +
      // the share on its own line, in words, so "72 · 29%" never reads as one number
      '<div class="tt-share">' + shareOf(n[id], total) + ' of all ' + num(total) + '</div>' +
      '<div class="tt-note">' + esc(k.what) + '</div>';
  }

  // The legend: each piece with its mark, name and count, so the numbers read without pointing at anything.
  const chipsHtml = (n) => '<div class="cx-chips">' + KINDS.filter((k) => n[k.id]).map((k) => '<button type="button" class="cx-chip" data-kind="' + k.id + '"><i class="cx-sw" data-sw="' + k.id + '"></i><span class="cx-mk">' + k.mark() + '</span>' + esc(k.name) + '<span class="cx-chip-n">(' + num(n[k.id]) + ')</span></button>').join('') + '</div>';

  // The bar, as a D3 join: a piece per outcome, its width easing to its share (and from its old share on a refresh).
  // One rounded shape cut into pieces: round at its two ends, nearly square where two pieces meet.
  function drawBar(el, c) {
    const n = split(c);
    const data = KINDS.filter((k) => n[k.id]).map((k) => ({ id: k.id, v: n[k.id] }));
    const r = (i) => { const a = i === 0 ? 6 : 2, z = i === data.length - 1 ? 6 : 2; return a + 'px ' + z + 'px ' + z + 'px ' + a + 'px'; };
    const segs = d3.select(el).selectAll('i.cx-seg').data(data, (d) => d.id)
      .join((enter) => enter.append('i').attr('class', 'cx-seg').style('flex-grow', 0))
      .attr('data-kind', (d) => d.id).attr('data-sw', (d) => d.id)
      .attr('tabindex', 0).attr('aria-label', (d) => KIND[d.id].name + ': ' + num(d.v))
      .style('border-radius', (d, i) => r(i));
    segs.order();
    const d = DUR();
    (d ? segs.transition().duration(d).ease(d3.easeCubicOut) : segs).style('flex-grow', (x) => x.v);
  }

  function renderFunnel(c) {
    const n = split(c), total = (c.recipients || []).length;
    const body = $('#cdFunnelBody');
    let cx = body.querySelector('.cx');
    if (!cx || cx.dataset.cid !== c.id) {
      body.innerHTML = '<div class="cx" data-cid="' + esc(c.id) + '">' +
        '<div class="cx-head"><span class="cd-label">Results</span><button type="button" class="btn sm" data-cx-expand title="Expand: every message as a dot">' + icon('maximize-2', 14) + 'Expand</button></div>' +
        '<div class="cx-figure"><span class="cx-num"></span><span class="cx-of"></span></div>' +
        '<div class="cx-bar"></div><div class="cx-chipwrap"></div><div class="cx-foot"></div></div>';
      cx = body.querySelector('.cx');
      wireCx(cx);
    }
    cx.__c = c;
    cx.querySelector('[data-cx-expand]').classList.toggle('hidden', !total);
    if (total) drawBar(cx.querySelector('.cx-bar'), c); else cx.querySelector('.cx-bar').innerHTML = '';
    cx.querySelector('.cx-chipwrap').innerHTML = total ? chipsHtml(n) : '<p class="sub">Nothing sent yet.</p>';
    cx.querySelector('.cx-foot').innerHTML = c.skipped?.length ? '<p class="sub cd-foot">' + num(c.skipped.length) + ' skipped before sending (invalid, duplicate or opted out)</p>' : '';
    const hot = cx.dataset.hot && n[cx.dataset.hot] ? cx.dataset.hot : null;
    delete cx.dataset.lit;
    light(cx, hot, c);
  }

  // Expand: the same split as a field of dots, one per message (or one per few, in a big campaign), filled down each
  // column then across, with every piece explained beneath.
  function expandResults(c) {
    hideTip();
    const n = split(c), total = (c.recipients || []).length;
    const per = Math.max(1, Math.ceil(total / 600));
    const dots = [];
    for (const k of KINDS) { const d = n[k.id] ? Math.max(1, Math.round(n[k.id] / per)) : 0; for (let i = 0; i < d; i++) dots.push({ i: dots.length, id: k.id }); }
    // The field fills the window's width: about 2.6 columns per row (a wide field reads better than a tall one), and
    // dots as big as fit across 600px, between 8 and 22px. Up to ~600 dots: past that, one dot is several messages.
    const cols = Math.max(10, Math.min(48, Math.round(Math.sqrt(dots.length * 2.6))));
    const rows = Math.ceil(dots.length / cols);
    const size = Math.max(8, Math.min(22, Math.floor((600 - 3 * (cols - 1)) / cols)));
    const rowsHtml = KINDS.filter((k) => n[k.id]).map((k) => '<div class="cx-row" data-kind="' + k.id + '"><i class="cx-sw" data-sw="' + k.id + '"></i><div class="cx-row-t"><b><span class="cx-mk">' + k.mark() + '</span>' + esc(k.name) + '</b><p>' + esc(k.what) + '</p><p class="cx-todo">' + esc(k.todo) + '</p></div><div class="cx-row-n"><b>' + num(n[k.id]) + '</b><span>' + pctOf(n[k.id], total) + '%</span></div></div>').join('');
    const body = openModal('Where every message ended up', '<div class="cx cx-big">' +
      '<div class="cx-figure"><span class="cx-num"></span><span class="cx-of"></span></div>' +
      '<div class="cx-field" style="grid-template-rows:repeat(' + rows + ',' + size + 'px);grid-template-columns:repeat(' + cols + ',' + size + 'px)"></div>' +
      chipsHtml(n) +
      '<p class="sub cx-note">Each message is counted once, at the furthest it got' + (per > 1 ? '. One dot is about ' + per + ' messages' : '') + '. Point at a dot, a chip or a row to see it.</p>' +
      '<div class="cx-rows">' + rowsHtml + '</div></div>');
    $('#modal .modal-box').classList.add('cx-box');
    const cx = body.querySelector('.cx');
    const field = cx.querySelector('.cx-field');
    field.__grid = { size, gap: 3, rows, cols, dots };
    // The dots, as a D3 join: they come in with a short ripple from the first. Once in, the inline styles are dropped,
    // so fading the ones you aren't pointing at (CSS) can take over.
    const sel = d3.select(field).selectAll('i').data(dots).join('i')
      .attr('class', 'cx-dot').attr('data-kind', (d) => d.id).attr('data-sw', (d) => d.id);
    if (DUR()) sel.style('opacity', 0).style('scale', 0.4).transition().duration(340).delay((d) => Math.min(600, d.i * 2)).ease(d3.easeCubicOut).style('opacity', 1).style('scale', 1)
      .on('end interrupt', function () { this.style.removeProperty('opacity'); this.style.removeProperty('scale'); });
    cx.__c = c;
    wireCx(cx);
    light(cx, null, c);
  }

  // Which piece the pointer is over, by position rather than by element: anywhere over the dot field is its nearest dot,
  // anywhere over the bar is the piece under that point (the 3px gaps belong to their neighbours). So moving across an
  // area stays on it, without hunting for the exact square or flickering off in a gap.
  function kindAtPoint(e, scope) {
    const field = e.target.closest?.('.cx-field');
    if (field && scope.contains(field) && field.__grid) {
      const { size, gap, rows, cols, dots } = field.__grid, r = field.getBoundingClientRect(), step = size + gap;
      const col = Math.max(0, Math.min(cols - 1, Math.floor((e.clientX - r.left + field.scrollLeft + gap / 2) / step)));
      const row = Math.max(0, Math.min(rows - 1, Math.floor((e.clientY - r.top + gap / 2) / step)));
      return dots[Math.min(dots.length - 1, col * rows + row)].id;
    }
    const bar = e.target.closest?.('.cx-bar');
    if (bar && scope.contains(bar)) {
      let best = null, dist = Infinity;
      for (const seg of bar.children) {
        const s = seg.getBoundingClientRect(), d = e.clientX < s.left ? s.left - e.clientX : e.clientX > s.right ? e.clientX - s.right : 0;
        if (d < dist) { dist = d; best = seg.dataset.kind; }
      }
      return best;
    }
    return null;
  }

  // The hover rule the app's charts use: under the pointer lights (and shows the tooltip), anything else clears.
  function wireCx(scope) {
    const kindAt = (t) => t.closest?.('[data-kind]');
    const clear = () => { light(scope, null, scope.__c); hideTip(); };
    scope.addEventListener('pointermove', (e) => {
      // The field and the bar: by position, with the tooltip.
      const k = kindAtPoint(e, scope);
      if (k) { light(scope, k, scope.__c); return showTip(tipFor(k, scope.__c), e.clientX, e.clientY); }
      // Chips and explanation rows: by element, no tooltip (they say it already).
      const t = kindAt(e.target);
      if (!t || !scope.contains(t)) return clear();
      light(scope, t.dataset.kind, scope.__c);
      hideTip();
    });
    scope.addEventListener('pointerleave', clear);
    scope.addEventListener('focusin', (e) => {
      const t = kindAt(e.target);
      if (!t) return;
      light(scope, t.dataset.kind, scope.__c);
      if (t.matches('.cx-seg')) { const r = t.getBoundingClientRect(); showTip(tipFor(t.dataset.kind, scope.__c), r.left + r.width / 2, r.top); }
    });
    scope.addEventListener('focusout', clear);
  }
  document.addEventListener('click', (e) => { if (e.target.closest('[data-cx-expand]') && CP.c) expandResults(CP.c); });

  // Deliveries over time: how many had been sent, delivered and read by each moment. The three
  // lines nest (read ≤ delivered ≤ sent), so they're drawn as layered areas, labelled at the end.
  // Over time: chart ↔ table as one movement. The view going out fades, the section's height glides to the new size,
  // and the view coming in arrives: the table's rows rise in one after another; the chart's areas sweep in from left
  // to right (as the time they show), its grid and axis fade in, the end labels last.
  function switchChartTable(c) {
    const el = $('#cdChart'), body = el.querySelector('.table-wrap, .cd-chart');
    if (Motion.reduce() || !body) { CP.chartTable = !CP.chartTable; return renderChart(c); }
    if (el.__switching) return;
    el.__switching = true;
    const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
    body.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 130, easing: 'ease-in', fill: 'forwards' }).finished.then(() => {
      const h0 = el.getBoundingClientRect().height;
      CP.chartTable = !CP.chartTable;
      renderChart(c);
      const h1 = el.getBoundingClientRect().height;
      if (Math.abs(h1 - h0) > 1) {
        el.style.overflow = 'hidden';
        el.animate([{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: 320, easing: ease }).finished.finally(() => { el.style.overflow = ''; });
      }
      if (CP.chartTable) {
        $$('.cd-ctable tr', el).forEach((r, i) => r.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 280, delay: Math.min(i, 12) * 22, easing: ease, fill: 'backwards' }));
      } else {
        const svg = el.querySelector('.cd-chart svg');
        svg?.querySelectorAll('.cd-grid-line, .cd-axis').forEach((n) => n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: ease, fill: 'backwards' }));
        svg?.querySelectorAll('path').forEach((p, i) => p.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 650, delay: 60 + (i % 3) * 40, easing: ease, fill: 'backwards' }));
        svg?.querySelectorAll('.cd-end').forEach((n) => n.animate([{ opacity: 0, transform: 'translateX(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 560, easing: ease, fill: 'backwards' }));
      }
    }).finally(() => { el.__switching = false; });
  }

  function renderChart(c) {
    const el = $('#cdChart');
    // Messages that failed (even after being sent) are left out, so the chart ends on the same numbers as the tiles above.
    const rs = c.recipients.filter((r) => r.sentAt && r.status !== 'failed');
    if (!rs.length) { el.innerHTML = `<div class="cd-label">Over time</div><p class="sub">${c.status === 'scheduled' ? 'Shows up once it starts sending.' : 'Nothing sent yet.'}</p>`; return; }
    const times = (k) => rs.map((r) => r[k] && new Date(r[k]).getTime()).filter(Boolean).sort((a, b) => a - b);
    const series = [['Sent', times('sentAt'), 'var(--chart-3)'], ['Delivered', times('deliveredAt'), 'var(--chart-2)'], ['Read', times('readAt'), 'var(--chart)']];
    const t0 = series[0][1][0];
    const t1 = Math.max(t0 + 60000, ...series.map(([, t]) => t[t.length - 1] || 0));
    const N = 48;
    const at = (i) => t0 + ((t1 - t0) * i) / N;
    const counts = series.map(([, t]) => { const out = []; let k = 0; for (let i = 0; i <= N; i++) { while (k < t.length && t[k] <= at(i)) k++; out.push(k); } return out; });
    const max = Math.max(1, counts[0][N]);
    // Drawn at the card's real width (redrawn on resize), so text and lines keep their shape.
    const W = Math.max(320, Math.round(el.clientWidth)), H = 190, L = 40, R = 116, Tp = 12, B = 26;
    const x = (i) => L + ((W - L - R) * i) / N;
    const y = (v) => Tp + (H - Tp - B) * (1 - v / max);
    const area = (vals) => `M${x(0)},${y(0)} ${vals.map((v, i) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} L${x(N)},${y(0)} Z`;
    const line = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    // End labels, nudged apart so they never overlap.
    const ends = series.map(([name], i) => ({ name, v: counts[i][N], y: y(counts[i][N]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 17);
    const fmtT = (t) => (t1 - t0 > 86400000 ? new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' : '') + new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const ticks = [0, Math.round(max / 2), max];
    el.innerHTML = `
      <div class="cd-chart-head"><div class="cd-label">Over time</div>
        <div class="cd-legend">${series.map(([n, , col]) => `<span><i style="background:${col}"></i>${n}</span>`).join('')}</div>
        <button class="btn sm" data-cd="chart-table" title="${CP.chartTable ? 'Show as chart' : 'Show as table'}">${icon(CP.chartTable ? 'chart-column-increasing' : 'table', 14)}${CP.chartTable ? 'Chart' : 'Table'}</button></div>
      ${CP.chartTable ? `<div class="table-wrap"><table class="cd-ctable"><thead><tr><th>Time</th>${series.map(([n]) => `<th class="num">${n}</th>`).join('')}</tr></thead><tbody>${
        [0, 6, 12, 18, 24, 30, 36, 42, 48].map((i) => `<tr><td>${esc(fmtT(at(i)))}</td>${counts.map((cs) => `<td class="num">${cs[i].toLocaleString()}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : `<div class="cd-chart" id="cdPlot">
        <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Sent, delivered and read over time">
          ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="cd-grid-line"/><text x="${L - 8}" y="${y(v) + 4}" class="cd-axis" text-anchor="end">${v.toLocaleString()}</text>`).join('')}
          ${series.map(([, , col], i) => `<path d="${area(counts[i])}" fill="${col}" opacity="0.9"/>`).join('')}
          ${series.map(([, , col], i) => `<path d="${line(counts[i])}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>`).join('')}
          ${ends.map((e) => `<text x="${W - R + 8}" y="${e.y + 4}" class="cd-end">${e.name} <tspan class="cd-end-v">${e.v.toLocaleString()}</tspan></text>`).join('')}
          <text x="${L}" y="${H - 6}" class="cd-axis">${esc(fmtT(t0))}</text>
          <text x="${W - R}" y="${H - 6}" class="cd-axis" text-anchor="end">${esc(fmtT(t1))}</text>
          <line class="cd-cross hidden" id="cdCross" y1="${Tp}" y2="${H - B}"/>
          <rect x="${L}" y="${Tp}" width="${W - L - R}" height="${H - Tp - B}" fill="transparent" id="cdHit"/>
        </svg>
      </div>`}`;
    if (CP.chartTable) return;
    const hit = $('#cdHit'), cross = $('#cdCross'), plot = $('#cdPlot');
    hit.addEventListener('pointermove', (e) => {
      const box = plot.getBoundingClientRect();
      const px = e.clientX - box.left;
      const i = Math.max(0, Math.min(N, Math.round(((px - L) / (W - L - R)) * N)));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.classList.remove('hidden');
      // The shared chart tooltip, as on the Overview: the time, then a row per line with its key.
      showTip(`<div class="tt-title">${esc(fmtT(at(i)))}</div>${series.map(([n, , col], k) => `<div class="tt-row cur"><span><i class="key" style="background:${col}"></i>${n}</span><b>${counts[k][i].toLocaleString()}</b></div>`).join('')}`, e.clientX, e.clientY);
    });
    hit.addEventListener('pointerleave', () => { hideTip(); cross.classList.add('hidden'); });
  }

  // Failures grouped by reason, in plain words, with Retry where trying again can work.
  // A campaign's failures grouped by reason, biggest first: { key, code, label, retry, n }. Used by the "Why it failed"
  // list and the retry dialog, so the two always agree.
  function failureGroups(c) {
    const groups = new Map();
    for (const r of c.recipients) {
      if (r.status !== 'failed') continue;
      const g = reasonOf(r.error), k = g.group || g.key;
      (groups.get(k) || groups.set(k, { ...g, n: 0 }).get(k)).n++;
    }
    return [...groups.values()].sort((a, b) => b.n - a.n);
  }

  function renderFailures(c) {
    const el = $('#cdFail');
    const failed = c.recipients.filter((r) => r.status === 'failed');
    el.classList.toggle('hidden', !failed.length);
    if (!failed.length) return;
    const list = failureGroups(c);
    const running = live(c);
    el.innerHTML = `
      <div class="cd-label">Why ${failed.length.toLocaleString()} failed</div>
      <div class="cd-reasons">${list.map((g) => `
        <div class="cd-reason">
          <span class="cd-reason-n">${g.n.toLocaleString()}</span>
          <span class="cd-reason-t">${esc(g.label)}${g.code ? ` <code class="cd-ecode" tabindex="0" data-ecode="${esc(g.code)}" aria-describedby="cdErrPop">${g.code}</code>` : ''}</span>
          ${g.retry && !running ? `<button class="btn sm" data-cd="retry" data-reason="${esc(g.key)}">${icon('refresh-cw', 13)}Retry ${g.n}</button>` : g.retry ? '' : '<span class="cd-noretry">Retrying won’t help</span>'}
        </div>`).join('')}</div>`;
    LA.hydrate(el);
  }

  // Hovering (or focusing, or tapping) an error code in "Why it failed": the same dark card the Inbox shows for a
  // failed message, from the Error codes list: what it means, what to do, and whether sending again helps.
  const RETRY_TXT = { yes: 'Sending again can work', later: 'Wait a while, then send again', no: 'Sending again won’t help until the cause is fixed' };
  let errPop = null, errHide = 0;
  const closeErrPop = () => { clearTimeout(errHide); errPop?.el.remove(); errPop = null; };
  function showErrPop(codeEl) {
    if (errPop?.code === codeEl) return;
    closeErrPop();
    const code = codeEl.dataset.ecode, e = window.MetaErrors?.byCode[code];
    const el = document.createElement('div');
    el.className = 'ib-err-pop';
    el.id = 'cdErrPop';
    el.setAttribute('role', 'tooltip');
    el.innerHTML = `<b>${esc(e ? e.title : 'Meta error ' + code)}</b>${e ? `<p>${esc(e.means)}</p><p>${esc(e.todo)}</p>` : `<p>This code isn’t in our list yet. Search “WhatsApp error ${esc(code)}” in Meta’s documentation.</p>`}
      <div class="ib-err-src"><div class="ib-err-codeline"><span>Meta error <code>${esc(code)}</code>${e ? ' · ' + RETRY_TXT[e.retry] : ''}</span>${e ? `<a href="#" data-ecopen="${esc(code)}">All error codes</a>` : ''}</div></div>`;
    document.body.appendChild(el);
    const r = codeEl.getBoundingClientRect(), w = el.offsetWidth, ht = el.offsetHeight, gap = 10;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    let top = r.top - ht - gap, below = false;
    if (top < 8) { top = r.bottom + gap; below = true; }
    Object.assign(el.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
    el.style.setProperty('--arrow-x', `${Math.round(r.left + r.width / 2 - left)}px`);
    el.classList.toggle('below', below);
    el.addEventListener('mouseenter', () => clearTimeout(errHide));
    el.addEventListener('mouseleave', () => { errHide = setTimeout(closeErrPop, 200); });
    el.addEventListener('click', (ev) => { const a = ev.target.closest('[data-ecopen]'); if (a) { ev.preventDefault(); closeErrPop(); window.MetaErrors?.open(a.dataset.ecopen); } });
    errPop = { el, code: codeEl };
  }
  const codeAt = (t) => t.closest?.('#cdFail [data-ecode]');
  document.addEventListener('mouseover', (ev) => { const c = codeAt(ev.target); if (c) { clearTimeout(errHide); showErrPop(c); } });
  document.addEventListener('mouseout', (ev) => { if (codeAt(ev.target) && errPop) errHide = setTimeout(closeErrPop, 200); });
  document.addEventListener('focusin', (ev) => { const c = codeAt(ev.target); if (c) showErrPop(c); });
  document.addEventListener('focusout', (ev) => { if (codeAt(ev.target)) errHide = setTimeout(closeErrPop, 200); });
  document.addEventListener('click', (ev) => { const c = codeAt(ev.target); if (c) showErrPop(c); else if (errPop && !errPop.el.contains(ev.target)) closeErrPop(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeErrPop(); });
  addEventListener('scroll', closeErrPop, { passive: true });

  // Recipients in a read-only sheet: sort, filter, copy, and a Show filter by outcome.
  const SHOW = {
    all: ['All', () => true],
    read: ['Read', (r) => r.status === 'read'],
    delivered: ['Delivered', (r) => r.status === 'delivered'],
    sent: ['Sent', (r) => r.status === 'sent'],
    replied: ['Replied', (r) => r.replied],
    failed: ['Failed', (r) => r.status === 'failed'],
    pending: ['Pending', (r) => r.status === 'pending' || r.status === 'queued'],
  };
  function renderRecipients(c, fresh) {
    const senders = Object.fromEntries(state.senders.map((x) => [x.id, x.label]));
    const t = (d) => (d ? new Date(d).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
    const prev = grid.sheet;
    grid.sheet = {
      headers: ['Phone', 'Name', 'From', 'Status', 'Replied', 'Sent', 'Delivered', 'Read', 'Error'],
      widths: [150, 170, 130, 110, 90, 140, 140, 140, 320],
      rows: c.recipients.map((r) => ({ r, on: true, cells: ['+' + r.phone, r.name || '', senders[r.senderId] || '', STATUS_LABEL[r.status] || r.status[0].toUpperCase() + r.status.slice(1), r.replied ? 'Yes' : '', t(r.sentAt), t(r.deliveredAt), t(r.readAt), r.error ? reasonOf(r.error).label : ''] })),
      filters: prev && !fresh ? prev.filters : {},
      sel: prev && !fresh ? prev.sel : undefined,
    };
    const counts = Object.fromEntries(Object.entries(SHOW).map(([k, [, f]]) => [k, c.recipients.filter(f).length]));
    // The filter, with the mark each status has elsewhere (ticks, the reply arrow, a red !, a clock). Its buttons are
    // redrawn only when what they show changes: a click just moves .active, so the pill slides there (a redraw would
    // make the app's seg control snap it, as a new control).
    const MARK = { read: () => TICK(true, 'blue'), delivered: () => TICK(true), sent: () => TICK(false), replied: () => icon('reply', 13), failed: () => '<span class="cd-x">!</span>', pending: () => icon('clock', 13) };
    const show = $('#cdShow');
    const opts = Object.keys(SHOW).filter((k) => k === 'all' || counts[k] || CP.show === k);
    const sig = opts.map((k) => k + ':' + counts[k]).join('|');
    if (show.dataset.sig !== sig) {
      show.dataset.sig = sig;
      show.innerHTML = opts.map((k) => `<button data-show="${k}" class="${CP.show === k ? 'active' : ''}">${MARK[k] ? `<span class="cd-show-mk">${MARK[k]()}</span>` : ''}${SHOW[k][0]} <span class="n">${counts[k].toLocaleString()}</span></button>`).join('');
      Motion.segs(show);
    } else show.querySelectorAll(':scope > button').forEach((b) => b.classList.toggle('active', b.dataset.show === CP.show));
    if (!grid.api) {
      grid.api = Sheet.create(grid.root, {
        sheet: () => grid.sheet,
        readOnly: true,
        indexWidth: 56,
        rowFilter: (sh, row) => SHOW[CP.show][1](row.r),
        cellInfo: (sh, row, col) => (col === 3 ? { cls: 'cd-st cd-st-' + row.r.status } : col === 4 && row.r.replied ? { cls: 'cd-st cd-st-replied' } : col === 8 && row.r.error ? { title: row.r.error } : null),
        emptyText: () => 'Nobody here.',
        open: (row) => {
          if (!row?.r.chatKey || !row.r.replied) return toast(row?.r.replied === false ? 'No reply from them yet' : 'No chat for this person');
          showTab('inbox');
          window.Inbox?.open(row.r.chatKey);
        },
        notify: (m) => toast(m),
      });
    }
    grid.api.render();
    const shown = grid.sheet.view?.length ?? grid.sheet.rows.length;
    $('#cdGrid').style.height = Math.max(180, Math.min(520, 60 + shown * 30)) + 'px';
    grid.api.redraw();
  }

  // --- Detail actions -------------------------------------------------------------

  $('#campaignDetail').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cd], [data-show]');
    if (!b) return;
    const c = CP.c;
    if (b.dataset.show) { CP.show = b.dataset.show; return renderRecipients(c, false); }
    const act = b.dataset.cd;
    if (act === 'back') return back();
    if (act === 'msgmore') { CP.msgOpen = !CP.msgOpen; return renderMessage(c); }
    if (act === 'prev' || act === 'next') { const n = c.recipients.filter((r) => r.values).slice(0, 20).length; CP.sample = (CP.sample + (act === 'next' ? 1 : -1) + n) % n; return renderMessage(c); }
    if (act === 'chart-table') return switchChartTable(c);
    if (act === 'follow') return followMenu(c, b);
    if (act === 'more') return moreMenu(c, b);
    await guard(async () => {
      if (act === 'stop') { await api(`/campaigns/${c.id}/stop`, { method: 'POST' }); toast('Stopping…'); }
      if (act === 'now' || act === 'resume') {
        if (act === 'now' && !(await confirmSendNow(CP.c))) return;
        await api(`/campaigns/${c.id}/resume`, { method: 'POST', body: {} });
      }
      if (act === 'retry') {
        await api(`/campaigns/${c.id}/resume`, { method: 'POST', body: { retryReasons: [b.dataset.reason] } });
        toast('Retrying…');
      }
      await open(c.id);
    }, b);
  });

  // Follow up: each choice asks first. Sending again, messaging repliers and duplicating open the Send page with
  // those people (nothing goes out until it's sent there); retrying asks which failures to send again.
  function followMenu(c, b) {
    const r = b.getBoundingClientRect();
    const unread = c.recipients.filter((x) => x.status === 'sent' || x.status === 'delivered');
    const replied = c.recipients.filter((x) => x.replied);
    // Only the failures a retry can fix (the same rule as the "Why it failed" list): not "not on WhatsApp" and the like.
    const retryable = c.recipients.filter((x) => x.status === 'failed' && reasonOf(x.error).retry);
    const n = (x) => x.toLocaleString();
    const people = (x) => `${n(x)} ${x === 1 ? 'person' : 'people'}`;
    const go = async (list, label, ask) => { if (await confirmDialog({ confirmText: 'Continue', ...ask })) SendPage.openRecipients(list, { label, templateId: c.templateId }); };
    const onSend = 'They open on the Send page, where you pick the message and check it before anything is sent.';
    Sheet.Menu.open(r.left, r.bottom + 4, [
      { label: `Send again to people who didn’t read (${n(unread.length)})`, disabled: !unread.length,
        action: () => go(unread, `${c.name} · didn’t read`, { title: `Send again to ${people(unread.length)}?`, message: `They got “${esc(c.name)}” but haven’t read it. ${onSend}` }) },
      { label: `Message everyone who replied (${n(replied.length)})`, disabled: !replied.length,
        action: () => go(replied, `${c.name} · replied`, { title: `Message ${people(replied.length)} who replied?`, message: `Everyone who replied to “${esc(c.name)}”. ${onSend}` }) },
      ...(retryable.length && !live(c) ? [{ label: `Retry failed messages (${n(retryable.length)})`, action: () => guard(() => retryDialog(c)) }] : []),
      '-',
      { label: `Duplicate the campaign (${people(c.recipients.length)})`,
        action: () => go(c.recipients, `${c.name} (copy)`, { title: 'Duplicate this campaign?', message: `A new campaign to the same ${people(c.recipients.length)} as “${esc(c.name)}”. ${onSend}` }) },
    ]);
  }

  // Retry: the failure reasons as in "Why it failed", each one a reason a retry can fix ticked to send again (all of them
  // to start), and the ones a retry can't fix shown, greyed, for the full picture. The button counts what's ticked.
  async function retryDialog(c) {
    const groups = failureGroups(c), can = groups.filter((g) => g.retry), cant = groups.filter((g) => !g.retry);
    const reason = (g) => `<span class="cd-reason-n">${g.n.toLocaleString()}</span><span class="cd-reason-t">${esc(g.label)}${g.code ? ` <code>${g.code}</code>` : ''}</span>`;
    const total = can.reduce((s, g) => s + g.n, 0);
    const answer = confirmDialog({
      title: 'Retry failed messages',
      message: `<p>Choose which to send again. They go out at the same safe pace, from the same numbers.</p>
        <div class="rt-list">
          ${can.length > 1 ? `<label class="rt-row rt-all"><input type="checkbox" id="rtAll" checked /><span class="rt-all-t">All that can be retried</span><span class="rt-all-n">${total.toLocaleString()}</span></label>` : ''}
          ${can.map((g) => `<label class="rt-row"><input type="checkbox" class="rt-pick" value="${esc(g.key)}" data-n="${g.n}" checked />${reason(g)}</label>`).join('')}
          ${cant.map((g) => `<div class="rt-row is-off"><span class="rt-gap"></span>${reason(g)}<span class="cd-noretry">Retrying won’t help</span></div>`).join('')}
        </div>`,
      confirmText: 'Retry',
    });
    const box = $('#confirm .confirm-box'), yes = $('#confirmYes'), all = $('#rtAll');
    const picks = [...document.querySelectorAll('#confirmMsg .rt-pick')];
    box.classList.add('wide');
    const sync = () => {
      const on = picks.filter((p) => p.checked), sum = on.reduce((s, p) => s + Number(p.dataset.n), 0);
      yes.textContent = sum ? `Retry ${sum.toLocaleString()}` : 'Retry';
      yes.disabled = !sum;
      if (all) { all.checked = on.length === picks.length; all.indeterminate = on.length > 0 && on.length < picks.length; }
    };
    picks.forEach((p) => p.addEventListener('change', sync));
    all?.addEventListener('change', () => { picks.forEach((p) => { p.checked = all.checked; }); sync(); });
    sync();
    const ok = await answer;
    box.classList.remove('wide');
    const keys = picks.filter((p) => p.checked).map((p) => p.value);
    if (!ok || !keys.length) return;
    await api(`/campaigns/${c.id}/resume`, { method: 'POST', body: { retryReasons: keys } });
    toast('Retrying…');
    await open(c.id);
  }

  function moreMenu(c, b) {
    const r = b.getBoundingClientRect();
    const running = live(c);
    Sheet.Menu.open(Math.min(r.left, innerWidth - 240), r.bottom + 4, [
      { label: 'Export CSV', action: () => { location.href = `/api/campaigns/${c.id}/export.csv`; } },
      // a test send stays listed, but out of the Overview's numbers
      { label: c.test ? 'Not a test: count it again' : 'Mark as test', action: () => guard(async () => {
        await api(`/campaigns/${c.id}/test`, { method: 'POST', body: { test: !c.test } });
        const inList = CP.list.find((x) => x.id === c.id);
        if (inList) inList.test = !c.test || undefined;
        toast(c.test ? 'Counted in the Overview again' : 'Marked as a test: left out of the Overview’s numbers');
        await open(c.id);
      }) },
      ...(c.status === 'scheduled' ? [{ label: 'Cancel the schedule', danger: true, action: () => guard(async () => {
        if (!(await confirmDialog({ title: 'Cancel the schedule?', message: "It won't send automatically. You can still send it later.", confirmText: 'Cancel schedule', danger: true }))) return;
        await api(`/campaigns/${c.id}/cancel`, { method: 'POST' });
        await open(c.id);
      }) }] : []),
      ...(!running ? [{ label: 'Delete campaign', danger: true, action: () => guard(async () => {
        if (!(await confirmDialog({ title: 'Delete this campaign?', message: 'Its delivery log is removed too. Export it first if you need it.', confirmText: 'Delete', danger: true }))) return;
        await api('/campaigns/' + c.id, { method: 'DELETE' });
        if (CP.pushed && history.state?.cid) history.replaceState({ tab: 'campaigns' }, '', '/campaigns');
        closeDetail();
      }) }] : []),
    ]);
  }

  let resizeT;
  addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (CP.detail && CP.c && !$('#campaignDetail').classList.contains('hidden')) renderChart(CP.c); }, 150); });

  // Used by app.js (tab switching), the Overview, the Assistant and the Send page.
  window.loadCampaigns = () => {
    const fromUrl = new URLSearchParams(location.search).get('c');
    if (fromUrl && !CP.detail && location.pathname === '/campaigns') CP.detail = fromUrl;
    if (!CP.detail) $('#campaignDetail').classList.add('hidden');
    return load().catch((e) => toast(e.message, 'error'));
  };
  window.openCampaign = (cid) => open(cid);
  window.stopPolling = stop;
})();
