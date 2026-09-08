/**
 * END-TO-END TEST for renaming a client REPEATEDLY — including renaming BACK
 * to a name used earlier in the same engagement's history (v5.32.93).
 *
 *   node frontend/test/rename-cycle-e2e.mjs
 *
 * Requires Node >= 22.18 (this file imports the backend's TypeScript directly;
 * Node strips the types natively). It fails loudly below if that is not so,
 * rather than skipping — a rename test that quietly does not run is exactly
 * the failure mode this file exists to end.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * rename-client-e2e.mjs (v5.32.92) covers ONE forward rename and ONE rename
 * back, and it passes. The reported failure is on the SECOND hop and on the
 * return to a name used earlier:
 *
 *     "I want to be able to name and rename as many times as possible without
 *      these stupid collisions and issues."
 *
 * Four fixes passed a single forward rename and left debris that broke the
 * next one. So this file renames in a CYCLE — seven hops, three of them back
 * to a name the engagement already had — and after EVERY hop asserts that all
 * seven places a client's identity is stored agree with each other:
 *
 *     interviews.client_name          (what the Interview Tracker shows)
 *     engagements.client_name         (the canonical row)
 *     vynora_engagement_index         exactly ONE entry for the code
 *     vynora_engagement_<CODE>.client
 *     vynora_briefing_<norm> & friends (the norm-suffixed key families)
 *     vynora_last_briefing
 *     the session's activeClient
 *
 * ── WHY IT IMPORTS THE BACKEND ──────────────────────────────────────────────
 *
 * The recurring failure mode in this bug was never a missing test. It was
 * checks that reported something narrower than they appeared: static source
 * assertions that went green over a live bug twice, and a fake server that
 * reimplemented the very logic it was asked to prove. So this fake server does
 * not imitate the rename — it CALLS it, importing planClientRename() from
 * backend/src/auth/clients.ts. The browser here talks to the same algorithm
 * production does. If it passes for a reason that does not hold in production,
 * that reason has to be in the HTTP glue below, which is fifty lines and does
 * no renaming of its own.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8827;

/* The real thing. Not a copy of it. */
let backend;
try {
  backend = await import('../../backend/src/auth/clients.ts');
} catch (e) {
  console.error('\n  Could not import backend/src/auth/clients.ts.');
  console.error('  This test runs the REAL rename algorithm, so it needs Node >= 22.18');
  console.error('  (native TypeScript type-stripping). Node here is ' + process.version + '.');
  console.error('  ' + String(e && e.message) + '\n');
  process.exit(1);
}
const { normClient, planClientRename, enforceServerNames, stampServerNames } = backend;
for (const [n, f] of [['enforceServerNames', enforceServerNames], ['stampServerNames', stampServerNames]]) {
  if (typeof f !== 'function') {
    console.error('\n  backend/src/auth/clients.ts does not export ' + n + '().\n');
    process.exit(1);
  }
}
if (typeof planClientRename !== 'function') {
  console.error('\n  backend/src/auth/clients.ts does not export planClientRename().');
  console.error('  That is the code-anchored rename planner this test drives.\n');
  process.exit(1);
}

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const CODE = 'ENG-GSC6-Y7ME';

/* ── The database, in memory ───────────────────────────────────────────────
 *
 * Three clients, because a rename that quietly moves a bystander is as wrong
 * as one that fails to move its own target, and nothing in four rounds of
 * fixes was watching for that.
 */
let DB, WORKSPACE, VERSIONS;
let renameCalls = [], statePuts = [], conflictCount = 0, renameResponses = [];

function seed() {
  DB = {
    engagements: [
      { id: 'e1', client_name: 'Meridian Foods' },
      { id: 'e2', client_name: 'Nissan Motors Corporation' },
      { id: 'e3', client_name: 'Regis Corporation' },
    ],
    interviews: [
      ...Array.from({ length: 6 }, (_, i) => ({ id: 'iv' + i, client_name: 'Meridian Foods' })),
      ...Array.from({ length: 9 }, (_, i) => ({ id: 'nv' + i, client_name: 'Nissan Motors Corporation' })),
    ],
    assignments: [
      { user_id: 'u2', client_name: 'Meridian Foods', client_norm: 'meridianfoods' },
      { user_id: 'u2', client_name: 'Regis Corporation', client_norm: 'regiscorporation' },
    ],
  };
  WORKSPACE = {
    vynora_engagement_index: JSON.stringify({
      meridianfoods: CODE,
      nissanmotorscorporation: 'ENG-MCJQ-RBH3',
      regiscorporation: 'ENG-6GGM-ZTX7',
    }),
    ['vynora_engagement_' + CODE]: JSON.stringify({
      code: CODE, client: 'Meridian Foods', industry: 'Manufacturing',
      rounds: [{ roundId: 'r1', roundNumber: 1, label: 'Initial Diagnostic', status: 'complete' }],
      interviews: [{ role: 'CTO', interviewee: 'Priya Sharma [Synthetic]', scores: { D1: 2 } }],
    }),
    vynora_engagement_ENGMCJQRBH3: JSON.stringify({ code: 'ENG-MCJQ-RBH3', client: 'Nissan Motors Corporation' }),
    vynora_briefing_meridianfoods: JSON.stringify({
      client: 'Meridian Foods', industry: 'Manufacturing', engagementCode: CODE,
      roleCatalog: [{ value: 'CTO', display: 'CTO / Technology Leadership' }],
      hypotheses: [{ index: 0, text: 'Data is siloed', status: 'open' }],
    }),
    vynora_mandatory_meridianfoods: JSON.stringify({ client: 'Meridian Foods', items: ['ERP migration'] }),
    vynora_solution_design_meridianfoods: JSON.stringify({ client: 'Meridian Foods', useCases: ['demand forecast'] }),
    ['vynora_hypothesis_verdicts_' + CODE]: JSON.stringify({ client: 'Meridian Foods', verdicts: { 0: 'supported' } }),
    vynora_briefing_nissanmotorscorporation: JSON.stringify({ client: 'Nissan Motors Corporation', hypotheses: [] }),
    vynora_last_briefing: JSON.stringify({ normKey: 'meridianfoods', client: 'Meridian Foods' }),

    /* Debris, exactly as production carries it: orphan workspace keys under
     * norms with no engagements row, no interviews and no index entry. Left
     * to block the collision check, these make "rename back to a name I used
     * before" permanently impossible — which is the case the user asked for. */
    vynora_briefing_meridianfoods1: JSON.stringify({ client: 'Meridian Foods 1', hypotheses: [] }),
    vynora_mandatory_meridianfoods1: JSON.stringify({ client: 'Meridian Foods 1' }),
    vynora_briefing_acmeindustrial: JSON.stringify({ client: 'Acme Industrial', hypotheses: [] }),
  };
  VERSIONS = {};
  for (const k of Object.keys(WORKSPACE)) VERSIONS[k] = 1;
  renameCalls = []; statePuts = []; conflictCount = 0; renameResponses = [];
}

