/**
 * END-TO-END TEST for renaming a client (pre_engagement.html, v5.32.92).
 *
 *   node frontend/test/rename-client-e2e.mjs
 *
 * WHY THIS EXISTS, stated plainly: v5.32.91 shipped a fix for this bug that
 * did not fix it, and a suite of STATIC source assertions went green anyway.
 *
 * The reported symptoms were: rename the client in the briefing, the interview
 * rows change, go back to the briefing and the OLD name is showing, the save
 * pill is red, and renaming back no longer reaches the tracker. v5.32.91
 * correctly identified that vyneStore's cache went stale behind the
 * server-side rename and added vyneStore.rehydrate(). That was real, and
 * insufficient, because it fixed the layer BELOW the one that decides what
 * the page loads.
 *
 * autoRestoreFromStore() consults the session's ACTIVE CLIENT first — by
 * design, since v5.17, so that a brand-new client gets a clean form instead of
 * the last client's. activeClient lives in sessionStorage. Nothing on the
 * server can touch it, rehydrate() does not touch it, and there was no setter
 * for it anywhere in the product. So after a rename it still named the OLD
 * client; the probe for that client's briefing found nothing (the server had
 * just renamed that key); and the page took the "brand-new client, restore
 * nothing" branch. Hence the revert. Every subsequent write then went out
 * under an identity the server no longer had.
 *
 * A source-text test cannot see any of that. This one drives the real page
 * against a fake API that renames keys the way the server actually does, and
 * asserts on what a consultant would SEE afterwards.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8823;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 100);

/* One client, briefed, with an engagement — the shape a rename acts on. */
function freshWorkspace() {
  return {
    vynora_engagement_index: JSON.stringify({ meridianfoods: 'MERI01' }),
    vynora_engagement_MERI01: JSON.stringify({
      code: 'MERI01', client: 'Meridian Foods', industry: 'Manufacturing',
      rounds: [{ roundId: 'r1', roundNumber: 1, label: 'Initial Diagnostic', status: 'complete' }],
      interviews: [{ role: 'CTO', interviewee: 'Priya Sharma [Synthetic]', scores: { D1: 2 } }],
    }),
    vynora_briefing_meridianfoods: JSON.stringify({
      client: 'Meridian Foods', industry: 'Manufacturing', engagementCode: 'MERI01',
      roleCatalog: [{ value: 'CTO', display: 'CTO / Technology Leadership' }],
      hypotheses: [{ index: 0, text: 'Data is siloed', status: 'open' }],
    }),
    vynora_last_briefing: JSON.stringify({ normKey: 'meridianfoods', client: 'Meridian Foods' }),
  };
}

let WORKSPACE = freshWorkspace();
let VERSIONS = {};
for (const k of Object.keys(WORKSPACE)) VERSIONS[k] = 1;
let renameCalls = [];
let statePuts = [];
let conflictCount = 0;

/* The server rename, reproduced faithfully enough to matter: the norm-keyed
 * key families are MOVED, and vynora_last_briefing's value is rewritten. This
 * is what makes the old briefing key genuinely disappear, which is the
 * condition the page mishandled. */
