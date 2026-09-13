/**
 * vyne-live.js — the audio and protocol helpers (v5.32.33).
 *
 * The frontend has no test runner, so this loads the real file and EXECUTES
 * it against a minimal window shim, rather than asserting on source text the
 * way the older frontend guards do. Every function here is somewhere a silent
 * audio bug hides: a sample-rate mistake produces a chipmunk voice, a
 * clamping mistake produces clicks, and a base64 mistake produces a hard throw
 * in the middle of a sentence. None of those are visible by reading.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "../../frontend/vyne-live.js");

let I: any;

beforeAll(() => {
  const code = readFileSync(SRC, "utf8");
  const win: any = {
    WebSocket: function () {},
    AudioContext: function () {},
    navigator: { mediaDevices: { getUserMedia: () => {} } },
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
  };
  const sandbox: any = { window: win, navigator: win.navigator, btoa: win.btoa, atob: win.atob,
    setTimeout, clearTimeout, TextDecoder, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  I = win.vyneLive._internals;
});

describe("PCM conversion", () => {
  it("maps the full float range to PCM16 without wrapping", () => {
    const pcm = I.floatTo16BitPCM(new Float32Array([0, 1, -1, 0.5, -0.5]));
    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBe(32767);
    expect(pcm[2]).toBe(-32768);
    expect(pcm[3]).toBeCloseTo(16383, -1);
    expect(pcm[4]).toBeCloseTo(-16384, -1);
  });

  it("clamps out-of-range input instead of wrapping it", () => {
    // Unclamped, +1.5 wraps to a large NEGATIVE value — an audible click on
    // every loud syllable, and the classic cause of "it crackles".
    const pcm = I.floatTo16BitPCM(new Float32Array([1.5, -1.5, 99]));
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
    expect(pcm[2]).toBe(32767);
  });

  it("round-trips through PCM16 within quantisation error", () => {
    const orig = new Float32Array(256);
    for (let i = 0; i < orig.length; i++) orig[i] = Math.sin((i / 256) * Math.PI * 2) * 0.9;
    const back = I.int16ToFloat32(I.floatTo16BitPCM(orig));
    for (let i = 0; i < orig.length; i++) expect(Math.abs(back[i] - orig[i])).toBeLessThan(1e-3);
  });
});

describe("resampling fallback", () => {
  it("produces the right length for 48k → 16k and 44.1k → 16k", () => {
    expect(I.resampleTo(new Float32Array(4800), 48000, 16000).length).toBe(1600);
    expect(I.resampleTo(new Float32Array(4410), 44100, 16000).length).toBe(1600);
  });

  it("is a no-op when the rates already match — the hot path must not touch samples", () => {
    const a = new Float32Array([0.1, 0.2, 0.3]);
    expect(I.resampleTo(a, 16000, 16000)).toBe(a);
  });

  it("preserves a tone's shape rather than aliasing it into noise", () => {
    // 200 Hz at 48 kHz → 16 kHz. A resampler that drops samples instead of
    // interpolating shows up here as a large error, not as an obvious bug.
    const inRate = 48000, freq = 200, n = 4800;
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) src[i] = Math.sin((2 * Math.PI * freq * i) / inRate);
    const out = I.resampleTo(src, inRate, 16000);
    let worst = 0;
    for (let i = 0; i < out.length; i++) {
      const expected = Math.sin((2 * Math.PI * freq * i) / 16000);
      worst = Math.max(worst, Math.abs(out[i] - expected));
    }
    expect(worst).toBeLessThan(0.05);
  });
});

describe("base64 transport", () => {
  it("round-trips binary exactly", () => {
    const bytes = new Uint8Array(512);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
    expect(Array.from(I.base64ToBytes(I.bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it("survives a buffer larger than the String.fromCharCode argument limit", () => {
    // The un-chunked idiom throws RangeError somewhere past ~64k arguments —
    // which in practice means it works in testing and fails on a long answer.
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const round = I.base64ToBytes(I.bytesToBase64(big));
    expect(round.length).toBe(big.length);
    expect(round[199_999]).toBe(big[199_999]);
  });
});

describe("protocol frames", () => {
  it("declares the exact input sample rate the protocol requires", () => {
    const pcm = I.floatTo16BitPCM(new Float32Array(320));
    const frame = I.buildAudioFrame(pcm);
    // A wrong rate here does not error — it plays back at the wrong speed, so
    // the model hears a chipmunk and transcribes nonsense.
    expect(frame.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(I.base64ToBytes(frame.realtimeInput.audio.data).length).toBe(640);
  });

  it("enables transcription in both directions", () => {
    const s = I.buildSetup("gemini-live-2.5-flash-preview");
    // The transcript IS the product — it feeds scoring, synthesis and the deck.
    // Without these the interview is audio nobody can analyse.
    expect(s.setup.inputAudioTranscription).toBeDefined();
    expect(s.setup.outputAudioTranscription).toBeDefined();
    expect(s.setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
  });

  it("does NOT carry a system instruction — the browser must not set the rules", () => {
    // During an interview this page runs in the INTERVIEWEE's browser. A
    // client-supplied instruction would let them rewrite the interviewer's
    // rules, including the one forbidding disclosure of the firm's confidential
    // briefing. The persona is pinned into the token server-side instead.
    const s = I.buildSetup("gemini-live-2.5-flash-preview");
    expect(s.setup.systemInstruction).toBeUndefined();
  });

  it("sends the resolved voice in the setup frame REGARDLESS of pinning", () => {
    // v5.32.47 put speechConfig here only when the token was unpinned, which
    // left a branch nobody could observe: if the mint DID pin and Google then
    // ignored speechConfig inside the token, the voice vanished with no way to
    // tell the two cases apart from outside. Both calls below carry the voice.
    const unpinned = I.buildSetup("models/gemini-2.5-flash-native-audio-latest", "persona text", "Orus");
    expect(unpinned.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Orus");
    const pinned = I.buildSetup("models/gemini-2.5-flash-native-audio-latest", null, "Charon");
    expect(pinned.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Charon");
    // Pinning still governs the INSTRUCTION — that one is a security boundary,
    // because the page runs in the interviewee's browser. The voice is not.
    expect(pinned.setup.systemInstruction).toBeUndefined();
  });

  it("omits speechConfig only when the grant names no voice at all", () => {
    const s = I.buildSetup("models/gemini-2.5-flash-native-audio-latest");
    expect(s.setup.generationConfig.speechConfig).toBeUndefined();
  });

  it("normalises the model id, accepting it with or without the models/ prefix", () => {
    expect(I.buildSetup("gemini-live-2.5-flash-preview").setup.model).toBe("models/gemini-live-2.5-flash-preview");
    expect(I.buildSetup("models/gemini-live-2.5-flash-preview").setup.model).toBe("models/gemini-live-2.5-flash-preview");
  });
});

describe("server frame parsing", () => {
  it("extracts audio, both transcripts and usage from one frame", () => {
    const f = I.parseServerFrame({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "AAA=" } }] },
        inputTranscription: { text: "we have no data platform" },
        outputTranscription: { text: "tell me more about that" },
      },
      usageMetadata: { promptTokenCount: 11, responseTokenCount: 22 },
    });
    expect(f.audio).toEqual(["AAA="]);
    expect(f.userText).toBe("we have no data platform");
    expect(f.agentText).toBe("tell me more about that");
    expect(f.usage.responseTokenCount).toBe(22);
  });

  it("ignores non-audio inline parts rather than feeding them to the speaker", () => {
    const f = I.parseServerFrame({
      serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "image/png", data: "XXXX" } }] } },
    });
    expect(f.audio).toEqual([]);
  });

  it("surfaces interruption, which is the whole point of the duplex path", () => {
    expect(I.parseServerFrame({ serverContent: { interrupted: true } }).interrupted).toBe(true);
    expect(I.parseServerFrame({ serverContent: { turnComplete: true } }).turnComplete).toBe(true);
  });

  it("tolerates empty, partial and malformed frames without throwing", () => {
    for (const bad of [null, undefined, {}, { serverContent: {} }, { serverContent: { modelTurn: {} } }]) {
      expect(() => I.parseServerFrame(bad)).not.toThrow();
    }
  });
});

describe("playback queue", () => {
  /** Minimal AudioContext double — enough to observe scheduling decisions. */
  function fakeCtx() {
    const started: number[] = [];
    const stopped: number[] = [];
    let t = 100;
    return {
      get currentTime() { return t; },
      advance(dt: number) { t += dt; },
      started, stopped,
      createBuffer: (_ch: number, len: number, rate: number) => ({
        length: len, duration: len / rate, getChannelData: () => new Float32Array(len),
      }),
      createBufferSource: () => ({
        buffer: null as any, connect() {},
        start(at: number) { started.push(at); },
        stop() { stopped.push(t); },
        onended: null,
      }),
      destination: {},
    };
  }

  it("schedules chunks back-to-back on the clock, not on onended", () => {
    const ctx = fakeCtx();
    const q = new I.PlaybackQueue(ctx);
    q.push(new Float32Array(24000));   // exactly 1s at 24 kHz
    q.push(new Float32Array(24000));
    q.push(new Float32Array(12000));   // 0.5s
    // Chaining on onended would leave an audible gap between every chunk —
    // the same seam the two-call TTS path has. Consecutive start times must
    // differ by exactly the previous chunk's duration.
    expect(ctx.started[1] - ctx.started[0]).toBeCloseTo(1.0, 5);
    expect(ctx.started[2] - ctx.started[1]).toBeCloseTo(1.0, 5);
  });

  it("never schedules in the past after the context has been running", () => {
    const ctx = fakeCtx();
    const q = new I.PlaybackQueue(ctx);
    q.push(new Float32Array(2400));
    ctx.advance(60);                    // a long silence
    q.push(new Float32Array(2400));
    expect(ctx.started[1]).toBeGreaterThanOrEqual(ctx.currentTime);
  });

  it("barge-in stops every queued source and resets the clock", () => {
    const ctx = fakeCtx();
    const q = new I.PlaybackQueue(ctx);
    q.push(new Float32Array(24000));
    q.push(new Float32Array(24000));
    q.push(new Float32Array(24000));
    expect(q.pending()).toBe(3);
    q.flush();
    // Audio queued ahead of the clock is speech the user has just talked over.
    // Letting it finish is what makes an agent feel deaf.
    expect(ctx.stopped.length).toBe(3);
    expect(q.pending()).toBe(0);
    q.push(new Float32Array(2400));
    expect(ctx.started[3]).toBeGreaterThanOrEqual(ctx.currentTime);
  });
});

