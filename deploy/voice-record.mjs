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
 *
 * ── What it DOES prove, as of v5.34.74 ──────────────────────────────────────
 *
 * The interviewer itself. Until now this file pinned its own three-sentence
 * system prompt, so the recording exercised the shipped TRANSPORT against a
 * prompt that existed nowhere else in the product — and the .txt it wrote was
 * then read as evidence about the product's interviewer. It was not. Question
 * quality, coverage, repetition and when the interview wrapped up were all
 * properties of that stub.
 *
 * With --instruction-file it runs the real buildInterviewerInstruction output:
 * persona, dimension agenda, closing rules, and the engagement briefing. Both
 * the banner and the verdict now state WHICH persona was used, because the
 * failure this fixes was not a wrong answer — it was a right answer to a
 * question nobody realised was being asked. Without the flag the stub still
 * works, and labels itself as the stub everywhere it appears.
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
/*
 * --loop: keep reading the eight scripted answers round and round until the
 * clock runs out. That is what every run did before v5.34.78, and it is only
 * honest for a deliberate soak — reaching the ~10-minute handover, or watching
 * for drift over half an hour. It is NOT how to judge interview quality: past
 * the first pass the interviewee is repeating itself, so any repetition in the
 * verdict is the rig's, not the interviewer's. Self-test needs the soak.
 */
const LOOP = has("loop") || SELFTEST;
/*
 * --offline-close-after N: make the offline stub say a closing line on its Nth
 * reply. The only way to prove the interview-close detector is wired to a hook
 * that fires, without spending a paid live run to find out it is not — which is
 * what v5.34.75 through .77 each did in turn.
 */
const OFFLINE_CLOSE_AFTER = Number(arg("offline-close-after", 0)) || 0;
/*
 * The closing pattern, at module scope so both the detector and the
 * "too early to be a close" guard above it read the SAME one. They were one
 * expression built inline; a guard testing a second copy is a guard that can
 * silently drift out of agreement with what it guards.
 *
 * Deliberately narrow. It is confined to a TEST harness; nothing in the product
 * keys off wording.
 */
const CLOSING_RE = new RegExp([
  String.raw`(thanks|thank you)[^.?!]{0,40}\b(your time|taking the time)\b`,
  String.raw`that concludes|concludes our interview`,
  String.raw`covered everything (i|we)('ve| have)? ?(came|come) for`,
  String.raw`appreciate[^.?!]{0,25}\b(your time|taking the time)\b`,
].join("|"));
/*
 * Completed exchanges required before any closing language is believed.
 * The shortest GENUINE close observed ran nine turns; a greeting is turn one.
 */
const MIN_TURNS_BEFORE_CLOSE = Number(process.env.VYNE_HARNESS_MIN_TURNS_BEFORE_CLOSE || 3);
/* One line per run, not one per greeting fragment. */
let closeIgnored = false;
/*
 * Counts replies across the WHOLE run, not per socket. The first version of
 * this lived inside the stub's socket factory, so every handover reset it to
 * zero — and offline handovers come every ~25 seconds, so it could never reach
 * 4 and the stub never closed. Exactly the class of bug this flag exists to
 * catch, committed while writing the flag.
 */
let stubReplies = 0;
const MINUTES = SELFTEST ? 1.5 : Number(arg("minutes", 14));
const OUT = arg("out", SELFTEST ? "voice-selftest" : "voice-record");
const MODEL = arg("model", "models/gemini-2.5-flash-native-audio-latest");
const VOICE = arg("voice", "Kore");
const INTERVIEWER = arg("interviewer", "Jack Smith");
/*
 * v5.34.74 — the SHIPPED interviewer, not one this file invented.
 *
 * Until now mint() pinned its own three-sentence prompt. That made every
 * judgement ever drawn from a recording about question quality, coverage,
 * repetition or when the interview wrapped up a judgement about THAT prompt,
 * while the .txt said "voice-record" and got read as the product. The header
 * above warns that a broken rig and a broken product look identical; this was
 * a working rig measuring the wrong subject, which is harder to notice.
 *
 * deploy/interviewer-instruction.ts renders the real thing —
 * buildInterviewerInstruction, agenda, closing rules and a representative
 * engagement briefing. run-voice-record.sh builds it before stage 4 and passes
 * it here. PERSONA_SOURCE is reported in the banner and in the verdict, so a
 * recording can never again be mistaken for something it is not.
 */
const INSTRUCTION_FILE = arg("instruction-file", "");
/*
 * v5.34.79: live rendering is the DEFAULT when an instruction file was asked
 * for. --pinned-instruction restores the old behaviour — one instruction for
 * the whole run — for the rare case where you want the prompt held still.
 */
const LIVE_INSTRUCTION = !!INSTRUCTION_FILE && !has("pinned-instruction");
const HARNESS_PERSONA =
  `You are ${INTERVIEWER}, conducting an AI-readiness interview. Ask ONE short question at a ` +
  `time and then wait for the answer. Never summarise the conversation unless asked. Keep every ` +
  `reply under three sentences.`;
