/**
 * /api/team.js
 * GET ?user_id=UUID
 * GET ?action=vip-status       (public — no user_id required; used by products.html
 *                                and any other page that just needs to know whether
 *                                the admin has VIP turned on, without full team data)
 * GET ?action=contact-links    (public — no user_id required; Telegram/WhatsApp/
 *                                customer-service URLs shown on contact.html and
 *                                the dashboard welcome popup, admin-editable)
 * Server-side (service-role) because RLS blocks users from seeing
 * other users' profile rows directly from the browser.
 */
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Fallbacks match what was previously hardcoded on the client, so contact.html
// and the dashboard popup never end up with a broken/empty link even if the
// site_settings rows haven't been created yet (e.g. migration not run).
const CONTACT_LINK_DEFAULTS = {
  telegram_support_url:   "https://t.me/Macedonia32",
  telegram_community_url: "https://t.me/+ZBPQYNyTdks0NjI8",
  whatsapp_url:            "https://chat.whatsapp.com/Fr9g6gu6NFrLdz92RPrF0f?s=cl&p=a&ilr=1",
  customer_service_url:   "tel:+2340000000000",
};

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="GET") return res.status(405).json({ error:"Method not allowed" });

  if(req.query.action==="vip-status") {
    const { data } = await supabase.from("site_settings").select("value").eq("key","vip_enabled").single();
    return res.json({ ok:true, vip_enabled: (data?.value ?? "true") === "true" });
  }

  if(req.query.action==="contact-links") {
    const keys = Object.keys(CONTACT_LINK_DEFAULTS);
    const { data } = await supabase.from("site_settings").select("key,value").in("key",keys);
    const map = { ...CONTACT_LINK_DEFAULTS };
    (data||[]).forEach(function(r){ if(r.value) map[r.key]=r.value; });
    return res.json({ ok:true, links:map });
  }

  const { user_id } = req.query;
  if(!user_id) return res.status(400).json({ error:"user_id required" });

  try {
    // ── Admin-configurable settings: referral depth, % rates, VIP kill switch ──
    const settingKeys = ["referral_levels","referral_l1_percent","referral_l2_percent","referral_l3_percent","vip_enabled"];
    const { data:settingsRows } = await supabase.from("site_settings").select("key,value").in("key",settingKeys);
    const settingsMap = {};
    (settingsRows||[]).forEach(function(r){ settingsMap[r.key]=r.value; });

    const referralLevels = Number(settingsMap.referral_levels || 3); // 1 or 3
    const l1Percent = Number(settingsMap.referral_l1_percent ?? 20);
    const l2Percent = Number(settingsMap.referral_l2_percent ?? 3);
    const l3Percent = Number(settingsMap.referral_l3_percent ?? 2);
    const vipEnabled = (settingsMap.vip_enabled ?? "true") === "true";

    const { data:l1 } = await supabase.from("profiles").select("id,full_name,email,created_at").eq("referred_by",user_id).order("created_at",{ascending:false});
    const l1List = l1||[];
    const l1Ids = l1List.map(m=>m.id);

    let activeSet = new Set();
    if(l1Ids.length) {
      const { data:invested } = await supabase.from("user_products").select("user_id").in("user_id",l1Ids);
      (invested||[]).forEach(r=>activeSet.add(r.user_id));
    }
    const l1WithStatus = l1List.map(m=>({...m, isActive:activeSet.has(m.id)}));

    // Only walk levels 2/3 when the admin has referral depth set to 3.
    let l2List = [];
    if(referralLevels >= 2 && l1Ids.length) {
      const { data:l2 } = await supabase.from("profiles").select("id,full_name,email,created_at,referred_by").in("referred_by",l1Ids).order("created_at",{ascending:false});
      l2List = l2||[];
    }

    let l3List = [];
    const l2Ids = l2List.map(m=>m.id);
    if(referralLevels >= 3 && l2Ids.length) {
      const { data:l3 } = await supabase.from("profiles").select("id,full_name,email,created_at").in("referred_by",l2Ids).order("created_at",{ascending:false});
      l3List = l3||[];
    }

    const l3Ids = l3List.map(m=>m.id);
    const allTeamIds = [...l1Ids, ...l2Ids, ...l3Ids];

    let l1Deposits=0, l2Deposits=0, l3Deposits=0;
    if(allTeamIds.length) {
      const { data:deps } = await supabase.from("deposits").select("user_id,amount").eq("status","completed").in("user_id",allTeamIds);
      const l1Set=new Set(l1Ids), l2Set=new Set(l2Ids);
      (deps||[]).forEach(d=>{
        const amt=Number(d.amount||0);
        if(l1Set.has(d.user_id)) l1Deposits+=amt;
        else if(l2Set.has(d.user_id)) l2Deposits+=amt;
        else l3Deposits+=amt;
      });
    }

    const { data:rewards } = await supabase.from("referral_rewards").select("amount").eq("referrer_id",user_id);
    const totalEarned = (rewards||[]).reduce((s,r)=>s+Number(r.amount||0),0);

    return res.json({
      ok: true,
      l1: l1WithStatus, l2: l2List, l3: l3List,
      active_count: activeSet.size,
      total_team: l1List.length + l2List.length + l3List.length,
      earned: totalEarned,
      total_team_deposits: l1Deposits+l2Deposits+l3Deposits,
      l1_deposits: l1Deposits, l2_deposits: l2Deposits, l3_deposits: l3Deposits,
      // Front-end uses these to render the correct number of level tabs,
      // the correct percentages, and to show/hide the VIP progress card.
      settings: {
        referral_levels: referralLevels,
        referral_l1_percent: l1Percent,
        referral_l2_percent: l2Percent,
        referral_l3_percent: l3Percent,
        vip_enabled: vipEnabled,
      },
    });
  } catch(e) {
    console.error("[team]", e);
    return res.status(500).json({ error: e.message });
  }
};
  