/* ── The route, as thin glue over the real planner ─────────────────────────
 *
 * This mirrors routes/assignments.ts PATCH /api/clients/rename: read the rows,
 * call planClientRename(), apply what it returns. The planning — which keys
 * move, which values are patched, what collides, what is debris — is entirely
 * the imported backend function's.
 */
/** code → client_name, the way the route reads it out of `engagements`. */
function trustedCodes() {
  const m = new Map();
  m.set(CODE, DB.engagements.find((e) => e.id === 'e1').client_name);
  m.set('ENG-MCJQ-RBH3', DB.engagements.find((e) => e.id === 'e2').client_name);
  return m;
}

function routeRename(body) {
  const plan = planClientRename({
    state: WORKSPACE,
    engagements: DB.engagements,
    interviews: DB.interviews,
    assignments: DB.assignments,
    target: { code: body.engagementCode || null, clientName: body.clientName || null },
    newName: String(body.newClientName || '').trim(),
  });
  if (plan.conflict) return { status: 409, body: { error: 'name_collision', detail: plan.conflict } };

  for (const [k, v] of Object.entries(plan.sets)) {
    WORKSPACE[k] = v;
    VERSIONS[k] = (VERSIONS[k] || 0) + 1;
  }
  for (const k of plan.deletes) { delete WORKSPACE[k]; delete VERSIONS[k]; }
  for (const id of plan.engagementIds) {
    const row = DB.engagements.find((r) => r.id === id);
    if (row) row.client_name = plan.newName;
  }
  for (const id of plan.interviewIds) {
    const row = DB.interviews.find((r) => r.id === id);
    if (row) row.client_name = plan.newName;
  }
  for (const a of DB.assignments) {
    if (plan.assignmentNorms.includes(a.client_norm)) {
      a.client_norm = normClient(plan.newName);
      a.client_name = plan.newName;
    }
  }
  return {
    status: 200,
    body: {
      ok: true, clientName: plan.newName, engagementCode: plan.code,
      engagementsRenamed: plan.engagementIds.length,
      interviewsRenamed: plan.interviewIds.length,
      assignmentsMoved: plan.assignmentNorms.length,
      workspaceKeysChanged: Object.keys(plan.sets).length + plan.deletes.length,
      report: plan.report,
    },
  };
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url === '/api/clients/rename' && req.method === 'PATCH') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => {
      const p = JSON.parse(b || '{}');
      renameCalls.push(p);
      const out = routeRename(p);
      renameResponses.push(out.body);
      json(out.body, out.status);
    });
    return;
  }
  if (url.startsWith('/api/module-state/') && req.method === 'PUT') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => {
      const conflicts = [];
      const versions = {};
      try {
        const p = JSON.parse(b);
        statePuts.push(p);
        const expected = p.expectedVersions || {};
        // Exactly what routes/moduleState.ts does, for every role: the name the
        // browser sends is discarded in favour of engagements.client_name.
        const sets = enforceServerNames(p.sets || {}, trustedCodes()).sets;
        for (const [k, v] of Object.entries(sets)) {
          const has = Object.prototype.hasOwnProperty.call(expected, k);
          if (has && (VERSIONS[k] || 0) !== expected[k]) {
            conflicts.push({ key: k, version: VERSIONS[k] || 0, value: WORKSPACE[k] || '' });
            continue;
          }
          WORKSPACE[k] = v;
          VERSIONS[k] = (VERSIONS[k] || 0) + 1;
          versions[k] = VERSIONS[k];
        }
        for (const k of (p.deletes || [])) { delete WORKSPACE[k]; delete VERSIONS[k]; }
      } catch { /* malformed body — the assertions below will show it */ }
      if (conflicts.length) { conflictCount++; return json({ error: 'version_conflict', conflicts, versions }, 409); }
      json({ ok: true, versions });
    });
    return;
  }
  if (url.startsWith('/api/module-state/')) {
    return json({ module: 'workspace', state: stampServerNames(WORKSPACE, trustedCodes()), versions: VERSIONS });
  }
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'o@firm.com' });
  if (url === '/api/my-clients') return json({ role: 'owner', clients: DB.engagements.map((e) => e.client_name) });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/engagements') return json({ engagements: [] });
  if (url === '/api/voice/voices') return json({ voices: [] });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  try {
    const body = readFileSync(join(DIR, url === '/' ? 'pre_engagement.html' : url), 'utf8');
    res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : 'text/html' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

/* ── The browser ───────────────────────────────────────────────────────────── */
seed();
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
/* SEED ONCE — addInitScript re-runs on every navigation, and this test reloads
 * after every hop. An unconditional write would reset activeClient to the
 * pre-rename value each time and make a FIXED product look broken. */
await ctx.addInitScript(() => {
  try {
    if (!sessionStorage.getItem('vyne_session')) {
      sessionStorage.setItem('vyne_session', JSON.stringify({
        token: 'tok', email: 'o@firm.com', role: 'owner', mode: 'dev',
        activeClient: 'Meridian Foods', at: Date.now(), la: Date.now(),
      }));
    }
  } catch (e) { /* seeding is best-effort; the first assertion catches a miss */ }
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

let nextName = '';
page.on('dialog', async (d) => {
  if (d.type() === 'prompt') await d.accept(nextName);
  else await d.accept();
});

const reload = async (p = page) => {
  await p.goto(`http://127.0.0.1:${PORT}/`);
  await p.waitForTimeout(1200);
};

/** Everything the product believes about who this client is, in one look. */
const observe = async (name, p = page) => {
  const norm = normClient(name);
  const page_ = await p.evaluate(() => ({
    field: (document.getElementById('client-name') || {}).value,
    active: (window.vyneAuth && vyneAuth.activeClient) ? vyneAuth.activeClient() : undefined,
    hyp: document.body.innerHTML.includes('Data is siloed'),
  }));
  let idx = {};
  try { idx = JSON.parse(WORKSPACE.vynora_engagement_index || '{}'); } catch { /* asserted below */ }
  let eng = {};
  try { eng = JSON.parse(WORKSPACE['vynora_engagement_' + CODE] || '{}'); } catch { /* asserted below */ }
  let lb = {};
  try { lb = JSON.parse(WORKSPACE.vynora_last_briefing || '{}'); } catch { /* asserted below */ }
  const NORM_FAMILIES = ['vynora_briefing_', 'vynora_mandatory_', 'vynora_solution_design_'];
  /* v5.32.97 — a family is CORRECTLY placed if it sits under the engagement
   * CODE (the new address) or under the client's CURRENT norm (a page not yet
   * migrated, or a workspace the lazy server migration has not reached).
   * Either is fine. What must never be true is a family sitting under a name
   * this engagement used EARLIER — that is the stranded key, and it is checked
   * separately below.
   *
   * Asserting "moved to the new norm" was the old architecture's invariant and
   * would now fail for exactly the reason the change is correct. */
  const placed = NORM_FAMILIES.filter((f) =>
    Object.prototype.hasOwnProperty.call(WORKSPACE, f + CODE)
    || Object.prototype.hasOwnProperty.call(WORKSPACE, f + norm));
  const placement = NORM_FAMILIES.map((f) =>
    f + (Object.prototype.hasOwnProperty.call(WORKSPACE, f + CODE) ? '<CODE>'
      : Object.prototype.hasOwnProperty.call(WORKSPACE, f + norm) ? '<norm>' : 'MISSING'));
  return {
    page: page_,
    interviews: DB.interviews.filter((r) => r.client_name === name).length,
    interviewsElsewhere: DB.interviews.filter((r) => r.client_name !== name && r.client_name !== 'Nissan Motors Corporation').map((r) => r.client_name),
    engagement: (DB.engagements.find((e) => e.id === 'e1') || {}).client_name,
    bystanderEng: (DB.engagements.find((e) => e.id === 'e2') || {}).client_name,
    indexNormsForCode: Object.keys(idx).filter((k) => idx[k] === CODE),
    engRecordClient: eng.client,
    normKeys: placed,
    placement,
    /* Keys under a norm that is NOT this client's current one but IS one this
     * engagement used before — the debris that breaks the next hop. */
    lastBriefing: lb,
    assignment: (DB.assignments.find((a) => a.user_id === 'u2' && a.client_name !== 'Regis Corporation') || {}),
  };
};

/** The seven agreements, asserted after one hop. */
const assertAgreement = async (label, name, usedNorms, p = page) => {
  const norm = normClient(name);
  const o = await observe(name, p);
  check(`[${label}] the page shows "${name}" after a reload`, o.page.field === name, String(o.page.field));
  check(`[${label}] the session's active client is "${name}"`, o.page.active === name, String(o.page.active));
  check(`[${label}] the briefing content survived the rename`, o.page.hyp, 'hypothesis text present: ' + o.page.hyp);
  check(`[${label}] all 6 interviews read "${name}"`, o.interviews === 6, o.interviews + ' rows; strays: ' + JSON.stringify(o.interviewsElsewhere));
  check(`[${label}] the engagements row reads "${name}"`, o.engagement === name, String(o.engagement));
  check(`[${label}] vynora_engagement_${CODE}.client reads "${name}"`, o.engRecordClient === name, String(o.engRecordClient));
  check(`[${label}] the index holds EXACTLY ONE norm for ${CODE}, and it is "${norm}"`,
    o.indexNormsForCode.length === 1 && o.indexNormsForCode[0] === norm,
    JSON.stringify(o.indexNormsForCode));
  check(`[${label}] every per-client family is addressable — by code or by the current name`,
    o.normKeys.length === 3, JSON.stringify(o.placement));
  const stale = usedNorms.filter((n) => n !== norm)
    .flatMap((n) => ['vynora_briefing_', 'vynora_mandatory_', 'vynora_solution_design_'].map((f) => f + n))
    .filter((k) => Object.prototype.hasOwnProperty.call(WORKSPACE, k));
  check(`[${label}] no key is left behind under a name this engagement used before`, stale.length === 0, stale.join(' | '));
  check(`[${label}] vynora_last_briefing agrees`, o.lastBriefing.normKey === norm && o.lastBriefing.client === name,
    JSON.stringify(o.lastBriefing));
  check(`[${label}] the consultant's assignment followed the rename`,
    o.assignment.client_name === name && o.assignment.client_norm === norm, JSON.stringify(o.assignment));
  check(`[${label}] the bystander client was not touched`, o.bystanderEng === 'Nissan Motors Corporation', String(o.bystanderEng));
  check(`[${label}] no write was refused on a stale version`, conflictCount === 0, 'conflicts: ' + conflictCount);
  check(`[${label}] the server reported nothing left unrenamed`,
    !!renameResponses.length && !!renameResponses[renameResponses.length - 1].report
      && (renameResponses[renameResponses.length - 1].report.residue || []).length === 0,
    JSON.stringify((renameResponses[renameResponses.length - 1] || {}).report));
};

/* ══ PART A — seven hops, three of them BACK to an earlier name ═════════════ */
await reload();
const first = await page.evaluate(() => ({
  field: (document.getElementById('client-name') || {}).value,
  active: (window.vyneAuth && vyneAuth.activeClient) ? vyneAuth.activeClient() : undefined,
}));
check('[start] the briefing loads under the current client', first.field === 'Meridian Foods', String(first.field));
check('[start] and the session names that client as active', first.active === 'Meridian Foods', String(first.active));

const HOPS = [
  'Meridian Foods New',
  'Meridian Foods Test',
  'Meridian Foods Test 1',
  'Meridian Foods',        // ← BACK to the original
  'Meridian Foods New',    // ← BACK to an intermediate
  'Harbor Point Dairy',
  'Meridian Foods Test',   // ← BACK, five hops later
];
const usedNorms = [normClient('Meridian Foods')];

for (let i = 0; i < HOPS.length; i++) {
  const name = HOPS[i];
  const label = 'hop ' + (i + 1) + ' → ' + name;
  nextName = name;
  conflictCount = 0;
  const before = renameCalls.length;
  await page.evaluate(() => renameClientPrompt());
  await page.waitForTimeout(1000);

  check(`[${label}] the rename reached the server`, renameCalls.length === before + 1
    && renameCalls[renameCalls.length - 1].newClientName === name,
    JSON.stringify(renameCalls[renameCalls.length - 1]));
  /* The whole design of the fix: the browser must NOT be the authority on the
   * old name. It sends the engagement code, which is stable and never renamed,
   * and the server resolves it to its own current name. */
  check(`[${label}] it identified the client by engagement CODE, not by a cached name`,
    (renameCalls[renameCalls.length - 1] || {}).engagementCode === CODE,
    JSON.stringify(renameCalls[renameCalls.length - 1]));

  await reload();
  if (!usedNorms.includes(normClient(name))) usedNorms.push(normClient(name));
  await assertAgreement(label, name, usedNorms);
}

check('[A] no uncaught page errors across seven hops', errors.length === 0, errors.slice(0, 3).join(' | '));

/* ══ PART A2 — a SECOND TAB holding a name from before the last rename ══════
 *
 * This is how the split got into production in the first place, and no test
 * had it. A consultant with the briefing open in two tabs renames in one; the
 * other tab's existingEngagement.client is now a name the server has moved
 * away from. Renaming from that tab used to send the stale name, match
 * nothing, change nothing, and report success — after which every later rename
 * of that client was computed from a wrong base and did nothing either.
 *
 * With the rename anchored on the engagement CODE, the stale tab is harmless:
 * it names an engagement, not a client name, and the server resolves what that
 * engagement is currently called from its own state.
 */
const tab2 = await ctx.newPage();
tab2.on('pageerror', (e) => errors.push('[tab2] ' + String(e)));
tab2.on('dialog', async (d) => {
  if (d.type() === 'prompt') await d.accept(nextName);
  else await d.accept();
});
/* sessionStorage is per-tab, so this tab starts with the seed value. Point it
 * at the client as it is named RIGHT NOW — which is what opening a second tab
 * from the client picker does. */
await tab2.goto(`http://127.0.0.1:${PORT}/`);
await tab2.evaluate(() => {
  const s = JSON.parse(sessionStorage.getItem('vyne_session') || '{}');
  s.activeClient = 'Meridian Foods Test';
  sessionStorage.setItem('vyne_session', JSON.stringify(s));
});
await reload(tab2);            // tab2 caches the CURRENT name: "Meridian Foods Test"
const tab2Cached = await tab2.evaluate(() =>
  (window.existingEngagement && existingEngagement.client) || null);
check('[A2] the second tab cached the name in force when it loaded',
  tab2Cached === 'Meridian Foods Test', String(tab2Cached));

nextName = 'Cedar Ridge Foods';
await page.evaluate(() => renameClientPrompt());   // tab 1 renames
await page.waitForTimeout(1000);
check('[A2] tab 1 renamed while tab 2 was open', renameResponses[renameResponses.length - 1].ok === true,
  JSON.stringify(renameResponses[renameResponses.length - 1]));

nextName = 'Cedar Ridge Dairy';
conflictCount = 0;
await tab2.evaluate(() => renameClientPrompt());   // tab 2 renames from a STALE name
await tab2.waitForTimeout(1000);
const staleCall = renameCalls[renameCalls.length - 1];
check('[A2] the stale tab did send a name the server had already moved away from',
  staleCall.clientName === 'Meridian Foods Test', JSON.stringify(staleCall));
check('[A2] but it identified the engagement by CODE, so the server ignored that name',
  staleCall.engagementCode === CODE, JSON.stringify(staleCall));
await reload(tab2);
await assertAgreement('A2 → Cedar Ridge Dairy', 'Cedar Ridge Dairy',
  [...usedNorms, normClient('Cedar Ridge Foods')], tab2);
await tab2.close();

/* Tab 1's session still names "Cedar Ridge Foods" — sessionStorage is per-tab
 * and no server call can reach it, which is a real limit of the browser, not a
 * rename bug. What matters is that its STORE is correct, so putting the right
 * name in brings the whole briefing back. */
await page.evaluate(() => {
  const s = JSON.parse(sessionStorage.getItem('vyne_session') || '{}');
  s.activeClient = 'Cedar Ridge Dairy';
  sessionStorage.setItem('vyne_session', JSON.stringify(s));
});
await reload();
usedNorms.push(normClient('Cedar Ridge Foods'), normClient('Cedar Ridge Dairy'));
await assertAgreement('A2 (tab 1) → Cedar Ridge Dairy', 'Cedar Ridge Dairy', usedNorms);

/* ══ PART B — starting from the exact broken shape production was in ════════
 *
 * Two index norms pointing at one code, and an engagement record whose .client
 * is two names behind. This is what a rename left behind before the fix, and
 * it is why renaming BACK returned 409 forever: the collision check refuses
 * when the target norm is already in the index — even when the entry it is
 * refusing over belongs to the very engagement being renamed.
 */
seed();
WORKSPACE.vynora_engagement_index = JSON.stringify({
  meridianfoodsnew: CODE,            // stale entry the delete missed
  meridianfoodstest: CODE,           // and the one the rename added
  nissanmotorscorporation: 'ENG-MCJQ-RBH3',
  regiscorporation: 'ENG-6GGM-ZTX7',
});
WORKSPACE['vynora_engagement_' + CODE] = JSON.stringify({
  code: CODE, client: 'Meridian Foods New',   // two names behind the rest
  rounds: [{ roundId: 'r1', roundNumber: 1, label: 'Initial Diagnostic', status: 'complete' }],
});
WORKSPACE.vynora_briefing_meridianfoodstest = WORKSPACE.vynora_briefing_meridianfoods;
WORKSPACE.vynora_mandatory_meridianfoodstest = WORKSPACE.vynora_mandatory_meridianfoods;
WORKSPACE.vynora_solution_design_meridianfoodstest = WORKSPACE.vynora_solution_design_meridianfoods;
delete WORKSPACE.vynora_briefing_meridianfoods;
delete WORKSPACE.vynora_mandatory_meridianfoods;
delete WORKSPACE.vynora_solution_design_meridianfoods;
WORKSPACE.vynora_last_briefing = JSON.stringify({ normKey: 'meridianfoodstest', client: 'Meridian Foods Test' });
for (const r of DB.interviews) if (r.client_name === 'Meridian Foods') r.client_name = 'Meridian Foods Test';
DB.engagements[0].client_name = 'Meridian Foods Test';
DB.assignments[0] = { user_id: 'u2', client_name: 'Meridian Foods Test', client_norm: 'meridianfoodstest' };
VERSIONS = {};
for (const k of Object.keys(WORKSPACE)) VERSIONS[k] = 1;

await ctx.clearCookies();
await page.evaluate(() => {
  const s = JSON.parse(sessionStorage.getItem('vyne_session') || '{}');
  s.activeClient = 'Meridian Foods Test';
  sessionStorage.setItem('vyne_session', JSON.stringify(s));
});
await reload();

/* Renaming back to "Meridian Foods New" is the case that used to be
 * impossible: that norm is sitting in the index. It belongs to THIS
 * engagement, so it is not a collision — it is debris this rename should
 * clear. */
nextName = 'Meridian Foods New';
conflictCount = 0;
const beforeB = renameCalls.length;
await page.evaluate(() => renameClientPrompt());
await page.waitForTimeout(1000);
check('[B] renaming back over a leftover index entry is not refused as a collision',
  renameCalls.length === beforeB + 1
    && !!renameResponses[renameResponses.length - 1]
    && renameResponses[renameResponses.length - 1].ok === true,
  JSON.stringify(renameResponses[renameResponses.length - 1]));
await reload();
await assertAgreement('B1 → Meridian Foods New', 'Meridian Foods New',
  ['meridianfoods', 'meridianfoodstest', 'meridianfoodsnew']);

/* And the next hop still works — the repair has to be real, not cosmetic. */
nextName = 'Meridian Foods';
conflictCount = 0;
await page.evaluate(() => renameClientPrompt());
await page.waitForTimeout(1000);
await reload();
await assertAgreement('B2 → Meridian Foods', 'Meridian Foods',
  ['meridianfoods', 'meridianfoodstest', 'meridianfoodsnew']);

/* ══ PART C — a real collision must still be refused ════════════════════════
 *
 * Debris does not block a rename; another LIVE client does. If this passes for
 * the wrong reason the fix above has simply removed the safety rail.
 */
nextName = 'Nissan Motors Corporation';
const beforeC = renameCalls.length;
await page.evaluate(() => renameClientPrompt());
await page.waitForTimeout(1000);
const cResp = renameResponses[renameResponses.length - 1] || {};
check('[C] renaming onto ANOTHER live client is still refused',
  renameCalls.length === beforeC + 1 && cResp.error === 'name_collision', JSON.stringify(cResp));
await reload();
const afterC = await observe('Meridian Foods');
check('[C] and the refused rename changed nothing', afterC.engagement === 'Meridian Foods'
  && afterC.engRecordClient === 'Meridian Foods' && afterC.interviews === 6,
  JSON.stringify({ eng: afterC.engagement, rec: afterC.engRecordClient, ivs: afterC.interviews }));
check('[C] and the bystander client is intact', afterC.bystanderEng === 'Nissan Motors Corporation'
  && DB.interviews.filter((r) => r.client_name === 'Nissan Motors Corporation').length === 9,
  String(afterC.bystanderEng));

/* ══ PART D — the owner who works across ALL clients, and their draft ═══════
 *
 * Reported after v5.32.93: "a rename only makes it to the interview tracker
 * when it is brand new; renaming back to a previously used name does not work
 * because it does not save in the session."
 *
 * Two things this exercises that nothing above did:
 *
 *  1. An owner who picked "all clients" on the hub has activeClient === null.
 *     setActiveClient() deliberately refuses to overwrite null (it means "all
 *     clients", and narrowing it silently would be worse). renameClientPrompt
 *     ignores that refusal, so for this session the rename never reaches the
 *     session at all.
 *  2. The Pre-Engagement DRAFT blob stores the client's name under the form
 *     field id 'client-name'. The rename patches `client` and `clientName`;
 *     'client-name' is neither, so the moved draft still carries the OLD name
 *     and restoreDraft() puts it straight back into the field.
 */
seed();
WORKSPACE.vynora_draft_pre_engagement_meridianfoods = JSON.stringify({
  'client-name': 'Meridian Foods', industry: 'Manufacturing', revenue: '$500M',
});
VERSIONS.vynora_draft_pre_engagement_meridianfoods = 1;

await page.evaluate(() => {
  const s = JSON.parse(sessionStorage.getItem('vyne_session') || '{}');
  s.activeClient = null;   // "all clients" — what the hub writes for that pick
  sessionStorage.setItem('vyne_session', JSON.stringify(s));
});
await reload();
const dStart = await page.evaluate(() => ({
  field: (document.getElementById('client-name') || {}).value,
  // `engagementCode` is a top-level `let`, so it is NOT on window — reading it
  // as window.engagementCode returns undefined and says nothing about the page.
  code: (typeof engagementCode !== 'undefined' && engagementCode) || null,
}));
check('[D] an all-clients owner still lands on the client via the last-briefing pointer',
  dStart.field === 'Meridian Foods' && dStart.code === CODE, JSON.stringify(dStart));

nextName = 'Meridian Foods New';
conflictCount = 0;
await page.evaluate(() => renameClientPrompt());
await page.waitForTimeout(1000);
check('[D] the rename itself succeeded server-side',
  (renameResponses[renameResponses.length - 1] || {}).ok === true,
  JSON.stringify(renameResponses[renameResponses.length - 1]));

await reload();
const dAfter = await page.evaluate(() => ({
  field: (document.getElementById('client-name') || {}).value,
  active: (window.vyneAuth && vyneAuth.activeClient) ? vyneAuth.activeClient() : undefined,
  industry: (document.getElementById('industry') || {}).value,
}));
check('[D] the briefing shows the NEW name after a reload, not the draft\'s old one',
  dAfter.field === 'Meridian Foods New', String(dAfter.field));
/* NOT "the session now names the new client". An all-clients owner should keep
 * working across all clients — silently narrowing them to whichever client
 * they happened to rename is a scope change from a button labelled "Rename
 * Client". What has to be true is that the page still finds the client, which
 * it does through vynora_last_briefing. */
check('[D] the all-clients scope was NOT silently narrowed by the rename',
  dAfter.active === null, String(dAfter.active));
let draftRaw = null;
try { draftRaw = JSON.parse(WORKSPACE.vynora_draft_pre_engagement_meridianfoodsnew || 'null'); } catch { /* asserted */ }
check('[D] the draft blob\'s own copy of the name was renamed too',
  !!draftRaw && draftRaw['client-name'] === 'Meridian Foods New', JSON.stringify(draftRaw));
check('[D] and the rest of the draft survived', !!draftRaw && draftRaw.industry === 'Manufacturing',
  JSON.stringify(draftRaw));
check('[D] the server reported the draft as renamed, not as nothing-to-do',
  ((renameResponses[renameResponses.length - 1] || {}).report || {}).residue?.length === 0
    && !!draftRaw && draftRaw['client-name'] === 'Meridian Foods New',
  JSON.stringify((renameResponses[renameResponses.length - 1] || {}).report));

/* And renaming BACK from here — the reported case. */
nextName = 'Meridian Foods';
await page.evaluate(() => renameClientPrompt());
await page.waitForTimeout(1000);
await reload();
const dBack = await page.evaluate(() => ({
  field: (document.getElementById('client-name') || {}).value,
  active: (window.vyneAuth && vyneAuth.activeClient) ? vyneAuth.activeClient() : undefined,
}));
check('[D] renaming BACK lands for an all-clients owner', dBack.field === 'Meridian Foods', String(dBack.field));
check('[D] and the interviews followed it back',
  DB.interviews.filter((r) => r.client_name === 'Meridian Foods').length === 6,
  DB.interviews.filter((r) => r.client_name === 'Meridian Foods').length + ' rows');

/* ── D2: a session scoped to a DIFFERENT client must not be hijacked ─────── */
await page.evaluate(() => {
  const s = JSON.parse(sessionStorage.getItem('vyne_session') || '{}');
  s.activeClient = 'Regis Corporation';   // this owner is working on someone else
  sessionStorage.setItem('vyne_session', JSON.stringify(s));
});
nextName = 'Silverbrook Foods';
await page.evaluate(() => renameClientPrompt());
await page.waitForTimeout(1000);
const hijack = await page.evaluate(() =>
  (window.vyneAuth && vyneAuth.activeClient) ? vyneAuth.activeClient() : undefined);
check('[D2] renaming one client does not repoint a session scoped to another',
  hijack === 'Regis Corporation', String(hijack));
check('[D2] and the rename itself still landed',
  DB.engagements.find((e) => e.id === 'e1').client_name === 'Silverbrook Foods',
  DB.engagements.find((e) => e.id === 'e1').client_name);

/* ══ PART E — the browser overwriting the rename it just made ═══════════════
 *
 * The reported state, exactly: the client name field reads the NEW name, the
 * save pill sits on "Not saved — retrying", and the Rename button's prompt
 * offers the name from ONE HOP AGO.
 *
 * Those three facts together locate the fault precisely. The field comes from
 * the briefing key and the session — both of which the rename moved. The
 * prompt comes from existingEngagement.client, i.e. vynora_engagement_<CODE>.
 * So that ONE record is behind while everything else moved. Something rewrote
 * it after the rename, and the only thing holding a pre-rename copy is the
 * browser's own store.
 *
 * detectRoundMode() writes the engagement record back to the store on every
 * single call, so there is almost always a queued write for that key. When the
 * rename lands inside that 800ms debounce window, the queued PRE-rename value
 * is still sitting in `dirty`. renameClientPrompt then calls
 * vyneStore.rehydrate(), whose very first act is flushNow() — which sends
 * WITHOUT expectedVersions. No version check, so the server cannot refuse it:
 * the stale record is force-written straight over the rename that just
 * succeeded. rehydrate() then re-reads the state it has itself just corrupted.
 *
 * The fix added in v5.32.91 to cure staleness is the thing re-injecting it.
 */
seed();
await page.evaluate(() => {
  const s = JSON.parse(sessionStorage.getItem('vyne_session') || '{}');
  s.activeClient = 'Meridian Foods';
  sessionStorage.setItem('vyne_session', JSON.stringify(s));
});
await reload();

nextName = 'Meridian Foods Test 2';
conflictCount = 0;
await page.evaluate(async () => {
  /* What detectRoundMode() does on every load: queue the engagement record.
   * Renaming inside the 800ms debounce leaves this PRE-rename value queued. */
  vyneStore.setItem('vynora_engagement_ENG-GSC6-Y7ME',
    vyneStore.getItem('vynora_engagement_ENG-GSC6-Y7ME'));
  await renameClientPrompt();          // no wait — the queued write is still dirty
});
await page.waitForTimeout(1500);

let recE = {};
try { recE = JSON.parse(WORKSPACE['vynora_engagement_' + CODE] || '{}'); } catch { /* asserted */ }
check('[E] the engagement record was NOT reverted by the browser\'s queued write',
  recE.client === 'Meridian Foods Test 2', String(recE.client));

await reload();
const eAfter = await page.evaluate(() => ({
  field: (document.getElementById('client-name') || {}).value,
  // What the Rename button would offer — the reported symptom, read directly.
  prompt: (typeof existingEngagement !== 'undefined' && existingEngagement)
    ? existingEngagement.client : null,
  pill: (() => { const el = document.getElementById('vyne-save-indicator');
    return el ? (el._label ? el._label.textContent : el.textContent) : 'MISSING'; })(),
}));
check('[E] the field and the Rename prompt agree after a reload',
  eAfter.field === 'Meridian Foods Test 2' && eAfter.prompt === 'Meridian Foods Test 2',
  'field=' + eAfter.field + ' promptWouldOffer=' + eAfter.prompt);
check('[E] the save pill is not stuck on "Not saved — retrying"',
  !/Not saved/i.test(String(eAfter.pill)), String(eAfter.pill));
check('[E] no write was refused on a stale version', conflictCount === 0, 'conflicts: ' + conflictCount);
await assertAgreement('E → Meridian Foods Test 2', 'Meridian Foods Test 2',
  ['meridianfoods', 'meridianfoodstest2']);

/* ══ PART F — a SECOND TAB unloading over a rename made in the first ════════
 *
 * The drop-the-queue fix in Part E protects the tab that performs the rename.
 * It cannot protect a different tab, and a consultant with the briefing open
 * twice is ordinary. That tab holds a pre-rename copy of the engagement record
 * and flushes it on pagehide via flushNow() — which, without expectedVersions,
 * is a FORCE WRITE the server cannot refuse. Closing that tab silently undoes
 * the rename.
 *
 * This is the assertion that makes expectedVersions in flushNow() load-bearing.
 * Reverting that line passes every other case in this file.
 */
seed();
await page.evaluate(() => {
  const s = JSON.parse(sessionStorage.getItem('vyne_session') || '{}');
  s.activeClient = 'Meridian Foods';
  sessionStorage.setItem('vyne_session', JSON.stringify(s));
});
await reload();

const tabF = await ctx.newPage();
tabF.on('pageerror', (e) => errors.push('[tabF] ' + String(e)));
await tabF.goto(`http://127.0.0.1:${PORT}/`);
await tabF.evaluate(() => {
  const s = JSON.parse(sessionStorage.getItem('vyne_session') || '{}');
  s.activeClient = 'Meridian Foods';
  sessionStorage.setItem('vyne_session', JSON.stringify(s));
});
await reload(tabF);
nextName = 'Harbour Lane Foods';
await page.evaluate(() => renameClientPrompt());          // tab 1 renames
await page.waitForTimeout(900);
let recF1 = {};
try { recF1 = JSON.parse(WORKSPACE['vynora_engagement_' + CODE] || '{}'); } catch { /* asserted */ }
check('[F] the rename landed in tab 1', recF1.client === 'Harbour Lane Foods', String(recF1.client));

/* NOW queue the stale write in the other tab and close it immediately — well
 * inside the 800ms debounce, so the queue is still full when pagehide fires
 * and flushNow() is what sends it. Queue it first and wait, and the ordinary
 * debounced flush() drains it instead: the test then exercises the path that
 * was never broken and passes with the fix reverted, which is how the first
 * version of this case fooled me. */
await tabF.evaluate(() => {
  vyneStore.setItem('vynora_engagement_ENG-GSC6-Y7ME',
    vyneStore.getItem('vynora_engagement_ENG-GSC6-Y7ME'));   // pre-rename copy
});
await tabF.close({ runBeforeUnload: true });               // pagehide → flushNow()
await page.waitForTimeout(1200);
let recF2 = {};
try { recF2 = JSON.parse(WORKSPACE['vynora_engagement_' + CODE] || '{}'); } catch { /* asserted */ }
check('[F] closing the OTHER tab did not force its stale copy over the rename',
  recF2.client === 'Harbour Lane Foods', String(recF2.client));
check('[F] and the engagements row still agrees with it',
  DB.engagements.find((e) => e.id === 'e1').client_name === 'Harbour Lane Foods',
  DB.engagements.find((e) => e.id === 'e1').client_name);

/* ══ PART G — the revert that survived v5.32.95 ═════════════════════════════
 *
 * Reported after .95 shipped: still reverting.
 *
 * .95 made every write carry expectedVersions, so a stale copy of
 * vynora_engagement_<CODE> gets a 409. That is not a refusal. onVersionConflict()
 * answers a 409 by adopting the server's VERSION and re-queueing OUR value on
 * top of it, then retrying — and the retry succeeds. Correct for two people
 * editing a synthesis; for a pre-rename copy of a renamed record it means the
 * 409 delays the revert by one round trip and then lets it through.
 *
 * And the whole guard layer in scopeWorkspaceWrite() short-circuits on
 * `allowed === null`. The reporter is a firm OWNER, so none of it ever ran on
 * their writes. The name being reverted was their own second tab.
 *
 * The fix is not another guard. It is that the browser does not own the name:
 * enforceServerNames() overwrites it from engagements.client_name on the way
 * in, for every role, before scoping is even consulted. There is no race left
 * to win.
 */
seed();
await page.evaluate(() => {
  const s = JSON.parse(sessionStorage.getItem('vyne_session') || '{}');
  s.activeClient = 'Meridian Foods';
  sessionStorage.setItem('vyne_session', JSON.stringify(s));
});
await reload();

const tabG = await ctx.newPage();
tabG.on('pageerror', (e) => errors.push('[tabG] ' + String(e)));
await tabG.goto(`http://127.0.0.1:${PORT}/`);
await tabG.evaluate(() => {
  const s = JSON.parse(sessionStorage.getItem('vyne_session') || '{}');
  s.activeClient = 'Meridian Foods';
  sessionStorage.setItem('vyne_session', JSON.stringify(s));
});
await reload(tabG);

nextName = 'Ashgrove Provisions';
await page.evaluate(() => renameClientPrompt());     // tab 1 renames
await page.waitForTimeout(900);
check('[G] the rename landed', DB.engagements.find((e) => e.id === 'e1').client_name === 'Ashgrove Provisions',
  DB.engagements.find((e) => e.id === 'e1').client_name);

/* tab 2 now writes its pre-rename copy through the NORMAL debounced flush —
 * the path that 409s and then wins on retry. Given a full second, .95's
 * version check has been raised, conflicted, re-queued and retried. */
await tabG.evaluate(() => {
  const rec = JSON.parse(vyneStore.getItem('vynora_engagement_ENG-GSC6-Y7ME') || '{}');
  rec.client = 'Meridian Foods';                     // the stale name, explicitly
  rec.industry = 'Manufacturing (edited)';           // and a real edit alongside it
  vyneStore.setItem('vynora_engagement_ENG-GSC6-Y7ME', JSON.stringify(rec));
  return vyneStore.flush();
});
await tabG.waitForTimeout(2500);                     // long enough for the retry

let recG = {};
try { recG = JSON.parse(WORKSPACE['vynora_engagement_' + CODE] || '{}'); } catch { /* asserted */ }
check('[G] a stale tab cannot put the old name back, even by winning the retry',
  recG.client === 'Ashgrove Provisions', String(recG.client));
/* The point is that the NAME is server-owned — not that the tab's other work is
 * thrown away. Discarding real edits to win an argument about a display string
 * would be a worse bug than the one being fixed. */
check('[G] and that tab\'s genuine edit still landed',
  recG.industry === 'Manufacturing (edited)', String(recG.industry));

/* Same for the index: a stale copy re-introduces the OLD norm as a live entry,
 * which is the duplicate-index state that made renaming back impossible. */
await tabG.evaluate(() => {
  vyneStore.setItem('vynora_engagement_index', JSON.stringify({
    meridianfoods: 'ENG-GSC6-Y7ME',                  // the old norm, as a stale tab holds it
    nissanmotorscorporation: 'ENG-MCJQ-RBH3',
    regiscorporation: 'ENG-6GGM-ZTX7',
  }));
  return vyneStore.flush();
});
await tabG.waitForTimeout(2500);
let idxG = {};
try { idxG = JSON.parse(WORKSPACE.vynora_engagement_index || '{}'); } catch { /* asserted */ }
check('[G] a stale index write is rewritten to the current norm, not added alongside it',
  Object.keys(idxG).filter((n) => idxG[n] === CODE).join(',') === 'ashgroveprovisions',
  JSON.stringify(idxG));

await tabG.close();
/* The 409s above were the POINT of this section — a stale tab's writes being
 * version-checked is the system working. Cleared before the shared agreement
 * check, whose "no write was refused" assertion is about renames that should
 * never conflict, not about deliberately stale writes. */
check('[G] the stale writes were version-checked rather than silently accepted',
  conflictCount > 0, 'conflicts: ' + conflictCount);
conflictCount = 0;
await reload();
await assertAgreement('G → Ashgrove Provisions', 'Ashgrove Provisions',
  ['meridianfoods', 'ashgroveprovisions']);

check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
