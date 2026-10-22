// WhatsApp bulk sender — Express backend.
// Stores config + campaigns in data/db.json, talks to the WhatsApp Cloud API
// (graph.facebook.com), and runs campaigns across multiple sender numbers.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const DEFAULT_DB = {
  settings: {
    demoMode: true,
    graphVersion: 'v21.0',
    defaultCountryCode: '91',
    webhookVerifyToken: crypto.randomBytes(12).toString('hex'),
    concurrencyPerNumber: 5,
    delayMsPerNumber: 100,
  },
  senders: [],
  templates: [],
  campaigns: [],
  // Inbox: every message people send us, plus replies sent from the inbox.
  messages: [],
  // Per-conversation state keyed "senderId:waId": { name, lastReadAt, ai: lead assistant state }.
  chats: {},
  // Address book (contacts.js), keyed by phone number.
  contacts: [],
  tags: [],
};

function loadDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return structuredClone(DEFAULT_DB);
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return { ...DEFAULT_DB, ...raw, settings: { ...DEFAULT_DB.settings, ...raw.settings } };
}

const db = loadDb();
let saveTimer = null;

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 300);
}
save();

const id = () => crypto.randomBytes(8).toString('hex');

// messageId -> { campaignId, index } so webhook status updates find their recipient.
const messageIndex = new Map();
for (const c of db.campaigns) {
  c.recipients.forEach((r, i) => r.messageId && messageIndex.set(r.messageId, { campaignId: c.id, index: i }));
  // A campaign that was mid-run when the server stopped can't resume its in-memory loop.
  if (c.status === 'running') c.status = 'stopped';
}

// wamid -> inbox message, for de-duplicating webhook deliveries and applying status updates.
const inboxIndex = new Map();
for (const m of db.messages) if (m.wamid) inboxIndex.set(m.wamid, m);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const maskToken = (t) => (t ? '••••' + t.slice(-4) : '');

function publicSender(s) {
  const { accessToken, ...rest } = s;
  return { ...rest, accessTokenMasked: maskToken(accessToken), hasToken: Boolean(accessToken) };
}

function normalizePhone(input) {
  let digits = String(input || '').replace(/\D/g, '').replace(/^00/, '');
  const cc = db.settings.defaultCountryCode;
  if (cc && digits.length === 10) digits = cc + digits;
  if (cc && digits.length === 11 && digits.startsWith('0')) digits = cc + digits.slice(1);
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

// Extract the variables ({{1}} or {{name}}) a template needs, as a flat list.
function templateVariables(components = []) {
  const vars = [];
  const scan = (text, where) => {
    const seen = new Set();
    for (const m of String(text || '').matchAll(/{{\s*([\w]+)\s*}}/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      vars.push({ key: `${where}.${m[1]}`, where, name: m[1] });
    }
  };
  for (const c of components) {
    const type = (c.type || '').toUpperCase();
    if (type === 'HEADER') {
      if (c.format === 'TEXT') scan(c.text, 'header');
      else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(c.format)) {
        vars.push({ key: 'header.media', where: 'header', name: c.format.toLowerCase() + ' URL', media: c.format.toLowerCase() });
      }
    } else if (type === 'BODY') scan(c.text, 'body');
    else if (type === 'BUTTONS') {
      (c.buttons || []).forEach((b, i) => {
        if (b.type === 'URL') scan(b.url, `button${i}`);
      });
    }
  }
  return vars;
}

// Build the "components" array for a send request from resolved variable values.
function buildComponents(template, values) {
  const comps = template.components || [];
  const named = template.parameterFormat === 'NAMED';
  const vars = templateVariables(comps);
  const param = (v) => {
    const p = { type: 'text', text: String(values[v.key] ?? '') };
    if (named && !/^\d+$/.test(v.name)) p.parameter_name = v.name;
    return p;
  };
  const out = [];

  const header = vars.filter((v) => v.where === 'header');
  if (header.length) {
    const media = header.find((v) => v.media);
    out.push({
      type: 'header',
      parameters: media ? [{ type: media.media, [media.media]: { link: values[media.key] } }] : header.map(param),
    });
  }
  const body = vars.filter((v) => v.where === 'body');
  if (body.length) out.push({ type: 'body', parameters: body.map(param) });

  const buttons = comps.find((c) => (c.type || '').toUpperCase() === 'BUTTONS');
  (buttons?.buttons || []).forEach((b, i) => {
    const bv = vars.filter((v) => v.where === `button${i}`);
    if (bv.length) out.push({ type: 'button', sub_type: 'url', index: String(i), parameters: bv.map((v) => ({ type: 'text', text: String(values[v.key] ?? '') })) });
  });
  return out;
}

async function graph(sender, pathname, options = {}) {
  const url = `https://graph.facebook.com/${db.settings.graphVersion}/${pathname}`;
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${sender.accessToken}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    // 190 = expired or invalid access token: say what to do, not just "Authentication Error".
    const msg = json.error?.code === 190
      ? `Access token for "${sender.label}" is expired or invalid. Paste a new token under Numbers.`
      : json.error?.error_user_msg || json.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = json.error?.code;
    err.status = res.status;
    throw err;
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Send one template message. Returns the WhatsApp message id.
// `demo` is fixed per campaign so a campaign scheduled in demo mode never sends for real later.
async function sendTemplate(sender, template, to, values, demo = db.settings.demoMode) {
  if (demo) {
    await sleep(80 + Math.random() * 250);
    if (Math.random() < 0.04) throw new Error('(demo) Simulated failure: recipient not on WhatsApp');
    return 'wamid.DEMO' + id();
  }
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name: template.name, language: { code: template.language }, components: buildComponents(template, values) },
  };
  const json = await graph(sender, `${sender.phoneNumberId}/messages`, { method: 'POST', body: JSON.stringify(body) });
  return json.messages?.[0]?.id;
}

// Rate-limit / throughput errors worth retrying with backoff.
const RETRYABLE = new Set([4, 80007, 130429, 131048, 131056]);

// ---------------------------------------------------------------------------
// Campaign runner
// ---------------------------------------------------------------------------

const running = new Map(); // campaignId -> { stop: boolean }
let notes = null; // notifications (notifications.js), mounted further down

async function runCampaign(campaign) {
  const control = { stop: false };
  running.set(campaign.id, control);
  campaign.status = 'running';
  campaign.startedAt ||= new Date().toISOString();
  save();
  notes?.campaignStarted(campaign);

  const template = db.templates.find((t) => t.id === campaign.templateId);
  if (!template) {
    campaign.recipients.forEach((r) => r.status === 'pending' && Object.assign(r, { status: 'failed', error: 'Template was deleted' }));
  }
  const senders = Object.fromEntries(db.senders.map((s) => [s.id, s]));
  const { concurrencyPerNumber, delayMsPerNumber } = db.settings;

  // Each sender works through its own queue in parallel with the others.
  const queues = {};
  campaign.recipients.forEach((r, i) => {
    if (r.status === 'pending' || r.status === 'queued') (queues[r.senderId] ||= []).push(i);
  });

  const worker = async (sender, queue) => {
    while (queue.length && !control.stop) {
      const i = queue.shift();
      const r = campaign.recipients[i];
      for (let attempt = 0; ; attempt++) {
        try {
          r.messageId = await sendTemplate(sender, template, r.phone, r.values, campaign.demo);
          r.status = 'sent';
          r.sentAt = new Date().toISOString();
          r.error = undefined;
          messageIndex.set(r.messageId, { campaignId: campaign.id, index: i });
          if (campaign.demo) simulateStatuses(campaign, i);
          break;
        } catch (e) {
          if (RETRYABLE.has(e.code) && attempt < 4) {
            await sleep(1000 * 2 ** attempt);
            continue;
          }
          r.status = 'failed';
          r.error = e.message;
          r.failedAt = new Date().toISOString();
          break;
        }
      }
      recount(campaign);
      save();
      if (delayMsPerNumber) await sleep(delayMsPerNumber);
    }
  };

  const jobs = [];
  for (const [senderId, queue] of Object.entries(queues)) {
    const sender = senders[senderId];
    if (!sender) {
      queue.forEach((i) => Object.assign(campaign.recipients[i], { status: 'failed', error: 'Sender number was deleted' }));
      continue;
    }
    for (let k = 0; k < Math.max(1, concurrencyPerNumber); k++) jobs.push(worker(sender, queue));
  }
  await Promise.all(jobs);

  running.delete(campaign.id);
  recount(campaign);
  campaign.status = control.stop ? 'stopped' : 'completed';
  campaign.finishedAt = new Date().toISOString();
  save();
  notes?.campaignDone(campaign, { stopped: control.stop });
  notes?.deliveryFailed(campaign);
}

