// Terms and Privacy pages (terms.html, privacy.html): the contents follow your reading, tied to the scroll itself
// (no jumps and no timed animations, so it moves exactly as fast as you scroll, in either direction).
//  - Desktop: the sections on screen are marked in the side list, and an ink bar on its rail covers exactly the part of
//    the document you can see, sliding and stretching as you scroll.
//  - Phones: a row of section chips in the sticky header. A dark pill glides from one chip to the next as the next
//    heading comes up (the text turns light exactly where the pill covers it), the row keeps the pill centred, and a
//    hairline underneath shows how far through the page you are. Tap a chip to jump; swipe the row to look around.
(() => {
  const toc = document.querySelector('.lg-toc'), doc = document.querySelector('.lg-doc'), top = document.querySelector('.lg-top');
  if (!toc || !doc || !top) return;
  const items = [...toc.querySelectorAll('a[href^="#"]')]
    .map((a, i) => ({ a, i, h: document.getElementById(decodeURIComponent(a.hash.slice(1))), name: a.textContent.trim() }))
    .filter((x) => x.h);
  if (!items.length) return;
  const phone = matchMedia('(max-width: 760px)');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => t * t * (3 - 2 * t);

  // Desktop: the ink bar on the list's rail.
  const ol = toc.querySelector('ol');
  const ink = document.createElement('i'); ink.className = 'lg-toc-ink'; ink.setAttribute('aria-hidden', 'true');
  ol.append(ink);

  // Phones: the chip row (two identical layers: the plain chips, and a dark copy shown only inside the pill).
  const chips = (cls) => items.map((x) => `<a class="${cls}" href="#${x.h.id}"><b>${x.i + 1}</b>${x.name}</a>`).join('');
  const rail = document.createElement('nav');
  rail.className = 'lg-rail'; rail.setAttribute('aria-label', 'Sections');
  rail.innerHTML = `<div class="lg-rail-scroll"><div class="lg-rail-track">${chips('lg-chip')}<div class="lg-rail-pill" aria-hidden="true">${chips('lg-chip')}</div></div></div><i class="lg-rail-prog" aria-hidden="true"></i>`;
  rail.querySelectorAll('.lg-rail-pill a').forEach((a) => { a.tabIndex = -1; });
  top.append(rail);
  toc.classList.add('js'); document.documentElement.classList.add('lg-js');
  const scroller = rail.querySelector('.lg-rail-scroll'), track = rail.querySelector('.lg-rail-track'), pill = rail.querySelector('.lg-rail-pill');
  const chipEls = [...track.children].filter((c) => c.classList.contains('lg-chip'));
  const prog = rail.querySelector('.lg-rail-prog');

  // While someone swipes the row themselves, leave its scroll position alone for a moment.
  let handsOn = 0;
  const hold = () => { handsOn = performance.now() + 1400; };
  ['touchstart', 'touchmove', 'wheel', 'pointerdown'].forEach((t) => scroller.addEventListener(t, hold, { passive: true }));
  chipEls.forEach((c) => c.addEventListener('click', () => { handsOn = 0; }));

  // Layout, measured once (and again on resize or when fonts arrive), so scrolling only does arithmetic.
  let H = [], end = 0, L = [], LH = [], C = [], W = [];
  const measure = () => {
    const y = scrollY;
    H = items.map((x) => x.h.getBoundingClientRect().top + y);
    end = doc.getBoundingClientRect().bottom + y;
    L = items.map((x) => x.a.parentElement.offsetTop); LH = items.map((x) => x.a.parentElement.offsetHeight);
    C = chipEls.map((c) => c.offsetLeft); W = chipEls.map((c) => c.offsetWidth);
  };
  // Where a point of the document falls, as a fractional section number (2.5 = halfway through the third section).
  const at = (y) => {
    if (y <= H[0]) return 0;
    for (let k = 0; k < H.length; k++) {
      const e = k + 1 < H.length ? H[k + 1] : end;
      if (y < e) return k + (y - H[k]) / Math.max(1, e - H[k]);
    }
    return H.length - 0.001;
  };

  let lastKey = '';
  const update = () => {
    const y = scrollY, from = y + top.offsetHeight + 8, to = y + innerHeight;
    if (!phone.matches) {
      // Ink bar: from where the top of the screen falls in the list to where its bottom falls.
      const map = (f) => { const k = Math.floor(f); return L[k] + (f - k) * LH[k]; };
      const a = map(at(from)), b = map(at(to));
      ink.style.transform = `translateY(${a}px)`; ink.style.height = `${Math.max(14, b - a)}px`;
      // Bold the sections that have a real share of the screen.
      const seen = items.filter((x, k) => (k + 1 < H.length ? H[k + 1] : end) > from + 24 && H[k] < to - 24);
      const key = seen.map((x) => x.i).join();
      if (key !== lastKey) {
        lastKey = key;
        items.forEach((x) => { const on = seen.includes(x); x.a.classList.toggle('on', on); if (on && x === seen[0]) x.a.setAttribute('aria-current', 'location'); else x.a.removeAttribute('aria-current'); });
      }
      return;
    }
    // Pill: sits on the section you're reading, and glides to the next one over the last stretch before its heading
    // reaches the reading line, landing as the new section starts.
    const line = from + 72, zone = Math.min(220, innerHeight * 0.3);
    let k = H.length - 1; while (k > 0 && H[k] > line) k--;
    const next = k + 1 < H.length ? H[k + 1] : null;
    const t = next == null ? 0 : ease(clamp((line - (next - zone)) / zone, 0, 1));
    const j = next == null ? k : k + 1;
    const l = lerp(C[k], C[j], t), w = lerp(W[k], W[j], t);
    pill.style.setProperty('--l', `${l}px`); pill.style.setProperty('--w', `${w}px`);
    if (performance.now() > handsOn) scroller.scrollLeft = l + w / 2 - scroller.clientWidth / 2;
    prog.style.transform = `scaleX(${clamp((y + innerHeight - H[0]) / Math.max(1, end - H[0]), 0, 1)})`;
    const cur = t < 0.5 ? k : j, key = `p${cur}`;
    if (key !== lastKey) { lastKey = key; chipEls.forEach((c, i) => { if (i === cur) c.setAttribute('aria-current', 'location'); else c.removeAttribute('aria-current'); }); }
  };

  let raf = 0;
  const soon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };
  const remeasure = () => { measure(); lastKey = ''; update(); };
  addEventListener('scroll', soon, { passive: true });
  addEventListener('resize', () => requestAnimationFrame(remeasure));
  phone.addEventListener?.('change', remeasure);
  document.fonts?.ready.then(remeasure);
  addEventListener('load', remeasure);
  if ('ResizeObserver' in window) new ResizeObserver(() => requestAnimationFrame(remeasure)).observe(doc);
  remeasure();
})();
