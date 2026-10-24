// Where the data lives: PostgreSQL when DATABASE_URL is set, otherwise JSON files in data/.
//
// The app works on the data in memory (see tenancy.js); a store loads it once at startup and
// saves changes. The Postgres store keeps accounts in their own tables and every workspace
// record (a contact, a message, a campaign…) as its own row, and on each save writes only the
// rows that changed, in one transaction. The first start with an empty database imports the
// JSON files (kept on disk as a backup).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const secrets = require('./secrets');

// Workspace collections stored one row per item, and the order to restore them in.
const LISTS = {
  senders: (a, b) => cmp(a.createdAt, b.createdAt),
  templates: (a, b) => cmp(a.name, b.name),
  campaigns: (a, b) => cmp(b.createdAt, a.createdAt), // newest first
  messages: (a, b) => cmp(a.ts, b.ts),
  contacts: (a, b) => cmp(a.createdAt, b.createdAt),
  tags: (a, b) => cmp(a.createdAt, b.createdAt),
  notifications: (a, b) => cmp(b.ts, a.ts), // newest first
  aiChats: (a, b) => cmp(b.updatedAt, a.updatedAt),
};
const cmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''));
const ACCOUNT_TABLES = {
  users: { key: (u) => u.id, cols: ['email'] },
  workspaces: { key: (w) => w.id, cols: [] },
  members: { key: (m) => `${m.wsId}:${m.userId}`, cols: ['ws_id', 'user_id'] },
  invites: { key: (i) => i.id, cols: ['ws_id'] },
  sessions: { key: (s) => s.hash, cols: ['user_id'] },
};

// --- Files ----------------------------------------------------------------------

function readFiles(dataDir) {
  const wsDir = path.join(dataDir, 'workspaces');
  const accFile = path.join(dataDir, 'accounts.json');
  const legacyFile = path.join(dataDir, 'db.json');
  const accounts = fs.existsSync(accFile)
    ? JSON.parse(fs.readFileSync(accFile, 'utf8'))
    : { users: [], workspaces: [], members: [], invites: [], sessions: [] };
  const data = new Map();
  for (const meta of accounts.workspaces) {
    const f = path.join(wsDir, meta.id + '.json');
    data.set(meta.id, secrets.openWorkspace(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}));
  }
  // Data from before workspaces existed becomes the first workspace, for whoever claims it.
  let legacy = null;
  if (!accounts.workspaces.length && fs.existsSync(legacyFile)) {
    legacy = { id: crypto.randomBytes(8).toString('hex'), name: 'Spotmies', createdAt: new Date().toISOString(), legacy: true };
    accounts.workspaces.push(legacy);
    data.set(legacy.id, secrets.openWorkspace(JSON.parse(fs.readFileSync(legacyFile, 'utf8'))));
  }
  return { accounts, data, legacy, legacyFile };
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function fileStore(dataDir) {
  const { accounts, data, legacy, legacyFile } = readFiles(dataDir);
  if (legacy) {
    fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
    fs.copyFileSync(legacyFile, path.join(dataDir, 'backups', `db-before-workspaces-${Date.now()}.json`));
    writeJson(path.join(dataDir, 'workspaces', legacy.id + '.json'), secrets.sealWorkspace(data.get(legacy.id)));
    fs.renameSync(legacyFile, legacyFile + '.migrated');
    writeJson(path.join(dataDir, 'accounts.json'), accounts);
  }
  return {
    kind: 'files',
    accounts,
    data,
    async saveAccounts(acc) { writeJson(path.join(dataDir, 'accounts.json'), acc); },
    async saveWorkspace(id, db) { writeJson(path.join(dataDir, 'workspaces', id + '.json'), secrets.sealWorkspace(db)); },
    async close() {},
  };
}

// --- Postgres -------------------------------------------------------------------

