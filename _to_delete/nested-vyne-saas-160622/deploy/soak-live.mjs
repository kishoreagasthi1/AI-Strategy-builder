#!/usr/bin/env node
/**
 * soak-live.mjs — a 90–120 minute live interview, run unattended, against the
 * REAL Gemini Live API (v5.34.39).
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * Every long-session failure so far cost a person an hour of talking to find,
 * and the answer to "does a two-hour deep dive hold up?" cannot be got any
 * other way — the vitest soak (backend/test/liveLongSessionSoak.test.ts) fakes
 * the socket, so it proves our handover logic and nothing about Google's
 * behaviour at minute ninety. This script talks to the real thing with no
 * human in the room: it streams audio, waits for replies, rides the ~10-minute
 * goAway handovers with a resumption handle, and prints a table of every turn
 * with the latency it took.
 *
 * Start it and walk away. It writes progress as it goes, so an interrupted run
 * still has its data.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   export GEMINI_API_KEY=...              # the key the API service uses
 *   node deploy/soak-live.mjs                      # 120 minutes, default
 *   node deploy/soak-live.mjs --minutes 20         # a short shakedown first
 *   node deploy/soak-live.mjs --wav answers.wav    # real speech, 16 kHz mono
 *   node deploy/soak-live.mjs --model models/gemini-2.5-flash-native-audio-latest
 *
 * ── Comparing runs (read this before believing a difference) ────────────────
 *
 * v5.34.38: runs in a SEQUENCE are not independent. Three consecutive
 * 10-minute runs gave first-turn latencies of 1.1 s, 38 s and 62 s while the
 * flags varied — an ordering effect far larger than anything the flags could
 * explain, most likely the project being throttled as Live sessions
 * accumulate. Any A/B here must therefore run the same configuration first and
 * last (`--out base.txt` … `--out base2.txt`) and compare those two before
 * trusting the variants in between. The verdict now prints the first-turn
 * latency and per-quarter means so an ordering effect is impossible to miss.
 *
 * ── The audio has to be real speech (learned the hard way) ─────────────────
 *
 * v5.34.34: the first version streamed synthesised speech-band TONE and I
 * claimed that would "exercise turn detection". It does not. The first real
 * run transcribed NOTHING and got no reply on any turn — the model never
 * detected a turn at all, so every line read "NO REPLY" and the soak looked
 * like a catastrophic product failure when it was a broken fixture. Worse, a
 * session with no valid turn gets aborted by the server (close 1008) after a
 * few minutes, which then looks like a second bug.
 *
 * So the default is now GENERATED SPEECH: the same Gemini TTS the product
 * already uses (backend/src/llm/tts.ts) speaks a handful of interview answers,
 * cached to disk on first run, and those are what get streamed. One API key
 * does both halves, nobody has to record anything, and the model hears real
 * words. `--wav file.wav` still takes your own recording (16-bit PCM mono
 * 16 kHz); `--tone` forces the old behaviour, which is now only useful for
 * testing the socket plumbing.
 *
 * ── What it asserts ─────────────────────────────────────────────────────────
 *
 * Nothing — it MEASURES, and prints a verdict. A soak that fails an assertion
 * halfway tells you less than one that finishes and shows where it degraded.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i === -1 ? dflt : args[i + 1];
};
const flag = (name) => args.includes("--" + name);

const KEY = process.env.GEMINI_API_KEY || "";
const MINUTES = Number(arg("minutes", 120));
const MODEL = arg("model", process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview");
const WAV = arg("wav", "");
const TONE = flag("tone");
const CACHE = arg("cache", "soak-answers");
/**
 * v5.34.35: DISCOVERED, not guessed.
 *
 * 5.34.34 hard-coded `gemini-2.5-flash-tts` — the default in the product's own
 * tts.ts — and the real run got a 404: that name does not exist for this key
 * on v1beta. Guessing a second name from a sandbox that cannot reach the API
 * would be the same mistake twice, so the script now asks ListModels which TTS
 * models the key actually has and picks one. `--tts-model NAME` overrides.
 */
