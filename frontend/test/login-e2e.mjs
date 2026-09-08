/**
 * END-TO-END TEST for interviewee sign-in (index.html).
 *
 *   node frontend/test/login-e2e.mjs
 *
 * WHY THIS EXISTS. An interviewee following an invite link could not sign in.
 * They set a password on Google's reset page, came back, typed the password
 * they had just chosen, and were told it was wrong.
 *
 * The cause was ordering, not credentials. Sign-in ran
 *
 *   firebaseAuth.tenantId = document.getElementById("firm").value.trim() || null;
 *
 * and the only thing that ever filled that field from an email address was a
 * BLUR handler. Browser autofill — precisely what happens when someone returns
 * from a password reset and their browser fills in the address it just saved —
 * does not reliably fire blur. So tenantId was null, the sign-in went to the
 * project's DEFAULT tenant, and the password had been set on the firm's
 * Identity Platform tenant. Firebase reports that as auth/invalid-credential,
 * which reads as "wrong password" and sends people to reset it again.
 *
 * Firebase is stubbed here. The assertion is not "does Google authenticate" —
 * it is "which tenant did we ask Google about", which is the thing that was
 * wrong and the thing no test looked at.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8802;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const FIRM = { name: 'Vynora Consulting', slug: null, idpTenantId: 'tenant-abc-123' };
let byEmailCalls = 0;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url === '/api/config') {
    // IdP mode, not dev mode — this bug only exists on the real auth path.
    return json({ devAuth: false, firebase: { apiKey: 'fake', authDomain: 'fake.firebaseapp.com' },
                  requireMfa: false, requireVerifiedEmail: false });
  }
  if (url === '/api/firm/by-email') {
    byEmailCalls++;
    const email = new URLSearchParams(req.url.split('?')[1] || '').get('email') || '';
    // Only the invited interviewee resolves; anyone else is a genuine miss.
    return json({ firms: email.toLowerCase() === 'exec@client.com' ? [FIRM] : [] });
  }
  if (url === '/api/firm') return json(FIRM);
  if (url === '/api/me') return json({ userId: 'u1', role: 'interviewee', email: 'exec@client.com' });
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  try {
    const body = readFileSync(join(DIR, url === '/' ? 'index.html' : url), 'utf8');
    res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'application/javascript' : 'text/html' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--no-sandbox'] });

/**
 * Replace the Firebase module loader with a stub that records the tenant the
 * app asked about, and accepts the password only for the right tenant —
 * exactly as Identity Platform does.
 */
/**
 * Stub modules served in place of the real Firebase SDK.
 *
 * Intercepted at the network layer rather than injected into the page: the
 * page's `firebaseAuth` is a script-scoped `let`, not a window property, so it
 * cannot be assigned from page.evaluate — and stubbing it that way would also
 * mean the page's OWN wiring never ran, which is the part under test.
 */
const FIREBASE_APP_STUB = `export function initializeApp(cfg) { return { cfg: cfg }; }`;
const FIREBASE_AUTH_STUB = `
  export function getAuth(app) { return { app: app, tenantId: null }; }
  export function getMultiFactorResolver() { return null; }
  export const TotpMultiFactorGenerator = { FACTOR_ID: 'totp' };
  export async function signInWithEmailAndPassword(auth, email, password) {
    (window.__signInAttempts = window.__signInAttempts || []).push({ tenantId: auth.tenantId, email: email });
    if (auth.tenantId !== 'tenant-abc-123') {
      const e = new Error('invalid credential');
      e.code = 'auth/invalid-credential';
      throw e;
    }
    return { user: { email: email, getIdToken: async () => 'tok' } };
  }
  export async function signOut() {}
  export function onAuthStateChanged() {}
  export function setPersistence() {}
  export function sendPasswordResetEmail() {}
`;

async function newPage(url) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Initialised up front so "no attempt was made" is an empty array rather
  // than undefined — the case where nothing happens is a real outcome here.
  await page.addInitScript('window.__signInAttempts = [];');
  await page.route('**/firebasejs/**/firebase-app.js', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: FIREBASE_APP_STUB }));
  await page.route('**/firebasejs/**/firebase-auth.js', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: FIREBASE_AUTH_STUB }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForTimeout(900);
  return { page, errors, ctx };
}

// ── 1. The autofill case: email set WITHOUT a blur, straight to submit ───────
{
  const { page, errors } = await newPage(`http://127.0.0.1:${PORT}/`);
  await page.evaluate(`(() => {
    // Exactly what autofill does: assign the value, fire nothing.
    document.getElementById('email').value = 'exec@client.com';
    document.getElementById('password').value = 'the-password-they-just-set';
    signIn();
  })()`);
  await page.waitForTimeout(900);
  const attempts = await page.evaluate(`window.__signInAttempts`);
  const msg = await page.evaluate(`(document.getElementById('msg') || {}).textContent || ''`);

  check('an autofilled email still resolves the firm before signing in',
    attempts.length === 1 && attempts[0].tenantId === 'tenant-abc-123',
    JSON.stringify(attempts));
  check('the sign-in was NOT attempted against the default tenant',
    !attempts.some((a) => a.tenantId === null), JSON.stringify(attempts));
  check('no credential error was shown for a correct password', !/password|credential/i.test(msg), msg);
  check('index.html threw nothing', errors.length === 0, errors.join(' | '));
}

// ── 2. The link case: ?firm= pre-selects, no lookup needed ───────────────────
{
  const before = byEmailCalls;
  const { page } = await newPage(`http://127.0.0.1:${PORT}/?firm=tenant-abc-123`);
  await page.evaluate(`(() => {
    document.getElementById('email').value = 'exec@client.com';
    document.getElementById('password').value = 'pw';
    signIn();
  })()`);
  await page.waitForTimeout(700);
  const attempts = await page.evaluate(`window.__signInAttempts`);
  check('an invite link with ?firm= signs in against that firm',
    attempts.length === 1 && attempts[0].tenantId === 'tenant-abc-123', JSON.stringify(attempts));
  check('and it does not need the email lookup at all', byEmailCalls === before, `${byEmailCalls - before} calls`);
}

// ── 3. A genuine miss must say something true ────────────────────────────────
{
  const { page } = await newPage(`http://127.0.0.1:${PORT}/`);
  await page.evaluate(`(() => {
    document.getElementById('email').value = 'nobody@nowhere.com';
    document.getElementById('password').value = 'pw';
    signIn();
  })()`);
  await page.waitForTimeout(900);
  const attempts = await page.evaluate(`window.__signInAttempts`);
  const msg = await page.evaluate(`(document.getElementById('msg') || {}).textContent || ''`);

  // The old code attempted the sign-in anyway and surfaced Firebase's
  // "invalid credential", which blames the password for a firm problem.
  check('an unresolvable firm does not produce a doomed sign-in attempt',
    attempts.length === 0, JSON.stringify(attempts));
  check('and the message names the real problem — the firm, not the password',
    /firm/i.test(msg) && !/password is|incorrect password/i.test(msg), msg);
}

await browser.close();
server.close();

console.log('\n=== INTERVIEWEE SIGN-IN END-TO-END ===\n');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n        ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
