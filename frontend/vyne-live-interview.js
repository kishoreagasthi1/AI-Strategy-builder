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
   * turns, and the call count on the statement was dominated by them.
   *
   * v5.34.73 — this comment used to end: "Scoring sees the whole running
   * transcript, so a longer gap loses nothing — the next pass still covers
   * everything said in between." That is false and always was.
   * transcriptText() below is `turns.slice(-TRANSCRIPT_WINDOW)` — the last 24
   * turns, not the whole transcript.
   *
   * Nothing is lost TODAY only because the window is wider than the interval:
   * 24 turns is roughly 4.75 minutes of a real interview (measured over the
   * 30-minute run of 2026-09-13: 152 turns in 1805 seconds) against a 60-second
   * gap, so consecutive passes overlap about fivefold. But the false sentence
   * was the justification anyone would lean on to RAISE the interval, and at a
   * brisk three seconds a turn the window is 72 seconds and the margin is
   * essentially gone. Evidence would then fall between passes silently, and a
   * dimension nobody ever scored looks exactly like a dimension nobody
   * discussed.
   *
   * If you raise this, raise TRANSCRIPT_WINDOW with it and keep the window at
   * least three times the interval in turns.
   */
  /*
   * v5.34.86 — 60s → 20s, because the scorecard is a LIVE meter.
   *
   * The interview screen shows seven dimension bars beside the conversation,
   * and they move only when a scoring pass lands. At a 60-second floor a
   * dimension could be discussed, evidenced and left behind before the meter
   * acknowledged it existed — the panel read as broken rather than as an
   * assessment forming while you watch. That matters more now that a dead
   * scorer ends the sitting (v5.34.85): the meter moving IS the signal that
   * scoring is alive.
   *
   * Priced before changing it rather than after. A pass sends the 24-turn
   * window (~3k tokens in) and returns a small JSON (~150 out), on flash-lite
   * at $0.10/M in and $0.40/M out — about $0.00036 a pass. Across a 60-minute
   * interview that is ~$0.02 at the old floor and ~$0.07 at this one. Four
   * cents an interview for a meter that responds to the conversation is not a
   * trade worth hesitating over.
   *
   * This is a FLOOR, not a schedule: passes are driven by completed turns and
   * skipped when the window has not changed (_lastScored), so a quiet stretch
   * still costs nothing.
   */
  var SCORE_MIN_INTERVAL_MS = 20000;
  /** Enough recent conversation for scoring context, bounded for cost. */
  var TRANSCRIPT_WINDOW = 24;

  /*
   * When scoring is dead enough to stop the interview. (v5.34.85)
   *
   * A pass runs at most once a minute (SCORE_MIN_INTERVAL_MS), so these are
   * minutes, not seconds — deliberately slow to fire. Ending a sitting in front
   * of an executive is a real cost; it is simply a smaller one than an hour
   * that yields no evidence.
   *
   * The two thresholds differ because the two situations differ. Three failures
   * AFTER a success is a provider that has gone down mid-interview: unambiguous,
   * and three minutes of unscored conversation is already a material hole in
   * the evidence. Never having scored is more often a thin opening than an
   * outage — the model is right to report no evidence from two sentences of
   * pleasantries — so that one waits longer before concluding the pipe is
   * broken rather than the conversation young.
   */
  var STOP_AFTER_CONSECUTIVE = 3;
  var STOP_IF_NEVER_SCORED_BY = 5;
  /*
   * ── v5.34.88: AND a duration, because a count alone is not a duration ──────
   *
   * The counts above were chosen in v5.34.85 reasoning "a pass runs at most
   * once a minute, so these are minutes". v5.34.86 then lowered
   * SCORE_MIN_INTERVAL_MS from 60s to 20s to make the live meter responsive,
   * and never revisited them — so "five passes without a score" quietly became
   * a hundred seconds instead of five minutes, and the interview could be
   * ended, in front of a client, over a ninety-second provider wobble.
   *
   * Two correct changes that are wrong together. Tying the thresholds to a
   * cadence constant declared elsewhere in the same file is what made that
   * possible, so they are no longer tied to it: a stop requires the count AND
   * a wall-clock stretch of continuous failure. Retune the cadence freely now
   * — the stop still means what it says.
   *
   * Ending a sitting is right when scoring is genuinely dead and wrong when it
   * is merely slow, and the only thing that distinguishes those is elapsed
   * time.
   */
  var STOP_AFTER_MS = 180000;          // 3 minutes of failing, having worked
  var STOP_IF_NEVER_SCORED_AFTER_MS = 300000;  // 5 minutes never having worked

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
      /*
       * v5.34.85 — the SHARED scale and calibration, not a private copy.
       *
       * This line was a hand-written duplicate of VyneScoring.SCALE, and the
       * benchmark calibration the text path carries was missing entirely.
       * scoringRubricParity.test.ts pins interview_agent.html against the
       * shared definition for exactly this reason and never looked at this
       * file — so the path that now produces most of the scores was the one
       * free to drift.
       *
       * It matters beyond tidiness: computeRoundScores averages voice and text
       * interviews into ONE round score. Two rubrics behind one number means
       * the number means neither.
       *
       * The literals stay as a fallback because vyne-scoring.js is page
       * furniture that not every context loads, and a scoring pass with a
       * slightly stale scale is worth more than no scoring pass at all.
       */
      'Scale: ' + ((window.VyneScoring && window.VyneScoring.SCALE) ||
        '1=Not Started, 2=Early/Ad Hoc, 3=Developing, 4=Advanced, 5=Leading/Optimized'),
      (window.VyneScoring && window.VyneScoring.BENCHMARK_CALIBRATION) || null,
      '',
      'FINDING ATTRIBUTION: write any finding as a CONDITION of the function or organisation,',
      'never as a named individual\'s act or fault. Not "the CRO blocked deployments" but',
      '"deployments have been paused pending explainability evidence."',
      '',
      /*
       * v5.34.85 — COVERAGE, which the voice path never reported.
       *
       * On a follow-up round tenant/scoring.ts blends each dimension against the
       * prior round in proportion to how much this conversation actually
       * re-evidenced it. applyScoreData reads that from scoreData.coverage — and
       * this template had no coverage key, so every voice refresh fell through
       * to the 0.3 default no matter how thoroughly a dimension was re-covered.
       * The whole delta-scoring feature was inert for voice, which is now most
       * interviews.
       *
       * Asked for only in refresh mode: on a first assessment there is nothing
       * to blend against, and a key the scorer must invent is a key it will
       * invent badly.
       */
      'Return ONLY this JSON, no prose, no fences:',
      (state.isRefreshMode
        ? '{"scores":{"D1":0,"D2":0,"D3":0,"D4":0,"D5":0,"D6":0,"D7":0},' +
          '"coverage":{"D1":0,"D2":0,"D3":0,"D4":0,"D5":0,"D6":0,"D7":0},' +
          '"finding":{"dimension":"D3","text":""},"questionsAsked":0}'
        : '{"scores":{"D1":0,"D2":0,"D3":0,"D4":0,"D5":0,"D6":0,"D7":0},' +
          '"finding":{"dimension":"D3","text":""},"questionsAsked":0}'),
      (state.isRefreshMode
        ? '"coverage" is how fully THIS conversation re-examined each dimension, 0 to 1: ' +
          '0 if it never came up, 0.5 if it was touched, 1 if it was gone through properly. ' +
          'It decides how much of the earlier round\'s score is kept, so guessing high erases ' +
          'evidence the firm already has.'
        : null),
      'Omit "finding" entirely if nothing significant emerged since the last scoring pass.',
      '',
      '--- TRANSCRIPT ---',
      transcript,
      '--- END TRANSCRIPT ---'
    /*
     * null drops a conditional line; '' is a deliberate blank line and stays.
     * The first version filtered '' too and silently collapsed every paragraph
     * break in the prompt.
     */
    ].filter(function (l) { return l !== null; }).join('\n');
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
    /* Fired at most once per sitting — see the scoring-dead block in _score. */
    this._scoringDeadFired = false;
    /* When the current unbroken run of failures began; null while healthy. */
    this._failingSince = null;
    /** Renewals used so far — see MAX_RENEWALS. */
    this.renewals = 0;
  }

  /** Transcripts stream in fragments; join them into whole turns. */
  /*
   * ── v5.34.121: the product now notices when the interviewer says goodbye. ──
   *
   * Reported from the 2026-09-18 resumed interview. Jack said "We've covered a
   * lot of ground today... Thank you so much for your time, Avery." and NOTHING
   * happened: the clock kept running, the interviewee was not moved on, the
   * microphone stayed hot and the session stayed live. Then the ~10-minute
   * goAway arrived, the handover fired, and its recovery nudge was appended to
   * the closing line —
   *
   *   "...Thank you so much for your time, Avery.I'm sorry, I missed that last
   *    part, could you tell me one more time?"
   *
   * — which is the interviewer asking a person who has already been thanked and
   * dismissed to repeat themselves. The same cause explains "it started
   * speaking to me after some time the screen was open".
   *
   * Grepping the page for every spelling of this — onClosed, closingDetected,
   * interviewClosed, farewell, goodbye — returns nothing. The detection was
   * never built. The HARNESS has had one since v5.34.77 and has twice been
   * corrected by real transcripts; the product it tests never got it.
   *
   * ── The regex is DUPLICATED from deploy/voice-record.mjs, deliberately ─────
   *
   * Same call as GOAWAY_HANDOVER_COST_MS: the rig is a node script and this is
   * a browser file, and a shared module for one regex is not worth a build step
   * here. A constant copied into two files is this project's most reliable
   * source of defects, so parity is asserted by
   * theInterviewerCanFinish.test.ts rather than left to discipline.
   *
   * Both of the rig's hard-won lessons come with it:
   *
   *   · "thanks for taking the time" is ALSO a greeting. A 2026-09-14 run ended
   *     at eleven seconds on the opening line. Tightening the pattern is the
   *     wrong fix — every closing wording appears in pleasantries — so the
   *     guard is STRUCTURAL: three completed exchanges before any closing
   *     language is believed. The shortest genuine close observed ran nine.
   *
   *   · "Thanks AGAIN for your time" defeated a contiguous pattern, so the
   *     phrase allows up to 40 intervening characters.
   */
  var CLOSING_RE = new RegExp([
    '(thanks|thank you)[^.?!]{0,40}\\b(your time|taking the time)\\b',
    'that concludes|concludes our interview',
    'covered everything (i|we)(\'ve| have)? ?(came|come) for',
    'appreciate[^.?!]{0,25}\\b(your time|taking the time)\\b',
  ].join('|'));
  var MIN_TURNS_BEFORE_CLOSE = Number(window.VYNE_MIN_TURNS_BEFORE_CLOSE) || 3;

  /**
   * Fires opts.onInterviewClosed(text) at most once per interview.
   *
   * Counts the interviewee's completed turns rather than all turns: the
   * interviewer's own greeting and its follow-up are one-sided, and it is
   * answered exchanges that distinguish a conversation from an opening.
   */
  LiveInterview.prototype._checkInterviewerClosed = function () {
    if (this._closedByAgent || this.stopped) return;
    var last = this.turns[this.turns.length - 1];
    if (!last || last.who !== 'VYNE' || !last.text) return;
    var text = String(last.text);
    if (!CLOSING_RE.test(text.toLowerCase())) return;
    var answered = 0;
    for (var i = 0; i < this.turns.length; i++) if (this.turns[i].who === 'You') answered++;
    if (answered < MIN_TURNS_BEFORE_CLOSE) {
      if (!this._closeIgnored) {
        this._closeIgnored = true;
        vlog('LiveInterview: closing language after only ' + answered + ' answered turn(s) — ' +
             'an interview cannot close before it starts, so this is a greeting', { text: text.slice(0, 120) });
      }
      return;
    }
    this._closedByAgent = true;
    vlog('LiveInterview: the interviewer has closed the interview', { answeredTurns: answered, text: text.slice(0, 160) });
    if (this.opts.onInterviewClosed) { try { this.opts.onInterviewClosed(text); } catch (e) {} }
  };

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
    /* v5.34.86: the panel shows this, so a pass in flight reads as activity
     * rather than as a frozen meter between updates. */
    if (this.opts.onScoringState) { try { this.opts.onScoringState(true); } catch (e) {} }

    fetch('/api/llm/generate', {
      method: 'POST',
      headers: window.vyneAuthHeaders ? window.vyneAuthHeaders() : { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'interview_score',
        module: 'interview_agent',
        clientName: self.opts.clientName || undefined,
        /*
         * ── v5.34.102: 900 was a budget for the ANSWER, and the model spends
         *    it on THINKING ───────────────────────────────────────────────────
         *
         * Measured against production on 2026-09-14, same prompt, twice:
         *
         *   maxTokens 900  -> tokensOut  35, finishReason "length", 60 chars,
         *                     cut at {"scores":{"D1":2,"D2":0,"D3":
         *   maxTokens 4000 -> tokensOut 159, finishReason "stop",  parses,
         *                     D1=2 D6=1 — the right answer for the transcript
         *
         * Thirty-five visible tokens out of a 900 budget, and still "length":
         * gemini-3.6-flash is a thinking model and maxOutputTokens covers the
         * reasoning as well as the reply, so roughly 865 tokens went on
         * thinking and the JSON was guillotined mid-value. vyneParseJson is
         * right to refuse it — a flat object cut before any complete pair has
         * nothing to salvage — so EVERY pass failed, and three consecutive
         * failures is what declares scoring dead and stops the interview.
         *
         * Found by calling /api/llm/generate directly from a signed-in browser
         * against production — NOT from the voice harness. The harness's own
         * "scoring passes: 0 succeeded, 3 failed" on 2026-09-14 was a rig
         * fault: before v5.34.100 it answered that endpoint with a 404, and
         * the page dutifully counted three failures. Two separate problems
         * that looked identical in the output. The truncation below is the
         * real one; it is reproducible on demand and has nothing to do with
         * the harness.
         *
         * 4000 is a CEILING, not a spend: only tokens actually produced are
         * billed, and the measured answer is ~160. The headroom is for the
         * thinking, which grows with the transcript.
         *
         * v5.34.103 — this number is back to an ANSWER budget, which is what
         * every call site in the product means by maxTokens. The thinking room
         * is now added once, in buildGeminiBody, because the mismatch was
         * between what the caller means and what Gemini's maxOutputTokens
         * means, and the translation layer is the only place that sees both.
         * 1200 is the measured answer (~160 tokens) with room for a long
         * finding; the reserve covers the rest.
         */
        maxTokens: 1200,
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
        self._failingSince = null;   // a success breaks the run, count and clock
        self.scoreSuccesses++;
        /*
         * v5.34.85 — a THROW in here used to vanish.
         *
         * This was `try { onScore(parsed); } catch(e) {}`. The page's handler
         * applies the scores and re-renders the scorecard; if either threw, the
         * pass was lost, the autosave alongside it was skipped, and
         * scoreFailures stayed 0 — so nothing counted it, no badge lit, and
         * everScored() still reported success. A scoring outage that looked
         * like a clean interview is exactly the outcome this whole mechanism
         * exists to prevent.
         *
         * Failing to APPLY a score is failing to score. It counts.
         */
        if (self.opts.onScore) {
          try { self.opts.onScore(parsed); }
          catch (e) { throw Object.assign(new Error('score_apply_failed'), { code: 'score_apply_failed', cause: e }); }
        }
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
        /*
         * ── v5.34.85: A DEAD SCORER ENDS THE INTERVIEW ──────────────────────
         *
         * The interview exists to produce evidence. An hour of an executive's
         * time that scores nothing is not a partial success, it is a waste of
         * the one thing the firm cannot get back — so when scoring is
         * demonstrably broken the honest thing is to stop, say so, and pick it
         * up later, rather than keep talking and hand back a transcript nobody
         * can turn into an assessment.
         *
         * Two triggers, both meaning "this is not a blip":
         *   · STOP_AFTER_CONSECUTIVE failures in a row after it had been
         *     working — the provider went down mid-interview;
         *   · it has NEVER scored once by STOP_IF_NEVER_SCORED_BY attempts —
         *     misconfiguration, a bad key, a budget refusal. Higher, because
         *     the opening exchanges are genuinely thin and a model that
         *     correctly reports "no evidence yet" must not look like an outage.
         *
         * The transcript is saved and the interview is resumable: this ends a
         * SITTING, never the interview. onScoringDead lets the page close it
         * gracefully through the interviewer rather than cutting the audio,
         * because the interviewee deserves an explanation in a human voice.
         */
        /*
         * Count AND duration. _failingSince is the first failure of the current
         * unbroken run and is cleared by any success, so a single recovered
         * blip can never accumulate toward a stop across an hour.
         */
        if (!self._failingSince) self._failingSince = Date.now();
        var failingMs = Date.now() - self._failingSince;
        var dead = (self.scoreSuccesses > 0 &&
                    self.scoreFailures >= STOP_AFTER_CONSECUTIVE && failingMs >= STOP_AFTER_MS) ||
                   (self.scoreSuccesses === 0 &&
                    self.scoreFailures >= STOP_IF_NEVER_SCORED_BY && failingMs >= STOP_IF_NEVER_SCORED_AFTER_MS);
        if (dead && !self._scoringDeadFired) {
          self._scoringDeadFired = true;
          vlog('LiveInterview: scoring is dead — ending the sitting', {
            failures: self.scoreFailures, everSucceeded: self.scoreSuccesses > 0,
            code: (e && e.code) || 'scoring_failed',
          });
          if (self.opts.onScoringDead) {
            try {
              self.opts.onScoringDead({
                code: (e && e.code) || 'scoring_failed',
                consecutive: self.scoreFailures,
                everSucceeded: self.scoreSuccesses > 0,
              });
            } catch (x) {}
          }
        }
      })
      .then(function () {
        self.scoring = false;
        if (self.opts.onScoringState) { try { self.opts.onScoringState(false); } catch (e) {} }
      });
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

  /**
   * How long before the planned end to tell the interviewer time is short.
   * (v5.34.75)
   *
   * interviewerPersona.ts carries the rule — "If you are told that time is
   * running short and you still have ground to cover, say so plainly before
   * the end: tell them roughly what is left ... they can pick it up another
   * time." That rule shipped in v5.34.73 with nothing to trigger it, which
   * made it inert: a session simply hit its ceiling and stopped, with
   * questions outstanding and nothing said about it.
   *
   * This is the trigger. It fires ONCE, and only when the caller says how long
   * the interview was planned for — see plannedMinutes below.
   */
  var WRAPUP_LEAD_MS = Number(window.VYNE_WRAPUP_LEAD_MS) || 4 * 60 * 1000;
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
           /*
            * v5.34.112 — the page was suspended, so the socket is stale.
            *
            * Raised by vyne-live.js's wall-clock heartbeat the moment this page
            * starts running again. It is the SAME condition v5.34.44 describes
            * below ("the laptop slept at minute five, and on waking the socket
            * was long dead"), caught at the wake instead of whenever the dead
            * socket gets round to admitting it — which is where the 20.3-second
            * hole on the 2026-09-15 run came from.
            */
           r === 'live_suspended' ||
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
      /* v5.34.79: may be a function — resolved at mint time by vyne-live.js so
       * each handover sees the interview as it stands. Passed straight through;
       * resolving it here would re-freeze it one layer down. */
      context: this.opts.context || undefined,
      /*
       * ── v5.34.84: THESE THREE WERE NEVER FORWARDED ──────────────────────
       *
       * vyne-live.js has read self.opts.agenda and self.opts.mandatoryCount at
       * mint time since v5.34.73, and interview_agent.html has passed both into
       * vyneLiveInterview.create() since v5.34.73 — but this function, the one
       * that builds what actually goes to vyneLive.start(), listed neither. So
       * the values were resolved from an object that never carried them, and
       * every mint sent agenda: undefined, mandatoryCount: undefined.
       *
       * What that silently disabled, in every live interview ever run:
       *   · the seven-dimension agenda and the per-role weighting (v5.34.73);
       *   · the whole mandatory-question block, which buildInterviewerInstruction
       *     emits only `if (mandatoryCount > 0)` — so "ask it on its own turn,
       *     never announce it" never reached the model either;
       *   · the evidenced-dimensions "do not ask about those again" rule;
       *   · the v5.34.79 no-repeat rule, gated on askedCount > 0.
       *
       * Every one of those has passing unit tests, because the tests call
       * buildInterviewerInstruction directly. The voice harness also passed,
       * because it renders its own instruction and supplies these three itself
       * — so it proved the BUILDER works and never that the PAGE delivers. That
       * is the harness's own documented trap ("measuring something else and
       * labelling it the product") landing one layer further out than the layer
       * it was written to catch.
       *
       * Passed through unresolved: vyne-live.js resolves a function at mint, so
       * each handover sees the interview as it stands. Resolving here would
       * re-freeze them, which is the v5.34.79 context bug one level down.
       */
      agenda: this.opts.agenda || undefined,
      mandatoryCount: this.opts.mandatoryCount !== undefined ? this.opts.mandatoryCount : undefined,
      askedCount: this.opts.askedCount !== undefined ? this.opts.askedCount : undefined,
      /*
       * v5.34.111 — the interview's booked size, and the clock.
       *
       * Same forwarding rule as the three above, and personaInputsReachTheWire
       * .test.ts now reads the field list off InterviewerContext itself, so a
       * field added to the persona fails this layer the day it appears. That
       * test is what caught these three the moment they were declared.
       */
      questionTargetLow: this.opts.questionTargetLow !== undefined ? this.opts.questionTargetLow : undefined,
      questionTargetHigh: this.opts.questionTargetHigh !== undefined ? this.opts.questionTargetHigh : undefined,
      /*
       * The clock comes from HERE, not from the page, because this object
       * already owns it: _startedAt is when the INTERVIEW began rather than
       * when this connection did, so elapsedMinutes() is continuous across
       * handovers. A function, so vyne-live.js resolves it at each mint — a
       * frozen value would tell a session opening at minute twenty-five that
       * it was minute zero, which is precisely the state the v5.34.79 context
       * bug put the model in.
       *
       * Note this is NOT plannedMinutes. That one is still dormant (see
       * _armWrapUp): the product records no booked DURATION anywhere. It does
       * record a booked SIZE — the consultant's depth choice — which is what
       * questionTargetLow/High above carry.
       */
      elapsedMin: function () { try { return self.elapsedMinutes(); } catch (e) { return undefined; } },
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
        /*
         * ── v5.34.118: a goAway ON TOP of an unanswered turn is the answer. ──
         *
         * Two live traces, on two different builds, show the same ten
         * milliseconds:
         *
         *   v5.34.116   +549693  USER TURN #9 transcribed
         *               +549704  goAway            (11ms later)
         *               ...      no model frame for 20 seconds
         *
         *   v5.34.117   +788650  USER TURN #13 transcribed
         *               +788660  goAway            (10ms later)
         *               ...      no model frame at all; we handed over
         *
         * In both, the interviewee's answer was transcribed — so the socket was
         * healthy and the server was listening — and in both, a goAway landed a
         * hair later and the turn was never answered. The server accepts the
         * audio, transcribes it, and declines to generate, because it is
         * draining the connection.
         *
         * v5.34.117 waits GOAWAY_STALL_MS (5s) to be SURE the model is not
         * merely slow. That five seconds is the dominant term in the 7.3-second
         * silence measured at minute nine of the 2026-09-16 interview: the
         * handover machinery itself costs 1.6s. It is a margin against a
         * possibility the server has already ruled out for us.
         *
         * So when a goAway arrives while a transcribed turn is outstanding, the
         * wait drops to GOAWAY_STALL_CONFIRMED_MS. Not zero — see that
         * constant — but near enough that the pause reads as a pause.
         *
         * Recorded against the TURN, not as a bare flag: a goAway that arrived
         * before this turn began says nothing about whether this turn will be
         * answered, and a flag would carry that stale claim forward.
         */
        var s = self.session;
        if (s && s._awaitingReply && s._userTurnStartedAt) {
          self._goAwayDuringTurn = s._userTurnStartedAt;
          vlog('LiveInterview: that goAway landed on a turn this connection has not answered', {
            unansweredMs: Date.now() - s._userTurnStartedAt });
        }
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
        /* v5.34.121 — after _flushPending, so the closing line is in turns[],
         * and before _score, so the page can stop the room while the scoring
         * of that last exchange is still allowed to finish. */
        self._checkInterviewerClosed();
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
      /* v5.34.94 — onNote was the onAgentText bug, still live in the product.
       *
       * vyne-live.js has emitted onNote('trying …') / onNote('connected via …')
       * during transport negotiation, and interview_agent.html has registered a
       * handler for it since it was written — but this allowlist never listed
       * it, so the page's handler could not fire. The comment beside that
       * handler says it exists "so the setup window never reads as a frozen or
       * silent screen", and that progress messaging has never once rendered.
       *
       * Identical shape to onAgentText (v5.34.77): the name is a real
       * vyne-live.js callback, so grepping for it in THAT file looks correct,
       * and only the middle layer is missing. harnessHooksReal.test.ts catches
       * this class for the voice harness but reads deploy/voice-record.mjs and
       * never interview_agent.html, so the product page was unguarded —
       * now covered by liveHookForwarding.test.ts. */
      onNote: function (msg) { if (self.opts.onNote) { try { self.opts.onNote(msg); } catch (e) {} } },
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
            /*
             * v5.34.73 — scoped to THIS turn, because it was not.
             *
             * The previous wording said "In one short sentence say you are
             * still here, then ... repeat your last question if I had not
             * answered it yet." Both halves were meant for the renewal turn
             * alone. Both became standing behaviour.
             *
             * Measured on the 30-minute recording of 2026-09-13
             * (voice-runs/, and agent-turns.txt reconstructed from the page
             * trace): three renewals produced FIFTY turns opening "I am still
             * here", and one question asked forty times verbatim. From the
             * interviewee's side that is an interviewer who keeps announcing it
             * has not hung up, and cannot remember what it just asked.
             *
             * The repetition had help — the harness reads scripted answers that
             * never answer the question, so "if I had not answered it yet" was
             * always true. A real interviewee usually answers. But a nudge that
             * relies on the other party behaving well to avoid a forty-fold
             * loop is a nudge with no floor under it.
             *
             * So: "just for this one turn", stated first; "ask it once more" in
             * place of an open-ended repeat; and an explicit instruction not to
             * carry any of it forward. The v5.34.43 lesson is preserved — this
             * still names ACTIONS rather than saying "please continue", which
             * is what stopped the model echoing the nudge back.
             *
             * Not yet validated by a 90-minute run. The comment above says
             * plainly that this wording should not change without one, and that
             * remains true of this version too — see NEXT_SESSION_SPEC.md.
             */
            /*
             * v5.34.112 — WHEN WE TOOK WORDS OFF THEM, SAY SO.
             *
             * Reported from the 2026-09-15 live interview: at the handover the
             * interviewee spoke for about fifteen seconds, none of it arrived,
             * and the interviewer came back asking for the answer as though
             * nothing had been said — opening with "I am still here".
             *
             * That line is not a model quirk. It is this instruction: "Say in
             * one short sentence that you are still there." We scripted it, for
             * the case where the handover lands in a genuine gap and the
             * interviewee is waiting — where it is the right thing to say.
             *
             * It is the wrong thing to say when we have just cut someone off
             * mid-answer. To them, they spoke for fifteen seconds and the agent
             * announced its own presence and re-asked the question: that reads
             * as not being listened to, which is the one thing this persona is
             * built to avoid. _cutOffInterviewee (set at the teardown) tells
             * the two cases apart, so the interviewer can do what a person
             * would — admit it missed the answer and ask for it again.
             *
             * Deliberately still naming ACTIONS rather than saying "please
             * continue": that is the v5.34.43 lesson, where an open-ended nudge
             * was echoed back verbatim eighteen times in ninety minutes.
             */
            /*
             * v5.34.117 — the stalled-connection branch, first.
             *
             * Named as an ACTION with an explicit prohibition on the two wrong
             * moves, for the v5.34.43 reason: an open-ended "carry on" was
             * echoed back verbatim eighteen times in ninety minutes.
             *
             * "already in the conversation you can see" is load-bearing. The
             * answer reaches the new session through buildLiveContext whether
             * or not Google's resume handle survived, so the model is being
             * pointed at something that is actually in front of it.
             */
            /*
             * ── v5.34.119: the nudge that made it read the transcript out. ───
             *
             * The v5.34.117 wording was:
             *
             *   "they have already given you a full answer to your last
             *    question and IT IS THERE IN THE CONVERSATION YOU CAN SEE, but
             *    a connection problem meant you did not respond to it. RESPOND
             *    TO THAT ANSWER NOW, DIRECTLY, as though you had just heard it."
             *
             * Reported from the 2026-09-17 live interview, at the 9-minute
             * handover — the first thing the fresh session said:
             *
             *   Avery:  "...there is a committee that sits and discusses this
             *           for initiatives that especially touch customers and
             *           employees. We we definitely take a serious look at
             *           that. I forget what the second part of your question
             *           was."
             *   Jack:  "Yeah, when it comes to the responsible A I, there is a
             *           committee that sits and discusses this for initiatives
             *           that especially touch customers and employees. We we
             *           definitely take a serious look at that. I forget what
             *           the second part of your question was. When you're
             *           linking all those systems, does your technology stack
             *           make that easy...?"
             *
             * Word for word, including "I forget what the second part of your
             * question was" — his sentence, read back to him — and then the
             * missing half of its own question appended.
             *
             * That is not the mirroring habit the persona now forbids. It is
             * this instruction, obeyed: I pointed the model at a transcript and
             * told it to respond to what was in it, and it read the entry out.
             * The give-away is the trailing-off clause: mirroring paraphrases,
             * reading recites, and no one paraphrases "I forget what the second
             * part of your question was".
             *
             * So the nudge must name the action WITHOUT naming the transcript.
             * The answer is already in context and needs no pointing at; what
             * was missing was what to DO, and "respond to that answer" turned
             * out to have a worse reading than the one intended.
             *
             * v5.34.117's actual requirement survives intact: do not make them
             * repeat a long answer we hold in full. "Take it as heard and carry
             * on" achieves that without inviting a recitation.
             */
            self.open(self._replyStalled
              ? 'Just for this one turn: a connection problem meant you never responded to the last thing '
                + 'they said. Take it as heard and carry straight on — ask your next question, or a '
                + 'follow-up on what they said if there is one worth asking. Do not read their answer back '
                + 'to them, do not summarise it, do not repeat any of their words, do not apologise, do not '
                + 'ask them to repeat anything, do not say you missed it, do not greet them again, do not '
                + 'say you are still there, and do not mention the connection — now or in any later turn.'
              : self._cutOffInterviewee
              ? 'Just for this one turn: the connection dropped for a couple of seconds while they were '
                + 'speaking, so you did not hear the last thing they said. Apologise briefly in one short '
                + 'sentence, say you missed that last part, and ask them to say it again. Do not greet them '
                + 'again, do not say you are still there, and do not explain the connection. From your next '
                + 'turn onwards carry on as normal and never mention this again.'
              : resumed
              ? 'Just for this one turn: our connection was briefly renewed and you still have the whole '
                + 'conversation. Say in one short sentence that you are still there, then either wait for the '
                + 'rest of my answer or, if I had not started answering, ask your last question once more. '
                + 'Do not greet me again. From your next turn onwards carry on as normal — do not mention the '
                + 'connection again, and do not open any later turn by saying you are still there.'
              : 'Just for this one turn: the connection was renewed mid-interview. Continue exactly where you '
                + 'left off with your next question — do not greet them again and do not mention the '
                + 'interruption, now or later.');
            self._cutOffInterviewee = false;
            self._replyStalled = false;
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
      /* v5.34.118: and the turn that goAway landed on belonged to that socket
       * too. Left set, it would compare against a fresh session's turn clock
       * and could shorten the wait on a turn no goAway has touched. */
      self._goAwayDuringTurn = null;
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
    this._armWrapUp();
    return this._openSession();
  };

  /**
   * Tell the interviewer, once, that time is running short. (v5.34.75)
   *
   * ── Why this needs a planned length, and why the product has none yet ─────
   *
   * There is no ceiling to count down from otherwise. MAX_INTERVIEW_MS is a
   * three-hour runaway guard, and the grant's maxSeconds is one ~10-minute
   * connection inside a much longer interview — counting down from either
   * would fire the wrap-up at the wrong moment, repeatedly.
   *
   * So this arms only when the CALLER supplies plannedMinutes. The voice
   * harness passes its --minutes, which is why it is exercised. The product
   * does not yet record how long an interview was booked for anywhere:
   * interview_agent.html has no duration field, the invite carries none, and
   * the engagement record has none. Wiring a number that does not exist would
   * be worse than leaving the rule dormant, so when plannedMinutes is absent
   * nothing fires and the interview behaves exactly as before.
   *
   * To turn it on in the product, give the consultant a planned length on the
   * interview invite and pass it through vyneLiveInterview.create({
   * plannedMinutes }). The rule on the far end is already written and tested.
   */
  LiveInterview.prototype._armWrapUp = function () {
    var self = this;
    var planned = Number(this.opts && this.opts.plannedMinutes) || 0;
    if (!planned || this._wrapUpTimer || this._wrapUpSent) return;
    var lead = Math.min(WRAPUP_LEAD_MS, planned * 60000 * 0.5);
    var fireIn = planned * 60000 - lead - (Date.now() - this._startedAt);
    if (fireIn <= 0) return;
    vlog('LiveInterview: wrap-up notice armed',
         { plannedMinutes: planned, firesInSec: Math.round(fireIn / 1000) });
    this._wrapUpTimer = setTimeout(function () {
      self._wrapUpTimer = null;
      self._sendWrapUp();
    }, fireIn);
  };

  /** Deliver the notice, waiting for a gap rather than talking over them. */
  LiveInterview.prototype._sendWrapUp = function (_retry) {
    var self = this;
    if (this._wrapUpSent || this.stopped) return;
    /*
     * One chain only. The waiting path below re-enters this function on a
     * timer, and _wrapUpSent is not set until the notice actually goes out —
     * so without this a second caller (a retry, a second timer, a test) starts
     * a SECOND chain, and both send. Caught by "sends it once, not once per
     * handover", which saw two notices.
     */
    if (this._wrapUpSending && !_retry) return;
    this._wrapUpSending = true;
    /*
     * Never mid-turn. Cutting across the interviewee to announce the time is
     * the rudest possible way to deliver this, and cutting across the
     * interviewer produces a half-asked question. Wait for a gap, but not
     * forever — after a minute of neither party pausing, say it anyway.
     */
    var st = this.session && this.session._turnState;
    var waited = this._wrapUpWaitedMs || 0;
    if ((st === 'speaking' || st === 'thinking') && waited < 60000) {
      this._wrapUpWaitedMs = waited + 2000;
      setTimeout(function () { self._sendWrapUp(true); }, 2000);
      return;
    }
    this._wrapUpSent = true;
    vlog('LiveInterview: sending the wrap-up notice', { afterWaitMs: waited });
    this.open(
      'Just for this one turn: we are near the end of the time set aside for this conversation. ' +
      'If you still have ground you need to cover, say so now in one or two sentences — roughly ' +
      'what is left and that it would take a few more minutes — and offer to pick it up another ' +
      'time if that suits them better. If you already have what you need, close the interview ' +
      'properly instead. Do not mention the time again after this turn.');
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
  /*
   * ── How long a gap is a real gap? (v5.34.112) ───────────────────────────────
   *
   * Reported from a 12-minute live interview on v5.34.111: at about minute
   * nine the interviewee spoke for roughly fifteen seconds, the interviewer did
   * not hear any of it, and came back asking for the answer as though nothing
   * had been said.
   *
   * Minute nine is the handover. The guard below already defers a handover
   * while the interviewee is speaking — and then settles for the first 1500ms
   * of quiet it sees. Fifteen hundred milliseconds is well inside how long a
   * senior executive pauses in the middle of composing an answer. So the pause
   * for thought reads as the end of the turn, the handover starts, and
   * everything said during the teardown and reconnect goes into a socket that
   * is being thrown away.
   *
   * The two numbers that produced this were set independently and never
   * related to each other: Google's goAway gives FIFTY SECONDS of notice
   * (measured, "timeLeft":"50s"), and we were spending 1.5 of them. There is
   * room to wait for a gap that actually means something.
   *
   * So the requirement starts high and relaxes as the deadline approaches —
   * hold out for a real turn boundary while there is time, accept a short
   * pause when there is not, and go anyway rather than let the server cut us,
   * because a server-cut handover is worse than an awkward one.
   */
  /*
   * What a graceful handover costs in socket time.
   *
   * DUPLICATED from vyne-live.js, which declares it inside its own IIFE and so
   * cannot be read from here. Duplicated deliberately rather than exported: a
   * global would be reachable from the interviewee's page, and this number is
   * only ever compared against a deadline the server set. goAwayHandoverCost
   * parity is asserted by handoverWaitsForAGap.test.ts, because a constant
   * copied into two files is this project's most reliable source of defects.
   */
  var GOAWAY_HANDOVER_COST_MS = 1500;
  var GOAWAY_QUIET_IDEAL_MS = Number(window.VYNE_GOAWAY_QUIET_IDEAL_MS) || 4000;
  var GOAWAY_QUIET_MIN_MS = Number(window.VYNE_GOAWAY_QUIET_MIN_MS) || 1500;
  /* Below this much headroom, stop being fussy about the gap. */
  var GOAWAY_RELAX_BELOW_MS = 12000;
  /* Loud within this long before the teardown means we cut them off. */
  var CUTOFF_WINDOW_MS = 2500;
  /*
   * ── v5.34.117: a dying connection that stops answering. ─────────────────────
   *
   * Reported from a live interview on v5.34.116, and read off the trace the
   * 🩺 button produced:
   *
   *   +547254  goAway (server will close this connection)
   *   +547255  handover deferred — they are mid-answer; waiting for the next
   *            turn boundary
   *   +549160  mic: utterance ends (~38.7s of speech)
   *   +549693  USER TURN #9 — model transcribed the interviewee
   *   +561694  !!! NO MODEL ACTIVITY 12s after the interviewee was transcribed
   *   +569820  model ACTIVITY on user turn #9 (20127ms after transcript began)
   *   +571855  renewing ahead of goAway at a turn boundary
   *   +574003  *** FIRST AUDIO FRAME — the agent is speaking ***
   *
   * Twenty-five seconds of total silence, and the interviewee had to ask
   * whether anyone was there. Every other reply in that session started inside
   * 650ms; the connection had already announced its own death and then simply
   * stopped generating. It kept transcribing — so the answer was never lost —
   * but it produced no model frame for twenty seconds.
   *
   * Two rules, both correct, met here for the first time:
   *
   *   "never hand over while the model is thinking or speaking"
   *        — protects a reply that is in flight.
   *   "mid-answer with time in hand: WAIT for the turn boundary" (v5.34.115)
   *        — protects the interviewee's answer, and was working exactly as
   *          designed; the deferral at +547255 is the right call.
   *
   * Their conjunction is an unbounded wait on a socket that is not coming
   * back. Nothing in either rule notices that the thing being waited for has
   * stopped happening. Worse, the thinking gate sat ABOVE the mustGoNow
   * branch, so even the server's own 50-second deadline could not break it:
   * had the interviewee stayed quiet, this would have run to the server cut at
   * ~47s rather than 25.
   *
   * The signal needed already existed and was only ever written to the log:
   * vyne-live.js arms a watchdog on every transcribed user turn and fires
   * `NO MODEL ACTIVITY 12s` when nothing answers it. That is this defect,
   * detected, twelve seconds in, and thrown away.
   *
   * So: when a goAway is pending and a transcribed turn has gone unanswered
   * for GOAWAY_STALL_MS, treat the connection as finished and hand over.
   *
   * This is the CHEAPEST moment in the whole turn to do it, which is what
   * makes the fix safe rather than a trade:
   *   - the interviewee has stopped speaking (that is why we are waiting at
   *     all), so nothing of theirs is lost to the teardown;
   *   - their answer is already transcribed and travels to the new session
   *     through buildLiveContext, so nothing has to be repeated.
   * Both of the things a handover normally costs are already paid.
   *
   * Five seconds, against a measured worst-case healthy latency of 650ms and
   * the 12s watchdog that named the problem. Deliberately well below the
   * watchdog: by the time that line prints, the interviewee is already
   * wondering if the line is dead.
   */
  var GOAWAY_STALL_MS = Number(window.VYNE_GOAWAY_STALL_MS) || 5000;
  /*
   * ── v5.34.118: the same stall, once the server has confirmed it. ───────────
   *
   * See onGoAway for the evidence. When a goAway lands on a turn that is
   * already transcribed and unanswered, the server has told us twice, and
   * waiting the full five seconds only adds five seconds of silence to a
   * conclusion already reached.
   *
   * One second rather than zero, for one reason: `_awaitingReply` clears on the
   * FIRST model frame of any kind, so this window only ever covers "heard it,
   * produced literally nothing". A reply that has begun is never at risk. The
   * second is there for a reply that is about to begin — measured healthy
   * latency on the 2026-09-16 interview was 5, 8, 8, 14, 16, 19 and 599ms, so
   * one second clears the worst of them by 400ms and the typical one by
   * fiftyfold. Below about 700ms this would start racing real replies; there is
   * no case for shaving it further.
   *
   * Expected effect at minute nine: 7.3s of silence becomes about 3.3s, of
   * which 1.6s is the mint-and-reconnect that no threshold can remove.
   */
  var GOAWAY_STALL_CONFIRMED_MS = Number(window.VYNE_GOAWAY_STALL_CONFIRMED_MS) || 1000;

  /*
   * Re-check every 300ms for as long as the handover is deferred.
   *
   * Armed on EVERY deferral path, including the model-is-thinking gate. That
   * gate used to return without arming anything and relied on onTurnState
   * delivering 'idle' later — which is precisely what a stalled connection
   * never does, so the stall escape below would have had nothing to call it.
   */
  LiveInterview.prototype._armGoAwayPoll = function () {
    var self = this;
    if (this._goAwayPoll) return;
    this._goAwayPoll = setInterval(function () {
      if (!self._goAwayPending || self.stopped) { clearInterval(self._goAwayPoll); self._goAwayPoll = null; return; }
      self._maybeRenewOnGoAway();
    }, 300);
  };

  LiveInterview.prototype._maybeRenewOnGoAway = function () {
    if (!this._goAwayPending || this.stopped || this._muted) return;
    if (!this.session || this.session.closed) return;
    var s = this.session;
    var quietMs = s._micLastLoudAt ? Date.now() - s._micLastLoudAt : Infinity;
    /*
     * Headroom to the server's own cut, less what a graceful handover costs.
     * No deadline recorded (an older server, or a renewal not driven by
     * goAway) means no budget to spend, so keep the original behaviour.
     */
    var headroomMs = s._goAwayDeadlineAt
      ? s._goAwayDeadlineAt - Date.now() - GOAWAY_HANDOVER_COST_MS
      : 0;
    var wantQuietMs = headroomMs > GOAWAY_RELAX_BELOW_MS
      ? GOAWAY_QUIET_IDEAL_MS : GOAWAY_QUIET_MIN_MS;
    /*
     * The deadline overrides everything, INCLUDING an interviewee who is
     * audibly mid-sentence. Expressed as its own flag rather than by zeroing
     * the threshold: the first cut of this set wantQuietMs = 0 and left the
     * `_micInUtterance` clause below intact, so a deadline reached while
     * someone was speaking still deferred and the server cut us anyway — which
     * is the outcome this whole branch exists to prevent. Caught by
     * handoverWaitsForAGap.test.ts before it shipped.
     */
    /*
     * ── v5.34.115: hand over at a TURN BOUNDARY, not at a quiet patch. ──────
     *
     * v5.34.112 raised the required silence from 1500ms to 4000ms and used the
     * fifty seconds of notice Google gives. Reported from a real 20-minute
     * interview on that build, at minute nine:
     *
     *     Jack:  "...could you point to a recent example of a project that's
     *             had a real impact on costs or speed?"
     *     Avery:  "of use cases and therefore we are reducing our cost
     *             significantly and improving our opportunity overall."
     *     Jack:  "Apologies, I missed that last part. Could you say it again?"
     *
     * The answer in the transcript BEGINS mid-sentence: the front of it was
     * spoken into the connection being torn down. A deliberate speaker giving
     * a long answer paused for more than four seconds in the middle of it, and
     * four seconds of silence was again read as the end of a turn.
     *
     * Raising the threshold again does not fix this, and that is the point: no
     * measure of silence DURATION can separate "finished answering" from
     * "thinking mid-answer", because for a senior executive they are the same
     * sound. The threshold only decides which of the two mistakes to make.
     *
     * So stop inferring it. There is one moment per turn that is unambiguously
     * safe — the interviewer has just finished asking, and the interviewee has
     * not started answering. vyne-live.js now marks exactly that
     * (`_spokeSinceTurnEnd`, cleared when the model's turn closes, set the
     * instant the microphone hears speech). Take that window when it comes,
     * and fall back to the silence rule only once the deadline is near enough
     * that waiting for the next question costs more than an awkward cut.
     *
     * Fifty seconds of notice is two or three turns at this pace, so the
     * fallback should be rare.
     */
    var atTurnBoundary = s._spokeSinceTurnEnd === false;
    var mustGoNow = !!s._goAwayDeadlineAt && headroomMs <= 0;
    /*
     * v5.34.117 — has the connection stopped answering? See GOAWAY_STALL_MS.
     *
     * `_awaitingReply` is set by vyne-live.js the moment a user turn is
     * transcribed and cleared by the first model frame of any kind, so this
     * measures exactly "it heard a turn and has produced nothing since".
     *
     * `!_micInUtterance` because they may have started speaking again — asking
     * whether anyone is there, which is what happened on the reported run.
     * Tearing the socket down mid-word is the one thing this whole branch
     * exists to avoid, so wait for that sentence to end first.
     */
    var stalledMs = (s._awaitingReply && s._userTurnStartedAt)
      ? Date.now() - s._userTurnStartedAt : 0;
    /*
     * v5.34.118 — did a goAway land on THIS turn? Compared by the turn's own
     * start time rather than a boolean, so a goAway from before this turn (or
     * from the previous connection) cannot shorten the wait on it.
     */
    var confirmedByGoAway = !!stalledMs && this._goAwayDuringTurn === s._userTurnStartedAt;
    var wantStallMs = confirmedByGoAway ? GOAWAY_STALL_CONFIRMED_MS : GOAWAY_STALL_MS;
    var replyStalled = stalledMs >= wantStallMs && !s._micInUtterance;
    /*
     * The model-is-working gate. Below mustGoNow and the stall check, not
     * above them: sitting above was what made the reported 25-second silence
     * unbounded, and what put the server's own deadline out of reach.
     */
    if (!replyStalled && !mustGoNow &&
        (this._turnState === 'speaking' || this._turnState === 'thinking')) {
      this._armGoAwayPoll();
      return;
    }
    if (mustGoNow && (s._micInUtterance || quietMs < GOAWAY_QUIET_MIN_MS)) {
      vlog('LiveInterview: handing over ON the goAway deadline even though the interviewee is mid-sentence — a server cut is worse', {
        quietMs: quietMs === Infinity ? null : quietMs, headroomMs: headroomMs });
    }
    /*
     * Three states, in order of certainty:
     *
     *   at a turn boundary        — they have not begun answering. Go now,
     *                               however short the silence has been.
     *   mid-answer, time in hand  — WAIT, whatever the silence says. This is
     *                               the case a duration threshold gets wrong,
     *                               and the one that cost a real answer.
     *   anything else             — the silence rule, as before: an unknown
     *                               boundary state, or a deadline close enough
     *                               that waiting costs more than cutting.
     */
    var midAnswer = s._spokeSinceTurnEnd === true;
    var waitForBoundary = midAnswer && headroomMs > GOAWAY_RELAX_BELOW_MS;
    if (!mustGoNow && !replyStalled && !atTurnBoundary &&
        (waitForBoundary || s._micInUtterance || quietMs < wantQuietMs)) {
      if (!this._goAwayPoll) {
        vlog('LiveInterview: handover deferred — they are mid-answer; waiting for the next turn boundary',
             { quietMs: quietMs === Infinity ? null : quietMs, wantQuietMs: wantQuietMs,
               spokeSinceTurnEnd: s._spokeSinceTurnEnd !== false,
               headroomSec: Math.round(headroomMs / 1000) });
      }
      this._armGoAwayPoll();
      return;
    }
    if (this._goAwayPoll) { clearInterval(this._goAwayPoll); this._goAwayPoll = null; }
    this._goAwayPending = false;
    /*
     * Logged HERE, not at the point the stall is detected.
     *
     * The first cut printed it the moment `replyStalled` went true, above the
     * deferral branch — so a build that detected the stall and then deferred
     * anyway produced a trace line saying it had handed over, and the rig's
     * verdict reported "noticed after 5.1s" on a run that sat through the full
     * 25-second stall. A log line that claims an action must sit after the
     * action is committed. Caught by running the harness against the v5.34.116
     * code on purpose, which is the only reason it was ever seen.
     */
    if (replyStalled) {
      vlog('LiveInterview: handing over because this connection has stopped answering — ' +
           'it transcribed a turn and produced nothing since', {
        unansweredMs: stalledMs, waitedMs: wantStallMs,
        confirmedByGoAway: confirmedByGoAway, turnState: this._turnState,
        headroomSec: Math.round(headroomMs / 1000) });
    }
    /*
     * v5.34.112 — did we cut them off? The nudge on the far side depends on it.
     *
     * Anything the interviewee says between here and the new session answering
     * is gone: the old socket is being discarded and the new one does not exist
     * yet. If they were audible moments ago, the honest assumption is that we
     * took words off them, and the interviewer should say so rather than open
     * with "I am still here" — which is what made a lost answer read as a
     * broken agent on the 2026-09-15 live interview.
     */
    this._cutOffInterviewee = !atTurnBoundary && (!!s._micInUtterance ||
      (s._micLastLoudAt ? Date.now() - s._micLastLoudAt < CUTOFF_WINDOW_MS : false));
    /*
     * v5.34.117 — the stalled handover is its own case, and it must not be
     * read as either of the other two.
     *
     * `_cutOffInterviewee` would be TRUE here on the reported run (they were
     * audible seconds ago, asking whether anyone was there), and it would
     * produce "I missed that last part, could you say it again" — asking a
     * senior executive to repeat a thirty-nine second answer that we have in
     * full, in the transcript, and that the new session can read. That is a
     * worse version of the v5.34.112 defect, not a fix for it.
     *
     * The `resumed` branch is wrong too: "I'm still here" is what the
     * interviewee got on this run, and it is what made a stalled server read
     * as a broken agent.
     *
     * Nothing was missed and nothing needs repeating. The only thing owed is
     * the answer to what they already said.
     */
    this._replyStalled = replyStalled;
    if (replyStalled) this._cutOffInterviewee = false;
    vlog('LiveInterview: renewing ahead of goAway at a turn boundary', {
      hasResumeHandle: !!this._resumeHandle,
      quietMs: quietMs === Infinity ? null : quietMs,
      replyStalled: replyStalled,
      cutOffInterviewee: this._cutOffInterviewee });
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
    if (this._wrapUpTimer) { clearTimeout(this._wrapUpTimer); this._wrapUpTimer = null; }
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
