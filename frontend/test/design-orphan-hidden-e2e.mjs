/**
 * Solution Design Studio — orphaned custom (ai_uc_*) selections don't render as
 * gibberish (v5.33.14).
 *
 *   node frontend/test/design-orphan-hidden-e2e.mjs
 *
 * A pre-v5.33.13 custom use case leaves its id behind in the roadmap's saved
 * `selected` with no published ucMeta and no catalog entry. The Studio's
 * "N use cases selected in the Roadmap Builder" list used to render it as a raw
 * id ("gibberish"). roadmapUseCases() now drops any ai_uc_* selection that
 * resolves to nothing, while keeping ids that DO resolve (a custom with a
 * published name, or a built-in / industry-catalog id).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ORPHANUI_PORT || 8965);
const results = [];
const check = (n, ok, d = '') => { let v = false; try { v = typeof ok === 'function' ? ok() : ok; } catch (e) { v = false; d = d || String(e).slice(0, 160); } results.push({ n, ok: !!v, d }); };

const STATE = {
  vynora_engagement_index: JSON.stringify({ orphanco: 'ORP-1' }),
  'vynora_roadmap_state_eng_ORP-1': JSON.stringify({
    assumptions: {}, dependencies: {}, generated: {},
    entry: {
      // uc_builtin: a normal id (kept). ai_uc_named: a custom WITH published meta
      // (kept). ai_uc_orphan_9: a custom with NO meta and no catalog (dropped).
      selected: { uc_builtin: true, ai_uc_named: true, ai_uc_orphan_9: true },
      ucMeta: { uc_builtin: { name: 'Built-in UC' }, ai_uc_named: { name: 'Named Custom UC' } },
      industryLabel: 'Logistics', maturityScores: {}, savedAt: '2026-08-18T08:18:26.000Z',
    },
  }),
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
  if (url === '/api/clients') return json({ clients: ['Orphanco'] });
  if (url === '/api/my-clients') return json({ role: 'owner', clients: ['Orphanco'] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/team') return json({ members: [] });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try { const f = readFileSync(join(DIR, url === '/' ? 'index.html' : url), 'utf8'); res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : url.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(f); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(`try{var s=${JSON.stringify({ token: 'tok', email: 'c@firm.com', role: 'owner', mode: 'dev', activeClient: 'Orphanco' })};
  s.at=Date.now();s.la=Date.now();sessionStorage.setItem('vyne_session', JSON.stringify(s));}catch(e){}`);
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));
page.on('dialog', (d) => d.dismiss().catch(() => {}));
await page.goto(`http://127.0.0.1:${PORT}/solution_design.html`);
await page.waitForTimeout(1400);

const out = await page.evaluate(() => {
  state.roadmap = readRoadmapSelection();
  var list = roadmapUseCases();
  return {
    ids: list.map(function (u) { return u.ucId; }),
    names: list.map(function (u) { return u.name; }),
  };
});

check('orphaned custom (ai_uc_orphan_9, no meta, no catalog) is hidden from the roadmap list',
  out.ids.indexOf('ai_uc_orphan_9') === -1, `ids=${JSON.stringify(out.ids)}`);
check('a custom WITH a published name is still shown (real customs survive)',
  out.ids.indexOf('ai_uc_named') !== -1 && out.names.indexOf('Named Custom UC') !== -1, JSON.stringify(out));
check('a normal (non-custom) selection is untouched',
  out.ids.indexOf('uc_builtin') !== -1, `ids=${JSON.stringify(out.ids)}`);
check('no raw ai_uc_* id leaks through as a display name',
  out.names.every(function (n) { return String(n).indexOf('ai_uc_') !== 0; }), `names=${JSON.stringify(out.names)}`);

await browser.close();
server.close();
let pass = 0, fail = 0;
console.log('\n  DESIGN STUDIO ORPHAN-HIDDEN GUARD\n  ' + '─'.repeat(64));
for (const r of results) { console.log(`  [${r.ok ? ' OK ' : 'FAIL'}] ${r.n}`); if (!r.ok) console.log(`         ${r.d}`); r.ok ? pass++ : fail++; }
if (pageErrors.length) { console.log('  page errors:'); pageErrors.slice(0, 5).forEach((e) => console.log('   - ' + e)); }
console.log('  ' + '─'.repeat(64) + `\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
