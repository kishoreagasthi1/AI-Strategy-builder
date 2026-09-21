/**
 * The ~10-minute handover waits for a real gap. (v5.34.112)
 *
 * ── Reported from a live interview, not a harness ───────────────────────────
 *
 * 12-minute interview on v5.34.111, a real person answering. It went well
 * except at about minute NINE:
 *
 *   "I spoke for a few seconds maybe 15 seconds and the agent did not pick it
 *    up and asked me to answer as though I had not heard it and said 'I am
 *    still here'."
 *
 * Minute nine is the handover — measured at 8.2 minutes on the 20-minute soak
 * of the same build. Three separate things combined to produce what he saw, and
 * all three were ours:
 *
 *   1. `_maybeRenewOnGoAway` defers a handover while the interviewee is
 *      speaking, then settles for the first 1500ms of quiet. That is well
 *      inside how long someone pauses while composing an answer. The pause for
 *      thought reads as the end of the turn.
 *
 *   2. Anything said during the teardown and reconnect is gone — the old
 *      socket is being discarded, the new one does not exist yet. So the
 *      fifteen seconds after that pause went nowhere.
 *
 *   3. The nudge sent to the fresh session said, verbatim: "Say in one short
 *      sentence that you are still there." "I am still here" was not the model
 *      misbehaving. We asked for it.
 *
 * And the budget was never the constraint: Google's goAway gives FIFTY seconds
 * of notice — measured in the trace as "timeLeft":"50s" — and we were spending
 * 1.5 of them. The two numbers were set in different files at different times
 * and never related to each other.
 *
 * ── What these tests hold ───────────────────────────────────────────────────
 *
 * That the wait scales with the headroom actually available, that it never
 * misses the server's deadline (a server-cut handover is worse than an awkward
 * one), and that the interviewer is told the truth about whether it interrupted
 * someone — because the recovery an interviewee experiences is entirely
 * determined by which of two sentences we send.
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

/** `_maybeRenewOnGoAway`, lifted out of its IIFE with its constants. */
function load() {
  const fn = /LiveInterview\.prototype\._maybeRenewOnGoAway = function \(\) \{[\s\S]*?\n  \};/.exec(INTERVIEW);
  expect(fn, "_maybeRenewOnGoAway moved — update this test").toBeTruthy();
  /* v5.34.117 added GOAWAY_STALL_MS after CUTOFF_WINDOW_MS, so the block now
   * ends there. Anchored on the last declaration rather than a line count for
   * the usual reason: a constant the function reads and the sandbox does not
   * define is a ReferenceError inside a try/catch somewhere, not a failure. */
  const consts = /var GOAWAY_HANDOVER_COST_MS[\s\S]*?var GOAWAY_STALL_CONFIRMED_MS = [^;]+;/.exec(INTERVIEW);
  expect(consts, "the goAway constants moved — update this test").toBeTruthy();
  const sandbox: any = {
    console, Date, Math, Number, proto: {}, vlog: () => {},
    window: {},
    setInterval: () => 1, clearInterval: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    consts![0] + "\n" + fn![0].replace("LiveInterview.prototype._maybeRenewOnGoAway =", "proto._maybeRenewOnGoAway ="),
    sandbox, { filename: "goaway" },
  );
  return sandbox;
}

/**
 * An interview with a goAway pending. `quietMs` is how long since the
 * interviewee was last audible; `headroomSec` how long until the server cuts.
 */
