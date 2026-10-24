// Animated Lucide icons, ported from lucide-animated (https://lucide-animated.com)
// to plain SVG + CSS so they work without React/motion. Each icon plays its
// animation when the element it sits in (button, tab, tile, card…) is hovered
// or focused. Animations live in style.css under "Animated icons".

(function () {
  // pathLength="1" lets CSS draw strokes with stroke-dashoffset 1 → 0.
  const PL = 'pathLength="1"';
  const SUN_RAYS = ['M12 2v2', 'm19.07 4.93-1.41 1.41', 'M20 12h2', 'm17.66 17.66 1.41 1.41', 'M12 20v2', 'm6.34 17.66-1.41 1.41', 'M2 12h2', 'm4.93 4.93 1.41 1.41'];
  const SM_RAYS = ['M12 2v2', 'M12 20v2', 'm4.9 4.9 1.4 1.4', 'm17.7 17.7 1.4 1.4', 'M2 12h2', 'M20 12h2', 'm6.3 17.7-1.4 1.4', 'm19.1 4.9-1.4 1.4'];
  const rays = (list) => list.map((d, i) => `<path class="ray" style="--i:${i + 1}" d="${d}"/>`).join('');

  const ICONS = {
    send: `<g class="a-plane"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></g>
      <path class="a-trail" d="M -3 28 C -0.5 26.8 1.6 24.6 3.3 22 C 4.8 19.7 5.2 17.6 4.2 16.1 C 3.2 14.7 1.4 14.5 0.3 15.8 C -0.9 17.2 -0.6 19.4 1.2 20.4 C 3.4 21.5 6.4 19.4 9 15.8" stroke-dasharray="2 2" stroke-width="1"/>`,
    'check-check': `<path class="draw" style="--i:0" ${PL} d="M2 12 7 17L18 6"/><path class="draw" style="--i:1" ${PL} d="M13 16L14.5 17.5L22 10"/>`,
    eye: `<path class="a-lid" d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle class="a-pupil" cx="12" cy="12" r="3"/>`,
    'badge-alert': `<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>`,
    upload: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><g class="a-arrow"><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></g>`,
    'cloud-upload': `<path d="M4.2 15.1A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.2"/><g class="a-arrow"><path d="M12 13v8"/><path d="m8 17 4-4 4 4"/></g>`,
    'refresh-cw': `<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`,
    plus: `<path d="M5 12h14"/><path d="M12 5v14"/>`,
    bell: `<g class="a-bell"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/></g><path class="a-clap" d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`,
    'bell-off': `<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/>`,
    delete: `<g class="a-lid"><path d="M3 6h18"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></g><g class="a-bin"><path d="M19 8v12c0 1-1 2-2 2H7c-1 0-2-1-2-2V8"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></g>`,
    copy: `<rect class="a-front" height="14" rx="2" ry="2" width="14" x="8" y="8"/><path class="a-back" d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`,
    clock: `<circle cx="12" cy="12" r="10"/><line class="a-hour" x1="12" x2="12" y1="12" y2="6"/><line class="a-min" x1="12" x2="16" y1="12" y2="12"/>`,
    search: `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`,
    rocket: `<path class="a-fire" d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>`,
    zap: `<path class="draw" ${PL} d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>`,
    'layout-grid': `<rect class="r1" height="7" rx="1" width="7" x="3" y="3"/><rect class="r2" height="7" rx="1" width="7" x="14" y="3"/><rect class="r3" height="7" rx="1" width="7" x="14" y="14"/><rect class="r4" height="7" rx="1" width="7" x="3" y="14"/>`,
    'chart-column-increasing': `<path class="redraw" style="--i:1" ${PL} d="M13 17V9"/><path class="redraw" style="--i:2" ${PL} d="M18 17V5"/><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path class="redraw" style="--i:0" ${PL} d="M8 17v-3"/>`,
    phone: `<path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"/>`,
    'file-text': `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path class="redraw" style="--d:.3s" ${PL} d="M10 9H8"/><path class="redraw" style="--d:.5s" ${PL} d="M16 13H8"/><path class="redraw" style="--d:.7s" ${PL} d="M16 17H8"/>`,
    settings: `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
    sun: `<circle cx="12" cy="12" r="4"/>${rays(SUN_RAYS)}`,
    'sun-moon': `<g class="a-moon"><path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4"/></g>${rays(SM_RAYS)}`,
    moon: `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`,
    'calendar-days': `<path d="M8 2v4"/><path d="M16 2v4"/><rect height="18" rx="2" width="18" x="3" y="4"/><path d="M3 10h18"/>${[[8, 14], [12, 14], [16, 14], [8, 18], [12, 18], [16, 18]].map(([cx, cy], i) => `<circle class="dot" style="--i:${i}" cx="${cx}" cy="${cy}" r="1" fill="currentColor" stroke="none"/>`).join('')}`,
    history: `<g class="a-arrow"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></g><line class="a-hour" x1="12" x2="12" y1="12" y2="7"/><line class="a-min" x1="12" x2="16" y1="12" y2="14"/>`,
    user: `<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>`,
    lock: `<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path class="a-slide" d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
    users: `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path class="a-slide" d="M22 21v-2a4 4 0 0 0-3-3.87"/><path class="a-slide" d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
    'circle-check': `<circle cx="12" cy="12" r="10"/><path class="draw" ${PL} d="m9 12 2 2 4-4"/>`,
    'maximize-2': `<path class="a-bl" d="M3 16.2V21m0 0h4.8M3 21l6-6"/><path class="a-tr" d="M21 7.8V3m0 0h-4.8M21 3l-6 6"/>`,
    x: `<path class="draw" style="--i:0" ${PL} d="M18 6 6 18"/><path class="draw" style="--i:2" ${PL} d="m6 6 12 12"/>`,
    'panel-right-open': `<rect height="18" rx="2" width="18" x="3" y="3"/><path d="M15 3v18"/><path class="a-chev" d="m10 15-3-3 3-3"/>`,
    'sliders-horizontal': `<line class="s1r" x1="21" x2="14" y1="4" y2="4"/><line class="s1l" x1="10" x2="3" y1="4" y2="4"/><line class="s2r" x1="21" x2="12" y1="12" y2="12"/><line class="s2l" x1="8" x2="3" y1="12" y2="12"/><line class="s3l" x1="3" x2="12" y1="20" y2="20"/><line class="s3r" x1="16" x2="21" y1="20" y2="20"/><line class="k1" x1="14" x2="14" y1="2" y2="6"/><line class="k2" x1="8" x2="8" y1="10" y2="14"/><line class="k3" x1="16" x2="16" y1="18" y2="22"/>`,
    'trending-up': `<polyline class="draw" ${PL} points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline class="draw-late" ${PL} points="16 7 22 7 22 13"/>`,
    'trending-down': `<polyline class="draw" ${PL} points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline class="draw-late" ${PL} points="16 17 22 17 22 11"/>`,
    'chart-spline': `<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path class="draw" style="--i:1.5" ${PL} d="M7 16c.5-2 1.5-7 4-7 2 0 2 3 4 3 2.5 0 4.5-5 5-7"/>`,
    'message-circle': `<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>`,
    'arrow-left': `<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>`,
    reply: `<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>`,
    'map-pin': `<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>`,
    'square-pen': `<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>`,
    download: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><g class="a-arrow"><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></g>`,
    // Assistant
    sparkles: `<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.13 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z"/><path class="a-twinkle" d="M20 3v4"/><path class="a-twinkle" d="M22 5h-4"/>`,
    paperclip: `<path class="a-clip" d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>`,
    'arrow-up': `<g class="a-arrow"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></g>`,
    'panel-left': `<rect height="18" rx="2" width="18" x="3" y="3"/><path d="M9 3v18"/><path class="a-chev" d="m16 15-3-3 3-3"/>`,
    'file-spreadsheet': `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>`,
    'check-one': `<path class="draw" ${PL} d="M20 6 9 17l-5-5"/>`,
    'chevron-down': `<path d="m6 9 6 6 6-6"/>`,
    square: `<rect x="6" y="6" width="12" height="12" rx="2"/>`,
    list: `<path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/>`,
    // Spreadsheet
    'undo-2': `<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>`,
    'redo-2': `<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>`,
  };

  // Names used before the animated set existed.
  const ALIASES = { template: 'file-text', calendar: 'calendar-days', chart: 'chart-column-increasing', check: 'check-check', alert: 'badge-alert' };

  function icon(name, size = 18) {
    const key = ALIASES[name] || name;
    const body = ICONS[key];
    if (!body) return '';
    return `<svg class="la la-${key}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  // Elements whose hover/focus plays the icons inside them.
  const HOST = '.btn, .seg > button, .kpi, .mini-item, .dropzone, .empty, .empty-mini, .stepc, .list-item, .badge, .card-head, .search-wrap, .la-host, .toast';

  function play(host) {
    host.querySelectorAll('svg.la').forEach((svg) => {
      svg.classList.remove('on');
      void svg.getBoundingClientRect(); // restart keyframe animations
      svg.classList.add('on');
    });
  }
  function stop(host) {
    host.querySelectorAll('svg.la.on').forEach((svg) => svg.classList.remove('on'));
  }

  document.addEventListener('pointerover', (e) => {
    const host = e.target.closest?.(HOST);
    if (host && !host.contains(e.relatedTarget)) play(host);
  });
  document.addEventListener('pointerout', (e) => {
    const host = e.target.closest?.(HOST);
    if (host && !host.contains(e.relatedTarget)) stop(host);
  });
  document.addEventListener('focusin', (e) => {
    const host = e.target.closest?.(HOST);
    if (host && e.target.matches(':focus-visible, input')) play(host);
  });
  document.addEventListener('focusout', (e) => {
    const host = e.target.closest?.(HOST);
    if (host && !host.contains(e.relatedTarget)) stop(host);
  });

  // Static markup can ask for an icon with data-icon="name".
  function hydrate(root = document) {
    root.querySelectorAll('[data-icon]:not([data-icon-done])').forEach((el) => {
      el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, Number(el.dataset.iconSize) || 16));
      el.dataset.iconDone = '1';
    });
  }

  window.LA = { icon, play, stop, hydrate, names: Object.keys(ICONS) };
})();
