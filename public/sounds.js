// SendON's own sounds, made in the browser (Web Audio), so there are no files to load. One for each kind of news:
//   alert    a chat is waiting for you (the AI held a reply, someone needs a person, a browser alert)
//   message  a customer wrote, or other news
//   success  something good (template approved, number OK, campaign done)
//   error    something failed
//   tick     a plain confirmation ("Saved")
// Window.Sound.play(name). Off when the person switched sounds off (Notifications page), kept in this browser.
// Browsers only allow sound after the person has clicked or typed on the page once; before that, nothing plays.

(function () {
  const KEY = 'sendon.sounds';
  let ctx = null;
  const enabled = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
  const audio = () => {
    if (!ctx) { const A = window.AudioContext || window.webkitAudioContext; if (!A) return null; ctx = new A(); }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  };
  // unlock audio on the first click or key press (browsers block sound before that)
  const unlock = () => { audio(); removeEventListener('pointerdown', unlock, true); removeEventListener('keydown', unlock, true); };
  addEventListener('pointerdown', unlock, true);
  addEventListener('keydown', unlock, true);

  // [frequency Hz, start s, length s, wave, loudness]
  const SOUNDS = {
    alert: [[784, 0, 0.16, 'triangle', 0.22], [988, 0.12, 0.16, 'triangle', 0.22], [1319, 0.24, 0.34, 'triangle', 0.24]],
    message: [[880, 0, 0.16, 'sine', 0.2], [1320, 0.09, 0.24, 'sine', 0.16]],
    success: [[1047, 0, 0.12, 'sine', 0.16], [1568, 0.07, 0.26, 'sine', 0.14]],
    error: [[392, 0, 0.16, 'triangle', 0.24], [294, 0.13, 0.32, 'triangle', 0.24]],
    tick: [[1400, 0, 0.05, 'sine', 0.06]],
  };
  const last = {};
  function play(name) {
    const notes = SOUNDS[name];
    if (!notes || !enabled()) return;
    if (Date.now() - (last[name] || 0) < 400) return; // several at once (a burst of updates): one sound
    last[name] = Date.now();
    const c = audio();
    if (!c || c.state !== 'running') return;
    const t0 = c.currentTime + 0.01;
    for (const [f, at, len, wave, vol] of notes) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = wave;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(vol, t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      o.connect(g).connect(c.destination);
      o.start(t0 + at);
      o.stop(t0 + at + len + 0.02);
    }
  }

  // A browser alert came in while SendON is open here (sw.js tells the open windows): play it here too, since the
  // system's own notification sound is up to the computer's settings.
  navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.kind === 'sendon-sound') play(e.data.sound || 'alert'); });

  window.Sound = {
    play,
    enabled,
    set(on) { try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {} if (on) play('success'); },
  };
})();
