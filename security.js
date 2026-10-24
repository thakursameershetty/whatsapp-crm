// Request-level protection: security headers, a same-origin check for anything that changes
// data, and rate limits (per signed-in user, else per IP). Limits live in memory, which is
// fine for one server.

const hosted = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production');

function headers(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (hosted) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// Browsers send Origin on cross-site POSTs; refuse ones from other sites (the webhook is Meta's).
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/webhook') return next();
  const origin = req.get('origin');
  if (!origin) return next(); // scripts and same-origin form posts in some browsers
  let host;
  try { host = new URL(origin).host; } catch { host = ''; }
  if (host && host === req.get('host')) return next();
  return res.status(403).json({ error: 'Cross-site request blocked' });
}

// name → [max requests, per milliseconds, which paths]
const RULES = [
  ['ai', 60, 60000, (r) => r.path.startsWith('/api/ai/') && r.method !== 'GET'],
  ['send', 60, 60000, (r) => r.method === 'POST' && (r.path === '/api/campaigns' || r.path === '/api/send/test' || /^\/api\/inbox\/[^/]+\/(send|draft)$/.test(r.path))],
  ['write', 300, 60000, (r) => r.path.startsWith('/api/') && r.method !== 'GET'],
  ['read', 1200, 60000, (r) => r.path.startsWith('/api/')],
];
const hits = new Map(); // "rule|who" → timestamps
setInterval(() => { const now = Date.now(); for (const [k, t] of hits) if (!t.length || now - t[t.length - 1] > 120000) hits.delete(k); }, 60000).unref();

function rateLimit(req, res, next) {
  const who = req.user?.id || req.ip;
  const now = Date.now();
  for (const [name, max, win, applies] of RULES) {
    if (!applies(req)) continue;
    const k = `${name}|${who}`;
    const t = (hits.get(k) || []).filter((x) => now - x < win);
    if (t.length >= max) {
      res.set('Retry-After', String(Math.ceil((win - (now - t[0])) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
    }
    t.push(now);
    hits.set(k, t);
    break; // the most specific rule counts
  }
  next();
}

module.exports = { headers, sameOrigin, rateLimit, hosted };
