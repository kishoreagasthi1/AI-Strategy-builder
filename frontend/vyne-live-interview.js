/**
 * vyne-live-interview.js — the bridge between the realtime voice session and
 * the Interview Agent's existing state machine (v5.32.41).
 *
 * ── Why a bridge rather than a rewrite ──────────────────────────────────────
 *
 * interview_agent.html already does a great deal that must keep working:
 * scoring, findings, the scorecard, mandatory questions, refresh scope,
 * autosave, resume, and the export that feeds Synthesis. None of that is about
 * voice. Rewriting it to be realtime-native would put every one of those at
 * risk to change how the audio is transported.
 *
 * So the realtime session replaces exactly one thing — the CONVERSATION — and
 * hands back the same `scoreData` shape the text path produces, so everything
 * downstream is untouched.
 *
 * ── The one genuine consequence ─────────────────────────────────────────────
 *
 * The text path asks a single model to both answer AND emit a
 * <<<SCORES>>> block. A speech-native model cannot do that: it is producing
 * audio, not a JSON envelope. So scoring moves to a SEPARATE pass over the
 * running transcript, through the normal gateway with its normal metering and
 * rate limits.
 *
 * That is a better separation than it replaces. The conversational model stops
 * being graded on JSON compliance, and the scoring model sees the whole
 * interview so far rather than one turn in isolation.
 *
 * ── Fallback is not an afterthought ─────────────────────────────────────────
 *
 * Realtime can be unavailable for entirely ordinary reasons: no key on the
 * deployment, over the monthly budget, a denied microphone, a corporate
 * firewall blocking WebSockets. In every one of those cases this module gets
 * out of the way and the interview proceeds on the existing text + TTS path.
 * An interview that fails because the voice transport is down would be a far
 * worse outcome than one that sounds less natural.
 */
