/**
 * The voice harness measures the RUN, not itself. (v5.34.114)
 *
 * ── Why the instrument gets its own tests ───────────────────────────────────
 *
 * deploy/voice-record.mjs is a development tool, so it has never had any. It
 * has now produced four separate measurement failures that were each read as
 * product defects and chased as such:
 *
 *   1. `minutes=NaN` — a flag passed in the wrong form became a NaN time
 *      limit, setTimeout fired on the first tick, and a complete verdict was
 *      printed for a run that never happened.
 *
 *   2. A 40-second machine sleep produced "the uplink never drained" and three
 *      minutes of dead air, indistinguishable in the trace from a network
 *      fault. Reported to the user as the connection jamming. It was not.
 *
 *   3. The stall watchdog timed its window from when an ANSWER WAS CUED, so a
 *      healthy exchange — a 23-second answer plus a 1.3-second reply — reported
 *      a stall. Five of seven on one run, then three more on the next after a
 *      partial fix.
 *
 *   4. The answer budget and the run deadline were two different clocks, and
 *      the gap between them was however long text-to-speech took. On the
 *      2026-09-15 live run that was eight minutes: the interviewee went mute
 *      fourteen minutes into a twenty-two minute interview, the run continued
 *      for another eight, and the verdict showed 18 stall recoveries and a
 *      conversation that had died. The product was working the whole time and
 *      said so, twenty-one times: "mic uplink SILENT for 15s while unmuted —
 *      frames flow but carry no audio; the model cannot hear".
 *
 * Every one of those cost a paid run and a debugging session. The harness's own
 * warning — "a broken harness and a broken product look identical from here" —
 * has been proved right four times, so its clocks are now pinned.
 *
 * These assertions are STATIC, read off the source. That is a real limitation:
 * they catch a clock being reintroduced, not a clock being wrong in a new way.
 * They are here because the cost of the failure is a paid run plus a wrong
 * conclusion, and static is what this file can be checked with for free.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RIG = readFileSync(join(__dirname, "..", "..", "deploy", "voice-record.mjs"), "utf8");

/** The body of `nextAnswer()` — what decides whether the tape speaks. */
function nextAnswerBody(): string {
  const at = RIG.indexOf("async function nextAnswer()");
  expect(at, "nextAnswer() moved — update this test").toBeGreaterThan(-1);
  const end = RIG.indexOf("\n}", at);
  return RIG.slice(at, end);
}

describe("v5.34.114 — one clock for the run", () => {
  it("the answer budget is the run deadline, not the process's own age", () => {
    /*
     * `t0` is set when the process starts, before the answers are synthesised.
     * A budget measured from it runs out early by exactly the synthesis time,
     * and the tape then goes silent while the run continues — which reads as
     * the interview dying.
     */
    const body = nextAnswerBody();
    expect(body, "nextAnswer() is back to timing itself from process start")
      .not.toMatch(/Date\.now\(\)\s*-\s*t0\s*>/);
    expect(body, "nextAnswer() no longer checks the run deadline at all")
      .toMatch(/RUN_DEADLINE_AT/);
  });

  it("the deadline is set after the answers are synthesised, not before", () => {
    /*
     * Order in the file is the proxy for order in time here: the assignment
     * sits at the bottom, after the top-level await that generates the tape,
     * which is the same place the run's own finish timer is armed. If it moved
     * above that, both clocks would be wrong together — which is tidier and
     * just as broken.
     */
    const assigned = RIG.indexOf("RUN_DEADLINE_AT = Date.now() + MINUTES * 60000;");
    const finishArmed = RIG.indexOf("setTimeout(() => finish(`reached the ${MINUTES}-minute limit`)");
    expect(assigned, "the deadline assignment is gone").toBeGreaterThan(-1);
    expect(finishArmed, "the run's finish timer moved").toBeGreaterThan(-1);
    // Adjacent, so the two can never be armed from different moments again.
    expect(Math.abs(assigned - finishArmed)).toBeLessThan(200);
  });

  it("declares the deadline without a temporal dead zone", () => {
    // A `const` at the bottom of the file throws on any earlier read rather
    // than reading as unset. Caught while writing the fix.
    expect(RIG).toMatch(/let RUN_DEADLINE_AT = Infinity;/);
  });
});

