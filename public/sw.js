/* Minimal service worker — satisfies Chrome's PWA installability requirement.
   Caches the app shell on install for basic offline support.
   Also handles Web Share Target (receiving audio files from other apps). */
const CACHE = 'pitchlist-v1';
const SHARE_CACHE = 'pitchlist-share';
const SHELL = ['/', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== SHARE_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  /* ── Web Share Target ──────────────────────────────────────────────────
     Android delivers shared files as a POST multipart/form-data to /share-target.
     We read each file, store it in the share cache keyed by filename,
     notify any open app windows via postMessage, then redirect to the app. */
  if (e.request.method === 'POST' && url.pathname === '/share-target') {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();
        const files = formData.getAll('audio');

        const shareCache = await caches.open(SHARE_CACHE);
        const stored = [];

        for (const file of files) {
          if (!(file instanceof File)) continue;
          /* Store blob under a predictable key; headers carry name + type */
          const key = '/share-pending/' + encodeURIComponent(file.name);
          await shareCache.put(key, new Response(file, {
            headers: {
              'content-type': file.type || 'audio/mpeg',
              'x-filename': file.name,
            }
          }));
          stored.push({ key, name: file.name, type: file.type });
        }

        /* If the app is already open, message it directly so it can import
           without waiting for a full page navigation. */
        if (stored.length > 0) {
          const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          for (const client of clients) {
            client.postMessage({ type: 'SHARE_RECEIVED', files: stored });
          }
        }
      } catch (err) {
        console.error('[SW] share-target error', err);
      }

      /* Redirect to app; ?shared=1 tells the app to check the share cache */
      return Response.redirect('/?shared=1', 303);
    })());
    return;
  }

  /* ── Normal fetch: network-first, cache fallback ───────────────────── */
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