function interview(sandbox: any, o: { quietMs?: number; headroomSec?: number; inUtterance?: boolean; spokeSinceTurnEnd?: boolean;
                                     turnState?: string; unansweredMs?: number; goAwayOnThisTurn?: boolean } = {}) {
  const now = Date.now();
  const stops: string[] = [];
  const polls: number[] = [];
  const li: any = {
    _goAwayPending: true,
    stopped: false,
    _muted: false,
    _turnState: o.turnState ?? "idle",
    _resumeHandle: "h1",
    _goAwayPoll: null,
    /* v5.34.117: the deferral paths now arm the poll through a method rather
     * than inline, so the fake has to provide it. Recorded, not ignored — a
     * deferral that arms nothing is the bug that made the reported silence
     * unbounded, so the tests below assert on it. */
    /* v5.34.118: the turn a goAway landed on, if any. */
    _goAwayDuringTurn: o.goAwayOnThisTurn ? now - (o.unansweredMs ?? 0) : null,
    _armGoAwayPoll: function (this: any) { polls.push(1); this._goAwayPoll = 1; },
    session: {
      closed: false,
      _micInUtterance: !!o.inUtterance,
      /* v5.34.117: "it transcribed a turn and has produced nothing since". */
      _awaitingReply: o.unansweredMs !== undefined,
      _userTurnStartedAt: o.unansweredMs === undefined ? null : now - o.unansweredMs,
      /* v5.34.115: undefined means "unknown", which must behave like the old
       * silence-based rule; the tests below set it explicitly. */
      _spokeSinceTurnEnd: o.spokeSinceTurnEnd,
      _micLastLoudAt: o.quietMs === undefined ? null : now - o.quietMs,
      _goAwayDeadlineAt: o.headroomSec === undefined ? null : now + o.headroomSec * 1000,
      stop: (r: string) => stops.push(r),
    },
    _maybeRenewOnGoAway: sandbox.proto._maybeRenewOnGoAway,
  };
  return { li, stops, polls, handedOver: () => stops.includes("goaway") };
}

describe("v5.34.112 — a pause for thought is not the end of a turn", () => {
  const sandbox = load();

  it("does NOT hand over after a 1.6s pause when there is plenty of time", () => {
    /*
     * THE reported defect. 1.6 seconds is someone drawing breath mid-answer,
     * and with ~50s of goAway notice there is no reason to take it as a turn
     * boundary.
     */
    const { li, handedOver } = interview(sandbox, { quietMs: 1600, headroomSec: 48 });
    li._maybeRenewOnGoAway();
    expect(handedOver(), "handed over during a pause for thought — the answer that follows is lost").toBe(false);
  });

  it("hands over on a real gap", () => {
    const { li, handedOver } = interview(sandbox, { quietMs: 5000, headroomSec: 48 });
    li._maybeRenewOnGoAway();
    expect(handedOver()).toBe(true);
  });

  it("hands over when the interviewee has not spoken at all", () => {
    // Waiting for the interviewer to ask something — the ideal moment.
    const { li, handedOver } = interview(sandbox, { headroomSec: 48 });
    li._maybeRenewOnGoAway();
    expect(handedOver()).toBe(true);
  });

  it("accepts a short pause once the deadline is close", () => {
    // Headroom below the relax threshold: take what we can get.
    const { li, handedOver } = interview(sandbox, { quietMs: 1600, headroomSec: 8 });
    li._maybeRenewOnGoAway();
    expect(handedOver()).toBe(true);
  });

  it("hands over ON the deadline even mid-sentence", () => {
    /*
     * A server-cut handover loses the resumption handle and the graceful
     * teardown; an awkward one loses a sentence. Never let the server decide.
     */
    const { li, handedOver } = interview(sandbox, { quietMs: 100, inUtterance: true, headroomSec: 0 });
    li._maybeRenewOnGoAway();
    expect(handedOver(), "the server was allowed to cut us instead").toBe(true);
  });

  it("never hands over mid-utterance while there is still headroom", () => {
    const { li, handedOver } = interview(sandbox, { quietMs: 9000, inUtterance: true, headroomSec: 40 });
    li._maybeRenewOnGoAway();
    expect(handedOver()).toBe(false);
  });

  it("keeps the old behaviour when the server gave no deadline", () => {
    /*
     * No deadline recorded means no budget to spend — an older server, or a
     * renewal not driven by goAway. Must not become MORE eager than before.
     */
    const { li, handedOver } = interview(sandbox, { quietMs: 1600 });
    li._maybeRenewOnGoAway();
    expect(handedOver()).toBe(true);
  });

  it("records whether the interviewee was cut off", () => {
    const cut = interview(sandbox, { quietMs: 300, headroomSec: 0 });
    cut.li._maybeRenewOnGoAway();
    expect(cut.li._cutOffInterviewee, "we took words off them and did not notice").toBe(true);

    const clean = interview(sandbox, { quietMs: 9000, headroomSec: 48 });
    clean.li._maybeRenewOnGoAway();
    expect(clean.li._cutOffInterviewee, "a clean gap was reported as an interruption").toBe(false);
  });
});

