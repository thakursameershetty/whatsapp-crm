// WhatsApp Sender — dashboard (vanilla JS, no build step).

const state = {
  settings: {},
  senders: [],
  templates: [],
  campaigns: [],
  sendMode: 'now',
  selectedSenders: new Set(),
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '—');

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) location.href = '/login';
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

// A toast in the top-right corner. opts: { title, icon, onClick, duration }.
// Every toast has a × to dismiss it, and hovering pauses its timer.
function toast(msg, type = '', opts = {}) {
  const el = document.createElement('div');
  el.className = 'toast ' + type + (opts.onClick ? ' clickable' : '');
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(opts.icon || (type === 'error' ? 'badge-alert' : 'circle-check'), 16)}<div class="toast-text"></div><button type="button" class="toast-x" aria-label="Dismiss">${icon('x', 14)}</button>`;
  const text = el.querySelector('.toast-text');
  if (opts.title) { const b = document.createElement('b'); b.textContent = opts.title; text.append(b); }
  const p = document.createElement('span');
  p.textContent = msg;
  text.append(p);
  $('#toasts').append(el);
  requestAnimationFrame(() => LA.play(el));
  let left = opts.duration || (type === 'error' ? 6000 : opts.onClick ? 6000 : 3500), started = Date.now(), timer;
  const dismiss = () => {
    if (el.classList.contains('out')) return;
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 280);
  };
  timer = setTimeout(dismiss, left);
  el.addEventListener('mouseenter', () => { clearTimeout(timer); left -= Date.now() - started; });
  el.addEventListener('mouseleave', () => { started = Date.now(); timer = setTimeout(dismiss, Math.max(left, 1200)); });
  el.querySelector('.toast-x').addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
  if (opts.onClick) el.addEventListener('click', () => { opts.onClick(); dismiss(); });
  return { dismiss };
}

async function guard(fn, btn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Tabs, modal
// ---------------------------------------------------------------------------

function showTab(name) {
  if (name === 'assistant' && !state.me?.admin) name = 'overview'; // the AI features are admin-only
  $$('.side-nav button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  const wasHidden = $('#tab-' + name)?.classList.contains('hidden');
  $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + name));
  if (wasHidden) { Motion.enter($('#tab-' + name)); scrollTo(0, 0); } // a new page starts at the top
  state.tab = name;
  // The inbox fills the window and starts with the sidebar shrunk to icons.
  document.body.classList.toggle('inbox-open', name === 'inbox');
  document.body.classList.toggle('assistant-open', name === 'assistant');
  syncNav();
  if (name === 'assistant') window.Assistant?.show();
  if (name === 'inbox') window.Inbox?.show();
  Motion.segs();
  document.body.classList.toggle('send-open', name === 'send');
  if (name === 'send') window.SendPage?.show();
  if (name === 'contacts') window.Contacts?.show();
  if (name === 'notifications') window.Notifications?.show();
  if (name === 'campaigns') loadCampaigns();
  if (name !== 'campaigns') stopPolling();
  if (name === 'overview') loadOverview().catch((e) => toast(e.message, 'error'));
  else stopOverviewPolling();
  if (name === 'numbers') refreshStats().then(renderSenders).catch(() => {});
  hideTip();
  // The address follows the page (/send, /inbox; the overview is just /), so Back and Forward move
  // between pages and a reload stays where you are.
  const path = name === 'overview' ? '/' : '/' + name;
  if (location.pathname !== path || location.hash) history[showTab.replace ? 'replaceState' : 'pushState']({ tab: name }, '', path);
  showTab.replace = false;
}
// Which page an address means: /send → send; old #send links still work.
const tabFromUrl = () => {
  const h = location.hash.slice(1), p = location.pathname.replace(/^\/+|\/+$/g, '');
  const t = (h && $('#tab-' + h) && h) || (p && $('#tab-' + p) && p) || 'overview';
  return t;
};
$$('.side-nav button[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
window.addEventListener('popstate', () => {
  const tab = tabFromUrl();
  if ($('#tab-' + tab)?.classList.contains('hidden')) { showTab.replace = true; showTab(tab); }
});
window.addEventListener('hashchange', () => { const tab = tabFromUrl(); showTab.replace = true; showTab(tab); });

// Sidebar: collapses to icons. Remembered per browser; on the Inbox it starts collapsed
// and the toggle only opens it for that visit.
state.navCollapsed = (() => { try { return localStorage.getItem('navCollapsed') === '1'; } catch { return false; } })();
state.inboxNavOpen = false;
function syncNav() {
  const mini = state.tab === 'inbox' ? !state.inboxNavOpen : state.navCollapsed;
  const was = document.body.classList.contains('nav-mini');
  document.body.classList.toggle('nav-mini', mini);
  const btn = $('#navToggle');
  const label = mini ? 'Expand sidebar' : 'Collapse sidebar';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-expanded', String(!mini));
  // Thumbs, the Send split and the inbox measure their space: let them re-fit once the sidebar has moved.
  if (was !== mini) setTimeout(() => dispatchEvent(new Event('resize')), Motion.reduce() ? 0 : 300);
}
$('#navToggle').addEventListener('click', () => {
  if (state.tab === 'inbox') state.inboxNavOpen = !state.inboxNavOpen;
  else {
    state.navCollapsed = !state.navCollapsed;
    try { localStorage.setItem('navCollapsed', state.navCollapsed ? '1' : '0'); } catch {}
  }
  syncNav();
});

const THEMES = [['light', 'Light', 'sun'], ['auto', 'Match system', 'sun-moon'], ['dark', 'Dark', 'moon']];
function renderThemeSeg() {
  const cur = document.documentElement.dataset.theme;
  $$('[data-theme-set]').forEach((b) => b.classList.toggle('active', b.dataset.themeSet === cur));
  // The collapsed sidebar's single button shows the current theme and names the next one.
  const i = Math.max(0, THEMES.findIndex(([k]) => k === cur));
  const next = THEMES[(i + 1) % THEMES.length];
  const btn = $('#themeCycle');
  btn.innerHTML = LA.icon(THEMES[i][2], 16); // runs before app.js defines icon()
  btn.title = `Theme: ${THEMES[i][1]} (click for ${next[1]})`;
  btn.setAttribute('aria-label', btn.title);
  btn.dataset.next = next[0];
}
function setTheme(t) {
  Motion.themeFade();
  window.applyTheme(t);
  try { localStorage.setItem('theme', t); } catch {}
  renderThemeSeg();
}
// The theme switch on narrow screens and the one in the account menu.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-set]');
  if (b) setTheme(b.dataset.themeSet);
});
$('#themeCycle').addEventListener('click', (e) => {
  setTheme(e.currentTarget.dataset.next);
  LA.play(e.currentTarget);
});
renderThemeSeg();
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]');
  if (go) { e.preventDefault(); showTab(go.dataset.goto); }
  const copy = e.target.closest('.copy');
  if (copy) { navigator.clipboard.writeText($('#' + copy.dataset.copy).value); toast('Copied'); }
});

// Phone fields (any input with inputmode="tel"): letters can't be typed, a + only at the start, at most
// 15 digits; the same message as the server explains anything else. phoneError() is the shared check.
function phoneError(v) {
  v = String(v ?? '').trim();
  if (!v) return 'Enter a phone number';
  if (!/^\+?[\d\s\-().]+$/.test(v)) return 'A phone number can only have digits (and a + at the start)';
  const digits = v.replace(/\D/g, '').replace(/^00/, '');
  if (digits.length < 10) return 'That number is too short. Enter 10 digits, or the full number with the country code.';
  if (digits.length > 15) return 'That number is too long. Phone numbers have at most 15 digits.';
  return '';
}
document.addEventListener('input', (e) => {
  const inp = e.target;
  if (!inp.matches?.('input[inputmode="tel"]')) return;
  const at = inp.selectionStart, before = inp.value;
  let v = before.replace(/[^\d+\s\-()]/g, '').replace(/(?!^)\+/g, '');
  let n = 0;
  v = v.replace(/\d/g, (d) => (++n > 15 ? '' : d));
  if (v !== before) { inp.value = v; const p = Math.max(0, at - (before.length - v.length)); inp.setSelectionRange(p, p); }
  inp.setCustomValidity(v.trim() && phoneError(v) ? phoneError(v) : '');
  inp.classList.remove('pw-bad');
});
// Meta IDs (phone number ID, business account ID): digits only.
document.addEventListener('input', (e) => {
  const inp = e.target;
  if (!inp.matches?.('input[data-digits]')) return;
  const v = inp.value.replace(/\D/g, '');
  if (v !== inp.value) inp.value = v;
  inp.setCustomValidity(v && v.length < 10 ? 'That ID looks too short. Copy it from Meta → WhatsApp → API Setup.' : '');
});
document.addEventListener('blur', (e) => {
  const inp = e.target;
  if (inp.matches?.('input[inputmode="tel"]') && inp.value.trim()) inp.classList.toggle('pw-bad', Boolean(phoneError(inp.value)));
}, true);

// Show/hide toggle on password fields (the same eye as on the sign-in pages).
const PW_EYE = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const PW_EYE_OFF = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2"/><path d="M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/></svg>';
function addPasswordEyes(root) {
  root.querySelectorAll('input[type=password]').forEach((inp) => {
    if (inp.parentElement.classList.contains('pw-wrap')) return;
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    inp.before(wrap);
    wrap.append(inp);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pw-eye'; b.innerHTML = PW_EYE; b.title = 'Show password'; b.setAttribute('aria-label', 'Show password');
    b.onclick = () => { const show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; b.innerHTML = show ? PW_EYE_OFF : PW_EYE; b.title = show ? 'Hide password' : 'Show password'; b.setAttribute('aria-label', b.title); inp.focus(); };
    wrap.append(b);
  });
}
function openModal(title, html) {
  $('#modalTitle').textContent = title;
  $('#modal .modal-box').className = 'modal-box'; // a size class from the last popup (wide, ci-box) doesn't carry over
  $('#modalBody').innerHTML = html;
  LA.hydrate($('#modalBody'));
  addPasswordEyes($('#modalBody'));
  $('#modal').classList.remove('hidden');
  return $('#modalBody');
}
// Fade/scale out, then hide.
function hideOverlay(el) {
  if (el.classList.contains('hidden') || el.classList.contains('closing')) return;
  el.classList.add('closing');
  setTimeout(() => el.classList.remove('closing') || el.classList.add('hidden'), Motion.reduce() ? 0 : 180);
}
const closeModal = () => hideOverlay($('#modal'));
// While any popup is open the page behind it stays put: scrolling only moves the popup. The page's
// scrollbar width is kept as padding so nothing shifts sideways when it's hidden.
(() => {
  const sync = () => {
    const open = [...document.querySelectorAll('.modal')].some((m) => !m.classList.contains('hidden'));
    const root = document.documentElement;
    if (open === root.classList.contains('modal-open')) return;
    if (open) root.style.setProperty('--sbw', innerWidth - root.clientWidth + 'px');
    root.classList.toggle('modal-open', open);
  };
  const watch = new MutationObserver(sync);
  document.querySelectorAll('.modal').forEach((m) => watch.observe(m, { attributes: true, attributeFilter: ['class'] }));
})();
$('#modalClose').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => e.target.id === 'modal' && closeModal());

// Styled replacement for window.confirm(). Resolves true/false.
// check: a label the person must tick before confirming (e.g. consent).
function confirmDialog({ title, message = '', confirmText = 'OK', danger = false, check = '' }) {
  return new Promise((resolve) => {
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').innerHTML = message + (check ? `<label class="confirm-check"><input type="checkbox" id="confirmCheck" /> <span>${check}</span></label>` : '');
    const yes = $('#confirmYes');
    yes.textContent = confirmText;
    yes.className = 'btn ' + (danger ? 'danger-solid' : 'primary');
    yes.disabled = Boolean(check);
    if (check) $('#confirmCheck').onchange = (e) => { yes.disabled = !e.target.checked; };
    $('#confirm').classList.remove('hidden');
    yes.focus();
    const done = (v) => {
      hideOverlay($('#confirm'));
      yes.onclick = $('#confirmNo').onclick = $('#confirm').onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    yes.onclick = () => done(true);
    $('#confirmNo').onclick = () => done(false);
    $('#confirm').onclick = (e) => { if (e.target.id === 'confirm') done(false); }; // (returning false from onclick would cancel every click inside, e.g. the checkbox)
    document.addEventListener('keydown', onKey, true);
  });
}

// Ceramic ON/OFF switch markup.
const toggleHtml = ({ checked, attrs = '', size = '' }) =>
  `<span class="toggle ${size}"><input type="checkbox" ${checked ? 'checked' : ''} ${attrs} /><span class="track"><span class="lbl on">ON</span><span class="lbl off">OFF</span><span class="knob"></span></span></span>`;

// A person's avatar colour: a pastel hue from their number, the same everywhere they appear.
function avatarStyle(seed) {
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `--av-h:${(h % 360)}`;
}

// Skeleton placeholders: shimmering shapes of what's loading. Static markup asks for one with
// data-skel="kind:count"; the real render replaces it.
const Skel = {
  line: (w = 70, cls = '') => `<span class="sk sk-line ${cls}" style="width:${w}%"></span>`,
  rows: (n = 6, avatar = true) => Array.from({ length: n }, (_, i) => `<div class="sk-row">${avatar ? '<span class="sk sk-circle"></span>' : ''}<span class="sk-col">${Skel.line(40 + ((i * 17) % 35))}${Skel.line(60 + ((i * 23) % 30), 'sm')}</span></div>`).join(''),
  notif: (n = 5) => `<div class="card nt-card sk-pad">${Array.from({ length: n }, (_, i) => `<div class="sk-row"><span class="sk sk-square"></span><span class="sk-col">${Skel.line(45 + ((i * 13) % 30))}${Skel.line(75, 'sm')}${Skel.line(18, 'xs')}</span></div>`).join('')}</div>`,
  kpi: (n = 4) => Array.from({ length: n }, () => `<div class="kpi sk-kpi">${Skel.line(45, 'sm')}${Skel.line(35, 'big')}${Skel.line(60, 'xs')}<span class="sk sk-block"></span></div>`).join(''),
  card: (n = 3) => Array.from({ length: n }, () => `<div class="card sk-cardbox"><span class="sk-row tight"><span class="sk sk-square"></span><span class="sk-col">${Skel.line(55)}${Skel.line(35, 'sm')}</span></span>${Skel.line(90, 'sm')}${Skel.line(70, 'sm')}</div>`).join(''),
  folder: (n = 8) => `<div class="cp-folders">${Array.from({ length: n }, () => `<div class="sk-folder"><span class="sk sk-tab"></span><span class="sk sk-body"></span></div>`).join('')}</div>`,
  person: (n = 12) => `<div class="ct-grid sk-pad">${Array.from({ length: n }, (_, i) => `<div class="sk-person"><span class="sk sk-circle lg"></span>${Skel.line(55 + ((i * 11) % 25))}${Skel.line(40, 'sm')}</div>`).join('')}</div>`,
  table: (n = 8) => `<div class="sk-pad">${Array.from({ length: n }, (_, i) => `<div class="sk-row tr"><span class="sk sk-circle sm"></span><span class="sk-col">${Skel.line(30 + ((i * 7) % 20))}${Skel.line(20, 'xs')}</span>${Skel.line(14)}${Skel.line(10)}${Skel.line(12)}</div>`).join('')}</div>`,
  stat: (n = 4) => Array.from({ length: n }, () => `<div class="sk-stat">${Skel.line(55, 'xs')}${Skel.line(30, 'big')}</div>`).join(''),
  chart: () => `<div class="sk-chart">${[38, 62, 45, 80, 55, 70, 30, 66, 50, 74, 42, 58, 85, 60].map((h) => `<span class="sk" style="height:${h}%"></span>`).join('')}</div>`,
  bars: (n = 4) => `<div class="sk-bars">${Array.from({ length: n }, (_, i) => `<div>${Skel.line(25, 'sm')}<span class="sk sk-bar" style="width:${92 - i * 18}%"></span></div>`).join('')}</div>`,
  lines: (n = 3) => `<div class="sk-lines">${Array.from({ length: n }, (_, i) => `<div class="sk-row tight">${Skel.line(50 + ((i * 19) % 35))}${Skel.line(18, 'sm')}</div>`).join('')}</div>`,
  bubbles: () => `<div class="sk-bubbles">${[['in', 46], ['in', 30], ['out', 52], ['in', 38], ['out', 28], ['out', 44]].map(([d, w]) => `<span class="sk sk-bubble ${d}" style="width:${w}%"></span>`).join('')}</div>`,
};
document.querySelectorAll('[data-skel]').forEach((el) => {
  const [kind, n] = el.dataset.skel.split(':');
  if (!el.children.length && Skel[kind]) el.innerHTML = Skel[kind](Number(n) || undefined);
});

// Animated Lucide icons (see icons.js).
const icon = (name, size = 18) => LA.icon(name, size);
const emptyState = ({ icon: ic, title, text, actions = '' }) =>
  `<div class="empty"><div class="empty-ico">${icon(ic, 28)}</div><h3>${title}</h3><p>${text}</p>${actions ? `<div class="row tight">${actions}</div>` : ''}</div>`;
const emptyMini = (ic, html) => `<div class="empty-mini"><span class="ico">${icon(ic, 18)}</span><span>${html}</span></div>`;

document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function renderMode() {
  const demo = state.settings.demoMode;
  $('#modeBadge').className = 'badge ' + (demo ? 'demo' : 'live');
  $('#modeBadge').textContent = demo ? 'Demo' : 'Live';
  $('#demoBanner').classList.toggle('hidden', !demo);
}

// --- Default country: a picker with flag, ISO code, name and calling code -------------------------
// Which country a shared code means when only the code is known (+1 is the US and Canada, +7 Russia and Kazakhstan…).
const CC_PREFERRED = { 1: 'US', 7: 'RU', 44: 'GB', 39: 'IT', 61: 'AU', 47: 'NO', 358: 'FI', 590: 'GP', 262: 'RE', 212: 'MA' };
const flagImg = (iso, size = 20) => `<img class="cc-flag" src="https://flagcdn.com/${iso.toLowerCase()}.svg" width="${size}" height="${Math.round(size * 0.75)}" alt="" loading="lazy" onerror="this.remove()" />`;
const countryOf = (iso, code) => COUNTRIES.find((c) => c[0] === iso) || COUNTRIES.find((c) => c[0] === CC_PREFERRED[code]) || COUNTRIES.find((c) => c[2] === String(code));
function setCountry(iso, code) {
  const c = countryOf(iso, code);
  $('#setCC').value = c ? c[2] : String(code || '').replace(/\D/g, '').slice(0, 3);
  $('#setCountry').value = c ? c[0] : '';
  $('#ccPick').innerHTML = c
    ? `${flagImg(c[0])}<b class="cc-iso">${c[0]}</b><span class="cc-name">${esc(c[1])}</span><span class="cc-code">+${c[2]}</span>${icon('chevron-down', 16)}`
    : `<span class="cc-name muted">Choose a country</span>${icon('chevron-down', 16)}`;
}
$('#ccPick').addEventListener('click', (e) => {
  const btn = e.currentTarget, r = btn.getBoundingClientRect();
  const el = Sheet.Menu.panel(r.left, r.bottom + 6, `<div class="search-wrap cc-search">${icon('search', 15)}<input class="search" id="ccQ" placeholder="Search country or code" autocomplete="off" /></div><div class="cc-list" id="ccList" role="listbox"></div>`);
  el.classList.add('cc-pop');
  el.style.width = r.width + 'px';
  const current = $('#setCountry').value;
  const draw = () => {
    const q = $('#ccQ', el).value.trim().toLowerCase().replace(/^\+/, '');
    const list = COUNTRIES.filter((c) => !q || c[1].toLowerCase().includes(q) || c[0].toLowerCase() === q || c[2].startsWith(q));
    $('#ccList', el).innerHTML = list.map((c) => `<button type="button" role="option" class="cc-opt ${c[0] === current ? 'on' : ''}" data-cc="${c[0]}" aria-selected="${c[0] === current}">${flagImg(c[0], 18)}<b class="cc-iso">${c[0]}</b><span class="cc-name">${esc(c[1])}</span><span class="cc-code">+${c[2]}</span></button>`).join('') || '<p class="tm-note" style="text-align:center;padding:12px 0">No country matches.</p>';
  };
  draw();
  setTimeout(() => {
    $('#ccQ', el).focus({ preventScroll: true });
    // Scroll only the list to the current country (scrollIntoView would move the page too and leave the list behind).
    const list = $('#ccList', el), on = list.querySelector('.cc-opt.on');
    if (on) list.scrollTop = on.offsetTop - list.clientHeight / 2 + on.offsetHeight / 2;
  }, 20);
  $('#ccQ', el).addEventListener('input', draw);
  $('#ccQ', el).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') el.querySelector('.cc-opt')?.click(); });
  $('#ccList', el).addEventListener('click', (ev) => {
    const o = ev.target.closest('[data-cc]');
    if (!o) return;
    const c = COUNTRIES.find((x) => x[0] === o.dataset.cc);
    setCountry(c[0], c[2]);
    Sheet.Menu.close();
    btn.focus();
  });
});

function renderSettings() {
  const s = state.settings;
  $('#setDemo').checked = s.demoMode;
  $('#demoRow').classList.toggle('hidden', !s.demoAllowed); // demo mode is only for our own workspaces
  setCountry(s.defaultCountry, s.defaultCountryCode || '91');
  $('#setGraph').value = s.graphVersion || '';
  $('#setConc').value = s.concurrencyPerNumber;
  $('#setDelay').value = s.delayMsPerNumber;
  $('#setVerify').value = s.webhookVerifyToken || '';
  $('#webhookUrl').value = location.origin + '/webhook';
  renderAiSettings();
  const la = s.leadAgent || {};
  $('#laEnabled').checked = Boolean(la.enabled);
  $('#laAuto').checked = Boolean(la.autoReply);
  $('#laAuto').disabled = !la.enabled;
  $('#laAutoRow').classList.toggle('dim', !la.enabled);
  if (document.activeElement !== $('#laBusiness')) $('#laBusiness').value = la.business || '';
  if (document.activeElement !== $('#laQualified')) $('#laQualified').value = la.qualified || '';
  renderMode();
}

async function saveSettings(extra = {}) {
  state.settings = await api('/settings', {
    method: 'PUT',
    body: {
      demoMode: $('#setDemo').checked,
      defaultCountryCode: $('#setCC').value.replace(/\D/g, ''),
      defaultCountry: $('#setCountry').value,
      graphVersion: $('#setGraph').value.trim() || 'v21.0',
      concurrencyPerNumber: Number($('#setConc').value),
      delayMsPerNumber: Number($('#setDelay').value),
      webhookVerifyToken: $('#setVerify').value.trim(),
      ...extra,
    },
  });
  renderSettings();
  // Country code affects which numbers are valid.
  window.SendPage?.recheck();
}

$('#saveSettings').addEventListener('click', (e) => guard(async () => { await saveSettings(); toast('Settings saved'); }, e.target));
$('#setDemo').addEventListener('change', () =>
  guard(async () => {
    if (!$('#setDemo').checked) {
      const ok = await confirmDialog({
        title: 'Switch to live sending?',
        message: 'With demo mode off, campaigns send <strong>real WhatsApp messages</strong> through your API and Meta charges for each one.',
        confirmText: 'Go live',
      });
      if (!ok) { $('#setDemo').checked = true; return; }
    }
    await saveSettings();
    toast(state.settings.demoMode ? 'Demo mode on' : 'Live mode — real messages will be sent');
  })
);

// Inbox lead assistant: on/off, what it knows about the business, what counts as qualified.
async function saveLeadAgent(note) {
  state.settings = await api('/settings', { method: 'PUT', body: { leadAgent: { enabled: $('#laEnabled').checked, autoReply: $('#laAuto').checked, business: $('#laBusiness').value, qualified: $('#laQualified').value } } });
  renderSettings();
  if (note) toast(note);
}
$('#laSave').addEventListener('click', (e) => guard(() => saveLeadAgent('Lead assistant saved'), e.target));
$('#laAuto').addEventListener('change', async (e) => {
  if (e.target.checked && !state.settings.demoMode) {
    const ok = await confirmDialog({ title: 'Let the AI reply on its own?', message: 'Live mode: the AI will send real WhatsApp messages to your customers without anyone approving them. It holds back when a person is needed, after an opt-out, when your team is active in the chat, and after 5 auto-replies in an hour. Make sure “About your business” is filled in.', confirmText: 'Turn on auto-reply' });
    if (!ok) { e.target.checked = false; return; }
  }
  guard(() => saveLeadAgent(e.target.checked ? 'Auto-reply on' : 'Auto-reply off: the AI only drafts'));
});
$('#laEnabled').addEventListener('change', () =>
  guard(async () => {
    if ($('#laEnabled').checked && !$('#laBusiness').value.trim()) toast('Tip: write about your business first, so drafts can answer questions', 'error');
    await saveLeadAgent($('#laEnabled').checked ? 'The AI will draft replies to new messages. You send each one.' : 'Automatic drafts off');
  })
);

// AI assistant: provider, keys and model, saved on their own so a half-typed key never rides along with other settings.
state.aiTab = null; // provider shown in the card; starts as the active one
function renderAiSettings() {
  const s = state.settings;
  const shown = state.aiTab || s.aiProvider;
  $$('#aiProviderSeg button').forEach((b) => b.classList.toggle('active', b.dataset.provider === shown));
  $$('.ai-settings [data-for]').forEach((el) => el.classList.toggle('hidden', el.dataset.for !== shown));
  $('#geminiKeyState').textContent = s.hasGeminiKey ? (s.geminiKeyFromEnv ? 'set from the server environment' : `saved ${s.geminiKeyMasked}`) : 'not set';
  $('#aiKeyState').textContent = s.aiKeyMasked ? `saved ${s.aiKeyMasked}` : s.aiKeyFromEnv ? 'set from the server environment' : 'not set';
  $('#setGeminiKey').placeholder = s.geminiKeyMasked ? 'Paste a new key to replace it' : 'Paste your key';
  $('#setAiKey').placeholder = s.aiKeyMasked ? 'Paste a new key to replace it' : 'sk-ant-…';
  if (document.activeElement !== $('#setGeminiModel')) $('#setGeminiModel').value = s.geminiModel || '';
  $('#removeAiKey').classList.toggle('hidden', !(shown === 'gemini' ? s.geminiKeyMasked : s.aiKeyMasked));
  $('#saveAiKey').textContent = shown === s.aiProvider ? 'Save' : `Save and use ${shown === 'gemini' ? 'Gemini' : 'Claude'}`;
  LA.hydrate($('.ai-settings'));
  // The Assistant header shows the model with its maker's logo.
  if ($('#asProvider')) {
    const gem = s.aiProvider === 'gemini';
    $('#asProvider').innerHTML = `<img class="prov-logo" src="/brand/${gem ? 'gemini' : 'claude'}.svg" alt="" /><span>${esc(gem ? s.geminiModel : 'Claude Opus 5.5')}</span>`;
  }
}
$('#aiProviderSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-provider]');
  if (!b) return;
  state.aiTab = b.dataset.provider;
  renderAiSettings();
  Motion.segs($('.ai-settings'));
});
async function putAi(body) {
  state.settings = await api('/settings', { method: 'PUT', body });
  $('#setAiKey').value = $('#setGeminiKey').value = '';
  renderSettings();
}
function aiFormBody() {
  const shown = state.aiTab || state.settings.aiProvider;
  const body = { aiProvider: shown };
  if (shown === 'gemini') {
    if ($('#setGeminiKey').value.trim()) body.geminiApiKey = $('#setGeminiKey').value.trim();
    body.geminiModel = $('#setGeminiModel').value.trim();
  } else if ($('#setAiKey').value.trim()) body.anthropicApiKey = $('#setAiKey').value.trim();
  return body;
}
$('#saveAiKey').addEventListener('click', (e) =>
  guard(async () => {
    const before = state.settings.aiProvider;
    await putAi(aiFormBody());
    state.aiTab = null;
    renderAiSettings();
    toast(before !== state.settings.aiProvider ? `The assistant now uses ${state.settings.aiProvider === 'gemini' ? 'Gemini' : 'Claude'}. New chats will use it.` : 'AI settings saved');
  }, e.target)
);
$('#testAiKey').addEventListener('click', (e) =>
  guard(async () => {
    await putAi(aiFormBody());
    state.aiTab = null;
    const r = await api('/ai/test', { method: 'POST' });
    toast(`Key works · ${r.model}`);
  }, e.target)
);
$('#removeAiKey').addEventListener('click', (e) =>
  guard(async () => {
    const gemini = (state.aiTab || state.settings.aiProvider) === 'gemini';
    const ok = await confirmDialog({ title: `Remove the ${gemini ? 'Gemini' : 'Anthropic'} key?`, message: 'The assistant stops working with this provider until you add a key again.', confirmText: 'Remove', danger: true });
    if (!ok) return;
    await putAi(gemini ? { removeGeminiApiKey: true } : { removeAnthropicApiKey: true });
    toast('API key removed');
  }, e.target)
);

// ---------------------------------------------------------------------------
// Sender numbers
// ---------------------------------------------------------------------------

async function loadSenders() {
  state.senders = await api('/senders');
  // Keep previous selection; default to all enabled numbers.
  const ids = new Set(state.senders.filter((s) => s.enabled).map((s) => s.id));
  if (!state.selectedSenders.size) state.selectedSenders = ids;
  else state.selectedSenders = new Set([...state.selectedSenders].filter((x) => ids.has(x)));
  renderSenders();
  renderSenderChecks();
  window.Assistant?.senders();
}

// Usage strip on each number card (today vs daily limit, totals).
function numStats(s) {
  const st = state.stats?.senders.find((x) => x.id === s.id);
  if (!st) return '';
  const limit = st.limit === undefined ? 250 : st.limit;
  const used = limit ? st.today / limit : 0;
  return `<div class="num-stats">
    <div class="num-stat"><b>${st.today.toLocaleString()}${limit ? ` <span>/ ${limit.toLocaleString()}</span>` : ''}</b><span>sent today${st.limit === undefined ? ' · limit unknown' : ''}</span>
      <div class="meter ${used >= 1 ? 'over' : used >= 0.8 ? 'warn' : ''}"><span data-w="${Math.min(100, used * 100).toFixed(2)}" data-k="nc-${s.id}"></span></div></div>
    <div class="num-stat"><b>${fmtNum(st.sent)}</b><span>sent in total</span></div>
    <div class="num-stat"><b>${st.sent ? pct(st.delivered, st.sent) + '%' : '—'}</b><span>delivered</span></div>
  </div>`;
}

function renderSenders() {
  const list = $('#senderList');
  if (!state.senders.length) {
    list.innerHTML = emptyState({
      icon: 'phone',
      title: 'No numbers yet',
      text: `Add each WhatsApp number from your Meta Business account. Messages are spread across all the numbers you add.${state.settings.demoMode ? ' For Demo mode, a label and any placeholder ID is enough.' : ''}`,
      actions: `<button class="btn primary" onclick="senderForm()">${icon('plus', 16)}Add number</button>${state.settings.demoMode ? `<button class="btn quiet" data-goto="overview">${icon('layout-grid', 16)}Or load a demo workspace</button>` : ''}`,
    });
    return;
  }
  list.innerHTML = state.senders
    .map(
      (s) => `
    <div class="card sender-card">
      <div class="sender-id">
        ${senderPhotoHtml(s)}
        <div class="sender-who">
          <b class="sender-vname" title="${s.verifiedName ? 'The business name customers see on WhatsApp' : esc(s.label)}">${esc(s.verifiedName || s.label)}</b>
          <span class="sender-num">${esc(s.displayPhone || '—')}</span>
        </div>
        <label title="${s.enabled ? 'Number is in use' : 'Number is switched off'}">${toggleHtml({ checked: s.enabled, attrs: `data-enable="${s.id}"`, size: 'sm' })}</label>
      </div>
      ${numStats(s)}
      <dl class="kv">
        ${s.verifiedName ? `<dt>Label</dt><dd>${esc(s.label)}</dd>` : ''}
        <dt>Phone number ID</dt><dd>${esc(s.phoneNumberId)}</dd>
        <dt>WABA ID</dt><dd>${esc(s.wabaId || '—')}</dd>
        <dt>Access token</dt><dd>${s.hasToken ? esc(s.accessTokenMasked) : '<span class="muted">not set</span>'}</dd>
        ${s.qualityRating ? `<dt>Quality</dt><dd>${esc(s.qualityRating)}</dd>` : ''}
        ${s.messagingLimit ? `<dt>Daily limit</dt><dd>${esc(s.messagingLimit)}</dd>` : ''}
        ${s.lastCheckedAt ? `<dt>Connection</dt><dd class="kv-ok">Connected · checked ${esc(relTime(s.lastCheckedAt))}</dd>` : ''}
      </dl>
      <div class="row tight">
        <button class="btn sm" data-test="${s.id}">${icon('zap', 15)}Test connection</button>
        <button class="btn quiet sm" data-edit="${s.id}">Edit</button>
        <button class="btn quiet danger sm" data-del="${s.id}" style="margin-left:auto">${icon('delete', 15)}Delete</button>
      </div>
    </div>`
    )
    .join('');
  Motion.values(list);
  // Numbers whose photo hasn't been read yet: ask Meta once, quietly.
  if (!state.settings.demoMode) for (const s of state.senders) if (s.hasToken && !s.photoCheckedAt && !photoAsked.has(s.id)) {
    photoAsked.add(s.id);
    api(`/senders/${s.id}/photo/refresh`, { method: 'POST' }).then((x) => { if (x.photoUrl) loadSenders(); }).catch(() => {});
  }
}
const photoAsked = new Set();

const senderPhotoHtml = (s) => `<span class="sender-photo">${s?.photoUrl ? `<img src="${esc(s.photoUrl)}" alt="" onerror="this.remove()">` : ''}<b>${esc((s?.label || '?').trim().charAt(0).toUpperCase())}</b></span>`;
// The profile photo editor: its own popup above Edit number. It opens on the number's current photo;
// drag to move, zoom, rotate and straighten, or choose another picture. Resolves with a 640×640 JPG
// (a size WhatsApp takes as is), or null when closed without saving.
function photoEditor(sender) {
  return new Promise((resolve) => {
    let el = $('#photoModal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'photoModal';
      el.className = 'modal hidden';
      document.body.append(el);
    }
    const name = esc(sender.verifiedName || sender.label || '');
    el.innerHTML = `<div class="modal-box pe-box" role="dialog" aria-labelledby="peTitle">
      <div class="modal-head"><h2 id="peTitle">Edit profile photo</h2><button type="button" class="icon-btn" data-pe="close" aria-label="Close">${icon('x', 18)}</button></div>
      <div class="pe-body">
        <div class="pe-stage" id="peStage"><canvas width="640" height="640"></canvas><div class="pe-empty hidden" id="peEmpty">${icon('upload', 22)}<span>Loading the current photo…</span></div></div>
        <div class="pe-side">
          <div class="pe-preview">
            <div class="pe-chat"><span class="pe-small"><canvas width="112" height="112"></canvas></span><div><b>${name}</b><small>How it looks in a chat list</small></div></div>
          </div>
          <div class="pe-ctl">
            <label for="peZoom">Zoom <output id="peZoomOut">1.0×</output></label>
            <div class="pe-zoom">
              <button type="button" class="pe-step" data-pe="out" aria-label="Zoom out">−</button>
              <input type="range" class="pe-range" id="peZoom" min="1" max="4" step="0.01" value="1">
              <button type="button" class="pe-step" data-pe="in" aria-label="Zoom in">+</button>
            </div>
          </div>
          <div class="pe-ctl">
            <label for="peTilt">Straighten <output id="peTiltOut">0°</output></label>
            <input type="range" class="pe-ruler" id="peTilt" min="-15" max="15" step="0.5" value="0" title="Double-click to set back to 0°">
            <div class="pe-ruler-scale" aria-hidden="true"><span>−15°</span><span>−10°</span><span>−5°</span><span>0°</span><span>+5°</span><span>+10°</span><span>+15°</span></div>
          </div>
          <div class="pe-tools">
            <button type="button" class="btn sm" data-pe="left" title="Rotate left">${icon('undo-2', 14)}Rotate</button>
            <button type="button" class="btn sm" data-pe="right" title="Rotate right">${icon('redo-2', 14)}Rotate</button>
            <button type="button" class="btn quiet sm" data-pe="reset">Reset</button>
          </div>
          <label class="btn sm pe-choose">${icon('upload', 14)}Choose another photo<input type="file" hidden accept="image/*" id="peFile"></label>
          <p class="sub pe-hint">Drag the photo to move it. Use your own logo or brand image: WhatsApp's business rules don't allow other brands' logos or misleading pictures.</p>
          <p class="pe-warn hidden" id="peWarn">This picture is small and may look blurry. Use one at least 640 pixels wide if you can.</p>
        </div>
      </div>
      <div class="modal-actions"><button type="button" class="btn quiet" data-pe="close">Cancel</button><button type="button" class="btn primary" data-pe="save" disabled>Save photo</button></div>
    </div>`;
    el.classList.remove('hidden');

    const V = 640; // the square that's uploaded, in pixels
    const stage = $('#peStage canvas', el), ctx = stage.getContext('2d');
    const previews = [$('.pe-small canvas', el)];
    const zoomEl = $('#peZoom', el), tiltEl = $('#peTilt', el), saveBtn = $('[data-pe="save"]', el);
    let img = null, zoom = 1, quarter = 0, tilt = 0, x = 0, y = 0; // x, y: photo centre offset, in square pixels

    // The photo's scale that fills the square at zoom 1, for the current angle (so rotating never shows corners).
    const angle = () => (quarter * 90 + tilt) * Math.PI / 180;
    const fit = () => {
      const c = Math.abs(Math.cos(angle())), s = Math.abs(Math.sin(angle()));
      return V * (c + s) / Math.min(img.naturalWidth, img.naturalHeight);
    };
    // Keep the square inside the photo: limit the offset in the photo's own (rotated) frame.
    const clamp = () => {
      const a = angle(), k = fit() * zoom, c = Math.abs(Math.cos(a)) + Math.abs(Math.sin(a));
      const w = img.naturalWidth * k, h = img.naturalHeight * k;
      const u = x * Math.cos(-a) - y * Math.sin(-a), v = x * Math.sin(-a) + y * Math.cos(-a);
      const lu = Math.max(0, (w - V * c) / 2), lv = Math.max(0, (h - V * c) / 2);
      const cu = Math.max(-lu, Math.min(lu, u)), cv = Math.max(-lv, Math.min(lv, v));
      x = cu * Math.cos(a) - cv * Math.sin(a); y = cu * Math.sin(a) + cv * Math.cos(a);
    };
    const paint = (c, size) => {
      const g = c.getContext('2d'), k = size / V, sc = fit() * zoom * k;
      g.save();
      g.fillStyle = '#fff';
      g.fillRect(0, 0, size, size);
      g.translate(size / 2 + x * k, size / 2 + y * k);
      g.rotate(angle());
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, -img.naturalWidth * sc / 2, -img.naturalHeight * sc / 2, img.naturalWidth * sc, img.naturalHeight * sc);
      g.restore();
    };
    // Sliders and their readouts follow the editor's state, whatever changed it (drag, wheel, buttons, Reset).
    const sync = () => {
      zoomEl.value = zoom;
      zoomEl.style.setProperty('--p', `${((zoom - 1) / 3) * 100}%`);
      $('#peZoomOut', el).textContent = `${zoom.toFixed(1)}×`;
      tiltEl.value = tilt;
      $('#peTiltOut', el).textContent = `${tilt > 0 ? '+' : tilt < 0 ? '−' : ''}${Math.abs(tilt)}°`;
    };
    const draw = () => {
      sync();
      if (!img) return;
      clamp();
      paint(stage, V);
      for (const p of previews) paint(p, p.width);
    };
    const reset = () => { zoom = 1; quarter = 0; tilt = 0; x = y = 0; draw(); };
    const load = (src, isNew) => new Promise((ok) => {
      const im = new Image();
      im.onload = () => {
        img = im;
        $('#peEmpty', el).classList.add('hidden');
        $('#peWarn', el).classList.toggle('hidden', Math.min(im.naturalWidth, im.naturalHeight) >= 192);
        saveBtn.disabled = false;
        reset();
        ok(true);
      };
      im.onerror = () => {
        if (isNew) toast("That file isn't a picture this browser can open. Use a JPG or PNG.", 'error');
        else showEmpty('No profile photo yet. Choose one to start.');
        ok(false);
      };
      im.src = src;
    });
    const showEmpty = (text) => { const e = $('#peEmpty', el); e.classList.remove('hidden'); $('span', e).textContent = text; };
    showEmpty('Loading the current photo…');
    load(`/api/senders/${sender.id}/photo/file?t=${Date.now()}`, false);

    zoomEl.addEventListener('input', () => { zoom = Number(zoomEl.value); draw(); });
    tiltEl.addEventListener('input', () => { tilt = Number(tiltEl.value); draw(); });
    tiltEl.addEventListener('dblclick', () => { tilt = 0; draw(); });
    let drag = null;
    stage.addEventListener('pointerdown', (e) => { if (!img) return; drag = { px: e.clientX, py: e.clientY, x, y }; stage.setPointerCapture(e.pointerId); });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = V / stage.getBoundingClientRect().width; // screen pixels to square pixels
      x = drag.x + (e.clientX - drag.px) * r;
      y = drag.y + (e.clientY - drag.py) * r;
      draw();
    });
    stage.addEventListener('pointerup', () => { drag = null; });
    stage.addEventListener('wheel', (e) => { if (!img) return; e.preventDefault(); zoom = Math.max(1, Math.min(4, zoom - e.deltaY * 0.002)); draw(); }, { passive: false });
    $('#peFile', el).addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      const url = URL.createObjectURL(f);
      load(url, true).finally(() => URL.revokeObjectURL(url));
    });

    const done = (v) => { document.removeEventListener('keydown', onKey, true); hideOverlay(el); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey, true);
    el.addEventListener('click', (e) => {
      if (e.target === el) return done(null); // clicking outside the box
      const b = e.target.closest('[data-pe]');
      if (!b) return;
      const act = b.dataset.pe;
      if (act === 'close') return done(null);
      if (act === 'reset') return reset();
      if (act === 'in' || act === 'out') { zoom = Math.max(1, Math.min(4, Math.round((zoom + (act === 'in' ? 0.25 : -0.25)) * 4) / 4)); return draw(); }
      if (act === 'left' || act === 'right') { quarter = (quarter + (act === 'left' ? 3 : 1)) % 4; return draw(); }
      if (act === 'save' && img) { draw(); stage.toBlob((blob) => done(blob), 'image/jpeg', 0.92); }
    });
  });
}

// Change the WhatsApp profile photo (JPG or PNG; Meta shows it as a circle, so square works best).
async function uploadSenderPhoto(id, file) {
  const res = await fetch(`/api/senders/${id}/photo`, { method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || (res.status === 413 ? 'That photo is too big: WhatsApp accepts up to 5 MB' : `Upload failed (${res.status})`));
  return json;
}
$('#senderList').addEventListener('change', (e) => {
  const id = e.target.dataset.enable;
  if (!id) return;
  guard(async () => {
    await api('/senders/' + id, { method: 'PUT', body: { enabled: e.target.checked } });
    if (e.target.checked) state.selectedSenders.add(id);
    await loadSenders();
  });
});

$('#senderList').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.edit) senderForm(state.senders.find((s) => s.id === b.dataset.edit));
  if (b.dataset.del)
    guard(async () => {
      const s = state.senders.find((x) => x.id === b.dataset.del);
      const ok = await confirmDialog({ title: `Delete “${esc(s.label)}”?`, message: 'The number and its saved token are removed from this app. Nothing changes in your Meta account.', confirmText: 'Delete', danger: true });
      if (!ok) return;
      await api('/senders/' + b.dataset.del, { method: 'DELETE' });
      await loadSenders();
    }, b);
  if (b.dataset.test)
    guard(async () => {
      const r = await api(`/senders/${b.dataset.test}/test`, { method: 'POST' });
      toast(`✓ Connected: ${r.info.display_phone_number} (${r.info.verified_name || 'unverified'})`);
      await loadSenders();
    }, b);
});

function senderForm(s = null) {
  // Live numbers are checked with Meta before they're saved (the server checks again on Save).
  const live = !state.settings.demoMode;
  const shared = !s && state.senders.find((x) => x.hasToken && x.wabaId);
  const body = openModal(s ? 'Edit number' : 'Add sender number', `
    <form id="senderForm" novalidate>
      ${s && live && s.hasToken ? `<div class="sf-photo"><span id="sfPhoto">${senderPhotoHtml(s)}</span><div><b>WhatsApp profile photo</b><span class="sub">What customers see on this number's chat. Use your own logo or brand image.</span></div><button type="button" class="btn sm sender-photo-btn" id="sfPhotoBtn">${icon('square-pen', 14)}Edit</button></div>` : ''}
      <label>Label <span class="opt">up to 40 characters</span><input name="label" required maxlength="40" placeholder="e.g. Sales line 1" value="${esc(s?.label)}" /></label>
      <label>Phone number ID <input name="phoneNumberId" required inputmode="numeric" data-digits maxlength="17" placeholder="From Meta → WhatsApp → API Setup (digits)" value="${esc(s?.phoneNumberId)}" /></label>
      <label>WhatsApp Business Account ID <span class="opt">${live ? 'found from Meta when the number is checked' : 'needed to sync templates'}</span><input name="wabaId" inputmode="numeric" data-digits maxlength="17" placeholder="${live ? 'Leave blank, or paste the Business portfolio ID' : 'Digits'}" value="${esc(s?.wabaId)}" /></label>
      ${s?.hasToken
        ? `<div class="field-label">Access token</div>
           <div class="sf-token" id="sfSaved"><span>${icon('lock', 14)}Saved token ending in <b>${esc((s.accessTokenMasked || '').slice(-4))}</b></span><button type="button" class="btn sm" id="sfReplace">Replace token</button></div>
           <label class="hidden" id="sfTokenWrap">New access token<input name="accessToken" type="password" autocomplete="off" placeholder="Paste the new token" /></label>`
        : `<label>Access token${live ? '' : ' <span class="opt">optional in demo mode</span>'}<input name="accessToken" type="password" autocomplete="off" placeholder="${shared ? 'Leave blank to use the token of ' + esc(shared.label) : 'Permanent system-user token'}" /></label>`}
      <label>Display phone <span class="opt">${live ? 'filled in from Meta when the number is checked' : 'optional, for your reference'}</span><input name="displayPhone" inputmode="tel" maxlength="22" placeholder="+91 98765 43210" value="${esc(s?.displayPhone)}" /></label>
      <div class="sf-status hidden" id="sfStatus" role="status" aria-live="polite"></div>
      <p class="sub">Numbers in the same WhatsApp Business Account can share one token. It's stored only on this server and never shown in full again.</p>
      <div class="modal-actions">
        ${live ? '<button type="button" class="btn quiet" id="sfTest" data-icon="zap" style="margin-right:auto">Test connection</button>' : ''}
        <button type="button" class="btn quiet" onclick="closeModal()">Cancel</button>
        <button class="btn primary">${s ? 'Save' : 'Add number'}</button>
      </div>
    </form>`);
  const form = $('#senderForm', body), status = $('#sfStatus', body);
  // Prefill WABA from an existing number to make adding more numbers quicker.
  if (!s && state.senders[0]?.wabaId) $('[name=wabaId]', body).value = state.senders[0].wabaId;
  $('#sfPhotoBtn', body)?.addEventListener('click', () => {
    const btn = $('#sfPhotoBtn', body);
    guard(async () => {
      const cropped = await photoEditor(s);
      if (!cropped) return;
      btn.classList.add('busy');
      try {
        const updated = await uploadSenderPhoto(s.id, cropped);
        $('#sfPhoto', body).innerHTML = senderPhotoHtml(updated);
        toast('Profile photo updated. Customers see it on their next look at the chat.');
        loadSenders();
      } catch (err) { toast(err.message, 'error'); } finally { btn.classList.remove('busy'); }
    });
  });
  $('#sfReplace', body)?.addEventListener('click', () => { $('#sfSaved', body).classList.add('hidden'); $('#sfTokenWrap', body).classList.remove('hidden'); $('[name=accessToken]', body).focus(); });
  const show = (kind, html) => { status.className = 'sf-status ' + kind; status.innerHTML = html; };
  // Editing the number or token means the last check no longer applies.
  form.addEventListener('input', (e) => { if (e.target.matches('[name=phoneNumberId], [name=wabaId], [name=accessToken]')) status.className = 'sf-status hidden'; });
  const fields = () => Object.fromEntries(new FormData(form));
  const firstProblem = () => {
    const d = fields();
    if (!d.label.trim()) return ['label', 'Give the number a label'];
    if (!d.phoneNumberId) return ['phoneNumberId', 'Enter the phone number ID'];
    return [...form.querySelectorAll('input')].map((i) => i.validationMessage && [i.name, i.validationMessage]).find(Boolean) || null;
  };
  const check = async () => {
    const bad = firstProblem();
    if (bad && bad[0] !== 'label') { form.querySelector(`[name=${bad[0]}]`).focus(); show('bad', esc(bad[1])); return false; }
    show('busy', '<span class="sf-spin"></span>Checking with Meta…');
    try {
      const r = await api('/senders/verify', { method: 'POST', body: { ...fields(), senderId: s?.id } });
      const i = r.info;
      $('[name=displayPhone]', body).value = i.displayPhone;
      if (i.wabaId) $('[name=wabaId]', body).value = i.wabaId;
      show('ok', `${icon('circle-check', 15)}<span><b>Connected</b> · ${esc(i.verifiedName || 'WhatsApp number')} · ${esc(i.displayPhone)}${i.qualityRating ? ` · quality ${esc(String(i.qualityRating).toLowerCase())}` : ''}${r.sharedToken ? '<br>Using the token saved for your other number in this Business Account.' : ''}</span>`);
      return true;
    } catch (err) { show('bad', esc(err.message)); return false; }
  };
  $('#sfTest', body)?.addEventListener('click', (e) => guard(check, e.currentTarget));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const bad = firstProblem();
    if (bad) { form.querySelector(`[name=${bad[0]}]`).focus(); show('bad', esc(bad[1])); return; }
    const btn = $('button.primary', form);
    guard(async () => {
      if (live) show('busy', '<span class="sf-spin"></span>Checking with Meta, then saving…');
      let saved;
      try {
        if (s) saved = await api('/senders/' + s.id, { method: 'PUT', body: fields() });
        else {
          saved = await api('/senders', { method: 'POST', body: fields() });
          state.selectedSenders.add(saved.id);
        }
      } catch (err) { show('bad', esc(err.message)); return; } // the problem stays in the popup, next to the fields
      closeModal();
      if (saved.warning) toast(saved.warning, 'error', { duration: 15000 });
      else toast(s ? 'Saved' : live ? 'Number connected and added' : 'Number added');
      await loadSenders();
    }, btn);
  });
}
window.senderForm = senderForm;
window.closeModal = closeModal;
$('#addSender').addEventListener('click', () => senderForm());

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

async function loadTemplates() {
  state.templates = await api('/templates');
  renderTemplates();
  renderTemplateSelect();
}

const comp = (t, type) => (t.components || []).find((c) => (c.type || '').toUpperCase() === type);

function renderTemplates() {
  const list = $('#templateList');
  if (!state.templates.length) {
    list.innerHTML = emptyState({
      icon: 'template',
      title: 'No templates yet',
      text: 'WhatsApp only lets you start conversations with templates Meta has approved. Create one here and send it to Meta for review, or sync the ones you already have.',
      actions: `<button class="btn primary" onclick="templateEditor()">${icon('plus', 16)}New template</button><button class="btn" onclick="document.getElementById('syncTemplates').click()">${icon('refresh-cw', 16)}Sync from Meta</button>`,
    });
    return;
  }
  list.innerHTML = state.templates
    .map((t) => `
    <div class="card tpl-card">
      <div class="li-head">
        <h3>${esc(t.name)}</h3>
        <span class="pill ${esc(t.status)}">${esc(TPL_STATUS[String(t.status).toUpperCase()] || t.status)}</span>
      </div>
      <div class="li-meta">${esc(t.language)} · ${esc((t.category || '').toLowerCase())} · ${t.source === 'synced' ? 'in Meta' : 'demo only'}</div>
      ${t.rejectedReason ? `<div class="tpl-reason">${icon('badge-alert', 14)}<span>Meta's reason: ${esc(t.rejectedReason.toLowerCase().replace(/_/g, ' '))}. Edit it and submit again.</span></div>` : ''}
      <div class="tpl-chat"><div class="bubble">${bubbleHtml(t, {}, true)}</div></div>
      ${t.variables.length ? `<div class="var-chips">${[...new Set(t.variables.map((v) => (v.media ? v.media + ' URL' : `{{${v.name}}}`)))].map((label) => `<span class="var-chip">${esc(label)}</span>`).join('')}</div>` : '<div class="var-chips"><span class="li-meta">No variables, same message for everyone</span></div>'}
      <div class="row tight">
        <button class="btn sm" data-use="${t.id}">${icon('send', 15)}Use for sending</button>
        ${(() => { const why = tplEditBlock(t); return `<button class="btn quiet sm" data-tedit="${t.id}" ${why ? `disabled title="${esc(why)}"` : ''}>${icon('square-pen', 15)}Edit</button>`; })()}
        <button class="btn quiet danger sm" data-del="${t.id}" style="margin-left:auto">${icon('delete', 15)}Delete</button>
      </div>
    </div>`)
    .join('');
}

$('#templateList').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tedit) return templateEditor(state.templates.find((x) => x.id === b.dataset.tedit));
  if (b.dataset.use) {
    $('#templateSelect').value = b.dataset.use;
    onTemplateChange();
    showTab('send');
  }
  if (b.dataset.del)
    guard(async () => {
      const ok = await confirmDialog({ title: 'Remove this template?', message: 'It is removed from this app only. The template stays in your WhatsApp Manager.', confirmText: 'Remove', danger: true });
      if (!ok) return;
      await api('/templates/' + b.dataset.del, { method: 'DELETE' });
      await loadTemplates();
    }, b);
});

$('#syncTemplates').addEventListener('click', (e) =>
  guard(async () => {
    const r = await api('/templates/sync', { method: 'POST' });
    state.templates = r.templates;
    renderTemplates();
    renderTemplateSelect();
    toast(`Synced ${r.synced} template(s) from Meta`);
    r.errors.forEach((er) => toast(er, 'error'));
  }, e.target)
);

// --- Template editor: create a template in Meta, or edit one ------------------------------------------
// One popup for both: the form on the left, the message as WhatsApp shows it on the right (with the
// sample values). Meta reviews every new or edited template; the result arrives by itself (webhook).
const TPL_LANGS = [['en', 'English'], ['en_US', 'English (US)'], ['en_GB', 'English (UK)'], ['hi', 'Hindi'], ['te', 'Telugu'], ['ta', 'Tamil'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['mr', 'Marathi'], ['bn', 'Bengali'], ['gu', 'Gujarati'], ['pa', 'Punjabi'], ['ur', 'Urdu'], ['ar', 'Arabic'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt_BR', 'Portuguese (Brazil)'], ['id', 'Indonesian']];
const TPL_STATUS = { APPROVED: 'Approved', PENDING: 'In review', REJECTED: 'Rejected', PAUSED: 'Paused', DISABLED: 'Disabled', FLAGGED: 'Flagged', IN_APPEAL: 'In appeal', PENDING_DELETION: 'Being deleted', MANUAL: 'Demo' };
const isGoUrl = (url) => /\/go\/{{\s*\w+\s*}}$/.test(url || '');
// What the editor works on, from a saved template (or blank for a new one).
function tplSpec(t) {
  const c = (type) => (t?.components || []).find((x) => String(x.type).toUpperCase() === type);
  const h = c('HEADER'), b = c('BODY'), f = c('FOOTER'), btns = c('BUTTONS')?.buttons || [];
  return {
    name: t?.name || '', language: t?.language || 'en', category: t?.category || 'MARKETING',
    header: { format: h ? h.format : 'NONE', text: h?.text || '', sample: h?.example?.header_text?.[0] || '', file: null, preview: '' },
    body: { text: b?.text || '', samples: b?.example?.body_text?.[0] || [] },
    footer: f?.text || '',
    buttons: btns.map((x) => x.type === 'URL' ? { type: 'URL', text: x.text, mode: isGoUrl(x.url) ? 'go' : 'fixed', url: isGoUrl(x.url) ? '' : x.url }
      : x.type === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: x.text, phone: x.phone_number || '' } : { type: 'QUICK_REPLY', text: x.text }),
  };
}
const tplVarNums = (text) => [...new Set([...String(text || '').matchAll(/{{\s*(\d+)\s*}}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
// When an approved template can next be edited (Meta allows one edit a day), or null if it can be now.
function tplEditBlock(t) {
  if (t.source !== 'synced' || !t.metaId) return null;
  const st = String(t.status).toUpperCase();
  if (!['APPROVED', 'REJECTED', 'PAUSED'].includes(st)) return `Meta doesn't allow edits while a template is ${(TPL_STATUS[st] || st).toLowerCase()}`;
  if (st === 'APPROVED' && t.editedAt && Date.now() - new Date(t.editedAt) < 864e5) return `Edited in the last day. Meta allows one edit a day: you can edit again ${relTime(new Date(new Date(t.editedAt).getTime() + 864e5))}`;
  return null;
}

