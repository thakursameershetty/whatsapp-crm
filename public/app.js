// SendON — dashboard (vanilla JS, no build step).

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

// This tab's id: sent with every change, so the live updates it causes don't echo back to it.
const TAB_ID = Math.random().toString(36).slice(2, 10);
async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Tab': TAB_ID },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) location.href = '/login';
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  // Something was saved (see "Unsaved changes"). Not the app's own background calls: marking things read, refreshing photos.
  if (options.method && options.method !== 'GET' && !/\/(read|photo\/refresh)$/.test(path)) markSaved();
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
  syncToastClear();
  let left = opts.duration || (type === 'error' ? 6000 : opts.onClick ? 6000 : 3500), started = Date.now(), timer;
  const dismiss = () => {
    if (el.classList.contains('out')) return;
    clearTimeout(timer);
    el.classList.add('out');
    syncToastClear();
    setTimeout(() => el.remove(), 280);
  };
  el.__dismiss = dismiss;
  timer = setTimeout(dismiss, left);
  el.addEventListener('mouseenter', () => { clearTimeout(timer); left -= Date.now() - started; });
  el.addEventListener('mouseleave', () => { started = Date.now(); timer = setTimeout(dismiss, Math.max(left, 1200)); });
  el.querySelector('.toast-x').addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
  if (opts.onClick) el.addEventListener('click', () => { opts.onClick(); dismiss(); });
  return { dismiss };
}

// With more than one toast showing, a "Clear all" button sits on top of the stack.
// "Sending to … · Undo" for a few seconds before a send goes out, so a slip can be taken back. Resolves true when the
// time is up (send it), false when Undo was clicked. It doesn't pause on hover, and closing the page counts as "time's
// up" (the caller sends with keepalive), so what you meant to send still goes.
function undoToast({ title, msg = '', seconds = 5, icon: ic = 'send' }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'toast undo-toast';
    el.setAttribute('role', 'status');
    el.innerHTML = `${icon(ic, 16)}<div class="toast-text"><b></b><span></span></div><button type="button" class="undo-btn">Undo</button><i class="undo-bar" aria-hidden="true"></i>`;
    el.querySelector('b').textContent = title;
    const line = el.querySelector('.toast-text span');
    let left = seconds;
    const tick = () => { line.textContent = `${msg ? msg + ' · ' : ''}sends in ${left}s`; };
    tick();
    el.querySelector('.undo-bar').style.animationDuration = seconds + 's';
    el.__dismiss = () => {}; // "Clear all" mustn't decide for you
    $('#toasts').append(el);
    syncToastClear();
    const iv = setInterval(() => { if (--left > 0) tick(); }, 1000);
    let settled = false;
    const finish = (send) => {
      if (settled) return;
      settled = true;
      clearInterval(iv);
      clearTimeout(t);
      removeEventListener('pagehide', onHide);
      el.classList.add('out');
      setTimeout(() => { el.remove(); syncToastClear(); }, 280);
      resolve(send);
    };
    const t = setTimeout(() => finish(true), seconds * 1000);
    const onHide = () => finish(true);
    addEventListener('pagehide', onHide);
    const btn = el.querySelector('.undo-btn');
    btn.onclick = () => finish(false);
    btn.focus({ preventScroll: true });
  });
}

function syncToastClear() {
  const box = $('#toasts');
  const live = [...box.querySelectorAll('.toast:not(.out)')];
  let btn = box.querySelector('.toast-clear');
  if (live.length > 1 && !btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-clear';
    btn.innerHTML = `${icon('x', 13)}Clear all`;
    btn.addEventListener('click', () => { [...box.querySelectorAll('.toast:not(.out)')].forEach((t) => t.__dismiss?.()); });
    box.prepend(btn);
  } else if (live.length <= 1 && btn) {
    btn.classList.add('out');
    setTimeout(() => btn.remove(), 200);
  }
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

// Narrow screens: the sidebar is a drawer opened from the top bar's menu button.
function setDrawer(open) {
  document.body.classList.toggle('drawer-open', open);
  $('#drawerOpen')?.setAttribute('aria-expanded', String(open));
  if (open) $('.side-nav button.active', $('#sidebar'))?.focus({ preventScroll: true });
}
$('#drawerOpen').addEventListener('click', () => setDrawer(!document.body.classList.contains('drawer-open')));
$('#drawerScrim').addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) { setDrawer(false); $('#drawerOpen').focus(); } });
$('[data-tab-go]').addEventListener('click', (e) => showTab(e.currentTarget.dataset.tabGo));
// The account menu and the other drawer buttons that leave the page close it too.
$('#sidebar').addEventListener('click', (e) => { if (e.target.closest('#acctBtn, [data-goto], a[href]') && matchMedia('(max-width: 900px)').matches) setTimeout(() => setDrawer(false), 0); });
function showTab(name) {
  if (name === 'assistant' && !state.me?.ai) name = 'overview'; // no AI assistant for this person
  // Leaving a campaign's Send page with unsaved work: ask to save it as a draft first (send.js askLeave).
  if (state.tab === 'send' && name !== 'send' && window.SendPage?.needsSave?.()) {
    const viaBack = showTab.replace; // Back / Forward already changed the address: put it back while asking
    showTab.replace = false;
    if (viaBack) history.pushState({ tab: 'send' }, '', '/send?c=' + encodeURIComponent(window.SendPage.campaignId()));
    window.SendPage.askLeave().then((go) => {
      if (!go) return;
      if (viaBack) history.back(); // (popstate then shows the page they were going back to)
      else showTab(name);
    });
    return;
  }
  // The Send page always sends one campaign (New campaign makes it first); without one, Campaigns.
  if (name === 'send' && !window.SendPage?.campaignId()) name = 'campaigns';
  const navFor = { reports: 'report', send: 'campaigns' }[name] || name; // pages under another one keep its sidebar item lit
  $$('.side-nav button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === navFor));
  const wasHidden = $('#tab-' + name)?.classList.contains('hidden');
  $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + name));
  if (wasHidden) { Motion.enter($('#tab-' + name)); scrollTo(0, 0); } // a new page starts at the top
  state.tab = name;
  // Narrow screens: the top bar names the page, and choosing a page closes the menu.
  $('#mbarTitle').textContent = $(`.side-nav button[data-tab="${navFor}"] .nav-label`)?.textContent || 'SendON';
  setDrawer(false);
  // The inbox fills the window and starts with the sidebar shrunk to icons.
  document.body.classList.toggle('inbox-open', name === 'inbox');
  document.body.classList.toggle('assistant-open', name === 'assistant');
  syncNav();
  if (name === 'assistant') window.Assistant?.show();
  if (name === 'inbox') window.Inbox?.show();
  Motion.segs();
  requestAnimationFrame(setupSticky);
  document.body.classList.toggle('send-open', name === 'send');
  if (name === 'send') window.SendPage?.show();
  if (name === 'settings' || name === 'send') window.Credits?.load(); // the balance may have changed
  if (name === 'contacts') window.Contacts?.show();
  if (name === 'notifications') window.Notifications?.show();
  if (name === 'campaigns') loadCampaigns();
  if (name !== 'campaigns') stopPolling();
  if (name === 'overview') loadOverview().catch((e) => toast(e.message, 'error'));
  else stopOverviewPolling();
  if (name === 'numbers') { refreshStats().then(renderSenders).catch(() => {}); if (!state.team) loadTeam().catch(() => {}); }
  if (name === 'report') window.MetaErrors?.render();
  if (name === 'reports') window.MetaErrors?.showReports();
  hideTip();
  // The address follows the page (/send, /inbox; the overview is just /), so Back and Forward move
  // between pages and a reload stays where you are.
  const path = name === 'overview' ? '/' : '/' + name + (name === 'send' ? '?c=' + encodeURIComponent(window.SendPage.campaignId()) : '');
  const here = name === 'send' ? location.pathname + location.search : location.pathname;
  if (here !== path || location.hash) history[showTab.replace ? 'replaceState' : 'pushState']({ tab: name }, '', path);
  showTab.replace = false;
}
// Which page an address means: /send → send; old #send links still work.
const tabFromUrl = () => {
  const OLD = { 'error-codes': 'report' }; // pages that were renamed
  const h0 = location.hash.slice(1), p0 = location.pathname.replace(/^\/+|\/+$/g, '');
  const h = OLD[h0] || h0, p = OLD[p0] || p0;
  const t = (h && $('#tab-' + h) && h) || (p && $('#tab-' + p) && p) || 'overview';
  return t;
};
// The sidebar opens a page at its start: Campaigns always lands on the list, even from inside a campaign or a day.
$$('.side-nav button[data-tab]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.tab === 'campaigns') {
    window.campaignsHome?.();
    // already on Campaigns (in a campaign or a day): the address drops ?c= / ?day= so a reload stays on the list
    if (state.tab === 'campaigns' && location.search) history.replaceState({ tab: 'campaigns' }, '', '/campaigns');
  }
  showTab(b.dataset.tab);
}));
window.addEventListener('popstate', () => {
  const tab = tabFromUrl();
  if ($('#tab-' + tab)?.classList.contains('hidden')) { showTab.replace = true; showTab(tab); }
});
window.addEventListener('hashchange', () => { const tab = tabFromUrl(); showTab.replace = true; showTab(tab); });

