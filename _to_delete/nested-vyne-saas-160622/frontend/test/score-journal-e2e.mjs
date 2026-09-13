/**
 * END-TO-END TEST for the score journal (interview_agent.html).
 *
 *   node frontend/test/score-journal-e2e.mjs
 *
 * The capture half of v5.32.66. transcript-e2e.mjs proves the viewer renders a
 * trail; this proves there is a trail to render.
 *
 * The rule that matters is not "record the scores" — it is "record only the
 * MOVEMENTS". The interviewer model restates all seven dimensions after every
 * single turn, so a journal that wrote an entry per reported score would bury
 * the four real movements of an interview under three hundred restatements and
 * make the panel useless. That distinction is the whole design, and it is a
 * one-line condition that would be easy to lose in a refactor.
 *
 * Everything here drives the page's REAL applyScoreData and addFinding against
 * the page's real state object. A test that reimplemented the journalling rule
 * would pass with the feature deleted.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8808;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  // A CONSULTANT session, matching interview-live-e2e.mjs. The page redirects
  // to the launcher for a role with no assigned interview, and an interviewee
  // whose bootstrap 404s is exactly that case — the redirect would leave every
  // assertion below evaluating against index.html.
  if (url === '/api/me') return json({ userId: 'u1', role: 'consultant', email: 'c@firm.com' });
  if (url.startsWith('/api/module-state/')) return json({ module: 'workspace', state: {}, versions: {} });
  if (url === '/api/interviews/mine/bootstrap') { res.writeHead(404); res.end('{}'); return; }
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try {
    const body = readFileSync(join(DIR, url === '/' ? 'interview_agent.html' : url), 'utf8');
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
await page.waitForTimeout(1500);

// A redirect to the launcher would make every assertion below evaluate against
// the wrong page and pass or fail for reasons unrelated to the journal.
check('the interview agent page actually loaded',
  /interview_agent|\/$/.test(page.url()) && (await page.evaluate('typeof applyScoreData')) === 'function',
  page.url());

// ── The journal must exist on a fresh session ───────────────────────────────
const initial = await page.evaluate(`(() => ({
  hasScoreEvents: Array.isArray(S.scoreEvents),
  hasFindingEvents: Array.isArray(S.findingEvents),
  scoreEventsEmpty: (S.scoreEvents || []).length === 0,
}))()`);
check('a fresh session starts with an empty score journal',
  initial.hasScoreEvents && initial.hasFindingEvents && initial.scoreEventsEmpty,
  JSON.stringify(initial));

// ── Drive the REAL scoring path, exactly as a turn would ────────────────────
const journal = await page.evaluate(`(() => {
  // Four turns of a plausible interview. The model restates every dimension
  // each time; only three values ever actually change.
  S.displayMessages.push({ role: 'ai', text: 'Q1', at: Date.now() });
  applyScoreData({ scores: { D1: 2, D2: 0, D3: 0, D4: 0, D5: 0, D6: 0, D7: 0 } });

  S.displayMessages.push({ role: 'user', text: 'A1', at: Date.now() });
  applyScoreData({ scores: { D1: 2, D2: 0, D3: 0, D4: 0, D5: 0, D6: 0, D7: 0 } });

  S.displayMessages.push({ role: 'ai', text: 'Q2', at: Date.now() });
  applyScoreData({
    scores: { D1: 2, D2: 0, D3: 0, D4: 0, D5: 0, D6: 1.5, D7: 0 },
    finding: { dimension: 'D6', text: 'Nobody owns model governance.' },
  });

  S.displayMessages.push({ role: 'user', text: 'A2', at: Date.now() });
  applyScoreData({ scores: { D1: 2.5, D2: 0, D3: 0, D4: 0, D5: 0, D6: 1.5, D7: 0 } });

  return {
    events: S.scoreEvents.map(function(e){
      return e.dimension + ':' + (e.from === null ? '-' : e.from) + '>' + e.to + '@' + e.afterTurn;
    }),
    findingEvents: S.findingEvents,
    scores: S.scores,
    findings: S.findings,
  };
})()`);

check('only real movements are journalled, not every restatement',
  journal.events.length === 3, JSON.stringify(journal.events));
check('the movements are the right ones, in order',
  journal.events[0] === 'D1:->2@1'
  && journal.events[1] === 'D6:->1.5@3'
  && journal.events[2] === 'D1:2>2.5@4',
  JSON.stringify(journal.events));
check('a zero score is treated as no evidence and journals nothing',
  !journal.events.some(function(e){ return e.indexOf('D2') === 0 || e.indexOf('>0') > -1; }),
  JSON.stringify(journal.events));
check('each movement is anchored to the conversation position it happened at',
  journal.events[1] === 'D6:->1.5@3', JSON.stringify(journal.events));
check('the scorecard itself still ends up correct',
  journal.scores.D1 === 2.5 && journal.scores.D6 === 1.5, JSON.stringify(journal.scores));

check('a finding is journalled with its dimension and position',
  journal.findingEvents.length === 1
  && journal.findingEvents[0].dimension === 'D6'
  && journal.findingEvents[0].afterTurn === 3,
  JSON.stringify(journal.findingEvents));
check('the journalled finding matches the one the engagement record receives',
  journal.findings.length === 1
  && journal.findings[0].text === journal.findingEvents[0].text,
  JSON.stringify(journal.findings) + ' vs ' + JSON.stringify(journal.findingEvents));

// ── A repeated finding must not double-journal ──────────────────────────────
const dedup = await page.evaluate(`(() => {
  // The realtime path re-scores an OVERLAPPING window every 60s with no memory
  // of what it already reported, so the same finding legitimately arrives
  // several times. addFinding dedups; the journal must dedup with it, or the
  // transcript disagrees with the deliverable about what was found.
  addFinding({ dimension: 'D6', text: 'Nobody owns model governance.' });
  addFinding({ dimension: 'D6', text: 'Nobody owns model governance.' });
  return { findings: S.findings.length, findingEvents: S.findingEvents.length };
})()`);
check('a repeated finding is journalled once, matching the findings list',
  dedup.findings === 1 && dedup.findingEvents === 1, JSON.stringify(dedup));

// ── The journal must survive a save/restore ─────────────────────────────────
const roundTrip = await page.evaluate(`(() => {
  S.sessionId = S.sessionId || 'sess-journal-test';
  S.sessionCode = S.sessionCode || 'VYNE-JRNL-0001';
  saveSession();
  const raw = vyneStore.getItem('vynora_session_' + S.sessionId)
           || vyneStore.getItem(LS_PREFIX + S.sessionId);
  const saved = raw ? JSON.parse(raw) : null;
  return {
    found: !!saved,
    events: saved ? (saved.scoreEvents || []).length : -1,
    findingEvents: saved ? (saved.findingEvents || []).length : -1,
  };
})()`);
check('the journal is saved with the session, so a resume does not lose it',
  roundTrip.found && roundTrip.events === 3 && roundTrip.findingEvents === 1,
  JSON.stringify(roundTrip));

check('interview_agent.html threw nothing', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();

console.log('\n=== SCORE JOURNAL END-TO-END ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n        ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
