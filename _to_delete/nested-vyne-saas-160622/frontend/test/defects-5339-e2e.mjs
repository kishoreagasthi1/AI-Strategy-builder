/**
 * END-TO-END TEST for the six defects reported against v5.33.8 (fixed in 5.33.9).
 *
 *   node frontend/test/defects-5339-e2e.mjs
 *
 * These are NOT the 5.33.7 defects — they are un-fixed SIBLINGS of them in
 * different functions, plus two on genuinely new ground (a client-deck PII leak
 * and a cross-client interview-resume). Each case drives the REAL page function
 * against seeded state and reads the real result, so backing a fix out makes
 * exactly its case go red. The revert mapping is in the case names.
 *
 *   1  runAISynthesis guarded on the FLAT engagement.interviews while its body
 *      reads engagement.rounds — the main synthesis button refused a
 *      rounds-schema engagement. (sibling of the 5.33.7 drill-down guards)
 *   2  The client-deck appendix reloaded persona scores raw and printed the
 *      named individual, bypassing the redaction the rest of the deck applies.
 *   3  openDrillDown's conflict callout named both ends by role only — two
 *      people in one role rendered indistinguishably. (sibling of the fix in
 *      openConflictDrillDown)
 *   4  renderFocusTile sourced interviews from ALL rounds concatenated instead
 *      of getActiveRoundInterviews(), inventing conflicts by mixing a refreshed
 *      role's superseded round-1 score with its refresh.
 *   5  deckLoadPersonaScores kept only the GLOBAL max refreshRound, dropping any
 *      persona never re-interviewed in the latest refresh (comment says "per
 *      role"; code did "per deck").
 *   6  latestSession() returned the newest session across the WHOLE firm, so an
 *      invited interviewee's "Continue where you left off" could load another
 *      person's live interview (different client, full transcript).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DEFECT_PORT || 8947);

const results = [];
const check = (name, ok, detail = '') => {
  let v = false;
  try { v = typeof ok === 'function' ? ok() : ok; }
  catch (e) { v = false; detail = detail || `threw: ${String(e).slice(0, 200)}`; }
  results.push({ name, ok: !!v, detail });
};

/* ── Seeds ─────────────────────────────────────────────────────────────────
 * Values are JSON strings, exactly as the app writes them and vyneStore reads
 * them back (mirrors frontend/test/training/fixture.mjs). */

// Synthesis: rounds-schema, single round, two people in ONE role (D5 conflict).
const ENG_T = {
  code: 'ENG-T', client: 'Testco', industry: 'Logistics',
  rounds: [{
    roundId: 'r1', roundNumber: 1, label: 'Initial Diagnostic', type: 'initial',
    status: 'complete',
    interviews: [
      { role: 'VP_Operations', name: 'Ada', interviewee: 'Ada',
        scores: { D1: 3, D2: 3, D3: 3, D4: 3, D5: 4, D6: 3, D7: 3 }, findings: [] },
      { role: 'VP_Operations', name: 'Evan', interviewee: 'Evan',
        scores: { D1: 2, D2: 2, D3: 2, D4: 2, D5: 1.5, D6: 2, D7: 2 }, findings: [] },
    ],
  }],
};

// Focus-tile: TWO rounds. Round 2 (active) refreshes CEO only. All-rounds
// concatenation invents a D5 conflict (2,2,5); the active round (5) has none.
const ENG_F = {
  code: 'ENG-F', client: 'Focusco', industry: 'Logistics',
  rounds: [
    { roundId: 'f1', roundNumber: 1, label: 'Initial Diagnostic', type: 'initial', status: 'complete',
      interviews: [
        { role: 'CEO', name: 'Ada', interviewee: 'Ada', scores: { D1: 2, D2: 2, D3: 2, D4: 2, D5: 2, D6: 2, D7: 2 }, findings: [] },
        { role: 'CFO', name: 'Bob', interviewee: 'Bob', scores: { D1: 2, D2: 2, D3: 2, D4: 2, D5: 2, D6: 2, D7: 2 }, findings: [] },
      ] },
    { roundId: 'f2', roundNumber: 2, label: 'Round 2 — Refresh', type: 'refresh', status: 'complete',
      interviews: [
        { role: 'CEO', name: 'Ada', interviewee: 'Ada', refreshRound: 2, scores: { D1: 5, D2: 5, D3: 5, D4: 5, D5: 5, D6: 5, D7: 5 }, findings: [] },
      ] },
  ],
};

