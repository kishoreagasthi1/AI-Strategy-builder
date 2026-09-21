/**
 * A turn that ends must TELL the app it ended, however it ended. (v5.34.105)
 *
 * ── What shipped, and what it cost ──────────────────────────────────────────
 *
 * v5.34.75 added a salvage: when generationComplete arrives and turnComplete
 * never follows, close the turn anyway. Its own comment says "the close is the
 * SAME path turnComplete takes, so a salvaged turn and a normal one leave
 * identical state behind" — and for the SESSION that was true. Usage banked,
 * playback run ended, per-turn flags cleared.
 *
 * But the notification the APP acts on was fired somewhere else entirely,
 * straight off the frame in the socket handler:
 *
 *     if (f.turnComplete && self.opts.onTurnComplete) ...
 *
 * and onTurnComplete (vyne-live-interview.js) is where the real work happens:
 *
 *     _flushPending()   commits the interviewer's words to the transcript
 *     onTurns(...)      hands that transcript to the page
 *     _score()          runs the scoring pass
 *
 * A salvaged turn did none of the three, and _closeTurn then cleared
 * _turnText — so the question was not delayed, it was destroyed. Absent from
 * the transcript, absent from the page, never scored, and never registered as
 * asked by the no-repeat machinery that the whole soak exists to test.
 *
 * Invisible while turnComplete was reliable, because the salvage was rare. On
 * 2026-09-14 the model sent 11 generationComplete and 0 turnComplete: every
 * turn in the interview, silently discarded.
 *
 * ── How it was finally caught ───────────────────────────────────────────────
 *
 * Not by a live run. By making the offline rig stop sending turnComplete —
 * which is what production does — at which point the wrapper's stage 3, the
 * check that the harness notices a closed interview, failed immediately. That
 * check reads the product's own onTurns hook, so it fails for exactly this.
 *
 * The lesson is the rig's, and it has been learned twice now: a harness whose
 * default is a world that stopped existing will keep passing while the product
 * fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const src = readFileSync(join(root, "frontend", "vyne-live.js"), "utf8");

/** _closeTurn and _drainTurnCompleteNotice, lifted out of the IIFE. */
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
    `${consts![0]}\n${grab("_drainTurnCompleteNotice")}\n${grab("_closeTurn")}\n${grab("_setTurnState")}`,
    sandbox, { filename: "vyne-live-turn-methods" },
  );
  return sandbox;
}

function session(sandbox: any) {
  const notices: number[] = [];
  const s: any = {
    _turnState: "speaking",
    /* v5.34.109: a close only counts when the model has generated something
     * since the last one. _noteModelActivity sets this on real frames. */
    _contentSinceClose: true,
    queue: { remainingMs: () => 0, pending: () => 0, endRun: () => {} },
    opts: { onTurnState: () => {}, onTurnComplete: () => notices.push(1) },
    _bankTurnUsage: () => {},
    _clearIdleDefer: () => {},
    _drainTurnCompleteNotice: sandbox.proto._drainTurnCompleteNotice,
    _closeTurn: sandbox.proto._closeTurn,
    _setTurnState: sandbox.proto._setTurnState,
  };
  return { s, notices };
}

describe("v5.34.105 — the app is told, however the turn ended", () => {
  let sandbox: any;
  beforeEach(() => { vi.useFakeTimers(); sandbox = load(); });

  it("a salvaged close owes the app a notice", () => {
    /* The defect: this was silent, and the turn's words were then cleared. */
    const { s, notices } = session(sandbox);
    s._closeTurn("generationComplete");
    s._drainTurnCompleteNotice();
    expect(notices.length, "a salvaged turn never reached the app").toBe(1);
  });

  it("a normal close owes it too", () => {
    const { s, notices } = session(sandbox);
    s._closeTurn("turnComplete");
    s._drainTurnCompleteNotice();
    expect(notices.length).toBe(1);
  });

  it("delivers exactly once even when drained repeatedly", () => {
    /*
     * Both the frame handler and the salvage timer drain, and a salvage can
     * close during a frame. Twice would double-score the turn and push the
     * interviewer's words into the transcript twice.
     */
    const { s, notices } = session(sandbox);
    s._closeTurn("generationComplete");
    s._drainTurnCompleteNotice();
    s._drainTurnCompleteNotice();
    s._drainTurnCompleteNotice();
    expect(notices.length).toBe(1);
  });

  it("delivers nothing when no turn has closed", () => {
    const { s, notices } = session(sandbox);
    s._drainTurnCompleteNotice();
    expect(notices.length).toBe(0);
  });

  it("two turns owe two notices", () => {
    /*
     * v5.34.106: the second turn must actually BEGIN. Setting the state back
     * to 'speaking' is not enough and never was a real sequence — the close
     * guard added in .106 is cleared by _noteModelActivity when the model
     * produces new content, and that is what is simulated here. Written
     * without it, this test asserted that the same turn could close twice,
     * which is the defect .106 exists to stop.
     */
    const { s, notices } = session(sandbox);
    s._closeTurn("generationComplete");
    s._drainTurnCompleteNotice();
    s._contentSinceClose = true;         // new content arrived: a new turn
    s._turnState = "speaking";
    s._closeTurn("generationComplete");
    s._drainTurnCompleteNotice();
    expect(notices.length).toBe(2);
  });

  it("a throwing app handler cannot break the session", () => {
    const { s } = session(sandbox);
    s.opts.onTurnComplete = () => { throw new Error("page blew up"); };
    s._closeTurn("turnComplete");
    expect(() => s._drainTurnCompleteNotice()).not.toThrow();
  });
});

