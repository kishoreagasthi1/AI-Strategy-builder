/**
 * Pre-Engagement briefing reflects synthesis hypothesis verdicts (v5.33.15).
 *
 *   node frontend/test/briefing-synthesis-verdicts-e2e.mjs
 *
 * Synthesis produces a per-hypothesis verdict (confirmed / contradicted /
 * unresolved). Those verdicts are published to vynora_hypothesis_verdicts_<code>.
 * When the briefing is (re)opened, its hypothesis cards must overlay those
 * verdicts — confirmed→confirmed, contradicted→rejected — instead of showing the
 * stale manual statuses. This drives the REAL page loader restoreBriefingPack()
 * and asserts the rendered cards, the "from synthesis" badge, idempotency, and
 * that a manual revert override is respected.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VERDICT_PORT || 8967);
const results = [];
const check = (n, ok, d = '') => { let v = false; try { v = typeof ok === 'function' ? ok() : ok; } catch (e) { v = false; d = d || String(e).slice(0, 160); } results.push({ n, ok: !!v, d }); };

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const H1 = 'Demand forecasting relies on spreadsheets, not a model';   // open  -> confirmed
const H2 = 'Leadership lacks a shared definition of AI readiness';      // confirmed -> contradicted (=> rejected)
const H3 = 'Data governance is owned by no single function';            // rejected, but user-reverted => stays rejected

const VERDICTS = {
  engagementCode: 'ENG-1', roundClosed: null, generatedAt: '2026-08-18T00:00:00Z', live: true,
  byText: {
    [norm(H1)]: { verdict: 'confirmed', evidence: 'Three of four interviewees described manual spreadsheet forecasting.', original: H1 },
    [norm(H2)]: { verdict: 'contradicted', evidence: 'CDO and CEO gave a consistent, specific readiness definition.', original: H2 },
    [norm(H3)]: { verdict: 'confirmed', evidence: 'Governance sits with the new data council.', original: H3 },
  },
};
const STATE = {
  vynora_engagement_index: JSON.stringify({ verdictco: 'ENG-1' }),
  'vynora_hypothesis_verdicts_ENG-1': JSON.stringify(VERDICTS),
  // H3 was reverted by the consultant, so its synthesis verdict must be ignored.
  'vynora_hypothesis_overrides_ENG-1': JSON.stringify({ [norm(H3)]: true }),
};

const PACK = {
  client: 'Verdictco', industry: 'Logistics', revenue: '$1B-$2B', engagementCode: 'ENG-1',
  hypotheses: [
    { index: 0, text: H1, status: 'open', note: '' },
    { index: 1, text: H2, status: 'confirmed', note: '' },
    { index: 2, text: H3, status: 'rejected', note: '' },
  ],
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
  if (url === '/api/clients') return json({ clients: ['Verdictco'] });
  if (url === '/api/my-clients') return json({ role: 'owner', clients: ['Verdictco'] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/team') return json({ members: [] });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try { const f = readFileSync(join(DIR, url === '/' ? 'index.html' : url), 'utf8'); res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : url.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(f); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(`try{var s=${JSON.stringify({ token: 'tok', email: 'c@firm.com', role: 'owner', mode: 'dev', activeClient: 'Verdictco' })};
  s.at=Date.now();s.la=Date.now();sessionStorage.setItem('vyne_session', JSON.stringify(s));}catch(e){}`);
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));
page.on('dialog', (d) => d.dismiss().catch(() => {}));
await page.goto(`http://127.0.0.1:${PORT}/pre_engagement.html`);
await page.waitForTimeout(1200);

const out = await page.evaluate((pack) => {
  restoreBriefingPack(pack);
  function cardInfo(idx) {
    var el = document.getElementById('hyp-card-' + idx);
    if (!el) return { present: false };
    var cls = el.className;
    var badge = el.querySelector('div[title], .hyp-text ~ div');
    var badgeText = '';
    el.querySelectorAll('div').forEach(function (d) { if (String(d.textContent).indexOf('From synthesis') >= 0) badgeText = d.textContent; });
    return {
      present: true,
      confirmed: cls.indexOf('confirmed') >= 0,
      rejected: cls.indexOf('rejected') >= 0,
      badge: badgeText,
      stateStatus: (hypothesesState[idx] || {}).status,
      synthDerived: !!(hypothesesState[idx] || {}).synthesisDerived,
    };
  }
  // idempotency: applying again must not change anything or throw
  var again = applySynthesisVerdicts(pack.hypotheses, { code: 'ENG-1' });
  return { h0: cardInfo(0), h1: cardInfo(1), h2: cardInfo(2), secondApplyChanged: again };
}, PACK);

check('open hypothesis becomes CONFIRMED from synthesis (status + card class)',
  out.h0.present && out.h0.confirmed && out.h0.stateStatus === 'confirmed' && out.h0.synthDerived,
  JSON.stringify(out.h0));
check('and it carries the honest "From synthesis: CONFIRMED" badge',
  /from synthesis:\s*confirmed/i.test(out.h0.badge), `badge=${JSON.stringify(out.h0.badge)}`);
check('previously-confirmed hypothesis flips to REJECTED on a contradicted verdict',
  out.h1.present && out.h1.rejected && out.h1.stateStatus === 'rejected' && out.h1.synthDerived,
  JSON.stringify(out.h1));
check('a consultant-reverted hypothesis is NOT overwritten by synthesis (override respected)',
  out.h2.present && out.h2.rejected && out.h2.stateStatus === 'rejected' && out.h2.synthDerived === false,
  JSON.stringify(out.h2));
check('re-applying the verdict map is idempotent (no further changes)',
  out.secondApplyChanged === 0, `secondApplyChanged=${out.secondApplyChanged}`);

await browser.close();
server.close();
let pass = 0, fail = 0;
console.log('\n  BRIEFING ← SYNTHESIS VERDICTS\n  ' + '─'.repeat(64));
for (const r of results) { console.log(`  [${r.ok ? ' OK ' : 'FAIL'}] ${r.n}`); if (!r.ok) console.log(`         ${r.d}`); r.ok ? pass++ : fail++; }
if (pageErrors.length) { console.log('  page errors:'); pageErrors.slice(0, 5).forEach((e) => console.log('   - ' + e)); }
console.log('  ' + '─'.repeat(64) + `\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