function recount(c) {
  const s = { pending: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
  for (const r of c.recipients) s[r.status] = (s[r.status] || 0) + 1;
  c.stats = s;
}

function simulateStatuses(campaign, i) {
  const r = campaign.recipients[i];
  setTimeout(() => {
    if (r.status !== 'sent') return;
    r.status = 'delivered';
    r.deliveredAt = new Date().toISOString();
    recount(campaign);
    save();
    if (Math.random() < 0.6) {
      setTimeout(() => {
        r.status = 'read';
        r.readAt = new Date().toISOString();
        recount(campaign);
        save();
      }, 2000 + Math.random() * 6000);
    }
  }, 800 + Math.random() * 2500);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();

// Webhook must stay reachable by Meta without the app password.
app.get('/webhook', (req, res) => {
  const ok = req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === db.settings.webhookVerifyToken;
  return ok ? res.status(200).send(req.query['hub.challenge']) : res.sendStatus(403);
});

app.post('/webhook', express.json({ limit: '2mb' }), (req, res) => {
  res.sendStatus(200);
  const rank = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
  const failedIn = new Set(); // campaigns that got new delivery failures in this webhook
  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      for (const st of change.value?.statuses || []) {
        const im = inboxIndex.get(st.id);
        if (im && im.dir === 'out') {
          const was = im.status;
          applyStatus(im, st);
          broadcast({ kind: 'status', key: im.key });
          if (im.status === 'failed' && was !== 'failed') notes?.replyFailed({ key: im.key, name: db.chats[im.key]?.name || '+' + im.wa, error: im.error, demo: im.demo });
          continue;
        }
        const ref = messageIndex.get(st.id);
        if (!ref) continue;
        const c = db.campaigns.find((x) => x.id === ref.campaignId);
        const r = c?.recipients[ref.index];
        if (!r) continue;
        if (st.status === 'failed') {
          if (r.status !== 'failed') failedIn.add(c);
          r.status = 'failed';
          r.failedAt = new Date(Number(st.timestamp) * 1000).toISOString();
          r.error = st.errors?.map((e) => `${e.code}: ${e.title}${e.error_data?.details ? ' — ' + e.error_data.details : ''}`).join('; ');
        } else if ((rank[st.status] ?? -1) > (rank[r.status] ?? -1)) {
          r.status = st.status;
          r[st.status + 'At'] = new Date(Number(st.timestamp) * 1000).toISOString();
        }
        recount(c);
      }
      if (change.value?.messages) ingestMessages(change.value);
    }
  }
  save();
  // Failures that arrive after a campaign finished (or while it runs) update its notification.
  for (const c of failedIn) if (!running.has(c.id)) notes?.deliveryFailed(c);
});

