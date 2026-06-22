// A minimal service worker to allow PWA installation
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  // Network-only strategy (we just need the handler to exist for PWA criteria)
  e.respondWith(fetch(e.request));
});