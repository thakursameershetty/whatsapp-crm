// Campaigns page. The list: a 30-day summary, live and scheduled sends pinned on top, then
// a compact table you can search, filter and sort. A campaign: what was sent, the funnel
// from sent to leads, deliveries over time, failures by reason, follow-ups, and every
// recipient in a read-only sheet. Uses helpers from app.js, sheet.js and send.js.

(function () {
  const CP = {
    list: [], filter: 'all', sort: 'new', q: '', detail: null, show: 'all', sample: 0, chartTable: false,
    view: (() => { try { return localStorage.getItem('campView') || 'cards'; } catch { return 'cards'; } })(),
  };
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

  async function load() {
    CP.list = await api('/campaigns');
    assignColors(CP.list);
    if (CP.detail) return open(CP.detail);
    renderList();
    stop();
    if (CP.list.some(live) || CP.list.some((c) => c.status === 'scheduled')) pollTimer = setTimeout(load, CP.list.some(live) ? 2000 : 15000);
  }

  const FILTERS = [
    ['all', 'All', () => true],
    ['completed', 'Completed', (c) => c.status === 'completed'],
    ['stopped', 'Stopped', (c) => c.status === 'stopped' || c.status === 'cancelled'],
  ];
  const SORTS = {
    new: ['Newest', (a, b) => String(b.startedAt || b.createdAt).localeCompare(String(a.startedAt || a.createdAt))],
    old: ['Oldest', (a, b) => String(a.startedAt || a.createdAt).localeCompare(String(b.startedAt || b.createdAt))],
    size: ['Most recipients', (a, b) => b.total - a.total],
    read: ['Best read rate', (a, b) => pctOf(b.stats?.read || 0, deliveredOf(b.stats)) - pctOf(a.stats?.read || 0, deliveredOf(a.stats))],
    replies: ['Most replies', (a, b) => (b.replies || 0) - (a.replies || 0)],
  };

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
    if (!CP.list.length) {
      // Same header as when there are campaigns, so the page always says where you are.
      el.innerHTML = `<div class="section-head"><div><h1>Campaigns</h1><p class="sub">Every bulk send you make, with its delivery, reads, replies and leads.</p></div><button class="btn primary" data-goto="send">${icon('plus', 16)}New campaign</button></div>` + emptyState({ icon: 'send', title: 'No campaigns yet', text: 'Every bulk send shows up here: delivery, reads, replies and the leads they bring in.', actions: `<button class="btn primary" data-goto="send">${icon('plus', 16)}Create a campaign</button>` });
      return;
    }
    const pinned = CP.list.filter((c) => live(c) || c.status === 'scheduled').sort((a, b) => (live(b) - live(a)) || String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
    const filter = FILTERS.find((f) => f[0] === CP.filter) || FILTERS[0];
    const q = CP.q.toLowerCase();
    const rows = CP.list
      .filter((c) => !live(c) && c.status !== 'scheduled' && filter[2](c))
      .filter((c) => !q || [c.name, c.templateName].some((v) => String(v).toLowerCase().includes(q)))
      .sort(SORTS[CP.sort][1]);

    // The last 30 days, in the current mode (the server keeps demo and live campaigns apart).
    const since = Date.now() - 30 * 86400000;
    const recent = CP.list.filter((c) => new Date(c.startedAt || c.createdAt).getTime() >= since && Boolean(c.demo) === Boolean(state.settings.demoMode));
    const T = recent.reduce((a, c) => { const s = c.stats || {}; a.sent += sentOf(s); a.del += deliveredOf(s); a.read += s.read || 0; a.rep += c.replies || 0; a.leads += c.leads || 0; return a; }, { sent: 0, del: 0, read: 0, rep: 0, leads: 0 });

    el.innerHTML = `
      <div class="section-head"><div><h1>Campaigns</h1>
        <p class="sub cp-summary">Last 30 days · <b>${T.sent.toLocaleString()}</b> sent · <b>${pctOf(T.del, T.sent)}%</b> delivered · <b>${pctOf(T.read, T.del)}%</b> read · <b>${T.rep.toLocaleString()}</b> repl${T.rep === 1 ? 'y' : 'ies'} · <b>${T.leads.toLocaleString()}</b> lead${T.leads === 1 ? '' : 's'}</p></div>
        <button class="btn primary" data-goto="send">${icon('plus', 16)}New campaign</button></div>
      ${pinned.length ? `<div class="cp-pinned">${pinned.map(pinnedCard).join('')}</div>` : ''}
      <div class="cp-tools">
        <div class="seg" id="cpFilter">${FILTERS.map(([k, label, fn]) => `<button data-f="${k}" class="${k === filter[0] ? 'active' : ''}">${label} <span class="opt">${CP.list.filter((c) => !live(c) && c.status !== 'scheduled' && fn(c)).length}</span></button>`).join('')}</div>
        <div class="search-wrap" data-icon="search" data-icon-size="15"><input class="search" id="cpSearch" placeholder="Search name or template" value="${esc(CP.q)}" aria-label="Search campaigns" /></div>
        <label class="inline">Sort <select id="cpSort">${Object.entries(SORTS).map(([k, [label]]) => `<option value="${k}" ${k === CP.sort ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <div class="seg seg-icons cp-view" id="cpView" role="radiogroup" aria-label="View">
          <button data-view="cards" class="${CP.view === 'cards' ? 'active' : ''}" title="Cards" aria-label="Cards" aria-checked="${CP.view === 'cards'}" role="radio">${icon('layout-grid', 15)}</button>
          <button data-view="table" class="${CP.view === 'table' ? 'active' : ''}" title="Table" aria-label="Table" aria-checked="${CP.view === 'table'}" role="radio">${icon('list', 15)}</button>
        </div>
      </div>
      ${CP.view === 'cards'
        ? `<div class="cp-folders">
            <button type="button" class="cp-folder-new" data-goto="send"><b>New campaign</b><span>Pick contacts and a template</span><i>${icon('plus', 22)}</i></button>
            ${rows.map(folderHtml).join('')}
          </div>${!rows.length && q ? '<p class="sub">No campaigns match.</p>' : ''}`
        : `<div class="card cp-card">
        <table class="data-table cp-table">
          <thead><tr class="heads"><th>Campaign</th><th class="num">Recipients</th><th>Delivered</th><th class="num">Read</th><th class="num">Replies</th><th class="num">Leads</th><th>Date</th></tr></thead>
          <tbody>${rows.length ? rows.map(rowHtml).join('') : `<tr><td colspan="7" class="table-empty">${q ? 'No campaigns match.' : 'Nothing here yet.'}</td></tr>`}</tbody>
        </table>
      </div>`}`;
    LA.hydrate(el);
    Motion.segs(el);
    const search = $('#cpSearch');
    search.oninput = () => { CP.q = search.value.trim(); const pos = search.selectionStart; renderList(); const s2 = $('#cpSearch'); s2.focus(); s2.setSelectionRange(pos, pos); };
    $('#cpSort').onchange = (e) => { CP.sort = e.target.value; renderList(); };
  }

  // Folders ↔ rows: each campaign keeps a view-transition name in both views, so the browser
  // morphs every folder into its row and back. Without support (or with reduced motion) it just swaps.
  function morph(swap) {
    if (!document.startViewTransition || Motion.reduce()) return swap();
    const root = document.documentElement;
    root.classList.add('vt-camp');
    const vt = document.startViewTransition(swap);
    vt.finished.finally(() => root.classList.remove('vt-camp'));
  }

  function pinnedCard(c) {
    const s = c.stats || {};
    const done = sentOf(s) + (s.failed || 0);
    const isLive = live(c);
    return `<div class="cp-pin ${isLive ? 'is-live' : ''}" data-open="${c.id}">
      <span class="cp-pin-state">${isLive ? '<span class="cp-dot"></span>Sending now' : `${icon('clock', 13)}Scheduled`}</span>
      <div class="cp-pin-main"><b title="${esc(c.name)}">${esc(c.name)}</b><span title="${esc(c.templateName)}">${esc(c.templateName)} · ${c.total.toLocaleString()} recipients${c.demo ? ' · demo' : ''}</span></div>
      ${isLive
        ? `<div class="cp-pin-progress"><div class="pc-progress"><span style="width:${pctOf(done, c.total)}%"></span></div><span>${done.toLocaleString()} of ${c.total.toLocaleString()} · ${esc(eta(c))}</span></div>
           <button class="btn sm danger" data-act="stop" data-id="${c.id}">Stop</button>`
        : `<div class="cp-pin-when"><b>${esc(relTime(c.scheduledAt))}</b><span>${esc(fullDate(c.scheduledAt))}</span></div>
           <button class="btn sm primary" data-act="now" data-id="${c.id}">Send now</button>`}
    </div>`;
  }

  // A campaign as a folder: tab and paper on top, name and numbers at the bottom.
  function folderHtml(c) {
    const s = c.stats || {};
    const sent = sentOf(s), del = deliveredOf(s);
    return `<button type="button" class="cp-folder" data-open="${c.id}" style="--c:${colorOf(c)};--vt:cp-${c.id}" title="${esc(c.name)}">
      <span class="cf-tab"></span><span class="cf-paper"></span><span class="cf-body"></span>
      <span class="cp-folder-top">${c.status !== 'completed' ? `<span class="pill ${c.status}">${esc(STATUS_LABEL[c.status] || c.status)}</span>` : ''}${c.demo ? '<span class="pill demo">demo</span>' : ''}${c.leads ? `<span class="cp-folder-leads">${c.leads} lead${c.leads > 1 ? 's' : ''}</span>` : ''}</span>
      <span class="cp-folder-body">
        <b>${esc(displayName(c))}</b>
        <small>${esc(c.templateName)} · ${esc(shortDate(c.startedAt || c.createdAt))}</small>
      </span>
      ${folderBar(c)}
      <span class="cf-stats">
        <span><b>${c.total.toLocaleString()}</b>Recipient${c.total === 1 ? '' : 's'}</span>
        <span><b>${sent ? pctOf(del, sent) + '%' : '—'}</b>Delivered</span>
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
    const sent = sentOf(s), del = deliveredOf(s);
    return `<tr data-open="${c.id}" style="--vt:cp-${c.id};--c:${colorOf(c)}">
      <td><div class="cp-who"><span class="cp-ficon" aria-hidden="true"><i class="cf-tab"></i><i class="cf-paper"></i><i class="cf-body"></i></span><div class="cp-name"><b title="${esc(c.name)}">${esc(displayName(c))}</b><span>${esc(c.templateName)}${c.demo ? ' · <span class="pill demo">demo</span>' : ''}${c.status !== 'completed' ? ` · <span class="pill ${c.status}">${esc(STATUS_LABEL[c.status] || c.status)}</span>` : ''}</span></div></div></td>
      <td class="num">${c.total.toLocaleString()}</td>
      <td><div class="cp-bar" title="${del.toLocaleString()} of ${sent.toLocaleString()} sent were delivered${s.failed ? ` · ${s.failed} failed` : ''}"><span><i style="width:${pctOf(del, sent)}%"></i></span><b>${sent ? pctOf(del, sent) + '%' : '—'}</b></div></td>
      <td class="num">${del ? pctOf(s.read || 0, del) + '%' : '—'}</td>
      <td class="num">${c.replies ? c.replies.toLocaleString() : '<span class="muted">0</span>'}</td>
      <td class="num">${c.leads ? `<b class="cp-leads">${c.leads}</b>` : '<span class="muted">0</span>'}</td>
      <td class="cp-date" title="${esc(fullDate(c.startedAt || c.createdAt))}">${esc(shortDate(c.startedAt || c.createdAt))}</td>
    </tr>`;
  }

  $('#campaignList').addEventListener('click', (e) => {
    const f = e.target.closest('#cpFilter [data-f]');
    if (f) { CP.filter = f.dataset.f; return renderList(); }
    const v = e.target.closest('#cpView [data-view]');
    if (v) {
      if (v.dataset.view === CP.view) return;
      try { localStorage.setItem('campView', v.dataset.view); } catch {}
      return morph(() => { CP.view = v.dataset.view; renderList(); });
    }
    const a = e.target.closest('[data-act]');
    if (a) {
      e.stopPropagation();
      return guard(async () => {
        if (a.dataset.act === 'stop') { await api(`/campaigns/${a.dataset.id}/stop`, { method: 'POST' }); toast('Stopping…'); }
        if (a.dataset.act === 'now') {
          if (!(await confirmDialog({ title: 'Send it now?', message: 'It starts sending straight away instead of at its scheduled time.', confirmText: 'Send now' }))) return;
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

  async function open(cid) {
    stop();
    CP.detail = cid;
    let c;
    try {
      c = await api('/campaigns/' + cid);
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
      el.dataset.cid = cid;
      CP.show = 'all';
      CP.sample = 0;
      el.innerHTML = `
        <div class="cd-head" id="cdHead"></div>
        <div class="cd-top">
          <div class="card cd-msg" id="cdMsg"></div>
          <div class="card cd-funnel" id="cdFunnel"></div>
        </div>
        <div class="card cd-chart-card" id="cdChart"></div>
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

  function back() {
    stop();
    CP.detail = null;
    $('#campaignDetail').classList.add('hidden');
    load();
  }

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
      <button class="btn ghost sm cd-back" data-cd="back">${icon('arrow-left', 15)}Campaigns</button>
      <div class="cd-title">
        <div><h1>${esc(c.name)} <span class="pill ${c.status}">${esc(STATUS_LABEL[c.status] || c.status)}</span>${c.demo ? ' <span class="pill demo">demo</span>' : ''}</h1>
          <p class="sub">Template <code>${esc(c.templateName)}</code> · ${nums.length ? esc(nums.join(', ')) : `${c.senderIds.length} number(s)`} · ${esc(when)}</p></div>
        <div class="cd-actions">${primary}
          <button class="btn" data-cd="follow" ${sentOf(s) || s.failed ? '' : 'disabled'}>Follow up ${icon('chevron-down', 14)}</button>
          <button class="btn quiet cd-more" data-cd="more" aria-label="More actions">⋯</button></div>
      </div>${why}`;
    LA.hydrate($('#cdHead'));
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

  // Sent → delivered → read → replied → leads. Each bar is a share of what was sent.
  function renderFunnel(c) {
    const s = c.stats || {};
    const sent = sentOf(s), del = deliveredOf(s), read = s.read || 0;
    const steps = [
      ['Sent', sent, null],
      ['Delivered', del, sent],
      ['Read', read, del],
      ['Replied', c.replies || 0, read || del],
      ['Leads', c.leads || 0, c.replies || 0],
    ];
    $('#cdFunnel').innerHTML = `
      <div class="cd-label">Results</div>
      <div class="cd-steps">${steps.map(([label, n, of], i) => `
        <div class="cd-step s${i}">
          <div class="cd-step-top"><span>${label}</span><b>${n.toLocaleString()}</b>${of != null ? `<em>${of ? pctOf(n, of) + '%' : '—'}</em>` : ''}</div>
          <div class="cd-step-bar"><i style="width:${sent ? Math.max(n ? 1.5 : 0, (100 * n) / sent) : 0}%"></i></div>
        </div>`).join('')}</div>
      <p class="sub cd-foot">${[
        s.pending ? `${s.pending.toLocaleString()} still to send` : '',
        s.failed ? `<span class="bad-text">${s.failed.toLocaleString()} failed</span>` : '',
        c.skipped?.length ? `${c.skipped.length.toLocaleString()} skipped before sending (invalid, duplicate or opted out)` : '',
        'percentages are of the step before',
      ].filter(Boolean).join(' · ')}</p>`;
  }

  // Deliveries over time: how many had been sent, delivered and read by each moment. The three
  // lines nest (read ≤ delivered ≤ sent), so they're drawn as layered areas, labelled at the end.
  function renderChart(c) {
    const el = $('#cdChart');
    const rs = c.recipients.filter((r) => r.sentAt);
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
    const W = Math.max(320, Math.round(el.clientWidth - 48)), H = 200, L = 40, R = 116, Tp = 12, B = 26;
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
        <button class="btn sm quiet" data-cd="chart-table">${CP.chartTable ? 'Chart' : 'Table'}</button></div>
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
        <div class="cd-tip hidden" id="cdTip"></div>
      </div>`}`;
    if (CP.chartTable) return;
    const hit = $('#cdHit'), tip = $('#cdTip'), cross = $('#cdCross'), plot = $('#cdPlot');
    hit.addEventListener('pointermove', (e) => {
      const box = plot.getBoundingClientRect();
      const px = e.clientX - box.left;
      const i = Math.max(0, Math.min(N, Math.round(((px - L) / (W - L - R)) * N)));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.classList.remove('hidden');
      tip.innerHTML = `<b>${esc(fmtT(at(i)))}</b>${series.map(([n, , col], k) => `<span><i style="background:${col}"></i>${n}<em>${counts[k][i].toLocaleString()}</em></span>`).join('')}`;
      tip.classList.remove('hidden');
      const left = x(i);
      tip.style.left = Math.min(box.width - tip.offsetWidth - 4, Math.max(4, left + 12)) + 'px';
    });
    hit.addEventListener('pointerleave', () => { tip.classList.add('hidden'); cross.classList.add('hidden'); });
  }

  // Failures grouped by reason, in plain words, with Retry where trying again can work.
  function renderFailures(c) {
    const el = $('#cdFail');
    const failed = c.recipients.filter((r) => r.status === 'failed');
    el.classList.toggle('hidden', !failed.length);
    if (!failed.length) return;
    const groups = new Map();
    for (const r of failed) { const g = reasonOf(r.error); const k = g.group || g.key; (groups.get(k) || groups.set(k, { ...g, n: 0 }).get(k)).n++; }
    const list = [...groups.values()].sort((a, b) => b.n - a.n);
    const running = live(c);
    el.innerHTML = `
      <div class="cd-label">Why ${failed.length.toLocaleString()} failed</div>
      <div class="cd-reasons">${list.map((g) => `
        <div class="cd-reason">
          <span class="cd-reason-n">${g.n.toLocaleString()}</span>
          <span class="cd-reason-t">${esc(g.label)}${g.code ? ` <code>${g.code}</code>` : ''}</span>
          ${g.retry && !running ? `<button class="btn sm" data-cd="retry" data-reason="${esc(g.key)}">${icon('refresh-cw', 13)}Retry ${g.n}</button>` : g.retry ? '' : '<span class="cd-noretry">Retrying won’t help</span>'}
        </div>`).join('')}</div>`;
    LA.hydrate(el);
  }

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
    $('#cdShow').innerHTML = Object.entries(SHOW).map(([k, [label]]) => (k === 'all' || counts[k] || CP.show === k ? `<button data-show="${k}" class="${CP.show === k ? 'active' : ''}">${label} <span class="n">${counts[k].toLocaleString()}</span></button>` : '')).join('');
    Motion.segs($('#cdShow'));
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
    if (act === 'chart-table') { CP.chartTable = !CP.chartTable; return renderChart(c); }
    if (act === 'follow') return followMenu(c, b);
    if (act === 'more') return moreMenu(c, b);
    await guard(async () => {
      if (act === 'stop') { await api(`/campaigns/${c.id}/stop`, { method: 'POST' }); toast('Stopping…'); }
      if (act === 'now' || act === 'resume') {
        if (act === 'now' && !(await confirmDialog({ title: 'Send it now?', message: 'It starts sending straight away instead of at its scheduled time.', confirmText: 'Send now' }))) return;
        await api(`/campaigns/${c.id}/resume`, { method: 'POST', body: {} });
      }
      if (act === 'retry') {
        await api(`/campaigns/${c.id}/resume`, { method: 'POST', body: { retryReasons: [b.dataset.reason] } });
        toast('Retrying…');
      }
      await open(c.id);
    }, b);
  });

  function followMenu(c, b) {
    const r = b.getBoundingClientRect();
    const unread = c.recipients.filter((x) => x.status === 'sent' || x.status === 'delivered');
    const replied = c.recipients.filter((x) => x.replied);
    const failed = c.recipients.filter((x) => x.status === 'failed');
    const go = (list, label) => SendPage.openRecipients(list, { label, templateId: c.templateId });
    Sheet.Menu.open(r.left, r.bottom + 4, [
      { label: `Send again to people who didn’t read (${unread.length.toLocaleString()})`, disabled: !unread.length, action: () => go(unread, `${c.name} · didn’t read`) },
      { label: `Message everyone who replied (${replied.length.toLocaleString()})`, disabled: !replied.length, action: () => go(replied, `${c.name} · replied`) },
      ...(failed.length && !live(c) ? [{ label: `Retry every failed message (${failed.length.toLocaleString()})`, action: () => guard(async () => { await api(`/campaigns/${c.id}/resume`, { method: 'POST', body: { retryFailed: true } }); toast('Retrying…'); await open(c.id); }) }] : []),
      '-',
      { label: `Duplicate the campaign (${c.recipients.length.toLocaleString()} people)`, action: () => go(c.recipients, `${c.name} (copy)`) },
    ]);
  }

  function moreMenu(c, b) {
    const r = b.getBoundingClientRect();
    const running = live(c);
    Sheet.Menu.open(Math.min(r.left, innerWidth - 240), r.bottom + 4, [
      { label: 'Export CSV', action: () => { location.href = `/api/campaigns/${c.id}/export.csv`; } },
      ...(c.status === 'scheduled' ? [{ label: 'Cancel the schedule', danger: true, action: () => guard(async () => {
        if (!(await confirmDialog({ title: 'Cancel the schedule?', message: "It won't send automatically. You can still send it later.", confirmText: 'Cancel schedule', danger: true }))) return;
        await api(`/campaigns/${c.id}/cancel`, { method: 'POST' });
        await open(c.id);
      }) }] : []),
      ...(!running ? [{ label: 'Delete campaign', danger: true, action: () => guard(async () => {
        if (!(await confirmDialog({ title: 'Delete this campaign?', message: 'Its delivery log is removed too. Export it first if you need it.', confirmText: 'Delete', danger: true }))) return;
        await api('/campaigns/' + c.id, { method: 'DELETE' });
        back();
      }) }] : []),
    ]);
  }

  let resizeT;
  addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (CP.detail && CP.c && !$('#campaignDetail').classList.contains('hidden')) renderChart(CP.c); }, 150); });

  // Used by app.js (tab switching), the Overview, the Assistant and the Send page.
  window.loadCampaigns = () => { if (!CP.detail) $('#campaignDetail').classList.add('hidden'); return load().catch((e) => toast(e.message, 'error')); };
  window.openCampaign = (cid) => open(cid);
  window.stopPolling = stop;
})();
