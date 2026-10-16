// WhatsApp Sender — dashboard (vanilla JS, no build step).

const state = {
  settings: {},
  senders: [],
  templates: [],
  campaigns: [],
  csv: { headers: [], rows: [], fileName: '' },
  // Per-row phone check, parallel to csv.rows: { phone, status: 'valid' | 'invalid' | 'duplicate' }
  meta: [],
  table: { sort: { col: null, dir: 1 }, filters: {}, search: '', page: 0, pageSize: 50, view: [], anchor: null },
  selected: new Set(), // row indices
  sendMode: 'now',
  mapping: {}, // variable key -> { type: 'column' | 'fixed', value }
  selectedSenders: new Set(),
  detailId: null,
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

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = icon(type === 'error' ? 'badge-alert' : 'circle-check', 16);
  el.append(document.createTextNode(msg));
  $('#toasts').append(el);
  requestAnimationFrame(() => LA.play(el));
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }, type === 'error' ? 6000 : 3500);
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
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  const wasHidden = $('#tab-' + name)?.classList.contains('hidden');
  $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + name));
  if (wasHidden) Motion.enter($('#tab-' + name));
  // The inbox needs the width: the sidebar shrinks to icons while it's open.
  document.body.classList.toggle('nav-mini', name === 'inbox');
  if (name === 'inbox') window.Inbox?.show();
  Motion.segs();
  syncSplitMode();
  if (name === 'send') fitSplit();
  if (name === 'campaigns') loadCampaigns();
  if (name !== 'campaigns') stopPolling();
  if (name === 'overview') loadOverview().catch((e) => toast(e.message, 'error'));
  else stopOverviewPolling();
  if (name === 'numbers') refreshStats().then(renderSenders).catch(() => {});
  hideTip();
  history.replaceState(null, '', '#' + name);
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
window.addEventListener('hashchange', () => {
  const tab = location.hash.slice(1);
  if ($('#tab-' + tab)?.classList.contains('hidden')) showTab(tab);
});

function renderThemeSeg() {
  $$('#themeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.themeSet === document.documentElement.dataset.theme));
}
$('#themeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-set]');
  if (!b) return;
  Motion.themeFade();
  window.applyTheme(b.dataset.themeSet);
  try { localStorage.setItem('theme', b.dataset.themeSet); } catch {}
  renderThemeSeg();
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
function confirmDialog({ title, message = '', confirmText = 'OK', danger = false }) {
  return new Promise((resolve) => {
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').innerHTML = message;
    const yes = $('#confirmYes');
    yes.textContent = confirmText;
    yes.className = 'btn ' + (danger ? 'danger-solid' : 'primary');
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
  if (state.csv.rows.length) { computeMeta(); renderTable(); }
  renderSendSummary();
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
// Send: template + senders
// ---------------------------------------------------------------------------

const currentTemplate = () => state.templates.find((t) => t.id === $('#templateSelect').value);

function renderTemplateSelect() {
  const sel = $('#templateSelect');
  const prev = sel.value;
  sel.innerHTML = state.templates.length
    ? `<option value="">— Choose a template —</option>` +
      state.templates.map((t) => `<option value="${t.id}" ${t.status !== 'APPROVED' && t.status !== 'MANUAL' ? 'disabled' : ''}>${esc(t.name)} (${esc(t.language)})${t.status !== 'APPROVED' ? ' · ' + esc(t.status) : ''}</option>`).join('')
    : `<option value="">No templates — add one in the Templates tab</option>`;
  if (state.templates.some((t) => t.id === prev)) sel.value = prev;
  onTemplateChange();
}

function renderSenderChecks() {
  const enabled = state.senders.filter((s) => s.enabled);
  $('#senderChecks').innerHTML = enabled.length
    ? enabled
        .map((s) => `<label class="toggle-item"><span><span class="ti-name">${esc(s.label)}</span><br/><span class="ti-meta">${esc(s.displayPhone || 'ID ' + s.phoneNumberId)}</span></span>${toggleHtml({ checked: state.selectedSenders.has(s.id), attrs: `value="${s.id}"`, size: 'sm' })}</label>`)
        .join('')
    : `<div class="empty-note">No numbers yet. <a href="#" data-goto="numbers">Add one</a> to start sending.</div>`;
  renderSendSummary();
}

$('#senderChecks').addEventListener('change', (e) => {
  if (e.target.checked) state.selectedSenders.add(e.target.value);
  else state.selectedSenders.delete(e.target.value);
  renderSendSummary();
});

$('#templateSelect').addEventListener('change', onTemplateChange);

function onTemplateChange() {
  const t = currentTemplate();
  const next = {};
  for (const v of t?.variables || []) next[v.key] = state.mapping[v.key] || autoMap(v);
  state.mapping = next;
  renderMapping();
  renderPreview();
  renderSendSummary();
}

// ---------------------------------------------------------------------------
// Send: recipients — file upload, data table, sort / filter / selection
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

async function readFile(file) {
  if (/\.xlsx?$/i.test(file.name)) {
    const XLSX = await loadXlsxLib();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    // raw: true keeps long phone numbers as digits instead of "9.19E+11".
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
    return grid.map((r) => r.map((c) => (c == null ? '' : String(c))));
  }
  return parseCsv(await file.text());
}

const looksLikePhone = (v) => /^\+?[\d\s\-().]{8,}$/.test(String(v).trim());

function loadGrid(grid, fileName = '') {
  const rows = grid.filter((r) => r.some((c) => String(c).trim()));
  if (!rows.length) {
    state.csv = { headers: [], rows: [], fileName: '' };
  } else {
    const hasHeader = !rows[0].some(looksLikePhone);
    const width = Math.max(...rows.map((r) => r.length));
    const headers = [];
    for (let i = 0; i < width; i++) {
      let h = (hasHeader ? String(rows[0][i] ?? '').trim() : '') || `Column ${i + 1}`;
      while (headers.includes(h)) h += ' (2)';
      headers.push(h);
    }
    const data = (hasHeader ? rows.slice(1) : rows).map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()])));
    state.csv = { headers, rows: data, fileName };
  }
  state.table = { ...state.table, sort: { col: null, dir: 1 }, filters: {}, search: '', page: 0, anchor: null };
  $('#tableSearch').value = '';
  const { headers } = state.csv;
  $('#phoneColumn').innerHTML = headers.map((h) => `<option>${esc(h)}</option>`).join('');
  if (headers.length) $('#phoneColumn').value = guessPhoneColumn();
  computeMeta();
  // Start with every valid, non-duplicate number selected.
  state.selected = new Set(state.meta.map((m, i) => (m.status === 'valid' ? i : -1)).filter((i) => i >= 0));
  $('#dropzone').classList.toggle('hidden', Boolean(headers.length));
  $('#clearCsv').classList.toggle('hidden', !headers.length);
  $('#splitBtn').classList.toggle('hidden', !headers.length);
  applySplit(Boolean(headers.length) && state.splitPref, { animate: false });
  $('#tableArea').classList.toggle('hidden', !headers.length);
  if (headers.length) $('#pasteWrap').classList.add('hidden');
  renderTable();
  onTemplateChange();
}

