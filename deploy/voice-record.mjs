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
         openSync, writeSync, readSync, closeSync, statSync, unlinkSync, copyFileSync } from "node:fs";
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
/*
 * v5.34.111 — a non-numeric --minutes must be FATAL, not silent.
 *
 * Measured on 2026-09-15: `run-voice-record.sh --minutes 20 --loop` was run
 * against a script that takes POSITIONAL arguments, so $1 was the literal
 * string "--minutes" and this became NaN. Nothing rejected it. The run then
 * armed its own time limit with setTimeout(finish, NaN * 60000), and a
 * setTimeout with a NaN delay fires on the next tick — so the interview ended
 * at 0.0s, before grant #1 had even come back, and printed a complete verdict:
 *
 *     minutes=NaN ... stopped because: reached the NaN-minute limit
 *     replies: 0 ... first audio: NEVER — the interviewer never spoke
 *
 * Every line of that verdict was true and none of it was about the product.
 * This file's own warning — "a broken harness and a broken product look
 * identical from here, and this one has been wrong three times" — is exactly
 * what happened, so it is now four, and the guard goes in rather than the
 * warning being restated.
 */
if (!Number.isFinite(MINUTES) || MINUTES <= 0) {
  console.error(`\n!! --minutes is "${arg("minutes", 14)}", which is not a positive number.`);
  console.error("!! Refusing to start: a NaN limit ends the run on the first tick and still");
  console.error("!! prints a full verdict, which reads as a dead product rather than a bad flag.");
  console.error("!! Note that deploy/run-voice-record.sh takes POSITIONAL arguments:");
  console.error("!!     bash deploy/run-voice-record.sh 20 soak\n");
  process.exit(2);
}
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
      questionTargetLow: f.questionTargetLow, questionTargetHigh: f.questionTargetHigh,
      elapsedMin: f.elapsedMin,
      /*
       * v5.34.111 — the interview's booked SIZE and the clock.
       *
       * Forwarded here for the reason the whole "render live, do not pin"
       * design exists: a field the product sends and this harness does not is
       * a field the paid run cannot exercise, while the verdict still reads as
       * if it had. The v5.34.111 early-close fix is entirely carried by these
       * three, so without this line tomorrow's soak would measure the old
       * behaviour and report it as the new one.
       *
       * personaInputsReachTheWire.test.ts reads the field list off
       * InterviewerContext and now checks THIS file too, so the next field
       * added to the persona fails there the day it appears.
       */
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
/*
 * ── v5.34.119: is the interviewer handing the answer back? ──────────────────
 *
 * Reported from the 2026-09-17 live interview — "Jack Smith was parroting what
 * I said back to me" — and confirmed in the transcript: ten interviewer turns,
 * ten openings of the form acknowledgement + "so" + their answer restated.
 * "Right, so it's a core pillar." "Got it, so start with quick wins for R O I."
 * "Makes sense, so embedded in the data pipelines."
 *
 * No rule asked for it and nothing measured it. A human had to sit through nine
 * minutes and notice, which is the most expensive detector this project owns.
 *
 * v5.34.119 adds persona rules against it, and a prompt rule is not a fix until
 * something checks whether the model obeyed. This is that check. It only has
 * teeth on a run against the real model — the offline stub speaks a canned
 * line — so it reports a rate rather than failing, and the paid soak is where
 * it earns its place.
 *
 * Two shapes, because they have different causes and different fixes:
 *   RECAP   — acknowledgement + "so" + a restatement. The persona habit.
 *   VERBATIM— a long run of the interviewee's own words played back. The
 *             handover nudge; see v5.34.119 in vyne-live-interview.js.
 */
/*
 * ── v5.34.120: the detector had a hole, and the next interview found it. ────
 *
 * v5.34.119 cut the parroting from 9-of-10 turns to 5-of-15 on the 2026-09-17
 * 08:13 interview. Two of those five were invisible to the rule above:
 *
 *   "I HEAR YOU, so you're tracking deviations from expected results."
 *        — "i hear you" was not in the acknowledgement list.
 *
 *   "That's interesting that you're seeing such significant productivity gains
 *    from your current workforce."
 *   "Having those governance teams and data stewards is clearly essential for
 *    managing quality across the board."
 *        — praise, then a restatement, with no "so" anywhere. A phrase list
 *          cannot catch this shape; there is no fixed phrase in it.
 *
 * So the detector would have reported ~20% against a true rate of ~33%. An
 * instrument that understates the defect it was built for is worse than none,
 * because it licenses the conclusion that the fix worked.
 *
 * Two rules now, with different mechanics on purpose:
 *
 *   RECAP_OPENER  — the "<ack>, so <restatement>" shape, by phrase, widened.
 *   the overlap test below — a long, question-free opening sentence that
 *     reuses a run of the interviewee's own words. No phrase list, so it
 *     catches shapes nobody has seen yet.
 *
 * The overlap test has to spare the form v5.34.119 deliberately protects —
 * "You mentioned a three-year roadmap. Is that formally funded now?" — so an
 * opening that explicitly attributes ("you mentioned", "you said", "going back
 * to") is exempt. That exemption is the whole reason this is two rules rather
 * than one, and neverReadTheAnswerBack.test.ts holds both halves against the
 * real transcript lines.
 */
const RECAP_OPENER = /^\s*(right|got it|gotcha|ok|okay|alright|all right|makes sense|interesting|understood|noted|i see|i hear you|i hear that|that's fair|fair enough|absolutely|of course|sure)\b[,.!]?\s+so\b/i;
/* An opening that names them as the source is the permitted form, not a recap. */
const ATTRIBUTED_OPENER = /^\s*(you (mentioned|said|described|talked about|noted)|going back to|coming back to|on the .{0,30}you)/i;
/*
 * There WAS a RECAP_MIN_WORDS floor here (10), on the theory that a short
 * opening sentence is a reaction rather than a recap. Removing it changed no
 * test, and no realistic clean opening is both short and shares a five-word run
 * with the answer — the "?" check and the overlap threshold already carry the
 * work. Deleted rather than kept as an unfalsifiable knob.
 */
/* Shared consecutive words that make an opening a restatement rather than reuse. */
const RECAP_OVERLAP_WORDS = 5;
let agentTurnsSeen = 0, recapOpeners = 0, recapRestates = 0, verbatimEchoes = 0;
const recapExamples = [], restateExamples = [], echoExamples = [];
/** The interviewee's last answer, for the verbatim check. */
let lastAnswerSpoken = "";
/** Longest run of consecutive words shared between the two strings. */
function longestSharedRun(a, b) {
  const wa = String(a).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const wb = String(b).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (!wa.length || !wb.length) return 0;
  let best = 0;
  let prev = new Array(wb.length + 1).fill(0);
  for (let i = 1; i <= wa.length; i++) {
    const cur = new Array(wb.length + 1).fill(0);
    for (let j = 1; j <= wb.length; j++) {
      if (wa[i - 1] === wb[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    }
    prev = cur;
  }
  return best;
}
/* Eight words is well past coincidence and well inside a recited sentence. */
const VERBATIM_RUN_WORDS = 8;
/*
 * The whole classification, as ONE pure function. (v5.34.120)
 *
 * It was inline in recordAgentTurn, and the tests that cover it had to rebuild
 * the logic in order to call it — so three deliberate mutations of the real
 * branch (dropping the restate shape, dropping the attributed-form exemption,
 * dropping the overlap threshold to 2) all passed a green suite. The tests were
 * grading a reimplementation, which is this harness's own signature failure
 * appearing inside the check written to catch it.
 *
 * Extracted so neverReadTheAnswerBack.test.ts can lift this exact source and
 * run it. Returns null, "opener" or "restate".
 */
function classifyAgentTurn(turn, lastAnswer) {
  const whole = String(turn).replace(/\s+/g, " ").trim();
  if (!whole) return null;
  if (RECAP_OPENER.test(whole)) return "opener";
  if (!lastAnswer || ATTRIBUTED_OPENER.test(whole)) return null;
  /* First sentence only: a recap is a preamble, and content further in is the
   * question it precedes. */
  const first = (whole.split(/(?<=[.?!])\s/)[0] || "").trim();
  if (first.includes("?")) return null;
  return longestSharedRun(first, lastAnswer) >= RECAP_OVERLAP_WORDS ? "restate" : null;
}
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
  /* v5.34.119 — measured before the question extraction, which drops any turn
   * without a '?' and would therefore miss a pure recap. */
  const whole = String(text).replace(/\s+/g, " ").trim();
  if (whole) {
    agentTurnsSeen++;
    const handedBack = classifyAgentTurn(whole, lastAnswerSpoken);
    if (handedBack === "opener") {
      recapOpeners++;
      if (recapExamples.length < 4) recapExamples.push(whole.slice(0, 90));
    } else if (handedBack === "restate") {
      recapRestates++;
      if (restateExamples.length < 4) restateExamples.push(whole.slice(0, 90));
    }
    if (lastAnswerSpoken && longestSharedRun(whole, lastAnswerSpoken) >= VERBATIM_RUN_WORDS) {
      verbatimEchoes++;
      if (echoExamples.length < 3) echoExamples.push(whole.slice(0, 90));
    }
  }
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
/*
 * ── v5.34.110: write down what the interviewer was actually told ───────────
 *
 * The instruction was built, sent, and never recorded — only its LENGTH
 * reached the verdict. So when the interviewer closed at 3.3 minutes with both
 * required questions outstanding, there was no way to tell whether it had been
 * told about them and ignored it, or never been told at all. Those are a
 * prompt fault and a context-assembly fault, and the fix differs for each.
 *
 * Called from BOTH mint paths, live and offline, so the capture itself is
 * exercised on every free run rather than only on the paid ones.
 */
function recordInstruction() {
  const text = currentInstruction();
  try {
    mintedInstructions.push(text);
    writeFileSync(at(`instruction-${String(mintedInstructions.length).padStart(2, "0")}.txt`), text);
  } catch (e) {}
  return text;
}

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
    /* v5.34.111: minutes of conversation so far, as LiveInterview.elapsedMinutes()
     * computes it in the product — from the start of the INTERVIEW, not of this
     * connection, so it keeps counting across a handover. */
    elapsedMin: Math.round((Date.now() - t0) / 60000),
  });
}