describe("v5.34.105 — where the notice is delivered from", () => {
  it("is no longer fired straight off f.turnComplete", () => {
    /*
     * The precise shape of the bug. If this line comes back, salvaged turns go
     * dark again and every test above still passes, because they drive
     * _closeTurn directly and never touch the socket handler.
     */
    /*
     * Anchored at line start so it matches CODE, not the note above the
     * salvage that quotes the old line verbatim. A bare substring search finds
     * the explanation of the bug and reports the bug — which is how a probe
     * fails a correct source, the most expensive kind of test failure.
     */
    expect(src, "onTurnComplete is gated on the frame again — salvaged turns will be dropped")
      .not.toMatch(/^\s*if \(f\.turnComplete && self\.opts\.onTurnComplete\)/m);
  });

  it("is drained after onAgentText, so the transcript has the turn's last words", () => {
    /*
     * Ordering, and the reason the notice is a flag rather than an inline call:
     * _noteModelActivity (which closes the turn) runs EARLIER in the frame
     * handler than onAgentText. Draining before the text would commit a
     * transcript missing the end of the sentence.
     */
    const handler = /if \(f\.userText && self\.opts\.onUserText\)[\s\S]*?_drainTurnCompleteNotice\(\);/.exec(src);
    expect(handler, "the drain no longer follows the text callbacks").toBeTruthy();
    const iText = handler![0].indexOf("onAgentText");
    const iDrain = handler![0].indexOf("_drainTurnCompleteNotice");
    expect(iText).toBeGreaterThan(-1);
    expect(iDrain, "the turn is announced complete before its last words are delivered")
      .toBeGreaterThan(iText);
  });

  it("the salvage timer drains it itself, having no frame to follow", () => {
    const salvage = /if \(f\.generationComplete && !f\.turnComplete && !this\._turnCloseTimer\) \{[\s\S]*?\}, TURN_CLOSE_GRACE_MS\);/.exec(src);
    expect(salvage, "the generationComplete salvage moved — update this test").toBeTruthy();
    expect(salvage![0], "a salvaged turn closes but never notifies the app")
      .toMatch(/_drainTurnCompleteNotice\(\)/);
  });

  it("and onTurnComplete still does the three things that matter", () => {
    /*
     * Stated here so the cost of dropping the notice is legible from this file
     * alone: transcript, page, score.
     */
    const li = readFileSync(join(root, "frontend", "vyne-live-interview.js"), "utf8");
    const hook = /onTurnComplete: function \(\) \{[\s\S]*?\n      \},/.exec(li);
    expect(hook, "the onTurnComplete hook moved — update this test").toBeTruthy();
    expect(hook![0]).toMatch(/_flushPending\(\)/);
    expect(hook![0]).toMatch(/onTurns/);
    expect(hook![0]).toMatch(/_score\(\)/);
  });
});

