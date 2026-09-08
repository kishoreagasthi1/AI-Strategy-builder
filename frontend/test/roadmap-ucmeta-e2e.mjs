/**
 * Roadmap Builder — custom (ai_uc_*) use-case names survive republish (v5.33.12).
 *
 *   node frontend/test/roadmap-ucmeta-e2e.mjs
 *
 * A custom use case added in the roadmap gets an id like ai_uc_<ts>_<rand> and
 * lives only in memory + the published ucMeta. buildSelectedUcMeta() rebuilds
 * ucMeta from the CATALOG, which no longer contains it on a later load — so the
 * old `entry.ucMeta = fresh` dropped its name and the Design Studio rendered the
 * raw id under "Other". mergeUcMeta() is the helper both publish paths now use
 * to keep a previously-published name for any still-selected id fresh omits.
 * This drives the REAL mergeUcMeta() in the real page with controlled inputs.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.UCMETA_PORT || 8959);
const results = [];
const check = (n, ok, d = '') => { let v = false; try { v = typeof ok === 'function' ? ok() : ok; } catch (e) { v = false; d = d || String(e).slice(0, 160); } results.push({ n, ok: !!v, d }); };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const body = (cb) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => cb(b)); };
  if (url.startsWith('/api/llm')) return body(() => json({ text: '{}', finishReason: 'stop' }));
  if (url.startsWith('/api/module-state/')) { if (req.method === 'PUT') return body(() => json({ ok: true, versions: {} })); return json({ module: 'workspace', state: {}, versions: {} }); }
  if (url === '/api/version') return json({ version: 'test', env: 'test' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'c@firm.com' });
  if (url === '/api/clients') return json({ clients: ['Gibberco'] });
  if (url === '/api/my-clients') return json({ role: 'owner', clients: ['Gibberco'] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/team') return json({ members: [] });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try { const f = readFileSync(join(DIR, url === '/' ? 'index.html' : url), 'utf8'); res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : url.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(f); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(`try{var s=${JSON.stringify({ token: 'tok', email: 'c@firm.com', role: 'owner', mode: 'dev', activeClient: 'Gibberco' })};
  s.at=Date.now();s.la=Date.now();sessionStorage.setItem('vyne_session', JSON.stringify(s));}catch(e){}`);
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));
page.on('dialog', (d) => d.dismiss().catch(() => {}));
await page.goto(`http://127.0.0.1:${PORT}/roadmap.html`);
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  // prev = what was published at creation (has the custom name + a now-deselected
  // catalog entry). fresh = the rebuilt catalog pass on a later load: it covers a
  // catalog use case but NOT the custom ai_uc_* one. sel = the current selection.
  var prev = {
    'ai_uc_1787050481318_kto': { name: 'Promotional Baseline & Lift Forecasting', dept: 'Demand Forecasting' },
    'was_selected_before': { name: 'no longer selected' },
  };
  var fresh = { 'catalog_x': { name: 'Catalog Use Case', dept: 'D' } };
  var sel = { 'ai_uc_1787050481318_kto': true, 'catalog_x': true };
  return mergeUcMeta(prev, fresh, sel);
});

check('custom ai_uc_* keeps its published name (not dropped to a raw id in the Studio)',
  out['ai_uc_1787050481318_kto'] && out['ai_uc_1787050481318_kto'].name === 'Promotional Baseline & Lift Forecasting',
  `custom=${JSON.stringify(out['ai_uc_1787050481318_kto'])}`);
check('catalog use case comes through from the fresh pass',
  out.catalog_x && out.catalog_x.name === 'Catalog Use Case', `catalog_x=${JSON.stringify(out.catalog_x)}`);
check('a no-longer-selected id is dropped (merge is scoped to the current selection)',
  !('was_selected_before' in out), `unexpected=${JSON.stringify(out.was_selected_before)}`);

await browser.close();
server.close();
let pass = 0, fail = 0;
console.log('\n  ROADMAP ucMeta PRESERVATION\n  ' + '─'.repeat(62));
for (const r of results) { console.log(`  [${r.ok ? ' OK ' : 'FAIL'}] ${r.n}`); if (!r.ok) console.log(`         ${r.d}`); r.ok ? pass++ : fail++; }
if (pageErrors.length) { console.log('  page errors:'); pageErrors.slice(0, 4).forEach((e) => console.log('   - ' + e)); }
console.log('  ' + '─'.repeat(62) + `\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
