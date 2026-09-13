/**
 * Gap Analysis — capability-checklist header reflects real blocking (v5.33.21).
 *
 *   node frontend/test/checklist-header-e2e.mjs
 *
 * getAssumptionState defaults to TRUE (assumed in place unless unchecked), so the
 * collapsed header counted only unchecked capabilities and ignored SCORE gaps —
 * it read "all in place" while dimensions were blocking and readiness was under
 * 100%. The header now mirrors effective.effectiveBlocking (score gaps + unchecked
 * REQUIRED capabilities), so "all in place" appears only when the use case is
 * genuinely unblocked.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.HDR_PORT || 8979);
const results = [];
const check = (n, ok, d = '') => { let v = false; try { v = typeof ok === 'function' ? ok() : ok; } catch (e) { v = false; d = d || String(e).slice(0, 160); } results.push({ n, ok: !!v, d }); };

const nameUc = (id, name) => ({ id, name, desc: '', impact: 'high', value: 'x', phase: 'p1', requires: {}, deptName: 'X', subUcs: [] });
const CUSTOM = { ai_uc_block: nameUc('ai_uc_block', 'Blocked UC'), ai_uc_ready: nameUc('ai_uc_ready', 'Ready UC') };
const STATE = {
  vynora_engagement_index: JSON.stringify({ testco: 'TST-1' }),
  'vynora_custom_ucs_eng_TST-1': JSON.stringify(CUSTOM),
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const body = (cb) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => cb(b)); };
  if (url.startsWith('/api/llm')) return body(() => json({ text: '{}', finishReason: 'stop' }));
  if (url.startsWith('/api/module-state/')) { if (req.method === 'PUT') return body(() => json({ ok: true, versions: {} })); return json({ module: 'workspace', state: STATE, versions: {} }); }
  if (url === '/api/version') return json({ version: 'test', env: 'test' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'c@firm.com' });
  if (url === '/api/clients') return json({ clients: ['Testco'] });
  if (url === '/api/my-clients') return json({ role: 'owner', clients: ['Testco'] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/team') return json({ members: [] });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try { const f = readFileSync(join(DIR, url === '/' ? 'index.html' : url), 'utf8'); res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : url.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(f); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(`try{var s=${JSON.stringify({ token: 'tok', email: 'c@firm.com', role: 'owner', mode: 'dev', activeClient: 'Testco' })};
  s.at=Date.now();s.la=Date.now();sessionStorage.setItem('vyne_session', JSON.stringify(s));}catch(e){}`);
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));
page.on('dialog', (d) => d.dismiss().catch(() => {}));
await page.goto(`http://127.0.0.1:${PORT}/roadmap.html`);
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  currentClientName = 'Testco';
  rehydrateCustomUcs('eng_TST-1');
  maturityScores = { D1: 2, D2: 2, D3: 2, D4: 2, D5: 2, D6: 2, D7: 2 };
  // BLOCKED: needs D1 = 3 but score is 2. Capabilities present, all default "in place".
  // READY: needs D1 = 2 and score is 2 — no gap.
  ucReqOverrides = {
    ai_uc_block: { confirmed: true, complexity: 2, requires: { D1: 3 }, capabilities: { D1: [{ id: 'blk_d1_0', text: 'a data foundation', critical: 'required' }] }, investments: { D1: [{ investment: 'Data lake', detail: 'd', score: 3 }] } },
    ai_uc_ready: { confirmed: true, complexity: 2, requires: { D1: 2 }, capabilities: { D1: [{ id: 'rdy_d1_0', text: 'a data foundation', critical: 'required' }] }, investments: { D1: [{ investment: 'Data lake', detail: 'd', score: 2 }] } },
  };
  selected = { ai_uc_block: true, ai_uc_ready: true };

  function info(id) {
    var uc = getUc(id), dept = getDeptForUc(id), profile = getProfile(id);
    var eff = computeEffectiveGaps(id, profile);
    var card = buildGapCard({ id: id, uc: uc, dept: dept, profile: profile, gap: computeGap(profile, maturityScores), effective: eff });
    return { text: card.textContent || '', readiness: eff.readiness, blocking: eff.effectiveBlocking.length };
  }
  return { blk: info('ai_uc_block'), rdy: info('ai_uc_ready') };
}, null);

check('a score-blocked use case is NOT ready (sanity: readiness < 100, 1 blocking dim)',
  out.blk.readiness < 100 && out.blk.blocking === 1, JSON.stringify(out.blk));
check('its checklist header does NOT say "all in place" (the reported bug)',
  !/all in place/.test(out.blk.text), 'header still says all in place');
check('instead it reports the blocking dimension ("1 dimension needs attention")',
  /1 dimension needs attention/.test(out.blk.text), `text=${out.blk.text.slice(0, 200)}`);
check('a genuinely unblocked use case (readiness 100) still shows "all in place"',
  out.rdy.readiness === 100 && /all in place/.test(out.rdy.text), JSON.stringify({ readiness: out.rdy.readiness, allInPlace: /all in place/.test(out.rdy.text) }));

await browser.close();
server.close();
let pass = 0, fail = 0;
console.log('\n  CHECKLIST HEADER REFLECTS BLOCKING\n  ' + '─'.repeat(64));
for (const r of results) { console.log(`  [${r.ok ? ' OK ' : 'FAIL'}] ${r.n}`); if (!r.ok) console.log(`         ${r.d}`); r.ok ? pass++ : fail++; }
if (pageErrors.length) { console.log('  page errors:'); pageErrors.slice(0, 6).forEach((e) => console.log('   - ' + e)); }
console.log('  ' + '─'.repeat(64) + `\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
