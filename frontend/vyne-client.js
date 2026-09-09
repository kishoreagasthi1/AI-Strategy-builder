/**
 * vyne-client.js — the platform bridge every legacy module loads FIRST.
 *
 * Gives a module three things with almost no surgery to its own code:
 *
 *   1. vyneStore  — a synchronous localStorage-compatible facade
 *                   (getItem/setItem/removeItem) backed by the tenant-scoped
 *                   /api/module-state store. Hydrated synchronously at script
 *                   parse time so all existing module code — written against
 *                   synchronous localStorage — keeps working unchanged.
 *                   Writes are debounced and pushed to the server.
 *
 *   2. vyneLLM    — a drop-in replacement for the old
 *                   fetch('https://api.anthropic.com/v1/messages', options)
 *                   call sites. Accepts the same options object, sends the
 *                   payload to OUR gateway (/api/llm/generate), and returns a
 *                   Response-like object whose .json() resolves to an
 *                   Anthropic-shaped body ({content:[{type:'text',text}]}).
 *                   Surrounding module code doesn't change at all.
 *
 *   3. auth       — session from the shell (sessionStorage), redirect to
 *                   login when missing/expired. NO provider API key exists
 *                   anywhere in the browser.
 *
 * Note on the synchronous XHR used for hydration: it is deliberate. Legacy
 * modules read storage during parse; async hydration would race them. This
 * is the strangler-phase bridge — it disappears when modules are rebuilt on
 * async APIs in later phases.
 */
