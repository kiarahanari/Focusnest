/* FocusNest — Service Worker
 * Tugas: (1) app tetap terbuka saat offline, (2) update mulus, (3) klik notifikasi alarm membuka app.
 * Ganti VERSION setiap kali kamu meng-upload index.html baru agar cache lama dibersihkan. */
const VERSION = 'v1';
const CORE = 'focusnest-core-' + VERSION;
const RUNTIME = 'focusnest-runtime-' + VERSION;
const CORE_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-aesthetic-192.png',
  './icon-aesthetic-512.png'
];

const OFFLINE_HTML = '<!doctype html><html lang="id"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>FocusNest — Offline</title>' +
  '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#EEF4FF;color:#1B2A4A;' +
  'font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}button{margin-top:14px;padding:10px 18px;' +
  'border:0;border-radius:12px;background:#5A7FF0;color:#fff;font:inherit;font-weight:700}</style></head><body><div>' +
  '<div style="font-size:48px">📴</div><h1 style="margin:8px 0">Kamu sedang offline</h1>' +
  '<p>FocusNest belum tersimpan di perangkat ini. Sambungkan internet sekali, buka app, lalu lain kali app bisa dipakai tanpa internet.</p>' +
  '<button onclick="location.reload()">Coba lagi</button></div></body></html>';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CORE)
      .then((c) => Promise.all(CORE_FILES.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('focusnest-') && k !== CORE && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

const cacheable = (res) => res && (res.ok || res.type === 'opaque');

async function put(name, req, res) {
  try { const c = await caches.open(name); await c.put(req, res); } catch (e) {}
}

/* Halaman: coba internet dulu (agar update selalu terambil), kalau lambat/gagal pakai cache */
function navigationHandler(req) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
    const fromCache = async () =>
      (await caches.match(req, { ignoreSearch: true })) ||
      (await caches.match('./index.html')) ||
      (await caches.match('./'));
    const timer = setTimeout(() => { fromCache().then(finish); }, 4000);
    fetch(req)
      .then((res) => {
        clearTimeout(timer);
        if (res && res.ok) {
          put(CORE, './index.html', res.clone());
          put(CORE, req, res.clone());
        }
        finish(res);
      })
      .catch(async () => {
        clearTimeout(timer);
        const c = await fromCache();
        finish(c || new Response(OFFLINE_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
      });
  });
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) put(RUNTIME, req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, cacheName) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  const net = fetch(req).then((res) => { if (cacheable(res)) c.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || new Response('', { status: 504 });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') { e.respondWith(navigationHandler(req)); return; }
    e.respondWith(staleWhileRevalidate(req, CORE));
    return;
  }
  /* Kode Firebase SDK (file statis berversi) → disimpan agar app bisa jalan offline */
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(cacheFirst(req).catch(() => new Response('', { status: 504 })));
    return;
  }
  /* Font Google */
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(staleWhileRevalidate(req, RUNTIME));
    return;
  }
  /* Selain itu (Firestore, Auth, API lain) → TIDAK di-cache, langsung ke internet */
});

/* Klik notifikasi alarm → buka / fokuskan app */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('./index.html');
    })
  );
});