let TTS_MODEL = arg("tts-model", process.env.GEMINI_TTS_MODEL || "");
const THINK_LEVEL = arg("thinking-level", "");
const THINK_BUDGET = args.includes("--thinking-budget") ? Number(arg("thinking-budget", 0)) : null;
const NO_COMPRESS = flag("no-compress");
const COMPRESS_TRIGGER = Number(arg("compress-trigger", 25600));
const VAD_END = arg("vad-end", "");
const VAD_SILENCE = args.includes("--vad-silence") ? Number(arg("vad-silence", 0)) : 0;
const OUT = arg("out", "soak-live-report.txt");
const HOST = "generativelanguage.googleapis.com";
const INPUT_RATE = 16000;
const FRAME_SAMPLES = 2048;              // same frame size the browser sends
const FRAME_MS = (FRAME_SAMPLES / INPUT_RATE) * 1000;

if (!KEY) {
  console.error("GEMINI_API_KEY is not set. Export the key the API service uses, then re-run.");
  process.exit(2);
}

/* ── report ──────────────────────────────────────────────────────────────── */

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(7) + "s";
const rows = [];
function say(line) {
  const s = `[${el()}] ${line}`;
  console.log(s);
  try { appendFileSync(OUT, s + "\n"); } catch {}
}
try { writeFileSync(OUT, `soak-live ${new Date().toISOString()} model=${MODEL} minutes=${MINUTES}\n`); } catch {}

/* ── audio ───────────────────────────────────────────────────────────────── */

/**
 * The answers the fake interviewee gives. Deliberately the kind of thing a
 * real stakeholder says — long enough to be a turn, specific enough that an
 * off-topic reply is obvious in the report.
 */
const ANSWERS = [
  "We centralised data and analytics about two years ago, and most reporting now runs through that team. " +
  "There are still federated analysts inside marketing and operations who build their own models.",
  "The biggest constraint is not tooling, it is that our master data is inconsistent across regions, " +
  "so any model we build has to be reconciled by hand before anyone trusts the output.",
  "We have run three pilots. One for demand forecasting, one for supplier risk, and one on customer " +
  "service summarisation. Only the forecasting one has made it into day to day operations.",
  "Governance sits with a steering committee that meets monthly. In practice the review happens late, " +
  "after a team has already built something, which slows everything down.",
  "Skills are the part I worry about most. We can hire data engineers, but the business side does not " +
  "yet know what to ask for, so requirements arrive half formed.",
];

const INPUT_RATE_TTS = 24000;   // what Gemini TTS returns

/** Linear-interpolated resample. 24 kHz TTS output → the 16 kHz uplink. */
function resample(src, fromRate, toRate) {
  if (fromRate === toRate) return src;
  const ratio = fromRate / toRate;
  const out = new Int16Array(Math.floor(src.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x), i1 = Math.min(src.length - 1, i0 + 1), f = x - i0;
    out[i] = Math.round(src[i0] * (1 - f) + src[i1] * f);
  }
  return out;
}

/** Speak one answer with the product's own TTS model. Returns 16 kHz PCM16. */
async function speak(text, index) {
  const cached = `${CACHE}/answer-${index}.pcm`;
  try {
    const b = readFileSync(cached);
    return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
  } catch { /* not cached yet */ }

  const r = await fetch(`https://${HOST}/v1beta/models/${TTS_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
      },
    }),
  });
  if (!r.ok) throw new Error(`tts ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const inline = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!inline?.data) throw new Error("tts: no audio in response");
  const rateMatch = /rate=(\d+)/.exec(inline.mimeType ?? "");
  const raw = Buffer.from(inline.data, "base64");
  const pcm24 = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  const pcm16 = resample(pcm24, rateMatch ? Number(rateMatch[1]) : INPUT_RATE_TTS, INPUT_RATE);
  try {
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(cached, Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength));
  } catch { /* cache is a convenience, not a requirement */ }
  return pcm16;
}

/**
 * Which TTS model does this key actually have? Preference order: a flash TTS
 * model (cheapest and quickest), then any TTS model that supports
 * generateContent. Names change; capabilities are what to select on.
 */
