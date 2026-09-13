#!/usr/bin/env node
/**
 * elevenlabs-record.mjs — EXPERIMENT 2.
 *
 * One question, asked honestly: **does a 120-minute voice conversation survive
 * on ElevenLabs Agents?**
 *
 * Nothing else. This script is not an integration, not a migration, and not a
 * comparison of voice quality. It holds one long call and reports where — if
 * anywhere — it breaks. That is the fact the VYNE architecture decision turns
 * on, and it is the fact nobody has.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Gemini Live caps audio-only sessions at ~15 minutes and kills the connection
 * every ~10 (goAway), so a 90-120 minute deep dive means a dozen handovers,
 * each one a chance to lose the interview. 5.34.42 made those handovers
 * recover instead of fatal, but the ceiling is still Google's.
 *
 * ElevenLabs publishes NO maximum call duration. That is not the same as "no
 * limit" — it is an untested assumption, and untested assumptions are what
 * cost this project three months. So: test it. Before writing one line of
 * integration code.
 *
 * ── What it measures ────────────────────────────────────────────────────────
 *
 *   - whether the socket survives N minutes, and if not, WHEN and WITH WHAT
 *   - reply latency per turn, and whether it degrades over the hours
 *   - every disconnect, interruption and silent stretch
 *   - the audio itself, as a stereo WAV you can listen to:
 *         LEFT  = the agent          RIGHT = the interviewee
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   node deploy/elevenlabs-record.mjs --offline            rig check, no key
 *   node deploy/elevenlabs-record.mjs --agent <id> --minutes 120
 *
 * The key is read from ELEVENLABS_API_KEY, which run-elevenlabs-test.sh loads
 * from ~/vyne/elevenlabs-key.txt. Never paste a key into a chat window.
 *
 * ── What it does NOT prove ──────────────────────────────────────────────────
 *
 * Nothing about VYNE's interview quality, scoring, or persona — the agent here
 * is configured in the ElevenLabs dashboard, not from interviewerPersona.ts.
 * And a clean 120 minutes here is evidence about ElevenLabs, not a promise
 * about the integrated product.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/* ── args ─────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const OFFLINE = has("offline");
const MINUTES = Number(arg("minutes", OFFLINE ? 1.3 : 120));
const AGENT_ID = arg("agent", "");
const VOICE_ID = arg("answer-voice", "JBFqnCBsd6RMkjVDRZzb");   // the INTERVIEWEE's voice
const OUT = arg("out", OFFLINE ? "elevenlabs-selfcheck" : "elevenlabs-record");
const KEY = process.env.ELEVENLABS_API_KEY || "";
const API = "https://api.elevenlabs.io";

const at = (ext) => (isAbsolute(OUT) ? `${OUT}.${ext}` : join(ROOT, `${OUT}.${ext}`));
const OUT_WAV = at("wav");
const OUT_TXT = at("txt");
const CACHE = join(ROOT, "elevenlabs-answers");

const RATE = 16000;            // convai default both directions: pcm_16000
const FRAME = 4000;            // 250 ms of uplink per message

if (!OFFLINE) {
  if (!KEY) {
    console.error("!! ELEVENLABS_API_KEY is not set.\n" +
      "   Put the key in ~/vyne/elevenlabs-key.txt and use deploy/run-elevenlabs-test.sh,\n" +
      "   which loads it for you. Do not paste the key into a chat window.\n" +
      "   (Or run with --offline to check the harness itself, which needs no key.)");
    process.exit(2);
  }
  if (!AGENT_ID) {
    console.error("!! --agent <agent_id> is required. Create the agent in the ElevenLabs\n" +
      "   dashboard first; the id is in its URL and on its settings page.");
    process.exit(2);
  }
}
if (typeof globalThis.WebSocket !== "function" && !OFFLINE) {
  console.error(`!! this Node (${process.version}) has no global WebSocket. Node 22+ is required.`);
  process.exit(2);
}

const t0 = Date.now();
const stamp = () => {
  const s = (Date.now() - t0) / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(3)}m${String(Math.floor(s % 60)).padStart(2, "0")}s `;
};
function say(s) {
  const line = stamp() + s;
  console.log(line);
  try { appendFileSync(OUT_TXT, line + "\n"); } catch {}
}
try { writeFileSync(OUT_TXT, `elevenlabs-record ${new Date().toISOString()} agent=${AGENT_ID || "(offline)"} minutes=${MINUTES}\n`); } catch {}

/* ── the interviewee's side ───────────────────────────────────────────────── */

