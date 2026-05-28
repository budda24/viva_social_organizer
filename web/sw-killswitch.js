// Self-unregistering service worker. Replaces the old Flutter PWA service
// worker that was caching main.dart.js aggressively. When an existing client
// fetches this file as an SW update, the browser activates this script,
// which then unregisters itself and force-reloads all controlled pages so
// they fall back to plain HTTP caching (controlled by Firebase Hosting
// headers in firebase.json). After every browser has rotated through once,
// this file can be deleted or kept as a safety net.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) {
      // ignore — best effort
    }
    try {
      await self.registration.unregister();
    } catch (_) {
      // ignore — best effort
    }
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      try {
        await client.navigate(client.url);
      } catch (_) {
        // some clients refuse navigate(); they'll pick up the change on
        // their next manual refresh, which is fine.
      }
    }
  })());
});