// Roadmap: flat list, Bob (CFO) refreshed to round 2, Ada (CEO) never refreshed.
// Per-role must keep BOTH; global-max drops Ada.
const ENG_R = {
  code: 'ENG-R', client: 'Refco', industry: 'Logistics',
  interviews: [
    { role: 'CEO', interviewee: 'Ada', name: 'Ada', refreshRound: 1, scores: { D1: 2, D2: 2, D3: 2, D4: 2, D5: 2, D6: 2, D7: 2 } },
    { role: 'CFO', interviewee: 'Bob', name: 'Bob', refreshRound: 1, scores: { D1: 3, D2: 3, D3: 3, D4: 3, D5: 3, D6: 3, D7: 3 } },
    { role: 'CFO', interviewee: 'Bob', name: 'Bob', refreshRound: 2, scores: { D1: 4, D2: 4, D3: 4, D4: 4, D5: 4, D6: 4, D7: 4 } },
  ],
};

const STATE = {
  vynora_engagement_index: JSON.stringify({ testco: 'ENG-T', focusco: 'ENG-F', refco: 'ENG-R' }),
  vynora_code_index: JSON.stringify({ 'ENG-T': 'Testco', 'ENG-F': 'Focusco', 'ENG-R': 'Refco' }),
  vynora_roadmap_index: JSON.stringify({ 'ENG-R': true }),
  'vynora_engagement_ENG-T': JSON.stringify(ENG_T),
  'vynora_engagement_ENG-F': JSON.stringify(ENG_F),
  'vynora_engagement_ENG-R': JSON.stringify(ENG_R),
};

// Interviewee bootstrap (defect 6): Ada @ Testco.
const BOOTSTRAP = {
  id: 'iv-ada', client_name: 'Testco', interviewee_name: 'Ada Lin',
  interviewee_role: 'CEO', status: 'invited', kind: 'initial', agenda: null,
  interviewer_name: 'Vera', interviewer_voice: 'Orus', round_number: 1, depth: 'deep',
};