// Sidebar: collapses to icons. Remembered per browser; on the Inbox, and on Send's Personalise step (which needs the
// width for the preview and the fields), it starts collapsed and the toggle only opens it for that visit.
state.navCollapsed = (() => { try { return localStorage.getItem('navCollapsed') === '1'; } catch { return false; } })();
state.inboxNavOpen = false;
state.sendWide = false; // Send is on its Personalise step (set by send.js)
state.sendNavOpen = false;
function syncNav() {
  const mini = state.tab === 'inbox' ? !state.inboxNavOpen : state.tab === 'send' && state.sendWide ? !state.sendNavOpen : state.navCollapsed;
  const was = document.body.classList.contains('nav-mini');
  document.body.classList.toggle('nav-mini', mini);
  const btn = $('#navToggle');
  const label = mini ? 'Expand sidebar' : 'Collapse sidebar';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-expanded', String(!mini));
  // Thumbs, the Send split and the inbox measure their space: let them re-fit once the sidebar has moved.
  if (was !== mini) setTimeout(() => dispatchEvent(new Event('resize')), Motion.reduce() ? 0 : 300);
  // (the first time: the sidebar was already set before the first paint, without sliding; from now on it slides)
  if (document.body.classList.contains('nav-instant')) requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('nav-instant')));
}
$('#navToggle').addEventListener('click', () => {
  if (state.tab === 'inbox') state.inboxNavOpen = !state.inboxNavOpen;
  else if (state.tab === 'send' && state.sendWide) state.sendNavOpen = !state.sendNavOpen;
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
  if (go) { e.preventDefault(); if (go.dataset.goto === 'send') window.CampaignSetup.create(); else showTab(go.dataset.goto); }
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
  modalBack = modalGuard = null;
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
// A page with nothing on it yet (no templates, numbers, campaigns, contacts…): its "nothing here" card fills the
// rest of the screen instead of sitting in the top half.
const FILL_EMPTY = '#senderList > .empty, #templateList > .empty, #campaignList > .empty, #ntList > .empty, #rsList > .empty, #ctLayout .ct-card';
let fillT = 0;
function fillEmpties() {
  cancelAnimationFrame(fillT);
  fillT = requestAnimationFrame(() => {
    for (const el of document.querySelectorAll(FILL_EMPTY)) {
      const isCard = el.classList.contains('ct-card');
      if (!el.offsetParent || (isCard && !el.querySelector('.empty'))) { el.style.minHeight = ''; el.classList.remove('fill-empty'); continue; }
      const top = el.getBoundingClientRect().top + scrollY;
      el.style.minHeight = Math.max(280, innerHeight - top - 24) + 'px';
      el.classList.add('fill-empty');
    }
  });
}
addEventListener('resize', fillEmpties);
new MutationObserver(fillEmpties).observe(document.querySelector('main') || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

// Scrollbars stay hidden until used (style.css): whatever is scrolling shows its bar, which fades a moment after it stops.
document.addEventListener('scroll', (e) => {
  const el = e.target === document ? document.documentElement : e.target;
  if (!el?.classList) return;
  el.classList.add('is-scrolling');
  clearTimeout(el.__scrollT);
  el.__scrollT = setTimeout(() => el.classList.remove('is-scrolling'), 900);
}, { capture: true, passive: true });

// A popup opened from another (a number's playbooks, from its settings) can go back to it when closed, and can ask
// first (unsaved changes). Both are set right after openModal, and cleared by the next one.
let modalBack = null, modalGuard = null;
const setModalBack = (fn) => { modalBack = fn; };
const setModalGuard = (fn) => { modalGuard = fn; };
const closeModal = async () => {
  if (modalGuard && !(await modalGuard())) return;
  modalGuard = null;
  const back = modalBack;
  modalBack = null;
  if (back) return back();
  hideOverlay($('#modal'));
};
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
// safe: focus starts on Cancel, so an Enter meant for something else doesn't confirm (sending, deleting)
function confirmDialog({ title, message = '', confirmText = 'OK', danger = false, check = '', safe = false }) {
  return new Promise((resolve) => {
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').innerHTML = message + (check ? `<label class="confirm-check"><input type="checkbox" class="cb" id="confirmCheck" /> <span>${check}</span></label>` : '');
    const yes = $('#confirmYes');
    yes.textContent = confirmText;
    yes.className = 'btn ' + (danger ? 'danger-solid' : 'primary');
    yes.disabled = Boolean(check);
    if (check) $('#confirmCheck').onchange = (e) => { yes.disabled = !e.target.checked; };
    $('#confirm').classList.remove('hidden');
    (safe ? $('#confirmNo') : yes).focus();
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

// Ceramic ON/OFF switch markup. `knob` is optional markup inside the moving knob (e.g. the AI orb).
const toggleHtml = ({ checked, attrs = '', size = '', knob = '' }) =>
  `<span class="toggle ${size}"><input type="checkbox" ${checked ? 'checked' : ''} ${attrs} /><span class="track"><span class="lbl on">ON</span><span class="lbl off">OFF</span><span class="knob">${knob}</span></span></span>`;

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
  const el = Sheet.Menu.panel(r.left, r.bottom + 6, `<div class="search-wrap cc-search">${icon('search', 15)}<input data-1p-ignore data-lpignore="true" data-form-type="other" class="search" id="ccQ" placeholder="Search country or code" autocomplete="off" /></div><div class="cc-list" id="ccList" role="listbox"></div>`);
  el.classList.add('cc-pop');
  el.style.width = r.width + 'px';
  const current = $('#setCountry').value;
  const draw = () => {
    const q = $('#ccQ', el).value.trim().toLowerCase().replace(/^\+/, '');
    const list = COUNTRIES.filter((c) => !q || c[1].toLowerCase().includes(q) || c[0].toLowerCase() === q || c[2].startsWith(q));
    $('#ccList', el).innerHTML = list.map((c) => `<button type="button" role="option" class="cc-opt ${c[0] === current ? 'on' : ''}" data-cc="${c[0]}" aria-selected="${c[0] === current}"><i class="ss-check">${c[0] === current ? TICK_SVG : ''}</i>${flagImg(c[0], 18)}<b class="cc-iso">${c[0]}</b><span class="cc-name">${esc(c[1])}</span><span class="cc-code">+${c[2]}</span></button>`).join('') || '<p class="tm-note" style="text-align:center;padding:12px 0">No country matches.</p>';
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
  renderReadReceipts();
  $('#setGraph').value = s.graphVersion || '';
  renderGraphWarn();
  $('#setConc').value = s.concurrencyPerNumber;
  $('#setDelay').value = s.delayMsPerNumber;
  $('#setVerify').value = s.webhookVerifyToken || '';
  $('#webhookUrl').value = location.origin + '/webhook';
  renderWebhookStatus();
  renderAiSettings();
  renderPlaybooks();
  renderMode();
}

// Settings → Webhook: is Meta actually reaching the app? When it last sent each kind of event.
function renderWebhookStatus() {
  const w = state.settings.webhookSeen || {};
  const live = !state.settings.demoMode;
  const recent = w.lastAt && Date.now() - Date.parse(w.lastAt) < 7 * 86400000;
  const state_ = !live ? ['muted', 'Demo mode', 'Nothing real comes in while Demo mode is on.']
    : recent ? ['good', 'Receiving events', `Meta last reached the app ${relTime(w.lastAt)}.`]
    : w.lastAt ? ['warn', 'Quiet lately', `Nothing from Meta since ${relTime(w.lastAt)}. Check the webhook is still subscribed.`]
    : ['bad', 'Nothing received yet', 'Meta hasn’t sent anything here yet. Add the URL and token above in Meta, subscribe to messages, then message your number.'];
  const row = (label, at, hint) => `<div class="wh-ev"><span class="wh-dot ${at ? 'on' : ''}"></span><b>${label}</b><span>${at ? relTime(at) : hint}</span></div>`;
  $('#whStatus').innerHTML = `
    <div class="wh-head"><span class="tag ${state_[0]}">${state_[1]}</span><span class="wh-sub">${esc(state_[2])}</span></div>
    <div class="wh-evs">
      ${row('Incoming messages', w.messageAt, 'none yet')}
      ${row('Delivery updates', w.statusAt, 'none yet')}
    </div>`;
}

// Meta's Graph API versions stop working on these dates (Meta for Developers changelog, as of Nov 2026).
// Settings warns 6 months ahead and offers a one-click move to the recommended version.
const GRAPH_RETIRES = { 'v21.0': '2027-01-21', 'v22.0': '2027-05-20', 'v23.0': '2027-10-08', 'v24.0': '2028-02-18', 'v25.0': '2028-07-29' };
const GRAPH_RECOMMENDED = 'v25.0';
function renderGraphWarn() {
  const v = ($('#setGraph').value || state.settings.graphVersion || '').trim();
  const until = GRAPH_RETIRES[v];
  const days = until ? Math.ceil((Date.parse(until + 'T00:00:00') - Date.now()) / 86400000) : null;
  const el = $('#gvWarn');
  const show = days != null && days < 183 && v !== GRAPH_RECOMMENDED;
  el.classList.toggle('hidden', !show);
  if (!show) return;
  const when = new Date(until + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  el.className = 'gv-warn ' + (days <= 0 ? 'bad' : 'warn');
  el.innerHTML = `${icon('badge-alert', 14)}<span>${days <= 0 ? `Meta retired ${esc(v)} on ${when}, so requests fail.` : `Meta retires ${esc(v)} on ${when} (${days} days).`}</span><button type="button" class="gv-fix" id="gvFix">Switch to ${GRAPH_RECOMMENDED}</button>`;
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#gvFix')) return;
  e.preventDefault();
  guard(async () => {
    const was = state.settings.graphVersion;
    $('#setGraph').value = GRAPH_RECOMMENDED;
    state.settings = await api('/settings', { method: 'PUT', body: { graphVersion: GRAPH_RECOMMENDED } });
    renderGraphWarn();
    toast(`Now using ${GRAPH_RECOMMENDED} (was ${was}). Check it: Numbers → Test connection, and send yourself a test message.`, '', { duration: 9000 });
  });
});
$('#setGraph').addEventListener('input', renderGraphWarn);

// Read receipts: saved as soon as you pick one (like a switch), not with the Save button.
const RR_HELP = {
  open: 'Their messages turn blue as soon as you open the chat (and when you or the AI reply).',
  reply: 'Read freely: their messages turn blue only once you or the AI send a reply or a reaction.',
  off: "They never see blue ticks from you. Note: WhatsApp may hide your read status from them anyway if they've turned theirs off.",
};
function renderReadReceipts() {
  const v = state.settings.readReceipts || 'open';
  Motion.patch($('#setRR'), [['open', 'When I open'], ['reply', 'Only when I reply'], ['off', 'Off']].map(([k, l]) => `<button type="button" data-rr="${k}" role="radio" aria-checked="${v === k}" class="${v === k ? 'active' : ''}">${l}</button>`).join(''));
  Motion.segs($('#setRR').parentElement);
  $('#rrHelp').textContent = RR_HELP[v];
  // Replay the ticks' animation for the chosen mode.
  const t = $('#rrTicks');
  t.className = 'rr-ticks';
  void t.offsetWidth;
  t.classList.add('play', 'mode-' + v);
}
$('#setRR').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rr]');
  if (!b || b.classList.contains('active')) return;
  const prev = state.settings.readReceipts;
  state.settings.readReceipts = b.dataset.rr;
  renderReadReceipts();
  guard(async () => {
    try { state.settings = await api('/settings', { method: 'PUT', body: { readReceipts: b.dataset.rr } }); toast('Read receipts: ' + b.textContent); }
    catch (err) { state.settings.readReceipts = prev; renderReadReceipts(); throw err; }
  });
});

async function saveSettings(extra = {}) {
  state.settings = await api('/settings', {
    method: 'PUT',
    body: {
      demoMode: $('#setDemo').checked,
      defaultCountryCode: $('#setCC').value.replace(/\D/g, ''),
      defaultCountry: $('#setCountry').value,
      graphVersion: $('#setGraph').value.trim() || GRAPH_RECOMMENDED,
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

// --- Lead assistant playbooks ------------------------------------------------------------------------------------
// Each playbook is one setup for the Inbox lead assistant (lead.js): what it may say, what makes a qualified lead, the
// next step, the tone, whether it drafts and/or sends on its own, which numbers use it and which campaign templates it
// answers. Edited in Settings; each number's list and default are also set from its card on the Numbers page.
const leadCfg = () => ({ playbooks: [], defaults: {}, ...(state.settings.leadAgent || {}) });
const pbUses = (p, sid) => p.allNumbers || (p.numbers || []).includes(sid);
// The playbook a number falls back to: its chosen default, else the first one it uses.
const pbDefault = (sid, cfg = leadCfg()) => { const list = cfg.playbooks.filter((p) => pbUses(p, sid)); return list.find((p) => p.id === cfg.defaults[sid]) || list[0] || null; };
async function savePlaybooks(next, note) {
  const cur = leadCfg();
  state.settings = await api('/settings', { method: 'PUT', body: { leadAgent: { on: next.on ?? cur.on !== false, autoOn: next.autoOn ?? cur.autoOn !== false, playbooks: next.playbooks, defaults: next.defaults } } });
  renderSettings();
  if (!$('#tab-numbers').classList.contains('hidden')) renderSenders();
  if (note) toast(note);
}
// A playbook's book icon, drawn like the campaigns' folders: each one its own pastel, stepping round the colour wheel in
// list order (as the folders do), so neighbours never look alike.
const pbColor = (p) => { const list = leadCfg().playbooks, i = list.findIndex((x) => x.id === p.id); return window.folderColorAt?.((i < 0 ? list.length : i) + 3) || 'var(--muted)'; }; // a new one gets the next colour
const pbBook = window.pbBook = (p, cls = '') => `<span class="pb-book ${cls}" style="--c:${pbColor(p)}" aria-hidden="true"><svg viewBox="0 0 36 40"><rect class="b-pages" x="8" y="4" width="25" height="33" rx="3"/><rect class="b-cover" x="4" y="3" width="25" height="33" rx="3"/><rect class="b-spine" x="4" y="3" width="6" height="33" rx="2.5"/><rect class="b-label" x="14" y="10" width="11" height="4" rx="2"/><rect class="b-label" x="14" y="17" width="7" height="2.5" rx="1.25"/></svg></span>`;
function renderPlaybooks() {
  const el = $('#pbList');
  if (!el) return;
  const cfg = leadCfg();
  const on = cfg.on !== false, autoAll = on && cfg.autoOn !== false;
  $('#laMaster').checked = on;
  $('#laAutoAll').checked = autoAll;
  $('#laAutoAll').disabled = !on;
  $('#laAutoRow').classList.toggle('dim', !on);
  el.classList.toggle('off', !on);
  const label = (id) => state.senders.find((x) => x.id === id)?.label;
  el.innerHTML = (on ? '' : `<p class="pb-offnote">${icon('bell-off', 15)}<span><b>Automatic drafts are off.</b> Nothing drafts or replies on its own for any number. You can still ask for a draft in any chat.</span></p>`)
    + `<div class="pb-grid">${cfg.playbooks.map((p) => {
      const nums = p.allNumbers ? 'All numbers' : (p.numbers || []).map(label).filter(Boolean).join(', ') || 'No numbers yet';
      const tpls = (p.templates || []).length;
      const [mode, cls] = pbMode(p, cfg);
      return `<button type="button" class="pb-tile" data-pb-edit="${esc(p.id)}">
        <span class="pb-tile-top">${pbBook(p)}<span class="pb-mode ${cls}">${mode}</span></span>
        <b>${esc(p.name)}</b>
        <span class="pb-when">${esc(p.when || (p.business ? p.business.slice(0, 160) : 'No description yet'))}</span>
        <span class="pb-tile-meta"><span title="${esc(nums)}">${icon('phone', 13)}<i>${esc(nums)}</i></span>${tpls ? `<span title="Answers replies to ${tpls} campaign template${tpls === 1 ? '' : 's'}">${icon('file-text', 13)}<i>${tpls}</i></span>` : ''}</span>
      </button>`;
    }).join('')}<button type="button" class="pb-tile pb-tile-new" data-pb-new><span class="pb-new-ic">${icon('plus', 20)}</span><b>New playbook</b><span class="pb-when">For another number, offer or kind of question</span></button></div>`;
}
// What a playbook does now, given the workspace's two switches.
function pbMode(p, cfg = leadCfg()) {
  if (cfg.on === false || !p.draft) return ['Drafts when asked', 'muted'];
  if (p.auto && cfg.autoOn === false) return ['Drafts replies · auto-send off', 'info'];
  return p.auto ? ['Replies on its own', 'good'] : ['Drafts replies', 'info'];
}
$('#laAutoAll').addEventListener('change', async (e) => {
  const on = e.target.checked;
  if (on && !state.settings.demoMode && !(await confirmDialog({ title: 'Let the AI reply on its own?', message: AUTO_WARN, confirmText: 'Turn on auto-reply' }))) { e.target.checked = false; return; }
  await guard(() => savePlaybooks({ ...leadCfg(), autoOn: on }, on ? 'Playbooks set to reply on their own will send' : 'Auto-send off: every playbook only drafts')).catch(() => { e.target.checked = !on; });
});
// The switch for the whole workspace.
$('#laMaster').addEventListener('change', async (e) => {
  const on = e.target.checked;
  await guard(() => savePlaybooks({ ...leadCfg(), on }, on ? 'Drafts on: replies are drafted as people write' : 'Automatic drafts off: nothing drafts or replies on its own')).catch(() => { e.target.checked = !on; });
});
$('#pbList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pb-edit], [data-pb-new]');
  if (b) playbookManager(b.dataset.pbEdit || 'new');
});

const AUTO_WARN = 'Live mode: the AI will send real WhatsApp messages to your customers without anyone approving them. It holds back when a person is needed, after an opt-out, when your team is active in the chat, and after 5 auto-replies in an hour. Make sure “About the business” is filled in.';
// The editing form for one playbook (used inside the All playbooks window).
function pbFormHtml(p, isNew) {
  return `<div class="pbm-form-head">${pbBook(p)}<div><h3>${isNew ? 'New playbook' : esc(p.name)}</h3><p class="sub">${isNew ? 'A setup for another number, offer or kind of question.' : 'Changes apply to the next reply in every chat using it.'}</p></div></div>
    <div class="pb-ed">
      <div class="pb-ed-main">
        <label>Name<input id="pbName" maxlength="60" placeholder="e.g. Website & app sales" /></label>
        <label>When to use it <span class="opt">helps the AI pick it when a number has several</span><input id="pbWhen" maxlength="300" placeholder="e.g. People asking about building a website or an app" /></label>
        <label>About the business or this offer <span class="opt">the only facts it will use</span><textarea id="pbBusiness" rows="9" placeholder="What you offer, prices, timings, FAQs, links.&#10;&#10;Example:&#10;Spotmies builds websites and apps for small businesses.&#10;Websites from ₹25,000 (2–3 weeks). Apps from ₹1.5 lakh.&#10;Mon–Sat, 10am–7pm IST."></textarea></label>
        <label>What makes a qualified lead<textarea id="pbQualified" rows="3" placeholder="e.g. Needs a website or app, and has a budget over ₹20,000 or wants it within 2 months."></textarea></label>
        <label>Next step to offer <span class="opt">when they qualify</span><input id="pbNext" maxlength="1000" placeholder="e.g. A free 20-minute call: https://cal.com/your-link" /></label>
        <label>Tone <span class="opt">optional</span><input id="pbTone" maxlength="300" placeholder="e.g. Friendly and short. Hinglish is fine." /></label>
      </div>
      <div class="pb-ed-side">
        <div class="pb-sec">
          <label class="pb-row"><span><b>Draft automatically</b><small>A draft is ready when they write. Off: only when you ask.</small></span>${toggleHtml({ checked: p.draft, attrs: 'id="pbDraft"', size: 'sm' })}</label>
          <label class="pb-row"><span><b>Send automatically <span class="pill scheduled">Beta</span></b><small>Replies on its own, within the guardrails (waits when a person is needed, after an opt-out, when your team is active, after 5 an hour).</small></span>${toggleHtml({ checked: p.auto, attrs: 'id="pbAuto"', size: 'sm' })}</label>
        </div>
        <div class="pb-sec">
          <div class="pb-sec-h"><div class="field-label">Numbers</div><button type="button" class="btn sm" id="pbNumPick">${icon('phone', 14)}Choose numbers</button></div>
          <div id="pbNumSum"></div>
        </div>
        <div class="pb-sec">
          <div class="pb-sec-h"><div class="field-label">Campaign templates <span class="opt">replies to these use it</span></div><button type="button" class="btn sm" id="pbTplPick">${icon('file-text', 14)}Choose templates</button></div>
          <div id="pbTplSum"></div>
        </div>
      </div>
    </div>
    <div class="pbm-actions">${isNew ? '' : `<button class="btn quiet danger" id="pbDel">${icon('delete', 15)}Delete</button>`}<span class="pbm-dirty" id="pbDirty"></span>${isNew ? '' : '<button class="btn quiet" id="pbReset">Undo changes</button>'}<button class="btn primary" id="pbSave">${isNew ? 'Create playbook' : 'Save'}</button></div>`;
}
const pbBlank = (first) => ({ id: '', name: '', when: '', business: '', qualified: '', nextStep: '', tone: '', draft: true, auto: false, allNumbers: first, numbers: [], templates: [] });

// All playbooks: every one listed on the left (search, book icons, what each does), the selected one's full editor on
// the right. Opens on a playbook (or 'new'). Moving away from unsaved changes asks first.
function playbookManager(selectId, { numberId = null, back = null } = {}) {
  let sel = selectId;
  let dirty = false;
  const num = numberId && state.senders.find((x) => x.id === numberId);
  // which number's playbooks the list shows ('' = all); opened from a number, that number
  let numF = num ? num.id : '';
  const body = openModal('Playbooks', `<div class="pbm">
    <aside class="pbm-side">
      <div class="search-wrap has-filter pbm-search" data-icon="search" data-icon-size="14"><input data-1p-ignore data-lpignore="true" data-form-type="other" autocomplete="off" class="search" id="pbmQ" placeholder="Search playbooks" />${state.senders.length > 1 ? '<button type="button" class="num-filter" id="pbmNum" aria-haspopup="menu"></button>' : ''}</div>
      <div class="pbm-list" id="pbmList"></div>
      <button type="button" class="btn pbm-new" id="pbmNew">${icon('plus', 15)}New playbook</button>
    </aside>
    <section class="pbm-main" id="pbmMain"></section>
  </div>`);
  $('#modal .modal-box').classList.add('wide', 'pbm-box');
  LA.hydrate(body);
  Motion.segs?.(body);
  const cfgNow = () => leadCfg();
  if (sel !== 'new' && !cfgNow().playbooks.some((p) => p.id === sel)) sel = (num ? cfgNow().playbooks.find((p) => pbUses(p, num.id)) : cfgNow().playbooks[0])?.id || 'new';
  const leave = async () => !dirty || confirmDialog({ title: 'Discard your changes?', message: 'This playbook has changes you haven’t saved.', confirmText: 'Discard', danger: true, safe: true });
  setModalGuard(leave);   // closing with unsaved changes asks first
  if (back) setModalBack(back); // and goes back to where it was opened from (a number's settings)

  function drawList() {
    const q = ($('#pbmQ', body).value || '').trim().toLowerCase();
    const list = cfgNow().playbooks.filter((p) => (!q || `${p.name} ${p.when}`.toLowerCase().includes(q)) && (!numF || pbUses(p, numF)));
    const fb = $('#pbmNum', body);
    if (fb) {
      const n = state.senders.find((x) => x.id === numF);
      fb.classList.toggle('on', Boolean(n));
      fb.innerHTML = `${icon('phone', 14)}${n ? `<span class="num-filter-lbl">${esc(n.label)}</span>` : ''}`;
      fb.title = n ? `Showing the playbooks ${n.label} uses. Click to change.` : 'Show one number’s playbooks';
    }
    $('#pbmList', body).innerHTML = (list.map((p) => {
      const [mode] = pbMode(p);
      return `<button type="button" class="pbm-item ${p.id === sel ? 'on' : ''}" data-id="${esc(p.id)}">${pbBook(p, 'md')}<span><b>${esc(p.name)}</b><small>${esc(mode)} · ${esc(p.allNumbers ? 'all numbers' : `${(p.numbers || []).length} number${(p.numbers || []).length === 1 ? '' : 's'}`)}</small></span></button>`;
    }).join('') || `<p class="sub pbm-none">${q ? 'No playbook matches.' : 'No playbooks yet.'}</p>`)
      + (sel === 'new' ? `<button type="button" class="pbm-item on pbm-item-new">${pbBook({ id: '__new' }, 'md')}<span><b>New playbook</b><small>Not saved yet</small></span></button>` : '');
  }
  function drawForm() {
    const cfg = cfgNow();
    const cur = cfg.playbooks.find((p) => p.id === sel);
    const p = cur ? { ...cur } : num ? { ...pbBlank(false), numbers: [num.id] } : pbBlank(!cfg.playbooks.length);
    const main = $('#pbmMain', body);
    main.innerHTML = pbFormHtml(p, !cur);
    LA.hydrate(main);
    main.scrollTop = 0;
    dirty = false;
    const markDirty = () => { dirty = true; $('#pbDirty', main).textContent = 'Unsaved changes'; };
    main.addEventListener('input', markDirty);
    main.addEventListener('change', markDirty);
    $('#pbName', main).value = p.name; $('#pbWhen', main).value = p.when; $('#pbBusiness', main).value = p.business;
    $('#pbQualified', main).value = p.qualified; $('#pbNext', main).value = p.nextStep; $('#pbTone', main).value = p.tone;
    // Numbers and templates are chosen in their own windows (the template window is the Send page's and Inbox's),
    // opened over this one; here, a summary of what's chosen. Templates follow the numbers: only templates the chosen
    // numbers can send are offered, and saving drops any that no chosen number can send.
    let allNums = Boolean(p.allNumbers);
    const numSel = new Set(p.numbers), tplSel = new Set(p.templates);
    const chosenNums = () => (allNums ? state.senders : state.senders.filter((x) => numSel.has(x.id)));
    const inScope = (t) => chosenNums().some((x) => canSend(t, x));
    const drawSummary = () => {
      const ns = chosenNums();
      $('#pbNumSum', main).innerHTML = allNums
        ? `<div class="pb-sum-all">${icon('phone', 15)}<span><b>All numbers</b><small>Every number uses it, including ones you add later.</small></span></div>`
        : ns.length ? `<div class="pb-chips">${ns.map((x) => `<span class="pb-chip">${senderPhotoHtml(x)}<span><b>${esc(x.label)}</b><small>${esc(x.displayPhone || '')}</small></span><button type="button" class="pb-x" data-unnum="${esc(x.id)}" aria-label="Remove ${esc(x.label)}">${icon('x', 13)}</button></span>`).join('')}</div>`
        : '<p class="pb-hint">No number uses this playbook yet.</p>';
      const ts = state.templates.filter((t) => tplSel.has(t.id) && inScope(t)).sort((a, b) => a.name.localeCompare(b.name));
      $('#pbTplPick', main).disabled = !ns.length;
      $('#pbTplSum', main).innerHTML = !ns.length ? `<p class="pb-hint">${icon('phone', 15)}Choose numbers first: you pick from their templates.</p>`
        : ts.length ? `<div class="pb-tpl-list">${ts.map((t) => `<div class="pb-tpl-row"><span class="pb-tpl-t"><b title="${esc(t.name)}">${esc(t.name)}</b><small>${esc(t.language)} · ${esc(catLabel(t.category).toLowerCase())}</small></span><button type="button" class="pb-x" data-untpl="${esc(t.id)}" aria-label="Remove ${esc(t.name)}">${icon('x', 13)}</button></div>`).join('')}</div>`
        : '<p class="pb-hint">None yet: replies to any campaign use it.</p>';
    };
    drawSummary();
    main.addEventListener('click', (e) => {
      const un = e.target.closest('[data-unnum]'), ut = e.target.closest('[data-untpl]');
      if (un) { numSel.delete(un.dataset.unnum); markDirty(); drawSummary(); }
      if (ut) { tplSel.delete(ut.dataset.untpl); markDirty(); drawSummary(); }
    });
    $('#pbNumPick', main).onclick = () => numberPicker({ all: allNums, ids: [...numSel], onUse: ({ all, ids }) => {
      allNums = all; numSel.clear(); ids.forEach((x) => numSel.add(x)); markDirty(); drawSummary();
    } });
    $('#pbTplPick', main).onclick = () => window.TemplatePicker?.({
      title: 'Templates for this playbook', multi: true, stacked: true, nums: chosenNums(), selectedIds: [...tplSel].filter((id) => inScope(state.templates.find((t) => t.id === id) || {})),
      only: inScope, block: () => null, useText: 'Use selected',
      onUse: (ids) => { tplSel.clear(); ids.forEach((x) => tplSel.add(x)); markDirty(); drawSummary(); },
    });
    const syncAuto = () => { const on = $('#pbDraft', main).checked; $('#pbAuto', main).disabled = !on; if (!on) $('#pbAuto', main).checked = false; $('#pbAuto', main).closest('.pb-row').classList.toggle('dim', !on); };
    syncAuto();
    $('#pbDraft', main).onchange = syncAuto;
    $('#pbAuto', main).onchange = async (e) => {
      if (!e.target.checked || state.settings.demoMode) return;
      if (!(await confirmDialog({ title: 'Let the AI reply on its own?', message: AUTO_WARN, confirmText: 'Turn on auto-reply' }))) e.target.checked = false;
    };
    if ($('#pbReset', main)) $('#pbReset', main).onclick = () => drawForm();
    if (cur) $('#pbDel', main).onclick = (e) => guard(async () => {
      if (!(await confirmDialog({ title: `Delete “${esc(cur.name)}”?`, message: 'Chats using it switch to their number’s default playbook. Numbers with no playbook left only draft when you ask.', confirmText: 'Delete', danger: true }))) return;
      const defaults = Object.fromEntries(Object.entries(cfg.defaults).filter(([, v]) => v !== cur.id));
      await savePlaybooks({ playbooks: cfg.playbooks.filter((x) => x.id !== cur.id), defaults }, 'Playbook deleted');
      sel = cfgNow().playbooks[0]?.id || 'new';
      drawList(); drawForm();
    }, e.currentTarget);
    $('#pbSave', main).onclick = (e) => guard(async () => {
      const name = $('#pbName', main).value.trim();
      if (!name) { $('#pbName', main).focus(); throw new Error('Give the playbook a name'); }
      const all = allNums;
      const numbers = [...numSel].filter((x) => state.senders.some((s) => s.id === x));
      if (!all && !numbers.length && !(await confirmDialog({ title: 'No numbers use it yet', message: 'It won’t answer any chat until a number uses it. Save anyway?', confirmText: 'Save' }))) return;
      if ($('#pbDraft', main).checked && !$('#pbBusiness', main).value.trim()) toast('Tip: write about the business, so its drafts can answer questions', 'error');
      const next = { ...p, name, when: $('#pbWhen', main).value.trim(), business: $('#pbBusiness', main).value, qualified: $('#pbQualified', main).value, nextStep: $('#pbNext', main).value.trim(), tone: $('#pbTone', main).value.trim(),
        draft: $('#pbDraft', main).checked, auto: $('#pbDraft', main).checked && $('#pbAuto', main).checked, allNumbers: all, numbers: all ? [] : numbers, templates: state.templates.filter((t) => tplSel.has(t.id) && inScope(t)).map((t) => t.id) };
      const before = new Set(cfg.playbooks.map((x) => x.id));
      const playbooks = cur ? cfg.playbooks.map((x) => (x.id === cur.id ? next : x)) : [...cfg.playbooks, next];
      await savePlaybooks({ playbooks, defaults: cfg.defaults }, cur ? 'Playbook saved' : `“${name}” created`);
      // a new one gets its id from the server: select it
      sel = cur ? cur.id : cfgNow().playbooks.find((x) => !before.has(x.id))?.id || cfgNow().playbooks.at(-1)?.id;
      drawList(); drawForm();
    }, e.currentTarget);
    if (!cur) $('#pbName', main).focus();
  }
  drawList();
  drawForm();
  $('#pbmQ', body).oninput = drawList;
  if ($('#pbmNum', body)) $('#pbmNum', body).onclick = (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const count = (sid) => cfgNow().playbooks.filter((p) => pbUses(p, sid)).length;
    Sheet.Menu.open(r.left, r.bottom + 6, [
      { label: 'All numbers', checked: !numF, kbd: String(cfgNow().playbooks.length), action: () => { numF = ''; drawList(); } },
      '-',
      ...state.senders.map((x) => ({ label: x.label, checked: numF === x.id, kbd: String(count(x.id)), action: () => { numF = x.id; drawList(); } })),
    ]);
  };
  $('#pbmList', body).onclick = async (e) => {
    const b = e.target.closest('.pbm-item[data-id]');
    if (!b || b.dataset.id === sel || !(await leave())) return;
    sel = b.dataset.id;
    drawList(); drawForm();
  };
  $('#pbmNew', body).onclick = async () => { if (sel === 'new' || !(await leave())) return; sel = 'new'; drawList(); drawForm(); };
}
window.playbookManager = playbookManager;

// What a number's card says about its playbooks.
function numberPlaybooksHtml(sid) {
  if (!state.settings.leadAgent) return '';
  const cfg = leadCfg();
  const list = cfg.playbooks.filter((p) => pbUses(p, sid));
  const def = pbDefault(sid, cfg);
  return `<dt>Lead assistant</dt><dd class="dd-pb">${cfg.on === false ? '<span class="muted">Off for the workspace</span>' : ''}${list.length ? list.map((p) => `<span class="pb-chip${list.length > 1 && p === def ? ' def' : ''}" title="${esc(p.when || p.name)}${list.length > 1 && p === def ? ' (default)' : ''}">${esc(p.name)}</span>`).join('') : '<span class="muted">No playbook: drafts only when asked</span>'}</dd>`;
}

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
  if (state.templates.length) { renderTemplates(); renderTemplateSelect(); } // both depend on which numbers exist
  window.Assistant?.senders();
}

// Meta's messaging limit as the stats give it: unique people reached in the last 24h against the business
// portfolio's limit (shared by all its numbers). limit: number, null = unlimited, undefined = Meta didn't say.
// When Meta doesn't say, 250 is assumed: it's the level every new portfolio starts at, so it's the safe floor.
const ASSUMED_LIMIT = 250;
function metaLimit(st) {
  const assumed = st.limit === undefined;
  const limit = assumed ? ASSUMED_LIMIT : st.limit;
  const used = limit ? st.limitUsed / limit : 0;
  const cls = used >= 1 ? 'over' : used >= 0.8 ? 'warn' : '';
  const total = limit === null ? ' <span>· unlimited</span>' : ` <span>/ ${limit.toLocaleString()}</span>`;
  const shared = st.limitShared > 1 ? `shared by ${st.limitShared} numbers` : '';
  const tag = assumed ? 'assumed' : 'Meta limit';
  const note = `people in 24h · ${tag}`;
  const title = "Meta's messaging limit: unique people you can message outside the 24-hour reply window in a rolling 24 hours. It's set for your whole business portfolio, so all its numbers share it."
    + (assumed ? " Meta hasn't reported it for this number yet, so 250 (the starting level) is shown. Press Test connection to check." : '');
  return { assumed, used, cls, total, note, shared, tag, title };
}

// Usage strip on each number card (Meta's limit, totals).
function numStats(s) {
  const st = state.stats?.senders.find((x) => x.id === s.id);
  if (!st) return '';
  const m = metaLimit(st);
  return `<div class="num-stats">
    <div class="num-stat" title="${esc(m.title)}"><b>${st.limitUsed.toLocaleString()}${m.total}</b><span>${m.note}</span>
      <div class="meter ${m.cls}"><span data-w="${Math.min(100, m.used * 100).toFixed(2)}" data-k="nc-${s.id}"></span></div></div>
    <div class="num-stat"><b>${fmtNum(st.sent)}</b><span>sent in total</span></div>
    <div class="num-stat"><b>${st.sent ? pct(st.delivered, st.sent) + '%' : '—'}</b><span>delivered</span></div>
  </div>`;
}

// A number's display name as Meta sees it (server: readNumberStatus). Not approved = every send fails with 131037.
const NAME_STATUS = {
  APPROVED: ['good', 'Approved', 'Meta approved this display name.'],
  AVAILABLE_WITHOUT_REVIEW: ['good', 'Approved', 'This display name can be used without a review.'],
  PENDING_REVIEW: ['warn', 'In review at Meta', 'Meta is reviewing the display name. Messages fail (error 131037) until it’s approved, usually within 1–2 days.'],
  DECLINED: ['bad', 'Rejected', 'Meta rejected the display name. Messages fail (error 131037) until a new name is approved. Change it in WhatsApp Manager → Phone numbers.'],
  EXPIRED: ['bad', 'Expired', 'The display name’s approval expired. Request it again in WhatsApp Manager → Phone numbers.'],
  NONE: ['warn', 'Not submitted', 'No display name has been submitted for review yet. Add one in WhatsApp Manager → Phone numbers.'],
};
// The number itself, when it isn't simply connected.
const NUMBER_STATUS = {
  PENDING: 'Setup not finished', UNVERIFIED: 'Not verified', DISCONNECTED: 'Disconnected', FLAGGED: 'Flagged by Meta',
  RESTRICTED: 'Restricted by Meta', BANNED: 'Banned by Meta', RATE_LIMITED: 'Rate limited', DELETED: 'Deleted at Meta', MIGRATED: 'Moved to another account',
};
const nameBlocked = (s) => ['PENDING_REVIEW', 'DECLINED', 'EXPIRED', 'NONE'].includes(s.nameStatus); // sends from it will fail
function nameStatusHtml(s) {
  const n = NAME_STATUS[s.nameStatus];
  const out = [];
  if (n) {
    const tip = n[2] + (s.nameRejection && s.nameStatus === 'DECLINED' ? ` Meta said: ${s.nameRejection}` : '') + (s.statusCheckedAt ? ` (checked ${shortAgo(s.statusCheckedAt)})` : '');
    out.push(`<dt>Display name</dt><dd title="${esc(tip)}"><span class="tag ${n[0]}">${n[1]}</span>${s.newNameStatus === 'PENDING_REVIEW' && s.nameStatus !== 'PENDING_REVIEW' ? '<span class="tag-note">a new name is in review</span>' : ''}</dd>`);
  }
  if (s.numberStatus && s.numberStatus !== 'CONNECTED') {
    out.push(`<dt>Number status</dt><dd title="Meta reports this number as ${esc(s.numberStatus.toLowerCase().replace(/_/g, ' '))}. Check it in WhatsApp Manager → Phone numbers."><span class="tag ${['PENDING', 'UNVERIFIED', 'RATE_LIMITED'].includes(s.numberStatus) ? 'warn' : 'bad'}">${esc(NUMBER_STATUS[s.numberStatus] || s.numberStatus.toLowerCase().replace(/_/g, ' '))}</span></dd>`);
  }
  return out.join('');
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
  // Search by name (label or the business name customers see) or number, once there are a few numbers.
  $('#numBar').classList.toggle('hidden', state.senders.length < 2);
  const q = (state.numQ || '').trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const qf = state.numQuality || '';
  const ratingOf = (s) => (QUALITY[s.qualityRating] ? s.qualityRating : 'NONE');
  drawNumFilter();
  const shown = state.senders.filter((s) => (!qf || ratingOf(s) === qf)
    && (!q || `${s.label} ${s.verifiedName || ''}`.toLowerCase().includes(q) || (digits && String(s.displayPhone || '').replace(/\D/g, '').includes(digits))));
  if (!shown.length) { list.innerHTML = `<div class="card list-empty"><b>No numbers match</b><p>${q ? `Nothing for “${esc(state.numQ)}”${qf ? ` with ${esc(numQualityLabel(qf).toLowerCase())} quality` : ''}.` : `No numbers with ${esc(numQualityLabel(qf).toLowerCase())} quality.`} <a href="#" data-clear-num>Clear search</a></p></div>`; return; }
  list.innerHTML = shown
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
        ${nameStatusHtml(s)}
        ${s.qualityRating ? `<dt>Quality</dt><dd class="dd-pop">${qualityTag(s.qualityRating)}</dd>` : ''}
        ${s.messagingLimit ? `<dt>Meta limit</dt><dd>${esc(tierText(s.messagingLimit))}</dd>` : ''}
        ${numberPlaybooksHtml(s.id)}
        ${s.lastCheckedAt ? `<dt>Connection</dt><dd class="dd-conn" title="Last checked ${esc(new Date(s.lastCheckedAt).toLocaleString())}"><span class="tag good">Connected</span><span class="tag-note">${esc(shortAgo(s.lastCheckedAt))}</span></dd>` : ''}
      </dl>
      <div class="row tight">
        <button class="btn sm" data-test="${s.id}">${icon('zap', 15)}Test connection</button>
        <button class="btn quiet sm" data-edit="${s.id}">${icon('square-pen', 15)}Edit</button>
        ${numberAccessHtml(s)}
      </div>
    </div>`
    )
    .join('');
  Motion.values(list);
  askPhotos();
}
// Numbers whose photo hasn't been read yet: ask Meta once, quietly (Numbers and Templates pages show them).
const photoAsked = new Set();
function askPhotos() {
  if (!state.settings.demoMode) for (const s of state.senders) if (s.hasToken && !s.photoCheckedAt && !photoAsked.has(s.id)) {
    photoAsked.add(s.id);
    api(`/senders/${s.id}/photo/refresh`, { method: 'POST' }).then((x) => { if (x.photoUrl) loadSenders(); }).catch(() => {});
  }
}

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
  if (b.dataset.numTeam) return teamModal();
  if (b.dataset.numGear) return numberModal(state.senders.find((s) => s.id === b.dataset.numGear));
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

// What each field of the number form is, and where to find it in Meta (the ? beside its name).
const SF_HELP = {
  label: 'Your own name for this number, shown only inside SendON (e.g. “Sales line 1”). Customers never see it.',
  phoneNumberId: 'Meta’s ID for the number, not the phone number itself (about 15 digits). Find it in Meta for Developers → your app → WhatsApp → API Setup, under the “From” number. Or WhatsApp Manager → Phone numbers → click the number.',
  accessToken: 'Lets SendON send from this number. Use a permanent token: Meta Business Settings → Users → System users → add one as Admin → Generate new token → pick your app, tick whatsapp_business_messaging and whatsapp_business_management. The temporary token on API Setup stops working after 24 hours.',
  wabaId: 'The WhatsApp Business Account this number belongs to; templates are synced from it. Click Find to fill it in, or see Meta Business Settings → Accounts → WhatsApp accounts, or API Setup under the phone number ID.',
  displayPhone: 'The number customers see, with the country code (e.g. +91 98765 43210). Click Find to read it from Meta.',
};
const sfHelp = (k) => `<span class="sf-help" tabindex="0" role="img" aria-label="Help: ${esc(SF_HELP[k])}" data-help="${esc(SF_HELP[k])}">?</span>`;
// The dark help tooltip for any [data-help] (the ? icons): drawn on top of everything, modals included, so nothing
// clips it; above its icon, or below when there's no room above, and kept inside the window.
{
  const tip = document.createElement('div');
  tip.className = 'help-tip hidden';
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  let at = null;
  const show = (el) => {
    at = el;
    tip.textContent = el.dataset.help;
    tip.classList.remove('hidden', 'below');
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight, vw = document.documentElement.clientWidth;
    const below = r.top - h - 10 < 8;
    tip.classList.toggle('below', below);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - 22, vw - w - 8));
    tip.style.left = left + 'px';
    tip.style.top = (below ? r.bottom + 10 : r.top - h - 10) + 'px';
    tip.style.setProperty('--arrow-x', Math.max(10, Math.min(w - 20, r.left + r.width / 2 - left - 5)) + 'px');
  };
  const hide = () => { at = null; tip.classList.add('hidden'); };
  document.addEventListener('pointerover', (e) => { const el = e.target.closest?.('[data-help]'); if (el && el !== at) show(el); else if (!el && at) hide(); });
  document.addEventListener('focusin', (e) => { const el = e.target.closest?.('[data-help]'); if (el) show(el); });
  document.addEventListener('focusout', (e) => { if (e.target === at) hide(); });
  addEventListener('scroll', hide, true);
}

function senderForm(s = null) {
  // Live numbers are checked with Meta before they're saved (the server checks again on Save).
  const live = !state.settings.demoMode;
  const body = openModal(s ? 'Edit number' : 'Add sender number', `
    <form id="senderForm" novalidate>
      ${s && live && s.hasToken ? `<div class="sf-photo"><span id="sfPhoto">${senderPhotoHtml(s)}</span><div><b>WhatsApp profile photo</b><span class="sub">What customers see on this number's chat. Use your own logo or brand image.</span></div><button type="button" class="btn sm sender-photo-btn" id="sfPhotoBtn">${icon('square-pen', 14)}Edit</button></div>` : ''}
      <label>Label ${sfHelp('label')}<span class="opt">up to 40 characters</span><input name="label" required maxlength="40" autocomplete="off" placeholder="e.g. Sales line 1" value="${esc(s?.label)}" /></label>
      <label>Phone number ID ${sfHelp('phoneNumberId')}<input name="phoneNumberId" required autocomplete="off" inputmode="numeric" data-digits maxlength="17" placeholder="From Meta → WhatsApp → API Setup (digits)" value="${esc(s?.phoneNumberId)}" /></label>
      ${s?.hasToken
        ? `<div class="field-label">Access token ${sfHelp('accessToken')}</div>
           <div class="sf-token" id="sfSaved"><span>${icon('lock', 14)}Saved token ending in <b>${esc((s.accessTokenMasked || '').replace(/^•+/, ''))}</b></span><button type="button" class="btn sm" id="sfReplace">Replace token</button></div>
           <label class="hidden" id="sfTokenWrap">New access token<input name="accessToken" type="text" class="secret" autocomplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" spellcheck="false" placeholder="Paste the new token" /></label>`
        : `<label>Access token ${sfHelp('accessToken')}${live ? '' : '<span class="opt">optional in demo mode</span>'}<input name="accessToken" type="text" class="secret" autocomplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" spellcheck="false" placeholder="Permanent system-user token" /></label>`}
      <label>WhatsApp Business Account ID ${sfHelp('wabaId')}<span class="opt">${live ? 'found from Meta when the number is checked' : 'needed to sync templates'}</span>${live ? '<span class="sf-find">' : ''}<input name="wabaId" autocomplete="off" inputmode="numeric" data-digits maxlength="17" placeholder="${live ? 'Click Find, or paste the ID or Business portfolio ID' : 'Digits'}" value="${esc(s?.wabaId)}" />${live ? `<button type="button" class="btn sm tip-end" id="sfFind" data-tip="I can find it for you with your phone number ID and access token">${icon('search', 14)}Find</button></span>` : ''}</label>
      <label>Display phone ${sfHelp('displayPhone')}<span class="opt">${live ? 'filled in from Meta when the number is checked' : 'optional, for your reference'}</span>${live ? '<span class="sf-find">' : ''}<input name="displayPhone" autocomplete="off" inputmode="tel" maxlength="22" placeholder="${live ? 'Click Find, or type it with the country code' : '+91 98765 43210'}" value="${esc(s?.displayPhone)}" />${live ? `<button type="button" class="btn sm tip-end" id="sfFindPhone" data-tip="I can read it from Meta with your phone number ID and access token">${icon('search', 14)}Find</button></span>` : ''}</label>
      <div class="sf-status hidden" id="sfStatus" role="status" aria-live="polite"></div>
      <p class="sub">${live ? 'Enter the phone number ID and token, then click Find to fill in the Business Account ID and display phone. ' : ''}The token is stored only on this server and never shown in full again.</p>
      <div class="modal-actions">
        ${live ? '<button type="button" class="btn quiet" id="sfTest" data-icon="zap" style="margin-right:auto">Test connection</button>' : ''}
        <button type="button" class="btn quiet" onclick="closeModal()">Cancel</button>
        <button class="btn primary">${s ? 'Save' : 'Add number'}</button>
      </div>
    </form>`);
  const form = $('#senderForm', body), status = $('#sfStatus', body);
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
  // Fills the account ID from the phone number ID and token (or turns a pasted Business portfolio ID into it).
  $('#sfFind', body)?.addEventListener('click', (e) => guard(async () => {
    if (!fields().phoneNumberId) { $('[name=phoneNumberId]', body).focus(); show('bad', 'Enter the phone number ID first'); return; }
    show('busy', '<span class="sf-spin"></span>Finding the Business Account…');
    try {
      const r = await api('/senders/find-waba', { method: 'POST', body: { ...fields(), senderId: s?.id } });
      $('[name=wabaId]', body).value = r.wabaId;
      show('ok', `${icon('circle-check', 15)}<span><b>Found</b> · ${r.name ? esc(r.name) + ' · ' : ''}${esc(r.wabaId)}</span>`);
    } catch (err) { show('bad', esc(err.message)); }
  }, e.currentTarget));
  // Fills the display phone (and the account ID, if empty) by checking the number with Meta.
  $('#sfFindPhone', body)?.addEventListener('click', (e) => guard(async () => {
    if (!fields().phoneNumberId) { $('[name=phoneNumberId]', body).focus(); show('bad', 'Enter the phone number ID first'); return; }
    show('busy', '<span class="sf-spin"></span>Reading the number from Meta…');
    try {
      const r = await api('/senders/verify', { method: 'POST', body: { ...fields(), senderId: s?.id } });
      const i = r.info;
      $('[name=displayPhone]', body).value = i.displayPhone || '';
      if (i.wabaId && !$('[name=wabaId]', body).value) $('[name=wabaId]', body).value = i.wabaId;
      show('ok', `${icon('circle-check', 15)}<span><b>Found</b> · ${esc(i.displayPhone || '')}${i.verifiedName ? ' · ' + esc(i.verifiedName) : ''}</span>`);
    } catch (err) { show('bad', esc(err.message)); }
  }, e.currentTarget));
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
window.setModalBack = setModalBack;
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

// Meta keeps templates per WhatsApp Business Account: a template can only go out from numbers in its account.
// (Templates made here in demo mode, and numbers whose account isn't known, aren't limited.)
const canSend = (t, s) => !t?.wabaId || !s.wabaId || t.wabaId === s.wabaId;
window.templateSenders = (t, list = state.senders) => list.filter((s) => canSend(t, s));
// The numbers in a template's account, for labels: "Spotmies · +91 93467 85644".
const accountLabel = (wabaId) => state.senders.filter((s) => s.wabaId === wabaId).map((s) => s.label).join(', ');
window.accountLabel = accountLabel;
state.tplSender = '';
// One short date at the end of the card's grey line ("· Approved 4 Nov"; the year only when it isn't this year), with
// every date in full on hover. Templates made in WhatsApp Manager show when they were first synced instead of
// created, since Meta doesn't share that.
const tplWhen = (d) => new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const tplDay = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(new Date(d).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
function tplDates(t) {
  const all = [t.createdAt && ['Created', t.createdAt], !t.createdAt && t.firstSeenAt && ['Synced', t.firstSeenAt], t.approvedAt && ['Approved', t.approvedAt]].filter(Boolean);
  if (!all.length) return '';
  const [word, d] = all[all.length - 1];
  return ` · <span class="tpl-date" title="${esc(all.map(([w, x]) => `${w} ${tplWhen(x)}`).join('\n'))}">${word} ${esc(tplDay(d))}</span>`;
}

// A template's variables as short chips. The preview above shows their sample values in place; hovering a chip
// highlights its spot there. A link's sample isn't in the preview, so its chip shows it on hover.
// The sample values a template was made with, for its card's preview, including its saved header image, video or document.
function tplSamples(t) {
  const values = Object.fromEntries(t.variables.filter((v) => v.example).map((v) => [v.key, v.example]));
  if (t.headerSample) values['header.media'] = location.origin + t.headerSample;
  else { // no saved copy (yet): Meta's own sample link, which works until Meta expires it
    const h = (t.components || []).find((c) => String(c.type).toUpperCase() === 'HEADER');
    const link = h?.example?.header_handle?.[0];
    if (/^https:\/\//.test(link || '')) { values['header.media'] = link; if (h.format === 'DOCUMENT') values['header.filename'] = 'Sample document.pdf'; }
  }
  return values;
}

function varChips(t) {
  const label = (v) => (v.media ? v.media + ' URL' : `${v.where === 'header' ? 'header ' : /^button/.test(v.where) ? 'link ' : ''}{{${v.name}}}`);
  const seen = new Set();
  return t.variables.filter((v) => !seen.has(label(v)) && seen.add(label(v))).map((v) => {
    const tip = /^button/.test(v.where) && v.example ? ` title="${esc(`Sample: ${v.example}`)}"` : '';
    return `<span class="var-chip" data-var="${esc(v.key)}"${tip}>${esc(label(v))}</span>`;
  }).join('');
}

// Hovering a variable chip lights up that variable in the card's preview (and scrolls it into view there).
document.addEventListener('pointerover', (e) => {
  const chip = e.target.closest?.('#templateList .var-chip[data-var]');
  const card = (chip || e.target).closest?.('.tpl-card');
  card?.querySelectorAll('.bubble .var.lit').forEach((x) => x.classList.remove('lit'));
  if (!chip) return;
  const spots = [...card.querySelectorAll('.bubble .var')].filter((x) => x.dataset.var === chip.dataset.var);
  spots.forEach((x) => x.classList.add('lit'));
  const box = card.querySelector('.tpl-chat'), el = spots[0];
  if (box && el) {
    const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (r.top < b.top || r.bottom > b.bottom) box.scrollBy({ top: r.top - b.top - b.height / 3, behavior: 'smooth' });
  }
});

// Scrolling and template cards, one scroll movement (a "gesture": wheel events less than 200ms apart) at a time:
// - a gesture that starts over a template's message (or its variable chips) scrolls only that box and stops at its
//   end; the page moves only with a new gesture once the box is already at its end.
// - a gesture that starts on the page keeps scrolling the page, even when the pointer drifts over a card.
const tplWheel = { at: 0, box: null, moved: false };
function scrollPageFrom(el, e) {
  let page = el.parentElement;
  while (page && !(page.scrollHeight > page.clientHeight && /auto|scroll/.test(getComputedStyle(page).overflowY))) page = page.parentElement;
  page ||= document.scrollingElement;
  page.scrollBy({ top: e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * page.clientHeight : e.deltaY, behavior: 'instant' });
}
// (Performance: the page-wide listener is passive, so it never makes the browser wait before scrolling; only the
// message boxes themselves, which are bound in renderTemplates, have a listener that can stop a scroll.)
document.addEventListener('wheel', (e) => {
  if (e.__tplBox) return; // a message box already handled it
  const t = performance.now();
  if (t - tplWheel.at > 200) Object.assign(tplWheel, { box: null, moved: false }); // a gesture that starts on the page
  tplWheel.at = t;
}, { passive: true });
function tplBoxWheel(e) {
  if (e.ctrlKey || !e.deltaY) return;
  e.__tplBox = true;
  const box = e.currentTarget, t = performance.now(), fresh = t - tplWheel.at > 200;
  tplWheel.at = t;
  if (box.scrollHeight <= box.clientHeight) { if (fresh) Object.assign(tplWheel, { box: null, moved: false }); return; } // nothing to scroll in it
  if (fresh) Object.assign(tplWheel, { box, moved: false });
  if (box !== tplWheel.box) { e.preventDefault(); scrollPageFrom(box, e); return; } // the page's gesture carries on
  const atEnd = e.deltaY > 0 ? box.scrollTop + box.clientHeight >= box.scrollHeight - 1 : box.scrollTop <= 0;
  if (!atEnd) { tplWheel.moved = true; return; } // the box scrolls
  e.preventDefault(); // at its end: stop here if this gesture scrolled the box, else move the page
  if (!tplWheel.moved) scrollPageFrom(box, e);
}
const bindTplWheel = (root) => root.querySelectorAll('.tpl-chat, .var-chips').forEach((b) => { if (!b.__wheel) { b.__wheel = true; b.addEventListener('wheel', tplBoxWheel, { passive: false }); } });

// Long template names end in "…" on one line; those get the full name in a tooltip (hover or keyboard focus).
function tipLongTemplateNames(only) {
  for (const h of only ? [only] : document.querySelectorAll('#templateList .tpl-title')) {
    const cut = h.firstElementChild.scrollWidth > h.firstElementChild.clientWidth + 1;
    h.toggleAttribute('data-tip', cut);
    if (cut) { h.dataset.tip = h.textContent; h.tabIndex = 0; h.setAttribute('aria-label', h.textContent); }
    else { h.removeAttribute('tabindex'); h.removeAttribute('aria-label'); }
  }
}
addEventListener('resize', () => { clearTimeout(tipLongTemplateNames.t); tipLongTemplateNames.t = setTimeout(() => tipLongTemplateNames(), 150); });
// Checked again on hover too: a list drawn while the tab was hidden had no widths to measure.
document.addEventListener('pointerover', (e) => { const h = e.target.closest?.('#templateList .tpl-title'); if (h) tipLongTemplateNames(h); });

const tplBodies = new Map(); // section id → its cards' HTML (drawn when the section opens)
function renderTemplates() {
  renderPlaybooks(); // its cards count the templates each playbook answers
  requestAnimationFrame(() => tipLongTemplateNames());
  const list = $('#templateList');
  // With several numbers: a "which number" filter, showing the templates each one can send.
  const nums = state.senders.filter((s) => s.wabaId);
  const filt = $('#tplSender');
  filt.classList.toggle('hidden', nums.length < 2);
  filt.innerHTML = '<option value="">All numbers</option>' + nums.map((s) => `<option value="${s.id}">${esc(s.label)}${s.displayPhone ? ' · ' + esc(s.displayPhone) : ''}</option>`).join('');
  if (!nums.some((s) => s.id === state.tplSender)) state.tplSender = '';
  filt.value = state.tplSender;
  const pick = state.senders.find((s) => s.id === state.tplSender);
  const byNumber = pick ? state.templates.filter((t) => canSend(t, pick)) : state.templates;
  // Search, category and status filters (the bar shows once there's something to filter).
  $('#tplBar').classList.toggle('hidden', state.templates.length < 2);
  const cats = [...new Set(byNumber.map((t) => catLabel(t.category)))].sort();
  if (!cats.includes(state.tplCat)) state.tplCat = ''; // also turns the first-load undefined into '' (All)
  // a dropdown rather than a row of pills, so the filters fit beside the title in the one-line header
  $('#tplCat').innerHTML = ['', ...cats].map((c) => `<option value="${esc(c)}">${esc(c || 'All categories')} (${byNumber.filter((t) => !c || catLabel(t.category) === c).length})</option>`).join('');
  $('#tplCat').value = state.tplCat;
  const q = (state.tplQ || '').trim().toLowerCase();
  const text = (t) => [t.name, t.language, t.category, ...(t.components || []).map((c) => c.text || '')].join(' ').toLowerCase();
  const shown = byNumber.filter((t) => (!state.tplCat || catLabel(t.category) === state.tplCat)
    && (!state.tplStatus || String(t.status).toUpperCase() === state.tplStatus)
    && (!q || text(t).includes(q)));
  // Newest first: when it was made here (or first synced), else approved. Templates with no date go last, newest
  // Meta ID first (Meta's IDs grow over time).
  const when = (t) => Date.parse(t.createdAt || t.firstSeenAt || t.approvedAt || '') || 0;
  const metaNum = (t) => (/^\d+$/.test(t.metaId || '') ? BigInt(t.metaId) : 0n);
  shown.sort((a, b) => when(b) - when(a) || (metaNum(b) > metaNum(a) ? 1 : metaNum(b) < metaNum(a) ? -1 : 0) || a.name.localeCompare(b.name));
  const filtering = q || state.tplCat || state.tplStatus;
  if (!state.templates.length) {
    list.innerHTML = emptyState({
      icon: 'template',
      title: 'No templates yet',
      text: 'WhatsApp only lets you start conversations with templates Meta has approved. Create one here and send it to Meta for review, or sync the ones you already have.',
      actions: `<button class="btn primary" onclick="templateEditor()">${icon('plus', 16)}New template</button><button class="btn" onclick="document.getElementById('syncTemplates').click()">${icon('refresh-cw', 16)}Sync from Meta</button>`,
    });
    return;
  }
  if (filtering && !shown.length) { list.className = 'cards'; list.innerHTML = `<div class="card list-empty"><b>No templates match</b><p>Try another word, category or status. <a href="#" data-clear-tpl>Clear filters</a></p></div>`; return; }
  if (pick && !shown.length) { list.innerHTML = `<p class="sub">No templates for ${esc(pick.label)} yet. Create one, or click Sync from Meta.</p>`; return; }
  const card = (t) => `
    <div class="card tpl-card">
      <div class="li-head">
        <h3 class="tpl-title"><span class="tpl-name">${esc(t.name)}</span></h3>
        <span class="tpl-head-r">${t.categoryChangedFrom ? `<span class="cat-flag" tabindex="0" aria-label="Category changed by Meta" data-tip="${esc(`Submitted as ${catLabel(t.categoryChangedFrom)}, but Meta changed it to ${catLabel(t.category)}. It's charged and treated as a ${(t.category || '').toLowerCase()} message. Think that's wrong? Request a review in WhatsApp Manager → Business Support Home.`)}">${icon('triangle-alert', 16)}</span>` : ''}<span class="pill ${esc(t.status)}">${esc(TPL_STATUS[String(t.status).toUpperCase()] || t.status)}</span></span>
      </div>
      <div class="li-meta">${esc(t.language)} · ${esc((t.category || '').toLowerCase())} · ${t.source === 'synced' ? 'in Meta' : 'demo only'}${tplDates(t)}</div>
      ${t.rejectedReason ? `<div class="tpl-reason">${icon('badge-alert', 14)}<span>Meta's reason: ${esc(t.rejectedReason.toLowerCase().replace(/_/g, ' '))}. Edit it and submit again.</span></div>` : ''}
      <div class="tpl-chat"><div class="bubble">${bubbleHtml(t, tplSamples(t), 'sample')}</div></div>
      ${t.variables.length ? `<div class="var-chips">${varChips(t)}</div>` : '<div class="var-chips"><span class="li-meta">No variables, same message for everyone</span></div>'}
      <div class="row tight">
        ${(() => { const why = tplSendBlock(t); return `<button class="btn sm${why ? ' is-off' : ''}" data-use="${t.id}" ${why ? `aria-disabled="true" data-tip="${esc(why)}"` : ''}>${icon('send', 15)}Use for sending</button>`; })()}
        ${(() => { const why = tplEditBlock(t); return `<button class="btn quiet sm" data-tedit="${t.id}" ${why ? `disabled title="${esc(why)}"` : ''}>${icon('square-pen', 15)}Edit</button>`; })()}
        <button class="btn quiet danger sm" data-del="${t.id}" style="margin-left:auto">${icon('delete', 15)}Delete</button>
      </div>
    </div>`;
  // All numbers, with numbers in different Business Accounts: one titled section per account.
  // One section per WhatsApp Business Account, headed by its number(s) as WhatsApp shows them: profile photo, name,
  // number, Meta's quality rating and limit, and how its templates stand. Picking a number shows just its section.
  const accounts = pick ? [pick.wabaId] : [...new Set(nums.map((x) => x.wabaId))];
  if (!accounts.length) { list.className = 'cards'; list.innerHTML = shown.map(card).join(''); bindTplWheel(list); return; }
  const groups = accounts.map((w) => ({ w, ts: shown.filter((t) => t.wabaId === w) })).filter((g) => !filtering || g.ts.length);
  const other = pick ? [] : shown.filter((t) => !accounts.includes(t.wabaId));
  if (other.length) groups.push({ w: '', ts: other });
  askPhotos();
  list.className = 'tpl-groups';
  // Collapsible: with several numbers they start closed (a list of numbers to open); with one, open. What's opened or
  // closed is remembered; a search or filter opens every section with a match.
  const solo = groups.length < 2;
  tplBodies.clear();
  list.innerHTML = groups.map(({ w, ts }) => {
    const id = w || 'other', open = solo || filtering || tplOpen().has(id);
    const inner = () => (ts.length ? `<div class="cards">${ts.map(card).join('')}</div>` : `<p class="sub tpl-group-empty">No templates for this number yet. Create one, or click Sync from Meta.</p>`);
    tplBodies.set(id, inner);
    return `<section class="tpl-group${open ? ' open' : ''}" data-tg="${esc(id)}">${tplGroupHead(w, ts, pick, solo)}
      ${open ? `<div class="tpl-group-body">${inner()}</div>` : ''}
    </section>`;
  }).join('');
  bindTplWheel(list);
  requestAnimationFrame(markStuck);
}
const tplOpen = () => { try { return new Set(JSON.parse(localStorage.getItem('tplOpen') || '[]')); } catch { return new Set(); } };
// Opening or closing touches only that section (nothing else is redrawn, so the other numbers and the header stay put):
// its templates grow in from nothing or shrink away, height and fade together.
document.addEventListener('click', (e) => {
  const head = e.target.closest?.('#templateList .tpl-num-h[data-toggle]');
  if (!head) return;
  const sec = head.closest('.tpl-group'), id = sec.dataset.tg, open = !sec.classList.contains('open'), set = tplOpen();
  open ? set.add(id) : set.delete(id);
  try { localStorage.setItem('tplOpen', JSON.stringify([...set])); } catch {}
  head.setAttribute('aria-expanded', open);
  sec.__anim?.cancel();
  let body = sec.querySelector(':scope > .tpl-group-body');
  const still = Motion.reduce();
  if (open) {
    sec.classList.add('open');
    if (!body) {
      body = Object.assign(document.createElement('div'), { className: 'tpl-group-body', innerHTML: (tplBodies.get(id) || (() => ''))() });
      sec.append(body);
      LA.hydrate(body);
      bindTplWheel(body);
      requestAnimationFrame(() => tipLongTemplateNames());
    }
    if (!still) {
      const h = body.offsetHeight;
      body.style.overflow = 'hidden';
      sec.__anim = body.animate([{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }], { duration: Math.min(420, 220 + h / 8), easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      sec.__anim.onfinish = sec.__anim.oncancel = () => { body.style.overflow = ''; sec.__anim = null; markStuck(); };
    }
  } else {
    // its header pinned (scrolled into its templates): first bring the section's top back under the title bar
    if (sec.getBoundingClientRect().top < head.getBoundingClientRect().top - 1) sec.scrollIntoView({ block: 'start', behavior: 'instant' });
    const done = () => { body?.remove(); sec.classList.remove('open'); sec.__anim = null; markStuck(); };
    if (!body || still) return done();
    const h = body.offsetHeight;
    body.style.overflow = 'hidden';
    sec.__anim = body.animate([{ height: h + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: Math.min(360, 200 + h / 10), easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' });
    sec.__anim.onfinish = done;
  }
  markStuck();
});
document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('#templateList .tpl-num-h[data-toggle]')) { e.preventDefault(); e.target.click(); } });

function tplGroupHead(w, ts, pick, solo) {
  const count = `<span class="tng-stat"><b>${ts.length}</b> ${ts.length === 1 ? 'template' : 'templates'}</span>`;
  const right = `<div class="tpl-num-stats">${count}${solo ? '' : `<span class="tpl-num-chev">${icon('chevron-down', 18)}</span>`}</div>`;
  const toggle = solo ? '' : ` data-toggle role="button" tabindex="0" aria-expanded="${(tplOpen().has(w || 'other'))}"`;
  if (!w) return `<header class="tpl-num-h other"${toggle}><span class="tpl-num-ic">${icon('file-text', 18)}</span><div class="tpl-num-main"><b>Other templates</b><span class="tpl-num-sub">Not tied to one of your numbers</span></div>${right}</header>`;
  const ss = pick ? [pick] : state.senders.filter((x) => x.wabaId === w);
  const one = (s) => {
    const q = QUALITY[s.qualityRating];
    const bits = [s.displayPhone && `<span class="tpl-num-phone">${esc(s.displayPhone)}</span>`,
      `<span class="tpl-num-q" title="Meta quality rating"><i class="q-dot ${esc(q ? s.qualityRating : 'none')}"></i>${q ? `Quality ${esc(q.label.toLowerCase())}` : 'Not rated yet'}</span>`].filter(Boolean);
    return `<div class="tpl-num-one">${senderPhotoHtml(s)}<div class="tpl-num-main">
        <b>${esc(s.label)}${s.verifiedName && s.verifiedName !== s.label ? `<small> · ${esc(s.verifiedName)}</small>` : ''}${s.enabled === false ? ' <span class="pill">off</span>' : ''}</b>
        <span class="tpl-num-sub">${bits.join('<i class="tpl-num-sep">·</i>')}</span></div></div>`;
  };
  return `<header class="tpl-num-h"${toggle}><div class="tpl-num-list">${ss.map(one).join('')}</div>${right}</header>`;
}

$('#tplSender').addEventListener('change', (e) => { state.tplSender = e.target.value; renderTemplates(); });
$('#numSearch').addEventListener('input', (e) => { state.numQ = e.target.value; renderSenders(); });
// The filter button inside the Numbers search: by Meta quality rating.
const numQualityLabel = (k) => (k === 'NONE' ? 'Not rated' : QUALITY[k]?.label || 'Any');
function drawNumFilter() {
  const k = state.numQuality || '';
  const b = $('#numFilter');
  b.classList.toggle('on', Boolean(k));
  b.innerHTML = `${icon('sliders-horizontal', 15)}${k ? `<span class="num-filter-lbl"><i class="q-dot ${k === 'NONE' ? 'none' : k}"></i>${esc(numQualityLabel(k))}</span>` : ''}`;
  b.title = k ? `Showing ${numQualityLabel(k).toLowerCase()} quality. Click to change.` : 'Filter by quality';
}
$('#numFilter').addEventListener('click', (e) => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  const counts = (k) => state.senders.filter((s) => (QUALITY[s.qualityRating] ? s.qualityRating : 'NONE') === k).length;
  const opt = (k, label) => ({ label, kbd: k ? String(counts(k)) : '', checked: (state.numQuality || '') === k, action: () => { state.numQuality = k; renderSenders(); } });
  Sheet.Menu.open(r.right - 200, r.bottom + 6, [opt('', 'Any quality'), '-', opt('GREEN', 'High'), opt('YELLOW', 'Medium'), opt('RED', 'Low'), opt('NONE', 'Not rated')]);
});
$('#senderList').addEventListener('click', (e) => {
  if (!e.target.closest('[data-clear-num]')) return;
  e.preventDefault();
  state.numQ = ''; state.numQuality = ''; $('#numSearch').value = '';
  renderSenders();
});
$('#tplSearch').addEventListener('input', (e) => { state.tplQ = e.target.value; clearTimeout(renderTemplates.q); renderTemplates.q = setTimeout(renderTemplates, 140); });
$('#tplStatus').addEventListener('change', (e) => { state.tplStatus = e.target.value; renderTemplates(); });
$('#tplCat').addEventListener('change', (e) => { state.tplCat = e.target.value; renderTemplates(); });
$('#templateList').addEventListener('click', (e) => {
  if (!e.target.closest('[data-clear-tpl]')) return;
  e.preventDefault();
  state.tplQ = state.tplCat = state.tplStatus = '';
  $('#tplSearch').value = ''; $('#tplStatus').value = '';
  renderTemplates();
});
$('#templateList').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tedit) return templateEditor(state.templates.find((x) => x.id === b.dataset.tedit));
  if (b.dataset.use) {
    // An unapproved template can't be sent: clicking just shows why (the same note as on hover).
    if (b.dataset.tip) { b.classList.add('tip-show'); clearTimeout(b._tip); b._tip = setTimeout(() => b.classList.remove('tip-show'), 2600); return; }
    window.CampaignSetup.create({ templateId: b.dataset.use });
  }
  if (b.dataset.del)
    guard(async () => {
      const ok = await confirmDialog({ title: 'Remove this template?', message: 'It is removed from this app only. The template stays in your WhatsApp Manager.', confirmText: 'Remove', danger: true });
      if (!ok) return;
      await api('/templates/' + b.dataset.del, { method: 'DELETE' });
      await loadTemplates();
    }, b);
});

// Sync can take a while (every Business Account, then the header samples): the button spins and says "Syncing…",
// a bar runs above the list and the cards dim until it's done.
$('#syncTemplates').addEventListener('click', async (e) => {
  const btn = e.currentTarget, list = $('#templateList');
  if (btn.classList.contains('syncing')) return;
  const label = btn.innerHTML;
  btn.classList.add('syncing');
  btn.setAttribute('aria-busy', 'true');
  btn.innerHTML = `${icon('refresh-cw', 16)}Syncing…`;
  const bar = document.createElement('div');
  bar.className = 'tpl-sync-bar';
  bar.setAttribute('role', 'status');
  bar.innerHTML = `<i></i><span>Getting your templates and their latest review status from Meta…</span>`;
  list.before(bar);
  list.classList.add('tpl-syncing');
  await guard(async () => {
    const r = await api('/templates/sync', { method: 'POST' });
    state.templates = r.templates;
    renderTemplates();
    renderTemplateSelect();
    toast(r.errors.length ? `Synced ${r.synced} template${r.synced === 1 ? '' : 's'}, with problems below` : `Up to date: ${r.synced} template${r.synced === 1 ? '' : 's'} from Meta`);
    r.errors.forEach((er) => toast(er, 'error'));
  }, btn);
  bar.remove();
  list.classList.remove('tpl-syncing');
  btn.classList.remove('syncing');
  btn.removeAttribute('aria-busy');
  btn.innerHTML = label;
});

// --- Template editor: create a template in Meta, or edit one ------------------------------------------
// One popup for both: the form on the left, the message as WhatsApp shows it on the right (with the
// sample values). Meta reviews every new or edited template; the result arrives by itself (webhook).
const TPL_LANGS = [['en', 'English'], ['en_US', 'English (US)'], ['en_GB', 'English (UK)'], ['hi', 'Hindi'], ['te', 'Telugu'], ['ta', 'Tamil'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['mr', 'Marathi'], ['bn', 'Bengali'], ['gu', 'Gujarati'], ['pa', 'Punjabi'], ['ur', 'Urdu'], ['ar', 'Arabic'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt_BR', 'Portuguese (Brazil)'], ['id', 'Indonesian']];
// A template's category as people read it: MARKETING → Marketing.
const catLabel = (c) => (c ? String(c).charAt(0).toUpperCase() + String(c).slice(1).toLowerCase() : 'Other');
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
    // A website button shows the link it opens (kept with the template), never the short link Meta has.
    buttons: btns.map((x, i) => x.type === 'URL' ? { type: 'URL', text: x.text, mode: isGoUrl(x.url) ? 'dynamic' : 'static', url: isGoUrl(x.url) ? t?.linkDefaults?.[i] || '' : x.url }
      : x.type === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: x.text, phone: x.phone_number || '' } : { type: 'QUICK_REPLY', text: x.text }),
  };
}
const tplVarNums = (text) => [...new Set([...String(text || '').matchAll(/{{\s*(\d+)\s*}}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
// Why a template can't be sent yet, or null if it can. Meta only delivers approved templates; ones made here in demo mode have no review.
function tplSendBlock(t) {
  const st = String(t.status || '').toUpperCase();
  if (t.source !== 'synced' || st === 'APPROVED') return null;
  return st === 'PENDING' || st === 'IN_APPEAL' ? 'Still in review at Meta. Please wait until it’s approved to send it.' : `Meta won’t deliver it while it’s ${(TPL_STATUS[st] || st).toLowerCase()}. Only approved templates can be sent.`;
}
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
  const original = tplSpec(t).header.format; // an edit keeps its current sample unless a new one is chosen
  const accounts = [...new Map(state.senders.filter((x) => x.wabaId && x.hasToken).map((x) => [x.wabaId, x])).values()];
  const HEADERS = [['NONE', 'None', 'ban', 'Just the message'], ['TEXT', 'Text', 'type', 'A bold title line'], ['IMAGE', 'Image', 'image', 'JPG or PNG · 5 MB'], ['VIDEO', 'Video', 'video', 'MP4 · 16 MB'], ['DOCUMENT', 'PDF', 'file-text', 'PDF · 15 MB']];
  const CATS = [['MARKETING', 'Marketing', 'sparkles', 'Offers, launches, events, news and anything that promotes'], ['UTILITY', 'Utility', 'circle-check', 'Updates on something they asked for: orders, bookings, account alerts']];
  const card = (n, title, extra, inner) => `<section class="te-card"><div class="te-card-h"><span class="te-step">${n}</span><b>${title}</b>${extra}</div>${inner}</section>`;
  const body = openModal(t ? `Edit ${t.name}` : 'New template', `
    <form id="teForm" class="te" novalidate>
      <div class="te-form">
        ${card(1, 'Basics', '', `
          <div class="te-row">
            <label class="te-name"><span class="te-lbl">Name${t ? '' : '<span class="te-req">required</span>'}</span><span class="te-inline"><input name="name" ${t ? 'readonly' : ''} value="${esc(spec.name)}" placeholder="e.g. webinar_invite" maxlength="512" autocomplete="off" spellcheck="false">${t ? '' : '<span class="te-count in hidden" id="teNameCount"></span>'}</span>${t ? '' : '<span class="te-hint te-name-hint" id="teNameHint" aria-live="polite"></span>'}</label>
            <label><span class="te-lbl">Language</span><select name="language" ${t ? 'disabled' : ''}>${TPL_LANGS.map(([v, l]) => `<option value="${v}" ${v === spec.language ? 'selected' : ''}>${l}</option>`).join('')}${TPL_LANGS.some(([v]) => v === spec.language) ? '' : `<option value="${esc(spec.language)}" selected>${esc(spec.language)}</option>`}</select></label>
          </div>
          <div class="te-field"><span class="field-label">Category ${(() => { const h = 'Meta checks the category when it reviews: a Utility template that promotes anything is moved to Marketing.'; return `<span class="sf-help" tabindex="0" role="img" aria-label="Help: ${esc(h)}" data-help="${esc(h)}">?</span>`; })()}</span>
            <div class="te-cats" role="radiogroup" aria-label="Category">${CATS.map(([v, l, ic, d]) => `<button type="button" role="radio" class="te-cat${spec.category === v ? ' on' : ''}" aria-checked="${spec.category === v}" data-cat="${v}"><span class="te-cat-ic">${icon(ic, 16)}</span><span><b>${l}</b><small>${d}</small></span></button>`).join('')}</div>
          </div>
          ${live && !t && accounts.length ? `<div class="te-acct"><span class="field-label">Business Account</span>
            <select name="senderId" class="hidden" aria-hidden="true" tabindex="-1">${accounts.map((x) => `<option value="${x.id}">${esc(x.verifiedName || x.label)}</option>`).join('')}</select>
            <button type="button" class="te-acct-btn${accounts.length > 1 ? '' : ' single'}" id="teAcct" ${accounts.length > 1 ? 'aria-haspopup="listbox"' : 'tabindex="-1"'}></button></div>` : ''}`)}

        ${card(2, 'Header', '<span class="opt">optional</span>', `
          <div class="te-hdrs" role="radiogroup" aria-label="Header">${HEADERS.map(([v, l, ic, d]) => `<button type="button" role="radio" class="te-hdr${spec.header.format === v ? ' on' : ''}" aria-checked="${spec.header.format === v}" data-hfmt="${v}" title="${d}">${icon(ic, 18)}<b>${l}</b><small>${d}</small></button>`).join('')}</div>
          <div id="teHeaderBox"></div>
          <input type="file" hidden id="teFile">`)}

        ${card(3, 'Message', '<span class="te-req">required</span><span class="te-count" id="teBodyCount"></span>', `
          <div class="te-editor">
            <div class="te-tools">
              <button type="button" data-wrap="*" title="Bold"><b>B</b></button><button type="button" data-wrap="_" title="Italic"><i>I</i></button><button type="button" data-wrap="~" title="Strikethrough"><s>S</s></button><button type="button" data-wrap="\`\`\`" title="Monospace"><code>&lt;/&gt;</code></button>
              <button type="button" class="te-addvar" data-addvar title="Add a variable: a value filled in for each person when sending">${icon('plus', 13)}Variable</button>
            </div>
            <textarea name="bodyText" rows="7" maxlength="1024" placeholder="Hi {{1}}, your order {{2}} is on its way. Track it here: {{3}}">${esc(spec.body.text)}</textarea>
          </div>
          <div id="teBodyWarn" class="te-warns" aria-live="polite"></div>
          <div id="teSamples" class="te-samples"></div>`)}

        ${card(4, 'Footer', '<span class="opt">optional</span><span class="te-count" id="teFooterCount"></span>', `
          <input name="footer" maxlength="60" value="${esc(spec.footer)}" placeholder="Reply STOP to stop these messages">`)}

        ${card(5, 'Buttons', '<span class="opt">optional, up to 10</span>', `
          <div id="teButtons" class="te-buttons"></div>
          <div class="te-addbtns"><button type="button" class="btn sm" data-addbtn="QUICK_REPLY">${icon('reply', 14)}Quick reply</button><button type="button" class="btn sm" data-addbtn="URL">${icon('external-link', 14)}Website</button><button type="button" class="btn sm" data-addbtn="PHONE_NUMBER">${icon('phone', 14)}Call</button></div>`)}
      </div>
      <aside class="te-preview">
        <div class="te-phone">
          <div class="te-phone-bar" id="tePhoneBar"></div>
          <div class="te-chat" id="teChat"><div class="bubble" id="tePreview"></div></div>
        </div>
        <p class="sub">${live ? 'Meta reviews every new or edited template, usually within minutes and at most a day. Its status updates here by itself.' : 'Demo mode: the template is saved here for practice and nothing goes to Meta.'}</p>
      </aside>
      <div class="te-actions">
        <div class="sf-status hidden" id="teStatus" role="status" aria-live="polite"></div>
        <button type="button" class="btn quiet" onclick="closeModal()">Cancel</button>
        <button class="btn primary">${icon('send', 15)}${t ? 'Save changes' : live ? 'Submit for review' : 'Save template'}</button>
      </div>
    </form>`);
  $('#modal .modal-box').classList.add('te-box');
  const form = $('#teForm', body), ta = $('[name=bodyText]', form), fileIn = $('#teFile', form);
  const status = $('#teStatus', body);
  const show = (kind, html) => { status.className = 'sf-status ' + kind; status.innerHTML = html; };


  // --- Business Account: who the template is for (photo, WhatsApp name, number), also heading the preview ---
  const acctOf = () => accounts.find((x) => x.id === $('[name=senderId]', form)?.value) || (t ? state.senders.find((x) => x.wabaId === t.wabaId) : accounts[0]);
  const acctName = (x) => x?.verifiedName || x?.label || '';
  const acctRow = (x) => `${senderPhotoHtml(x)}<span class="te-acct-t"><b>${esc(acctName(x))}</b><small>${esc(x.displayPhone || x.label || '')}</small></span>`;
  const drawAcct = () => {
    const x = acctOf(), btn = $('#teAcct', form);
    if (btn && x) btn.innerHTML = acctRow(x) + (accounts.length > 1 ? icon('chevron-down', 15) : '');
    $('#tePhoneBar', body).innerHTML = x
      ? `${senderPhotoHtml(x)}<span><b>${esc(acctName(x))}</b><small>${esc(x.displayPhone || 'WhatsApp Business')}</small></span>`
      : `<span class="te-phone-av">${icon('smartphone', 14)}</span><span><b>Preview</b></span>`;
  };
  $('#teAcct', form)?.addEventListener('click', (e) => {
    if (accounts.length < 2) return;
    const r = e.currentTarget.getBoundingClientRect(), cur = acctOf();
    const pop = Sheet.Menu.panel(r.left, r.bottom + 6, `<div class="te-acct-list" role="listbox">${accounts.map((x) => `<button type="button" role="option" class="te-acct-opt${x.id === cur?.id ? ' on' : ''}" aria-selected="${x.id === cur?.id}" data-acct="${x.id}">${acctRow(x)}${x.id === cur?.id ? icon('check-one', 15) : ''}</button>`).join('')}</div>`);
    pop.style.width = r.width + 'px';
    Sheet.Menu.fit?.(pop, r);
    pop.addEventListener('click', (ev) => {
      const o = ev.target.closest('[data-acct]');
      if (!o) return;
      $('[name=senderId]', form).value = o.dataset.acct;
      Sheet.Menu.close();
      drawAcct();
    });
    pop.querySelector('.te-acct-opt.on, .te-acct-opt')?.focus();
  });

  // --- What Meta won't accept, caught as you type (the server checks the same) ---
  // HTML or script tags show as plain text on WhatsApp, so they're never meant; a lone "<" or "a < b" is fine.
  const HTML_TAG = /<\/?[a-z][a-z0-9-]*(\s[^<>]*)?\/?>|<!--|<\?[a-z]/i;
  const TAG_MSG = 'Remove the HTML tags (like <b> or <script>): WhatsApp shows them as plain text. For formatting use the B, I and S buttons.';
  const bodyIssues = () => {
    const b = spec.body.text.trim(), out = [];
    const first = b.match(/^{{\s*(\w+)\s*}}/), last = b.match(/{{\s*(\w+)\s*}}$/);
    if (first) out.push(`The message starts with {{${first[1]}}}. Meta doesn't accept a variable at the very start: add a word before it, like “Hi {{${first[1]}}}”.`);
    if (last) out.push(`The message ends with {{${last[1]}}}. Meta doesn't accept a variable at the very end: add a word or a full stop after it.`);
    if (HTML_TAG.test(b)) out.push(TAG_MSG);
    return out;
  };
  // What's wrong with a name, or ''. Meta takes lowercase letters, numbers and _, up to 512; a run of _ (from extra
  // spaces, or typed) reads as a mistake, so it's flagged until fixed.
  const nameProblem = (v) => (/__/.test(v) ? 'Use a single _ between words (there are several in a row)' : '');
  // The name's helper line and count: only while it's being typed in (or just after a change worth saying).
  let nameT = 0;
  const nameHint = (msg) => {
    const h = $('#teNameHint', body), cnt = $('#teNameCount', body), el = $('[name=name]', form);
    if (!h) return;
    const focused = document.activeElement === el;
    cnt.textContent = `${el.value.length} / 512`;
    cnt.classList.toggle('hidden', !focused && !el.value.length);
    cnt.classList.toggle('warn', el.value.length >= 480);
    const err = nameProblem(el.value);
    el.classList.toggle('bad', Boolean(err));
    h.textContent = err || msg || (focused ? 'Lowercase letters, numbers and _ · up to 512' : '');
    h.classList.toggle('on', Boolean(h.textContent));
    h.classList.toggle('bad', Boolean(err));
    clearTimeout(nameT);
    if (msg && !err) nameT = setTimeout(() => nameHint(''), 3200);
  };
  // A field with tags gets a red outline and says why on hover.
  const markTags = (el) => { if (!el) return false; const bad = HTML_TAG.test(el.value); el.classList.toggle('bad', bad); el.title = bad ? TAG_MSG : ''; return bad; };

  // --- Header ---
  const MEDIA_ACCEPT = { IMAGE: 'image/jpeg,image/png', VIDEO: 'video/mp4', DOCUMENT: 'application/pdf' };
  const MEDIA_MAX = { IMAGE: 5, VIDEO: 16, DOCUMENT: 15 };
  const kindOf = (f) => (f === 'DOCUMENT' ? 'PDF' : String(f).toLowerCase());
  const formatFor = (mime) => Object.keys(MEDIA_ACCEPT).find((k) => MEDIA_ACCEPT[k].split(',').includes(mime));
  const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const clearFile = () => { const h = spec.header; if (h.preview) URL.revokeObjectURL(h.preview); h.file = null; h.preview = ''; fileIn.value = ''; };
  const setFormat = (f) => {
    if (f === spec.header.format) return;
    if (spec.header.file) clearFile();
    spec.header.format = f;
    $$('[data-hfmt]', form).forEach((b) => { b.classList.toggle('on', b.dataset.hfmt === f); b.setAttribute('aria-checked', String(b.dataset.hfmt === f)); });
    renderHeader();
    renderPreview();
  };
  // A sample file: from the picker, or dropped on the header box or the preview (which also picks the header type).
  const takeFile = (f) => {
    if (!f) return;
    const fmt = formatFor(f.type);
    if (!fmt) return toast('Use a JPG or PNG image, an MP4 video or a PDF', 'error');
    if (MEDIA_ACCEPT[spec.header.format] && fmt !== spec.header.format) return toast(`This header is a${spec.header.format === 'IMAGE' ? 'n' : ''} ${kindOf(spec.header.format)}: pick a ${kindOf(spec.header.format)} file, or change the header type`, 'error');
    if (f.size > MEDIA_MAX[fmt] * 1048576) return toast(`WhatsApp accepts header ${kindOf(fmt)}s up to ${MEDIA_MAX[fmt]} MB`, 'error');
    if (spec.header.format !== fmt) setFormat(fmt);
    clearFile();
    spec.header.file = f;
    spec.header.preview = URL.createObjectURL(f);
    renderHeader();
    renderPreview();
  };
  const pick = () => { const f = spec.header.format; if (!MEDIA_ACCEPT[f]) return; fileIn.accept = MEDIA_ACCEPT[f]; fileIn.click(); };
  fileIn.addEventListener('change', () => takeFile(fileIn.files?.[0]));
  const renderHeader = () => {
    const h = spec.header, box = $('#teHeaderBox', body);
    if (h.format === 'TEXT') {
      box.innerHTML = `<div class="te-inline"><input name="headerText" maxlength="60" value="${esc(h.text)}" placeholder="Your order is on its way" autocomplete="off"><span class="te-count in">${h.text.length} / 60</span></div>
        <span class="te-hint">Up to 60 characters. One variable at most, like {{1}}.</span>
        ${tplVarNums(h.text).length ? `<label class="te-sample"><code>{{1}}</code><input name="headerSample" value="${esc(h.sample)}" placeholder="What {{1}} could be"></label>` : ''}`;
    } else if (MEDIA_ACCEPT[h.format]) {
      const kind = kindOf(h.format), keeping = t && original === h.format && !h.file;
      const thumb = h.file ? (h.format === 'IMAGE' ? `<img src="${esc(h.preview)}" alt="">` : h.format === 'VIDEO' ? `<video src="${esc(h.preview)}" muted playsinline></video>` : icon('file-text', 22)) : '';
      box.innerHTML = h.file
        ? `<div class="te-file"><span class="te-file-th ${h.format.toLowerCase()}">${thumb}</span><span class="te-file-t"><b title="${esc(h.file.name)}">${esc(h.file.name)}</b><small>${size(h.file.size)} · sample for Meta's review</small></span>
            <button type="button" class="btn sm" data-pick>${icon('refresh-cw', 13)}Replace</button><button type="button" class="icon-btn" data-unfile title="Remove" aria-label="Remove the sample">${icon('x', 15)}</button></div>`
        : `<button type="button" class="te-drop" data-pick>${icon('cloud-upload', 22)}<b>${keeping ? `Keeping the current sample ${kind}` : `Drop a sample ${kind} here, or <u>browse</u>`}</b>
            <small>${keeping ? 'Click to replace it.' : `${HEADERS.find((x) => x[0] === h.format)[3]}. For Meta's review only: you choose the real ${kind} for each campaign.`}</small></button>`;
    } else box.innerHTML = '';
  };

  // --- Variable samples ---
  const renderSamples = () => {
    const nums = tplVarNums(spec.body.text);
    const box = $('#teSamples', body);
    box.innerHTML = nums.length ? `<span class="te-cap">Sample values <span class="opt">for Meta's review and the preview, never sent</span></span>` + nums.map((n) => `<label class="te-sample"><code>{{${n}}}</code><input data-sample="${n - 1}" value="${esc(spec.body.samples[n - 1] || '')}" placeholder="${n === 1 ? 'e.g. Rahul' : 'e.g. a real-looking value'}"></label>`).join('') : '';
  };

  // --- Buttons ---
  const renderButtons = () => {
    const box = $('#teButtons', body);
    box.innerHTML = spec.buttons.map((b, i) => `<div class="te-btn" data-i="${i}">
      <span class="te-btn-kind">${icon(b.type === 'URL' ? 'external-link' : b.type === 'PHONE_NUMBER' ? 'phone' : 'reply', 14)}${b.type === 'URL' ? 'Website' : b.type === 'PHONE_NUMBER' ? 'Call' : 'Quick reply'}</span>
      <input data-bf="text" maxlength="25" value="${esc(b.text)}" placeholder="${b.type === 'URL' ? 'Register Now' : b.type === 'PHONE_NUMBER' ? 'Call us' : 'Interested'}" aria-label="Button text">
      ${b.type === 'URL' ? `<input data-bf="url" value="${esc(b.url)}" placeholder="https://example.com/page" inputmode="url" aria-label="Link the button opens">
        <div class="te-mode"><div class="seg" role="radiogroup" aria-label="Link type">${[['static', 'Static'], ['dynamic', 'Dynamic']].map(([m, l]) => `<button type="button" data-bmode="${m}" class="${b.mode === m ? 'active' : ''}" role="radio" aria-checked="${b.mode === m}">${l}</button>`).join('')}</div>
        <small>${b.mode === 'static' ? '<b>Static:</b> this exact link is part of the template. It can’t be changed when sending.' : '<b>Dynamic:</b> this is the starting link; you can change it for each campaign when sending.'}</small></div>` : ''}
      ${b.type === 'PHONE_NUMBER' ? `<input data-bf="phone" value="${esc(b.phone)}" placeholder="+91 98765 43210" inputmode="tel">` : ''}
      <button type="button" class="icon-btn te-btn-x" data-rmbtn="${i}" aria-label="Remove button">${icon('x', 14)}</button>
    </div>`).join('');
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
    const values = {}, h = spec.header;
    tplVarNums(spec.body.text).forEach((n) => { if (spec.body.samples[n - 1]) values[`body.${n}`] = spec.body.samples[n - 1]; });
    if (h.sample) values['header.1'] = h.sample;
    if (h.preview && h.format !== 'VIDEO') values['header.media'] = h.preview;
    if (h.format === 'DOCUMENT' && h.file) values['header.filename'] = h.file.name;
    const pv = $('#tePreview', body);
    const time = `<div class="te-time">${esc(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</div>`;
    pv.innerHTML = spec.body.text.trim() || h.format !== 'NONE' || spec.buttons.length ? bubbleHtml(asTemplate(), values, false, time) : '<span class="te-empty">Your message appears here as you write it.</span>';
    // The media spot: the chosen video plays here; with no file yet it's a button to add one (or drop one on it).
    const spot = pv.querySelector('.media:not(.media-doc)');
    if (spot && MEDIA_ACCEPT[h.format]) {
      const kind = kindOf(h.format), keeping = t && original === h.format && !h.file;
      spot.outerHTML = h.format === 'VIDEO' && h.preview
        ? videoHtml(h.preview, 'te-pv-video')
        : `<button type="button" class="media te-pv-drop" data-pick title="${keeping ? 'Replace the sample' : `Add a sample ${kind}`}">${icon(h.format === 'IMAGE' ? 'image' : h.format === 'VIDEO' ? 'video' : 'file-text', 22)}<b>${keeping ? `Current sample ${kind}` : `Add a sample ${kind}`}</b><small>${keeping ? 'Click to replace' : 'Click or drop a file here'}</small></button>`;
    }
    const issues = bodyIssues();
    $('#teBodyWarn', body).innerHTML = issues.map((x) => `<p class="te-warn">${icon('badge-alert', 14)}<span>${esc(x)}</span></p>`).join('');
    ta.classList.toggle('bad', issues.length > 0);
    const n = spec.body.text.length;
    $('#teBodyCount', body).textContent = `${n} / 1024`;
    $('#teBodyCount', body).classList.toggle('warn', n > 1000);
    $('#teFooterCount', body).textContent = spec.footer ? `${spec.footer.length} / 60` : '';
  };

  // Drag a file over the header box or the preview: it lights up; drop to use it.
  for (const zone of [$('#teHeaderBox', body), $('#teChat', body)]) {
    zone.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); zone.classList.add('te-over'); } });
    zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('te-over'); });
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('te-over'); takeFile(e.dataTransfer?.files?.[0]); });
  }

  // --- Events ---
  form.addEventListener('click', (e) => {
    const cat = e.target.closest('[data-cat]');
    if (cat) {
      spec.category = cat.dataset.cat;
      $$('[data-cat]', form).forEach((b) => { b.classList.toggle('on', b === cat); b.setAttribute('aria-checked', String(b === cat)); });
      return;
    }
    const hf = e.target.closest('[data-hfmt]');
    if (hf) { setFormat(hf.dataset.hfmt); if (hf.dataset.hfmt === 'TEXT') $('[name=headerText]', body)?.focus(); return; }
    if (e.target.closest('[data-pick]')) return pick();
    if (e.target.closest('[data-unfile]')) { clearFile(); renderHeader(); renderPreview(); return; }
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
      spec.buttons.push(type === 'URL' ? { type, text: '', mode: 'dynamic', url: '' } : type === 'PHONE_NUMBER' ? { type, text: '', phone: '' } : { type, text: '' });
      renderButtons();
      renderPreview();
      $(`.te-btn[data-i="${spec.buttons.length - 1}"] [data-bf=text]`, body)?.focus();
      return;
    }
    const bm = e.target.closest('[data-bmode]');
    if (bm) { spec.buttons[Number(bm.closest('.te-btn').dataset.i)].mode = bm.dataset.bmode; renderButtons(); return; }
    const rm = e.target.closest('[data-rmbtn]');
    if (rm) { spec.buttons.splice(Number(rm.dataset.rmbtn), 1); renderButtons(); renderPreview(); }
  });
  form.addEventListener('input', (e) => {
    const el = e.target;
    status.className = 'sf-status hidden';
    if (el.name === 'name') {
      const raw = el.value, v = raw.toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
      const dropped = [...new Set(raw.replace(/[a-zA-Z0-9_\s-]/g, ''))].join(' ');
      if (v !== raw) { const pos = Math.max(0, el.selectionStart - (raw.length - v.length)); el.value = v; el.setSelectionRange(pos, pos); }
      spec.name = v; el.dataset.suggested = '';
      nameHint(dropped ? `Only lowercase letters, numbers and _ (left out: ${dropped})` : /[A-Z\s-]/.test(raw) ? 'Capitals become lowercase, spaces and dashes become _' : '');
    }
    else if (el.name === 'bodyText') {
      spec.body.text = el.value;
      // No name typed yet: suggest one from the message's first words (it stays editable).
      const nameEl = $('[name=name]', form);
      if (!t && (!nameEl.value || nameEl.dataset.suggested)) {
        const sug = el.value.replace(/{{\s*\d+\s*}}/g, ' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 4).join('_').slice(0, 40);
        nameEl.value = sug; spec.name = sug; nameEl.dataset.suggested = sug ? '1' : ''; nameEl.classList.remove('bad');
        nameHint(sug ? 'Suggested from your message. Change it if you like.' : '');
      } if (tplVarNums(el.value).join() !== $$('[data-sample]', body).map((x) => Number(x.dataset.sample) + 1).join()) renderSamples(); }
    else if (el.name === 'footer') { spec.footer = el.value; markTags(el); }
    else if (el.name === 'headerText') {
      spec.header.text = el.value;
      markTags(el);
      const cnt = $('.te-count.in', body); if (cnt) cnt.textContent = `${el.value.length} / 60`;
      if (Boolean(tplVarNums(el.value).length) !== Boolean($('[name=headerSample]', body))) { const pos = el.selectionStart; renderHeader(); const x = $('[name=headerText]', body); x.focus(); x.setSelectionRange(pos, pos); }
    }
    else if (el.name === 'headerSample') { spec.header.sample = el.value; markTags(el); }
    else if (el.dataset.sample != null) { spec.body.samples[Number(el.dataset.sample)] = el.value; if (!markTags(el)) { el.classList.toggle('bad', Boolean(linkProblem(el.value))); el.title = linkProblem(el.value) ? `This ${linkProblem(el.value)}. Write the full link, e.g. https://example.com` : ''; } }
    else if (el.dataset.bf) { const b = spec.buttons[Number(el.closest('.te-btn').dataset.i)]; b[el.dataset.bf] = el.value; if (el.dataset.bf === 'text') markTags(el); if (el.dataset.bf === 'url') { const bad = el.value.trim() && linkProblem(el.value, true); el.classList.toggle('bad', Boolean(bad)); el.title = bad ? 'Write the full link, starting with https://' : ''; } }
    renderPreview();
  });
  form.addEventListener('change', (e) => { if (e.target.name === 'language') spec.language = e.target.value; });
  form.addEventListener('focusin', (e) => { if (e.target.name === 'name' && !t) nameHint(''); });
  form.addEventListener('focusout', (e) => { if (e.target.name === 'name' && !t) setTimeout(() => nameHint(''), 0); });

  const fileData = (f) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(f); });
  // Points at what's missing: scrolls to it, outlines it, and says so beside the buttons.
  const missing = (el, msg) => { el?.classList.add('bad'); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); el?.focus?.({ preventScroll: true }); show('bad', msg); };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!t && !spec.name.trim()) return missing($('[name=name]', form), 'Give the template a name, e.g. webinar_invite');
    if (!t && nameProblem(spec.name)) { nameHint(''); return missing($('[name=name]', form), `${nameProblem(spec.name)}: e.g. ${esc(spec.name.replace(/_{2,}/g, '_'))}`); }
    const h = spec.header;
    if (MEDIA_ACCEPT[h.format] && !h.file && !(t && original === h.format)) { const d = $('.te-drop', body); missing(d, `Add a sample ${kindOf(h.format)} for the header: Meta needs it to review the template`); return; }
    if (!spec.body.text.trim()) return missing(ta, 'Write the message');
    const issue = bodyIssues()[0];
    if (issue) return missing(ta, esc(issue));
    const tagged = $$('[name=headerText], [name=headerSample], [name=footer], [data-sample], [data-bf=text]', form).find((x) => HTML_TAG.test(x.value));
    if (tagged) { markTags(tagged); return missing(tagged, esc(TAG_MSG)); }
    const btn = $('.te-actions .btn.primary', body);
    guard(async () => {
      if (t && String(t.status).toUpperCase() === 'APPROVED' && live && t.metaId) {
        const ok = await confirmDialog({ title: `Send ${esc(t.name)} back to review?`, message: "Meta reviews every edit. Until it's approved again, this template can't be sent, and Meta allows one edit a day.", confirmText: 'Save and submit' });
        if (!ok) return;
      }
      show('busy', `<span class="sf-spin"></span>${live && (!t || t.metaId) ? 'Sending to Meta…' : 'Saving…'}`);
      const payload = {
        name: spec.name, language: $('[name=language]', form).value, category: spec.category, senderId: $('[name=senderId]', form)?.value,
        header: { format: h.format, text: h.text, sample: h.sample, file: h.file ? { mime: h.file.type, name: h.file.name, data: await fileData(h.file) } : null },
        body: { text: spec.body.text, samples: tplVarNums(spec.body.text).map((n) => spec.body.samples[n - 1] || '') },
        footer: spec.footer, buttons: spec.buttons,
      };
      try {
        await api(t ? `/templates/${t.id}/meta` : '/templates/meta', { method: t ? 'PUT' : 'POST', body: payload });
      } catch (err) { show('bad', esc(err.message)); return; }
      if (h.preview) URL.revokeObjectURL(h.preview);
      closeModal();
      toast(live && (t?.metaId || !t) ? `${t ? 'Changes sent' : 'Template sent'} to Meta for review. You'll see the result here.` : 'Template saved');
      await loadTemplates();
    }, btn);
  });

  drawAcct();
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

