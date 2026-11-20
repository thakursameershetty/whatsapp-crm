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

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/inbox';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const here = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (here) { await here.navigate(url).catch(() => {}); return here.focus(); }
    return self.clients.openWindow(url);
  })());
});
