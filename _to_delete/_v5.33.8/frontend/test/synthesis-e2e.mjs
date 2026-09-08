/**
 * END-TO-END TEST for the Synthesis Dashboard (synthesis.html).
 *
 *   node frontend/test/synthesis-e2e.mjs
 *
 * WHY THIS EXISTS. v5.32.59 replaced four hand-rolled implementations of the
 * scoring rules and three definitions of "latest round" with two shared
 * modules, and rewrote the corroborated-findings panel to cluster by CLAIM.
 * Every one of those changes is inside a page that no test had ever loaded.
 *
 * A source grep would have said all of it was done. Only a browser can say
 * whether the page still runs — whether VyneScoring is actually reachable from
 * synthesis.html's scope, whether the numbers it renders match the formula the
 * server persists, and whether planning an empty round still blanks a client.
 *
 * Every assertion below is a defect that shipped, not a hypothetical.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8797;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

/**
 * Acme, two rounds.
 *
 * Round 1: a CEO and a CTO, plus TWO COOs from different business units —
 * the F20 case. Both COOs have real names, so both must survive; the browser
 * used to dedupe on role alone and silently drop the second.
 *
 * Round 2: pinned as roundNumber 2 but pushed into the array FIRST, so the
 * array order is [2, 1] while the round order is [1, 2] — the F23 case that
 * became reachable when v5.32.55 let a consultant pin a round number.
 *
 * Findings are chosen to separate the three outcomes:
 *
 *   D1  two DIFFERENT roles, same claim, different wording   → corroborated
 *   D5  two people in ONE role saying the identical sentence → corroborated
 *       (v5.32.86; see below)
 *   D7  two different roles, genuinely different claims      → thematic
 *
 * The D5 case is the one this fixture used to describe wrongly. Its comment
 * said "two roles on DIFFERENT claims (thematic)", and the test asserted D5 as
 * the thematic tile — but Cara Diaz and Dev Rao make the IDENTICAL statement,
 * and the only reason it landed in thematic was the defect fixed in v5.32.86:
 * attribution deduped on the role string, so two COOs collapsed to one source
 * and their agreement was reported as "raised this area, not agreement". The
 * test was pinning the bug. D7 now carries the thematic case properly.
 */
const ENG = {
  code: 'ACME01',
  client: 'Acme Industrial',
  industry: 'Manufacturing',
  currentRoundId: 'r1',
  rounds: [
    {
      roundId: 'r2', roundNumber: 2, label: 'Q3 Refresh', type: 'refresh',
      status: 'active', interviews: [], scores: {},
    },
    {
      roundId: 'r1', roundNumber: 1, label: 'Initial Diagnostic', type: 'initial',
      status: 'complete', scores: {},
      interviews: [
        {
          role: 'CEO', interviewee: 'Ada Stone', name: 'Ada Stone', sourceInterviewId: 'iv-ceo',
          scores: { D1: 3, D3: 4, D5: 2, D7: 2 },
          findings: [
            { dimension: 'D1', text: 'Data lineage is undocumented across finance systems' },
            { dimension: 'D5', text: 'Approval policy requires three separate signatures' },
            { dimension: 'D7', text: 'Change fatigue is high after two ERP programmes' },
          ],
        },
        {
          role: 'CTO', interviewee: 'Ben Wu', name: 'Ben Wu', sourceInterviewId: 'iv-cto',
          scores: { D1: 5, D2: 4, D7: 3 },
          findings: [
            { dimension: 'D1', text: 'Lineage for our data is undocumented' },
            { dimension: 'D7', text: 'Engineers do not trust the deployment process' },
          ],
        },
        {
          role: 'COO', interviewee: 'Cara Diaz', name: 'Cara Diaz', sourceInterviewId: 'iv-coo-a',
          scores: { D5: 2 },
          findings: [{ dimension: 'D5', text: 'Handoffs between shifts are manual' }],
        },
        {
          role: 'COO', interviewee: 'Dev Rao', name: 'Dev Rao', sourceInterviewId: 'iv-coo-b',
          scores: { D5: 4 },
          findings: [{ dimension: 'D5', text: 'Handoffs between shifts are manual' }],
        },
      ],
    },
  ],
};

