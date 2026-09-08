/**
 * END-TO-END TEST: a large workspace must still save (vyne-client.js, v5.33.1).
 *
 *   node frontend/test/large-save-e2e.mjs
 *
 * THE DATA LOSS. vyneStore's flush() sent every save with `keepalive: true`.
 * Chrome enforces a hard 64 KiB limit on the body of a keepalive request and
 * rejects anything larger IN THE BROWSER, before it is sent. The failure
 * surfaces as `TypeError: Failed to fetch` — no HTTP status, because no request
 * was made — so the network-level .catch re-queues the same oversized payload
 * and retries it forever at increasing backoff. Every save is lost, silently,
 * while the save pill reads "Not saved — retrying".
 *
 * WHY IT LOOKS LIKE "THIS USED TO WORK". Nothing fails until the workspace
 * crosses 64 KiB. vynora_roadmap_state carries EVERY client's partition and is
 * rewritten whole on every edit, so a substantial engagement — a 19-department
 * industry catalog with generated requirements — crosses the line mid-session
 * and from that moment nothing is ever saved again.
 *
 * Reported from production with this exact console signature:
 *     PUT /api/module-state/workspace 409 (Conflict)
 *     [vyne] state flush failed: TypeError: Failed to fetch   (repeating)
 *
 * WHY NO OTHER SUITE CATCHES IT. Every other e2e writes a few hundred bytes.
 * The bug is invisible below 64 KiB, which is every fixture in the repo. This
 * file's entire job is to write a payload big enough to trip the limit.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8833;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

let STATE = {};
let putCount = 0;
let biggestPut = 0;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'c@firm.com' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url.startsWith('/api/module-state/')) {
    if (req.method === 'PUT') {
      let b = ''; req.on('data', (c) => b += c);
      req.on('end', () => {
        putCount++;
        biggestPut = Math.max(biggestPut, Buffer.byteLength(b));
        let body = {}; try { body = JSON.parse(b); } catch { /* ignore */ }
        for (const [k, v] of Object.entries(body.sets || {})) STATE[k] = v;
        for (const k of body.deletes || []) delete STATE[k];
        json({ ok: true, versions: {} });
      });
      return;
    }
    return json({ module: 'workspace', state: STATE, versions: {} });
  }
  if (url === '/api/clients') return json({ clients: [] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url.startsWith('/api/llm')) return json({ text: '{}', finishReason: 'stop', provider: 'stub', model: 'stub', usage: {} });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try {
    const body = readFileSync(join(DIR, url === '/' ? 'roadmap.html' : url), 'utf8');
    res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : 'text/html' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
await ctx.addInitScript(`
  try { sessionStorage.setItem('vyne_session', JSON.stringify({
    token: 'tok', email: 'c@firm.com', role: 'owner', mode: 'dev',
    at: Date.now(), la: Date.now() })); } catch (e) {}
`);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForTimeout(1600);

/* ── A payload comfortably over the 64 KiB keepalive ceiling ──────────────── */
const KB = 400;
await page.evaluate(`(() => {
  var chunk = 'x'.repeat(1024);
  var big = [];
  for (var i = 0; i < ${KB}; i++) big.push(chunk);
  vyneStore.setItem('vynora_roadmap_state', JSON.stringify({ byEng: { big: big } }));
  return vyneStore.flush();
})()`);
await page.waitForTimeout(2500);

check(`a ${KB} KB save actually reaches the server`, putCount >= 1,
  putCount + ' PUTs received');
check('the server received the whole payload, not a truncated one',
  biggestPut > KB * 1024 * 0.9, biggestPut + ' bytes');
check('the value is readable back from the server',
  (() => { try { return JSON.parse(STATE['vynora_roadmap_state'] || '{}').byEng.big.length === KB; }
           catch { return false; } })(),
  Object.keys(STATE).join(', ') || '(server has nothing)');

/* The pill is the consultant's only signal. Stuck on "Not saved — retrying"
 * while nothing can ever succeed is the part that cost a day's work. */
const pill = await page.evaluate(`(() => {
  var el = document.getElementById('vyne-save-indicator');
  return el ? (el._label ? el._label.textContent : el.textContent) : 'MISSING';
})()`);
check('the save pill is not stuck on a retry that can never succeed',
  !/Not saved/i.test(String(pill)), String(pill));

/* A small save must keep working too — the fix must not disable keepalive
 * everywhere, only where the browser would refuse the request. */
putCount = 0;
await page.evaluate(`(() => {
  vyneStore.setItem('vynora_deck_mode', 'internal');
  return vyneStore.flush();
})()`);
await page.waitForTimeout(1200);
check('a small save still goes out', putCount >= 1 && STATE['vynora_deck_mode'] === 'internal',
  putCount + ' PUTs, value=' + STATE['vynora_deck_mode']);

check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
