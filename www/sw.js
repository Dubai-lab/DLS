/* ============================================================================
   Tombstone service worker.

   The DLS Africa Hub is a native app now. This file replaces the old caching
   service worker so that browsers which already installed the PWA do not keep
   serving it forever from their cache.

   An installed service worker updates itself by re-fetching this exact URL, so
   the only reliable way to retire one is to ship a replacement that deletes its
   caches and unregisters itself. Deleting the file instead would leave the old
   worker live on every device that ever installed it.

   Keep this served at the site root for at least one full season. Removing it
   early strands anyone who has not opened the site since the cutover.
   ========================================================================= */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // 1. drop every cache this origin owns
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));

    // 2. stand down
    await self.registration.unregister();

    // 3. reload any open tab so it leaves the cached copy behind
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.navigate(client.url).catch(() => {});
    }
  })());
});

// Serve nothing from cache while this worker is still winding down.
self.addEventListener('fetch', event => {
  event.respondWith(fetch(event.request));
});
