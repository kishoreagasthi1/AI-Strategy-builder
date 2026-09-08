/**
 * THE TRAINING SCREENSHOT HARNESS.
 *
 *   node frontend/test/training/shoot.mjs            # everything
 *   node frontend/test/training/shoot.mjs roadmap    # one page's shots
 *
 * It serves the REAL frontend files against a stub backend seeded from
 * fixture.mjs, drives a real Chromium to each screen and state, and writes a PNG
 * per state into docs/training/shots/.
 *
 * ── Why a stub backend and not the real one ────────────────────────────────
 *
 * Because the screenshots go into a document that leaves the building, and the
 * production database has real client names in it. The stub is the only way to
 * get a fully-worked engagement on screen that is safe to publish. The cost is
 * stated plainly in the manifest: these are invented clients.
 *
 * ── What a "shot" is ───────────────────────────────────────────────────────
 *
 * { id, page, title, note, prep?, target?, full? }
 *
 *   prep    JS evaluated in the page after load, to reach the state
 *   target  CSS selector to shoot instead of the viewport
 *   full    full-page capture rather than the 1440x900 viewport
 *
 * A shot whose prep throws is RECORDED AS FAILED and the run continues, because
 * a harness that dies on shot 3 of 60 tells you nothing about shots 4–60.
 */
import http from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { workspace, INTERVIEWS_API, A, B, FIRM } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..', '..');
const OUT = join(FRONTEND, '..', 'docs', 'training', 'shots');
const PORT = Number(process.env.SHOT_PORT || 8899);

/* ── The stub backend ─────────────────────────────────────────────────────── */

let STATE = workspace();

/**
 * A single LLM stub for every generate button in the product.
 *
 * The pages ask for many different JSON shapes and each parses its own. Rather
 * than guess at all of them, the stub returns a UNION object: every key any
 * caller might read, so whichever one this particular button wanted is present.
 * Anything it does not recognise renders as an empty section, which is a
 * truthful screenshot of "the model returned nothing for this" rather than a
 * crash.
 */
const LLM_UNION = {
  summary: 'Movement data is reconciled by hand at month end, and every downstream number inherits that delay.',
  text: 'Movement data is reconciled by hand at month end.',
  gaps: [
    { text: 'Movement data reconciliation', detail: 'A single automated reconciliation of depot, TMS and finance movement records.', weight: 0.9 },
    { text: 'Shift handover capture', detail: 'Structured capture of handover at the point of shift change rather than the next morning.', weight: 0.7 },
    { text: 'AI approval gate', detail: 'A named owner and a one-page approval route for model deployment.', weight: 0.5 },
  ],
  hypotheses: [
    { text: 'Trailer utilisation data already exists and is simply not used.' },
    { text: 'Cost-to-serve cannot be trusted because its inputs are reconciled late.' },
  ],
  questions: [
    'Where does movement data originate, and how many times is it re-keyed?',
    'Who signs off a technology business case under £2m today?',
  ],
  recommendations: [
    { title: 'Automate movement reconciliation', rationale: 'Unblocks every downstream analytic.', horizon: 'Now' },
    { title: 'Name an AI approver', rationale: 'Nothing clears governance until somebody can say yes.', horizon: 'Now' },
    { title: 'Structured shift handover', rationale: 'Removes the overnight lag and the transcription errors.', horizon: 'Next' },
  ],
  useCases: [
    { name: 'Automated shift handover', value: 'Removes a 12-hour reporting lag and the re-keying errors with it.', dept: 'Operations' },
    { name: 'Trailer load-fill optimisation', value: 'Two to four points of utilisation on the same fleet.', dept: 'Operations' },
    { name: 'Daily cost-to-serve', value: 'Pricing decisions on current numbers rather than last quarter’s.', dept: 'Finance' },
  ],
};

function serve(req, res) {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  const body = (cb) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => cb(b)); };

  if (url.startsWith('/api/llm')) {
    return body(() => json({
      text: JSON.stringify(LLM_UNION), finishReason: 'stop',
      provider: 'stub', model: 'stub',
      usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0 },
    }));
  }
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
  if (url === '/api/version') return json({ version: pageVersion(), env: 'demo' });
  if (url === '/api/config') return json({ devAuth: true, firebase: null, requireMfa: false, requireVerifiedEmail: false });
  if (url === '/api/me') return json({ userId: 'u1', role: FIRM.role, email: FIRM.email, firm: 'Meridian Advisory' });
  if (url === '/api/clients') return json({ clients: [A.name, B.name] });
  if (url === '/api/assignments') return json({ assignments: [] });
  if (url === '/api/interviews') {
    if (req.method === 'POST') return body(() => json({ id: 'iv-new', loginHint: 'NWF01-4821' }, 201));
    return json({ interviews: INTERVIEWS_API });
  }
  if (url.startsWith('/api/interviews/')) {
    if (req.method === 'PATCH') return body(() => json({ ok: true }));
    return json({ interview: INTERVIEWS_API[0], transcript: [] });
  }
  if (url === '/api/firms/team') {
    return json({ members: [
      { userId: 'u1', email: FIRM.email, role: 'owner', name: 'You' },
      { userId: 'u2', email: 'analyst@meridianadvisory.com', role: 'consultant', name: 'Priya Raman' },
    ] });
  }
  if (url === '/api/scorecard') return json({ engagements: [], dimensionNames: {} });
  if (url === '/api/voice/voices') return json({ voices: [{ id: 'Orus', label: 'Orus' }, { id: 'Aoede', label: 'Aoede' }] });
  if (url === '/api/billing/summary') return json({ months: [], clients: [] });
  if (url === '/api/subscription') return json({ plan: 'pro', status: 'active', seats: 5 });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  try {
    const file = readFileSync(join(FRONTEND, url === '/' ? 'index.html' : url), 'utf8');
    res.writeHead(200, {
      'content-type': url.endsWith('.js') ? 'application/javascript'
        : url.endsWith('.css') ? 'text/css' : 'text/html',
    });
    res.end(file);
  } catch { res.writeHead(404); res.end(); }
}

