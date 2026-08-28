/**
 * /api/admin.js — All admin actions
 *
 * GET  ?action=deposits&status=&admin_id=
 * GET  ?action=withdrawals&status=
 * GET  ?action=users
 * GET  ?action=user-team&target_user_id=
 * GET  ?action=products
 * GET  ?action=messages
 * GET  ?action=gift-codes
 * GET  ?action=stats
 * GET  ?action=withdrawal-lock-status
 * GET  ?action=withdrawal-limits
 * GET  ?action=extra-settings
 * POST ?action=set-method              { method: manual|monnify }
 * POST ?action=set-withdrawal-lock      { locked }
 * POST ?action=set-withdrawal-limits    { min, max }
 * POST ?action=set-bank-details         { bank_name, account_number, account_name }
 * POST ?action=set-welcome-bonus        { enabled, amount }
 * POST ?action=set-invest-gate          { required }
 * POST ?action=set-referral-gate        { required }
 * POST ?action=set-vip-enabled          { enabled }
 * POST ?action=set-withdrawal-fee       { percent }
 * POST ?action=set-referral-settings    { levels, l1, l2, l3 }
 * POST ?action=set-contact-links        { telegram_support_url, telegram_community_url, whatsapp_url, customer_service_url }
 * POST ?action=adjust-wallet            { target_user_id, amount, type, reason }
 * POST ?action=process-deposit          { deposit_id, act }
 * POST ?action=process-withdrawal       { withdrawal_id, act, note }
 * POST ?action=send-message             { user_id, title, content }
 * POST ?action=update-message           { message_id, title, content }
 * POST ?action=delete-message           { message_id }
 * POST ?action=save-product             { id?, name, ... }
 * POST ?action=delete-product           { product_id }
 * POST ?action=toggle-product           { product_id, status }
 * POST ?action=set-admin                { target_user_id, is_admin }
 * POST ?action=ban-user                 { target_user_id }
 * POST ?action=unban-user               { target_user_id }
 * POST ?action=create-gift-code
 * POST ?action=toggle-gift-code
 * POST ?action=delete-gift-code
 */
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { initiateTransfer, verifyPayment, getWalletBalance } = require("../lib/targetgrowths");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SUPPORTED_BANK_CODES = new Set([
  "NGR801", "NGR044", "NGR50211", "NGR050", "NGR000019", "NGR070", "NGR011", "NGR214",
  "NGR00103", "NGR058", "NGR301", "NGR082", "NGR565", "NGR20009", "NGR999991", "NGR526",
  "NGR999992", "NGR076", "NGR101", "NGR51310", "NGR221", "NGR068", "NGR232", "NGR100",
  "NGR302", "NGR035A", "NGR032", "NGR033", "NGR215", "NGR566", "NGR035", "NGR057",
]);

const BANK_CODES = {
  access: "NGR044", "access bank": "NGR044", "access bank plc": "NGR044",
  gtbank: "NGR058", "gt bank": "NGR058", "guaranty trust bank": "NGR058", "gtco": "NGR058", "gtco bank": "NGR058",
  "first bank": "NGR011", "first bank of nigeria": "NGR011",
  wema: "NGR035", "wema bank": "NGR035",
  zenith: "NGR057", "zenith bank": "NGR057",
  uba: "NGR033", "united bank for africa": "NGR033",
  opay: "NGR20009", "opay digital services": "NGR20009",
  palmpay: "NGR999991", "palm pay": "NGR999991",
  "sterling bank": "NGR232", sterling: "NGR232",
  "fidelity bank": "NGR070", fidelity: "NGR070",
  "union bank": "NGR032", union: "NGR032", "union bank of nigeria": "NGR032",
  "stanbic ibtc": "NGR221", "stanbic ibtc bank": "NGR221",
  "polaris bank": "NGR076", polaris: "NGR076",
  "ecobank": "NGR050", "ecobank nigeria": "NGR050",
  "fcmb": "NGR214", "first city monument bank": "NGR214",
  "keystone bank": "NGR082", keystone: "NGR082",
  "unity bank": "NGR215", unity: "NGR215",
  "providus bank": "NGR101", providus: "NGR101",
};

