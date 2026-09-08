/**
 * END-TO-END TEST for the transcript viewer's evidence panel (interviews.html).
 *
 *   node frontend/test/transcript-e2e.mjs
 *
 * WHY THIS EXISTS. The transcript could always answer "what was said". The
 * question a client actually asks is "why is D6 a 2.4", and answering it meant
 * reading the whole conversation and inferring backwards, because the scores
 * lived in the engagement record and the words lived in the transcript with
 * nothing joining them.
 *
 * v5.32.66 puts the score MOVEMENTS and the findings beside the words. The
 * server half is unit- and route-tested; this is the half that has to be true
 * in a browser — that a movement renders against the exchange that caused it,
 * that an anchor still lands correctly when a blank message shifts the array,
 * and that an interview with no trail says so rather than showing an empty
 * panel that reads as "nothing was found".
 *
 * That last one matters most. A viewer that silently renders nothing is
 * indistinguishable from an interview that found nothing, and a consultant has
 * no way to tell which they are looking at.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8807;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const INTERVIEWS = [
  { id: 'iv-full', client_name: 'Acme Industrial', interviewee_name: 'Dana Fox',
    interviewee_role: 'CFO', email: 'dana@acme.com', status: 'completed',
    interviewer_name: 'Vyn', interviewer_voice: null, round_number: 1,
    kind: 'initial', created_at: '2026-08-10T10:00:00Z',
    started_at: '2026-08-10T10:00:00Z', completed_at: '2026-08-10T11:00:00Z' },
  { id: 'iv-bare', client_name: 'Acme Industrial', interviewee_name: 'Old Interview',
    interviewee_role: 'COO', email: 'old@acme.com', status: 'completed',
    interviewer_name: 'Vyn', interviewer_voice: null, round_number: 1,
    kind: 'initial', created_at: '2026-08-01T10:00:00Z',
    started_at: '2026-08-01T10:00:00Z', completed_at: '2026-08-01T11:00:00Z' },
];

const FINDING = 'Nobody owns model governance and the board has not been told.';

/* A conversation with a BLANK message in the middle. `turns` drops it, so the
 * array position and the position a score was journalled against diverge — the
 * exact case where an anchor lands on the wrong answer if idx is ignored. */
const TRANSCRIPTS = {
  'iv-full': {
    id: 't1', client_name: 'Acme Industrial', interviewee_name: 'Dana Fox',
    interviewee_role: 'CFO', round_number: 1, turn_count: 4, mode: 'text',
    captured_at: '2026-08-10T11:00:00Z',
    turns: [
      { who: 'Interviewer', text: 'Tell me how data is managed today.', at: 1000, idx: 0 },
      { who: 'Interviewee', text: 'We have a warehouse but no catalogue.', at: 2000, idx: 1 },
      // idx 2 was a blank message, filtered out on the way in.
      { who: 'Interviewer', text: 'And who signs off on a model going live?', at: 3000, idx: 3 },
      { who: 'Interviewee', text: 'Honestly, nobody does.', at: 4000, idx: 4 },
    ],
    score_events: [
      { dimension: 'D1', from: null, to: 2, afterTurn: 2, at: 2100 },
      { dimension: 'D6', from: null, to: 1.5, afterTurn: 5, at: 4100 },
      { dimension: 'D1', from: 2, to: 2.5, afterTurn: 5, at: 4200 },
    ],
    findings: [{ dimension: 'D6', text: FINDING, afterTurn: 5, at: 4150 }],
  },
  'iv-bare': {
    id: 't2', client_name: 'Acme Industrial', interviewee_name: 'Old Interview',
    interviewee_role: 'COO', round_number: 1, turn_count: 2, mode: 'voice',
    captured_at: '2026-08-01T11:00:00Z',
    turns: [
      { who: 'Interviewer', text: 'How is governance handled?', at: 1, idx: 0 },
      { who: 'Interviewee', text: 'We are working on it.', at: 2, idx: 1 },
    ],
    score_events: null,
    findings: null,
  },
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

  const m = /^\/api\/interviews\/([^/]+)\/transcript$/.exec(url);
  if (m) {
    const t = TRANSCRIPTS[m[1]];
    return t ? json({ transcripts: [t] }) : json({ error: 'no_transcript' }, 404);
  }
  if (url === '/api/interviews' && req.method === 'GET') return json({ interviews: INTERVIEWS });
  if (url === '/api/voice/voices') return json({ voices: [] });
  if (url.startsWith('/api/module-state/')) return json({ module: 'workspace', state: {} });
  if (url === '/api/me') return json({ userId: 'u1', role: 'consultant', email: 'c@firm.com' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/firms/team') return json({ members: [] });
  if (url === '/api/clients') return json({ clients: ['Acme Industrial'] });
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
    token: 'tok', email: 'c@firm.com', role: 'consultant', mode: 'dev',
    at: Date.now(), la: Date.now() })); } catch (e) {}
