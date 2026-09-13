/**
 * v5.34.33 — a 90–120 minute deep-dive interview, driven with no human.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Every failure in this saga so far was found by a person conducting a real
 * interview, noticing the exact minute it broke, and pasting a console log.
 * That costs an hour per data point and cannot be repeated often enough to be
 * useful — and the interesting failures are now at ten, twenty, eighty
 * minutes, which no one can sit through more than once.
 *
 * So the clock is the thing that gets faked, not the code. This drives the
 * SHIPPED frontend modules through a full two-hour interview in a couple of
 * seconds: twelve Google `goAway` handovers, the grant requests they mint, the
 * resumption handles they carry, the utterances in between, and the replies.
 * Nothing about the transport is re-implemented — the assertions are on what
 * reached the wire and on whether the interview was still alive at the end.
 *
 * ── What it can and cannot prove ────────────────────────────────────────────
 *
 * It proves OUR side: that a two-hour interview is not cut off by a renewal
 * ceiling, a concurrency guard, a lost resumption handle, or a handover that
 * lands mid-sentence. It cannot prove Google's side — how fast the real model
 * answers at minute 90, whether its own context holds — because the socket
 * here is a fake. `deploy/soak-live.mjs` is the unattended companion that
 * answers those against the real API.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const FE = (p: string) => readFileSync(join(__dirname, "..", "..", "frontend", p), "utf8");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Grant = Record<string, unknown>;

/**
 * One interview, one page, a fake Google on the other end of the socket.
 *
 * The fake is deliberately faithful about the things that have actually
 * broken: it only ever issues a resumption handle after a turn completes, it
 * sends `goAway` before dropping a connection, and it refuses to accept audio
 * before setupComplete.
 */
