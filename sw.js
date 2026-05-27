const CACHE = 'dls-v3';
const STATIC_ASSETS = ['./manifest.json', './dls_logo.jpeg'];
const HTML_FILES = ['.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'Africa DLS Global League 🌍', {
      body: data.body || 'New update available',
      icon: data.icon || './dls_logo.jpeg',
      badge: './dls_logo.jpeg',
      vibrate: [200, 100, 200],
      data: { url: data.url || './viewer.html' }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const match = list.find(c => c.url.includes('viewer.html'));
      if (match) return match.focus();
      return clients.openWindow(e.notification.data.url || './viewer.html');
    })
  );
});

self.addEventListener('fetch', e => {
  if(e.request.url.includes('firebaseio.com')) return;

  const isHTML = HTML_FILES.some(ext => e.request.url.includes(ext)) ||
                 e.request.mode === 'navigate';

  if(isHTML){
    // Network-first for HTML — always get latest code
    e.respondWith(
      fetch(e.request).then(res => {
        if(res.ok){
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
  } else {
    // Cache-first for static assets (images, manifest)
    e.respondWith(
      caches.match(e.request).then(cached => {
        if(cached) return cached;
        return fetch(e.request).then(res => {
          if(res.ok && e.request.method === 'GET'){
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        });
      }).catch(() => caches.match('./viewer.html'))
    );
  }
});