async function discoverTtsModel() {
  const r = await fetch(`https://${HOST}/v1beta/models?pageSize=1000`, {
    headers: { "x-goog-api-key": KEY },
  });
  if (!r.ok) throw new Error(`ListModels ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const all = (await r.json()).models || [];
  const tts = all.filter((m) =>
    /tts/i.test(m.name || "") &&
    (m.supportedGenerationMethods || []).includes("generateContent"));
  if (!tts.length) {
    throw new Error("this key has no TTS model that supports generateContent. " +
      "Run with --wav yourrecording.wav instead, or --tone to test the socket only. " +
      "Models seen: " + all.map((m) => m.name).filter((n) => /tts|audio/i.test(n)).join(", "));
  }
  const pick = tts.find((m) => /flash/i.test(m.name)) || tts[0];
  say(`TTS models available to this key: ${tts.map((m) => m.name).join(", ")}`);
  say(`using ${pick.name}`);
  return pick.name.replace(/^models\//, "");
}

/** 16-bit PCM mono 16 kHz from the user's own WAV. */
function loadWav() {
  const b = readFileSync(WAV);
  const i = b.indexOf(Buffer.from("data"));
  if (i === -1) throw new Error(`${WAV}: no data chunk — is it a PCM WAV?`);
  const pcm = b.subarray(i + 8);
  say(`loaded ${WAV}: ${(pcm.length / 2 / INPUT_RATE).toFixed(1)}s ` +
      `(assumed PCM16 mono ${INPUT_RATE}Hz; re-encode with: ` +
      `ffmpeg -i in.wav -ar 16000 -ac 1 -c:a pcm_s16le out.wav)`);
  return [new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))];
}

/** Speech-band tone. Kept only for plumbing tests — the model hears no words. */
function tonePcm(seconds = 12) {
  const n = seconds * INPUT_RATE;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / INPUT_RATE;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t);
    const v = Math.sin(2 * Math.PI * 130 * t) * 0.5
            + Math.sin(2 * Math.PI * 700 * t) * 0.3
            + Math.sin(2 * Math.PI * 1800 * t) * 0.2;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * env * 9000)));
  }
  return [out];
}

/** Every answer clip, in the order they will be spoken. */
async function loadAnswers() {
  if (WAV) return loadWav();
  if (TONE) {
    say("--tone: streaming speech-band TONE. The model cannot transcribe this, so it will " +
        "NOT answer. Use this only to check the socket, handovers and closes.");
    return tonePcm();
  }
  if (!TTS_MODEL) TTS_MODEL = await discoverTtsModel();
  say(`generating ${ANSWERS.length} spoken answers with ${TTS_MODEL} (cached in ${CACHE}/)`);
  const clips = [];
  for (let i = 0; i < ANSWERS.length; i++) {
    const pcm = await speak(ANSWERS[i], i);
    clips.push(pcm);
    say(`  answer ${i + 1}: ${(pcm.length / INPUT_RATE).toFixed(1)}s`);
  }
  return clips;
}

const b64 = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).toString("base64");
const silence = new Int16Array(FRAME_SAMPLES);

/* ── the ephemeral token, exactly as the backend mints it ────────────────── */

/**
 * v5.34.36 — the setup is now an EXPERIMENT, not a fixed shape.
 *
 * The first valid run showed reply latency climbing 1s → 12.7s → 18.6s →
 * 40.6s inside four minutes of conversation, which is the same curve the human
 * tests reported by ear. That is a measurement, not a cause, and the three
 * candidate causes each correspond to one setup field:
 *
 *   thinking      --thinking-level LOW | --thinking-budget 0
 *                 3.1 Live controls reasoning with thinkingLevel, 2.5 with
 *                 thinkingBudget. Which one this model ACCEPTS is reported
 *                 below rather than assumed — the product currently pins
 *                 thinkingBudget, which a 3.1 model may simply reject.
 *   context       --no-compress | --compress-trigger N
 *                 A 25600-token trigger cannot fire in four minutes of audio
 *                 (~25 tokens/second each way), so if latency climbs before
 *                 then, compression is not the lever people assume it is.
 *   turn taking   --vad-end LOW|HIGH --vad-silence MS
 *
 * Every attempt logs whether the field survived: auth_tokens rejects an
 * unknown field with a 400 naming it, so one run answers "does this model even
 * support that knob" — the question two releases were spent guessing at.
 */
async function mint(resumeHandle) {
  const thinkingConfig = {};
  if (THINK_LEVEL) thinkingConfig.thinkingLevel = THINK_LEVEL;
  if (THINK_BUDGET !== null) thinkingConfig.thinkingBudget = THINK_BUDGET;

  const setup = {
    model: MODEL,
    generationConfig: {
      responseModalities: ["AUDIO"],
      ...(Object.keys(thinkingConfig).length ? { thinkingConfig } : {}),
    },
    systemInstruction: { parts: [{ text:
      "You are Jack Smith, conducting an AI-readiness interview. Ask ONE short question at a " +
      "time and wait. Never summarise the conversation unless asked. Keep every reply under " +
      "three sentences." }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    ...(NO_COMPRESS ? {} : { contextWindowCompression: {
      triggerTokens: COMPRESS_TRIGGER,
      slidingWindow: { targetTokens: Math.floor(COMPRESS_TRIGGER / 2) },
    } }),
    ...(VAD_END || VAD_SILENCE ? { realtimeInputConfig: { automaticActivityDetection: {
      ...(VAD_END ? { endOfSpeechSensitivity: "END_SENSITIVITY_" + VAD_END } : {}),
      ...(VAD_SILENCE ? { silenceDurationMs: VAD_SILENCE } : {}),
    } } } : {}),
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
  };

  const post = async (setupBody) => {
    const r = await fetch(`https://${HOST}/v1alpha/auth_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        bidiGenerateContentSetup: setupBody,
      }),
    });
    return { ok: r.ok, status: r.status, text: await r.text() };
  };

  let res = await post(setup);
  if (!res.ok && res.status === 400 && Object.keys(thinkingConfig).length) {
    // The one field most likely to be unsupported on this model. Report it
    // rather than silently dropping it: "the knob does not exist here" is the
    // answer, and the product pins the same field.
    say(`auth_tokens REJECTED thinkingConfig ${JSON.stringify(thinkingConfig)} ` +
        `for ${MODEL}: ${res.text.slice(0, 200)}`);
    say("retrying without it — the run below has UNCONSTRAINED thinking");
    const { thinkingConfig: _drop, ...gen } = setup.generationConfig;
    res = await post({ ...setup, generationConfig: gen });
  }
  if (!res.ok) throw new Error(`auth_tokens ${res.status}: ${res.text.slice(0, 300)}`);
  if (!resumeHandle) {
    say(`setup accepted: thinking=${Object.keys(thinkingConfig).length ? JSON.stringify(thinkingConfig) : "model default"}` +
        ` compression=${NO_COMPRESS ? "OFF" : COMPRESS_TRIGGER}` +
        ` vad=${VAD_END || VAD_SILENCE ? (VAD_END || "-") + "/" + (VAD_SILENCE || "-") : "server default"}`);
  }
  const j = JSON.parse(res.text);
  return j.token ?? j.name;
}

