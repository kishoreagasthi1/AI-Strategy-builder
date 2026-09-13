#!/usr/bin/env node
/**
 * voice-record.mjs — run a real interview through the SHIPPED frontend and
 * record what the interviewee would have heard. (v5.34.42)
 *
 * ── Why this exists, and how it differs from soak-live.mjs ──────────────────
 *
 * `deploy/soak-live.mjs` talks to Google over its own socket with its own
 * handover logic. It measures Google. It cannot tell you whether OUR handover
 * code works, because it does not run OUR handover code — and the 10-minute
 * failure this release fixes lived entirely in ours.
 *
 * `backend/test/liveTurnOwnership.test.ts` runs our real code, but against a
 * fake socket. It proves the logic. It cannot tell you what the thing SOUNDS
 * like.
 *
 * This script is the missing third: the actual shipped `frontend/vyne-live.js`
 * and `frontend/vyne-live-interview.js`, loaded from disk and run unmodified in
 * a vm, against the REAL Gemini Live socket — and every sample the page would
 * have played is written to a WAV you can listen to.
 *
 *   LEFT channel  = the interviewer (what you would hear)
 *   RIGHT channel = the interviewee (what the harness said)
 *
 * Both are on one timeline, so gaps, overlaps, barge-in and the ~1.5 s handover
 * are audible exactly where they happened. A ten-minute recording tells you in
 * ten minutes what a ten-minute live interview tells you — without you being
 * in the room.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   export GEMINI_API_KEY=...                  (the key the API service uses)
 *   node deploy/voice-record.mjs --selftest    ~90 s — DO THIS FIRST
 *   node deploy/voice-record.mjs --minutes 14  crosses one ~10-min handover
 *   node deploy/voice-record.mjs --minutes 25  crosses two
 *
 * Writes, next to itself:
 *   <out>.wav   the recording (stereo, 24 kHz)
 *   <out>.log   the page's own trace — the same lines vyneLiveLogDump() gives
 *   <out>.txt   a turn-by-turn table and a verdict
 *
 * ── What it does NOT prove ──────────────────────────────────────────────────
 *
 * It does not exercise our /api/voice/live-session route: the grant is minted
 * here, directly from Google, in the shape that route returns. So the budget
 * hold, the concurrency cap and the `renewalOf` exemption are NOT under test —
 * deliberately, so that a cap refusal cannot be mistaken for a voice fault.
 * It also does not run the browser's real AudioContext: the playback QUEUE is
 * ours and is under test, the sound card is not.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync,
         openSync, writeSync, readSync, closeSync, statSync, unlinkSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FE = (p) => readFileSync(join(ROOT, "frontend", p), "utf8");

/* ── args ─────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const SELFTEST = has("selftest");
/*
 * --offline: run the whole harness against a LOCAL fake Gemini — no key, no
 * quota, no network. It exists because this harness has a fixture problem by
 * construction: three times already a "catastrophic product failure" turned
 * out to be the test rig (a tone instead of speech, a hardcoded TTS model, a
 * mute uplink). Offline mode proves the rig records, mixes and survives a
 * handover BEFORE a real run is believed. It proves nothing about Google.
 */
const OFFLINE = has("offline");
const MINUTES = SELFTEST ? 1.5 : Number(arg("minutes", 14));
const OUT = arg("out", SELFTEST ? "voice-selftest" : "voice-record");
const MODEL = arg("model", "models/gemini-2.5-flash-native-audio-latest");
const VOICE = arg("voice", "Kore");
const INTERVIEWER = arg("interviewer", "Jack Smith");
const HOST = "generativelanguage.googleapis.com";
const KEY = process.env.GEMINI_API_KEY || "";

const at = (name) => (isAbsolute(OUT) ? `${OUT}.${name}` : join(ROOT, `${OUT}.${name}`));
const OUT_WAV = at("wav");
const OUT_LOG = at("log");
const OUT_TXT = at("txt");
/*
 * Cache answers by a hash of the TEXT, in this script's own directory.
 *
 * The first real run shared `soak-answers/answer-<index>.pcm` with
 * soak-live.mjs, whose answer list is different — so the first five turns
 * streamed soak-live's sentences while this script's log printed its own. The
 * measurements were unaffected (both are real interview speech) but the log
 * described audio that was not being sent, which is the kind of quiet lie a
 * harness must not tell. Keyed by content, a changed sentence regenerates
 * itself and nothing can drift again.
 */
const CACHE = join(ROOT, "voice-answers");
const keyOf = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

const IN_RATE = 16000;      // uplink, protocol-fixed
const OUT_RATE = 24000;     // model audio, protocol-fixed
const FRAME = 2048;         // samples per onaudioprocess call (~128 ms)

