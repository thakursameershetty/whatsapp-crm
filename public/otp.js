// One-time code, after Bencho's component (MIT, bencho.dev/licence), ported from React to
// plain JS for this no-build app. OneTimeCode.mount(el, { length, check, onVerified }):
// `check(code)` returns a Promise<boolean> — the server's answer — instead of the demo's
// Accept/Reject knob. Returns { reset(), focus(), destroy() }.

(function () {
  /* ══ One-time code ════════════════════════════════════════
     Six small cells and a caret. Digits rise into their cells;
     a right code draws the cells together until they fuse into
     one capsule that says so, and a wrong one sends a shiver
     down the row and drains the digits out.

     ── SIX CELLS, ONE FIELD ────────────────────────────────
     The same call the sign-in sheet makes, for the same reasons:
     six real inputs break paste, autofill from the notification,
     backspace and screen readers. So there is one invisible
     input over the row and the cells are drawn underneath it.

     ── THE MERGE IS THE GOO'S ──────────────────────────────
     The cells sit under a blur-and-threshold filter, far enough
     apart that it never bridges them. Verifying slides them to
     the middle while a capsule grows out of the same point: as
     they close, the filter joins them, and what is left is one
     shape. Nobody draws the in-between — it is the filter
     deciding when two things are close enough to be one. */

  /* ══ liquid ═══════════════════════════════════════════════
     ── what the goo can and cannot do ──────────────────────
     This is feGaussianBlur + feColorMatrix, not a shader. The
     matrix multiplies alpha by `cut` and subtracts half of it,
     so alpha below 0.5 lands on zero and everything above 0.536
     is fully opaque. That hard edge is what fuses nearby shapes
     into one blob — and it is also why this must never touch
     text: glyph antialiasing lives entirely below 0.5, so type
     under this filter loses its edges and then itself.

     Each mount needs its own filter id: duplicate SVG ids do not
     scope, they collide, and the second instance silently steals
     the first one's filter. */
  let seq = 0;
  function goo(blur = 7, cut = 28) {
    const id = `otp-goo-${++seq}`;
    const svg = `<svg class="liq-defs" aria-hidden="true" focusable="false"><defs><filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="smear"/><feColorMatrix in="smear" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${cut} ${-(cut / 2)}"/></filter></defs></svg>`;
    return { url: `url(#${id})`, svg };
  }

  /* Read once. A preference, not a live input. */
  const stillness = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /* how long a cell takes to swell and settle when a digit lands */
  const POP_MS = 260;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, v) => { const u = clamp((v - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };

  /* a cell, and the air between two */
  const W = 36;
  const H = 44;
  const G = 7;
  /* the capsule a right code becomes */
  const CAP = 128;
  /* ── the merge is a SPRING, not a tween ─────────────────
     It was a 560ms ease-in-out, which arrived and stopped. A
     spring a little under critical lets the capsule run past its
     size and come back — stretching long and thin on the way out
     and settling round — which is what makes the fuse read as
     liquid rather than as boxes sliding. Per frame at 60Hz, from
     a stiffness and a damping ratio. */
  const MERGE = (() => { const k = 0.075, zeta = 0.42; return { k, d: 1 - 2 * zeta * Math.sqrt(k) }; })();
  const SHAKE_MS = 620;
  const CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  function mount(root, { length = 6, corner = 12, check = async () => true, onVerified = () => {}, onChange = () => {} } = {}) {
    const n = length === 4 ? 4 : 6;
    const r = clamp(corner, 0, H / 2);
    const rowW = n * W + (n - 1) * G;
    const still = stillness();
    const g = goo(3, 24);

    root.classList.add('otp');
    root.innerHTML = `<div class="otp-row" style="width:${rowW}px;height:${H}px">
      <div class="otp-goo" aria-hidden="true" style="${still ? '' : `filter:${g.url}`}">${Array.from({ length: n }, () => `<span class="otp-cell" style="width:${W}px"></span>`).join('')}<span class="otp-cell otp-cap" style="width:0;border-radius:${H / 2}px"></span></div>
      ${Array.from({ length: n }, () => `<span class="otp-slot" style="width:${W}px"></span>`).join('')}
      <i class="otp-caret"></i>
      <span class="otp-ok">${CHECK}Verified</span>
      <input class="otp-field" inputmode="numeric" autocomplete="one-time-code" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" maxlength="${n}" aria-label="${n}-digit code" spellcheck="false" />
    </div>${g.svg}`;
    const $ = (s) => root.querySelector(s);
    const cells = [...root.querySelectorAll('.otp-cell:not(.otp-cap)')], cap = $('.otp-cap');
    const slots = [...root.querySelectorAll('.otp-slot')], caretEl = $('.otp-caret'), okEl = $('.otp-ok'), field = $('.otp-field');

    let code = '', phase = 'type', focus = false;
    /* moving parts, read by the loop */
    const caret = { x: W / 2, v: 0 };
    /* when each cell last took a digit — for the little swell */
    const popAt = [];
    let merge = { m: 0, v: 0, to: 0 };
    let shook = 0, raf = 0;
    const timers = [];
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));

    function setPhase(p) { phase = p; root.dataset.phase = p; }
    setPhase('type');

    /* ── the one loop ────────────────────────────────────────
       Runs while something moves and stops itself after, so a
       row nobody is typing into costs nothing. */
    function wake() {
      if (raf) return;
      let prev = 0;
      const tick = (t) => {
        const dt = prev ? clamp((t - prev) / 16.67, 0, 2.5) : 1;
        prev = t;
        let busy = false;
        /* the caret, on a spring with a little give. Frames, not
           milliseconds: the damping is RAISED to dt, so a dropped
           frame decays the same energy as the two it replaced. */
        const target = Math.min(code.length, n - 1) * (W + G) + W / 2;
        if (still) { caret.x = target; caret.v = 0; }
        else {
          caret.v += (target - caret.x) * 0.2 * dt;
          caret.v *= Math.pow(0.62, dt);
          caret.x += caret.v * dt;
          if (Math.abs(target - caret.x) < 0.05 && Math.abs(caret.v) < 0.05) { caret.x = target; caret.v = 0; } else busy = true;
        }
        /* the merge, sprung */
        if (merge.m !== merge.to || merge.v !== 0) {
          if (still) { merge.m = merge.to; merge.v = 0; }
          else {
            merge.v += (merge.to - merge.m) * MERGE.k * dt;
            merge.v *= Math.pow(MERGE.d, dt);
            merge.m += merge.v * dt;
            if (Math.abs(merge.to - merge.m) < 0.0008 && Math.abs(merge.v) < 0.0008) { merge.m = merge.to; merge.v = 0; } else busy = true;
          }
        }
        if (t - shook < SHAKE_MS + 200) busy = true;
        /* a cell still swelling from a digit keeps the loop alive */
        if (popAt.some((at) => t - at < POP_MS)) busy = true;
        draw(t);
        raf = busy ? requestAnimationFrame(tick) : 0;
      };
      raf = requestAnimationFrame(tick);
    }
    const fuse = (to) => { merge = { ...merge, to }; wake(); };

    /* ── where everything is this frame ──────────────────────── */
    function draw(now = performance.now()) {
      /* the raw spring runs past 0 and 1; the cells' travel is
         clamped to it, and only the capsule is allowed to take the
         overshoot, as a stretch */
      const raw = merge.m, m = clamp(raw, 0, 1);
      const home = (i) => i * (W + G), mid = (rowW - W) / 2;
      const since = now - shook;
      const shaking = phase === 'no' && since < SHAKE_MS && !still;
      const shake = (i) => (shaking ? 5 * Math.exp(-since / 190) * Math.sin((since / 1000) * Math.PI * 2 * 10 + i * 0.55) : 0);
      const cellX = (i) => mix(home(i), mid, m) + shake(i);
      /* ── a digit arriving ─────────────────────────────────────
         The cell that takes it swells a touch and settles: up and
         back on one half-sine, four per cent at the top. Small on
         purpose — it is an acknowledgement, not an event. */
      const pop = (i) => { const at = popAt[i]; if (at === undefined) return 1; const u = (now - at) / POP_MS; return u > 0 && u < 1 ? 1 + 0.04 * Math.sin(Math.PI * u) : 1; };
      /* checking: a soft wave of breath through the cells */
      const breath = (i) => { if (phase !== 'check' || still) return pop(i); const u = ((now % 900) / 900) * (n + 2) - i; return 1 - 0.07 * (u > 0 && u < 2 ? Math.sin((u / 2) * Math.PI) : 0); };
      const over = raw - 1;
      /* long and thin past its size, round again as it settles:
         width and height trade, so it reads as one soft thing */
      const capW = CAP * smooth(0.3, 1, m) * (1 + Math.max(-0.12, over) * 0.9);
      const capSy = 1 - Math.max(-0.12, over) * 0.55;
      /* cells round off into the capsule's pill as they close in,
         so the two shapes agree by the time the goo joins them */
      const cellR = mix(r, H / 2, smooth(0.15, 0.7, m));
      cells.forEach((c, i) => { c.style.borderRadius = cellR + 'px'; c.style.transform = `translateX(${cellX(i).toFixed(2)}px) scale(${breath(i).toFixed(3)})`; });
      cap.style.display = capW > 0.5 ? '' : 'none';
      cap.style.width = capW + 'px';
      cap.style.transform = `translateX(${((rowW - capW) / 2).toFixed(2)}px) scaleY(${capSy.toFixed(3)})`;
      slots.forEach((s, i) => {
        s.style.transform = `translateX(${cellX(i).toFixed(2)}px)`;
        s.style.opacity = String(1 - smooth(0, 0.45, m));
        /* a wrong code drains right to left */
        const out = phase === 'no' && !still ? smooth(0, 1, (since - 300 - (n - 1 - i) * 45) / 220) : 0;
        const d = s.firstElementChild;
        if (d) { d.style.translate = `0 ${(out * 8).toFixed(2)}px`; d.style.opacity = String(1 - out); }
      });
      /* the caret, stretched by its own speed — and not until the
         cells have come apart again, or it stands in an empty slot
         the capsule is still on */
      caretEl.dataset.on = String(phase === 'type' && focus && code.length < n && m < 0.08);
      caretEl.style.transform = `translateX(${(caret.x - 1).toFixed(2)}px) scaleX(${(1 + Math.min(5, Math.abs(caret.v) * 0.9)).toFixed(3)})`;
      okEl.style.opacity = String(smooth(0.72, 1, m));
      okEl.style.scale = String(mix(0.92, 1, smooth(0.72, 1, m)));
    }

    // Digits: an empty cell is just the cell; a new digit gets a fresh element so it rises in.
    function renderDigits(prevLen) {
      slots.forEach((s, i) => {
        const d = code[i];
        if (!d) { s.innerHTML = ''; return; }
        if (i >= prevLen || s.textContent !== d) s.innerHTML = `<span class="otp-digit">${d}</span>`;
      });
    }

    function onInput() {
      if (phase !== 'type') { field.value = code; return; }
      const next = field.value.replace(/\D/g, '').slice(0, n);
      field.value = next;
      /* each new digit swells its cell — a paste runs along the row */
      if (!still && next.length > code.length) {
        const t0 = performance.now();
        for (let i = code.length; i < next.length; i++) popAt[i] = t0 + (i - code.length) * 45;
      }
      const prevLen = code.length;
      code = next;
      renderDigits(prevLen);
      onChange(code);
      wake();
      if (code.length < n) return;
      /* full: a beat of checking, then the server's answer */
      setPhase('check');
      wake();
      const started = performance.now();
      Promise.resolve(check(code)).catch(() => false).then((ok) => {
        later(() => {
          if (ok) { setPhase('ok'); fuse(1); field.blur(); field.setAttribute('aria-label', 'Verified'); onVerified(code); }
          else {
            setPhase('no');
            shook = performance.now();
            wake();
            later(() => { code = ''; field.value = ''; renderDigits(0); setPhase('type'); onChange(''); field.focus(); wake(); }, SHAKE_MS + n * 45 + 160);
          }
        }, Math.max(0, (still ? 0 : 420) - (performance.now() - started)));
      });
    }
    field.addEventListener('input', onInput);
    field.addEventListener('focus', () => { focus = true; wake(); });
    field.addEventListener('blur', () => { focus = false; wake(); });
    draw();

    return {
      focus: () => field.focus(),
      get code() { return code; },
      get verified() { return phase === 'ok'; },
      /* splits the capsule back into empty cells */
      reset() { code = ''; field.value = ''; renderDigits(0); setPhase('type'); fuse(0); },
      destroy() { cancelAnimationFrame(raf); timers.forEach(clearTimeout); root.innerHTML = ''; },
    };
  }

  window.OneTimeCode = { mount };
})();
