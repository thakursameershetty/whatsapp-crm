// Inbox — WhatsApp-style conversations: messages people send to our numbers
// (from the webhook) plus our replies and the campaign messages they received.
// Uses helpers from app.js: $, $$, api, esc, icon, toast, state, openModal,
// closeModal, bubbleHtml, guard.

(function () {
  const ib = {
    seen: new Set(), seenKey: null, freshAt: new Map(), sentAt: new Map(), enter: false, template: '',
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

  // Why a message wasn't delivered, in plain words (Meta's own text stays available on hover).
  const FAIL_HELP = {
    131049: ['Meta held this back', "WhatsApp limits how many marketing messages one person gets from businesses. Meta decided this person had enough for now — it isn't a problem with your number or template. Try again in a day or two, or switch this template's category to Utility if it's an update rather than an offer."],
    131026: ['Not delivered', "This number isn't on WhatsApp, or their app is too old to receive it."],
    131047: ['Reply window closed', 'More than 24 hours since they last wrote, so only a template can be sent.'],
    131056: ['Too many messages too quickly', 'Wait a little before sending this person another message.'],
    131048: ['Spam limit reached', 'Too many people blocked or reported this number recently. Meta is limiting what it can send.'],
    130429: ['Sending too fast', 'Meta rate-limited this number. It will go through if you try again shortly.'],
    132001: ['Template not found', "Meta doesn't have this template in this language. Sync templates and check its name."],
    132015: ['Template paused', 'Meta paused this template because of low ratings. Use another one or edit it in WhatsApp Manager.'],
  };
  function failedNote(err) {
    const code = (String(err).match(/\b(1\d{5})\b/) || [])[1];
    const h = FAIL_HELP[code];
    return h
      ? `<div class="ib-err" title="${esc(err)}"><b>${esc(h[0])}</b> · ${esc(h[1])}</div>`
      : `<div class="ib-err">Not delivered: ${esc(err)}</div>`;
  }

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

  // WhatsApp-style *bold* _italic_ ~strike~ and clickable links (shared with template bubbles).
  const fmtText = (text) => waFormat(esc(text));

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
      if (ib.template && !(c.templates || []).includes(ib.template)) return false;
      if (q && ![c.name, c.wa, fmtPhone(c.wa), c.last?.text].some((v) => String(v || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function renderList() {
    // Number filter only matters with more than one number in play.
    // Every number in the workspace (not only ones with chats yet), with how many conversations each has.
    const senders = [...new Map([...state.senders.map((x) => [x.id, x.label]), ...ib.convs.map((c) => [c.senderId, c.senderLabel])])];
    const sel = $('#ibSender');
    sel.classList.toggle('hidden', senders.length < 2);
    sel.innerHTML = `<option value="">All numbers (${ib.convs.length})</option>` + senders.map(([id, label]) => `<option value="${esc(id)}">${esc(label)} (${ib.convs.filter((c) => c.senderId === id).length})</option>`).join('');
    sel.value = senders.some(([id]) => id === ib.sender) ? ib.sender : '';
    // Template filter: people who were sent a given template (by a campaign or from here).
    const tplNames = [...new Set(ib.convs.flatMap((c) => c.templates || []))].sort((a, b) => a.localeCompare(b));
    const tsel = $('#ibTemplate');
    tsel.classList.toggle('hidden', !tplNames.length);
    if (ib.template && !tplNames.includes(ib.template)) ib.template = '';
    tsel.innerHTML = `<option value="">All templates</option>` + tplNames.map((n) => `<option value="${esc(n)}">${esc(n)} (${ib.convs.filter((c) => (c.templates || []).includes(n)).length})</option>`).join('');
    tsel.value = ib.template;
    const multi = senders.length > 1;

    const list = filtered();
    const box = $('#ibConvItems');
    // Where each row was, so rows that move (a new message lifts a chat to the top) can glide there.
    const before = new Map($$('.ib-conv', box).map((el) => [el.dataset.key, el.getBoundingClientRect().top]));
    if (!ib.loaded) {
      box.innerHTML = Skel.rows(8);
    } else if (!ib.convs.length) {
      box.innerHTML = `<div class="ib-none">No conversations yet.</div>`;
    } else if (!list.length) {
      box.innerHTML = `<div class="ib-none">No chats match.</div>`;
    } else {
      box.innerHTML = list
        .map((c) => {
          const l = c.last || {};
          return `<button class="ib-conv ${c.key === ib.key ? 'active' : ''} ${c.unread ? 'unread' : ''}" data-key="${esc(c.key)}" role="listitem">
            <span class="ib-av" style="${avatarStyle(c.wa)}">${initials(c)}</span>
            <span class="ib-conv-main">
              <span class="ib-conv-top"><b>${esc(displayName(c))}</b>${c.ai?.handover ? '<span class="ib-flag need">Needs you</span>' : c.ai?.hasDraft ? '<span class="ib-flag draft">Draft</span>' : ''}<time>${listTime(c.lastAt)}</time></span>
              <span class="ib-conv-bot">
                <span class="ib-prev">${c.ai?.busy ? '<span class="ib-prev-typing">AI is typing…</span>' : `${l.dir === 'out' ? ticks(l.status) : ''}<span>${esc(previewText(l))}</span>`}</span>
                ${c.unread ? `<span class="ib-count">${c.unread}</span>` : ''}
              </span>
              ${multi ? `<span class="ib-via" title="via ${esc(c.senderLabel)}">via ${esc(c.senderLabel)}</span>` : ''}
            </span>
          </button>`;
        })
        .join('');
    }
    animateList(before);
    placeHighlight();
    if (!ib.key) renderChat();
  }

  // Rows that moved glide from their old spot; new rows fade in. After a filter or search,
  // the results cascade in instead.
  const EASE = 'cubic-bezier(0.65, 0, 0.35, 1)', EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
  function animateList(before) {
    const rows = $$('#ibConvItems .ib-conv');
    if (Motion.reduce() || !visible()) { ib.enter = false; return; }
    if (ib.enter) {
      ib.enter = false;
      rows.slice(0, 14).forEach((el, i) => el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: i * 26, easing: EASE_OUT, fill: 'backwards' }));
      return;
    }
    if (!before.size) return;
    for (const el of rows) {
      const was = before.get(el.dataset.key);
      if (was == null) { el.animate([{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: EASE_OUT }); continue; }
      const dy = was - el.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 480, easing: EASE });
    }
  }

  // One highlight behind the list that slides to the open chat (rows are re-rendered, it isn't).
  $('#ibConvs').innerHTML = `<i class="ib-hl" aria-hidden="true"></i><div id="ibConvItems">${Skel.rows(8)}</div>`;
  function placeHighlight() {
    const hl = $('#ibConvs .ib-hl'), on = $('#ibConvItems .ib-conv.active');
    if (!on) { hl.style.opacity = '0'; return; }
    const snap = hl.style.opacity !== '1' || Motion.reduce();
    if (snap) hl.style.transition = 'none';
    // Layout position (offsets), not the on-screen one: rows may be mid-slide when this runs.
    hl.style.transform = `translateY(${on.offsetTop + $('#ibConvItems').offsetTop}px)`;
    hl.style.height = on.offsetHeight + 'px';
    hl.style.opacity = '1';
    if (snap) { hl.getBoundingClientRect(); hl.style.transition = ''; }
  }
  new ResizeObserver(() => placeHighlight()).observe($('#ibConvItems'));

  $('#ibConvs').addEventListener('click', (e) => {
    const b = e.target.closest('.ib-conv');
    if (b) openConversation(b.dataset.key);
  });
  $('#ibSearch').addEventListener('input', (e) => { ib.q = e.target.value.trim(); ib.enter = true; renderList(); });
  $('#ibSender').addEventListener('change', (e) => { ib.sender = e.target.value; ib.enter = true; renderList(); });
  $('#ibTemplate').addEventListener('change', (e) => { ib.template = e.target.value; ib.enter = true; renderList(); });
  $('#ibFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    ib.filter = b.dataset.f;
    $$('#ibFilter button').forEach((x) => x.classList.toggle('active', x === b));
    ib.enter = true;
    renderList();
  });

  // ---------- Conversation ----------

  async function openConversation(key) {
    if (ib.key && ib.key !== key) ib.drafts[ib.key] = $('#ibText')?.value || '';
    if (key === ib.key) return;
    ib.key = key;
    ib.replyTo = null;
    ib.thread = null;
    // The old conversation slides out as this one slides in; the list highlight glides across.
    await Motion.morph(() => {
      $('#inbox').classList.add('has-chat');
      renderList();
      renderChat();
    }, 'ib');
    await loadThread(true);
    markRead();
  }

  function closeConversation() {
    if (ib.key) ib.drafts[ib.key] = $('#ibText')?.value || '';
    ib.key = null;
    ib.thread = null;
    Motion.morph(() => {
      $('#inbox').classList.remove('has-chat');
      renderList();
      renderChat();
    }, 'ib');
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
      pane.innerHTML = Skel.bubbles();
      return;
    }
    const w = windowInfo(c);
    const sameChat = pane.dataset.key === ib.key && $('#ibMsgs', pane);
    if (!sameChat) {
      pane.dataset.key = ib.key;
      pane.innerHTML = `
        <header class="ib-head">
          <button class="icon-btn ib-back" id="ibBack" aria-label="Back to chats">${icon('arrow-left', 18)}</button>
          <span class="ib-av" style="${avatarStyle(c.wa)}">${initials(c)}</span>
          <div class="ib-who"><b id="ibName"></b><span id="ibSub"></span></div>
          <div class="ib-headx" id="ibHeadX"></div>
          <span class="ib-window" id="ibWindow"></span>
        </header>
        <div class="ib-lead hidden" id="ibLead"></div>
        <div class="ib-msgs" id="ibMsgs"></div>
        <div id="ibAi" class="ib-ai"></div>
        <button type="button" class="ib-jump hidden" id="ibJump" aria-label="Go to the newest message" title="Newest message">${icon('chevron-down', 20)}</button>
        <div id="ibFoot"></div>`;
      $('#ibBack').onclick = closeConversation;
      toBottom = true;
      ib.stick = true;
      watchScroll(pane);
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
    renderLead();
    renderAi();
    // The banner, the reply box and the AI strip above it are drawn after the messages; land on the newest one.
    if (ib.stick) toLatest();
  }

  // --- Staying on the newest message ---
  // A chat opens on its newest message and stays there as things around it change size (the lead banner, the
  // floating AI strip, images, new messages), until you scroll up; then the ↓ button takes you back.
  const toLatest = (smooth = false) => { const b = $('#ibMsgs'); if (b) b.scrollTo({ top: b.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); };
  function watchScroll(pane) {
    const msgs = $('#ibMsgs', pane), ai = $('#ibAi', pane), foot = $('#ibFoot', pane), jump = $('#ibJump', pane);
    const gap = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight;
    // The AI strip floats over the chat: the messages get room underneath it, and it sits on the reply box.
    const layout = () => {
      pane.style.setProperty('--ib-foot', foot.offsetHeight + 'px');
      pane.style.setProperty('--ib-ai', (ai.childElementCount ? ai.offsetHeight : 0) + 'px');
      if (ib.stick) toLatest();
    };
    msgs.addEventListener('scroll', () => {
      ib.stick = gap() < 48;
      jump.classList.toggle('hidden', gap() < 160);
    }, { passive: true });
    jump.addEventListener('click', () => { ib.stick = true; toLatest(true); });
    const ro = new ResizeObserver(layout);
    [msgs, ai, foot].forEach((el) => ro.observe(el));
    new MutationObserver(() => { if (ib.stick) toLatest(); }).observe(msgs, { childList: true, subtree: true });
    layout();
  }

  // ---------- Lead assistant: contact strip, suggested reply, hand-over ----------

  const STATUS_LABEL = { new: 'New', interested: 'Interested', qualified: 'Qualified', won: 'Won', lost: 'Not interested' };
  const STATUS_PILL = { new: '', interested: 'sent', qualified: 'scheduled', won: 'delivered', lost: 'cancelled' };

  function renderLead() {
    const t = ib.thread;
    const ct = t?.contact;
    const ai = t?.ai;
    const hx = $('#ibHeadX');
    if (!hx) return;
    const tagOf = (id) => (t?.tags || []).find((x) => x.id === id);
    hx.innerHTML = t ? `
      ${ct ? (ct.optOut ? '<span class="pill failed">Opted out</span>' : `<span class="pill ${STATUS_PILL[ct.status] || ''}">${esc(STATUS_LABEL[ct.status] || ct.status)}</span>`) : ''}
      ${ct ? ct.tags.map(tagOf).filter(Boolean).slice(0, 3).map((x) => `<span class="tag-chip tag-${esc(x.color)}" title="${esc(x.name)}">${esc(x.name)}</span>`).join('') : ''}
      ${ct ? `<button class="btn sm quiet" data-ai="contact" title="Open contact">${icon('users', 14)}Contact</button>` : ''}
      ${ai ? `<button class="ib-ai-toggle ${ai.on ? 'on' : ''}" data-ai="toggle" title="${ai.auto ? 'The AI replies on its own when they write (within the guardrails). Click to stop for this chat.' : ai.on ? 'The AI drafts a reply when they write. Click to stop for this chat.' : ai.off ? 'AI is off for this chat. Click to turn on.' : 'Turn on the lead assistant in Settings to draft replies automatically.'}" aria-pressed="${ai.on}"><svg class="orb-icon" data-orb-icon="14"></svg>AI ${ai.auto ? 'auto-reply' : ai.on ? 'on' : 'off'}</button>` : ''}` : '';
    Orb.hydrate(hx);
    const lead = ct?.lead || {};
    const bits = [['Need', lead.need], ['Budget', lead.budget], ['Timeline', lead.timeline]].filter(([, v]) => v);
    const strip = $('#ibLead');
    strip.classList.toggle('hidden', !(lead.summary || bits.length));
    strip.innerHTML = `<span class="ib-lead-sum">${esc(lead.summary || '')}</span>${bits.map(([k, v]) => `<span><b>${k}</b> ${esc(v)}</span>`).join('')}`;
  }

  let aiOrb = null;
  function renderAi() {
    const el = $('#ibAi');
    if (!el) return;
    aiOrb?.destroy();
    aiOrb = null;
    const t = ib.thread;
    const ai = t?.ai;
    if (!ai) { el.innerHTML = ''; return; }
    const w = windowInfo(current());
    const last = (t.messages || []).filter((m) => m.type !== 'reaction').at(-1);
    let html = '';
    if (ai.handover) html += `<div class="ib-handover">${icon('badge-alert', 16)}<div><b>Needs you</b><span>${esc(ai.handover.reason)}</span></div><button class="btn sm quiet" data-ai="clear-handover">Done</button></div>`;
    // While the AI writes: a typing bubble on the reply side, like WhatsApp's "typing…".
    if (ai.busy) html += `<div class="ib-typing" role="status" aria-label="AI is typing"><span class="ib-typing-bubble"><i></i><i></i><i></i></span><span class="ib-typing-label"><svg class="orb" id="ibAiOrb"></svg>AI is typing…</span></div>`;
    else if (ai.draft) html += `<div class="ib-draft">
        <div class="ib-draft-head"><svg class="orb-icon" data-orb-icon="14"></svg><span>Suggested reply</span>${ai.draft.stale ? '<span class="warn-text">They wrote again since this. Regenerate?</span>' : ai.autoHeld ? `<span class="ib-held" title="Auto-reply is on, but this one waits for you">Not sent automatically: ${esc(ai.autoHeld)}</span>` : ''}</div>
        <div class="ib-draft-text">${fmtText(ai.draft.text)}</div>
        <div class="ib-draft-actions">
          ${w.open ? `<button class="btn sm primary" data-ai="send" data-icon="send" data-icon-size="13">Send</button><button class="btn sm" data-ai="edit">Edit</button>` : '<span class="sub">The reply window has closed, so only a template can be sent.</span>'}
          <button class="btn sm quiet" data-ai="regen">Regenerate</button><button class="btn sm quiet" data-ai="dismiss">Dismiss</button>
        </div>
      </div>`;
    else if (w.open && last?.dir === 'in' && !t.contact?.optOut) html += ai.auto
      ? `<button class="ib-ai-ask" data-ai="reply" title="The AI writes and sends a reply now"><svg class="orb-icon" data-orb-icon="14"></svg>Let AI reply</button>`
      : `<button class="ib-ai-ask" data-ai="regen"><svg class="orb-icon" data-orb-icon="14"></svg>Draft a reply with AI</button>`;
    if (ai.error && !ai.busy && !ai.draft) html += `<div class="ib-ai-err">${esc(ai.error)}</div>`;
    const sig = `${Boolean(ai.handover)}|${ai.busy ? 'busy' : ai.draft ? 'draft:' + ai.draft.text : ''}`;
    el.innerHTML = html;
    if (sig !== el.__sig && !Motion.reduce()) [...el.children].forEach((c, i) => c.animate([{ opacity: 0, transform: 'translateY(8px) scale(0.99)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: i * 40, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' }));
    el.__sig = sig;
    LA.hydrate(el);
    Orb.hydrate(el);
    const orbEl = $('#ibAiOrb', el);
    if (orbEl) aiOrb = Orb.mount(orbEl, { state: 'reasoning', size: 16 });
  }

  $('#ibChat').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ai]');
    if (!b || !ib.key) return;
    const key = ib.key;
    const act = b.dataset.ai;
    const setAi = (ai) => { if (ib.key === key && ib.thread) { ib.thread.ai = ai; renderAi(); renderLead(); } };
    if (act === 'contact') return window.Contacts?.open(ib.thread.contact.id);
    if (act === 'send' || act === 'edit') {
      const ta = $('#ibText');
      if (!ta) return;
      ta.value = ib.thread.ai.draft.text;
      autosize();
      if (act === 'send') return sendText();
      ta.focus();
      return;
    }
    await guard(async () => {
      if (act === 'regen' || act === 'reply') {
        setAi({ ...ib.thread.ai, busy: true, error: null });
        setAi(await api(`/inbox/${enc(key)}/draft`, { method: 'POST', body: { send: act === 'reply' } }));
        await loadThread();
      }
      if (act === 'dismiss') setAi(await api(`/inbox/${enc(key)}/draft`, { method: 'DELETE' }));
      if (act === 'clear-handover') setAi(await api(`/inbox/${enc(key)}/ai`, { method: 'POST', body: { clearHandover: true } }));
      if (act === 'toggle') {
        if (!state.settings.leadAgent?.enabled) { showTab('settings'); return toast('Turn on the lead assistant under Settings → Lead assistant'); }
        setAi(await api(`/inbox/${enc(key)}/ai`, { method: 'POST', body: { off: ib.thread.ai.on } }));
      }
      loadList().catch(() => {});
    }, b).catch(() => {});
    if ((act === 'regen' || act === 'reply') && ib.thread?.ai?.busy) { ib.thread.ai.busy = false; renderAi(); }
  });

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
      box.innerHTML = Skel.bubbles();
      return;
    }
    if (!msgs.length) {
      box.innerHTML = `<div class="ib-day">No messages yet. Send a template to start the conversation.</div>`;
      return;
    }

    // Messages already on screen stay put; only ones that just arrived rise in.
    if (ib.seenKey !== ib.key) { ib.seen = new Set(); ib.freshAt.clear(); ib.sentAt.clear(); }
    const now = Date.now();
    let html = '';
    let prev = null;
    for (const m of msgs) {
      if (m.type === 'reaction') continue;
      // Each day is its own section, so its sticky date pill only sticks while that day is on
      // screen and the next day's pill pushes it away (otherwise the pills pile up at the top).
      if (!prev || startOfDay(prev.ts) !== startOfDay(m.ts)) {
        html += `${html ? '</section>' : ''}<section class="ib-dayblock"><div class="ib-day">${dayLabel(m.ts)}</div>`;
        prev = null;
      }
      const first = !prev || prev.dir !== m.dir || new Date(m.ts) - new Date(prev.ts) > 10 * 60000;
      const react = m.wamid && reactions.get(m.wamid);
      const mid = m.id || m.wamid || m.ts;
      const isNew = ib.seenKey === ib.key && !ib.seen.has(mid);
      ib.seen.add(mid);
      // When a new message started rising in. The list is re-rendered often (the server's copy of a
      // message you sent, delivery ticks), so a row that's still mid-animation carries on from there
      // instead of restarting. The server's copy of your message takes over its placeholder's start.
      let start = ib.freshAt.get(mid);
      if (isNew && start == null) {
        start = (!m.local && m.dir === 'out' && ib.sentAt.get(m.text)) || now;
        ib.freshAt.set(mid, start);
      }
      if (m.local && start != null) ib.sentAt.set(m.text, start);
      const age = start != null ? now - start : Infinity;
      const fresh = age < 450;
      html += `<div class="ib-row ${m.dir} ${first ? 'first' : ''} ${react ? 'reacted' : ''} ${fresh ? 'fresh' : ''}" ${fresh && age > 0 ? `style="animation-delay:-${age}ms"` : ''} data-wamid="${esc(m.wamid || '')}">
        <div class="ib-bubble ${m.type}">${msgBody(m, byWamid)}${react ? `<span class="ib-reacts">${esc(react)}</span>` : ''}</div>
        ${m.wamid && m.dir === 'in' ? `<button class="ib-reply-btn" data-reply="${esc(m.wamid)}" title="Reply" aria-label="Reply">${icon('reply', 14)}</button>` : ''}
      </div>`;
      if (m.status === 'failed' && m.error) html += failedNote(m.error);
      prev = m;
    }
    box.innerHTML = html ? html + '</section>' : '';
    ib.seenKey = ib.key;
    if (toBottom || nearBottom) ib.stick = true;
    if (ib.stick) box.scrollTop = box.scrollHeight;
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
    if (m.auto) h += `<div class="ib-label ib-auto">${icon('sparkles', 11)}Auto-reply · AI</div>`;
    switch (m.type) {
      case 'template': {
        const t = state.templates.find((x) => x.id === m.templateId);
        h += `<div class="ib-label">${icon('send', 11)}${esc(m.campaign === 'Test send' ? 'Test send · ' + m.templateName : m.campaign ? 'Campaign · ' + m.campaign : 'Template · ' + m.templateName)}</div>`;
        const meta = `<span class="ib-meta static">${fmtTime(m.ts)}${tick(m.status, m.error)}</span>`;
        return h + (t ? `<div class="bubble">${bubbleHtml(t, m.values || {}, false, meta)}</div>` : `<div class="ib-text">Template <code>${esc(m.templateName)}</code></div>${meta}`);
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
        // WhatsApp didn't share this message's content (polls, some stickers, view-once, calls…).
        h += `<div class="ib-text ib-unsupported">${icon('badge-alert', 13)}<span>Message not shown here. Open WhatsApp on the phone to see it.</span><span class="ib-spacer ${m.dir}"></span></div>`;
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

  // Demo mode: a box to write as the customer, so replies and auto-reply can be tried without WhatsApp.
  function simBar() {
    if (!state.settings.demoMode || !ib.key) return '';
    return `<form class="ib-sim" id="ibSim" autocomplete="off">
      <span class="ib-sim-tag">${icon('users', 13)} Demo</span>
      <input id="ibSimText" placeholder="Write as ${esc(displayName(current() || {}))} (the customer)…" aria-label="Write as the customer" />
      <button class="btn sm" id="ibSimSend">Send as customer</button>
    </form>`;
  }
  $('#ibChat').addEventListener('submit', (e) => {
    if (e.target.id !== 'ibSim') return;
    e.preventDefault();
    const inp = $('#ibSimText'), text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    guard(() => api('/demo/inbound', { method: 'POST', body: { key: ib.key, text } }), $('#ibSimSend'));
  });

  function renderFoot(open) {
    const foot = $('#ibFoot');
    const mode = (open ? 'open' : 'closed') + (state.settings.demoMode ? ':sim' : '');
    if (foot.dataset.mode === mode && foot.dataset.key === ib.key) return renderReplyBar();
    foot.dataset.mode = mode;
    foot.dataset.key = ib.key;
    if (!open) {
      foot.innerHTML = simBar() + `<div class="ib-closed">
        <div><b>Reply window closed</b><span>WhatsApp only allows free-form replies within 24 hours of the customer's last message. Send an approved template to restart the conversation.</span></div>
        <button class="btn primary sm" id="ibTplBtn" data-icon="file-text" data-icon-size="14">Send template</button>
      </div>`;
      LA.hydrate(foot);
      $('#ibTplBtn').onclick = templateModal;
      return;
    }
    foot.innerHTML = simBar() + `<div class="ib-compose">
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
          const savedLink = t.linkDefaults?.[/^button(\d+)$/.exec(v.where)?.[1]]; // a website button's own link
          if (values[v.key] == null) values[v.key] = savedLink || (v.key === 'body.1' || /name/i.test(v.name) ? firstName : '');
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
      <label>Phone number<input id="ncPhone" inputmode="tel" maxlength="22" placeholder="98765 43210 or +91 98765 43210" /></label>
      <label>From<select id="ncSender">${senders.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}${s.displayPhone ? ' · ' + esc(s.displayPhone) : ''}</option>`).join('')}</select></label>
      <div class="modal-actions"><button class="btn quiet" id="ncCancel">Cancel</button><button class="btn primary" id="ncGo">Open chat</button></div>`
    );
    $('#ncPhone', body).focus();
    $('#ncCancel', body).onclick = closeModal;
    const go = () => {
      const err = phoneError($('#ncPhone', body).value);
      if (err) { $('#ncPhone', body).focus(); return toast(err, 'error'); }
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

  function onEvent(ev) {
    // (Toasts for new messages come from the Notifications feed.)
    clearTimeout(listTimer);
    listTimer = setTimeout(async () => {
      await loadList().catch(() => {});
      if (ev.kind === 'message' && ev.key === ib.key) markRead();
    }, 150);
    if (ev.kind === 'draft' && ev.key === ib.key && visible()) { loadThread().catch(() => {}); return; }
    if (ev.key === ib.key && visible()) {
      clearTimeout(threadTimer);
      threadTimer = setTimeout(() => loadThread().catch(() => {}), 120);
    }
  }

  function connect() {
    const es = new EventSource('/api/events');
    // One stream for the whole app: other pages (Notifications) listen for 'live' events.
    es.addEventListener('inbox', (e) => {
      const ev = JSON.parse(e.data);
      document.dispatchEvent(new CustomEvent('live', { detail: ev }));
      if (ev.kind !== 'notification') onEvent(ev);
    });
    // After a reconnect, catch up on anything missed.
    es.addEventListener('open', () => {
      document.dispatchEvent(new CustomEvent('live', { detail: { kind: 'reconnect' } }));
      if (ib.loaded) loadList().catch(() => {});
    });
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
    open: (key) => openConversation(key),
    // The conversation on screen right now, if any.
    viewing: () => (visible() && !document.hidden ? ib.key : null),
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