let SYSTEM_INSTRUCTION = HARNESS_PERSONA;
let PERSONA_SOURCE = "HARNESS STUB (three sentences — NOT the product's interviewer)";
if (INSTRUCTION_FILE) {
  try {
    const t = readFileSync(isAbsolute(INSTRUCTION_FILE) ? INSTRUCTION_FILE : join(ROOT, INSTRUCTION_FILE), "utf8").trim();
    if (t.length < 200) throw new Error(`only ${t.length} chars — that is not the shipped persona`);
    SYSTEM_INSTRUCTION = t;
    PERSONA_SOURCE = `SHIPPED persona via interviewerPersona.ts (${t.length} chars)`;
  } catch (e) {
    console.error(`\n!! could not read --instruction-file: ${e.message}`);
    console.error("!! refusing to record against the stub prompt and call it the product.\n");
    process.exit(2);
  }
}
/*
 * ── LIVE instruction, re-rendered at EVERY mint (v5.34.79) ──────────────────
 *
 * --instruction-file renders the shipped persona ONCE, before the run, and
 * pins it. That was faithful while the instruction was static. It is not any
 * more.
 *
 * v5.34.79 made the product recompute the interview's state at every mint —
 * which questions have been asked and answered, how many required ones are
 * left — because a ~10-minute handover starts a session with NO memory of the
 * conversation, and what it knows about the ground already covered comes only
 * from the context sent with its grant. A harness that pins one instruction
 * hands every session the same "nothing asked yet" snapshot: exactly the state
 * the fix exists to prevent. It would have reported a clean pass on the bug.
 *
 * So the harness renders it live, through the SAME buildInterviewerInstruction
 * the server uses. tsx's ESM loader is registered in-process, so this is a
 * function call at mint time — no subprocess, nothing to stall a handover.
 *
 * If that import fails, the run does NOT quietly fall back to the pinned file
 * and call itself live: it says which mode it is in, in the banner and in the
 * verdict, because a harness that lies about what it measured is the one
 * failure this file exists to make impossible.
 */
let renderInstruction = null;
let liveFixture = null;
if (LIVE_INSTRUCTION) {
  try {
    /*
     * Import the PERSONA module directly, and read the fixture as JSON.
     *
     * Importing deploy/interviewer-instruction.ts from here instead produced
     * "Cannot require() ES Module ... in a cycle" under the tsx loader. Going
     * straight to the one function that matters avoids the module graph
     * entirely, and the fixture both sides read is the same JSON file, so the
     * harness and the CLI renderer cannot drift apart.
     */
    const { register } = await import("../backend/node_modules/tsx/dist/esm/api/index.mjs");
    register();
    const persona = await import("../backend/src/llm/interviewerPersona.ts");
    const fx = JSON.parse(readFileSync(join(ROOT, "deploy", "interviewer-fixture.json"), "utf8"));
    const isDim = (d) => persona.DIM_CODES.includes(d);
    const dims = (a) => (a || []).filter(isDim);
    renderInstruction = (f) => persona.buildInterviewerInstruction({
      interviewerName: f.interviewerName, clientName: f.clientName, industry: f.industry,
      intervieweeName: f.intervieweeName, intervieweeRole: f.intervieweeRole,
      context: f.context, mandatoryCount: f.mandatoryCount, askedCount: f.askedCount,
      agenda: f.agenda && { lead: dims(f.agenda.lead), cover: dims(f.agenda.cover),
                            light: dims(f.agenda.light), evidenced: dims(f.agenda.evidenced) },
    });
    liveFixture = { ...fx };
    SYSTEM_INSTRUCTION = renderInstruction({ ...liveFixture, askedCount: 0 });
    PERSONA_SOURCE = `SHIPPED persona, RE-RENDERED at every mint (${SYSTEM_INSTRUCTION.length} chars at open)`;
  } catch (e) {
    console.error(`\n!! could not load the live instruction renderer: ${e.message}`);
    console.error("!! this run would pin one instruction for the whole interview, which cannot");
    console.error("!! exercise anything that changes across a handover. Pass --pinned-instruction");
    console.error("!! to record that way deliberately.\n");
    process.exit(2);
  }
}

/*
 * The harness's own record of the conversation, kept from onTurns. It is what
 * the live fixture is derived from — the same two facts the page derives it
 * from: which questions have been asked and answered, and which required ones
 * are still outstanding.
 */
const askedQuestions = [];      // answered, deduped, oldest first
const seenQuestion = Object.create(null);
let pendingQuestion = null;     // asked, not yet answered
let turnsSeen = 0;              // cursor into turns[], so answers are not skipped
const mandatoryDone = new Set();

/** The required questions the fixture's background lists, in order. */
function fixtureMandatory() {
  const m = /Questions that must be asked before the interview ends:\n([\s\S]*)$/.exec(liveFixture?.context || "");
  if (!m) return [];
  return m[1].split("\n").map((l) => l.replace(/^\s*\d+\.\s*/, "").trim()).filter(Boolean);
}

/*
 * Same rule the page uses (markAskedMandatoryQuestions): a required question
 * counts as done when a turn strongly overlaps it AND an answer follows.
 * Reimplemented rather than shared because the page is a browser file with no
 * module boundary — the OVERLAP THRESHOLD is the thing that must not drift, so
 * it is named here rather than buried in an expression.
 */
const MQ_OVERLAP = 0.7;
const MQ_STOP = new Set("the a an of to and or in on for is are you your have has do this that with we i it be as at by how what please confirm".split(" "));
/*
 * v5.34.83 — kept in step with interview_agent.html's mqStem/mqTokens/mqOverlap
 * by interviewNoRepeat.test.ts, which runs the same fixtures through BOTH and
 * requires identical answers. Two copies exist because one is browser script
 * and one is Node with no module boundary between them; a test is the only
 * thing that can stop them drifting, and drift here would make the harness
 * report coverage the product does not see.
 */
