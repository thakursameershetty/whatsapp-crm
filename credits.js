// Pricing is switched off until PRICING=on is set on the server: until then nothing below applies (no charges, no number
// limits, no credits shown), while workspaces' plans and any credits added are kept for when it's switched on.
const LIVE = /^(on|true|1|yes)$/i.test(String(process.env.PRICING || '').trim());

// Credits: what SendON charges for. They're on top of Meta's own per-message fees, which Meta bills to each
// customer's WhatsApp Business Account directly.
//
// A workspace on the credits plan (an admin switches it on; workspaces made before credits stay free) buys packs, and an
// admin adds them after payment. Each pack lasts 12 months. Work takes credits from the pack that expires first:
//   - a template message: 2 for a marketing template, 1 for utility or authentication; a message that fails gives
//     its credits back (Meta doesn't charge for those either), so a retry never costs twice;
//   - WhatsApp numbers: the biggest pack a workspace has (unexpired) sets how many it may connect: the ₹10,000 pack 1,
//     the ₹20,000 pack 3, the ₹25,000 pack no limit; before any pack, 1 (to set up before buying);
//   - AI, on our key or the workspace's own: 1 for each Assistant answer, each reply the
//     AI sends by itself, and each AI-written reply a person sends unchanged; an Assistant answer that builds a campaign
//     plan (it reads the file, the templates and the numbers, and checks every row) is PLAN_RATE instead. Approving the
//     plan doesn't use AI, so it's only the messages' own credits. Drafts are free; a notes summary is 1.
// Replies typed by a person in the Inbox are free. Demo mode never uses credits.
//
// The log (db.credits.ledger) keeps one running line per thing (a campaign, a day of Inbox templates, a day of AI
// replies), not one per message, so it stays short.

const PACKS = {
  '10k': { name: '₹10,000 pack', price: 10000, credits: 10000, numbers: 1 },
  '20k': { name: '₹20,000 pack', price: 20000, credits: 22000, numbers: 3 },
  '25k': { name: '₹25,000 pack', price: 25000, credits: 30000, numbers: null }, // null: no limit
};
const RATES = { MARKETING: 2, UTILITY: 1, AUTHENTICATION: 1 };
const AI_RATE = 1;
const PLAN_RATE = 3; // an Assistant answer that prepares a campaign plan
// Numbers allowed by the biggest unexpired pack (custom packs count by their size): [at least this many credits, numbers].
const NUMBER_TIERS = [[30000, null], [22000, 3], [0, 1]];
const PACK_MONTHS = 12;
const LEDGER_MAX = 500;

const valid = (p, now = Date.now()) => Date.parse(p.expiresAt) > now;
// The balance of any workspace's data (used by the admin list, which reads every workspace).
const balanceOf = (d) => (d?.credits?.packs || []).filter((p) => p.left > 0 && valid(p)).reduce((s, p) => s + p.left, 0);
// What a template message costs: marketing (and anything unknown) 2, utility and authentication 1.
const rateFor = (template) => RATES[String(template?.category || '').toUpperCase()] ?? RATES.MARKETING;

