/**
 * END-TO-END TEST: roadmap work must come back after a reload, even when the
 * browser cannot resolve the engagement code (roadmap.html, v5.32.99).
 *
 *   node frontend/test/roadmap-partition-e2e.mjs
 *
 * THE DATA LOSS. v5.32.97 re-addressed per-client keys by engagement code and,
 * in doing so, changed getEngKey()'s no-code fallback from 'client_<norm>' to
 * 'unassigned'. readEngKeys() — the READ path added in the same change — looks
 * for 'client_<norm>' and never looked at 'unassigned' while a client name was
 * set. So the roadmap SAVED to one partition and READ from another.
 *
 * Reported from production: a full session of work — use-case selection,
 * confirmed implementation stages, gap analysis — gone after the app timed out.
 * The timeout was incidental; it was simply when the page next reloaded and
 * read the wrong key. Every save had "succeeded".
 *
 * WHEN NO CODE RESOLVES. currentEngagementCode() reads
 * vynora_engagement_index[normClient(currentClientName)]. A client worked on in
 * Roadmap before Pre-Engagement has written that index entry — which is exactly
 * what happens with a freshly generated industry catalog — has no entry, so the
 * fallback IS the live path for that session, not an edge case.
 *
 * WHY THE EXISTING SUITES MISSED IT. Every other roadmap test seeds
 * vynora_engagement_index with the client, so getEngKey() always resolves a
 * code and the fallback branch never executes. All five roadmap suites passed
 * against this bug, before and after the fix. This file exists to make the
 * fallback path the thing under test.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8831;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

/* NO vynora_engagement_index entry for this client — the whole point. */
let STATE = {};
const CLIENT = 'Harbourline Health';

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
  if (url === '/api/clients') return json({ clients: [CLIENT] });
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
    activeClient: ${JSON.stringify(CLIENT)}, at: Date.now(), la: Date.now() })); } catch (e) {}
`);

const pageErrors = [];
async function open() {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForTimeout(1600);
  return page;
}

// ── A session of real work, with no engagement code available ──────────────
{
  const page = await open();
  const info = await page.evaluate(`(() => {
    currentClientName = ${JSON.stringify(CLIENT)};
    var ucs = getAllUcs();
    var picked = ucs.slice(0, 3).map(function(u){ return u.id; });
    picked.forEach(function(id){ selected[id] = true; });
    notesState = { D1: 'Claims platform is three systems stitched together.' };
    maturityScores = { D1: 2.4, D2: 1.8 };
    savePersistentState();
    return { code: currentEngagementCode(), engKey: getEngKey(), picked: picked };
  })()`);
  check('the browser genuinely cannot resolve a code for this client',
    info.code === null, String(info.code));
  /* The assertion the bug turned on. 'unassigned' is a SHARED bucket the server
   * denies for restricted consultants, and nothing reads it back per-client. */
  check('with no code, work is still saved under THIS CLIENT, not a shared bucket',
    info.engKey === 'client_harbourlinehealth', info.engKey);
  await page.evaluate(`vyneStore.flush()`);
  await page.waitForTimeout(1000);
  globalThis.__picked = info.picked;
  await page.close();
}

// ── The reload. This is where a morning of work disappeared ────────────────
{
  const page = await open();
  const after = await page.evaluate(`(() => {
    currentClientName = ${JSON.stringify(CLIENT)};
    loadPersistentState();
    return {
      engKey: getEngKey(),
      selectedCount: Object.keys(selected || {}).filter(function(k){ return selected[k]; }).length,
      notes: (notesState && notesState.D1) || null,
    };
  })()`);
  check('the use-case selection survives the reload',
    after.selectedCount === 3, after.selectedCount + ' selected');
  check('the dimension notes survive the reload',
    after.notes === 'Claims platform is three systems stitched together.', String(after.notes));
  /* NOT asserting maturityScores here. savePersistentState() writes them into
   * the partition but loadPersistentState() never reads them back — the scores
   * come from the engagement record via the engagement-score loader instead.
   * That redundancy is pre-existing and separate from this bug; asserting it
   * here would make this file fail for a reason it does not name. */
  check('the partition that was written is the one that was read',
    after.engKey === 'client_harbourlinehealth', after.engKey);
  await page.close();
}

// ── Recovery: work ALREADY stranded under 'unassigned' by v5.32.97/.98 ─────
{
  STATE = {};
  const stranded = {
    byEng: {
      unassigned: {
        selected: { 'x1': true, 'x2': true },
        notes: { D1: 'Stranded by v5.32.97.' },
        maturityScores: { D1: 3.1 },
        savedAt: '2026-08-15T12:00:00.000Z',
      },
    },
  };
  STATE['vynora_roadmap_state'] = JSON.stringify(stranded);
  const page = await open();
  const rec = await page.evaluate(`(() => {
    currentClientName = ${JSON.stringify(CLIENT)};
    loadPersistentState();
    return {
      selectedCount: Object.keys(selected || {}).filter(function(k){ return selected[k]; }).length,
      notes: (notesState && notesState.D1) || null,
    };
  })()`);
  check('work already stranded under "unassigned" is recovered, not abandoned',
    rec.selectedCount === 2 && rec.notes === 'Stranded by v5.32.97.', JSON.stringify(rec));
  await page.close();
}

check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
server.close();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
