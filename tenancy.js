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
<body class="auth-body">${body}<script src="/gradient-ascii.js"></script><script>
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

  function signupPage({ error = '', name = '', email = '', business = '', next = '', invite = null } = {}) {
    const legacy = !invite && legacyUnclaimed();
    return page('Create account', shell({
      kicker: invite ? `Join ${invite.wsName}` : 'Start free',
      headline: invite ? 'One inbox. One team. Every campaign.' : 'WhatsApp marketing that runs itself.',
      form: `<form method="post" action="/signup" class="auth-fields">${mark}
<h1>${invite ? `Join ${esc(invite.wsName)}` : 'Create your account'}</h1>
<p class="auth-sub">${invite ? `You were invited to the ${esc(invite.wsName)} workspace.` : 'Set up in minutes. No credit card.'}</p>
<div class="auth-row">
<label>Your name<input name="name" value="${esc(name)}" autocomplete="name" placeholder="Full name" required autofocus></label>
${invite ? '' : `<label>Business name<input name="business" value="${esc(business)}" placeholder="e.g. Spotmies" required></label>`}
</div>
<label>Your email<input type="email" name="email" value="${esc(email || invite?.email || '')}" autocomplete="email" placeholder="you@company.com" required></label>
<label>Password <span class="opt">at least 8 characters</span><input type="password" name="password" autocomplete="new-password" minlength="8" placeholder="Create a password" required></label>
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
  function resetPage({ token, error = '' }) {
    return page('New password', shell({
      kicker: 'Almost there',
      headline: 'Choose a new password.',
      form: `<form method="post" action="/reset/${esc(token)}" class="auth-fields">${mark}
<h1>Choose a new password</h1>
<p class="auth-sub">You'll be signed out everywhere else.</p>
<label>New password <span class="opt">at least 8 characters</span><input type="password" name="password" autocomplete="new-password" minlength="8" placeholder="New password" required autofocus></label>
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
      const again = (error) => res.status(400).send(signupPage({ error, name, email, business, next, invite }));
      if (tooMany(`${req.ip}|signup`)) return again('Too many attempts. Try again in a few minutes.');
      noteTry(`${req.ip}|signup`);
      if (!String(name).trim()) return again('Enter your name');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return again('Enter a valid email');
      if (String(password).length < 8) return again('Use a password of at least 8 characters');
      if (userByEmail(email)) return again('An account with this email already exists. Sign in instead.');
      if (!invite && !String(business).trim()) return again('Enter your business name');

      // Keeping the data from before accounts existed: prove it with the old app password
      // (or be the OWNER_EMAIL). Otherwise everyone starts with a fresh workspace.
      const old = !invite && legacyUnclaimed();
      // With neither variable set, only a local copy (not a hosted one) lets the first sign-up take it.
      const hosted = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production');
      const claims = old && ((legacy && appPassword && sameText(String(legacy), appPassword)) || (ownerEmail && email === ownerEmail.toLowerCase()) || (!appPassword && !ownerEmail && !hosted));
      if (old && legacy && !claims) return again('That app password is wrong. Leave it empty to start a fresh workspace.');

      const user = { id: id(), name: String(name).trim().slice(0, 80), email, password: hashPassword(password), createdAt: now(), emailVerified: false };
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
      sendVerify(req, user);
      startSession(res, user.id, wsId);
      res.redirect('/');
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
      res.send(resetPage({ token: req.params.token }));
    });
    app.post('/reset/:token', form, (req, res) => {
      const user = userByToken('resetToken', req.params.token);
      if (!user) return res.status(404).send(messagePage('Reset password', 'This link has expired', 'Reset links work for 1 hour and only once. Ask for a new one.', '<a class="auth-btn" href="/forgot">Send a new link</a>'));
      if (String(req.body.password || '').length < 8) return res.status(400).send(resetPage({ token: req.params.token, error: 'Use a password of at least 8 characters' }));
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
        user: { ...publicUser(req.user), emailVerified: req.user.emailVerified !== false },
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

    app.post('/api/account/verify-email', wrap((req, res) => {
      if (req.user.emailVerified !== false) return res.json({ ok: true, already: true });
      if (tooMany(`${req.user.id}|verify`)) throw fail('Too many emails. Try again in a few minutes.', 429);
      noteTry(`${req.user.id}|verify`);
      sendVerify(req, req.user);
      res.json({ ok: true, mail: mail.enabled() });
    }));

    app.post('/api/account/password', wrap((req, res) => {
      if (!checkPassword(req.body.current, req.user.password)) throw fail('Your current password is wrong');
      if (String(req.body.password || '').length < 8) throw fail('Use a password of at least 8 characters');
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