describe("shipped file integrity", () => {
  it("still points at the real Google endpoint", () => {
    // frontend/test/live-e2e.mjs REWRITES WS_HOST to a local server so it can
    // drive the client without touching Google. That rewrite must never end up
    // in a release — an app that silently talks to localhost would fail only in
    // production, and only for the voice path.
    const src = readFileSync(SRC, "utf8");
    expect(src).toContain("var WS_HOST = 'wss://generativelanguage.googleapis.com';");
    expect(src).not.toContain("127.0.0.1");
    expect(src).not.toContain("localhost");
  });

  it("carries no API key and reaches our own server for the grant", () => {
    const src = readFileSync(SRC, "utf8");
    // The real key stays server-side; the browser only ever holds a short-lived
    // ephemeral token minted per session.
    expect(src).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
    expect(src).toContain("/api/voice/live-session");
  });
});

/**
 * WIRE CONTRACT — the field paths Google actually reads.
 *
 * Every path asserted here was read off Google's own SDK, @google/genai 2.16.0,
 * dist/index.cjs:
 *
 *   liveConnectConfigToMldev()      — the Live setup frame serializer
 *     responseModalities  → setup.generationConfig.responseModalities
 *     speechConfig        → setup.generationConfig.speechConfig
 *     systemInstruction   → setup.systemInstruction
 *     inputAudioTranscription  → setup.inputAudioTranscription
 *     outputAudioTranscription → setup.outputAudioTranscription
 *
 *   liveConnectConstraintsToMldev() — writes constraints to the wire field
 *                                     `bidiGenerateContentSetup`
 *   convertBidiSetupToTokenSetup()  — then FLATTENS {setup:{...}} to {...}, so
 *                                     the token body carries a bare
 *                                     BidiGenerateContentSetup
 *
 * Why this file and not just the browser e2e: the Live socket does NOT reject a
 * field in the wrong place. It ignores it, completes setup, and speaks in the
 * default voice. So a misplaced field is invisible to any test that only checks
 * "did the session open" — which is how speechConfig sat one level too high for
 * five releases while the interviewer's NAME (correctly placed) worked fine.
 * Right name, wrong voice was the fingerprint.
 */