const mqStem = (w) => w.replace(/(ies)$/, "y").replace(/(sses|shes|ches|xes)$/, (m) => m.slice(0, -2))
  .replace(/(ing|ed|es|s)$/, "");
const mqTokens = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
  .filter((w) => w.length > 3 && !MQ_STOP.has(w)).map(mqStem);
function mqOverlap(turnText, questionText) {
  const want = [...new Set(mqTokens(questionText))];
  if (!want.length) return 0;
  const got = new Set(mqTokens(turnText));
  return want.filter((w) => got.has(w)).length / want.length;
}
function matchesMandatory(turnText, question) {
  return mqTokens(question).length > 0 && mqOverlap(turnText, question) >= MQ_OVERLAP;
}

/** Fold one completed VYNE turn into the record. Answered-ness is resolved later. */
function recordAgentTurn(text) {
  const qs = String(text).split(/(?<=[?])\s+/)
    .filter((s) => s.includes("?"))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 12);
  if (!qs.length) return;
  pendingQuestion = { text: qs[qs.length - 1], all: qs };
}

/** The interviewee answered, so everything still pending is now asked AND answered. */
function settlePendingQuestion() {
  if (!pendingQuestion) return;
  for (const q of pendingQuestion.all) {
    const k = q.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
    if (!seenQuestion[k]) { seenQuestion[k] = 1; askedQuestions.push(q.length > 220 ? q.slice(0, 220) + "…" : q); }
    fixtureMandatory().forEach((mq, i) => { if (matchesMandatory(q, mq)) mandatoryDone.add(i); });
  }
  pendingQuestion = null;
}

/**
 * The instruction for the session about to be minted.
 *
 * Mirrors buildLiveContext() in interview_agent.html: the asked list and the
 * OUTSTANDING required questions, with the counts that match them. If the two
 * ever disagree the interviewer is told a question is required and that it has
 * not been asked, which is an instruction to ask it again — the exact fault
 * this version fixes.
 */
