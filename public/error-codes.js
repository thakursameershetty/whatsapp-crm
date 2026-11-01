// Common error codes Meta's WhatsApp Cloud API sends back, in plain words: what happened, what to do, and whether
// sending again can help. Meta's own list is the source of truth:
// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
// retry: 'yes' = resending can work as is · 'later' = wait, then resend · 'no' = fix the cause first.
(() => {
  const C = {
    message: 'Messages',
    template: 'Templates',
    limit: 'Limits',
    account: 'Account & policy',
    access: 'Access & setup',
    phone: 'Phone number',
    other: 'Other',
  };
  const E = [
    // Messages to people
    [131026, 'message', 'Message undeliverable', "The person's number isn't on WhatsApp, they haven't accepted WhatsApp's latest terms, or their app is too old to receive it.", 'Check the number. If it is right, reach them another way; resending won’t change it.', 'no'],
    [131047, 'message', 'Reply window closed', 'More than 24 hours have passed since the person last messaged you, so only an approved template can be sent.', 'Send a template. Once they reply, you can chat freely again for 24 hours.', 'no'],
    [131049, 'message', 'Meta chose not to deliver', 'WhatsApp limits how many marketing messages one person gets from businesses, to keep their experience good. It isn’t a problem with your number or template.', 'Try again in a day or two. If it is an update rather than an offer, use a Utility template.', 'later'],
    [131050, 'message', 'Person stopped marketing messages', 'This person chose to stop receiving marketing messages from your business.', 'Don’t send them marketing templates. They can still get utility messages and your replies when they write.', 'no'],
    [131021, 'message', 'Recipient is the sender', 'The message was addressed to the same number that sends it.', 'Send to a different number.', 'no'],
    [131030, 'message', 'Number not in allowed list', 'A test number can only message phone numbers added to its allowed list in Meta.', 'Add the number under WhatsApp → API Setup in Meta, or use your real business number.', 'no'],
    [131051, 'message', 'Message type not supported', 'WhatsApp doesn’t support this kind of message.', 'Send a supported type (text, image, document, template…).', 'no'],
    [131052, 'message', 'Media download failed', "Couldn't download the media the person sent.", 'Ask them to send it again.', 'no'],
    [131053, 'message', 'Media upload failed', "Meta couldn't fetch or process the media file you sent (wrong type, too big, or the link isn't reachable).", 'Check the file’s type and size and that its link is public, then resend.', 'yes'],
    [130472, 'message', 'Part of a Meta experiment', "The person's number is in a Meta experiment that holds back marketing messages.", 'Nothing to fix; it’s Meta’s test. Try them again later.', 'later'],
    [131000, 'other', 'Something went wrong at Meta', 'Meta hit an unknown error while sending.', 'Resend. If it keeps happening, check Meta’s status page.', 'yes'],
    [131016, 'other', 'Service unavailable', 'A WhatsApp service is temporarily down.', 'Wait a few minutes and resend.', 'later'],
    [2, 'other', 'Temporary service problem', 'Meta’s API had a temporary problem.', 'Wait a moment and resend.', 'later'],
    [1, 'other', 'Unknown API error', 'Meta reported an unknown error, often temporary.', 'Resend. If it keeps happening, check Meta’s status page.', 'yes'],
    [135000, 'other', 'Generic user error', 'Meta rejected the request for an unspecified reason.', 'Check the message and its values, then resend.', 'no'],

    // Templates
    [132000, 'template', 'Wrong number of variables', 'The values sent don’t match the template’s variables ({{1}}, {{2}}…).', 'Fill every variable the template has, then resend.', 'no'],
    [132001, 'template', 'Template not found', "Meta has no template with this name in this language for this account.", 'Sync templates, and check the name, language and that it belongs to this number’s account.', 'no'],
    [132005, 'template', 'Template text too long', 'With the values filled in, the message is longer than WhatsApp allows.', 'Use shorter values.', 'no'],
    [132007, 'template', 'Template content not allowed', 'The filled-in template breaks WhatsApp’s formatting or content rules.', 'Change the values (or the template) and resend.', 'no'],
    [132012, 'template', 'Variable in the wrong format', 'A value doesn’t match what the template expects (for example text where a link or media is needed).', 'Fix that value and resend.', 'no'],
    [132015, 'template', 'Template paused', 'Meta paused this template because people gave it poor feedback.', 'Use another template, or improve this one in WhatsApp Manager.', 'no'],
    [132016, 'template', 'Template disabled', 'Meta disabled this template after repeated poor feedback.', 'Create a new, improved template.', 'no'],
    [132068, 'template', 'Flow blocked', 'The WhatsApp Flow in this message is blocked.', 'Fix the Flow in WhatsApp Manager.', 'no'],
    [132069, 'template', 'Flow throttled', 'Too many messages with this Flow were sent recently.', 'Wait and resend.', 'later'],

    // Limits
    [130429, 'limit', 'Sending too fast', 'This number hit Meta’s throughput limit (messages per second).', 'Slow down; it goes through if you resend shortly.', 'later'],
    [131056, 'limit', 'Too many messages to one person', 'You sent this person too many messages in a short time.', 'Wait a little before messaging them again.', 'later'],
    [131048, 'limit', 'Spam limit reached', 'Many people blocked or reported this number recently, so Meta is limiting what it can send.', 'Pause campaigns, message only people who opted in, and let quality recover.', 'later'],
    [4, 'limit', 'Too many API calls', 'The app made too many requests to Meta in a short time.', 'Wait a few minutes and resend.', 'later'],
    [80007, 'limit', 'Account rate limit', 'The WhatsApp Business Account hit Meta’s rate limit.', 'Wait and resend.', 'later'],
    [133016, 'limit', 'Too many registration attempts', 'The number was registered or deregistered too many times recently.', 'Wait before trying again.', 'later'],

    // Account & policy
    [131031, 'account', 'Account locked', 'Meta locked the WhatsApp Business Account, usually for a policy problem (often many blocks or reports) or failed verification.', 'Check WhatsApp Manager → Account quality for the reason and request a review. Resend once unlocked.', 'no'],
    [368, 'account', 'Temporarily blocked for policy', 'The account is temporarily blocked for breaking WhatsApp’s policies.', 'Check Account quality in WhatsApp Manager; request a review if it’s a mistake.', 'no'],
    [130497, 'account', 'Country not allowed', 'This business account can’t message people in the recipient’s country.', 'Check your business’s allowed countries in Meta.', 'no'],
    [131042, 'account', 'Payment problem', 'There’s a problem with the account’s payment method, so paid messages can’t be sent.', 'Fix the payment method in Meta Business Settings → Billing.', 'no'],
    [131057, 'account', 'Account in maintenance', 'The business account is in maintenance mode (for example, a throughput upgrade).', 'Wait a few minutes and resend.', 'later'],
    [131037, 'account', 'Display name not approved', 'This number’s display name needs Meta’s approval before it can send.', 'Check the display name status in WhatsApp Manager.', 'no'],

    // Access & setup
    [190, 'access', 'Access token expired', 'The access token is expired, revoked or wrong.', 'Create a permanent system-user token in Meta Business Settings and paste it under Numbers.', 'no'],
    [0, 'access', 'Couldn’t authenticate', 'Meta couldn’t verify the access token.', 'Paste a valid access token under Numbers.', 'no'],
    [10, 'access', 'Permission denied', 'The token doesn’t have permission for this number or action.', 'Give the system user whatsapp_business_messaging and whatsapp_business_management.', 'no'],
    [3, 'access', 'Missing capability', 'The app isn’t allowed to use this API.', 'Check the app’s permissions and features in Meta.', 'no'],
    [200, 'access', 'API permission missing', 'The token is missing a permission this call needs.', 'Regenerate the token with the WhatsApp permissions.', 'no'],
    [100, 'access', 'Invalid parameter', 'Something in the request is wrong or missing (often a wrong ID).', 'Check the phone number ID, account ID and message details.', 'no'],
    [33, 'access', 'ID not found', 'The phone number ID or account ID doesn’t exist or this token can’t see it.', 'Copy the IDs again from Meta → WhatsApp → API Setup.', 'no'],
    [131005, 'access', 'Access denied', 'The token can’t do this for this number.', 'Check the system user’s access to the number and account.', 'no'],
    [131008, 'access', 'Required value missing', 'A required part of the request is missing.', 'Check the message has everything it needs.', 'no'],
    [131009, 'access', 'Value not valid', 'A value in the request isn’t valid.', 'Check numbers, IDs and links in the message.', 'no'],
    [131045, 'access', 'Certificate problem', 'The number’s registration certificate is wrong.', 'Re-register the number in Meta.', 'no'],

    // Phone number registration
    [133000, 'phone', 'Deregistration incomplete', 'A previous deregistration of this number didn’t finish.', 'Deregister the number again, then register it.', 'no'],
    [133004, 'phone', 'Server temporarily unavailable', 'Registration servers are temporarily unavailable.', 'Try again in a few minutes.', 'later'],
    [133005, 'phone', 'Two-step PIN wrong', 'The two-step verification PIN didn’t match.', 'Use the right PIN, or reset it in WhatsApp Manager.', 'no'],
    [133006, 'phone', 'Number needs re-verification', 'The phone number must be verified again before it can register.', 'Verify the number again in WhatsApp Manager.', 'no'],
    [133008, 'phone', 'Too many PIN guesses', 'Too many wrong two-step PINs were tried.', 'Wait for the time Meta gives, then try the right PIN.', 'later'],
    [133009, 'phone', 'PIN guessed too fast', 'PIN attempts were made too quickly.', 'Wait a moment and try again.', 'later'],
    [133010, 'phone', 'Number not registered', 'This phone number isn’t registered on the WhatsApp Business Platform.', 'Register the number in Meta.', 'no'],
    [133015, 'phone', 'Wait before registering', 'The number was recently deleted; registration has to wait.', 'Try again in a few minutes.', 'later'],
  ].map(([code, cat, title, means, todo, retry]) => ({ code: String(code), cat, title, means, todo, retry }));
  window.MetaErrors = { list: E, cats: C, byCode: Object.fromEntries(E.map((e) => [e.code, e])) };
})();

