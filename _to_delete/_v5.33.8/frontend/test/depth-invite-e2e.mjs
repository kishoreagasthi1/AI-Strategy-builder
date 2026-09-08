/**
 * END-TO-END: the consultant's INTERVIEW DEPTH reaches the interviewee (v5.33.8).
 *
 *   node frontend/test/depth-invite-e2e.mjs
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * Depth — the question budget the agent works to, and therefore how long a
 * client executive sits in the chair — was a `<select>` on interview_agent.html's
 * setup screen. That screen is hidden outright for interviewees, and the choice
 * was persisted to nothing: no workspace key, no column, no field on the invite.
 *
 * Probed in a real browser before the fix, and this is the whole finding:
 *
 *     CONSULTANT chose Quick Screen -> persisted where?  {} — nowhere
 *     INTERVIEWEE (after consultant chose Quick):  S.depth "deep", budget 50
 *
 * So every distributed interview ran as a 40–50 question Deep Dive whatever the
 * consultant selected, and the preview sheet's estimate could be wrong by an
 * hour — always long.
 *
 * ── What this proves, and what it does not ─────────────────────────────────
 *
 * It drives the REAL interviews.html invite form and the REAL interview_agent.html
 * interviewee path against a stub that stores what the route stores. It does not
 * prove the SQL is right — vyneDepth.test.ts pins the arithmetic and migration
 * 028 carries the column — but it does prove the chain the defect lived in:
 * form → POST body → interview row → bootstrap → S.depth → question budget.
 *
 * REVERT TESTS
 *   · delete `S.depth = VyneDepth.normalize(iv.depth)` from interview_agent.html
 *     → "the interviewee's session runs to the consultant's depth" fails,
 *       reporting deep/50 for a quick-screen invite. That is the original bug,
 *       reproduced.
 *   · drop `body.depth` from createInvite() in interviews.html
 *     → "the invite carries the chosen depth" fails.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8863;

const results = [];
const check = (name, ok, detail = '') => {
  let v = false;
  try { v = typeof ok === 'function' ? ok() : ok; }
  catch (e) { v = false; detail = detail || `threw: ${String(e).slice(0, 140)}`; }
  results.push({ name, ok: !!v, detail });
};

const CLIENT = 'Northwind Freight Group';
const NORM = 'northwindfreightgroup';
const CODE = 'NWF01';

/* The interview table, as far as this test is concerned. `depth` defaults to
 * 'deep' exactly as migration 028 does, so an invite that sends nothing
 * produces the row the product produced before the column existed. */
let ROWS = [];
let POSTED = [];
let PATCHED = [];

function resetRows() {
  ROWS = [];
  POSTED = [];
  PATCHED = [];
}

const WORKSPACE = () => ({
  vynora_engagement_index: JSON.stringify({ [NORM]: CODE }),
  ['vynora_engagement_' + CODE]: JSON.stringify({
    code: CODE, client: CLIENT, industry: 'Logistics',
    currentRoundId: 'r1',
    rounds: [{ roundId: 'r1', roundNumber: 1, label: 'Initial Diagnostic',
               status: 'active', interviews: [], scores: {} }],
  }),
  ['vynora_briefing_' + NORM]: JSON.stringify({
    client: CLIENT, industry: 'Logistics',
    roleCatalog: [
      { value: 'CEO', display: 'CEO / Executive Leadership' },
      { value: 'CTO', display: 'CTO / Head of Technology' },
    ],
    selectedRoles: ['CEO', 'CTO'],
  }),
});

