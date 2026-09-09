/**
 * v5.34.18 — the opening turn must REACH THE WIRE on a clean auto-start.
 *
 * Why this test loads the real files instead of modelling them:
 *
 * resilientOpenRetry.test.ts models open() faithfully and passes — and the
 * production interview was silent anyway, because the model it builds starts
 * from `session` ALREADY ATTACHED. The bug lived entirely in the moment before
 * that: vyne-live.js dispatches onReady synchronously from the setupComplete
 * frame, which is before the promise chain that assigns LiveInterview.session
 * has run, so open()'s `if (!this.session) return;` fired and nothing was sent.
 * A hand-written model of open() cannot see that, because the ordering it gets
 * wrong belongs to the caller.
 *
 * So this evaluates frontend/vyne-live.js and frontend/vyne-live-interview.js
 * as shipped, against a fake socket that reproduces Google's frame order, and
 * asserts on BYTES SENT. The assertion is the one the interviewee cares about:
 * did a clientContent turn carrying the opening actually leave the browser.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const FE = (p: string) => readFileSync(join(__dirname, "..", "..", "frontend", p), "utf8");

/** Frames the fake socket received, as parsed objects. */
type Sent = any[];

function makeSandbox(sent: Sent) {
  const sockets: any[] = [];
  void sockets;

  class FakeWebSocket {
    static OPEN = 1;
    url: string;
    readyState = 0;
    binaryType = "";
    onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
      // Google's real order: handshake, then setupComplete a beat later. Both
      // land as separate macrotasks, exactly as they do over a network.
      setTimeout(() => {
        this.readyState = 1;
        this.onopen && this.onopen();
        setTimeout(() => {
          this.onmessage && this.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
        }, 1);
      }, 1);
    }
    send(data: string) { try { sent.push(JSON.parse(data)); } catch { sent.push(data); } }
    close() { this.readyState = 3; }
    /** A model-reasoning frame: modelTurn text, no audio. */
    think(text = "Formulating Opening Questions") {
      this.onmessage?.({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ text }] } } }) });
    }
    /** A spoken frame. */
    speak(b64 = "AAAA") {
      this.onmessage?.({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [
        { inlineData: { mimeType: "audio/pcm;rate=24000", data: b64 } },
      ] } } }) });
    }
  }

  const audioCtx = () => ({
    state: "running", sampleRate: 16000, currentTime: 0,
    resume: async () => {}, close: () => {},
    createMediaStreamSource: () => ({ connect() {} }),
    createScriptProcessor: () => ({ connect() {}, disconnect() {}, onaudioprocess: null }),
    createGain: () => ({ gain: { value: 0 }, connect() {} }),
    // Must be correctly SIZED: PlaybackQueue copies the decoded PCM into this
    // channel, and a zero-length stub throws "offset is out of bounds" —
    // failing the test for a reason that has nothing to do with the code.
    createBuffer: (_ch: number, len: number, rate: number) => ({
      getChannelData: () => new Float32Array(len),
      duration: len / rate,
    }),
    createBufferSource: () => ({ buffer: null, connect() {}, start() {}, stop() {}, onended: null }),
    destination: {},
  });

  const win: any = {
    WebSocket: FakeWebSocket,
    AudioContext: function () { return audioCtx(); },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        token: "tok", model: "gemini-2.5-flash-native-audio-latest",
        voice: "Kore", pinned: true, maxSeconds: 900, sessionId: "s1",
      }),
    }),
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    TextDecoder,
    // Keep the trace quiet; the assertions are on the wire, not the log.
    VYNE_LIVE_DEBUG: false,
    // Shrink the 12s resend window so the retry policy is actually exercised
    // rather than merely out-waited.
    VYNE_OPEN_RETRY_MS: 30,
  };
  win.window = win;
  win.self = win;

  const ctx = vm.createContext(win);
  vm.runInContext(FE("vyne-live.js"), ctx, { filename: "vyne-live.js" });
  vm.runInContext(FE("vyne-live-interview.js"), ctx, { filename: "vyne-live-interview.js" });
  return { win, sockets };
}

/** The opening text, as it appears on a clientContent turn. */
function openingsOnWire(sent: Sent, line: string) {
  return sent.filter((f) => {
    const t = f?.clientContent?.turns?.[0]?.parts?.[0]?.text;
    return typeof t === "string" && t === line;
  });
}

