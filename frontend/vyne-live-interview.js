/**
 * vyne-live-interview.js — the bridge between the realtime voice session and
 * the Interview Agent's existing state machine (v5.34.31).
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

  /** Shared trace (defined in vyne-live.js). A no-op if that file is absent or
   *  stale-cached, so instrumentation can never itself break an interview. */
  function vlog(tag, data) {
    if (window.vyneLiveLog) { try { window.vyneLiveLog(tag, data); } catch (e) {} }
  }
  function rs(ws) {
    if (!ws) return 'no-socket';
    return ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] || ('?' + ws.readyState);
  }

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
   * v5.34.33 — bounded by DURATION, not by a count.
   *
   * The old ceiling was 8 renewals, on the arithmetic that eight covers two
   * hours. It does not: Google ends a Live connection roughly every ten
   * minutes (goAway), so a deep-dive interview needs one handover per ten
   * minutes of conversation — twelve for two hours, more if any connection
   * drops early. At renewal nine the live path declared itself over and the
   * interview died about eighty minutes in, which is not a limit anyone chose.
   *
   * A duration ceiling says what was actually meant: keep the interview alive
   * for as long as an interview can plausibly run, and stop a runaway page
   * from renewing forever. The count ceiling stays as a second guard, high
   * enough that it is never the thing a real interview hits.
   */
  var MAX_INTERVIEW_MS = Number(window.VYNE_MAX_INTERVIEW_MS) || 3 * 60 * 60 * 1000;
  var MAX_RENEWALS = Number(window.VYNE_MAX_RENEWALS) || 40;
  /** Consecutive 1007 CONTENT_TYPE_AUDIO closes before the live path gives up. */
  var MAX_AUDIO_REJECTIONS = 3;
  /** Pause before re-minting after such a close (overridable for tests). */
  var RENEW_BACKOFF_MS = Number(window.VYNE_RENEW_BACKOFF_MS) || 1500;
  /*
   * v5.34.39: waits after a RESOURCE_EXHAUSTED close — 15 s, 30 s, 60 s, 120 s.
   * Long on purpose: a rate limit is a budget over TIME, so the only thing that
   * helps is not spending it, and an interview can survive a two-minute gap far
   * better than it survives a dead line that never explains itself.
   */
  /*
   * v5.34.46 — A DEAD NETWORK IS NOT A REFUSAL.
   *
   * Measured, not guessed. Wi-Fi was pulled 4 minutes into a live run and the
   * trace reads, end to end, in 36 milliseconds:
   *
   *   +240534  ws ERROR
   *   +240542  session.stop(live_socket_error)
   *   +240543  LiveInterview: renewing lapsed session      <- 5.34.44 fired
   *   +240569  grant REFUSED by our server                 <- network still down
   *   +240570  LiveInterview: renewal FAILED — live path is over
   *
   * 5.34.44 correctly made a socket error renewable, and the renewal then died
   * 26 ms later trying to mint a grant over the same dead network — landing on
   * `renew_failed`, which is in DELIBERATE and therefore permanent. The fix
   * moved the failure one step downstream and stopped there.
   *
   * The flaw is that every renewal failure was treated identically. They are
   * not the same thing:
   *   - "too many live sessions", over budget, 401/403 — a REFUSAL. Retrying
   *     changes nothing and burns the cap further.
   *   - fetch rejected, 5xx, no status at all — TRANSPORT. The interviewee shut
   *     a laptop lid or walked into a lift. Thirty seconds later it works again.
   *
   * So transport failures now retry on a bounded backoff (~90 s of coverage)
   * while refusals stay terminal, and the first attempt waits a moment rather
   * than firing into a socket that has only just died.
   */
  var RENEW_RETRY_MS = Number(window.VYNE_RENEW_RETRY_MS) || 4000;
  var RENEW_RETRY_MAX_MS = Number(window.VYNE_RENEW_RETRY_MAX_MS) || 20000;
  var MAX_RENEW_RETRIES = Number(window.VYNE_MAX_RENEW_RETRIES) || 6;
  /** Let a just-dead socket settle before asking the network for anything. */
  var SOCKET_SETTLE_MS = Number(window.VYNE_SOCKET_SETTLE_MS) || 1500;

  /** Codes that mean "we were told no", not "we could not ask". */
  var REFUSALS = ['too_many_live_sessions', 'live_not_configured', 'live_free_tier_blocked',
                  'over_budget', 'budget_exceeded', 'invalid_input', 'forbidden', 'unauthorized'];

  function isTransientRenewFailure(e) {
    if (!e) return true;                                  // unknown — assume it can come back
    if (REFUSALS.indexOf(String(e.code || '')) !== -1) return false;
    var status = Number(e.status || 0);
    if (status === 401 || status === 403 || status === 429) return false;
    if (status >= 400 && status < 500) return false;      // a real client-side refusal
    return true;                                          // 0/undefined (fetch threw) or 5xx
  }

  var QUOTA_BACKOFF_MS = Number(window.VYNE_QUOTA_BACKOFF_MS) || 15000;
  var QUOTA_BACKOFF_MAX_MS = Number(window.VYNE_QUOTA_BACKOFF_MAX_MS) || 120000;
  var MAX_QUOTA_RETRIES = Number(window.VYNE_MAX_QUOTA_RETRIES) || 4;

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
                    'paused', 'renew_failed', 'restart', 'page_unload'];
  function isRenewable(reason) {
    var r = String(reason || '');
    if (DELIBERATE.indexOf(r) !== -1) return false;
    return r === 'max_duration' || r.indexOf('closed:') === 0 ||
           r === 'socket_closed' || r === 'error' || r === 'goaway' ||
           // v5.34.42: a resumed session that never spoke — reconnect WITHOUT
           // the handle rather than leave the interviewee in silence.
           r === 'renew_silent_retry' ||
           /*
            * v5.34.44 — A SOCKET ERROR IS NOT THE END OF AN INTERVIEW.
            *
            * `'error'` was in this list and looked like it covered this. It did
            * not: vyne-live.js raises the reason `'live_socket_error'`, which
            * matches none of the strings above, so every socket error fell
            * through to "not renewable" and ended the live path outright.
            *
            * Found when a 90-minute test run died: the laptop slept at minute
            * five, and on waking the socket was long dead. The interview did not
            * come back. In a real interview that is an interviewee who closed
            * their lid for lunch, or lost Wi-Fi in a lift, returning to a dead
            * line — their answers safe (5.34.42 saves synchronously) but the
            * voice gone for good, with a renewal path sitting right there
            * unused.
            *
            * Everything a renewal needs already works: the resumption handle,
            * the backoff, the concurrency exemption, and the 5.34.42 watchdog
            * for a resumed session that comes back mute. This one string was
            * all that stood between a transient network fault and a lost
            * interview.
            */
           r === 'live_socket_error';
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
      // v5.34.29: the previous connection's resumption handle, if it gave one.
      resumeHandle: this._resumeHandle || undefined,
      onResumeHandle: function (h) { if (h) self._resumeHandle = h; },
      /*
       * v5.34.33: the sessionId this grant continues. A two-hour deep dive
       * needs a fresh grant every ~10 minutes, and without this the server's
       * concurrency guard refuses the fourth handover — the interview dying
       * at our own nuisance counter rather than at anything Google did.
       * Verified server-side against this user's own holds.
       */
      renewalOf: this._lastSessionId || undefined,
      /*
       * The server announced it will close this connection. Renew NOW if the
       * model is idle; otherwise at the next turn boundary — so the handover
       * lands between sentences, and with the handle above the new session
       * picks up mid-conversation. Falls through to the existing close-driven
       * renewal if the server cuts us first.
       */
      /*
       * v5.34.40: the model sent its question as text and no voice. Hand it to
       * the app so the interview stays audible; `onAudioArrivedLate` is the
       * cancel, so a slow voice cannot end up talking over the substitute.
       */
      onReplyWithoutAudio: function (text) {
        vlog('LiveInterview: reply arrived as TEXT with no audio — asking the app to speak it', { chars: (text || '').length });
        if (self.opts.onReplyWithoutAudio) { try { self.opts.onReplyWithoutAudio(text); } catch (e) {} }
      },
      onAudioArrivedLate: function () {
        if (self.opts.onAudioArrivedLate) { try { self.opts.onAudioArrivedLate(); } catch (e) {} }
      },
      onQuotaExhausted: function (reason) {
        // Surfaced for the badge; the backoff itself is decided in onEnded.
        if (self.opts.onQuotaExhausted) { try { self.opts.onQuotaExhausted({ reason: reason }); } catch (e) {} }
      },
      onGoAway: function (timeLeftMs) {
        vlog('LiveInterview: goAway received', { timeLeftMs: timeLeftMs, idle: self._turnState !== 'speaking' && self._turnState !== 'thinking' });
        self._goAwayPending = true;
        self._maybeRenewOnGoAway();
      },
      onTurnState: function (s) {
        self._turnState = s;
        if (s === 'idle' && self._goAwayPending) self._maybeRenewOnGoAway();
        if (self.opts.onTurnState) { try { self.opts.onTurnState(s); } catch (e) {} }
      },

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
        // Speech has begun: whatever "preparing" state the UI is showing is over.
        if (!self._spoke) { self._spoke = true; if (self.opts.onAgentSpeaking) { try { self.opts.onAgentSpeaking(); } catch (e) {} } }
        if (self.opts.onPartialAgent) { try { self.opts.onPartialAgent(t); } catch (e) {} }
      },
      /*
       * The model is reasoning in text before speaking (v5.34.19). This is
       * NOT transcript — it never reaches turns[], the on-screen bubbles, or the
       * scoring pass, all of which take agentText only. It exists so the page
       * can say "your interviewer is preparing" instead of showing an idle
       * screen for the ten to twenty seconds a native-audio model can spend
       * composing an opening.
       */
      onAgentThinking: function (t) {
        if (self.opts.onAgentThinking) { try { self.opts.onAgentThinking(t); } catch (e) {} }
      },
      /** Fired once, from whichever arrives first — audio or transcript. */
      onAgentSpeaking: function () {
        if (self._spoke) return;
        self._spoke = true;
        if (self.opts.onAgentSpeaking) { try { self.opts.onAgentSpeaking(); } catch (e) {} }
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
      // v5.34.22: per-turn state and uplink level, straight through to the
      // page. Neither is transcript; both are what the interviewee needs to
      // SEE — "it heard me", "it is thinking", "it is speaking" — so that a
      // normal ten-second reply latency no longer reads as a dead line and
      // sends them to a microphone button that does not belong to this path.
      onMicLevel: function (rms, peak) { if (self.opts.onMicLevel) { try { self.opts.onMicLevel(rms, peak); } catch (e) {} } },
      onMicSilent: function (info) { if (self.opts.onMicSilent) { try { self.opts.onMicSilent(info); } catch (e) {} } },
      onNoReply: function (n) { if (self.opts.onNoReply) { try { self.opts.onNoReply(n); } catch (e) {} } },
      onUplinkIgnored: function (st) { if (self.opts.onUplinkIgnored) { try { self.opts.onUplinkIgnored(st); } catch (e) {} } },
      onApiMismatch: function () { if (self.opts.onApiMismatch) { try { self.opts.onApiMismatch(); } catch (e) {} } },
      onAudioRejected: function (reason) { if (self.opts.onAudioRejected) { try { self.opts.onAudioRejected(reason); } catch (e) {} } },
      // Forwarded so the UI can show WHICH voice the session actually opened
      // with. v5.32.51: without this the only way to tell whether a voice
      // selection had taken effect was to listen to it and guess — which is
      // exactly how a silently-dropped voice survived several releases.
      /*
       * v5.34.18: ATTACH THE SESSION HERE, not only in _openSession's .then().
       *
       * onReady is dispatched synchronously from the setupComplete frame, which
       * is BEFORE the promise chain that assigns self.session has run. Callers
       * legitimately open the interview from onReady — that is the earliest
       * correct moment — and were finding `this.session === null`, so
       * LiveInterview.open() bailed on its first line and the interview opened
       * mute. Take the session from the argument so the ordering cannot matter.
       */
      onReady: function (g, sess) {
        if (sess && self.session !== sess) {
          vlog('LiveInterview: session attached from onReady (before promise chain)');
          self.session = sess;
        }
        if (self.opts.onReady) { try { self.opts.onReady(g, sess); } catch (e) { vlog('app onReady THREW', e && e.message); } }
      },
      onState: function (s) { if (self.opts.onState) { try { self.opts.onState(s); } catch (e) {} } },
      onError: function (r, e) { if (self.opts.onError) { try { self.opts.onError(r, e); } catch (x) {} } },
      onEnded: function (r) {
        /*
         * v5.34.46 — WHILE A RENEWAL IS IN FLIGHT, IT OWNS THE OUTCOME.
         *
         * The replacement session is being born here. If its own start fails —
         * `mint_failed` when the network is still down — vyne-live.js calls
         * stop() on it, which re-enters THIS handler with a reason that is not
         * renewable, sets stopped = true, and fires onEnded('mint_failed').
         * The renewal's own catch then ran a moment later and found the
         * interview already declared over, so the retry it was about to make
         * was skipped.
         *
         * That is why the measured Wi-Fi trace ended TWICE:
         *     interview ENDED: mint_failed
         *     interview ENDED: renew_failed
         * Two endings for one failure, and the first one silently disarmed the
         * recovery for the second. The renewal chain decides; the dying
         * replacement does not get a vote.
         */
        if (self._renewing) {
          vlog('LiveInterview: ignoring session end while a renewal is in flight — the renewal decides',
               { reason: r });
          return;
        }
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
        /*
         * v5.34.27: a 1007 CONTENT_TYPE_AUDIO close is Google refusing to answer
         * an audio turn on this model configuration (see vyne-live.js
         * ws.onclose). Renewing instantly re-minted a grant every ~7 s — two in
         * one trace — which is how the per-user grant cap gets spent and the
         * interview lands on the text+TTS fallback (S4 by another road). So:
         * back off a little, count consecutive rejections, and after three
         * stop renewing and END the live path with a reason the page can show.
         */
        /*
         * v5.34.39 — a rate-limited project needs TIME, not another connection.
         *
         * When Google closes with RESOURCE_EXHAUSTED, the renewal path was
         * re-minting within milliseconds, which spends more of the allowance
         * that has just run out. The soak's `base2` run shows the result: five
         * connections in ten minutes, four of them killed, half the answers
         * never replied to. Each retry made the next one likelier to fail.
         *
         * So this one reason gets escalating backoff instead — and the
         * interviewee is told the truth, because "the connection is rate
         * limited, waiting" is a fundamentally different thing to sit through
         * than a silence with no explanation.
         */
        var quotaHit = !!(self.session && self.session.quotaExhausted);
        self._quotaHits = quotaHit ? (self._quotaHits || 0) + 1 : 0;
        var quotaWaitMs = quotaHit ? Math.min(QUOTA_BACKOFF_MAX_MS, QUOTA_BACKOFF_MS * Math.pow(2, self._quotaHits - 1)) : 0;
        if (quotaHit) {
          vlog('LiveInterview: rate-limited by Google — backing off before the next connection', {
            consecutive: self._quotaHits, waitMs: quotaWaitMs });
          if (self.opts.onQuotaExhausted) {
            try { self.opts.onQuotaExhausted({ consecutive: self._quotaHits, waitMs: quotaWaitMs }); } catch (e) {}
          }
        }
        if (quotaHit && self._quotaHits > MAX_QUOTA_RETRIES) {
          vlog('LiveInterview: still rate-limited after ' + MAX_QUOTA_RETRIES + ' waits — live voice is over for now');
          self.stopped = true;
          if (self.opts.onEnded) { try { self.opts.onEnded('quota_exhausted', self.turns.slice()); } catch (e) {} }
          return;
        }

        var rejected = !!(self.session && self.session.audioRejected);
        self._audioRejections = rejected ? (self._audioRejections || 0) + 1 : 0;
        if (rejected && self._audioRejections >= MAX_AUDIO_REJECTIONS) {
          vlog('LiveInterview: ' + self._audioRejections + ' consecutive 1007 CONTENT_TYPE_AUDIO closes — live path is over for this model configuration');
          self.stopped = true;
          if (self.opts.onEnded) { try { self.opts.onEnded('audio_rejected', self.turns.slice()); } catch (e) {} }
          return;
        }
        var elapsedMs = Date.now() - (self._startedAt || Date.now());
        var withinDuration = elapsedMs < MAX_INTERVIEW_MS;
        if (!withinDuration) {
          vlog('LiveInterview: NOT renewing — the interview has run past its duration ceiling',
               { elapsedMin: Math.round(elapsedMs / 60000), ceilingMin: Math.round(MAX_INTERVIEW_MS / 60000) });
        }
        if (isRenewable(r) && !self.stopped && !self._muted && withinDuration && self.renewals < MAX_RENEWALS) {
          self.renewals++;
          vlog('LiveInterview: renewing lapsed session', { reason: r, renewal: self.renewals,
               elapsedMin: Math.round(elapsedMs / 60000),
               afterAudioRejection: rejected, delayMs: rejected ? RENEW_BACKOFF_MS : 0 });
          if (self.opts.onRenewing) { try { self.opts.onRenewing(self.renewals, r); } catch (e) {} }
          var settleMs = (r === 'live_socket_error') ? SOCKET_SETTLE_MS : 0;
          /*
           * v5.34.46 — one named chain, so a transport retry re-enters exactly
           * the same path: the resumption handle, the nudge and the 5.34.42
           * mute-resume watchdog all still apply on the retry. A second,
           * parallel reconnect path would drift from this one within a release.
           */
          self._renewing = true;
          /*
           * v5.34.47 — ONE place computes the wait before an attempt.
           *
           * .46 applied the backoff twice: once in the retry's setTimeout and
           * again inside attemptRenewal via retryWaitMs. The trace logged
           * 4s/8s/16s while the real gaps were 8s/16s/32s, so a recovery that
           * was designed to take ~28 s took 58 s, and the log disagreed with
           * the recording. The delay now lives here and nowhere else; the
           * retry path calls attemptRenewal() directly and logs this number.
           */
          var renewWaitMs = function () {
            var retryWaitMs = self._renewRetries
              ? Math.min(RENEW_RETRY_MAX_MS, RENEW_RETRY_MS * Math.pow(2, self._renewRetries - 1)) : 0;
            return Math.max(quotaWaitMs, rejected ? RENEW_BACKOFF_MS : 0, settleMs, retryWaitMs);
          };
          var attemptRenewal = function () {
            var waitMs = renewWaitMs();
            if (!waitMs) return self._openSession();
            return new Promise(function (res) { setTimeout(res, waitMs); }).then(function () {
              // The interview can end while we are waiting out the backoff.
              if (self.stopped || self._muted) return Promise.reject({ code: 'renew_aborted' });
              return self._openSession();
            });
          };
          var onRenewalOk = function () {
            self._renewing = false;
            self._renewRetries = 0;          // back on the network; forget the streak
            if (self.opts.onRenewed) { try { self.opts.onRenewed(self.renewals); } catch (e) {} }
            // Pick the thread back up rather than sitting mute waiting for the
            // interviewee to speak first into what looks like a dead line.
            // v5.34.29: with a resumption handle the session already HAS the
            // conversation; a nudge would make Jack restate his last question.
            var resumed = !!(self.session && self.session.grant && self.session.grant.pinnedExtras && self.session.grant.pinnedExtras.resumed);
            vlog('LiveInterview: renewed', { resumedWithHandle: resumed });
            /*
             * v5.34.31: a resumed session has the whole conversation, but it is
             * a NEW connection with no turn in flight — it says nothing until
             * spoken to, and the interviewee does not know whose turn it is.
             * 5.34.29 sent no nudge here, which is the "went a bit silent"
             * after the 10-minute handover. Nudge, but tell it what it has.
             */
            /*
             * v5.34.42 — the nudge goes through open(), not say().
             *
             * A real 10-minute interview died exactly here. The trace:
             *   587703  setupComplete — session is live
             *   587705  sendText -> WIRE  "Our connection was briefly renewed…"
             *   598390  userTranscript "Are you there?"
             *   610394  !!! NO MODEL ACTIVITY 12s after the interviewee was transcribed
             * Two milliseconds after setupComplete. That is precisely the warmup
             * instant open() exists for — "setupComplete does not mean the model
             * can generate yet; a turn sent in that instant is sometimes
             * silently dropped" (v5.34.16-19, and the machinery below it). The
             * OPENING has been protected against this for six releases; the
             * renewal nudge was sending raw text into the same window with no
             * retry, no liveness check and no alarm, so every handover was a
             * coin flip and a lost one killed the interview outright.
             *
             * open() resets the new session's frame flags, sends, and resends
             * ONCE if nothing at all comes back. Same guarantee, same code.
             */
            /*
             * v5.34.44 — REVERTED to the 5.34.42 wording. Measured, not reasoned.
             *
             * 5.34.43 shortened this to "Please continue." on the theory that a
             * long instruction was what made the native-audio model answer in
             * text at a handover. Ninety minutes on the real API said otherwise,
             * and said it unambiguously:
             *
             *   5.34.42, 9 handovers:  3 text-only replies ("I am still here.")
             *   5.34.43, 9 handovers: 18 text-only replies — every one of them
             *                         the literal string "Please continue.",
             *                         at replyNo 1, 2 or 3 of a renewal.
             *
             * Six times worse. The model was ECHOING the nudge back rather than
             * acting on it. Length was never the problem: the opening trigger
             * "Please begin the interview now" works because it names an ACTION,
             * and "Please continue" names nothing, so there is nothing to do with
             * it but repeat it. The long form below tells the model what to say
             * and then what to do next, which is exactly why it does not echo.
             *
             * Do not shorten this again without a 90-minute run to compare
             * against. The archived evidence is voice-runs/tier1-90min.* (this
             * wording, 3 mute turns) and voice-runs/tier1-90min-v43.* (the short
             * trigger, 20). The remaining 3 are a separate, older class — the
             * model starting a question whose audio never arrives — and are not
             * addressed here.
             */
            self.open(resumed
              ? 'Our connection was briefly renewed; you still have the whole conversation. In one short sentence '
                + 'say you are still here, then either wait for the rest of my answer or repeat your last question '
                + 'if I had not answered it yet. Do not greet me again.'
              : 'The connection was renewed mid-interview. Continue exactly where you left off '
                + 'with your next question — do not greet them again or mention the interruption.');
            self._watchRenewedSilence();
          };
          var onRenewalFail = function (e) {
            self._renewing = false;
            /*
             * v5.34.47 — the interview ended while a retry was waiting out its
             * backoff. Whoever stopped it already owns the ending; saying
             * "renewal FAILED" here would end it a second time.
             */
            if (e && e.code === 'renew_aborted') {
              vlog('LiveInterview: renewal abandoned — the interview stopped while waiting to retry');
              return;
            }
            /*
             * v5.34.22: a failed renewal is TERMINAL for the live path. Before,
             * `stopped` stayed false here, so the page's routing saw an interview
             * that was neither live nor finished — and the text+TTS path took
             * the next message, in a different voice, over a session that might
             * still come back. One owner: live is over, say so.
             */
            vlog('LiveInterview: renewal FAILED — live path is over', { err: e && (e.code || e.message), status: e && e.status });
            /*
             * v5.34.33: name the one refusal that looks like a product fault
             * and is not. The ~10-minute goAway handover mints a FRESH grant,
             * and a user is capped at a few grants inside a rolling window
             * (routes/voice.ts, VYNE_LIVE_MAX_CONCURRENT /
             * VYNE_LIVE_OPEN_WINDOW_SECONDS). After a few test interviews the
             * cap is already spent, so the handover — not the interview — is
             * what gets refused, and a session that was running perfectly
             * stops dead at ten minutes.
             */
            if (e && e.code === 'too_many_live_sessions') {
              vlog('!!! the 10-minute handover was REFUSED BY OUR OWN CAP, not by Google — this user has too many ' +
                   'recent grants in the rolling window. Raise VYNE_LIVE_MAX_CONCURRENT on the API (it is a ' +
                   'runaway-tab guard, not the spend control) or wait out the window.');
            }
            /*
             * v5.34.46 — retry TRANSPORT failures; only refusals are terminal.
             */
            if (isTransientRenewFailure(e) && !self.stopped && !self._muted &&
                (self._renewRetries || 0) < MAX_RENEW_RETRIES) {
              self._renewRetries = (self._renewRetries || 0) + 1;
              // renewWaitMs() reads the streak we just incremented, so this is
              // the wait the next attempt will actually take — not a second
              // copy of it (v5.34.47).
              var backoff = renewWaitMs();
              vlog('LiveInterview: renewal failed on TRANSPORT, not refusal — retrying', {
                attempt: self._renewRetries, of: MAX_RENEW_RETRIES, inMs: backoff,
                err: e && (e.code || e.message), status: e && e.status });
              if (self.opts.onRenewing) { try { self.opts.onRenewing(self.renewals, 'reconnecting'); } catch (x) {} }
              // Re-enter the same path the close handler uses, so the resumption
              // handle, the nudge and the mute-resume watchdog all still apply.
              // attemptRenewal() owns the delay; there is no setTimeout here.
              self._renewing = true;
              attemptRenewal().then(onRenewalOk).catch(onRenewalFail);
              return;
            }
            if (!isTransientRenewFailure(e)) {
              vlog('LiveInterview: renewal REFUSED (not a transport fault) — live path is over',
                   { code: e && e.code, status: e && e.status });
            } else {
              vlog('LiveInterview: still no network after ' + MAX_RENEW_RETRIES +
                   ' attempts — live path is over');
            }
            self.stopped = true;
            if (self.opts.onEnded) { try { self.opts.onEnded('renew_failed', self.turns.slice()); } catch (x) {} }
          };
          attemptRenewal().then(onRenewalOk).catch(onRenewalFail);
          return;
        }
        // Not renewing: paused sessions lapse quietly and come back on Resume
        // (setInterviewPaused re-mints), everything else is the end of live.
        if (!self._muted) self.stopped = true;
        if (self.opts.onEnded) { try { self.opts.onEnded(r, self.turns.slice()); } catch (e) {} }
      }
    };
  };

  /** Renew this long before the grant's token expires (at a turn boundary). */
  var EXPIRY_LEAD_MS = Number(window.VYNE_EXPIRY_LEAD_MS) || 20000;

  LiveInterview.prototype._openSession = function () {
    var self = this;
    vlog('LiveInterview._openSession() — starting vyneLive session');
    return window.vyneLive.start(this._sessionOpts()).then(function (s) {
      // Normally already attached by onReady above; kept so the session is
      // correct even if a future transport stops passing it to onReady.
      vlog('_openSession resolved (promise chain ran)', { alreadyAttached: self.session === s });
      self.session = s;
      /*
       * v5.34.33 — the goAway that belonged to the PREVIOUS connection dies
       * with it.
       *
       * Found by the two-hour soak, not by a person: when a connection is
       * dropped by the server before the deferred handover fires (the
       * interviewee was still speaking, then the socket went), the renewal
       * runs down the close path and the stale `_goAwayPending` survives into
       * the fresh connection — which then hands over AGAIN about a second
       * later, on a connection nobody asked to close. Two handovers where one
       * was needed, an extra grant against the cap, and a second gap in the
       * conversation. A goAway is a fact about one socket; it must not outlive
       * it.
       */
      if (self._goAwayPoll) { clearInterval(self._goAwayPoll); self._goAwayPoll = null; }
      if (self._renewSilenceTimer) { clearTimeout(self._renewSilenceTimer); self._renewSilenceTimer = null; }
      if (self._goAwayPending) {
        vlog('LiveInterview: clearing the previous connection\'s goAway — it does not apply to this one');
        self._goAwayPending = false;
      }
      /* v5.34.33: remember this grant's sessionId so the NEXT connection can
       * identify itself as its continuation (see _sessionOpts.renewalOf). */
      if (s && s.grant && s.grant.sessionId) self._lastSessionId = s.grant.sessionId;
      self._flushPendingSay();
      self._armExpiryRenewal(s);
      return self;
    });
  };

  /*
   * v5.34.29: the token has a hard wall-clock expiry and Google closes the
   * socket on it mid-sentence ("1011 — auth token has expired"; a production
   * trace showed it exactly 300 s after each mint). Treat it like goAway:
   * renew a little early, at a turn boundary, with the resumption handle, so
   * the interviewee never hears the cut. The close-driven renewal remains the
   * fallback if the timer is late.
   */
  LiveInterview.prototype._armExpiryRenewal = function (s) {
    var self = this;
    if (this._expiryTimer) { clearTimeout(this._expiryTimer); this._expiryTimer = null; }
    var g = s && s.grant, expMs = g && g.expiresAt ? Date.parse(g.expiresAt) : NaN;
    if (!isFinite(expMs)) return;
    var inMs = expMs - Date.now() - EXPIRY_LEAD_MS;
    if (inMs < 200) inMs = 200;
    vlog('LiveInterview: token expiry renewal armed', { inSec: Math.round(inMs / 1000), expiresAt: g.expiresAt });
    this._expiryTimer = setTimeout(function () {
      self._expiryTimer = null;
      if (self.session !== s || self.stopped) return;
      vlog('LiveInterview: token expiry approaching — renew at next turn boundary');
      self._goAwayPending = true;
      self._maybeRenewOnGoAway();
    }, inMs);
  };

  LiveInterview.prototype.start = function () {
    if (!window.vyneLive || !window.vyneLive.isSupported()) {
      return Promise.reject(new Error('live_unsupported'));
    }
    // v5.34.33: when the INTERVIEW began, as distinct from when this
    // connection began. Renewals are bounded by this, so a deep dive gets as
    // many handovers as its duration needs.
    if (!this._startedAt) this._startedAt = Date.now();
    return this._openSession();
  };

  /** Minutes of conversation so far, across every connection it took. */
  LiveInterview.prototype.elapsedMinutes = function () {
    return this._startedAt ? Math.round((Date.now() - this._startedAt) / 60000) : 0;
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
    vlog('LiveInterview.open() called', { hasSession: !!this.session, line: String(line).slice(0, 60) });

    /*
     * v5.34.18: DO NOT SILENTLY RETURN WHEN THE SESSION IS NOT ATTACHED YET.
     *
     * This early return was the auto-start bug. open() is called from onReady,
     * which vyne-live.js dispatches synchronously from the setupComplete frame —
     * before the promise chain assigning self.session has run. So on every clean
     * start the function returned here, having sent nothing, initialised no
     * _gotAgentFrame and armed no retry, while the caller had already flipped
     * _openingSent to true and disarmed its own backstop.
     *
     * The onReady handler above now attaches the session, so this should no
     * longer be reachable on the normal path. It is kept as a genuine retry
     * rather than a bail: a microtask is all the promise chain needs, and one
     * bounded re-entry is cheaper than another mute interview.
     */
    if (!this.session) {
      if (this._openDeferred) { vlog('open() BAILED — no session, and already deferred once'); return false; }
      this._openDeferred = true;
      vlog('open() DEFERRED — session not attached yet, retrying next microtask');
      Promise.resolve().then(function () { self.open(line); });
      return false;
    }
    this._openDeferred = false;
    this.session._gotAgentFrame = false;
    this.session._gotAnyModelFrame = false;
    if (this._openRetry) { clearTimeout(this._openRetry); this._openRetry = null; }
    var attempts = 0;
    /*
     * v5.34.19: ONE resend, and only into total silence.
     *
     * v5.34.17 resent every 3s until the agent produced a frame, capped at 4.
     * Measured against a real session, that was actively harmful. The
     * native-audio model reasons in TEXT for ten to twenty seconds before an
     * opening — a real trace showed first audio at 15.5s — and the retry's
     * liveness check ignored text frames, so it fired all four times, at +24s,
     * +27s, +30s and +33s. Each resend arrives as a fresh user turn and the
     * model starts over ("Restarting the Introduction", "Re-initiating the
     * Discussion"). The retry added to cure a silent opening was prolonging it.
     *
     * The genuine failure it exists for — a turn dropped in the warmup instant,
     * where NOTHING comes back at all — is distinguishable: zero frames of any
     * kind. So wait long enough to clear a normal think, then resend at most
     * once. If the model is thinking, _gotAnyModelFrame is already true and
     * nothing is sent.
     */
    var MAX_ATTEMPTS = 2;        // the opening, plus one rescue for a dropped turn
    // Comfortably past a normal 10-20s think. Overridable ONLY so tests can
    // assert the retry policy without sleeping twelve seconds per case — the
    // previous policy's tests passed partly because nothing they measured had
    // time to happen.
    var RETRY_AFTER_MS = Number(window.VYNE_OPEN_RETRY_MS) || 12000;
    function fire() {
      var s = self.session;
      // Log the guard values on EVERY attempt. When the opening does not land,
      // which guard stopped it is the entire question, and all four are
      // invisible from outside.
      var g = { attempt: attempts + 1, of: MAX_ATTEMPTS,
                hasSession: !!s, closed: !!(s && s.closed), muted: !!self._muted,
                readyState: rs(s && s.ws), gotAgentFrame: !!(s && s._gotAgentFrame),
                gotAnyModelFrame: !!(s && s._gotAnyModelFrame) };
      if (!s || s.closed || self._muted || !s.ws || s.ws.readyState !== 1) {
        vlog('open/fire STOPPED — session not sendable', g); return;
      }
      if (s._gotAgentFrame) { vlog('open/fire STOPPED — agent already speaking', g); return; }
      // The one that matters: a thinking model is a working model. Resending
      // here is what restarted it four times in the trace.
      if (s._gotAnyModelFrame) { vlog('open/fire STOPPED — model is working (thinking), not dropped', g); return; }
      if (attempts >= MAX_ATTEMPTS) { vlog('open/fire GAVE UP — attempt cap reached', g); return; }
      attempts++;
      vlog(attempts === 1 ? 'open/fire SENDING opening' : 'open/fire RESENDING (total silence — turn looks dropped)', g);
      try { s.sendText(line); } catch (e) { vlog('open/fire sendText THREW', e && e.message); }
      self._openRetry = setTimeout(fire, RETRY_AFTER_MS);
    }
    fire();
    return true;
  };

  /** Text turns that may be queued while a renewal is in flight. Bounded:
   *  a page cannot pile up an unbounded backlog against a socket that never
   *  returns — the renewal either completes or ends the live path. */
  var MAX_PENDING_SAY = 5;

  LiveInterview.prototype.say = function (text) {
    var alive = this.isAlive();
    vlog('LiveInterview.say()', { hasSession: !!this.session, alive: alive, text: String(text).slice(0, 60) });
    /*
     * v5.34.22: while live OWNS the conversation but the socket is momentarily
     * gone (grant lapsed, renewal in flight), a typed message used to fall
     * through to the text+TTS path — a second model, a second voice, a second
     * transcript, over an interview that was about to come back. Hold it here
     * and send it into the renewed session instead. sendText() already queues
     * across CONNECTING; this covers the gap before a socket exists at all.
     */
    if (!alive && !this.stopped) {
      var q = this._pendingSay || (this._pendingSay = []);
      if (q.length >= MAX_PENDING_SAY) q.shift();
      q.push(String(text));
      vlog('LiveInterview.say() HELD — no live socket yet; will send into the renewed session', { queued: q.length });
      return false;
    }
    if (this.session) return this.session.sendText(text);
    return false;
  };
  LiveInterview.prototype._flushPendingSay = function () {
    var q = this._pendingSay; this._pendingSay = null;
    if (!q || !q.length || !this.session) return;
    vlog('LiveInterview: flushing held text turns into renewed session', { count: q.length });
    for (var i = 0; i < q.length; i++) { try { this.session.sendText(q[i]); } catch (e) {} }
  };

  LiveInterview.prototype.setMuted = function (m) {
    /*
     * v5.34.19: capture WHO muted.
     *
     * A real trace showed setMuted(true) at +55.8s mid-answer, after which every
     * subsequent turn was discarded. Nothing in the app mutes on a timer, on tab
     * visibility, or on any model event — the only two paths are the in-interview
     * Pause button and the interviewee banner's "Pause — continue later", both
     * user clicks. So the useful thing is not another guard, it is a name: the
     * stack says which control fired, and whether anything fired it at all.
     */
    vlog('LiveInterview.setMuted(' + !!m + ')', {
      was: !!this._muted,
      via: (function () {
        try { return String(new Error().stack || '').split('\n').slice(2, 6).join(' | '); }
        catch (e) { return 'unavailable'; }
      })()
    });
    // v5.34.8: remember pause state here, not just on the socket, so the
    // grant-expiry renewal below can tell a paused session from a live one.
    this._muted = !!m;
    if (this.session) this.session.setMuted(m);
  };

  /** Proactive handover on goAway / token expiry — only ever between turns,
   *  and only while the interviewee is not mid-sentence (v5.34.31): the
   *  ~1.5 s of handover has no socket, so anything said then is lost, and a
   *  half-heard answer is exactly the "went a bit silent" that follows. */
  LiveInterview.prototype._maybeRenewOnGoAway = function () {
    var self = this;
    if (!this._goAwayPending || this.stopped || this._muted) return;
    if (this._turnState === 'speaking' || this._turnState === 'thinking') return;
    if (!this.session || this.session.closed) return;
    var s = this.session;
    var quietMs = s._micLastLoudAt ? Date.now() - s._micLastLoudAt : Infinity;
    if (s._micInUtterance || quietMs < 1500) {
      if (!this._goAwayPoll) {
        vlog('LiveInterview: handover deferred — interviewee is speaking');
        this._goAwayPoll = setInterval(function () {
          if (!self._goAwayPending || self.stopped) { clearInterval(self._goAwayPoll); self._goAwayPoll = null; return; }
          self._maybeRenewOnGoAway();
        }, 300);
      }
      return;
    }
    if (this._goAwayPoll) { clearInterval(this._goAwayPoll); this._goAwayPoll = null; }
    this._goAwayPending = false;
    vlog('LiveInterview: renewing ahead of goAway at a turn boundary', { hasResumeHandle: !!this._resumeHandle });
    // stop() with a renewable reason drives the normal onEnded → renewal path.
    s.stop('goaway');
  };

  /**
   * v5.34.42 — if a RESUMED session never speaks, stop resuming.
   *
   * open()'s retry rescues a dropped turn. It cannot rescue a resumed session
   * that is itself wedged — and the trace above shows one: the nudge went out,
   * the interviewee then said "Are you there?", it was transcribed, and the
   * model produced nothing but empty `speechState` frames for the rest of the
   * interview. A handle that yields a mute session is worse than no handle,
   * because the alternative is not silence: a fresh connection still carries
   * the recent transcript through buildLiveContext, so the interviewer picks
   * up the thread even without Google's own memory of it.
   *
   * So: one recovery attempt per renewal, and the interviewee is told rather
   * than left listening to nothing.
   */
  var RENEW_SILENCE_MS = Number(window.VYNE_RENEW_SILENCE_MS) || 20000;

  LiveInterview.prototype._watchRenewedSilence = function () {
    var self = this;
    if (this._renewSilenceTimer) { clearTimeout(this._renewSilenceTimer); }
    this._renewSilenceTimer = setTimeout(function () {
      self._renewSilenceTimer = null;
      var s = self.session;
      if (!s || s.closed || self.stopped || self._muted) return;
      if (s._gotAnyModelFrame) return;                 // it is working; nothing to do
      if (self._recoveredSilentRenewal) {
        vlog('!!! the renewed session is STILL silent after dropping the resume handle — live voice is over', {
          elapsedMin: self.elapsedMinutes() });
        self.stopped = true;
        if (self.opts.onEnded) { try { self.opts.onEnded('renew_silent', self.turns.slice()); } catch (e) {} }
        return;
      }
      self._recoveredSilentRenewal = true;
      vlog('!!! RESUMED SESSION IS MUTE — no model frame of any kind ' + RENEW_SILENCE_MS + 'ms after the handover. ' +
           'Dropping the resumption handle and reconnecting fresh; the recent transcript still goes across as context.',
           { hadHandle: !!self._resumeHandle, elapsedMin: self.elapsedMinutes() });
      if (self.opts.onRenewSilent) { try { self.opts.onRenewSilent(); } catch (e) {} }
      self._resumeHandle = null;                        // fresh session, no handle
      try { s.stop('renew_silent_retry'); } catch (e) {}
    }, RENEW_SILENCE_MS);
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
    if (this._expiryTimer) { clearTimeout(this._expiryTimer); this._expiryTimer = null; }
    if (this._goAwayPoll) { clearInterval(this._goAwayPoll); this._goAwayPoll = null; }
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
