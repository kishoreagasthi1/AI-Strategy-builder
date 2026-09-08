/**
 * END-TO-END smoke + engagement-bridge test across every page v5.32.59 touched.
 *
 *   node frontend/test/pages-e2e.mjs
 *
 * WHY THIS EXISTS. v5.32.59 introduced two new shared scripts and rewired
 * eleven call sites across six HTML pages to use them. The single most likely
 * way to get that wrong is not a subtle scoring error — it is a page that
 * throws ReferenceError: VyneScoring is not defined on load, because the
 * script tag never landed in that file, and then silently renders a stale
 * screen because the exception was swallowed by a catch.
 *
 * A grep for `<script src="vyne-scoring.js">` proves the tag is in the file.
 * It does not prove the page runs. This loads each page in a real browser and
 * fails on any uncaught error.
 *
 * It also drives interview_agent.html's writeInterviewToEngagement() directly.
 * That function is the CONSULTANT-side bridge — it runs on every in-tab
 * interview completion, it writes round.scores, and until this release it
 * deduped interviews by ROLE ALONE. Two executives with the same title meant
 * the second one's scores and findings replaced the first's, with nothing
 * shown to anybody. It has never had a test.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8798;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const WORKSPACE = {
  vynora_engagement_index: JSON.stringify({ acmeindustrial: 'ACME01' }),
  vynora_engagement_ACME01: JSON.stringify({
    code: 'ACME01', client: 'Acme Industrial', industry: 'Manufacturing',
    currentRoundId: 'r1',
    rounds: [
      { roundId: 'r2', roundNumber: 2, label: 'Q3 Refresh', type: 'refresh',
        status: 'active', interviews: [], scores: {} },
      { roundId: 'r1', roundNumber: 1, label: 'Initial Diagnostic', type: 'initial',
        status: 'complete', interviews: [
          { role: 'CEO', interviewee: 'Ada Stone', name: 'Ada Stone', scores: { D3: 4 }, findings: [] },
        ], scores: { D3: 4 } },
    ],
  }),
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url.startsWith('/api/module-state/') && req.method === 'PUT') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => json({ ok: true, versions: {} }));
    return;
  }
  if (url.startsWith('/api/module-state/')) return json({ module: 'workspace', state: WORKSPACE, versions: {} });
  if (url === '/api/me') return json({ userId: 'u1', role: 'consultant', email: 'c@firm.com' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/clients') return json({ clients: ['Acme Industrial'] });
  if (url === '/api/interviews') return json({ interviews: [] });
  if (url === '/api/firms/team') return json({ members: [] });
  if (url === '/api/scorecard') return json({ engagements: [], dimensionNames: {} });
  if (url === '/api/voice/voices') return json({ voices: [] });
  if (url === '/api/billing/summary') return json({ months: [], clients: [] });
  if (url === '/api/subscription') return json({ plan: 'pro', status: 'active' });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  try {
    const body = readFileSync(join(DIR, url === '/' ? 'index.html' : url), 'utf8');
    res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : 'text/html' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  try {
    sessionStorage.setItem('vyne_session', JSON.stringify({
      token: 'tok', email: 'c@firm.com', role: 'consultant', mode: 'dev',
      at: Date.now(), la: Date.now() }));
  } catch (e) {}
});

// ── Every page that was rewired must load clean and see both modules ────────
const PAGES = [
  'synthesis.html', 'roadmap.html', 'interview_agent.html', 'interviews.html',
  'solution_design.html', 'pre_engagement.html', 'scorecard.html', 'index.html',
];
for (const p of PAGES) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/${p}`);
  await page.waitForTimeout(900);
  const mods = await page.evaluate(() => ({
    scoring: !!(window.VyneScoring && window.VyneScoring.computeRoundScores),
    findings: !!(window.VyneFindings && window.VyneFindings.corroborateFindings),
  }));
  check(`${p} loads with no uncaught errors`, errors.length === 0, errors.join(' | '));
  check(`${p} can reach VyneScoring and VyneFindings`, mods.scoring && mods.findings,
    JSON.stringify(mods));
  await page.close();
}

// ── The consultant-side bridge: two executives, one job title ───────────────
const agent = await ctx.newPage();
const agentErrors = [];
agent.on('pageerror', (e) => agentErrors.push(String(e)));
await agent.goto(`http://127.0.0.1:${PORT}/interview_agent.html`);
await agent.waitForTimeout(1200);

const bridge = await agent.evaluate(() => {
  // Start from a clean engagement so this test owns the record it asserts on.
  vyneStore.setItem('vynora_engagement_index', JSON.stringify({}));

  const run = (name, role, scores) => {
    S.client = 'Bridge Test Co';
    S.industry = 'Manufacturing';
    S.stakeholderName = name;
    S.stakeholderRole = role;
    S.scores = scores;
    S.findings = [];
    S.isRefreshMode = false;
    S.eventContext = null;
    S.sessionId = 'sess-' + name.replace(/\W/g, '');
    writeInterviewToEngagement();
  };

  run('Gail Ito', 'COO', { D5: 2 });
  run('Hugo Best', 'COO', { D5: 4 });      // different person, same title
  run('Gail Ito', 'COO', { D5: 3 });       // same person again — must REPLACE

  const idx = JSON.parse(vyneStore.getItem('vynora_engagement_index') || '{}');
  const code = idx['bridgetestco'];
  const eng = JSON.parse(vyneStore.getItem('vynora_engagement_' + code) || 'null');
  const r1 = (eng.rounds || [])[0] || {};
  return {
    names: (r1.interviews || []).map((i) => i.interviewee),
    count: (r1.interviews || []).length,
    d5: (r1.scores || {}).D5,
    formulaD5: window.VyneScoring.computeRoundScores(r1.interviews, { roleWeight: window.vyneRoleWeight }).scores.D5,
  };
});

check('the bridge keeps two different people who share a job title',
  bridge.count === 2, `${bridge.count}: ${bridge.names.join(', ')}`);
check('both names are present after the bridge wrote',
  bridge.names.includes('Gail Ito') && bridge.names.includes('Hugo Best'), bridge.names.join(', '));
check('re-running the SAME person replaces rather than duplicating',
  bridge.names.filter((n) => n === 'Gail Ito').length === 1, bridge.names.join(', '));
check('the bridge stored the score the canonical formula gives',
  bridge.d5 === bridge.formulaD5, `stored ${bridge.d5} vs formula ${bridge.formulaD5}`);
check('and that score reflects BOTH people (3.5), not one of them',
  bridge.d5 === 3.5, `D5 = ${bridge.d5}`);
check('the interview agent page threw nothing while doing it',
  agentErrors.length === 0, agentErrors.join(' | '));

await browser.close();
server.close();

console.log('\n=== PAGE LOAD + ENGAGEMENT BRIDGE END-TO-END ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n        ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
