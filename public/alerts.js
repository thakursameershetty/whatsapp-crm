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
  async function thisBrowser() {
    if (!supported) return null;
    const r = await navigator.serviceWorker.getRegistration('/');
    return r ? r.pushManager.getSubscription() : null;
  }

  async function turnOn() {
    if (!supported) return toast(/iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone, add SendON to your Home Screen first (Share → Add to Home Screen), then open it from there and turn alerts on.' : 'This browser can’t show notifications.', 'error', { duration: 8000 });
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notifications are blocked for SendON in this browser. Allow them in the site settings (the icon left of the address), then try again.', 'error', { duration: 8000 });
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
    const on = Boolean(await thisBrowser().catch(() => null)) && Notification.permission === 'granted';
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
  if (supported && Notification.permission === 'granted') thisBrowser().then((sub) => sub && api('/alerts/push', { method: 'POST', body: { subscription: sub.toJSON() } }).catch(() => {})).catch(() => {});

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
  // opens. "Not now" waits ASK_AGAIN_MS before asking again in this browser; once on, it never shows.
  const ASK_AGAIN_MS = 3 * 24 * 3600 * 1000;
  const ASK_KEY = 'sendon.alertsAsked';
  const askedAt = () => { try { return Number(localStorage.getItem(ASK_KEY)) || 0; } catch { return 0; } };
  const markAsked = () => { try { localStorage.setItem(ASK_KEY, String(Date.now())); } catch {} };
  let askedThisVisit = false;
  async function maybeAsk() {
    const tab = document.getElementById('tab-inbox');
    if (askedThisVisit || !supported || !st || !tab || tab.classList.contains('hidden')) return;
    if (!document.getElementById('modal')?.classList.contains('hidden')) return; // another pop-up is open
    if (Date.now() - askedAt() < ASK_AGAIN_MS) return;
    const blocked = Notification.permission === 'denied';
    if (!blocked && Notification.permission === 'granted' && await thisBrowser().catch(() => null)) return; // already on
    askedThisVisit = true;
    const body = openModal('Turn on notifications', `
      <div class="al-ask">
        <div class="al-ask-icon">${icon('bell', 26)}</div>
        <p><b>Know the moment a customer needs you.</b> SendON tells you when a chat is waiting for a reply, even when this tab is closed.</p>
        <ul>
          <li>${icon('message-circle', 15)}A customer asks about a meeting, pricing, or thanks you, and the AI waits for you</li>
          <li>${icon('users', 15)}A chat needs a person and no one on the team is online</li>
        </ul>
        ${blocked ? `<p class="al-ask-blocked">${icon('triangle-alert', 15)}<span>Notifications are blocked for SendON in this browser. Click the icon left of the address bar, set <b>Notifications</b> to <b>Allow</b>, then reload the page.</span></p>` : ''}
      </div>
      <div class="modal-actions"><button type="button" class="btn quiet" data-ask="later">Not now</button>${blocked ? '' : `<button type="button" class="btn primary" data-ask="allow" data-icon="bell" data-icon-size="15">Allow notifications</button>`}</div>`);
    LA.hydrate(body);
    markAsked(); // closing the pop-up any way counts as "not now"
    body.querySelector('[data-ask="later"]').addEventListener('click', () => closeModal());
    body.querySelector('[data-ask="allow"]')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try { await turnOn(); } catch (err) { toast(err.message, 'error'); }
      closeModal();
    });
  }
  // when the Inbox opens (now, or later from the sidebar)
  const inboxTab = document.getElementById('tab-inbox');
  if (inboxTab) new MutationObserver(() => setTimeout(maybeAsk, 600)).observe(inboxTab, { attributes: true, attributeFilter: ['class'] });
  loaded.then(() => setTimeout(maybeAsk, 1200));
})();
