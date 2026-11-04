// Contacts and tags: an address book of everyone you message, keyed by phone number.
// People who write to you in the Inbox are added automatically; the Inbox lead
// assistant fills in what it learns (need, budget, timeline, status). Contacts can be
// imported from spreadsheets (merged by phone), exported, tagged, and sent to by tag.
// Opted-out contacts are never sent to.

const STATUSES = ['new', 'interested', 'qualified', 'won', 'lost'];
const TAG_COLORS = ['blue', 'green', 'violet', 'orange', 'teal', 'pink', 'gray'];
const STOP_RE = /^\s*(stop|stop all|unsubscribe|opt[ -]?out|cancel|remove me)\s*[.!]*\s*$/i;

module.exports = function mountContacts(app, ctx) {
  const { db, save, id, wrap, fail, normalizePhone, phoneInputError, broadcast } = ctx;
  db.contacts ||= [];
  db.tags ||= [];

  const byPhone = (phone) => db.contacts.find((c) => c.phone === phone);
  const now = () => new Date().toISOString();
  const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);

  function tagIds(list = []) {
    const ok = new Set(db.tags.map((t) => t.id));
    return [...new Set(list)].filter((t) => ok.has(t));
  }

  // Names → tag ids, creating tags that don't exist yet.
  function ensureTags(names = []) {
    const out = [];
    for (const raw of names) {
      const name = clean(raw, 40);
      if (!name) continue;
      let t = db.tags.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!t) {
        t = { id: id(), name, color: TAG_COLORS[db.tags.length % TAG_COLORS.length], createdAt: now() };
        db.tags.push(t);
      }
      out.push(t.id);
    }
    return out;
  }

  // Merge fields into the contact with this phone, creating it if needed. Blank values never
  // overwrite saved ones, so an import with an empty "email" column keeps the email you had.
  function upsert(phone, fields = {}, { source = 'manual', addTags = [] } = {}) {
    let c = byPhone(phone);
    const created = !c;
    if (!c) {
      c = { id: id(), phone, name: '', email: '', company: '', tags: [], status: 'new', optOut: false, notes: '', lead: {}, extra: {}, source, createdAt: now() };
      db.contacts.push(c);
    }
    for (const k of ['name', 'email', 'company', 'notes']) if (clean(fields[k], k === 'notes' ? 4000 : 200)) c[k] = clean(fields[k], k === 'notes' ? 4000 : 200);
    if (fields.extra) for (const [k, v] of Object.entries(fields.extra)) if (clean(v)) c.extra[clean(k, 60)] = clean(v, 500);
    if (STATUSES.includes(fields.status)) c.status = fields.status;
    if (typeof fields.optOut === 'boolean') c.optOut = fields.optOut;
    if (addTags.length) c.tags = [...new Set([...c.tags, ...tagIds(addTags)])];
    c.updatedAt = now();
    return { contact: c, created };
  }

  const isOptedOut = (phone) => Boolean(byPhone(phone)?.optOut);

  // Everyone a campaign messages is in Contacts, delivered or not. Each contact keeps every campaign that messaged
  // them and how it went: contact.campaigns = [{ id, name, status: sent | delivered | read | failed, at, senderId,
  // error? }] (newest last), and contact.delivery = the latest one. contact.via: the number that first brought them in
  // (a campaign's sender, or the number they first wrote to). A contact you already have keeps its name and details;
  // demo campaigns don't add anyone.
  const DELIVERY_AT = (r) => r.readAt || r.deliveredAt || r.failedAt || r.sentAt || '';
  function noteDelivery(c, r) {
    if (!c || c.demo || !r?.phone || !['sent', 'delivered', 'read', 'failed'].includes(r.status)) return;
    const had = byPhone(r.phone);
    const { contact, created } = upsert(r.phone, had?.name ? {} : { name: r.name || '' }, { source: 'campaign' });
    if (created && r.senderId) contact.via = r.senderId;
    const at = DELIVERY_AT(r) || now();
    const entry = { id: c.id, name: String(c.name || '').slice(0, 120), status: r.status, at, ...(r.senderId ? { senderId: r.senderId } : {}), ...(r.status === 'failed' && r.error ? { error: String(r.error).slice(0, 300) } : {}) };
    const list = (contact.campaigns ||= []);
    const i = list.findIndex((x) => x.id === c.id);
    if (i >= 0) list[i] = entry; else list.push(entry);
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (list.length > 200) list.splice(0, list.length - 200);
    const last = list[list.length - 1];
    contact.delivery = { status: last.status, at: last.at, campaignId: last.id, campaign: last.name, ...(last.error ? { error: last.error } : {}) };
  }
  // Once per workspace: every campaign sent before this existed (oldest first), and the number that brought in each
  // contact added before numbers were recorded (their first campaign message or first chat, whichever came first).
  function contactsFromPastCampaigns() {
    if (db.settings.campaignContactsV2) return 0;
    const before = db.contacts.length;
    for (const c of [...(db.campaigns || [])].filter((x) => !x.demo).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
      for (const r of c.recipients || []) noteDelivery(c, r);
    }
    const first = new Map(); // phone → { senderId, at }
    const seen = (phone, senderId, at) => { if (!phone || !senderId) return; const f = first.get(phone); if (!f || String(at) < String(f.at)) first.set(phone, { senderId, at }); };
    for (const c of db.campaigns || []) if (!c.demo) for (const r of c.recipients || []) if (r.sentAt || r.failedAt) seen(r.phone, r.senderId, r.sentAt || r.failedAt);
    for (const m of db.messages || []) if (m.dir === 'in' && !m.demo) seen(normalizePhone(m.wa) || m.wa, m.senderId, m.ts);
    for (const c of db.contacts) if (!c.via && ['campaign', 'inbox'].includes(c.source) && first.has(c.phone)) c.via = first.get(c.phone).senderId;
    db.settings.campaignContactsV2 = true;
    save();
    return db.contacts.length - before;
  }

  // Numbers saved by older versions (which allowed 8–9 digits, without a country code) are cleaned again with
  // today's rules. One that still isn't a valid number, or that now matches another contact, is kept as it is and
  // marked with `phoneProblem` so it shows up in Contacts to fix; nothing is deleted or merged. Safe to run on every start.
  function recheckPhones() {
    let fixed = 0, flagged = 0;
    for (const c of db.contacts || []) {
      const p = normalizePhone(c.phone);
      let problem = '';
      if (!p) problem = 'This number is too short or too long for WhatsApp. Add the country code or correct it.';
      else if (p !== c.phone && byPhone(p)) problem = `Another contact already has +${p}. Check which one is right.`;
      else if (p !== c.phone) { c.phone = p; c.updatedAt = now(); fixed++; }
      if (problem) { if (c.phoneProblem !== problem) { c.phoneProblem = problem; flagged++; } }
      else if (c.phoneProblem) delete c.phoneProblem;
    }
    if (fixed || flagged) save();
    return { fixed, flagged, problems: (db.contacts || []).filter((c) => c.phoneProblem).length };
  }

  // Someone messaged one of our numbers: make sure they're in Contacts, and honour STOP at once.
  function onInbound(wa, { name, text, ts, senderId } = {}) {
    const phone = normalizePhone(wa) || wa;
    const { contact, created } = upsert(phone, { name }, { source: 'inbox' });
    if (created && senderId) contact.via = senderId;
    contact.lastMessageAt = ts || now();
    if (text && STOP_RE.test(text)) {
      contact.optOut = true;
      contact.status = 'lost';
      contact.optOutAt = now();
    }
    return contact;
  }

  // What the lead assistant learned about this person.
  function applyLead(phone, lead = {}, { stage = true } = {}) {
    const { contact } = upsert(phone, { name: lead.name, email: lead.email, company: lead.company }, { source: 'inbox' });
    const status = { not_interested: 'lost' }[lead.status] || lead.status;
    // The assistant's own view of the stage, kept even when a person has set it, so "Let the AI decide" can go back to it.
    if (STATUSES.includes(status) && status !== 'won') contact.aiStatus = status;
    if (!stage) { contact.updatedAt = now(); return contact; }
    // A human's "won" stands; the assistant can move a lead along but not undo that. And once a person has set the
    // stage (any stage, from the Inbox or Contacts), it stands: the assistant keeps its notes up to date but can't
    // move it until "Let the AI decide" hands it back.
    if (STATUSES.includes(status) && status !== 'won' && contact.status !== 'won' && !contact.leadLock) contact.status = status;
    contact.lead = {
      ...contact.lead,
      ...Object.fromEntries(['summary', 'need', 'budget', 'timeline'].filter((k) => clean(lead[k])).map((k) => [k, clean(lead[k], 600)])),
      updatedAt: now(),
    };
    if (lead.opt_out) { contact.optOut = true; contact.status = 'lost'; contact.optOutAt = now(); }
    contact.updatedAt = now();
    return contact;
  }

  // A person decides whether this is a qualified lead (from the Inbox): true or false, which the assistant then can't
  // change, or null to let the assistant decide again. A deal marked won stays won.
  function setLead(phone, qualified, by = '') {
    const { contact } = upsert(phone, {}, { source: 'inbox' });
    if (qualified === null) {
      // Back to the assistant: its last view of the stage, if it has one (a deal marked won stays won).
      delete contact.leadLock;
      if (contact.aiStatus && contact.status !== 'won') contact.status = contact.aiStatus;
    }
    else {
      if (qualified && contact.status !== 'won') contact.status = 'qualified';
      if (!qualified && contact.status === 'qualified') contact.status = 'interested';
      contact.leadLock = { status: contact.status, qualified: Boolean(qualified), by, at: now() };
    }
    contact.updatedAt = now();
    return contact;
  }

  // Contacts with any of these tags (or everyone), never the opted-out ones.
  function listByTags(names = [], { statuses = [] } = {}) {
    const wanted = names.length ? db.tags.filter((t) => names.some((n) => n.toLowerCase() === t.name.toLowerCase())).map((t) => t.id) : null;
    return db.contacts.filter((c) => !c.optOut && (!wanted || c.tags.some((t) => wanted.includes(t))) && (!statuses.length || statuses.includes(c.status)));
  }

  const tagCounts = () => Object.fromEntries(db.tags.map((t) => [t.id, db.contacts.filter((c) => c.tags.includes(t.id)).length]));

  // --- Routes ----------------------------------------------------------------

  // --- The Contacts page, one page at a time --------------------------------------------------------------
  // GET /api/contacts?page=0&per=100 with q (search), sort + dir, and the Filters panel's picks as comma lists: stage,
  // delivery (delivered | undelivered | optout), num (a number's id, or none), tag (a tag id, or none), source. Within a
  // list: any of them; across lists: all. Returns that page, how many match, and per filter section how many each option
  // would give with the other sections' picks (facets). ids=1 adds every matching id (Select all). Without page, the
  // whole book as before (the Send page uses that).
  const everFailed = (c) => (c.campaigns || []).some((x) => x.status === 'failed') || c.delivery?.status === 'failed';
  const everDelivered = (c) => (c.campaigns || []).some((x) => x.status === 'delivered' || x.status === 'read') || ['delivered', 'read'].includes(c.delivery?.status);
  const MATCH = {
    stage: (c, k) => !c.optOut && c.status === k,
    delivery: (c, k) => (k === 'delivered' ? everDelivered(c) : k === 'undelivered' ? everFailed(c) : k === 'optout' && Boolean(c.optOut)),
    num: (c, k) => (c.via || 'none') === k,
    tag: (c, k) => (k === 'none' ? !c.tags.length : c.tags.includes(k)),
    source: (c, k) => (c.source || 'manual') === k,
  };
  const fmtPhone = (p) => { const m = /^91(\d{5})(\d{5})$/.exec(p); return m ? `+91 ${m[1]} ${m[2]}` : '+' + p; };
  const RANK = { new: 0, interested: 1, qualified: 2, won: 3, lost: 4 };
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  function queryContacts(qs) {
    const listOf = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
    const fs = Object.fromEntries(Object.keys(MATCH).map((k) => [k, new Set(listOf(qs[k]))]));
    const q = String(qs.q || '').trim().toLowerCase(), qd = q.replace(/\D/g, '');
    const inSearch = (c) => !q || [c.name, c.email, c.company, c.lead?.summary, fmtPhone(c.phone)].some((v) => String(v || '').toLowerCase().includes(q)) || (qd.length >= 3 && c.phone.includes(qd));
    const passes = (c, skip) => Object.entries(fs).every(([sec, set]) => sec === skip || !set.size || [...set].some((k) => MATCH[sec](c, k)));
    const searched = db.contacts.filter(inSearch);
    const matching = searched.filter((c) => passes(c));
    // How many each option would give, with the other sections' picks
    const facets = {}, facetTotals = {};
    for (const sec of Object.keys(MATCH)) {
      const base = searched.filter((c) => passes(c, sec)), n = {};
      const bump = (k) => { n[k] = (n[k] || 0) + 1; };
      for (const c of base) {
        if (sec === 'stage') { if (!c.optOut) bump(c.status); }
        else if (sec === 'delivery') { if (everDelivered(c)) bump('delivered'); if (everFailed(c)) bump('undelivered'); if (c.optOut) bump('optout'); }
        else if (sec === 'num') bump(c.via || 'none');
        else if (sec === 'tag') { if (!c.tags.length) bump('none'); else c.tags.forEach(bump); }
        else bump(c.source || 'manual');
      }
      facets[sec] = n;
      facetTotals[sec] = base.length;
    }
    // Sorting, as the page always did: contacts with no value for it (no name, company, tag…) last, either way
    const tagName = new Map(db.tags.map((t) => [t.id, t.name]));
    const SORTS = {
      name: (c) => { const n = (c.name || '').trim(); return n && /[a-z]/i.test(n[0]) ? n : ''; },
      added: (c) => c.createdAt || '',
      message: (c) => c.lastMessageAt || '',
      status: (c) => (c.optOut ? 5 : RANK[c.status] ?? 0),
      tags: (c) => c.tags.map((t) => tagName.get(t)).filter(Boolean).sort((a, b) => a.localeCompare(b))[0] || '',
      lead: (c) => (c.lead?.summary ? c.lead.updatedAt || '1' : ''),
      company: (c) => (c.company || '').trim(),
    };
    const key = SORTS[qs.sort] ? qs.sort : 'name', dir = qs.dir === 'desc' ? -1 : 1;
    const val = new Map(matching.map((c) => [c, SORTS[key](c)]));
    const nameOf = (c) => c.name || fmtPhone(c.phone);
    const blank = (v) => v === '' || v == null;
    matching.sort((a, b) => {
      const x = val.get(a), y = val.get(b);
      if (blank(x) !== blank(y)) return blank(x) ? 1 : -1;
      return dir * (typeof x === 'number' ? x - y : collator.compare(String(x), String(y))) || collator.compare(nameOf(a), nameOf(b));
    });
    const per = String(qs.per) === '0' ? 0 : Math.min(500, Math.max(10, Math.round(Number(qs.per)) || 100)); // 0 = all
    const pages = per ? Math.max(1, Math.ceil(matching.length / per)) : 1;
    const page = Math.min(Math.max(0, Math.round(Number(qs.page)) || 0), pages - 1);
    return {
      contacts: per ? matching.slice(page * per, page * per + per) : matching,
      total: matching.length, page, per, pages, facets, facetTotals,
      all: db.contacts.length, opted: db.contacts.filter((c) => c.optOut).length, untagged: db.contacts.filter((c) => !c.tags.length).length,
      ...(qs.ids ? { ids: matching.map((c) => c.id) } : {}),
    };
  }

  app.get('/api/contacts', (req, res) => {
    if (req.query.phones) return res.json({ phones: db.contacts.map((c) => c.phone) }); // the import's "new or already here"
    if (req.query.page == null) return res.json({ contacts: db.contacts, tags: db.tags, counts: tagCounts(), statuses: STATUSES });
    res.json({ ...queryContacts(req.query), tags: db.tags, counts: tagCounts(), statuses: STATUSES });
  });
  // One contact (opening it from the Inbox, or one not on the page shown), and several (a selection across pages)
  app.get('/api/contacts/:id', wrap((req, res) => {
    const c = db.contacts.find((x) => x.id === req.params.id);
    if (!c) throw fail('Contact not found', 404);
    res.json(c);
  }));
  app.post('/api/contacts/by-ids', wrap((req, res) => {
    const ids = new Set(Array.isArray(req.body.ids) ? req.body.ids : []);
    res.json({ contacts: db.contacts.filter((c) => ids.has(c.id)) });
  }));

  app.post('/api/contacts', wrap((req, res) => {
    const phoneErr = phoneInputError(req.body.phone);
    if (phoneErr) throw fail(phoneErr);
    const phone = normalizePhone(req.body.phone);
    const { contact, created } = upsert(phone, req.body, { source: 'manual', addTags: req.body.tags || [] });
    save();
    res.json({ contact, created });
  }));

  app.put('/api/contacts/:id', wrap((req, res) => {
    const c = db.contacts.find((x) => x.id === req.params.id);
    if (!c) throw fail('Contact not found', 404);
    if (req.body.phone != null) {
      const phoneErr = phoneInputError(req.body.phone);
      if (phoneErr) throw fail(phoneErr);
      const phone = normalizePhone(req.body.phone);
      if (phone !== c.phone && byPhone(phone)) throw fail('Another contact already has that number');
      c.phone = phone;
      delete c.phoneProblem;
    }
    // Here blank means "clear it": this is the edit form, not a merge.
    for (const k of ['name', 'email', 'company', 'notes']) if (k in req.body) c[k] = clean(req.body[k], k === 'notes' ? 4000 : 200);
    // A stage a person picks is their decision about the lead: the assistant won't change it (see applyLead; the
    // Inbox's "Let the AI decide" hands it back).
    if (STATUSES.includes(req.body.status) && (req.body.status !== c.status || req.body.lockStage === true)) c.leadLock = { status: req.body.status, qualified: ['qualified', 'won'].includes(req.body.status), by: req.user?.email || '', at: now() };
    if (STATUSES.includes(req.body.status)) c.status = req.body.status;
    if (typeof req.body.optOut === 'boolean') c.optOut = req.body.optOut;
    if (Array.isArray(req.body.tags)) c.tags = tagIds(req.body.tags);
    c.updatedAt = now();
    save();
    res.json(c);
  }));

  app.post('/api/contacts/delete', wrap((req, res) => {
    const ids = new Set(req.body.ids || []);
    const before = db.contacts.length;
    db.contacts = db.contacts.filter((c) => !ids.has(c.id));
    save();
    res.json({ deleted: before - db.contacts.length });
  }));

  // rows: [{ phone, name, email, company, extra: {} }]; tags: existing ids; newTags: names to create.
  app.post('/api/contacts/import', wrap((req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) throw fail('Nothing to import');
    if (rows.length > 100000) throw fail('Import up to 100,000 contacts at a time');
    const tags = [...tagIds(req.body.tags || []), ...ensureTags(req.body.newTags || [])];
    let added = 0, updated = 0, invalid = 0;
    const seen = new Set();
    for (const r of rows) {
      const phone = normalizePhone(r.phone);
      if (!phone) { invalid++; continue; }
      const { created } = upsert(phone, r, { source: 'import', addTags: tags });
      if (seen.has(phone)) continue;
      seen.add(phone);
      created ? added++ : updated++;
    }
    save();
    res.json({ added, updated, invalid, tags });
  }));

  app.post('/api/contacts/tags', wrap((req, res) => {
    const ids = new Set(req.body.ids || []);
    const add = [...tagIds(req.body.add || []), ...ensureTags(req.body.newTags || [])];
    const remove = new Set(req.body.remove || []);
    let n = 0;
    for (const c of db.contacts) {
      if (!ids.has(c.id)) continue;
      c.tags = [...new Set([...c.tags.filter((t) => !remove.has(t)), ...add])];
      c.updatedAt = now();
      n++;
    }
    save();
    res.json({ updated: n, tags: db.tags });
  }));

  app.post('/api/tags', wrap((req, res) => {
    const name = clean(req.body.name, 40);
    if (!name) throw fail('Give the tag a name');
    if (db.tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw fail('A tag with that name already exists');
    const t = { id: id(), name, color: TAG_COLORS.includes(req.body.color) ? req.body.color : TAG_COLORS[db.tags.length % TAG_COLORS.length], createdAt: now() };
    db.tags.push(t);
    save();
    res.json(t);
  }));

  app.put('/api/tags/:id', wrap((req, res) => {
    const t = db.tags.find((x) => x.id === req.params.id);
    if (!t) throw fail('Tag not found', 404);
    if (req.body.name != null) {
      const name = clean(req.body.name, 40);
      if (!name) throw fail('Give the tag a name');
      if (db.tags.some((x) => x !== t && x.name.toLowerCase() === name.toLowerCase())) throw fail('A tag with that name already exists');
      t.name = name;
    }
    if (TAG_COLORS.includes(req.body.color)) t.color = req.body.color;
    save();
    res.json(t);
  }));

  app.delete('/api/tags/:id', wrap((req, res) => {
    db.tags = db.tags.filter((t) => t.id !== req.params.id);
    for (const c of db.contacts) c.tags = c.tags.filter((t) => t !== req.params.id);
    save();
    res.json({ ok: true });
  }));

  return { byPhone, upsert, onInbound, applyLead, setLead, isOptedOut, listByTags, ensureTags, recheckPhones, noteDelivery, contactsFromPastCampaigns, STATUSES, notify: (key) => broadcast({ kind: 'contact', key }) };
};
