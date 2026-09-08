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
  var WS_VARIANTS = [
    { v: 'v1alpha', svc: 'BidiGenerateContent',            auth: 'key' },
    { v: 'v1beta',  svc: 'BidiGenerateContent',            auth: 'key' },
    { v: 'v1alpha', svc: 'BidiGenerateContentConstrained', auth: 'key' },
    { v: 'v1beta',  svc: 'BidiGenerateContentConstrained', auth: 'key' },
    { v: 'v1alpha', svc: 'BidiGenerateContent',            auth: 'access_token' },
    { v: 'v1beta',  svc: 'BidiGenerateContentConstrained', auth: 'access_token' }
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
    var out = { audio: [], userText: '', agentText: '', interrupted: false, turnComplete: false, usage: null };
    if (!msg) return out;
    var sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) out.interrupted = true;
      if (sc.turnComplete) out.turnComplete = true;
      if (sc.inputTranscription && sc.inputTranscription.text) out.userText = sc.inputTranscription.text;
      if (sc.outputTranscription && sc.outputTranscription.text) out.agentText = sc.outputTranscription.text;
      var parts = sc.modelTurn && sc.modelTurn.parts;
      if (parts) {
        for (var i = 0; i < parts.length; i++) {
          var d = parts[i].inlineData;
          if (d && d.data && String(d.mimeType || '').indexOf('audio') === 0) out.audio.push(d.data);
        }
      }
    }
    if (msg.usageMetadata) out.usage = msg.usageMetadata;
    return out;
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
    this._set('connecting');

    // 1. Ask OUR server for a grant. This is where the budget check, the
    //    concurrency cap and the reservation happen — see routes/voice.ts.
    return fetch('/api/voice/live-session', {
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
        if (self.opts.onNote) { try { self.opts.onNote('trying ' + variantLabel(variant) + '…'); } catch (e) {} }
        return self._openSocket(variant, 8000).then(function (r) {
          self.variant = variantLabel(variant);
          if (self.opts.onNote) { try { self.opts.onNote('connected via ' + self.variant); } catch (e) {} }
          return r;
        }).catch(function (err) {
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
        } catch (e) { return; }

        if (msg && msg.setupComplete && !sawSetup) {
          // Only NOW is the session real. Resolving on `onopen` reported success
          // for a socket the server was about to close.
          sawSetup = true;
          clearTimeout(setupTimer);
          self._set('live');
          var maxMs = (self.grant.maxSeconds || 2700) * 1000;
          self.timer = setTimeout(function () { self.stop('max_duration'); }, maxMs);
          if (!settled) { settled = true; resolve(self); }
          if (self.opts.onReady) { try { self.opts.onReady(self.grant); } catch (e) {} }
        }

        if (self.opts.onFrame) { try { self.opts.onFrame(msg); } catch (e) {} }
        var f = parseServerFrame(msg);

        if (f.interrupted) {
          self.queue.flush();
          if (self.opts.onInterrupted) { try { self.opts.onInterrupted(); } catch (e) {} }
        }
        for (var i = 0; i < f.audio.length && !self.muted; i++) {
          var bytes = base64ToBytes(f.audio[i]);
          var pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
          self.queue.push(int16ToFloat32(pcm));
        }
        if (f.userText && self.opts.onUserText) { try { self.opts.onUserText(f.userText); } catch (e) {} }
        if (f.agentText && self.opts.onAgentText) { try { self.opts.onAgentText(f.agentText); } catch (e) {} }
        if (f.turnComplete && self.opts.onTurnComplete) { try { self.opts.onTurnComplete(); } catch (e) {} }
        if (f.usage) {
          self.usage.tokensIn = f.usage.promptTokenCount || self.usage.tokensIn;
          self.usage.tokensOut = f.usage.responseTokenCount || self.usage.tokensOut;
        }
      };

      ws.onerror = function (e) {
        if (!settled) { settled = true; reject(Object.assign(new Error('live_socket_error'), { closeCode: null })); return; }
        self._fail('live_socket_error', e);
      };

      ws.onclose = function (ev) {
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
    this.muted = !!m;
    if (this.muted && this.queue) this.queue.flush();
    return this.muted;
  };

  /** False once the socket has gone — e.g. the token expired during a pause. */
  VyneLiveSession.prototype.isAlive = function () {
    return !this.closed && !!this.ws && this.ws.readyState === 1;
  };

  /** Send a text turn — used to open the interview without waiting for the
   *  interviewee to speak first, and by the type-instead fallback. */
  VyneLiveSession.prototype.sendText = function (text) {
    if (!this.ws || this.ws.readyState !== 1) return false;
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
        fetch('/api/voice/live-session/close', {
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
