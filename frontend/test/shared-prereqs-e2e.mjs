/**
 * Roadmap Builder — capability-level Shared Prerequisites + synthesis unification (v5.33.17).
 *
 *   node frontend/test/shared-prereqs-e2e.mjs
 *
 * ONE canonical function (computeSharedPrereqs) ranks the SPECIFIC shared
 * capabilities (investment rungs) required across selected use cases. It drives
 * BOTH the Gap-Analysis "Shared prerequisites" panel AND the roadmap synthesis
 * context (buildSynthesisContext().sharedGaps), so the two can't drift.
 *
 * Scenario (maturity 2.0; confirmed per-use-case requirements + investments):
 *   A Demand Forecasting : needs DL, FS
 *   B Assortment         : needs DL, FS, EF
 *   C Control Tower      : needs DL, PM, RT
 *   D Trade Promotion    : needs PM            → PM completes it
 *   E Sentiment Mining   : needs RI            (single-use)
 * Shared (≥2): DL×3, FS×2, PM×2 (PM completes D). Single: EF, RT, RI.
 * Ranking: DL (3) → PM (2, completes 1) → FS (2, completes 0).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PREREQ_PORT || 8973);
const results = [];
const check = (n, ok, d = '') => { let v = false; try { v = typeof ok === 'function' ? ok() : ok; } catch (e) { v = false; d = d || String(e).slice(0, 160); } results.push({ n, ok: !!v, d }); };

const nameUc = (id, name) => ({ id, name, desc: '', impact: 'high', value: 'x', phase: 'p1', requires: {}, deptName: 'X', subUcs: [] });
const CUSTOM = {
  ai_uc_a: nameUc('ai_uc_a', 'Demand Forecasting'),
  ai_uc_b: nameUc('ai_uc_b', 'Assortment Optimization'),
  ai_uc_c: nameUc('ai_uc_c', 'Supply Chain Control Tower'),
  ai_uc_d: nameUc('ai_uc_d', 'Trade Promotion Optimization'),
  ai_uc_e: nameUc('ai_uc_e', 'Consumer Sentiment Mining'),
};
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
  var DL = { investment: 'Unified data lake', detail: 'consolidate POS/shipment/master data', score: 3 };
  var FS = { investment: 'Feature store', detail: 'serve ML-ready features', score: 3 };
  var PM = { investment: 'Closed-loop promotion measurement', detail: 'attribute lift by account', score: 3 };
  var RT = { investment: 'Real-time streaming', detail: 'live POS/inventory events', score: 3 };
  var EF = { investment: 'Executive AI forum', detail: 'prioritization governance', score: 4 };
  var RI = { investment: 'Review ingestion', detail: 'social + review pipeline', score: 3 };
  ucReqOverrides = {
    ai_uc_a: { confirmed: true, complexity: 2, requires: { D1: 3 }, investments: { D1: [DL, FS] } },
    ai_uc_b: { confirmed: true, complexity: 2, requires: { D1: 3, D3: 4 }, investments: { D1: [DL, FS], D3: [EF] } },
    ai_uc_c: { confirmed: true, complexity: 2, requires: { D1: 3, D5: 3 }, investments: { D1: [DL], D5: [PM, RT] } },
    ai_uc_d: { confirmed: true, complexity: 2, requires: { D5: 3 }, investments: { D5: [PM] } },
    ai_uc_e: { confirmed: true, complexity: 2, requires: { D1: 3 }, investments: { D1: [RI] } },
  };
  selected = { ai_uc_a: true, ai_uc_b: true, ai_uc_c: true, ai_uc_d: true, ai_uc_e: true };

  var lines = computeSharedPrereqs();
  var by = {}; lines.forEach(function (l) { by[l.name] = { count: l.count, completesCount: l.completesCount, inits: l.inits.slice() }; });
  var order = lines.filter(function (l) { return l.count >= 2; }).map(function (l) { return l.name; });

  // per-uc detail on PM (should complete Trade Promotion, +2 for Control Tower)
  var pm = lines.find(function (l) { return l.name === 'Closed-loop promotion measurement'; });
  var pmTrade = pm.perUc.find(function (u) { return u.name === 'Trade Promotion Optimization'; });
  var pmCtrl = pm.perUc.find(function (u) { return u.name === 'Supply Chain Control Tower'; });

  var panel = buildSharedPrereqsPanel();
  var panelText = panel ? panel.textContent : '';

  // synthesis unification: the SAME capabilities must appear in the synthesis context
  var syn = null; try { syn = buildSynthesisContext(); } catch (e) { syn = { error: String(e).slice(0, 160) }; }
  var synShared = (syn && syn.sharedGaps) ? syn.sharedGaps.map(function (g) { return { detail: g.detail, dim: g.dim, inits: (g.inits || []).slice() }; }) : null;
  var synDL = synShared ? synShared.find(function (g) { return /Unified data lake/.test(g.detail); }) : null;

  return { by, order, pmTrade, pmCtrl, panelText, synShared, synDL, synErr: (syn && syn.error) || null };
});

check('DL is a shared prerequisite for 3 use cases; RI/EF/RT are single-use',
  out.by['Unified data lake'] && out.by['Unified data lake'].count === 3 && out.by['Review ingestion'].count === 1 && out.by['Executive AI forum'].count === 1,
  JSON.stringify(out.by));
check('ranking is by reach then completion: DL → PM → FS',
  out.order.join(' > ') === 'Unified data lake > Closed-loop promotion measurement > Feature store', `order=${JSON.stringify(out.order)}`);
check('PM completes Trade Promotion (its last prerequisite), but not Control Tower',
  out.pmTrade && out.pmTrade.completes === true && out.pmCtrl && out.pmCtrl.completes === false,
  JSON.stringify({ trade: out.pmTrade, ctrl: out.pmCtrl }));
check('"still needs" names the specific remaining capabilities (Control Tower needs data lake + streaming)',
  out.pmCtrl && out.pmCtrl.remaining.indexOf('Unified data lake') >= 0 && out.pmCtrl.remaining.indexOf('Real-time streaming') >= 0,
  JSON.stringify(out.pmCtrl));
check('panel renders capability rows with reach + completion copy',
  /Prerequisite for 3 use cases/.test(out.panelText) && /Completes this pick/.test(out.panelText) && /still needs:/.test(out.panelText),
  `text=${out.panelText.slice(0, 160)}`);
check('SYNTHESIS uses the same canonical capabilities (not "Score X below required Y")',
  !out.synErr && out.synDL && out.synDL.inits.length === 3 && !/below required/i.test(JSON.stringify(out.synShared)),
  out.synErr ? `synErr=${out.synErr}` : `synDL=${JSON.stringify(out.synDL)}`);

await browser.close();
server.close();
let pass = 0, fail = 0;
console.log('\n  ROADMAP SHARED PREREQUISITES (canonical, panel + synthesis)\n  ' + '─'.repeat(64));
for (const r of results) { console.log(`  [${r.ok ? ' OK ' : 'FAIL'}] ${r.n}`); if (!r.ok) console.log(`         ${r.d}`); r.ok ? pass++ : fail++; }
if (pageErrors.length) { console.log('  page errors:'); pageErrors.slice(0, 6).forEach((e) => console.log('   - ' + e)); }
console.log('  ' + '─'.repeat(64) + `\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
