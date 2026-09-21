/**
 * A connection that announced its own death and then stopped answering.
 * (v5.34.117)
 *
 * ── Reported from a live interview, with the trace this time ─────────────────
 *
 *   "In minute 9 the system completely went silent for about 30-40 seconds. No
 *    response, nothing. Then I had to ask if Jack was still there. It came back
 *    after that to continue. But that is not a good pause, it felt too long."
 *
 * The 🩺 diagnostics dump, which is why this file exists instead of a third
 * guess:
 *
 *   +547254  frame goAway (server will close this connection)
 *   +547255  handover deferred — they are mid-answer; waiting for the next
 *            turn boundary
 *   +549160  mic: utterance ends (~38.7s of speech)
 *   +549693  USER TURN #9 — model transcribed the interviewee; awaiting reply
 *   +561694  !!! NO MODEL ACTIVITY 12s after the interviewee was transcribed
 *   +563751  mic: SPEECH on uplink        <- "Jack, are you still there?"
 *   +569820  model ACTIVITY on user turn #9 (20127ms after transcript began)
 *   +571648  INTERRUPTED — barge-in
 *   +571855  renewing ahead of goAway at a turn boundary
 *   +574003  *** FIRST AUDIO FRAME — the agent is speaking ***
 *
 * ── What was and was NOT wrong ──────────────────────────────────────────────
 *
 * Both of the mechanisms suspected before the trace arrived are innocent, and
 * both of the fixes they implied would have been wrong:
 *
 *   - the renewal retry ladder (4s + 8s + 16s) never ran. The re-mint
 *     succeeded first time, in 763ms, and the new session was live 1.4s later.
 *   - "shortening the floor hold" never printed. The goAway arithmetic did
 *     exactly what v5.34.112 designed it to do.
 *
 * v5.34.115's turn-boundary deferral was also working correctly: at +547255 it
 * declined to hand over mid-answer, which is right, and is what saved the
 * 38.7-second answer that the previous build would have clipped.
 *
 * The defect is the conjunction of two correct rules with nothing between them:
 *
 *   "never hand over while the model is thinking or speaking"   (protects a
 *        reply in flight — and the model was 'thinking' the entire 20s)
 *   "mid-answer with time in hand: WAIT for the turn boundary"  (protects the
 *        interviewee's answer — and the boundary requires the model to finish
 *        a turn it had stopped working on)
 *
 * Each waits for the other. Neither notices that the socket has already told
 * us it is closing. The interviewee broke the deadlock by speaking, which
 * eventually forced a turn to close; the handover then completed in 2.5s.
 *
 * Two aggravations found while reading it:
 *
 *   - the model-is-thinking gate sat ABOVE the mustGoNow branch, so the
 *     server's own 50-second deadline could not break the deadlock either. Had
 *     the interviewee stayed quiet this would have run to the server cut at
 *     ~47s rather than 25s, losing the resumption handle with it.
 *   - the deferral inside that gate armed no poll at all. It relied on
 *     onTurnState delivering 'idle', which is precisely what a stalled
 *     connection never delivers.
 *
 * And the signal was already there. vyne-live.js arms a watchdog on every
 * transcribed user turn and prints `NO MODEL ACTIVITY 12s` when nothing
 * answers it. That line IS this defect, detected twelve seconds in, and
 * written only to the log. The fix is largely a matter of acting on something
 * the product already knew — which is the third time this project has found a
 * defect its own instrumentation had already named.
 *
 * ── Why handing over here is cheap, not a trade ─────────────────────────────
 *
 * A handover normally costs two things: whatever is said during the ~1.5s with
 * no socket, and the interviewee's sense of being listened to. At this exact
 * moment both are already paid — they have STOPPED speaking (that is why we
 * are waiting), and their answer is transcribed and travels to the fresh
 * session through buildLiveContext. So nothing is lost and nothing needs
 * repeating, which is what the third nudge branch is for.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const LIVE = readFileSync(join(root, "frontend", "vyne-live.js"), "utf8");
const INTERVIEW = readFileSync(join(root, "frontend", "vyne-live-interview.js"), "utf8");

/*
 * The nudges are written as multi-line JS string concatenation, so a regex over
 * the raw source can fail on a phrase that straddles a `' + '` boundary — which
 * it did, on "do not ask them to repeat anything", the moment v5.34.119
 * rewrapped the lines. The assertion has to see what the MODEL sees, so join
 * the fragments first. (Sixth time this project's instrument has reported on
 * its own formatting rather than on the product.)
 */
