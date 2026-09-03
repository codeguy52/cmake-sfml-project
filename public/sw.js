/*
 * Service worker: makes the app usable with no network after the first visit.
 *
 * Runtime caching rather than a build-time precache manifest, so there is no
 * plugin in the build and no generated file list to drift out of date. The
 * trade-off is that the very first load of each asset needs the network.
 *
 * Two strategies, chosen by what breaks if the cache is stale:
 *  - Navigations are network-first. A stale HTML shell would keep pointing at
 *    hashed asset filenames that no longer exist after a deploy, which is the
 *    one failure mode that leaves a blank page.
 *  - Everything else same-origin is cache-first. Vite's asset filenames are
 *    content-hashed, so a cached hit is by definition the right bytes.
 *
 * The Tesseract language model is cross-origin and deliberately not cached
 * here; the browser's HTTP cache handles it, and it is far too large to hold in
 * a cache this worker manages.
 */

const VERSION = 'v1';
const SHELL_CACHE = `ember-shell-${VERSION}`;
const ASSET_CACHE = `ember-assets-${VERSION}`;

const SHELL_URLS = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // One bad URL must not fail the whole install.
      await Promise.allSettled(SHELL_URLS.map((url) => cache.add(url)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', response.clone());
          return response;
        } catch {
          const cached = await caches.match('./index.html');
          return cached ?? new Response('Offline and no cached copy available.', { status: 503 });
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(ASSET_CACHE);
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
