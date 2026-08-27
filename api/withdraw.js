/**
 * /api/withdraw.js
 * POST → request withdrawal
 * GET  → history
 * GET  ?action=lock-status  (public)
 * GET  ?action=limits       (public)
 */
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  if(req.method==="GET" && req.query.action==="lock-status") {
    const { data } = await supabase.from("site_settings").select("value").eq("key","withdrawals_locked").single();
    return res.json({ ok:true, locked: data?.value === "true" });
  }

  if(req.method==="GET" && req.query.action==="limits") {
    const { data } = await supabase.from("site_settings").select("key,value").in("key",["min_withdraw","max_withdraw"]);
    const min = Number(data?.find(s=>s.key==="min_withdraw")?.value || 1000);
    const max = Number(data?.find(s=>s.key==="max_withdraw")?.value || 0);
    return res.json({ ok:true, min, max });
  }

  const user_id = req.method==="GET" ? req.query.user_id : req.body?.user_id;
  if(!user_id) return res.status(400).json({ error:"user_id required" });

  if(req.method==="GET") {
    const { data,error } = await supabase.from("withdrawals").select("*").eq("user_id",user_id).order("created_at",{ascending:false}).limit(50);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, withdrawals:data||[] });
  }

  if(req.method!=="POST") return res.status(405).json({ error:"Method not allowed" });

  const { amount, bank_name, bank_id, account_number, account_name } = req.body;
  if(!amount||!bank_name||!account_number||!account_name) return res.status(400).json({ error:"All fields required" });
  const num = Number(amount);
  if(isNaN(num) || num <= 0) return res.status(400).json({ error:"Invalid amount" });

  // All gating (lock, min/max, invest-required, fee %) now lives in one
  // place — the request_withdrawal() Postgres function — so the admin
  // toggles actually take effect and there's no read-then-write race
  // on the wallet balance.
  const requestStartedAt = new Date().toISOString();
  const { data, error } = await supabase.rpc("request_withdrawal", {
    p_user_id: user_id,
    p_amount: num,
    p_bank_name: bank_name,
    p_account_number: account_number,
    p_account_name: account_name,
  });

  if(error) return res.status(500).json({ error:error.message });
  if(!data?.ok) {
    const messages = {
      withdrawals_locked:   "Withdrawals are temporarily paused. Please check back later.",
      below_minimum:        `Minimum withdrawal is ₦${Number(data.min||0).toLocaleString()}`,
      above_maximum:        `Maximum withdrawal is ₦${Number(data.max||0).toLocaleString()}`,
      investment_required:  "You need an active investment before you can withdraw.",
      active_referral_required: "You need at least one referral who has made a purchase before you can withdraw.",
      insufficient_balance: "Insufficient balance",
    };
    return res.json({ ok:false, error: messages[data?.error] || data?.error || "Withdrawal failed" });
  }

  if(bank_id) {
    const withdrawalId = data.withdrawal_id || data.id;
    if(withdrawalId) {
      await supabase.from("withdrawals").update({ bank_id }).eq("id", withdrawalId).eq("user_id", user_id);
    } else {
      const { data:created } = await supabase.from("withdrawals").select("id").eq("user_id", user_id).eq("status", "pending").gte("created_at", requestStartedAt).order("created_at", { ascending:false }).limit(1).maybeSingle();
      if(created?.id) await supabase.from("withdrawals").update({ bank_id }).eq("id", created.id);
    }
  }

  return res.json({ ok:true, amount:data.amount, fee:data.fee, net:data.net });
};
