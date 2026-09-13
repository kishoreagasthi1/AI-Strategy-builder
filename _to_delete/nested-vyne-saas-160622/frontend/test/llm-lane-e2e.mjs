/**
 * LLM generation lane routing — item 7 of the perf review (v5.34.0).
 *
 *   node frontend/test/llm-lane-e2e.mjs
 *
 * Splitting generation onto its own Cloud Run service is a frontend routing
 * switch: window.VYNE_LLM_BASE. This drives the REAL vyne-client.js and asserts:
 *   · with VYNE_LLM_BASE set, window.vyneLLM() hits the LLM server, NOT the API;
 *   · a data write (vyneStore) still goes to the API server, never the LLM one;
 *   · with VYNE_LLM_BASE UNSET (the default), generation goes to the API server
 *     — i.e. nothing changes until an operator opts in.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = Number(process.env.LANE_API_PORT || 8991);
const LLM_PORT = Number(process.env.LANE_LLM_PORT || 8992);
const results = [];
const check = (n, ok, d = '') => { let v = false; try { v = typeof ok === 'function' ? ok() : ok; } catch (e) { v = false; d = d || String(e).slice(0, 160); } results.push({ n, ok: !!v, d }); };

const apiHits = [];
const llmHits = [];
const STATE = { vynora_seed: JSON.stringify('ok') };

function jsonRes(res, o) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); }
function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', '*');
}

// API server: serves the frontend + data endpoints, records what it receives.
const apiServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  apiHits.push(url);
  const body = (cb) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => cb(b)); };
  if (url.startsWith('/api/llm')) return body(() => jsonRes(res, { text: '{}', finishReason: 'stop' }));
  if (url.startsWith('/api/voice')) return body(() => jsonRes(res, { ok: true }));
  if (url.startsWith('/api/module-state/')) { if (req.method === 'PUT') return body(() => jsonRes(res, { ok: true, versions: {} })); return jsonRes(res, { module: 'workspace', state: STATE, versions: {} }); }
  if (url === '/api/version') return jsonRes(res, { version: 'test', env: 'test' });
  if (url === '/api/config') return jsonRes(res, { devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return jsonRes(res, { userId: 'u1', role: 'owner', email: 'c@firm.com' });
  if (url === '/api/clients') return jsonRes(res, { clients: ['Testco'] });
  if (url === '/api/my-clients') return jsonRes(res, { role: 'owner', clients: ['Testco'] });
  if (url === '/api/assignments') return jsonRes(res, { assignments: [] });
  if (url === '/api/team') return jsonRes(res, { members: [] });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try { const f = readFileSync(join(DIR, url === '/' ? 'index.html' : url), 'utf8'); res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : 'text/html' }); res.end(f); }
  catch { res.writeHead(404); res.end(); }
});

// LLM server: the "generation lane". Records hits, answers with a valid shape.
const llmServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  llmHits.push(url);
  const body = (cb) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => cb(b)); };
  if (url.startsWith('/api/llm')) return body(() => jsonRes(res, { text: '{"ok":1}', finishReason: 'stop' }));
  if (url.startsWith('/api/voice')) return body(() => jsonRes(res, { ok: true }));
  res.writeHead(404); res.end();
});

await new Promise((r) => apiServer.listen(API_PORT, r));
await new Promise((r) => llmServer.listen(LLM_PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function run(withLlmBase) {
  apiHits.length = 0; llmHits.length = 0;
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const llmUrl = `http://127.0.0.1:${LLM_PORT}`;
  await ctx.addInitScript(`try{
    var s=${JSON.stringify({ token: 'tok', email: 'c@firm.com', role: 'owner', mode: 'dev', activeClient: 'Testco' })};
    s.at=Date.now();s.la=Date.now();sessionStorage.setItem('vyne_session', JSON.stringify(s));
    ${withLlmBase ? `window.VYNE_LLM_BASE=${JSON.stringify(llmUrl)};` : ''}
  }catch(e){}`);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(`http://127.0.0.1:${API_PORT}/roadmap.html`);
  await page.waitForTimeout(1200);
  // Fire one generation call and one data write through the REAL client.
  await page.evaluate(async () => {
    await window.vyneLLM({ body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }) }, 'test');
    window.vyneStore.setItem('vynora_lane_probe', 'x');
    window.vyneStore.flush();
  });
  await page.waitForTimeout(600);
  const base = withLlmBase ? llmUrl : '';
  const out = { llmBase: page.evaluate ? await page.evaluate(() => (window.vyneLlmBase ? window.vyneLlmBase() : 'MISSING')) : null };
  await ctx.close();
  return { ...out, apiHits: [...apiHits], llmHits: [...llmHits], base };
}

const on = await run(true);
const off = await run(false);

await browser.close();
apiServer.close();
llmServer.close();

// ── with the split ON ──
check('vyneLlmBase() returns the configured LLM base when VYNE_LLM_BASE is set',
  on.llmBase === `http://127.0.0.1:${LLM_PORT}`, `got ${on.llmBase}`);
check('generation (/api/llm/generate) is routed to the LLM server',
  on.llmHits.some((u) => u.startsWith('/api/llm')), `llmHits=${JSON.stringify(on.llmHits)}`);
check('the LLM server received NO data (/api/module-state) calls',
  !on.llmHits.some((u) => u.startsWith('/api/module-state')), `llmHits=${JSON.stringify(on.llmHits)}`);
check('the data write (/api/module-state PUT) still went to the API server',
  on.apiHits.some((u) => u.startsWith('/api/module-state')), `apiHits=${JSON.stringify(on.apiHits)}`);
check('the API server received NO generation calls when split is on',
  !on.apiHits.some((u) => u.startsWith('/api/llm')), `apiHits=${JSON.stringify(on.apiHits)}`);

// ── with the split OFF (default) ──
check('default: vyneLlmBase() equals the API base (empty string) when unset',
  off.llmBase === '', `got ${off.llmBase}`);
check('default: generation stays on the API server (no LLM service needed)',
  off.apiHits.some((u) => u.startsWith('/api/llm')) && off.llmHits.length === 0,
  `apiHits=${JSON.stringify(off.apiHits)} llmHits=${JSON.stringify(off.llmHits)}`);

let pass = 0, fail = 0;
console.log('\n  LLM GENERATION LANE ROUTING (item 7)\n  ' + '─'.repeat(64));
for (const r of results) { console.log(`  [${r.ok ? ' OK ' : 'FAIL'}] ${r.n}`); if (!r.ok) console.log(`         ${r.d}`); r.ok ? pass++ : fail++; }
console.log('  ' + '─'.repeat(64) + `\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
