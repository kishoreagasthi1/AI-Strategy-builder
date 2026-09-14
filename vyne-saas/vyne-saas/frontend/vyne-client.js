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

  // ── Version (v5.29) ─────────────────────────────────────────────────────
  // Single source of truth for "what frontend build is this" — kept in
  // lockstep with backend/src/version.ts's VERSION by hand on every release
  // (test/version.test.ts fails the backend build if they drift apart).
  // about.html fetches GET /api/version and compares it against this so a
  // partial deploy (one side redeployed, the other not — see v5.27's
  // postmortem, where a stale frontend folder got redeployed silently) is
  // visible from inside the running app.
  var VYNE_VERSION = "5.32.4";
  window.VYNE_VERSION = VYNE_VERSION;

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

  function onAuthFailure() {
    try { sessionStorage.removeItem("vyne_session"); } catch (e) {}
    window.location.href = "index.html?expired=1";
  }

  // ── vyneStore: synchronous store facade over /api/module-state ────────────
  var cache = {};
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
      return JSON.parse(xhr.responseText).state || {};
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

  function hydrateSync() {
    if (isShell) return; // shell doesn't need module state
    var s = readSession();
    INTERVIEWEE = !!(s && s.role === "interviewee");
    if (INTERVIEWEE) { hydrateIntervieweeSync(); return; }
    cache = fetchStateSync(STORE_MODULE) || {};
    if (Object.keys(cache).length === 0) {
      // One-time forward-migration of keys written before the shared
      // namespace existed. Merged into cache AND queued to flush so they
      // persist under 'workspace' from now on.
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
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 800);
  }

  function flush() {
    flushTimer = null;
    var sets = dirty.sets;
    var deletes = Object.keys(dirty.deletes);
    if (Object.keys(sets).length === 0 && deletes.length === 0) return;
    dirty = { sets: {}, deletes: {} };
    var endpoint = INTERVIEWEE
      ? "/api/interviews/mine/state"       // private per-interview namespace
      : "/api/module-state/" + STORE_MODULE;
    fetch(API_BASE + endpoint, {
      method: "PUT",
      headers: Object.assign({ "content-type": "application/json" }, authHeaders()),
      body: JSON.stringify({ sets: sets, deletes: deletes }),
      keepalive: true,
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) onAuthFailure();
        else if (!r.ok) console.error("[vyne] state flush HTTP " + r.status);
      })
      .catch(function (e) {
        console.error("[vyne] state flush failed:", e);
        // Re-queue so nothing is lost on transient failures.
        for (var k in sets) if (!(k in dirty.sets)) dirty.sets[k] = sets[k];
        deletes.forEach(function (k) { dirty.deletes[k] = true; });
        scheduleFlush();
      });
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
      xhr.send(JSON.stringify({ sets: sets, deletes: deletes }));
    } catch (e) {
      // Sync XHR refused (some browsers on unload): best-effort keepalive.
      try {
        fetch(API_BASE + endpoint, {
          method: "PUT",
          headers: Object.assign({ "content-type": "application/json" }, authHeaders()),
          body: JSON.stringify({ sets: sets, deletes: deletes }),
          keepalive: true,
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
      return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
    },
    setItem: function (key, value) {
      value = String(value);
      cache[key] = value;
      dirty.sets[key] = value;
      delete dirty.deletes[key];
      scheduleFlush();
    },
    removeItem: function (key) {
      delete cache[key];
      delete dirty.sets[key];
      dirty.deletes[key] = true;
      scheduleFlush();
    },
    /** Full localStorage-compatible enumeration surface. */
    keys: function () { return Object.keys(cache); },
    key: function (i) { return Object.keys(cache)[i] ?? null; },
    /** Force-push pending writes now (used on pagehide). */
    flush: flush,
  };
  Object.defineProperty(window.vyneStore, "length", {
    get: function () { return Object.keys(cache).length; },
  });

  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });

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
  window.vyneLLM = function (options, taskName) {
    var payload = {};
    try {
      payload = JSON.parse(options && options.body ? options.body : "{}");
    } catch (e) {}

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
    var floor = (window.VYNE_TASK_DEFAULT === "synthesis" || taskName === "synthesis") ? 16384 : 8192;
    body.maxTokens = Math.max(payload.max_tokens || 0, floor);
    if (typeof payload.temperature === "number") body.temperature = payload.temperature;
    var billingClient = billingClientName();
    if (billingClient) body.clientName = billingClient;

    return fetch(API_BASE + "/api/llm/generate", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, authHeaders()),
      body: JSON.stringify(body),
    }).then(function (res) {
      if (res.status === 401) onAuthFailure();
      return res.json().then(
        function (data) {
          var anthropicShaped = res.ok
            ? {
                content: [{ type: "text", text: data.text || "" }],
                usage: data.usage,
                _vyne: { provider: data.provider, model: data.model },
              }
            : { error: { message: data.error || "gateway error" } };
          // Response-like object: the module's `res.ok` / `res.json()` /
          // `res.status` patterns all keep working.
          return {
            ok: res.ok,
            status: res.status,
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
  };

  // ── Session helpers for the shell ─────────────────────────────────────────
  window.vyneAuth = {
    session: readSession,
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
      return fetch(API_BASE + path, {
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
    var p = fetch(API_BASE + "/api/voice/tts", {
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
  // cbs: { onended, onfallback(text) } — onfallback fires if the FIRST chunk
  // fails, so the caller can use the browser voice for the whole text.
  window.vyneSpeak = function (text, cbs) {
    cbs = cbs || {};
    var stopped = false;
    var current = null;

    // Lead chunk: first 1-2 sentences (~<=220 chars); remainder: the rest.
    // (speakChunks is shared with vyneTTSPrewarm so prewarmed audio hits
    //  the cache exactly.)
    var chunks = speakChunks(text);

    var fetches = chunks.map(function (c) { return vyneTTS(c); }); // start ALL now

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
        return fetch(API_BASE + "/api/voice/transcribe", {
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

  hydrateSync();
  initSilentTokenRefresh();
})();