(function () {
  'use strict';

  /**
   * Scoring runs at most this often, no matter how fast turns arrive.
   *
   * v5.32.44: was 20s. A short exchange produced a scoring call every couple of
   * turns, and the call count on the statement was dominated by them. Scoring
   * sees the whole running transcript, so a longer gap loses nothing — the next
   * pass still covers everything said in between.
   */
  var SCORE_MIN_INTERVAL_MS = 60000;
  /** Enough recent conversation for scoring context, bounded for cost. */
  var TRANSCRIPT_WINDOW = 24;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Build the scoring request. Deliberately mirrors the text path's contract so
   * the caller can feed the result straight into the same handler.
   */
  function scorePrompt(state, transcript) {
    return [
      'You are scoring an AI-readiness interview that is happening by voice.',
      'Below is the transcript so far between the interviewer and ' +
        (state.stakeholderName || 'the stakeholder') +
        (state.stakeholderRole ? ' (' + state.stakeholderRole + ')' : '') +
        ' at ' + (state.client || 'the client') + '.',
      '',
      'Score ONLY dimensions the transcript gives you real evidence for. Use 0 for everything else —',
      'a guess is worse than a gap here, because these scores flow into a client deliverable.',
      '',
      'D1 Data & Data Management | D2 Technology & Infrastructure | D3 AI Strategy & Vision',
      'D4 People & Skills | D5 Process & Operations | D6 Governance & Risk | D7 Culture & Change Readiness',
      'Scale: 1=Not Started, 2=Early/Ad Hoc, 3=Developing, 4=Advanced, 5=Leading/Optimized',
      '',
      'FINDING ATTRIBUTION: write any finding as a CONDITION of the function or organisation,',
      'never as a named individual\'s act or fault. Not "the CRO blocked deployments" but',
      '"deployments have been paused pending explainability evidence."',
      '',
      'Return ONLY this JSON, no prose, no fences:',
      '{"scores":{"D1":0,"D2":0,"D3":0,"D4":0,"D5":0,"D6":0,"D7":0},"finding":{"dimension":"D3","text":""},"questionsAsked":0}',
      'Omit "finding" entirely if nothing significant emerged since the last scoring pass.',
      '',
      '--- TRANSCRIPT ---',
      transcript,
      '--- END TRANSCRIPT ---'
    ].join('\n');
  }

  function LiveInterview(opts) {
    this.opts = opts || {};
    this.session = null;
    this.turns = [];             // {who:'You'|'VYNE', text}
    this.pendingUser = '';
    this.pendingAgent = '';
    this.lastScoreAt = 0;
    this.scoring = false;
    this.stopped = false;
    /**
     * Consecutive scoring failures (v5.32.55).
     *
     * Every failure mode of the scoring pass used to land on the same silent
     * `return`: a 429 from the shared rate limit, a monthly or daily token cap,
     * a provider 5xx, JSON the model wrapped in prose, an outright refusal.
     * None of them were counted, logged or surfaced.
     *
     * The consequence is not a degraded interview — it is a COMPLETED one with
     * `scores: {}`. The round takes no scores from it, the scorecard shows a
     * dash on all seven dimensions, and the first person to notice is a
     * consultant looking at an empty dashboard, plausibly after the deliverable
     * has been drafted. A 45-minute conversation with an executive is not
     * repeatable; this has to be visible while the interview is still running.
     */
    this.scoreFailures = 0;
    this.scoreSuccesses = 0;
    /** Renewals used so far — see MAX_RENEWALS. */
    this.renewals = 0;
  }

  /** Transcripts stream in fragments; join them into whole turns. */
  LiveInterview.prototype._flushPending = function () {
    if (this.pendingUser.trim()) {
      this.turns.push({ who: 'You', text: this.pendingUser.trim() });
      this.pendingUser = '';
    }
    if (this.pendingAgent.trim()) {
      this.turns.push({ who: 'VYNE', text: this.pendingAgent.trim() });
      this.pendingAgent = '';
    }
    if (this.turns.length > 200) this.turns.splice(0, this.turns.length - 200);
  };

  LiveInterview.prototype.transcriptText = function () {
    return this.turns.slice(-TRANSCRIPT_WINDOW)
      .map(function (t) { return t.who + ': ' + t.text; }).join('\n');
  };

  /**
   * Score the conversation so far. Failures are swallowed on purpose: a scoring
   * hiccup must never interrupt a live interview the consultant is sitting in.
   * The transcript is the durable record, and a later pass can re-derive from it.
   */
  LiveInterview.prototype._score = function () {
    var self = this;
    if (this.scoring || this.stopped) return;
    var now = Date.now();
    if (now - this.lastScoreAt < SCORE_MIN_INTERVAL_MS) return;
    var text = this.transcriptText();
    if (!text || this.turns.length < 2) return;
    // Nothing new since the last pass — scoring the same transcript again would
    // be a paid call that cannot change the answer.
    if (text === this._lastScored) return;
    this._lastScored = text;

    this.scoring = true;
    this.lastScoreAt = now;

    fetch('/api/llm/generate', {
      method: 'POST',
      headers: window.vyneAuthHeaders ? window.vyneAuthHeaders() : { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'interview_score',
        module: 'interview_agent',
        clientName: self.opts.clientName || undefined,
        maxTokens: 900,
        temperature: 0,
        messages: [{ role: 'user', content: scorePrompt(self.opts.state || {}, text) }]
      })
    }).then(function (r) {
      if (r.ok) return r.json();
      // Carry the reason forward instead of collapsing it to null: "over the
      // daily token cap" and "the provider is down" need different responses
      // from the consultant, and the badge can say which.
      return r.json().catch(function () { return {}; }).then(function (b) {
        var e = new Error((b && b.error) || ('http_' + r.status));
        e.code = (b && b.error) || ('http_' + r.status);
        throw e;
      });
    })
      .then(function (d) {
        if (!d || self.stopped) return;
        var parsed = window.vyneParseJson ? window.vyneParseJson(d.text || '') : null;
        if (!parsed) throw Object.assign(new Error('unparseable_score_response'), { code: 'unparseable_score_response' });
        self.scoreFailures = 0;
        self.scoreSuccesses++;
        if (self.opts.onScore) { try { self.opts.onScore(parsed); } catch (e) {} }
      })
      .catch(function (e) {
        self.scoreFailures++;
        try { console.warn('[live-interview] scoring pass failed', e && e.message); } catch (x) {}
        // Report EVERY failure and let the UI decide when it matters. Two in a
        // row is already two minutes of unscored conversation.
        if (self.opts.onScoreError) {
          try {
            self.opts.onScoreError({
              code: (e && e.code) || 'scoring_failed',
              consecutive: self.scoreFailures,
              everSucceeded: self.scoreSuccesses > 0,
            });
          } catch (x) {}
        }
      })
      .then(function () { self.scoring = false; });
  };

  /**
   * How many times a lapsed session may be renewed inside one interview.
   *
   * A grant is 15 minutes by default (see liveSession.ts DEFAULT_SESSION_SECONDS
   * — deliberately short, because the hold is taken up front). A "Deep Dive" is
   * scoped at 60-90 minutes. Before v5.32.55 the session simply died at the
   * ceiling: the microphone tracks stopped, the badge read "session ended", and
   * nothing restarted — so the deepest interview tier was structurally
   * impossible to conduct, and worse, LiveInterview.stopped stayed false, so
   * the page went on routing typed input into a dead socket where sendText()
   * returned false and said nothing.
   *
   * Eight renewals covers a two-hour interview. It is bounded rather than
   * unlimited because each renewal takes a fresh budget hold, and a runaway
   * page should exhaust a counter rather than a firm's monthly cap.
   */
  var MAX_RENEWALS = 8;

  /**
   * Reasons a session ended that mean "carry on", not "the interview is over".
   *
   * The socket path reports `closed:code 1011 — ...` (see vyne-live.js's
   * ws.onclose), so this matches on the PREFIX rather than an exact string —
   * matching exactly is how a renewal check quietly never fires.
   *
   * Everything a person did deliberately — finishing, pausing, stopping — is
   * NOT renewable, and neither is a failed renewal, which would otherwise loop.
   */
  var DELIBERATE = ['finished', 'interview_finished', 'user_stopped', 'stopped',
                    'paused', 'renew_failed'];
  function isRenewable(reason) {
    var r = String(reason || '');
    if (DELIBERATE.indexOf(r) !== -1) return false;
    return r === 'max_duration' || r.indexOf('closed:') === 0 ||
           r === 'socket_closed' || r === 'error';
  }

  LiveInterview.prototype._sessionOpts = function () {
    var self = this;
    var st = this.opts.state || {};
    return {
      module: 'interview_agent',
      clientName: st.client || undefined,
      industry: st.industry || undefined,
      intervieweeName: st.stakeholderName || undefined,
      intervieweeRole: st.stakeholderDisplayLabel || st.stakeholderRole || undefined,
      interviewerName: this.opts.interviewerName || 'Vyn',
      voice: this.opts.voice || undefined,
      context: this.opts.context || undefined,

      onUserText: function (t) {
        // Verbatim, for the same reason as the on-screen transcript: these are
        // sub-word fragments. Inserting spaces here corrupts the text the
        // SCORING model reads, which is worse than an ugly screen — it degrades
        // the scores and findings that reach the client deliverable.
        self.pendingUser += t;
        if (self.opts.onPartialUser) { try { self.opts.onPartialUser(t); } catch (e) {} }
      },
      onAgentText: function (t) {
        self.pendingAgent += t;
        if (self.opts.onPartialAgent) { try { self.opts.onPartialAgent(t); } catch (e) {} }
      },
      onTurnComplete: function () {
        self._flushPending();
        if (self.opts.onTurns) { try { self.opts.onTurns(self.turns.slice()); } catch (e) {} }
        self._score();
      },
      onInterrupted: function () {
        // The interviewee talked over the agent. Whatever the agent had said up
        // to that point is still real and belongs in the transcript.
        self._flushPending();
      },
      // Forwarded so the UI can show WHICH voice the session actually opened
      // with. v5.32.51: without this the only way to tell whether a voice
      // selection had taken effect was to listen to it and guess — which is
      // exactly how a silently-dropped voice survived several releases.
      onReady: function (g) { if (self.opts.onReady) { try { self.opts.onReady(g); } catch (e) {} } },
      onState: function (s) { if (self.opts.onState) { try { self.opts.onState(s); } catch (e) {} } },
      onError: function (r, e) { if (self.opts.onError) { try { self.opts.onError(r, e); } catch (x) {} } },
      onEnded: function (r) {
        self._flushPending();
        // A grant that simply ran out of time is not the end of the interview.
        // Renew silently and keep going — the conversation, the transcript and
        // the accumulated scores all live here, not in the socket.
        // v5.34.8: do not auto-renew while the user has paused. Pause only
        // MUTES the session (setMuted), it does not stop it, so a grant that
        // expires mid-pause used to renew and then SPEAK ("connection was
        // renewed... continue") — the interview appeared to wake itself up a
        // few minutes into a pause. Let the grant lapse quietly instead; the
        // Resume handler reconnects a dead session on the user's action.
        if (isRenewable(r) && !self.stopped && !self._muted && self.renewals < MAX_RENEWALS) {
          self.renewals++;
          if (self.opts.onRenewing) { try { self.opts.onRenewing(self.renewals, r); } catch (e) {} }
          self._openSession().then(function () {
            if (self.opts.onRenewed) { try { self.opts.onRenewed(self.renewals); } catch (e) {} }
            // Pick the thread back up rather than sitting mute waiting for the
            // interviewee to speak first into what looks like a dead line.
            self.say('The connection was renewed mid-interview. Continue exactly where you left off '
              + 'with your next question — do not greet them again or mention the interruption.');
          }).catch(function (e) {
            if (self.opts.onEnded) { try { self.opts.onEnded('renew_failed', self.turns.slice()); } catch (x) {} }
          });
          return;
        }
        if (self.opts.onEnded) { try { self.opts.onEnded(r, self.turns.slice()); } catch (e) {} }
      }
    };
  };

  LiveInterview.prototype._openSession = function () {
    var self = this;
    return window.vyneLive.start(this._sessionOpts()).then(function (s) {
      self.session = s;
      return self;
    });
  };

  LiveInterview.prototype.start = function () {
    if (!window.vyneLive || !window.vyneLive.isSupported()) {
      return Promise.reject(new Error('live_unsupported'));
    }
    return this._openSession();
  };

  /** Open the interview so the interviewee does not have to speak first.
   *
   * v5.34.16: warmup retry on the ACTUAL opening path. setupComplete does
   * not mean the model can generate yet; an opening sent in that instant is
   * sometimes silently dropped, so the interview opened mute (intermittent).
   * If no agent frame arrives within 3.5s, resend the opening ONCE. The
   * session sets _gotAgentFrame on any response; we check that, not a
   * timer alone, so a session that DID answer is never double-prompted. */
  LiveInterview.prototype.open = function (line) {
    // v5.34.17: RESILIENT warmup retry. setupComplete does not mean the model
    // can generate yet, and the warmup window varies — a single retry at 3.5s
    // still intermittently missed it, so the interview opened mute. Instead of
    // one retry, poll: resend the opening every ~3s until the agent actually
    // produces a frame (session._gotAgentFrame), capped at a few attempts so it
    // can never loop or double-talk once the agent is responding. This makes the
    // opening timing-independent — it WILL land as soon as the model is ready.
    var self = this;
    if (!this.session) return;
    this.session._gotAgentFrame = false;
    if (this._openRetry) { clearTimeout(this._openRetry); this._openRetry = null; }
    var attempts = 0;
    var MAX_ATTEMPTS = 4;      // ~1 initial + 3 resends over ~12s
    function fire() {
      var s = self.session;
      if (!s || s.closed || self._muted || !s.ws || s.ws.readyState !== 1) return;
      if (s._gotAgentFrame) return;        // agent responded — stop.
      if (attempts >= MAX_ATTEMPTS) return; // give up rather than loop.
      attempts++;
      try { s.sendText(line); } catch (e) {}
      self._openRetry = setTimeout(fire, 3000);
    }
    fire();
  };

  LiveInterview.prototype.say = function (text) {
    if (this.session) this.session.sendText(text);
  };

  LiveInterview.prototype.setMuted = function (m) {
    // v5.34.8: remember pause state here, not just on the socket, so the
    // grant-expiry renewal below can tell a paused session from a live one.
    this._muted = !!m;
    if (this.session) this.session.setMuted(m);
  };

  LiveInterview.prototype.isAlive = function () {
    return !!(this.session && this.session.isAlive());
  };

  /** Has ANY scoring pass succeeded? Checked before an interview is submitted. */
  LiveInterview.prototype.everScored = function () {
    return this.scoreSuccesses > 0;
  };

  /**
   * Score the closing conversation, then shut down (v5.32.55).
   *
   * stop() used to set `stopped = true` as its very first act, which suppressed
   * _score() (guarded on `stopped`) AND discarded any pass already in flight.
   * Combined with the 60-second floor, the last minute or two of every voice
   * interview went unscored — and that is the densest part, where a stakeholder
   * summarises what actually matters to them.
   *
   * So the final pass ignores the interval (it is the last one, cost is one
   * call) and is awaited before the socket closes. The timeout is a backstop:
   * an interview must never hang on the way out because scoring is slow.
   */
  LiveInterview.prototype.finalScore = function (timeoutMs) {
    var self = this;
    this._flushPending();
    if (this.stopped || this.turns.length < 2) return Promise.resolve(false);
    this.lastScoreAt = 0;          // the interval floor does not apply to the last pass
    this.scoring = false;          // let it run even if one was in flight
    this._lastScored = null;       // the transcript grew since the previous pass
    var done = false;
    return new Promise(function (resolve) {
      var finish = function (v) { if (!done) { done = true; resolve(v); } };
      setTimeout(function () { finish(false); }, timeoutMs || 12000);
      var before = self.scoreSuccesses;
      self._score();
      var poll = setInterval(function () {
        if (done) { clearInterval(poll); return; }
        if (!self.scoring) { clearInterval(poll); finish(self.scoreSuccesses > before); }
      }, 200);
    });
  };

  LiveInterview.prototype.stop = function (reason) {
    this.stopped = true;
    this._flushPending();
    if (this.session) this.session.stop(reason || 'finished');
  };

  window.vyneLiveInterview = {
    create: function (opts) { return new LiveInterview(opts); },
    /** Cheap pre-check so the caller can decide before showing any UI. */
    available: function () { return !!(window.vyneLive && window.vyneLive.isSupported()); },
    _esc: esc
  };
})();
