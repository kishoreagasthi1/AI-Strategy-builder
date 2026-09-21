/**
 * A page that stopped running knows its connection is stale. (v5.34.112)
 *
 * ── The hole ────────────────────────────────────────────────────────────────
 *
 * When a laptop sleeps or a browser freezes a tab, this page stops dead:
 * timers do not fire, the microphone graph stops, nothing is sent. The socket
 * does NOT close — neither end writes, so it just rots. On waking, the page is
 * holding a WebSocket that looks open and is not.
 *
 * v5.34.44 already made that survivable — `live_socket_error` is renewable,
 * and its comment names this exact case: "the laptop slept at minute five, and
 * on waking the socket was long dead." What it does not do is NOTICE. Recovery
 * waited for the dead socket to admit it was dead, via a failed send, a server
 * reset, or a watchdog. That admission is the expensive part.
 *
 * Measured on the 20-minute 2026-09-15 run: a 30-SECOND drain timeout fired
 * 184 seconds after it was armed, which a running event loop cannot do — the
 * process was frozen. The interviewer's first words after it came 20.3s after
 * the interviewee stopped speaking, the worst latency of the run, of which the
 * renewal itself was 2.6s. The rest was the page not yet knowing.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 *
 * The wall-clock heartbeat: a beat that arrives late by more than the floor did
 * not happen late, it did not happen at all, and the connection is stale by
 * exactly that much. Renew at the wake rather than a sentence later.
 *
 * Verified end-to-end as well as here, by SIGSTOPping a real harness run for
 * 45 seconds: without the detector the page waited for the harness's own
 * 30-second drain timeout; with it, `onError: live_suspended` fired on the
 * instant of resume and the handover completed in 0.1s.
 *
 * NOT claimed: a measured saving against a real rotting TCP socket. The
 * offline harness's socket is a stub and never rots, so the seventeen seconds
 * this is expected to save in production are an inference from the live trace,
 * not something these tests measure.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const src = readFileSync(join(root, "frontend", "vyne-live.js"), "utf8");

/**
 * A world whose clock we control, so a "suspension" is a number rather than a
 * fifteen-second test. Every timer the page arms is registered here and fired
 * by hand.
 */
