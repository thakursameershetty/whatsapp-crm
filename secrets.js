// Encryption at rest for the secrets a workspace stores: WhatsApp access tokens and AI keys.
// They're encrypted (AES-256-GCM) when written to the database or files and decrypted when
// loaded, so the app works with plain values in memory. The key comes from ENCRYPTION_KEY
// (any long random string). Without it values are stored as they are, and the app says so.

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const SETTINGS_SECRETS = ['anthropicApiKey', 'geminiApiKey'];
const raw = process.env.ENCRYPTION_KEY || '';
const key = raw ? crypto.createHash('sha256').update(raw).digest() : null;

// The same plain value keeps the same ciphertext, so unchanged rows aren't rewritten on every save.
const cache = new Map();

function encrypt(value) {
  if (!key || typeof value !== 'string' || !value || value.startsWith(PREFIX)) return value;
  if (cache.has(value)) return cache.get(value);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  const out = PREFIX + [iv, body, c.getAuthTag()].map((b) => b.toString('base64')).join(':');
  cache.set(value, out);
  return out;
}

function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  if (!key) throw new Error('Stored secrets are encrypted but ENCRYPTION_KEY is not set. Set the same ENCRYPTION_KEY as before.');
  const [iv, body, tag] = value.slice(PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(body), d.final()]).toString('utf8');
  cache.set(plain, value);
  return plain;
}

// A copy of a workspace's settings / sender with its secrets encrypted (for writing).
const sealSettings = (s) => (s ? { ...s, ...Object.fromEntries(SETTINGS_SECRETS.filter((k) => s[k]).map((k) => [k, encrypt(s[k])])) } : s);
const sealSender = (x) => (x && x.accessToken ? { ...x, accessToken: encrypt(x.accessToken) } : x);

// Decrypt in place after loading.
function openSettings(s) { if (s) for (const k of SETTINGS_SECRETS) if (s[k]) s[k] = decrypt(s[k]); return s; }
function openSender(x) { if (x?.accessToken) x.accessToken = decrypt(x.accessToken); return x; }
function openWorkspace(db) {
  openSettings(db.settings);
  for (const s of db.senders || []) openSender(s);
  return db;
}
function sealWorkspace(db) {
  return { ...db, settings: sealSettings(db.settings), senders: (db.senders || []).map(sealSender) };
}

module.exports = { enabled: Boolean(key), encrypt, decrypt, sealSettings, sealSender, openWorkspace, sealWorkspace };