describe("wire contract with the Gemini Live API", () => {
  /** Resolve a value the way the service does: by path, or not at all. */
  const at = (o: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], o);

  it("puts speechConfig where the service reads it — under generationConfig", () => {
    const s = I.buildSetup("models/gemini-2.5-flash-native-audio-latest", null, "Orus");
    expect(at(s, "setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName"))
      .toBe("Orus");
    // And NOT where it used to be. This is the whole bug in one assertion.
    expect(at(s, "setup.speechConfig")).toBeUndefined();
  });

  it("puts responseModalities under generationConfig, and systemInstruction beside it", () => {
    const s = I.buildSetup("models/x", "persona", "Kore");
    expect(at(s, "setup.generationConfig.responseModalities")).toEqual(["AUDIO"]);
    expect(at(s, "setup.systemInstruction.parts.0.text")).toBe("persona");
    // systemInstruction is NOT nested under generationConfig — different rule
    // from speechConfig, and getting them the same way round is the point.
    expect(at(s, "setup.generationConfig.systemInstruction")).toBeUndefined();
  });

  it("keeps both transcriptions at the top of setup, not under generationConfig", () => {
    const s = I.buildSetup("models/x");
    expect(at(s, "setup.inputAudioTranscription")).toBeDefined();
    expect(at(s, "setup.outputAudioTranscription")).toBeDefined();
    expect(at(s, "setup.generationConfig.inputAudioTranscription")).toBeUndefined();
  });
});
