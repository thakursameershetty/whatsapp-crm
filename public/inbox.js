// Inbox — WhatsApp-style conversations: messages people send to our numbers
// (from the webhook) plus our replies and the campaign messages they received.
// Uses helpers from app.js: $, $$, api, esc, icon, toast, state, openModal,
// closeModal, bubbleHtml, guard.

(function () {
  const ib = {
    convs: [],
    unread: 0,
    key: null, // open conversation
    thread: null, // { conversation, messages }
    filter: 'all',
    q: '',
    sender: '',
    replyTo: null, // message being replied to
    drafts: {},
    loaded: false,
  };

  const enc = encodeURIComponent;
  const visible = () => !$('#tab-inbox').classList.contains('hidden');
  const current = () => ib.convs.find((c) => c.key === ib.key) || ib.thread?.conversation;

  // ---------- Formatting ----------

  const DAY = 86400000;
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const daysAgo = (ts) => Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY);
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function listTime(ts) {
    if (!ts) return '';
    const d = daysAgo(ts);
    if (d === 0) return fmtTime(ts);
    if (d === 1) return 'Yesterday';
    if (d < 7) return new Date(ts).toLocaleDateString([], { weekday: 'short' });
    return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: '2-digit' });
  }
  function dayLabel(ts) {
    const d = daysAgo(ts);
    if (d === 0) return 'Today';
    if (d === 1) return 'Yesterday';
    if (d < 7) return new Date(ts).toLocaleDateString([], { weekday: 'long' });
    return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function fmtPhone(wa) {
    const m = /^91(\d{5})(\d{5})$/.exec(wa);
    return m ? `+91 ${m[1]} ${m[2]}` : '+' + wa;
  }
  const displayName = (c) => c.name || fmtPhone(c.wa);
  function initials(c) {
    if (!c.name) return icon('users', 18);
    const parts = c.name.trim().split(/\s+/);
    return esc((parts[0][0] + (parts[1]?.[0] || '')).toUpperCase());
  }

  // WhatsApp-style *bold* _italic_ ~strike~ and clickable links.
  function fmtText(text) {
    return esc(text)
      .split(/(https?:\/\/[^\s<]+)/g)
      .map((part, i) =>
        i % 2
          ? `<a href="${part}" target="_blank" rel="noopener">${part}</a>`
          : part
              .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
              .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<i>$2</i>')
              .replace(/~([^~\n]+)~/g, '<s>$1</s>')
      )
      .join('');
  }

  const MEDIA_LABEL = { image: '📷 Photo', video: '🎥 Video', audio: '🎤 Audio', sticker: '💟 Sticker', location: '📍 Location' };
  function previewText(m) {
    if (!m) return '';
    if (m.type === 'reaction') return `Reacted ${m.reaction?.emoji || ''}`;
    if (m.type === 'template') return `Template: ${m.templateName || m.text}`;
    if (m.type === 'document') return '📄 ' + (m.media?.filename || m.text || 'Document');
    if (MEDIA_LABEL[m.type]) return MEDIA_LABEL[m.type] + (m.text ? ' ' + m.text : '');
    return m.text || '';
  }

  // Message ticks: clock (sending), ✓ sent, ✓✓ delivered, blue ✓✓ read, ! failed.
  function ticks(status, error) {
    if (status === 'pending') return `<svg class="ib-tick" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2 1.3"/></svg>`;
    if (status === 'failed') return `<span class="ib-tick failed" title="${esc(error || 'Not delivered')}">!</span>`;
    const double = status === 'delivered' || status === 'read';
    return `<svg class="ib-tick ${status === 'read' ? 'read' : ''}" viewBox="0 0 18 11" width="17" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${
      double ? '<path d="M1 5.8 4.2 9 11 1.8"/><path d="M7.6 8.4 8.2 9 15 1.8"/>' : '<path d="M3 5.8 6.2 9 13 1.8"/>'
    }</svg>`;
  }

  // ---------- Conversation list ----------

  async function loadList() {
    const res = await api('/inbox');
    ib.convs = res.conversations;
    ib.unread = res.unread;
    ib.loaded = true;
    renderBadge();
    if (visible()) renderList();
  }

  function renderBadge() {
    const b = $('#inboxBadge');
    b.textContent = ib.unread > 99 ? '99+' : ib.unread;
    b.classList.toggle('hidden', !ib.unread);
    document.title = (ib.unread ? `(${ib.unread}) ` : '') + 'WhatsApp Sender';
  }

  function filtered() {
    const q = ib.q.toLowerCase();
    const now = Date.now();
    return ib.convs.filter((c) => {
      if (ib.filter === 'unread' && !c.unread) return false;
      if (ib.filter === 'open' && !(c.windowEndsAt && new Date(c.windowEndsAt) > now)) return false;
      if (ib.sender && c.senderId !== ib.sender) return false;
      if (q && ![c.name, c.wa, fmtPhone(c.wa), c.last?.text].some((v) => String(v || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function renderList() {
    // Number filter only matters with more than one number in play.
    const senders = [...new Map(ib.convs.map((c) => [c.senderId, c.senderLabel]))];
    const sel = $('#ibSender');
    sel.classList.toggle('hidden', senders.length < 2);
    sel.innerHTML = `<option value="">All numbers</option>` + senders.map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join('');
    sel.value = senders.some(([id]) => id === ib.sender) ? ib.sender : '';
    const multi = senders.length > 1;

    const list = filtered();
    const box = $('#ibConvs');
    if (!ib.convs.length) {
      box.innerHTML = `<div class="ib-none">No conversations yet.</div>`;
    } else if (!list.length) {
      box.innerHTML = `<div class="ib-none">No chats match.</div>`;
    } else {
      box.innerHTML = list
        .map((c) => {
          const l = c.last || {};
          return `<button class="ib-conv ${c.key === ib.key ? 'active' : ''} ${c.unread ? 'unread' : ''}" data-key="${esc(c.key)}" role="listitem">
            <span class="ib-av">${initials(c)}</span>
            <span class="ib-conv-main">
              <span class="ib-conv-top"><b>${esc(displayName(c))}</b><time>${listTime(c.lastAt)}</time></span>
              <span class="ib-conv-bot">
                <span class="ib-prev">${l.dir === 'out' ? ticks(l.status) : ''}<span>${esc(previewText(l))}</span></span>
                ${c.unread ? `<span class="ib-count">${c.unread}</span>` : ''}
              </span>
              ${multi ? `<span class="ib-via">via ${esc(c.senderLabel)}</span>` : ''}
            </span>
          </button>`;
        })
        .join('');
    }
    if (!ib.key) renderChat();
  }

  $('#ibConvs').addEventListener('click', (e) => {
    const b = e.target.closest('.ib-conv');
    if (b) openConversation(b.dataset.key);
  });
  $('#ibSearch').addEventListener('input', (e) => { ib.q = e.target.value.trim(); renderList(); });
  $('#ibSender').addEventListener('change', (e) => { ib.sender = e.target.value; renderList(); });
  $('#ibFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    ib.filter = b.dataset.f;
    $$('#ibFilter button').forEach((x) => x.classList.toggle('active', x === b));
    renderList();
  });

  // ---------- Conversation ----------

  async function openConversation(key) {
    if (ib.key && ib.key !== key) ib.drafts[ib.key] = $('#ibText')?.value || '';
    ib.key = key;
    ib.replyTo = null;
    ib.thread = null;
    $('#inbox').classList.add('has-chat');
    renderList();
    renderChat();
    await loadThread(true);
    markRead();
  }

  function closeConversation() {
    if (ib.key) ib.drafts[ib.key] = $('#ibText')?.value || '';
    ib.key = null;
    ib.thread = null;
    $('#inbox').classList.remove('has-chat');
    renderList();
    renderChat();
  }

  async function loadThread(toBottom = false) {
    const key = ib.key;
    if (!key) return;
    const t = await api('/inbox/' + enc(key));
    if (key !== ib.key) return; // switched while loading
    // Keep messages still being sent (not on the server yet).
    const pending = (ib.thread?.messages || []).filter((m) => m.status === 'pending' || m.local);
    ib.thread = t;
    t.messages.push(...pending);
    renderChat(toBottom);
  }

  function markRead() {
    const c = ib.convs.find((x) => x.key === ib.key);
    if (!c || !c.unread || document.hidden || !visible()) return;
    ib.unread -= c.unread;
    c.unread = 0;
    renderBadge();
    renderList();
    api(`/inbox/${enc(c.key)}/read`, { method: 'POST' }).catch(() => {});
  }

  function windowInfo(c) {
    const end = c?.windowEndsAt ? new Date(c.windowEndsAt).getTime() : 0;
    const left = end - Date.now();
    if (left <= 0) return { open: false, label: 'Template only' };
    const h = Math.floor(left / 3600000);
    return { open: true, label: h >= 1 ? `${h}h left to reply` : `${Math.max(1, Math.round(left / 60000))}m left to reply` };
  }

  function renderChat(toBottom = false) {
    const pane = $('#ibChat');
    if (!ib.key) {
      pane.innerHTML = emptyPane();
      LA.hydrate(pane);
      return;
    }
    const c = current();
    if (!c) {
      pane.innerHTML = `<div class="ib-empty"><div class="ib-loading">Loading…</div></div>`;
      return;
    }
    const w = windowInfo(c);
    const sameChat = pane.dataset.key === ib.key && $('#ibMsgs', pane);
    if (!sameChat) {
      pane.dataset.key = ib.key;
      pane.innerHTML = `
        <header class="ib-head">
          <button class="icon-btn ib-back" id="ibBack" aria-label="Back to chats">${icon('arrow-left', 18)}</button>
          <span class="ib-av">${initials(c)}</span>
          <div class="ib-who"><b id="ibName"></b><span id="ibSub"></span></div>
          <span class="ib-window" id="ibWindow"></span>
        </header>
        <div class="ib-msgs" id="ibMsgs"></div>
        <div id="ibFoot"></div>`;
      $('#ibBack').onclick = closeConversation;
      toBottom = true;
    }
    $('#ibName').textContent = displayName(c);
    $('#ibSub').textContent = `${c.name ? fmtPhone(c.wa) + ' · ' : ''}via ${c.senderLabel}`;
    const chip = $('#ibWindow');
    chip.className = 'ib-window ' + (w.open ? 'open' : 'closed');
    chip.innerHTML = icon(w.open ? 'clock' : 'file-text', 13) + esc(w.label);
    chip.title = w.open
      ? 'WhatsApp allows free-form replies for 24 hours after their last message'
      : 'More than 24 hours since their last message: only approved templates can be sent';
    renderMessages(toBottom);
    renderFoot(w.open);
  }

  function emptyPane() {
    if (ib.loaded && !ib.convs.length) {
      const demo = state.settings.demoMode;
      return `<div class="ib-empty"><div>
        <div class="ib-empty-ico">${icon('message-circle', 30)}</div>
        <h3>No messages yet</h3>
        <p>When someone replies to your WhatsApp number, the conversation shows up here instantly.</p>
        <p class="ib-hint">${
          demo
            ? 'In demo mode, <b>Overview → Load demo workspace</b> adds sample conversations.'
            : 'Meta delivers replies through the webhook, so the app must be reachable on a public HTTPS address. Set the Callback URL and verify token from <a href="#" data-goto="settings">Settings</a> in your Meta app, and subscribe to the <code>messages</code> field.'
        }</p>
      </div></div>`;
    }
    return `<div class="ib-empty"><div>
      <div class="ib-empty-ico">${icon('message-circle', 30)}</div>
      <h3>WhatsApp Inbox</h3>
      <p>Pick a conversation to read and reply. Free-form replies are allowed for 24 hours after a customer's last message; after that, send a template.</p>
    </div></div>`;
  }

  function renderMessages(toBottom) {
    const box = $('#ibMsgs');
    if (!box) return;
    const msgs = ib.thread?.messages || [];
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const byWamid = new Map(msgs.filter((m) => m.wamid).map((m) => [m.wamid, m]));
    const reactions = new Map();
    for (const m of msgs) if (m.type === 'reaction' && m.reaction?.to && m.reaction.emoji) reactions.set(m.reaction.to, m.reaction.emoji);

    if (!ib.thread) {
      box.innerHTML = `<div class="ib-loading">Loading…</div>`;
      return;
    }
    if (!msgs.length) {
      box.innerHTML = `<div class="ib-day">No messages yet. Send a template to start the conversation.</div>`;
      return;
    }

    let html = '';
    let prev = null;
    for (const m of msgs) {
      if (m.type === 'reaction') continue;
      if (!prev || startOfDay(prev.ts) !== startOfDay(m.ts)) {
        html += `<div class="ib-day">${dayLabel(m.ts)}</div>`;
        prev = null;
      }
      const first = !prev || prev.dir !== m.dir || new Date(m.ts) - new Date(prev.ts) > 10 * 60000;
      const react = m.wamid && reactions.get(m.wamid);
      html += `<div class="ib-row ${m.dir} ${first ? 'first' : ''} ${react ? 'reacted' : ''}" data-wamid="${esc(m.wamid || '')}">
        <div class="ib-bubble ${m.type}">${msgBody(m, byWamid)}${react ? `<span class="ib-reacts">${esc(react)}</span>` : ''}</div>
        ${m.wamid && m.dir === 'in' ? `<button class="ib-reply-btn" data-reply="${esc(m.wamid)}" title="Reply" aria-label="Reply">${icon('reply', 14)}</button>` : ''}
      </div>`;
      if (m.status === 'failed' && m.error) html += `<div class="ib-err">Not delivered: ${esc(m.error)}</div>`;
      prev = m;
    }
    box.innerHTML = html;
    if (toBottom || nearBottom) box.scrollTop = box.scrollHeight;
    ib.stick = toBottom || nearBottom;
  }

  function msgBody(m, byWamid) {
    const c = current();
    // Sent while in Demo mode: never reached WhatsApp, so no ticks and a clear label.
    // (Sample conversations from the demo workspace are demo through and through; no label needed.)
    const simulated = m.dir === 'out' && m.demo && !m.seed;
    const tick = (status, error) => (simulated ? '' : ticks(status, error));
    let h = simulated ? `<div class="ib-label ib-demo">Demo mode · not actually sent</div>` : '';
    if (m.context) {
      const q = byWamid.get(m.context);
      h += `<div class="ib-quote" data-jump="${esc(m.context)}"><b>${q ? (q.dir === 'out' ? 'You' : esc(displayName(c))) : 'Reply'}</b><span>${esc(q ? previewText(q) : 'Original message')}</span></div>`;
    }
    const src = m.media?.id ? `/api/media/${enc(m.media.id)}` : '';
    let textInside = true;
    switch (m.type) {
      case 'template': {
        const t = state.templates.find((x) => x.id === m.templateId);
        h += `<div class="ib-label">${icon('send', 11)}${esc(m.campaign === 'Test send' ? 'Test send · ' + m.templateName : m.campaign ? 'Campaign · ' + m.campaign : 'Template · ' + m.templateName)}</div>`;
        h += t ? `<div class="bubble">${bubbleHtml(t, m.values || {})}</div>` : `<div class="ib-text">Template <code>${esc(m.templateName)}</code></div>`;
        return h + `<span class="ib-meta static">${fmtTime(m.ts)}${tick(m.status, m.error)}</span>`;
      }
      case 'image':
      case 'sticker':
        h += `<a class="ib-media ${m.type}" href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${m.type}" loading="lazy" onerror="this.parentNode.classList.add('broken')"></a>`;
        break;
      case 'video':
        h += `<video class="ib-media" controls preload="metadata" src="${src}"></video>`;
        break;
      case 'audio':
        h += `<audio class="ib-audio" controls preload="none" src="${src}"></audio>`;
        break;
      case 'document': {
        const name = m.media?.filename || 'Document';
        h += `<a class="ib-doc" href="${src}?name=${enc(name)}">${icon('file-text', 22)}<span><b>${esc(name)}</b><small>${esc(m.media?.mime || '')}</small></span>${icon('download', 16)}</a>`;
        break;
      }
      case 'location': {
        const l = m.location || {};
        h += `<a class="ib-loc" href="https://maps.google.com/?q=${l.lat},${l.lng}" target="_blank" rel="noopener"><span class="ib-loc-pin">${icon('map-pin', 22)}</span><span><b>${esc(l.name || 'Shared location')}</b><small>${esc(l.address || `${l.lat}, ${l.lng}`)}</small></span></a>`;
        break;
      }
      case 'button':
      case 'interactive':
        h += `<div class="ib-label">${icon('reply', 11)}Tapped a button</div>`;
        break;
      case 'unsupported':
        h += `<div class="ib-text ib-unsupported">${esc(m.text)}</div>`;
        textInside = false;
        break;
    }
    const meta = `${fmtTime(m.ts)}${m.dir === 'out' ? tick(m.status, m.error) : ''}`;
    if (textInside && m.text) h += `<div class="ib-text">${fmtText(m.text)}<span class="ib-spacer ${m.dir}"></span></div>`;
    return h + `<span class="ib-meta ${m.text || m.type === 'unsupported' ? '' : 'over'}">${meta}</span>`;
  }

  // Jump to a quoted message; start a reply.
  $('#ibChat').addEventListener('click', (e) => {
    const r = e.target.closest('[data-reply]');
    if (r) return startReply(r.dataset.reply);
    const j = e.target.closest('.ib-quote[data-jump]');
    if (j && j.closest('#ibMsgs')) {
      const row = $(`.ib-row[data-wamid="${CSS.escape(j.dataset.jump)}"]`);
      if (!row) return;
      row.scrollIntoView({ block: 'center', behavior: Motion.reduce() ? 'auto' : 'smooth' });
      row.classList.remove('ib-flash');
      void row.offsetWidth;
      row.classList.add('ib-flash');
    }
  });
  // Images load after render; keep the view pinned to the newest message.
  $('#ibChat').addEventListener('load', (e) => {
    if (e.target.tagName === 'IMG' && ib.stick) { const b = $('#ibMsgs'); if (b) b.scrollTop = b.scrollHeight; }
  }, true);

  // ---------- Composer ----------

  function renderFoot(open) {
    const foot = $('#ibFoot');
    const mode = open ? 'open' : 'closed';
    if (foot.dataset.mode === mode && foot.dataset.key === ib.key) return renderReplyBar();
    foot.dataset.mode = mode;
    foot.dataset.key = ib.key;
    if (!open) {
      foot.innerHTML = `<div class="ib-closed">
        <div><b>Reply window closed</b><span>WhatsApp only allows free-form replies within 24 hours of the customer's last message. Send an approved template to restart the conversation.</span></div>
        <button class="btn primary sm" id="ibTplBtn" data-icon="file-text" data-icon-size="14">Send template</button>
      </div>`;
      LA.hydrate(foot);
      $('#ibTplBtn').onclick = templateModal;
      return;
    }
    foot.innerHTML = `<div class="ib-compose">
      <div class="ib-replybar hidden" id="ibReplyBar"></div>
      <div class="ib-compose-row">
        <button class="icon-btn la-host" id="ibTplBtn" title="Send a template" aria-label="Send a template">${icon('file-text', 18)}</button>
        <textarea id="ibText" rows="1" placeholder="Type a message" aria-label="Message"></textarea>
        <button class="ib-send" id="ibSendBtn" aria-label="Send" title="Send (Enter)">${icon('send', 18)}</button>
      </div>
    </div>`;
    const ta = $('#ibText');
    ta.value = ib.drafts[ib.key] || '';
    autosize();
    ta.addEventListener('input', autosize);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); }
      if (e.key === 'Escape' && ib.replyTo) { e.stopPropagation(); ib.replyTo = null; renderReplyBar(); }
    });
    $('#ibSendBtn').onclick = sendText;
    $('#ibTplBtn').onclick = templateModal;
    renderReplyBar();
    if (matchMedia('(pointer: fine)').matches) ta.focus();
  }

  function autosize() {
    const ta = $('#ibText');
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
    $('#ibSendBtn').disabled = !ta.value.trim();
  }

  function startReply(wamid) {
    ib.replyTo = ib.thread?.messages.find((m) => m.wamid === wamid) || null;
    renderReplyBar();
    $('#ibText')?.focus();
  }

  function renderReplyBar() {
    const bar = $('#ibReplyBar');
    if (!bar) return;
    const m = ib.replyTo;
    bar.classList.toggle('hidden', !m);
    if (!m) return;
    bar.innerHTML = `<div class="ib-quote"><b>${m.dir === 'out' ? 'You' : esc(displayName(current()))}</b><span>${esc(previewText(m))}</span></div>
      <button class="icon-btn" id="ibReplyX" aria-label="Cancel reply">${icon('x', 16)}</button>`;
    $('#ibReplyX').onclick = () => { ib.replyTo = null; renderReplyBar(); };
  }

  async function sendText() {
    const ta = $('#ibText');
    const text = ta.value.trim();
    if (!text || !ib.key) return;
    const key = ib.key;
    const replyTo = ib.replyTo?.wamid;
    const temp = { id: 'tmp' + Date.now(), local: true, dir: 'out', type: 'text', text, ts: new Date().toISOString(), status: 'pending', context: replyTo };
    ib.thread.messages.push(temp);
    ta.value = '';
    ib.drafts[key] = '';
    ib.replyTo = null;
    autosize();
    renderReplyBar();
    renderMessages(true);
    try {
      await api(`/inbox/${enc(key)}/send`, { method: 'POST', body: { text, replyTo } });
      if (ib.key === key) {
        ib.thread.messages = ib.thread.messages.filter((m) => m !== temp);
        await loadThread();
      }
    } catch (e) {
      Object.assign(temp, { status: 'failed', error: e.message });
      if (ib.key === key) renderMessages();
      toast(e.message, 'error');
    }
  }

  // ---------- Templates & new chats ----------

  function templateModal() {
    const usable = state.templates.filter((t) => !['REJECTED', 'PAUSED', 'DISABLED'].includes(t.status));
    if (!usable.length) return toast('Add or sync a template first (Templates page)', 'error');
    const c = current();
    const key = ib.key;
    const firstName = (c?.name || '').split(/\s+/)[0];
    const values = {};
    const body = openModal(
      'Send a template',
      `<p class="sub ib-modal-sub">To ${esc(displayName(c))} · via ${esc(c?.senderLabel || '')}</p>
      <label>Template<select id="itTpl">${usable.map((t) => `<option value="${t.id}">${esc(t.name)} · ${esc(t.language)}</option>`).join('')}</select></label>
      <div id="itVars"></div>
      <div class="tpl-chat"><div class="bubble" id="itPrev"></div></div>
      <div class="modal-actions"><button class="btn quiet" id="itCancel">Cancel</button><button class="btn primary" id="itSend" data-icon="send">Send template</button></div>`
    );
    const tpl = () => usable.find((t) => t.id === $('#itTpl', body).value);
    const draw = () => {
      const t = tpl();
      $('#itVars', body).innerHTML = t.variables
        .map((v) => {
          if (values[v.key] == null) values[v.key] = v.key === 'body.1' || /name/i.test(v.name) ? firstName : '';
          return `<label>${esc(v.where === 'body' ? 'Body' : v.where === 'header' ? 'Header' : 'Button')} {{${esc(v.name)}}}<input data-k="${esc(v.key)}" value="${esc(values[v.key])}" placeholder="${v.media ? 'https://…' : ''}" /></label>`;
        })
        .join('');
      $('#itPrev', body).innerHTML = bubbleHtml(t, values);
    };
    draw();
    $('#itTpl', body).onchange = draw;
    $('#itVars', body).addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      values[k] = e.target.value;
      $('#itPrev', body).innerHTML = bubbleHtml(tpl(), values);
    });
    $('#itCancel', body).onclick = closeModal;
    $('#itSend', body).onclick = (e) =>
      guard(async () => {
        const t = tpl();
        const picked = Object.fromEntries(t.variables.map((v) => [v.key, values[v.key] || '']));
        await api(`/inbox/${enc(key)}/send`, { method: 'POST', body: { templateId: t.id, values: picked } });
        closeModal();
        toast('Template sent');
        await loadList();
        if (ib.key === key) await loadThread(true);
      }, e.currentTarget);
  }

  function newChatModal() {
    const senders = state.senders.filter((s) => s.enabled);
    if (!senders.length) return toast('Add a WhatsApp number first (Numbers page)', 'error');
    const body = openModal(
      'New chat',
      `<p class="sub ib-modal-sub">WhatsApp only lets you start a conversation with an approved template. Free-form messages open up once they reply.</p>
      <label>Phone number<input id="ncPhone" inputmode="tel" placeholder="98765 43210 or +91 98765 43210" /></label>
      <label>From<select id="ncSender">${senders.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}${s.displayPhone ? ' · ' + esc(s.displayPhone) : ''}</option>`).join('')}</select></label>
      <div class="modal-actions"><button class="btn quiet" id="ncCancel">Cancel</button><button class="btn primary" id="ncGo">Open chat</button></div>`
    );
    $('#ncPhone', body).focus();
    $('#ncCancel', body).onclick = closeModal;
    const go = () => {
      let digits = $('#ncPhone', body).value.replace(/\D/g, '').replace(/^00/, '');
      const cc = state.settings.defaultCountryCode;
      if (cc && digits.length === 10) digits = cc + digits;
      if (digits.length < 8 || digits.length > 15) return toast('Enter a valid phone number with country code', 'error');
      closeModal();
      openConversation(`${$('#ncSender', body).value}:${digits}`);
    };
    $('#ncGo', body).onclick = go;
    $('#ncPhone', body).addEventListener('keydown', (e) => e.key === 'Enter' && go());
  }
  $('#ibNew').addEventListener('click', newChatModal);

  // ---------- Live updates ----------

  let listTimer = null;
  let threadTimer = null;
  const notify = new Set();

  function onEvent(ev) {
    if (ev.kind === 'message' && ev.dir === 'in' && !(visible() && ev.key === ib.key && !document.hidden)) notify.add(ev.key);
    clearTimeout(listTimer);
    listTimer = setTimeout(async () => {
      await loadList().catch(() => {});
      // A toast for new messages you aren't looking at.
      for (const key of notify) {
        const c = ib.convs.find((x) => x.key === key);
        if (c && (!visible() || key !== ib.key)) toast(`New message from ${displayName(c)}: ${previewText(c.last)}`.slice(0, 120));
      }
      notify.clear();
      if (ev.kind === 'message' && ev.key === ib.key) markRead();
    }, 150);
    if (ev.key === ib.key && visible()) {
      clearTimeout(threadTimer);
      threadTimer = setTimeout(() => loadThread().catch(() => {}), 120);
    }
  }

  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('inbox', (e) => onEvent(JSON.parse(e.data)));
    // After a reconnect, catch up on anything missed.
    es.addEventListener('open', () => ib.loaded && loadList().catch(() => {}));
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && visible()) markRead();
  });
  // Keep the "Xh left to reply" chip honest.
  setInterval(() => { if (visible() && ib.key) renderChat(); }, 60000);

  // ---------- Layout ----------

  function fit() {
    const el = $('#inbox');
    if (!visible()) return;
    const top = el.getBoundingClientRect().top + scrollY;
    el.style.height = Math.max(420, Math.floor(innerHeight - top)) + 'px';
  }
  addEventListener('resize', fit);

  window.Inbox = {
    async show() {
      scrollTo(0, 0);
      fit();
      renderList();
      renderChat(true);
      await loadList().catch((e) => toast(e.message, 'error'));
      if (ib.key) { await loadThread().catch(() => {}); markRead(); }
      fit();
    },
  };

  connect();
  loadList().catch(() => {});
})();