`);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForTimeout(1200);

// ── 1. The interview with a full trail ──────────────────────────────────────
await page.evaluate(`viewTranscript('iv-full','Dana Fox')`);
await page.waitForTimeout(600);

const full = await page.evaluate(`(() => {
  const ov = document.getElementById('transcript-overlay');
  const body = document.getElementById('transcript-body');
  const text = body.textContent;
  // Where does each movement land relative to the exchange text?
  const idx = (s) => text.indexOf(s);
  return {
    open: ov.style.display === 'flex',
    text,
    posAnswer1: idx('We have a warehouse but no catalogue.'),
    posD1First: idx('first evidence'),
    posAnswer2: idx('Honestly, nobody does.'),
    posFindingInline: text.lastIndexOf('FINDING'),
    hasSummaryFindings: text.indexOf('1 finding recorded during this interview') >= 0,
    hasWhereEnded: text.indexOf('Where each score ended up') >= 0,
    movementCount: (text.match(/movements? during the conversation/g) || []).length,
    saysThreeMovements: text.indexOf('3 movements during the conversation') >= 0,
    mentionsApprox: text.indexOf('Positions are approximate') >= 0,
  };
})()`);

check('the transcript overlay opens', full.open);
check('the conversation is still there', full.posAnswer1 > -1 && full.posAnswer2 > -1);
check('findings are summarised at the top', full.hasSummaryFindings, full.text.slice(0, 200));
check('the final score of each dimension is summarised', full.hasWhereEnded);
check('it reports the number of movements', full.saysThreeMovements, String(full.movementCount));
check('a first score reads as "first evidence", not a move from zero',
  full.posD1First > -1);
check('the D1 first-evidence movement renders AFTER the answer that produced it',
  full.posD1First > full.posAnswer1, `answer@${full.posAnswer1} movement@${full.posD1First}`);
check('the finding renders inline, after the last exchange',
  full.posFindingInline > full.posAnswer2,
  `answer@${full.posAnswer2} finding@${full.posFindingInline}`);
check('a journalled trail is NOT labelled approximate', !full.mentionsApprox);

// The anchor test, stated precisely: afterTurn 5 must land on the LAST turn
// (original index 4), not run off the end, even though `turns` has only 4
// entries because a blank message was filtered out.
const anchoring = await page.evaluate(`(() => {
  const body = document.getElementById('transcript-body');
  const text = body.textContent;
  const lastAnswer = text.indexOf('Honestly, nobody does.');
  return {
    // Searching FROM the last answer, not from the start — D6 also appears in
    // the findings summary at the top, so a plain indexOf would pass on that
    // and prove nothing about where the movement rendered.
    d6AfterLastAnswer: text.indexOf('D6', lastAnswer) > lastAnswer,
    // And exactly one D1 movement each: a double render is the failure this
    // whole anchoring scheme invites.
    d1Movements: (text.match(/D1/g) || []).length,
    // Nothing should have been swept into the "after the final exchange"
    // bucket: every anchor here is within range once idx is respected.
    noTrailingBucket: text.indexOf('After the final exchange') === -1,
  };
})()`);
check('an anchor past the filtered blank message still lands on the right turn',
  anchoring.d6AfterLastAnswer);
check('no movement is rendered twice', anchoring.d1Movements === 3, String(anchoring.d1Movements));
check('nothing was pushed into the out-of-range bucket', anchoring.noTrailingBucket);

check('the score movements do not leak raw HTML', !full.text.includes('<div'));

// ── 2. The interview with NO trail ──────────────────────────────────────────
await page.evaluate(`closeTranscript()`);
await page.evaluate(`viewTranscript('iv-bare','Old Interview')`);
await page.waitForTimeout(600);

const bare = await page.evaluate(`(() => {
  const text = document.getElementById('transcript-body').textContent;
  return {
    text,
    saysNoTrail: text.indexOf('No score trail was stored') >= 0,
    // v5.32.89: and it must NOT assert a reason it cannot know. The old copy
    // blamed the interview's age, which was wrong for every synthetic
    // interview ever generated — the synthetic route never wrote a trail at
    // any version, so "recorded from v5.32.66 onward" explained nothing and
    // misdirected the reader.
    blamesAge: /trails are recorded from v5\.32\.66 onward/.test(text),
    stillHasWords: text.indexOf('We are working on it.') >= 0,
    doesNotClaimNoFindings: text.indexOf('0 findings') === -1,
  };
})()`);
check('an interview with no trail SAYS so', bare.saysNoTrail, bare.text.slice(0, 200));
check('and does not assert a reason the row cannot carry',
  !bare.blamesAge, bare.text.slice(0, 240));
check('and never implies the interview found nothing', bare.doesNotClaimNoFindings);
check('the conversation itself still renders', bare.stillHasWords);

// ── 3. A trail reconstructed server-side is labelled as such ────────────────
const derived = await page.evaluate(`(() => {
  // Same viewer, a payload carrying the derived flag. Built in place rather
  // than through the network stub so the assertion is about the RENDERING rule
  // and not about a second fixture drifting from the first.
  const t = {
    id: 't3', client_name: 'Acme Industrial', interviewee_name: 'X', interviewee_role: 'CFO',
    round_number: 1, turn_count: 1, mode: 'text', captured_at: '2026-08-10T11:00:00Z',
    turns: [{ who: 'Interviewee', text: 'An answer.', at: 1, idx: 0 }],
    score_events: [{ dimension: 'D1', from: null, to: 3, afterTurn: 1, at: null, derived: true }],
    findings: null,
  };
  window.__t = t;
  return true;
})()`);
check('fixture for the reconstructed case was built', derived === true);

const derivedRender = await page.evaluate(`(async () => {
  // Point the stub at the in-page fixture by overriding fetch for one call.
  const realFetch = window.fetch;
  window.fetch = async (u, o) => {
    if (String(u).indexOf('/transcript') >= 0) {
      return new Response(JSON.stringify({ transcripts: [window.__t] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(u, o);
  };
  closeTranscript();
  await viewTranscript('iv-derived', 'X');
  window.fetch = realFetch;
  const text = document.getElementById('transcript-body').textContent;
  return { approx: text.indexOf('Positions are approximate') >= 0, text };
})()`);
check('a reconstructed trail is labelled approximate rather than presented as exact',
  derivedRender.approx, derivedRender.text.slice(0, 240));

check('interviews.html threw nothing', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();

console.log('\n=== TRANSCRIPT EVIDENCE END-TO-END ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n        ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
