// Every <select> in the app opens the app's own list instead of the system one: the same look as the
// Default country picker (floating card, tick on the current choice, search when the list is long).
// The <select> stays the source of truth: picking sets its value and fires 'change', so page code is
// unchanged. Phones and tablets keep the native picker, which suits a thumb better.
(() => {
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch) return;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TICK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const SEARCH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
  const SEARCH_FROM = 9; // options before a search box appears

  function open(sel) {
    if (sel.disabled || !window.Sheet) return;
    const r = sel.getBoundingClientRect();
    const items = [];
    for (const node of sel.children) {
      if (node.tagName === 'OPTGROUP') { items.push({ group: node.label }); for (const o of node.children) items.push({ o }); }
      else if (node.tagName === 'OPTION' && !node.hidden) items.push({ o: node });
    }
    const opts = items.filter((x) => x.o);
    // <select data-chips> with options tagged data-tag="…": a row of filter chips (All, then each tag with its count).
    const tags = 'chips' in sel.dataset ? [...new Set(opts.map((x) => x.o.dataset.tag).filter(Boolean))] : [];
    let tag = '';
    const chips = tags.length > 1 ? `<div class="ss-chips" role="tablist">${['', ...tags].map((t) => `<button type="button" class="ss-chip ${t ? '' : 'on'}" data-tag="${esc(t)}">${esc(t || 'All')} <span>${opts.filter((x) => (t ? x.o.dataset.tag === t : x.o.dataset.tag)).length}</span></button>`).join('')}</div>` : '';
    const searchBox = opts.length >= SEARCH_FROM || chips ? `<div class="search-wrap ss-search">${SEARCH}<input class="search" placeholder="Search" autocomplete="off" aria-label="Search options" /></div>` : '';
    const el = Sheet.Menu.panel(r.left, r.bottom + 6, `${searchBox}${chips}<div class="ss-list" role="listbox"></div>`);
    el.classList.add('ss-pop');
    el.style.minWidth = Math.max(180, r.width) + 'px';
    const list = el.querySelector('.ss-list'), q = el.querySelector('.ss-search input');
    const draw = () => {
      const term = (q?.value || '').trim().toLowerCase();
      // Groups (<optgroup>) are sections: a heading with how many of its options are showing, pinned while you
      // scroll through it, and a line between one section and the next.
      const shown = (o) => !(term && !o.textContent.toLowerCase().includes(term)) && !(tag && o.dataset.tag !== tag);
      const counts = [];
      for (const it of items) { if (it.group != null) counts.push(0); else if (counts.length && shown(it.o)) counts[counts.length - 1]++; }
      let html = '', pendingGroup = null, gi = -1;
      for (const it of items) {
        if (it.group != null) { pendingGroup = it.group; gi++; continue; }
        const o = it.o;
        if (!shown(o)) continue;
        if (pendingGroup != null) { html += `<div class="ss-group"><span>${esc(pendingGroup)}</span><small>${counts[gi]}</small></div>`; pendingGroup = null; }
        const on = o.selected;
        // Options can carry a small picture: data-photo (an image URL) with data-letter as its fallback, or data-icon.
        const d = o.dataset;
        const pic = d.photo != null || d.letter != null || d.icon
          ? `<span class="ss-av">${d.icon ? window.LA?.icon(d.icon, 14) || '' : `${d.photo ? `<img src="${esc(d.photo)}" alt="" onerror="this.remove()">` : ''}<b>${esc(d.letter || '')}</b>`}</span>`
          : '';
        html += `<button type="button" role="option" class="ss-opt ${on ? 'on' : ''} ${pic ? 'has-av' : ''}" data-i="${o.index}" aria-selected="${on}" ${o.disabled ? 'disabled' : ''}><i class="ss-check">${on ? TICK : ''}</i>${pic}<span>${esc(o.textContent)}</span>${d.count ? `<small class="ss-count">${esc(d.count)}</small>` : ''}</button>`;
      }
      list.innerHTML = html || '<p class="ss-none">Nothing matches.</p>';
    };
    draw();
    // Keep it on screen: open upward when there's no room below.
    const h = el.offsetHeight;
    if (r.bottom + 6 + h > innerHeight - 8 && r.top - 6 - h > 8) el.style.top = r.top - 6 - h + 'px';
    const on = list.querySelector('.ss-opt.on');
    if (on) list.scrollTop = on.offsetTop - list.clientHeight / 2 + on.offsetHeight / 2;
    (q || on || list.querySelector('.ss-opt'))?.focus({ preventScroll: true });
    const pick = (i) => {
      Sheet.Menu.close();
      if (sel.selectedIndex !== i) {
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      sel.focus({ preventScroll: true });
    };
    list.addEventListener('click', (e) => { const b = e.target.closest('.ss-opt'); if (b && !b.disabled) pick(Number(b.dataset.i)); });
    q?.addEventListener('input', draw);
    el.querySelector('.ss-chips')?.addEventListener('click', (e) => {
      const c = e.target.closest('.ss-chip');
      if (!c) return;
      tag = c.dataset.tag;
      el.querySelectorAll('.ss-chip').forEach((x) => x.classList.toggle('on', x === c));
      draw();
      q?.focus({ preventScroll: true });
    });
    el.addEventListener('keydown', (e) => {
      const btns = [...list.querySelectorAll('.ss-opt:not(:disabled)')], i = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); btns[Math.min(btns.length - 1, i + 1)]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); if (i <= 0 && q) q.focus(); else btns[Math.max(0, i - 1)]?.focus(); }
      else if (e.key === 'Enter' && document.activeElement === q) { e.preventDefault(); btns[0]?.click(); }
      else if (e.key === 'Escape') sel.focus({ preventScroll: true });
    }, true);
  }

  // Open ours instead of the system list: on a mouse press, or Space / Enter / Alt+Down from the keyboard.
  // (On window, so it runs before the menu's own outside-click close and can tell an open list apart.)
  addEventListener('mousedown', (e) => {
    const sel = e.target.closest?.('select');
    if (!sel || sel.multiple || sel.size > 1 || e.button !== 0) return;
    e.preventDefault();
    if (document.querySelector('.ss-pop') && open.last === sel) { Sheet.Menu.close(); open.last = null; return; } // second click closes
    sel.focus({ preventScroll: true });
    open.last = sel;
    setTimeout(() => open(sel)); // after this press has finished (it would count as a click outside and close the list)
  }, true);
  document.addEventListener('keydown', (e) => {
    const sel = e.target;
    if (!(sel instanceof HTMLSelectElement) || sel.multiple) return;
    if (e.key === ' ' || e.key === 'Enter' || (e.altKey && e.key === 'ArrowDown')) { e.preventDefault(); open.last = sel; open(sel); }
  }, true);
})();