const SCHEMA = `
create table if not exists users (id text primary key, email text not null unique, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists workspaces (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists members (id text primary key, ws_id text not null references workspaces(id) on delete cascade, user_id text not null references users(id) on delete cascade, data jsonb not null, updated_at timestamptz not null default now(), unique (ws_id, user_id));
create table if not exists invites (id text primary key, ws_id text not null references workspaces(id) on delete cascade, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists sessions (id text primary key, user_id text not null references users(id) on delete cascade, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists ws_items (
  workspace_id text not null references workspaces(id) on delete cascade,
  kind text not null,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, kind, id)
);
create index if not exists ws_items_kind on ws_items (workspace_id, kind);
create index if not exists members_user on members (user_id);
create index if not exists sessions_user on sessions (user_id);
`;

async function pgStore(url, dataDir) {
  const { Pool } = require('pg');
  const local = /localhost|127\.0\.0\.1|\.railway\.internal|^postgres(ql)?:\/\/[^@]*@[^.:/]+[:/]/.test(url);
  const pool = new Pool({ connectionString: url, max: 5, ssl: local || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false } });
  await pool.query(SCHEMA);

  // What each row looked like when last saved, so a save writes only what changed.
  const saved = new Map(); // "table|key" or "ws|kind|id" -> JSON text

  async function loadAll() {
    const accounts = { users: [], workspaces: [], members: [], invites: [], sessions: [] };
    for (const t of Object.keys(ACCOUNT_TABLES)) {
      const { rows } = await pool.query(`select id, data from ${t}`);
      for (const r of rows) { accounts[t].push(r.data); saved.set(`${t}|${r.id}`, JSON.stringify(r.data)); }
    }
    accounts.users.sort((a, b) => cmp(a.createdAt, b.createdAt));
    accounts.workspaces.sort((a, b) => cmp(a.createdAt, b.createdAt));
    const data = new Map(accounts.workspaces.map((w) => [w.id, {}]));
    const { rows } = await pool.query('select workspace_id, kind, id, data from ws_items');
    for (const r of rows) {
      const db = data.get(r.workspace_id);
      if (!db) continue;
      saved.set(`${r.workspace_id}|${r.kind}|${r.id}`, JSON.stringify(r.data));
      if (r.kind === 'settings') db.settings = r.data;
      else if (r.kind === 'chats') (db.chats ||= {})[r.id] = r.data;
      else if (LISTS[r.kind]) (db[r.kind] ||= []).push(r.data);
      else if (r.kind === 'misc') db[r.id] = r.data.value;
    }
    for (const db of data.values()) { for (const [k, sort] of Object.entries(LISTS)) db[k]?.sort(sort); secrets.openWorkspace(db); }
    return { accounts, data };
  }

  // Rows for one workspace: [kind, id, data].
  function rowsOf(db) {
    const out = [];
    for (const [k, v] of Object.entries(db)) {
      if (k === 'settings') out.push(['settings', 'settings', secrets.sealSettings(v)]);
      else if (k === 'senders') for (const item of v || []) { item.id ||= crypto.randomBytes(8).toString('hex'); out.push([k, String(item.id), secrets.sealSender(item)]); }
      else if (k === 'chats') for (const [key, chat] of Object.entries(v || {})) out.push(['chats', key, chat]);
      else if (LISTS[k]) for (const item of v || []) { item.id ||= crypto.randomBytes(8).toString('hex'); out.push([k, String(item.id), item]); }
      else if (v !== undefined) out.push(['misc', k, { value: v }]);
    }
    return out;
  }

  async function syncWorkspace(client, wsId, db) {
    // A brand-new workspace may be saved before the accounts are; make sure its row exists.
    await client.query("insert into workspaces (id, data) values ($1, '{}') on conflict (id) do nothing", [wsId]);
    const seen = new Set();
    for (const [kind, id, data] of rowsOf(db)) {
      const key = `${wsId}|${kind}|${id}`;
      seen.add(key);
      const json = JSON.stringify(data);
      if (saved.get(key) === json) continue;
      await client.query(
        `insert into ws_items (workspace_id, kind, id, data, updated_at) values ($1, $2, $3, $4, now())
         on conflict (workspace_id, kind, id) do update set data = excluded.data, updated_at = now()`,
        [wsId, kind, id, json],
      );
      saved.set(key, json);
    }
    for (const key of [...saved.keys()]) {
      if (!key.startsWith(wsId + '|') || seen.has(key)) continue;
      const [, kind, ...rest] = key.split('|');
      await client.query('delete from ws_items where workspace_id = $1 and kind = $2 and id = $3', [wsId, kind, rest.join('|')]);
      saved.delete(key);
    }
  }

  async function syncAccounts(client, acc) {
    // Parents before children when adding; children before parents when removing.
    const order = ['users', 'workspaces', 'members', 'invites', 'sessions'];
    const keep = {};
    for (const t of order) {
      const def = ACCOUNT_TABLES[t];
      keep[t] = new Set();
      for (const item of acc[t] || []) {
        const id = def.key(item);
        keep[t].add(id);
        const json = JSON.stringify(item);
        if (saved.get(`${t}|${id}`) === json) continue;
        const extra = { users: [item.email], workspaces: [], members: [item.wsId, item.userId], invites: [item.wsId], sessions: [item.userId] }[t];
        const cols = ['id', 'data', ...def.cols];
        const vals = [id, json, ...extra];
        await client.query(
          `insert into ${t} (${cols.join(', ')}, updated_at) values (${cols.map((_, i) => '$' + (i + 1)).join(', ')}, now())
           on conflict (id) do update set ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = now()`,
          vals,
        );
        saved.set(`${t}|${id}`, json);
      }
    }
    for (const t of [...order].reverse()) {
      for (const key of [...saved.keys()]) {
        if (!key.startsWith(t + '|')) continue;
        const id = key.slice(t.length + 1);
        if (keep[t].has(id)) continue;
        await client.query(`delete from ${t} where id = $1`, [id]);
        saved.delete(key);
      }
    }
  }

  async function inTx(fn) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await fn(client);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => {});
      // Forget what we thought was saved, so the next save writes everything again.
      saved.clear();
      const fresh = await loadKeysOnly();
      for (const [k, v] of fresh) saved.set(k, v);
      throw e;
    } finally {
      client.release();
    }
  }
  async function loadKeysOnly() {
    const m = new Map();
    for (const t of Object.keys(ACCOUNT_TABLES)) for (const r of (await pool.query(`select id, data from ${t}`)).rows) m.set(`${t}|${r.id}`, JSON.stringify(r.data));
    for (const r of (await pool.query('select workspace_id, kind, id, data from ws_items')).rows) m.set(`${r.workspace_id}|${r.kind}|${r.id}`, JSON.stringify(r.data));
    return m;
  }

  // Saves run one at a time so they never interleave.
  let chain = Promise.resolve();
  const queue = (fn) => (chain = chain.then(fn, fn));

  let { accounts, data } = await loadAll();
  let imported = false;
  if (!accounts.workspaces.length) {
    // Empty database: bring in the JSON files (they stay on disk as a backup).
    const files = readFiles(dataDir);
    if (files.accounts.workspaces.length) {
      await inTx(async (c) => {
        await syncAccounts(c, files.accounts);
        for (const [id, db] of files.data) await syncWorkspace(c, id, db);
      });
      ({ accounts, data } = await loadAll());
      imported = true;
      fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'backups', `imported-to-postgres-${Date.now()}.txt`), `Imported ${accounts.workspaces.length} workspace(s) into Postgres. The JSON files in this folder are the copy from before.\n`);
    }
  }

  return {
    kind: 'postgres',
    imported,
    accounts,
    data,
    saveAccounts: (acc) => queue(() => inTx((c) => syncAccounts(c, acc))),
    saveWorkspace: (id, db) => queue(() => inTx((c) => syncWorkspace(c, id, db))),
    // A new workspace needs its row before its items (and before members point at it).
    async close() { await chain.catch(() => {}); await pool.end(); },
  };
}

async function openStore(dataDir) {
  const url = process.env.DATABASE_URL;
  return url ? pgStore(url, dataDir) : fileStore(dataDir);
}

module.exports = { openStore, fileStore };
