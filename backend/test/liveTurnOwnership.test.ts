/**
 * v5.34.22 — the live path is the SOLE owner of microphone, playback and turn.
 *
 * These tests run the SHIPPED frontend/vyne-live.js and vyne-live-interview.js
 * in a vm against a fake socket and a fake audio graph that can be DRIVEN:
 * the ScriptProcessor's onaudioprocess is called with real Float32 frames, so
 * what lands on the wire is the real PCM the real code produced. Every earlier
 * "fix" in this saga had a test that modelled the logic and passed while the
 * browser failed; the assertions here are on bytes sent, callbacks fired and
 * trace lines written by the code under test, not on a re-implementation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const FE = (p: string) => readFileSync(join(__dirname, "..", "..", "frontend", p), "utf8");

function makeWorld(overrides: Record<string, unknown> = {}) {
  const sent: any[] = [];
  const log: string[] = [];
  const sockets: any[] = [];
  const processors: any[] = [];

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
    send(d: string) { try { const o = JSON.parse(d); Object.defineProperty(o, "_socket", { value: sockets.indexOf(this) }); sent.push(o); } catch { sent.push(d); } }
    close() { this.readyState = 3; }
    frame(sc: any) { this.onmessage?.({ data: JSON.stringify({ serverContent: sc }) }); }
    think(text = "Considering the answer") { this.frame({ modelTurn: { parts: [{ text }] } }); }
    speak() { this.frame({ modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAAAAAAAAA=" } }] } }); }
    userSaid(t: string) { this.frame({ inputTranscription: { text: t } }); }
    turnComplete() { this.frame({ turnComplete: true }); }
    interrupt() { this.frame({ interrupted: true }); }
  }

  const ctx = () => {
    const c: any = {
      state: "running", sampleRate: 16000, currentTime: 0,
      resume: async () => {}, close: () => {},
      createMediaStreamSource: () => ({ connect() {} }),
      createScriptProcessor: () => { const n = { connect() {}, disconnect() {}, onaudioprocess: null }; processors.push(n); return n; },
      createGain: () => ({ gain: { value: 0 }, connect() {} }),
      createBuffer: (_ch: number, len: number, rate: number) => ({ getChannelData: () => new Float32Array(len), duration: len / rate }),
      createBufferSource: () => ({ buffer: null, connect() {}, start() {}, stop() {}, onended: null }),
      destination: {},
    };
    return c;
  };

  const win: any = {
    WebSocket: FakeWebSocket,
    AudioContext: function () { return ctx(); },
    navigator: { mediaDevices: { getUserMedia: async () => ({
      getTracks: () => [], getAudioTracks: () => [{ readyState: "live", muted: false, enabled: true, label: "Fake Mic", getSettings: () => ({ sampleRate: 48000 }) }],
    }) } },
    fetch: async () => ({ ok: true, json: async () => ({ token: "tok", model: "gemini-2.5-flash-native-audio-latest", voice: "Kore", pinned: true, maxSeconds: 900, sessionId: "s1" }) }),
    console: { ...console, log: (...a: any[]) => { log.push(a.map(String).join(" ")); } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    TextDecoder,
    VYNE_OPEN_RETRY_MS: 30,
    VYNE_MIC_SILENT_WARN_MS: 60,
    VYNE_REPLY_WATCHDOG_MS: 60,
    ...overrides,
  };
  win.window = win; win.self = win;
  const c = vm.createContext(win);
  vm.runInContext(FE("vyne-live.js"), c, { filename: "vyne-live.js" });
  vm.runInContext(FE("vyne-live-interview.js"), c, { filename: "vyne-live-interview.js" });
  const trace = () => String(win.vyneLiveLogDump());
  return { win, sent, sockets, processors, trace, log };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function speechFrame(n = 2048, amp = 0.3) {
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = Math.sin(i / 7) * amp;
  return f;
}
const silentFrame = (n = 2048) => new Float32Array(n);

async function startSession(w: ReturnType<typeof makeWorld>, opts: any = {}) {
  const s = new w.win.vyneLive.Session(opts);
  const p = s.start();
  await wait(10);
  await p;
  return s;
}
function feed(w: ReturnType<typeof makeWorld>, frame: Float32Array, times = 1) {
  const node = w.processors[w.processors.length - 1];
  for (let i = 0; i < times; i++) node.onaudioprocess({ inputBuffer: { getChannelData: () => frame } });
}
const audioFrames = (sent: any[]) => sent.filter((f) => f?.realtimeInput?.audio?.data);
function pcmOf(frame: any): Int16Array {
  const b = Buffer.from(frame.realtimeInput.audio.data, "base64");
  return new Int16Array(b.buffer, b.byteOffset, b.length / 2);
}

describe("uplink level instrumentation (S1: could the model hear anything?)", () => {
  it("speech-level frames reach the wire as non-zero PCM and are logged as SPEECH", async () => {
    const w = makeWorld();
    const levels: number[] = [];
    await startSession(w, { onMicLevel: (r: number) => levels.push(r) });
    feed(w, speechFrame(), 3);
    const a = audioFrames(w.sent);
    expect(a.length).toBe(3);
    const pcm = pcmOf(a[0]);
    expect(pcm.length).toBe(2048);
    expect(Math.max(...Array.from(pcm).map(Math.abs))).toBeGreaterThan(5000);
    expect(w.trace()).toMatch(/mic: SPEECH on uplink/);
    expect(levels.length).toBeGreaterThan(0);
    expect(levels[0]).toBeGreaterThan(w.win.vyneLive._internals.SPEECH_RMS);
  });

  it("a flowing-but-silent uplink is declared SILENT and reported to the app", async () => {
    const w = makeWorld();
    let silent: any = null;
    await startSession(w, { onMicSilent: (i: any) => { silent = i; } });
    feed(w, silentFrame(), 2);
    await wait(80);
    feed(w, silentFrame(), 2);
    expect(audioFrames(w.sent).length).toBe(4);          // frames DID flow —
    expect(w.trace()).toMatch(/mic uplink SILENT/);       // — and said nothing
    expect(silent).toBeTruthy();
    expect(silent.readyState).toBe("live");
  });

  it("does NOT cry silence right after a resume (the silence clock restarts on unmute)", async () => {
    const w = makeWorld();
    let silent = 0;
    const s = await startSession(w, { onMicSilent: () => { silent++; } });
    feed(w, speechFrame(), 1);
    s.setMuted(true);
    await wait(100);           // longer than the silence window, while muted
    s.setMuted(false);
    feed(w, silentFrame(), 1);
    expect(silent).toBe(0);
  });

  it("frameStats is honest about RMS and peak", () => {
    const w = makeWorld();
    const { frameStats } = w.win.vyneLive._internals;
    expect(frameStats(new Float32Array(100))).toEqual({ rms: 0, peak: 0 });
    const st = frameStats(new Float32Array([0.5, -0.5, 0.5, -0.5]));
    expect(st.rms).toBeCloseTo(0.5, 6);
    expect(st.peak).toBe(0.5);
    expect(frameStats(new Float32Array(0)).rms).toBe(0);
  });
});

describe("per-turn reply tracking (S1: did the model answer what it heard?)", () => {
  it("fires onNoReply when a transcribed user turn gets no model activity", async () => {
    const w = makeWorld();
    let noReply = 0;
    await startSession(w, { onNoReply: () => { noReply++; } });
    w.sockets[0].userSaid("we have three data teams");
    await wait(100);
    expect(noReply).toBe(1);
    expect(w.trace()).toMatch(/USER TURN #1/);
    expect(w.trace()).toMatch(/NO MODEL ACTIVITY/);
  });

  it("disarms when the model starts thinking, speaking or completes the turn", async () => {
    const w = makeWorld();
    let noReply = 0;
    await startSession(w, { onNoReply: () => { noReply++; } });
    w.sockets[0].userSaid("we have"); w.sockets[0].userSaid(" three data teams");
    w.sockets[0].think();
    await wait(100);
    expect(noReply).toBe(0);
    expect(w.trace()).toMatch(/model ACTIVITY on user turn #1/);
  });

  it("turn state goes thinking → speaking → idle, and again on the NEXT turn", async () => {
    const w = makeWorld();
    const states: string[] = [];
    await startSession(w, { onTurnState: (s: string) => states.push(s) });
    const ws = w.sockets[0];
    ws.think(); ws.speak(); ws.speak(); ws.turnComplete();
    ws.userSaid("ok"); ws.think(); ws.speak(); ws.turnComplete();
    expect(states).toEqual(["thinking", "speaking", "idle", "thinking", "speaking", "idle"]);
  });

  it("an interruption flushes playback and returns to idle", async () => {
    const w = makeWorld();
    const states: string[] = [];
    const s = await startSession(w, { onTurnState: (st: string) => states.push(st) });
    const ws = w.sockets[0];
    ws.speak(); ws.speak();
    expect(s.queue.pending()).toBe(2);
    ws.interrupt();
    expect(s.queue.pending()).toBe(0);
    expect(states[states.length - 1]).toBe("idle");
    expect(w.trace()).toMatch(/INTERRUPTED — barge-in/);
  });
});

describe("playback instrumentation (S3)", () => {
  it("logs a run start with the context's real rate, and a run end on turnComplete", async () => {
    const w = makeWorld();
    await startSession(w);
    const ws = w.sockets[0];
    ws.speak(); ws.speak(); ws.turnComplete();
    const t = w.trace();
    expect(t).toMatch(/playback run starts/);
    expect(t).toMatch(/playback run ends \(turnComplete\)/);
    expect(t).not.toMatch(/PLAYBACK OVERLAP/);
  });
});

describe("LiveInterview keeps ownership across a renewal", () => {
  it("holds say() while there is no live socket and sends it once the session opens", async () => {
    const w = makeWorld();
    const LI = w.win.vyneLiveInterview.create({});
    expect(LI.say("typed while dead")).toBe(false);
    expect(w.sent.length).toBe(0);
    await LI.start(); await wait(10);
    const typed = w.sent.filter((f) => f?.clientContent?.turns?.[0]?.parts?.[0]?.text === "typed while dead");
    expect(typed.length).toBe(1);
    expect(w.trace()).toMatch(/say\(\) HELD/);
  });

  it("a lapsed socket renews, and a message typed during the gap lands in the NEW session", async () => {
    const w = makeWorld();
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    const first = w.sockets[0];
    // Google closes the connection (~10 min lifetime) — reported via onclose.
    first.readyState = 3; first.onclose({ code: 1011, reason: "lifetime" });
    expect(LI.isAlive()).toBe(false);
    expect(LI.stopped).toBe(false);                      // still OWNS the interview
    expect(LI.say("during the gap")).toBe(false);
    await wait(20);
    expect(w.sockets.length).toBe(2);
    const onSecond = w.sent.filter((f) => f?.clientContent?.turns?.[0]?.parts?.[0]?.text === "during the gap");
    expect(onSecond.length).toBe(1);
    expect(onSecond[0]._socket).toBe(1);                 // the RENEWED socket, not the dead one
    // and the renewal's own "continue where you left off" nudge went first
    const nudge = w.sent.filter((f) => /renewed mid-interview|briefly renewed/.test(f?.clientContent?.turns?.[0]?.parts?.[0]?.text || ""));
    expect(nudge.length).toBe(1);
    expect(nudge[0]._socket).toBe(1);
  });

  it("a failed renewal ENDS the live path (stopped=true) so the page may fall back", async () => {
    const w = makeWorld();
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    w.win.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: "too_many_live_sessions" }) });
    const first = w.sockets[0];
    first.readyState = 3; first.onclose({ code: 1011, reason: "lifetime" });
    await wait(30);
    expect(LI.stopped).toBe(true);
  });

  it("a paused session that lapses is NOT ended — Resume re-mints it", async () => {
    const w = makeWorld();
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    LI.setMuted(true);
    const first = w.sockets[0];
    first.readyState = 3; first.onclose({ code: 1011, reason: "idle" });
    await wait(20);
    expect(LI.stopped).toBe(false);
    expect(w.sockets.length).toBe(1);                    // no renewal while paused
  });

  it("stop('page_unload') is deliberate: no renewal, /close beacon sent", async () => {
    const w = makeWorld();
    const closes: any[] = [];
    w.win.fetch = async (url: string, init: any) => {
      if (String(url).endsWith("/close")) { closes.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; }
      return { ok: true, json: async () => ({ token: "tok", model: "m", voice: "Kore", pinned: true, maxSeconds: 900, sessionId: "s1" }) };
    };
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    LI.stop("page_unload");
    await wait(5);
    expect(LI.stopped).toBe(true);
    expect(w.sockets.length).toBe(1);
    expect(closes.length).toBe(1);
    expect(closes[0].sessionId).toBe("s1");
  });
});

/* ── v5.34.23 ─────────────────────────────────────────────────────────────── */

