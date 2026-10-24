// Password rules, shared by the server (require) and the pages (<script>), so both always agree.
// passwordRules.check(pw, { email, name }) → { ok, rules: [{ id, label, ok }], problem }
// Any <input data-pw-rules> on a page gets a live checklist under it.
(function (root) {
  // The passwords people pick most often (and the ones that leak first). Compared lowercase.
  const COMMON = new Set(('password password1 password12 password123 passw0rd p@ssw0rd p@ssword welcome welcome1 welcome123 '
    + 'qwerty qwerty1 qwerty123 qwertyuiop asdfgh asdfghjkl zxcvbnm 1q2w3e4r 1qaz2wsx abc12345 abcd1234 iloveyou '
    + 'admin admin123 administrator letmein letmein1 monkey dragon sunshine princess football baseball master '
    + 'superman batman trustno1 starwars whatsapp whatsapp1 whatsapp123 spotmies spotmies1 spotmies123 india123 '
    + 'changeme default secret secret123 test1234 testtest computer internet login123 hello123 freedom').split(' '));

  const BASE = [
    { id: 'length', label: 'At least 8 characters', test: (p) => p.length >= 8 },
    { id: 'case', label: 'An uppercase and a lowercase letter', test: (p) => /[a-z]/.test(p) && /[A-Z]/.test(p) },
    { id: 'digit', label: 'A number or a symbol', test: (p) => /[^A-Za-z\s]/.test(p) },
  ];

  // Things that make a password easy to guess even when it ticks every box above.
  function guessable(p, { email = '', name = '' } = {}) {
    const low = p.toLowerCase();
    if (COMMON.has(low) || COMMON.has(low.replace(/[^a-z0-9@]+$/, ''))) return 'This password is too common. Pick something less predictable.';
    if (new Set(low).size < 4) return 'Use more different characters.';
    const local = String(email).toLowerCase().split('@')[0];
    if (local.length >= 4 && low.includes(local)) return "Don't use your email in your password.";
    const words = String(name).toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
    if (words.some((w) => low.includes(w))) return "Don't use your name in your password.";
    return '';
  }

  function check(pw, who) {
    const p = String(pw || '');
    const rules = BASE.map((r) => ({ id: r.id, label: r.label, ok: r.test(p) }));
    const miss = rules.find((r) => !r.ok);
    const problem = p.length > 128 ? 'Use at most 128 characters.'
      : miss ? `Your password needs: ${rules.filter((r) => !r.ok).map((r) => r.label.toLowerCase()).join(', ')}.`
      : guessable(p, who);
    return { ok: !problem, rules, problem };
  }

  const api = { check };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.passwordRules = api;

  // The live checklist. data-pw-email / data-pw-name point at the inputs holding the email and name.
  // A second input with data-pw-match="#first" is the "confirm password" field.
  // Trying to submit with a password that breaks a rule turns the missing rules red and says why.
  const TICK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const CROSS = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  const noteAfter = (inp) => {
    const note = document.createElement('p');
    note.className = 'pw-note';
    (inp.closest('label') || inp).after(note);
    return note;
  };
  // On a submit every invalid field reports; only the first one takes the focus.
  const firstInvalid = (inp) => !inp.form || inp.form.querySelector(':invalid') === inp;
  function mount(inp) {
    if (inp._pw) return inp._pw;
    const list = document.createElement('ul');
    list.className = 'pw-rules';
    (inp.closest('label') || inp).after(list);
    const note = noteAfter(list);
    // data-pw-email="#id" reads another input; data-email="a@b.c" is a fixed value.
    const val = (sel, fixed) => (sel && document.querySelector(sel)?.value) || fixed || '';
    const who = () => ({ email: val(inp.dataset.pwEmail, inp.dataset.email), name: val(inp.dataset.pwName, inp.dataset.name) });
    let touched = false, shout = false;
    const draw = () => {
      const r = check(inp.value, who());
      list.classList.toggle('shout', shout);
      list.innerHTML = r.rules.map((x) => `<li class="${x.ok ? 'ok' : 'miss'}">${x.ok || !shout ? TICK : CROSS}<span>${x.label}</span></li>`).join('');
      // The list shows what's missing; the line below only covers what it can't (too common, your name, too long).
      note.textContent = (shout || touched) && inp.value && r.rules.every((x) => x.ok) ? r.problem : '';
      inp.classList.toggle('pw-bad', shout && !r.ok);
      inp.setCustomValidity(!r.ok && (inp.value || inp.required) ? r.problem : '');
      return r;
    };
    // Show the problem in the page, not in the browser's little bubble.
    const showErrors = (focus = true) => { shout = true; const r = draw(); if (!r.ok && focus) inp.focus(); return r.ok; };
    inp.addEventListener('invalid', (e) => { e.preventDefault(); showErrors(firstInvalid(inp)); });
    inp.addEventListener('input', () => { touched = true; draw(); });
    draw();
    return (inp._pw = { showErrors, reset: () => { touched = shout = false; draw(); } });
  }
  function mountMatch(inp) {
    if (inp._pw) return inp._pw;
    const first = document.querySelector(inp.dataset.pwMatch);
    const note = noteAfter(inp);
    let shout = false;
    const draw = () => {
      const bad = Boolean(inp.value || shout) && inp.value !== first.value;
      // While typing, wait until it's as long as the password before saying it doesn't match.
      note.textContent = bad && (shout || inp.value.length >= first.value.length) ? "Passwords don't match." : '';
      inp.classList.toggle('pw-bad', Boolean(note.textContent));
      inp.setCustomValidity(bad ? "Passwords don't match." : '');
      return !bad;
    };
    const showErrors = (focus = true) => { shout = true; const ok = draw(); if (!ok && focus) inp.focus(); return ok; };
    inp.addEventListener('invalid', (e) => { e.preventDefault(); showErrors(firstInvalid(inp)); });
    inp.addEventListener('input', draw);
    first.addEventListener('input', () => inp.value && draw());
    draw();
    return (inp._pw = { showErrors, reset: () => { shout = false; draw(); } });
  }
  api.mount = mount;
  api.mountMatch = mountMatch;
  const start = () => {
    document.querySelectorAll('input[data-pw-rules]').forEach(mount);
    document.querySelectorAll('input[data-pw-match]').forEach(mountMatch);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : globalThis);
