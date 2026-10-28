/**
 * Service worker: offline app shell only.
 *
 * Deliberate rule: no API response containing patient data is ever cached here.
 * Drafts live in IndexedDB (optionally encrypted); the HTTP cache holds only
 * static assets and the template library.
 */

const VERSION = 'rpwa-v8';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/editor.js',
  'js/doc.js',
  'js/validate.js',
  'js/export.js',
  'js/store.js',
  'js/crypto.js',
  'js/ui.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'data/templates.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, fall back to the cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('index.html'))
    );
    return;
  }

  // Template library: cache first, refresh in the background.
  if (url.pathname.endsWith('data/templates.json')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((res) => {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(request, copy));
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  const isStatic = /\.(js|css|svg|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/');
  if (isStatic) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(request, copy));
        return res;
      }))
    );
  }
});