// --- Sticky page headers ---------------------------------------------------------------------------------
// Every list page keeps its title row (and its search / filter bar just below) pinned while the content scrolls.
// The bar sits right under the header: the header's height is measured into --head-h.
const STICKY_BARS = '#ovFilters, .ct-bar, #tplBar, .cp-tools, .ec-bar, #tab-reports .list-bar, .nt-bar';
// Exact (fractional) heights of the pinned header (--head-h) and toolbar (--bar-h), for whatever pins below them.
const stickyRO = new ResizeObserver((es) => { for (const e of es) e.target.closest('.tab')?.style.setProperty(e.target.classList.contains('sticky-bar') ? '--bar-h' : '--head-h', e.target.getBoundingClientRect().height + 'px'); });
// (The Inbox, Assistant and Send pages have their own layouts: nothing pins there, so nothing is measured there.
// Measuring forces the browser to lay out the whole page, which on a long chat is a visible hitch.)
const OWN_LAYOUT = /^(inbox|assistant|send)$/;
function setupSticky() {
  if (OWN_LAYOUT.test(state.tab)) return;
  const main = document.querySelector('main');
  if (main) {
    const cs = getComputedStyle(main);
    document.documentElement.style.setProperty('--gut', cs.paddingLeft);
    document.documentElement.style.setProperty('--gut-top', cs.paddingTop);
  }
  for (const tab of $$('.tab')) {
    if (/^tab-(inbox|assistant|send)$/.test(tab.id)) continue; // own layouts
    const head = [...tab.querySelectorAll('.section-head')].find((h) => !h.closest('.hidden, #campaignDetail, .modal'));
    if (head && !head.classList.contains('sticky-head')) { head.classList.add('sticky-head'); stickyRO.observe(head); }
    const cd = tab.querySelector('#cdHead.sticky-head'); // an open campaign's own header (campaigns.js)
    if (cd && !cd.__sticky) { cd.__sticky = true; stickyRO.observe(cd); }
    tab.querySelectorAll(STICKY_BARS).forEach((b) => { if (!b.closest('.section-head') && !b.classList.contains('sticky-bar')) { b.classList.add('sticky-bar'); stickyRO.observe(b); } });
  }
  markStuck();
}
// A thin line under whatever is pinned at the moment, so the edge reads against the scrolling content.
function markStuck() {
  if (OWN_LAYOUT.test(state.tab)) return;
  const tab = $(`#tab-${state.tab}`);
  if (!tab) return;
  const head = [...tab.querySelectorAll('.sticky-head')].find((h) => h.offsetParent), bar = [...tab.querySelectorAll('.sticky-bar')].find((b) => b.offsetParent);
  const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stick-top')) || 0;
  const barStuck = bar && bar.getBoundingClientRect().top <= top + (head?.offsetHeight || 0) + 1 && scrollY > 0;
  head?.classList.toggle('stuck', scrollY > 2 && !bar); // with a toolbar, only the toolbar draws the edge line
  tab.querySelectorAll('.sticky-bar').forEach((b) => { b.classList.toggle('stuck', b === bar && barStuck); b.classList.toggle('pinned', b === bar && barStuck); });
  // Templates: a number's header pinned under the title bar joins it (full width, the bar's background, one edge line
  // under both), so header and number read as one bar while that number's templates scroll by.
  if (state.tab === 'templates' && head) {
    const edge = top + head.getBoundingClientRect().height;
    let any = false;
    tab.querySelectorAll('.tpl-group.open > .tpl-num-h').forEach((h) => {
      const on = h.getBoundingClientRect().top <= edge + 0.5 && h.parentElement.getBoundingClientRect().top < h.getBoundingClientRect().top - 0.5;
      h.classList.toggle('pinned', on);
      any ||= on;
    });
    head.classList.toggle('merged', any);
  }
  // Contacts (table view): the column headings pinned under the title bar join it the same way.
  if (state.tab === 'contacts' && head) {
    const sel = parseFloat(getComputedStyle(tab).getPropertyValue('--ct-sel-h')) || 0; // the pinned selection bar, when shown
    const edge = top + head.getBoundingClientRect().height + sel, thead = tab.querySelector('#ctHeadWrap');
    const on = Boolean(thead && thead.offsetParent && thead.getBoundingClientRect().top <= edge + 0.5 && thead.parentElement.getBoundingClientRect().top < edge - 0.5);
    thead?.classList.toggle('pinned', on);
    head.classList.toggle('merged', on);
  }
}
addEventListener('scroll', markStuck, { passive: true });

