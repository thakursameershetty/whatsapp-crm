// Opening a Google Sheet shared as "Anyone with the link can view": its CSV export, fetched here (a browser can't —
// Google's download doesn't allow it) and opened like a CSV file (Send page tabs, Contacts import). Only Google's own
// export address is ever called, built from the sheet id in the link — never the link itself.

const MAX_BYTES = 15 * 1024 * 1024;

// The sheet (and tab) a Google Sheets link points at, or null if it isn't one.
function parseSheetLink(link) {
  let u;
  try { u = new URL(String(link || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') return null;
  const gid = /(?:^|[#&?])gid=(\d+)/.exec(`${u.search}${u.hash}`)?.[1];
  const pub = /^\/spreadsheets\/d\/e\/([\w-]{20,})/.exec(u.pathname)?.[1]; // published to the web
  if (pub) return { id: null, exportUrl: `https://docs.google.com/spreadsheets/d/e/${pub}/pub?output=csv${gid ? `&gid=${gid}` : ''}` };
  const id = /^\/spreadsheets\/d\/([\w-]{20,})/.exec(u.pathname)?.[1];
  if (!id) return null;
  return { id, exportUrl: `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}` };
}

const NOT_SHARED = 'Couldn’t open that sheet. In Google Sheets, click Share → General access → “Anyone with the link” (Viewer), then paste the link again.';

// The sheet's title, for the tab name (best effort: "Google Sheet" when it can't be read).
async function sheetTitle(id) {
  try {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/edit`, { signal: AbortSignal.timeout(8000) });
    const html = res.ok ? (await res.text()).slice(0, 200000) : '';
    const t = /<title>([^<]*)<\/title>/i.exec(html)?.[1] || '';
    const name = t.replace(/\s*-\s*Google (Sheets|Drive)\s*$/i, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    return name && !/^(Google Sheets|Sign in)/i.test(name) ? name.slice(0, 80) : '';
  } catch { return ''; }
}

module.exports = function mountGoogleSheets(app, { wrap, fail }) {
  app.post('/api/import/google-sheet', wrap(async (req, res) => {
    const parsed = parseSheetLink(req.body?.url);
    if (!parsed) throw fail('That isn’t a Google Sheets link. Copy it from the sheet’s address bar or Share → Copy link.');
    let r;
    try { r = await fetch(parsed.exportUrl, { redirect: 'follow', signal: AbortSignal.timeout(20000) }); }
    catch { throw fail('Google Sheets didn’t answer. Try again in a moment.', 502); }
    // A private sheet answers with Google's sign-in page (HTML) or a 401/403/404, not a CSV.
    if (!r.ok || (r.headers.get('content-type') || '').includes('text/html')) throw fail(NOT_SHARED);
    if (Number(r.headers.get('content-length') || 0) > MAX_BYTES) throw fail('That sheet is too big to open at once (over 15 MB). Split it into smaller sheets.');
    const csv = await r.text();
    if (csv.length > MAX_BYTES) throw fail('That sheet is too big to open at once (over 15 MB). Split it into smaller sheets.');
    if (!csv.trim()) throw fail('That sheet is empty.');
    res.json({ csv, name: parsed.id ? await sheetTitle(parsed.id) : '' });
  }));
};
module.exports.parseSheetLink = parseSheetLink;