if (!KEY && !OFFLINE) {
  console.error("!! GEMINI_API_KEY is not set.\n" +
    "   Get it the same way run-soak.sh does, then:  export GEMINI_API_KEY=...\n" +
    "   Do not paste the key into a chat window.\n" +
    "   (Or run with --offline to check the harness itself, which needs no key.)");
  process.exit(2);
}
if (typeof globalThis.WebSocket !== "function" && !OFFLINE) {
  console.error(`!! this Node (${process.version}) has no global WebSocket. Node 22+ is required.`);
  process.exit(2);
}

const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(7) + "s ";
function say(s) {
  const line = stamp() + s;
  console.log(line);
  try { appendFileSync(OUT_TXT, line + "\n"); } catch {}
}
try { writeFileSync(OUT_TXT, `voice-record ${new Date().toISOString()} model=${MODEL} minutes=${MINUTES}\n`); } catch {}

/* ── the interviewee's side: generated speech, cached ─────────────────────── */

const ANSWERS = [
  "We are a mid-sized manufacturer, about twelve hundred people, and I run technology and data for the group.",
  "We centralised data and analytics roughly two years ago, so most reporting now runs through that one team.",
  "Honestly the biggest constraint is not the tooling. It is that the business side cannot specify what it wants precisely enough to build against.",
  "We have a data warehouse on Snowflake, a handful of Power BI workspaces, and far too many spreadsheets that nobody will admit to owning.",
  "Skills worry me most. We can hire data engineers. Getting the operations managers to trust a model they did not build is the harder problem.",
  "There is no formal governance body yet. Decisions get made in a weekly architecture call and written down afterwards, when someone remembers.",
  "If I am honest, our last two analytics projects went over on time and neither one changed a decision anybody was making.",
  "I would say the appetite is there at the executive level, but the middle layer has seen enough failed pilots to be sceptical.",
];

function resample(src, from, to) {
  if (from === to) return src;
  const ratio = from / to;
  const out = new Int16Array(Math.floor(src.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio, i0 = Math.floor(x), i1 = Math.min(i0 + 1, src.length - 1), f = x - i0;
    out[i] = Math.round(src[i0] * (1 - f) + src[i1] * f);
  }
  return out;
}

async function discoverTtsModel() {
  const r = await fetch(`https://${HOST}/v1beta/models?key=${encodeURIComponent(KEY)}&pageSize=200`);
  if (!r.ok) throw new Error(`ListModels ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const tts = (j.models || []).filter((m) =>
    /tts/i.test(m.name) && (m.supportedGenerationMethods || []).includes("generateContent"));
  const flash = tts.find((m) => /flash/i.test(m.name)) || tts[0];
  if (!flash) throw new Error("no TTS model on this key supports generateContent");
  return flash.name.replace(/^models\//, "");
}

let ttsModel = null;
async function speak(text, index) {
  if (OFFLINE) {
    // A buzz the length the sentence would take. Speech-shaped enough for the
    // offline stand-in's level check, and NOT speech — which is exactly why
    // offline mode can never be used to judge the model (v5.34.34).
    const n = Math.round((text.length / 14) * IN_RATE), pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 3000, (n - i) / 3000);
      pcm[i] = Math.round(Math.sin(i / 9) * Math.sin(i / 700) * env * 8000);
    }
    return pcm;
  }
  void index;
  const cached = join(CACHE, `${keyOf(text)}.pcm`);
  if (existsSync(cached)) {
    const b = readFileSync(cached);
    return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
  }
  if (!ttsModel) { ttsModel = await discoverTtsModel(); say(`TTS model: ${ttsModel}`); }
  const r = await fetch(`https://${HOST}/v1beta/models/${ttsModel}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
      },
    }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new Error("TTS returned no audio");
  const raw = Buffer.from(part.inlineData.data, "base64");
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || "")?.[1] || 24000);
  const pcm = resample(new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2)), rate, IN_RATE);
  try { mkdirSync(CACHE, { recursive: true }); writeFileSync(cached, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)); } catch {}
  return pcm;
}

/* ── the recording: one stereo timeline, written by wall clock ─────────────── */

/**
 * Both channels are addressed by TIME, not by append order, so a gap in the
 * interviewer's speech is a gap in the file. That is the whole point: the
 * failures being chased here — the stop-go choke, the ten-minute silence, the
 * handover pause — are all things you can only judge by when they happen
 * relative to everything else.
 */
/*
 * STREAMED, not buffered.
 *
 * The first version held the whole timeline in memory: two Float32Arrays
 * sized for the run. At 14 minutes that is 170 MB and nobody notices. At 90
 * minutes it is ~1.1 GB, and `writeWav` then allocated another ~500 MB buffer
 * to serialise it — so the run would most likely die AT MINUTE NINETY, in the
 * act of writing the file, losing ninety minutes of evidence and a Live quota
 * with it. The failure would have arrived at the worst possible moment and
 * looked like a product fault.
 *
 * So: keep only a short window in RAM and append finalised audio to a raw PCM
 * file as the clock moves past it. Memory is now constant regardless of run
 * length. Audio is still addressed by TIME — a gap in the interviewer's
 * speech is still a gap in the file — because within the window, writes land
 * at their true offset; only samples older than the window are sealed.
 */
