// Credits (credits.js on the server): the balance, the rates and where credits went, on the Settings page; and what a
// send costs, for the Send page. A workspace on the free plan sees none of it, and demo mode costs nothing.
window.Credits = (() => {
  const C = { data: null };
  const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const charged = () => Boolean(C.data?.on && !state.settings?.demoMode);
  const rate = (t) => (String(t?.category || '').toUpperCase() === 'MARKETING' || !t?.category ? C.data.rates.marketing : C.data.rates.utility);
  const kind = (t) => String(t?.category || 'marketing').toLowerCase();

  async function load() {
    try { C.data = await api('/credits'); } catch { C.data = null; }
    render();
    if (state.tab === 'send') window.SendPage?.refresh?.();
    return C.data;
  }

  // --- For the Send page ---------------------------------------------------------------------------------------------
  // "706 credits": what sending `count` messages of template t uses ('' when free).
  const costText = (t, count) => (charged() && t && count ? `${fmt(count * rate(t))} credits` : '');
  // Why it can't be sent, when there aren't enough credits ('' otherwise).
  const short = (t, count) => {
    if (!charged() || !t || !count) return '';
    const need = count * rate(t);
    return need > C.data.balance ? `Needs ${fmt(need)} credits and this workspace has ${fmt(C.data.balance)}. Add credits in Settings → Credits, or send to fewer people` : '';
  };
  // A line for the "Send N messages?" confirmation.
  const confirmText = (t, count) => {
    if (!charged() || !t || !count) return '';
    const r = rate(t);
    return `<br><br>Uses <strong>${fmt(count * r)} credits</strong> (${r} per ${kind(t)} message) of your ${fmt(C.data.balance)}. Messages that fail give their credits back.`;
  };

  // --- Settings → Credits ------------------------------------------------------------------------------------------
  function render() {
    const card = $('#creditsCard');
    if (!card) return;
    const d = C.data;
    card.classList.toggle('hidden', !d?.on);
    if (!d?.on) return;
    const next = d.packs.filter((p) => !p.expired && p.left > 0).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))[0];
    const low = d.balance === 0 ? 'out' : next && d.balance < Math.max(500, (d.packs[0]?.credits || 0) * 0.1) ? 'low' : '';
    card.innerHTML = `
      <div class="card-head">
        <h2 data-icon="zap">Credits</h2>
        <button type="button" class="btn sm primary" id="crBuy" data-icon="plus" data-icon-size="14">Buy credits</button>
      </div>
      <div class="cr-top">
        <div class="cr-bal ${low}">
          <b>${fmt(d.balance)}</b>
          <span>${low === 'out' ? 'No credits left: campaigns, template messages and AI are on hold' : 'credits left'}${next ? ` · ${fmt(next.left)} expire ${day(next.expiresAt)}` : ''}</span>
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
      <p class="sub cr-note">Messages that fail give their credits back. Credits from a pack last ${d.months} months. These are SendON’s charges: Meta bills its own per-message fee to your WhatsApp Business Account separately. AI uses credits whether it runs on SendON’s AI or your own AI key.</p>
      <div class="field-label">Recent activity</div>
      <div class="cr-log">${d.ledger.length ? d.ledger.slice(0, 12).map(row).join('') : '<p class="sub">Nothing yet.</p>'}</div>`;
    LA.hydrate(card);
  }
  const numbersText = (n) => (n == null ? 'Unlimited numbers' : n === 1 ? '1 WhatsApp number' : `Up to ${n} WhatsApp numbers`);
  function row(l) {
    const net = l.kind === 'add' ? `+${fmt(l.used)}` : `−${fmt(l.used - l.refunded)}`;
    const detail = l.kind === 'add' ? 'Added' : l.kind === 'expire' ? 'Expired unused' : `${fmt(l.used)} used${l.refunded ? ` · ${fmt(l.refunded)} returned for failed messages` : ''}`;
    return `<div class="cr-row ${l.kind}"><span><b>${esc(l.what)}</b><small>${esc(detail)} · ${esc(relTime(l.at))}</small></span><em>${net}</em></div>`;
  }

  // Buying: the packs, and how to pay. An admin adds the credits once it's paid.
  function buy() {
    const d = C.data;
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
  document.addEventListener('click', (e) => { if (e.target.closest('#crBuy')) buy(); });

  return { load, render, costText, short, confirmText, get data() { return C.data; } };
})();