describe("v5.34.112 — the interviewer is told which recovery to perform", () => {
  it("has a nudge for the case where it cut someone off", () => {
    /* v5.34.117 inserted the stalled-connection branch ahead of this one, so
     * the chain now opens on _replyStalled. Anchored on the open() call rather
     * than on _cutOffInterviewee's position in it. */
    const m = /self\.open\(self\._replyStalled[\s\S]*?\);/.exec(INTERVIEW);
    expect(m, "the renewal nudge chain is gone").toBeTruthy();
    const nudge = m![0].split("self._cutOffInterviewee")[1];
    expect(nudge, "the cut-off branch of the renewal nudge is gone").toBeTruthy();
    // It must ask for the answer again, and must NOT open by announcing itself.
    expect(nudge).toMatch(/say it again|repeat/i);
    expect(nudge).toMatch(/do not say you are still there/i);
  });

  it("keeps the 'still there' wording ONLY for the uninterrupted case", () => {
    /*
     * That sentence is correct when the handover landed in a genuine gap and
     * the interviewee is waiting. It is what made a lost answer read as a
     * broken agent when it did not.
     */
    const m = /self\.open\(self\._replyStalled([\s\S]*?)\);/.exec(INTERVIEW);
    const branches = m![1].split("self._cutOffInterviewee")[1].split(": resumed");
    expect(branches.length).toBeGreaterThan(1);
    /*
     * Assert the INSTRUCTION, not the phrase. The first draft matched
     * /you are still there,/ against the cut-off branch — which contains
     * "do not say you are still there". A probe that matches the negation of
     * the thing it is testing for; the third time this session that a test has
     * matched prose rather than meaning.
     */
    expect(branches[0], "the cut-off nudge still tells it to announce itself")
      .not.toMatch(/Say in one short sentence that you are still there/);
    expect(branches[1], "the uninterrupted nudge lost its 'still there' wording")
      .toMatch(/Say in one short sentence that you are still there/);
  });

  it("clears the flag, so one interruption does not colour later handovers", () => {
    expect(INTERVIEW).toMatch(/self\._cutOffInterviewee = false;/);
  });
});

describe("v5.34.112 — the duplicated constant agrees with its original", () => {
  it("GOAWAY_HANDOVER_COST_MS is the same in both files", () => {
    /*
     * vyne-live.js declares it inside its own IIFE, so vyne-live-interview.js
     * cannot read it and carries its own copy. The first draft of this change
     * referenced it across the boundary and would have thrown a ReferenceError
     * on every handover. A copied constant is this project's most reliable
     * source of defects, so the copies are pinned to each other.
     */
    const a = /var GOAWAY_HANDOVER_COST_MS = (\d+);/.exec(LIVE);
    const b = /var GOAWAY_HANDOVER_COST_MS = (\d+);/.exec(INTERVIEW);
    expect(a, "vyne-live.js no longer defines it").toBeTruthy();
    expect(b, "vyne-live-interview.js no longer defines it").toBeTruthy();
    expect(Number(b![1])).toBe(Number(a![1]));
  });

  it("the ideal gap is longer than the minimum, and both are plausible speech pauses", () => {
    const ideal = Number(/var GOAWAY_QUIET_IDEAL_MS = Number\([^)]*\) \|\| (\d+);/.exec(INTERVIEW)![1]);
    const min = Number(/var GOAWAY_QUIET_MIN_MS = Number\([^)]*\) \|\| (\d+);/.exec(INTERVIEW)![1]);
    expect(ideal).toBeGreaterThan(min);
    // Long enough to clear a breath, short enough to find inside 50s of notice.
    expect(ideal).toBeGreaterThanOrEqual(3000);
    expect(ideal).toBeLessThanOrEqual(10000);
  });

  it("the relax threshold leaves room for the ideal gap to be found", () => {
    const relax = Number(/var GOAWAY_RELAX_BELOW_MS = (\d+);/.exec(INTERVIEW)![1]);
    const ideal = Number(/var GOAWAY_QUIET_IDEAL_MS = Number\([^)]*\) \|\| (\d+);/.exec(INTERVIEW)![1]);
    expect(relax, "no time is left to wait for the gap we are asking for").toBeGreaterThan(ideal);
  });
});