function templateEditor(t = null) {
  const live = !state.settings.demoMode;
  const spec = tplSpec(t);
  let linkDomain = state.settings.linkDomain || ''; // kept here so redrawing the buttons doesn't reset it
  const accounts = [...new Map(state.senders.filter((x) => x.wabaId && x.hasToken).map((x) => [x.wabaId, x])).values()];
  const body = openModal(t ? `Edit ${t.name}` : 'New template', `
    <form id="teForm" class="te" novalidate>
      <div class="te-form">
        <div class="te-row">
          <label class="te-name">Name<input name="name" ${t ? 'readonly' : ''} value="${esc(spec.name)}" placeholder="order_update" maxlength="60" autocomplete="off">${t ? '' : '<span class="te-hint">Lowercase letters, numbers and underscores</span>'}</label>
          <label>Language<select name="language" ${t ? 'disabled' : ''}>${TPL_LANGS.map(([v, l]) => `<option value="${v}" ${v === spec.language ? 'selected' : ''}>${l}</option>`).join('')}${TPL_LANGS.some(([v]) => v === spec.language) ? '' : `<option value="${esc(spec.language)}" selected>${esc(spec.language)}</option>`}</select></label>
        </div>
        <div class="te-row">
          <div class="te-field"><span class="field-label">Category</span><div class="seg te-seg" data-seg="category">${[['MARKETING', 'Marketing', 'Offers, events, news'], ['UTILITY', 'Utility', 'Updates on something they did']].map(([v, l, d]) => `<button type="button" data-v="${v}" class="${spec.category === v ? 'active' : ''}" title="${d}">${l}</button>`).join('')}</div></div>
          ${live && !t && accounts.length > 1 ? `<label>Business Account<select name="senderId">${accounts.map((x) => `<option value="${x.id}">${esc(x.verifiedName || x.label)}</option>`).join('')}</select></label>` : ''}
        </div>

        <section class="te-sec">
          <div class="te-sec-h"><b>Header</b><span class="opt">optional</span></div>
          <div class="seg te-seg" data-seg="header">${[['NONE', 'None'], ['TEXT', 'Text'], ['IMAGE', 'Image'], ['VIDEO', 'Video'], ['DOCUMENT', 'PDF']].map(([v, l]) => `<button type="button" data-v="${v}" class="${spec.header.format === v ? 'active' : ''}">${l}</button>`).join('')}</div>
          <div id="teHeaderBox"></div>
        </section>

        <section class="te-sec">
          <div class="te-sec-h"><b>Message</b><span class="te-count" id="teBodyCount"></span></div>
          <div class="te-tools">
            <button type="button" data-wrap="*" title="Bold"><b>B</b></button><button type="button" data-wrap="_" title="Italic"><i>I</i></button><button type="button" data-wrap="~" title="Strikethrough"><s>S</s></button><button type="button" data-wrap="\`\`\`" title="Monospace"><code>&lt;/&gt;</code></button>
            <button type="button" class="te-addvar" data-addvar title="Add a variable: a value filled in for each person when sending">${icon('plus', 13)}Variable</button>
          </div>
          <textarea name="bodyText" rows="8" maxlength="1024" placeholder="Hi {{1}}, your order {{2}} is on its way. Track it here: {{3}}">${esc(spec.body.text)}</textarea>
          <div id="teSamples" class="te-samples"></div>
        </section>

        <section class="te-sec">
          <div class="te-sec-h"><b>Footer</b><span class="opt">optional</span><span class="te-count" id="teFooterCount"></span></div>
          <input name="footer" maxlength="60" value="${esc(spec.footer)}" placeholder="Reply STOP to stop these messages">
        </section>

        <section class="te-sec">
          <div class="te-sec-h"><b>Buttons</b><span class="opt">optional, up to 10</span></div>
          <div id="teButtons" class="te-buttons"></div>
          <div class="te-addbtns"><button type="button" class="btn sm" data-addbtn="QUICK_REPLY">${icon('reply', 14)}Quick reply</button><button type="button" class="btn sm" data-addbtn="URL">${icon('external-link', 14)}Website</button><button type="button" class="btn sm" data-addbtn="PHONE_NUMBER">${icon('phone', 14)}Call</button></div>
        </section>
        <div class="sf-status hidden" id="teStatus" role="status" aria-live="polite"></div>
      </div>
      <aside class="te-preview">
        <span class="te-cap">Preview with the sample values</span>
        <div class="te-chat"><div class="bubble" id="tePreview"></div></div>
        <p class="sub">${live ? 'Meta reviews every new or edited template, usually within minutes and at most a day. Its status updates here by itself.' : 'Demo mode: the template is saved here for practice and nothing goes to Meta.'}</p>
      </aside>
      <div class="modal-actions te-actions">
        <button type="button" class="btn quiet" onclick="closeModal()">Cancel</button>
        <button class="btn primary">${t ? 'Save changes' : live ? 'Submit for review' : 'Save template'}</button>
      </div>
    </form>`);
  $('#modal .modal-box').classList.add('te-box');
  const form = $('#teForm', body), ta = $('[name=bodyText]', form);
  const status = $('#teStatus', body);
  const show = (kind, html) => { status.className = 'sf-status ' + kind; status.innerHTML = html; };

  // --- Header ---
  const MEDIA_ACCEPT = { IMAGE: 'image/jpeg,image/png', VIDEO: 'video/mp4', DOCUMENT: 'application/pdf' };
  const MEDIA_MAX = { IMAGE: 5, VIDEO: 16, DOCUMENT: 15 };
  const renderHeader = () => {
    const h = spec.header, box = $('#teHeaderBox', body);
    if (h.format === 'TEXT') {
      box.innerHTML = `<input name="headerText" maxlength="60" value="${esc(h.text)}" placeholder="Your order is on its way" autocomplete="off">
        ${tplVarNums(h.text).length ? `<label class="te-sample">Sample for {{1}}<input name="headerSample" value="${esc(h.sample)}" placeholder="What {{1}} could be"></label>` : ''}`;
    } else if (MEDIA_ACCEPT[h.format]) {
      const kind = h.format === 'DOCUMENT' ? 'PDF' : h.format.toLowerCase();
      box.innerHTML = `<div class="te-media"><label class="btn sm">${icon('upload', 14)}${h.file ? 'Replace' : 'Upload'} sample ${kind}<input type="file" hidden accept="${MEDIA_ACCEPT[h.format]}" id="teHeaderFile"></label>
        <span class="sub">${h.file ? esc(h.file.name) : t && tplSpec(t).header.format === h.format ? 'Keeping the current sample' : `For Meta's review only. The real ${kind} is chosen when sending.`}</span></div>`;
      $('#teHeaderFile', box).addEventListener('change', (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        if (f.size > MEDIA_MAX[h.format] * 1048576) return toast(`WhatsApp accepts header ${kind}s up to ${MEDIA_MAX[h.format]} MB`, 'error');
        if (h.preview) URL.revokeObjectURL(h.preview);
        h.file = f;
        h.preview = h.format === 'IMAGE' ? URL.createObjectURL(f) : '';
        renderHeader();
        renderPreview();
      });
    } else box.innerHTML = '';
  };

  // --- Variable samples ---
  const renderSamples = () => {
    const nums = tplVarNums(spec.body.text);
    const box = $('#teSamples', body);
    box.innerHTML = nums.length ? `<span class="te-cap">Samples for Meta's review <span class="opt">shown in the preview, never sent</span></span>` + nums.map((n) => `<label class="te-sample"><code>{{${n}}}</code><input data-sample="${n - 1}" value="${esc(spec.body.samples[n - 1] || '')}" placeholder="${n === 1 ? 'e.g. Rahul' : 'e.g. a real-looking value'}"></label>`).join('') : '';
  };

  // --- Buttons ---
  const renderButtons = () => {
    const box = $('#teButtons', body);
    const anyGo = spec.buttons.some((b) => b.type === 'URL' && b.mode === 'go');
    box.innerHTML = spec.buttons.map((b, i) => `<div class="te-btn" data-i="${i}">
      <span class="te-btn-kind">${icon(b.type === 'URL' ? 'external-link' : b.type === 'PHONE_NUMBER' ? 'phone' : 'reply', 14)}${b.type === 'URL' ? 'Website' : b.type === 'PHONE_NUMBER' ? 'Call' : 'Quick reply'}</span>
      <input data-bf="text" maxlength="25" value="${esc(b.text)}" placeholder="${b.type === 'URL' ? 'Register Now' : b.type === 'PHONE_NUMBER' ? 'Call us' : 'Interested'}" aria-label="Button text">
      ${b.type === 'URL' ? `<select data-bf="mode" aria-label="Which link"><option value="go" ${b.mode === 'go' ? 'selected' : ''}>Any link, chosen when sending</option><option value="fixed" ${b.mode === 'fixed' ? 'selected' : ''}>The same link every time</option></select>
        ${b.mode === 'fixed' ? `<input data-bf="url" class="te-wide" value="${esc(b.url)}" placeholder="https://example.com/page">` : ''}` : ''}
      ${b.type === 'PHONE_NUMBER' ? `<input data-bf="phone" value="${esc(b.phone)}" placeholder="+91 98765 43210" inputmode="tel">` : ''}
      <button type="button" class="icon-btn te-btn-x" data-rmbtn="${i}" aria-label="Remove button">${icon('x', 14)}</button>
    </div>`).join('');
    box.insertAdjacentHTML('beforeend', anyGo ? `<label class="te-domain"><span>Short link domain <span class="opt">your own domain, connected to this app. Customers see it when they tap.</span></span><input name="linkDomain" value="${esc(linkDomain)}" placeholder="https://link.yourcompany.com" inputmode="url"></label>` : '');
    $('.te-addbtns', body).classList.toggle('hidden', spec.buttons.length >= 10);
  };

  // --- Preview: the template as it would be saved, filled with the samples ---
  const asTemplate = () => {
    const comps = [];
    const h = spec.header;
    if (h.format === 'TEXT' && h.text.trim()) comps.push({ type: 'HEADER', format: 'TEXT', text: h.text });
    else if (MEDIA_ACCEPT[h.format]) comps.push({ type: 'HEADER', format: h.format });
    comps.push({ type: 'BODY', text: spec.body.text || '' });
    if (spec.footer.trim()) comps.push({ type: 'FOOTER', text: spec.footer });
    // Shown in the order Meta keeps them: website and call buttons first, then quick replies.
    const ordered = [...spec.buttons].sort((a, b) => (a.type === 'QUICK_REPLY') - (b.type === 'QUICK_REPLY'));
    if (ordered.length) comps.push({ type: 'BUTTONS', buttons: ordered.map((b) => ({ type: b.type, text: b.text || '…' })) });
    return { components: comps };
  };
  const renderPreview = () => {
    const values = {};
    tplVarNums(spec.body.text).forEach((n) => { if (spec.body.samples[n - 1]) values[`body.${n}`] = spec.body.samples[n - 1]; });
    if (spec.header.sample) values['header.1'] = spec.header.sample;
    if (spec.header.preview) values['header.media'] = spec.header.preview;
    $('#tePreview', body).innerHTML = spec.body.text.trim() || spec.header.format !== 'NONE' || spec.buttons.length ? bubbleHtml(asTemplate(), values) : '<span class="te-empty">Your message appears here as you write it.</span>';
    const n = spec.body.text.length;
    $('#teBodyCount', body).textContent = `${n} / 1024`;
    $('#teBodyCount', body).classList.toggle('warn', n > 1000);
    $('#teFooterCount', body).textContent = spec.footer ? `${spec.footer.length} / 60` : '';
  };

  // --- Events ---
  form.addEventListener('click', (e) => {
    const seg = e.target.closest('[data-seg] button');
    if (seg) {
      const which = seg.parentElement.dataset.seg;
      seg.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === seg));
      if (which === 'category') spec.category = seg.dataset.v;
      else { spec.header.format = seg.dataset.v; renderHeader(); renderPreview(); }
      return;
    }
    const wrap = e.target.closest('[data-wrap]');
    if (wrap) {
      const m = wrap.dataset.wrap, [a, z] = [ta.selectionStart, ta.selectionEnd];
      const sel = ta.value.slice(a, z) || 'text';
      ta.setRangeText(m + sel + m, a, z, 'select');
      ta.focus();
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (e.target.closest('[data-addvar]')) {
      const next = (tplVarNums(ta.value).at(-1) || 0) + 1;
      ta.setRangeText(`{{${next}}}`, ta.selectionStart, ta.selectionEnd, 'end');
      ta.focus();
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const add = e.target.closest('[data-addbtn]');
    if (add) {
      const type = add.dataset.addbtn;
      spec.buttons.push(type === 'URL' ? { type, text: '', mode: 'go', url: '' } : type === 'PHONE_NUMBER' ? { type, text: '', phone: '' } : { type, text: '' });
      renderButtons();
      renderPreview();
      $(`.te-btn[data-i="${spec.buttons.length - 1}"] [data-bf=text]`, body)?.focus();
      return;
    }
    const rm = e.target.closest('[data-rmbtn]');
    if (rm) { spec.buttons.splice(Number(rm.dataset.rmbtn), 1); renderButtons(); renderPreview(); }
  });
  form.addEventListener('input', (e) => {
    const el = e.target;
    status.className = 'sf-status hidden';
    if (el.name === 'name') { const v = el.value.toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, ''); if (v !== el.value) el.value = v; spec.name = v; }
    else if (el.name === 'bodyText') { spec.body.text = el.value; if (tplVarNums(el.value).join() !== $$('[data-sample]', body).map((x) => Number(x.dataset.sample) + 1).join()) renderSamples(); }
    else if (el.name === 'footer') spec.footer = el.value;
    else if (el.name === 'headerText') { spec.header.text = el.value; if (Boolean(tplVarNums(el.value).length) !== Boolean($('[name=headerSample]', body))) { renderHeader(); $('[name=headerText]', body).focus(); } }
    else if (el.name === 'headerSample') spec.header.sample = el.value;
    else if (el.name === 'linkDomain') linkDomain = el.value.trim();
    else if (el.dataset.sample != null) spec.body.samples[Number(el.dataset.sample)] = el.value;
    else if (el.dataset.bf) { const b = spec.buttons[Number(el.closest('.te-btn').dataset.i)]; b[el.dataset.bf] = el.value; if (el.dataset.bf === 'mode') { renderButtons(); } }
    renderPreview();
  });
  form.addEventListener('change', (e) => { if (e.target.name === 'language') spec.language = e.target.value; });

  const fileData = (f) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(f); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = $('.te-actions .btn.primary', body);
    guard(async () => {
      if (t && String(t.status).toUpperCase() === 'APPROVED' && live && t.metaId) {
        const ok = await confirmDialog({ title: `Send ${esc(t.name)} back to review?`, message: "Meta reviews every edit. Until it's approved again, this template can't be sent, and Meta allows one edit a day.", confirmText: 'Save and submit' });
        if (!ok) return;
      }
      show('busy', `<span class="sf-spin"></span>${live && (!t || t.metaId) ? 'Sending to Meta…' : 'Saving…'}`);
      const h = spec.header;
      const payload = {
        name: spec.name, language: $('[name=language]', form).value, category: spec.category, senderId: $('[name=senderId]', form)?.value,
        header: { format: h.format, text: h.text, sample: h.sample, file: h.file ? { mime: h.file.type, data: await fileData(h.file) } : null },
        body: { text: spec.body.text, samples: tplVarNums(spec.body.text).map((n) => spec.body.samples[n - 1] || '') },
        footer: spec.footer, buttons: spec.buttons, linkDomain: spec.buttons.some((b) => b.type === 'URL' && b.mode === 'go') ? linkDomain : '',
      };
      try {
        await api(t ? `/templates/${t.id}/meta` : '/templates/meta', { method: t ? 'PUT' : 'POST', body: payload });
      } catch (err) { show('bad', esc(err.message)); return; }
      if (h.preview) URL.revokeObjectURL(h.preview);
      closeModal();
      toast(live && (t?.metaId || !t) ? `${t ? 'Changes sent' : 'Template sent'} to Meta for review. You'll see the result here.` : 'Template saved');
      if (payload.linkDomain) state.settings.linkDomain = payload.linkDomain.replace(/\/+$/, '');
      await loadTemplates();
    }, btn);
  });

  renderHeader();
  renderSamples();
  renderButtons();
  renderPreview();
  if (!t) $('[name=name]', form).focus();
}
window.templateEditor = templateEditor;
$('#addTemplate').addEventListener('click', () => templateEditor());
// Meta's review results come in live (webhook): refresh the list when one arrives.
document.addEventListener('live', (e) => { if (e.detail?.kind === 'templates') loadTemplates().catch(() => {}); });