describe("v5.34.106 — a turn closes once, however many times it is told to", () => {
  /*
   * This is a collision between two fixes made hours apart, and neither one's
   * own tests could have found it.
   *
   * Nothing ever guarded a second close, because nothing needed to: the
   * salvage timer bails unless the state is speaking/thinking, and _closeTurn
   * used to set 'idle' immediately — a closed turn was not closeable.
   *
   * v5.34.101 holds the floor, so the state stays 'speaking' for as long as
   * audio is still playing. A turnComplete arriving late — exactly the
   * flakiness the salvage absorbs — now lands on an already-closed turn. On
   * its own that double-banks usage; with v5.34.105 it also flushes the
   * interviewer's words into the transcript twice and spends a second paid
   * scoring call on the same conversation.
   */
  let sandbox: any;
  beforeEach(() => { vi.useFakeTimers(); sandbox = load(); });

  function counted() {
    const notices: string[] = [];
    let banked = 0;
    const s: any = {
      _turnState: "speaking",
      _contentSinceClose: true,
      queue: { remainingMs: () => 4500, pending: () => 3, endRun: () => {} },
      opts: { onTurnState: () => {}, onTurnComplete: () => notices.push("notice") },
      _bankTurnUsage: () => { banked++; },
      _clearIdleDefer: () => {},
      _drainTurnCompleteNotice: sandbox.proto._drainTurnCompleteNotice,
      _closeTurn: sandbox.proto._closeTurn,
      _setTurnState: sandbox.proto._setTurnState,
    };
    return { s, notices, banked: () => banked };
  }

  it("a late turnComplete after a salvage does not close the turn again", () => {
    const { s, notices, banked } = counted();
    s._closeTurn("generationComplete");   // the salvage
    s._drainTurnCompleteNotice();
    s._closeTurn("turnComplete");         // arrives late, floor still held
    s._drainTurnCompleteNotice();
    expect(notices.length, "the transcript was flushed twice and the turn scored twice").toBe(1);
    expect(banked(), "the turn's usage was banked twice").toBe(1);
  });

  it("the floor hold is what exposes it — the state is still 'speaking' after the close", () => {
    /*
     * Pins the precondition, so that if the deferral is ever removed this test
     * explains why the guard was needed rather than looking redundant.
     */
    const { s } = counted();
    s._closeTurn("generationComplete");
    expect(s._turnState, "the close no longer holds the floor; re-read the v5.34.101 note")
      .toBe("speaking");
  });

  it("a genuinely new turn can close again", () => {
    const { s, notices } = counted();
    s._closeTurn("generationComplete");
    s._drainTurnCompleteNotice();
    s._contentSinceClose = true;          // what _noteModelActivity does on new content
    s._turnState = "speaking";
    s._closeTurn("turnComplete");
    s._drainTurnCompleteNotice();
    expect(notices.length).toBe(2);
  });
});

