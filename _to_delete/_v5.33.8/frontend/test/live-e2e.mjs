/**
 * END-TO-END TEST for vyne-live.js — run it in a real browser.
 *
 *   npm i -D ws playwright        # not repo dependencies; this is run on demand
 *   node frontend/test/live-e2e.mjs
 *
 * Drives the REAL browser audio pipeline (AudioContext, MediaStream capture,
 * ScriptProcessor, WebSocket) against a fake Gemini Live server and a fake VYNE
 * backend. Verifies: the grant is requested, the token reaches the socket, the
 * setup frame pins model + AUDIO + both transcriptions, microphone audio is
 * streamed as 16 kHz PCM16, transcripts surface, BARGE-IN flushes queued
 * speech, and the session is reconciled on close with the server's own usage.
 *
 * TWO THINGS IT DELIBERATELY FAKES, and why:
 *
 *   · The Google endpoint. WS_HOST is rewritten to a local server, so this
 *     proves the protocol shape and the client's behaviour, NOT that Google
 *     accepts it. test/liveClient.test.ts asserts the shipped file still points
 *     at the real host, so the rewrite cannot leak into a release.
 *   · The microphone. Containers have no audio input device (verified:
 *     enumerateDevices() returns empty even with Chromium's fake-capture
 *     flags), so the stream is synthesised in-browser from an oscillator. The
 *     whole capture graph is still real; only the OS device layer is not.
 *
 * What it CANNOT tell you: whether it sounds good, whether the latency feels
 * conversational, or whether barge-in feels responsive to a human. Those need
 * a person, a microphone and a real key.
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'vyne-live.js');
const HTTP_PORT = 8781, WS_PORT = 8782;

const log = [];
const record = (k, v) => log.push({ k, v });

// ── Fake Gemini Live server ──────────────────────────────────────────────────
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
let audioFrames = [];
let setupFrame = null;
let voiceUsed = null;

function pcmChunk(ms, freq = 440) {
  const n = Math.floor(24000 * (ms / 1000));
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / 24000) * 20000), i * 2);
  return b.toString('base64');
}

wss.on('connection', (ws, req) => {
  record('ws_connected', { url: req.url });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.setup) {
      setupFrame = m.setup;
      voiceUsed = voiceGoogleWouldUse(m.setup);   // resolved from the REAL path
      record('setup', m.setup);
      ws.send(JSON.stringify({ setupComplete: {} }));
      return;
    }
    if (m.realtimeInput && m.realtimeInput.audio) {
      audioFrames.push(m.realtimeInput.audio);
      if (audioFrames.length === 3) {
        // Speak: three chunks of audio plus transcripts.
        ws.send(JSON.stringify({ serverContent: {
          outputTranscription: { text: 'Tell me about your data platform.' },
          modelTurn: { parts: [
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmChunk(1500) } },
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmChunk(1500, 520) } },
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmChunk(1500, 620) } },
          ] } } }));
        ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'We have three warehouses.' } } }));
      }
      if (audioFrames.length === 6) {
        // BARGE-IN: the user talked over the model mid-utterance.
        ws.send(JSON.stringify({ serverContent: { interrupted: true } }));
        ws.send(JSON.stringify({ usageMetadata: { promptTokenCount: 1234, responseTokenCount: 5678 } }));
      }
    }
    if (m.clientContent) record('client_text', m.clientContent);
  });
});

// ── Fake VYNE backend + page ─────────────────────────────────────────────────
let closeBody = null;
const clientJs = readFileSync(CLIENT, 'utf8')
  .replace("var WS_HOST = 'wss://generativelanguage.googleapis.com';", `var WS_HOST = 'ws://127.0.0.1:${WS_PORT}';`);

const CLIENTJS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'vyne-client.js'), 'utf8');
const PAGE = `<!doctype html><meta charset="utf-8"><title>live harness</title>
<script>try{sessionStorage.setItem('vyne_session', JSON.stringify({token:'tok-abc123',email:'t@t.com',role:'consultant',mode:'dev',at:Date.now(),la:Date.now()}));}catch(e){}</script>
<script>${CLIENTJS}</script>
<script>
// This container has no audio input device (verified: enumerateDevices() is
// empty even with Chromium's fake-capture flags). So build a genuine
// MediaStream in-browser from an oscillator. The full capture graph —
// createMediaStreamSource, ScriptProcessor, float->PCM16, base64, socket — is
// exercised for real; only the OS device layer is substituted, which is the
// one part that cannot be tested here anyway.
(function(){
  var real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: function(){
    var AC = window.AudioContext || window.webkitAudioContext;
    var ac = new AC();
    var dest = ac.createMediaStreamDestination();
    var osc = ac.createOscillator(); osc.type='sawtooth'; osc.frequency.value = 190;
    var lfo = ac.createOscillator(); lfo.frequency.value = 0.9;      // syllable-ish envelope
    var lfoGain = ac.createGain(); lfoGain.gain.value = 0.45;
    var g = ac.createGain(); g.gain.value = 0.5;
    lfo.connect(lfoGain); lfoGain.connect(g.gain);
    osc.connect(g); g.connect(dest);
    osc.start(); lfo.start();
    window.__fakeMic = ac;
    return Promise.resolve(dest.stream);
  }});
})();
</script>
<script>${clientJs}</script>
<script>
window.__ev = [];
window.__start = function(){
  return window.vyneLive.start({
    module: 'interview_agent',
    systemInstruction: 'You are a VYNE interviewer.',
    onState: function(s){ window.__ev.push(['state', s]); },
    onUserText: function(t){ window.__ev.push(['user', t]); },
    onAgentText: function(t){ window.__ev.push(['agent', t]); },
    onInterrupted: function(){ window.__ev.push(['interrupted', Date.now()]); },
    onError: function(r){ window.__ev.push(['error', r]); },
    onEnded: function(r){ window.__ev.push(['ended', r]); }
  }).then(function(s){
      window.__session = s;
      var origFlush = s.queue.flush.bind(s.queue);
      s.queue.flush = function(){
        window.__ev.push(['flush_pending_before', s.queue.pending()]);
        origFlush();
        window.__ev.push(['flush_pending_after', s.queue.pending()]);
      };
      return 'ok';
    })
    .catch(function(e){ window.__ev.push(['startfail', String(e && e.message)]); return 'fail:'+(e&&e.message); });
};
</script>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  if (req.url === '/api/voice/live-session' && req.method === 'POST') {
    record('grant_requested', req.headers['authorization'] || null);
    res.writeHead(200, { 'content-type': 'application/json' });
    // pinned:false mirrors PRODUCTION: Google's auth_tokens endpoint rejects
    // the constraint block, so the persona and the voice both have to travel in
    // the setup frame instead. Minting this as pinned:true would have made the
    // v5.32.47 voice bug untestable — which is how it shipped.
    res.end(JSON.stringify({ token: 'eph-test-token', model: 'gemini-live-2.5-flash-preview',
                             voice: 'Orus', maxSeconds: 2700, expiresAt: new Date(Date.now() + 2700e3).toISOString(),
                             sessionId: 'sess-test-1', pinned: false,
                             instruction: 'You are Vyn, an AI-readiness interviewer.' }));
    return;
  }
  if (req.url === '/api/voice/live-session/close' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => { closeBody = JSON.parse(b || '{}'); record('close_posted', closeBody);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
    return;
  }
  // vyne-client.js hydrates workspace state on boot; without this it paints a
  // read-only banner and logs errors that mask real page failures.
  if (req.url.startsWith('/api/module-state/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ module: 'workspace', state: {} }));
    return;
  }
  /* v5.33.4: vyne-client.js probes /api/version on every page load to warn
   * about a frontend/backend version skew. Unhandled it 404s, which this
   * file's "no uncaught page errors" check counts as an error — a harness gap,
   * not a product bug. Answering with the page's own version keeps the banner
   * silent, which is what this suite wants. */
  if (req.url === '/api/version') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: 'test', env: 'test' }));
    return;
  }
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(HTTP_PORT, r));

