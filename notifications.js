// Notifications: one feed of everything worth knowing about. Campaigns finishing, failed
// deliveries, new messages, opt-outs, and what the Inbox lead assistant did or needs.
// Each one links to where you can act on it. Related events are grouped while unread
// (three messages from the same person are one notification, not three), and every new
// notification is pushed to open dashboards over the live events stream.

const MAX = 500;

// kind → category used by the page's filters
const CATEGORY = {
  message: 'messages', optout: 'messages', reply_failed: 'messages',
  campaign_done: 'campaigns', campaign_started: 'campaigns', delivery_failed: 'campaigns',
  ai_draft: 'ai', ai_auto: 'ai', ai_handover: 'ai', ai_qualified: 'ai', ai_error: 'ai',
};

module.exports = function mountNotifications(app, ctx) {
  const { db, save, id, wrap, broadcast } = ctx;
  db.notifications ||= [];

  // Only real notifications in live mode; demo ones too in demo mode (like the inbox).
  const visible = () => (db.settings.demoMode ? db.notifications : db.notifications.filter((n) => !n.demo));

  // Add a notification, or fold it into an unread one with the same group key.
  // fields: { kind, title, body, link: { tab, id?, key? }, group?, demo?, count? }
  function add(fields) {
    const now = new Date().toISOString();
    const demo = Boolean(fields.demo);
    let n = fields.group && db.notifications.find((x) => x.group === fields.group && !x.read && Boolean(x.demo) === demo);
    if (n) {
      Object.assign(n, { title: fields.title, body: fields.body, link: fields.link || n.link, ts: now, count: fields.count ?? (n.count || 1) + 1 });
      // Move it back to the top.
      db.notifications.splice(db.notifications.indexOf(n), 1);
      db.notifications.unshift(n);
    } else {
      n = { id: id(), kind: fields.kind, category: CATEGORY[fields.kind] || 'account', title: fields.title, body: fields.body || '', link: fields.link || null, group: fields.group || null, count: fields.count || 1, ts: now, read: false, ...(demo ? { demo: true } : {}), ...(fields.seed ? { seed: true } : {}) };
      db.notifications.unshift(n);
      if (db.notifications.length > MAX) db.notifications.length = MAX;
    }
    save();
    broadcast({ kind: 'notification', notification: n, unread: unread() });
    return n;
  }

  const unread = () => visible().filter((n) => !n.read).length;
  const pick = (ids) => { const set = new Set(ids || []); return visible().filter((n) => set.has(n.id)); };

  app.get('/api/notifications', (req, res) => res.json({ notifications: visible(), unread: unread() }));

  // { ids } or { all: true }; { read: false } marks unread again.
  app.post('/api/notifications/read', wrap((req, res) => {
    const list = req.body.all ? visible() : pick(req.body.ids);
    const read = req.body.read !== false;
    for (const n of list) n.read = read;
    save();
    broadcast({ kind: 'notification', unread: unread() });
    res.json({ unread: unread() });
  }));

  // Remove { ids }, or { all: true } (everything shown), or { read: true } (only read ones).
  app.post('/api/notifications/clear', wrap((req, res) => {
    const gone = new Set((req.body.all ? visible() : req.body.read ? visible().filter((n) => n.read) : pick(req.body.ids)).map((n) => n.id));
    db.notifications = db.notifications.filter((n) => !gone.has(n.id));
    save();
    broadcast({ kind: 'notification', unread: unread() });
    res.json({ removed: gone.size, unread: unread() });
  }));

  // --- Events from the rest of the app --------------------------------------------

  const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

  function campaignStarted(c) {
    if (!c.scheduledAt) return; // only scheduled sends start without you watching
    add({ kind: 'campaign_started', title: `“${c.name}” started sending`, body: `Scheduled send to ${plural(c.recipients.length, 'recipient')}.`, link: { tab: 'campaigns', id: c.id }, demo: c.demo });
  }

  function campaignDone(c, { stopped } = {}) {
    const s = c.stats || {};
    const sent = (s.sent || 0) + (s.delivered || 0) + (s.read || 0);
    const failed = s.failed || 0;
    add({
      kind: 'campaign_done',
      title: stopped ? `“${c.name}” was stopped` : `“${c.name}” finished`,
      body: `${plural(sent, 'message')} sent${failed ? `, ${plural(failed, 'failed')}` : ''}${stopped ? `, ${plural(c.recipients.length - sent - failed, 'not sent')}` : ''}.`,
      link: { tab: 'campaigns', id: c.id },
      demo: c.demo,
    });
  }

  // Failed deliveries, one notification per campaign that keeps its count up to date.
  function deliveryFailed(c) {
    const failed = c.recipients.filter((r) => r.status === 'failed');
    if (!failed.length) return;
    const top = {};
    for (const r of failed) { const k = String(r.error || 'Unknown error').replace(/ — .*/, ''); top[k] = (top[k] || 0) + 1; }
    const [reason] = Object.entries(top).sort((a, b) => b[1] - a[1])[0];
    add({ kind: 'delivery_failed', group: 'fail:' + c.id, count: failed.length, title: `${plural(failed.length, 'message')} failed in “${c.name}”`, body: `Most common reason: ${reason}`, link: { tab: 'campaigns', id: c.id }, demo: c.demo });
  }

  function message({ key, name, text, type, demo }) {
    const n = db.notifications.find((x) => x.group === 'msg:' + key && !x.read);
    const count = (n?.count || 0) + 1;
    const preview = type === 'text' || type === 'button' || type === 'interactive' ? text : `Sent ${type === 'audio' ? 'a voice note' : type === 'image' ? 'a photo' : 'a ' + type}`;
    add({ kind: 'message', group: 'msg:' + key, count, title: count > 1 ? `${plural(count, 'new message')} from ${name}` : `New message from ${name}`, body: String(preview || '').slice(0, 160), link: { tab: 'inbox', key }, demo });
  }

  const optout = ({ name, phone, key, demo }) => add({ kind: 'optout', title: `${name} opted out`, body: 'They asked to stop messages. They won’t be included in future sends.', link: key ? { tab: 'inbox', key } : { tab: 'contacts' }, demo, group: 'optout:' + phone });
  const replyFailed = ({ key, name, error, demo }) => add({ kind: 'reply_failed', title: `Your message to ${name} failed`, body: error || 'WhatsApp didn’t deliver it.', link: { tab: 'inbox', key }, demo, group: 'replyfail:' + key });
  const aiDraft = ({ key, name, text, demo }) => add({ kind: 'ai_draft', group: 'draft:' + key, title: `AI drafted a reply to ${name}`, body: text.slice(0, 160), link: { tab: 'inbox', key }, demo });
  const aiAuto = ({ key, name, text, demo }) => add({ kind: 'ai_auto', group: 'auto:' + key, title: `AI replied to ${name}`, body: text.slice(0, 160), link: { tab: 'inbox', key }, demo });
  const aiHandover = ({ key, name, reason, demo }) => add({ kind: 'ai_handover', group: 'handover:' + key, title: `${name} needs a person`, body: reason, link: { tab: 'inbox', key }, demo });
  const aiQualified = ({ key, name, summary, demo }) => add({ kind: 'ai_qualified', group: 'qualified:' + key, title: `${name} is a qualified lead`, body: summary || '', link: { tab: 'inbox', key }, demo });
  const aiError = ({ key, name, error, demo }) => add({ kind: 'ai_error', group: 'aierror', title: `The lead assistant couldn’t draft a reply${name ? ` to ${name}` : ''}`, body: error, link: key ? { tab: 'inbox', key } : { tab: 'settings' }, demo });

  return { add, campaignStarted, campaignDone, deliveryFailed, message, optout, replyFailed, aiDraft, aiAuto, aiHandover, aiQualified, aiError };
};