function bankCodeFor(bankName, savedBankId) {
  const name = String(bankName || "").trim().toLowerCase().replace(/\s+/g, " ");
  const legacyCode = String(savedBankId || "").trim().toUpperCase();
  const mapped = BANK_CODES[name] || null;

  // Older versions stored NGR999 for both OPay and PalmPay. TargetGrowths
  // requires distinct active codes, so prefer the corrected name mapping.
  if (legacyCode === "NGR999" && mapped) return mapped;
  if (mapped) return mapped;
  if (SUPPORTED_BANK_CODES.has(legacyCode)) return legacyCode;
  return null;
}

function appUrl(req) {
  const configured = String(process.env.APP_URL || "").trim();
  if (configured) return configured.replace(/\/$/, "");
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  return `${forwardedProto}://${forwardedHost}`.replace(/\/$/, "");
}

function providerReference(data, fallback) {
  const tx = data?.data?.transaction || data?.data?.payment || data?.transaction || {};
  return data?.transaction_id || data?.transactionId || data?.reference || data?.trx_id ||
    data?.data?.transaction_id || data?.data?.reference || data?.data?.trx_id ||
    tx.transaction_id || tx.transactionId || tx.reference || tx.trx_id || fallback;
}

function providerPaymentStatus(data) {
  const tx = data?.data?.transaction || data?.data?.payment || data?.transaction || {};
  // TargetGrowths top-level status="success" means the lookup succeeded;
  // the actual payment state is data.payment_status.
  return String(data?.data?.payment_status || data?.data?.status || tx.payment_status || tx.status || data?.payment_status || "").trim().toLowerCase();
}

function providerIdentifierMatches(data, expected) {
  const actual = data?.data?.identifier || data?.identifier;
  return Boolean(actual) && String(actual).trim() === String(expected || "").trim();
}

function providerPaymentAmount(data) {
  const tx = data?.data?.transaction || data?.data?.payment || data?.transaction || {};
  return Number(data?.amount ?? data?.payment_amount ?? data?.data?.amount ?? data?.data?.payment_amount ?? tx.amount ?? tx.payment_amount);
}

function isSuccessfulPaymentStatus(status) {
  return ["success", "successful", "completed", "complete", "paid", "approved"].includes(status);
}

