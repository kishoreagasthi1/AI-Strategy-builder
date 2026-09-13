/**
 * END-TO-END TEST: a mandatory question is owed by each PERSON, not by each
 * ROLE (interview_agent.html, v5.33.2).
 *
 *   node frontend/test/mandatory-person-e2e.mjs
 *
 * THE DEFECT. Completion was recorded as:
 *
 *     store.completed[qid][role] = true
 *
 * so the instant one CTO answered a mandatory question, every other CTO was
 * skipped — and the store had no record of WHICH CTO answered. On an
 * engagement with two CTOs (or the far commoner case, divisional COOs) that is
 * three people, one answer, and no way to tell whose. The consultant's
 * management screen showed the role struck through with a ✓, which reads as
 * "this is covered" when it is not.
 *
 * This is the same identity defect v5.32.86 fixed across the refresh pipeline,
 * where a round-2 refresh was recorded against an interviewee literally named
 * "COO". The fix reuses that same key — window.vynePersonKey(), 'Role||Name' —
 * rather than inventing a third notion of "who".
 *
 * ASSIGNMENT is deliberately still by role: "every CTO must be asked this" is
 * the right way to state the requirement. Only COMPLETION moved to the person.
 *
 * THE LEGACY SHAPE MATTERS. Stores written before v5.33.2 hold `{role: true}`
 * and genuinely cannot say who answered. Those records suppress only an
 * UNNAMED interviewee in that role. A named person is asked, because failing
 * to ask someone who never answered is the real harm; asking twice is merely
 * repetitive. That asymmetry is asserted below, not assumed.
 *
 * REVERT TEST. Change mqPersonKey() back to returning the bare role:
 *     return String(role||'').trim();
 * and "a SECOND CTO is still asked ..." fails — the second CTO's key collides
 * with the first's. That is the assertion that pins the reported bug.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8835;

const results = [];
const check = (name, ok, detail = '') => {
  let v = false;
  try { v = typeof ok === 'function' ? ok() : ok; }
  catch (e) { v = false; detail = detail || `threw: ${String(e).slice(0, 140)}`; }
  results.push({ name, ok: !!v, detail });
};

const CLIENT = 'Acme Industrial';
const CODE = 'ENG-ACME-0001';

/* A live store (current shape, nobody has answered yet) and a legacy one. */
const LIVE_STORE = {
  questions: [
    { id: 'q_board', text: 'What has the board been told about the AI programme?',
      roles: ['CTO', 'CFO'], dimensions: ['D3'] },
  ],
  completed: {},
};
const LEGACY_STORE = {
  questions: [
    { id: 'q_legacy', text: 'Who signs off on model risk?', roles: ['CTO'], dimensions: ['D6'] },
  ],
  /* Pre-v5.33.2: the key IS the role, the value is `true`, the person is lost. */
  completed: { q_legacy: { CTO: true } },
};

