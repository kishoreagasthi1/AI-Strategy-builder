/**
 * Solution Design Studio ← Roadmap Builder bridge (v5.33.11).
 *
 *   node frontend/test/design-roadmap-bridge-e2e.mjs
 *
 * roadmap.html moved each client's roadmap selection into a PER-ENGAGEMENT key
 * (vynora_roadmap_state_<engKey>) and stopped writing the legacy single
 * vynora_roadmap_state blob. solution_design.html still read only the legacy
 * blob, so any roadmap saved after the split showed up as an EMPTY portfolio in
 * the studio — "Design Studio did not pick up the use cases from my Roadmap
 * Builder". This drives the real page and asserts readRoadmapSelection() now
 * reads the per-engagement key, and still falls back to the legacy blob for a
 * client that predates the split.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BRIDGE_PORT || 8953);
const results = [];
const check = (name, ok, detail = '') => { let v = false; try { v = typeof ok === 'function' ? ok() : ok; } catch (e) { v = false; detail = detail || String(e).slice(0, 160); } results.push({ name, ok: !!v, detail }); };

/* New-key client (post-split): selection lives ONLY under the per-engagement key. */
const STATE = {
  vynora_engagement_index: JSON.stringify({ bridgeco: 'BRG-1', oldco: 'OLD-1' }),
  'vynora_roadmap_state_eng_BRG-1': JSON.stringify({
    assumptions: {}, dependencies: {}, generated: {},
    entry: {
      selected: { uc_alpha: true, uc_beta: true },
      ucMeta: { uc_alpha: { name: 'Alpha' }, uc_beta: { name: 'Beta' } },
      industryLabel: 'Logistics',
      maturityScores: { D1: 2.4 },
      savedAt: '2026-08-18T00:00:00.000Z',
    },
  }),
  /* Legacy client (pre-split): selection ONLY in the legacy single blob. */
  vynora_roadmap_state: JSON.stringify({
    byEng: { 'eng_OLD-1': { selected: { uc_legacy: true }, ucMeta: {}, industryLabel: 'Healthcare' } },
  }),
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const body = (cb) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => cb(b)); };
  if (url.startsWith('/api/llm')) return body(() => json({ text: '{}', finishReason: 'stop' }));
  if (url.startsWith('/api/module-state/')) {
    if (req.method === 'PUT') return body(() => json({ ok: true, versions: {} }));
    return json({ module: 'workspace', state: STATE, versions: {} });
  }
  if (url === '/api/version') return json({ version: 'test', env: 'test' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'c@firm.com' });
  if (url === '/api/clients') return json({ clients: ['Bridgeco', 'Oldco'] });
  if (url === '/api/my-clients') return json({ role: 'owner', clients: ['Bridgeco', 'Oldco'] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/team') return json({ members: [] });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try {
    const file = readFileSync(join(DIR, url === '/' ? 'index.html' : url), 'utf8');
    res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : url.endsWith('.css') ? 'text/css' : 'text/html' });
    res.end(file);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const pageErrors = [];

async function readSelectionFor(clientName) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(`try{var s=${JSON.stringify({ token: 'tok', email: 'c@firm.com', role: 'owner', mode: 'dev', activeClient: clientName })};
    s.at=Date.now();s.la=Date.now();sessionStorage.setItem('vyne_session', JSON.stringify(s));}catch(e){}`);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(clientName + ': ' + String(e).slice(0, 160)));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(`http://127.0.0.1:${PORT}/solution_design.html`);
  await page.waitForTimeout(1400);
  const out = await page.evaluate(() => readRoadmapSelection());
  await ctx.close();
  return out;
}

const brg = await readSelectionFor('Bridgeco');
check('reads per-engagement key vynora_roadmap_state_eng_BRG-1 (the post-split location)',
  brg.engKey === 'eng_BRG-1' && Object.keys(brg.selected || {}).sort().join(',') === 'uc_alpha,uc_beta',
  `engKey=${brg.engKey} selected=${JSON.stringify(Object.keys(brg.selected || {}))}`);
check('carries the published industry through from the per-engagement entry',
  brg.industry === 'Logistics', `industry=${brg.industry}`);

const old = await readSelectionFor('Oldco');
check('still falls back to the legacy blob for a pre-split client (no regression)',
  old.engKey === 'eng_OLD-1' && Object.keys(old.selected || {}).join(',') === 'uc_legacy',
  `engKey=${old.engKey} selected=${JSON.stringify(Object.keys(old.selected || {}))}`);

await browser.close();
server.close();

let pass = 0, fail = 0;
console.log('\n  DESIGN STUDIO ← ROADMAP BRIDGE\n  ' + '─'.repeat(64));
for (const r of results) { console.log(`  [${r.ok ? ' OK ' : 'FAIL'}] ${r.name}`); if (!r.ok) console.log(`         ${r.detail}`); r.ok ? pass++ : fail++; }
if (pageErrors.length) { console.log('  page errors:'); pageErrors.slice(0, 5).forEach((e) => console.log('   - ' + e)); }
console.log('  ' + '─'.repeat(64) + `\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
