/*
 * /api/deposit.js — Manual + Monnify + TargetGrowths
 *
 * TargetGrowths keys are read only on the server from:
 *   TARGETGROWTHS_PUBLIC_KEY
 *   TARGETGROWTHS_SECRET_KEY
 */

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const {
  initiatePayment,
  verifyPayment,
} = require("../lib/targetgrowths");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const MONNIFY_BASE = process.env.MONNIFY_BASE_URL || "https://api.monnify.com";

function genNarration(uid) {
  return `ARD${uid.replace(/-/g, "").slice(0, 5).toUpperCase()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function genRef(prefix, uid) {
  // TargetGrowths documents a maximum identifier length of 20 characters.
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(2).toString("hex").toUpperCase();
  const roomForUser = Math.max(1, 20 - prefix.length - timestamp.length - random.length);
  const userPart = uid.replace(/-/g, "").slice(0, roomForUser).toUpperCase();
  return `${prefix}${userPart}${timestamp}${random}`.slice(0, 20);
}

function appUrl(req) {
  const configured = String(process.env.APP_URL || "").trim();
  if (configured) return configured.replace(/\/$/, "");
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  return `${forwardedProto}://${forwardedHost}`.replace(/\/$/, "");
}

function checkoutUrl(data) {
  return data?.url || data?.checkout_url || data?.payment_url || data?.redirect_url ||
    data?.data?.url || data?.data?.checkout_url || data?.data?.payment_url || data?.data?.redirect_url;
}

function providerReference(data) {
  return data?.transaction_ref || data?.transactionReference || data?.trx_id || data?.transaction_id || data?.ref_trx ||
    data?.data?.transaction_ref || data?.data?.transactionReference || data?.data?.trx_id || data?.data?.transaction_id || data?.data?.ref_trx || null;
}

function normalizedProviderStatus(data) {
  // TargetGrowths uses top-level status="success" for a successful lookup.
  // The actual payment state is nested under data.payment_status.
  return String(data?.data?.payment_status || data?.data?.status || data?.payment_status || "").trim().toLowerCase();
}

function providerIdentifierMatches(data, expected) {
  const actual = data?.data?.identifier || data?.identifier;
  return Boolean(actual) && String(actual).trim() === String(expected || "").trim();
}

function isProviderSuccess(status) {
  return ["success", "successful", "completed", "complete", "paid", "approved"].includes(status);
}

function isProviderFailure(status) {
  return ["failed", "failure", "rejected", "reject", "cancelled", "canceled", "declined"].includes(status);
}

function isPotentialMerchantIdentifier(value) {
  const id = String(value || "").trim();
  return id.length > 0 && id.length <= 20 && /^[A-Za-z0-9_-]+$/.test(id);
}