// Page titles: the header is one line, so each page's description shows on hover over its title instead. The tip stays
// open while the pointer is on it (some descriptions have a link).
const headTip = Object.assign(document.createElement('div'), { id: 'headTip', className: 'chart-tip head-tip hidden' });
headTip.setAttribute('role', 'tooltip');
document.body.append(headTip);
let headTipT = 0;
const headDesc = (h) => {
  const sub = h.closest('.section-head')?.querySelector(':scope > div:first-child > .sub');
  return sub && sub.textContent.trim() ? sub : null;
};
function hideHeadTip() { clearTimeout(headTipT); headTipT = 0; headTip.classList.add('hidden'); headTip.__for = null; }
function showHeadTip(h) {
  const sub = headDesc(h);
  if (!sub) return;
  headTip.innerHTML = sub.innerHTML;
  headTip.__for = h;
  headTip.classList.remove('hidden');
  const r = h.getBoundingClientRect(), w = headTip.offsetWidth;
  headTip.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  headTip.style.top = r.bottom + 8 + 'px';
}
document.addEventListener('pointerover', (e) => {
  const h = e.target.closest?.(':is(.tab, #campaignList) > .section-head :is(h1, .cp-sum-btn)');
  if (h && headDesc(h)) {
    clearTimeout(headTipT);
    if (headTip.__for !== h) headTipT = setTimeout(() => showHeadTip(h), headTip.__for ? 0 : 250);
    return;
  }
  if (e.target.closest?.('#headTip')) { clearTimeout(headTipT); return; }
  if (headTip.__for || headTipT) { clearTimeout(headTipT); headTipT = setTimeout(hideHeadTip, 160); }
});
addEventListener('scroll', () => headTip.__for && hideHeadTip(), { passive: true });
document.addEventListener('focusin', (e) => { const b = e.target.closest?.('.cp-sum-btn'); if (b) showHeadTip(b); });
document.addEventListener('focusout', (e) => { if (e.target.closest?.('.cp-sum-btn')) hideHeadTip(); });
document.addEventListener('pointerdown', (e) => !e.target.closest?.('#headTip') && headTip.__for && hideHeadTip());

// A header's filters sit beside the title while they fit on that line; when they don't (a narrow window, many filters)
// the whole toolbar moves to its own row under the title, rather than wrapping into a cramped block.
const SEARCH_W = 210;
function fitHead(h) {
  const bar = h.querySelector(':scope > .in-head');
  if (!bar || !h.offsetParent) return;
  const kids = [...bar.children].filter((k) => k.getClientRects().length);
  if (!kids.length) return h.classList.remove('tools-below');
  const cs = getComputedStyle(h), gap = parseFloat(cs.columnGap) || 0, bgap = parseFloat(getComputedStyle(bar).columnGap) || 0;
  const need = kids.reduce((a, k) => a + (k.classList.contains('search-wrap') ? SEARCH_W : k.classList.contains('filter-note') ? 0 : k.scrollWidth), 0) + bgap * (kids.length - 1);
  const acts = h.lastElementChild !== bar ? h.lastElementChild : null;
  const avail = h.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - h.firstElementChild.scrollWidth - (acts ? acts.offsetWidth + gap : 0) - gap;
  h.classList.toggle('tools-below', need > avail);
}
const headRO = new ResizeObserver((ents) => { const seen = new Set(); for (const e of ents) { const h = e.target.closest('.section-head') || e.target.querySelector(':scope > .section-head.has-tools'); if (h && !seen.has(h)) { seen.add(h); fitHead(h); } } });
document.querySelectorAll('.section-head.has-tools').forEach((h) => {
  headRO.observe(h);
  const bar = h.querySelector(':scope > .in-head');
  if (!bar) return;
  [...bar.children, h.firstElementChild, h.lastElementChild].forEach((k) => headRO.observe(k));
  new MutationObserver(() => fitHead(h)).observe(bar, { attributes: true, attributeFilter: ['class'], subtree: true, childList: true });
});
// Campaigns draws its header itself (campaigns.js calls fitHead after each draw); its container is watched for size.
window.fitHead = fitHead;
headRO.observe($('#campaignList'));

// The browser's saved logins and form history kept popping up over ordinary text boxes (search, names, messages).
// Every box opts out unless it says otherwise (the account password fields keep their current-/new-password hints),
// password managers too.
function noAutofill(root) {
  root.querySelectorAll?.('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=color]), textarea').forEach((el) => {
    if (el.__noAf) return;
    el.__noAf = true;
    if (!el.hasAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
    if (/password/.test(el.getAttribute('autocomplete'))) return;
    el.setAttribute('data-1p-ignore', '');
    el.setAttribute('data-lpignore', 'true');
    el.setAttribute('data-bwignore', '');
    el.setAttribute('data-form-type', 'other');
  });
}
noAutofill(document);
new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1) noAutofill(n.matches?.('input, textarea') ? n.parentNode || n : n); })
  .observe(document.body, { childList: true, subtree: true });
addEventListener('resize', setupSticky);
// The Inbox scrolls inside its own panes: shadow the list's tools / the chat header once something is underneath.
document.addEventListener('scroll', (e) => {
  const t = e.target;
  if (t.id === 'ibConvs') $('#tab-inbox .ib-tools')?.classList.toggle('stuck', t.scrollTop > 2);
  else if (t.id === 'ibMsgs') $('#tab-inbox .ib-head')?.classList.toggle('stuck', t.scrollTop > 2);
}, { capture: true, passive: true });
// Pages that pin things re-check when their content changes; changes inside the Inbox, Assistant and Send (which
// redraw often) are ignored.
new MutationObserver((recs) => {
  if (recs.every((r) => r.target.closest?.('#tab-inbox, #tab-assistant, #tab-send'))) return;
  clearTimeout(setupSticky.t); setupSticky.t = setTimeout(setupSticky, 50);
}).observe(document.querySelector('main') || document.body, { childList: true, subtree: true });

// --- Live: other people's changes, and new versions of the app ---------------------------------------------
// Someone else changed something in this workspace: reload just that part (a moment later, so a burst of
// changes is one reload). Our own changes are skipped (each tab sends its id with every request).
const liveDue = new Map();
const busy = () => Boolean(document.querySelector('.modal:not(.hidden), .sg-menu-pop')) || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
const LIVE_RELOAD = {
  senders: async () => { await loadSenders(); refreshStats().then(() => state.tab === 'numbers' && renderSenders()).catch(() => {}); },
  templates: () => loadTemplates(),
  settings: async () => { state.settings = await api('/settings'); if (!$('#tab-settings').contains(document.activeElement)) renderSettings(); },
  team: async () => {
    const hadAi = state.me?.ai;
    await loadMe(); await loadTeam(); await loadSenders();
    if (state.tab === 'overview') loadOverview();
    if (hadAi !== state.me.ai) { // the AI assistant was given or taken away: reload what shows it
      state.settings = await api('/settings');
      if (!$('#tab-settings').contains(document.activeElement)) renderSettings();
      if (state.tab === 'assistant' && !state.me.ai) showTab('overview');
      if (state.tab === 'inbox') window.Inbox?.show();
    }
  },
  contacts: () => state.tab === 'contacts' && window.Contacts?.show(),
  campaigns: () => { if (state.tab === 'campaigns') loadCampaigns(); if (state.tab === 'overview') loadOverview(); },
  reports: () => state.tab === 'reports' && window.MetaErrors?.showReports(),
};
document.addEventListener('live', (e) => {
  const d = e.detail || {};
  if (d.kind === 'hello') return checkBuild(d.build);
  if (d.kind !== 'changed' || d.tab === TAB_ID || !LIVE_RELOAD[d.area]) return;
  clearTimeout(liveDue.get(d.area));
  liveDue.set(d.area, setTimeout(() => {
    liveDue.delete(d.area);
    Promise.resolve(LIVE_RELOAD[d.area]()).catch(() => {});
  }, 400));
});
// Unsaved changes: a field you've typed into counts until something is saved (any change the server accepts), you
// put it back as it was, or its window is closed (closing a form discards it). Search boxes and filters don't count,
// nor the Inbox reply box (its draft comes back after a reload by itself), nor ticks and switches.
const edited = new Set();
const NOT_DATA = 'input[type=search], [role=searchbox], .search, #ibText, [data-no-unsaved], [data-no-unsaved] *';
const NOT_TYPED = ['checkbox', 'radio', 'range', 'file', 'color', 'button', 'submit'];
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches?.('input, textarea, [contenteditable]') && !t.matches(NOT_DATA) && !NOT_TYPED.includes(t.type)) edited.add(t);
}, true);
function hasUnsaved() {
  for (const t of edited) {
    if (!t.isConnected || t.closest('.modal.hidden, .modal.closing') || ('defaultValue' in t && t.value === t.defaultValue)) edited.delete(t);
  }
  return edited.size > 0;
}
function markSaved() { edited.clear(); }

