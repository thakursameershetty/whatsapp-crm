// Notifications page: everything worth knowing about, newest first, grouped by day.
// Campaigns finishing, failed deliveries, new messages, opt-outs and what the Inbox lead
// assistant did or needs. Clicking one marks it read and opens where you can act on it.
// New ones arrive live (over the Inbox's event stream) and pop a toast you can click or dismiss.

(function () {
  const NT = { list: [], unread: 0, filter: 'all', loaded: false, fresh: new Set() };

  const KIND = {
    message: { icon: 'message-circle', tone: 'info' },
    optout: { icon: 'bell-off', tone: 'muted' },
    reply_failed: { icon: 'badge-alert', tone: 'danger' },
    campaign_started: { icon: 'rocket', tone: 'violet' },
    campaign_done: { icon: 'circle-check', tone: 'good' },
    delivery_failed: { icon: 'badge-alert', tone: 'danger' },
    ai_draft: { icon: 'sparkles', tone: 'violet' },
    ai_auto: { icon: 'send', tone: 'violet' },
    ai_handover: { icon: 'users', tone: 'warn' },
    ai_qualified: { icon: 'trending-up', tone: 'good' },
    ai_error: { icon: 'badge-alert', tone: 'warn' },
  };
  const FILTERS = [['all', 'All'], ['unread', 'Unread'], ['messages', 'Messages'], ['campaigns', 'Campaigns'], ['ai', 'AI assistant']];
  // Which new notifications also pop a toast. (Everything lands on the page either way.)
  const TOAST = new Set(['message', 'optout', 'reply_failed', 'campaign_started', 'campaign_done', 'delivery_failed', 'ai_draft', 'ai_auto', 'ai_handover', 'ai_qualified', 'ai_error']);
  const ERROR_KINDS = new Set(['reply_failed', 'delivery_failed', 'ai_error']);

  const visible = () => !$('#tab-notifications').classList.contains('hidden');
  const shown = () => NT.list.filter((n) => (NT.filter === 'all' ? true : NT.filter === 'unread' ? !n.read : n.category === NT.filter));

  async function load() {
    const r = await api('/notifications');
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
      <span class="nt-ico tone-${k.tone}">${icon(k.icon, 17)}</span>
      <span class="nt-main">
        <b>${esc(n.title)}</b>
        ${n.body ? `<span class="nt-body">${esc(n.body)}</span>` : ''}
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
    const list = shown();
    $('#ntSub').textContent = NT.list.length
      ? `${NT.unread ? `${NT.unread.toLocaleString()} unread` : 'All caught up'} · ${NT.list.length.toLocaleString()} in total`
      : 'Campaigns, deliveries, messages and the AI assistant, in one place.';
    const count = (k) => (k === 'all' ? NT.list.length : k === 'unread' ? NT.unread : NT.list.filter((n) => n.category === k).length);
    Motion.patch($('#ntFilter'), FILTERS.map(([k, label]) => `<button data-f="${k}" class="${NT.filter === k ? 'active' : ''}" role="tab" aria-selected="${NT.filter === k}">${label}${count(k) ? ` <span class="opt">${count(k).toLocaleString()}</span>` : ''}</button>`).join(''));
    $('#ntReadAll').disabled = !NT.unread;
    $('#ntClear').disabled = !NT.list.length;

    if (!list.length) {
      $('#ntList').innerHTML = NT.list.length
        ? emptyState({ icon: 'check-check', title: NT.filter === 'unread' ? 'All caught up' : 'Nothing here', text: NT.filter === 'unread' ? 'You’ve read every notification.' : 'No notifications of this kind yet.' })
        : emptyState({ icon: 'bell', title: 'No notifications yet', text: 'When a campaign finishes, a delivery fails, someone messages you or the AI assistant needs you, it shows up here.' });
      LA.hydrate($('#ntList'));
      return;
    }
    const groups = new Map();
    list.forEach((n) => { const d = dayLabel(n.ts); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(n); });
    let i = 0;
    $('#ntList').innerHTML = [...groups].map(([day, items]) => `<section class="nt-day"><h3>${esc(day)}</h3><div class="card nt-card">${items.map((n) => row(n, i++)).join('')}</div></section>`).join('');
    NT.fresh.clear();
  }

  // Open what a notification is about.
  function go(n) {
    const l = n.link || {};
    if (l.tab === 'inbox' && l.key) { showTab('inbox'); window.Inbox?.open(l.key); }
    else if (l.tab === 'campaigns' && l.id) { showTab('campaigns'); window.openCampaign?.(l.id); }
    else if (l.tab) showTab(l.tab);
  }

  async function setRead(ids, read = true) {
    for (const n of NT.list) if (ids.includes(n.id)) n.read = read;
    NT.unread = NT.list.filter((n) => !n.read).length;
    badge();
    if (visible()) render();
    const r = await api('/notifications/read', { method: 'POST', body: { ids, read } }).catch(() => null);
    if (r) { NT.unread = r.unread; badge(); }
  }

  // Slide a row out, then drop it.
  function removeRows(ids) {
    const els = ids.map((id) => $(`.nt-item[data-id="${id}"]`)).filter(Boolean);
    if (Motion.reduce() || !els.length) return finish();
    els.forEach((el) => { el.style.height = el.offsetHeight + 'px'; void el.offsetHeight; el.classList.add('gone'); });
    setTimeout(finish, 320);
    function finish() {
      NT.list = NT.list.filter((n) => !ids.includes(n.id));
      NT.unread = NT.list.filter((n) => !n.read).length;
      badge();
      render();
    }
  }

  $('#ntFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b || b.dataset.f === NT.filter) return;
    NT.filter = b.dataset.f;
    render();
    $('#ntList').classList.remove('nt-enter');
    void $('#ntList').offsetWidth;
    $('#ntList').classList.add('nt-enter');
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
  }));

  $('#ntClear').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const readCount = NT.list.filter((n) => n.read).length;
    const items = [];
    if (readCount) items.push({ label: `Clear read (${readCount})`, action: () => clear({ read: true }, NT.list.filter((n) => n.read).map((n) => n.id)) });
    items.push({
      label: `Clear all (${NT.list.length})`, action: async () => {
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

  document.addEventListener('live', (e) => {
    const ev = e.detail;
    if (ev.kind === 'reconnect') return load().then(() => visible() && render()).catch(() => { });
    if (ev.kind !== 'notification') return;
    if (typeof ev.unread === 'number') NT.unread = ev.unread;
    const n = ev.notification;
    if (n) {
      NT.list = [n, ...NT.list.filter((x) => x.id !== n.id)];
      NT.fresh.add(n.id);
      popToast(n);
    }
    badge();
    if (visible()) render();
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