/* ── Stub backend ─────────────────────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const body = (cb) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => cb(b)); };

  if (url.startsWith('/api/llm')) return body(() => json({ text: '{}', finishReason: 'stop', provider: 'stub', model: 'stub', usage: {} }));
  if (url.startsWith('/api/module-state/')) {
    if (req.method === 'PUT') return body(() => json({ ok: true, versions: {} }));
    return json({ module: 'workspace', state: STATE, versions: {} });
  }
  if (url === '/api/interviews/mine/bootstrap') return json({ interview: BOOTSTRAP, injected: STATE, own: {} });
  if (url === '/api/version') return json({ version: 'test', env: 'test' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'c@firm.com' });
  if (url === '/api/clients') return json({ clients: ['Testco', 'Focusco', 'Refco'] });
  if (url === '/api/my-clients') return json({ role: 'owner', clients: ['Testco', 'Focusco', 'Refco'] });
  if (url === '/api/team') return json({ members: [{ id: 'u1', email: 'c@firm.com', role: 'owner' }] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/interviews') return json({ interviews: [] });
  if (url === '/api/firms/team') return json({ members: [] });
  if (url === '/api/voice/voices') return json({ voices: [{ id: 'Orus', label: 'Orus' }] });
  if (url === '/api/scorecard') return json({ engagements: [], dimensionNames: {} });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try {
    const file = readFileSync(join(DIR, url === '/' ? 'index.html' : url), 'utf8');
    res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : url.endsWith('.css') ? 'text/css' : 'text/html' });
    res.end(file);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const pageErrors = [];

async function open(page_, session) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(`try{var s=${JSON.stringify(session)};s.at=Date.now();s.la=Date.now();
    sessionStorage.setItem('vyne_session', JSON.stringify(s));}catch(e){}`);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(page_ + ': ' + String(e).slice(0, 160)));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(`http://127.0.0.1:${PORT}/${page_}`);
  await page.waitForTimeout(1400);
  return { page, ctx };
}

const CONSULTANT = { token: 't', email: 'c@firm.com', role: 'owner', mode: 'dev', activeClient: 'Testco' };
const INTERVIEWEE = { token: 't', email: 'ada@testco.example', role: 'interviewee', mode: 'dev' };

/* ═══ synthesis.html — defects 1, 3, 4 ═══════════════════════════════════════ */
{
  const { page, ctx } = await open('synthesis.html', CONSULTANT);

  // Defect 1 — runAISynthesis accepts a rounds-schema engagement.
  const d1 = await page.evaluate(() => {
    loadEngagement('Testco');
    var k = document.getElementById('api-key'); if (k) k.value = 'test-key';
    var btn = document.getElementById('btn-synth'); if (btn) btn.disabled = false;
    try { runAISynthesis(); } catch (e) { return { pass: false, why: 'threw ' + e.message }; }
    // The guard returns BEFORE btn.disabled=true; if it passed, the button is disabled.
    return { pass: !!(btn && btn.disabled), interviews: (engagement && engagement.interviews) };
  });
  check('D1 runAISynthesis passes guard on rounds-schema (revert: flat-array guard trips)',
    d1.pass, `btn.disabled=${d1.pass}; engagement.interviews=${JSON.stringify(d1.interviews)}`);
  if (process.env.CAPTURE) console.log(`CAPTURE D1 :: proceeded past guard = ${d1.pass} (rounds-schema engagement, flat engagement.interviews = ${JSON.stringify(d1.interviews)})`);

  // Defect 3 — conflict callout disambiguates two people in one role.
  // Scoped to the callout element specifically: the per-role breakdown further
  // down the same modal prints names regardless, so reading all of #modal-body
  // would mask a reverted callout.
  const d3 = await page.evaluate(() => {
    loadEngagement('Testco');
    openDrillDown('D5');
    var el = document.querySelector('.conflict-callout-text');
    return { present: !!el, text: el ? el.textContent : '' };
  });
  check('D3 openDrillDown names both same-role people (Ada & Evan) in the conflict callout',
    d3.present && d3.text.includes('Ada') && d3.text.includes('Evan'),
    `callout=${d3.present}; Ada=${d3.text.includes('Ada')}; Evan=${d3.text.includes('Evan')}; text="${d3.text.slice(0, 120)}"`);
  if (process.env.CAPTURE) console.log(`CAPTURE D3 :: "${d3.text.split('.')[0]}."`);

  // Defect 4 — focus tile uses the active round, not all rounds concatenated.
  const d4 = await page.evaluate(() => {
    loadEngagement('Focusco');
    renderFocusTile();
    var t = (document.getElementById('remaining-questions') || {}).textContent || '';
    return { text: t };
  });
  check('D4 renderFocusTile (active round) invents NO cross-round conflict (revert: "Scoring Contradictions" appears)',
    d4.text.indexOf('Scoring Contradictions') === -1,
    `remaining-questions="${d4.text.replace(/\s+/g, ' ').slice(0, 140)}"`);
  if (process.env.CAPTURE) console.log(`CAPTURE D4 :: invents cross-round "Scoring Contradictions" section = ${d4.text.indexOf('Scoring Contradictions') !== -1} | tile="${d4.text.replace(/\s+/g, ' ').trim().slice(0, 110)}"`);

  await ctx.close();
}

