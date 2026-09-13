/**
 * v5.34.37 — the deploy shell's environment must not reach the test suite.
 *
 * ── The bug this file exists to prevent ────────────────────────────────────
 *
 * `deploy/deploy.sh` forwards whatever `GEMINI_*` / `VYNE_*` variables are
 * exported in the operator's shell to Cloud Run — that is deliberate, it is
 * how a deploy is made reproducible. But the same script runs the test suite
 * as its release gate, in that same shell, and a dozen tests describe what the
 * code does with NO operator configuration set. So exporting a variable in
 * order to deploy it changed what the tests asserted, and the gate failed on
 * the very configuration the operator was trying to ship.
 *
 * It has now happened twice, both times costing a deploy:
 *   5.34.32  GEMINI_LIVE_VAD_* broke four liveSession assertions
 *   5.34.36  GEMINI_TTS_MODEL broke the tts default assertion
 *
 * I fixed the first one inside the one test file that failed, which fixed that
 * instance and left the class open. This fixes the class: every test file
 * starts from a clean provider configuration, whatever the shell holds.
 *
 * ── Why these prefixes, and not simply everything ──────────────────────────
 *
 * `GEMINI_*` and `VYNE_*` are the product's own provider/runtime knobs; a test
 * that wants one sets it itself and restores it (see liveModelDefault and
 * liveSession, which do exactly that, and still work — this only clears what
 * the shell brought in, before any test runs).
 *
 * Everything that selects WHICH tests run is deliberately left alone:
 * RLS_TEST, TEST_DATABASE_URL, RLS_APP_URL, DATABASE_URL, DEV_AUTH, NODE_ENV,
 * SIGNUP_ACCESS_KEY, SOAK_DEBUG. Clearing those would silently skip the
 * RLS-gated suites — trading a loud failure for a quiet one, which is the
 * wrong direction.
 */
const CLEAR_PREFIXES = ["GEMINI_", "VYNE_"];
const KEEP = new Set([
  "VYNE_MODULE",          // set by page-level fixtures, not by a deploy shell
]);

const cleared: string[] = [];
for (const key of Object.keys(process.env)) {
  if (KEEP.has(key)) continue;
  if (CLEAR_PREFIXES.some((p) => key.startsWith(p))) {
    delete process.env[key];
    cleared.push(key);
  }
}

if (cleared.length && !process.env.VITEST_QUIET_ENV) {
  // Loud enough to explain a surprise, quiet enough not to be noise: the
  // operator needs to know their exports were ignored HERE and still apply to
  // the deploy itself.
  console.log(
    `[test env] ignoring ${cleared.length} provider variable(s) from the shell so the suite ` +
    `describes the code's own defaults: ${cleared.join(", ")}. ` +
    `They are still forwarded to Cloud Run by deploy.sh — only the gate is insulated.`
  );
}
