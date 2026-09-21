/**
 * The turn-close notice does not depend on traffic arriving. (v5.34.111)
 *
 * ── A theory, and the test that killed it ───────────────────────────────────
 *
 * This file was written to prove that a ~10-minute handover throws away the
 * turn before it. The reasoning looked sound. v5.34.105 made the app's
 * turn-close notice DEFERRED: `_closeTurn` raises `_turnNeedsNotify` and
 * `_drainTurnCompleteNotice` delivers it, and it was drained in exactly two
 * places — the generationComplete salvage timer, and the socket frame handler,
 * i.e. "when the next frame arrives". A handover is engineered to happen when
 * no next frame is coming: `_maybeRenewOnGoAway` waits for the turn state to
 * reach 'idle' before renewing. So the last turn of every connection looked
 * like it should be lost, taking _flushPending(), onTurns() and _score() with
 * it — which would have explained repeats and blank spaces after minute ten
 * exactly.
 *
 * It is not what happens, and the 625-sequence handover enumeration added to
 * turnCloseSequences.test.ts is what established that. With BOTH drain sites
 * added here removed again, it stayed green. The reason: `_closeTurn` has only
 * two callers — the salvage timer, which drains immediately after it, and
 * `_noteModelActivity`, which runs inside the frame handler, which drains at
 * the end of THAT SAME handler. A turn closed by a turnComplete frame is
 * announced by that frame's own handler, before anything can tear the
 * connection down.
 *
 * The theory was wrong. Chasing where it was wrong is what found the real
 * defect — the one early return that skips the drain — and that lives in
 * pausedTurnIsNotResurrected.test.ts, not here.
 *
 * ── What this file is now ───────────────────────────────────────────────────
 *
 * The drain sites were kept, because the property they buy is worth having on
 * its own: a turn that has closed is announced because the TURN ENDED, not
 * because more traffic happened to arrive afterwards. Two sites —
 *
 *   · the floor-hold timer, which is the deterministic end of the turn; and
 *   · stop(), for a connection that dies with a notice outstanding
 *
 * — and `_drainTurnCompleteNotice` was already idempotent, which is what makes
 * adding them safe. These tests pin that property. They are a guard against a
 * future change to the frame handler quietly making the original theory TRUE,
 * which is a real risk: it was one early return away from being true already.
 *
 * Read honestly, the tests below assert defence in depth rather than a bug
 * fixed. That is worth saying plainly, because a file that claims to have
 * fixed something it did not is worse than no file at all.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const src = readFileSync(join(root, "frontend", "vyne-live.js"), "utf8");

/** The real turn methods, lifted out of the IIFE — no DOM, no sockets. */
function load() {
  const grab = (name: string) => {
    const re = new RegExp(
      `VyneLiveSession\\.prototype\\.${name} = function \\([\\s\\S]*?\\n  \\};`, "m");
    const m = re.exec(src);
    expect(m, `${name} moved or changed shape — update this test`).toBeTruthy();
    return m![0].replace(`VyneLiveSession.prototype.${name} =`, `proto.${name} =`);
  };
  const consts = /var IDLE_DEFER_MIN_MS[\s\S]*?var GOAWAY_HANDOVER_COST_MS = \d+;/.exec(src);
  expect(consts, "the turn-close constants moved — update this test").toBeTruthy();
  const sandbox: any = { console, setTimeout, clearTimeout, Date, Math, proto: {}, vlog: () => {} };
  vm.createContext(sandbox);
  vm.runInContext(
    [consts![0],
     grab("_drainTurnCompleteNotice"),
     grab("_clearIdleDefer"),
     grab("_closeTurn"),
     grab("_setTurnState")].join("\n"),
    sandbox, { filename: "vyne-live-turn-methods" },
  );
  return sandbox;
}

/**
 * A session whose playback still has audio to drain, so `_closeTurn` takes the
 * FLOOR HOLD path rather than going straight to idle. That is the path a real
 * turn takes, and the one the handover lands in.
 */