const joined = (s: string) => s.replace(/'\s*\+\s*'/g, "");

function load() {
  const fn = /LiveInterview\.prototype\._maybeRenewOnGoAway = function \(\) \{[\s\S]*?\n  \};/.exec(INTERVIEW);
  expect(fn, "_maybeRenewOnGoAway moved — update this test").toBeTruthy();
  const consts = /var GOAWAY_HANDOVER_COST_MS[\s\S]*?var GOAWAY_STALL_CONFIRMED_MS = [^;]+;/.exec(INTERVIEW);
  expect(consts, "the goAway constants moved — update this test").toBeTruthy();
  const sandbox: any = {
    console, Date, Math, Number, proto: {}, vlog: () => {},
    window: {}, setInterval: () => 1, clearInterval: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    consts![0] + "\n" + fn![0].replace("LiveInterview.prototype._maybeRenewOnGoAway =", "proto._maybeRenewOnGoAway ="),
    sandbox, { filename: "goaway" },
  );
  return sandbox;
}

/**
 * The reported situation, parameterised.
 *
 * `unansweredMs` is how long ago a user turn was transcribed with no model
 * frame since — i.e. how long the connection has been silent on a turn it
 * demonstrably heard. Omit it for a session with no outstanding turn.
 */
function interview(sandbox: any, o: {
  quietMs?: number; headroomSec?: number; inUtterance?: boolean;
  spokeSinceTurnEnd?: boolean; turnState?: string; unansweredMs?: number; goAwayOnThisTurn?: boolean;
} = {}) {
  const now = Date.now();
  const stops: string[] = [];
  let polls = 0;
  const li: any = {
    _goAwayPending: true,
    stopped: false,
    _muted: false,
    _turnState: o.turnState ?? "idle",
    _resumeHandle: "h1",
    _goAwayPoll: null,
    /* v5.34.118: the turn a goAway landed on, if any. */
    _goAwayDuringTurn: o.goAwayOnThisTurn ? now - (o.unansweredMs ?? 0) : null,
    _armGoAwayPoll: function (this: any) { polls++; this._goAwayPoll = 1; },
    session: {
      closed: false,
      _micInUtterance: !!o.inUtterance,
      _awaitingReply: o.unansweredMs !== undefined,
      _userTurnStartedAt: o.unansweredMs === undefined ? null : now - o.unansweredMs,
      _spokeSinceTurnEnd: o.spokeSinceTurnEnd,
      _micLastLoudAt: o.quietMs === undefined ? null : now - o.quietMs,
      _goAwayDeadlineAt: o.headroomSec === undefined ? null : now + o.headroomSec * 1000,
      stop: (r: string) => stops.push(r),
    },
    _maybeRenewOnGoAway: sandbox.proto._maybeRenewOnGoAway,
  };
  return { li, stops, handedOver: () => stops.includes("goaway"), polled: () => polls };
}

/** The reported run, at the moment the 12s watchdog printed. */
const REPORTED = {
  headroomSec: 35,        // goAway at +547254 with 50s of notice, now +561700
  spokeSinceTurnEnd: true, // they answered; the model's turn never closed
  turnState: "thinking",   // and so it stayed 'thinking' for twenty seconds
  quietMs: 12500,          // utterance ended at +549160
  unansweredMs: 12000,     // transcribed at +549693
};

