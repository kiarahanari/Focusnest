/**
 * FocusNest — webhook Scalev -> Firestore members/{email}   (versi Cloudflare Pages Functions)
 *
 * Taruh file ini di: <root project>/function/api/scalev-webhook.js
 * Endpoint jadi:      https://domainkamu.com/api/scalev-webhook
 *
 * Environment variables (Cloudflare Pages > Settings > Variables and Secrets, tipe Secret):
 *   SCALEV_WEBHOOK_SIGNING_SECRET  = signing secret dari dashboard Scalev
 *   FIREBASE_SERVICE_ACCOUNT       = isi lengkap file JSON service account
 *   ACCESS_DAYS                    = (opsional) masa akses dalam hari. Kosong = selamanya
 *
 * Tidak pakai firebase-admin (tidak jalan di Workers). Kita pakai Firestore REST API
 * + Web Crypto bawaan Cloudflare.
 */

const enc = new TextEncoder();

/* ---------- helper base64 ---------- */
const b64urlFromBytes = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlFromStr = (s) => b64urlFromBytes(enc.encode(s));
const bytesFromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/* ---------- 1. verifikasi signature Scalev (header X-Scalev-Hmac-Sha256, base64 HMAC-SHA256 atas raw body) ---------- */
async function validSignature(rawText, signature, secret) {
  if (!secret || !signature) return false;
  try {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, bytesFromB64(signature), enc.encode(rawText)); // constant-time
  } catch { return false; }
}

/* ---------- 2. access token Google dari service account (JWT RS256) ---------- */
let cached = { token: '', exp: 0 };
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.exp - 60 > now) return cached.token;

  const header = b64urlFromStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlFromStr(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const key = await crypto.subtle.importKey(
    'pkcs8', bytesFromB64(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(header + '.' + claims));
  const jwt = header + '.' + claims + '.' + b64urlFromBytes(sig);

  const r = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt,
  });
  if (!r.ok) throw new Error('Gagal ambil access token: ' + r.status + ' ' + (await r.text()));
  const j = await r.json();
  cached = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return cached.token;
}

