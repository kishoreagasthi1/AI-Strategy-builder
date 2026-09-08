/**
 * END-TO-END TEST: "Clear" removes ONE engagement, and the version banner
 * (synthesis.html + vyne-client.js, v5.33.4).
 *
 *   node frontend/test/scoped-clear-e2e.mjs
 *
 * ── clearAllData ───────────────────────────────────────────────────────────
 *
 * It deleted every vynora_* key in the FIRM's cloud workspace — every client's
 * briefings, interviews, transcripts, roadmaps, scores and snapshots — from a
 * button sitting next to "Export Snapshot" on a screen that otherwise operates
 * entirely on the client named in the box above it. The confirm text said so,
 * which is not the same as it being what anyone wanted.
 *
 * The key set is DERIVED from the engagement's own identity as a key suffix
 * rather than listed family by family, because a hand-maintained family list is
 * exactly what has gone stale three times running (v5.32.25, v5.33.0's five
 * roadmap families, v5.33.3's vynora_memory_). The assertions below are
 * therefore mostly about what must SURVIVE.
 *
 * ── the version banner ─────────────────────────────────────────────────────
 *
 * The frontend is static files on Firebase Hosting; the API is a Cloud Run
 * revision. Two deploy commands, so a browser can run one version against the
 * other. It happened: the API was on 5.33.0 while the page said 5.32.97, and
 * the reported symptom was "I lose my work each time" — a debugging session
 * spent on a bug already fixed in code neither of us was running.
 *
 * REVERT TESTS
 *   · make clearAllData() delete everything again → the four SURVIVES cases fail
 *   · delete checkVersionSkew()                   → the banner cases fail
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8841;

const results = [];
const check = (name, ok, detail = '') => {
  let v = false;
  try { v = typeof ok === 'function' ? ok() : ok; }
  catch (e) { v = false; detail = detail || `threw: ${String(e).slice(0, 140)}`; }
  results.push({ name, ok: !!v, detail });
};

const MINE  = { name: 'Northwind Freight',  code: 'ENG-NWF1-0001', norm: 'northwindfreight' };
const OTHER = { name: 'Harbourline Health', code: 'ENG-HBL2-0002', norm: 'harbourlinehealth' };

let STATE = {};
let API_VERSION = null;   // set per scenario

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/version') return json({ version: API_VERSION, env: 'test' });
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
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'c@firm.com' });
  if (url === '/api/clients') return json({ clients: [MINE.name, OTHER.name] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/interviews') return json({ interviews: [] });
  if (url.startsWith('/api/llm')) return json({ text: '{}', finishReason: 'stop', provider: 'stub', model: 'stub', usage: {} });
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
await ctx.addInitScript(`
  try { sessionStorage.setItem('vyne_session', JSON.stringify({
    token: 'tok', email: 'c@firm.com', role: 'owner', mode: 'dev',
    at: Date.now(), la: Date.now() })); } catch (e) {}
`);

const errors = [];
async function open() {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());          // the confirm()
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForTimeout(1600);
  return page;
}

function seed() {
  return {
    vynora_engagement_index: JSON.stringify({ [MINE.norm]: MINE.code, [OTHER.norm]: OTHER.code }),

    // ── mine, across every addressing shape in the product ──
    ['vynora_engagement_' + MINE.code]:        JSON.stringify({ code: MINE.code, client: MINE.name }),
    ['vynora_briefing_' + MINE.norm]:          JSON.stringify({ client: MINE.name }),
    ['vynora_synthesis_full_' + MINE.code]:    JSON.stringify({ synthesis: 'mine' }),
    ['vynora_roadmap_state_eng_' + MINE.code]: JSON.stringify({ entry: { notes: { D1: 'mine' } } }),
    ['vynora_dim_gaps_client_' + MINE.norm]:   JSON.stringify({ g: 1 }),
    ['vynora_memory_' + MINE.code]:            JSON.stringify({ byPerson: {} }),
    vynora_session_s1:                          JSON.stringify({ client: MINE.name, stakeholderRole: 'CTO' }),

    // ── the other client's, which must all survive ──
    ['vynora_engagement_' + OTHER.code]:        JSON.stringify({ code: OTHER.code, client: OTHER.name }),
    ['vynora_briefing_' + OTHER.norm]:          JSON.stringify({ client: OTHER.name }),
    ['vynora_synthesis_full_' + OTHER.code]:    JSON.stringify({ synthesis: 'theirs' }),
    ['vynora_roadmap_state_eng_' + OTHER.code]: JSON.stringify({ entry: { notes: { D1: 'theirs' } } }),
    vynora_session_s2:                          JSON.stringify({ client: OTHER.name, stakeholderRole: 'CFO' }),

    // ── firm-wide, not any one client's ──
    vynora_deck_mode: 'internal',
    vynora_roadmap_state: JSON.stringify({
      byEng: {
        ['eng_' + MINE.code]:  { notes: { D1: 'mine legacy' } },
        ['eng_' + OTHER.code]: { notes: { D1: 'theirs legacy' } },
      },
    }),
  };
}

/* ── Clearing one engagement ─────────────────────────────────────────────── */
{
  STATE = seed();
  API_VERSION = null;   // /api/version returns null → banner must stay silent
  const page = await open();
  const out = await page.evaluate(`(() => {
    document.getElementById('client-input').value = ${JSON.stringify(MINE.name)};
    clearAllData();
    return { keys: vyneStore.keys().filter(k => k.indexOf('vynora_') === 0).sort() };
  })()`);
  await page.evaluate(`vyneStore.flush()`);
  await page.waitForTimeout(900);

  const has = (k) => out.keys.includes(k);

  check('the named client’s engagement record is gone',
    !has('vynora_engagement_' + MINE.code), '');
  check('...its briefing (norm-addressed) is gone',
    !has('vynora_briefing_' + MINE.norm), '');
  check('...its synthesis (code-addressed) is gone',
    !has('vynora_synthesis_full_' + MINE.code), '');
  check('...its roadmap partition (eng_<CODE>) is gone',
    !has('vynora_roadmap_state_eng_' + MINE.code), '');
  check('...its gap analysis (client_<norm>) is gone',
    !has('vynora_dim_gaps_client_' + MINE.norm), '');
  check('...its memory blob is gone',
    !has('vynora_memory_' + MINE.code), '');
  check('...and its interview session, matched by the client INSIDE it',
    !has('vynora_session_s1'), '');

  /* THE FINDING. Everything below is another client's work. */
  check('SURVIVES: the other client’s engagement record',
    has('vynora_engagement_' + OTHER.code), out.keys.join(', '));
  check('SURVIVES: the other client’s briefing and synthesis',
    has('vynora_briefing_' + OTHER.norm) && has('vynora_synthesis_full_' + OTHER.code), '');
  check('SURVIVES: the other client’s roadmap partition',
    has('vynora_roadmap_state_eng_' + OTHER.code), '');
  check('SURVIVES: the other client’s interview session',
    has('vynora_session_s2'), '');
  check('SURVIVES: firm-wide settings that belong to nobody',
    has('vynora_deck_mode'), '');

  // The shared index and blob are edited ENTRY-WISE, never removed whole.
  const idx = JSON.parse(STATE['vynora_engagement_index'] || '{}');
  check('the shared index loses only this client’s entry',
    idx[MINE.norm] === undefined && idx[OTHER.norm] === OTHER.code, JSON.stringify(idx));
  const blob = JSON.parse(STATE['vynora_roadmap_state'] || '{}');
  check('the legacy roadmap blob loses only this client’s partition',
    !(blob.byEng || {})['eng_' + MINE.code] && !!(blob.byEng || {})['eng_' + OTHER.code],
    JSON.stringify(Object.keys(blob.byEng || {})));

  await page.close();
}