function makeWorld() {
  const sockets: any[] = [];
  let now = 1_700_000_000_000;
  const intervals: { fn: Function; ms: number; id: number; last: number }[] = [];
  const timeouts: { fn: Function; at: number; id: number }[] = [];
  let nextId = 1;

  class FakeWebSocket {
    static OPEN = 1;
    url: string; readyState = 0; binaryType = "";
    onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
    constructor(url: string) {
      this.url = url; sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1; this.onopen && this.onopen();
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) }));
      });
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

  const FakeDate: any = function () {};
  FakeDate.now = () => now;

  const win: any = {
    WebSocket: FakeWebSocket,
    AudioContext: function () { return ctx(); },
    Date: FakeDate,
    navigator: { mediaDevices: { getUserMedia: async () => ({
      getTracks: () => [],
      getAudioTracks: () => [{ readyState: "live", muted: false, enabled: true, label: "m", getSettings: () => ({ sampleRate: 48000 }) }],
    }) } },
    fetch: async () => ({ ok: true, json: async () => ({
      token: "t", model: "m", voice: "Kore", pinned: true, maxSeconds: 900, sessionId: "s1" }) }),
    console: { ...console, log: () => {} },
    setInterval: (fn: Function, ms: number) => { const id = nextId++; intervals.push({ fn, ms, id, last: now }); return id; },
    clearInterval: (id: number) => { const i = intervals.findIndex((x) => x.id === id); if (i >= 0) intervals.splice(i, 1); },
    setTimeout: (fn: Function, ms: number) => { const id = nextId++; timeouts.push({ fn, at: now + (ms || 0), id }); return id; },
    clearTimeout: (id: number) => { const i = timeouts.findIndex((x) => x.id === id); if (i >= 0) timeouts.splice(i, 1); },
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    TextDecoder,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  win.window = win; win.self = win;
  vm.runInContext(src, vm.createContext(win), { filename: "vyne-live.js" });

  return {
    win, sockets,
    /** Move the clock WITHOUT running anything — the machine was asleep. */
    freeze(ms: number) { now += ms; },
    /** Let every interval whose period has elapsed fire once. */
    beat() {
      for (const iv of [...intervals]) {
        if (now - iv.last >= iv.ms) { iv.last = now; try { iv.fn(); } catch {} }
      }
    },
    /** Normal time: advance in beat-sized steps, running timers as we go. */
    advance(ms: number, step = 1000) {
      for (let i = 0; i < ms; i += step) { now += step; this.beat(); }
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

async function live(onError: (r: string) => void) {
  const w = makeWorld();
  const s = new w.win.vyneLive.Session({ onError: (r: string) => onError(r) });
  const p = s.start();
  await settle(); await settle(); await settle();
  await p;
  return { w, s };
}

describe("v5.34.112 — a suspended page renews instead of waiting", () => {
  it("raises live_suspended when the clock jumps past the floor", async () => {
    const errors: string[] = [];
    const { w } = await live((r) => errors.push(r));
    w.freeze(45_000);          // the laptop slept for 45 seconds
    w.beat();                  // the first beat after waking
    expect(errors, "the page woke holding a dead socket and said nothing").toContain("live_suspended");
  });

  it("does not raise it while time passes normally", async () => {
    /*
     * The false-positive case, and the reason the floor is seconds rather than
     * milliseconds. A watchdog that renews a healthy interview every few
     * minutes is worse than the hole it closes.
     */
    const errors: string[] = [];
    const { w } = await live((r) => errors.push(r));
    w.advance(120_000);        // two minutes of ordinary running time
    expect(errors).not.toContain("live_suspended");
  });

  it("tolerates a gap just under the floor", async () => {
    // A long synchronous task or a GC pause must not end the session.
    const errors: string[] = [];
    const { w } = await live((r) => errors.push(r));
    w.freeze(3_500);
    w.beat();
    expect(errors).not.toContain("live_suspended");
  });

  it("fires once per suspension, not once per beat afterwards", async () => {
    const errors: string[] = [];
    const { w } = await live((r) => errors.push(r));
    w.freeze(60_000);
    w.beat(); w.beat(); w.beat();
    expect(errors.filter((e) => e === "live_suspended").length).toBe(1);
  });

  it("leaves a PAUSED interview alone", async () => {
    /*
     * v5.34.8: a pause mutes the session and lets the grant lapse quietly; the
     * Resume handler reconnects on the user's action. Forcing a renewal here
     * would wake an interview the interviewee deliberately stopped — and a
     * paused interview is precisely when a laptop gets shut.
     */
    const errors: string[] = [];
    const { w, s } = await live((r) => errors.push(r));
    s.setMuted(true);
    w.freeze(120_000);
    w.beat();
    expect(errors, "a paused interview was force-renewed on wake").not.toContain("live_suspended");
  });

  it("stops beating once the session is stopped", async () => {
    const errors: string[] = [];
    const { w, s } = await live((r) => errors.push(r));
    s.stop("done");
    errors.length = 0;
    w.freeze(120_000);
    w.beat();
    expect(errors).not.toContain("live_suspended");
  });
});

describe("v5.34.112 — the reason is one the interview can act on", () => {
  const interview = readFileSync(join(root, "frontend", "vyne-live-interview.js"), "utf8");

  it("live_suspended is renewable", () => {
    /*
     * The whole change is inert otherwise: vyne-live.js would raise a reason
     * that isRenewable() does not recognise, which is the "not renewable" path
     * that ended the live interview outright before v5.34.44.
     */
    const m = /function isRenewable\(reason\)[\s\S]*?\n  \}/.exec(interview);
    expect(m, "isRenewable moved — update this test").toBeTruthy();
    expect(m![0]).toMatch(/'live_suspended'/);
  });

  it("the detector is armed only once the session is actually live", () => {
    // Armed at setupComplete, so the seconds a slow connect legitimately takes
    // cannot read as a suspension.
    const at = src.indexOf("_watchForSuspend()");
    const setup = src.indexOf("setupComplete — session is live");
    expect(at).toBeGreaterThan(-1);
    expect(Math.abs(at - setup)).toBeLessThan(2000);
  });

  it("the floor is well clear of scheduling jitter", () => {
    const m = /var SUSPEND_FLOOR_MS = (\d+);/.exec(src);
    expect(m, "SUSPEND_FLOOR_MS moved — update this test").toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(3000);
  });
});
