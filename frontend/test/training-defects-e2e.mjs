/**
 * END-TO-END TEST for the six defects the training-screenshot pass found (v5.33.7).
 *
 *   node frontend/test/training-defects-e2e.mjs
 *
 * WHY THIS EXISTS. Building the training material meant driving every screen of
 * the product to every state it has and then LOOKING at the result — which no
 * test suite had ever done, because a test asserts the thing it was written to
 * assert and a screenshot shows you everything else. Six defects fell out. Four
 * of them had shipped and were visible to users; two were visible to
 * interviewees, who are the client's executives.
 *
 * All six share a shape: nothing throws, nothing logs, and the screen is simply
 * wrong. That is exactly the class a browser test catches and a unit test does
 * not, so every case below drives the real page in a real browser and reads the
 * rendered DOM — not the source.
 *
 * THE DEFECTS
 *
 *   1  openDrillDown / openConflictDrillDown guarded on `engagement.interviews`,
 *      the FLAT legacy array, while their own next line read the rounds. Every
 *      engagement created since rounds shipped returned instantly: no modal, no
 *      toast, nothing, under a panel captioned "Click any dimension to see the
 *      full score breakdown".
 *
 *   2  The contradiction header read `${high.score} points higher` where it
 *      meant the spread, and named both ends by role — so the most interesting
 *      contradiction there is, two people holding one title, rendered as
 *      "VP_Operations scored D5 5 points higher than VP_Operations".
 *
 *   3  The synthesis interview tracker took `iv.find(i => roleKey(i.role) ===
 *      key)` — the FIRST interview for a role — and showed that one person's
 *      average as the role's, on a panel headed "who has been interviewed".
 *
 *   4  pushToRoadmapBuilder() said "find the engagement that's currently loaded"
 *      and picked whichever record had the newest createdAt.
 *
 *   5  interview_agent.html's BTN style contained `font:600 15px "Inter"` and
 *      was interpolated into a double-quoted style attribute, terminating it
 *      early. Every interviewee-facing call to action rendered as a grey
 *      default button.
 *
 *   6  renderScorecard() appended the benchmark legend twice, from two
 *      byte-identical blocks both commented "Single benchmark legend".
 *
 * REVERT TESTS — each fix backed out individually, observed failing, restored.
 * The mapping is in the case names.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { workspace, INTERVIEWS_API, A, B, ENG_A } from './training/fixture.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DEFECT_PORT || 8931);

const results = [];
const check = (name, ok, detail = '') => {
  let v = false;
  try { v = typeof ok === 'function' ? ok() : ok; }
  catch (e) { v = false; detail = detail || `threw: ${String(e).slice(0, 160)}`; }
  results.push({ name, ok: !!v, detail });
};

/* ── Stub backend ─────────────────────────────────────────────────────────── */

let STATE = workspace();

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const body = (cb) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => cb(b)); };

  if (url.startsWith('/api/llm')) return body(() => json({ text: '{}', finishReason: 'stop', provider: 'stub', model: 'stub', usage: {} }));
  if (url.startsWith('/api/module-state/')) {
    if (req.method === 'PUT') {
      return body((b) => {
        let p = {}; try { p = JSON.parse(b); } catch { /* ignore */ }
        for (const [k, v] of Object.entries(p.sets || {})) STATE[k] = v;
        for (const k of p.deletes || []) delete STATE[k];
        json({ ok: true, versions: {} });
      });
    }
    return json({ module: 'workspace', state: STATE, versions: {} });
  }
  if (url === '/api/version') return json({ version: 'test', env: 'test' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'c@firm.com' });
  if (url === '/api/clients') return json({ clients: [A.name, B.name] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/interviews') return json({ interviews: INTERVIEWS_API });
  if (url.startsWith('/api/interviews/')) return json({ interview: INTERVIEWS_API[1], transcript: [] });
  if (url === '/api/firms/team') return json({ members: [] });
  if (url === '/api/voice/voices') return json({ voices: [] });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  try {
    const file = readFileSync(join(DIR, url === '/' ? 'index.html' : url), 'utf8');
    res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : 'text/html' });
    res.end(file);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function open(page, session) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(`
    try { var s = ${JSON.stringify({ token: 'tok', email: 'c@firm.com', role: 'owner', mode: 'dev', activeClient: A.name, ...(session || {}) })};
      s.at = Date.now(); s.la = Date.now();
      sessionStorage.setItem('vyne_session', JSON.stringify(s)); } catch (e) {}
  `);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  p.on('dialog', (d) => { p._lastDialog = d.message(); d.dismiss().catch(() => {}); });
  await p.goto(`http://127.0.0.1:${PORT}/${page}`);
  await p.waitForTimeout(1500);
  return { ctx, page: p, errors };
}

