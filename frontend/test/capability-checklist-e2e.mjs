/**
 * Gap Analysis — capability checklist is reliably available per use case (v5.33.19).
 *
 *   node frontend/test/capability-checklist-e2e.mjs
 *
 * The per-use-case "Capability checklist" read only the volatile
 * generatedAssumptions store, which a reload / client-switch / post-confirm
 * store re-sync clears — and writeRoadmapPartition persisted it under the WRONG
 * key (engKey instead of the ucId the readers use), so it was saved empty and
 * wiped on the next load. Now: (1) getEffectiveAssumptions/hasAssumptions fall
 * back to the capabilities saved on the requirements override (durable), so the
 * checklist stays available and earlier ones are recovered; (2) the live store
 * is persisted correctly so it survives a save/reload too.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CHECKLIST_PORT || 8975);
const results = [];
const check = (n, ok, d = '') => { let v = false; try { v = typeof ok === 'function' ? ok() : ok; } catch (e) { v = false; d = d || String(e).slice(0, 160); } results.push({ n, ok: !!v, d }); };

const nameUc = (id, name) => ({ id, name, desc: '', impact: 'high', value: 'x', phase: 'p1', requires: {}, deptName: 'X', subUcs: [] });
const CUSTOM = { ai_uc_a: nameUc('ai_uc_a', 'Demand Forecasting'), ai_uc_b: nameUc('ai_uc_b', 'Trade Promotion') };
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
  var capsA = { D1: [{ id: 'a_d1_0', text: 'A single governed demand data source exists', critical: 'required' }] };
  var capsB = { D5: [{ id: 'b_d5_0', text: 'Promotion outcomes are measured by account', critical: 'required' }] };
  // Confirmed requirements with capabilities saved on the override (durable copy).
  ucReqOverrides = {
    ai_uc_a: { confirmed: true, complexity: 2, requires: { D1: 3 }, capabilities: capsA, investments: { D1: [{ investment: 'Data lake', detail: 'd', score: 3 }] } },
    ai_uc_b: { confirmed: true, complexity: 2, requires: { D5: 3 }, capabilities: capsB, investments: { D5: [{ investment: 'Promo measurement', detail: 'd', score: 3 }] } },
  };
  selected = { ai_uc_a: true, ai_uc_b: true };
  // Simulate the wiped live store — the exact intermittent state.
  generatedAssumptions = {};

  function cardText(id) {
    var uc = getUc(id), dept = getDeptForUc(id), profile = getProfile(id);
    var card = buildGapCard({ id: id, uc: uc, dept: dept, profile: profile, gap: computeGap(profile, maturityScores), effective: computeEffectiveGaps(id, profile) });
    return card.textContent || '';
  }
  var res = {
    hasA: hasAssumptions('ai_uc_a'), hasB: hasAssumptions('ai_uc_b'),
    effA: Object.keys(getEffectiveAssumptions('ai_uc_a')),
    cardA: cardText('ai_uc_a'), cardB: cardText('ai_uc_b'),
  };

  // Persistence: the live store must survive save -> load.
  generatedAssumptions = { ai_uc_c: { D2: [{ id: 'c1', text: 'cap', critical: 'required' }] } };
  savePersistentState();
  generatedAssumptions = {};                 // simulate the wipe a reload used to cause
  loadPersistentState();
  res.persisted = !!(generatedAssumptions['ai_uc_c'] && generatedAssumptions['ai_uc_c'].D2);
  return res;
}, null);

check('checklist is AVAILABLE from the durable override even when the live store is empty',
  out.hasA === true && out.hasB === true, JSON.stringify({ hasA: out.hasA, hasB: out.hasB }));
check('getEffectiveAssumptions recovers the saved capabilities (reads ovr.capabilities)',
  out.effA.join(',') === 'D1', `effA=${JSON.stringify(out.effA)}`);
check('the "Capability checklist" renders under EACH use case (A and B)',
  /Capability checklist/.test(out.cardA) && /Capability checklist/.test(out.cardB),
  `A=${/Capability checklist/.test(out.cardA)} B=${/Capability checklist/.test(out.cardB)}`);
check('it renders COLLAPSED by default (shows "tap to expand")',
  /tap to expand/.test(out.cardA), `cardA has expand hint=${/tap to expand/.test(out.cardA)}`);
check('the live generatedAssumptions store now SURVIVES a save/reload (persistence fix)',
  out.persisted === true, `persisted=${out.persisted}`);

await browser.close();
server.close();
let pass = 0, fail = 0;
console.log('\n  GAP ANALYSIS — CAPABILITY CHECKLIST RELIABILITY\n  ' + '─'.repeat(64));
for (const r of results) { console.log(`  [${r.ok ? ' OK ' : 'FAIL'}] ${r.n}`); if (!r.ok) console.log(`         ${r.d}`); r.ok ? pass++ : fail++; }
if (pageErrors.length) { console.log('  page errors:'); pageErrors.slice(0, 6).forEach((e) => console.log('   - ' + e)); }
console.log('  ' + '─'.repeat(64) + `\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
