// Netlify Function: menerima webhook Scalev -> mengaktifkan member di Firestore
// Env vars (Netlify > Site settings > Environment variables):
//   SCALEV_WEBHOOK_SIGNING_SECRET = Signing Secret dari Scalev
//   FIREBASE_SERVICE_ACCOUNT      = isi file JSON service account (1 baris)
const crypto = require("node:crypto");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

function validSignature(rawBody, signature) {
  const secret = process.env.SCALEV_WEBHOOK_SIGNING_SECRET;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signature, "base64");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

const clean = (e) => (e || "").trim().toLowerCase();

async function setMember(email, active, orderId) {
  if (!email) return;
  const update = { active, orderId: orderId || null, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (active) update.since = admin.firestore.FieldValue.serverTimestamp();
  await db.collection("members").doc(email).set(update, { merge: true });

  if (active) {
    // Buat akun Auth (tanpa password). Member nanti klik "Atur password" / login Google.
    try {
      await admin.auth().getUserByEmail(email);
    } catch (err) {
      if (err.code === "auth/user-not-found") await admin.auth().createUser({ email });
      else throw err;
    }
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, "base64")
    : Buffer.from(event.body || "", "utf8");

  if (!validSignature(rawBody, event.headers["x-scalev-hmac-sha256"])) {
    return { statusCode: 401, body: "Invalid signature" };
  }

  const { event: name, data } = JSON.parse(rawBody.toString("utf8"));
  const orderId = data && data.order_id;

  try {
    if (name === "order.created") {
      // Simpan email pembeli supaya bisa dicocokkan saat pembayaran masuk
      const email = clean(data.destination_address && data.destination_address.email);
      if (orderId && email) await db.collection("orders").doc(orderId).set({ email }, { merge: true });
    }

    if (name === "payment.received") {
      // payment_status = paid / settled
      let email = clean(data.customer && data.customer.email);
      if (!email && orderId) {
        const snap = await db.collection("orders").doc(orderId).get();
        email = snap.exists ? snap.data().email : "";
      }
      await setMember(email, true, orderId);
    }

    if (name === "order.status_changed" && data.status === "canceled" && orderId) {
      const snap = await db.collection("orders").doc(orderId).get();
      if (snap.exists) await setMember(snap.data().email, false, orderId);
    }
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "Error" }; // Scalev akan mencoba kirim ulang
  }

  return { statusCode: 200, body: "ok" };
};
