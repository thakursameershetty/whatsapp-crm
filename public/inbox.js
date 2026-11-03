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
    const sig = JSON.stringify([key, t.earlier, t.chatLead, t.messages.map((m) => [m.id, m.status, m.text?.length, m.reaction])]);
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
    const why = lock ? `You set this: ${lock.qualified ? 'a qualified lead' : 'not a qualified lead'}. The AI won’t change it.` : 'Set by the AI. Click to decide yourself whether they’re a qualified lead.';
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
    const key = ib.key, ct = ib.thread?.contact, lock = ct?.leadLock;
    const set = (qualified) => guard(async () => {
      const r = await api(`/inbox/${enc(key)}/lead`, { method: 'POST', body: { qualified } });
      if (ib.key === key && ib.thread) { ib.thread.contact = r.contact; renderLead(); }
      toast(qualified === null ? 'The AI decides again whether they’re a qualified lead' : qualified ? 'Marked as a qualified lead' : 'Marked as not a qualified lead');
    });
    const r = b.getBoundingClientRect();
    Sheet.Menu.open(r.left, r.bottom + 4, [
      { label: 'Qualified lead', checked: lock?.qualified === true, action: () => set(true) },
      { label: 'Not a qualified lead', checked: lock?.qualified === false, action: () => set(false) },
      '-',
      { label: `Let the AI decide${!lock && ct ? ` (now: ${STATUS_LABEL[ct.status] || ct.status})` : ''}`, checked: !lock, action: () => set(null) },
    ]);
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
    let p;
    try { p = await api(`/inbox/${enc(key)}/profile`); } catch (err) { return toast(err.message, 'error'); }
    if (mine !== infoReq || ib.key !== key || !ib.thread) return;
    if (box.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return; // don't redraw under someone typing
    const c = current(), t = ib.thread, ct = p.contact, lead = t.chatLead || {}, lock = ct?.leadLock;
    const others = p.chats.filter((x) => !x.current);
    const via = state.senders.find((x) => x.id === c.senderId);
    const bits = [['Need', lead.need], ['Budget', lead.budget], ['Timeline', lead.timeline]].filter(([, v]) => v);
    // About: their details as text; the pencil in the header opens the contact form to change them.
    const about = (k, v) => `<div><dt>${k}</dt><dd class="${v ? '' : 'muted'}">${v ? esc(v) : '—'}</dd></div>`;
    box.innerHTML = `
      <div class="ibi-bar"><b>Contact info</b><span class="ibi-bar-acts">${ct ? `<button type="button" class="icon-btn" data-info-edit title="Edit contact" aria-label="Edit contact">${icon('square-pen', 16)}</button>` : ''}<button type="button" class="icon-btn" data-info-close title="Close" aria-label="Close">${icon('x', 17)}</button></span></div>
      <div class="ibi-scroll">
        <div class="ct-phead ibi-head">
          <span class="ib-av xl" style="${avatarStyle(c.wa)}">${initials(c)}</span>
          <h2>${esc(ct?.name || displayName(c))}</h2>
          <p><button type="button" class="ibi-copy" data-copy-num="+${esc(c.wa)}" title="Copy the number">${esc(fmtPhone(c.wa))}${icon('copy', 12)}</button></p>
          ${via ? `<p class="ibi-via">Chatting with ${esc(via.label)}${via.displayPhone ? ' · ' + esc(via.displayPhone) : ''}</p>` : ''}
        </div>
        ${ct ? `
        <section class="ibi-sec">
          <div class="field-label">Stage${lock ? ` <span class="ibi-lock" title="You set this, so the AI won’t change it">${icon('lock', 11)}set by you</span>` : ' <span class="opt">set by the AI</span>'}</div>
          <div class="ct-pstatus">${STATUS_ORDER.map((k) => `<button type="button" class="ct-tag ${ct.status === k ? 'active' : ''}" data-info-status="${k}">${esc(STATUS_LABEL[k])}</button>`).join('')}</div>
          ${lock ? '<button type="button" class="ibi-link" data-info-ai>Let the AI decide again</button>' : ''}
          <label class="ct-poptout"><span>Opted out <span class="opt">never message them</span></span>${toggleHtml({ checked: ct.optOut, attrs: 'data-info-optout', size: 'sm' })}</label>
        </section>` : `
        <section class="ibi-sec ibi-new"><p class="sub">They’re not in your contacts yet.</p><button type="button" class="btn sm primary" data-info-add>${icon('plus', 14)}Add to contacts</button></section>`}
        ${lead.summary || bits.length ? `<section class="ct-leadbox ibi-sec"><div class="pc-label">This chat, from the lead assistant <button type="button" class="ib-lead-again" data-lead-again title="Summarise again"><svg class="orb-icon" data-orb-icon="13" aria-hidden="true"></svg><span>Summarise</span></button></div>
          ${lead.summary ? `<p>${esc(lead.summary)}</p>` : ''}${bits.length ? `<dl>${bits.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}</section>`
          : t?.messages?.some((m) => m.dir === 'in') ? `<section class="ct-leadbox ibi-sec"><div class="pc-label">This chat, from the lead assistant <button type="button" class="ib-lead-again" data-lead-again title="Summarise: the AI reads the whole chat and writes notes"><svg class="orb-icon" data-orb-icon="13" aria-hidden="true"></svg><span>Summarise</span></button></div><p class="muted">No summary yet.</p></section>` : ''}
        ${ct ? `
        <section class="ibi-sec">
          <div class="field-label">Tags</div>
          <div class="ct-pick ibi-tags">${(t.tags || []).map((x) => `<button type="button" class="ct-tag tag-${esc(x.color)} ${ct.tags.includes(x.id) ? 'active' : ''}" data-info-tag="${x.id}"><i></i><span class="ct-tag-name">${esc(x.name)}</span></button>`).join('') || '<span class="sub">No tags yet. Make them on the Contacts page.</span>'}</div>
        </section>
        <section class="ibi-sec">
          <div class="field-label">About</div>
          <dl class="ibi-about">${about('Name', ct.name)}${about('Phone', fmtPhone(c.wa))}${about('Email', ct.email)}${about('Company', ct.company)}${about('Notes', ct.notes)}</dl>
        </section>` : ''}
        ${others.length ? `<section class="ibi-sec"><div class="field-label">Other chats with your numbers <span class="opt">${others.length}</span></div>
          <div class="ibi-chats">${others.map((x) => `<button type="button" class="pf-chat" data-pf-open="${esc(x.key)}">
            <div class="pf-chat-h"><b>${esc(x.number)}</b><time>${esc(relTime(x.lastAt))}</time></div>
            <p class="pf-sum${x.lead?.summary ? '' : ' muted'}">${esc(x.lead?.summary || 'No summary yet.')}</p>
            <div class="pf-last">${x.lastDir === 'out' ? 'You: ' : ''}${esc(String(x.lastText || '').slice(0, 90))}</div>
          </button>`).join('')}</div></section>` : ''}
        ${ct ? `<button type="button" class="ibi-link ibi-foot" data-info-contacts="${esc(ct.id)}">${icon('users', 13)}Open in Contacts (change number, delete)</button>` : ''}
      </div>`;
    box.classList.remove('hidden');
    $('#inbox').classList.add('has-info');
    LA.hydrate?.(box);
    Orb.hydrate(box);
  }
  // Save one change to the contact, then reload the chat (pill, strip and this panel follow).
  async function saveContact(body, msg) {
    const ct = ib.thread?.contact;
    if (!ct) return;
    await guard(async () => { await api('/contacts/' + ct.id, { method: 'PUT', body }); if (msg) toast(msg); await loadThread(); });
  }
  $('#ibInfo').addEventListener('click', (e) => {
    const ct = ib.thread?.contact, key = ib.key;
    if (e.target.closest('[data-info-close]')) return closeInfo();
    if (e.target.closest('[data-info-edit]') && ct) return window.Contacts?.open(ct.id, { inChat: true, onSaved: () => loadThread() });
    const num = e.target.closest('[data-copy-num]');
    if (num) return navigator.clipboard?.writeText(num.dataset.copyNum).then(() => toast('Number copied'), () => {});
    const st = e.target.closest('[data-info-status]');
    if (st && ct && st.dataset.infoStatus !== ct.status) return saveContact({ status: st.dataset.infoStatus }, `Stage: ${STATUS_LABEL[st.dataset.infoStatus]}`);
    if (e.target.closest('[data-info-ai]')) return guard(async () => { await api(`/inbox/${enc(key)}/lead`, { method: 'POST', body: { qualified: null } }); toast('The AI decides the stage again'); await loadThread(); });
    const tg = e.target.closest('[data-info-tag]');
    if (tg && ct) { const id = tg.dataset.infoTag; return saveContact({ tags: ct.tags.includes(id) ? ct.tags.filter((x) => x !== id) : [...ct.tags, id] }); }
    if (e.target.closest('[data-info-add]')) {
      const c = current();
      return guard(async () => { await api('/contacts', { method: 'POST', body: { phone: '+' + c.wa, name: c.name || '' } }); toast('Added to contacts'); await loadThread(); });
    }
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
          <button class="btn sm quiet" data-ai="regen" title="Regenerate">${icon('refresh-cw', 14)}<span class="bl">Regenerate</span></button><button class="btn sm quiet" data-ai="dismiss" title="Dismiss">${icon('x', 14)}<span class="bl">Dismiss</span></button>
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
    Sheet.Menu.open(r.left, r.bottom + 6, [
      ...ai.playbooks.map((p) => ({ label: p.name, checked: ai.playbook?.id === p.id, kbd: manual && ai.playbook?.id === p.id ? 'chosen' : '', action: () => set(p.id) })),
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
    const src = m.media?.id ? `/api/media/${enc(m.media.id)}` : '';
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

  // Send a template to this person: pick it (with the category chips, like the Send page), fill in its variables (a
  // header file can be uploaded), and watch the message take shape beside the fields. Then a review step, and once
  // sent there are 5 seconds to undo before it goes. Undo brings this window back as it was.
  function templateModal(prev = null) {
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
          <label>Template<select id="itTpl" data-chips><option value="">— Choose a template —</option>${tplOptions()}</select></label>
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
      $('#itTpl', body).closest('label').classList.toggle('hidden', review);
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