// ---------------------------------------------------------------------------
// Shared: reading contact files, phone numbers, template bubbles
// (used by the Send page, the Assistant and the Inbox)
// ---------------------------------------------------------------------------

function parseCsv(text) {
  text = text.replace(/^﻿/, '').trim();
  if (!text) return [];
  const firstLine = text.split(/\r?\n/)[0];
  const delim = [',', '\t', ';', '|'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

// Excel support is loaded on demand so the page stays light.
let xlsxLoading;
function loadXlsxLib() {
  xlsxLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxLoading = null; reject(new Error('Could not load Excel reader — check your internet, or save the file as CSV')); };
    document.head.append(s);
  });
  return xlsxLoading;
}

const looksLikePhone = (v) => /^\+?[\d\s\-().]{8,}$/.test(String(v).trim());

// Every phone number in a cell, best first. Lead sheets often hold several ("98450 08573 / 99805 17082",
// "Mobile: … ⏎ Telephone: …"); each part is read on its own, notes in brackets are ignored, and fewer than
// 10 or more than 15 digits isn't a phone number. Office/landline numbers go last (they rarely have WhatsApp).
// Keep in step with phoneCandidates in server.js.
function phoneCandidates(input) {
  const cc = state.settings.defaultCountryCode;
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
// placeholders like "Not Captured", "N/A" or "-" count as empty, so a fallback can step in.
// Keep in step with cleanCell in server.js.
const FILLER = /^(not\s*(captured|available|applicable|known|mentioned|provided|given|found)|n\s*\/?\s*a|nil|null|none|unknown|invalid|tbd|tba|no\s*data|-+|\.+|\?+|x+)$/i;
function cleanCell(v) {
  const s = String(v ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return !s || FILLER.test(s) ? '' : s;
}

// A cell that is a phone number and nothing else: digits with the usual separators, optionally
// "p:" / "tel:" in front (Meta lead exports) or a note like "(whatsapp)" after. Dates, IDs and
// emails with long digit runs don't count.
function phoneLike(v) {
  const t = String(v ?? '').trim().replace(/^(p|tel|phone)\s*:\s*/i, '').replace(/\s*\(?[a-z][a-z .]*\)?$/i, '');
  const digits = t.replace(/\D/g, '').length;
  return /^\+?[\d\s\-().]{8,}$/.test(t) && digits >= 10 && digits <= 15;
}

// Which column holds the phone numbers: the one whose cells actually are numbers, with the
// column name only as a tie-breaker. ("Contact Name" mentions "contact" but holds names.)
// `cell(row, i, header)` reads a cell, so it works for array rows and object rows alike.
function guessPhoneColumn(headers, rows, cell = (r, i) => r[i]) {
  const sample = rows.slice(0, 300);
  // Score against every non-empty row, so a column filled in only a few rows can't win on a small sample.
  const total = sample.filter((r) => headers.some((h, i) => String(cell(r, i, h) ?? '').trim())).length;
  let best = '', bestScore = 0;
  headers.forEach((h, i) => {
    let filled = 0, phones = 0;
    for (const r of sample) {
      const v = String(cell(r, i, h) ?? '').trim();
      if (!v) continue;
      filled++;
      if (phoneLike(v)) phones++;
    }
    if (!filled) return;
    let score = phones / Math.max(1, total);
    if (/phone|mobile|whats\s?app|cell|msisdn|\btel/i.test(h)) score += 0.3;
    else if (/number|contact/i.test(h)) score += 0.1;
    if (/name|mail|s\.?\s?no\b|serial|date|time|created|updated|\bid\b|pin|zip|amount|price/i.test(h)) score -= 0.4;
    if (score > bestScore) { bestScore = score; best = h; }
  });
  return bestScore >= 0.5 ? best : '';
}

// --- Shifted rows ---------------------------------------------------------------------
// Exports that merge leads from different forms (Meta lead ads, for one) put a form's extra
// answers in the middle of some rows, pushing the rest of those rows a few columns right.
// Rows are arrays of cells. The Send page and Contacts import both use these.

function cellKind(v) {
  v = String(v ?? '').trim();
  if (!v) return 'empty';
  if (phoneLike(v)) return 'phone';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'email';
  if (/^[a-z]{1,3}:\S+$/i.test(v)) return 'id';
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return 'date';
  if (/^(true|false|yes|no)$/i.test(v)) return 'bool';
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'num';
  if (/^[A-Z][A-Z_]{2,}$/.test(v)) return 'code';
  return 'text';
}

// → [{ k: columns shifted right, start: first column that moved, idx: row indices }]. Rows whose
// phone cell fails but which have a number 1–5 columns to the right are shifted; the shift starts at
// the leftmost column where the moved values clearly fit that column's usual kind better than unmoved.
function detectShiftedRows(headers, rows, pc) {
  if (pc < 0) return [];
  const blank = (r) => !r.some((v) => String(v ?? '').trim());
  const good = rows.filter((r) => !blank(r) && normalizePhone(r[pc])).slice(0, 300);
  if (good.length < 3) return [];
  const share = (list, c, off, want) => list.filter((r) => cellKind(r[c + off]) === want).length / list.length;
  const usual = headers.map((_, c) => {
    const n = {};
    for (const r of good) { const k = cellKind(r[c]); n[k] = (n[k] || 0) + 1; }
    return Object.entries(n).sort((a, b) => b[1] - a[1])[0][0];
  });
  const byShift = new Map();
  rows.forEach((r, i) => {
    if (blank(r) || normalizePhone(r[pc])) return;
    for (let k = 1; k <= 5; k++) {
      if (cellKind(r[pc + k]) === 'phone' && normalizePhone(r[pc + k])) { (byShift.get(k) || byShift.set(k, []).get(k)).push(i); break; }
    }
  });
  const groups = [];
  for (const [k, idx] of byShift) {
    const list = idx.map((i) => rows[i]);
    let start = pc;
    for (let c = pc - 1; c >= 0; c--) {
      if (usual[c] === 'empty') continue;
      const moved = share(list, c, k, usual[c]);
      if (moved < 0.6) break;
      if (moved > share(list, c, 0, usual[c])) start = c;
    }
    groups.push({ k, start, idx });
  }
  return groups;
}

// Shifted rows moved back under the right headers. The answers that caused the shift go to new
// "Extra answer" columns at the end (nothing is lost); unnamed columns left empty are dropped.
function realignShiftedRows(headers, rows, groups) {
  const extra = Math.max(0, ...groups.map((g) => g.k));
  const H = headers.length;
  const outHeaders = headers.slice();
  for (let j = 1; j <= extra; j++) {
    let name = `Extra answer ${j}`;
    for (let n = 2; outHeaders.includes(name); n++) name = `Extra answer ${j} (${n})`;
    outHeaders.push(name);
  }
  const shiftOf = new Map(groups.flatMap((g) => g.idx.map((i) => [i, g])));
  let out = rows.map((cells, i) => {
    const old = cells.concat(Array(Math.max(0, H - cells.length)).fill(''));
    const g = shiftOf.get(i);
    if (!g) return old.slice(0, H).concat(Array(extra).fill(''));
    return [...old.slice(0, g.start), ...old.slice(g.start + g.k, H), ...Array(g.k).fill(''), ...old.slice(g.start, g.start + g.k), ...Array(extra - g.k).fill('')];
  });
  for (let c = H - 1; c >= 0; c--) {
    if (!/^Column [A-Z]+$/.test(outHeaders[c]) || out.some((r) => String(r[c] ?? '').trim())) continue;
    outHeaders.splice(c, 1);
    out = out.map((r) => { r.splice(c, 1); return r; });
  }
  return { headers: outHeaders, rows: out };
}

const varLabel = (v) => (v.media ? `header ${v.media} URL` : `${v.where} {{${v.name}}}`);

// A PDF in a message: clicking it opens this preview popup (above anything else open) instead of leaving the app.
function pdfViewer(url, name) {
  let el = $('#pdfModal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pdfModal';
    el.className = 'modal hidden';
    document.body.append(el);
    el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-pdf-close]')) hideOverlay(el); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.classList.contains('hidden')) { e.stopPropagation(); hideOverlay(el); } }, true);
  }
  el.innerHTML = `<div class="modal-box pdf-box" role="dialog" aria-label="${esc(name)}">
    <div class="modal-head"><h2 class="pdf-name">${icon('file-text', 18)}<span>${esc(name)}</span></h2>
      <div class="pdf-actions"><a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener">${icon('external-link', 14)}Open in new tab</a><a class="btn sm" href="${esc(url)}" download="${esc(name)}">${icon('download', 14)}Download</a><button type="button" class="icon-btn" data-pdf-close aria-label="Close">${icon('x', 18)}</button></div></div>
    <iframe class="pdf-frame" src="${esc(url)}#view=FitH" title="${esc(name)}"></iframe>
    <p class="sub pdf-note">If it doesn't show here, the file's website doesn't allow previews: use Open in new tab.</p>
  </div>`;
  el.classList.remove('hidden');
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-pdf]');
  if (!a || e.metaKey || e.ctrlKey) return; // ⌘/Ctrl-click still opens a new tab
  e.preventDefault();
  e.stopPropagation();
  pdfViewer(a.dataset.pdf, a.dataset.pdfName || 'Document.pdf');
}, true);

