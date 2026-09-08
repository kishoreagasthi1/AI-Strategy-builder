/**
 * END-TO-END TEST: the roadmap partition is PER ENGAGEMENT, and migrating to it
 * loses nothing (roadmap.html, v5.33.4).
 *
 *   node frontend/test/roadmap-split-e2e.mjs
 *
 * WHY THE SPLIT. `vynora_roadmap_state` held EVERY client's roadmap in one
 * value — byEng plus firm-wide assumptions/dependencies/generated maps — and
 * was rewritten WHOLE on every edit. A substantial engagement crosses 64 KiB,
 * which is the hard limit Chrome puts on a `keepalive` request body, and
 * vyneStore sent every save with keepalive: true. Result: "Not saved —
 * retrying" forever, and a morning of work gone. v5.33.1 fixed the keepalive
 * half (large-save-e2e.mjs pins it). This is the structural half: a save is now
 * the size of ONE engagement instead of the whole firm.
 *
 * WHY THIS FILE IS MOSTLY ABOUT MIGRATION. Re-addressing roadmap keys is
 * exactly what caused the v5.32.97 data loss — getEngKey() started writing to
 * 'unassigned' while readEngKeys() still looked for 'client_<norm>', so the
 * roadmap saved to one partition and read from another and every save
 * "succeeded". The lesson taken from that is that the interesting assertions
 * are not "the new key works" but "the OLD key is still found, and nothing is
 * destroyed on the way". Hence: read-both-ways, and the legacy blob is never
 * written and never deleted.
 *
 * REVERT TEST: point writeRoadmapPartition() back at ENGAGE_KEY and
 * "each engagement writes ONLY its own key" plus "a save carries one
 * engagement, not the firm" both fail.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8839;

const results = [];
const check = (name, ok, detail = '') => {
  let v = false;
  try { v = typeof ok === 'function' ? ok() : ok; }
  catch (e) { v = false; detail = detail || `threw: ${String(e).slice(0, 140)}`; }
  results.push({ name, ok: !!v, detail });
};

const A = { name: 'Northwind Freight', code: 'ENG-NWF1-0001', norm: 'northwindfreight' };
const B = { name: 'Harbourline Health', code: 'ENG-HBL2-0002', norm: 'harbourlinehealth' };

let STATE = {};
let puts = [];

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.startsWith('/api/module-state/')) {
    if (req.method === 'PUT') {
      let b = ''; req.on('data', (c) => b += c);
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(b); } catch { /* ignore */ }
        puts.push({ keys: Object.keys(body.sets || {}), bytes: Buffer.byteLength(b) });
        for (const [k, v] of Object.entries(body.sets || {})) STATE[k] = v;
        for (const k of body.deletes || []) delete STATE[k];
        json({ ok: true, versions: {} });
      });
      return;
    }
    return json({ module: 'workspace', state: STATE, versions: {} });
  }
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'c@firm.com' });
  if (url === '/api/clients') return json({ clients: [A.name, B.name] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url.startsWith('/api/llm')) return json({ text: '{}', finishReason: 'stop', provider: 'stub', model: 'stub', usage: {} });
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

const errors = [];
async function open(client) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForTimeout(1500);
  await page.evaluate(`currentClientName = ${JSON.stringify(client.name)}`);
  return page;
}

const INDEX = JSON.stringify({ [A.norm]: A.code, [B.norm]: B.code });

/* ── 1. A legacy blob holding TWO clients, exactly as v5.33.3 wrote it ────── */
STATE = {
  vynora_engagement_index: INDEX,
  vynora_roadmap_state: JSON.stringify({
    assumptions:  { ['eng_' + A.code]: { uc1: { a1: false } } },
    dependencies: { ['eng_' + A.code]: { uc1: { g1: ['d1'] } } },
    generated:    {},
    byEng: {
      ['eng_' + A.code]: {
        notes: { D1: 'Northwind: claims platform is three systems.' },
        selected: { n1: true, n2: true }, maturityScores: { D1: 2.4 },
        savedAt: '2026-08-15T09:00:00.000Z',
      },
      ['eng_' + B.code]: {
        notes: { D1: 'Harbourline: HARBOURLINE PRIVATE.' },
        selected: { h1: true }, maturityScores: { D1: 3.9 },
        savedAt: '2026-08-15T10:00:00.000Z',
      },
    },
  }),
};

{
  const page = await open(A);
  const got = await page.evaluate(`(() => {
    loadPersistentState();
    return {
      engKey: getEngKey(),
      notes: (notesState && notesState.D1) || null,
      selectedCount: Object.keys(selected || {}).filter(k => selected[k]).length,
      assumption: getAssumptionState ? null : null,
      deps: JSON.stringify(dependencyState['eng_' + ${JSON.stringify(A.code)}] || null),
    };
  })()`);
  check('a client still on the legacy blob loads its work',
    got.notes === 'Northwind: claims platform is three systems.' && got.selectedCount === 2,
    JSON.stringify(got));
  check('its dependency tags come across too',
    got.deps === JSON.stringify({ uc1: { g1: ['d1'] } }), String(got.deps));
  check('it never reads the other client’s partition',
    !JSON.stringify(got).includes('HARBOURLINE PRIVATE'), '');
  await page.close();
}

