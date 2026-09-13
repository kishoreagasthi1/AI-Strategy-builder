/**
 * Synthesis publishes the hypothesis→verdict map without needing Close Round
 * (v5.33.15).
 *
 *   node frontend/test/synthesis-verdict-map-e2e.mjs
 *
 * The Pre-Engagement briefing reads vynora_hypothesis_verdicts_<code> to overlay
 * verdicts onto its hypothesis cards. That map used to be written ONLY by Close
 * Round, so running synthesis and viewing verdicts left the briefing unable to
 * reflect them. persistHypothesisVerdictMap() now writes the map from a synthesis
 * result directly. Drives the real function on the real page.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SVMAP_PORT || 8969);
const results = [];
const check = (n, ok, d = '') => { let v = false; try { v = typeof ok === 'function' ? ok() : ok; } catch (e) { v = false; d = d || String(e).slice(0, 160); } results.push({ n, ok: !!v, d }); };

const STATE = { vynora_engagement_index: JSON.stringify({ svco: 'ENG-9' }) };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const body = (cb) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => cb(b)); };
  if (url.startsWith('/api/llm')) return body(() => json({ text: '{}', finishReason: 'stop' }));
  if (url.startsWith('/api/module-state/')) { if (req.method === 'PUT') return body(() => json({ ok: true, versions: {} })); return json({ module: 'workspace', state: STATE, versions: {} }); }
  if (url === '/api/version') return json({ version: 'test', env: 'test' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'c@firm.com' });
  if (url === '/api/clients') return json({ clients: ['Svco'] });
  if (url === '/api/my-clients') return json({ role: 'owner', clients: ['Svco'] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/team') return json({ members: [] });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try { const f = readFileSync(join(DIR, url === '/' ? 'index.html' : url), 'utf8'); res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : url.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(f); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(`try{var s=${JSON.stringify({ token: 'tok', email: 'c@firm.com', role: 'owner', mode: 'dev', activeClient: 'Svco' })};
  s.at=Date.now();s.la=Date.now();sessionStorage.setItem('vyne_session', JSON.stringify(s));}catch(e){}`);
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));
page.on('dialog', (d) => d.dismiss().catch(() => {}));
await page.goto(`http://127.0.0.1:${PORT}/synthesis.html`);
await page.waitForTimeout(1200);

const out = await page.evaluate(() => {
  engagement = { code: 'ENG-9', client: 'Svco' };
  var res = { hypothesisVerdict: [
    { hypothesis: 'Forecasting is manual', verdict: 'confirmed', evidence: 'e1' },
    { hypothesis: 'Governance is centralized', verdict: 'contradicted', evidence: 'e2' },
  ] };
  persistHypothesisVerdictMap(res);
  var raw = vyneStore.getItem('vynora_hypothesis_verdicts_ENG-9');
  var vm = raw ? JSON.parse(raw) : null;
  // empty result must NOT clobber the just-written map
  persistHypothesisVerdictMap({ hypothesisVerdict: [] });
  var afterEmpty = vyneStore.getItem('vynora_hypothesis_verdicts_ENG-9');
  return { vm: vm, clobberedByEmpty: JSON.parse(afterEmpty || 'null') };
});

check('writes vynora_hypothesis_verdicts_<code> from a synthesis result (no Close Round needed)',
  out.vm && out.vm.byText && Object.keys(out.vm.byText).length === 2, JSON.stringify(out.vm && Object.keys(out.vm.byText || {})));
check('maps confirmed/contradicted verdicts by normalized hypothesis text',
  out.vm && out.vm.byText['forecasting is manual'] && out.vm.byText['forecasting is manual'].verdict === 'confirmed' &&
  out.vm.byText['governance is centralized'] && out.vm.byText['governance is centralized'].verdict === 'contradicted',
  JSON.stringify(out.vm && out.vm.byText));
check('an empty synthesis result does NOT clobber an existing map',
  out.clobberedByEmpty && out.clobberedByEmpty.byText && Object.keys(out.clobberedByEmpty.byText).length === 2,
  JSON.stringify(out.clobberedByEmpty && Object.keys(out.clobberedByEmpty.byText || {})));

await browser.close();
server.close();
let pass = 0, fail = 0;
console.log('\n  SYNTHESIS VERDICT-MAP PUBLISH\n  ' + '─'.repeat(64));
for (const r of results) { console.log(`  [${r.ok ? ' OK ' : 'FAIL'}] ${r.n}`); if (!r.ok) console.log(`         ${r.d}`); r.ok ? pass++ : fail++; }
if (pageErrors.length) { console.log('  page errors:'); pageErrors.slice(0, 5).forEach((e) => console.log('   - ' + e)); }
console.log('  ' + '─'.repeat(64) + `\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