function serverRename(oldName, newName) {
  const o = norm(oldName), n = norm(newName);
  const next = {};
  for (const [k, v] of Object.entries(WORKSPACE)) {
    const NORM_SUFFIX = ['vynora_briefing_', 'vynora_mandatory_', 'vynora_draft_pre_engagement_'];
    const fam = NORM_SUFFIX.find((f) => k === f + o);
    if (fam) { next[fam + n] = v.split(oldName).join(newName); continue; }
    if (k === 'vynora_engagement_index') {
      const idx = JSON.parse(v); const code = idx[o]; delete idx[o]; if (code) idx[n] = code;
      next[k] = JSON.stringify(idx); continue;
    }
    if (k === 'vynora_last_briefing') {
      next[k] = JSON.stringify({ normKey: n, client: newName }); continue;
    }
    if (k.startsWith('vynora_engagement_')) { next[k] = v.replace(oldName, newName); continue; }
    /* v5.32.97: per-client keys are addressed by CODE now, so the briefing no
     * longer MOVES on a rename — but the name embedded in its value still has
     * to change. The real server does that for every key it resolves to the
     * client (renameOwnedKeys/setName); this fake was only doing it for keys
     * with the NAME in the key, which is the assumption the change removes. */
    next[k] = v.split(oldName).join(newName);
  }
  WORKSPACE = next;
  /* A rename BUMPS the version of every key it rewrites, exactly as the real
   * UPDATE does. This is what makes a browser holding pre-rename versions
   * lose the compare-and-set on its next write — the 409 behind the red save
   * pill, and the reason a stale cache must be re-read rather than flushed. */
  VERSIONS = {};
  for (const k of Object.keys(WORKSPACE)) VERSIONS[k] = 2;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url === '/api/clients/rename' && req.method === 'PATCH') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => {
      const p = JSON.parse(b || '{}');
      renameCalls.push(p);
      serverRename(p.clientName, p.newClientName);
      json({ ok: true, clientName: p.newClientName, engagementsRenamed: 1, interviewsRenamed: 6, assignmentsMoved: 0 });
    });
    return;
  }
  if (url.startsWith('/api/module-state/') && req.method === 'PUT') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => {
      let conflicts = [];
      const versions = {};
      try {
        const p = JSON.parse(b);
        statePuts.push(p);
        const expected = p.expectedVersions || {};
        for (const [k, v] of Object.entries(p.sets || {})) {
          const has = Object.prototype.hasOwnProperty.call(expected, k);
          if (has && (VERSIONS[k] || 0) !== expected[k]) {
            conflicts.push({ key: k, version: VERSIONS[k] || 0, value: WORKSPACE[k] || '' });
            continue;
          }
          WORKSPACE[k] = v;
          VERSIONS[k] = (VERSIONS[k] || 0) + 1;
          versions[k] = VERSIONS[k];
        }
        for (const k of (p.deletes || [])) { delete WORKSPACE[k]; delete VERSIONS[k]; }
      } catch {}
      if (conflicts.length) { conflictCount++; return json({ error: 'version_conflict', conflicts, versions }, 409); }
      json({ ok: true, versions });
    });
    return;
  }
  if (url.startsWith('/api/module-state/')) return json({ module: 'workspace', state: WORKSPACE, versions: VERSIONS });
  if (url === '/api/me') return json({ userId: 'u1', role: 'owner', email: 'o@firm.com' });
  if (url === '/api/my-clients') return json({ role: 'owner', clients: Object.keys(WORKSPACE).includes('vynora_briefing_meridianfoodsnew') ? ['Meridian Foods New'] : ['Meridian Foods'] });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/engagements') return json({ engagements: [] });
  if (url === '/api/voice/voices') return json({ voices: [] });
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
/* The session carries activeClient, exactly as index.html's picker sets it.
 * This is the value the whole bug turns on. */
await ctx.addInitScript(() => {
  try {
    /* SEED ONCE. addInitScript runs on every navigation, so an unconditional
     * write would reset activeClient to the pre-rename value on the reload
     * below — and the reload is the entire point of this file. That would
     * have made the product look broken after it was fixed, which is the
     * mirror image of the static tests that made it look fixed while it was
     * broken. */
    if (!sessionStorage.getItem('vyne_session')) {
      sessionStorage.setItem('vyne_session', JSON.stringify({
        token: 'tok', email: 'o@firm.com', role: 'owner', mode: 'dev',
        activeClient: 'Meridian Foods', at: Date.now(), la: Date.now() }));
    }
  } catch (e) {}
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', async (d) => {
  // window.prompt for the new name; window.confirm for anything else.
  if (d.type() === 'prompt') await d.accept('Meridian Foods New');
  else await d.accept();
});

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForTimeout(1500);

const before = await page.evaluate(() => ({
  name: (document.getElementById('client-name') || {}).value,
  active: (window.vyneAuth && vyneAuth.activeClient) ? vyneAuth.activeClient() : undefined,
}));
check('the briefing loads under the current client', before.name === 'Meridian Foods', before.name);
check('and the session names that client as active', before.active === 'Meridian Foods', String(before.active));

// ── The rename ──────────────────────────────────────────────────────────────
await page.evaluate(() => renameClientPrompt());
await page.waitForTimeout(1200);

check('the rename reached the server', renameCalls.length === 1 && renameCalls[0].newClientName === 'Meridian Foods New',
  JSON.stringify(renameCalls));

const afterRename = await page.evaluate(() => ({
  name: (document.getElementById('client-name') || {}).value,
  active: (window.vyneAuth && vyneAuth.activeClient) ? vyneAuth.activeClient() : undefined,
}));
check('the field shows the NEW name straight after the rename',
  afterRename.name === 'Meridian Foods New', afterRename.name);
/* The assertion v5.32.91 was missing. activeClient lives in sessionStorage,
 * survives reloads, and is consulted BEFORE anything the rename touched. Left
 * stale it makes every later page load look up a client the server no longer
 * has under that name. */
check('the session active client follows the rename',
  afterRename.active === 'Meridian Foods New', String(afterRename.active));

/* ── Carrying on in the SAME tab, without reloading ─────────────────────────
 *
 * The rename bumped every rewritten key's version server-side. A browser still
 * holding the pre-rename numbers loses the compare-and-set on its very next
 * write — HTTP 409 — and the save pill goes red with nothing the consultant
 * did to explain it. This is the assertion that makes vyneStore.rehydrate()
 * load-bearing; without it the earlier checks all pass on the reload path
 * alone, and the same-tab path stays broken exactly as reported.
 */
