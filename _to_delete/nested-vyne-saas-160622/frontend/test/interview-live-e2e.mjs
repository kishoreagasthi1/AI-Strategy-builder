/**
 * END-TO-END TEST for the Interview Agent's realtime voice path.
 *
 *   npm i -D ws playwright
 *   CHROMIUM_PATH=/path/to/chrome node frontend/test/interview-live-e2e.mjs
 *
 * Loads the REAL interview_agent.html in a real browser, against a fake VYNE
 * backend and a fake Gemini Live server, and drives an actual interview:
 * setup form → tap to begin → live session → transcripts → scoring → finish.
 *
 * It asserts the two things that matter most and cannot be checked by reading:
 *
 *   1. When realtime is available, the interview runs on it — one greeting, not
 *      two, and typed input goes into the live session rather than starting a
 *      parallel text conversation.
 *   2. When realtime is NOT available, the interview still runs, on the
 *      existing text + TTS path. An interview that dies because the voice
 *      transport is down is a far worse failure than one that sounds flat.
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTTP_PORT = 8791, WS_PORT = 8792;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

// ── Fake Gemini Live ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });

/**
 * What Google ACTUALLY does with a setup frame — not what we hope it does.
 *
 * This is the fix for the real defect behind five bad releases. The previous
 * fake accepted any JSON at all and answered setupComplete, so a setup frame
 * with speechConfig at the WRONG PATH passed every test and then spoke in the
 * default voice in production. A fake that accepts anything tests nothing.
 *
 * The paths below are read off @google/genai 2.16.0
 * (dist/index.cjs, liveConnectConfigToMldev):
 *
 *   setup.generationConfig.responseModalities
 *   setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName
 *   setup.systemInstruction
 *   setup.inputAudioTranscription / setup.outputAudioTranscription
 *
 * Anything placed elsewhere is IGNORED here, exactly as the real socket ignores
 * it — silently, with a successful connection and the default voice.
 */
const GOOGLE_DEFAULT_VOICE = 'Aoede';
function voiceGoogleWouldUse(setup) {
  const v = setup
    && setup.generationConfig
    && setup.generationConfig.speechConfig
    && setup.generationConfig.speechConfig.voiceConfig
    && setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig
    && setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
  return v || GOOGLE_DEFAULT_VOICE;
}
function modalitiesGoogleWouldUse(setup) {
  return (setup && setup.generationConfig && setup.generationConfig.responseModalities) || [];
}
let liveConnections = 0, sawClientText = null, audioFrames = 0, setupFrame = null;
let voiceUsed = null, modalitiesUsed = null;
let grantBody = null;

/**
 * Split text the way the Live API actually streams transcription: SUB-WORD
 * fragments that concatenate back to the original verbatim, each carrying its
 * own leading space where one belongs.
 *
 * The first version of this harness split on ' ', which silently discarded the
 * spacing question entirely — and that is why it passed while production
 * rendered "the sing le bi ggest re qui rement".
 */
const AGENT_LINE = "Hi, I'm Vyn. What does AI readiness look like from your seat?";
const USER_LINE = 'Yeah the single biggest requirement is to get all of our data into a single repository.';
function fragments(text) {
  const sizes = [3, 2, 5, 4, 6, 2, 7];
  const out = [];
  let i = 0, k = 0;
  while (i < text.length) {
    const n = sizes[k++ % sizes.length];
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

function pcm(ms) {
  const n = Math.floor(24000 * (ms / 1000));
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 24000) * 18000), i * 2);
  return b.toString('base64');
}

wss.on('connection', (ws) => {
  liveConnections++;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.setup) {
      setupFrame = m.setup;
      // Resolve the voice the way the real service does, from the real path.
      voiceUsed = voiceGoogleWouldUse(m.setup);
      modalitiesUsed = modalitiesGoogleWouldUse(m.setup);
      ws.send(JSON.stringify({ setupComplete: {} }));
      return;
    }
    if (m.realtimeInput) { audioFrames++; return; }
    if (m.clientContent) {
      sawClientText = m.clientContent.turns[0].parts[0].text;
      // Greet, then transcribe both sides and end the turn.
      // Audio only — the transcription arrives as its own fragment stream below,
      // continuously, the way a real turn does.
      ws.send(JSON.stringify({ serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm(300) } }] } } }));
      // Sub-word fragments, exactly as the Live API delivers them.
      fragments(AGENT_LINE).forEach((f) =>
        ws.send(JSON.stringify({ serverContent: { outputTranscription: { text: f } } })));
      fragments(USER_LINE).forEach((f) =>
        ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: f } } })));
      ws.send(JSON.stringify({ serverContent: { turnComplete: true },
        usageMetadata: { promptTokenCount: 100, responseTokenCount: 200 } }));
    }
  });
});