// --- Split view: contacts table on the left, message setup on the right ---
state.splitPref = (() => { try { return localStorage.getItem('splitView') === '1'; } catch { return false; } })();

function applySplit(on, { animate = true } = {}) {
  const tab = $('#tab-send');
  if (tab.classList.contains('split') === on) return;
  const change = () => {
    tab.classList.toggle('split', on);
    $('#splitBtn').setAttribute('aria-pressed', on);
    $('#splitBtn').lastChild.textContent = on ? 'Stacked view' : 'Split view';
    syncSplitMode();
    if (on) scrollTo({ top: 0 });
    fitSplit();
  };
  // View Transitions morph every card from its old box to its new one.
  if (animate && document.startViewTransition && !Motion.reduce() && !tab.classList.contains('hidden')) {
    document.documentElement.classList.add('vt-split');
    const vt = document.startViewTransition(change);
    vt.finished.finally(() => document.documentElement.classList.remove('vt-split'));
  } else change();
}

// Split view is a full-height workspace: sheet on the left, setup panel on the right.
function syncSplitMode() {
  const on = $('#tab-send').classList.contains('split') && !$('#tab-send').classList.contains('hidden');
  document.body.classList.toggle('split-mode', on);
}
function fitSplit() {
  const tab = $('#tab-send');
  if (!tab.classList.contains('split')) return;
  const top = tab.getBoundingClientRect().top + scrollY;
  tab.style.setProperty('--split-h', Math.max(520, innerHeight - top - 16) + 'px');
}
addEventListener('resize', fitSplit);

// Drag (or arrow-key) the divider to resize the setup panel; remembered per browser.
(() => {
  const handle = $('#splitHandle');
  const tab = $('#tab-send');
  const clamp = (w) => Math.round(Math.max(340, Math.min(tab.clientWidth * 0.6, w)));
  const set = (w) => { tab.style.setProperty('--side-w', clamp(w) + 'px'); };
  const save = () => { try { localStorage.setItem('splitSide', parseInt(getComputedStyle(tab).getPropertyValue('--side-w'))); } catch {} };
  try { const w = Number(localStorage.getItem('splitSide')); if (w) tab.style.setProperty('--side-w', w + 'px'); } catch {}
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const right = tab.getBoundingClientRect().right;
    const move = (ev) => set(right - ev.clientX - 5);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing');
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = $('.grid-2', tab).getBoundingClientRect().width;
    set(cur + (e.key === 'ArrowLeft' ? 24 : -24));
    save();
  });
  handle.addEventListener('dblclick', () => { set(440); save(); });
})();

$('#splitBtn').addEventListener('click', () => {
  state.splitPref = !$('#tab-send').classList.contains('split');
  try { localStorage.setItem('splitView', state.splitPref ? '1' : '0'); } catch {}
  applySplit(state.splitPref);
});

function guessPhoneColumn() {
  const { headers, rows } = state.csv;
  const sample = rows.slice(0, 50);
  return (
    headers.find((h) => /phone|mobile|whatsapp|number|contact|msisdn|cell/i.test(h)) ||
    headers.slice().sort((a, b) => sample.filter((r) => looksLikePhone(r[b])).length - sample.filter((r) => looksLikePhone(r[a])).length)[0]
  );
}

function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '').replace(/^00/, '');
  const cc = state.settings.defaultCountryCode;
  if (cc && d.length === 10) d = cc + d;
  if (cc && d.length === 11 && d.startsWith('0')) d = cc + d.slice(1);
  return d.length >= 8 && d.length <= 15 ? d : null;
}

function computeMeta() {
  const col = $('#phoneColumn').value;
  const seen = new Set();
  state.meta = state.csv.rows.map((r) => {
    const phone = normalizePhone(r[col]);
    if (!phone) return { phone, status: 'invalid' };
    if (seen.has(phone)) return { phone, status: 'duplicate' };
    seen.add(phone);
    return { phone, status: 'valid' };
  });
  for (const i of [...state.selected]) if (state.meta[i]?.status === 'invalid') state.selected.delete(i);
}

