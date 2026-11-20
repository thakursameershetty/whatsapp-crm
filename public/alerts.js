// Alerts outside the app (server: alerts.js). On the Notifications page: turn on browser notifications for this
// browser, test them, and switch the emails on or off. Each person sets their own. Also opens the chat an alert links
// to (/inbox?ws=…&chat=…; the server already switched to that workspace).

(function () {
  const box = () => document.getElementById('ntAlerts');
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let st = null;

  const b64ToBytes = (s) => {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  const reg = () => navigator.serviceWorker.register('/sw.js');
  // The browser's notification permission: 'granted', 'denied' or 'default'. Chrome's PermissionStatus follows the
  // site-settings switch right away; Notification.permission can lag until a reload, so the status wins when we have it.
  let permStatus = null;
  const permReady = supported && navigator.permissions?.query
    ? navigator.permissions.query({ name: 'notifications' }).then((p) => { permStatus = p; }).catch(() => {})
    : Promise.resolve();
  const perm = () => (permStatus ? (permStatus.state === 'prompt' ? 'default' : permStatus.state) : supported ? Notification.permission : 'default');
  async function thisBrowser() {
    if (!supported) return null;
    const r = await navigator.serviceWorker.getRegistration('/');
    return r ? r.pushManager.getSubscription() : null;
  }

  let turning = false; // turnOn is running (the permission watcher leaves it alone meanwhile)
  async function turnOn() {
    if (turning) return;
    turning = true;
    try { await turnOnNow(); } finally { turning = false; lastPerm = supported ? perm() : null; }
  }
  async function turnOnNow() {
    if (!supported) return toast(/iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone, add SendON to your Home Screen first (Share → Add to Home Screen), then open it from there and turn alerts on.' : 'This browser can’t show notifications.', 'error', { duration: 8000 });
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { if (perm === 'denied' && document.getElementById('modal')?.classList.contains('hidden')) openAsk(true); return; }
    const r = await reg();
    await navigator.serviceWorker.ready;
    const sub = (await r.pushManager.getSubscription()) || await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(st.publicKey) });
    st = await api('/alerts/push', { method: 'POST', body: { subscription: sub.toJSON() } });
    toast('Browser alerts are on. Sending a test…');
    await api('/alerts/test', { method: 'POST' }).catch((e) => toast(e.message, 'error'));
    render();
  }
  async function turnOff() {
    const sub = await thisBrowser();
    if (sub) { await api('/alerts/push', { method: 'DELETE', body: { endpoint: sub.endpoint } }); await sub.unsubscribe().catch(() => {}); }
    st = await api('/alerts');
    render();
  }

  async function render() {
    const el = box();
    if (!el || !st) return;
    const on = Boolean(await thisBrowser().catch(() => null)) && perm() === 'granted';
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="nt-alerts-text">${icon('bell', 16)}<div><b>Alerts when a chat waits for you</b>
        <span class="sub">When the AI holds a reply (a meeting, pricing, appreciation) or asks for a person, and no one on the team has SendON open, or no one replies within 5 minutes.</span></div></div>
      <div class="nt-alerts-ctl">
        ${on ? `<span class="pill read" style="text-transform:none;gap:5px">${icon('circle-check', 12)}On in this browser</span><button class="btn sm quiet" data-al="test">Test</button><button class="btn sm quiet" data-al="off">Turn off</button>`
             : `<button class="btn sm primary" data-al="on" data-icon="bell" data-icon-size="13">Turn on browser alerts</button>`}
        <label class="nt-alerts-mail" title="${st.emailWorks ? '' : 'Email isn’t set up on this server yet, so nothing is emailed for now.'}"><input type="checkbox" data-al="email" ${st.email ? 'checked' : ''}> Email me too</label>
      </div>`;
    window.LA?.hydrate?.(el);
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('#ntAlerts [data-al]');
    if (!b || b.type === 'checkbox') return;
    b.disabled = true;
    try {
      if (b.dataset.al === 'on') await turnOn();
      if (b.dataset.al === 'off') await turnOff();
      if (b.dataset.al === 'test') { await api('/alerts/test', { method: 'POST' }); toast('Test alert sent'); }
    } catch (err) { toast(err.message, 'error'); }
    b.disabled = false;
  });
  document.addEventListener('change', async (e) => {
    const c = e.target.closest('#ntAlerts [data-al="email"]');
    if (!c) return;
    try { st = await api('/alerts/email', { method: 'POST', body: { on: c.checked } }); toast(c.checked ? 'You’ll get an email too' : 'No alert emails'); }
    catch (err) { c.checked = !c.checked; toast(err.message, 'error'); }
  });

  const loaded = api('/alerts').then((s) => { st = s; render(); }).catch(() => {});
  // keep this browser's subscription fresh (browsers rotate them now and then)
  if (supported && perm() === 'granted') thisBrowser().then((sub) => sub && api('/alerts/push', { method: 'POST', body: { subscription: sub.toJSON() } }).catch(() => {})).catch(() => {});

  // Opened from an alert: show that chat, then tidy the address.
  const q = new URLSearchParams(location.search);
  const chat = q.get('chat');
  if (chat && location.pathname.startsWith('/inbox')) {
    history.replaceState(history.state, '', '/inbox');
    let tries = 0;
    const t = setInterval(() => {
      if (window.Inbox?.open) { clearInterval(t); window.Inbox.open(chat); }
      else if (++tries > 50) clearInterval(t);
    }, 200);
  }

  // Asking on the Inbox: a browser without alerts gets a pop-up (the screen behind it blurred) the first time the Inbox
  // opens while alerts are off in this browser. "Not now" lasts until the page is reloaded or opened again; once
  // alerts are on, it never shows.
  let askedThisVisit = false;
  const markAsked = () => { askedThisVisit = true; };
  async function maybeAsk() {
    const tab = document.getElementById('tab-inbox');
    if (askedThisVisit || !supported || !st || !tab || tab.classList.contains('hidden')) return;
    if (!document.getElementById('modal')?.classList.contains('hidden')) return; // another pop-up is open
    await permReady;
    const blocked = perm() === 'denied';
    if (!blocked && perm() === 'granted' && await thisBrowser().catch(() => null)) return; // already on
    askedThisVisit = true;
    openAsk(blocked);
  }

  // Which browser, for the steps and where its site-settings icon is (left of the address, near the top-left corner).
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'edge' : /Firefox\//.test(ua) ? 'firefox' : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other';
  const SITE_ICON = {
    chrome: { svg: icon('sliders-horizontal', 15), name: 'the settings icon' },
    edge: { svg: icon('lock', 15), name: 'the lock icon' },
    firefox: { svg: icon('bell-off', 15), name: 'the crossed-out bell' },
  };
  // A small picture of the address bar with the icon to click ringed, and the steps for this browser.
  function blockedSteps() {
    const host = location.host;
    if (browser === 'safari') return `<ol class="al-steps">
        <li>In the menu bar, click <b>Safari</b> → <b>Settings…</b> → <b>Websites</b></li>
        <li>Choose <b>Notifications</b> on the left, find <b>${host}</b> and set it to <b>Allow</b></li>
        <li>Come back here: alerts turn on by themselves</li></ol>`;
    const ic = SITE_ICON[browser] || SITE_ICON.chrome;
    return `<div class="al-bar" aria-hidden="true"><span class="al-bar-nav">${icon('arrow-left', 13)}${icon('arrow-right', 13)}${icon('refresh-cw', 13)}</span>
        <span class="al-bar-url"><span class="al-bar-icon">${ic.svg}</span>${host}/inbox</span></div>
      <ol class="al-steps">
        <li>Click ${ic.name} <span class="al-inline-icon">${ic.svg}</span> at the left of the address bar, at the top of this window</li>
        <li>${browser === 'firefox' ? 'Next to <b>Send notifications</b>, click the <b>×</b> to remove the block' : 'Find <b>Notifications</b> and switch it to <b>Allow</b>'}</li>
        <li>Come back here: alerts turn on by themselves (or reload the page)</li></ol>`;
  }

  // An arrow over the page, pointing up at the browser's site-settings icon (the page can't draw on the browser itself).
  let arrow = null;
  function showArrow(text) {
    hideArrow();
    if (innerWidth < 700 || browser === 'safari' || browser === 'other') return; // phones and Safari: no icon in that spot
    arrow = document.createElement('div');
    arrow.className = 'al-arrow';
    arrow.innerHTML = `<svg width="34" height="46" viewBox="0 0 34 46" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M17 44V4"/><path d="M5 16 17 4l12 12"/></svg><span>${text}</span>`;
    document.body.append(arrow);
  }
  function hideArrow() { arrow?.remove(); arrow = null; }
  const modalEl = document.getElementById('modal');
  if (modalEl) new MutationObserver(() => { if (modalEl.classList.contains('hidden') || modalEl.classList.contains('closing')) { hideArrow(); askOpen = false; } }).observe(modalEl, { attributes: true, attributeFilter: ['class'] });

  // Follow the browser's setting live, pop-up open or not: switched on (in the site settings or the browser's prompt) →
  // the pop-up goes and alerts turn on; switched off or reset → the pop-up comes straight back (whatever "Not now" said).
  // Browsers don't always fire the change event for the site-settings toggle, so it's also checked every second and
  // when the window gets focus again.
  let lastPerm = null; // set once the permission status is known (permReady)
  let askOpen = false;
  async function permissionChanged() {
    if (!supported || turning || lastPerm === null) return;
    const now = perm();
    if (now === lastPerm) return;
    const was = lastPerm;
    lastPerm = now;
    if (now === 'granted') {
      hideArrow();
      if (askOpen) closeModal();
      try { await turnOn(); } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (was === 'granted') { // turned off: this browser's subscription no longer works
      const sub = await thisBrowser().catch(() => null);
      if (sub) api('/alerts/push', { method: 'DELETE', body: { endpoint: sub.endpoint } }).then((x) => { st = x; render(); }).catch(() => {});
      sub?.unsubscribe().catch(() => {});
    }
    render();
    // ask again, unless a different pop-up is open (ours just switches to the right version: blocked or not)
    if (askOpen || document.getElementById('modal')?.classList.contains('hidden')) openAsk(now === 'denied');
  }
  if (supported) {
    permReady.then(() => { lastPerm = perm(); if (permStatus) permStatus.onchange = permissionChanged; });
    setInterval(permissionChanged, 1000);
    addEventListener('focus', permissionChanged);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) permissionChanged(); });
  }

  function openAsk(blocked) {
    const body = openModal(blocked ? 'Notifications are blocked' : 'Turn on notifications', `
      <div class="al-card ${blocked ? 'al-warn' : ''}">
        <div class="al-glow" aria-hidden="true"></div>
        <div class="al-chip">${icon(blocked ? 'bell-off' : 'bell', 20)}</div>
        <h3>${blocked ? 'Notifications are blocked' : 'Never miss a customer<br>who needs you'}</h3>
        <p>${blocked
          ? 'SendON can’t alert you in this browser until you allow it. It only takes a moment:'
          : 'Get an alert when a chat waits for a reply: a meeting, pricing or a thank-you the AI holds for you, or a chat no one online has answered. Even with this tab closed.'}</p>
        ${blocked ? `<div class="al-guide">${blockedSteps()}</div>` : ''}
        <div class="al-actions">
          <button type="button" class="al-btn" data-ask="later">Not now</button>
          ${blocked ? '<button type="button" class="al-btn dark" data-ask="reload">Reload page</button>' : '<button type="button" class="al-btn dark" data-ask="allow">Allow notifications</button>'}
        </div>
      </div>`);
    body.closest('.modal-box')?.classList.add('al-box');
    LA.hydrate(body);
    askOpen = true;
    markAsked(); // closing the pop-up any way counts as "not now"
    if (blocked) showArrow('Click this icon, then allow Notifications'); else hideArrow();
    body.querySelector('[data-ask="later"]').addEventListener('click', () => closeModal());
    body.querySelector('[data-ask="reload"]')?.addEventListener('click', () => location.reload());
    body.querySelector('[data-ask="allow"]')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      // the browser's own question appears under the address bar, top left
      showArrow('Your browser is asking up here: click Allow');
      try { await turnOn(); } catch (err) { toast(err.message, 'error'); }
      lastPerm = perm();
      hideArrow();
      if (perm() === 'denied') return openAsk(true); // they clicked Block: show how to undo it
      closeModal();
    });
  }
  window.Alerts = { ask: () => openAsk(perm() === 'denied') };
  // when the Inbox opens (now, or later from the sidebar)
  const inboxTab = document.getElementById('tab-inbox');
  if (inboxTab) new MutationObserver(() => setTimeout(maybeAsk, 600)).observe(inboxTab, { attributes: true, attributeFilter: ['class'] });
  loaded.then(() => setTimeout(maybeAsk, 1200));
})();
