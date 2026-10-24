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
    const el = Sheet.Menu.panel(r.left, r.bottom + 6, `${opts.length >= SEARCH_FROM ? `<div class="search-wrap ss-search">${SEARCH}<input class="search" placeholder="Search" autocomplete="off" aria-label="Search options" /></div>` : ''}<div class="ss-list" role="listbox"></div>`);
    el.classList.add('ss-pop');
    el.style.minWidth = Math.max(180, r.width) + 'px';
    const list = el.querySelector('.ss-list'), q = el.querySelector('.ss-search input');
    const draw = () => {
      const term = (q?.value || '').trim().toLowerCase();
      let html = '', pendingGroup = null;
      for (const it of items) {
        if (it.group != null) { pendingGroup = it.group; continue; }
        const o = it.o;
        if (term && !o.textContent.toLowerCase().includes(term)) continue;
        if (pendingGroup != null) { html += `<div class="ss-group">${esc(pendingGroup)}</div>`; pendingGroup = null; }
        const on = o.selected;
        html += `<button type="button" role="option" class="ss-opt ${on ? 'on' : ''}" data-i="${o.index}" aria-selected="${on}" ${o.disabled ? 'disabled' : ''}><span>${esc(o.textContent)}</span>${on ? TICK : ''}</button>`;
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

  function openDate(inp, btn) {
    const min = parse(inp.min) || null;
    let sel = parse(inp.value) || (() => { const d = new Date(Date.now() + 3600e3); d.setMinutes(0, 0, 0); return d; })();
    let view = new Date(sel.getFullYear(), sel.getMonth(), 1);
    const r = btn.getBoundingClientRect();
    const el = Sheet.Menu.panel(r.left, r.bottom + 6, '<div class="dt-body"></div>');
    el.classList.add('dt-pop');
    // every pick applies straight away (closing by clicking outside keeps it); Done just closes
    const set = (d) => { if (min && d < min) d = new Date(min); sel = d; inp.value = toLocal(sel); fire(inp); draw(); };
    const quick = () => {
      const at = (days, h) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d; };
      const hour = new Date(Date.now() + 3600e3); hour.setMinutes(Math.ceil(hour.getMinutes() / 15) * 15, 0, 0);
      const mon = at((8 - new Date().getDay()) % 7 || 7, 10);
      return [['In 1 hour', hour], ...(new Date().getHours() < 18 ? [['This evening, 7 PM', at(0, 19)]] : []), ['Tomorrow, 10 AM', at(1, 10)], ['Monday, 10 AM', mon]];
    };
    function draw() {
      const today = new Date(), first = view.getDay(), days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
      const minDay = min && new Date(min.getFullYear(), min.getMonth(), min.getDate());
      let cells = '';
      for (let i = 0; i < first; i++) cells += '<span></span>';
      for (let d = 1; d <= days; d++) {
        const day = new Date(view.getFullYear(), view.getMonth(), d), off = minDay && day < minDay;
        cells += `<button type="button" class="dt-day ${sameDay(day, sel) ? 'on' : ''} ${sameDay(day, today) ? 'today' : ''}" data-d="${d}" ${off ? 'disabled' : ''}>${d}</button>`;
      }
      let times = '';
      for (let m = 0; m < 1440; m += 15) {
        const t = new Date(sel); t.setHours(0, m, 0, 0);
        const off = min && t < min, on = sel.getHours() * 60 + sel.getMinutes() === m;
        times += `<button type="button" class="dt-time ${on ? 'on' : ''}" data-m="${m}" ${off ? 'disabled' : ''}>${esc(t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}</button>`;
      }
      const prevOff = minDay && new Date(view.getFullYear(), view.getMonth(), 0) < minDay;
      el.querySelector('.dt-body').innerHTML = `
        <div class="dt-quick">${quick().map(([l, d], i) => `<button type="button" class="dt-chip" data-q="${i}">${esc(l)}</button>`).join('')}</div>
        <div class="dt-main">
          <div class="dt-cal">
            <div class="dt-head"><button type="button" class="dt-nav" data-nav="-1" aria-label="Previous month" ${prevOff ? 'disabled' : ''}>‹</button><b>${esc(view.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</b><button type="button" class="dt-nav" data-nav="1" aria-label="Next month">›</button></div>
            <div class="dt-week">${[...Array(7)].map((_, i) => `<span>${esc(new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }))}</span>`).join('')}</div>
            <div class="dt-grid">${cells}</div>
          </div>
          <div class="dt-times">${times}</div>
        </div>
        <div class="dt-foot"><span>Sends <b>${esc(fmt(sel))}</b> · ${esc(rel(sel))}</span><button type="button" class="btn sm primary" data-done>Done</button></div>`;
      const on = el.querySelector('.dt-time.on'), col = el.querySelector('.dt-times');
      if (on) col.scrollTop = on.offsetTop - col.clientHeight / 2 + on.offsetHeight / 2;
    }
    draw();
    const h = el.offsetHeight;
    if (r.bottom + 6 + h > innerHeight - 8 && r.top - 6 - h > 8) el.style.top = r.top - 6 - h + 'px';
    el.style.left = Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, r.left)) + 'px';
    el.addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t || t.disabled) return;
      if (t.dataset.nav) { view = new Date(view.getFullYear(), view.getMonth() + Number(t.dataset.nav), 1); draw(); }
      else if (t.dataset.d) { const d = new Date(sel); d.setFullYear(view.getFullYear(), view.getMonth(), Number(t.dataset.d)); set(d); }
      else if (t.dataset.m) { const d = new Date(sel); d.setHours(0, Number(t.dataset.m), 0, 0); set(d); }
      else if (t.dataset.q) { const d = quick()[Number(t.dataset.q)][1]; view = new Date(d.getFullYear(), d.getMonth(), 1); set(d); }
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
      const el = Sheet.Menu.panel(r.left, r.bottom + 6, `<div class="ss-list">${list.map((v) => `<button type="button" class="ss-opt ${v === inp.value ? 'on' : ''}" data-v="${esc(v)}"><span>${esc(v)}</span></button>`).join('')}</div>`);
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