const ANSWERS = [
  "We are a mid-sized manufacturer, about twelve hundred people, and I run technology and data for the group.",
  "We centralised data and analytics roughly two years ago, so most reporting now runs through that one team.",
  "The biggest constraint is not the tooling. It is that the business side cannot specify what it wants precisely enough to build against.",
  "We have a warehouse on Snowflake, a handful of Power BI workspaces, and far too many spreadsheets nobody will admit to owning.",
  "Skills worry me most. We can hire data engineers. Getting operations managers to trust a model they did not build is harder.",
  "There is no formal governance body yet. Decisions get made in a weekly architecture call and written down afterwards, when someone remembers.",
  "If I am honest, our last two analytics projects went over on time and neither one changed a decision anybody was making.",
  "The appetite is there at the executive level, but the middle layer has seen enough failed pilots to be sceptical.",
];

const keyOf = (t) => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(36); };

function buzz(seconds) {
  const n = Math.round(seconds * RATE), pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 3000, (n - i) / 3000);
    pcm[i] = Math.round(Math.sin(i / 9) * Math.sin(i / 700) * env * 8000);
  }
  return pcm;
}

/** The interviewee's voice, from ElevenLabs TTS — one vendor, one key. */
async function speak(text) {
  if (OFFLINE) return buzz(text.length / 14);
  const cached = join(CACHE, `${keyOf(text)}.pcm`);
  if (existsSync(cached)) {
    const b = readFileSync(cached);
    return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
  }
  const r = await fetch(`${API}/v1/text-to-speech/${VOICE_ID}?output_format=pcm_16000`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const raw = Buffer.from(await r.arrayBuffer());
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  try { mkdirSync(CACHE, { recursive: true }); writeFileSync(cached, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)); } catch {}
  return pcm;
}

/* ── the recording: one stereo timeline, addressed by wall clock ──────────── */

const CAP = Math.ceil((MINUTES + 5) * 60 * RATE);
const track = { L: new Float32Array(CAP), R: new Float32Array(CAP) };
let writtenTo = 0;
const now = () => (Date.now() - t0) / 1000;

function writeAt(ch, seconds, pcm) {
  const start = Math.max(0, Math.round(seconds * RATE));
  const buf = track[ch];
  const n = Math.min(pcm.length, buf.length - start);
  for (let i = 0; i < n; i++) {
    const v = buf[start + i] + pcm[i] / 32768;
    buf[start + i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  if (start + n > writtenTo) writtenTo = start + n;
}

function writeWav(path) {
  const n = writtenTo;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(track.L[i] * 32767))), i * 4);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(track.R[i] * 32767))), i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
  return n / RATE;
}

/* ── offline: a local stand-in for the ElevenLabs socket ──────────────────── */

/**
 * Speaks a buzz per turn, pings on a timer so the pong path is exercised, and
 * NEVER disconnects — so if the real run reports a disconnect, we know the rig
 * did not invent it. Its job is to prove the plumbing, nothing else.
 */
function FakeSocket() {
  const ws = this;
  ws.readyState = 0;
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  let quiet = 0, spoke = false, closed = false, pingId = 0;
  const frame = (o) => !closed && ws.onmessage && ws.onmessage({ data: JSON.stringify(o) });
  ws.send = (d) => {
    let o; try { o = JSON.parse(d); } catch { return; }
    if (typeof o.user_audio_chunk === "string") {
      const b = Buffer.from(o.user_audio_chunk, "base64");
      const pcm = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
      let peak = 0; for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
      if (peak > 2000) { quiet = 0; spoke = true; }
      else if (spoke && ++quiet > 4) { spoke = false; quiet = 0; setTimeout(reply, 500); }
    }
  };
  ws.close = () => { if (!closed) { closed = true; ws.readyState = 3; ws.onclose && ws.onclose({ code: 1000, reason: "client" }); } };
  function reply() {
    frame({ type: "user_transcript", user_transcript_event: { user_transcript: "(offline stand-in heard you)" } });
    frame({ type: "agent_response", agent_response_event: { agent_response: "Offline stand-in reply." } });
    const pcm = buzz(2.2);
    for (let o = 0; o < pcm.length; o += RATE / 4) {
      const part = pcm.subarray(o, Math.min(o + RATE / 4, pcm.length));
      setTimeout(() => frame({ type: "audio", audio_event: {
        audio_base_64: Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString("base64"),
        event_id: ++pingId } }), (o / RATE) * 1000);
    }
    setTimeout(() => frame({ type: "agent_response_complete" }), 2400);
  }
  setTimeout(() => {
    ws.readyState = 1; ws.onopen && ws.onopen();
    setTimeout(() => frame({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: {
      conversation_id: "offline", agent_output_audio_format: "pcm_16000", user_input_audio_format: "pcm_16000" } }), 20);
    setInterval(() => frame({ type: "ping", ping_event: { event_id: ++pingId, ping_ms: 0 } }), 8000);
  }, 20);
}