describe("v5.34.117 — the reported 25-second silence", () => {
  const sandbox = load();

  it("hands over instead of waiting on a connection that stopped answering", () => {
    const { li, handedOver } = interview(sandbox, REPORTED);
    li._maybeRenewOnGoAway();
    expect(handedOver(), "still waiting for a turn boundary the dead socket will never produce").toBe(true);
  });

  it("would have handed over at 5s, not 20", () => {
    /*
     * The whole value of the fix is in the number. At 5s the interviewee has
     * noticed a pause; at 20s they have concluded the line is dead and said so
     * out loud, which is what happened.
     */
    const { li, handedOver } = interview(sandbox, { ...REPORTED, unansweredMs: 5100 });
    li._maybeRenewOnGoAway();
    expect(handedOver()).toBe(true);
  });

  it("does NOT hand over before the stall threshold", () => {
    /*
     * Healthy reply latency on the reported run: 10ms, 11ms, 591ms, 641ms,
     * 643ms. Five seconds is nearly eight times the worst of those, so this
     * boundary is not near anything normal — but a threshold with no test
     * under it drifts, and this one decides whether a working connection gets
     * thrown away mid-thought.
     */
    const { li, handedOver } = interview(sandbox, { ...REPORTED, unansweredMs: 4900 });
    li._maybeRenewOnGoAway();
    expect(handedOver(), "tore down a connection that was still within normal latency").toBe(false);
  });
});

describe("v5.34.117 — what the stall escape must NOT break", () => {
  const sandbox = load();

  it("still refuses to hand over while the model is genuinely working", () => {
    /*
     * The gate this fix reaches past is not wrong; it is only unbounded. With
     * no outstanding user turn, 'thinking' means a reply is being composed and
     * tearing the socket down would discard it.
     */
    const { li, handedOver, polled } = interview(sandbox, {
      headroomSec: 40, turnState: "thinking", quietMs: 9000, spokeSinceTurnEnd: false,
    });
    li._maybeRenewOnGoAway();
    expect(handedOver(), "discarded a reply that was in flight").toBe(false);
    expect(polled(), "deferred without arming a re-check — the deadlock that caused this defect").toBeGreaterThan(0);
  });

  it("still refuses to hand over while the model is speaking", () => {
    const { li, handedOver } = interview(sandbox, {
      headroomSec: 40, turnState: "speaking", quietMs: 9000,
    });
    li._maybeRenewOnGoAway();
    expect(handedOver()).toBe(false);
  });

  it("waits for the interviewee's sentence to end even when the model has stalled", () => {
    /*
     * On the reported run they started speaking again at +563751 — asking
     * whether anyone was there. Cutting the socket mid-word is the one thing
     * this whole branch exists to prevent, and it would put us straight back
     * into the v5.34.112 defect.
     */
    const { li, handedOver } = interview(sandbox, { ...REPORTED, unansweredMs: 20000, inUtterance: true, quietMs: 200 });
    li._maybeRenewOnGoAway();
    expect(handedOver(), "cut the interviewee off mid-sentence to escape a stall").toBe(false);
  });

  it("hands over once that sentence finishes", () => {
    const { li, handedOver } = interview(sandbox, { ...REPORTED, unansweredMs: 20000, inUtterance: false, quietMs: 600 });
    li._maybeRenewOnGoAway();
    expect(handedOver()).toBe(true);
  });

  it("v5.34.115's mid-answer deferral is untouched when the model has NOT stalled", () => {
    /*
     * +547255 on the reported trace. This is the call that saved a 38.7-second
     * answer, and it is the behaviour most at risk from a fix aimed at the
     * silence that followed it.
     */
    const { li, handedOver } = interview(sandbox, {
      headroomSec: 48, spokeSinceTurnEnd: true, quietMs: 1600, turnState: "idle",
    });
    li._maybeRenewOnGoAway();
    expect(handedOver(), "handed over mid-answer — this is the defect v5.34.115 fixed").toBe(false);
  });
});

