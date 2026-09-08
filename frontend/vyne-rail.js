/**
 * vyne-rail.js — the persistent Vynora-navy left rail (Foundry shell).
 *
 * The two-tone signature: deep navy rail on the left, light instrument
 * content beside it. Mirrors Foundry's .tower-rail (same gradient, same
 * type treatment). Role-aware: consultants get the module nav; interviewees
 * see only their interview. Renders only when a session exists — the login
 * screen stays clean and centered.
 *
 * Load AFTER vyne-client.js on every page.
 */
(function () {
  /** &<>"' — the rail renders consultant-entered values on every page. */
  function railEsc(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  "use strict";

  var RAIL_W = 216;

  // Order mirrors the engagement's actual sequence, which is also the order
  // the Hub cards use. v5.32.18: Solution Design Studio was missing entirely —
  // it had a Hub card but no rail entry, so once you were inside any module
  // there was no way to reach it without going back to the Hub first.
  var NAV = [
    { href: "index.html",          icon: "⌂",  label: "The Hub" },
    { href: "pre_engagement.html", icon: "📋", label: "Pre-Engagement" },
    { href: "interview_agent.html",icon: "🎤", label: "Interview Agent" },
    { href: "interviews.html",     icon: "🗂", label: "Interview Tracker" },
    { href: "synthesis.html",      icon: "📊", label: "Synthesis" },
    { href: "roadmap.html",        icon: "🗺", label: "Roadmap Builder" },
    { href: "solution_design.html",icon: "📐", label: "Design Studio" },
  ];
  var NAV_INTERVIEWEE = [
    { href: "interview_agent.html", icon: "🎤", label: "Your Interview" },
  ];

  function currentPage() {
    var p = (location.pathname.split("/").pop() || "index.html");
    return p === "" ? "index.html" : p;
  }

  function render() {
    if (document.getElementById("vyne-rail")) return;
    var s = (window.vyneAuth && vyneAuth.session()) || null;
    if (!s) return; // pre-login: no rail

    var isInterviewee = s.role === "interviewee";
    var items = isInterviewee ? NAV_INTERVIEWEE : NAV;
    var page = currentPage();

    var css = document.createElement("style");
    css.textContent =
      "#vyne-rail{position:fixed;left:0;top:0;bottom:0;width:" + RAIL_W + "px;z-index:600;" +
        "background:linear-gradient(180deg,#01203D,#02182C);color:#cdd9e6;display:flex;flex-direction:column;" +
        "padding:22px 14px;font-family:'Inter',system-ui,sans-serif;box-sizing:border-box}" +
      "#vyne-rail .vr-brand{font-family:'Space Grotesk','Inter',sans-serif;font-weight:700;font-size:17px;" +
        "letter-spacing:-.01em;color:#fff;margin:0 8px 2px}" +
      "#vyne-rail .vr-brand span{color:#C6A46B}" +
      "#vyne-rail .vr-tag{font-size:10.5px;line-height:1.5;margin:2px 8px 12px;color:#8ea7bd;" +
        "letter-spacing:.06em;text-transform:uppercase;font-weight:600}" +
      "#vyne-rail .vr-client{margin:0 8px 16px;padding:8px 10px;background:rgba(255,255,255,.06);" +
        "border:1px solid rgba(198,164,107,.35);border-radius:8px}" +
      "#vyne-rail .vr-client .vc-label{font-size:8.5px;letter-spacing:.18em;text-transform:uppercase;" +
        "color:#C6A46B;font-weight:700;margin-bottom:2px}" +
      "#vyne-rail .vr-client .vc-name{font-size:12.5px;font-weight:700;color:#fff;line-height:1.3;" +
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "#vyne-rail .vr-client .vc-switch{font-size:10px;color:#8ea7bd;cursor:pointer;text-decoration:underline}" +
      "#vyne-rail .vr-client .vc-switch:hover{color:#fff}" +
      "#vyne-rail .vr-nav{flex:1 1 auto;display:flex;flex-direction:column;gap:2px;overflow-y:auto}" +
      "#vyne-rail .vr-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;" +
        "color:#9db3c7;text-decoration:none;font-size:13px;font-weight:600;border-left:3px solid transparent;" +
        "transition:background .15s,color .15s}" +
      "#vyne-rail .vr-item:hover{background:rgba(255,255,255,.07);color:#fff}" +
      "#vyne-rail .vr-item.active{background:rgba(255,255,255,.08);color:#fff;border-left-color:#C6A46B}" +
      "#vyne-rail .vr-item .vr-ico{width:20px;text-align:center;font-size:14px}" +
      "#vyne-rail .vr-foot{flex:0 0 auto;border-top:1px solid rgba(255,255,255,.10);padding-top:12px;margin-top:12px}" +
      "#vyne-rail .vr-user{font-size:11px;color:#8ea7bd;margin:0 8px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "#vyne-rail .vr-out{width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);" +
        "color:#dbe6f0;border-radius:8px;padding:8px;font:600 12px 'Inter',sans-serif;cursor:pointer;transition:all .15s}" +
      "#vyne-rail .vr-out:hover{background:rgba(255,255,255,.12);color:#fff}" +
      "body.vyne-railed{margin-left:" + RAIL_W + "px !important}" +
      "body.vyne-railed .vyne-home-btn{display:none !important}" +
      "@media (max-width:900px){#vyne-rail{display:none}body.vyne-railed{margin-left:0 !important}}";
    document.head.appendChild(css);

    // Client-context box: which client this session works on (consultant /
    // owner). Interviewees are always exactly their own interview.
    var clientBox = "";
    if (!isInterviewee) {
      var ac = s.activeClient;
      var cName = ac ? ac : (ac === null ? "All clients (admin)" : "No client selected");
      clientBox =
        '<div class="vr-client">' +
          '<div class="vc-label">Client engagement</div>' +
          // v5.32.29 SECURITY (audit H-3). The title attribute was escaped and
          // the text node beside it was not, so a client named
          // `Acme<img src=x onerror=...>` fired on EVERY page that loads the
          // rail. Same value, same line, one escaped and one not.
          '<div class="vc-name" title="' + railEsc(cName) + '">' + railEsc(cName) + '</div>' +
          '<span class="vc-switch" onclick="vyneAuth.switchClient()">switch client</span>' +
        '</div>';
    }

    var rail = document.createElement("div");
    rail.id = "vyne-rail";
    rail.innerHTML =
      '<div class="vr-brand">Vynora <span>VYNE™</span></div>' +
      '<div class="vr-tag">AI Readiness · Cloud</div>' +
      clientBox +
      '<nav class="vr-nav">' +
        items.map(function (it) {
          return '<a class="vr-item' + (it.href === page ? " active" : "") + '" href="' + it.href + '">' +
            '<span class="vr-ico">' + it.icon + '</span>' + it.label + '</a>';
        }).join("") +
      '</nav>' +
      '<div class="vr-foot">' +
        '<div class="vr-user">' + railEsc(s.email || "") + (s.role ? " · " + railEsc(s.role) : "") + '</div>' +
        '<button class="vr-out" onclick="vyneAuth.signOut()">Sign out</button>' +
      '</div>';
    document.body.appendChild(rail);
    document.body.classList.add("vyne-railed");
  }

  window.vyneRail = { render: render };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
