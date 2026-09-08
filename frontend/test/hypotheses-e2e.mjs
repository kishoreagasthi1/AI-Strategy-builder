/**
 * END-TO-END TEST for the Pre-Engagement hypothesis panel (pre_engagement.html).
 *
 *   node frontend/test/hypotheses-e2e.mjs
 *
 * WHY THIS EXISTS. Two functions read the hypothesis cards back out of the DOM
 * and they disagreed about how to find a card.
 *
 * persistHypothesisStatuses() looked each one up by id. saveBriefingContext()
 * matched DOM POSITION against state index — which is only the same thing when
 * every state entry has a card on screen. In a refresh round it is not: the
 * RESOLVED group registers state entries and renders them as plain rows inside
 * a <details>, not as .hyp-card elements. So the first real card was state
 * index R, its text was written onto hypothesis 0, every hypothesis shifted by
 * the number of resolved ones, and the last R lost their text.
 *
 * That result is `briefing.hypotheses` — saved, and read by every later round.
 * The worst case is a round where everything prior was confirmed, because then
 * R is nearly everything.
 *
 * These tests drive the real page's real functions against a DOM shaped the way
 * a refresh round actually shapes it.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8803;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return json({ userId: 'u1', role: 'consultant', email: 'c@firm.com' });
  if (url.startsWith('/api/module-state/')) return json({ module: 'workspace', state: {}, versions: {} });
  if (url === '/api/clients') return json({ clients: [] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try {
    const body = readFileSync(join(DIR, url === '/' ? 'pre_engagement.html' : url), 'utf8');
    res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : 'text/html' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
await ctx.addInitScript(`
  try { sessionStorage.setItem('vyne_session', JSON.stringify({
    token: 'tok', email: 'c@firm.com', role: 'consultant', mode: 'dev',
    at: Date.now(), la: Date.now() })); } catch (e) {}
`);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForTimeout(1200);

/**
 * Build the DOM a refresh round builds: three RESOLVED hypotheses that live in
 * state but render as plain rows, then two carried-forward ones that render as
 * real cards. This is round 3 with everything previously confirmed.
 */
const SETUP = `(() => {
  const grid = document.getElementById('hypotheses-grid');
  grid.innerHTML = '';
  for (const k of Object.keys(hypothesesState)) delete hypothesesState[k];
  renderHypothesesRefresh._curRound = 3;

  // Group 0 — resolved: state entries, NO .hyp-card elements.
  const resolved = [
    { text: 'Data fragmentation is the primary blocker.', status: 'confirmed' },
    { text: 'Governance has no clear owner.', status: 'confirmed' },
    { text: 'Processes are less automated than leadership believes.', status: 'confirmed' },
  ];
  let idx = 0;
  const details = document.createElement('details');
  resolved.forEach((h) => {
    hypothesesState[idx++] = { status: h.status, note: '', text: h.text, resolved: true };
    const row = document.createElement('div');
    row.textContent = h.text;
    details.appendChild(row);
  });
  grid.appendChild(details);

  // Group 1 — carried forward: real cards, with .hyp-text and a note field.
  const carried = [
    { text: 'The new platform has not reduced manual reconciliation.', status: 'open' },
    { text: 'Reskilling is still unfunded.', status: 'open' },
  ];
  carried.forEach((h) => {
    const i = idx++;
    hypothesesState[i] = { status: h.status, note: '', text: h.text, createdInRound: 2 };
    const card = document.createElement('div');
    card.className = 'hyp-card';
    card.id = 'hyp-card-' + i;
    card.innerHTML = '<div class="hyp-text">' + h.text + '</div>'
      + '<textarea class="hyp-note" id="hyp-note-' + i + '"></textarea>';
    grid.appendChild(card);
  });
  return { resolvedCount: resolved.length, total: Object.keys(hypothesesState).length };
})()`;

const setup = await page.evaluate(SETUP);
check('the fixture really has resolved entries with no cards (else this proves nothing)',
  setup.resolvedCount === 3 && setup.total === 5
    && (await page.evaluate(`document.querySelectorAll('.hyp-card').length`)) === 2,
  JSON.stringify(setup));

// ── 1. Reading the cards back must not shift the texts ──────────────────────
const collected = await page.evaluate(`collectHypotheses()`);
check('every hypothesis keeps its own text',
  collected[0].text === 'Data fragmentation is the primary blocker.'
  && collected[3].text === 'The new platform has not reduced manual reconciliation.'
  && collected[4].text === 'Reskilling is still unfunded.',
  JSON.stringify(collected.map((h) => h.text)));
check('no hypothesis was left with an empty text',
  collected.every((h) => h.text && h.text.length > 5), JSON.stringify(collected.map((h) => h.text)));
check('the resolved flag and prior round tags survive',
  collected[0].resolved === true && collected[3].createdInRound === 2,
  JSON.stringify(collected[0]) + ' | ' + JSON.stringify(collected[3]));
check('statuses are preserved',
  collected.filter((h) => h.status === 'confirmed').length === 3, JSON.stringify(collected.map((h) => h.status)));

// ── 2. A custom hypothesis added in round 3 ─────────────────────────────────
await page.evaluate(`addCustomHypothesis()`);
const after = await page.evaluate(`(() => {
  const keys = Object.keys(hypothesesState).map(Number).sort((a, b) => a - b);
  const i = keys[keys.length - 1];
  return {
    newIndex: i,
    state: hypothesesState[i],
    hasCard: !!document.getElementById('hyp-card-' + i),
    hasTextArea: !!document.getElementById('hyp-custom-' + i),
    hasNoteField: !!document.getElementById('hyp-note-' + i),
    overwroteAnything: keys.length !== new Set(keys).size,
    stillFive: keys.filter((k) => k < i).length,
  };
})()`);

check('the custom card was added without overwriting an existing hypothesis',
  after.newIndex === 5 && after.stillFive === 5, JSON.stringify(after));
check('it is tagged with the round it was written in',
  after.state.createdInRound === 3, JSON.stringify(after.state));
check('it has a field for the hypothesis text', after.hasTextArea);
check('it has its own evidence/notes field, like every generated card', after.hasNoteField);

// ── 3. Typing into it, then reading everything back ─────────────────────────
await page.evaluate(`(() => {
  const ta = document.getElementById('hyp-custom-5');
  ta.value = 'The event has moved the constraint from data to change capacity.';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const nt = document.getElementById('hyp-note-5');
  nt.value = 'Raised independently by the COO and the CHRO.';
  nt.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
const final = await page.evaluate(`collectHypotheses()`);
check('the custom hypothesis text is read back',
  final[5].text === 'The event has moved the constraint from data to change capacity.', JSON.stringify(final[5]));
check('its evidence note is read back',
  final[5].note === 'Raised independently by the COO and the CHRO.', JSON.stringify(final[5]));
check('and it still carries its round tag through the read', final[5].createdInRound === 3, JSON.stringify(final[5]));
check('adding it did not disturb the others',
  final[0].text === 'Data fragmentation is the primary blocker.'
  && final[4].text === 'Reskilling is still unfunded.',
  JSON.stringify(final.map((h) => h.text)));

check('pre_engagement.html threw nothing', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();

console.log('\n=== PRE-ENGAGEMENT HYPOTHESES END-TO-END ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n        ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
