/**
 * END-TO-END TEST for who a refresh interview is actually WITH
 * (interview_agent.html, v5.32.86).
 *
 *   node frontend/test/refresh-person-e2e.mjs
 *
 * WHY THIS EXISTS. One role can be held by several people — a client with
 * divisional COOs has three — and the whole refresh pipeline treated the role
 * string as an identity. The sharpest end of that was here:
 *
 *     stakeholderName: role.replace(/_/g,' ')
 *
 * so a round-2 refresh was recorded against an interviewee literally called
 * "COO". Not the wrong COO — no COO. The resulting row matches none of the
 * round-1 people, shares no login with them, and cannot be a follow-up of
 * either of their interviews.
 *
 * The second half is the prompt. `buildRefreshSystemPrompt` looked up
 * `round1Summaries[role]`, which Close Round wrote with a plain assignment
 * keyed by role, so it held whichever holder was written last. That block is
 * headed "YOUR OWN ROUND 1 VIEW" and is read to the person in the chair. The
 * code's own comment claimed "no other role's scores/findings ever appear here
 * (no cross-leakage)" — true between roles, false between two people in one.
 *
 * Both halves are asserted on what the page actually does, not on the
 * functions in isolation: the picker a consultant sees, and the session state
 * the interview runs on.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8801;

const results = [];
const check = (name, ok, detail = '') => {
  let v = false;
  try { v = typeof ok === 'function' ? ok() : ok; }
  catch (e) { v = false; detail = detail || `threw: ${String(e).slice(0, 120)}`; }
  results.push({ name, ok: !!v, detail });
};

/**
 * The agenda Close Round writes for an engagement with two divisional COOs who
 * disagreed with each other on D5, plus a CFO. byRole is present exactly as a
 * pre-v5.32.86 agenda would have it, so the fallback path is exercised by the
 * LEGACY fixture further down rather than by accident here.
 */
const AGENDA = {
  engagementCode: 'ACME01',
  clientName: 'Acme Industrial',
  roundClosed: 1,
  roundLabel: 'Round 1 — Initial Diagnostic',
  byRole: {
    COO: { isNewRole: false, agendaItems: [{ type: 'contradiction', dimension: 'D5', question: 'What explains the gap?' }] },
    CFO: { isNewRole: false, agendaItems: [{ type: 'hypothesis', dimension: 'D1', question: 'How would you assess it now?' }] },
  },
  byPerson: {
    'COO||Cara Diaz': { role: 'COO', person: 'Cara Diaz', label: 'COO (Cara Diaz)', isNewRole: false,
      agendaItems: [{ type: 'contradiction', dimension: 'D5', question: 'What explains the gap?' }] },
    'COO||Dev Rao': { role: 'COO', person: 'Dev Rao', label: 'COO (Dev Rao)', isNewRole: false,
      agendaItems: [{ type: 'contradiction', dimension: 'D5', question: 'What explains the gap?' }] },
    'CFO||Priya Sharma': { role: 'CFO', person: 'Priya Sharma', label: 'CFO', isNewRole: false,
      agendaItems: [{ type: 'hypothesis', dimension: 'D1', question: 'How would you assess it now?' }] },
  },
};

/** Round-1 records, per person. The two COOs scored D5 differently. */
const CONTEXT = {
  engagementCode: 'ACME01',
  round1Summaries: {
    'COO||Cara Diaz': { role: 'COO', name: 'Cara Diaz', scores: { D5: 2 }, findings: ['D5 handoffs between shifts are manual'] },
    'COO||Dev Rao': { role: 'COO', name: 'Dev Rao', scores: { D5: 4 }, findings: ['D5 the plant floor is largely automated'] },
    'CFO||Priya Sharma': { role: 'CFO', name: 'Priya Sharma', scores: { D1: 3 }, findings: ['D1 lineage is undocumented'] },
  },
  round1ByRole: {
    COO: { role: 'COO', name: 'Cara Diaz', scores: { D5: 2 }, findings: ['D5 handoffs between shifts are manual'] },
    CFO: { role: 'CFO', name: 'Priya Sharma', scores: { D1: 3 }, findings: ['D1 lineage is undocumented'] },
  },
  synthesisVerdicts: { hypothesisVerdict: [], blindSpots: [], strategicImplications: [] },
};