let STATE = WORKSPACE();
/** Which interview the bootstrap should hand back. */
let BOOTSTRAP_ROW = null;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const body = (cb) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => cb(b)); };

  if (url === '/api/interviews' && req.method === 'POST') {
    return body((b) => {
      let p = {}; try { p = JSON.parse(b); } catch { /* ignore */ }
      POSTED.push(p);
      const row = {
        id: 'iv-' + (ROWS.length + 1),
        client_name: p.clientName, interviewee_name: p.intervieweeName,
        interviewee_role: p.intervieweeRole, status: 'invited',
        created_at: new Date(1786000000000 + ROWS.length).toISOString(),
        email: p.email, kind: 'initial', agenda: null, agenda_status: null,
        interviewer_name: p.interviewerName || null,
        interviewer_voice: p.interviewerVoice || null,
        round_number: p.roundNumber ?? null,
        // 028: NOT NULL DEFAULT 'deep'
        depth: p.depth ?? 'deep',
      };
      ROWS.push(row);
      return json({ id: row.id, loginHint: 'NWF01-4821' }, 201);
    });
  }
  if (url.startsWith('/api/interviews/') && req.method === 'PATCH') {
    return body((b) => {
      let p = {}; try { p = JSON.parse(b); } catch { /* ignore */ }
      PATCHED.push(p);
      const id = url.split('/')[3];
      const row = ROWS.find((r) => r.id === id);
      // COALESCE semantics: absent leaves the column alone.
      if (row && p.depth !== undefined && p.depth !== null) row.depth = p.depth;
      return json({ ok: true });
    });
  }
  if (url === '/api/interviews') return json({ interviews: ROWS });
  if (url === '/api/interviews/mine/bootstrap') {
    if (!BOOTSTRAP_ROW) return json({ error: 'no_interview_assigned' }, 404);
    return json({ interview: BOOTSTRAP_ROW, injected: WORKSPACE(), own: {} });
  }
  if (url.startsWith('/api/module-state/')) {
    if (req.method === 'PUT') return body(() => json({ ok: true, versions: {} }));
    return json({ module: 'workspace', state: STATE, versions: {} });
  }
  if (url === '/api/version') return json({ version: null, env: 'test' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'c@firm.com' });
  if (url === '/api/clients') return json({ clients: [CLIENT] });
  // interviews.html reads its client list from /api/my-clients (owner → the
  // full list) and its team from /api/team, NOT from /api/clients. Getting this
  // wrong left every dropdown empty and createInvite() refusing to post.
  if (url === '/api/my-clients') return json({ role: 'owner', clients: [CLIENT] });
  if (url === '/api/team') return json({ members: [{ id: 'u1', email: 'c@firm.com', role: 'owner' }] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/firms/team') return json({ members: [] });
  if (url === '/api/voice/voices') return json({ voices: [{ id: 'Orus', label: 'Orus' }] });
  if (url.startsWith('/api/llm')) return body(() => json({ text: '{}', finishReason: 'stop' }));
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try {
    const f = readFileSync(join(DIR, url === '/' ? 'index.html' : url), 'utf8');
    res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : 'text/html' });
    res.end(f);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];

async function open(page_, session) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(`try{var s=${JSON.stringify(session)};s.at=Date.now();s.la=Date.now();
    sessionStorage.setItem('vyne_session', JSON.stringify(s));}catch(e){}`);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(page_ + ': ' + String(e).slice(0, 160)));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(`http://127.0.0.1:${PORT}/${page_}`);
  await page.waitForTimeout(1500);
  return { page, ctx };
}

const CONSULTANT = { token: 't', email: 'c@firm.com', role: 'owner', mode: 'dev', activeClient: CLIENT };
const INTERVIEWEE = { token: 't', email: 'peter@northwind.example', role: 'interviewee', mode: 'dev' };

/* ── 1. The consultant chooses a depth on the invite ─────────────────────── */
{
  resetRows();
  const { page, ctx } = await open('interviews.html', CONSULTANT);

  check('the invite form HAS a depth control at all',
    await page.evaluate(`!!document.getElementById('iv-depth')`),
    'this is the control whose absence was the defect');

  check('it defaults to Deep Dive — what every interview ran as before',
    await page.evaluate(`(document.getElementById('iv-depth')||{}).value`) === 'deep');

  await page.evaluate(`(() => {
    document.getElementById('iv-client').value = ${JSON.stringify(CLIENT)};
    document.getElementById('iv-client').dispatchEvent(new Event('change'));
    document.getElementById('iv-name').value = 'Peter Osei';
    document.getElementById('iv-email').value = 'peter@northwind.example';
    var role = document.getElementById('iv-role');
    for (var i = 0; i < role.options.length; i++) if (role.options[i].value === 'CTO') role.selectedIndex = i;
    document.getElementById('iv-depth').value = 'quick';
    createInvite();
  })()`);
  await page.waitForTimeout(1200);

  check('the invite carries the chosen depth to the server',
    POSTED.length === 1 && POSTED[0].depth === 'quick',
    JSON.stringify(POSTED[0] || null));
  check('...and the interview row is stored with it',
    ROWS.length === 1 && ROWS[0].depth === 'quick',
    JSON.stringify(ROWS.map((r) => r.depth)));

  await page.close(); await ctx.close();
}