// A deploy restarts the server with a new build id. When this page sees one it reloads itself, but never in the
// middle of something: while you're typing or have a window or menu open it waits, and while anything you've typed
// isn't saved it asks you to save first. A note says which; clicking it updates now (asking first if that would lose
// unsaved work). Once you're done, and saved, it updates by itself.
let BUILD = null, updating = false;
function checkBuild(build) {
  if (!build) return;
  if (BUILD == null) { BUILD = build; return; }
  if (build === BUILD || updating) return;
  updating = true;
  const reload = () => { try { sessionStorage.setItem('updated', '1'); } catch {} location.reload(); };
  if (!busy() && !hasUnsaved()) return reload();
  let note = null, shown = '';
  const updateNow = async () => {
    if (hasUnsaved() && !(await confirmDialog({ title: 'Update without saving?', message: 'What you’ve typed but not saved yet will be lost. Save it first and the app updates by itself.', confirmText: 'Update anyway', danger: true }))) { shown = ''; return; }
    reload();
  };
  const tell = () => {
    const kind = hasUnsaved() ? 'save' : 'wait';
    if (kind === shown) return;
    note?.dismiss();
    shown = kind;
    note = kind === 'save'
      ? toast('A new version of the app is ready. Save what you’re working on and it updates right after. Click to update now.', '', { title: 'Save your changes to update', icon: 'refresh-cw', onClick: updateNow, duration: 600000 })
      : toast('A new version of the app is ready. Click to update now, or it updates once you’re done here.', '', { title: 'Update available', icon: 'refresh-cw', onClick: updateNow, duration: 600000 });
  };
  tell();
  setInterval(() => {
    if (!busy() && !hasUnsaved() && !document.hidden) return reload();
    tell();
  }, 2000);
}
// Backup for when the live stream misses it: ask every 2 minutes, and when you come back to the tab.
const askBuild = () => api('/version').then((v) => checkBuild(v.build)).catch(() => {});
setInterval(askBuild, 120000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) askBuild(); });
try { if (sessionStorage.getItem('updated')) { sessionStorage.removeItem('updated'); setTimeout(() => toast('Updated to the latest version'), 600); } } catch {}

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

// Links typed as values must be complete. `mustBeLink`: a button link or header file (only a full http(s) address
// works there). Otherwise only text that looks like a link without its https:// ("cal.com/demo", "www.x.com") is a
// problem: WhatsApp wouldn't make it tappable. Returns what's wrong, or ''. Keep in step with linkProblem in server.js.
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

// A popup over the one already open (which keeps its state): the template and number pickers use it from the
// playbook editor. Returns { body, box, close }. Escape and a click outside close only this one.
function layerModal(id, title, html, cls = '') {
  let el = $('#' + id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.className = 'modal layer hidden';
    document.body.append(el);
    el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-layer-close]')) hideOverlay(el); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.classList.contains('hidden') && !$$('.modal.layer:not(.hidden)').some((o) => o !== el && el.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING)) { e.stopPropagation(); hideOverlay(el); } }, true);
  }
  el.innerHTML = `<div class="modal-box ${cls}" role="dialog" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-layer-close aria-label="Close">${icon('x', 18)}</button></div><div class="layer-body">${html}</div></div>`;
  LA.hydrate(el);
  el.classList.remove('hidden');
  return { body: el.querySelector('.layer-body'), box: el.querySelector('.modal-box'), close: () => hideOverlay(el) };
}

// Choosing numbers (for a playbook): every number as a card with its WhatsApp photo, name, number, quality and how
// many templates it can send; or "All numbers", which also covers numbers added later. onUse({ all, ids }).
function numberPicker({ all = false, ids = [], title = 'Choose numbers', onUse }) {
  let every = all;
  const sel = new Set(ids);
  const { body, close } = layerModal('numPickModal', title, `
    <label class="np-all"><span>${icon('phone', 16)}<span><b>All numbers</b><small>Every number uses it, including ones you add later.</small></span></span>${toggleHtml({ checked: every, attrs: 'id="npAll"', size: 'sm' })}</label>
    <div class="np-grid" id="npGrid" role="listbox" aria-multiselectable="true"></div>
    <div class="tp-foot"><span class="tp-count" id="npCount"></span><button type="button" class="btn quiet" data-layer-close>Cancel</button><button type="button" class="btn primary" id="npUse">Use selected</button></div>`, 'wide np-box');
  const draw = () => {
    $('#npGrid', body).classList.toggle('all', every);
    $('#npGrid', body).innerHTML = state.senders.map((s) => {
      const on = every || sel.has(s.id), q = QUALITY[s.qualityRating];
      const n = state.templates.filter((t) => canSend(t, s)).length;
      return `<div class="np-card ${on ? 'on' : ''}" data-id="${esc(s.id)}" role="option" aria-selected="${on}" tabindex="${every ? -1 : 0}">
        <span class="np-check">${TICK_SVG}</span>${senderPhotoHtml(s)}
        <span class="np-t"><b>${esc(s.label)}${s.enabled === false ? ' <span class="pill">off</span>' : ''}</b><small>${esc(s.displayPhone || '')}</small>
        <small class="np-meta"><i class="q-dot ${esc(q ? s.qualityRating : 'none')}"></i>${q ? `Quality ${esc(q.label.toLowerCase())}` : 'Not rated yet'} · ${n} template${n === 1 ? '' : 's'}</small></span></div>`;
    }).join('') || '<p class="pb-hint">No numbers yet. Add one on the Numbers page.</p>';
    $('#npCount', body).textContent = every ? 'All numbers' : `${sel.size} selected`;
  };
  draw();
  const toggle = (c) => { if (every || !c) return; sel.has(c.dataset.id) ? sel.delete(c.dataset.id) : sel.add(c.dataset.id); draw(); $(`.np-card[data-id="${CSS.escape(c.dataset.id)}"]`, body)?.focus(); };
  $('#npAll', body).onchange = (e) => { every = e.target.checked; draw(); };
  $('#npGrid', body).addEventListener('click', (e) => toggle(e.target.closest('.np-card')));
  $('#npGrid', body).addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e.target.closest('.np-card')); } });
  $('#npUse', body).onclick = () => { onUse({ all: every, ids: every ? [] : state.senders.filter((s) => sel.has(s.id)).map((s) => s.id) }); close(); };
}

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
    chips.push(val ? `<span class="var${neutral === 'sample' ? ' sample' : ''}" ${key}${neutral === 'sample' ? ` title="{{${esc(name)}}}: sample value"` : ''}>${waFormat(esc(val))}</span>` : `<span class="var ${neutral ? '' : 'empty'}" ${key}>{{${esc(name)}}}</span>`);
    return `\u0001${chips.length - 1}\u0001`;
  });
  return waFormat(marked).replace(/\u0001(\d+)\u0001/g, (_, n) => chips[n]);
}

// A video the way WhatsApp shows one: its first frame, a round play button and its length; click to play or pause
// (a thin progress bar runs along the bottom), double-click or the corner button for full screen. Used in message
// bubbles, the Inbox and the template editor. Behaviour below, shared by every .vid on the page.
const PLAY_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.2-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z"/></svg>';
const FULL_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
function videoHtml(src, cls = '') {
  const u = String(src || '');
  const first = /^blob:/.test(u) || u.includes('#') ? u : u + '#t=0.1'; // #t: Chrome paints the first frame as the thumbnail
  return `<div class="vid ${cls}" data-vid><video src="${esc(first)}" preload="metadata" playsinline></video>`
    + `<button type="button" class="vid-play" aria-label="Play video">${PLAY_SVG}</button>`
    + `<span class="vid-time">${icon('video', 12)}<span class="vid-len"></span></span>`
    + `<button type="button" class="vid-full" aria-label="Full screen">${FULL_SVG}</button><i class="vid-bar"><b></b></i></div>`;
}
const vidClock = (sec) => (Number.isFinite(sec) ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : '');
document.addEventListener('click', (e) => {
  const box = e.target.closest?.('.vid');
  if (!box) return;
  e.preventDefault(); e.stopPropagation(); // a video inside a link or clickable card shouldn't open that too
  const v = box.querySelector('video');
  if (e.target.closest('.vid-full')) { (v.requestFullscreen || v.webkitEnterFullscreen)?.call(v); v.controls = true; return v.play().catch(() => {}); }
  if (v.paused) { document.querySelectorAll('.vid.playing video').forEach((o) => o !== v && o.pause()); v.play().catch(() => box.classList.add('broken')); } else v.pause();
});
document.addEventListener('dblclick', (e) => { const v = e.target.closest?.('.vid')?.querySelector('video'); if (v) { v.controls = true; (v.requestFullscreen || v.webkitEnterFullscreen)?.call(v); } });
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) document.querySelectorAll('.vid video[controls]').forEach((v) => (v.controls = false)); });
// Media events don't bubble, so these listen in the capture phase.
const vidOf = (e) => (e.target?.tagName === 'VIDEO' ? e.target.closest('.vid') : null);
document.addEventListener('loadedmetadata', (e) => { const b = vidOf(e); if (b) { b.querySelector('.vid-len').textContent = vidClock(e.target.duration); b.classList.add('ready'); } }, true);
document.addEventListener('error', (e) => { vidOf(e)?.classList.add('broken'); }, true);
document.addEventListener('play', (e) => vidOf(e)?.classList.add('playing'), true);
document.addEventListener('pause', (e) => vidOf(e)?.classList.remove('playing'), true);
document.addEventListener('ended', (e) => { const b = vidOf(e); if (b) { b.classList.remove('playing'); e.target.currentTime = 0.1; } }, true);
document.addEventListener('timeupdate', (e) => {
  const b = vidOf(e), v = e.target;
  if (!b || !v.duration) return;
  b.querySelector('.vid-bar b').style.width = `${(100 * v.currentTime) / v.duration}%`;
  b.querySelector('.vid-len').textContent = vidClock(b.classList.contains('playing') ? v.duration - v.currentTime : v.duration);
}, true);

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
      const isVideo = h.format === 'VIDEO' && /^(https?:\/\/|blob:)/.test(url || '');
      // A real image keeps its own shape, like on the phone; until there is one, a placeholder box.
      let docName = h.format === 'DOCUMENT' && url ? String(values['header.filename'] || '').trim() || decodeURIComponent(String(url).split('/').pop() || '') : '';
      if (/^[0-9a-f]{32}\.[a-z0-9]{2,4}$/.test(docName)) docName = 'Document.pdf'; // an upload from before names were kept
      if (docName && !/\.[a-z0-9]{2,4}$/i.test(docName)) docName += '.pdf'; // the server adds it when sending, too
      // A PDF opens in the preview popup (pdfViewer) when clicked.
      html += isImg ? `<img class="media-img" src="${esc(url)}" alt="" loading="lazy" />`
        : isVideo ? videoHtml(url)
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
  const q = statsQuery();
  let st = await api('/stats?' + q);
  // A remembered filter can point at a number or template that no longer exists (e.g. after
  // reloading the demo workspace). The dropdown would show "All", yet still filter everything out.
  const staleSender = st.filters.sender && !st.senders.some((s) => s.id === st.filters.sender);
  const staleTemplate = st.filters.template && !st.options.templates.includes(st.filters.template);
  if (staleSender || staleTemplate) {
    if (staleSender) state.ov.sender = '';
    if (staleTemplate) state.ov.template = '';
    saveOv();
    st = await api('/stats?' + statsQuery());
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
  // the description shows on hover over the title (one-line header); only what's happening now stays beside it
  $('#ovSub').textContent = live ? 'Your messaging at a glance: real messages sent from your WhatsApp numbers.' : 'Your messaging at a glance. Demo data: nothing here was really sent.';
  $('#ovLive').innerHTML = `${live ? '' : '<span class="pill">Demo data</span>'}${st.running ? `<span class="pill running">${st.running} sending now</span>` : ''}`;
  $('#seedBtn').classList.toggle('hidden', live || st.hasSeed || !state.settings?.demoAllowed);
  $('#unseedBtn').classList.toggle('hidden', !st.hasSeed);
  renderFilters(st);
  renderSetup(st);
  renderKpis(st);
  renderFunnel(st);
  if (!$('#outModal').classList.contains('hidden')) renderOutModal();
  renderHealth(st);
  renderUpcoming(st);
  renderRecent(st);
  // the chart last: its card shares a row with "Where they ended up", so it's only at its final size once that's in.
  // Drawn earlier, its entrance ran at the old size and then snapped to the new one (a stutter as it settled).
  renderCharts();
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
  // Test campaigns are left out of these numbers; the switch shows only when there are some
  const ft = $('#fTests');
  ft.classList.toggle('hidden', !st.tests && !st.filters.tests);
  if (st.tests || st.filters.tests) ft.innerHTML = `Include tests <span class="opt">${st.tests}</span>${toggleHtml({ checked: st.filters.tests, attrs: 'id="fTestsOn" aria-label="Include test campaigns in these numbers"', size: 'sm' })}`;
  ft.title = st.filters.tests ? 'Test campaigns are counted in these numbers' : `${st.tests} test campaign${st.tests === 1 ? ' is' : 's are'} left out of these numbers`;
  renderRangeBtn(st);
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

// what the Overview asks for: the period (preset or custom), number, template, tests
function statsQuery() {
  const c = state.ov.custom;
  return new URLSearchParams({ range: state.ov.range, ...(c ? { from: c.from, to: c.to } : {}), sender: state.ov.sender, template: state.ov.template, tests: state.ov.tests ? '1' : '' });
}
// The period dropdown: Last 7 / 14 / 30 / 90 days, or a custom range from the calendar
function renderRangeBtn(st) {
  const b = $('#rangeBtn');
  if (!b) return;
  const label = st?.custom ? periodText(st) : `Last ${state.ov.range} days`;
  b.innerHTML = `${icon('calendar-days', 15)}<span>${esc(label)}</span>${icon('chevron-down', 13)}`;
  b.classList.toggle('on', Boolean(state.ov.custom));
  const n = st?.range || state.ov.range;
  b.title = `The period shown. The changes on the cards compare with the ${n} day${n === 1 ? '' : 's'} just before.`;
}
$('#rangeBtn').addEventListener('click', (e) => {
  const b = e.currentTarget, r = b.getBoundingClientRect();
  const custom = state.ov.custom;
  const el = Sheet.Menu.open(r.left, r.bottom + 6, [
    ...[7, 14, 30, 90].map((n) => ({ label: `Last ${n} days`, checked: !custom && state.ov.range === n, action: () => { state.ov.custom = null; state.ov.range = -1; setRange(n); } })),
    '-',
    { label: custom ? `Custom: ${periodText({ custom })}` : 'Custom range…', checked: Boolean(custom), action: () => openCustomRange(b) },
  ]);
  return el;
});
function openCustomRange(b) {
  const was = state.ov.custom;
  DateFilter.open(b, {
    value: was ? { from: was.from, to: was.to } : null,
    onChange: (v) => {
      // a range (or picked days: from the first to the last); cleared → back to the last few days
      const days = v?.days?.slice().sort();
      const next = v?.from ? { from: v.from, to: v.to } : days?.length ? { from: days[0], to: days.at(-1) } : null;
      if (JSON.stringify(next) === JSON.stringify(state.ov.custom)) return;
      state.ov.custom = next;
      saveOv();
      loadOverview().catch((err) => toast(err.message, 'error'));
    },
  });
}

function setRange(n) {
  if (state.ov.range === n && !state.ov.custom) return;
  state.ov.custom = null;
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

$('#fTests').addEventListener('change', (e) => {
  if (e.target.id !== 'fTestsOn') return;
  state.ov.tests = e.target.checked;
  saveOv();
  loadOverview().catch((err) => toast(err.message, 'error'));
});


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
const FEW = 5; // a rate from fewer messages than this is shown as less reliable
const rateOf = (b, m) => (b[m.den] ? (100 * b[m.num]) / b[m.den] : null);
const metricValue = (m, b) => (m.kind === 'count' ? m.of(b) : rateOf(b, m));
const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

const dayLabel = (iso, opts = { month: 'short', day: 'numeric' }) => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, opts);
// The period the Overview shows, in words: "last 14 days", or a custom "Oct 1 – Oct 20"
const periodText = (st) => (st.custom ? (st.custom.from === st.custom.to ? dayLabel(st.custom.from) : `${dayLabel(st.custom.from)} – ${dayLabel(st.custom.to)}`) : `last ${st.range} days`);
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// Daily buckets, or weekly ones (ending today) for the 90-day range.
function makeBuckets(days, range) {
  const lastIdx = days.length - 1;
  if (range < 90) {
    return days.map((d, i) => ({ ...d, key: d.date, label: i === lastIdx && d.date === todayKey() ? 'Today' : dayLabel(d.date), long: dayLabel(d.date, { weekday: 'short', month: 'short', day: 'numeric' }) }));
  }
  const out = [];
  for (let end = days.length; end > 0; end -= 7) {
    const chunk = days.slice(Math.max(0, end - 7), end);
    const b = { key: chunk[0].date, sent: 0, delivered: 0, read: 0, failed: 0, reasons: {} };
    chunk.forEach((d) => { b.sent += d.sent; b.delivered += d.delivered; b.read += d.read; b.failed += d.failed; for (const [k, n] of Object.entries(d.reasons || {})) b.reasons[k] = (b.reasons[k] || 0) + n; });
    b.label = end === days.length && days[days.length - 1].date === todayKey() ? 'This week' : dayLabel(chunk[0].date);
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
  // Counts that grew 10× or more read better as a multiple ("42×, was 19") than as "+4126%".
  const shown = rate ? `${diff >= 0 ? '+' : '−'}${fmt1(Math.abs(diff))} pts`
    : cur >= prev * 10 ? `${Math.round(cur / prev).toLocaleString()}× · was ${prev.toLocaleString()}`
    : `${diff >= 0 ? '+' : '−'}${Math.round(Math.abs(diff))}%`;
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
        <linearGradient id="kf-${key}" gradientUnits="userSpaceOnUse" x1="0" x2="${VW}" y1="0" y2="0">
          <stop offset="${(pts[0][0] / VW).toFixed(4)}" stop-color="#fff" stop-opacity="${pts[0][0] > 1 ? 0 : 1}"/>
          <stop offset="${(Math.min(pts[0][0] + 26, VW) / VW).toFixed(4)}" stop-color="#fff"/>
          <stop offset="${(Math.max(pts[pts.length - 1][0] - 26, 0) / VW).toFixed(4)}" stop-color="#fff"/>
          <stop offset="${(pts[pts.length - 1][0] / VW).toFixed(4)}" stop-color="#fff" stop-opacity="${pts[pts.length - 1][0] < VW - 10 ? 0 : 1}"/>
        </linearGradient>
        <mask id="ke-${key}" maskContentUnits="userSpaceOnUse"><rect width="${VW}" height="${VH}" fill="url(#kf-${key})"/></mask>
        <linearGradient id="kg-${key}" gradientUnits="userSpaceOnUse" x1="0" x2="${VW}" y1="0" y2="0">
          <stop offset="${(pts[0][0] / VW).toFixed(4)}" stop-color="#fff" stop-opacity="${pts[0][0] > 1 ? 0.15 : 1}"/>
          <stop offset="${(Math.min(pts[0][0] + 12, VW) / VW).toFixed(4)}" stop-color="#fff"/>
        </linearGradient>
        <mask id="kl-${key}" maskContentUnits="userSpaceOnUse"><rect x="-10" y="-10" width="${VW + 20}" height="${VH + 20}" fill="url(#kg-${key})"/></mask>
      </defs>
      <g mask="url(#ke-${key})"><path class="ka-fill" d="${area}" fill="url(#kh-${key})" mask="url(#km-${key})"/></g>
      <g mask="url(#kl-${key})"><path class="ka-line" d="${line}" stroke="url(#kh-${key})" vector-effect="non-scaling-stroke"/></g>
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
  const per = st.range >= 90 ? 'Per week' : 'Per day';
  const title = m.kind === 'rate' ? m.label : `${m.label}`;
  const sub = `${per}, ${periodText(st)}${st.filters.sender || st.filters.template ? ' · filtered' : ''}${m.kind === 'rate' ? (m.den === 'sent' ? ' · delivered ÷ sent' : ' · read ÷ delivered') : ''}`;
  // Table view shows every number as a column, so the Sent / rate / Failed tabs have nothing to change there: they
  // step aside, and the header says what the table is.
  const tableView = state.ov.table;
  $('#chartTitle').lastChild.textContent = tableView ? 'Day by day' : title;
  $('#chartSub').textContent = tableView ? `${per}, ${periodText(st)} · every number${st.filters.sender || st.filters.template ? ' · filtered' : ''}` : sub;
  $('#chartTitle').firstElementChild?.replaceWith(document.createRange().createContextualFragment(icon(tableView ? 'table' : m.kind === 'rate' ? 'chart-spline' : 'chart-column-increasing', 18)));
  $('#metricSeg').classList.toggle('hidden', tableView);
  // Table / Chart: an icon button beside Zoom and Expand, showing what a click switches to
  const tb = $('#chartTableBtn'), tl = state.ov.table ? 'Show as chart' : 'Show as table';
  tb.innerHTML = icon(state.ov.table ? 'chart-column-increasing' : 'table', 14);
  tb.title = tl;
  tb.setAttribute('aria-label', tl);
  $('#dayChart').classList.toggle('hidden', state.ov.table);
  $('#dayTable').classList.toggle('hidden', !state.ov.table);
  // the table has its own marks in the header: no legend above it
  // table view: no chart, so no room kept for its key either
  $('#dayLegend').classList.toggle('gone', state.ov.table);
  if (state.ov.table) $('#chartZoomBtn').classList.add('hidden');
  if (state.ov.table) renderChartTable($('#dayTable'), bs);
  else {
    drawChart($('#dayChart'), bs, m, { instant });
    // a rate's key, in the line the stacked charts use for theirs: the period's overall rate, and what the dot sizes
    // and hollow dots mean
    if (m.kind === 'rate') {
      const num = bs.reduce((t, b) => t + (b[m.num] || 0), 0), den = bs.reduce((t, b) => t + (b[m.den] || 0), 0);
      const leg = $('#dayLegend');
      leg.innerHTML = `<span><svg class="rk-line" viewBox="0 0 22 10" width="22" height="10" aria-hidden="true"><path d="M1 7 8 3l6 3 7-5"/><circle cx="8" cy="3" r="2.6"/></svg>${esc(m.label)} <b>${den ? fmt1((100 * num) / den) + '%' : '—'}</b>&nbsp;overall</span>`
        + `<span title="Each dot's size shows how many messages that day's rate is from"><svg class="rk-dot" viewBox="0 0 16 10" width="16" height="10" aria-hidden="true"><circle cx="4" cy="5" r="2.4"/><circle cx="11.5" cy="5" r="4"/></svg>bigger = more messages</span>`
        + `<span title="A day with under ${FEW} messages: one message moves its rate a lot"><svg class="rk-dot few" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="3.4"/></svg>hollow = under ${FEW} messages</span>`;
      leg.classList.remove('hidden');
      const more = leg.scrollWidth > leg.clientWidth + 1;
      leg.classList.toggle('more', more);
      leg.classList.toggle('end', false);
    }
  }

  if (!$('#chartModal').classList.contains('hidden')) {
    $('#xTitle').textContent = title;
    $('#xSub').textContent = sub;
    drawChart($('#xChart'), bs, m, { instant });
    renderChartTable($('#xTable'), bs);
  }
  syncControls();
}

function drawChart(el, bs, m, { instant = false, resize = false } = {}) {
  // any new drawing replaces the pending "finish it" redraw below: that one was for the tab shown before, and firing
  // later it would put that chart back over this one (switching Read rate → Failed quickly showed the rate line)
  clearTimeout(el.__finalT);
  if (!el.offsetParent || !window.d3) return;
  const W = el.clientWidth, H = el.clientHeight;
  if (!W || !H) return;
  // Sent: where each day's messages ended up; Failed: each day's failures by reason (both stacked, drawFlow). The rates
  // stay this chart. Between the two kinds the outgoing one sinks to the line and fades while the other grows in.
  const flow = m === METRICS.sent ? 'sent' : m === METRICS.failed ? 'failed' : null;
  el.classList.toggle('is-flow', Boolean(flow));
  if (flow) return drawFlow(el, bs, { instant, resize, mode: flow, layout: 'stack' });
  if (el.__flow) hideFlow(el, { instant });
  const pad = { l: 42, r: 12, t: 26, b: 28 };
  const base = H - pad.b;
  const isRate = m.kind === 'rate';

  let svg = d3.select(el).select('svg.d3chart');
  const first = svg.empty();
  if (first) {
    // (keep a stacked chart that is still fading out: only the placeholder goes)
    el.querySelectorAll(':scope > :not(svg.fl-svg)').forEach((n) => n.remove());
    el.insertAdjacentHTML('beforeend', '<div class="chart-empty hidden"><div><strong></strong><span></span></div></div>');
    svg = d3.select(el).insert('svg', ':first-child').attr('class', 'd3chart').attr('role', 'img');
    svg.append('g').attr('class', 'grid');
    svg.append('g').attr('class', 'yticks');
    svg.append('g').attr('class', 'cols');
    const ln = svg.append('g').attr('class', 'linelayer').attr('opacity', 0);
    ln.append('path').attr('class', 'bridge');
    ln.append('path').attr('class', 'line');
    ln.append('g').attr('class', 'dots');
    svg.append('line').attr('class', 'crosshair').attr('opacity', 0);
    svg.append('g').attr('class', 'xlabels');
    svg.append('text').attr('class', 'peak').attr('text-anchor', 'middle').attr('opacity', 0);
    svg.append('g').attr('class', 'hits');
    bindChartHover(el);
    // made fresh (e.g. the first switch from the stacked chart to a rate): fade in, as later switches do (style.css)
    if (!instant && !Motion.reduce()) svg.style('opacity', 0).transition().delay(120).duration(300).style('opacity', 1).on('end', () => svg.style('opacity', null));
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
  const dur = instant || Motion.reduce() ? 0 : resize ? 380 : 750; // a resize: a quick glide to the new size

  // If an earlier animation never got to run (e.g. the tab was in the background),
  // finish it now rather than leaving the chart half-drawn.
  clearTimeout(el.__finalT);
  if (!dur) svg.selectAll('*').interrupt();
  else el.__finalT = setTimeout(() => {
    // still on this chart's tab? then finish it (with what's selected now, in case that changed)
    if (document.visibilityState !== 'visible' || METRICS[state.ov.metric] !== m) return;
    drawChart(el, bs, m, { instant: true });
  }, dur + bs.length * 35 + 400);

  const T = (sel, delay = 0) => (dur ? sel.transition().duration(dur).delay(delay).ease(d3.easeCubicOut) : sel);

  // Axis: ticks ride the scale change like a D3 axis.
  const y0 = svg.node().__y || y;
  svg.node().__y = y.copy();
  const clampY = (v) => Math.max(pad.t - 12, Math.min(base, v));
  // (moving and fading run apart: old labels are gone early, new ones arrive late, so two sets never pile up)
  const fadeOut = (s) => s.transition('fade').duration(dur * 0.2).attr('opacity', 0);
  const fadeIn = (s) => (dur ? s.transition('fade').delay(dur * 0.22).duration(dur * 0.35).attr('opacity', 1) : s.interrupt('fade').attr('opacity', 1));
  svg.select('g.grid').selectAll('line').data(ticks, (d) => `${isRate}${d}`).join(
    (enter) => enter.append('line').attr('x1', pad.l).attr('x2', W - pad.r).attr('y1', (d) => clampY(y0(d))).attr('y2', (d) => clampY(y0(d))).attr('opacity', 0)
      .call(fadeIn).call((e) => T(e).attr('y1', (d) => y(d)).attr('y2', (d) => y(d))),
    (update) => update.call(fadeIn).call((u) => T(u).attr('x2', W - pad.r).attr('y1', (d) => y(d)).attr('y2', (d) => y(d))),
    (exit) => exit.call((ex) => (dur ? (fadeOut(ex), T(ex).attr('y1', (d) => clampY(y(d))).attr('y2', (d) => clampY(y(d))).remove()) : ex.remove()))
  );
  svg.select('g.yticks').selectAll('text').data(ticks, (d) => `${isRate}${d}`).join(
    (enter) => enter.append('text').attr('class', 'tick').attr('text-anchor', 'end').attr('x', pad.l - 10).attr('y', (d) => clampY(y0(d)) + 4).text(tickFmt).attr('opacity', 0)
      .call(fadeIn).call((e) => T(e).attr('y', (d) => y(d) + 4)),
    (update) => update.call(fadeIn).call((u) => T(u).attr('y', (d) => y(d) + 4)),
    (exit) => exit.call((ex) => (dur ? (fadeOut(ex), T(ex).attr('y', (d) => clampY(y(d)) + 4).remove()) : ex.remove()))
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
  // Each point knows how many messages its rate is based on: busier days get bigger dots, and days with
  // only a handful (where one message swings the rate a lot) get a hollow dot, so they don't look as solid.
  const nOf = (b) => (isRate ? b[m.den] || 0 : 0);
  const nMax = d3.max(bs, nOf) || 1;
  const rOf = (n) => (n < FEW ? 4 : 4 + 2.5 * Math.sqrt(n / nMax));
  const pts = bs.map((b, i) => ({ x: cx(b), y: isRate && vals[i] != null ? y(vals[i]) : null, key: b.key, i, n: nOf(b) }));
  const prevPts = lineG.node().__pts;
  const sameShape = prevPts && prevPts.length === pts.length;
  const fromPts = pts.map((p, i) => ({ x: p.x, y: sameShape && prevPts[i].y != null ? prevPts[i].y : base }));
  lineG.node().__pts = pts;
  // Straight segments between days next to each other (no smoothing that overshoots), and a faint bridge
  // across days with nothing sent.
  const lineGen = d3.line().defined((p) => p.y != null).x((p) => p.x).y((p) => p.y).curve(d3.curveLinear);
  const real = pts.filter((p) => p.y != null);
  const bridgeP = lineG.select('path.bridge').attr('d', isRate && real.length > 1 ? d3.line().x((p) => p.x).y((p) => p.y)(real) : null);
  if (dur && isRate) bridgeP.attr('opacity', 0).transition().delay(dur * 0.6).duration(dur * 0.6).attr('opacity', 1); else bridgeP.attr('opacity', 1);
  const at = (k) => pts.map((p, i) => ({ x: p.x, y: p.y == null ? null : fromPts[i].y + (p.y - fromPts[i].y) * k }));
  if (!dur || !isRate) {
    lineG.selectAll('path').interrupt();
    lineG.select('path.line').attr('d', lineGen(pts));
  } else {
    lineG.select('path.line').transition().duration(dur).ease(d3.easeCubicOut).attrTween('d', () => (k) => lineGen(at(k)));
  }
  const dots = lineG.select('g.dots').selectAll('circle').data(pts.filter((p) => p.y != null), (p) => p.key)
    .join((enter) => enter.append('circle').attr('r', 4).attr('cx', (p) => p.x).attr('cy', base));
  dots.classed('few', (p) => p.n < FEW);
  T(dots).attr('cx', (p) => p.x).attr('cy', (p) => p.y).attr('r', (p) => rOf(p.n));

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
  el.classList.toggle('chart-is-empty', empty); // no grid lines or y-axis numbers behind the "nothing here" note
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
    const row = (key, mk, label, value) => `<div class="tt-row ${state.ov.metric === key ? 'cur' : ''}"><span><i class="key ${state.ov.metric === key ? '' : 'none'}"></i>${waMark(mk)}${label}</span><b>${value}</b></div>`;
    showTip(`<div class="tt-title">${esc(b.long)} · ${(b.sent + b.failed).toLocaleString()} message${b.sent + b.failed === 1 ? '' : 's'}</div>
      ${row('sent', 'sent', 'Sent', b.sent.toLocaleString())}
      ${row('deliveryRate', 'delivered', 'Delivered', `${b.delivered.toLocaleString()}${dr == null ? '' : ` · ${fmt1(dr)}%`}`)}
      ${row('readRate', 'read', 'Read', `${b.read.toLocaleString()}${rr == null ? '' : ` · ${fmt1(rr)}%`}`)}
      ${row('failed', 'failed', 'Failed', b.failed.toLocaleString())}
      ${isRate && b[m.den] ? `<div class="tt-note ${b[m.den] < FEW ? 'few' : ''}">${b[m.den] < FEW ? `Only ${b[m.den]} message${b[m.den] === 1 ? '' : 's'}, so one message moves this rate a lot` : `${m.short} based on ${b[m.den].toLocaleString()} ${m.den} messages`}</div>` : ''}`, px, py);
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

// The marks people know from WhatsApp, for labelling counts anywhere: one grey tick (sent), two grey ticks (delivered),
// two blue ticks (read), a red ! (failed), an envelope stack for the total.
// A number that rolls to a new value digit by digit, like an odometer: only the digits that change move, up when the
// number grows and down when it shrinks. Used by the campaign results and the Overview's "Where they ended up".
function rollNum(el, value) {
  const text = Number(value || 0).toLocaleString(), old = el.dataset.v ?? '', up = Number(value) >= Number(el.dataset.n ?? value);
  if (text === old) return;
  el.dataset.v = text;
  el.dataset.n = value;
  const prev = [...old];
  el.innerHTML = [...text].map((ch, i, all) => {
    const was = prev[prev.length - (all.length - i)];
    const moved = old !== '' && /\d/.test(ch) && was !== ch;
    return '<span class="cx-d' + (moved ? (up ? ' up' : ' down') : '') + '" style="animation-delay:' + i * 70 + 'ms">' + ch + '</span>';
  }).join('');
  el.setAttribute('aria-label', text);
}

function waMark(kind) {
  const tick = (two, cls = '') => `<svg class="cd-tick ${cls}" viewBox="0 0 16 11" width="15" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${two ? 'M1 5.8 4.2 9 11 1.8M7.6 8.4l.6.6L15 1.8' : 'M1 5.8 4.2 9 11 1.8'}"/></svg>`;
  return `<span class="wa-mk">${{ sent: tick(false), delivered: tick(true), read: tick(true, 'blue'), failed: '<span class="cd-x">!</span>', total: icon('send', 13) }[kind] || ''}</span>`;
}

// The numbers behind the chart. Total = every message tried that day (sent + failed); sent, delivered and read nest
// inside it, which the header marks make clear. A totals row closes the period.
function renderChartTable(el, bs) {
  const pctCell = (v) => (v == null ? '<td class="muted">—</td>' : `<td>${fmt1(v)}%</td>`);
  const n = (v) => v.toLocaleString();
  const sum = bs.reduce((a, b) => ({ sent: a.sent + b.sent, delivered: a.delivered + b.delivered, read: a.read + b.read, failed: a.failed + b.failed }), { sent: 0, delivered: 0, read: 0, failed: 0 });
  const th = (k, label, title) => `<th title="${title}"><span class="th-mk">${waMark(k)}${label}</span></th>`;
  const row = (label, b, cls = '') => `<tr class="${cls}"><td>${label}</td><td>${n(b.sent + b.failed)}</td><td>${n(b.sent)}</td><td>${n(b.delivered)}</td>${pctCell(rateOf(b, METRICS.deliveryRate))}<td>${n(b.read)}</td>${pctCell(rateOf(b, METRICS.readRate))}<td>${n(b.failed)}</td></tr>`;
  el.innerHTML = `<table><thead><tr><th>${bs.length > 20 || state.stats.range === 90 ? 'Week' : 'Day'}</th>${th('total', 'Total', 'Every message tried: sent + failed')}${th('sent', 'Sent', 'Accepted by WhatsApp (one grey tick or more)')}${th('delivered', 'Delivered', 'On their phone (two grey ticks or blue)')}<th>Delivery rate</th>${th('read', 'Read', 'Opened (blue ticks)')}<th>Read rate</th>${th('failed', 'Failed', 'Didn’t reach them')}</tr></thead><tbody>${bs
    .slice()
    .reverse()
    .map((b) => row(esc(b.long), b))
    .join('')}</tbody><tfoot>${row(`Total · ${state.stats?.range || bs.length} days`, sum, 'tt-total')}</tfoot></table>`;
}

// Chart ↔ table: the view going out fades away, the card's height glides to the new size, and the view coming in
// arrives: the table's rows rise in one after another; the chart's columns grow up from the line again (a rate line
// fades in), with the tabs and the key.
let tableSwitching = false; // (not in state.ov: that's saved, and a reload mid-switch would keep the button stuck)
$('#chartTableBtn').addEventListener('click', () => {
  if (tableSwitching) return; // one switch at a time (a double click mid-fade would run it twice)
  const card = $('#chartCard'), toTable = !state.ov.table, reduce = Motion.reduce();
  const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
  const swap = () => {
    const h0 = card.getBoundingClientRect().height;
    state.ov.table = toTable;
    saveOv();
    const host = $('#dayChart');
    if (!toTable && host.__flow) hideFlow(host, { instant: true }); // drawn afresh, so its columns grow in
    renderCharts();
    if (reduce) return;
    const h1 = card.getBoundingClientRect().height;
    if (Math.abs(h1 - h0) > 1) {
      card.style.overflow = 'hidden';
      card.animate([{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: 300, easing: ease }).finished.finally(() => { card.style.overflow = ''; });
    }
    const head = $('#chartTitle').parentElement;
    head.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 260, easing: ease });
    if (toTable) {
      $$('#dayTable thead tr, #dayTable tbody tr, #dayTable tfoot tr').forEach((r, i) => r.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 280, delay: Math.min(i, 16) * 18, easing: ease, fill: 'backwards' }));
    } else {
      $('#metricSeg').animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: ease });
      if (!host.classList.contains('is-flow')) host.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: 80, easing: ease, fill: 'backwards' });
      $('#dayLegend').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 250, easing: ease, fill: 'backwards' });
    }
  };
  if (reduce) return swap();
  // out first, quickly
  tableSwitching = true;
  const out = toTable ? [$('#dayChart'), $('#dayLegend'), $('#metricSeg')] : [$('#dayTable')];
  Promise.all(out.map((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in', fill: 'forwards' }).finished))
    .then(() => { swap(); out.forEach((el) => el.getAnimations().forEach((a) => a.cancel())); })
    .finally(() => { tableSwitching = false; });
});
// Redraw at the new size only when the size really changed: a redraw is instant, and would cut short a chart that is
// still animating (e.g. switching Sent → Failed), which a same-size notification would otherwise do.
{ let lastW = 0, lastH = 0;
  new ResizeObserver(([e]) => { const { width: w, height: hh } = e.contentRect; if (Math.round(w) === lastW && Math.round(hh) === lastH) return; const first = !lastW; lastW = Math.round(w); lastH = Math.round(hh); if (first) return;
    // its room is changing (the sidebar folding, the window resizing): follow it as it goes, a glide at the first
    // change and then every ~90 ms, each going on from where the columns are, and once more when it stops
    const now = performance.now();
    if (!(now - (window.__rsAt || 0) < 90)) { window.__rsAt = now; drawChartsResize(); }
    clearTimeout(window.__rsT); window.__rsT = setTimeout(() => { window.__rsAt = performance.now(); drawChartsResize(); }, 120); }).observe($('#dayChart')); }
function drawChartsResize() {
  if (!state.stats) return;
  const bs = makeBuckets(state.stats.days, state.stats.range), m = METRICS[state.ov.metric];
  drawChart($('#dayChart'), bs, m, { resize: true });
}
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

// --- "Where they ended up", expanded: every day split into what got through (above the line) and what failed (below),
// as shares of the day (default) or counts, beside the period's summary. Pointing at a kind in the summary lights it in
// the chart. Grows out of the card and shrinks back into it, as the main chart's Expand does.
function renderOutModal({ instant = false } = {}) {
  const st = state.stats;
  if (!st) return;
  const share = state.ov.outScale !== 'count';
  $('#oSub').textContent = `Each day, ${periodText(st)}${st.filters.sender || st.filters.template ? ' · filtered' : ''}`;
  $('#oNote').textContent = share
    ? 'Each day as 100%: above the line got through, below it failed. Faint days had only a few messages.'
    : 'Messages each day: above the line got through, below it failed.';
  $$('#oScaleSeg button').forEach((b) => b.classList.toggle('active', (b.dataset.scale === 'share') === share));
  Motion.segs($('#outModal'));
  const chart = $('#oChart');
  drawFlow(chart, makeBuckets(st.days, st.range), { instant, mode: 'sent', layout: 'diverge', share });
  renderFunnel(st, $('#oFunnel'), (k) => (k ? chart.setAttribute('data-kind', k) : chart.removeAttribute('data-kind')));
}
function openOutModal() {
  const modal = $('#outModal'), box = modal.querySelector('.chart-box');
  modal.classList.remove('hidden');
  renderOutModal();
  if (!Motion.reduce()) {
    box.animate(flipFrom(box, $('#funnelCard').getBoundingClientRect()), { duration: 460, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    modal.animate([{ backgroundColor: 'rgba(12, 18, 24, 0)' }, { backgroundColor: getComputedStyle(modal).backgroundColor }], { duration: 300 });
  }
  $('#oClose').focus({ preventScroll: true });
}
function closeOutModal() {
  const modal = $('#outModal');
  if (modal.classList.contains('hidden') || modal.__closing) return;
  hideTip();
  const box = modal.querySelector('.chart-box');
  const done = () => { modal.__closing = false; modal.classList.add('hidden'); };
  if (Motion.reduce()) return done();
  modal.__closing = true;
  box.animate(flipFrom(box, $('#funnelCard').getBoundingClientRect()).reverse(), { duration: 320, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'forwards' }).finished.then(() => {
    box.getAnimations().forEach((a) => a.cancel());
    done();
  });
  modal.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, fill: 'forwards' }).finished.then((a) => a.cancel?.());
}
$('#outExpandBtn').addEventListener('click', openOutModal);
// Bar ↔ pie: the view going out fades, the card settles to the new height, and the one coming in grows in
function syncOutView() {
  const b = $('#outViewBtn'), pie = Boolean(state.ov.outPie), label = pie ? 'Show as a bar' : 'Show as a pie chart';
  b.innerHTML = icon(pie ? 'chart-bar' : 'chart-pie', 14);
  b.title = label;
  b.setAttribute('aria-label', label);
  b.setAttribute('aria-pressed', String(pie));
}
syncOutView();
$('#outViewBtn').addEventListener('click', () => {
  const host = $('#funnel'), card = $('#funnelCard'), st = state.stats;
  if (!st || host.__switching) return;
  const go = () => {
    const h0 = card.getBoundingClientRect().height;
    state.ov.outPie = !state.ov.outPie;
    saveOv();
    syncOutView();
    renderFunnel(st);
    if (Motion.reduce()) return;
    const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
    const h1 = card.getBoundingClientRect().height;
    if (Math.abs(h1 - h0) > 1) { card.style.overflow = 'hidden'; card.animate([{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: 300, easing: ease }).finished.finally(() => { card.style.overflow = ''; }); }
    const top = host.querySelector('.fs-pie, .fs-bar');
    top?.animate(state.ov.outPie ? [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'none' }] : [{ opacity: 0, transform: 'scaleX(0.6)', transformOrigin: 'left' }, { opacity: 1, transform: 'none', transformOrigin: 'left' }], { duration: 380, easing: ease });
    host.querySelectorAll('.fs-row').forEach((r, i) => r.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 120 + i * 40, easing: ease, fill: 'backwards' }));
  };
  if (Motion.reduce()) return go();
  host.__switching = true;
  host.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 130, easing: 'ease-in', fill: 'forwards' }).finished
    .then(() => { go(); host.getAnimations().forEach((a) => a.cancel()); })
    .finally(() => { host.__switching = false; });
});
$('#oClose').addEventListener('click', closeOutModal);
$('#outModal').addEventListener('click', (e) => e.target.id === 'outModal' && closeOutModal());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeOutModal());
$('#oScaleSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-scale]');
  if (!b || state.ov.outScale === b.dataset.scale || (!state.ov.outScale && b.dataset.scale === 'share')) return;
  state.ov.outScale = b.dataset.scale;
  saveOv();
  renderOutModal();
});
new ResizeObserver(() => { if (!$('#outModal').classList.contains('hidden') && state.stats) drawFlow($('#oChart'), makeBuckets(state.stats.days, state.stats.range), { instant: true, mode: 'sent', layout: 'diverge', share: state.ov.outScale !== 'count' }); }).observe($('#oChart'));

