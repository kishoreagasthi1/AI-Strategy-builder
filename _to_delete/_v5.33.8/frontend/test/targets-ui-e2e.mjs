/**
 * END-TO-END TEST for three Maturity Targets UI defects (roadmap.html, v5.32.73).
 *
 *   node frontend/test/targets-ui-e2e.mjs
 *
 * All three are the same species: the tab became the FIRST tab in v5.32.68, and
 * the code around it still assumed it was one of the later ones.
 *
 *   1. BLANK ON ARRIVAL. view-targets ships display:block and tab-targets ships
 *      class="tab on", but the body was only ever filled by showTab('targets').
 *      Nothing calls showTab on a fresh load, so the tab the consultant lands on
 *      was empty until they clicked away to Use cases and back. The existing
 *      maturity-targets-e2e.mjs suite never caught this because every one of its
 *      43 assertions calls showTab() or applyEngagementByCode() first — it tests
 *      the tab's behaviour, never its arrival.
 *
 *   2. "GENERATE ALL" VANISHED. The bulk button was gated on `!anyGaps`, so
 *      generating one dimension hid it for the other six and left no route back
 *      to the bulk action.
 *
 *   3. THE HEADING SHOUTED. An <h2> — the only one in the file — restating the
 *      tab's own name in browser-default bold directly against the sticky tab
 *      bar. No other tab panel has a heading at all.
 *
 * The first assertion here is the load-order one, and it must run before
 * anything touches showTab. Ordering is load-bearing in this file.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8814;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const WORKSPACE = {
  vynora_engagement_index: JSON.stringify({ meridianassurance: 'MER01' }),
  vynora_engagement_MER01: JSON.stringify({
    code: 'MER01', client: 'Meridian Assurance', industry: 'Insurance',
    currentRoundId: 'r1',
    rounds: [{
      roundId: 'r1', roundNumber: 1, label: 'Initial Diagnostic', status: 'complete',
      date: '2026-08-01',
      scores: { D1: 2.6, D6: 1.8 },
      benchmarks: { D1: { avg: 2.9, best: 3.7 }, D6: { avg: 2.4, best: 3.5 } },
      interviews: [],
    }],
  }),
  vynora_briefing_meridianassurance: JSON.stringify({
    client: 'Meridian Assurance', industry: 'Insurance',
    benchmarks: { D1: { avg: 2.9, best: 3.7 }, D6: { avg: 2.4, best: 3.5 } },
  }),
};

const MODEL_GAPS = [
  { text: 'Policy data catalogue', detail: 'Governed inventory with named owners.', weight: 0.8 },
  { text: 'Claims feature pipeline', detail: 'Automated features over claims history.', weight: 0.7 },
  { text: 'Reserving data lineage', detail: 'Lineage to actuarial outputs.', weight: 0.9 },
];

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.startsWith('/api/llm')) {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => json({
      text: JSON.stringify({ gaps: MODEL_GAPS }), finishReason: 'stop',
      provider: 'stub', model: 'stub', usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0 },
    }));
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
/* The engagement is the session's active client, so the page auto-loads it at
   boot — which is the code path the blank-tab bug lived in. */
await ctx.addInitScript(`
  try {
    sessionStorage.setItem('vyne_session', JSON.stringify({
      token: 'tok', email: 'c@firm.com', role: 'consultant', mode: 'dev',
      activeClient: 'Meridian Assurance', at: Date.now(), la: Date.now() }));
  } catch (e) {}
`);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForTimeout(1800);

// ── 1. THE TAB YOU LAND ON MUST NOT BE BLANK ───────────────────────────────
// Nothing below this point may call showTab or applyEngagementByCode until the
// assertion has been taken — that call is exactly what used to mask the bug.
const onArrival = await page.evaluate(`(() => {
  const body = document.getElementById('targets-body');
  return {
    tabIsOn: document.getElementById('tab-targets').classList.contains('on'),
    viewVisible: document.getElementById('view-targets').style.display !== 'none',
    bodyChildren: body ? body.children.length : -1,
    text: body ? body.textContent.trim().slice(0, 120) : '',
    rows: document.querySelectorAll('#targets-body .tgt-row').length,
  };
})()`);
check('Maturity targets is the tab you land on',
  onArrival.tabIsOn && onArrival.viewVisible, JSON.stringify(onArrival));
check('and it has CONTENT on arrival, with no tab-switching first',
  onArrival.bodyChildren > 0 && onArrival.text.length > 0,
  JSON.stringify(onArrival));
check('specifically, all seven dimension rows are drawn at boot',
  onArrival.rows === 7, 'rows=' + onArrival.rows);

/* v5.32.79: an engagement with SELECTED USE CASES — i.e. any engagement anyone
   has actually worked on — used to be redirected straight to Gap analysis by
   applyEngagementByCode, so the first tab was the default in the markup and
   almost never the tab a consultant landed on. This is the case that was
   missing: the checks above load an engagement with no selections. */
