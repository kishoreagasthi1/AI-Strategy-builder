/**
 * END-TO-END TEST for the Maturity Targets tab (roadmap.html), v5.32.68.
 *
 * WHAT THIS TAB IS, AND WHAT THE FIRST VERSION GOT WRONG.
 *
 * Gap analysis next door answers "what do the use cases I selected require?".
 * This tab answers "we are at 2.6 on Data — what would it take to reach 3.7, or
 * 5.0?", which nothing in the product could answer.
 *
 * v5.32.67 shipped it as a score-keyed LADDER: a step at 3.0, then 3.5, then
 * 4.0. Two lies in one control. It implied a prerequisite chain that does not
 * exist — a firm can run a mature model-risk committee while its data catalogue
 * is a spreadsheet — and it implied maturity arrives in half points, next to
 * scores that are measured to one decimal because they come from a weighted
 * average over an interview. A rung labelled "3.5" is a number nobody measured.
 *
 * So the model is now a FLAT weighted list. No order, no dependency. Each gap
 * carries a weight in score points, and a dimension's weights sum to exactly
 * the distance from its current score to 5.0. That invariant is what makes the
 * projection legible, and most of what follows tests it directly.
 *
 * The two controls carry different meanings and must behave differently:
 *
 *   "we have this"      — the interview missed it. Corrects the CLIENT'S ACTUAL
 *                         score, and must therefore propagate everywhere the
 *                         score goes: the sliders, the matrix, the use-case gap
 *                         readiness. It is a correction to a measurement.
 *   "we would do this"  — prospective. Moves a PROJECTION and nothing else.
 *
 * Conflating the two would either silently inflate a client's assessed maturity
 * from a wish, or bury a real coverage gap in a hypothetical. Several tests
 * below exist only to hold them apart.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8810;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

/* An insurance client — deliberately NOT logistics, because the tab must never
 * fall back to another sector's content. D1 and D6 measured, the rest not. */
const WORKSPACE = {
  vynora_engagement_index: JSON.stringify({ meridianassurance: 'MER01' }),
  vynora_engagement_MER01: JSON.stringify({
    code: 'MER01', client: 'Meridian Assurance', industry: 'Insurance',
    currentRoundId: 'r1',
    rounds: [{
      roundId: 'r1', roundNumber: 1, label: 'Initial Diagnostic', status: 'complete',
      date: '2026-08-01',
      scores: { D1: 2.6, D6: 1.8 },
      benchmarks: { D1: { avg: 2.9, best: 3.7, laggard: 1.4 }, D6: { avg: 2.4, best: 3.5 } },
      benchmarkBasis: 'Estimated from the nearest well-documented sectors.',
      interviews: [],
    }],
  }),
  vynora_briefing_meridianassurance: JSON.stringify({
    client: 'Meridian Assurance', industry: 'Insurance',
    benchmarks: { D1: { avg: 2.9, best: 3.7, laggard: 1.4 }, D6: { avg: 2.4, best: 3.5 } },
    benchmarkBasis: 'Estimated from the nearest well-documented sectors.',
  }),
};

let llmCalls = [];

/* Weights that deliberately do NOT sum to the 2.4 budget (they sum to 2.0), so
 * the normalisation is exercised rather than accidentally satisfied. */
