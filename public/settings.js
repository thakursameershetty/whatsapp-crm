// Settings: tabs across the top (Account, Inbox & AI, Sending, Developer, Appearance) and a search over every
// setting. Each tab has its own address (/settings/developer; Account is plain /settings), so a reload or a
// shared link opens the right one. The settings themselves are still filled and saved by app.js (renderSettings,
// saveSettings): this file only shows one panel at a time and finds things.
window.SettingsTabs = (() => {
  const TABS = ['account', 'inbox', 'sending', 'developer', 'appearance'];
  const LABEL = { account: 'Account', inbox: 'Inbox & AI', sending: 'Sending', developer: 'Developer', appearance: 'Appearance' };
  const ALIAS = { workspace: 'account' }; // Workspace and Account were one tab each before
  const norm = (s) => (TABS.includes(ALIAS[s] || s) ? ALIAS[s] || s : 'account');
  const fromPath = () => norm(location.pathname.split('/')[2]);
  let cur = fromPath();

  function draw() {
    $$('#setTabs [data-set]').forEach((b) => {
      const on = b.dataset.set === cur;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    $$('#tab-settings .set-panel').forEach((p) => {
      const was = p.classList.contains('hidden');
      p.classList.toggle('hidden', p.dataset.panel !== cur);
      if (was && p.dataset.panel === cur) Motion.enter?.(p);
    });
    moveBar();
    Motion.segs?.($('#tab-settings .set-panel:not(.hidden)'));
    renderThemeSeg?.();
    speed();
  }
  // The underline slides to the active tab.
  function moveBar() {
    const nav = $('#setTabs'), on = nav?.querySelector('.active');
    if (!nav || !on || !nav.offsetWidth) return;
    nav.style.setProperty('--bar-x', on.offsetLeft + 'px');
    nav.style.setProperty('--bar-w', on.offsetWidth + 'px');
    on.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); // narrow screens: the tab bar scrolls sideways
  }
  addEventListener('resize', moveBar);

  // Pick a tab: the address follows (pushState, so Back returns to the previous tab).
  function pick(name, { push = true } = {}) {
    name = norm(name);
    const changed = name !== cur;
    cur = name;
    draw();
    const path = '/settings' + (name === 'account' ? '' : '/' + name);
    if (state.tab === 'settings' && location.pathname !== path) history[push && changed ? 'pushState' : 'replaceState']({ tab: 'settings' }, '', path);
  }
  $('#setTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-set]'); if (b) pick(b.dataset.set); });
  $('#setTabs').addEventListener('keydown', (e) => { // arrow keys move between tabs
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    pick(TABS[(TABS.indexOf(cur) + d + TABS.length) % TABS.length]);
    $('#setTabs .active')?.focus();
  });

  // --- Search: every .setting-row and every card, by its title, its text and its data-find words ---------------------
  const titleOf = (el) => (el.querySelector(el.matches('.set-group') ? ':scope > .set-gh h3' : '.setting-title')?.textContent || '').trim();
  function index() {
    const out = [];
    $$('#tab-settings .set-panel').forEach((panel) => {
      panel.querySelectorAll('.set-group, .setting-row').forEach((el) => {
        if (el.closest('.hidden') || getComputedStyle(el).display === 'none') return; // not for this person (e.g. no AI)
        const title = titleOf(el);
        if (!title) return;
        const text = `${title} ${el.dataset.find || ''} ${el.matches('.setting-row') ? el.textContent : ''}`.toLowerCase();
        out.push({ el, title, panel: panel.dataset.panel, row: el.matches('.setting-row'), text });
      });
    });
    return out;
  }
  let hits = [], sel = 0;
  function search() {
    const q = $('#setQ').value.trim().toLowerCase(), box = $('#setResults');
    if (!q) { box.classList.add('hidden'); hits = []; return; }
    const words = q.split(/\s+/);
    hits = index().filter((x) => words.every((w) => x.text.includes(w)))
      .sort((a, b) => (b.title.toLowerCase().includes(q) - a.title.toLowerCase().includes(q)) || (b.row - a.row))
      .slice(0, 8);
    sel = 0;
    box.innerHTML = hits.length
      ? hits.map((h, i) => `<button type="button" role="option" class="set-hit ${i === sel ? 'on' : ''}" data-i="${i}"><b>${esc(h.title)}</b><span>${esc(LABEL[h.panel])}</span></button>`).join('')
      : `<p class="set-none">No setting matches “${esc(q)}”.</p>`;
    box.classList.remove('hidden');
  }
  function go(h) {
    if (!h) return;
    $('#setQ').value = '';
    $('#setResults').classList.add('hidden');
    pick(h.panel);
    requestAnimationFrame(() => {
      h.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      h.el.classList.remove('set-flash');
      void h.el.offsetWidth; // restart the highlight
      h.el.classList.add('set-flash');
      setTimeout(() => h.el.classList.remove('set-flash'), 1800);
    });
  }
  $('#setQ').addEventListener('input', search);
  $('#setQ').addEventListener('focus', search);
  $('#setQ').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('#setQ').value = ''; search(); $('#setQ').blur(); return; }
    if (!hits.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      $$('#setResults .set-hit').forEach((b, i) => b.classList.toggle('on', i === sel));
    }
    if (e.key === 'Enter') { e.preventDefault(); go(hits[sel]); }
  });
  $('#setResults').addEventListener('mousedown', (e) => { const b = e.target.closest('[data-i]'); if (b) { e.preventDefault(); go(hits[Number(b.dataset.i)]); } });
  $('#setQ').addEventListener('blur', () => setTimeout(() => $('#setResults').classList.add('hidden'), 120));
  // "/" on the Settings page jumps to the search (unless you're typing somewhere).
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || state.tab !== 'settings' || e.metaKey || e.ctrlKey) return;
    if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    $('#setQ').focus();
  });

  // --- Sending: what the two numbers add up to --------------------------------------------------------------------
  function speed() {
    const el = $('#setSpeed');
    if (!el) return;
    const c = Math.max(1, Number($('#setConc').value) || 1), d = Math.max(0, Number($('#setDelay').value) || 0);
    const perSec = d ? (c * 1000) / d : null;
    const fmt = (x) => (x >= 10 ? Math.round(x).toLocaleString() : x.toFixed(1).replace(/\.0$/, ''));
    el.innerHTML = perSec == null
      ? `${LA.icon('zap', 15)}<span>No delay: each number sends as fast as Meta answers, ${c} at a time.</span>`
      : `${LA.icon('trending-up', 15)}<span>At most about <b>${fmt(perSec)} messages a second</b> per number (${fmt(perSec * 60)} a minute).</span>`;
  }
  $('#setConc').addEventListener('input', speed);
  $('#setDelay').addEventListener('input', speed);

  return {
    current: () => cur,
    // Called by showTab('settings'): draw the tab the address (or the last visit) asked for.
    show() { requestAnimationFrame(draw); },
    // Open Settings on a given tab, from anywhere in the app.
    open(name) { if (state.tab === 'settings') return pick(name); cur = norm(name); showTab('settings'); },
    // Back / Forward between /settings/x addresses.
    fromUrl() { cur = fromPath(); draw(); },
  };
})();