// --- Funnel ---

// "Messages sent", day by day, stacked: one column per day (or week), built from where that day's messages ended up.
// Above the line, from the bottom: read (darkest), delivered but not read, sent but not delivered yet; below it, what
// failed. The same pieces and colours as a campaign's Results bar (style.css --cx-*). Drawn into the main chart when its
// Sent tab is on (drawChart hands over), with the main chart's axis and the app's hover rule: the column nearest the
// pointer is outlined, the rest fade, the shared tooltip shows; moving off clears it.
const FLOW = [
  ['read', (b) => b.read],
  ['delivered', (b) => b.delivered - b.read],
  ['sent', (b) => b.sent - b.delivered],
];
// Failed, by reason: the period's biggest reasons, each a strength of the app's danger red, and the rest as Other.
const REASON_SHADES = [100, 72, 50, 34];
function reasonLabel(code) {
  if (code === 'other') return 'Other reasons';
  const e = window.MetaErrors?.byCode[code];
  return e ? e.title : 'Meta error ' + code;
}
function topReasons(bs) {
  const sum = {};
  for (const b of bs) for (const [k, n] of Object.entries(b.reasons || {})) sum[k] = (sum[k] || 0) + n;
  const all = Object.entries(sum).sort((a, b) => b[1] - a[1]);
  const top = all.filter(([k]) => k !== 'other').slice(0, REASON_SHADES.length).map(([k]) => k);
  return { top, hasOther: all.some(([k]) => !top.includes(k)) };
}
const reasonFill = (id, top) => (id === 'other' ? 'var(--faint)' : `color-mix(in srgb, var(--cx-failed) ${REASON_SHADES[top.indexOf(id)] ?? 30}%, var(--surface))`);

function drawFlow(host, bs, { instant = false, resize = false, mode = 'sent', layout = 'diverge', share = false } = {}) {
  host.__redraw = () => drawFlow(host, bs, { mode, layout, share });
  host.__flow = bs;
  host.__flowMode = mode;
  host.__flowShare = share;
  if (!window.d3 || !host.clientWidth) return;
  host.classList.add('fl-host');
  // the loading placeholder (data-skel) goes once there is something to draw, as the main chart does
  host.querySelectorAll(':scope > :not(svg):not(.chart-empty):not(.fl-zoom)').forEach((n) => n.remove());
  host.removeAttribute('data-skel');
  const W = host.clientWidth, H = host.clientHeight || 260, pad = { l: 42, r: 12, t: 26, b: 28 };
  // Nothing in the period: no axis, just what this chart will show and the way to get there.
  const nothing = !bs.some((b) => (mode === 'failed' ? b.failed : b.sent + b.failed));
  host.classList.toggle('fl-none', nothing);
  if (nothing) {
    d3.select(host).select('svg.fl-svg').remove();
    host.__flY = null;
    host.__spike = null; zoomButton(host);
    host.__flowX = null;
    let em = host.querySelector('.fl-empty');
    if (!em) { em = document.createElement('div'); em.className = 'fl-empty'; host.append(em); }
    const days = bs.length > 20 ? 'this period' : `the last ${bs.length} days`;
    em.innerHTML = mode === 'failed'
      ? `<span class="fl-empty-ic ok">${icon('circle-check', 20)}</span><b>Nothing failed in ${days}</b><span>Failures show up here day by day, grouped by Meta’s reason.</span>`
      : `<span class="fl-empty-ic">${icon('send', 20)}</span><b>Nothing sent in ${days}</b><span>Each day’s messages show up here as they go out: read, delivered, sent and failed.</span><button type="button" class="btn sm primary" data-goto="send">${icon('plus', 14)}New campaign</button>`;
    const leg = host.id === 'dayChart' ? $('#dayLegend') : host.id === 'xChart' ? $('#xLegend') : null;
    leg?.classList.add('hidden');
    return;
  }
  host.querySelector('.fl-empty')?.remove();
  const R = mode === 'failed' ? topReasons(bs) : null;
  host.__flowReasons = R;
  // Layouts: 'stack' puts failed on top, so a column is everything tried that day (the main chart); 'diverge' puts what
  // got through above the line and what failed below it (the "Where they ended up" Expand). Share: each day as 100%.
  const below = mode !== 'failed' && layout === 'diverge';
  const tried = (b) => b.sent + b.failed;
  const unit = (b) => (share ? (tried(b) ? 100 / tried(b) : 0) : 1); // a message's height in the scale's units
  const upOf = (b) => (mode === 'failed' ? b.failed : below ? b.sent : tried(b)) * unit(b);
  const downOf = (b) => (below ? b.failed * unit(b) : 0);
  // A spike (one day far above the rest) flattens every other day. The scale stays true by default; a line above the
  // chart offers to zoom in on the usual days, and then a spike runs off the chart (fading out) with its real total.
  // Share never needs it.
  const capOf = (vals) => {
    const nz = vals.filter((v) => v > 0).sort((a, b) => a - b);
    if (share || nz.length < 3) return 0;
    const q = nz[Math.floor((nz.length - 1) * 0.75)], usual = nz.filter((v) => v <= q * 4).at(-1) || q;
    return nz.at(-1) > Math.max(usual * 3, q * 4) ? usual : 0;
  };
  const spikeUp = capOf(bs.map(upOf)), spikeDown = capOf(bs.map(downOf));
  const zoom = Boolean(host.__zoom && (spikeUp || spikeDown));
  const capUp = zoom ? spikeUp : 0, capDown = zoom ? spikeDown : 0;
  const maxUp = share && mode !== 'failed' ? 100 : Math.max(1, capUp || Math.max(...bs.map(upOf)));
  const maxDown = below ? capDown || Math.max(0, ...bs.map(downOf)) : 0;
  const y = d3.scaleLinear().domain([0, maxUp]).nice(4);
  // One scale for both sides, so a day's failures read true against what got through; below the line is just enough
  // room for the worst day's failures (at least a sliver).
  const usable = H - pad.t - pad.b, top = y.domain()[1];
  const down = maxDown ? Math.max(16, (usable * maxDown) / (top + maxDown)) : 8;
  const base = pad.t + usable - down;
  y.range([base, pad.t]);
  const k = (base - pad.t) / top;
  const cutUp = (b) => Boolean(capUp) && upOf(b) > top, cutDown = (b) => below && Boolean(capDown) && downOf(b) > capDown;
  // days with only a handful of messages, faint in Share (1 of 2 failing isn't 50% of anything that matters)
  const busy = bs.map(tried).filter((v) => v > 0).sort((a, b) => a - b);
  const few = share ? Math.max(3, (busy[Math.floor(busy.length / 2)] || 0) * 0.1) : 0;
  const x = d3.scaleBand().domain(bs.map((b) => b.key)).range([pad.l, W - pad.r]).paddingInner(bs.length > 20 ? 0.3 : 0.38).paddingOuter(0.15);
  const bw = x.bandwidth(), GAP = 2, dur = instant || Motion.reduce() ? 0 : resize ? 380 : 750; // resize: a quick glide
  let svg = d3.select(host).select('svg.fl-svg');
  // back before it had finished leaving (a quick switch away and back): call off its exit and bring it back in full
  if (!svg.empty() && svg.classed('leaving')) {
    svg.interrupt().classed('leaving', false).style('opacity', 1);
    svg.selectAll('.yticks, .grid, .fl-x, .fl-cuts').interrupt().style('opacity', null);
  }
  if (svg.empty()) {
    svg = d3.select(host).append('svg').attr('class', 'fl-svg').attr('role', 'img');
    svg.append('g').attr('class', 'grid');
    svg.append('g').attr('class', 'yticks');
    svg.append('line').attr('class', 'fl-base');
    svg.append('g').attr('class', 'fl-cols');
    svg.append('g').attr('class', 'fl-cuts');
    // fades for a column that runs off the chart: out at the top (or, below the line, at the bottom)
    const defs = svg.append('defs');
    for (const [dir, stops] of [['up', [[0, 0], [0.22, 1]]], ['down', [[0.78, 1], [1, 0]]], ['both', [[0, 0], [0.18, 1], [0.82, 1], [1, 0]]]]) {
      const g = defs.append('linearGradient').attr('id', `flFadeG-${dir}-${host.id}`).attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', 1);
      for (const [o, a] of stops) g.append('stop').attr('offset', o).attr('stop-color', '#fff').attr('stop-opacity', a);
      defs.append('mask').attr('id', `flFade-${dir}-${host.id}`).attr('maskContentUnits', 'objectBoundingBox')
        .append('rect').attr('width', 1).attr('height', 1).attr('fill', `url(#flFadeG-${dir}-${host.id})`);
    }
    svg.append('rect').attr('class', 'fl-ring').attr('opacity', 0);
    svg.append('g').attr('class', 'fl-x');
    bindFlowHover(host);
    if (dur) svg.style('opacity', 0).transition().delay(120).duration(260).style('opacity', 1);
  }
  svg.attr('viewBox', `0 0 ${W} ${H}`).attr('width', W).attr('height', H).attr('aria-label', 'Messages per day: read, delivered, sent and failed');
  const ticks = y.ticks(4).filter(Number.isInteger);
  // Axis: the gridlines and numbers ride the scale change with the columns (as the rate chart's do): a value on both
  // scales slides to its new place, a new one fades in from where it would have been, an old one slides off and fades.
  const TA = (sel) => (dur ? sel.transition().duration(dur).ease(d3.easeCubicOut) : sel.interrupt());
  const y0 = host.__flY || y;
  host.__flY = y.copy();
  const clampY = (v) => Math.max(pad.t - 12, Math.min(base, v));
  const tkey = (v) => (share ? '%' : '') + v;
  // fading runs apart from moving (named transitions): an old label is gone in the first third, a new one appears
  // in the last half, so two sets of numbers never pile up mid-way
  const fadeOut = (s) => s.transition('fade').duration(dur * 0.2).attr('opacity', 0);
  const fadeIn = (s) => (dur ? s.transition('fade').delay(dur * 0.22).duration(dur * 0.35).attr('opacity', 1) : s.interrupt('fade').attr('opacity', 1));
  svg.select('.grid').selectAll('line').data(ticks, tkey).join(
    (enter) => enter.append('line').attr('x1', pad.l).attr('x2', W - pad.r).attr('y1', (v) => clampY(y0(v))).attr('y2', (v) => clampY(y0(v))).attr('opacity', 0).call(fadeIn),
    (update) => update.call(fadeIn),
    (exit) => (dur ? exit.call(fadeOut).transition().duration(dur).ease(d3.easeCubicOut).attr('y1', (v) => clampY(y(v))).attr('y2', (v) => clampY(y(v))).remove() : exit.remove()),
  ).call((s) => TA(s).attr('x1', pad.l).attr('x2', W - pad.r).attr('y1', (v) => y(v)).attr('y2', (v) => y(v)));
  svg.select('.yticks').selectAll('text').data(ticks, tkey).join(
    (enter) => enter.append('text').attr('class', 'tick').attr('x', pad.l - 10).attr('text-anchor', 'end').attr('y', (v) => clampY(y0(v)) + 4).attr('opacity', 0).call(fadeIn),
    (update) => update.call(fadeIn),
    (exit) => (dur ? exit.call(fadeOut).transition().duration(dur).ease(d3.easeCubicOut).attr('y', (v) => clampY(y(v)) + 4).remove() : exit.remove()),
  ).text((v) => fmtNum(v) + (share ? '%' : '')).call((s) => TA(s).attr('x', pad.l - 10).attr('y', (v) => y(v) + 4));
  const bl = svg.select('.fl-base');
  if (bl.attr('y1') == null) bl.attr('y1', base + 0.5).attr('y2', base + 0.5);
  TA(bl).attr('x1', pad.l).attr('x2', W - pad.r).attr('y1', base + 0.5).attr('y2', base + 0.5);
  const parts = mode === 'failed'
    ? [...R.top.map((code) => [code, (b) => b.reasons?.[code] || 0]), ...(R.hasOther ? [['other', (b) => b.failed - R.top.reduce((s, c) => s + (b.reasons?.[c] || 0), 0)]] : [])]
    : below ? FLOW : [...FLOW, ['failed', (b) => b.failed]];
  const pieces = (b, i) => {
    const out = [];
    // a cut column fills to the top edge, its pieces in their true proportions
    const ku = cutUp(b) ? (base - pad.t - (parts.length - 1) * GAP) / upOf(b) : k;
    const kd = cutDown(b) ? (down - GAP - 2) / downOf(b) : k;
    let yy = base - GAP / 2;
    for (const [id, f] of parts) { const v = f(b) * unit(b), hh = Math.max(3, v * ku); if (v > 0) { out.push({ id, i, y: yy - hh, h: hh }); yy -= hh + GAP; } }
    if (below && b.failed) out.push({ id: 'failed', i, y: base + GAP / 2 + 1, h: Math.max(3, downOf(b) * kd) });
    return out;
  };
  const cols = svg.select('.fl-cols').selectAll('g.fl-col').data(bs, (b) => b.key).join((enter) => enter.append('g').attr('class', 'fl-col')).attr('data-i', (b, i) => i)
    .classed('fl-few', (b) => share && tried(b) > 0 && tried(b) < few)
    .attr('mask', (b) => { const d = cutUp(b) && cutDown(b) ? 'both' : cutUp(b) ? 'up' : cutDown(b) ? 'down' : null; return d && `url(#flFade-${d}-${host.id})`; });
  cols.each(function (b, i) {
    const r = d3.select(this).selectAll('rect').data(pieces(b, i), (p) => mode + ':' + p.id)
      .join(
        // a new piece starts on the line in its place; one already drawn slides there with the rest (the chart's
        // room changing: the columns move sideways as one with the axis, no snap)
        (enter) => enter.append('rect').attr('rx', 3).attr('y', base).attr('height', 0).attr('x', x(b.key)).attr('width', bw),
        (update) => update,
        // pieces of the other mode, or a reason that's gone: back down to the line, then out
        (exit) => (dur ? exit.transition().duration(dur / 2).ease(d3.easeCubicIn).attr('y', base).attr('height', 0).remove() : exit.remove()),
      )
      .attr('data-sw', (p) => (mode === 'failed' ? null : p.id)).style('fill', (p) => (mode === 'failed' ? reasonFill(p.id, R.top) : null));
    // (an instant redraw stops an entrance still running, or it would carry on to the old size)
    (dur ? r.transition().duration(dur).delay(resize ? 0 : i * Math.min(30, 400 / bs.length)).ease(d3.easeCubicOut) : r.interrupt())
      .attr('x', x(b.key)).attr('width', bw).attr('y', (p) => p.y).attr('height', (p) => p.h);
  });
  // zoomed in: the real total above a column that runs off the top
  const cuts = bs.filter(cutUp).map((b) => ({ key: b.key, b }));
  const cg = svg.select('.fl-cuts').selectAll('text.fl-cut-n').data(cuts, (c) => c.key)
    .join((enter) => enter.append('text').attr('class', 'fl-cut-n').attr('opacity', 0));
  cg.attr('x', (c) => x(c.b.key) + bw / 2).attr('y', pad.t - 12).attr('text-anchor', 'middle')
    .text((c) => fmtNum(mode === 'failed' ? c.b.failed : below ? c.b.sent : tried(c.b)));
  (dur ? cg.transition().delay(dur * 0.8).duration(250) : cg.interrupt()).attr('opacity', 1);
  host.__cut = (b) => cutUp(b) || cutDown(b);
  // the days that would run off the chart when zoomed in (fitted to the usual days); the zoom button in the card's
  // header shows only when there are some
  const fitUp = spikeUp && d3.scaleLinear().domain([0, spikeUp]).nice(4).domain()[1];
  const big = spikeUp || spikeDown ? bs.filter((b) => (spikeUp && upOf(b) > fitUp) || (spikeDown && downOf(b) > spikeDown)) : [];
  host.__spike = big.length ? (big.length === 1 ? big[0].long.replace(/^\w+, /, '') : big.length + ' days') : null;
  host.__zoomed = zoom;
  host.__big = new Set(big.map((b) => b.key));
  zoomButton(host);
  const every = Math.max(1, Math.ceil((bs.length * 64) / (W - pad.l - pad.r)));
  // day labels: slide to their new places; new days fade in, gone ones fade out
  svg.select('.fl-x').selectAll('text').data(bs, (b) => b.key).join(
    (enter) => enter.append('text').attr('class', 'tick').attr('text-anchor', 'middle').attr('x', (b) => x(b.key) + bw / 2).attr('opacity', 0),
    (update) => update,
    (exit) => (dur ? exit.transition().duration(dur / 2).attr('opacity', 0).remove() : exit.remove()),
  ).attr('y', H - 8).text((b, i) => ((bs.length - 1 - i) % every === 0 ? b.label : ''))
    .call((s) => TA(s).attr('x', (b) => x(b.key) + bw / 2).attr('opacity', 1));
  host.__flowX = { x, bw };
  flowLegend(host, mode, bs, R);
}
// Zoom past a spike: a quiet button in the chart's header ("Fit small days" / "Show all"), there only when a day
// dwarfs the rest; double-clicking the chart does the same.
const ZOOM_BTN = { dayChart: 'chartZoomBtn', xChart: 'xZoomBtn', oChart: 'oZoomBtn' };
function zoomButton(host) {
  const b = document.getElementById(ZOOM_BTN[host.id]);
  if (!b) return;
  const show = Boolean(host.__spike) && !host.classList.contains('hidden');
  b.classList.toggle('hidden', !show);
  if (!show) return;
  const label = host.__zoomed ? 'Show all' : 'Fit small days';
  // the card's header is tight: just the magnifier there (its label in the tooltip), words in the expanded views
  b.innerHTML = icon(host.__zoomed ? 'zoom-out' : 'zoom-in', 14) + (b.classList.contains('icon-only') ? '' : label);
  b.setAttribute('aria-label', label);
  b.setAttribute('aria-pressed', String(Boolean(host.__zoomed)));
  b.removeAttribute('title'); // the card below explains it instead of the browser's plain tooltip
}
// What the zoom button does, in the shared chart tooltip, under the button: what it is, and what a click will do.
function zoomTipHtml(host) {
  const who = esc(host.__spike), one = !/ days$/.test(host.__spike);
  return host.__zoomed
    ? `<div class="tt-title">${icon('zoom-out', 13)} Show all days</div><div class="tt-body">Zoomed in on the smaller days: ${who} ${one ? 'runs' : 'run'} off the top of the chart, with ${one ? 'its total' : 'their totals'} above.</div><div class="tt-note">Click to go back to the full scale.</div>`
    : `<div class="tt-title">${icon('zoom-in', 13)} Fit small days</div><div class="tt-body">${who} ${one ? 'is' : 'are'} much bigger than the other days, so they’re hard to see.</div><div class="tt-note">Click to fit the scale to the smaller days. ${who} will run off the top, with ${one ? 'its total' : 'their totals'} shown. Double-clicking the chart does the same.</div>`;
}
function showBtnTip(btn, html) {
  const tip = $('#chartTip');
  clearTimeout(tip.__hideT);
  tip.innerHTML = html;
  tip.classList.remove('hidden');
  const r = btn.getBoundingClientRect(), w = tip.offsetWidth, vw = document.documentElement.clientWidth;
  tip.style.left = Math.max(12, Math.min(r.right - w, vw - w - 12)) + 'px';
  tip.style.top = r.bottom + 8 + 'px';
}
function toggleZoom(host) {
  if (!host.__spike || !host.__redraw) return;
  hideTip();
  host.__zoom = !host.__zoomed;
  host.__redraw();
}
for (const [h, b] of Object.entries(ZOOM_BTN)) {
  const btn = document.getElementById(b), host = document.getElementById(h);
  btn?.addEventListener('click', () => { toggleZoom(host); if (btn.matches(':hover')) showBtnTip(btn, zoomTipHtml(host)); });
  btn?.addEventListener('pointerenter', () => host.__spike && showBtnTip(btn, zoomTipHtml(host)));
  btn?.addEventListener('focus', () => host.__spike && showBtnTip(btn, zoomTipHtml(host)));
  btn?.addEventListener('pointerleave', hideTip);
  btn?.addEventListener('blur', hideTip);
  document.getElementById(h)?.addEventListener('dblclick', (e) => { if (e.target.closest('svg.fl-svg')) { e.preventDefault(); toggleZoom(document.getElementById(h)); } });
}