const MODEL_GAPS = [
  { text: 'Policy data catalogue', detail: 'A governed inventory of policy and claims data products with named owners.', weight: 0.5 },
  { text: 'Claims feature pipeline', detail: 'Automated feature engineering over claims history for underwriting models.', weight: 0.4 },
  { text: 'Reserving data lineage', detail: 'End-to-end lineage from source systems to actuarial reserving outputs.', weight: 0.3 },
  { text: 'Real-time exposure feeds', detail: 'Streaming exposure and bordereaux data rather than monthly batch.', weight: 0.8 },
];

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url.startsWith('/api/llm')) {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => {
      try { llmCalls.push(JSON.parse(b)); } catch { llmCalls.push({ raw: b }); }
      // The GATEWAY shape — {text, finishReason} — which vyne-client.js maps
      // into the Anthropic-looking object the page reads.
      json({
        text: JSON.stringify({ gaps: MODEL_GAPS }),
        finishReason: 'stop', provider: 'stub', model: 'stub',
        usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0 },
      });
    });
    return;
  }
  if (url === '/api/me') return json({ userId: 'u1', role: 'consultant', email: 'c@firm.com' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url.startsWith('/api/module-state/')) {
    if (req.method === 'PUT') { let b=''; req.on('data',c=>b+=c); req.on('end',()=>json({ ok:true, versions:{} })); return; }
    return json({ module: 'workspace', state: WORKSPACE, versions: {} });
  }
  if (url === '/api/clients') return json({ clients: ['Meridian Assurance'] });
  if (url === '/api/assignments') return json({ assignments: [] });
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
    token: 'tok', email: 'c@firm.com', role: 'consultant', mode: 'dev',
    at: Date.now(), la: Date.now() })); } catch (e) {}
