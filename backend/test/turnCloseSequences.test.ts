/**
 * Every ordering of the frames a turn can be made of. (v5.34.109)
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Between v5.34.101 and v5.34.108 the turn-close path was changed six times,
 * and every defect was found by the NEXT change rather than by the tests
 * written for the last one:
 *
 *   .101 held the floor         -> broke the salvage timer's "a closed turn is
 *                                  not closeable" assumption, which nothing
 *                                  stated and no test covered
 *   .105 notified the app       -> made that breakage expensive: double
 *                                  transcript, double scoring call
 *   .106 guarded the double close -> too broad (swallowed real turns), then
 *                                  reopened on trailing transcript
 *   .108 fixed the window       -> the window had been reasoned, not measured;
 *                                  production trails 2.9s to 10.8s, not "a
 *                                  second or two"
 *
 * Each fix was tested against the sequence that had just been observed. The
 * bugs lived in the sequences nobody had thought to write down — and they were
 * all INTERACTIONS, never a single feature misbehaving.
 *
 * So this file does not test a sequence. It enumerates them: every ordering of
 * the frames a live turn is made of, driven through the real vyne-live.js and
 * the real vyne-live-interview.js, checked against invariants that hold no
 * matter what the model sends.
 *
 * ── The invariants ──────────────────────────────────────────────────────────
 *
 * A "turn" is a run of model content (audio or thinking-text) that gets closed.
 * For every such turn, whatever order the frames arrive in:
 *
 *   I1  the app is told exactly once
 *   I2  the turn's usage is banked exactly once
 *
 * I1 failing high means the interviewer's words enter the transcript twice and
 * a second paid scoring call is spent; failing low means a question is lost
 * from the transcript entirely and never scored. I2 failing high over-bills the
 * client, failing low under-bills them. All four are real money or real wrong
 * answers, so the oracle is the product's meaning, not this session's fixes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const FE = (f: string) => readFileSync(join(root, "frontend", f), "utf8");

/** A live session wired to fake sockets and audio, as close to the page as a test gets. */
function makeWorld(overrides: Record<string, unknown> = {}) {
  const sockets: any[] = [];
  class FakeWebSocket {
    static OPEN = 1;
    url: string; readyState = 0; binaryType = "";
    onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
    constructor(url: string) {
      this.url = url; sockets.push(this);
      setTimeout(() => {
        this.readyState = 1; this.onopen && this.onopen();
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) }), 1);
      }, 1);
    }
    send() {}
    close() { this.readyState = 3; }
    frame(sc: any) { this.onmessage?.({ data: JSON.stringify({ serverContent: sc }) }); }
  }
  const ctx = () => ({
    state: "running", sampleRate: 16000, currentTime: 0,
    resume: async () => {}, close: () => {},
    createMediaStreamSource: () => ({ connect() {} }),
    createScriptProcessor: () => ({ connect() {}, disconnect() {}, onaudioprocess: null }),
    createGain: () => ({ gain: { value: 0 }, connect() {} }),
    createBuffer: (_c: number, len: number, rate: number) =>
      ({ getChannelData: () => new Float32Array(len), duration: len / rate }),
    createBufferSource: () => ({ buffer: null, connect() {}, start() {}, stop() {}, onended: null }),
    destination: {},
  });
  const win: any = {
    WebSocket: FakeWebSocket,
    AudioContext: function () { return ctx(); },
    navigator: { mediaDevices: { getUserMedia: async () => ({
      getTracks: () => [],
      getAudioTracks: () => [{ readyState: "live", muted: false, enabled: true, label: "m", getSettings: () => ({ sampleRate: 48000 }) }],
    }) } },
    fetch: async () => ({ ok: true, json: async () => ({
      token: "tok", model: "gemini-2.5-flash-native-audio-latest", voice: "Kore",
      pinned: true, maxSeconds: 900, sessionId: "s1" }) }),
    console: { ...console, log: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    TextDecoder,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    /* Fast, so hundreds of orderings run in seconds. The behaviour under test
     * is the ordering, not the delay. */
    VYNE_TURN_CLOSE_GRACE_MS: 15,
    VYNE_OPEN_RETRY_MS: 5000,
    VYNE_REPLY_WATCHDOG_MS: 5000,
    VYNE_MIC_SILENT_WARN_MS: 5000,
    ...overrides,
  };
  win.window = win; win.self = win;
  const c = vm.createContext(win);
  vm.runInContext(FE("vyne-live.js"), c, { filename: "vyne-live.js" });
  return { win, sockets };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* The frame alphabet a turn is built from. */
type Ev = "audio" | "think" | "gen" | "tc";
const ALPHABET: Ev[] = ["audio", "think", "gen", "tc"];

function emit(sock: any, e: Ev) {
  if (e === "audio") sock.frame({ modelTurn: { parts: [{ inlineData: {
    mimeType: "audio/pcm;rate=24000", data: "AAAAAAAAAAA=" } }] } });
  else if (e === "think") sock.frame({ modelTurn: { parts: [{ text: "considering" }] } });
  else if (e === "gen") sock.frame({ generationComplete: true });
  else sock.frame({ turnComplete: true });
}

/** Usage arrives in its own frame, and is what makes usage.turns countable. */
function sendUsage(sock: any) {
  sock.onmessage({ data: JSON.stringify({ usageMetadata: { promptTokenCount: 10, responseTokenCount: 5 } }) });
}

/**
 * What SHOULD happen, derived from the sequence alone.
 *
 * Deliberately independent of how vyne-live.js works: content makes a turn
 * live, a close ends it, and a close with no live turn is a duplicate that
 * must produce nothing. Written this way so the oracle cannot drift into
 * simply restating the implementation.
 */
function expectedNotices(seq: Ev[]): number {
  let live = false, turns = 0;
  for (const e of seq) {
    if (e === "audio" || e === "think") live = true;
    else if (live) { turns++; live = false; }
  }
  return turns;
}
/*
 * NOTE on spacing, learned the hard way while writing this file.
 *
 * The first version fired frames 4ms apart against a 15ms salvage grace, and
 * reported dozens of failures that were the ORACLE's fault, not the product's:
 * content arriving after generationComplete DISARMS the salvage, correctly,
 * because the model plainly had not finished. A gen followed 4ms later by
 * audio is not a turn boundary at all.
 *
 * Frames are therefore spaced wider than the grace, so each generationComplete
 * resolves — into a close, or into nothing — before the next frame lands, and
 * "a close ends the live turn" is true as written above. An oracle that has to
 * model the product's timers is an oracle that will drift into restating them.
 */

/** Every sequence of the given length over the alphabet. */
function sequences(len: number): Ev[][] {
  let out: Ev[][] = [[]];
  for (let i = 0; i < len; i++) {
    const next: Ev[][] = [];
    for (const s of out) for (const a of ALPHABET) next.push([...s, a]);
    out = next;
  }
  return out;
}

async function run(seq: Ev[]) {
  const w = makeWorld();
  let notices = 0;
  const s = new w.win.vyneLive.Session({ onTurnComplete: () => { notices++; } });
  const p = s.start();
  await wait(12);
  await p;
  const sock = w.sockets[0];
  for (const e of seq) {
    if (e === "audio" || e === "think") sendUsage(sock);
    emit(sock, e);
    await wait(40);            // wider than the 15ms salvage grace; see the note above
  }
  await wait(60);
  return { notices, banked: s.usage.turns || 0 };
}

describe("v5.34.109 — one notice per turn, in every ordering", () => {
  it("holds across all 256 four-frame sequences", async () => {
    const failures: string[] = [];
    for (const seq of sequences(4)) {
      const want = expectedNotices(seq);
      const { notices, banked } = await run(seq);
      if (notices !== want) {
        failures.push(`${seq.join(",")}: app told ${notices}x, should be ${want}x`);
      } else if (banked !== want) {
        failures.push(`${seq.join(",")}: usage banked ${banked}x, should be ${want}x`);
      }
      if (failures.length >= 8) break;   // enough to diagnose; don't print 256
    }
    expect(failures, `sequences where a turn was announced or billed the wrong number of times:\n  ${failures.join("\n  ")}`)
      .toEqual([]);
  }, 120_000);

  it("holds across five-frame sequences containing a salvage", async () => {
    /*
     * Length five, filtered to the ones that actually arm the salvage, which
     * is where every defect of the last two days has lived. Filtering keeps
     * the run short without narrowing to sequences already known to be safe.
     */
    const interesting = sequences(5).filter((s) => s.includes("gen"));
    const failures: string[] = [];
    for (const seq of interesting) {
      const want = expectedNotices(seq);
      const { notices, banked } = await run(seq);
      if (notices !== want) failures.push(`${seq.join(",")}: app told ${notices}x, should be ${want}x`);
      else if (banked !== want) failures.push(`${seq.join(",")}: usage banked ${banked}x, should be ${want}x`);
      if (failures.length >= 8) break;
    }
    expect(failures, `sequences where a turn was announced or billed the wrong number of times:\n  ${failures.join("\n  ")}`)
      .toEqual([]);
  }, 300_000);
});

describe("v5.34.109 — trailing transcript vs a text-only reply", () => {
  /*
   * The enumeration above cannot reach this: its alphabet has no transcript
   * event, and adding one needs an oracle that models when transcript counts —
   * which is the rule itself, so the test would only restate the code.
   *
   * These two drive the real session through the two sequences that actually
   * differ, and assert the discrimination directly. Both were wrong in earlier
   * versions, in opposite directions:
   *
   *   v5.34.106 counted transcript always -> six turns closed twice, because
   *             it trails a finished turn word by word
   *   v5.34.109 first counted it never    -> a text-only reply, which produces
   *             nothing else at all, lost its close entirely
   *
   * What separates them is that the INTERVIEWEE HAS SPOKEN. Nothing has been
   * said since a turn the model was merely finishing; a new turn exists only
   * because an answer came back.
   */
  async function world() {
    const w = makeWorld();
    const s = new w.win.vyneLive.Session({ onTurnComplete: () => {} });
    const p = s.start();
    await wait(12);
    await p;
    return { w, s, sock: w.sockets[0] };
  }

  it("transcript trailing a closed turn is NOT a new turn", async () => {
    const { s, sock } = await world();
    emit(sock, "audio"); await wait(30);
    emit(sock, "gen");   await wait(50);          // salvage closes the turn
    sock.frame({ outputTranscription: { text: "...the tail." } });
    await wait(20);
    expect(s._contentSinceClose,
      "trailing transcript was read as a new turn — the late close that follows it " +
      "will close the same turn a second time")
      .toBeFalsy();
  });

  it("a text-only reply still gets its close, via the mute-turn rescue", () => {
    /*
     * v5.34.110: transcript no longer marks a turn live — it trails a finished
     * one, and gating it on the interviewee having spoken failed because this
     * model's turnComplete lands up to 8.5s late, inside the next exchange.
     *
     * So a mute turn is recognised where it CAN be told from a duplicate: at
     * the close, by having transcript and no audio. A duplicate close has
     * neither, because _closeTurn clears _turnText.
     */
    const close = /_closeTurn = function \(why\) \{[\s\S]*?_contentSinceClose = false;/.exec(
      readFileSync(join(root, "frontend", "vyne-live.js"), "utf8"));
    expect(close, "the close guard moved — update this test").toBeTruthy();
    expect(close![0]).toMatch(/var muteTurn = !this\._turnAudio && !!this\._turnText;/);
    expect(close![0], "the mute-turn rescue is computed but not used in the guard")
      .toMatch(/!this\._contentSinceClose && !muteTurn/);
  });

  it("an answer alone is not a turn — the model still has to reply", async () => {
    /* Otherwise a close arriving on its own after an answer would be honoured. */
    const { s, sock } = await world();
    emit(sock, "audio"); await wait(30);
    emit(sock, "gen");   await wait(50);
    sock.frame({ inputTranscription: { text: "We use Snowflake." } });
    await wait(20);
    expect(s._contentSinceClose).toBeFalsy();
  });
});

describe("v5.34.109 — the answer flag belongs to one turn, not the session", () => {
  /*
   * Added because a mutation survived: deleting the line that clears
   * _userSpokeSinceClose at close broke nothing above. Every test there
   * exercises the FIRST exchange, where the flag starts false anyway.
   *
   * Left uncleared it latches: after any answer, all trailing transcript for
   * the rest of the interview reads as a new turn, and the v5.34.106
   * double-close comes back on every turn from the second onward — the exact
   * defect production showed on 11 turns of 11.
   */
  it("trailing transcript after a LATER turn is still not a new turn", async () => {
    const w = makeWorld();
    const s = new w.win.vyneLive.Session({ onTurnComplete: () => {} });
    const p = s.start(); await wait(12); await p;
    const sock = w.sockets[0];

    emit(sock, "audio"); await wait(30);
    emit(sock, "gen");   await wait(50);                       // turn 1 closes
    sock.frame({ inputTranscription: { text: "We use Snowflake." } });
    await wait(10);
    emit(sock, "audio"); await wait(30);                       // turn 2 speaks
    emit(sock, "gen");   await wait(50);                       // turn 2 closes

    sock.frame({ outputTranscription: { text: "...the tail." } });
    await wait(20);
    expect(s._contentSinceClose,
      "the answer flag latched: trailing transcript now reads as a new turn on every " +
      "turn after the first answer, which is the double close on 11 turns of 11")
      .toBeFalsy();
  });
});

/**
 * ── v5.34.111: the alphabet gains a handover ────────────────────────────────
 *
 * The enumeration above has four events and stops when the frames stop. Real
 * connections do not stop when the frames stop; they are TORN DOWN, roughly
 * every ten minutes, by a goAway followed by a renewal. That is the one event
 * this file was explicitly documented as not covering, and it is where the
 * only turn-transport defect left in the product turned out to live: the
 * turn-close notice was drained by the arrival of the NEXT frame, and at a
 * handover there is no next frame.
 *
 * So: the same oracle, the same orderings, with the connection actually ending
 * at the end — which is what every connection does. A turn that happened must
 * have been announced by the time the socket is gone, or it is lost for good.
 */
describe("v5.34.111 — every turn survives the connection ending", () => {
  type HEv = Ev | "goaway";
  const HANDOVER_ALPHABET: HEv[] = ["audio", "think", "gen", "tc", "goaway"];

  /* goAway is not content and not a close, so the oracle is unchanged. */
  const expectedH = (seq: HEv[]) => expectedNotices(seq.filter((e) => e !== "goaway") as Ev[]);

  function hsequences(len: number): HEv[][] {
    let out: HEv[][] = [[]];
    for (let i = 0; i < len; i++) {
      const next: HEv[][] = [];
      for (const s of out) for (const a of HANDOVER_ALPHABET) next.push([...s, a]);
      out = next;
    }
    return out;
  }

  /**
   * Run the sequence, then end the connection the way a handover does.
   *
   * `stop('renewal')` is exactly what LiveInterview._openSession does to the
   * outgoing session once the replacement is up, so this is the real teardown
   * rather than a simulation of one.
   */
  async function runToTeardown(seq: HEv[]) {
    const w = makeWorld();
    let notices = 0;
    const s = new w.win.vyneLive.Session({ onTurnComplete: () => { notices++; } });
    const p = s.start();
    await wait(12);
    await p;
    const sock = w.sockets[0];
    for (const e of seq) {
      if (e === "goaway") {
        sock.onmessage({ data: JSON.stringify({ goAway: { timeLeft: "4s" } }) });
      } else {
        if (e === "audio" || e === "think") sendUsage(sock);
        emit(sock, e);
      }
      await wait(40);
    }
    await wait(60);
    s.stop("renewal");
    await wait(20);
    return { notices, banked: s.usage.turns || 0 };
  }

  it("announces every turn across all 625 four-event sequences ending in a teardown", async () => {
    const failures: string[] = [];
    for (const seq of hsequences(4)) {
      const want = expectedH(seq);
      const { notices } = await runToTeardown(seq);
      if (notices !== want) {
        failures.push(`${seq.join(",")}: app told ${notices}x, should be ${want}x`);
      }
      if (failures.length >= 8) break;
    }
    expect(
      failures,
      "turns the app was never told about, or was told about twice, when the connection ended:\n  " +
        failures.join("\n  "),
    ).toEqual([]);
  }, 300_000);

  it("the last turn before a goAway is never lost", async () => {
    /*
     * The narrowest statement of the defect, kept separate from the sweep so a
     * failure reads as one sentence rather than a list of orderings.
     *
     * Before the fix: the turn closed, the notice was raised, the floor hold
     * ran out, the renewal tore the socket down, and onTurnComplete never ran
     * — so the interviewer's last question never reached the transcript and
     * the next mint's "already asked" list did not contain it.
     */
    const { notices } = await runToTeardown(["audio", "tc", "goaway"]);
    expect(notices, "the turn before the handover was thrown away").toBe(1);
  }, 60_000);

  it("a goAway arriving mid-turn still yields exactly one notice", async () => {
    const { notices } = await runToTeardown(["audio", "goaway", "tc"]);
    expect(notices).toBe(1);
  }, 60_000);

  it("a teardown with no turn in flight announces nothing", async () => {
    const { notices } = await runToTeardown(["goaway"]);
    expect(notices).toBe(0);
  }, 60_000);

  it("a salvaged turn cut short by a handover is still announced once", async () => {
    const { notices } = await runToTeardown(["audio", "gen", "goaway"]);
    expect(notices).toBe(1);
  }, 60_000);

  it("stopping twice does not announce the turn twice", async () => {
    /*
     * The renewal path can re-enter stop() — ws.onclose calls it on our behalf
     * after we have called it ourselves. The drain must be idempotent across
     * that, not just within one call.
     */
    const w = makeWorld();
    let notices = 0;
    const s = new w.win.vyneLive.Session({ onTurnComplete: () => { notices++; } });
    const p = s.start(); await wait(12); await p;
    const sock = w.sockets[0];
    sendUsage(sock); emit(sock, "audio"); await wait(40);
    emit(sock, "tc"); await wait(40);
    s.stop("renewal");
    s.stop("closed:1011");
    await wait(20);
    expect(notices).toBe(1);
  }, 60_000);
});
