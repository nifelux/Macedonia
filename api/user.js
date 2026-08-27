/**
 * /api/user.js
 * POST ?action=update-profile
 * POST ?action=add-bank-card
 * POST ?action=delete-bank-card
 * GET  ?action=bank-cards&user_id=
 * GET  ?action=my-products&user_id=  (read-only — cron owns all crediting)
 */
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  const action = req.query.action;
  const user_id = req.method==="GET" ? req.query.user_id : req.body?.user_id;
  if(!user_id) return res.status(400).json({ error:"user_id required" });

  if(req.method==="GET") {
    if(action==="bank-cards") {
      const { data,error } = await supabase.from("bank_cards").select("*").eq("user_id",user_id).order("is_default",{ascending:false});
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, cards:data||[] });
    }
    if(action==="my-products") {
      const { data,error } = await supabase.from("user_products").select("*,products(name,description)").eq("user_id",user_id).order("created_at",{ascending:false});
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, products:data||[] });
    }
    return res.status(400).json({ error:"Unknown action" });
  }

  if(req.method!=="POST") return res.status(405).json({ error:"Method not allowed" });

  if(action==="update-profile") {
    const { full_name, phone } = req.body;
    const { error } = await supabase.from("profiles").update({ full_name, phone, updated_at:new Date().toISOString() }).eq("id",user_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="add-bank-card") {
    const { bank_name, bank_id, account_number, account_name, is_default } = req.body;
    if(!bank_name||!account_number||!account_name) return res.status(400).json({ error:"All fields required" });
    if(is_default) await supabase.from("bank_cards").update({ is_default:false }).eq("user_id",user_id);
    const { error } = await supabase.from("bank_cards").insert({ user_id, bank_name, bank_id:bank_id||null, account_number, account_name, is_default:!!is_default });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="delete-bank-card") {
    const { card_id } = req.body;
    const { error } = await supabase.from("bank_cards").delete().eq("id",card_id).eq("user_id",user_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  return res.status(400).json({ error:"Unknown action" });
};
    