function session(sandbox: any, opts: { remainingMs?: number; goAwayInMs?: number } = {}) {
  const notices: string[] = [];
  const states: string[] = [];
  const remainingMs = opts.remainingMs ?? 3000;
  const s: any = {
    _turnState: "speaking",
    _contentSinceClose: true,
    _turnAudio: true,
    _turnText: "so who signs off on that?",
    queue: { remainingMs: () => remainingMs, pending: () => 1, endRun: () => {} },
    opts: {
      onTurnState: (x: string) => states.push(x),
      onTurnComplete: () => notices.push("turn"),
    },
    _bankTurnUsage: () => {},
    _goAwayDeadlineAt: opts.goAwayInMs ? Date.now() + opts.goAwayInMs : null,
    _drainTurnCompleteNotice: sandbox.proto._drainTurnCompleteNotice,
    _clearIdleDefer: sandbox.proto._clearIdleDefer,
    _closeTurn: sandbox.proto._closeTurn,
    _setTurnState: sandbox.proto._setTurnState,
  };
  return { s, notices, states };
}

describe("v5.34.111 — the last turn of a connection reaches the app", () => {
  let sandbox: any;
  beforeEach(() => { vi.useFakeTimers(); sandbox = load(); });

  it("delivers the notice when the floor hold releases, with no further frames", () => {
    /*
     * The property, stated directly: the turn ended, so the app is told. Not
     * "the turn ended and then a frame happened to arrive, so the app is told".
     * In the shipping product the frame handler usually gets here first; this
     * asserts the floor-hold timer would have, on its own.
     */
    const { s, notices } = session(sandbox, { remainingMs: 3000 });
    s._closeTurn("turnComplete");
    expect(notices.length, "the floor is still held — nothing owed yet").toBe(0);
    vi.advanceTimersByTime(3000);
    expect(
      notices.length,
      "the turn ended and nothing announced it — delivery is back to depending on traffic",
    ).toBe(1);
  });

  it("delivers it for a salvaged close too", () => {
    const { s, notices } = session(sandbox, { remainingMs: 2000 });
    s._closeTurn("generationComplete");
    vi.advanceTimersByTime(2000);
    expect(notices.length).toBe(1);
  });

  it("delivers exactly once when a frame also arrives", () => {
    /*
     * Both drain sites now fire for the same turn in the common case. Twice
     * would double-score the turn and push the interviewer's words into the
     * transcript twice — the failure v5.34.105 was careful to avoid, and the
     * reason the drain is idempotent rather than an inline call.
     */
    const { s, notices } = session(sandbox, { remainingMs: 1000 });
    s._closeTurn("turnComplete");
    s._drainTurnCompleteNotice();          // the frame handler gets there first
    vi.advanceTimersByTime(1000);          // then the floor hold releases
    expect(notices.length).toBe(1);
  });

  it("a close with no floor hold is still owed, and the frame handler pays it", () => {
    /*
     * remainingMs below IDLE_DEFER_MIN_MS — the turn goes straight to idle and
     * no timer is armed, so there is no deferred drain to rely on. This is the
     * one path that still depends on the frame handler, which runs immediately
     * after _closeTurn within the same handler. The notice must be RAISED and
     * not delivered inline: v5.34.105 put it behind a flag precisely so that
     * onAgentText commits the turn's last words to the transcript first.
     */
    const { s, notices } = session(sandbox, { remainingMs: 0 });
    s._closeTurn("turnComplete");
    expect(notices.length, "delivered inline — _flushPending would miss the last words").toBe(0);
    expect(s._turnNeedsNotify, "the turn closed and nothing is owed").toBe(true);
    s._drainTurnCompleteNotice();          // what the frame handler does next
    expect(notices.length).toBe(1);
  });

  it("a connection dying with a notice pending still pays it (the stop() path)", () => {
    /*
     * The guarantee stop() provides, exercised through the same lifted methods:
     * a turn closed, no frame came, and the drain at teardown is what delivers.
     */
    const { s, notices } = session(sandbox, { remainingMs: 0 });
    s._closeTurn("turnComplete");
    expect(notices.length).toBe(0);
    s._drainTurnCompleteNotice();          // stop() now does exactly this
    expect(notices.length).toBe(1);
    s._drainTurnCompleteNotice();          // and a later frame must not repeat it
    expect(notices.length).toBe(1);
  });

  it("delivers under a goAway that shortens the hold", () => {
    /*
     * The actual handover shape: goAway has landed, the floor hold is cut
     * short to leave room for the renewal, and the turn ends early. The notice
     * must still be delivered before the connection is torn down.
     */
    const { s, notices } = session(sandbox, { remainingMs: 8000, goAwayInMs: 4000 });
    s._closeTurn("turnComplete");
    vi.advanceTimersByTime(8000);
    expect(notices.length).toBe(1);
  });

  it("does not deliver a notice for a turn that never closed", () => {
    const { s, notices } = session(sandbox, { remainingMs: 3000 });
    vi.advanceTimersByTime(60_000);
    expect(notices.length).toBe(0);
  });

  it("two turns across a hold deliver two notices, in order", () => {
    const { s, notices } = session(sandbox, { remainingMs: 1500 });
    s._closeTurn("turnComplete");
    vi.advanceTimersByTime(1500);
    // A new turn begins: content since the last close is what makes it one.
    s._turnState = "speaking";
    s._contentSinceClose = true;
    s._turnAudio = true;
    s._closeTurn("turnComplete");
    vi.advanceTimersByTime(1500);
    expect(notices.length).toBe(2);
  });

  it("a superseded hold does not deliver twice", () => {
    /*
     * The floor-hold timer belongs to the turn that scheduled it (v5.34.101).
     * If a new turn starts first, the old timer must not fire a second notice
     * for a turn already reported.
     */
    const { s, notices } = session(sandbox, { remainingMs: 5000 });
    s._closeTurn("turnComplete");
    s._setTurnState("thinking");           // a new turn interrupts the hold
    vi.advanceTimersByTime(5000);
    expect(notices.length).toBeLessThanOrEqual(1);
  });
});

