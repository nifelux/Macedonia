/* assets/js/supabase.js
   ⚠️ PUT YOUR REAL SUPABASE CREDENTIALS BELOW
   Supabase Dashboard → Settings → API */
(function () {
  var SUPABASE_URL  = "https://pidabyudcwwcpmfnujmd.supabase.co";      // https://xxxx.supabase.co
  var SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBpZGFieXVkY3d3Y3BtZm51am1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyODM1MDcsImV4cCI6MjA5OTg1OTUwN30.PjUW68xz_i2ZlYIkuqpGP5hFZxU_U8mjix-35xCbfBQ";  // eyJhbGci...

  if (!SUPABASE_URL || SUPABASE_URL === "YOUR_SUPABASE_URL") {
    console.error("❌ MACEDONIA: Supabase not configured. Edit assets/js/supabase.js");
    return;
  }
  if (typeof window.supabase === "undefined") {
    console.error("❌ MACEDONIA: @supabase/supabase-js not loaded yet.");
    return;
  }

  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
  });
  console.log("✅ Macedonia: Supabase ready");
})();