const WINDOW_SEC = 180;                                  // generous: writes land within a few seconds of now
const WINDOW = WINDOW_SEC * OUT_RATE;
const rec = { L: new Float32Array(WINDOW), R: new Float32Array(WINDOW) };
let winStart = 0;                                        // sample index of win[0]
let writtenTo = 0;                                       // highest sample index touched
let lateSamples = 0;
const RAW = at("pcm");
let rawFd = null;
try { rawFd = openSync(RAW, "w"); } catch (e) { console.error(`!! cannot open ${RAW}: ${e.message}`); process.exit(2); }

function writeAt(ch, seconds, samples) {
  const start = Math.round(Math.max(0, seconds) * OUT_RATE);
  if (start < winStart) { lateSamples += samples.length; return; }   // already sealed
  if (start + samples.length > winStart + WINDOW) sealTo(start + samples.length - WINDOW);
  const buf = rec[ch];
  const off = start - winStart;
  const n = Math.min(samples.length, WINDOW - off);
  for (let i = 0; i < n; i++) {
    const v = buf[off + i] + samples[i];
    buf[off + i] = v > 1 ? 1 : v < -1 ? -1 : v;          // mix, clamped
  }
  if (start + n > writtenTo) writtenTo = start + n;
}

/** Append everything before `target` to the raw file and slide the window. */
function sealTo(target) {
  if (target <= winStart) return;
  const count = Math.min(target - winStart, WINDOW);
  const out = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(rec.L[i] * 32767))), i * 4);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(rec.R[i] * 32767))), i * 4 + 2);
  }
  writeSync(rawFd, out);
  rec.L.copyWithin(0, count); rec.L.fill(0, WINDOW - count);
  rec.R.copyWithin(0, count); rec.R.fill(0, WINDOW - count);
  winStart += count;
}

/** Seal continuously so RAM stays flat however long the interview runs. */
setInterval(() => {
  try { sealTo(Math.round((now() - 30) * OUT_RATE)); } catch (e) { /* reported at finish */ }
}, 15000);

function writeWav(path) {
  sealTo(writtenTo);                                     // seal the tail
  try { closeSync(rawFd); } catch {}
  rawFd = null;
  const bytes = (() => { try { return statSync(RAW).size; } catch { return 0; } })();
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + bytes, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(OUT_RATE, 24); h.writeUInt32LE(OUT_RATE * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(bytes, 40);
  // Copy the raw PCM in chunks — never a single half-gigabyte Buffer.
  const wav = openSync(path, "w");
  writeSync(wav, h);
  const src = openSync(RAW, "r");
  const chunk = Buffer.alloc(1 << 22);                   // 4 MB at a time
  let n;
  while ((n = readSync(src, chunk, 0, chunk.length, null)) > 0) writeSync(wav, chunk, 0, n);
  closeSync(src); closeSync(wav);
  try { unlinkSync(RAW); } catch {}
  if (lateSamples) say(`(note: ${(lateSamples / OUT_RATE).toFixed(1)}s of audio arrived later than the ${WINDOW_SEC}s window and was dropped from the recording)`);
  return bytes / 4 / OUT_RATE;
}

/* ── the browser shim ─────────────────────────────────────────────────────── */

const now = () => (Date.now() - t0) / 1000;
let processors = [];
let uplinkQueue = [];                                   // Int16Array chunks to send
const trace = [];

function makeAudioContext(rate) {
  const c = {
    state: "running",
    sampleRate: rate,
    get currentTime() { return now(); },
    resume: async () => {},
    close: async () => {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createScriptProcessor: () => {
      const n = { connect() {}, disconnect() {}, onaudioprocess: null };
      processors.push(n);
      return n;
    },
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createBuffer: (_ch, len, r) => {
      const d = new Float32Array(len);
      return { length: len, sampleRate: r, duration: len / r, getChannelData: () => d, numberOfChannels: 1 };
    },
    createBufferSource: () => {
      const s = {
        buffer: null, onended: null,
        connect() { return this; }, disconnect() {},
        start(when) {
          const at = typeof when === "number" ? when : now();
          if (s.buffer) writeAt("L", at, s.buffer.getChannelData());
          const ms = Math.max(0, (at - now()) * 1000) + (s.buffer ? s.buffer.duration * 1000 : 0);
          setTimeout(() => { try { s.onended && s.onended(); } catch {} }, ms);
        },
        stop() {},
      };
      return s;
    },
    destination: { connect() {} },
  };
  return c;
}

const win = {
  WebSocket: globalThis.WebSocket,
  AudioContext: function (o) { return makeAudioContext((o && o.sampleRate) || IN_RATE); },
  TextDecoder, TextEncoder,
  setTimeout, clearTimeout, setInterval, clearInterval,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  console: {
    ...console,
    log: (...a) => { const s = a.map((x) => (typeof x === "string" ? x : safe(x))).join(" "); trace.push(s); },
  },
  location: { origin: "https://harness.local" },
  addEventListener() {},
  removeEventListener() {},
  localStorage: (() => { const s = {}; return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; } }; })(),
  navigator: {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [],
        getAudioTracks: () => [{ readyState: "live", muted: false, enabled: true, label: "harness",
                                 getSettings: () => ({ sampleRate: IN_RATE }), stop() {} }],
      }),
    },
  },
  VYNE_LIVE_DEBUG: true,
  VYNE_VERSION: (() => { try { return readFileSync(join(ROOT, "VERSION"), "utf8").trim(); } catch { return "?"; } })(),
};
function safe(x) { try { return JSON.stringify(x); } catch { return String(x); } }
win.window = win; win.self = win;