/** A pre-v5.32.86 agenda: byRole only, no person anywhere. Must still load. */
const LEGACY_AGENDA = {
  engagementCode: 'OLDC01',
  clientName: 'Legacy Co',
  roundClosed: 1,
  byRole: {
    COO: { isNewRole: false, agendaItems: [{ type: 'contradiction', dimension: 'D5', question: 'What explains the gap?' }] },
  },
};
const LEGACY_CONTEXT = {
  engagementCode: 'OLDC01',
  round1Summaries: {
    // Written the OLD way: keyed by role, and two COOs collapsed to one entry.
    COO: { role: 'COO', name: 'Cara Diaz', scores: { D5: 2 }, findings: ['D5 handoffs are manual'] },
  },
};

/**
 * The engagement memory (v5.32.88), derived at Close Round across ALL rounds.
 *
 * Shaped so the two things it exists for are both visible:
 *
 *   · Dev scored D5 in round 1 and took part in round 2 without revisiting it
 *     — so D5 is STALE for him and his 4/5 is being carried forward
 *   · Cara has a D5 trajectory (2 → 3) and was re-evidenced in round 2
 *
 * Cara appears here only so ambient/own separation can be asserted; the run
 * below is Dev's.
 */
const MEMORY = {
  code: 'ACME01', client: 'Acme Industrial', derivedAt: '2026-08-15T00:00:00.000Z',
  fromRounds: [1, 2], newestRound: 2, closedRound: 2,
  byPerson: {
    'COO||Dev Rao': {
      key: 'COO||Dev Rao', role: 'COO', person: 'Dev Rao', label: 'COO (Dev Rao)',
      roundsParticipated: [1, 2],
      byDimension: {
        D5: { score: 4, coverage: null, lastMeasuredRound: 1, roundsSinceMeasured: 1,
              stale: true, movement: null,
              trajectory: [{ round: 1, score: 4 }],
              latest: { round: 1, score: 4, coverage: null,
                        text: 'The plant floor is largely automated',
                        source: { roundId: 'r1', interviewId: 'iv-d1' } },
              history: [] },
        D1: { score: 3, coverage: 0.4, lastMeasuredRound: 2, roundsSinceMeasured: 0,
              stale: false, movement: null,
              trajectory: [{ round: 2, score: 3 }],
              latest: { round: 2, score: 3, coverage: 0.4,
                        text: 'Reporting is consolidated but slow',
                        source: { roundId: 'r2', interviewId: 'iv-d2' } },
              history: [] },
      },
    },
    'COO||Cara Diaz': {
      key: 'COO||Cara Diaz', role: 'COO', person: 'Cara Diaz', label: 'COO (Cara Diaz)',
      roundsParticipated: [1, 2],
      byDimension: {
        D5: { score: 3, coverage: 0.9, lastMeasuredRound: 2, roundsSinceMeasured: 0,
              stale: false, movement: 1,
              trajectory: [{ round: 1, score: 2 }, { round: 2, score: 3 }],
              latest: { round: 2, score: 3, coverage: 0.9,
                        text: 'CARA PRIVATE — shift handoffs are now logged in the MES',
                        source: { roundId: 'r2', interviewId: 'iv-c2' } },
              history: [] },
      },
    },
  },
  byDimension: {},
};

