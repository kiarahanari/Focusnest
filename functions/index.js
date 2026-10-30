/* FocusNest — pengirim pengingat terjadwal. Jalan tiap 1 menit, kirim push FCM ke semua perangkat akun.
   Data jadwal: pushQueue/{uid} = { items:[{tag,at,title,body}], next, tokens:{token:{ok}}, sent:{} } */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

const STALE_MS = 2 * 3600 * 1000;       // pengingat yang terlambat > 2 jam dibuang (tidak berguna lagi)
const BAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

async function isMember(uid) {
  try {
    const email = (((await admin.auth().getUser(uid)).email) || '').toLowerCase();
    if (!email) return false;
    const m = await db.doc('members/' + email).get();
    if (m.exists) {
      const d = m.data(), ex = d.expiresAt && d.expiresAt.toMillis ? d.expiresAt.toMillis() : (typeof d.expiresAt === 'number' ? d.expiresAt : 0);
      if (String(d.active) === 'true' && (!ex || ex > Date.now())) return true;
    }
    return (await db.doc('admins/' + email).get()).exists;   // admin selalu boleh
  } catch (e) { return false; }
}

exports.sendDueReminders = onSchedule(
  { schedule: 'every 1 minutes', region: 'asia-southeast1', timeZone: 'Asia/Jakarta', maxInstances: 1, timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const now = Date.now();
    const snap = await db.collection('pushQueue').where('next', '<=', now).limit(300).get();
    for (const doc of snap.docs) {
      try {
        const data = doc.data(), uid = doc.id;
        const items = Array.isArray(data.items) ? data.items : [];
        const sent = Object.assign({}, data.sent || {});
        const due = items.filter(i => i.at <= now && i.at > now - STALE_MS && !sent[i.tag + '@' + i.at]);
        const tokens = Object.entries(data.tokens || {}).filter(([, v]) => v && v.ok !== false).map(([t]) => t);
        const dead = [];
        if (due.length && tokens.length && await isMember(uid)) {
          for (const it of due) {
            const res = await admin.messaging().sendEachForMulticast({
              tokens,
              data: { title: String(it.title), body: String(it.body || ''), tag: String(it.tag), url: './' },
              webpush: { headers: { Urgency: 'high', TTL: '3600' } },
              android: { priority: 'high' }
            });
            res.responses.forEach((r, k) => { if (!r.success && r.error && BAD.has(r.error.code)) dead.push(tokens[k]); });
            sent[it.tag + '@' + it.at] = now;
          }
        } else due.forEach(it => { sent[it.tag + '@' + it.at] = now; });
        Object.keys(sent).forEach(k => { if (now - sent[k] > 3 * 864e5) delete sent[k]; });   // rapikan catatan lama

        /* tulis ulang lewat transaksi: baca versi terbaru dulu supaya perubahan jadwal dari app tidak tertimpa */
        await db.runTransaction(async tx => {
          const cur = (await tx.get(doc.ref)).data() || {};
          const left = (Array.isArray(cur.items) ? cur.items : []).filter(i => i.at > now);
          const keep = Object.assign({}, cur.sent || {}, sent); Object.keys(keep).forEach(k => { if (now - keep[k] > 3 * 864e5) delete keep[k]; });
          tx.update(doc.ref, { items: left, next: left.length ? Math.min(...left.map(i => i.at)) : null, sent: keep });
        });
        for (const t of dead) await doc.ref.update(new admin.firestore.FieldPath('tokens', t), admin.firestore.FieldValue.delete()).catch(() => {});
      } catch (e) { console.error('pushQueue', doc.id, e); }
    }
  }
);

