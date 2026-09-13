/**
 * END-TO-END TEST for the Interview Tracker (interviews.html).
 *
 *   node frontend/test/tracker-e2e.mjs
 *
 * WHY THIS EXISTS, stated plainly: the tracker has now shipped twice with a
 * feature missing because a patch failed to apply and nothing checked. The
 * Round field and the Round column were both written, both asserted in a build
 * script, and neither reached the release — because the script threw before it
 * wrote, and the only verification was reading the diff I thought I had made.
 *
 * Source greps cannot catch that class of mistake reliably, and neither can I.
 * A real browser loading the real page against a fake backend can: if the
 * control is not in the DOM, or does not resolve, or does not reach the
 * request body, these fail.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8795;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

let invitePosts = [];
let patchPosts = [];

/**
 * Two interviews for one client, plus a THIRD sharing a login with the second —
 * the shadowing case. Ordered created_at DESC, as the real API returns them.
 */
const INTERVIEWS = [
  { id: 'iv-3', client_name: 'Acme Industrial', interviewee_name: 'Carla Reyes',
    interviewee_role: 'CDO', email: 'shared@acme.com', status: 'invited',
    interviewer_name: 'Marcus', interviewer_voice: 'Charon', round_number: 2,
    kind: 'initial', created_at: '2026-08-12T10:00:00Z', started_at: null, completed_at: null },
  { id: 'iv-2', client_name: 'Acme Industrial', interviewee_name: 'Bob Chen',
    interviewee_role: 'COO', email: 'shared@acme.com', status: 'invited',
    interviewer_name: 'Marcus', interviewer_voice: 'Charon', round_number: null,
    kind: 'initial', created_at: '2026-08-11T10:00:00Z', started_at: null, completed_at: null },
  { id: 'iv-1', client_name: 'Newco Ltd', interviewee_name: 'Dana Fox',
    interviewee_role: 'CEO', email: 'dana@newco.com', status: 'invited',
    interviewer_name: 'Vyn', interviewer_voice: null, round_number: null,
    kind: 'initial', created_at: '2026-08-10T10:00:00Z', started_at: null, completed_at: null },
  /* The widest realistic row, copied from a real tracker: a long company name,
   * a display-label role, a long address, and COMPLETED status — which is what
   * adds the fifth action button ("Request follow-up") and made the row wide
   * enough to paint outside the white panel. Without this row the overflow
   * assertions below measure short rows and prove nothing. */
  /* v5.32.84. Two rows sharing ONE login where the shadowed one is already
   * COMPLETED — the arrangement the product creates on purpose. A follow-up
   * reuses its parent's login and is newer by construction, so before the fix
   * requesting one painted a red "shadowed by" warning across the very
   * interview it was following up on. Ordered newest-first like the API. */
  { id: 'iv-fu', client_name: 'Acme Industrial', interviewee_name: 'Elena Rodriguez',
    interviewee_role: 'CHRO', email: 'elena@acme.com', status: 'invited',
    interviewer_name: 'Vyn', interviewer_voice: null, round_number: 2,
    kind: 'follow_up', parent_interview_id: 'iv-done', created_at: '2026-08-13T10:00:00Z',
    started_at: null, completed_at: null },
  { id: 'iv-done', client_name: 'Acme Industrial', interviewee_name: 'Elena Rodriguez',
    interviewee_role: 'CHRO', email: 'elena@acme.com', status: 'completed',
    interviewer_name: 'Vyn', interviewer_voice: null, round_number: 1,
    kind: 'initial', created_at: '2026-08-12T09:00:00Z',
    started_at: '2026-08-12T09:00:00Z', completed_at: '2026-08-12T10:00:00Z' },
  { id: 'iv-wide', client_name: 'Nissan Motors Corporation',
    interviewee_name: 'David Okafor [Synthetic]',
    interviewee_role: 'Operations / Frontline Manager',
    email: 'david.okafor.operations@nissanmotorscorporation.example.com',
    status: 'completed', interviewer_name: 'Vyn', interviewer_voice: null,
    round_number: 1, kind: 'initial', created_at: '2026-08-06T11:36:58Z',
    started_at: '2026-08-06T11:36:58Z', completed_at: '2026-08-06T11:36:58Z' },
];

