/**
 * /api/messages.js
 * GET  ?user_id=
 * POST ?action=mark-read  { user_id, message_id }
 */
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  const user_id = req.method==="GET" ? req.query.user_id : req.body?.user_id;
  if(!user_id) return res.status(400).json({ error:"user_id required" });

  if(req.method==="GET") {
    const { data,error } = await supabase.from("messages").select("*").or(`user_id.eq.${user_id},user_id.is.null`).order("created_at",{ascending:false}).limit(50);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, messages:data||[] });
  }

  if(req.method==="POST" && req.query.action==="mark-read") {
    const { message_id } = req.body;
    if(message_id) await supabase.from("messages").update({ is_read:true }).eq("id",message_id);
    else await supabase.from("messages").update({ is_read:true }).or(`user_id.eq.${user_id},user_id.is.null`);
    return res.json({ ok:true });
  }

  return res.status(405).json({ error:"Method not allowed" });
};
