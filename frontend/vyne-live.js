/**
 * vyne-live.js — realtime duplex voice for the Interview Agent (v5.34.27).
 *
 * Loaded alongside vyne-client.js. Exposes window.vyneLive.
 *
 * ── What this replaces, and why it is a different shape ─────────────────────
 *
 * The vyneSpeak path is: model writes prose → two independent TTS calls →
 * play one after the other. That cannot produce a natural conversation at any
 * voice setting, for three structural reasons: the text is written to be read
 * rather than said, prosody resets at the chunk boundary, and the interviewee
 * cannot interrupt. This module holds a duplex connection to a speech-native
 * model instead, so barge-in and turn-taking are properties of the transport
 * rather than features to be simulated.
 *
 * ── The audio never touches our server ──────────────────────────────────────
 *
 * The browser connects DIRECTLY to Google using a short-lived token minted by
 * POST /api/voice/live-session. See backend/src/llm/liveSession.ts for the
 * full reasoning; the short version is that proxying audio through Cloud Run
 * would pin an instance for the length of every interview, cap sessions at the
 * 60-minute request timeout, and break on Cloud Run's best-effort session
 * affinity when a connection drops.
 *
 * The token travels in the WebSocket URL as a query parameter, because
 * browsers cannot set headers on a WebSocket handshake. That would normally
 * violate our own rule about credentials in URLs — and it is precisely why the
 * token is ephemeral, single-use, model-pinned and expires in minutes. A
 * long-lived API key must never go here. Our real key stays server-side.
 *
 * ── Two engineering choices worth knowing ───────────────────────────────────
 *
 * 1. SEPARATE AudioContexts for capture and playback, each opened at the rate
 *    its side of the protocol actually uses (16 kHz in, 24 kHz out). Asking
 *    the browser for the right rate up front means no resampling in the hot
 *    path at all. resampleTo() below exists only as a fallback for browsers
 *    that quietly ignore the requested sampleRate — verified at runtime rather
 *    than assumed, because Safari has historically done exactly that.
 *
 * 2. ScriptProcessorNode, not AudioWorklet. AudioWorklet is the modern and
 *    technically better choice — it runs off the main thread and will not
 *    glitch under layout pressure. But loading one without shipping a separate
 *    file means a blob: URL, and our CSP (firebase.json) pins script sources
 *    to an explicit allowlist with no blob:. Loosening the CSP for an audio
 *    node is a bad trade on an app whose main risk is script injection into
 *    model output. If you later add `blob:` to script-src for another reason,
 *    switching this is a contained change.
 */
