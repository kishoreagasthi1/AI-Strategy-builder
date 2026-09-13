/**
 * END-TO-END TEST: one client's roadmap must never appear under another's
 * (roadmap.html, v5.32.74).
 *
 *   node frontend/test/roadmap-client-isolation-e2e.mjs
 *
 * THE LEAK. loadPersistentState read
 *     (mine && mine.synthesis) || parsed.synthesis || null
 * where `mine` is the per-engagement slice and `parsed.synthesis` is a FLAT slot
 * carrying no client identity — and savePersistentState rewrote that flat slot
 * with the current client's synthesis on every single save. It was therefore a
 * live copy of "whoever was worked on last", and any engagement without its own
 * byEng entry inherited it.
 *
 * Observed in production: a new Meridian Foods engagement opened Roadmap &
 * Synthesis already populated with a different client's synthesis from a
 * different industry, instead of waiting for Synthesize.
 *
 * WHY THIS IS NOT COSMETIC. synthesisResult and ganttData feed the Strategy Deck
 * export. A consultant could export a deck titled for one client containing
 * another client's synthesis, and hand it to them. The server already treats
 * these slots as untrustworthy — filterRoadmapState() drops them for
 * client-scoped consultants precisely because they are unattributable. An owner
 * has no such filter, so the owner is the one person the leak reached.
 *
 * The test drives the page's REAL save and load against a REAL server that
 * persists what it is sent, across a REAL page reload, with two clients in two
 * industries. A test that called loadPersistentState() twice in one page would
 * miss the reload path entirely.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8815;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const engagement = (code, client, industry) => JSON.stringify({
  code, client, industry, currentRoundId: 'r1',
  rounds: [{ roundId: 'r1', roundNumber: 1, label: 'Initial', status: 'complete',
    date: '2026-08-01', scores: { D1: 2.6 }, interviews: [] }],
});

/* Two clients, two industries — the exact shape of the report. */
const baseState = () => ({
  vynora_engagement_index: JSON.stringify({
    northreachlogistics: 'NRL01', meridianfoods: 'MFD01',
  }),
  vynora_engagement_NRL01: engagement('NRL01', 'Northreach Logistics', 'Logistics'),
  vynora_engagement_MFD01: engagement('MFD01', 'Meridian Foods', 'Food & Beverages'),
});

let STATE = baseState();

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.startsWith('/api/llm')) {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => json({ text: '{}', finishReason: 'stop', provider: 'stub', model: 'stub',
      usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0 } }));
    return;
  }
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'c@firm.com' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url.startsWith('/api/module-state/')) {
    if (req.method === 'PUT') {
      let b = ''; req.on('data', (c) => b += c);
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(b); } catch { /* ignore */ }
        for (const [k, v] of Object.entries(body.sets || {})) STATE[k] = v;
        for (const k of body.deletes || []) delete STATE[k];
        json({ ok: true, versions: {} });
      });
      return;
    }
    return json({ module: 'workspace', state: STATE, versions: {} });
  }
  if (url === '/api/clients') return json({ clients: ['Northreach Logistics', 'Meridian Foods'] });
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
    token: 'tok', email: 'c@firm.com', role: 'owner', mode: 'dev',
    at: Date.now(), la: Date.now() })); } catch (e) {}