`);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForTimeout(1800);

check('the roadmap page loaded and the tab exists',
  (await page.evaluate(`typeof renderTargetsTab`)) === 'function'
  && (await page.evaluate(`!!document.getElementById('tab-targets')`)),
  page.url());

// ── It LEADS. Verifying the scores comes before building on them ───────────
const ordering = await page.evaluate(`(() => {
  const tabs = [...document.querySelectorAll('.tab-bar .tab')].map(function(t){ return t.id; });
  return {
    tabs: tabs,
    first: tabs[0],
    defaultOn: document.getElementById('tab-targets').classList.contains('on'),
    defaultVisible: document.getElementById('view-targets').style.display !== 'none',
    gapNotDefault: document.getElementById('view-gap').style.display === 'none',
  };
})()`);
check('Maturity targets is the FIRST tab, before the use case matrix',
  ordering.first === 'tab-targets'
  && ordering.tabs.indexOf('tab-targets') < ordering.tabs.indexOf('tab-matrix'),
  ordering.tabs.join(' | '));
check('and it is what opens by default — scores get verified before use cases',
  ordering.defaultOn && ordering.defaultVisible && ordering.gapNotDefault,
  JSON.stringify(ordering));

const separation = await page.evaluate(`(() => {
  showTab('targets');
  return {
    targetsVisible: document.getElementById('view-targets').style.display !== 'none',
    gapHidden: document.getElementById('view-gap').style.display === 'none',
    tabOn: document.getElementById('tab-targets').classList.contains('on'),
  };
})()`);
check('the tab opens and is separate from Gap analysis',
  separation.targetsVisible && separation.gapHidden && separation.tabOn,
  JSON.stringify(separation));

// ── NO other industry's content, ever ───────────────────────────────────────
const beforeGen = await page.evaluate(`(() => {
  applyEngagementByCode('MER01');
  showTab('targets');
  const text = document.getElementById('targets-body').textContent;
  return {
    client: currentClientName,
    d1: maturityScores.D1,
    text,
    anyGaps: ['D1','D2','D3','D4','D5','D6','D7'].some(function(d){ return gapItems(d).length; }),
  };
})()`);
check('the engagement loaded with its measured scores',
  beforeGen.client === 'Meridian Assurance' && beforeGen.d1 === 2.6,
  JSON.stringify({ c: beforeGen.client, d1: beforeGen.d1 }));
check('nothing is shown until a list is generated for THIS industry',
  beforeGen.anyGaps === false && /No gap list for this dimension yet/.test(beforeGen.text),
  beforeGen.text.slice(0, 200));
check('no logistics content appears anywhere on the tab',
  !/ERP\/WMS|warehouse management|logistics/i.test(beforeGen.text),
  beforeGen.text.slice(0, 300));
check('it offers to generate for the client\'s own industry',
  beforeGen.text.indexOf('Generate for Insurance') >= 0
  || beforeGen.text.indexOf('Insurance') >= 0,
  beforeGen.text.slice(0, 300));

// ── The target defaults to the industry best from pre-engagement ───────────
const defaulted = await page.evaluate(`(() => {
  const eff = effectiveTarget('D1');
  const input = document.getElementById('tgt-in-D1');
  return {
    value: eff.value, source: eff.source,
    ownTarget: getMaturityTarget('D1'),
    inputValue: input ? input.value : null,
    text: document.getElementById('targets-body').textContent,
  };
})()`);
check('an untouched target defaults to the industry best for that dimension',
  // D1's benchmark best is 3.7 in the fixture.
  defaulted.value === 3.7 && defaulted.source === 'benchmark' && defaulted.inputValue === '3.7',
  JSON.stringify(defaulted));
check('the default is disclosed as the industry figure, not passed off as a decision',
  /industry best/.test(defaulted.text), defaulted.text.slice(0, 300));
check('defaulting does not silently write a target the consultant never set',
  defaulted.ownTarget === null, String(defaulted.ownTarget));

const overridden = await page.evaluate(`(() => {
  setMaturityTarget('D1', 4.2);
  renderTargetsTab();
  const eff = effectiveTarget('D1');
  return { value: eff.value, source: eff.source, text: document.getElementById('targets-body').textContent };
})()`);
check('a consultant\'s own number overrides the default and is labelled as theirs',
  overridden.value === 4.2 && overridden.source === 'consultant',
  JSON.stringify({ v: overridden.value, s: overridden.source }));

const noBenchmark = await page.evaluate(`(() => {
  // D3 has no benchmark in the fixture — the target must stay empty rather
  // than inventing one.
  return { eff: effectiveTarget('D3'), input: (document.getElementById('tgt-in-D3')||{}).value };
})()`);
check('a dimension with no benchmark gets no invented target',
  noBenchmark.eff.value === null && noBenchmark.input === '',
  JSON.stringify(noBenchmark));

await page.evaluate(`(() => { delete maturityTargets.D1; saveMaturityTargets(); renderTargetsTab(); })()`);

// ── Generate, and check the weight invariant ────────────────────────────────
const gen = await page.evaluate(`(async () => {
  vyneStore.setItem('vynora_api_key', 'test-key');
  await generateDimGaps('D1');
  const items = gapItems('D1');
  return {
    n: items.length,
    weights: items.map(function(i){ return i.weight; }),
    sum: Math.round(items.reduce(function(a,i){ return a + i.weight; }, 0) * 10) / 10,
    basedOn: dimGaps.D1.basedOnScore,
    industry: dimGaps.D1.industry,
    anyScoreKeyed: items.some(function(i){ return i.score !== undefined; }),
    text: document.getElementById('targets-body').textContent,
  };
})()`);
check('the generated gaps arrive as a list', gen.n === 4, String(gen.n));
check('the weights sum EXACTLY to the distance from the current score to 5.0',
  // 5.0 − 2.6 = 2.4. The model returned weights summing to 2.0; normalisation
  // is what closes that, and the invariant is the whole basis of the projection.
  gen.sum === 2.4, JSON.stringify({ weights: gen.weights, sum: gen.sum, basedOn: gen.basedOn }));
check('every weight is a real one-decimal quantity',
  gen.weights.every(function(w){ return w >= 0.1 && Math.abs(w * 10 - Math.round(w * 10)) < 1e-9; }),
  JSON.stringify(gen.weights));
check('no gap is keyed to a score level — the ladder is gone',
  gen.anyScoreKeyed === false, JSON.stringify(gen.weights));
check('the list is labelled as generated for this industry',
  gen.industry === 'Insurance' && gen.text.indexOf('generated for Insurance') >= 0,
  gen.industry);
check('the panel states the invariant rather than leaving it implicit',
  /weights sum to 2\.4/.test(gen.text), gen.text.slice(0, 400));

// ── The model was asked the right question ──────────────────────────────────
const prompt = JSON.stringify(llmCalls[0] || {});
check('the prompt carries the SAME scoring scale the interviews use',
  prompt.indexOf('1=Not Started, 2=Early/Ad Hoc, 3=Developing, 4=Advanced, 5=Leading/Optimized') >= 0);
check('the prompt tells the model to cover the whole way to 5.0',
  /do not stop at 4\.0/i.test(prompt));
check('the prompt forbids a ladder and forbids score-keyed items',
  /FLAT LIST, NOT A LADDER/.test(prompt) && /Do NOT key items to score levels/.test(prompt));
check('the prompt gives the model the industry benchmark for this dimension',
  /best-in-class 3\.7/.test(prompt), prompt.slice(0, 400));
check('and the benchmark calibration instruction the interviewer scores under',
  /requires deeper evidence/.test(prompt));

// ── "we would do this" moves a PROJECTION only ──────────────────────────────
const planned = await page.evaluate(`(() => {
  const items = gapItems('D1');
  const before = maturityScores.D1;
  toggleGapPlan('D1', items[0].id, true);
  toggleGapPlan('D1', items[2].id, true);
  return {
    actualUnchanged: maturityScores.D1 === before,
    planned: plannedWeight('D1'),
    text: document.getElementById('targets-body').textContent,
  };
})()`);
check('planning gaps does NOT touch the client\'s actual score',
  planned.actualUnchanged === true);
check('the projection is the sum of exactly the ticked weights',
  planned.planned === Math.round((gen.weights[0] + gen.weights[2]) * 10) / 10,
  JSON.stringify({ got: planned.planned, expect: gen.weights[0] + gen.weights[2] }));
check('the projected score is shown and labelled a projection',
  /projected/.test(planned.text) && /projection/.test(planned.text),
  planned.text.slice(0, 400));

// ── Non-adjacent selection: the list is not a hierarchy ─────────────────────
check('ticking the first and third but not the second is a valid state',
  // The whole reason for abandoning the ladder. Nothing may require anything.
  planned.planned > 0 && planned.actualUnchanged);

// ── Target reachability ─────────────────────────────────────────────────────
const reach = await page.evaluate(`(() => {
  setMaturityTarget('D1', 3.7);
  renderTargetsTab();
  const short = document.getElementById('targets-body').textContent;
  gapItems('D1').forEach(function(i){ toggleGapPlan('D1', i.id, true); });
  const all = document.getElementById('targets-body').textContent;
  return { short: short, all: all, projected: Math.round((maturityScores.D1 + plannedWeight('D1')) * 10) / 10 };
})()`);
check('a plan that falls short says by how much',
  /short of 3\.7/.test(reach.short), reach.short.slice(0, 400));
check('ticking every gap projects exactly 5.0 — the invariant, end to end',
  reach.projected === 5, String(reach.projected));
check('and it reports reaching the target',
  /reaches target 3\.7/.test(reach.all), reach.all.slice(0, 400));

// ── "we have this" CORRECTS the measured score and propagates ───────────────
const credited = await page.evaluate(`(() => {
  const items = gapItems('D1');
  const target = items[1];                       // 'Claims feature pipeline'
  const before = maturityScores.D1;
  const beforeSlider = (document.getElementById('score-D1')||{}).textContent;
  toggleGapCredit('D1', target.id, true);
  return {
    weight: target.weight,
    before: before,
    after: maturityScores.D1,
    base: baseScoreFor('D1'),
    beforeSlider: beforeSlider,
    afterSlider: (document.getElementById('score-D1')||{}).textContent,
    stillListed: gapItems('D1').some(function(i){ return i.id === target.id; }),
    outstanding: outstandingGaps('D1').some(function(i){ return i.id === target.id; }),
    outstandingSum: Math.round(outstandingGaps('D1').reduce(function(a,i){ return a+i.weight; },0)*10)/10,
    text: document.getElementById('targets-body').textContent,
  };
})()`);
check('crediting a gap raises the CLIENT\'S ACTUAL score by its weight',
  credited.after === Math.round((credited.before + credited.weight) * 10) / 10,
  JSON.stringify({ before: credited.before, w: credited.weight, after: credited.after }));
check('the measured base is kept separate from the correction',
  credited.base === 2.6, String(credited.base));
check('the score change reaches the maturity slider on the left',
  credited.afterSlider === credited.after.toFixed(1),
  credited.beforeSlider + ' → ' + credited.afterSlider);
check('a credited gap leaves the outstanding list',
  credited.outstanding === false && credited.stillListed === true);
check('the outstanding weights still sum to the distance to 5.0',
  // The invariant survives a credit without renormalising: the credit raises
  // current by w and removes w from the outstanding total.
  credited.outstandingSum === Math.round((5 - credited.after) * 10) / 10,
  JSON.stringify({ outstanding: credited.outstandingSum, expect: 5 - credited.after }));
check('the correction is disclosed rather than blended into the measurement',
  /credited/.test(credited.text), credited.text.slice(0, 400));

// ── Unticking reverses it exactly ───────────────────────────────────────────
const reversed = await page.evaluate(`(() => {
  const items = gapItems('D1');
  const target = items[1];
  toggleGapCredit('D1', target.id, false);
  return { score: maturityScores.D1, base: baseScoreFor('D1'), credited: creditedWeight('D1') };
})()`);
check('removing a credit restores the measured score exactly',
  reversed.score === 2.6 && reversed.credited === 0, JSON.stringify(reversed));

// ── Regenerating cannot silently keep ticks against vanished items ──────────
const regen = await page.evaluate(`(async () => {
  const items = gapItems('D1');
  toggleGapCredit('D1', items[0].id, true);
  toggleGapPlan('D1', items[1].id, true);
  const creditedBefore = creditedWeight('D1');
  await generateDimGaps('D1');
  return {
    creditedBefore: creditedBefore,
    creditedAfter: creditedWeight('D1'),
    plannedAfter: plannedWeight('D1'),
    score: maturityScores.D1,
  };
})()`);
check('regenerating drops ticks that referred to the old items',
  regen.creditedBefore > 0 && regen.creditedAfter === 0 && regen.plannedAfter === 0,
  JSON.stringify(regen));
check('and returns the score to what the interviews measured',
  regen.score === 2.6, String(regen.score));

// ── Persistence ─────────────────────────────────────────────────────────────
const persisted = await page.evaluate(`(() => {
  const items = gapItems('D1');
  toggleGapCredit('D1', items[0].id, true);
  setMaturityTarget('D6', 3.2);
  const saved = {
    gaps: JSON.parse(vyneStore.getItem(dimGapsKey())||'{}'),
    credits: JSON.parse(vyneStore.getItem(gapCreditsKey())||'{}'),
    targets: JSON.parse(vyneStore.getItem(targetsKey())||'{}'),
  };
  dimGaps = {}; gapCredits = {}; maturityTargets = {};
  loadDimGaps(); loadGapCredits(); loadMaturityTargets();
  return {
    savedItems: (saved.gaps.D1 && saved.gaps.D1.items || []).length,
    reloadedItems: gapItems('D1').length,
    reloadedCredit: creditedWeight('D1'),
    reloadedTarget: getMaturityTarget('D6'),
  };
})()`);
check('gaps, credits and targets survive a write and read back',
  persisted.savedItems === 4 && persisted.reloadedItems === 4
  && persisted.reloadedCredit > 0 && persisted.reloadedTarget === 3.2,
  JSON.stringify(persisted));

// ── Nothing renders raw markup ──────────────────────────────────────────────
const escaped = await page.evaluate(`(() => {
  dimGaps['D2'] = { industry: '<img src=x onerror=alert(1)>', generatedAt: null, basedOnScore: 2,
    items: [{ id: 'x1', text: '<script>bad()</scr'+'ipt>', detail: '<b>markup</b>', weight: 3 }] };
  renderTargetsTab();
  const el = document.getElementById('targets-body');
  return {
    noScript: el.querySelectorAll('script').length === 0,
    noImg: el.querySelectorAll('img').length === 0,
    noBold: el.querySelectorAll('b').length === 0,
    showsText: el.textContent.indexOf('<b>markup</b>') >= 0,
  };
})()`);
check('a model-supplied gap cannot inject markup',
  escaped.noScript && escaped.noImg && escaped.noBold && escaped.showsText,
  JSON.stringify(escaped));

check('roadmap.html threw nothing', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

console.log('\n=== MATURITY TARGETS END-TO-END ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n        ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
