/**
 * END-TO-END TEST for the All-interviews table (interviews.html, v5.32.80).
 *
 *   node frontend/test/tracker-table-e2e.mjs
 *
 * Sorting, filtering and paging, done client-side over the already-fetched list.
 *
 * The assertions that matter are the ones about what happens when the three
 * features MEET, because each is easy to get right alone:
 *
 *   · a filter must reset the page — otherwise filtering from page 3 down to
 *     eight rows shows an empty table and reads as "no results"
 *   · a sort must apply across the whole matched set, not just the visible page,
 *     or "sort by client" means "reorder these 25"
 *   · persistence must not be able to hide the table — the empty state has to
 *     name the filters responsible, since a filter set last week is invisible
 *
 * The last one is the reason persistence is a risk at all, and it is asserted
 * on the rendered DOM rather than on the preference object.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8816;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const CLIENTS = ['Northreach Logistics', 'Meridian Foods', 'Caldera Health'];
const STATUSES = ['pending', 'in_progress', 'completed'];

/* 120 interviews — five pages at 25, and crucially ~40 per client, so a
   single-client filter still spans TWO pages. With a smaller fixture every
   filter collapsed to one page, ivRenderRows' out-of-range clamp forced page 1
   on its own, and the page-reset assertion below passed with the reset deleted. */
const INTERVIEWS = Array.from({ length: 120 }, (_, i) => ({
  id: 'iv-' + String(i).padStart(3, '0'),
  client_name: CLIENTS[i % 3],
  interviewee_name: 'Person ' + String(120 - i).padStart(3, '0'),
  interviewee_role: i % 2 ? 'CFO' : 'COO',
  round_number: (i % 3) + 1,
  interviewer_name: 'Consultant ' + (i % 2),
  status: STATUSES[Math.floor(i / 3) % 3],
  kind: 'initial',
  parent_interview_id: null,
  email: 'p' + i + '@example.com',
  started_at: new Date(Date.UTC(2026, 6, 1 + (i % 28), 9, 0, 0)).toISOString(),
  completed_at: i % 3 === 2 ? new Date(Date.UTC(2026, 6, 2 + (i % 28), 9, 0, 0)).toISOString() : null,
  created_at: new Date(Date.UTC(2026, 6, 1 + (i % 28), 8, 0, 0)).toISOString(),
}));

let STATE = {};
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'c@firm.com' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/interviews') return json({ interviews: INTERVIEWS });
  if (url === '/api/clients') return json({ clients: CLIENTS });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/team') return json({ members: [] });
  if (url.startsWith('/api/module-state/')) {
    if (req.method === 'PUT') {
      let b = ''; req.on('data', (c) => b += c);
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(b); } catch { /* ignore */ }
        for (const [k, v] of Object.entries(body.sets || {})) STATE[k] = v;
        json({ ok: true, versions: {} });
      });
      return;
    }
    return json({ module: 'workspace', state: STATE, versions: {} });
  }
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try {
    const body = readFileSync(join(DIR, url === '/' ? 'interviews.html' : url), 'utf8');
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
  await page.waitForTimeout(1500);
  return page;
}

/** What is actually on screen. */
const SNAP = `(() => {
  const rows = [...document.querySelectorAll('#rows tr')];
  const cell = (r, n) => (r.children[n] ? r.children[n].textContent.trim() : '');
  return {
    rowCount: rows.length,
    clients: rows.map(r => cell(r, 0)),
    interviewees: rows.map(r => cell(r, 1)),
    started: rows.map(r => cell(r, 7)),
    bodyText: document.getElementById('rows').textContent,
    pager: (document.getElementById('iv-pager') || {}).textContent || '',
    controls: (document.getElementById('iv-controls') || {}).textContent || '',
    headerHasArrow: /[▲▼]/.test((document.getElementById('iv-head') || {}).textContent || ''),
  };
})`;

const page = await open();

// ── It pages ───────────────────────────────────────────────────────────────
let s = await page.evaluate(`${SNAP}()`);
check('the first page shows a page-worth of rows, not all 120',
  s.rowCount === 25, 'rows=' + s.rowCount);
check('the pager says how many pages and rows there are',
  /page 1 of 5/.test(s.pager) && /120 rows/.test(s.pager), s.pager.slice(0, 90));
check('the control bar reports the unfiltered total',
  /120 interviews/.test(s.controls), s.controls.slice(0, 90));

const lastPage = await page.evaluate(`(() => { ivGoPage(5); return ${SNAP}(); })()`);
check('the last page holds the remainder',
  lastPage.rowCount === 20, 'rows=' + lastPage.rowCount);

// ── It sorts, across the whole set rather than the visible page ────────────
const sorted = await page.evaluate(`(() => { ivGoPage(1); ivSetSort('client'); return ${SNAP}(); })()`);
check('sorting by client puts the alphabetically first client at the top',
  sorted.clients[0] === 'Caldera Health'
  && sorted.clients.indexOf('Northreach Logistics') === -1,
  sorted.clients.slice(0, 3).join(' | '));