conflictCount = 0;
statePuts = [];
await page.evaluate(() => {
  vyneStore.setItem('vynora_engagement_index', vyneStore.getItem('vynora_engagement_index') || '{}');
  return vyneStore.flush();
});
await page.waitForTimeout(700);
check('writing again in the same tab is not refused on a stale version',
  conflictCount === 0 && statePuts.length >= 1,
  'conflicts: ' + conflictCount + ' puts: ' + statePuts.length);
const sameTabPill = await page.evaluate(() => {
  const el = document.getElementById('vyne-save-indicator');
  return el ? (el._label ? el._label.textContent : el.textContent) : 'MISSING';
});
check('and the save pill in that same tab is not red',
  !/Not saved/i.test(String(sameTabPill)), String(sameTabPill));

// ── "Then I went back to the briefing screen" — a real reload ───────────────
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForTimeout(1500);

const afterReload = await page.evaluate(() => ({
  name: (document.getElementById('client-name') || {}).value,
  active: (window.vyneAuth && vyneAuth.activeClient) ? vyneAuth.activeClient() : undefined,
  hyp: document.body.innerHTML.includes('Data is siloed'),
}));
check('RELOADING the briefing still shows the new name, not the old one',
  afterReload.name === 'Meridian Foods New', afterReload.name);
check('and the session still names the new client',
  afterReload.active === 'Meridian Foods New', String(afterReload.active));
check("and the client's own briefing content came back with it",
  afterReload.hyp, 'hypothesis text present: ' + afterReload.hyp);

/* The red pill. A write after the rename must land, not be refused or aimed
 * at a key family the server renamed away. */
statePuts = [];
await page.evaluate(() => {
  vyneStore.setItem('vynora_rename_probe', 'x');
  return vyneStore.flush();
});
await page.waitForTimeout(600);
const pill = await page.evaluate(() => {
  const el = document.getElementById('vyne-save-indicator');
  return el ? (el._label ? el._label.textContent : el.textContent) : 'MISSING';
});
check('a save after the rename actually goes out', statePuts.length >= 1, JSON.stringify(statePuts).slice(0, 200));
check('and the save pill does not sit on an error', !/Not saved|error/i.test(String(pill)), String(pill));
/* The reported "not saved, red dot". A browser still holding pre-rename
 * version numbers loses the compare-and-set on its very next write. */
check('no write was refused on a stale version', conflictCount === 0, 'conflicts: ' + conflictCount);

/* No stranded key under the old identity — that is what left the tracker
 * showing the old name after a rename BACK. */
const stranded = Object.keys(WORKSPACE).filter((k) => k.includes('meridianfoods') && !k.includes('meridianfoodsnew'));
check('no workspace key is left behind under the old norm', stranded.length === 0, stranded.join(' | '));

/* ── Renaming BACK ──────────────────────────────────────────────────────────
 *
 * "Then I tried to change the name back and the tracker rows did not change
 * back." A second rename has to be as ordinary as the first; it was not,
 * because the first left the session and the cache pointing at an identity the
 * server had moved, and the second was then computed from that wrong base.
 */
await page.evaluate(() => { window.__nextName = 'Meridian Foods'; });
page.removeAllListeners('dialog');
page.on('dialog', async (d) => {
  if (d.type() === 'prompt') await d.accept('Meridian Foods');
  else await d.accept();
});
conflictCount = 0;
await page.evaluate(() => renameClientPrompt());
await page.waitForTimeout(1200);

check('a second rename reaches the server with the right OLD name',
  renameCalls.length === 2 && renameCalls[1].clientName === 'Meridian Foods New'
    && renameCalls[1].newClientName === 'Meridian Foods',
  JSON.stringify(renameCalls));

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForTimeout(1500);
const back = await page.evaluate(() => ({
  name: (document.getElementById('client-name') || {}).value,
  active: (window.vyneAuth && vyneAuth.activeClient) ? vyneAuth.activeClient() : undefined,
  hyp: document.body.innerHTML.includes('Data is siloed'),
}));
check('renaming BACK lands, and survives a reload', back.name === 'Meridian Foods', back.name);
check('the session follows the second rename too', back.active === 'Meridian Foods', String(back.active));
check('and the briefing content is still there after two renames', back.hyp, String(back.hyp));
const strandedNew = Object.keys(WORKSPACE).filter((k) => k.includes('meridianfoodsnew'));
check('nothing is left behind under the intermediate name', strandedNew.length === 0, strandedNew.join(' | '));
check('the second rename was not refused on a stale version', conflictCount === 0, 'conflicts: ' + conflictCount);

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
