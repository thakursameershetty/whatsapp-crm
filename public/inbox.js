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
    drafts: (() => { try { return JSON.parse(sessionStorage.getItem('ib.drafts')) || {}; } catch { return {}; } })(), // unsent text per chat (kept across a reload)
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
    131031: ['Account locked by Meta', 'Meta locked the WhatsApp Business Account behind this number, so nothing it sends is delivered. See WhatsApp Manager → Account quality for why, and resend once it is unlocked.'],
    131047: ['Reply window closed', 'More than 24 hours since they last wrote, so only a template can be sent.'],
    131056: ['Too many messages too quickly', 'Wait a little before sending this person another message.'],
    131048: ['Spam limit reached', 'Too many people blocked or reported this number recently. Meta is limiting what it can send.'],
    130429: ['Sending too fast', 'Meta rate-limited this number. It will go through if you try again shortly.'],
    132001: ['Template not found', "Meta doesn't have this template in this language. Sync templates and check its name."],
    132015: ['Template paused', 'Meta paused this template because of low ratings. Use another one or edit it in WhatsApp Manager.'],
  };
  // Failures that sending the same message again can't fix: not on WhatsApp, window closed (needs a
  // template instead), or the template itself is missing or paused.
  const NO_RESEND = new Set(['131026', '131047', '132001', '132015']);
  // Your reaction under a customer's message, with whether it reached them (Meta's delivery updates).
  const REACT_STATUS = { sent: 'Sent', delivered: 'Delivered', read: 'Seen' };
  function reactMine(rx) {
    const st = rx.outMsg?.status;
    const failed = st === 'failed';
    const title = failed ? `Your reaction wasn't delivered${rx.outMsg.error ? ': ' + rx.outMsg.error : ''}. Open the reactions to try again.` : `Your reaction · ${REACT_STATUS[st] || 'Sending…'}. Open the reactions to change or remove it.`;
    return `<span class="ib-react-mine ${failed ? 'failed' : ''} ${st === 'sent' || !st ? 'pending' : ''}" title="${esc(title)}">${esc(rx.out)}</span>`;
  }
  // Unified inbox: a small circle on the person's photo with the photo of the number the chat is on ("via"),
  // so you can tell your numbers apart at a glance. Falls back to the number's initial.
  function viaBadge(c) {
    const s = state.senders.find((x) => x.id === c.senderId) || { label: c.senderLabel };
    return `<span class="ib-av-via" title="via ${esc(s.label || c.senderLabel || '')}${s.displayPhone ? ' · ' + esc(s.displayPhone) : ''}">${senderPhotoHtml(s)}</span>`;
  }
  function failedNote(m) {
    const err = m.error;
    // Meta's error code: "131031: …" from delivery updates, "(#131030) …" from a rejected send, or a 13xxxx in the text.
    // No code means the error came from this app (e.g. it never reached Meta).
    const s = String(err || '');
    const code = (s.match(/^(\d{1,6}):/) || s.match(/\(#(\d+)\)/) || s.match(/\b(1\d{5})\b/) || [])[1];
    const h = FAIL_HELP[code];
    // One short line under the message; "Details" opens a small card with the explanation and Meta's own words.
    const known = code && window.MetaErrors?.byCode[code]; // the Error codes page's entry, for codes not explained here
    const title = h ? h[0] : known ? known.title : 'Not delivered';
    const explain = h ? h[1] : known ? `${known.means} ${known.todo}` : '';
    const raw = s.replace(/^\d+:\s*/, '').replace(/^\(#\d+\)\s*/, '');
    const end = current()?.windowEndsAt;
    const windowOpen = end && new Date(end) > new Date();
    const canResend = !m.local && m.id && !NO_RESEND.has(code) && (m.type === 'template' || (m.type === 'text' && windowOpen));
    const action = m.resentAt
      ? `<span class="ib-resent">Sent again</span>`
      : canResend ? `<button class="ib-resend" data-resend="${esc(m.id)}">${icon('refresh-cw', 12)}Resend</button>` : '';
    return `<div class="ib-err">
      <div class="ib-err-line"><span class="ib-err-ico" aria-hidden="true">!</span><b>${esc(title)}</b>${code ? `<span class="ib-err-code" title="Error code from Meta (WhatsApp), not from this app. Search it to learn more.">Meta ${esc(code)}</span>` : ''}<button class="ib-err-more" data-err-more aria-haspopup="dialog" data-title="${esc(title)}" data-explain="${esc(explain)}" data-code="${esc(code || '')}" data-raw="${esc(raw)}">Details</button>${action}</div>
    </div>`;
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
  // What a message WhatsApp didn't share was (server.js keeps the kind from WhatsApp's reason).
  const UNSUPPORTED = { view_once: 'View-once message', poll: 'Poll', edit: 'Edited a message', live_location: 'Live location', event: 'Event', video_note: 'Video note', call: 'Call', ephemeral: 'Disappearing message' };
  const UNSUPPORTED_HINT = {
    view_once: "WhatsApp doesn't let business accounts open view-once photos, videos or voice messages. Ask them to send it again without view once.",
    poll: "WhatsApp doesn't share polls with business accounts. Ask them to type their answer instead.",
    edit: "They edited an earlier message, but WhatsApp doesn't share the new text with business accounts. Ask them if it's important.",
    live_location: "WhatsApp doesn't share live location with business accounts. Ask them to send their current location instead; that shows here.",
    event: "WhatsApp doesn't share events with business accounts. Ask them to send the details as a message.",
    video_note: "WhatsApp doesn't share video notes with business accounts. Ask them to send it as a normal video.",
    call: "They tried to call this number. Calls aren't received here; reply with a message or call them back.",
    ephemeral: "WhatsApp doesn't share disappearing messages with business accounts. Ask them to turn off disappearing messages and send it again.",
  };
  function previewText(m) {
    if (!m) return '';
    if (m.type === 'reaction') return `Reacted ${m.reaction?.emoji || ''}`;
    if (m.type === 'template') return `Template: ${m.templateName || m.text}`;
    if (m.type === 'document') return '📄 ' + (m.media?.filename || m.text || 'Document');
    if (m.type === 'unsupported') return UNSUPPORTED[m.unsupported?.kind] || 'Message not shown here';
    if (m.type === 'contacts') return '👤 ' + (m.contacts?.[0]?.name || m.text || 'Contact');
    if (m.type === 'video' && gif.ok.has(m.media?.id)) return 'GIF' + (m.text ? ' ' + m.text : '');
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

  // The list, from the server. A reply that's the same as what's on screen (most live updates touch one chat) is
  // left alone: no redraw at all.
  // The list comes from the server a slice at a time (GET /api/inbox?offset=…&limit=…): the first 30 chats, then 25
  // more each time you scroll near the end. Search, filters, days and order are applied there.
  const FIRST = 30, MORE = 25;
  const listQuery = (offset, limit) => {
    const p = new URLSearchParams({ offset: String(offset), limit: String(limit), q: ib.q, filter: ib.filter, sender: ib.sender, template: ib.template, sort: ib.sort, tz: String(new Date().getTimezoneOffset()) });
    if (ib.date) p.set('dates', JSON.stringify(ib.date));
    return '/inbox?' + p;
  };
  let listSeq = 0;
  // How many chats the list should hold: 30, plus 25 for each "more" you scrolled to (back to 30 when a filter changes).
  ib.wanted = FIRST;
  // The same request already on its way is shared, not sent again (the page, the live stream and a reconnect can all
  // ask at once).
  // (and the same one asked again within a second reuses that answer: opening the page, the live stream connecting
  // and a reconnect all ask for the first 30 one after another)
  const inflight = new Map();
  let lastList = null;
  const getList = (url, fresh) => {
    if (!fresh && lastList?.url === url && Date.now() - lastList.at < 1000) return lastList.p;
    const p = inflight.get(url) || inflight.set(url, api(url).finally(() => inflight.delete(url))).get(url);
    lastList = { url, at: Date.now(), p };
    return p;
  };
  // From the top. reset (a filter or search changed): the first 30. Otherwise (a new message, a refresh): as many as
  // you'd scrolled to, so the list stays as it was.
  async function loadList({ reset = false } = {}) {
    if (reset) ib.wanted = FIRST;
    const seq = ++listSeq;
    const res = await getList(listQuery(0, Math.min(200, ib.wanted)), reset);
    if (seq !== listSeq) return; // a newer one is on its way
    if (reset) $('#ibConvs').scrollTop = 0; // new results start at the top (and don't count as "scrolled to the end")
    const sig = res.total + '#' + res.conversations.map((c) => c.key + c.lastAt + c.unread + (c.last?.status || '') + (c.ai?.busy ? 1 : 0) + (c.ai?.hasDraft ? 1 : 0) + (c.ai?.handover ? 1 : 0) + (c.name || '')).join('|');
    const same = ib.loaded && !reset && sig === ib.sig;
    ib.sig = sig;
    ib.convs = res.conversations;
    ib.res = res;
    ib.unread = res.unread;
    ib.loaded = true;
    renderBadge();
    if (visible() && !same) renderList();
  }
  // The next 25, when you scroll near the end.
  let loadingMore = false;
  async function loadMore() {
    if (loadingMore || !ib.res || ib.convs.length >= ib.res.total) return;
    loadingMore = true;
    const seq = listSeq;
    try {
      const res = await api(listQuery(ib.convs.length, MORE));
      if (seq !== listSeq) return; // the list was reloaded meanwhile
      const have = new Set(ib.convs.map((c) => c.key));
      ib.convs = [...ib.convs, ...res.conversations.filter((c) => !have.has(c.key))];
      ib.wanted = ib.convs.length;
      ib.res = { ...ib.res, total: res.total };
      loadingMore = false;
      renderRows();
    } catch (e) { toast(e.message, 'error'); } finally { loadingMore = false; }
  }
  // a filter, search or the days changed: ask again from the top
  let refilterT = 0;
  const refilter = (wait = 0) => { clearTimeout(refilterT); refilterT = setTimeout(() => loadList({ reset: true }).catch((e) => toast(e.message, 'error')), wait); };

  function renderBadge() {
    const b = $('#inboxBadge');
    b.textContent = ib.unread > 99 ? '99+' : ib.unread;
    b.classList.toggle('hidden', !ib.unread);
    document.title = (ib.unread ? `(${ib.unread}) ` : '') + 'SendON';
  }

  // (already filtered and in order: the server did it)
  const filtered = () => ib.convs;
  function renderList() {
    renderFilters();
    renderRows();
  }
  function renderFilters() {
    // Rebuilt only when the numbers or the templates on offer change (they rarely do).
    const R = ib.res || { senders: {}, senderLabels: {}, templates: {}, counts: { all: 0 } };
    const fsig = state.senders.map((x) => x.id + x.label + (x.photoUrl || '')).join() + '|' + JSON.stringify(R.senders) + '|' + JSON.stringify(R.templates) + '|' + ib.sender + ib.template;
    if (fsig === ib.fsig) return;
    ib.fsig = fsig;
    // Number filter only matters with more than one number in play.
    // Every number in the workspace (not only ones with chats yet), each with how many chats it has.
    const senders = [...new Map([...state.senders.map((x) => [x.id, x.label]), ...Object.entries(R.senderLabels || {})])];
    const sel = $('#ibSender');
    $('#ibSenderWrap').classList.toggle('hidden', senders.length < 2);
    const chats = (n) => `${n} chat${n === 1 ? '' : 's'}`;
    // Each number shows its WhatsApp profile photo (or its first letter), in the list and on the closed filter.
    const pic = (id, label) => { const s = state.senders.find((x) => x.id === id); return { photo: s?.photoUrl || '', letter: (label || '?').trim().charAt(0).toUpperCase() }; };
    sel.innerHTML = `<option value="" data-icon="layers">All numbers</option>` + senders.map(([id, label]) => { const p = pic(id, label); return `<option value="${esc(id)}" data-photo="${esc(p.photo)}" data-letter="${esc(p.letter)}" data-count="${esc(chats(R.senders[id] || 0))}">${esc(label)}</option>`; }).join('');
    sel.value = senders.some(([id]) => id === ib.sender) ? ib.sender : '';
    const cur = senders.find(([id]) => id === sel.value);
    $('#ibSenderPic').innerHTML = cur ? senderPhotoHtml(state.senders.find((x) => x.id === cur[0]) || { label: cur[1] }) : icon('layers', 15);
    $('#ibSenderPic').classList.toggle('all', !cur);
    // Template filter: people who were sent a given template (by a campaign or from here).
    const tplNames = Object.keys(R.templates || {}).sort((a, b) => a.localeCompare(b));
    const tsel = $('#ibTemplate');
    tsel.classList.toggle('hidden', !tplNames.length);
    if (ib.template && !tplNames.includes(ib.template)) ib.template = '';
    // In sections, like the Send page: by WhatsApp account when the numbers are in more than one, else by category.
    // data-tag (the category) drives the chips above the list.
    const tplOf = (n) => (state.templates || []).find((t) => t.name === n);
    const tplOpt = (n) => `<option value="${esc(n)}" data-tag="${esc(catLabel(tplOf(n)?.category))}">${esc(n)} (${R.templates[n] || 0})</option>`;
    const accounts = [...new Set(state.senders.map((x) => x.wabaId).filter(Boolean))];
    const sections = accounts.length > 1
      ? [...accounts.map((w) => [accountLabel(w), tplNames.filter((n) => tplOf(n)?.wabaId === w)]), ['Other', tplNames.filter((n) => !accounts.includes(tplOf(n)?.wabaId))]]
      : [...new Set(tplNames.map((n) => catLabel(tplOf(n)?.category)))].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b)).map((cat) => [cat, tplNames.filter((n) => catLabel(tplOf(n)?.category) === cat)]);
    tsel.innerHTML = `<option value="">All templates</option>` + sections.filter(([, ns]) => ns.length).map(([label, ns]) => `<optgroup label="${esc(label)}">${ns.map(tplOpt).join('')}</optgroup>`).join('');
    tsel.value = ib.template;
  }
  function renderRows() {
    const multi = new Set([...state.senders.map((x) => x.id), ...Object.keys(ib.res?.senders || {})]).size > 1;
    const list = filtered();
    const total = ib.res?.total ?? list.length;
    ib.more = total > list.length;
    const box = $('#ibConvItems');
    // Where each row was, so rows that move (a new message lifts a chat to the top) can glide there.
    const before = new Map($$('.ib-conv', box).map((el) => [el.dataset.key, el.getBoundingClientRect().top]));
    if (!ib.loaded) {
      box.innerHTML = Skel.rows(8);
    } else if (!ib.res?.counts.all) {
      box.innerHTML = `<div class="ib-none">No conversations yet.</div>`;
    } else if (!list.length) {
      box.innerHTML = `<div class="ib-none">No chats match.</div>`;
    } else {
      box.innerHTML = list
        .map((c) => {
          const l = c.last || {};
          return `<button class="ib-conv ${c.key === ib.key ? 'active' : ''} ${c.unread ? 'unread' : ''}" data-key="${esc(c.key)}" role="listitem">
            <span class="ib-av" style="${avatarStyle(c.wa)}">${initials(c)}${multi ? viaBadge(c) : ''}</span>
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
        .join('') + (ib.more ? `<div class="ib-more" aria-hidden="true">${loadingMore ? 'Loading more chats…' : `${(total - list.length).toLocaleString()} more chats below`}</div>` : '');
    }
    animateList(before);
    placeHighlight();
    if (!ib.key) renderChat();
  }
  // Near the end of the drawn rows: draw the next page.
  $('#ibConvs').addEventListener('scroll', (e) => {
    const el = e.currentTarget;
    if (!ib.more || el.scrollHeight - el.scrollTop - el.clientHeight > 400) return;
    loadMore(); // the next 25 from the server
  }, { passive: true });

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
  // Date: the day (or days, or range) of a chat's latest message, and newest / oldest first.
  ib.date = null; ib.sort = 'new';
  // It lives inside the search box, as the Contacts "Added by" filter does: just the calendar until a date (or oldest
  // first) is picked, then that choice beside it.
  const dateHtml = () => {
    const on = DateFilter.active(ib.date), lbl = on ? DateFilter.label(ib.date) : ib.sort === 'old' ? 'Oldest first' : '';
    return `<button type="button" class="num-filter df-in ${lbl ? 'on' : ''}" id="ibDate" aria-haspopup="dialog" title="Filter by date and order" aria-label="Filter by date${lbl ? ': ' + esc(lbl) : ''}">${icon('calendar-days', 15)}${lbl ? `<span class="num-filter-lbl">${esc(lbl)}</span>` : ''}${on ? `<i class="df-x" data-df-clear title="Clear the date" aria-label="Clear the date">${icon('x', 12)}</i>` : ''}</button>`;
  };
  const dateBtn = () => { $('#ibDate').outerHTML = dateHtml(); };
  $('.ib-search').insertAdjacentHTML('beforeend', dateHtml());
  $('.ib-search').addEventListener('click', (e) => {
    const b = e.target.closest('#ibDate');
    if (!b) return;
    if (e.target.closest('[data-df-clear]')) { e.stopPropagation(); ib.date = null; dateBtn(); ib.enter = true; return refilter(); }
    const marks = new Map(Object.entries(ib.res?.days || {}));
    DateFilter.open(b, {
      value: ib.date, marks, sort: ib.sort,
      onChange: (v) => { ib.date = v; ib.enter = true; refilter(); dateBtn(); },
      onSort: (s) => { ib.sort = s; ib.enter = true; refilter(); dateBtn(); },
    });
  });
  $('#ibSearch').addEventListener('input', (e) => { ib.q = e.target.value.trim(); ib.enter = true; refilter(250); }); // (after a pause in typing)
  $('#ibSender').addEventListener('change', (e) => { ib.sender = e.target.value; ib.enter = true; refilter(); });
  $('#ibTemplate').addEventListener('change', (e) => { ib.template = e.target.value; ib.enter = true; refilter(); });
  $('#ibFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    ib.filter = b.dataset.f;
    $$('#ibFilter button').forEach((x) => x.classList.toggle('active', x === b));
    ib.enter = true;
    refilter();
  });

  // ---------- Conversation ----------
  // The open chat and unsent drafts live in this tab's sessionStorage too, so a reload (a new version of the app
  // being deployed, or a refresh) comes back to the same chat with the half-typed message still there.
  const keep = (k, v) => { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch {} };
  addEventListener('pagehide', () => {
    if (ib.key && $('#ibText')) ib.drafts[ib.key] = $('#ibText').value;
    const drafts = Object.fromEntries(Object.entries(ib.drafts).filter(([, t]) => t && t.trim()));
    keep('ib.drafts', Object.keys(drafts).length ? JSON.stringify(drafts) : null);
  });

  async function openConversation(key) {
    if (ib.key && ib.key !== key) ib.drafts[ib.key] = $('#ibText')?.value || '';
    if (key === ib.key) return;
    ib.key = key;
    keep('ib.open', key);
    ib.replyTo = null;
    ib.thread = null;
    // The old conversation slides out as this one slides in; the list highlight glides across.
    await Motion.morph(() => {
      $('#inbox').classList.add('has-chat');
      $$('#ibConvItems .ib-conv').forEach((r) => r.classList.toggle('active', r.dataset.key === key));
      placeHighlight();
      renderChat();
    }, 'ib');
    await loadThread(true);
    markRead();
  }

  function closeConversation() {
    if (ib.key) ib.drafts[ib.key] = $('#ibText')?.value || '';
    ib.key = null;
    keep('ib.open', null);
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
    // the latest messages; more when you've scrolled back to the top (ib.span grows per chat)
    const span = ib.spans?.[key] || 150;
    const t = await api('/inbox/' + enc(key) + '?limit=' + span);
    if (key !== ib.key) return; // switched while loading
    // Keep messages still being sent (not on the server yet).
    const pending = (ib.thread?.messages || []).filter((m) => m.status === 'pending' || m.local);
    t.messages.push(...pending);
    // Nothing new since it was drawn (coming back to the Inbox, a poll): keep what's on screen. Redrawing a long
    // chat costs a few frames, and that's the stutter you'd see.
    const ctSig = t.contact && [t.contact.status, t.contact.optOut, t.contact.tags, t.contact.leadLock?.at, t.contact.name];
    const sig = JSON.stringify([key, t.earlier, t.chatLead, ctSig, t.messages.map((m) => [m.id, m.status, m.text?.length, m.reaction])]);
    ib.thread = t;
    if (sig === ib.threadSig && $('#ibChat').dataset.key === key) { if (toBottom) toLatest(); return; }
    renderChat(toBottom);
    ib.threadSig = sig;
  }

  async function loadEarlier(box) {
    const key = ib.key;
    ib.loadingEarlier = true;
    (ib.spans ||= {})[key] = (ib.spans[key] || 150) + 150;
    const fromBottom = box.scrollHeight - box.scrollTop;
    try {
      await loadThread(false);
      if (ib.key === key) box.scrollTop = box.scrollHeight - fromBottom; // stay on the same message
    } finally { ib.loadingEarlier = false; }
  }

  function markRead() {
    const c = ib.convs.find((x) => x.key === ib.key);
    if (!c || !c.unread || document.hidden || !visible()) return;
    ib.unread -= c.unread;
    c.unread = 0;
    renderBadge();
    const row = $(`#ibConvItems .ib-conv[data-key="${CSS.escape(c.key)}"]`);
    if (row) { row.classList.remove('unread'); row.querySelector('.ib-count')?.remove(); }
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
    // (pane.dataset.key says which chat the header was drawn for; it's set below, only when the header is redrawn,
    // so switching chats always redraws it: avatar, photo of the number, name)
    ib.threadSig = null; // drawn now: the next load compares against this
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
          <span class="ib-av" data-sheet-open style="${avatarStyle(c.wa)}">${initials(c)}${state.senders.length > 1 ? viaBadge(c) : ''}</span>
          <div class="ib-who" data-sheet-open><b id="ibName"></b><span id="ibSub"></span></div>
          <div class="ib-headx" id="ibHeadX"></div>
          <span class="ib-window" id="ibWindow"></span>
        </header>
        <div class="ib-lead hidden" id="ibLead"></div>
        <div class="ib-msgs" id="ibMsgs"></div>
        <div id="ibAi" class="ib-ai"></div>
        <button type="button" class="ib-jump hidden" id="ibJump" aria-label="Go to the newest message" title="Newest message">${icon('chevron-down', 20)}</button>
        <div id="ibFoot"></div>
        <div class="ib-sheet" id="ibSheet" aria-hidden="true">
          <div class="ib-sheet-scrim" data-sheet-close></div>
          <div class="ib-sheet-panel" role="dialog" aria-modal="true" aria-label="Chat details">
            <div class="ib-sheet-grab" aria-hidden="true"><i></i></div>
            <div class="ib-sheet-body" id="ibSheetBody"></div>
          </div>
        </div>`;
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
      // at the top of a long chat: fetch the next older batch, keeping your place
      if (msgs.scrollTop < 80 && ib.thread?.earlier > 0 && !ib.loadingEarlier) loadEarlier(msgs);
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

  // The stage pill doubles as the lead switch: click it to say whether they're a qualified lead. A choice made here is
  // locked (the AI can't change it; a lock icon shows), until "Let the AI decide" hands it back.
  function leadPill(ct) {
    const lock = ct?.leadLock;
    const st = ct?.status || 'new';
    const why = lock ? 'You set this stage, so the AI won’t change it. Click to change it or let the AI decide.' : 'Set by the AI. Click to set the stage yourself.';
    return `<button type="button" class="pill ib-lead-pill ${STATUS_PILL[st] || ''}${lock ? ' locked' : ''}" data-lead aria-haspopup="menu" title="${esc(why)}">${lock ? icon('lock', 11) : ''}${esc(STATUS_LABEL[st] || st)}${icon('chevron-down', 11)}</button>`;
  }
  // Summarise again (the strip above the chat, and the contact panel): the notes are rewritten from the whole chat
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lead-again]');
    if (!b || !ib.key || b.classList.contains('busy')) return;
    const key = ib.key;
    // the orb turns while the AI reads, and the label says so
    const working = (on) => $$('[data-lead-again]').forEach((x) => {
      x.classList.toggle('busy', on);
      // while it reads: the weaving thinking orb (the chat's threads drawn together) in place of the still icon
      if (on && window.ThinkingOrb && !x.__live) {
        const icon0 = x.querySelector('svg');
        if (icon0) { x.__icon = document.createRange().createContextualFragment(`<svg class="orb-icon" data-orb-icon="${icon0.dataset.orbIcon || 14}" aria-hidden="true"></svg>`).firstChild; x.__live = ThinkingOrb.mount(icon0, { state: 'weaving', size: 16 }); }
      } else if (!on && x.__live) {
        x.__live.el.replaceWith(x.__icon); x.__live.destroy(); x.__live = null; Orb.hydrate(x);
      }
      const o = x.querySelector('svg')?.__orb;
      if (o && !x.__live) on ? o.play() : o.pause();
      const lab = x.querySelector('span');
      if (lab) { if (on) { lab.dataset.was = lab.textContent; lab.textContent = 'Summarising…'; } else if (lab.dataset.was) lab.textContent = lab.dataset.was; }
    });
    working(true);
    guard(async () => {
      try {
        const r = await api('/inbox/' + enc(key) + '/summarize', { method: 'POST' });
        if (ib.key === key && ib.thread) { ib.thread.chatLead = r.lead; renderLead(); }
        toast('Summary updated');
      } finally { working(false); }
    });
  });
  $('#ibChat').addEventListener('click', (e) => {
    if (!e.target.closest('[data-lead-more]') || !ib.key) return;
    (ib.leadOpen ||= new Set());
    if (ib.leadOpen.has(ib.key)) ib.leadOpen.delete(ib.key); else ib.leadOpen.add(ib.key);
    renderLead();
  });
  // (The phone sheet has the pill too, outside #ibChat: listen on the document.)
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lead]');
    if (!b || !ib.key) return;
    const ct = ib.thread?.contact, lock = ct?.leadLock;
    const r = b.getBoundingClientRect();
    Sheet.Menu.open(r.left, r.bottom + 4, ct ? [
      ...STATUS_ORDER.map((k) => ({ label: STATUS_LABEL[k], checked: ct.status === k, action: () => setStage(k) })),
      '-',
      { label: 'Let the AI decide', checked: !lock, action: () => letAiDecide() },
    ] : [{ label: 'Add to contacts to set a stage', action: () => addContact() }]);
  });

  function renderLead() {
    const t = ib.thread;
    const ct = t?.contact;
    const ai = t?.ai;
    const hx = $('#ibHeadX');
    if (!hx) return;
    const tagOf = (id) => (t?.tags || []).find((x) => x.id === id);
    hx.innerHTML = t ? `
      ${ct?.optOut ? '<span class="pill failed">Opted out</span>' : leadPill(ct)}
      ${ct ? ct.tags.map(tagOf).filter(Boolean).slice(0, 3).map((x) => `<span class="tag-chip tag-${esc(x.color)}" title="${esc(x.name)}">${esc(x.name)}</span>`).join('') : ''}
      ${ai?.playbook ? pbChip(ai) : ''}
      ${ai ? `<label class="ib-ai-switch ${ai.on ? 'on' : ''}" title="${ai.auto ? 'The AI replies on its own when they write (within the guardrails). Switch off to stop for this chat.' : ai.on ? 'The AI drafts a reply when they write. Switch off to stop for this chat.' : ai.off ? 'AI is off for this chat. Switch on to let it help.' : ai.master === false ? 'The lead assistant is off for the whole workspace (Settings → Lead assistant).' : 'This chat’s playbook only drafts when you ask. Turn on “Draft automatically” for it in Settings → Lead assistant.'}"><span class="ibx-l">${ai.playbook?.auto ? 'AI auto-reply' : 'AI drafts'}</span>${toggleHtml({ checked: ai.on, attrs: 'data-ai-switch aria-label="AI for this chat"', size: 'sm', knob: '<svg class="orb-icon" data-orb-icon="14"></svg>' })}</label>` : ''}` : '';
    Orb.hydrate(hx);
    // This chat's own notes (the server keeps them per chat: the same person may talk to several of our numbers).
    const lead = t?.chatLead || {};
    const bits = [['Need', lead.need], ['Budget', lead.budget], ['Timeline', lead.timeline]].filter(([, v]) => v);
    const strip = $('#ibLead');
    // no notes yet, but they've written: the strip offers to make them
    const canSum = Boolean(t?.messages?.some((m) => m.dir === 'in'));
    const empty = !(lead.summary || bits.length);
    // no notes yet: no strip, just a small floating "Summarise" pill over the top of the chat
    strip.classList.toggle('hidden', !t || empty);
    strip.classList.remove('empty');
    let fab = strip.parentElement.querySelector(':scope > .ib-sum-fab');
    if (empty && canSum) {
      if (!fab) {
        fab = document.createElement('button');
        fab.type = 'button';
        fab.className = 'ib-sum-fab ib-lead-again';
        fab.dataset.leadAgain = '';
        fab.title = 'Summarise: the AI reads the whole chat and writes notes (who they are, what they want)';
        fab.innerHTML = `<svg class="orb-icon" data-orb-icon="14" aria-hidden="true"></svg><span>Summarise this chat</span>`;
        strip.after(fab);
        Orb.hydrate(fab);
      }
      const head = strip.parentElement.querySelector('.ib-head'); // just under the chat's header (the strip is hidden)
      fab.style.top = (head ? head.offsetTop + head.offsetHeight : 0) + 12 + 'px';
    } else fab?.remove();
    // One line, so the chat keeps its room; "More" opens the rest when it doesn't fit (remembered per chat).
    strip.classList.toggle('open', ib.leadOpen?.has(ib.key) || false);
    strip.innerHTML = `<div class="ib-lead-body"><span class="ib-lead-sum">${empty ? 'No summary of this chat yet' : esc(lead.summary || '')}</span>${bits.map(([k, v]) => `<span><b>${k}</b> ${esc(v)}</span>`).join('')}</div><button type="button" class="ib-lead-more hidden" data-lead-more>${strip.classList.contains('open') ? 'Less' : 'More'}</button><button type="button" class="ib-lead-again" data-lead-again title="${empty ? 'Summarise: the AI reads the whole chat and writes notes (who they are, what they want)' : 'Summarise again: the AI re-reads the whole chat and rewrites these notes'}"><svg class="orb-icon" data-orb-icon="14" aria-hidden="true"></svg><span>Summarise</span></button>`;
    Orb.hydrate(strip);
    requestAnimationFrame(() => {
      const body = strip.querySelector('.ib-lead-body'), more = strip.querySelector('[data-lead-more]');
      if (body && more) more.classList.toggle('hidden', !strip.classList.contains('open') && body.scrollHeight <= body.clientHeight + 2);
    });
    renderSheet(t, ct, ai, lead, bits, tagOf);
    if (ib.infoOpen) renderInfo();
  }

  // ---------- Phones: the chat's details in a sheet from the bottom ----------
  // The header keeps the face, the name and a small AI switch; tapping the face or name opens this sheet with the
  // rest: stage and tags, the reply window, the lead summary, the full AI switch and the contact.
  function renderSheet(t, ct, ai, lead, bits, tagOf) {
    const body = $('#ibSheetBody'), c = current();
    if (!body || !c) return;
    const w = windowInfo(c);
    const tags = ct ? ct.tags.map(tagOf).filter(Boolean) : [];
    body.innerHTML = `
      <div class="ibs-who">
        <span class="ib-av" style="${avatarStyle(c.wa)}">${initials(c)}</span>
        <div><b>${esc(displayName(c))}</b><span>${esc(fmtPhone(c.wa))} · via ${esc(c.senderLabel)}</span></div>
      </div>
      <div class="ibs-chips">
        ${ct?.optOut ? '<span class="pill failed">Opted out</span>' : leadPill(ct)}
        ${tags.map((x) => `<span class="tag-chip tag-${esc(x.color)}">${esc(x.name)}</span>`).join('')}
        <span class="ib-window ${w.open ? 'open' : 'closed'}">${icon(w.open ? 'clock' : 'file-text', 13)}${esc(w.label)}</span>
      </div>
      ${lead.summary || bits.length ? `<div class="ibs-lead">
        ${lead.summary ? `<p>${esc(lead.summary)}</p>` : ''}
        ${bits.length ? `<dl>${bits.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      </div>` : ''}
      ${ai ? `<label class="ibs-ai">
        <svg class="orb-icon" data-orb-icon="18"></svg>
        <span><b>${ai.playbook?.auto ? 'AI auto-reply' : 'AI drafts'}</b><small>${ai.auto ? 'Replies on its own when they write, within the guardrails.' : ai.on ? 'Drafts a reply when they write, for you to send.' : ai.off ? 'Off for this chat.' : 'Drafts only when you ask (this playbook doesn’t draft on its own).'}</small></span>
        ${toggleHtml({ checked: ai.on, attrs: 'data-ai-switch aria-label="AI for this chat"', size: 'sm' })}
      </label>` : ''}
      <button class="btn ibs-contact" data-media-grid="media">${icon('image', 15)}Media, audio and docs</button>
      <button class="btn ibs-contact" data-profile>${icon('user', 15)}Profile and other chats</button>
      ${ct ? `<button class="btn ibs-contact" data-ai="contact">${icon('users', 15)}Open contact</button>` : ''}`;
    Orb.hydrate(body);
  }
  const phone = () => matchMedia('(max-width: 900px)').matches;
  // ---------- Contact info: everything about the person, beside the chat ----------
  // Opens from their photo or name, or "Contact info" in the header, and stays open as you move between chats. Edits save
  // as you go (no Edit step): stage, opted out, tags, name, email, company and notes. Below them, this chat's summary and
  // their other chats with our numbers (only numbers you can see: the server leaves the rest out).
  const STATUS_ORDER = ['new', 'interested', 'qualified', 'won', 'lost'];
  let infoReq = 0;
  function openInfo() { ib.infoOpen = true; renderInfo(); }
  function closeInfo() {
    ib.infoOpen = false;
    $('#ibInfo').classList.add('hidden');
    $('#inbox').classList.remove('has-info');
  }
  const openProfile = openInfo; // (the phone sheet's button)
  async function renderInfo() {
    const box = $('#ibInfo');
    if (!ib.infoOpen || !ib.key || !ib.thread) { box.classList.add('hidden'); $('#inbox').classList.remove('has-info'); return; }
    const key = ib.key, mine = ++infoReq;
    if (ib.infoP?.key === key) drawInfo(ib.infoP.p); // at once, from what we have (a click shows straight away)
    let p;
    try { p = await api(`/inbox/${enc(key)}/profile`); } catch (err) { return toast(err.message, 'error'); }
    if (mine !== infoReq || ib.key !== key || !ib.thread) return;
    ib.infoP = { key, p };
    drawInfo(p);
  }
  function drawInfo(p) {
    const box = $('#ibInfo');
    if (!ib.infoOpen || !ib.thread) return;
    if (box.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return; // don't redraw under someone typing
    // The chat's copy of the contact is the newest (changes made here land on it first).
    const tc = ib.thread.contact;
    const c = current(), t = ib.thread, ct = tc ? { ...(p.contact || {}), ...tc } : p.contact, lead = t.chatLead || {}, lock = ct?.leadLock;
    const others = p.chats.filter((x) => !x.current);
    const via = state.senders.find((x) => x.id === c.senderId);
    const bits = [['Need', lead.need], ['Budget', lead.budget], ['Timeline', lead.timeline]].filter(([, v]) => v);
    // About: their details as text; the pencil in the header opens the contact form to change them.
    const about = (k, v) => `<div><dt>${k}</dt><dd class="${v ? '' : 'muted'}">${v ? esc(v) : 'Not added'}</dd></div>`;
    const card = (title, body, extra = '') => `<section class="ibi-card">${title ? `<div class="ibi-card-h">${title}${extra}</div>` : ''}${body}</section>`;
    const leadBody = lead.summary || bits.length
      ? `${lead.summary ? `<p class="ibi-sum">${esc(lead.summary)}</p>` : ''}${bits.length ? `<dl class="ibi-bits">${bits.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}`
      : '<p class="ibi-sum muted">No summary yet. Summarise reads the chat and writes notes.</p>';
    const hasIn = t?.messages?.some((m) => m.dir === 'in');
    box.innerHTML = `
      <div class="ibi-bar"><b>Contact info</b><span class="ibi-bar-acts"><button type="button" class="icon-btn" data-info-close title="Close" aria-label="Close">${icon('x', 17)}</button></span></div>
      <div class="ibi-scroll">
        <div class="ibi-hero">
          <span class="ib-av lg" style="${avatarStyle(c.wa)}">${initials(c)}</span>
          <div class="ibi-who">
            <h2>${esc(ct?.name || displayName(c))}</h2>
            <button type="button" class="ibi-copy" data-copy-num="+${esc(c.wa)}" title="Copy the number">${esc(fmtPhone(c.wa))}${icon('copy', 12)}</button>
            ${via ? `<span class="ibi-via" title="The number this chat is with">${senderPhotoHtml(via)}<span>via ${esc(via.label)}</span></span>` : ''}
          </div>
        </div>
        <div class="ibi-acts">
          <button type="button" class="ibi-act" data-copy-num="+${esc(c.wa)}">${icon('copy', 16)}<span>Copy</span></button>
          ${ct ? `<button type="button" class="ibi-act" data-info-edit>${icon('square-pen', 16)}<span>Edit</span></button>
          <button type="button" class="ibi-act" data-info-contacts="${esc(ct.id)}">${icon('users', 16)}<span>Contacts</span></button>`
          : `<button type="button" class="ibi-act primary" data-info-add>${icon('plus', 16)}<span>Add contact</span></button>`}
        </div>
        ${mediaCard()}
        ${ct ? card('Stage', stageHtml(ct, lock), lock
          ? `<span class="stg-src you" title="${esc(`You set this${lock.by ? ` (${lock.by})` : ''}, so the AI won’t change it`)}">${icon('lock', 11)}Set by you</span>`
          : '<span class="stg-src" title="The AI moves the stage as the chat goes on"><svg class="orb-icon" data-orb-icon="12" aria-hidden="true"></svg>Set by the AI</span>') : ''}
        ${lead.summary || bits.length || hasIn ? card(`<span class="ibi-ai"><svg class="orb-icon" data-orb-icon="14" aria-hidden="true"></svg>Lead notes</span>`, leadBody, `<button type="button" class="ib-lead-again" data-lead-again title="The AI reads the whole chat and writes notes"><span>Summarise</span></button>`) : ''}
        ${ct ? card('Tags', `<div class="ibi-tags">${(t.tags || []).map((x) => `<button type="button" class="ct-tag tag-${esc(x.color)} ${ct.tags.includes(x.id) ? 'active' : ''}" data-info-tag="${x.id}"><i></i><span class="ct-tag-name">${esc(x.name)}</span></button>`).join('') || '<span class="sub">No tags yet. Make them on the Contacts page.</span>'}</div>`) : ''}
        ${ct ? card('About', `<dl class="ibi-about">${about('Name', ct.name)}${about('Phone', fmtPhone(c.wa))}${about('Email', ct.email)}${about('Company', ct.company)}${about('Notes', ct.notes)}</dl>`) : ''}
        ${others.length ? card(`Other chats <span class="ibi-n">${others.length}</span>`, `<div class="ibi-chats">${others.map((x) => `<button type="button" class="pf-chat" data-pf-open="${esc(x.key)}">
            <div class="pf-chat-h"><b>${esc(x.number)}</b><time>${esc(relTime(x.lastAt))}</time></div>
            <p class="pf-sum${x.lead?.summary ? '' : ' muted'}">${esc(x.lead?.summary || 'No summary yet.')}</p>
            <div class="pf-last">${x.lastDir === 'out' ? 'You: ' : ''}${esc(String(x.lastText || '').slice(0, 90))}</div>
          </button>`).join('')}</div>`) : ''}
      </div>`;
    box.classList.remove('hidden');
    $('#inbox').classList.add('has-info');
    LA.hydrate?.(box);
    Orb.hydrate(box);
  }
  // The stage: New → Interested → Qualified → Won as steps (the ones passed get a tick), "Not interested" as its own
  // state below (it greys the steps), then whether they've opted out.
  const PIPE = ['new', 'interested', 'qualified', 'won'];
  function stageHtml(ct, lock) {
    const lost = ct.status === 'lost', at = PIPE.indexOf(ct.status);
    const steps = PIPE.map((k, i) => {
      const cls = lost ? '' : i < at ? 'done' : i === at ? 'on' : '';
      return `<button type="button" role="radio" aria-checked="${ct.status === k}" class="stg-step ${cls}" data-info-status="${k}" title="${ct.status === k ? (lock ? 'The stage now' : 'Click to confirm it, so the AI won’t change it') : `Move to ${STATUS_LABEL[k]}`}">
        <span class="stg-dot"></span><span class="stg-lbl">${esc(STATUS_LABEL[k])}</span></button>`;
    }).join('');
    return `<div class="stg${lost ? ' is-lost' : ''}${ct.optOut ? ' is-out' : ''}">
      <div class="stg-track" role="radiogroup" aria-label="Stage">${steps}</div>
      <div class="stg-foot">
        <button type="button" role="radio" aria-checked="${lost}" class="stg-lost${lost ? ' on' : ''}" data-info-status="lost" title="${lost ? 'Click a step above to bring them back' : 'They’re not interested'}">${icon('x', 13)}Not interested</button>
        ${lock ? `<button type="button" class="stg-ai" data-info-ai title="Hand the stage back to the AI">${icon('refresh-cw', 12)}Let AI decide</button>` : ''}
      </div>
      <label class="stg-opt${ct.optOut ? ' on' : ''}"><span class="stg-opt-ic">${icon(ct.optOut ? 'badge-alert' : 'bell', 15)}</span><span class="stg-opt-t"><b>${ct.optOut ? 'Opted out' : 'Can be messaged'}</b><small>${ct.optOut ? 'No campaigns or replies' : 'Turn on if they asked to stop'}</small></span>${toggleHtml({ checked: ct.optOut, attrs: 'data-info-optout aria-label="Opted out"', size: 'sm' })}</label>
    </div>`;
  }
  // Save one change to the contact. It shows at once (header pill, phone sheet and this panel) and is put back if the
  // save fails. Only the newest of quick clicks gets to draw the server's answer, so they can't undo each other.
  let saveSeq = 0;
  const redrawContact = () => { renderLead(); if (ib.infoOpen && ib.infoP?.key === ib.key) drawInfo(ib.infoP.p); };
  async function saveContact(body, msg, local = body) {
    const ct = ib.thread?.contact;
    if (!ct) return;
    const key = ib.key, before = structuredClone(ct), mine = ++saveSeq;
    Object.assign(ct, local);
    redrawContact();
    try {
      const r = await api('/contacts/' + ct.id, { method: 'PUT', body });
      if (ib.key === key && mine === saveSeq && ib.thread?.contact) { Object.assign(ib.thread.contact, r); redrawContact(); }
      if (msg) toast(msg);
    } catch (err) {
      if (ib.key === key && mine === saveSeq && ib.thread?.contact) { ib.thread.contact = Object.assign(ib.thread.contact, before); redrawContact(); }
      toast(err.message, 'error');
    }
  }
  function setStage(k) {
    const ct = ib.thread?.contact;
    if (!ct) return;
    const same = ct.status === k;
    if (same && ct.leadLock) return;
    saveContact({ status: k, lockStage: true }, same ? `${STATUS_LABEL[k]}: confirmed, the AI won’t change it` : `Stage: ${STATUS_LABEL[k]}`,
      { status: k, leadLock: { status: k, qualified: ['qualified', 'won'].includes(k), by: '', at: new Date().toISOString() } });
  }
  async function letAiDecide() {
    const ct = ib.thread?.contact, key = ib.key;
    if (!ct?.leadLock) return;
    const before = { leadLock: ct.leadLock, status: ct.status };
    delete ct.leadLock;
    if (ct.aiStatus && ct.status !== 'won') ct.status = ct.aiStatus; // the AI's last view of it, straight away
    redrawContact();
    let r;
    try {
      r = await api(`/inbox/${enc(key)}/lead`, { method: 'POST', body: { qualified: null } });
    } catch (err) {
      if (ib.key === key && ib.thread?.contact) { Object.assign(ib.thread.contact, before); redrawContact(); }
      return toast(err.message, 'error');
    }
    if (ib.key === key && ib.thread?.contact) { ib.thread.contact = r.contact; redrawContact(); }
    if (r.contact?.aiStatus) return toast(`The AI decides the stage again: ${STATUS_LABEL[r.contact.status] || r.contact.status}`);
    // The AI hasn't judged this chat yet: have it read the chat now and set the stage.
    if (!ib.thread?.messages?.some((m) => m.dir === 'in')) return toast('The AI decides the stage again once they write');
    toast('The AI is reading the chat to set the stage…');
    try {
      const s = await api(`/inbox/${enc(key)}/summarize`, { method: 'POST', body: { stage: true } });
      if (ib.key === key && ib.thread?.contact && s.contact) { Object.assign(ib.thread.contact, s.contact); if (s.lead) ib.thread.chatLead = s.lead; redrawContact(); }
      toast(`The AI set the stage: ${STATUS_LABEL[s.contact?.status] || 'done'}`);
    } catch (err) {
      toast(`The AI decides the stage again on their next message (${err.message})`, 'error'); // the hand-back itself worked
    }
  }
  function addContact() {
    const c = current();
    return guard(async () => { await api('/contacts', { method: 'POST', body: { phone: '+' + c.wa, name: c.name || '' } }); toast('Added to contacts'); await loadThread(); });
  }
  $('#ibInfo').addEventListener('click', (e) => {
    const ct = ib.thread?.contact, key = ib.key;
    if (e.target.closest('[data-info-close]')) return closeInfo();
    if (e.target.closest('[data-info-edit]') && ct) return window.Contacts?.open(ct.id, { inChat: true, onSaved: () => loadThread() });
    const num = e.target.closest('[data-copy-num]');
    if (num) return navigator.clipboard?.writeText(num.dataset.copyNum).then(() => toast('Number copied'), () => {});
    const st = e.target.closest('[data-info-status]');
    if (st && ct) return setStage(st.dataset.infoStatus);
    if (e.target.closest('[data-info-ai]')) return letAiDecide();
    const tg = e.target.closest('[data-info-tag]');
    if (tg && ct) { const id = tg.dataset.infoTag; return saveContact({ tags: ct.tags.includes(id) ? ct.tags.filter((x) => x !== id) : [...ct.tags, id] }); }
    if (e.target.closest('[data-info-add]')) return addContact();
    const o = e.target.closest('[data-pf-open]');
    if (o) return openConversation(o.dataset.pfOpen);
    const cb = e.target.closest('[data-info-contacts]');
    if (cb) { showTab('contacts'); window.Contacts?.open(cb.dataset.infoContacts); }
  });
  $('#ibInfo').addEventListener('change', (e) => {
    if (e.target.closest('[data-info-optout]')) saveContact({ optOut: e.target.checked }, e.target.checked ? 'Opted out: they won’t be messaged' : 'They can be messaged again');
  });
  $('#ibInfo').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInfo(); });

  function openSheet() {
    const sh = $('#ibSheet');
    if (!sh || sh.classList.contains('open')) return;
    sh.classList.add('open');
    sh.setAttribute('aria-hidden', 'false');
    sh.querySelector('.ib-sheet-panel').style.transform = '';
  }
  function closeSheet() {
    const sh = $('#ibSheet');
    if (!sh || !sh.classList.contains('open')) return;
    sh.classList.remove('open');
    sh.setAttribute('aria-hidden', 'true');
    sh.querySelector('.ib-sheet-panel').style.transform = '';
  }
  $('#ibChat').addEventListener('click', (e) => {
    if (e.target.closest('[data-sheet-close]') || e.target.closest('#ibSheet [data-ai="contact"]')) return closeSheet();
    if (e.target.closest('[data-sheet-open]')) { if (phone()) openSheet(); else openInfo(); }
    if (e.target.closest('[data-profile]')) { closeSheet(); openProfile(); }
    // Long AI notes and drafts show a few lines on phones: tap to read the rest.
    const more = e.target.closest('.ib-handover span, .ib-draft-text');
    if (more && phone()) more.classList.toggle('full');
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  // Drag the sheet down to close it.
  $('#ibChat').addEventListener('pointerdown', (e) => {
    const panel = e.target.closest('.ib-sheet-panel');
    if (!panel || (panel.scrollTop > 0 && !e.target.closest('.ib-sheet-grab'))) return;
    const y0 = e.clientY;
    let dy = 0;
    const move = (ev) => { dy = Math.max(0, ev.clientY - y0); if (dy > 4) { panel.style.transition = 'none'; panel.style.transform = `translateY(${dy}px)`; } };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      panel.style.transition = '';
      if (dy > 90) closeSheet(); else panel.style.transform = '';
    };
    addEventListener('pointermove', move, { passive: true }); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  });

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
          <button class="btn sm quiet" data-ai="regen" title="Regenerate">${icon('refresh-cw', 14)}<span class="bl">Regenerate</span></button><button class="btn sm quiet" data-ai="opts" title="Pick a playbook or add instructions, then regenerate" aria-expanded="${optsOpen()}">${icon('sliders-horizontal', 14)}<span class="bl">Playbook & notes</span></button><button class="btn sm quiet" data-ai="dismiss" title="Dismiss">${icon('x', 14)}<span class="bl">Dismiss</span></button>
        </div>
      </div>`;
    else if (w.open && last?.dir === 'in' && !t.contact?.optOut) html += `<div class="ib-ai-row">${ai.auto
      ? `<button class="ib-ai-ask" data-ai="reply" title="The AI writes and sends a reply now"><svg class="orb-icon" data-orb-icon="14"></svg>Let AI reply</button>`
      : `<button class="ib-ai-ask" data-ai="regen"><svg class="orb-icon" data-orb-icon="14"></svg>Draft a reply with AI</button>`}<button class="ib-ai-ask ib-ai-more" data-ai="opts" aria-expanded="${optsOpen()}" title="Pick a playbook or add instructions on top of it">${icon('sliders-horizontal', 14)}<span>Playbook & notes</span></button></div>`;
    if (!ai.busy && ai.extra && !optsOpen()) html += `<button type="button" class="ib-ai-extra" data-ai="opts" title="Your instructions for this chat, added on top of the playbook. Click to change.">${icon('square-pen', 13)}<span><b>Added for this chat:</b> ${esc(ai.extra)}</span></button>`;
    if (!ai.busy && optsOpen()) html += optsPanel(ai);
    if (ai.error && !ai.busy && !ai.draft) html += `<div class="ib-ai-err">${esc(ai.error)}</div>`;
    const sig = `${Boolean(ai.handover)}|${ai.busy ? 'busy' : ai.draft ? 'draft:' + ai.draft.text : ''}`;
    el.innerHTML = html;
    if (sig !== el.__sig && !Motion.reduce()) [...el.children].forEach((c, i) => c.animate([{ opacity: 0, transform: 'translateY(8px) scale(0.99)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: i * 40, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' }));
    el.__sig = sig;
    LA.hydrate(el);
    Orb.hydrate(el);
    const orbEl = $('#ibAiOrb', el);
    // "AI is typing…": the composing orb
    if (orbEl) aiOrb = window.ThinkingOrb ? ThinkingOrb.mount(orbEl, { state: 'composing', size: 16 }) : Orb.mount(orbEl, { state: 'reasoning', size: 16 });
  }

  $('#ibChat').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ai]');
    if (!b || !ib.key) return;
    const key = ib.key;
    const act = b.dataset.ai;
    const setAi = (ai) => { if (ib.key === key && ib.thread) { ib.thread.ai = ai; renderAi(); renderLead(); } };
    if (act === 'contact') return window.Contacts?.open(ib.thread.contact.id);
    if (act === 'opts') { if (optsOpen()) ib.aiOpts = null; else openOpts(); renderAi(); if (optsOpen()) $('#ibExtra')?.focus(); return; }
    if (act === 'opts-close') { ib.aiOpts = null; renderAi(); return; }
    if (act === 'opts-save' || act === 'opts-draft') {
      const o = ib.aiOpts;
      const cur = ib.thread.ai;
      const curPb = cur.playbook?.by === 'manual' ? cur.playbook.id : '';
      await guard(async () => {
        if (act === 'opts-draft') {
          setAi({ ...cur, busy: true, error: null });
          ib.aiOpts = null;
          setAi(await api(`/inbox/${enc(key)}/draft`, { method: 'POST', body: { playbook: o.pb || null, extra: o.extra } }));
          await loadThread();
        } else {
          let x = cur;
          if (o.pb !== curPb) x = await api(`/inbox/${enc(key)}/playbook`, { method: 'POST', body: { id: o.pb || null } });
          if (o.extra.trim() !== (cur.extra || '')) x = await api(`/inbox/${enc(key)}/extra`, { method: 'POST', body: { text: o.extra } });
          ib.aiOpts = null;
          setAi(x);
          toast('Saved for this chat. The next reply uses it.');
        }
      }, b).catch(() => {});
      if (ib.thread?.ai?.busy) { ib.thread.ai.busy = false; renderAi(); }
      return;
    }
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
        if (!ib.thread.ai.on && ib.thread.ai.master === false) { showTab('settings'); return toast('The lead assistant is off for the whole workspace. Turn it on under Settings → Lead assistant'); }
        if (!ib.thread.ai.on && !ib.thread.ai.playbook?.draft) { showTab('settings'); return toast(ib.thread.ai.playbook ? `Turn on “Draft automatically” for the “${ib.thread.ai.playbook.name}” playbook under Settings → Lead assistant` : 'Give this number a playbook under Settings → Lead assistant'); }
        setAi(await api(`/inbox/${enc(key)}/ai`, { method: 'POST', body: { off: ib.thread.ai.on } }));
      }
      loadList().catch(() => {});
    }, b).catch(() => {});
    if ((act === 'regen' || act === 'reply') && ib.thread?.ai?.busy) { ib.thread.ai.busy = false; renderAi(); }
  });

  // "Playbook & notes": pick any playbook for this chat and add instructions on top of it (this chat only; the
  // playbook itself isn't edited). What's typed lives in ib.aiOpts, so live updates re-rendering the panel keep it.
  const optsOpen = () => Boolean(ib.aiOpts && ib.aiOpts.key === ib.key);
  function openOpts() {
    const ai = ib.thread?.ai || {};
    ib.aiOpts = { key: ib.key, pb: ai.playbook?.by === 'manual' ? ai.playbook.id : '', extra: ai.extra || '' };
  }
  function optsPanel(ai) {
    const o = ib.aiOpts;
    const list = ai.playbooks || [];
    const here = list.filter((p) => p.here), other = list.filter((p) => !p.here);
    const opt = (p) => `<option value="${esc(p.id)}" ${o.pb === p.id ? 'selected' : ''}>${esc(p.name)}</option>`;
    const auto = ai.playbook && ai.playbook.by !== 'manual' ? ` (now: ${esc(ai.playbook.name)})` : '';
    return `<div class="ib-ai-opts">
      <label class="ib-ai-field"><span>Playbook</span>
        <select id="ibPbSel">
          <option value="" ${o.pb ? '' : 'selected'}>Choose automatically${auto}</option>
          ${here.length ? `<optgroup label="This number">${here.map(opt).join('')}</optgroup>` : ''}
          ${other.length ? `<optgroup label="Other playbooks">${other.map(opt).join('')}</optgroup>` : ''}
        </select>
      </label>
      <label class="ib-ai-field"><span>Add on top of the playbook <small>This chat only. The playbook stays as it is.</small></span>
        <textarea id="ibExtra" rows="3" maxlength="2000" placeholder="e.g. Offer them the Diwali 10% discount. Reply in Telugu. They've already seen the demo.">${esc(o.extra)}</textarea>
      </label>
      <div class="ib-ai-opts-actions">
        ${windowInfo(current()).open ? `<button class="btn sm primary" data-ai="opts-draft">${ai.draft ? 'Regenerate with these' : 'Draft reply'}</button>` : ''}
        <button class="btn sm" data-ai="opts-save">Save for this chat</button>
        <button class="btn sm quiet" data-ai="opts-close">Cancel</button>
      </div>
    </div>`;
  }
  $('#ibChat').addEventListener('input', (e) => {
    if (!optsOpen()) return;
    if (e.target.id === 'ibExtra') ib.aiOpts.extra = e.target.value;
  });
  $('#ibChat').addEventListener('change', (e) => {
    if (optsOpen() && e.target.id === 'ibPbSel') ib.aiOpts.pb = e.target.value;
  });

  // The playbook answering this chat: a chip in the header; click to pick another for this chat, or let it choose.
  const PB_WHY = {
    manual: () => 'You chose it for this chat',
    campaign: (w) => `They replied to the campaign${w ? ` “${w}”` : ''}`,
    ai: (w) => `The AI chose it${w ? `: ${w}` : ''}`,
    default: () => 'This number’s default playbook',
    only: () => 'The only playbook this number uses',
    pending: () => 'The AI picks one when they write; until then, the number’s default',
  };
  function pbChip(ai) {
    const p = ai.playbook;
    const why = (PB_WHY[p.by] || PB_WHY.default)(p.why);
    return `<button type="button" class="ib-pb" data-pb aria-haspopup="menu" title="Playbook: ${esc(p.name)}. ${esc(why)}.${ai.playbooks?.length > 1 ? ' Click to change.' : ''}">${window.pbBook ? pbBook(p, 'sm') : icon('layers', 13)}<span>${esc(p.name)}</span>${ai.playbooks?.length > 1 ? icon('chevron-down', 12) : ''}</button>`;
  }
  $('#ibChat').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pb]');
    const ai = ib.thread?.ai;
    if (!b || !ai?.playbooks || ai.playbooks.length < 2) return;
    const key = ib.key, r = b.getBoundingClientRect();
    const set = (id) => guard(async () => { const x = await api(`/inbox/${enc(key)}/playbook`, { method: 'POST', body: { id } }); if (ib.key === key && ib.thread) { ib.thread.ai = x; renderAi(); renderLead(); } toast(id ? `This chat now uses “${ai.playbooks.find((p) => p.id === id)?.name}”` : 'The playbook is chosen automatically again'); }, b).catch(() => {});
    const manual = ai.playbook?.by === 'manual';
    const item = (p) => ({ label: p.name, checked: ai.playbook?.id === p.id, kbd: manual && ai.playbook?.id === p.id ? 'chosen' : p.here ? '' : 'other number', action: () => set(p.id) });
    const here = ai.playbooks.filter((p) => p.here), other = ai.playbooks.filter((p) => !p.here);
    Sheet.Menu.open(r.left, r.bottom + 6, [
      ...here.map(item),
      ...(here.length && other.length ? ['-'] : []),
      ...other.map(item),
      '-',
      { label: 'Choose automatically', checked: false, disabled: !manual, action: () => set(null) },
    ]);
  });

  function emptyPane() {
    if (ib.loaded && !ib.res?.counts.all) {
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
    // Reactions by the message they're on: the customer's ('in') and ours ('out'), latest of each.
    const reactions = new Map();
    for (const m of msgs) {
      if (m.type !== 'reaction' || !m.reaction?.to) continue;
      const r = reactions.get(m.reaction.to) || {};
      r[m.dir] = m.reaction.emoji || '';
      if (m.dir === 'out') r.outMsg = m;
      reactions.set(m.reaction.to, r);
    }
    const canReact = windowInfo(current()).open;

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
      const rx = (m.wamid && reactions.get(m.wamid)) || {};
      const react = rx.in || rx.out;
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
        <div class="ib-bubble ${m.type}">${msgBody(m, byWamid)}${react ? `<span class="ib-reacts">${rx.in ? esc(rx.in) : ''}${rx.out ? reactMine(rx) : ''}</span>` : ''}</div>
        ${m.wamid && m.dir === 'in' ? `<button class="ib-reply-btn" data-reply="${esc(m.wamid)}" title="Reply" aria-label="Reply">${icon('reply', 14)}</button>` : ''}
        ${m.wamid && m.dir === 'in' && canReact ? `<button class="ib-reply-btn ib-react-btn" data-react="${esc(m.wamid)}" data-mine="${esc(rx.outMsg?.status === 'failed' ? '' : rx.out || '')}" title="React" aria-label="React">${icon('smile-plus', 14)}</button>` : ''}
      </div>`;
      if (m.status === 'failed' && m.error) html += failedNote(m);
      prev = m;
    }
    box.innerHTML = html ? html + '</section>' : '';
    vnHydrate();
    gifHydrate();
    Orb.hydrate(box);
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
    const src = m.media?.local || (m.media?.id ? `/api/media/${enc(m.media.id)}` : '');
    let textInside = true;
    if (m.auto) h += `<div class="ib-label ib-auto"><svg class="orb-icon" data-orb-icon="11"></svg>Auto-reply · AI</div>`;
    switch (m.type) {
      case 'template': {
        const t = state.templates.find((x) => x.id === m.templateId);
        h += `<div class="ib-label">${icon('send', 11)}${esc(m.campaign === 'Test send' ? 'Test send · ' + m.templateName : m.campaign ? 'Campaign · ' + m.campaign : 'Template · ' + m.templateName)}</div>`;
        const meta = `<span class="ib-meta static">${fmtTime(m.ts)}${tick(m.status, m.error)}</span>`;
        return h + (t ? `<div class="bubble">${bubbleHtml(t, m.values || {}, false, meta)}</div>` : `<div class="ib-text">Template <code>${esc(m.templateName)}</code></div>${meta}`);
      }
      case 'image':
      case 'sticker':
        h += `<a class="ib-media ${m.type}" href="${src}" target="_blank" rel="noopener" data-view="${esc(m.media?.id || '')}"><img src="${src}" alt="${m.type}" loading="lazy" onerror="this.parentNode.classList.add('broken')"></a>`;
        break;
      case 'video':
        // A still of the first frame with a play button; clicking opens it in the media viewer.
        h += `<a class="ib-media ib-vthumb ${gif.ok.has(m.media?.id) ? 'gif' : ''}" href="${src}" target="_blank" rel="noopener" data-view="${esc(m.media?.id || '')}"><video src="${src}#t=0.1" preload="metadata" muted playsinline></video><span class="ib-vplay">${PLAY_SVG}</span><span class="ib-vdur">${icon('video', 12)}<span></span></span><button type="button" class="ib-gif-badge" data-gif-replay aria-label="Play GIF again">GIF</button></a>`;
        break;
      case 'audio':
        h += m.media?.id || m.local ? voiceHtml(m.local ? { ...m, media: { ...m.media, id: m.id } } : m, src) : `<div class="ib-text ib-unsupported">Audio unavailable</div>`;
        break;
      case 'document':
        h += docHtml(m, src);
        break;
      case 'location':
        h += locHtml(m.location || {});
        break;
      case 'contacts':
        h += vcardsHtml(m);
        textInside = false;
        break;
      case 'button':
      case 'interactive':
        h += `<div class="ib-label">${icon('reply', 11)}Tapped a button</div>`;
        break;
      case 'unsupported': {
        // WhatsApp didn't share this message's content (view-once, polls, edits, calls…). Newer messages keep
        // WhatsApp's reason, so we can say what it was; older ones only know that something arrived.
        const u = m.unsupported || {};
        const what = UNSUPPORTED[u.kind];
        const tip = [u.reason, u.code ? `WhatsApp code ${u.code}` : ''].filter(Boolean).join(' · ');
        // A number on the WhatsApp API isn't on a phone, so "open it on the phone" isn't an option: say what to do instead.
        const note = UNSUPPORTED_HINT[u.kind] || "WhatsApp doesn't share this kind of message with business accounts. If it matters, ask them to send it again as a normal message.";
        h += `<div class="ib-text ib-unsupported"${tip ? ` title="${esc(tip)}"` : ''}>${icon(u.kind === 'view_once' ? 'eye' : 'badge-alert', 13)}<span><b>${esc(what || 'Message not shown')}</b> · ${esc(note)}</span><span class="ib-spacer ${m.dir}"></span></div>`;
        textInside = false;
        break;
      }
      case 'system':
        h += `<div class="ib-label">${icon('badge-alert', 11)}WhatsApp notice</div>`;
        break;
    }
    if (m.local && m.media) {
      const p = m.progress || 0;
      h += `<div class="ib-upl ${m.status === 'failed' ? 'failed' : ''}" data-upl="${esc(m.id)}"><span><i style="width:${p}%"></i></span><small>${m.status === 'failed' ? 'Not sent' : p < 100 ? `Uploading ${p}%` : 'Sending…'}</small></div>`;
    }
    const meta = `${fmtTime(m.ts)}${m.dir === 'out' ? tick(m.status, m.error) : ''}`;
    if (textInside && m.text) h += `<div class="ib-text">${fmtText(m.text)}<span class="ib-spacer ${m.dir}"></span></div>`;
    return h + `<span class="ib-meta ${m.text || m.type === 'unsupported' ? '' : 'over'}">${meta}</span>`;
  }

  // ---------- Media in the chat: voice notes, documents, locations, contact cards, and the media viewer ----------
  const MIC_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 14.5a3.5 3.5 0 0 0 3.5-3.5V5.5a3.5 3.5 0 1 0-7 0V11a3.5 3.5 0 0 0 3.5 3.5zm6-3.5a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.91V19H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.09A6 6 0 0 0 18 11z"/></svg>';
  const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>';
  const HEADPHONES_SVG = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M12 3a9 9 0 0 0-9 9v6.5A2.5 2.5 0 0 0 5.5 21H7a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H5v-1a7 7 0 0 1 14 0v1h-2a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.5a2.5 2.5 0 0 0 2.5-2.5V12a9 9 0 0 0-9-9z"/></svg>';
  const PIN_SVG = '<svg viewBox="0 0 24 32" width="30" height="40" aria-hidden="true"><path d="M12 0C5.4 0 0 5.3 0 11.9 0 20.8 12 32 12 32s12-11.2 12-20.1C24 5.3 18.6 0 12 0z" fill="#e5483d"/><circle cx="12" cy="11.5" r="4.6" fill="#fff"/></svg>';

  // ----- Voice notes & audio: WhatsApp's player. Their photo with a mic (or headphones for an audio file), play,
  // a waveform of the real recording you can tap or drag along, and the length. One plays at a time; it keeps
  // playing while the chat redraws, and the next unplayed voice note plays after it, as on the phone.
  const VN_BARS = 40;
  const vn = { id: null, a: null, raf: 0, rate: 1, wave: new Map(), dur: new Map(), busy: new Set(), queue: [], running: 0 };
  try { vn.rate = Number(localStorage.getItem('ib.vnRate')) || 1; } catch { /* default speed */ }
  let vnPlayed;
  try { vnPlayed = new Set(JSON.parse(localStorage.getItem('ib.vnPlayed') || '[]')); } catch { vnPlayed = new Set(); }
  function markPlayed(id) {
    if (vnPlayed.has(id)) return;
    vnPlayed.add(id);
    try { localStorage.setItem('ib.vnPlayed', JSON.stringify([...vnPlayed].slice(-500))); } catch { /* just this visit */ }
  }
  // Until the recording is measured, a steady made-up shape (the same one for the same note).
  function seededWave(id) {
    let s = 7;
    for (const ch of String(id)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
    return Array.from({ length: VN_BARS }, () => { s = (s * 1103515245 + 12345) >>> 0; return 0.22 + (((s >>> 16) % 1000) / 1000) * 0.5; });
  }
  const isVoice = (m) => Boolean(m.media?.voice) || /ogg|opus/i.test(m.media?.mime || '');
  function voiceHtml(m, src) {
    const id = m.media.id, c = current() || {};
    const heights = vn.wave.get(id) || seededWave(id);
    const pic = isVoice(m)
      ? `${m.dir === 'out' ? `<span class="ibv-av">${senderPhotoHtml(state.senders.find((s) => s.id === c.senderId) || {})}</span>` : `<span class="ibv-av ib-av" style="${avatarStyle(c.wa)}">${initials(c)}</span>`}<i class="ibv-mic">${MIC_SVG}</i>`
      : `<span class="ibv-av ibv-file">${HEADPHONES_SVG}</span>`;
    return `<div class="ib-voice ${vn.wave.has(id) ? '' : 'loading'}" data-voice="${esc(id)}" data-src="${esc(src)}">
      <span class="ibv-pic">${pic}<button type="button" class="ibv-rate" aria-label="Playback speed">${vn.rate}×</button></span>
      <button type="button" class="ibv-play" aria-label="Play">${PLAY_SVG}${PAUSE_SVG}</button>
      <span class="ibv-main"><span class="ibv-wave" role="slider" tabindex="0" aria-label="Position" aria-valuemin="0" aria-valuemax="100">${heights.map((h) => `<i style="height:${Math.round(h * 100)}%"></i>`).join('')}<b class="ibv-dot"></b></span><span class="ibv-time"></span></span>
    </div>`;
  }
  // Brings every player on screen up to date: progress, playing or not, length, played.
  function vnPaint(id) {
    if (!id) return;
    const on = vn.id === id && vn.a ? vn.a : null;
    const dur = vn.dur.get(id) || (on && Number.isFinite(on.duration) ? on.duration : NaN);
    const p = on && dur ? Math.min(1, on.currentTime / dur) : 0;
    const k = Math.round(p * VN_BARS), h = vn.wave.get(id);
    for (const el of $$(`[data-voice="${CSS.escape(id)}"]`)) {
      const bars = el.querySelectorAll('.ibv-wave i');
      if (h && el.classList.contains('loading')) { bars.forEach((b, i) => (b.style.height = `${Math.round(h[i] * 100)}%`)); el.classList.remove('loading'); }
      bars.forEach((b, i) => b.classList.toggle('on', i < k));
      const w = el.querySelector('.ibv-wave');
      w.style.setProperty('--p', p);
      w.setAttribute('aria-valuenow', Math.round(p * 100));
      const playing = Boolean(on && !on.paused);
      el.classList.toggle('active', Boolean(on));
      el.classList.toggle('playing', playing);
      el.classList.toggle('played', vnPlayed.has(id));
      el.querySelector('.ibv-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
      el.querySelector('.ibv-rate').textContent = `${vn.rate}×`;
      el.querySelector('.ibv-time').textContent = on && (playing || on.currentTime > 0) ? vidClock(on.currentTime) : vidClock(dur);
    }
  }
  // After each redraw: measure the waveform and length of notes not seen yet, two at a time.
  function vnHydrate(root = $('#ibMsgs')) {
    for (const el of root ? $$('[data-voice]', root) : []) {
      const id = el.dataset.voice;
      if (!vn.wave.has(id) && !vn.busy.has(id)) { vn.busy.add(id); vn.queue.push([id, el.dataset.src]); }
      vnPaint(id);
    }
    while (vn.running < 2 && vn.queue.length) {
      const [id, src] = vn.queue.shift();
      vn.running++;
      vnMeasure(id, src).finally(() => { vn.running--; vnHydrate(null); });
    }
  }
  async function vnMeasure(id, src) {
    try {
      const r = await fetch(src);
      if (!r.ok) throw new Error(r.status);
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const audio = await new Ctx(1, 1, 44100).decodeAudioData(await r.arrayBuffer());
      const d = audio.getChannelData(0), size = Math.max(1, Math.floor(d.length / VN_BARS)), peaks = [];
      for (let b = 0; b < VN_BARS; b++) {
        let sum = 0, n = 0;
        for (let i = b * size; i < (b + 1) * size && i < d.length; i += 16) { sum += d[i] * d[i]; n++; }
        peaks.push(Math.sqrt(sum / (n || 1)));
      }
      const max = Math.max(...peaks) || 1;
      vn.wave.set(id, peaks.map((v) => 0.14 + 0.86 * Math.pow(v / max, 0.85)));
      vn.dur.set(id, audio.duration);
    } catch {
      // This browser can't decode it (or it's gone): keep the made-up shape and ask the player for the length.
      vn.wave.set(id, seededWave(id));
      await new Promise((done) => {
        const a = new Audio();
        a.preload = 'metadata';
        a.onloadedmetadata = () => { if (Number.isFinite(a.duration)) vn.dur.set(id, a.duration); done(); };
        a.onerror = done;
        a.src = src;
        setTimeout(done, 8000);
      });
    }
    vnPaint(id);
  }
  // The player for this note (made the first time it's played or dragged), with every other one stopped.
  function vnFor(id, src) {
    if (vn.id === id && vn.a) return vn.a;
    vnStop();
    const a = new Audio(src);
    a.preload = 'auto';
    a.playbackRate = vn.rate;
    vn.id = id; vn.a = a;
    const loop = () => { cancelAnimationFrame(vn.raf); if (vn.a === a && !a.paused) { vnPaint(id); vn.raf = requestAnimationFrame(loop); } };
    a.addEventListener('play', () => { markPlayed(id); $$('video').forEach((v) => v.pause()); loop(); });
    a.addEventListener('pause', () => vnPaint(id));
    a.addEventListener('loadedmetadata', () => { if (Number.isFinite(a.duration) && !vn.dur.has(id)) vn.dur.set(id, a.duration); vnPaint(id); });
    a.addEventListener('ended', () => vnEnded(id));
    a.addEventListener('error', () => { if (vn.a !== a) return; toast("This audio couldn't be played here. Try downloading it."); vnStop(); });
    return a;
  }
  function vnStop() {
    const id = vn.id;
    if (vn.a) { vn.a.pause(); vn.a.removeAttribute('src'); vn.a.load(); }
    cancelAnimationFrame(vn.raf);
    vn.id = null; vn.a = null;
    vnPaint(id);
  }
  function vnEnded(id) {
    vnStop();
    // Then the next voice note right after it, if it hasn't been played yet.
    const msgs = (ib.thread?.messages || []).filter((m) => m.type !== 'reaction');
    const i = msgs.findIndex((m) => m.media?.id === id), next = msgs[i + 1];
    if (i >= 0 && next?.type === 'audio' && next.media?.id && !vnPlayed.has(next.media.id)) {
      const el = $(`[data-voice="${CSS.escape(next.media.id)}"]`);
      if (el) vnFor(next.media.id, el.dataset.src).play().catch(() => {});
    }
  }
  function vnSeek(el, clientX) {
    const w = el.querySelector('.ibv-wave').getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - w.left) / w.width));
    const id = el.dataset.voice, a = vnFor(id, el.dataset.src), dur = vn.dur.get(id) || a.duration;
    if (Number.isFinite(dur) && dur > 0) a.currentTime = p * dur;
    vnPaint(id);
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-voice]');
    if (!el) return;
    if (e.target.closest('.ibv-play')) {
      const a = vnFor(el.dataset.voice, el.dataset.src);
      if (a.paused) a.play().catch(() => {}); else a.pause();
    } else if (e.target.closest('.ibv-rate')) {
      vn.rate = vn.rate === 1 ? 1.5 : vn.rate === 1.5 ? 2 : 1;
      try { localStorage.setItem('ib.vnRate', vn.rate); } catch { /* just this visit */ }
      if (vn.a) vn.a.playbackRate = vn.rate;
      vnPaint(el.dataset.voice);
    }
  });
  // Tap or drag along the waveform to move through the note (and don't start a swipe-to-reply).
  document.addEventListener('pointerdown', (e) => {
    const wave = e.target.closest?.('.ibv-wave');
    if (!wave) return;
    e.stopPropagation();
    e.preventDefault();
    const el = wave.closest('[data-voice]');
    vnSeek(el, e.clientX);
    const move = (ev) => vnSeek(el, ev.clientX);
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }, true);
  document.addEventListener('keydown', (e) => {
    const wave = e.target.closest?.('.ibv-wave');
    if (!wave || !['ArrowLeft', 'ArrowRight', ' ', 'Enter'].includes(e.key)) return;
    e.preventDefault();
    const el = wave.closest('[data-voice]'), a = vnFor(el.dataset.voice, el.dataset.src);
    if (e.key === ' ' || e.key === 'Enter') { if (a.paused) a.play().catch(() => {}); else a.pause(); return; }
    a.currentTime = Math.max(0, a.currentTime + (e.key === 'ArrowLeft' ? -5 : 5));
    vnPaint(el.dataset.voice);
  });

  // ----- Video stills in the chat: show the length once it's known; "unavailable" if it's gone.
  document.addEventListener('loadedmetadata', (e) => {
    const box = e.target.closest?.('.ib-vthumb, .mv-thumb');
    const len = box?.querySelector('.ib-vdur span, .mv-thumb-len');
    if (len) len.textContent = vidClock(e.target.duration);
  }, true);
  document.addEventListener('error', (e) => { if (e.target.tagName === 'VIDEO') e.target.closest('.ib-vthumb')?.classList.add('broken'); }, true);

  // ----- GIFs: WhatsApp sends a GIF as a short video with no sound (the server checks the file for a sound
  // track). In the chat it plays by itself, silently, GIF_LOOPS times when it comes into view, then rests with a
  // GIF badge that plays it again. Clicking it opens the viewer, where it loops for as long as it's open.
  const GIF_LOOPS = 3, GIF_MAX_SEC = 30;
  const gif = { silent: new Map(), ok: new Set(), busy: new Set(), done: new Set(), loops: new Map(), io: null };
  function gifHydrate(root = $('#ibMsgs')) {
    for (const a of root ? $$('.ib-vthumb[data-view]', root) : []) {
      const id = a.dataset.view;
      if (!id) continue;
      if (gif.silent.has(id)) { gifSetup(a, id); continue; }
      if (gif.busy.has(id)) continue;
      gif.busy.add(id);
      fetch(`/api/media/${enc(id)}/info`)
        .then((r) => (r.ok ? r.json() : null))
        .then((info) => {
          gif.silent.set(id, Boolean(info?.silent));
          for (const el of $$(`.ib-vthumb[data-view="${CSS.escape(id)}"]`)) gifSetup(el, id);
        })
        .catch(() => {})
        .finally(() => gif.busy.delete(id));
    }
  }
  // A silent video that's short enough is a GIF: mark it and start watching for it to come into view.
  function gifSetup(a, id) {
    if (!gif.silent.get(id) || a.dataset.gifSet) return;
    a.dataset.gifSet = '1';
    const v = a.querySelector('video');
    const go = () => {
      if (!(v.duration > 0 && v.duration <= GIF_MAX_SEC)) return;
      const fresh = !gif.ok.has(id);
      gif.ok.add(id);
      a.classList.add('gif');
      if (gif.done.has(id) || (window.Motion?.reduce?.() ?? false)) return; // reduced motion: waits for a tap on the badge
      gif.io ||= new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          gif.io.unobserve(en.target);
          gifPlay(en.target);
        }
      }, { threshold: 0.6 });
      gif.io.observe(a);
      if (fresh && mv.el?.classList.contains('open')) mvStrip(); // the viewer's thumbnails say GIF now
    };
    if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true });
  }
  function gifPlay(a) {
    const id = a.dataset.view, v = a.querySelector('video');
    if (!v || !a.isConnected) return;
    v.loop = false;
    v.muted = true;
    a.classList.add('playing');
    const again = () => { v.currentTime = 0; v.play().catch(() => a.classList.remove('playing')); };
    v.onended = () => {
      const n = (gif.loops.get(id) || 0) + 1;
      gif.loops.set(id, n);
      if (n < GIF_LOOPS) return again();
      gif.done.add(id);
      gif.loops.delete(id);
      a.classList.remove('playing');
      v.currentTime = 0.1; // rest on the first frame, as before it played
    };
    if (v.ended || v.currentTime > 0.2) again(); else v.play().catch(() => a.classList.remove('playing'));
  }
  // The GIF badge plays it again (three more times) in the chat, without opening the viewer.
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-gif-replay]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const a = b.closest('.ib-vthumb');
    gif.done.delete(a.dataset.view);
    gif.loops.delete(a.dataset.view);
    gifPlay(a);
  }, true);

  // ----- Documents: a card with the file type. A PDF opens in the app's PDF preview; anything else downloads.
  const DOC_KIND = { pdf: 'pdf', doc: 'word', docx: 'word', xls: 'sheet', xlsx: 'sheet', csv: 'sheet', ppt: 'slides', pptx: 'slides', zip: 'zip', rar: 'zip', txt: 'text' };
  function docHtml(m, src) {
    const name = m.media?.filename || 'Document';
    const mime = m.media?.mime || '';
    const ext = (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] || mime.split('/')[1] || 'file').toLowerCase();
    const pdf = ext === 'pdf' || /pdf/i.test(mime);
    const dl = /^blob:/.test(src) ? src : `${src}?name=${enc(name)}`;
    const label = ext.length <= 4 ? ext.toUpperCase() : 'FILE';
    const open = pdf ? `href="${src}" target="_blank" rel="noopener" data-pdf="${src}" data-pdf-name="${esc(name)}"` : `href="${dl}"`;
    return `<div class="ib-doc2">
      <a class="ib-doc2-main" ${open} title="${pdf ? 'Preview' : 'Download'} ${esc(name)}"><span class="ib-doc2-ico ${DOC_KIND[ext] || 'other'}">${icon('file-text', 18)}<em>${esc(label)}</em></span><span class="ib-doc2-name"><b>${esc(name)}</b><small>${pdf ? 'PDF · Click to preview' : esc(label + ' file · Click to download')}</small></span></a>
      <a class="ib-doc2-dl" href="${dl}" title="Download" aria-label="Download ${esc(name)}">${icon('download', 17)}</a>
    </div>`;
  }

  // ----- Locations: a map of the spot (OpenStreetMap tiles) with a pin; clicking opens a map you can move around.
  const okCoord = (l) => Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng)) && (l.lat !== null && l.lng !== null);
  const gmaps = (l) => `https://www.google.com/maps/search/?api=1&query=${Number(l.lat)},${Number(l.lng)}`;
  function mapTiles(lat, lng, z = 15) {
    const n = 2 ** z, r = (lat * Math.PI) / 180;
    const x = ((lng + 180) / 360) * n * 256, y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * 256;
    let h = '';
    for (let tx = Math.floor((x - 200) / 256); tx <= Math.floor((x + 200) / 256); tx++) {
      for (let ty = Math.floor((y - 110) / 256); ty <= Math.floor((y + 110) / 256); ty++) {
        if (ty < 0 || ty >= n) continue;
        h += `<img src="https://tile.openstreetmap.org/${z}/${((tx % n) + n) % n}/${ty}.png" style="left:${Math.round(tx * 256 - x)}px;top:${Math.round(ty * 256 - y)}px" alt="" loading="lazy" draggable="false">`;
      }
    }
    return h;
  }
  function locHtml(l) {
    if (!okCoord(l)) return `<div class="ib-text ib-unsupported">Shared a location</div>`;
    const lat = Number(l.lat), lng = Number(l.lng);
    const title = l.name || 'Location';
    return `<a class="ib-loc2" href="${gmaps(l)}" target="_blank" rel="noopener" data-loc="${lat},${lng}" data-loc-name="${esc(l.name || '')}" data-loc-addr="${esc(l.address || '')}">
      <span class="ib-map"><span class="ib-map-tiles">${mapTiles(lat, lng)}</span><span class="ib-map-pin">${PIN_SVG}</span><small class="ib-map-credit">© OpenStreetMap</small></span>
      ${l.name || l.address ? `<span class="ib-loc2-text"><b>${esc(title)}</b>${l.address ? `<small>${esc(l.address)}</small>` : ''}</span>` : ''}
    </a>`;
  }
  function locViewer(lat, lng, name, addr) {
    let el = $('#locModal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'locModal';
      el.className = 'modal hidden';
      document.body.append(el);
      el.addEventListener('click', (e) => {
        if (e.target === el || e.target.closest('[data-loc-close]')) hideOverlay(el);
        const cp = e.target.closest('[data-loc-copy]');
        if (cp) navigator.clipboard?.writeText(cp.dataset.locCopy).then(() => toast('Copied'), () => toast("Couldn't copy"));
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.classList.contains('hidden')) { e.stopPropagation(); hideOverlay(el); } }, true);
    }
    const d = 0.006, l = { lat, lng };
    const where = addr || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    el.innerHTML = `<div class="modal-box loc-box" role="dialog" aria-label="${esc(name || 'Location')}">
      <div class="modal-head"><h2 class="pdf-name">${icon('map-pin', 18)}<span>${esc(name || 'Shared location')}</span></h2>
        <div class="pdf-actions"><a class="btn sm" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}" target="_blank" rel="noopener">${icon('arrow-right', 14)}Directions</a><a class="btn sm" href="${gmaps(l)}" target="_blank" rel="noopener">${icon('external-link', 14)}Google Maps</a><button type="button" class="icon-btn" data-loc-close aria-label="Close">${icon('x', 18)}</button></div></div>
      <iframe class="loc-frame" src="https://www.openstreetmap.org/export/embed.html?bbox=${lng - d},${lat - d},${lng + d},${lat + d}&layer=mapnik&marker=${lat},${lng}" title="Map of ${esc(name || 'the location')}"></iframe>
      <div class="loc-foot"><span>${esc(where)}</span><button type="button" class="btn sm quiet" data-loc-copy="${esc(addr ? `${name ? name + ', ' : ''}${addr}` : `${lat}, ${lng}`)}">${icon('copy', 14)}Copy</button></div>
    </div>`;
    el.classList.remove('hidden');
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[data-loc]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    const [lat, lng] = a.dataset.loc.split(',').map(Number);
    locViewer(lat, lng, a.dataset.locName, a.dataset.locAddr);
  });

  // ----- Contact cards: who they shared, their numbers, and buttons to save it or copy the number.
  function vcardsHtml(m) {
    let list = m.contacts;
    if (!list?.length) {
      // Messages from before cards were kept whole: "Name · +91 98765 43210" per line.
      list = String(m.text || '').split('\n').filter(Boolean).map((line) => {
        const parts = line.split(' · ');
        const phones = parts.filter((p) => /^\+?[\d\s()-]{6,}$/.test(p)).map((phone) => ({ phone }));
        return { name: parts.find((p) => !/^\+?[\d\s()-]{6,}$/.test(p)) || '', phones };
      });
    }
    return list.map((ct) => {
      const phone = ct.phones?.[0]?.phone || '';
      const name = ct.name || phone || 'Contact';
      const sub = [...(ct.phones || []).map((p) => p.phone), ct.org, ct.email].filter(Boolean).join(' · ');
      return `<div class="ib-vcard">
        <div class="ib-vcard-top"><span class="ib-av" style="${avatarStyle(phone || name)}">${initials({ name: ct.name })}</span><span><b>${esc(name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span></div>
        ${phone ? `<div class="ib-vcard-acts"><button type="button" data-vcard-save="${esc(phone)}" data-name="${esc(ct.name || '')}">Save contact</button><button type="button" data-vcard-copy="${esc(phone)}">Copy number</button></div>` : ''}
      </div>`;
    }).join('') + `<span class="ib-vcard-spacer"></span>`;
  }
  document.addEventListener('click', async (e) => {
    const cp = e.target.closest?.('[data-vcard-copy]');
    if (cp) return navigator.clipboard?.writeText(cp.dataset.vcardCopy).then(() => toast('Number copied'), () => toast("Couldn't copy"));
    const sv = e.target.closest?.('[data-vcard-save]');
    if (!sv || sv.disabled) return;
    sv.disabled = true;
    try {
      const r = await api('/contacts', { method: 'POST', body: { phone: sv.dataset.vcardSave, name: sv.dataset.name } });
      toast(r.created ? `Saved ${sv.dataset.name || 'the contact'} to Contacts` : 'Already in your Contacts');
    } catch (err) {
      toast(err.message || "Couldn't save the contact");
    } finally {
      sv.disabled = false;
    }
  });

  // ----- Media viewer, like WhatsApp on the computer: photos, stickers and videos open full screen over the app.
  // Top: back, who sent it and when, zoom, open, download. Bottom: "All media" (a grid of everything in this chat),
  // a strip of thumbnails to jump between them, the caption, Reply and Done. ←/→ or swipe to move, click, scroll or
  // pinch to zoom, drag to look around, Esc to close. Ctrl/Cmd-click in the chat still opens a new tab.
  const mv = { el: null, list: [], i: 0, z: 1, x: 0, y: 0, grid: false, tab: 'media', gridOnly: false };
  const viewable = () => (ib.thread?.messages || []).filter((m) => ['image', 'sticker', 'video'].includes(m.type) && m.media?.id && !m.local);
  const audios = () => (ib.thread?.messages || []).filter((m) => m.type === 'audio' && m.media?.id && !m.local);
  const docs = () => (ib.thread?.messages || []).filter((m) => m.type === 'document' && m.media?.id && !m.local);
  const mediaSrc = (m) => `/api/media/${enc(m.media.id)}`;
  const mvStage = () => $('.mv-stage', mv.el);
  const mvImg = () => $('.mv-stage img', mv.el);
  function mvOpen(mediaId) {
    mv.list = viewable();
    if (!mv.list.length) return;
    mv.i = Math.max(0, mv.list.findIndex((m) => m.media.id === mediaId));
    if (!mv.el) mvBuild();
    vnStop();
    mv.gridOnly = false;
    mvStrip();
    mvGrid(false);
    mvShow();
    mvReveal();
  }
  // "Media, audio and docs" from Contact info: straight to the grid, on a tab (works when there are no photos too).
  function mvOpenGrid(tab = 'media') {
    mv.list = viewable();
    mv.i = 0;
    if (!mv.el) mvBuild();
    mv.gridOnly = true;
    mvStage().innerHTML = '';
    mvStrip();
    mv.tab = tab;
    mvGrid(true);
    mvReveal();
  }
  // Contact info's "Media, audio and docs" row: how many, and the latest photos; opens the grid on that tab.
  function mediaCard() {
    const media = viewable(), au = audios(), dc = docs();
    const total = media.length + au.length + dc.length;
    if (!total) return '';
    const latest = media.slice(-4).reverse();
    const first = media.length ? 'media' : au.length ? 'audio' : 'docs';
    const counts = String(total);
    return `<section class="ibi-card ibi-media">
      <button type="button" class="ibi-media-h" data-media-grid="${first}"><b>Media, audio and docs</b><span>${esc(counts)}</span>${icon('arrow-right', 15)}</button>
      ${latest.length ? `<div class="ibi-media-row">${latest.map((m) => `<a class="ibi-media-th ${m.type}" href="${mediaSrc(m)}" target="_blank" rel="noopener" data-view="${esc(m.media.id)}">${m.type === 'video' ? `<video src="${mediaSrc(m)}#t=0.1" preload="metadata" muted playsinline></video><span class="mv-thumb-play">${PLAY_SVG}</span>` : `<img src="${mediaSrc(m)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('broken')">`}</a>`).join('')}</div>` : ''}
      ${au.length || dc.length ? `<div class="ibi-media-links">${au.length ? `<button type="button" data-media-grid="audio">${MIC_SVG}${au.length} audio</button>` : ''}${dc.length ? `<button type="button" data-media-grid="docs">${icon('file-text', 14)}${dc.length} ${dc.length === 1 ? 'document' : 'documents'}</button>` : ''}</div>` : ''}
    </section>`;
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-media-grid]');
    if (!b || !ib.thread) return;
    e.preventDefault();
    mvOpenGrid(b.dataset.mediaGrid);
  });
  function mvReveal() {
    mv.el.classList.add('open');
    document.documentElement.classList.add('mv-lock');
    $('[data-mv="close"]', mv.el).focus({ preventScroll: true });
  }
  function mvClose() {
    if (!mv.el?.classList.contains('open')) return;
    mv.el.classList.remove('open');
    document.documentElement.classList.remove('mv-lock');
    mvStage().innerHTML = '';
    $('.mv-strip', mv.el).innerHTML = '';
    $('.mv-grid', mv.el).innerHTML = '';
  }
  function mvBuild() {
    mv.el = document.createElement('div');
    mv.el.className = 'mv';
    mv.el.setAttribute('role', 'dialog');
    mv.el.setAttribute('aria-modal', 'true');
    mv.el.setAttribute('aria-label', 'Media viewer');
    mv.el.innerHTML = `
      <div class="mv-head">
        <button type="button" class="mv-btn mv-back" data-mv="close" aria-label="Close">${icon('arrow-left', 20)}</button>
        <span class="mv-av"></span>
        <div class="mv-who"><b></b><small></small></div>
        <div class="mv-tools">
          <button type="button" class="mv-btn" data-mv="zoom" aria-label="Zoom in" title="Zoom">${icon('zoom-in', 19)}</button>
          <a class="mv-btn" data-mv="open" target="_blank" rel="noopener" aria-label="Open in a new tab" title="Open in a new tab">${icon('external-link', 18)}</a>
          <a class="mv-btn" data-mv="download" aria-label="Download" title="Download">${icon('download', 19)}</a>
        </div>
      </div>
      <div class="mv-body">
        <div class="mv-stage"></div>
        <button type="button" class="mv-nav prev" data-mv="prev" aria-label="Previous">${icon('arrow-left', 22)}</button>
        <button type="button" class="mv-nav next" data-mv="next" aria-label="Next">${icon('arrow-right', 22)}</button>
        <p class="mv-cap"></p>
        <div class="mv-grid" hidden></div>
      </div>
      <div class="mv-foot">
        <button type="button" class="mv-pill" data-mv="grid">${icon('layout-grid', 15)}<span>All media</span></button>
        <div class="mv-strip" role="listbox" aria-label="Photos and videos in this chat"></div>
        <div class="mv-acts">
          <button type="button" class="mv-pill" data-mv="reply">${icon('reply', 15)}<span>Reply</span></button>
          <button type="button" class="mv-pill mv-done" data-mv="done">Done</button>
        </div>
      </div>`;
    document.body.appendChild(mv.el);
    mvWire();
  }
  function thumbHtml(m, i, cls) {
    const src = mediaSrc(m);
    const inner = m.type === 'video'
      ? `<video src="${src}#t=0.1" preload="metadata" muted playsinline></video>${gif.ok.has(m.media.id) ? '<span class="mv-thumb-gif">GIF</span>' : `<span class="mv-thumb-play">${PLAY_SVG}</span>${cls === 'mv-cell' ? '<span class="mv-thumb-len"></span>' : ''}`}`
      : `<img src="${src}" alt="" loading="lazy" draggable="false" onerror="this.parentNode.classList.add('broken')">`;
    return `<button type="button" class="mv-thumb ${cls} ${m.type}" data-mv-go="${i}" aria-label="${m.type === 'video' ? 'Video' : 'Photo'} ${i + 1}">${inner}</button>`;
  }
  function mvStrip() {
    $('.mv-strip', mv.el).innerHTML = mv.list.map((m, i) => thumbHtml(m, i, 'mv-chip')).join('');
  }
  function mvGrid(show) {
    mv.grid = show;
    const g = $('.mv-grid', mv.el), el = mv.el;
    g.hidden = !show;
    el.classList.toggle('gridding', show);
    el.classList.toggle('grid-only', show && mv.gridOnly);
    if (!show) { g.innerHTML = ''; return; }
    $('.mv-stage video', el)?.pause();
    // The header shows the chat while the grid is up.
    const c = current() || {};
    $('.mv-av', el).innerHTML = `<span class="ib-av" style="${avatarStyle(c.wa)}">${initials(c)}</span>`;
    $('.mv-who b', el).textContent = displayName(c);
    $('.mv-who small', el).textContent = 'Media, audio and docs';
    const lists = { media: mv.list, audio: audios(), docs: docs() };
    const tab = (k, label) => `<button type="button" role="tab" class="mv-tab ${mv.tab === k ? 'on' : ''}" data-mv-tab="${k}" aria-selected="${mv.tab === k}">${label}<span>${lists[k].length}</span></button>`;
    const items = lists[mv.tab];
    // Newest first, under a heading per day (like "Media, links and docs" on the phone).
    let html = '', day = null;
    const group = mv.tab === 'media' ? '<div class="mv-cells">' : '<div class="mv-rows">';
    items.map((m, i) => [m, i]).reverse().forEach(([m, i]) => {
      const d = dayLabel(m.ts);
      if (d !== day) { html += `${day ? '</div>' : ''}<h3>${esc(d)}</h3>${group}`; day = d; }
      html += mv.tab === 'media' ? thumbHtml(m, i, 'mv-cell') : rowHtml(m);
    });
    if (day) html += '</div>';
    const none = { media: 'No photos or videos in this chat yet.', audio: 'No voice messages or audio in this chat yet.', docs: 'No documents in this chat yet.' }[mv.tab];
    g.innerHTML = `<div class="mv-grid-in"><div class="mv-tabs" role="tablist">${tab('media', 'Media')}${tab('audio', 'Audio')}${tab('docs', 'Docs')}</div>${html || `<p class="mv-none">${none}</p>`}</div>`;
    if (!mv.gridOnly) $(`[data-mv-go="${mv.i}"]`, g)?.classList.add('current');
    vnHydrate(g);
  }
  // A voice note or document in the Audio / Docs tab: who sent it and when, the player or the card, download, reply.
  function rowHtml(m) {
    const c = current() || {}, src = mediaSrc(m), mime = m.media.mime || '';
    const when = new Date(m.ts).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const ext = /ogg|opus/.test(mime) ? 'ogg' : /mpeg|mp3/.test(mime) ? 'mp3' : /mp4|m4a|aac/.test(mime) ? 'm4a' : /amr/.test(mime) ? 'amr' : 'audio';
    const file = `${isVoice(m) ? 'Voice message' : 'Audio'} ${m.media.id}.${ext}`;
    return `<div class="mv-row ${m.type}">
      <div class="mv-row-h"><b>${m.dir === 'out' ? 'You' : esc(displayName(c))}</b><small>${esc(when)}</small>
        ${m.type === 'audio' ? `<a class="mv-btn" href="${src}?name=${enc(file)}" title="Download" aria-label="Download">${icon('download', 16)}</a>` : ''}
        ${m.wamid && m.dir === 'in' ? `<button type="button" class="mv-btn" data-mv-reply="${esc(m.wamid)}" title="Reply" aria-label="Reply">${icon('reply', 16)}</button>` : ''}</div>
      <div class="mv-row-body ${m.dir}">${m.type === 'audio' ? voiceHtml(m, src) : docHtml(m, src)}</div>
      ${m.text ? `<p class="mv-row-cap">${fmtText(m.text)}</p>` : ''}
    </div>`;
  }
  function mvShow() {
    const m = mv.list[mv.i], n = mv.list.length, el = mv.el, c = current() || {};
    const src = mediaSrc(m), stage = mvStage();
    el.classList.remove('broken');
    el.classList.toggle('video', m.type === 'video');
    el.classList.toggle('sticker', m.type === 'sticker');
    el.classList.toggle('gif', gif.ok.has(m.media.id));
    stage.innerHTML = m.type === 'video' && gif.ok.has(m.media.id)
      ? `<video src="${src}" autoplay loop muted playsinline disablepictureinpicture></video>`
      : m.type === 'video'
      ? `<video src="${src}" controls autoplay playsinline></video>`
      : `<img src="${src}" alt="${esc(m.text || (m.type === 'sticker' ? 'Sticker' : 'Photo'))}" draggable="false">`;
    const media = stage.firstElementChild;
    media.onerror = () => el.classList.add('broken');
    $('.mv-av', el).innerHTML = m.dir === 'out'
      ? senderPhotoHtml(state.senders.find((s) => s.id === c.senderId) || {})
      : `<span class="ib-av" style="${avatarStyle(c.wa)}">${initials(c)}</span>`;
    $('.mv-who b', el).textContent = m.dir === 'out' ? 'You' : displayName(c);
    $('.mv-who small', el).textContent = new Date(m.ts).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const cap = $('.mv-cap', el);
    cap.innerHTML = m.text ? fmtText(m.text) : '';
    const ext = /png/.test(m.media.mime || '') ? 'png' : /webp/.test(m.media.mime || '') ? 'webp' : m.type === 'video' ? 'mp4' : 'jpg';
    $('[data-mv="download"]', el).href = `${src}?name=${enc(`WhatsApp ${m.type === 'video' ? 'Video' : m.type === 'sticker' ? 'Sticker' : 'Image'} ${m.media.id}.${ext}`)}`;
    $('[data-mv="open"]', el).href = src;
    $('[data-mv="prev"]', el).hidden = mv.i === 0;
    $('[data-mv="next"]', el).hidden = mv.i >= n - 1;
    $('[data-mv="reply"]', el).hidden = !(m.dir === 'in' && m.wamid);
    $('[data-mv="zoom"]', el).hidden = m.type === 'video';
    for (const t of $$('.mv-strip .mv-thumb', el)) t.classList.toggle('current', Number(t.dataset.mvGo) === mv.i);
    const cur = $(`.mv-strip [data-mv-go="${mv.i}"]`, el);
    cur?.setAttribute('aria-selected', 'true');
    cur?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    mv.z = 1; mv.x = 0; mv.y = 0;
    mvApply();
  }
  function mvStep(d) {
    const i = mv.i + d;
    if (i < 0 || i >= mv.list.length) return;
    mv.i = i;
    mvShow();
  }
  // Zoom to z, keeping the point (cx, cy) (from the stage's centre) under the pointer.
  function mvZoom(z, cx = 0, cy = 0) {
    if (!mvImg()) return;
    z = Math.min(5, Math.max(1, z));
    const k = z / mv.z;
    mv.x = z === 1 ? 0 : cx - (cx - mv.x) * k;
    mv.y = z === 1 ? 0 : cy - (cy - mv.y) * k;
    mv.z = z;
    mvClamp();
    mvApply();
  }
  function mvClamp() {
    const img = mvImg(), r = mvStage().getBoundingClientRect();
    if (!img) return;
    const mx = Math.max(0, (img.offsetWidth * mv.z - r.width) / 2 + 40), my = Math.max(0, (img.offsetHeight * mv.z - r.height) / 2 + 40);
    mv.x = Math.min(mx, Math.max(-mx, mv.x));
    mv.y = Math.min(my, Math.max(-my, mv.y));
  }
  function mvApply() {
    const img = mvImg();
    if (img) img.style.transform = `translate(${mv.x}px, ${mv.y}px) scale(${mv.z})`;
    mv.el.classList.toggle('zoomed', mv.z > 1);
    const zb = $('[data-mv="zoom"]', mv.el);
    zb.innerHTML = icon(mv.z > 1 ? 'zoom-out' : 'zoom-in', 19);
    zb.setAttribute('aria-label', mv.z > 1 ? 'Zoom out' : 'Zoom in');
  }
  function mvWire() {
    const el = mv.el, stage = mvStage();
    const fromCentre = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2]; };
    let moved = false;
    el.addEventListener('click', (e) => {
      const go = e.target.closest('[data-mv-go]');
      if (go) { mv.i = Number(go.dataset.mvGo); mv.gridOnly = false; mvGrid(false); return mvShow(); }
      const tb = e.target.closest('[data-mv-tab]');
      if (tb) { mv.tab = tb.dataset.mvTab; $('.mv-grid', el).scrollTop = 0; return mvGrid(true); }
      const rp = e.target.closest('[data-mv-reply]');
      if (rp) { mvClose(); return startReply(rp.dataset.mvReply); }
      const b = e.target.closest('[data-mv]');
      if (b) {
        const a = b.dataset.mv;
        if (a === 'download' || a === 'open') return;
        e.preventDefault();
        if (a === 'close') mv.grid && !mv.gridOnly ? mvGrid(false) : mvClose();
        else if (a === 'done') mvClose();
        else if (a === 'prev') mvStep(-1);
        else if (a === 'next') mvStep(1);
        else if (a === 'zoom') mvZoom(mv.z > 1 ? 1 : 2.5);
        else if (a === 'grid') { if (mv.grid && mv.gridOnly) return mvClose(); if (!mv.grid) mv.tab = 'media'; mvGrid(!mv.grid); }
        else if (a === 'reply') { const w = mv.list[mv.i].wamid; mvClose(); startReply(w); }
        return;
      }
      if (moved) return;
      const img = mvImg();
      if (img && e.target === img) mvZoom(mv.z > 1 ? 1 : 2.5, ...fromCentre(e));
      else if (e.target === stage) mvClose(); // the dark area around it closes
    });
    stage.addEventListener('wheel', (e) => {
      if (!mvImg()) return;
      e.preventDefault();
      mvZoom(mv.z * Math.exp(-e.deltaY * 0.0025), ...fromCentre(e));
    }, { passive: false });
    // Drag to look around when zoomed, swipe left/right to move between items, pinch to zoom.
    const pts = new Map();
    let start = null, pinch = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'VIDEO') return; // its own controls
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      moved = false;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, z: mv.z };
        start = null;
      } else start = { px: e.clientX, py: e.clientY, x: mv.x, y: mv.y };
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        mvZoom(pinch.z * (Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d));
        moved = true;
        return;
      }
      if (!start) return;
      const dx = e.clientX - start.px, dy = e.clientY - start.py;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 6) { moved = true; try { stage.setPointerCapture(e.pointerId); } catch { /* fine without */ } }
      if (!moved) return;
      const img = mvImg();
      if (mv.z > 1) { mv.x = start.x + dx; mv.y = start.y + dy; mvClamp(); mvApply(); }
      else if (img) img.style.transform = `translateX(${dx}px)`;
    });
    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pinch) { if (pts.size < 2) pinch = null; return; }
      if (start && moved && mv.z === 1) {
        const dx = e.clientX - start.px;
        if (dx < -60) mvStep(1); else if (dx > 60) mvStep(-1); else mvApply();
      }
      start = null;
      setTimeout(() => { moved = false; }, 0);
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    addEventListener('resize', () => { if (el.classList.contains('open')) { mvClamp(); mvApply(); } });
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[data-view]');
    if (!a || !a.dataset.view || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (!a.classList.contains('broken')) mvOpen(a.dataset.view);
  });
  document.addEventListener('keydown', (e) => {
    if (!mv.el?.classList.contains('open')) return;
    if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); return mv.grid && !mv.gridOnly ? mvGrid(false) : mvClose(); }
    if (mv.grid || e.target.tagName === 'VIDEO' || e.metaKey || e.ctrlKey || e.altKey) return;
    const act = { ArrowLeft: () => mvStep(-1), ArrowRight: () => mvStep(1), '+': () => mvZoom(mv.z * 1.5), '=': () => mvZoom(mv.z * 1.5), '-': () => mvZoom(mv.z / 1.5) }[e.key];
    if (!act) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    act();
  }, true);

  // AI on/off for this chat (the switch in the chat header).
  $('#ibChat').addEventListener('change', async (e) => {
    const cb = e.target.closest('[data-ai-switch]');
    if (!cb) return;
    const pbx = ib.thread?.ai?.playbook;
    if (cb.checked && ib.thread?.ai?.master === false) { cb.checked = false; showTab('settings'); return toast('The lead assistant is off for the whole workspace. Turn it on under Settings → Lead assistant'); }
    if (cb.checked && !pbx?.draft) {
      cb.checked = false;
      showTab('settings');
      return toast(pbx ? `Turn on “Draft automatically” for the “${pbx.name}” playbook under Settings → Lead assistant` : 'Give this number a playbook under Settings → Lead assistant');
    }
    const key = ib.key;
    cb.disabled = true;
    try {
      const ai = await api(`/inbox/${enc(key)}/ai`, { method: 'POST', body: { off: !cb.checked } });
      if (ib.key === key && ib.thread) { ib.thread.ai = ai; renderAi(); renderLead(); }
      loadList().catch(() => {});
    } catch (err) {
      cb.checked = !cb.checked;
      toast(err.message, 'error');
    } finally {
      cb.disabled = false;
    }
  });

  // Emoji reactions: a small picker beside the message; picking the emoji you already used removes it.
  // WhatsApp's own quick set, then "+" for more.
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const MORE_REACTIONS = ['😀', '😁', '😊', '🙂', '😉', '😍', '🥰', '😘', '😎', '🤩', '🥳', '🤔', '😅', '🤣', '😇', '🙃',
    '😐', '😬', '🙄', '😴', '😭', '😡', '🤯', '😱', '🤗', '🤝', '👏', '🙌', '💪', '👌', '✌️', '🤞',
    '👋', '👀', '🔥', '✨', '🎉', '💯', '✅', '❌', '⭐', '💡', '📌', '📞', '💼', '🚀', '💚', '💙'];
  const emojiBtn = (x, mine) => `<button role="menuitem" data-emoji="${x}" class="${x === mine ? 'on' : ''}" title="${x === mine ? 'Remove reaction' : 'React ' + x}">${x}</button>`;
  // The picker floats in the page (not inside the message), placed just above the button that opened it, so it
  // shows up beside the button even on a very tall message. No room above: it opens below. It stays inside the chat.
  let picker = null;
  const closePicker = () => {
    if (!picker) return;
    picker.el.remove();
    picker.btn.closest('.ib-row')?.classList.remove('picking');
    picker = null;
  };
  function placePicker() {
    if (!picker) return;
    const { el, btn } = picker;
    const box = ($('#ibMsgs') || document.body).getBoundingClientRect();
    const b = btn.isConnected ? btn.getBoundingClientRect() : picker.at;
    picker.at = b;
    const w = el.offsetWidth, h = el.offsetHeight, gap = 8;
    // WhatsApp puts the bar to the left of the button, overlapping the message; keep it within the chat.
    const left = Math.min(Math.max(box.left + gap, b.right - w + 12), box.right - w - gap);
    let top = b.top - h - gap;
    if (top < box.top + gap) top = Math.min(b.bottom + gap, box.bottom - h - gap);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(Math.max(top, gap))}px`;
  }
  function openPicker(btn) {
    const mine = btn.dataset.mine;
    const el = document.createElement('div');
    el.className = 'ib-react-pick';
    el.setAttribute('role', 'menu');
    el.dataset.for = btn.dataset.react;
    el.dataset.mine = mine;
    el.dataset.key = ib.key;
    el.innerHTML = `${REACTIONS.map((x) => emojiBtn(x, mine)).join('')}${mine && !REACTIONS.includes(mine) ? emojiBtn(mine, mine) : ''}<button class="ib-react-plus" data-react-more title="More emojis" aria-label="More emojis">${icon('plus', 20)}</button>`;
    document.body.appendChild(el);
    btn.closest('.ib-row')?.classList.add('picking');
    picker = { el, btn };
    placePicker();
  }
  document.addEventListener('click', async (e) => {
    const path = e.composedPath(); // taken at click time: "+" swaps the picker's contents, so its button is gone afterwards
    const inPicker = picker && path.includes(picker.el);
    const more = inPicker && e.target.closest('[data-react-more]');
    if (more) {
      picker.el.classList.add('expanded');
      picker.el.innerHTML = `<div class="ib-react-grid">${[...REACTIONS, ...MORE_REACTIONS].map((x) => emojiBtn(x, picker.el.dataset.mine)).join('')}</div>`;
      placePicker();
      return;
    }
    const pick = inPicker && e.target.closest('[data-emoji]');
    if (pick) {
      const { for: wamid, mine, key } = picker.el.dataset;
      const emoji = pick.dataset.emoji === mine ? '' : pick.dataset.emoji;
      closePicker();
      try {
        await api(`/inbox/${enc(key)}/react`, { method: 'POST', body: { wamid, emoji } });
        if (ib.key === key) await loadThread();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (inPicker) return;
    const b = e.target.closest('#ibChat [data-react]');
    const same = b && picker && picker.el.dataset.for === b.dataset.react;
    closePicker();
    if (b && !same) openPicker(b);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });
  window.addEventListener('resize', closePicker);
  document.addEventListener('scroll', (e) => { if (picker && e.target.id === 'ibMsgs') closePicker(); }, true);

  // ---------- Swipe to reply ----------
  // Trackpad: two fingers left on a message. Touch: swipe it right (as on a phone). The bubble follows the fingers,
  // a reply arrow appears in the space it leaves and pops once you've gone far enough; let go and the bubble springs
  // back and the reply starts. Going past the point gets heavier (rubber band), like WhatsApp.
  const SWIPE_AT = 56, SWIPE_MAX = 84;
  let sw = null;
  let wheelQuietUntil = 0; // the trackpad's momentum keeps sending wheel events after a swipe ends; ignore those
  const canSwipe = (row) => row && row.dataset.wamid && !row.dataset.wamid.startsWith('tmp') && $('#ibText');
  function beginSwipe(row, dir) {
    closePicker();
    const bubble = row.querySelector('.ib-bubble');
    const ico = document.createElement('span');
    ico.className = 'ib-swipe-ico';
    ico.innerHTML = icon('reply', 15);
    // Sits where the bubble's edge was, so it's uncovered as the bubble slides away.
    const edge = dir < 0 ? bubble.offsetLeft + bubble.offsetWidth - 34 : bubble.offsetLeft + 6;
    ico.style.left = `${edge}px`;
    row.appendChild(ico);
    row.classList.add('swiping');
    return { row, bubble, ico, dir, dx: 0, armed: false, timer: 0 };
  }
  function moveSwipe(dx) {
    const d = Math.max(0, dx * sw.dir); // distance in the swipe's direction only
    const eased = d <= SWIPE_MAX ? d : SWIPE_MAX + (d - SWIPE_MAX) * 0.2;
    sw.bubble.style.transform = `translateX(${sw.dir * eased}px)`;
    sw.row.style.setProperty('--swipe', Math.min(1, eased / SWIPE_AT).toFixed(3));
    const armed = eased >= SWIPE_AT;
    if (armed !== sw.armed) {
      sw.armed = armed;
      sw.row.classList.toggle('swipe-armed', armed);
      if (armed) navigator.vibrate?.(10);
    }
  }
  function endSwipe() {
    if (!sw) return;
    const { row, bubble, ico, armed } = sw;
    clearTimeout(sw.timer);
    sw = null;
    row.classList.add('swipe-back');
    bubble.style.transform = '';
    row.style.setProperty('--swipe', 0);
    setTimeout(() => { row.classList.remove('swipe-back', 'swipe-armed', 'swiping'); ico.remove(); }, 340);
    if (armed) startReply(row.dataset.wamid);
  }
  // Trackpad (two-finger horizontal scroll arrives as wheel events).
  $('#ibChat').addEventListener('wheel', (e) => {
    const box = $('#ibMsgs');
    if (!box || !box.contains(e.target)) return;
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.2;
    if (!sw && !horizontal) return;
    e.preventDefault(); // also keeps the browser's swipe-back-a-page gesture out of the chat
    if (!sw) {
      if (performance.now() < wheelQuietUntil) { wheelQuietUntil = performance.now() + 120; return; }
      const row = e.target.closest('.ib-row');
      if (!canSwipe(row) || e.deltaX <= 0) return; // fingers left only
      sw = beginSwipe(row, -1);
    }
    sw.dx -= e.deltaX;
    moveSwipe(sw.dx);
    clearTimeout(sw.timer);
    sw.timer = setTimeout(() => { endSwipe(); wheelQuietUntil = performance.now() + 250; }, 180); // no wheel event for a moment = fingers lifted
  }, { passive: false });
  // Touch screens: swipe right.
  let touch = null;
  $('#ibChat').addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const row = e.target.closest('#ibMsgs .ib-row');
    if (canSwipe(row)) touch = { row, x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  $('#ibChat').addEventListener('pointermove', (e) => {
    if (!touch || e.pointerId !== touch.id) return;
    const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
    if (!sw) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { touch = null; return; } // scrolling instead
      if (dx < 10 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      sw = beginSwipe(touch.row, 1);
      try { touch.row.setPointerCapture(e.pointerId); } catch { /* keeps working without capture */ }
    }
    moveSwipe(dx);
  });
  const endTouch = (e) => { if (touch && e.pointerId === touch.id) { touch = null; endSwipe(); } };
  $('#ibChat').addEventListener('pointerup', endTouch);
  $('#ibChat').addEventListener('pointercancel', endTouch);

  // A failed message's details: a small card floating above the "Details" link (outside the message list, so it
  // can't be mistaken for a message). Closes on a click elsewhere, scrolling, resizing or Esc.
  let errPop = null;
  const closeErrPop = () => { errPop?.el.remove(); errPop?.btn.setAttribute('aria-expanded', 'false'); errPop = null; };
  document.addEventListener('click', (e) => {
    if (errPop && e.composedPath().includes(errPop.el)) {
      const rep = e.target.closest('[data-report]');
      if (rep) {
        e.preventDefault();
        const { code, title } = errPop.el.dataset;
        closeErrPop();
        window.MetaErrors?.report({ code, area: 'Inbox & replies', from: '/inbox', message: `A message to ${current()?.name || current()?.wa ? (current().name || '+' + current().wa) : 'a contact'} wasn't delivered: ${title}.\n\n` });
        return;
      }
      const ec = e.target.closest('[data-ec]');
      if (ec) { e.preventDefault(); const code = ec.dataset.ec; closeErrPop(); window.MetaErrors?.open(code); return; }
      const c = e.target.closest('[data-copy]');
      if (c) navigator.clipboard?.writeText(c.dataset.copy).then(() => { c.lastChild.textContent = 'Copied'; setTimeout(() => { if (c.isConnected) c.lastChild.textContent = 'Copy'; }, 1500); }, () => toast("Couldn't copy", 'error'));
      return;
    }
    const b = e.target.closest('#ibChat [data-err-more]');
    const same = b && errPop?.btn === b;
    closeErrPop();
    if (!b || same) return;
    const el = document.createElement('div');
    el.className = 'ib-err-pop';
    el.setAttribute('role', 'dialog');
    const code = b.dataset.code;
    el.innerHTML = `<b>${esc(b.dataset.title)}</b>${b.dataset.explain ? `<p>${esc(b.dataset.explain)}</p>` : ''}
      <div class="ib-err-src">${code
        ? `<div class="ib-err-codeline"><span>Meta error <code>${esc(code)}</code></span><button class="ib-err-copy" data-copy="Meta error ${esc(code)}" title="Copy “Meta error ${esc(code)}”">${icon('copy', 13)}Copy</button><a href="/report?code=${esc(code)}" data-ec="${esc(code)}">What it means</a></div><p class="ib-err-raw">${esc(b.dataset.raw)}</p>`
        : `<p class="ib-err-raw">From this app (it didn't reach Meta): ${esc(b.dataset.raw)}</p>`}</div>
      <div class="ib-err-report">Still stuck? <a href="/report" data-report>Report an issue</a></div>`;
    el.dataset.code = code || '';
    el.dataset.title = b.dataset.title;
    document.body.appendChild(el);
    const r = b.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight, gap = 10;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w + 28), innerWidth - w - 8); // arrow near the card's right
    let top = r.top - h - gap, below = false;
    if (top < 8) { top = r.bottom + gap; below = true; }
    Object.assign(el.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
    el.style.setProperty('--arrow-x', `${Math.round(r.left + r.width / 2 - left)}px`);
    el.classList.toggle('below', below);
    b.setAttribute('aria-expanded', 'true');
    errPop = { el, btn: b };
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeErrPop(); });
  window.addEventListener('resize', closeErrPop);
  document.addEventListener('scroll', (e) => { if (errPop && e.target.id === 'ibMsgs') closeErrPop(); }, true);

  // Send a failed message again, as it was.
  $('#ibChat').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-resend]');
    if (!b || b.disabled) return;
    b.disabled = true;
    b.textContent = 'Sending…';
    const key = ib.key;
    try {
      await api(`/inbox/${enc(key)}/resend`, { method: 'POST', body: { id: b.dataset.resend } });
      if (ib.key === key) await loadThread();
    } catch (err) {
      toast(err.message, 'error');
      b.disabled = false;
      b.innerHTML = `${icon('refresh-cw', 12)}Resend`;
    }
  });

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
        <button class="icon-btn la-host" id="ibAttachBtn" title="Attach a photo, video, document or audio" aria-label="Attach" aria-haspopup="menu">${icon('paperclip', 18)}</button>
        <button class="icon-btn" id="ibStickerBtn" title="Stickers" aria-label="Stickers" aria-haspopup="dialog">${STICKER_SVG}</button>
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
    $('#ibAttachBtn').onclick = (e) => { $('.ib-stk-tray')?.remove(); attachMenu(e.currentTarget); };
    $('#ibStickerBtn').onclick = (e) => stickerTray(e.currentTarget);
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


  // ---------- Attachments: send a photo, video, document or audio in the 24-hour window ----------
  // The paperclip (or dropping files on the chat, or pasting a screenshot) opens a preview: each file large, with
  // its own caption, a strip to move between them, and a note on how WhatsApp will send it. Photos WhatsApp can't
  // take (WebP, HEIC in Safari…) or that are over 5 MB become JPGs here first, like the phone does. Anything else
  // too big for its kind can go as a document instead. Then each one rises into the chat with its upload progress.
  // Kept in step with OUT_MEDIA in server.js.
  const OUT_MEDIA = {
    image: { types: ['image/jpeg', 'image/png'], mb: 5, label: 'Photos' },
    video: { types: ['video/mp4', 'video/3gpp'], mb: 16, label: 'Videos' },
    audio: { types: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'], mb: 16, label: 'Audio files' },
    document: { types: null, mb: 100, label: 'Files' },
    sticker: { types: [], mb: 0.5, label: 'Stickers' },
  };
  const MIME_ALIAS = { 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/mp3': 'audio/mpeg', 'audio/x-aac': 'audio/aac', 'image/jpg': 'image/jpeg', 'audio/opus': 'audio/ogg' };
  // Types WhatsApp lists for documents. Others are tried, but WhatsApp may refuse them (its reason is shown).
  const DOC_OK = /^(application\/pdf|text\/plain|application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.[a-z.]+))$/;
  const MB = 1024 * 1024;
  const fmtSize = (n) => (n >= MB ? `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const att = { el: null, items: [], i: 0, key: null };

  const kindOf = (it) => (it.asSticker ? 'sticker' : it.asDoc ? 'document' : Object.keys(OUT_MEDIA).find((k) => OUT_MEDIA[k].types?.includes(it.mime)) || 'document');
  // A photo WhatsApp won't take as a photo, or one over 5 MB: redraw it as a JPG (at most 4096 px, smaller until it fits).
  async function asJpeg(file) {
    const bmp = await createImageBitmap(file);
    let scale = Math.min(1, 4096 / Math.max(bmp.width, bmp.height));
    for (const q of [0.9, 0.85, 0.8, 0.75, 0.7, 0.6]) {
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; // a PNG's see-through parts become white, not black
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= 5 * MB) return blob;
      scale *= 0.85;
    }
    throw new Error('too big');
  }
  // A sticker, as WhatsApp needs it: a 512×512 WebP up to 100 KB, the picture fitted inside with its see-through
  // parts kept. An animated WebP can only be used as it is (512×512, up to 500 KB): browsers can't make those.
  async function makeSticker(file) {
    if (file.type === 'image/webp') {
      const h = new Uint8Array(await file.slice(0, 32).arrayBuffer());
      if (String.fromCharCode(...h.slice(12, 16)) === 'VP8X' && h[20] & 0x02) {
        const w = 1 + (h[24] | (h[25] << 8) | (h[26] << 16)), ht = 1 + (h[27] | (h[28] << 8) | (h[29] << 16));
        if (w === 512 && ht === 512 && file.size <= 500 * 1024) return file;
        throw new Error(`Animated stickers have to be 512×512 and up to 500 KB; this one is ${w}×${ht}, ${fmtSize(file.size)}.`);
      }
    }
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { throw new Error("This browser can't open this picture to make a sticker."); }
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const k = Math.min(496 / bmp.width, 496 / bmp.height); // a few pixels of margin, as WhatsApp's guide asks
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, (512 - w) / 2, (512 - h) / 2, w, h);
    for (const q of [0.92, 0.85, 0.75, 0.65, 0.55, 0.45, 0.35]) {
      const b = await new Promise((r) => c.toBlob(r, 'image/webp', q));
      if (!b || b.type !== 'image/webp') throw new Error("This browser can't make stickers (it can't save WebP pictures). Try Chrome, Edge or Firefox.");
      if (b.size <= 100 * 1024) return b;
    }
    throw new Error("Couldn't make this picture small enough for a sticker (WhatsApp allows 100 KB).");
  }
  async function toggleSticker(it, on) {
    it.asSticker = on;
    if (on) it.asDoc = false;
    if (on && !it.sticker && !it.stickerErr) {
      if (att.el?.classList.contains('open')) attDraw();
      try {
        const b = await makeSticker(it.original || it.blob);
        it.sticker = { blob: b, url: URL.createObjectURL(b) };
      } catch (e) { it.stickerErr = e.message; }
    }
    if (att.el?.classList.contains('open') && att.items.includes(it)) attDraw();
  }
  const canSticker = (it) => /^image\//.test(it.original?.type || it.mime) && !/svg/.test(it.mime);
  async function prepare(file) {
    const it = { name: file.name || `Pasted image ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.png`, mime: MIME_ALIAS[file.type] || file.type || 'application/octet-stream', blob: file, caption: '', asDoc: false, note: '' };
    const img = /^image\//.test(it.mime) && it.mime !== 'image/gif' && it.mime !== 'image/svg+xml';
    if (img && (!OUT_MEDIA.image.types.includes(it.mime) || file.size > 5 * MB)) {
      try {
        const was = it.mime === 'image/jpeg' || it.mime === 'image/png' ? `It was ${fmtSize(file.size)}, over WhatsApp's 5 MB for photos, so it's been made smaller` : `WhatsApp takes photos as JPG or PNG, so this ${it.mime.split('/')[1].toUpperCase()} becomes a JPG`;
        it.blob = await asJpeg(file);
        it.mime = 'image/jpeg';
        it.name = it.name.replace(/\.[a-z0-9]+$/i, '') + '.jpg';
        it.note = `${was}. To send the original, tick “Send as a document”.`;
        it.original = file;
      } catch {
        it.asDoc = true;
        it.note = "This browser can't open this kind of photo, so it goes as a document.";
      }
    }
    if (it.mime === 'image/gif') { it.asDoc = true; it.note = 'GIFs go as a file. WhatsApp only plays GIFs that are sent from its own app.'; }
    if (/^video\//.test(it.mime) && !OUT_MEDIA.video.types.includes(it.mime)) { it.asDoc = true; it.note = `WhatsApp plays MP4 videos only, so this ${(it.name.split('.').pop() || 'video').toUpperCase()} goes as a document.`; }
    if (/^audio\//.test(it.mime) && !OUT_MEDIA.audio.types.includes(it.mime)) { it.asDoc = true; it.note = 'WhatsApp plays MP3, M4A, AAC, AMR and OGG audio, so this goes as a document.'; }
    it.url = URL.createObjectURL(it.blob);
    return it;
  }
  // What's wrong with sending it this way, if anything (blocks Send until fixed or removed).
  function problem(it) {
    if (it.asSticker) return it.stickerErr || (it.sticker ? '' : 'Making the sticker…');
    const k = kindOf(it), max = OUT_MEDIA[k].mb * MB, size = (it.asDoc && it.original ? it.original : it.blob).size;
    if (size > max) return k === 'document' ? `Too big: WhatsApp sends files up to 100 MB, and this is ${fmtSize(size)}.` : `Too big: ${OUT_MEDIA[k].label.toLowerCase()} can be up to ${OUT_MEDIA[k].mb} MB, and this is ${fmtSize(size)}.`;
    return '';
  }
  async function openAttach(files, opts = {}) {
    files = [...(files || [])].filter((f) => f && f.size !== undefined);
    if (!files.length || !ib.key || !$('#ibText')) return;
    if (!windowInfo(current()).open) return toast('The 24-hour reply window is closed. Send a template to restart the conversation.', 'error');
    if (!att.el) attBuild();
    if (att.key !== ib.key || !att.el.classList.contains('open')) { attReset(); att.key = ib.key; }
    const busy = toastBusy(files.length);
    const fresh = await Promise.all(files.slice(0, 30 - att.items.length).map(prepare));
    busy?.();
    if (files.length > fresh.length) toast(`Up to 30 files at a time: the first ${fresh.length} are ready. Send them, then add the rest.`, 'error');
    if (!att.items.length && !opts.sticker) {
      // What was typed in the reply box becomes the first file's caption (as on the phone). Not for stickers,
      // which can't have one: the text stays in the reply box.
      const ta = $('#ibText');
      if (ta?.value.trim() && fresh[0]) { fresh[0].caption = ta.value.trim(); ta.value = ''; ib.drafts[ib.key] = ''; autosize(); }
    }
    att.i = att.items.length;
    att.items.push(...fresh);
    if (opts.sticker) for (const it of fresh) if (canSticker(it)) toggleSticker(it, true);
    attDraw();
    att.el.classList.add('open');
    document.documentElement.classList.add('mv-lock');
    setTimeout(() => $('.atx-cap', att.el)?.focus(), 30);
  }
  // Converting big photos can take a moment.
  function toastBusy(n) {
    let shown = false;
    const t = setTimeout(() => { shown = true; toast(n > 1 ? `Getting ${n} files ready…` : 'Getting the file ready…'); }, 400);
    return () => { clearTimeout(t); return shown; };
  }
  function attReset() {
    for (const it of att.items) { URL.revokeObjectURL(it.url); if (it.origUrl) URL.revokeObjectURL(it.origUrl); if (it.sticker) URL.revokeObjectURL(it.sticker.url); }
    att.items = []; att.i = 0;
  }
  function attClose(keep = false) {
    if (!att.el?.classList.contains('open')) return;
    att.el.classList.remove('open');
    document.documentElement.classList.remove('mv-lock');
    $('.atx-view', att.el).innerHTML = '';
    if (!keep) attReset();
  }
  // Laid out like WhatsApp on the computer: ✕ and the file's name on top; the file large; the strip of files
  // (the selected one shows a bin to remove it); the caption pill with "add files" in it; then who it's going to
  // on the left and Send on the right.
  function attBuild() {
    att.el = document.createElement('div');
    att.el.className = 'atx';
    att.el.setAttribute('role', 'dialog');
    att.el.setAttribute('aria-modal', 'true');
    att.el.innerHTML = `
      <div class="atx-head">
        <button type="button" class="atx-x" data-as="close" aria-label="Cancel" title="Cancel">${icon('x', 20)}</button>
        <div class="atx-title"><b></b><small></small></div>
      </div>
      <div class="atx-view"></div>
      <div class="atx-under">
        <div class="atx-note" hidden></div>
        <div class="atx-strip" role="listbox" aria-label="Files to send"></div>
        <div class="atx-capwrap">
          <button type="button" class="atx-add" data-as="add" title="Add more files" aria-label="Add more files">${icon('plus', 18)}</button>
          <input class="atx-cap" type="text" maxlength="1024" placeholder="Add a caption" aria-label="Caption">
        </div>
      </div>
      <div class="atx-bar">
        <span class="atx-to"></span>
        <label class="atx-doc" title="Send the original file at full quality, as a document"><input type="checkbox" data-as="asdoc"><span>Send as document</span></label>
        <label class="atx-doc atx-stk" title="Send this picture as a WhatsApp sticker"><input type="checkbox" data-as="assticker"><span>Send as sticker</span></label>
        <button type="button" class="atx-send" data-as="send" aria-label="Send">${icon('send', 20)}<span class="atx-n"></span></button>
      </div>
      <input type="file" class="atx-more" multiple hidden>`;
    document.body.appendChild(att.el);
    att.el.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-as-rm]');
      if (rm) {
        const i = Number(rm.dataset.asRm);
        URL.revokeObjectURL(att.items[i].url);
        att.items.splice(i, 1);
        if (!att.items.length) return attClose();
        att.i = Math.min(att.i > i ? att.i - 1 : att.i, att.items.length - 1);
        return attDraw();
      }
      const go = e.target.closest('[data-as-go]');
      if (go) { att.i = Number(go.dataset.asGo); return attDraw(); }
      const fix = e.target.closest('[data-as-fix]');
      if (fix) { att.items[att.i].asDoc = true; return attDraw(); }
      const a = e.target.closest('[data-as]')?.dataset.as;
      if (a === 'close') attClose();
      else if (a === 'add') $('.atx-more', att.el).click();
      else if (a === 'send') attSend();
    });
    $('.atx-more', att.el).addEventListener('change', (e) => { openAttach(e.target.files); e.target.value = ''; });
    $('.atx-cap', att.el).addEventListener('input', (e) => { att.items[att.i].caption = e.target.value; });
    $('.atx-cap', att.el).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); attSend(); } });
    $('[data-as="asdoc"]', att.el).addEventListener('change', (e) => { const it = att.items[att.i]; it.asDoc = e.target.checked; if (it.asDoc) it.asSticker = false; attDraw(); });
    $('[data-as="assticker"]', att.el).addEventListener('change', (e) => toggleSticker(att.items[att.i], e.target.checked));
    document.addEventListener('keydown', (e) => {
      if (!att.el.classList.contains('open')) return;
      if (e.key === 'Escape') { e.stopImmediatePropagation(); attClose(); }
      // ←/→ move between files (not while typing a caption).
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target.tagName !== 'INPUT' && att.items.length > 1) {
        att.i = (att.i + (e.key === 'ArrowLeft' ? -1 : 1) + att.items.length) % att.items.length;
        attDraw();
      }
    }, true);
    // Files dropped on the open preview are added to it.
    att.el.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
    att.el.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); openAttach(e.dataTransfer.files); } });
  }
  // A file's icon, coloured by type (PDF red, Word blue, Excel green, PowerPoint orange…), with its extension.
  function fileIco(name, size = 26) {
    const ext = (name.split('.').pop() || 'file').toLowerCase();
    return `<span class="ib-doc2-ico ${DOC_KIND[ext] || 'other'}">${icon('file-text', size)}<em>${esc(ext.slice(0, 4).toUpperCase())}</em></span>`;
  }
  async function textPeek(it, view) {
    try {
      const t = await it.blob.slice(0, 4000).text();
      if (view.dataset.url === it.url + 'document') $('.atx-text', view).textContent = t + (it.blob.size > 4000 ? '\n…' : '');
    } catch { /* leave the card */ }
  }
  function attDraw() {
    const el = att.el, it = att.items[att.i], c = current() || {};
    const k = kindOf(it), bad = problem(it), file = k === 'sticker' && it.sticker ? it.sticker.blob : it.asDoc && it.original ? it.original : it.blob;
    $('.atx-title b', el).textContent = k === 'sticker' ? 'Sticker' : it.asDoc && it.original ? it.original.name : it.name;
    $('.atx-title small', el).textContent = `${fmtSize(file.size)}${att.items.length > 1 ? ` · ${att.i + 1} of ${att.items.length}` : ''}`;
    // The big preview, as they'll get it: the photo, the video, the PDF's pages, a text file's start, or a file card.
    const view = $('.atx-view', el);
    if (view.dataset.url !== it.url + k + (it.sticker?.url || '')) {
      view.dataset.url = it.url + k + (it.sticker?.url || '');
      const url = it.asDoc && it.original ? (it.origUrl ||= URL.createObjectURL(it.original)) : it.url;
      const mime = it.asDoc && it.original ? it.original.type : it.mime;
      const card = (extra = '') => `<div class="atx-file">${fileIco(it.name, 30)}<b>${esc(it.name)}</b><small>${esc(fmtSize(file.size))}</small>${extra}</div>`;
      view.innerHTML = k === 'sticker' ? `<div class="atx-sticker">${it.sticker ? `<img src="${it.sticker.url}" alt="Sticker">` : it.stickerErr ? `<img class="atx-sticker-was" src="${it.url}" alt="">` : '<span>Making the sticker…</span>'}</div>`
        : k === 'image' || (k === 'document' && /^image\/(jpeg|png|webp|gif|avif|bmp)$/.test(mime)) ? `<img src="${url}" alt="">`
        : k === 'video' ? `<video src="${url}" controls playsinline></video>`
        : k === 'audio' ? `<div class="atx-file"><span class="atx-aud">${HEADPHONES_SVG}</span><b>${esc(it.name)}</b><small>${esc(fmtSize(file.size))}</small><audio src="${url}" controls></audio></div>`
        : /pdf/.test(mime) ? `<iframe class="atx-pdf" src="${url}#toolbar=0&navpanes=0&view=FitH" title="${esc(it.name)}"></iframe>`
        : /^text\/(plain|csv|markdown)$/.test(mime) || /\.(txt|csv|md|log)$/i.test(it.name) ? `<div class="atx-page"><pre class="atx-text"></pre></div>`
        : card('<span class="atx-nopv">No preview available</span>');
      if ($('.atx-text', view)) textPeek(it, view);
    }
    // How it'll go: notes about conversions, documents WhatsApp may refuse, or what's blocking Send.
    const notes = [];
    if (it.note && !(it.original && it.asDoc)) notes.push(esc(it.note));
    if (k === 'document' && !DOC_OK.test(it.asDoc && it.original ? it.original.type : it.mime)) notes.push("WhatsApp lists PDF, Word, Excel, PowerPoint and text files for documents, so it may not accept this one. If it doesn't, you'll see why.");
    if (k === 'audio') notes.push('Audio is sent without a caption.');
    if (k === 'sticker' && it.sticker) notes.push(`Made into a 512×512 sticker (${fmtSize(it.sticker.blob.size)}), the size WhatsApp needs. Stickers are sent without a caption.`);
    if (bad && bad !== 'Making the sticker…') notes.unshift(`<b>${esc(bad)}</b>${['image', 'video', 'audio'].includes(k) ? ' <button type="button" class="atx-fix" data-as-fix>Send as document instead</button>' : ''}`);
    const note = $('.atx-note', el);
    note.hidden = !notes.length;
    note.classList.toggle('bad', Boolean(bad));
    note.innerHTML = notes.map((n) => `<p>${n}</p>`).join('');
    // The strip: thumbnails for photos and videos, coloured file icons for the rest. The selected one has a bin.
    $('.atx-strip', el).innerHTML = att.items.map((x, i) => {
      const xk = kindOf(x), on = i === att.i;
      const face = xk === 'sticker' && x.sticker ? `<img class="atx-chip-stk" src="${x.sticker.url}" alt="">`
        : /^image\/(jpeg|png|webp|gif|avif|bmp)$/.test(x.mime) ? `<img src="${x.url}" alt="">`
        : xk === 'video' ? `<video src="${x.url}#t=0.1" preload="metadata" muted></video>`
        : xk === 'audio' ? `<span class="atx-chip-aud">${HEADPHONES_SVG}</span>` : fileIco(x.name, 16);
      return `<div class="atx-chip ${on ? 'on' : ''} ${problem(x) ? 'bad' : ''}" role="option" aria-selected="${on}">
        <button type="button" ${on ? `data-as-rm="${i}" aria-label="Remove ${esc(x.name)}" title="Remove"` : `data-as-go="${i}" aria-label="${esc(x.name)}" title="${esc(x.name)}"`}>${face}${on ? `<span class="atx-bin">${icon('delete', 20)}</span>` : ''}</button>
      </div>`;
    }).join('');
    $('.atx-strip .on', el)?.scrollIntoView({ inline: 'center', block: 'nearest' });
    // Caption (not for audio).
    const cap = $('.atx-cap', el);
    cap.value = k === 'audio' || k === 'sticker' ? '' : it.caption;
    cap.disabled = k === 'audio' || k === 'sticker';
    cap.placeholder = k === 'audio' ? 'Audio is sent without a caption' : k === 'sticker' ? 'Stickers are sent without a caption' : 'Add a caption';
    // Bottom bar: who it's going to; "Send as document" for photos and videos; Send with how many.
    $('.atx-to', el).innerHTML = `<span class="ib-av" style="${avatarStyle(c.wa)}">${initials(c)}</span><span>${esc(displayName(c))}</span>`;
    const canDoc = (/^(image|video)\//.test(it.mime) && it.mime !== 'image/gif' && OUT_MEDIA[it.mime.startsWith('video') ? 'video' : 'image'].types.includes(it.mime)) || Boolean(it.original);
    $('.atx-doc', el).hidden = !canDoc;
    $('[data-as="asdoc"]', el).checked = it.asDoc && !it.asSticker;
    $('.atx-stk', el).hidden = !canSticker(it);
    $('[data-as="assticker"]', el).checked = Boolean(it.asSticker);
    const blocked = att.items.some(problem);
    const send = $('[data-as="send"]', el);
    send.disabled = blocked;
    send.title = blocked ? 'Fix or remove the files marked in red first' : att.items.length > 1 ? `Send ${att.items.length} files` : 'Send';
    $('.atx-n', el).textContent = att.items.length > 1 ? att.items.length : '';
  }
  function attSend() {
    if (!att.items.length || att.items.some(problem)) return;
    const key = att.key, items = att.items.slice();
    att.items = []; // the URLs live on in the chat until each upload is done
    attClose(true);
    let replyTo = ib.replyTo?.wamid;
    ib.replyTo = null;
    renderReplyBar();
    (async () => { for (const it of items) { await sendFile(key, it, replyTo); replyTo = undefined; } })();
  }
  // One file: a placeholder in the chat with the file itself (so it shows at once), then the upload with progress.
  function sendFile(key, it, replyTo) {
    const stk = it.asSticker && it.sticker;
    const type = kindOf(it), blob = stk ? stk.blob : it.asDoc && it.original ? it.original : it.blob, mime = stk ? 'image/webp' : it.asDoc && it.original ? (MIME_ALIAS[it.original.type] || it.original.type) : it.mime;
    const name = stk ? 'sticker.webp' : it.asDoc && it.original ? it.original.name : it.name;
    const temp = { id: 'tmp' + Date.now() + Math.random().toString(36).slice(2, 6), local: true, dir: 'out', type, text: type === 'audio' || type === 'sticker' ? '' : it.caption.trim(), ts: new Date().toISOString(), status: 'pending', context: replyTo, progress: 0, media: { local: stk ? stk.url : it.url, mime, filename: type === 'document' ? name : undefined, size: blob.size } };
    const thread = ib.thread;
    if (ib.key === key && thread) { thread.messages.push(temp); renderMessages(true); }
    return new Promise((done) => {
      const x = new XMLHttpRequest();
      x.open('POST', `/api/inbox/${enc(key)}/media`);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.setRequestHeader('X-Tab', TAB_ID);
      x.setRequestHeader('X-File-Type', mime);
      x.setRequestHeader('X-File-Name', encodeURIComponent(name));
      if (temp.text) x.setRequestHeader('X-Caption', encodeURIComponent(temp.text));
      if (replyTo) x.setRequestHeader('X-Reply-To', encodeURIComponent(replyTo));
      if (it.asDoc) x.setRequestHeader('X-As-Document', '1');
      if (stk) x.setRequestHeader('X-As-Sticker', '1');
      x.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        temp.progress = Math.round((100 * e.loaded) / e.total);
        const bar = $(`[data-upl="${temp.id}"]`);
        if (bar) { bar.querySelector('i').style.width = `${temp.progress}%`; bar.querySelector('small').textContent = temp.progress < 100 ? `Uploading ${temp.progress}%` : 'Sending…'; }
      };
      const fail = (msg) => {
        Object.assign(temp, { status: 'failed', error: msg });
        if (ib.key === key) renderMessages();
        toast(msg, 'error');
        done();
      };
      x.onerror = () => fail("Couldn't send the file: check the connection and try again.");
      x.onload = async () => {
        let json = {};
        try { json = JSON.parse(x.responseText || '{}'); } catch { /* not JSON */ }
        if (x.status === 401) location.href = '/login';
        if (x.status < 200 || x.status >= 300) return fail(json.error || (x.status === 413 ? 'That file is too big for WhatsApp' : `Couldn't send the file (${x.status})`));
        markSaved();
        if (thread) thread.messages = thread.messages.filter((m) => m !== temp);
        if (ib.key === key) await loadThread();
        setTimeout(() => { URL.revokeObjectURL(it.url); if (it.sticker) URL.revokeObjectURL(it.sticker.url); }, 60000);
        done();
      };
      x.send(blob);
    });
  }
  // The paperclip menu.
  function attachMenu(btn) {
    let m = $('.ib-attach-menu');
    if (m) return m.remove();
    m = document.createElement('div');
    m.className = 'ib-attach-menu';
    m.setAttribute('role', 'menu');
    m.innerHTML = `
      <button type="button" role="menuitem" data-pick="image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif,image/bmp,video/mp4,video/3gpp,video/quicktime,video/*">${icon('image', 17)}<span><b>Photos & videos</b><small>JPG, PNG up to 5 MB · MP4 up to 16 MB</small></span></button>
      <button type="button" role="menuitem" data-pick="">${icon('file-text', 17)}<span><b>Document</b><small>PDF, Word, Excel… up to 100 MB</small></span></button>
      <button type="button" role="menuitem" data-pick="audio/*">${HEADPHONES_SVG}<span><b>Audio</b><small>MP3, M4A, AAC, OGG up to 16 MB</small></span></button>
      <button type="button" role="menuitem" data-pick="image/*" data-sticker>${STICKER_SVG}<span><b>Sticker</b><small>Make one from any picture</small></span></button>`;
    btn.closest('.ib-compose').appendChild(m);
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = true;
      if (b.dataset.pick) inp.accept = b.dataset.pick;
      const sticker = 'sticker' in b.dataset;
      inp.onchange = () => openAttach(inp.files, { sticker });
      inp.click();
      m.remove();
    });
    setTimeout(() => {
      const away = (e) => { if (!m.contains(e.target) && !btn.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', away, true); } };
      document.addEventListener('pointerdown', away, true);
    });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('.ib-attach-menu')?.remove(); });
  // Drop files, or a whole folder, anywhere on a chat (like WhatsApp: a dashed frame, "Drop file here"). A folder
  // sends every file in it (and its folders) as separate files, skipping hidden ones like .DS_Store. With the reply
  // window closed it says so instead of letting the browser open the file.
  const DROP_FOLDER_SVG = '<svg viewBox="0 0 64 52" width="76" height="62" aria-hidden="true"><path d="M4 8a4 4 0 0 1 4-4h15l6 6h27a4 4 0 0 1 4 4v30a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="#5aa9e6"/><path d="M4 16h56v28a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="#78bdf0"/><circle cx="52" cy="44" r="8" fill="#21c063"/><path d="M52 40v8M48 44h8" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>';
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  function dropZone(show) {
    let z = $('#ibChat .ib-drop');
    if (!show) { z?.remove(); return; }
    const open = Boolean($('#ibText'));
    if (!z) { z = document.createElement('div'); z.className = 'ib-drop'; $('#ibChat').appendChild(z); }
    z.classList.toggle('closed', !open);
    const c = current() || {};
    z.innerHTML = `<div class="ib-drop-in">${DROP_FOLDER_SVG}<b>${open ? 'Drop file here' : "Can't send files right now"}</b><small>${open ? 'Photos, videos, documents, audio or a whole folder' : 'The 24-hour reply window is closed. Send a template to restart the conversation.'}</small>${open ? `<span class="ib-drop-to">To<span class="ib-av" style="${avatarStyle(c.wa)}">${initials(c)}</span><b>${esc(displayName(c))}</b></span>` : ''}</div>`;
  }
  async function droppedFiles(dt) {
    // Read the entries now: the drop's data is gone once this event is over.
    const entries = [...(dt.items || [])].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null)).filter(Boolean);
    if (!entries.length) return [...(dt.files || [])];
    const out = [];
    const walk = async (en) => {
      if (out.length >= 200 || en.name.startsWith('.')) return;
      if (en.isFile) { const f = await new Promise((res) => en.file(res, () => res(null))); if (f) out.push(f); return; }
      if (!en.isDirectory) return;
      const reader = en.createReader();
      for (;;) {
        const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        if (!batch.length) break;
        for (const x of batch.sort((p, q) => p.name.localeCompare(q.name, undefined, { numeric: true }))) await walk(x);
      }
    };
    for (const en of entries) await walk(en);
    return out;
  }
  $('#ibChat').addEventListener('dragenter', (e) => { if (!hasFiles(e) || !ib.key || att.el?.classList.contains('open')) return; e.preventDefault(); if (dragDepth++ === 0) dropZone(true); });
  $('#ibChat').addEventListener('dragover', (e) => { if (hasFiles(e) && ib.key) { e.preventDefault(); e.dataTransfer.dropEffect = $('#ibText') ? 'copy' : 'none'; } });
  $('#ibChat').addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropZone(false); } });
  $('#ibChat').addEventListener('drop', async (e) => {
    dragDepth = 0;
    dropZone(false);
    if (!hasFiles(e) || !ib.key) return;
    e.preventDefault();
    if (!$('#ibText')) return toast('The 24-hour reply window is closed. Send a template to restart the conversation.', 'error');
    const files = await droppedFiles(e.dataTransfer);
    if (!files.length) return toast('Nothing to send: that folder is empty', 'error');
    openAttach(files);
  });
  // Folders dropped on the open preview are added to it too.
  document.addEventListener('drop', async (e) => {
    if (!att.el?.classList.contains('open') || !att.el.contains(e.target) || !hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    openAttach(await droppedFiles(e.dataTransfer));
  }, true);

  // ----- The sticker tray (beside the paperclip): stickers sent or received in your chats; one tap sends one.
  const STICKER_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9.5L21 14.5V5a2 2 0 0 0-2-2z" /><path d="M14 21v-4.5a2 2 0 0 1 2-2h5"/><path d="M8.5 9.5h.01M15.5 9.5h.01"/><path d="M8.5 13.5s1.2 1.5 3.5 1.5"/></svg>';
  async function stickerTray(btn) {
    let t = $('.ib-stk-tray');
    if (t) return t.remove();
    $('.ib-attach-menu')?.remove();
    t = document.createElement('div');
    t.className = 'ib-stk-tray';
    t.setAttribute('role', 'dialog');
    t.setAttribute('aria-label', 'Stickers');
    t.innerHTML = `<div class="ib-stk-head"><b>Stickers</b><button type="button" class="ib-stk-make" data-stk-make>${icon('plus', 14)}Make a sticker</button></div><div class="ib-stk-grid"><p class="ib-stk-empty">Loading…</p></div>`;
    btn.closest('.ib-compose').appendChild(t);
    t.addEventListener('click', (e) => {
      if (e.target.closest('[data-stk-make]')) {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.accept = 'image/*';
        inp.onchange = () => openAttach(inp.files, { sticker: true });
        inp.click();
        return t.remove();
      }
      const b = e.target.closest('[data-stk]');
      if (b) { t.remove(); sendSticker(b.dataset.stk); }
    });
    setTimeout(() => {
      const away = (e) => { if (!t.isConnected) return document.removeEventListener('pointerdown', away, true); if (!t.contains(e.target) && !btn.contains(e.target)) { t.remove(); document.removeEventListener('pointerdown', away, true); } };
      document.addEventListener('pointerdown', away, true);
    });
    let list = [];
    try { list = (await api('/stickers')).stickers || []; } catch (err) { $('.ib-stk-grid', t).innerHTML = `<p class="ib-stk-empty">${esc(err.message)}</p>`; return; }
    if (!t.isConnected) return;
    $('.ib-stk-grid', t).innerHTML = list.length
      ? list.map((x) => `<button type="button" class="ib-stk" data-stk="${esc(x.id)}" title="Send this sticker" aria-label="Send sticker"><img src="/api/media/${enc(x.id)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></button>`).join('')
      : `<p class="ib-stk-empty">Stickers you send and receive show up here. You can also make one from any picture with <b>Make a sticker</b>.</p>`;
  }
  async function sendSticker(id) {
    const key = ib.key, thread = ib.thread;
    if (!key || !thread) return;
    const replyTo = ib.replyTo?.wamid;
    ib.replyTo = null;
    renderReplyBar();
    const temp = { id: 'tmp' + Date.now(), local: true, dir: 'out', type: 'sticker', text: '', ts: new Date().toISOString(), status: 'pending', context: replyTo, progress: 100, media: { local: `/api/media/${enc(id)}`, mime: 'image/webp' } };
    thread.messages.push(temp);
    renderMessages(true);
    try {
      await api(`/inbox/${enc(key)}/sticker`, { method: 'POST', body: { id, replyTo } });
      thread.messages = thread.messages.filter((m) => m !== temp);
      if (ib.key === key) await loadThread();
    } catch (err) {
      Object.assign(temp, { status: 'failed', error: err.message });
      if (ib.key === key) renderMessages();
      toast(err.message, 'error');
    }
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('.ib-stk-tray')?.remove(); });
  $('#ibChat').addEventListener('paste', (e) => {
    if (e.target.id !== 'ibText') return;
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    openAttach(files);
  });

  // ---------- Templates & new chats ----------

  // Send a template to this person: pick it (with the category chips, like the Send page), fill in its variables (a
  // header file can be uploaded), and watch the message take shape beside the fields. Then a review step, and once
  // sent there are 5 seconds to undo before it goes. Undo brings this window back as it was.
  // First the template window (the Send page's, with search, filters and previews): what this chat's number can't
  // send shows greyed with the reason. Picking one goes on to its variables.
  function templateModal(prev = null) {
    if (prev?.templateId || !window.TemplatePicker) return fillTemplate(prev);
    const key = ib.key, senderId = key.split(':')[0];
    const sender = state.senders.find((s) => s.id === senderId);
    if (!state.templates.some((t) => !tplSendBlock(t) && (!sender || templateSenders(t, [sender]).length))) return toast('No approved template can be sent from this number yet (Templates page)', 'error');
    let lastTpl = '';
    try { lastTpl = localStorage.getItem('ibTpl') || ''; } catch {}
    window.TemplatePicker({
      title: `Send a template to ${current()?.name || fmtPhone(current()?.wa || key.split(':')[1])}`,
      useText: 'Next',
      selected: prev?.pickFrom || lastTpl,
      nums: [],
      firstWaba: sender?.wabaId,
      block: (t) => tplSendBlock(t) || (sender && !templateSenders(t, [sender]).length ? `Not from ${sender.label}: it belongs to another Business Account` : null),
      onUse: (id) => { if (ib.key !== key) return false; try { localStorage.setItem('ibTpl', id); } catch {} fillTemplate({ templateId: id, values: prev?.values }); return true; },
    });
  }
  function fillTemplate(prev = null) {
    const key = ib.key, c = current();
    const senderId = key.split(':')[0];
    const sender = state.senders.find((s) => s.id === senderId);
    const usable = state.templates.filter((t) => !tplSendBlock(t) && (!sender || templateSenders(t, [sender]).length));
    if (!usable.length) return toast('No approved template can be sent from this number yet (Templates page)', 'error');
    const F = window.TplFill || {};
    const firstName = (c?.name || '').split(/\s+/)[0];
    const values = prev?.values || {};
    let lastTpl = '';
    try { lastTpl = localStorage.getItem('ibTpl') || ''; } catch {}
    const pick = prev?.templateId || (usable.some((t) => t.id === lastTpl) ? lastTpl : '');
    // Every template, grouped by the number(s) that can send it, like the Send page; this chat's number first, and
    // what it can't send (another Business Account, or not approved) shows but can't be picked.
    function tplOptions() {
      const ok = new Set(usable.map((t) => t.id));
      const opt = (t) => `<option value="${t.id}" data-tag="${esc(catLabel(t.category))}"${ok.has(t.id) ? '' : ' disabled'}${t.id === pick ? ' selected' : ''}>${esc(t.name)} · ${esc(t.language)}${t.status && t.status !== 'APPROVED' ? ` (${esc(TPL_STATUS[String(t.status).toUpperCase()] || t.status).toLowerCase()})` : ''}</option>`;
      const accounts = [...new Set(state.senders.map((x) => x.wabaId).filter(Boolean))];
      if (accounts.length < 2) return state.templates.map(opt).join('');
      const mine = sender?.wabaId;
      accounts.sort((a, b) => (b === mine) - (a === mine));
      const group = (label, ts) => (ts.length ? `<optgroup label="${esc(label)}">${ts.map(opt).join('')}</optgroup>` : '');
      return accounts.map((w) => group(`${accountLabel(w)}${w === mine ? '' : ' · not from this number'}`, state.templates.filter((t) => t.wabaId === w))).join('')
        + group('Other', state.templates.filter((t) => !accounts.includes(t.wabaId)));
    }
    const to = `${c?.name ? `<b>${esc(c.name)}</b> · ` : ''}${esc(fmtPhone(c?.wa || key.split(':')[1]))}`;
    const body = openModal(
      'Send a template',
      `<div class="it-grid">
        <div class="it-fields">
          <p class="sub it-to">To ${to} · via ${esc(sender?.label || c?.senderLabel || '')}</p>
          <div class="it-tpl-l"><span class="field-label">Template</span><select id="itTpl" class="hidden" aria-hidden="true" tabindex="-1"><option value="">— Choose a template —</option>${tplOptions()}</select>
            <button type="button" class="tp-btn" id="itChange" aria-haspopup="dialog"></button></div>
          <div class="it-vars-wrap" id="itVarsWrap"><div class="field-label">Fill in the variables</div><div id="itVars"></div></div>
          <div class="it-review hidden" id="itReview"></div>
        </div>
        <div class="it-prev">
          <div class="field-label">Preview</div>
          <div class="phone sp-phone-big"><div class="bubble" id="itPrev"></div></div>
        </div>
      </div>
      <div class="modal-actions"><button class="btn quiet" id="itBack">Cancel</button><button class="btn primary" id="itNext">Review</button></div>`
    );
    $('#modal .modal-box').classList.add('wide', 'it-box');
    const tpl = () => usable.find((t) => t.id === $('#itTpl', body).value);
    let step = 'fill';
    const defaultFor = (t, v) => t.linkDefaults?.[/^button(\d+)$/.exec(v.where)?.[1]] || (v.key === 'body.1' || /name/i.test(v.name) ? firstName : '');
    const preview = () => {
      const t = tpl();
      $('#itChange', body).innerHTML = t
        ? `${icon('file-text', 16)}<span class="tp-btn-main"><b title="${esc(t.name)}">${esc(t.name)}</b><small>${esc(t.language)} · ${esc(catLabel(t.category).toLowerCase())}${t.variables.length ? ` · ${t.variables.length} variable${t.variables.length > 1 ? 's' : ''}` : ' · no variables'}</small></span><span class="tp-btn-act">Change</span>`
        : `${icon('file-text', 16)}<span class="tp-btn-main"><b>Choose a template</b></span>${icon('chevron-down', 15)}`;
      $('#itPrev', body).innerHTML = t ? bubbleHtml(t, values) : '<span class="muted">Pick a template to see the message here.</span>';
    };
    const row = (t, v) => {
      const val = values[v.key] ?? '';
      const where = v.media ? 'header' : v.where.startsWith('button') ? 'button link' : v.where;
      const link = v.media || /^button/.test(v.where);
      const ph = v.media ? F.MEDIA_EXAMPLE?.[v.media] || 'https://…' : link ? 'https://… (any full link)' : 'Type the text';
      return `<div class="sp-map" data-key="${esc(v.key)}">
        <div class="var-key">${esc(v.media ? v.media + ' URL' : `{{${v.name}}}`)}<small>${esc(where)}</small></div>
        <input class="m-val" value="${esc(val)}" placeholder="${esc(ph)}" aria-label="${esc(varLabel(v))}" />
        ${v.media ? `<div class="m-upload-row"><label class="btn sm m-upload" title="Upload a ${esc(v.media)} from this computer">${icon('upload', 14)}${F.uploadedName?.(val) ? 'Replace' : 'Upload'} ${esc(v.media)}<input type="file" hidden accept="${esc(F.UPLOAD_ACCEPT?.[v.media] || '')}" /></label>${val ? `<button type="button" class="btn sm quiet m-unupload">${icon('delete', 14)}Remove</button>` : ''}</div>` : ''}
      </div>${v.media === 'document' ? `<div class="sp-map" data-key="header.filename">
        <div class="var-key">file name<small>header</small></div>
        <input class="m-val" value="${esc(values['header.filename'] || '')}" placeholder="e.g. Brochure.pdf" maxlength="100" aria-label="File name they see" />
        <small class="m-hint">What they see on the PDF. Leave empty to use the uploaded file's name.</small>
      </div>` : ''}`;
    };
    const draw = () => {
      const t = tpl();
      for (const v of t?.variables || []) if (values[v.key] == null) values[v.key] = defaultFor(t, v);
      $('#itVarsWrap', body).classList.toggle('hidden', !t);
      $('#itVars', body).innerHTML = !t ? '' : t.variables.length ? t.variables.map((v) => row(t, v)).join('') : '<p class="sub">This template has no variables: it goes exactly as shown.</p>';
      preview();
    };
    // A field with a problem gets a red note under it; returns the first problem.
    const check = () => {
      const t = tpl();
      if (!t) return 'Choose a template first';
      let first = '';
      for (const v of t.variables) {
        const inp = $(`.sp-map[data-key="${CSS.escape(v.key)}"] .m-val`, body);
        const val = String(values[v.key] || '').trim();
        const bad = !val ? (v.media ? `Add the header ${v.media}: upload it or paste its link` : `Fill in ${varLabel(v)}`) : linkProblem(val, Boolean(v.media) || /^button/.test(v.where)) ? `This ${linkProblem(val, true)}. Write the full link, e.g. https://example.com` : '';
        if (!inp) continue;
        inp.classList.toggle('bad', Boolean(bad));
        let note = inp.parentElement.querySelector('.m-err');
        if (bad && !note) { note = document.createElement('small'); note.className = 'm-err'; inp.after(note); }
        if (note) { if (bad) note.textContent = bad; else note.remove(); }
        if (bad && !first) { first = bad; inp.focus(); }
      }
      return first;
    };
    const setStep = (next) => {
      step = next;
      const t = tpl(), review = next === 'review';
      $('#itTpl', body).closest('.it-tpl-l').classList.toggle('hidden', review);
      $('#itVarsWrap', body).classList.toggle('hidden', review || !t);
      $('#itReview', body).classList.toggle('hidden', !review);
      if (review) {
        const demo = state.settings.demoMode;
        $('#itReview', body).innerHTML = `<div class="it-rev-card">
          <div class="it-rev-row"><span>Template</span><b>${esc(t.name)} · ${esc(t.language)}</b></div>
          <div class="it-rev-row"><span>To</span><b>${c?.name ? esc(c.name) + ' · ' : ''}${esc(fmtPhone(c?.wa || key.split(':')[1]))}</b></div>
          <div class="it-rev-row"><span>From</span><b>${esc(sender?.label || '')}${sender?.displayPhone ? ' · ' + esc(sender.displayPhone) : ''}</b></div>
          ${(() => { const ct = (window.Credits?.confirmText(t, 1) || '').replace(/^(<br>)+/, ''); return ct ? `<div class="it-rev-credit">${ct}</div>` : ''; })()}
        </div>
        <p class="it-rev-note">${icon(demo ? 'eye' : 'send', 14)}<span>${demo ? 'Demo mode: sending is simulated.' : '<b>Live:</b> a real WhatsApp message goes to them.'} You'll have 5 seconds to undo.</span></p>`;
        LA.hydrate($('#itReview', body));
      }
      $('#itBack', body).textContent = review ? 'Back' : 'Cancel';
      $('#itNext', body).innerHTML = review ? `${icon('send', 15)}Send now` : 'Review';
    };
    draw();
    $('#itTpl', body).onchange = () => { try { localStorage.setItem('ibTpl', $('#itTpl', body).value); } catch {} draw(); };
    // Change: back to the template window, keeping what's been typed (a variable with the same name carries over)
    $('#itChange', body).onclick = () => templateModal({ pickFrom: $('#itTpl', body).value, values });
    $('#itVars', body).addEventListener('input', (e) => {
      const r = e.target.closest('.sp-map');
      if (!r || !e.target.matches('.m-val')) return;
      values[r.dataset.key] = e.target.value;
      if (e.target.classList.contains('bad')) { e.target.classList.remove('bad'); r.querySelector('.m-err')?.remove(); }
      preview();
    });
    // Header file from the computer: the server keeps it and gives back a link, used like a pasted one.
    $('#itVars', body).addEventListener('change', async (e) => {
      if (!e.target.matches('.m-upload input[type=file]')) return;
      const file = e.target.files[0], r = e.target.closest('.sp-map'), btn = e.target.closest('.m-upload');
      e.target.value = '';
      if (!file || !r) return;
      btn.classList.add('busy');
      try {
        const res = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || (res.status === 413 ? 'That file is too big for WhatsApp' : `Upload failed (${res.status})`));
        values[r.dataset.key] = json.url;
        if (json.fileName && file.type === 'application/pdf') values['header.filename'] = json.fileName;
        draw();
        toast(`Uploaded ${file.name}`);
      } catch (err) { toast(err.message, 'error'); btn.classList.remove('busy'); }
    });
    $('#itVars', body).addEventListener('click', (e) => {
      const b = e.target.closest('.m-unupload');
      if (!b) return;
      const k = b.closest('.sp-map').dataset.key, file = F.uploadedName?.(values[k]);
      values[k] = '';
      if (values['header.filename'] != null) values['header.filename'] = '';
      draw();
      if (file) api('/uploads/' + file, { method: 'DELETE' }).catch(() => {});
    });
    $('#itBack', body).onclick = () => (step === 'review' ? setStep('fill') : closeModal());
    $('#itNext', body).onclick = async () => {
      if (step === 'fill') {
        const err = check();
        if (err) return toast(err, 'error');
        return setStep('review');
      }
      const t = tpl();
      const picked = Object.fromEntries(t.variables.map((v) => [v.key, values[v.key] || '']));
      if (values['header.filename']) picked['header.filename'] = values['header.filename'];
      closeModal();
      const who = c?.name || fmtPhone(c?.wa || '');
      if (!(await undoToast({ title: `Sending ${t.name}`, msg: `to ${who}` }))) {
        toast('Nothing was sent', '', { title: 'Undone', icon: 'undo-2' });
        if (ib.key === key) templateModal({ templateId: t.id, values });
        return;
      }
      try {
        // keepalive: still goes if the page was closed during the countdown
        await api(`/inbox/${enc(key)}/send`, { method: 'POST', body: { templateId: t.id, values: picked }, keepalive: true });
        toast(`Template sent to ${who}`);
        await loadList();
        if (ib.key === key) await loadThread(true);
      } catch (err) { toast(err.message, 'error'); }
    };
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
    // A restart (a deploy) can close the stream for good: start a new one shortly after.
    es.addEventListener('error', () => { if (es.readyState === EventSource.CLOSED) setTimeout(connect, 3000); });
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
      // what was loaded last time shows at once (no skeleton, no jump); the fresh list replaces it only if it differs
      ib.fsig = null;
      renderList();
      // the open chat is still drawn from before: leave it (no redraw, no jump) unless it's another chat
      if ($('#ibChat').dataset.key !== (ib.key || '')) renderChat(true);
      await loadList().catch((e) => toast(e.message, 'error'));
      if (ib.key) { await loadThread().catch(() => {}); markRead(); }
      else { // just reloaded with a chat open: open it again (if it's still there)
        let k = null; try { k = sessionStorage.getItem('ib.open'); } catch {}
        if (k && ib.convs.some((c) => c.key === k)) await openConversation(k).catch(() => {});
        else keep('ib.open', null);
      }
      fit();
    },
  };

  connect();
  loadList().catch(() => {});
})();
