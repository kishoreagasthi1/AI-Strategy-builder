/**
 * END-TO-END TEST for industry-catalog persistence in the roadmap builder
 * (roadmap.html), v5.32.70.
 *
 *   node frontend/test/industry-catalog-e2e.mjs
 *
 * THE BUG THIS EXISTS FOR.
 *
 * Reported as "there is no autosave in the AI roadmap builder — I had to
 * regenerate the use cases for Food & Beverages each time I went in with
 * Meridian Foods". The store was innocent. vyneStore saved the catalog, the PUT
 * landed, the row was in Postgres. Nothing was ever looking for it under the
 * name the client actually has.
 *
 * resolveIndustryParts() split the engagement's industry string on `&`, `and`,
 * `/` and `+` as well as commas. "Food & Beverages" therefore arrived as TWO
 * industries. The consultant was offered a catalog for "Food", generated it,
 * came back, and was met with "No use-case catalog for 'Beverages' yet" —
 * indistinguishable, from the outside, from the first catalog having failed to
 * save. It had saved, at vynora_industry_catalog_food, where a client whose
 * industry reads "Food & Beverages" would never look.
 *
 * The content was wrong too: two disconnected half-catalogs — a food value
 * chain and a beverage value chain — where the client needed one catalog for
 * the segment it is actually in.
 *
 * WHAT THIS TEST HOLDS DOWN. Four things, and the last two are the ones a
 * refactor would quietly drop:
 *
 *   · an industry name containing "&" is ONE industry
 *   · generating a catalog once is enough — forever, across reloads
 *   · a comma-separated multi-industry client still combines (the feature the
 *     old split existed for, which the narrowing must not break)
 *   · catalogs stranded under the OLD split are still found, so a firm that
 *     already hit the bug is not asked to pay for the same content a third time
 *
 * Every assertion drives the page's real applyEngagementByCode against a real
 * server that persists what it is sent, over a real page reload. A test that
 * called resolveIndustryParts() and checked the array would pass with the
 * catalog never reaching the browser.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8812;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

/** A generated catalog as it sits in the store, for a given label. */
const storedCatalog = (label, deptName, ucNames) => JSON.stringify({
  label,
  depts: [{ name: deptName, icon: '🏭', uc: ucNames.map((n, i) => ({
    id: 'gx' + label.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) + '_u' + i,
    name: n, desc: n + ' detail', impact: 'high', complexity: 'medium',
    value: '', phase: 'p1', subUcs: [],
  })) }],
  generatedAt: '2026-08-01T00:00:00.000Z',
});

const engagement = (code, client, industry) => JSON.stringify({
  code, client, industry, currentRoundId: 'r1',
  rounds: [{ roundId: 'r1', roundNumber: 1, label: 'Initial Diagnostic',
    status: 'complete', date: '2026-08-01', scores: { D1: 2.6 }, interviews: [] }],
});

/* Three clients, one per resolution path.
 *   MFD01 — "Food & Beverages", nothing stored     → the reported bug
 *   LEG01 — "Oil & Gas", stored under the OLD split → legacy reuse
 *   MIX01 — "Healthcare Payor, Pharmacies"          → genuine multi-industry */
const BASE_STATE = () => ({
  vynora_engagement_index: JSON.stringify({
    meridianfoods: 'MFD01', northreachenergy: 'LEG01', calderahealth: 'MIX01',
  }),
  vynora_engagement_MFD01: engagement('MFD01', 'Meridian Foods', 'Food & Beverages'),
  vynora_engagement_LEG01: engagement('LEG01', 'Northreach Energy', 'Oil & Gas'),
  vynora_engagement_MIX01: engagement('MIX01', 'Caldera Health', 'Healthcare Payor, Pharmacies'),
  // Stranded by the pre-v5.32.70 ampersand split — two halves, no whole.
  vynora_industry_catalog_oil: storedCatalog('Oil', 'Upstream', ['Reservoir modelling']),
  vynora_industry_catalog_gas: storedCatalog('Gas', 'Midstream', ['Pipeline integrity']),
  // A genuine two-industry client, each part generated separately and correctly.
  vynora_industry_catalog_healthcarepayor: storedCatalog('Healthcare Payor', 'Claims', ['Claims triage']),
  vynora_industry_catalog_pharmacies: storedCatalog('Pharmacies', 'Dispensing', ['Adherence outreach']),
});

let STATE = BASE_STATE();