// ── Drive a real browser ─────────────────────────────────────────────────────
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-device-for-media-capture', '--use-fake-ui-for-media-stream',
         '--autoplay-policy=no-user-gesture-required', '--no-sandbox',
         '--disable-features=AudioServiceOutOfProcess'],
});
const ctx = await browser.newContext({ permissions: ['microphone'] });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) pageErrors.push('console: ' + m.text()); });

await page.goto(`http://127.0.0.1:${HTTP_PORT}/`);
const supported = await page.evaluate(() => window.vyneLive.isSupported());
const startResult = await page.evaluate(() => window.__start());

// Let audio actually flow.
await page.waitForTimeout(3500);

const state = await page.evaluate(() => ({
  events: window.__ev,
  micRate: window.__session ? window.__session.micCtx.sampleRate : null,
  outRate: window.__session ? window.__session.outCtx.sampleRate : null,
  pendingAfterBargeIn: window.__session ? window.__session.queue.pending() : null,
  wsState: window.__session ? window.__session.ws.readyState : null,
}));

await page.evaluate(() => window.__session && window.__session.stop('test_done'));
await page.waitForTimeout(600);

await browser.close(); wss.close(); server.close();

// ── Assertions ───────────────────────────────────────────────────────────────
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

check('vyneLive.isSupported() in a real browser', supported === true, String(supported));
check('session started without falling back', startResult === 'ok', String(startResult));
check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));
check('backend grant was requested', log.some((l) => l.k === 'grant_requested'));
// v5.32.35: vyne-live.js called a helper that did not exist, silently sent NO
// Authorization header, and every session died at the server with
// `missing_token`. The fake backend never checked, so nothing caught it.
check('grant request carried the session bearer token',
  log.some((l) => l.k === 'grant_requested' && typeof l.v === 'string' && l.v.startsWith('Bearer ')),
  String(log.find((l) => l.k === 'grant_requested')?.v));
