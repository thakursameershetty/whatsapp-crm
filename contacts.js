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

  // Someone messaged one of our numbers: make sure they're in Contacts, and honour STOP at once.
  function onInbound(wa, { name, text, ts } = {}) {
    const phone = normalizePhone(wa) || wa;
    const { contact } = upsert(phone, { name }, { source: 'inbox' });
    contact.lastMessageAt = ts || now();
    if (text && STOP_RE.test(text)) {
      contact.optOut = true;
      contact.status = 'lost';
      contact.optOutAt = now();
    }
    return contact;
  }

  // What the lead assistant learned about this person.
  function applyLead(phone, lead = {}) {
    const { contact } = upsert(phone, { name: lead.name, email: lead.email, company: lead.company }, { source: 'inbox' });
    const status = { not_interested: 'lost' }[lead.status] || lead.status;
    // A human's "won" stands; the assistant can move a lead along but not undo that.
    if (STATUSES.includes(status) && status !== 'won' && contact.status !== 'won') contact.status = status;
    contact.lead = {
      ...contact.lead,
      ...Object.fromEntries(['summary', 'need', 'budget', 'timeline'].filter((k) => clean(lead[k])).map((k) => [k, clean(lead[k], 600)])),
      updatedAt: now(),
    };
    if (lead.opt_out) { contact.optOut = true; contact.status = 'lost'; contact.optOutAt = now(); }
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

  app.get('/api/contacts', (req, res) => res.json({ contacts: db.contacts, tags: db.tags, counts: tagCounts(), statuses: STATUSES }));

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
    }
    // Here blank means "clear it": this is the edit form, not a merge.
    for (const k of ['name', 'email', 'company', 'notes']) if (k in req.body) c[k] = clean(req.body[k], k === 'notes' ? 4000 : 200);
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

  return { byPhone, upsert, onInbound, applyLead, isOptedOut, listByTags, ensureTags, STATUSES, notify: (key) => broadcast({ kind: 'contact', key }) };
};