(function () {
  "use strict";

  var MODULE = (window.VYNE_MODULE || "shared").toLowerCase();
  var API_BASE = window.VYNE_API_BASE || "";

  /*
   * v5.34.0 (perf review P1, item 7) — the LLM/voice generation base.
   *
   * Long, multi-second generations share the DATA service's request budget:
   * a burst of them consumes an instance's request slots so /api/module-state
   * calls queue behind them — the app-wide slowness pattern the clustering
   * storm produced. The structural fix is to run generation on its OWN Cloud
   * Run service (its own concurrency/timeout/scaling) so data endpoints keep a
   * guaranteed lane. `deploy/deploy.sh llm` stands that service up.
   *
   * This is the single switch that points generation at it. It DEFAULTS to the
   * data API (window.VYNE_LLM_BASE unset → LLM_BASE === API_BASE), so nothing
   * changes until an operator sets window.VYNE_LLM_BASE to the vyne-llm URL.
   * Every generation call site (the vyneLLM gateway, voice tts/transcribe/live,
   * synthetic, solution-design/generate) routes through vyneLlmBase(); data
   * calls keep using API_BASE.
   */
  var LLM_BASE = window.VYNE_LLM_BASE || API_BASE;
  window.vyneLlmBase = function () { return LLM_BASE; };

  // ── Version (v5.29) ─────────────────────────────────────────────────────
  // Single source of truth for "what frontend build is this" — kept in
  // lockstep with backend/src/version.ts's VERSION by hand on every release
  // (test/version.test.ts fails the backend build if they drift apart).
  // about.html fetches GET /api/version and compares it against this so a
  // partial deploy (one side redeployed, the other not — see v5.27's
  // postmortem, where a stale frontend folder got redeployed silently) is
  // visible from inside the running app.
  var VYNE_VERSION = "5.34.21";
  window.VYNE_VERSION = VYNE_VERSION;

  // ── Client identity norm (v5.32.26) ─────────────────────────
  // Lowercase, strip non-alphanumerics, truncate. This is the key-derivation
  // scheme every module uses to partition workspace state by client, and it
  // MUST agree character-for-character with normClient() in
  // backend/src/auth/clients.ts — the server drops any key whose client
  // segment it cannot match against the caller's assignments, so a
  // disagreement presents as "my work vanished", silently, on reload.
  //
  // The limit was 30 until v5.32.26. At 30, two client names sharing a
  // 30-character alphanumeric prefix collapsed onto one identity and shared
  // one set of keys. Data written under the old rule is migrated server-side
  // on first read (migrateLegacyNormKeys in auth/clients.ts) — the browser
  // only ever writes the widened form.
  var VYNE_NORM_MAX = 100;
  var VYNE_NORM_LEGACY_MAX = 30;
  function vyneNormClient(n) {
    return String(n == null ? "" : n).toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, VYNE_NORM_MAX);
  }
  /** What a pre-v5.32.26 build would have derived. Diagnostics only. */
  function vyneLegacyNormClient(n) {
    return String(n == null ? "" : n).toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, VYNE_NORM_LEGACY_MAX);
  }
  window.VYNE_NORM_MAX = VYNE_NORM_MAX;
  window.vyneNormClient = vyneNormClient;
  window.vyneLegacyNormClient = vyneLegacyNormClient;

  /* ══ Per-client keys are addressed by ENGAGEMENT CODE (v5.32.97) ═════════
   *
   * Every per-client workspace key used to be suffixed with the client's
   * NORMALIZED NAME — vynora_briefing_meridianfoods. That is the root of the
   * whole rename saga: renaming a client was not a field update but a bulk
   * migration of a dozen key families, and every bug in it (v5.32.7 through
   * v5.32.96) was debris from one of those migrations — keys stranded under an
   * old norm, duplicate index entries, orphans blocking a rename back to a name
   * used before.
   *
   * ENG-XXXX-XXXX never changes, and since v5.32.96 it is a NOT NULL column on
   * `engagements`, minted server-side when the client is created. Addressed by
   * the code, a rename touches no keys at all.
   *
   * READS accept BOTH shapes, deliberately and for a long time. The server
   * migrates norm-suffixed keys to code-suffixed lazily, per tenant
   * (migrateNormKeysToCode in auth/clients.ts), so at any moment a given
   * workspace may hold either. A page that could only read the new shape would
   * show an empty briefing to anyone whose migration had not run — which is
   * the same class of "silently looks like a brand-new client" failure this
   * whole effort exists to remove.
   *
   * WRITES are always code-shaped when a code is known. Passing no code falls
   * back to the norm, so a client that somehow has none still works exactly as
   * it did before rather than writing to a key called "vynora_briefing_null".
   */
  function vyneClientKey(family, code, clientName) {
    if (code) return family + code;
    var n = vyneNormClient(clientName);
    return n ? family + n : null;
  }

  /** Read a per-client key, accepting either shape. Code first. */
  function vyneReadClientKey(family, code, clientName) {
    if (!window.vyneStore) return null;
    if (code) {
      var byCode = vyneStore.getItem(family + code);
      if (byCode != null) return byCode;
    }
    var n = vyneNormClient(clientName);
    return n ? vyneStore.getItem(family + n) : null;
  }

  /**
   * Write a per-client key under the code, and clear any copy left under the
   * old norm-shaped key so the two cannot diverge. Divergence between two
   * copies of one client's data is exactly what produced a briefing screen
   * showing one name while the rename prompt offered another.
   */
  function vyneWriteClientKey(family, code, clientName, value) {
    if (!window.vyneStore) return null;
    var key = vyneClientKey(family, code, clientName);
    if (!key) return null;
    vyneStore.setItem(key, value);
    var n = vyneNormClient(clientName);
    if (code && n && family + n !== key && vyneStore.getItem(family + n) != null) {
      vyneStore.removeItem(family + n);
    }
    return key;
  }

  window.vyneClientKey = vyneClientKey;
  window.vyneReadClientKey = vyneReadClientKey;
  window.vyneWriteClientKey = vyneWriteClientKey;

  // Small, unobtrusive corner badge on every page (including the
  // pre-login shell) linking to about.html — the fastest way to check
  // "is this actually the build I just deployed" without opening devtools.
  function addVersionBadge() {
    if (document.getElementById("vyne-version-badge")) return;
    var b = document.createElement("a");
    b.id = "vyne-version-badge";
    b.href = "about.html";
    b.textContent = "v" + VYNE_VERSION;
    b.title = "About VYNE — build & version info";
    b.style.cssText =
      "position:fixed;bottom:8px;right:10px;z-index:99998;font:600 10px 'Inter',system-ui,sans-serif;" +
      "color:#6C7783;text-decoration:none;opacity:.55;background:rgba(255,255,255,0.85);" +
      "padding:2px 9px;border-radius:10px;border:1px solid rgba(1,32,61,0.08);transition:opacity .15s";
    b.onmouseover = function () { b.style.opacity = "1"; };
    b.onmouseout = function () { b.style.opacity = ".55"; };
    document.body.appendChild(b);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addVersionBadge);
  } else {
    addVersionBadge();
  }

  /**
   * ── The version-mismatch banner (v5.33.4) ────────────────────────────────
   *
   * The frontend is static files on Firebase Hosting and the API is a Cloud Run
   * revision. They are deployed by two separate commands, so any of these leaves
   * a browser running one version against the other:
   *
   *   · only one of the two deploy steps was run (or one failed and was missed)
   *   · the browser is serving a cached page from before the last deploy
   *   · a tab has been open across a deploy
   *
   * That state is not theoretical here. A release went out where the API was on
   * 5.33.0 while the page said 5.32.97, and the symptom the consultant reported
   * was "I lose my work each time" — a full debugging session spent on a bug
   * that had already been fixed in code neither of us was running. The version
   * numbers were in the console the whole time and neither of us read them.
   *
   * So this reads them instead. It only ever speaks when the two disagree; a
   * matching pair is silent, which is the normal case and must stay invisible.
   *
   * Deliberately NOT blocking. It cannot know which side is stale, and a modal
   * that stops a consultant working mid-interview because a deploy is thirty
   * seconds from finishing would be worse than the problem. Reload is one click,
   * and dismissing it lasts for the tab.
   */
  function checkVersionSkew() {
    if (window.VYNE_SKIP_VERSION_CHECK) return;
    try {
      if (sessionStorage.getItem("vyne_version_skew_dismissed") === VYNE_VERSION) return;
    } catch (e) { /* private mode — just show it */ }
    fetch(API_BASE + "/api/version", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (v) {
        if (!v || !v.version || v.version === VYNE_VERSION) return;
        showVersionSkew(v.version);
      })
      /* A failed probe means the API is unreachable, which the save pill already
       * reports far more usefully than a version banner would. Silence. */
      .catch(function () {});
  }

  function showVersionSkew(apiVersion) {
    if (document.getElementById("vyne-version-skew")) return;
    var bar = document.createElement("div");
    bar.id = "vyne-version-skew";
    bar.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:99999;background:#B8972A;color:#01203D;" +
      "font:600 12px 'Inter',system-ui,sans-serif;padding:8px 14px;display:flex;" +
      "align-items:center;gap:12px;box-shadow:0 1px 6px rgba(1,32,61,0.25)";

    /* textContent, not innerHTML. apiVersion is a server-supplied string and
     * this file is the one place every page in the product loads — an unescaped
     * sink here would be on every screen at once. */
    var msg = document.createElement("span");
    msg.style.cssText = "flex:1";
    msg.textContent =
      "This page is running v" + VYNE_VERSION + " but the server is on v" + apiVersion +
      ". Reload to pick up the current build — until you do, what you see here may not " +
      "match what the server does.";

    var reload = document.createElement("button");
    reload.textContent = "Reload";
    reload.style.cssText =
      "background:#01203D;color:#fff;border:0;border-radius:6px;padding:5px 13px;" +
      "font:600 12px 'Inter',system-ui,sans-serif;cursor:pointer";
    reload.onclick = function () {
      /* Flush first. Reloading a page with queued edits still in the debounce
       * window is how work gets lost, and this banner exists to PREVENT a lost
       * session, not to cause one. */
      try {
        if (window.vyneStore && vyneStore.flush) {
          Promise.resolve(vyneStore.flush()).catch(function () {})
            .then(function () { location.reload(true); });
          return;
        }
      } catch (e) { /* fall through */ }
      location.reload(true);
    };

    var dismiss = document.createElement("button");
    dismiss.textContent = "Dismiss";
    dismiss.title = "Hide until this tab is reopened";
    dismiss.style.cssText =
      "background:transparent;color:#01203D;border:1px solid rgba(1,32,61,0.35);" +
      "border-radius:6px;padding:5px 11px;font:600 12px 'Inter',system-ui,sans-serif;cursor:pointer";
    dismiss.onclick = function () {
      try { sessionStorage.setItem("vyne_version_skew_dismissed", VYNE_VERSION); } catch (e) {}
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    };

    bar.appendChild(msg);
    bar.appendChild(reload);
    bar.appendChild(dismiss);
    document.body.appendChild(bar);
    console.warn("[vyne] VERSION SKEW — page v" + VYNE_VERSION + ", API v" + apiVersion);
  }
  window.vyneCheckVersionSkew = checkVersionSkew;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", checkVersionSkew);
  } else {
    checkVersionSkew();
  }

  // The legacy modules share one key space (the old app shared localStorage
  // across all pages — briefing data flows Pre-Engagement → Interview Agent →
  // Synthesis). So vyneStore persists under ONE namespace for every module;
  // MODULE is still used to attribute LLM calls for metering.
  var STORE_MODULE = "workspace";
  // Phase 1 wrote keys under 'pre_engagement' before the shared namespace
  // existed; hydration migrates them forward once (see hydrateSync).
  var LEGACY_STORE_MODULES = ["pre_engagement"];

  // ── Session ────────────────────────────────────────────────────────────────
  // Expiry policy: a login is good for at most 12 hours (absolute) and
  // 30 minutes without user activity (idle). Server tokens expire on their
  // own too — any 401 from the API also ends the session cleanly.
  var SESSION_ABS_MS = 12 * 60 * 60 * 1000;
  var SESSION_IDLE_MS = 30 * 60 * 1000;

  function expireSession() {
    try { sessionStorage.removeItem("vyne_session"); } catch (e) {}
    if (MODULE !== "shell") { window.location.href = "index.html?expired=1"; }
  }

  function readSession() {
    try {
      var s = JSON.parse(sessionStorage.getItem("vyne_session") || "null");
      if (!s) return null;
      var now = Date.now();
      if (s.at && now - s.at > SESSION_ABS_MS) { expireSession(); return null; }
      if (s.la && now - s.la > SESSION_IDLE_MS) { expireSession(); return null; }
      return s;
    } catch (e) {
      return null;
    }
  }

  // Activity tracking (throttled to one write a minute) + periodic sweep so
  // an abandoned tab signs itself out even without navigation.
  var _lastTouch = 0;
  function touchSession() {
    var now = Date.now();
    if (now - _lastTouch < 60000) return;
    _lastTouch = now;
    try {
      var s = JSON.parse(sessionStorage.getItem("vyne_session") || "null");
      if (s) { s.la = now; sessionStorage.setItem("vyne_session", JSON.stringify(s)); }
    } catch (e) {}
  }
  ["click", "keydown", "mousemove", "touchstart"].forEach(function (ev) {
    window.addEventListener(ev, touchSession, { passive: true });
  });
  setInterval(readSession, 60000); // readSession redirects when expired

  var session = readSession();
  var isShell = MODULE === "shell";
  if (!session && !isShell) {
    // Not signed in → back to the shell. Modules never run unauthenticated.
    window.location.href = "index.html";
    return;
  }

  function authHeaders() {
    var s = readSession();
    return s ? { authorization: "Bearer " + s.token } : {};
  }

  /**
   * v5.32.47: exposed so sibling modules loaded on the same page (vyne-live.js)
   * can authenticate without duplicating session handling. It must stay a
   * FUNCTION call rather than a cached object — readSession() enforces the 12h
   * absolute and 30min idle expiry on every call, and a cached header would
   * keep presenting a token this file has already decided is dead.
   *
   * This was missing when vyne-live.js first shipped: it called a helper that
   * did not exist, fell back to sending no Authorization header at all, and
   * every realtime session died at the server with `missing_token`.
   */
  window.vyneAuthHeaders = function () {
    return Object.assign({ "content-type": "application/json" }, authHeaders());
  };

  function onAuthFailure() {
    try { sessionStorage.removeItem("vyne_session"); } catch (e) {}
    window.location.href = "index.html?expired=1";
  }

  // ── vyneStore: synchronous store facade over /api/module-state ────────────
  var cache = {};
  /* Per-key versions from the last hydration (v5.32.58). Echoed back on write
   * so the server can refuse a save built on a stale read instead of letting
   * it silently overwrite a colleague's work. */
  var versions = {};
  var dirty = { sets: {}, deletes: {} };
  var flushTimer = null;

  function fetchStateSync(moduleName) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", API_BASE + "/api/module-state/" + moduleName, false); // sync on purpose
    var h = authHeaders();
    for (var k in h) xhr.setRequestHeader(k, h[k]);
    try {
      xhr.send(null);
    } catch (e) {
      console.error("[vyne] hydration failed:", e);
      return null;
    }
    if (xhr.status === 401 || xhr.status === 403) { onAuthFailure(); return null; }
    if (xhr.status !== 200) {
      console.error("[vyne] hydration HTTP " + xhr.status);
      return null;
    }
    try {
      var body = JSON.parse(xhr.responseText);
      versions = body.versions || {};
      return body.state || {};
    } catch (e) {
      return {};
    }
  }

  // Interviewee mode: hydrate from /api/interviews/mine/bootstrap instead of
  // the workspace (which interviewees cannot read). The server injects a
  // SANITIZED slice of the briefing plus the interviewee's own session state.
  var INTERVIEWEE = false;
  var MY_INTERVIEW = null;

  function hydrateIntervieweeSync() {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", API_BASE + "/api/interviews/mine/bootstrap", false);
    var h = authHeaders();
    for (var k in h) xhr.setRequestHeader(k, h[k]);
    try { xhr.send(null); } catch (e) { console.error("[vyne] bootstrap failed:", e); return; }
    if (xhr.status === 401 || xhr.status === 403) { onAuthFailure(); return; }
    if (xhr.status === 404) {
      alert("No interview is assigned to your account yet. Please contact your consultant.");
      window.location.href = "index.html";
      return;
    }
    if (xhr.status !== 200) { console.error("[vyne] bootstrap HTTP " + xhr.status); return; }
    try {
      var data = JSON.parse(xhr.responseText);
      MY_INTERVIEW = data.interview || null;
      cache = {};
      var k2;
      for (k2 in data.injected) cache[k2] = data.injected[k2];
      for (k2 in data.own) cache[k2] = data.own[k2]; // own state wins
    } catch (e) { cache = {}; }
  }

  // False until a hydration actually succeeds. Writes are refused while false:
  // an empty cache that only LOOKS empty must never be allowed to overwrite the
  // firm's real data.
  var HYDRATED = false;
  // v5.33.23 (performance): the workspace GET now fires ASYNC at boot so it
  // overlaps the (large) page parse instead of blocking it. Correctness is
  // unchanged because the SYNCHRONOUS path is kept as a fallback: the first store
  // access (ensureHydratedForRead below, called by every get/set) does the
  // guaranteed blocking fetch if the async one hasn't landed yet. So the store is
  // never read empty and the write-gate (HYDRATED) behaves exactly as before —
  // in the common case the fetch is simply hidden behind parse and nothing blocks.
  var _asyncHydrateXhr = null;
  var _hydrateFallbackDone = false;

  function showHydrationFailureBanner() {
    function paint() {
      if (document.getElementById("vyne-hydration-error")) return;
      var d = document.createElement("div");
      d.id = "vyne-hydration-error";
      d.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:99999;background:#9B1C1C;color:#fff;" +
        "font:600 13px 'Inter',system-ui,sans-serif;padding:10px 16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.2)";
      d.innerHTML = "\u26A0 Could not load your saved work \u2014 this page is read-only so nothing gets overwritten. " +
        "<a href=\"javascript:location.reload()\" style=\"color:#fff;text-decoration:underline\">Reload to try again</a>";
      document.body.appendChild(d);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", paint);
    else paint();
  }

  // One-time forward-migration of keys written before the shared namespace
  // existed (runs only when the workspace is empty). Merged into cache AND queued
  // to flush so they persist under 'workspace' from now on.
  function migrateLegacyIfEmpty() {
    if (Object.keys(cache).length !== 0) return;
    for (var i = 0; i < LEGACY_STORE_MODULES.length; i++) {
      var legacy = fetchStateSync(LEGACY_STORE_MODULES[i]);
      if (legacy && Object.keys(legacy).length) {
        for (var k in legacy) {
          cache[k] = legacy[k];
          dirty.sets[k] = legacy[k];
        }
        console.log("[vyne] migrated " + Object.keys(legacy).length +
          " keys from legacy namespace '" + LEGACY_STORE_MODULES[i] + "'");
        scheduleFlush();
        break;
      }
    }
  }

  // The guaranteed, synchronous hydration path — unchanged semantics from before.
  // v5.32.25 DATA LOSS: fetchStateSync returns null on ANY failure (500, 502,
  // timeout, dropped wifi); a null must stay distinguishable from an empty firm
  // so vyneStore refuses to write until a hydration succeeds — otherwise the
  // first save read-modify-writes the whole blob from an empty cache and wipes
  // every other client's work.
  function hydrateSyncFallback() {
    var hydratedState = fetchStateSync(STORE_MODULE);
    HYDRATED = hydratedState !== null;
    cache = hydratedState || {};
    if (!HYDRATED) {
      console.error("[vyne] could not load saved state — this session is READ-ONLY until it reconnects");
      showHydrationFailureBanner();
      return;
    }
    migrateLegacyIfEmpty();
  }

  // Called by every store access. Fast no-op once hydrated (or in shell /
  // interviewee mode). If the async fetch hasn't landed yet, do the blocking
  // fetch NOW so the caller never sees an empty store — identical to the old
  // boot behavior, just deferred to first-access instead of always-at-boot.
  function ensureHydratedForRead() {
    if (isShell || INTERVIEWEE || HYDRATED || _hydrateFallbackDone) return;
    _hydrateFallbackDone = true;
    if (_asyncHydrateXhr) { try { _asyncHydrateXhr.abort(); } catch (e) {} _asyncHydrateXhr = null; }
    hydrateSyncFallback();
  }

  // Boot: kick off the workspace fetch ASYNC so it overlaps page parse. If a
  // store access happens before it completes, ensureHydratedForRead() falls back
  // to the synchronous fetch (above) — so nothing regresses; in the common case
  // the async fetch simply finishes during parse and no access ever blocks.
  function startHydration() {
    if (isShell) return; // shell doesn't need module state
    var s = readSession();
    INTERVIEWEE = !!(s && s.role === "interviewee");
    if (INTERVIEWEE) { hydrateIntervieweeSync(); HYDRATED = true; return; } // small, different endpoint — stays sync
    var xhr = new XMLHttpRequest();
    _asyncHydrateXhr = xhr;
    xhr.open("GET", API_BASE + "/api/module-state/" + STORE_MODULE, true); // async
    var h = authHeaders();
    for (var k in h) xhr.setRequestHeader(k, h[k]);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      _asyncHydrateXhr = null;
      if (HYDRATED || _hydrateFallbackDone) return; // a read already ran the sync fallback
      if (xhr.status === 401 || xhr.status === 403) { onAuthFailure(); return; }
      if (xhr.status !== 200) { console.error("[vyne] hydration HTTP " + xhr.status); showHydrationFailureBanner(); return; }
      var state = null;
      try { var body = JSON.parse(xhr.responseText); versions = body.versions || {}; state = body.state || {}; } catch (e) { state = null; }
      if (state === null) { showHydrationFailureBanner(); return; }
      HYDRATED = true;
      cache = state;
      migrateLegacyIfEmpty();
    };
    try { xhr.send(null); } catch (e) { _asyncHydrateXhr = null; }
  }

  // ── Save indicator (v5.32.7) ────────────────────────────────────────────
  // vyneStore has always saved to Postgres automatically — but silently, with
  // no on-screen sign that it happened. That silence is exactly what led a
  // consultant to assume module data "only goes to a JSON file" and go
  // looking for a save button that didn't need to exist. This is a small,
  // honest status pill reflecting the REAL state of scheduleFlush()/flush()
  // — not a fake "Saved" that always shows regardless of what's happening.
  var saveIndicatorEl = null;
  var saveIndicatorHideTimer = null;
  function ensureSaveIndicator() {
    if (saveIndicatorEl || isShell) return saveIndicatorEl;
    var el = document.createElement("div");
    el.id = "vyne-save-indicator";
    el.style.cssText =
      "position:fixed;bottom:8px;right:66px;z-index:99998;font:600 10px 'Inter',system-ui,sans-serif;" +
      "padding:2px 9px;border-radius:10px;border:1px solid transparent;transition:opacity .2s;" +
      "display:flex;align-items:center;gap:5px;pointer-events:none;opacity:0";
    var dot = document.createElement("span");
    dot.style.cssText = "width:6px;height:6px;border-radius:50%;flex-shrink:0";
    var label = document.createElement("span");
    el.appendChild(dot);
    el.appendChild(label);
    el._dot = dot;
    el._label = label;
    if (document.body) document.body.appendChild(el);
    else document.addEventListener("DOMContentLoaded", function () { document.body.appendChild(el); });
    saveIndicatorEl = el;
    return el;
  }
  // state: 'pending' (edits queued) | 'saving' (request in flight) |
  //        'saved' (confirmed, fades out) | 'error' (flush failed — stays
  //        visible until the next successful flush, deliberately not silent)
  function setSaveIndicator(state) {
    var el = ensureSaveIndicator();
    if (!el) return;
    if (saveIndicatorHideTimer) { clearTimeout(saveIndicatorHideTimer); saveIndicatorHideTimer = null; }
    var styles = {
      pending: { bg: "rgba(184,151,42,0.08)", border: "rgba(184,151,42,0.25)", dot: "#B8973A", text: "Unsaved changes" },
      saving: { bg: "rgba(55,138,221,0.08)", border: "rgba(55,138,221,0.25)", dot: "#378ADD", text: "Saving…" },
      saved: { bg: "rgba(47,125,79,0.08)", border: "rgba(47,125,79,0.25)", dot: "#2F7D4F", text: "Saved" },
      error: { bg: "rgba(176,50,75,0.09)", border: "rgba(176,50,75,0.3)", dot: "#B0324B", text: "Not saved — retrying" },
      /* v5.32.58: a state for "this will never succeed". "Retrying" was shown
       * for refusals nothing was retrying, so the one honest label was being
       * spent on the dishonest case. */
      rejected: { bg: "rgba(176,50,75,0.14)", border: "rgba(176,50,75,0.45)", dot: "#B0324B", text: "Not saved — reload to recover" },
    }[state];
    if (!styles) return;
    el.style.background = styles.bg;
    el.style.borderColor = styles.border;
    el._dot.style.background = styles.dot;
    el._label.textContent = styles.text;
    el._label.style.color = styles.dot;
    el.style.opacity = "1";
    if (state === "saved") {
      saveIndicatorHideTimer = setTimeout(function () { el.style.opacity = "0"; }, 2200);
    }
  }

  function scheduleFlush() {
    setSaveIndicator("pending");
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 800);
  }

  function flush() {
    flushTimer = null;
    var sets = dirty.sets;
    var deletes = Object.keys(dirty.deletes);
    if (Object.keys(sets).length === 0 && deletes.length === 0) return;
    dirty = { sets: {}, deletes: {} };
    setSaveIndicator("saving");
    var endpoint = INTERVIEWEE
      ? "/api/interviews/mine/state"       // private per-interview namespace
      : "/api/module-state/" + STORE_MODULE;
    /*
     * v5.33.1 DATA LOSS — keepalive is now CONDITIONAL on the payload size.
     *
     * `keepalive: true` was set on every flush. Chrome enforces a hard 64 KiB
     * limit on the body of a keepalive request and rejects anything larger IN
     * THE BROWSER, before it is sent — which surfaces as
     * `TypeError: Failed to fetch`, not as an HTTP status. The .catch below
     * then re-queues and retries the same oversized payload, forever, at
     * increasing backoff. Every save after that point is lost, silently, and
     * the pill reads "Not saved — retrying" while nothing can ever succeed.
     *
     * It only bites once a workspace grows past 64 KiB, which is why it
     * presents as "this used to work". vynora_roadmap_state alone carries every
     * client's partition and is rewritten whole on each edit, so a large
     * engagement crosses the line and then never saves again.
     *
     * keepalive only buys anything when the page is going away, and the unload
     * path (flushNow) has its own handling. For an ordinary debounced flush the
     * page is alive and a normal fetch completes perfectly well — so use
     * keepalive only while the body is safely under the limit.
     */
    var payload = JSON.stringify({ sets: sets, deletes: deletes,
                                   expectedVersions: versionsFor(sets) });
    var KEEPALIVE_MAX = 60 * 1024;   // 64 KiB spec limit, with headroom
    fetch(API_BASE + endpoint, {
      method: "PUT",
      headers: Object.assign({ "content-type": "application/json" }, authHeaders()),
      body: payload,
      keepalive: payload.length < KEEPALIVE_MAX,
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { onAuthFailure(); return; }
        if (r.status === 409) return r.json().then(function (b) { onVersionConflict(b, sets, deletes); });
        if (!r.ok) {
          /*
           * v5.32.58 DATA LOSS. This used to just `return`.
           *
           * `dirty` is cleared BEFORE the request goes out, and only the
           * network-level .catch below re-queued. So a 429 — reachable at the
           * 300/min per-user baseline with a couple of tabs flushing every
           * 800ms — or a 500, or a transient 502 from a cold Cloud Run
           * instance, DISCARDED the edits permanently. The save pill read
           * "Not saved — retrying" the whole time, which was simply untrue:
           * nothing was retrying. A consultant watched a reassuring label
           * while their work evaporated.
           *
           * Re-queue on anything that could plausibly succeed later. A 4xx
           * that is not auth (a validation refusal) will never succeed on
           * retry, so that one is surfaced rather than looped forever.
           */
          console.error("[vyne] state flush HTTP " + r.status);
          var retryable = r.status === 429 || r.status >= 500;
          if (retryable) {
            requeue(sets, deletes);
            setSaveIndicator("error");           // label matches reality now
            scheduleRetry();
          } else {
            setSaveIndicator("rejected");
          }
          return;
        }
        retryDelay = 0;
        setSaveIndicator("saved");
      })
      .catch(function (e) {
        console.error("[vyne] state flush failed:", e);
        setSaveIndicator("error");
        requeue(sets, deletes);
        scheduleRetry();
      });
  }

  /** The versions we believe we are writing on top of, for these keys only. */
  function versionsFor(sets) {
    var out = {};
    for (var k in sets) if (Object.prototype.hasOwnProperty.call(versions, k)) out[k] = versions[k];
    return out;
  }

  /**
   * Someone else saved this key while we were editing it (v5.32.58).
   *
   * The old behaviour was to win the race by accident and destroy their work.
   * Neither "always win" nor "always lose" is right, so: adopt the server's
   * current value as the new base, keep OUR edit queued on top of it, and
   * retry once against the version we now know about. Whoever saves last still
   * wins the field they touched, but the other person's other changes survive
   * instead of being replaced wholesale by a stale snapshot.
   *
   * The consultant is told, because two people editing one client's synthesis
   * at once is worth knowing about even when the merge works.
   */
  function onVersionConflict(body, sets, deletes) {
    var conflicts = (body && body.conflicts) || [];
    // Accept any version the server did apply, so the un-conflicted half is
    // not retried on a now-stale number.
    var applied = (body && body.versions) || {};
    for (var ok in applied) versions[ok] = applied[ok];

    var retry = {};
    conflicts.forEach(function (c) {
      versions[c.key] = c.version;   // we are now based on THEIR value
      cache[c.key] = c.value;        // and our reads see it
      if (Object.prototype.hasOwnProperty.call(sets, c.key)) retry[c.key] = sets[c.key];
    });
    if (Object.keys(retry).length) {
      requeue(retry, []);
      setSaveIndicator("error");
      scheduleRetry();
    }
    try {
      if (window.dispatchEvent) {
        window.dispatchEvent(new CustomEvent("vyne:conflict", {
          detail: { keys: conflicts.map(function (c) { return c.key; }) },
        }));
      }
    } catch (e) {}
    console.warn("[vyne] another user saved these keys first; re-applying on top:",
      conflicts.map(function (c) { return c.key; }).join(", "));
  }

  /** Put unsaved work back on the queue without clobbering newer edits. */
  function requeue(sets, deletes) {
    for (var k in sets) if (!(k in dirty.sets)) dirty.sets[k] = sets[k];
    deletes.forEach(function (k) { dirty.deletes[k] = true; });
  }

  /* Back off rather than hammering: a 429 answered with an immediate retry
   * every 800ms is what caused the 429. Capped so a long outage still ends in
   * a save when connectivity returns rather than an hour-long gap. */
  var retryDelay = 0;
  function scheduleRetry() {
    retryDelay = retryDelay ? Math.min(retryDelay * 2, 30000) : 1000;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, retryDelay);
  }

  // Guaranteed delivery on navigation: if writes are still debounced when
  // the page unloads, push them synchronously (the strangler-phase
  // counterpart of the deliberate sync hydration). visibilitychange also
  // triggers a normal keepalive flush as an early, non-blocking attempt.
  function flushNow() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    var sets = dirty.sets;
    var deletes = Object.keys(dirty.deletes);
    if (Object.keys(sets).length === 0 && deletes.length === 0) return;
    dirty = { sets: {}, deletes: {} };
    var endpoint = INTERVIEWEE
      ? "/api/interviews/mine/state"
      : "/api/module-state/" + STORE_MODULE;
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("PUT", API_BASE + endpoint, false); // sync: completes before unload
      xhr.setRequestHeader("content-type", "application/json");
      var s0 = readSession();
      if (s0) xhr.setRequestHeader("authorization", "Bearer " + s0.token);
      /*
       * v5.32.95 — expectedVersions is sent HERE TOO.
       *
       * It was omitted, which made the unload path a FORCE WRITE: no version
       * check, so the server could not refuse it. That is how a rename got
       * undone by the browser that had just made it. detectRoundMode() queues
       * vynora_engagement_<CODE> on every call, so a rename landing inside the
       * 800ms debounce leaves a PRE-rename copy of that record in `dirty`;
       * rehydrate() calls flushNow() first; and this line wrote that stale
       * record over the freshly renamed one. The engagement record then sat one
       * name behind the index, the briefing key, the interviews and the
       * engagements row — which is the split every previous fix was trying to
       * explain, and the reason the Rename prompt offered a name two hops old.
       *
       * Losing one debounce window on unload is a far smaller harm than
       * silently overwriting whatever the server has. A refusal here is the
       * system working.
       */
      xhr.send(JSON.stringify({ sets: sets, deletes: deletes,
                                expectedVersions: versionsFor(sets) }));
      /* v5.32.58: the status was never checked here. This is the LAST chance
       * to save before the page dies, and a failure was silent and total —
       * the whole debounce window gone with no trace. Putting the work back on
       * the queue means it survives into the next page load's flush if the
       * store is still in memory, and at minimum the failure is visible. */
      if (xhr.status && (xhr.status < 200 || xhr.status >= 300)) {
        console.error("[vyne] unload flush HTTP " + xhr.status);
        requeue(sets, deletes);
      }
    } catch (e) {
      requeue(sets, deletes);
      // Sync XHR refused (some browsers on unload): best-effort keepalive.
      try {
        var lastBody = JSON.stringify({ sets: sets, deletes: deletes,
                                        expectedVersions: versionsFor(sets) });
        fetch(API_BASE + endpoint, {
          method: "PUT",
          headers: Object.assign({ "content-type": "application/json" }, authHeaders()),
          // Same reasoning as the sync attempt above: never force-write.
          body: lastBody,
          /* Over 64 KiB the browser refuses a keepalive request outright, so
           * sending it that way guarantees the loss it is meant to prevent.
           * Without keepalive the request may be cancelled by the unload — a
           * chance of delivery beats a certainty of rejection. */
          keepalive: lastBody.length < 60 * 1024,
        });
      } catch (e2) { /* nothing left to try */ }
    }
  }
  window.addEventListener("pagehide", flushNow);
  window.addEventListener("beforeunload", flushNow);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });

  window.vyneStore = {
    getItem: function (key) {
      ensureHydratedForRead();
      return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
    },
    setItem: function (key, value) {
      ensureHydratedForRead();
      // See HYDRATED above: writing from a cache we never successfully filled
      // is how the whole firm's roadmap state gets replaced by one engagement.
      if (!HYDRATED && !INTERVIEWEE) { console.warn("[vyne] refusing to save '" + key + "' — state was never loaded"); return; }
      value = String(value);
      cache[key] = value;
      dirty.sets[key] = value;
      delete dirty.deletes[key];
      scheduleFlush();
    },
    removeItem: function (key) {
      ensureHydratedForRead();
      if (!HYDRATED && !INTERVIEWEE) { console.warn("[vyne] refusing to delete '" + key + "' — state was never loaded"); return; }
      delete cache[key];
      delete dirty.sets[key];
      dirty.deletes[key] = true;
      scheduleFlush();
    },
    /** Did saved state actually load? Modules can use this to disable saving UI. */
    isHydrated: function () { ensureHydratedForRead(); return HYDRATED || INTERVIEWEE; },
    /** Full localStorage-compatible enumeration surface. */
    keys: function () { ensureHydratedForRead(); return Object.keys(cache); },
    key: function (i) { ensureHydratedForRead(); return Object.keys(cache)[i] ?? null; },
    /** Force-push pending writes now (used on pagehide). */
    flush: flush,
    /*
     * Re-read the whole cache from the server (v5.32.91).
     *
     * There was no way to do this, and PATCH /api/clients/rename needed one.
     * That endpoint rewrites the workspace keys server-side, in one
     * transaction, behind this store's back. Everything here then goes stale
     * at once, in three compounding ways:
     *
     *   · `cache` still holds the OLD key names and lacks the new ones, so the
     *     renaming page looks the client up under the new name, finds nothing,
     *     and falls back to "no engagement" — which is why the name appeared
     *     to revert on screen
     *   · `versions` are stale, so the next flush 409s — the red "Not saved"
     *     pill, with nothing the consultant did to explain it
     *   · worst, the stale cache is still authoritative locally, so a
     *     subsequent write pushes the OLD keys back to the server. A second
     *     rename then fights a cache that is re-asserting the first state,
     *     which is why renaming BACK did not reach the tracker either.
     *
     * Pending writes are flushed first, synchronously, rather than discarded:
     * they were made against the pre-rename key names and are the
     * consultant's own work. Losing them silently would be a worse bug than
     * the one being fixed. Returns false if the re-read failed, in which case
     * the caller must not treat local state as authoritative.
     */
    rehydrate: function (opts) {
      if (INTERVIEWEE) return false;   // different endpoint; see hydrateIntervieweeSync
      /*
       * v5.32.95 — a caller that has just had the SERVER rewrite these keys can
       * say so, and the queued writes for them are discarded rather than
       * flushed.
       *
       * Flushing them is not a merge, it is a revert: they were computed
       * against names and keys the server no longer has, so the best case is
       * that they are refused and the worst case (before the fix above) is that
       * they overwrite the rename. Dropping them costs at most the last 800ms
       * of edits to THAT client, which were addressed to an identity that no
       * longer exists; everything queued for other clients still flushes
       * normally.
       */
      var drop = opts && typeof opts.drop === "function" ? opts.drop : null;
      if (drop) {
        var k;
        for (k in dirty.sets) if (drop(k)) delete dirty.sets[k];
        for (k in dirty.deletes) if (drop(k)) delete dirty.deletes[k];
      }
      flushNow();
      var fresh = fetchStateSync(STORE_MODULE);
      if (fresh === null) return false;   // versions untouched on failure
      cache = fresh;
      dirty = { sets: {}, deletes: {} };
      HYDRATED = true;
      return true;
    },
  };
  Object.defineProperty(window.vyneStore, "length", {
    get: function () { return Object.keys(cache).length; },
  });

  /* v5.32.59 (L2). A SECOND pair of listeners used to live here — another
   * `pagehide` → flush() and an identical `visibilitychange` handler — left
   * over from before flushNow() existed. Both events were therefore handled
   * twice.
   *
   * That was merely wasteful until v5.32.58 added optimistic concurrency.
   * Since then the synchronous flushNow() on pagehide drains the queue and
   * bumps every key's version, and the async flush() that fired immediately
   * after it re-sent the same payload carrying the version it read BEFORE
   * that bump — a guaranteed 409 against our own write, on a page that is
   * unloading, which the conflict handler answers by re-hydrating and
   * re-queueing work nobody will ever be around to send.
   *
   * The registrations above cover both events exactly once. */

  // ── Client cost-recovery billing (v5.27) ──────────────────────────────────
  // Best-effort attribution, attached centrally so individual call sites
  // across every module never need to know about billing at all.
  //   Interviewee  → their own interview's client (MY_INTERVIEW.client_name).
  //   Consultant/owner → the session's currently active client, IF one is
  //     chosen. Deliberately omitted when viewing "all clients"
  //     (activeClient null/undefined) — there is no single client to charge.
  // See backend/src/routes/billing.ts for how this is aggregated into
  // statements; usage_events.client_name/client_norm is where it lands.
  function billingClientName() {
    if (INTERVIEWEE) return (MY_INTERVIEW && MY_INTERVIEW.client_name) || undefined;
    var s = readSession();
    return s && s.activeClient ? s.activeClient : undefined;
  }

  // ── vyneLLM: drop-in for fetch('https://api.anthropic.com/...', options) ──
  // ── VYNE_ROLE_WEIGHTS: the one role-weighting table ──────────────────────
  //
  // v5.32.25. There were SIX copies: synthesis.html lines 629, 677, 1034 and
  // 2756, interview_agent.html:2373, and backend engagementMerge.ts. The
  // line-629 copy carries ten roles; every other copy carries four or five and
  // falls back to 0.5 for anything missing.
  //
  // That meant the Synthesis dashboard and the number actually PERSISTED to
  // the engagement disagreed for any CFO, CHRO, IT_Director, VP_Sales,
  // Operations_Manager or General_Counsel interview. A D7 with CHRO=5.0 and
  // CEO=1.0 reads 3.0 "AI Capable" on screen and 2.3 "AI Exploring" in the
  // stored score that /api/scorecard serves and that the Solution Design
  // generator is told is the client's "measured" maturity.
  //
  // This copy is the ten-role one — the superset. The backend keeps its own
  // copy for server-side merges (it cannot import a browser script); a test
  // asserts the two stay identical.
  var VYNE_ROLE_WEIGHTS = {
    D1:{CDO:1.0,CTO:0.8,IT_Director:0.7,CEO:0.4,CFO:0.4,COO:0.5,CHRO:0.3,VP_Sales:0.3,Operations_Manager:0.3,General_Counsel:0.2},
    D2:{CTO:1.0,IT_Director:0.9,CDO:0.7,CEO:0.3,CFO:0.3,COO:0.4,CHRO:0.2,VP_Sales:0.2,Operations_Manager:0.4,General_Counsel:0.1},
    D3:{CEO:1.0,CDO:0.9,CFO:0.8,CTO:0.7,COO:0.6,CHRO:0.4,VP_Sales:0.5,IT_Director:0.3,Operations_Manager:0.3,General_Counsel:0.3},
    D4:{CHRO:1.0,CDO:0.7,CEO:0.6,COO:0.5,CTO:0.5,CFO:0.4,VP_Sales:0.4,IT_Director:0.4,Operations_Manager:0.6,General_Counsel:0.2},
    D5:{COO:1.0,Operations_Manager:0.9,CFO:0.7,CEO:0.5,CDO:0.5,CTO:0.5,VP_Sales:0.6,CHRO:0.4,IT_Director:0.4,General_Counsel:0.2},
    D6:{General_Counsel:1.0,CDO:0.9,CTO:0.8,IT_Director:0.8,CEO:0.5,CFO:0.6,COO:0.4,CHRO:0.3,VP_Sales:0.2,Operations_Manager:0.3},
    D7:{CEO:1.0,CHRO:1.0,COO:0.7,CDO:0.6,CTO:0.5,CFO:0.4,VP_Sales:0.5,Operations_Manager:0.8,IT_Director:0.3,General_Counsel:0.2}
  };
  window.VYNE_ROLE_WEIGHTS = VYNE_ROLE_WEIGHTS;

  /* ── Who said it (v5.32.86) ────────────────────────────────────────────────
   *
   * One role can be held by several people. A client with divisional COOs has
   * three, and every layer above the raw interview list used the role STRING as
   * if it were an identity: conflicts read "the COO scored 4.5 while the COO
   * scored 2.1", two COOs could not corroborate each other, the refresh context
   * kept whichever one was written last, and a refresh interview was recorded
   * against the literal name "COO".
   *
   * These live here, in the file every module page already loads, rather than
   * being defined once per page. This codebase has been bitten before by two
   * copies of one rule drifting apart — findings.ts and vyne-findings.js need a
   * parity test to stay honest — and there is no reason to create a third pair.
   */

  /** Stable identity for one interviewee within an engagement. */
  window.vynePersonKey = function (iv) {
    if (!iv) return "";
    var role = String(iv.role || "").trim();
    var name = String(iv.interviewee || iv.name || "").trim();
    return name ? role + "||" + name : role;
  };

  /**
   * Display label: the role alone, or "Role (Person)" where that role is held
   * by more than one NAMED person in this roster.
   *
   * Only widened where it has to be. Naming everyone would churn every string
   * in the product and read as noise on the ninety per cent of engagements with
   * one person per role. An unnamed interview keeps the bare role, because
   * there is nothing to disambiguate it with.
   */
  window.vyneLabelFor = function (interviews) {
    var byRole = {};
    var list = Object.prototype.toString.call(interviews) === "[object Array]" ? interviews : [];
    for (var i = 0; i < list.length; i++) {
      var iv = list[i]; if (!iv) continue;
      var role = String(iv.role || "").trim();
      var name = String(iv.interviewee || iv.name || "").trim();
      if (!role || !name) continue;
      if (!Object.prototype.hasOwnProperty.call(byRole, role)) byRole[role] = [];
      if (byRole[role].indexOf(name) === -1) byRole[role].push(name);
    }
    return function (iv) {
      if (!iv) return "";
      var role = String(iv.role || "").trim();
      var name = String(iv.interviewee || iv.name || "").trim();
      if (!role) return name;
      if (!name) return role;
      var held = Object.prototype.hasOwnProperty.call(byRole, role) ? byRole[role].length : 0;
      return held > 1 ? role + " (" + name + ")" : role;
    };
  };

  /** Does any role in this roster have more than one named holder? */
  window.vyneHasSharedRole = function (interviews) {
    var label = window.vyneLabelFor(interviews);
    var list = Object.prototype.toString.call(interviews) === "[object Array]" ? interviews : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && label(list[i]).indexOf(" (") !== -1) return true;
    }
    return false;
  };

  // Roles arrive as bare keys ("COO") from invites and as display labels
  // ("COO / VP Operations") from synthetic and imported engagements. Looking a
  // display label up in the table missed every time and silently returned the
  // 0.5 default, turning the whole weighting scheme into an unweighted mean.
  window.vyneRoleWeight = function (dim, role) {
    var table = VYNE_ROLE_WEIGHTS[dim] || {};
    var r = String(role || "").trim();
    if (Object.prototype.hasOwnProperty.call(table, r)) return table[r];
    try {
      if (window.VyneRoleCanon && typeof window.VyneRoleCanon.roleKey === "function") {
        var k = window.VyneRoleCanon.roleKey(r);
        if (k && Object.prototype.hasOwnProperty.call(table, k)) return table[k];
      }
    } catch (e) {}
    // Last resort: match on the part before a separator ("COO / VP Ops" -> "COO").
    var head = r.split(/[\/(—-]/)[0].trim().replace(/\s+/g, "_");
    if (Object.prototype.hasOwnProperty.call(table, head)) return table[head];
    return 0.5;
  };

  // ── vyneParseJson: the one tolerant JSON parser ──────────────────────────
  //
  // v5.32.23. Before this there were four, in four files, with four different
  // capabilities and two of them sharing a name:
  //
  //   interview_agent.html  previewSafeParse      fences + shrinking-tail retry
  //   roadmap.html          safeParseJsonObject   brace balancing, NO fence strip
  //   solution_design.html  safeParseJsonObject   fences + leading prose
  //   backend               parseJsonLoose (x2)   one tolerant, one bare
  //
  // roadmap.html also *called* previewSafeParse, which is defined only in
  // interview_agent.html — so every AI dependency generation threw a
  // ReferenceError, had it swallowed by a catch, and rendered "No hard
  // prerequisites identified — this can proceed on its own". A wrong answer
  // presented confidently, after paying for the call. That is the cost of
  // four near-copies: the gaps between them are invisible until one bites.
  //
  // Ten further call sites used a bare JSON.parse with no tolerance at all,
  // two of which failed silently (static benchmarks shown as if AI-refreshed;
  // interview scores discarded by an empty catch).
  //
  // Handles, in order: markdown fences, conversational preamble/postamble,
  // trailing commas, and a response cut off mid-object — which it repairs by
  // balancing braces, ignoring any that appear inside string values.
  function vyneParseJsonDetailed(text) {
    var out = { value: null, ok: false, salvaged: false, truncated: false, reason: "" };
    if (text == null || text === "") { out.reason = "empty response"; return out; }
    var clean = String(text).trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    try { out.value = JSON.parse(clean); out.ok = true; return out; } catch (e) {}

    // v5.32.25. This used to take the FIRST "{" or "[" of either kind and treat
    // it as the document start. A bracket anywhere in the preamble — and models
    // write "Based on the findings [D1, D3], here is the roadmap:" constantly —
    // started the parse mid-prose, so perfectly valid JSON came back reported
    // as truncated.
    //
    // Fixing that naively introduced the opposite bug: for a genuinely
    // truncated document, scanning forward finds an INNER object that parses
    // cleanly and returns it as though it were the whole thing. Ordering alone
    // can't separate the two cases, so both strategies run and the larger
    // result wins — which is the right answer for each.
    var starts = [];
    for (var si = 0; si < clean.length && starts.length < 12; si++) {
      if (clean[si] === "{" || clean[si] === "[") starts.push(si);
    }
    if (!starts.length) { out.reason = "no JSON object or array in the response"; return out; }

    // Strategy A — a complete document with prose around it.
    var fromProse = null;
    for (var sj = 0; sj < starts.length; sj++) {
      var cand = clean.slice(starts[sj]);
      var lastC = Math.max(cand.lastIndexOf("}"), cand.lastIndexOf("]"));
      if (lastC <= 0) continue;
      var trial = cand.slice(0, lastC + 1);
      try { fromProse = JSON.parse(trial); break; } catch (e) {}
      try { fromProse = JSON.parse(trial.replace(/,(\s*[}\]])/g, "$1")); break; } catch (e) {}
    }

    // Strategy B — cut off mid-document: drop the incomplete tail and close
    // whatever is still open, walking string-aware so braces inside values and
    // escaped quotes don't confuse the depth count.
    var fromRepair = repairTruncated(clean.slice(starts[0]));

    var aLen = fromProse === null ? -1 : JSON.stringify(fromProse).length;
    var bLen = fromRepair === null ? -1 : JSON.stringify(fromRepair).length;
    if (aLen < 0 && bLen < 0) {
      out.truncated = !/[}\]]\s*$/.test(clean);
      out.reason = out.truncated
        ? "the response was cut off before the document was finished"
        : "the model did not return a parseable JSON object";
      return out;
    }
    if (bLen > aLen) {
      out.value = fromRepair; out.ok = true; out.salvaged = true; out.truncated = true;
      out.reason = "the response was cut off; a partial document was recovered";
      return out;
    }
    out.value = fromProse; out.ok = true; out.salvaged = true;
    return out;
  }

  /** Drop an incomplete tail and balance what's still open. null if nothing survives. */
  function repairTruncated(body) {
    var inStr = false, esc = false, depthCurly = 0, depthSq = 0, lastGood = -1, i, ch;
    for (i = 0; i < body.length; i++) {
      ch = body[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depthCurly++;
      else if (ch === "}") { depthCurly--; if (depthCurly >= 0) lastGood = i; }
      else if (ch === "[") depthSq++;
      else if (ch === "]") { depthSq--; if (depthSq >= 0) lastGood = i; }
    }

    if (lastGood >= 0) {
      var head = body.slice(0, lastGood + 1).replace(/,\s*$/, "");
      inStr = false; esc = false; depthCurly = 0; depthSq = 0;
      for (i = 0; i < head.length; i++) {
        ch = head[i];
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === "{") depthCurly++; else if (ch === "}") depthCurly--;
        else if (ch === "[") depthSq++; else if (ch === "]") depthSq--;
      }
      var repaired = head;
      while (depthSq-- > 0) repaired += "]";
      while (depthCurly-- > 0) repaired += "}";
      try { return JSON.parse(repaired); } catch (e) {}
    }

    // A FLAT object cut mid-value ({"a":1,"b":"tru) has no closing brace at
    // all, so there is no recovery point above. Fall back to the last complete
    // key/value pair.
    var depth2 = 0, inS2 = false, esc2 = false, lastComma = -1;
    for (i = 0; i < body.length; i++) {
      ch = body[i];
      if (esc2) { esc2 = false; continue; }
      if (ch === "\\") { esc2 = true; continue; }
      if (ch === '"') { inS2 = !inS2; continue; }
      if (inS2) continue;
      if (ch === "{" || ch === "[") depth2++;
      else if (ch === "}" || ch === "]") depth2--;
      else if (ch === "," && depth2 === 1) lastComma = i;
    }
    if (lastComma > 0) {
      try { return JSON.parse(body.slice(0, lastComma) + (body[0] === "[" ? "]" : "}")); } catch (e) {}
    }
    return null;
  }

  // Drop-in for the old helpers: value or null.
  function vyneParseJson(text) { return vyneParseJsonDetailed(text).value; }

  window.vyneParseJson = vyneParseJson;
  window.vyneParseJsonDetailed = vyneParseJsonDetailed;
  // Back-compat aliases so the existing call sites keep working unchanged —
  // and so roadmap.html's previously-undefined previewSafeParse resolves.
  window.previewSafeParse = vyneParseJson;
  window.safeParseJsonObject = function (text) { return vyneParseJson(text); };

  // ── vyneFit: fit a collection into a prompt without losing anything ──────
  //
  // v5.32.23. Seven prompts in this app embedded `array.map(...).join('')` with
  // no bound. The worst, roadmap.html's narrative synthesis, is O(gaps x
  // initiatives) — each shared gap also enumerates every initiative it blocks —
  // and reaches ~100k tokens on a large engagement. Another, the dependency
  // generator, inlines every OTHER selected use case into each call and is then
  // invoked once per use case: quadratic in the size of the selection.
  //
  // The instinct is to cap with .slice(0, N). That is what was there before,
  // and removing those caps was a deliberate product decision — the consultant
  // asked for completeness, and silently dropping the 13th of 40 findings is
  // exactly the kind of invisible loss that erodes trust in the output.
  //
  // So: everything that fits goes in verbatim, and whatever doesn't is
  // SUMMARISED by a real model call rather than truncated. The caller gets back
  // what was kept, what was condensed, and the summary itself, so the UI can
  // say so plainly. Nothing is ever dropped without the consultant being told.
  //
  //   items     array of anything
  //   renderFn  item -> the exact string that would have gone into the prompt
  //   opts.budgetChars   soft ceiling for this block (default 24000, ~6k tokens)
  //   opts.minVerbatim   always keep at least this many verbatim (default 20)
  //   opts.label         what these are, for the summary prompt ("initiatives")
  //   opts.rank          optional comparator; highest-value items kept verbatim
  //
  // Returns { text, total, kept, summarised, summary, note, fitted }.
  function vyneFit(items, renderFn, opts) {
    opts = opts || {};
    var budget = opts.budgetChars || 24000;
    var minVerbatim = opts.minVerbatim == null ? 20 : opts.minVerbatim;
    var label = opts.label || "items";
    var list = (items || []).slice();
    if (opts.rank) { try { list.sort(opts.rank); } catch (e) {} }

    // v5.32.25: a renderFn that threw used to yield "" and get filtered out —
    // the item vanished, `total` under-reported it, and nothing said so. That is
    // exactly the silent loss this function exists to prevent, so a failure is
    // now a visible placeholder that still counts.
    var renderFailures = 0;
    var rendered = list.map(function (it) {
      try {
        var t = String(renderFn(it));
        return t.length ? t : null;
      } catch (e) {
        renderFailures++;
        return "  - [an item could not be rendered for this prompt]";
      }
    }).filter(function (t) { return t !== null; });

    var whole = rendered.join("\n");
    if (whole.length <= budget) {
      return Promise.resolve({
        text: whole, total: rendered.length, kept: rendered.length,
        summarised: 0, summary: "", note: "", fitted: false,
      });
    }

    // Fill to the budget, then hand the remainder to the model.
    // v5.32.25: the budget check used to be gated on `i >= minVerbatim`, so the
    // first N items went in REGARDLESS of size. roadmap.html's renderInit emits
    // a multi-line block per initiative carrying every gap, so 25 heavily-gapped
    // initiatives sailed past a 60k budget and rebuilt the ~100k-token prompt
    // this function was written to prevent — reporting fitted:false, so the UI
    // notice stayed hidden too. minVerbatim is now a floor on COUNT, not a
    // licence to ignore the ceiling: it still guarantees a minimum, but a single
    // oversized item can no longer blow the budget on its own.
    var kept = [], used = 0;
    var hardCeiling = budget * 2;   // absolute stop, even for the guaranteed items
    for (var i = 0; i < rendered.length; i++) {
      var len = rendered[i].length;
      if (used + len > hardCeiling) break;
      if (i >= minVerbatim && used + len > budget) break;
      kept.push(rendered[i]); used += len + 1;
    }
    var overflow = rendered.slice(kept.length);
    if (!overflow.length) {
      return Promise.resolve({
        text: kept.join("\n"), total: rendered.length, kept: kept.length,
        summarised: 0, summary: "", note: "", fitted: false,
      });
    }

    // The overflow can itself be enormous, so cap what goes INTO the summariser
    // — but say so in the note if we had to, rather than pretending otherwise.
    var SUMMARISER_INPUT_CAP = 120000;
    var overflowText = overflow.join("\n");
    var overflowTruncated = false;
    if (overflowText.length > SUMMARISER_INPUT_CAP) {
      overflowText = overflowText.slice(0, SUMMARISER_INPUT_CAP);
      overflowTruncated = true;
    }

    var prompt =
      "You are compressing part of a consulting dataset so it fits in another model's context.\n" +
      "Below are " + overflow.length + " " + label + " that could not be included in full.\n\n" +
      "Write a faithful, information-dense summary of them. Rules:\n" +
      "- Preserve every DISTINCT theme, constraint, blocker and named entity. Merge only true duplicates.\n" +
      "- Keep counts and any figures exact.\n" +
      "- Do not editorialise, rank, or recommend. You are compressing, not analysing.\n" +
      "- Plain lines, no markdown, no preamble. Aim for under 400 words.\n\n" +
      label.toUpperCase() + ":\n" + overflowText;

    // window.vyneLLM, not a bare reference: vyneFit is defined above it in this
    // IIFE, so the local binding does not exist yet at definition time.
    return window.vyneLLM(
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1200,
          messages: [{ role: "user", content: prompt }] }) },
      "fit_summary"
    ).then(function (res) {
      return res.json().then(function (d) {
        var summary = (res.ok && d.content && d.content[0] && d.content[0].text)
          ? d.content[0].text.trim() : "";
        return buildFitResult(kept, overflow, rendered, label, summary, overflowTruncated, renderFailures);
      });
    }).catch(function () {
      return buildFitResult(kept, overflow, rendered, label, "", overflowTruncated, renderFailures);
    });
  }

  function buildFitResult(kept, overflow, rendered, label, summary, overflowTruncated, renderFailures) {
    var note;
    if (summary) {
      note = "The " + kept.length + " most significant " + label + " are listed in full above. " +
        "The remaining " + overflow.length + " were condensed into the summary that follows — " +
        "they are represented, not omitted." +
        (overflowTruncated ? " (The overflow was itself very large; the summary covers as much of it as could be read in one pass.)" : "");
    } else {
      // The summariser failed. Say so in the prompt itself — a silent gap is
      // worse than a model that knows it is working from a partial picture.
      note = "WARNING: " + overflow.length + " further " + label + " could not be included and the " +
        "attempt to summarise them failed. Treat the list above as incomplete and say so in your output.";
    }
    if (renderFailures) {
      note += " " + renderFailures + " item(s) could not be rendered and appear as placeholders.";
    }
    var text = kept.join("\n") + "\n\n[" + note + "]" + (summary ? ("\n\nSUMMARY OF THE REMAINING " + overflow.length + " " + label.toUpperCase() + ":\n" + summary) : "");
    return {
      text: text, total: rendered.length, kept: kept.length,
      summarised: overflow.length, summary: summary, note: note, fitted: true,
    };
  }

  window.vyneFit = vyneFit;

  // Compression the consultant cannot see is the same silent loss the caps were
  // removed to avoid. Any module that fits a prompt calls this so the fact is
  // visible in the UI, with the numbers, at the moment it happens.
  function vyneFitNotice(fits, hostId) {
    var host = document.getElementById(hostId);
    if (!host) return;
    var parts = [];
    (fits || []).forEach(function (f) {
      if (f && f.fit && f.fit.fitted) {
        parts.push(f.fit.summarised + " of " + f.fit.total + " " + f.label);
      }
    });
    if (!parts.length) { host.style.display = "none"; host.innerHTML = ""; return; }
    host.style.display = "block";
    host.innerHTML =
      '<div style="font-size:11.5px;line-height:1.55;color:#7A5C1E;background:rgba(184,151,42,0.10);' +
      'border:1px solid rgba(184,151,42,0.4);border-radius:8px;padding:9px 12px;margin:10px 0">' +
      "<b>Condensed to fit:</b> " + parts.join(" and ") +
      " were too large to include in full, so they were summarised into the prompt rather than dropped. " +
      "The model saw a faithful summary of them, not a truncated list." +
      "</div>";
  }
  window.vyneFitNotice = vyneFitNotice;

  // ── vynePool: bounded-concurrency chunk runner (v5.32.27) ────────────────
  // Two generators ask for more than one response can hold — the industry
  // catalog (up to ~10 functions x ~10 use cases x 4 sub-use-cases) and the
  // Gantt (one row per selected initiative, now that the count caps are gone).
  // vyneFit answers "the INPUT is too big"; this answers "the OUTPUT is too
  // big", which fitting cannot help with — the only fix is more calls.
  //
  // Two properties matter and both are the reason this is shared rather than
  // written twice:
  //   · order is preserved, so a caller can zip results back onto its input
  //     array by index without carrying correlation ids through the prompt;
  //   · one rejected item resolves to {ok:false} instead of rejecting the
  //     whole batch. A chunked generator that loses nine good chunks because
  //     the tenth timed out is worse than the truncation it replaced.
  function vynePool(items, limit, fn, onProgress) {
    var list = items || [];
    var out = new Array(list.length);
    var next = 0;
    var done = 0;
    var width = Math.max(1, Math.min(limit || 1, list.length));
    if (!list.length) return Promise.resolve(out);
    return new Promise(function (resolve) {
      function pump() {
        if (next >= list.length) return;
        var i = next++;
        Promise.resolve()
          .then(function () { return fn(list[i], i); })
          .then(
            function (value) { out[i] = { ok: true, value: value }; },
            function (error) { out[i] = { ok: false, error: error }; }
          )
          .then(function () {
            done++;
            if (typeof onProgress === "function") {
              try { onProgress(done, list.length); } catch (e) {}
            }
            if (done === list.length) resolve(out);
            else pump();
          });
      }
      for (var w = 0; w < width; w++) pump();
    });
  }
  window.vynePool = vynePool;


  // v5.32.23: every generator in the app now gets one automatic retry when the
  // model runs out of room mid-answer. Previously only the solution-design
  // route had this, and only because that generator broke in production twice.
  //
  // The retry asks for a SHORTER answer rather than repeating the request,
  // because the failure it absorbs is length — asking again identically mostly
  // reproduces it. It fires only on a genuine truncation signal (finishReason
  // "length", now that the gateway actually reports one), never on a provider
  // error: the gateway has its own chain and its own backoff, and retrying
  // those here would just double the wait for the same answer.
  var COMPACT_SUFFIX =
    "\n\nIMPORTANT: a previous attempt ran out of room and was cut off before it finished. " +
    "Return the SAME structure, but noticeably shorter — fewer words per field, fewer items per list. " +
    "A complete, valid, shorter answer is far more useful than a richer one that stops halfway.";

  function vyneLlmOnce(payload, taskName) {

    var body = {
      // Pages can set window.VYNE_TASK_DEFAULT so their calls hit the right
      // routing chain (e.g. 'synthesis' → premium models) without editing
      // every call site.
      task: taskName || window.VYNE_TASK_DEFAULT || "legacy",
      module: MODULE,
      messages: (payload.messages || []).map(function (m) {
        return { role: m.role, content: m.content };
      }),
    };
    if (payload.system) body.messages.unshift({ role: "system", content: String(payload.system) });
    // Floor the output budget: legacy modules ask for 400-3500 tokens, but
    // modern reasoning models spend part of the budget thinking — small caps
    // cause truncated, unparseable JSON (surfaced twice in field testing:
    // doc-intelligence, then a 10-interview synthesis cut off mid-JSON).
    // Heavy synthesis tasks get extra headroom.
    // v5.32.23: this floor is why most call-site max_tokens values are inert —
    // a module asking for 700 or 3500 silently gets 8192. That is protective,
    // but it made the numbers at the call sites misleading (a "3500 -> 6500"
    // raise made earlier changed nothing, and a test was written asserting the
    // inert value). The effective budget is now reported back on the response
    // so a caller can log or assert what it actually got.
    var floor = (window.VYNE_TASK_DEFAULT === "synthesis" || taskName === "synthesis") ? 16384 : 8192;
    var effectiveMaxTokens = Math.max(payload.max_tokens || 0, floor);
    body.maxTokens = effectiveMaxTokens;
    if (typeof payload.temperature === "number") body.temperature = payload.temperature;
    var billingClient = billingClientName();
    if (billingClient) body.clientName = billingClient;

    return fetch(LLM_BASE + "/api/llm/generate", {   // v5.34.0: generation lane
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, authHeaders()),
      body: JSON.stringify(body),
    }).then(function (res) {
      if (res.status === 401) onAuthFailure();
      return res.json().then(
        function (data) {
          // Map the gateway's normalised finishReason back onto Anthropic's
          // vocabulary. Nine call sites across roadmap.html and
          // solution_design.html already check `stop_reason === 'max_tokens'`;
          // they were dead because nothing ever set it. This revives all of
          // them without touching a line in those modules.
          var stopReason = data.finishReason === "length" ? "max_tokens"
                         : data.finishReason === "stop" ? "end_turn"
                         : data.finishReason;
          var anthropicShaped = res.ok
            ? {
                content: [{ type: "text", text: data.text || "" }],
                usage: data.usage,
                stop_reason: stopReason,
                _vyne: {
                  provider: data.provider,
                  model: data.model,
                  finishReason: data.finishReason,
                  maxTokens: effectiveMaxTokens,
                  truncated: data.finishReason === "length",
                },
              }
            : { error: { message: data.error || "gateway error" } };
          // Response-like object: the module's `res.ok` / `res.json()` /
          // `res.status` patterns all keep working.
          return {
            ok: res.ok,
            status: res.status,
            truncated: res.ok && data.finishReason === "length",
            json: function () { return Promise.resolve(anthropicShaped); },
          };
        },
        function () {
          return {
            ok: false,
            status: res.status,
            json: function () {
              return Promise.resolve({ error: { message: "gateway error " + res.status } });
            },
          };
        }
      );
    });
  }

  window.vyneLLM = function (options, taskName) {
    var payload = {};
    try {
      payload = JSON.parse(options && options.body ? options.body : "{}");
    } catch (e) {}

    return vyneLlmOnce(payload, taskName).then(function (res) {
      if (!res.truncated) return res;
      // Ran out of room. Re-ask for a shorter answer, appending the instruction
      // to the last user message so the original prompt is preserved verbatim.
      var retryPayload = JSON.parse(JSON.stringify(payload));
      var msgs = retryPayload.messages || [];
      for (var i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user" && typeof msgs[i].content === "string") {
          msgs[i].content += COMPACT_SUFFIX;
          break;
        }
      }
      if (console && console.info) {
        console.info("[vyne] response hit the token ceiling — retrying once for a shorter answer");
      }
      return vyneLlmOnce(retryPayload, taskName).then(function (res2) {
        // Even if the retry is also truncated, return it: the shared parser
        // salvages a partial document, and two attempts is enough.
        return res2;
      });
    });
  };

  // ── Session helpers for the shell ─────────────────────────────────────────
  window.vyneAuth = {
    session: readSession,
    /**
     * Expose the 401 path so PAGE-LEVEL fetches can end a dead session the same
     * way the store and the LLM gateway do (v5.32.82).
     *
     * vyneStore's hydrate/flush and vyneLLM all call onAuthFailure() on a 401,
     * so an expired token cleanly returns to login. Raw `fetch` calls in the
     * pages did not — synthetic generation surfaced an expired session as
     * "Generation failed: invalid_token", which reads like the generator broke
     * rather than "sign in again". Same for any other page-level call.
     *
     * Returns true when it handled the response, so a caller can simply stop.
     */
    handleAuthFailure: function (statusOrError) {
      var dead = statusOrError === 401 || statusOrError === 403
        || /invalid_token|token_expired|unauthorized|forbidden_for_role/i.test(String(statusOrError || ""));
      if (dead) onAuthFailure();
      return dead;
    },
    signOut: function () {
      try { sessionStorage.removeItem("vyne_session"); } catch (e) {}
      window.location.href = "index.html";
    },
    setSession: function (s) {
      s.la = Date.now(); // idle-timeout baseline
      sessionStorage.setItem("vyne_session", JSON.stringify(s));
    },
    /** The client engagement this session works on.
     *  string = that client · null = all clients (admin) · undefined = not chosen. */
    activeClient: function () {
      var s = readSession();
      return s ? s.activeClient : undefined;
    },
    /** Authenticated JSON call to the platform API.
     *  vyneAuth.api('/api/engagements', {method:'POST', body:{...}}) → Promise<parsed JSON>. */
    api: function (path, opts) {
      opts = opts || {};
      // v5.34.0: opts.base lets a GENERATION call (e.g. solution-design/generate)
      // target the LLM lane (window.vyneLlmBase()) while data calls stay on
      // API_BASE. Defaults to API_BASE, so every existing caller is unchanged.
      var base = opts.base != null ? opts.base : API_BASE;
      return fetch(base + path, {
        method: opts.method || "GET",
        headers: Object.assign({ "content-type": "application/json" }, authHeaders()),
        body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      }).then(function (r) {
        if (r.status === 401) { onAuthFailure(); throw new Error("unauthorized"); }
        return r.json().then(function (j) {
          if (!r.ok) { var e = new Error(j && j.error ? j.error : ("API " + r.status)); e.status = r.status; e.body = j; throw e; }
          return j;
        });
      });
    },
    /*
     * Point this session at a client under a new name (v5.32.92).
     *
     * There was no setter for activeClient anywhere in the product — only
     * index.html's picker wrote it, and switchClient() cleared it. That is the
     * gap the rename fell through, and why v5.32.91's fix looked right and
     * changed nothing a consultant could see.
     *
     * activeClient lives in sessionStorage, so it survives reloads and is
     * untouchable from the server. autoRestoreFromStore() consults it FIRST —
     * deliberately, since v5.17, so a brand-new client gets a clean form
     * rather than the previous client's. After a server-side rename the two
     * facts combine badly: the session still names the old client, the probe
     * for that client's briefing finds nothing (the server just renamed that
     * key), and the page concludes "brand-new client, restore nothing". The
     * consultant sees the old name and an empty form, and every write after
     * that goes out under an identity the server no longer has.
     *
     * Only ever call this when the client is genuinely the SAME engagement
     * under a new name. It is not a client switcher — switchClient() is.
     */
    setActiveClient: function (name, ownedNorms) {
      try {
        var s = JSON.parse(sessionStorage.getItem("vyne_session") || "null");
        if (!s) return false;
        // Leave `null` alone: null means "all clients" for an admin, which is
        // not a client that can be renamed, and overwriting it would silently
        // narrow their scope. "" (a consultant with no clients) likewise.
        if (s.activeClient === null || s.activeClient === undefined) return false;
        if (s.activeClient === "") return false;
        /*
         * v5.32.93b — and only when the session is on THE CLIENT BEING RENAMED.
         *
         * ownedNorms comes from the rename response: every normalized name the
         * server found that engagement under. Without this check, an owner
         * whose session is scoped to client A, renaming client B from a
         * briefing they reached by other means, had their session silently
         * repointed at B — a scope change nobody asked for, from a button that
         * says "Rename Client". Omitted (older callers) it behaves as before.
         */
        if (ownedNorms && ownedNorms.length) {
          var cur = String(s.activeClient).toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 100);
          if (ownedNorms.indexOf(cur) === -1) return false;
        }
        s.activeClient = name;
        sessionStorage.setItem("vyne_session", JSON.stringify(s));
        return true;
      } catch (e) { return false; }
    },
    /** Drop the client context and return to the picker on the hub. */
    switchClient: function () {
      try {
        var s = JSON.parse(sessionStorage.getItem("vyne_session") || "null");
        if (s) { delete s.activeClient; sessionStorage.setItem("vyne_session", JSON.stringify(s)); }
      } catch (e) {}
      window.location.href = "index.html";
    },
  };

  // ── Natural voice: server TTS (Gemini) with browser fallback ─────────────
  // Returns a Promise<Audio|null>: an Audio element loaded with natural
  // speech, or null when the server voice is unavailable (caller falls back
  // to browser speechSynthesis).
  // Synthesized-audio cache: text+voice → Promise<dataUrl|null>. Lets the
  // interview PREWARM the opening question's audio while the tap-to-begin
  // overlay is still up, so the agent speaks the instant the user taps.
  // Small LRU — repeated phrases within a session also benefit.
  var _ttsCache = {};
  var _ttsCacheKeys = [];
  function ttsDataUrl(text, voice) {
    var key = (voice || "") + "|" + text;
    if (_ttsCache[key]) return _ttsCache[key];
    var ttsBody = voice ? { text: text, voice: voice } : { text: text };
    var billingClientTts = billingClientName();
    if (billingClientTts) ttsBody.clientName = billingClientTts;
    var p = fetch(LLM_BASE + "/api/voice/tts", {   // v5.34.0: generation lane
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, authHeaders()),
      body: JSON.stringify(ttsBody),
    })
      .then(function (r) {
        if (!r.ok) return null;
        return r.json().then(function (d) {
          if (!d.audioBase64) return null;
          return "data:" + (d.mime || "audio/wav") + ";base64," + d.audioBase64;
        });
      })
      .catch(function () { return null; });
    _ttsCache[key] = p;
    _ttsCacheKeys.push(key);
    if (_ttsCacheKeys.length > 12) delete _ttsCache[_ttsCacheKeys.shift()];
    // Never cache failures — retry next time.
    p.then(function (url) { if (url === null) { delete _ttsCache[key]; } });
    return p;
  }

  /** How vyneSpeak splits text — prewarm MUST chunk identically so the
   *  cache keys line up. */
  function speakChunks(text) {
    var m = text.match(/^[\s\S]{1,220}?[.!?](?:\s|$)/);
    if (m && m[0].trim().length >= 25 && text.length - m[0].length > 60) {
      return [m[0].trim(), text.slice(m[0].length).trim()];
    }
    return [text];
  }

  window.vyneTTS = function (text, voice) {
    return ttsDataUrl(text, voice).then(function (url) {
      return url ? new Audio(url) : null;
    });
  };

  /** Start synthesizing (and caching) speech WITHOUT playing it. Returns a
   *  promise that resolves true when the first chunk's audio is ready. */
  window.vyneTTSPrewarm = function (text, voice) {
    var chunks = speakChunks(text);
    var first = ttsDataUrl(chunks[0], voice);
    for (var i = 1; i < chunks.length; i++) ttsDataUrl(chunks[i], voice);
    return first.then(function (url) { return url !== null; });
  };

  // vyneSpeak: low-latency natural speech. Splits the reply into a short
  // lead sentence + remainder and PIPELINES them: the lead starts playing
  // while the remainder synthesizes, cutting time-to-first-word to the TTS
  // latency of one sentence instead of the whole reply.
  // Returns a controller { pause() } (the module treats it like an Audio).
  // cbs: { onended, onfallback(text), voice } — onfallback fires if the FIRST
  // chunk fails, so the caller can use the browser voice for the whole text.
  //
  // v5.32.52: `voice`. Every other function in this file already accepted one
  // and threaded it to the server; vyneSpeak alone dropped it, so the TTS
  // fallback always spoke in the server default (Kore, female) regardless of
  // which interviewer voice the consultant had assigned. Gemini TTS and Gemini
  // Live share the same prebuilt voice names, so the SAME id works on both
  // paths — which is the point. When realtime is unavailable the interview
  // should still sound like the interviewer the client was introduced to,
  // rather than swapping in a different person mid-engagement.
  window.vyneSpeak = function (text, cbs) {
    cbs = cbs || {};
    var voice = cbs.voice || undefined;
    var stopped = false;
    var current = null;

    // Lead chunk: first 1-2 sentences (~<=220 chars); remainder: the rest.
    // (speakChunks is shared with vyneTTSPrewarm so prewarmed audio hits
    //  the cache exactly.)
    var chunks = speakChunks(text);

    var fetches = chunks.map(function (c) { return vyneTTS(c, voice); }); // start ALL now

    function playFrom(i) {
      if (stopped) return;
      if (i >= fetches.length) { if (cbs.onended) cbs.onended(); return; }
      fetches[i].then(function (audio) {
        if (stopped) return;
        if (!audio) {
          if (i === 0 && cbs.onfallback) { cbs.onfallback(text); return; }
          // A later chunk failed — end gracefully rather than going silent mid-thought.
          if (cbs.onended) cbs.onended();
          return;
        }
        current = audio;
        audio.onended = function () { playFrom(i + 1); };
        audio.onerror = function () { playFrom(i + 1); };
        audio.play().catch(function () {
          if (i === 0 && cbs.onfallback) cbs.onfallback(text);
          else if (cbs.onended) cbs.onended();
        });
      });
    }
    playFrom(0);

    return {
      pause: function () {
        stopped = true;
        if (current) { try { current.pause(); } catch (e) {} }
      },
    };
  };

  // ── Audio conversion: recorded WebM/Opus → 16kHz mono WAV ─────────────────
  // Gemini's transcription accepts wav/mp3/ogg/flac/aac — NOT the webm
  // container Chrome records. Decoding + resampling in the browser makes the
  // upload format deterministic on every browser (and 4x smaller).
  function blobToWavBase64(blob) {
    return blob.arrayBuffer().then(function (buf) {
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx = new AC();
      return ctx.decodeAudioData(buf).then(function (decoded) {
        var targetRate = 16000;
        var frames = Math.ceil(decoded.duration * targetRate);
        var off = new OfflineAudioContext(1, frames, targetRate);
        var src = off.createBufferSource();
        src.buffer = decoded;
        src.connect(off.destination);
        src.start();
        return off.startRendering();
      }).then(function (rendered) {
        ctx.close();
        var samples = rendered.getChannelData(0);
        // Peak-normalize: laptop mics record quietly, and near-silent audio
        // makes transcription models hallucinate ("the the the…"). Scale so
        // the loudest sample sits at ~-3dB (skip if truly silent).
        var peak = 0;
        for (var p = 0; p < samples.length; p++) {
          var a = Math.abs(samples[p]);
          if (a > peak) peak = a;
        }
        if (peak > 0.001 && peak < 0.7) {
          var gain = 0.7 / peak;
          for (var g = 0; g < samples.length; g++) samples[g] *= gain;
        }
        console.log("[vyne] recording: " + rendered.duration.toFixed(1) + "s, peak level " +
          peak.toFixed(3) + (peak < 0.02 ? " — VERY QUIET, check mic input" : ""));
        var pcm = new DataView(new ArrayBuffer(44 + samples.length * 2));
        function wstr(o, s) { for (var i = 0; i < s.length; i++) pcm.setUint8(o + i, s.charCodeAt(i)); }
        wstr(0, "RIFF"); pcm.setUint32(4, 36 + samples.length * 2, true); wstr(8, "WAVE");
        wstr(12, "fmt "); pcm.setUint32(16, 16, true); pcm.setUint16(20, 1, true);
        pcm.setUint16(22, 1, true); pcm.setUint32(24, 16000, true);
        pcm.setUint32(28, 32000, true); pcm.setUint16(32, 2, true); pcm.setUint16(34, 16, true);
        wstr(36, "data"); pcm.setUint32(40, samples.length * 2, true);
        for (var i = 0; i < samples.length; i++) {
          var s = Math.max(-1, Math.min(1, samples[i]));
          pcm.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
        var bytes = new Uint8Array(pcm.buffer);
        var bin = "";
        var CHUNK = 0x8000;
        for (var j = 0; j < bytes.length; j += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(j, j + CHUNK));
        }
        return btoa(bin);
      });
    });
  }

  // ── Reliable mic: record → server transcription (Gemini) ─────────────────
  // Drop-in replacement for window.SpeechRecognition. The browser API the
  // modules shipped with auto-stops on silence, mishears, and only works
  // well in Chrome; this shim records the FULL answer with MediaRecorder,
  // then transcribes server-side in one shot. Same event surface the
  // modules already use: onresult / onend / onerror, start() / stop().
  function VyneRecognition() {
    this.continuous = true;
    this.interimResults = true;
    this.lang = "en-US";
    this.maxAlternatives = 1;
    this.onresult = null;
    this.onend = null;
    this.onerror = null;
    this._rec = null;
    this._chunks = [];
    this._stream = null;
  }

  function makeResultEvent(text, isFinal) {
    var alt = [{ transcript: text, confidence: 0.95 }];
    alt.isFinal = isFinal;
    var results = [alt];
    return { results: results, resultIndex: 0 };
  }

  VyneRecognition.prototype.start = function () {
    var self = this;
    if (self._rec) return;
    navigator.mediaDevices.getUserMedia({
      audio: {
        // Ask the browser for its full speech-processing chain: automatic
        // gain (fixes quiet laptop mics), echo cancellation (stops the
        // agent's own voice bleeding into the answer), noise suppression.
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    }).then(
      function (stream) {
        self._stream = stream;
        self._chunks = [];
        var mime = window.MediaRecorder && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : (MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "");
        self._rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        self._mime = self._rec.mimeType || mime || "audio/webm";
        self._rec.ondataavailable = function (e) { if (e.data && e.data.size) self._chunks.push(e.data); };
        self._rec.onstop = function () { self._finish(); };
        self._rec.start(1000); // gather in 1s chunks
        if (self._showRecording) self._showRecording();
      },
      function (err) {
        if (self.onerror) self.onerror({ error: "not-allowed", message: String(err) });
        if (self.onend) self.onend();
      }
    );
  };

  VyneRecognition.prototype.stop = function () {
    if (this._rec && this._rec.state !== "inactive") this._rec.stop();
    else if (this.onend) this.onend();
  };
  VyneRecognition.prototype.abort = function () {
    this._aborted = true;
    this.stop();
  };

  VyneRecognition.prototype._finish = function () {
    var self = this;
    if (self._stream) { self._stream.getTracks().forEach(function (t) { t.stop(); }); self._stream = null; }
    var blob = new Blob(self._chunks, { type: self._mime });
    self._rec = null;
    if (self._aborted || blob.size < 1000) { // aborted or essentially empty
      self._aborted = false;
      if (self._hideBanner) self._hideBanner();
      if (self.onend) self.onend();
      return;
    }
    if (self._showTranscribing) self._showTranscribing();
    // Interim cue so the UI shows something while the server transcribes.
    if (self.onresult) self.onresult(makeResultEvent("(transcribing your answer…)", false));
    // Convert to 16kHz WAV first — Gemini rejects Chrome's webm container.
    blobToWavBase64(blob)
      .then(function (b64) {
        // Debug hook: hear exactly what was sent —
        //   new Audio('data:audio/wav;base64,'+vyneLastRecording).play()
        window.vyneLastRecording = b64;
        var transcribeBody = { audioBase64: b64, mimeType: "audio/wav" };
        var billingClientTx = billingClientName();
        if (billingClientTx) transcribeBody.clientName = billingClientTx;
        return fetch(LLM_BASE + "/api/voice/transcribe", {   // v5.34.0: generation lane
          method: "POST",
          headers: Object.assign({ "content-type": "application/json" }, authHeaders()),
          body: JSON.stringify(transcribeBody),
        });
      })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
      .then(function (d) {
        if (self._hideBanner) self._hideBanner();
        if (self.onresult) self.onresult(makeResultEvent(d.text || "", true));
        if (self.onend) self.onend();
      })
      .catch(function (err) {
        console.error("[vyne] transcription failed:", err);
        if (self._hideBanner) self._hideBanner();
        if (self.onresult) self.onresult(makeResultEvent("", true)); // clear the interim cue
        if (self.onerror) self.onerror({ error: "network", message: String(err) });
        if (self.onend) self.onend();
      });
  };

  // ── Unmissable recording indicator ────────────────────────────────────────
  // The interview agent AUTO-STARTS listening after it finishes speaking, so
  // users often click the mic to "turn it on" and actually turn it OFF —
  // then answer into a dead mic. This banner is driven by the recorder
  // itself, so what it says is always the truth.
  var recBanner = null;
  function showRecBanner(html, bg) {
    if (!recBanner) {
      recBanner = document.createElement("div");
      recBanner.style.cssText =
        "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:99999;" +
        "font:600 14px 'Inter',sans-serif;color:#fff;padding:10px 22px;border-radius:24px;" +
        "box-shadow:0 4px 18px rgba(0,0,0,0.4);pointer-events:none;transition:background 0.2s";
      document.body.appendChild(recBanner);
    }
    recBanner.style.background = bg;
    recBanner.style.display = "block";
    recBanner.innerHTML = html;
  }
  function hideRecBanner() {
    if (recBanner) recBanner.style.display = "none";
  }
  var pulseStyle = document.createElement("style");
  pulseStyle.textContent = "@keyframes vynePulse{0%,100%{opacity:1}50%{opacity:0.35}}";
  document.addEventListener("DOMContentLoaded", function () {
    document.head.appendChild(pulseStyle);
  });

  VyneRecognition.prototype._showRecording = function () {
    showRecBanner(
      '<span style="display:inline-block;width:10px;height:10px;background:#fff;border-radius:50%;' +
      'margin-right:9px;animation:vynePulse 1.2s infinite"></span>' +
      "RECORDING — speak your answer, click the mic when finished",
      "#DC2626"
    );
  };
  VyneRecognition.prototype._showTranscribing = function () {
    showRecBanner("✍️ Transcribing your answer…", "#C6A46B");
  };
  VyneRecognition.prototype._hideBanner = hideRecBanner;

  window.VyneRecognition = VyneRecognition;

  // ── Interviewee helpers (used by the Interview Agent page) ────────────────
  window.vyneInterview = {
    isInterviewee: function () { return INTERVIEWEE; },
    mine: function () { return MY_INTERVIEW; },
    complete: function () {
      flush();
      return fetch(API_BASE + "/api/interviews/mine/complete", {
        method: "POST",
        headers: authHeaders(),
      }).then(function (r) { return r.ok; });
    },
  };

  // ── Silent token refresh (v5.30) ───────────────────────────────────────
  // Identity Platform ID tokens are only valid ~1 hour — far shorter than
  // this app's own 30-min idle / 12-hr absolute session policy above. Before
  // this, a user actively working past that hour (an interviewee mid-
  // interview, a consultant mid-synthesis) got hard-401'd on their next save
  // and bounced to a fresh login screen — losing in-progress context despite
  // being fully within policy the whole time. This keeps the token in
  // sessionStorage current in the background so ONLY genuine idle/absolute
  // expiry (or an explicit sign-out) ever interrupts a session; a live token
  // refresh is invisible to the user.
  //
  // Deliberately skipped for the shell (index.html does its own first-class
  // Firebase sign-in and would double-initialize the SDK) and for dev-mode
  // sessions (token is "dev:<uid>", not a real ID token — nothing to
  // refresh).
  var TOKEN_REFRESH_MS = 45 * 60 * 1000; // comfortably under the ~60-min token lifetime

  function updateSessionToken(newToken) {
    if (!newToken) return;
    try {
      var raw = sessionStorage.getItem("vyne_session");
      if (!raw) return; // session already ended locally — nothing to refresh
      var s = JSON.parse(raw);
      if (!s) return;
      s.token = newToken;
      sessionStorage.setItem("vyne_session", JSON.stringify(s));
    } catch (e) { /* best-effort — a missed refresh just falls back to the old 401 path */ }
  }

  function initSilentTokenRefresh() {
    if (isShell || !session || session.mode !== "idp") return;
    fetch(API_BASE + "/api/config")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg || !cfg.firebase) return;
        return Promise.all([
          import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js"),
          import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"),
        ]).then(function (mods) {
          var appMod = mods[0];
          var authMod = mods[1];
          var fbApp = appMod.initializeApp(cfg.firebase);
          var auth = authMod.getAuth(fbApp);
          // Must be set BEFORE the persisted user rehydrates from IndexedDB,
          // or the SDK won't match a user signed into an Identity Platform
          // tenant (see index.html's finishLogin — same value set there).
          if (session.idpTenantId) auth.tenantId = session.idpTenantId;

          // The documented way to keep a backend-synced token fresh
          // (Firebase's own guidance for session-cookie sync applies here
          // just as well): fires once when the persisted user rehydrates,
          // and again on every automatic background refresh the SDK
          // performs for as long as this page stays open.
          authMod.onIdTokenChanged(auth, function (user) {
            if (!user) return;
            user.getIdToken().then(updateSessionToken).catch(function () {});
          });

          // Backstop: backgrounded tabs get their timers throttled, which
          // can delay the SDK's own proactive refresh. A page left open in
          // a background tab for a full long session still gets forced
          // ahead of the ~60-min expiry.
          setInterval(function () {
            if (auth.currentUser) {
              auth.currentUser.getIdToken(true).then(updateSessionToken).catch(function () {});
            }
          }, TOKEN_REFRESH_MS);
        });
      })
      .catch(function (e) {
        console.warn("[vyne] silent token refresh unavailable:", e && e.message);
      });
  }

  startHydration();
  initSilentTokenRefresh();
})();
