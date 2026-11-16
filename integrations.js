// Integration API: lets another app (Spotmies CRM's workflows, first) send through a workspace.
//
// Settings → Developer → API keys: the owner creates a key; it's shown once and only its SHA-256 is kept
// (db.apiKeys). Calls send it as "Authorization: Bearer <key>" to /api/v1/… and run inside that key's workspace,
// with the owner's reach (all numbers). Sending goes through createCampaign, the same path as the Send page, so
// every rule holds: approved templates, the number's Business Account, opt-outs, the daily limit, credits, a
// locked number, pacing per number, auto-pause on failures. Demo mode simulates, as everywhere else.
//
//   GET  /api/v1/account                 the workspace, demo mode
//   GET  /api/v1/senders                 numbers that can send
//   GET  /api/v1/templates               templates and the variables each needs
//   POST /api/v1/campaigns               send a template to people: { name, templateId, senderIds, consent: true,
//                                        recipients: [{ phone, name?, values: { "body.1": "Ravi", … } }], externalId? }
//                                        externalId makes retries safe: the same id returns the campaign already made.
//   GET  /api/v1/campaigns/:id           progress, counts, and each recipient's status
//   GET  /api/v1/messages?after=<cursor> every WhatsApp message in and out (Inbox chats, campaign sends, test sends),
//                                        oldest change first, for keeping a copy in sync: each item comes again
//                                        whenever it changes (sent → delivered → read). Pass back `next` as `after`.
//   POST /api/v1/messages                reply: { senderId, phone, text, replyTo? } inside WhatsApp's 24-hour window,
//                                        or { senderId, phone, templateId, values } any time
//   POST /api/v1/messages/media          send a file (raw body) inside the window: ?senderId=&phone=, headers
//                                        X-File-Type, X-File-Name, X-Caption, X-Reply-To, X-As-Document: 1
//   GET  /api/v1/media/:id               a photo, video, voice note or document from a message

const crypto = require('crypto');