check('websocket connected carrying the ephemeral token',
  log.some((l) => l.k === 'ws_connected' && /(?:key|access_token)=eph-test-token/.test(l.v.url)),
  String(log.find((l) => l.k === 'ws_connected')?.v?.url));
check('setup frame pinned model + AUDIO + both transcriptions',
  !!setupFrame && setupFrame.model === 'models/gemini-live-2.5-flash-preview'
  && setupFrame.generationConfig.responseModalities[0] === 'AUDIO'
  && !!setupFrame.inputAudioTranscription && !!setupFrame.outputAudioTranscription,
  JSON.stringify(setupFrame || {}).slice(0, 160));

check('the service would actually USE the chosen voice, not the default',
  voiceUsed === 'Orus',
  `resolved: ${voiceUsed} (generationConfig: ${JSON.stringify(setupFrame && setupFrame.generationConfig || null)})`);
check('setup frame carries the server-composed persona when not pinned',
  !!setupFrame && !!setupFrame.systemInstruction
  && /Vyn/.test(setupFrame.systemInstruction.parts[0].text),
  JSON.stringify(setupFrame && setupFrame.systemInstruction || null).slice(0, 120));

check('real microphone audio streamed to the socket', audioFrames.length >= 6, `${audioFrames.length} frames`);
check('every audio frame declares rate=16000',
  audioFrames.length > 0 && audioFrames.every((f) => f.mimeType === 'audio/pcm;rate=16000'),
  audioFrames[0] && audioFrames[0].mimeType);
const decoded = audioFrames.length ? Buffer.from(audioFrames[0].data, 'base64') : Buffer.alloc(0);
check('frames carry PCM16 of the expected frame size', decoded.length === 2048 * 2, `${decoded.length} bytes`);
const nonSilent = audioFrames.some((f) => {
  const b = Buffer.from(f.data, 'base64');
  for (let i = 0; i < b.length; i += 2) if (Math.abs(b.readInt16LE(i)) > 200) return true;
  return false;
});
check('captured audio is a real signal, not silence', nonSilent);

check('capture context runs at 16 kHz (no resampling in the hot path)', state.micRate === 16000, String(state.micRate));
check('playback context runs at 24 kHz', state.outRate === 24000, String(state.outRate));

const ev = state.events.map((e) => e[0] + ':' + e[1]);
check('reached the live state', ev.some((e) => e === 'state:live'), ev.join(','));
check('agent transcript surfaced', ev.some((e) => e.startsWith('agent:Tell me about')));
check('interviewee transcript surfaced', ev.some((e) => e.startsWith('user:We have three warehouses')));
check('barge-in fired', ev.some((e) => e.startsWith('interrupted:')));
const before = state.events.filter((e) => e[0] === 'flush_pending_before').map((e) => e[1]);
const after = state.events.filter((e) => e[0] === 'flush_pending_after').map((e) => e[1]);
check('there was queued speech to interrupt (else the test proves nothing)',
  before.some((n) => n > 0), 'pending before flush: ' + JSON.stringify(before));
check('barge-in actually flushed the queued speech',
  before.some((n) => n > 0) && after.every((n) => n === 0),
  'before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));

check('close posted the session for reconciliation', !!closeBody);
check('close reported usage from the server, not invented',
  !!closeBody && closeBody.tokensIn === 1234 && closeBody.tokensOut === 5678, JSON.stringify(closeBody));
check('close reported a bounded duration',
  !!closeBody && closeBody.seconds >= 0 && closeBody.seconds <= 2700, closeBody && String(closeBody.seconds));

console.log('\n=== vyne-live.js END-TO-END (real Chromium, fake mic, fake Live server) ===\n');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : '  → ' + r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
