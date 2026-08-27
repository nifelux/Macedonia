/* assets/js/auth.js — shared helpers, exposes window.MacedoniaAuth */
(function () {
  window.MacedoniaAuth = {

    requireAuth: async function () {
      if (!window.sb) { location.href = "/index.html"; return null; }
      try {
        var { data: { session } } = await window.sb.auth.getSession();
        if (!session) { location.href = "/index.html"; return null; }
        var banned = await this._checkBanned(session.user.id);
        if (banned) { await this._forceBannedRedirect(); return null; }
        this._startBanWatch(session.user.id);
        return session;
      } catch(e) { location.href = "/index.html"; return null; }
    },

    // Returns true only when we positively confirmed is_active === false.
    // Any lookup failure (network blip, etc.) fails OPEN — we never want
    // a transient error to lock a legitimate user out.
    _checkBanned: async function (userId) {
      try {
        var { data } = await window.sb.from("profiles").select("is_active").eq("id", userId).single();
        return !!data && data.is_active === false;
      } catch(e) { return false; }
    },

    _forceBannedRedirect: async function () {
      if (window.sb) { try { await window.sb.auth.signOut(); } catch(e){} }
      location.href = "/banned.html";
    },

    // Catches the case where a user is banned while they already have a
    // page open — requireAuth only runs once per page load, so without
    // this an already-signed-in banned user could keep using the app
    // until their session naturally expired or they navigated again.
    _banWatchStarted: false,
    _startBanWatch: function (userId) {
      if (this._banWatchStarted) return;
      this._banWatchStarted = true;
      var self = this;
      setInterval(async function () {
        var banned = await self._checkBanned(userId);
        if (banned) await self._forceBannedRedirect();
      }, 60000);
    },

    requireAdmin: async function () {
      var session = await this.requireAuth();
      if (!session) return null;
      try {
        var { data } = await window.sb.from("profiles").select("is_admin").eq("id", session.user.id).single();
        if (!data?.is_admin) { location.href = "/dashboard.html"; return null; }
        return session;
      } catch(e) { location.href = "/dashboard.html"; return null; }
    },

    loadProfile: async function (userId) {
      if (!window.sb) return null;
      try {
        var { data: p } = await window.sb.from("profiles").select("*").eq("id", userId).single();
        if (!p) return null;
        document.querySelectorAll("[data-auth]").forEach(function (el) {
          var key = el.dataset.auth;
          if (p[key] !== undefined && p[key] !== null) el.textContent = p[key];
        });
        document.querySelectorAll("[data-vip]").forEach(function (el) {
          el.className = el.className.replace(/\bvip-\d\b/g, "");
          el.classList.add("vip-" + (p.vip_level || 0));
          el.textContent = p.vip_level > 0 ? "VIP " + p.vip_level : "Member";
        });
        return p;
      } catch(e) { console.warn("loadProfile error:", e); return null; }
    },

    logout: async function () {
      if (window.sb) { try { await window.sb.auth.signOut(); } catch(e){} }
      location.href = "/index.html";
    },

    money: function (v) {
      return "₦" + Number(v || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    toast: function (msg, duration) {
      var el = document.getElementById("toast");
      if (!el) {
        el = document.createElement("div");
        el.id = "toast";
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.classList.add("show");
      clearTimeout(el._t);
      el._t = setTimeout(function () { el.classList.remove("show"); }, duration || 2500);
    },

    timeAgo: function (dateStr) {
      var diff = Date.now() - new Date(dateStr).getTime();
      var m = Math.floor(diff / 60000);
      if (m < 1) return "just now";
      if (m < 60) return m + "m ago";
      var h = Math.floor(m / 60);
      if (h < 24) return h + "h ago";
      return Math.floor(h / 24) + "d ago";
    }
  };
})();
        
