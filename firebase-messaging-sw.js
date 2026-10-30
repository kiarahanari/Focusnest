/* FocusNest — service worker push pengingat (FCM).
   Taruh di folder yang SAMA dengan index.html (root situs). Tidak mengganggu service-worker.js yang sudah ada
   karena memakai scope terpisah (firebase-cloud-messaging-push-scope). */
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCZfHDmg9acVtC6n6YjCyc1xATwkqdwPAA",
  authDomain: "focusnest-81ce2.firebaseapp.com",
  projectId: "focusnest-81ce2",
  storageBucket: "focusnest-81ce2.firebasestorage.app",
  messagingSenderId: "1034039846676",
  appId: "1:1034039846676:web:889990fee370f2cfaac401"
});
const messaging = firebase.messaging();

/* Pesan data-only: dipanggil saat tidak ada jendela FocusNest yang sedang terlihat.
   (Kalau app sedang terbuka & terlihat, pengingat di dalam app yang tampil — jadi tidak dobel.) */
messaging.onBackgroundMessage(payload => {
  const d = (payload && payload.data) || {};
  const title = d.title || '⏰ FocusNest';
  return self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || 'focusnest',          // tag sama dengan pengingat di dalam app → saling menggantikan, bukan dobel
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200],
    data: { url: d.url || './' }
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope.replace(/firebase-cloud-messaging-push-scope\/?$/, '')).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return clients.openWindow(target);
  }));
});