// WhatsApp formatting on already-escaped text, the way the phone shows it: *bold*, _italic_, ~strike~,
// ```monospace```, and links (with or without https://, e.g. youtube.com) that open in a new tab.
const WA_LINK = /((?:https?:\/\/|www\.)[^\s<]+|(?<![@\w.\/-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|org|net|io|co|app|dev|me|ai|edu|gov|info|biz|ly|gl|be|link|site|shop|store|xyz|tv)\b(?:\/[^\s<]*)?)/gi;
function waFormat(html) {
  return html
    .split(WA_LINK)
    .map((part, i) => {
      if (i % 2) {
        const [, url, tail] = part.match(/^(.*?)([.,!?:;)\]]*)$/); // a full stop after a link isn't part of it
        return `<a href="${/^https?:\/\//i.test(url) ? url : 'https://' + url}" target="_blank" rel="noopener">${url}</a>${tail}`;
      }
      return part
        .replace(/```([^`]+)```/g, '<code>$1</code>')
        .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
        .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<i>$2</i>')
        .replace(/~([^~\n]+)~/g, '<s>$1</s>');
    })
    .join('');
}

// Template text with {{variables}} filled in (or shown as chips) and WhatsApp formatting applied.
// Variables are swapped out while the template text is formatted so their markup isn't touched by it;
// a filled-in value is formatted on its own (a link or *bold* in it shows the way the phone shows it).
function fill(text, where, values, neutral = false) {
  const chips = [];
  const marked = esc(text).replace(/{{\s*([\w]+)\s*}}/g, (_, name) => {
    const val = values[`${where}.${name}`];
    const key = `data-var="${esc(`${where}.${name}`)}"`;
    chips.push(val ? `<span class="var" ${key}>${waFormat(esc(val))}</span>` : `<span class="var ${neutral ? '' : 'empty'}" ${key}>{{${esc(name)}}}</span>`);
    return `\u0001${chips.length - 1}\u0001`;
  });
  return waFormat(marked).replace(/\u0001(\d+)\u0001/g, (_, n) => chips[n]);
}

// WhatsApp bubble for a template. Unfilled variables show as {{name}} chips.
// `meta` (the Inbox's time and ticks) goes under the text and above the buttons, as on the phone.
function bubbleHtml(t, values, neutral = false, meta = '') {
  let html = '';
  const h = comp(t, 'HEADER');
  if (h) {
    if (h.format === 'TEXT') html += `<div class="hdr">${fill(h.text, 'header', values, neutral)}</div>`;
    else {
      const url = values['header.media'];
      const isImg = h.format === 'IMAGE' && /^(https?:\/\/|blob:)/.test(url || '');
      // A real image keeps its own shape, like on the phone; until there is one, a placeholder box.
      let docName = h.format === 'DOCUMENT' && url ? String(values['header.filename'] || '').trim() || decodeURIComponent(String(url).split('/').pop() || '') : '';
      if (/^[0-9a-f]{32}\.[a-z0-9]{2,4}$/.test(docName)) docName = 'Document.pdf'; // an upload from before names were kept
      if (docName && !/\.[a-z0-9]{2,4}$/i.test(docName)) docName += '.pdf'; // the server adds it when sending, too
      // A PDF opens in the preview popup (pdfViewer) when clicked.
      html += isImg ? `<img class="media-img" src="${esc(url)}" alt="" loading="lazy" />`
        : docName && /^(https?:\/\/|blob:)/.test(url) ? `<a class="media media-doc" href="${esc(url)}" target="_blank" rel="noopener" data-pdf="${esc(url)}" data-pdf-name="${esc(docName)}" title="Preview ${esc(docName)}">${icon('file-text', 22)}<span>${esc(docName)}</span><small>Preview</small></a>`
        : `<div class="media">${esc(h.format.toLowerCase())}</div>`;
    }
  }
  html += `<div>${fill(comp(t, 'BODY')?.text || '', 'body', values, neutral)}</div>`;
  const f = comp(t, 'FOOTER');
  if (f) html += `<div class="ftr">${esc(f.text)}</div>`;
  html += meta;
  const b = comp(t, 'BUTTONS');
  // The same icons WhatsApp puts on each kind of button: reply arrow, open-link box, phone.
  if (b?.buttons?.length) html += `<div class="btns">${b.buttons.map((x) => `<div>${icon(x.type === 'URL' ? 'external-link' : x.type === 'PHONE_NUMBER' ? 'phone' : 'reply', 16)}${esc(x.text)}</div>`).join('')}</div>`;
  return html;
}

// ---------------------------------------------------------------------------
// Overview dashboard
// ---------------------------------------------------------------------------

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const fmtNum = (n) => (n >= 10000 ? compact.format(n) : n.toLocaleString());
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const sum = (arr, k) => arr.reduce((t, d) => t + d[k], 0);

function relTime(d) {
  const diff = new Date(d) - Date.now();
  const abs = Math.abs(diff);
  const unit = abs < 3600e3 ? ['minute', 60e3] : abs < 86400e3 ? ['hour', 3600e3] : ['day', 86400e3];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(diff / unit[1]), unit[0]);
}

// Overview filters: date range, number, template and the metric being charted.
// Remembered per browser so the dashboard opens the way you left it.
const OV_DEFAULT = { range: 14, sender: '', template: '', metric: 'sent', table: false };
state.ov = (() => {
  try { return { ...OV_DEFAULT, ...JSON.parse(localStorage.getItem('ov') || '{}') }; } catch { return { ...OV_DEFAULT }; }
})();
const saveOv = () => { try { localStorage.setItem('ov', JSON.stringify(state.ov)); } catch {} };

let ovTimer = null;
const stopOverviewPolling = () => { clearTimeout(ovTimer); ovTimer = null; };

async function refreshStats() {
  const q = new URLSearchParams({ range: state.ov.range, sender: state.ov.sender, template: state.ov.template });
  let st = await api('/stats?' + q);
  // A remembered filter can point at a number or template that no longer exists (e.g. after
  // reloading the demo workspace). The dropdown would show "All", yet still filter everything out.
  const staleSender = st.filters.sender && !st.senders.some((s) => s.id === st.filters.sender);
  const staleTemplate = st.filters.template && !st.options.templates.includes(st.filters.template);
  if (staleSender || staleTemplate) {
    if (staleSender) state.ov.sender = '';
    if (staleTemplate) state.ov.template = '';
    saveOv();
    st = await api('/stats?' + new URLSearchParams({ range: state.ov.range, sender: state.ov.sender, template: state.ov.template }));
  }
  state.stats = st;
  return state.stats;
}

async function loadOverview() {
  stopOverviewPolling();
  $('#tab-overview').classList.add('loading');
  try {
    const st = await refreshStats();
    renderOverview(st);
    // Keep numbers moving while something is sending (and briefly after demo sends settle).
    const busy = st.running > 0 || st.recent.some((c) => c.finishedAt && Date.now() - new Date(c.finishedAt) < 60e3);
    if (busy && !$('#tab-overview').classList.contains('hidden')) ovTimer = setTimeout(loadOverview, 3000);
  } finally {
    $('#tab-overview').classList.remove('loading');
  }
}

function renderOverview(st) {
  const live = !st.demo;
  $('#ovSub').innerHTML = `${live ? 'Live sending' : 'Demo data — nothing here was really sent'}${st.running ? ` · <span class="pill running">${st.running} sending now</span>` : ''}`;
  $('#seedBtn').classList.toggle('hidden', live || st.hasSeed || !state.settings?.demoAllowed);
  $('#unseedBtn').classList.toggle('hidden', !st.hasSeed);
  renderFilters(st);
  renderSetup(st);
  renderKpis(st);
  renderCharts();
  renderFunnel(st);
  renderHealth(st);
  renderUpcoming(st);
  renderRecent(st);
  Motion.values($('#tab-overview'));
}

function renderFilters(st) {
  const fill = (sel, items, current) => {
    const opts = sel.querySelectorAll('option:not([value=""])');
    opts.forEach((o) => o.remove());
    sel.insertAdjacentHTML('beforeend', items.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join(''));
    sel.value = items.some(([v]) => v === current) ? current : '';
  };
  fill($('#fSender'), st.senders.map((s) => [s.id, s.label]), st.filters.sender);
  $('#fSender').closest('label').classList.toggle('hidden', st.senders.length < 2 && !st.filters.sender); // nothing to choose between
  fill($('#fTemplate'), st.options.templates.map((t) => [t, t]), st.filters.template);
  $('#fReset').classList.toggle('hidden', !st.filters.sender && !st.filters.template);
  $('#fNote').textContent = `Changes compare with the previous ${st.range} days${st.range === 90 ? ' · grouped by week' : ''}`;
  syncControls();
}

// Keep every range / metric control (page + expanded view + KPI tiles) in step.
function syncControls() {
  $$('[data-range]').forEach((b) => b.classList.toggle('active', Number(b.dataset.range) === state.ov.range));
  $$('[data-metric]').forEach((b) => {
    const on = b.dataset.metric === state.ov.metric;
    b.classList.toggle(b.classList.contains('kpi') ? 'selected' : 'active', on);
    if (b.classList.contains('kpi')) b.setAttribute('aria-pressed', on);
  });
}

function setRange(n) {
  if (state.ov.range === n) return;
  state.ov.range = n;
  saveOv();
  syncControls();
  loadOverview().catch((e) => toast(e.message, 'error'));
}

function setMetric(key) {
  if (!METRICS[key] || state.ov.metric === key) return;
  state.ov.metric = key;
  saveOv();
  syncControls();
  renderCharts();
}

document.addEventListener('click', (e) => {
  const r = e.target.closest('[data-range]');
  if (r) return setRange(Number(r.dataset.range));
  const m = e.target.closest('[data-metric]');
  if (m) setMetric(m.dataset.metric);
});
$('#kpis').addEventListener('keydown', (e) => {
  const tile = e.target.closest('.kpi[data-metric]');
  if (tile && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setMetric(tile.dataset.metric); }
});
['#fSender', '#fTemplate'].forEach((sel) =>
  $(sel).addEventListener('change', () => {
    state.ov.sender = $('#fSender').value;
    state.ov.template = $('#fTemplate').value;
    saveOv();
    loadOverview().catch((e) => toast(e.message, 'error'));
  })
);
// Give the filter row its glass background only once it's pinned under the top bar.
addEventListener('scroll', () => {
  const bar = $('#ovFilters');
  if (bar.offsetParent) bar.classList.toggle('stuck', bar.getBoundingClientRect().top <= 0);
}, { passive: true });

$('#fReset').addEventListener('click', () => {
  state.ov.sender = state.ov.template = '';
  saveOv();
  loadOverview().catch((e) => toast(e.message, 'error'));
});

// --- Setup checklist ---

function renderSetup(st) {
  const s = st.setup, demoOk = state.settings?.demoAllowed;
  const steps = [
    { done: s.sender, title: 'Add a WhatsApp number', text: demoOk ? 'Phone number ID and token from Meta. A placeholder is fine for demo mode.' : 'Your phone number ID and WhatsApp Business account ID from Meta.', action: `<button class="btn sm" onclick="senderForm()">${icon('plus', 15)}Add number</button>` },
    { done: s.template, title: 'Add a template', text: 'Create one in Meta WhatsApp Manager, then sync it in.', action: `<button class="btn sm" data-goto="templates">${icon('file-text', 15)}Templates</button>` },
    { done: s.campaign, title: 'Send a campaign', text: 'Upload contacts, pick who to message and press send.', action: `<button class="btn sm" data-goto="send">${icon('send', 15)}Start</button>` },
    demoOk
      ? { done: s.live && s.token, title: 'Go live', text: 'Add your API token and switch off demo mode in Settings.', action: `<button class="btn sm" data-goto="settings">${icon('rocket', 15)}Go live</button>` }
      : { done: s.token, title: 'Connect your token', text: 'Add the access token from Meta to your number so messages really send.', action: `<button class="btn sm" data-goto="numbers">${icon('rocket', 15)}Add token</button>` },
  ];
  const done = steps.filter((x) => x.done).length;
  if (done === steps.length) { $('#setupCard').innerHTML = ''; return; }
  $('#setupCard').innerHTML = `
    <div class="card setup">
      <div>
        <h2>Get set up</h2>
        <div class="sub">${done} of ${steps.length} done. Each step takes about a minute.</div>
        <div class="setup-progress"><span data-w="${(100 * done) / steps.length}" data-k="setup"></span></div>
        ${st.demo && !st.hasSeed ? `<button class="btn quiet sm" id="seedInline" style="margin-left:-12px">Or explore with sample data →</button>` : ''}
      </div>
      <div class="steps">
        ${steps
          .map((x, i) => `<div class="stepc ${x.done ? 'done' : ''}">
            <div class="chk">${x.done ? '✓' : i + 1}</div>
            <div class="st-title">${x.title}</div>
            <div class="st-text">${x.text}</div>
            ${x.done ? '' : x.action}
          </div>`)
          .join('')}
      </div>
    </div>`;
}

// --- Metrics ---

const METRICS = {
  sent: { label: 'Messages sent', short: 'Sent', kind: 'count', icon: 'send', of: (b) => b.sent },
  deliveryRate: { label: 'Delivery rate', short: 'Delivery rate', kind: 'rate', icon: 'check', num: 'delivered', den: 'sent' },
  readRate: { label: 'Read rate', short: 'Read rate', kind: 'rate', icon: 'eye', num: 'read', den: 'delivered' },
  failed: { label: 'Failed', short: 'Failed', kind: 'count', icon: 'alert', of: (b) => b.failed, bad: true },
};
const rateOf = (b, m) => (b[m.den] ? (100 * b[m.num]) / b[m.den] : null);
const metricValue = (m, b) => (m.kind === 'count' ? m.of(b) : rateOf(b, m));
const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

const dayLabel = (iso, opts = { month: 'short', day: 'numeric' }) => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, opts);

// Daily buckets, or weekly ones (ending today) for the 90-day range.
function makeBuckets(days, range) {
  const lastIdx = days.length - 1;
  if (range < 90) {
    return days.map((d, i) => ({ ...d, key: d.date, label: i === lastIdx ? 'Today' : dayLabel(d.date), long: dayLabel(d.date, { weekday: 'short', month: 'short', day: 'numeric' }) }));
  }
  const out = [];
  for (let end = days.length; end > 0; end -= 7) {
    const chunk = days.slice(Math.max(0, end - 7), end);
    const b = { key: chunk[0].date, sent: 0, delivered: 0, read: 0, failed: 0 };
    chunk.forEach((d) => { b.sent += d.sent; b.delivered += d.delivered; b.read += d.read; b.failed += d.failed; });
    b.label = end === days.length ? 'This week' : dayLabel(chunk[0].date);
    b.long = `${dayLabel(chunk[0].date)} – ${dayLabel(chunk[chunk.length - 1].date)}`;
    out.unshift(b);
  }
  return out;
}

// --- KPI tiles ---
// Every tile covers the selected range and compares with the previous period of the
// same length. Rates compare in percentage points, counts in percent change.

function deltaChip(cur, prev, { rate = false, bad = false } = {}) {
  if (cur == null) return '<span class="delta-chip">No data</span>';
  if (prev == null || (!rate && !prev)) {
    if (!rate && !prev && !cur) return '<span class="delta-chip">No change</span>';
    return '<span class="delta-chip">New this period</span>';
  }
  const diff = rate ? cur - prev : ((cur - prev) / prev) * 100;
  const shown = rate ? `${diff >= 0 ? '+' : '−'}${fmt1(Math.abs(diff))} pts` : `${diff >= 0 ? '+' : '−'}${Math.round(Math.abs(diff))}%`;
  if (Math.abs(diff) < (rate ? 0.05 : 0.5)) return `<span class="delta-chip">${rate ? '±0.0 pts' : '0%'}</span>`;
  const up = diff > 0;
  const good = up !== bad;
  return `<span class="delta-chip ${good ? 'good' : 'bad'}">${icon(up ? 'trending-up' : 'trending-down', 13)}${shown}</span>`;
}

// Each tile ends in a soft gradient area chart of its metric over the period,
// edge to edge, with a hover cursor and value pill. The SVG stretches to the
// tile; dots, cursor and pill are HTML on top so they never distort.
const kpiSeen = new Set();
const kpiData = {};
const VW = 300, VH = 78, TOP = 10, BOT = 4;

function areaTile(bs, m, key) {
  const vals = bs.map((b) => metricValue(m, b));
  const n = vals.length;
  const present = vals.filter((v) => v != null);
  let lo = 0, hi = Math.max(...present, 1);
  if (m.kind === 'rate' && present.length) {
    // Rates live in a narrow band; pad around it so the shape is readable.
    lo = Math.max(0, Math.min(...present) - 6);
    hi = Math.min(100, Math.max(...present) + 3);
    if (hi - lo < 8) lo = Math.max(0, hi - 8);
  }
  // Stop a little short of the right edge so today's dot isn't clipped by the tile.
  const xAt = (i) => (n === 1 ? VW / 2 : (i / (n - 1)) * (VW - 9));
  const yAt = (v) => VH - BOT - ((v - lo) / (hi - lo || 1)) * (VH - TOP - BOT);
  // Rates have no value on days without sends; the curve joins the days that do.
  const pts = vals.map((v, i) => (v == null ? null : [xAt(i), yAt(v)])).filter(Boolean);
  kpiData[key] = { vals, bs, m, xAt, yAt };
  if (!pts.length) return `<div class="kpi-empty">No data in this period</div>`;
  const line = d3.line().curve(d3.curveMonotoneX)(pts);
  const area = d3.area().curve(d3.curveMonotoneX).y0(VH)(pts);
  const reveal = !kpiSeen.has(key + n);
  kpiSeen.add(key + n);
  let li = n - 1;
  while (li > 0 && vals[li] == null) li--;
  const last = vals[li] == null ? null : [xAt(li), yAt(vals[li])];
  const labelIdx = n > 2 ? [0, Math.round((n - 1) / 2), n - 1] : [n - 1];
  return `<div class="kpi-area ${reveal ? 'reveal' : ''}" data-key="${key}">
    <svg viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="kh-${key}" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stop-color="var(--kpi-a)"/><stop offset="0.5" stop-color="var(--kpi-b)"/><stop offset="1" stop-color="var(--kpi-c)"/>
        </linearGradient>
        <linearGradient id="kv-${key}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity="0.5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
        </linearGradient>
        <mask id="km-${key}" maskContentUnits="userSpaceOnUse"><rect width="${VW}" height="${VH}" fill="url(#kv-${key})"/></mask>
      </defs>
      <path class="ka-fill" d="${area}" fill="url(#kh-${key})" mask="url(#km-${key})"/>
      <path class="ka-line" d="${line}" stroke="url(#kh-${key})" vector-effect="non-scaling-stroke"/>
    </svg>
    ${last ? `<i class="ka-now" style="left:${(last[0] / VW) * 100}%;top:${(last[1] / VH) * 100}%"></i>` : ''}
    <i class="ka-cursor"></i><i class="ka-dot"></i><span class="ka-pill"></span>
  </div>
  <div class="ka-x">${labelIdx.map((i) => `<span class="${i === n - 1 ? 'now' : ''}" style="left:${(xAt(i) / VW) * 100}%">${esc(bs[i].label)}</span>`).join('')}</div>`;
}

function renderKpis(st) {
  const t = st.totals, p = st.prev, r = st.range;
  const bs = makeBuckets(st.days, r);
  const attempts = t.sent + t.failed;
  const tiles = Object.entries(METRICS).map(([key, m]) => {
    if (m.kind === 'count') {
      const cur = m.of(t), prev = m.of(p);
      const caption = key === 'sent'
        ? `${fmtNum(Math.round(cur / r))} a day on average`
        : `${attempts ? fmt1((100 * cur) / attempts) : '0.0'}% of ${fmtNum(attempts)} attempts`;
      return { key, m, value: `<span data-count="${cur}" data-fmt="int" data-k="kpi-${key}">0</span>`, caption, delta: deltaChip(cur, prev, { bad: m.bad }) };
    }
    const cur = rateOf(t, m), prev = rateOf(p, m);
    const caption = `${fmtNum(t[m.num])} of ${fmtNum(t[m.den])} ${m.den === 'sent' ? 'sent' : 'delivered'}${prev == null ? '' : ` · was ${fmt1(prev)}%`}`;
    return {
      key, m,
      value: cur == null ? '—' : `<span data-count="${cur.toFixed(2)}" data-fmt="pct1" data-k="kpi-${key}">0</span><small>%</small>`,
      caption, delta: deltaChip(cur, prev, { rate: true }),
    };
  });
  $('#kpis').innerHTML = tiles
    .map(({ key, m, value, caption, delta }) => `<div class="kpi" data-metric="${key}" role="button" tabindex="0" aria-pressed="false" title="Show ${m.label.toLowerCase()} in the chart">
      <div class="kpi-top">
        <div class="kpi-label"><span class="kpi-icon">${icon(m.icon, 15)}</span>${m.label}</div>
        <span title="Compared with the previous ${r} days">${delta}</span>
      </div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-caption">${caption}</div>
      <div class="kpi-viz">${areaTile(bs, m, key)}</div>
    </div>`)
    .join('');
  syncControls();
}

// Hover: snap to the nearest day that has a value; show cursor, dot and pill.
$('#kpis').addEventListener('pointermove', (e) => {
  const box = e.target.closest('.kpi-area');
  $$('#kpis .kpi-area.hover').forEach((a) => a !== box && a.classList.remove('hover'));
  if (!box) return;
  const d = kpiData[box.dataset.key];
  const r = box.getBoundingClientRect();
  const n = d.vals.length;
  let i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
  i = Math.max(0, Math.min(n - 1, i));
  if (d.vals[i] == null) {
    let a = i, b = i;
    while (a >= 0 && d.vals[a] == null) a--;
    while (b < n && d.vals[b] == null) b++;
    i = a < 0 ? b : b >= n ? a : i - a <= b - i ? a : b;
    if (i < 0 || i >= n) return;
  }
  const v = d.vals[i];
  const lx = (d.xAt(i) / VW) * 100, ly = (d.yAt(v) / VH) * 100;
  box.classList.add('hover');
  box.querySelector('.ka-cursor').style.left = lx + '%';
  Object.assign(box.querySelector('.ka-dot').style, { left: lx + '%', top: ly + '%' });
  const pill = box.querySelector('.ka-pill');
  pill.innerHTML = `<b>${d.m.kind === 'rate' ? fmt1(v) + '%' : v.toLocaleString()}</b><span>${esc(d.bs[i].label === 'Today' || d.bs[i].label === 'This week' ? d.bs[i].label : d.bs[i].long)}</span>`;
  pill.style.left = Math.min(86, Math.max(14, lx)) + '%';
});
$('#kpis').addEventListener('pointerleave', () => $$('#kpis .kpi-area.hover').forEach((a) => a.classList.remove('hover')));

// --- The main chart (and its expanded twin) ---

function niceScale(max) {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  return { top: Math.ceil(max / step) * step, step };
}

function barPath(x, base, w, h) {
  if (h < 1) return `M${x},${base - 2}h${w}v2h${-w}Z`; // flat 2px stub for empty buckets
  const r = Math.min(4, w / 2, h);
  const top = base - h;
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
}

function renderCharts({ instant = false } = {}) {
  const st = state.stats;
  if (!st) return;
  const bs = makeBuckets(st.days, st.range);
  const m = METRICS[state.ov.metric];
  const per = st.range === 90 ? 'Per week' : 'Per day';
  const title = m.kind === 'rate' ? m.label : `${m.label}`;
  const sub = `${per}, last ${st.range} days${st.filters.sender || st.filters.template ? ' · filtered' : ''}${m.kind === 'rate' ? (m.den === 'sent' ? ' · delivered ÷ sent' : ' · read ÷ delivered') : ''}`;
  $('#chartTitle').lastChild.textContent = title;
  $('#chartSub').textContent = sub;
  $('#chartTitle').firstElementChild?.replaceWith(document.createRange().createContextualFragment(icon(m.kind === 'rate' ? 'chart-spline' : 'chart-column-increasing', 18)));
  $('#chartTableBtn').textContent = state.ov.table ? 'Chart' : 'Table';
  $('#dayChart').classList.toggle('hidden', state.ov.table);
  $('#dayTable').classList.toggle('hidden', !state.ov.table);
  if (state.ov.table) renderChartTable($('#dayTable'), bs);
  else drawChart($('#dayChart'), bs, m, { instant });

  if (!$('#chartModal').classList.contains('hidden')) {
    $('#xTitle').textContent = title;
    $('#xSub').textContent = sub;
    drawChart($('#xChart'), bs, m, { instant });
    renderChartTable($('#xTable'), bs);
  }
  syncControls();
}

function drawChart(el, bs, m, { instant = false } = {}) {
  if (!el.offsetParent || !window.d3) return;
  const W = el.clientWidth, H = el.clientHeight;
  if (!W || !H) return;
  const pad = { l: 42, r: 12, t: 26, b: 28 };
  const base = H - pad.b;
  const isRate = m.kind === 'rate';

  let svg = d3.select(el).select('svg.d3chart');
  const first = svg.empty();
  if (first) {
    el.innerHTML = '<div class="chart-empty hidden"><div><strong></strong><span></span></div></div>';
    svg = d3.select(el).insert('svg', ':first-child').attr('class', 'd3chart').attr('role', 'img');
    svg.append('g').attr('class', 'grid');
    svg.append('g').attr('class', 'yticks');
    svg.append('g').attr('class', 'cols');
    const ln = svg.append('g').attr('class', 'linelayer').attr('opacity', 0);
    ln.append('path').attr('class', 'line');
    ln.append('g').attr('class', 'dots');
    svg.append('line').attr('class', 'crosshair').attr('opacity', 0);
    svg.append('g').attr('class', 'xlabels');
    svg.append('text').attr('class', 'peak').attr('text-anchor', 'middle').attr('opacity', 0);
    svg.append('g').attr('class', 'hits');
    bindChartHover(el);
  }
  svg.attr('viewBox', `0 0 ${W} ${H}`).attr('aria-label', `${m.label}, ${bs.length} ${bs.length > 20 ? 'periods' : 'days'}`);

  const vals = bs.map((b) => metricValue(m, b));
  const present = vals.filter((v) => v != null);
  const max = d3.max(present) || 0;
  let domain, ticks, tickFmt;
  if (isRate) {
    const lo = present.length ? Math.max(0, Math.floor((d3.min(present) - 5) / 10) * 10) : 0;
    domain = [lo, 100];
    ticks = d3.ticks(lo, 100, 4);
    tickFmt = (v) => `${v}%`;
  } else {
    const { top, step } = niceScale(max);
    domain = [0, top];
    ticks = d3.range(0, top + step / 2, step);
    tickFmt = (v) => compact.format(v);
  }
  const x = d3.scaleBand().domain(bs.map((b) => b.key)).range([pad.l, W - pad.r]);
  const y = d3.scaleLinear().domain(domain).range([base, pad.t]);
  const band = x.bandwidth();
  const bw = Math.min(24, Math.max(3, band * 0.62));
  const cx = (b) => x(b.key) + band / 2;
  const dur = instant || Motion.reduce() ? 0 : 750;

  // If an earlier animation never got to run (e.g. the tab was in the background),
  // finish it now rather than leaving the chart half-drawn.
  clearTimeout(el.__finalT);
  if (!dur) svg.selectAll('*').interrupt();
  else el.__finalT = setTimeout(() => document.visibilityState === 'visible' && drawChart(el, bs, m, { instant: true }), dur + bs.length * 35 + 400);

  const T = (sel, delay = 0) => (dur ? sel.transition().duration(dur).delay(delay).ease(d3.easeCubicOut) : sel);

  // Axis: ticks ride the scale change like a D3 axis.
  const y0 = svg.node().__y || y;
  svg.node().__y = y.copy();
  const clampY = (v) => Math.max(pad.t - 12, Math.min(base, v));
  svg.select('g.grid').selectAll('line').data(ticks, (d) => `${isRate}${d}`).join(
    (enter) => enter.append('line').attr('x1', pad.l).attr('x2', W - pad.r).attr('y1', (d) => clampY(y0(d))).attr('y2', (d) => clampY(y0(d))).attr('opacity', 0)
      .call((e) => T(e).attr('opacity', 1).attr('y1', (d) => y(d)).attr('y2', (d) => y(d))),
    (update) => update.call((u) => T(u).attr('opacity', 1).attr('x2', W - pad.r).attr('y1', (d) => y(d)).attr('y2', (d) => y(d))),
    (exit) => exit.call((ex) => (dur ? T(ex).attr('opacity', 0).attr('y1', (d) => clampY(y(d))).attr('y2', (d) => clampY(y(d))).remove() : ex.remove()))
  );
  svg.select('g.yticks').selectAll('text').data(ticks, (d) => `${isRate}${d}`).join(
    (enter) => enter.append('text').attr('class', 'tick').attr('text-anchor', 'end').attr('x', pad.l - 10).attr('y', (d) => clampY(y0(d)) + 4).text(tickFmt).attr('opacity', 0)
      .call((e) => T(e).attr('opacity', 1).attr('y', (d) => y(d) + 4)),
    (update) => update.call((u) => T(u).attr('opacity', 1).attr('y', (d) => y(d) + 4)),
    (exit) => exit.call((ex) => (dur ? T(ex).attr('opacity', 0).attr('y', (d) => clampY(y(d)) + 4).remove() : ex.remove()))
  );

  // Columns (counts). Each bar remembers its drawn geometry, so any change —
  // new values, new range, back from the line view — tweens from what's on screen.
  const colsG = svg.select('g.cols');
  T(colsG).attr('opacity', isRate ? 0 : 1);
  const target = (b) => ({ x: x(b.key) + (band - bw) / 2, w: bw, h: isRate ? 0 : Math.max(0, base - y(metricValue(m, b) || 0)) });
  const bars = colsG.selectAll('path.bar').data(bs, (b) => b.key).join(
    (enter) => enter.append('path').attr('class', 'bar').each(function (b) { const t = target(b); this.__g = { x: t.x, w: t.w, h: 0 }; }),
    (update) => update,
    (exit) => exit.each(function () { this.__exit = true; }).call((ex) => (dur
      ? ex.transition().duration(dur / 2).attr('opacity', 0).remove()
      : ex.remove()))
  );
  bars.classed('zero', (b) => !isRate && !metricValue(m, b));
  const staggered = first || bars.filter(function () { return this.__g.h === 0; }).size() === bs.length;
  if (!dur) {
    bars.attr('d', function (b) { const t = target(b); this.__g = t; return barPath(t.x, base, t.w, t.h); }).attr('opacity', 1);
  } else {
    bars.transition().duration(dur).delay((b, i) => (staggered ? i * Math.min(40, 500 / bs.length) : 0)).ease(d3.easeCubicOut)
      .attr('opacity', 1)
      .attrTween('d', function (b) {
        const from = { ...this.__g }, to = target(b);
        const ix = d3.interpolateNumber(from.x, to.x), iw = d3.interpolateNumber(from.w, to.w), ih = d3.interpolateNumber(from.h, to.h);
        return (k) => { this.__g = { x: ix(k), w: iw(k), h: ih(k) }; return barPath(this.__g.x, base, this.__g.w, this.__g.h); };
      });
  }

  // Line (rates): morph point by point from the previous drawing; gaps where a
  // period had nothing to measure.
  const lineG = svg.select('g.linelayer');
  T(lineG).attr('opacity', isRate ? 1 : 0);
  const pts = bs.map((b, i) => ({ x: cx(b), y: isRate && vals[i] != null ? y(vals[i]) : null, key: b.key, i }));
  const prevPts = lineG.node().__pts;
  const sameShape = prevPts && prevPts.length === pts.length;
  const fromPts = pts.map((p, i) => ({ x: p.x, y: sameShape && prevPts[i].y != null ? prevPts[i].y : base }));
  lineG.node().__pts = pts;
  const lineGen = d3.line().defined((p) => p.y != null).x((p) => p.x).y((p) => p.y).curve(d3.curveMonotoneX);
  const at = (k) => pts.map((p, i) => ({ x: p.x, y: p.y == null ? null : fromPts[i].y + (p.y - fromPts[i].y) * k }));
  if (!dur || !isRate) {
    lineG.selectAll('path').interrupt();
    lineG.select('path.line').attr('d', lineGen(pts));
  } else {
    lineG.select('path.line').transition().duration(dur).ease(d3.easeCubicOut).attrTween('d', () => (k) => lineGen(at(k)));
  }
  const dots = lineG.select('g.dots').selectAll('circle').data(pts.filter((p) => p.y != null), (p) => p.key)
    .join((enter) => enter.append('circle').attr('r', 3.5).attr('cx', (p) => p.x).attr('cy', base));
  T(dots).attr('cx', (p) => p.x).attr('cy', (p) => p.y);

  // X labels: thin them out so they never collide.
  const every = Math.max(1, Math.ceil((bs.length * 64) / (W - pad.l - pad.r)));
  svg.select('g.xlabels').selectAll('text').data(bs, (b) => b.key).join((enter) => enter.append('text').attr('class', 'tick').attr('text-anchor', 'middle'))
    .attr('x', cx).attr('y', H - 8)
    .text((b, i) => ((bs.length - 1 - i) % every === 0 ? b.label : ''));

  // Selective direct label: the peak bar, or the latest point on a line.
  const peak = svg.select('text.peak');
  let li = -1;
  if (isRate) for (let i = vals.length - 1; i >= 0; i--) { if (vals[i] != null) { li = i; break; } }
  else if (max > 0) li = vals.indexOf(max);
  if (li < 0) T(peak).attr('opacity', 0);
  else {
    const v = vals[li];
    const fromV = peak.node().__v ?? 0;
    peak.node().__v = v;
    const show = (k) => (isRate ? `${fmt1(fromV + (v - fromV) * k)}%` : fmtNum(Math.round(fromV + (v - fromV) * k)));
    const px = Math.min(W - pad.r - 18, Math.max(pad.l + 18, cx(bs[li])));
    if (!dur) peak.attr('opacity', 1).attr('x', px).attr('y', y(v) - 9).text(show(1));
    else peak.transition().duration(dur).delay(staggered && !isRate ? li * Math.min(40, 500 / bs.length) : 0).ease(d3.easeCubicOut)
      .attr('opacity', 1).attr('x', px).attr('y', y(v) - 9)
      .tween('text', function () { return (k) => { this.textContent = show(k); }; });
  }

  // Hover targets: a full-height band per period.
  svg.select('g.hits').selectAll('rect').data(bs, (b) => b.key).join((enter) => enter.append('rect').attr('class', 'hit').attr('tabindex', 0))
    .attr('x', (b) => x(b.key)).attr('y', pad.t - 10).attr('width', band).attr('height', base - pad.t + 10)
    .attr('data-i', (b, i) => i)
    .attr('aria-label', (b, i) => `${b.long}: ${vals[i] == null ? 'no data' : isRate ? fmt1(vals[i]) + '%' : vals[i].toLocaleString()}`);
  svg.select('line.crosshair').attr('y1', pad.t - 6).attr('y2', base);

  el.__ctx = { bs, m, vals, cx, isRate };
  const empty = isRate ? !present.length : max === 0;
  const em = el.querySelector('.chart-empty');
  em.classList.toggle('hidden', !empty);
  em.querySelector('strong').textContent = isRate ? 'Nothing to measure yet' : `No ${m.label.toLowerCase()} in this period`;
  em.querySelector('span').textContent = state.ov.sender || state.ov.template ? 'Try a wider range or clear the filters.' : 'Try a wider date range.';
}

function bindChartHover(el) {
  const svg = el.querySelector('svg.d3chart');
  const at = (target) => {
    const hit = target.closest?.('rect.hit');
    return hit ? Number(hit.getAttribute('data-i')) : -1;
  };
  const show = (i, px, py) => {
    const { bs, m, cx, isRate } = el.__ctx;
    const b = bs[i];
    $$('path.bar', el).forEach((p, j) => p.classList.toggle('on', j === i));
    $$('g.dots circle', el).forEach((c) => c.classList.toggle('on', c.__data__.i === i));
    el.classList.toggle('hovering', i >= 0);
    const ch = svg.querySelector('line.crosshair');
    ch.setAttribute('x1', cx(b)); ch.setAttribute('x2', cx(b)); ch.setAttribute('opacity', isRate ? 1 : 0);
    const dr = rateOf(b, METRICS.deliveryRate), rr = rateOf(b, METRICS.readRate);
    const row = (key, label, value) => `<div class="tt-row ${state.ov.metric === key ? 'cur' : ''}"><span><i class="key ${state.ov.metric === key ? '' : 'none'}"></i>${label}</span><b>${value}</b></div>`;
    showTip(`<div class="tt-title">${esc(b.long)}</div>
      ${row('sent', 'Sent', b.sent.toLocaleString())}
      ${row('deliveryRate', 'Delivered', `${b.delivered.toLocaleString()}${dr == null ? '' : ` · ${fmt1(dr)}%`}`)}
      ${row('readRate', 'Read', `${b.read.toLocaleString()}${rr == null ? '' : ` · ${fmt1(rr)}%`}`)}
      ${row('failed', 'Failed', b.failed.toLocaleString())}`, px, py);
  };
  const clear = () => {
    $$('path.bar.on, g.dots circle.on', el).forEach((n) => n.classList.remove('on'));
    el.classList.remove('hovering');
    svg.querySelector('line.crosshair').setAttribute('opacity', 0);
    hideTip();
  };
  el.addEventListener('pointermove', (e) => { const i = at(e.target); i < 0 ? clear() : show(i, e.clientX, e.clientY); });
  el.addEventListener('pointerleave', clear);
  el.addEventListener('focusin', (e) => { const i = at(e.target); if (i < 0) return; const r = e.target.getBoundingClientRect(); show(i, r.left + r.width / 2, r.top + 40); });
  el.addEventListener('focusout', clear);
}

function showTip(html, x, y) {
  const tip = $('#chartTip');
  clearTimeout(tip.__hideT);
  tip.innerHTML = html;
  tip.classList.remove('hidden');
  const r = tip.getBoundingClientRect();
  let left = x + 14, topY = y - r.height - 12;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (topY < 70) topY = y + 18;
  tip.style.left = left + 'px';
  tip.style.top = topY + 'px';
}
const hideTip = () => $('#chartTip').classList.add('hidden');
function hideTipSoon() { const tip = $('#chartTip'); clearTimeout(tip.__hideT); tip.__hideT = setTimeout(hideTip, 60); }

function renderChartTable(el, bs) {
  const pctCell = (v) => (v == null ? '<td class="muted">—</td>' : `<td>${fmt1(v)}%</td>`);
  el.innerHTML = `<table><thead><tr><th>${bs.length > 20 || state.stats.range === 90 ? 'Week' : 'Day'}</th><th>Sent</th><th>Delivered</th><th>Delivery rate</th><th>Read</th><th>Read rate</th><th>Failed</th></tr></thead><tbody>${bs
    .slice()
    .reverse()
    .map((b) => `<tr><td>${esc(b.long)}</td><td>${b.sent.toLocaleString()}</td><td>${b.delivered.toLocaleString()}</td>${pctCell(rateOf(b, METRICS.deliveryRate))}<td>${b.read.toLocaleString()}</td>${pctCell(rateOf(b, METRICS.readRate))}<td>${b.failed.toLocaleString()}</td></tr>`)
    .join('')}</tbody></table>`;
}

$('#chartTableBtn').addEventListener('click', () => {
  state.ov.table = !state.ov.table;
  saveOv();
  renderCharts();
});
new ResizeObserver(() => drawChartsInstant()).observe($('#dayChart'));
new ResizeObserver(() => drawChartsInstant()).observe($('#xChart'));
function drawChartsInstant() {
  if (!state.stats) return;
  const bs = makeBuckets(state.stats.days, state.stats.range), m = METRICS[state.ov.metric];
  drawChart($('#dayChart'), bs, m, { instant: true });
  if (!$('#chartModal').classList.contains('hidden')) drawChart($('#xChart'), bs, m, { instant: true });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') drawChartsInstant(); });

// --- Expanded chart: grows out of the card and shrinks back into it ---

function flipFrom(box, rect) {
  const end = box.getBoundingClientRect();
  return [
    { transform: `translate(${rect.left - end.left}px, ${rect.top - end.top}px) scale(${rect.width / end.width}, ${rect.height / end.height})`, opacity: 0.5 },
    { transform: 'none', opacity: 1 },
  ];
}

function openChartModal() {
  const modal = $('#chartModal');
  const box = modal.querySelector('.chart-box');
  modal.classList.remove('hidden', 'closing');
  renderCharts();
  if (!Motion.reduce()) {
    box.animate(flipFrom(box, $('#chartCard').getBoundingClientRect()), { duration: 460, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    modal.animate([{ backgroundColor: 'rgba(12, 18, 24, 0)' }, { backgroundColor: getComputedStyle(modal).backgroundColor }], { duration: 300 });
  }
  $('#xClose').focus({ preventScroll: true });
}

function closeChartModal() {
  const modal = $('#chartModal');
  if (modal.classList.contains('hidden') || modal.__closing) return;
  hideTip();
  const box = modal.querySelector('.chart-box');
  const done = () => { modal.__closing = false; modal.classList.add('hidden'); renderCharts({ instant: true }); };
  if (Motion.reduce()) return done();
  modal.__closing = true;
  box.animate(flipFrom(box, $('#chartCard').getBoundingClientRect()).reverse(), { duration: 320, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'forwards' }).finished.then(() => {
    box.getAnimations().forEach((a) => a.cancel());
    done();
  });
  modal.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, fill: 'forwards' }).finished.then((a) => a.cancel?.());
}

$('#chartExpandBtn').addEventListener('click', openChartModal);
$('#xClose').addEventListener('click', closeChartModal);
$('#chartModal').addEventListener('click', (e) => e.target.id === 'chartModal' && closeChartModal());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeChartModal());

// --- Funnel ---

function renderFunnel(st) {
  const t = st.totals;
  $('#funnelSub').textContent = `In the last ${st.range} days${st.filters.sender || st.filters.template ? ' · filtered' : ''}`;
  if (!t.sent && !t.failed) {
    $('#funnel').innerHTML = emptyMini('chart', 'Nothing sent in this period. Try a wider date range.');
    return;
  }
  const rows = [
    ['Sent', t.sent, 'messages'],
    ['Delivered', t.delivered, 'reached the phone'],
    ['Read', t.read, 'opened the chat'],
  ];
  $('#funnel').innerHTML =
    rows
      .map(([name, v, note], i) => `<div class="funnel-row">
        <div class="funnel-name">${name}</div>
        <div class="funnel-track"><div class="funnel-bar" data-w="${t.sent ? ((100 * v) / t.sent).toFixed(2) : 0}" data-k="fn-${name}"></div></div>
        <div class="funnel-val"><span><b data-count="${v}" data-fmt="int" data-k="fnv-${name}">0</b> ${note}</span><span>${i ? `<b data-count="${t.sent ? ((100 * v) / t.sent).toFixed(2) : 0}" data-fmt="pct1" data-k="fnp-${name}">0</b><b>%</b> of sent` : ''}</span></div>
      </div>`)
      .join('') +
    `<div class="funnel-note"><span>Failed <b data-count="${t.failed}" data-fmt="int" data-k="fn-failed">0</b></span><span>Waiting to send <b data-count="${t.pending}" data-fmt="int" data-k="fn-pending">0</b></span></div>`;
}

// --- Number health ---

function renderHealth(st) {
  if (!st.senders.length) {
    $('#senderHealth').innerHTML = emptyMini('phone', 'No numbers yet. <a href="#" onclick="senderForm();return false">Add your first WhatsApp number</a>.');
    return;
  }
  $('#senderHealth').innerHTML = st.senders
    .map((s) => {
      const limit = s.limit === undefined ? 250 : s.limit;
      const known = s.limit !== undefined;
      const used = limit ? s.today / limit : 0;
      const cls = used >= 1 ? 'over' : used >= 0.8 ? 'warn' : '';
      return `<div class="health-row">
        <div>
          <div class="health-name"><span>${esc(s.label)}</span><i class="q-dot ${esc(s.qualityRating || 'none')}" title="Quality: ${esc(s.qualityRating || 'unknown')}"></i>${s.enabled ? '' : '<span class="pill">off</span>'}</div>
          <div class="health-phone">${esc(s.displayPhone || '—')}</div>
        </div>
        <div class="health-meter">
          <div class="meter ${cls}"><span data-w="${Math.min(100, used * 100).toFixed(2)}" data-k="h-${s.id}"></span></div>
          <div class="meter-label"><span><b data-count="${s.today}" data-fmt="int" data-k="ht-${s.id}">0</b> ${limit === null ? 'today · unlimited' : `/ ${limit.toLocaleString()} today`}</span><span>${known ? '' : 'limit unknown'}</span></div>
        </div>
        <div class="health-total"><b data-count="${s.sent}" data-k="hs-${s.id}">0</b>${s.sent ? `sent · ${pct(s.delivered, s.sent)}% delivered` : 'nothing sent yet'}</div>
      </div>`;
    })
    .join('');
}

// --- Upcoming & recent ---

function renderUpcoming(st) {
  if (!st.upcoming.length) {
    $('#upcoming').innerHTML = emptyMini('calendar', 'Nothing scheduled. Choose <b>Later</b> when sending to plan a campaign ahead.');
    return;
  }
  $('#upcoming').innerHTML = `<div class="mini">${st.upcoming
    .map((c) => {
      const d = new Date(c.scheduledAt);
      return `<div class="mini-item up-item" data-open-campaign="${c.id}">
        <div class="when-chip"><b>${d.getDate()}</b><small>${d.toLocaleDateString(undefined, { month: 'short' })}</small></div>
        <div class="mini-title">${esc(c.name)}</div>
        <div class="mini-meta">${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · ${c.total.toLocaleString()} recipients</div>
        <div class="mini-right"><b>${relTime(c.scheduledAt)}</b></div>
      </div>`;
    })
    .join('')}</div>`;
}

function renderRecent(st) {
  const list = st.recent.filter((c) => c.status !== 'scheduled');
  if (!list.length) {
    $('#recent').innerHTML = emptyMini('send', 'No campaigns yet. <a href="#" data-goto="send">Send your first one</a>.');
    return;
  }
  $('#recent').innerHTML = `<div class="mini">${list
    .map((c) => {
      const s = c.stats || {};
      const sent = (s.sent || 0) + (s.delivered || 0) + (s.read || 0);
      const delivered = (s.delivered || 0) + (s.read || 0);
      const color = window.folderColorAt && c.colorIndex != null ? folderColorAt(c.colorIndex) : 'oklch(var(--fl) var(--fc) 250)';
      return `<div class="mini-item rc-item" data-open-campaign="${c.id}" style="--c:${color}">
        <span class="cp-ficon" aria-hidden="true"><i class="cf-tab"></i><i class="cf-paper"></i><i class="cf-body"></i></span>
        <div class="mini-title" title="${esc(c.name)}">${esc(window.campaignDisplayName ? campaignDisplayName(c) : c.name)}</div>
        <div class="mini-right"><b><span data-count="${pct(delivered, sent)}" data-k="rc-${c.id}">0</span>%</b>delivered</div>
        <div class="mini-meta"><span class="pill ${c.status}" style="height:18px;font-size:10.5px">${c.status}</span> ${relTime(c.startedAt || c.createdAt)} · ${c.total.toLocaleString()} recipients</div>
        <div class="mini-progress"><span data-w="${pct(sent + (s.failed || 0), c.total)}" data-k="rp-${c.id}"></span></div>
      </div>`;
    })
    .join('')}</div>`;
}

document.addEventListener('click', (e) => {
  const item = e.target.closest('[data-open-campaign]');
  if (!item || e.target.closest('a')) return;
  showTab('campaigns');
  openCampaign(item.dataset.openCampaign);
});

// --- Demo workspace ---

async function seedDemo(btn) {
  await guard(async () => {
    await api('/demo/seed', { method: 'POST' });
    toast('Demo workspace loaded: 3 numbers, 3 templates and two weeks of history');
    state.selectedSenders.clear();
    await Promise.all([loadSenders(), loadTemplates()]);
    await loadOverview();
  }, btn);
}
$('#seedBtn').addEventListener('click', (e) => seedDemo(e.target));
$('#setupCard').addEventListener('click', (e) => { if (e.target.id === 'seedInline') seedDemo(e.target); });
$('#unseedBtn').addEventListener('click', (e) =>
  guard(async () => {
    const ok = await confirmDialog({ title: 'Remove demo data?', message: 'The sample numbers, templates and campaigns are deleted. Anything you added yourself stays.', confirmText: 'Remove', danger: true });
    if (!ok) return;
    await api('/demo/seed', { method: 'DELETE' });
    toast('Demo data removed');
    state.selectedSenders.clear();
    await Promise.all([loadSenders(), loadTemplates()]);
    await loadOverview();
  }, e.target)
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

LA.hydrate();

// --- Account, workspace and team (tenancy.js) -----------------------------------
async function loadMe() {
  state.me = await api('/me');
  const { user, workspace } = state.me;
  const initials = (user.name || user.email).split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  $('#acctAv').textContent = initials;
  $('#acctAv').setAttribute('style', avatarStyle(user.email));
  document.body.classList.toggle('no-ai', !state.me.admin); // hides the Assistant and AI settings
  $('#acctWs').textContent = workspace.name;
  $('#acctUser').textContent = user.name || user.email;
  $('#wsName').value = workspace.name;
  $('#wsName').disabled = $('#wsSave').disabled = state.me.role !== 'owner';
  $('#acctMe').innerHTML = `<span class="acct-av lg" style="${avatarStyle(user.email)}">${esc(initials)}</span><span class="acct-text"><b>${esc(user.name || user.email)}</b><span>${esc(user.email)}</span></span><span class="pill ${state.me.role === 'owner' ? 'scheduled' : ''}">${state.me.role === 'owner' ? 'Owner' : 'Member'}</span>`;
  const n = state.me.workspaces.length;
  $('#acctFacts').innerHTML = `<div><dt>Email</dt><dd>${user.emailVerified ? '<span class="acct-ok">Confirmed</span>' : 'Not confirmed yet'}</dd></div>
    <div><dt>Workspaces</dt><dd>${n} ${n === 1 ? 'workspace' : 'workspaces'}</dd></div>
    ${user.createdAt ? `<div><dt>Member since</dt><dd>${new Date(user.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</dd></div>` : ''}`;
  const del = user.deletionRequest;
  $('#acctDelete').classList.toggle('hidden', Boolean(del));
  $('#acctDelNote').classList.toggle('hidden', !del);
  if (del) $('#acctDelNote').innerHTML = `<b>Deletion requested</b> on ${new Date(del.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}. Our team will get in touch before anything is deleted. Your account works as usual until then.<button class="btn sm" id="acctDelCancel">Cancel request</button>`;
  renderWorkspaces();
  document.title = `${workspace.name} · WhatsApp Sender`;
  $('#verifyBanner').classList.toggle('hidden', user.emailVerified);
  $('#verifyEmail').textContent = user.email;
}
$('#verifyResend').addEventListener('click', (e) => guard(async () => {
  const r = await api('/account/verify-email', { method: 'POST' });
  toast(r.already ? 'Your email is already confirmed' : r.mail ? 'Sent. Check your inbox.' : 'Email isn’t set up on this server yet');
  if (r.already) loadMe();
}, e.target));
// --- Team: a row of avatars; click one for their details and actions, the dashed circle to invite ---
const TEAM_VISIBLE = 7;
const initials2 = (n) => String(n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
async function loadTeam() {
  const t = await api('/team');
  state.team = t;
  $('#teamCount').textContent = `${t.members.length} ${t.members.length === 1 ? 'person' : 'people'}${t.invites.length ? ` · ${t.invites.length} invited` : ''}`;
  renderTeam();
}
// Everyone in one list: you first, then owners, members, and pending invites last.
function teamPeople() {
  const t = state.team;
  const rank = (m) => (m.you ? 0 : m.role === 'owner' ? 1 : 2);
  return [
    ...[...t.members].sort((x, y) => rank(x) - rank(y)).map((m) => ({ ...m, kind: 'member', key: 'm' + m.id, label: m.you ? 'You' : (m.name || m.email).split(/[\s@]/)[0] })),
    ...t.invites.map((i) => ({ ...i, kind: 'invite', key: 'i' + i.id, name: '', label: i.email.split('@')[0] })),
  ];
}
function tmAvatar(p, size = '') {
  return `<span class="tm-face ${size}" style="${p.kind === 'invite' ? '' : avatarStyle(p.email)}">${p.kind === 'invite' ? icon('user', size ? 16 : 20) : esc(initials2(p.name || p.email))}</span>`;
}
function renderTeam() {
  const t = state.team, people = teamPeople(), owner = t.role === 'owner';
  const shown = people.slice(0, TEAM_VISIBLE), extra = people.length - shown.length;
  $('#teamRow').innerHTML = '<div class="tm-stack"><span class="tm-tip" aria-hidden="true"></span>' + shown.map((p, i) => `<button type="button" style="z-index:${TEAM_VISIBLE - i}" class="tm-av ${p.kind === 'invite' ? 'invited' : ''} ${p.role === 'owner' ? 'owner' : ''}" data-tm="${p.key}" data-label="${esc(p.kind === 'invite' ? p.email + ' · invited' : (p.you ? 'You · ' : '') + (p.name || p.email))}" aria-label="${esc(p.name || p.email)}${p.kind === 'invite' ? ' (invited)' : ''}">
      <span class="tm-pic">${tmAvatar(p)}${p.kind === 'invite' ? `<i class="tm-badge">${icon('clock', 10)}</i>` : p.role === 'owner' ? '<i class="tm-badge tm-crown" aria-label="Owner">★</i>' : ''}</span>
      <span class="tm-name">${esc(p.label)}</span>
    </button>`).join('')
    + (extra > 0 ? `<button type="button" class="tm-av" style="z-index:0" data-tm="all" data-label="See everyone" aria-label="Everyone in this workspace"><span class="tm-pic"><span class="tm-face tm-more">+${extra}</span></span><span class="tm-name">Everyone</span></button>` : '') + '</div>'
    + (owner ? `<button type="button" class="tm-av tm-add" data-tm="add" aria-label="Invite a teammate"><span class="tm-pic"><span class="tm-face">${icon('plus', 20)}</span></span><span class="tm-name">Invite</span></button>` : '');
}
// Popovers hang from the team row. A card opened from a face sits in one fixed place under the stack
// (the same for every face), and its hook slides along the top edge to point at the face that was
// clicked. Clicking another face while one is open swaps the contents in place and glides the hook over.
const tmHook = { x: null, at: 0 };
function tmPop(anchor, html, cls) {
  const inStack = anchor.closest('.tm-stack');
  const target = anchor.querySelector('.tm-face') || anchor;
  const fr = target.getBoundingClientRect(), base = (inStack || anchor).getBoundingClientRect();
  const swapping = inStack && tmHook.x != null && Date.now() - tmHook.at < 400; // a card was open a moment ago
  const el = Sheet.Menu.panel(0, 0, html);
  el.classList.add('tm-pop', cls);
  if (swapping) el.classList.add('tm-swap'); // no pop-in: it's the same card, new contents
  const w = el.offsetWidth, h = el.offsetHeight, gap = 12;
  const ar = anchor.getBoundingClientRect(); // the button itself never moves; the face inside it lifts and grows
  const cx = ar.left + ar.width / 2, cy = inStack ? ar.top + ar.height / 2 : fr.top + fr.height / 2;
  // Measured from the face's centre, so a face that's still growing gives the same answer.
  const faceBottom = inStack ? cy + 21 * 1.4 : fr.bottom, faceTop = inStack ? cy - 21 * 1.4 : fr.top;
  const left = Math.max(8, Math.min(innerWidth - w - 8, (inStack ? base.left - 6 : cx - w / 2)));
  const below = faceBottom + gap + h <= innerHeight - 8 || faceTop - gap - h < 8;
  el.style.left = left + 'px';
  el.style.top = (below ? faceBottom + gap : faceTop - gap - h) + 'px';
  el.classList.toggle('tm-up', !below);
  const arrow = Math.max(18, Math.min(w - 18, cx - left));
  if (swapping) {
    el.style.setProperty('--arrow-x', tmHook.x + 'px');
    requestAnimationFrame(() => requestAnimationFrame(() => el.style.setProperty('--arrow-x', arrow + 'px')));
  } else el.style.setProperty('--arrow-x', arrow + 'px');
  tmHook.x = arrow;
  if (inStack) {
    // remember where the hook was when this card closes, so the next face can glide from there
    const watch = new MutationObserver(() => { if (!el.isConnected) { tmHook.at = Date.now(); watch.disconnect(); } });
    watch.observe(document.body, { childList: true });
  } else tmHook.x = null;
  return el;
}
function memberPop(anchor, p) {
  const t = state.team, owner = t.role === 'owner', inv = p.kind === 'invite';
  const ROLE_TEXT = { owner: 'Manages numbers, settings and the team', member: 'Sends campaigns, uses the Inbox and contacts' };
  const row = (k, v) => `<div class="tm-kv"><span>${k}</span><b>${v}</b></div>`;
  const when = (d) => (d ? esc(relTime(d)) : '');
  const head = `<div class="tm-card">
      <span class="tm-pic">${tmAvatar(p, 'lg')}${inv ? `<i class="tm-badge">${icon('clock', 10)}</i>` : ''}</span>
      <div class="tm-who"><b title="${esc(p.name || p.email)}">${esc(inv ? p.email : p.name || p.email)}${p.you ? ' <span class="muted">(you)</span>' : ''}</b>
        ${inv ? '<span class="tm-state"><i></i>Invite pending</span>' : `<span title="${esc(p.email)}">${esc(p.email)}</span>`}</div>
    </div>`;
  const details = `<div class="tm-sec">
      ${row('Role', `${p.role === 'owner' ? 'Owner' : 'Member'}<small>${ROLE_TEXT[p.role] || ''}</small>`)}
      ${inv ? (p.createdAt ? row('Invited', `${when(p.createdAt)}${p.invitedBy ? ` by ${esc(p.invitedBy)}` : ''}`) : '') + row('Link expires', when(p.expiresAt)) : p.joinedAt ? row('Joined', when(p.joinedAt)) : ''}
    </div>`;
  const link = inv && owner ? `<div class="tm-sec">
      <div class="tm-sec-label">Invite link</div>
      <div id="tmLink"><button class="btn sm" data-act="link">${icon('copy', 14)}Get invite link</button></div>
      <p class="tm-note">A fresh link is made each time and the one sent before stops working, so only the latest link opens the invite.</p>
    </div>` : '';
  const acts = inv
    ? (owner ? `${state.me.mail ? `<button class="btn sm" data-act="resend">${icon('send', 14)}Resend email</button>` : ''}<button class="btn sm quiet danger tm-end" data-act="uninvite">Cancel invite</button>` : '')
    : p.you
      ? (t.members.length > 1 ? `<button class="btn sm quiet danger tm-end" data-act="leave">Leave workspace</button>` : '')
      : owner ? `<button class="btn sm" data-act="role">${p.role === 'owner' ? 'Make member' : 'Make owner'}</button><button class="btn sm quiet danger tm-end" data-act="remove">Remove</button>` : '';
  const el = tmPop(anchor, head + details + link + (acts ? `<div class="tm-acts">${acts}</div>` : ''), 'tm-member');
  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]'), act = btn?.dataset.act;
    if (!act) return;
    if (act === 'link' || act === 'resend') return guard(async () => {
      const r = await api(`/team/invites/${p.id}/link`, { method: 'POST', body: { email: act === 'resend' } });
      p.expiresAt = r.expiresAt;
      $('#tmLink', el).innerHTML = `<div class="tm-linkrow"><input readonly value="${esc(r.link)}" aria-label="Invite link" /><button class="btn sm" data-act="copy">${icon('copy', 14)}Copy</button></div>`;
      $('#tmLink input', el)?.select();
      if (act === 'resend') toast(r.emailed ? `Invite emailed to ${p.email} again` : 'New link ready. Copy it and send it to them.');
    }, btn);
    if (act === 'copy') { navigator.clipboard.writeText($('#tmLink input', el).value); toast('Invite link copied'); btn.innerHTML = `${icon('check', 14)}Copied`; return; }
    Sheet.Menu.close();
    if (act === 'uninvite') return guard(async () => { await api('/team/invites/' + p.id, { method: 'DELETE' }); toast('Invite cancelled'); loadTeam(); });
    if (act === 'role') return guard(async () => { await api('/team/members/' + p.id, { method: 'PATCH', body: { role: p.role === 'owner' ? 'member' : 'owner' } }); toast(p.role === 'owner' ? 'Now a member' : 'Now an owner'); loadTeam(); });
    const self = act === 'leave';
    if (!(await confirmDialog({ title: self ? 'Leave this workspace?' : `Remove ${p.name || p.email}?`, message: self ? 'You lose access until someone invites you again.' : 'They lose access to this workspace straight away.', confirmText: self ? 'Leave' : 'Remove', danger: true }))) return;
    guard(async () => { await api('/team/members/' + p.id, { method: 'DELETE' }); if (self) location.href = '/'; else { toast('Removed from the team'); loadTeam(); } });
  });
}
function invitePop(anchor) {
  const el = tmPop(anchor, `
    <div class="sg-pop-title">Invite a teammate</div>
    <div class="tm-inv-form">
      <input type="email" id="tmEmail" placeholder="name@company.com" aria-label="Their email" autocomplete="off" />
      <div class="seg tm-role" role="radiogroup" aria-label="Role"><button type="button" class="active" data-role="member">Member</button><button type="button" data-role="owner">Owner</button></div>
      <button class="btn primary" id="tmSend">Send invite</button>
    </div>
    <p class="tm-note">${state.me.mail ? 'They get an email with a link to join. Links work for 7 days.' : 'Email isn’t set up yet, so you’ll get a link to send them yourself. Links work for 7 days.'}</p>
    <div class="tm-out hidden" id="tmOut"></div>`, 'tm-invite');
  let role = 'member';
  const email = $('#tmEmail', el);
  setTimeout(() => email.focus({ preventScroll: true }), 30);
  $('.tm-role', el).addEventListener('click', (e) => { const b = e.target.closest('[data-role]'); if (!b) return; role = b.dataset.role; $$('.tm-role button', el).forEach((x) => x.classList.toggle('active', x === b)); });
  const send = () => guard(async () => {
    const r = await api('/team/invites', { method: 'POST', body: { email: email.value, role } });
    $('#tmOut', el).classList.remove('hidden');
    $('#tmOut', el).innerHTML = `<span>${icon('circle-check', 15)}${r.emailed ? `Invite emailed to <b>${esc(email.value)}</b>.` : `Invite ready for <b>${esc(email.value)}</b>. Send them this link:`}</span>
      <div class="row tight"><input readonly value="${esc(r.link)}" /><button class="btn sm" id="tmCopy">${icon('copy', 14)}Copy</button></div>`;
    $('#tmCopy', el).onclick = () => { navigator.clipboard.writeText(r.link); toast('Invite link copied'); };
    email.value = ''; email.focus();
    loadTeam();
  }, $('#tmSend', el));
  $('#tmSend', el).onclick = send;
  email.addEventListener('keydown', (e) => e.key === 'Enter' && send());
}
function allPop(anchor) {
  const el = tmPop(anchor, `<div class="search-wrap tm-search">${icon('search', 15)}<input class="search" id="tmQ" placeholder="Search people" /></div><div class="tm-list" id="tmList"></div>`, 'tm-all');
  const draw = () => {
    const q = $('#tmQ', el).value.trim().toLowerCase();
    const list = teamPeople().filter((p) => !q || (p.name || '').toLowerCase().includes(q) || p.email.toLowerCase().includes(q));
    $('#tmList', el).innerHTML = list.map((p) => `<button type="button" class="tm-li" data-tmk="${p.key}">${tmAvatar(p, 'sm')}<span class="tm-who"><b>${esc(p.kind === 'invite' ? p.email : p.name || p.email)}${p.you ? ' <span class="muted">(you)</span>' : ''}</b><span>${p.kind === 'invite' ? 'Invited' : esc(p.email)}</span></span><span class="pill ${p.role === 'owner' ? 'scheduled' : ''} ws-here">${p.role === 'owner' ? 'Owner' : 'Member'}</span></button>`).join('') || '<p class="tm-note" style="text-align:center;padding:14px 0">Nobody matches.</p>';
  };
  draw();
  setTimeout(() => $('#tmQ', el).focus({ preventScroll: true }), 30);
  $('#tmQ', el).addEventListener('input', draw);
  $('#tmList', el).addEventListener('click', (e) => { const b = e.target.closest('[data-tmk]'); if (!b) return; const p = teamPeople().find((x) => x.key === b.dataset.tmk); memberPop(anchor, p); });
}
// The stack magnifies like a dock: the face under the cursor swells and lifts, its neighbours grow a
// little less the further away they are, and one tooltip springs along above the face you're on.
// Every value is a spring (stiffness 300, damping 17: a quick move with a small, soft overshoot).
(() => {
  const K = 300, C = 17, RANGE = 70, GROW = 0.4, LIFT = -0.08;
  const springs = new Map(); // element → { s, v } for scale and lift
  const tip = { x: 0, vx: 0, o: 0, vo: 0, tx: 0, to: 0, el: null, label: '' };
  let mouseX = null, focusEl = null, raf = 0, last = 0;
  const reduce = () => Motion.reduce();
  const faces = () => [...document.querySelectorAll('#teamRow .tm-stack .tm-av')];
  const step = (o, key, vkey, target, dt) => { const a = -K * (o[key] - target) - C * o[vkey]; o[vkey] += a * dt; o[key] += o[vkey] * dt; };
  function frame(t) {
    const dt = Math.min(0.032, (t - (last || t)) / 1000 || 0.016); last = t;
    const stack = document.querySelector('#teamRow .tm-stack');
    if (!stack) { raf = 0; return; }
    const box = stack.getBoundingClientRect();
    let moving = false, best = null, bestD = Infinity;
    // First where everything is, so the closest face is known before anything moves.
    const items = faces().map((el) => {
      const r = el.getBoundingClientRect(), cx = r.left + r.width / 2;
      const d = focusEl ? (el === focusEl ? 0 : Infinity) : mouseX == null ? Infinity : Math.abs(mouseX - cx);
      if (d < bestD) { bestD = d; best = { el, cx: cx - box.left }; }
      return { el, d };
    });
    for (const { el, d } of items) {
      const pic = el.querySelector('.tm-pic');
      const near = Math.max(0, 1 - d / RANGE), ease = near * near * (3 - 2 * near); // smoothstep falloff
      const sp = springs.get(el) || { s: 1, v: 0, y: 0, vy: 0 };
      springs.set(el, sp);
      const target = 1 + GROW * ease;
      if (reduce()) { sp.s = target; sp.v = 0; } else step(sp, 's', 'v', target, dt);
      const lift = best && el === best.el && near > 0 ? LIFT : 0; // only the face being named lifts
      if (reduce()) sp.y = lift; else step(sp, 'y', 'vy', lift, dt);
      pic.style.transform = `translateY(${(sp.y * 42).toFixed(2)}px) scale(${sp.s.toFixed(4)})`;
      el.style.zIndex = String(Number.isFinite(d) ? 1000 - Math.round(d) : 10); // nearest on top
      if (Math.abs(sp.v) > 0.001 || Math.abs(sp.s - target) > 0.001 || Math.abs(sp.vy) > 0.001 || Math.abs(sp.y - lift) > 0.001) moving = true;
    }
    // tooltip: over the closest face, 24px above its lifted, magnified top
    const active = best && bestD < RANGE * 0.6 && !document.querySelector('.tm-pop') ? best : null; // no name tooltip over an open card
    tip.el = stack.querySelector('.tm-tip');
    if (active) {
      const label = active.el.dataset.label || '';
      if (label !== tip.label) { tip.el.textContent = label; tip.label = label; }
      tip.tx = active.cx; tip.to = 1;
      if (tip.o < 0.05) { tip.x = tip.tx; tip.vx = 0; } // appear in place, then follow
    } else tip.to = 0;
    if (reduce()) { tip.x = tip.tx; tip.o = tip.to; } else { step(tip, 'x', 'vx', tip.tx, dt); step(tip, 'o', 'vo', tip.to, dt); }
    const o = Math.max(0, Math.min(1, tip.o));
    const top = 21 * (1 + GROW) + Math.abs(LIFT) * 42 + 24 + 13; // half the magnified face + its lift + 24px gap + half the tooltip
    tip.el.style.opacity = o.toFixed(3);
    const half = tip.el.offsetWidth / 2, x = Math.max(half - 14, tip.x); // never past the card's left edge
    tip.el.style.setProperty('--tip-shift', (tip.x - x).toFixed(2) + 'px'); // keeps the arrow pointing at the face
    tip.el.style.transform = `translate(${x.toFixed(2)}px, ${(-top + (1 - o) * 8).toFixed(2)}px) translate(-50%, -50%) scale(${(0.85 + 0.15 * o).toFixed(3)})`;
    if (Math.abs(tip.vx) > 0.01 || Math.abs(tip.x - tip.tx) > 0.1 || Math.abs(tip.o - tip.to) > 0.002) moving = true;
    raf = moving || mouseX != null || focusEl ? requestAnimationFrame(frame) : 0;
    if (!raf) last = 0;
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  const row = $('#teamRow');
  row.addEventListener('mousemove', (e) => { mouseX = e.target.closest('.tm-stack') ? e.clientX : null; kick(); });
  row.addEventListener('mouseleave', () => { mouseX = null; kick(); });
  row.addEventListener('focusin', (e) => { focusEl = e.target.closest('.tm-stack .tm-av'); kick(); });
  row.addEventListener('focusout', () => { focusEl = null; kick(); });
})();
$('#teamRow').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tm]');
  if (!b) return;
  if (b.dataset.tm === 'add') return invitePop(b);
  if (b.dataset.tm === 'all') return allPop(b);
  memberPop(b, teamPeople().find((p) => p.key === b.dataset.tm));
});
// The account menu: who you are, your workspaces, the theme, and log out.
const LOGOUT_SVG = '<svg class="logout-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><g class="logout-arrow"><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></g></svg>';
const TICK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
$('#acctBtn').addEventListener('click', (e) => {
  const me = state.me;
  if (!me) return;
  const btn = e.currentTarget, r = btn.getBoundingClientRect();
  const cur = document.documentElement.dataset.theme;
  const el = Sheet.Menu.panel(r.left, 0, `
    <div class="acct-pop-me"><span class="acct-av" style="${avatarStyle(me.user.email)}">${esc($('#acctAv').textContent)}</span><span class="acct-text"><b>${esc(me.user.name || me.user.email)}</b><span>${esc(me.user.email)}</span></span></div>
    <hr />
    <div class="acct-pop-label">Workspaces</div>
    ${me.workspaces.map((w) => `<button type="button" class="acct-pop-item" data-ws="${w.id}"><span>${esc(w.name)}</span>${w.id === me.workspace.id ? TICK_SVG : ''}</button>`).join('')}
    <button type="button" class="acct-pop-item" data-act="team">${icon('users', 15)}<span>Workspace & team</span></button>
    ${me.admin ? `<button type="button" class="acct-pop-item" data-act="admin">${icon('layout-grid', 15)}<span>Admin: all workspaces</span></button>` : ''}
    <hr />
    <div class="acct-pop-theme"><span>Theme</span><div class="seg seg-icons">${THEMES.map(([k, label, ic]) => `<button type="button" data-theme-set="${k}" title="${label}" class="${k === cur ? 'active' : ''}">${icon(ic, 15)}</button>`).join('')}</div></div>
    <hr />
    <a class="acct-pop-item logout" href="/logout">${LOGOUT_SVG}<span>Log out</span></a>`);
  el.classList.add('acct-pop');
  el.style.width = Math.max(240, r.width) + 'px';
  el.style.top = Math.max(8, r.top - 8 - el.offsetHeight) + 'px';
  el.addEventListener('click', (ev) => {
    const ws = ev.target.closest('[data-ws]'), act = ev.target.closest('[data-act]')?.dataset.act;
    if (ws) {
      Sheet.Menu.close();
      if (ws.dataset.ws !== me.workspace.id) switchWorkspace(ws.dataset.ws);
    }
    if (act === 'team') { Sheet.Menu.close(); showTab('settings'); scrollTo({ top: 0, behavior: 'smooth' }); } // Workspace & team is the first card
    if (act === 'admin') location.href = '/admin.html';
  });
});
// Edit your own name and email (a new email needs your password, then a confirmation link).
$('#acctEdit').addEventListener('click', () => {
  const u = state.me.user;
  const body = openModal('Edit your account', `
    <label>Your name<input id="aeName" maxlength="60" value="${esc(u.name || '')}" autocomplete="name" /></label>
    <label>Email<input id="aeEmail" type="email" value="${esc(u.email)}" autocomplete="email" /></label>
    <label id="aePwWrap" class="hidden">Current password <span class="opt">needed to change your email</span><input id="aePw" type="password" autocomplete="current-password" /></label>
    <p class="sub hidden" id="aeNote">We'll send a confirmation link to the new address and let the old one know.</p>
    <div class="modal-actions"><button class="btn quiet" id="aeCancel">Cancel</button><button class="btn primary" id="aeSave">Save</button></div>`);
  const emailChanged = () => $('#aeEmail', body).value.trim().toLowerCase() !== u.email;
  $('#aeEmail', body).addEventListener('input', () => { const c = emailChanged(); $('#aePwWrap', body).classList.toggle('hidden', !c); $('#aeNote', body).classList.toggle('hidden', !c); });
  $('#aeCancel', body).onclick = closeModal;
  $('#aeSave', body).onclick = (e) => guard(async () => {
    const changed = emailChanged();
    await api('/account', { method: 'PATCH', body: { name: $('#aeName', body).value, email: $('#aeEmail', body).value, current: $('#aePw', body).value } });
    closeModal();
    await loadMe();
    loadTeam();
    toast(changed ? 'Saved. Check the new inbox to confirm it.' : 'Saved');
  }, e.target);
});

$('#wsSave').addEventListener('click', (e) => guard(async () => { await api('/workspace', { method: 'PATCH', body: { name: $('#wsName').value } }); await loadMe(); toast('Workspace renamed'); }, e.target));
// --- Workspaces: the list in Settings, creating one, switching -------------------------------
// After a create or switch the page reloads into the other workspace; this note survives the reload
// so it can say where you are now and how to get back.
function switchWorkspace(id, kind = 'switched') {
  const w = state.me.workspaces.find((x) => x.id === id);
  return guard(async () => {
    await api('/workspace/switch', { method: 'POST', body: { id } });
    try { sessionStorage.setItem('wsNotice', JSON.stringify({ kind, name: w?.name || '' })); } catch {}
    location.reload();
  });
}
function renderWorkspaces() {
  const me = state.me, lim = me.workspaceLimit;
  $('#wsCount').textContent = lim == null ? `${me.workspaces.length}` : `${me.workspacesOwned} of ${lim} you can own`;
  $('#wsList').innerHTML = me.workspaces.map((w) => {
    const cur = w.id === me.workspace.id;
    return `<div class="ws-row ${cur ? 'current' : ''}">
      <span class="acct-av sm" style="${avatarStyle(w.id)}">${esc((w.name || '?').slice(0, 1).toUpperCase())}</span>
      <span class="ws-who"><b title="${esc(w.name)}">${esc(w.name)}</b><span>${w.role === 'owner' ? 'Owner' : 'Member'}</span></span>
      ${cur ? '<span class="pill scheduled ws-here">You\'re here</span>' : `<button class="btn sm" data-switch-ws="${w.id}">Switch</button>`}
    </div>`;
  }).join('');
  const full = lim != null && me.workspacesOwned >= lim;
  $('#wsNew').disabled = full;
  $('#wsNew').title = full ? `You can own up to ${lim} workspaces` : 'Create a workspace for another business';
}
$('#wsList').addEventListener('click', (e) => { const b = e.target.closest('[data-switch-ws]'); if (b) switchWorkspace(b.dataset.switchWs); });
$('#wsNew').addEventListener('click', async () => {
  const me = state.me, lim = me.workspaceLimit;
  const body = openModal('New workspace', `
    <p class="sub" style="margin-top:-6px">A separate, empty workspace for another business, with its own numbers, templates, contacts, campaigns and team. Your current workspace stays exactly as it is.</p>
    <label>Business name <span class="opt">up to 40 characters</span><input id="nwName" maxlength="40" placeholder="e.g. Cotton Business 3" /></label>
    <div class="nw-note">${icon('layout-grid', 15)}<span>You'll move into the new workspace straight away. To switch back, use <b>Your workspaces</b> here in Settings, or click your name at the bottom of the sidebar.${lim != null ? ` You own ${me.workspacesOwned} of ${lim}.` : ''}</span></div>
    <div class="modal-actions"><button class="btn quiet" id="nwCancel">Cancel</button><button class="btn primary" id="nwGo">Create and open</button></div>`);
  $('#nwName', body).focus();
  $('#nwCancel', body).onclick = closeModal;
  const go = (e) => guard(async () => {
    const r = await api('/workspaces', { method: 'POST', body: { name: $('#nwName', body).value } });
    try { sessionStorage.setItem('wsNotice', JSON.stringify({ kind: 'created', name: r.name })); } catch {}
    location.reload();
  }, $('#nwGo', body));
  $('#nwGo', body).onclick = go;
  $('#nwName', body).addEventListener('keydown', (e) => e.key === 'Enter' && go());
});
// The note left by a create or switch: say where you are and point at the switcher.
function showWorkspaceNotice() {
  let n; try { n = JSON.parse(sessionStorage.getItem('wsNotice') || 'null'); sessionStorage.removeItem('wsNotice'); } catch { return; }
  if (!n || !state.me) return;
  const name = state.me.workspace.name;
  const el = document.createElement('div');
  el.className = 'ws-notice';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="ws-notice-ic">${icon('circle-check', 18)}</span><div><b>${n.kind === 'created' ? `Workspace “${esc(name)}” created` : `Switched to “${esc(name)}”`}</b>
    <span>${n.kind === 'created' ? 'It starts empty. Add a WhatsApp number to get going. ' : ''}Switch workspaces any time from your name at the bottom of the sidebar.</span></div>
    <button class="icon-btn" aria-label="Close">${icon('x', 16)}</button>`;
  document.body.append(el);
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); document.body.classList.remove('ws-hint'); };
  el.querySelector('button').onclick = close;
  setTimeout(close, 9000);
  document.body.classList.add('ws-hint'); // the account button glows for a moment so people see where switching lives
}
// Request account deletion: nothing is deleted here. An admin follows up, then deletes it.
const DELETE_REASONS = [['not-using', 'Not using it any more'], ['too-expensive', 'Too expensive'], ['missing-feature', 'Missing something I need'], ['other-tool', 'Switching to another tool'], ['testing', 'Was only trying it out'], ['privacy', 'Privacy concerns'], ['other', 'Something else']];
$('#acctDelete').addEventListener('click', () => {
  const body = openModal('Request account deletion', `
    <p class="sub" style="margin-top:-6px">Tell us why and we'll get back to you. Nothing is deleted until our team has talked to you, and your account keeps working until then.</p>
    <div class="del-what"><b>When it's deleted</b><span>Workspaces only you use are erased with their numbers, contacts, campaigns and messages. Shared workspaces stay with your teammates.</span></div>
    <div class="field-label">Why are you leaving?</div>
    <div class="del-reasons">${DELETE_REASONS.map(([k, label]) => `<label class="del-reason"><input type="radio" name="delReason" value="${k}" /><span>${label}</span></label>`).join('')}</div>
    <label>Anything we could have done better? <span class="opt">optional</span><textarea id="delNote" rows="3" maxlength="1000" placeholder="It helps us a lot"></textarea></label>
    <label>Your password <span class="opt">to confirm it's you</span><input type="password" id="delPw" autocomplete="current-password" /></label>
    <div class="modal-actions"><button class="btn quiet" id="delCancel">Cancel</button><button class="btn danger-solid" id="delGo">Send request</button></div>`);
  $('#delCancel', body).onclick = closeModal;
  $('#delGo', body).onclick = (e) => {
    const reason = $('input[name=delReason]:checked', body)?.value;
    if (!reason) return toast('Pick a reason first', true);
    if (!$('#delPw', body).value) return $('#delPw', body).focus();
    guard(async () => {
      await api('/account/deletion-request', { method: 'POST', body: { reason, note: $('#delNote', body).value, password: $('#delPw', body).value } });
      closeModal();
      await loadMe();
      toast("Request sent. We'll be in touch.");
    }, e.target);
  };
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#acctDelCancel')) return;
  guard(async () => { await api('/account/deletion-request', { method: 'DELETE' }); await loadMe(); toast('Deletion request cancelled'); }, e.target);
});
// Change password: the same rules and the same "type it again" check as sign-up.
$('#pwChange').addEventListener('click', () => {
  const u = state.me.user;
  const body = openModal('Change password', `
    <label>Current password<input type="password" id="pwCur" autocomplete="current-password" /></label>
    <label>New password<input type="password" id="pwNew" autocomplete="new-password" maxlength="128" data-email="${esc(u.email)}" data-name="${esc(u.name || '')}" /></label>
    <label>Confirm new password<input type="password" id="pwAgain" autocomplete="new-password" maxlength="128" data-pw-match="#pwNew" /></label>
    <div class="modal-actions"><button class="btn quiet" id="pwCancel">Cancel</button><button class="btn primary" id="pwSave">Change password</button></div>`);
  const rules = passwordRules.mount($('#pwNew', body)), again = passwordRules.mountMatch($('#pwAgain', body));
  $('#pwCur', body).focus();
  $('#pwCancel', body).onclick = closeModal;
  $('#pwSave', body).onclick = (e) => {
    if (!$('#pwCur', body).value) return $('#pwCur', body).focus();
    if (!rules.showErrors() || !again.showErrors()) return;
    guard(async () => {
      await api('/account/password', { method: 'POST', body: { current: $('#pwCur', body).value, password: $('#pwNew', body).value } });
      closeModal();
      toast('Password changed');
    }, e.target);
  };
});
(async () => {
  try {
    await loadMe().catch(() => {});
    showWorkspaceNotice();
    loadTeam().catch(() => {});
    state.settings = await api('/settings');
    renderSettings();
    await Promise.all([loadSenders(), loadTemplates()]);
    await window.SendPage?.restoreDraft().catch(() => false); // the Send page's sheets and settings from last time
    showTab.replace = true; // the first page replaces the address (e.g. an old #send link becomes /send)
    showTab(tabFromUrl());
  } catch (e) {
    toast('Could not reach the server: ' + e.message, 'error');
  }
})();