/* The grant. Minted here in the shape /api/voice/live-session returns, so the
 * frontend takes its real path and the cap/budget cannot confuse the result. */
let grantCount = 0;
const grantBodies = [];

async function mint(setupExtra) {
  const setup = {
    model: MODEL,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
    },
    systemInstruction: { parts: [{ text:
      `You are ${INTERVIEWER}, conducting an AI-readiness interview. Ask ONE short question at a ` +
      `time and then wait for the answer. Never summarise the conversation unless asked. Keep every ` +
      `reply under three sentences.` }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { triggerTokens: 25600, slidingWindow: { targetTokens: 12800 } },
    sessionResumption: setupExtra.resumeHandle ? { handle: setupExtra.resumeHandle } : {},
  };
  const r = await fetch(`https://${HOST}/v1alpha/auth_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      bidiGenerateContentSetup: setup,
    }),
  });
  const text = await r.text();
  if (!r.ok) { const e = new Error(`auth_tokens ${r.status}: ${text.slice(0, 300)}`); e.status = r.status; throw e; }
  const j = JSON.parse(text);
  return j.token ?? j.name;
}

win.fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith("/close")) return { ok: true, status: 200, json: async () => ({}) };
  if (u.includes("/api/voice/live-session")) {
    const body = JSON.parse(init.body);
    grantBodies.push(body);
    grantCount++;
    say(`grant #${grantCount} requested` +
        (body.resumeHandle ? ` (resuming, handle ${String(body.resumeHandle).slice(0, 12)}…)` : " (fresh)") +
        (body.renewalOf ? ` continuing ${body.renewalOf}` : ""));
    try {
      const token = await mint(body);
      return { ok: true, status: 200, json: async () => ({
        token, model: MODEL, voice: VOICE, pinned: true, maxSeconds: 1800,
        sessionId: `harness-${grantCount}`,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        pinnedExtras: { transcription: true, manualVad: false, resumption: true, compression: true,
                        resumed: !!body.resumeHandle },
      }) };
    } catch (e) {
      say(`!! grant mint FAILED: ${e.message}`);
      return { ok: false, status: e.status || 500, json: async () => ({ error: "mint_failed", detail: e.message }) };
    }
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

/* ── offline: a local stand-in for Gemini ─────────────────────────────────── */

/**
 * Speaks a short buzz per turn so the recording has something audible in it,
 * answers when the uplink goes quiet, and issues a goAway after OFFLINE_GOAWAY
 * so the handover path runs end to end. Deliberately dumb: its job is to prove
 * the harness plumbing, not to imitate a model.
 */
const OFFLINE_GOAWAY_MS = Number(arg("offline-goaway", 25000));

/*
 * v5.34.47 — FAULT INJECTION, offline only.
 *
 *   --offline-fail-mints 3
 *
 * Refuse the next N grant requests AFTER the opening one, the way a dead
 * network does: a 500 with no refusal code, which isTransientRenewFailure()
 * classifies as transport and therefore retries.
 *
 * This exists because every line v5.34.47 changed sits on the failure path.
 * A clean run of ANY length — fourteen minutes or ninety — never executes
 * them. The .46 backoff bug was found only because a real Wi-Fi drop happened
 * to occur during a run, which is not a test strategy. This makes that event
 * reproducible in about two minutes, for nothing, with no quota spent.
 *
 * The gaps between attempts are timed and judged at the end of the run, so
 * the double-counted backoff cannot come back unnoticed: it did not fail any
 * assertion when it shipped, it just made every gap twice what the log said.
 */
const OFFLINE_FAIL_MINTS = Number(arg("offline-fail-mints", 0));
let mintAttempts = 0;
let mintFailuresLeft = OFFLINE_FAIL_MINTS;
const mintAt = [];                       // seconds since t0, one per ATTEMPT
let renewalsAtFaultEnd = 0;              // handover count when the burst ended

if (OFFLINE) {
  win.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/close")) return { ok: true, status: 200, json: async () => ({}) };
    mintAttempts++;
    mintAt.push(now());
    if (mintAttempts > 1 && mintFailuresLeft > 0) {
      mintFailuresLeft--;
      // Snapshot the handover count as the burst ends: every attempt in it
      // belonged to ONE handover, and .46 counted each as a new one.
      if (mintFailuresLeft === 0) renewalsAtFaultEnd = renewals;
      say(`grant attempt ${mintAttempts} REFUSED by the offline stub ` +
          `(injected transport fault; ${mintFailuresLeft} more to inject)`);
      return { ok: false, status: 500,
               json: async () => ({ error: "mint_failed", detail: "offline fault injection" }) };
    }
    grantCount++;
    say(`grant #${grantCount} (offline stub)`);
    return { ok: true, status: 200, json: async () => ({
      token: "offline", model: MODEL, voice: VOICE, pinned: true, maxSeconds: 1800,
      sessionId: `offline-${grantCount}`,
      pinnedExtras: { transcription: true, manualVad: false, resumption: true, compression: true, resumed: false },
    }) };
  };
  win.WebSocket = function (url) {
    const ws = this;
    ws.url = url; ws.readyState = 0; ws.binaryType = "";
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    const frame = (o) => ws.onmessage && ws.onmessage({ data: JSON.stringify(o) });
    let quiet = 0, spoke = false, closed = false;
    ws.send = (d) => {
      let o; try { o = JSON.parse(d); } catch { return; }
      if (o.realtimeInput?.audio?.data) {
        const b = Buffer.from(o.realtimeInput.audio.data, "base64");
        const pcm = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
        let peak = 0; for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
        if (peak > 2000) { quiet = 0; spoke = true; }
        else if (spoke && ++quiet > 8) { spoke = false; quiet = 0; setTimeout(reply, 600); }
      }
      if (o.clientContent) setTimeout(reply, 700);       // a text nudge gets an answer too
    };
    ws.close = () => { if (closed) return; closed = true; ws.readyState = 3; ws.onclose && ws.onclose({ code: 1000, reason: "client" }); };
    function reply() {
      if (closed) return;
      frame({ serverContent: { modelTurn: { parts: [{ text: "Thinking about that." }] } } });
      const dur = 2.2, n = Math.round(dur * OUT_RATE), pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        const env = Math.min(1, i / 2000, (n - i) / 2000);
        pcm[i] = Math.round(Math.sin(i / 11) * Math.sin(i / 900) * env * 7000);
      }
      const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
      for (let o = 0; o < n; o += OUT_RATE / 4) {
        const part = pcm.subarray(o, Math.min(o + OUT_RATE / 4, n));
        setTimeout(() => closed || frame({ serverContent: { modelTurn: { parts: [{ inlineData: {
          mimeType: `audio/pcm;rate=${OUT_RATE}`,
          data: Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString("base64") } }] } } }),
          (o / OUT_RATE) * 1000);
      }
      setTimeout(() => closed || frame({ serverContent: { turnComplete: true } }), dur * 1000 + 100);
      void b64;
    }
    setTimeout(() => {
      ws.readyState = 1; ws.onopen && ws.onopen();
      setTimeout(() => frame({ setupComplete: {} }), 30);
      setTimeout(() => closed || frame({ goAway: { timeLeft: "8s" } }), OFFLINE_GOAWAY_MS);
    }, 20);
  };
  win.WebSocket.OPEN = 1;
}