// ── Fake VYNE backend ────────────────────────────────────────────────────────
let liveEnabled = true;
let scoreCalls = 0, textGenerateCalls = 0, ttsCalls = 0, ttsVoices = [];

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url === '/api/voice/live-session' && req.method === 'POST') {
    let gb = ''; req.on('data', (c) => gb += c);
    req.on('end', () => { try { grantBody = JSON.parse(gb); } catch {} });
    if (!liveEnabled) return json({ error: 'daily_user_token_limit_exceeded' }, 503);
    return json({ token: 'tok', model: 'models/gemini-2.5-flash-native-audio-latest', voice: 'Orus',
                  maxSeconds: 2700, expiresAt: new Date(Date.now() + 2.7e6).toISOString(),
                  sessionId: 'sess-1', pinned: true });
  }
  if (url === '/api/voice/voices') return json({ voices: [
    { id: 'Aoede', presents: 'female', character: 'breezy' },
    { id: 'Charon', presents: 'male', character: 'informative' },
    { id: 'Orus', presents: 'male', character: 'firm' } ] });
  if (url === '/api/voice/live-session/close') return json({ ok: true });
  if (url === '/api/voice/tts') {
    ttsCalls++;
    let tb = ''; req.on('data', (c) => tb += c);
    req.on('end', () => { try { ttsVoices.push(JSON.parse(tb).voice || null); } catch { ttsVoices.push(null); }
      json({ audioBase64: '', mime: 'audio/wav', voice: 'Kore' }); });
    return;
  }
  if (url === '/api/llm/generate' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(b); } catch {}
      if (body.task === 'interview_score') {
        scoreCalls++;
        return json({ text: '{"scores":{"D1":3,"D2":0,"D3":4,"D4":0,"D5":0,"D6":0,"D7":0},"finding":{"dimension":"D1","text":"No single source of truth across warehouses."},"questionsAsked":2}',
                      provider: 'x', model: 'y', usage: {}, latencyMs: 1 });
      }
      textGenerateCalls++;
      return json({ text: 'Text path reply.\\n<<<SCORES>>>\\n{"scores":{"D1":2},"questionsAsked":1}\\n<<<END_SCORES>>>',
                    provider: 'x', model: 'y', usage: {}, latencyMs: 1 });
    });
    return;
  }
  // v5.32.47: the interviewer's name and voice are no longer typed on this
  // page's setup screen — a consultant assigns them in the Interview Tracker.
  // For a consultant running the agent directly, the tracker's remembered
  // defaults arrive through workspace state, so that is what this serves. The
  // DISTRIBUTED case carries the same two values on the interview row instead
  // (interviewees are locked out of workspace); asserted separately below.
  if (url.startsWith('/api/module-state/')) return json({ module: 'workspace', state: {
    vynora_interviewer_name: 'Anika',
    vynora_interviewer_voice: 'Orus',
  } });
  if (url === '/api/config') return json({ devAuth: false, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return json({ userId: 'u1', role: 'consultant', email: 't@t.com' });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  // Static files, with the live WS host rewritten to the fake server.
  try {
    let body = readFileSync(join(DIR, url === '/' ? 'interview_agent.html' : url), 'utf8');
    if (url.endsWith('vyne-live.js')) {
      body = body.replace("var WS_HOST = 'wss://generativelanguage.googleapis.com';", `var WS_HOST = 'ws://127.0.0.1:${WS_PORT}';`);
    }
    res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : 'text/html' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(HTTP_PORT, r));

// ── Drive the real page ──────────────────────────────────────────────────────
async function run(label, { live }) {
  liveEnabled = live;
  liveConnections = 0; sawClientText = null; audioFrames = 0; grantBody = null; setupFrame = null;
  voiceUsed = null; modalitiesUsed = null;
  scoreCalls = 0; textGenerateCalls = 0; ttsCalls = 0; ttsVoices = [];

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    try {
      sessionStorage.setItem('vyne_session', JSON.stringify({
        token: 'tok-abc', email: 't@t.com', role: 'consultant', mode: 'dev', at: Date.now(), la: Date.now() }));
    } catch (e) {}
    // No audio input device exists in CI containers — synthesise a real
    // MediaStream so the whole capture graph still runs for real.
    const patch = () => {
      if (!navigator.mediaDevices) return;
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: function () {
        const AC = window.AudioContext || window.webkitAudioContext;
        const ac = new AC(); const dest = ac.createMediaStreamDestination();
        const osc = ac.createOscillator(); osc.frequency.value = 200; osc.connect(dest); osc.start();
        return Promise.resolve(dest.stream);
      }});
    };
    patch();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(m.text())) errors.push(m.text()); });

  await page.goto(`http://127.0.0.1:${HTTP_PORT}/`);
  await page.waitForTimeout(600);

  // Fill the setup form and start.
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('change')); } };
    set('client-name', 'Acme Industrial');
    set('stakeholder-name', 'Dana Reed');
    set('industry', 'logistics');
    set('api-key', 'test-key');
    const role = document.getElementById('stakeholder-role');
    if (role && role.options.length > 1) { role.selectedIndex = 1; role.dispatchEvent(new Event('change')); }
    // Deliberately NOT setting an interviewer name or voice here: those fields
    // no longer exist on this screen. The values below come from the tracker.
  });

  // The setup screen must not grow these fields back. If it does, two places
  // can set the interviewer and the one that loses is silent about it — which
  // is precisely the failure this change removed.
  const removedFields = await page.evaluate(() => ({
    name: !!document.getElementById('interviewer-name'),
    voice: !!document.getElementById('interviewer-voice'),
  }));

  // The distributed path, checked directly. Driving the whole interviewee UI
  // here would test the invite flow rather than this resolution rule; what
  // matters is that an interview record BEATS whatever workspace state says,
  // because the interviewee's browser can only ever see the record.
  const fromInterviewRecord = await page.evaluate(() => {
    const prev = window.vyneInterview;
    window.vyneInterview = {
      isInterviewee: () => true,
      mine: () => ({ interviewer_name: 'Marcus', interviewer_voice: 'Charon' }),
    };
    let out;
    try { out = assignedInterviewerIdentity(); } finally { window.vyneInterview = prev; }
    return out;
  });
  await page.evaluate(() => { try { startNewInterview(); } catch (e) { window.__startErr = String(e); } });
  await page.waitForTimeout(800);

  // Tap the overlay to begin.
  await page.evaluate(() => {
    const ov = [...document.querySelectorAll('div')].find((d) => /Tap to (begin|resume)/.test(d.textContent || '') && d.style.position === 'fixed');
    if (ov && ov.onclick) ov.onclick();
  });
  await page.waitForTimeout(2500);

  const state = await page.evaluate(() => ({
    bubbles: document.querySelectorAll('#messages-wrap .msg-bubble').length,
    bubbleTexts: [...document.querySelectorAll('#messages-wrap .msg-bubble')].map((b) => b.textContent.trim()),
    clock: (document.getElementById('iv-clock') || {}).textContent || '',
    hasPause: !!document.getElementById('iv-pause'),
    badge: (document.getElementById('vyne-voice-badge') || {}).textContent || '',
    liveActive: typeof liveActive === 'function' ? liveActive() : null,
    // S is declared with `let`, so it is a script-scope binding and NOT a
    // property of window — reading window.S silently yields undefined.
    scores: (typeof S !== 'undefined') ? JSON.parse(JSON.stringify(S.scores || {})) : null,
    findings: (typeof S !== 'undefined') ? (S.findings || []).length : -1,
    chat: document.body.innerText,
  }));

  let pause = null;
  if (live) {
    // Measure the RATE, not a running total. Comparing cumulative counters
    // always shows "more later", so it passed even with the mute removed.
    await page.evaluate(() => togglePause());
    await page.waitForTimeout(300);          // let the mute take effect
    const atPause = audioFrames;
    const clockA = await page.evaluate(() => (document.getElementById('iv-clock') || {}).textContent);
    await page.waitForTimeout(1200);         // a window in which NOTHING should be sent
    const afterPauseWindow = audioFrames;
    const clockB = await page.evaluate(() => (document.getElementById('iv-clock') || {}).textContent);
    const labelPaused = await page.evaluate(() => (document.getElementById('iv-pause') || {}).textContent);

    await page.evaluate(() => togglePause());
    await page.waitForTimeout(1200);         // an equal window in which frames SHOULD flow
    const afterResumeWindow = audioFrames;

    pause = {
      duringPause: afterPauseWindow - atPause,
      afterResume: afterResumeWindow - afterPauseWindow,
      clockA, clockB, labelPaused,
    };
  }

  // ── Finish the interview for real, and watch what it does ────────────────
  //
  // v5.32.54. finishInterview() used to close with a TEXT call asking the model
  // to "provide final recommended scores for all dimensions" — built from
  // S.messages, which the realtime path NEVER writes. So on every voice
  // interview a model that had seen nothing invented seven scores, and they
  // were written straight over the ones the live scoring passes had measured.
  // Those went into the client deck.
  let finish = null;
  if (live) {
    const before = await page.evaluate(() => JSON.parse(JSON.stringify(S.scores || {})));
    const textCallsBefore = textGenerateCalls;
    await page.evaluate(() => { try { return finishInterview(); } catch (e) { return null; } });
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => JSON.parse(JSON.stringify(S.scores || {})));
    finish = {
      closingTextCalls: textGenerateCalls - textCallsBefore,
      scoresBefore: before,
      scoresAfter: after,
      // The resume gate reads this. On the live path S.messages stays empty,
      // so a gate that only counts messages cannot see a voice interview.
      messages: await page.evaluate(() => (S.messages || []).length),
      displayMessages: await page.evaluate(() => (S.displayMessages || []).length),
      startedGate: await page.evaluate(() => {
        var prior = { sess: { messages: S.messages, displayMessages: S.displayMessages } };
        return !!(prior && prior.sess && (
          (prior.sess.messages && prior.sess.messages.length > 0) ||
          (prior.sess.displayMessages && prior.sess.displayMessages.length > 0)
        ));
      }),
      findings: await page.evaluate(() => (S.findings || []).length),
    };
  }

  await browser.close();
  return { state, errors, pause, removedFields, fromInterviewRecord, finish };
}