function makeWorld23(flags: any = {}, extra: Record<string, unknown> = {}) {
  const localStorage = { _s: {} as any, getItem(k: string) { return this._s[k] ?? null; }, setItem(k: string, v: string) { this._s[k] = v; }, removeItem(k: string) { delete this._s[k]; } };
  return makeWorld({
    VYNE_LIVE_FLAGS: flags,
    VYNE_UTTERANCE_GAP_MS: 30,
    VYNE_IGNORED_WATCHDOG_MS: 80,
    VYNE_MIC_SILENT_WARN_MS: 80,
    localStorage,
    ...extra,
  });
}
/**
 * Poll until a condition holds, rather than sleeping and hoping. (v5.34.69)
 *
 * Fails with the caller's own sentence on timeout, so a genuine regression
 * reads as what broke instead of as a bare timeout.
 */
async function waitFor(cond: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out after ${ms}ms waiting: ${what}`);
}

const audioOnly = (sent: any[]) => sent.filter((f) => f?.realtimeInput?.audio);
const rtKeys = (sent: any[]) => sent.filter((f) => f?.realtimeInput).map((f) => Object.keys(f.realtimeInput)[0]);

describe("v5.34.23 — nothing on the uplink before setupComplete", () => {
  it("frames produced between socket OPEN and setupComplete are held, not sent", async () => {
    const w = makeWorld23();
    // A socket that opens but delays setupComplete, so we can feed frames in the gap.
    const Orig = w.win.WebSocket;
    class SlowSetup extends Orig { constructor(url: string) { super(url); } }
    let pending: any = null;
    w.win.WebSocket = function (url: string) {
      const ws: any = new SlowSetup(url);
      const real = ws.onmessage;
      // swallow the automatic setupComplete; release it manually
      setTimeout(() => { pending = ws; }, 0);
      Object.defineProperty(ws, "onmessage", { set(fn) { real; ws._om = fn; }, get() { return (ev: any) => { if (JSON.parse(ev.data).setupComplete && !ws._release) return; ws._om(ev); }; } });
      return ws;
    };
    const s = new w.win.vyneLive.Session({});
    const p = s.start();
    /*
     * v5.34.69: wait for the CONDITION, not for a duration.
     *
     * This was `await wait(15)` — a fixed 15ms bet that the socket had opened.
     * It holds on an idle machine and loses under load: reproduced by running
     * the suite with eight workers on two cores, where it failed while passing
     * in isolation. A timing test that fails when the machine is busy teaches
     * people to re-run rather than to look, which is how a real regression here
     * would get waved through — and what this guards is that nothing reaches
     * Google's uplink before setupComplete.
     */
    await waitFor(() => s.ws?.readyState === 1 && !!pending,
                  "the socket never opened, or setupComplete was never swallowed");
    expect(s.ws.readyState).toBe(1);
    expect(s.state).toBe("connecting");
    feed(w, speechFrame(), 3);
    expect(audioOnly(w.sent).length).toBe(0);     // held
    pending._release = true; pending._om({ data: JSON.stringify({ setupComplete: {} }) });
    await p;
    feed(w, speechFrame(), 2);
    expect(audioOnly(w.sent).length).toBe(2);     // flowing
    expect(w.trace()).toMatch(/micFramesHeldBeforeSetup":3/);
  });
});

describe("v5.34.23 — experiment flags", () => {
  it("default: no flags, wire identical (no realtimeInputConfig, gain 1)", async () => {
    const w = makeWorld23();
    await startSession(w);
    expect(w.sent[0].setup.realtimeInputConfig).toBeUndefined();
    feed(w, speechFrame(2048, 0.25), 1);
    expect(Math.max(...Array.from(pcmOf(audioOnly(w.sent)[0])))).toBeLessThan(0.26 * 32767);
    expect(w.trace()).not.toMatch(/EXPERIMENT/);
  });

  it("micGain amplifies the PCM on the wire and clamps", async () => {
    const w = makeWorld23({ micGain: 3 });
    await startSession(w);
    feed(w, speechFrame(2048, 0.25), 1);
    const pcm = Array.from(pcmOf(audioOnly(w.sent)[0]));
    expect(Math.max(...pcm)).toBeGreaterThan(0.7 * 32767);
    feed(w, speechFrame(2048, 0.9), 1);
    const pcm2 = Array.from(pcmOf(audioOnly(w.sent)[1]));
    expect(Math.max(...pcm2)).toBe(32767);         // clamped, not wrapped
    expect(w.trace()).toMatch(/EXPERIMENT FLAGS ACTIVE/);
  });

  it("streamEnd sends audioStreamEnd once after a ≥1s utterance ends", async () => {
    const w = makeWorld23({ streamEnd: true });
    await startSession(w);
    feed(w, speechFrame(), 9);                     // ~1.15 s of speech (9 × 128 ms)
    await wait(40);
    feed(w, silentFrame(), 2);                     // gap closes the utterance; next frame carries the signal
    const keys = rtKeys(w.sent);
    expect(keys.filter((k) => k === "audioStreamEnd").length).toBe(1);
    expect(keys.indexOf("audioStreamEnd")).toBeGreaterThan(8);
    expect(w.trace()).toMatch(/sent audioStreamEnd/);
  });

  it("manualVad disables server VAD in setup and brackets each utterance with activityStart/End", async () => {
    const w = makeWorld23({ manualVad: true });
    await startSession(w);
    expect(w.sent[0].setup.realtimeInputConfig).toEqual({ automaticActivityDetection: { disabled: true } });
    feed(w, silentFrame(), 1);
    feed(w, speechFrame(), 3);                     // short utterance (< 1 s) still gets bracketed
    await wait(40);
    feed(w, silentFrame(), 2);
    const keys = rtKeys(w.sent);
    const start = keys.indexOf("activityStart"), end = keys.indexOf("activityEnd");
    expect(start).toBe(1);                         // BEFORE the first loud frame (after one silent one)
    expect(keys[start + 1]).toBe("audio");
    expect(end).toBeGreaterThan(start + 3);
    expect(keys.filter((k) => k === "activityStart").length).toBe(1);
    expect(keys.filter((k) => k === "activityEnd").length).toBe(1);
  });
});

describe("v5.34.23 — the server ignored our speech", () => {
  it("fires onUplinkIgnored with a QUIET verdict when a quiet ≥1s utterance gets no server reaction", async () => {
    const w = makeWorld23();
    let got: any = null;
    await startSession(w, { onUplinkIgnored: (st: any) => { got = st; } });
    feed(w, speechFrame(2048, 0.015), 9);          // rms ≈ 0.0106: speech-level, but quiet
    await wait(40); feed(w, silentFrame(), 1);
    await wait(120);
    expect(got).toBeTruthy();
    expect(got.meanRms).toBeLessThan(0.02);
    expect(w.trace()).toMatch(/SERVER IGNORED/);
    expect(w.trace()).toMatch(/uplink is QUIET/);
  });

  it("does NOT fire when the server reacted (a transcription arrived after the utterance began)", async () => {
    const w = makeWorld23();
    let got = 0;
    await startSession(w, { onUplinkIgnored: () => { got++; } });
    feed(w, speechFrame(), 9);
    w.sockets[0].userSaid("hello");
    await wait(40); feed(w, silentFrame(), 1);
    await wait(120);
    expect(got).toBe(0);
  });

  it("gives the server-side verdict when the level was fine", async () => {
    const w = makeWorld23();
    await startSession(w);
    feed(w, speechFrame(2048, 0.3), 9);
    await wait(40); feed(w, silentFrame(), 1);
    await wait(120);
    expect(w.trace()).toMatch(/level is fine — server-side/);
  });
});

describe("v5.34.23 — uplink backlog", () => {
  it("warns when the browser is holding seconds of audio, sheds past 3s, and recovers", async () => {
    const w = makeWorld23();
    const s = await startSession(w);
    feed(w, speechFrame(), 2);                     // establishes frameBytes
    const frameBytes = s._frameBytes;
    expect(frameBytes).toBeGreaterThan(4000);
    const perSec = frameBytes * (16000 / 2048);
    s.ws.bufferedAmount = Math.round(perSec * 1.5);
    feed(w, speechFrame(), 1);
    expect(w.trace()).toMatch(/UPLINK BACKLOG — 1\.5s/);
    const before = audioOnly(w.sent).length;
    s.ws.bufferedAmount = Math.round(perSec * 4);
    feed(w, speechFrame(), 5);
    expect(audioOnly(w.sent).length).toBe(before); // shed
    expect(w.trace()).toMatch(/SHEDDING frames/);
    s.ws.bufferedAmount = 0;
    feed(w, speechFrame(), 1);
    expect(audioOnly(w.sent).length).toBe(before + 1);
    expect(w.trace()).toMatch(/backlog drained.*droppedFrames":5/);
  });
});

describe("v5.34.23 — silence detector does not cry wolf on a noise-suppressed room", () => {
  it("a low-RMS floor with audible peaks is not silence; a flat line is", async () => {
    const w = makeWorld23();
    let silent = 0;
    await startSession(w, { onMicSilent: () => { silent++; } });
    const floor = new Float32Array(2048); floor[100] = 0.01; // rms ≈ 0.0002, peak 0.01
    feed(w, floor, 2); await wait(100); feed(w, floor, 2);
    expect(silent).toBe(0);
    const flat = new Float32Array(2048); flat[100] = 0.001;  // peak 0.001
    feed(w, flat, 2); await wait(100); feed(w, flat, 2);
    expect(silent).toBe(1);
  });
});

describe("v5.34.23 — hear what the model hears", () => {
  it("capturedUplink returns exactly the PCM that went on the wire, and pcm16ToWav frames it", async () => {
    const w = makeWorld23();
    const s = await startSession(w);
    feed(w, speechFrame(2048, 0.5), 3);
    const cap = s.capturedUplink(1);
    expect(cap.length).toBe(3 * 2048);
    const wire = Array.from(pcmOf(audioOnly(w.sent)[2]));
    expect(Array.from(cap.slice(-2048))).toEqual(wire);
    const wav = w.win.vyneLive._internals.pcm16ToWav(cap);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(wav.length).toBe(44 + cap.length * 2);
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16000);
  });
});

describe("v5.34.24 — turn-state experiment flags", () => {
  it("legacyChunks sends realtimeInput.mediaChunks[] with the same PCM, and the keepalive too", async () => {
    const w = makeWorld23({ legacyChunks: true });
    const s = await startSession(w);
    feed(w, speechFrame(), 1);
    const f = w.sent.find((x) => x?.realtimeInput?.mediaChunks);
    expect(f).toBeTruthy();
    expect(f.realtimeInput.mediaChunks[0].mimeType).toBe("audio/pcm;rate=16000");
    expect(Buffer.from(f.realtimeInput.mediaChunks[0].data, "base64").length).toBe(4096);
    expect(w.sent.some((x) => x?.realtimeInput?.audio)).toBe(false);
    s.setMuted(true); feed(w, silentFrame(), 1);
    expect(w.sent.filter((x) => x?.realtimeInput?.mediaChunks).length).toBe(2);
  });

  it("openingViaRealtime sends the opening as realtimeInput.text, never a clientContent turn", async () => {
    const w = makeWorld23({ openingViaRealtime: true });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    LI.open("Please begin the interview now.");
    expect(w.sent.some((x) => x?.clientContent)).toBe(false);
    const t = w.sent.find((x) => x?.realtimeInput?.text);
    expect(t.realtimeInput.text).toBe("Please begin the interview now.");
  });

  it("holdMicUntilFirstTurn sends no audio until the first turnComplete, then flows", async () => {
    const w = makeWorld23({ holdMicUntilFirstTurn: true });
    await startSession(w);
    feed(w, speechFrame(), 3);
    expect(audioOnly(w.sent).length).toBe(0);
    expect(w.trace()).toMatch(/holding mic audio until the first turn/);
    w.sockets[0].speak(); w.sockets[0].turnComplete();
    feed(w, speechFrame(), 2);
    expect(audioOnly(w.sent).length).toBe(2);
  });

  it("manualVad asks the server to pin it: the grant request carries manualVad:true (and nothing else new)", async () => {
    const bodies: any[] = [];
    const w = makeWorld23({ manualVad: true }, {
      fetch: async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ token: "tok", model: "m", voice: "Kore", pinned: true, maxSeconds: 900, sessionId: "s1", pinnedExtras: { transcription: true, manualVad: true } }) }; },
    });
    await startSession(w);
    expect(bodies[0].manualVad).toBe(true);
    expect(w.trace()).toMatch(/pinnedExtras":\{"transcription":true,"manualVad":true\}/);
    const w2 = makeWorld23({}, { fetch: async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ token: "tok", model: "m", voice: "Kore", pinned: true, maxSeconds: 900, sessionId: "s1" }) }; } });
    await startSession(w2);
    expect("manualVad" in bodies[1]).toBe(false);
  });
});

describe("v5.34.25 — v1alpha flag", () => {
  it("default order is unchanged (v1beta constrained first); v1alpha flag puts the v1alpha variants first", () => {
    const w = makeWorld23();
    const { variantOrder, } = w.win.vyneLive._internals;
    // v5.34.26: v1alpha is the default; v1beta:true restores the old order.
    const def = variantOrder({ v1beta: true }).map((v: any) => v.v + "/" + v.svc + "?" + v.auth);
    expect(def[0]).toBe("v1beta/BidiGenerateContentConstrained?access_token");
    const alt = variantOrder({}).map((v: any) => v.v + "/" + v.svc + "?" + v.auth);
    expect(alt[0]).toBe("v1alpha/BidiGenerateContentConstrained?access_token");
    expect(alt[1]).toBe("v1alpha/BidiGenerateContentConstrained?key");
    expect(alt[3]).toBe("v1beta/BidiGenerateContentConstrained?access_token");
    expect(alt.length).toBe(def.length);
    expect(alt.slice().sort()).toEqual(def.slice().sort());
  });
  it("by default the socket opens on the v1alpha URL; v1beta:true opens on v1beta", async () => {
    const w = makeWorld23({});
    await startSession(w);
    expect(w.sockets[0].url).toContain("google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=tok");
    const w2 = makeWorld23({ v1beta: true });
    await startSession(w2);
    expect(w2.sockets[0].url).toContain("google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=tok");
  });
  it("an old API (no pinnedExtras in the grant) is called out loudly", async () => {
    const w = makeWorld23({});
    let mismatch = 0;
    await startSession(w, { onApiMismatch: () => { mismatch++; } });
    expect(mismatch).toBe(1);
    expect(w.trace()).toMatch(/API BUILD MISMATCH/);
    const w2 = makeWorld23({}, { fetch: async () => ({ ok: true, json: async () => ({ token: "tok", model: "m", voice: "Kore", pinned: true, maxSeconds: 900, sessionId: "s1", pinnedExtras: { transcription: true, manualVad: false } }) }) });
    let m2 = 0;
    await startSession(w2, { onApiMismatch: () => { m2++; } });
    expect(m2).toBe(0);
  });
});

describe("v5.34.27 — 1007 CONTENT_TYPE_AUDIO is named, backed off, and capped", () => {
  const REASON = "The audio content type (CONTENT_TYPE_AUDIO) is not supported for this model configuration.";
  it("the close is logged as a Google-side rejection and reported to the app", async () => {
    const w = makeWorld23({}, { VYNE_RENEW_BACKOFF_MS: 20 });
    let rej: any = null;
    const LI = w.win.vyneLiveInterview.create({ onAudioRejected: (r: string) => { rej = r; } });
    await LI.start(); await wait(10);
    const ws = w.sockets[0]; ws.readyState = 3; ws.onclose({ code: 1007, reason: REASON });
    expect(rej).toBe(REASON);
    expect(w.trace()).toMatch(/GOOGLE REJECTED AN AUDIO TURN/);
    await wait(60);
    expect(w.sockets.length).toBe(2);                      // renewed, after the backoff
    expect(w.trace()).toMatch(/afterAudioRejection":true,"delayMs":20/);
  });
  it("an ordinary close renews immediately; three consecutive 1007s end the live path", async () => {
    const w = makeWorld23({}, { VYNE_RENEW_BACKOFF_MS: 5 });
    let ended: string | null = null;
    const LI = w.win.vyneLiveInterview.create({ onEnded: (r: string) => { ended = r; } });
    await LI.start(); await wait(10);
    for (let i = 0; i < 3; i++) {
      const ws = w.sockets[w.sockets.length - 1]; ws.readyState = 3; ws.onclose({ code: 1007, reason: REASON });
      await wait(30);
    }
    expect(LI.stopped).toBe(true);
    expect(ended).toBe("audio_rejected");
    expect(w.sockets.length).toBe(3);                      // two renewals, then stop
  });
  it("a successful session in between resets the rejection count", async () => {
    const w = makeWorld23({}, { VYNE_RENEW_BACKOFF_MS: 5 });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    let ws = w.sockets[0]; ws.readyState = 3; ws.onclose({ code: 1007, reason: REASON }); await wait(30);
    ws = w.sockets[1]; ws.readyState = 3; ws.onclose({ code: 1007, reason: REASON }); await wait(30);
    ws = w.sockets[2]; ws.readyState = 3; ws.onclose({ code: 1011, reason: "lifetime" }); await wait(30);   // ordinary
    ws = w.sockets[3]; ws.readyState = 3; ws.onclose({ code: 1007, reason: REASON }); await wait(30);
    expect(LI.stopped).toBe(false);
    expect(w.sockets.length).toBe(5);
  });
});

describe("v5.34.29 — session continuity: resumption handle + goAway handover", () => {
  const grantWith = (extra: any) => async (u: string, init: any) => {
    const body = JSON.parse(init.body);
    if (String(u).endsWith("/close")) return { ok: true, json: async () => ({}) };   // the stop() beacon
    (grantWith as any).bodies.push(body);
    return { ok: true, json: async () => ({ token: "tok", model: "m", voice: "Kore", pinned: true, maxSeconds: 900, sessionId: "s" + (grantWith as any).bodies.length,
      pinnedExtras: { transcription: true, manualVad: false, resumption: true, compression: true, resumed: !!body.resumeHandle, ...extra } }) };
  };
  const fresh = () => { (grantWith as any).bodies = []; return grantWith({}); };

  it("keeps the newest resumable handle and presents it on the renewed grant; no nudge when resumed", async () => {
    const w = makeWorld23({}, { fetch: fresh() });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    const ws = w.sockets[0];
    ws.onmessage({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } }) });
    ws.onmessage({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "h2", resumable: true } }) });
    ws.onmessage({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "stale", resumable: false } }) });
    expect(LI._resumeHandle).toBe("h2");
    ws.readyState = 3; ws.onclose({ code: 1011, reason: "lifetime" });
    await wait(30);
    const bodies = (grantWith as any).bodies;
    expect(bodies.length).toBe(2);
    expect(bodies[0].resumeHandle).toBeUndefined();
    expect(bodies[1].resumeHandle).toBe("h2");
    // v5.34.31: a resumed session still gets a nudge, so it does not sit mute
    // waiting to be spoken to.
    // v5.34.43: and that nudge is a TRIGGER, not an instruction — the long
    // form made the native-audio model answer in text at the handover.
    const texts = w.sent.map((f) => f?.clientContent?.turns?.[0]?.parts?.[0]?.text || "").filter(Boolean);
    // v5.34.73 reworded the nudge to scope it to the renewal TURN (it had become
    // standing behaviour — 50 turns opening "I am still here"). Match the part
    // that distinguishes the resumed variant, not its punctuation.
    expect(texts.some((t) => /briefly renewed and you still have the whole conversation/.test(t))).toBe(true);
    expect(texts.some((t) => /renewed mid-interview/.test(t))).toBe(false);
    expect(w.trace()).toMatch(/resumedWithHandle":true/);
  });

  it("goAway while idle renews immediately, at most once, through the normal renewal path", async () => {
    const w = makeWorld23({}, { fetch: fresh() });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    const ws = w.sockets[0];
    ws.onmessage({ data: JSON.stringify({ goAway: { timeLeft: "5s" } }) });
    await wait(30);
    expect(w.sockets.length).toBe(2);
    expect(LI.renewals).toBe(1);
    expect(w.trace()).toMatch(/goAway received.*timeLeftMs":5000/);
    expect(w.trace()).toMatch(/renewing ahead of goAway/);
  });

  it("goAway while the model is speaking waits for the turn boundary", async () => {
    const w = makeWorld23({}, { fetch: fresh() });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    const ws = w.sockets[0];
    ws.speak();                                          // turn state → speaking
    ws.onmessage({ data: JSON.stringify({ goAway: { timeLeft: "8s" } }) });
    await wait(30);
    expect(w.sockets.length).toBe(1);                    // not yet
    ws.turnComplete();                                   // → idle
    await wait(30);
    expect(w.sockets.length).toBe(2);
  });

  it("a goAway that the server cuts before the boundary still renews via the close path", async () => {
    const w = makeWorld23({}, { fetch: fresh() });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    const ws = w.sockets[0];
    ws.speak();
    ws.onmessage({ data: JSON.stringify({ goAway: { timeLeft: "1s" } }) });
    ws.readyState = 3; ws.onclose({ code: 1011, reason: "deadline" });
    await wait(30);
    expect(w.sockets.length).toBe(2);
    expect(LI.renewals).toBe(1);
  });
});

describe("v5.34.29 — renew ahead of token expiry", () => {
  it("arms a renewal at expiresAt − lead and renews at an idle boundary with the handle", async () => {
    const bodies: any[] = [];
    const w = makeWorld23({}, {
      VYNE_EXPIRY_LEAD_MS: 10,
      fetch: async (u: string, init: any) => {
        if (String(u).endsWith("/close")) return { ok: true, json: async () => ({}) };
        const b = JSON.parse(init.body); bodies.push(b);
        return { ok: true, json: async () => ({ token: "tok", model: "m", voice: "Kore", pinned: true, maxSeconds: 900, sessionId: "s" + bodies.length,
          expiresAt: new Date(Date.now() + 60).toISOString(), pinnedExtras: { transcription: true, manualVad: false, resumption: true, compression: true, resumed: !!b.resumeHandle } }) };
      },
    });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    w.sockets[0].onmessage({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "H", resumable: true } }) });
    expect(w.trace()).toMatch(/token expiry renewal armed/);
    await wait(400);
    expect(w.sockets.length).toBeGreaterThanOrEqual(2);
    expect(bodies[1].resumeHandle).toBe("H");
    expect(w.trace()).toMatch(/token expiry approaching/);
    LI.stop("finished");
  });
  it("a grant without expiresAt arms nothing", async () => {
    const w = makeWorld23({}, { VYNE_EXPIRY_LEAD_MS: 10 });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    expect(w.trace()).not.toMatch(/token expiry renewal armed/);
    LI.stop("finished");
  });
});

describe("v5.34.31 — no handover while the interviewee is speaking", () => {
  it("goAway during an utterance waits until the mic has been quiet, then renews", async () => {
    const w = makeWorld23({}, { VYNE_UTTERANCE_GAP_MS: 30 });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    feed(w, speechFrame(), 3);                            // interviewee talking
    w.sockets[0].onmessage({ data: JSON.stringify({ goAway: { timeLeft: "8s" } }) });
    await wait(50);
    expect(w.sockets.length).toBe(1);
    expect(w.trace()).toMatch(/handover deferred — they are mid-answer/);
    /*
     * v5.34.112 — this case still takes the 1500ms path, deliberately.
     *
     * The required gap now scales with the goAway headroom: hold out for a
     * real turn boundary while there is time, accept a short pause when there
     * is not. This test's goAway says "8s", which after the handover cost is
     * ~6.5s of headroom — below the relax threshold — so 1500ms still renews,
     * and the behaviour asserted here is unchanged. The LONG-headroom case is
     * handoverWaitsForAGap.test.ts's job.
     */
    // quiet: the utterance closes, the 1.5 s quiet rule holds it a moment longer
    feed(w, silentFrame(), 1);
    await wait(50);
    expect(w.sockets.length).toBe(1);
    LI.session._micLastLoudAt = Date.now() - 2000;       // simulate 2 s of quiet
    await wait(400);
    expect(w.sockets.length).toBe(2);
    LI.stop("finished");
  });

  it("with a long deadline, a pause inside an answer is never enough — it waits for the boundary", async () => {
    /*
     * v5.34.112, from a live 12-minute interview: at the handover the
     * interviewee spoke for ~15 seconds and none of it arrived. The handover
     * had fired during a pause for thought, because 1500ms of quiet counted as
     * the end of a turn. Google gives 50 seconds of notice; there is room to
     * wait for a gap that means something.
     */
    const w = makeWorld23({}, { VYNE_UTTERANCE_GAP_MS: 30 });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    feed(w, speechFrame(), 3);
    w.sockets[0].onmessage({ data: JSON.stringify({ goAway: { timeLeft: "50s" } }) });
    await wait(50);
    feed(w, silentFrame(), 1);
    LI.session._micLastLoudAt = Date.now() - 2000;       // a pause for thought
    await wait(400);
    expect(w.sockets.length, "handed over during a pause — the next 15s of answer is lost").toBe(1);
    /*
     * v5.34.115 supersedes what this test used to assert. A SIX-second gap was
     * "a real gap" under .112's duration rule and handed over; it is not enough
     * any more, because the interviewee is still mid-answer and a long answer
     * can contain a six-second pause. That was the minute-nine failure on the
     * 2026-09-15 20-minute interview, where the transcript of a long answer
     * begins mid-sentence.
     */
    LI.session._micLastLoudAt = Date.now() - 6000;
    await wait(400);
    expect(w.sockets.length, "a long pause inside an answer was taken as the end of it").toBe(1);
    /* The model finishes its next question: nobody has answered it yet. That
     * is the boundary, and it is the moment a handover costs nothing. */
    LI.session._spokeSinceTurnEnd = false;
    await wait(400);
    expect(w.sockets.length, "the safe turn boundary came and the handover never took it").toBe(2);
    LI.stop("finished");
  });
});

/* ── v5.34.33 ─────────────────────────────────────────────────────────────── */

describe("v5.34.33 — the trace outlives the page, and talking counts as activity", () => {
  it("mirrors the trace tail into localStorage and offers the previous page's copy", async () => {
    const store: any = { _s: {} as any,
      getItem(k: string) { return this._s[k] ?? null; },
      setItem(k: string, v: string) { this._s[k] = v; },
      removeItem(k: string) { delete this._s[k]; } };

    const w = makeWorld23({}, { localStorage: store, VYNE_TRACE_FLUSH_MS: 0 });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    // pagehide is what a mid-interview sign-out actually triggers; the harness
    // has no event plumbing, so call the exposed flush the listener calls.
    w.win.vyneLiveLogFlush();
    const saved = store.getItem("vyne_live_trace");
    expect(saved, "trace was not persisted").toBeTruthy();
    expect(saved).toMatch(/grant minted/);
    LI.stop("finished");

    // A NEW page instance (same browser) finds the dead session's trace.
    const w2 = makeWorld23({}, { localStorage: store });
    expect(String(w2.win.vyneLiveLogDumpPrev())).toMatch(/grant minted/);
    // …and starts its own capture from clean, so the two are never conflated.
    expect(String(w2.win.vyneLiveLogDump())).not.toMatch(/grant minted/);
    // The live key now belongs to the NEW instance; the old run is only under
    // the _prev key, so one page's failure can never be read as another's.
    expect(store.getItem("vyne_live_trace") || "").not.toMatch(/grant minted/);
    expect(store.getItem("vyne_live_trace_prev")).toMatch(/grant minted/);
  });

  it("a storage that throws never breaks the session", async () => {
    const hostile = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
    const w = makeWorld23({}, { localStorage: hostile });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    w.win.vyneLiveLogFlush();
    expect(w.trace()).toMatch(/setupComplete — session is live/);
    expect(String(w.win.vyneLiveLogDumpPrev())).toMatch(/no previous trace/);
    LI.stop("finished");
  });

  it("an utterance and a model turn both refresh the app's idle clock", async () => {
    const touches: number[] = [];
    const w = makeWorld23({}, { vyneTouchSession: () => touches.push(Date.now()) });
    const s = await startSession(w, {});
    feed(w, speechFrame(), 3);                    // interviewee starts speaking
    expect(touches.length).toBe(1);
    w.sockets[0].turnComplete();                  // …and the agent finishes a turn
    expect(touches.length).toBe(2);
    s.stop("finished");
  });

  it("exposes __vyneLiveActive so the session layer can see a live interview", async () => {
    const w = makeWorld23();
    expect(!!w.win.__vyneLiveActive).toBe(false);
    const s = await startSession(w, {});
    expect(w.win.__vyneLiveActive).toBe(true);
    let idleFired = 0;
    w.win.__vyneOnLiveIdle = () => { idleFired++; };
    s.stop("finished");
    expect(w.win.__vyneLiveActive).toBe(false);
    expect(idleFired).toBeGreaterThan(0);
  });
});

/* ── v5.34.39 ─────────────────────────────────────────────────────────────── */

describe("v5.34.39 — a rate-limited project is named, and waited out", () => {
  /** The close Google actually sent in the soak's base2 run. */
  const EXHAUSTED = { code: 1011, reason: "Resource has been exhausted (e.g. check quota)." };

  it("names RESOURCE_EXHAUSTED instead of letting it read as silence", async () => {
    const w = makeWorld23({}, { VYNE_QUOTA_BACKOFF_MS: 20 });
    const hits: any[] = [];
    const LI = w.win.vyneLiveInterview.create({ onQuotaExhausted: (i: any) => hits.push(i) });
    await LI.start(); await wait(10);
    w.sockets[0].onclose(EXHAUSTED);
    await wait(10);
    expect(w.trace()).toMatch(/GOOGLE IS RATE-LIMITING THIS PROJECT/);
    expect(hits.length).toBeGreaterThan(0);
    LI.stop("finished");
  });

  it("waits before re-minting, instead of spending the allowance that just ran out", async () => {
    const w = makeWorld23({}, { VYNE_QUOTA_BACKOFF_MS: 120, VYNE_QUOTA_BACKOFF_MAX_MS: 400 });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    expect(w.sockets.length).toBe(1);
    w.sockets[0].onclose(EXHAUSTED);
    await wait(40);
    // Still ONE socket: the old code opened the next one within milliseconds.
    expect(w.sockets.length).toBe(1);
    expect(w.trace()).toMatch(/backing off before the next connection/);
    await wait(200);
    expect(w.sockets.length).toBe(2);
    LI.stop("finished");
  });

  it("the wait escalates while the rate limit persists", async () => {
    const w = makeWorld23({}, { VYNE_QUOTA_BACKOFF_MS: 30, VYNE_QUOTA_BACKOFF_MAX_MS: 500 });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    w.sockets[0].onclose(EXHAUSTED);
    await wait(120);
    w.sockets[w.sockets.length - 1].onclose(EXHAUSTED);
    await wait(200);
    const waits = w.trace().match(/"waitMs":\d+/g) || [];
    expect(waits.length).toBeGreaterThanOrEqual(2);
    const values = waits.map((m) => Number(m.split(":")[1]));
    expect(values[1]).toBeGreaterThan(values[0]);
    LI.stop("finished");
  });

  it("gives up with a NAMED reason rather than retrying forever", async () => {
    const w = makeWorld23({}, { VYNE_QUOTA_BACKOFF_MS: 10, VYNE_QUOTA_BACKOFF_MAX_MS: 20, VYNE_MAX_QUOTA_RETRIES: 2 });
    const ended: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onEnded: (r: string) => ended.push(r) });
    await LI.start(); await wait(10);
    for (let i = 0; i < 4 && !LI.stopped; i++) {
      w.sockets[w.sockets.length - 1].onclose(EXHAUSTED);
      await wait(80);
    }
    expect(ended).toContain("quota_exhausted");
    expect(LI.stopped).toBe(true);
  });

  it("an ordinary 1011 is NOT treated as a rate limit", async () => {
    const w = makeWorld23({}, { VYNE_QUOTA_BACKOFF_MS: 5000 });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    w.sockets[0].onclose({ code: 1011, reason: "Internal error encountered." });
    await wait(60);
    // Renewed immediately, with no quota backoff: an internal error is transient.
    expect(w.sockets.length).toBe(2);
    expect(w.trace()).not.toMatch(/RATE-LIMITING THIS PROJECT/);
    LI.stop("finished");
  });
});

/* ── v5.34.40 ─────────────────────────────────────────────────────────────── */

describe("v5.34.40 — a reply that arrives as text and never as voice", () => {
  /** Output transcript only: what the soak caught on a healthy socket. */
  function sayInText(ws: any, text: string) {
    ws.frame({ outputTranscription: { text } });
  }

  it("hands the app the text after the mute window, so the room is not left silent", async () => {
    // v5.34.41: speaking is opt-in now (it fed the mic and made the agent
    // choke). The DETECTION below is unconditional; the flag only gates voice.
    const w = makeWorld23({ speakMuteReplies: true }, { VYNE_MUTE_REPLY_MS: 40 });
    const spoken: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onReplyWithoutAudio: (t: string) => spoken.push(t) });
    await LI.start(); await wait(10);
    sayInText(w.sockets[0], "How is the organization addressing that knowledge gap");
    await wait(120);
    expect(spoken.length).toBe(1);
    expect(spoken[0]).toContain("knowledge gap");
    expect(w.trace()).toMatch(/REPLY WITH NO VOICE/);
    LI.stop("finished");
  });

  it("stays quiet when the voice DOES arrive — no fallback, no double audio", async () => {
    const w = makeWorld23({}, { VYNE_MUTE_REPLY_MS: 200 });
    const spoken: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onReplyWithoutAudio: (t: string) => spoken.push(t) });
    await LI.start(); await wait(10);
    sayInText(w.sockets[0], "And what changed in practice");
    await wait(40);
    w.sockets[0].speak();                       // the audio turns up in time
    await wait(300);
    expect(spoken).toEqual([]);
    LI.stop("finished");
  });

  it("cancels the app's fallback voice if the audio turns up late", async () => {
    const w = makeWorld23({ speakMuteReplies: true }, { VYNE_MUTE_REPLY_MS: 30 });
    const spoken: string[] = [];
    let cancelled = 0;
    const LI = w.win.vyneLiveInterview.create({
      onReplyWithoutAudio: (t: string) => { spoken.push(t); LI.session._spokeFallback = true; },
      onAudioArrivedLate: () => { cancelled++; },
    });
    await LI.start(); await wait(10);
    sayInText(w.sockets[0], "Have you considered moving that checkpoint earlier");
    await wait(80);
    expect(spoken.length).toBe(1);
    w.sockets[0].speak();                       // …and then the voice appears
    await wait(20);
    expect(cancelled).toBe(1);
    expect(w.trace()).toMatch(/telling the app to stop its fallback voice/);
    LI.stop("finished");
  });

  it("fires immediately on turnComplete with a transcript and no audio at all", async () => {
    const w = makeWorld23({ speakMuteReplies: true }, { VYNE_MUTE_REPLY_MS: 60000 });   // window nowhere near elapsed
    const spoken: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onReplyWithoutAudio: (t: string) => spoken.push(t) });
    await LI.start(); await wait(10);
    sayInText(w.sockets[0], "Was that pilot from this year");
    w.sockets[0].turnComplete();
    await wait(20);
    expect(spoken.length).toBe(1);
    expect(w.trace()).toMatch(/MUTE TURN — turnComplete with a transcript and no audio/);
    LI.stop("finished");
  });

  it("says nothing while the session is muted — a paused interview stays paused", async () => {
    const w = makeWorld23({}, { VYNE_MUTE_REPLY_MS: 30 });
    const spoken: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onReplyWithoutAudio: (t: string) => spoken.push(t) });
    await LI.start(); await wait(10);
    LI.setMuted(true);
    sayInText(w.sockets[0], "Something said while paused");
    w.sockets[0].turnComplete();
    await wait(100);
    expect(spoken).toEqual([]);
    LI.stop("finished");
  });
});

/* ── v5.34.41 ─────────────────────────────────────────────────────────────── */

describe("v5.34.41 — the mute-reply fallback must never fight the live voice", () => {
  const sayInText = (ws: any, t: string) => ws.frame({ outputTranscription: { text: t } });

  it("is OFF by default: it detects and logs, and does not speak", async () => {
    const w = makeWorld23({}, { VYNE_MUTE_REPLY_MS: 30 });
    const spoken: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onReplyWithoutAudio: (t: string) => spoken.push(t) });
    await LI.start(); await wait(10);
    sayInText(w.sockets[0], "How is the organization addressing that gap");
    await wait(100);
    expect(w.trace()).toMatch(/REPLY WITH NO VOICE/);         // still diagnosed
    expect(spoken).toEqual([]);                               // …and still silent
    expect(w.trace()).toMatch(/not speaking it/);
    LI.stop("finished");
  });

  it("speaks only when deliberately switched on", async () => {
    const w = makeWorld23({ speakMuteReplies: true }, { VYNE_MUTE_REPLY_MS: 30 });
    const spoken: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onReplyWithoutAudio: (t: string) => spoken.push(t) });
    await LI.start(); await wait(10);
    sayInText(w.sockets[0], "Have you considered moving that checkpoint earlier");
    await wait(100);
    expect(spoken.length).toBe(1);
    LI.stop("finished");
  });

  it("NEVER speaks after a barge-in — the loop that made the agent choke", async () => {
    /*
     * The regression, pinned: `interrupted` resets _turnAudio, which re-armed
     * the timer mid-turn. The fallback then spoke, the mic heard it, Google
     * called that another barge-in and flushed its playback: stop-go-stop-go.
     */
    const w = makeWorld23({ speakMuteReplies: true }, { VYNE_MUTE_REPLY_MS: 30 });
    const spoken: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onReplyWithoutAudio: (t: string) => spoken.push(t) });
    await LI.start(); await wait(10);
    w.sockets[0].speak();                       // the model is talking…
    w.sockets[0].interrupt();                   // …and gets barged in on
    sayInText(w.sockets[0], "picking up where I left off");
    await wait(120);
    expect(spoken).toEqual([]);
    LI.stop("finished");
  });

  it("never speaks while audio is still queued for playback", async () => {
    const w = makeWorld23({ speakMuteReplies: true }, { VYNE_MUTE_REPLY_MS: 30 });
    const spoken: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onReplyWithoutAudio: (t: string) => spoken.push(t) });
    await LI.start(); await wait(10);
    const s = LI.session;
    s.queue.pending = () => 2;                  // playback in flight
    s._turnAudio = false;                       // …but this turn shows no audio
    sayInText(w.sockets[0], "something the model said");
    await wait(120);
    expect(spoken).toEqual([]);
    LI.stop("finished");
  });

  it("a normal turn is unaffected — one interruption does not poison the next turn", async () => {
    const w = makeWorld23({ speakMuteReplies: true }, { VYNE_MUTE_REPLY_MS: 30 });
    const spoken: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onReplyWithoutAudio: (t: string) => spoken.push(t) });
    await LI.start(); await wait(10);
    w.sockets[0].speak(); w.sockets[0].interrupt(); w.sockets[0].turnComplete();
    await wait(20);
    sayInText(w.sockets[0], "a fresh turn with no voice");   // NEW turn, mute
    await wait(120);
    expect(spoken.length).toBe(1);
    LI.stop("finished");
  });
});

/* ── v5.34.42 ─────────────────────────────────────────────────────────────── */

describe("v5.34.42 — the handover nudge must survive the warmup window", () => {
  /** Record every grant body so we can see what the renewal asked Google for. */
  function grants() {
    const bodies: any[] = [];
    const fetch = async (u: string, init: any) => {
      if (String(u).endsWith("/close")) return { ok: true, json: async () => ({}) };
      const b = JSON.parse(init.body); bodies.push(b);
      return { ok: true, json: async () => ({ token: "tok", model: "m", voice: "Kore", pinned: true, maxSeconds: 900,
        sessionId: "s" + bodies.length,
        pinnedExtras: { transcription: true, manualVad: false, resumption: true, compression: true, resumed: !!b.resumeHandle } }) };
    };
    return { bodies, fetch };
  }
  /** Drive a goAway handover and return once the new socket is up. */
  async function handover(w: any) {
    w.sockets[w.sockets.length - 1].onmessage({ data: JSON.stringify({ goAway: { timeLeft: "50s" } }) });
    await wait(80);
  }
  // v5.34.43 shortened the nudge to a trigger; these assert the MECHANISM
  // (that it goes through open() and is resent into silence), not the wording.
  const nudges = (w: any) =>
    w.sent.filter((f: any) => /renewed mid-interview|briefly renewed/.test(f?.clientContent?.turns?.[0]?.parts?.[0]?.text || ""));

  it("sends the nudge through open(), so a turn dropped in the warmup window is resent", async () => {
    const w = makeWorld23({}, { VYNE_OPEN_RETRY_MS: 150, VYNE_RENEW_SILENCE_MS: 60000 });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    await handover(w);
    expect(w.sockets.length).toBe(2);
    expect(nudges(w).length).toBe(1);
    expect(nudges(w)[0]._socket).toBe(1);                 // into the NEW socket
    // Total silence from the renewed session: open()'s rescue resends ONCE.
    await wait(250);
    expect(nudges(w).length).toBe(2);
    expect(w.trace()).toMatch(/open\/fire RESENDING \(total silence — turn looks dropped\)/);
    LI.stop("finished");
  });

  it("does NOT resend once the model is working — a thinking model is left alone", async () => {
    const w = makeWorld23({}, { VYNE_OPEN_RETRY_MS: 150, VYNE_RENEW_SILENCE_MS: 60000 });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    await handover(w);
    w.sockets[1].think("Considering where we left off");   // a frame of any kind
    await wait(250);
    expect(nudges(w).length).toBe(1);
    expect(w.trace()).toMatch(/open\/fire STOPPED — model is working \(thinking\), not dropped/);
    LI.stop("finished");
  });

  it("drops the resume handle and reconnects when the resumed session stays mute", async () => {
    const g = grants();
    const w = makeWorld23({}, { VYNE_OPEN_RETRY_MS: 60000, VYNE_RENEW_SILENCE_MS: 200, fetch: g.fetch });
    let silent = 0;
    const LI = w.win.vyneLiveInterview.create({ onRenewSilent: () => { silent++; } });
    await LI.start(); await wait(10);
    w.sockets[0].onmessage({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "H", resumable: true } }) });
    await handover(w);
    expect(w.sockets.length).toBe(2);
    expect(g.bodies[1].resumeHandle).toBe("H");            // the renewal resumed…
    expect(silent).toBe(0);
    await wait(400);                                       // …and then never spoke
    expect(silent).toBe(1);
    expect(w.trace()).toMatch(/RESUMED SESSION IS MUTE/);
    expect(w.sockets.length).toBe(3);                      // reconnected…
    // …and this time WITHOUT the handle, so a wedged handle cannot wedge the
    // replacement too. The recent transcript still crosses as page context.
    expect(g.bodies[2].resumeHandle).toBeUndefined();
    LI.stop("finished");
  });

  it("gives up with a named reason if the fresh connection is mute too", async () => {
    const ended: string[] = [];
    const w = makeWorld23({}, { VYNE_OPEN_RETRY_MS: 60000, VYNE_RENEW_SILENCE_MS: 150 });
    const LI = w.win.vyneLiveInterview.create({ onEnded: (r: string) => ended.push(r) });
    await LI.start(); await wait(10);
    await handover(w);
    await wait(700);                                       // silent, twice
    expect(ended).toContain("renew_silent");
    expect(LI.stopped).toBe(true);
  });

  it("a renewed session that DOES speak is never torn down by the silence watchdog", async () => {
    const w = makeWorld23({}, { VYNE_OPEN_RETRY_MS: 60000, VYNE_RENEW_SILENCE_MS: 120 });
    const ended: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onEnded: (r: string) => ended.push(r) });
    await LI.start(); await wait(10);
    await handover(w);
    w.sockets[1].speak();
    await wait(400);
    expect(ended).toEqual([]);
    expect(w.sockets.length).toBe(2);
    expect(LI.stopped).toBe(false);
    LI.stop("finished");
  });
});

/* ── v5.34.43 ─────────────────────────────────────────────────────────────── */

describe("v5.34.43 — the handover nudge is a trigger, and a fragment is not a failure", () => {
  const grants = () => {
    const bodies: any[] = [];
    const fetch = async (u: string, init: any) => {
      if (String(u).endsWith("/close")) return { ok: true, json: async () => ({}) };
      const b = JSON.parse(init.body); bodies.push(b);
      return { ok: true, json: async () => ({ token: "tok", model: "m", voice: "Kore", pinned: true, maxSeconds: 900,
        sessionId: "s" + bodies.length,
        pinnedExtras: { transcription: true, manualVad: false, resumption: true, compression: true, resumed: !!b.resumeHandle } }) };
    };
    return { bodies, fetch };
  };
  const nudgeText = (w: any) =>
    w.sent.filter((f: any) => f?.clientContent?.turns?.[0]?.parts?.[0]?.text)
          .map((f: any) => f.clientContent.turns[0].parts[0].text)
          .filter((t: string) => /continue/i.test(t));

  /*
   * The two nudge-wording tests that stood here are GONE, and deliberately.
   *
   * They asserted that the handover nudge was a two-word trigger and that it
   * never said "say". Ninety minutes on the real API showed that wording made
   * things six times worse — the model echoed "Please continue." back as text
   * 18 times across 9 handovers, against 3 for the long form. A test that pins
   * a decision the evidence has overturned is worse than no test: it makes the
   * wrong answer look defended. v5.34.44 restores the long wording and guards
   * it in its own block below.
   *
   * The INSTRUMENT half of 5.34.43 survives unchanged and is tested here — it
   * measured well (15 transcript fragments correctly reclassified, zero false
   * "!!!" lines) and is independent of the wording question.
   */

  it("a 7-character transcript fragment with no audio is NOT reported as a mute turn", async () => {
    const w = makeWorld23({});
    let spoke = 0;
    const s = await startSession(w, { onReplyWithoutAudio: () => { spoke++; } });
    const ws = w.sockets[0];
    ws.frame({ outputTranscription: { text: "So most" } });
    ws.turnComplete();
    const t = w.trace();
    expect(t).not.toMatch(/!!! MUTE TURN/);
    expect(t).toMatch(/short transcript fragment and no audio — not counted/);
    expect(spoke).toBe(0);
    void s;
  });

  it("a real text-only sentence IS still reported", async () => {
    const w = makeWorld23({});
    const s = await startSession(w, {});
    const ws = w.sockets[0];
    ws.frame({ outputTranscription: { text: "So how does that work across the three teams?" } });
    ws.turnComplete();
    expect(w.trace()).toMatch(/!!! MUTE TURN/);
    void s;
  });

  it("the floor is overridable, so the threshold can be tuned without a release", async () => {
    const w = makeWorld23({}, { VYNE_MUTE_TEXT_MIN_CHARS: 200 });
    const s = await startSession(w, {});
    const ws = w.sockets[0];
    ws.frame({ outputTranscription: { text: "So how does that work across the three teams?" } });
    ws.turnComplete();
    expect(w.trace()).not.toMatch(/!!! MUTE TURN/);
    void s;
  });
});

/* ── v5.34.44 ─────────────────────────────────────────────────────────────── */

describe("v5.34.44 — the nudge names an action, and a socket error is survivable", () => {
  const grants = () => {
    const bodies: any[] = [];
    const fetch = async (u: string, init: any) => {
      if (String(u).endsWith("/close")) return { ok: true, json: async () => ({}) };
      const b = JSON.parse(init.body); bodies.push(b);
      return { ok: true, json: async () => ({ token: "tok", model: "m", voice: "Kore", pinned: true, maxSeconds: 900,
        sessionId: "s" + bodies.length,
        pinnedExtras: { transcription: true, manualVad: false, resumption: true, compression: true, resumed: !!b.resumeHandle } }) };
    };
    return { bodies, fetch };
  };
  const sentText = (w: any) =>
    w.sent.map((f: any) => f?.clientContent?.turns?.[0]?.parts?.[0]?.text || "").filter(Boolean);

  it("the handover nudge is NOT a bare imperative — it tells the model what to say and do", async () => {
    const g = grants();
    const w = makeWorld23({}, { VYNE_OPEN_RETRY_MS: 60000, VYNE_RENEW_SILENCE_MS: 60000, fetch: g.fetch });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    w.sockets[0].onmessage({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "H", resumable: true } }) });
    w.sockets[0].onmessage({ data: JSON.stringify({ goAway: { timeLeft: "50s" } }) });
    await wait(80);
    const nudge = sentText(w).filter((t: string) => /renewed/i.test(t));
    expect(nudge.length).toBe(1);
    /*
     * The regression guard. 5.34.43 shortened this to "Please continue." and the
     * model echoed it back as text 18 times in 9 handovers, against 3 for this
     * wording. A bare imperative gives it nothing to do but repeat.
     */
    expect(nudge[0]).not.toBe("Please continue.");
    expect(nudge[0].length).toBeGreaterThan(60);
    // The v5.34.43 lesson is that the nudge must name ACTIONS. v5.34.73 kept
    // that and added a scope, because both actions had become permanent: three
    // renewals produced 50 turns opening "I am still here" and one question
    // asked 40 times (voice-runs/, 2026-09-13). Assert the actions AND the
    // scope — the scope is the new regression risk.
    expect(nudge[0]).toMatch(/say .*you are still there/i);
    expect(nudge[0]).toMatch(/ask your last question once more/i);
    expect(nudge[0]).toMatch(/^Just for this one turn/i);
    expect(nudge[0], "the nudge must say not to carry itself forward")
      .toMatch(/do not open any later turn by saying you are still there/i);
    LI.stop("finished");
  });

  it("a socket error RENEWS instead of ending the interview", async () => {
    const g = grants();
    // v5.34.46 deliberately lets a just-dead socket settle before asking the
    // network for a grant, so the reconnect is no longer instant.
    const w = makeWorld23({}, { VYNE_OPEN_RETRY_MS: 60000, VYNE_RENEW_SILENCE_MS: 60000,
                                VYNE_SOCKET_SETTLE_MS: 10, fetch: g.fetch });
    const ended: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onEnded: (r: string) => ended.push(r) });
    await LI.start(); await wait(10);
    w.sockets[0].onmessage({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "H", resumable: true } }) });
    // What a sleeping laptop or a dropped Wi-Fi connection actually produces.
    LI.session._fail("live_socket_error", new Error("socket died"));
    await wait(80);
    expect(LI.stopped).toBe(false);
    expect(ended).toEqual([]);
    expect(w.sockets.length).toBe(2);              // it came back
    expect(g.bodies[1].resumeHandle).toBe("H");    // with the conversation
    LI.stop("finished");
  });

  it("a deliberate stop is still never renewed — the fix does not widen that", async () => {
    const w = makeWorld23({});
    const ended: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onEnded: (r: string) => ended.push(r) });
    await LI.start(); await wait(10);
    LI.stop("page_unload");
    await wait(40);
    expect(LI.stopped).toBe(true);
    expect(w.sockets.length).toBe(1);
  });

  it("isRenewable covers the reason vyne-live.js actually raises", () => {
    const w = makeWorld23({});
    const LI = w.win.vyneLiveInterview.create({});
    // The bug in one line: 'error' was listed, 'live_socket_error' was raised.
    expect(String(FE_LIVE)).toContain("'live_socket_error'");
    void LI;
  });
});

const FE_LIVE = readFileSync(join(__dirname, "..", "..", "frontend", "vyne-live-interview.js"), "utf8");

/* ── v5.34.46 ─────────────────────────────────────────────────────────────── */

describe("v5.34.46 — a dead network is not a refusal", () => {
  /** A grant endpoint that fails N times the way a dead network does, then works. */
  function flaky(failures: number, failure: any = { status: 500, error: "mint_failed" }) {
    const bodies: any[] = [];
    let n = 0;
    const fetch = async (u: string, init: any) => {
      if (String(u).endsWith("/close")) return { ok: true, json: async () => ({}) };
      const b = JSON.parse(init.body);
      if (n++ > 0 && n - 1 <= failures) {
        return { ok: false, status: failure.status, json: async () => ({ error: failure.error }) };
      }
      bodies.push(b);
      return { ok: true, json: async () => ({ token: "tok", model: "m", voice: "Kore", pinned: true, maxSeconds: 900,
        sessionId: "s" + bodies.length,
        pinnedExtras: { transcription: true, manualVad: false, resumption: true, compression: true, resumed: !!b.resumeHandle } }) };
    };
    return { bodies, fetch, attempts: () => n };
  }

  it("a Wi-Fi drop no longer kills the interview — the mint retries and recovers", async () => {
    const f = flaky(2);                                  // down for two attempts, then back
    const w = makeWorld23({}, { fetch: f.fetch, VYNE_SOCKET_SETTLE_MS: 10,
                                VYNE_RENEW_RETRY_MS: 20, VYNE_RENEW_RETRY_MAX_MS: 40 });
    const ended: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onEnded: (r: string) => ended.push(r) });
    await LI.start(); await wait(10);
    LI.session._fail("live_socket_error", new Error("network went away"));
    await wait(400);
    expect(ended).toEqual([]);                           // NOT renew_failed
    expect(LI.stopped).toBe(false);
    expect(w.trace()).toMatch(/renewal failed on TRANSPORT, not refusal — retrying/);
    expect(f.attempts()).toBeGreaterThanOrEqual(3);      // it kept trying
    expect(w.sockets.length).toBeGreaterThanOrEqual(2);  // and came back
    LI.stop("finished");
  });

  it("a REFUSAL is still terminal — retrying our own cap would only burn it further", async () => {
    const f = flaky(99, { status: 429, error: "too_many_live_sessions" });
    const w = makeWorld23({}, { fetch: f.fetch, VYNE_SOCKET_SETTLE_MS: 10, VYNE_RENEW_RETRY_MS: 20 });
    const ended: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onEnded: (r: string) => ended.push(r) });
    await LI.start(); await wait(10);
    LI.session._fail("live_socket_error", new Error("socket died"));
    await wait(300);
    expect(ended).toContain("renew_failed");
    expect(LI.stopped).toBe(true);
    expect(w.trace()).toMatch(/renewal REFUSED \(not a transport fault\)/);
    expect(f.attempts()).toBeLessThanOrEqual(3);         // it did NOT hammer the cap
  });

  it("gives up eventually rather than retrying a network that never returns", async () => {
    const f = flaky(99);                                 // never comes back
    const w = makeWorld23({}, { fetch: f.fetch, VYNE_SOCKET_SETTLE_MS: 5,
                                VYNE_RENEW_RETRY_MS: 10, VYNE_RENEW_RETRY_MAX_MS: 15,
                                VYNE_MAX_RENEW_RETRIES: 3 });
    const ended: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onEnded: (r: string) => ended.push(r) });
    await LI.start(); await wait(10);
    LI.session._fail("live_socket_error", new Error("still gone"));
    await wait(500);
    expect(ended).toContain("renew_failed");
    expect(w.trace()).toMatch(/still no network after 3 attempts/);
  });

  it("classifies the two cases the way the measured trace demands", async () => {
    const w = makeWorld23({});
    const LI = w.win.vyneLiveInterview.create({});
    void LI;
    const src = FE_LIVE;
    // A refusal names a reason; a transport fault has no status, or a 5xx.
    expect(src).toContain("function isTransientRenewFailure");
    expect(src).toContain("too_many_live_sessions");
    expect(src).toMatch(/status >= 400 && status < 500.*return false/s);
  });

  it("does not fire the first mint into a socket that has only just died", () => {
    expect(FE_LIVE).toContain("SOCKET_SETTLE_MS");
    expect(FE_LIVE).toMatch(/r === 'live_socket_error'\s*\)\s*\?\s*SOCKET_SETTLE_MS/);
  });
});

/* ── v5.34.47 ─────────────────────────────────────────────────────────────── */

describe("v5.34.47 — the retry waits once, and says how long it waited", () => {
  /**
   * Same shape as flaky() above, but it records WHEN each mint was attempted.
   * The bug this describes was invisible to a pass/fail assertion: .46 retried
   * correctly and recovered, it just took twice as long as it logged.
   */
  function timedFlaky(failures: number) {
    const at: number[] = [];
    let n = 0;
    const fetch = async (u: string, init: any) => {
      if (String(u).endsWith("/close")) return { ok: true, json: async () => ({}) };
      const b = JSON.parse(init.body);
      at.push(Date.now());
      if (n++ > 0 && n - 1 <= failures) {
        return { ok: false, status: 500, json: async () => ({ error: "mint_failed" }) };
      }
      return { ok: true, json: async () => ({ token: "tok", model: "m", voice: "Kore", pinned: true,
        maxSeconds: 900, sessionId: "s" + n,
        pinnedExtras: { transcription: true, manualVad: false, resumption: true, compression: true,
                        resumed: !!b.resumeHandle } }) };
    };
    return { fetch, at, attempts: () => n };
  }

  it("the gap between attempts is the backoff, not twice the backoff", async () => {
    /*
     * v5.34.46 applied the delay in two places — the retry's setTimeout and
     * again inside attemptRenewal — so the trace said 4s/8s/16s while the real
     * gaps were 8s/16s/32s. A 28-second recovery took 58. Scaled down here:
     * 60ms, 120ms, 240ms. Doubling would put the third attempt past 360ms.
     */
    const f = timedFlaky(3);
    const w = makeWorld23({}, { fetch: f.fetch, VYNE_SOCKET_SETTLE_MS: 1,
                                VYNE_RENEW_RETRY_MS: 60, VYNE_RENEW_RETRY_MAX_MS: 5000 });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    f.at.length = 0;                                      // forget the opening mint
    LI.session._fail("live_socket_error", new Error("network went away"));
    await wait(900);
    expect(f.at.length).toBeGreaterThanOrEqual(4);        // renewal + 3 retries
    const gaps = f.at.slice(1).map((t, i) => t - f.at[i]);
    // 60 / 120 / 240, with slack for timer jitter but well under the doubled 120 / 240 / 480.
    expect(gaps[0]).toBeLessThan(110);
    expect(gaps[1]).toBeLessThan(200);
    expect(gaps[2]).toBeLessThan(380);
    LI.stop("finished");
  });

  it("the logged wait is the wait actually taken", async () => {
    const f = timedFlaky(2);
    const w = makeWorld23({}, { fetch: f.fetch, VYNE_SOCKET_SETTLE_MS: 1,
                                VYNE_RENEW_RETRY_MS: 60, VYNE_RENEW_RETRY_MAX_MS: 5000 });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    f.at.length = 0;
    LI.session._fail("live_socket_error", new Error("gone"));
    await wait(700);
    const m = /retrying.*"inMs":\s*(\d+)/.exec(w.trace());
    expect(m).toBeTruthy();
    const logged = Number(m![1]);
    const actualFirstGap = f.at[1] - f.at[0];
    expect(logged).toBe(60);
    expect(Math.abs(actualFirstGap - logged)).toBeLessThan(60);
    LI.stop("finished");
  });

  it("stopping mid-backoff ends the interview once, not twice", async () => {
    /*
     * The wait now lives inside attemptRenewal, so the guard that used to sit
     * in the retry's setTimeout has to sit after the wait instead — otherwise
     * a stop during the backoff would fall through to onRenewalFail and fire
     * onEnded('renew_failed') on top of the ending that already happened.
     */
    const f = timedFlaky(99);
    const w = makeWorld23({}, { fetch: f.fetch, VYNE_SOCKET_SETTLE_MS: 1,
                                VYNE_RENEW_RETRY_MS: 200, VYNE_RENEW_RETRY_MAX_MS: 5000 });
    const ended: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onEnded: (r: string) => ended.push(r) });
    await LI.start(); await wait(10);
    LI.session._fail("live_socket_error", new Error("gone"));
    await wait(60);                                       // mid-wait
    LI.stop("finished");
    const attemptsAtStop = f.attempts();
    await wait(500);
    // The interview is over because stop() said so. The abandoned retry must
    // not add a second, contradictory ending on top of it.
    expect(ended).not.toContain("renew_failed");
    expect(w.trace()).toMatch(/renewal abandoned/);
    expect(f.attempts()).toBe(attemptsAtStop);            // and it stopped trying
  });

  it("the delay is computed in exactly one place", () => {
    expect(FE_LIVE).toContain("var renewWaitMs = function ()");
    // The retry must not re-wrap attemptRenewal in its own timer.
    expect(FE_LIVE).not.toMatch(/}, backoff\);/);
    expect(FE_LIVE).toContain("var backoff = renewWaitMs();");
  });
});

/* The harness's own label, so a retry does not read as a second handover. */
const FE_RECORDER = readFileSync(join(__dirname, "..", "..", "deploy", "voice-record.mjs"), "utf8");

describe("v5.34.47 — one handover, one 'starting' line in the recording log", () => {
  it("a reconnect attempt is labelled a retry, not a new handover", () => {
    expect(FE_RECORDER).toContain('if (reason === "reconnecting")');
    expect(FE_RECORDER).toMatch(/still reconnecting \(retry \$\{renewRetries\}\)/);
  });

  it("fault injection exists, is offline-only, and judges its own result", () => {
    // The gate in run-voice-record.sh greps for "  PASS" in the run's .txt.
    // If this flag or that verdict line is renamed, the gate silently stops
    // checking anything — it would still find no FAIL and carry on.
    expect(FE_RECORDER).toContain('arg("offline-fail-mints", 0)');
    expect(FE_RECORDER).toContain("if (OFFLINE_FAIL_MINTS) say(faultVerdict());");
    expect(FE_RECORDER).toMatch(/mintAttempts > 1 && mintFailuresLeft > 0/);
    // Refused with a bare 500 and no code, so isTransientRenewFailure() sees
    // transport rather than a refusal — injecting a refusal would test nothing.
    expect(FE_RECORDER).toMatch(/status: 500,\s*\n?\s*json: async \(\) => \(\{ error: "mint_failed"/);
  });

  it("the fault verdict measures only the injected burst", () => {
    // The first version counted the later goAway handovers as retries and
    // reported FAIL on a run that had passed.
    expect(FE_RECORDER).toContain("mintAt.slice(1, 2 + OFFLINE_FAIL_MINTS)");
  });

  it("the shell gate greps for a line the verdict actually prints", () => {
    const gate = readFileSync(join(__dirname, "..", "..", "deploy", "run-voice-record.sh"), "utf8");
    expect(gate).toContain("--offline-fail-mints 3");
    expect(gate).toContain('grep -q "^  PASS" voice-faultcheck.txt');
    // The verdict's pass line is indented by two spaces; the grep anchors on it.
    expect(FE_RECORDER).toContain('? "PASS" : "FAIL"');
  });

  it("the handover counter only advances on a real handover", () => {
    // renewals = n must not be reachable from the 'reconnecting' branch.
    const block = FE_RECORDER.slice(FE_RECORDER.indexOf("onRenewing: (n, reason)"),
                                    FE_RECORDER.indexOf("onRenewSilent:"));
    const reconnectBranch = block.slice(0, block.indexOf("renewals = n"));
    expect(reconnectBranch).toContain("return;");
    expect(block).toContain("renewRetries = 0;");
  });
});

/* ── v5.34.49 ─────────────────────────────────────────────────────────────── */

const FE_VOICE = readFileSync(join(__dirname, "..", "..", "frontend", "vyne-live.js"), "utf8");

describe("v5.34.49 — what the session reports as used is what it used", () => {
  /*
   * v5.34.52 rewrote these. They were written when usage was maxed across the
   * session; it is now accumulated per turn, so each case ends its turn before
   * asserting the session total. The BEHAVIOURS being guarded are unchanged —
   * details arrays, no double-counting, zero frames, the close beacon.
   */
  /** Feed a usageMetadata frame straight at the socket, as Google does. */
  const usage = (w: any, u: any) =>
    w.sockets[0].onmessage({ data: JSON.stringify({ usageMetadata: u }) });
  /*
   * v5.34.110 — a turn SPEAKS before it ends.
   *
   * These drove turns with a usage frame and a bare turnComplete and no audio
   * at all, which is not a sequence the server ever produces: every real turn
   * generates something. v5.34.109's duplicate-close guard reads exactly that
   * — has the model generated anything since the last close — so a turn with
   * no audio now reads as the same turn closing twice and is correctly
   * ignored.
   *
   * The fix is the frame sequence, not the guard. The assertions below are
   * untouched: they are about token arithmetic after a real 13x under-count,
   * and a speak() before the close is what a real turn looks like.
   */
  const endTurn = (w: any) => { w.sockets[0].speak(); w.sockets[0].frame({ turnComplete: true }); };

  async function started() {
    const w = makeWorld23({});
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    return { w, LI };
  }

  it("counts audio tokens reported only in the details arrays", async () => {
    /*
     * The production shape, reproduced: 42 sessions metered 150,620 in against
     * 9,399 out. Both directions are audio; output should be the same order as
     * input, not 1.6% of it. That is what a scalar carrying only the text
     * transcript looks like when the audio sits in responseTokensDetails.
     */
    const { w, LI } = await started();
    usage(w, {
      promptTokenCount: 3600,
      responseTokenCount: 224,                    // text transcript only
      promptTokensDetails: [{ modality: "AUDIO", tokenCount: 3600 }],
      responseTokensDetails: [
        { modality: "AUDIO", tokenCount: 4100 },
        { modality: "TEXT", tokenCount: 224 },
      ],
    });
    endTurn(w);
    expect(LI.session.usage.tokensOut).toBe(4324);  // not 224
    expect(LI.session.usage.tokensIn).toBe(3600);
    LI.stop("finished");
  });

  it("does not double-count when the scalar is already the aggregate", async () => {
    // max(), not sum() — this is the whole reason for choosing max.
    const { w, LI } = await started();
    usage(w, {
      promptTokenCount: 5000,
      responseTokenCount: 8000,
      responseTokensDetails: [{ modality: "AUDIO", tokenCount: 8000 }],
    });
    endTurn(w);
    expect(LI.session.usage.tokensOut).toBe(8000);  // not 16000
    LI.stop("finished");
  });

  it("a later, smaller frame cannot erase what was already counted", async () => {
    /*
     * The old code assigned rather than accumulated, so the LAST frame won. If
     * usageMetadata is per-turn rather than cumulative, that reports one turn
     * as the whole session — an invoice an order of magnitude light. Monotonic
     * max is correct under either reading.
     */
    const { w, LI } = await started();
    usage(w, { promptTokenCount: 90000, responseTokenCount: 70000 });
    usage(w, { promptTokenCount: 120, responseTokenCount: 90 });
    endTurn(w);
    expect(LI.session.usage.tokensIn).toBe(90000);
    expect(LI.session.usage.tokensOut).toBe(70000);
    LI.stop("finished");
  });

  it("a zero frame leaves a real count alone", async () => {
    const { w, LI } = await started();
    usage(w, { promptTokenCount: 4000, responseTokenCount: 5000 });
    usage(w, { promptTokenCount: 0, responseTokenCount: 0 });
    endTurn(w);
    expect(LI.session.usage.tokensOut).toBe(5000);
    LI.stop("finished");
  });

  it("malformed or missing usage never throws — a bill is not worth an interview", async () => {
    const { w, LI } = await started();
    usage(w, {});
    usage(w, { responseTokensDetails: [{ modality: "AUDIO" }] });   // no tokenCount
    usage(w, { promptTokenCount: "not a number" });
    expect(LI.stopped).toBe(false);
    expect(LI.session.usage.tokensIn).toBe(0);
    expect(LI.session.usage.tokensOut).toBe(0);
    LI.stop("finished");
  });

  it("the close beacon sends what was counted", async () => {
    const closes: any[] = [];
    const w = makeWorld23({}, {
      fetch: async (url: string, init: any) => {
        if (String(url).endsWith("/close")) { closes.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; }
        return { ok: true, json: async () => ({ token: "t", model: "m", voice: "Kore", pinned: true, maxSeconds: 900, sessionId: "s1" }) };
      },
    });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    w.sockets[0].onmessage({ data: JSON.stringify({ usageMetadata: {
      responseTokenCount: 100,
      responseTokensDetails: [{ modality: "AUDIO", tokenCount: 9000 }],
    } }) });
    LI.stop("finished");   // mid-turn: stop() must flush it
    await wait(10);
    expect(closes.length).toBe(1);
    expect(closes[0].tokensOut).toBe(9000);
  });

  it("the whole usageMetadata object reaches the trace, not two scalars", () => {
    // The field set above is inferred from a token ratio, not from a captured
    // frame. This is what lets the next real interview settle it.
    expect(FE_VOICE).toContain("usageMetadata (full shape, first frame of this session)");
    expect(FE_VOICE).toContain("inDetails: msg.usageMetadata.promptTokensDetails");
    expect(FE_VOICE).toContain("outDetails: msg.usageMetadata.responseTokensDetails");
  });
});

/* ── v5.34.51 ─────────────────────────────────────────────────────────────── */

describe("v5.34.51 — a recording must use the model production runs", () => {
  const GATE = readFileSync(join(__dirname, "..", "..", "deploy", "run-voice-record.sh"), "utf8");

  it("the harness is pointed at the deployed GEMINI_LIVE_MODEL, not a hardcoded default", () => {
    /*
     * Found in a real interview's trace: the session ran on
     * gemini-3.1-flash-live-preview while the harness recorded on
     * gemini-2.5-flash-native-audio-latest, because the service overrides
     * DEFAULT_LIVE_MODEL with GEMINI_LIVE_MODEL and nothing read it. Every
     * latency figure, mute-turn count and nudge comparison measured that day
     * was therefore taken on a model no interviewee ever speaks to.
     */
    expect(GATE).toContain('v["name"] == "GEMINI_LIVE_MODEL"');
    expect(GATE).toContain('--model "$LIVE_MODEL"');
  });

  it("says so loudly when the service names no model, rather than silently guessing", () => {
    expect(GATE).toMatch(/the service sets no GEMINI_LIVE_MODEL/);
    expect(GATE).toMatch(/measures the wrong thing/);
  });

  it("every model the backend will run live is priced", async () => {
    // A live model missing from PRICE_TABLE meters a real, billed interview at
    // $0.00 — the silent undercount that file's comments already record twice.
    const { LIVE_CAPABLE_MODELS } = await import("../src/llm/liveSession.js");
    const { PRICE_TABLE } = await import("../src/llm/types.js");
    for (const m of LIVE_CAPABLE_MODELS) {
      const bare = m.replace(/^models\//, "");
      expect(PRICE_TABLE[bare], `${bare} has no price — a real interview would meter $0.00`).toBeTruthy();
    }
  });
});

/* ── v5.34.52 ─────────────────────────────────────────────────────────────── */

describe("v5.34.52 — usage is accumulated per turn, not maxed across the session", () => {
  const usage = (w: any, u: any) =>
    w.sockets[0].onmessage({ data: JSON.stringify({ usageMetadata: u }) });
  /* v5.34.110: a turn speaks before it ends — see the note on endTurn above. */
  const turnEnd = (w: any) => { w.sockets[0].speak(); w.sockets[0].frame({ turnComplete: true }); };

  async function started() {
    const w = makeWorld23({});
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    return { w, LI };
  }

  it("three turns of speech add up instead of reporting the largest one", async () => {
    /*
     * The measurement that forced this. Session 55111401, a real interview:
     *   session_secs 590, tokens_out 367 — about 15 seconds of speech in a
     *   ten-minute segment, because max() recorded one turn and called it the
     *   session. Roughly a thirteenfold undercount on the most expensive call
     *   the product makes.
     */
    const { w, LI } = await started();
    usage(w, { promptTokenCount: 2230, responseTokenCount: 249 }); turnEnd(w);
    usage(w, { promptTokenCount: 4100, responseTokenCount: 367 }); turnEnd(w);
    usage(w, { promptTokenCount: 6050, responseTokenCount: 180 }); turnEnd(w);
    await wait(5);
    expect(LI.session.usage.tokensOut).toBe(796);     // not 367
    expect(LI.session.usage.tokensIn).toBe(12380);    // not 6050
    expect(LI.session.usage.turns).toBe(3);
    LI.stop("finished");
  });

  it("several frames inside one turn are banked once, not summed", async () => {
    /*
     * Whether Google emits usage once per turn or repeatedly with a running
     * total is not established. Banking the LATEST value at turnComplete is
     * correct under both readings; summing every frame would double-count
     * under the second.
     */
    const { w, LI } = await started();
    usage(w, { promptTokenCount: 1000, responseTokenCount: 100 });
    usage(w, { promptTokenCount: 1500, responseTokenCount: 200 });
    usage(w, { promptTokenCount: 2000, responseTokenCount: 300 });
    turnEnd(w);
    await wait(5);
    expect(LI.session.usage.tokensOut).toBe(300);     // the final running total
    expect(LI.session.usage.tokensIn).toBe(2000);
    expect(LI.session.usage.turns).toBe(1);
    LI.stop("finished");
  });

  it("a session that ends mid-turn still bills that turn", async () => {
    // A handover or a hang-up lands mid-turn more often than not.
    const closes: any[] = [];
    const w = makeWorld23({}, {
      fetch: async (url: string, init: any) => {
        if (String(url).endsWith("/close")) { closes.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; }
        return { ok: true, json: async () => ({ token: "t", model: "m", voice: "Kore", pinned: true, maxSeconds: 900, sessionId: "s1" }) };
      },
    });
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(10);
    usage(w, { promptTokenCount: 5000, responseTokenCount: 900 }); turnEnd(w);
    usage(w, { promptTokenCount: 5200, responseTokenCount: 400 });   // no turnComplete
    LI.stop("finished");
    await wait(10);
    expect(closes[0].tokensOut).toBe(1300);           // 900 banked + 400 flushed
    expect(closes[0].tokensIn).toBe(10200);
  });

  it("a turn is never banked twice", async () => {
    const { w, LI } = await started();
    usage(w, { promptTokenCount: 1000, responseTokenCount: 100 });
    turnEnd(w); turnEnd(w);                            // duplicate turnComplete
    await wait(5);
    expect(LI.session.usage.tokensOut).toBe(100);
    expect(LI.session.usage.turns).toBe(1);
    LI.stop("finished");
  });

  it("a turn with no usage frame banks nothing", async () => {
    const { w, LI } = await started();
    turnEnd(w);
    await wait(5);
    expect(LI.session.usage.tokensOut).toBe(0);
    expect(LI.session.usage.turns ?? 0).toBe(0);
    LI.stop("finished");
  });

  it("usage riding on a frame with other content reaches the trace", async () => {
    // The classifier returned before the standalone usageMetadata branch, so a
    // whole session's usage frames were invisible — which is why per-turn
    // versus cumulative could not be settled and the accumulator stayed wrong
    // through two releases.
    expect(FE_VOICE).toContain("bits.push('usage');");
    expect(FE_VOICE).toContain("detail.usageOut = msg.usageMetadata.responseTokenCount;");
  });
});

/**
 * v5.34.75 — a turn that GENERATES and never COMPLETES still ends.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * vyne-live.js closed a model turn in exactly one place, `if (f.turnComplete)`,
 * and that branch is what banks the turn's usage, ends the playback run, clears
 * the per-turn flags and returns the state machine to 'idle'.
 * `generationComplete` was parsed into the frame object and then used for
 * nothing but a log line.
 *
 * On models/gemini-3.1-flash-live-preview — what production serves — the server
 * sometimes sends generationComplete and never follows it with turnComplete.
 * Counted on the 30-minute recording of 2026-09-13:
 *
 *   voice-record.log  (3.1-flash-live-preview) : 26 generationComplete, 23 turnComplete
 *   voice-runs/…      (2.5-flash-native-audio) : 102 generationComplete, 145 turnComplete
 *
 * Three turns generated and never closed, each pinning _turnState at 'speaking'
 * for the rest of that session. The voice harness drives the whole conversation
 * off the speaking → idle edge, so it died outright — half of a thirty-minute
 * recording spent with a dead uplink, the model waiting for someone who had
 * stopped talking. In the product the cost is quieter: onTurnState consumers
 * believe the interviewer is mid-sentence, the goAway idle check defers a
 * renewal that is not actually mid-turn, and usage.turns under-counts.
 *
 * Token totals survive either way — _turnUsage holds the max seen and stop()
 * banks it — so this is not a billing fault and these tests do not claim one.
 */
describe("v5.34.75 — generationComplete closes a turn turnComplete abandoned", () => {
  const GRACE = 60;   // the shipped default is 1200ms; shortened here
  const w75 = () => makeWorld23({}, { VYNE_TURN_CLOSE_GRACE_MS: GRACE });

  /** Start a session and get it speaking, the way a real turn begins. */
  async function speaking(w: any) {
    const states: string[] = [];
    const LI = w.win.vyneLiveInterview.create({ onTurnState: (s: string) => states.push(s) });
    await LI.start(); await wait(10);
    w.sockets[0].speak();
    await wait(5);
    return { LI, ws: w.sockets[0], states };
  }

  it("the regression: the turn ends even though turnComplete never arrives", async () => {
    const w = w75();
    const { LI, ws, states } = await speaking(w);
    expect(states).toContain("speaking");

    ws.frame({ generationComplete: true });
    await wait(GRACE * 5);

    expect(states.at(-1), "the turn never closed — state stayed pinned at 'speaking'").toBe("idle");
    expect(LI.session._salvagedTurns).toBe(1);
    LI.stop("finished");
  });

  it("says so in the trace, with a !!! so it is not mistaken for routine", async () => {
    const w = w75();
    const { LI, ws } = await speaking(w);
    ws.frame({ generationComplete: true });
    await wait(GRACE * 5);
    expect(w.trace()).toMatch(/!!! turnComplete never arrived after generationComplete/);
    LI.stop("finished");
  });

  it("does NOT fire when turnComplete arrives normally", async () => {
    /*
     * The negative control, and the one that matters most: on every healthy
     * turn both frames arrive together, so this must never double-close.
     */
    const w = w75();
    const { LI, ws, states } = await speaking(w);
    ws.frame({ generationComplete: true, turnComplete: true });
    await wait(GRACE * 5);

    expect(states.at(-1)).toBe("idle");
    expect(LI.session._salvagedTurns || 0, "a healthy turn was counted as salvaged").toBe(0);
    expect(w.trace()).not.toMatch(/!!! turnComplete never arrived/);
    LI.stop("finished");
  });

  it("does not fire when turnComplete merely arrives LATE", async () => {
    // Inside the grace window the ordinary path must still own the close.
    const w = w75();
    const { LI, ws } = await speaking(w);
    ws.frame({ generationComplete: true });
    await wait(GRACE / 3);
    ws.turnComplete();
    await wait(GRACE * 5);
    expect(LI.session._salvagedTurns || 0).toBe(0);
    LI.stop("finished");
  });

  it("a new turn starting cancels a pending salvage", async () => {
    /*
     * generationComplete followed by more audio means the model kept going.
     * Closing the turn underneath it would end one that is still running.
     */
    const w = w75();
    const { LI, ws, states } = await speaking(w);
    ws.frame({ generationComplete: true });
    await wait(GRACE / 3);
    ws.speak();
    await wait(GRACE * 5);
    expect(LI.session._salvagedTurns || 0).toBe(0);
    expect(states.at(-1)).toBe("speaking");
    LI.stop("finished");
  });

  it("banks the turn's usage on the salvaged path, exactly once", async () => {
    // _closeTurn is shared with turnComplete precisely so a salvaged turn and a
    // healthy one leave identical state behind.
    const w = w75();
    const { LI, ws } = await speaking(w);
    ws.onmessage?.({ data: JSON.stringify({ usageMetadata: { promptTokenCount: 120, responseTokenCount: 40 } }) });
    await wait(5);
    ws.frame({ generationComplete: true });
    await wait(GRACE * 5);
    expect(LI.session.usage.tokensIn).toBe(120);
    expect(LI.session.usage.tokensOut).toBe(40);
    expect(LI.session.usage.turns).toBe(1);
    LI.stop("finished");
  });
});

/**
 * v5.34.75 — the interview says when time is running short.
 *
 * interviewerPersona.ts has carried the rule since v5.34.73: "If you are told
 * that time is running short and you still have ground to cover, say so plainly
 * before the end ... they can pick it up another time." It shipped with nothing
 * to trigger it, which made it inert — a session hit its ceiling and simply
 * stopped, with questions outstanding and nothing said about it.
 *
 * The trigger needs a PLANNED length, and the product does not record one
 * anywhere (no duration on the invite, none on the engagement). So it arms only
 * when a caller supplies plannedMinutes; the voice harness does, which is what
 * these tests stand in for. Without it, nothing fires and behaviour is
 * unchanged — which is why the "never arms" case below is load-bearing.
 */
describe("v5.34.75 — the wrap-up notice", () => {
  const w75 = (extra: Record<string, unknown> = {}) => makeWorld23({}, extra);
  /** Text this world has actually put on the wire (sentText is scoped elsewhere). */
  const wireText = (w: any) =>
    w.sent.map((f: any) => f?.clientContent?.turns?.[0]?.parts?.[0]?.text || "").filter(Boolean);
  const notices = (w: any) => wireText(w).filter((t: string) => /time set aside/.test(t));

  it("never arms when the caller did not say how long the interview is", async () => {
    const w = w75();
    const LI = w.win.vyneLiveInterview.create({});
    await LI.start(); await wait(20);
    expect(LI._wrapUpTimer, "armed a countdown against a length nobody set").toBeFalsy();
    expect(w.trace()).not.toMatch(/wrap-up notice armed/);
    LI.stop("finished");
  });

  it("arms when plannedMinutes is given, and says so in the trace", async () => {
    const w = w75({ VYNE_WRAPUP_LEAD_MS: 60000 });
    const LI = w.win.vyneLiveInterview.create({ plannedMinutes: 30 });
    await LI.start(); await wait(20);
    expect(w.trace()).toMatch(/wrap-up notice armed/);
    LI.stop("finished");
  });

  it("sends a ONE-TURN notice naming the choice, not a bare 'time is up'", async () => {
    /*
     * Scoped to the turn for the same reason the renewal nudge is: the previous
     * unscoped nudge became standing behaviour and produced fifty turns opening
     * "I am still here". And it has to offer the alternative — an interview cut
     * off with questions outstanding is the failure being fixed, not the cure.
     */
    const w = w75({ VYNE_WRAPUP_LEAD_MS: 20 });
    const LI = w.win.vyneLiveInterview.create({ plannedMinutes: 0.02 });   // ~1.2s
    await LI.start(); await wait(20);
    await waitFor(() => notices(w).length > 0, "the wrap-up notice to be sent", 3000);

    const notice = notices(w)[0];
    expect(notice).toMatch(/^Just for this one turn/);
    expect(notice).toMatch(/pick it up another time/);
    expect(notice).toMatch(/close the interview properly instead/);
    expect(notice).toMatch(/Do not mention the time again after this turn/);
    LI.stop("finished");
  });

  it("sends it once, not once per handover", async () => {
    const w = w75({ VYNE_WRAPUP_LEAD_MS: 20 });
    const LI = w.win.vyneLiveInterview.create({ plannedMinutes: 0.02 });
    await LI.start(); await wait(20);
    await waitFor(() => notices(w).length > 0, "the wrap-up notice to be sent", 3000);
    LI._sendWrapUp(); LI._sendWrapUp();
    await wait(30);
    /*
     * Count the DECISION, not the frames. open() legitimately resends a line
     * after 12s of total silence (that retry is why the opening lands at all),
     * so asserting on wire frames would make this test a hostage to transport
     * behaviour it is not about. What must happen once is the notice being
     * decided on and logged.
     */
    const decided = (w.trace().match(/sending the wrap-up notice/g) || []).length;
    expect(decided, "the wrap-up was decided more than once").toBe(1);
    LI.stop("finished");
  });

  it("stopping clears the countdown", async () => {
    const w = w75({ VYNE_WRAPUP_LEAD_MS: 60000 });
    const LI = w.win.vyneLiveInterview.create({ plannedMinutes: 30 });
    await LI.start(); await wait(20);
    LI.stop("finished");
    expect(LI._wrapUpTimer).toBeFalsy();
  });
});