function isFailedPaymentStatus(status) {
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

async function verifyTargetGrowthsDeposit(dep) {
  const verificationCandidates = [
    dep?.provider_identifier,
    isPotentialMerchantIdentifier(dep?.provider_reference) ? dep.provider_reference : null,
  ];
  if (!verificationCandidates.some(value => String(value || "").trim())) return { ok:false, status:"missing_reference" };

  let verificationResult;
  try {
    verificationResult = await verifyWithCandidates(verificationCandidates);
  } catch (error) {
    console.warn("[admin-targetgrowths-verify]", error.message);
    return { ok:false, status:"verification_unavailable", error:error.message };
  }

  const verification = verificationResult.data;
  const status = providerPaymentStatus(verification);
  const amount = providerPaymentAmount(verification);
  const providerRef = providerReference(verification, verificationResult.id);
  if (!providerIdentifierMatches(verification, dep?.provider_identifier)) {
    return { ok:false, status:"identifier_mismatch", verification };
  }
  const payload = {
    provider_status: status || "pending",
    provider_reference: providerRef,
    provider_response: verification,
    updated_at: new Date().toISOString(),
  };

  if (isFailedPaymentStatus(status)) {
    await supabase.from("deposits").update({ ...payload, status:"rejected" }).eq("id", dep.id).eq("status", "pending");
    return { ok:false, status, verification };
  }
  if (!isSuccessfulPaymentStatus(status)) {
    await supabase.from("deposits").update(payload).eq("id", dep.id).eq("status", "pending");
    return { ok:false, status:status || "pending", verification };
  }
  if (!Number.isFinite(amount) || Math.abs(amount - Number(dep.amount)) >= 0.01) {
    await supabase.from("deposits").update({ ...payload, provider_status:"amount_mismatch" }).eq("id", dep.id).eq("status", "pending");
    return { ok:false, status:"amount_mismatch", verification };
  }

  await supabase.from("deposits").update({ ...payload, provider_status:"verified_success" }).eq("id", dep.id).eq("status", "pending");
  return { ok:true, status:"verified_success", verification, provider_reference:providerRef };
}

async function activeDepositMethod() {
  const { data } = await supabase.from("site_settings").select("value").eq("key", "deposit_method").single();
  return data?.value || "manual";
}

async function activeWithdrawalMethod() {
  // The existing admin method selector controls both flows for now. Any
  // method other than TargetGrowths is deliberately handled manually.
  const { data } = await supabase.from("site_settings").select("value").eq("key", "deposit_method").maybeSingle();
  return String(data?.value || "manual").toLowerCase();
}

async function isAdmin(id) {
  if(!id) return false;
  const { data } = await supabase.from("profiles").select("is_admin").eq("id",id).single();
  return !!data?.is_admin;
}

module.exports = async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  const action = req.query.action;
  const admin_id = req.method==="GET" ? req.query.admin_id : req.body?.admin_id;
  if(!await isAdmin(admin_id)) return res.status(403).json({ error:"Unauthorized" });

  // ── GETs ──────────────────────────────────────────────────────────────────
  if(req.method==="GET") {

    if(action==="deposits") {
      const status = req.query.status||"pending";
      const method = await activeDepositMethod();
      let q = supabase.from("deposits").select("*,profiles!user_id(full_name,email,referral_code)").order("created_at",{ascending:false}).limit(100);
      if(status!=="all") q=q.eq("status",status);
      // The pending queue follows the method currently selected in admin settings.
      // Historical/all-status views remain available for audit purposes.
      if(status==="pending" && method) q=q.eq("method",method);
      const { data,error } = await q;
      if(error) return res.status(500).json({ error:error.message });
      const deposits = data || [];
      // Do not block the queue on a live provider request. Approval performs a
      // fresh TargetGrowths verification in process-deposit before crediting.
      deposits.forEach(dep => {
        dep.provider_verified = dep.method === "targetgrowths" && dep.provider_status === "verified_success";
      });
      return res.json({ ok:true, method, deposits });
    }

    if(action==="withdrawals") {
      const status = req.query.status||"pending";
      let q = supabase.from("withdrawals").select("*,profiles!user_id(full_name,email)").order("created_at",{ascending:false}).limit(100);
      if(status!=="all") q=q.eq("status",status);
      const { data,error } = await q;
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, withdrawals:data||[] });
    }

    if(action==="users") {
      const search = String(req.query.q || "").trim();
      let q = supabase.from("profiles").select("*,wallets(balance)").order("created_at",{ascending:false}).limit(1000);
      if (search) {
        // Keep the PostgREST expression safe while allowing normal names/emails.
        const safeSearch = search.replace(/[^a-zA-Z0-9@._+ -]/g, " ").trim();
        if (safeSearch) q = q.or(`full_name.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%,phone.ilike.%${safeSearch}%`);
      }
      const { data,error } = await q;
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, users:data||[], search:search||null });
    }

    if(action==="user-team") {
      const { target_user_id } = req.query;
      if(!target_user_id) return res.status(400).json({ error:"target_user_id required" });

      const { data:l1 } = await supabase.from("profiles").select("id,full_name,email,created_at").eq("referred_by",target_user_id).order("created_at",{ascending:false});
      const l1List = l1||[];
      const l1Ids = l1List.map(m=>m.id);

      let activeSet = new Set();
      if(l1Ids.length) {
        const { data:invested } = await supabase.from("user_products").select("user_id").in("user_id",l1Ids);
        (invested||[]).forEach(r=>activeSet.add(r.user_id));
      }
      const l1WithStatus = l1List.map(m=>({...m, isActive:activeSet.has(m.id)}));

      // Admin view always walks the full 3-level downline for audit purposes,
      // regardless of the referral_levels commission setting — that setting
      // only controls what gets *paid*, not who's actually in the tree.
      let l2List = [];
      if(l1Ids.length) {
        const { data:l2 } = await supabase.from("profiles").select("id,full_name,email,created_at,referred_by").in("referred_by",l1Ids).order("created_at",{ascending:false});
        l2List = l2||[];
      }
      let l3List = [];
      const l2Ids = l2List.map(m=>m.id);
      if(l2Ids.length) {
        const { data:l3 } = await supabase.from("profiles").select("id,full_name,email,created_at").in("referred_by",l2Ids).order("created_at",{ascending:false});
        l3List = l3||[];
      }
      const l3Ids = l3List.map(m=>m.id);
      const allTeamIds = [...l1Ids, ...l2Ids, ...l3Ids];

      let ownDeposits=0, l1Deposits=0, l2Deposits=0, l3Deposits=0;
      const depIds = [target_user_id, ...allTeamIds];
      const { data:deps } = await supabase.from("deposits").select("user_id,amount").eq("status","completed").in("user_id",depIds);
      const l1Set=new Set(l1Ids), l2Set=new Set(l2Ids);
      (deps||[]).forEach(d=>{
        const amt=Number(d.amount||0);
        if(d.user_id===target_user_id) ownDeposits+=amt;
        else if(l1Set.has(d.user_id)) l1Deposits+=amt;
        else if(l2Set.has(d.user_id)) l2Deposits+=amt;
        else l3Deposits+=amt;
      });

      return res.json({
        ok:true,
        l1:l1WithStatus, l2:l2List, l3:l3List,
        active_count: activeSet.size,
        total_team: l1List.length + l2List.length + l3List.length,
        own_deposits: ownDeposits,
        l1_deposits: l1Deposits, l2_deposits: l2Deposits, l3_deposits: l3Deposits,
        total_team_deposits: l1Deposits+l2Deposits+l3Deposits,
        grand_total_deposits: ownDeposits+l1Deposits+l2Deposits+l3Deposits,
      });
    }

    if(action==="products") {
      const { data,error } = await supabase.from("products").select("*").order("sort_order");
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, products:data||[] });
    }

    if(action==="messages") {
      const { data,error } = await supabase.from("messages").select("*, recipient:profiles!user_id(full_name,email)").order("created_at",{ascending:false}).limit(100);
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, messages:data||[] });
    }

    if(action==="gift-codes") {
      const { data,error } = await supabase.from("gift_codes").select("*").order("created_at",{ascending:false}).limit(100);
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, codes:data||[] });
    }

    if(action==="withdrawal-lock-status") {
      const { data } = await supabase.from("site_settings").select("value").eq("key","withdrawals_locked").single();
      return res.json({ ok:true, locked: data?.value === "true" });
    }

    if(action==="withdrawal-limits") {
      const { data } = await supabase.from("site_settings").select("key,value").in("key",["min_withdraw","max_withdraw"]);
      const min = Number(data?.find(s=>s.key==="min_withdraw")?.value || 1000);
      const max = Number(data?.find(s=>s.key==="max_withdraw")?.value || 0);
      return res.json({ ok:true, min, max });
    }

    if(action==="extra-settings") {
      const keys = ["deposit_bank_name","deposit_account_number","deposit_account_name",
        "welcome_bonus_enabled","welcome_bonus_amount","require_invest_before_withdraw",
        "require_active_referral_to_withdraw",
        "vip_enabled","withdrawal_fee_percent","referral_levels",
        "referral_l1_percent","referral_l2_percent","referral_l3_percent",
        "telegram_support_url","telegram_community_url","whatsapp_url","customer_service_url"];
      const { data,error } = await supabase.from("site_settings").select("key,value").in("key",keys);
      if(error) return res.status(500).json({ error:error.message });
      const map={}; (data||[]).forEach(function(r){ map[r.key]=r.value; });
      return res.json({ ok:true, settings:map });
    }

    if(action==="targetgrowths-balance") {
      try {
        const balance = await getWalletBalance("NGN");
        return res.json({ ok:true, ...balance, fetched_at:new Date().toISOString() });
      } catch (error) {
        console.error("[TG-BALANCE]", error.message, error.providerResponse || "");
        return res.status(502).json({ ok:false, error:error.message || "Unable to load TargetGrowths balance" });
      }
    }

    if(action==="stats") {
      const [d,w,u,p] = await Promise.all([
        supabase.from("deposits").select("id",{count:"exact",head:true}).eq("status","pending"),
        supabase.from("withdrawals").select("id",{count:"exact",head:true}).eq("status","pending"),
        supabase.from("profiles").select("id",{count:"exact",head:true}),
        supabase.from("user_products").select("id",{count:"exact",head:true}).eq("status","active"),
      ]);
      return res.json({ ok:true, pending_deposits:d.count||0, pending_withdrawals:w.count||0, total_users:u.count||0, active_products:p.count||0 });
    }

    return res.status(400).json({ error:"Unknown action" });
  }

  if(req.method!=="POST") return res.status(405).json({ error:"Method not allowed" });

  // ── POSTs ─────────────────────────────────────────────────────────────────
  if(action==="set-method") {
    const { method } = req.body;
    if(!["manual","monnify","targetgrowths"].includes(method)) return res.status(400).json({ error:"Invalid method" });
    const { error } = await supabase.from("site_settings").upsert({ key:"deposit_method", value:method, updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, method });
  }

  if(action==="set-withdrawal-lock") {
    const { locked } = req.body;
    const { error } = await supabase.from("site_settings").upsert({ key:"withdrawals_locked", value: locked?"true":"false", updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, locked: !!locked });
  }

  if(action==="set-withdrawal-limits") {
    const { min, max } = req.body;
    const minNum = Number(min), maxNum = Number(max);
    if(isNaN(minNum)||minNum<0) return res.status(400).json({ error:"Invalid minimum amount" });
    if(isNaN(maxNum)||maxNum<0) return res.status(400).json({ error:"Invalid maximum amount" });
    if(maxNum>0 && maxNum<minNum) return res.status(400).json({ error:"Maximum must be greater than minimum (or 0 for no maximum)" });
    await supabase.from("site_settings").upsert([
      { key:"min_withdraw", value:String(minNum), updated_at:new Date().toISOString() },
      { key:"max_withdraw", value:String(maxNum), updated_at:new Date().toISOString() },
    ]);
    return res.json({ ok:true, min:minNum, max:maxNum });
  }

  if(action==="set-bank-details") {
    const { bank_name, account_number, account_name } = req.body;
    if(!bank_name||!account_number||!account_name) return res.status(400).json({ error:"bank_name, account_number, and account_name required" });
    const now=new Date().toISOString();
    const { error } = await supabase.from("site_settings").upsert([
      { key:"deposit_bank_name",      value:String(bank_name).trim(),      updated_at:now },
      { key:"deposit_account_number", value:String(account_number).trim(), updated_at:now },
      { key:"deposit_account_name",   value:String(account_name).trim(),   updated_at:now },
    ]);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-welcome-bonus") {
    const { enabled, amount } = req.body;
    const num = Number(amount||0);
    if(isNaN(num)||num<0) return res.status(400).json({ error:"Invalid amount" });
    const now=new Date().toISOString();
    const { error } = await supabase.from("site_settings").upsert([
      { key:"welcome_bonus_enabled", value: enabled?"true":"false", updated_at:now },
      { key:"welcome_bonus_amount",  value:String(num),             updated_at:now },
    ]);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-invest-gate") {
    const { required } = req.body;
    const { error } = await supabase.from("site_settings").upsert({ key:"require_invest_before_withdraw", value: required?"true":"false", updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-referral-gate") {
    const { required } = req.body;
    const { error } = await supabase.from("site_settings").upsert({ key:"require_active_referral_to_withdraw", value: required?"true":"false", updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-vip-enabled") {
    const { enabled } = req.body;
    const { error } = await supabase.from("site_settings").upsert({ key:"vip_enabled", value: enabled?"true":"false", updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-withdrawal-fee") {
    const { percent } = req.body;
    const num = Number(percent);
    if(isNaN(num)||num<0||num>100) return res.status(400).json({ error:"Percent must be between 0 and 100" });
    const { error } = await supabase.from("site_settings").upsert({ key:"withdrawal_fee_percent", value:String(num), updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-referral-settings") {
    const { levels, l1, l2, l3 } = req.body;
    const lv=Number(levels), p1=Number(l1), p2=Number(l2), p3=Number(l3);
    if(![1,3].includes(lv)) return res.status(400).json({ error:"levels must be 1 or 3" });
    if([p1,p2,p3].some(function(n){ return isNaN(n)||n<0||n>100; })) return res.status(400).json({ error:"Percentages must be between 0 and 100" });
    const now=new Date().toISOString();
    const { error } = await supabase.from("site_settings").upsert([
      { key:"referral_levels",     value:String(lv), updated_at:now },
      { key:"referral_l1_percent", value:String(p1), updated_at:now },
      { key:"referral_l2_percent", value:String(p2), updated_at:now },
      { key:"referral_l3_percent", value:String(p3), updated_at:now },
    ]);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-contact-links") {
    const { telegram_support_url, telegram_community_url, whatsapp_url, customer_service_url } = req.body;
    const fields = { telegram_support_url, telegram_community_url, whatsapp_url, customer_service_url };
    for(const [key,val] of Object.entries(fields)){
      if(!val || !String(val).trim()) return res.status(400).json({ error:key+" is required" });
    }
    const now=new Date().toISOString();
    const { error } = await supabase.from("site_settings").upsert(
      Object.entries(fields).map(function([key,val]){ return { key, value:String(val).trim(), updated_at:now }; })
    );
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="adjust-wallet") {
    const { target_user_id, amount, type, reason } = req.body;
    if(!target_user_id||!amount||!["credit","debit"].includes(type)) return res.status(400).json({ error:"target_user_id, amount, and type (credit|debit) required" });
    const num = Number(amount);
    if(isNaN(num)||num<=0) return res.status(400).json({ error:"Invalid amount" });

    const { data:wallet } = await supabase.from("wallets").select("balance").eq("user_id",target_user_id).single();
    if(!wallet) return res.status(404).json({ error:"Wallet not found for this user" });

    const delta = type==="credit"?num:-num;
    const newBalance = Number(wallet.balance) + delta;
    if(newBalance < 0) return res.status(400).json({ error:"This would make the balance negative (₦"+newBalance.toLocaleString()+"). Reduce the debit amount." });

    await supabase.from("wallets").update({ balance:newBalance, updated_at:new Date().toISOString() }).eq("user_id",target_user_id);
    await supabase.from("wallet_transactions").insert({ user_id:target_user_id, type: type==="credit"?"admin_credit":"admin_debit", amount: type==="credit"?num:-num, description:"Admin adjustment"+(reason?": "+reason:"") });
    await supabase.from("messages").insert({ user_id:target_user_id, sender_id:null, title: type==="credit"?"Wallet Credited":"Wallet Adjusted", content:`Your wallet was ${type==="credit"?"credited":"debited"} ₦${num.toLocaleString()} by an admin.`+(reason?` Reason: ${reason}`:"") });

    return res.json({ ok:true, new_balance:newBalance });
  }

  if(action==="process-deposit") {
    const { deposit_id, act } = req.body;
    if(!deposit_id||!["approve","reject"].includes(act)) return res.status(400).json({ error:"deposit_id and act required" });
    const { data:dep } = await supabase.from("deposits").select("*").eq("id",deposit_id).single();
    if(!dep) return res.status(404).json({ error:"Not found" });
    // TargetGrowths deposits may be completed automatically by a verified webhook,
    // but admins can approve a still-pending deposit when provider confirmation is
    // unavailable. The process_deposit RPC remains the idempotent credit authority.
    if(dep.status==="completed") return res.json({ ok:true, note:"already_completed" });
    if(dep.status==="rejected") return res.json({ ok:true, note:"already_rejected" });
    if(act==="reject") {
      await supabase.from("deposits").update({ status:"rejected", approved_by:admin_id, approved_at:new Date().toISOString(), updated_at:new Date().toISOString() }).eq("id",deposit_id);
      return res.json({ ok:true, action:"rejected" });
    }

    const isTargetGrowthsDeposit = dep.provider === "targetgrowths" || dep.method === "targetgrowths";
    if (isTargetGrowthsDeposit) {
      const verification = await verifyTargetGrowthsDeposit(dep);
      if (!verification.ok) {
        if (verification.status === "verification_unavailable") {
          return res.status(502).json({ error:"TargetGrowths status could not be verified. Try again after checking the provider dashboard." });
        }
        if (verification.status === "amount_mismatch") {
          return res.status(409).json({ error:"TargetGrowths confirmed a different amount. The deposit was not approved." });
        }
        if (["failed","failure","rejected","reject","cancelled","canceled","declined"].includes(verification.status)) {
          return res.status(409).json({ error:"TargetGrowths marked this payment as unsuccessful. The deposit was not approved." });
        }
        return res.status(409).json({ error:`TargetGrowths payment is not confirmed yet (${verification.status || "pending"}). Only successful payments can be approved.` });
      }
    }

    await supabase.from("deposits").update({ approved_by:admin_id, approved_at:new Date().toISOString(), updated_at:new Date().toISOString() }).eq("id",deposit_id).eq("status","pending");
    const { data,error } = await supabase.rpc("process_deposit", { p_reference:dep.reference, p_amount:dep.amount, p_payload:{ source:"admin_approval", admin_id } });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, action:"approved", data });
  }

  if(action==="process-withdrawal") {
    const { withdrawal_id, act, note } = req.body;
    if(!withdrawal_id||!["approve","reject"].includes(act)) return res.status(400).json({ error:"withdrawal_id and act required" });
    const { data:w } = await supabase.from("withdrawals").select("*").eq("id",withdrawal_id).single();
    if(!w) return res.status(404).json({ error:"Not found" });
    if(w.status!=="pending") return res.json({ ok:true, note:"already_processed", status:w.status, provider_status:w.provider_status||null });

    if(act==="reject") {
      const { data, error } = await supabase.rpc("finalize_targetgrowths_withdrawal", {
        p_withdrawal_id: withdrawal_id,
        p_success: false,
        p_provider_reference: null,
        p_provider_status: "admin_rejected",
        p_payload: { source:"admin_rejection", admin_id, note:note||null },
      });
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, action:"reject", data });
    }

    const withdrawalMethod = await activeWithdrawalMethod();
    console.log("[withdrawal-routing]", JSON.stringify({ withdrawal_id, method: withdrawalMethod }));

    // Manual mode must never validate a TargetGrowths bank code or call the
    // provider. The wallet was already debited by request_withdrawal(); this
    // approval only records the administrator's manual payment decision.
    if (withdrawalMethod !== "targetgrowths") {
      const { data:manualClaimed, error:manualError } = await supabase.from("withdrawals").update({
        status: "completed",
        provider: "manual",
        provider_status: "manual_approved",
        provider_identifier: null,
        provider_reference: null,
        provider_response: { source: "manual_admin_approval", admin_id },
        processed_by: admin_id,
        processed_at: new Date().toISOString(),
        note: note || "Approved for manual bank transfer",
        updated_at: new Date().toISOString(),
      }).eq("id", withdrawal_id).eq("status", "pending").select("*").single();

      if (manualError) return res.status(500).json({ error: manualError.message });
      if (!manualClaimed) return res.json({ ok:true, note:"already_processed" });
      return res.json({ ok:true, action:"approved", status:"manual_approved" });
    }

    const bankId = bankCodeFor(w.bank_name, w.bank_id);
    if(!bankId) return res.status(400).json({ error:"This bank is not configured for TargetGrowths payouts. Save the exact Nigerian bank name or bank code before approving." });

    const { data:profile } = await supabase.from("profiles").select("full_name,email").eq("id",w.user_id).single();
    const identifier = `TGW${String(withdrawal_id).replace(/-/g, "").slice(0, 12).toUpperCase()}${Date.now().toString(36).toUpperCase()}`;
    const { data:claimed, error:claimError } = await supabase.from("withdrawals").update({
      status:"approved",
      provider:"targetgrowths",
      provider_identifier:identifier,
      provider_status:"initiating",
      processed_by:admin_id,
      processed_at:new Date().toISOString(),
      note:note||null,
    }).eq("id",withdrawal_id).eq("status","pending").select("*").single();
    if(claimError || !claimed) return res.json({ ok:true, note:"already_processed" });

    const payoutAmount = Number(w.net_amount ?? w.amount);
    try {
      const ipnUrl = `${appUrl(req)}/api/webhooks/targetgrowths`;
      console.log("[TG-TRANSFER-IPN]", JSON.stringify({ identifier, ipn_url: ipnUrl, amount: w.net_amount || w.amount }));
      const provider = await initiateTransfer({
        identifier,
        amount:payoutAmount,
        bankId,
        recipient:w.account_number,
        accountName:w.account_name,
        ipnUrl,
        customerEmail:profile?.email,
      });
      const providerRef = providerReference(provider, identifier);
      const { error:updateError } = await supabase.from("withdrawals").update({
        status:"approved",
        provider_status:String(provider?.status || provider?.data?.status || "pending").toLowerCase(),
        provider_reference:providerRef,
        provider_response:provider,
        updated_at:new Date().toISOString(),
      }).eq("id",withdrawal_id).eq("status","approved");
      if(updateError) return res.status(500).json({ error:updateError.message });
      return res.json({ ok:true, action:"approved", status:"provider_pending", provider_reference:providerRef });
    } catch(e) {
      console.error("[targetgrowths-transfer]", e);
      if(e.retryable) {
        await supabase.from("withdrawals").update({ provider_status:"manual_review", note:"TargetGrowths request timed out or could not be confirmed. Do not retry until the provider is checked.", updated_at:new Date().toISOString() }).eq("id",withdrawal_id).eq("status","approved");
        return res.status(502).json({ error:"TargetGrowths did not confirm the payout. The withdrawal was left for manual review." });
      }
      const { error:refundError } = await supabase.rpc("finalize_targetgrowths_withdrawal", {
        p_withdrawal_id: withdrawal_id,
        p_success: false,
        p_provider_reference: identifier,
        p_provider_status: "initiation_failed",
        p_payload: { source:"targetgrowths_transfer_error", error:e.message, provider_response:e.providerResponse||null },
      });
      if(refundError) return res.status(500).json({ error:`${e.message}; refund failed: ${refundError.message}` });
      return res.status(502).json({ error:e.message || "TargetGrowths payout failed" });
    }
  }

  if(action==="send-message") {
    const { user_id, title, content } = req.body;
    if(!title||!content) return res.status(400).json({ error:"title and content required" });
    const { error } = await supabase.from("messages").insert({ user_id:user_id||null, sender_id:admin_id, title, content });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="update-message") {
    const { message_id, title, content } = req.body;
    if(!message_id||!title||!content) return res.status(400).json({ error:"message_id, title and content required" });
    const { error } = await supabase.from("messages").update({ title, content }).eq("id",message_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="delete-message") {
    const { message_id } = req.body;
    if(!message_id) return res.status(400).json({ error:"message_id required" });
    const { error } = await supabase.from("messages").delete().eq("id",message_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="save-product") {
    const { id, name, description, type, vip_level, price, daily_income, duration_days, total_return, sort_order } = req.body;
    const payload = { name, description, type, vip_level:Number(vip_level||0), price:Number(price), daily_income:Number(daily_income), duration_days:Number(duration_days), total_return:Number(total_return), sort_order:Number(sort_order||0), updated_at:new Date().toISOString() };
    let error;
    if(id) { ({ error } = await supabase.from("products").update(payload).eq("id",id)); }
    else { ({ error } = await supabase.from("products").insert(payload)); }
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="delete-product") {
    const { product_id } = req.body;
    const { error } = await supabase.from("products").delete().eq("id",product_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="toggle-product") {
    const { product_id, status } = req.body;
    const { error } = await supabase.from("products").update({ status, updated_at:new Date().toISOString() }).eq("id",product_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-admin") {
    const { target_user_id, is_admin } = req.body;
    const { error } = await supabase.from("profiles").update({ is_admin:!!is_admin }).eq("id",target_user_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="ban-user") {
    const { target_user_id } = req.body;
    if(!target_user_id) return res.status(400).json({ error:"target_user_id required" });
    if(target_user_id === admin_id) return res.status(400).json({ error:"cannot_ban_self" });
    const { data:target } = await supabase.from("profiles").select("is_admin").eq("id",target_user_id).single();
    if(target?.is_admin) return res.status(400).json({ error:"cannot_ban_admin" });
    const { error } = await supabase.from("profiles").update({ is_active:false, updated_at:new Date().toISOString() }).eq("id",target_user_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="unban-user") {
    const { target_user_id } = req.body;
    if(!target_user_id) return res.status(400).json({ error:"target_user_id required" });
    const { error } = await supabase.from("profiles").update({ is_active:true, updated_at:new Date().toISOString() }).eq("id",target_user_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="create-gift-code") {
    const { code, amount, max_uses, expires_at } = req.body;
    if(!code||!amount) return res.status(400).json({ error:"code and amount required" });
    const cleanCode = String(code).trim().toUpperCase();
    const { error } = await supabase.from("gift_codes").insert({ code:cleanCode, amount:Number(amount), max_uses:Number(max_uses||1), uses:0, status:"active", expires_at:expires_at||null });
    if(error) {
      if(error.code==="23505") return res.status(400).json({ error:"This code already exists. Choose a different one." });
      return res.status(500).json({ error:error.message });
    }
    return res.json({ ok:true, code:cleanCode });
  }

  if(action==="toggle-gift-code") {
    const { code_id, status } = req.body;
    const { error } = await supabase.from("gift_codes").update({ status }).eq("id",code_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="delete-gift-code") {
    const { code_id } = req.body;
    const { error } = await supabase.from("gift_codes").delete().eq("id",code_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  return res.status(400).json({ error:"Unknown action: "+action });
};