// The key under the main chart: the four outcomes with their marks, or the failure reasons, each with its total.
function flowLegend(host, mode, bs, R) {
  const leg = host.id === 'dayChart' ? $('#dayLegend') : host.id === 'xChart' ? $('#xLegend') : null;
  if (!leg) return;
  const sum = (f) => bs.reduce((s, b) => s + f(b), 0);
  const item = (sw, fill, mk, label, n) => '<span><i class="cx-sw"' + (sw ? ' data-sw="' + sw + '"' : '') + (fill ? ' style="background:' + fill + '"' : '') + '></i>' + mk + esc(label) + ' <b>(' + n.toLocaleString() + ')</b></span>';
  leg.innerHTML = mode === 'failed'
    ? [...R.top, ...(R.hasOther ? ['other'] : [])].map((code) => item('', reasonFill(code, R.top), '', reasonLabel(code), code === 'other' ? sum((b) => b.failed - R.top.reduce((s, c) => s + (b.reasons?.[c] || 0), 0)) : sum((b) => b.reasons?.[code] || 0))).join('')
    : [['read', 'Read', (b) => b.read], ['delivered', 'Delivered', (b) => b.delivered - b.read], ['sent', 'Sent', (b) => b.sent - b.delivered], ['failed', 'Failed', (b) => b.failed]]
      .map(([sw, l, f]) => [sw, l, sum(f)]).filter(([, , n]) => n).map(([sw, l, n]) => item(sw, '', waMark(sw), l, n)).join('');
  leg.classList.remove('hidden');
  // longer than the card: a fade on the side there's more on (it scrolls sideways)
  const edges = () => { const more = leg.scrollWidth > leg.clientWidth + 1; leg.classList.toggle('more', more); leg.classList.toggle('end', more && leg.scrollLeft + leg.clientWidth >= leg.scrollWidth - 2); };
  edges();
  if (!leg.__edges) { leg.__edges = true; leg.addEventListener('scroll', edges, { passive: true }); }
}
function hideFlow(host, { instant = false } = {}) {
  host.querySelector('.fl-empty')?.remove();
  host.classList.remove('fl-none');
  const svg = d3.select(host).select('svg.fl-svg');
  host.classList.remove('fl-host', 'hovering');
  host.__flow = null;
  host.__flY = null;
  host.__spike = null; zoomButton(host);
  const leg = host.id === 'dayChart' ? $('#dayLegend') : host.id === 'xChart' ? $('#xLegend') : null;
  leg?.classList.add('hidden');
  if (svg.empty()) return;
  if (instant || Motion.reduce()) return svg.remove();
  const base = Number(svg.select('.fl-base').attr('y1')) || 0;
  // its axis goes at once (the incoming chart brings its own), its columns sink to the line, then it's gone
  svg.selectAll('.yticks, .grid, .fl-x, .fl-cuts').interrupt().transition().duration(120).style('opacity', 0);
  svg.classed('leaving', true).selectAll('.fl-col rect').interrupt().transition().duration(240).ease(d3.easeCubicIn).attr('y', base).attr('height', 0);
  svg.transition().duration(280).style('opacity', 0).remove();
}

function bindFlowHover(host) {
  const clear = () => { host.classList.remove('hovering'); host.querySelectorAll('.fl-col.on').forEach((c) => c.classList.remove('on')); d3.select(host).select('.fl-ring').attr('opacity', 0); hideTip(); };
  host.addEventListener('pointermove', (e) => {
    const bs = host.__flow, g = host.__flowX;
    if (!bs || !g || !e.target.closest('svg.fl-svg')) return;
    // the column nearest the pointer, anywhere across the chart, gaps included
    const px = e.clientX - host.getBoundingClientRect().left;
    let i = 0, best = Infinity;
    bs.forEach((b, j) => { const d = Math.abs(g.x(b.key) + g.bw / 2 - px); if (d < best) { best = d; i = j; } });
    const b = bs[i];
    host.classList.add('hovering');
    host.querySelectorAll('.fl-col').forEach((c) => c.classList.toggle('on', Number(c.dataset.i) === i));
    const box = host.querySelectorAll('.fl-col')[i]?.getBBox();
    if (box?.height) d3.select(host).select('.fl-ring').attr('x', box.x - 4).attr('y', box.y - 4).attr('width', box.width + 8).attr('height', box.height + 8).attr('rx', 7).attr('opacity', 1);
    else d3.select(host).select('.fl-ring').attr('opacity', 0);
    if (host.__flowMode === 'failed') {
      const R = host.__flowReasons, codes = [...R.top, ...(R.hasOther ? ['other'] : [])];
      const n = (code) => (code === 'other' ? b.failed - R.top.reduce((s, c) => s + (b.reasons?.[c] || 0), 0) : b.reasons?.[code] || 0);
      return showTip('<div class="tt-title">' + esc(b.long) + ' · ' + b.failed.toLocaleString() + ' failed</div>' +
        codes.filter((c) => n(c)).map((c) => '<div class="tt-row cur"><span><i class="cx-sw" style="background:' + reasonFill(c, R.top) + '"></i>' + esc(reasonLabel(c)) + (c !== 'other' ? ' <code class="tt-code">' + c + '</code>' : '') + '</span><b>' + n(c).toLocaleString() + '</b></div>').join('') +
        (b.failed ? '' : '<div class="tt-note">Nothing failed this day.</div>'), e.clientX, e.clientY);
    }
    const all = b.sent + b.failed, pc = (v) => (host.__flowShare && all ? ' <small>' + fmt1((100 * v) / all) + '%</small>' : '');
    const row = (sw, label, v) => '<div class="tt-row cur"><span><i class="cx-sw" data-sw="' + sw + '"></i>' + waMark(sw) + label + '</span><b>' + v.toLocaleString() + pc(v) + '</b></div>';
    showTip('<div class="tt-title">' + esc(b.long) + ' · ' + (b.sent + b.failed).toLocaleString() + ' tried</div>' +
      row('read', 'Read', b.read) + row('delivered', 'Delivered, not read', b.delivered - b.read) + row('sent', 'Sent, not delivered', b.sent - b.delivered) + row('failed', 'Failed', b.failed) +
      (host.__cut?.(b) ? '<div class="tt-note">Goes off the chart while zoomed in.</div>'
        : host.__spike && !host.__zoomed && !host.__big?.has(b.key) ? '<div class="tt-note">Small days are hard to see next to ' + esc(host.__spike) + '. Use the zoom button above, or double-click the chart.</div>' : ''), e.clientX, e.clientY);
  });
  host.addEventListener('pointerleave', clear);
}

// The period at a glance, beside the chart: the total, one bar split by where messages ended up, and a row per piece
// with its mark, count and share. Pointing at a piece or a row lights it (the app's hover rule).
function renderFunnel(st, el = $('#funnel'), onLight = null) {
  const t = st.totals, total = t.sent + t.failed;
  const sub = `Where messages ended up · ${periodText(st)}${st.filters.sender || st.filters.template ? ' · filtered' : ''}`;
  if (el.id === 'funnel') $('#funnelSub').textContent = sub;
  $('#outExpandBtn')?.toggleAttribute('disabled', !total);
  if (!total) {
    const guide = [['read', 'Read', 'They opened it: two blue ticks'], ['delivered', 'Delivered', 'On their phone: two grey ticks'], ['sent', 'Sent', 'WhatsApp accepted it: one grey tick'], ['failed', 'Failed', 'It didn’t reach them, with Meta’s reason']];
    el.innerHTML = '<div class="fs fs-none"><div class="fl-figure"><b class="fl-num">0</b><span>messages tried</span></div><div class="fs-bar fs-bar-empty"></div>' +
      '<div class="fs-rows">' + guide.map(([k, l, what]) => '<div class="fs-row"><i class="cx-sw" data-sw="' + k + '"></i>' + waMark(k) + '<span class="fs-l"><b>' + l + '</b><small>' + what + '</small></span><span class="fs-n"><b>0</b></span></div>').join('') + '</div>' +
      '<p class="sub fs-hint">Send a campaign and this fills in: where every message ended up.</p></div>';
    return;
  }
  const parts = [
    ['read', 'Read', t.read, 'Opened (blue ticks)'],
    ['delivered', 'Delivered', t.delivered - t.read, 'On their phone, not opened yet'],
    ['sent', 'Sent', t.sent - t.delivered, 'Accepted, phone not reached yet'],
    ['failed', 'Failed', t.failed, 'Didn’t reach them'],
  ].filter(([, , n]) => n > 0);
  const pct = (n) => (100 * n / total).toFixed(n / total < 0.1 ? 1 : 0) + '%';
  const r = (i) => { const a = i === 0 ? 6 : 2, z = i === parts.length - 1 ? 6 : 2; return a + 'px ' + z + 'px ' + z + 'px ' + a + 'px'; };
  // Bar or pie (the card's switch, on the Overview only): the pie is a ring with the number in its middle
  const pie = el.id === 'funnel' && state.ov.outPie;
  el.innerHTML = '<div class="fs' + (pie ? ' fs-is-pie' : '') + '">' +
    (pie
      ? '<div class="fs-pie"><svg viewBox="-90 -90 180 180" aria-hidden="true"></svg><div class="fs-pie-mid"><b class="fl-num cx-num"></b><span class="fl-of"></span></div></div>'
      : '<div class="fl-figure"><b class="fl-num cx-num"></b><span class="fl-of"></span></div>' +
        '<div class="cx-bar fs-bar">' + parts.map(([k, , n], i) => '<i class="cx-seg" data-kind="' + k + '" data-sw="' + k + '" style="flex-grow:' + n + ';border-radius:' + r(i) + '"></i>').join('') + '</div>') +
    '<div class="fs-rows">' + parts.map(([k, l, n, what]) => '<div class="fs-row" data-kind="' + k + '"><i class="cx-sw" data-sw="' + k + '"></i>' + waMark(k) + '<span class="fs-l"><b>' + l + '</b><small>' + what + '</small></span><span class="fs-n"><b>' + n.toLocaleString() + '</b><small>' + pct(n) + '</small></span></div>').join('') + '</div>' +
    (t.pending ? '<div class="fl-foot">Waiting to send <b>' + t.pending.toLocaleString() + '</b></div>' : '') + '</div>';
  const fs = el.querySelector('.fs'), big = fs.querySelector('.fl-num'), of = fs.querySelector('.fl-of');
  const byKind = Object.fromEntries(parts.map(([k, l, n]) => [k, { l, n }]));
  if (pie && window.d3) {
    // the ring: a slice per outcome in the bar's order (clockwise from the top), small gaps between, round ends;
    // it sweeps round when drawn; a hovered slice stands out a little
    const arc = d3.arc().innerRadius(58).outerRadius(84).cornerRadius(3).padAngle(parts.length > 1 ? 0.025 : 0);
    const big2 = d3.arc().innerRadius(58).outerRadius(88).cornerRadius(3).padAngle(parts.length > 1 ? 0.025 : 0);
    const slices = d3.pie().sort(null).value((p) => p[2])(parts);
    const paths = d3.select(fs.querySelector('.fs-pie svg')).selectAll('path').data(slices).join('path')
      .attr('class', 'fs-arc').attr('data-kind', (d) => d.data[0]).attr('data-sw', (d) => d.data[0]);
    if (Motion.reduce()) paths.attr('d', arc);
    else paths.transition().duration(700).delay((d, i) => i * 60).ease(d3.easeCubicOut).attrTween('d', (d) => { const i = d3.interpolate({ ...d, endAngle: d.startAngle }, d); return (t) => arc(i(t)); });
    fs.__grow = (k) => paths.transition('hover').duration(180).attr('d', (d) => (d.data[0] === k ? big2(d) : arc(d)));
  }
  // hovering a piece of the bar or a row rolls the big number to that kind's count, as on a campaign's results
  const light = (k) => {
    if (fs.dataset.hot === (k || '') && fs.dataset.lit) return;
    fs.dataset.hot = k || ''; fs.dataset.lit = '1';
    fs.classList.toggle('hovering', Boolean(k));
    fs.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('on', x.dataset.kind === k));
    rollNum(big, k ? byKind[k].n : total);
    fs.__grow?.(k);
    of.innerHTML = k ? '<span class="cx-of-k">' + waMark(k) + esc(byKind[k].l) + '</span><span class="cx-of-pct">' + pct(byKind[k].n) + ' of ' + total.toLocaleString() + '</span>' : 'messages tried';
    onLight?.(k);
  };
  light(null);
  fs.addEventListener('pointermove', (e) => light(e.target.closest('[data-kind]')?.dataset.kind || null));
  fs.addEventListener('pointerleave', () => light(null));
}

// --- Number health ---