const KEY_PREFIX = 'sk_sendon_';
const KEYS_MAX = 10;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const tidy = (v, max) => String(v ?? '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

module.exports = function mountIntegrations(apiV1, app, ctx) {
  const { db, save, tenants, wrap, fail, id, createCampaign, lockOf, senderName, publicTemplate, notApprovedError, broadcastTo } = ctx;
  const { chatKey, sendInboxText, sendInboxTemplate, sendOutMedia, outKind, OUT_MEDIA, MIME_ALIAS, ensureMedia, normalizeTypedPhone, contacts, WINDOW_MS } = ctx;
  const express = require('express');

  // --- Keys (managed by the owner while signed in) ---------------------------------------------------------------
  const keysOf = () => (db.apiKeys ||= []);
  const publicKey = ({ hash, ...k }) => k;

  app.get('/api/integrations/keys', (req, res) => res.json(keysOf().map(publicKey)));

  app.post('/api/integrations/keys', wrap((req, res) => {
    const name = tidy(req.body?.name, 60);
    if (!name) throw fail('Name the key after the app that will use it, e.g. “Spotmies CRM”');
    if (keysOf().length >= KEYS_MAX) throw fail(`A workspace can have ${KEYS_MAX} keys. Revoke one you no longer use first.`);
    const key = KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
    const entry = { id: id(), name, hash: sha(key), last4: key.slice(-4), createdAt: new Date().toISOString(), createdBy: req.user?.id || '' };
    keysOf().push(entry);
    save();
    // The only time the key is ever shown.
    res.json({ ...publicKey(entry), key });
  }));

  app.delete('/api/integrations/keys/:id', wrap((req, res) => {
    const before = keysOf().length;
    db.apiKeys = keysOf().filter((k) => k.id !== req.params.id);
    if (db.apiKeys.length === before) throw fail('That key was already revoked', 404);
    save();
    res.json({ ok: true });
  }));

  // --- Signing in with a key ----------------------------------------------------------------------------------------
  // Per key: 120 calls a minute (in memory, like the app's other limits).
  const hits = new Map();
  const limited = (keyId) => {
    const now = Date.now();
    const t = (hits.get(keyId) || []).filter((x) => now - x < 60000);
    t.push(now);
    hits.set(keyId, t);
    return t.length > 120;
  };

  apiV1.use((req, res, next) => {
    const given = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || ''))?.[1] || '';
    if (!given.startsWith(KEY_PREFIX)) return res.status(401).json({ error: 'Send your SendON API key as “Authorization: Bearer sk_sendon_…”' });
    const hash = sha(given);
    let found = null;
    for (const ws of tenants.allWorkspaces()) {
      const k = (ws.db.apiKeys || []).find((x) => x.hash === hash);
      if (k) { found = { ws, k }; break; }
    }
    if (!found) return res.status(401).json({ error: 'This API key isn’t valid. It may have been revoked: create a new one in SendON → Settings → Developer.' });
    if (found.ws.meta.suspended) return res.status(403).json({ error: 'This workspace is suspended' });
    if (limited(found.k.id)) { res.set('Retry-After', '60'); return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' }); }
    req.apiKey = found.k;
    req.role = 'owner';
    tenants.forWorkspace(found.ws, () => {
      // When it was last used, for the keys list (saved at most once a minute).
      if (!found.k.lastUsedAt || Date.now() - Date.parse(found.k.lastUsedAt) > 60000) { found.k.lastUsedAt = new Date().toISOString(); save(); }
      next();
    });
  });

  // --- What can be sent ----------------------------------------------------------------------------------------------
  apiV1.get('/account', (req, res) => {
    res.json({ workspace: { id: tenants.meta()?.id, name: tenants.meta()?.name }, demoMode: Boolean(db.settings.demoMode) });
  });

  apiV1.get('/senders', (req, res) => {
    res.json(db.senders.map((s) => {
      const lock = lockOf(s);
      return {
        id: s.id,
        label: s.label,
        phone: s.displayPhone || '',
        wabaId: s.wabaId || '',
        enabled: Boolean(s.enabled),
        quality: s.quality || '',
        // Why it can't send right now, or '' when it can.
        problem: !s.enabled ? 'Turned off in SendON' : lock ? lock.title : !db.settings.demoMode && !s.accessToken ? 'No access token' : '',
      };
    }));
  });

  const comp = (t, type) => (t.components || []).find((c) => String(c.type).toUpperCase() === type);
  const bodyText = (t) => comp(t, 'BODY')?.text || '';
  apiV1.get('/templates', (req, res) => {
    res.json(db.templates.map((t) => {
      const p = publicTemplate(t);
      return {
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category || '',
        status: t.status || '',
        wabaId: t.wabaId || '',
        body: bodyText(t),
        // The rest of the layout, to draw the message as WhatsApp shows it.
        header: (() => { const h = comp(t, 'HEADER'); return h ? { format: h.format, text: h.text || '' } : null; })(),
        footer: comp(t, 'FOOTER')?.text || '',
        buttons: (comp(t, 'BUTTONS')?.buttons || []).map((b) => ({ type: b.type, text: b.text })),
        // '' when it can be sent; otherwise why not (still in review, rejected…).
        problem: db.settings.demoMode ? '' : notApprovedError(t),
        variables: (p.variables || []).map((v) => ({ key: v.key, name: v.name, where: v.where, ...(v.media ? { media: v.media } : {}), ...(v.example ? { example: v.example } : {}) })),
      };
    }));
  });

  // --- Sending --------------------------------------------------------------------------------------------------------
  const RECIPIENTS_MAX = 10000;
  apiV1.post('/campaigns', wrap((req, res) => {
    const b = req.body || {};
    const externalId = tidy(b.externalId, 120);
    if (externalId) {
      const done = db.campaigns.find((c) => c.externalId === externalId);
      if (done) return res.json({ ...campaignOut(done), duplicate: true });
    }
    // The calling app confirms the people agreed to get these messages, as the Send page asks a person to.
    if (b.consent !== true && !db.settings.demoMode) throw fail('Set consent: true to confirm these people agreed to receive WhatsApp messages from you');
    const list = Array.isArray(b.recipients) ? b.recipients : [];
    if (!list.length) throw fail('Add at least one recipient');
    if (list.length > RECIPIENTS_MAX) throw fail(`Send to at most ${RECIPIENTS_MAX.toLocaleString()} people per campaign`);
    const senderIds = Array.isArray(b.senderIds) ? b.senderIds.map(String) : [];
    const locked = db.senders.filter((s) => senderIds.includes(s.id) && lockOf(s));
    if (locked.length) throw fail(`${locked.map(senderName).join(', ')}: ${lockOf(locked[0]).title.toLowerCase()}, so nothing would be delivered.`, 423);
    const template = db.templates.find((t) => t.id === b.templateId);
    if (!template) throw fail('Unknown templateId: list them with GET /api/v1/templates');

    // The recipients as the sheet the Send page would make: a phone column, a name column, and a column per variable.
    const keys = (publicTemplate(template).variables || []).map((v) => v.key);
    const rows = list.map((r) => {
      const row = { phone: String(r?.phone ?? ''), name: tidy(r?.name, 120) };
      for (const k of keys) row['v:' + k] = String(r?.values?.[k] ?? '');
      return row;
    });
    const mapping = Object.fromEntries(keys.map((k) => [k, { type: 'column', value: 'v:' + k }]));

    const c = createCampaign({
      name: tidy(b.name, 120) || undefined,
      templateId: template.id,
      senderIds,
      rows,
      phoneColumn: 'phone',
      mapping,
      source: 'api',
    });
    c.api = { keyId: req.apiKey.id, keyName: req.apiKey.name };
    if (externalId) c.externalId = externalId;
    save();
    // Open SendON pages show the new campaign straight away.
    broadcastTo(tenants.meta()?.id, { kind: 'changed', area: 'campaigns', tab: '' });
    res.status(201).json(campaignOut(c));
  }));

  apiV1.get('/campaigns/:id', wrap((req, res) => {
    const c = db.campaigns.find((x) => x.id === req.params.id);
    if (!c) throw fail('No campaign with that id in this workspace', 404);
    res.json({ ...campaignOut(c), recipients: c.recipients.map(recipientOut) });
  }));

  function campaignOut(c) {
    return {
      id: c.id,
      name: c.name,
      externalId: c.externalId || null,
      status: c.status, // queued, holding, scheduled, running, completed, stopped
      demo: Boolean(c.demo),
      templateId: c.templateId,
      templateName: c.templateName,
      senderIds: c.senderIds,
      createdAt: c.createdAt,
      startedAt: c.startedAt || null,
      finishedAt: c.finishedAt || null,
      pausedReason: c.pausedReason || null,
      total: c.recipients.length,
      stats: c.stats, // pending, sent, delivered, read, failed
      skipped: (c.skipped || []).map((s) => ({ phone: s.phone || s.raw || '', name: s.name || '', reason: s.reason })),
    };
  }
  // --- Conversations (the Inbox) ----------------------------------------------------------------------------------
  // One feed of every message, newest change last. Inbox messages live in db.messages; campaign sends live on each
  // campaign's recipients (as the Inbox thread shows them). Each item's `updatedAt` is when it last changed, so an
  // item comes back in the feed after a status change. The last 2 seconds are held back: anything that changes
  // later is stamped after the cursor, so a cursor never skips a change.
  const SETTLE_MS = 2000;
  const FEED_MAX = 500;
  const maxIso = (...xs) => xs.filter(Boolean).sort().at(-1) || '';
  const fill = (text, values = {}, where = 'body') => String(text || '').replace(/{{\s*(\w+)\s*}}/g, (m, k) => values[`${where}.${k}`] ?? m);
  const bodyOf = (templateId) => (db.templates.find((t) => t.id === templateId)?.components || []).find((c) => String(c.type).toUpperCase() === 'BODY')?.text || '';
  const live = (x) => db.settings.demoMode || !x.demo;
  const nameFor = (key, wa) => db.chats[key]?.name || contacts.byPhone(wa)?.name || '';
  const senderLabel = (sid) => { const s = db.senders.find((x) => x.id === sid); return s ? `${s.label}${s.displayPhone ? ` · ${s.displayPhone}` : ''}` : ''; };

  function inboxItem(m) {
    const template = m.type === 'template' ? { id: m.templateId, name: m.templateName, values: m.values || {} } : null;
    return {
      id: m.id,
      wamid: m.wamid || null,
      senderId: m.senderId,
      sender: senderLabel(m.senderId),
      phone: m.wa,
      name: nameFor(m.key, m.wa),
      direction: m.dir,
      type: m.type,
      text: template ? fill(bodyOf(m.templateId), m.values) : m.text || '',
      template,
      media: m.media ? { id: m.media.id, mime: m.media.mime || '', filename: m.media.filename || '', voice: Boolean(m.media.voice), size: m.media.size || null, animated: Boolean(m.media.animated) } : null,
      location: m.location || null,
      contacts: m.contacts || null, // shared contact cards: [{ name, phones: [{ phone, wa, type }], org, email }]
      unsupported: m.unsupported || null, // what WhatsApp didn't share (view-once, poll…): { kind, reason, code }
      reaction: m.reaction || null,
      replyTo: m.context || null,
      status: m.dir === 'out' ? m.status || 'sent' : null,
      error: m.error || null,
      auto: Boolean(m.auto), // written and sent by SendON's AI
      campaign: m.campaign ? { id: null, name: m.campaign } : null,
      at: m.ts,
      updatedAt: maxIso(m.updatedAt, m.ts),
    };
  }

  function campaignItem(c, r) {
    return {
      id: `c:${c.id}:${r.phone}`,
      wamid: r.messageId || null,
      senderId: r.senderId,
      sender: senderLabel(r.senderId),
      phone: r.phone,
      name: r.name || nameFor(chatKey(r.senderId, r.phone), r.phone),
      direction: 'out',
      type: 'template',
      text: fill(bodyOf(c.templateId), r.values),
      template: { id: c.templateId, name: c.templateName, values: r.values || {} },
      media: null,
      location: null,
      contacts: null,
      unsupported: null,
      reaction: null,
      replyTo: null,
      status: r.status,
      error: r.error || null,
      auto: false,
      campaign: { id: c.id, name: c.name },
      at: r.sentAt || r.failedAt,
      updatedAt: maxIso(r.updatedAt, r.sentAt, r.deliveredAt, r.readAt, r.failedAt),
    };
  }

  const encodeCursor = (it) => Buffer.from(`${it.updatedAt}|${it.id}`).toString('base64url');
  const decodeCursor = (c) => { const [at = '', itemId = ''] = Buffer.from(String(c || ''), 'base64url').toString().split('|'); return { at, itemId }; };

  apiV1.get('/messages', (req, res) => {
    const after = req.query.after ? decodeCursor(req.query.after) : null;
    const limit = Math.max(1, Math.min(FEED_MAX, Number(req.query.limit) || FEED_MAX));
    const until = new Date(Date.now() - SETTLE_MS).toISOString();
    const out = [];
    const keep = (it) => {
      if (!it.at || !it.updatedAt || it.updatedAt >= until) return;
      if (after && (it.updatedAt < after.at || (it.updatedAt === after.at && it.id <= after.itemId))) return;
      out.push(it);
    };
    for (const m of db.messages) if (live(m) && (m.dir === 'in' || m.dir === 'out')) keep(inboxItem(m));
    for (const c of db.campaigns) {
      if (!live(c)) continue;
      for (const r of c.recipients) if (r.sentAt || r.failedAt) keep(campaignItem(c, r));
    }
    out.sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : 1) : a.updatedAt < b.updatedAt ? -1 : 1));
    const page = out.slice(0, limit);
    res.json({
      messages: page,
      // Keep asking from here; with no new messages it stays where it was.
      next: page.length ? encodeCursor(page.at(-1)) : req.query.after || null,
      hasMore: out.length > page.length,
    });
  });

  // Replying. Same rules as replying in SendON's Inbox: text only inside the 24-hour window, templates any time,
  // nothing from a number Meta has locked, nobody who opted out.
  apiV1.post('/messages', wrap(async (req, res) => {
    const b = req.body || {};
    const sender = db.senders.find((s) => s.id === String(b.senderId || ''));
    if (!sender) throw fail('Unknown senderId: list numbers with GET /api/v1/senders');
    const lock = lockOf(sender);
    if (lock) throw fail(`${lock.title}: nothing can be sent from ${senderName(sender)} until Meta unlocks it.`, 423);
    const wa = normalizeTypedPhone(b.phone);
    if (!wa) throw fail('That phone number isn’t valid');
    if (contacts.byPhone(wa)?.optOut) throw fail('This person opted out of WhatsApp messages from you', 409);
    const key = chatKey(sender.id, wa);
    const msg = b.templateId
      ? await sendInboxTemplate(key, String(b.templateId), b.values && typeof b.values === 'object' ? b.values : {})
      : await sendInboxText(key, b.text, { replyTo: b.replyTo ? String(b.replyTo) : undefined });
    res.status(201).json(inboxItem(msg));
  }));

  // A photo, video, audio file or document, as SendON's Inbox sends one (only inside the 24-hour window).
  apiV1.post('/messages/media', express.raw({ type: () => true, limit: '100mb' }), wrap(async (req, res) => {
    const sender = db.senders.find((s) => s.id === String(req.query.senderId || ''));
    if (!sender) throw fail('Unknown senderId: list numbers with GET /api/v1/senders');
    const lock = lockOf(sender);
    if (lock) throw fail(`${lock.title}: nothing can be sent from ${senderName(sender)} until Meta unlocks it.`, 423);
    const wa = normalizeTypedPhone(req.query.phone);
    if (!wa) throw fail('That phone number isn’t valid');
    if (contacts.byPhone(wa)?.optOut) throw fail('This person opted out of WhatsApp messages from you', 409);
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) throw fail('The file is empty');
    const dec = (h) => { try { return decodeURIComponent(String(req.get(h) || '')); } catch { return ''; } };
    const raw = String(req.get('X-File-Type') || req.get('content-type') || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    const mime = MIME_ALIAS[raw] || raw;
    const filename = dec('X-File-Name').replace(/[\\/\r\n"]/g, '_').slice(0, 200) || 'file';
    const type = outKind(mime, req.get('X-As-Document') === '1');
    const rule = OUT_MEDIA[type];
    if (buf.length > rule.mb * 1024 * 1024) {
      throw fail(type === 'document'
        ? `WhatsApp sends files up to 100 MB. This one is ${(buf.length / 1048576).toFixed(1)} MB.`
        : `${rule.label} can be up to ${rule.mb} MB on WhatsApp. This one is ${(buf.length / 1048576).toFixed(1)} MB. Send it as a document instead (up to 100 MB).`, 413);
    }
    const msg = await sendOutMedia(chatKey(sender.id, wa), { buf, mime, type, filename, caption: dec('X-Caption').trim().slice(0, 1024), replyTo: dec('X-Reply-To') || undefined });
    res.status(201).json(inboxItem(msg));
  }));

  // Is the 24-hour window open with this person on this number (and until when)?
  apiV1.get('/conversations/window', (req, res) => {
    const wa = normalizeTypedPhone(req.query.phone);
    const sid = String(req.query.senderId || '');
    const lastIn = wa && db.messages.filter((m) => m.dir === 'in' && m.wa === wa && (!sid || m.senderId === sid) && live(m)).at(-1);
    const until = lastIn ? new Date(Date.parse(lastIn.ts) + WINDOW_MS).toISOString() : null;
    res.json({ open: Boolean(until && Date.parse(until) > Date.now()), until, senderId: lastIn?.senderId || null });
  });

  apiV1.get('/media/:mid', wrap(async (req, res) => {
    // Only media that belongs to a message in this workspace.
    if (!db.messages.some((m) => m.media?.id === req.params.mid)) throw fail('No such media in this workspace', 404);
    const { file, meta } = await ensureMedia(req.params.mid);
    res.type(meta.mime || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(file);
  }));

  // Anything else under /api/v1 is a JSON 404, not the sign-in page.
  apiV1.use((req, res) => res.status(404).json({ error: `No such endpoint: ${req.method} /api/v1${req.path}` }));

  const recipientOut = (r) => ({
    phone: r.phone,
    name: r.name || '',
    status: r.status,
    error: r.error || null,
    sentAt: r.sentAt || null,
    deliveredAt: r.deliveredAt || null,
    readAt: r.readAt || null,
    failedAt: r.failedAt || null,
  });
};