`);

const pageErrors = [];
async function open() {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForTimeout(1600);
  return page;
}

const SECRET = 'Northreach should consolidate its three regional TMS instances before any AI work.';

// ── Client A does real work ────────────────────────────────────────────────
{
  const page = await open();
  const saved = await page.evaluate(`(() => {
    applyEngagementByCode('NRL01');
    synthesisResult = { summary: ${JSON.stringify(SECRET)}, industry: 'Logistics' };
    ganttData = { bars: [{ name: 'TMS consolidation', start: 0, len: 6 }] };
    notesState = { D1: 'Three separate TMS instances.' };
    savePersistentState();
    return { client: currentClientName, engKey: getEngKey() };
  })()`);
  check('client A loaded and saved under its own engagement key',
    saved.client === 'Northreach Logistics' && saved.engKey === 'eng_NRL01',
    JSON.stringify(saved));
  await page.evaluate(`vyneStore.flush()`);
  await page.waitForTimeout(1000);
  await page.close();
}

// The server's own copy is the ground truth for what leaked.
/*
 * v5.33.4: the roadmap partition moved OUT of the firm-wide
 * `vynora_roadmap_state` blob and into one key per engagement,
 * `vynora_roadmap_state_<engKey>` (roadmap-split-e2e.mjs covers the move and
 * its migration). The property this case is about has not changed — client A's
 * synthesis must be stored ATTRIBUTED to client A — only where "attributed"
 * now lives. Accepting BOTH shapes rather than swapping to the new one: this
 * file also seeds legacy blobs further down to prove they still load, and a
 * check that only understood the new location would go quiet on exactly the
 * tenants that have not migrated yet.
 */
check('client A’s synthesis is stored ATTRIBUTED to client A',
  (() => { try {
    const own = JSON.parse(STATE['vynora_roadmap_state_eng_NRL01'] || 'null');
    if (own && own.entry && own.entry.synthesis) return true;
    const st = JSON.parse(STATE['vynora_roadmap_state'] || '{}');
    return !!(st.byEng && st.byEng.eng_NRL01 && st.byEng.eng_NRL01.synthesis);
  } catch { return false; } })(),
  'keys: ' + Object.keys(STATE).filter((k) => k.indexOf('vynora_roadmap_state') === 0).join(', '));

/* And the other half of attribution, which the split makes checkable in a way
 * it was not before: client B's key must not exist at all yet. */
check('nothing was written under any OTHER engagement’s partition',
  Object.keys(STATE).filter((k) => k.indexOf('vynora_roadmap_state_') === 0)
    .every((k) => k === 'vynora_roadmap_state_eng_NRL01'),
  Object.keys(STATE).filter((k) => k.indexOf('vynora_roadmap_state_') === 0).join(', '));

check('and NOT copied into the unattributed flat slots',
  (() => { try {
    const st = JSON.parse(STATE['vynora_roadmap_state'] || '{}');
    return !st.synthesis && !st.gantt && !st.notes;
  } catch { return false; } })(),
  'flat keys present: ' + Object.keys(JSON.parse(STATE['vynora_roadmap_state'] || '{}'))
    .filter((k) => ['notes', 'synthesis', 'gantt'].includes(k)).join(', '));

// ── Client B, brand new, must be BLANK ─────────────────────────────────────
{
  const page = await open();
  const b = await page.evaluate(`(() => {
    applyEngagementByCode('MFD01');
    showTab('roadmap');
    return {
      client: currentClientName,
      engKey: getEngKey(),
      synthesis: synthesisResult,
      gantt: ganttData,
      notes: notesState,
      bodyText: document.getElementById('view-roadmap') ? document.getElementById('view-roadmap').textContent : '',
    };
  })()`);
  check('client B is the loaded engagement',
    b.client === 'Meridian Foods' && b.engKey === 'eng_MFD01', JSON.stringify({ c: b.client, k: b.engKey }));
  check('THE LEAK: client B’s synthesis is BLANK, not client A’s',
    b.synthesis === null, JSON.stringify(b.synthesis));
  check('client B’s Gantt is blank too — it feeds the same deck export',
    b.gantt === null, JSON.stringify(b.gantt));
  check('and client B’s notes are blank',
    !b.notes || Object.keys(b.notes).length === 0, JSON.stringify(b.notes));
  check('client A’s words appear NOWHERE on client B’s roadmap tab',
    b.bodyText.indexOf('Northreach') === -1 && b.bodyText.indexOf('TMS') === -1,
    b.bodyText.slice(0, 200));
  await page.close();
}

// ── Client A must still have its own work ──────────────────────────────────
{
  const page = await open();
  const a = await page.evaluate(`(() => {
    applyEngagementByCode('NRL01');
    return { synthesis: synthesisResult, gantt: ganttData, notes: notesState };
  })()`);
  check('the fix did not cost client A its work — attribution still loads',
    !!(a.synthesis && a.synthesis.summary === SECRET), JSON.stringify(a.synthesis));
  check('client A’s Gantt and notes survived too',
    !!(a.gantt && a.gantt.bars) && !!(a.notes && a.notes.D1), JSON.stringify({ g: a.gantt, n: a.notes }));
  await page.close();
}

// ── THE UPGRADE CASE: flat slots ALREADY populated, as production's are ────
{
  /*
   * This is the case the first version of this file missed, and the miss is
   * instructive. Removing the WRITE means the flat slots never get populated
   * during the test's own flow, so restoring the READ fallback broke nothing
   * and the suite stayed green — two fixes masking each other.
   *
   * Every existing firm's stored state ALREADY has those slots filled by the
   * old build. So the upgrade path is: flat slots present, client A attributed
   * under byEng, client B opening for the first time. That is exactly the
   * production situation, and it must be blank.
   */
  STATE = baseState();
  STATE['vynora_roadmap_state'] = JSON.stringify({
    byEng: { eng_NRL01: { synthesis: { summary: SECRET }, gantt: { bars: [{ name: 'TMS' }] },
                          notes: { D1: 'Three separate TMS instances.' } } },
    // Written by every pre-v5.32.74 save. Unattributed, and A's.
    synthesis: { summary: SECRET },
    gantt: { bars: [{ name: 'TMS consolidation', start: 0, len: 6 }] },
    notes: { D1: 'Three separate TMS instances.' },
  });
  const page = await open();
  const LEGACY_SHAPE = JSON.stringify({
    byEng: { eng_NRL01: { synthesis: { summary: SECRET }, gantt: { bars: [{ name: 'TMS' }] },
                          notes: { D1: 'Three separate TMS instances.' } } },
    synthesis: { summary: SECRET },
    gantt: { bars: [{ name: 'TMS consolidation', start: 0, len: 6 }] },
    notes: { D1: 'Three separate TMS instances.' },
  });
  const upgraded = await page.evaluate(`(() => {
    applyEngagementByCode('MFD01');
    /* Re-seed the PRE-UPGRADE shape and read again, deliberately.
       applyEngagementByCode triggers a save on the way through, and since
       v5.32.74 no longer writes the flat slots, that save strips them — which
       would mask the very fallback under test. Restoring the on-disk shape
       immediately before the read is the only way to exercise it. */
    vyneStore.setItem('vynora_roadmap_state', ${JSON.stringify(LEGACY_SHAPE)});
    loadPersistentState();
    showTab('roadmap');
    return { synthesis: synthesisResult, gantt: ganttData, notes: notesState,
             bodyText: (document.getElementById('view-roadmap')||{}).textContent || '' };
  })()`);
  check('UPGRADE: legacy flat slots on disk do NOT bleed into a new client',
    upgraded.synthesis === null && upgraded.gantt === null,
    JSON.stringify({ s: upgraded.synthesis, g: upgraded.gantt }));
  check('UPGRADE: and none of client A’s words reach client B’s screen',
    upgraded.bodyText.indexOf('Northreach') === -1 && upgraded.bodyText.indexOf('TMS') === -1,
    upgraded.bodyText.slice(0, 160));

  // Client A, who legitimately owns that content, still sees it.
  const stillA = await page.evaluate(`(() => {
    applyEngagementByCode('NRL01');
    return { synthesis: synthesisResult };
  })()`);
  check('UPGRADE: client A still sees their own attributed synthesis',
    !!(stillA.synthesis && stillA.synthesis.summary === SECRET), JSON.stringify(stillA.synthesis));
  await page.close();
}

// ── The attribution rule itself, asserted directly ─────────────────────────
{
  /* adoptLegacyFlatState decides whether unattributed data may be believed.
     Driving it through a page load leaves too much room for some other reset to
     mask the answer — which is what happened when disabling its ambiguity guard
     failed nothing. Call it directly. */
  STATE = baseState();
  const page = await open();
  const rule = await page.evaluate(`(() => {
    const flat = { synthesis: { summary: 'AMBIGUOUS' } };
    return {
      twoEngagements: adoptLegacyFlatState(flat, 'eng_MFD01'),
      withByEng: adoptLegacyFlatState(
        { synthesis: { summary: 'X' }, byEng: { eng_NRL01: {} } }, 'eng_NRL01'),
      nothingToAdopt: adoptLegacyFlatState({}, 'eng_MFD01'),
    };
  })()`);
  check('RULE: two engagements on record — legacy data is refused',
    rule.twoEngagements === null, JSON.stringify(rule.twoEngagements));
  check('RULE: once ANY engagement has attributed state, flat data is refused',
    rule.withByEng === null, JSON.stringify(rule.withByEng));

  await page.close();
}

// ── The byEng guard, on its own, with a SOLE engagement ───────────────────
{
  /*
   * The byEng guard needs its own case AND its own server state. Asserted
   * against the two-engagement index above, removing the guard still returned
   * null via the codes check — the assertion could not tell the two rules
   * apart. With a SINGLE engagement the codes check passes, so byEng-is-empty
   * is the only thing left standing.
   *
   * It also needs its own STATE because the first attempt set the index with
   * vyneStore.setItem from inside the page — which FLUSHED to the shared server
   * asynchronously and landed after the next block had reset it, making a later
   * assertion fail intermittently. Mutating shared state from a rule check is
   * how a suite becomes order-dependent.
   */
  STATE = {
    vynora_engagement_index: JSON.stringify({ meridianfoods: 'MFD01' }),
    vynora_engagement_MFD01: engagement('MFD01', 'Meridian Foods', 'Food & Beverages'),
  };
  const page = await open();
  const soleIndexRule = await page.evaluate(`(() => ({
    byEngEmpty: adoptLegacyFlatState({ synthesis: { summary: 'LEGACY' } }, 'eng_MFD01'),
    byEngUsed:  adoptLegacyFlatState(
      { synthesis: { summary: 'LEGACY' }, byEng: { eng_MFD01: { synthesis: { summary: 'REAL' } } } },
      'eng_MFD01'),
  }))()`);
  check('RULE: sole engagement + NO attributed state anywhere — adopt',
    !!(soleIndexRule.byEngEmpty && soleIndexRule.byEngEmpty.synthesis),
    JSON.stringify(soleIndexRule.byEngEmpty));
  check('RULE: sole engagement but byEng ALREADY used — refuse, the flat copy is stale',
    soleIndexRule.byEngUsed === null, JSON.stringify(soleIndexRule.byEngUsed));
  await page.close();
}

// ── Pre-v5.7 data: adopted only when it cannot belong to anyone else ───────
{
  // TWO engagements + flat-only state = ambiguous. Must NOT be adopted.
  STATE = baseState();
  STATE['vynora_roadmap_state'] = JSON.stringify({
    synthesis: { summary: 'LEGACY AMBIGUOUS CONTENT' }, gantt: { bars: [] }, notes: { D1: 'x' },
  });
  const page = await open();
  const amb = await page.evaluate(`(() => {
    applyEngagementByCode('MFD01');
    return { synthesis: synthesisResult };
  })()`);
  check('ambiguous legacy state is refused — two engagements, no way to know whose',
    amb.synthesis === null, JSON.stringify(amb.synthesis));
  await page.close();
}
{
  // ONE engagement + flat-only state = unambiguous. Must be adopted, or a
  // pre-v5.7 firm silently loses its only copy.
  STATE = {
    vynora_engagement_index: JSON.stringify({ meridianfoods: 'MFD01' }),
    vynora_engagement_MFD01: engagement('MFD01', 'Meridian Foods', 'Food & Beverages'),
    vynora_roadmap_state: JSON.stringify({
      synthesis: { summary: 'LEGACY SOLE-ENGAGEMENT CONTENT' }, gantt: { bars: [] },
    }),
  };
  const page = await open();
  const sole = await page.evaluate(`(() => {
    applyEngagementByCode('MFD01');
    return { synthesis: synthesisResult };
  })()`);
  check('unambiguous legacy state IS adopted — one engagement, it can only be theirs',
    !!(sole.synthesis && sole.synthesis.summary === 'LEGACY SOLE-ENGAGEMENT CONTENT'),
    JSON.stringify(sole.synthesis));
  await page.close();
}

check('roadmap.html threw nothing', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
server.close();

console.log('\n=== ROADMAP CLIENT ISOLATION END-TO-END ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n        ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