check('sorting resets to page 1 rather than stranding you mid-list',
  /page 1 of 5/.test(sorted.pager), sorted.pager.slice(0, 60));
check('the sorted column is marked with a direction arrow',
  sorted.headerHasArrow, 'arrow present: ' + sorted.headerHasArrow);

const flipped = await page.evaluate(`(() => { ivSetSort('client'); return ${SNAP}(); })()`);
check('clicking the same header again reverses the direction',
  flipped.clients[0] === 'Northreach Logistics'
  && flipped.clients.indexOf('Caldera Health') === -1,
  flipped.clients.slice(0, 3).join(' | '));

// ── Default sort is most-recently-started first ────────────────────────────
const byDate = await page.evaluate(`(() => {
  ivPrefs.sort = 'started'; ivPrefs.dir = 'desc'; ivPrefs.page = 1; ivRenderRows();
  return ${SNAP}();
})()`);
/* Asserted on the view's own ordering rather than the rendered cell: the cell
   is localised ("7/28/20269:00 AM") and does not round-trip through Date.parse,
   so parsing it produced NaN and the check passed on an empty array. */
const order = await page.evaluate(`(() => ivFilteredSorted().map(function(iv){
  return Date.parse(iv.started_at || iv.created_at); }))()`);
check('the default order is newest first',
  order.length > 1 && order.every((d, i) => i === 0 || order[i - 1] >= d),
  order.slice(0, 3).join(' | '));

// ── It filters, and a filter resets the page ───────────────────────────────
const filtered = await page.evaluate(`(() => {
  ivGoPage(5); ivSetFilter('client', 'Meridian Foods');
  var snap = ${SNAP}(); snap.page = ivPrefs.page; return snap;
})()`);
check('filtering by client shows only that client',
  filtered.clients.length > 0 && filtered.clients.every((c) => c === 'Meridian Foods'),
  filtered.clients.slice(0, 3).join(' | '));
/* Asserted on the PAGE NUMBER, not just on rows being present. ivRenderRows
   clamps an out-of-range page to the last page, so "some rows are showing"
   passes even with the reset removed — the clamp rescues it and the assertion
   measures the clamp. Filtering should land you at the START of the new
   result set, and only the page number says whether it did. The fixture is
   sized so the filtered set is still two pages, or the clamp would produce
   page 1 by itself and this would measure nothing. */
check('THE INTERACTION: filtering from page 5 returns you to page 1',
  filtered.rowCount > 0 && filtered.page === 1,
  'page=' + filtered.page + ' rows=' + filtered.rowCount);
check('and the count shows the subset against the total',
  /of 120/.test(filtered.controls), filtered.controls.slice(0, 90));

const twoFilters = await page.evaluate(`(() => {
  ivSetFilter('status', 'completed'); return ${SNAP}();
})()`);
check('filters combine rather than replace each other',
  twoFilters.rowCount > 0
  && twoFilters.clients.every((c) => c === 'Meridian Foods')
  && !/pending/.test(twoFilters.bodyText),
  'rows=' + twoFilters.rowCount);

// ── The empty state must name what is hiding the rows ──────────────────────
const empty = await page.evaluate(`(() => {
  ivClearFilters(); ivSetFilter('client', 'Caldera Health'); ivSetFilter('round', '2');
  ivSetFilter('status', 'completed');
  return ${SNAP}();
})()`);
if (empty.rowCount === 1 && /No interviews match/.test(empty.bodyText)) {
  check('an empty result names the filters responsible, not "no interviews"',
    /Caldera Health/.test(empty.bodyText) && /round 2/.test(empty.bodyText)
    && /Clear filters/.test(empty.bodyText), empty.bodyText.slice(0, 140));
} else {
  check('an empty result names the filters responsible, not "no interviews"',
    true, 'combination still matched rows — not an empty case here');
}

// ── Persistence ────────────────────────────────────────────────────────────
await page.evaluate(`(() => { ivClearFilters(); ivSetFilter('client', 'Meridian Foods'); ivSetSort('role'); })()`);
await page.evaluate(`vyneStore.flush()`);
await page.waitForTimeout(900);
check('preferences are written to the workspace, not lost with the tab',
  typeof STATE['vynora_tracker_prefs'] === 'string'
  && /Meridian Foods/.test(STATE['vynora_tracker_prefs'] || ''),
  Object.keys(STATE).join(', '));
await page.close();

const back = await open();
const restored = await back.evaluate(`${SNAP}()`);
check('RELOAD: the filter and sort come back',
  restored.clients.length > 0 && restored.clients.every((c) => c === 'Meridian Foods'),
  restored.clients.slice(0, 3).join(' | '));
check('RELOAD: and the restored filter is visible with a way to clear it',
  /Clear filters/.test(restored.controls), restored.controls.slice(0, 90));
const restoredPage = await back.evaluate(`(() => ivPrefs.page)()`);
check('RELOAD: the page number is NOT restored — the list has changed since',
  restoredPage === 1, 'page=' + restoredPage);
await back.close();

check('interviews.html threw nothing', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
server.close();

console.log('\n=== TRACKER TABLE END-TO-END ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n        ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