// --- Date & time (input type=datetime-local) and suggestion lists (input list=…) ---------------------
// The same idea as the dropdowns: the input stays the source of truth (value, 'input'/'change' events),
// the app shows its own picker. Unlike dropdowns these are used on phones too, so they apply everywhere.
(() => {
  const TICK2 = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const toLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const parse = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d : null; };
  const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const fmt = (d) => d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const rel = (d) => { const m = Math.round((d - Date.now()) / 60000); return m < 60 ? `in ${Math.max(1, m)} min` : m < 1440 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} day${Math.round(m / 1440) === 1 ? '' : 's'}`; };
  const CAL = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>';
  const fire = (inp) => { inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); };

  function enhanceDate(inp) {
    if (inp._dt) return;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'dt-pick';
    inp.after(btn); inp.classList.add('dt-native'); inp._dt = btn;
    const label = () => { const d = parse(inp.value); btn.innerHTML = `${CAL}<span>${d ? esc(fmt(d)) : 'Pick a date and time'}</span>${d && d > Date.now() ? `<small>${esc(rel(d))}</small>` : ''}`; };
    // follow the input: shown when it's shown, relabelled when the page sets a value
    const sync = () => { btn.classList.toggle('hidden', inp.classList.contains('hidden')); label(); };
    new MutationObserver(sync).observe(inp, { attributes: true, attributeFilter: ['class', 'value', 'min'] });
    inp.addEventListener('input', label);
    sync();
    btn.addEventListener('click', () => openDate(inp, btn));
  }

  // The schedule picker: the month (click its name for a month / year grid), a time you can type or nudge (↑/↓,
  // the wheel, or the small arrows; AM/PM where the locale uses it), quick picks, and Now. Every change applies to the
  // input straight away; a time that has already passed is said so in the footer (Send checks it again).
  const CLOCK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const CHEV = (rot) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="transform:rotate(${rot}deg)"><path d="m6 9 6 6 6-6"/></svg>`;
  function openDate(inp, btn) {
    const min = parse(inp.min) || null;
    let sel = parse(inp.value) || (() => { const d = new Date(Date.now() + 3600e3); d.setMinutes(0, 0, 0); return d; })();
    let view = new Date(sel.getFullYear(), sel.getMonth(), 1), picking = 'days';
    const h12 = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 !== false;
    const r = btn.getBoundingClientRect();
    const el = Sheet.Menu.panel(r.left, r.bottom + 6, `<div class="dt-body sch-body">
      <div class="dt-quick"></div>
      <div class="sch-cal"></div>
      <div class="sch-clock">
        <span class="sch-clock-ic">${CLOCK}</span>
        <span class="sch-field"><input class="sch-hh" inputmode="numeric" maxlength="2" aria-label="Hour" autocomplete="off" /><span class="sch-step"><button type="button" data-step="h" data-by="1" tabindex="-1" aria-label="Later hour">${CHEV(180)}</button><button type="button" data-step="h" data-by="-1" tabindex="-1" aria-label="Earlier hour">${CHEV(0)}</button></span></span>
        <b class="sch-colon">:</b>
        <span class="sch-field"><input class="sch-mm" inputmode="numeric" maxlength="2" aria-label="Minutes" autocomplete="off" /><span class="sch-step"><button type="button" data-step="m" data-by="1" tabindex="-1" aria-label="Later minute">${CHEV(180)}</button><button type="button" data-step="m" data-by="-1" tabindex="-1" aria-label="Earlier minute">${CHEV(0)}</button></span></span>
        ${h12 ? '<div class="seg seg-sm sch-ampm" role="radiogroup" aria-label="AM or PM"><button type="button" data-ap="am">AM</button><button type="button" data-ap="pm">PM</button></div>' : ''}
        <button type="button" class="btn sm quiet sch-now" data-now>Now</button>
      </div>
      <div class="dt-foot"><span class="sch-sum"></span><button type="button" class="btn sm primary" data-done>Done</button></div>
    </div>`);
    el.classList.add('dt-pop', 'sch-pop');
    const hh = el.querySelector('.sch-hh'), mm = el.querySelector('.sch-mm');
    // apply a date: from the calendar or quick picks it can't be before the earliest allowed; typed times aren't moved
    const set = (d, clamp = true) => { if (clamp && min && d < min) d = new Date(min); sel = d; inp.value = toLocal(sel); fire(inp); drawCal(); syncClock(); };
    const quick = () => {
      const at = (days, h) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d; };
      const hour = new Date(Date.now() + 3600e3); hour.setMinutes(Math.ceil(hour.getMinutes() / 15) * 15, 0, 0);
      const mon = at((8 - new Date().getDay()) % 7 || 7, 10);
      return [['In 1 hour', hour], ...(new Date().getHours() < 18 ? [['This evening, 7 PM', at(0, 19)]] : []), ['Tomorrow, 10 AM', at(1, 10)], ['Monday, 10 AM', mon]];
    };
    el.querySelector('.dt-quick').innerHTML = quick().map(([l], i) => `<button type="button" class="dt-chip" data-q="${i}">${esc(l)}</button>`).join('');
    const minDay = min && new Date(min.getFullYear(), min.getMonth(), min.getDate());
    function drawCal() {
      const box = el.querySelector('.sch-cal');
      if (picking === 'months') {
        const y = view.getFullYear(), now = new Date();
        const months = [...Array(12)].map((_, m) => {
          const off = minDay && new Date(y, m + 1, 0) < minDay;
          const on = y === sel.getFullYear() && m === sel.getMonth(), cur = y === now.getFullYear() && m === now.getMonth();
          return `<button type="button" class="sch-month ${on ? 'on' : ''} ${cur ? 'today' : ''}" data-month="${m}" ${off ? 'disabled' : ''}>${esc(new Date(y, m, 1).toLocaleDateString(undefined, { month: 'short' }))}</button>`;
        }).join('');
        const prevOff = minDay && y - 1 < minDay.getFullYear();
        box.innerHTML = `<div class="dt-head"><button type="button" class="dt-nav" data-year="-1" aria-label="Previous year" ${prevOff ? 'disabled' : ''}>${CHEV(90)}</button><button type="button" class="sch-title" data-pick="days" aria-label="Back to the days">${y}${CHEV(180)}</button><button type="button" class="dt-nav" data-year="1" aria-label="Next year">${CHEV(-90)}</button></div><div class="sch-months">${months}</div>`;
        return;
      }
      const today = new Date(), first = view.getDay(), days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
      const weeks = Math.ceil((first + days) / 7);
      let cells = '';
      for (let i = 0; i < weeks * 7; i++) {
        const day = new Date(view.getFullYear(), view.getMonth(), 1 - first + i), out = day.getMonth() !== view.getMonth();
        if (out) { cells += `<span class="sch-cell out"><span class="dt-day">${day.getDate()}</span></span>`; continue; }
        const off = minDay && day < minDay;
        cells += `<span class="sch-cell"><button type="button" class="dt-day ${sameDay(day, sel) ? 'on' : ''} ${sameDay(day, today) ? 'today' : ''}" data-d="${day.getDate()}" ${off ? 'disabled' : ''}>${day.getDate()}</button></span>`;
      }
      const prevOff = minDay && new Date(view.getFullYear(), view.getMonth(), 0) < minDay;
      box.innerHTML = `<div class="dt-head"><button type="button" class="dt-nav" data-nav="-1" aria-label="Previous month" ${prevOff ? 'disabled' : ''}>${CHEV(90)}</button><button type="button" class="sch-title" data-pick="months" aria-label="Choose the month and year">${esc(view.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}${CHEV(0)}</button><button type="button" class="dt-nav" data-nav="1" aria-label="Next month">${CHEV(-90)}</button></div>
        <div class="dt-week">${[...Array(7)].map((_, i) => `<span>${esc(new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2))}</span>`).join('')}</div>
        <div class="dt-grid">${cells}</div>`;
    }
    function syncClock() {
      const h = sel.getHours(), m = sel.getMinutes();
      if (document.activeElement !== hh) hh.value = h12 ? String(h % 12 || 12) : pad(h);
      if (document.activeElement !== mm) mm.value = pad(m);
      el.querySelectorAll('[data-ap]').forEach((b) => { const on = (b.dataset.ap === 'pm') === (h >= 12); b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); });
      if (h12) Motion?.segs?.(el);
      const past = sel < (min || new Date());
      const sum = el.querySelector('.sch-sum');
      sum.classList.toggle('bad', past);
      sum.innerHTML = past ? `<b>${esc(fmt(sel))}</b> has already passed: pick a later time` : `Sends <b>${esc(fmt(sel))}</b> · ${esc(rel(sel))}`;
    }
    // typed hour / minute: applied as soon as it's a real one
    const typedHour = (v) => { const n = Number(v); if (!/^\d{1,2}$/.test(v)) return null; if (h12) return n >= 1 && n <= 12 ? (n % 12) + (sel.getHours() >= 12 ? 12 : 0) : null; return n <= 23 ? n : null; };
    hh.addEventListener('input', () => {
      hh.value = hh.value.replace(/\D/g, '');
      const h = typedHour(hh.value);
      if (h == null) return;
      const d = new Date(sel); d.setHours(h); set(d, false);
      // two digits, or one that can't start a longer hour: on to the minutes
      if (hh.value.length === 2 || Number(hh.value) > (h12 ? 1 : 2)) { mm.focus(); mm.select(); }
    });
    mm.addEventListener('input', () => {
      mm.value = mm.value.replace(/\D/g, '');
      const n = Number(mm.value);
      if (!/^\d{1,2}$/.test(mm.value) || n > 59) return;
      const d = new Date(sel); d.setMinutes(n, 0, 0); set(d, false);
    });
    const nudge = (part, by) => { const d = new Date(sel); if (part === 'h') d.setHours(d.getHours() + by); else d.setMinutes(d.getMinutes() + by, 0, 0); view = new Date(d.getFullYear(), d.getMonth(), 1); set(d, false); };
    for (const [f, part] of [[hh, 'h'], [mm, 'm']]) {
      f.addEventListener('focus', () => f.select());
      f.addEventListener('blur', () => setTimeout(syncClock)); // tidy (05, 12…)
      f.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudge(part, (e.key === 'ArrowUp' ? 1 : -1) * (part === 'm' && e.shiftKey ? 5 : 1)); f.value = part === 'h' ? (h12 ? String(sel.getHours() % 12 || 12) : pad(sel.getHours())) : pad(sel.getMinutes()); f.select(); }
        else if (e.key === 'Enter') { e.preventDefault(); Sheet.Menu.close(); btn.focus({ preventScroll: true }); }
        else if (e.key === ':' && f === hh) { e.preventDefault(); mm.focus(); }
      });
      f.parentElement.addEventListener('wheel', (e) => { e.preventDefault(); nudge(part, e.deltaY < 0 ? 1 : -1); }, { passive: false });
    }
    drawCal();
    syncClock();
    Sheet.Menu.fit(el, r); // above the button when there's no room below, held there by its bottom edge
    const swap = (to) => Sheet.Menu.morph(el, () => { picking = to; drawCal(); }, { zoom: to === 'months' ? 'out' : 'in', part: '.sch-cal' });
    el.addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t || t.disabled) return;
      if (t.dataset.nav) { view = new Date(view.getFullYear(), view.getMonth() + Number(t.dataset.nav), 1); drawCal(); }
      else if (t.dataset.year) { view = new Date(view.getFullYear() + Number(t.dataset.year), view.getMonth(), 1); drawCal(); }
      else if (t.dataset.pick) swap(t.dataset.pick);
      else if (t.dataset.month) { view = new Date(view.getFullYear(), Number(t.dataset.month), 1); swap('days'); }
      else if (t.dataset.d) { const d = new Date(sel); d.setFullYear(view.getFullYear(), view.getMonth(), Number(t.dataset.d)); set(d); }
      else if (t.dataset.step) nudge(t.dataset.step, Number(t.dataset.by));
      else if (t.dataset.ap) { const d = new Date(sel), pm = sel.getHours() >= 12; if ((t.dataset.ap === 'pm') !== pm) { d.setHours(d.getHours() + (pm ? -12 : 12)); set(d, false); } }
      else if ('now' in t.dataset) { const d = new Date(Date.now() + 60000); d.setSeconds(0, 0); view = new Date(d.getFullYear(), d.getMonth(), 1); picking = 'days'; set(d); }
      else if (t.dataset.q) { const d = quick()[Number(t.dataset.q)][1]; view = new Date(d.getFullYear(), d.getMonth(), 1); picking = 'days'; set(d); }
      else if ('done' in t.dataset) { Sheet.Menu.close(); btn.focus({ preventScroll: true }); }
    });
  }

  // Suggestions: <input list="…"> shows a styled list of the datalist's options; typing filters it.
  function enhanceList(inp) {
    const id = inp.getAttribute('list'); if (!id || inp._ls) return;
    inp._ls = true; inp.dataset.suggest = id; inp.removeAttribute('list'); inp.setAttribute('autocomplete', 'off');
    const show = () => {
      const dl = document.getElementById(id); if (!dl) return;
      const q = inp.value.trim().toLowerCase();
      const all = [...dl.options].map((o) => o.value).filter(Boolean);
      const list = all.filter((v) => !q || v.toLowerCase().includes(q) || all.includes(inp.value)); // full list when the value is already one of them
      if (!list.length) return Sheet.Menu.close();
      const r = inp.getBoundingClientRect();
      const el = Sheet.Menu.panel(r.left, r.bottom + 6, `<div class="ss-list">${list.map((v) => `<button type="button" class="ss-opt ${v === inp.value ? 'on' : ''}" data-v="${esc(v)}"><i class="ss-check">${v === inp.value ? TICK2 : ''}</i><span>${esc(v)}</span></button>`).join('')}</div>`);
      el.classList.add('ss-pop'); el.style.minWidth = r.width + 'px';
      el.addEventListener('mousedown', (e) => e.preventDefault()); // keep the focus in the input
      el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; inp.value = b.dataset.v; fire(inp); Sheet.Menu.close(); });
    };
    inp.addEventListener('focus', () => setTimeout(show));
    inp.addEventListener('input', (e) => { if (e.isTrusted) show(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') Sheet.Menu.close(); if (e.key === 'ArrowDown') { e.preventDefault(); document.querySelector('.ss-pop .ss-opt')?.focus(); } });
    inp.addEventListener('blur', () => setTimeout(() => { if (!document.activeElement?.closest?.('.ss-pop')) Sheet.Menu.close(); }, 120));
  }

  const scan = (root = document) => {
    root.querySelectorAll?.('input[type="datetime-local"]').forEach(enhanceDate);
    root.querySelectorAll?.('input[list]').forEach(enhanceList);
  };
  const start = () => { scan(); new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n.parentNode || n); }).observe(document.body, { childList: true, subtree: true }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