function makeInterviewWorld(opts: { maxConcurrent?: number; openWindowSeconds?: number } = {}) {
  const grants: Grant[] = [];
  const closes: Grant[] = [];
  const sockets: any[] = [];
  const processors: any[] = [];
  const log: string[] = [];
  /**
   * Two sets, because admitLiveSession reads two different things: the CAP
   * counts holds still open (TASK_HOLD minus TASK_HOLD_RELEASE), while the
   * renewal exemption looks for a TASK_HOLD row this user owns inside the
   * window — which a released hold still has. Collapsing them would make the
   * fake reject continuations the real server admits.
   */
  const holds = new Set<string>();
  const issued = new Set<string>();
  const refusals: string[] = [];
  const scorings: any[] = [];
  const maxConcurrent = opts.maxConcurrent ?? 3;

  let sessionSeq = 0;

  class FakeWebSocket {
    static OPEN = 1;
    url: string; readyState = 0; binaryType = "";
    onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
    sent: any[] = [];
    dead = false;
    constructor(url: string) {
      this.url = url; sockets.push(this);
      setTimeout(() => {
        this.readyState = 1; this.onopen && this.onopen();
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) }), 1);
      }, 1);
    }
    send(d: string) { try { this.sent.push(JSON.parse(d)); } catch { this.sent.push(d); } }
    close() { this.readyState = 3; }
    frame(sc: any) { if (!this.dead) this.onmessage?.({ data: JSON.stringify({ serverContent: sc }) }); }
    /** A whole model turn: thought summary, audio, transcript, completion. */
    reply(text = "And what did that change in practice?") {
      this.frame({ outputTranscription: { text } });
      this.frame({ modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAAAAAAAAA=" } }] } });
      this.frame({ generationComplete: true });
      this.frame({ turnComplete: true });
      // Google issues a resumable handle at turn boundaries, not continuously.
      this.onmessage?.({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "h" + sockets.indexOf(this), resumable: true } }) });
    }
    heard(text: string) { this.frame({ inputTranscription: { text } }); }
    goAway(ms = 8000) { this.onmessage?.({ data: JSON.stringify({ goAway: { timeLeft: ms / 1000 + "s" } }) }); }
    /** The connection Google actually drops after its ~10-minute lifetime. */
    drop(code = 1011, reason = "connection lifetime exceeded") {
      this.dead = true; this.readyState = 3;
      this.onclose && this.onclose({ code, reason });
    }
  }

  const ctx = () => ({
    state: "running", sampleRate: 16000, currentTime: 0,
    resume: async () => {}, close: () => {},
    createMediaStreamSource: () => ({ connect() {} }),
    createScriptProcessor: () => { const n = { connect() {}, disconnect() {}, onaudioprocess: null }; processors.push(n); return n; },
    createGain: () => ({ gain: { value: 0 }, connect() {} }),
    createBuffer: (_ch: number, len: number, rate: number) => ({ getChannelData: () => new Float32Array(len), duration: len / rate }),
    createBufferSource: () => ({ buffer: null, connect() {}, start() {}, stop() {}, onended: null }),
    destination: {},
  });

  const win: any = {
    WebSocket: FakeWebSocket,
    AudioContext: function () { return ctx(); },
    navigator: { mediaDevices: { getUserMedia: async () => ({
      getTracks: () => [], getAudioTracks: () => [{ readyState: "live", muted: false, enabled: true, label: "Fake Mic", getSettings: () => ({ sampleRate: 48000 }) }],
    }) } },
    /**
     * Stands in for OUR API: mints grants and accepts closes, and enforces the
     * same concurrency rule routes/voice.ts + metering.admitLiveSession do —
     * including the v5.34.33 exemption for a verified continuation. This is
     * where the "died at the fourth handover" bug lived, so the fake has to be
     * able to reproduce it.
     */
    fetch: async (url: string, init: any) => {
      const body = init && init.body ? JSON.parse(init.body) : {};
      /* The per-turn scoring pass goes to the gateway, not the voice route.
       * Answering it properly matters: it is the one call that runs on the
       * app's OWN token during an interview, so it is where a dead session
       * shows up first. */
      if (String(url).indexOf("/api/llm/generate") !== -1) {
        scorings.push(body);
        return { ok: true, json: async () => ({
          text: '{"scores":{"D1":3,"D2":0,"D3":4,"D4":0,"D5":0,"D6":0,"D7":0},"questionsAsked":1}' }) };
      }
      if (String(url).endsWith("/close")) {
        closes.push(body);
        holds.delete(String(body.sessionId));
        return { ok: true, json: async () => ({}) };
      }
      const isRenewal = !!body.renewalOf && issued.has(String(body.renewalOf));
      if (!isRenewal && holds.size >= maxConcurrent) {
        refusals.push("too_many_live_sessions");
        return { ok: false, status: 429, json: async () => ({ error: "too_many_live_sessions" }) };
      }
      const sessionId = "s" + ++sessionSeq;
      holds.add(sessionId); issued.add(sessionId);
      const grant = {
        token: "tok" + sessionSeq, model: "models/gemini-3.1-flash-live-preview",
        voice: "Sadaltager", pinned: true, maxSeconds: 900, sessionId,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        thinkingBudget: 0,
        pinnedExtras: { transcription: true, manualVad: false, resumption: true,
                        compression: { triggerTokens: 25600, slidingWindow: { targetTokens: 12800 } },
                        resumed: !!body.resumeHandle },
        _req: body,
      };
      grants.push(grant);
      return { ok: true, json: async () => grant };
    },
    console: { ...console, log: (...a: any[]) => { log.push(a.map(String).join(" ")); } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    TextDecoder,
    localStorage: { _s: {} as any, getItem(k: string) { return this._s[k] ?? null; }, setItem(k: string, v: string) { this._s[k] = v; }, removeItem(k: string) { delete this._s[k]; } },
    // Handovers are driven explicitly here, so the timers only need to be short.
    VYNE_OPEN_RETRY_MS: 5000,
    VYNE_MIC_SILENT_WARN_MS: 600000,
    VYNE_REPLY_WATCHDOG_MS: 600000,
    VYNE_IGNORED_WATCHDOG_MS: 600000,
    VYNE_UTTERANCE_GAP_MS: 30,
    VYNE_EXPIRY_LEAD_MS: 5,
    // vyne-client.js is not loaded here; the scoring pass only needs its parser.
    vyneParseJson: (t: string) => { try { return JSON.parse(t); } catch { return null; } },
    vyneAuthHeaders: () => ({ "content-type": "application/json", authorization: "Bearer t" }),
  };
  win.window = win; win.self = win;
  const c = vm.createContext(win);
  vm.runInContext(FE("vyne-live.js"), c, { filename: "vyne-live.js" });
  vm.runInContext(FE("vyne-live-interview.js"), c, { filename: "vyne-live-interview.js" });

  return { win, grants, closes, sockets, processors, holds, issued, refusals, scorings,
           trace: () => String(win.vyneLiveLogDump()), log };
}