function currentInstruction() {
  if (!renderInstruction || !liveFixture) return SYSTEM_INSTRUCTION;
  const all = fixtureMandatory();
  const due = all.filter((_, i) => !mandatoryDone.has(i));
  const base = String(liveFixture.context || "")
    .replace(/Questions that must be asked before the interview ends:\n[\s\S]*$/, "").trimEnd();
  const parts = [base];
  if (askedQuestions.length || pendingQuestion) {
    const block = [];
    if (askedQuestions.length) {
      block.push("", "Questions you have ALREADY asked in this interview, and which have been answered:");
      askedQuestions.forEach((q, i) => block.push(`${i + 1}. ${q}`));
    }
    if (pendingQuestion) {
      block.push("", "This one was asked but NOT answered — the interview was interrupted here. Ask it again:", pendingQuestion.text);
    }
    parts.push(block.join("\n"));
  }
  if (due.length) {
    parts.push(["", "Questions that must be asked before the interview ends:"]
      .concat(due.map((q, i) => `${i + 1}. ${q}`)).join("\n"));
  }
  return renderInstruction({
    ...liveFixture,
    context: parts.join("\n"),
    mandatoryCount: due.length,
    askedCount: askedQuestions.length,
  });
}

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
    /* v5.34.79: computed HERE, not captured. Every mint — the opening one and
     * every ~10-minute handover — gets the interview as it actually stands. */
    systemInstruction: { parts: [{ text: currentInstruction() }] },
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
    /*
     * v5.34.78 — THIS STUB USED TO COUNT EVERY FETCH AS A GRANT MINT.
     *
     * It caught /api/llm/generate too. That never showed up because the offline
     * stub sent no transcript, so vyne-live-interview.js never had two turns to
     * score and the scoring call was never made. The moment the stub started
     * speaking (see the reply() comment), the first score request at 15.5s was
     * counted as grant attempt 2, ate one of the three injected transport
     * faults, and shifted the whole retry-gap window — the fault check then
     * reported 9.9s / 4.0s / 8.0s against an expected 4 / 8 / 16 and FAILED a
     * backoff that was in fact exactly right.
     *
     * Which is the harness's own trap once more: a rig fault reported as a
     * product fault, in the stage built to rule that out. Mints are the grant
     * endpoint, and nothing else.
     */
    if (!/\/api\/voice\/live-session$/.test(u.split("?")[0])) {
      // Any other product call — scoring, most of all. Succeed quietly; its
      // body is not what this harness measures.
      /*
       * v5.34.83 — a score-shaped reply, so the page stops crying wolf.
       *
       * When the stub started speaking (v5.34.79) the page began making its real
       * scoring call, and a "{}" answer made it log "scoring pass failed
       * unparseable_score_response" on every offline run. The failure is
       * swallowed by design and changed nothing, but a rig that prints a red
       * line for its own stub trains you to ignore red lines.
       */
      return { ok: true, status: 200, json: async () => ({
        text: JSON.stringify({ scores: {}, findings: [], rationale: "offline stub" }) }) };
    }
    mintAttempts++;
    mintAt.push(now());
    /*
     * Refuse only DURING a handover. The injected fault is a transport fault on
     * renewal, which is the code path that has retry logic; refusing a mint
     * that no ladder is waiting on just removes a grant from the count and
     * teaches nothing.
     */
    if (mintAttempts > 1 && mintFailuresLeft > 0 && renewingSince !== null) {
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
        else if (spoke && ++quiet > 8) {
          spoke = false; quiet = 0;
          /*
           * v5.34.79 — the stub now transcribes the INTERVIEWEE too.
           *
           * It only ever emitted the agent side, so a "You" turn never reached
           * vyne-live-interview.js and turns[] held one speaker. Everything
           * that keys off an answer having been given — the asked-and-answered
           * record the next mint's instruction is built from — was therefore
           * untestable offline. That is how the greeting false positive got
           * through: the offline check could not see the half of the
           * conversation the bug lived in.
           */
          frame({ serverContent: { inputTranscription: { text: "That is a fair question, and here is the answer." } } });
          setTimeout(reply, 600);
        }
      }
      if (o.clientContent) setTimeout(reply, 700);       // a text nudge gets an answer too
    };
    ws.close = () => { if (closed) return; closed = true; ws.readyState = 3; ws.onclose && ws.onclose({ code: 1000, reason: "client" }); };
    function reply() {
      if (closed) return;
      frame({ serverContent: { modelTurn: { parts: [{ text: "Thinking about that." }] } } });
      /*
       * v5.34.78 — THE STUB NOW SPEAKS A TRANSCRIPT.
       *
       * It never did, and that is why the offline self-check — the thing whose
       * whole job is to prove the rig before a real run is believed — could not
       * see that the harness's interview-close detector had never once fired.
       * Everything downstream of outputTranscription was untestable offline, so
       * a dead hook there looked identical to a clean run. That is the harness's
       * own stated trap ("a broken rig and a broken product look identical")
       * reappearing inside the tool built to escape it.
       *
       * Fragmented deliberately, the way the real API sends it, because the
       * fragmentation is half of what the old detector got wrong: it matched
       * multi-word patterns against sub-word pieces.
       */
      stubReplies++;
      /*
       * v5.34.79 — the stub now GREETS the way the real model greets.
       *
       * Verbatim from the 2026-09-14 03:40 run, whose opening was "Hello,
       * Alex. I'm Jack Smith. Thanks for taking the time today." That matched
       * the closing pattern and ended a live run at eleven seconds with zero
       * replies. The offline check could not have caught it: the stub's first
       * line was a question, so the one utterance in an interview most likely
       * to trip a farewell pattern was the one utterance never simulated.
       */
      /*
       * Reply 2 asks a REQUIRED question, verbatim from the fixture.
       *
       * Without it the offline check never exercises the path that takes a
       * question off the outstanding list — the half of v5.34.79 that stops
       * the interviewer asking "who signs off before a model affects a
       * production line" three times in 43 seconds. The stub's generic
       * "question N?" lines can never match a mandatory question, so the
       * shrink was untestable without a paid run. Twice today a live run was
       * spent discovering something the offline stub was simply not saying.
       */
      const mq = fixtureMandatory();
      const line = stubReplies === 1
        ? "Hello, Alex. I'm Jack Smith. Thanks for taking the time today. How is your data organised?"
        : (stubReplies === 2 && mq.length)
        ? mq[0]
        : (OFFLINE_CLOSE_AFTER > 0 && stubReplies >= OFFLINE_CLOSE_AFTER)
        ? "I think I've covered everything I came for. Thanks again for your time, Alex."
        : `And what does that look like in practice, question ${stubReplies}?`;
      line.split(/(?<=\s)/).forEach((w, i) => setTimeout(
        () => closed || frame({ serverContent: { outputTranscription: { text: w } } }), 60 + i * 25));
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

/*
 * ── The SCORING path needs one function from vyne-client.js (v5.34.83) ──────
 *
 * Every offline run since v5.34.79 printed "scoring pass failed
 * unparseable_score_response". It reads as the scorer being broken. It is not:
 * vyne-live-interview.js parses the scoring reply with window.vyneParseJson,
 * which lives in vyne-client.js — a file the harness does not load, because it
 * is page furniture. So `parsed` was null whatever the reply contained, and no
 * payload from the stub could ever have satisfied it. The line was about a
 * missing file in the RIG and said nothing about the product.
 *
 * The REAL function is lifted out of vyne-client.js rather than reimplemented.
 * A hand-rolled JSON.parse here would be the harness grading itself against a
 * parser the product does not use, which is the fault this whole file exists
 * to avoid. If the extraction ever fails, say so once and carry on: scoring is
 * not what a voice recording measures, and a missing parser must not stop a run.
 */
try {
  const client = FE("vyne-client.js");
  const a = client.indexOf("function vyneParseJsonDetailed(text) {");
  const b = client.indexOf("function vyneParseJson(text)", a);
  const end = client.indexOf("\n", b);
  if (a < 0 || b < 0) throw new Error("vyneParseJson not found in vyne-client.js");
  vm.runInContext(
    `${client.slice(a, end)}\nwindow.vyneParseJson = vyneParseJson;`,
    ctx, { filename: "vyne-client.js#vyneParseJson" });
} catch (e) {
  say(`(scoring replies will not be parsed: ${e.message} — this affects nothing a recording measures)`);
}
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
/** When the interviewer said goodbye, in seconds. null = it never did. */
let closedAt = null;
let state = "idle";
let speakingSince = null;
let askedAt = null;
let answerIndex = 0;
let firstAudioAt = null;
let ended = null;
let renewals = 0;
let renewRetries = 0;   // retries inside the CURRENT handover (v5.34.47)
/* When the current handover began, or null between handovers. Read by the
 * stall watchdog, which must not count a reconnect ladder as silence. */
let renewingSince = null;
/* Set once the scripted interviewee runs out of distinct material (v5.34.78). */
let scriptExhaustedAt = null;
let silentRenewals = 0;
/* v5.34.94 — scoring, which this rig watched none of until now. See the
 * onScore/onScoreError/onScoringDead handlers and the verdict lines. */
let scoreCalls = 0;
let scoreErrors = 0;
let scoringDead = null;
const scoredDims = new Set();
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
  /*
   * v5.34.75 — the harness knows how long the interview was booked for, so it
   * is what exercises the wrap-up notice. interviewerPersona.ts carries the
   * rule ("if you are told time is running short, say what is left and offer to
   * pick it up another time"); vyne-live-interview.js fires it at
   * plannedMinutes minus WRAPUP_LEAD_MS. The product has no booked-length field
   * yet, so this is currently the only caller — see _armWrapUp for what would
   * need to exist to turn it on for real interviews.
   */
  plannedMinutes: MINUTES,
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
    renewingSince = Date.now();
    say(`— handover #${n} starting (this is the ~10-minute one) —`);
  },
  onRenewed: () => {
    say(renewRetries
      ? `— handover complete after ${renewRetries} retr${renewRetries === 1 ? "y" : "ies"}, interview continues —`
      : `— handover complete, interview continues —`);
    renewRetries = 0;
    renewingSince = null;
    /*
     * v5.34.78 — coming back from a handover is not a stall recovery.
     *
     * The watchdog is suppressed for the duration of the retry ladder, so the
     * moment the handover completed it saw 38 seconds of accumulated silence
     * and fired half a second later — logging "the uplink went quiet and the
     * watchdog restarted it" about a handover that had just succeeded. That
     * line is the run's alarm for a dead uplink; spending it on the normal case
     * is how an alarm stops meaning anything.
     *
     * A real interviewee picks the conversation back up after a reconnect. So
     * does this: restart the silence clock, and if nothing is in flight a beat
     * later, cue the next answer as ordinary conversation rather than as a
     * recovery. If the session is genuinely dead, nothing here helps and the
     * watchdog fires on its own merits 25 seconds from now — which is the
     * report we actually want.
     */
    lastCueAt = Date.now();
    setTimeout(() => {
      if (ended || answering || uplinkQueue.length) return;
      if (state === "speaking" || state === "thinking") return;
      nextAnswer();
    }, 1200);
  },
  onRenewSilent: () => { silentRenewals++; say(`!! the renewed session did not speak — dropping the handle and reconnecting`); },
  onQuotaExhausted: () => { say(`!! GOOGLE IS RATE-LIMITING THIS PROJECT — the run below is INVALID FOR COMPARISON`); },
  onReplyWithoutAudio: () => { say(`!! a reply arrived as text with no voice`); },
  /*
   * v5.34.75 — notice when the interviewer CLOSES, and stop.
   *
   * The shipped persona is told to end the interview once it has what it came
   * for, and on 2026-09-13 it did: "I think I have a good picture of how things
   * work across technology, data, and potential governance. Thanks for your
   * time." The harness then kept reading scripted answers at it, so it closed
   * again a few turns later, and the transcript showed two goodbyes — read at
   * first glance as the closing rule failing when it was the rig refusing to
   * leave.
   *
   * A real interviewee stops talking when the interview ends. So does this now.
   * The pattern is deliberately narrow and sits in a TEST harness; nothing in
   * the product keys off wording.
   */
  /*
   * v5.34.78 — THIS HOOK HAD NEVER ONCE FIRED.
   *
   * It was written as onAgentText, which is a vyne-live.js callback.
   * vyne-live-interview.js INTERCEPTS that name: it accumulates the fragment
   * into pendingAgent and re-emits it as onPartialAgent. It does not forward
   * onAgentText, so the harness's handler sat there, regex carefully widened
   * twice, never called. "closed by agent: no" was not a measurement. It was
   * a field that could only ever print "no".
   *
   * Two things had to be wrong together for that to survive review: the hook
   * name was never checked against the module that actually calls it, and the
   * one assertion that would have caught it — a run where the interviewer
   * demonstrably closed, which is every run since v5.34.73 — was read from the
   * transcript by eye instead of from the verdict.
   *
   * onTurns is the right hook and is the one the PRODUCT uses: it fires on
   * turnComplete with the flushed turns array, so the text is a WHOLE turn.
   * That also fixes a second latent bug — the old handler tested the regex
   * against sub-word fragments (" your", " time"), which no multi-word pattern
   * could ever match even if it had been called.
   */
  onTurns: (all) => {
    if (!Array.isArray(all) || !all.length) return;
    const last = all[all.length - 1];
    /*
     * v5.34.79 — keep the harness's own record of the conversation, because
     * the instruction for the NEXT mint is derived from it. A "You" turn means
     * whatever question was on the table has now been answered.
     *
     * Consume every turn since the last call, not just the newest. _flushPending
     * pushes the interviewee's turn and THEN the interviewer's, so "You" is
     * never the last element — reading only the tail saw the questions and none
     * of the answers, and reported "0 asked and answered" after thirteen
     * exchanges. turns[] is also capped at 200 and spliced from the front, so
     * the cursor is clamped rather than trusted.
     */
    if (turnsSeen > all.length) turnsSeen = 0;
    for (; turnsSeen < all.length; turnsSeen++) {
      const t = all[turnsSeen];
      if (!t || !t.text) continue;
      if (t.who === "You") settlePendingQuestion();
      else if (t.who === "VYNE") recordAgentTurn(t.text);
    }
    if (closedAt !== null) return;
    if (!last || last.who !== "VYNE" || !last.text) return;
    const t = last.text;
    const s = String(t).toLowerCase();
    /*
     * v5.34.79 — AN INTERVIEW CANNOT CLOSE BEFORE IT HAS STARTED.
     *
     * The 2026-09-14 03:40 run ended at ELEVEN SECONDS with zero replies. The
     * interviewer's greeting was "Hello, Alex. I'm Jack Smith. Thanks for
     * taking the time today." — and "thanks ... taking the time" is the
     * closing pattern, because at the end of an interview that is exactly what
     * it means. The phrase is genuinely ambiguous; only its position is not.
     *
     * This became reachable in v5.34.78, which fixed the detector's hook. While
     * the handler was dead a false positive was impossible, so widening the
     * regex twice looked free. It was not — it was untested.
     *
     * A tighter pattern is the wrong answer: every wording that ends an
     * interview also appears in pleasantries, and each narrowing trades a false
     * stop for a missed one, which is the failure that wasted twenty-eight
     * minutes. So gate on STRUCTURE instead. Three completed exchanges is well
     * under any real close (the shortest genuine one so far ran nine turns) and
     * well over any greeting.
     */
    if (turns.length < MIN_TURNS_BEFORE_CLOSE) {
      if (!closeIgnored && CLOSING_RE.test(s)) {
        closeIgnored = true;
        say(`(ignoring closing language after only ${turns.length} repl${turns.length === 1 ? "y" : "ies"} — ` +
            `an interview cannot close before it starts; this is almost certainly a greeting)`);
        say(`  "${String(t).trim().slice(0, 120)}"`);
      }
      return;
    }
    /*
     * v5.34.77 — widened, because it missed the real thing by one word.
     *
     * The 2026-09-14 run closed with "I think I've covered everything I came
     * for. Thanks again for your time, Alex. Take care." The previous pattern
     * required "thanks for your time" CONTIGUOUS, so "again" defeated it. The
     * harness then read scripted answers at a finished interview for another
     * twenty minutes, and that tail is what produced every bad number in the
     * verdict: one question counted eleven times (it was the interviewer being
     * talked over while trying to say goodbye), speech share 41% instead of the
     * real 25%, and "closed by agent: no" about an interview that had closed at
     * minute nine.
     *
     * So: allow words between the thanks and the time, and match the other
     * shapes it actually uses. Still deliberately narrow — a false positive
     * ends the run early, which is the more expensive mistake — and still
     * confined to a TEST harness. Nothing in the product keys off wording.
     */
    if (!CLOSING_RE.test(s)) return;
    closedAt = now();
    say(`— the interviewer CLOSED the interview at ${closedAt.toFixed(0)}s —`);
    say(`  "${String(t).trim().slice(0, 160)}"`);
    // Let the last sentence finish playing before tearing the socket down.
    setTimeout(() => finish("interviewer closed the interview"), 6000);
  },
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

  /*
   * ── v5.34.94: THE SCORING CALLBACKS, WHICH THIS RIG HAS NEVER SUBSCRIBED TO ─
   *
   * This is the only harness that runs the SHIPPED vyne-live.js and
   * vyne-live-interview.js, and it registered onTurns/onEnded/onError but none
   * of onScore, onScoreError or onScoringDead. So the entire v5.34.85–.88
   * scoring machinery — the live meter, the consecutive-failure counters, the
   * time-based stop, and the apology-then-stop the product owner specifically
   * asked for — could not be exercised by any automated run. The one thing the
   * interview exists to produce was the one thing the rig did not watch.
   *
   * Deliberately PASSIVE: these count and narrate, and change no control flow.
   * A harness that reacts to a scoring failure would be testing the harness.
   */
  onScore: (payload) => {
    scoreCalls++;
    const dims = payload && payload.scores ? Object.keys(payload.scores).filter((d) => payload.scores[d] > 0) : [];
    for (const d of dims) scoredDims.add(d);
    say(`score pass #${scoreCalls}: ${dims.length ? dims.map((d) => `${d}=${payload.scores[d]}`).join(" ") : "no dimension had evidence yet"}`);
  },
  onScoreError: (e) => {
    scoreErrors++;
    say(`!! scoring pass FAILED (${scoreErrors}): ${(e && (e.code || e.message)) || e}`);
  },
  onScoringDead: (info) => {
    scoringDead = info || true;
    say(`!! SCORING DECLARED DEAD — the interview should now apologise and stop. ${JSON.stringify(info || {})}`);
  },
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
/* Set by nextAnswer() and by the watchdog; read only for the stall report. */
let lastCueAt = Date.now();
let stallRecoveries = 0;
async function nextAnswer() {
  if (answering || ended || Date.now() - t0 > MINUTES * 60000) return;
  if (uplinkQueue.length) { say(`(skipping a duplicate answer cue — ${uplinkQueue.length} frames still on the uplink)`); return; }
  answering = true;
  lastCueAt = Date.now();
  try {
    /*
     * v5.34.78 — STOP WHEN THE INTERVIEWEE RUNS OUT OF THINGS TO SAY.
     *
     * ANSWERS holds eight answers. A cycle costs about fourteen seconds, so
     * the scripted interviewee has said everything it knows inside two
     * minutes. Every run before this one then started the script again from
     * the top and kept going to the wall clock: the 2026-09-14 run spent
     * twenty-eight of its thirty minutes reading answers one to eight at an
     * interviewer that had correctly finished the interview at 112 seconds and
     * spent the rest of the half hour saying "we covered that already".
     *
     * That tail is not a weak measurement, it is an actively false one. It
     * invents repetition that the product did not produce, and it is billed at
     * the live model's output rate for the whole of it.
     *
     * So the default is now: one pass, then stop. --loop restores the old
     * behaviour for a deliberate soak (the ~10-minute handover needs more
     * conversation than eight answers can supply, and until the interviewee
     * side is model-generated rather than scripted, a soak is the only way to
     * reach it — see NEXT_SESSION_SPEC.md).
     */
    if (answerIndex >= ANSWERS.length && !LOOP) {
      scriptExhaustedAt = now();
      say(`— the scripted interviewee is out of material after ${ANSWERS.length} answers (${scriptExhaustedAt.toFixed(0)}s) —`);
      say(`  Stopping here. Past this point the rig repeats itself and the`);
      say(`  interviewer's replies measure the rig, not the product. Pass --loop`);
      say(`  to soak past it (that is what reaches the ~10-minute handover).`);
      answering = false;
      finish("the scripted interviewee ran out of material");
      return;
    }
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
    /*
     * v5.34.75 — BOUNDED. This was an unbounded setInterval, so a queue that
     * never drained (the socket dropping mid-answer, which is what a handover
     * is) pinned `answering` true forever, and every later cue returned at the
     * guard above. The run was then dead and nothing said so.
     */
    const drainStartedAt = Date.now();
    const waitForDrain = setInterval(() => {
      if (uplinkQueue.length === 0) {
        clearInterval(waitForDrain); askedAt = now(); answering = false; return;
      }
      if (Date.now() - drainStartedAt > 30000) {
        clearInterval(waitForDrain);
        say(`!! the uplink never drained (${uplinkQueue.length} frames left) — dropping this answer and carrying on`);
        uplinkQueue.length = 0;
        askedAt = null; answering = false;
      }
    }, 120);
  } catch (e) {
    say(`!! could not produce an answer: ${e.message}`);
    answering = false;
  }
}