/* The two-pass generator's stub. Pass 1 is names only; pass 2 expands one
 * function. Detected on the prompt's own "PASS 1 of 2" marker rather than on
 * loose keywords — the skeleton prompt contains the word "expands" in prose,
 * which is enough to misroute a keyword match and make the whole flow fail
 * silently in a way that looks like the feature is broken. */
let genLabels = [];
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url.startsWith('/api/llm')) {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => {
      let prompt = '';
      try { prompt = JSON.parse(b).messages[0].content; } catch { /* leave blank */ }
      const label = (prompt.match(/industry: "([^"]*)"/) || [])[1] || '';
      const skeleton = /PASS 1 of 2/.test(prompt);
      if (skeleton) genLabels.push(label);
      const payload = skeleton
        ? { label, depts: [{ name: 'Production', icon: '🏭', scope: 'plant operations',
              ucNames: ['Yield optimisation', 'Line changeover planning'] }] }
        : { uc: ['Yield optimisation', 'Line changeover planning'].map((n) => ({
              name: n, desc: n + ' detail', impact: 'high', complexity: 'medium',
              value: '', phase: 'p1', subUcs: [] })) };
      json({ text: JSON.stringify(payload), finishReason: 'stop',
             provider: 'stub', model: 'stub', usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0 } });
    });
    return;
  }
  if (url === '/api/me') return json({ userId: 'u1', role: 'consultant', email: 'c@firm.com' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url.startsWith('/api/module-state/')) {
    // A REAL store: PUTs mutate it and the next GET returns what was written.
    // A stub that acknowledged writes without keeping them would let the very
    // bug under test pass.
    if (req.method === 'PUT') {
      let b = ''; req.on('data', (c) => b += c);
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(b); } catch { /* ignore */ }
        for (const [k, v] of Object.entries(body.sets || {})) STATE[k] = v;
        for (const k of body.deletes || []) delete STATE[k];
        json({ ok: true, versions: {} });
      });
      return;
    }
    return json({ module: 'workspace', state: STATE, versions: {} });
  }
  if (url === '/api/clients') return json({ clients: ['Meridian Foods', 'Northreach Energy', 'Caldera Health'] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  try {
    const body = readFileSync(join(DIR, url === '/' ? 'roadmap.html' : url), 'utf8');
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

const pageErrors = [];
/** A FRESH page load — the only honest way to test persistence. */
async function open() {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForTimeout(1800);
  return page;
}

/** What a consultant would actually see after opening an engagement. */
const SNAPSHOT = `(code) => {
  applyEngagementByCode(code);
  const host = document.getElementById('custom-cat-panel');
  const ind = INDUSTRIES[currentIndustry] || {};
  const depts = ind.depts || [];
  return {
    key: currentIndustry,
    label: ind.label || '',
    deptNames: depts.map(function(d){ return d.name; }),
    ucNames: depts.reduce(function(a,d){ return a.concat((d.uc||[]).map(function(u){ return u.name; })); }, []),
    offering: host ? (host.textContent.match(/No use-case catalog for \\u201C([^\\u201D]*)\\u201D/) || [])[1] || null : null,
    panelPresent: !!host,
  };
}`;
const snap = (page, code) => page.evaluate(`(${SNAPSHOT})(${JSON.stringify(code)})`);

// ── 1. An ampersand does not make two industries ────────────────────────────
{
  const page = await open();
  const split = await page.evaluate(`JSON.stringify({
    amp: resolveIndustryParts('Food & Beverages'),
    and: resolveIndustryParts('Aerospace and Defence'),
    slash: resolveIndustryParts('Technology / SaaS'),
    comma: resolveIndustryParts('Healthcare Payor, Pharmacies'),
    semi: resolveIndustryParts('Mining; Metals'),
  })`);
  const s = JSON.parse(split);
  check('"Food & Beverages" is ONE industry, not two',
    s.amp.length === 1 && s.amp[0] === 'Food & Beverages', JSON.stringify(s.amp));
  check('"and" and "/" inside a name do not split it either',
    s.and.length === 1 && s.slash.length === 1,
    JSON.stringify(s.and) + ' / ' + JSON.stringify(s.slash));
  check('a comma or semicolon still separates genuinely different businesses',
    s.comma.length === 2 && s.comma[0] === 'Healthcare Payor'
    && s.semi.length === 2, JSON.stringify(s.comma) + ' / ' + JSON.stringify(s.semi));
  await page.close();
}

// ── 2. THE REPORTED BUG: generate once, and once is enough ──────────────────
{
  genLabels = [];
  const page = await open();
  const before = await snap(page, 'MFD01');
  check('a client with no catalog is offered one for its WHOLE industry name',
    before.offering === 'Food & Beverages', JSON.stringify(before));

  await page.evaluate(`generateIndustryCatalog('Food & Beverages')`);
  await page.waitForTimeout(4000);
  await page.evaluate(`vyneStore.flush()`);
  await page.waitForTimeout(1200);

  check('exactly ONE catalog is generated, for the segment the client is in',
    genLabels.length === 1 && genLabels[0] === 'Food & Beverages', JSON.stringify(genLabels));
  check('and it is stored under the industry as written',
    typeof STATE['vynora_industry_catalog_foodbeverages'] === 'string'
    && !STATE['vynora_industry_catalog_food'],
    Object.keys(STATE).filter((k) => k.includes('catalog')).join(', '));
  await page.close();

  // The reload is the test. Everything above could hold with the catalog
  // discarded on the way back in.
  const back = await open();
  const after = await snap(back, 'MFD01');
  check('RELOAD: the catalog is still there — no second generation is asked for',
    after.offering === null && after.panelPresent === false, JSON.stringify(after));
  check('RELOAD: and it is the real catalog, not an empty shell',
    after.label === 'Food & Beverages'
    && after.ucNames.indexOf('Yield optimisation') > -1,
    JSON.stringify(after));
  check('no further LLM calls were made just to open the engagement',
    genLabels.length === 1, JSON.stringify(genLabels));
  await back.close();
}

// ── 3. Catalogs stranded by the OLD split are still found ───────────────────
{
  genLabels = [];
  const page = await open();
  const legacy = await snap(page, 'LEG01');
  check('a firm that already hit the bug keeps the halves it paid for',
    legacy.offering === null
    && legacy.ucNames.indexOf('Reservoir modelling') > -1
    && legacy.ucNames.indexOf('Pipeline integrity') > -1,
    JSON.stringify(legacy));
  check('and they are presented under the client’s real industry name',
    legacy.label === 'Oil & Gas', legacy.label);
  check('reusing them costs nothing — no regeneration is triggered',
    genLabels.length === 0, JSON.stringify(genLabels));
  await page.close();
}

// ── 4. A genuine multi-industry client still combines ───────────────────────
{
  const page = await open();
  const mix = await snap(page, 'MIX01');
  check('a comma-separated client still combines both catalogs',
    mix.ucNames.indexOf('Claims triage') > -1
    && mix.ucNames.indexOf('Adherence outreach') > -1, JSON.stringify(mix));
  check('and asks for nothing, because nothing is missing',
    mix.offering === null && mix.panelPresent === false, JSON.stringify(mix));
  await page.close();
}

// ── 5. A PARTIAL legacy set must not masquerade as a whole catalog ──────────
{
  // Half the old split present. Combining it would hand the consultant a
  // catalog covering only the upstream half of the client's business, with
  // nothing on screen to say so. Better to offer one complete catalog.
  STATE = BASE_STATE();
  delete STATE['vynora_industry_catalog_gas'];
  genLabels = [];
  const page = await open();
  const partial = await snap(page, 'LEG01');
  check('a HALF-present legacy set is refused, and a whole catalog offered instead',
    partial.offering === 'Oil & Gas'
    && partial.ucNames.indexOf('Pipeline integrity') === -1,
    JSON.stringify(partial));
  await page.close();
  STATE = BASE_STATE();
}

// ── 6. A catalog registers under the key it was stored by ───────────────────
{
  // loadCustomCatalogFor used to register under cat.label, so a catalog saved
  // at ..._oil whose model-written label read "Oil & Gas" registered as
  // cx_oilgas. Two code paths naming one catalog differently is how a lookup
  // misses a catalog that is sitting right there.
  STATE = BASE_STATE();
  STATE['vynora_industry_catalog_oil'] = storedCatalog('Oil & Gas', 'Upstream', ['Reservoir modelling']);
  const page = await open();
  const keyed = await page.evaluate(`(() => {
    const key = loadCustomCatalogFor('Oil');
    return { key: key, label: (INDUSTRIES[key] || {}).label };
  })()`);
  check('the registration key comes from the STORAGE label, not the model’s',
    keyed.key === 'cx_oil', JSON.stringify(keyed));
  check('while the consultant still sees the catalog’s own name',
    keyed.label === 'Oil & Gas', JSON.stringify(keyed));
  await page.close();
  STATE = BASE_STATE();
}

check('roadmap.html threw nothing throughout', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
server.close();

console.log('\n=== INDUSTRY CATALOG PERSISTENCE END-TO-END ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n        ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
