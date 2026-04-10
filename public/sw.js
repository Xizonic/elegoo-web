// Minimal service worker for PWA installability
const CACHE_NAME = 'elegoo-web-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Network-first strategy — always prefer live data from printer
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
