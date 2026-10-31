// WhatsApp bulk sender — Express backend.
// Each business has its own workspace (tenancy.js: accounts, sign-in, one data file per
// workspace). Talks to the WhatsApp Cloud API (graph.facebook.com) and runs campaigns across
// multiple sender numbers.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads'); // template header files (served at /u/…)

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const DEFAULT_DB = {
  settings: {
    demoMode: false, // new workspaces send for real; see tenants.demoAllowed
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
  // Redirect links for "Visit website" buttons: { id: code, url, createdAt, clicks }. See /go/:code.
  links: [],
};

// One workspace per business; `db` always means the current request's workspace.
const store = global.__store || require('./store').fileStore(DATA_DIR); // main.js opens Postgres when DATABASE_URL is set
const tenants = require('./tenancy')({ store, defaultDb: DEFAULT_DB, appPassword: APP_PASSWORD, ownerEmail: process.env.OWNER_EMAIL || '' });
const { db, save } = tenants;

const id = () => crypto.randomBytes(8).toString('hex');

// messageId -> { campaignId, index } so webhook status updates find their recipient.
const messageIndex = new Map();
// wamid -> inbox message, for de-duplicating webhook deliveries and applying status updates.
const inboxIndex = new Map();
for (const ws of tenants.allWorkspaces()) tenants.forWorkspace(ws, () => {
  for (const c of db.campaigns) {
    c.recipients.forEach((r, i) => r.messageId && messageIndex.set(r.messageId, { campaignId: c.id, index: i }));
    // A campaign that was mid-run when the server stopped can't resume its in-memory loop.
    // Campaigns sent before names were picked up from columns like "Contact Name": take them from the greeting.
    if (c.recipients.length && c.recipients.every((r) => !r.name)) {
      const g = greetingVar(db.templates.find((t) => t.id === c.templateId));
      if (g && c.recipients.some((r) => r.values?.[g])) { for (const r of c.recipients) r.name = String(r.values?.[g] || '').trim().slice(0, 120); save(); }
    }
    if (c.status === 'running') { c.status = 'stopped'; c.pausedReason = 'Stopped because the server restarted while it was sending (for example a new deploy). Nothing was lost: press Resume to send the rest.'; save(); }
  }
  // Rewrite once so secrets stored before encryption was turned on get encrypted.
  if (require('./secrets').enabled) save();
  for (const m of db.messages) if (m.wamid) inboxIndex.set(m.wamid, m);
  // Workspaces that may not use demo mode (it used to be on for every new one): switch them to live and clear the sample data.
  if (!tenants.demoAllowed() && (db.settings.demoMode || hasSeedData())) {
    db.settings.demoMode = false;
    removeSeedData();
    for (const c of db.campaigns) if (c.demo && c.status === 'scheduled') c.status = 'cancelled';
    save();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const maskToken = (t) => (t ? '••••' + t.slice(-4) : '');

function publicSender(s) {
  const { accessToken, ...rest } = s;
  return { ...rest, accessTokenMasked: maskToken(accessToken), hasToken: Boolean(accessToken) };
}

// A number someone typed in a form: digits with optional +, spaces, dashes or brackets, and either
// 10 digits (the default country code is added) or the full number with country code (up to 15).
// Returns an error message, or '' when it's fine. (Imported sheets go through normalizePhone, which is forgiving.)
function phoneInputError(input) {
  const v = String(input ?? '').trim();
  if (!v) return 'Enter a phone number';
  if (!/^\+?[\d\s\-().]+$/.test(v)) return 'A phone number can only have digits (and a + at the start)';
  const digits = v.replace(/\D/g, '').replace(/^00/, '');
  if (digits.length < 10) return 'That number is too short. Enter 10 digits, or the full number with the country code.';
  if (digits.length > 15) return 'That number is too long. Phone numbers have at most 15 digits.';
  return normalizePhone(v) ? '' : 'Enter a valid phone number';
}

// Every phone number in a cell, best first. Lead sheets often hold several ("98450 08573 / 99805 17082",
// "Mobile: … ⏎ Telephone: …"); each part is read on its own, notes in brackets are ignored, and fewer than
// 10 or more than 15 digits isn't a phone number. Office/landline numbers go last (they rarely have WhatsApp).
// Keep in step with phoneCandidates in public/app.js.
function phoneCandidates(input) {
  const cc = db.settings.defaultCountryCode;
  const best = [], last = [];
  for (const part of String(input ?? '').split(/[\n,;|]+|\s*\/\s*|\s+(?:or|and|&)\s+/i)) {
    let d = part.replace(/\([^)]*\)/g, ' ').replace(/\D/g, '').replace(/^00/, '');
    if (cc && d.length === 10) d = cc + d;
    else if (cc && d.length === 11 && d.startsWith('0')) d = cc + d.slice(1);
    if (d.length < 10 || d.length > 15) continue;
    (/\b(tel|telephone|office|landline|fax|board)\b/i.test(part) ? last : best).push(d);
  }
  return [...new Set([...best, ...last])];
}
function normalizePhone(input) {
  return phoneCandidates(input)[0] || null;
}

// A sheet value for a {{variable}}: bracketed notes dropped ("Sourceways (unclear)" → "Sourceways"), and
// placeholders like "Not Captured", "N/A" or "-" count as empty, so the Send page's fallback can step in.
// Keep in step with cleanCell in public/app.js.
const FILLER = /^(not\s*(captured|available|applicable|known|mentioned|provided|given|found)|n\s*\/?\s*a|nil|null|none|unknown|invalid|tbd|tba|no\s*data|-+|\.+|\?+|x+)$/i;
function cleanCell(v) {
  const s = String(v ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return !s || FILLER.test(s) ? '' : s;
}

// Links typed as values must be complete. `mustBeLink`: a button link or header file (only a full http(s) address
// works there). Otherwise only text that looks like a link without its https:// ("cal.com/demo", "www.x.com") is a
// problem: WhatsApp wouldn't make it tappable. Returns what's wrong, or ''. Keep in step with linkProblem in public/app.js.
function linkProblem(value, mustBeLink = false) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  const full = /^https?:\/\/(?:[^\s/?#]+\.[^\s/?#]{2,}|localhost(?::\d+)?)(?:[/?#]\S*)?$/i.test(v);
  if (mustBeLink) return full ? '' : /^(https?:)?\/\//i.test(v) ? 'is not a complete link' : 'must start with https:// or http://';
  const word = v.split(/\s+/).find((w) => /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(w) && !/^https?:\/\//i.test(w) && !/@/.test(w) && /^www\.|\//i.test(w));
  const isFull = (w) => /^https?:\/\/(?:[^\s/?#]+\.[^\s/?#]{2,}|localhost(?::\d+)?)(?:[/?#]\S*)?$/i.test(w);
  const broken = v.split(/\s+/).find((w) => /^h?tt?ps?[:/]/i.test(w) && !isFull(w)); // "https//x", "htps://x", "https://"
  if (broken) return `has a broken link (${broken})`;
  return word ? `has a link without https:// (${word})` : '';
}
// Every value a message would be sent with, checked: the first problem as "{{2}} has a link without https://…".
function valuesProblem(template, values) {
  for (const v of templateVariables(template.components)) {
    const bad = linkProblem(values[v.key], Boolean(v.media) || /^button/.test(v.where));
    if (bad) return `${v.media ? `The header ${v.media} link` : /^button/.test(v.where) ? 'The button link' : `{{${v.name}}}`} ${bad}`;
  }
  return '';
}
// The name WhatsApp shows on a document header (otherwise it says "Untitled"): the one typed on the Send page,
// else the name at the end of the link (uploads keep the original there), else "Document.pdf".
function safeFileName(name, ext = 'pdf') {
  let n = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/\s+\./g, '.').trim().slice(0, 100);
  if (!n) return '';
  if (!new RegExp(`\\.${ext}$`, 'i').test(n)) n += '.' + ext;
  return n;
}
function docFileName(values) {
  const typed = safeFileName(values['header.filename']);
  if (typed) return typed;
  let last = '';
  try { last = decodeURIComponent(new URL(values['header.media']).pathname.split('/').filter(Boolean).pop() || ''); } catch {}
  return /^[0-9a-f]{32}\.[a-z0-9]{2,4}$/.test(last) || !/\.[a-z0-9]{2,4}$/i.test(last) ? 'Document.pdf' : safeFileName(last, last.split('.').pop());
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
      parameters: media ? [{ type: media.media, [media.media]: { link: values[media.key], ...(media.media === 'document' ? { filename: docFileName(values) } : {}) } }] : header.map(param),
    });
  }
  const body = vars.filter((v) => v.where === 'body');
  if (body.length) out.push({ type: 'body', parameters: body.map(param) });

  const buttons = comps.find((c) => (c.type || '').toUpperCase() === 'BUTTONS');
  (buttons?.buttons || []).forEach((b, i) => {
    const bv = vars.filter((v) => v.where === `button${i}`);
    const viaGo = isGoButton(b);
    if (bv.length) out.push({ type: 'button', sub_type: 'url', index: String(i), parameters: bv.map((v) => ({ type: 'text', text: viaGo ? goCode(values[v.key]) : String(values[v.key] ?? '') })) });
  });
  return out;
}

// "Visit website" buttons can only change the end of their link, so a template whose button is
// https://<this app>/go/{{1}} gets a short code, and /go/<code> sends people on to the full link
// pasted when sending. That way the button can open any link, not just one site's pages.
const isGoButton = (b) => b.type === 'URL' && /\/go\/{{\s*\w+\s*}}$/.test(b.url || '');
function goCode(value) {
  const url = String(value ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return url; // already a code (or the end of a link): sent as is
  const found = db.links.find((l) => l.url === url);
  if (found) return found.id;
  let code;
  do code = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 7).toLowerCase(); while (code.length < 7 || tenants.allWorkspaces().some((ws) => ws.db.links?.some((l) => l.id === code)));
  db.links.push({ id: code, url, createdAt: new Date().toISOString(), clicks: 0 });
  save();
  return code;
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

// Failures that say the list (or the number) is in trouble. Meta's marketing cap (131049) and rate
// limits are Meta's choice about timing, not bad numbers, so they don't count towards auto-pausing.
const NOT_LIST_PROBLEMS = /^(131049|130429|131056|4|80007):/;
const listFailures = (c) => c.recipients.filter((r) => r.status === 'failed' && !NOT_LIST_PROBLEMS.test(String(r.error || ''))).length;
const attempted = (c) => c.recipients.filter((r) => ['sent', 'delivered', 'read', 'failed'].includes(r.status)).length;

async function runCampaign(campaign) {
  const control = { stop: false };
  running.set(campaign.id, control);
  campaign.status = 'running';
  // This run is judged on its own messages: what went wrong before (and was resumed past) doesn't count again.
  delete campaign.pausedReason;
  const base = { done: attempted(campaign), failed: listFailures(campaign) };
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
      // Many failures usually means a bad list or a blocked number: stop before it hurts the number's quality.
      const done = attempted(campaign) - base.done, bad = listFailures(campaign) - base.failed;
      if (!campaign.demo && !control.stop && done >= 40 && bad / done > 0.3) {
        control.stop = true;
        campaign.pausedReason = `Paused automatically: ${Math.round((100 * bad) / done)}% of ${done} messages failed because the numbers couldn't receive them (not on WhatsApp, blocked, or wrong). Sending more to a list like this can lower your number's quality rating. Check the failures before sending the rest.`;
      }
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
  if (campaign.pausedReason) notes?.add({ kind: 'delivery_failed', title: `“${campaign.name}” was paused`, body: campaign.pausedReason, link: { tab: 'campaigns', id: campaign.id } });
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
const security = require('./security');
app.set('trust proxy', 1); // behind Railway's proxy: req.ip is the visitor, not the proxy
app.disable('x-powered-by');
app.use(security.headers);
app.use(security.sameOrigin);

// Webhook must stay reachable by Meta without the app password.
// Every workspace uses this same URL; Meta's verify token says which one is setting it up.
app.get('/webhook', (req, res) => {
  const token = String(req.query['hub.verify_token'] || '');
  const ok = req.query['hub.mode'] === 'subscribe' && token && tenants.allWorkspaces().some((ws) => ws.db.settings.webhookVerifyToken === token);
  return ok ? res.status(200).send(req.query['hub.challenge']) : res.sendStatus(403);
});

// Each change belongs to the workspace that owns its phone number.
app.post('/webhook', express.json({ limit: '2mb' }), (req, res) => {
  res.sendStatus(200);
  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'message_template_status_update') {
        // No phone number here: the entry is the Business Account.
        const ws = tenants.allWorkspaces().find((w) => w.db.senders.some((x) => x.wabaId === String(entry.id)) || w.db.templates.some((x) => x.metaId === String(change.value?.message_template_id)));
        if (ws) tenants.forWorkspace(ws, () => handleTemplateStatus(String(entry.id), change.value || {}));
        continue;
      }
      const ws = tenants.byPhoneNumberId(change.value?.metadata?.phone_number_id);
      if (ws) tenants.forWorkspace(ws, () => handleWebhookChange(change));
    }
  }
});

function handleWebhookChange(change) {
  const rank = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
  const failedIn = new Set(); // campaigns that got new delivery failures in this webhook
  {
    {
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
}

// Sign up, sign in, invites (tenancy.js). Everything after requireAuth needs a signed-in
// member and runs inside their workspace.
tenants.mountAuth(app, express);

app.use(express.json({ limit: '20mb' }));
// Images and files uploaded for template headers. Meta fetches them by link without signing in,
// so they're public; the random names keep them unguessable.
// A document's link ends with its file name (/u/<file>/<name>), which WhatsApp shows instead of "Untitled".
app.get(['/u/:file', '/u/:file/:name'], (req, res) => {
  if (!/^[0-9a-f]{32}\.[a-z0-9]{2,4}$/.test(req.params.file)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('X-Frame-Options', 'SAMEORIGIN'); // the app's PDF preview shows these in a frame
  res.sendFile(path.join(UPLOAD_DIR, req.params.file), (err) => err && !res.headersSent && res.status(404).end());
});
// A template button's redirect link (see goCode). Public: the people tapping it aren't signed in.
app.get('/go/:code', (req, res) => {
  const code = String(req.params.code).toLowerCase();
  for (const ws of tenants.allWorkspaces()) {
    const link = ws.db.links?.find((l) => l.id === code);
    if (!link) continue;
    tenants.forWorkspace(ws, () => { link.clicks = (link.clicks || 0) + 1; link.lastClickAt = new Date().toISOString(); save(); });
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, link.url);
  }
  res.status(404).send('This link has expired or never existed.');
});
// The sign-in pages and the landing page use these files, so they load without signing in.
const PUBLIC_FILES = new Set(['/style.css', '/icons.css', '/icons.js', '/gradient-ascii.js', '/otp.js', '/password-rules.js', '/brand/logo.svg', '/brand/logo-small.svg']);
// The home page: the landing page for visitors, the app for anyone signed in. (/welcome always shows the landing page.)
const LANDING = path.join(__dirname, 'public', 'landing.html');
app.get(['/', '/welcome'], (req, res, next) => {
  if (req.path === '/' && tenants.signedIn(req)) return next();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(LANDING);
});
app.use((req, res, next) => (PUBLIC_FILES.has(req.path) ? next() : tenants.requireAuth(req, res, next)));
app.use(security.rateLimit); // after sign-in, so limits are per user
// The AI features (the Assistant and the Inbox lead assistant) are admin-only for now.
const AI_PATHS = ['/api/ai', /^\/api\/inbox\/[^/]+\/(draft|ai)$/];
app.use(AI_PATHS, (req, res, next) => (req.admin ? next() : res.status(403).json({ error: 'The AI assistant isn’t available on this account' })));
// Browsers must check for a newer copy every time, so an update shows on a normal refresh.
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
// Each page has its own address (/send, /inbox…): they're all the one app page, which shows the right one.
const APP_PAGES = ['overview', 'assistant', 'inbox', 'contacts', 'send', 'campaigns', 'numbers', 'templates', 'notifications', 'settings'];
app.get(APP_PAGES.map((p) => '/' + p), (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });
// D3 for the dashboard charts, served locally so it works offline.
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'd3', 'dist')));

const wrap = (fn) => (req, res) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch((e) => res.status(e.httpStatus || 400).json({ error: e.message }));
const fail = (msg, httpStatus = 400) => Object.assign(new Error(msg), { httpStatus });
tenants.mountAccountApi(app, { wrap, fail });

// --- Settings ---------------------------------------------------------------

// AI assistant: Claude (Anthropic) or Gemini (Google). Keys are write-only from the browser, like sender access tokens.
const AI_PROVIDERS = ['gemini', 'claude'];
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
function aiConfig() {
  // Keys from the server's environment only serve the original workspace; every other business brings its own.
  const env = tenants.isLegacy() ? process.env : {};
  const keys = { claude: db.settings.anthropicApiKey || env.ANTHROPIC_API_KEY || '', gemini: db.settings.geminiApiKey || env.GEMINI_API_KEY || '' };
  // Until one is picked, use whichever has a key (Gemini first: it has a free tier).
  const provider = AI_PROVIDERS.includes(db.settings.aiProvider) ? db.settings.aiProvider : keys.gemini || !keys.claude ? 'gemini' : 'claude';
  return { provider, key: keys[provider], keys, geminiModel: db.settings.geminiModel || DEFAULT_GEMINI_MODEL };
}
function publicSettings(req) {
  const { anthropicApiKey, geminiApiKey, leadAgent, aiProvider, geminiModel, ...rest } = db.settings;
  if (!req.admin) return { ...rest, demoAllowed: tenants.demoAllowed() }; // AI is admin-only
  const ai = aiConfig();
  return {
    ...rest,
    leadAgent,
    demoAllowed: tenants.demoAllowed(),
    aiProvider: ai.provider,
    geminiModel: ai.geminiModel,
    hasAiKey: Boolean(ai.key),
    aiKeyMasked: maskToken(anthropicApiKey),
    aiKeyFromEnv: !anthropicApiKey && tenants.isLegacy() && Boolean(process.env.ANTHROPIC_API_KEY),
    hasGeminiKey: Boolean(ai.keys.gemini),
    geminiKeyMasked: maskToken(geminiApiKey),
    geminiKeyFromEnv: !geminiApiKey && tenants.isLegacy() && Boolean(process.env.GEMINI_API_KEY),
  };
}

app.get('/api/settings', (req, res) => res.json(publicSettings(req)));

app.put('/api/settings', (req, res) => {
  const allowed = ['demoMode', 'graphVersion', 'defaultCountryCode', 'defaultCountry', 'webhookVerifyToken', 'concurrencyPerNumber', 'delayMsPerNumber'];
  // A calling code is 1–3 digits; the country is its two-letter ISO code (it tells +1 US from +1 Canada).
  if ('defaultCountryCode' in req.body && !/^\d{1,3}$/.test(String(req.body.defaultCountryCode))) return res.status(400).json({ error: 'The country code should be 1–3 digits, e.g. 91 for India' });
  if ('defaultCountry' in req.body && req.body.defaultCountry && !/^[A-Z]{2}$/.test(String(req.body.defaultCountry))) return res.status(400).json({ error: 'Pick a country from the list' });
  for (const k of allowed) if (k in req.body) db.settings[k] = req.body[k];
  if (!tenants.demoAllowed()) db.settings.demoMode = false;
  db.settings.concurrencyPerNumber = Math.min(50, Math.max(1, Number(db.settings.concurrencyPerNumber) || 1));
  db.settings.delayMsPerNumber = Math.max(0, Number(db.settings.delayMsPerNumber) || 0);
  if (req.admin) saveAiSettings(req.body);
  save();
  res.json(publicSettings(req));
});

// AI keys, provider and the lead assistant (admin-only, see AI_PATHS).
function saveAiSettings(body) {
  // Blank means "keep the saved key"; removing it is an explicit flag.
  if (typeof body.anthropicApiKey === 'string' && body.anthropicApiKey.trim()) db.settings.anthropicApiKey = body.anthropicApiKey.trim();
  if (body.removeAnthropicApiKey) delete db.settings.anthropicApiKey;
  if (typeof body.geminiApiKey === 'string' && body.geminiApiKey.trim()) db.settings.geminiApiKey = body.geminiApiKey.trim();
  if (body.removeGeminiApiKey) delete db.settings.geminiApiKey;
  if (body.leadAgent && typeof body.leadAgent === 'object') {
    const l = body.leadAgent;
    db.settings.leadAgent = {
      enabled: Boolean(l.enabled),
      autoReply: Boolean(l.enabled && l.autoReply),
      business: String(l.business ?? db.settings.leadAgent?.business ?? '').slice(0, 20000),
      qualified: String(l.qualified ?? db.settings.leadAgent?.qualified ?? '').slice(0, 4000),
    };
  }
  if (AI_PROVIDERS.includes(body.aiProvider)) db.settings.aiProvider = body.aiProvider;
  if (typeof body.geminiModel === 'string') {
    const m = body.geminiModel.trim().replace(/^models\//, '');
    if (!m) delete db.settings.geminiModel;
    else if (/^[\w.-]{1,80}$/.test(m)) db.settings.geminiModel = m;
  }
}

// --- Sender numbers ---------------------------------------------------------

app.get('/api/senders', (req, res) => res.json(db.senders.map(publicSender)));

// A number's label shows on cards, filters and the Send page: keep it short.
const tidyLabel = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
const senderLabelError = (v) => { const s = tidyLabel(v); return !s ? 'Give the number a label' : s.length > 40 ? `Keep the label to 40 characters (it's ${s.length})` : ''; };

// Meta's IDs are numbers; the display phone, if given, is a phone number. Values already saved
// (e.g. demo placeholders) are left alone when an edit doesn't change them.
function senderIdsError(body, existing) {
  const changed = (k) => k in body && String(body[k] ?? '').trim() !== String(existing?.[k] ?? '');
  for (const [k, name] of [['phoneNumberId', 'Phone number ID'], ['wabaId', 'WhatsApp Business Account ID']]) {
    const v = String(body[k] ?? '').trim();
    if (v && changed(k) && !/^\d{10,17}$/.test(v)) return `${name} should be 10–17 digits (copy it from Meta → WhatsApp → API Setup)`;
  }
  const dp = String(body.displayPhone ?? '').trim();
  if (dp && changed('displayPhone')) { const e = phoneInputError(dp); if (e) return 'Display phone: ' + e.charAt(0).toLowerCase() + e.slice(1); }
  return '';
}

// --- Checking a number with Meta before it's saved ----------------------------------------
// Live numbers are only saved once Meta confirms the token works, the phone number ID exists and
// (when given) it belongs to that Business Account. Demo mode skips this: its numbers are placeholders.
// Only reads from Meta; nothing is sent.
async function verifyWithMeta({ phoneNumberId, wabaId, accessToken }) {
  const who = { label: 'this number', accessToken };
  const say = (e, fallback) => {
    if (e.code === 190) return "Meta doesn't accept this access token. It may be mistyped, expired or revoked. Create a permanent system-user token in Meta Business Settings and paste it again.";
    if (e.code === 10 || e.code === 200 || e.code === 3) return "This token doesn't have permission for this number. Give the system user the whatsapp_business_messaging and whatsapp_business_management permissions.";
    if (e.status === 429 || e.code === 4 || e.code === 80008) return 'Meta is rate limiting checks right now. Wait a minute and try again.';
    if (!e.status) return "Couldn't reach Meta to check this number. Check the server's internet connection and try again.";
    // Meta's own text only when it adds something (not its generic "Unsupported get request…").
    return fallback + (e.message && !/Unsupported get request|does not exist/i.test(e.message) ? ` (Meta said: ${e.message})` : '');
  };
  let info;
  try { info = await graph(who, `${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`); }
  catch (e) { throw fail(say(e, "Meta has no WhatsApp number with this phone number ID that this token can use. Copy the ID from Meta → WhatsApp → API Setup (it isn't the phone number itself).")); }
  if (!info.display_phone_number) throw fail("That ID isn't a WhatsApp phone number ID. Copy the Phone number ID from Meta → WhatsApp → API Setup.");
  const found = await findWaba(who, phoneNumberId, wabaId, say);
  return { displayPhone: info.display_phone_number, verifiedName: info.verified_name || '', qualityRating: info.quality_rating, messagingLimit: info.messaging_limit_tier, ...(found ? { wabaId: found } : {}) };
}
// Works out which WhatsApp Business Account holds the number, so nobody has to dig the ID out of Meta.
// `given` may be the account ID, the Business portfolio ID (the business_id= in business.facebook.com links,
// which people paste by mistake) or blank, in which case the token's own permissions are asked.
async function findWaba(who, phoneNumberId, given, say) {
  const holds = async (waba) => (await graph(who, `${encodeURIComponent(waba)}/phone_numbers?fields=id&limit=200`)).data?.some((x) => x.id === String(phoneNumberId));
  const firstHolding = async (ids) => { for (const w of ids) if (await holds(w).catch(() => false)) return w; return ''; };
  if (given) {
    try {
      if (await holds(given)) return given;
      throw fail("This number isn't in that WhatsApp Business Account. Paste your Business portfolio ID instead (the business_id= in business.facebook.com links) and the right account is found from it.");
    } catch (e) {
      if (e.code !== 100) throw e.httpStatus ? e : fail(say(e,"Meta has no WhatsApp Business Account with this ID that this token can use. Paste your Business portfolio ID instead (the business_id= in business.facebook.com links) and the right account is found from it."));
    }
    // Code 100 "nonexisting field": a real ID, but not a WhatsApp Business Account. Try it as a Business portfolio.
    const accounts = [];
    for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
      try { accounts.push(...((await graph(who, `${encodeURIComponent(given)}/${edge}?fields=id&limit=200`)).data || []).map((x) => x.id)); } catch {}
    }
    const w = await firstHolding(accounts);
    if (w) return w;
    throw fail("That isn't a WhatsApp Business Account ID, and no account under it holds this number. Paste your Business portfolio ID instead (the business_id= in business.facebook.com links) and the right account is found from it.");
  }
  // Blank: tokens limited to particular accounts list them in their permissions. Unrestricted tokens don't,
  // so then the accounts of the businesses the token can see are tried. If neither works the field stays
  // empty; it's only needed for syncing templates.
  try {
    const d = (await graph(who, `debug_token?input_token=${encodeURIComponent(who.accessToken)}`)).data || {};
    const ids = [...new Set((d.granular_scopes || []).filter((g) => /^whatsapp_business_/.test(g.scope)).flatMap((g) => g.target_ids || []))];
    const w = await firstHolding(ids);
    if (w) return w;
  } catch {}
  try {
    const businesses = ((await graph(who, 'me/businesses?fields=id&limit=50')).data || []).map((x) => x.id);
    const accounts = [];
    for (const b of businesses) for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
      try { accounts.push(...((await graph(who, `${encodeURIComponent(b)}/${edge}?fields=id&limit=200`)).data || []).map((x) => x.id)); } catch {}
    }
    return await firstHolding([...new Set(accounts)]);
  } catch { return ''; }
}
// Meta only sends a Business Account's webhooks (replies, delivered/read) to apps it's linked to, and new
// accounts usually aren't. Linking again is harmless, so it's done on every save. A failure doesn't stop the
// number being saved (sending works without it); it comes back as a warning to show.
async function linkWebhooks(s) {
  if (!s.wabaId || db.settings.demoMode) return '';
  try { await graph(s, `${encodeURIComponent(s.wabaId)}/subscribed_apps`, { method: 'POST' }); return ''; }
  catch (e) { return `Saved, but Meta wouldn't link this Business Account to your app, so replies and delivered/read ticks won't arrive (Meta said: ${e.message}). Give the token the whatsapp_business_management permission and save again.`; }
}
// The token to check with: the one typed in, else the number's saved one, else one shared by a number in the same Business Account.
function tokenFor(body, existing) {
  const typed = String(body.accessToken || '').trim();
  if (typed) return typed;
  if (existing?.accessToken) return existing.accessToken;
  const waba = String(body.wabaId || existing?.wabaId || '').trim();
  return (waba && db.senders.find((x) => x !== existing && x.wabaId === waba && x.accessToken)?.accessToken) || '';
}
const NEED_TOKEN = 'Paste the access token for this number. It lets the app send from it; Meta Business Settings → System users → Generate token.';

// The popup's "Test connection": checks what's typed without saving anything.
app.post('/api/senders/verify', wrap(async (req, res) => {
  const existing = req.body.senderId ? db.senders.find((x) => x.id === req.body.senderId) : null;
  const pnid = String(req.body.phoneNumberId || '').trim(), waba = String(req.body.wabaId || '').trim();
  const idErr = senderIdsError({ phoneNumberId: pnid, wabaId: waba });
  if (!pnid) throw fail('Enter the phone number ID first');
  if (idErr) throw fail(idErr);
  const token = tokenFor(req.body, existing);
  if (!token) throw fail(NEED_TOKEN);
  res.json({ ok: true, info: await verifyWithMeta({ phoneNumberId: pnid, wabaId: waba, accessToken: token }), sharedToken: !req.body.accessToken && !existing?.accessToken });
}));

app.post('/api/senders', wrap(async (req, res) => {
  const { label, phoneNumberId, wabaId, displayPhone } = req.body;
  if (!label || !phoneNumberId) throw fail('Label and Phone Number ID are required');
  const labelErr = senderLabelError(label) || senderIdsError(req.body);
  if (labelErr) throw fail(labelErr);
  const s = { id: id(), label: tidyLabel(label), phoneNumberId: String(phoneNumberId).trim(), wabaId: String(wabaId || '').trim(), accessToken: tokenFor(req.body), displayPhone: displayPhone || '', enabled: true, createdAt: new Date().toISOString() };
  if (!db.settings.demoMode) {
    if (!s.accessToken) throw fail(NEED_TOKEN);
    Object.assign(s, await verifyWithMeta(s), { lastCheckedAt: new Date().toISOString() });
  }
  db.senders.push(s);
  save();
  res.json({ ...publicSender(s), warning: await linkWebhooks(s) });
}));

app.put('/api/senders/:id', wrap(async (req, res) => {
  const s = db.senders.find((x) => x.id === req.params.id);
  if (!s) throw fail('Not found', 404);
  if ('label' in req.body) { const e = senderLabelError(req.body.label); if (e) throw fail(e); req.body.label = tidyLabel(req.body.label); }
  { const e = senderIdsError(req.body, s); if (e) throw fail(e); }
  // A new token or different IDs are checked with Meta before anything changes (switching a number on/off isn't).
  const next = { phoneNumberId: String(req.body.phoneNumberId ?? s.phoneNumberId).trim(), wabaId: String(req.body.wabaId ?? s.wabaId ?? '').trim(), accessToken: tokenFor(req.body, s) };
  // A number still missing its Business Account is checked again too, so saving it can fill the account in.
  const credsChanged = Boolean(String(req.body.accessToken || '').trim()) || next.phoneNumberId !== s.phoneNumberId || next.wabaId !== String(s.wabaId || '') || !next.wabaId;
  let checked = null;
  if (credsChanged && !db.settings.demoMode) {
    if (!next.accessToken) throw fail(NEED_TOKEN);
    checked = await verifyWithMeta(next);
  }
  for (const k of ['label', 'phoneNumberId', 'wabaId', 'displayPhone', 'enabled']) if (k in req.body) s[k] = typeof req.body[k] === 'string' ? req.body[k].trim() : req.body[k];
  // Blank token on edit means "keep the existing one".
  if (req.body.accessToken) s.accessToken = req.body.accessToken.trim();
  if (checked) Object.assign(s, checked, { lastCheckedAt: new Date().toISOString() });
  save();
  res.json({ ...publicSender(s), warning: checked ? await linkWebhooks(s) : '' });
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
  await readProfilePhoto(s);
  save();
  res.json({ ok: true, info, sender: publicSender(s) });
}));

// --- WhatsApp profile photo -------------------------------------------------
// The picture customers see on the business's chat. Meta's link to it expires after a while, so it's
// read again on Test connection, after a change, and when the Numbers page finds it missing.
async function readProfilePhoto(s) {
  try {
    const p = (await graph(s, `${s.phoneNumberId}/whatsapp_business_profile?fields=profile_picture_url`)).data?.[0] || {};
    s.photoUrl = p.profile_picture_url || '';
  } catch { /* the photo is a nicety: a failed read leaves the old one */ }
  s.photoCheckedAt = new Date().toISOString();
}
app.post('/api/senders/:id/photo/refresh', wrap(async (req, res) => {
  const s = db.senders.find((x) => x.id === req.params.id);
  if (!s) throw fail('Not found', 404);
  if (s.accessToken && !db.settings.demoMode) await readProfilePhoto(s);
  save();
  res.json(publicSender(s));
}));
// The current photo itself, passed through this server so the photo editor can work on it (the browser
// won't let a page edit a picture loaded straight from WhatsApp's image server).
app.get('/api/senders/:id/photo/file', wrap(async (req, res) => {
  const s = db.senders.find((x) => x.id === req.params.id);
  if (!s) throw fail('Not found', 404);
  const get = () => (s.photoUrl ? fetch(s.photoUrl) : null);
  let r = await get();
  if (!r?.ok && s.accessToken && !db.settings.demoMode) { await readProfilePhoto(s); save(); r = await get(); } // the link had expired
  if (!r?.ok) throw fail('This number has no profile photo yet', 404);
  res.type(r.headers.get('content-type') || 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(Buffer.from(await r.arrayBuffer()));
}));
// Meta's "resumable upload": start an upload on the token's app, send the file, get back a handle that
// other calls accept in place of the file (a profile picture, a template's sample header).
async function metaCall(url, init, what) {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw fail(`Meta didn't accept the ${what}: ${j.error?.error_user_msg || j.error?.message || 'HTTP ' + r.status}`);
  return j;
}
async function metaUploadHandle(s, buf, mime, what) {
  const base = `https://graph.facebook.com/${db.settings.graphVersion}`;
  const appId = (await graph(s, `debug_token?input_token=${encodeURIComponent(s.accessToken)}`)).data?.app_id;
  if (!appId) throw fail("Couldn't tell which Meta app this token belongs to");
  const session = await metaCall(`${base}/${appId}/uploads?file_length=${buf.length}&file_type=${encodeURIComponent(mime)}`, { method: 'POST', headers: { Authorization: `Bearer ${s.accessToken}` } }, what);
  return (await metaCall(`${base}/${session.id}`, { method: 'POST', headers: { Authorization: `OAuth ${s.accessToken}`, file_offset: '0', 'Content-Type': mime }, body: buf }, what)).h;
}
// Changing it: upload the file for a handle, then set that handle as the number's profile picture.
app.post('/api/senders/:id/photo', express.raw({ type: () => true, limit: '5mb' }), wrap(async (req, res) => {
  const s = db.senders.find((x) => x.id === req.params.id);
  if (!s) throw fail('Not found', 404);
  if (db.settings.demoMode) throw fail('Profile photos can only be changed for real numbers, not in demo mode');
  if (!s.accessToken) throw fail('No access token saved for this number');
  const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png'].includes(mime)) throw fail('WhatsApp profile photos must be JPG or PNG');
  if (!req.body?.length) throw fail('The file is empty');
  const h = await metaUploadHandle(s, req.body, mime, 'photo');
  await metaCall(`https://graph.facebook.com/${db.settings.graphVersion}/${s.phoneNumberId}/whatsapp_business_profile`, { method: 'POST', headers: { Authorization: `Bearer ${s.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', profile_picture_handle: h }) }, 'photo');
  await readProfilePhoto(s);
  save();
  res.json(publicSender(s));
}));

// --- Templates --------------------------------------------------------------

const publicTemplate = (t) => ({ ...t, variables: templateVariables(t.components) });

app.get('/api/templates', (req, res) => res.json(db.templates.map(publicTemplate)));

// Manually defined template (for before API access, or for templates you know the shape of).
app.post('/api/templates', wrap((req, res) => {
  // Meta only sends templates it has approved, and those are created in WhatsApp Manager. Templates typed in here
  // can't be sent for real, so they're only for demo mode.
  if (!db.settings.demoMode) throw fail('Create templates in Meta WhatsApp Manager, then click Sync from Meta. Templates added here only work in demo mode.');
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
  // Numbers saved without their Business Account get one more try at finding it from the token.
  if (!db.settings.demoMode) {
    for (const s of db.senders.filter((x) => !x.wabaId && x.accessToken)) {
      const found = await findWaba(s, s.phoneNumberId, '', (e, f) => f).catch(() => '');
      if (found) { s.wabaId = found; save(); await linkWebhooks(s); }
    }
  }
  const accounts = new Map();
  for (const s of db.senders) if (s.wabaId && s.accessToken && !accounts.has(s.wabaId)) accounts.set(s.wabaId, s);
  if (!accounts.size) {
    const missing = db.senders.find((x) => x.accessToken && !x.wabaId);
    throw fail(missing
      ? `Couldn't work out which WhatsApp Business Account “${missing.label}” is in. Edit the number and paste its WhatsApp Business Account ID (Meta → WhatsApp → API Setup, under the phone number ID).`
      : 'Add a sender number with a WABA ID and access token first');
  }

  let synced = 0;
  const errors = [];
  for (const [wabaId, sender] of accounts) {
    try {
      let next = `${wabaId}/message_templates?fields=name,language,status,category,components,parameter_format,rejected_reason&limit=100`;
      while (next) {
        const page = await graph(sender, next);
        for (const t of page.data || []) {
          const existing = db.templates.find((x) => x.source === 'synced' && x.wabaId === wabaId && x.name === t.name && x.language === t.language);
          const data = { name: t.name, language: t.language, category: t.category, status: t.status, rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : '', components: t.components, parameterFormat: t.parameter_format || 'POSITIONAL', source: 'synced', wabaId, metaId: t.id, updatedAt: new Date().toISOString() };
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

// --- Creating and editing templates in Meta --------------------------------
// The editor sends a plain description ({ name, language, category, header, body, footer, buttons }); this turns
// it into Meta's template format, with the sample values Meta's review needs. Variables are numbered {{1}}, {{2}}…
const TEMPLATE_LIMITS = { header: 60, body: 1024, footer: 60, button: 25, buttons: 10 };
const varsIn = (text) => [...String(text || '').matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]);
function templateComponents(spec, { handle, linkBase }) {
  const out = [];
  const checkVars = (text, where) => {
    const v = varsIn(text);
    if (v.some((x) => !/^\d+$/.test(x))) throw fail(`${where}: use numbered variables like {{1}}, {{2}}`);
    const nums = [...new Set(v.map(Number))].sort((a, b) => a - b);
    if (nums.some((n, i) => n !== i + 1)) throw fail(`${where}: number the variables in order, starting at {{1}}`);
    return nums.length;
  };
  const h = spec.header || {}, format = String(h.format || 'NONE').toUpperCase();
  if (format === 'TEXT') {
    const text = String(h.text || '').trim();
    if (!text) throw fail('Write the header text, or set the header to None');
    if (text.length > TEMPLATE_LIMITS.header) throw fail(`The header can be up to ${TEMPLATE_LIMITS.header} characters`);
    const n = checkVars(text, 'Header');
    if (n > 1) throw fail('The header can have one variable at most');
    if (n && !String(h.sample || '').trim()) throw fail('Add a sample for the header variable: Meta needs it to review the template');
    out.push({ type: 'HEADER', format: 'TEXT', text, ...(n ? { example: { header_text: [String(h.sample).trim()] } } : {}) });
  } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) {
    if (!handle) throw fail(`Upload a sample ${format.toLowerCase()} for the header: Meta needs it to review the template`);
    out.push({ type: 'HEADER', format, example: { header_handle: [handle] } });
  }
  const body = String(spec.body?.text || '').trim();
  if (!body) throw fail('Write the message');
  if (body.length > TEMPLATE_LIMITS.body) throw fail(`The message can be up to ${TEMPLATE_LIMITS.body} characters`);
  if (/^{{\s*\w+\s*}}/.test(body) || /{{\s*\w+\s*}}$/.test(body)) throw fail("Meta doesn't accept a variable at the very start or end of the message. Add a word or a full stop around it.");
  const n = checkVars(body, 'Message');
  const samples = (spec.body?.samples || []).map((x) => String(x ?? '').trim()).slice(0, n);
  if (n && (samples.length < n || samples.some((x) => !x))) throw fail('Add a sample for every variable in the message: Meta needs them to review the template');
  samples.forEach((x, i) => { const bad = linkProblem(x); if (bad) throw fail(`The sample for {{${i + 1}}} ${bad}`); });
  out.push({ type: 'BODY', text: body, ...(n ? { example: { body_text: [samples] } } : {}) });
  const footer = String(spec.footer || '').trim();
  if (footer) {
    if (footer.length > TEMPLATE_LIMITS.footer) throw fail(`The footer can be up to ${TEMPLATE_LIMITS.footer} characters`);
    if (varsIn(footer).length) throw fail("The footer can't have variables");
    out.push({ type: 'FOOTER', text: footer });
  }
  const buttons = [];
  for (const b of (spec.buttons || []).slice(0, TEMPLATE_LIMITS.buttons)) {
    const text = String(b.text || '').trim();
    if (!text) throw fail('Every button needs its text');
    if (text.length > TEMPLATE_LIMITS.button) throw fail(`Button text can be up to ${TEMPLATE_LIMITS.button} characters ("${text}")`);
    if (b.type === 'QUICK_REPLY') buttons.push({ type: 'QUICK_REPLY', text });
    else if (b.type === 'PHONE_NUMBER') {
      const phone = normalizePhone(b.phone);
      if (!phone) throw fail(`"${text}": enter the phone number to call, with its country code`);
      buttons.push({ type: 'PHONE_NUMBER', text, phone_number: '+' + phone });
    } else if (b.type === 'URL') {
      const url = String(b.url || '').trim();
      if (linkProblem(url, true) || varsIn(url).length) throw fail(`"${text}": enter the full website link, starting with https://`);
      // Static: the link itself is part of the template, exactly as typed.
      if (b.mode === 'static') buttons.push({ type: 'URL', text, url });
      // Dynamic: opened through the short-link service in the background (see goCode), so it can change per
      // campaign. People only ever see their own link: it's kept as the default (linkDefaults) for sending.
      else buttons.push({ type: 'URL', text, url: `${linkBase}/go/{{1}}`, example: [`${linkBase}/go/${goCode(url)}`], _link: url });
    } else throw fail('Unknown button type');
  }
  // Meta's rules: buttons grouped by kind (website and call buttons together, quick replies together),
  // at most 2 website buttons and 1 call button.
  if (buttons.filter((b) => b.type === 'URL').length > 2) throw fail('A template can have 2 website buttons at most');
  if (buttons.filter((b) => b.type === 'PHONE_NUMBER').length > 1) throw fail('A template can have 1 call button at most');
  buttons.sort((a, b) => (a.type === 'QUICK_REPLY') - (b.type === 'QUICK_REPLY'));
  out.linkDefaults = {};
  buttons.forEach((b, i) => { if (b._link) { out.linkDefaults[i] = b._link; delete b._link; } });
  if (buttons.length) out.push({ type: 'BUTTONS', buttons });
  return out;
}
// A website button's link when sending: the one chosen for this campaign, else the one typed in the template.
function withLinkDefaults(template, values) {
  const out = { ...values };
  for (const [i, url] of Object.entries(template.linkDefaults || {})) {
    const key = `button${i}.1`;
    if (!String(out[key] ?? '').trim()) out[key] = url;
  }
  return out;
}
// The number (and so the Business Account and token) a template is made with.
function templateSender(spec, t) {
  const usable = db.senders.filter((x) => x.wabaId && x.accessToken);
  const s = t ? usable.find((x) => x.wabaId === t.wabaId) : usable.find((x) => x.id === spec.senderId) || usable[0];
  if (!s) throw fail(t ? "No number with a token is connected to this template's Business Account" : 'Add a sender number with its WhatsApp Business Account ID first (Numbers page)');
  return s;
}
// Where website buttons' short links live: a separate public service (the url-analytics app) that passes /go/<code>
// to this app. Set SHORT_LINK_DOMAIN to move it; a workspace's settings.linkDomain overrides it.
const SHORT_LINK_BASE = process.env.SHORT_LINK_DOMAIN || 'https://url-analytics.up.railway.app';
// Short links for website buttons run on the company's own domain (customers see it when they tap), which must
// already point at this app: a test link is opened on it and must get this app's answer (see /go/:code).
// Only needed when the template has such a button.
async function linkBaseFor(req, spec) {
  if (!(spec.buttons || []).some((b) => b.type === 'URL' && b.mode !== 'static')) return '';
  const d = String(db.settings.linkDomain || SHORT_LINK_BASE).trim().replace(/\/+$/, '');
  if (!db.settings.demoMode) {
    const r = await fetch(`${d}/go/zzzzzzz`, { redirect: 'manual', signal: AbortSignal.timeout(8000) }).catch(() => null);
    const text = r ? await r.text().catch(() => '') : '';
    if (!r || r.status !== 404 || !text.includes('This link has expired or never existed.')) throw fail("Website buttons can't be set up right now (the link service isn't answering). Try again in a few minutes.");
  }
  return d;
}
async function headerHandle(s, spec, t) {
  const f = spec.header?.file;
  const format = String(spec.header?.format || 'NONE').toUpperCase();
  if (!['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) return '';
  if (f?.data) {
    const buf = Buffer.from(String(f.data), 'base64');
    const mime = String(f.mime || '').toLowerCase();
    const ok = { IMAGE: ['image/jpeg', 'image/png'], VIDEO: ['video/mp4'], DOCUMENT: ['application/pdf'] }[format];
    if (!ok.includes(mime)) throw fail(`The header sample must be ${format === 'IMAGE' ? 'a JPG or PNG' : format === 'VIDEO' ? 'an MP4 video' : 'a PDF'}`);
    return metaUploadHandle(s, buf, mime, 'header sample');
  }
  // Editing without a new file: keep the sample Meta already has.
  const old = (t?.components || []).find((c) => String(c.type).toUpperCase() === 'HEADER' && c.format === format);
  return old?.example?.header_handle?.[0] || '';
}
const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY'];

app.post('/api/templates/meta', wrap(async (req, res) => {
  const spec = req.body;
  const name = String(spec.name || '').trim();
  if (!/^[a-z0-9_]{1,512}$/.test(name)) throw fail('Name the template with lowercase letters, numbers and underscores, e.g. order_update');
  const language = String(spec.language || '').trim();
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) throw fail('Pick the language');
  const category = String(spec.category || '').toUpperCase();
  if (!TEMPLATE_CATEGORIES.includes(category)) throw fail('Pick Marketing or Utility');
  const now = new Date().toISOString();
  if (db.settings.demoMode) {
    // Demo: nothing goes to Meta; the template is kept here as if approved, for practice sends.
    const components = templateComponents(spec, { handle: 'demo', linkBase: await linkBaseFor(req, spec) });
    if (db.templates.some((x) => x.name === name && x.language === language)) throw fail('A template with this name and language already exists');
    const t = { id: id(), name, language, category, status: 'MANUAL', source: 'manual', parameterFormat: 'POSITIONAL', components, linkDefaults: components.linkDefaults, updatedAt: now };
    db.templates.push(t);
    save();
    return res.json(publicTemplate(t));
  }
  const s = templateSender(spec);
  if (db.templates.some((x) => x.wabaId === s.wabaId && x.name === name && x.language === language)) throw fail('A template with this name and language already exists. Pick another name, or edit that one.');
  const components = templateComponents(spec, { handle: await headerHandle(s, spec), linkBase: await linkBaseFor(req, spec) });
  const r = await graph(s, `${encodeURIComponent(s.wabaId)}/message_templates`, { method: 'POST', body: JSON.stringify({ name, language, category, components }) });
  const t = { id: id(), name, language, category: r.category || category, status: r.status || 'PENDING', rejectedReason: '', components, parameterFormat: 'POSITIONAL', source: 'synced', wabaId: s.wabaId, metaId: r.id, linkDefaults: components.linkDefaults, submittedAt: now, updatedAt: now };
  db.templates.push(t);
  save();
  res.json(publicTemplate(t));
}));

// Edit: Meta allows it for approved, rejected and paused templates; the name and language stay. An approved one can
// be edited once a day and 10 times a month, and goes back to review.
const EDITABLE = ['APPROVED', 'REJECTED', 'PAUSED'];
app.put('/api/templates/:id/meta', wrap(async (req, res) => {
  const t = db.templates.find((x) => x.id === req.params.id);
  if (!t) throw fail('Not found', 404);
  const spec = req.body;
  const category = String(spec.category || t.category || '').toUpperCase();
  if (t.source !== 'synced' || !t.metaId) {
    // A demo template: just change it here.
    const components = templateComponents(spec, { handle: 'demo', linkBase: await linkBaseFor(req, spec) });
    Object.assign(t, { category, components, linkDefaults: components.linkDefaults, updatedAt: new Date().toISOString() });
    save();
    return res.json(publicTemplate(t));
  }
  if (!EDITABLE.includes(String(t.status).toUpperCase())) throw fail(`Meta doesn't allow editing a template while it's ${String(t.status).toLowerCase().replace(/_/g, ' ')}. Try again once it's approved or rejected.`);
  const s = templateSender(spec, t);
  const components = templateComponents(spec, { handle: await headerHandle(s, spec, t), linkBase: await linkBaseFor(req, spec) });
  await graph(s, encodeURIComponent(t.metaId), { method: 'POST', body: JSON.stringify({ components, ...(category !== t.category ? { category } : {}) }) });
  const now = new Date().toISOString();
  Object.assign(t, { components, linkDefaults: components.linkDefaults, category, status: 'PENDING', rejectedReason: '', editedAt: now, updatedAt: now });
  save();
  res.json(publicTemplate(t));
}));

// Meta's review results arrive on the webhook (field message_template_status_update), keyed by Business Account.
const TEMPLATE_EVENT_TEXT = { APPROVED: 'approved', REJECTED: 'rejected', PAUSED: 'paused', DISABLED: 'disabled', FLAGGED: 'flagged for low quality', PENDING_DELETION: 'being deleted', REINSTATED: 'approved again' };
function handleTemplateStatus(wabaId, v) {
  const t = db.templates.find((x) => x.metaId === String(v.message_template_id)) ||
    db.templates.find((x) => x.wabaId === wabaId && x.name === v.message_template_name && x.language === v.message_template_language);
  if (!t) return;
  const event = String(v.event || '').toUpperCase();
  t.status = event === 'REINSTATED' ? 'APPROVED' : event;
  t.rejectedReason = event === 'REJECTED' && v.reason && v.reason !== 'NONE' ? String(v.reason) : '';
  t.updatedAt = new Date().toISOString();
  save();
  if (TEMPLATE_EVENT_TEXT[event]) notes?.add({ kind: event === 'APPROVED' || event === 'REINSTATED' ? 'template_approved' : 'template_problem', title: `Template ${t.name} was ${TEMPLATE_EVENT_TEXT[event]}`, body: t.rejectedReason ? `Meta's reason: ${t.rejectedReason.toLowerCase().replace(/_/g, ' ')}` : event === 'APPROVED' ? 'It can be used for sending now.' : '', link: { tab: 'templates', id: t.id } });
  broadcast({ kind: 'templates' });
}

// --- Sending ----------------------------------------------------------------

// Who a row is, for the campaign's recipient list: a name column by its usual names ("Contact Name",
// "Full name", first + last…), else the value of a greeting variable ("Hi {{1}}" → {{1}} is the name).
const norm = (h) => String(h).toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
const NAME_COLS = ['name', 'full name', 'fullname', 'contact name', 'customer name', 'client name', 'lead name', 'person name', 'your name', 'contact', 'customer'];
const NOT_A_PERSON = /company|business|org|brand|shop|store|firm|file|template|campaign|\bad\b|adset|ad set|form|sheet|product|city|place|user ?name|nick/;
function nameColumnOf(headers) {
  const hs = headers.map((h) => [h, norm(h)]);
  for (const want of NAME_COLS) { const hit = hs.find(([, n]) => n === want); if (hit) return { col: hit[0] }; }
  const first = hs.find(([, n]) => /^(first name|firstname|given name|fname)$/.test(n)), last = hs.find(([, n]) => /^(last name|lastname|surname|family name|lname)$/.test(n));
  if (first) return { col: first[0], last: last?.[0] };
  const any = hs.find(([, n]) => /\bname\b/.test(n) && !NOT_A_PERSON.test(n));
  return any ? { col: any[0] } : null;
}
// "Hi {{1}}", "Hello {{name}}", "Dear {{2}}": that body variable is the person's name.
function greetingVar(template) {
  const body = (template?.components || []).find((c) => String(c.type).toUpperCase() === 'BODY')?.text || '';
  const m = body.match(/\b(hi|hello|hey|dear|namaste|hii)\b[\s,]*\{\{\s*(\w+)\s*\}\}/i);
  return m ? 'body.' + m[2] : null;
}

function resolveRecipients(body, template) {
  const { rows = [], phoneColumn, mapping = {} } = body;
  const vars = templateVariables(template.components);
  const nameCol = rows.length ? nameColumnOf(Object.keys(rows[0])) : null, greet = greetingVar(template);
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
      values[v.key] = m.type === 'column' ? (m.keepFiller ? String(row[m.value] ?? '').trim() : cleanCell(row[m.value])) || String(m.fallback ?? '').trim() : m.type === 'same' ? '' : String(m.value ?? '');
    }
    // "Same as another variable" (a button reusing the message's link) once the others are filled.
    for (const v of vars) if (mapping[v.key]?.type === 'same') values[v.key] = values[mapping[v.key].value] ?? '';
    if (mapping['header.filename']?.value) values['header.filename'] = String(mapping['header.filename'].value).trim(); // a document's shown name
    const fromCol = nameCol ? [row[nameCol.col], nameCol.last && row[nameCol.last]].filter(Boolean).join(' ').trim() : '';
    Object.assign(values, withLinkDefaults(template, values)); // website buttons: the template's own link unless the campaign chose one
    recipients.push({ phone, values, name: String(fromCol || (greet && values[greet]) || '').trim().slice(0, 120) });
  }
  return { recipients, skipped, vars };
}

app.post('/api/send/test', wrap(async (req, res) => {
  const { senderId, templateId, phone, values = {} } = req.body;
  checkDailyLimit(1);
  const sender = db.senders.find((s) => s.id === senderId);
  const template = db.templates.find((t) => t.id === templateId);
  if (!sender || !template) throw fail('Pick a sender number and a template');
  if (template.wabaId && sender.wabaId && template.wabaId !== sender.wabaId) throw fail(`“${sender.label}” can't send ${template.name}: it belongs to a different WhatsApp Business Account`);
  const phoneErr = phoneInputError(phone);
  if (phoneErr) throw fail(phoneErr);
  const to = normalizePhone(phone);
  if (!db.settings.demoMode && !sender.accessToken) throw fail('This sender has no access token');
  const linkErr = valuesProblem(template, withLinkDefaults(template, values));
  if (linkErr) throw fail(linkErr);
  const messageId = await sendTemplate(sender, template, to, withLinkDefaults(template, values));
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
// Template messages sent in the last 24 hours (campaigns and one-off sends), for the daily cap.
function sentLast24h() {
  const t = Date.now() - 86400000;
  const recent = (ts) => ts && Date.parse(ts) >= t;
  return db.campaigns.reduce((n, c) => n + (c.demo ? 0 : c.recipients.filter((r) => recent(r.sentAt)).length), 0)
    + db.messages.filter((m) => m.dir === 'out' && m.type === 'template' && !m.demo && recent(m.ts)).length;
}
// Throws if sending `count` more would pass the workspace's daily limit (null = no limit).
function checkDailyLimit(count) {
  const limit = tenants.meta()?.dailyLimit;
  if (limit == null || db.settings.demoMode) return;
  const left = Math.max(0, limit - sentLast24h());
  if (count > left) throw fail(`This workspace can send ${limit.toLocaleString()} messages a day, and ${left.toLocaleString()} are left right now. Send to fewer people, wait, or ask support to raise the limit.`);
}

function createCampaign(body) {
  const { name, templateId, senderIds = [] } = body;
  if (tenants.meta()?.suspended) throw fail('This workspace is suspended', 403);
  const template = db.templates.find((t) => t.id === templateId);
  if (!template) throw fail('Pick a template');
  const senders = db.senders.filter((s) => senderIds.includes(s.id) && s.enabled);
  if (!senders.length) throw fail('Select at least one enabled sender number');
  // Meta keeps templates per Business Account: a number from another account can't send this one.
  const wrong = senders.find((s) => template.wabaId && s.wabaId && s.wabaId !== template.wabaId);
  if (wrong) throw fail(`“${wrong.label}” can't send ${template.name}: the template belongs to a different WhatsApp Business Account. Turn that number off for this campaign.`);
  if (!db.settings.demoMode) {
    const noToken = senders.find((s) => !s.accessToken);
    if (noToken) throw fail(`"${noToken.label}" has no access token (or turn on Demo mode)`);
  }

  const { recipients, skipped, vars } = resolveRecipients(body, template);
  if (!recipients.length) throw fail('No valid recipients');
  checkDailyLimit(recipients.length);
  const missing = vars.find((v) => recipients.some((r) => !r.values[v.key]));
  const badRow = recipients.find((r) => valuesProblem(template, r.values));
  if (badRow) throw fail(`+${badRow.phone}: ${valuesProblem(template, badRow.values)}. Fix it on the Send page.`);
  if (missing) {
    const m = body.mapping?.[missing.key] || {};
    const empty = recipients.filter((r) => !r.values[missing.key]);
    const label = missing.media ? `the header ${missing.media}` : `{{${missing.name}}}`;
    throw fail(m.type === 'column'
      ? `${empty.length} ${empty.length === 1 ? 'person has' : 'people have'} no ${label} in “${m.value}” (empty, “Not Captured”, “N/A”…), e.g. +${empty[0].phone}. Type a fallback under ${label} on the Send page (like “there”), or refresh the page to leave them out.`
      : `Fill in ${label} on the Send page.`);
  }

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
  // People must have agreed to get these messages (WhatsApp policy, and it keeps the number healthy).
  if (body.consent !== true && !db.settings.demoMode) throw fail('Confirm that these contacts agreed to receive messages from you');
  res.json(summary(createCampaign(body)));
}));

// Start scheduled campaigns when their time comes. Campaigns whose time passed
// while the server was off start as soon as it's back up.
setInterval(() => {
  const now = Date.now();
  for (const ws of tenants.allWorkspaces()) tenants.forWorkspace(ws, () => {
    if (ws.meta.suspended) return;
    for (const c of db.campaigns) {
      if (c.status === 'scheduled' && new Date(c.scheduledAt) <= now && !running.has(c.id)) runCampaign(c);
    }
  });
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
const listeners = new Set(); // open dashboards, each tagged with its workspace
function broadcast(data) {
  const ws = tenants.wsId();
  const line = `event: inbox\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) if (res.wsId === ws) res.write(line);
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
  res.wsId = tenants.wsId();
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
  res.json({ conversation: conversationInfo(key, own, recipientNames()), messages, ai: req.admin ? leadApi.stateFor(key) : null, contact: contactsApi.byPhone(wa) || null, tags: db.tags });
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
    const filled = withLinkDefaults(template, values);
    const empty = templateVariables(template.components).find((v) => !String(filled[v.key] ?? '').trim());
    if (empty) throw fail(`Fill in ${empty.where} ${empty.name}`);
    const linkErr = valuesProblem(template, filled);
    if (linkErr) throw fail(linkErr);
    const wamid = await sendTemplate(sender, template, wa, filled, demo);
    msg = { type: 'template', templateId, templateName: template.name, values, wamid };
    res.json(recordOut(key, msg));
  } else {
    res.json(await sendInboxText(key, text, { replyTo }));
  }
}));

// Demo mode only: pretend the customer in a conversation wrote a message, so the Inbox and
// the lead assistant (drafts and auto-reply) can be tried without WhatsApp. It goes through the
// same steps as a real incoming message; everything it creates is demo data.
app.post('/api/demo/inbound', wrap((req, res) => {
  if (!db.settings.demoMode || !tenants.demoAllowed()) throw fail('Only available in Demo mode');
  const key = String(req.body.key || '');
  const { senderId, wa } = splitKey(key);
  if (!db.senders.some((s) => s.id === senderId) || !/^\d{6,15}$/.test(wa)) throw fail('Pick a conversation first');
  const text = String(req.body.text || '').trim().slice(0, 4000);
  if (!text) throw fail('Type what the customer says');
  const chat = (db.chats[key] ||= { lastReadAt: null, seed: true });
  const msg = { id: id(), wamid: 'wamid.DEMO' + id(), key, senderId, wa, dir: 'in', type: 'text', text, ts: new Date().toISOString(), demo: true, seed: true };
  db.messages.push(msg);
  inboxIndex.set(msg.wamid, msg);
  const had = Boolean(contactsApi.byPhone(wa));
  const contact = contactsApi.onInbound(wa, { name: chat.name, text, ts: msg.ts });
  if (!had && contact) contact.seed = true; // removed with the rest of the demo data
  const who = chat.name || contact?.name || '+' + wa;
  if (contact?.optOut && contact.optOutAt && Date.now() - Date.parse(contact.optOutAt) < 5000) notes?.optout({ name: who, phone: contact.phone, key, demo: true });
  else notes?.message({ key, name: who, text, type: 'text', demo: true });
  leadApi.onInbound(key);
  save();
  broadcast({ kind: 'message', key, dir: 'in' });
  res.json(msg);
}));

// A free-form text reply in a conversation (only inside WhatsApp's 24-hour window). Used by the
// Inbox and by the lead assistant's auto-reply (auto: true marks the message as sent by the AI).
async function sendInboxText(key, text, { replyTo, auto = false } = {}) {
  const { senderId, wa } = splitKey(key);
  const sender = db.senders.find((s) => s.id === senderId);
  if (!sender) throw fail('This WhatsApp number is no longer connected');
  const demo = db.settings.demoMode;
  if (!demo && !sender.accessToken) throw fail(`"${sender.label}" has no access token`);
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
  return recordOut(key, { type: 'text', text: body, wamid, context: replyTo || undefined, ...(auto ? { auto: true } : {}) });
}

// Store an outgoing Inbox message and tell open dashboards.
function recordOut(key, msg) {
  const { senderId, wa } = splitKey(key);
  const demo = db.settings.demoMode;
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
  return msg;
}

// Media people send arrives as an ID; download it once with the number's token and cache it.
app.get('/api/media/:mid', wrap(async (req, res) => {
  const mid = req.params.mid;
  if (!/^\d+$/.test(mid)) throw fail('Invalid media id', 404);
  const dir = path.join(MEDIA_DIR, tenants.wsId());
  const file = path.join(dir, mid);
  if (!fs.existsSync(file)) {
    const owner = db.messages.find((m) => m.media?.id === mid);
    if (!owner) throw fail('Media not found', 404);
    const sender = db.senders.find((s) => s.id === owner?.senderId && s.accessToken) || db.senders.find((s) => s.accessToken);
    if (!sender) throw fail('No access token to download this media', 404);
    const info = await graph(sender, mid);
    const r = await fetch(info.url, { headers: { Authorization: `Bearer ${sender.accessToken}` } });
    if (!r.ok) throw fail(`Media download failed (HTTP ${r.status})`, 502);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    fs.writeFileSync(file + '.json', JSON.stringify({ mime: info.mime_type }));
  }
  const { mime } = JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
  res.type(mime || 'application/octet-stream');
  if (req.query.name) res.attachment(String(req.query.name));
  res.sendFile(file);
}));

// Upload a template header image, video or document from the computer. Returns a public link to put in
// the header, the same as a link pasted by hand. Types and sizes are what WhatsApp accepts for each.
const UPLOAD_TYPES = {
  'image/jpeg': ['jpg', 5], 'image/png': ['png', 5],
  'video/mp4': ['mp4', 16], 'video/3gpp': ['3gp', 16],
  'application/pdf': ['pdf', 16],
};
app.post('/api/uploads', express.raw({ type: () => true, limit: '16mb' }), wrap((req, res) => {
  const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const kind = UPLOAD_TYPES[mime];
  if (!kind) throw fail('WhatsApp accepts JPG or PNG images, MP4 videos and PDF documents for template headers.');
  const [ext, maxMb] = kind;
  if (!req.body?.length) throw fail('The file is empty');
  if (req.body.length > maxMb * 1024 * 1024) throw fail(`WhatsApp accepts ${mime.split('/')[0] === 'image' ? 'images' : 'files'} like this up to ${maxMb} MB. Make it smaller and try again.`);
  // Named by a fingerprint of the contents: the same file uploaded again (under any name) is stored once.
  const name = `${crypto.createHash('sha256').update(req.body).digest('hex').slice(0, 32)}.${ext}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(path.join(UPLOAD_DIR, name))) fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
  // The original file name rides along at the end of the link (see /u/:file/:name and docFileName).
  const original = safeFileName(decodeURIComponent(String(req.get('x-file-name') || '')), ext);
  res.json({ url: `${req.protocol}://${req.get('host')}/u/${name}${original ? '/' + encodeURIComponent(original) : ''}`, fileName: original });
}));
// Removing an upload from the Send page. A file a campaign or message already used is kept: scheduled
// sends still need Meta to fetch it, and the Inbox shows sent messages from the same link.
app.delete('/api/uploads/:file', wrap((req, res) => {
  const name = req.params.file;
  if (!/^[0-9a-f]{32}\.[a-z0-9]{2,4}$/.test(name)) throw fail('Not found', 404);
  // Identical files share one copy (named by contents), possibly across workspaces: keep it while anyone uses it.
  const used = tenants.allWorkspaces().some(({ db: w }) => w.campaigns.some((c) => JSON.stringify(c.recipients).includes(name)) || w.messages.some((m) => JSON.stringify(m.values || {}).includes(name)));
  if (!used) fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
  res.json({ ok: true, deleted: !used });
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
    // A full 3 × 2 grid on the overview; colorIndex = place by creation date, which picks the folder colour (as on the Campaigns page).
    recent: (() => { const order = new Map([...db.campaigns].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map((c, i) => [c.id, i])); return camps.filter((c) => c.status !== 'scheduled').slice(0, 6).map((c) => ({ ...summary(c), colorIndex: order.get(c.id) })); })(),
    upcoming: camps.filter((c) => c.status === 'scheduled').sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt)).slice(0, 5).map(summary),
    running: camps.filter((c) => c.status === 'running').length,
    setup: {
      sender: db.senders.length > 0,
      token: db.senders.some((s) => s.accessToken),
      template: db.templates.length > 0,
      campaign: db.campaigns.length > 0,
      live: !demo,
    },
    hasSeed: hasSeedData(),
  };
}

app.get('/api/stats', (req, res) => res.json(computeStats(req.query)));

// --- Demo workspace -----------------------------------------------------------
// Fills the app with realistic sample numbers, templates and two weeks of
// campaign history so the dashboard can be explored before the API is ready.

app.post('/api/demo/seed', wrap((req, res) => {
  if (!tenants.demoAllowed()) throw fail('Sample data is not available for this workspace');
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
  removeSeedData();
  save();
  res.json({ ok: true });
}));

function hasSeedData() {
  return db.senders.some((s) => s.seed) || db.templates.some((t) => t.seed) || db.campaigns.some((c) => c.seed);
}
// Removes the sample workspace from the current workspace (only items marked seed).
function removeSeedData() {
  for (const m of db.messages) if (m.seed && m.wamid) inboxIndex.delete(m.wamid); // the index is shared by every workspace
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
}

// --- Contacts and the Inbox lead assistant ------------------------------------

notes = require('./notifications')(app, { db, save, id, wrap, broadcast });
const contactsApi = require('./contacts')(app, { db, save, id, wrap, fail, normalizePhone, phoneInputError, broadcast });
const leadApi = require('./lead')(app, { db, save, id, wrap, fail, aiConfig, aiAllowed: tenants.aiAllowed, broadcast, contacts: contactsApi, notes, sendText: (key, text, opts) => sendInboxText(key, text, opts) });

// --- AI assistant -------------------------------------------------------------

require('./ai')(app, { db, save, id, wsId: tenants.wsId, wrap, fail, aiConfig, contacts: contactsApi, normalizePhone, templateVariables, createCampaign, computeStats, summary, publicSender });

app.listen(PORT, () => {
  console.log(`WhatsApp Sender running at http://localhost:${PORT}`);
  console.log(`${tenants.allWorkspaces().length} workspace(s). Sign up or sign in at /login.`);
  console.log(tenants.adminCount ? `Admin panel: ${tenants.adminCount} admin email(s) from ADMIN_EMAILS.` : 'Admin panel: off (ADMIN_EMAILS is not set).');
});
// Write pending changes before the process stops (deploys restart it).
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  tenants.flush().catch((e) => console.error('Saving on shutdown failed:', e.message)).finally(() => process.exit(0));
});