/**
 * Newco exercises the FLAT-LIST MIGRATION path, which is where the role-only
 * dedupe actually lived (F20). A record with a flat `interviews` array AND a
 * rounds array is what every pre-rounds engagement looks like after an import,
 * and the sync loop that folds one into the other is the code that used to
 * drop the second COO on the floor.
 *
 * Two COOs with different names, and one repeat of the SAME person (same
 * sourceInterviewId) which must NOT produce a duplicate row.
 */
const ENG2 = {
  code: 'NEWC01',
  client: 'Newco Ltd',
  industry: 'Logistics',
  interviews: [
    { role: 'COO', interviewee: 'Eve Park', name: 'Eve Park', sourceInterviewId: 'nv-1',
      scores: { D5: 2 }, findings: [] },
    { role: 'COO', interviewee: 'Finn Ash', name: 'Finn Ash', sourceInterviewId: 'nv-2',
      scores: { D5: 4 }, findings: [] },
    { role: 'COO', interviewee: 'Eve Park', name: 'Eve Park', sourceInterviewId: 'nv-1',
      scores: { D5: 2 }, findings: [] },
  ],
  rounds: [
    { roundId: 'n1', roundNumber: 1, label: 'Initial Diagnostic', type: 'initial',
      status: 'active', interviews: [], scores: {} },
  ],
};

/**
 * A PERSISTED synthesis for Acme, and deliberately none for Newco.
 *
 * This is the shape v5.32.60's synthetic generator writes, and the shape any
 * real engagement carries after its first synthesis run — which means it is
 * also the shape every engagement is in after a page RELOAD. Newco has none, so
 * the two clients distinguish "a stored synthesis exists" from "it does not".
 */
const STORED_SYNTHESIS = {
  savedAt: 1786000000000,
  synthesis: {
    hypothesisVerdict: [
      { hypothesis: 'Data fragmentation blocks AI scale-up', verdict: 'confirmed', evidence: 'CEO and CTO described the same condition on D1.' },
    ],
    blindSpots: [{ topic: 'AI governance ownership', whyItMatters: 'Nobody owns it.', whoShouldAddress: ['CEO'] }],
    strategicImplications: ['Consolidate before scaling.'],
  },
};

