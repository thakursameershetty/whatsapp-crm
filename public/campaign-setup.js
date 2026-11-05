// New campaign, and a campaign's settings: its name, the template it sends, and whether the AI replies to the people
// who answer it (with what it may say about the business). Saving a new one makes a draft (POST /api/drafts) and opens
// it on the Send page, where its recipients are set up. A sent campaign keeps only its AI settings editable: replies
// keep coming after it's sent. Uses helpers from app.js and send.js (TemplatePicker).

(function () {
  const AUTO_NOTE = 'Live mode: the AI sends real WhatsApp replies without anyone approving them. It holds back when a person is needed, after an opt-out, when your team is active in the chat, and after 5 auto-replies in an hour.';

  function tplButton(t) {
    return t
      ? `${icon('file-text', 16)}<span class="tp-btn-main"><b title="${esc(t.name)}">${esc(t.name)}</b><small>${esc(t.language)} · ${esc(catLabel(t.category).toLowerCase())}${t.variables.length ? ` · ${t.variables.length} variable${t.variables.length > 1 ? 's' : ''}` : ''}</small></span><span class="tp-btn-act">Change</span>`
      : `${icon('file-text', 16)}<span class="tp-btn-main"><b>${state.templates.length ? 'Choose a template' : 'No templates yet'}</b><small>${state.templates.length ? `${state.templates.filter((x) => !tplSendBlock(x)).length} ready to send` : 'Add one under Templates'}</small></span>${icon('chevron-down', 15)}`;
  }

  // draft: an existing draft to edit; campaign: a sent campaign (AI settings only). Otherwise a new campaign, with
  // name / templateId filled in when given. onSaved(record) runs after the save.
  function open({ draft = null, campaign = null, name = '', templateId = '', onSaved = null, onCancel = null } = {}) {
    const rec = draft || campaign;
    const isNew = !rec;
    const sent = Boolean(campaign);
    const ai = { on: false, auto: false, business: '', qualified: '', nextStep: '', tone: '', ...(rec?.ai || {}) };
    let tplId = rec?.templateId || (state.templates.some((t) => t.id === templateId && !tplSendBlock(t)) ? templateId : '');
    const showAi = Boolean(state.me?.ai);
    const masterOff = state.settings?.leadAgent?.on === false;
    const pbs = state.settings?.leadAgent?.playbooks || [];
    const title = isNew ? 'New campaign' : sent ? 'AI replies' : 'Campaign settings';
    const body = openModal(title, `
      <div class="cs-grid">
      <div class="cs-form">
        ${sent ? `<p class="sub cs-sent"><b>${esc(rec.name)}</b> · ${esc(rec.templateName || '')}</p>` : `
        <label>Campaign name<input id="csName" maxlength="120" placeholder="e.g. Diwali offer — Nov 2026" value="${esc(rec?.name || name)}" /></label>
        <label>Description <span class="opt">optional · for your team, not sent</span><textarea id="csDesc" rows="5" maxlength="500" placeholder="e.g. 20% off sweets for past buyers in Hyderabad, ends Nov 15">${esc(rec?.description || '')}</textarea></label>
        <div class="field-label">Template</div>
        <div class="cs-tplwrap"><button type="button" class="tp-btn" id="csTpl" aria-haspopup="dialog"></button><button type="button" class="cs-tpl-x hidden" id="csTplX" aria-label="Remove the template" title="Remove the template">${icon('x', 15)}</button></div>
        <div class="field-label cs-from-h">Send from <span class="opt" id="csNumsHint"></span></div>
        <button type="button" class="cs-numsel" id="csNums" aria-haspopup="listbox"></button>`}
        ${showAi ? `
        <div class="cs-ai">
          <label class="pb-row"><span><b>AI replies to this campaign</b><small>When someone answers it, the AI drafts a reply in the Inbox using what you write below.</small></span>${toggleHtml({ checked: ai.on, attrs: 'id="csAi"', size: 'sm' })}</label>
          <div class="cs-ai-fields ${ai.on ? '' : 'hidden'}" id="csAiFields">
            ${masterOff ? `<p class="pb-offnote">${icon('bell-off', 15)}<span>Automatic drafts are off for the workspace (Settings → Lead assistant), so nothing drafts on its own until they're switched back on.</span></p>` : ''}
            ${pbs.length ? `<label>Start from a playbook <span class="opt">optional</span><select id="csPb"><option value="">No playbook: write it here</option>${pbs.map((p) => `<option value="${esc(p.id)}" ${p.id === ai.playbookId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
            <div class="cs-pb hidden" id="csPbCard"></div>` : ''}
            <p class="sub cs-opt" id="csOpt">Everything here is optional. The more it knows, the better it answers.</p>
            <label><span id="csBusinessL">About the business or this offer <span class="opt">the only facts it will use</span></span><textarea id="csBusiness" rows="5" placeholder="What you offer, prices, timings, FAQs, links.">${esc(ai.business)}</textarea></label>
            <label><span id="csQualifiedL">What makes a qualified lead</span><textarea id="csQualified" rows="2" placeholder="e.g. Wants a website within 2 months, budget over ₹20,000.">${esc(ai.qualified)}</textarea></label>
            <label><span id="csNextL">Next step to offer <span class="opt">when they qualify</span></span><input id="csNext" maxlength="1000" placeholder="e.g. A free 20-minute call: https://cal.com/your-link" value="${esc(ai.nextStep)}" /></label>
            <label><span id="csToneL">Tone</span><input id="csTone" maxlength="300" placeholder="e.g. Friendly and short." value="${esc(ai.tone)}" /></label>
            <label class="pb-row"><span><b>Send replies on its own <span class="pill scheduled">Beta</span></b><small>Off: each reply waits in the Inbox for you to send.</small></span>${toggleHtml({ checked: ai.auto, attrs: 'id="csAuto"', size: 'sm' })}</label>
            <p class="sub cs-warn ${ai.auto ? '' : 'hidden'}" id="csWarn">${esc(AUTO_NOTE)}</p>
          </div>
        </div>` : ''}
      </div>
      <aside class="cs-preview" aria-label="Message preview"><div class="field-label">Preview <span class="opt" id="csPrevMeta"></span></div><div class="cs-prev-box" id="csPrev"></div></aside>
      </div>
      <div class="modal-actions">${!isNew && !sent ? `<button class="btn quiet danger cs-del" id="csDel">${icon('delete', 15)}Delete draft</button>` : ''}<button class="btn quiet" id="csCancel">Cancel</button><button class="btn primary" id="csSave">${isNew ? 'Create campaign' : 'Save'}</button></div>`);
    $('#modal .modal-box').classList.add('cs-box');
    // The chosen template as the message people get (variables shown as {{1}} until the Send page fills them).
    const drawPreview = () => {
      const t = state.templates.find((x) => x.id === tplId);
      $('#csPrevMeta', body).textContent = t ? t.variables.length ? `${t.variables.length} variable${t.variables.length > 1 ? 's' : ''} to fill in next` : 'no variables' : '';
      $('#csPrev', body).innerHTML = t
        ? `<div class="phone cs-phone"><div class="bubble">${bubbleHtml(t, {}, true)}</div></div>`
        : `<div class="cs-prev-empty">${icon('file-text', 22)}<b>No template yet</b><span>Choose one to see the message here.</span></div>`;
    };
    // The numbers: only those that can send the chosen template (its WhatsApp Business Account). All of them to start.
    const nums = new Set(rec?.senderIds || []);
    const eligible = () => { const all = state.senders.filter((x) => x.enabled), t = state.templates.find((x) => x.id === tplId); return t ? templateSenders(t, all) : all; };
    const av = (x) => `<span class="ss-av">${x.photoUrl ? `<img src="${esc(x.photoUrl)}" alt="" onerror="this.remove()">` : ''}<b>${esc((x.label || '?').trim().charAt(0).toUpperCase())}</b></span>`;
    const nameOf = (x) => x.verifiedName || x.label;
    // The closed dropdown: the one number, or "3 numbers" with their faces.
    const drawNums = () => {
      const el = $('#csNums', body);
      if (!el) return;
      if (!tplId) { el.disabled = true; $('#csNumsHint', body).textContent = ''; el.innerHTML = '<span class="cs-numsel-t muted">Choose a template first</span>'; return; }
      const list = eligible(), all = state.senders.filter((x) => x.enabled);
      for (const id of [...nums]) if (!list.some((x) => x.id === id)) nums.delete(id);
      if (!nums.size) list.forEach((x) => nums.add(x.id));
      const on = list.filter((x) => nums.has(x.id));
      $('#csNumsHint', body).textContent = on.length > 1 ? 'split evenly across them' : '';
      el.disabled = list.length < 2;
      el.innerHTML = !list.length
        ? `<span class="cs-numsel-t muted">${all.length ? 'No number can send this template (another WhatsApp Business Account)' : 'No numbers yet: add one under Numbers'}</span>`
        : on.length === 1
          ? `${av(on[0])}<span class="cs-numsel-t"><b>${esc(nameOf(on[0]))}</b><small>${esc(on[0].displayPhone || '')}</small></span>`
          : `<span class="cs-faces">${on.slice(0, 3).map(av).join('')}</span><span class="cs-numsel-t"><b>${on.length === list.length ? `All ${on.length} numbers` : `${on.length} numbers`}</b><small>${esc(on.map(nameOf).filter((v, i, a) => a.indexOf(v) === i).join(', '))}</small></span>`;
    };
    // Open: tick or untick numbers (it stays open while you pick; at least one stays on).
    $('#csNums', body)?.addEventListener('click', (e) => {
      const list = eligible();
      if (list.length < 2) return;
      const r = e.currentTarget.getBoundingClientRect();
      const pop = Sheet.Menu.panel(r.left, r.bottom + 6, `<div class="ss-list" role="listbox" aria-multiselectable="true"></div><div class="cs-numsel-foot"><button type="button" class="btn sm quiet" data-all>Select all</button><button type="button" class="btn sm primary" data-done>Done</button></div>`);
      pop.classList.add('ss-pop');
      pop.style.minWidth = r.width + 'px';
      const draw = () => {
        pop.querySelector('.ss-list').innerHTML = list.map((x) => { const on = nums.has(x.id); return `<button type="button" role="option" class="ss-opt has-av ${on ? 'on' : ''}" data-sid="${x.id}" aria-selected="${on}"><i class="ss-check">${on ? icon('check-one', 15) : ''}</i>${av(x)}<span>${esc(nameOf(x))}</span><small class="ss-count">${esc(x.displayPhone || '')}</small></button>`; }).join('');
        pop.querySelector('[data-all]').disabled = nums.size === list.length;
      };
      draw();
      pop.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-done]')) return Sheet.Menu.close();
        if (ev.target.closest('[data-all]')) list.forEach((x) => nums.add(x.id));
        const b = ev.target.closest('.ss-opt');
        if (b) {
          if (nums.has(b.dataset.sid)) { if (nums.size === 1) return toast('Send from at least one number', 'error'); nums.delete(b.dataset.sid); } else nums.add(b.dataset.sid);
        }
        draw();
        drawNums();
      });
    });
    const drawTpl = () => { const b = $('#csTpl', body); if (b) { b.innerHTML = tplButton(state.templates.find((t) => t.id === tplId)); b.classList.toggle('empty', !tplId); $('#csTplX', body).classList.toggle('hidden', !tplId); } drawNums(); drawPreview(); };
    $('#csTplX', body)?.addEventListener('click', () => { tplId = ''; drawTpl(); $('#csTpl', body).focus(); });
    drawTpl();
    $('#csName', body)?.focus();
    $('#csTpl', body)?.addEventListener('click', () => {
      if (!state.templates.length) { closeModal(); showTab('templates'); return toast('Add or sync a template first'); }
      window.TemplatePicker({ selected: tplId, stacked: true, useText: 'Use this template', onUse: (id) => { tplId = id; drawTpl(); } });
    });
    const aiOn = $('#csAi', body), auto = $('#csAuto', body);
    aiOn?.addEventListener('change', () => $('#csAiFields', body).classList.toggle('hidden', !aiOn.checked));
    auto?.addEventListener('change', () => $('#csWarn', body).classList.toggle('hidden', !auto.checked));
    // A playbook chosen: it shows read-only, and the fields become what this campaign adds on top of it.
    const PH = { business: 'What you offer, prices, timings, FAQs, links.', qualified: 'e.g. Wants a website within 2 months, budget over ₹20,000.', next: 'e.g. A free 20-minute call: https://cal.com/your-link', tone: 'e.g. Friendly and short.' };
    const drawPb = () => {
      const sel = $('#csPb', body);
      if (!sel) return;
      const p = pbs.find((x) => x.id === sel.value);
      const card = $('#csPbCard', body);
      card.classList.toggle('hidden', !p);
      const set = (id, html) => { $(id, body).innerHTML = html; };
      if (!p) {
        set('#csOpt', 'Everything here is optional. The more it knows, the better it answers.');
        set('#csBusinessL', 'About the business or this offer <span class="opt">the only facts it will use</span>');
        set('#csQualifiedL', 'What makes a qualified lead');
        set('#csNextL', 'Next step to offer <span class="opt">when they qualify</span>');
        set('#csToneL', 'Tone');
        $('#csBusiness', body).placeholder = PH.business; $('#csQualified', body).placeholder = PH.qualified; $('#csNext', body).placeholder = PH.next; $('#csTone', body).placeholder = PH.tone;
        return;
      }
      const row = (label, v) => (String(v || '').trim() ? `<div class="cs-pb-row"><span>${label}</span><p>${esc(v)}</p></div>` : '');
      card.innerHTML = `<div class="cs-pb-h">${icon('sparkles', 15)}<b>${esc(p.name)}</b><span class="opt">used as it is · edit it in Settings → Lead assistant</span></div>
        <div class="cs-pb-body">${row('About the business', p.business) + row('Qualified lead', p.qualified) + row('Next step', p.nextStep) + row('Tone', p.tone) || '<p class="muted">This playbook is empty.</p>'}</div>
        <button type="button" class="cs-pb-more" id="csPbMore">Show all</button>`;
      $('#csPbMore', body).onclick = (e) => { card.classList.toggle('open'); e.currentTarget.textContent = card.classList.contains('open') ? 'Show less' : 'Show all'; };
      set('#csOpt', `Anything you add below goes on top of <b>${esc(p.name)}</b>, for this campaign only. The playbook isn't changed.`);
      set('#csBusinessL', 'Add for this campaign <span class="opt">extra facts: this offer, its price, dates, links</span>');
      set('#csQualifiedL', 'Add to what makes a qualified lead');
      set('#csNextL', 'Next step <span class="opt">leave empty to use the playbook’s</span>');
      set('#csToneL', 'Tone <span class="opt">leave empty to use the playbook’s</span>');
      $('#csBusiness', body).placeholder = 'e.g. Diwali offer: 20% off all sweet boxes till Nov 15. Free delivery over ₹999.';
      $('#csQualified', body).placeholder = 'e.g. Wants 10 or more boxes (corporate gifting).';
      $('#csNext', body).placeholder = p.nextStep || PH.next;
      $('#csTone', body).placeholder = p.tone || PH.tone;
    };
    $('#csPb', body)?.addEventListener('change', drawPb);
    drawPb();
    $('#csCancel', body).onclick = () => { closeModal(); onCancel?.(); };
    $('#csDel', body)?.addEventListener('click', () => guard(async () => {
      if (!(await confirmDialog({ title: `Delete “${esc(rec.name)}”?`, message: 'The draft and the sheets you set up for it are removed. Nothing was sent.', confirmText: 'Delete', danger: true }))) return;
      await remove(rec.id);
      closeModal();
    }));
    const collect = () => (showAi ? {
      on: aiOn.checked, auto: aiOn.checked && auto.checked, business: $('#csBusiness', body).value, qualified: $('#csQualified', body).value,
      nextStep: $('#csNext', body).value.trim(), tone: $('#csTone', body).value.trim(), playbookId: $('#csPb', body)?.value || '',
    } : ai);
    $('#csSave', body).onclick = (e) => guard(async () => {
      let saved;
      if (sent) saved = { ...campaign, ...(await api(`/campaigns/${campaign.id}/ai`, { method: 'PATCH', body: { ai: collect() } })) };
      else {
        const nm = $('#csName', body).value.trim();
        if (!nm) { $('#csName', body).focus(); throw new Error('Give the campaign a name'); }
        if (!tplId) throw new Error('Choose a template');
        if (!nums.size) throw new Error('Choose a number to send from');
        const data = { name: nm, description: $('#csDesc', body).value.trim(), templateId: tplId, senderIds: [...nums], ai: collect() };
        saved = isNew ? await api('/drafts', { method: 'POST', body: data }) : await api(`/drafts/${draft.id}`, { method: 'PATCH', body: data });
      }
      closeModal();
      if (sent) toast(saved.ai.on ? 'AI replies on for this campaign' : 'AI replies off for this campaign');
      onSaved?.(saved);
    }, e.currentTarget);
  }

  async function remove(id) {
    await api('/drafts/' + id, { method: 'DELETE' });
    window.SendPage?.forgetCampaign(id);
    toast('Draft deleted');
    if (state.tab === 'campaigns') loadCampaigns();
  }

  // New campaign, then its Send page. then(): runs once the page is open for it (e.g. to add a sheet).
  function create({ name = '', templateId = '', then = null } = {}) {
    open({ name, templateId, onSaved: (d) => { window.SendPage.openCampaign(d); then?.(d); } });
  }

  // Open a draft from the Campaigns page (the latest from the server, in case it changed elsewhere).
  async function resume(id) {
    const d = await api('/drafts/' + id);
    window.SendPage.openCampaign(d);
  }

  // Once per browser: Send moved into Campaigns, and how a campaign is made now.
  const SEEN = 'seen:campaign-flow';
  function whatsNew({ force = false } = {}) {
    try { if (!force && localStorage.getItem(SEEN)) return; localStorage.setItem(SEEN, '1'); } catch { if (!force) return; }
    const step = (n, ic, title, text) => `<li class="wn-step"><span class="wn-ic">${icon(ic, 18)}<i>${n}</i></span><div><b>${title}</b><p>${text}</p></div></li>`;
    const body = openModal('Send now lives in Campaigns', `
      <p class="sub wn-lead">There's no separate Send page any more. Every send starts as a campaign, so its message, numbers, AI replies and results stay together in one folder.</p>
      <ol class="wn-steps">
        ${step(1, 'chart-column-increasing', 'Go to Campaigns → New campaign', 'It’s in the sidebar. The Send item is gone.')}
        ${step(2, 'file-text', 'Name it, pick the template and numbers', 'Add a description if you like. The message preview shows on the right. Turn on <b>AI replies</b> to have replies answered from a playbook, with extra details for this campaign.')}
        ${step(3, 'users', 'Add the people and personalise', 'Upload a file, paste rows or pick from Contacts, just like before. Fill in the variables, send a test, then send now or schedule it.')}
        ${step(4, 'clock', 'Not ready yet? It waits in Drafts', 'Leave any time: the campaign is saved as a draft. Open <b>Drafts</b> on the Campaigns page to carry on.')}
      </ol>
      <div class="modal-actions"><button class="btn quiet" id="wnOk">Got it</button><button class="btn primary" id="wnGo">${icon('plus', 15)}Create a campaign</button></div>`);
    $('#modal .modal-box').classList.add('wn-box');
    $('#wnOk', body).onclick = closeModal;
    $('#wnGo', body).onclick = () => { closeModal(); create(); };
  }

  window.CampaignSetup = { open, create, resume, remove, whatsNew };
})();
