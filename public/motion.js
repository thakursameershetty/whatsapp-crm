// Motion helpers shared across the UI (uses D3 for tweening).
//  - values(root): numbers count up and bars/meters slide from their previous value
//    to the new one. Elements opt in with data-count / data-w, and a data-k key so a
//    re-render (e.g. live polling) continues from where the last one left off.
//  - Segmented controls get a ceramic thumb that slides to the active option.
//  - enter(el): staggered fade-up for a page or section.
//  - Respects prefers-reduced-motion.

(function () {
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const prev = new Map();
  const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  const FORMATS = {
    num: (v) => (v >= 10000 ? compact.format(Math.round(v)) : Math.round(v).toLocaleString()),
    int: (v) => Math.round(v).toLocaleString(),
    pct1: (v) => (Math.round(v * 10) / 10).toFixed(1),
  };

  function values(root = document) {
    root.querySelectorAll('[data-w]').forEach((el) => {
      const to = Number(el.dataset.w) || 0;
      const k = el.dataset.k ? 'w:' + el.dataset.k : null;
      const from = k && prev.has(k) ? prev.get(k) : 0;
      if (k) prev.set(k, to);
      if (reduce() || from === to) { el.style.width = to + '%'; return; }
      el.style.transition = 'none';
      el.style.width = from + '%';
      el.getBoundingClientRect();
      el.style.transition = '';
      el.style.width = to + '%';
    });

    root.querySelectorAll('[data-count]').forEach((el) => {
      const to = Number(el.dataset.count) || 0;
      const fmt = FORMATS[el.dataset.fmt] || FORMATS.num;
      const k = el.dataset.k ? 'c:' + el.dataset.k : null;
      const from = k && prev.has(k) ? prev.get(k) : 0;
      if (k) prev.set(k, to);
      if (reduce() || from === to || !window.d3) { el.textContent = fmt(to); return; }
      el.textContent = fmt(from);
      d3.select(el)
        .transition()
        .duration(900)
        .ease(d3.easeCubicOut)
        .tween('text', () => {
          const i = d3.interpolateNumber(from, to);
          return (t) => { el.textContent = fmt(i(t)); };
        });
    });
  }

  // --- Sliding thumb for .seg controls ---

  // Where each control's thumb last sat (by id), so a control that's rebuilt by a
  // re-render slides on from there instead of snapping.
  const lastPos = new Map();

  function placeThumb(seg, instant) {
    const th = seg.__thumb;
    if (!th) return;
    // A redraw of the buttons (innerHTML, e.g. live counts on a running campaign) removes the thumb:
    // put it back, so it isn't left moving while detached (or stuck where the old buttons were).
    if (th.parentNode !== seg) seg.prepend(th);
    const a = seg.querySelector(':scope > button.active');
    if (!a || !a.offsetWidth) { th.style.opacity = '0'; return; }
    if (seg.id) lastPos.set(seg.id, { w: a.offsetWidth, h: a.offsetHeight, x: a.offsetLeft, y: a.offsetTop });
    // First placement (or after being hidden) snaps; later changes slide.
    if (th.style.opacity !== '1') instant = true;
    if (instant || reduce()) th.style.transition = 'none';
    th.style.opacity = '1';
    th.style.width = a.offsetWidth + 'px';
    th.style.height = a.offsetHeight + 'px';
    th.style.transform = `translate(${a.offsetLeft}px, ${a.offsetTop}px)`;
    if (instant || reduce()) { th.getBoundingClientRect(); th.style.transition = ''; }
  }

  function setupSeg(seg) {
    if (seg.__thumb || !seg.querySelector(':scope > button')) return;
    const th = document.createElement('i');
    th.className = 'seg-thumb';
    th.setAttribute('aria-hidden', 'true');
    seg.prepend(th);
    seg.__thumb = th;
    seg.classList.add('has-thumb');
    // Re-place on a new active button, and when the buttons are redrawn or their text (counts) changes width.
    new MutationObserver((muts) => {
      if (muts.every((m) => m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every((n) => n === th))) return; // our own re-attach
      placeThumb(seg, muts.some((m) => m.type === 'childList' && m.target === seg));
    }).observe(seg, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    // A control inside something hidden (e.g. the expanded chart dialog) has no size yet;
    // place the thumb once it's shown or resized. (The first callback is just the initial size.)
    let seen = false;
    new ResizeObserver(() => { if (seen) placeThumb(seg, true); seen = true; }).observe(seg);
    const last = seg.id && lastPos.get(seg.id);
    if (last && !reduce()) {
      th.style.transition = 'none';
      Object.assign(th.style, { opacity: '1', width: last.w + 'px', height: last.h + 'px', transform: `translate(${last.x}px, ${last.y}px)` });
      th.getBoundingClientRect();
      th.style.transition = '';
      requestAnimationFrame(() => placeThumb(seg));
    } else placeThumb(seg, true);
  }

  function segs(root = document) {
    root.querySelectorAll('.seg').forEach(setupSeg);
    document.querySelectorAll('.seg.has-thumb').forEach((s) => placeThumb(s));
  }

  // New .seg controls rendered later (e.g. campaign filters) get a thumb too.
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches('.seg')) setupSeg(n);
      n.querySelectorAll?.('.seg').forEach(setupSeg);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('resize', () => document.querySelectorAll('.seg.has-thumb').forEach((s) => placeThumb(s, true)));
  document.fonts?.ready.then(() => segs());

  // --- Page / section entrance ---

  function enter(el) {
    if (!el || reduce()) return;
    el.classList.remove('enter');
    el.getBoundingClientRect();
    el.classList.add('enter');
    clearTimeout(el.__enterT);
    el.__enterT = setTimeout(() => el.classList.remove('enter'), 900);
  }

  // Cross-fade colours when the theme changes.
  function themeFade() {
    if (reduce()) return;
    const root = document.documentElement;
    root.classList.add('theme-anim');
    clearTimeout(root.__themeT);
    root.__themeT = setTimeout(() => root.classList.remove('theme-anim'), 450);
  }

  // Update a container's markup without replacing children that are still the same kind of
  // element: their attributes (e.g. .active) change in place, so CSS transitions play.
  function patch(el, html) {
    if (el.__html === html) return;
    el.__html = html;
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    const next = [...t.content.children];
    const cur = [...el.children].filter((c) => !c.classList.contains('seg-thumb'));
    if (next.length !== cur.length || next.some((n, i) => n.tagName !== cur[i].tagName)) {
      cur.forEach((c) => c.remove());
      el.append(...next);
      return;
    }
    next.forEach((n, i) => {
      const c = cur[i];
      for (const a of [...c.attributes]) if (!n.hasAttribute(a.name)) c.removeAttribute(a.name);
      for (const a of [...n.attributes]) if (c.getAttribute(a.name) !== a.value) c.setAttribute(a.name, a.value);
      if (c.innerHTML !== n.innerHTML) c.innerHTML = n.innerHTML;
    });
  }

  // Morph between two states of the page with a view transition. Elements that carry a
  // view-transition-name while html.vt-<name> is set glide from their old place and size to
  // the new one. Resolves once the DOM has been updated (callers can carry on from there).
  function morph(swap, name) {
    if (!document.startViewTransition || reduce()) { swap(); return Promise.resolve(); }
    const root = document.documentElement;
    root.classList.add('vt-' + name);
    const vt = document.startViewTransition(swap);
    vt.finished.finally(() => root.classList.remove('vt-' + name));
    return vt.updateCallbackDone.catch(() => {});
  }

  window.Motion = { values, segs, enter, themeFade, reduce, patch, morph };
})();