/* ── one connection ──────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Answers advance across the WHOLE interview, not per connection. */
let globalTurn = 0;

/**
 * Runs one Live connection until it is told to go away, it dies, or the soak
 * is over. Resolves with the handle to resume from and why it ended.
 */
async function connection({ index, resumeHandle, deadline }) {
  const token = await mint(resumeHandle);
  const url = `wss://${HOST}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${token}`;
  const ws = new WebSocket(url);

  let handle = resumeHandle || null;
  let setupDone = false, closed = false, reason = "";
  let turnActive = false, replyAt = 0, thinkingAt = 0;
  /** Set to the moment this turn's answer ended; frames before it are the previous turn's. */
  let awaitingFrom = 0;
  let lastAudioAt = 0;
  let heardText = "", saidText = "";
  let goAway = false;
  const turns = [];

  /*
   * The setup frame the BROWSER sends on this endpoint (vyne-live.js
   * buildSetup): the pinned fields come from the token, and the client still
   * names the model, the modality and the voice. Kept identical on purpose —
   * a soak that sends a different setup frame is soaking different software.
   */
  ws.onopen = () => ws.send(JSON.stringify({
    setup: {
      model: MODEL.indexOf("models/") === 0 ? MODEL : "models/" + MODEL,
      generationConfig: { responseModalities: ["AUDIO"] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  }));
  ws.onmessage = async (ev) => {
    const raw = typeof ev.data === "string" ? ev.data : Buffer.from(await ev.data.arrayBuffer()).toString("utf8");
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.setupComplete) { setupDone = true; say(`conn ${index}: setupComplete${resumeHandle ? " (resumed)" : ""}`); return; }
    if (m.goAway) { goAway = true; say(`conn ${index}: goAway ${JSON.stringify(m.goAway)}`); return; }
    if (m.sessionResumptionUpdate) {
      if (m.sessionResumptionUpdate.newHandle) handle = m.sessionResumptionUpdate.newHandle;
      return;
    }
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) heardText += sc.inputTranscription.text;
    if (sc.outputTranscription?.text) saidText += sc.outputTranscription.text;
    const parts = sc.modelTurn?.parts || [];
    for (const p of parts) {
      lastAudioAt = Date.now();
      /*
       * v5.34.38: only count a frame that arrives AFTER this turn's answer
       * finished streaming.
       *
       * The baseline run printed `reply -12138ms`: the model was still
       * delivering the PREVIOUS answer when the next clip started, its trailing
       * frames landed in the new turn's accounting, and replyAt ended up before
       * doneAt. One negative value then dragged both degradation means below
       * zero and made the headline number meaningless. A latency that cannot be
       * negative must not be representable as negative.
       */
      if (!awaitingFrom || Date.now() < awaitingFrom) continue;
      if (p.text && !thinkingAt) thinkingAt = Date.now();
      if (p.inlineData?.data && !replyAt) replyAt = Date.now();
    }
    if (sc.turnComplete) turnActive = false;
  };
  ws.onclose = (e) => { closed = true; reason = `close ${e.code} ${String(e.reason || "").slice(0, 120)}`; };
  ws.onerror = () => { /* onclose carries the detail */ };

  // Wait for setup, with a bound: a wedged connection must not stall the soak.
  for (let i = 0; i < 150 && !setupDone && !closed; i++) await sleep(100);
  if (!setupDone) { try { ws.close(); } catch {} return { handle, reason: reason || "setup timeout", turns }; }

  // Speak, then listen, for as long as this connection lasts.
  let turnNo = 0;
  while (!closed && Date.now() < deadline && !goAway) {
    turnNo++;
    heardText = ""; saidText = ""; replyAt = 0; thinkingAt = 0; turnActive = true;
    const spokeAt = Date.now();

    /*
     * One whole answer clip, streamed in REAL TIME at the browser's frame size.
     * Pacing is part of what is being tested: a soak that blasts the audio as
     * fast as the socket takes it is not testing turn detection at all.
     */
    const clip = CLIPS[globalTurn % CLIPS.length];
    globalTurn++;
    for (let off = 0; off < clip.length && !closed; off += FRAME_SAMPLES) {
      const chunk = clip.subarray(off, Math.min(clip.length, off + FRAME_SAMPLES));
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(chunk), mimeType: `audio/pcm;rate=${INPUT_RATE}` } } }));
      await sleep(FRAME_MS);
    }
    const doneAt = Date.now();
    awaitingFrom = doneAt;
    // Then silence, so server-side turn detection can close the turn.
    for (let i = 0; i < Math.round(3000 / FRAME_MS) && !closed; i++) {
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(silence), mimeType: `audio/pcm;rate=${INPUT_RATE}` } } }));
      await sleep(FRAME_MS);
    }

    /*
     * v5.34.36 — KEEP STREAMING while waiting. This was the harness's biggest
     * lie about the browser.
     *
     * The browser's ScriptProcessor never stops: silence keeps flowing up the
     * socket for the whole time the interviewee is quiet. The first version of
     * this script sent 3 s of silence and then went mute and polled — so the
     * server's own end-of-speech detection had no further audio to work with,
     * and the measured "reply latency" was partly the server waiting for a
     * stream that had stopped. Latencies here are only comparable to the real
     * app if the uplink behaves like the real app.
     */
    const waitUntil = Date.now() + 60000;
    while (!closed && !replyAt && Date.now() < waitUntil) {
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(silence), mimeType: `audio/pcm;rate=${INPUT_RATE}` } } }));
      await sleep(FRAME_MS);
    }
    const settle = Date.now() + 30000;
    while (!closed && turnActive && Date.now() < settle) {
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(silence), mimeType: `audio/pcm;rate=${INPUT_RATE}` } } }));
      await sleep(FRAME_MS);
    }
    /*
     * v5.34.38: and then wait for the model to actually go QUIET. turnComplete
     * is not the last audio frame in practice, and starting the next answer on
     * top of a still-speaking model is a barge-in — the baseline run's replies
     * were visibly truncated mid-sentence because of it. A real interviewee
     * waits for the question to finish; so does the fixture.
     */
    const quietBy = Date.now() + 10000;
    while (!closed && Date.now() < quietBy && lastAudioAt && Date.now() - lastAudioAt < 1200) {
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(silence), mimeType: `audio/pcm;rate=${INPUT_RATE}` } } }));
      await sleep(FRAME_MS);
    }
    awaitingFrom = 0;

    const row = {
      minute: +((Date.now() - t0) / 60000).toFixed(1),
      conn: index, turn: turnNo,
      replyMs: replyAt ? replyAt - doneAt : null,
      thinkMs: thinkingAt && replyAt ? replyAt - thinkingAt : null,
      heard: heardText.trim().slice(0, 60),
      said: saidText.trim().slice(0, 80),
    };
    turns.push(row); rows.push(row);
    say(`conn ${index} turn ${turnNo}: reply ${row.replyMs === null ? "NONE" : row.replyMs + "ms"}` +
        (row.thinkMs ? ` (thought ${row.thinkMs}ms of it)` : "") +
        (row.heard ? ` | heard "${row.heard}"` : " | heard nothing") +
        (row.said ? ` | said "${row.said}"` : ""));
    /*
     * v5.34.34: two very different outcomes used to print the same alarm.
     * "Heard nothing AND no reply" means the AUDIO never registered as speech
     * — a broken fixture, not a product failure, and the first real run of
     * this script produced a page of false alarms that way. "Heard the answer
     * but did not reply" is the real defect this soak exists to catch.
     */
    if (row.replyMs === null && !row.heard && !rows.some((r) => r.heard)) {
      // Nothing has been transcribed in this run AT ALL: the audio is wrong.
      say(`conn ${index}: the model transcribed NOTHING — the audio is not registering as speech. ` +
          `This is the fixture, not the product. Check the clip rate/format (needs PCM16 mono ${INPUT_RATE}Hz).`);
    } else if (row.replyMs === null && !row.heard) {
      /*
       * v5.34.39: the same clips WERE transcribed earlier in this very run, so
       * the audio is fine and the service has stopped listening. The gen25 run
       * printed "this is the fixture" for five consecutive turns after three
       * clean ones — blaming my own harness for what was actually Google
       * refusing to work, which is the opposite of what a diagnostic is for.
       */
      say(`conn ${index}: the model stopped transcribing at minute ${row.minute}, though the SAME clips were ` +
          `transcribed earlier in this run — so the audio is fine and the service has stopped listening. ` +
          `Check the connection-ends line for a quota or availability close.`);
    } else if (row.replyMs === null) {
      say(`conn ${index}: HEARD the answer and did NOT reply at minute ${row.minute}` +
          (closed ? ` — but the connection closed here (${reason}), so this is the socket dying, not a refusal.`
                  : " — the real signature: a live socket, an understood answer, no reply."));
    }
  }

  try { ws.close(); } catch {}
  return { handle, reason: reason || (goAway ? "goAway" : "soak deadline"), turns };
}