describe("v5.34.114 — a stall is silence from the model", () => {
  it("the window is measured from model activity, not from the cue alone", () => {
    const at = RIG.indexOf("stallRecoveries++");
    expect(at).toBeGreaterThan(-1);
    const guard = RIG.slice(Math.max(0, at - 700), at);
    expect(guard, "the stall window is back to timing from the cue")
      .toMatch(/Math\.max\(lastCueAt, lastActivityAt\)/);
  });

  it("an answer finishing counts as activity", () => {
    /*
     * The correction that finally made the number honest. Without it a long
     * answer plus a normal reply overruns the window, because nothing during
     * the answer's own playback counts.
     */
    const at = RIG.indexOf("clearInterval(waitForDrain); askedAt = now(); answering = false;");
    expect(at, "the uplink drain handler moved — update this test").toBeGreaterThan(-1);
    expect(RIG.slice(at, at + 200)).toMatch(/noteActivity\(\)/);
  });

  it("the window restarts when the interview does", () => {
    // Otherwise the first thing the watchdog reports is how long text-to-speech
    // took: "nothing has happened for 480s", measured against the TTS.
    const at = RIG.indexOf("sessionUpAt = now();");
    expect(at, "sessionUpAt assignment moved — update this test").toBeGreaterThan(-1);
    expect(RIG.slice(at, at + 600)).toMatch(/lastCueAt = Date\.now\(\)/);
  });

  it("neither suppression pass is unbounded", () => {
    /*
     * A pass granted while something is legitimately in progress has to be
     * withdrawn once "in progress" outlasts anything it could be. Both the
     * stuck-uplink and the mid-turn passes are ceilinged; the uplink one was
     * what blinded the watchdog for 186 seconds.
     */
    expect(RIG).toMatch(/var|const|let/);
    expect(RIG).toMatch(/STUCK_MS/);
    const at = RIG.indexOf("stallRecoveries++");
    const guard = RIG.slice(Math.max(0, at - 1200), at);
    expect(guard, "the stuck-uplink pass lost its ceiling").toMatch(/uplinkBusySince/);
    expect(guard, "the mid-turn pass lost its ceiling").toMatch(/turnBusySince/);
  });
});

describe("v5.34.114 — the harness cannot hide that it stopped running", () => {
  it("a suspended process is detected and reported", () => {
    expect(RIG, "the suspension heartbeat is gone").toMatch(/SUSPEND_FLOOR_MS/);
    expect(RIG).toMatch(/THIS PROCESS WAS SUSPENDED/);
  });

  it("a non-numeric time limit refuses to start", () => {
    expect(RIG).toMatch(/Number\.isFinite\(MINUTES\)/);
  });
});

describe("v5.34.114 — the stub is faithful to the frame's CONTENT", () => {
  it("goAway gives the notice production actually gives", () => {
    /*
     * The stub said 8s; the live trace says 50s. With 8s there is never any
     * headroom, so every offline run took the old path and could not reach the
     * handover-gap logic at all — a check that reports PASS on behaviour it
     * never executed.
     */
    const m = /const OFFLINE_GOAWAY_TIMELEFT = arg\("offline-goaway-timeleft", "(\d+)s"\)/.exec(RIG);
    expect(m, "the stub's goAway notice is no longer configurable").toBeTruthy();
    expect(Number(m![1]), "the stub is back to a notice production never sends")
      .toBeGreaterThanOrEqual(30);
  });

  it("the tape pauses mid-answer, the way a person does", () => {
    // Without this the harness cannot reproduce the reported minute-nine
    // failure at all: a tape that never pauses never gets cut off by one.
    expect(RIG).toMatch(/OFFLINE_THINK_PAUSE_MS/);
    const m = /const OFFLINE_THINK_PAUSE_MS = Number\(arg\("offline-think-pause", (\d+)\)\)/.exec(RIG);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(0);
  });
});
