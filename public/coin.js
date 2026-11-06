// The credits coin: a 3D gold coin with real thickness. It leans toward the pointer with a moving highlight, and a
// click (or Enter / Space) tosses it: up, one and a half turns, down onto its other face with a small bounce and
// wobble. The faces dim as they turn edge-on, and a glint sweeps
// across when it lands. Styles: .coin in style.css. Image: brand/credit-coin.webp.
//   Coin.html({ size: 120, label: 'Credits' })  → the button's HTML; it works wherever it's put (one listener here).
window.Coin = (() => {
  const SRC = '/brand/credit-coin.webp';
  const SLICES = 14; // edge slices: enough that the rim looks solid when it's side-on
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function html({ size = 120, label = 'Credits' } = {}) {
    const edge = Array.from({ length: SLICES }, (_, i) => `<i style="--i:${i}"></i>`).join('');
    const face = (side) => `<span class="coin-face ${side}"><img src="${SRC}" alt="" draggable="false" /><i class="coin-shine"></i><i class="coin-glint"></i></span>`;
    return `<button type="button" class="coin" data-coin style="--coin:${size}px;--slices:${SLICES}" aria-label="${label}. Flip the coin" title="Flip the coin">
      <span class="coin-toss" aria-hidden="true"><span class="coin-tilt"><span class="coin-spin">
        <span class="coin-edge">${edge}</span>${face('front')}${face('back')}
      </span></span></span>
    </button>`;
  }

  // --- Leaning toward the pointer, with the highlight following it ---------------------------------------------------
  document.addEventListener('pointermove', (e) => {
    const c = e.target.closest?.('[data-coin]');
    if (!c || c.dataset.busy) return;
    const r = c.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    const y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
    c.style.setProperty('--tx', x.toFixed(3));
    c.style.setProperty('--ty', y.toFixed(3));
    c.classList.add('is-hover');
  });
  document.addEventListener('pointerout', (e) => {
    const c = e.target.closest?.('[data-coin]');
    if (!c || c.contains(e.relatedTarget)) return;
    c.style.setProperty('--tx', 0);
    c.style.setProperty('--ty', 0);
    c.classList.remove('is-hover');
  });

  // --- The toss ----------------------------------------------------------------------------------------------------
  // Lighting while it spins: a face is brightest facing you and darkest edge-on (|cos| of the angle).
  const lit = (deg) => 0.62 + 0.38 * Math.abs(Math.cos((deg * Math.PI) / 180));
  function toss(c) {
    if (c.dataset.busy) return;
    const spin = c.querySelector('.coin-spin'), up = c.querySelector('.coin-toss');
    const size = c.getBoundingClientRect().width;
    const from = Number(c.dataset.angle || 0), to = from + 540; // 1½ turns: lands on the other face
    const end = () => {
      spin.style.transform = `rotateY(${to % 360}deg)`;
      c.dataset.angle = String(to % 360);
      spin.getAnimations().forEach((a) => a.cancel());
      delete c.dataset.busy;
      c.classList.remove('is-tossing');
      c.querySelectorAll('.coin-glint').forEach((g) => g.animate(
        [{ transform: 'translateX(-130%) rotate(24deg)', opacity: 0 }, { opacity: 1, offset: 0.35 }, { transform: 'translateX(130%) rotate(24deg)', opacity: 0 }],
        { duration: 650, easing: 'ease-out' }));
    };
    if (reduce()) { spin.animate([{ opacity: 1 }, { opacity: 0.4 }, { opacity: 1 }], { duration: 260 }); return end(); }
    c.dataset.busy = '1';
    c.classList.add('is-tossing');
    c.style.setProperty('--tx', 0);
    c.style.setProperty('--ty', 0);
    const T = 1150, H = Math.max(36, size * 0.62);
    // Spin: fast off the thumb, slowing as it comes down. The light follows the angle.
    const steps = 24, ease = (p) => 1 - Math.pow(1 - p, 2.2);
    spin.animate(Array.from({ length: steps + 1 }, (_, i) => {
      const deg = from + (to - from) * ease(i / steps);
      return { transform: `rotateY(${deg}deg)`, '--lit': lit(deg), offset: (i / steps) * 0.8 };
    }).concat([{ transform: `rotateY(${to}deg)`, '--lit': 1, offset: 1 }]), { duration: T, fill: 'forwards' });
    // Height: up decelerating, down accelerating (gravity), a small bounce, then a settling wobble.
    up.animate([
      { transform: 'translateY(0) rotateX(0deg) scale(1)', easing: 'cubic-bezier(.22,.68,.36,1)' },
      { transform: `translateY(${-H}px) rotateX(-8deg) scale(1.05)`, offset: 0.4, easing: 'cubic-bezier(.6,0,.86,.42)' },
      { transform: 'translateY(0) rotateX(0deg) scale(1)', offset: 0.78, easing: 'cubic-bezier(.25,.8,.4,1)' },
      { transform: `translateY(${-H * 0.09}px) rotateX(9deg) scale(1)`, offset: 0.86, easing: 'cubic-bezier(.5,0,.75,.5)' },
      { transform: 'translateY(0) rotateX(-4deg) scale(1)', offset: 0.93 },
      { transform: 'translateY(0) rotateX(0deg) scale(1)', offset: 1 },
    ], { duration: T });
    setTimeout(end, T);
  }
  document.addEventListener('click', (e) => { const c = e.target.closest?.('[data-coin]'); if (c) toss(c); });

  return { html, toss };
})();