/* ── the soak ────────────────────────────────────────────────────────────── */

let CLIPS = [];

(async () => {
  say(`starting: ${MINUTES} minutes on ${MODEL}`);
  try {
    CLIPS = await loadAnswers();
  } catch (e) {
    say(`could not prepare the answer audio: ${e && e.message}`);
    process.exit(2);
  }
  const deadline = Date.now() + MINUTES * 60 * 1000;
  let handle = null, conn = 0, ended = "";
  const closeReasons = [];

  while (Date.now() < deadline) {
    conn++;
    try {
      const r = await connection({ index: conn, resumeHandle: handle, deadline });
      handle = r.handle;
      closeReasons.push(r.reason);
      say(`conn ${conn} ended: ${r.reason}${handle ? " (handle kept)" : " (NO handle — the next connection loses the conversation)"}`);
    } catch (e) {
      ended = String(e && e.message);
      say(`conn ${conn} FAILED to open: ${ended}`);
      if (/auth_tokens 4\d\d/.test(ended)) break;     // a key or quota problem: stop, don't spin
      await sleep(5000);
    }
  }

  /* ── verdict ───────────────────────────────────────────────────────────── */
  const answered = rows.filter((r) => r.replyMs !== null);
  const missed = rows.filter((r) => r.replyMs === null);
  const pct = (a) => { const s = [...a].sort((x, y) => x - y); return (p) => s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
  const q = pct(answered.map((r) => r.replyMs));
  const firstHalf = answered.filter((r) => r.minute < MINUTES / 2).map((r) => r.replyMs);
  const secondHalf = answered.filter((r) => r.minute >= MINUTES / 2).map((r) => r.replyMs);
  const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);

  say("");
  say("──────── verdict ────────");
  say(`connections: ${conn}   turns: ${rows.length}   answered: ${answered.length}   unanswered: ${missed.length}`);
  say(`reply latency: median ${q(0.5)}ms   p90 ${q(0.9)}ms   worst ${Math.max(0, ...answered.map((r) => r.replyMs))}ms`);
  /*
   * v5.34.38 — FIRST-turn latency, reported separately.
   *
   * Three back-to-back 10-minute runs on 2026-09-11 produced first-turn
   * latencies of 1,076 ms, 38,224 ms and 62,774 ms. The configuration being
   * varied (thinking, compression) cannot plausibly make the FIRST reply of a
   * fresh session 60x slower; run ORDER can, if the project is being throttled
   * as sessions accumulate. Without this line the effect hides inside a median
   * and gets attributed to whichever flag that run happened to carry — which is
   * exactly the mistake this script exists to stop.
   *
   * So: compare like with like. Run the SAME config first and last, and treat
   * any conclusion drawn from a single run in a sequence as provisional.
   */
  if (answered.length) {
    const quarter = Math.max(1, Math.floor(answered.length / 4));
    const means = [0, 1, 2, 3].map((i) => mean(answered.slice(i * quarter, (i + 1) * quarter).map((r) => r.replyMs)));
    say(`first answered turn: ${answered[0].replyMs}ms at minute ${answered[0].minute}` +
        `   (quarters: ${means.join("ms → ")}ms)`);
  }
  say(firstHalf.length && secondHalf.length
      ? `degradation: first half mean ${mean(firstHalf)}ms → second half mean ${mean(secondHalf)}ms`
      : `degradation: not enough answered turns in both halves to compare (` +
        `${firstHalf.length} vs ${secondHalf.length})`);
  if (missed.length) say(`unanswered turns at minutes: ${missed.map((r) => r.minute).join(", ")}`);
  say(`connection ends: ${closeReasons.join(" | ") || "none"}`);
  /*
   * v5.34.39 — the headline this whole exercise was for.
   *
   * Six 10-minute runs on 2026-09-11: the FIRST answered 34 of 35 turns with a
   * 1,196 ms median. The SIXTH, byte-identical in configuration, answered 6 of
   * 12 with a 31,844 ms median and closed four times, once explicitly with
   * "Resource has been exhausted (e.g. check quota)". Nine releases of model,
   * VAD and thinking settings were spent on what is a project-level rate
   * limit. If the run hit one, that is the first thing the reader must see.
   */
  const throttled = closeReasons.filter((r) => /exhaust|quota|unavailable|rate.?limit/i.test(r));
  if (throttled.length) {
    say(`!!! ${throttled.length} connection(s) ended in a QUOTA or AVAILABILITY close: ${throttled.join(" | ")}`);
    say("    Latency in this run says more about the project's remaining Live API allowance than about " +
        "any setting under test. Compare only against a run made from a rested quota.");
  }
  const heardAny = rows.some((r) => r.heard);
  if (!heardAny) say("the model transcribed nothing on ANY turn — treat this run as a fixture failure, not a product result");
  say(`full log: ${OUT}`);
  say(!heardAny ? "INVALID — the audio never registered as speech; fix the fixture and re-run."
      : throttled.length ? "INVALID FOR COMPARISON — this run was rate-limited; see the line above."
      : rows.length && !missed.length && mean(secondHalf) < mean(firstHalf) * 2
      ? "PASS — every turn answered and the second half did not blow out."
      : "LOOK CLOSER — see the unanswered turns and the degradation line above.");
  process.exit(0);
})();