/* ---------- 3. helper Firestore REST ---------- */
const fsBase = (pid) => `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;
const fsNum = (f) => {                       // baca angka dari field Firestore (integer / double / timestamp)
  if (!f) return 0;
  if (f.integerValue !== undefined) return Number(f.integerValue);
  if (f.doubleValue !== undefined) return Number(f.doubleValue);
  if (f.timestampValue) return Date.parse(f.timestampValue);
  return 0;
};

/* ---------- 4. pencarian email & status di payload ----------
 * PENTING: cek nama field persis di payload Scalev (docs.scalev.com -> Webhook Events / Order),
 * atau lihat log request pertama. Sesuaikan dua fungsi ini kalau beda. */
function pickEmail(d) {
  const c = [d?.customer_email, d?.email, d?.customer?.email, d?.buyer_email, d?.buyer?.email]
    .find((x) => typeof x === 'string' && x.includes('@'));
  return c ? c.trim().toLowerCase() : '';
}
const pickPaymentStatus = (d) => String(d?.payment_status ?? d?.payment?.status ?? d?.status ?? '').toLowerCase();

const PAID = ['paid', 'settled'];
const REVOKE = ['refunded', 'cancelled', 'canceled', 'expired', 'failed']; // sesuaikan dgn status Scalev

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

/* ---------- handler utama ---------- */
export async function onRequestPost({ request, env }) {
  const raw = await request.text(); // RAW body: jangan di-parse dulu sebelum signature dicek
  const ok = await validSignature(raw, request.headers.get('X-Scalev-Hmac-Sha256'), env.SCALEV_WEBHOOK_SIGNING_SECRET);
  if (!ok) return json({ error: 'invalid signature' }, 401);

  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  const { event, unique_id: eventId, data } = body;

  if (event !== 'payment.received' && event !== 'order.payment_status_changed') {
    return json({ ok: true, ignored: event });
  }

  const email = pickEmail(data);
  const status = event === 'payment.received' ? 'paid' : pickPaymentStatus(data);
  const orderId = String(data?.order_id || data?.id || '');
  if (!email) {
    console.error('Email tidak ditemukan di payload. Cek nama field:', raw.slice(0, 2000));
    return json({ ok: false, reason: 'no email' }); // 200 supaya Scalev tidak retry terus
  }
  if (!PAID.includes(status) && !REVOKE.includes(status)) return json({ ok: true, ignored: status });

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const pid = sa.project_id;
  const base = fsBase(pid);
  let markerCreated = false;

  try {
    const token = await getAccessToken(sa);
    const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

    // Idempotent: Scalev kirim "at least once". Buat dokumen penanda; kalau sudah ada (409) = duplikat.
    if (eventId) {
      const mk = await fetch(`${base}/webhook_events?documentId=${encodeURIComponent(eventId)}`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ fields: { event: { stringValue: String(event) }, at: { integerValue: String(Date.now()) } } }),
      });
      if (mk.status === 409) return json({ ok: true, duplicate: true });
      if (!mk.ok) throw new Error('Gagal buat penanda event: ' + mk.status + ' ' + (await mk.text()));
      markerCreated = true;
    }

    const now = Date.now();
    const docName = `projects/${pid}/databases/(default)/documents/members/${email}`;
    let write;

    if (PAID.includes(status)) {
      // baca data lama (untuk firstActiveAt & perpanjangan expiresAt)
      const g = await fetch(`${base}/members/${encodeURIComponent(email)}`, { headers: auth });
      const old = g.ok ? (await g.json()).fields || {} : {};
      const days = Number(env.ACCESS_DAYS || 0);

      const fields = {
        active: { booleanValue: true },
        activeAt: { integerValue: String(now) },
        orderId: { stringValue: orderId },
      };
      if (!old.firstActiveAt) fields.firstActiveAt = { integerValue: String(now) };
      if (!old.addedAt) fields.addedAt = { integerValue: String(now) };
      if (days > 0) {
        const from = Math.max(now, fsNum(old.expiresAt)); // perpanjangan: tambah dari sisa masa aktif
        fields.expiresAt = { integerValue: String(from + days * 86400000) };
      }
      write = {
        update: { name: docName, fields },
        updateMask: { fieldPaths: Object.keys(fields) },
        updateTransforms: [{
          fieldPath: 'hist',
          appendMissingElements: { values: [{ mapValue: { fields: {
            t: { stringValue: 'on' }, ts: { integerValue: String(now) },
            src: { stringValue: 'scalev' }, order: { stringValue: orderId },
          } } }] },
        }],
      };
    } else {
      const fields = { active: { booleanValue: false }, inactiveAt: { integerValue: String(now) } };
      write = {
        update: { name: docName, fields },
        updateMask: { fieldPaths: Object.keys(fields) },
        updateTransforms: [{
          fieldPath: 'hist',
          appendMissingElements: { values: [{ mapValue: { fields: {
            t: { stringValue: 'off' }, ts: { integerValue: String(now) },
            src: { stringValue: 'scalev' }, status: { stringValue: status },
          } } }] },
        }],
      };
    }

    const c = await fetch(`${base}:commit`, { method: 'POST', headers: auth, body: JSON.stringify({ writes: [write] }) });
    if (!c.ok) throw new Error('Gagal tulis member: ' + c.status + ' ' + (await c.text()));

    return json({ ok: true, [PAID.includes(status) ? 'activated' : 'deactivated']: email });
  } catch (e) {
    console.error(e);
    // hapus penanda supaya retry dari Scalev bisa diproses lagi
    if (markerCreated) {
      try {
        const t = await getAccessToken(sa);
        await fetch(`${base}/webhook_events/${encodeURIComponent(eventId)}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } });
      } catch {}
    }
    return json({ error: 'server error' }, 500);
  }
}

// Biar kalau dibuka lewat browser (GET) tidak error membingungkan
export async function onRequestGet() {
  return new Response('Scalev webhook endpoint. Gunakan POST.', { status: 405 });
}