const HOST = "generativelanguage.googleapis.com";
const KEY = process.env.GEMINI_API_KEY || "";

const at = (name) => (isAbsolute(OUT) ? `${OUT}.${name}` : join(ROOT, `${OUT}.${name}`));
const OUT_WAV = at("wav");
const OUT_LOG = at("log");
const OUT_TXT = at("txt");
/* v5.34.103: per-run archive of the trace and verdict; set in finish(). */
let ARCHIVE_DIR = null;
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

/*
 * ── The interviewee's answers. (v5.34.114) ──────────────────────────────────
 *
 * Rewritten from a REAL 12-minute interview recorded on v5.34.111 with a group
 * CIO, lightly generalised — the client's name and anything identifying is
 * out; the substance, the register and the length of the answers are his.
 *
 * Why this matters more than it looks. The previous set had EIGHT answers, and
 * a cycle costs about twenty-eight seconds of wall clock, so the tape ran out
 * of distinct material at roughly 3.7 minutes. Every run past that point was
 * the interviewer talking to a loop.
 *
 * That one number silently invalidated a great deal of work. The v5.34.110
 * soak "closed at 4.4 minutes" and a 2026-09-13 recording "decided the
 * interview was finished at roughly four minutes" — and both of those are just
 * when the tape stopped saying anything new. They were read, including by me,
 * as the interviewer deciding it was done, which sent a whole night after a
 * defect whose evidence was an artefact of this array's length. The live
 * 12-minute interview that produced these answers showed no such thing.
 *
 * Twenty-two answers is about ten minutes of distinct conversation. That
 * crosses the ~9-minute handover with real material still in hand, which is
 * the first time this harness can say anything honest about what happens
 * after it. Keep it growing rather than looping: --loop is still there, and
 * its verdict still says not to judge repetition from it, but the point is to
 * need it less.
 *
 * These are ANSWERS ONLY. Nothing here is an instruction, a question, or
 * anything the interviewer should treat as direction — the rig speaks them
 * through TTS as the interviewee's turn, exactly as a person would.
 */
const ANSWERS = [
  "I care about the ROI that AI produces. At the end of the day AI is another technology, and I don't distinguish it from any other technology in that sense. It's a tool to generate business value. The number one metric I follow is what is the value of the effort we're putting in.",
  "We do that on every project, it's part of our governance process. We look at both hard ROI and cost avoidance. From a financial standpoint the only thing we really give weight to is hard ROI; we discount cost avoidance significantly. The other thing we value is revenue growth without cost increase.",
  "The measurement tells you what is worth tackling. If the return on investment is highest, that pushes a project up the chain, and then the complexity of execution. High value and low complexity become quick wins. High value and medium complexity take second priority. Value is always the key driver.",
  "It's a combination of different departments, not just one area. A very high return with a very high investment is not the highest percentage return. We look at it through the lens of highest percentage return, so we want maximum value for a dollar invested. That's how we prioritise.",
  "When we look at projects we ask whether something can be done as a central capability, through our centre of excellence, and to what extent that can then be customised for regional or functional nuances. If the investment is made centrally we take the modification investment from the regions, and the costs and benefits are shared.",
  "Not everything starts centrally. Sometimes projects start decentralised. But if it's a project that makes sense for many functions and many regions, we then bring it centrally to build something common that is customised for regions.",
  "We have a global data warehouse and we also have regional data warehouses. The global one holds common data for global processes and data that can be leveraged across regions. If data is very specific to a regional system or a regional language, we let it sit in those decentralised zones and we access it through APIs when needed.",
  "We do have situations where we have very specific siloed systems holding very specific data that isn't worth centralising, simply because the effort doesn't generate the ROI. In those cases we still make the data accessible to other interested parties who have the permissions, through APIs.",
  "That is usually the long pole in the tent. Data captured well, entered properly, generated with quality, is easier to handle. Sometimes we have data coming from different sources that has to be normalised, and that effort sits with our data engineering centre of excellence. We take a lot of effort cleansing data to some set of standards.",
  "I don't know the names of the frameworks, but we definitely rely on tools. We have data quality tools that we run. We also use some of our AI capabilities to identify opportunities to cleanse data. We have master data management systems, reference systems that are cleansed, catalogues that are maintained.",
  "We have data scientists centrally and we also have some embedded data science teams. The embedded data scientists are people who also have domain specific knowledge.",
  "The embedded teams report into the function head of the region or the department. They have a dotted line to the chief data officer's organisation.",
  "We try our best to keep a good data catalogue. It is, I would say, about eighty to ninety percent up to date. Of course we have modifications sometimes that aren't fully current, but the attempt is to keep it up to date.",
  "That is effort we do through our data governance process. We have a data governance committee across different domains. There are data stewards, and those stewards help keep the definitions up to date.",
  "We are mostly cloud. Almost a hundred percent. We are trying to avoid anything on premises.",
  "It's a combination. If it makes sense for us to buy something we always prefer that. But if it is something very customised to our needs we try to build it, and if there's nothing in the market that meets our requirements we build it. The preference is to buy a solution that brings us speed to market.",
  "Model monitoring sits with the team that owns the product. We watch for drift on the inputs rather than waiting for the output to go wrong, and there is a retraining cadence, though I would not claim it is uniform across every model we run.",
  "Adoption is the part people underestimate. We can deliver a model that is technically correct and still see a market ignore it because it doesn't fit how they actually work on a Tuesday morning. So we put change effort alongside the build now.",
  "Risk and legal are involved from the start on anything customer facing. For internal productivity work the bar is lower and the team can move faster, but anything that touches a consumer or a regulated process goes through review before it ships.",
  "Honestly, the skills gap is less about data science than about people who can translate between the business problem and the technical one. Those people are rare and we tend to grow them rather than hire them.",
  "We have had failures. A couple of projects where we built something perfectly good that solved a problem nobody was being measured on, so it never got used. We learned to check who owns the number before we start.",
  "If I look two years out, the thing that would change most is having the data foundation good enough that a new use case takes weeks rather than quarters. That is the constraint now, more than the models themselves.",
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
/*
 * When this RUN's clock runs out. Assigned once the interviewee's answers have
 * been synthesised and the interview is about to begin — see the note at the
 * assignment. Declared here, and Infinity until then, so that a call before it
 * is set cannot throw on a temporal-dead-zone const.
 */
let RUN_DEADLINE_AT = Infinity;

/*
 * ── Was this process actually RUNNING? (v5.34.112) ──────────────────────────
 *
 * v5.34.81 added a suspension warning, and it only fires when the TOTAL wall
 * clock overruns the booking by 1.5x. That catches a laptop that slept and
 * woke late. It cannot catch a suspension INSIDE a run, because `finish()` is
 * itself driven by the wall clock: the run still ends on schedule, the frozen
 * minutes are simply eaten out of the conversation, and every number in the
 * verdict is quietly measuring a machine instead of a model.
 *
 * That is what the 20-minute v5.34.111 soak was. It reported 20.1 minutes for
 * a 20-minute booking, so the existing detector stayed silent — while the
 * trace showed a 30-SECOND drain timeout firing 184 seconds after it was
 * armed:
 *
 *     283.4s answering (9.2s): "Honestly the biggest constraint..."
 *     467.5s !! the uplink never drained (32 frames left)
 *
 * A 30s timer cannot fire 184s late on a running event loop. Timers were
 * frozen. "The connection to Google jammed for three minutes" and "this
 * laptop was asleep for three minutes" produce an identical trace, and the
 * harness had no way to tell them apart — so it reported the first, which
 * sends someone hunting a transport bug that may not exist.
 *
 * A one-second heartbeat settles it. Timer drift on a busy event loop is tens
 * of milliseconds; a suspended process shows up as seconds. Recorded, summed
 * and reported, so every future run says plainly whether its own numbers are
 * about the product.
 */
const HEARTBEAT_MS = 1000;
/* Anything past this is not scheduling jitter. Generous: a GC pause or a
 * synchronous WAV write can cost a few hundred ms and must not count. */
const SUSPEND_FLOOR_MS = 3000;
const suspensions = [];
let lastBeatAt = Date.now();
setInterval(() => {
  const gap = Date.now() - lastBeatAt;
  lastBeatAt = Date.now();
  if (gap > SUSPEND_FLOOR_MS) {
    suspensions.push({ at: (Date.now() - t0 - gap) / 1000, frozenSec: (gap - HEARTBEAT_MS) / 1000 });
  }
}, HEARTBEAT_MS).unref?.();
const suspendedSec = () => suspensions.reduce((a, s) => a + s.frozenSec, 0);
let processors = [];
let uplinkQueue = [];                                   // Int16Array chunks to send
const trace = [];

/*
 * ── the floor-hold invariant (v5.34.101) ──────────────────────────────────
 *
 * The defect this exists to catch: a turn going to 'idle' while seconds of the
 * interviewer's voice are still queued, which reopens the mic and invites the
 * interviewee to talk over a question still being asked. It was invisible for
 * a release because the numbers that show it — playbackPending, stillQueuedSec
 * — were printed in the trace and read by nobody, while the verdict said the
 * run was clean.
 *
 * So the rig now WATCHES rather than merely records. Every close that leaves
 * real audio queued must be followed immediately by either a hold, or the
 * goAway shortening that deliberately overrides it. Anything else is the bug
 * back again, and the verdict says so in as many words.
 *
 * Passive, like the scoring observers: it counts and narrates, and changes no
 * control flow. A rig that reacted would be testing itself.
 */
const FLOOR_HOLD_FLOOR_MS = 250;        // matches IDLE_DEFER_MIN_MS in vyne-live.js

/*
 * Read at verdict time over the whole trace rather than streamed line by line.
 * _closeTurn banks usage and ends the playback run between the close line and
 * the hold line, and either of those may log; a strict next-line match would
 * then score every turn a violation and the rig would cry wolf on a correct
 * build. A short window after each close is what the sequence actually
 * guarantees.
 */
const FLOOR_HOLD_WINDOW = 6;            // lines after a close to look in
function auditFloorHolds(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!/model turn ENDS/.test(lines[i])) continue;
    const m = /"playbackRemainingMs":\s*(\d+)/.exec(lines[i]);
    const ms = m ? Number(m[1]) : 0;
    if (ms < FLOOR_HOLD_FLOOR_MS) continue;          // nothing left to hear
    const window = lines.slice(i + 1, i + 1 + FLOOR_HOLD_WINDOW).join("\n");
    if (/holding the floor until playback drains/.test(window)) { floorHolds++; continue; }
    if (/shortening the floor hold/.test(window)) continue;   // goAway overrode it, by design
    idleWhileSpeaking++;
    if (ms > worstIdleWhileSpeakingMs) worstIdleWhileSpeakingMs = ms;
  }
}

