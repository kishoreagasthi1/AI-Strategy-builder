/**
 * END-TO-END TEST for chunked synthetic generation (interviews.html).
 *
 *   node frontend/test/synthetic-chunked-e2e.mjs
 *
 * WHY THIS EXISTS. The two defects this feature replaces are both invisible to
 * a backend test, because both are properties of how the BROWSER drives the
 * API rather than of what any single request returns:
 *
 *   • one persona failing must not discard the personas that succeeded, and
 *   • rounds must run in order, with round N carrying round N−1's findings.
 *
 * A source grep sees a loop. Only a real browser against a real page shows
 * whether the loop keeps going after a 502, what it puts in the second round's
 * request body, and what the consultant is told at the end.
 *
 * It also covers the v5.32.82 change that shipped with no regression test of
 * its own: a page-level 401 routing through vyneAuth.handleAuthFailure so an
 * expired session returns to login instead of surfacing as
 * "Generation failed: invalid_token".
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;

const results = [];
/**
 * `ok` may be a boolean or a thunk. A thunk is evaluated here and a throw is
 * recorded as a FAILURE rather than escaping — an assertion that reaches into
 * a shape the page did not produce (`r2[0].priorRound.every(...)` when
 * priorRound is missing) would otherwise take the whole process down with a
 * TypeError, and every check after it goes unreported. The suite exists to say
 * what broke; dying is the one outcome that says nothing.
 */
const check = (name, ok, detail = '') => {
  let value = false;
  try {
    value = typeof ok === 'function' ? ok() : ok;
  } catch (e) {
    value = false;
    detail = detail || `threw: ${String(e).slice(0, 120)}`;
  }
  results.push({ name, ok: !!value, detail });
};

const PERSONAS = [
  { index: 0, name: 'Victoria Hale', role: 'CEO' },
  { index: 1, name: 'Marcus Webb', role: 'VP Sales / Revenue' },
  { index: 2, name: 'Priya Sharma', role: 'CTO' },
];

/** Per-run server state, reset between scenarios. */
let personaCalls = [];
let commitBodies = [];
let failRule = () => null;   // (body) → null | {status, json}

const scored = (i) => ({
  D1: 2 + i * 0.1, D2: 2.4, D3: 3.1, D4: 2.0, D5: 2.5, D6: 1.4, D7: 2.6,
});

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  const readBody = (cb) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { cb(JSON.parse(b)); } catch { cb({}); } });
  };

  if (url === '/api/synthetic/personas' && req.method === 'POST') {
    return json({
      code: 'ACME-SYN1', clientName: 'Acme Industrial', industry: 'Manufacturing',
      personas: PERSONAS,
      rounds: [
        { round: 1, label: 'Initial Diagnostic', refresh: false },
        { round: 2, label: 'Refresh (6 months on)', refresh: true },
      ],
    });
  }

  if (url === '/api/synthetic/persona' && req.method === 'POST') {
    return readBody((body) => {
      personaCalls.push(body);
      const forced = failRule(body);
      if (forced) return json(forced.json, forced.status);
      const p = PERSONAS[body.personaIndex];
      json({
        persona: { name: p.name, role: p.role },
        round: body.round,
        roundLabel: body.round === 1 ? 'Initial Diagnostic' : 'Refresh (6 months on)',
        scores: scored(body.personaIndex),
        findings: [{ dimension: 'D1', text: 'Finding from ' + p.role + ' round ' + body.round }],
        summary: 's',
        transcript: [{ who: 'Interviewer', text: 'q', at: 1 }, { who: 'Interviewee', text: 'a', at: 2 }],
      });
    });
  }

  if (url === '/api/synthetic/commit' && req.method === 'POST') {
    return readBody((body) => {
      commitBodies.push(body);
      json({
        ok: true, code: 'ACME-SYN1', clientName: body.clientName,
        interviews: body.results.length,
        rounds: Math.max.apply(null, body.results.map((r) => r.round)),
        chunked: true,
      });
    });
  }

  if (url === '/api/interviews' && req.method === 'GET') return json({ interviews: [] });
  if (url === '/api/voice/voices') return json({ voices: [] });
  if (url.startsWith('/api/module-state/')) return json({ module: 'workspace', state: {} });
  if (url === '/api/me') return json({ userId: 'u1', role: 'consultant', email: 'c@firm.com' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/firms/team') return json({ members: [] });
  if (url === '/api/clients') return json({ clients: ['Acme Industrial'] });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  try {
    const body = readFileSync(join(DIR, url === '/' ? 'interviews.html' : url), 'utf8');
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
      at: Date.now(), la: Date.now(),
    }));
  } catch (e) {}
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

async function run({ refresh = true } = {}) {
  personaCalls = [];
  commitBodies = [];
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForTimeout(700);
  await page.fill('#syn-client', 'Acme Industrial');
  await page.evaluate((r) => { document.getElementById('syn-refresh').checked = r; }, refresh);
  await page.click('#syn-btn');
}

