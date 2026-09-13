/**
 * Roadmap Builder — custom (ai_uc_*) use cases persist + rehydrate (v5.33.13).
 *
 *   node frontend/test/roadmap-custom-uc-e2e.mjs
 *
 * A custom use case added ad-hoc used to live only in the shared in-memory
 * catalog, so it vanished on reload — orphaning its selection and degrading its
 * name to a raw id in the Design Studio. It is now persisted per engagement
 * (vynora_custom_ucs_<engKey>) and re-injected into the catalog on load, and
 * cleared before another engagement's customs are injected so nothing leaks
 * across a client switch. This drives the real page functions.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CUSTOMUC_PORT || 8961);
const results = [];
const check = (n, ok, d = '') => { let v = false; try { v = typeof ok === 'function' ? ok() : ok; } catch (e) { v = false; d = d || String(e).slice(0, 160); } results.push({ n, ok: !!v, d }); };

const CUSTOM = {
  ai_uc_1787050481318_kto: {
    id: 'ai_uc_1787050481318_kto', name: 'Promotional Baseline & Lift Forecasting',
    desc: 'Custom demand use case', impact: 'high', value: 'Margin +2pts', phase: 'p1',
    requires: { D1: 3 }, deptName: 'Nonexistent Dept (forces fallback)',
    subUcs: [{ id: 'ai_uc_1787050481318_kto_s1', name: 'Baseline model', desc: '', phase: 'p1', data: 'sales', tech: 'ML' }],
  },
};
const STATE = {
  vynora_engagement_index: JSON.stringify({ testco: 'TST-1' }),
  'vynora_roadmap_state_eng_TST-1': JSON.stringify({ assumptions: {}, dependencies: {}, generated: {}, entry: { selected: { ai_uc_1787050481318_kto: true }, ucMeta: {}, industryLabel: 'Logistics' } }),
  'vynora_custom_ucs_eng_TST-1': JSON.stringify(CUSTOM),
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const body = (cb) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => cb(b)); };
  if (url.startsWith('/api/llm')) return body(() => json({ text: '{}', finishReason: 'stop' }));
  if (url.startsWith('/api/module-state/')) { if (req.method === 'PUT') return body(() => json({ ok: true, versions: {} })); return json({ module: 'workspace', state: STATE, versions: {} }); }
  if (url === '/api/version') return json({ version: 'test', env: 'test' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'c@firm.com' });
  if (url === '/api/clients') return json({ clients: ['Testco'] });
  if (url === '/api/my-clients') return json({ role: 'owner', clients: ['Testco'] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/team') return json({ members: [] });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try { const f = readFileSync(join(DIR, url === '/' ? 'index.html' : url), 'utf8'); res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : url.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(f); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(`try{var s=${JSON.stringify({ token: 'tok', email: 'c@firm.com', role: 'owner', mode: 'dev', activeClient: 'Testco' })};
  s.at=Date.now();s.la=Date.now();sessionStorage.setItem('vyne_session', JSON.stringify(s));}catch(e){}`);
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));
page.on('dialog', (d) => d.dismiss().catch(() => {}));
await page.goto(`http://127.0.0.1:${PORT}/roadmap.html`);
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  var ID = 'ai_uc_1787050481318_kto';
  // 1) rehydrate this engagement's customs into the catalog
  rehydrateCustomUcs('eng_TST-1');
  var afterRehydrate = { present: !!getUc(ID), name: (getUc(ID) || {}).name, sub: !!SUB_UCS[ID], selectable: getAllUcs().some(function (u) { return u.id === ID; }) };
  // 2) switching to another engagement (no customs) must clear it — no leak
  rehydrateCustomUcs('eng_OTHER');
  var afterSwitch = { present: !!getUc(ID) };
  return { afterRehydrate: afterRehydrate, afterSwitch: afterSwitch };
});

check('custom use case is injected into the catalog on load (resolves by id, with its name)',
  out.afterRehydrate.present && out.afterRehydrate.name === 'Promotional Baseline & Lift Forecasting' && out.afterRehydrate.sub,
  JSON.stringify(out.afterRehydrate));
check('it is now a first-class catalog entry (appears in getAllUcs — feeds stages/synthesis/studio)',
  out.afterRehydrate.selectable, `selectable=${JSON.stringify(out.afterRehydrate)}`);
check('switching to another engagement clears it from the shared catalog (no cross-client leak)',
  out.afterSwitch.present === false, `still present=${out.afterSwitch.present}`);

await browser.close();
server.close();
let pass = 0, fail = 0;
console.log('\n  ROADMAP CUSTOM USE-CASE PERSISTENCE\n  ' + '─'.repeat(64));
for (const r of results) { console.log(`  [${r.ok ? ' OK ' : 'FAIL'}] ${r.n}`); if (!r.ok) console.log(`         ${r.d}`); r.ok ? pass++ : fail++; }
if (pageErrors.length) { console.log('  page errors:'); pageErrors.slice(0, 5).forEach((e) => console.log('   - ' + e)); }
console.log('  ' + '─'.repeat(64) + `\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