const ctx = vm.createContext(win);
vm.runInContext(FE("vyne-live.js"), ctx, { filename: "vyne-live.js" });
vm.runInContext(FE("vyne-live-interview.js"), ctx, { filename: "vyne-live-interview.js" });
say(`loaded shipped frontend v${win.VYNE_VERSION} (vyne-live.js + vyne-live-interview.js)`);

/* ── the uplink pump: real frames through the real ScriptProcessor path ───── */

/**
 * The browser calls onaudioprocess every ~128 ms whether or not anyone is
 * speaking, and v5.34.38 proved that matters: a harness that goes MUTE while
 * waiting inflates reply latency by an order of magnitude, because the model
 * never sees the silence that closes a turn. So this pump never stops.
 */
let pumpTimer = null;
function startPump() {
  const frameMs = (FRAME / IN_RATE) * 1000;
  pumpTimer = setInterval(() => {
    const node = processors[processors.length - 1];
    if (!node || !node.onaudioprocess) return;
    const f = new Float32Array(FRAME);
    const chunk = uplinkQueue.length ? uplinkQueue.shift() : null;
    if (chunk) {
      for (let i = 0; i < FRAME && i < chunk.length; i++) f[i] = chunk[i] / 32768;
      writeAt("R", now(), f.length === FRAME ? resampleF(f, IN_RATE, OUT_RATE) : f);
    }
    try { node.onaudioprocess({ inputBuffer: { getChannelData: () => f } }); } catch (e) { say(`pump threw: ${e.message}`); }
  }, frameMs);
}
function resampleF(src, from, to) {
  if (from === to) return src;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(src.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio, i0 = Math.floor(x), i1 = Math.min(i0 + 1, src.length - 1), f = x - i0;
    out[i] = src[i0] * (1 - f) + src[i1] * f;
  }
  return out;
}
function enqueueAnswer(pcm) {
  for (let i = 0; i < pcm.length; i += FRAME) uplinkQueue.push(pcm.subarray(i, Math.min(i + FRAME, pcm.length)));
}