describe("v5.34.117 — the server's deadline is reachable from every state", () => {
  const sandbox = load();

  it("hands over on the deadline even while the model is 'thinking'", () => {
    /*
     * The latent half of this defect, and the worse one. The thinking gate
     * used to return before mustGoNow was ever evaluated, so a stalled
     * connection ran to the server's own cut — losing the graceful teardown
     * and the resumption handle, which is a materially worse outcome than the
     * 25 seconds that were actually reported.
     */
    const { li, handedOver } = interview(sandbox, {
      headroomSec: 0, turnState: "thinking", quietMs: 9000,
    });
    li._maybeRenewOnGoAway();
    expect(handedOver(), "the server was left to cut us because the model was 'thinking'").toBe(true);
  });

  it("hands over on the deadline even while the model is 'speaking'", () => {
    const { li, handedOver } = interview(sandbox, {
      headroomSec: 0, turnState: "speaking", quietMs: 9000,
    });
    li._maybeRenewOnGoAway();
    expect(handedOver()).toBe(true);
  });

  it("every deferral arms a re-check", () => {
    /*
     * The mechanical root cause. A deferral that arms nothing is a wait with
     * no end, and the gate that produced the reported silence was exactly
     * that. Asserted across all three deferral paths.
     */
    for (const o of [
      { headroomSec: 40, turnState: "thinking", quietMs: 9000, spokeSinceTurnEnd: false },
      { headroomSec: 48, spokeSinceTurnEnd: true, quietMs: 1600 },
      { headroomSec: 48, inUtterance: true, quietMs: 100 },
    ]) {
      const { li, handedOver, polled } = interview(sandbox, o);
      li._maybeRenewOnGoAway();
      expect(handedOver()).toBe(false);
      expect(polled(), `deferred without arming a re-check: ${JSON.stringify(o)}`).toBeGreaterThan(0);
    }
  });

  it("the 'stopped answering' line is logged only once the handover is committed", () => {
    /*
     * Found by running the rig against the v5.34.116 code on purpose. The
     * first cut logged this the moment `replyStalled` went true — above the
     * deferral branch — so a build that detected the stall and then deferred
     * anyway printed a line saying it had handed over. The rig read that line
     * and reported "noticed after 5.1s" on a run that sat through the whole
     * 25-second stall.
     *
     * A log line that claims an action has to sit after the action is
     * committed, or it is the instrument lying about the product — which is
     * the failure mode that has cost this project more time than any defect.
     */
    const fn = /LiveInterview\.prototype\._maybeRenewOnGoAway = function \(\) \{[\s\S]*?\n  \};/.exec(INTERVIEW)![0];
    const iCommit = fn.indexOf("this._goAwayPending = false;");
    const iLog = fn.indexOf("handing over because this connection has stopped answering");
    expect(iCommit, "the handover commit point moved").toBeGreaterThan(0);
    expect(iLog, "the stalled-handover trace line is gone").toBeGreaterThan(0);
    expect(iLog, "the line claims a handover that has not been committed yet").toBeGreaterThan(iCommit);
  });

  it("_armGoAwayPoll exists and re-checks several times a second", () => {
    const m = /LiveInterview\.prototype\._armGoAwayPoll = function \(\) \{[\s\S]*?\n  \};/.exec(INTERVIEW);
    expect(m, "_armGoAwayPoll is gone — the deferral paths have nothing to arm").toBeTruthy();
    expect(m![0]).toMatch(/setInterval[\s\S]*?,\s*300\s*\)/);
    // It must be idempotent: three deferral paths call it, and a second timer
    // on the same interview means two handovers racing each other.
    expect(m![0]).toMatch(/if \(this\._goAwayPoll\) return;/);
  });
});

