/**
 * /api/webhooks/index.js — Monnify webhook
 *
 * Monnify sends a webhook to this URL whenever ANY transaction completes
 * on ANY user's reserved account. Since reserved accounts are permanent
 * (not tied to a single "deposit attempt"), this creates a NEW completed
 * deposits row directly for each transaction via process_monnify_deposit,
 * rather than matching against a pre-existing pending row.
 *
 * Signature verification: Monnify signs the raw JSON body with HMAC-SHA512
 * using your Secret Key, sent in the "monnify-signature" header.
 *
 * Register this URL in your Monnify dashboard: https://<domain>/api/webhooks
 */

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function rawBody(req) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(req.body)) return resolve(req.body);
    if (typeof req.body === "string") return resolve(Buffer.from(req.body));
    const chunks = [];
    req.on("data", d => chunks.push(d));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") return res.json({ ok: true, service: "Macedonia Webhook" });
  if (req.method !== "POST") return res.status(405).end();

  const body = await rawBody(req);
  if (!body || !body.length) return res.json({ ok: true });

  const signature = req.headers["monnify-signature"] || "";
  const secret = process.env.MONNIFY_SECRET_KEY || "";

  if (secret && signature) {
    const expected = crypto.createHmac("sha512", secret).update(body).digest("hex");
    if (expected !== signature) {
      console.warn("[webhook] Invalid Monnify signature");
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  let payload;
  try { payload = JSON.parse(body.toString("utf8")); }
  catch { return res.status(400).json({ error: "Invalid JSON" }); }

  const eventType = payload?.eventType;
  if (eventType !== "SUCCESSFUL_TRANSACTION") {
    return res.json({ ok: true, skipped: true, eventType });
  }

  const eventData = payload?.eventData || {};
  const accountRef = eventData?.product?.reference; // this is our "ARD-<userId>" reference
  const amountPaid = eventData?.amountPaid;
  const transactionRef = eventData?.transactionReference;

  if (!accountRef || !amountPaid || !transactionRef) {
    return res.status(400).json({ error: "Missing required fields in Monnify payload" });
  }

  // accountRef looks like "ARD-<uuid>" — strip prefix to get the user_id
  const userId = accountRef.startsWith("ARD-") ? accountRef.slice(4) : null;
  if (!userId) return res.status(400).json({ error: "Could not resolve user from accountReference" });

  console.log(`[webhook] Monnify: user=${userId} amount=₦${amountPaid} ref=${transactionRef}`);

  const { data, error } = await supabase.rpc("process_monnify_deposit", {
    p_user_id: userId,
    p_amount: Number(amountPaid),
    p_monnify_ref: transactionRef,
    p_payload: payload,
  });

  if (error) {
    console.error("[webhook] process_monnify_deposit error:", error.message);
    return res.status(500).json({ error: error.message });
  }
  if (!data?.ok) {
    return res.json({ ok: true, note: data?.error });
  }

  console.log(`[webhook] ✅ Monnify deposit credited: user=${userId} ₦${amountPaid}`);
  return res.json({ ok: true, data });
};

module.exports.config = { api: { bodyParser: false } };
      