/* ── drive the interview ──────────────────────────────────────────────────── */

const turns = [];
let state = "idle";
let speakingSince = null;
let askedAt = null;
let answerIndex = 0;
let firstAudioAt = null;
let ended = null;
let renewals = 0;
let renewRetries = 0;   // retries inside the CURRENT handover (v5.34.47)
let silentRenewals = 0;
let chokes = 0;                 // interrupted while we were not speaking
let lastTurnCompleteAt = 0;
/* Set the instant finish() starts. Guards the periodic trace flush, and makes
 * finish() itself idempotent — three signal handlers and a timer can all reach
 * it, and writing the WAV twice would corrupt it. */
let finished = false;

const LI = win.vyneLiveInterview.create({
  module: "interview_agent",
  interviewerName: INTERVIEWER,
  voice: VOICE,
  clientName: "Harness Manufacturing",
  intervieweeName: "Alex Interviewee",
  intervieweeRole: "Head of Technology and Data",
  industry: "Manufacturing",
  onTurnState: (s) => {
    const prev = state; state = s;
    if (s === "speaking" && prev !== "speaking") {
      speakingSince = now();
      if (firstAudioAt === null) { firstAudioAt = now(); say(`first interviewer audio at ${firstAudioAt.toFixed(1)}s`); }
      if (askedAt !== null) {
        const lat = now() - askedAt;
        turns.push({ n: turns.length + 1, latency: lat, at: now() });
        say(`reply ${turns.length}: ${lat.toFixed(1)}s after the answer ended`);
        askedAt = null;
      }
    }
    if (s === "idle" && prev === "speaking") {
      lastTurnCompleteAt = now();
      // Answer the question after a beat, the way a person does.
      setTimeout(nextAnswer, 900);
    }
  },
  /*
   * v5.34.47 — one handover, one "starting" line.
   *
   * onRenewing fires once per ATTEMPT, and a transport retry re-enters it with
   * reason 'reconnecting'. The v5.34.46 trace therefore printed
   * "— handover #1 starting —" four times for what was one handover with three
   * retries, which read like four separate handovers in the log and in the
   * summary. Count the handover on the first attempt; call the rest retries.
   */
  onRenewing: (n, reason) => {
    if (reason === "reconnecting") {
      renewRetries++;
      say(`— handover #${n}: still reconnecting (retry ${renewRetries}) —`);
      return;
    }
    renewals = n;
    renewRetries = 0;
    say(`— handover #${n} starting (this is the ~10-minute one) —`);
  },
  onRenewed: () => {
    say(renewRetries
      ? `— handover complete after ${renewRetries} retr${renewRetries === 1 ? "y" : "ies"}, interview continues —`
      : `— handover complete, interview continues —`);
    renewRetries = 0;
  },
  onRenewSilent: () => { silentRenewals++; say(`!! the renewed session did not speak — dropping the handle and reconnecting`); },
  onQuotaExhausted: () => { say(`!! GOOGLE IS RATE-LIMITING THIS PROJECT — the run below is INVALID FOR COMPARISON`); },
  onReplyWithoutAudio: () => { say(`!! a reply arrived as text with no voice`); },
  onAgentText: () => {},
  /*
   * A DEAD INTERVIEW ENDS THE RUN. It does not sit recording silence.
   *
   * Twice tonight this cost a run its evidence: the interview died at minute
   * five, and the harness went on streaming silence for another hour with the
   * trace held in memory, unwritten. The whole point of the trace is to
   * explain a failure, and it was being withheld precisely when a failure had
   * happened. A short grace period catches any trailing frames, then we write
   * everything out and stop.
   */
  onEnded: (r) => {
    ended = r;
    say(`interview ENDED: ${r}`);
    setTimeout(() => finish(`the interview ended (${r}) — not waiting out the remaining time`), 3000);
  },
  onError: (r) => say(`onError: ${r}`),
});

/*
 * ONE answer in flight, ever.
 *
 * Found by the offline run: the handover produces a second idle transition, so
 * two answers were enqueued three seconds apart. The uplink drains in real
 * time, so the second answer sat behind the first and the reply that followed
 * it was timed from the wrong moment — a clean 8.4 s "degradation" that was
 * entirely the harness. Guard on the QUEUE, not just on the async section:
 * the answer is not over when the function returns, it is over when the last
 * frame has gone out.
 */