/* ── connect ──────────────────────────────────────────────────────────────── */

async function signedUrl() {
  const r = await fetch(`${API}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(AGENT_ID)}`,
    { headers: { "xi-api-key": KEY } });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 300);
    if (r.status === 401) throw new Error(`401 — the API key was rejected. Check ~/vyne/elevenlabs-key.txt.`);
    if (r.status === 404) throw new Error(`404 — no agent with id ${AGENT_ID}. Copy it from the agent's page in the dashboard.`);
    throw new Error(`get-signed-url ${r.status}: ${body}`);
  }
  const j = await r.json();
  return j.signed_url || j.signedUrl;
}

/* ── run state ────────────────────────────────────────────────────────────── */

const turns = [];
let answerIndex = 0, askedAt = null, answering = false;
let firstAudioAt = null, speaking = false;
let pings = 0, interruptions = 0, disconnects = 0;
let uplink = [];
let ws = null, done = false;
let lastAgentAudioAt = 0;

function enqueue(pcm) { for (let i = 0; i < pcm.length; i += FRAME) uplink.push(pcm.subarray(i, Math.min(i + FRAME, pcm.length))); }

/*
 * The uplink never stops. A harness that goes mute while waiting inflates
 * latency by an order of magnitude, because the server's turn detection never
 * sees the silence that closes a turn. Learned the hard way on Gemini
 * (v5.34.38); it costs nothing to carry the lesson across.
 */