/*
 * ── The conversation watchdog (v5.34.75) ────────────────────────────────────
 *
 * nextAnswer() had exactly one caller: the model's speaking -> idle edge. So
 * any single missed edge ended the interview permanently, in silence, with the
 * run still counting down. That is what happened on 2026-09-13: the newer Live
 * model sent generationComplete without turnComplete three times, the client
 * never left 'speaking', no answer was ever cued again, and the recording spent
 * roughly half of its thirty minutes with a dead uplink — rms 0, the model
 * politely waiting for a person who had stopped existing.
 *
 * vyne-live.js now salvages that turn (TURN_CLOSE_GRACE_MS), which fixes the
 * cause. This is the floor underneath it: whatever the reason, if nobody has
 * said anything for a while, say something. A harness that can be killed by one
 * dropped event cannot be trusted to report a thirty-minute result.
 *
 * Deliberately generous. A real pause between a question and an answer is a few
 * seconds; twenty-five means something is wrong, not that someone is thinking.
 */
const STALL_MS = Number(process.env.VYNE_HARNESS_STALL_MS || 25000);
/*
 * v5.34.78 — a handover is not a stall.
 *
 * Stage 2 of the self-check injects transport faults on purpose and waits out
 * a 4 + 8 + 16s retry ladder. At 26s the watchdog declared that nothing had
 * happened and cued an answer into the middle of it — into the one stage whose
 * entire subject is the timing of that ladder. Nothing broke, but the stage was
 * measuring itself plus me.
 *
 * The ceiling matters as much as the guard. Suppressing the watchdog for the
 * duration of a handover is right; suppressing it FOREVER because a handover
 * never completed would restore exactly the failure this watchdog exists to
 * catch — a dead uplink with the clock still running. So the pass is granted
 * for one retry ladder plus slack, and then the watchdog takes over again.
 */