function mount(app, { db, save, id, wrap, fail, meta, notes }) {
  const day = () => new Date().toISOString().slice(0, 10);
  const book = () => (db.credits ||= { packs: [], ledger: [] });
  // Charged in this workspace? The credits plan, and not demo mode (or a demo campaign).
  const on = (demo = db.settings.demoMode) => LIVE && meta()?.billing === 'credits' && !demo;
  const live = () => book().packs.filter((p) => p.left > 0 && valid(p)).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  const balance = () => live().reduce((s, p) => s + p.left, 0);
  // Enough for `n`? Always yes when this workspace isn't charged.
  const enough = (n, demo) => !on(demo) || balance() >= n;
  // How many WhatsApp numbers this workspace may connect (null: no limit, and always on the free plan or in demo mode).
  const numberLimit = () => {
    if (!on()) return null;
    const best = Math.max(0, ...book().packs.filter((p) => valid(p)).map((p) => p.credits));
    return NUMBER_TIERS.find(([min]) => best >= min)[1];
  };
  const numbersUsed = () => db.senders.filter((s) => !s.seed).length;

  function line(key, what, kind = 'use') {
    const b = book();
    let l = b.ledger.find((x) => x.key === key);
    if (!l) {
      l = { id: id(), key, kind, what, used: 0, refunded: 0, count: 0, at: new Date().toISOString() };
      b.ledger.unshift(l);
      if (b.ledger.length > LEDGER_MAX) b.ledger.length = LEDGER_MAX;
    }
    l.what = what;
    l.at = new Date().toISOString();
    return l;
  }

  // Packs whose year ran out with credits left: noted once in the log.
  function sweep() {
    for (const p of book().packs) {
      if (p.left > 0 && !valid(p) && !p.expiredNoted) {
        p.expiredNoted = true;
        const l = line('expire:' + p.id, `${p.name} expired`, 'expire');
        l.used = p.left;
      }
    }
  }

  // Take `n` credits for one thing. Returns the charge to keep with it ({ n, packs, key }), null when this workspace
  // isn't charged (go ahead, nothing taken), or false when there aren't enough (nothing taken).
  function charge(n, { key, what, demo } = {}) {
    if (!on(demo) || !n) return null;
    sweep();
    if (balance() < n) {
      notes?.add({ kind: 'credits_out', group: 'credits_out', title: 'You’re out of credits', body: 'Messages and AI replies that use credits are on hold. Add credits to carry on.', link: { tab: 'settings' } });
      return false;
    }
    const taken = [];
    let need = n;
    for (const p of live()) {
      const k = Math.min(p.left, need);
      p.left -= k;
      need -= k;
      taken.push([p.id, k]);
      if (!need) break;
    }
    const l = line(key, what);
    l.used += n;
    l.count += 1;
    warnIfLow();
    save();
    return { n, packs: taken, key };
  }

  // Give a charge back (a message that failed, an AI reply that couldn't be sent). Credits from a pack that has expired
  // since are gone, like the rest of that pack.
  function refund(ch) {
    if (!ch || ch.refunded) return;
    ch.refunded = true;
    const packs = book().packs;
    for (const [pid, k] of ch.packs || []) {
      const p = packs.find((x) => x.id === pid);
      if (p && valid(p)) p.left += k;
    }
    const l = book().ledger.find((x) => x.key === ch.key);
    if (l) l.refunded += ch.n;
    save();
  }

  // Running low: below 10% of the last pack added (at least 500 credits). One notice until the next top-up.
  function warnIfLow() {
    const b = book(), last = b.packs.at(-1);
    const at = Math.max(500, Math.round((last?.credits || 0) * 0.1));
    const bal = balance();
    if (bal < at && !b.lowWarned) {
      b.lowWarned = true;
      notes?.add({ kind: 'credits_low', group: 'credits_low', title: `Credits running low: ${bal.toLocaleString('en-IN')} left`, body: 'Add a pack so campaigns and AI replies don’t stop. Settings → Credits.', link: { tab: 'settings' } });
    }
  }

  // An admin adds a pack after payment: one of PACKS, or a custom number of credits.
  function addPack({ pack, credits, price, note, by }) {
    const preset = PACKS[pack];
    const n = preset ? preset.credits : Math.floor(Number(credits));
    if (!Number.isFinite(n) || n < 1 || n > 10_000_000) throw fail('Enter how many credits to add');
    const rupees = preset ? preset.price : Math.max(0, Math.floor(Number(price) || 0));
    const added = new Date(), expires = new Date(added);
    expires.setMonth(expires.getMonth() + PACK_MONTHS);
    const p = { id: id(), name: preset ? preset.name : `${n.toLocaleString('en-IN')} credits`, credits: n, left: n, price: rupees, note: String(note || '').slice(0, 200), by: by || '', addedAt: added.toISOString(), expiresAt: expires.toISOString() };
    const b = book();
    b.packs.push(p);
    b.lowWarned = false;
    const l = line('add:' + p.id, `${p.name} added`, 'add');
    l.used = n;
    save();
    return p;
  }

  // What the Settings page shows.
  function summary() {
    sweep();
    const b = book();
    return {
      on: LIVE && meta()?.billing === 'credits',
      live: LIVE,
      demo: Boolean(db.settings.demoMode),
      balance: balance(),
      packs: b.packs.slice().reverse().slice(0, 20).map(({ id: pid, name, credits, left, price, addedAt, expiresAt }) => ({ id: pid, name, credits, left, price, addedAt, expiresAt, expired: !valid({ expiresAt }) })),
      ledger: b.ledger.slice(0, 60).map(({ id: lid, kind, what, used, refunded, count, at }) => ({ id: lid, kind, what, used, refunded, count, at })),
      rates: { marketing: RATES.MARKETING, utility: RATES.UTILITY, authentication: RATES.AUTHENTICATION, ai: AI_RATE, plan: PLAN_RATE },
      packOptions: Object.entries(PACKS).map(([k, v]) => ({ id: k, ...v })),
      months: PACK_MONTHS,
      numberLimit: numberLimit(),
      numbersUsed: numbersUsed(),
    };
  }

  app.get('/api/credits', (req, res) => res.json(summary()));

  // Ledger keys for the things that use credits, so each gets one running line.
  const keys = {
    campaign: (c) => ({ key: 'c:' + c.id, what: `Campaign “${c.name}”`, demo: c.demo }),
    inboxTemplate: () => ({ key: 'it:' + day(), what: `Inbox templates, ${day()}` }),
    aiReply: () => ({ key: 'ai:' + day(), what: `AI replies, ${day()}` }),
    assistant: () => ({ key: 'as:' + day(), what: `Assistant answers, ${day()}` }),
    assistantPlan: () => ({ key: 'ap:' + day(), what: `Assistant campaign plans, ${day()}` }),
  };

  // Adding a number past the plan's limit: why not, and which pack allows more.
  function checkNumberLimit() {
    const lim = numberLimit();
    if (lim == null || numbersUsed() < lim) return;
    const more = lim < 3 ? 'The ₹20,000 pack includes 3 numbers, and the ₹25,000 pack has no limit.' : 'The ₹25,000 pack has no number limit.';
    throw fail(`Your credits include ${lim} WhatsApp number${lim === 1 ? '' : 's'}, and this workspace has ${numbersUsed()}. ${more} Settings → Credits.`, 402);
  }

  return { on, enough, balance, charge, refund, addPack, summary, keys, rateFor, AI_RATE, PLAN_RATE, numberLimit, checkNumberLimit };
}

module.exports = { mount, balanceOf, rateFor, PACKS, RATES, AI_RATE, PLAN_RATE, LIVE };