describe("v5.34.111 — a dying connection does not swallow a pending notice", () => {
  /*
   * stop() is the last chance. It cannot be lifted out of the IIFE the way the
   * turn methods can — it closes AudioContexts, stops MediaStream tracks and
   * posts the usage reconciliation — so this is asserted against the source.
   *
   * Two properties, both of which matter:
   *   · stop() drains at all; and
   *   · it drains BEFORE the teardown that clears the state onTurnComplete
   *     reads (the queue flush and _turnCloseTimer clear).
   */
  const stopBody = () => {
    const m = /VyneLiveSession\.prototype\.stop = function \(reason\) \{[\s\S]*?\n  \};/.exec(src);
    expect(m, "stop() moved — update this test").toBeTruthy();
    return m![0];
  };

  it("stop() drains the pending turn notice", () => {
    expect(
      stopBody(),
      "stop() tears the connection down without telling the app the last turn ended",
    ).toMatch(/_drainTurnCompleteNotice\(\)/);
  });

  it("it drains before the playback queue is flushed", () => {
    const body = stopBody();
    const drain = body.indexOf("_drainTurnCompleteNotice()");
    const flush = body.indexOf("this.queue.flush()");
    expect(drain).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(-1);
    expect(drain, "the notice is drained after the turn's state was torn down")
      .toBeLessThan(flush);
  });

  it("the drain is still idempotent, so the extra sites cannot double-fire", () => {
    const m = /VyneLiveSession\.prototype\._drainTurnCompleteNotice = function \(\) \{[\s\S]*?\n  \};/.exec(src);
    expect(m).toBeTruthy();
    expect(m![0]).toMatch(/if \(!this\._turnNeedsNotify\) return;/);
    expect(m![0]).toMatch(/this\._turnNeedsNotify = false;/);
  });
});

describe("v5.34.111 — the renewal is what makes this reachable", () => {
  const interview = readFileSync(join(root, "frontend", "vyne-live-interview.js"), "utf8");

  it("the renewal still waits for an idle turn state", () => {
    /*
     * Not a thing to change — it is why the handover lands in the gap. Pinned
     * so that if it ever stops waiting, whoever changes it reads this file and
     * knows the notice ordering depended on it.
     */
    expect(interview).toMatch(/if \(s === 'idle' && self\._goAwayPending\) self\._maybeRenewOnGoAway\(\)/);
  });

  it("onTurnComplete still does the three things a dropped notice costs", () => {
    const m = /onTurnComplete: function \(\) \{[\s\S]*?\n      \},/.exec(interview);
    expect(m, "onTurnComplete moved — update this test").toBeTruthy();
    expect(m![0]).toMatch(/_flushPending\(\)/);
    expect(m![0]).toMatch(/onTurns/);
    expect(m![0]).toMatch(/_score\(\)/);
  });
});