async function settled(pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(pred)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

/* ── 1. The happy path fans out and commits everything ─────────────────── */

failRule = () => null;
await run();
let ok = await settled(() => /Generated/.test(document.getElementById('syn-msg').textContent));
check('a full run reports success', ok, await page.textContent('#syn-msg'));
check('one request per persona per round, not one request total',
  personaCalls.length === 6, `${personaCalls.length} persona calls`);
check('exactly one commit', commitBodies.length === 1, `${commitBodies.length} commits`);
check('the commit carries every generated persona',
  () => commitBodies[0] && commitBodies[0].results.length === 6,
  JSON.stringify(commitBodies[0] && commitBodies[0].results.length));

/* ── 2. Rounds run in order, and round 2 carries round 1's findings ────── */

const firstRound2 = personaCalls.findIndex((c) => c.round === 2);
const lastRound1 = personaCalls.map((c) => c.round).lastIndexOf(1);
check('every round-1 call precedes every round-2 call',
  firstRound2 > lastRound1, `last r1 at ${lastRound1}, first r2 at ${firstRound2}`);

const r2 = personaCalls.filter((c) => c.round === 2);
check('round-2 requests carry a priorRound',
  r2.length === 3 && r2.every((c) => Array.isArray(c.priorRound) && c.priorRound.length === 3),
  JSON.stringify(r2.map((c) => (c.priorRound || []).length)));
check('the priorRound is round ONE\'s findings, not a placeholder',
  () => r2[0] && r2[0].priorRound.every((p) => /round 1$/.test(p.findings[0].text)),
  JSON.stringify(r2[0] && r2[0].priorRound));
check('round-1 requests carry no priorRound',
  personaCalls.filter((c) => c.round === 1).every((c) => c.priorRound === undefined));

/* ── 3. The Nissan case: one persona fails, the rest survive ──────────── */

failRule = (b) =>
  b.personaIndex === 1 && b.round === 1
    ? { status: 502, json: { error: 'persona_failed', category: 'parse_failed', role: 'VP Sales / Revenue', round: 1 } }
    : null;
await run();
ok = await settled(() => /Generated/.test(document.getElementById('syn-msg').textContent));
check('a failed persona does not abort the run', ok, await page.textContent('#syn-msg'));

const msgHtml = await page.innerHTML('#syn-msg');
check('the failure is named, with the role',
  /VP Sales \/ Revenue/.test(msgHtml), msgHtml.slice(0, 200));
check('the failure gives a reason a consultant can act on',
  /could not be parsed/.test(msgHtml), msgHtml.slice(0, 200));
check('the reason is the CATEGORY, never the model\'s own words',
  !/JSON|SyntaxError|token/i.test(msgHtml), msgHtml.slice(0, 200));
check('a retry control is offered', /id="syn-retry"|id='syn-retry'/.test(msgHtml));
check('the survivors are still committed',
  () => commitBodies.length === 1 && commitBodies[0].results.length === 5,
  JSON.stringify(commitBodies.map((c) => c.results.length)));
check('the failed persona is absent from the commit, not committed empty',
  () => commitBodies[0] && !commitBodies[0].results.some(
    (r) => r.persona.role === 'VP Sales / Revenue' && r.round === 1),
  JSON.stringify(commitBodies[0] && commitBodies[0].results.map((r) => r.persona.role + ':' + r.round)));
check('round 2 still ran for the personas that succeeded',
  () => commitBodies[0] && commitBodies[0].results.filter((r) => r.round === 2).length === 3,
  JSON.stringify(commitBodies[0] && commitBodies[0].results.filter((r) => r.round === 2).length));

/* ── 4. Retry re-runs only what failed, and re-commits the whole set ──── */

const beforeRetry = personaCalls.length;
failRule = () => null;
/*
 * Guarded rather than a bare page.click. A missing control throws a 30-second
 * Playwright timeout that kills the process, so the report for every check
 * after this point is never printed — a suite that dies mid-run reports
 * nothing about what it had not yet reached, which is the worst possible
 * behaviour for a suite whose job is to say what broke.
 */
const retryClicked = await page.click('#syn-retry', { timeout: 3000 }).then(() => true, () => false);
check('the retry control is actually clickable', retryClicked);
ok = retryClicked &&
  await settled(() => /Now \d+ interviews/.test(document.getElementById('syn-msg').textContent));
check('retry reports the new total', ok, await page.textContent('#syn-msg'));
check('retry re-runs ONLY the failed persona',
  personaCalls.length === beforeRetry + 1,
  `${personaCalls.length - beforeRetry} extra calls`);
check('retry re-commits the full set, so the earlier rows are not deleted',
  () => commitBodies.length === 2 && commitBodies[1].results.length === 6,
  JSON.stringify(commitBodies.map((c) => c.results.length)));

/* ── 5. Every persona in round 1 failing stops rather than faking round 2 ─ */

failRule = (b) =>
  b.round === 1
    ? { status: 502, json: { error: 'persona_failed', category: 'timeout', role: 'x', round: 1 } }
    : null;
await run();
ok = await settled(() => /Generation failed/.test(document.getElementById('syn-msg').textContent));
check('a totally failed round 1 is reported as a failure', ok, await page.textContent('#syn-msg'));
check('no round-2 call is made with nothing to follow on from',
  personaCalls.every((c) => c.round === 1),
  JSON.stringify(personaCalls.map((c) => c.round)));
check('nothing is committed when nothing generated', commitBodies.length === 0);

/* ── 6. The v5.32.82 change, which shipped with no test ───────────────── */

failRule = (b) => (b.round === 1 && b.personaIndex === 0
  ? { status: 401, json: { error: 'invalid_token' } } : null);
await run();
/*
 * Asserted on index.html specifically. The page under test is served at '/',
 * so a predicate that also accepts '/' is true before the click and true after
 * it — it would report this as held with the 401 handling deleted. The
 * redirect target is the only thing here that distinguishes the two worlds.
 */
const wentToLogin = await settled(() => /index\.html/.test(location.pathname), 6000);
const finalUrl = page.url();
const msgAfter401 = wentToLogin ? '' : await page.textContent('#syn-msg');
check('an expired session mid-run returns to login, not "Generation failed: invalid_token"',
  wentToLogin, `url=${finalUrl} msg=${msgAfter401}`);

check('no uncaught page errors', errors.length === 0, errors.join(' | ').slice(0, 300));

await browser.close();
server.close();

console.log('\n=== CHUNKED SYNTHETIC GENERATION END-TO-END ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