const silence = new Int16Array(FRAME);
setInterval(() => {
  if (!ws || ws.readyState !== 1 || done) return;
  const chunk = uplink.length ? uplink.shift() : silence;
  if (chunk !== silence) writeAt("R", now(), chunk);
  try { ws.send(JSON.stringify({ user_audio_chunk: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64") })); }
  catch (e) { say(`uplink send threw: ${e.message}`); }
}, (FRAME / RATE) * 1000);

async function nextAnswer() {
  if (answering || done || Date.now() - t0 > MINUTES * 60000) return;
  if (uplink.length) return;
  answering = true;
  try {
    const text = ANSWERS[answerIndex % ANSWERS.length];
    answerIndex++;
    const pcm = await speak(text);
    say(`answering (${(pcm.length / RATE).toFixed(1)}s): "${text.slice(0, 56)}…"`);
    enqueue(pcm);
    const drain = setInterval(() => {
      if (!uplink.length) { clearInterval(drain); askedAt = now(); answering = false; }
    }, 120);
  } catch (e) {
    say(`!! could not produce an answer: ${e.message}`);
    answering = false;
  }
}

function onMessage(raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  switch (m.type) {
    case "conversation_initiation_metadata": {
      const d = m.conversation_initiation_metadata_event || {};
      say(`connected — conversation ${d.conversation_id}, in ${d.user_input_audio_format}, out ${d.agent_output_audio_format}`);
      if (d.agent_output_audio_format && d.agent_output_audio_format !== "pcm_16000") {
        say(`!! the agent outputs ${d.agent_output_audio_format}, not pcm_16000 — the recording will be wrong.`);
        say(`   Set the agent's output format to PCM 16000 in the dashboard and run again.`);
      }
      setTimeout(nextAnswer, 1500);
      break;
    }
    case "ping":
      pings++;
      try { ws.send(JSON.stringify({ type: "pong", event_id: (m.ping_event || {}).event_id })); } catch {}
      break;
    case "audio": {
      const b64 = (m.audio_event || {}).audio_base_64;
      if (!b64) break;
      const raw2 = Buffer.from(b64, "base64");
      const pcm = new Int16Array(raw2.buffer, raw2.byteOffset, Math.floor(raw2.length / 2));
      // Lay the agent down where it actually plays: appended to its own run,
      // so a gap in its speech is a gap in the file.
      const at2 = Math.max(now(), lastAgentAudioAt);
      writeAt("L", at2, pcm);
      lastAgentAudioAt = at2 + pcm.length / RATE;
      if (firstAudioAt === null) { firstAudioAt = now(); say(`first agent audio at ${firstAudioAt.toFixed(1)}s`); }
      if (!speaking) {
        speaking = true;
        if (askedAt !== null) {
          const lat = now() - askedAt;
          turns.push({ n: turns.length + 1, latency: lat, at: now() });
          say(`reply ${turns.length}: ${lat.toFixed(1)}s`);
          askedAt = null;
        }
      }
      break;
    }
    case "agent_response_complete":
      speaking = false;
      setTimeout(nextAnswer, 900);
      break;
    case "interruption":
      interruptions++;
      speaking = false;
      break;
    case "user_transcript":
    case "agent_response":
    case "vad_score":
      break;
    default:
      break;
  }
}

async function connect() {
  if (OFFLINE) { ws = new FakeSocket(); }
  else {
    const url = await signedUrl();
    ws = new WebSocket(url);
  }
  ws.onopen = () => {
    say("socket open — sending conversation_initiation_client_data");
    try { ws.send(JSON.stringify({ type: "conversation_initiation_client_data" })); } catch (e) { say(`init send threw: ${e.message}`); }
  };
  ws.onmessage = async (ev) => {
    const d = ev.data;
    onMessage(typeof d === "string" ? d : (d && typeof d.text === "function" ? await d.text() : String(d)));
  };
  ws.onerror = (e) => say(`socket error: ${(e && (e.message || e.type)) || "unknown"}`);
  ws.onclose = (ev) => {
    if (done) return;
    disconnects++;
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    say(`!! SOCKET CLOSED at ${mins} min — code ${ev && ev.code}, reason "${(ev && ev.reason) || ""}"`);
    say(`   THIS IS THE ANSWER THE EXPERIMENT EXISTS FOR: the call did not survive ${MINUTES} minutes unaided.`);
    finish(`socket closed after ${mins} min (code ${ev && ev.code})`);
  };
}

/* ── finish ───────────────────────────────────────────────────────────────── */

function finish(why) {
  if (done) return;
  done = true;
  try { ws && ws.close(); } catch {}
  const secs = writeWav(OUT_WAV);
  const lat = turns.map((t) => t.latency);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const half = Math.ceil(lat.length / 2);
  say("");
  say("──────────────────────────────── verdict ────────────────────────────────");
  say(`stopped because: ${why}`);
  say(`recording:   ${OUT_WAV}  (${(secs / 60).toFixed(1)} min, L=agent R=interviewee)`);
  say(`turns:       ${turns.length}    disconnects: ${disconnects}    interruptions: ${interruptions}    pings answered: ${pings}`);
  if (lat.length) {
    say(`first reply: ${lat[0].toFixed(1)}s`);
    say(`latency:     mean ${mean(lat).toFixed(1)}s   worst ${Math.max(...lat).toFixed(1)}s`);
    say(`degradation: first half ${mean(lat.slice(0, half)).toFixed(1)}s → second half ${mean(lat.slice(half)).toFixed(1)}s`);
  }
  say(`first audio: ${firstAudioAt === null ? "NEVER — the agent never spoke" : firstAudioAt.toFixed(1) + "s"}`);
  say("");
  if (disconnects === 0 && turns.length > 0) {
    say(`VERDICT: the call held for ${(secs / 60).toFixed(0)} minutes with no disconnect.`);
    say(`         If that is >= 90, ElevenLabs clears the bar Gemini Live does not.`);
  } else if (disconnects > 0) {
    say(`VERDICT: the call DROPPED. Note the minute and the close code above — that is`);
    say(`         ElevenLabs' real session ceiling, and it decides the architecture.`);
  } else {
    say(`VERDICT: INCONCLUSIVE — no turns completed. Check the lines above for a 401,`);
    say(`         a 404 on the agent id, or an audio-format mismatch. A broken rig and a`);
    say(`         broken vendor look identical from here; do not conclude anything yet.`);
  }
  say("─────────────────────────────────────────────────────────────────────────");
  process.exit(0);
}

process.on("SIGINT", () => finish("interrupted by you (Ctrl-C)"));

/* Silence watchdog — a call that is technically open but conversationally dead
 * is the failure mode Gemini showed, and it would be invisible here otherwise. */
setInterval(() => {
  if (done || askedAt === null) return;
  const waited = now() - askedAt;
  if (waited > 60 && Math.floor(waited) % 60 === 0) say(`!! ${Math.round(waited)}s with no reply — the call is open but silent`);
}, 1000);

say(`starting: ${MINUTES} minutes${OFFLINE ? " (OFFLINE rig check — no key, no cost)" : `, agent ${AGENT_ID}`}`);
if (!OFFLINE) say(`this will consume roughly ${Math.ceil(MINUTES)} ElevenLabs call-minutes`);

(async () => {
  try {
    if (!OFFLINE) { say("pre-generating the interviewee's answers…"); for (const a of ANSWERS) await speak(a); say("answers ready"); }
    await connect();
  } catch (e) {
    say(`!! could not start: ${e.message}`);
    finish("start failed");
  }
})();

setTimeout(() => finish(`reached the ${MINUTES}-minute target WITHOUT dropping`), MINUTES * 60000 + 5000);
