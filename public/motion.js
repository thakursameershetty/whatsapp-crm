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

  function placeThumb(seg, instant) {
    const th = seg.__thumb;
    if (!th) return;
    const a = seg.querySelector(':scope > button.active');
    if (!a || !a.offsetWidth) { th.style.opacity = '0'; return; }
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
    new MutationObserver(() => placeThumb(seg)).observe(seg, { subtree: true, attributes: true, attributeFilter: ['class'] });
    // A control inside something hidden (e.g. the expanded chart dialog) has no size yet;
    // place the thumb once it's shown or resized.
    new ResizeObserver(() => placeThumb(seg, true)).observe(seg);
    placeThumb(seg, true);
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

  window.Motion = { values, segs, enter, themeFade, reduce };
})();
