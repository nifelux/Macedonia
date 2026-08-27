/**
 * TargetGrowths IPN/webhook.
 * Register: https://YOUR_DOMAIN/api/webhooks/targetgrowths
 *
 * The provider secret is never exposed to the browser. It is read from
 * TARGETGROWTHS_SECRET_KEY by lib/targetgrowths.js.
 */

const { createClient } = require("@supabase/supabase-js");
const {
  getCredentials,
  parseWebhookBody,
  verifyPayment,
  webhookIdentifier,
  webhookTransactionReference,
  webhookAmount,
  webhookStatus,
  webhookType,
  isSuccessfulStatus,
  isFailedStatus,
  webhookSignatureCheck,
} = require("../../lib/targetgrowths");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function rawBody(req) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(req.body)) return resolve(req.body);
    if (typeof req.body === "string") return resolve(Buffer.from(req.body));
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function closeEnough(a, b) {
  return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) < 0.01;
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") return res.json({ ok: true, service: "TargetGrowths webhook" });
  if (req.method !== "POST") return res.status(405).end();

  let body;
  try { body = await rawBody(req); } catch (e) { return res.status(400).json({ error: "Could not read webhook body" }); }
  const payload = parseWebhookBody(body);
  console.log("[TG-WEBHOOK-RAW]", JSON.stringify(payload));
  if (!payload || Object.keys(payload).length === 0) return res.status(400).json({ error: "Empty webhook payload" });

  try { getCredentials(); } catch (e) {
    console.error("[targetgrowths-webhook] credentials are not configured");
    return res.status(500).json({ error: "Webhook is not configured" });
  }

  const signatureCheck = webhookSignatureCheck(payload);
  console.log("[TG-SIGNATURE-CHECK]", JSON.stringify({
    amount_raw: signatureCheck.amountRaw,
    identifier: signatureCheck.identifier,
    matched_amount: signatureCheck.matched,
    enforced_for_deposits: false,
  }));

  const identifier = webhookIdentifier(payload);
  const providerReference = webhookTransactionReference(payload);
  const amount = webhookAmount(payload);
  const status = webhookStatus(payload);
  const type = webhookType(payload);
  if (!identifier) return res.status(400).json({ error: "Missing identifier" });

  // Payout callbacks remain protected by the inbound signature because the
  // payment verification endpoint is for collections, not bank transfers.
  if (type === "payout" || type === "transfer") {
    if (!signatureCheck.valid) {
      console.warn("[targetgrowths-webhook] invalid payout signature");
      return res.status(401).json({ error: "Invalid signature" });
    }
    if (amount === null || !status) return res.status(400).json({ error: "Missing payout amount or status" });
    if (!isSuccessfulStatus(status) && !isFailedStatus(status)) {
      return res.json({ ok: true, skipped: true, status });
    }

    const { data: withdrawal, error } = await supabase.from("withdrawals")
      .select("id,amount,net_amount,status,provider_identifier")
      .eq("provider_identifier", identifier).single();
    if (error || !withdrawal) return res.status(404).json({ error: "Withdrawal not found" });

    const expectedAmount = withdrawal.net_amount ?? withdrawal.amount;
    if (!closeEnough(amount, expectedAmount)) return res.status(400).json({ error: "Payout amount mismatch" });

    const { data, error: rpcError } = await supabase.rpc("finalize_targetgrowths_withdrawal", {
      p_withdrawal_id: withdrawal.id,
      p_success: isSuccessfulStatus(status),
      p_provider_reference: providerReference,
      p_provider_status: status,
      p_payload: payload,
    });
    if (rpcError) {
      console.error("[targetgrowths-webhook] withdrawal finalize error:", rpcError.message);
      return res.status(500).json({ error: rpcError.message });
    }
    return res.json({ ok: true, data });
  }

  const { data: deposit, error } = await supabase.from("deposits")
    .select("id,reference,amount,status,provider_identifier,provider_reference")
    .eq("provider_identifier", identifier).single();
  if (error || !deposit) return res.status(404).json({ error: "Deposit not found" });
  if (deposit.status === "completed") return res.json({ ok: true, action: "already_credited" });

  // For deposits, the webhook is only a trigger. The authenticated verification
  // endpoint is the settlement authority because the provider signature format
  // may differ from the documented amount+identifier formula.
  let verification;
  try {
    verification = await verifyPayment(deposit.provider_identifier);
  } catch (error) {
    console.warn("[targetgrowths-webhook] verification unavailable:", error.message);
    return res.status(503).json({ error: "Payment verification temporarily unavailable" });
  }

  if (verification?.error === true || String(verification?.status || "").toLowerCase() === "error") {
    console.warn("[targetgrowths-webhook] provider verification returned an error", verification?.message || "");
    return res.status(503).json({ error: "TargetGrowths could not verify this payment" });
  }

  const verifiedData = verification?.data && typeof verification.data === "object" ? verification.data : {};
  const verifiedIdentifier = String(verifiedData.identifier || verification?.identifier || "").trim();
  const verifiedStatus = String(verifiedData.payment_status || verifiedData.status || "").trim().toLowerCase();
  const verifiedAmount = Number(verifiedData.amount ?? verifiedData.payment_amount);
  const verifiedReference = verifiedData.transaction_ref || verifiedData.ref_trx || providerReference || deposit.provider_reference || null;
  const storedVerification = { webhook: payload, verification };
  console.log("[TG-WEBHOOK-VERIFIED]", JSON.stringify({
    deposit_reference: deposit.reference,
    identifier: verifiedIdentifier,
    status: verifiedStatus,
    amount: verifiedData.amount,
    provider_reference: verifiedReference,
  }));

  if (verifiedIdentifier !== String(deposit.provider_identifier).trim()) {
    await supabase.from("deposits").update({
      provider_status: "identifier_mismatch",
      provider_reference: verifiedReference,
      provider_response: storedVerification,
      updated_at: new Date().toISOString(),
    }).eq("id", deposit.id).eq("status", "pending");
    return res.status(400).json({ error: "Verified payment identifier mismatch" });
  }

  if (isFailedStatus(verifiedStatus)) {
    await supabase.from("deposits").update({
      status: "rejected",
      provider_status: verifiedStatus,
      provider_reference: verifiedReference,
      provider_response: storedVerification,
      updated_at: new Date().toISOString(),
    }).eq("id", deposit.id).neq("status", "completed");
    return res.json({ ok: true, action: "rejected", status: verifiedStatus });
  }

  if (!isSuccessfulStatus(verifiedStatus)) {
    await supabase.from("deposits").update({
      provider_status: verifiedStatus || "pending",
      provider_reference: verifiedReference,
      provider_response: storedVerification,
      updated_at: new Date().toISOString(),
    }).eq("id", deposit.id).eq("status", "pending");
    return res.json({ ok: true, action: "pending", status: verifiedStatus || "pending" });
  }

  if (!Number.isFinite(verifiedAmount) || !closeEnough(verifiedAmount, deposit.amount)) {
    await supabase.from("deposits").update({
      provider_status: "amount_mismatch",
      provider_reference: verifiedReference,
      provider_response: storedVerification,
      provider_error: "Verified amount does not match the requested deposit amount",
      updated_at: new Date().toISOString(),
    }).eq("id", deposit.id).eq("status", "pending");
    return res.status(400).json({ error: "Verified payment amount mismatch" });
  }

  const { data, error: rpcError } = await supabase.rpc("process_deposit", {
    p_reference: deposit.reference,
    p_amount: Number(deposit.amount),
    p_payload: storedVerification,
  });
  if (rpcError) {
    console.error("[targetgrowths-webhook] deposit processing error:", rpcError.message);
    return res.status(500).json({ error: rpcError.message });
  }
  if (data && data.success === false) {
    console.error("[targetgrowths-webhook] deposit settlement rejected:", data.message || data);
    return res.status(400).json({ error: data.message || "Deposit settlement was rejected" });
  }
  await supabase.from("deposits").update({
    provider_status: verifiedStatus,
    provider_reference: verifiedReference,
    provider_response: storedVerification,
    updated_at: new Date().toISOString(),
  }).eq("id", deposit.id);
  return res.json({ ok: true, action: "auto_credited", status: verifiedStatus, data });
};

module.exports.config = { api: { bodyParser: false } };