const STATUS_COL = '__status';
const cellValue = (i, col) => (col === STATUS_COL ? state.meta[i].status : state.csv.rows[i][col] ?? '');
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Filter syntax: plain text = contains · "!text" = doesn't contain · "=x" exact · ">10", "<=5" numeric.
function matches(value, filter, exact) {
  const v = String(value);
  if (exact) return filter === '(empty)' ? v === '' : v === filter;
  const f = filter.trim();
  const num = f.match(/^(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/);
  if (num) {
    const n = parseFloat(v.replace(/,/g, ''));
    if (isNaN(n)) return false;
    const t = parseFloat(num[2]);
    return { '>': n > t, '<': n < t, '>=': n >= t, '<=': n <= t, '=': n === t }[num[1]];
  }
  if (f.startsWith('!')) return !v.toLowerCase().includes(f.slice(1).toLowerCase());
  if (f.startsWith('=')) return v.toLowerCase() === f.slice(1).toLowerCase();
  return v.toLowerCase().includes(f.toLowerCase());
}

function computeView() {
  const { rows, headers } = state.csv;
  const { filters, search, sort } = state.table;
  const active = Object.entries(filters).filter(([, f]) => f.value !== '');
  const q = search.trim().toLowerCase();
  let view = [];
  for (let i = 0; i < rows.length; i++) {
    if (q && !headers.some((h) => String(rows[i][h]).toLowerCase().includes(q))) continue;
    if (!active.every(([col, f]) => matches(cellValue(i, col), f.value, f.exact))) continue;
    view.push(i);
  }
  if (sort.col) view.sort((a, b) => sort.dir * collator.compare(String(cellValue(a, sort.col)), String(cellValue(b, sort.col))) || a - b);
  state.table.view = view;
  const pages = Math.max(1, Math.ceil(view.length / state.table.pageSize));
  if (state.table.page >= pages) state.table.page = pages - 1;
  return view;
}

// Columns with only a few different values get a dropdown filter instead of a text box.
function distinctValues(col) {
  const set = new Set();
  for (let i = 0; i < state.csv.rows.length; i++) {
    set.add(cellValue(i, col));
    if (set.size > 15) return null;
  }
  return state.csv.rows.length > 5 ? [...set].sort(collator.compare) : null;
}

// Spreadsheet-style column letters: A, B, … Z, AA, AB, …
function colLetter(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

function renderTable() {
  const { headers } = state.csv;
  if (!headers.length) return;
  const { sort, filters } = state.table;
  const cols = [STATUS_COL, ...headers];
  const label = (c) => (c === STATUS_COL ? 'Number check' : c);
  const arrow = (c) => (sort.col === c ? (sort.dir > 0 ? '▲' : '▼') : '↕');

  const filterCell = (c) => {
    const f = filters[c]?.value ?? '';
    const opts = c === STATUS_COL ? ['valid', 'duplicate', 'invalid'] : distinctValues(c);
    if (opts) {
      return `<select data-filter="${esc(c)}" data-exact="1" class="${f ? 'active' : ''}"><option value="">All</option>${opts
        .map((o) => `<option value="${esc(o === '' ? '(empty)' : o)}" ${f === (o === '' ? '(empty)' : o) ? 'selected' : ''}>${esc(o === '' ? '(empty)' : o)}</option>`)
        .join('')}</select>`;
    }
    return `<input data-filter="${esc(c)}" value="${esc(f)}" class="${f ? 'active' : ''}" placeholder="Filter…" title="Text = contains · !text = not contains · =text exact · >10, <5, >=, <= for numbers" />`;
  };

  $('#dataTable thead').innerHTML = `
    <tr class="heads">
      <th class="sel"><input type="checkbox" class="cb" id="selPage" title="Select / unselect all filtered rows" /></th>
      <th>#</th>
      ${cols.map((c, i) => `<th class="sortable ${sort.col === c ? 'sorted' : ''}" data-sort="${esc(c)}"><span class="col-letter">${colLetter(i)}</span>${esc(label(c))}<span class="arrow">${arrow(c)}</span></th>`).join('')}
    </tr>
    <tr class="filters"><th></th><th></th>${cols.map((c) => `<th>${filterCell(c)}</th>`).join('')}</tr>`;
  const headRow = $('#dataTable thead tr.heads');
  $('#dataTable').style.setProperty('--head-h', headRow.offsetHeight + 'px');
  renderBody();
}

function renderBody() {
  const { headers, rows, fileName } = state.csv;
  const view = computeView();
  const { page, pageSize, anchor } = state.table;
  const start = page * pageSize;
  const slice = view.slice(start, start + pageSize);

  $('#dataTable tbody').innerHTML = slice.length
    ? slice
        .map((i) => {
          const m = state.meta[i];
          const sel = state.selected.has(i);
          const cls = [sel && 'selected', m.status === 'invalid' && 'invalid', anchor === i && 'anchor'].filter(Boolean).join(' ');
          return `<tr data-i="${i}" class="${cls}">
            <td class="sel"><input type="checkbox" class="cb" ${sel ? 'checked' : ''} ${m.status === 'invalid' ? 'disabled' : ''} tabindex="-1" /></td>
            <td class="idx">${i + 1}</td>
            <td><span class="pill ${m.status}" title="${m.phone ? '+' + m.phone : 'Not a valid phone number'}">${m.status}</span></td>
            ${headers.map((h) => (rows[i][h] === '' ? '<td class="empty-cell">—</td>' : `<td>${esc(rows[i][h])}</td>`)).join('')}
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="${headers.length + 3}" class="table-empty">No rows match these filters.</td></tr>`;

  // Header checkbox reflects the filtered view.
  const selectable = view.filter((i) => state.meta[i].status !== 'invalid');
  const selInView = selectable.filter((i) => state.selected.has(i)).length;
  const cb = $('#selPage');
  cb.checked = selectable.length > 0 && selInView === selectable.length;
  cb.indeterminate = selInView > 0 && selInView < selectable.length;

  const pages = Math.max(1, Math.ceil(view.length / pageSize));
  const filtered = view.length !== rows.length;
  $('#tableFoot').innerHTML = `
    <span>${view.length ? `Showing ${(start + 1).toLocaleString()}–${Math.min(start + pageSize, view.length).toLocaleString()} of ${view.length.toLocaleString()}` : '0 rows'}${filtered ? ` (filtered from ${rows.length.toLocaleString()})` : ''}</span>
    <div class="foot-right">
    <label class="inline">Rows per page <select id="pageSize">${[25, 50, 100, 250].map((n) => `<option ${n === pageSize ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <div class="seg">
      <button data-page="first" ${page === 0 ? 'disabled' : ''} title="First page">«</button>
      <button data-page="prev" ${page === 0 ? 'disabled' : ''} title="Previous page">‹</button>
      <span>Page ${page + 1} / ${pages}</span>
      <button data-page="next" ${page >= pages - 1 ? 'disabled' : ''} title="Next page">›</button>
      <button data-page="last" ${page >= pages - 1 ? 'disabled' : ''} title="Last page">»</button>
    </div>
    </div>`;

  const counts = state.meta.reduce((a, m) => ((a[m.status] = (a[m.status] || 0) + 1), a), {});
  $('#fileInfo').innerHTML = `<span>${esc(fileName || 'Pasted data')}</span>
    <span class="muted" style="font-weight:400">${rows.length.toLocaleString()} rows · ${headers.length} columns</span>
    <span class="pill valid">${(counts.valid || 0).toLocaleString()} valid</span>
    ${counts.invalid ? `<span class="pill invalid">${counts.invalid} invalid</span>` : ''}
    ${counts.duplicate ? `<span class="pill duplicate">${counts.duplicate} duplicate</span>` : ''}`;
  $('#selInfo').innerHTML = `<b>${state.selected.size.toLocaleString()}</b> of ${rows.length.toLocaleString()} selected`;
  renderSendSummary();
  renderPreview();
}

// --- table events ---

$('#dataTable').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (th) {
    const col = th.dataset.sort;
    const s = state.table.sort;
    // Click cycles: ascending → descending → original order.
    if (s.col !== col) state.table.sort = { col, dir: 1 };
    else if (s.dir === 1) s.dir = -1;
    else state.table.sort = { col: null, dir: 1 };
    renderTable();
    return;
  }
  if (e.target.id === 'selPage') {
    const selectable = state.table.view.filter((i) => state.meta[i].status !== 'invalid');
    const allOn = selectable.every((i) => state.selected.has(i));
    selectable.forEach((i) => (allOn ? state.selected.delete(i) : state.selected.add(i)));
    renderBody();
    return;
  }
  const tr = e.target.closest('tbody tr[data-i]');
  if (!tr) return;
  const i = Number(tr.dataset.i);
  if (state.meta[i].status === 'invalid') return;
  const turnOn = !state.selected.has(i);
  const { anchor, view } = state.table;
  if (e.shiftKey && anchor !== null && view.includes(anchor)) {
    // Shift-click: apply to every row between the last clicked row and this one, in the current sort/filter order.
    const [a, b] = [view.indexOf(anchor), view.indexOf(i)].sort((x, y) => x - y);
    for (let k = a; k <= b; k++) {
      const idx = view[k];
      if (state.meta[idx].status === 'invalid') continue;
      turnOn ? state.selected.add(idx) : state.selected.delete(idx);
    }
  } else {
    turnOn ? state.selected.add(i) : state.selected.delete(i);
  }
  state.table.anchor = i;
  renderBody();
});

// Stop the browser from highlighting text on shift-click.
$('#dataTable').addEventListener('mousedown', (e) => { if (e.shiftKey && e.target.closest('tbody')) e.preventDefault(); });

let filterDebounce;
$('#dataTable').addEventListener('input', (e) => {
  const col = e.target.dataset.filter;
  if (col === undefined) return;
  state.table.filters[col] = { value: e.target.value, exact: e.target.dataset.exact === '1' };
  e.target.classList.toggle('active', e.target.value !== '');
  state.table.page = 0;
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(renderBody, e.target.tagName === 'SELECT' ? 0 : 150);
});

$('#tableSearch').addEventListener('input', (e) => {
  state.table.search = e.target.value;
  state.table.page = 0;
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(renderBody, 150);
});

$('#tableFoot').addEventListener('click', (e) => {
  const b = e.target.closest('[data-page]');
  if (!b) return;
  const pages = Math.ceil(state.table.view.length / state.table.pageSize);
  const t = state.table;
  t.page = { first: 0, prev: t.page - 1, next: t.page + 1, last: pages - 1 }[b.dataset.page];
  renderBody();
  $('#tableScroll').scrollTop = 0;
});

$('#tableFoot').addEventListener('change', (e) => {
  if (e.target.id !== 'pageSize') return;
  state.table.pageSize = Number(e.target.value);
  state.table.page = 0;
  renderBody();
});
$('#phoneColumn').addEventListener('change', () => { computeMeta(); renderTable(); });

$('#selFiltered').addEventListener('click', () => {
  state.table.view.forEach((i) => state.meta[i].status !== 'invalid' && state.selected.add(i));
  renderBody();
});
$('#unselFiltered').addEventListener('click', () => {
  state.table.view.forEach((i) => state.selected.delete(i));
  renderBody();
});
$('#selNone').addEventListener('click', () => { state.selected.clear(); renderBody(); });
$('#clearFilters').addEventListener('click', () => {
  Object.assign(state.table, { filters: {}, search: '', page: 0, sort: { col: null, dir: 1 } });
  $('#tableSearch').value = '';
  renderTable();
});

// --- loading data ---

async function handleFile(file) {
  if (!file) return;
  await guard(async () => {
    const grid = await readFile(file);
    loadGrid(grid, file.name);
    $('#csvText').value = '';
    toast(`Loaded ${state.csv.rows.length.toLocaleString()} rows from ${file.name}`);
  });
}

$$('.fileInput').forEach((inp) => inp.addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; }));

const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
// Dropping anywhere on the recipients card works too.
$('#recipientsCard').addEventListener('dragover', (e) => e.preventDefault());
$('#recipientsCard').addEventListener('drop', (e) => { if (!dz.contains(e.target)) { e.preventDefault(); handleFile(e.dataTransfer.files[0]); } });

$('#togglePaste').addEventListener('click', () => {
  $('#pasteWrap').classList.toggle('hidden');
  if (!$('#pasteWrap').classList.contains('hidden')) $('#csvText').focus();
});
let csvDebounce;
$('#csvText').addEventListener('input', () => {
  clearTimeout(csvDebounce);
  csvDebounce = setTimeout(() => {
    loadGrid(parseCsv($('#csvText').value));
    $('#pasteWrap').classList.remove('hidden');
  }, 300);
});
$('#sampleCsv').addEventListener('click', () => {
  const names = ['Ravi', 'Priya', 'Amit', 'Sneha', 'Karan', 'Pooja', 'Arjun', 'Neha', 'Vikram', 'Anjali', 'Rohit', 'Kavya'];
  const cities = ['Pune', 'Delhi', 'Mumbai', 'Bengaluru', 'Hyderabad'];
  const grid = [['phone', 'name', 'city', 'plan', 'orders']];
  for (let k = 0; k < 120; k++) {
    const n = names[k % names.length];
    grid.push([String(9800000000 + k * 7919), `${n} ${String.fromCharCode(65 + (k % 26))}.`, cities[k % 5], ['Gold', 'Silver', 'Free'][k % 3], String((k * 37) % 50)]);
  }
  grid.push(['12345', 'Bad number', 'Pune', 'Free', '0']);
  grid.push([grid[1][0], 'Duplicate of row 1', 'Delhi', 'Gold', '3']);
  loadGrid(grid, 'sample-contacts.csv');
});
$('#clearCsv').addEventListener('click', () => {
  $('#csvText').value = '';
  state.selected.clear();
  loadGrid([]);
});

function validRecipients() {
  const seen = new Set();
  let dupes = 0;
  for (const i of state.selected) {
    const p = state.meta[i]?.phone;
    if (!p) continue;
    if (seen.has(p)) dupes++;
    else seen.add(p);
  }
  return { count: seen.size, dupes };
}

// Row used for the preview and test message: first selected row in table order.
function previewRow() {
  const i = state.table.view.find((x) => state.selected.has(x)) ?? [...state.selected][0];
  return state.csv.rows[i ?? 0];
}

// ---------------------------------------------------------------------------
// Send: variable mapping + preview
// ---------------------------------------------------------------------------

function autoMap(v) {
  const match = state.csv.headers.find((h) => h.toLowerCase() === v.name.toLowerCase());
  return match ? { type: 'column', value: match } : { type: 'fixed', value: '' };
}

const varLabel = (v) => (v.media ? `header ${v.media} URL` : `${v.where} {{${v.name}}}`);

function renderMapping() {
  const t = currentTemplate();
  const el = $('#mapping');
  if (!t) { el.innerHTML = '<p class="sub">Pick a template to see what you can personalise.</p>'; return; }
  if (!t.variables.length) { el.innerHTML = '<p class="sub">This template has no variables, so everyone gets the same message.</p>'; return; }
  const cols = state.csv.headers;
  el.innerHTML =
    `<p class="sub" style="margin-bottom:6px">Fill each placeholder from a column in your file, or type the same text for everyone.</p>` +
    t.variables
      .map((v) => {
        const m = state.mapping[v.key];
        const fixed = m.type !== 'column';
        const where = v.media ? 'header media' : v.where.startsWith('button') ? 'button link' : v.where;
        return `<div class="map-row" data-key="${esc(v.key)}">
          <div class="var-key">${esc(v.media ? v.media + ' URL' : `{{${v.name}}}`)}<small>${esc(where)}</small></div>
          <select class="m-src">
            ${cols.length ? `<optgroup label="Column from your file">${cols.map((c, i) => `<option value="c:${i}" ${!fixed && c === m.value ? 'selected' : ''}>${esc(c)}</option>`).join('')}</optgroup>` : ''}
            <option value="fixed" ${fixed ? 'selected' : ''}>Same text for everyone…</option>
          </select>
          ${fixed ? `<input class="m-input m-val" value="${esc(m.value)}" placeholder="${v.media ? 'https://…/image.jpg' : 'Type the text'}" />` : ''}
        </div>`;
      })
      .join('');
}

$('#mapping').addEventListener('input', (e) => {
  const row = e.target.closest('.map-row');
  if (!row) return;
  const key = row.dataset.key;
  if (e.target.classList.contains('m-src')) {
    const v = e.target.value;
    state.mapping[key] = v === 'fixed' ? { type: 'fixed', value: '' } : { type: 'column', value: state.csv.headers[Number(v.slice(2))] };
    renderMapping();
    if (v === 'fixed') $(`.map-row[data-key="${CSS.escape(key)}"] .m-val`)?.focus();
  } else {
    state.mapping[key].value = e.target.value;
  }
  renderPreview();
  renderSendSummary();
});

function valuesForRow(row) {
  const t = currentTemplate();
  const out = {};
  for (const v of t?.variables || []) {
    const m = state.mapping[v.key] || {};
    out[v.key] = m.type === 'column' ? (row?.[m.value] ?? '') : m.value || '';
  }
  return out;
}

function fill(text, where, values, neutral = false) {
  return esc(text).replace(/{{\s*([\w]+)\s*}}/g, (_, name) => {
    const val = values[`${where}.${name}`];
    return val ? `<span class="var">${esc(val)}</span>` : `<span class="var ${neutral ? '' : 'empty'}">{{${esc(name)}}}</span>`;
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

function renderPreview() {
  const t = currentTemplate();
  const el = $('#preview');
  if (!t) { el.innerHTML = '<span class="muted">Select a template</span>'; $('#previewNote').textContent = ''; return; }
  const row = previewRow();
  el.innerHTML = bubbleHtml(t, valuesForRow(row));
  $('#previewNote').textContent = row ? `Showing values for ${row[$('#phoneColumn').value] || 'first row'}` : 'Add recipients to preview personalised values.';
}

function renderSendSummary() {
  const { count, dupes } = validRecipients();
  const nums = state.selectedSenders.size;
  const per = nums ? Math.ceil(count / nums) : 0;
  const t = currentTemplate();
  const emptyVar = t?.variables.find((v) => { const m = state.mapping[v.key]; return !m || (m.type !== 'column' && !String(m.value).trim()); });

  // Tell the user exactly what's missing instead of just disabling the button.
  const why =
    !state.csv.rows.length ? 'Upload your contact list in step 1' :
    !count ? 'Select at least one recipient' :
    !t ? 'Choose a template in step 2' :
    !nums ? 'Turn on at least one sender number' :
    emptyVar ? `Fill in ${emptyVar.media ? 'the ' + emptyVar.media + ' URL' : `{{${emptyVar.name}}}`} in step 3` : '';

  const detail = [
    nums ? `${nums} number${nums === 1 ? '' : 's'} · ~${per.toLocaleString()} each` : '',
    t ? `template ${esc(t.name)}` : '',
    dupes ? `${dupes} duplicate${dupes === 1 ? '' : 's'} skipped` : '',
  ].filter(Boolean).join(' · ');

  $('#sendSummary').innerHTML = `<strong>${count.toLocaleString()} recipient${count === 1 ? '' : 's'}</strong>
    <div>${why ? `<span class="why">${esc(why)}</span>` : detail}</div>`;
  const scheduled = state.sendMode === 'schedule';
  $('#sendAll').innerHTML = `${icon(scheduled ? 'clock' : 'send', 17)}${scheduled ? 'Schedule' : 'Send'}${count ? ' ' + count.toLocaleString() : ''} message${count === 1 ? '' : 's'}`;
  $('#sendAll').disabled = Boolean(why);
}

// Default schedule time: the next quarter hour, at least 30 minutes from now.
function defaultScheduleTime() {
  const d = new Date(Date.now() + 30 * 60 * 1000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return toLocalInput(d);
}
const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

$('#sendMode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  state.sendMode = b.dataset.mode;
  $$('#sendMode button').forEach((x) => x.classList.toggle('active', x === b));
  const input = $('#scheduleAt');
  input.classList.toggle('hidden', state.sendMode !== 'schedule');
  if (state.sendMode === 'schedule') {
    input.min = toLocalInput(new Date());
    if (!input.value) input.value = defaultScheduleTime();
  }
  renderSendSummary();
});

// ---------------------------------------------------------------------------
// Send: actions
// ---------------------------------------------------------------------------

$('#testSend').addEventListener('click', (e) =>
  guard(async () => {
    const t = currentTemplate();
    const senderId = [...state.selectedSenders][0];
    if (!t) throw new Error('Choose a template first');
    if (!senderId) throw new Error('Select a sender number first');
    const values = valuesForRow(previewRow());
    const empty = t.variables.find((v) => !values[v.key]);
    if (empty) throw new Error(`Fill in ${varLabel(empty)} first`);
    const r = await api('/send/test', { method: 'POST', body: { senderId, templateId: t.id, phone: $('#testPhone').value, values } });
    toast(`${r.demo ? '(Demo) ' : ''}Test sent to +${r.to}`);
  }, e.target)
);

$('#sendAll').addEventListener('click', (e) =>
  guard(async () => {
    const t = currentTemplate();
    const { count } = validRecipients();
    const nums = state.selectedSenders.size;
    let scheduledAt = null;
    if (state.sendMode === 'schedule') {
      const when = new Date($('#scheduleAt').value);
      if (isNaN(when)) throw new Error('Pick a date and time to schedule');
      if (when < Date.now()) throw new Error('That time is in the past');
      scheduledAt = when.toISOString();
    }
    const demo = state.settings.demoMode;
    const ok = await confirmDialog({
      title: scheduledAt ? `Schedule ${count.toLocaleString()} messages?` : `Send ${count.toLocaleString()} messages now?`,
      message: `Template <strong>${esc(t.name)}</strong> from ${nums} number${nums === 1 ? '' : 's'}${scheduledAt ? `, on <strong>${esc(new Date(scheduledAt).toLocaleString())}</strong>` : ''}.\n\n${demo ? 'Demo mode: sending is simulated.' : '<strong>Live:</strong> real WhatsApp messages will be sent.'}`,
      confirmText: scheduledAt ? 'Schedule' : 'Send now',
    });
    if (!ok) return;
    const rows = [...state.selected].sort((a, b) => a - b).map((i) => state.csv.rows[i]);
    const c = await api('/campaigns', {
      method: 'POST',
      body: {
        name: $('#campaignName').value.trim(),
        templateId: t.id,
        senderIds: [...state.selectedSenders],
        rows,
        phoneColumn: $('#phoneColumn').value,
        mapping: state.mapping,
        scheduledAt,
      },
    });
    toast(scheduledAt ? `Scheduled ${c.total} messages for ${new Date(scheduledAt).toLocaleString()}` : `Campaign started — ${c.total} messages queued`);
    $('#campaignName').value = '';
    showTab('campaigns');
    openCampaign(c.id);
  }, e.target)
);

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

let pollTimer = null;
const stopPolling = () => { clearTimeout(pollTimer); pollTimer = null; };

function progressBar(stats, total, key = '') {
  const pct = (n) => (total ? (100 * (n || 0)) / total : 0);
  const seg = (cls, v) => `<span class="${cls}" data-w="${pct(v).toFixed(2)}" data-k="${key}-${cls}"></span>`;
  return `<div class="progress">${seg('p-read', stats.read)}${seg('p-delivered', stats.delivered)}${seg('p-sent', stats.sent)}${seg('p-failed', stats.failed)}</div>`;
}

async function loadCampaigns() {
  state.campaigns = await api('/campaigns');
  renderCampaignList();
  if (state.detailId) openCampaign(state.detailId);
  else if (state.campaigns.some((c) => c.status === 'running' || c.status === 'scheduled')) {
    stopPolling();
    pollTimer = setTimeout(loadCampaigns, state.campaigns.some((c) => c.status === 'running') ? 2000 : 10000);
  }
}

const CAMP_FILTERS = [
  ['all', 'All', () => true],
  ['scheduled', 'Scheduled', (c) => c.status === 'scheduled'],
  ['running', 'Sending', (c) => c.status === 'running' || c.status === 'queued'],
  ['completed', 'Completed', (c) => c.status === 'completed'],
  ['stopped', 'Stopped', (c) => c.status === 'stopped' || c.status === 'cancelled'],
];
state.campFilter = 'all';

function renderCampaignList() {
  const el = $('#campaignList');
  el.classList.toggle('hidden', Boolean(state.detailId));
  if (!state.campaigns.length) {
    el.innerHTML = emptyState({
      icon: 'send',
      title: 'No campaigns yet',
      text: 'Every bulk send shows up here with live progress: sent, delivered, read and failed, per recipient.',
      actions: `<button class="btn primary" data-goto="send">${icon('plus', 16)}Create a campaign</button>`,
    });
    return;
  }
  const filter = CAMP_FILTERS.find((f) => f[0] === state.campFilter) || CAMP_FILTERS[0];
  const list = state.campaigns.filter(filter[2]);
  el.innerHTML =
    `<div class="section-head"><div><h1>Campaigns</h1><p class="sub">Every bulk send, with live delivery progress.</p></div><button class="btn primary" data-goto="send">${icon('plus', 16)}New campaign</button></div>
    <div class="seg camp-filters" id="campFilters">${CAMP_FILTERS.map(([k, label, fn]) => {
      const n = state.campaigns.filter(fn).length;
      return `<button data-filter="${k}" class="${k === filter[0] ? 'active' : ''}" ${n || k === 'all' ? '' : 'disabled'}>${label} <span class="opt">${n}</span></button>`;
    }).join('')}</div>` +
    (list.length
      ? list
          .map((c) => {
            const s = c.stats || {};
            const sent = (s.sent || 0) + (s.delivered || 0) + (s.read || 0);
            const delivered = (s.delivered || 0) + (s.read || 0);
            const when = c.status === 'scheduled' ? `<strong>Sends ${relTime(c.scheduledAt)}</strong> · ${fmtDate(c.scheduledAt)}` : fmtDate(c.startedAt || c.createdAt);
            return `<div class="card list-item" data-open="${c.id}">
              <div class="li-head">
                <h3>${esc(c.name)} ${c.demo ? '<span class="pill demo">demo</span>' : ''}</h3>
                <span class="pill ${c.status}">${c.status}</span>
              </div>
              <div class="li-meta">${when} · template <code>${esc(c.templateName)}</code> · ${c.senderIds.length} number${c.senderIds.length === 1 ? '' : 's'}</div>
              ${progressBar(s, c.total, 'cl-' + c.id)}
              <div class="camp-stats">
                <span><b>${c.total.toLocaleString()}</b> recipients</span>
                <span><b>${sent.toLocaleString()}</b> sent</span>
                <span><b>${delivered.toLocaleString()}</b> delivered</span>
                <span><b>${(s.read || 0).toLocaleString()}</b> read</span>
                ${s.failed ? `<span><b>${s.failed.toLocaleString()}</b> failed</span>` : ''}
                ${sent ? `<span class="rate"><b>${pct(delivered, sent)}%</b> delivered · <b>${pct(s.read || 0, delivered)}%</b> read</span>` : ''}
              </div>
            </div>`;
          })
          .join('')
      : `<div class="empty-mini">${icon('send', 18)} Nothing here.</div>`);
  Motion.values(el);
}

$('#campaignList').addEventListener('click', (e) => {
  const f = e.target.closest('[data-filter]');
  if (f && e.target.closest('#campFilters')) { state.campFilter = f.dataset.filter; renderCampaignList(); }
});

$('#campaignList').addEventListener('click', (e) => {
  const item = e.target.closest('[data-open]');
  if (item) openCampaign(item.dataset.open);
});

let detailFilter = 'all';

async function openCampaign(cid) {
  stopPolling();
  state.detailId = cid;
  let c;
  try {
    c = await api('/campaigns/' + cid);
  } catch (e) {
    state.detailId = null;
    toast(e.message, 'error');
    return renderCampaignList();
  }
  $('#campaignList').classList.add('hidden');
  const el = $('#campaignDetail');
  if (el.classList.contains('hidden') || el.dataset.cid !== cid) Motion.enter(el);
  el.dataset.cid = cid;
  el.classList.remove('hidden');
  const s = c.stats;
  const total = c.recipients.length;
  const senders = Object.fromEntries(state.senders.map((x) => [x.id, x.label]));
  const shown = c.recipients.filter((r) => detailFilter === 'all' || r.status === detailFilter);
  const running = c.status === 'running' || c.status === 'queued';

  el.innerHTML = `
    <button class="btn ghost sm" id="backToList">${icon('history', 15)}All campaigns</button>
    <div class="card" style="margin-top:14px">
      <div class="li-head">
        <div>
          <h1>${esc(c.name)}</h1>
          <div class="muted small">Template <code>${esc(c.templateName)}</code> · ${c.senderIds.length} number(s) · created ${fmtDate(c.createdAt)}${c.scheduledAt ? ` · scheduled for <strong>${fmtDate(c.scheduledAt)}</strong>` : ''} ${c.demo ? '· <strong>demo</strong>' : ''}</div>
        </div>
        <span class="pill ${c.status}">${c.status}</span>
      </div>
      <div class="stats">
        <div class="stat"><b data-count="${total}" data-fmt="int" data-k="cd-${c.id}-total">0</b><span>Total</span></div>
        <div class="stat"><b data-count="${(s.pending || 0)}" data-fmt="int" data-k="cd-${c.id}-pending">0</b><span>Pending</span></div>
        <div class="stat"><b data-count="${(s.sent || 0)}" data-fmt="int" data-k="cd-${c.id}-sent">0</b><span>Sent</span></div>
        <div class="stat"><b data-count="${(s.delivered || 0)}" data-fmt="int" data-k="cd-${c.id}-delivered">0</b><span>Delivered</span></div>
        <div class="stat"><b data-count="${(s.read || 0)}" data-fmt="int" data-k="cd-${c.id}-read">0</b><span>Read</span></div>
        <div class="stat"><b data-count="${(s.failed || 0)}" data-fmt="int" data-k="cd-${c.id}-failed">0</b><span>Failed</span></div>
      </div>
      ${progressBar(s, total, 'cd-' + c.id)}
      ${c.skipped?.length ? `<div class="muted small">${c.skipped.length} row(s) skipped (invalid or duplicate numbers).</div>` : ''}
      <div class="row" style="margin-top:14px">
        ${running ? `<button class="btn danger" id="cStop">${icon('badge-alert', 16)}Stop</button>` : ''}
        ${c.status === 'scheduled' ? `<button class="btn primary" id="cResume">${icon('send', 16)}Send now</button><button class="btn danger" id="cCancel">${icon('clock', 16)}Cancel schedule</button>` : ''}
        ${!running && c.status !== 'scheduled' && s.pending ? `<button class="btn primary" id="cResume">${icon('send', 16)}${c.status === 'cancelled' ? 'Send now' : 'Resume'}</button>` : ''}
        ${!running && s.failed ? `<button class="btn secondary" id="cRetry">${icon('refresh-cw', 16)}Retry failed (${s.failed})</button>` : ''}
        <a class="btn ghost" href="/api/campaigns/${c.id}/export.csv">${icon('upload', 16)}Export CSV</a>
        ${!running ? `<button class="btn danger" id="cDelete">${icon('delete', 16)}Delete</button>` : ''}
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="li-head" style="margin-bottom:10px">
        <h2 style="margin:0">Recipients</h2>
        <select id="cFilter" style="width:auto;margin:0">
          ${['all', 'pending', 'sent', 'delivered', 'read', 'failed'].map((f) => `<option value="${f}" ${f === detailFilter ? 'selected' : ''}>${f[0].toUpperCase() + f.slice(1)}${f === 'all' ? '' : ` (${s[f] || 0})`}</option>`).join('')}
        </select>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Phone</th><th>Name</th><th>From</th><th>Status</th><th>Sent</th><th>Error</th></tr></thead>
          <tbody>${shown
            .slice(0, 500)
            .map((r) => `<tr><td>+${esc(r.phone)}</td><td>${esc(r.name)}</td><td>${esc(senders[r.senderId] || '—')}</td><td><span class="pill ${r.status}">${r.status}</span></td><td>${r.sentAt ? new Date(r.sentAt).toLocaleTimeString() : ''}</td><td class="err">${esc(r.error || '')}</td></tr>`)
            .join('')}</tbody>
        </table>
        ${shown.length > 500 ? `<div class="muted small" style="margin-top:8px">Showing 500 of ${shown.length}. Export CSV for the full list.</div>` : ''}
        ${!shown.length ? '<div class="muted" style="padding:16px 0">Nothing here.</div>' : ''}
      </div>
    </div>`;

  Motion.values(el);
  $('#backToList').onclick = () => {
    stopPolling();
    state.detailId = null;
    el.classList.add('hidden');
    loadCampaigns();
  };
  $('#cFilter').onchange = (e) => { detailFilter = e.target.value; openCampaign(cid); };
  const act = (sel, fn) => { const b = $(sel); if (b) b.onclick = () => guard(fn, b); };
  act('#cStop', async () => { await api(`/campaigns/${cid}/stop`, { method: 'POST' }); toast('Stopping…'); });
  act('#cResume', async () => { await api(`/campaigns/${cid}/resume`, { method: 'POST', body: {} }); openCampaign(cid); });
  act('#cRetry', async () => { await api(`/campaigns/${cid}/resume`, { method: 'POST', body: { retryFailed: true } }); openCampaign(cid); });
  act('#cCancel', async () => {
    if (!(await confirmDialog({ title: 'Cancel the schedule?', message: "It won't send automatically. You can still send it manually later.", confirmText: 'Cancel schedule', danger: true }))) return;
    await api(`/campaigns/${cid}/cancel`, { method: 'POST' });
    openCampaign(cid);
  });
  act('#cDelete', async () => {
    if (!(await confirmDialog({ title: 'Delete this campaign?', message: 'Its delivery log is removed too. Export it first if you need it.', confirmText: 'Delete', danger: true }))) return;
    await api('/campaigns/' + cid, { method: 'DELETE' });
    state.detailId = null;
    el.classList.add('hidden');
    loadCampaigns();
  });

  // Keep refreshing while sending, and for a while after so delivered/read updates show up.
  const recent = c.finishedAt && Date.now() - new Date(c.finishedAt) < 5 * 60 * 1000;
  if (running || recent || c.status === 'scheduled') pollTimer = setTimeout(() => state.detailId === cid && openCampaign(cid), running ? 1500 : 4000);
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

(async () => {
  try {
    state.settings = await api('/settings');
    renderSettings();
    await Promise.all([loadSenders(), loadTemplates()]);
    const tab = location.hash.slice(1);
    showTab(tab && $('#tab-' + tab) ? tab : 'overview');
  } catch (e) {
    toast('Could not reach the server: ' + e.message, 'error');
  }
})();
