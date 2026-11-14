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

const crypto = require('crypto');

const KEY_PREFIX = 'sk_sendon_';
const KEYS_MAX = 10;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const tidy = (v, max) => String(v ?? '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

module.exports = function mountIntegrations(apiV1, app, ctx) {
  const { db, save, tenants, wrap, fail, id, createCampaign, lockOf, senderName, publicTemplate, notApprovedError, broadcastTo } = ctx;

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

  const bodyText = (t) => (t.components || []).find((c) => String(c.type).toUpperCase() === 'BODY')?.text || '';
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