(function () {
  'use strict';

  /* ── LIVE PATH TRACE (v5.34.18) ─────────────────────────────────────────────
   *
   * The opening turn crosses four files and two async boundaries before it
   * reaches the socket, and every failure on that path is SILENT: a guard that
   * returns early, a promise that has not settled, a frame the model never
   * sends. None of them throw, so a broken start looks exactly like a working
   * one until nobody speaks.
   *
   * So the path traces itself. Every log line carries milliseconds since the
   * module loaded, which is the only way to see an ordering bug — the specific
   * class of bug this exists for is "A ran before B, and B is what A needed".
   *
   * Off with `window.VYNE_LIVE_DEBUG = false`. In DevTools, `copy(vyneLiveLogDump())`
   * gives a paste-ready transcript.
   */
  var _T0 = Date.now();
  function vlog(tag, data) {
    if (window.VYNE_LIVE_DEBUG === false) return;
    var dt = Date.now() - _T0;
    var stamp = '        ' + dt;
    stamp = stamp.slice(stamp.length - 6);
    try { console.log('[VL +' + stamp + 'ms] ' + tag, data === undefined ? '' : data); } catch (e) {}
    try {
      var buf = window.__vyneLiveLog || (window.__vyneLiveLog = []);
      buf.push({ t: dt, tag: tag, data: data });
      // v5.34.20: a live turn produces audio frames at ~20/second, so a chatty
      // ring rolls the interesting events — a pause, a close, a teardown — off
      // the end before anyone can read them. Audio frames are now rolled up
      // (see _traceFrame) AND the ring is large enough to hold a whole
      // interview's worth of events. Overridable for a very long session.
      var cap = Number(window.VYNE_LIVE_LOG_MAX) || 20000;
      if (buf.length > cap) buf.splice(0, buf.length - cap);
    } catch (e) {}
  }
  window.vyneLiveLog = vlog;
  /** Start a clean capture — call right before the thing you want to see. */
  window.vyneLiveLogClear = function (note) {
    window.__vyneLiveLog = [];
    vlog('--- log cleared' + (note ? ': ' + note : '') + ' ---');
    return 'cleared';
  };
  /** Drop a labelled marker into the trace, e.g. just before clicking Pause. */
  window.vyneLiveMark = function (label) { vlog('>>> MARK: ' + String(label)); return 'marked'; };
  /** Paste-ready transcript of the whole trace. `copy(vyneLiveLogDump())`. */
  window.vyneLiveLogDump = function () {
    var buf = window.__vyneLiveLog || [];
    return buf.map(function (e) {
      var stamp = '        ' + e.t;
      stamp = stamp.slice(stamp.length - 6);
      var d = '';
      if (e.data !== undefined) {
        try { d = ' ' + JSON.stringify(e.data); } catch (x) { d = ' <unserialisable>'; }
      }
      return '[VL +' + stamp + 'ms] ' + e.tag + d;
    }).join('\n');
  };
  /** Socket readyState as a word — '1' tells you nothing at 2am. */
  function rs(ws) {
    if (!ws) return 'no-socket';
    return ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] || ('?' + ws.readyState);
  }
  function snip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > (n || 80) ? s.slice(0, n || 80) + '…(' + s.length + ')' : s;
  }

  /**
   * Protocol surface. These are the parts most likely to move: Google retires
   * preview endpoints and model ids, which is exactly how the batch TTS path
   * ended up pinned to a dead May-2025 preview. Keep them in one place and
   * confirm them against the account before a release.
   */
  var WS_HOST = 'wss://generativelanguage.googleapis.com';
  /**
   * How the ephemeral token is presented, and on which endpoint, is not
   * publicly documented for raw WebSocket use, and getting it wrong fails in a
   * way that looks like something else entirely: the handshake is ACCEPTED and
   * the socket is then closed with code 1008 and no error frame.
   *
   * Verified against the live API: `?access_token=<token>` on v1beta returns
   *   1008 — Method doesn't allow unregistered callers (callers without
   *   established identity). Please use API Key or other form of API consumer
   *   identity
   * Google's own SDK passes the minted token as `api_key=token.name` against
   * api_version v1alpha, i.e. as a KEY, not as an access token — which is what
   * that error is asking for.
   *
   * Rather than guess again, try the plausible combinations in order and keep
   * the first that reaches setupComplete. The winner is reported to the caller
   * so it can be pinned once observed.
   */
  // v5.34.14: order variants by what actually connects FIRST. The working
  // combination in production (verified live via socket tracing) is
  // v1beta / BidiGenerateContentConstrained / access_token. It used to be
  // LAST, so every interview opened five doomed sockets (~1-2s each) before
  // the sixth connected — ~8-11s of dead air that read as 'no sound / broken'.
  // Trying the known-good one first drops first-audio to ~2-3s. The rest
  // remain as ordered fallbacks in case the endpoint shape changes again.
  var WS_VARIANTS = [
    { v: 'v1beta',  svc: 'BidiGenerateContentConstrained', auth: 'access_token' },
    { v: 'v1alpha', svc: 'BidiGenerateContentConstrained', auth: 'access_token' },
    { v: 'v1beta',  svc: 'BidiGenerateContentConstrained', auth: 'key' },
    { v: 'v1alpha', svc: 'BidiGenerateContentConstrained', auth: 'key' },
    { v: 'v1beta',  svc: 'BidiGenerateContent',            auth: 'key' },
    { v: 'v1alpha', svc: 'BidiGenerateContent',            auth: 'key' }
  ];
  function wsUrl(variant, token) {
    return WS_HOST + '/ws/google.ai.generativelanguage.' + variant.v +
           '.GenerativeService.' + variant.svc +
           '?' + variant.auth + '=' + encodeURIComponent(token);
  }
  function variantLabel(v) { return v.v + '/' + v.svc + '?' + v.auth; }
  var INPUT_RATE = 16000;    // protocol requires 16 kHz mono PCM16 little-endian
  var OUTPUT_RATE = 24000;   // the model returns 24 kHz PCM16
  var FRAME_SAMPLES = 2048;  // ~128 ms at 16 kHz — small enough to feel live

  // ── Pure helpers. Exported on _internals so they can be unit tested in Node
  //    without a browser; every one of them is a place a silent audio bug hides.

  /** Float32 [-1,1] → little-endian PCM16. Clamped: overflow wraps to a loud
   *  click rather than saturating, which is the classic "why does it crackle". */
  function floatTo16BitPCM(input) {
    var out = new Int16Array(input.length);
    for (var i = 0; i < input.length; i++) {
      var s = input[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  /** PCM16 → Float32 [-1,1], for playback buffers. */
  function int16ToFloat32(input) {
    var out = new Float32Array(input.length);
    for (var i = 0; i < input.length; i++) out[i] = input[i] / 0x8000;
    return out;
  }

  /** Linear-interpolation resample. Only used when the browser refuses the
   *  requested context rate — handles non-integer ratios like 44100→16000. */
  function resampleTo(input, inRate, outRate) {
    if (inRate === outRate) return input;
    var ratio = inRate / outRate;
    var len = Math.floor(input.length / ratio);
    var out = new Float32Array(len);
    for (var i = 0; i < len; i++) {
      var pos = i * ratio;
      var i0 = Math.floor(pos);
      var i1 = Math.min(i0 + 1, input.length - 1);
      var frac = pos - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }

  /** Chunked so a long utterance cannot blow the argument limit on
   *  String.fromCharCode — the failure mode is a hard throw mid-sentence. */
  function bytesToBase64(bytes) {
    var bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Build the setup frame.
   *
   *  NOTE what is NOT here: the system instruction. It is pinned into the token
   *  server-side (see backend/src/llm/interviewerPersona.ts). During an
   *  interview this page is running in the INTERVIEWEE's browser, and a
   *  client-supplied instruction would let them rewrite the interviewer's
   *  rules — including the one forbidding disclosure of the firm's confidential
   *  briefing. Model and modality are echoed so a mismatch fails loudly at
   *  connect rather than producing a session we did not intend. */
  /*
   * FIELD PATHS ARE NOT GUESSWORK — they are read off Google's own SDK.
   *
   * Source: @google/genai 2.16.0, dist/index.cjs, liveConnectConfigToMldev().
   * That function is the SDK's serializer for a Live connect config, and it is
   * explicit about where each field lands on the wire:
   *
   *   responseModalities  → setup.generationConfig.responseModalities
   *   speechConfig        → setup.generationConfig.speechConfig      ← line 23384
   *   systemInstruction   → setup.systemInstruction
   *   inputAudioTranscription  → setup.inputAudioTranscription
   *   outputAudioTranscription → setup.outputAudioTranscription
   *
   * v5.32.53 fixes speechConfig, which this code had at setup.speechConfig —
   * one level too high. The Live socket does not reject an unknown field there;
   * it just ignores it, so the session opened happily and spoke in the default
   * voice. And because systemInstruction WAS in the right place, the
   * interviewer's NAME arrived correctly while the VOICE never did. That pair
   * of symptoms — right name, wrong voice — is the fingerprint of this bug, and
   * it survived five releases because the test harness's fake server accepted
   * any shape at all instead of modelling Google's.
   */
  function buildSetup(model, unpinnedInstruction, voiceName, flags) {
    return {
      setup: {
        model: model.indexOf('models/') === 0 ? model : 'models/' + model,
        // EXPERIMENT (manualVad): turn the server's VAD off and signal turns
        // ourselves from the client-side utterance detector. Field path per
        // the Live API docs: setup.realtimeInputConfig.automaticActivityDetection.
        ...(flags && flags.manualVad
          ? { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } }
          : {}),
        generationConfig: {
          responseModalities: ['AUDIO'],
          // NOT setup.speechConfig. See the note above.
          ...(voiceName
            ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } } } }
            : {})
        },
        // Present ONLY when the server could not pin the persona into the
        // token (grant.pinned === false). The voice above is sent
        // unconditionally; this one is not,
        // because the instruction is a security boundary (this page runs in the
        // interviewee's browser) and the voice is not.
        ...(unpinnedInstruction ? { systemInstruction: { parts: [{ text: unpinnedInstruction }] } } : {}),
        // Both directions transcribed: the transcript IS the product here —
        // it feeds scoring, synthesis, the scorecard and the client deck.
        // Without these the interview would be audio nobody can analyse.
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    };
  }

  function buildAudioFrame(pcm16, legacy) {
    var blob = {
      data: bytesToBase64(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)),
      mimeType: 'audio/pcm;rate=' + INPUT_RATE
    };
    // EXPERIMENT (legacyChunks): the pre-2025 field. See readFlags().
    return { realtimeInput: legacy ? { mediaChunks: [blob] } : { audio: blob } };
  }

  /**
   * RMS and peak of one capture frame (v5.34.22).
   *
   * "mic: N frames sent" proved the uplink was FLOWING and nothing else. A
   * frame counter climbs identically for a microphone carrying speech, a
   * muted input device, a track the OS has silenced, and a capture graph
   * wired to the wrong node — the four cases the S1 investigation could not
   * tell apart. Level is the number that separates them, and it is the only
   * client-side fact that says whether the model COULD have heard anything.
   */
  function frameStats(float32) {
    var sum = 0, peak = 0, n = float32.length;
    for (var i = 0; i < n; i++) {
      var s = float32[i];
      var a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      sum += s * s;
    }
    return { rms: n ? Math.sqrt(sum / n) : 0, peak: peak };
  }
  /** Above this RMS a frame is treated as carrying speech-level audio. A
   *  quiet room on a laptop mic with AGC sits around 0.001-0.005. */
  var SPEECH_RMS = 0.01;
  /** Below this for SILENT_WARN_MS while unmuted, the uplink is declared dead. */
  // v5.34.23: 0.0005 was too tight — Chrome's noise suppression parks a quiet
  // room at 0.0002-0.0008 between sentences, which tripped this a few seconds
  // after every answer. Genuine silence (a muted/wrong device) sits at 0.0001
  // with a peak under 0.003 and stays there.
  var SILENT_RMS = 0.0003;
  var SILENT_PEAK = 0.005;
  // Both overridable ONLY so tests can exercise the watchdogs without waiting
  // out the real windows (the same reason VYNE_OPEN_RETRY_MS exists).
  var SILENT_WARN_MS = Number(window.VYNE_MIC_SILENT_WARN_MS) || 15000;
  /** Uplink bytes queued in the browser above this many seconds of audio is a
   *  conversation that has already stopped being live; say so, then shed. */
  var BACKLOG_WARN_SEC = 1;
  var BACKLOG_DROP_SEC = 3;
  /** No serverContent this long after the user's speech was transcribed is
   *  the shape of a turn the model heard and never answered. */
  var REPLY_WATCHDOG_MS = Number(window.VYNE_REPLY_WATCHDOG_MS) || 12000;
  /** Client-side utterance (≥ this long) with no server reaction inside
   *  IGNORED_WATCHDOG_MS → the server is not treating our audio as speech. */
  var IGNORED_MIN_UTTERANCE_MS = 1000;
  /** Quiet this long closes a client-side utterance. */
  var UTTERANCE_GAP_MS = Number(window.VYNE_UTTERANCE_GAP_MS) || 1200;
  var IGNORED_WATCHDOG_MS = Number(window.VYNE_IGNORED_WATCHDOG_MS) || 8000;
  /** Uplink capture ring, seconds of 16 kHz PCM16 — "hear what the model hears". */
  var CAPTURE_SECONDS = 30;

  /*
   * EXPERIMENT FLAGS (v5.34.23). A production trace showed 17 s of speech-level
   * uplink audio and NOTHING back from the server — no inputTranscription, no
   * model frame — then a reply a long time later. The three server-side
   * explanations (uplink too quiet for its VAD; its VAD never closing the
   * turn; a turn it only closes on an explicit signal) each have a cheap
   * client-side test, and none of them can be run from the console without a
   * hard reload — which forgets window.* — so the flags persist in
   * localStorage. DevTools:
   *     vyneLiveFlags()                              // show
   *     vyneLiveFlags({ micGain: 3 })                // amplify the uplink ×3
   *     vyneLiveFlags({ streamEnd: true })           // audioStreamEnd after each utterance
   *     vyneLiveFlags({ manualVad: true })           // client sends activityStart/End
   *     vyneLiveFlags(null)                          // clear
   * All default OFF: with none set the wire is identical to 5.34.22.
   */
  var FLAGS_KEY = 'VYNE_LIVE_FLAGS';
  function readFlags() {
    var f = {};
    try { var raw = window.localStorage && window.localStorage.getItem(FLAGS_KEY); if (raw) f = JSON.parse(raw) || {}; } catch (e) {}
    try { var w = window.VYNE_LIVE_FLAGS; if (w && typeof w === 'object') for (var k in w) f[k] = w[k]; } catch (e) {}
    return {
      micGain: Number(f.micGain) > 0 ? Number(f.micGain) : 1,
      streamEnd: !!f.streamEnd,
      manualVad: !!f.manualVad,
      // v5.34.24 — three more, each aimed at the server's TURN state, which the
      // 5.34.23 trace pinned as the failure (level fine, backlog 0, no reaction):
      //   legacyChunks:          send audio as realtimeInput.mediaChunks[] (the
      //                          older field) instead of realtimeInput.audio —
      //                          this endpoint IGNORES unknown fields silently
      //                          (see the speechConfig note in buildSetup).
      //   openingViaRealtime:    send text turns as realtimeInput.text instead
      //                          of a clientContent turn, so the session never
      //                          mixes the two input paths.
      //   holdMicUntilFirstTurn: send no mic audio until the opening turn has
      //                          completed — no realtime audio during a
      //                          clientContent-driven generation.
      legacyChunks: !!f.legacyChunks,
      openingViaRealtime: !!f.openingViaRealtime,
      holdMicUntilFirstTurn: !!f.holdMicUntilFirstTurn,
      // v5.34.25 — v1alpha: connect the constrained service on v1alpha first.
      // Google's own SDK routes EVERY ephemeral-token session to
      // `v1alpha.GenerativeService.BidiGenerateContentConstrained` and warns
      // that token support exists in v1alpha only; the token itself is minted
      // at /v1alpha/auth_tokens. We connect on v1beta because it was the first
      // variant that reached setupComplete — but "reaches setupComplete and
      // speaks the opening" is not "treats realtime audio as a turn", which is
      // exactly the half that has never worked, and v1alpha was never tried.
      v1alpha: !!f.v1alpha,
      // v5.34.26: v1alpha is now the DEFAULT order (see variantOrder); this
      // flag restores the 5.34.14–5.34.25 order (v1beta first) for comparison.
      v1beta: !!f.v1beta
    };
  }
  function anyFlag(f) {
    return !!(f && (f.micGain !== 1 || f.streamEnd || f.manualVad || f.legacyChunks || f.openingViaRealtime || f.holdMicUntilFirstTurn || f.v1alpha || f.v1beta));
  }
  /**
   * The variant sweep order for this session's flags.
   *
   * v5.34.26: v1alpha FIRST by default. Four production traces on v1beta show
   * the same thing: the token-pinned session reaches setupComplete and answers a
   * text turn, then treats 15-24 s of speech-level realtime audio as nothing and
   * emits no transcription of its own speech. Google's SDK routes every
   * ephemeral-token session to v1alpha and warns token support is v1alpha-only;
   * the token is minted at /v1alpha/auth_tokens. v1beta was chosen in 5.34.14
   * purely because it connected first. If v1alpha fails to connect, the sweep
   * continues to v1beta exactly as before, at the cost of one attempt.
   */
  function variantOrder(flags) {
    var preferAlpha = !(flags && flags.v1beta);
    var a = [], b = [];
    for (var i = 0; i < WS_VARIANTS.length; i++) (WS_VARIANTS[i].v === 'v1alpha' ? a : b).push(WS_VARIANTS[i]);
    return preferAlpha ? a.concat(b) : b.concat(a);
  }
  window.vyneLiveFlags = function (set) {
    try {
      if (set === null) window.localStorage.removeItem(FLAGS_KEY);
      else if (set && typeof set === 'object') {
        var cur = {}; try { cur = JSON.parse(window.localStorage.getItem(FLAGS_KEY) || '{}') || {}; } catch (e) {}
        for (var k in set) cur[k] = set[k];
        window.localStorage.setItem(FLAGS_KEY, JSON.stringify(cur));
      }
    } catch (e) {}
    var f = readFlags();
    try { console.log('[vyneLiveFlags] ' + JSON.stringify(f) + (set !== undefined ? ' — hard-reload (⌘⇧R) to apply' : '')); } catch (e) {}
    return f;
  };

  /**
   * Normalise one server frame into the few things the UI cares about.
   * Kept pure and separate from the socket so the protocol shape can be tested
   * without a network, and so a shape change surfaces in one place.
   */
  function parseServerFrame(msg) {
    var out = { audio: [], userText: '', agentText: '', modelText: '', anyModelActivity: false,
                interrupted: false, turnComplete: false, generationComplete: false, usage: null };
    if (!msg) return out;
    var sc = msg.serverContent;
    if (sc) {
      if (sc.generationComplete) out.generationComplete = true;
      /*
       * v5.34.19: ANY serverContent means the model is working on our turn.
       *
       * This distinction cost fifteen seconds of every interview. On a long
       * opening the native-audio model reasons IN TEXT first — modelTurn parts
       * carrying text rather than inlineData audio — and this parser dropped
       * those parts entirely. So the only two signals of life, `audio` and
       * `agentText` (which is the output TRANSCRIPT, and only exists once
       * speech starts), both stayed empty while the model was plainly busy.
       *
       * The opening retry read that as "the turn was dropped" and resent it —
       * four times, at +24s, +27s, +30s, +33s — and each resend RESTARTED the
       * model's reasoning ("Restarting the Introduction", "Re-initiating the
       * Discussion"). The retry meant to rescue a silent start was extending it.
       */
      out.anyModelActivity = true;
      if (sc.interrupted) out.interrupted = true;
      if (sc.turnComplete) out.turnComplete = true;
      if (sc.inputTranscription && sc.inputTranscription.text) out.userText = sc.inputTranscription.text;
      if (sc.outputTranscription && sc.outputTranscription.text) out.agentText = sc.outputTranscription.text;
      var parts = sc.modelTurn && sc.modelTurn.parts;
      if (parts) {
        for (var i = 0; i < parts.length; i++) {
          var d = parts[i].inlineData;
          if (d && d.data && String(d.mimeType || '').indexOf('audio') === 0) out.audio.push(d.data);
          // The model's own text on an AUDIO session is its reasoning, not
          // speech. Surfaced so the UI can say "preparing", and so the retry can
          // tell a thinking model from a dropped turn — but deliberately NOT
          // merged into agentText, which is the spoken transcript and feeds
          // scoring, the on-screen bubbles and the client deliverable.
          else if (parts[i].text) out.modelText += parts[i].text;
        }
      }
    }
    if (msg.usageMetadata) out.usage = msg.usageMetadata;
    return out;
  }

  /**
   * Log EVERY server frame, classified.
   *
   * The distinction that matters most is audio-vs-text: a native-audio model
   * answering an instructional turn in TEXT is a silent interview that looks,
   * from every other angle, like a working session. The second is "no frames at
   * all", which is what a dropped turn looks like and is invisible without this.
   *
   * Anything we do not recognise is logged by its top-level keys rather than
   * dropped, because the frame shape is Google's to change and a new envelope
   * would otherwise present as silence.
   */
  /**
   * Emit the pending audio-frame rollup, if any.
   *
   * Audio arrives ~20 frames a second. Logging each one buried every event that
   * matters — the pause, the close, the teardown — under hundreds of identical
   * lines, which is exactly the report this addresses. Audio-only frames are
   * counted instead, and the count is flushed when something INTERESTING
   * happens or when the run gets long, so "the agent spoke for 12 seconds"
   * costs one line rather than 240.
   */
  function _flushAudioRun(sess) {
    if (!sess._audioRun || !sess._audioRun.n) return;
    vlog('frame AUDIO x' + sess._audioRun.n + ' (rolled up)', {
      b64Bytes: sess._audioRun.bytes,
      spanMs: Date.now() - sess._audioRun.startedAt
    });
    sess._audioRun = null;
  }

  function _traceFrame(sess, msg) {
    if (window.VYNE_LIVE_DEBUG === false) return;
    if (!msg || typeof msg !== 'object') { _flushAudioRun(sess); vlog('frame <non-object>', msg); return; }
    if (msg.setupComplete) { vlog('frame setupComplete'); return; }
    var sc = msg.serverContent;
    if (sc) {
      var bits = [], detail = {};
      var parts = (sc.modelTurn && sc.modelTurn.parts) || [];
      var audioN = 0, audioBytes = 0, textParts = [];
      for (var i = 0; i < parts.length; i++) {
        var d = parts[i].inlineData;
        if (d && d.data && String(d.mimeType || '').indexOf('audio') === 0) {
          audioN++; audioBytes += d.data.length;
        } else if (parts[i].text) {
          textParts.push(parts[i].text);
        } else if (d) {
          bits.push('inlineData:' + (d.mimeType || '?'));
        }
      }
      if (audioN) {
        bits.push('AUDIO x' + audioN);
        detail.b64Bytes = audioBytes;
        if (!sess._firstAudioAt) {
          sess._firstAudioAt = Date.now();
          vlog('*** FIRST AUDIO FRAME — the agent is speaking ***',
               { msSinceSetup: sess.startedAt ? (Date.now() - sess.startedAt) : null });
        }
      }
      // A modelTurn carrying TEXT on an AUDIO-modality session is the
      // fingerprint of the model answering an instruction instead of speaking.
      if (textParts.length) { bits.push('MODEL-TEXT (not audio!)'); detail.text = snip(textParts.join(' '), 160); }
      if (sc.outputTranscription && sc.outputTranscription.text) {
        bits.push('agentTranscript'); detail.agent = snip(sc.outputTranscription.text, 60);
      }
      if (sc.inputTranscription && sc.inputTranscription.text) {
        bits.push('userTranscript'); detail.user = snip(sc.inputTranscription.text, 60);
      }
      if (sc.interrupted) bits.push('INTERRUPTED');
      if (sc.turnComplete) bits.push('turnComplete');
      if (sc.generationComplete) bits.push('generationComplete');
      if (!bits.length) bits.push('serverContent(empty) keys=' + Object.keys(sc).join(','));

      // An AUDIO-ONLY frame carries no information the previous one did not.
      // Count it; print the first of a run and then only a periodic rollup.
      var audioOnly = audioN > 0 && bits.length === 1;
      if (audioOnly) {
        if (!sess._audioRun) {
          sess._audioRun = { n: 0, bytes: 0, startedAt: Date.now() };
          vlog('frame AUDIO (run starts; further frames rolled up)');
        }
        sess._audioRun.n++;
        sess._audioRun.bytes += audioBytes;
        if (sess._audioRun.n % 100 === 0) _flushAudioRun(sess);
        return;
      }
      // Anything else is an event worth seeing in sequence, so close the run
      // first — otherwise the rollup would print after the event it preceded.
      _flushAudioRun(sess);
      vlog('frame ' + bits.join(' + '), Object.keys(detail).length ? detail : undefined);
      return;
    }
    _flushAudioRun(sess);
    if (msg.usageMetadata) {
      vlog('frame usageMetadata', { in: msg.usageMetadata.promptTokenCount, out: msg.usageMetadata.responseTokenCount });
      return;
    }
    if (msg.goAway) { vlog('frame goAway (server is closing us)', msg.goAway); return; }
    vlog('frame OTHER keys=' + Object.keys(msg).join(','), snip(JSON.stringify(msg), 200));
  }

  /**
   * Gapless playback queue.
   *
   * Each chunk is scheduled against the context clock rather than played on
   * the previous chunk's `onended`. That event fires on the main thread with
   * millisecond-scale jitter, which is audible as a stutter between chunks —
   * the same class of seam the two-call TTS path has, and the reason this is
   * scheduled arithmetic instead of an event chain.
   */
  function PlaybackQueue(ctx) {
    this.ctx = ctx;
    this.sources = [];
    this.nextAt = 0;
  }
  PlaybackQueue.prototype.push = function (float32) {
    /*
     * v5.34.19: A SUSPENDED OUTPUT CONTEXT IS SILENT, AND SAYS NOTHING.
     *
     * The contexts are resumed exactly once, in _openAudio, and were never
     * looked at again. A context the browser suspends later — Chrome does this
     * to backgrounded or idle contexts, and a pause/resume cycle is precisely
     * when a tab loses focus — keeps accepting scheduled buffers and plays none
     * of them. No error, no exception, no state change anywhere else.
     *
     * That failure is indistinguishable, from the outside, from a healthy
     * session: muted false, isAlive true, socket OPEN, frames arriving, and the
     * MICROPHONE still streaming — because micCtx and outCtx are separate
     * contexts and only one of them went to sleep.
     *
     * So check it here, where the audio actually lands, say so loudly, and try
     * to bring it back. resume() on a running context is a no-op.
     */
    if (this.ctx.state !== 'running') {
      var self0 = this;
      if (!this._suspendedWarned) {
        this._suspendedWarned = true;
        vlog('!!! PLAYBACK CONTEXT NOT RUNNING — audio is arriving but cannot be heard', {
          state: this.ctx.state, queued: this.sources.length
        });
      }
      try {
        this.ctx.resume().then(function () {
          vlog('playback context resumed', { state: self0.ctx.state });
          self0._suspendedWarned = false;
        }).catch(function (e) { vlog('playback context resume FAILED', e && e.message); });
      } catch (e) { vlog('playback context resume THREW', e && e.message); }
    }
    var buf = this.ctx.createBuffer(1, float32.length, OUTPUT_RATE);
    buf.getChannelData(0).set(float32);
    var src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    var now = this.ctx.currentTime;
    // A small floor keeps the first chunk from being scheduled in the past on
    // a context that has been running a while.
    var at = Math.max(now + 0.02, this.nextAt);
    /*
     * v5.34.22: S3 ("all kinds of distortions") was never instrumented. The
     * two ways this queue can distort are (a) a chunk scheduled to START before
     * the previous one ENDS — overlap, heard as garble — and (b) a run where
     * nextAt drifts far ahead of the clock, heard as the agent continuing to
     * talk long after it stopped generating. Neither can happen by
     * construction here, which is exactly why they must be measured rather
     * than assumed: if a trace shows distortion WITHOUT an overlap line, the
     * cause is outside this queue (a second audio source, or the context's
     * sample rate), and that is the whole diagnosis.
     */
    if (this._lastEnd && at < this._lastEnd - 0.001) {
      vlog('!!! PLAYBACK OVERLAP — chunk starts before the previous one ends', {
        startsAt: at, prevEnds: this._lastEnd, overlapMs: Math.round((this._lastEnd - at) * 1000)
      });
    }
    if (!this._runPushes) {
      this._runPushes = 0; this._runStartedAt = Date.now(); this._runFirstAt = at;
      vlog('playback run starts', {
        ctxState: this.ctx.state, ctxRate: this.ctx.sampleRate, bufRate: OUTPUT_RATE,
        resampledByBrowser: this.ctx.sampleRate !== OUTPUT_RATE,
        leadMs: Math.round((at - now) * 1000), samples: float32.length
      });
    }
    this._runPushes++;
    src.start(at);
    this.nextAt = at + buf.duration;
    this._lastEnd = this.nextAt;
    this._aheadSec = this.nextAt - now;
    var self = this;
    src.onended = function () {
      var i = self.sources.indexOf(src);
      if (i >= 0) self.sources.splice(i, 1);
    };
    this.sources.push(src);
  };
  /** BARGE-IN. Everything already scheduled must stop immediately — audio
   *  queued ahead of the clock is speech the user has just talked over, and
   *  letting it finish is exactly what makes an agent feel deaf. */
  PlaybackQueue.prototype.flush = function () {
    if (this.sources.length) {
      vlog('playback flush — stopping scheduled audio', {
        stopped: this.sources.length, ctxState: this.ctx && this.ctx.state,
        unplayedMs: this.ctx ? Math.max(0, Math.round((this.nextAt - this.ctx.currentTime) * 1000)) : null
      });
    }
    for (var i = 0; i < this.sources.length; i++) {
      try { this.sources[i].stop(); } catch (e) { /* already ended */ }
    }
    this.sources = [];
    this.nextAt = 0;
    this.endRun('flush');
  };
  /** Close the per-turn playback rollup (on turnComplete, flush, or stop). */
  PlaybackQueue.prototype.endRun = function (why) {
    if (!this._runPushes) return;
    vlog('playback run ends (' + why + ')', {
      chunks: this._runPushes,
      audioSec: this._lastEnd && this._runFirstAt != null ? Math.round((this._lastEnd - this._runFirstAt) * 10) / 10 : null,
      wallSec: Math.round((Date.now() - this._runStartedAt) / 100) / 10,
      stillQueuedSec: this.ctx ? Math.max(0, Math.round((this._lastEnd - this.ctx.currentTime) * 10) / 10) : null,
      ctxState: this.ctx && this.ctx.state
    });
    this._runPushes = 0; this._lastEnd = 0; this._runFirstAt = null;
  };
  PlaybackQueue.prototype.pending = function () { return this.sources.length; };

  // ── Session ────────────────────────────────────────────────────────────────

  function VyneLiveSession(opts) {
    this.opts = opts || {};
    this.state = 'idle';
    this.ws = null;
    this.grant = null;
    this.micCtx = null;
    this.outCtx = null;
    this.stream = null;
    this.node = null;
    this.queue = null;
    this.timer = null;
    this.startedAt = 0;
    this.usage = { tokensIn: 0, tokensOut: 0 };
    this.closed = false;
  }

  VyneLiveSession.prototype._set = function (s) {
    this.state = s;
    if (this.opts.onState) { try { this.opts.onState(s); } catch (e) {} }
  };

  VyneLiveSession.prototype._fail = function (reason, err) {
    if (this.closed) return;
    if (this.opts.onError) { try { this.opts.onError(reason, err); } catch (e) {} }
    this.stop(reason);
  };

  /** The capture track's own account of itself — the OS can mute a track
   *  (readyState 'live', muted true) and the graph keeps running on zeros. */
  VyneLiveSession.prototype._trackInfo = function () {
    try {
      var t = this.stream && this.stream.getAudioTracks ? this.stream.getAudioTracks()[0] : null;
      if (!t) return 'no-track';
      var s = t.getSettings ? t.getSettings() : {};
      return { readyState: t.readyState, muted: !!t.muted, enabled: t.enabled !== false,
               label: snip(t.label, 40), rate: s.sampleRate, ec: s.echoCancellation, ns: s.noiseSuppression, agc: s.autoGainControl };
    } catch (e) { return 'unavailable'; }
  };

  /**
   * Fold one frame's level into the session's picture of the uplink (v5.34.22).
   *
   * Three outputs, each answering one question a trace could not before:
   *   - `mic: SPEECH on uplink` once per utterance — did the interviewee's
   *     voice reach the socket at all, and when (to line up against the
   *     model's inputTranscription and any reply).
   *   - `!!! mic uplink SILENT` once — frames are flowing but carry nothing.
   *     That is a capture-chain fault (track muted by the OS, wrong device,
   *     a context the browser would not resample into) and no amount of
   *     turn-taking logic will fix it.
   *   - onMicLevel(rms) at ~10 Hz for a visible meter, so a person can see
   *     "the app hears me" without opening DevTools.
   */
  VyneLiveSession.prototype._observeMicLevel = function (st) {
    var now = Date.now();
    this.micRms = st.rms;
    if (!this._micWinAt || now - this._micWinAt >= 5000) { this._micWinAt = now; this._micPeakWindow = 0; }
    if (st.peak > (this._micPeakWindow || 0)) this._micPeakWindow = st.peak;
    if (st.rms >= SPEECH_RMS) {
      this._micSpeechFrames = (this._micSpeechFrames || 0) + 1;
      this._micLastLoudAt = now;
      if (!this._micInUtterance) {
        this._micInUtterance = true;
        this._utteranceStartedAt = now;
        this._uttSum = 0; this._uttN = 0; this._uttPeak = 0;
        this._uttServerActivityBefore = this._lastServerActivityAt || 0;
        if (this.flags && this.flags.manualVad) this._pendingActivityStart = true;
        vlog('mic: SPEECH on uplink (utterance starts)', { rms: Math.round(st.rms * 1e4) / 1e4,
          msSinceTurnComplete: this._lastTurnCompleteAt ? now - this._lastTurnCompleteAt : null,
          agentPlaying: !!(this.queue && this.queue.pending()),
          wsBuffered: (this.ws && this.ws.bufferedAmount) || 0 });
      }
      this._uttSum += st.rms; this._uttN++; if (st.peak > this._uttPeak) this._uttPeak = st.peak;
    } else if (this._micInUtterance && this._micLastLoudAt && now - this._micLastLoudAt > UTTERANCE_GAP_MS) {
      this._micInUtterance = false;
      // Audio time, not wall time: loud frames × frame length. Identical in a
      // browser, and it is what the ≥1 s threshold actually means.
      var uttMs = (this._uttN || 0) * (FRAME_SAMPLES / INPUT_RATE) * 1000;
      var uttStats = { speechSec: Math.round(uttMs / 100) / 10, meanRms: this._uttN ? Math.round(this._uttSum / this._uttN * 1e4) / 1e4 : 0,
                       peak: Math.round((this._uttPeak || 0) * 1e3) / 1e3, gain: (this.flags && this.flags.micGain) || 1,
                       wsBuffered: (this.ws && this.ws.bufferedAmount) || 0 };
      vlog('mic: utterance ends (~' + uttStats.speechSec + 's of speech)', uttStats);
      var fl = this.flags || {};
      var pe = { activityEnd: !!(fl.manualVad && (this._activityOpen || this._pendingActivityStart)),
                 streamEnd: !!(fl.streamEnd && uttMs >= IGNORED_MIN_UTTERANCE_MS) };
      this._pendingActivityStart = false;
      if (pe.activityEnd || pe.streamEnd) this._pendingUtteranceEnd = pe;
      this._armIgnoredWatchdog(uttMs, uttStats);
    }
    if (st.rms > SILENT_RMS || st.peak > SILENT_PEAK) { this._micLastNonSilentAt = now; this._micSilentWarned = false; }
    else if (!this._micLastNonSilentAt) this._micLastNonSilentAt = now;
    var quietSince = Math.max(this._micLastNonSilentAt, this._micLastLoudAt || 0);
    if (!this._micSilentWarned && now - quietSince > SILENT_WARN_MS) {
      this._micSilentWarned = true;
      vlog('!!! mic uplink SILENT for ' + Math.round(SILENT_WARN_MS / 1000) + 's while unmuted — frames flow but carry no audio; the model cannot hear', {
        rms: st.rms, micCtx: this.micCtx && { state: this.micCtx.state, rate: this.micCtx.sampleRate }, track: this._trackInfo()
      });
      if (this.opts.onMicSilent) { try { this.opts.onMicSilent(this._trackInfo()); } catch (e) {} }
    }
    if (this.opts.onMicLevel && (!this._micLevelAt || now - this._micLevelAt >= 100)) {
      this._micLevelAt = now;
      try { this.opts.onMicLevel(st.rms, st.peak); } catch (e) {}
    }
  };
  /** Latest capture-frame RMS (0..1); 0 before the first frame. */
  VyneLiveSession.prototype.micLevel = function () { return this.micRms || 0; };

  /** Keep the last CAPTURE_SECONDS of what actually went on the wire. */
  VyneLiveSession.prototype._capture = function (pcm16) {
    if (!this._cap) { this._cap = new Int16Array(INPUT_RATE * CAPTURE_SECONDS); this._capPos = 0; this._capFilled = 0; }
    var n = pcm16.length, cap = this._cap, L = cap.length;
    for (var i = 0; i < n; i++) { cap[this._capPos] = pcm16[i]; this._capPos = (this._capPos + 1) % L; }
    this._capFilled = Math.min(L, this._capFilled + n);
  };
  /** The captured uplink, oldest first, as Int16Array (last `seconds`). */
  VyneLiveSession.prototype.capturedUplink = function (seconds) {
    if (!this._cap || !this._capFilled) return new Int16Array(0);
    var want = Math.min(this._capFilled, Math.round((seconds || CAPTURE_SECONDS) * INPUT_RATE));
    var out = new Int16Array(want), L = this._cap.length;
    var start = (this._capPos - want + L) % L;
    for (var i = 0; i < want; i++) out[i] = this._cap[(start + i) % L];
    return out;
  };

  /**
   * The line the 5.34.22 trace could not write (v5.34.23). It tracked "the
   * model transcribed you and did not answer" — but the failing session never
   * got as far as a transcription. This one starts from OUR side: an utterance
   * of speech-level audio went up; did the server react AT ALL — transcription,
   * thinking, audio, anything — within a few seconds of it ending? If not, the
   * server is not treating what we send as speech, and the utterance stats
   * say whether that is a level problem (meanRms well under 0.05) or not.
   */
  VyneLiveSession.prototype._armIgnoredWatchdog = function (uttMs, stats) {
    var self = this;
    if (uttMs < IGNORED_MIN_UTTERANCE_MS || this.muted) return;
    var uttStartedAt = this._utteranceStartedAt;
    if (this._ignoredWatchdog) clearTimeout(this._ignoredWatchdog);
    this._ignoredWatchdog = setTimeout(function () {
      self._ignoredWatchdog = null;
      if (self.closed || self.muted) return;
      var reacted = (self._lastServerActivityAt || 0) > uttStartedAt;
      if (reacted) return;
      vlog('!!! SERVER IGNORED ~' + stats.speechSec + 's of speech-level uplink — no transcription, no thinking, no audio ' +
           Math.round(IGNORED_WATCHDOG_MS / 1000) + 's after it ended', {
        utterance: stats,
        verdict: stats.meanRms < 0.02 ? 'uplink is QUIET (meanRms < 0.02) — try vyneLiveFlags({micGain:3})'
                                     : 'level is fine — server-side turn detection; try vyneLiveFlags({streamEnd:true}) then ({manualVad:true})',
        flags: self.flags, micCtx: self.micCtx && { state: self.micCtx.state, rate: self.micCtx.sampleRate },
        preSetupFramesDropped: self._preSetupFrames || 0, track: self._trackInfo()
      });
      if (self.opts.onUplinkIgnored) { try { self.opts.onUplinkIgnored(stats); } catch (e) {} }
    }, IGNORED_WATCHDOG_MS);
  };

  /**
   * Per-turn reply tracking (v5.34.22). The trace could show every frame and
   * still not answer "did the model reply to what was just said" — because
   * it never related the model's frames to the USER's. This does:
   *   inputTranscription  → the model heard something; arm a watchdog.
   *   any modelTurn/turnComplete afterwards → disarm, log latency.
   *   watchdog fires → the one line that pins S1 to the server side.
   */
  VyneLiveSession.prototype._noteUserTranscript = function (text) {
    var self = this, now = Date.now();
    this._lastUserTextAt = now;
    if (!this._awaitingReply) {
      this._awaitingReply = true;
      this._userTurnStartedAt = now;
      this._replyTurnNo = (this._replyTurnNo || 0) + 1;
      vlog('USER TURN #' + this._replyTurnNo + ' — model transcribed the interviewee; awaiting its reply', {
        text: snip(text, 60), agentPlaying: !!(this.queue && this.queue.pending()) });
    }
    if (this._replyWatchdog) clearTimeout(this._replyWatchdog);
    this._replyWatchdog = setTimeout(function () {
      self._replyWatchdog = null;
      if (!self._awaitingReply || self.closed) return;
      vlog('!!! NO MODEL ACTIVITY ' + Math.round(REPLY_WATCHDOG_MS / 1000) + 's after the interviewee was transcribed — the model heard a turn and did not answer it', {
        turn: self._replyTurnNo, muted: !!self.muted, wsState: rs(self.ws),
        micRms: Math.round((self.micRms || 0) * 1e4) / 1e4, micInUtterance: !!self._micInUtterance,
        hint: 'VAD end-of-turn may not be firing (continuous noise/echo on the uplink keeps the turn open), or the server dropped the turn'
      });
      if (self.opts.onNoReply) { try { self.opts.onNoReply(self._replyTurnNo); } catch (e) {} }
    }, REPLY_WATCHDOG_MS);
  };
  VyneLiveSession.prototype._noteModelActivity = function (f) {
    var now = Date.now();
    if (this._awaitingReply && (f.modelText || f.audio.length || f.agentText || f.turnComplete)) {
      this._awaitingReply = false;
      if (this._replyWatchdog) { clearTimeout(this._replyWatchdog); this._replyWatchdog = null; }
      vlog('model ACTIVITY on user turn #' + this._replyTurnNo + ' (' + (now - this._userTurnStartedAt) + 'ms after transcript began; ' +
           (now - this._lastUserTextAt) + 'ms after last fragment)', {
        kind: f.audio.length ? 'audio' : (f.modelText ? 'thinking-text' : (f.agentText ? 'transcript' : 'turnComplete')) });
    }
    // Per-turn state for the UI: thinking → speaking → idle. Session-level
    // _gotAgentFrame stays as it is (the opening retry depends on it).
    if (f.modelText && !this._turnAudio && this._turnState !== 'thinking') this._setTurnState('thinking');
    if (f.audio.length && !this._turnAudio) {
      this._turnAudio = true;
      this._turnFirstAudioAt = now;
      if (this._replyTurnNo && this._userTurnStartedAt && !this._loggedTurnAudio) {
        vlog('reply FIRST AUDIO for user turn #' + this._replyTurnNo, { msAfterUserTurn: now - this._userTurnStartedAt });
      }
      this._loggedTurnAudio = true;
      this._setTurnState('speaking');
    }
    if (f.turnComplete) {
      this._lastTurnCompleteAt = now;
      vlog('model turn ENDS', { turnHadAudio: !!this._turnAudio, playbackPending: this.queue ? this.queue.pending() : null,
        msSinceLastUtteranceEnd: this._micLastLoudAt ? now - this._micLastLoudAt : null });
      if (this.queue) this.queue.endRun('turnComplete');
      this._turnAudio = false; this._loggedTurnAudio = false;
      this._setTurnState('idle');
    }
  };
  VyneLiveSession.prototype._setTurnState = function (s) {
    if (this._turnState === s) return;
    this._turnState = s;
    if (this.opts.onTurnState) { try { this.opts.onTurnState(s); } catch (e) {} }
  };

  VyneLiveSession.prototype.start = function () {
    var self = this;
    vlog('session.start() called', { module: this.opts.module, voice: this.opts.voice, interviewer: this.opts.interviewerName });
    window.__vyneLiveCurrent = this;   // for vyneLiveMicCheck()
    this.flags = readFlags();
    if (anyFlag(this.flags)) vlog('EXPERIMENT FLAGS ACTIVE', this.flags);
    this._set('connecting');

    // 1. Ask OUR server for a grant. This is where the budget check, the
    //    concurrency cap and the reservation happen — see routes/voice.ts.
    // v5.34.0: voice runs on the generation lane (window.vyneLlmBase), which
    // defaults to same-origin when unset — so bare '/api/...' behaviour is kept.
    return fetch((window.vyneLlmBase ? window.vyneLlmBase() : '') + '/api/voice/live-session', {
      method: 'POST',
      headers: window.vyneAuthHeaders
        ? window.vyneAuthHeaders()
        : { 'content-type': 'application/json' },
      body: JSON.stringify({
        module: self.opts.module || 'interview_agent',
        clientName: self.opts.clientName || undefined,
        context: self.opts.context || undefined,
        intervieweeName: self.opts.intervieweeName || undefined,
        intervieweeRole: self.opts.intervieweeRole || undefined,
        industry: self.opts.industry || undefined,
        voice: self.opts.voice || undefined,
        interviewerName: self.opts.interviewerName || undefined,
        // v5.34.24: the server pins this into the token (the client's own
        // setup frame is not reliably honoured on the constrained endpoint).
        manualVad: self.flags && self.flags.manualVad ? true : undefined
      })
    }).then(function (r) {
      if (!r.ok) {
        // A refusal here is normal and meaningful: over budget, too many
        // concurrent sessions, free-tier key, or not configured at all. The
        // caller falls back to the existing text + TTS path rather than
        // failing the interview.
        return r.json().catch(function () { return {}; }).then(function (b) {
          // The refusal reason is the whole story on a reconnect: every
          // pause/resume cycle mints a FRESH grant, and a user is capped at a
          // few open grants inside a rolling window (routes/voice.ts), so a
          // session that will not come back after a second or third pause looks
          // exactly like this line and nothing else.
          vlog('grant REFUSED by our server', { status: r.status, error: b.error, detail: b.detail });
          var e = new Error(b.error || ('live_session_http_' + r.status));
          e.code = b.error; e.status = r.status;
          throw e;
        });
      }
      return r.json();
    }).then(function (grant) {
      self.grant = grant;
      vlog('grant minted', { model: grant.model, voice: grant.voice, pinned: grant.pinned,
                             thinkingBudget: grant.thinkingBudget, pinnedExtras: grant.pinnedExtras,
                             maxSeconds: grant.maxSeconds, sessionId: grant.sessionId,
                             frontend: window.VYNE_VERSION || '?' });
      // v5.34.26: a frontend deployed without its API is a silent half-build.
      // The 5.34.24+ route always returns pinnedExtras; its absence means the
      // API service is still on an older build and NONE of the token-side
      // changes (transcription pin, manual VAD, thinking budget) are in effect.
      if (grant.pinnedExtras === undefined) {
        vlog('!!! API BUILD MISMATCH — the API service is older than 5.34.24: no pinnedExtras in the grant. Redeploy the API (deploy.sh api).');
        if (self.opts.onApiMismatch) { try { self.opts.onApiMismatch(); } catch (e) {} }
      }
      return self._openAudio();
    }).then(function () {
      // The token's shape decides the endpoint, but the mint fallback means we
      // cannot always be sure which shape we got. Try the constrained endpoint
      // first, then the standard one, rather than failing on a guess.
      // Walk the candidates until one reaches setupComplete. Each attempt is
      // short so the whole sweep stays inside a few seconds of user patience.
      var i = 0;
      var variants = variantOrder(self.flags);
      function attempt() {
        if (self.closed) return Promise.reject(new Error('cancelled'));
        var variant = variants[i];
        vlog('ws variant attempt ' + (i + 1) + '/' + variants.length, variantLabel(variant));
        if (self.opts.onNote) { try { self.opts.onNote('trying ' + variantLabel(variant) + '…'); } catch (e) {} }
        return self._openSocket(variant, 8000).then(function (r) {
          self.variant = variantLabel(variant);
          vlog('ws variant CONNECTED', self.variant);
          if (self.opts.onNote) { try { self.opts.onNote('connected via ' + self.variant); } catch (e) {} }
          return r;
        }).catch(function (err) {
          vlog('ws variant failed', { variant: variantLabel(variant), err: err && err.message });
          try { if (self.ws) { self.ws.onclose = null; self.ws.onerror = null; self.ws.close(); } } catch (e) {}
          i++;
          if (i >= variants.length || self.closed) throw err;
          return attempt();
        });
      }
      return attempt();
    }).catch(function (err) {
      if (self.opts.onFallback) { try { self.opts.onFallback(err); } catch (e) {} }
      self._fail(err && err.code ? err.code : 'live_unavailable', err);
      throw err;
    });
  };

  VyneLiveSession.prototype._openAudio = function () {
    var self = this;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('audio_unsupported'));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // The model does its own turn detection, and browser processing that
        // suppresses "noise" also clips the front of a quiet answer — which in
        // an interview is exactly the hesitant sentence you most want.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    }).then(async function (stream) {
      self.stream = stream;
      // Ask for the protocol rates directly so the hot path does no resampling.
      self.micCtx = new AC({ sampleRate: INPUT_RATE });
      self.outCtx = new AC({ sampleRate: OUTPUT_RATE });
      self.queue = new PlaybackQueue(self.outCtx);

      // CRITICAL. Both contexts are constructed AFTER `await fetch(...)`, so we
      // are no longer inside the user-gesture callstack and Chrome starts them
      // in the "suspended" state. A suspended context never fires
      // onaudioprocess (so no microphone frames are ever sent) and never plays
      // a scheduled buffer (so the model's speech is silent). Both failures are
      // completely silent — no error, no warning — which is what makes this
      // worth the explicit resume and the state check below.
      try { await self.micCtx.resume(); } catch (e) {}
      try { await self.outCtx.resume(); } catch (e) {}
      vlog('audio contexts opened', { micState: self.micCtx.state, micRate: self.micCtx.sampleRate,
                                      outState: self.outCtx.state, outRate: self.outCtx.sampleRate });
      if (self.micCtx.state !== 'running' || self.outCtx.state !== 'running') {
        // Surface it rather than producing a session that looks connected and
        // is deaf and mute.
        throw new Error('audio_context_suspended');
      }

      var src = self.micCtx.createMediaStreamSource(stream);
      var node = self.micCtx.createScriptProcessor(FRAME_SAMPLES, 1, 1);
      self.node = node;
      node.onaudioprocess = function (ev) {
        if (self.closed || !self.ws || self.ws.readyState !== 1) return;
        /*
         * v5.34.23: nothing on the uplink before setupComplete. The contexts are
         * opened BEFORE the socket, so this handler is already firing when the
         * socket opens, and the first frame used to leave in the ~130 ms between
         * our setup message and the server's setupComplete. Google's own client
         * never sends realtime input until connect() resolves; a frame the
         * server receives mid-setup is at best dropped and at worst the reason
         * a session's realtime input is never treated as speech.
         */
        if (self.state !== 'live') { self._preSetupFrames = (self._preSetupFrames || 0) + 1; return; }
        // EXPERIMENT (holdMicUntilFirstTurn): no realtime audio while the
        // opening (a clientContent turn) is still being generated/spoken.
        if (self.flags && self.flags.holdMicUntilFirstTurn && !self._lastTurnCompleteAt) {
          self._heldForFirstTurn = (self._heldForFirstTurn || 0) + 1;
          if (self._heldForFirstTurn === 1) vlog('EXPERIMENT: holding mic audio until the first turn completes');
          return;
        }
        // v5.34.21: keepalive while paused. A muted session used to send
        // NOTHING (return on self.muted), so the socket went idle and the
        // SERVER closed it — pause tore the whole session down, Resume had
        // to re-mint, and after a few cycles the concurrency cap refused it
        // (the 'stops after the Nth pause' bug). Instead, while muted, keep
        // the socket warm with a low-rate SILENT frame (all zeros): the
        // uplink stays alive, the model hears quiet (not an interruption),
        // and Resume simply unmutes a still-living session — no teardown,
        // no re-mint, no cap.
        if (self.muted) {
          var nowTs = Date.now();
          if (!self._lastKeepAlive || (nowTs - self._lastKeepAlive) >= 2000) {
            self._lastKeepAlive = nowTs;
            try {
              var silent = new Int16Array(FRAME_SAMPLES); // zero-filled = silence
              self.ws.send(JSON.stringify(buildAudioFrame(silent, self.flags && self.flags.legacyChunks)));
              if (!self._keepAliveLogged) { self._keepAliveLogged = true; vlog('paused — sending silent keepalive frames to hold the socket'); }
            } catch (e) { /* socket closing — close handler tidies up */ }
          }
          return;
        }
        var input = ev.inputBuffer.getChannelData(0);
        // EXPERIMENT (micGain): amplify before everything else, so the level
        // trace, the capture ring and the wire all see the same audio.
        var gain = (self.flags && self.flags.micGain) || 1;
        if (gain !== 1) {
          var amp = new Float32Array(input.length);
          for (var gi = 0; gi < input.length; gi++) {
            var gv = input[gi] * gain;
            amp[gi] = gv > 1 ? 1 : (gv < -1 ? -1 : gv);
          }
          input = amp;
        }
        // v5.34.22: LEVEL, not just count. See frameStats().
        var st = frameStats(input);
        self._observeMicLevel(st);
        // Mic frames leave every ~128ms, so log the first and then sparsely.
        // They matter here for one reason: uplink audio is what the model's
        // activity detection can INTERRUPT a turn on, so a dropped opening
        // needs to be readable against what the microphone was sending.
        self._micFrames = (self._micFrames || 0) + 1;
        if (self._micFrames === 1) vlog('mic: first frame sent to socket', { rms: st.rms, peak: st.peak, track: self._trackInfo() });
        else if (self._micFrames % 40 === 0) vlog('mic: ' + self._micFrames + ' frames sent (~' +
          Math.round(self._micFrames * FRAME_SAMPLES / INPUT_RATE) + 's of uplink audio)', {
            rms: Math.round(st.rms * 1e4) / 1e4, peakLast5s: Math.round(self._micPeakWindow * 1e3) / 1e3,
            speechFrames: self._micSpeechFrames || 0,
            wsBuffered: self.ws.bufferedAmount || 0, backlogSec: Math.round((self._backlogSec || 0) * 10) / 10
          });
        // Verified, not assumed — see the header note on Safari.
        var pcmF = self.micCtx.sampleRate === INPUT_RATE
          ? input
          : resampleTo(input, self.micCtx.sampleRate, INPUT_RATE);
        var pcm16 = floatTo16BitPCM(pcmF);
        self._capture(pcm16);
        /*
         * v5.34.23: IS THE UPLINK ACTUALLY LEAVING THE BROWSER IN REAL TIME?
         *
         * A production trace (5.34.22) showed: a 7 s answer, then NOTHING from
         * the server for 50 s, then an `interrupted` on a turn that never
         * produced a frame, then a reply, then a second `interrupted` while our
         * microphone was measurably silent. Every one of those is what a
         * DELAYED uplink looks like from the client: the server hears each
         * utterance late, replies late, and "interrupts" the model with speech
         * that ended ten seconds earlier. ws.bufferedAmount is the bytes the
         * browser has NOT yet handed to the network — the one number that
         * separates "the network/server is not draining our audio" from
         * "Google's pipeline is slow after it has our audio". And past a few
         * seconds of backlog, a late frame is worse than a lost one: shed.
         */
        var buffered = self.ws.bufferedAmount || 0;
        var bps = self._frameBytes ? self._frameBytes * (INPUT_RATE / FRAME_SAMPLES) : 0;
        var backlogSec = bps ? buffered / bps : 0;
        self._backlogSec = backlogSec;
        if (backlogSec >= BACKLOG_WARN_SEC && !self._backlogWarned) {
          self._backlogWarned = true;
          vlog('!!! UPLINK BACKLOG — ' + (Math.round(backlogSec * 10) / 10) + 's of audio is queued in the browser, not yet on the network', {
            bufferedBytes: buffered, frameBytes: self._frameBytes, hint: 'the server hears you late; replies and interruptions will all be late' });
        } else if (backlogSec < BACKLOG_WARN_SEC / 2 && self._backlogWarned) {
          self._backlogWarned = false;
          vlog('uplink backlog drained', { droppedFrames: self._droppedFrames || 0 });
        }
        if (backlogSec >= BACKLOG_DROP_SEC) {
          self._droppedFrames = (self._droppedFrames || 0) + 1;
          if (self._droppedFrames === 1 || self._droppedFrames % 40 === 0) vlog('uplink SHEDDING frames (backlog ' + (Math.round(backlogSec * 10) / 10) + 's) — dropped ' + self._droppedFrames + ' so far');
          return;
        }
        try {
          // EXPERIMENT (manualVad): the utterance detector decided a turn just
          // began — say so BEFORE the frame that begins it.
          if (self._pendingActivityStart) {
            self._pendingActivityStart = false; self._activityOpen = true;
            self.ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
            vlog('EXPERIMENT: sent activityStart');
          }
          var wire = JSON.stringify(buildAudioFrame(pcm16, self.flags.legacyChunks));
          self._frameBytes = wire.length;
          self.ws.send(wire);
          var pe = self._pendingUtteranceEnd;
          if (pe) {
            self._pendingUtteranceEnd = null;
            if (pe.activityEnd) { self._activityOpen = false; self.ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } })); vlog('EXPERIMENT: sent activityEnd'); }
            if (pe.streamEnd) { self.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); vlog('EXPERIMENT: sent audioStreamEnd'); }
          }
        } catch (e) { /* socket closing — the close handler will tidy up */ }
      };
      src.connect(node);
      // A ScriptProcessor only fires while connected to a destination. Routing
      // it through a zero gain keeps it alive without echoing the interviewee's
      // own microphone back at them.
      var mute = self.micCtx.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(self.micCtx.destination);
    });
  };

  VyneLiveSession.prototype._openSocket = function (variant, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var url = wsUrl(variant, self.grant.token);
      var ws;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      self.ws = ws;
      ws.binaryType = 'arraybuffer';

      var settled = false, sawSetup = false;

      // If the server accepts the socket but never acknowledges setup, there is
      // nothing to wait for and no error will ever arrive — the session simply
      // hangs. Bound it so the caller can fall back instead of stalling.
      var setupTimer = setTimeout(function () {
        if (settled || sawSetup) return;
        settled = true;
        try { ws.onclose = null; ws.close(); } catch (e) {}
        reject(Object.assign(new Error('live_setup_timeout'), { closeCode: null }));
      }, timeoutMs || 15000);

      ws.onopen = function () {
        // On the constrained endpoint the model/modality/persona already live in
        // the token. We still send a setup frame so a mismatch fails loudly, but
        // the instruction is only included when the server told us it could not
        // pin it.
        vlog('ws OPEN — sending setup frame', { variant: variantLabel(variant), pinned: self.grant.pinned });
        ws.send(JSON.stringify(buildSetup(
          self.grant.model,
          self.grant.pinned ? null : self.grant.instruction,
          self.grant.voice,
          self.flags
        )));
        self.startedAt = Date.now();
      };

      ws.onmessage = function (ev) {
        var msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
        } catch (e) { vlog('frame UNPARSEABLE', snip(ev.data, 120)); return; }
        _traceFrame(self, msg);

        if (msg && msg.setupComplete && !sawSetup) {
          // Only NOW is the session real. Resolving on `onopen` reported success
          // for a socket the server was about to close.
          sawSetup = true;
          clearTimeout(setupTimer);
          self._set('live');
          var maxMs = (self.grant.maxSeconds || 2700) * 1000;
          self.timer = setTimeout(function () { self.stop('max_duration'); }, maxMs);
          vlog('setupComplete — session is live', { msSinceOpen: Date.now() - self.startedAt, micFramesHeldBeforeSetup: self._preSetupFrames || 0 });
          if (!settled) { settled = true; resolve(self); }
          /*
           * v5.34.18 — PASS THE SESSION TO onReady. This is the auto-start bug.
           *
           * resolve() above only SCHEDULES the promise chain; onReady below runs
           * synchronously, in this same message tick. So every `.then()` between
           * here and the caller — including the one in LiveInterview._openSession
           * that does `self.session = s` — has NOT run yet.
           *
           * The consequence was a mute interview on every clean start:
           * LiveInterview.open() begins `if (!this.session) return;`, so the
           * opening turn was never sent, `_gotAgentFrame` was never initialised,
           * and the v5.34.15/16/17 warmup retries — all downstream of that guard
           * — never armed. Meanwhile interview_agent.html had already set
           * `_openingSent = true`, which disarmed the post-resolve backstop that
           * would otherwise have covered it. Session connected, nobody spoke.
           *
           * Handing the session in as the second argument lets the listener
           * attach it BEFORE it needs it, with no dependency on microtask order.
           * The `.then()` assignment stays as-is; this makes it redundant rather
           * than replacing it.
           */
          if (self.opts.onReady) { try { self.opts.onReady(self.grant, self); } catch (e) { vlog('onReady THREW', e && e.message); } }
          // v5.34.11: flush any text queued before the socket was OPEN.
          // v5.34.15: opening warmup retry. "setupComplete" does not mean the
          // model is ready to GENERATE — a turn sent in the instant after it can
          // be silently dropped (intermittently), so the interview opened mute
          // even though the opening was sent. Remember the opening turn and, if
          // NO response frame (audio or text) arrives within a few seconds,
          // resend it once. This self-heals the race regardless of warmup time.
          if (self._pendingText && self._pendingText.length) {
            vlog('flushing queued text sent before socket was OPEN', { count: self._pendingText.length });
            var _q = self._pendingText; self._pendingText = null;
            self._openingTurn = _q[_q.length - 1];
            self._sawFirstResponse = false;
            for (var _i = 0; _i < _q.length; _i++) { self.sendText(_q[_i]); }
            self._openingRetryTimer = setTimeout(function () {
              if (!self._sawFirstResponse && !self.closed && self.ws && self.ws.readyState === 1 && self._openingTurn) {
                try { self.sendText(self._openingTurn); } catch (e) {}
              }
            }, 3500);
          }
        }

        if (self.opts.onFrame) { try { self.opts.onFrame(msg); } catch (e) {} }
        var f = parseServerFrame(msg);
        // v5.34.15: first real response cancels the opening warmup retry.
        if (!self._sawFirstResponse && (f.audio.length || f.agentText)) {
          self._sawFirstResponse = true;
          if (self._openingRetryTimer) { clearTimeout(self._openingRetryTimer); self._openingRetryTimer = null; }
        }
        // v5.34.16: expose a simple 'agent has produced a frame' flag on the
        // session so the interview layer's open() can detect a dropped
        // opening (warmup) and resend it — the opening goes through
        // sendText directly, not the _pendingText flush, so the retry must
        // live where the opening is actually sent (LiveInterview.open).
        /*
         * Two DIFFERENT questions, deliberately kept apart (v5.34.19):
         *
         *   _gotAnyModelFrame — is the model working on our turn at all? Any
         *     frame answers yes, including a text-reasoning frame. This is what
         *     the opening retry must consult: resending while the model is
         *     mid-thought restarts it, so a retry then makes the very silence
         *     it was added to cure strictly worse.
         *
         *   _gotAgentFrame — has the model actually SPOKEN (or begun to)? Only
         *     audio or an output transcript answers yes. This is what the UI
         *     uses to drop the "preparing" indicator.
         */
        if (f.anyModelActivity && !self._gotAnyModelFrame) {
          self._gotAnyModelFrame = true;
          vlog('_gotAnyModelFrame -> true (model is working; opening retries stop here)');
        }
        if (f.audio.length || f.agentText) {
          if (!self._gotAgentFrame) vlog('_gotAgentFrame -> true (agent is speaking)');
          self._gotAgentFrame = true;
        }
        // The model is reasoning out loud in text. Tell the UI, so ~15 seconds
        // of preparation reads as preparation rather than as a dead line.
        if (f.modelText && !self._gotAgentFrame) {
          if (!self._thinkingAnnounced) {
            self._thinkingAnnounced = true;
            vlog('model is THINKING (text frames, no audio yet)');
          }
          if (self.opts.onAgentThinking) { try { self.opts.onAgentThinking(f.modelText); } catch (e) {} }
        }

        // v5.34.22: relate the model's frames to the interviewee's turn.
        if (f.anyModelActivity) self._lastServerActivityAt = Date.now();
        if (f.userText) self._noteUserTranscript(f.userText);
        self._noteModelActivity(f);

        if (f.interrupted) {
          // Who interrupted? If the uplink was quiet, the model heard its OWN
          // playback (echo cancellation not holding) — that is a choppy,
          // self-cancelling agent, and it reads as "distortion" (S3).
          vlog('INTERRUPTED — barge-in', {
            micRms: Math.round((self.micRms || 0) * 1e4) / 1e4, micInUtterance: !!self._micInUtterance,
            msSinceLastUtteranceEnd: self._micLastLoudAt ? Date.now() - self._micLastLoudAt : null,
            playbackPending: self.queue ? self.queue.pending() : null,
            wsBuffered: (self.ws && self.ws.bufferedAmount) || 0,
            // Quiet uplink NOW + an interruption = the server is reacting to
            // audio we sent earlier (a lagging uplink), or to its own echo.
            uplinkQuietNow: !self._micInUtterance
          });
          self.queue.flush();
          self._turnAudio = false; self._loggedTurnAudio = false;
          self._setTurnState('idle');
          if (self.opts.onInterrupted) { try { self.opts.onInterrupted(); } catch (e) {} }
        }
        // Usage always counts — the tokens were spent regardless of pause state.
        if (f.usage) {
          self.usage.tokensIn = f.usage.promptTokenCount || self.usage.tokensIn;
          self.usage.tokensOut = f.usage.responseTokenCount || self.usage.tokensOut;
        }
        // While paused, the session stays open but must be INERT: a turn that
        // arrives mid-pause is discarded whole — not just its audio. Previously
        // only audio was gated on self.muted, so agentText/turnComplete still
        // fired and the transcript kept advancing and the interview appeared to
        // "keep going" while the UI showed Paused/Resume. Drop the entire turn.
        if (self.muted) { if (f.audio.length || f.agentText) vlog('turn DISCARDED — session is muted/paused'); return; }
        // First actual audio also ends any "preparing" state, even when the
        // output transcript has not arrived yet.
        if (f.audio.length && self.opts.onAgentSpeaking && !self._announcedSpeaking) {
          self._announcedSpeaking = true;
          try { self.opts.onAgentSpeaking(); } catch (e) {}
        }
        for (var i = 0; i < f.audio.length; i++) {
          var bytes = base64ToBytes(f.audio[i]);
          var pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
          self.queue.push(int16ToFloat32(pcm));
        }
        if (f.userText && self.opts.onUserText) { try { self.opts.onUserText(f.userText); } catch (e) {} }
        if (f.agentText && self.opts.onAgentText) { try { self.opts.onAgentText(f.agentText); } catch (e) {} }
        if (f.turnComplete && self.opts.onTurnComplete) { try { self.opts.onTurnComplete(); } catch (e) {} }
      };

      ws.onerror = function (e) {
        vlog('ws ERROR', { variant: variantLabel(variant), settled: settled, sawSetup: sawSetup });
        if (!settled) { settled = true; reject(Object.assign(new Error('live_socket_error'), { closeCode: null })); return; }
        self._fail('live_socket_error', e);
      };

      ws.onclose = function (ev) {
        vlog('ws CLOSE — the SERVER closed the socket', {
          code: ev.code, reason: ev.reason, sawSetup: sawSetup,
          audioEverReceived: !!self._firstAudioAt,
          muted: !!self.muted,
          // A paused session sends no microphone frames at all, so the socket
          // goes idle. If a close lands shortly after a pause with the session
          // muted, that is the shape of an idle timeout rather than a fault.
          secondsSinceOpen: self.startedAt ? Math.round((Date.now() - self.startedAt) / 1000) : 0
        });
        clearTimeout(setupTimer);
        // The close code and reason are the ONLY explanation the server gives
        // when it rejects a session after the handshake. Without them this
        // failure is completely opaque, which is exactly how it presented.
        var why = 'code ' + ev.code + (ev.reason ? ' — ' + ev.reason : '');
        /*
         * v5.34.27: THE line. Five production traces of "the model ignores me"
         * finally produced this close, twice in eight seconds:
         *   1007 — The audio content type (CONTENT_TYPE_AUDIO) is not supported
         *          for this model configuration.
         * It arrives right after the model's thinking frames for a reply to a
         * turn that contained the interviewee's AUDIO — i.e. Google HEARD the
         * audio (the thinking quotes it) and then refused to generate against
         * it. That is a server-side rejection of this model/config, not a
         * client fault. Named here so it can never again be read as silence.
         */
        var audioRejected = ev.code === 1007 && /CONTENT_TYPE_AUDIO|audio content type/i.test(String(ev.reason || ''));
        if (audioRejected) {
          vlog('!!! GOOGLE REJECTED AN AUDIO TURN — 1007 CONTENT_TYPE_AUDIO. The server heard the interviewee and refused to generate a reply for this model configuration', {
            model: self.grant && self.grant.model, variant: variantLabel(variant), pinned: !!(self.grant && self.grant.pinned),
            thinkingBudget: self.grant && self.grant.thinkingBudget, pinnedExtras: self.grant && self.grant.pinnedExtras,
            secondsSinceOpen: self.startedAt ? Math.round((Date.now() - self.startedAt) / 1000) : 0
          });
          self.audioRejected = true;
          if (self.opts.onAudioRejected) { try { self.opts.onAudioRejected(ev.reason); } catch (e) {} }
        }
        if (self.opts.onClose) { try { self.opts.onClose(ev.code, ev.reason, sawSetup); } catch (e) {} }
        if (!settled) {
          settled = true;
          reject(Object.assign(new Error('live_socket_closed: ' + why), { closeCode: ev.code, closeReason: ev.reason }));
          return;
        }
        self.stop('closed:' + why);
      };
    });
  };

  /**
   * Pause/resume the session without tearing it down.
   *
   * Muting gates BOTH directions: no microphone frames leave, and any speech
   * arriving mid-pause is discarded rather than queued — otherwise the agent
   * would deliver a stale reply the moment you resumed, answering a question
   * from before the interruption.
   *
   * The session itself stays open. That matters because the token has a hard
   * wall-clock expiry: a long pause can outlive it, so the caller must be ready
   * to start a fresh session on resume (see isAlive()).
   */
  VyneLiveSession.prototype.setMuted = function (m) {
    var was = this.muted;
    vlog('session.setMuted(' + !!m + ')', { was: !!was });
    this.muted = !!m;
    if (!this.muted) {
      this._keepAliveLogged = false; this._lastKeepAlive = 0;
      // The silence clock did not run while muted; restart it so a long pause
      // cannot masquerade as a dead uplink the instant the session resumes.
      this._micLastNonSilentAt = Date.now(); this._micSilentWarned = false;
      this._awaitingReply = false;
      if (this._replyWatchdog) { clearTimeout(this._replyWatchdog); this._replyWatchdog = null; }
      if (was) vlog('resumed — capture chain state', { micCtx: this.micCtx && { state: this.micCtx.state, rate: this.micCtx.sampleRate },
        outCtx: this.outCtx && { state: this.outCtx.state, rate: this.outCtx.sampleRate }, track: this._trackInfo() });
    }
    if (this.muted && !was) {
      // Entering pause: flush the playback queue. queue.flush() stops every
      // audio source already scheduled on the output context, so nothing keeps
      // talking after the user hits Pause — without it the tail of the current
      // turn plays on and is heard as a long delayed chunk on resume.
      if (this.queue) this.queue.flush();
      if (this.opts.onInterrupted) { try { this.opts.onInterrupted(); } catch (e) {} }
    }
    return this.muted;
  };

  /** False once the socket has gone — e.g. the token expired during a pause. */
  VyneLiveSession.prototype.isAlive = function () {
    return !this.closed && !!this.ws && this.ws.readyState === 1;
  };

  /** Send a text turn — used to open the interview without waiting for the
   *  interviewee to speak first, and by the type-instead fallback. */
  VyneLiveSession.prototype.sendText = function (text) {
    // v5.34.11: queue text sent before the socket is OPEN instead of
    // silently dropping it. The opening turn is sent right after the
    // session resolves; on a fast start/restart the socket can be a beat
    // away from readyState OPEN, and the old guard returned false into the
    // void — session alive but SILENT. Queue now, flush on setupComplete.
    if (!this.ws || this.ws.readyState !== 1) {
      if (this.ws && this.ws.readyState === 0) {
        vlog('sendText QUEUED (socket CONNECTING)', { text: snip(text) });
        (this._pendingText || (this._pendingText = [])).push(String(text));
        return true;
      }
      vlog('sendText DROPPED — socket not usable', { readyState: rs(this.ws), text: snip(text) });
      return false;
    }
    if (this.flags && this.flags.openingViaRealtime) {
      // EXPERIMENT: text on the realtime path, never a clientContent turn.
      vlog('sendText -> WIRE (realtimeInput.text)', { readyState: rs(this.ws), text: snip(text) });
      this.ws.send(JSON.stringify({ realtimeInput: { text: String(text) } }));
      return true;
    }
    vlog('sendText -> WIRE', { readyState: rs(this.ws), text: snip(text) });
    this.ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: String(text) }] }],
        turnComplete: true
      }
    }));
    return true;
  };

  VyneLiveSession.prototype.stop = function (reason) {
    if (this.closed) return;
    /*
     * v5.34.20: WHO tore this session down, and was it us?
     *
     * A pause was observed to end with isAlive:false and both AudioContexts
     * closed — a full teardown, not a mute. setMuted() cannot do that, so
     * either something calls stop() directly, or the socket closed underneath
     * us and ws.onclose called stop('closed:...') on our behalf. Those two have
     * completely different remedies, and only the stack tells them apart:
     * a frame mentioning ws.onclose means the SERVER dropped us.
     *
     * Worth knowing while reading it: muting stops microphone frames entirely
     * (see node.onaudioprocess), so a paused session sends nothing at all and
     * looks idle to the server.
     */
    vlog('session.stop(' + reason + ')', {
      audioEverReceived: !!this._firstAudioAt,
      micFrames: this._micFrames || 0,
      gotAgentFrame: !!this._gotAgentFrame,
      muted: !!this.muted,
      wsState: rs(this.ws),
      secondsAlive: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      via: (function () {
        try { return String(new Error().stack || '').split('\n').slice(2, 7).join(' | '); }
        catch (e) { return 'unavailable'; }
      })()
    });
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this._replyWatchdog) { clearTimeout(this._replyWatchdog); this._replyWatchdog = null; }
    if (this._ignoredWatchdog) { clearTimeout(this._ignoredWatchdog); this._ignoredWatchdog = null; }
    if (this._openingRetryTimer) { clearTimeout(this._openingRetryTimer); this._openingRetryTimer = null; }
    if (this.queue) this.queue.flush();
    try { if (this.ws && this.ws.readyState <= 1) this.ws.close(); } catch (e) {}
    if (this.stream) {
      var t = this.stream.getTracks();
      for (var i = 0; i < t.length; i++) { try { t[i].stop(); } catch (e) {} }
    }
    if (this.node) { try { this.node.disconnect(); } catch (e) {} }
    try { if (this.micCtx) this.micCtx.close(); } catch (e) {}
    try { if (this.outCtx) this.outCtx.close(); } catch (e) {}
    this._set('ended');

    // Release the unused part of the reservation. keepalive so it still goes
    // out if the interviewee closed the tab — otherwise an abandoned session
    // silently forfeits its whole 45-minute reservation against the firm's cap.
    if (this.grant) {
      var seconds = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
      try {
        fetch((window.vyneLlmBase ? window.vyneLlmBase() : '') + '/api/voice/live-session/close', {  // v5.34.0: generation lane
          method: 'POST',
          keepalive: true,
          headers: window.vyneAuthHeaders
            ? window.vyneAuthHeaders()
            : { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: this.grant.sessionId,
            module: this.opts.module || 'interview_agent',
            clientName: this.opts.clientName || undefined,
            maxSeconds: this.grant.maxSeconds,
            tokensIn: this.usage.tokensIn,
            tokensOut: this.usage.tokensOut,
            seconds: Math.max(0, Math.min(seconds, this.grant.maxSeconds))
          })
        }).catch(function () {});
      } catch (e) {}
    }
    if (this.opts.onEnded) { try { this.opts.onEnded(reason || 'stopped'); } catch (e) {} }
  };

  window.vyneLive = {
    isSupported: function () {
      return !!(window.WebSocket && (window.AudioContext || window.webkitAudioContext) &&
                navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    },
    start: function (opts) {
      var s = new VyneLiveSession(opts);
      return s.start().then(function () { return s; });
    },
    Session: VyneLiveSession,
    _internals: {
      floatTo16BitPCM: floatTo16BitPCM,
      int16ToFloat32: int16ToFloat32,
      resampleTo: resampleTo,
      bytesToBase64: bytesToBase64,
      base64ToBytes: base64ToBytes,
      buildSetup: buildSetup,
      buildAudioFrame: buildAudioFrame,
      parseServerFrame: parseServerFrame,
      PlaybackQueue: PlaybackQueue,
      frameStats: frameStats,
      readFlags: readFlags,
      variantOrder: variantOrder,
      pcm16ToWav: pcm16ToWav,
      SPEECH_RMS: SPEECH_RMS,
      SILENT_RMS: SILENT_RMS,
      INPUT_RATE: INPUT_RATE,
      OUTPUT_RATE: OUTPUT_RATE
    }
  };

  /**
   * DevTools: `vyneLiveMicCheck()` — samples the CURRENT live session's uplink
   * for three seconds and reports whether it carried speech-level audio. Say
   * something after calling it. This is the one-line test for "can the model
   * hear me at all", independent of everything downstream of the socket.
   */
  /** 16 kHz mono PCM16 → WAV bytes. */
  function pcm16ToWav(pcm) {
    var buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
    function w(o, str) { for (var i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); }
    w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, INPUT_RATE, true);
    v.setUint32(28, INPUT_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data');
    v.setUint32(40, pcm.length * 2, true);
    for (var i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i], true);
    return new Uint8Array(buf);
  }
  /**
   * DevTools: `vyneLivePlayUplink(10)` — play the last 10 s of EXACTLY what
   * went to Google, through the speakers. If you hear yourself, clear and at
   * normal pitch, the capture chain is right and the problem is on the
   * server's side of the socket. If it is faint, garbled, slow or silent, the
   * problem is here. `vyneLiveDownloadUplink(30)` saves the same as a WAV.
   */
  window.vyneLivePlayUplink = function (seconds) {
    var s = window.__vyneLiveCurrent;
    if (!s) { console.warn('[vyneLivePlayUplink] no live session'); return null; }
    var pcm = s.capturedUplink(seconds || 10);
    if (!pcm.length) { console.warn('[vyneLivePlayUplink] nothing captured yet'); return null; }
    var AC = window.AudioContext || window.webkitAudioContext, ctx = new AC({ sampleRate: INPUT_RATE });
    var buf = ctx.createBuffer(1, pcm.length, INPUT_RATE); buf.getChannelData(0).set(int16ToFloat32(pcm));
    var src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
    src.onended = function () { try { ctx.close(); } catch (e) {} };
    var st = frameStats(int16ToFloat32(pcm));
    vlog('vyneLivePlayUplink', { seconds: Math.round(pcm.length / INPUT_RATE * 10) / 10, rms: st.rms, peak: st.peak });
    return { seconds: pcm.length / INPUT_RATE, rms: st.rms, peak: st.peak };
  };
  window.vyneLiveDownloadUplink = function (seconds) {
    var s = window.__vyneLiveCurrent;
    if (!s) { console.warn('[vyneLiveDownloadUplink] no live session'); return null; }
    var wav = pcm16ToWav(s.capturedUplink(seconds || CAPTURE_SECONDS));
    var url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    var a = document.createElement('a'); a.href = url; a.download = 'vyne-uplink-' + Date.now() + '.wav';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    return a.download;
  };

  window.vyneLiveMicCheck = function (seconds) {
    var s = window.__vyneLiveCurrent;
    if (!s || s.closed) { console.warn('[vyneLiveMicCheck] no live session'); return Promise.resolve(null); }
    var ms = (seconds || 3) * 1000, peak = 0, sum = 0, n = 0, t0 = Date.now();
    return new Promise(function (resolve) {
      var iv = setInterval(function () {
        var r = s.micLevel(); if (r > peak) peak = r; sum += r; n++;
        if (Date.now() - t0 >= ms) {
          clearInterval(iv);
          var out = { peakRms: peak, meanRms: n ? sum / n : 0, speechLevel: peak >= SPEECH_RMS,
                      muted: !!s.muted, micCtx: s.micCtx && s.micCtx.state, track: s._trackInfo() };
          vlog('vyneLiveMicCheck', out);
          resolve(out);
        }
      }, 50);
    });
  };
})();
