// Notifications page: everything worth knowing about, newest first, grouped by day.
// Campaigns finishing, failed deliveries, new messages, opt-outs and what the Inbox lead
// assistant did or needs. Clicking one marks it read and opens where you can act on it.
// New ones arrive live (over the Inbox's event stream) and pop a toast you can click or dismiss.

(function () {
  const NT = {
    list: [], unread: 0, filter: 'all', loaded: false, fresh: new Set(),
    // which days (the calendar: one day, several, or a range) and pages (how many per page is remembered)
    date: null, page: 0, pageSig: '',
    per: (() => { try { const n = localStorage.getItem('ntPer'); return n == null ? 50 : Number(n) || 0; } catch { return 50; } })(),
  };
  const PER_PAGE = [25, 50, 100, 200, 0];

  const KIND = {
    message: { icon: 'message-circle', tone: 'info' },
    optout: { icon: 'bell-off', tone: 'muted' },
    reply_failed: { icon: 'badge-alert', tone: 'danger' },
    campaign_started: { icon: 'rocket', tone: 'violet' },
    campaign_done: { icon: 'circle-check', tone: 'good' },
    delivery_failed: { icon: 'badge-alert', tone: 'danger' },
    ai_draft: { orb: true, tone: 'violet' }, // the AI's own work shows the AI's icon (the dotted sphere)
    ai_auto: { orb: true, tone: 'violet' },
    ai_handover: { icon: 'users', tone: 'warn' },
    ai_qualified: { icon: 'trending-up', tone: 'good' },
    ai_error: { icon: 'badge-alert', tone: 'warn' },
    whats_new: { icon: 'sparkles', tone: 'violet' },
    number_ok: { icon: 'circle-check', tone: 'good' }, // a number's display name was approved
    number_problem: { icon: 'badge-alert', tone: 'danger' }, // …or rejected / expired
    credits_added: { icon: 'zap', tone: 'good' }, // an admin added credits (after payment)
    credits_low: { icon: 'zap', tone: 'warn' },
    credits_out: { icon: 'zap', tone: 'danger' },
    template_approved: { icon: 'file-text', tone: 'good' }, // Meta approved (or reinstated) a template
    template_problem: { icon: 'file-text', tone: 'danger' }, // …rejected, paused, disabled, flagged or re-categorised it
    template_update: { icon: 'file-text', tone: 'info' }, // …anything else worth knowing (an appeal is being looked at)
  };
  const FILTERS = [['all', 'All'], ['unread', 'Unread'], ['messages', 'Messages'], ['campaigns', 'Campaigns'], ['ai', 'AI assistant'], ['templates', 'Templates'], ['numbers', 'Numbers']];
  // Which new notifications also pop a toast. (Everything lands on the page either way.)
  const TOAST = new Set(['message', 'optout', 'reply_failed', 'campaign_started', 'campaign_done', 'delivery_failed', 'ai_draft', 'ai_auto', 'ai_handover', 'ai_qualified', 'ai_error', 'credits_added', 'template_approved', 'template_problem', 'template_update', 'number_ok', 'number_problem']);
  const ERROR_KINDS = new Set(['reply_failed', 'delivery_failed', 'ai_error', 'template_problem', 'number_problem']);

  const visible = () => !$('#tab-notifications').classList.contains('hidden');
  // One page from the server (GET /api/notifications?page=…): the kind and days are applied there, with the counts.
  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    const p = new URLSearchParams({ page: String(NT.page), per: String(NT.per), filter: NT.filter, tz: String(new Date().getTimezoneOffset()) });
    if (NT.date) p.set('dates', JSON.stringify(NT.date));
    const r = await api('/notifications?' + p);
    if (seq !== loadSeq) return;
    NT.res = r;
    NT.page = r.page;
    NT.list = r.notifications;
    NT.unread = r.unread;
    NT.loaded = true;
    badge();
  }

  function badge() {
    const b = $('#notifBadge');
    b.textContent = NT.unread > 99 ? '99+' : NT.unread;
    b.classList.toggle('hidden', !NT.unread);
    const m = $('#mbarBadge'); // the narrow screens' top bar
    if (m) { m.textContent = b.textContent; m.classList.toggle('hidden', !NT.unread); }
  }

  function dayLabel(ts) {
    const d = new Date(ts), today = new Date();
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((start(today) - start(d)) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return d.toLocaleDateString('en-IN', { weekday: 'long' });
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  function row(n, i) {
    const k = KIND[n.kind] || { icon: 'bell', tone: 'muted' };
    return `<div class="nt-item ${n.read ? '' : 'unread'} ${NT.fresh.has(n.id) ? 'fresh' : ''}" data-id="${n.id}" style="--i:${i}" role="button" tabindex="0">
      <span class="nt-ico tone-${k.tone}">${k.orb ? '<svg class="orb-icon" data-orb-icon="17"></svg>' : icon(k.icon, 17)}</span>
      <span class="nt-main">
        <b>${esc(n.title)}</b>
        ${n.body ? `<span class="nt-body">${esc(n.body.length === 160 && !/[.!?…]$/.test(n.body) ? n.body.replace(/\s+\S*$/, '') + '…' : n.body)}</span>` : ''}
        <time title="${esc(new Date(n.ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }))}">${relTime(n.ts)}</time>
      </span>
      <span class="nt-acts">
        <button type="button" class="nt-act" data-act="toggle" title="${n.read ? 'Mark as unread' : 'Mark as read'}" aria-label="${n.read ? 'Mark as unread' : 'Mark as read'}">${icon(n.read ? 'eye' : 'check-check', 15)}</button>
        <button type="button" class="nt-act" data-act="remove" title="Clear" aria-label="Clear this notification">${icon('x', 15)}</button>
      </span>
      ${n.read ? '' : '<i class="nt-dot" aria-label="Unread"></i>'}
    </div>`;
  }

  function render() {
    const R = NT.res || { counts: { all: 0, unread: 0, read: 0 }, total: 0, pages: 1, per: NT.per };
    const list = NT.list; // this page
    const pages = R.pages || 1;
    const from = R.per ? NT.page * R.per : 0;
    const totalAll = R.counts.all;
    $('#ntDateWrap').innerHTML = DateFilter.button(NT.date, 'ntDate');
    $('#ntPer').innerHTML = PER_PAGE.map((n) => `<option value="${n}" ${n === NT.per ? 'selected' : ''}>${n ? `${n} / page` : 'Show all'}</option>`).join('');
    $('#ntPer').value = String(NT.per);
    $('#ntSub').textContent = totalAll
      ? `Campaigns, deliveries, messages and the AI assistant, in one place. ${NT.unread ? `${NT.unread.toLocaleString()} unread` : 'All caught up'} · ${totalAll.toLocaleString()} in total.`
      : 'Campaigns, deliveries, messages and the AI assistant, in one place.';
    const count = (k) => (k === 'unread' ? NT.unread : R.counts[k] || 0);
    // a dropdown (with counts), so the date and page size fit beside the title in the one-line header
    $('#ntFilter').innerHTML = FILTERS.map(([k, label]) => `<option value="${k}">${k === 'all' ? 'All notifications' : label} (${count(k).toLocaleString()})</option>`).join('');
    $('#ntFilter').value = NT.filter;
    $('#ntReadAll').disabled = !NT.unread;
    $('#ntClear').disabled = !totalAll;

    if (!list.length) {
      $('#ntList').innerHTML = totalAll
        ? emptyState({ icon: 'check-check', title: NT.filter === 'unread' && !NT.date ? 'All caught up' : 'Nothing here', text: NT.date ? 'No notifications on these days.' : NT.filter === 'unread' ? 'You’ve read every notification.' : 'No notifications of this kind yet.', actions: NT.date ? '<button class="btn" data-nt-anydate>Show any date</button>' : '' })
        : emptyState({ icon: 'bell', title: 'No notifications yet', text: 'When a campaign finishes, a delivery fails, someone messages you or the AI assistant needs you, it shows up here.' });
      LA.hydrate($('#ntList'));
      return;
    }
    const groups = new Map();
    list.forEach((n) => { const d = dayLabel(n.ts); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(n); });
    let i = 0;
    $('#ntList').innerHTML = [...groups].map(([day, items]) => `<section class="nt-day"><h3>${esc(day)}</h3><div class="card nt-card">${items.map((n) => row(n, i++)).join('')}</div></section>`).join('')
      + (pages > 1 ? `<div class="cp-pager nt-pager">
          <span>${(from + 1).toLocaleString()}–${(from + list.length).toLocaleString()} of ${R.total.toLocaleString()}</span>
          <div class="seg"><button type="button" data-nt-page="-1" ${NT.page ? '' : 'disabled'} aria-label="Previous page">${icon('arrow-left', 14)}</button><span>Page ${NT.page + 1} of ${pages}</span><button type="button" data-nt-page="1" ${NT.page < pages - 1 ? '' : 'disabled'} aria-label="Next page">${icon('arrow-right', 14)}</button></div>
        </div>` : '');
    Orb.hydrate($('#ntList'));
    NT.fresh.clear();
  }

  // Open what a notification is about.
  function go(n) {
    const l = n.link || {};
    if (l.whatsNew) { showTab(l.tab || 'campaigns'); return window.CampaignSetup?.whatsNew({ force: true }); } // the What's new window again
    if (l.tab === 'inbox' && l.key) { showTab('inbox'); window.Inbox?.open(l.key); }
    else if (l.tab === 'campaigns' && l.id) { showTab('campaigns'); window.openCampaign?.(l.id); }
    else if (l.tab === 'numbers' && l.id) window.focusNumber(l.id);
    else if (l.tab === 'templates' && l.id) window.focusTemplate(l.id);
    else if (l.tab) showTab(l.tab);
  }

  // Ask the server again for the page you're on (after anything changes what's on it).
  const reload = () => load().then(() => visible() && render()).catch((e) => toast(e.message, 'error'));
  // A filter or the days changed: from the first page.
  const refilter = () => { NT.page = 0; return reload(); };

  async function setRead(ids, read = true) {
    // (shown at once on this page; the server's count follows)
    let delta = 0;
    for (const n of NT.list) if (ids.includes(n.id) && n.read !== read) { n.read = read; delta += read ? -1 : 1; }
    NT.unread = Math.max(0, NT.unread + delta);
    if (NT.res) NT.res.counts.unread = NT.unread;
    badge();
    if (visible()) render();
    const r = await api('/notifications/read', { method: 'POST', body: { ids, read } }).catch(() => null);
    if (r) { NT.unread = r.unread; badge(); }
    if (visible() && NT.filter === 'unread') reload(); // read ones leave the Unread list
  }

  // Slide a row out, then drop it.
  function removeRows(ids) {
    const els = ids.map((id) => $(`.nt-item[data-id="${id}"]`)).filter(Boolean);
    if (Motion.reduce() || !els.length) return finish();
    els.forEach((el) => { el.style.height = el.offsetHeight + 'px'; void el.offsetHeight; el.classList.add('gone'); });
    setTimeout(finish, 320);
    function finish() {
      NT.list = NT.list.filter((n) => !ids.includes(n.id));
      render();
      setTimeout(reload, 400); // the server's page and counts (the next ones move up)
    }
  }

  $('#ntFilter').addEventListener('change', (e) => {
    if (e.target.value === NT.filter) return;
    NT.filter = e.target.value;
    refilter();
    $('#ntList').classList.remove('nt-enter');
    void $('#ntList').offsetWidth;
    $('#ntList').classList.add('nt-enter');
  });

  // Days: the same calendar as Campaigns and the Inbox (one day, several, or a range); dots show how many each day has.
  $('#ntDateWrap').addEventListener('click', (e) => {
    const b = e.target.closest('#ntDate');
    if (!b) return;
    if (e.target.closest('[data-df-clear]')) { NT.date = null; return refilter(); }
    const marks = new Map(Object.entries(NT.res?.days || {}));
    DateFilter.open(b, { value: NT.date, marks, onChange: (v) => { NT.date = v; refilter(); } });
  });
  $('#ntPer').addEventListener('change', (e) => {
    NT.per = Number(e.target.value) || 0;
    try { localStorage.setItem('ntPer', String(NT.per)); } catch { }
    refilter();
  });
  $('#ntList').addEventListener('click', async (e) => {
    if (e.target.closest('[data-nt-anydate]')) { NT.date = null; return refilter(); }
    const pg = e.target.closest('[data-nt-page]');
    if (pg) {
      NT.page += Number(pg.dataset.ntPage);
      await reload(); // that page, from the server
      // back to the top of the list, under the pinned header
      const top = $('#ntList').getBoundingClientRect().top + scrollY - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stick-top')) || 0) - ($('#tab-notifications > .section-head')?.offsetHeight || 0) - 12;
      scrollTo({ top: Math.max(0, top), behavior: Motion.reduce() ? 'auto' : 'smooth' });
      return;
    }
  });
  $('#ntList').addEventListener('click', (e) => {
    const item = e.target.closest('.nt-item');
    if (!item) return;
    const n = NT.list.find((x) => x.id === item.dataset.id);
    if (!n) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'toggle') return setRead([n.id], !n.read);
    if (act === 'remove') {
      removeRows([n.id]);
      return api('/notifications/clear', { method: 'POST', body: { ids: [n.id] } }).catch((err) => toast(err.message, 'error'));
    }
    if (!n.read) setRead([n.id]);
    go(n);
  });
  $('#ntList').addEventListener('keydown', (e) => {
    const item = e.target.closest('.nt-item');
    if (item && e.target === item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); item.click(); }
  });

  $('#ntReadAll').addEventListener('click', () => guard(async () => {
    NT.list.forEach((n) => (n.read = true));
    NT.unread = 0;
    badge();
    render();
    await api('/notifications/read', { method: 'POST', body: { all: true } });
    await reload();
  }));

  $('#ntClear').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const readCount = NT.res?.counts.read || 0, allCount = NT.res?.counts.all || 0;
    const items = [];
    if (readCount) items.push({ label: `Clear read (${readCount})`, action: () => clear({ read: true }, NT.list.filter((n) => n.read).map((n) => n.id)) });
    items.push({
      label: `Clear all (${allCount})`, action: async () => {
        if (!(await confirmDialog({ title: 'Clear all notifications?', message: 'This removes them from the list. Campaigns, chats and contacts aren’t affected.', confirmText: 'Clear all', danger: true }))) return;
        clear({ all: true }, NT.list.map((n) => n.id));
      }
    });
    Sheet.Menu.open(r.left, r.bottom + 4, items);
  });

  function clear(body, ids) {
    removeRows(ids);
    api('/notifications/clear', { method: 'POST', body }).catch((err) => toast(err.message, 'error'));
  }

  // --- Live --------------------------------------------------------------------

  let liveT = 0;
  document.addEventListener('live', (e) => {
    const ev = e.detail;
    if (ev.kind === 'reconnect') return load().then(() => visible() && render()).catch(() => { });
    if (ev.kind !== 'notification') return;
    if (typeof ev.unread === 'number') NT.unread = ev.unread;
    const n = ev.notification;
    if (n) { NT.fresh.add(n.id); popToast(n); }
    badge();
    // the page you're looking at asks again (newest first, so a new one lands on page 1); not open: only the badge
    if (visible()) { clearTimeout(liveT); liveT = setTimeout(reload, 300); }
  });

  function popToast(n) {
    if (!TOAST.has(n.kind) || n.read || visible()) return;
    // No toast for a message in the chat you're reading.
    if (n.link?.tab === 'inbox' && n.link.key && window.Inbox?.viewing() === n.link.key && (n.kind === 'message' || n.kind === 'ai_draft')) return;
    toast(n.body || '', ERROR_KINDS.has(n.kind) ? 'error' : '', {
      title: n.title,
      icon: (KIND[n.kind] || {}).icon || 'bell',
      onClick: () => { setRead([n.id]); go(n); },
    });
  }

  window.Notifications = {
    async show() {
      if (!NT.loaded) $('#ntList').innerHTML = Skel.notif(6);
      await guard(load);
      render();
    },
  };
  load().catch(() => { });
})();
