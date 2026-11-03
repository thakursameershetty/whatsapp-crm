// A date filter: a calendar to pick several separate days, or a range from one day to another. Used by the Inbox (a
// chat's latest message) and Campaigns (when it was sent or scheduled). It looks like the scheduling picker (.dt-*).
//
//   DateFilter.button(value)            → the HTML of the toolbar button, labelled with the current choice
//   DateFilter.open(btn, { value, marks, sort, onChange, onSort })
//       value: null (any date), { days: ['2026-11-01', …] } or { from: '2026-11-01', to: '2026-11-07' }
//       marks: Map of 'YYYY-MM-DD' → how many things that day has (a dot under the date)
//       sort:  optional 'new' | 'old', shown as a Newest / Oldest switch; onSort(next) when it changes
//       onChange(next) runs on every pick, so the list behind updates as you choose
//   DateFilter.match(value, date)       → whether a date (Date or ISO string) passes
//
// Picking: a click picks that one day; ⌘/Ctrl-click adds or removes a day; Shift-click takes every day from the last one
// clicked to this one. (On a touch screen, with no keys, a tap adds or removes.) Range mode: first day, then last.
// Days after today can only be picked when something is on them (a scheduled campaign): there's nothing else to find.
window.DateFilter = (() => {
  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const short = (k) => fromKey(k).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const shift = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return keyOf(d); };

  const spanDays = (from, to) => { const out = []; for (let d = fromKey(from); keyOf(d) <= to; d.setDate(d.getDate() + 1)) out.push(keyOf(d)); return out; };
  const active = (v) => Boolean(v && ((v.days && v.days.length) || (v.from && v.to)));
  function match(v, date) {
    if (!active(v)) return true;
    if (!date) return false;
    const k = keyOf(date instanceof Date ? date : new Date(date));
    return v.days ? v.days.includes(k) : k >= v.from && k <= v.to;
  }
  function label(v) {
    if (!active(v)) return 'Any date';
    if (v.days) return v.days.length === 1 ? short(v.days[0]) : `${v.days.length} days`;
    return v.from === v.to ? short(v.from) : `${short(v.from)} – ${short(v.to)}`;
  }
  const button = (v, id = '') =>
    `<button type="button" class="df-btn ${active(v) ? 'on' : ''}" ${id ? `id="${id}"` : ''} aria-haspopup="dialog" title="Filter by date">${icon('calendar-days', 15)}<span>${esc(label(v))}</span>${active(v) ? `<i class="df-x" data-df-clear title="Clear the date" aria-label="Clear the date">${icon('x', 12)}</i>` : icon('chevron-down', 13)}</button>`;

  function open(btn, { value = null, marks = new Map(), sort = null, onChange = () => {}, onSort = () => {} } = {}) {
    let v = active(value) ? JSON.parse(JSON.stringify(value)) : null;
    const opened = v ? JSON.parse(JSON.stringify(v)) : null; // what Cancel puts back
    let mode = v?.from ? 'range' : 'days';
    let anchor = null, hover = null; // range: the first day picked, and the day under the pointer
    let last = null, touch = false;  // the day clicked last (for Shift-click), and whether that was a tap
    const today = keyOf(new Date());
    const future = (k) => k > today && !(marks.get(k) > 0); // later than today, with nothing on it
    const lastMark = [...marks.keys()].sort().at(-1) || today;
    const modKey = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
    const start = v ? fromKey(v.days ? v.days.slice().sort().at(-1) : v.to) : new Date();
    let view = new Date(start.getFullYear(), start.getMonth(), 1), picking = 'days'; // 'months': the month / year grid
    const maxKey = lastMark > today ? lastMark : today; // nothing to find after this (bar scheduled days)
    const r = btn.getBoundingClientRect();
    const el = Sheet.Menu.panel(r.left, r.bottom + 6, '<div class="dt-body df-body"></div>');
    el.classList.add('dt-pop', 'df-pop');
    const emit = () => onChange(active(v) ? v : null);
    const QUICK = [
      ['Today', () => ({ from: shift(0), to: shift(0) })],
      ['Yesterday', () => ({ from: shift(-1), to: shift(-1) })],
      ['Last 7 days', () => ({ from: shift(-6), to: shift(0) })],
      ['Last 30 days', () => ({ from: shift(-29), to: shift(0) })],
      ['This month', () => { const n = new Date(); return { from: keyOf(new Date(n.getFullYear(), n.getMonth(), 1)), to: shift(0) }; }],
    ];
    function inRange(k) {
      if (mode !== 'range') return false;
      const a = anchor || v?.from, b = anchor ? hover || anchor : v?.to;
      if (!a || !b) return false;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return k >= lo && k <= hi;
    }
    // Each day sits in a cell that can carry a band: a range is one continuous soft band with solid circles at its
    // two ends, and picked days next to each other join up the same way. The band rounds off at the ends of a week.
    function draw() {
      const first = view.getDay(), days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
      const weeks = Math.ceil((first + days) / 7);
      const isPicked = (k) => (mode === 'days' ? Boolean(v?.days?.includes(k)) : inRange(k));
      const lo0 = anchor || v?.from, hi0 = anchor ? hover || anchor : v?.to;
      const [lo, hi] = lo0 && hi0 && lo0 > hi0 ? [hi0, lo0] : [lo0, hi0];
      let cells = '';
      for (let i = 0; i < weeks * 7; i++) {
        const date = new Date(view.getFullYear(), view.getMonth(), 1 - first + i), k = keyOf(date), d = date.getDate();
        const col = i % 7, out = date.getMonth() !== view.getMonth();
        if (out) { cells += `<span class="df-cell out"><span class="dt-day df-day">${d}</span></span>`; continue; } // the next / last month, faded
        const picked = isPicked(k);
        const prev = keyOf(new Date(date.getFullYear(), date.getMonth(), d - 1)), next = keyOf(new Date(date.getFullYear(), date.getMonth(), d + 1));
        // joined to the day before / after (in the band)?
        const joinL = picked && col > 0 && isPicked(prev) && new Date(date.getFullYear(), date.getMonth(), d - 1).getMonth() === view.getMonth();
        const joinR = picked && col < 6 && isPicked(next) && new Date(date.getFullYear(), date.getMonth(), d + 1).getMonth() === view.getMonth();
        const end = picked && (mode === 'days' || k === lo || k === hi); // a solid circle
        const n = marks.get(k) || 0;
        cells += `<span class="df-cell${joinL ? ' jl' : ''}${joinR ? ' jr' : ''}"><button type="button" class="dt-day df-day ${picked ? (end ? 'on' : 'in') : ''} ${k === today ? 'today' : ''} ${n ? 'has' : ''}" data-k="${k}" title="${n ? `${n} on this day` : ''}" ${future(k) ? 'disabled' : ''}>${d}</button></span>`;
      }
      const hint = mode === 'range'
        ? anchor ? `From <b>${esc(short(anchor))}</b>: now pick the last day` : active(v) ? `<b>${esc(label(v))}</b>` : 'Pick the first day, then the last'
        : active(v) ? `<b>${esc(label(v))}</b>${v.days.length > 1 ? ` · ${esc(v.days.slice().sort().map(short).join(', '))}` : ''}` : `Click a day · <kbd>${modKey}</kbd> to add more · <kbd>⇧</kbd> for a range`;
      el.querySelector('.df-body').innerHTML = `
        <div class="df-top">
          <div class="seg seg-sm df-mode" role="radiogroup" aria-label="How to pick"><button type="button" data-mode="days" class="${mode === 'days' ? 'active' : ''}">Pick days</button><button type="button" data-mode="range" class="${mode === 'range' ? 'active' : ''}">Range</button></div>
          ${sort ? `<div class="seg seg-sm df-sort" role="radiogroup" aria-label="Order"><button type="button" data-sort="new" class="${sort === 'new' ? 'active' : ''}">Newest first</button><button type="button" data-sort="old" class="${sort === 'old' ? 'active' : ''}">Oldest first</button></div>` : ''}
        </div>
        <div class="dt-quick">${QUICK.map(([l], i) => `<button type="button" class="dt-chip" data-q="${i}">${esc(l)}</button>`).join('')}</div>
        <div class="dt-cal">
          ${picking === 'months' ? monthsHtml() : `<div class="dt-head"><button type="button" class="dt-nav" data-nav="-1" aria-label="Previous month">${icon('chevron-down', 15)}</button><button type="button" class="sch-title" data-pick="months" aria-label="Choose the month and year">${esc(view.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}${icon('chevron-down', 14)}</button><button type="button" class="dt-nav" data-nav="1" aria-label="Next month" ${keyOf(new Date(view.getFullYear(), view.getMonth() + 1, 1)) > maxKey ? 'disabled' : ''}>${icon('chevron-down', 15)}</button></div>
          <div class="dt-week">${[...Array(7)].map((_, i) => `<span>${esc(new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2))}</span>`).join('')}</div>
          <div class="dt-grid">${cells}</div>`}
        </div>
        <div class="df-line"><span class="df-hint">${hint}</span>${active(v) ? '<button type="button" class="df-clear" data-clear>Clear</button>' : ''}</div>
        <div class="df-foot"><button type="button" class="btn df-cancel" data-cancel>Cancel</button><button type="button" class="btn primary" data-done>Apply</button></div>`;
      Motion.segs(el);
    }
    // The month / year grid behind the title: ‹ year ›, twelve months; a month with nothing in it yet (after today and
    // past anything scheduled) is greyed, as the › arrow is.
    function monthsHtml() {
      const y = view.getFullYear(), now = new Date();
      const pickedMonths = new Set((v?.days || (v?.from ? [v.from, v.to] : [])).map((k) => k.slice(0, 7)));
      const months = [...Array(12)].map((_, m) => {
        const key = `${y}-${pad(m + 1)}`, off = key + '-01' > maxKey;
        const cur = y === now.getFullYear() && m === now.getMonth();
        return `<button type="button" class="sch-month ${y === view.getFullYear() && m === view.getMonth() ? 'on' : ''} ${cur ? 'today' : ''} ${pickedMonths.has(key) ? 'has' : ''}" data-month="${m}" ${off ? 'disabled' : ''}>${esc(new Date(y, m, 1).toLocaleDateString(undefined, { month: 'short' }))}</button>`;
      }).join('');
      return `<div class="dt-head"><button type="button" class="dt-nav" data-year="-1" aria-label="Previous year">${icon('chevron-down', 15)}</button><button type="button" class="sch-title open" data-pick="days" aria-label="Back to the days">${y}${icon('chevron-down', 14)}</button><button type="button" class="dt-nav" data-year="1" aria-label="Next year" ${`${y + 1}-01-01` > maxKey ? 'disabled' : ''}>${icon('chevron-down', 15)}</button></div><div class="sch-months">${months}</div>`;
    }
    draw();
    Sheet.Menu.fit(el, r);
    el.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.mode && t.dataset.mode !== mode) { mode = t.dataset.mode; anchor = null; v = null; emit(); return draw(); }
      if (t.dataset.sort) { sort = t.dataset.sort; onSort(sort); return draw(); }
      if (t.dataset.nav) { view = new Date(view.getFullYear(), view.getMonth() + Number(t.dataset.nav), 1); return draw(); }
      if (t.dataset.pick) { const to = t.dataset.pick; return Sheet.Menu.morph(el, () => { picking = to; draw(); }, { zoom: to === 'months' ? 'out' : 'in', part: '.dt-cal' }); }
      if (t.dataset.year) { view = new Date(view.getFullYear() + Number(t.dataset.year), view.getMonth(), 1); return draw(); }
      if (t.dataset.month && !t.disabled) { view = new Date(view.getFullYear(), Number(t.dataset.month), 1); return Sheet.Menu.morph(el, () => { picking = 'days'; draw(); }, { zoom: 'in', part: '.dt-cal' }); }
      if (t.dataset.q) { mode = 'range'; anchor = null; v = QUICK[Number(t.dataset.q)][1](); const d = fromKey(v.to); view = new Date(d.getFullYear(), d.getMonth(), 1); emit(); return draw(); }
      if ('clear' in t.dataset) { v = null; anchor = null; emit(); return draw(); }
      if ('done' in t.dataset) { Sheet.Menu.close(); return btn.focus?.({ preventScroll: true }); }
      // Cancel: back to what it was when the calendar opened (the list behind follows)
      if ('cancel' in t.dataset) { v = opened ? JSON.parse(JSON.stringify(opened)) : null; emit(); Sheet.Menu.close(); return btn.focus?.({ preventScroll: true }); }
      const k = t.dataset.k;
      if (!k || t.disabled) return;
      const add = e.metaKey || e.ctrlKey, span = e.shiftKey;
      if (span && last) {
        // Shift: every day from the last one clicked to this one
        mode = 'range'; anchor = null;
        const [lo, hi] = last <= k ? [last, k] : [k, last];
        v = { from: lo, to: hi };
      } else if (mode === 'range' && !add) {
        if (!anchor) { anchor = k; hover = k; v = null; }
        else { const [lo, hi] = anchor <= k ? [anchor, k] : [k, anchor]; v = { from: lo, to: hi }; anchor = null; }
      } else {
        // a plain click picks just this day; ⌘/Ctrl (or a tap) adds or removes it
        mode = 'days'; anchor = null;
        const days = new Set(add || touch ? (v?.days || (v?.from ? spanDays(v.from, v.to) : [])) : []);
        if (add || touch) days.has(k) ? days.delete(k) : days.add(k); else days.add(k);
        v = days.size ? { days: [...days].sort() } : null;
      }
      last = k;
      emit();
      draw();
    });
    el.addEventListener('pointerdown', (e) => { touch = e.pointerType === 'touch'; });
    el.addEventListener('pointerover', (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (mode === 'range' && anchor && k && k !== hover) { hover = k; draw(); }
    });
  }

  return { open, match, label, button, active, keyOf };
})();