describe("v5.34.110 — what counts as content", () => {
  /*
   * Source-level: _noteModelActivity cannot be lifted out of the IIFE the way
   * _closeTurn can. What is pinned here is which frames mark a turn as live,
   * because getting that list wrong is what produced the two worst regressions
   * of this whole sequence.
   */
  const contentTest = () => {
    const m = /if \(f\.audio\.length[^\n]*_contentSinceClose = true;/.exec(src);
    expect(m, "the content test moved — update this test").toBeTruthy();
    return m![0];
  };

  it("audio and thinking-text mark a turn as live", () => {
    expect(contentTest()).toMatch(/f\.audio\.length/);
    expect(contentTest()).toMatch(/f\.modelText/);
  });

  it("a usage report does NOT — it is bookkeeping, not generation", () => {
    /*
     * Measured on the live run of 2026-09-15. v5.34.109 counted f.usage so a
     * text-only reply would not lose its close. But parseServerFrame sets
     * usage from ANY frame carrying usageMetadata, and SIXTEEN
     * sessionResumptionUpdate frames sat between each salvage close and the
     * late turnComplete that followed it. Every one re-armed the guard: it
     * never fired once and all 44 turns of 44 closed twice.
     */
    expect(contentTest(), "a usage report counts as content again — resumption frames carry " +
      "usageMetadata and sit in the gap before the late turnComplete, so the duplicate-close " +
      "guard will never fire")
      .not.toMatch(/f\.usage/);
  });

  it("output transcript does NOT either — it trails a finished turn", () => {
    /*
     * v5.34.106 counted it and six turns closed twice. v5.34.109 gated it on
     * the interviewee having spoken, which does not help: this model's
     * turnComplete arrives 2 to 8.5 seconds late, well into the next exchange.
     */
    expect(contentTest(), "output transcript counts as content again — it trails a finished turn")
      .not.toMatch(/agentText/);
  });

  it("and a text-only reply is rescued at the close instead", () => {
    /*
     * Which is where it can be told apart: a mute turn has accumulated
     * transcript and no audio of its own. A duplicate close has neither —
     * _closeTurn clears _turnText, and the measured gap carries no transcript.
     */
    const close = /_closeTurn = function \(why\) \{[\s\S]*?_contentSinceClose = false;/.exec(src);
    expect(close, "the close guard moved — update this test").toBeTruthy();
    expect(close![0], "a text-only reply has no rescue — its close is swallowed as a duplicate " +
      "and its question never reaches the transcript or the scorer")
      .toMatch(/!this\._turnAudio && !!this\._turnText/);
  });
});

describe("v5.34.106 — the guard is scoped to the hazard, not to 'any second close'", () => {
  /*
   * A broader guard — suppress ANY close of an already-closed turn — passed
   * every test written for it and then swallowed the second and third turns of
   * liveTurnOwnership's usage test, which drives turns with bare turnComplete
   * frames. That test exists because a real session reported 367 output tokens
   * for ten minutes of speech: a thirteenfold under-count, because usage was
   * maxed rather than summed. Re-breaking it to fix a duplicate close would
   * have traded a small double-count for a large under-count.
   *
   * So: only a turnComplete landing on a SALVAGED turn is suppressed.
   */
  let sandbox: any;
  beforeEach(() => { vi.useFakeTimers(); sandbox = load(); });

  it("consecutive turnComplete closes are each honoured", () => {
    const notices: string[] = [];
    let banked = 0;
    const s: any = {
      _turnState: "speaking",
      _contentSinceClose: true,
      queue: { remainingMs: () => 0, pending: () => 0, endRun: () => {} },
      opts: { onTurnState: () => {}, onTurnComplete: () => notices.push("n") },
      _bankTurnUsage: () => { banked++; },
      _clearIdleDefer: () => {},
      _drainTurnCompleteNotice: sandbox.proto._drainTurnCompleteNotice,
      _closeTurn: sandbox.proto._closeTurn,
      _setTurnState: sandbox.proto._setTurnState,
    };
    for (let i = 0; i < 3; i++) {
      s._turnState = "speaking";
      s._contentSinceClose = true;        // each turn reported its usage
      s._closeTurn("turnComplete");
      s._drainTurnCompleteNotice();
    }
    expect(banked, "turns driven by bare turnComplete frames stopped banking usage").toBe(3);
    expect(notices.length).toBe(3);
  });
});

describe("v5.34.106 — the rig can produce the shapes production produces", () => {
  /*
   * Three turn shapes now exist offline, and every one of them was added
   * because something it could reach had never been exercised:
   *
   *   default                        generationComplete, no turnComplete
   *                                  -> found v5.34.105 (salvaged turns never
   *                                     reached the app at all)
   *   --offline-late-turn-complete   ...then a LATE turnComplete
   *                                  -> found v5.34.106 (the same turn closing
   *                                     twice once the floor is held)
   *   --offline-mute-replies         transcript, no voice
   *                                  -> found that v5.34.40's mute detection
   *                                     can no longer fire: MUTE_REPLY_MS is
   *                                     6000ms and the salvage closes a silent
   *                                     turn in ~1200ms, clearing the timer
   *   --offline-barge-in             interrupted mid-answer
   *                                  -> first offline exercise of flush(),
   *                                     _turnWasInterrupted, and the mute-timer
   *                                     cancel
   *
   * A mode that quietly disappears takes its findings with it, so their
   * presence is pinned here rather than left to the wrapper.
   */
  const harness = readFileSync(join(root, "deploy", "voice-record.mjs"), "utf8");

  it("offers all three opt-in shapes", () => {
    expect(harness).toMatch(/const OFFLINE_LATE_TURN_COMPLETE = Number\(arg\("offline-late-turn-complete", 0\)\)/);
    expect(harness).toMatch(/const OFFLINE_MUTE_REPLIES = Number\(arg\("offline-mute-replies", 0\)\)/);
    expect(harness).toMatch(/const OFFLINE_BARGE_IN = Number\(arg\("offline-barge-in", 0\)\)/);
  });

  it("keeps them OFF by default, so the common shape stays the default", () => {
    /*
     * The common production case is no turnComplete at all. A rig that made
     * every run a barge-in soak would measure something nobody experiences.
     */
    for (const flag of ["offline-late-turn-complete", "offline-mute-replies", "offline-barge-in"]) {
      expect(harness, `${flag} no longer defaults to off`)
        .toMatch(new RegExp(`arg\\("${flag}", 0\\)`));
    }
  });

  it("audits the invariants rather than leaving numbers to be read by eye", () => {
    /*
     * The floor-hold defect sat in a trace for a release with playbackPending
     * printed beside it. Printing is not checking.
     */
    expect(harness).toMatch(/function auditDoubleCloses/);
    expect(harness).toMatch(/TURN CLOSED TWICE/);
    expect(harness).toMatch(/FLOOR RELEASED EARLY/);
    expect(harness).toMatch(/FLOOR HELD AFTER A BARGE-IN/);
  });

  it("says plainly when a mode produced nothing, instead of printing a clean verdict", () => {
    // A mode that tested nothing must not read as a pass.
    expect(harness).toMatch(/tested nothing|Nothing was tested/);
  });
});