/* ── It refuses to run with no client named ──────────────────────────────── */
{
  STATE = seed();
  const page = await open();
  const before = await page.evaluate(`vyneStore.keys().length`);
  await page.evaluate(`(() => {
    document.getElementById('client-input').value = '';
    clearAllData();
  })()`);
  const after = await page.evaluate(`vyneStore.keys().length`);
  check('with no client named it deletes nothing at all', before === after,
    before + ' → ' + after);
  await page.close();
}

/* ── Two clients whose norms are substrings of one another ───────────────── */
{
  /* "Wind Freight" normalizes to windfreight, which is a SUFFIX of
   * northwindfreight. A bare endsWith() would take both. The leading
   * underscore on every suffix is what prevents it — asserted, because it is
   * one character and reads like an accident. */
  STATE = {
    vynora_engagement_index: JSON.stringify({ northwindfreight: 'ENG-A', windfreight: 'ENG-B' }),
    'vynora_briefing_northwindfreight': JSON.stringify({ client: 'Northwind Freight' }),
    'vynora_briefing_windfreight':      JSON.stringify({ client: 'Wind Freight' }),
  };
  const page = await open();
  const keys = await page.evaluate(`(() => {
    document.getElementById('client-input').value = 'Wind Freight';
    clearAllData();
    return vyneStore.keys().filter(k => k.indexOf('vynora_briefing_') === 0).sort();
  })()`);
  check('clearing "Wind Freight" does not take "Northwind Freight"',
    keys.length === 1 && keys[0] === 'vynora_briefing_northwindfreight', keys.join(', '));
  await page.close();
}