let answering = false;
async function nextAnswer() {
  if (answering || ended || Date.now() - t0 > MINUTES * 60000) return;
  if (uplinkQueue.length) { say(`(skipping a duplicate answer cue — ${uplinkQueue.length} frames still on the uplink)`); return; }
  answering = true;
  try {
    const text = ANSWERS[answerIndex % ANSWERS.length];
    answerIndex++;
    const pcm = await speak(text, answerIndex - 1);
    say(`answering (${(pcm.length / IN_RATE).toFixed(1)}s): "${text.slice(0, 58)}…"`);
    enqueueAnswer(pcm);
    // The answer is "over" once the queue drains; the model's VAD closes the
    // turn a beat later. Latency is measured from there, not from now.
    // askedAt is set when the uplink has actually DRAINED, not on a timer that
    // assumes it did — a backed-up queue would otherwise shift every latency
    // after it and look exactly like the model getting slower.
    const waitForDrain = setInterval(() => {
      if (uplinkQueue.length === 0) { clearInterval(waitForDrain); askedAt = now(); answering = false; }
    }, 120);
  } catch (e) {
    say(`!! could not produce an answer: ${e.message}`);
    answering = false;
  }
}

/* The choke signature, measured rather than guessed: the model stops its own
 * playback while the interviewee is NOT speaking. That is the self-cancelling
 * agent (S3) the project opened with and the 5.34.40 regression reproduced. */
const origFlags = win.vyneLiveFlags ? win.vyneLiveFlags() : {};
setInterval(() => {
  const s = LI.session;
  if (!s) return;
  if (s._turnWasInterrupted && uplinkQueue.length === 0 && state !== "idle") chokes++;
}, 500);

/* ── run ──────────────────────────────────────────────────────────────────── */

function finish(why) {
  if (finished) return;
  finished = true;
  try { clearInterval(pumpTimer); } catch {}
  try { LI.stop("page_unload"); } catch {}
  const secs = writeWav(OUT_WAV);
  try {
    const dump = win.vyneLiveLogDump ? String(win.vyneLiveLogDump()) : trace.join("\n");
    writeFileSync(OUT_LOG, dump);
  } catch (e) { try { writeFileSync(OUT_LOG, trace.join("\n")); } catch {} }

  const lat = turns.map((t) => t.latency);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const half = Math.ceil(lat.length / 2);
  say("");
  say("──────────────────────────────── verdict ────────────────────────────────");
  /*
   * Judge the injected-fault run here rather than leaving the numbers to be
   * read by eye. The .46 bug produced a PASSING run — it recovered, it just
   * took twice as long as it claimed — so the only thing that catches it is
   * an explicit comparison against the schedule the code says it is using.
   */
  function faultVerdict() {
    // What the shipped constants say the schedule should be: 4s, 8s, 16s,
    // capped at 20s. RENEW_RETRY_MS / RENEW_RETRY_MAX_MS in
    // vyne-live-interview.js, both overridable on window.
    const base = (win.VYNE_RENEW_RETRY_MS || 4000) / 1000;
    const cap = (win.VYNE_RENEW_RETRY_MAX_MS || 20000) / 1000;
    /*
     * Measure ONLY the injected burst. mintAt[0] is the opening grant,
     * mintAt[1] the renewal attempt that was refused, and the next
     * OFFLINE_FAIL_MINTS entries are its retries. Everything after that is
     * the normal goAway cycle continuing, whose gaps are the goAway interval
     * and have nothing to do with the backoff — the first version of this
     * function counted those too and reported a FAIL on a clean run.
     */
    const burst = mintAt.slice(1, 2 + OFFLINE_FAIL_MINTS);
    const retryGaps = burst.slice(1).map((t, i) => t - burst[i]);
    if (!retryGaps.length) return `fault injection:  NO RETRY HAPPENED — expected ${OFFLINE_FAIL_MINTS}. FAIL.`;
    const lines = [];
    let bad = 0;
    retryGaps.forEach((gap, i) => {
      const want = Math.min(cap, base * Math.pow(2, i));
      // Generous window: timers are not precise, but a DOUBLED backoff
      // (2x want) sits far outside it, which is the whole point.
      const ok = gap >= want * 0.7 && gap <= want * 1.45;
      if (!ok) bad++;
      lines.push(`  retry ${i + 1}: waited ${gap.toFixed(1)}s, expected ~${want.toFixed(1)}s  ${ok ? "ok" : "<< WRONG"}`);
    });
    const recovered = grantCount >= 2;
    // The label check: the whole burst belonged to ONE handover. .46 counted
    // each attempt as a new one, so this was 4 where it should have been 1.
    const labelOk = renewalsAtFaultEnd === 1;
    return `fault injection:  ${OFFLINE_FAIL_MINTS} mint(s) refused, ${retryGaps.length} retry gap(s) measured\n`
      + lines.join("\n")
      + `\n  recovered: ${recovered ? "yes — the interview continued" : "NO — the interview died. FAIL."}`
      + `\n  handover label: ${renewalsAtFaultEnd} handover(s) counted across `
      + `${retryGaps.length + 1} attempt(s)  ${labelOk ? "ok" : "<< WRONG"}`
      + `\n  ${bad === 0 && recovered && labelOk ? "PASS" : "FAIL"}`;
  }
  say(`stopped because: ${why}${ended ? ` (interview ended: ${ended})` : ""}`);
  say(`recording:       ${OUT_WAV}  (${(secs / 60).toFixed(1)} min, L=interviewer R=interviewee)`);
  say(`page trace:      ${OUT_LOG}`);
  say(`grants minted:   ${grantCount}   handovers: ${renewals}   mute handovers recovered: ${silentRenewals}`);
  say(`replies:         ${turns.length}`);
  if (OFFLINE_FAIL_MINTS) say(faultVerdict());
  if (lat.length) {
    say(`first reply:     ${lat[0].toFixed(1)}s`);
    say(`latency mean:    first half ${mean(lat.slice(0, half)).toFixed(1)}s → second half ${mean(lat.slice(half)).toFixed(1)}s`);
    say(`latency worst:   ${Math.max(...lat).toFixed(1)}s`);
  }
  say(`first audio:     ${firstAudioAt === null ? "NEVER — the interviewer never spoke" : firstAudioAt.toFixed(1) + "s"}`);
  if (!turns.length && firstAudioAt === null) {
    say("!! nothing was heard at all. Before believing this is a product fault, check the trace");
    say("   for 'grant REFUSED', 'auth_tokens', or a rate-limit close — a broken harness and a");
    say("   broken product look identical from here, and this one has been wrong three times.");
  }
  if (renewals === 0 && MINUTES >= 12) {
    say("!! no handover happened in a run long enough to need one — the ten-minute path was NOT exercised.");
  }
  say("Listen to the WAV. The things to judge by ear: does the voice stop and start mid-sentence,");
  say("is there a long hole after each handover, and does it still answer after minute ten.");
  say("─────────────────────────────────────────────────────────────────────────");
  process.exit(0);
}