const WORKSPACE = {
  vynora_engagement_index: JSON.stringify({ acmeindustrial: 'ACME01', newcoltd: 'NEWC01' }),
  vynora_engagement_ACME01: JSON.stringify(ENG),
  vynora_engagement_NEWC01: JSON.stringify(ENG2),
  vynora_synthesis_full_ACME01: JSON.stringify(STORED_SYNTHESIS),
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
  if (url === '/api/clients') return json({ clients: ['Acme Industrial', 'Newco Ltd'] });
  if (url === '/api/interviews') return json({ interviews: [] });
  if (url === '/api/firms/team') return json({ members: [] });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  try {
    const body = readFileSync(join(DIR, url === '/' ? 'synthesis.html' : url), 'utf8');
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
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForTimeout(1500);

// ── The shared modules must actually be reachable from the page ─────────────
const modules = await page.evaluate(() => ({
  scoring: typeof window.VyneScoring === 'object' && typeof window.VyneScoring.computeRoundScores === 'function',
  findings: typeof window.VyneFindings === 'object' && typeof window.VyneFindings.corroborateFindings === 'function',
  roleWeight: typeof window.vyneRoleWeight === 'function',
}));
check('vyne-scoring.js is loaded and exposes the formula', modules.scoring);
check('vyne-findings.js is loaded and exposes the corroboration rule', modules.findings);
check('vyneRoleWeight is still reachable for injection', modules.roleWeight);

// ── Load the engagement the way a consultant does ───────────────────────────
await page.evaluate(() => {
  document.getElementById('client-input').value = 'Acme Industrial';
  loadEngagement();
});
await page.waitForTimeout(1200);

const state = await page.evaluate(() => {
  const e = engagement;
  const byNum = (n) => (e.rounds || []).find((r) => r.roundNumber === n);
  return {
    loaded: !!e,
    code: e && e.code,
    r1Interviews: (byNum(1).interviews || []).length,
    r1Names: (byNum(1).interviews || []).map((i) => i.interviewee),
    r1Scores: byNum(1).scores,
    r2Scores: byNum(2).scores,
    latestRoundId: window.VyneScoring.latestRound(e.rounds).roundId,
    latestScoredId: (window.VyneScoring.latestScoredRound(e.rounds) || {}).roundId,
  };
});

check('the engagement loaded', state.loaded && state.code === 'ACME01', JSON.stringify(state.code));

// ── F20: two COOs, both kept (stored-rounds path) ───────────────────────────
check('two people in the same role are both kept, not deduped by role',
  state.r1Interviews === 4, `${state.r1Interviews} interviews: ${state.r1Names.join(', ')}`);
check('both COOs are present by name',
  state.r1Names.includes('Cara Diaz') && state.r1Names.includes('Dev Rao'), state.r1Names.join(', '));

// ── F6: the number on screen is the number the formula says ─────────────────
const formula = await page.evaluate(() => {
  const e = engagement;
  const r1 = e.rounds.find((r) => r.roundNumber === 1);
  return window.VyneScoring.computeRoundScores(r1.interviews, { roleWeight: window.vyneRoleWeight }).scores;
});
check('round 1 D1 matches the canonical formula',
  state.r1Scores.D1 === formula.D1, `stored ${state.r1Scores.D1} vs formula ${formula.D1}`);
check('round 1 D5 matches the canonical formula (both COOs counted)',
  state.r1Scores.D5 === formula.D5, `stored ${state.r1Scores.D5} vs formula ${formula.D5}`);
check('scores are stored at one decimal place, not two',
  Object.values(state.r1Scores).every((v) => v == null || Math.abs(v * 10 - Math.round(v * 10)) < 1e-9),
  JSON.stringify(state.r1Scores));

// ── F21/F22: a planned, un-interviewed round must not be stamped with scores ─
check('the planned empty round is still the latest round',
  state.latestRoundId === 'r2', state.latestRoundId);
check('the latest SCORED round skips the empty planned round',
  state.latestScoredId === 'r1', String(state.latestScoredId));
check('the empty planned round was NOT stamped with the prior round\'s scores',
  Object.keys(state.r2Scores || {}).length === 0, JSON.stringify(state.r2Scores));

// ── F23: array order [2, 1] must not decide which round is latest ───────────
const ordering = await page.evaluate(() => {
  const e = engagement;
  return {
    arrayOrder: e.rounds.map((r) => r.roundNumber),
    sorted: window.VyneScoring.sortRounds(e.rounds).map((r) => r.roundNumber),
  };
});
check('the stored array really is out of numeric order (else this proves nothing)',
  ordering.arrayOrder[0] === 2, JSON.stringify(ordering.arrayOrder));
check('rounds resolve in numeric order regardless of array order',
  JSON.stringify(ordering.sorted) === '[1,2]', JSON.stringify(ordering.sorted));

// ── F13: corroboration is about the claim, not the dimension ────────────────
const panel = await page.evaluate(() => {
  const list = document.getElementById('confirmed-list');
  const tiles = [...list.querySelectorAll('.synth-sec-hdr')].map((h) => h.textContent.trim());
  return { html: list.innerHTML, tiles };
});
const corroboratedTiles = panel.tiles.filter((t) => /sources agree/.test(t));
const thematicTile = panel.tiles.find((t) => /raised this area/.test(t));
check('a claim two roles actually made is shown as agreement',
  corroboratedTiles.some((t) => /D1/.test(t)), panel.tiles.join(' || '));
check('a dimension two roles raised on DIFFERENT points is not shown as agreement',
  !!thematicTile && /D7/.test(thematicTile), panel.tiles.join(' || '));
check('the thematic tile says in English that it is not agreement',
  /not agreement/i.test(panel.html));
check('D7 does not appear as a corroborated tile',
  !corroboratedTiles.some((t) => /D7/.test(t)), corroboratedTiles.join(' || '));

/* ── One role, two people (v5.32.86) ──────────────────────────────────────
 *
 * Cara Diaz and Dev Rao are both COOs of different divisions and make the
 * IDENTICAL statement about manual shift handoffs. That is the strongest
 * evidence an engagement can produce: two executives, independently, word for
 * word.
 *
 * It used to be reported as "2 roles raised this area" — explicitly NOT
 * agreement — because attribution deduped on the role string and two COOs
 * became one source. And the tile that did appear said "COO", which cannot
 * tell a consultant which of the two divisions was speaking.
 */
check('two people in ONE role saying the same thing is agreement, not just a shared area',
  corroboratedTiles.some((t) => /D5/.test(t)), panel.tiles.join(' || '));
check('the attribution names BOTH COOs, since "COO and COO agree" says nothing',
  /Cara Diaz/.test(panel.html) && /Dev Rao/.test(panel.html),
  panel.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 220));
check('a role held by ONE person is still shown as the bare role',
  /(^|[^(])\bCEO\b/.test(panel.html.replace(/<[^>]+>/g, ' ')) && !/CEO \(/.test(panel.html),
  panel.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 220));

// ── F20 on the MIGRATION path: this is where the role-only dedupe lived ─────
await page.evaluate(() => {
  document.getElementById('client-input').value = 'Newco Ltd';
  loadEngagement();
});
await page.waitForTimeout(1200);

const newco = await page.evaluate(() => {
  const e = engagement;
  const r = (e.rounds || [])[0] || {};
  return {
    code: e && e.code,
    names: (r.interviews || []).map((i) => i.interviewee),
    count: (r.interviews || []).length,
    d5: (r.scores || {}).D5,
  };
});
check('the migration-path engagement loaded', newco.code === 'NEWC01', String(newco.code));
check('the flat list folded BOTH COOs into the round, not just the first',
  newco.count === 2, `${newco.count}: ${newco.names.join(', ')}`);
check('both names survived the fold',
  newco.names.includes('Eve Park') && newco.names.includes('Finn Ash'), newco.names.join(', '));
check('the SAME person listed twice did not become two rows',
  newco.names.filter((n) => n === 'Eve Park').length === 1, newco.names.join(', '));
check('the round average reflects both COOs, not one',
  newco.d5 === 3, `D5 = ${newco.d5} (both: 3, first only: 2)`);

// ── Nothing threw ───────────────────────────────────────────────────────────
/* ── Close Round reachable from a STORED synthesis (v5.32.85) ──────────────
 *
 * The button is display:none in the markup, is hidden AND disabled again on
 * every engagement load, and was shown by exactly one call to
 * updateCloseRoundBtn() — the one after a LIVE synthesis parses. So a
 * consultant who reloaded the page, or opened a synthetic engagement (which
 * ships with a persisted synthesis precisely so no billed call is needed),
 * could not close a round at all.
 *
 * That is not one button. Close Round is the ONLY writer of
 * vynora_refresh_agenda_<CODE>, and that key is the only thing the interview
 * agent's Refresh Interview tab reads — so the whole refresh flow was
 * unreachable from a reloaded page.
 *
 * Asserted through the page, on the button a consultant actually clicks,
 * rather than on the function: the defect was never in updateCloseRoundBtn(),
 * it was in nothing calling it.
 */
await page.evaluate(() => {
  document.getElementById('client-input').value = 'Acme Industrial';
  loadEngagement();
});
await page.waitForTimeout(1200);

const crAcme = await page.evaluate(() => {
  const b = document.getElementById('btn-close-round');
  return b ? { present: true, hidden: b.style.display === 'none', disabled: !!b.disabled } : { present: false };
});
check('Close Round is offered on an engagement with a STORED synthesis',
  crAcme.present && !crAcme.hidden && !crAcme.disabled, JSON.stringify(crAcme));

// Newco has no stored synthesis, so it must stay hidden — the suppression has
// to still work, or this "fix" just shows the button unconditionally.
await page.evaluate(() => {
  document.getElementById('client-input').value = 'Newco Ltd';
  loadEngagement();
});
await page.waitForTimeout(1200);

const crNewco = await page.evaluate(() => {
  const b = document.getElementById('btn-close-round');
  return b ? { hidden: b.style.display === 'none', disabled: !!b.disabled } : { hidden: true, disabled: true };
});
check('Close Round stays hidden when there is NO synthesis to close on',
  crNewco.hidden || crNewco.disabled, JSON.stringify(crNewco));

/*
 * And the reason that assertion needs a SECOND client at all (v5.32.85).
 *
 * The synthesis state lived in page-load globals that nothing cleared when the
 * consultant switched engagement: lastSynthesisResult (which drives the
 * Unresolved Hypotheses and Blind Spots sections AND is what Close Round bakes
 * into the refresh agenda), synthesisBoxHydrated (which gates the box, so once
 * true it never re-read storage), and _parsedSynthesisForReport (the .docx
 * fallback). Loading Acme then Newco left Newco's dashboard showing Acme's
 * synthesis under Newco's name.
 *
 * Newco has no stored synthesis of its own, so ANY synthesis content on screen
 * here came from Acme. That is the whole test: the page must be blank, not
 * plausible.
 */
const leak = await page.evaluate(() => ({
  boxText: (document.getElementById('synthesis-box') || {}).textContent || '',
  focusText: (document.getElementById('focus-tile') || document.body).textContent || '',
  inMemory: typeof lastSynthesisResult === 'object' && lastSynthesisResult
    ? JSON.stringify(lastSynthesisResult) : '',
  noteShown: ((document.getElementById('synthesis-saved-note') || {}).style || {}).display === 'block',
}));
check('switching client does not leave the previous client\'s synthesis in the box',
  !/Data fragmentation blocks AI scale-up/.test(leak.boxText),
  leak.boxText.slice(0, 160));
check('switching client does not leave it in memory for Close Round to bake in',
  !/Data fragmentation blocks AI scale-up/.test(leak.inMemory),
  leak.inMemory.slice(0, 160));
check('switching client does not leave the previous client\'s blind spot on screen',
  !/AI governance ownership/.test(leak.focusText),
  leak.focusText.slice(0, 160));
check('the "saved synthesis" note does not carry over to a client with none',
  !leak.noteShown, String(leak.noteShown));

/* ── Close Round routes the agenda to PEOPLE (v5.32.86) ────────────────────
 *
 * Acme's round 1 has two divisional COOs, Cara Diaz and Dev Rao, who disagree
 * with each other on D5 (2 vs 4). Everything in the refresh pipeline used to be
 * keyed by role:
 *
 *   · the agenda was byRole, so a contradiction involving ONE of three COOs
 *     was routed to "COO" and pulled in the two who agreed
 *   · round1Summaries[role] was a plain assignment, so the second COO
 *     overwrote the first and one person's whole round-1 record was lost —
 *     and that map is read back to the round-2 interviewee under the heading
 *     "YOUR OWN ROUND 1 VIEW"
 *
 * Asserted on the payload Close Round actually writes, because that payload is
 * the entire contract between this page and the interview agent.
 */
await page.evaluate(() => {
  document.getElementById('client-input').value = 'Acme Industrial';
  loadEngagement();
});
await page.waitForTimeout(1200);

const agenda = await page.evaluate(() => {
  confirmCloseRound(1);
  return {
    agenda: JSON.parse(vyneStore.getItem('vynora_refresh_agenda_ACME01') || 'null'),
    ctx: JSON.parse(vyneStore.getItem('vynora_refresh_context_ACME01') || 'null'),
  };
});

check('Close Round writes a refresh agenda at all', !!agenda.agenda,
  String(agenda.agenda));
check('the agenda is keyed by PERSON, not only by role',
  !!(agenda.agenda && agenda.agenda.byPerson && Object.keys(agenda.agenda.byPerson).length),
  JSON.stringify(agenda.agenda && Object.keys(agenda.agenda.byPerson || {})));
check('byRole survives for agendas the agent may already hold',
  !!(agenda.agenda && agenda.agenda.byRole && Object.keys(agenda.agenda.byRole).length));

const people = agenda.agenda ? Object.values(agenda.agenda.byPerson || {}) : [];
const coos = people.filter((p) => p.role === 'COO');
check('both COOs get their own agenda entry, not one shared "COO" entry',
  coos.length === 2, JSON.stringify(people.map((p) => p.role + '/' + p.person)));
check('each COO entry names the person',
  coos.every((p) => p.person && /Cara Diaz|Dev Rao/.test(p.person)),
  JSON.stringify(coos.map((p) => p.person)));
check('the D5 contradiction reached BOTH people who actually disagreed',
  coos.every((p) => (p.agendaItems || []).some((it) => it.type === 'contradiction' && it.dimension === 'D5')),
  JSON.stringify(coos.map((p) => (p.agendaItems || []).map((i) => i.type + ':' + i.dimension))));

/* The round-1 record, per person. With the old role key one of these two was
 * simply gone, and the survivor was read back to whichever COO sat round 2. */
const summaries = agenda.ctx ? agenda.ctx.round1Summaries || {} : {};
const cooSummaries = Object.values(summaries).filter((v) => v.role === 'COO');
check('both COOs keep their own round-1 record',
  cooSummaries.length === 2, JSON.stringify(Object.keys(summaries)));
check('and the two records are actually different people\'s',
  cooSummaries.length === 2 && cooSummaries[0].scores.D5 !== cooSummaries[1].scores.D5,
  JSON.stringify(cooSummaries.map((v) => v.name + ':' + JSON.stringify(v.scores))));

check('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();

console.log('\n=== SYNTHESIS DASHBOARD END-TO-END ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n        ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