describe("v5.34.117 — the interviewee is not asked to repeat themselves", () => {
  it("the stalled branch is checked FIRST, ahead of the cut-off branch", () => {
    /*
     * Order is the whole fix here. On the reported run the interviewee had
     * been audible 6 seconds earlier (asking whether anyone was there), so
     * _cutOffInterviewee computes TRUE — and that branch says "I missed that
     * last part, could you say it again". Asking a senior executive to repeat
     * a 39-second answer that we hold in full, in the transcript, is a worse
     * version of the v5.34.112 defect rather than a fix for it.
     */
    const m = /self\.open\(self\._replyStalled([\s\S]*?)\);/.exec(INTERVIEW);
    expect(m, "the stalled-connection nudge branch is gone").toBeTruthy();
    const chain = joined(m![1]);
    expect(chain.indexOf("self._cutOffInterviewee"),
      "the cut-off branch is evaluated before the stalled branch").toBeGreaterThan(0);
    const stalled = chain.split("self._cutOffInterviewee")[0];
    /*
     * Assert the INSTRUCTION form, not a phrase. Twice this session a probe
     * has matched the negation of the thing it was testing for, because these
     * nudges say "do not say X" in the very branch that must not say X.
     */
    expect(stalled, "the stalled nudge asks for a repeat").not.toMatch(/ask them to say it again|could you say it again/i);
    expect(stalled, "the stalled nudge announces itself").not.toMatch(/Say in one short sentence that you are still there/);
    /*
     * v5.34.119 rewrote this branch. The v5.34.117 wording pointed the model at
     * the transcript ("it is there in the conversation you can see... respond
     * to that answer now") and it read the entry out verbatim on the
     * 2026-09-17 interview. The requirement is unchanged — do not make them
     * repeat a long answer we hold in full — but the action must be named
     * without naming the transcript. See neverReadTheAnswerBack.test.ts.
     */
    expect(stalled, "the stalled nudge does not name the action to take")
      .toMatch(/Take it as heard and carry straight on/i);
    expect(stalled).toMatch(/do not ask them to repeat anything/i);
  });

  it("names actions and forbids carrying the nudge forward", () => {
    // The v5.34.43 lesson: an open-ended "please continue" came back verbatim
    // eighteen times in ninety minutes.
    const stalled = joined(/self\.open\(self\._replyStalled([\s\S]*?)self\._cutOffInterviewee/.exec(INTERVIEW)![1]);
    expect(stalled).toMatch(/Just for this one turn/);
    expect(stalled).toMatch(/or in any later turn|never mention this again/i);
  });

  it("does not report a cut-off when the connection merely stalled", () => {
    expect(INTERVIEW).toMatch(/if \(replyStalled\) this\._cutOffInterviewee = false;/);
  });

  it("clears the flag, so one stall does not colour later handovers", () => {
    expect(INTERVIEW).toMatch(/self\._replyStalled = false;/);
  });
});

describe("v5.34.117 — the signals this reads are the ones vyne-live.js writes", () => {
  /*
   * This project's most reliable source of defects is a correct component
   * wired to nothing. `_awaitingReply` and `_userTurnStartedAt` are read here
   * across a file boundary, off an object this file does not own; a rename in
   * vyne-live.js would silently make the stall undetectable and restore the
   * reported behaviour with every test above still green.
   */
  it("vyne-live.js sets _awaitingReply on a transcribed user turn", () => {
    expect(LIVE).toMatch(/this\._awaitingReply = true;/);
    expect(LIVE).toMatch(/this\._userTurnStartedAt = now;/);
  });

  it("vyne-live.js clears _awaitingReply on the first model frame of any kind", () => {
    const m = /if \(this\._awaitingReply && \(([^)]*)\)\) \{[\s\S]{0,120}?this\._awaitingReply = false;/.exec(LIVE);
    expect(m, "the clear-on-activity path moved — the stall check may now never clear").toBeTruthy();
    // Audio, text, transcript or turnComplete all count as "it is alive".
    for (const sig of ["modelText", "audio", "agentText", "turnComplete"]) {
      expect(m![1], `${sig} no longer counts as model activity`).toContain(sig);
    }
  });

  it("the stall threshold is well below the watchdog that named this defect", () => {
    /*
     * REPLY_WATCHDOG_MS is when the product COMPLAINS about an unanswered
     * turn. Acting must happen first, and by a clear margin: by the time that
     * line prints, the interviewee is already wondering if the line is dead.
     */
    const stall = Number(/var GOAWAY_STALL_MS = Number\([^)]*\) \|\| (\d+);/.exec(INTERVIEW)![1]);
    const watchdog = Number(/var REPLY_WATCHDOG_MS = Number\([^)]*\) \|\| (\d+);/.exec(LIVE)![1]);
    expect(stall).toBeGreaterThan(1500);   // above any real reply latency
    expect(stall * 2).toBeLessThanOrEqual(watchdog);
  });

  it("the threshold is overridable, so a soak can exercise the other branches", () => {
    expect(INTERVIEW).toMatch(/window\.VYNE_GOAWAY_STALL_MS/);
  });
});

