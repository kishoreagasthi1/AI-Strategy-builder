/**
 * A turn is not over while the interviewer is still talking. (v5.34.101)
 *
 * ── What was happening, measured ────────────────────────────────────────────
 *
 * `generationComplete` means the model finished GENERATING. It says nothing
 * about playback, and the two are seconds apart: the model pushes a whole
 * answer down the socket as fast as it will go, and the audio then plays out
 * locally in real time.
 *
 * From the live run of 2026-09-14, at the moment each turn was closed:
 *
 *     playbackPending   30  25  12  15  15  10  14  14  16  14
 *     stillQueuedSec   9.1 7.1 3.3 4.6 4.5 3.1 4.0 3.6 4.5 4.3
 *
 * Every turn went to 'idle' with between three and nine seconds of the
 * interviewer's voice still queued. Downstream, 'idle' is the signal that the
 * floor is free: the UI clears "speaking", the mic reopens, and the interviewee
 * is invited to answer a question that is still being asked.
 *
 * ── Why it stayed invisible ─────────────────────────────────────────────────
 *
 * Two things had to change at once. `turnComplete` used to arrive and close the
 * turn at the right moment, so the generationComplete salvage was pathological
 * and rare — 3 occurrences in a 30-minute recording on 2026-09-13. By
 * 2026-09-14 gemini-2.5-flash-native-audio-latest had stopped sending
 * `turnComplete` at all (11 generationComplete, 0 turnComplete, 11 salvages),
 * so the salvage became the ONLY way a turn closes and its timing became the
 * conversation's timing.
 *
 * And the offline rig always sent `turnComplete`, so no amount of free testing
 * could reproduce it. `--offline-prod-turns` now makes the rig behave the way
 * production actually does; that flag is what turned this from a number nobody
 * could explain into something reproducible in ninety seconds.
 *
 * These tests drive _closeTurn directly against a fake queue, because the real
 * one needs an AudioContext and what is under test is the state machine, not
 * the audio.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const src = readFileSync(join(root, "frontend", "vyne-live.js"), "utf8");

/**
 * The prototype under test, lifted out of the IIFE.
 *
 * vyne-live.js publishes a factory on window and keeps VyneLiveSession private,
 * so the constructor is not reachable. The three methods this concerns are
 * plain prototype functions with no closure dependencies beyond `vlog` and the
 * two IDLE_DEFER_* constants, so they are extracted and bound to a stub.
 */
function loadTurnMethods() {
  const grab = (name: string) => {
    const re = new RegExp(
      `VyneLiveSession\\.prototype\\.${name} = function \\([\\s\\S]*?\\n  \\};`, "m");
    const m = re.exec(src);
    expect(m, `${name} moved or changed shape — update this test`).toBeTruthy();
    return m![0].replace(`VyneLiveSession.prototype.${name} =`, `proto.${name} =`);
  };
  const consts = /var IDLE_DEFER_MIN_MS[\s\S]*?var GOAWAY_HANDOVER_COST_MS = \d+;/.exec(src);
  expect(consts, "the IDLE_DEFER_* / GOAWAY_HANDOVER_COST_MS constants are gone").toBeTruthy();

  const sandbox: any = { console, setTimeout, clearTimeout, Date, Math, proto: {}, vlogged: [] };
  sandbox.vlog = (...a: unknown[]) => sandbox.vlogged.push(a);
  vm.createContext(sandbox);
  vm.runInContext(
    `${consts![0]}\n${grab("_clearIdleDefer")}\n${grab("_closeTurn")}\n${grab("_setTurnState")}`,
    sandbox, { filename: "vyne-live-turn-methods" },
  );
  return sandbox;
}

/** A session stub carrying only what _closeTurn touches. */
function makeSession(sandbox: any, remainingMs: number) {
  const states: string[] = [];
  const s: any = {
    _turnState: "speaking",
    _turnAudio: true,
    /* v5.34.109: a close only counts when the model has generated something
     * since the last one — _noteModelActivity sets this from real frames, so a
     * stub that skips it has every close suppressed as a duplicate. */
    _contentSinceClose: true,
    queue: { remainingMs: () => remainingMs, pending: () => 3, endRun: () => {} },
    opts: { onTurnState: (x: string) => states.push(x) },
    _bankTurnUsage: () => {},
    _clearIdleDefer: sandbox.proto._clearIdleDefer,
    /* v5.34.111: releasing the floor also delivers the turn-close notice, so a
     * stub that skips this throws where the real session tells the app its turn
     * ended. What that delivery protects is handoverKeepsTheLastTurn.test.ts's
     * job; here it only has to exist. */
    _drainTurnCompleteNotice: () => {},
    _closeTurn: sandbox.proto._closeTurn,
    _setTurnState: sandbox.proto._setTurnState,
  };
  return { s, states };
}

