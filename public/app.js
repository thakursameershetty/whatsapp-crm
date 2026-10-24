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
  $$('.side-nav button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  const wasHidden = $('#tab-' + name)?.classList.contains('hidden');
  $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + name));
  if (wasHidden) Motion.enter($('#tab-' + name));
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
  history.replaceState(null, '', '#' + name);
}
$$('.side-nav button[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
window.addEventListener('hashchange', () => {
  const tab = location.hash.slice(1);
  if ($('#tab-' + tab)?.classList.contains('hidden')) showTab(tab);
});

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

function openModal(title, html) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  LA.hydrate($('#modalBody'));
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
    $('#confirm').onclick = (e) => e.target.id === 'confirm' && done(false);
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

function renderSettings() {
  const s = state.settings;
  $('#setDemo').checked = s.demoMode;
  $('#setCC').value = s.defaultCountryCode || '';
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
      text: 'Add each WhatsApp number from your Meta Business account. Messages are spread across all the numbers you add. For Demo mode, a label and any placeholder ID is enough.',
      actions: `<button class="btn primary" onclick="senderForm()">${icon('plus', 16)}Add number</button>${state.settings.demoMode ? `<button class="btn quiet" data-goto="overview">${icon('layout-grid', 16)}Or load a demo workspace</button>` : ''}`,
    });
    return;
  }
  list.innerHTML = state.senders
    .map(
      (s) => `
    <div class="card sender-card">
      <div class="li-head">
        <h3>${esc(s.label)}</h3>
        <label title="${s.enabled ? 'Number is in use' : 'Number is switched off'}">${toggleHtml({ checked: s.enabled, attrs: `data-enable="${s.id}"`, size: 'sm' })}</label>
      </div>
      <div class="num">${esc(s.displayPhone || '—')}</div>
      ${numStats(s)}
      <dl class="kv">
        <dt>Phone number ID</dt><dd>${esc(s.phoneNumberId)}</dd>
        <dt>WABA ID</dt><dd>${esc(s.wabaId || '—')}</dd>
        <dt>Access token</dt><dd>${s.hasToken ? esc(s.accessTokenMasked) : '<span class="muted">not set</span>'}</dd>
        ${s.verifiedName ? `<dt>Verified name</dt><dd>${esc(s.verifiedName)}</dd>` : ''}
        ${s.qualityRating ? `<dt>Quality</dt><dd>${esc(s.qualityRating)}</dd>` : ''}
        ${s.messagingLimit ? `<dt>Daily limit</dt><dd>${esc(s.messagingLimit)}</dd>` : ''}
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
  const body = openModal(s ? 'Edit number' : 'Add sender number', `
    <form id="senderForm">
      <label>Label <input name="label" required placeholder="e.g. Sales line 1" value="${esc(s?.label)}" /></label>
      <label>Display phone <span class="opt">optional, for your reference</span><input name="displayPhone" placeholder="+91 98765 43210" value="${esc(s?.displayPhone)}" /></label>
      <label>Phone number ID <input name="phoneNumberId" required placeholder="From Meta → WhatsApp → API Setup" value="${esc(s?.phoneNumberId)}" /></label>
      <label>WhatsApp Business Account ID <input name="wabaId" placeholder="Needed to sync templates" value="${esc(s?.wabaId)}" /></label>
      <label>Access token ${s?.hasToken ? '<span class="opt">leave blank to keep current</span>' : ''}
        <input name="accessToken" type="password" autocomplete="off" placeholder="${s?.hasToken ? esc(s.accessTokenMasked) : 'Permanent system-user token'}" />
      </label>
      <p class="sub">Numbers in the same WhatsApp Business Account can share one token. It's stored only on this server and never shown in full again.</p>
      <div class="modal-actions">
        <button type="button" class="btn quiet" onclick="closeModal()">Cancel</button>
        <button class="btn primary">${s ? 'Save' : 'Add number'}</button>
      </div>
    </form>`);
  // Prefill WABA + token hint from an existing number to make adding more numbers quicker.
  if (!s && state.senders[0]?.wabaId) $('[name=wabaId]', body).value = state.senders[0].wabaId;
  $('#senderForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    guard(async () => {
      if (s) await api('/senders/' + s.id, { method: 'PUT', body: data });
      else {
        // Reuse an existing token from the same WABA if none was given.
        const added = await api('/senders', { method: 'POST', body: data });
        state.selectedSenders.add(added.id);
      }
      closeModal();
      toast(s ? 'Saved' : 'Number added');
      await loadSenders();
    }, $('button.primary', e.target));
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
      text: 'WhatsApp only lets you start conversations with approved templates. Once your API is ready, click Sync from Meta. Until then, add one by hand to try things out.',
      actions: `<button class="btn primary" onclick="templateForm()">${icon('plus', 16)}Add manually</button><button class="btn" onclick="document.getElementById('syncTemplates').click()">${icon('refresh-cw', 16)}Sync from Meta</button>`,
    });
    return;
  }
  list.innerHTML = state.templates
    .map((t) => `
    <div class="card tpl-card">
      <div class="li-head">
        <h3>${esc(t.name)}</h3>
        <span class="pill ${esc(t.status)}">${esc(t.status)}</span>
      </div>
      <div class="li-meta">${esc(t.language)} · ${esc((t.category || '').toLowerCase())} · ${t.source === 'synced' ? 'synced from Meta' : 'added manually'}</div>
      <div class="tpl-chat"><div class="bubble">${bubbleHtml(t, {}, true)}</div></div>
      ${t.variables.length ? `<div class="var-chips">${[...new Set(t.variables.map((v) => (v.media ? v.media + ' URL' : `{{${v.name}}}`)))].map((label) => `<span class="var-chip">${esc(label)}</span>`).join('')}</div>` : '<div class="var-chips"><span class="li-meta">No variables, same message for everyone</span></div>'}
      <div class="row tight">
        <button class="btn sm" data-use="${t.id}">${icon('send', 15)}Use for sending</button>
        <button class="btn quiet danger sm" data-del="${t.id}" style="margin-left:auto">${icon('delete', 15)}Delete</button>
      </div>
    </div>`)
    .join('');
}

$('#templateList').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
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

function templateForm() {
  openModal('Add template manually', `
    <form id="tplForm">
      <p class="sub" style="margin-bottom:16px">The name and language must exactly match an approved template in WhatsApp Manager for live sending. Use <code>{{1}}</code>, <code>{{2}}</code>… (or named like <code>{{name}}</code>) for variables.</p>
      <div class="row">
        <label>Template name <input name="name" required placeholder="order_update" pattern="[a-z0-9_]+" title="lowercase letters, numbers and underscores" /></label>
        <label>Language code <input name="language" required value="en" placeholder="en, en_US, hi" /></label>
      </div>
      <div class="row">
        <label>Category
          <select name="category"><option>MARKETING</option><option>UTILITY</option><option>AUTHENTICATION</option></select>
        </label>
        <label>Header
          <select name="headerFormat" id="hf"><option value="NONE">None</option><option value="TEXT">Text</option><option value="IMAGE">Image</option><option value="VIDEO">Video</option><option value="DOCUMENT">Document</option></select>
        </label>
      </div>
      <label id="htWrap" class="hidden">Header text <input name="headerText" placeholder="Hi {{1}}!" /></label>
      <label>Body <textarea name="bodyText" rows="5" required placeholder="Hello {{1}}, your order {{2}} has shipped!"></textarea></label>
      <label>Footer <span class="opt">optional</span><input name="footerText" placeholder="Reply STOP to unsubscribe" /></label>
      <div class="row">
        <label>URL button text <span class="opt">optional</span><input name="btnText" placeholder="Track order" /></label>
        <label>Button URL <input name="btnUrl" placeholder="https://example.com/track/{{1}}" /></label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn quiet" onclick="closeModal()">Cancel</button>
        <button class="btn primary">Add template</button>
      </div>
    </form>`);
  $('#hf').addEventListener('change', (e) => $('#htWrap').classList.toggle('hidden', e.target.value !== 'TEXT'));
  $('#tplForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    d.urlButtons = d.btnText && d.btnUrl ? [{ text: d.btnText, url: d.btnUrl }] : [];
    guard(async () => {
      const t = await api('/templates', { method: 'POST', body: d });
      closeModal();
      toast('Template added');
      await loadTemplates();
      if (!$('#templateSelect').value || state.templates.length === 1) {
        $('#templateSelect').value = t.id;
        onTemplateChange();
      }
    }, $('button.primary', e.target));
  });
}
window.templateForm = templateForm;
$('#addTemplate').addEventListener('click', () => templateForm());

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

function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '').replace(/^00/, '');
  const cc = state.settings.defaultCountryCode;
  if (cc && d.length === 10) d = cc + d;
  if (cc && d.length === 11 && d.startsWith('0')) d = cc + d.slice(1);
  return d.length >= 8 && d.length <= 15 ? d : null;
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

function fill(text, where, values, neutral = false) {
  return esc(text).replace(/{{\s*([\w]+)\s*}}/g, (_, name) => {
    const val = values[`${where}.${name}`];
    const key = `data-var="${esc(`${where}.${name}`)}"`;
    return val ? `<span class="var" ${key}>${esc(val)}</span>` : `<span class="var ${neutral ? '' : 'empty'}" ${key}>{{${esc(name)}}}</span>`;
  });
}

// WhatsApp bubble for a template. Unfilled variables show as {{name}} chips.
function bubbleHtml(t, values, neutral = false) {
  let html = '';
  const h = comp(t, 'HEADER');
  if (h) {
    if (h.format === 'TEXT') html += `<div class="hdr">${fill(h.text, 'header', values, neutral)}</div>`;
    else {
      const url = values['header.media'];
      const isImg = h.format === 'IMAGE' && /^https?:\/\//.test(url || '');
      html += `<div class="media" ${isImg ? `style="background-image:url('${esc(url)}')"` : ''}>${isImg ? '' : esc(h.format.toLowerCase())}</div>`;
    }
  }
  html += `<div>${fill(comp(t, 'BODY')?.text || '', 'body', values, neutral)}</div>`;
  const f = comp(t, 'FOOTER');
  if (f) html += `<div class="ftr">${esc(f.text)}</div>`;
  const b = comp(t, 'BUTTONS');
  if (b?.buttons?.length) html += `<div class="btns">${b.buttons.map((x) => `<div>${x.type === 'URL' ? '↗ ' : x.type === 'PHONE_NUMBER' ? '✆ ' : '↩ '}${esc(x.text)}</div>`).join('')}</div>`;
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
  $('#seedBtn').classList.toggle('hidden', live || st.hasSeed);
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
  const s = st.setup;
  const steps = [
    { done: s.sender, title: 'Add a WhatsApp number', text: 'Phone number ID and token from Meta. A placeholder is fine for demo mode.', action: `<button class="btn sm" onclick="senderForm()">${icon('plus', 15)}Add number</button>` },
    { done: s.template, title: 'Add a template', text: 'Sync approved templates from Meta, or add one by hand.', action: `<button class="btn sm" data-goto="templates">${icon('file-text', 15)}Templates</button>` },
    { done: s.campaign, title: 'Send a campaign', text: 'Upload contacts, pick who to message and press send.', action: `<button class="btn sm" data-goto="send">${icon('send', 15)}Start</button>` },
    { done: s.live && s.token, title: 'Go live', text: 'Add your API token and switch off demo mode in Settings.', action: `<button class="btn sm" data-goto="settings">${icon('rocket', 15)}Go live</button>` },
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
        <div class="health-total"><b data-count="${s.sent}" data-k="hs-${s.id}">0</b>sent · ${pct(s.delivered, s.sent)}% delivered</div>
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
      return `<div class="mini-item" data-open-campaign="${c.id}">
        <div class="mini-title">${esc(c.name)}</div>
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
  $('#acctWs').textContent = workspace.name;
  $('#acctUser').textContent = user.name || user.email;
  $('#wsName').value = workspace.name;
  $('#wsName').disabled = $('#wsSave').disabled = state.me.role !== 'owner';
  $('#acctMe').innerHTML = `<span class="acct-av lg" style="${avatarStyle(user.email)}">${esc(initials)}</span><span class="acct-text"><b>${esc(user.name || user.email)}</b><span>${esc(user.email)}</span></span><span class="pill ${state.me.role === 'owner' ? 'scheduled' : ''}">${state.me.role === 'owner' ? 'Owner' : 'Member'}</span>`;
  $('#inviteBox').classList.toggle('hidden', state.me.role !== 'owner');
  document.title = `${workspace.name} · WhatsApp Sender`;
  $('#verifyBanner').classList.toggle('hidden', user.emailVerified);
  $('#verifyEmail').textContent = user.email;
  $('#inviteNote').textContent = state.me.mail ? 'They get an email with a link to join. Links work for 7 days.' : 'Email isn’t set up yet, so copy the link and send it yourself. Links work for 7 days.';
}
$('#verifyResend').addEventListener('click', (e) => guard(async () => {
  const r = await api('/account/verify-email', { method: 'POST' });
  toast(r.already ? 'Your email is already confirmed' : r.mail ? 'Sent. Check your inbox.' : 'Email isn’t set up on this server yet');
  if (r.already) loadMe();
}, e.target));
async function loadTeam() {
  const t = await api('/team');
  $('#teamCount').textContent = `${t.members.length} ${t.members.length === 1 ? 'person' : 'people'}${t.invites.length ? ` · ${t.invites.length} invited` : ''}`;
  $('#teamList').innerHTML = t.members.map((m) => `<div class="team-row"><span class="acct-av sm" style="${avatarStyle(m.email)}">${esc((m.name || m.email).slice(0, 1).toUpperCase())}</span>
      <span class="team-who"><b>${esc(m.name)}${m.you ? ' <span class="muted">(you)</span>' : ''}</b><span>${esc(m.email)}</span></span>
      <span class="pill ${m.role === 'owner' ? 'scheduled' : ''}">${m.role}</span>
      ${t.role === 'owner' && !m.you ? `<button class="btn sm quiet" data-member="${m.id}" data-role="${m.role === 'owner' ? 'member' : 'owner'}">${m.role === 'owner' ? 'Make member' : 'Make owner'}</button><button class="btn sm quiet danger" data-remove="${m.id}">Remove</button>` : ''}
      ${m.you && t.members.length > 1 ? `<button class="btn sm quiet danger" data-remove="${m.id}">Leave</button>` : ''}
    </div>`).join('') + t.invites.map((i) => `<div class="team-row invited"><span class="acct-av sm">✉</span><span class="team-who"><b>${esc(i.email)}</b><span>Invited · expires ${new Date(i.expiresAt).toLocaleDateString()}</span></span><span class="pill">${i.role}</span><button class="btn sm quiet" data-uninvite="${i.id}">Cancel</button></div>`).join('');
}
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
      if (ws.dataset.ws !== me.workspace.id) guard(async () => { await api('/workspace/switch', { method: 'POST', body: { id: ws.dataset.ws } }); location.reload(); });
    }
    if (act === 'team') { Sheet.Menu.close(); showTab('settings'); $('#acctCard').scrollIntoView({ behavior: 'smooth' }); }
    if (act === 'admin') location.href = '/admin.html';
  });
});
// Edit your own name and email (a new email needs your password, then a confirmation link).
$('#acctEdit').addEventListener('click', () => {
  const u = state.me.user;
  const body = openModal('Edit your account', `
    <label>Your name<input id="aeName" maxlength="80" value="${esc(u.name || '')}" autocomplete="name" /></label>
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
$('#wsNew').addEventListener('click', async () => {
  const body = openModal('New workspace', `<p class="sub" style="margin-top:-6px">A separate, empty workspace for another business. You can switch between them from the sidebar.</p><label>Business name<input id="nwName" maxlength="80" /></label><div class="modal-actions"><button class="btn quiet" id="nwCancel">Cancel</button><button class="btn primary" id="nwGo">Create</button></div>`);
  $('#nwName', body).focus();
  $('#nwCancel', body).onclick = closeModal;
  $('#nwGo', body).onclick = (e) => guard(async () => { await api('/workspaces', { method: 'POST', body: { name: $('#nwName', body).value } }); location.reload(); }, e.target);
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
$('#inviteBtn').addEventListener('click', (e) => guard(async () => {
  const r = await api('/team/invites', { method: 'POST', body: { email: $('#inviteEmail').value } });
  $('#inviteOut').classList.remove('hidden');
  toast(r.emailed ? 'Invite emailed. You can also copy the link.' : 'Invite created. Copy the link and send it to them.');
  $('#inviteOut').innerHTML = `<input readonly value="${esc(r.link)}" id="inviteLink" /><button class="btn sm" id="inviteCopy">Copy link</button>`;
  $('#inviteCopy').onclick = () => { navigator.clipboard.writeText(r.link); toast('Invite link copied'); };
  $('#inviteEmail').value = '';
  loadTeam();
}, e.target));
$('#teamList').addEventListener('click', async (e) => {
  const rm = e.target.closest('[data-remove]'), un = e.target.closest('[data-uninvite]'), mr = e.target.closest('[data-member]');
  if (rm) {
    const self = rm.dataset.remove === state.me.user.id;
    if (!(await confirmDialog({ title: self ? 'Leave this workspace?' : 'Remove this teammate?', message: self ? 'You lose access until someone invites you again.' : 'They lose access to this workspace straight away.', confirmText: self ? 'Leave' : 'Remove', danger: true }))) return;
    await guard(async () => { await api('/team/members/' + rm.dataset.remove, { method: 'DELETE' }); if (self) location.href = '/'; else loadTeam(); });
  }
  if (un) guard(async () => { await api('/team/invites/' + un.dataset.uninvite, { method: 'DELETE' }); loadTeam(); });
  if (mr) guard(async () => { await api('/team/members/' + mr.dataset.member, { method: 'PATCH', body: { role: mr.dataset.role } }); loadTeam(); });
});

(async () => {
  try {
    await loadMe().catch(() => {});
    loadTeam().catch(() => {});
    state.settings = await api('/settings');
    renderSettings();
    await Promise.all([loadSenders(), loadTemplates()]);
    const tab = location.hash.slice(1);
    showTab(tab && $('#tab-' + tab) ? tab : 'overview');
  } catch (e) {
    toast('Could not reach the server: ' + e.message, 'error');
  }
})();
