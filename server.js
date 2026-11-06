// SendON — Express backend.
// Each business has its own workspace (tenancy.js: accounts, sign-in, one data file per
// workspace). Talks to the WhatsApp Cloud API (graph.facebook.com) and runs campaigns across
// multiple sender numbers.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeLead, sanitizeLead } = require('./lead'); // the lead assistant's playbooks (lead.js)

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
    graphVersion: 'v25.0', // GRAPH_RECOMMENDED below
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
  // Named lists of contacts (contacts.js): { id, name, contactIds, createdAt, updatedAt }.
  collections: [],
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
// Meta access tokens nearly all end in "ZDZD", so the last 4 can't tell two tokens apart: show the last 8,
// which take in the characters before it that do differ (still nothing usable out of a ~200-character token).
const maskWaToken = (t) => (t ? '••••' + t.slice(-8) : '');

function publicSender(s) {
  const { accessToken, ...rest } = s;
  return { ...rest, accessTokenMasked: maskWaToken(accessToken), hasToken: Boolean(accessToken) };
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
  // `example`: the sample value given when the template was made (Meta keeps them), so people can see what each
  // variable is for. Positional samples are listed in order ({{1}}, {{2}}…); named ones by name.
  const sampleOf = (name, list = [], named = []) => {
    const hit = (named || []).find((x) => x?.param_name === name);
    if (hit) return String(hit.example ?? '');
    return /^\d+$/.test(name) ? String(list?.[Number(name) - 1] ?? '') : '';
  };
  const scan = (text, where, sample = () => '') => {
    const seen = new Set();
    for (const m of String(text || '').matchAll(/{{\s*([\w]+)\s*}}/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const example = sample(m[1]).trim();
      vars.push({ key: `${where}.${m[1]}`, where, name: m[1], ...(example ? { example } : {}) });
    }
  };
  for (const c of components) {
    const type = (c.type || '').toUpperCase();
    const ex = c.example || {};
    if (type === 'HEADER') {
      if (c.format === 'TEXT') scan(c.text, 'header', (n) => sampleOf(n, ex.header_text, ex.header_text_named_params));
      else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(c.format)) {
        vars.push({ key: 'header.media', where: 'header', name: c.format.toLowerCase() + ' URL', media: c.format.toLowerCase() });
      }
    } else if (type === 'BODY') scan(c.text, 'body', (n) => sampleOf(n, ex.body_text?.[0], ex.body_text_named_params));
    else if (type === 'BUTTONS') {
      (c.buttons || []).forEach((b, i) => {
        // A button's sample is the whole link; the variable's part is what follows the fixed start ("…/go/{{1}}").
        if (b.type === 'URL') scan(b.url, `button${i}`, () => {
          const full = String((Array.isArray(b.example) ? b.example[0] : b.example) || ''), start = String(b.url).split('{{')[0];
          return full.startsWith(start) ? full.slice(start.length) : full;
        });
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

// "05/11/2026, 1:00 pm": a moment in the person's own time (the server runs in UTC). tz is the browser's
// getTimezoneOffset() in minutes; India's when it isn't known (e.g. a campaign the Assistant made).
function localStamp(tz, d = new Date()) {
  const off = Number.isFinite(Number(tz)) && tz !== '' && tz != null ? Number(tz) : -330;
  return new Date(d.getTime() - off * 60000).toLocaleString('en-GB', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

// A failed message's Meta error code, from either way it was stored: "131042: Title" (the status webhook, and sends
// since this change) or Meta's own "(#131037) text" (sends rejected straight away, before it).
function errorCodeOf(error) {
  const t = String(error || '');
  return t.match(/^(\d{2,6}):/)?.[1] || t.match(/\(#(\d{2,6})\)/)?.[1] || '';
}

async function graph(sender, pathname, options = {}) {
  const { version, ...fetchOptions } = options; // `version` overrides the configured Graph API version for one call
  const url = `https://graph.facebook.com/${version || db.settings.graphVersion}/${pathname}`;
  const res = await fetch(url, {
    ...fetchOptions,
    headers: { Authorization: `Bearer ${sender.accessToken}`, 'Content-Type': 'application/json', ...(fetchOptions.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    // 190 = expired or invalid access token: say what to do, not just "Authentication Error".
    const msg = json.error?.code === 190
      ? `Access token for "${sender.label}" is expired or invalid. Paste a new token under Numbers.`
      : json.error?.error_user_msg || json.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = json.error?.code;
    err.subcode = json.error?.error_subcode;
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
let credits = null; // what SendON charges (credits.js), mounted further down

// Failures that say the list (or the number) is in trouble. Meta's marketing cap (131049) and rate
// limits are Meta's choice about timing, not bad numbers, so they don't count towards auto-pausing.
const NOT_LIST_PROBLEMS = /^(131049|130429|131056|4|80007):/;
// Failures that are about the sending number, account or template, not the people: every message fails the same way
// until it's fixed, so they pause the send quickly, with what to fix (and don't count as a bad list).
const ACCOUNT_PROBLEMS = {
  131037: 'this number’s display name isn’t approved by Meta yet. Check its status in WhatsApp Manager → Phone numbers',
  131042: 'there’s a payment problem on the WhatsApp account. Fix the payment method in Meta Business Settings → Billing',
  131031: 'the WhatsApp account is locked. Check Account quality in WhatsApp Manager',
  368: 'Meta has temporarily blocked this number. Check Account quality in WhatsApp Manager',
  190: 'the number’s access token expired. Paste a new one under Numbers',
  132001: 'Meta can’t find this template in that language. Check it under Templates',
  132015: 'Meta has paused this template. Check it under Templates',
  132016: 'Meta has disabled this template. Choose another one',
};
const accountProblem = (r) => (r.status === 'failed' && ACCOUNT_PROBLEMS[errorCodeOf(r.error)] ? errorCodeOf(r.error) : '');
const listFailures = (c) => c.recipients.filter((r) => r.status === 'failed' && !NOT_LIST_PROBLEMS.test(String(r.error || '')) && !accountProblem(r)).length;
const accountFailures = (c) => c.recipients.filter(accountProblem).length;
const attempted = (c) => c.recipients.filter((r) => ['sent', 'delivered', 'read', 'failed'].includes(r.status)).length;

// "It needs N credits (…), and this workspace has M": the reason a send can't start.
function creditsShort(count, template) {
  const rate = credits.rateFor(template), need = count * rate, cat = String(template?.category || 'marketing').toLowerCase();
  return `It needs ${need.toLocaleString('en-IN')} credits (${count.toLocaleString('en-IN')} message${count === 1 ? '' : 's'} × ${rate} for a ${cat} template), and this workspace has ${credits.balance().toLocaleString('en-IN')}.`;
}

async function runCampaign(campaign) {
  // Not enough credits for everyone still to send: don't start (a scheduled campaign, or one resumed later).
  const tpl = db.templates.find((t) => t.id === campaign.templateId);
  const toSend = campaign.recipients.filter((r) => r.status === 'pending' || r.status === 'queued').length;
  if (tpl && toSend && !credits.enough(toSend * credits.rateFor(tpl), campaign.demo)) {
    campaign.status = 'stopped';
    campaign.pausedReason = `Not sent: ${creditsShort(toSend, tpl)} Add credits on the Credits page, then resume it.`;
    save();
    notes?.add({ kind: 'credits_out', group: 'credits_out', title: `“${campaign.name}” didn’t start: not enough credits`, body: campaign.pausedReason, link: { tab: 'campaigns', id: campaign.id } });
    return;
  }
  const control = { stop: false };
  running.set(campaign.id, control);
  campaign.status = 'running';
  // This run is judged on its own messages: what went wrong before (and was resumed past) doesn't count again.
  delete campaign.pausedReason;
  const base = { done: attempted(campaign), failed: listFailures(campaign), account: accountFailures(campaign) };
  campaign.startedAt ||= new Date().toISOString();
  const runFrom = Date.now(); // "took" adds up the time spent sending, not the hours it sat stopped between runs
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
      // Credits for this message (credits.js). Run out part-way: stop here; the rest stay waiting for a resume.
      const ch = template ? credits.charge(credits.rateFor(template), credits.keys.campaign(campaign)) : null;
      if (ch === false) {
        control.stop = true;
        campaign.pausedReason = 'Paused: this workspace ran out of credits. Add credits on the Credits page, then resume to send the rest.';
        break;
      }
      if (ch) r.credit = ch;
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
          // "131037: …", the same shape as failures from the status webhook, so the code is shown and grouped the same way
          r.error = /^\d{2,6}$/.test(String(e.code ?? '')) ? `${e.code}: ${String(e.message).replace(/^\(#\d+\)\s*/, '')}` : e.message;
          r.failedAt = new Date().toISOString();
          credits.refund(ch); // Meta didn't take it: no charge
          break;
        }
      }
      contactsApi.noteDelivery(campaign, r);
      recount(campaign);
      save();
      // Many failures usually means a bad list or a blocked number: stop before it hurts the number's quality.
      const done = attempted(campaign) - base.done, bad = listFailures(campaign) - base.failed, acct = accountFailures(campaign) - base.account;
      if (!campaign.demo && !control.stop && acct >= 5 && acct / done > 0.5) {
        // the same problem with the number or template, again and again: name it, and what fixes it
        const counts = {};
        for (const x of campaign.recipients) { const k = accountProblem(x); if (k) counts[k] = (counts[k] || 0) + 1; }
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
        control.stop = true;
        campaign.pausedReason = `Paused automatically: Meta rejected ${acct} of ${done} messages (error ${top}) because ${ACCOUNT_PROBLEMS[top]}. Every message will fail until that's fixed; then press Resume. Your contacts are fine.`;
      } else if (!campaign.demo && !control.stop && done >= 40 && bad / done > 0.3) {
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
  campaign.activeMs = (campaign.activeMs || 0) + (Date.now() - runFrom);
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
      if (change.field === 'message_template_status_update' || change.field === 'template_category_update') {
        // No phone number here: the entry is the Business Account.
        const ws = tenants.allWorkspaces().find((w) => w.db.senders.some((x) => x.wabaId === String(entry.id)) || w.db.templates.some((x) => x.metaId === String(change.value?.message_template_id)));
        const handle = change.field === 'template_category_update' ? handleTemplateCategory : handleTemplateStatus;
        if (ws) tenants.forWorkspace(ws, () => handle(String(entry.id), change.value || {}));
        continue;
      }
      // Meta decided on a number's display name (subscribe to "phone_number_name_update" in the app's webhook fields).
      // The entry is the Business Account; the number comes as display_phone_number.
      if (change.field === 'phone_number_name_update') {
        const v = change.value || {}, digits = String(v.display_phone_number || '').replace(/\D/g, '');
        const match = (x) => digits && String(x.displayPhone || '').replace(/\D/g, '') === digits;
        const ws = tenants.allWorkspaces().find((w) => w.db.senders.some(match));
        if (ws) tenants.forWorkspace(ws, () => {
          const s = db.senders.find(match);
          const st = { APPROVED: 'APPROVED', REJECTED: 'DECLINED', DEFERRED: 'PENDING_REVIEW' }[String(v.decision || '').toUpperCase()];
          if (!s || !st) return;
          if (st === 'APPROVED' && v.requested_verified_name) s.verifiedName = v.requested_verified_name;
          if (v.rejection_reason && st === 'DECLINED') s.nameRejection = String(v.rejection_reason).slice(0, 300);
          applyNumberStatus(s, { nameStatus: st, newNameStatus: '', statusCheckedAt: new Date().toISOString() });
          save();
        });
        continue;
      }
      const ws = tenants.byPhoneNumberId(change.value?.metadata?.phone_number_id);
      if (!ws) continue;
      // The entry is the number's Business Account, so a number saved without one learns it here.
      const s = ws.db.senders.find((x) => x.phoneNumberId === String(change.value.metadata.phone_number_id) && !x.wabaId);
      if (s && /^\d{10,17}$/.test(String(entry.id))) tenants.forWorkspace(ws, () => { s.wabaId = String(entry.id); save(); });
      tenants.forWorkspace(ws, () => handleWebhookChange(change));
    }
  }
});

function handleWebhookChange(change) {
  // When Meta last reached this workspace, for the Settings → Webhook status.
  const v = change.value || {};
  const hook = (db.settings.webhookSeen ||= {});
  const now = new Date().toISOString();
  hook.lastAt = now;
  if (v.messages?.length) hook.messageAt = now;
  if (v.statuses?.length) hook.statusAt = now;
  save();
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
          if (im.status === 'failed' && was !== 'failed') credits?.refund(im.credit);
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
          credits?.refund(r.credit); // failed messages cost nothing (once: a charge is refunded only once)
          r.status = 'failed';
          r.failedAt = new Date(Number(st.timestamp) * 1000).toISOString();
          r.error = st.errors?.map((e) => `${e.code}: ${e.title}${e.error_data?.details ? ' — ' + e.error_data.details : ''}`).join('; ');
        } else if ((rank[st.status] ?? -1) > (rank[r.status] ?? -1)) {
          r.status = st.status;
          r[st.status + 'At'] = new Date(Number(st.timestamp) * 1000).toISOString();
        }
        contactsApi.noteDelivery(c, r);
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
const PUBLIC_FILES = new Set(['/style.css', '/icons.css', '/icons.js', '/gradient-ascii.js', '/otp.js', '/password-rules.js', '/brand/logo.svg', '/brand/logo-small.svg', '/legal.css']);
// The home page: the landing page for visitors, the app for anyone signed in. (/welcome always shows the landing page.)
const LANDING = path.join(__dirname, 'public', 'landing.html');
app.get(['/', '/welcome'], (req, res, next) => {
  if (req.path === '/' && tenants.signedIn(req)) return next();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(LANDING);
});
// The Terms of Service and Privacy Policy: linked from sign-up and the landing page, so anyone can read them.
for (const [route, file] of [['/terms', 'terms.html'], ['/privacy', 'privacy.html']]) {
  app.get(route, (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', file)); });
}
// The landing page's company logos (public/brand/clients/) are public too.
const PUBLIC_DIRS = ['/brand/clients/'];
const isPublic = (p) => PUBLIC_FILES.has(p) || PUBLIC_DIRS.some((d) => p.startsWith(d) && !p.includes('..'));
app.use((req, res, next) => (isPublic(req.path) ? next() : tenants.requireAuth(req, res, next)));

// --- Live updates for everyone in a workspace --------------------------------------------------------------
// After any successful change (POST/PUT/PATCH/DELETE under /api), every open page in that workspace is told which
// part changed, and reloads just that part: numbers, templates, settings, the team, contacts, campaigns.
// The tab that made the change says who it is (X-Tab), so it doesn't reload its own work.
const LIVE_AREAS = [
  [/^\/api\/(senders|uploads)/, 'senders'], [/^\/api\/templates/, 'templates'], [/^\/api\/settings/, 'settings'],
  [/^\/api\/(team|workspace)/, 'team'], [/^\/api\/(contacts|tags|collections)/, 'contacts'], [/^\/api\/(campaigns|send)/, 'campaigns'],
  [/^\/api\/reports/, 'reports'],
];
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const p = req.baseUrl + req.path;
  const area = LIVE_AREAS.find(([re]) => re.test(p))?.[1];
  if (!area) return next();
  const ws = tenants.wsId(), tab = String(req.get('x-tab') || '').slice(0, 40);
  res.on('finish', () => { if (res.statusCode < 400 && ws) broadcastTo(ws, { kind: 'changed', area, tab }); });
  next();
});
app.use(security.rateLimit); // after sign-in, so limits are per user
// An admin switching a workspace's AI on or off: tell that workspace's open pages (they reload who can use it).
// Its plan (free / credits / unlimited): its pages reload the balance, so credits appear, change or disappear at once.
app.patch('/api/admin/workspaces/:id', (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    if ('ai' in (req.body || {})) broadcastTo(req.params.id, { kind: 'changed', area: 'team', tab: '' });
    if ('billing' in (req.body || {})) broadcastTo(req.params.id, { kind: 'changed', area: 'credits', tab: '' });
  });
  next();
});
// Pricing switched on or off, or plans changed for every workspace (admin → System): every workspace's open pages
// reload their balance.
app.use('/api/admin/platform', (req, res, next) => { // (also matches /api/admin/platform/plans)
  if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) for (const ws of tenants.allWorkspaces()) broadcastTo(ws.meta.id, { kind: 'changed', area: 'credits', tab: '' }); });
  next();
});
// The AI features (the Assistant and the Inbox lead assistant): admins, and the people a workspace gave it to (req.ai).
const AI_PATHS = ['/api/ai', /^\/api\/inbox\/[^/]+\/(draft|ai)$/];
app.use(AI_PATHS, (req, res, next) => (req.ai ? next() : res.status(403).json({ error: 'The AI assistant isn’t available on this account' })));
// Who sets the AI up (keys, provider, the lead assistant): admins, and owners of a workspace with AI.
const aiManage = (req) => req.admin || (req.ai && req.role === 'owner');
// Browsers must check for a newer copy every time, so an update shows on a normal refresh.
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
// Each page has its own address (/send, /inbox…): they're all the one app page, which shows the right one.
const APP_PAGES = ['overview', 'assistant', 'inbox', 'contacts', 'send', 'campaigns', 'numbers', 'templates', 'credits', 'credits-activity', 'notifications', 'settings', 'report', 'reports', 'error-codes'];
app.get([...APP_PAGES.map((p) => '/' + p), '/settings/:section'], (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });
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
// Our keys (the server's environment) serve the original workspace, and any workspace on the credits plan that has AI
// switched on. Everyone else brings their own key, and a workspace's own key always wins. AI answers use credits
// either way (credits.js). platform = this answer comes from our key.
const platformAi = () => tenants.isLegacy() || tenants.meta()?.billing === 'unlimited' && tenants.aiAllowed() || (require('./credits').isLive() && tenants.meta()?.billing === 'credits' && tenants.aiAllowed());
function aiConfig() {
  const env = platformAi() ? process.env : {};
  const own = { claude: db.settings.anthropicApiKey || '', gemini: db.settings.geminiApiKey || '' };
  const keys = { claude: own.claude || env.ANTHROPIC_API_KEY || '', gemini: own.gemini || env.GEMINI_API_KEY || '' };
  // Until one is picked, use whichever has a key (Gemini first: it has a free tier).
  const provider = AI_PROVIDERS.includes(db.settings.aiProvider) ? db.settings.aiProvider : keys.gemini || !keys.claude ? 'gemini' : 'claude';
  return { provider, key: keys[provider], keys, geminiModel: db.settings.geminiModel || DEFAULT_GEMINI_MODEL, platform: !own[provider] && Boolean(keys[provider]) };
}
function publicSettings(req) {
  const { anthropicApiKey, geminiApiKey, leadAgent: rawLead, aiProvider, geminiModel, ...rest } = db.settings;
  // always as playbooks (a workspace from before them shows its one setup as "Default")
  const leadAgent = { ...(rawLead || {}), ...normalizeLead(rawLead || {}) };
  leadAgent.enabled = leadAgent.on && leadAgent.playbooks.some((p) => p.draft);
  leadAgent.autoReply = leadAgent.on && leadAgent.autoOn && leadAgent.playbooks.some((p) => p.auto);
  if (!req.ai) return { ...rest, demoAllowed: tenants.demoAllowed() }; // no AI for this person
  const ai = aiConfig();
  // Members with AI use it, but don't see the keys.
  if (!aiManage(req)) return { ...rest, leadAgent, demoAllowed: tenants.demoAllowed(), aiProvider: ai.provider, hasAiKey: Boolean(ai.key), hasGeminiKey: Boolean(ai.keys.gemini) };
  return {
    ...rest,
    leadAgent,
    aiManage: true,
    demoAllowed: tenants.demoAllowed(),
    aiProvider: ai.provider,
    geminiModel: ai.geminiModel,
    hasAiKey: Boolean(ai.key),
    aiKeyMasked: maskToken(anthropicApiKey),
    aiKeyFromEnv: !anthropicApiKey && platformAi() && Boolean(process.env.ANTHROPIC_API_KEY),
    hasGeminiKey: Boolean(ai.keys.gemini),
    geminiKeyMasked: maskToken(geminiApiKey),
    geminiKeyFromEnv: !geminiApiKey && platformAi() && Boolean(process.env.GEMINI_API_KEY),
  };
}

// --- Members limited to some numbers ---------------------------------------------------------------
// An owner can limit a member to chosen numbers (req.senderScope, set in tenancy.js; null = all numbers).
// Enforced here for every request, so it holds whatever the page does: lists are filtered, a chat or campaign on
// another number is refused, and workspace-wide changes (settings, numbers, templates) are for owners only.
// Contacts stay shared with everyone in the workspace.
const keySender = (key) => { const k = String(key || ''); const i = k.lastIndexOf(':'); return i > 0 ? k.slice(0, i) : ''; };
const OWNER_ONLY_WRITES = [/^\/api\/settings$/, /^\/api\/senders(\/|$)/, /^\/api\/templates(\/|$)/, /^\/api\/demo\/seed$/];
app.use('/api', (req, res, next) => {
  const scope = req.senderScope;
  if (!scope) return next();
  const p = req.baseUrl + req.path, write = req.method !== 'GET';
  const no = (msg) => res.status(403).json({ error: msg });
  if (write && OWNER_ONLY_WRITES.some((re) => re.test(p)) && !/^\/api\/senders\/[^/]+\/photo\/refresh$/.test(p)) return no('Only the workspace owner can change this.');
  // A chat: its key starts with the number it's on.
  const chat = /^\/api\/inbox\/([^/]+)/.exec(p);
  if (chat && !scope.has(keySender(decodeURIComponent(chat[1])))) return no('This chat is on a number you don’t have access to.');
  if (p === '/api/demo/inbound' && !scope.has(keySender(req.body?.key))) return no('This chat is on a number you don’t have access to.');
  // A campaign: seeing it needs one of its numbers; acting on it needs all of them.
  const camp = /^\/api\/campaigns\/([^/]+)/.exec(p);
  if (camp) {
    const c = db.campaigns.find((x) => x.id === camp[1]);
    if (c && !(write ? c.senderIds.every((x) => scope.has(x)) : c.senderIds.some((x) => scope.has(x)))) return no('This campaign uses a number you don’t have access to.');
  }
  // Sending: only from your numbers.
  if (p === '/api/campaigns' && write && (req.body?.senderIds || []).some((x) => !scope.has(x))) return no('You can only send from your own numbers.');
  if (p === '/api/campaigns' && write && req.body?.draftId && (db.drafts.find((d) => d.id === req.body.draftId)?.senderIds || []).some((x) => !scope.has(x))) return no('This campaign sends from a number you don’t have access to.');
  if (/^\/api\/drafts(\/|$)/.test(p) && write && Array.isArray(req.body?.senderIds) && req.body.senderIds.some((x) => !scope.has(x))) return no('You can only send from your own numbers.');
  if (p === '/api/send/test' && !scope.has(req.body?.senderId)) return no('You can only send from your own numbers.');
  if (/^\/api\/senders\/([^/]+)\/photo/.test(p) && !scope.has(p.split('/')[3])) return no('That number isn’t yours.');
  // Lists: only what's on your numbers.
  if (req.method === 'GET') {
    const send = res.json.bind(res);
    const wabas = new Set(db.senders.filter((s) => scope.has(s.id)).map((s) => s.wabaId).filter(Boolean));
    const notesOk = (n) => (n.link?.key ? scope.has(keySender(n.link.key)) : n.link?.id && n.link?.tab === 'campaigns' ? (db.campaigns.find((c) => c.id === n.link.id)?.senderIds || []).some((x) => scope.has(x)) : true);
    const filters = {
      '/api/senders': (b) => b.filter((s) => scope.has(s.id)),
      '/api/templates': (b) => b.filter((t) => !t.wabaId || wabas.has(t.wabaId)),
      '/api/campaigns': (b) => b.filter((c) => (c.senderIds || []).some((x) => scope.has(x))),
      '/api/inbox': (b) => { const conversations = b.conversations.filter((c) => scope.has(keySender(c.key))); return { ...b, conversations, unread: conversations.reduce((n, c) => n + (c.unread || 0), 0) }; },
      '/api/notifications': (b) => { const notifications = b.notifications.filter(notesOk); return { ...b, notifications, unread: notifications.filter((n) => !n.read).length }; },
    };
    if (filters[p]) res.json = (body) => send(filters[p](body));
  }
  next();
});

app.get('/api/settings', (req, res) => res.json(publicSettings(req)));

app.put('/api/settings', (req, res) => {
  const allowed = ['demoMode', 'readReceipts', 'graphVersion', 'defaultCountryCode', 'defaultCountry', 'webhookVerifyToken', 'concurrencyPerNumber', 'delayMsPerNumber'];
  // A calling code is 1–3 digits; the country is its two-letter ISO code (it tells +1 US from +1 Canada).
  if ('defaultCountryCode' in req.body && !/^\d{1,3}$/.test(String(req.body.defaultCountryCode))) return res.status(400).json({ error: 'The country code should be 1–3 digits, e.g. 91 for India' });
  if ('defaultCountry' in req.body && req.body.defaultCountry && !/^[A-Z]{2}$/.test(String(req.body.defaultCountry))) return res.status(400).json({ error: 'Pick a country from the list' });
  for (const k of allowed) if (k in req.body) db.settings[k] = req.body[k];
  if (!tenants.demoAllowed()) db.settings.demoMode = false;
  if (!READ_RECEIPTS.includes(db.settings.readReceipts)) db.settings.readReceipts = 'open';
  db.settings.concurrencyPerNumber = Math.min(50, Math.max(1, Number(db.settings.concurrencyPerNumber) || 1));
  db.settings.delayMsPerNumber = Math.max(0, Number(db.settings.delayMsPerNumber) || 0);
  if (aiManage(req)) saveAiSettings(req.body);
  save();
  res.json(publicSettings(req));
});

// AI keys, provider and the lead assistant (admins and owners with AI, see aiManage).
function saveAiSettings(body) {
  // Blank means "keep the saved key"; removing it is an explicit flag.
  if (typeof body.anthropicApiKey === 'string' && body.anthropicApiKey.trim()) db.settings.anthropicApiKey = body.anthropicApiKey.trim();
  if (body.removeAnthropicApiKey) delete db.settings.anthropicApiKey;
  if (typeof body.geminiApiKey === 'string' && body.geminiApiKey.trim()) db.settings.geminiApiKey = body.geminiApiKey.trim();
  if (body.removeGeminiApiKey) delete db.settings.geminiApiKey;
  // The lead assistant's playbooks (lead.js): which numbers use each one, each number's default, linked templates.
  if (body.leadAgent && typeof body.leadAgent === 'object' && Array.isArray(body.leadAgent.playbooks)) {
    db.settings.leadAgent = sanitizeLead(body.leadAgent, { senderIds: db.senders.map((x) => x.id), templateIds: db.templates.map((t) => t.id), newId: id });
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
  try { info = await graph(who, `${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`); }
  catch (e) { throw fail(say(e, "Meta has no WhatsApp number with this phone number ID that this token can use. Copy the ID from Meta → WhatsApp → API Setup (it isn't the phone number itself).")); }
  if (!info.display_phone_number) throw fail("That ID isn't a WhatsApp phone number ID. Copy the Phone number ID from Meta → WhatsApp → API Setup.");
  const found = await findWaba(who, phoneNumberId, wabaId, say);
  const messagingLimit = await readMessagingLimit(who, phoneNumberId);
  const status = await readNumberStatus(who, phoneNumberId);
  return { displayPhone: info.display_phone_number, verifiedName: info.verified_name || '', qualityRating: info.quality_rating, messagingLimit, limitCheckedAt: new Date().toISOString(), ...status, ...(found ? { wabaId: found } : {}) };
}

// Meta's word on a number: is its display name approved (name_status; a requested new name: new_name_status), is the
// number itself connected (status), and was it verified by code. Unapproved names make every send fail (131037), so the
// Numbers page and the send confirmation show it. Never fatal: a failed read returns nothing and keeps what was known.
async function readNumberStatus(who, phoneNumberId) {
  const id = encodeURIComponent(phoneNumberId);
  let info = null;
  try { info = await graph(who, `${id}?fields=status,name_status,new_name_status,code_verification_status`); }
  catch { try { info = await graph(who, `${id}?fields=status,name_status`); } catch { return {}; } } // (an older API version without some fields)
  return {
    numberStatus: String(info.status || ''), nameStatus: String(info.name_status || ''), newNameStatus: String(info.new_name_status || ''),
    codeVerification: String(info.code_verification_status || ''), statusCheckedAt: new Date().toISOString(),
  };
}
const NAME_WORDS = { APPROVED: 'approved', AVAILABLE_WITHOUT_REVIEW: 'approved', DECLINED: 'rejected', EXPIRED: 'expired', PENDING_REVIEW: 'in review', NONE: 'not submitted' };
// Save a fresh reading on the number; a display name that changed (approved, rejected…) is also a notification.
function applyNumberStatus(s, st) {
  if (!st?.statusCheckedAt) return;
  const before = s.nameStatus;
  Object.assign(s, st);
  if (before && st.nameStatus && before !== st.nameStatus && NAME_WORDS[st.nameStatus] !== NAME_WORDS[before]) {
    const ok = NAME_WORDS[st.nameStatus] === 'approved';
    notes?.add({
      kind: ok ? 'number_ok' : 'number_problem',
      title: `${s.verifiedName || s.label}: display name ${NAME_WORDS[st.nameStatus] || st.nameStatus.toLowerCase()}`,
      body: ok ? `Meta approved the display name for ${s.displayPhone || s.label}. It can send messages now.` : `Messages from ${s.displayPhone || s.label} fail (error 131037) until Meta approves its display name. Check it in WhatsApp Manager → Phone numbers.`,
      link: { tab: 'numbers' },
    });
  }
}

// Meta's messaging limit: unique people a business can message outside the 24h customer service window per
// rolling 24 hours. Since late 2025 it is set per business portfolio and shared by all its numbers, read from
// whatsapp_business_manager_messaging_limit (Graph v24.0+); the old per-number messaging_limit_tier is
// deprecated and only tried as a fallback. Returns e.g. 'TIER_2K', or '' when Meta doesn't say. Never throws.
const LIMIT_MIN_VERSION = 24;
async function readMessagingLimit(who, phoneNumberId) {
  const id = encodeURIComponent(phoneNumberId);
  const configured = Number(String(db.settings.graphVersion).replace(/^v/, '')) || 0;
  const version = configured >= LIMIT_MIN_VERSION ? undefined : `v${LIMIT_MIN_VERSION}.0`;
  try {
    const t = (await graph(who, `${id}?fields=whatsapp_business_manager_messaging_limit`, { version })).whatsapp_business_manager_messaging_limit;
    if (t) return String(t);
  } catch { /* fall through to the old field */ }
  try { return String((await graph(who, `${id}?fields=messaging_limit_tier`)).messaging_limit_tier || ''); } catch { return ''; }
}
// 'TIER_250' → 250, 'TIER_2K' → 2000, 'TIER_UNLIMITED' → null (no cap), anything else → undefined (unknown).
function tierLimit(tier) {
  if (tier === 'TIER_UNLIMITED') return null;
  const m = /^TIER_(\d+)(K)?$/.exec(String(tier || ''));
  return m ? Number(m[1]) * (m[2] ? 1000 : 1) : undefined;
}
// Works out which WhatsApp Business Account holds the number, so nobody has to dig the ID out of Meta.
// `given` may be the account ID, the Business portfolio ID (the business_id= in business.facebook.com links,
// which people paste by mistake) or blank, in which case the token's own permissions are asked.
async function findWaba(who, phoneNumberId, given, say) {
  const holds = async (waba) => (await graph(who, `${encodeURIComponent(waba)}/phone_numbers?fields=id&limit=200`)).data?.some((x) => x.id === String(phoneNumberId));
  const firstHolding = async (ids) => { for (const w of ids) if (await holds(w).catch(() => false)) return w; return ''; };
  if (given) {
    let lastErr;
    try {
      if (await holds(given)) return given;
      throw fail("This number isn't in that WhatsApp Business Account. Paste your Business portfolio ID instead (the business_id= in business.facebook.com links) and the right account is found from it.");
    } catch (e) {
      lastErr = e;
      if (e.code !== 100) throw e.httpStatus ? e : fail(say(e,"Meta has no WhatsApp Business Account with this ID that this token can use. Paste your Business portfolio ID instead (the business_id= in business.facebook.com links) and the right account is found from it."));
    }
    // Code 100 "nonexisting field": a real ID, but not a WhatsApp Business Account. Subcode 33: Meta won't open
    // the ID for this token at all (wrong ID, or the token isn't given that account). Either way, try it as a Business portfolio.
    const hidden = lastErr?.subcode === 33;
    const accounts = [];
    for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
      try { accounts.push(...((await graph(who, `${encodeURIComponent(given)}/${edge}?fields=id&limit=200`)).data || []).map((x) => x.id)); } catch {}
    }
    const w = await firstHolding(accounts);
    if (w) return w;
    if (hidden) throw fail(`Meta won't let this access token open account ${given}. If the ID is right, the token hasn't been given this WhatsApp account: in Meta Business Settings → System users, pick the user, Assign assets → this WhatsApp account (full control), then Generate token with whatsapp_business_messaging and whatsapp_business_management and paste it with Replace token.`);
    throw fail("That isn't a WhatsApp Business Account ID, and no account under it holds this number. Paste your Business portfolio ID instead (the business_id= in business.facebook.com links) and the right account is found from it.");
  }
  // Blank: tokens limited to particular accounts list them in their permissions. Unrestricted tokens don't,
  // so then accounts this workspace already knows (from its other numbers and synced templates) and the
  // accounts of the businesses the token can see are tried. If none works the field stays empty; it's only
  // needed for syncing templates.
  {
    const known = [...new Set([...db.senders.map((x) => x.wabaId), ...db.templates.map((x) => x.wabaId)].filter((x) => /^\d{10,17}$/.test(String(x || ''))))];
    const w = await firstHolding(known);
    if (w) return w;
  }
  try {
    const d = (await graph(who, `debug_token?input_token=${encodeURIComponent(who.accessToken)}`)).data || {};
    const ids = [...new Set((d.granular_scopes || []).filter((g) => /^whatsapp_business_/.test(g.scope)).flatMap((g) => g.target_ids || []))];
    const w = await firstHolding(ids);
    if (w) return w;
  } catch {}
  try {
    // System users given particular accounts in Business Settings.
    const w = await firstHolding(((await graph(who, 'me/assigned_whatsapp_business_accounts?fields=id&limit=200')).data || []).map((x) => x.id));
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
// A phone number ID can be saved only once across all workspaces: webhooks (replies, delivered/read) are routed
// by it to a single number, so a second copy would split or lose them and send twice from one number.
function duplicateSenderError(phoneNumberId, self) {
  const pnid = String(phoneNumberId || '').trim();
  if (!pnid) return '';
  const here = db.senders.find((x) => x !== self && x.phoneNumberId === pnid);
  if (here) return `This number is already added here as "${here.label}"${here.displayPhone ? ` (${here.displayPhone})` : ''}. Edit that one instead of adding it again.`;
  // Demo-mode workspaces (test copies of a real one) never talk to Meta, so they may hold the same number.
  if (!db.settings.demoMode && tenants.allWorkspaces().some((w) => w.db.senders !== db.senders && !w.db.settings?.demoMode && w.db.senders.some((x) => x.phoneNumberId === pnid))) return 'This number is already connected to another workspace. A number can be in only one workspace; remove it there first.';
  return '';
}
const NEED_TOKEN = 'Paste the access token for this number. It lets the app send from it; Meta Business Settings → System users → Generate token.';

// The popup's "Test connection": checks what's typed without saving anything.
app.post('/api/senders/verify', wrap(async (req, res) => {
  const existing = req.body.senderId ? db.senders.find((x) => x.id === req.body.senderId) : null;
  const pnid = String(req.body.phoneNumberId || '').trim(), waba = String(req.body.wabaId || '').trim();
  const idErr = senderIdsError({ phoneNumberId: pnid, wabaId: waba });
  if (!pnid) throw fail('Enter the phone number ID first');
  if (idErr) throw fail(idErr);
  { const e = duplicateSenderError(pnid, existing); if (e) throw fail(e); }
  const token = tokenFor(req.body, existing);
  if (!token) throw fail(NEED_TOKEN);
  res.json({ ok: true, info: await verifyWithMeta({ phoneNumberId: pnid, wabaId: waba, accessToken: token }), sharedToken: !req.body.accessToken && !existing?.accessToken });
}));

// The popup's "Find" button next to the account ID: works out the WhatsApp Business Account from the phone number ID
// and token, or from a Business portfolio ID typed in the field. Only reads from Meta.
app.post('/api/senders/find-waba', wrap(async (req, res) => {
  const existing = req.body.senderId ? db.senders.find((x) => x.id === req.body.senderId) : null;
  const pnid = String(req.body.phoneNumberId || '').trim(), given = String(req.body.wabaId || '').trim();
  if (!pnid) throw fail('Enter the phone number ID first');
  { const e = senderIdsError({ phoneNumberId: pnid, wabaId: given }) || duplicateSenderError(pnid, existing); if (e) throw fail(e); }
  const token = tokenFor(req.body, existing);
  if (!token) throw fail(NEED_TOKEN);
  const who = { label: 'this number', accessToken: token };
  const say = (e, fallback) => (e.code === 190 ? "Meta doesn't accept this access token. Paste a new one." : fallback);
  const wabaId = await findWaba(who, pnid, given, say);
  // Meta has no lookup from a phone number to its account, and this token isn't allowed to list accounts
  // (no business_management permission, or a temporary token), so the ID has to be pasted in.
  if (!wabaId) throw fail("Couldn't find it automatically with this token. Paste the WhatsApp Business Account ID instead: it's in Meta Business Settings → Accounts → WhatsApp accounts (pick the account, the ID is under its name), or in your Meta app → WhatsApp → API Setup. Your Business portfolio ID (business_id= in business.facebook.com links) also works. Then click Find again.");
  const name = await graph(who, `${encodeURIComponent(wabaId)}?fields=name`).then((x) => x.name || '').catch(() => '');
  res.json({ wabaId, name });
}));

app.post('/api/senders', wrap(async (req, res) => {
  credits.checkNumberLimit(); // the plan's number limit (credits.js)
  const { label, phoneNumberId, wabaId, displayPhone } = req.body;
  if (!label || !phoneNumberId) throw fail('Label and Phone Number ID are required');
  const labelErr = senderLabelError(label) || senderIdsError(req.body) || duplicateSenderError(phoneNumberId);
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
  { const e = senderIdsError(req.body, s) || ('phoneNumberId' in req.body && String(req.body.phoneNumberId).trim() !== s.phoneNumberId ? duplicateSenderError(req.body.phoneNumberId, s) : ''); if (e) throw fail(e); }
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

// Moves a number (with its token and settings, under the same id) to another workspace the person owns. Its chats,
// campaigns and contacts stay where they are; Meta's webhooks follow the number, so new replies arrive in the new
// workspace. Moving it back joins it up with its old history again.
app.post('/api/senders/:id/move', wrap(async (req, res) => {
  const s = db.senders.find((x) => x.id === req.params.id);
  if (!s) throw fail('Not found', 404);
  if (req.role !== 'owner') throw fail('Only the workspace owner can move a number', 403);
  const target = tenants.workspaceById(String(req.body.workspaceId || ''));
  if (!target || target.meta.id === tenants.wsId()) throw fail('Pick another workspace to move it to');
  if (tenants.roleIn(req.user.id, target.meta.id) !== 'owner') throw fail(`Only an owner of “${target.meta.name}” can move a number into it`, 403);
  if (db.settings.demoMode || target.db.settings?.demoMode) throw fail('Numbers can’t be moved into or out of a workspace in demo mode');
  if (target.db.senders.some((x) => x.phoneNumberId === s.phoneNumberId)) throw fail(`“${target.meta.name}” already has this number`);
  const busy = db.campaigns.filter((c) => (c.senderIds || []).includes(s.id) && (cpLive(c) || ['scheduled', 'holding'].includes(c.status)));
  if (busy.length) throw fail(`${busy.length === 1 ? `The campaign “${busy[0].name}” is` : `${busy.length} campaigns are`} still sending or scheduled from this number. Wait for ${busy.length === 1 ? 'it' : 'them'} to finish, or cancel ${busy.length === 1 ? 'it' : 'them'}, then move it.`);
  tenants.forWorkspace(target, () => credits.checkNumberLimit()); // the plan's number limit there
  db.senders = db.senders.filter((x) => x !== s);
  save();
  tenants.forWorkspace(target, () => { db.senders.push(s); save(); });
  res.json({ ok: true, workspace: { id: target.meta.id, name: target.meta.name } });
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
  const info = await graph(s, `${s.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,status`);
  s.displayPhone = info.display_phone_number || s.displayPhone;
  s.verifiedName = info.verified_name;
  s.qualityRating = info.quality_rating;
  s.messagingLimit = info.messaging_limit = await readMessagingLimit(s, s.phoneNumberId);
  applyNumberStatus(s, await readNumberStatus(s, s.phoneNumberId));
  s.lastCheckedAt = s.limitCheckedAt = new Date().toISOString();
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

// A link button's sample is a short-link code ("…/go/{{1}}" → "k3x9qa2"): show the page it opens instead.
const publicTemplate = (t) => ({ ...t, variables: templateVariables(t.components).map((v) => {
  if (!/^button/.test(v.where) || !v.example || /^https?:/i.test(v.example)) return v;
  const link = db.links?.find((l) => l.id === v.example.toLowerCase());
  return link ? { ...v, example: link.url } : v;
}) });

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
  const t = { id: id(), name: name.trim(), language: language.trim(), category: category || 'MARKETING', status: 'MANUAL', source: 'manual', parameterFormat: named ? 'NAMED' : 'POSITIONAL', components, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  db.templates.push(t);
  save();
  res.json(publicTemplate(t));
}));

// Deleting a template deletes it in Meta too (WhatsApp Manager), then here, so Sync can't bring it back. Only this
// language is deleted when Meta's id is known (hsm_id); otherwise Meta deletes the name in every language. Templates
// made only in this app (or in demo mode) are just removed here. If Meta refuses, nothing is removed.
app.delete('/api/templates/:id', wrap(async (req, res) => {
  const t = db.templates.find((x) => x.id === req.params.id);
  if (!t) throw fail('Not found', 404);
  let inMeta = false;
  if (t.wabaId && t.source === 'synced' && !db.settings.demoMode) {
    const s = db.senders.find((x) => x.wabaId === t.wabaId && x.accessToken);
    if (!s) throw fail('No number with a saved access token is in this template’s WhatsApp Business Account, so it can’t be deleted in Meta. Add the token under Numbers, then try again.');
    const q = new URLSearchParams({ name: t.name, ...(t.metaId ? { hsm_id: t.metaId } : {}) });
    try { await graph(s, `${encodeURIComponent(t.wabaId)}/message_templates?${q}`, { method: 'DELETE' }); inMeta = true; }
    catch (e) {
      if (!/not.*(exist|found)|does not exist/i.test(e.message) && e.code !== 100) throw fail(`Meta didn’t delete it: ${e.message}`);
      inMeta = true; // already gone in Meta: just remove it here
    }
  }
  db.templates = db.templates.filter((x) => x !== t);
  save();
  res.json({ ok: true, inMeta });
}));

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
      const fields = 'name,language,status,category,components,parameter_format,rejected_reason';
      let next = `${wabaId}/message_templates?fields=${fields},previous_category&limit=100`;
      while (next) {
        // previous_category says Meta re-categorised it; if Meta ever refuses that field, sync without it.
        const page = await graph(sender, next).catch((e) => {
          if (!/previous_category/i.test(e.message || '') || !next.includes(',previous_category')) throw e;
          next = next.replace(',previous_category', '');
          return graph(sender, next);
        });
        for (const t of page.data || []) {
          if (/^(DELETED|PENDING_DELETION)$/i.test(t.status || '')) continue; // being deleted in Meta: not brought back
          const existing = db.templates.find((x) => x.source === 'synced' && x.wabaId === wabaId && x.name === t.name && x.language === t.language);
          const data = { name: t.name, language: t.language, category: t.category, categoryChangedFrom: categoryChangedFrom(existing, t.category, t.previous_category), status: t.status, rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : '', components: t.components, parameterFormat: t.parameter_format || 'POSITIONAL', source: 'synced', wabaId, metaId: t.id, updatedAt: new Date().toISOString() };
          // Meta doesn't say when a template was made or approved, so both are noted as this app sees them happen.
          const approvedNow = t.status === 'APPROVED' && (!existing || existing.status !== 'APPROVED');
          if (existing) Object.assign(existing, data, approvedNow && existing.status ? { approvedAt: data.updatedAt } : {});
          else db.templates.push({ id: id(), ...data, firstSeenAt: data.updatedAt });
          synced++;
        }
        next = page.paging?.next ? page.paging.next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, '') : null;
      }
    } catch (e) {
      errors.push(`WABA ${wabaId}: ${e.message}`);
    }
  }
  await fetchMetaSamples(db.templates.filter((t) => t.source === 'synced' && accounts.has(t.wabaId)));
  save();
  res.json({ synced, errors, templates: db.templates.map(publicTemplate) });
}));

// The category the template had before Meta moved it (e.g. picked Utility, Meta made it Marketing), or ''.
// What was picked here wins: if it matches Meta's category now, the change was the user's own edit.
function categoryChangedFrom(existing, category, previous) {
  const now = String(category || '').toUpperCase();
  const picked = String(existing?.requestedCategory || '').toUpperCase();
  if (picked) return picked !== now ? picked : '';
  const prev = String(previous || '').toUpperCase();
  return prev && prev !== now ? prev : '';
}

// --- Creating and editing templates in Meta --------------------------------
// The editor sends a plain description ({ name, language, category, header, body, footer, buttons }); this turns
// it into Meta's template format, with the sample values Meta's review needs. Variables are numbered {{1}}, {{2}}…
const TEMPLATE_LIMITS = { header: 60, body: 1024, footer: 60, button: 25, buttons: 10 };
// HTML or script tags (<b>, </script>, <img …>, <!-- …): WhatsApp shows them as plain text, so they're never meant.
// Formatting is *bold*, _italic_, ~strike~ and ```mono```. A lone "<" or "a < b" is fine.
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(\s[^<>]*)?\/?>|<!--|<\?[a-z]/i;
const varsIn = (text) => [...String(text || '').matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]);
function templateComponents(spec, { handle, linkBase }) {
  const out = [];
  const noTags = (text, where) => { if (HTML_TAG.test(String(text || ''))) throw fail(`${where}: remove the HTML tags (like <b> or <script>). WhatsApp shows them as plain text. For formatting use *bold*, _italic_ or ~strikethrough~.`); };
  for (const [v, where] of [[spec.header?.text, 'Header'], [spec.header?.sample, 'Header sample'], [spec.body?.text, 'Message'], [spec.footer, 'Footer'],
    ...(spec.body?.samples || []).map((x, i) => [x, `Sample for {{${i + 1}}}`]), ...(spec.buttons || []).map((b) => [b.text, 'Button text'])]) noTags(v, where);
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
// A copy of a template's header image, video or document sample, kept with the uploads (/u/…) so the Templates
// page can show it. Meta's own sample links expire, and a template made here only has Meta's upload code.
const SAMPLE_MIME = { IMAGE: 'image/jpeg', VIDEO: 'video/mp4', DOCUMENT: 'application/pdf' };
function keepSample(buf, mime, format, name = '') {
  const ext = (UPLOAD_TYPES[mime] || UPLOAD_TYPES[SAMPLE_MIME[format]])[0];
  const file = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${ext}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(path.join(UPLOAD_DIR, file))) fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  const nice = format === 'DOCUMENT' ? safeFileName(name, ext) : '';
  return `/u/${file}${nice ? '/' + encodeURIComponent(nice) : ''}`;
}
const sampleFileOk = (p) => /^\/u\/[0-9a-f]{32}\.[a-z0-9]{2,4}/.test(p || '') && fs.existsSync(path.join(UPLOAD_DIR, p.split('/')[2]));
// The sample picked in the template form, saved; '' when none was uploaded this time.
function formSample(spec) {
  const f = spec.header?.file, format = String(spec.header?.format || 'NONE').toUpperCase();
  if (!f?.data || !SAMPLE_MIME[format]) return '';
  try { return keepSample(Buffer.from(String(f.data), 'base64'), String(f.mime || '').toLowerCase(), format, f.name); } catch { return ''; }
}
// The template's sample after a create or edit: the new upload, else the one it had (if the header kind is the same).
function sampleAfterEdit(spec, t) {
  const format = String(spec.header?.format || 'NONE').toUpperCase();
  if (!SAMPLE_MIME[format]) return {};
  const fresh = formSample(spec);
  if (fresh) return { headerSample: fresh, headerSampleFrom: '' };
  return t?.headerSample && (t.components || []).some((c) => String(c.type).toUpperCase() === 'HEADER' && c.format === format) ? {} : { headerSample: '' };
}
// Sync: download the sample Meta shows for each image/video/document template that has no saved copy yet (or whose
// sample changed in Meta). Failures are skipped quietly; the card keeps its placeholder.
async function fetchMetaSamples(list) {
  const tally = { saved: 0, failed: [] };
  for (const t of list) {
    const h = (t.components || []).find((c) => String(c.type).toUpperCase() === 'HEADER');
    const from = h?.example?.header_handle?.[0];
    if (!SAMPLE_MIME[h?.format]) continue;
    if (!/^https:\/\//.test(from || '')) { if (!sampleFileOk(t.headerSample)) tally.failed.push(`${t.name}: Meta gave no sample link (${String(from || 'none').slice(0, 40)})`); continue; }
    if (sampleFileOk(t.headerSample) && (!t.headerSampleFrom || t.headerSampleFrom === from)) continue;
    try {
      const r = await fetch(from, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SendON template preview)', Accept: '*/*' } });
      if (!r.ok) { tally.failed.push(`${t.name}: HTTP ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > 16 * 1024 * 1024) { tally.failed.push(`${t.name}: ${buf.length} bytes`); continue; }
      const mime = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      t.headerSample = keepSample(buf, mime, h.format, t.headerSample?.split('/')[3] ? decodeURIComponent(t.headerSample.split('/')[3]) : '');
      t.headerSampleFrom = from;
      tally.saved++;
    } catch (e) { tally.failed.push(`${t.name}: ${e.message}`); }
  }
  if (tally.saved || tally.failed.length) console.log(`Template samples: ${tally.saved} saved${tally.failed.length ? `; not saved: ${tally.failed.join('; ')}` : ''}`);
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
  // Meta's rule: lowercase letters, numbers and underscores, up to 512 characters. A run of underscores is a mistake.
  if (!/^[a-z0-9_]{1,512}$/.test(name)) throw fail(name.length > 512 ? 'Keep the template name to 512 characters' : 'Name the template with lowercase letters, numbers and underscores, e.g. order_update');
  if (/__/.test(name)) throw fail(`Use a single underscore between words in the name, e.g. ${name.replace(/_{2,}/g, '_')}`);
  const language = String(spec.language || '').trim();
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) throw fail('Pick the language');
  const category = String(spec.category || '').toUpperCase();
  if (!TEMPLATE_CATEGORIES.includes(category)) throw fail('Pick Marketing or Utility');
  const now = new Date().toISOString();
  if (db.settings.demoMode) {
    // Demo: nothing goes to Meta; the template is kept here as if approved, for practice sends.
    const components = templateComponents(spec, { handle: 'demo', linkBase: await linkBaseFor(req, spec) });
    if (db.templates.some((x) => x.name === name && x.language === language)) throw fail('A template with this name and language already exists');
    const t = { id: id(), name, language, category, status: 'MANUAL', source: 'manual', parameterFormat: 'POSITIONAL', components, linkDefaults: components.linkDefaults, ...sampleAfterEdit(spec), createdAt: now, updatedAt: now };
    db.templates.push(t);
    save();
    return res.json(publicTemplate(t));
  }
  const s = templateSender(spec);
  if (db.templates.some((x) => x.wabaId === s.wabaId && x.name === name && x.language === language)) throw fail('A template with this name and language already exists. Pick another name, or edit that one.');
  const components = templateComponents(spec, { handle: await headerHandle(s, spec), linkBase: await linkBaseFor(req, spec) });
  const r = await graph(s, `${encodeURIComponent(s.wabaId)}/message_templates`, { method: 'POST', body: JSON.stringify({ name, language, category, components }) });
  const t = { id: id(), name, language, category: r.category || category, requestedCategory: category, categoryChangedFrom: categoryChangedFrom({ requestedCategory: category }, r.category || category), status: r.status || 'PENDING', rejectedReason: '', components, parameterFormat: 'POSITIONAL', source: 'synced', wabaId: s.wabaId, metaId: r.id, linkDefaults: components.linkDefaults, ...sampleAfterEdit(spec), createdAt: now, submittedAt: now, updatedAt: now };
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
    Object.assign(t, { category, ...sampleAfterEdit(spec, t), components, linkDefaults: components.linkDefaults, updatedAt: new Date().toISOString() });
    save();
    return res.json(publicTemplate(t));
  }
  if (!EDITABLE.includes(String(t.status).toUpperCase())) throw fail(`Meta doesn't allow editing a template while it's ${String(t.status).toLowerCase().replace(/_/g, ' ')}. Try again once it's approved or rejected.`);
  const s = templateSender(spec, t);
  const components = templateComponents(spec, { handle: await headerHandle(s, spec, t), linkBase: await linkBaseFor(req, spec) });
  await graph(s, encodeURIComponent(t.metaId), { method: 'POST', body: JSON.stringify({ components, ...(category !== t.category ? { category } : {}) }) });
  const now = new Date().toISOString();
  Object.assign(t, { ...sampleAfterEdit(spec, t), components, linkDefaults: components.linkDefaults, category, requestedCategory: category, categoryChangedFrom: '', status: 'PENDING', rejectedReason: '', editedAt: now, updatedAt: now });
  delete t.approvedAt; // set again when Meta approves the edit
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
  if (event === 'APPROVED') t.approvedAt = t.updatedAt;
  save();
  if (TEMPLATE_EVENT_TEXT[event]) notes?.add({ kind: event === 'APPROVED' || event === 'REINSTATED' ? 'template_approved' : 'template_problem', title: `Template ${t.name} was ${TEMPLATE_EVENT_TEXT[event]}`, body: t.rejectedReason ? `Meta's reason: ${t.rejectedReason.toLowerCase().replace(/_/g, ' ')}` : event === 'APPROVED' ? 'It can be used for sending now.' : '', link: { tab: 'templates', id: t.id } });
  broadcast({ kind: 'templates' });
}

// Meta re-categorising a template (field template_category_update). With new_category the change has happened;
// with only correct_category Meta is giving notice that it will change.
function handleTemplateCategory(wabaId, v) {
  const t = db.templates.find((x) => x.metaId === String(v.message_template_id)) ||
    db.templates.find((x) => x.wabaId === wabaId && x.name === v.message_template_name && x.language === v.message_template_language);
  if (!t) return;
  const label = (c) => String(c || '').toLowerCase();
  const from = String(v.previous_category || t.category || '').toUpperCase();
  const to = String(v.new_category || '').toUpperCase();
  if (to) {
    if (to === String(t.category).toUpperCase() && t.categoryChangedFrom) return; // already known (a repeat)
    t.category = to;
    t.categoryChangedFrom = categoryChangedFrom(t, to, from);
    t.updatedAt = new Date().toISOString();
    save();
    notes?.add({ kind: 'template_problem', title: `Meta changed ${t.name} from ${label(from)} to ${label(to)}`, body: `It's now charged and treated as a ${label(to)} message. If you think that's wrong, request a review in WhatsApp Manager → Business Support Home.`, link: { tab: 'templates', id: t.id } });
  } else if (v.correct_category) {
    notes?.add({ kind: 'template_problem', title: `Meta will change ${t.name} to ${label(v.correct_category)}`, body: `Meta says it doesn't fit ${label(from)}. If you think that's wrong, request a review in WhatsApp Manager → Business Support Home.`, link: { tab: 'templates', id: t.id } });
  }
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
  { const e = !db.settings.demoMode && notApprovedError(template); if (e) throw fail(e); }
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

// Meta only delivers approved templates; anything else would fail for every recipient. Templates made here in
// demo mode have no Meta status to wait for.
function notApprovedError(t) {
  const st = String(t.status || '').toUpperCase();
  if (t.source !== 'synced' || st === 'APPROVED') return '';
  return st === 'PENDING' ? `${t.name} is still in review at Meta. It can be sent once it's approved (usually within a day; you'll get a notification).` : `Meta won't deliver ${t.name} while it's ${st.toLowerCase().replace(/_/g, ' ')}. Only approved templates can be sent.`;
}

function createCampaign(body) {
  // Sending a draft (made with New campaign): its name, template and AI settings, and its id, so the page that set it up
  // keeps pointing at it. The draft stays until the send can no longer be undone (finishDraft).
  const draft = body.draftId ? db.drafts.find((d) => d.id === body.draftId) : null;
  if (body.draftId && !draft) throw fail('This campaign was deleted or has already been sent', 404);
  if (draft && db.campaigns.some((c) => c.id === draft.id)) throw fail('This campaign is already sending', 409);
  const name = draft ? draft.name : body.name;
  const templateId = draft ? draft.templateId : body.templateId;
  const senderIds = draft?.senderIds?.length ? draft.senderIds : body.senderIds || [];
  const hold = Math.min(10, Math.max(0, Math.round(Number(body.hold) || 0)));
  if (tenants.meta()?.suspended) throw fail('This workspace is suspended', 403);
  const template = db.templates.find((t) => t.id === templateId);
  if (!template) throw fail('Pick a template');
  { const e = !db.settings.demoMode && notApprovedError(template); if (e) throw fail(e); }
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
  if (!credits.enough(recipients.length * credits.rateFor(template))) throw fail(`Not enough credits. ${creditsShort(recipients.length, template)} Add credits on the Credits page, or send to fewer people.`, 402);
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
    id: draft ? draft.id : id(),
    name: name || `${template.name} — ${localStamp(body.tz)}`,
    templateId,
    templateName: template.name,
    senderIds: senders.map((s) => s.id),
    demo: db.settings.demoMode,
    createdAt: new Date().toISOString(),
    scheduledAt,
    // "Send now" waits a few seconds first (hold), so an accidental send can be undone (POST …/undo) before anything goes
    status: scheduledAt ? 'scheduled' : hold ? 'holding' : 'queued',
    ...(hold && !scheduledAt ? { holdUntil: new Date(Date.now() + hold * 1000).toISOString() } : {}),
    skipped: [...(body.skipped || []), ...skipped],
    recipients,
    ...(body.source ? { source: body.source } : {}),
    // a test send (to yourself or the team): tagged, and left out of the Overview's numbers unless asked for
    ...(body.test ? { test: true } : {}),
    ...(draft ? { ai: draft.ai || { on: false }, fromDraft: true, ...(draft.description ? { description: draft.description } : {}) } : {}),
  };
  recount(c);
  db.campaigns.unshift(c);
  if (c.status !== 'holding') finishDraft(c);
  save();
  if (c.status === 'holding') setTimeout(() => releaseHold(c), hold * 1000);
  else if (!scheduledAt) runCampaign(c);
  return c;
}
// A sent draft is a campaign now: the draft goes (an undone send leaves it, ready to send again).
function finishDraft(c) {
  if (c.fromDraft) db.drafts = db.drafts.filter((d) => d.id !== c.id);
}
// The undo window has passed: send it (unless it was undone; then it's gone from the list and nothing happens).
function releaseHold(c) {
  if (c.status !== 'holding' || !db.campaigns.includes(c)) return;
  c.status = 'queued';
  delete c.holdUntil;
  finishDraft(c);
  save();
  runCampaign(c);
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
      // held for undo while the server restarted: its few seconds are up
      if (c.status === 'holding' && new Date(c.holdUntil) <= now) releaseHold(c);
    }
  });
}, 5000);

// Mark a campaign as a test, or not (from its ⋯ menu): only changes where it's counted, never what was sent.
app.post('/api/campaigns/:id/test', wrap((req, res) => {
  const c = db.campaigns.find((x) => x.id === req.params.id);
  if (!c) throw fail('Not found', 404);
  if (req.body.test) c.test = true; else delete c.test;
  save();
  res.json(summary(c));
}));

// Undo a "Send now" within its few seconds: the campaign is removed as if it was never sent.
app.post('/api/campaigns/:id/undo', wrap((req, res) => {
  const c = db.campaigns.find((x) => x.id === req.params.id);
  if (!c) throw fail('Not found', 404);
  if (c.status !== 'holding') throw fail('Too late to undo: the campaign has started sending', 409);
  db.campaigns = db.campaigns.filter((x) => x !== c);
  save();
  res.json({ ok: true });
}));

app.post('/api/campaigns/:id/cancel', wrap((req, res) => {
  const c = db.campaigns.find((x) => x.id === req.params.id);
  if (!c) throw fail('Not found', 404);
  if (c.status !== 'scheduled') throw fail('Only scheduled campaigns can be cancelled');
  c.status = 'cancelled';
  save();
  res.json(summary(c));
}));

// --- Campaign drafts -----------------------------------------------------------
// New campaign makes a draft: a name, a template and the AI reply settings. The people to send to are set up on the
// Send page (kept in that browser while it's a draft); sending it turns the draft into a campaign with the same id.
const AI_LIMITS = { business: 20000, qualified: 4000, nextStep: 1000, tone: 300 };
function cleanAi(a = {}) {
  const out = { on: Boolean(a.on), auto: Boolean(a.on && a.auto) };
  for (const [k, n] of Object.entries(AI_LIMITS)) out[k] = String(a[k] ?? '').slice(0, n);
  // a playbook it starts from (its facts and rules first, this campaign's additions on top; lead.js)
  const pb = String(a.playbookId || '');
  if (pb && normalizeLead(db.settings.leadAgent || {}).playbooks.some((p) => p.id === pb)) out.playbookId = pb;
  return out;
}
function draftFields(body, d = {}) {
  if (body.name !== undefined) {
    const name = String(body.name || '').trim().slice(0, 120);
    if (!name) throw fail('Give the campaign a name');
    d.name = name;
  }
  if (body.templateId !== undefined) {
    const t = db.templates.find((x) => x.id === body.templateId);
    if (!t) throw fail('Pick a template');
    d.templateId = t.id;
    d.templateName = t.name;
  }
  if (body.ai !== undefined) d.ai = cleanAi(body.ai);
  if (body.description !== undefined) d.description = String(body.description || '').trim().slice(0, 500);
  // The numbers it sends from: enabled ones that can send its template (same WhatsApp Business Account).
  if (body.senderIds !== undefined || body.templateId !== undefined) {
    const t = db.templates.find((x) => x.id === d.templateId);
    const want = body.senderIds !== undefined ? (Array.isArray(body.senderIds) ? body.senderIds.map(String) : []) : d.senderIds || [];
    const ok = db.senders.filter((x) => x.enabled && want.includes(x.id) && !(t?.wabaId && x.wabaId && x.wabaId !== t.wabaId));
    if (body.senderIds !== undefined && !ok.length) throw fail('Choose at least one number to send from');
    d.senderIds = ok.map((x) => x.id);
  }
  d.updatedAt = new Date().toISOString();
  return d;
}
// A draft without its saved sheets (they can be large): for lists and replies to edits.
const draftLite = ({ work, ...d }) => d;
app.get('/api/drafts', (req, res) => res.json(db.drafts.filter((d) => Boolean(d.demo) === Boolean(db.settings.demoMode)).map(draftLite)));
// Save as draft: the Send page's sheets (rows, ticks, edits), variables and schedule, so the draft opens with its people
// on any device. The page also keeps a copy in the browser as you work; whichever is newer is used when it's opened.
const WORK_MAX = 15 * 1024 * 1024;
app.put('/api/drafts/:id/work', wrap((req, res) => {
  const d = db.drafts.find((x) => x.id === req.params.id);
  if (!d) throw fail('This campaign draft was deleted or has been sent', 404);
  const w = req.body || {};
  if (!Array.isArray(w.sheets) || w.sheets.length > 50) throw fail('Nothing to save');
  const strs = (a) => (Array.isArray(a) ? a.map((x) => String(x ?? '')) : []);
  const sheets = w.sheets.map((sh) => ({
    name: String(sh?.name || '').slice(0, 200), file: String(sh?.file || '').slice(0, 300), headers: strs(sh?.headers),
    widths: Array.isArray(sh?.widths) ? sh.widths.map((n) => Number(n) || 0) : [], wraps: Array.isArray(sh?.wraps) ? sh.wraps : [],
    phoneName: String(sh?.phoneName || ''), included: sh?.included !== false, dirty: Boolean(sh?.dirty),
    rows: (Array.isArray(sh?.rows) ? sh.rows : []).filter(Array.isArray).map(([cells, on, pick]) => (Array.isArray(pick) && pick.length ? [strs(cells), on ? 1 : 0, pick] : [strs(cells), on ? 1 : 0])),
    filters: sh?.filters && typeof sh.filters === 'object' ? sh.filters : {},
  }));
  const work = { v: 1, savedAt: Number(w.savedAt) || Date.now(), active: Number(w.active) || 0, mapping: w.mapping && typeof w.mapping === 'object' ? w.mapping : {}, sheets, mode: w.mode === 'schedule' ? 'schedule' : 'now', at: String(w.at || '').slice(0, 40) };
  if (JSON.stringify(work).length > WORK_MAX) throw fail('This draft is too big to save (over 15 MB). Remove some sheets or columns and try again.', 413);
  d.work = work;
  d.people = sheets.filter((x) => x.included).reduce((n, x) => n + x.rows.filter((r) => r[1]).length, 0);
  d.workAt = d.updatedAt = new Date().toISOString();
  save();
  res.json(draftLite(d));
}));
app.get('/api/drafts/:id', wrap((req, res) => {
  const d = db.drafts.find((x) => x.id === req.params.id);
  if (!d) throw fail(db.campaigns.some((c) => c.id === req.params.id) ? 'This campaign has already been sent' : 'This campaign draft was deleted', 404);
  res.json(d);
}));
app.post('/api/drafts', wrap((req, res) => {
  if (!String(req.body?.name || '').trim()) throw fail('Give the campaign a name');
  if (!req.body?.templateId) throw fail('Pick a template');
  const d = draftFields({ ai: {}, ...req.body }, { id: id(), createdAt: new Date().toISOString(), ...(db.settings.demoMode ? { demo: true } : {}) });
  db.drafts.unshift(d);
  save();
  res.json(d);
}));
app.patch('/api/drafts/:id', wrap((req, res) => {
  const d = db.drafts.find((x) => x.id === req.params.id);
  if (!d) throw fail('This campaign draft was deleted or has been sent', 404);
  draftFields(req.body || {}, d);
  save();
  res.json(draftLite(d));
}));
app.delete('/api/drafts/:id', wrap((req, res) => {
  db.drafts = db.drafts.filter((x) => x.id !== req.params.id);
  save();
  res.json({ ok: true });
}));
// A sent campaign can be renamed (its name is only a label: nothing sent changes).
app.patch('/api/campaigns/:id/name', wrap((req, res) => {
  const c = db.campaigns.find((x) => x.id === req.params.id);
  if (!c) throw fail('Not found', 404);
  const name = String(req.body?.name || '').trim().slice(0, 120);
  if (!name) throw fail('Give the campaign a name');
  c.name = name;
  save();
  res.json({ name });
}));
// A sent campaign's AI reply settings can still change: replies keep coming after it's sent.
app.patch('/api/campaigns/:id/ai', wrap((req, res) => {
  const c = db.campaigns.find((x) => x.id === req.params.id);
  if (!c) throw fail('Not found', 404);
  c.ai = cleanAi(req.body?.ai);
  save();
  res.json({ ai: c.ai });
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

// The Campaigns page asks a page at a time (?page=…, or ?view=calendar&month=YYYY-MM): search, status, number, dates
// and sort are applied here and only what's shown is worked out (replies and leads read the inbox, the costly part)
// and sent, with the counts the page shows. Without them it's the whole list, as other callers expect.
const CP_FILTERS = {
  all: () => true,
  completed: (c) => c.status === 'completed',
  stopped: (c) => c.status === 'stopped' || c.status === 'cancelled',
  tests: (c) => Boolean(c.test),
};
const cpLive = (c) => c.status === 'running' || c.status === 'queued';
const cpDay = (c) => c.startedAt || c.scheduledAt || c.createdAt;
app.get('/api/campaigns', (req, res) => {
  const all = db.campaigns.filter((c) => c.status !== 'holding');
  const paged = req.query.page != null || req.query.view === 'calendar';
  if (!paged) {
    const idx = inboundIndex();
    return res.json(all.map((c) => { const o = outcome(c, idx); return { ...summary(c), replies: o.replies, leads: o.leads }; }));
  }
  const q = String(req.query.q || '').trim().toLowerCase();
  const sender = String(req.query.sender || '');
  const filter = CP_FILTERS[req.query.filter] ? req.query.filter : 'all';
  const sort = String(req.query.sort || 'new');
  const per = Math.min(500, Math.max(0, Math.round(Number(req.query.per ?? 50)) || 0)); // 0 = all
  const tz = Number(req.query.tz) || 0; // the browser's getTimezoneOffset(), so "a day" is the person's day
  const dayKey = (iso) => new Date(new Date(iso).getTime() - tz * 60000).toISOString().slice(0, 10);
  let dates = null;
  try { dates = req.query.dates ? JSON.parse(String(req.query.dates)) : null; } catch {}
  const dayOk = (c) => {
    if (!dates) return true;
    const k = dayKey(cpDay(c));
    if (Array.isArray(dates.days) && dates.days.length) return dates.days.includes(k);
    if (dates.from && dates.to) return k >= dates.from && k <= dates.to;
    return true;
  };
  const textOk = (c) => !q || [c.name, c.templateName].some((v) => String(v || '').toLowerCase().includes(q));
  const senderOk = (c) => !sender || (c.senderIds || []).includes(sender);
  const settled = all.filter((c) => !cpLive(c) && c.status !== 'scheduled');
  const counts = Object.fromEntries(Object.entries(CP_FILTERS).map(([k, fn]) => [k, settled.filter(fn).length]));
  const rows = settled.filter(CP_FILTERS[filter]).filter((c) => textOk(c) && senderOk(c) && dayOk(c));
  const pinned = all.filter((c) => (cpLive(c) || c.status === 'scheduled') && textOk(c) && senderOk(c) && dayOk(c))
    .sort((a, b) => (cpLive(b) - cpLive(a)) || String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
  const idx = inboundIndex();
  const outs = new Map();
  const out = (c) => outs.get(c.id) || outs.set(c.id, outcome(c, idx)).get(c.id);
  const del = (c) => (c.stats?.delivered || 0) + (c.stats?.read || 0);
  const readPct = (c) => (del(c) ? (c.stats?.read || 0) / del(c) : 0);
  const SORT = {
    new: (a, b) => String(b.startedAt || b.createdAt).localeCompare(String(a.startedAt || a.createdAt)),
    old: (a, b) => String(a.startedAt || a.createdAt).localeCompare(String(b.startedAt || b.createdAt)),
    size: (a, b) => b.recipients.length - a.recipients.length,
    read: (a, b) => readPct(b) - readPct(a),
    replies: (a, b) => out(b).replies - out(a).replies, // (only this sort reads every campaign's replies)
  };
  rows.sort(SORT[sort] || SORT.new);
  // colour: place by creation date (as everywhere)
  const order = new Map([...db.campaigns].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map((c, i) => [c.id, i]));
  const show = (c) => { const o = out(c); return { ...summary(c), replies: o.replies, leads: o.leads, colorIndex: order.get(c.id) }; };
  // the last 30 days, in the current mode, tests left out (the header's summary)
  const since = Date.now() - 30 * 86400000;
  const inWindow = all.filter((c) => new Date(c.startedAt || c.createdAt).getTime() >= since && Boolean(c.demo) === Boolean(db.settings.demoMode));
  const recent = inWindow.filter((c) => !c.test);
  const summary30 = recent.reduce((a, c) => { const st = c.stats || {}; a.sent += (st.sent || 0) + (st.delivered || 0) + (st.read || 0); a.del += del(c); a.read += st.read || 0; const o = out(c); a.rep += o.replies; a.leads += o.leads; return a; }, { sent: 0, del: 0, read: 0, rep: 0, leads: 0, testsOut: inWindow.length - recent.length });
  // dots for the date picker, and the months that have campaigns
  const days = {};
  for (const c of all) { const k = dayKey(cpDay(c)); days[k] = (days[k] || 0) + 1; }
  const drafts = db.drafts.filter((d) => Boolean(d.demo) === Boolean(db.settings.demoMode) && (!q || [d.name, d.templateName].some((v) => String(v || '').toLowerCase().includes(q))));
  const draftCount = db.drafts.filter((d) => Boolean(d.demo) === Boolean(db.settings.demoMode)).length;
  const base = { counts, total: rows.length, pinned: pinned.map(show), drafts, draftCount, summary: summary30, days, any: all.length + db.drafts.length, live: all.some(cpLive), scheduled: all.some((c) => c.status === 'scheduled') };
  if (req.query.view === 'calendar') {
    const both = [...pinned, ...rows];
    const newest = both.map(cpDay).sort().at(-1);
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : (newest ? dayKey(newest) : dayKey(new Date().toISOString())).slice(0, 7);
    return res.json({ ...base, month, items: both.filter((c) => dayKey(cpDay(c)).startsWith(month)).map(show) });
  }
  const pages = per ? Math.max(1, Math.ceil(rows.length / per)) : 1;
  const page = Math.min(Math.max(0, Math.round(Number(req.query.page)) || 0), pages - 1);
  res.json({ ...base, page, pages, per, items: (per ? rows.slice(page * per, page * per + per) : rows).map(show) });
});

app.get('/api/campaigns/:id', wrap((req, res) => {
  const c = db.campaigns.find((x) => x.id === req.params.id);
  if (!c) throw fail('Not found', 404);
  const o = outcome(c, inboundIndex());
  const colorIndex = [...db.campaigns].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).findIndex((x) => x.id === c.id);
  res.json({ ...c, colorIndex, replies: o.replies, leads: o.leads, recipients: c.recipients.map((r, i) => (o.per[i] ? { ...r, replied: o.per[i].replied, chatKey: o.per[i].key, contactStatus: o.per[i].contactStatus } : r)) });
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
  const reasonOf = (r) => errorCodeOf(r.error) || String(r.error || '');
  const retry = req.body?.retryFailed || codes ? c.recipients.filter((r) => r.status === 'failed' && (!codes || codes.has(reasonOf(r)))) : [];
  const tpl = db.templates.find((t) => t.id === c.templateId);
  const toSend = c.recipients.filter((r) => r.status === 'pending' || r.status === 'queued').length + retry.length;
  if (tpl && !credits.enough(toSend * credits.rateFor(tpl), c.demo)) throw fail(`Not enough credits. ${creditsShort(toSend, tpl)} Add credits on the Credits page.`, 402);
  retry.forEach((r) => Object.assign(r, { status: 'pending', error: undefined }));
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
function broadcastTo(ws, data) {
  const line = `event: inbox\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) if (res.wsId === ws) res.write(line);
}
// This server's version: it changes with every deploy (restart), so open pages can tell they're out of date.
const BUILD_ID = String(process.env.RAILWAY_DEPLOYMENT_ID || process.env.RAILWAY_GIT_COMMIT_SHA || Date.now());
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
      out.media = { id: x.id, mime: x.mime_type, filename: x.filename, voice: Boolean(x.voice), ...(x.sha256 ? { sha256: x.sha256 } : {}), ...(x.animated ? { animated: true } : {}) };
      out.text = x.caption || '';
      break;
    }
    case 'location':
      out.location = { lat: m.location?.latitude, lng: m.location?.longitude, name: m.location?.name, address: m.location?.address };
      break;
    case 'contacts':
      out.text = (m.contacts || []).map((c) => [c.name?.formatted_name, ...(c.phones || []).map((p) => p.phone)].filter(Boolean).join(' · ')).join('\n');
      // Kept whole too, so the inbox can draw a contact card (name, numbers, company, email).
      out.contacts = (m.contacts || []).map((c) => ({
        name: c.name?.formatted_name || [c.name?.first_name, c.name?.last_name].filter(Boolean).join(' '),
        phones: (c.phones || []).map((p) => ({ phone: p.phone || '', wa: p.wa_id || '', type: p.type || '' })),
        org: c.org?.company || '',
        email: c.emails?.[0]?.email || '',
      }));
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
    case 'system': // e.g. "They changed their number"
      out.text = m.system?.body || 'WhatsApp notice';
      break;
    default: {
      // WhatsApp didn't send the content (view-once, polls, edits…). Keep what it says about why, so the chat
      // can name it ("View-once message") instead of a blank "not supported".
      const e = m.errors?.[0] || {};
      const raw = String(m.unsupported?.type || '').toLowerCase();
      const said = `${raw} ${e.title || ''} ${e.message || ''} ${e.error_data?.details || ''}`.toLowerCase();
      const kind = /view[\s_-]?once/.test(said) ? 'view_once'
        : /\bpoll/.test(said) ? 'poll'
        : /\bedit/.test(said) ? 'edit'
        : /live[\s_-]?location/.test(said) ? 'live_location'
        : /\bevent\b/.test(said) ? 'event'
        : /video[\s_-]?note/.test(said) ? 'video_note'
        : /\bcall/.test(said) ? 'call'
        : /ephemeral|disappearing/.test(said) ? 'ephemeral'
        : raw || (m.type && !['unsupported', 'unknown'].includes(m.type) ? m.type : '');
      out.type = 'unsupported';
      out.unsupported = { kind, code: e.code || null, reason: e.error_data?.details || e.message || e.title || '', raw: raw || m.type || '' };
      out.text = UNSUPPORTED_LABEL[kind] || 'Message not shown here';
    }
  }
  return out;
}
const UNSUPPORTED_LABEL = { view_once: 'View-once message', poll: 'Poll', edit: 'Edited a message', live_location: 'Live location', event: 'Event', video_note: 'Video note', call: 'Call', ephemeral: 'Disappearing message' };

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
    const contact = contactsApi.onInbound(m.from, { name: names[m.from], text: msg.text, ts: msg.ts, senderId });
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

// msgs: this chat's messages, oldest first. ctx (from the list): lookups built once for every chat, so building the list
// stays one pass over the messages however many chats there are.
function conversationInfo(key, msgs, names, ctx = null) {
  const base = conversationBase(key, msgs, names, ctx);
  return { ...base, ...conversationExtras(key, base.wa, base._lastIn, ctx), _lastIn: undefined };
}
// The cheap part, for every chat: what the list filters, sorts and counts by. (_lastIn is for the extras.)
function conversationBase(key, msgs, names, ctx = null) {
  const { senderId, wa } = splitKey(key);
  const chat = db.chats[key] || {};
  const sender = ctx ? ctx.senders.get(senderId) : db.senders.find((s) => s.id === senderId);
  let lastIn = null, last = null, unread = 0;
  for (const m of msgs) {
    if (m.dir === 'in') { lastIn = m; if (!chat.lastReadAt || m.ts > chat.lastReadAt) unread++; }
    if (m.type !== 'reaction') last = m;
  }
  last ||= msgs.at(-1);
  return {
    key,
    senderId,
    senderLabel: sender?.label || 'Unknown number',
    wa,
    name: chat.name || names.get(wa) || '',
    last: last && {
      dir: last.dir, type: last.type, text: last.text || last.templateName || '', status: last.status, ts: last.ts, reaction: last.reaction,
      // For the preview line's icon and words: voice note or audio file, the document's name, the place, the contact.
      ...(last.media ? { media: { id: last.media.id, mime: last.media.mime, voice: last.media.voice || undefined, filename: last.media.filename } } : {}),
      ...(last.location?.name ? { location: { name: last.location.name } } : {}),
      ...(last.contacts?.[0]?.name ? { contacts: [{ name: last.contacts[0].name }] } : {}),
      ...(last.unsupported?.kind ? { unsupported: { kind: last.unsupported.kind } } : {}),
    },
    lastAt: last?.ts || null,
    unread,
    windowEndsAt: lastIn ? new Date(new Date(lastIn.ts).getTime() + WINDOW_MS).toISOString() : null,
    _lastIn: lastIn,
  };
}

// Lead assistant and contact details shown on each conversation.
function conversationExtras(key, wa, lastIn, ctx) {
  const ai = leadApi.stateFor(key, lastIn ?? null);
  const c = ctx ? ctx.contacts.get(wa) : contactsApi.byPhone(wa);
  return {
    ai: { on: ai.on, busy: ai.busy, hasDraft: Boolean(ai.draft), handover: Boolean(ai.handover) },
    contact: c ? { id: c.id, status: c.status, optOut: c.optOut, tags: c.tags } : null,
  };
}

app.get('/api/version', (req, res) => res.json({ build: BUILD_ID }));
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  res.write(`event: inbox\ndata: ${JSON.stringify({ kind: 'hello', build: BUILD_ID })}\n\n`);
  res.wsId = tenants.wsId();
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
});

// A contact's chats, per number of ours: every template sent to them from it (by a campaign or from the Inbox) with how
// it went, and whether they've written back to that number (only then is there a conversation to open). For the
// contact panel's Chat window. Numbers they replied to come first, most recent reply first.
app.get('/api/contacts/:id/threads', wrap((req, res) => {
  const c = db.contacts.find((x) => x.id === req.params.id);
  if (!c) throw fail('Contact not found', 404);
  const wa = c.phone, by = new Map();
  const get = (sid) => by.get(sid) || by.set(sid, { senderId: sid, key: chatKey(sid, wa), sends: [], replied: false, lastInAt: null }).get(sid);
  for (const camp of db.campaigns) {
    if (camp.demo && !db.settings.demoMode) continue;
    for (const r of camp.recipients) {
      if (r.phone !== wa || !(r.sentAt || r.failedAt)) continue;
      get(r.senderId).sends.push({ campaign: camp.name, campaignId: camp.id, templateId: camp.templateId, templateName: camp.templateName, values: r.values || {}, status: r.status, error: r.error || '', at: r.readAt || r.deliveredAt || r.sentAt || r.failedAt });
    }
  }
  for (const m of inboxMessages()) {
    if (m.wa !== wa) continue;
    const t = get(m.senderId);
    if (m.dir === 'in') { t.replied = true; if (!t.lastInAt || m.ts > t.lastInAt) t.lastInAt = m.ts; }
    else if (m.type === 'template' && m.campaign !== 'Test send') t.sends.push({ campaign: '', templateId: m.templateId, templateName: m.templateName, values: m.values || {}, status: m.status, error: m.error || '', at: m.ts });
  }
  const threads = [...by.values()].map((t) => ({ ...t, sends: t.sends.sort((a, b) => String(b.at).localeCompare(String(a.at))) }));
  threads.sort((a, b) => (b.replied - a.replied) || String(b.lastInAt || '').localeCompare(String(a.lastInAt || '')));
  res.json({ threads });
}));

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
  const ctx = { senders: new Map(db.senders.map((s) => [s.id, s])), contacts: new Map(db.contacts.map((c) => [c.phone, c])) };
  if (req.query.offset == null) { // everything (older callers)
    const conversations = [...byKey].map(([key, msgs]) => ({ ...conversationInfo(key, sorted(msgs), names, ctx), templates: [...(tpls.get(key) || [])] }));
    conversations.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
    return sendJson(req, res, { conversations, unread: conversations.reduce((n, c) => n + c.unread, 0) });
  }
  // The Inbox list, a slice at a time (?offset=0&limit=30, then 25 more as you scroll): search, filters, days and order
  // apply here over every chat's cheap details; only the slice gets the rest (AI state, contact) and is sent.
  const all = [...byKey].map(([key, msgs]) => ({ ...conversationBase(key, sorted(msgs), names, ctx), templates: [...(tpls.get(key) || [])] }));
  const now = Date.now();
  const tz = Number(req.query.tz) || 0;
  const dayKey = (iso) => new Date(new Date(iso).getTime() - tz * 60000).toISOString().slice(0, 10);
  let dates = null;
  try { dates = req.query.dates ? JSON.parse(String(req.query.dates)) : null; } catch {}
  const q = String(req.query.q || '').trim().toLowerCase(), qDigits = q.replace(/\D/g, '');
  const f = String(req.query.filter || 'all'), sender = String(req.query.sender || ''), template = String(req.query.template || '');
  const open = (c) => c.windowEndsAt && new Date(c.windowEndsAt) > now;
  const ok = (c) => {
    if (f === 'unread' && !c.unread) return false;
    if (f === 'open' && !open(c)) return false;
    if (sender && c.senderId !== sender) return false;
    if (template && !c.templates.includes(template)) return false;
    if (q && ![c.name, c.wa, c.last?.text].some((v) => String(v || '').toLowerCase().includes(q)) && !(qDigits.length >= 3 && c.wa.includes(qDigits))) return false;
    if (dates && c.lastAt) {
      const k = dayKey(c.lastAt);
      if (Array.isArray(dates.days) && dates.days.length ? !dates.days.includes(k) : dates.from && dates.to && (k < dates.from || k > dates.to)) return false;
    }
    return true;
  };
  const rows = all.filter(ok).sort(req.query.sort === 'old' ? (a, b) => String(a.lastAt || '').localeCompare(String(b.lastAt || '')) : (a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
  const offset = Math.max(0, Math.round(Number(req.query.offset)) || 0);
  const limit = Math.min(200, Math.max(1, Math.round(Number(req.query.limit)) || 30));
  const slice = rows.slice(offset, offset + limit).map(({ _lastIn, ...c }) => ({ ...c, ...conversationExtras(c.key, c.wa, _lastIn, ctx) }));
  // what the filters show (over every chat): counts per tab, number and template, and dots for the date picker
  const senders = {}, templates = {}, days = {};
  for (const c of all) {
    senders[c.senderId] = (senders[c.senderId] || 0) + 1;
    for (const t of c.templates) templates[t] = (templates[t] || 0) + 1;
    if (c.lastAt) { const k = dayKey(c.lastAt); days[k] = (days[k] || 0) + 1; }
  }
  const senderLabels = Object.fromEntries(all.map((c) => [c.senderId, c.senderLabel]));
  sendJson(req, res, {
    conversations: slice, total: rows.length, offset, unread: all.reduce((n, c) => n + c.unread, 0),
    counts: { all: all.length, unread: all.filter((c) => c.unread).length, open: all.filter(open).length },
    senders, senderLabels, templates, days,
  });
});
// Messages are stored in the order they arrive, so they're nearly always sorted already: only sort when they aren't.
function sorted(msgs) {
  for (let i = 1; i < msgs.length; i++) if (msgs[i - 1].ts > msgs[i].ts) return msgs.sort((a, b) => a.ts.localeCompare(b.ts));
  return msgs;
}
// A big JSON reply, gzipped when the browser accepts it (the Inbox list is mostly repeated keys: ~10x smaller).
function sendJson(req, res, body) {
  const text = JSON.stringify(body);
  if (text.length < 20000 || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return res.type('json').send(text);
  res.set({ 'Content-Encoding': 'gzip', 'Content-Type': 'application/json; charset=utf-8', Vary: 'Accept-Encoding' });
  res.send(require('zlib').gzipSync(text, { level: 6 }));
}

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
      sent.push({ id: r.messageId || c.id + wa, wamid: r.messageId, dir: 'out', type: 'template', templateId: c.templateId, templateName: c.templateName, values: r.values, campaign: c.name, ts: r.sentAt || r.failedAt, status: r.status, error: r.error, resentAt: r.resentAt, demo: Boolean(c.demo), seed: Boolean(c.seed) });
    }
  }
  const all = [...own, ...sent].sort((a, b) => a.ts.localeCompare(b.ts));
  // The latest `limit` messages (default 150); the chat asks for more when you scroll back to the top.
  const limit = Math.max(20, Math.min(5000, Number(req.query.limit) || 150));
  const messages = all.slice(-limit);
  const contact = contactsApi.byPhone(wa) || null;
  sendJson(req, res, { conversation: conversationInfo(key, own, recipientNames()), messages, earlier: all.length - messages.length, ai: req.ai ? leadApi.stateFor(key) : null, contact, chatLead: leadApi.chatLead(key, contact), tags: db.tags });
}));

// Mark a conversation read here, and (live) send blue ticks to the person.
app.post('/api/inbox/:key/read', wrap(async (req, res) => {
  const key = req.params.key;
  const chat = (db.chats[key] ||= { lastReadAt: null });
  chat.lastReadAt = new Date().toISOString();
  save();
  broadcast({ kind: 'read', key });
  res.json({ ok: true });
  if ((db.settings.readReceipts || 'open') === 'open') sendReadReceipt(key);
}));

// Blue ticks for the customer. settings.readReceipts:
//   'open'  (default) when you open the chat, and when anyone replies (you or the AI)
//   'reply' only when a reply is sent, so you can read without them knowing
//   'off'   never
// One receipt for their latest message marks everything before it read too; each message is sent at most once.
const READ_RECEIPTS = ['open', 'reply', 'off'];
function sendReadReceipt(key) {
  const lastIn = db.messages.filter((m) => m.key === key && m.dir === 'in' && !m.demo && m.wamid && m.type !== 'reaction').at(-1);
  const sender = db.senders.find((s) => s.id === splitKey(key).senderId);
  if (!lastIn || lastIn.readSent || !sender?.accessToken || db.settings.demoMode) return;
  lastIn.readSent = true;
  save();
  graph(sender, `${sender.phoneNumberId}/messages`, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: lastIn.wamid }) }).catch(() => {});
}

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

  if (templateId) return res.json(await sendInboxTemplate(key, templateId, values));
  // Sending the AI's suggested reply as it is (written by the AI, on any key): 1 credit. Typed or edited by a person: free.
  const draft = db.chats[key]?.ai?.draft;
  const aiWritten = draft && String(text || '').trim() === String(draft.text || '').trim();
  const ch = aiWritten ? credits.charge(credits.AI_RATE, credits.keys.aiReply()) : null;
  if (ch === false) throw fail('Out of credits: sending the AI’s suggested reply uses 1 credit. Add credits on the Credits page, or edit the reply and send it as your own.', 402);
  try { res.json(await sendInboxText(key, text, { replyTo, ...(ch ? { credit: ch } : {}) })); } catch (e) { credits.refund(ch); throw e; }
}));

// The person behind a chat: their contact, and every chat they have with our numbers that you can see (a member limited
// to some numbers sees only those), each with its own notes. Newest first; the open chat is marked.
app.get('/api/inbox/:key/profile', wrap((req, res) => {
  const key = req.params.key;
  const { wa } = splitKey(key);
  if (!/^\d{6,15}$/.test(wa)) throw fail('Invalid phone number');
  const scope = req.senderScope;
  const contact = contactsApi.byPhone(wa) || null;
  const chats = new Map();
  for (const m of db.messages) {
    if (m.wa !== wa || (scope && !scope.has(m.senderId)) || m.type === 'reaction') continue;
    const x = chats.get(m.key) || chats.set(m.key, { key: m.key, senderId: m.senderId, count: 0, lastAt: '', firstAt: m.ts }).get(m.key);
    x.count++;
    if (m.ts >= x.lastAt) { x.lastAt = m.ts; x.lastDir = m.dir; x.lastText = m.text || (m.type === 'template' ? `Template: ${m.templateName || ''}` : m.type); }
  }
  const senders = Object.fromEntries(db.senders.map((s) => [s.id, s]));
  const list = [...chats.values()].filter((x) => senders[x.senderId]).map((x) => ({
    ...x, current: x.key === key, number: senders[x.senderId].label, displayPhone: senders[x.senderId].displayPhone || '',
    lead: leadApi.chatLead(x.key, contact),
  })).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const tags = (contact?.tags || []).map((t) => db.tags.find((x) => x.id === t)).filter(Boolean);
  res.json({ contact, tags, chats: list });
}));

// A person decides whether this chat's contact is a qualified lead (or hands it back to the AI): contacts.setLead.
app.post('/api/inbox/:key/lead', wrap((req, res) => {
  const { wa } = splitKey(req.params.key);
  if (!/^\d{6,15}$/.test(wa)) throw fail('Invalid phone number');
  const q = req.body?.qualified;
  if (q !== true && q !== false && q !== null) throw fail('Say whether they are a qualified lead');
  const contact = contactsApi.setLead(wa, q, req.user?.email || '');
  save();
  contactsApi.notify(req.params.key);
  res.json({ contact });
}));

// A template message in a conversation (works any time, inside or outside the 24-hour window).
async function sendInboxTemplate(key, templateId, values = {}) {
  const { senderId, wa } = splitKey(key);
  const sender = db.senders.find((s) => s.id === senderId);
  if (!sender) throw fail('This WhatsApp number is no longer connected');
  if (!db.settings.demoMode && !sender.accessToken) throw fail(`"${sender.label}" has no access token`);
  const template = db.templates.find((t) => t.id === templateId);
  if (!template) throw fail('Pick a template');
  const filled = withLinkDefaults(template, values);
  const empty = templateVariables(template.components).find((v) => !String(filled[v.key] ?? '').trim());
  if (empty) throw fail(`Fill in ${empty.where} ${empty.name}`);
  const linkErr = valuesProblem(template, filled);
  if (linkErr) throw fail(linkErr);
  const ch = credits.charge(credits.rateFor(template), credits.keys.inboxTemplate());
  if (ch === false) throw fail(`Out of credits: a ${String(template.category || 'marketing').toLowerCase()} template uses ${credits.rateFor(template)}. Add credits on the Credits page.`, 402);
  let wamid;
  try { wamid = await sendTemplate(sender, template, wa, filled, db.settings.demoMode); } catch (e) { credits.refund(ch); throw e; }
  return recordOut(key, { type: 'template', templateId, templateName: template.name, values, wamid, ...(ch ? { credit: ch } : {}) });
}

// React to a customer's message with an emoji (or remove our reaction with an empty emoji). Like any free-form
// message it needs the 24-hour window. One reaction per message: a new one replaces ours.
app.post('/api/inbox/:key/react', wrap(async (req, res) => {
  const key = req.params.key;
  const { senderId, wa } = splitKey(key);
  const sender = db.senders.find((s) => s.id === senderId);
  if (!sender) throw fail('This WhatsApp number is no longer connected');
  const demo = db.settings.demoMode;
  if (!demo && !sender.accessToken) throw fail(`"${sender.label}" has no access token`);
  const target = String(req.body.wamid || '');
  const emoji = String(req.body.emoji || '').trim();
  if (emoji.length > 16 || /[\w\s]/.test(emoji)) throw fail('Pick one emoji');
  if (!db.messages.some((m) => m.key === key && m.dir === 'in' && m.wamid === target)) throw fail('Message not found', 404);
  const lastIn = db.messages.filter((m) => m.key === key && m.dir === 'in').at(-1);
  if (!lastIn || Date.now() - new Date(lastIn.ts) > WINDOW_MS) throw fail('The 24-hour reply window is closed, so reactions can’t be sent.');
  // Meta answers with a message id; its delivery updates (sent, delivered, read, failed) then arrive on the
  // webhook like any message's, so the Inbox can show whether the reaction got through.
  let wamid = 'wamid.DEMO' + id();
  if (!demo) {
    const r = await graph(sender, `${sender.phoneNumberId}/messages`, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: wa, type: 'reaction', reaction: { message_id: target, emoji } }) });
    wamid = r.messages?.[0]?.id || '';
  }
  if (emoji && (db.settings.readReceipts || 'open') !== 'off') sendReadReceipt(key); // reacting counts as replying
  db.messages = db.messages.filter((m) => !(m.key === key && m.dir === 'out' && m.type === 'reaction' && m.reaction?.to === target));
  if (emoji) {
    const msg = { id: id(), key, senderId, wa, dir: 'out', type: 'reaction', wamid, reaction: { emoji, to: target }, ts: new Date().toISOString(), status: 'sent', ...(demo ? { demo: true } : {}) };
    db.messages.push(msg);
    if (wamid) inboxIndex.set(wamid, msg);
    if (demo) setTimeout(() => { applyStatus(msg, { status: 'delivered' }); save(); broadcast({ kind: 'status', key }); }, 900);
  }
  save();
  broadcast({ kind: 'message', key, dir: 'out' });
  res.json({ ok: true, emoji });
}));

// Send a message that wasn't delivered again, as it was: a text (only inside the 24-hour window) or the
// same template with the same values. Works for Inbox messages and for campaign messages shown in the
// thread. The failed one is marked so it can't be sent again twice by accident.
app.post('/api/inbox/:key/resend', wrap(async (req, res) => {
  const key = req.params.key;
  const { senderId, wa } = splitKey(key);
  const msgId = String(req.body.id || '');
  let orig = db.messages.find((m) => m.id === msgId && m.key === key && m.dir === 'out');
  let mark = orig;
  if (!orig) {
    for (const c of db.campaigns) {
      const r = c.recipients.find((x) => x.phone === wa && x.senderId === senderId && (x.messageId || c.id + wa) === msgId);
      if (r) { orig = { type: 'template', templateId: c.templateId, values: r.values, status: r.status, resentAt: r.resentAt }; mark = r; break; }
    }
  }
  if (!orig) throw fail('Message not found', 404);
  if (orig.status !== 'failed') throw fail('This message was delivered, so there is nothing to send again');
  if (orig.resentAt) throw fail('This message was already sent again');
  let msg;
  if (orig.type === 'text') msg = await sendInboxText(key, orig.text, { replyTo: orig.context });
  else if (orig.type === 'template') msg = await sendInboxTemplate(key, orig.templateId, orig.values || {});
  else throw fail("This kind of message can't be sent again from here");
  mark.resentAt = new Date().toISOString();
  save();
  broadcast({ kind: 'status', key });
  res.json(msg);
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
  const contact = contactsApi.onInbound(wa, { name: chat.name, text, ts: msg.ts, senderId });
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
async function sendInboxText(key, text, { replyTo, auto = false, credit } = {}) {
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
  return recordOut(key, { type: 'text', text: body, wamid, context: replyTo || undefined, ...(auto ? { auto: true } : {}), ...(credit ? { credit } : {}) });
}

// ---------- Sending a photo, video, document or audio in the 24-hour window ----------
// What WhatsApp accepts as each kind, and how big (MB). Anything else, or anything sent "as a document", goes as a
// document (up to 100 MB): e.g. a GIF, HEIC or WAV, or a photo at full quality.
const OUT_MEDIA = {
  image: { types: ['image/jpeg', 'image/png'], mb: 5, label: 'Photos' },
  video: { types: ['video/mp4', 'video/3gpp'], mb: 16, label: 'Videos' },
  audio: { types: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'], mb: 16, label: 'Audio files' },
  document: { types: null, mb: 100, label: 'Documents' },
};
const MIME_ALIAS = { 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/mp3': 'audio/mpeg', 'audio/x-aac': 'audio/aac', 'image/jpg': 'image/jpeg', 'audio/opus': 'audio/ogg' };
function outKind(mime, asDocument) {
  if (asDocument) return 'document';
  return Object.keys(OUT_MEDIA).find((k) => OUT_MEDIA[k].types?.includes(mime)) || 'document';
}
// Put the file in WhatsApp's media store (multipart, so not through graph()'s JSON). Returns its media id.
async function uploadToMeta(sender, buf, mime, filename) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buf], { type: mime }), filename);
  const r = await fetch(`https://graph.facebook.com/${db.settings.graphVersion}/${sender.phoneNumberId}/media`, { method: 'POST', headers: { Authorization: `Bearer ${sender.accessToken}` }, body: form });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.error || !json.id) {
    const err = new Error(json.error?.code === 190 ? `Access token for "${sender.label}" is expired or invalid. Paste a new token under Numbers.` : `WhatsApp didn't accept the file: ${json.error?.error_user_msg || json.error?.message || `HTTP ${r.status}`}`);
    err.code = json.error?.code;
    throw err;
  }
  return String(json.id);
}
// Who and where a reply goes, if the 24-hour window is open (else a clear error).
function replyTarget(key) {
  const { senderId, wa } = splitKey(key);
  const sender = db.senders.find((s) => s.id === senderId);
  if (!sender) throw fail('This WhatsApp number is no longer connected');
  if (!/^\d{6,15}$/.test(wa)) throw fail('Invalid phone number');
  if (!db.settings.demoMode && !sender.accessToken) throw fail(`"${sender.label}" has no access token`);
  const lastIn = db.messages.filter((m) => m.key === key && m.dir === 'in').at(-1);
  if (!lastIn || Date.now() - new Date(lastIn.ts) > WINDOW_MS) throw fail('The 24-hour reply window is closed. Send a template to restart the conversation.');
  return { sender, wa };
}
// Upload a file to WhatsApp, send it, keep a copy (so the chat shows it at once) and record it. Demo mode only records.
async function sendOutMedia(key, { buf, mime, type, filename, caption = '', replyTo }) {
  const { sender, wa } = replyTarget(key);
  const demo = db.settings.demoMode;
  const mediaId = demo ? String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0') : await uploadToMeta(sender, buf, mime, filename);
  const dir = path.join(MEDIA_DIR, tenants.wsId());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, mediaId), buf);
  fs.writeFileSync(path.join(dir, mediaId) + '.json', JSON.stringify({ mime, ...(type === 'video' ? { audio: mp4HasAudio(buf) } : {}) }));
  const noCaption = type === 'audio' || type === 'sticker';
  let wamid;
  if (demo) wamid = 'wamid.DEMO' + id();
  else {
    const part = { id: mediaId };
    if (caption && !noCaption) part.caption = caption;
    if (type === 'document') part.filename = filename;
    const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: wa, type, [type]: part };
    if (replyTo) payload.context = { message_id: replyTo };
    wamid = (await graph(sender, `${sender.phoneNumberId}/messages`, { method: 'POST', body: JSON.stringify(payload) })).messages?.[0]?.id;
  }
  const media = { id: mediaId, mime, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('base64') };
  if (type === 'document') media.filename = filename;
  if (type === 'audio' && mime === 'audio/ogg') media.voice = true;
  if (type === 'sticker' && webpInfo(buf)?.animated) media.animated = true;
  return recordOut(key, { type, text: noCaption ? '' : caption, media, wamid, context: replyTo });
}
// A WebP's size and whether it's animated, from its header (RIFF....WEBP, then a VP8X, VP8L or VP8 chunk).
function webpInfo(buf) {
  if (buf.length < 30 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8X') return { animated: Boolean(buf[20] & 0x02), w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { animated: false, w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) }; }
  if (chunk === 'VP8 ') return { animated: false, w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  return null;
}
// WhatsApp's rules for a sticker: WebP, exactly 512×512, up to 100 KB (500 KB if animated).
function stickerProblem(buf) {
  const w = webpInfo(buf);
  if (!w) return 'Stickers have to be WebP pictures.';
  if (w.w !== 512 || w.h !== 512) return `Stickers have to be exactly 512×512 pixels; this one is ${w.w}×${w.h}.`;
  const max = w.animated ? 500 : 100;
  if (buf.length > max * 1024) return `${w.animated ? 'Animated stickers' : 'Stickers'} can be up to ${max} KB on WhatsApp; this one is ${Math.round(buf.length / 1024)} KB.`;
  return '';
}
app.post('/api/inbox/:key/media', express.raw({ type: () => true, limit: '100mb' }), wrap(async (req, res) => {
  const key = req.params.key;
  replyTarget(key); // before reading anything else: a closed window is the clearest reason to stop
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw fail('The file is empty');
  // The browser sends the bytes as octet-stream (so the JSON body parser never takes a .json file) and the real type here.
  const raw = String(req.get('X-File-Type') || req.get('content-type') || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  const mime = MIME_ALIAS[raw] || raw;
  const dec = (h) => { try { return decodeURIComponent(String(req.get(h) || '')); } catch { return ''; } };
  const filename = (dec('X-File-Name').replace(/[\\/\r\n"]/g, '_').slice(0, 200)) || 'file';
  const caption = dec('X-Caption').trim().slice(0, 1024);
  const replyTo = dec('X-Reply-To') || undefined;
  const sticker = req.get('X-As-Sticker') === '1';
  const type = sticker ? 'sticker' : outKind(mime, req.get('X-As-Document') === '1');
  if (sticker) {
    const bad = stickerProblem(buf);
    if (bad) throw fail(bad);
  } else {
    const rule = OUT_MEDIA[type];
    if (buf.length > rule.mb * 1024 * 1024) {
      throw fail(type === 'document'
        ? `WhatsApp sends files up to 100 MB. This one is ${(buf.length / 1048576).toFixed(1)} MB.`
        : `${rule.label} can be up to ${rule.mb} MB on WhatsApp. This one is ${(buf.length / 1048576).toFixed(1)} MB. Send it as a document instead (up to 100 MB), or make it smaller.`, 413);
    }
  }
  res.json(await sendOutMedia(key, { buf, mime: sticker ? 'image/webp' : mime, type, filename, caption, replyTo }));
}));

// The sticker tray: stickers sent or received in this workspace's chats, newest first, each sticker once.
app.get('/api/stickers', wrap((req, res) => {
  const seen = new Set(), stickers = [];
  for (let i = db.messages.length - 1; i >= 0 && stickers.length < 80; i--) {
    const m = db.messages[i];
    if (m.type !== 'sticker' || !m.media?.id) continue;
    const k = m.media.sha256 || m.media.id;
    if (seen.has(k)) continue;
    seen.add(k);
    stickers.push({ id: m.media.id, animated: Boolean(m.media.animated), dir: m.dir, ts: m.ts });
  }
  res.json({ stickers });
}));
// Send a sticker from the tray: its saved copy goes up to WhatsApp again (a received sticker's id can't be reused).
app.post('/api/inbox/:key/sticker', wrap(async (req, res) => {
  const key = req.params.key;
  replyTarget(key);
  const mid = String(req.body?.id || '');
  if (!db.messages.some((m) => m.type === 'sticker' && m.media?.id === mid)) throw fail('That sticker is no longer available', 404);
  const { file } = await ensureMedia(mid);
  const buf = fs.readFileSync(file);
  const bad = stickerProblem(buf);
  if (bad) throw fail(`This sticker can't be sent again: ${bad.charAt(0).toLowerCase() + bad.slice(1)}`);
  res.json(await sendOutMedia(key, { buf, mime: 'image/webp', type: 'sticker', filename: 'sticker.webp', replyTo: req.body?.replyTo || undefined }));
}));

// Store an outgoing Inbox message and tell open dashboards.
function recordOut(key, msg) {
  if ((db.settings.readReceipts || 'open') !== 'off') sendReadReceipt(key);
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
// Beside the file, a .json with its type (and, for a video, whether it has sound: see mp4HasAudio).
async function ensureMedia(mid) {
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
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, buf);
    fs.writeFileSync(file + '.json', JSON.stringify({ mime: info.mime_type, ...(/^video\//.test(info.mime_type || '') ? { audio: mp4HasAudio(buf) } : {}) }));
  }
  const meta = JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
  // Videos cached before we checked for sound: check once now.
  if (/^video\//.test(meta.mime || '') && meta.audio === undefined) {
    meta.audio = mp4HasAudio(fs.readFileSync(file));
    fs.writeFileSync(file + '.json', JSON.stringify(meta));
  }
  return { file, meta };
}
// WhatsApp sends a GIF as a short MP4 with no sound. An MP4 (or 3GP) lists its tracks in 'hdlr' boxes:
// 'hdlr', 4 bytes version/flags, 4 bytes pre_defined, then the handler type, which is 'soun' for a sound track.
function mp4HasAudio(buf) {
  for (let i = buf.indexOf('hdlr'); i !== -1; i = buf.indexOf('hdlr', i + 4)) {
    if (buf.toString('latin1', i + 12, i + 16) === 'soun') return true;
  }
  return false;
}
app.get('/api/media/:mid', wrap(async (req, res) => {
  const { file, meta } = await ensureMedia(req.params.mid);
  res.type(meta.mime || 'application/octet-stream');
  if (req.query.name) res.attachment(String(req.query.name));
  res.sendFile(file);
}));
// What the inbox needs to know before showing it: a video without sound is shown as a GIF.
app.get('/api/media/:mid/info', wrap(async (req, res) => {
  const { meta } = await ensureMedia(req.params.mid);
  const video = /^video\//.test(meta.mime || '');
  res.json({ mime: meta.mime || '', video, audio: video ? Boolean(meta.audio) : undefined, silent: video && meta.audio === false });
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
  const used = tenants.allWorkspaces().some(({ db: w }) => w.campaigns.some((c) => JSON.stringify(c.recipients).includes(name)) || w.messages.some((m) => JSON.stringify(m.values || {}).includes(name)) || w.templates.some((t) => String(t.headerSample || '').includes(name)));
  if (!used) fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
  res.json({ ok: true, deleted: !used });
}));

// --- Dashboard stats ----------------------------------------------------------

const dayKey = (d) => new Date(d).toLocaleDateString('en-CA'); // YYYY-MM-DD in server's local time

function computeStats(query = {}) {
  // Only count campaigns from the current mode, so demo runs never inflate live numbers.
  const demo = db.settings.demoMode;
  // A custom period (from–to, any days up to a year, in order) or the last 7 / 14 / 30 / 90 days
  const KEY = /^\d{4}-\d{2}-\d{2}$/;
  let custom = null;
  if (KEY.test(query.from || '') && KEY.test(query.to || '')) {
    const [a, b] = [query.from, query.to].sort();
    const span = Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000) + 1;
    if (span >= 1 && span <= 366) custom = { from: a, to: b };
  }
  const range = custom ? Math.round((new Date(custom.to + 'T12:00:00') - new Date(custom.from + 'T12:00:00')) / 86400000) + 1
    : [7, 14, 30, 90].includes(Number(query.range)) ? Number(query.range) : 14;
  const senderF = query.sender || '';
  const templateF = query.template || '';
  const scope = query.scope || null; // numbers a limited member may see
  const inScope = (id) => !scope || scope.has(id);
  const all = db.campaigns.filter((c) => Boolean(c.demo) === demo && c.senderIds.some(inScope));
  const camps = all.filter((c) => (!templateF || c.templateName === templateF) && (!senderF || c.senderIds.includes(senderF)));
  // Test campaigns stay out of the numbers unless asked for (tests=1). They're still listed (recent, upcoming), and
  // Number health always counts them: Meta's limits and quality see every message.
  const withTests = query.tests === '1' || query.tests === true;
  const counted = withTests ? camps : camps.filter((c) => !c.test);

  // Daily buckets for the range, plus the previous period of the same length for comparisons.
  const days = [];
  for (let i = range - 1; i >= 0; i--) {
    const d = custom ? new Date(custom.to + 'T12:00:00') : new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push({ date: dayKey(d), sent: 0, delivered: 0, read: 0, failed: 0, reasons: {} });
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
  for (const s of db.senders.filter((x) => inScope(x.id))) perSender[s.id] = { today: 0, sent: 0, delivered: 0, read: 0, failed: 0 };

  const add = (bucket, r) => {
    const ok = r.status === 'sent' || r.status === 'delivered' || r.status === 'read';
    if (ok) bucket.sent++;
    if (r.status === 'delivered' || r.status === 'read') bucket.delivered++;
    if (r.status === 'read') bucket.read++;
    if (r.status === 'failed') {
      bucket.failed++;
      // by reason (Meta's error code, or the message when there is none), for the Overview's Failed chart
      const why = errorCodeOf(r.error) || (/not on whatsapp/i.test(r.error || '') ? '131026' : 'other');
      if (bucket.reasons) bucket.reasons[why] = (bucket.reasons[why] || 0) + 1;
    }
  };

  for (const c of counted) {
    for (const r of c.recipients) {
      if ((senderF && r.senderId !== senderF) || !inScope(r.senderId)) continue;
      // "Waiting to send" is only what will still go out: scheduled or sending campaigns. A stopped or cancelled one
      // keeps its unsent people as pending, but they won't be sent, so they don't count.
      if (r.status === 'pending' || r.status === 'queued') { if (c.status === 'scheduled' || c.status === 'running') totals.pending++; continue; }
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

  // Meta's limit counts unique people messaged outside the service window in a rolling 24h, shared by every number
  // in the business portfolio. Numbers on the same WhatsApp Business Account are in the same portfolio, so usage is
  // pooled per account. Every template send is counted, which can overcount a little (a template sent while the
  // customer's window is open doesn't count at Meta).
  const group = (s) => s.wabaId || s.id;
  const since = Date.now() - 86400000;
  const people = {};
  const count = (senderId, phone, ts) => {
    const s = db.senders.find((x) => x.id === senderId);
    if (!s || !phone || !ts || Date.parse(ts) < since) return;
    (people[group(s)] ||= new Set()).add(String(phone).replace(/\D/g, ''));
  };
  for (const c of all) for (const r of c.recipients) count(r.senderId, r.phone, r.sentAt);
  for (const m of db.messages) if (m.dir === 'out' && m.type === 'template' && Boolean(m.demo) === demo) count(m.senderId, m.wa, m.ts);
  const shared = (s) => db.senders.filter((x) => group(x) === group(s)).length;

  const senders = db.senders.filter((s) => inScope(s.id)).map((s) => ({
    id: s.id,
    label: s.label,
    displayPhone: s.displayPhone,
    enabled: s.enabled,
    qualityRating: s.qualityRating || null,
    limit: tierLimit(s.messagingLimit),
    limitUsed: people[group(s)]?.size || 0,
    limitShared: shared(s),
    limitCheckedAt: s.limitCheckedAt || null,
    ...perSender[s.id],
  }));
  const meta = tenants.meta();
  const cap = meta?.dailyLimit == null || demo ? null : { limit: meta.dailyLimit, used: sentLast24h() };

  return {
    demo,
    cap,
    range,
    filters: { sender: senderF, template: templateF, tests: withTests },
    custom,
    tests: camps.filter((c) => c.test).length,
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

// Meta's limit changes as quality and volume change, so it's re-read when the dashboard loads and it's over 6h old.
const LIMIT_REFRESH_MS = 6 * 3600 * 1000;
app.get('/api/stats', wrap(async (req, res) => {
  req.query.scope = req.senderScope; // a member limited to some numbers sees stats for those only
  if (!db.settings.demoMode) {
    const stale = db.senders.filter((s) => s.accessToken && !(Date.parse(s.limitCheckedAt) > Date.now() - LIMIT_REFRESH_MS));
    // the display name and number status too: every 6h, or every 15 min while a name is waiting on Meta
    const ago = (t) => Date.now() - (Date.parse(t) || 0);
    const statusStale = db.senders.filter((s) => s.accessToken && (ago(s.statusCheckedAt) > LIMIT_REFRESH_MS || ((s.nameStatus === 'PENDING_REVIEW' || s.newNameStatus === 'PENDING_REVIEW') && ago(s.statusCheckedAt) > 15 * 60000)));
    if (stale.length || statusStale.length) {
      await Promise.all([
        ...stale.map(async (s) => { s.messagingLimit = await readMessagingLimit(s, s.phoneNumberId) || s.messagingLimit || ''; s.limitCheckedAt = new Date().toISOString(); }),
        ...statusStale.map(async (s) => applyNumberStatus(s, await readNumberStatus(s, s.phoneNumberId))),
      ]);
      save();
    }
  }
  res.json(computeStats(req.query));
}));

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
    { label: 'Sales line 1', displayPhone: '+91 98200 11001', messagingLimit: 'TIER_2K', qualityRating: 'GREEN' },
    { label: 'Sales line 2', displayPhone: '+91 98200 11002', messagingLimit: 'TIER_2K', qualityRating: 'GREEN' },
    { label: 'Support', displayPhone: '+91 98200 11003', messagingLimit: 'TIER_2K', qualityRating: 'YELLOW' },
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
credits = require('./credits').mount(app, { db, save, id, wrap, fail, meta: tenants.meta, notes });
// Credits paid for before sign-up (admin → People) are added through the same path as the admin's "Add credits".
// Either way, the workspace's open pages are told straight away, so the balance rolls up without a reload.
const creditsChanged = (wsId) => broadcastTo(wsId, { kind: 'changed', area: 'credits', tab: '' });
tenants.setCreditAdder((ws, pack) => { tenants.forWorkspace(ws, () => credits.addPack(pack)); creditsChanged(ws.meta.id); });
// Admins: a workspace's credits, and adding a pack after the customer has paid.
const adminWs = (req) => {
  if (!req.admin) throw fail('Admins only', 403);
  const ws = tenants.allWorkspaces().find((w) => w.meta.id === req.params.id);
  if (!ws) throw fail('Workspace not found', 404);
  return ws;
};
// Taking credits back: { packId } for what's left in one pack, or { credits, packId? }, with a note.
app.post('/api/admin/workspaces/:id/credits/remove', wrap((req, res) => {
  const ws = adminWs(req);
  const summary = tenants.forWorkspace(ws, () => { credits.removeCredits({ ...req.body, by: req.user.email }); return credits.summary(); });
  creditsChanged(ws.meta.id);
  res.json(summary);
}));
app.get('/api/admin/workspaces/:id/credits', wrap((req, res) => { const ws = adminWs(req); res.json(tenants.forWorkspace(ws, () => credits.summary())); }));
app.post('/api/admin/workspaces/:id/credits', wrap((req, res) => {
  const ws = adminWs(req);
  const summary = tenants.forWorkspace(ws, () => { credits.addPack({ ...req.body, by: req.user.email }); return credits.summary(); });
  creditsChanged(ws.meta.id);
  res.json(summary);
}));
const contactsApi = require('./contacts')(app, { db, save, id, wrap, fail, normalizePhone, phoneInputError, broadcast });
// Templates saved before their dates were kept: created = when it was sent to Meta from here, approved = the
// latest "was approved" notification about it. Templates made in WhatsApp Manager have neither until they change.
for (const ws of tenants.allWorkspaces()) tenants.forWorkspace(ws, () => {
  let n = 0;
  for (const t of db.templates) {
    if (!t.createdAt && t.submittedAt) { t.createdAt = t.submittedAt; n++; }
    if (!t.approvedAt && String(t.status).toUpperCase() === 'APPROVED') {
      const note = (db.notifications || []).filter((x) => x.kind === 'template_approved' && x.link?.id === t.id && / was approved$/.test(x.title)).sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0];
      if (note) { t.approvedAt = note.ts; n++; }
    }
  }
  if (n) save();
});
// Campaigns saved by older versions, brought in line with today's (each step only touches what's still old, so it's
// safe on every start):
// · auto names "template — 11/5/2026, 5:52:18 AM" were the server's UTC time in US order: now "— 05/11/2026, 11:22 am"
//   in India's time (when it was created)
// · "Why it stopped" blamed the list when the failures were the number's or template's (e.g. 131037): now names that
// · "took" counted the hours it sat stopped between runs: now estimated from when its messages actually went out
for (const ws of tenants.allWorkspaces()) tenants.forWorkspace(ws, () => {
  let n = 0;
  const OLD_STAMP = /^(.*) — \d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}[\s ]?(AM|PM)$/;
  for (const c of db.campaigns) {
    const m = String(c.name || '').match(OLD_STAMP);
    if (m && Date.parse(c.createdAt)) { c.name = `${m[1]} — ${localStamp(-330, new Date(c.createdAt))}`; n++; }
    if (/^Paused automatically: .*couldn't receive them/.test(c.pausedReason || '')) {
      const counts = {};
      for (const r of c.recipients) { const k = accountProblem(r); if (k) counts[k] = (counts[k] || 0) + 1; }
      const acct = Object.values(counts).reduce((a, b) => a + b, 0);
      if (acct && acct >= listFailures(c)) {
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
        c.pausedReason = `Paused automatically: Meta rejected ${acct} messages (error ${top}) because ${ACCOUNT_PROBLEMS[top]}. Every message will fail until that's fixed; then press Resume. Your contacts are fine.`;
        n++;
      }
    }
    if (c.finishedAt && c.activeMs == null && !c.seed) {
      // the stretches with messages going out, with gaps of over 5 minutes (stopped, waiting) left out
      const ts = c.recipients.map((r) => Date.parse(r.sentAt || r.failedAt)).filter(Boolean).sort((a, b) => a - b);
      if (ts.length) {
        let ms = 0;
        for (let i = 1; i < ts.length; i++) { const gap = ts[i] - ts[i - 1]; if (gap < 5 * 60000) ms += gap; }
        c.activeMs = Math.max(1000, ms);
        n++;
      }
    }
  }
  if (n) save();
});
// What's new (once per workspace): Send moved into Campaigns. Opening it shows the same window as on first load, so
// anyone who closed that can read it again.
for (const ws of tenants.allWorkspaces()) tenants.forWorkspace(ws, () => {
  if (db.settings.whatsNewCampaigns) return;
  notes.add({ kind: 'whats_new', title: 'What’s new: Send now lives in Campaigns', body: 'Every send starts as a campaign now: its name, template, numbers and AI replies first, then the people. Open this to see how it works.', link: { tab: 'campaigns', whatsNew: 'campaign-flow' } });
  db.settings.whatsNewCampaigns = true;
  save();
});
// Everyone from campaigns sent before campaign contacts existed (once per workspace).
for (const ws of tenants.allWorkspaces()) tenants.forWorkspace(ws, () => {
  const n = contactsApi.contactsFromPastCampaigns();
  if (n) console.log(`Contacts in ${ws.meta.name}: ${n} added from past campaigns.`);
});
// Clean numbers saved by older versions with today's rules; ones that still aren't valid are flagged in Contacts.
for (const ws of tenants.allWorkspaces()) tenants.forWorkspace(ws, () => {
  const r = contactsApi.recheckPhones();
  if (r.fixed || r.flagged) console.log(`Contacts in ${ws.meta.name}: ${r.fixed} number(s) cleaned, ${r.flagged} newly flagged (${r.problems} need fixing).`);
});
const leadApi = require('./lead')(app, { db, save, id, wrap, fail, aiConfig, aiAllowed: tenants.aiAllowed, broadcast, contacts: contactsApi, notes, credits, sendText: (key, text, opts) => sendInboxText(key, text, opts) });

// --- AI assistant -------------------------------------------------------------

require('./ai')(app, { db, save, id, wsId: tenants.wsId, wrap, fail, aiConfig, credits, contacts: contactsApi, normalizePhone, templateVariables, createCampaign, computeStats, summary, publicSender });

// --- Meta Graph API version: kept current for every workspace ---------------------------------
// Meta retires each version about two years after release, and then every request fails. Every workspace below
// GRAPH_RECOMMENDED is moved up to it when the server starts and once a day, so raising this constant (and
// deploying) upgrades everyone. Admins can also move all workspaces to any version from the admin panel.
// Dates from Meta for Developers (Nov 2026).
const GRAPH_RECOMMENDED = 'v25.0';
const GRAPH_RETIRES = { 'v21.0': '2027-01-21', 'v22.0': '2027-05-20', 'v23.0': '2027-10-08', 'v24.0': '2028-02-18', 'v25.0': '2028-07-29' };
const graphNum = (v) => Number(String(v || '').replace(/^v/, '')) || 0;
function upgradeGraphVersions(to = GRAPH_RECOMMENDED, { force = false } = {}) {
  const moved = [];
  for (const ws of tenants.allWorkspaces()) tenants.forWorkspace(ws, () => {
    const was = db.settings.graphVersion;
    if (was === to || (!force && graphNum(was) >= graphNum(to))) return;
    db.settings.graphVersion = to;
    save();
    moved.push({ name: ws.meta.name, from: was || '(none)' });
  });
  if (moved.length) console.log(`Meta API version: moved ${moved.length} workspace(s) to ${to}: ${moved.map((m) => `${m.name} (was ${m.from})`).join(', ')}`);
  return moved;
}
upgradeGraphVersions();
setInterval(() => upgradeGraphVersions(), 24 * 3600 * 1000);

// Admin: every workspace's version, and moving them all to one (e.g. a newer release before the app is updated).
app.get('/api/admin/graph-version', (req, res) => {
  if (!req.admin) return res.status(403).json({ error: 'Admins only' });
  const list = tenants.allWorkspaces().map((ws) => ({ id: ws.meta.id, name: ws.meta.name, version: ws.db.settings.graphVersion || '', retires: GRAPH_RETIRES[ws.db.settings.graphVersion] || null }));
  res.json({ recommended: GRAPH_RECOMMENDED, retires: GRAPH_RETIRES, workspaces: list });
});
app.post('/api/admin/graph-version', wrap((req, res) => {
  if (!req.admin) throw fail('Admins only', 403);
  const to = String(req.body.version || '').trim();
  if (!/^v\d{2,3}\.0$/.test(to)) throw fail('Write the version like v25.0');
  if (graphNum(to) < graphNum(GRAPH_RECOMMENDED) && !req.body.confirmOlder) throw fail(`${to} is older than the recommended ${GRAPH_RECOMMENDED}. Pick ${GRAPH_RECOMMENDED} or newer.`);
  res.json({ moved: upgradeGraphVersions(to, { force: true }) });
}));

app.listen(PORT, () => {
  console.log(`SendON running at http://localhost:${PORT}`);
  console.log(`${tenants.allWorkspaces().length} workspace(s). Sign up or sign in at /login.`);
  console.log(tenants.adminCount ? `Admin panel: ${tenants.adminCount} admin email(s) from ADMIN_EMAILS.` : 'Admin panel: off (ADMIN_EMAILS is not set).');
});
// Write pending changes before the process stops (deploys restart it).
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  tenants.flush().catch((e) => console.error('Saving on shutdown failed:', e.message)).finally(() => process.exit(0));
});