/*
 * EVERY way this process can be asked to stop must write the evidence.
 *
 * SIGINT alone was not enough. A plain `kill` sends SIGTERM, which had no
 * handler — so the default action killed the process outright and a
 * 38-minute run lost its entire trace. `kill` is the obvious thing for a
 * person to type; a harness that discards its findings when you type it is
 * not a harness.
 */
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => finish(`stopped by ${sig}`));
}

/*
 * And a belt to that brace: flush the trace to disk every 60 seconds, so even
 * SIGKILL — or a machine going to sleep and never waking the process — leaves
 * everything up to the last minute. The trace is the only artefact that
 * explains WHY something failed, and it was the one thing not being written
 * as it went.
 */
setInterval(() => {
  if (finished) return;
  try {
    const dump = win.vyneLiveLogDump ? String(win.vyneLiveLogDump()) : trace.join("\n");
    writeFileSync(OUT_LOG, dump);
  } catch { /* best effort — never let a flush failure stop the run */ }
}, 60000);

say(`starting: ${MINUTES} minutes, model ${MODEL}, voice ${VOICE}, interviewer "${INTERVIEWER}"`);
if (SELFTEST) say("SELFTEST: ~90 seconds, just enough to prove the harness hears a voice. No handover.");

/*
 * Generate every answer BEFORE the interview starts.
 *
 * The first real run discovered the TTS model mid-interview and then spent 100
 * seconds synthesising answer six while the session sat idle — a hole in the
 * recording that nothing in the product put there, in the exact place a reader
 * would blame the product for it. Pay that cost up front, where it is visible
 * and cannot be mistaken for anything else.
 */
async function pregenerate() {
  if (OFFLINE) return;
  say(`generating ${ANSWERS.length} interviewee answers (cached after the first run)…`);
  for (let i = 0; i < ANSWERS.length; i++) {
    try {
      const pcm = await speak(ANSWERS[i], i);
      say(`  answer ${i + 1}: ${(pcm.length / IN_RATE).toFixed(1)}s`);
    } catch (e) {
      say(`!! answer ${i + 1} could not be generated: ${e.message}`);
      if (i === 0) { say("!! no interviewee audio at all — stopping before wasting a Live session"); process.exit(3); }
      break;
    }
  }
}

startPump();
await pregenerate();
LI.start().then(() => {
  /*
   * Open exactly as interview_agent.html does — the SHORT trigger, through
   * open(), with the same _openingSent bookkeeping. A long instruction sent as
   * a user turn makes the native-audio model reply in TEXT and the interview
   * opens silently (see the comment above _openingLine in the page); a harness
   * that opened differently would be testing a path nobody ships.
   */
  if (!LI._openingSent) {
    let sent = false;
    try { sent = LI.open("Please begin the interview now.") !== false; }
    catch (e) { say(`!! open() threw: ${e.message}`); }
    LI._openingSent = sent;
    say(`opening sent through open(): ${sent}`);
  }
  say("live session up — waiting for the interviewer to speak");
  setTimeout(() => {
    if (firstAudioAt === null) say("!! 45s and still no audio — see the trace; this is the warmup-window failure if the nudge was dropped");
  }, 45000);
}).catch((e) => {
  say(`!! could not start: ${e && (e.code || e.message)}`);
  finish("start failed");
});

setTimeout(() => finish(`reached the ${MINUTES}-minute limit`), MINUTES * 60000 + 5000);