function speechFrame(n = 2048, amp = 0.3) {
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = Math.sin(i / 7) * amp;
  return f;
}
const silentFrame = (n = 2048) => new Float32Array(n);

function feed(w: ReturnType<typeof makeInterviewWorld>, frame: Float32Array, times = 1) {
  const node = w.processors[w.processors.length - 1];
  for (let i = 0; i < times; i++) node.onaudioprocess({ inputBuffer: { getChannelData: () => frame } });
}

/** Holds from earlier sessions whose /close never landed (a page that
 *  navigated away mid-interview), still inside the rolling window. */
function strand(w: { holds: Set<string>; issued: Set<string> }, n: number) {
  for (let i = 1; i <= n; i++) { w.holds.add("stranded-" + i); w.issued.add("stranded-" + i); }
}

/** The live socket right now — the one the interview is actually using. */
const live = (w: ReturnType<typeof makeInterviewWorld>) => w.sockets[w.sockets.length - 1];

/**
 * One question-and-answer exchange: the interviewee speaks, the model
 * transcribes and answers. Returns when the reply has landed.
 */
async function exchange(w: ReturnType<typeof makeInterviewWorld>, answer: string) {
  feed(w, speechFrame(), 6);              // ~0.8 s of speech-level uplink
  live(w).heard(answer);
  feed(w, silentFrame(), 2);
  await wait(2);
  live(w).reply();
  await wait(2);
}

/**
 * The ~10-minute Google handover, as it really happens: goAway first, the
 * client renews at a turn boundary, the old connection drops.
 */
async function handover(w: ReturnType<typeof makeInterviewWorld>) {
  const before = w.sockets.length;
  const old = live(w);
  old.goAway();
  await wait(60);                          // the client's quiet-gap poll
  if (w.sockets.length === before) {       // not yet handed over — let it settle
    feed(w, silentFrame(), 2);
    await wait(400);
  }
  old.drop();
  await wait(40);
  return w.sockets.length > before;
}