describe("v5.34.101 — the floor is held until the audio has played", () => {
  let sandbox: any;
  beforeEach(() => { vi.useFakeTimers(); sandbox = loadTurnMethods(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does NOT go idle while seconds of speech are still queued", () => {
    /*
     * The defect, as a behaviour. 4.5s was a typical figure from the live run.
     */
    const { s, states } = makeSession(sandbox, 4500);
    s._closeTurn("generationComplete");
    expect(states, "the session announced idle with 4.5s of speech still to play")
      .not.toContain("idle");
    expect(s._turnState).toBe("speaking");
  });

  it("goes idle once the queued audio has finished", () => {
    const { s, states } = makeSession(sandbox, 4500);
    s._closeTurn("generationComplete");
    vi.advanceTimersByTime(4400);
    expect(states).not.toContain("idle");
    vi.advanceTimersByTime(200);
    expect(states, "the floor was never released").toContain("idle");
    expect(s._turnState).toBe("idle");
  });

  it("goes idle immediately when nothing is queued", () => {
    /*
     * The normal case must not acquire a timer. Before the model stopped
     * sending turnComplete this was every close, and it still is whenever
     * playback has already drained.
     */
    const { s, states } = makeSession(sandbox, 0);
    s._closeTurn("turnComplete");
    expect(states).toEqual(["idle"]);
  });

  it("a new turn cancels the pending release", () => {
    /*
     * Otherwise the timer fires later and announces idle in the MIDDLE of the
     * next turn — the same wrong claim, in the opposite direction.
     */
    const { s, states } = makeSession(sandbox, 4500);
    s._closeTurn("generationComplete");
    s._setTurnState("speaking");          // the next turn begins
    vi.advanceTimersByTime(10000);
    expect(states, "a deferred idle fired during the following turn")
      .not.toContain("idle");
    expect(s._turnState).toBe("speaking");
  });

  it("the release is capped, so a bad reading cannot pin 'speaking' forever", () => {
    /*
     * remainingMs is derived from an AudioContext clock. If that ever returns
     * something absurd, holding the floor indefinitely would be a worse failure
     * than releasing it early — the session would never accept another answer.
     */
    const { s, states } = makeSession(sandbox, 10 * 60 * 1000);
    s._closeTurn("generationComplete");
    vi.advanceTimersByTime(21000);
    expect(states, "the cap did not release the floor").toContain("idle");
  });

  /*
   * ── The seam this fix nearly broke ────────────────────────────────────────
   *
   * The ~10-minute handover renews at a TURN BOUNDARY, never mid-turn:
   * _maybeRenewOnGoAway() returns early while the state is speaking/thinking
   * and re-enters from onTurnState('idle'). So 'idle' is not only a UI signal —
   * it is the starting gun for the handover.
   *
   * Holding the floor moves that gun 3-9s later (the live figures). The goAway
   * grace observed in the traces is 8000ms. Deferring blindly would therefore
   * have pushed most mid-turn goAways past their own deadline and converted a
   * graceful handover into a server-cut one — trading a known defect for a
   * quieter one, which is the worst kind of fix.
   */
  it("a pending goAway shortens the hold rather than missing the handover", () => {
    const { s, states } = makeSession(sandbox, 9000);   // 9s of audio queued
    s._goAwayDeadlineAt = Date.now() + 8000;            // 8s of grace
    s._closeTurn("generationComplete");
    expect(states, "released the floor instead of holding the shortened window")
      .not.toContain("idle");
    /* 8000ms of grace minus the 1500ms a handover costs = a 6500ms hold. */
    vi.advanceTimersByTime(6400);
    expect(states, "released early — the rest of the sentence was lost for nothing")
      .not.toContain("idle");
    vi.advanceTimersByTime(200);
    expect(states, "held past the goAway deadline — the handover would be a server cut")
      .toContain("idle");
  });

  it("goes idle at once when the goAway leaves no room at all", () => {
    /*
     * A goAway arriving with under GOAWAY_HANDOVER_COST_MS left. The last
     * second of a sentence is cheaper to lose than the whole handover.
     */
    const { s, states } = makeSession(sandbox, 9000);
    s._goAwayDeadlineAt = Date.now() + 1000;
    s._closeTurn("generationComplete");
    expect(states).toEqual(["idle"]);
  });

  it("no goAway pending means the audio alone decides", () => {
    const { s, states } = makeSession(sandbox, 4500);
    s._goAwayDeadlineAt = null;
    s._closeTurn("generationComplete");
    vi.advanceTimersByTime(4600);
    expect(states).toContain("idle");
  });

  it("usage is banked and the run ended immediately, not deferred", () => {
    /*
     * Only the STATE transition waits. Deferring the accounting would lose a
     * turn's tokens if the session ended inside the window.
     */
    let banked = 0, ended = 0;
    const { s } = makeSession(sandbox, 4500);
    s._bankTurnUsage = () => { banked++; };
    s.queue.endRun = () => { ended++; };
    s._closeTurn("generationComplete");
    expect(banked).toBe(1);
    expect(ended).toBe(1);
    expect(s._turnText).toBe("");
  });
});

describe("v5.34.101 — the rig can now reproduce production", () => {
  const harness = readFileSync(join(root, "deploy", "voice-record.mjs"), "utf8");

  it("the offline stub can emit generationComplete with no turnComplete", () => {
    /*
     * The reason this defect survived: every offline run sent turnComplete, so
     * `salvaged turns` was 0 on the rig and 11 in production, and the rig was
     * testing a world that had stopped existing.
     */
    /*
     * And it is the DEFAULT, not a flag someone has to remember. It shipped
     * opt-in and that was wrong: the rig's default must be the world the
     * product actually runs in, or it goes on passing while production fails.
     */
    expect(harness, "production-shaped turns are opt-in again — the rig will drift from production")
      .toMatch(/const OFFLINE_PROD_TURNS = !has\("offline-legacy-turns"\)/);
    /*
     * Behaviour, not shape. This asserted the exact text of the burst block and
     * broke when v5.34.106 added the barge-in ordering to it, while the
     * behaviour under test was unchanged — the second time an over-specified
     * probe in this file has failed a correct source. What matters is that the
     * burst branch ends a turn with generationComplete.
     */
    const burstBranch = /const burst = OFFLINE_PROD_TURNS;[\s\S]*?\n      \} else \{/.exec(harness);
    expect(burstBranch, "the burst branch moved — update this test").toBeTruthy();
    expect(burstBranch![0], "the burst path no longer ends its turn with generationComplete")
      .toMatch(/generationComplete: true/);
  });

  it("and bursts the audio, so a real playback backlog builds", () => {
    // Pacing the audio in real time is what kept stillQueuedSec at zero.
    expect(harness).toMatch(/if \(burst\) setTimeout\(emit, 5\); else setTimeout\(emit, \(o \/ OUT_RATE\) \* 1000\);/);
  });
});

describe("v5.34.101 — playback exposes how much is left to hear", () => {
  it("remainingMs is read before endRun clears it", () => {
    /*
     * endRun() zeroes _lastEnd, which is what remainingMs is computed from.
     * Reading after it would return 0 every time and silently restore the old
     * behaviour while every test above still passed.
     */
    /*
     * Both needles are anchored on `queue.` — the prose above the read says
     * "Read BEFORE endRun()", and a bare `endRun(` matches that comment at a
     * lower index than the call it is describing, which fails this on a
     * correct source. The assertion is about two CALLS, so match calls.
     */
    const close = /_closeTurn = function \(why\) \{[\s\S]*?\n  \};/.exec(src)![0];
    const iRead = close.indexOf("queue.remainingMs()");
    const iEnd = close.indexOf("queue.endRun(");
    expect(iRead).toBeGreaterThan(-1);
    expect(iEnd).toBeGreaterThan(-1);
    expect(iRead, "remainingMs is read after endRun() has already cleared it").toBeLessThan(iEnd);
  });

  /*
   * Added because a mutation survived.
   *
   * Deleting the line that RECORDS the goAway deadline left all three goAway
   * tests green, because each of them assigns _goAwayDeadlineAt by hand. The
   * guard was tested; the wire feeding it was not — a correct component
   * connected to nothing, which is the shape of nearly every defect found in
   * this codebase. The frame handler lives inside the socket's onmessage
   * closure and cannot be lifted out, so this reads the source.
   */
  it("the goAway frame handler actually populates the deadline", () => {
    const block = /if \(msg && msg\.goAway\) \{[\s\S]*?\n        \}/.exec(src);
    expect(block, "the goAway frame handler moved — update this test").toBeTruthy();
    expect(block![0], "the deadline is never recorded, so the guard above can never fire")
      .toMatch(/_goAwayDeadlineAt\s*=\s*ms\s*\?/);
  });

  it("a flush zeroes it, so a barge-in frees the floor at once", () => {
    // Pause, barge-in and stop all reach flush(). The audio is stopped, so
    // waiting out speech that will never be heard would hold the floor for
    // nothing.
    const flush = /PlaybackQueue\.prototype\.flush = function \(\) \{[\s\S]*?\n  \};/.exec(src)![0];
    expect(flush).toMatch(/this\._lastEnd = 0;/);
  });
});