/* ═══ roadmap.html — defects 2, 5 ════════════════════════════════════════════ */
{
  const { page, ctx } = await open('roadmap.html', { ...CONSULTANT, activeClient: 'Refco' });

  // Defect 5 — per-role latest: a never-refreshed role survives.
  const d5 = await page.evaluate(() => {
    var p = deckLoadPersonaScores();
    var roles = (p && p.interviews || []).map(function (i) { return i.role; });
    var cfo = (p && p.interviews || []).filter(function (i) { return i.role === 'CFO'; })[0];
    return { roles: roles, count: roles.length, cfoOverall: cfo && cfo.overall };
  });
  check('D5 deckLoadPersonaScores keeps the non-refreshed CEO AND the refreshed CFO (revert: CEO dropped)',
    d5.count === 2 && d5.roles.includes('CEO') && d5.roles.includes('CFO'),
    `roles=${JSON.stringify(d5.roles)}`);
  check('D5 refreshed CFO shows its round-2 score (4.0), not the superseded round-1 (3.0)',
    Math.abs((d5.cfoOverall || 0) - 4.0) < 0.01, `cfoOverall=${d5.cfoOverall}`);
  if (process.env.CAPTURE) console.log(`CAPTURE D5 :: personas in deck = ${JSON.stringify(d5.roles)} (${d5.count}); refreshed CFO overall = ${d5.cfoOverall}`);

  // Defect 2 is a client-deck-only PII leak inside the 26-slide PptxGenJS
  // export, which needs a fully-loaded synthesis to run — impractical to drive
  // headless here. It is revert-tested at the source level in
  // revert_defects_5339.py instead (the appendix must read the in-scope,
  // client-redacted personaScores, never a fresh deckLoadPersonaScores()).
  // Supporting behavioral fact: the raw persona data carries names at all —
  const d2 = await page.evaluate(() => {
    var p = deckLoadPersonaScores();
    return { names: (p && p.interviews || []).map(function (i) { return i.interviewee; }) };
  });
  check('D2 (support) raw persona load carries interviewee names — the PII the client-deck appendix must not reprint',
    d2.names.includes('Bob'), `names=${JSON.stringify(d2.names)}`);

  await ctx.close();
}

/* ═══ interview_agent.html — defect 6 ════════════════════════════════════════ */
{
  const { page, ctx } = await open('interview_agent.html', INTERVIEWEE);

  // Seed two sessions in the shared store: Ada (THIS interviewee, saved OLDER)
  // and Bob (a DIFFERENT client, saved NEWER). Then ask _vyneIvResume() which
  // one "Continue where you left off" targets.
  const d6 = await page.evaluate(() => {
    var mk = function (id, code, client, role, name, lastSaved) {
      return { sessionId: id, sessionCode: code, client: client, stakeholderRole: role,
               stakeholderName: name, lastSaved: lastSaved, questionsAsked: 3, messages: [], scores: {}, findings: [] };
    };
    vyneStore.setItem('vynora_session_idA', JSON.stringify(mk('idA', 'VYNE-AAAA-0001', 'Testco', 'CEO', 'Ada Lin', 1000)));
    vyneStore.setItem('vynora_session_idB', JSON.stringify(mk('idB', 'VYNE-BBBB-0002', 'Harbourline', 'CFO', 'Bob Marsh', 999999)));
    vyneStore.setItem('vynora_code_index', JSON.stringify({ 'VYNE-AAAA-0001': 'idA', 'VYNE-BBBB-0002': 'idB' }));

    if (typeof window._vyneIvResume !== 'function') return { pass: false, why: 'no _vyneIvResume (bootstrap did not render welcome)' };
    var captured = null;
    window.resumeFromCode = function () { captured = (document.getElementById('resume-code-input') || {}).value || null; };
    window._vyneIvResume();
    return { captured: captured };
  });
  check('D6 auto-resume targets THIS interviewee\'s own session (Ada), not the firm-wide newest (Bob) [revert: picks Bob]',
    d6.captured === 'VYNE-AAAA-0001', `captured=${d6.captured}${d6.why ? ' (' + d6.why + ')' : ''}`);
  if (process.env.CAPTURE) console.log(`CAPTURE D6 :: "Continue where you left off" targets code ${d6.captured} (Ada@Testco=VYNE-AAAA-0001, newer Bob@Harbourline=VYNE-BBBB-0002)`);

  await ctx.close();
}

await browser.close();
server.close();

/* ── Report ───────────────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
console.log('\n  DEFECTS 5.33.9 — behavioral checks\n  ' + '─'.repeat(70));
for (const r of results) {
  console.log(`  [${r.ok ? ' OK ' : 'FAIL'}] ${r.name}`);
  if (!r.ok || process.env.VERBOSE) console.log(`         ${r.detail}`);
  r.ok ? pass++ : fail++;
}
if (pageErrors.length) { console.log('\n  page errors:'); pageErrors.forEach((e) => console.log('   - ' + e)); }
console.log('  ' + '─'.repeat(70));
console.log(`  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