const WORKSPACE = {
  vynora_refresh_agenda_ACME01: JSON.stringify(AGENDA),
  vynora_refresh_context_ACME01: JSON.stringify(CONTEXT),
  vynora_memory_ACME01: JSON.stringify(MEMORY),
  vynora_refresh_agenda_OLDC01: JSON.stringify(LEGACY_AGENDA),
  vynora_refresh_context_OLDC01: JSON.stringify(LEGACY_CONTEXT),
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.startsWith('/api/module-state/') && req.method === 'PUT') {
    let b = ''; req.on('data', (c) => b += c); req.on('end', () => json({ ok: true, versions: {} }));
    return;
  }
  if (url.startsWith('/api/module-state/')) return json({ module: 'workspace', state: WORKSPACE, versions: {} });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return json({ userId: 'u1', role: 'consultant', email: 'c@firm.com' });
  if (url === '/api/interviews') return json({ interviews: [] });
  if (url === '/api/voice/voices') return json({ voices: [] });
  if (url === '/api/clients') return json({ clients: ['Acme Industrial'] });
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
await ctx.addInitScript(() => {
  try {
    sessionStorage.setItem('vyne_session', JSON.stringify({
      token: 'tok', email: 'c@firm.com', role: 'consultant', mode: 'dev', at: Date.now(), la: Date.now() }));
  } catch (e) {}
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForTimeout(1400);

/* ── The picker ─────────────────────────────────────────────────────────── */

const loaded = await page.evaluate(() => {
  const all = (typeof refreshAgendasAll !== 'undefined') ? refreshAgendasAll : [];
  const i = all.findIndex((a) => a.engagementCode === 'ACME01');
  if (i < 0) return { found: false, count: all.length };
  loadRefreshAgenda(i);
  const sel = document.getElementById('refresh-role-select');
  return {
    found: true,
    options: [...sel.options].map((o) => ({ value: o.value, text: o.textContent })),
  };
});

check('the agent finds the refresh agenda at all', loaded.found, JSON.stringify(loaded));
check('the picker offers one option per PERSON, not one per role',
  () => loaded.options.length === 3, JSON.stringify(loaded.options));
check('the two COOs are distinguishable in the list',
  () => loaded.options.filter((o) => /Cara Diaz|Dev Rao/.test(o.text)).length === 2,
  JSON.stringify(loaded.options.map((o) => o.text)));
/*
 * The label is only widened where it must be. Asserted on the label PART, not
 * on the whole option text: every option ends in " (Round 1 participant)" or
 * " (New Role)", so a naive /CFO \(/ matches that tag and reports the bare
 * role as disambiguated. Strip the tag first.
 */
const labelOf = (t) => String(t).replace(/\s*\((Round 1 participant|New Role)\)\s*$/, '').trim();
check('a role held by ONE person is still shown as the bare role',
  () => loaded.options.map((o) => labelOf(o.text)).includes('CFO'),
  JSON.stringify(loaded.options.map((o) => labelOf(o.text))));
check('and the person is not appended where the role already identifies them',
  () => !loaded.options.some((o) => /^CFO \(/.test(labelOf(o.text))),
  JSON.stringify(loaded.options.map((o) => labelOf(o.text))));

/* ── The interview the consultant actually starts ───────────────────────── */

const started = await page.evaluate(() => {
  const sel = document.getElementById('refresh-role-select');
  sel.value = 'COO||Dev Rao';
  const keyEl = document.getElementById('api-key-refresh') || document.getElementById('api-key');
  if (keyEl) keyEl.value = 'test-key';
  // Stop short of launching the interview UI; the assertion is about the
  // session state the interview would run on.
  const realLaunch = window.launchInterviewScreen;
  let launched = false;
  window.launchInterviewScreen = function () { launched = true; };
  try { startRefreshInterview(); } finally { window.launchInterviewScreen = realLaunch; }
  return {
    launched,
    stakeholderName: S.stakeholderName,
    stakeholderRole: S.stakeholderRole,
    displayLabel: S.stakeholderDisplayLabel,
    prompt: S.refreshSystemPrompt || '',
  };
});

check('starting a refresh actually starts one', started.launched, JSON.stringify(started));
check('the interviewee is a PERSON, not the role string',
  () => started.stakeholderName === 'Dev Rao', String(started.stakeholderName));
check('the role is still carried alongside the person',
  () => started.stakeholderRole === 'COO', String(started.stakeholderRole));

/* ── The prompt, which is where the leak was ────────────────────────────── */

check('the prompt gives this person THEIR OWN round-1 score',
  () => /you assessed this around 4\/5/.test(started.prompt),
  started.prompt.slice(0, 400));
check('and not the other COO\'s',
  () => !/you assessed this around 2\/5/.test(started.prompt),
  started.prompt.slice(0, 400));
check('nor the other COO\'s findings',
  () => !/handoffs between shifts are manual/i.test(started.prompt),
  started.prompt.slice(0, 600));
check('the persona line names the person too',
  () => /YOUR PERSONA: COO \(Dev Rao\)/.test(started.prompt),
  started.prompt.slice(0, 200));

/* ── Cumulative history and coverage (v5.32.88) ───────────────────────────
 *
 * `refreshCtxData` only ever carried the round just closed, so a round-3
 * interview knew nothing of round 1, and nothing told the agent whether an
 * unchanged score meant "we asked and it is the same" or "nobody asked". Both
 * come from the memory now.
 */
check('the prompt draws on every round the person took part in',
  () => /YOUR OWN HISTORY ON THIS ENGAGEMENT \(rounds 1, 2\)/.test(started.prompt),
  started.prompt.slice(0, 700));
check('a STALE dimension is called out as needing re-evidencing, not restating',
  () => /D5/.test(started.prompt) && /NOT revisited since/.test(started.prompt),
  started.prompt.slice(0, 900));
check('the round the score was last measured in is stated',
  () => /you assessed this around 4\/5 in round 1/.test(started.prompt),
  started.prompt.slice(0, 900));
check('a thinly-covered dimension is flagged to be probed properly',
  () => /only lightly evidenced last time/.test(started.prompt),
  started.prompt.slice(0, 900));
check('their own prior words are quoted back to them',
  () => /plant floor is largely automated/.test(started.prompt),
  started.prompt.slice(0, 900));
check('and NOBODY else\'s material is in there',
  () => !/CARA PRIVATE/.test(started.prompt) && !/Cara Diaz/.test(started.prompt),
  started.prompt.slice(0, 900));

/* ── A pre-v5.32.86 agenda must still work ──────────────────────────────── */

const legacy = await page.evaluate(() => {
  const all = (typeof refreshAgendasAll !== 'undefined') ? refreshAgendasAll : [];
  const i = all.findIndex((a) => a.engagementCode === 'OLDC01');
  if (i < 0) return { found: false };
  loadRefreshAgenda(i);
  const sel = document.getElementById('refresh-role-select');
  sel.value = 'COO';
  const keyEl = document.getElementById('api-key-refresh') || document.getElementById('api-key');
  if (keyEl) keyEl.value = 'test-key';
  const realLaunch = window.launchInterviewScreen;
  window.launchInterviewScreen = function () {};
  try { startRefreshInterview(); } finally { window.launchInterviewScreen = realLaunch; }
  return {
    found: true,
    options: [...sel.options].map((o) => o.value),
    stakeholderName: S.stakeholderName,
    prompt: S.refreshSystemPrompt || '',
  };
});

check('an agenda written before this version still loads', legacy.found, JSON.stringify(legacy));
check('a legacy agenda still offers its roles',
  () => legacy.options.length === 1 && legacy.options[0] === 'COO',
  JSON.stringify(legacy.options));
check('a legacy agenda falls back to the role for the name, rather than breaking',
  () => legacy.stakeholderName === 'COO', String(legacy.stakeholderName));
/*
 * The legacy context has ONE holder recorded for COO, so its round-1 history
 * is unambiguous and is supplied. The interesting case is the opposite one —
 * a legacy context with two holders — and the code declines there rather than
 * guessing. That branch is asserted in the unit layer; here the point is only
 * that an old agenda still runs.
 */
check('a legacy agenda with an unambiguous role still gets its history',
  () => /you assessed this around 2\/5/.test(legacy.prompt), legacy.prompt.slice(0, 300));

check('no uncaught page errors', errors.length === 0, errors.join(' | ').slice(0, 300));

await browser.close();
server.close();

console.log('\n=== REFRESH INTERVIEW: WHICH PERSON ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