// Optional password protection for the dashboard + API: a login page that sets a
// session cookie. (Basic auth still works for scripts, e.g. curl -u :password.)
if (APP_PASSWORD) {
  const SESSION = crypto.createHash('sha256').update('whatsapp-sender:' + APP_PASSWORD).digest('hex');
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const cookie = (req) => /(?:^|;\s*)ws_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1] || '';
  const basicPass = (req) => {
    const [scheme, b64] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Basic' || !b64) return '';
    const raw = Buffer.from(b64, 'base64').toString();
    return raw.slice(raw.indexOf(':') + 1);
  };
  const loginPage = (error = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · WhatsApp Sender</title><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><style>g{stroke:%2314181c}circle{fill:%2314181c}@media (prefers-color-scheme:dark){g{stroke:%23fff}circle{fill:%23fff}}</style><g fill='none' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'><path d='M11.5 4.5h9a8 8 0 0 1 8 8v4a8 8 0 0 1-8 8h-7.2L8 28.6v-5.1A8 8 0 0 1 3.5 16.5v-4a8 8 0 0 1 8-8z'/><path d='M10.4 12.4q1.6-2.2 3.2 0'/><path d='M10.6 17.2q2.4 2.4 4.8 1.4l5.6-4'/></g><circle cx='20.4' cy='11.6' r='1.4'/></svg>"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@600&display=swap" rel="stylesheet"><link rel="stylesheet" href="/style.css">
<script>try{var t=localStorage.getItem('theme')||'light';document.documentElement.dataset.mode=t==='auto'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t}catch(e){}</script></head>
<body class="login-body"><form class="card login-card" method="post" action="/login">
<div class="brand"><svg class="logo" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 4.5h9a8 8 0 0 1 8 8v4a8 8 0 0 1-8 8h-7.2L8 28.6v-5.1A8 8 0 0 1 3.5 16.5v-4a8 8 0 0 1 8-8z"/><path d="M10.4 12.4q1.6-2.2 3.2 0"/><circle class="logo-eye" cx="20.4" cy="11.6" r="1.25" fill="currentColor" stroke="none"/><path d="M10.6 17.2q2.4 2.4 4.8 1.4l5.6-4"/></svg><span class="brand-name">WhatsApp Sender</span></div>
<label>Password<input type="password" name="password" autofocus autocomplete="current-password" required></label>
${error ? `<p class="login-error">${error}</p>` : ''}<button class="btn primary" type="submit">Sign in</button></form></body></html>`;

  app.get('/login', (req, res) => res.send(loginPage()));
  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    if (!same(String(req.body?.password || ''), APP_PASSWORD)) return res.status(401).send(loginPage('Wrong password'));
    res.set('Set-Cookie', `ws_session=${SESSION}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`);
    res.redirect('/');
  });
  app.get('/logout', (req, res) => {
    res.set('Set-Cookie', 'ws_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.redirect('/login');
  });
  app.use((req, res, next) => {
    if (same(cookie(req), SESSION) || same(basicPass(req), APP_PASSWORD)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Signed out — reload the page to sign in' });
    if (req.path === '/style.css') return next(); // the login page uses it
    res.redirect('/login');
  });
}

app.use(express.json({ limit: '20mb' }));
// Browsers must check for a newer copy every time, so an update shows on a normal refresh.
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
// D3 for the dashboard charts, served locally so it works offline.
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'd3', 'dist')));

const wrap = (fn) => (req, res) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch((e) => res.status(e.httpStatus || 400).json({ error: e.message }));
const fail = (msg, httpStatus = 400) => Object.assign(new Error(msg), { httpStatus });

// --- Settings ---------------------------------------------------------------

// AI assistant: Claude (Anthropic) or Gemini (Google). Keys are write-only from the browser, like sender access tokens.
const AI_PROVIDERS = ['gemini', 'claude'];
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
function aiConfig() {
  const keys = { claude: db.settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY || '', gemini: db.settings.geminiApiKey || process.env.GEMINI_API_KEY || '' };
  // Until one is picked, use whichever has a key (Gemini first: it has a free tier).
  const provider = AI_PROVIDERS.includes(db.settings.aiProvider) ? db.settings.aiProvider : keys.gemini || !keys.claude ? 'gemini' : 'claude';
  return { provider, key: keys[provider], keys, geminiModel: db.settings.geminiModel || DEFAULT_GEMINI_MODEL };
}
function publicSettings() {
  const { anthropicApiKey, geminiApiKey, ...rest } = db.settings;
  const ai = aiConfig();
  return {
    ...rest,
    aiProvider: ai.provider,
    geminiModel: ai.geminiModel,
    hasAiKey: Boolean(ai.key),
    aiKeyMasked: maskToken(anthropicApiKey),
    aiKeyFromEnv: !anthropicApiKey && Boolean(process.env.ANTHROPIC_API_KEY),
    hasGeminiKey: Boolean(ai.keys.gemini),
    geminiKeyMasked: maskToken(geminiApiKey),
    geminiKeyFromEnv: !geminiApiKey && Boolean(process.env.GEMINI_API_KEY),
  };
}

app.get('/api/settings', (req, res) => res.json(publicSettings()));

app.put('/api/settings', (req, res) => {
  const allowed = ['demoMode', 'graphVersion', 'defaultCountryCode', 'webhookVerifyToken', 'concurrencyPerNumber', 'delayMsPerNumber'];
  for (const k of allowed) if (k in req.body) db.settings[k] = req.body[k];
  db.settings.concurrencyPerNumber = Math.min(50, Math.max(1, Number(db.settings.concurrencyPerNumber) || 1));
  db.settings.delayMsPerNumber = Math.max(0, Number(db.settings.delayMsPerNumber) || 0);
  // Blank means "keep the saved key"; removing it is an explicit flag.
  if (typeof req.body.anthropicApiKey === 'string' && req.body.anthropicApiKey.trim()) db.settings.anthropicApiKey = req.body.anthropicApiKey.trim();
  if (req.body.removeAnthropicApiKey) delete db.settings.anthropicApiKey;
  if (typeof req.body.geminiApiKey === 'string' && req.body.geminiApiKey.trim()) db.settings.geminiApiKey = req.body.geminiApiKey.trim();
  if (req.body.removeGeminiApiKey) delete db.settings.geminiApiKey;
  if (req.body.leadAgent && typeof req.body.leadAgent === 'object') {
    const l = req.body.leadAgent;
    db.settings.leadAgent = {
      enabled: Boolean(l.enabled),
      business: String(l.business ?? db.settings.leadAgent?.business ?? '').slice(0, 20000),
      qualified: String(l.qualified ?? db.settings.leadAgent?.qualified ?? '').slice(0, 4000),
    };
  }
  if (AI_PROVIDERS.includes(req.body.aiProvider)) db.settings.aiProvider = req.body.aiProvider;
  if (typeof req.body.geminiModel === 'string') {
    const m = req.body.geminiModel.trim().replace(/^models\//, '');
    if (!m) delete db.settings.geminiModel;
    else if (/^[\w.-]{1,80}$/.test(m)) db.settings.geminiModel = m;
  }
  save();
  res.json(publicSettings());
});

// --- Sender numbers ---------------------------------------------------------

app.get('/api/senders', (req, res) => res.json(db.senders.map(publicSender)));

app.post('/api/senders', wrap((req, res) => {
  const { label, phoneNumberId, wabaId, accessToken, displayPhone } = req.body;
  if (!label || !phoneNumberId) throw fail('Label and Phone Number ID are required');
  const s = { id: id(), label, phoneNumberId: String(phoneNumberId).trim(), wabaId: String(wabaId || '').trim(), accessToken: String(accessToken || '').trim(), displayPhone: displayPhone || '', enabled: true, createdAt: new Date().toISOString() };
  db.senders.push(s);
  save();
  res.json(publicSender(s));
}));

app.put('/api/senders/:id', wrap((req, res) => {
  const s = db.senders.find((x) => x.id === req.params.id);
  if (!s) throw fail('Not found', 404);
  for (const k of ['label', 'phoneNumberId', 'wabaId', 'displayPhone', 'enabled']) if (k in req.body) s[k] = typeof req.body[k] === 'string' ? req.body[k].trim() : req.body[k];
  // Blank token on edit means "keep the existing one".
  if (req.body.accessToken) s.accessToken = req.body.accessToken.trim();
  save();
  res.json(publicSender(s));
}));

app.delete('/api/senders/:id', (req, res) => {
  db.senders = db.senders.filter((x) => x.id !== req.params.id);
  save();
  res.json({ ok: true });
});

// Check the credentials by fetching the phone number's details from Meta.
app.post('/api/senders/:id/test', wrap(async (req, res) => {
  const s = db.senders.find((x) => x.id === req.params.id);
  if (!s) throw fail('Not found', 404);
  if (!s.accessToken) throw fail('No access token saved for this number');
  const info = await graph(s, `${s.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,status`);
  s.displayPhone = info.display_phone_number || s.displayPhone;
  s.verifiedName = info.verified_name;
  s.qualityRating = info.quality_rating;
  s.messagingLimit = info.messaging_limit_tier;
  s.lastCheckedAt = new Date().toISOString();
  save();
  res.json({ ok: true, info, sender: publicSender(s) });
}));

// --- Templates --------------------------------------------------------------

const publicTemplate = (t) => ({ ...t, variables: templateVariables(t.components) });

app.get('/api/templates', (req, res) => res.json(db.templates.map(publicTemplate)));

// Manually defined template (for before API access, or for templates you know the shape of).
app.post('/api/templates', wrap((req, res) => {
  const { name, language, category, headerFormat, headerText, bodyText, footerText, urlButtons } = req.body;
  if (!name || !language || !bodyText) throw fail('Name, language and body text are required');
  const components = [];
  if (headerFormat && headerFormat !== 'NONE') components.push({ type: 'HEADER', format: headerFormat, ...(headerFormat === 'TEXT' ? { text: headerText || '' } : {}) });
  components.push({ type: 'BODY', text: bodyText });
  if (footerText) components.push({ type: 'FOOTER', text: footerText });
  const buttons = (urlButtons || []).filter((b) => b.text && b.url).map((b) => ({ type: 'URL', text: b.text, url: b.url }));
  if (buttons.length) components.push({ type: 'BUTTONS', buttons });
  const named = /{{\s*[a-z_][\w]*\s*}}/i.test(JSON.stringify(components).replace(/{{\s*\d+\s*}}/g, ''));
  const t = { id: id(), name: name.trim(), language: language.trim(), category: category || 'MARKETING', status: 'MANUAL', source: 'manual', parameterFormat: named ? 'NAMED' : 'POSITIONAL', components, updatedAt: new Date().toISOString() };
  db.templates.push(t);
  save();
  res.json(publicTemplate(t));
}));

app.delete('/api/templates/:id', (req, res) => {
  db.templates = db.templates.filter((x) => x.id !== req.params.id);
  save();
  res.json({ ok: true });
});

// Pull approved templates from every WhatsApp Business Account we have a token for.
app.post('/api/templates/sync', wrap(async (req, res) => {
  const accounts = new Map();
  for (const s of db.senders) if (s.wabaId && s.accessToken && !accounts.has(s.wabaId)) accounts.set(s.wabaId, s);
  if (!accounts.size) throw fail('Add a sender number with a WABA ID and access token first');

  let synced = 0;
  const errors = [];
  for (const [wabaId, sender] of accounts) {
    try {
      let next = `${wabaId}/message_templates?fields=name,language,status,category,components,parameter_format&limit=100`;
      while (next) {
        const page = await graph(sender, next);
        for (const t of page.data || []) {
          const existing = db.templates.find((x) => x.source === 'synced' && x.wabaId === wabaId && x.name === t.name && x.language === t.language);
          const data = { name: t.name, language: t.language, category: t.category, status: t.status, components: t.components, parameterFormat: t.parameter_format || 'POSITIONAL', source: 'synced', wabaId, metaId: t.id, updatedAt: new Date().toISOString() };
          if (existing) Object.assign(existing, data);
          else db.templates.push({ id: id(), ...data });
          synced++;
        }
        next = page.paging?.next ? page.paging.next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, '') : null;
      }
    } catch (e) {
      errors.push(`WABA ${wabaId}: ${e.message}`);
    }
  }
  save();
  res.json({ synced, errors, templates: db.templates.map(publicTemplate) });
}));

// --- Sending ----------------------------------------------------------------

function resolveRecipients(body, template) {
  const { rows = [], phoneColumn, mapping = {} } = body;
  const vars = templateVariables(template.components);
  const seen = new Set();
  const recipients = [];
  const skipped = [];
  for (const row of rows) {
    const phone = normalizePhone(row[phoneColumn]);
    if (!phone) { skipped.push({ raw: row[phoneColumn], reason: 'Invalid number' }); continue; }
    if (seen.has(phone)) { skipped.push({ raw: row[phoneColumn], reason: 'Duplicate' }); continue; }
    if (contactsApi.isOptedOut(phone)) { seen.add(phone); skipped.push({ raw: row[phoneColumn], reason: 'Opted out' }); continue; }
    seen.add(phone);
    const values = {};
    for (const v of vars) {
      const m = mapping[v.key] || {};
      values[v.key] = m.type === 'column' ? String(row[m.value] ?? '').trim() : String(m.value ?? '');
    }
    recipients.push({ phone, values, name: row.name || row.Name || '' });
  }
  return { recipients, skipped, vars };
}

app.post('/api/send/test', wrap(async (req, res) => {
  const { senderId, templateId, phone, values = {} } = req.body;
  const sender = db.senders.find((s) => s.id === senderId);
  const template = db.templates.find((t) => t.id === templateId);
  if (!sender || !template) throw fail('Pick a sender number and a template');
  const to = normalizePhone(phone);
  if (!to) throw fail('Invalid phone number');
  if (!db.settings.demoMode && !sender.accessToken) throw fail('This sender has no access token');
  const messageId = await sendTemplate(sender, template, to, values);
  // Keep test sends in the Inbox thread too, so the conversation shows everything that went out.
  const demo = db.settings.demoMode;
  const key = chatKey(sender.id, to);
  const msg = { id: id(), wamid: messageId, key, senderId: sender.id, wa: to, dir: 'out', type: 'template', templateId: template.id, templateName: template.name, values, campaign: 'Test send', ts: new Date().toISOString(), status: 'sent', ...(demo ? { demo: true } : {}) };
  db.messages.push(msg);
  if (messageId) inboxIndex.set(messageId, msg);
  db.chats[key] ||= { lastReadAt: new Date().toISOString() };
  save();
  broadcast({ kind: 'message', key, dir: 'out' });
  res.json({ ok: true, messageId, to, demo });
}));

// Validates and starts (or schedules) a campaign. Used by the Send page and by
// assistant plans once the person approves them.
function createCampaign(body) {
  const { name, templateId, senderIds = [] } = body;
  const template = db.templates.find((t) => t.id === templateId);
  if (!template) throw fail('Pick a template');
  const senders = db.senders.filter((s) => senderIds.includes(s.id) && s.enabled);
  if (!senders.length) throw fail('Select at least one enabled sender number');
  if (!db.settings.demoMode) {
    const noToken = senders.find((s) => !s.accessToken);
    if (noToken) throw fail(`"${noToken.label}" has no access token (or turn on Demo mode)`);
  }

  const { recipients, skipped, vars } = resolveRecipients(body, template);
  if (!recipients.length) throw fail('No valid recipients');
  const missing = vars.find((v) => recipients.some((r) => !r.values[v.key]));
  if (missing) throw fail(`Variable "${missing.key}" is empty for some recipients — map it to a column or set a fixed value`);

  // Spread recipients evenly across the chosen numbers (round-robin).
  recipients.forEach((r, i) => Object.assign(r, { senderId: senders[i % senders.length].id, status: 'pending' }));

  let scheduledAt = null;
  if (body.scheduledAt) {
    const when = new Date(body.scheduledAt);
    if (isNaN(when)) throw fail('Invalid schedule date');
    if (when < Date.now() - 60_000) throw fail('Scheduled time is in the past');
    scheduledAt = when.toISOString();
  }

  const c = {
    id: id(),
    name: name || `${template.name} — ${new Date().toLocaleString()}`,
    templateId,
    templateName: template.name,
    senderIds: senders.map((s) => s.id),
    demo: db.settings.demoMode,
    createdAt: new Date().toISOString(),
    scheduledAt,
    status: scheduledAt ? 'scheduled' : 'queued',
    skipped: [...(body.skipped || []), ...skipped],
    recipients,
    ...(body.source ? { source: body.source } : {}),
  };
  recount(c);
  db.campaigns.unshift(c);
  save();
  if (!scheduledAt) runCampaign(c);
  return c;
}

app.post('/api/campaigns', wrap((req, res) => {
  const { skipped, source, ...body } = req.body;
  res.json(summary(createCampaign(body)));
}));

// Start scheduled campaigns when their time comes. Campaigns whose time passed
// while the server was off start as soon as it's back up.
setInterval(() => {
  const now = Date.now();
  for (const c of db.campaigns) {
    if (c.status === 'scheduled' && new Date(c.scheduledAt) <= now && !running.has(c.id)) runCampaign(c);
  }
}, 5000);

app.post('/api/campaigns/:id/cancel', wrap((req, res) => {
  const c = db.campaigns.find((x) => x.id === req.params.id);
  if (!c) throw fail('Not found', 404);
  if (c.status !== 'scheduled') throw fail('Only scheduled campaigns can be cancelled');
  c.status = 'cancelled';
  save();
  res.json(summary(c));
}));

const summary = (c) => {
  const { recipients, ...rest } = c;
  return { ...rest, total: recipients.length };
};

// Replies and leads: a recipient "replied" if they wrote to the number that messaged them within
// REPLY_DAYS of receiving it; a reply is a "lead" if their contact is now qualified or won.
const REPLY_DAYS = 7;
function inboundIndex() {
  const idx = new Map();
  for (const m of db.messages) if (m.dir === 'in' && m.type !== 'reaction') (idx.get(m.key) || idx.set(m.key, []).get(m.key)).push(new Date(m.ts).getTime());
  return idx;
}
function outcome(c, idx) {
  let replies = 0, leads = 0;
  const per = c.recipients.map((r) => {
    if (!r.sentAt) return null;
    const t0 = new Date(r.sentAt).getTime();
    const key = chatKey(r.senderId, r.phone);
    const replied = (idx.get(key) || []).some((t) => t > t0 && t - t0 < REPLY_DAYS * 86400000);
    const status = contactsApi.byPhone(r.phone)?.status;
    if (replied) { replies++; if (status === 'qualified' || status === 'won') leads++; }
    return { replied, key, contactStatus: status || null };
  });
  return { replies, leads, per };
}

app.get('/api/campaigns', (req, res) => {
  const idx = inboundIndex();
  res.json(db.campaigns.map((c) => { const o = outcome(c, idx); return { ...summary(c), replies: o.replies, leads: o.leads }; }));
});

app.get('/api/campaigns/:id', wrap((req, res) => {
  const c = db.campaigns.find((x) => x.id === req.params.id);
  if (!c) throw fail('Not found', 404);
  const o = outcome(c, inboundIndex());
  res.json({ ...c, replies: o.replies, leads: o.leads, recipients: c.recipients.map((r, i) => (o.per[i] ? { ...r, replied: o.per[i].replied, chatKey: o.per[i].key, contactStatus: o.per[i].contactStatus } : r)) });
}));

app.post('/api/campaigns/:id/stop', wrap((req, res) => {
  const ctl = running.get(req.params.id);
  if (ctl) ctl.stop = true;
  res.json({ ok: true });
}));

app.post('/api/campaigns/:id/resume', wrap((req, res) => {
  const c = db.campaigns.find((x) => x.id === req.params.id);
  if (!c) throw fail('Not found', 404);
  if (running.has(c.id)) throw fail('Already running');
  // Also retry failures when asked: all of them, or only those with certain error codes / messages.
  const codes = Array.isArray(req.body?.retryReasons) ? new Set(req.body.retryReasons.map(String)) : null;
  const reasonOf = (r) => String(r.error || '').match(/^(\d{2,6}):/)?.[1] || String(r.error || '');
  if (req.body?.retryFailed || codes) c.recipients.forEach((r) => r.status === 'failed' && (!codes || codes.has(reasonOf(r))) && Object.assign(r, { status: 'pending', error: undefined }));
  runCampaign(c);
  res.json(summary(c));
}));

app.delete('/api/campaigns/:id', wrap((req, res) => {
  if (running.has(req.params.id)) throw fail('Stop the campaign first');
  db.campaigns = db.campaigns.filter((x) => x.id !== req.params.id);
  save();
  res.json({ ok: true });
}));

app.get('/api/campaigns/:id/export.csv', (req, res) => {
  const c = db.campaigns.find((x) => x.id === req.params.id);
  if (!c) return res.sendStatus(404);
  const senders = Object.fromEntries(db.senders.map((s) => [s.id, s.label]));
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['phone', 'name', 'sender', 'status', 'message_id', 'sent_at', 'delivered_at', 'read_at', 'error'].join(',')];
  for (const r of c.recipients) lines.push([r.phone, r.name, senders[r.senderId] || r.senderId, r.status, r.messageId, r.sentAt, r.deliveredAt, r.readAt, r.error].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="campaign-${c.id}.csv"`);
  res.send(lines.join('\n'));
});

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------
// Conversations are keyed "senderId:waId": one of our numbers talking to one person.
// Messages people send arrive on the webhook; replies go out through the Cloud API.
// Campaign messages already sent to that person are merged into the thread on read.