/* ── 2. THE DEFECT: does it reach the interviewee? ───────────────────────── */
{
  BOOTSTRAP_ROW = ROWS[0];
  const { page, ctx } = await open('interview_agent.html', INTERVIEWEE);

  const seen = await page.evaluate(`(() => ({
    depth: S.depth,
    initialBudget: VyneDepth.initialBudget(S.depth),
    promptSaysQuick: /20-25/.test(VyneDepth.prompt(S.depth)),
    setupHidden: getComputedStyle(document.getElementById('setup-screen')).display === 'none',
  }))()`);

  /* THE ASSERTION THIS FILE EXISTS FOR. Before v5.33.8 this reported
   * deep / 50 for a quick-screen invite. */
  check('the interviewee’s session runs to the CONSULTANT’s depth',
    seen.depth === 'quick', JSON.stringify(seen));
  check('...so the question budget is the quick one, not the module default',
    seen.initialBudget === 25, 'budget ' + seen.initialBudget);
  check('...and the model is instructed with the matching range',
    seen.promptSaysQuick === true, JSON.stringify(seen));
  check('the interviewee still cannot see the setup screen that used to own this',
    seen.setupHidden === true,
    'if this ever renders, depth stopped being the consultant’s decision');

  await page.close(); await ctx.close();
}

/* ── 3. An invite that says nothing still behaves exactly as before ──────── */
{
  resetRows();
  const { page, ctx } = await open('interviews.html', CONSULTANT);
  await page.evaluate(`(() => {
    document.getElementById('iv-client').value = ${JSON.stringify(CLIENT)};
    document.getElementById('iv-client').dispatchEvent(new Event('change'));
    document.getElementById('iv-name').value = 'Marguerite Vance';
    document.getElementById('iv-email').value = 'mv@northwind.example';
    var role = document.getElementById('iv-role');
    for (var i = 0; i < role.options.length; i++) if (role.options[i].value === 'CEO') role.selectedIndex = i;
    createInvite();                       // depth left at its default
  })()`);
  await page.waitForTimeout(1200);
  await page.close(); await ctx.close();

  BOOTSTRAP_ROW = ROWS[0];
  const { page: p2, ctx: c2 } = await open('interview_agent.html', INTERVIEWEE);
  const seen = await p2.evaluate(`(() => ({ depth: S.depth, budget: VyneDepth.initialBudget(S.depth) }))()`);
  check('an untouched invite is still a 50-question Deep Dive',
    seen.depth === 'deep' && seen.budget === 50, JSON.stringify(seen));
  await p2.close(); await c2.close();
}

/* ── 4. A row created before 028 has no depth at all ─────────────────────── */
{
  /* The realistic failure this guards: a bootstrap response cached by a browser
   * that has not reloaded, or any row the column has not reached. `undefined`
   * must land on the default, not make the progress denominator NaN. */
  BOOTSTRAP_ROW = { ...ROWS[0] };
  delete BOOTSTRAP_ROW.depth;
  const { page, ctx } = await open('interview_agent.html', INTERVIEWEE);
  const seen = await page.evaluate(`(() => ({
    depth: S.depth, budget: VyneDepth.initialBudget(S.depth),
    budgetIsANumber: Number.isFinite(VyneDepth.initialBudget(S.depth)),
  }))()`);
  check('a pre-028 row with no depth falls back to deep, not to NaN',
    seen.depth === 'deep' && seen.budgetIsANumber && seen.budget === 50, JSON.stringify(seen));
  await page.close(); await ctx.close();
}

/* ── 5. The row editor can change it before they start, and not after ────── */
{
  resetRows();
  ROWS.push({
    id: 'iv-9', client_name: CLIENT, interviewee_name: 'Ines Kaur', interviewee_role: 'CTO',
    status: 'invited', created_at: '2026-07-10T09:00:00.000Z', email: 'ik@northwind.example',
    kind: 'initial', agenda: null, agenda_status: null,
    interviewer_name: null, interviewer_voice: null, round_number: null, depth: 'deep',
  });
  ROWS.push({
    id: 'iv-10', client_name: CLIENT, interviewee_name: 'Tomas Reinholt', interviewee_role: 'CTO',
    status: 'in_progress', created_at: '2026-07-11T09:00:00.000Z', email: 'tr@northwind.example',
    kind: 'initial', agenda: null, agenda_status: null,
    interviewer_name: null, interviewer_voice: null, round_number: null, depth: 'deep',
  });
  const { page, ctx } = await open('interviews.html', CONSULTANT);
  await page.waitForTimeout(600);

  const editable = await page.evaluate(`(() => {
    editRow('iv-9');
    var el = document.querySelector("#row-iv-9 [data-f='depth']");
    return { present: !!el, disabled: el ? el.disabled : null, value: el ? el.value : null };
  })()`);
  check('an INVITED row can have its depth changed',
    editable.present && editable.disabled === false && editable.value === 'deep',
    JSON.stringify(editable));

  await page.evaluate(`(() => {
    document.querySelector("#row-iv-9 [data-f='depth']").value = 'standard';
    saveRow('iv-9');
  })()`);
  await page.waitForTimeout(900);
  check('...and the change is sent and stored',
    PATCHED.some((p) => p.depth === 'standard') && ROWS.find((r) => r.id === 'iv-9').depth === 'standard',
    JSON.stringify(PATCHED));

  const started = await page.evaluate(`(() => {
    editRow('iv-10');
    var el = document.querySelector("#row-iv-10 [data-f='depth']");
    return { present: !!el, disabled: el ? el.disabled : null };
  })()`);
  check('a STARTED row shows its depth but will not let you change it',
    started.present && started.disabled === true, JSON.stringify(started));

  PATCHED.length = 0;
  await page.evaluate(`saveRow('iv-10')`);
  await page.waitForTimeout(900);
  check('...and saving that row does not post a depth at all',
    PATCHED.length === 1 && PATCHED[0].depth === undefined,
    JSON.stringify(PATCHED));

  await page.close(); await ctx.close();
}

