// Alerts outside the app for chats waiting on a person: the lead assistant held its reply (a meeting, pricing,
// appreciation) or asked for a person. They go out right away when no one who can see the chat has SendON open, and
// anyway once it has waited ESCALATE_MS with no reply (an open tab doesn't mean someone is looking). Each person gets a
// browser notification (on every browser where they allowed them, even with the tab closed) and an email (unless they
// turned those off). One alert per held reply; a reply, a dismissed draft or a new message from the customer ends it.
//
// The waiting state lives on the chat (db.chats[key].ai.alert), so a restart doesn't lose it: a sweep every minute
// sends the ones that are due.
//
// Push keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when set, otherwise made once and kept with the accounts.

const webpush = require('web-push');

const ESCALATE_MS = 5 * 60 * 1000;
const SWEEP_MS = 60 * 1000;
const MAX_SUBS = 10; // browsers per person

module.exports = function mountAlerts(app, ctx) {
  const { tenants, listeners, wrap, fail, mail } = ctx;
  const base = () => (process.env.APP_URL || 'https://sendon.si').replace(/\/$/, '');

  let vapid = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
    ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
    : tenants.platformValue('vapid');
  if (!vapid?.publicKey) vapid = tenants.platformValue('vapid', webpush.generateVAPIDKeys());
  webpush.setVapidDetails(base(), vapid.publicKey, vapid.privateKey);

  const splitKey = (key) => { const i = String(key).lastIndexOf(':'); return { senderId: key.slice(0, i), wa: key.slice(i + 1) }; };
  const canSee = (member, senderId) => member.senders === null || member.senders.includes(senderId);
  // Who on this workspace's team can see this chat, and whether any of them has SendON open on it right now.
  const teamFor = (ws, key) => tenants.team(ws.meta.id).filter((m) => canSee(m, splitKey(key).senderId));
  const someoneOnline = (ws, team) => {
    const ids = new Set(team.map((m) => m.user.id));
    for (const res of listeners) if (res.wsId === ws.meta.id && ids.has(res.userId)) return true;
    return false;
  };

  async function push(user, payload) {
    const subs = user.push || [];
    if (!subs.length) return 0;
    let sent = 0, gone = [];
    await Promise.all(subs.map(async (s) => {
      try { await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600, urgency: 'high' }); sent++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) gone.push(s.endpoint); else console.error('Push failed:', e.statusCode || '', e.message); }
    }));
    if (gone.length) { user.push = subs.filter((s) => !gone.includes(s.endpoint)); tenants.saveAccounts(); }
    return sent;
  }

  // Send the alert for one chat to everyone who can see it.
  function send(ws, key, alert) {
    const chat = ws.db.chats[key] || {};
    const name = chat.name || '+' + splitKey(key).wa;
    const url = `${base()}/inbox?ws=${encodeURIComponent(ws.meta.id)}&chat=${encodeURIComponent(key)}`;
    const draft = chat.ai?.draft?.text || '';
    for (const m of teamFor(ws, key)) {
      push(m.user, { title: `${name} is waiting for a reply`, body: `AI held its reply: ${alert.reason}.${draft ? ` Suggested: “${draft.slice(0, 120)}${draft.length > 120 ? '…' : ''}”` : ''}`, url, tag: 'wait:' + key }).catch(() => {});
      if (mail.enabled() && m.user.alertEmail !== false && m.user.email) mail.replyWaiting(m.user.email, { name, reason: alert.reason, draft, workspace: ws.meta.name }, url);
    }
    alert.sentAt = new Date().toISOString();
  }

  // Is this chat still waiting? Not once someone (or the AI) replied, the draft is gone, or a newer draft replaced it.
  function stillWaiting(ws, key, alert) {
    const ai = ws.db.chats[key]?.ai;
    if (!ai?.draft || ai.draft.basedOn !== alert.basedOn) return false;
    return !ws.db.messages.some((m) => m.key === key && m.dir === 'out' && m.type !== 'reaction' && m.ts > alert.at);
  }

  // Check one chat: send if due, forget it once it's answered. Runs inside the workspace.
  function check(ws, key, now = Date.now()) {
    const ai = ws.db.chats[key]?.ai;
    const alert = ai?.alert;
    if (!alert || alert.sentAt) return;
    if (!stillWaiting(ws, key, alert)) { delete ai.alert; tenants.save(); return; }
    if (!someoneOnline(ws, teamFor(ws, key)) || now - Date.parse(alert.at) >= ESCALATE_MS) { send(ws, key, alert); tenants.save(); }
  }

  // Called by the lead assistant (in the chat's workspace) when it holds a reply for a person.
  function held(key, { reason, basedOn, demo }) {
    if (demo) return;
    const ws = tenants.current();
    if (!ws) return;
    const ai = ((ws.db.chats[key] ||= { lastReadAt: null }).ai ||= {});
    if (ai.alert?.basedOn === basedOn) return; // already waiting on this one
    ai.alert = { reason, basedOn, at: new Date().toISOString() };
    check(ws, key);
  }

  setInterval(() => {
    for (const ws of tenants.allWorkspaces()) {
      if (ws.db.settings?.demoMode) continue;
      tenants.forWorkspace(ws, () => {
        for (const [key, chat] of Object.entries(ws.db.chats || {})) if (chat.ai?.alert && !chat.ai.alert.sentAt) check(ws, key);
      });
    }
  }, SWEEP_MS).unref();

  // --- This person's alert settings (the Notifications page) ---
  const state = (u) => ({ publicKey: vapid.publicKey, browsers: (u.push || []).length, email: u.alertEmail !== false, emailWorks: mail.enabled() });
  app.get('/api/alerts', (req, res) => res.json(state(req.user)));
  app.post('/api/alerts/push', wrap((req, res) => {
    const s = req.body?.subscription;
    if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw fail('That browser subscription isn’t valid');
    const u = req.user;
    u.push = [{ endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) }, at: new Date().toISOString() }, ...(u.push || []).filter((x) => x.endpoint !== s.endpoint)].slice(0, MAX_SUBS);
    tenants.saveAccounts();
    res.json(state(u));
  }));
  app.delete('/api/alerts/push', wrap((req, res) => {
    const u = req.user;
    u.push = (u.push || []).filter((x) => x.endpoint !== String(req.body?.endpoint || ''));
    tenants.saveAccounts();
    res.json(state(u));
  }));
  app.post('/api/alerts/email', wrap((req, res) => {
    req.user.alertEmail = Boolean(req.body?.on);
    tenants.saveAccounts();
    res.json(state(req.user));
  }));
  app.post('/api/alerts/test', wrap(async (req, res) => {
    const n = await push(req.user, { title: 'SendON alerts are on', body: 'This is how you’ll hear about chats waiting for a reply.', url: `${base()}/notifications`, tag: 'test' });
    if (!n) throw fail('No browser is set up for alerts yet. Click “Turn on browser alerts” first.');
    res.json({ sent: n });
  }));

  return { held };
};