let STATE = {
  vynora_engagement_index: JSON.stringify({ acmeindustrial: CODE }),
  ['vynora_mandatory_' + CODE]: JSON.stringify(LIVE_STORE),
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
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
  if (url === '/api/me') return json({ userId: 'u1', role: 'consultant', email: 'c@firm.com' });
  if (url === '/api/interviews') return json({ interviews: [] });
  if (url === '/api/voice/voices') return json({ voices: [] });
  if (url === '/api/clients') return json({ clients: [CLIENT] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url.startsWith('/api/llm')) return json({ text: '{}', finishReason: 'stop', provider: 'stub', model: 'stub', usage: {} });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try {
    const body = readFileSync(join(DIR, url === '/' ? 'interview_agent.html' : url), 'utf8');
    res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : 'text/html' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  try {
    sessionStorage.setItem('vyne_session', JSON.stringify({
      token: 'tok', email: 'c@firm.com', role: 'consultant', mode: 'dev', at: Date.now(), la: Date.now() }));
  } catch (e) {}
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForTimeout(1500);

const C = JSON.stringify(CLIENT);

/* ── The two CTOs ─────────────────────────────────────────────────────────
 * Priya is interviewed first and answers. Marcus is interviewed after her.
 * Before v5.33.2, Marcus was never asked and the store could not say that
 * Priya — rather than Marcus — was the one who had answered. */
const run = await page.evaluate(`(() => {
  var before = getDueMandatoryQuestions(${C}, 'CTO', 'Priya Raman').map(function(q){ return q.id; });
  markMandatoryComplete(${C}, 'q_board', 'CTO', 'Priya Raman');
  return {
    priyaBefore: before,
    priyaAfter:  getDueMandatoryQuestions(${C}, 'CTO', 'Priya Raman').map(function(q){ return q.id; }),
    marcus:      getDueMandatoryQuestions(${C}, 'CTO', 'Marcus Bell').map(function(q){ return q.id; }),
    cfo:         getDueMandatoryQuestions(${C}, 'CFO', 'Dana Wu').map(function(q){ return q.id; }),
    coo:         getDueMandatoryQuestions(${C}, 'COO', 'Sam Ortiz').map(function(q){ return q.id; }),
    answerers:   mqAnswerers(loadMandatoryStore(${C}), 'q_board'),
    personKey:   mqPersonKey('CTO', 'Marcus Bell'),
  };
})()`);

check('the first CTO is owed the question before she answers',
  run.priyaBefore.length === 1 && run.priyaBefore[0] === 'q_board', JSON.stringify(run.priyaBefore));
check('the person who answered is not asked again',
  run.priyaAfter.length === 0, JSON.stringify(run.priyaAfter));

/* THE REPORTED BUG. */
check('a SECOND CTO is still asked after the first CTO has answered',
  run.marcus.length === 1 && run.marcus[0] === 'q_board', JSON.stringify(run.marcus));

check('another assigned role is unaffected by the CTO answering',
  run.cfo.length === 1 && run.cfo[0] === 'q_board', JSON.stringify(run.cfo));
check('a role the question was never assigned to is not asked',
  run.coo.length === 0, JSON.stringify(run.coo));

/* "If there are two CTOs, we need to know who answered what." */
check('the store records WHICH person answered, with role and timestamp', () => {
  const a = run.answerers;
  return a.length === 1 && a[0].person === 'Priya Raman' && a[0].role === 'CTO'
    && !a[0].legacy && /^\d{4}-\d{2}-\d{2}T/.test(String(a[0].at));
}, JSON.stringify(run.answerers));

check('completion is keyed on the shared person identity, not a local invention',
  run.personKey === 'CTO||Marcus Bell', String(run.personKey));

/* The key must be the SAME string synthesis.html and the refresh agenda use —
 * a second, subtly different person model is how this class of bug returns. */
const keyMatch = await page.evaluate(`(() => {
  if (!window.vynePersonKey) return 'vynePersonKey MISSING';
  var shared = window.vynePersonKey({ role: 'CTO', interviewee: 'Marcus Bell' });
  return shared === mqPersonKey('CTO', 'Marcus Bell') ? 'match' : ('shared=' + shared);
})()`);
check('it is literally window.vynePersonKey, shared with synthesis and refresh',
  keyMatch === 'match', String(keyMatch));

/* ── Legacy records: suppress the unnamed, ask the named ──────────────── */
STATE['vynora_mandatory_' + CODE] = JSON.stringify(LEGACY_STORE);
const page2 = await ctx.newPage();
page2.on('pageerror', (e) => errors.push(String(e)));
await page2.goto(`http://127.0.0.1:${PORT}/`);
await page2.waitForTimeout(1500);

const legacy = await page2.evaluate(`(() => ({
  unnamed: getDueMandatoryQuestions(${C}, 'CTO', '').map(function(q){ return q.id; }),
  named:   getDueMandatoryQuestions(${C}, 'CTO', 'Marcus Bell').map(function(q){ return q.id; }),
  shown:   mqAnswerers(loadMandatoryStore(${C}), 'q_legacy'),
}))()`);

check('a legacy role-level record still suppresses an UNNAMED interviewee',
  legacy.unnamed.length === 0, JSON.stringify(legacy.unnamed));
check('a legacy role-level record does NOT suppress a named person',
  legacy.named.length === 1 && legacy.named[0] === 'q_legacy', JSON.stringify(legacy.named));
check('legacy records are surfaced as legacy, not as a person named "CTO"', () => {
  const a = legacy.shown;
  return a.length === 1 && a[0].legacy === true && a[0].role === 'CTO' && a[0].person === '';
}, JSON.stringify(legacy.shown));

/* ── The consultant's management screen ───────────────────────────────── */
STATE['vynora_mandatory_' + CODE] = JSON.stringify({
  questions: LIVE_STORE.questions,
  completed: {
    q_board: {
      'CTO||Priya Raman': { role: 'CTO', person: 'Priya Raman', at: '2026-08-14T09:30:00.000Z' },
    },
  },
});
const page3 = await ctx.newPage();
page3.on('pageerror', (e) => errors.push(String(e)));
await page3.goto(`http://127.0.0.1:${PORT}/`);
await page3.waitForTimeout(1500);

const html = await page3.evaluate(`(() => {
  var box = document.getElementById('mqm-list');
  if (!box) return 'MQM LIST MISSING';
  renderManagedMandatoryList(${C});
  return box.innerHTML;
})()`);

check('the management screen names who answered',
  /Priya Raman/.test(html), html.slice(0, 200));
check('it still shows the roles the question is assigned to',
  /CTO/.test(html) && /CFO/.test(html), html.slice(0, 300));
check('the footer no longer claims answers are recorded per role',
  !/roles with ✓ already answered/.test(html), html.slice(0, 400));

/* The strike-through, driven by a LEGACY store — the only fixture where the
 * old renderer actually produces it. Against the current store shape the old
 * renderer matches nothing and silently shows the question as untouched, so
 * asserting `no line-through` on the current shape would pass either way and
 * report something narrower than it appears. Here it is load-bearing: the old
 * screen crosses CTO out, which reads as "the CTO is covered" when the store
 * cannot even say which CTO answered and a second one is still owed it. */
STATE['vynora_mandatory_' + CODE] = JSON.stringify(LEGACY_STORE);
const page4 = await ctx.newPage();
page4.on('pageerror', (e) => errors.push(String(e)));
await page4.goto(`http://127.0.0.1:${PORT}/`);
await page4.waitForTimeout(1500);
const legacyHtml = await page4.evaluate(`(() => {
  var box = document.getElementById('mqm-list');
  if (!box) return 'MQM LIST MISSING';
  renderManagedMandatoryList(${C});
  return box.innerHTML;
})()`);
check('a legacy answer is not crossed out as if the role were finished',
  !/line-through/.test(legacyHtml), legacyHtml.slice(0, 300));
check('a legacy answer says the name was not recorded, rather than implying one',
  /name not recorded/.test(legacyHtml), legacyHtml.slice(0, 400));

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