const WINDOW_MS = 24 * 3600 * 1000; // WhatsApp allows free-form replies for 24h after their last message
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const chatKey = (senderId, wa) => `${senderId}:${wa}`;
const splitKey = (key) => {
  const i = String(key).lastIndexOf(':');
  return { senderId: key.slice(0, i), wa: key.slice(i + 1) };
};

// Live updates for open dashboards (Server-Sent Events).
const listeners = new Set();
function broadcast(data) {
  const line = `event: inbox\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) res.write(line);
}
setInterval(() => { for (const res of listeners) res.write(': ping\n\n'); }, 25000);

const STATUS_RANK = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
function applyStatus(m, st) {
  if (st.status === 'failed') {
    m.status = 'failed';
    m.error = st.errors?.map((e) => `${e.code}: ${e.title}${e.error_data?.details ? ' — ' + e.error_data.details : ''}`).join('; ');
  } else if ((STATUS_RANK[st.status] ?? -1) > (STATUS_RANK[m.status] ?? -1)) {
    m.status = st.status;
  }
}

// Normalise one webhook message into what the inbox stores.
function parseIncoming(m) {
  const out = { type: m.type, text: '' };
  switch (m.type) {
    case 'text':
      out.text = m.text?.body || '';
      break;
    case 'image': case 'video': case 'audio': case 'document': case 'sticker': {
      const x = m[m.type] || {};
      out.media = { id: x.id, mime: x.mime_type, filename: x.filename, voice: Boolean(x.voice) };
      out.text = x.caption || '';
      break;
    }
    case 'location':
      out.location = { lat: m.location?.latitude, lng: m.location?.longitude, name: m.location?.name, address: m.location?.address };
      break;
    case 'contacts':
      out.text = (m.contacts || []).map((c) => [c.name?.formatted_name, ...(c.phones || []).map((p) => p.phone)].filter(Boolean).join(' · ')).join('\n');
      break;
    case 'button': // tap on a template's quick-reply button
      out.text = m.button?.text || '';
      break;
    case 'interactive':
      out.text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
      break;
    case 'reaction':
      out.reaction = { emoji: m.reaction?.emoji || '', to: m.reaction?.message_id };
      break;
    case 'order':
      out.text = 'Sent an order';
      break;
    default:
      out.type = 'unsupported';
      out.text = "This message type isn't supported";
  }
  return out;
}

function ingestMessages(value) {
  const pnid = value.metadata?.phone_number_id;
  const sender = db.senders.find((s) => s.phoneNumberId === pnid);
  const senderId = sender?.id || 'pn_' + pnid;
  const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
  for (const m of value.messages || []) {
    if (inboxIndex.has(m.id)) continue; // Meta can deliver the same webhook more than once
    const key = chatKey(senderId, m.from);
    const chat = (db.chats[key] ||= { lastReadAt: null });
    if (names[m.from]) chat.name = names[m.from];
    const msg = { id: id(), wamid: m.id, key, senderId, wa: m.from, dir: 'in', ts: new Date(Number(m.timestamp) * 1000).toISOString(), context: m.context?.id, ...parseIncoming(m) };
    db.messages.push(msg);
    inboxIndex.set(m.id, msg);
    // Everyone who writes in becomes a contact; STOP opts them out straight away.
    const contact = contactsApi.onInbound(m.from, { name: names[m.from], text: msg.text, ts: msg.ts });
    const who = chat.name || contact?.name || '+' + m.from;
    if (contact?.optOut && contact.optOutAt && Date.now() - Date.parse(contact.optOutAt) < 5000) notes?.optout({ name: who, phone: contact.phone, key });
    else if (msg.type !== 'reaction') notes?.message({ key, name: who, text: msg.text, type: msg.type });
    if (msg.type !== 'reaction') leadApi.onInbound(key);
    broadcast({ kind: 'message', key, dir: 'in' });
  }
}

// Demo messages only show in demo mode; real ones always show.
const inboxMessages = () => (db.settings.demoMode ? db.messages : db.messages.filter((m) => !m.demo));

// Names we know from campaign contact files, used until the person's WhatsApp profile name arrives.
function recipientNames() {
  const names = new Map();
  for (const c of db.campaigns) for (const r of c.recipients) if (r.name && !names.has(r.phone)) names.set(r.phone, r.name);
  return names;
}

function conversationInfo(key, msgs, names) {
  const { senderId, wa } = splitKey(key);
  const chat = db.chats[key] || {};
  const sender = db.senders.find((s) => s.id === senderId);
  const lastIn = msgs.filter((m) => m.dir === 'in').at(-1);
  const last = msgs.filter((m) => m.type !== 'reaction').at(-1) || msgs.at(-1);
  return {
    key,
    senderId,
    senderLabel: sender?.label || 'Unknown number',
    wa,
    name: chat.name || names.get(wa) || '',
    last: last && { dir: last.dir, type: last.type, text: last.text || last.templateName || '', status: last.status, ts: last.ts, reaction: last.reaction },
    lastAt: last?.ts || null,
    unread: msgs.filter((m) => m.dir === 'in' && (!chat.lastReadAt || m.ts > chat.lastReadAt)).length,
    windowEndsAt: lastIn ? new Date(new Date(lastIn.ts).getTime() + WINDOW_MS).toISOString() : null,
    ...conversationExtras(key, wa),
  };
}

// Lead assistant and contact details shown on each conversation.
function conversationExtras(key, wa) {
  const ai = leadApi.stateFor(key);
  const c = contactsApi.byPhone(wa);
  return {
    ai: { on: ai.on, busy: ai.busy, hasDraft: Boolean(ai.draft), handover: Boolean(ai.handover) },
    contact: c ? { id: c.id, status: c.status, optOut: c.optOut, tags: c.tags } : null,
  };
}

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
});

app.get('/api/inbox', (req, res) => {
  const byKey = new Map();
  for (const m of inboxMessages()) (byKey.get(m.key) || byKey.set(m.key, []).get(m.key)).push(m);
  const names = recipientNames();
  // Which templates each person was sent (campaigns and template messages from the Inbox), for the template filter.
  const tpls = new Map();
  const addTpl = (key, name) => { if (name) (tpls.get(key) || tpls.set(key, new Set()).get(key)).add(name); };
  for (const c of db.campaigns) {
    if (c.demo && !db.settings.demoMode) continue;
    for (const r of c.recipients) if (r.sentAt || r.failedAt) addTpl(chatKey(r.senderId, r.phone), c.templateName);
  }
  for (const m of inboxMessages()) if (m.type === 'template') addTpl(m.key, m.templateName);
  const conversations = [...byKey].map(([key, msgs]) => ({ ...conversationInfo(key, msgs.sort((a, b) => a.ts.localeCompare(b.ts)), names), templates: [...(tpls.get(key) || [])] }));
  conversations.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
  res.json({ conversations, unread: conversations.reduce((n, c) => n + c.unread, 0) });
});

app.get('/api/inbox/:key', wrap((req, res) => {
  const key = req.params.key;
  const { senderId, wa } = splitKey(key);
  if (!/^\d{6,15}$/.test(wa)) throw fail('Invalid conversation', 404);
  const own = inboxMessages().filter((m) => m.key === key);
  // Campaign messages this person got from this number, shown as template bubbles.
  const sent = [];
  for (const c of db.campaigns) {
    if (c.demo && !db.settings.demoMode) continue;
    for (const r of c.recipients) {
      if (r.phone !== wa || r.senderId !== senderId || !(r.sentAt || r.failedAt)) continue;
      sent.push({ id: r.messageId || c.id + wa, wamid: r.messageId, dir: 'out', type: 'template', templateId: c.templateId, templateName: c.templateName, values: r.values, campaign: c.name, ts: r.sentAt || r.failedAt, status: r.status, error: r.error, demo: Boolean(c.demo), seed: Boolean(c.seed) });
    }
  }
  const messages = [...own, ...sent].sort((a, b) => a.ts.localeCompare(b.ts));
  res.json({ conversation: conversationInfo(key, own, recipientNames()), messages, ai: leadApi.stateFor(key), contact: contactsApi.byPhone(wa) || null, tags: db.tags });
}));

// Mark a conversation read here, and (live) send blue ticks to the person.
app.post('/api/inbox/:key/read', wrap(async (req, res) => {
  const key = req.params.key;
  const chat = (db.chats[key] ||= { lastReadAt: null });
  chat.lastReadAt = new Date().toISOString();
  save();
  broadcast({ kind: 'read', key });
  res.json({ ok: true });
  const lastIn = db.messages.filter((m) => m.key === key && m.dir === 'in' && !m.demo).at(-1);
  const sender = db.senders.find((s) => s.id === splitKey(key).senderId);
  if (lastIn && sender?.accessToken && !db.settings.demoMode && !lastIn.readSent) {
    lastIn.readSent = true;
    graph(sender, `${sender.phoneNumberId}/messages`, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: lastIn.wamid }) }).catch(() => {});
  }
}));

// Reply with text (inside the 24h window) or a template (any time).
app.post('/api/inbox/:key/send', wrap(async (req, res) => {
  const key = req.params.key;
  const { senderId, wa } = splitKey(key);
  const sender = db.senders.find((s) => s.id === senderId);
  if (!sender) throw fail('This WhatsApp number is no longer connected');
  if (!/^\d{6,15}$/.test(wa)) throw fail('Invalid phone number');
  const demo = db.settings.demoMode;
  if (!demo && !sender.accessToken) throw fail(`"${sender.label}" has no access token`);
  const { text, replyTo, templateId, values = {} } = req.body;

  let msg;
  if (templateId) {
    const template = db.templates.find((t) => t.id === templateId);
    if (!template) throw fail('Pick a template');
    const empty = templateVariables(template.components).find((v) => !String(values[v.key] ?? '').trim());
    if (empty) throw fail(`Fill in ${empty.where} ${empty.name}`);
    const wamid = await sendTemplate(sender, template, wa, values, demo);
    msg = { type: 'template', templateId, templateName: template.name, values, wamid };
  } else {
    const body = String(text || '').trim();
    if (!body) throw fail('Type a message');
    const lastIn = db.messages.filter((m) => m.key === key && m.dir === 'in').at(-1);
    if (!lastIn || Date.now() - new Date(lastIn.ts) > WINDOW_MS) throw fail('The 24-hour reply window is closed. Send a template to restart the conversation.');
    let wamid;
    if (demo) wamid = 'wamid.DEMO' + id();
    else {
      const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: wa, type: 'text', text: { body, preview_url: true } };
      if (replyTo) payload.context = { message_id: replyTo };
      wamid = (await graph(sender, `${sender.phoneNumberId}/messages`, { method: 'POST', body: JSON.stringify(payload) })).messages?.[0]?.id;
    }
    msg = { type: 'text', text: body, wamid, context: replyTo || undefined };
  }

  Object.assign(msg, { id: id(), key, senderId, wa, dir: 'out', ts: new Date().toISOString(), status: 'sent', ...(demo ? { demo: true } : {}) });
  db.messages.push(msg);
  if (msg.wamid) inboxIndex.set(msg.wamid, msg);
  db.chats[key] ||= { lastReadAt: new Date().toISOString() };
  leadApi.onSent(key);
  save();
  broadcast({ kind: 'message', key, dir: 'out' });
  if (demo) {
    // Simulated ticks: delivered, then read.
    setTimeout(() => { applyStatus(msg, { status: 'delivered' }); save(); broadcast({ kind: 'status', key }); }, 700 + Math.random() * 800);
    setTimeout(() => { applyStatus(msg, { status: 'read' }); save(); broadcast({ kind: 'status', key }); }, 2500 + Math.random() * 3000);
  }
  res.json(msg);
}));

// Media people send arrives as an ID; download it once with the number's token and cache it.
app.get('/api/media/:mid', wrap(async (req, res) => {
  const mid = req.params.mid;
  if (!/^\d+$/.test(mid)) throw fail('Invalid media id', 404);
  const file = path.join(MEDIA_DIR, mid);
  if (!fs.existsSync(file)) {
    const owner = db.messages.find((m) => m.media?.id === mid);
    const sender = db.senders.find((s) => s.id === owner?.senderId && s.accessToken) || db.senders.find((s) => s.accessToken);
    if (!sender) throw fail('No access token to download this media', 404);
    const info = await graph(sender, mid);
    const r = await fetch(info.url, { headers: { Authorization: `Bearer ${sender.accessToken}` } });
    if (!r.ok) throw fail(`Media download failed (HTTP ${r.status})`, 502);
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    fs.writeFileSync(file + '.json', JSON.stringify({ mime: info.mime_type }));
  }
  const { mime } = JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
  res.type(mime || 'application/octet-stream');
  if (req.query.name) res.attachment(String(req.query.name));
  res.sendFile(file);
}));

// --- Dashboard stats ----------------------------------------------------------

// Meta's messaging-limit tiers → unique recipients per 24h.
const TIER_LIMITS = { TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: null };
const dayKey = (d) => new Date(d).toLocaleDateString('en-CA'); // YYYY-MM-DD in server's local time

function computeStats(query = {}) {
  // Only count campaigns from the current mode, so demo runs never inflate live numbers.
  const demo = db.settings.demoMode;
  const range = [7, 14, 30, 90].includes(Number(query.range)) ? Number(query.range) : 14;
  const senderF = query.sender || '';
  const templateF = query.template || '';
  const all = db.campaigns.filter((c) => Boolean(c.demo) === demo);
  const camps = all.filter((c) => (!templateF || c.templateName === templateF) && (!senderF || c.senderIds.includes(senderF)));

  // Daily buckets for the range, plus the previous period of the same length for comparisons.
  const days = [];
  for (let i = range - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push({ date: dayKey(d), sent: 0, delivered: 0, read: 0, failed: 0 });
  }
  const byDay = Object.fromEntries(days.map((d) => [d.date, d]));
  const startKey = days[0].date;
  const prevStart = new Date(startKey + 'T00:00:00');
  prevStart.setDate(prevStart.getDate() - range);
  const prevStartKey = dayKey(prevStart);
  const today = dayKey(Date.now());

  const blank = () => ({ sent: 0, delivered: 0, read: 0, failed: 0 });
  const totals = { ...blank(), pending: 0 };
  const prev = blank();
  const perSender = {};
  for (const s of db.senders) perSender[s.id] = { today: 0, sent: 0, delivered: 0, read: 0, failed: 0 };

  const add = (bucket, r) => {
    const ok = r.status === 'sent' || r.status === 'delivered' || r.status === 'read';
    if (ok) bucket.sent++;
    if (r.status === 'delivered' || r.status === 'read') bucket.delivered++;
    if (r.status === 'read') bucket.read++;
    if (r.status === 'failed') bucket.failed++;
  };

  for (const c of camps) {
    for (const r of c.recipients) {
      if (senderF && r.senderId !== senderF) continue;
      if (r.status === 'pending' || r.status === 'queued') { totals.pending++; continue; }
      const at = r.sentAt || r.failedAt;
      if (!at) continue;
      const key = dayKey(at);
      if (byDay[key]) { add(byDay[key], r); add(totals, r); }
      else if (key >= prevStartKey && key < startKey) add(prev, r);
    }
  }

  // Number health is always "today" and unfiltered, so it reflects real daily limits.
  for (const c of all) {
    for (const r of c.recipients) {
      const ps = perSender[r.senderId];
      if (!ps) continue;
      add(ps, r);
      if (r.sentAt && dayKey(r.sentAt) === today) ps.today++;
    }
  }

  const senders = db.senders.map((s) => ({
    id: s.id,
    label: s.label,
    displayPhone: s.displayPhone,
    enabled: s.enabled,
    qualityRating: s.qualityRating || null,
    limit: s.messagingLimit in TIER_LIMITS ? TIER_LIMITS[s.messagingLimit] : undefined,
    ...perSender[s.id],
  }));

  return {
    demo,
    range,
    filters: { sender: senderF, template: templateF },
    options: { templates: [...new Set(all.map((c) => c.templateName))].sort() },
    days,
    totals,
    prev,
    senders,
    recent: camps.slice(0, 5).map(summary),
    upcoming: camps.filter((c) => c.status === 'scheduled').sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt)).slice(0, 5).map(summary),
    running: camps.filter((c) => c.status === 'running').length,
    setup: {
      sender: db.senders.length > 0,
      token: db.senders.some((s) => s.accessToken),
      template: db.templates.length > 0,
      campaign: db.campaigns.length > 0,
      live: !demo,
    },
    hasSeed: db.senders.some((s) => s.seed) || db.templates.some((t) => t.seed) || db.campaigns.some((c) => c.seed),
  };
}

app.get('/api/stats', (req, res) => res.json(computeStats(req.query)));

// --- Demo workspace -----------------------------------------------------------
// Fills the app with realistic sample numbers, templates and two weeks of
// campaign history so the dashboard can be explored before the API is ready.

app.post('/api/demo/seed', wrap((req, res) => {
  if (!db.settings.demoMode) throw fail('Turn on Demo mode first — sample data is only for demo mode');
  if (db.campaigns.some((c) => c.seed)) throw fail('Demo workspace is already loaded');

  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const names = ['Ravi', 'Priya', 'Amit', 'Sneha', 'Karan', 'Pooja', 'Arjun', 'Neha', 'Vikram', 'Anjali', 'Rohit', 'Kavya', 'Imran', 'Divya', 'Suresh', 'Meera'];

  const senders = [
    { label: 'Sales line 1', displayPhone: '+91 98200 11001', messagingLimit: 'TIER_1K', qualityRating: 'GREEN' },
    { label: 'Sales line 2', displayPhone: '+91 98200 11002', messagingLimit: 'TIER_1K', qualityRating: 'GREEN' },
    { label: 'Support', displayPhone: '+91 98200 11003', messagingLimit: 'TIER_250', qualityRating: 'YELLOW' },
  ].map((s, i) => ({ id: id(), phoneNumberId: 'DEMO' + (1000 + i), wabaId: 'DEMO-WABA', accessToken: '', enabled: true, createdAt: new Date().toISOString(), seed: true, verifiedName: 'Demo Store', ...s }));
  db.senders.push(...senders);

  const templates = [
    { name: 'festive_offer', category: 'MARKETING', components: [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Hi {{1}}! 🪔 Our festive sale is live — {{2}} off everything this week only.\n\nUse code {{3}} at checkout.' },
      { type: 'FOOTER', text: 'Reply STOP to opt out' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Shop now', url: 'https://example.com/sale' }, { type: 'QUICK_REPLY', text: 'Not interested' }] },
    ] },
    { name: 'order_shipped', category: 'UTILITY', components: [
      { type: 'BODY', text: 'Hi {{1}}, your order {{2}} has shipped and should arrive by {{3}}.' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Track order', url: 'https://example.com/track/{{1}}' }] },
    ] },
    { name: 'appointment_reminder', category: 'UTILITY', components: [
      { type: 'HEADER', format: 'TEXT', text: 'Reminder for {{1}}' },
      { type: 'BODY', text: 'Your appointment is on {{1}} at {{2}}. Reply YES to confirm or call us to reschedule.' },
    ] },
  ].map((t) => ({ id: id(), language: 'en', status: 'APPROVED', source: 'manual', parameterFormat: 'POSITIONAL', updatedAt: new Date().toISOString(), seed: true, ...t }));
  db.templates.push(...templates);

  // Plausible variable values so demo messages read naturally in the Inbox.
  const demoValues = (tplName, first) => ({
    festive_offer: { 'header.media': '', 'body.1': first, 'body.2': pick(['20%', '30%', '40%']), 'body.3': pick(['FEST30', 'DIWALI', 'SALE40']) },
    order_shipped: { 'body.1': first, 'body.2': '#' + rnd(10000, 99999), 'body.3': pick(['Friday', 'Saturday', 'Monday']), 'button0.1': String(rnd(10000, 99999)) },
    appointment_reminder: { 'header.1': first, 'body.1': pick(['Monday', 'Tuesday', 'Thursday']), 'body.2': pick(['10:30 AM', '2:00 PM', '5:15 PM']) },
  })[tplName] || {};

  const baseTitles = ['Weekend flash sale', 'New arrivals', 'Order updates', 'Festive offer — wave 1', 'Festive offer — wave 2', 'Loyalty members', 'Appointment reminders', 'Win-back: inactive buyers', 'Order updates', 'Diwali preview'];
  const older = ['Monsoon sale', 'Order updates', 'Back in stock', 'Appointment reminders', 'Feedback request', 'Order updates', 'Independence Day offer', 'New arrivals', 'Loyalty members', 'Order updates', 'Weekend flash sale', 'Appointment reminders', 'Price drop alert', 'Order updates'];
  const titles = [...older, ...baseTitles];
  const campaigns = [];
  for (let k = 0; k < titles.length; k++) {
    // The last 10 campaigns fall in the last two weeks; older ones spread back ~60 days.
    const fromEnd = titles.length - 1 - k;
    const daysAgo = fromEnd < 10 ? Math.round((fromEnd / 9) * 13) : 14 + Math.round(((fromEnd - 10) / (older.length - 1)) * 45);
    const start = new Date(Date.now() - daysAgo * 86400000);
    start.setHours(rnd(9, 18), rnd(0, 59), 0, 0);
    if (start > Date.now()) start.setTime(Date.now() - 3600000);
    const tpl = templates[k % templates.length];
    const useSenders = k % 3 === 2 ? senders.slice(0, 1) : senders.slice(0, rnd(2, 3));
    const size = rnd(90, 520);
    const recipients = [];
    for (let i = 0; i < size; i++) {
      const t0 = start.getTime() + i * rnd(150, 900);
      const roll = Math.random();
      const status = roll < 0.035 ? 'failed' : roll < 0.09 ? 'sent' : roll < 0.42 ? 'delivered' : 'read';
      const first = pick(names);
      const r = { phone: '9198' + String(rnd(10000000, 99999999)), name: `${first} ${String.fromCharCode(65 + rnd(0, 25))}.`, values: demoValues(tpl.name, first), senderId: useSenders[i % useSenders.length].id, status };
      if (status === 'failed') Object.assign(r, { failedAt: new Date(t0).toISOString(), error: pick(['131026: Message undeliverable', '131049: Not delivered to maintain ecosystem health', 'Recipient phone number not on WhatsApp']) });
      else {
        r.sentAt = new Date(t0).toISOString();
        r.messageId = 'wamid.DEMO' + id();
        if (status !== 'sent') r.deliveredAt = new Date(t0 + rnd(2, 40) * 1000).toISOString();
        if (status === 'read') r.readAt = new Date(t0 + rnd(60, 7200) * 1000).toISOString();
      }
      recipients.push(r);
    }
    const c = { id: id(), name: titles[k], templateId: tpl.id, templateName: tpl.name, senderIds: useSenders.map((s) => s.id), demo: true, seed: true, createdAt: start.toISOString(), startedAt: start.toISOString(), finishedAt: new Date(start.getTime() + size * 600).toISOString(), scheduledAt: null, status: 'completed', skipped: [], recipients };
    recount(c);
    campaigns.unshift(c);
  }

  // One upcoming scheduled send.
  const when = new Date(Date.now() + 86400000);
  when.setHours(10, 0, 0, 0);
  const upcoming = { id: id(), name: 'Diwali offer — main send', templateId: templates[0].id, templateName: templates[0].name, senderIds: senders.map((s) => s.id), demo: true, seed: true, createdAt: new Date().toISOString(), scheduledAt: when.toISOString(), status: 'scheduled', skipped: [],
    recipients: Array.from({ length: 640 }, (_, i) => ({ phone: '9198' + String(rnd(10000000, 99999999)), name: `${pick(names)} ${String.fromCharCode(65 + rnd(0, 25))}.`, values: {}, senderId: senders[i % 3].id, status: 'pending' })) };
  recount(upcoming);
  db.campaigns.unshift(upcoming, ...campaigns);
  seedConversations(campaigns);
  seedNotifications(campaigns);
  save();
  res.json({ ok: true });
}));

// Sample conversations for the demo workspace: replies to recent demo campaigns.
// Each script: minutes ago the chat started, whether it's been read, then the messages
// as [direction, minutes after the previous one, content].
function seedConversations(campaigns) {
  const scripts = [
    { ago: 4, unread: true, msgs: [['in', 0, { text: 'Hi, do you ship to Pune? 🙂' }]] },
    { ago: 18, unread: true, msgs: [['in', 0, { text: 'Can I reschedule to Friday instead?' }], ['in', 1, { text: 'Morning slot if possible' }]] },
    { ago: 55, msgs: [
      ['in', 0, { text: 'Is the 30% off valid on electronics too?' }],
      ['out', 3, { text: 'Yes! It applies to everything except gift cards 🎁' }],
      ['in', 2, { text: 'Great, ordering now' }],
      ['in', 0, { type: 'reaction', reaction: { emoji: '👍' }, reactTo: 1 }],
    ] },
    { ago: 140, msgs: [['in', 0, { type: 'button', text: 'Not interested' }]] },
    { ago: 210, msgs: [
      ['in', 0, { text: "This is where I am, is there a store nearby?" }],
      ['in', 0, { type: 'location', location: { lat: 19.0596, lng: 72.8295, name: 'Bandra West', address: 'Hill Road, Bandra West, Mumbai' } }],
      ['out', 6, { text: "Yes, we're 5 minutes away at Linking Road. Open till 9 pm today!", replyTo: 1 }],
    ] },
    { ago: 600, msgs: [['in', 0, { type: 'button', text: 'YES' }], ['out', 4, { text: 'Confirmed ✅ See you then!' }]] },
    { ago: 60 * 30, msgs: [
      ['in', 0, { text: "Where is my order? It's been 4 days" }],
      ['out', 9, { text: "Sorry about the delay! It's out for delivery today 🚚" }],
      ['in', 3, { text: 'Thanks!' }],
    ] },
    { ago: 60 * 75, msgs: [['in', 0, { text: 'STOP' }], ['out', 2, { text: "Done, you won't get offers from us anymore." }]] },
  ];
  const used = new Set();
  const now = Date.now();
  for (const sc of scripts) {
    const startAt = now - sc.ago * 60000;
    // Someone who got (and read) a demo campaign before this chat started.
    let r = null;
    for (const c of campaigns) {
      r = c.recipients.find((x) => x.status === 'read' && !used.has(x.phone) && new Date(x.sentAt).getTime() < startAt - 10 * 60000);
      if (r) break;
    }
    if (!r) continue;
    used.add(r.phone);
    const key = chatKey(r.senderId, r.phone);
    let t = startAt;
    const made = [];
    for (const [dir, gap, content] of sc.msgs) {
      t += gap * 60000;
      const { reactTo, replyTo, ...rest } = content;
      const m = { id: id(), wamid: 'wamid.DEMO' + id(), key, senderId: r.senderId, wa: r.phone, dir, type: 'text', text: '', ts: new Date(t).toISOString(), demo: true, seed: true, ...rest };
      if (dir === 'out') m.status = 'read';
      if (reactTo != null) m.reaction.to = made[reactTo].wamid;
      if (replyTo != null) m.context = made[replyTo].wamid;
      made.push(m);
      db.messages.push(m);
      inboxIndex.set(m.wamid, m);
    }
    db.chats[key] = { name: r.name.replace(/ [A-Z]\.$/, '') + ' ' + ['Sharma', 'Iyer', 'Khan', 'Reddy', 'Patel', 'Nair', 'Gupta', 'Das'][used.size % 8], lastReadAt: sc.unread ? null : new Date(t + 60000).toISOString(), seed: true };
  }
  seedContacts(campaigns);
}

// Sample contacts with tags: the people in the demo conversations plus some campaign recipients.
function seedContacts(campaigns) {
  const tagSpecs = [['Clients', 'green'], ['Leads', 'blue'], ['Developers', 'violet'], ['Designers', 'pink']];
  const tags = tagSpecs.map(([name, color]) => db.tags.find((t) => t.name === name) || (db.tags.push({ id: id(), name, color, seed: true, createdAt: new Date().toISOString() }), db.tags.at(-1)));
  const statuses = ['new', 'interested', 'qualified', 'won', 'new', 'interested'];
  const people = new Map();
  for (const [key, chat] of Object.entries(db.chats)) if (chat.seed) people.set(key.slice(key.lastIndexOf(':') + 1), chat.name);
  for (const c of campaigns) for (const r of c.recipients) if (people.size < 60 && !people.has(r.phone)) people.set(r.phone, r.name.replace(/ [A-Z]\.$/, ''));
  let i = 0;
  for (const [phone, name] of people) {
    if (db.contacts.some((x) => x.phone === phone)) continue;
    const t = [tags[i % 2].id, ...(i % 3 === 0 ? [tags[2 + (i % 2)].id] : [])];
    db.contacts.push({ id: id(), phone, name, email: '', company: ['Bright Clinic', 'Nova Studio', '', 'Kiran Traders', ''][i % 5], tags: t, status: statuses[i % statuses.length], optOut: false, notes: '', lead: {}, extra: {}, source: 'demo', seed: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    i++;
  }
}

// A few sample notifications so the Notifications page has something to show in the demo.
function seedNotifications(campaigns) {
  const chats = Object.entries(db.chats).filter(([, c]) => c.seed);
  const [k1, c1] = chats[0] || [], [k2, c2] = chats[1] || [], [k3, c3] = chats[2] || [];
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const withFails = campaigns.find((c) => c.stats?.failed) || campaigns[0];
  const items = [
    k1 && { kind: 'message', title: `New message from ${c1.name}`, body: 'Hi, do you ship to Pune? 🙂', link: { tab: 'inbox', key: k1 }, min: 4 },
    k2 && { kind: 'ai_draft', title: `AI drafted a reply to ${c2.name}`, body: 'Yes, our morning slots open at 9. Shall I book you in for tomorrow?', link: { tab: 'inbox', key: k2 }, min: 18 },
    k3 && { kind: 'ai_handover', title: `${c3.name} needs a person`, body: 'Asked about a refund for a damaged order', link: { tab: 'inbox', key: k3 }, min: 52 },
    { kind: 'campaign_done', title: `“${campaigns[0].name}” finished`, body: `${(campaigns[0].stats.sent + campaigns[0].stats.delivered + campaigns[0].stats.read).toLocaleString()} messages sent, ${campaigns[0].stats.failed} failed.`, link: { tab: 'campaigns', id: campaigns[0].id }, min: 95, read: true },
    { kind: 'delivery_failed', title: `${withFails.stats.failed} messages failed in “${withFails.name}”`, body: 'Most common reason: 131026: Message undeliverable', link: { tab: 'campaigns', id: withFails.id }, min: 100, count: withFails.stats.failed },
    k1 && { kind: 'ai_qualified', title: `${c1.name} is a qualified lead`, body: 'Wants bulk delivery to Pune before Diwali, budget around ₹40k', link: { tab: 'inbox', key: k1 }, min: 60 * 26, read: true },
    { kind: 'optout', title: 'Imran K. opted out', body: 'They asked to stop messages. They won’t be included in future sends.', link: { tab: 'contacts' }, min: 60 * 30, read: true },
  ].filter(Boolean);
  for (const it of items.reverse()) {
    const n = notes.add({ ...it, demo: true, seed: true });
    Object.assign(n, { ts: ago(it.min), read: Boolean(it.read) });
  }
  db.notifications.sort((a, b) => b.ts.localeCompare(a.ts));
}

app.delete('/api/demo/seed', wrap((req, res) => {
  if ([...running.keys()].some((cid) => db.campaigns.find((c) => c.id === cid)?.seed)) throw fail('Stop the running demo campaign first');

  db.campaigns = db.campaigns.filter((c) => !c.seed);
  db.senders = db.senders.filter((s) => !s.seed);
  db.templates = db.templates.filter((t) => !t.seed);
  db.messages = db.messages.filter((m) => !m.seed);
  for (const [key, chat] of Object.entries(db.chats)) if (chat.seed) delete db.chats[key];
  db.contacts = db.contacts.filter((c) => !c.seed);
  db.notifications = (db.notifications || []).filter((n) => !n.seed);
  const seedTags = new Set(db.tags.filter((t) => t.seed).map((t) => t.id));
  db.tags = db.tags.filter((t) => !t.seed);
  for (const c of db.contacts) c.tags = c.tags.filter((t) => !seedTags.has(t));
  inboxIndex.clear();
  for (const m of db.messages) if (m.wamid) inboxIndex.set(m.wamid, m);
  save();
  res.json({ ok: true });
}));

// --- Contacts and the Inbox lead assistant ------------------------------------

notes = require('./notifications')(app, { db, save, id, wrap, broadcast });
const contactsApi = require('./contacts')(app, { db, save, id, wrap, fail, normalizePhone, broadcast });
const leadApi = require('./lead')(app, { db, save, id, wrap, fail, aiConfig, broadcast, contacts: contactsApi, notes });

// --- AI assistant -------------------------------------------------------------

require('./ai')(app, { db, save, id, wrap, fail, aiConfig, contacts: contactsApi, normalizePhone, templateVariables, createCampaign, computeStats, summary, publicSender });

app.listen(PORT, () => {
  console.log(`WhatsApp Sender running at http://localhost:${PORT}`);
  console.log(db.settings.demoMode ? 'Demo mode is ON — no real messages will be sent.' : 'LIVE mode — messages will be sent via the WhatsApp Cloud API.');
  if (!APP_PASSWORD) console.log('Tip: set APP_PASSWORD=yourpassword to protect the dashboard before exposing it publicly.');
});
