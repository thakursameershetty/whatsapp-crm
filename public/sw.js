// SendON's service worker: only for alerts (alerts.js on the server). It shows a notification when a chat is waiting
// for a person, even with SendON closed, and opens that chat when it's clicked. It doesn't cache anything.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'SendON', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: Boolean(d.tag),
    requireInteraction: true, // stays on screen until someone looks
    icon: '/brand/logo-small.svg',
    badge: '/brand/logo-small.svg',
    data: { url: d.url || '/inbox' },
  }));
});

// Clicking an alert opens what it's about (a chat: /inbox?ws=…&chat=…). A SendON window that's already open is asked
// to show it (it switches without reloading, or loads the link when it's another workspace); only with none open
// does a new window open. A window opened before alerts were on isn't controlled by this worker, so it can't be
// redirected from here: asking it (postMessage) works either way.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/inbox', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .filter((w) => new URL(w.url).origin === self.location.origin);
    // the one in front, else the most recently used
    const win = wins.find((w) => w.focused) || wins.find((w) => w.visibilityState === 'visible') || wins[0];
    if (!win) return self.clients.openWindow(url);
    win.postMessage({ kind: 'sendon-open', url });
    return win.focus().catch(() => self.clients.openWindow(url));
  })());
});