const OPENING = "Please begin the interview now.";
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe("opening reaches the wire on auto-start", () => {
  let sent: Sent;
  let win: any;

  let sockets: any[];
  beforeEach(() => { sent = []; const sb = makeSandbox(sent); win = sb.win; sockets = sb.sockets; });

  /**
   * This is the production sequence, reproduced exactly: interview_agent.html
   * opens from inside onReady and records whether the opening was dispatched.
   * Before v5.34.18 this sent NOTHING — the whole bug, in one assertion.
   */
  it("sends the opening when open() is called from onReady (the auto-start path)", async () => {
    let openingSent = false;
    const LIVE = win.vyneLiveInterview.create({
      state: {},
      onReady: function () {
        if (!LIVE._openingSent) {
          openingSent = LIVE.open(OPENING) !== false;
          LIVE._openingSent = openingSent;
        }
      },
    });
    await LIVE.start();
    await settle();

    expect(openingsOnWire(sent, OPENING).length).toBeGreaterThanOrEqual(1);
    expect(openingSent).toBe(true);
  });

  /** The guard that silently ate the opening: session must be attached by then. */
  it("has session attached by the time onReady fires", async () => {
    let hadSessionInOnReady: boolean | null = null;
    const LIVE = win.vyneLiveInterview.create({
      state: {},
      onReady: function () { hadSessionInOnReady = !!LIVE.session; },
    });
    await LIVE.start();
    await settle();
    expect(hadSessionInOnReady).toBe(true);
  });

  /** open() must report what it did, so the caller's backstop stays armed. */
  it("open() returns false when it could not send, so the backstop still runs", async () => {
    const LIVE = win.vyneLiveInterview.create({ state: {} });
    expect(LIVE.open(OPENING)).toBe(false);   // no session at all yet
    await settle();
    expect(openingsOnWire(sent, OPENING).length).toBe(0);
  });

  /** The exact production shape: onReady opens, and .then() must not double-send. */
  it("does not send the opening twice when the backstop also runs", async () => {
    const LIVE = win.vyneLiveInterview.create({
      state: {},
      onReady: function () {
        if (!LIVE._openingSent) LIVE._openingSent = LIVE.open(OPENING) !== false;
      },
    });
    await LIVE.start().then(() => {
      if (!LIVE._openingSent) LIVE._openingSent = LIVE.open(OPENING) !== false;
    });
    // Deliberately INSIDE the resend window: this case is about the backstop not
    // duplicating the opening, not about the silence rescue (covered separately).
    await settle(15);
    expect(openingsOnWire(sent, OPENING).length).toBe(1);
  });

  /** Warmup retry still works: no agent frame -> resend, capped. */
  it("retries the opening while the agent stays silent", async () => {
    const LIVE = win.vyneLiveInterview.create({
      state: {},
      onReady: function () { LIVE.open(OPENING); },
    });
    await LIVE.start();
    await settle(20);
    const first = openingsOnWire(sent, OPENING).length;
    expect(first).toBe(1);
    // The retry cadence is 3s; assert the timer is armed rather than waiting.
    expect(LIVE._openRetry).toBeTruthy();
    expect(LIVE.session._gotAgentFrame).toBe(false);
  });

  /**
   * v5.34.19 — THE RETRY MUST NOT INTERRUPT A THINKING MODEL.
   *
   * This is the regression that shipped as a fix. A native-audio model reasons
   * in text for ten to twenty seconds before an opening; the old liveness check
   * looked only at audio and output transcript, saw neither, and resent the
   * opening four times. Each resend restarted the model's reasoning, so the
   * retry added to cure a silent opening was the thing prolonging it.
   */
  it("does NOT resend while the model is reasoning in text", async () => {
    const LIVE = win.vyneLiveInterview.create({
      state: {},
      onReady: function () { LIVE.open(OPENING); },
    });
    await LIVE.start();
    await settle(20);
    expect(openingsOnWire(sent, OPENING).length).toBe(1);

    // The model starts thinking — text frames, no audio, exactly as observed.
    sockets[0].think("Initiating the Interview Process");
    sockets[0].think("Formulating Opening Questions");

    // Well past several resend deadlines. A thinking model must be left alone.
    await settle(200);
    expect(LIVE.session._gotAnyModelFrame).toBe(true);
    expect(openingsOnWire(sent, OPENING).length).toBe(1);
  });

  it("stops retrying for good once the agent actually speaks", async () => {
    const LIVE = win.vyneLiveInterview.create({
      state: {},
      onReady: function () { LIVE.open(OPENING); },
    });
    await LIVE.start();
    await settle(20);
    sockets[0].speak();
    await settle(80);
    expect(LIVE.session._gotAgentFrame).toBe(true);
    expect(openingsOnWire(sent, OPENING).length).toBe(1);
  });

  /** Thinking text is not speech: it must never reach the transcript. */
  it("keeps model reasoning out of the transcript and out of scoring", async () => {
    const partials: string[] = [];
    const thoughts: string[] = [];
    const LIVE = win.vyneLiveInterview.create({
      state: {},
      onPartialAgent: (t: string) => partials.push(t),
      onAgentThinking: (t: string) => thoughts.push(t),
      onReady: function () { LIVE.open(OPENING); },
    });
    await LIVE.start();
    await settle(20);
    sockets[0].think("Restarting the Introduction");
    await settle(20);

    expect(thoughts.join(" ")).toContain("Restarting the Introduction");
    expect(partials.join(" ")).not.toContain("Restarting the Introduction");
    expect(LIVE.turns.length).toBe(0);
    expect(LIVE.transcriptText()).toBe("");
  });

  /** The UI needs one edge to hang the "preparing" message on. */
  it("signals speaking exactly once, on the first audio frame", async () => {
    let speaking = 0;
    const LIVE = win.vyneLiveInterview.create({
      state: {},
      onAgentSpeaking: () => { speaking++; },
      onReady: function () { LIVE.open(OPENING); },
    });
    await LIVE.start();
    await settle(20);
    sockets[0].think();
    expect(speaking).toBe(0);          // thinking is not speaking
    sockets[0].speak();
    sockets[0].speak();
    await settle(20);
    expect(speaking).toBe(1);
  });

  /** The genuine warmup drop is still rescued — once. */
  it("resends exactly once into total silence, never more", async () => {
    const LIVE = win.vyneLiveInterview.create({
      state: {},
      onReady: function () { LIVE.open(OPENING); },
    });
    await LIVE.start();
    await settle(300);                 // ~10 resend windows
    // Exactly one rescue, then it stops for good — the old policy sent 4 and
    // would have kept the pattern going for as long as the cap allowed.
    expect(openingsOnWire(sent, OPENING).length).toBe(2);
  });

  /**
   * v5.34.20 — a talkative agent must not push the interesting events out.
   *
   * Reported from a real session: the trace filled with one line per audio
   * frame (~20/second), so by the time the user paused, everything explaining
   * the pause had rolled off the ring. Audio-only frames are now counted and
   * rolled up. This asserts both halves: the flood collapses, AND the event
   * that follows it survives in order.
   */
  it("rolls up audio frames so surrounding events survive the ring", async () => {
    const logged: string[] = [];
    win.console = { ...console, log: (line: string) => { logged.push(String(line)); } };
    win.VYNE_LIVE_DEBUG = true;

    const LIVE = win.vyneLiveInterview.create({
      state: {},
      onReady: function () { LIVE.open(OPENING); },
    });
    await LIVE.start();
    await settle(15);

    for (let i = 0; i < 500; i++) sockets[0].speak();
    // The event that must not be buried.
    sockets[0].onclose?.({ code: 1011, reason: "server went away" });
    await settle(20);

    const audioLines = logged.filter((l) => l.includes("frame AUDIO"));
    expect(audioLines.length).toBeLessThan(20);       // was 500, one per frame
    expect(logged.some((l) => l.includes("ws CLOSE"))).toBe(true);

    // And the ring holds it, which is what the user actually reads back.
    const ring = win.__vyneLiveLog as Array<{ tag: string }>;
    expect(ring.some((e) => e.tag.includes("ws CLOSE"))).toBe(true);
    expect(ring.some((e) => e.tag.includes("session.stop"))).toBe(true);
  });

  /** The capture helpers the operator drives from the console. */
  it("exposes log clear/mark helpers that keep the trace readable", async () => {
    win.VYNE_LIVE_DEBUG = true;
    win.console = { ...console, log: () => {} };
    const LIVE = win.vyneLiveInterview.create({ state: {}, onReady: function () { LIVE.open(OPENING); } });
    await LIVE.start();
    await settle(15);
    expect((win.__vyneLiveLog as unknown[]).length).toBeGreaterThan(1);

    win.vyneLiveLogClear("about to pause");
    win.vyneLiveMark("clicked Pause");
    const ring = win.__vyneLiveLog as Array<{ tag: string }>;
    expect(ring.length).toBe(2);
    expect(ring[0].tag).toContain("log cleared: about to pause");
    expect(ring[1].tag).toContain("MARK: clicked Pause");
  });
});