async function verifyWithCandidates(candidates) {
  const ids = [...new Set((candidates || []).map(value => String(value || "").trim()).filter(Boolean))];
  if (!ids.length) throw new Error("No TargetGrowths payment identifier is available");

  let lastError = null;
  for (const id of ids) {
    try {
      const data = await verifyPayment(id);
      const message = String(data?.message || "").toLowerCase();
      const status = String(data?.status || data?.data?.payment_status || data?.data?.status || "").toLowerCase();
      if (data?.error === true || status === "error" || message.includes("no payment transaction") || message.includes("not found")) {
        lastError = new Error(data?.message || "TargetGrowths payment transaction was not found");
        continue;
      }
      return { id, data };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("TargetGrowths payment verification failed");
}

async function reconcileTargetGrowthsDeposit(deposit) {
  if (!deposit || deposit.method !== "targetgrowths" || deposit.status === "completed") return null;
  const lastUpdate = Date.parse(deposit.updated_at || deposit.created_at || "");
  if (Number.isFinite(lastUpdate) && Date.now() - lastUpdate < 15000) return null;

  const verificationCandidates = [
    deposit.provider_identifier,
    isPotentialMerchantIdentifier(deposit.provider_reference) ? deposit.provider_reference : null,
  ];
  if (!verificationCandidates.some(value => String(value || "").trim())) return null;

  let verificationResult;
  try {
    verificationResult = await verifyWithCandidates(verificationCandidates);
  } catch (error) {
    console.warn("[targetgrowths-status] verification unavailable:", error.message);
    return null;
  }

  const verification = verificationResult.data;
  const status = normalizedProviderStatus(verification);
  const data = verification?.data || {};
  const verifiedAmount = Number(data.amount ?? data.payment_amount ?? verification?.amount);
  const providerRef = providerReference(verification) || deposit.provider_reference || verificationResult.id;

  if (!providerIdentifierMatches(verification, deposit.provider_identifier)) {
    console.warn("[targetgrowths-status] verification identifier mismatch", { deposit: deposit.reference });
    await supabase.from("deposits").update({
      provider_status: "identifier_mismatch",
      provider_reference: providerRef,
      provider_response: verification,
      updated_at: new Date().toISOString(),
    }).eq("id", deposit.id).eq("status", "pending");
    return { status: "pending" };
  }

  if (isProviderFailure(status)) {
    await supabase.from("deposits").update({
      status: "rejected",
      provider_status: status,
      provider_reference: providerRef,
      provider_response: verification,
      updated_at: new Date().toISOString(),
    }).eq("id", deposit.id).neq("status", "completed");
    return { status: "rejected" };
  }

  if (!isProviderSuccess(status)) {
    await supabase.from("deposits").update({
      provider_status: status || "pending",
      provider_reference: providerRef,
      provider_response: verification,
      updated_at: new Date().toISOString(),
    }).eq("id", deposit.id).eq("status", "pending");
    return { status: status || "pending" };
  }
  if (!Number.isFinite(verifiedAmount) || Math.abs(verifiedAmount - Number(deposit.amount)) >= 0.01) {
    console.error("[targetgrowths-status] amount mismatch", { deposit: deposit.amount, verifiedAmount, reference: deposit.reference });
    await supabase.from("deposits").update({
      provider_status: "amount_mismatch",
      provider_reference: providerRef,
      provider_response: verification,
      provider_error: "Verified amount does not match the requested deposit amount",
      updated_at: new Date().toISOString(),
    }).eq("id", deposit.id);
    return { status: "pending" };
  }

  const { error: rpcError } = await supabase.rpc("process_deposit", {
    p_reference: deposit.reference,
    p_amount: Number(deposit.amount),
    p_payload: { source: "targetgrowths_verify", verification },
  });
  if (rpcError) {
    console.error("[targetgrowths-status] deposit processing error:", rpcError.message);
    return null;
  }

  await supabase.from("deposits").update({
    provider_status: "completed",
    provider_reference: providerRef,
    provider_response: verification,
    updated_at: new Date().toISOString(),
  }).eq("id", deposit.id);
  return { status: "completed" };
}

async function getManualBankDetails() {
  const { data } = await supabase.from("site_settings").select("key,value")
    .in("key", ["deposit_bank_name", "deposit_account_number", "deposit_account_name"]);
  const map = {}; (data || []).forEach(r => { map[r.key] = r.value; });
  return {
    bank_name: map.deposit_bank_name || "OPay",
    account_number: map.deposit_account_number || "6416919879",
    account_name: map.deposit_account_name || "UFUMWEN DESTINY IKPONMWOSA",
  };
}

async function getMonnifyToken() {
  const auth = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString("base64");
  const res = await fetch(`${MONNIFY_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
  });
  const data = await res.json();
  if (!data?.responseBody?.accessToken) throw new Error("Could not authenticate with Monnify");
  return data.responseBody.accessToken;
}

async function createMonnifyReservedAccount(userId, email, name) {
  const token = await getMonnifyToken();
  const accountRef = `ARD-${userId}`;
  const res = await fetch(`${MONNIFY_BASE}/api/v2/bank-transfer/reserved-accounts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      accountReference: accountRef,
      accountName: name || "Macedonia User",
      currencyCode: "NGN",
      contractCode: process.env.MONNIFY_CONTRACT_CODE,
      customerEmail: email,
      customerName: name || "Macedonia User",
      getAllAvailableBanks: false,
    }),
  });
  const data = await res.json();
  if (!data?.responseBody) throw new Error(data?.responseMessage || "Monnify rejected the account creation request");
  const acct = data.responseBody.accounts?.[0];
  if (!acct) throw new Error("Monnify did not return an account");
  return {
    account_reference: accountRef,
    account_number: acct.accountNumber,
    bank_name: acct.bankName,
    bank_code: acct.bankCode,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action } = req.query;

  if (req.method === "GET" && action === "method") {
    const { data } = await supabase.from("site_settings").select("value").eq("key", "deposit_method").single();
    return res.json({ ok: true, method: data?.value || "manual" });
  }

  if (req.method === "GET" && action === "status") {
    const { ref, user_id } = req.query;
    if (!ref) return res.status(400).json({ error: "ref required" });
    const { data, error } = await supabase.from("deposits")
      .select("id,user_id,reference,status,amount,paid_at,method,provider_identifier,provider_reference,provider_status,provider_response,updated_at,created_at")
      .eq("reference", ref).single();
    if (error || !data) return res.status(404).json({ error: "not found" });
    if (user_id && String(data.user_id) !== String(user_id)) return res.status(404).json({ error: "not found" });
    if (data.method === "targetgrowths" && data.status === "completed" && !["completed","success","successful","paid","settled","approved"].includes(String(data.provider_status || "").toLowerCase())) {
      return res.json({ ok: true, status: "pending", amount: data.amount, method: data.method, provider_status: data.provider_status || "unverified" });
    }
    if (data.method === "targetgrowths" && data.status === "pending") {
      await reconcileTargetGrowthsDeposit(data);
      const { data: refreshed } = await supabase.from("deposits")
        .select("status,amount,paid_at,method,provider_status,provider_reference")
        .eq("id", data.id).single();
      return res.json({ ok: true, ...(refreshed || data) });
    }
    return res.json({ ok: true, ...data });
  }

  if (req.method === "GET" && action === "monnify-account") {
    const { user_id, email, name } = req.query;
    if (!user_id) return res.status(400).json({ error: "user_id required" });
    const { data: profile } = await supabase.from("profiles")
      .select("monnify_account_number,monnify_bank_name,monnify_account_ref")
      .eq("id", user_id).single();

    if (profile?.monnify_account_number) {
      return res.json({ ok: true, account_number: profile.monnify_account_number, bank_name: profile.monnify_bank_name, account_name: name || "Macedonia User" });
    }

    try {
      const acct = await createMonnifyReservedAccount(user_id, email, name);
      await supabase.from("profiles").update({
        monnify_account_number: acct.account_number,
        monnify_bank_name: acct.bank_name,
        monnify_bank_code: acct.bank_code,
        monnify_account_ref: acct.account_reference,
        updated_at: new Date().toISOString(),
      }).eq("id", user_id);
      return res.json({ ok: true, account_number: acct.account_number, bank_name: acct.bank_name, account_name: name || "Macedonia User" });
    } catch (e) {
      console.error("[monnify-account]", e);
      return res.status(500).json({ error: e.message || "Could not create your Monnify account. Try again." });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { user_id, amount, sender_name } = req.body || {};

  if (action === "initiate-targetgrowths") {
    if (!user_id || !amount) return res.status(400).json({ error: "user_id and amount required" });
    const num = Number(amount);
    if (!Number.isFinite(num) || num < 600) return res.status(400).json({ error: "Minimum TargetGrowths deposit is ₦600" });

    const { data: profile } = await supabase.from("profiles").select("full_name,email").eq("id", user_id).single();
    const email = profile?.email || req.body.email;
    if (!email) return res.status(400).json({ error: "A customer email is required" });

    const reference = genRef("TGP", user_id);
    const identifier = reference;
    const origin = appUrl(req);
    const { error: insertError } = await supabase.from("deposits").insert({
      user_id,
      amount: num,
      reference,
      status: "pending",
      method: "targetgrowths",
      provider: "targetgrowths",
      provider_identifier: identifier,
      provider_status: "initiated",
      created_at: new Date().toISOString(),
    });
    if (insertError) return res.status(500).json({ error: insertError.message });

    try {
      const ipnUrl = `${origin}/api/webhooks/targetgrowths`;
      console.log("[TG-INITIATE-IPN]", JSON.stringify({ identifier, ipn_url: ipnUrl, amount: num }));
      const provider = await initiatePayment({
        identifier,
        amount: num,
        details: `Wallet deposit for ${profile?.full_name || email}`,
        ipnUrl,
        successUrl: `${origin}/targetgrowths-checkout.html?ref=${encodeURIComponent(reference)}&result=success`,
        cancelUrl: `${origin}/targetgrowths-checkout.html?ref=${encodeURIComponent(reference)}&result=cancelled`,
        siteLogo: origin,
        customerName: profile?.full_name || email,
        customerEmail: email,
      });
      console.log("[TG-INITIATE-RAW]", JSON.stringify(provider));
      const url = checkoutUrl(provider);
      if (!url) throw new Error("TargetGrowths did not return a checkout URL");
      await supabase.from("deposits").update({
        provider_response: provider,
        provider_reference: providerReference(provider),
        provider_status: "checkout_created",
        updated_at: new Date().toISOString(),
      }).eq("reference", reference);
      return res.json({ ok: true, reference, identifier, checkout_url: url });
    } catch (e) {
      console.error("[targetgrowths-initiate-payment]", e);
      await supabase.from("deposits").update({
        status: e.retryable ? "pending" : "rejected",
        provider_status: e.retryable ? "manual_review" : "initiation_failed",
        provider_error: e.message,
        updated_at: new Date().toISOString(),
      }).eq("reference", reference);
      return res.status(502).json({ error: e.retryable ? "TargetGrowths did not confirm checkout creation. Please try again after checking the payment status." : (e.message || "Could not start the payment") });
    }
  }

  if (action === "initiate-manual") {
    if (!user_id || !amount) return res.status(400).json({ error: "user_id and amount required" });
    if (!sender_name || !sender_name.trim()) return res.status(400).json({ error: "Sender name is required" });
    const num = Number(amount);
    if (!Number.isFinite(num) || num < 500) return res.status(400).json({ error: "Minimum deposit is ₦500" });
    const reference = genRef("MAN", user_id);
    const narration = genNarration(user_id);
    const { error } = await supabase.from("deposits").insert({
      user_id, amount: num, reference, narration, sender_name: sender_name.trim(),
      status: "pending", method: "manual", provider: "manual", created_at: new Date().toISOString(),
    });
    if (error) return res.status(500).json({ error: error.message });
    const bankDetails = await getManualBankDetails();
    return res.json({ ok: true, reference, narration, amount: num, ...bankDetails });
  }

  return res.status(400).json({ error: "Unknown action: " + action });
};
