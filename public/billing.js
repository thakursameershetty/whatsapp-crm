// Credits (credits.js on the server): the balance, the rates and where credits went, on the Settings page; and what a
// send costs, for the Send page. A workspace on the free plan sees none of it, and demo mode costs nothing.
window.Credits = (() => {
  const C = { data: null };
  const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const charged = () => Boolean(C.data?.on && !state.settings?.demoMode);
  const unlimited = () => Boolean(C.data?.unlimited); // a workspace that's never charged: shows "Unlimited"
  const rate = (t) => (String(t?.category || '').toUpperCase() === 'MARKETING' || !t?.category ? C.data.rates.marketing : C.data.rates.utility);
  const kind = (t) => String(t?.category || 'marketing').toLowerCase();

  async function load() {
    try { C.data = await api('/credits'); } catch { C.data = null; }
    render();
    slots();
    if (C.data) C.shown = C.data.balance; // the next change rolls from here
    if (state.tab === 'send') window.SendPage?.refresh?.();
    return C.data;
  }

  // A balance that rolls digit by digit to its new value, like the campaign results (rollNum, app.js). A number that
  // was just drawn starts at the last balance shown, so a drop or a top-up is seen ticking over.
  function roll(el, value) {
    if (!el) return;
    if (el.dataset.v == null && C.shown != null) { el.dataset.v = Number(C.shown).toLocaleString(); el.dataset.n = C.shown; el.textContent = el.dataset.v; }
    if (typeof rollNum === 'function') rollNum(el, value);
    else el.textContent = Number(value).toLocaleString();
  }
  const lowOf = (d) => (d.balance === 0 ? 'out' : d.balance < Math.max(500, (d.packs?.[0]?.credits || 0) * 0.1) ? 'low' : '');

  // --- The chip in the Overview, Campaigns and Assistant headers (any <span class="cr-slot">) ---------------------------
  function slots() {
    const d = C.data, on = charged();
    document.querySelectorAll('.cr-slot').forEach((slot) => {
      if (unlimited()) {
        slot.innerHTML = `<span class="cr-chip unl">${window.Coin ? Coin.html({ size: 24, label: 'Unlimited credits' }) : ''}<button type="button" class="cr-chip-t" data-goto="credits" title="This workspace has unlimited credits: nothing it does is charged"><b>Unlimited</b></button></span>`;
        return;
      }
      if (!on) { slot.innerHTML = ''; return; }
      if (!slot.firstElementChild) {
        slot.innerHTML = `<span class="cr-chip">${window.Coin ? Coin.html({ size: 24, label: 'Credits' }) : ''}<button type="button" class="cr-chip-t" data-goto="credits" title="Credits left in this workspace. Open the Credits page"><b class="cr-chip-v"></b><span>credits</span></button></span>`;
      }
      slot.firstElementChild.className = 'cr-chip ' + lowOf(d);
      roll(slot.querySelector('.cr-chip-v'), d.balance);
    });
  }
  // While a page with the balance on it is open, check it now and then (a campaign that's sending uses credits).
  setInterval(() => {
    if (charged() && document.visibilityState === 'visible' && ['overview', 'campaigns', 'assistant', 'credits'].includes(state.tab)) load();
  }, 20000);

  // --- For the Send page ---------------------------------------------------------------------------------------------
  // "706 credits": what sending `count` messages of template t uses ('' when free).
  const costText = (t, count) => (charged() && t && count ? `${fmt(count * rate(t))} credits` : '');
  // Why it can't be sent, when there aren't enough credits ('' otherwise).
  const short = (t, count) => {
    if (!charged() || !t || !count) return '';
    const need = count * rate(t);
    return need > C.data.balance ? `Needs ${fmt(need)} credits and this workspace has ${fmt(C.data.balance)}. Add credits on the Credits page, or send to fewer people` : '';
  };
  // A line for the "Send N messages?" confirmation.
  const confirmText = (t, count) => {
    if (!charged() || !t || !count) return '';
    const r = rate(t);
    return `<br><br>Uses <strong>${fmt(count * r)} credits</strong> (${r} per ${kind(t)} message) of your ${fmt(C.data.balance)}. Messages that fail give their credits back.`;
  };

  // --- the Credits page ------------------------------------------------------------------------------------------
  function render() {
    const card = $('#creditsCard');
    if (!card) return;
    const d = C.data;
    const shown = Boolean(d?.on || d?.unlimited);
    card.classList.toggle('hidden', !shown);
    $('#creditsNone')?.classList.toggle('hidden', shown || !d);
    const act = $('#creditsActivity');
    act?.classList.toggle('hidden', !shown);
    const unl = Boolean(d?.unlimited);
    if (!unl && !d?.on) return;
    const next = unl ? null : d.packs.filter((p) => !p.expired && p.left > 0).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))[0];
    const low = unl ? '' : d.balance === 0 ? 'out' : next && lowOf(d) ? 'low' : '';
    card.innerHTML = `
      <div class="card-head">
        <h2 data-icon="zap">Balance</h2>
        ${unl ? '' : '<button type="button" class="btn sm primary" id="crBuy" data-icon="plus" data-icon-size="14">Buy credits</button>'}
      </div>
      <div class="cr-top">
        <div class="cr-bal ${low}">
          ${window.Coin ? Coin.html({ size: 92, label: unl ? 'Unlimited credits' : `${fmt(d.balance)} credits` }) : ''}
          ${unl ? '<b>Unlimited</b><span>Nothing here uses credits: the rates are what it would cost, for your records.</span>'
            : `<b class="cr-num"></b><span>${low === 'out' ? 'No credits left: campaigns, template messages and AI are on hold' : 'credits left'}${next ? ` · ${fmt(next.left)} expire ${day(next.expiresAt)}` : ''}</span>`}
          ${d.demo ? '<span class="cr-demo">Demo mode is on: nothing uses credits</span>' : ''}
        </div>
        <dl class="cr-rates">
          <div><dt>Marketing template message</dt><dd>${d.rates.marketing} credits</dd></div>
          <div><dt>Utility template message</dt><dd>${d.rates.utility} credit</dd></div>
          <div><dt>AI reply sent, or an Assistant answer</dt><dd>${d.rates.ai} credit</dd></div>
          <div><dt>Assistant answer that prepares a campaign plan</dt><dd>${d.rates.plan ?? 3} credits</dd></div>
          <div><dt>Replies you type in the Inbox</dt><dd>Free</dd></div>
          <div class="cr-nums"><dt>WhatsApp numbers on your plan</dt><dd>${d.numberLimit == null ? `${fmt(d.numbersUsed)} connected · no limit` : `${fmt(d.numbersUsed)} of ${fmt(d.numberLimit)}`}</dd></div>
        </dl>
      </div>
      <p class="sub cr-note">${unl ? 'This workspace is on Unlimited: nothing is taken, and the activity below shows what it used at the rates above.' : `Messages that fail give their credits back. Credits from a pack last ${d.months} months.`} These are SendON’s charges: Meta bills its own per-message fee to your WhatsApp Business Account separately.${unl ? '' : ' AI uses credits whether it runs on SendON’s AI or your own AI key.'}</p>`;
    LA.hydrate(card);
    if (act) { act.innerHTML = activityHtml(d.ledger, unl); LA.hydrate(act); }
    if (!unl) roll($('.cr-num', card), d.balance);
  }
  // Recent activity: the last 14 days only; View all activity opens the whole log.
  const RECENT_DAYS = 14;
  const recent = (ledger) => ledger.filter((l) => Date.now() - Date.parse(l.at) < RECENT_DAYS * 86400000);
  function activityHtml(ledger, free) {
    const list = recent(ledger);
    return `<div class="card-head"><h2 data-icon="history">Recent activity <span class="opt">last ${RECENT_DAYS} days</span></h2>${ledger.length ? `<button type="button" class="btn sm quiet" data-goto="credits-activity" data-icon="list" data-icon-size="14">View all activity</button>` : ''}</div>
      <div class="cr-log">${list.length ? list.map((l) => row(l, free)).join('') : `<p class="sub">${ledger.length ? `Nothing in the last ${RECENT_DAYS} days.` : 'Nothing yet.'}</p>`}</div>`;
  }
  // The Credits activity page (/credits-activity): every entry, newest first, under a heading per month.
  async function showAll() {
    const card = $('#crAllCard');
    if (!card) return;
    let d;
    try { d = await api('/credits?all=1'); } catch (e) { card.innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }
    if (state.tab !== 'credits-activity') return;
    const free = Boolean(d.unlimited), n = d.ledger.length;
    $('#crAllSub').textContent = `${fmt(n)} entr${n === 1 ? 'y' : 'ies'}, newest first.${free ? ' This workspace is on Unlimited: nothing was taken.' : ''}`;
    if (!n) { card.innerHTML = '<div class="empty"><div class="empty-ico" data-icon="history" data-icon-size="28"></div><h3>Nothing yet</h3><p>Credits added and used will show here.</p></div>'; LA.hydrate(card); return; }
    const months = [];
    for (const l of d.ledger) {
      const m = new Date(l.at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      if (months.at(-1)?.m !== m) months.push({ m, rows: [] });
      months.at(-1).rows.push(l);
    }
    card.innerHTML = months.map((g) => `<div class="cr-month"><h3 class="field-label">${esc(g.m)}</h3><div class="cr-log">${g.rows.map((l) => row(l, free)).join('')}</div></div>`).join('');
  }
  const numbersText = (n) => (n == null ? 'Unlimited numbers' : n === 1 ? '1 WhatsApp number' : `Up to ${n} WhatsApp numbers`);
  function row(l, free = false) { // free: an Unlimited workspace's use, logged but not taken
    const net = l.kind === 'add' ? `+${fmt(l.used)}` : free ? `${fmt(l.used - l.refunded)}` : `−${fmt(l.used - l.refunded)}`;
    const detail = l.kind === 'add' ? 'Added' : l.kind === 'remove' ? 'Removed by SendON' : l.kind === 'expire' ? 'Expired unused' : `${fmt(l.used)} used${l.refunded ? ` · ${fmt(l.refunded)} returned for failed messages` : ''}${free ? ' · not charged' : ''}`;
    return `<div class="cr-row ${l.kind}"><span><b>${esc(l.what)}</b><small>${esc(detail)} · ${esc(relTime(l.at))}</small></span><em>${net}</em></div>`;
  }

  // Buying. With online payment on (d.checkout): pick a pack, pay in Razorpay's checkout, and the credits are added
  // as soon as it's confirmed. Otherwise: the packs, and how to reach us (an admin adds them once paid).
  function buy() {
    const d = C.data;
    if (d.checkout) return buyOnline();
    openModal('Buy credits', `
      <div class="cr-packs">${d.packOptions.map((p) => `<div class="cr-pack">
        <b>₹${fmt(p.price)}</b><span>${fmt(p.credits)} credits</span><span class="cr-pack-n">${numbersText(p.numbers)}</span>${p.credits > p.price ? `<em>+${Math.round((100 * (p.credits - p.price)) / p.price)}% bonus</em>` : '<em class="plain">&nbsp;</em>'}
      </div>`).join('')}</div>
      <p class="sub">Tell us which pack you want and we’ll send the payment details. Credits are added to <b>${esc(state.me?.workspace?.name || 'this workspace')}</b> as soon as it’s paid, and last ${d.months} months.</p>
      <div class="modal-actions">
        <a class="btn" href="tel:+917207333883" data-icon="phone" data-icon-size="15">+91 72073 33883</a>
        <a class="btn primary" href="https://calendly.com/sendon-spotmies" target="_blank" rel="noopener" data-icon="calendar-days" data-icon-size="15">Book a call</a>
      </div>`);
    LA.hydrate($('#modal'));
  }
  let rzpLoading = null;
  const loadCheckout = () => (rzpLoading ||= new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = resolve;
    s.onerror = () => { rzpLoading = null; reject(new Error('Couldn’t open the payment page. Check your internet and try again.')); };
    document.head.append(s);
  }));
  function buyOnline() {
    const d = C.data;
    loadCheckout().catch(() => {}); // start loading while they choose
    openModal('Buy credits', `
      <div class="cr-packs">${d.packOptions.map((p) => `<button type="button" class="cr-pack cr-pack-buy" data-buy-pack="${esc(p.id)}">
        <b>₹${fmt(p.price)}</b><span>${fmt(p.credits)} credits</span><span class="cr-pack-n">${numbersText(p.numbers)}</span>${p.credits > p.price ? `<em>+${Math.round((100 * (p.credits - p.price)) / p.price)}% bonus</em>` : '<em class="plain">&nbsp;</em>'}
        <span class="cr-pack-pay">Pay ₹${fmt(p.price)}</span>
      </button>`).join('')}</div>
      <p class="sub">Pay by UPI, card, netbanking or wallet. The credits are added to <b>${esc(state.me?.workspace?.name || 'this workspace')}</b> as soon as the payment goes through, and last ${d.months} months.</p>`);
  }
  async function pay(btn) {
    const all = [...document.querySelectorAll('[data-buy-pack]')];
    all.forEach((b) => (b.disabled = true));
    btn.classList.add('busy');
    const done = () => { all.forEach((b) => (b.disabled = false)); btn.classList.remove('busy'); };
    try {
      await loadCheckout();
      const o = await api('/credits/order', { method: 'POST', body: { pack: btn.dataset.buyPack } });
      const rzp = new window.Razorpay({
        key: o.key, order_id: o.orderId, amount: o.amount, currency: o.currency,
        name: 'SendON', description: `${o.pack} · ${o.workspace}`,
        prefill: { email: o.email, name: o.name },
        theme: { color: '#1f7a4d' },
        handler: async (r) => {
          try {
            C.data = await api('/credits/verify', { method: 'POST', body: r });
            closeModal(); // the "credits added" notification shows the toast
            load();
          } catch (e) { toast(e.message, 'error', { duration: 12000 }); load(); }
        },
        modal: { ondismiss: done },
      });
      rzp.on('payment.failed', (r) => toast(r.error?.description || 'The payment didn’t go through. Nothing was charged.', 'error'));
      rzp.open();
    } catch (e) { toast(e.message, 'error'); done(); }
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('#crBuy')) buy();
    const p = e.target.closest('[data-buy-pack]');
    if (p && !p.disabled) pay(p);
  });

  return { load, render, slots, showAll, costText, short, confirmText, get data() { return C.data; } };
})();