const RENEW_GRACE_MS = Number(process.env.VYNE_HARNESS_RENEW_GRACE_MS || 60000);
setInterval(() => {
  if (ended || answering || uplinkQueue.length) return;
  if (renewingSince !== null && Date.now() - renewingSince < RENEW_GRACE_MS) return;
  if (state === "speaking" || state === "thinking") return;
  if (Date.now() - lastCueAt < STALL_MS) return;
  stallRecoveries++;
  say(`!! nothing has happened for ${Math.round((Date.now() - lastCueAt) / 1000)}s — cueing the next answer (recovery ${stallRecoveries})`);
  lastCueAt = Date.now();
  nextAnswer();
}, 2000);

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
  /*
   * v5.34.81 — say when the PROCESS was suspended, because every number below
   * is then measuring the laptop, not the model.
   *
   * A Mac sleeping mid-run freezes the whole event loop: timers stop, the
   * uplink never drains, latencies land wherever the clock resumed. On
   * 2026-09-14 that produced a 2-minute run with a 6-minute wall clock, one
   * reply, and a gate message blaming interview-close detection — sending a
   * debugging session after code that was working correctly.
   *
   * Wall clock far beyond the booked ceiling can only mean the process stopped
   * running, since every other way a run can overrun is bounded.
   */
  if (now() > MINUTES * 60 * 1.5 + 30) {
    say(`!! this run took ${(now() / 60).toFixed(1)} minutes of wall clock for a ${MINUTES}-minute booking.`);
    say(`   The process was suspended — on a laptop, that is the machine sleeping. Timers`);
    say(`   stop while it is asleep, so the latencies, the stall recoveries and the reply`);
    say(`   count below are NOT measurements of the model. Re-run with the machine awake:`);
    say(`   caffeinate -i bash deploy/run-voice-record.sh ${MINUTES}`);
  }
  say(`recording:       ${OUT_WAV}  (${(secs / 60).toFixed(1)} min, L=interviewer R=interviewee)`);
  say(`page trace:      ${OUT_LOG}`);
  say(`grants minted:   ${grantCount}   handovers: ${renewals}   mute handovers recovered: ${silentRenewals}`);
  say(`replies:         ${turns.length}`);
  /* In the verdict too: this is the line that says what was actually measured. */
  say(`persona:         ${PERSONA_SOURCE}`);
  /*
   * v5.34.94 — SCORING, IN THE VERDICT.
   *
   * "An interview without scoring is useless waste of time." A run that talked
   * for fourteen minutes and scored nothing used to produce a verdict that read
   * exactly like a good one, because nothing on this page looked at scoring at
   * all. These four lines are the difference between "the conversation worked"
   * and "the interview worked".
   */
  say(`scoring passes:  ${scoreCalls} succeeded, ${scoreErrors} failed` +
      `${scoreCalls === 0 ? "  !! NOTHING WAS SCORED — this run produced no assessment" : ""}`);
  say(`dimensions scored: ${scoredDims.size} of 7` +
      `${scoredDims.size ? ` (${[...scoredDims].sort().join(", ")})` : ""}`);
  if (scoringDead) {
    say(`scoring declared DEAD: the stop path fired — check the transcript for the apology before the stop`);
  } else if (scoreErrors && scoreCalls) {
    say(`scoring recovered after ${scoreErrors} failure(s) — the stop path correctly did NOT fire`);
  }
  /*
   * v5.34.79 — show that the no-repeat machinery actually RAN.
   *
   * Without these lines a run where the tracking silently did nothing looks
   * identical to one where it worked: both print a clean verdict. These are
   * the two numbers that say the instruction sent at the last mint differed
   * from the one sent at the first.
   */
  if (renderInstruction) {
    const outstanding = fixtureMandatory().filter((_, i) => !mandatoryDone.has(i)).length;
    say(`questions tracked: ${askedQuestions.length} asked and answered` +
        `${pendingQuestion ? ", 1 left unanswered at the end" : ""}`);
    say(`required questions: ${mandatoryDone.size} of ${fixtureMandatory().length} covered` +
        `${outstanding ? ` — ${outstanding} would still be sent as outstanding` : " — none re-sent as outstanding"}`);
    const repeats = askedQuestions.length && turns.length > askedQuestions.length
      ? turns.length - askedQuestions.length : 0;
    if (repeats > 2) {
      say(`!! ${turns.length} replies but only ${askedQuestions.length} distinct questions — the interviewer is repeating itself.`);
    }
    say(`instruction at last mint: ${currentInstruction().length} chars (was ${SYSTEM_INSTRUCTION.length} at open)`);
  }
  /*
   * Three numbers that say whether the RIG behaved, so a reader never again has
   * to infer it from a suspiciously low reply count.
   */
  /*
   * v5.34.78 — say WHY it did not close, because "no" has three meanings and
   * only one of them is a product fault. It can be: the interviewer genuinely
   * kept going (a real finding); the run stopped first because the scripted
   * interviewee ran dry (a rig limit, and the verdict must not be read as a
   * finding); or the run was a --loop soak, where the interviewer is being
   * talked at by a tape and closing rules are not what is under test.
   */
  say(`closed by agent: ${
    closedAt !== null ? `yes, at ${(closedAt / 60).toFixed(1)} min`
    : scriptExhaustedAt !== null ? `not reached — the rig ran out of answers at ${(scriptExhaustedAt / 60).toFixed(1)} min, before the question of closing arose`
    : LOOP ? "no — but this was a --loop soak, so the interviewee was a tape and this line is not evidence"
    : "no — ran to the time limit"}`);
  if (LOOP && !SELFTEST) {
    say(`!! --loop: the interviewee repeated its ${ANSWERS.length} answers ${Math.max(1, Math.ceil(answerIndex / ANSWERS.length))}x.`);
    say(`   Judge transport and endurance from this run. Do NOT judge question`);
    say(`   quality, repetition or coverage from it — after answer ${ANSWERS.length} the`);
    say(`   interviewer is responding to a loop, and any repetition is the rig's.`);
  }
  say(`stall recoveries:${stallRecoveries === 0 ? " 0 (the conversation never stalled)" : ` ${stallRecoveries} !! the uplink went quiet and the watchdog restarted it`}`);
  say(`salvaged turns:  ${(LI.session && LI.session._salvagedTurns) || 0}${(LI.session && LI.session._salvagedTurns) ? " !! generationComplete with no turnComplete — see TURN_CLOSE_GRACE_MS" : ""}`);
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
  /*
   * v5.34.78 — judge this against the run's REAL length, not its booked one.
   *
   * MINUTES is a ceiling now: the run ends when the interviewer closes or the
   * script runs dry, both of which happen inside two minutes. Testing the
   * booked figure printed "no handover happened in a run long enough to need
   * one" under a two-minute run — an alarm about a path nothing could have
   * reached, on the first run of the version that introduced the early stop.
   */
  const ranMin = now() / 60;
  if (renewals === 0 && MINUTES >= 12 && ranMin >= 12) {
    say("!! no handover happened in a run long enough to need one — the ten-minute path was NOT exercised.");
  } else if (renewals === 0 && MINUTES >= 12) {
    say(`(the ~10-minute handover was not reached: the run ended at ${ranMin.toFixed(1)} min. ` +
        `Use --loop for a soak if that path is what you want to exercise.)`);
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
say(`interviewer persona: ${PERSONA_SOURCE}`);
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