/* ── 6. A follow-up: depth is inherited, and scales the agenda budget ────── */
{
  resetRows();
  /* What the /followup/draft route produces: a follow_up row carrying the
   * PARENT's depth, with an agenda awaiting approval. */
  ROWS.push({
    id: 'iv-fu', client_name: CLIENT, interviewee_name: 'Peter Osei', interviewee_role: 'CTO',
    status: 'invited', created_at: '2026-08-01T09:00:00.000Z', email: 'peter@northwind.example',
    kind: 'follow_up', parent_interview_id: 'iv-cto', agenda_status: 'draft',
    agenda: [
      { dimension: 'D5', text: 'How shift handover works today across both regions' },
      { dimension: 'D6', text: 'Who signs off a model going into production' },
      { dimension: 'D1', text: 'Where month-end reconciliation stands now' },
    ],
    interviewer_name: null, interviewer_voice: null, round_number: 2,
    depth: 'quick',                         // inherited from the parent
  });

  const { page, ctx } = await open('interviews.html', CONSULTANT);
  await page.waitForTimeout(600);
  const seeded = await page.evaluate(`(() => {
    openAgendaReview('iv-fu');
    var el = document.getElementById('agenda-depth');
    return { value: el ? el.value : null, hint: (document.getElementById('agenda-depth-hint')||{}).textContent };
  })()`);
  check('the agenda dialog opens on the depth the follow-up INHERITED',
    seeded.value === 'quick', JSON.stringify(seeded));
  check('...and states the length THIS agenda produces, not a generic range',
    /3 topics/.test(seeded.hint || ''), JSON.stringify(seeded.hint));

  const changed = await page.evaluate(`(() => {
    var el = document.getElementById('agenda-depth');
    el.value = 'deep'; el.onchange();
    return (document.getElementById('agenda-depth-hint')||{}).textContent;
  })()`);
  check('changing depth moves the stated length',
    changed !== seeded.hint && /9 questions/.test(changed || ''),
    JSON.stringify({ before: seeded.hint, after: changed }));

  await page.evaluate(`saveAgenda(true)`);
  await page.waitForTimeout(900);
  check('approving the agenda saves the depth in the SAME request',
    PATCHED.length === 1 && PATCHED[0].approve === true && PATCHED[0].depth === 'deep',
    JSON.stringify(PATCHED));

  await page.close(); await ctx.close();
}

/* ── 7. ...and the follow-up interviewee runs to it ──────────────────────── */
{
  for (const [depth, expected] of [['quick', 3], ['standard', 6], ['deep', 9]]) {
    BOOTSTRAP_ROW = { ...ROWS[0], depth, agenda_status: 'approved' };
    const { page, ctx } = await open('interview_agent.html', INTERVIEWEE);
    const b = await page.evaluate(`(() => {
      var entry = { agendaItems: S.followUpAgenda || [] };
      return { depth: S.depth, items: entry.agendaItems.length,
               budget: computeRefreshQuestionBudget(entry, 0).high };
    })()`);
    check(`a 3-topic follow-up at ${depth} budgets ${expected} questions`,
      b.depth === depth && b.items === 3 && b.budget === expected, JSON.stringify(b));
    await page.close(); await ctx.close();
  }
}

check('no uncaught page errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

console.log('\n=== INTERVIEW DEPTH TRAVELS WITH THE INVITE (v5.33.8) ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : '\n        → ' + r.detail}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