// ── Case 1: realtime available ───────────────────────────────────────────────
{
  const { state, errors, pause, removedFields, fromInterviewRecord, finish } = await run('live', { live: true });
  check('live: no uncaught page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  check('live: a live session was opened', liveConnections === 1, `${liveConnections} connections`);
  check('live: badge shows live voice', /Live voice/.test(state.badge), state.badge);
  check('live: the agent was told to open the interview', !!sawClientText && /Begin the interview/i.test(sawClientText), String(sawClientText).slice(0, 80));
  check('live: microphone audio streamed', audioFrames > 0, `${audioFrames} frames`);
  check('live: agent speech reached the transcript', state.chat.includes('AI readiness look like'));
  check('live: interviewee speech reached the transcript', state.chat.includes('single biggest'));

  // THE bug: fragments were joined with an inserted space, producing
  // "the sing le bi ggest re qui rement". Exact reassembly is the only
  // assertion that catches it — a substring match on a few words does not.
  check('live: sub-word fragments reassemble EXACTLY, no inserted spaces',
    state.bubbleTexts.some((t) => t === AGENT_LINE),
    JSON.stringify(state.bubbleTexts.find((t) => /readiness/.test(t)) || state.bubbleTexts).slice(0, 200));
  check('live: the interviewee turn reassembles exactly too',
    state.bubbleTexts.some((t) => t === USER_LINE),
    JSON.stringify(state.bubbleTexts.find((t) => /single/.test(t)) || '').slice(0, 200));
  check('live: scoring pass ran over the transcript', scoreCalls >= 1, `${scoreCalls} calls`);
  check('live: scores applied to session state', state.scores.D3 === 4, JSON.stringify(state.scores));
  check('live: finding captured', state.findings >= 1, String(state.findings));
  // The whole point of the sequencing fix: the text path must NOT also run.
  check('live: no parallel text conversation started', textGenerateCalls === 0, `${textGenerateCalls} text generate calls`);

  // v5.32.43 — the word-per-line bug. Transcription arrives a word at a time;
  // each fragment used to become its own chat bubble, which made the transcript
  // unreadable. Two speakers over one exchange should be a handful of bubbles,
  // not one per word.
  check('live: transcript fragments coalesce into whole turns',
    state.bubbles > 0 && state.bubbles <= 6, `${state.bubbles} bubbles: ${JSON.stringify(state.bubbleTexts).slice(0, 160)}`);
  check('live: a whole sentence lands in ONE bubble',
    state.bubbleTexts.some((t) => t.includes('from your seat')),
    JSON.stringify(state.bubbleTexts).slice(0, 200));

  check('live: the TRACKER-assigned interviewer name reaches the server',
    grantBody && grantBody.interviewerName === 'Anika', JSON.stringify(grantBody || {}).slice(0, 160));
  check('live: the TRACKER-assigned voice reaches the server',
    grantBody && grantBody.voice === 'Orus', JSON.stringify(grantBody || {}).slice(0, 160));
  check('setup screen no longer offers its own interviewer name/voice',
    !removedFields.name && !removedFields.voice, JSON.stringify(removedFields));
  // THE assertion that five releases were missing. It does not ask "did we put
  // a speechConfig somewhere in the frame" — it asks the fake to resolve the
  // voice from the SAME path the real service reads, and fails if that comes
  // back as the default. speechConfig at setup.speechConfig (where this code
  // had it) resolves to Aoede here, exactly as it did in production.
  check('live: Google would actually USE the assigned voice, not the default',
    voiceUsed === 'Orus', `resolved: ${voiceUsed} (frame: ${JSON.stringify(setupFrame && setupFrame.generationConfig || null)})`);
  check('live: response modality resolves from the real path too',
    Array.isArray(modalitiesUsed) && modalitiesUsed[0] === 'AUDIO', JSON.stringify(modalitiesUsed));
  // pinned:true in the fake grant — so this also covers the case where the mint
  // succeeded and the voice would otherwise have been left to the token alone.
  check('live: the voice is sent even on a PINNED token',
    !!setupFrame && !!(setupFrame.generationConfig || {}).speechConfig,
    JSON.stringify(setupFrame && setupFrame.generationConfig || null));
  check('live: the badge names the voice actually in use',
    /Orus/.test(state.badge), state.badge);
  check('an assigned interview record supplies the interviewer identity',
    fromInterviewRecord && fromInterviewRecord.name === 'Marcus' && fromInterviewRecord.voice === 'Charon',
    JSON.stringify(fromInterviewRecord));

  // ── Finishing a VOICE interview must not invent scores ───────────────────
  check('finish: no transcript-less closing call that fabricates scores',
    finish && finish.closingTextCalls === 0,
    finish ? `${finish.closingTextCalls} closing text calls; S.messages=${finish.messages}` : 'no finish run');
  check('finish: measured scores survive the close unchanged',
    finish && JSON.stringify(finish.scoresBefore) === JSON.stringify(finish.scoresAfter),
    finish ? `${JSON.stringify(finish.scoresBefore)} -> ${JSON.stringify(finish.scoresAfter)}` : '');
  // ── An interrupted voice interview must be resumable ─────────────────────
  check('resume: a voice interview registers as started (else it is discarded)',
    finish && finish.messages === 0 && finish.displayMessages > 0 && finish.startedGate === true,
    finish ? `messages=${finish.messages} displayMessages=${finish.displayMessages} started=${finish.startedGate}` : '');
  check('findings: no duplicates accumulated across scoring passes',
    finish && finish.findings <= 2, finish ? `${finish.findings} findings` : '');

  check('live: pause control exists', state.hasPause);
  check('live: pause stops microphone frames',
    pause && pause.duringPause === 0 && pause.afterResume > 0,
    pause ? `frames during pause=${pause.duringPause}, after resume=${pause.afterResume}` : 'no pause run');
  check('live: pause stops the clock',
    pause && pause.clockA === pause.clockB, pause ? `${pause.clockA} → ${pause.clockB}` : '');
  check('live: pause button flips to Resume',
    pause && /Resume/.test(pause.labelPaused), pause ? pause.labelPaused : '');
  check('live: no TTS greeting talked over the live agent', ttsCalls === 0, `${ttsCalls} tts calls`);
}

// ── Case 2: realtime unavailable — the interview must still work ─────────────
{
  const { state, errors } = await run('fallback', { live: false });
  check('fallback: no uncaught page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  check('fallback: no live session attempted to open', liveConnections === 0, `${liveConnections}`);
  check('fallback: badge shows standard voice', /Standard voice/.test(state.badge), state.badge);
  // THE bug behind "it's gone back to the default female voice and delivery":
  // realtime falls back for ordinary reasons, and the TTS path ignored the
  // assigned voice entirely — so the interviewee heard the server default.
  check('fallback: TTS speaks in the ASSIGNED voice, not the server default',
    ttsVoices.length > 0 && ttsVoices.every((v) => v === 'Orus'),
    JSON.stringify(ttsVoices));
  // And the badge must say WHY, in words. A raw error code sent us round the
  // houses for a whole release cycle.
  check('fallback: badge explains WHY realtime is not in use, in English',
    /daily token cap/.test(state.badge) && !/daily_user_token_limit_exceeded/.test(state.badge),
    state.badge);
  check('fallback: the interview still ran on the text path', textGenerateCalls >= 1, `${textGenerateCalls} calls`);
  check('fallback: text path still scored', state.scores.D1 === 2, JSON.stringify(state.scores));
}

wss.close(); server.close();

console.log('\n=== INTERVIEW AGENT · REALTIME VOICE END-TO-END ===\n');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : '  → ' + r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
