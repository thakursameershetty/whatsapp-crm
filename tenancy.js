// Workspaces, accounts and sign-in.
//
// Every business gets its own workspace: its own WhatsApp numbers, templates, contacts,
// campaigns, inbox, AI settings and chats. People sign up with email + password; a workspace
// can have several members. Where it's all saved is up to the store (store.js: Postgres, or
// JSON files when there's no database).
//
// The rest of the app uses one `db` object. Here `db` is a proxy that points at the current
// request's workspace (AsyncLocalStorage), so existing code works unchanged but can only see
// its own workspace. Background work (webhooks, scheduler, startup) runs inside forWorkspace().

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const mail = require('./mail');
const passwordRules = require('./public/password-rules');

const SESSION_DAYS = 30;
// New workspaces may send this many template messages a day until an admin raises it.
const NEW_WORKSPACE_DAILY_LIMIT = Number(process.env.NEW_WORKSPACE_DAILY_LIMIT || 250);
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
const isAdmin = (user) => Boolean(user && ADMIN_EMAILS.includes(String(user.email).toLowerCase()));
const RESET_MINUTES = 60;
const VERIFY_DAYS = 7;
const INVITE_DAYS = 7;

module.exports = function tenancy({ store, defaultDb, appPassword = '', ownerEmail = '' }) {
  const id = () => crypto.randomBytes(8).toString('hex');
  const now = () => new Date().toISOString();
  const als = new AsyncLocalStorage();

  // --- Accounts ---------------------------------------------------------------

  const accounts = store.accounts;
  let accTimer = null;
  function saveAccounts() {
    if (accTimer) return;
    accTimer = setTimeout(() => {
      accTimer = null;
      store.saveAccounts(accounts).catch((e) => console.error('Saving accounts failed:', e.message));
    }, 200);
  }

  // --- Workspaces -------------------------------------------------------------

  const loaded = new Map(); // wsId -> { meta, db, timer }

  // Fill in anything a workspace file is missing (older files, new features).
  function normalize(raw) {
    const db = { ...structuredClone(defaultDb), ...raw, settings: { ...structuredClone(defaultDb.settings), ...(raw.settings || {}) } };
    for (const k of ['senders', 'templates', 'campaigns', 'messages', 'contacts', 'tags', 'notifications', 'aiChats']) db[k] ||= [];
    db.chats ||= {};
    return db;
  }

  function loadWorkspace(meta) {
    const ws = { meta, db: normalize(store.data.get(meta.id) || {}), timer: null };
    loaded.set(meta.id, ws);
    return ws;
  }

  for (const meta of accounts.workspaces) loadWorkspace(meta);

  function createWorkspace(name) {
    const meta = { id: id(), name: String(name || 'My workspace').trim().slice(0, 80) || 'My workspace', createdAt: now(), dailyLimit: NEW_WORKSPACE_DAILY_LIMIT };
    accounts.workspaces.push(meta);
    const ws = loadWorkspace(meta);
    ws.db.settings.webhookVerifyToken = crypto.randomBytes(12).toString('hex');
    saveWorkspace(ws);
    saveAccounts();
    return ws;
  }

  function saveWorkspace(ws) {
    if (ws.timer) return;
    ws.timer = setTimeout(() => {
      ws.timer = null;
      store.saveWorkspace(ws.meta.id, ws.db).catch((e) => console.error(`Saving workspace ${ws.meta.id} failed:`, e.message));
    }, 300);
  }

  const current = () => als.getStore() || null;
  const save = () => { const ws = current(); if (ws) saveWorkspace(ws); };
  const forWorkspace = (ws, fn) => als.run(ws, fn);
  const allWorkspaces = () => [...loaded.values()];
  const byPhoneNumberId = (pnid) => allWorkspaces().find((ws) => ws.db.senders.some((s) => s.phoneNumberId === pnid));

  // Outside any workspace (e.g. while modules are being set up) reads and writes go to a
  // throwaway object, so nothing leaks between workspaces.
  const scratch = normalize({});
  const db = new Proxy({}, {
    get: (_, k) => (current()?.db ?? scratch)[k],
    set: (_, k, v) => { (current()?.db ?? scratch)[k] = v; return true; },
    has: (_, k) => k in (current()?.db ?? scratch),
    ownKeys: () => Reflect.ownKeys(current()?.db ?? scratch),
    getOwnPropertyDescriptor: (_, k) => ({ ...Reflect.getOwnPropertyDescriptor(current()?.db ?? scratch, k), configurable: true }),
  });

  // --- Passwords and sessions -------------------------------------------------

  const hashPassword = (pw) => {
    const salt = crypto.randomBytes(16).toString('hex');
    return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
  };
  const checkPassword = (pw, stored) => {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const a = crypto.scryptSync(String(pw), salt, 64), b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const sameText = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  function startSession(res, userId, wsId) {
    const token = crypto.randomBytes(32).toString('hex');
    accounts.sessions = accounts.sessions.filter((s) => new Date(s.expiresAt) > new Date());
    accounts.sessions.push({ hash: sha(token), userId, wsId, expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString() });
    saveAccounts();
    res.set('Set-Cookie', `ws_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  }
  const cookieToken = (req) => /(?:^|;\s*)ws_sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1] || '';
  const sessionOf = (req) => {
    const t = cookieToken(req);
    if (!t) return null;
    const s = accounts.sessions.find((x) => x.hash === sha(t));
    return s && new Date(s.expiresAt) > new Date() ? s : null;
  };

  const userByEmail = (email) => accounts.users.find((u) => u.email === String(email || '').trim().toLowerCase());
  const membershipsOf = (userId) => accounts.members.filter((m) => m.userId === userId);
  const roleIn = (userId, wsId) => accounts.members.find((m) => m.userId === userId && m.wsId === wsId)?.role || null;
  const legacyUnclaimed = () => accounts.workspaces.find((w) => w.legacy && !accounts.members.some((m) => m.wsId === w.id));

  // A little protection against password guessing: 10 tries per 15 minutes per IP + email.
  const tries = new Map();
  function tooMany(key) {
    const t = (tries.get(key) || []).filter((x) => Date.now() - x < 15 * 60000);
    tries.set(key, t);
    return t.length >= 10;
  }
  const noteTry = (key) => (tries.get(key) || tries.set(key, []).get(key)).push(Date.now());

  // --- Pages --------------------------------------------------------------------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LOGO = `<img class="logo" src="/brand/logo-small.svg" alt="">`;
  function page(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · WhatsApp Sender</title><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@600&display=swap" rel="stylesheet"><link rel="stylesheet" href="/style.css"><link rel="icon" type="image/svg+xml" href="/brand/logo-small.svg">
<script>try{var t=localStorage.getItem('theme')||'light';document.documentElement.dataset.mode=t==='auto'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t}catch(e){}</script></head>
<body class="auth-body">${body}<script src="/gradient-ascii.js"></script><script src="/otp.js"></script><script src="/password-rules.js"></script><script>
// Sign-up: "Send code" emails a confirmation code, then shows the box for it.
(function () {
  var btn = document.getElementById('suSend'); if (!btn) return;
  var email = document.getElementById('suEmail'), wrap = document.getElementById('suCodeWrap'), note = document.getElementById('suCodeNote'), wait = 0, timer;
  function tick() { if (wait > 0) { btn.textContent = 'Resend in ' + wait + 's'; btn.disabled = true; wait--; timer = setTimeout(tick, 1000); } else { btn.textContent = 'Resend code'; btn.disabled = false; } }
  btn.onclick = function () {
    if (!email.checkValidity() || !email.value) { email.reportValidity(); return; }
    btn.disabled = true; btn.textContent = 'Sending…';
    fetch('/signup/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.value }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { btn.disabled = false; btn.textContent = 'Send code'; note.textContent = ''; alert(x.j.error || 'Could not send the code'); return; }
        wrap.classList.remove('hidden'); note.textContent = 'sent to ' + email.value; otp && otp.reset(); hidden.value = ''; otp && otp.focus();
        wait = 30; tick();
      });
  };
  email.addEventListener('input', function () { clearTimeout(timer); wait = 0; btn.disabled = false; btn.textContent = 'Send code'; hidden.value = ''; otp && otp.reset(); });
  // Confirmed: the code row and the Resend button fold away, and the email gets a green tick.
  function done() {
    clearTimeout(timer);
    email.readOnly = true;
    btn.style.width = btn.offsetWidth + 'px'; btn.tabIndex = -1;
    wrap.style.height = wrap.offsetHeight + 'px';
    void wrap.offsetHeight;
    document.getElementById('suEmailRow').classList.add('is-verified');
    wrap.classList.add('folding'); wrap.style.height = '0px';
    setTimeout(function () { wrap.classList.add('hidden'); wrap.classList.remove('folding'); wrap.style.height = ''; }, 500);
  }
  // The code row: each full code is checked with the server; a right one fuses into "Verified".
  var hidden = document.getElementById('suCode'), otp = window.OneTimeCode && OneTimeCode.mount(document.getElementById('suOtp'), {
    length: 6,
    align: 'start',
    check: function (code) {
      return fetch('/signup/code/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.value, code: code }) }).then(function (r) { return r.ok; });
    },
    onVerified: function (code) { hidden.value = code; setTimeout(done, 1100); },
    onChange: function () { hidden.value = ''; },
  });
  document.querySelector('form[action="/signup"]').addEventListener('submit', function (e) {
    if (!hidden.value) { e.preventDefault(); wrap.classList.remove('hidden'); if (otp) otp.focus(); note.textContent = btn.textContent === 'Send code' ? 'click Send code first' : 'enter the code from your email'; }
  });
})();
// Confirm-email page: the same code row; a right code goes straight into the app.
(function () {
  var el = document.getElementById('gateOtp'); if (!el || !window.OneTimeCode) return;
  var err = document.getElementById('gateErr');
  var otp = OneTimeCode.mount(el, {
    length: 6,
    check: function (code) {
      return fetch('/verify/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }) }).then(function (r) { err.classList.toggle('hidden', r.ok); return r.ok; });
    },
    onVerified: function () { setTimeout(function () { location.href = '/'; }, 900); },
  });
  otp.focus();
})();
// The page background: the same faint time-of-day sky as the Assistant's start page.
(function () {
  var SKY = [[0, 265, 0.07], [4.5, 265, 0.07], [6.5, 70, 0.12], [9, 85, 0.08], [12, 90, 0.035], [15.5, 80, 0.06], [18.5, 45, 0.11], [20, 330, 0.07], [21.5, 265, 0.07], [24, 265, 0.07]];
  var d = new Date(), t = d.getHours() + d.getMinutes() / 60, i = 0;
  while (i < SKY.length - 2 && t >= SKY[i + 1][0]) i++;
  var a = SKY[i], b = SKY[i + 1], f = (t - a[0]) / (b[0] - a[0]), dh = ((b[1] - a[1] + 540) % 360) - 180;
  document.body.style.setProperty('--sky-h', ((a[1] + dh * f + 360) % 360).toFixed(1));
  document.body.style.setProperty('--sky-c', (a[2] + (b[2] - a[2]) * f).toFixed(3));
})();
// The left panel: a drifting ASCII light (falls back to the CSS gradient without WebGL2).
var art = document.querySelector('.auth-art');
if (art && window.GradientASCII) { var host = document.createElement('div'); host.className = 'auth-ascii'; art.prepend(host); if (!GradientASCII.mount(host, { colors: ['#494949', '#eef2ff', '#ffffff', '#7e7e7e'], shape: 'pinch', characters: ' =+xX0S8#@', cellSize: 16, density: 0.8, glow: 0.25, grain: 0.06 })) host.remove(); else art.classList.add('has-ascii'); }
</script><script>
// Show/hide toggle on every password field.
var EYE='<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
var OFF='<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2"/><path d="M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/></svg>';
document.querySelectorAll('input[type=password]').forEach(function(inp){
  var wrap=document.createElement('span'); wrap.className='pw-wrap'; inp.parentNode.insertBefore(wrap,inp); wrap.appendChild(inp);
  var b=document.createElement('button'); b.type='button'; b.className='pw-eye'; b.innerHTML=EYE; b.setAttribute('aria-label','Show password'); b.title='Show password';
  b.onclick=function(){var show=inp.type==='password'; inp.type=show?'text':'password'; b.innerHTML=show?OFF:EYE; var l=show?'Hide password':'Show password'; b.setAttribute('aria-label',l); b.title=l; inp.focus();};
  wrap.appendChild(b);
});
</script></body></html>`;
  }
  const brand = `<div class="brand">${LOGO}<span class="brand-name">WhatsApp Sender</span></div>`;
  // Two-panel card: a gradient panel with a headline on the left, the form on the right.
  const shell = ({ kicker, headline, form }) => `<main class="auth-card">
  <aside class="auth-art" aria-hidden="true">
    <div class="auth-art-logo">${LOGO}<span>WhatsApp Sender</span></div>
    <div class="auth-art-text"><p>${esc(kicker)}</p><h2>${esc(headline)}</h2></div>
  </aside>
  <section class="auth-form">${form}</section>
</main>`;
  const mark = `<span class="auth-mark">${LOGO}</span>`;

  function loginPage({ error = '', email = '', next = '', notice = '' } = {}) {
    return page('Sign in', shell({
      kicker: 'Welcome back',
      headline: 'Pick up right where you left off.',
      form: `<form method="post" action="/login" class="auth-fields">${mark}
<h1>Sign in</h1>
<p class="auth-sub">Your campaigns and chats are waiting.</p>
<label>Your email<input type="email" name="email" value="${esc(email)}" autocomplete="email" placeholder="you@company.com" required autofocus></label>
<label><span class="auth-label-row">Password<a href="/forgot${email ? `?email=${encodeURIComponent(email)}` : ''}" class="auth-forgot">Forgot password?</a></span><input type="password" name="password" autocomplete="current-password" placeholder="Your password" required></label>
<input type="hidden" name="next" value="${esc(next)}">
${notice ? `<p class="auth-notice">${esc(notice)}</p>` : ''}${error ? `<p class="login-error">${esc(error)}</p>` : ''}<button class="auth-btn" type="submit">Sign in</button>
<p class="login-alt">Don't have an account? <a href="/signup${next ? `?next=${encodeURIComponent(next)}` : ''}">Create one</a></p></form>`,
    }));
  }

  function signupPage({ error = '', name = '', email = '', business = '', next = '', invite = null, codeSent = false, verified = '' } = {}) {
    const legacy = !invite && legacyUnclaimed();
    return page('Create account', shell({
      kicker: invite ? `Join ${invite.wsName}` : 'Start free',
      headline: invite ? 'One inbox. One team. Every campaign.' : 'WhatsApp marketing that runs itself.',
      form: `<form method="post" action="/signup" class="auth-fields">${mark}
<h1>${invite ? `Join ${esc(invite.wsName)}` : 'Create your account'}</h1>
<p class="auth-sub">${invite ? `You were invited to the ${esc(invite.wsName)} workspace.` : 'Set up in minutes. No credit card.'}</p>
<div class="auth-row">
<label>Your name<input name="name" id="suName" value="${esc(name)}" autocomplete="name" placeholder="Full name" required autofocus></label>
${invite ? '' : `<label>Business name<input name="business" value="${esc(business)}" placeholder="e.g. Spotmies" required></label>`}
</div>
<label>Your email<span class="auth-inline${verified ? ' is-verified' : ''}" id="suEmailRow"><span class="auth-email"><input type="email" name="email" id="suEmail" value="${esc(email || invite?.email || '')}" autocomplete="email" placeholder="you@company.com" required${verified ? ' readonly' : ''}><svg class="auth-tick" viewBox="0 0 24 24" aria-label="Email confirmed" role="img"><circle cx="12" cy="12" r="10"/><path d="m7.8 12.4 2.8 2.8 5.6-5.8"/></svg></span><button type="button" class="auth-send" id="suSend"${verified ? ' tabindex="-1"' : ''}>Send code</button></span></label>
<div id="suCodeWrap" ${codeSent && !verified ? '' : 'class="hidden"'}><span class="auth-otp-label">Confirmation code <span class="opt" id="suCodeNote">sent to your email</span></span><div class="auth-otp" id="suOtp"></div><input type="hidden" name="code" id="suCode" value="${esc(verified)}"></div>
<label>Password<input type="password" name="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="Create a password" required id="suPw" data-pw-rules data-pw-email="#suEmail" data-pw-name="#suName"></label>
<label>Confirm password<input type="password" name="confirm" autocomplete="new-password" maxlength="128" placeholder="Type it again" required data-pw-match="#suPw"></label>
${legacy ? `<label>Existing app password <span class="opt">only if you used this app before</span><input type="password" name="legacy" autocomplete="off" placeholder="Keeps your existing ${esc(legacy.name)} data"></label>` : ''}
<input type="hidden" name="next" value="${esc(next)}">
${error ? `<p class="login-error">${esc(error)}</p>` : ''}<button class="auth-btn" type="submit">${invite ? 'Join workspace' : 'Get started'}</button>
<p class="login-alt">Already have an account? <a href="/login${next ? `?next=${encodeURIComponent(next)}` : ''}">Sign in</a></p></form>`,
    }));
  }

  function forgotPage({ email = '', sent = false, error = '' } = {}) {
    return page('Reset password', shell({
      kicker: 'Forgot password',
      headline: 'It happens. Let’s get you back in.',
      form: sent
        ? `<div class="auth-fields">${mark}<h1>Check your email</h1><p class="auth-sub">If an account exists for <b>${esc(email)}</b>, we sent a link to reset the password. It works for 1 hour.</p><a class="auth-btn" href="/login">Back to sign in</a></div>`
        : `<form method="post" action="/forgot" class="auth-fields">${mark}
<h1>Reset your password</h1>
<p class="auth-sub">Enter your email and we'll send you a link to choose a new password.</p>
<label>Your email<input type="email" name="email" value="${esc(email)}" autocomplete="email" placeholder="you@company.com" required autofocus></label>
${error ? `<p class="login-error">${esc(error)}</p>` : ''}<button class="auth-btn" type="submit">Send reset link</button>
<p class="login-alt">Remembered it? <a href="/login">Sign in</a></p></form>`,
    }));
  }
  function resetPage({ token, error = '', email = '' }) {
    return page('New password', shell({
      kicker: 'Almost there',
      headline: 'Choose a new password.',
      form: `<form method="post" action="/reset/${esc(token)}" class="auth-fields">${mark}
<h1>Choose a new password</h1>
<p class="auth-sub">You'll be signed out everywhere else.</p>
<label>New password<input type="password" name="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="New password" required autofocus id="rsPw" data-pw-rules data-email="${esc(email)}"></label>
<label>Confirm new password<input type="password" name="confirm" autocomplete="new-password" maxlength="128" placeholder="Type it again" required data-pw-match="#rsPw"></label>
${error ? `<p class="login-error">${esc(error)}</p>` : ''}<button class="auth-btn" type="submit">Save password</button></form>`,
    }));
  }
  const messagePage = (title, heading, text, cta = '<a class="auth-btn" href="/">Open the app</a>') =>
    page(title, shell({ kicker: title, headline: heading, form: `<div class="auth-fields">${mark}<h1>${esc(heading)}</h1><p class="auth-sub">${text}</p>${cta}</div>` }));

  // One-time links (reset password, confirm email): only a hash is stored, on the user.
  function issueToken(user, kind, ms) {
    const token = crypto.randomBytes(24).toString('hex');
    user[kind] = { hash: sha(token), expiresAt: new Date(Date.now() + ms).toISOString() };
    saveAccounts();
    return token;
  }
  const userByToken = (kind, token) => accounts.users.find((u) => u[kind] && u[kind].hash === sha(String(token || '')) && new Date(u[kind].expiresAt) > new Date());
  // 6-digit email codes: kept in memory (hash only) for 10 minutes, 5 tries each.
  const codes = new Map(); // email → { hash, expiresAt, tries }
  function sendCode(email) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    codes.set(email, { hash: sha(email + ':' + code), expiresAt: Date.now() + 10 * 60000, tries: 0 });
    mail.code(email, code);
  }
  // consume: false checks it (counting the try) but keeps it for the real submit.
  function checkCode(email, code, { consume = true } = {}) {
    const c = codes.get(email);
    if (!c || c.expiresAt < Date.now()) return 'That code has expired. Send a new one.';
    if (++c.tries > 5) { codes.delete(email); return 'Too many wrong codes. Send a new one.'; }
    if (!sameText(c.hash, sha(email + ':' + String(code || '').replace(/\D/g, '')))) return 'That code isn’t right. Check the email and try again.';
    if (consume) codes.delete(email);
    else c.tries--; // a right answer doesn't use up a try
    return null;
  }

  // Signed in but the email isn't confirmed yet: this page is all they can use.
  function verifyGatePage(user, { error = '', sent = false } = {}) {
    return page('Confirm email', shell({
      kicker: 'One last step',
      headline: 'Confirm your email to continue.',
      form: `<form method="post" action="/verify/code" class="auth-fields">${mark}
<h1>Confirm your email</h1>
<p class="auth-sub">We ${sent ? 'just sent' : 'sent'} a 6-digit code to <b>${esc(user.email)}</b>. Enter it below. The email also has a link you can click instead.</p>
<div class="auth-otp" id="gateOtp"></div><input type="hidden" name="code" id="gateCode">
${error ? `<p class="login-error">${esc(error)}</p>` : ''}<p class="login-error hidden" id="gateErr">That code isn’t right. Check the email and try again.</p>
<p class="login-alt"><button type="submit" form="resendForm" class="auth-link">Send a new code</button> · <a href="/logout">Log out</a></p></form>
<form id="resendForm" method="post" action="/verify/resend"></form>`,
    }));
  }

  function sendVerify(req, user) {
    const token = issueToken(user, 'verifyToken', VERIFY_DAYS * 86400000);
    mail.verify(user.email, user.name, `${mail.baseUrl(req)}/verify/${token}`);
  }

  const safeNext = (n) => (/^\/[^/\\]/.test(String(n || '')) ? String(n) : '/');
  const inviteFor = (token) => {
    const inv = accounts.invites.find((i) => i.hash === sha(String(token || '')) && new Date(i.expiresAt) > new Date());
    if (!inv) return null;
    return { ...inv, wsName: accounts.workspaces.find((w) => w.id === inv.wsId)?.name || 'a workspace' };
  };
  function acceptInvite(inv, userId) {
    if (!roleIn(userId, inv.wsId)) accounts.members.push({ wsId: inv.wsId, userId, role: inv.role || 'member', joinedAt: now() });
    accounts.invites = accounts.invites.filter((i) => i.hash !== inv.hash);
    saveAccounts();
  }
  const inviteFromNext = (next) => inviteFor(/^\/invite\/([a-f0-9]{48})$/.exec(String(next || ''))?.[1]);

  // --- Routes -------------------------------------------------------------------

  function mountAuth(app, express) {
    const form = express.urlencoded({ extended: false });

    app.get('/login', (req, res) => (sessionOf(req) ? res.redirect(safeNext(req.query.next)) : res.send(loginPage({ next: req.query.next }))));
    app.post('/login', form, (req, res) => {
      const email = String(req.body.email || '').trim().toLowerCase();
      const key = `${req.ip}|${email}`;
      const next = req.body.next;
      if (tooMany(key)) return res.status(429).send(loginPage({ error: 'Too many attempts. Try again in a few minutes.', email, next }));
      const user = userByEmail(email);
      if (!user || !checkPassword(req.body.password, user.password)) { noteTry(key); return res.status(401).send(loginPage({ error: 'Wrong email or password', email, next })); }
      const inv = inviteFromNext(next);
      if (inv) acceptInvite(inv, user.id);
      const ws = inv?.wsId || user.lastWsId || membershipsOf(user.id)[0]?.wsId;
      if (!ws) return res.status(403).send(loginPage({ error: 'Your account has no workspace. Ask for a new invite.', email }));
      startSession(res, user.id, ws);
      res.redirect(inv ? '/' : safeNext(next));
    });

    app.get('/signup', (req, res) => res.send(signupPage({ next: req.query.next, invite: inviteFromNext(req.query.next) })));
    app.post('/signup', form, (req, res) => {
      const { name = '', password = '', business = '', legacy = '', next = '' } = req.body;
      const email = String(req.body.email || '').trim().toLowerCase();
      const invite = inviteFromNext(next);
      // A page that comes back with another error keeps a confirmed email confirmed.
      const again = (error) => res.status(400).send(signupPage({ error, name, email, business, next, invite, verified: req.body.code && !checkCode(email, req.body.code, { consume: false }) ? String(req.body.code) : '' }));
      if (tooMany(`${req.ip}|signup`)) return again('Too many attempts. Try again in a few minutes.');
      noteTry(`${req.ip}|signup`);
      if (!String(name).trim()) return again('Enter your name');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return again('Enter a valid email');
      const weak = passwordRules.check(password, { email, name }).problem;
      if (weak) return again(weak);
      if (req.body.confirm !== password) return again("The two passwords don't match");
      if (userByEmail(email)) return again('An account with this email already exists. Sign in instead.');
      if (!invite && !String(business).trim()) return again('Enter your business name');
      // The email is confirmed before the account exists: the code we sent must match.
      const codeErr = checkCode(email, req.body.code);
      if (codeErr) return res.status(400).send(signupPage({ error: req.body.code ? codeErr : 'Click “Send code” and enter the code from your email', name, email, business, next, invite, codeSent: Boolean(codes.get(email)) }));

      // Keeping the data from before accounts existed: prove it with the old app password
      // (or be the OWNER_EMAIL). Otherwise everyone starts with a fresh workspace.
      const old = !invite && legacyUnclaimed();
      // With neither variable set, only a local copy (not a hosted one) lets the first sign-up take it.
      const hosted = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production');
      const claims = old && ((legacy && appPassword && sameText(String(legacy), appPassword)) || (ownerEmail && email === ownerEmail.toLowerCase()) || (!appPassword && !ownerEmail && !hosted));
      if (old && legacy && !claims) return again('That app password is wrong. Leave it empty to start a fresh workspace.');

      const user = { id: id(), name: String(name).trim().slice(0, 80), email, password: hashPassword(password), createdAt: now(), emailVerified: true };
      accounts.users.push(user);
      let wsId;
      if (invite) { acceptInvite(invite, user.id); wsId = invite.wsId; }
      else if (claims) {
        old.name = String(business).trim().slice(0, 80) || old.name;
        accounts.members.push({ wsId: old.id, userId: user.id, role: 'owner', joinedAt: now() });
        wsId = old.id;
      } else {
        const ws = createWorkspace(business);
        accounts.members.push({ wsId: ws.meta.id, userId: user.id, role: 'owner', joinedAt: now() });
        wsId = ws.meta.id;
      }
      user.lastWsId = wsId;
      saveAccounts();
      startSession(res, user.id, wsId);
      res.redirect('/');
    });

    // Sign-up: email a code as soon as they've typed their email.
    app.post('/signup/code', express.json(), (req, res) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email first' });
      if (userByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
      if (tooMany(`${req.ip}|code`) || tooMany(`${email}|code`)) return res.status(429).json({ error: 'Too many codes. Try again in a few minutes.' });
      noteTry(`${req.ip}|code`); noteTry(`${email}|code`);
      sendCode(email);
      res.json({ ok: true, mail: mail.enabled() });
    });

    // The code row checks each full code as it's typed (kept for the real submit).
    app.post('/signup/code/check', express.json(), (req, res) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const err = checkCode(email, req.body?.code, { consume: false });
      res.status(err ? 400 : 200).json(err ? { ok: false, error: err } : { ok: true });
    });

    // The confirm-email gate (signed in, email not confirmed).
    const gateUser = (req) => { const s = sessionOf(req); return s && accounts.users.find((u) => u.id === s.userId); };
    app.get('/verify', (req, res) => {
      const u = gateUser(req);
      if (!u) return res.redirect('/login');
      if (u.emailVerified !== false) return res.redirect('/');
      res.send(verifyGatePage(u));
    });
    app.post('/verify/code', form, express.json(), (req, res) => {
      const u = gateUser(req);
      const json = req.is('application/json');
      if (!u) return json ? res.status(401).json({ ok: false }) : res.redirect('/login');
      const err = checkCode(u.email, req.body.code);
      if (err) return json ? res.status(400).json({ ok: false, error: err }) : res.status(400).send(verifyGatePage(u, { error: err }));
      u.emailVerified = true;
      delete u.verifyToken;
      saveAccounts();
      json ? res.json({ ok: true }) : res.redirect('/');
    });
    app.post('/verify/resend', form, (req, res) => {
      const u = gateUser(req);
      if (!u) return res.redirect('/login');
      if (tooMany(`${u.id}|verify`)) return res.status(429).send(verifyGatePage(u, { error: 'Too many codes. Try again in a few minutes.' }));
      noteTry(`${u.id}|verify`);
      sendCode(u.email);
      sendVerify(req, u);
      res.send(verifyGatePage(u, { sent: true }));
    });

    // Forgot password → email a one-hour link. The page never says whether the email exists.
    app.get('/forgot', (req, res) => res.send(forgotPage({ email: req.query.email || '' })));
    app.post('/forgot', form, (req, res) => {
      const email = String(req.body.email || '').trim().toLowerCase();
      if (tooMany(`${req.ip}|forgot`)) return res.status(429).send(forgotPage({ email, error: 'Too many attempts. Try again in a few minutes.' }));
      noteTry(`${req.ip}|forgot`);
      const user = userByEmail(email);
      if (user) mail.reset(user.email, `${mail.baseUrl(req)}/reset/${issueToken(user, 'resetToken', RESET_MINUTES * 60000)}`);
      res.send(forgotPage({ email, sent: true }));
    });
    app.get('/reset/:token', (req, res) => {
      if (!userByToken('resetToken', req.params.token)) return res.status(404).send(messagePage('Reset password', 'This link has expired', 'Reset links work for 1 hour and only once. Ask for a new one.', '<a class="auth-btn" href="/forgot">Send a new link</a>'));
      res.send(resetPage({ token: req.params.token, email: userByToken('resetToken', req.params.token).email }));
    });
    app.post('/reset/:token', form, (req, res) => {
      const user = userByToken('resetToken', req.params.token);
      if (!user) return res.status(404).send(messagePage('Reset password', 'This link has expired', 'Reset links work for 1 hour and only once. Ask for a new one.', '<a class="auth-btn" href="/forgot">Send a new link</a>'));
      const weak = passwordRules.check(req.body.password, user).problem;
      if (weak) return res.status(400).send(resetPage({ token: req.params.token, error: weak, email: user.email }));
      if (req.body.confirm !== req.body.password) return res.status(400).send(resetPage({ token: req.params.token, error: "The two passwords don't match", email: user.email }));
      user.password = hashPassword(String(req.body.password));
      delete user.resetToken;
      user.emailVerified = true; // they proved they can read this inbox
      accounts.sessions = accounts.sessions.filter((x) => x.userId !== user.id); // signed out everywhere
      saveAccounts();
      res.send(loginPage({ email: user.email, notice: 'Password changed. Sign in with your new password.' }));
    });

    // Confirm email address.
    app.get('/verify/:token', (req, res) => {
      const user = userByToken('verifyToken', req.params.token);
      if (!user) return res.status(404).send(messagePage('Confirm email', 'This link has expired', 'Sign in and send a new confirmation link from the banner at the top of the app.'));
      user.emailVerified = true;
      delete user.verifyToken;
      saveAccounts();
      res.send(messagePage('Confirm email', 'Email confirmed', `Thanks, <b>${esc(user.email)}</b> is confirmed.`));
    });

    app.get('/invite/:token', (req, res) => {
      const inv = inviteFor(req.params.token);
      if (!inv) return res.status(404).send(page('Invite', shell({ kicker: 'Invite', headline: 'Invites last 7 days so links can’t be reused forever.', form: `<div class="auth-fields">${mark}<h1>This invite has expired</h1><p class="auth-sub">Ask whoever invited you to send a new link.</p><a class="auth-btn" href="/login">Sign in</a></div>` })));
      const s = sessionOf(req);
      if (s) { acceptInvite(inv, s.userId); s.wsId = inv.wsId; saveAccounts(); return res.redirect('/'); }
      const next = `/invite/${req.params.token}`;
      res.redirect(userByEmail(inv.email) ? `/login?next=${encodeURIComponent(next)}` : `/signup?next=${encodeURIComponent(next)}`);
    });

    app.get('/logout', (req, res) => {
      const t = cookieToken(req);
      if (t) { accounts.sessions = accounts.sessions.filter((s) => s.hash !== sha(t)); saveAccounts(); }
      res.set('Set-Cookie', 'ws_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      res.redirect('/login');
    });
  }

  // Everything else needs a signed-in member; the request then runs inside its workspace.
  // (Basic auth also works for scripts: curl -u email:password.)
  function requireAuth(req, res, next) {
    let userId = null, wsId = null, session = null;
    session = sessionOf(req);
    if (session) { userId = session.userId; wsId = session.wsId; }
    else {
      const [scheme, b64] = (req.headers.authorization || '').split(' ');
      if (scheme === 'Basic' && b64) {
        const raw = Buffer.from(b64, 'base64').toString();
        const user = userByEmail(raw.slice(0, raw.indexOf(':')));
        if (user && checkPassword(raw.slice(raw.indexOf(':') + 1), user.password)) { userId = user.id; wsId = user.lastWsId || membershipsOf(user.id)[0]?.wsId; }
      }
    }
    if (userId && wsId && !roleIn(userId, wsId)) wsId = membershipsOf(userId)[0]?.wsId || null; // removed from that workspace
    const ws = wsId && loaded.get(wsId);
    if (!userId || !ws) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Signed out — reload the page to sign in' });
      return res.redirect('/login' + (req.path !== '/' ? `?next=${encodeURIComponent(req.originalUrl)}` : ''));
    }
    if (session && session.wsId !== wsId) { session.wsId = wsId; saveAccounts(); }
    req.user = accounts.users.find((u) => u.id === userId);
    req.admin = isAdmin(req.user);
    // Nothing works until the email is confirmed (new sign-ups confirm with a code first).
    if (req.user.emailVerified === false && req.path !== '/api/me') {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Confirm your email first', verify: true });
      return res.redirect('/verify');
    }
    // A suspended workspace is closed to its members (admins can still look in).
    if (ws.meta.suspended && !req.admin) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'This workspace is suspended. Contact support.' });
      return res.status(403).send(messagePage('Suspended', 'This workspace is suspended', 'Sending and the dashboard are paused for this workspace. If you think this is a mistake, contact support.', '<a class="auth-btn" href="/logout">Log out</a>'));
    }
    req.role = roleIn(userId, wsId);
    req.session = session;
    als.run(ws, next);
  }

  // Account, workspace and team endpoints (inside a workspace).
  function mountAccountApi(app, { wrap, fail }) {
    const ownerOnly = (req) => { if (req.role !== 'owner') throw fail('Only the workspace owner can do that', 403); };
    const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

    app.get('/api/me', (req, res) => {
      const ws = current();
      res.json({
        user: { ...publicUser(req.user), emailVerified: req.user.emailVerified !== false, createdAt: req.user.createdAt, deletionRequest: req.user.deletionRequest || null },
        admin: req.admin,
        mail: mail.enabled(),
        role: req.role,
        workspace: { id: ws.meta.id, name: ws.meta.name },
        workspaces: membershipsOf(req.user.id).map((m) => ({ id: m.wsId, name: accounts.workspaces.find((w) => w.id === m.wsId)?.name, role: m.role })),
      });
    });

    app.patch('/api/workspace', wrap((req, res) => {
      ownerOnly(req);
      const name = String(req.body.name || '').trim().slice(0, 80);
      if (!name) throw fail('Give the workspace a name');
      current().meta.name = name;
      saveAccounts();
      res.json({ name });
    }));

    app.post('/api/workspaces', wrap((req, res) => {
      const ws = createWorkspace(req.body.name);
      accounts.members.push({ wsId: ws.meta.id, userId: req.user.id, role: 'owner', joinedAt: now() });
      if (req.session) req.session.wsId = ws.meta.id;
      req.user.lastWsId = ws.meta.id;
      saveAccounts();
      res.json({ id: ws.meta.id, name: ws.meta.name });
    }));

    app.post('/api/workspace/switch', wrap((req, res) => {
      const wsId = String(req.body.id || '');
      if (!roleIn(req.user.id, wsId) || !loaded.get(wsId)) throw fail('You are not a member of that workspace', 403);
      if (req.session) req.session.wsId = wsId;
      req.user.lastWsId = wsId;
      saveAccounts();
      res.json({ ok: true });
    }));

    app.get('/api/team', (req, res) => {
      const wsId = current().meta.id;
      res.json({
        members: accounts.members.filter((m) => m.wsId === wsId).map((m) => ({ ...publicUser(accounts.users.find((u) => u.id === m.userId) || {}), role: m.role, joinedAt: m.joinedAt, you: m.userId === req.user.id })),
        invites: req.role === 'owner' ? accounts.invites.filter((i) => i.wsId === wsId && new Date(i.expiresAt) > new Date()).map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt })) : [],
        role: req.role,
      });
    });

    // The link is shown to the owner to share (no email is sent).
    app.post('/api/team/invites', wrap((req, res) => {
      ownerOnly(req);
      const email = String(req.body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Enter a valid email');
      const wsId = current().meta.id;
      const existing = userByEmail(email);
      if (existing && roleIn(existing.id, wsId)) throw fail('They are already in this workspace');
      const token = crypto.randomBytes(24).toString('hex');
      accounts.invites = accounts.invites.filter((i) => !(i.wsId === wsId && i.email === email));
      accounts.invites.push({ id: id(), hash: sha(token), wsId, email, role: req.body.role === 'owner' ? 'owner' : 'member', invitedBy: req.user.id, expiresAt: new Date(Date.now() + INVITE_DAYS * 86400000).toISOString() });
      saveAccounts();
      const link = `${mail.baseUrl(req)}/invite/${token}`;
      mail.invite(email, req.user.name || req.user.email, current().meta.name, link);
      res.json({ link, expiresInDays: INVITE_DAYS, emailed: mail.enabled() });
    }));

    app.delete('/api/team/invites/:id', wrap((req, res) => {
      ownerOnly(req);
      accounts.invites = accounts.invites.filter((i) => !(i.id === req.params.id && i.wsId === current().meta.id));
      saveAccounts();
      res.json({ ok: true });
    }));

    app.delete('/api/team/members/:userId', wrap((req, res) => {
      const wsId = current().meta.id;
      const self = req.params.userId === req.user.id;
      if (!self) ownerOnly(req);
      const owners = accounts.members.filter((m) => m.wsId === wsId && m.role === 'owner');
      if (owners.length === 1 && owners[0].userId === req.params.userId) throw fail('A workspace needs an owner. Make someone else owner first.');
      accounts.members = accounts.members.filter((m) => !(m.wsId === wsId && m.userId === req.params.userId));
      accounts.sessions = accounts.sessions.filter((s) => !(s.userId === req.params.userId && s.wsId === wsId));
      saveAccounts();
      res.json({ ok: true });
    }));

    app.patch('/api/team/members/:userId', wrap((req, res) => {
      ownerOnly(req);
      const m = accounts.members.find((x) => x.wsId === current().meta.id && x.userId === req.params.userId);
      if (!m) throw fail('Not a member', 404);
      const role = req.body.role === 'owner' ? 'owner' : 'member';
      if (m.role === 'owner' && role === 'member' && accounts.members.filter((x) => x.wsId === m.wsId && x.role === 'owner').length === 1) throw fail('A workspace needs at least one owner');
      m.role = role;
      saveAccounts();
      res.json({ ok: true });
    }));

    // Your own name and email. Only you can change them; a new email needs your password and a fresh confirmation.
    app.patch('/api/account', wrap((req, res) => {
      const u = req.user;
      if (req.body.name != null) {
        const name = String(req.body.name).trim().slice(0, 80);
        if (!name) throw fail('Enter your name');
        u.name = name;
      }
      if (req.body.email != null) {
        const email = String(req.body.email).trim().toLowerCase();
        if (email !== u.email) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Enter a valid email');
          if (!checkPassword(req.body.current, u.password)) throw fail('Your current password is wrong');
          if (userByEmail(email)) throw fail('Another account already uses that email');
          const old = u.email;
          u.email = email;
          u.emailVerified = false;
          delete u.resetToken;
          mail.emailChanged(old, email, `${mail.baseUrl(req)}/login`);
          sendCode(email);
          sendVerify(req, u);
        }
      }
      saveAccounts();
      res.json({ user: { ...publicUser(u), emailVerified: u.emailVerified !== false } });
    }));

    // --- Admin (people listed in ADMIN_EMAILS): every workspace, its usage, suspend and limits.
    const adminOnly = (req) => { if (!req.admin) throw fail('Admins only', 403); };
    app.get('/api/admin/workspaces', wrap((req, res) => {
      adminOnly(req);
      const day = Date.now() - 86400000, month = Date.now() - 30 * 86400000;
      const after = (ts, t) => ts && Date.parse(ts) >= t;
      res.json(allWorkspaces().map((ws) => {
        const d = ws.db, m = ws.meta;
        const recips = d.campaigns.filter((c) => !c.demo).flatMap((c) => c.recipients || []); // real sends only
        const sent = (t) => recips.filter((r) => after(r.sentAt, t)).length + d.messages.filter((x) => x.dir === 'out' && x.type === 'template' && !x.demo && after(x.ts, t)).length;
        const failed30 = recips.filter((r) => r.status === 'failed' && after(r.failedAt || r.sentAt, month)).length;
        const last = [...d.messages.filter((x) => !x.demo).map((x) => x.ts), ...d.campaigns.filter((c) => !c.demo).map((c) => c.startedAt || c.createdAt)].filter(Boolean).sort().at(-1) || null;
        return {
          id: m.id, name: m.name, createdAt: m.createdAt, suspended: Boolean(m.suspended), dailyLimit: m.dailyLimit ?? null, legacy: Boolean(m.legacy),
          members: accounts.members.filter((x) => x.wsId === m.id).map((x) => { const u = accounts.users.find((y) => y.id === x.userId); return { email: u?.email, role: x.role }; }),
          demoMode: Boolean(d.settings.demoMode), numbers: d.senders.filter((s) => !s.seed).length, contacts: d.contacts.length,
          campaigns: d.campaigns.filter((c) => !c.demo).length, sent24h: sent(day), sent30d: sent(month), failed30d: failed30, lastActivity: last,
        };
      }).sort((a, b) => String(b.lastActivity || b.createdAt).localeCompare(String(a.lastActivity || a.createdAt))));
    }));
    app.patch('/api/admin/workspaces/:id', wrap((req, res) => {
      adminOnly(req);
      const ws = loaded.get(req.params.id);
      if (!ws) throw fail('Workspace not found', 404);
      if (typeof req.body.suspended === 'boolean') {
        ws.meta.suspended = req.body.suspended;
        if (req.body.suspended) ws.meta.suspendedAt = now(); else delete ws.meta.suspendedAt;
      }
      if ('dailyLimit' in req.body) {
        const n = req.body.dailyLimit === null || req.body.dailyLimit === '' ? null : Math.max(0, Math.floor(Number(req.body.dailyLimit)));
        if (n !== null && !Number.isFinite(n)) throw fail('Enter a number, or leave it empty for no limit');
        ws.meta.dailyLimit = n;
      }
      saveAccounts();
      res.json({ ok: true });
    }));

    // --- Account deletion: the person asks, an admin follows up and does it -------------
    const REASONS = { 'not-using': 'Not using it any more', 'too-expensive': 'Too expensive', 'missing-feature': 'Missing something I need', 'other-tool': 'Switching to another tool', 'testing': 'Was only trying it out', 'privacy': 'Privacy concerns', other: 'Something else' };
    // What deleting this person would do to each workspace they belong to.
    function deletionPlan(user) {
      return membershipsOf(user.id).map((m) => {
        const ws = loaded.get(m.wsId), others = accounts.members.filter((x) => x.wsId === m.wsId && x.userId !== user.id);
        const name = ws?.meta.name || 'Unknown workspace';
        if (ws?.meta.legacy && !others.length) return { wsId: m.wsId, name, action: 'detach', text: 'Original workspace: the data is kept, nobody is in it any more' };
        if (!others.length) return { wsId: m.wsId, name, action: 'delete', text: 'Deleted with all its data (only member)' };
        if (m.role === 'owner' && !others.some((x) => x.role === 'owner')) {
          const heir = [...others].sort((a, b) => String(a.joinedAt || '').localeCompare(String(b.joinedAt || '')))[0];
          return { wsId: m.wsId, name, action: 'handover', heir: heir.userId, text: `Kept; ${accounts.users.find((u) => u.id === heir.userId)?.email || 'a teammate'} becomes the owner` };
        }
        return { wsId: m.wsId, name, action: 'leave', text: 'Kept; they are removed from the team' };
      });
    }
    async function deleteAccount(user) {
      const plan = deletionPlan(user);
      for (const p of plan) {
        if (p.action === 'handover') { const heir = accounts.members.find((x) => x.wsId === p.wsId && x.userId === p.heir); if (heir) heir.role = 'owner'; }
        if (p.action === 'delete') {
          const ws = loaded.get(p.wsId);
          if (ws?.timer) { clearTimeout(ws.timer); ws.timer = null; }
          loaded.delete(p.wsId);
          accounts.workspaces = accounts.workspaces.filter((w) => w.id !== p.wsId);
          accounts.invites = accounts.invites.filter((i) => i.wsId !== p.wsId);
          await store.deleteWorkspace(p.wsId);
        }
      }
      accounts.members = accounts.members.filter((m) => m.userId !== user.id);
      accounts.sessions = accounts.sessions.filter((x) => x.userId !== user.id);
      accounts.invites = accounts.invites.filter((i) => i.email !== user.email);
      accounts.users = accounts.users.filter((u) => u.id !== user.id);
      codes.delete(user.email);
      saveAccounts();
      return plan;
    }

    app.post('/api/account/deletion-request', wrap((req, res) => {
      const u = req.user;
      if (!checkPassword(req.body.password, u.password)) throw fail('Your password is wrong');
      const reason = REASONS[req.body.reason] ? req.body.reason : 'other';
      u.deletionRequest = { at: now(), reason, note: String(req.body.note || '').trim().slice(0, 1000) };
      saveAccounts();
      mail.deletionReceived(u.email, u.name);
      for (const to of ADMIN_EMAILS) mail.deletionRequested(to, u, REASONS[reason], u.deletionRequest.note, `${mail.baseUrl(req)}/admin.html`);
      res.json({ deletionRequest: u.deletionRequest });
    }));
    app.delete('/api/account/deletion-request', wrap((req, res) => {
      delete req.user.deletionRequest;
      saveAccounts();
      res.json({ ok: true });
    }));

    app.get('/api/admin/deletion-requests', wrap((req, res) => {
      adminOnly(req);
      res.json(accounts.users.filter((u) => u.deletionRequest).sort((a, b) => a.deletionRequest.at.localeCompare(b.deletionRequest.at)).map((u) => ({
        id: u.id, name: u.name, email: u.email, createdAt: u.createdAt, ...u.deletionRequest, reasonText: REASONS[u.deletionRequest.reason] || u.deletionRequest.reason, plan: deletionPlan(u),
      })));
    }));
    app.post('/api/admin/users/:id/delete', wrap(async (req, res) => {
      adminOnly(req);
      const u = accounts.users.find((x) => x.id === req.params.id);
      if (!u) throw fail('That account no longer exists', 404);
      if (u.id === req.user.id) throw fail("You can't delete your own account from here");
      if (String(req.body.confirm || '').trim().toLowerCase() !== u.email) throw fail('Type their email to confirm');
      const plan = await deleteAccount(u);
      console.log(`[admin] ${req.user.email} deleted the account ${u.email}`);
      mail.deletionDone(u.email);
      res.json({ ok: true, plan });
    }));
    app.post('/api/admin/users/:id/dismiss-deletion', wrap((req, res) => {
      adminOnly(req);
      const u = accounts.users.find((x) => x.id === req.params.id);
      if (u) { delete u.deletionRequest; saveAccounts(); }
      res.json({ ok: true });
    }));

    app.post('/api/account/verify-email', wrap((req, res) => {
      if (req.user.emailVerified !== false) return res.json({ ok: true, already: true });
      if (tooMany(`${req.user.id}|verify`)) throw fail('Too many emails. Try again in a few minutes.', 429);
      noteTry(`${req.user.id}|verify`);
      sendVerify(req, req.user);
      res.json({ ok: true, mail: mail.enabled() });
    }));

    app.post('/api/account/password', wrap((req, res) => {
      if (!checkPassword(req.body.current, req.user.password)) throw fail('Your current password is wrong');
      const weak = passwordRules.check(req.body.password, req.user).problem;
      if (weak) throw fail(weak);
      req.user.password = hashPassword(String(req.body.password));
      saveAccounts();
      res.json({ ok: true });
    }));
  }

  return {
    db, save, id, current, forWorkspace, allWorkspaces, byPhoneNumberId, createWorkspace,
    mountAuth, requireAuth, mountAccountApi,
    wsId: () => current()?.meta.id || null,
    meta: () => current()?.meta || null,
    isLegacy: () => Boolean(current()?.meta.legacy),
    async flush() { // write everything now (used on shutdown)
      if (accTimer) { clearTimeout(accTimer); accTimer = null; }
      await store.saveAccounts(accounts);
      for (const ws of loaded.values()) if (ws.timer) { clearTimeout(ws.timer); ws.timer = null; await store.saveWorkspace(ws.meta.id, ws.db); }
      await store.close();
    },
  };
};