/**
 * ── v5.34.118: the server tells us twice ────────────────────────────────────
 *
 * v5.34.117 shipped and the 9-minute pause dropped from 25s to 7.3s, measured
 * on the 2026-09-16 live interview:
 *
 *   +788248  you stop speaking (14.5s answer)
 *   +788650  USER TURN #13 — the server transcribes it
 *   +788660  frame goAway                          <- TEN MILLISECONDS LATER
 *      ...   no model frame of any kind
 *   +793924  handing over — this connection has stopped answering   (5.27s)
 *   +794299  grant minted                                          (0.37s)
 *   +794776  new session live                                      (0.48s)
 *   +795566  *** FIRST AUDIO FRAME — the agent is speaking ***      (0.79s)
 *
 * "There is still a longer than expected silence at exactly the 9 minute mark.
 *  The pause is long enough to notice."
 *
 * He is right, and 5.27 of those 7.3 seconds are GOAWAY_STALL_MS — a margin
 * this file chose, not a defect. The handover itself costs 1.6s.
 *
 * The margin exists to be SURE the model is not merely slow. The trace shows
 * the server had already told us, and told us twice:
 *
 *   v5.34.116 trace   +549693 USER TURN #9   → +549704 goAway  (11ms)
 *   v5.34.117 trace   +788650 USER TURN #13  → +788660 goAway  (10ms)
 *
 * Two builds, two interviews, the same ten milliseconds, and in both cases the
 * turn was never answered. The socket is healthy — it transcribed the answer —
 * and the server is draining it: it will accept audio and decline to generate.
 *
 * So a goAway landing on an already-transcribed, unanswered turn IS the
 * confirmation the five seconds were buying. These tests hold that the wait
 * collapses when it arrives, and stays long when it does not.
 */