/* ── The version banner ──────────────────────────────────────────────────── */
{
  STATE = seed();
  API_VERSION = '9.9.9';                       // deliberately not the page's
  const page = await open();
  await page.waitForTimeout(900);
  const bar = await page.evaluate(`(() => {
    var el = document.getElementById('vyne-version-skew');
    return el ? { text: el.textContent, buttons: el.querySelectorAll('button').length } : null;
  })()`);
  check('a version mismatch raises a banner', !!bar, String(bar));
  check('it names BOTH versions, so the stale side is identifiable',
    !!bar && bar.text.includes('9.9.9') && /v5\.\d+\.\d+/.test(bar.text), bar && bar.text);
  check('it offers Reload and Dismiss rather than blocking',
    !!bar && bar.buttons === 2, bar && String(bar.buttons));

  /* Guarded, so a missing banner reports a FAILURE rather than throwing and
   * aborting the run before the "matching versions are silent" cases — which
   * are the ones that would catch the opposite regression. */
  const dismissed = await page.evaluate(`(() => {
    var el = document.getElementById('vyne-version-skew');
    if (!el) return 'NO BANNER';
    var btns = el.querySelectorAll('button');
    if (btns.length < 2) return 'NO DISMISS BUTTON';
    btns[1].click();
    return !!document.getElementById('vyne-version-skew');
  })()`);
  check('Dismiss removes it', dismissed === false, String(dismissed));
  await page.close();
}

{
  /* The normal case, and the one that matters most: matching versions must be
   * SILENT. A banner that shows on every load is a banner nobody reads. */
  const pageVersion = await (async () => {
    const src = readFileSync(join(DIR, 'vyne-client.js'), 'utf8');
    return (src.match(/var VYNE_VERSION = "([^"]+)"/) || [])[1];
  })();
  STATE = seed();
  API_VERSION = pageVersion;
  const page = await open();
  await page.waitForTimeout(900);
  const bar = await page.evaluate(`!!document.getElementById('vyne-version-skew')`);
  check('matching versions show NO banner', bar === false, 'API said ' + pageVersion);
  await page.close();
}

{
  /* An unreachable /api/version must not raise anything either — the save pill
   * already reports connectivity, and far more usefully. */
  STATE = seed();
  API_VERSION = undefined;                     // handler returns {version: undefined}
  const page = await open();
  await page.waitForTimeout(900);
  const bar = await page.evaluate(`!!document.getElementById('vyne-version-skew')`);
  check('an unusable /api/version response is silent, not alarming', bar === false, '');
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