function pageVersion() {
  const src = readFileSync(join(FRONTEND, 'vyne-client.js'), 'utf8');
  return (src.match(/var VYNE_VERSION = "([^"]+)"/) || [])[1] || 'dev';
}

/* ── The runner ───────────────────────────────────────────────────────────── */

export async function run(shots, filter) {
  mkdirSync(OUT, { recursive: true });
  const server = http.createServer(serve);
  await new Promise((r) => server.listen(PORT, r));

  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  /**
   * A fresh CONTEXT per shot, not just a fresh page, because the thing that
   * distinguishes several of these screens is the session itself — signed out,
   * signed in as a consultant with a client chosen, signed in as an
   * interviewee. That lives in sessionStorage and is seeded by an init script,
   * which is a context-level thing.
   */
  async function contextFor(shot) {
    const c = await browser.newContext({
      viewport: shot.viewport || { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    if (shot.session !== false) {
      const s = {
        token: 'tok', email: FIRM.email, role: FIRM.role, mode: 'dev',
        activeClient: A.name, ...(shot.session || {}),
      };
      await c.addInitScript(`
        try { var s = ${JSON.stringify(s)}; s.at = Date.now(); s.la = Date.now();
          sessionStorage.setItem('vyne_session', JSON.stringify(s)); } catch (e) {}
      `);
    }
    return c;
  }

  const taken = [];
  const wanted = shots.filter((s) => !filter || s.id.includes(filter) || s.page.includes(filter));

  for (const shot of wanted) {
    STATE = workspace();                       // every shot starts from the same world
    const ctx = await contextFor(shot);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    const rec = { ...shot, ok: false, errors, note: shot.note || '' };
    try {
      await page.goto(`http://127.0.0.1:${PORT}/${shot.page}`, { waitUntil: 'load' });
      await page.waitForTimeout(shot.settle || 1500);
      if (shot.prep) {
        const r = await page.evaluate(shot.prep);
        if (r && r.error) rec.prepError = String(r.error);
        await page.waitForTimeout(shot.after || 900);
      }
      const file = join(OUT, shot.id + '.png');
      if (shot.target) {
        const el = await page.$(shot.target);
        if (!el) throw new Error(`target not found: ${shot.target}`);
        await el.screenshot({ path: file });
      } else {
        await page.screenshot({ path: file, fullPage: !!shot.full });
      }
      rec.ok = true;
      rec.file = 'shots/' + shot.id + '.png';
    } catch (e) {
      rec.failure = String(e).slice(0, 300);
    }
    taken.push(rec);
    const flag = rec.ok ? (rec.prepError ? 'WARN' : ' OK ') : 'FAIL';
    console.log(`  [${flag}] ${shot.id.padEnd(38)} ${rec.failure || rec.prepError || ''}`);
    await page.close();
    await ctx.close();
  }

  await browser.close();
  server.close();

  /* MERGE into the manifest, do not replace it.
   *
   * v5.33.8: this used to write `taken` straight out, which is the FILTERED
   * set. So `shoot.mjs 03-05` — re-shooting one screen after a UI change, the
   * single most common way this is run — silently reduced a 120-entry manifest
   * to one entry, and the scripts' screenshot references stopped resolving
   * against it. Found by running exactly that. */
  const MANIFEST = join(OUT, '..', 'manifest.json');
  let prior = [];
  try { prior = JSON.parse(readFileSync(MANIFEST, 'utf8')); } catch { /* first run */ }
  if (!Array.isArray(prior)) prior = [];
  const byId = new Map(prior.map((r) => [r.id, r]));
  for (const { prep, ...r } of taken) byId.set(r.id, r);
  writeFileSync(MANIFEST, JSON.stringify(
    [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), null, 2));

  const bad = taken.filter((t) => !t.ok).length;
  const warn = taken.filter((t) => t.ok && t.prepError).length;
  console.log(`\n  ${taken.length - bad} captured, ${bad} failed, ${warn} with prep warnings`);
  console.log(`  → ${OUT}`);
  return taken;
}

export { OUT, PORT };