describe("v5.34.118 — a goAway on an unanswered turn collapses the wait", () => {
  const sandbox = load();

  /* The 2026-09-16 run, one second after the transcript. */
  const CONFIRMED = {
    headroomSec: 45, spokeSinceTurnEnd: true, turnState: "thinking", quietMs: 1400,
    unansweredMs: 1100, goAwayOnThisTurn: true,
  };

  it("hands over about a second in, not five", () => {
    const { li, handedOver } = interview(sandbox, CONFIRMED);
    li._maybeRenewOnGoAway();
    expect(handedOver(), "still spending 5s confirming what the server already said twice").toBe(true);
  });

  it("does NOT collapse the wait without that goAway", () => {
    /*
     * The same instant with no goAway on this turn is an ordinary slow reply,
     * and 1.1s is well inside what a model may legitimately take. Only the
     * server's second signal justifies going early.
     */
    const { li, handedOver } = interview(sandbox, { ...CONFIRMED, goAwayOnThisTurn: false });
    li._maybeRenewOnGoAway();
    expect(handedOver(), "tore down a merely-slow connection at 1.1s").toBe(false);
  });

  it("leaves room for a reply that is about to begin", () => {
    /*
     * Measured healthy latency on that interview: 5, 8, 8, 14, 16, 19 and
     * 599ms. 900ms clears the worst of them, so the collapse must not fire
     * there — otherwise the fix for a stalled connection becomes a new way to
     * discard a working one.
     */
    const { li, handedOver } = interview(sandbox, { ...CONFIRMED, unansweredMs: 900 });
    li._maybeRenewOnGoAway();
    expect(handedOver(), "cut off a reply inside normal latency").toBe(false);
  });

  it("still waits for the interviewee's sentence to end", () => {
    const { li, handedOver } = interview(sandbox, { ...CONFIRMED, inUtterance: true, quietMs: 100 });
    li._maybeRenewOnGoAway();
    expect(handedOver(), "cut the interviewee off mid-sentence").toBe(false);
  });

  it("the long wait still applies to a stall with no goAway attached", () => {
    // v5.34.117's behaviour has to survive intact: most stalls arrive with no
    // second signal, and 5s remains the right margin for those.
    const { li, handedOver } = interview(sandbox, { ...REPORTED, unansweredMs: 4900 });
    li._maybeRenewOnGoAway();
    expect(handedOver()).toBe(false);
  });
});

describe("v5.34.118 — the marker is tied to the turn, not to the connection", () => {
  const sandbox = load();

  it("a goAway from a DIFFERENT turn does not shorten this one", () => {
    /*
     * The failure this guards against: a boolean flag. goAway #1 on the
     * 2026-09-16 run arrived at +774423, fourteen seconds before the turn that
     * stalled. A flag set then would still be set now, and would collapse the
     * wait on every later turn of that connection whether or not the server had
     * said anything about them.
     */
    const { li, handedOver } = interview(sandbox, { ...REPORTED, unansweredMs: 1100 });
    li._goAwayDuringTurn = li.session._userTurnStartedAt - 14000;  // a previous turn
    li._maybeRenewOnGoAway();
    expect(handedOver(), "a stale goAway marker shortened the wait on an untouched turn").toBe(false);
  });

  it("onGoAway records the turn it landed on, not a bare flag", () => {
    const m = /onGoAway: function \(timeLeftMs\) \{[\s\S]*?\n      \},/.exec(INTERVIEW);
    expect(m, "onGoAway moved — update this test").toBeTruthy();
    expect(m![0]).toMatch(/_goAwayDuringTurn = s\._userTurnStartedAt/);
    // Guarded on there actually BEING an unanswered turn.
    expect(m![0]).toMatch(/s\._awaitingReply && s\._userTurnStartedAt/);
  });

  it("the marker is cleared when the connection is replaced", () => {
    /*
     * A goAway belongs to one socket. Carried into the next session it would
     * be compared against a fresh turn clock, and this project has shipped
     * exactly that defect before — v5.34.33, the goAway that outlived its
     * connection.
     */
    expect(INTERVIEW).toMatch(/self\._goAwayDuringTurn = null;/);
  });

  it("the two thresholds are ordered, and the short one clears real latency", () => {
    const long = Number(/var GOAWAY_STALL_MS = Number\([^)]*\) \|\| (\d+);/.exec(INTERVIEW)![1]);
    const short = Number(/var GOAWAY_STALL_CONFIRMED_MS = Number\([^)]*\) \|\| (\d+);/.exec(INTERVIEW)![1]);
    expect(short).toBeLessThan(long);
    // 599ms was the slowest healthy reply on the reported interview.
    expect(short, "below the slowest healthy reply measured — this will race real replies").toBeGreaterThan(700);
  });
});
