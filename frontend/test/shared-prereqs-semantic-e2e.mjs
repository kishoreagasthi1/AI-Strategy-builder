/**
 * Shared Prerequisites — semantic grouping across use cases (v5.33.20).
 *
 *   node frontend/test/shared-prereqs-semantic-e2e.mjs
 *
 * Real engagements generate each use case's capabilities with unique wording, so
 * exact-text grouping finds nothing shared ("(1 use case)" everywhere). An LLM
 * clustering pass now groups look-alike capabilities across use cases into shared
 * THEMES, cached per engagement and re-run only when the capability set changes.
 * The gateway is stubbed to cluster by dimension so the outcome is deterministic.
 *
 * Scenario (maturity 2.0; differently-worded investments):
 *   A: D1 "Enterprise VoC Data Mart", D4 "CPG Data Science Upskilling"
 *   B: D1 "Real-Time Signal Feature Store", D4 "Dedicated NLP Data Science Capability"
 *   C: D4 "Embedded Domain Data Science"
 * Exact grouping → 5 lines, all count 1 (nothing shared).
 * Semantic grouping → D4 theme covers A,B,C (3); D1 theme covers A,B (2).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SEMPREREQ_PORT || 8977);
const results = [];
const check = (n, ok, d = '') => { let v = false; try { v = typeof ok === 'function' ? ok() : ok; } catch (e) { v = false; d = d || String(e).slice(0, 160); } results.push({ n, ok: !!v, d }); };

const nameUc = (id, name) => ({ id, name, desc: '', impact: 'high', value: 'x', phase: 'p1', requires: {}, deptName: 'X', subUcs: [] });
const CUSTOM = { ai_uc_a: nameUc('ai_uc_a', 'Sentiment Sensing'), ai_uc_b: nameUc('ai_uc_b', 'Demand Forecasting'), ai_uc_c: nameUc('ai_uc_c', 'Trend Detection') };
const STATE = {
  vynora_engagement_index: JSON.stringify({ testco: 'TST-1' }),
  'vynora_custom_ucs_eng_TST-1': JSON.stringify(CUSTOM),
};

// Gateway stub: for the clustering prompt, parse "cN (Ddim): text" and cluster by dimension.
function clusterByDim(content) {
  const re = /(c\d+) \((D[1-7])\):/g; let m; const byDim = {};
  while ((m = re.exec(content))) { (byDim[m[2]] = byDim[m[2]] || []).push(m[1]); }
  const names = { D1: 'Unified data foundation', D4: 'Embedded data-science talent' };
  return { clusters: Object.keys(byDim).map((d) => ({ theme: names[d] || (d + ' capability'), dim: d, detail: 'Shared ' + d + ' capability across use cases.', memberIds: byDim[d] })) };
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const body = (cb) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => cb(b)); };
  if (url.startsWith('/api/llm')) return body((raw) => {
    let content = ''; try { content = (JSON.parse(raw).messages || [])[0].content || ''; } catch (e) {}
    if (/Cluster them into SHARED/i.test(content)) return json({ text: JSON.stringify(clusterByDim(content)), finishReason: 'stop' });
    return json({ text: '{}', finishReason: 'stop' });
  });
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

const inv = (name) => ({ investment: name, detail: 'd', score: 3 });
const out = await page.evaluate(async () => {
  window._tempApiKey = 'test-key';
  currentClientName = 'Testco';
  rehydrateCustomUcs('eng_TST-1');
  maturityScores = { D1: 2, D2: 2, D3: 2, D4: 2, D5: 2, D6: 2, D7: 2 };
  ucReqOverrides = {
    ai_uc_a: { confirmed: true, complexity: 2, requires: { D1: 3, D4: 3 }, investments: { D1: [{ investment: 'Enterprise VoC Data Mart', detail: 'd', score: 3 }], D4: [{ investment: 'CPG Data Science Upskilling', detail: 'd', score: 3 }] } },
    ai_uc_b: { confirmed: true, complexity: 2, requires: { D1: 3, D4: 3 }, investments: { D1: [{ investment: 'Real-Time Signal Feature Store', detail: 'd', score: 3 }], D4: [{ investment: 'Dedicated NLP Data Science Capability', detail: 'd', score: 3 }] } },
    ai_uc_c: { confirmed: true, complexity: 2, requires: { D4: 3 }, investments: { D4: [{ investment: 'Embedded Domain Data Science', detail: 'd', score: 3 }] } },
  };
  selected = { ai_uc_a: true, ai_uc_b: true, ai_uc_c: true };

  // Before clustering: exact grouping finds nothing shared.
  var exactShared = computeSharedPrereqsExact().filter(function (l) { return l.count >= 2; }).length;

  // Run the clustering pass (deterministic via the stub).
  var info = collectSharedPrereqItems();
  var sig = sharedPrereqSignature(info.items);
  await generateSharedPrereqClusters(info, sig);

  var cached = !!sharedPrereqClusters();
  var lines = computeSharedPrereqs();
  var by = {}; lines.forEach(function (l) { by[l.name] = { count: l.count, ucIds: l.ucIds.slice() }; });
  var talent = lines.find(function (l) { return l.name === 'Embedded data-science talent'; });
  var panel = buildSharedPrereqsPanel();
  var panelText = panel ? panel.textContent : '';
  // signature stable on re-collect (cache would hit, no re-gen)
  var sig2 = sharedPrereqSignature(collectSharedPrereqItems().items);

  // PERFORMANCE FIX: moving a maturity slider must NOT invalidate the cache,
  // otherwise the LLM pass re-fires on every edit and saturates the backend.
  maturityScores.D4 = 4;                                  // D4 now met → its items no longer outstanding
  var stillFreshAfterSlider = !!sharedPrereqClusters();
  var sig3 = sharedPrereqSignature(collectSharedPrereqItems().items);
  var linesAfter = computeSharedPrereqs();
  var talentAfter = linesAfter.find(function (l) { return l.name === 'Embedded data-science talent'; });

  return {
    exactShared, cached, by, talentUcs: talent ? talent.ucIds.slice() : null, panelText,
    sigStable: sig === sig2, sigStableAfterSlider: sig === sig3,
    stillFreshAfterSlider, talentCountAfterSlider: talentAfter ? talentAfter.count : 0,
  };
});

check('exact-text grouping finds NOTHING shared (the real-world failure)',
  out.exactShared === 0, `exactShared=${out.exactShared}`);
check('the clustering result is cached and used',
  out.cached === true, `cached=${out.cached}`);
check('differently-worded data-science investments GROUP into one theme across A, B, C',
  out.talentUcs && out.talentUcs.slice().sort().join(',') === 'ai_uc_a,ai_uc_b,ai_uc_c',
  `talentUcs=${JSON.stringify(out.talentUcs)}`);
check('data-foundation theme is shared across the two use cases that need it',
  out.by['Unified data foundation'] && out.by['Unified data foundation'].count === 2, JSON.stringify(out.by['Unified data foundation']));
check('panel now shows the shared theme ("Prerequisite for 3 use cases")',
  /Prerequisite for 3 use cases/.test(out.panelText) && /Embedded data-science talent/.test(out.panelText),
  `text=${out.panelText.slice(0, 200)}`);
check('signature is stable — a warm cache would not re-run the LLM pass',
  out.sigStable === true, `sigStable=${out.sigStable}`);
check('PERF: moving a maturity slider does NOT invalidate the cache (no re-clustering)',
  out.sigStableAfterSlider === true && out.stillFreshAfterSlider === true,
  `sigStableAfterSlider=${out.sigStableAfterSlider} stillFresh=${out.stillFreshAfterSlider}`);
check('PERF: the panel still updates live — D4 now met, so the talent theme drops out',
  out.talentCountAfterSlider === 0, `talentCountAfterSlider=${out.talentCountAfterSlider}`);

await browser.close();
server.close();
let pass = 0, fail = 0;
console.log('\n  SHARED PREREQUISITES — SEMANTIC GROUPING\n  ' + '─'.repeat(64));
for (const r of results) { console.log(`  [${r.ok ? ' OK ' : 'FAIL'}] ${r.n}`); if (!r.ok) console.log(`         ${r.d}`); r.ok ? pass++ : fail++; }
if (pageErrors.length) { console.log('  page errors:'); pageErrors.slice(0, 6).forEach((e) => console.log('   - ' + e)); }
console.log('  ' + '─'.repeat(64) + `\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