// ---------- The Error codes page ----------
(() => {
  const ME = window.MetaErrors;
  const RETRY = { yes: ['Resending can help', 'good'], later: ['Wait, then resend', 'warn'], no: ['Fix the cause first', 'bad'] };
  const ui = { q: '', cat: '' };
  const google = (code) => `https://www.google.com/search?q=${encodeURIComponent(`WhatsApp Cloud API error ${code}`)}`;

  function row(e) {
    const [rl, rc] = RETRY[e.retry];
    return `<article class="ec-row" id="ec-${e.code}">
      <code class="ec-code">${esc(e.code)}</code>
      <div class="ec-main">
        <b>${esc(e.title)}</b>
        <p>${esc(e.means)}</p>
        <p class="ec-todo"><span>What to do</span>${esc(e.todo)}</p>
      </div>
      <div class="ec-side">
        <span class="tag ${rc}">${rl}</span>
        <a href="${google(e.code)}" target="_blank" rel="noopener" class="ec-search">Search ${icon('external-link', 12)}</a>
      </div>
    </article>`;
  }

  function draw() {
    const q = ui.q.trim().toLowerCase();
    const hits = ME.list.filter((e) => (!ui.cat || e.cat === ui.cat) && (!q || e.code.includes(q) || `${e.title} ${e.means} ${e.todo}`.toLowerCase().includes(q)));
    const counts = Object.fromEntries(Object.keys(ME.cats).map((k) => [k, ME.list.filter((e) => e.cat === k).length]));
    $('#ecFilter').innerHTML = [['', 'All', ME.list.length], ...Object.entries(ME.cats).map(([k, v]) => [k, v, counts[k]])]
      .map(([k, label, n]) => `<button data-cat="${k}" class="${ui.cat === k ? 'active' : ''}" role="tab" aria-selected="${ui.cat === k}">${esc(label)} <span class="opt">${n}</span></button>`).join('');
    if (!hits.length) {
      const looksLikeCode = /^\d+$/.test(q);
      $('#ecList').innerHTML = `<div class="card ec-empty"><b>${looksLikeCode ? `Code ${esc(q)} isn't in this list` : 'Nothing matches'}</b><p>${looksLikeCode ? `It may be rare or new. <a href="${google(q)}" target="_blank" rel="noopener">Search for it ↗</a> or check <a href="https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes" target="_blank" rel="noopener">Meta's full list ↗</a>.` : 'Try a code number or another word.'}</p></div>`;
      return;
    }
    const groups = Object.keys(ME.cats).map((k) => [k, hits.filter((e) => e.cat === k)]).filter(([, l]) => l.length);
    $('#ecList').innerHTML = groups.map(([k, l]) => `<section class="ec-group"><h3>${esc(ME.cats[k])}</h3><div class="card ec-card">${l.map(row).join('')}</div></section>`).join('');
  }

  // Opens the page on one code (from the Inbox's "What it means"), or the code in ?code= on a reload.
  ME.render = (focus = ME.focus || new URLSearchParams(location.search).get('code')) => {
    ME.focus = null;
    if (focus) { ui.q = ''; ui.cat = ''; $('#ecSearch').value = ''; }
    draw();
    if (!focus) return;
    const el = document.getElementById('ec-' + focus);
    if (!el) { ui.q = String(focus); $('#ecSearch').value = ui.q; draw(); return; }
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center', behavior: Motion.reduce() ? 'auto' : 'smooth' });
      el.classList.remove('hl'); void el.offsetWidth; el.classList.add('hl');
    });
  };
  ME.open = (code) => { ME.focus = String(code); showTab('report'); };

  // ---------- Report an issue (pop-ups opened from the page header, or from an error in the Inbox) ----------
  const rp = { areas: [], reports: [], loaded: false, from: '' };
  const ago = (ts) => { const m = Math.round((Date.now() - Date.parse(ts)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(ts).toLocaleDateString(); };
  async function loadReports() {
    try { Object.assign(rp, await api('/reports'), { loaded: true }); } catch (e) { rp.error = e.message; }
    drawCount();
  }
  // The open-reports count on the header button.
  function drawCount() {
    const n = rp.reports.filter((r) => r.status !== 'resolved').length;
    const c = $('#rpMineCount');
    c.textContent = n;
    c.classList.toggle('hidden', !n);
  }
  // ---------- Your reports: a page with expandable reports ----------
  const rs = { q: '', status: '', open: new Set() };
  const when = (ts) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const PAGE_NAMES = { '/inbox': 'Inbox', '/send': 'Send', '/campaigns': 'Campaigns', '/numbers': 'Numbers', '/templates': 'Templates', '/contacts': 'Contacts', '/': 'Overview' };
  function drawReportsPage() {
    const all = rp.reports;
    const n = (st) => all.filter((r) => !st || (st === 'open' ? r.status !== 'resolved' : r.status === 'resolved')).length;
    $('#rsFilter').innerHTML = [['', 'All'], ['open', 'Open'], ['resolved', 'Resolved']].map(([k, l]) => `<button data-st="${k}" class="${rs.status === k ? 'active' : ''}" role="tab" aria-selected="${rs.status === k}">${l} <span class="opt">${n(k)}</span></button>`).join('');
    const q = rs.q.trim().toLowerCase();
    const shown = all.filter((r) => (!rs.status || (rs.status === 'open' ? r.status !== 'resolved' : r.status === 'resolved'))
      && (!q || `${r.area} ${r.errorCode} ${r.message} ${r.by}`.toLowerCase().includes(q)));
    if (rp.error) { $('#rsList').innerHTML = `<div class="card list-empty"><b>Couldn't load reports</b><p>${esc(rp.error)}</p></div>`; return; }
    if (!all.length) { $('#rsList').innerHTML = `<div class="card list-empty"><b>Nothing reported yet</b><p>When something goes wrong, use <a href="#" data-rs-new>Report an issue</a> and it shows up here with its status.</p></div>`; return; }
    if (!shown.length) { $('#rsList').innerHTML = `<div class="card list-empty"><b>No reports match</b><p>Try another word or status.</p></div>`; return; }
    $('#rsList').innerHTML = `<div class="card rs-card">${shown.map((r) => {
      const open = rs.open.has(r.id);
      const known = r.errorCode && ME.byCode[r.errorCode];
      return `<article class="rs-row ${open ? 'open' : ''}">
        <button class="rs-sum" data-rs="${esc(r.id)}" aria-expanded="${open}">
          <span class="tag ${r.status === 'resolved' ? 'good' : 'warn'}">${r.status === 'resolved' ? 'Resolved' : 'Open'}</span>
          <span class="rs-title"><b>${esc(r.area)}</b>${r.errorCode ? `<code>${esc(r.errorCode)}</code>` : ''}<span class="rs-snip">${esc(r.message.replace(/\s*\n+\s*/g, ' '))}</span></span>
          <span class="rs-when">${esc(ago(r.at))}</span>
          <span class="rs-chev">${icon('chevron-down', 16)}</span>
        </button>
        <div class="rs-body" ${open ? '' : 'hidden'}>
          <p class="rs-msg">${esc(r.message)}</p>
          <dl class="rs-facts">
            <dt>Reported by</dt><dd>${esc(r.by)}${r.byEmail && r.byEmail !== r.by ? ` <span class="muted">${esc(r.byEmail)}</span>` : ''}</dd>
            <dt>When</dt><dd>${esc(when(r.at))}</dd>
            <dt>About</dt><dd>${esc(r.area)}</dd>
            ${r.errorCode ? `<dt>Error code</dt><dd><code>${esc(r.errorCode)}</code> ${known ? `${esc(known.title)} · ` : ''}<a href="/report?code=${esc(r.errorCode)}" data-rs-code="${esc(r.errorCode)}">What it means</a></dd>` : ''}
            ${r.page ? `<dt>Where</dt><dd>${esc(PAGE_NAMES[r.page] || r.page)}</dd>` : ''}
            <dt>Status</dt><dd>${r.status === 'resolved' ? `Resolved ${esc(when(r.resolvedAt))}` : 'Open: the team has it and will get back to you by email'}</dd>
          </dl>
        </div>
      </article>`;
    }).join('')}</div>`;
  }
  ME.showReports = async () => {
    $('#rsList').innerHTML = Skel?.list ? Skel.list(3) : '';
    await loadReports();
    drawReportsPage();
  };
  async function showReports() { showTab('reports'); }
  $('#rsSearch').addEventListener('input', (e) => { rs.q = e.target.value; drawReportsPage(); });
  $('#rsFilter').addEventListener('click', (e) => { const b = e.target.closest('[data-st]'); if (!b) return; rs.status = b.dataset.st; drawReportsPage(); });
  $('#rsNewBtn').addEventListener('click', () => { rp.from = ''; showForm(); });
  $('#rsList').addEventListener('click', (e) => {
    if (e.target.closest('[data-rs-new]')) { e.preventDefault(); rp.from = ''; showForm(); return; }
    const code = e.target.closest('[data-rs-code]');
    if (code) { e.preventDefault(); ME.open(code.dataset.rsCode); return; }
    const sum = e.target.closest('[data-rs]');
    if (!sum) return;
    const id = sum.dataset.rs, row = sum.closest('.rs-row'), open = !rs.open.has(id);
    if (open) rs.open.add(id); else rs.open.delete(id);
    row.classList.toggle('open', open);
    row.querySelector('.rs-body').hidden = !open;
    sum.setAttribute('aria-expanded', open);
  });
  async function showForm({ code = '', area = '', message = '' } = {}) {
    if (!rp.loaded) await loadReports();
    const areas = rp.areas.length ? rp.areas : ['Something else'];
    const body = openModal('Report an issue', `<form class="rp-form" id="rpForm" novalidate>
        <p class="sub rp-lead">Tell us what went wrong and the team will look into it. If you saw an error code, it may already have a quick fix in the list on the Report an issue page.</p>
        <label for="rpArea">What's it about?</label>
        <select id="rpArea">${areas.map((a) => `<option ${a === area ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
        <label for="rpCode">Error code <span class="opt">if you saw one</span></label>
        <input id="rpCode" inputmode="numeric" autocomplete="off" placeholder="e.g. 131031" maxlength="8" value="${esc(code)}" />
        <p class="rp-hint hidden" id="rpHint"></p>
        <label for="rpMsg">What happened?</label>
        <textarea id="rpMsg" rows="5" maxlength="4000" placeholder="What you did, what you expected, and what happened instead. Which number or contact, if it's about one.">${esc(message)}</textarea>
        <p class="sub rp-note">Goes to the Spotmies team with your name and email, so we can reply.</p>
        <div class="modal-actions"><button type="button" class="btn quiet" id="rpCancel">Cancel</button><button class="btn primary" id="rpSend" type="submit" data-icon="send">Send report</button></div>
      </form>`);
    LA.hydrate(body);
    const hint = () => { const c = $('#rpCode', body).value.replace(/\D/g, ''); const e = ME.byCode[c]; $('#rpHint', body).classList.toggle('hidden', !e); if (e) $('#rpHint', body).textContent = `${c} is “${e.title}”: ${e.todo}`; };
    $('#rpCode', body).addEventListener('input', hint);
    hint();
    $('#rpCancel', body).onclick = closeModal;
    const ta = $('#rpMsg', body);
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    $('#rpForm', body).addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#rpSend', body);
      btn.disabled = true;
      try {
        const r = await api('/reports', { method: 'POST', body: { area: $('#rpArea', body).value, errorCode: $('#rpCode', body).value, message: ta.value, page: rp.from || '' } });
        rp.reports.unshift(r);
        rp.from = '';
        drawCount();
        if (state.tab === 'reports') { rs.open.add(r.id); drawReportsPage(); }
        closeModal();
        toast('Thanks! Your report reached the team. See it under Your reports.');
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
  }
  // From an error in the Inbox: the form opens right there, filled in.
  ME.report = ({ from = '', ...fill } = {}) => { rp.from = from; showForm(fill); };
  const baseRender = ME.render;
  ME.render = (...a) => { baseRender(...a); if (!rp.loaded) loadReports(); };
  $('#rpNewBtn').addEventListener('click', () => { rp.from = ''; showForm(); });
  $('#rpMineBtn').addEventListener('click', showReports);

  $('#ecSearch').addEventListener('input', (e) => { ui.q = e.target.value; draw(); });
  $('#ecFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    ui.cat = b.dataset.cat;
    draw();
  });
})();
