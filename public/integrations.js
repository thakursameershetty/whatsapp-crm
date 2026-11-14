// Settings → Developer → API keys (integrations.js on the server): create a key for another app, see when each
// was last used, revoke one. A new key is shown once, here, with a Copy button; afterwards only its last 4 show.
(() => {
  const list = $('#apiKeyList');
  if (!list) return;
  let keys = [];

  function draw() {
    if (!keys.length) {
      list.innerHTML = '<p class="api-keys-empty">No keys yet. Create one below and paste it into the other app.</p>';
      return;
    }
    list.innerHTML = keys.map((k) => `
      <div class="api-key" data-id="${esc(k.id)}">
        <div class="api-key-main">
          <b>${esc(k.name)}</b>
          <span class="api-key-meta"><code>sk_sendon_…${esc(k.last4)}</code> · created ${relTime(k.createdAt)} · ${k.lastUsedAt ? 'last used ' + relTime(k.lastUsedAt) : 'never used'}</span>
        </div>
        <button type="button" class="btn sm" data-revoke="${esc(k.id)}">Revoke</button>
      </div>`).join('');
  }

  async function load() {
    try { keys = await api('/integrations/keys'); draw(); }
    catch (e) { list.innerHTML = `<p class="api-keys-empty">${esc(e.message)}</p>`; }
  }

  // Load when the Developer tab is first shown (no request for people who never open it).
  new IntersectionObserver((entries, obs) => {
    if (entries.some((e) => e.isIntersecting)) { obs.disconnect(); load(); }
  }).observe(list);

  $('#apiKeyCreate').addEventListener('click', (e) => guard(async () => {
    const name = $('#apiKeyName').value.trim() || 'Spotmies CRM';
    const made = await api('/integrations/keys', { method: 'POST', body: { name } });
    $('#apiKeyName').value = '';
    const box = $('#apiKeyNew');
    box.innerHTML = `
      <p><b>Copy this key now.</b> It won’t be shown again. Paste it into ${esc(made.name)}’s SendON settings.</p>
      <div class="input-group"><input id="apiKeyValue" readonly value="${esc(made.key)}" aria-label="New API key" /><button type="button" class="btn sm copy" data-copy="apiKeyValue">Copy</button></div>`;
    box.classList.remove('hidden');
    await load();
  }, e.currentTarget));

  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-revoke]');
    if (!b) return;
    const k = keys.find((x) => x.id === b.dataset.revoke);
    guard(async () => {
      const ok = await confirmDialog({
        title: `Revoke “${esc(k?.name || 'this key')}”?`,
        message: 'Apps using it stop working straight away. Campaigns they already started keep sending.',
        confirmText: 'Revoke',
        danger: true,
      });
      if (!ok) return;
      await api('/integrations/keys/' + encodeURIComponent(b.dataset.revoke), { method: 'DELETE' });
      $('#apiKeyNew').classList.add('hidden');
      await load();
      toast('Key revoked');
    }, b);
  });
})();
