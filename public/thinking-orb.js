// Thinking orbs (thinking-orbs 0.3.2 by Jakub Antalik, MIT: notice at the top of thinking-orbs/engine.js): nine hand-tuned animated states
// for what the AI is doing right now. The package's drawing engine is used as shipped (thinking-orbs/engine.js); this
// file does what its React component does, without React (the dashboard has no build step):
//   ThinkingOrb.mount(el, { state, size, speed }) → { set(state), destroy() }
// `el` is replaced by a <canvas> (keeping its classes). States: working, searching, solving, listening, connecting,
// weaving, composing, breathing, shaping. Size is the display size; the drawing uses the nearest tuned design (20, 32
// or 64 px) and is scaled to fit. Light or dark follows the app's theme; with "reduce motion" it's drawn once, still.
// The still dotted-sphere icon on buttons stays orb.js (Orb.hydrate).
import { r as resolvePreset, M as MODE_FRAMES, p as paintFrame } from './thinking-orbs/engine.js';

const STATES = ['working', 'searching', 'solving', 'listening', 'connecting', 'weaving', 'composing', 'breathing', 'shaping'];
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
};
const tuned = (px) => (px <= 26 ? 20 : px <= 44 ? 32 : 64);

function mount(el, { state = 'working', size = 20, speed = 1 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = (el.getAttribute?.('class') || '') + ' thinking-orb';
  canvas.setAttribute('role', 'img');
  canvas.style.width = canvas.style.height = size + 'px';
  canvas.style.display = 'block';
  el.replaceWith(canvas);
  const design = tuned(size);
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d');
  let raf = 0, running = false, cur = null;
  const scale = (size / design) * dpr;

  function setup(next) {
    cur = STATES.includes(next) ? next : 'working';
    const { mode, speed: base, opts } = resolvePreset(cur, design);
    cur = { name: cur, frame: MODE_FRAMES[mode], opts, speed: base * speed };
    canvas.setAttribute('aria-label', 'AI ' + cur.name);
  }
  const draw = (t) => {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, design, design);
    paintFrame(ctx, cur.frame(design, t, cur.opts), isDark());
  };
  const loop = () => { if (!running) return; draw((performance.now() / 1000) * cur.speed); raf = requestAnimationFrame(loop); };
  const start = () => { if (running || reduced()) return; running = true; raf = requestAnimationFrame(loop); };
  const stop = () => { running = false; cancelAnimationFrame(raf); };

  setup(state);
  draw(reduced() ? 0.6 : (performance.now() / 1000) * cur.speed);
  // only while it's on screen and the tab is showing
  const io = new IntersectionObserver(([e]) => (e.isIntersecting && !document.hidden ? start() : stop()));
  io.observe(canvas);
  const onVis = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVis);
  return {
    el: canvas,
    set(next) { if (next === cur.name) return; setup(next); if (!running) draw(0.6); },
    destroy() { stop(); io.disconnect(); document.removeEventListener('visibilitychange', onVis); },
  };
}

window.ThinkingOrb = { mount, STATES };
window.dispatchEvent(new Event('thinkingorb:ready'));