/*
 * ── a turn closes once (v5.34.106) ─────────────────────────────────────────
 *
 * Two 'model turn ENDS' with no audio between them is the same turn closing
 * twice. That double-banks the turn's usage, and since v5.34.105 it also
 * flushes the interviewer's words into the transcript twice and spends a
 * second paid scoring call on one conversation.
 *
 * Reachable only under --offline-late-turn-complete, which is why that mode
 * exists: the no-turnComplete default can never produce a second close, and
 * the legacy mode never salvages, so neither shape can reach it.
 */
function auditDoubleCloses(lines) {
  /*
   * Deliberately narrow: only a SALVAGE close followed by a turnComplete
   * close, with no audio between, is counted.
   *
   * The first version of this flagged any two closes with no audio between,
   * and flagged a turnComplete->turnComplete pair. That is not a defect the
   * product agrees with: liveTurnOwnership drives three turns with bare
   * turnComplete frames and requires three closes, because a real session
   * once reported 367 output tokens for ten minutes of speech by treating
   * several turns as one. A rig that calls that shape a bug would push
   * somebody into re-breaking a thirteenfold under-count.
   *
   * Salvage-then-turnComplete is unambiguous: the salvage only ever fires
   * when turnComplete did NOT arrive, so a turnComplete immediately after it,
   * with nothing generated in between, is the same turn closing twice.
   */
  /*
   * v5.34.106 — and the barge-in invariant, audited in the same pass.
   *
   * A flush stops scheduled audio: it will never be heard. Holding the floor
   * for it would leave the interviewee waiting in silence for a sentence that
   * was thrown away — the v5.34.101 defect inverted. PlaybackQueue.flush()
   * zeroes _lastEnd to prevent that, and until this mode existed nothing
   * offline had ever flushed, so the guarantee was never once exercised.
   */
  let flushedSinceAudio = false;
  let lastCloseWasSalvage = false;
  for (const line of lines) {
    if (/playback flush/.test(line)) flushedSinceAudio = true;
    else if (/frame AUDIO/.test(line)) flushedSinceAudio = false;
    else if (flushedSinceAudio && /holding the floor until playback drains/.test(line)) {
      heldAfterFlush++;
      flushedSinceAudio = false;
    }
    if (/(late (turnComplete|close) ignored|close ignored — nothing has been generated)/.test(line)) {
      lateClosesSuppressed++;
      const g = /"msSinceSalvage":\s*(\d+)/.exec(line);
      if (g) lateCloseGapsMs.push(Number(g[1]));
      continue;                       // guarded: the turn did not close again
    }
    /*
     * v5.34.109 — transcript counts as "something happened" here too.
     *
     * The audit used audio alone to mark a new turn, and reported two double
     * closes on the mute-reply mode: a text-only turn HAS no audio, so a
     * legitimate close looked like a duplicate. An audit that cries wolf on a
     * correct build is worse than no audit, because the next real one gets
     * waved through.
     */
    if (/frame AUDIO|frame agentTranscript/.test(line)) { lastCloseWasSalvage = false; continue; }
    const m = /model turn ENDS[^\n]*"via":"(\w+)"/.exec(line);
    if (!m) continue;
    /*
     * v5.34.109 — ANY close after a salvage, not only a turnComplete one. A
     * second generationComplete re-arms the salvage timer, so salvage->salvage
     * is reachable too, and the narrower audit was blind to it.
     */
    if (lastCloseWasSalvage) doubleClosedTurns++;
    lastCloseWasSalvage = m[1] === "generationComplete";
  }
}

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
    systemInstruction: { parts: [{ text: recordInstruction() }] },
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
  /*
   * ── v5.34.100: SCORING IS STUBBED IN A LIVE RUN, NOT LEFT TO 404 ──────────
   *
   * Everything that was not a grant or a close fell through to the 404 below —
   * including /api/llm/generate, which vyne-live-interview.js calls every 20s
   * once two turns exist. The page read that as http_404 and counted a failed
   * scoring pass, and the v5.34.85 scoring-dead stop then did exactly what it
   * is supposed to do: after five failures and five minutes with nothing ever
   * scored, it apologised to the interviewee and stopped the interview.
   *
   * So a 14-minute live run terminated at ~5 minutes and never reached the
   * ~10-minute handover it was started for — a rig fault presenting as a
   * product failure, which is this harness's oldest recurring trap.
   *
   * The offline path has stubbed this since v5.34.83 for the same reason. The
   * live path needs it too: this rig measures voice transport, and it carries
   * neither an API origin nor a session cookie, so it cannot score and should
   * not pretend the attempt means anything. Answer score-shaped, count it, and
   * say plainly in the verdict that scoring was NOT exercised.
   */
  if (/\/api\/llm\/generate$/.test(u.split("?")[0])) {
    scoreStubCalls++;
    return { ok: true, status: 200, json: async () => ({
      text: JSON.stringify({ scores: {}, findings: [], rationale: "harness stub — scoring not exercised" }) }) };
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
 * v5.34.114 — how much NOTICE the stub's goAway gives, matching production.
 *
 * The stub said "8s" and production says "50s" — measured in the 2026-09-15
 * live trace as {"timeLeft":"50s"}. That four-second-versus-fifty-second gap
 * is not cosmetic: v5.34.112 made the handover hold out for a real pause in
 * the conversation while there is headroom to do so, relaxing only as the
 * deadline nears. With 8s of notice there is never any headroom, so every
 * offline run took the old 1500ms path and could not exercise the new logic at
 * all — an offline check that would have reported PASS on a behaviour it never
 * reached. The same trap as every other instrument bug in this file, one layer
 * out: the stub was faithful to the frame's SHAPE and not to its CONTENT.
 */
const OFFLINE_GOAWAY_TIMELEFT = arg("offline-goaway-timeleft", "50s");
/*
 * Silence inserted INSIDE each answer, so the tape pauses for thought the way
 * a person does. See the note where it is applied. Default 2000ms — measured
 * against the reported defect, where a pause of roughly that length was read
 * as the end of a turn. Set 0 for the old unbroken-speech tape.
 */
const OFFLINE_THINK_PAUSE_MS = Number(arg("offline-think-pause", 2000));
/* v5.34.101 — see the stub's turn-ending frames. Opt-in for now so the existing
 * wrapper stages keep their measured baselines; it is the truthful default once
 * those are re-baselined. */
/*
 * v5.34.101 — production-shaped turn frames are now the DEFAULT.
 *
 * This shipped as an opt-in flag a few hours ago and that was the wrong call.
 * The behaviour it simulates is not an edge case to be exercised on demand; it
 * is what the model does on every turn in production, and a rig whose default
 * is a world that stopped existing will keep passing while the product fails.
 * The old pacing is kept behind --offline-legacy-turns, for bisecting against
 * a build from before the model changed. --offline-prod-turns still parses so
 * existing invocations and notes do not break.
 */
const OFFLINE_PROD_TURNS = !has("offline-legacy-turns");
/*
 * ── v5.34.106: --offline-late-turn-complete <ms> ──────────────────────────
 *
 * A third turn shape, and the one neither of the other two can produce.
 *
 * Production's flakiness is not only "turnComplete never comes". It is also
 * "turnComplete comes LATE" — after TURN_CLOSE_GRACE_MS, so the salvage has
 * already closed the turn. That sequence used to be harmless because
 * _closeTurn set 'idle' immediately and the salvage timer's own guard made a
 * closed turn uncloseable. v5.34.101 holds the floor, so the state stays
 * 'speaking' and the late frame closes the same turn a second time: usage
 * banked twice, and since v5.34.105 the transcript flushed twice and a second
 * paid scoring call spent on the same conversation.
 *
 * Default 0 (off), because it is a THIRD shape rather than a replacement: the
 * common production case is no turnComplete at all, and that stays the
 * default. Set it above TURN_CLOSE_GRACE_MS (1200) or the salvage never fires
 * and the mode tests nothing.
 */
const OFFLINE_LATE_TURN_COMPLETE = Number(arg("offline-late-turn-complete", 0)) || 0;

/*
 * ── v5.34.106: two more shapes the rig could never produce ────────────────
 *
 * --offline-mute-replies N   every Nth reply is TEXT with no voice at all
 * --offline-barge-in N       every Nth reply is cut off by the interviewee
 *
 * Both are real, both are observed by this harness, and neither had ever
 * happened in it. onReplyWithoutAudio has had a `say()` line since v5.34.40
 * and no offline run has ever printed it; no run has ever sent an
 * `interrupted` frame either. A handler that is watched but never exercised
 * is the same dead wiring this codebase keeps finding in the product — here
 * it was in the thing meant to catch it.
 *
 * The mute shape matters particularly for v5.34.106: a text-only reply gives
 * no audio and no thinking-text, so nothing reopens the salvage close guard
 * for it. Only LATE_TURN_COMPLETE_WINDOW_MS tells it from a late frame, and
 * that reasoning was written without ever being run.
 */
const OFFLINE_MUTE_REPLIES = Number(arg("offline-mute-replies", 0)) || 0;
/*
 * v5.34.112 — THE MODEL GOES SILENT. The one fault this rig could not inject.
 *
 * The 20-minute v5.34.111 soak hit it twice for real:
 *
 *     283.4s answering (9.2s): "Honestly the biggest constraint is not..."
 *     467.5s !! the uplink never drained (32 frames left) — dropping this answer
 *     469.3s !! nothing has happened for 186s
 *     494.9s onError: live_socket_error
 *
 * Three minutes of dead air, ended by the socket failing outright and a forced
 * reconnect, whose first reply took 20.3s — the worst latency of the run and
 * the longest hole an interviewee would sit through. Every other fault this
 * harness can fake (a missing turnComplete, a mute reply, a barge-in, a failed
 * mint, a goAway) was added after a real run exposed it. This is that, for the
 * fault that matters most to a thirty-minute conversation: after reply N the
 * stub answers nothing at all, forever.
 *
 * It is also the only way to check that the stall watchdog still has teeth
 * after being re-based on model activity in this same version — a watchdog
 * that no longer cries wolf is worth nothing if it also no longer barks.
 */
const OFFLINE_SILENT_AFTER = Number(arg("offline-silent-after", 0)) || 0;
const OFFLINE_BARGE_IN = Number(arg("offline-barge-in", 0)) || 0;
/*
 * ── v5.34.117: the goAway'd connection that stops answering. ────────────────
 *
 * Reported from a live interview on v5.34.116 and read off the 🩺 trace: the
 * server sent goAway at 9m07s, transcribed a 38.7-second answer, and then
 * produced no model frame for twenty seconds. Total silence 25s, broken only
 * by the interviewee asking whether anyone was there.
 *
 * Every offline fault this rig can fake was added after a real run exposed it,
 * and this is the shape none of them covered. --offline-silent-after is the
 * nearest: it silences the stub FOREVER, and forever is a different code path
 * (`_watchRenewedSilence`, the retry ladder) from a socket that stalls once
 * because it is closing. The difference matters — the whole v5.34.117 fix
 * lives in the gap between them.
 *
 * Under this flag: the first interviewee turn AFTER a goAway is transcribed
 * normally and then answered `--offline-stall-after-goaway` ms later instead
 * of the usual 600. The client should never see that reply: it should notice
 * the stall, hand over, and take the answer with it. The verdict measures how
 * long the silence actually lasted, which is the number the interviewee feels.
 */
const OFFLINE_STALL_AFTER_GOAWAY = Number(arg("offline-stall-after-goaway", 0)) || 0;
let stallsInjected = 0;
let muteRepliesSent = 0;
let muteRepliesDetected = 0;
let bargeInsSent = 0;

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
      /* v5.34.100: counted, so the verdict says "NOT EXERCISED" here too. An
       * offline run that reported "scoring passes: 2 succeeded" was claiming a
       * success for this stub answering itself. */
      scoreStubCalls++;
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
    recordInstruction();          // same capture as the live path
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
    /* v5.34.117 — per SOCKET, not per run: a goAway is a fact about one
     * connection, and the stall must be injected on the dying one only. */
    let goAwaySent = false, stalledThisSocket = false;
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
          /*
           * v5.34.117 — transcribe it, then go quiet. The transcript is what
           * makes this the reported defect rather than a dead uplink: the
           * server demonstrably HEARD the turn, so nothing is lost, and the
           * client's own `_awaitingReply` is armed and never cleared.
           */
          let replyIn = 600;
          if (OFFLINE_STALL_AFTER_GOAWAY > 0 && goAwaySent && !stalledThisSocket) {
            stalledThisSocket = true; stallsInjected++;
            replyIn = OFFLINE_STALL_AFTER_GOAWAY;
            /*
             * v5.34.117 — and the INTERVIEWEE goes quiet, which is half the
             * scenario.
             *
             * On the reported run they finished a 38.7-second answer and then
             * waited. The rig's tape does the opposite: with --loop it talks
             * almost continuously, and the product correctly refuses to tear a
             * socket down mid-word — so the first version of this stage
             * measured 13.1s and blamed the product for the tape.
             *
             * Dropping the queued audio here is the interviewee stopping. The
             * pump keeps running (it must — see startPump: a harness that goes
             * mute inflates every latency it measures), so the uplink carries
             * silent frames, which is exactly what a person waiting sounds
             * like.
             */
            const dropped = uplinkQueue.length;
            uplinkQueue.length = 0;
            /*
             * v5.34.118 — and a SECOND goAway, ten milliseconds behind the
             * transcript, because that is what the server actually does.
             *
             *   v5.34.116 trace   +549693 USER TURN #9   → +549704 goAway
             *   v5.34.117 trace   +788650 USER TURN #13  → +788660 goAway
             *
             * Two builds, two live interviews, the same ten milliseconds, and
             * in both the turn was never answered. Without this frame the rig
             * reproduces the silence but not the SIGNAL, so the whole of
             * v5.34.118 — which exists to act on that signal — would be
             * untestable offline and the stage would report v5.34.117's 5.9s
             * as if it were the best available.
             */
            setTimeout(() => closed || frame({ goAway: { timeLeft: OFFLINE_GOAWAY_TIMELEFT } }), 10);
            say(`   (rig: goAway'd connection transcribed this turn, sent a second goAway on top ` +
                `of it, and will not answer for ${(OFFLINE_STALL_AFTER_GOAWAY / 1000).toFixed(0)}s; ` +
                `interviewee falls silent, ${dropped} queued frames dropped)`);
          }
          setTimeout(reply, replyIn);
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
      /* v5.34.112: past this point the model is gone. No frames of any kind —
       * not audio, not text, not generationComplete — which is what a stalled
       * uplink looks like from the page's side. */
      if (OFFLINE_SILENT_AFTER > 0 && stubReplies > OFFLINE_SILENT_AFTER) {
        if (stubReplies === OFFLINE_SILENT_AFTER + 1) {
          say(`(rig: the model has gone SILENT after reply ${OFFLINE_SILENT_AFTER} — no further frames)`);
        }
        return;
      }
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
      /*
       * ── v5.34.101: --offline-prod-turns reproduces what Google now does ─────
       *
       * The default stub paces audio in real time and ends with turnComplete.
       * Production does neither. The real model pushes a whole answer down the
       * socket as fast as it will go and then sends generationComplete, and as
       * of 2026-09-14 gemini-2.5-flash-native-audio-latest sends no
       * turnComplete at all (11 generationComplete, 0 turnComplete on a live
       * run). So the rig has been testing a world that stopped existing, which
       * is why `salvaged turns: 0` offline and 11 live, and why the turn-close
       * defect could not be reproduced for free.
       *
       * Under this flag: burst the audio (so the playback queue builds a real
       * backlog) and close with generationComplete only.
       */
      const burst = OFFLINE_PROD_TURNS;
      /*
       * v5.34.106 — a MUTE reply: transcript, no audio at all. The turn still
       * ends (generationComplete), so it exercises the salvage on a turn that
       * produced no audio, which is the one shape that reopens nothing in the
       * v5.34.106 close guard.
       */
      const mute = OFFLINE_MUTE_REPLIES > 0 && stubReplies % OFFLINE_MUTE_REPLIES === 0;
      if (mute) {
        muteRepliesSent++;
        say(`   (rig: reply ${stubReplies} sent as TEXT with no voice)`);
        setTimeout(() => closed || frame({ serverContent: { generationComplete: true } }), 1200);
        return;
      }
      for (let o = 0; o < n; o += OUT_RATE / 4) {
        const part = pcm.subarray(o, Math.min(o + OUT_RATE / 4, n));
        const emit = () => closed || frame({ serverContent: { modelTurn: { parts: [{ inlineData: {
          mimeType: `audio/pcm;rate=${OUT_RATE}`,
          data: Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString("base64") } }] } } });
        if (burst) setTimeout(emit, 5); else setTimeout(emit, (o / OUT_RATE) * 1000);
      }
      /*
       * v5.34.106 — a BARGE-IN: the interviewee talks over the answer. The
       * server sends `interrupted`, the client flushes the playback queue, and
       * v5.34.101's floor hold must release AT ONCE rather than waiting out
       * audio that will never be heard. flush() zeroing _lastEnd is what makes
       * that true, and nothing offline had ever tested it.
       */
      if (OFFLINE_BARGE_IN > 0 && stubReplies % OFFLINE_BARGE_IN === 0) {
        bargeInsSent++;
        say(`   (rig: interviewee barges in over reply ${stubReplies})`);
        /*
         * 1500ms, not 400: the turn is closed by the salvage at
         * generationComplete + TURN_CLOSE_GRACE_MS (~1260ms) and the floor is
         * then held for the ~1s of audio still queued. A barge-in at 400ms
         * lands on a turn that has not closed yet and tests nothing about the
         * hold. Landing it INSIDE the hold is the real sequence — the
         * interviewee talks over the tail of the question — and it is the only
         * way to reach the interaction between flush() and the deferred idle.
         */
        setTimeout(() => closed || frame({ serverContent: { interrupted: true } }), 1500);
      }
      if (burst) {
        /*
         * v5.34.106 — in barge-in mode the turn must END AFTER the
         * interruption, not before it.
         *
         * With generationComplete at 60ms the turn is always closed by the
         * time the barge-in lands, so the close computes its remaining
         * playback before any flush — and the one guarantee flush() makes,
         * that it zeroes _lastEnd, is never exercised. Removing that line
         * changed nothing in the verdict, which is how a rig gives false
         * assurance.
         *
         * Ordering it after the interrupt reaches the real sequence: the
         * interviewee talks over the question, the queue is flushed, and THEN
         * the model's turn ends. The close must find nothing left to play.
         */
        const bargingThisTurn = OFFLINE_BARGE_IN > 0 && stubReplies % OFFLINE_BARGE_IN === 0;
        setTimeout(() => closed || frame({ serverContent: { generationComplete: true } }),
                   bargingThisTurn ? 1900 : 60);
        if (OFFLINE_LATE_TURN_COMPLETE > 0) {
          /*
           * ── v5.34.110: what production actually puts in the gap ───────────
           *
           * The live run of 2026-09-15 closed all 44 turns twice with a guard
           * that should have stopped it. The guard was not at fault: SIXTEEN
           * sessionResumptionUpdate frames sat between the salvage close and
           * the late turnComplete, each carrying usageMetadata — which
           * parseServerFrame reads off ANY frame, so every one of them looked
           * like the model generating something and re-armed the guard.
           *
           * The rig sent an EMPTY gap, so no free run could reproduce it. It
           * now fills that gap the way the server does. Without this the fix
           * is untestable offline, and the next one would be guessed too.
           */
          for (let g = 200; g < OFFLINE_LATE_TURN_COMPLETE; g += 500) {
            setTimeout(() => closed || frame({
              sessionResumptionUpdate: { resumable: true, newHandle: `h${stubReplies}-${g}` },
              usageMetadata: { promptTokenCount: 1200, responseTokenCount: 40 },
            }), 60 + g);
          }
          /* After the salvage has already closed this turn. */
          setTimeout(() => closed || frame({ serverContent: { turnComplete: true } }),
                     60 + OFFLINE_LATE_TURN_COMPLETE);
        }
      } else {
        setTimeout(() => closed || frame({ serverContent: { turnComplete: true } }), dur * 1000 + 100);
      }
      void b64;
    }
    setTimeout(() => {
      ws.readyState = 1; ws.onopen && ws.onopen();
      setTimeout(() => frame({ setupComplete: {} }), 30);
      setTimeout(() => {
        if (closed) return;
        goAwaySent = true;
        frame({ goAway: { timeLeft: OFFLINE_GOAWAY_TIMELEFT } });
      }, OFFLINE_GOAWAY_MS);
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
  /*
   * ── A person pauses in the middle of an answer. (v5.34.114) ───────────────
   *
   * Every answer on this tape was one unbroken block of speech, because TTS
   * produces one. Real people stop mid-thought — and that is precisely the
   * defect reported from the 2026-09-15 live interview: at the handover the
   * interviewee paused to think, the ~1500ms quiet rule read the pause as the
   * end of his turn, the handover fired, and the fifteen seconds he then spoke
   * went into a socket being torn down.
   *
   * A tape that never pauses cannot reproduce that, so every offline run
   * "passed" a scenario it was incapable of reaching. The unit tests in
   * handoverWaitsForAGap.test.ts cover the logic; this makes the harness
   * capable of showing the whole thing end to end.
   *
   * Inserted at the midpoint rather than at a random offset: reproducible runs
   * matter more than variety, and the midpoint is the worst case — it
   * guarantees there is still speech to lose afterwards.
   */
  if (OFFLINE_THINK_PAUSE_MS > 0 && pcm.length > FRAME * 4) {
    const silentFrames = Math.round((OFFLINE_THINK_PAUSE_MS / 1000) * IN_RATE / FRAME);
    const mid = Math.floor(pcm.length / 2 / FRAME) * FRAME;
    for (let i = 0; i < mid; i += FRAME) uplinkQueue.push(pcm.subarray(i, Math.min(i + FRAME, pcm.length)));
    for (let k = 0; k < silentFrames; k++) uplinkQueue.push(new Int16Array(FRAME));
    for (let i = mid; i < pcm.length; i += FRAME) uplinkQueue.push(pcm.subarray(i, Math.min(i + FRAME, pcm.length)));
    return;
  }
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
/*
 * v5.34.100 — WHEN THE LIVE SESSION ACTUALLY CAME UP.
 *
 * t0 is process start, and a live run spends ~50s synthesising the eight
 * scripted answers through the TTS model before it ever requests a grant. Two
 * numbers were being measured against t0 and were therefore wrong by that
 * whole prologue:
 *
 *   · "first audio: 65.0s" — the interviewer had in fact spoken 15.7s after the
 *     session opened. 65s reads as a catastrophic warmup failure; it was TTS.
 *   · the stall watchdog fired at 26s, while the answers were still being
 *     synthesised and no session existed at all — a "recovery" from a stall
 *     that could not happen, inflating stallRecoveries and cueing an answer
 *     into a socket that was not there.
 *
 * Both are the harness measuring itself. Anchor them here instead.
 */
let sessionUpAt = null;
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
/* v5.34.101: failure code -> how many times. Printed in the verdict so a run
 * that scores nothing says WHY without anyone scrolling back. */
const scoreErrorCodes = new Map();
/* v5.34.101: turns closed with audio still queued, and the worst offender.
 * The floor-hold invariant — see the verdict line that reads them. */
let idleWhileSpeaking = 0;
let worstIdleWhileSpeakingMs = 0;
let floorHolds = 0;
/* v5.34.106: turns closed more than once, and guarded late closes. */
let doubleClosedTurns = 0;
let lateClosesSuppressed = 0;
/* v5.34.107: every measured salvage -> turnComplete gap, so the window is
 * never set from reasoning again. */
const lateCloseGapsMs = [];
/* v5.34.110: the full text handed to the interviewer at each mint. */
const mintedInstructions = [];
/* v5.34.106: a floor held over audio a barge-in already discarded. */
let heldAfterFlush = 0;
/* v5.34.100: scoring requests this rig answered with a stub. Non-zero means the
 * scoring numbers below measure the stub, not the product. */
let scoreStubCalls = 0;
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
        noteActivity();
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
  onReplyWithoutAudio: () => {
    muteRepliesDetected++;
    say(`!! a reply arrived as text with no voice (detected ${muteRepliesDetected})`);
  },
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
    const code = String((e && (e.code || e.message)) || e);
    /*
     * v5.34.101 — tally the CODE, not just the count.
     *
     * The live run of 2026-09-14 reported "0 succeeded, 3 failed" and that is
     * all that survived into the hands of the person who had to decide what to
     * do next. The reason was in the scroll-back, three screens up. A verdict
     * that says a thing failed without saying why costs another paid run to
     * find out, so the codes now ride in the verdict itself.
     */
    scoreErrorCodes.set(code, (scoreErrorCodes.get(code) || 0) + 1);
    say(`!! scoring pass FAILED (${scoreErrors}): ${code}`);
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
/*
 * v5.34.112 — WHAT A STALL IS MEASURED FROM.
 *
 * The watchdog fired on `Date.now() - lastCueAt >= STALL_MS`, and lastCueAt is
 * set when an ANSWER IS CUED. So the 25-second window covered a whole healthy
 * cycle: a nine-second answer, the interviewer's reply, and a scoring pass. Any
 * cycle slower than 25s reported a stall even though every step of it worked.
 *
 * Measured on the 20-minute v5.34.111 soak: 7 stall recoveries reported, of
 * which 5 were this. Recovery 4 is the clearest —
 *
 *     692.4s answering (8.6s)
 *     702.1s reply 18: 1.2s after the answer ended     <- the model answered fine
 *     707.4s score pass #17
 *     717.4s !! nothing has happened for 25s           <- 25s after the CUE
 *
 * "Nothing has happened" while the trace directly above it shows three things
 * happening. That number would have sent us hunting a transport stall that did
 * not exist, and on a 30-minute run it would read as ~15 of them.
 *
 * A stall is silence from the MODEL, so it is timed from the last thing the
 * model did. The two genuine stalls on that run — both preceded by "the uplink
 * never drained" — are still caught, because in those the model really did go
 * quiet (186 seconds, once).
 */
let lastActivityAt = Date.now();
const noteActivity = () => { lastActivityAt = Date.now(); };
let stallRecoveries = 0;
async function nextAnswer() {
  /* v5.34.114: the RUN's deadline, not the process's — see RUN_DEADLINE_AT. */
  if (answering || ended || Date.now() > RUN_DEADLINE_AT) return;
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
    lastAnswerSpoken = text;   // v5.34.119: for the verbatim-echo check

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
        /*
         * v5.34.114 — THE ANSWER FINISHING IS ACTIVITY.
         *
         * Third and final correction to what a stall is measured from. The
         * window ran from `lastCueAt`, the moment the answer was CUED, so a
         * long answer plus a normal reply exceeded it and reported a stall on a
         * healthy exchange — three of them on the 20-minute soak:
         *
         *     156.9s answering (23.6s): "We have a global data warehouse..."
         *     182.2s !! nothing has happened for 25s
         *
         * The answer had finished 1.7 seconds earlier and the reply was on its
         * way. v5.34.112 moved the window onto model activity and fixed the
         * short-answer case; it did not fix this, because during a 23-second
         * answer nothing counts as activity at all.
         *
         * The honest question a stall watchdog asks is "the interviewee has
         * stopped speaking — has the model responded yet?", so the clock starts
         * when the interviewee stops. Deliberately NOT set on the drain-timeout
         * branch below: an uplink that never drained IS the fault, and the
         * watchdog should fire for it.
         */
        clearInterval(waitForDrain); askedAt = now(); answering = false;
        noteActivity();
        return;
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
/*
 * v5.34.112 — THE TWO UNBOUNDED PASSES.
 *
 * v5.34.78 bounded the renewal pass and said exactly why: "Suppressing the
 * watchdog for the duration of a handover is right; suppressing it FOREVER
 * because a handover never completed would restore exactly the failure this
 * watchdog exists to catch." Two of the four passes below were still forever.
 *
 *   uplinkQueue.length — suppressed while frames are waiting to go out. A
 *     queue that stops draining therefore blinds the watchdog for as long as
 *     it stays stuck. Measured on the v5.34.111 soak: the queue jammed at
 *     283.4s and the watchdog said nothing until 469.3s, then reported "186s".
 *     The one thing it exists to notice, and it was suppressed by it.
 *
 *   state speaking/thinking — suppressed while the model is mid-turn. A model
 *     that goes silent WITHOUT closing its turn leaves the page in 'speaking'
 *     with nothing to end it, so the watchdog never runs again. That is
 *     verbatim the 2026-09-13 failure quoted in the comment above: "the client
 *     never left 'speaking', no answer was ever cued again". The salvage in
 *     vyne-live.js fixes the cause; this pass quietly reopened the symptom for
 *     any silence the salvage cannot see, and --offline-silent-after proves it
 *     (before this change: 0 stall recoveries on a model that stopped dead).
 *
 * Both now get a ceiling, for the same reason the renewal pass did: a pass
 * granted while something is legitimately in progress, withdrawn once "in
 * progress" has lasted longer than the thing could possibly take.
 */
const STUCK_MS = Number(process.env.VYNE_HARNESS_STUCK_MS || 45000);
let uplinkBusySince = null;
let turnBusySince = null;
setInterval(() => {
  if (ended || answering) return;
  /* v5.34.100: nothing to stall on before the session exists. See sessionUpAt. */
  if (sessionUpAt === null) return;
  if (renewingSince !== null && Date.now() - renewingSince < RENEW_GRACE_MS) return;

  uplinkBusySince = uplinkQueue.length ? (uplinkBusySince ?? Date.now()) : null;
  if (uplinkBusySince !== null && Date.now() - uplinkBusySince < STUCK_MS) return;

  const midTurn = state === "speaking" || state === "thinking";
  turnBusySince = midTurn ? (turnBusySince ?? Date.now()) : null;
  if (turnBusySince !== null && Date.now() - turnBusySince < STUCK_MS) return;

  if (Date.now() - Math.max(lastCueAt, lastActivityAt) < STALL_MS) return;
  stallRecoveries++;
  say(`!! nothing has happened for ${Math.round((Date.now() - Math.max(lastCueAt, lastActivityAt)) / 1000)}s — cueing the next answer (recovery ${stallRecoveries})`);
  lastCueAt = Date.now();
  noteActivity();
  /* A stuck uplink is why we are here; clearing it is part of the recovery,
   * not a side effect. Leaving it would re-suppress the next cue at the guard
   * in nextAnswer(). */
  if (uplinkQueue.length) {
    say(`   (clearing ${uplinkQueue.length} frame(s) stuck on the uplink)`);
    uplinkQueue.length = 0;
  }
  uplinkBusySince = null;
  turnBusySince = null;
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
  /*
   * ── v5.34.103: keep the evidence ───────────────────────────────────────────
   *
   * Every run wrote voice-record.log and voice-record.txt, and every run
   * therefore destroyed the previous one's. On 2026-09-14 a live run reported
   * "first audio: 65.0s" — 20s past the threshold this harness itself warns
   * at — and by the time anyone came to diagnose it the trace had been
   * overwritten by the next run. The question could not be answered from the
   * evidence, only from another paid run.
   *
   * These runs cost real money and the trace is the only artefact that
   * survives them, so it is now also written under a per-run name. The plain
   * voice-record.log stays exactly where it is, because every runbook, every
   * handoff note and the verdict lines below all point at it.
   */
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const keepDir = join(ROOT, "voice-runs");
    mkdirSync(keepDir, { recursive: true });
    ARCHIVE_DIR = join(keepDir, `${OUT.split(/[\\/]/).pop()}-${stamp}`);
    mkdirSync(ARCHIVE_DIR, { recursive: true });
  } catch (e) { ARCHIVE_DIR = null; }
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
  /*
   * v5.34.112 — the first thing in the verdict, because it decides whether
   * anything after it is a measurement of the product at all.
   */
  if (suspensions.length) {
    const tot = suspendedSec();
    say(`!! THIS PROCESS WAS SUSPENDED for ${tot.toFixed(0)}s across ${suspensions.length} gap(s) — ` +
        `${((tot / Math.max(1, now())) * 100).toFixed(0)}% of the run.`);
    suspensions.slice(0, 6).forEach((g) =>
      say(`   frozen ${g.frozenSec.toFixed(0)}s starting at ${g.at.toFixed(1)}s`));
    if (suspensions.length > 6) say(`   (and ${suspensions.length - 6} more)`);
    say(`   On a laptop this is the machine sleeping. While suspended, timers do not fire,`);
    say(`   the uplink does not drain and the socket dies — which reads in the trace as`);
    say(`   "the uplink never drained" and a long silence, i.e. EXACTLY like a network`);
    say(`   fault. The latencies, stall recoveries and dead-air gaps below are therefore`);
    say(`   NOT measurements of the model. Re-run with the machine kept awake:`);
    say(`     caffeinate -i bash deploy/run-voice-record.sh ${MINUTES} soak`);
  } else {
    say(`process suspensions: none — the event loop ran continuously, so the numbers below are the product's`);
  }
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
  /*
   * ── v5.34.117: how long the stalled handover left the interviewee waiting ──
   *
   * Measured off the CLIENT's own trace, not the stub's intentions. The rig has
   * misreported four times in this project, every time by trusting a clock it
   * owned rather than one the product wrote, so this reads the two lines
   * vyne-live.js and vyne-live-interview.js print and subtracts them.
   *
   * The number that matters is transcript → first audio of the new session:
   * that is the hole the person sits in. 25s on the reported run.
   */
  if (OFFLINE_STALL_AFTER_GOAWAY > 0) {
    /* The prefix is column-padded — `[VL + 42427ms]`. The first cut of this
     * regex required the digits to touch the plus, so every timestamp parsed
     * as null and the verdict printed "noticed after ?s". Fifth time this
     * project's instrument has misreported; it stays cheap to check. */
    const ms = (l) => { const m = /\[VL \+\s*(\d+)ms\]/.exec(l); return m ? Number(m[1]) : null; };
    const find = (from, re) => { for (let i = from; i < trace.length; i++) if (re.test(trace[i])) return i; return -1; };
    const iStall = find(0, /handing over because this connection has stopped answering/);
    if (stallsInjected === 0) {
      say(`stalled handover: NOT EXERCISED — the run ended before a goAway, so this proves nothing.`);
      say(`   Run longer than the goAway interval (${(OFFLINE_GOAWAY_MS / 1000).toFixed(0)}s), or lower it with --offline-goaway.`);
    } else if (iStall < 0) {
      say(`!! stalled handover: the stall was injected ${stallsInjected}x and the client NEVER noticed it.`);
      say(`   This is the v5.34.116 defect, unfixed: the handover is waiting for a turn`);
      say(`   boundary on a connection that has stopped producing turns.`);
    } else {
      /* The transcribed turn the stall was injected on: the last USER TURN
       * line at or before the escape. */
      let iTurn = -1;
      for (let i = iStall; i >= 0; i--) if (/USER TURN #/.test(trace[i])) { iTurn = i; break; }
      const iAudio = find(iStall, /FIRST AUDIO FRAME — the agent is speaking/);
      const t0 = iTurn >= 0 ? ms(trace[iTurn]) : null;
      const tEsc = ms(trace[iStall]);
      const tAud = iAudio >= 0 ? ms(trace[iAudio]) : null;
      const noticedMs = t0 != null && tEsc != null ? tEsc - t0 : null;
      const silenceMs = t0 != null && tAud != null ? tAud - t0 : null;
      say(`stalled handover: noticed after ${noticedMs == null ? "?" : (noticedMs / 1000).toFixed(1)}s, ` +
          `interviewee heard nothing for ${silenceMs == null ? "?" : (silenceMs / 1000).toFixed(1)}s ` +
          `(injected stall ${(OFFLINE_STALL_AFTER_GOAWAY / 1000).toFixed(0)}s, reported defect 25.0s)`);
      if (silenceMs != null && silenceMs > 12000) {
        say(`!! that is longer than the 12s at which the product itself calls the line dead.`);
      }
      /*
       * The nudge decides what the interviewee HEARS on the far side, and the
       * two wrong ones are worse than the silence: "I'm still here" is what
       * they got on the reported run, and "could you say it again" asks them
       * to repeat an answer we hold in full.
       */
      const nudge = trace.slice(iStall).find((l) => /sendText -> WIRE/.test(l)) || "";
      const wrong = /still there/i.test(nudge) ? "'still there'"
                  : /say it again|repeat/i.test(nudge) ? "'say it again'" : null;
      if (wrong) say(`!! the recovery nudge was the ${wrong} one — it should be answering the turn it already has.`);
    }
  }
  say(`replies:         ${turns.length}`);
  /*
   * v5.34.119 — the parroting rate. Reported on every run, above the scoring
   * lines, because it is about whether the interview was BEARABLE rather than
   * whether it produced data, and the reported complaint was the former.
   */
  if (agentTurnsSeen) {
    const pct = (n) => `${Math.round((n / agentTurnsSeen) * 100)}%`;
    const handed = recapOpeners + recapRestates;
    say(`handing the answer back: ${handed}/${agentTurnsSeen} turns (${pct(handed)}) — ` +
        `${recapOpeners} "<ack>, so ..." openers, ${recapRestates} restated it without one, ` +
        `${verbatimEchoes} repeated ${VERBATIM_RUN_WORDS}+ of their words verbatim`);
    if (verbatimEchoes) {
      say(`!! a verbatim echo is the 2026-09-17 handover defect. The interviewer read their answer out loud.`);
      echoExamples.forEach((e) => say(`   "${e}…"`));
    }
    if (handed * 2 >= agentTurnsSeen) {
      say(`!! more than half the turns opened by restating the answer — this is what reads as parroting.`);
      recapExamples.forEach((e) => say(`   "${e}…"`));
      restateExamples.forEach((e) => say(`   "${e}…"`));
    }
    /*
     * Named exactly as PERSONA_SOURCE names it. A near-miss here would print
     * nothing and let a stub run be read as a measurement of the shipped
     * rules, which is this harness's signature failure.
     */
    if (PERSONA_SOURCE.indexOf("HARNESS STUB") >= 0) {
      say(`   (harness stub persona — this rate says NOTHING about the shipped rules)`);
    }
    if (OFFLINE) {
      say(`   (offline: the stub speaks one canned line, so only a paid run measures this)`);
    }
  }
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
  /*
   * v5.34.100 — say WHICH of three things happened, because "0 succeeded" read
   * as a product failure when it was the rig having no API to call.
   */
  if (scoreStubCalls) {
    say(`scoring:         NOT EXERCISED — ${scoreStubCalls} request(s) answered by the rig's stub.`);
    say(`                 This harness carries no API origin or session, so it cannot score. Use`);
    say(`                 the browser for scoring; these runs measure voice transport only.`);
  } else {
    say(`scoring passes:  ${scoreCalls} succeeded, ${scoreErrors} failed` +
        `${scoreCalls === 0 ? "  !! NOTHING WAS SCORED — this run produced no assessment" : ""}`);
    if (scoreErrorCodes.size) {
      const codes = [...scoreErrorCodes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `${c} x${n}`).join(", ");
      say(`scoring failed with: ${codes}`);
      /*
       * These three are the ones a consultant can act on without reading code,
       * and they need different responses: a cap is a billing decision, a
       * provider fault is a wait, and an unparseable response is ours.
       */
      if ([...scoreErrorCodes.keys()].some((c) => /cap|quota|429/i.test(c))) {
        say(`                 a cap or quota — this is a billing limit, not a code fault.`);
      }
      if ([...scoreErrorCodes.keys()].some((c) => /unparseable|score_apply_failed/i.test(c))) {
        say(`                 the model answered and WE could not use it — that one is ours.`);
      }
      if ([...scoreErrorCodes.keys()].some((c) => /^http_5/.test(c))) {
        say(`                 5xx from the gateway — provider or backend, check the API logs.`);
      }
    }
    say(`dimensions scored: ${scoredDims.size} of 7` +
        `${scoredDims.size ? ` (${[...scoredDims].sort().join(", ")})` : ""}`);
  }
  /*
   * v5.34.101 — the invariant this release exists to enforce.
   */
  auditFloorHolds(trace);
  auditDoubleCloses(trace);
  if (idleWhileSpeaking) {
    say(`!! FLOOR RELEASED EARLY on ${idleWhileSpeaking} turn(s) — worst had ${(worstIdleWhileSpeakingMs / 1000).toFixed(1)}s`);
    say(`                 of the interviewer's voice still queued. The mic reopens and the`);
    say(`                 interviewee is invited to talk over a question still being asked.`);
    say(`                 This is the v5.34.101 defect; it is back. Do not ship.`);
  } else if (floorHolds) {
    say(`floor holds:     ${floorHolds} turn(s) correctly held until the audio drained`);
  } else {
    say(`floor holds:     none needed — no turn closed with audio still queued`);
  }
  if (doubleClosedTurns) {
    say(`!! TURN CLOSED TWICE on ${doubleClosedTurns} turn(s) — usage is double-banked, the`);
    say(`                 interviewer's words go into the transcript twice, and a second paid`);
    say(`                 scoring call is spent on the same conversation. See v5.34.106.`);
  } else if (lateClosesSuppressed) {
    say(`late closes:     ${lateClosesSuppressed} late turnComplete(s) correctly ignored after a salvage`);
    if (lateCloseGapsMs.length) {
      const sorted = [...lateCloseGapsMs].sort((a, b) => a - b);
      say(`                 gaps ${(sorted[0] / 1000).toFixed(1)}s..${(sorted[sorted.length - 1] / 1000).toFixed(1)}s` +
          ` (LATE_TURN_COMPLETE_WINDOW_MS must stay clear of the top of this range)`);
    }
  } else if (OFFLINE_LATE_TURN_COMPLETE > 0) {
    say(`!! --offline-late-turn-complete was set but no late close was ever suppressed —`);
    say(`                 the salvage never fired, so this run tested nothing. The delay must`);
    say(`                 exceed TURN_CLOSE_GRACE_MS (1200ms).`);
  }
  /*
   * v5.34.106 — a mode that produced nothing tested nothing, and must say so
   * rather than let a clean verdict be read as a pass.
   */
  if (OFFLINE_MUTE_REPLIES > 0) {
    if (!muteRepliesSent) {
      say(`!! --offline-mute-replies produced no mute replies — the run was too short to`);
      say(`                 reach reply ${OFFLINE_MUTE_REPLIES}. Nothing was tested.`);
    } else if (!muteRepliesDetected) {
      /*
       * Measured on the first run of this mode, 2026-09-14: 4 sent, 0
       * detected, and no "MUTE TURN" line in the trace at all.
       *
       * The reason is structural, not a flag. v5.34.40 arms a MUTE_REPLY_MS
       * (6000ms) timer on the first text of a silent turn. v5.34.75 then added
       * the salvage, which closes a turn ~1200ms after generationComplete —
       * and _closeTurn clears that timer. So on a production-shaped mute turn
       * the detection can no longer fire: a feature made unreachable by a
       * later change, which is the same shape as the v5.34.105 defect.
       *
       * Reported, not asserted as a failure: onReplyWithoutAudio also needs
       * vyneLiveFlags({speakMuteReplies:true}), which is off by default, so
       * today the only loss is a diagnostic. Turn it on and the recovery is
       * gone too.
       */
      say(`mute replies:    ${muteRepliesSent} sent, 0 detected.`);
      say(`                 MUTE_REPLY_MS is 6000ms and the salvage closes a silent turn in`);
      say(`                 ~1200ms, clearing the timer — so v5.34.40's detection cannot fire`);
      say(`                 on a production-shaped mute turn. Harmless while`);
      say(`                 vyneLiveFlags({speakMuteReplies:true}) is off; it is the recovery`);
      say(`                 that is lost when it is on.`);
    } else {
      say(`mute replies:    ${muteRepliesSent} sent, ${muteRepliesDetected} detected and handed to the page`);
    }
  }
  if (OFFLINE_BARGE_IN > 0) {
    if (!bargeInsSent) {
      say(`!! --offline-barge-in produced no interruptions — nothing was tested.`);
    } else {
      /*
       * The choke count is NOT a fault here: this rig injects the interrupt on
       * a timer, so some land while its scripted interviewee happens to be
       * silent. In a live run that number means echo cancellation is not
       * holding; in this mode it means the timer fired between answers.
       */
      say(`barge-ins:       ${bargeInsSent} sent (injected on a timer, so the choke count below`);
      say(`                 is not evidence of echo in this mode)`);
      if (heldAfterFlush) {
        say(`!! FLOOR HELD AFTER A BARGE-IN on ${heldAfterFlush} turn(s) — the audio was discarded`);
        say(`                 and the interviewee was made to wait for it anyway. flush() must`);
        say(`                 zero _lastEnd; see v5.34.101.`);
      } else {
        say(`                 floor released immediately on every flush, as it must be`);
      }
    }
  }
  if (scoringDead) {
    say(`scoring declared DEAD: the stop path fired — check the transcript for the apology before the stop`);
    if (scoreStubCalls) {
      say(`                 !! and it fired against the STUB, which should not happen — the stub`);
      say(`                    answers 200, so this is a real defect in the scoring-health logic.`);
    }
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
  say(`stall recoveries:${stallRecoveries === 0 ? " 0 (the conversation never stalled)" : ` ${stallRecoveries} !! the uplink went quiet and the watchdog restarted it` + (suspensions.length ? ` (but this process was suspended for ${suspendedSec().toFixed(0)}s — attribute these to that first)` : "")}`);
  say(`salvaged turns:  ${(LI.session && LI.session._salvagedTurns) || 0}${(LI.session && LI.session._salvagedTurns) ? " !! generationComplete with no turnComplete — see TURN_CLOSE_GRACE_MS" : ""}`);
  if (OFFLINE_FAIL_MINTS) say(faultVerdict());
  if (lat.length) {
    say(`first reply:     ${lat[0].toFixed(1)}s`);
    say(`latency mean:    first half ${mean(lat.slice(0, half)).toFixed(1)}s → second half ${mean(lat.slice(half)).toFixed(1)}s`);
    say(`latency worst:   ${Math.max(...lat).toFixed(1)}s`);
  }
  say(`first audio:     ${firstAudioAt === null
        ? "NEVER — the interviewer never spoke"
        : (sessionUpAt === null
            ? firstAudioAt.toFixed(1) + "s"
            : `${(firstAudioAt - sessionUpAt).toFixed(1)}s after the session opened ` +
              `(${firstAudioAt.toFixed(1)}s from start; the first ${sessionUpAt.toFixed(1)}s is TTS prep)`)}`);
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
        (LOOP
          ? `It was a --loop soak, so the tape was not the limit: the INTERVIEWER closed. ` +
            `Reaching the handover needs an interview that does not wrap up first.)`
          : `Use --loop for a soak if that path is what you want to exercise.)`));
  }
  /*
   * v5.34.110 — outside the persona guard, so a run that used the harness stub
   * still reports what it sent. A capture that only reports on the expensive
   * runs is a capture nobody can check for free.
   */
  say(`instruction at last mint: ${currentInstruction().length} chars (was ${SYSTEM_INSTRUCTION.length} at open)`);
  /*
   * v5.34.111 — did the interview reach the size it was booked for?
   *
   * The v5.34.110 soak closed at 22 questions against a 40-50 question Deep
   * Dive and nothing in the verdict said so, because nothing in the verdict
   * knew what the booking was: the harness never sent one and neither did the
   * product. Both do now, so the run can be judged against it rather than
   * against an impression of how long it felt.
   *
   * Reported whether or not the interviewer closed, because a run that closes
   * AT the target and a run that closes at half of it look identical in every
   * other line of this verdict.
   */
  {
    const lo = liveFixture && liveFixture.questionTargetLow;
    const hi = liveFixture && liveFixture.questionTargetHigh;
    const asked = askedQuestions.length;
    if (lo && hi) {
      const pct = Math.round((asked / lo) * 100);
      say(`booked size: ${lo} to ${hi} questions — asked ${asked} (${pct}% of the lower bound)`);
      if (asked < lo) {
        say(`!! SHORT OF THE BOOKING by ${lo - asked} question(s). If the interviewer closed here,`);
        say(`   it closed below the length the client was sold. Check whether the last`);
        say(`   instruction actually carried the size and the outstanding ground:`);
        say(`     grep -n 'booked as' ${OUT}.instruction-*.txt`);
        say(`     grep -n 'Ground you do not have yet\\|there is more to get' ${OUT}.instruction-*.txt`);
      }
    } else {
      say(`!! the harness sent NO booked size — this run cannot exercise the v5.34.111 close rules.`);
    }
    const lastMint = mintedInstructions.length ? mintedInstructions[mintedInstructions.length - 1] : "";
    if (lastMint) {
      say(`size in the last instruction: ${/booked as \d+ to \d+ questions/.test(lastMint) ? "YES" : "NO — the size did not survive to the last mint"}`);
      say(`outstanding ground in the last instruction: ${/Ground you do not have yet|there is more to get|booked for/.test(lastMint) ? "YES" : "NO — the agenda ended with nothing owed"}`);
      say(`elapsed clock in the last instruction: ${/minutes? into this interview|start of this interview/.test(lastMint) ? "YES" : "NO"}`);
    }
  }
  if (mintedInstructions.length) {
  const last = mintedInstructions[mintedInstructions.length - 1];
  const REQUIRED_HEADING = "must be asked before the interview ends";
  const told = last.includes(REQUIRED_HEADING);
    say(`instruction written to: ${OUT}.instruction-NN.txt  (${mintedInstructions.length} mint(s), verbatim)`);
    if (!told) {
    say(`!! the LAST instruction carried NO required-question list. If the interviewer`);
    say(`   closed with required questions outstanding, it closed on what it was told —`);
    say(`   the fault is in assembling the context, not in the interviewer.`);
      } else {
    say(`required questions WERE in the last instruction — if it still closed with them`);
    say(`   outstanding, that is the interviewer overriding a direct instruction.`);
    }
  const askedBlock = /Questions you have ALREADY asked[\s\S]*?(?:\n\n|$)/.exec(last);
    if (askedBlock) {
    const n = (askedBlock[0].match(/^\d+\. /gm) || []).length;
    say(`already-asked context: ${n} question(s), ${askedBlock[0].length} chars of the instruction`);
    }
  }

  say("Listen to the WAV. The things to judge by ear: does the voice stop and start mid-sentence,");
  say("is there a long hole after each handover, and does it still answer after minute ten.");
  /*
   * Last, so the archived .txt contains the whole verdict including the lines
   * above. The WAV is deliberately NOT copied — it is tens of megabytes per
   * run and the diagnosis always happens in the trace; the WAV stays at its
   * usual path for listening to, and is the one artefact the next run still
   * overwrites.
   */
  if (ARCHIVE_DIR) {
    try {
      copyFileSync(OUT_LOG, join(ARCHIVE_DIR, "trace.log"));
      copyFileSync(OUT_TXT, join(ARCHIVE_DIR, "verdict.txt"));
      say(`kept for later:  ${ARCHIVE_DIR}/  (trace.log, verdict.txt — the next run will not overwrite these)`);
    } catch (e) {
      say(`!! could not archive this run's trace (${e && e.message}) — copy ${OUT_LOG} by hand before the next run`);
    }
  }
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
  sessionUpAt = now();
  /*
   * v5.34.114: the stall window starts when the INTERVIEW does.
   *
   * Synthesising the 22 answers took 480 seconds on the 2026-09-15 run, and
   * the watchdog's very first act once the session opened was to report
   * "nothing has happened for 480s" — it had been timing the text-to-speech.
   * One of the 18 stall recoveries on that verdict was this.
   */
  lastCueAt = Date.now();
  noteActivity();
  say("live session up — waiting for the interviewer to speak");
  setTimeout(() => {
    if (firstAudioAt === null) say("!! 45s and still no audio — see the trace; this is the warmup-window failure if the nudge was dropped");
  }, 45000);
}).catch((e) => {
  say(`!! could not start: ${e && (e.code || e.message)}`);
  finish("start failed");
});

/*
 * ── ONE clock for the run. (v5.34.114) ──────────────────────────────────────
 *
 * This line executes AFTER the interviewee's answers have been synthesised, so
 * the run gets its full MINUTES of interview. `nextAnswer()` measured its own
 * budget as `Date.now() - t0`, and t0 is set when the PROCESS starts — before
 * that synthesis. Two clocks for one deadline, differing by however long the
 * TTS took.
 *
 * Measured on the 22-minute live run of 2026-09-15, the first with the new
 * 22-answer tape, so every answer had to be generated:
 *
 *     479.9s  session opens (8 minutes of TTS before it)
 *    1314.3s  reply 27 — the LAST reply
 *    1320.0s  t0 + 22 minutes: nextAnswer() starts returning immediately
 *    1573.6s  handover #2, into a conversation that had nothing to say
 *    1804.4s  finish, at the real 22-minute mark
 *
 * The interviewee went mute 14 minutes into a 22-minute interview and the run
 * carried on for another eight. The product noticed and said so, 21 times over
 * — "mic uplink SILENT for 15s while unmuted — frames flow but carry no audio;
 * the model cannot hear" — and it read in the verdict as 18 stall recoveries
 * and a dead interview. None of it was the product.
 *
 * So the deadline is a value, set once, read by both.
 */
RUN_DEADLINE_AT = Date.now() + MINUTES * 60000;
setTimeout(() => finish(`reached the ${MINUTES}-minute limit`), MINUTES * 60000 + 5000);
