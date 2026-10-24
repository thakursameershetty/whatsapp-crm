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
