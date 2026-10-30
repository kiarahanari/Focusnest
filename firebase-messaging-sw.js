/* FocusNest — firebase-messaging-sw.js (v20, gabungan 2 file jadi 1)
   Taruh di folder yang SAMA dengan index.html (root situs), nama file tetap firebase-messaging-sw.js.
   Hapus file firebase-messaging-sw_1.js — tidak dipakai lagi.

   Yang dilakukan file ini:
   1. Menerima push FCM (payload data-only ATAU berisi notification) dan menampilkannya walau app DITUTUP.
   2. Meniru alarm: notifikasi dibunyikan ulang beberapa kali (bunyi sistem + getar panjang) sampai
      diketuk / digeser / tombol "Matikan" ditekan.
   3. Saat notifikasi diketuk: membuka FocusNest dan membunyikan alarm berulang di dalam app
      (app sudah punya penerima pesan 'fn-ring' dan parameter ?ring=1).

   Catatan: file ini sengaja TIDAK memuat library Firebase. Token FCM dibuat oleh app (index.html)
   dan penerimaan push cukup lewat event 'push' bawaan browser. Jadi tidak ada config/API key di sini,
   dan tidak akan muncul notifikasi dobel. */

const SW_VER = 'v20';
const RING = { repeat: 6, gapSec: 10 };            // 6 kali bunyi, jeda 10 detik (± 1 menit). Bisa ditimpa lewat data.rep / data.gap dari server.
const VIBRATE = [500, 200, 500, 200, 500, 200, 800];
const BASE = new URL('./', self.location).href;    // alamat root FocusNest

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = (v, d, lo, hi) => { v = parseInt(v, 10); return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };

/* Baca payload push: mendukung {notification:{title,body}, data:{...}} maupun data-only. */
function parsePush(e) {
  let p = {};
  try { p = e.data ? e.data.json() : {}; }
  catch (x) { try { p = { data: { body: e.data.text() } }; } catch (y) {} }
  const n = p.notification || {}, d = p.data || {};
  return {
    title: n.title || d.title || '⏰ FocusNest',
    body: n.body || d.body || '',
    tag: d.tag || n.tag || 'focusnest',            // tag sama dengan pengingat di dalam app → saling menggantikan, bukan dobel
    rep: num(d.rep, RING.repeat, 1, 20),
    gap: num(d.gap, RING.gapSec, 5, 60)
  };
}

function notifOpts(m) {
  return {
    body: m.body,
    tag: m.tag,
    renotify: true,                                 // tag sama + renotify = bunyi & getar lagi
    requireInteraction: true,                       // tetap tampil sampai disentuh (desktop)
    silent: false,
    vibrate: VIBRATE,
    icon: 'icon-aesthetic-192.png',
    badge: 'icon-aesthetic-192.png',
    actions: [{ action: 'open', title: 'Buka' }, { action: 'stop', title: 'Matikan' }],
    data: { title: m.title, body: m.body }
  };
}

self.addEventListener('push', e => {
  const m = parsePush(e);
  e.waitUntil((async () => {
    const cl = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    /* App sedang terbuka & fokus → pengingat di dalam app yang tampil (tidak dobel). */
    if (cl.some(c => c.visibilityState === 'visible' && c.focused)) return;

    /* App terbuka tapi di tab/jendela belakang → minta app membunyikan alarm juga. */
    cl.forEach(c => { try { c.postMessage({ type: 'fn-ring', title: m.title, body: m.body }); } catch (x) {} });

    /* Bunyi pertama, lalu ulangi selama notifikasi masih ada (belum diketuk / digeser / dimatikan). */
    const o = notifOpts(m);
    await self.registration.showNotification(m.title, o);
    for (let i = 1; i < m.rep; i++) {
      await sleep(m.gap * 1000);
      const open = await self.registration.getNotifications({ tag: m.tag });
      if (!open.length) break;
      await self.registration.showNotification(m.title, o);
    }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();                           // menutup notifikasi = menghentikan bunyi ulang di atas
  if (e.action === 'stop') return;
  const dt = e.notification.data || {};
  e.waitUntil((async () => {
    const cl = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = cl.filter(c => c.url.startsWith(BASE));
    const target = mine.find(c => c.visibilityState === 'visible') || mine[0];
    if (target) {
      try { target.postMessage({ type: 'fn-ring', title: dt.title, body: dt.body }); return await target.focus(); } catch (x) {}
    }
    return self.clients.openWindow(BASE + '?ring=1&title=' + encodeURIComponent(dt.title || '') + '&body=' + encodeURIComponent(dt.body || ''));
  })());
});