const withSelections = await page.evaluate(`(() => {
  selected = { ins_u1: true, ins_u2: true };
  applyEngagementByCode('MER01');
  return {
    onTab: [...document.querySelectorAll('.tab-bar .tab')].filter(function(t){
      return t.classList.contains('on'); }).map(function(t){ return t.id; }),
    targetsVisible: document.getElementById('view-targets').style.display !== 'none',
    gapRendered: (document.getElementById('view-gap').textContent || '').length > 0,
  };
})()`);
check('an engagement WITH selections still lands on the first tab',
  withSelections.onTab.length === 1 && withSelections.onTab[0] === 'tab-targets'
  && withSelections.targetsVisible, JSON.stringify(withSelections));
check('and Gap analysis is still rendered, just not navigated to',
  withSelections.gapRendered, 'gap body length > 0: ' + withSelections.gapRendered);

// ── 2. THE HEADING IS QUIET, AND CLEAR OF THE TAB BAR ──────────────────────
const heading = await page.evaluate(`(() => {
  const el = document.querySelector('#view-targets .tgt-title');
  const h2 = document.querySelectorAll('#view-targets h2').length;
  if(!el) return { missing: true, h2 };
  const cs = getComputedStyle(el);
  const tabBar = document.querySelector('.tab-bar').getBoundingClientRect();
  return {
    missing: false, h2,
    text: el.textContent.trim(),
    fontSize: parseFloat(cs.fontSize),
    fontWeight: Number(cs.fontWeight),
    marginTop: parseFloat(cs.marginTop),
    gapBelowTabs: Math.round(el.getBoundingClientRect().top - tabBar.bottom),
  };
})()`);
check('the tab still names itself, just quietly',
  !heading.missing && heading.text === 'Maturity targets', JSON.stringify(heading));
check('it is no longer an h2 shouting the tab’s own name back at it',
  heading.h2 === 0, 'h2 count = ' + heading.h2);
check('the type is close to the tab bar’s own 13px, not a display heading',
  heading.fontSize <= 14, 'fontSize=' + heading.fontSize);
check('and not heavy — under the 700 an h2 defaults to',
  heading.fontWeight < 700, 'fontWeight=' + heading.fontWeight);
check('there is real space between the tab bar and the text',
  heading.gapBelowTabs >= 12,
  'gap=' + heading.gapBelowTabs + 'px, marginTop=' + heading.marginTop);

// ── 3. THE BULK BUTTON SURVIVES THE FIRST DIMENSION ────────────────────────
/* `.tgt-gen-all`, NOT `.tgt-gen`: the latter is also on every row's Generate,
   Regenerate and Clear, so a bare `.tgt-gen` selector silently matched whatever
   came first in the DOM. The final assertion below caught it — it reported the
   bulk button as still present when what it had found was a row's Regenerate. */
const before = await page.evaluate(`(() => {
  applyEngagementByCode('MER01');
  showTab('targets');
  const btn = document.querySelector('#targets-body .tgt-gen-all');
  return { present: !!btn, label: btn ? btn.textContent.trim() : null,
           withGaps: ['D1','D2','D3','D4','D5','D6','D7'].filter(function(d){ return gapItems(d).length; }).length };
})()`);
check('with nothing generated, the bulk button offers all seven',
  before.present && /seven/i.test(before.label || ''), JSON.stringify(before));

await page.evaluate(`generateDimGaps('D1')`);
await page.waitForTimeout(2500);

const after = await page.evaluate(`(() => {
  const btn = document.querySelector('#targets-body .tgt-gen-all');
  return {
    present: !!btn,
    label: btn ? btn.textContent.trim() : null,
    note: document.querySelector('#targets-body .tgt-note') ? document.getElementById('targets-body').textContent : '',
    withGaps: ['D1','D2','D3','D4','D5','D6','D7'].filter(function(d){ return gapItems(d).length; }).length,
  };
})()`);
check('D1 actually generated, so the next assertion means something',
  after.withGaps === 1, 'dimensions with gaps = ' + after.withGaps);
check('THE BUG: the bulk button is STILL there after one dimension',
  after.present === true, JSON.stringify({ present: after.present, label: after.label }));
check('and it now offers the six that remain, not all seven again',
  /remaining 6/i.test(after.label || ''), 'label = ' + after.label);
check('the note says which dimensions are still missing',
  /6 of 7/.test(after.note) && /D2/.test(after.note) && !/^.*\bD1\b.*dimensions have no gap list/.test(after.note.split('\n')[0] || ''),
  after.note.slice(0, 200));

// ── the button must eventually go away, or it is just noise ────────────────
const all = await page.evaluate(`(async () => {
  await generateAllDimGaps();
  const btn = document.querySelector('#targets-body .tgt-gen-all');
  return { present: !!btn,
           withGaps: ['D1','D2','D3','D4','D5','D6','D7'].filter(function(d){ return gapItems(d).length; }).length };
})()`);
check('once every dimension has a list, the button is gone',
  all.withGaps === 7 && all.present === false, JSON.stringify(all));

check('roadmap.html threw nothing', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();

console.log('\n=== MATURITY TARGETS UI END-TO-END ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n        ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