describe("v5.34.33 — a two-hour deep-dive interview survives on its own", () => {
  it("runs 12 handovers and 36 exchanges without the live path ever giving up", async () => {
    const w = makeInterviewWorld();
    const ended: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onEnded: (r: string) => ended.push(r) });
    await LI.start();
    await wait(10);

    // 120 minutes ≈ 12 Google connection lifetimes, three exchanges each.
    const HANDOVERS = 12;
    for (let h = 0; h < HANDOVERS; h++) {
      for (let q = 0; q < 3; q++) await exchange(w, `answer ${h}.${q} about our data platform`);
      const handed = await handover(w);
      expect(handed, `handover ${h + 1} never opened a new connection`).toBe(true);
      expect(LI.stopped, `interview died at handover ${h + 1}`).toBe(false);
    }
    // Still working after the last handover: one more full exchange.
    await exchange(w, "a final thought on governance");

    expect(ended).toEqual([]);                       // never reported as over
    expect(LI.stopped).toBe(false);
    expect(w.refusals).toEqual([]);                  // never refused by our cap
    expect(w.grants.length).toBe(HANDOVERS + 1);     // one per connection
    expect(w.sockets.length).toBe(HANDOVERS + 1);
    expect(LI.renewals).toBe(HANDOVERS);
    expect(LI.elapsedMinutes()).toBeGreaterThanOrEqual(0);
    // The conversation is one thread, not thirteen: every renewal carried the
    // previous connection's handle, so the model keeps the whole interview.
    const renewalGrants = w.grants.slice(1);
    expect(renewalGrants.every((g: any) => !!g._req.resumeHandle)).toBe(true);
    expect(renewalGrants.every((g: any) => g.pinnedExtras.resumed === true)).toBe(true);
    // …and the transcript accumulated across all of them.
    expect(LI.turns.length).toBeGreaterThan(HANDOVERS * 3);
    LI.stop("finished");
  }, 30000);

  it("the OLD 8-renewal ceiling would have ended it ~80 minutes in", async () => {
    // The regression this guards: a count-based ceiling is a duration limit in
    // disguise. With the ceiling at 8, handover 9 ends the interview.
    const w = makeInterviewWorld();
    const ended: string[] = [];
    w.win.VYNE_MAX_RENEWALS = 8;
    const c2 = vm.createContext(w.win);
    vm.runInContext(FE("vyne-live-interview.js"), c2, { filename: "vyne-live-interview.js" });
    const LI = w.win.vyneLiveInterview.create({ onEnded: (r: string) => ended.push(r) });
    await LI.start(); await wait(10);
    for (let h = 0; h < 9; h++) { await exchange(w, "answer " + h); await handover(w); }
    expect(LI.renewals).toBe(8);
    expect(LI.stopped).toBe(true);                   // …which is the bug, pinned
    LI.stop("finished");
  }, 30000);

  it("a handover is never refused by our own concurrency guard, even at cap", async () => {
    /*
     * The state that actually killed an interview at ten minutes: earlier test
     * sessions whose /close never landed (the page had navigated away on a
     * 401), so their holds sit in the window until it rolls. The handover then
     * asks for a grant and is refused by our own counter.
     *
     * Note the ordering that normally saves us: the handover closes the old
     * connection BEFORE minting, so its own hold is already released. The cap
     * is only reached when OTHER holds are stranded — hence three here.
     */
    const w = makeInterviewWorld({ maxConcurrent: 3 });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    strand(w, 3);                                    // the window fills up
    expect(w.holds.size).toBe(4);
    await exchange(w, "we centralised reporting last year");
    const handed = await handover(w);                // the fourth grant
    expect(handed).toBe(true);
    expect(w.refusals).toEqual([]);
    expect(LI.stopped).toBe(false);
    // The continuation named the session it continues, which is what earns the
    // exemption server-side.
    expect((w.grants[1] as any)._req.renewalOf).toBe((w.grants[0] as any).sessionId);
    if (process.env.SOAK_DEBUG) console.log(w.trace().split("\n").filter((l) => /renew|goAway|grant|REFUSED|closed:|handover/.test(l)).join("\n"));
    LI.stop("finished");
  }, 20000);

  it("without renewalOf the same handover IS refused — the exemption is doing the work", async () => {
    const w = makeInterviewWorld({ maxConcurrent: 3 });
    const ended: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onEnded: (r: string) => ended.push(r) });
    await LI.start(); await wait(10);
    strand(w, 3);
    LI._lastSessionId = null;                        // pre-5.34.33 behaviour
    await exchange(w, "an answer");
    await handover(w);
    await wait(20);
    expect(w.refusals).toEqual(["too_many_live_sessions"]);
    expect(ended).toContain("renew_failed");   // …the interview dies here
    expect(w.trace()).toMatch(/REFUSED BY OUR OWN CAP/);
  }, 20000);

  it("every handover closes the connection it replaces, so holds do not accumulate", async () => {
    const w = makeInterviewWorld();
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    for (let h = 0; h < 5; h++) { await exchange(w, "answer " + h); await handover(w); }
    if (process.env.SOAK_DEBUG) console.log(w.trace().split("\n").filter((l) => /renewing|goAway|grant minted|REFUSED|closed:|handover|renewed|NOT renewing/.test(l)).join("\n"));
    // One live hold at a time: five closed, one open.
    expect(w.closes.length).toBe(5);
    expect(w.holds.size).toBe(1);
    LI.stop("finished");
    await wait(5);
    expect(w.holds.size).toBe(0);
  }, 20000);
});