/* ── 2. Editing migrates it, and writes ONLY its own key ─────────────────── */
{
  puts = [];
  const page = await open(A);
  await page.evaluate(`(() => {
    loadPersistentState();
    notesState.D2 = 'Northwind: added after the split.';
    savePersistentState();
    return vyneStore.flush();
  })()`);
  await page.waitForTimeout(1200);

  const written = [...new Set(puts.flatMap((p) => p.keys))];
  check('the save goes to the per-engagement key',
    written.includes('vynora_roadmap_state_eng_' + A.code), written.join(', '));
  /* THE POINT OF THE WHOLE CHANGE. */
  check('each engagement writes ONLY its own key, never the shared blob',
    !written.includes('vynora_roadmap_state'), written.join(', '));

  const mine = JSON.parse(STATE['vynora_roadmap_state_eng_' + A.code] || '{}');
  check('a save carries one engagement, not the firm',
    JSON.stringify(mine).includes('Northwind') && !JSON.stringify(mine).includes('Harbourline'),
    Object.keys(mine).join(', '));
  check('only this engagement’s tag slice is persisted',
    Object.keys(mine.dependencies || {}).length === 1
      && !!mine.dependencies['eng_' + A.code],
    JSON.stringify(Object.keys(mine.dependencies || {})));

  /* NEVER DESTRUCTIVE. The blob is the fallback for every client that has not
   * been opened since the upgrade; deleting from it is how the v5.32.97 loss
   * happened, one shape removed at a time. */
  const blob = JSON.parse(STATE['vynora_roadmap_state'] || '{}');
  // `(blob.byEng || {})`, not `blob.byEng`: if a regression makes the save
  // overwrite the blob with the new per-engagement SHAPE, byEng is gone
  // entirely and a bare property read throws — which aborts the run instead of
  // reporting a failure. A test that crashes on the bug it exists to catch
  // still tells you something, but it tells you less, and later assertions
  // never run at all.
  check('the legacy blob is left completely intact',
    !!(blob.byEng || {})['eng_' + A.code] && !!(blob.byEng || {})['eng_' + B.code],
    'byEng holds: ' + Object.keys(blob.byEng || {}).join(', '));
  await page.close();
}

/* ── 3. The migrated client reloads from the NEW key ─────────────────────── */
{
  const page = await open(A);
  const got = await page.evaluate(`(() => {
    loadPersistentState();
    return { d1: (notesState||{}).D1 || null, d2: (notesState||{}).D2 || null,
             n: Object.keys(selected||{}).filter(k => selected[k]).length,
             deps: JSON.stringify(dependencyState['eng_' + ${JSON.stringify(A.code)}] || null) };
  })()`);
  check('the new edit survives the reload',
    got.d2 === 'Northwind: added after the split.', String(got.d2));
  check('and so does everything that came from the blob',
    got.d1 === 'Northwind: claims platform is three systems.' && got.n === 2,
    JSON.stringify(got));
  check('dependency tags survive the migration round-trip',
    got.deps === JSON.stringify({ uc1: { g1: ['d1'] } }), String(got.deps));
  await page.close();
}

/* ── 4. The OTHER client, never opened since the upgrade, is untouched ───── */
{
  const page = await open(B);
  const got = await page.evaluate(`(() => {
    loadPersistentState();
    return { notes: (notesState||{}).D1 || null,
             n: Object.keys(selected||{}).filter(k => selected[k]).length };
  })()`);
  check('a client that has NOT been opened since the upgrade still loads',
    got.notes === 'Harbourline: HARBOURLINE PRIVATE.' && got.n === 1, JSON.stringify(got));
  check('and it did not inherit the migrated client’s work',
    !String(got.notes).includes('Northwind'), String(got.notes));
  await page.close();
}

/* ── 5. A brand-new engagement never touches the blob at all ─────────────── */
{
  STATE = { vynora_engagement_index: INDEX };
  puts = [];
  const page = await open(B);
  await page.evaluate(`(() => {
    loadPersistentState();
    notesState.D1 = 'Fresh start, no legacy blob present.';
    savePersistentState();
    return vyneStore.flush();
  })()`);
  await page.waitForTimeout(1200);
  const written = [...new Set(puts.flatMap((p) => p.keys))];
  check('a fresh engagement writes only its own partition',
    written.includes('vynora_roadmap_state_eng_' + B.code)
      && !written.includes('vynora_roadmap_state'), written.join(', '));
  check('no empty shared blob is created',
    STATE['vynora_roadmap_state'] === undefined, String(STATE['vynora_roadmap_state']));
  await page.close();
}

/* ── 6. The size claim, measured rather than asserted ────────────────────── */
{
  STATE = { vynora_engagement_index: INDEX };
  const page = await open(A);
  // Twelve clients' worth of partitions in the OLD shape, versus this client's
  // own key in the new one.
  const sizes = await page.evaluate(`(() => {
    var big = {};
    for (var i = 0; i < 12; i++) {
      big['eng_ENG-FAKE-' + i] = { notes: {}, selected: {} };
      for (var j = 0; j < 200; j++) big['eng_ENG-FAKE-' + i].notes['D' + j] = 'x'.repeat(200);
    }
    var oldShape = JSON.stringify({ assumptions:{}, dependencies:{}, generated:{}, byEng: big });
    loadPersistentState();
    for (var j = 0; j < 200; j++) notesState['D' + j] = 'x'.repeat(200);
    savePersistentState();
    var mineKey = 'vynora_roadmap_state_' + getEngKey();
    return { old: oldShape.length, mine: (vyneStore.getItem(mineKey) || '').length };
  })()`);
  check('one engagement’s save is a fraction of the firm-wide blob',
    sizes.mine > 0 && sizes.mine < sizes.old / 8,
    `firm-wide ${sizes.old} bytes vs this engagement ${sizes.mine}`);
  /* 64 KiB is the ceiling that cost the Humana session. */
  check('and it stays under the 64 KiB keepalive ceiling at this scale',
    sizes.mine < 64 * 1024, sizes.mine + ' bytes');
  await page.close();
}

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