/**
 * Acme is mid-round-2; Newco has no engagement record at all. Those are the two
 * cases a consultant meets, and they must render differently and correctly.
 */
const WORKSPACE = {
  vynora_engagement_index: JSON.stringify({ acmeindustrial: 'ACME01' }),
  vynora_engagement_ACME01: JSON.stringify({
    code: 'ACME01', client: 'Acme Industrial', currentRoundId: 'r2',
    rounds: [
      { roundId: 'r1', roundNumber: 1, label: 'Initial Diagnostic', status: 'complete' },
      { roundId: 'r2', roundNumber: 2, label: 'Q3 Refresh', status: 'active' },
    ],
  }),
  /* v5.32.90. Acme has a briefing, so its row editor offers the CONSULTANT'S
   * catalog. The catalog deliberately omits COO even though Bob Chen is a COO
   * on this client — a role can leave the catalog after the interview was
   * created, and that stale value must survive being looked at. Newco has no
   * briefing at all, so it falls back to the standard list; both paths are
   * exercised below. */
  vynora_briefing_acmeindustrial: JSON.stringify({
    client: 'Acme Industrial',
    roleCatalog: [
      { value: 'CEO', display: 'CEO / Executive Leadership' },
      { value: 'CDO', display: 'CDO / VP Data & Analytics' },
      { value: 'Head_Franchising', display: 'Head of Franchising', custom: true },
    ],
  }),
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url === '/api/interviews' && req.method === 'GET') return json({ interviews: INTERVIEWS });
  if (url === '/api/interviews' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => { try { invitePosts.push(JSON.parse(b)); } catch {} json({ id: 'new', loginHint: 'ok' }, 201); });
    return;
  }
  if (url.startsWith('/api/interviews/') && req.method === 'PATCH') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => { try { patchPosts.push(JSON.parse(b)); } catch {} json({ ok: true }); });
    return;
  }
  if (url === '/api/voice/voices') return json({ voices: [
    { id: 'Aoede', presents: 'female', character: 'breezy' },
    { id: 'Charon', presents: 'male', character: 'informative' } ] });
  if (url.startsWith('/api/module-state/')) return json({ module: 'workspace', state: WORKSPACE });
  if (url === '/api/me') return json({ userId: 'u1', role: 'consultant', email: 'c@firm.com' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/firms/team') return json({ members: [] });
  if (url === '/api/clients') return json({ clients: ['Acme Industrial', 'Newco Ltd'] });
  /* The row editor's client picker reads THIS. /api/me says consultant, so this
     also covers the branch that used to throw the list away for non-owners. */
  if (url === '/api/my-clients') return json({ role: 'consultant',
    clients: ['Acme Industrial', 'Newco Ltd', 'Caldera Health'] });
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
await ctx.addInitScript(() => {
  try {
    sessionStorage.setItem('vyne_session', JSON.stringify({
      token: 'tok', email: 'c@firm.com', role: 'consultant', mode: 'dev',
      at: Date.now(), la: Date.now() }));
  } catch (e) {}
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForTimeout(1200);

// ── The controls must EXIST ─────────────────────────────────────────────────
const controls = await page.evaluate(() => ({
  round: !!document.getElementById('iv-round'),
  interviewerName: !!document.getElementById('iv-interviewer-name'),
  interviewerVoice: !!document.getElementById('iv-interviewer-voice'),
  headers: [...document.getElementById('rows').closest('table')
    .querySelectorAll('thead th')].map((t) => t.textContent.trim()),
}));
check('invite form has a Round field', controls.round);
check('invite form has interviewer name + voice', controls.interviewerName && controls.interviewerVoice);
check('the table has a Round column', controls.headers.includes('Round'), controls.headers.join(' | '));

// ── And the column must RESOLVE, never blank ────────────────────────────────
const rows = await page.evaluate(() => {
  const hdr = [...document.getElementById('rows').closest('table')
    .querySelectorAll('thead th')].map((t) => t.textContent.trim());
  const ri = hdr.indexOf('Round');
  return [...document.querySelectorAll('#rows tr')].map((tr) => {
    const tds = [...tr.querySelectorAll('td')];
    return {
      name: tds[1] ? tds[1].textContent.trim() : '',
      round: ri >= 0 && tds[ri] ? tds[ri].textContent.trim() : '',
      login: tds.map((t) => t.textContent).join(' '),
    };
  });
});
const carla = rows.find((r) => r.name.includes('Carla'));
const bob = rows.find((r) => r.name.includes('Bob'));
const dana = rows.find((r) => r.name.includes('Dana'));

check('a PINNED round shows its number and says it was set on the invite',
  !!carla && /Round 2/.test(carla.round) && /set on invite/i.test(carla.round),
  carla && carla.round);
check('an UNPINNED round resolves to the client\'s current round, not blank',
  !!bob && /Round 2/.test(bob.round) && /current/i.test(bob.round),
  bob && bob.round);
check('the resolved round names the round label so it is recognisable',
  !!bob && /Q3 Refresh/.test(bob.round), bob && bob.round);
check('a client with NO engagement record still shows a round, not blank',
  !!dana && /Round 1/.test(dana.round), dana && dana.round);
check('no round cell is ever empty',
  rows.length === INTERVIEWS.length && rows.every((r) => r.round.trim().length > 0),
  JSON.stringify(rows.map((r) => r.round)));

// ── The shadowed login is flagged ───────────────────────────────────────────
check('a login used by two interviews is flagged on the shadowed row',
  !!bob && /shadowed/i.test(bob.login), bob && bob.login.slice(0, 120));
check('the row that actually wins the login is NOT flagged',
  !!carla && !/shadowed/i.test(carla.login), carla && carla.login.slice(0, 120));

/*
 * v5.32.84. Both rows below share one login and only the newer is reachable —
 * so the OLD rule flagged the completed one. It fired on every multi-round
 * engagement, on every follow-up, and on every synthetic engagement, which is
 * to say on the design working correctly. A warning that is loudest where
 * sharing is intended teaches the reader to skim it, and skimming it costs the
 * case it exists for.
 *
 * Both directions are asserted. Suppressing the noise is only worth doing if
 * the signal survives, and the check above (Bob, invited, shadowed by Carla)
 * is that signal.
 */
const rowsById = await page.evaluate(() =>
  Object.fromEntries([...document.querySelectorAll('#rows tr')].map((tr) => [
    tr.id, [...tr.querySelectorAll('td')].map((t) => t.textContent).join(' '),
  ])));
check('a COMPLETED interview is not flagged as shadowed by its own follow-up',
  !!rowsById['row-iv-done'] && !/shadowed/i.test(rowsById['row-iv-done']),
  (rowsById['row-iv-done'] || '(row missing)').slice(0, 140));
check('the follow-up that wins the login is not flagged either',
  !!rowsById['row-iv-fu'] && !/shadowed/i.test(rowsById['row-iv-fu']),
  (rowsById['row-iv-fu'] || '(row missing)').slice(0, 140));
check('an INVITED row sharing a login is still flagged — the signal survives',
  !!bob && /shadowed/i.test(bob.login), bob && bob.login.slice(0, 120));

// ── The Round field must reach the REQUEST, not just the screen ─────────────
await page.evaluate(() => {
  // Dispatch the event, don't just set the value: the role list is built by
  // iv-client's oninput handler, exactly as it is when a consultant types.
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) { el.value = v; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }
  };
  set('iv-client', 'Acme Industrial');
  set('iv-name', 'Erin Vale');
  set('iv-email', 'erin@acme.com');
  set('iv-password', 'abcdefghij');
  set('iv-round', '3');
  const role = document.getElementById('iv-role');
  if (role && role.options.length > 1) {
    role.selectedIndex = 1;
    role.dispatchEvent(new Event('change'));
  }
  return createInvite();
});
await page.waitForTimeout(500);
const inviteMsg = await page.evaluate(() => {
  const r = document.getElementById('iv-role');
  return ((document.getElementById('create-msg')||{}).textContent || '')
    + ' [role opts=' + (r ? r.options.length : -1) + ' value=' + (r ? JSON.stringify(r.value) : 'n/a') + ']';
});
check('the chosen round reaches the invite request',
  invitePosts.length === 1 && invitePosts[0].roundNumber === 3,
  JSON.stringify(invitePosts[0] || {}).slice(0, 200) + ' | form said: ' + inviteMsg);

// A blank round must be OMITTED, not sent as 0 or NaN — the server reads
// absent as "current round", and NaN would fail validation outright.
invitePosts = [];
await page.evaluate(() => {
  // Tolerant of a MISSING field on purpose: when the control has been lost —
  // which is exactly the regression this file was written for — the run must
  // report a clean FAIL for every affected assertion rather than crashing on
  // the first null and hiding the rest.
  const el = (id) => document.getElementById(id) || {};
  el('iv-round').value = '';
  el('iv-name').value = 'Frank Ng';
  el('iv-email').value = 'frank@acme.com';
  return createInvite();
});
await page.waitForTimeout(500);
check('a blank round is omitted from the request entirely',
  invitePosts.length === 1 && !('roundNumber' in invitePosts[0]),
  JSON.stringify(invitePosts[0] || {}).slice(0, 200));

// ── Editing a row can change the round ──────────────────────────────────────
await page.evaluate(() => editRow('iv-1'));
await page.waitForTimeout(200);
const hasRowInput = await page.evaluate(() =>
  !!document.querySelector("[data-f='roundNumber']"));
check('the row editor exposes the round', hasRowInput);
await page.evaluate(() => {
  const el = document.querySelector("[data-f='roundNumber']");
  if (el) el.value = '4';
  return saveRow('iv-1');
});
await page.waitForTimeout(500);
check('editing a row sends the new round',
  patchPosts.length >= 1 && patchPosts[0].roundNumber === 4,
  JSON.stringify(patchPosts[0] || {}).slice(0, 200));

/* ── Pre-Engagement is the master: the INVITE form too (v5.32.91) ───────────
 *
 * The row editor was locked down in .90; the create form still took a typed
 * client and offered an "Other role…" escape, so the discipline stopped at
 * the control most likely to introduce a bad identity in the first place.
 *
 * The rule is: a client is registered in Pre-Engagement (POST /api/engagements
 * — which is what puts it in /api/my-clients at all), its stakeholder map is
 * built there, and this module only ASSIGNS from those two lists.
 */
const inviteShape = await page.evaluate(() => {
  const c = document.getElementById('iv-client');
  const r = document.getElementById('iv-role');
  return {
    clientTag: c ? c.tagName : 'MISSING',
    roleTag: r ? r.tagName : 'MISSING',
    clientOpts: c && c.options ? [...c.options].map((o) => o.value) : null,
    roleOpts: r && r.options ? [...r.options].map((o) => o.value) : null,
    customRow: !!document.getElementById('iv-role-custom-row'),
    hint: (document.getElementById('iv-source-hint') || {}).textContent || '',
  };
});
check('the invite form picks the client from a list', inviteShape.clientTag === 'SELECT', inviteShape.clientTag);
check('the invite client list is populated AT PAGE LOAD',
  !!inviteShape.clientOpts && inviteShape.clientOpts.includes('Acme Industrial'),
  JSON.stringify(inviteShape.clientOpts));
check('the custom-role escape hatch is gone',
  !inviteShape.customRow && !!inviteShape.roleOpts && !inviteShape.roleOpts.includes('__custom__'),
  JSON.stringify(inviteShape.roleOpts));
check('the form says where clients and roles come from',
  /Pre-Engagement/.test(inviteShape.hint), inviteShape.hint.slice(0, 120));

/* Acme HAS a briefing → its catalog, and only its catalog. */
await page.evaluate(() => {
  const el = document.getElementById('iv-client');
  if (!el) return;
  el.value = 'Acme Industrial';
  el.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(150);
const acmeInvite = await page.evaluate(() => {
  const r = document.getElementById('iv-role');
  return { opts: r && r.options ? [...r.options].map((o) => o.value) : [],
           disabled: r ? r.disabled : null,
           hint: (document.getElementById('iv-source-hint') || {}).textContent || '' };
});
check('a client WITH a briefing offers exactly its stakeholder map',
  acmeInvite.opts.includes('Head_Franchising') && !acmeInvite.opts.includes('VP_Sales')
    && !acmeInvite.disabled,
  acmeInvite.opts.join(' | '));

/* Newco has no briefing → nothing to offer, and the form must SAY so rather
 * than present an empty dropdown, which reads as broken. */
await page.evaluate(() => {
  const el = document.getElementById('iv-client');
  if (!el) return;
  el.value = 'Newco Ltd';
  el.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(150);
const newcoInvite = await page.evaluate(() => {
  const r = document.getElementById('iv-role');
  return { opts: r && r.options ? [...r.options].map((o) => o.value).filter(Boolean) : null,
           disabled: r ? r.disabled : null,
           hint: (document.getElementById('iv-source-hint') || {}).textContent || '' };
});
check('a client with no stakeholder map offers no roles at all',
  !!newcoInvite.opts && newcoInvite.opts.length === 0,
  JSON.stringify(newcoInvite.opts));
check('and the role picker is disabled rather than silently empty',
  newcoInvite.disabled === true, String(newcoInvite.disabled));
check('and the hint names the client and points at Pre-Engagement',
  /Newco Ltd/.test(newcoInvite.hint) && /Pre-Engagement/.test(newcoInvite.hint),
  newcoInvite.hint.slice(0, 160));

/* Submitting anyway must explain the MISSING REGISTRATION, not blame typing. */
invitePosts = [];
const refusal = await page.evaluate(() => {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('iv-name', 'Gita Menon');
  set('iv-email', 'gita@newco.com');
  return Promise.resolve(createInvite()).then(() =>
    (document.getElementById('create-msg') || {}).textContent || '');
});
check('creating an invite without a stakeholder map is refused',
  invitePosts.length === 0, JSON.stringify(invitePosts));
check('and the refusal says to build the map in Pre-Engagement',
  /stakeholder map/.test(refusal) && /Pre-Engagement/.test(refusal), refusal);

/* ── Client and role are PICKED in the row editor, never typed (v5.32.90) ────
 *
 * Both fields are identities other modules key off, and a free-typed value
 * fails silently in the same way v5.32.10 already fixed for this page's two
 * other client controls:
 *
 *   · a client name matching nothing does not RENAME anything (that is
 *     PATCH /api/clients/rename, from Pre-Engagement) — it moves this one
 *     interview onto a normClient() identity that exists nowhere else,
 *     detaching it from its engagement so it stops reaching Synthesis
 *   · a role outside the catalog becomes a second identity under
 *     roleCanon.js, which is the v5.32.5 double-listing postmortem verbatim
 *
 * The person's NAME stays free text: it is a label, not a key.
 */
patchPosts = [];
await page.evaluate(() => editRow('iv-1'));           // Dana Fox · Newco Ltd · CEO
await page.waitForTimeout(200);

const shapes = await page.evaluate(() => {
  const tag = (f) => {
    const el = document.querySelector("[data-f='" + f + "']");
    return el ? el.tagName : 'MISSING';
  };
  return { client: tag('clientName'), role: tag('intervieweeRole'), name: tag('intervieweeName') };
});
check('the row editor picks the client from a list', shapes.client === 'SELECT', shapes.client);
check('the row editor picks the role from a list', shapes.role === 'SELECT', shapes.role);
check("the person's name is still free text", shapes.name === 'INPUT', shapes.name);

/* The consultant's own assigned clients, from /api/my-clients. Before this
 * release the page discarded that response for anyone who was not an owner,
 * which would leave a consultant a one-option picker and no way to move a
 * misfiled interview at all. */
const optsOf = (f) => page.evaluate((sel) => {
  // Tolerant on purpose, per this file's header: if the control has been lost
  // or reverted to an <input> it has no .options, and every assertion below
  // must still report rather than the run dying on the first one.
  const el = document.querySelector("[data-f='" + sel + "']");
  if (!el || !el.options) return null;
  return [...el.options].map((o) => ({ value: o.value, text: o.textContent.trim(), selected: o.selected }));
}, f);

const clientOptRows = await optsOf('clientName');
const clientOpts = (clientOptRows || []).map((o) => o.value);
check('the client list is the consultant\'s assigned clients',
  clientOpts.includes('Acme Industrial') && clientOpts.includes('Caldera Health'),
  clientOpts.join(' | '));
const currentClient = await page.evaluate(() => {
  const el = document.querySelector("[data-f='clientName']");
  return el ? el.value : null;
});
check('the current client is the selected one', currentClient === 'Newco Ltd', currentClient);

/* Newco has NO briefing, and as of v5.32.91 there is no standard-list
 * fallback to paper over that — Pre-Engagement is the only source of roles.
 * So the picker holds exactly one thing: Dana's existing role, carried
 * forward so editing anything else on this row cannot silently rewrite it. */
const newcoRoleRows = await optsOf('intervieweeRole');
const newcoRoles = {
  value: await page.evaluate(() => {
    const el = document.querySelector("[data-f='intervieweeRole']");
    return el ? el.value : null;
  }),
  opts: (newcoRoleRows || []).map((o) => o.value),
  texts: (newcoRoleRows || []).map((o) => o.text),
};
check('a client with no briefing offers no invented roles',
  newcoRoles.opts.length === 1 && !newcoRoles.opts.includes('VP_Sales'),
  newcoRoles.opts.join(' | '));
check('the current role is the selected one', newcoRoles.value === 'CEO', newcoRoles.value);
check('and it says the stakeholder map is missing, not that the role is odd',
  newcoRoles.texts.some((t) => /no stakeholder map/.test(t)), newcoRoles.texts.join(' | '));
check('there is no way to invent a role here',
  !newcoRoles.opts.includes('__custom__'), newcoRoles.opts.join(' | '));

/* Moving the interview to Acme must re-scope the roles to ACME'S catalog.
 * Leaving the old client's list up is how a role from one engagement gets
 * written onto another. */
await page.evaluate(() => {
  const el = document.querySelector("[data-f='clientName']");
  if (!el) return;
  el.value = 'Acme Industrial';
  el.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(150);
const acmeRoles = (await optsOf('intervieweeRole') || []).map((o) => o.text);
check('changing the client re-scopes the roles to that client\'s briefing',
  acmeRoles.some((t) => t.includes('Head of Franchising')) && !acmeRoles.some((t) => t.includes('VP Sales')),
  acmeRoles.join(' | '));

/* ── A role no longer in the catalog must SURVIVE being looked at ──────────
 *
 * Bob Chen is a COO on Acme, and Acme's catalog has no COO. A select that
 * simply dropped the value would rewrite his role the moment a consultant
 * edited the round on that row — turning a display inconsistency into data
 * loss, which is worse than the problem being fixed. It is carried as a
 * marked option instead, and a save that does not touch it sends it back
 * unchanged.
 */
await page.evaluate(() => refresh());
await page.waitForTimeout(400);
await page.evaluate(() => editRow('iv-2'));           // Bob Chen · Acme · COO
await page.waitForTimeout(200);
const staleRows = await optsOf('intervieweeRole');
const staleSel = (staleRows || []).find((o) => o.selected);
const stale = {
  value: await page.evaluate(() => {
    const el = document.querySelector("[data-f='intervieweeRole']");
    return el ? el.value : null;
  }),
  label: staleSel ? staleSel.text : '',
  opts: (staleRows || []).map((o) => o.value),
};
check('a role that has left the catalog is still selected, not dropped',
  stale.value === 'COO', stale.opts.join(' | '));
check('and it is marked as off-catalog rather than passed off as current',
  /not in this client's briefing/.test(stale.label), stale.label);

patchPosts = [];
await page.evaluate(() => saveRow('iv-2'));
await page.waitForTimeout(500);
check('saving an untouched row sends the stale role back unchanged',
  patchPosts.length === 1 && patchPosts[0].intervieweeRole === 'COO',
  JSON.stringify(patchPosts[0] || {}).slice(0, 200));
check('and does not blank the client either',
  patchPosts.length === 1 && patchPosts[0].clientName === 'Acme Industrial',
  JSON.stringify(patchPosts[0] || {}).slice(0, 200));

// The widest row must actually be on screen — otherwise everything below
// measures short rows and passes for the wrong reason.
const wideRow = await page.evaluate(() =>
  [...document.getElementById('rows').querySelectorAll('tr')]
    .some((tr) => (tr.textContent || '').includes('Nissan Motors Corporation')
      && (tr.textContent || '').includes('Request follow-up')));
check('the widest row (long name, long role, long email, completed) is rendered', wideRow);

// ── The table must stay INSIDE its white panel ──────────────────────────────
//
// v5.32.60. Ten columns, five action buttons held on one line by
// white-space:nowrap, plus full company names, display-label roles, long email
// addresses and full locale timestamps — the table's natural width exceeded
// the panel and the content painted outside the white card.
//
// Two distinct claims, measured separately:
//
//   · the PANEL must never overflow, at any width. That is the actual defect:
//     content escaping the card. A cell extending past the viewport inside a
//     clipping scroll wrapper is fine — it is not painted outside anything.
//
//   · on a normal laptop the table must FIT, with no scrolling needed. A
//     scroll wrapper alone would have silenced the symptom while leaving the
//     consultant dragging sideways to reach the Delete button on every row.
for (const [w, h] of [[1440, 900], [1280, 800], [1024, 768]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(350);
  const box = await page.evaluate(() => {
    const panel = document.getElementById('rows').closest('.panel');
    const scroller = document.querySelector('.table-scroll');
    return {
      panelOverflow: panel.scrollWidth - panel.clientWidth,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      hasScroller: !!scroller,
      overflowX: scroller ? getComputedStyle(scroller).overflowX : '',
      needsScroll: scroller ? scroller.scrollWidth - scroller.clientWidth : -1,
    };
  });
  check(`at ${w}px the white panel contains its table`, box.panelOverflow <= 1, `panel overflows by ${box.panelOverflow}px`);
  check(`at ${w}px the page itself does not scroll sideways`, box.docOverflow <= 1, `document overflows by ${box.docOverflow}px`);
  check(`at ${w}px overflow is absorbed by a clipping scroll wrapper`,
    box.hasScroller && box.overflowX === 'auto', JSON.stringify(box));
  if (w >= 1280) {
    check(`at ${w}px the table FITS — no sideways dragging to reach Delete`,
      box.needsScroll <= 1, `${box.needsScroll}px of hidden width`);
  }
}
await page.setViewportSize({ width: 1440, height: 900 });

check('no uncaught page errors', errors.length === 0, errors.join(' | ').slice(0, 200));

if (process.env.SHOT) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(400);
  const panel = await page.evaluateHandle(() => document.getElementById('rows').closest('.panel'));
  await (panel.asElement()).scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await (panel.asElement()).screenshot({ path: process.env.SHOT });
}
await browser.close();
server.close();

console.log('\n=== INTERVIEW TRACKER END-TO-END ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