// Compact "how long ago" for tight spots: now, 5m, 3h, 2d, 3w, then the date. (Full date goes in a tooltip.)
function shortAgo(ts) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  if (m < 10080) return `${Math.round(m / 1440)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
// 'TIER_2K' → '2,000 people / 24h' (the whole business portfolio shares it).
function tierText(tier) {
  if (tier === 'TIER_UNLIMITED') return 'Unlimited';
  const m = /^TIER_(\d+)(K)?$/.exec(tier || '');
  return m ? `${(Number(m[1]) * (m[2] ? 1000 : 1)).toLocaleString()} people / 24h` : tier;
}

// Meta's quality rating as a small tag, in the words WhatsApp Manager uses (High / Medium / Low).
// Hovering (or focusing) the tag opens a card: why it's at this level, what that means, and what to do.
// Meta rates a number from how people reacted to its messages over roughly the last 7 days.
const QUALITY = {
  GREEN: {
    label: 'High', cls: 'good',
    why: 'Few people blocked or reported this number over the last 7 days. People are responding well.',
    means: 'No restrictions. This is the level Meta wants to see before it raises your messaging limit.',
    todo: 'Keep messaging people who opted in, and keep messages relevant and not too frequent.',
  },
  YELLOW: {
    label: 'Medium', cls: 'warn',
    why: 'More people than usual blocked or reported this number, or marked its messages as spam, over the last 7 days.',
    means: 'A warning. Nothing is restricted yet, but if it keeps dropping to Low, Meta can restrict the number.',
    todo: 'Slow down campaigns, send only to people who opted in, and add a “Not interested” quick-reply so people can opt out instead of blocking.',
  },
  RED: {
    label: 'Low', cls: 'bad',
    why: 'Many people blocked or reported this number recently, usually after messages they didn’t expect or want.',
    means: 'Meta can restrict sending, pause templates with poor feedback, or lock the account (error 131031).',
    todo: 'Pause campaigns from this number for about a week, then restart small with opted-in contacts only. It usually recovers in 1–2 weeks.',
  },
};
const QUALITY_NONE = {
  label: 'Not rated yet', cls: 'muted',
  why: 'Meta hasn’t rated this number yet. It needs more messages and responses first.',
  means: 'No restrictions. It starts at the default messaging limit.',
  todo: 'Start with people who opted in, so its first rating comes out High.',
};
function qualityTag(rating) {
  const q = QUALITY[rating] || QUALITY_NONE;
  return `<span class="tag ${q.cls} has-pop" tabindex="0">${q.label}
    <span class="tag-pop" role="tooltip">
      <span class="qp-head"><b>Quality: ${q.label}</b><span>Meta's rating: ${esc(rating || 'UNKNOWN')}</span></span>
      <span class="qp-sec"><i>Why</i>${esc(q.why)}</span>
      <span class="qp-sec"><i>What it means</i>${esc(q.means)}</span>
      <span class="qp-sec"><i>What to do</i>${esc(q.todo)}</span>
    </span></span>`;
}

function renderHealth(st) {
  if (!st.senders.length) {
    $('#senderHealth').innerHTML = emptyMini('phone', 'No numbers yet. <a href="#" onclick="senderForm();return false">Add your first WhatsApp number</a>.');
    return;
  }
  $('#senderHealth').innerHTML = st.senders
    .map((s) => {
      const m = metaLimit(s);
      return `<div class="health-row">
        <div>
          <div class="health-name"><span>${esc(s.label)}</span><i class="q-dot ${esc(s.qualityRating || 'none')}" title="Quality: ${esc(s.qualityRating || 'unknown')}"></i>${s.enabled ? '' : '<span class="pill">off</span>'}</div>
          <div class="health-phone">${esc(s.displayPhone || '—')}</div>
        </div>
        <div class="health-meter" title="${esc(m.title)}">
          <div class="meter ${m.cls}"><span data-w="${Math.min(100, m.used * 100).toFixed(2)}" data-k="h-${s.id}"></span></div>
          <div class="meter-label"><span><b data-count="${s.limitUsed}" data-fmt="int" data-k="ht-${s.id}">0</b>${m.total.replace(/<\/?span>/g, '')} people</span>${m.assumed ? '<span>assumed</span>' : ''}</div>
        </div>
        <div class="health-total"><b data-count="${s.sent}" data-k="hs-${s.id}">0</b>${s.sent ? `sent · ${pct(s.delivered, s.sent)}% delivered` : 'nothing sent yet'}</div>
      </div>`;
    })
    .join('') +
    (st.cap ? `<p class="sub health-cap">Workspace cap (set in this app, not by Meta): <b>${st.cap.used.toLocaleString()} / ${st.cap.limit.toLocaleString()}</b> template messages in the last 24h. Support can raise it.</p>` : '');
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
      // delivered out of everyone it tried (sent + failed): failures count against it. (Out of "sent" alone, 5 of 7
      // delivered with 2 failed read as 100%.) Not out of the full total, so one still sending isn't held down by the
      // people it hasn't reached yet.
      const tried = sent + (s.failed || 0);
      const color = window.folderColorAt && c.colorIndex != null ? folderColorAt(c.colorIndex) : 'oklch(var(--fl) var(--fc) 250)';
      return `<div class="mini-item rc-item" data-open-campaign="${c.id}" style="--c:${color}">
        <span class="cp-ficon" aria-hidden="true"><i class="cf-tab"></i><i class="cf-paper"></i><i class="cf-body"></i></span>
        <div class="mini-title" title="${esc(c.name)}">${esc(window.campaignDisplayName ? campaignDisplayName(c) : c.name)}</div>
        <div class="mini-right" title="${delivered.toLocaleString()} of ${tried.toLocaleString()} delivered${s.failed ? ` · ${s.failed.toLocaleString()} failed` : ''}"><b><span data-count="${pct(delivered, tried)}" data-k="rc-${c.id}">0</span>%</b>delivered</div>
        <div class="mini-meta"><span class="pill ${c.status}" style="height:18px;font-size:10.5px">${c.status}</span>${c.test ? ' <span class="pill test" style="height:18px;font-size:10.5px" title="A test send: not counted in these numbers">Test</span>' : ''} ${relTime(c.startedAt || c.createdAt)} · ${c.total.toLocaleString()} recipients</div>
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
// A person's avatar: their photo if they added one, else initials on their colour.
const personInitials = (u) => (u.name || u.email || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const faceHtml = (u, cls = '') => `<span class="acct-av ${cls}${u.photo ? ' has-photo' : ''}" style="${avatarStyle(u.email)}">${u.photo ? `<img src="${esc(u.photo)}" alt="" />` : esc(personInitials(u))}</span>`;
async function loadMe() {
  state.me = await api('/me');
  const { user, workspace } = state.me;
  // Bottom left: the workspace you're in (its letter and colour, as in Your workspaces), with your own face on it.
  $('#acctAv').className = 'acct-av ws-av';
  $('#acctAv').setAttribute('style', avatarStyle(workspace.id));
  $('#acctAv').innerHTML = `${esc((workspace.name || '?').slice(0, 1).toUpperCase())}${faceHtml(user, 'acct-me-badge')}`;
  document.body.classList.toggle('no-ai', !state.me.ai); // hides the Assistant and AI settings
  document.body.classList.toggle('no-ai-manage', !(state.me.admin || (state.me.ai && state.me.role === 'owner'))); // AI keys and setup: owners
  // A member limited to some numbers: owner-only controls go (the server refuses them anyway), and Settings says why.
  const limited = Array.isArray(state.me.senders);
  document.body.classList.toggle('limited', limited);
  const ln = $('#limitedNote');
  if (ln) { ln.classList.toggle('hidden', !limited); if (limited) ln.innerHTML = `${icon('lock', 14)}<span>You work with <b>${state.me.senders.length} number${state.me.senders.length === 1 ? '' : 's'}</b> the owner picked for you. Workspace settings, numbers and templates are changed by the owner.</span>`; }
  $$('#tab-settings .grid-2 input, #tab-settings .grid-2 select').forEach((x) => { if (x.closest('.card')?.querySelector('#saveSettings')) x.disabled = limited; });
  $('#acctWs').textContent = workspace.name;
  $('#acctUser').textContent = user.name || user.email;
  $('#wsName').value = workspace.name;
  $('#wsName').disabled = $('#wsSave').disabled = state.me.role !== 'owner';
  $('#acctMe').innerHTML = `<span class="acct-photo">${faceHtml(user, 'lg')}</span><span class="acct-text"><b>${esc(user.name || user.email)}</b><span>${esc(user.email)}</span></span><span class="pill ${state.me.role === 'owner' ? 'scheduled' : ''}">${state.me.role === 'owner' ? 'Owner' : 'Member'}</span>`;
  $('#acctPhotoRm').classList.toggle('hidden', !user.photo);
  const n = state.me.workspaces.length;
  $('#acctFacts').innerHTML = `<div><dt>Email</dt><dd>${user.emailVerified ? '<span class="acct-ok">Confirmed</span>' : 'Not confirmed yet'}</dd></div>
    <div><dt>Workspaces</dt><dd>${n} ${n === 1 ? 'workspace' : 'workspaces'}</dd></div>
    ${user.createdAt ? `<div><dt>Member since</dt><dd>${new Date(user.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</dd></div>` : ''}`;
  const del = user.deletionRequest;
  $('#acctDelete').classList.toggle('hidden', Boolean(del));
  $('#acctDelNote').classList.toggle('hidden', !del);
  if (del) $('#acctDelNote').innerHTML = `<b>Deletion requested</b> on ${new Date(del.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}. Our team will get in touch before anything is deleted. Your account works as usual until then.<button class="btn sm" id="acctDelCancel">Cancel request</button>`;
  renderWorkspaces();
  document.title = `${workspace.name} · SendON`;
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
// --- Who can use a number (bottom-right of each number card) ---------------------------------------
// Only owners manage this. With only owners in the workspace the card keeps a plain Delete; as soon as there's a
// member it shows the faces of who can use the number (everyone, by default) and a settings button, where the
// number is shared or limited and deleted.
const canUseNumber = (m, id) => m.role === 'owner' || !Array.isArray(m.senders) || m.senders.includes(id);
function numberAccessHtml(s) {
  const t = state.team;
  // Every number has the same settings button: its lead-assistant playbooks, who can use it, deleting it.
  const gear = `<button type="button" class="na-gear" data-num-gear="${s.id}" title="Number settings: lead assistant, ${t?.role === 'owner' ? 'who can use it, ' : ''}delete" aria-label="Number settings">${icon('settings', 16)}</button>`;
  const members = t?.role === 'owner' ? t.members.filter((m) => m.role !== 'owner') : [];
  if (!members.length) return `<div class="na" style="margin-left:auto">${gear}</div>`;
  const who = t.members.filter((m) => canUseNumber(m, s.id));
  // Up to 3 faces; anyone beyond that is counted in a "+N" circle.
  const faces = who.slice(0, 3).map((m, i) => `<span class="na-face" style="z-index:${9 - i}">${tmAvatar({ ...m, kind: 'member' })}</span>`).join('');
  const more = who.length > 3 ? `<span class="na-face na-more">+${who.length - 3}</span>` : '';
  return `<div class="na" style="margin-left:auto">
      <button type="button" class="na-group" data-num-team="1" title="${esc(who.map((m) => m.name || m.email).join(', '))} can use this number. Open the team.">${faces}${more}</button>
      ${gear}
    </div>`;
}
// Number settings: who on the team can use it (owners always), and deleting it.
function numberModal(s) {
  if (!s) return;
  const team = state.team?.role === 'owner' && state.team.members.some((m) => m.role !== 'owner');
  const ai = Boolean(state.settings.aiManage);
  const body = openModal(`${s.label}`, `
    <div class="nm-head">${senderPhotoHtml(s)}<div><b>${esc(s.verifiedName || s.label)}</b><span>${esc(s.displayPhone || '')}</span></div></div>
    ${ai ? `<div class="nm-sec-l nm-sec-row"><span>Lead assistant</span><button type="button" class="nm-link" id="nmPbAll">All playbooks ${icon('arrow-right', 13)}</button></div>
    <p class="tmm-hint">The playbooks chats on this number use. With several: the one linked to the campaign they replied to, else the AI’s pick, else the default.</p>
    <div class="nm-pb" id="nmPb"></div>
    <div class="nm-pb-acts"><button type="button" class="btn sm primary" id="nmPbNew">${icon('plus', 14)}New playbook for this number</button><button type="button" class="btn sm" id="nmPbAdd" aria-haspopup="menu">Add an existing one${icon('chevron-down', 13)}</button></div>` : ''}
    ${team ? `<div class="nm-sec-l">Who can use this number</div>
    <p class="tmm-hint">They see its chats, campaigns and stats, and can send from it. Owners always can.</p>
    <div class="nm-list" id="nmList"></div>` : ''}
    <div class="nm-danger">
      <div><b>Delete this number</b><span>Removes it and its saved token from this app. Nothing changes in your Meta account.</span></div>
      <button class="btn sm danger-solid" id="nmDel">${icon('delete', 14)}Delete</button>
    </div>`);
  $('#modal .modal-box').classList.add('tmm-box');
  // --- its playbooks ---
  const drawPb = () => {
    const el = $('#nmPb', body);
    if (!el) return;
    const cfg = leadCfg();
    const list = cfg.playbooks.filter((p) => pbUses(p, s.id));
    const def = pbDefault(s.id, cfg)?.id;
    el.innerHTML = (cfg.on === false ? `<p class="nm-pb-off">${icon('bell-off', 14)}The lead assistant is off for the whole workspace (Settings).</p>` : '')
      + (list.length ? list.map((p) => {
        const [mode] = pbMode(p);
        return `<div class="nm-pb-row" data-id="${esc(p.id)}">
          ${pbBook(p, 'md')}
          <span class="nm-pb-who"><b>${esc(p.name)}</b><small>${esc(mode)}${p.when ? ' · ' + esc(p.when) : ''}</small></span>
          ${list.length > 1 ? `<label class="pb-num-def" title="Used when nothing else decides"><input type="radio" name="nmDef" value="${esc(p.id)}" ${p.id === def ? 'checked' : ''} /><span>Default</span></label>` : ''}
          <button type="button" class="icon-btn" data-pb-open="${esc(p.id)}" title="Edit this playbook" aria-label="Edit ${esc(p.name)}">${icon('square-pen', 15)}</button>
          <button type="button" class="icon-btn" data-pb-drop="${esc(p.id)}" ${p.allNumbers ? 'disabled' : ''} title="${p.allNumbers ? 'Used by all numbers: change that in the playbook' : 'Stop using it on this number'}" aria-label="Remove from this number">${icon('x', 15)}</button>
        </div>`;
      }).join('') : `<p class="nm-pb-none">No playbook yet: on this number the AI drafts only when someone asks, without facts about the business.</p>`);
    const others = cfg.playbooks.filter((p) => !pbUses(p, s.id));
    $('#nmPbAdd', body).disabled = !others.length;
    $('#nmPbAdd', body).title = others.length ? '' : 'Every playbook is already used by this number';
  };
  const changePb = (fn, note) => guard(async () => { const cfg = leadCfg(); await savePlaybooks(fn(cfg), note); drawPb(); });
  if (ai) {
    drawPb();
    // the playbooks window opens over this one; closing it comes back here (re-drawn, so changes show)
    const back = () => numberModal(state.senders.find((x) => x.id === s.id) || s);
    $('#nmPbNew', body).onclick = () => playbookManager('new', { numberId: s.id, back });
    $('#nmPbAll', body).onclick = () => playbookManager(pbDefault(s.id)?.id || undefined, { numberId: s.id, back });
    $('#nmPbAdd', body).onclick = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      Sheet.Menu.open(r.left, r.bottom + 6, leadCfg().playbooks.filter((p) => !pbUses(p, s.id)).map((p) => ({
        label: p.name, pre: pbBook(p, 'sm'),
        action: () => changePb((cfg) => ({ ...cfg, playbooks: cfg.playbooks.map((x) => (x.id === p.id ? { ...x, numbers: [...new Set([...(x.numbers || []), s.id])] } : x)) }), `${s.label} now uses “${p.name}”`),
      })));
    };
    $('#nmPb', body).addEventListener('click', (e) => {
      const open = e.target.closest('[data-pb-open]');
      if (open) return playbookManager(open.dataset.pbOpen, { numberId: s.id, back: () => numberModal(state.senders.find((x) => x.id === s.id) || s) });
      const drop = e.target.closest('[data-pb-drop]');
      if (drop) {
        const id = drop.dataset.pbDrop;
        changePb((cfg) => {
          const defaults = { ...cfg.defaults };
          if (defaults[s.id] === id) delete defaults[s.id];
          return { ...cfg, defaults, playbooks: cfg.playbooks.map((x) => (x.id === id ? { ...x, numbers: (x.numbers || []).filter((n) => n !== s.id) } : x)) };
        }, `${s.label} no longer uses it`);
      }
    });
    $('#nmPb', body).addEventListener('change', (e) => {
      if (e.target.name !== 'nmDef') return;
      const id = e.target.value;
      changePb((cfg) => ({ ...cfg, defaults: { ...cfg.defaults, [s.id]: id } }), 'Default playbook set');
    });
  }
  // --- who can use it ---
  const draw = () => {
    if (!$('#nmList', body)) return;
    $('#nmList', body).innerHTML = state.team.members.map((m) => {
      const owner = m.role === 'owner', on = canUseNumber(m, s.id);
      return `<div class="tmm-row">
        <span class="tm-pic">${tmAvatar({ ...m, kind: 'member' })}</span>
        <div class="tmm-who"><b>${esc(m.name || m.email)}${m.you ? ' <span class="muted">(You)</span>' : ''}</b><span>${owner ? 'Owner · always' : !Array.isArray(m.senders) ? 'Member · all numbers' : `Member · ${m.senders.length} number${m.senders.length === 1 ? '' : 's'}`}</span></div>
        ${owner ? '<span class="tmm-role static">Owner</span>' : `<label class="nm-tog">${toggleHtml({ checked: on, attrs: `data-nm="${m.id}" aria-label="${esc(m.name || m.email)} can use this number"`, size: 'sm' })}</label>`}
      </div>`;
    }).join('');
  };
  draw();
  $('#nmList', body)?.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-nm]');
    if (!cb) return;
    const m = state.team.members.find((x) => x.id === cb.dataset.nm);
    const base = Array.isArray(m.senders) ? m.senders : state.senders.map((x) => x.id);
    const next = cb.checked ? [...new Set([...base, s.id])] : base.filter((x) => x !== s.id);
    if (!next.length) { cb.checked = true; return toast(`${m.name || m.email} would have no numbers left. Give them another number first, or remove them from the team.`, 'error'); }
    const all = state.senders.every((x) => next.includes(x.id));
    guard(async () => {
      try { await api('/team/members/' + m.id, { method: 'PATCH', body: { senders: all ? null : next } }); }
      catch (err) { cb.checked = !cb.checked; throw err; }
      await loadTeam();
      draw();
      toast(`${m.name || m.email} ${cb.checked ? 'can now use' : 'no longer uses'} ${s.label}`);
    });
  });
  $('#nmDel', body).onclick = () => guard(async () => {
    const ok = await confirmDialog({ title: `Delete “${esc(s.label)}”?`, message: 'The number and its saved token are removed from this app. Nothing changes in your Meta account.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    await api('/senders/' + s.id, { method: 'DELETE' });
    closeModal();
    await loadSenders();
    loadTeam().catch(() => {});
  });
}

async function loadTeam() {
  const t = await api('/team');
  state.team = t;
  $('#teamCount').textContent = `${t.members.length} ${t.members.length === 1 ? 'person' : 'people'}${t.invites.length ? ` · ${t.invites.length} invited` : ''}`;
  renderTeam();
  if (state.tab === 'numbers' && state.senders?.length) renderSenders(); // number cards show who can use each number
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
  return `<span class="tm-face ${size}${p.photo ? ' has-photo' : ''}" style="${p.kind === 'invite' ? '' : avatarStyle(p.email)}">${p.kind === 'invite' ? icon('user', size ? 16 : 20) : p.photo ? `<img src="${esc(p.photo)}" alt="" />` : esc(initials2(p.name || p.email))}</span>`;
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
  const el = tmPop(anchor, `<div class="search-wrap tm-search">${icon('search', 15)}<input data-1p-ignore data-lpignore="true" data-form-type="other" autocomplete="off" class="search" id="tmQ" placeholder="Search people" /></div><div class="tm-list" id="tmList"></div>`, 'tm-all');
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
    items.forEach(({ el, d }, i) => {
      const pic = el.querySelector('.tm-pic');
      const near = Math.max(0, 1 - d / RANGE), ease = near * near * (3 - 2 * near); // smoothstep falloff
      const sp = springs.get(el) || { s: 1, v: 0, y: 0, vy: 0 };
      springs.set(el, sp);
      const target = 1 + GROW * ease;
      if (reduce()) { sp.s = target; sp.v = 0; } else step(sp, 's', 'v', target, dt);
      const lift = best && el === best.el && near > 0 ? LIFT : 0; // only the face being named lifts
      if (reduce()) sp.y = lift; else step(sp, 'y', 'vy', lift, dt);
      pic.style.transform = `translateY(${(sp.y * 42).toFixed(2)}px) scale(${sp.s.toFixed(4)})`;
      // Left over right, always (the leftmost face on top of the stack); only the face being named comes up above them.
      el.style.zIndex = String(lift ? items.length + 1 : items.length - i);
      if (Math.abs(sp.v) > 0.001 || Math.abs(sp.s - target) > 0.001 || Math.abs(sp.vy) > 0.001 || Math.abs(sp.y - lift) > 0.001) moving = true;
    });
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
// Which numbers a member works with, under their name in the Team window. Owners always have all of them.
function numsChip(p, canEdit) {
  // Only members can be limited: owners always use every number, so they get no chip (and with only owners
  // in the workspace there's nothing to set at all).
  if (p.role === 'owner') return '';
  const all = !Array.isArray(p.senders);
  const ss = all ? [] : p.senders.map((id) => state.senders.find((s) => s.id === id)).filter(Boolean);
  const label = all ? 'All numbers' : ss.length === 1 ? ss[0].label : `${ss.length} numbers`;
  const faces = ss.slice(0, 3).map((s) => senderPhotoHtml(s)).join('');
  const inner = `${faces ? `<span class="nc-faces">${faces}</span>` : icon('phone', 12)}<span>${esc(label)}</span>`;
  return canEdit
    ? `<button type="button" class="nums-chip" data-nums="${esc(p.key)}" title="Choose which numbers ${esc(p.name || p.email)} can use">${inner}${icon('chevron-down', 12)}</button>`
    : `<span class="nums-chip static">${inner}</span>`;
}
// Whether a member can use the AI assistant (once the workspace has AI). Owners always can, so they get no chip.
function aiChip(p, canEdit) {
  if (!state.team.aiWorkspace || p.aiAlways) return '';
  const inner = `${icon('sparkles', 12)}<span>${p.ai ? 'AI on' : 'AI off'}</span>`;
  return canEdit
    ? `<button type="button" class="nums-chip ai-chip ${p.ai ? 'on' : ''}" data-aichip="${esc(p.key)}" aria-pressed="${p.ai}" title="${p.ai ? `${esc(p.name || p.email)} can use the AI assistant. Click to turn it off.` : `Let ${esc(p.name || p.email)} use the AI assistant`}">${inner}</button>`
    : `<span class="nums-chip ai-chip static ${p.ai ? 'on' : ''}">${inner}</span>`;
}
const chipsHtml = (p, canEdit) => { const c = numsChip(p, canEdit) + aiChip(p, canEdit); return c ? `<div class="tmm-chips">${c}</div>` : ''; };
// Owner picks the numbers a member may use: all of them, or only some.
function numbersPicker(anchor, p, done) {
  const r = anchor.getBoundingClientRect();
  let pick = new Set(Array.isArray(p.senders) ? p.senders : []);
  let allMode = !Array.isArray(p.senders);
  const el = Sheet.Menu.panel(r.left, r.bottom + 6, `
    <div class="np">
      <div class="np-h"><b>Numbers for ${esc((p.name || p.email).split(' ')[0])}</b><span>They see chats, campaigns and stats only for these, and send only from them.</span></div>
      <div class="seg np-mode" role="radiogroup"><button type="button" data-mode="all">All numbers</button><button type="button" data-mode="some">Only some</button></div>
      <div class="np-list"></div>
      <div class="np-acts"><button type="button" class="btn sm quiet" data-np="cancel">Cancel</button><button type="button" class="btn sm primary" data-np="save">Save</button></div>
    </div>`);
  el.classList.add('np-pop');
  const draw = () => {
    el.querySelectorAll('.np-mode button').forEach((b) => b.classList.toggle('active', (b.dataset.mode === 'all') === allMode));
    el.querySelector('.np-list').classList.toggle('off', allMode);
    el.querySelector('.np-list').innerHTML = state.senders.map((s) => `<label class="np-row"><input type="checkbox" class="cb" value="${esc(s.id)}" ${allMode || pick.has(s.id) ? 'checked' : ''} ${allMode ? 'disabled' : ''} />${senderPhotoHtml(s)}<span><b>${esc(s.label)}</b><small>${esc(s.displayPhone || '')}</small></span></label>`).join('') || '<p class="sub">No numbers yet.</p>';
    Motion.segs(el);
  };
  draw();
  Sheet.Menu.fit(el, r); // now that the numbers are listed: below the chip, or above it near the bottom of the window
  el.addEventListener('click', (e) => {
    const m = e.target.closest('.np-mode [data-mode]'); // (scoped: <html> has its own data-mode, the theme)
    if (m) { allMode = m.dataset.mode === 'all'; if (!allMode && !pick.size) pick = new Set(state.senders.map((s) => s.id)); draw(); return; }
    const a = e.target.closest('[data-np]');
    if (!a) return;
    if (a.dataset.np === 'cancel') return Sheet.Menu.close();
    guard(async () => {
      await api('/team/members/' + p.id, { method: 'PATCH', body: { senders: allMode ? null : [...pick] } });
      Sheet.Menu.close();
      toast(allMode ? `${p.name || p.email} can use every number` : `${p.name || p.email} can use ${pick.size} number${pick.size === 1 ? '' : 's'}`);
      await done();
    }, a);
  });
  el.addEventListener('change', (e) => { const c = e.target.closest('input[type=checkbox]'); if (!c) return; if (c.checked) pick.add(c.value); else pick.delete(c.value); el.querySelector('[data-np="save"]').disabled = !allMode && !pick.size; });
}

// The team window: invite by email at the top, everyone below with their role. Opened from any face or the "+".
function teamModal({ focus = false } = {}) {
  const owner = state.team.role === 'owner';
  const body = openModal('Team', `
    ${owner ? `<form class="tmm-add" id="tmmForm" novalidate>
        <input type="email" id="tmmEmail" placeholder="Who else is in? Their email" autocomplete="off" aria-label="Their email" />
        <button class="btn tmm-addbtn" id="tmmAdd" type="submit" disabled>Add</button>
      </form>
      <p class="tmm-hint">${state.me.mail ? 'They’ll get an email invite to join this workspace. Links work for 7 days.' : 'You’ll get a link to send them. Links work for 7 days.'}</p>
      <div class="tmm-out hidden" id="tmmOut"></div>` : '<p class="tmm-hint">Only owners can invite people or change roles.</p>'}
    <div class="tmm-list" id="tmmList"></div>`);
  $('#modal .modal-box').classList.add('tmm-box');
  const draw = () => {
    const people = teamPeople();
    $('#tmmList', body).innerHTML = people.map((p) => {
      const inv = p.kind === 'invite';
      const role = inv ? 'Invited' : p.role === 'owner' ? 'Owner' : 'Member';
      const canMenu = inv ? owner : owner || p.you;
      return `<div class="tmm-row ${inv ? 'invited' : ''}">
        <span class="tm-pic">${tmAvatar(p)}</span>
        <div class="tmm-who"><b>${esc(inv ? p.email : p.name || p.email)}${p.you ? ' <span class="muted">(You)</span>' : ''}</b><span>${inv ? `Expires ${esc(relTime(p.expiresAt))}` : esc(p.email)}</span>${inv ? '' : chipsHtml(p, owner)}</div>
        ${canMenu ? `<button type="button" class="tmm-role" data-key="${esc(p.key)}" aria-haspopup="menu">${role}${icon('chevron-down', 14)}</button>` : `<span class="tmm-role static">${role}</span>`}
      </div>`;
    }).join('');
  };
  draw();
  const refresh = async () => { await loadTeam(); draw(); };
  if (owner) {
    const input = $('#tmmEmail', body), add = $('#tmmAdd', body);
    const valid = () => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.value.trim());
    input.addEventListener('input', () => { add.disabled = !valid(); add.classList.toggle('ready', valid()); });
    $('#tmmForm', body).addEventListener('submit', (e) => {
      e.preventDefault();
      if (!valid()) return;
      guard(async () => {
        const email = input.value.trim();
        const r = await api('/team/invites', { method: 'POST', body: { email, role: 'member' } });
        input.value = ''; add.disabled = true; add.classList.remove('ready');
        const out = $('#tmmOut', body);
        out.classList.remove('hidden');
        out.innerHTML = r.emailed ? `${icon('circle-check', 15)}<span>Invite emailed to <b>${esc(email)}</b>.</span>`
          : `${icon('circle-check', 15)}<span>Invite ready for <b>${esc(email)}</b>. Send them this link:</span><div class="tmm-link"><input readonly value="${esc(r.link)}" /><button type="button" class="btn sm" id="tmmCopy">${icon('copy', 14)}Copy</button></div>`;
        $('#tmmCopy', body)?.addEventListener('click', () => { navigator.clipboard.writeText(r.link); toast('Invite link copied'); });
        await refresh();
        input.focus();
      }, add);
    });
    if (focus) setTimeout(() => input.focus(), 50);
  }
  // Numbers a member may use (owners always have all of them).
  $('#tmmList', body).addEventListener('click', (e) => {
    const n = e.target.closest('[data-nums]');
    if (!n) return;
    const p = teamPeople().find((x) => x.key === n.dataset.nums);
    if (p) numbersPicker(n, p, refresh);
  });
  // The AI assistant for a member: one click turns it on or off.
  $('#tmmList', body).addEventListener('click', (e) => {
    const c = e.target.closest('[data-aichip]');
    if (!c) return;
    const p = teamPeople().find((x) => x.key === c.dataset.aichip);
    if (!p) return;
    guard(async () => {
      await api('/team/members/' + p.id, { method: 'PATCH', body: { ai: !p.ai } });
      toast(!p.ai ? `${p.name || p.email} can use the AI assistant` : `${p.name || p.email} can no longer use the AI assistant`);
      await refresh();
    }, c);
  });
  // Role menu: change role / remove for members; link, resend, cancel for invites; leave for yourself.
  $('#tmmList', body).addEventListener('click', (e) => {
    const b = e.target.closest('.tmm-role[data-key]');
    if (!b) return;
    const p = teamPeople().find((x) => x.key === b.dataset.key);
    if (!p) return;
    const r = b.getBoundingClientRect();
    const say = (m) => toast(m);
    const items = p.kind === 'invite' ? [
      { label: 'Copy invite link', action: () => guard(async () => { const x = await api(`/team/invites/${p.id}/link`, { method: 'POST', body: {} }); await navigator.clipboard.writeText(x.link); say('New invite link copied. The old one no longer works.'); await refresh(); }) },
      state.me.mail && { label: 'Resend email', action: () => guard(async () => { await api(`/team/invites/${p.id}/link`, { method: 'POST', body: { email: true } }); say(`Invite emailed to ${p.email} again`); await refresh(); }) },
      '-',
      { label: 'Cancel invite', danger: true, action: () => guard(async () => { await api('/team/invites/' + p.id, { method: 'DELETE' }); say('Invite cancelled'); await refresh(); }) },
    ] : [
      ...(owner ? [
        { label: 'Owner', kbd: 'manages team & settings', checked: p.role === 'owner', action: () => p.role !== 'owner' && guard(async () => { await api('/team/members/' + p.id, { method: 'PATCH', body: { role: 'owner' } }); say(`${p.name || p.email} is now an owner`); await refresh(); }) },
        { label: 'Member', kbd: 'sends & replies', checked: p.role !== 'owner', action: () => p.role === 'owner' && guard(async () => { await api('/team/members/' + p.id, { method: 'PATCH', body: { role: 'member' } }); say(`${p.name || p.email} is now a member`); await refresh(); }) },
      ] : []),
      ...((p.you ? state.team.members.length > 1 : owner) ? ['-', { label: p.you ? 'Leave workspace' : 'Remove from team', danger: true, action: async () => {
        if (!(await confirmDialog({ title: p.you ? 'Leave this workspace?' : `Remove ${p.name || p.email}?`, message: p.you ? 'You lose access until someone invites you again.' : 'They lose access to this workspace straight away.', confirmText: p.you ? 'Leave' : 'Remove', danger: true }))) return;
        guard(async () => { await api('/team/members/' + p.id, { method: 'DELETE' }); if (p.you) location.href = '/'; else { say('Removed from the team'); await refresh(); } });
      } }] : []),
    ];
    Sheet.Menu.open(r.right - 230, r.bottom + 6, items.filter(Boolean));
  });
}
$('#teamRow').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tm]');
  if (!b) return;
  teamModal({ focus: b.dataset.tm === 'add' });
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
    <div class="acct-pop-me">${faceHtml(me.user)}<span class="acct-text"><b>${esc(me.user.name || me.user.email)}</b><span>${esc(me.user.email)}</span></span></div>
    <hr />
    <div class="acct-pop-label">Workspaces</div>
    ${me.workspaces.map((w) => `<button type="button" class="acct-pop-item ws-item ${w.id === me.workspace.id ? 'on' : ''}" data-ws="${w.id}" role="menuitemradio" aria-checked="${w.id === me.workspace.id}"><i class="ss-check">${w.id === me.workspace.id ? TICK_SVG : ''}</i><span>${esc(w.name)}</span></button>`).join('')}
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
// The photo block in Edit your account (kept in step when the photo is uploaded or removed).
const aePhotoHtml = () => faceHtml(state.me.user, 'lg');
function refreshAePhoto() {
  const ph = document.getElementById('aePhoto');
  if (!ph) return;
  ph.innerHTML = aePhotoHtml();
  const u = state.me.user, act = ph.parentElement.querySelector('.ae-photo-act .row');
  act.innerHTML = `<label class="btn sm">${icon('upload', 14)}${u.photo ? 'Change photo' : 'Upload photo'}<input type="file" hidden accept="image/*" id="acctPhotoFile" /></label>${u.photo ? '<button type="button" class="btn sm quiet danger" id="acctPhotoRm">Remove</button>' : ''}`;
}
// Edit your own name and email (a new email needs your password, then a confirmation link).
$('#acctEdit').addEventListener('click', () => {
  const u = state.me.user;
  const body = openModal('Edit your account', `
    <div class="ae-photo"><span id="aePhoto">${aePhotoHtml()}</span><div class="ae-photo-act"><b>Profile photo</b><span class="sub">Shown to your team and on your messages in the app.</span><div class="row tight"><label class="btn sm">${icon('upload', 14)}${u.photo ? 'Change photo' : 'Upload photo'}<input type="file" hidden accept="image/*" id="acctPhotoFile" /></label>${u.photo ? '<button type="button" class="btn sm quiet danger" id="acctPhotoRm">Remove</button>' : ''}</div></div></div>
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
    // A protected workspace asks for its password first (once per sign-in).
    const body = { id };
    if (w?.protected) {
      try { await api('/workspace/switch', { method: 'POST', body }); }
      catch {
        const pw = await askWorkspacePassword(w.name, (password) => api('/workspace/switch', { method: 'POST', body: { id, password } }));
        if (pw == null) return;
      }
    } else await api('/workspace/switch', { method: 'POST', body });
    try { sessionStorage.setItem('wsNotice', JSON.stringify({ kind, name: w?.name || '' })); } catch {}
    location.reload();
  });
}
// Asks for a protected workspace's password; `tryIt(password)` checks it (throws when wrong). Resolves with the
// password once it works, or null if cancelled.
function askWorkspacePassword(name, tryIt) {
  return new Promise((resolve) => {
    const body = openModal(`Open “${name}”`, `
      <p class="sub">${icon('lock', 14)} This workspace is protected. Enter its password to open it. You'll only be asked once until you sign out.</p>
      <label>Workspace password<input type="password" id="wpPw" autocomplete="off" /></label>
      <div class="sf-status hidden" id="wpStatus" role="status"></div>
      <div class="modal-actions"><button type="button" class="btn quiet" id="wpCancel">Cancel</button><button type="button" class="btn primary" id="wpGo">Open</button></div>`);
    let done = false;
    const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
    const go = () => guard(async () => {
      const pw = $('#wpPw', body).value;
      try { await tryIt(pw); finish(pw); }
      catch (err) { const st = $('#wpStatus', body); st.className = 'sf-status bad'; st.textContent = err.message; $('#wpPw', body).select(); }
    }, $('#wpGo', body));
    $('#wpGo', body).onclick = go;
    $('#wpPw', body).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    $('#wpCancel', body).onclick = () => finish(null);
    $('#modalClose').addEventListener('click', () => finish(null), { once: true });
    $('#wpPw', body).focus();
  });
}
// Opening the app (or reloading) inside a protected workspace that this sign-in hasn't unlocked yet.
function showLockScreen() {
  const me = state.me, others = me.workspaces.filter((w) => w.id !== me.workspace.id);
  const el = document.createElement('div');
  el.className = 'ws-lock';
  el.innerHTML = `<div class="ws-lock-box">
    <span class="ws-lock-ic">${icon('lock', 22)}</span>
    <h2>${esc(me.workspace.name)} is protected</h2>
    <p class="sub">Enter the workspace password to open it. You'll only be asked once until you sign out.</p>
    <input type="password" id="wlPw" placeholder="Workspace password" autocomplete="off" />
    <div class="sf-status hidden" id="wlStatus" role="status"></div>
    <button class="btn primary" id="wlGo">Open workspace</button>
    ${others.length ? `<div class="ws-lock-alt"><span>Or go to</span>${others.map((w) => `<button type="button" class="btn sm" data-ws-go="${w.id}">${w.protected ? icon('lock', 12) : ''}${esc(w.name)}</button>`).join('')}</div>` : ''}
    <a class="link ws-lock-out" href="/logout">Log out</a>
  </div>`;
  document.body.append(el);
  const go = () => guard(async () => {
    try { await api('/workspace/unlock', { method: 'POST', body: { password: $('#wlPw', el).value } }); location.reload(); }
    catch (err) { const st = $('#wlStatus', el); st.className = 'sf-status bad'; st.textContent = err.message; $('#wlPw', el).select(); }
  }, $('#wlGo', el));
  $('#wlGo', el).onclick = go;
  $('#wlPw', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-ws-go]'); if (b) switchWorkspace(b.dataset.wsGo); });
  $('#wlPw', el).focus();
}
function renderWorkspaces() {
  const me = state.me, lim = me.workspaceLimit;
  $('#wsCount').textContent = lim == null ? `${me.workspaces.length}` : `${me.workspacesOwned} of ${lim} you can own`;
  $('#wsList').innerHTML = me.workspaces.map((w) => {
    const cur = w.id === me.workspace.id;
    return `<div class="ws-row ${cur ? 'current' : ''}">
      <span class="acct-av sm" style="${avatarStyle(w.id)}">${esc((w.name || '?').slice(0, 1).toUpperCase())}</span>
      <span class="ws-who"><b title="${esc(w.name)}">${esc(w.name)}${w.protected ? `<span class="ws-lock-tag" title="Password protected">${icon('lock', 11)}</span>` : ''}</b><span>${w.role === 'owner' ? 'Owner' : 'Member'}${cur ? '<span class="ws-cur"><i></i>Current</span>' : ''}</span></span>
      ${cur ? '<div class="ws-team-slot"></div>' : `<button class="btn sm" data-switch-ws="${w.id}">Switch</button>`}
    </div>`;
  }).join('');
  // The team belongs to the workspace you're in: show it inside that row.
  $('#wsList .ws-team-slot')?.append($('#wsTeam'));
  $('#wsSettings').classList.toggle('hidden', me.role !== 'owner'); // password and deleting are for owners
  const full = lim != null && me.workspacesOwned >= lim;
  $('#wsNew').disabled = full;
  $('#wsNew').title = full ? `You can own up to ${lim} workspaces` : 'Create a workspace for another business';
}
$('#wsList').addEventListener('click', (e) => { const b = e.target.closest('[data-switch-ws]'); if (b) switchWorkspace(b.dataset.switchWs); });
// Workspace settings (owners): one popup for the workspace's password and for deleting it.
function workspaceSettings() {
  const ws = state.me.workspace;
  const body = openModal('Workspace settings', `
    <p class="sub">For “${esc(ws.name)}”. Only owners see these.</p>
    <section class="wss-sec">
      <div class="wss-head"><span class="wss-ic">${icon('lock', 16)}</span><div><b>Password protection</b><span class="pill ${ws.protected ? 'APPROVED' : ''}">${ws.protected ? 'On' : 'Off'}</span></div></div>
      <p class="sub">${ws.protected ? 'Everyone in the team enters the password once per sign-in to open this workspace. Changing it asks everyone again.' : 'Anyone in the team opens this workspace straight away. Add a password so everyone has to enter it once per sign-in.'}</p>
      <div class="row tight"><button type="button" class="btn sm" id="wssLock">${icon('lock', 14)}${ws.protected ? 'Change password' : 'Set a password'}</button>${ws.protected ? `<button type="button" class="btn quiet sm" id="wssUnlock">Turn off</button>` : ''}</div>
    </section>
    <section class="wss-sec wss-danger">
      <div class="wss-head"><span class="wss-ic">${icon('delete', 16)}</span><div><b>Delete this workspace</b></div></div>
      <p class="sub">Removes its numbers, templates, contacts, campaigns, inbox and AI chats for everyone in it. This can't be undone.</p>
      <div class="row tight"><button type="button" class="btn danger sm" id="wssDelete">${icon('delete', 14)}Delete workspace</button></div>
    </section>
    <div class="modal-actions"><button type="button" class="btn quiet" onclick="closeModal()">Close</button></div>`);
  $('#wssLock', body).onclick = workspacePassword;
  $('#wssUnlock', body)?.addEventListener('click', workspacePasswordOff);
  $('#wssDelete', body).onclick = deleteWorkspace;
}
$('#wsSettings').addEventListener('click', workspaceSettings);
// Password protection: set, change or turn off.
function workspacePassword() {
  const body = openModal(state.me.workspace.protected ? 'Change the workspace password' : 'Protect this workspace', `
    <p class="sub">Everyone in the team, you included, enters this password once per sign-in to open “${esc(state.me.workspace.name)}”. Share it only with people who should see this workspace. Changing it asks everyone again.</p>
    <label>Password <span class="opt">at least 4 characters</span><input type="password" id="lkPw" autocomplete="new-password" /></label>
    <label>Type it again<input type="password" id="lkPw2" autocomplete="new-password" /></label>
    <div class="sf-status hidden" id="lkStatus" role="status"></div>
    <div class="modal-actions"><button type="button" class="btn quiet" id="lkBack">Back</button><button type="button" class="btn primary" id="lkGo">Save password</button></div>`);
  $('#lkBack', body).onclick = workspaceSettings;
  $('#lkPw', body).focus();
  $('#lkGo', body).onclick = () => guard(async () => {
    const a = $('#lkPw', body).value, b = $('#lkPw2', body).value, st = $('#lkStatus', body);
    if (a !== b) { st.className = 'sf-status bad'; st.textContent = "The two passwords don't match"; return; }
    try { await api('/workspace/lock', { method: 'PUT', body: { password: a } }); }
    catch (err) { st.className = 'sf-status bad'; st.textContent = err.message; return; }
    toast('Workspace password saved'); await loadMe(); workspaceSettings();
  }, $('#lkGo', body));
}
function workspacePasswordOff() {
  guard(async () => {
    const ok = await confirmDialog({ title: 'Turn off the password?', message: `Anyone in the team will open “${esc(state.me.workspace.name)}” without a password.`, confirmText: 'Turn off', danger: true });
    if (!ok) return;
    await api('/workspace/lock', { method: 'PUT', body: { password: '' } });
    toast('Password turned off'); await loadMe(); workspaceSettings();
  });
}
// Your profile photo: cropped to a centred square and shrunk to 320 px before uploading.
document.addEventListener('change', (e) => {
  if (e.target.id !== 'acctPhotoFile') return;
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  guard(async () => {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("That file isn't a picture this browser can open")); i.src = URL.createObjectURL(f); });
    const side = Math.min(img.naturalWidth, img.naturalHeight), c = document.createElement('canvas');
    c.width = c.height = 320;
    c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 320, 320);
    URL.revokeObjectURL(img.src);
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.88));
    const res = await fetch('/api/account/photo', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
    toast('Profile photo updated');
    await loadMe(); loadTeam().catch(() => {});
    refreshAePhoto();
  });
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#acctPhotoRm')) return;
  guard(async () => { await api('/account/photo', { method: 'DELETE' }); toast('Photo removed'); await loadMe(); loadTeam().catch(() => {}); refreshAePhoto(); });
});
// Delete the current workspace: confirm by typing its name, then land in another workspace.
function deleteWorkspace() {
  const me = state.me, name = me.workspace.name;
  if (me.workspaces.length < 2) return toast('This is your only workspace. Create another one first, or delete your account instead.', 'error');
  const body = openModal(`Delete “${name}”?`, `
    <p class="sub">Everything in this workspace is removed for everyone in it: WhatsApp numbers, templates, contacts, campaigns and their results, the inbox and AI chats. Your Meta account and WhatsApp numbers themselves aren't touched. <b>This can't be undone.</b></p>
    <label>Type <b>${esc(name)}</b> to confirm<input id="wdName" autocomplete="off" placeholder="${esc(name)}" /></label>
    <div class="sf-status hidden" id="wdStatus" role="status"></div>
    <div class="modal-actions"><button type="button" class="btn quiet" id="wdBack">Back</button><button type="button" class="btn danger-solid" id="wdGo" disabled>Delete workspace</button></div>`);
  $('#wdBack', body).onclick = workspaceSettings;
  const inp = $('#wdName', body), go = $('#wdGo', body), status = $('#wdStatus', body);
  inp.addEventListener('input', () => { go.disabled = inp.value.trim() !== name; });
  inp.focus();
  go.addEventListener('click', () => guard(async () => {
    try {
      const r = await api('/workspace', { method: 'DELETE', body: { confirm: inp.value.trim() } });
      try { sessionStorage.setItem('wsNotice', JSON.stringify({ kind: 'deleted', name, to: r.to.name })); } catch {}
      location.reload();
    } catch (err) { status.className = 'sf-status bad'; status.textContent = err.message; }
  }, go));
}
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
  el.innerHTML = `<span class="ws-notice-ic">${icon('circle-check', 18)}</span><div><b>${n.kind === 'created' ? `Workspace “${esc(name)}” created` : n.kind === 'deleted' ? `Workspace “${esc(n.name)}” deleted` : `Switched to “${esc(name)}”`}</b>
    <span>${n.kind === 'created' ? 'It starts empty. Add a WhatsApp number to get going. ' : n.kind === 'deleted' ? `You're now in “${esc(name)}”. ` : ''}Switch workspaces any time from your name at the bottom of the sidebar.</span></div>
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
    if (state.me?.locked) return showLockScreen(); // nothing else loads until the password is entered
    showWorkspaceNotice();
    loadTeam().catch(() => {});
    state.settings = await api('/settings');
    renderSettings();
    await Promise.all([loadSenders(), loadTemplates(), window.Credits?.load()]);
    await window.SendPage?.restoreDraft().catch(() => false); // the Send page's sheets and settings from last time
    showTab.replace = true; // the first page replaces the address (e.g. an old #send link becomes /send)
    showTab(tabFromUrl());
    window.CampaignSetup?.whatsNew(); // once per browser: Send moved into Campaigns
  } catch (e) {
    toast('Could not reach the server: ' + e.message, 'error');
  }
})();

// Settings → General → Animations: Auto / Full / Reduced (this browser). Auto says when it has turned them down.
function syncMotionSetting() {
  const cur = Motion.pref();
  $$('#setMotion [data-motion]').forEach((b) => { const on = b.dataset.motion === cur; b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); });
  $('#motionHelp').textContent = cur === 'auto'
    ? (Motion.lite() ? 'Turned down: this computer looked slow to draw them. Choose Full to have them anyway.' : 'Auto keeps them smooth, and turns them down on slower computers.')
    : cur === 'lite' ? 'Fewer and quicker animations, and no blurred glass. Easiest on older computers.' : 'Every animation, on any computer.';
  Motion.segs($('#setMotion').parentElement);
}
$('#setMotion').addEventListener('click', (e) => {
  const b = e.target.closest('[data-motion]');
  if (!b) return;
  Motion.setMotion(b.dataset.motion);
  syncMotionSetting();
});
syncMotionSetting();
