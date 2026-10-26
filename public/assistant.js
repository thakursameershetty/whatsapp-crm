// AI assistant page: a prompt box with file attachments, a data
// preview window, and a thread where each reply streams its steps (with thinking
// orbs) and ends in text, a question to answer, a stats card, or a campaign plan.
// Plans are only sent when the person clicks Approve on the card.

(function () {
  const AS = {
    sessionId: null,
    pending: [], // attached files not yet sent with a message
    files: new Map(), // localId -> file, every file this conversation has seen
    busy: false,
    openQuestion: null, // { el }
    openPlans: new Map(), // planId -> { el, plan }
    preview: { fileId: null, filter: 'all', search: '' },
    orbs: new Set(),
  };
  const ACCEPT = /\.(csv|tsv|txt|xlsx|xls)$/i;
  const PREVIEW_ROWS = 300;

  // --- Small helpers ---------------------------------------------------------

  const orb = (el, state, size = 18) => {
    const h = Orb.mount(el, { state, size });
    AS.orbs.add(h);
    return {
      destroy() {
        h.destroy();
        AS.orbs.delete(h);
      },
    };
  };
  const orbSvg = (cls = '') => `<svg class="orb ${cls}"></svg>`;
  const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const fmtPhone = (p) => (p ? '+' + p : '');

  // Lightweight markdown: paragraphs, bullet / numbered lists, **bold**, `code`.
  function md(text) {
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const out = [];
    let list = null, para = [];
    const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; };
    for (const line of String(text).split('\n')) {
      const ul = line.match(/^\s*[-*•]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushList();
        (list ||= { tag, items: [] }).items.push((ul || ol)[1]);
      } else if (!line.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(line.replace(/^#+\s*/, '')); }
    }
    flushPara();
    flushList();
    return out.join('');
  }

  // --- Reading files -----------------------------------------------------------

  // Files are read exactly like on the Send page (shared code), so the same messy sheets work:
  // every sheet, long numbers kept as digits, any CSV delimiter, header-less sheets, blank or
  // repeated column names. Rows are kept as objects keyed by column name here.
  const readSheets = (file) => SendPage.readWorkbook(file);
  function toTable(grid) {
    const t = SendPage.toTable(grid);
    return { headers: t.headers, rows: t.rows.map((r) => Object.fromEntries(t.headers.map((h, i) => [h, r[i] ?? '']))) };
  }

  // Rows pushed a few columns right (Meta lead exports that merge forms): same detection and fix
  // as the Send page.
  const cellsOf = (f) => f.rows.map((r) => f.headers.map((h) => r[h] ?? ''));
  const shiftedIn = (f) => detectShiftedRows(f.headers, cellsOf(f), f.headers.indexOf(f.phoneColumn));
  function fixShifted(f) {
    const fixed = realignShiftedRows(f.headers, cellsOf(f), shiftedIn(f));
    f.headers = fixed.headers;
    f.rows = fixed.rows.map((cells) => Object.fromEntries(f.headers.map((h, i) => [h, String(cells[i] ?? '').trim()])));
    if (!f.headers.includes(f.phoneColumn)) f.phoneColumn = guessPhone(f.headers, f.rows);
    check(f);
  }

  const guessPhone = (headers, rows) => guessPhoneColumn(headers, rows, (r, i, h) => r[h]);


  // Per-row phone check for the preview, with the same rules the server applies.
  function check(f) {
    const seen = new Set();
    let valid = 0, invalid = 0, duplicate = 0;
    f.meta = f.rows.map((r) => {
      const phone = normalizePhone(r[f.phoneColumn]);
      if (!phone) { invalid++; return { phone, status: 'invalid' }; }
      if (seen.has(phone)) { duplicate++; return { phone, status: 'duplicate' }; }
      seen.add(phone);
      valid++;
      return { phone, status: 'valid' };
    });
    f.counts = { valid, invalid, duplicate };
  }

  const newId = () => Math.random().toString(36).slice(2, 9);

  // Every sheet with data becomes its own attachment (the AI sees each separately and can combine them);
  // sheets of one file share a group, shown as one chip.
  async function attach(list) {
    const files = [...list].filter((x) => ACCEPT.test(x.name));
    if (!files.length) return toast('Attach CSV or Excel files (.csv, .tsv, .xlsx, .xls)', 'error');
    let first = null;
    for (const file of files) {
      try {
        const sheets = (await readSheets(file)).filter((sh) => sh.grid.some((r) => r.some((c) => String(c).trim())));
        if (!sheets.length) { toast(`${file.name} is empty`, 'error'); continue; }
        const group = 'g' + newId();
        for (const sh of sheets) {
          const { headers, rows } = toTable(sh.grid);
          if (!headers.length) continue;
          const many = sheets.length > 1;
          const f = { localId: 'l' + newId(), group, file: file.name, sheet: many ? sh.name : '', name: many ? `${file.name} · ${sh.name}` : file.name, headers, rows, phoneColumn: guessPhone(headers, rows), fileId: null };
          check(f);
          // Rows pushed a few columns right (Meta exports that merge forms) are moved back straight away.
          const shifted = shiftedIn(f).reduce((n, g) => n + g.idx.length, 0);
          if (shifted) { fixShifted(f); f.autoFixed = shifted; }
          AS.files.set(f.localId, f);
          AS.pending.push(f);
          first ||= f;
        }
      } catch (e) {
        toast(`Couldn't read ${file.name}: ${e.message}`, 'error');
      }
    }
    renderPending();
    syncSend();
    // Open the preview straight away so the data is checked first.
    if (first) openPreview(first.localId);
  }

  const groupsOf = (list) => {
    const m = new Map();
    for (const f of list) (m.get(f.group) || m.set(f.group, []).get(f.group)).push(f);
    return [...m.values()];
  };

  // One chip per file; a workbook's chip counts its sheets.
  const fileChip = (sheets, removable) => {
    const f = sheets[0];
    const rows = sheets.reduce((n, x) => n + x.rows.length, 0), invalid = sheets.reduce((n, x) => n + x.counts.invalid, 0);
    return `
    <span class="file-chip la-host" data-preview="${f.localId}" role="button" tabindex="0" title="Preview ${esc(f.file)}">
      ${icon('file-spreadsheet', 16)}
      <span class="fc-text"><span class="fc-name">${esc(f.file)}</span><span class="fc-meta">${sheets.length > 1 ? `${sheets.length} sheets · ` : ''}${plural(rows, 'row')}${invalid ? ` · <span class="warn-text">${invalid} invalid</span>` : ''}</span></span>
      ${removable ? `<button type="button" class="fc-x" data-unattach="${f.group}" aria-label="Remove ${esc(f.file)}">${icon('x', 13)}</button>` : ''}
    </span>`;
  };

  function renderPending() {
    const el = $('#cmpFiles');
    el.innerHTML = groupsOf(AS.pending).map((g) => fileChip(g, true)).join('');
    el.classList.toggle('hidden', !AS.pending.length);
  }

  // --- Composer ---------------------------------------------------------------

  const input = $('#cmpInput');
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  }
  function syncSend() {
    const empty = !input.value.trim();
    $('#cmpSend').disabled = AS.busy || empty;
    $('#composer').classList.toggle('busy', AS.busy);
    $('#cmpHint').textContent = AS.busy ? 'Working…' : AS.pending.length && empty ? 'Now say what to do with the file' : '';
  }
  input.addEventListener('input', () => { autosize(); syncSend(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || AS.busy) return;
    send({ text });
  });
  $('#cmpFile').addEventListener('change', (e) => { attach(e.target.files); e.target.value = ''; });

  const composer = $('#composer');
  composer.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('over'); });
  composer.addEventListener('dragleave', (e) => { if (!composer.contains(e.relatedTarget)) composer.classList.remove('over'); });
  composer.addEventListener('drop', (e) => {
    e.preventDefault();
    composer.classList.remove('over');
    if (e.dataTransfer.files.length) attach(e.dataTransfer.files);
  });

  document.addEventListener('click', (e) => {
    const x = e.target.closest('[data-unattach]');
    if (x) {
      e.stopPropagation();
      const g = x.dataset.unattach;
      AS.pending.filter((f) => f.group === g).forEach((f) => AS.files.delete(f.localId));
      AS.pending = AS.pending.filter((f) => f.group !== g);
      renderPending();
      syncSend();
      return;
    }
    const chip = e.target.closest('[data-preview]');
    if (chip) openPreview(chip.dataset.preview);
  });
  document.addEventListener('keydown', (e) => {
    const chip = e.target.closest?.('[data-preview]');
    if (chip && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openPreview(chip.dataset.preview); }
  });

  function renderSenderPick() {
    const sel = $('#cmpSender');
    const cur = sel.value;
    const list = state.senders.filter((s) => s.enabled);
    sel.innerHTML = `<option value="">Any number</option>` + list.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}${s.displayPhone ? ' · ' + esc(s.displayPhone) : ''}</option>`).join('');
    sel.value = list.some((s) => s.id === cur) ? cur : '';
    $('#cmpSenderWrap').classList.toggle('hidden', !list.length);
  }

  $('#asThread').addEventListener('click', (e) => { if (e.target.closest('[data-as-new]')) $('#asNew').click(); });
  $('#asNew').addEventListener('click', async () => {
    if (AS.busy) return;
    if (AS.openPlans.size && [...AS.openPlans.values()].some((p) => p.plan.status === 'pending')) {
      const ok = await confirmDialog({ title: 'Start a new chat?', message: 'The plan waiting for approval in this chat will be dropped. Nothing has been sent.', confirmText: 'New chat' });
      if (!ok) return;
    }
    Motion.morph(reset, 'as'); // the prompt box glides back to the middle
  });

  // keepList: opening another chat re-renders the list itself, so its highlight can slide.
  // The empty page carries a faint wash of the sky's colour right now: golden at dawn, a warm
  // near-neutral at midday, orange-pink at sunset, violet at dusk, night blue after dark.
  // [hour, hue (OKLCH), chroma]; hues blend along the shorter way round the colour wheel.
  const SKY = [[0, 265, 0.07], [4.5, 265, 0.07], [6.5, 70, 0.12], [9, 85, 0.08], [12, 90, 0.035], [15.5, 80, 0.06], [18.5, 45, 0.11], [20, 330, 0.07], [21.5, 265, 0.07], [24, 265, 0.07]];
  function sky() {
    const d = new Date(), t = d.getHours() + d.getMinutes() / 60;
    const i = SKY.findIndex(([h], k) => k < SKY.length - 1 && t >= h && t < SKY[k + 1][0]);
    const [h0, a0, c0] = SKY[i], [h1, a1, c1] = SKY[i + 1];
    const f = (t - h0) / (h1 - h0);
    const dh = ((a1 - a0 + 540) % 360) - 180;
    const tab = $('#tab-assistant');
    tab.style.setProperty('--sky-h', ((a0 + dh * f + 360) % 360).toFixed(1));
    tab.style.setProperty('--sky-c', (c0 + (c1 - c0) * f).toFixed(3));
  }
  sky();
  setInterval(sky, 60000);

  // The empty page greets you by the time of day.
  function greet() {
    const h = new Date().getHours();
    $('#asGreet').textContent = h < 5 ? 'Working late?' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }

  // The header shows the chat's title (or "New chat").
  function setTitle(t) {
    const el = $('#asTitle');
    el.textContent = t || 'New chat';
    el.classList.toggle('muted', !t);
    el.title = t || '';
  }

  function reset({ keepList = false } = {}) {
    AS.chatId = null;
    setTitle('');
    greet();
    for (const h of AS.orbs) h.destroy();
    AS.orbs.clear();
    Object.assign(AS, { sessionId: null, pending: [], files: new Map(), openQuestion: null, openPlans: new Map() });
    $('#asThread').innerHTML = '';
    setActive(false);
    renderPending();
    input.value = '';
    autosize();
    syncSend();
    input.focus();
    if (!keepList) renderHistory();
  }

  function setActive(on) {
    $('#asPanel').classList.toggle('active', on);
    $('#asHero').classList.toggle('hidden', on);
    $('#asNew').classList.toggle('hidden', !on);
    $('#asThread').classList.toggle('hidden', !on);
  }

  // The page fills the window below whatever sits above it (banner, top bar on phones).
  function fit() {
    const tab = $('#tab-assistant');
    if (tab.classList.contains('hidden')) return;
    tab.style.height = Math.max(420, innerHeight - (tab.getBoundingClientRect().top + scrollY) - 4) + 'px';
  }
  addEventListener('resize', fit);

  // --- Sending a turn ----------------------------------------------------------

  async function uploadPending() {
    for (const f of AS.pending) {
      const r = await api('/ai/files', {
        method: 'POST',
        body: { sessionId: AS.sessionId, name: f.name, sheet: f.sheet, workbook: f.sheet ? f.file : '', headers: f.headers, rows: f.rows, phoneColumn: f.phoneColumn, shiftedFixed: f.autoFixed || 0 },
      });
      AS.sessionId = r.sessionId;
      f.fileId = r.fileId;
    }
  }

  async function send({ text = '', answer = null, shown = null }) {
    if (AS.busy) return;
    $('#asThread').classList.remove('replay');
    // First message: the prompt box glides from the middle to the bottom as the thread fades in.
    if (!$('#asPanel').classList.contains('active')) await Motion.morph(() => setActive(true), 'as');
    else setActive(true);
    if (!AS.chatId && $('#asTitle').classList.contains('muted')) setTitle(String(shown ?? text).replace(/\s+/g, ' ').trim().slice(0, 70));
    const files = AS.pending.slice();
    const thread = $('#asThread');

    // Anything left waiting is now settled by this message.
    if (AS.openQuestion && answer == null) resolveQuestion(AS.openQuestion.el, null, text);
    for (const [, p] of AS.openPlans) if (p.plan.status === 'pending') { p.plan.status = 'superseded'; renderPlan(p.el, p.plan); }

    thread.insertAdjacentHTML('beforeend', `<div class="msg-user">${files.length ? `<div class="mu-files">${groupsOf(files).map((g) => fileChip(g, false)).join('')}</div>` : ''}<div class="mu-bubble">${esc(shown ?? text)}</div></div>`);
    LA.hydrate(thread);
    thread.scrollTop = thread.scrollHeight;
    input.value = '';
    autosize();
    AS.busy = true;
    syncSend();
    const turn = newTurn();

    try {
      try {
        await uploadPending();
      } catch (e) {
        if (!/expired/i.test(e.message)) throw e;
        AS.sessionId = null; // the server restarted: start over with these files
        await uploadPending();
      }
      AS.pending = [];
      renderPending();
      await stream({ sessionId: AS.sessionId, text, answer, shown: shown ?? undefined, senderId: $('#cmpSender').value || undefined }, (ev) => onEvent(turn, ev));
    } catch (e) {
      turn.stopSteps();
      if (e.status === 412) {
        turn.add(`<div class="ai-note"><svg class="orb-icon" data-orb-icon="16"></svg><div><strong>Connect the AI first.</strong> ${esc(e.message)}</div><button class="btn sm primary" data-goto="settings">Open Settings</button></div>`);
        input.value = text;
      } else if (e.status === 409 && /new chat/i.test(e.message)) {
        turn.add(`<div class="ai-note warn">${icon('badge-alert', 16)}<div>${esc(e.message)}</div><button class="btn sm" data-as-new>New chat</button></div>`);
        input.value = text;
      } else if (e.status === 410) {
        AS.sessionId = null;
        turn.add(`<div class="ai-note warn">${icon('badge-alert', 16)}<div>This conversation expired (the server restarted). Attach the file again and resend your message.</div></div>`);
        input.value = text;
      } else {
        turn.add(`<div class="ai-note warn">${icon('badge-alert', 16)}<div>${esc(e.message)}</div></div>`);
      }
      autosize();
    } finally {
      AS.busy = false;
      turn.finish();
      syncSend();
      loadHistory();
    }
  }

  async function stream(body, onEv) {
    const res = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 401) location.href = '/login';
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw Object.assign(new Error(j.error || `Request failed (${res.status})`), { status: res.status });
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onEv(JSON.parse(line));
      }
    }
  }

  // One assistant reply: a list of steps, then the body (text and cards, in order).
  function newTurn() {
    const el = document.createElement('div');
    el.className = 'msg-ai';
    el.innerHTML = `<div class="ai-avatar">${orbSvg()}</div><div class="ai-main"><div class="ai-steps"></div><div class="ai-body"></div></div>`;
    $('#asThread').append(el);
    // One orb per reply: the avatar, showing what the AI is doing right now.
    let avatar = orb($('.ai-avatar svg', el), 'reasoning', 22), avatarState = 'reasoning';
    const setAvatar = (state) => {
      if (!avatar || state === avatarState) return;
      avatar.destroy();
      $('.ai-avatar', el).innerHTML = orbSvg();
      avatar = orb($('.ai-avatar svg', el), state, 22);
      avatarState = state;
    };
    const steps = new Map();
    const stepsEl = $('.ai-steps', el), body = $('.ai-body', el);
    follow(null, true);
    return {
      el,
      step(ev) {
        let s = steps.get(ev.id);
        if (!s) {
          const stick = nearBottom();
          const row = document.createElement('div');
          row.className = 'ai-step running';
          row.innerHTML = `<span class="st-ico"><span class="st-dot"></span></span><span class="st-label">${esc(ev.label)}</span><span class="st-detail"></span>`;
          stepsEl.append(row);
          s = { row, state: ev.state || 'working' };
          steps.set(ev.id, s);
          setAvatar(s.state);
          follow(row, stick);
        }
        if (ev.status === 'done' && s.row.classList.contains('running')) {
          s.row.classList.replace('running', 'done');
          // Back to whatever is still running, if anything.
          const still = [...steps.values()].filter((x) => x.row.classList.contains('running')).at(-1);
          if (still) setAvatar(still.state);
          $('.st-ico', s.row).innerHTML = icon('check-one', 14);
          if (ev.detail) $('.st-detail', s.row).textContent = ev.detail;
        }
      },
      add(html) {
        const stick = nearBottom();
        body.insertAdjacentHTML('beforeend', html);
        const node = body.lastElementChild;
        LA.hydrate(node);
        Orb.hydrate(node);
        follow(node, stick);
        return node;
      },
      stopSteps() {
        for (const [sid, s] of steps) if (s.row.classList.contains('running')) this.step({ id: sid, status: 'done' });
      },
      finish() {
        this.stopSteps();
        el.classList.add('done');
        // A single step ("Understanding your request") adds nothing once the answer is here.
        if (steps.size === 1 && body.children.length) stepsEl.classList.add('quiet');
        avatar.destroy();
        avatar = null;
        $('.ai-avatar', el).innerHTML = '<svg class="orb-icon" data-orb-icon="18"></svg>';
        Orb.hydrate(el);
        // Steps fold into one line once the reply is done; keep what's on screen from jumping.
        const n = steps.size;
        const thread = $('#asThread'), anchor = body.firstElementChild, before = anchor?.getBoundingClientRect().top;
        if (n > 1) {
          const think = [...steps.keys()].filter((k) => k.startsWith('think')).length;
          const work = n - think;
          stepsEl.insertAdjacentHTML('afterbegin', `<button type="button" class="steps-toggle">${work ? plural(work, 'step') : 'Thought it through'} ${icon('chevron-down', 14)}</button>`);
          stepsEl.classList.add('folded');
          if (anchor && before < thread.getBoundingClientRect().top + 40) thread.scrollTop += anchor.getBoundingClientRect().top - before;
        }
        if (!body.children.length && !n) el.remove();
      },
    };
  }

  $('#asThread').addEventListener('click', (e) => {
    const t = e.target.closest('.steps-toggle');
    if (t) t.parentElement.classList.toggle('folded');
  });

  // Follow new content only if the reader was already at the bottom (checked before it was added).
  const nearBottom = () => {
    const t = $('#asThread');
    return t.scrollHeight - t.scrollTop - t.clientHeight < 160;
  };
  function follow(node, stick) {
    if (!stick) return;
    const t = $('#asThread');
    // A tall card (a plan) is shown from its top rather than scrolled past.
    if (node && node.offsetHeight > t.clientHeight * 0.6) node.scrollIntoView({ block: 'start', behavior: 'instant' });
    else t.scrollTop = t.scrollHeight;
  }

  function onEvent(turn, ev) {
    switch (ev.type) {
      case 'session': AS.sessionId = AS.chatId = ev.sessionId; break;
      case 'step': turn.step(ev); break;
      case 'text': turn.add(`<div class="ai-text">${md(ev.text)}</div>`); break;
      case 'question': {
        const el = turn.add(questionHtml(ev));
        const o = orb($('.q-head svg', el), 'waiting', 16);
        AS.openQuestion = { el, orb: o };
        break;
      }
      case 'plan': {
        const stick = nearBottom();
        const el = turn.add('<div class="plan-card"></div>');
        AS.openPlans.set(ev.plan.id, { el, plan: ev.plan });
        renderPlan(el, ev.plan);
        follow(el, stick); // again, now that the card has its full height
        break;
      }
      case 'stats': turn.add(statsHtml(ev.stats)); Motion.values(turn.el); break;
      case 'sheet': supersede(ev.sheet.replaces); turn.add(sheetHtml(ev.sheet)); break;
      case 'error': turn.add(`<div class="ai-note warn">${icon('badge-alert', 16)}<div>${esc(ev.error)}</div></div>`); break;
    }
  }

  // --- Question card ------------------------------------------------------------

  function questionHtml(q) {
    return `<div class="q-card" data-question="${esc(q.id)}">
      <div class="q-head">${orbSvg()}<span>Needs your answer</span></div>
      <p class="q-text">${esc(q.question)}</p>
      <div class="q-options ${q.options.length ? '' : 'hidden'}">${q.options.map((o) => `<button type="button" class="q-opt" data-answer="${esc(o.label)}"><b>${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ''}</button>`).join('')}</div>
      <form class="q-other"><input placeholder="${q.options.length ? 'Or type your own answer…' : 'Type your answer…'}" aria-label="Your answer" /><button class="btn sm">Answer</button></form>
    </div>`;
  }

  function resolveQuestion(el, chosen, typed) {
    if (!el || el.classList.contains('answered')) return;
    el.classList.add('answered');
    AS.openQuestion?.orb.destroy();
    AS.openQuestion = null;
    $('.q-head', el).innerHTML = `${icon('check-one', 14)}<span>${typed && !chosen ? 'Answered in chat' : 'Answered'}</span>`;
    $$('.q-opt', el).forEach((b) => { b.disabled = true; b.classList.toggle('chosen', b.dataset.answer === chosen); });
    $$('.q-other input, .q-other button', el).forEach((x) => (x.disabled = true));
    if (typed && !chosen) $('.q-other input', el).value = typed;
  }

  $('#asThread').addEventListener('click', (e) => {
    const opt = e.target.closest('.q-opt');
    if (!opt || opt.disabled || AS.busy) return;
    const card = opt.closest('.q-card');
    resolveQuestion(card, opt.dataset.answer);
    send({ answer: opt.dataset.answer, shown: opt.dataset.answer });
  });
  $('#asThread').addEventListener('submit', (e) => {
    const form = e.target.closest('.q-other');
    if (!form) return;
    e.preventDefault();
    const val = $('input', form).value.trim();
    if (!val || AS.busy) return;
    resolveQuestion(form.closest('.q-card'), null, val);
    send({ answer: val, shown: val });
  });

  // --- Stats card -----------------------------------------------------------------

  // --- Clean sheet card (build_sheet): a preview of the table, and where it can go next ---------

  function sheetHtml(sh) {
    const d = sh.dropped || {};
    const notes = [
      d.no_valid_phone ? `${d.no_valid_phone.toLocaleString()} without a valid number left out` : '',
      d.duplicates_merged ? `${d.duplicates_merged.toLocaleString()} duplicate number${d.duplicates_merged === 1 ? '' : 's'} merged` : '',
      d.filtered_out ? `${d.filtered_out.toLocaleString()} filtered out` : '',
    ].filter(Boolean);
    const empty = Object.entries(sh.empty_cells || {}).filter(([c]) => c !== sh.phone_column).map(([c, n]) => `${esc(c)} empty in ${n.toLocaleString()}`);
    const more = Math.max(0, sh.rows - (sh.preview || []).length);
    return `<div class="sheet-card" data-sheet="${esc(sh.id)}">
      <div class="shc-head">${icon('file-spreadsheet', 18)}<div class="shc-title"><b>${esc(sh.name)}</b><span>${sh.rows.toLocaleString()} rows · ${sh.columns.length} columns · from ${(sh.sources || []).length} sheet${(sh.sources || []).length === 1 ? '' : 's'}</span></div><span class="shc-old hidden">Replaced by a newer version below</span></div>
      ${sh.summary ? `<p class="shc-sum">${esc(sh.summary)}</p>` : ''}
      <div class="shc-table"><table><thead><tr>${sh.columns.map((c) => `<th>${c === sh.phone_column ? icon('phone', 11) : ''}${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${(sh.preview || []).map((r) => `<tr>${sh.columns.map((c) => `<td title="${esc(r[c])}">${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>
        ${more ? `<div class="shc-more">and ${more.toLocaleString()} more row${more === 1 ? '' : 's'}</div>` : ''}</div>
      ${notes.length || empty.length ? `<div class="shc-notes">${[...notes, ...empty].map((n) => `<span>${n}</span>`).join('')}</div>` : ''}
      <div class="shc-acts">
        <button type="button" class="btn sm primary" data-sheet-act="send">${icon('send', 14)}Open in Send</button>
        <button type="button" class="btn sm" data-sheet-act="xlsx">${icon('download', 14)}Excel</button>
        <button type="button" class="btn sm quiet" data-sheet-act="csv">CSV</button>
      </div>
    </div>`;
  }
  function supersede(oldId) {
    if (!oldId) return;
    const el = document.querySelector(`.sheet-card[data-sheet="${CSS.escape(oldId)}"]`);
    if (!el) return;
    el.classList.add('superseded');
    el.querySelector('.shc-old')?.classList.remove('hidden');
  }
  // The full table lives with the conversation on the server; fetched when it's opened or downloaded.
  async function fullSheet(id) {
    return api(`/ai/files/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(AS.sessionId || '')}`);
  }
  const saveFile = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000); }; // released later: a quick release can cut a download short
  const safeName = (n) => String(n || 'sheet').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'sheet';
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sheet-act]');
    if (!b) return;
    const id = b.closest('.sheet-card').dataset.sheet;
    guard(async () => {
      const t = await fullSheet(id);
      if (b.dataset.sheetAct === 'send') {
        SendPage.openSheet(t.name, t.headers, t.rows, t.phoneColumn);
        toast(`Opened “${t.name}” on the Send page · ${t.rows.length.toLocaleString()} rows`);
      } else if (b.dataset.sheetAct === 'csv') {
        const cell = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
        const csv = [t.headers, ...t.rows].map((r) => r.map((v) => cell(String(v ?? ''))).join(',')).join('\r\n');
        saveFile(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), safeName(t.name) + '.csv');
      } else {
        const XLSX = await loadXlsxLib();
        const ws = XLSX.utils.aoa_to_sheet([t.headers, ...t.rows]);
        ws['!cols'] = t.headers.map((h, i) => ({ wch: Math.min(40, Math.max(h.length, ...t.rows.slice(0, 200).map((r) => String(r[i] ?? '').length)) + 2) }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, safeName(t.name).slice(0, 31));
        const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
        saveFile(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), safeName(t.name) + '.xlsx');
      }
    }, b);
  });

  function statsHtml(st) {
    const t = st.totals, p = st.prev;
    const tile = (label, value, sub, key) => `<div class="sc-tile"><div class="sc-label">${label}</div><div class="sc-value" ${key}>${value}</div><div class="sc-sub">${sub}</div></div>`;
    const dr = pct(t.delivered, t.sent), rr = pct(t.read, t.delivered);
    const delta = (cur, prev) => {
      if (!prev) return cur ? 'new this period' : 'no sends';
      const d = Math.round((100 * (cur - prev)) / prev);
      return `${d >= 0 ? '+' : ''}${d}% vs previous ${st.range} days`;
    };
    const filt = [st.filters.sender && st.senders.find((s) => s.id === st.filters.sender)?.label, st.filters.template].filter(Boolean).join(' · ');
    const recent = st.recent.slice(0, 3);
    return `<div class="stats-card">
      <div class="sc-head"><span class="pc-label">Last ${st.range} days${filt ? ' · ' + esc(filt) : ''}</span><span class="pill ${st.demo ? 'demo' : 'completed'}">${st.demo ? 'Demo data' : 'Live'}</span></div>
      <div class="sc-tiles">
        ${tile('Sent', fmtNum(t.sent), delta(t.sent, p.sent))}
        ${tile('Delivered', dr + '%', `${fmtNum(t.delivered)} of ${fmtNum(t.sent)}`)}
        ${tile('Read', rr + '%', `${fmtNum(t.read)} of ${fmtNum(t.delivered)}`)}
        ${tile('Failed', fmtNum(t.failed), t.sent + t.failed ? pct(t.failed, t.sent + t.failed) + '% of attempts' : '—')}
      </div>
      ${recent.length ? `<div class="sc-recent">${recent.map((c) => {
        const s = c.stats || {};
        const sent = (s.sent || 0) + (s.delivered || 0) + (s.read || 0);
        return `<button type="button" class="sc-camp" data-open-campaign="${esc(c.id)}"><span class="sc-camp-name">${esc(c.name)}</span><span class="pill ${esc(c.status)}">${esc(c.status)}</span><span class="sc-camp-n">${sent.toLocaleString()} / ${c.total.toLocaleString()}</span></button>`;
      }).join('')}</div>` : ''}
    </div>`;
  }

  // --- Plan card --------------------------------------------------------------------

  const tplById = (tid) => state.templates.find((t) => t.id === tid);
  const fileByServerId = (fid) => [...AS.files.values()].find((f) => f.fileId === fid);

  function renderPlan(el, p) {
    for (const o of el._orbs || []) o.destroy();
    el._orbs = [];
    const t = tplById(p.templateId);
    const pending = p.status === 'pending';
    const skipped = Object.entries(p.counts.skipped);
    const skippedN = skipped.reduce((n, [, c]) => n + c, 0);
    const enabled = state.senders.filter((s) => s.enabled);
    const chosen = new Set(p.senders.map((s) => s.id));

    const mapSelect = (v) => {
      const m = p.mapping[v.key];
      const fixed = m.type === 'fixed';
      const opts = p.columns.map((c) => `<option value="col:${esc(c)}" ${!fixed && m.value === c ? 'selected' : ''}>${esc(c)}</option>`).join('');
      return `<div class="pc-map">
        <span class="pc-var">${esc(v.label)}</span>
        <span class="pc-arrow">←</span>
        ${pending ? `<select data-map="${esc(v.key)}" aria-label="Value for ${esc(v.label)}">${opts}<option value="fixed" ${fixed ? 'selected' : ''}>Fixed value…</option></select>
          <input class="pc-fixed ${fixed ? '' : 'hidden'}" data-fixed="${esc(v.key)}" value="${fixed ? esc(m.value) : ''}" placeholder="${v.media ? 'https://…' : 'Text for everyone'}" aria-label="Fixed value for ${esc(v.label)}" />`
          : `<span class="pc-val">${fixed ? `“${esc(m.value)}”` : `column <b>${esc(m.value)}</b>`}</span>`}
      </div>`;
    };

    const rules = [];
    if (p.filters.length) rules.push(...p.filters.map((f) => `${esc(f.column)} ${esc(f.op.replace(/_/g, ' '))}${f.value != null && !/empty/.test(f.op) ? ` “${esc(f.value)}”` : ''}`));
    if (p.optIn) rules.push(`Only opted in: ${esc(p.optIn.column)} is ${p.optIn.allowed_values.map((v) => `“${esc(v)}”`).join(' or ')}${p.sources.length > 1 ? (p.optIn.include_sheets_without_column ? ' · sheets without that column are included (you confirmed consent)' : ' · sheets without that column are left out') : ''}`);
    if (p.excludeDays) rules.push(`Skip anyone messaged in the last ${p.excludeDays} days`);

    const foot = {
      pending: `<span class="pc-wait">${orbSvg()} Waiting for your approval. Nothing has been sent.</span>
        <div class="pc-buttons"><button type="button" class="btn quiet" data-plan-decline>Decline</button>
        <button type="button" class="btn primary" data-plan-approve data-icon="send">${p.scheduledAt ? 'Approve & schedule' : 'Approve & send'} to ${p.counts.recipients.toLocaleString()}</button></div>`,
      approved: `<div class="pc-live" data-live="${esc(p.campaignId || '')}"><span class="pc-wait">${orbSvg()} <span class="pc-live-text">Starting…</span></span><div class="pc-progress"><span></span></div></div>
        <button type="button" class="btn sm quiet" data-open-campaign="${esc(p.campaignId || '')}">Open campaign</button>`,
      declined: `<span class="pc-done">${icon('x', 14)} Declined. Nothing was sent.</span>`,
      superseded: `<span class="pc-done">${icon('x', 14)} Not approved. You replied instead, so nothing was sent.</span>`,
      expired: `<span class="pc-done">${icon('clock', 14)} Not approved before the app restarted, so nothing was sent. Ask again for a fresh plan.</span>`,
    }[p.status];

    el.className = `plan-card status-${p.status}`;
    el.dataset.plan = p.id;
    el.innerHTML = `
      <div class="pc-head">
        <div>
          <div class="pc-kicker">Campaign plan <span class="pill ${p.demo ? 'demo' : 'completed'}">${p.demo ? 'Demo · simulated' : 'Live'}</span></div>
          <h3>${esc(p.name)}</h3>
        </div>
        <div class="pc-actions">
          <button type="button" class="btn sm quiet" data-plan-data data-icon="file-spreadsheet">View data</button>
          <a class="btn sm quiet" href="/api/ai/plans/${esc(p.id)}/recipients.csv" download data-icon="download">Download CSV</a>
        </div>
      </div>

      ${p.explanation ? `<div class="pc-section pc-explain">
        <div class="pc-label">What will happen</div>
        <div class="ai-text">${md(p.explanation)}</div>
        ${p.edited?.length ? `<p class="pc-note">You changed the ${esc(p.edited.join(' and '))} after this was written. The preview below is up to date.</p>` : ''}
      </div>` : ''}

      <div class="pc-section">
        <div class="pc-label">Recipients <span class="pc-cap">who gets the message, and who was left out and why</span></div>
        <div class="pc-recip">
          <div class="pc-big"><b>${p.counts.recipients.toLocaleString()}</b><span>will get this message<br><span class="muted">from ${plural(p.counts.rows, 'row')} in ${p.sources.length > 1 ? `${p.sources.length} sheets` : esc(p.sources[0].name)}</span></span></div>
          <div class="pc-skips">${skippedN ? skipped.map(([r, n]) => `<span class="pc-skip"><b>${n.toLocaleString()}</b> ${esc(r.toLowerCase())}</span>`).join('') : `<span class="pc-skip ok">${icon('check-one', 13)} No rows skipped</span>`}</div>
        </div>
      </div>

      <div class="pc-section">
        <div class="pc-label">Message preview <span class="pc-cap">exactly what the first ${p.samples.length > 1 ? p.samples.length + ' people' : 'person'} will see; their own values are highlighted</span></div>
        <div class="pc-carousel">${t ? p.samples.map((s) => `
          <div class="pc-sample">
            <div class="pc-to"><b>${esc(s.name || 'Recipient')}</b> ${esc(fmtPhone(s.phone))}</div>
            <div class="phone"><div class="bubble">${bubbleHtml(t, s.values)}</div></div>
          </div>`).join('') : `<p class="sub">Template preview unavailable.</p>`}
        </div>
      </div>

      <div class="pc-section">
        <div class="pc-label">Summary <span class="pc-cap">${pending ? 'you can change the numbers and variables here' : 'what was used'}</span></div>
        <dl class="pc-summary">
          <dt>Template</dt><dd><b>${esc(p.templateName)}</b> <span class="pill ${esc(p.templateStatus)}">${esc(p.templateStatus.toLowerCase())}</span></dd>
          <dt>Send from</dt><dd>${pending && enabled.length > 1
            ? `<div class="pc-senders">${enabled.map((s) => `<label class="pc-sender ${chosen.has(s.id) ? 'on' : ''}"><input type="checkbox" data-sender="${esc(s.id)}" ${chosen.has(s.id) ? 'checked' : ''} />${esc(s.label)}</label>`).join('')}</div>`
            : p.senders.map((s) => `<b>${esc(s.label)}</b>${s.phone ? ` <span class="muted">${esc(s.phone)}</span>` : ''}`).join(', ')}</dd>
          ${p.sources.length > 1
            ? `<dt>Sheets</dt><dd class="pc-sources">${p.sources.map((x) => `<div><b>${esc(x.name)}</b> <span class="muted">· phone column ${esc(x.phoneColumn)} · ${x.recipients.toLocaleString()} of ${plural(x.rows, 'row')}</span></div>`).join('')}</dd>`
            : `<dt>Phone column</dt><dd>${esc(p.sources[0].phoneColumn)}</dd>`}
          ${p.variables.length ? `<dt>Variables</dt><dd class="pc-maps">${p.variables.map(mapSelect).join('')}</dd>` : ''}
          ${rules.length ? `<dt>Rules</dt><dd>${rules.join('<br>')}</dd>` : ''}
          <dt>When</dt><dd>${p.scheduledAt ? `Scheduled for <b>${esc(new Date(p.scheduledAt).toLocaleString())}</b>` : 'Right after you approve'}</dd>
        </dl>
      </div>

      ${p.assumptions.length ? `<div class="pc-section"><div class="pc-label">Please check <span class="pc-cap">guesses the assistant made</span></div><ul class="pc-assume">${p.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}

      <div class="pc-foot">${foot}</div>`;
    LA.hydrate(el);
    const svg = $('.pc-wait svg', el);
    if (svg) el._orbs.push(orb(svg, p.status === 'approved' ? 'background' : 'waiting', 16));
    if (p.status === 'approved') watchCampaign(el, p.campaignId);
  }

  async function patchPlan(el, body) {
    const entry = AS.openPlans.get(el.dataset.plan);
    if (!entry) return;
    el.classList.add('saving');
    try {
      const plan = await api(`/ai/plans/${entry.plan.id}`, { method: 'PATCH', body });
      entry.plan = plan;
      renderPlan(el, plan);
      toast('Plan updated');
    } catch (e) {
      toast(e.message, 'error');
      renderPlan(el, entry.plan);
    } finally {
      el.classList.remove('saving');
    }
  }

  $('#asThread').addEventListener('change', (e) => {
    const card = e.target.closest('.plan-card');
    if (!card) return;
    const entry = AS.openPlans.get(card.dataset.plan);
    if (e.target.matches('[data-sender]')) {
      const ids = $$('[data-sender]', card).filter((x) => x.checked).map((x) => x.dataset.sender);
      if (!ids.length) { e.target.checked = true; return toast('Keep at least one number', 'error'); }
      patchPlan(card, { senderIds: ids });
    } else if (e.target.matches('[data-map]')) {
      const key = e.target.dataset.map;
      const fixedInput = $(`[data-fixed="${CSS.escape(key)}"]`, card);
      if (e.target.value === 'fixed') {
        fixedInput.classList.remove('hidden');
        fixedInput.focus();
      } else patchPlan(card, { mapping: { [key]: { type: 'column', value: e.target.value.slice(4) } } });
    } else if (e.target.matches('[data-fixed]')) {
      const val = e.target.value.trim();
      if (val && val !== entry.plan.mapping[e.target.dataset.fixed]?.value) patchPlan(card, { mapping: { [e.target.dataset.fixed]: { type: 'fixed', value: val } } });
    }
  });

  $('#asThread').addEventListener('click', async (e) => {
    const card = e.target.closest('.plan-card');
    if (!card) return;
    const entry = AS.openPlans.get(card.dataset.plan);
    if (!entry) return;
    if (e.target.closest('[data-plan-data]')) {
      const f = fileByServerId(entry.plan.fileId);
      if (f) openPreview(f.localId, entry.plan);
      return;
    }
    const approve = e.target.closest('[data-plan-approve]');
    const decline = e.target.closest('[data-plan-decline]');
    if (!approve && !decline) return;
    if (AS.busy) return toast('Wait for the assistant to finish', 'error');
    const p = entry.plan;
    if (approve) {
      const ok = await confirmDialog(p.demo
        ? { title: `Send to ${plural(p.counts.recipients, 'person', 'people')}?`, message: 'Demo mode is on, so sending is simulated.', confirmText: p.scheduledAt ? 'Schedule' : 'Send' }
        : { title: `Send ${plural(p.counts.recipients, 'real WhatsApp message')}?`, message: `This sends <strong>${esc(p.templateName)}</strong> from ${p.senders.map((s) => esc(s.label)).join(', ')}${p.scheduledAt ? ` at ${esc(new Date(p.scheduledAt).toLocaleString())}` : ' now'}. Meta charges for each message.`, confirmText: p.scheduledAt ? 'Schedule' : 'Send now' });
      if (!ok) return;
    }
    await guard(async () => {
      if (approve) {
        const r = await api(`/ai/plans/${p.id}/approve`, { method: 'POST' });
        entry.plan = r.plan;
        toast(r.campaign.status === 'scheduled' ? 'Campaign scheduled' : 'Campaign started');
        loadCampaignsQuietly();
      } else {
        entry.plan = await api(`/ai/plans/${p.id}/decline`, { method: 'POST' });
      }
      renderPlan(card, entry.plan);
    }, approve || decline);
  });

  const loadCampaignsQuietly = () => { if (!$('#tab-overview').classList.contains('hidden')) loadOverview().catch(() => {}); };

  // Live progress on an approved plan's card.
  function watchCampaign(el, cid) {
    clearTimeout(el._watch);
    const tick = async () => {
      if (!el.isConnected) return;
      try {
        const c = (await api('/campaigns')).find((x) => x.id === cid);
        if (!c) return;
        const s = c.stats || {};
        const done = (s.sent || 0) + (s.delivered || 0) + (s.read || 0) + (s.failed || 0);
        const delivered = (s.delivered || 0) + (s.read || 0);
        const text = c.status === 'scheduled'
          ? `Scheduled for ${new Date(c.scheduledAt).toLocaleString()}`
          : `${c.status === 'completed' ? 'Finished' : c.status === 'running' || c.status === 'queued' ? 'Sending' : c.status[0].toUpperCase() + c.status.slice(1)} · ${done.toLocaleString()} of ${c.total.toLocaleString()} processed · ${delivered.toLocaleString()} delivered${s.failed ? ` · ${s.failed} failed` : ''}`;
        $('.pc-live-text', el).textContent = text;
        $('.pc-progress span', el).style.width = (c.total ? (100 * done) / c.total : 0) + '%';
        const active = c.status === 'running' || c.status === 'queued';
        // Keep polling while sending, and a little after for delivered/read updates.
        if (active || Date.now() - new Date(c.finishedAt || 0) < 20000) el._watch = setTimeout(tick, 2000);
        else if (el._orbs?.length) { el._orbs.forEach((o) => o.destroy()); el._orbs = []; const w = $('.pc-wait svg', el); if (w) w.outerHTML = icon('check-one', 14); }
      } catch {
        el._watch = setTimeout(tick, 4000);
      }
    };
    tick();
  }

  // --- Data preview window ---------------------------------------------------------

  function openPreview(localId, plan = null) {
    const f = AS.files.get(localId);
    if (!f) return;
    AS.preview = { fileId: localId, filter: 'all', search: '', plan };
    $('#fpSearch').value = '';
    renderPreview();
    $('#filePreview').classList.remove('hidden');
    Motion.segs($('#filePreview'));
  }
  const closePreview = () => hideOverlay($('#filePreview'));
  $('#fpClose').addEventListener('click', closePreview);
  $('#filePreview').addEventListener('click', (e) => e.target.id === 'filePreview' && closePreview());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('#filePreview').classList.contains('hidden') && closePreview());

  function renderPreview() {
    const f = AS.files.get(AS.preview.fileId);
    const { filter, search, plan } = AS.preview;
    $('#fpTitle').innerHTML = `${icon('file-spreadsheet', 18)} ${esc(f.file)}`;
    $('#fpSub').textContent = `${f.sheet ? `Sheet “${f.sheet}” · ` : ''}${plural(f.rows.length, 'row')} · ${plural(f.headers.length, 'column')}`;

    // File tabs when several are attached to this conversation.
    const all = [...AS.files.values()];
    $('#fpTabs').innerHTML = all.length > 1 ? all.map((x) => `<button type="button" class="fp-tab ${x.localId === f.localId ? 'active' : ''}" data-fp-file="${x.localId}">${esc(x.name)}</button>`).join('') : '';
    $('#fpTabs').classList.toggle('hidden', all.length < 2);

    const c = f.counts;
    $('#fpStats').innerHTML = `
      <span class="fp-stat"><b>${f.rows.length.toLocaleString()}</b> rows</span>
      <span class="fp-stat good"><b>${c.valid.toLocaleString()}</b> valid numbers</span>
      <span class="fp-stat ${c.invalid ? 'bad' : ''}"><b>${c.invalid.toLocaleString()}</b> invalid</span>
      <span class="fp-stat ${c.duplicate ? 'warn' : ''}"><b>${c.duplicate.toLocaleString()}</b> duplicates</span>`;

    $('#fpPhone').innerHTML = f.headers.map((h) => `<option ${h === f.phoneColumn ? 'selected' : ''}>${esc(h)}</option>`).join('');
    // Same hints as the Send page: shifted rows, and numbers that seem to be in another column.
    const hints = [];
    if (f.autoFixed) hints.push(`<span class="fp-hint ok">${icon('circle-check', 14)} ${f.autoFixed === 1 ? '1 shifted row was' : `${f.autoFixed.toLocaleString()} shifted rows were`} moved back under the right columns.</span>`);
    const groups = shiftedIn(f), nShift = groups.reduce((n, g) => n + g.idx.length, 0);
    if (nShift) {
      const k = groups.length === 1 ? groups[0].k : null;
      const where = `the number is ${k ? `${k} column${k > 1 ? 's' : ''}` : 'a few columns'} to the right`;
      hints.push(f.fileId
        ? `<span class="fp-hint">${icon('badge-alert', 14)} ${plural(nShift, 'row')} look shifted (${where}). This file was already sent to the assistant, so attach it again to fix them.</span>`
        : `<button type="button" class="fp-hint" data-fp-fix>${icon('badge-alert', 14)} ${nShift === 1 ? '1 row looks' : `${nShift.toLocaleString()} rows look`} shifted: ${where}. <b>Fix ${nShift > 1 ? 'them' : 'it'}</b></button>`);
    }
    if (f.rows.length && c.valid / f.rows.length < 0.3) {
      const better = guessPhone(f.headers, f.rows);
      if (better && better !== f.phoneColumn) hints.push(`<button type="button" class="fp-hint" data-fp-use="${esc(better)}">${icon('phone', 14)} Numbers look like they're in “${esc(better)}”. <b>Use it</b></button>`);
    }
    $('#fpHints').innerHTML = hints.join('');
    $('#fpHints').classList.toggle('hidden', !hints.length);
    $$('#fpFilter button').forEach((b) => {
      b.classList.toggle('active', b.dataset.f === filter);
      const n = { all: f.rows.length, valid: c.valid, invalid: c.invalid, duplicate: c.duplicate }[b.dataset.f];
      $('.n', b).textContent = n.toLocaleString();
    });

    // Columns the plan uses get a label, so the person can see what goes where.
    const tags = {};
    tags[f.phoneColumn] = ['phone'];
    if (plan && plan.sources.some((x) => x.fileId === f.fileId)) {
      for (const v of plan.variables) {
        const m = plan.mapping[v.key];
        if (m.type === 'column') (tags[m.value] ||= []).push(v.label.replace(/^body /, ''));
      }
      if (plan.optIn) (tags[plan.optIn.column] ||= []).push('opt-in');
    }

    const q = search.toLowerCase();
    const idx = [];
    for (let i = 0; i < f.rows.length; i++) {
      if (filter !== 'all' && f.meta[i].status !== filter) continue;
      if (q && !f.headers.some((h) => String(f.rows[i][h]).toLowerCase().includes(q))) continue;
      idx.push(i);
    }
    const shown = idx.slice(0, PREVIEW_ROWS);
    const head = `<tr><th class="num">#</th><th>Check</th>${f.headers.map((h) => `<th class="${tags[h] ? 'tagged' : ''}">${esc(h)}${(tags[h] || []).map((t) => `<span class="col-tag ${t === 'phone' ? 'is-phone' : ''}">${t === 'phone' ? icon('phone', 11) : ''}${esc(t)}</span>`).join('')}</th>`).join('')}</tr>`;
    const body = shown.map((i) => {
      const m = f.meta[i];
      const why = m.status === 'invalid' ? 'Not a valid phone number' : m.status === 'duplicate' ? 'Same number appears earlier in the file' : fmtPhone(m.phone);
      return `<tr class="${m.status}"><td class="num">${i + 1}</td><td><span class="pill ${m.status}" title="${esc(why)}">${m.status}</span></td>${f.headers.map((h) => `<td class="${h === f.phoneColumn ? 'phone-col' : ''}">${esc(f.rows[i][h])}</td>`).join('')}</tr>`;
    }).join('');
    $('#fpTable').innerHTML = idx.length
      ? `<table class="data-table fp-data"><thead>${head}</thead><tbody>${body}</tbody></table>`
      : `<div class="fp-empty">No rows match.</div>`;
    $('#fpNote').textContent = idx.length > PREVIEW_ROWS ? `Showing the first ${PREVIEW_ROWS} of ${idx.length.toLocaleString()} rows. Search to find others.` : `${plural(idx.length, 'row')} shown.`;
    LA.hydrate($('#filePreview'));
  }

  $('#fpTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fp-file]');
    if (b) { AS.preview.fileId = b.dataset.fpFile; AS.preview.filter = 'all'; renderPreview(); }
  });
  $('#fpFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (b) { AS.preview.filter = b.dataset.f; renderPreview(); }
  });
  let fpDebounce;
  $('#fpSearch').addEventListener('input', (e) => {
    clearTimeout(fpDebounce);
    fpDebounce = setTimeout(() => { AS.preview.search = e.target.value.trim(); renderPreview(); }, 150);
  });
  $('#fpHints').addEventListener('click', (e) => {
    const f = AS.files.get(AS.preview.fileId);
    if (e.target.closest('[data-fp-fix]')) {
      const before = f.counts.invalid;
      fixShifted(f);
      renderPreview();
      renderPending();
      toast(`Fixed: ${(before - f.counts.invalid).toLocaleString()} more valid numbers`);
    }
    const use = e.target.closest('[data-fp-use]');
    if (use) { $('#fpPhone').value = use.dataset.fpUse; $('#fpPhone').dispatchEvent(new Event('change')); }
  });
  $('#fpPhone').addEventListener('change', async (e) => {
    const f = AS.files.get(AS.preview.fileId);
    f.phoneColumn = e.target.value;
    check(f);
    renderPreview();
    renderPending();
    // Already sent: tell the server, and the assistant hears about it on the next message.
    if (f.fileId) await guard(() => api(`/ai/files/${f.fileId}`, { method: 'PUT', body: { sessionId: AS.sessionId, phoneColumn: f.phoneColumn } }));
  });


  // --- Wiring ------------------------------------------------------------------------

  Orb.mount($('#asHeroOrb'), { state: 'base', size: 36 });
  greet();
  renderSenderPick();
  autosize();
  syncSend();

  window.Assistant = {
    senders: renderSenderPick,
    show() {
      fit();
      input.focus({ preventScroll: true });
    },
  };

  // --- Chat history ------------------------------------------------------------------
  // Every chat is saved on the server. The panel lists them by day; opening one replays its
  // transcript and you can carry on (attached files aren't kept, so re-attach if needed).

  const HIST = { list: [], q: '', open: (() => { try { const v = localStorage.getItem('asHistory'); return v == null ? innerWidth >= 1200 : v === '1'; } catch { return innerWidth >= 1200; } })() };

  async function loadHistory() {
    HIST.list = await api('/ai/chats').catch(() => HIST.list);
    renderHistory();
  }

  // How many messages you sent. (Servers started before this field existed send the total instead.)
  const turnsText = (c) => {
    const n = c.turns ?? Math.ceil((c.messages || 0) / 2);
    return `${n} message${n === 1 ? '' : 's'}`;
  };

  // "10:42 AM" today, "Mon" this week, "12 Oct" before that.
  function shortWhen(ts) {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    if (now - d < 6 * 86400000) return d.toLocaleDateString('en-IN', { weekday: 'short' });
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  function histGroup(ts) {
    const d = new Date(ts), now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((day(now) - day(d)) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return 'Previous 7 days';
    if (days < 30) return 'Previous 30 days';
    return d.toLocaleDateString('en-IN', { month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }

  function renderHistory() {
    const q = HIST.q.toLowerCase();
    const list = HIST.list.filter((c) => !q || c.title.toLowerCase().includes(q));
    const groups = new Map();
    for (const c of list) { const g = histGroup(c.updatedAt); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
    $('#ashItems').innerHTML = list.length
      ? [...groups].map(([g, items]) => `<div class="ash-group"><h4>${esc(g)}</h4>${items.map((c) => `<div class="ash-item ${c.id === AS.chatId ? 'on' : ''}" data-chat="${c.id}" role="button" tabindex="0" title="${esc(c.title)}">
          <span class="ash-main"><span class="ash-top"><b>${esc(c.title)}</b><time>${esc(shortWhen(c.updatedAt))}</time></span>
          <span class="ash-sub">${esc(c.preview || turnsText(c))}</span></span>
          <button type="button" class="ash-more" data-chat-menu="${c.id}" aria-label="More for ${esc(c.title)}">⋯</button>
        </div>`).join('')}</div>`).join('')
      : `<div class="ash-empty">${icon(HIST.list.length ? 'search' : 'message-circle', 22)}<p>${HIST.list.length ? 'No chats match that search.' : 'Your conversations with the assistant will be saved here.'}</p></div>`;
    $('#ashCount').textContent = HIST.list.length ? HIST.list.length.toLocaleString() : '';
    LA.hydrate($('#ashItems'));
    placeHighlight();
  }

  // One highlight behind the list that slides to the open chat (the rows are re-rendered, it isn't).
  $('#ashList').innerHTML = `<i class="ash-hl" aria-hidden="true"></i><div id="ashItems">${Skel.rows(6, false)}</div>`;
  function placeHighlight() {
    const hl = $('#ashList .ash-hl'), on = $('#ashItems .ash-item.on');
    if (!on) { hl.style.opacity = '0'; return; }
    const snap = hl.style.opacity !== '1' || Motion.reduce();
    if (snap) hl.style.transition = 'none';
    // Layout position (offsets, unaffected by rows sliding in). The items box is a flow root, so the
    // first day heading's margin stays inside it and the two offsets add up exactly.
    hl.style.transform = `translateY(${on.offsetTop + $('#ashItems').offsetTop}px)`;
    hl.style.height = on.offsetHeight + 'px';
    hl.style.opacity = '1';
    if (snap) { hl.getBoundingClientRect(); hl.style.transition = ''; }
  }

  // Opening or closing the list changes the layout once, then everything glides from where it
  // was (transform-only animations, so the conversation never re-wraps mid-animation).
  const EASE = 'cubic-bezier(0.65, 0, 0.35, 1)', EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)', EASE_IN = 'cubic-bezier(0.55, 0, 0.75, 0.3)';
  function setHistoryOpen(open, animate = true) {
    HIST.open = open;
    try { localStorage.setItem('asHistory', open ? '1' : '0'); } catch {}
    $('#asHistToggle').setAttribute('aria-expanded', String(open));
    const tab = $('#tab-assistant'), panel = $('#asHistory');
    const wide = innerWidth > 900;
    if (!animate || !wide || Motion.reduce() || tab.classList.contains('hidden')) { tab.classList.toggle('hist-open', open); return; }
    panel.getAnimations().forEach((a) => a.finish());
    // Things in the conversation that move when the list takes (or gives back) its space.
    const movers = ['.as-head-right', '#asHero', '#asThread', '#composer', '.cmp-note'].map((q) => $(q, tab)).filter((el) => el?.offsetParent);
    const before = movers.map((el) => el.getBoundingClientRect());
    const glide = () => movers.forEach((el, i) => {
      const a = before[i], b = el.getBoundingClientRect();
      // The header buttons hug the right edge; everything else is centred.
      const dx = el.matches('.as-head-right') ? a.right - b.right : a.left + a.width / 2 - (b.left + b.width / 2);
      if (Math.abs(dx) > 0.5) el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 520, easing: EASE });
    });
    if (open) {
      tab.classList.add('hist-open');
      glide();
      panel.animate([{ transform: 'translateX(48px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 520, easing: EASE_OUT });
      [...$$('#ashItems h4, #ashItems .ash-item', panel)].slice(0, 16).forEach((el, i) =>
        el.animate([{ opacity: 0, transform: 'translateX(18px)' }, { opacity: 1, transform: 'none' }], { duration: 440, delay: 90 + i * 30, easing: EASE_OUT, fill: 'backwards' }));
    } else {
      // Keep the list on screen, pinned where it was, while it slides away.
      const r = panel.getBoundingClientRect();
      Object.assign(panel.style, { position: 'absolute', top: '0', bottom: '0', right: '0', width: r.width + 'px', opacity: '1', zIndex: '3' });
      tab.classList.remove('hist-open');
      glide();
      panel.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateX(56px)', opacity: 0 }], { duration: 360, easing: EASE_IN }).finished
        .catch(() => {}).finally(() => { if (!HIST.open) panel.removeAttribute('style'); });
    }
  }
  setHistoryOpen(HIST.open, false);
  // Rows wrap differently while the list is hidden, so measure the highlight again whenever it resizes.
  new ResizeObserver(() => placeHighlight()).observe($('#ashItems'));
  $('#asHistToggle').addEventListener('click', () => setHistoryOpen(!HIST.open));
  $('#ashNew').addEventListener('click', () => { $('#asNew').click(); if (innerWidth < 900) setHistoryOpen(false); });
  $('#ashSearch').addEventListener('input', (e) => { HIST.q = e.target.value.trim(); renderHistory(); });

  async function confirmLeave() {
    if (AS.busy) return false;
    if ([...AS.openPlans.values()].some((p) => p.plan.status === 'pending')) {
      return confirmDialog({ title: 'Leave this chat?', message: 'The plan waiting for approval stays in this chat, but it may expire. Nothing has been sent.', confirmText: 'Open chat' });
    }
    return true;
  }

  // Replay a saved chat with the same cards a live reply uses.
  async function openChat(cid) {
    if (cid === AS.chatId || !(await confirmLeave())) return;
    let chat;
    try { chat = await api('/ai/chats/' + cid); } catch (e) { toast(e.message, 'error'); return loadHistory(); }
    // The old conversation slides out and this one slides in; the list highlight glides across.
    await Motion.morph(() => replay(chat), 'as');
    $('#asThread').scrollTop = $('#asThread').scrollHeight;
    if (innerWidth < 900) setHistoryOpen(false);
    input.focus();
  }

  function replay(chat) {
    reset({ keepList: true });
    AS.chatId = AS.sessionId = chat.id;
    setTitle(chat.title);
    setActive(true);
    const thread = $('#asThread');
    thread.classList.add('replay'); // no per-message entrance animations when replaying
    const msgs = chat.messages;
    msgs.forEach((m, i) => {
      if (m.role === 'user') {
        const files = (m.files || []).map((f) => `<span class="file-chip static">${icon('file-spreadsheet', 16)}<span class="fc-text"><span class="fc-name">${esc(f.sheet ? `${f.name} · ${f.sheet}` : f.name)}</span><span class="fc-meta">${(f.rows || 0).toLocaleString()} rows</span></span></span>`).join('');
        thread.insertAdjacentHTML('beforeend', `<div class="msg-user">${files ? `<div class="mu-files">${files}</div>` : ''}${m.text ? `<div class="mu-bubble">${esc(m.text)}</div>` : ''}</div>`);
        return;
      }
      const el = document.createElement('div');
      el.className = 'msg-ai done';
      el.innerHTML = '<div class="ai-main"><div class="ai-body"></div></div>';
      thread.append(el);
      const body = $('.ai-body', el);
      const add = (html) => { body.insertAdjacentHTML('beforeend', html); const n = body.lastElementChild; LA.hydrate(n); Orb.hydrate(n); return n; };
      for (const it of m.items || []) {
        if (it.type === 'text') add(`<div class="ai-text">${md(it.text)}</div>`);
        else if (it.type === 'error') add(`<div class="ai-note warn">${icon('badge-alert', 16)}<div>${esc(it.text)}</div></div>`);
        else if (it.type === 'stats') { add(statsHtml(it.stats)); Motion.values(el); }
        else if (it.type === 'sheet') { supersede(it.sheet.replaces); add(sheetHtml(it.sheet)); }
        else if (it.type === 'plan') { const pel = add('<div class="plan-card"></div>'); AS.openPlans.set(it.plan.id, { el: pel, plan: it.plan }); renderPlan(pel, it.plan); }
        else if (it.type === 'question') {
          const qel = add(questionHtml(it));
          const next = msgs[i + 1];
          // Only a question in the very last reply can still be answered.
          if (!next) AS.openQuestion = { el: qel, orb: orb($('.q-head svg', qel), 'waiting', 16) };
          else resolveQuestion(qel, it.options.some((o) => o.label === next.text) ? next.text : null, next.text || '');
        }
      }
    });
    if (!chat.continuable) thread.insertAdjacentHTML('beforeend', `<div class="ai-note">${icon('history', 16)}<div>This chat was too long to save in full. You can read it, but start a new chat to continue.</div></div>`);
    LA.hydrate(thread);
    thread.scrollTop = thread.scrollHeight;
    renderHistory();
  }

  $('#ashList').addEventListener('click', (e) => {
    const more = e.target.closest('[data-chat-menu]');
    if (more) {
      e.stopPropagation();
      const c = HIST.list.find((x) => x.id === more.dataset.chatMenu);
      const r = more.getBoundingClientRect();
      Sheet.Menu.open(r.left, r.bottom + 4, [
        { label: 'Rename', action: () => renameChat(c) },
        { label: 'Delete', action: () => deleteChat(c) },
      ]);
      return;
    }
    const item = e.target.closest('[data-chat]');
    if (item) openChat(item.dataset.chat);
  });
  $('#ashList').addEventListener('keydown', (e) => {
    const item = e.target.closest('[data-chat]');
    if (item && e.target === item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openChat(item.dataset.chat); }
  });

  function renameChat(c) {
    const body = openModal('Rename chat', `<label>Name<input id="ashName" maxlength="100" value="${esc(c.title)}" /></label>
      <div class="modal-actions"><button class="btn quiet" id="ashCancel">Cancel</button><button class="btn primary" id="ashSave">Save</button></div>`);
    const inp = $('#ashName', body);
    inp.focus();
    inp.select();
    $('#ashCancel', body).onclick = closeModal;
    const go = () => guard(async () => {
      const r = await api('/ai/chats/' + c.id, { method: 'PATCH', body: { title: inp.value } });
      if (AS.chatId === c.id) setTitle(r.title);
      closeModal();
      loadHistory();
    });
    $('#ashSave', body).onclick = go;
    inp.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  }

  async function deleteChat(c) {
    if (!(await confirmDialog({ title: 'Delete this chat?', message: `“${esc(c.title)}” will be removed from your history. Campaigns it created aren’t affected.`, confirmText: 'Delete', danger: true }))) return;
    await guard(async () => {
      await api('/ai/chats/' + c.id, { method: 'DELETE' });
      if (AS.chatId === c.id) Motion.morph(reset, 'as');
      loadHistory();
    });
  }

  loadHistory();
})();
