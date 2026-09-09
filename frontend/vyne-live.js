/**
 * vyne-live.js — realtime duplex voice for the Interview Agent (v5.32.33).
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
      if (buf.length > 4000) buf.splice(0, buf.length - 4000);
    } catch (e) {}
  }
  window.vyneLiveLog = vlog;
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
  function buildSetup(model, unpinnedInstruction, voiceName) {
    return {
      setup: {
        model: model.indexOf('models/') === 0 ? model : 'models/' + model,
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

  function buildAudioFrame(pcm16) {
    return {
      realtimeInput: {
        audio: {
          data: bytesToBase64(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)),
          mimeType: 'audio/pcm;rate=' + INPUT_RATE
        }
      }
    };
  }

  /**
   * Normalise one server frame into the few things the UI cares about.
   * Kept pure and separate from the socket so the protocol shape can be tested
   * without a network, and so a shape change surfaces in one place.
   */
  function parseServerFrame(msg) {
    var out = { audio: [], userText: '', agentText: '', modelText: '', anyModelActivity: false,
                interrupted: false, turnComplete: false, usage: null };
    if (!msg) return out;
    var sc = msg.serverContent;
    if (sc) {
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
  function _traceFrame(sess, msg) {
    if (window.VYNE_LIVE_DEBUG === false) return;
    if (!msg || typeof msg !== 'object') { vlog('frame <non-object>', msg); return; }
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
      vlog('frame ' + bits.join(' + '), Object.keys(detail).length ? detail : undefined);
      return;
    }
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
    src.start(at);
    this.nextAt = at + buf.duration;
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
        stopped: this.sources.length, ctxState: this.ctx && this.ctx.state
      });
    }
    for (var i = 0; i < this.sources.length; i++) {
      try { this.sources[i].stop(); } catch (e) { /* already ended */ }
    }
    this.sources = [];
    this.nextAt = 0;
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

  VyneLiveSession.prototype.start = function () {
    var self = this;
    vlog('session.start() called', { module: this.opts.module, voice: this.opts.voice, interviewer: this.opts.interviewerName });
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
        interviewerName: self.opts.interviewerName || undefined
      })
    }).then(function (r) {
      if (!r.ok) {
        // A refusal here is normal and meaningful: over budget, too many
        // concurrent sessions, free-tier key, or not configured at all. The
        // caller falls back to the existing text + TTS path rather than
        // failing the interview.
        return r.json().catch(function () { return {}; }).then(function (b) {
          var e = new Error(b.error || ('live_session_http_' + r.status));
          e.code = b.error; e.status = r.status;
          throw e;
        });
      }
      return r.json();
    }).then(function (grant) {
      self.grant = grant;
      vlog('grant minted', { model: grant.model, voice: grant.voice, pinned: grant.pinned,
                             maxSeconds: grant.maxSeconds, sessionId: grant.sessionId });
      return self._openAudio();
    }).then(function () {
      // The token's shape decides the endpoint, but the mint fallback means we
      // cannot always be sure which shape we got. Try the constrained endpoint
      // first, then the standard one, rather than failing on a guess.
      // Walk the candidates until one reaches setupComplete. Each attempt is
      // short so the whole sweep stays inside a few seconds of user patience.
      var i = 0;
      function attempt() {
        if (self.closed) return Promise.reject(new Error('cancelled'));
        var variant = WS_VARIANTS[i];
        vlog('ws variant attempt ' + (i + 1) + '/' + WS_VARIANTS.length, variantLabel(variant));
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
          if (i >= WS_VARIANTS.length || self.closed) throw err;
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
        if (self.closed || self.muted || !self.ws || self.ws.readyState !== 1) return;
        // Mic frames leave every ~128ms, so log the first and then sparsely.
        // They matter here for one reason: uplink audio is what the model's
        // activity detection can INTERRUPT a turn on, so a dropped opening
        // needs to be readable against what the microphone was sending.
        self._micFrames = (self._micFrames || 0) + 1;
        if (self._micFrames === 1) vlog('mic: first frame sent to socket');
        else if (self._micFrames % 40 === 0) vlog('mic: ' + self._micFrames + ' frames sent (~' +
          Math.round(self._micFrames * FRAME_SAMPLES / INPUT_RATE) + 's of uplink audio)');
        var input = ev.inputBuffer.getChannelData(0);
        // Verified, not assumed — see the header note on Safari.
        var pcmF = self.micCtx.sampleRate === INPUT_RATE
          ? input
          : resampleTo(input, self.micCtx.sampleRate, INPUT_RATE);
        try {
          self.ws.send(JSON.stringify(buildAudioFrame(floatTo16BitPCM(pcmF))));
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
          self.grant.voice
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
          vlog('setupComplete — session is live', { msSinceOpen: Date.now() - self.startedAt });
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

        if (f.interrupted) {
          self.queue.flush();
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
        vlog('ws CLOSE', { code: ev.code, reason: ev.reason, sawSetup: sawSetup,
                           audioEverReceived: !!self._firstAudioAt });
        clearTimeout(setupTimer);
        // The close code and reason are the ONLY explanation the server gives
        // when it rejects a session after the handshake. Without them this
        // failure is completely opaque, which is exactly how it presented.
        var why = 'code ' + ev.code + (ev.reason ? ' — ' + ev.reason : '');
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
    vlog('session.stop(' + reason + ')', { audioEverReceived: !!this._firstAudioAt,
                                           micFrames: this._micFrames || 0,
                                           gotAgentFrame: !!this._gotAgentFrame });
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
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
      INPUT_RATE: INPUT_RATE,
      OUTPUT_RATE: OUTPUT_RATE
    }
  };
})();
