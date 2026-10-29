/*
 * Service worker — a cache allowlist, not an offline copy of the app.
 *
 * The rule this file enforces is the one in risk R10: the worker must never be able to
 * serve a byte of clinical content. So it caches exactly two kinds of thing:
 *
 *   1. build-hashed static assets under /_next/static/ and /icons/ — immutable by
 *      construction, and holding no patient data;
 *   2. the /offline page, which is deliberately content-free.
 *
 * Everything else — every HTML response, every API call, every report route — is
 * network-only. A navigation that fails while offline gets /offline instead of a stale
 * page. This is why there is no precache manifest and no Workbox: the useful part of
 * Workbox is precaching, and precaching is precisely what this product must not do.
 *
 * No PHI in Cache Storage is a property you can check by reading this file. That is the
 * point of keeping it short.
 */

const VERSION = 'v1';
const STATIC_CACHE = `static-${VERSION}`;
const OFFLINE_URL = '/offline';

/** Explicit, ordered allowlist. A path not listed here is never cached. */
const CACHEABLE = [/^\/_next\/static\//, /^\/icons\//];

const PRECACHE = [OFFLINE_URL, '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Anything that is not a same-origin GET is not ours to intercept.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  const path = new URL(request.url).pathname;

  if (CACHEABLE.some((pattern) => pattern.test(path))) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Navigations: network, then the content-free offline page. Never a cached document.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL).then((r) => r ?? Response.error())),
    );
  }
});