/**
 * Northwind with a D5 disagreement BETWEEN THE TWO VP OPERATIONS.
 *
 * The fixture's round 1 has them agreeing, which produces no contradiction to
 * drill into. This is the case that matters and the one the old header rendered
 * as "VP_Operations … than VP_Operations": same title, same company, five
 * against two.
 */
function engWithSameRoleConflict() {
  const eng = JSON.parse(JSON.stringify(ENG_A));
  const r1 = eng.rounds[0];
  r1.interviews.find((i) => i.interviewee === 'Grace Okonkwo').scores.D5 = 5;
  r1.interviews.find((i) => i.interviewee === 'Tomas Reinholt').scores.D5 = 2;
  return eng;
}

/* ══ 1 + 2 — the drill-downs, on a rounds-only engagement ══════════════════ */
{
  STATE = workspace();
  STATE['vynora_engagement_' + A.code] = JSON.stringify(engWithSameRoleConflict());

  const { ctx, page, errors } = await open('synthesis.html');

  /* The record this runs against must have NO flat interviews array, or the
   * test passes against the old guard too and proves nothing. */
  const shape = await page.evaluate(`(() => {
    document.getElementById('client-input').value = ${JSON.stringify(A.name)};
    loadEngagement();
    return { flat: !!(engagement && engagement.interviews),
             roundIvs: (engagement.rounds[0].interviews || []).length };
  })()`);
  await page.waitForTimeout(1200);

  check('the fixture is rounds-only — no flat interviews array to fall back on',
    shape.flat === false && shape.roundIvs === 5, JSON.stringify(shape));

  // ── openDrillDown ──
  const drill = await page.evaluate(`(() => {
    openDrillDown('D5');
    var m = document.getElementById('drill-modal');
    var vis = m && getComputedStyle(m).display !== 'none';
    return {
      open: !!vis,
      // openDrillDown puts the CODE in the badge and the NAME in the title.
      badge: (document.getElementById('modal-dim-badge')||{}).textContent || '',
      title: (document.getElementById('modal-title')||{}).textContent || '',
      rows: document.querySelectorAll('#drill-modal .calc-row, #drill-modal .vs-card').length,
    };
  })()`);
  check('DEFECT 1 — clicking a dimension opens the drill-down on a rounds-only engagement',
    drill.open === true, JSON.stringify(drill));
  check('...and it is the dimension that was clicked',
    drill.badge === 'D5' && /Process/.test(drill.title), JSON.stringify(drill));

  await page.evaluate(`closeDrillDown()`);

  // ── openConflictDrillDown ──
  const conflict = await page.evaluate(`(() => {
    openConflictDrillDown('D5');
    var m = document.getElementById('drill-modal');
    var vis = m && getComputedStyle(m).display !== 'none';
    return {
      open: !!vis,
      subtitle: (document.getElementById('modal-subtitle')||{}).textContent || '',
      hero: (document.querySelector('.cdim-spread-sub')||{}).textContent || '',
      spreadNum: (document.querySelector('.cdim-spread-num')||{}).textContent || '',
    };
  })()`);

  check('DEFECT 1 — clicking a contradiction opens its drill-down too',
    conflict.open === true, JSON.stringify(conflict).slice(0, 200));

  /* THE COPY. Grace scored 5 and Tomas 2, so the spread is 3.0. The old
   * sentence interpolated high.score and said "5 points higher", which is not
   * a difference between anything — it is one of the two scores. */
  check('DEFECT 2 — the header quotes the SPREAD (3.0), not the higher score (5)',
    /\b3\.0 points higher\b/.test(conflict.hero), conflict.hero);
  check('...and does not say "5 points higher"',
    !/\b5 points higher\b/.test(conflict.hero), conflict.hero);
  check('...the spread agrees with the Δ shown above it',
    conflict.spreadNum.includes('3.0') && conflict.subtitle.includes('Δ3.0'),
    conflict.spreadNum + ' | ' + conflict.subtitle);

  /* THE NAMING. Both ends are VP Operations, so the roles alone cannot tell
   * the reader who is who. */
  check('DEFECT 2 — both ends are named when the two people share a job title',
    conflict.hero.includes('Grace Okonkwo') && conflict.hero.includes('Tomas Reinholt'),
    conflict.hero);
  check('...and it no longer reads "X than X"',
    !/VP Operations scored D5 [^]*? than VP Operations —/.test(conflict.hero),
    conflict.hero);

  await page.evaluate(`closeDrillDown()`);

  /* The other direction: when the roles DIFFER, adding names would be noise.
   * D6 has CEO 1, CTO 2, CFO 2 — different roles at each end. */
  const diffRoles = await page.evaluate(`(() => {
    openConflictDrillDown('D6');
    return { hero: (document.querySelector('.cdim-spread-sub')||{}).textContent || '' };
  })()`);
  check('when the roles differ the header stays on roles alone',
    /CEO/.test(diffRoles.hero) && !/\(/.test(diffRoles.hero), diffRoles.hero);

  check('no uncaught page errors while drilling', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/* ══ 3 — the interview tracker, one row per PERSON ═════════════════════════ */
{
  STATE = workspace();
  const { ctx, page, errors } = await open('synthesis.html');
  const tracker = await page.evaluate(`(() => {
    document.getElementById('client-input').value = ${JSON.stringify(A.name)};
    loadEngagement();
    return null;
  })()`);
  await page.waitForTimeout(1400);

  const rows = await page.evaluate(`(() => {
    return [...document.querySelectorAll('#interview-tracker .interview-row')].map(function(r){
      return {
        role: (r.querySelector('.iv-role')||{}).textContent || '',
        person: (r.querySelector('.iv-name')||{}).textContent || '',
        status: (r.querySelector('.iv-status')||{}).textContent || '',
        score: (r.querySelector('.iv-score')||{}).textContent || '',
      };
    });
  })()`);

  const ops = rows.filter((r) => /VP Operations/i.test(r.role));
  check('DEFECT 3 — both VP Operations appear in the tracker, not one',
    ops.length === 2, `${ops.length} row(s): ` + JSON.stringify(ops));
  check('...and they are named',
    ops.some((r) => r.person === 'Tomas Reinholt') && ops.some((r) => r.person === 'Grace Okonkwo'),
    JSON.stringify(ops.map((o) => o.person)));
  check('...with their OWN averages, not one average shown twice',
    ops.length === 2 && ops[0].score !== ops[1].score,
    JSON.stringify(ops.map((o) => o.score)));

  /* The roster half of the panel must survive: CDO is in the briefing's
   * roleCatalog... it is not, so use the invited-but-not-done case instead —
   * every role in the catalog with no interview renders exactly one Pending
   * row, and none of them is duplicated. */
  const pending = rows.filter((r) => /Pending/i.test(r.status));
  check('a role nobody has been interviewed for still renders ONE pending row',
    pending.length === new Set(pending.map((p) => p.role)).size,
    JSON.stringify(pending.map((p) => p.role)));
  check('every completed row carries a person name',
    rows.filter((r) => /Done/.test(r.status)).every((r) => r.person.length > 0),
    JSON.stringify(rows.filter((r) => /Done/.test(r.status)).map((r) => r.person)));
  check('the tracker shows one row per interview that happened (5)',
    rows.filter((r) => /Done/.test(r.status)).length === 5,
    String(rows.filter((r) => /Done/.test(r.status)).length));

  check('no uncaught page errors rendering the tracker', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/* ══ 4 — the roadmap handoff pushes the LOADED engagement ══════════════════ */
{
  /* Harbourline is the NEWER record (createdAt 2026-08-04 against Northwind's
   * 2026-07-01). Give it scores, so the old code would not merely alert — it
   * would succeed, writing the wrong client's roadmap. That is the case worth
   * pinning: a failure you can see is not the dangerous one. */
  STATE = workspace();
  const engB = JSON.parse(STATE['vynora_engagement_' + B.code]);
  engB.rounds[0].status = 'complete';
  engB.rounds[0].scores = { D1: 4.1, D2: 4.4, D3: 4.0, D4: 3.9, D5: 4.2, D6: 3.8, D7: 4.0 };
  engB.rounds[0].interviews = [{ role: 'CEO', interviewee: 'Dana Whitfield', name: 'Dana Whitfield',
    sourceInterviewId: 'iv-hbl-1', scores: engB.rounds[0].scores, findings: [] }];
  STATE['vynora_engagement_' + B.code] = JSON.stringify(engB);

  const { ctx, page, errors } = await open('synthesis.html');

  const out = await page.evaluate(`(() => {
    var alerts = [];
    var realAlert = window.alert; window.alert = function(m){ alerts.push(String(m)); };
    document.getElementById('client-input').value = ${JSON.stringify(A.name)};
    loadEngagement();
    return { alerts: alerts, loaded: engagement && engagement.code };
  })()`);
  await page.waitForTimeout(1200);

  const pushed = await page.evaluate(`(() => {
    var alerts = [];
    window.alert = function(m){ alerts.push(String(m)); };
    pushToRoadmapBuilder();
    return {
      alerts: alerts,
      keys: vyneStore.keys().filter(function(k){ return k.indexOf('vynora_roadmap_scores_') === 0; }).sort(),
      mine: JSON.parse(vyneStore.getItem('vynora_roadmap_scores_${A.code}') || 'null'),
      theirs: JSON.parse(vyneStore.getItem('vynora_roadmap_scores_${B.code}') || 'null'),
    };
  })()`);

  check('the newer engagement really is the OTHER one (else this proves nothing)',
    out.loaded === A.code, `loaded ${out.loaded}, newer record is ${B.code}`);
  check('DEFECT 4 — the push writes the LOADED client’s scores',
    !!pushed.mine && pushed.mine.clientName === A.name, JSON.stringify(pushed.mine));
  check('...and writes nothing for the client that merely has a newer createdAt',
    pushed.theirs === null, JSON.stringify(pushed.keys));
  check('...it pushed exactly one engagement',
    pushed.keys.length === 1, JSON.stringify(pushed.keys));
  check('...silently, with no alert',
    pushed.alerts.length === 0, JSON.stringify(pushed.alerts));

  await ctx.close();
  check('no uncaught page errors during the push', errors.length === 0, errors.join(' | '));
}

/* ══ 4b — with nothing loaded it says so, rather than guessing ═════════════ */
{
  /* No activeClient AND no last-briefing pointer. Both have to go: the page
   * auto-restores whichever client was last worked on, so dropping only the
   * session's activeClient still lands on a loaded engagement — which is how
   * the first draft of this case passed against the fixed code for the wrong
   * reason, reporting "refuses" about a page that had quietly loaded Northwind. */
  STATE = workspace();
  delete STATE.vynora_last_briefing;
  const { ctx, page } = await open('synthesis.html', { activeClient: undefined });
  const out = await page.evaluate(`(() => {
    var alerts = [];
    window.alert = function(m){ alerts.push(String(m)); };
    var loadedBefore = !!(typeof engagement !== 'undefined' && engagement && engagement.code);
    pushToRoadmapBuilder();
    return {
      loadedBefore: loadedBefore,
      alerts: alerts,
      keys: vyneStore.keys().filter(function(k){ return k.indexOf('vynora_roadmap_scores_') === 0; }),
    };
  })()`);
  check('nothing is loaded, so the refusal is about an empty page (not a loaded one)',
    out.loadedBefore === false, JSON.stringify(out));
  check('DEFECT 4 — with no engagement loaded it refuses and explains',
    out.alerts.length === 1 && /Load an engagement first/i.test(out.alerts[0]),
    JSON.stringify(out.alerts));
  check('...and writes nothing at all',
    out.keys.length === 0, JSON.stringify(out.keys));
  await ctx.close();
}

/* ══ 5 — the interviewee's buttons are actually gold ═══════════════════════ */
{
  STATE = workspace();
  const { ctx, page, errors } = await open('interview_agent.html', {
    role: 'interviewee', email: 'peter.osei@northwindfreight.example', activeClient: undefined,
  });

  const btn = await page.evaluate(`(() => {
    var _iv = vyneInterview.mine();
    _iv.client_name = ${JSON.stringify(A.name)};
    _iv.id = 'iv-cto';
    _iv.interviewee_name = 'Peter Osei';
    _iv.interviewee_role = 'CTO';
    _iv.interviewer_name = 'Vyn';
    var _ov = document.getElementById('vyne-iv-overlay'); if (_ov) _ov.remove();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    return null;
  })()`);
  await page.waitForTimeout(1400);

  const styles = await page.evaluate(`(() => {
    var ov = document.getElementById('vyne-iv-overlay');
    if (!ov) return { found: false };
    var b = [...ov.querySelectorAll('button')];
    if (!b.length) return { found: true, buttons: 0 };
    var cta = b[0];
    var cs = getComputedStyle(cta);
    return {
      found: true, buttons: b.length,
      label: (cta.textContent || '').trim().slice(0, 40),
      styleAttr: cta.getAttribute('style') || '',
      background: cs.backgroundColor,
      color: cs.color,
      weight: cs.fontWeight,
    };
  })()`);

  check('the interviewee welcome panel rendered with a call to action',
    styles.found === true && styles.buttons > 0, JSON.stringify(styles));

  /* THE DEFECT, stated as the browser sees it. `font:600 15px "Inter"` closed
   * the style attribute at the quote, so background and color never reached
   * the element and the browser painted its default button chrome. */
  check('DEFECT 5 — the style attribute survives intact past the font shorthand',
    /background:#C6A46B/.test(styles.styleAttr) && /color:#01203D/.test(styles.styleAttr),
    styles.styleAttr);
  check('...so the button is actually VYNE gold, not browser grey',
    styles.background === 'rgb(198, 164, 107)', styles.background);
  check('...with the navy label it was meant to have',
    styles.color === 'rgb(1, 32, 61)', styles.color);
  check('...and the font weight from the shorthand still applies',
    styles.weight === '600', styles.weight);

  check('no uncaught page errors on the interviewee page', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/* ══ 6 — one benchmark legend, not two ════════════════════════════════════ */
{
  STATE = workspace();
  const { ctx, page, errors } = await open('interview_agent.html');

  const legends = await page.evaluate(`(() => {
    S.client = ${JSON.stringify(A.name)};
    S.stakeholderRole = 'CTO';
    S.stakeholderName = 'Peter Osei';
    S.industry = 'Logistics';
    var br = loadBriefingContext(S.client);
    if (br && br.benchmarks) S.benchmarks = br.benchmarks;
    S.scores = { D1: 3, D2: 4, D6: 2 };
    renderScorecard();
    var host = document.getElementById('dim-grid') || document.getElementById('scorecard-grid');
    var all = [...document.querySelectorAll('span')].filter(function(s){
      return (s.textContent || '').trim() === 'Industry avg';
    });
    return {
      benchmarksPresent: !!(S.benchmarks && Object.values(S.benchmarks).some(function(b){ return b && b.avg; })),
      legendCount: all.length,
    };
  })()`);

  check('the benchmarks are present, so a legend is expected at all',
    legends.benchmarksPresent === true, JSON.stringify(legends));
  check('DEFECT 6 — the live scorecard renders exactly ONE benchmark legend',
    legends.legendCount === 1, `${legends.legendCount} "Industry avg" markers`);

  /* Re-rendering must not accumulate them either — renderScorecard() runs after
   * every scored answer, so a legend appended per call would grow all session. */
  const after = await page.evaluate(`(() => {
    renderScorecard(); renderScorecard(); renderScorecard();
    return [...document.querySelectorAll('span')].filter(function(s){
      return (s.textContent || '').trim() === 'Industry avg';
    }).length;
  })()`);
  check('...and re-rendering four times still leaves one', after === 1, String(after));

  check('no uncaught page errors rendering the scorecard', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/* ══ 7 — a briefing pack whose hypotheses carry no index ═══════════════════ */
{
  /* Not one of the six visible defects — found alongside them. A pack written
   * by anything that does not stamp `index` produced a column of NaN badges
   * and, worse, ONE shared state slot: marking the third hypothesis Confirmed
   * marked all of them. */
  STATE = workspace();
  const { ctx, page, errors } = await open('pre_engagement.html');

  const out = await page.evaluate(`(() => {
    restoreBriefingPack({
      client: 'Indexless Ltd', industry: 'Logistics',
      hypotheses: [
        { text: 'First hypothesis', status: 'open' },
        { text: 'Second hypothesis', status: 'confirmed', note: 'CEO and CTO agree' },
        { text: 'Third hypothesis', status: 'rejected' },
      ],
    }, null);
    var badges = [...document.querySelectorAll('#hypotheses-grid .hyp-num')].map(function(n){ return n.textContent; });
    return {
      badges: badges,
      stateKeys: Object.keys(hypothesesState).sort(),
      texts: Object.values(hypothesesState).map(function(h){ return h.text; }),
      ids: [...document.querySelectorAll('#hypotheses-grid .hyp-card')].map(function(c){ return c.id; }),
    };
  })()`);

  check('DEFECT 7 — index-less hypotheses number 1, 2, 3 rather than NaN',
    JSON.stringify(out.badges) === JSON.stringify(['1', '2', '3']), JSON.stringify(out.badges));
  check('...each gets its OWN state slot, so marking one does not mark all',
    out.stateKeys.length === 3, JSON.stringify(out.stateKeys));
  check('...and all three texts survive rather than collapsing to the last',
    new Set(out.texts).size === 3, JSON.stringify(out.texts));
  check('...with distinct element ids, so the note fields are independent',
    new Set(out.ids).size === 3 && !out.ids.some((i) => /undefined|NaN/.test(i)),
    JSON.stringify(out.ids));

  /* And a pack that DOES carry index is unchanged — the fallback must not
   * renumber a pack the product itself wrote. */
  const withIndex = await page.evaluate(`(() => {
    restoreBriefingPack({
      client: 'Indexed Ltd', industry: 'Logistics',
      hypotheses: [
        { index: 4, text: 'Fifth by position', status: 'open' },
        { index: 7, text: 'Eighth by position', status: 'open' },
      ],
    }, null);
    return {
      badges: [...document.querySelectorAll('#hypotheses-grid .hyp-num')].map(function(n){ return n.textContent; }),
      stateKeys: Object.keys(hypothesesState).sort(),
    };
  })()`);
  check('a pack that carries its own index keeps it',
    JSON.stringify(withIndex.badges) === JSON.stringify(['5', '8']),
    JSON.stringify(withIndex.badges) + ' keys ' + JSON.stringify(withIndex.stateKeys));

  check('no uncaught page errors restoring a briefing', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

await browser.close();
server.close();

console.log('\n=== v5.33.7 — DEFECTS FOUND BY THE TRAINING SCREENSHOT PASS ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n        ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