describe("v5.34.115 — the handover waits for a turn boundary", () => {
  const sandbox = load();

  it("goes immediately when the question has been asked and not yet answered", () => {
    /*
     * The one unambiguously safe moment in a turn. Silence has barely started
     * — they are drawing breath to answer — and that is exactly when a
     * handover costs nothing, so the quiet threshold must not hold it back.
     */
    const { li, handedOver } = interview(sandbox, {
      quietMs: 200, headroomSec: 48, spokeSinceTurnEnd: false,
    });
    li._maybeRenewOnGoAway();
    expect(handedOver(), "the safe window came and went unused").toBe(true);
  });

  it("does NOT go mid-answer, however long the thinking pause", () => {
    /*
     * THE reported defect on v5.34.114: a long answer with a pause longer than
     * the 4s threshold. The transcript begins mid-sentence because the front of
     * the answer went into the socket being torn down.
     */
    for (const pause of [4100, 6000, 12000]) {
      const { li, handedOver } = interview(sandbox, {
        quietMs: pause, headroomSec: 48, spokeSinceTurnEnd: true,
      });
      li._maybeRenewOnGoAway();
      expect(handedOver(), `handed over after a ${pause}ms pause inside an answer`).toBe(false);
    }
  });

  it("falls back to the silence rule when the deadline is close", () => {
    // Waiting for a boundary that may not come costs more than an awkward cut.
    const { li, handedOver } = interview(sandbox, {
      quietMs: 1600, headroomSec: 8, spokeSinceTurnEnd: true,
    });
    li._maybeRenewOnGoAway();
    expect(handedOver()).toBe(true);
  });

  it("still goes on the deadline, mid-answer or not", () => {
    const { li, handedOver } = interview(sandbox, {
      quietMs: 100, inUtterance: true, headroomSec: 0, spokeSinceTurnEnd: true,
    });
    li._maybeRenewOnGoAway();
    expect(handedOver()).toBe(true);
  });

  it("a boundary handover is not reported as an interruption", () => {
    /*
     * Which nudge the fresh session gets is decided by this. Apologising for
     * missing an answer nobody had started giving would be its own small lie.
     */
    const { li } = interview(sandbox, {
      quietMs: 200, headroomSec: 48, spokeSinceTurnEnd: false,
    });
    li._maybeRenewOnGoAway();
    expect(li._cutOffInterviewee).toBe(false);
  });

  it("a deadline handover mid-answer IS reported as an interruption", () => {
    const { li } = interview(sandbox, {
      quietMs: 200, headroomSec: 0, spokeSinceTurnEnd: true,
    });
    li._maybeRenewOnGoAway();
    expect(li._cutOffInterviewee, "cut someone off and did not admit it").toBe(true);
  });
});

describe("v5.34.115 — the page marks the boundary", () => {
  it("clears the flag when the model's turn closes", () => {
    const close = /VyneLiveSession\.prototype\._closeTurn = function \(why\) \{[\s\S]*?\n  \};/.exec(LIVE);
    expect(close, "_closeTurn moved — update this test").toBeTruthy();
    expect(close![0]).toMatch(/_spokeSinceTurnEnd = false/);
  });

  it("sets it the instant the microphone hears speech", () => {
    const at = LIVE.indexOf("this._micInUtterance = true;");
    expect(at).toBeGreaterThan(-1);
    expect(LIVE.slice(at, at + 400)).toMatch(/_spokeSinceTurnEnd = true/);
  });
});
