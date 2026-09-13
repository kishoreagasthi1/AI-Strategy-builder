/**
 * Roadmap Builder — orphaned custom (ai_uc_*) selections self-heal (v5.33.14).
 *
 *   node frontend/test/roadmap-orphan-prune-e2e.mjs
 *
 * A custom use case added before v5.33.13 was never persisted, so on reload the
 * catalog no longer contains it — but its id lingered in `selected`. With no use
 * case to draw a checkbox for, the Builder could not offer a way to untick it,
 * so it sat in the saved selection forever and surfaced in the Design Studio as
 * a raw-id "gibberish" row. loadPersistentState() now prunes any ai_uc_* id that
 * (after rehydration) still resolves to no use case, and re-persists the cleaned
 * selection. A REAL custom (present in the custom store) is rehydrated and kept.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ORPHAN_PORT || 8963);
const results = [];
const check = (n, ok, d = '') => { let v = false; try { v = typeof ok === 'function' ? ok() : ok; } catch (e) { v = false; d = d || String(e).slice(0, 160); } results.push({ n, ok: !!v, d }); };

// A genuine, persisted custom (survives) + an orphan id with no store record (pruned).
const GOOD = {
  ai_uc_good_1: {
    id: 'ai_uc_good_1', name: 'Persisted Custom UC', desc: 'real', impact: 'high', value: 'x', phase: 'p1',
    requires: {}, deptName: 'Nonexistent (forces fallback to depts[0])',
    subUcs: [],
  },
};
const STATE = {
  vynora_engagement_index: JSON.stringify({ testco: 'TST-1' }),
  'vynora_roadmap_state_eng_TST-1': JSON.stringify({
    assumptions: {}, dependencies: {}, generated: {},
    entry: {
      selected: { ai_uc_good_1: true, ai_uc_orphan_9: true },
      ucMeta: { ai_uc_good_1: { name: 'Persisted Custom UC' }, ai_uc_orphan_9: { name: 'ai_uc_orphan_9' } },
      industryLabel: 'Logistics', maturityScores: { D1: 2 }, savedAt: '2026-08-18T08:18:26.000Z',
    },
  }),
  'vynora_custom_ucs_eng_TST-1': JSON.stringify(GOOD),
};

const puts = [];  // capture what the page persists back
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const body = (cb) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => cb(b)); };
  if (url.startsWith('/api/llm')) return body(() => json({ text: '{}', finishReason: 'stop' }));
  if (url.startsWith('/api/module-state/')) {
    if (req.method === 'PUT') return body((b) => { try { puts.push(JSON.parse(b)); } catch (e) {} json({ ok: true, versions: {} }); });
    return json({ module: 'workspace', state: STATE, versions: {} });
  }
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
  // Production sets currentClientName from the active client during boot, which
  // is what makes getEngKey() resolve to eng_<code>; assert it, then drive load.
  currentClientName = 'Testco';
  // Drive the real load path — this rehydrates customs then prunes orphans.
  loadPersistentState();
  var partRaw = vyneStore.getItem('vynora_roadmap_state_eng_TST-1');
  var part = null; try { part = JSON.parse(partRaw); } catch (e) {}
  return {
    engKey: getEngKey(),
    goodStillSelected: !!selected['ai_uc_good_1'],
    orphanStillSelected: !!selected['ai_uc_orphan_9'],
    goodResolves: !!getUc('ai_uc_good_1'),
    orphanResolves: !!getUc('ai_uc_orphan_9'),
    persistedSelected: (part && part.entry && part.entry.selected) || null,
  };
});

check('orphaned custom selection (no use case behind it) is pruned from `selected`',
  out.orphanStillSelected === false, `orphanStillSelected=${out.orphanStillSelected}`);
check('a genuinely persisted custom is rehydrated and kept in `selected`',
  out.goodStillSelected === true && out.goodResolves === true, JSON.stringify(out));
check('the orphan resolves to no use case (confirming it was a true orphan, not a live UC)',
  out.orphanResolves === false, `orphanResolves=${out.orphanResolves}`);

// The cleaned selection must be persisted back to the store (self-heal), not
// just fixed in memory — read it straight out of vyneStore after the load.
const sel = out.persistedSelected;
check('the cleaned selection is re-persisted (orphan gone from the saved partition, good kept)',
  !!sel && sel.ai_uc_good_1 === true && !('ai_uc_orphan_9' in sel),
  sel ? JSON.stringify(sel) : 'no partition persisted');

await browser.close();
server.close();
let pass = 0, fail = 0;
console.log('\n  ROADMAP ORPHANED-SELECTION SELF-HEAL\n  ' + '─'.repeat(64));
for (const r of results) { console.log(`  [${r.ok ? ' OK ' : 'FAIL'}] ${r.n}`); if (!r.ok) console.log(`         ${r.d}`); r.ok ? pass++ : fail++; }
if (pageErrors.length) { console.log('  page errors:'); pageErrors.slice(0, 5).forEach((e) => console.log('   - ' + e)); }
console.log('  ' + '─'.repeat(64) + `\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
