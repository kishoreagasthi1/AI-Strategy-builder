/**
 * Production entrypoint — wires real implementations into buildServer().
 * DEV_AUTH=1 (non-production only) swaps in the dev verifier and serves the
 * frontend directory same-origin so the whole stack runs locally sans GCP.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { initPool, getPool, assertRlsEnforceable, assertSchemaCurrent } from "./db/pool.js";
import { buildServer } from "./server.js";
import { IdentityPlatformVerifier } from "./auth/verify.js";
import { DevVerifier } from "./auth/devVerifier.js";
import { dbMeter, dbLimitCheck } from "./llm/metering.js";
import type { LimitCheck } from "./llm/gateway.js";
import { makeSubscriptionLimitCheck, withSubscriptionGate } from "./billing/subscriptions.js";
import { makeGeminiAiStudioAdapter } from "./llm/adapters/geminiAiStudio.js";
import { makeGeminiVertexAdapter } from "./llm/adapters/geminiVertex.js";
import { makeAnthropicVertexAdapter } from "./llm/adapters/anthropicVertex.js";
import { makeAnthropicApiAdapter } from "./llm/adapters/anthropicApi.js";
import { makeOpenAiAdapter } from "./llm/adapters/openai.js";
import { initSentry, initErrorReporting, captureError } from "./monitoring/errors.js";
import { makeStripeClient } from "./billing/stripeClient.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  const config = loadConfig();

  /*
   * Two error sinks, both initialised here and nowhere else: tests build
   * servers via buildServer() directly and never call main(), so a test run
   * never touches either.
   *
   * Cloud Error Reporting (v5.32.70) needs no configuration and is therefore
   * on in production unconditionally. That is the point of it — the v5.32.69
   * preflight found SENTRY_DSN unset, which made captureError() a silent
   * no-op and meant the metering-failure alerting reported to nobody. A
   * reporting path that depends on someone having remembered to set an env
   * var is a reporting path that is off when it matters.
   */
  const errorReportingOn = initErrorReporting({
    service: process.env.K_SERVICE ?? "vyne-api",
    version: VERSION,
    enabled: config.env === "production",
  });

  // Sentry stays optional and additive — richer grouping when a DSN is set.
  const sentryOn = initSentry({ dsn: config.sentryDsn, environment: config.env, release: VERSION });

  // A crash here (an unhandled rejection or a synchronous throw outside any
  // Fastify request — e.g. during startup, or in a fire-and-forget promise
  // some route kicked off) bypasses server.ts's request-scoped error
  // handler entirely. Without this, such crashes were invisible to
  // monitoring even with Sentry configured.
  process.on("unhandledRejection", (reason) => {
    captureError(reason, { source: "unhandledRejection" });
    console.error("Unhandled rejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    captureError(err, { source: "uncaughtException" });
    console.error("Uncaught exception:", err);
  });

  initPool(config.databaseUrl);
  // V225-audit H2 fix: fail loudly at boot if the connection RLS relies on
  // can't actually enforce it (superuser / BYPASSRLS role) — see
  // assertRlsEnforceable()'s doc comment. Hard-fails in production; warns
  // only in dev/test, where the owner-role default is a known, accepted
  // trade-off covered separately by the RLS-specific test suite.
  await assertRlsEnforceable(getPool(), { strict: config.env === "production" });
  /* v5.33.5 — the schema the code expects must actually be there. See
   * assertSchemaCurrent's comment: v5.33.3 shipped code depending on migration
   * 026 while 026 had not been run, and the only symptom was one feature
   * returning "internal_error" to whoever happened to use it first. In
   * production this throws, so Cloud Run keeps serving the PREVIOUS working
   * revision instead of promoting a broken one. */
  await assertSchemaCurrent(getPool(), { strict: config.env === "production" });

  const devAuth = config.env !== "production" && process.env.DEV_AUTH === "1";
  // V225-audit M2 fix: DEV_AUTH=1 alone no longer grants unsigned dev:<uid>
  // impersonation — DevVerifier's constructor throws on an empty secret, so
  // a deployment can't drift into "dev auth is on with no secret" silently.
  const devVerifier = devAuth ? new DevVerifier(process.env.DEV_AUTH_SECRET ?? "") : undefined;
  const frontendDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../frontend"
  );

  // The subscription paywall (billing/subscriptions.ts's doc comment) is a
  // separate switch from having Stripe configured at all — STRIPE_SECRET_KEY
  // alone only enables checkout/the billing portal. STRIPE_ENFORCE_PAYWALL=1
  // is required on top of that to actually gate LLM usage, so turning on
  // Stripe never instantly locks out tenants that predate this feature.
  // Read directly from process.env (not AppConfig) so this stays out of
  // every test's inline config literal — it only matters here.
  const enforcePaywall = process.env.STRIPE_ENFORCE_PAYWALL === "1";
  const trialDays = Number(process.env.TRIAL_DAYS ?? 14);
  // v5.32.63 (audit V2-H1): was an inline one-parameter wrapper that dropped
  // userId, disabling the per-user daily cap whenever the paywall was on.
  const limitCheck: LimitCheck = enforcePaywall
    ? withSubscriptionGate(makeSubscriptionLimitCheck(trialDays), dbLimitCheck)
    : dbLimitCheck;

  const app = await buildServer({
    config,
    verifier: devVerifier ?? new IdentityPlatformVerifier(),
    devVerifier,
    adapters: [
      // GEMINI_PAID=1 → the key is on a billed Google AI account: higher
      // quotas, prompts not used for training, allowed in production.
      makeGeminiAiStudioAdapter({
        apiKey: config.geminiApiKey,
        model: process.env.GEMINI_MODEL,
        paidTier: config.geminiPaidTier,
      }),
      // Secondary adapter on a FULL Flash model: separate quota
      // pool (absorbs 503/429 on the primary) + audio-capable for
      // transcription when the primary is a lite model.
      makeGeminiAiStudioAdapter({
        apiKey: config.geminiApiKey,
        name: "gemini-aistudio-2",
        model: process.env.GEMINI_MODEL_2 ?? "gemini-3.5-flash",
        paidTier: config.geminiPaidTier,
      }),
      makeGeminiVertexAdapter({ project: config.gcpProject, model: process.env.GEMINI_MODEL }),
      makeAnthropicVertexAdapter({ project: config.gcpProject, location: config.vertexLocation }),
      /*
       * v5.34.54 — Claude on an API KEY rather than GCP credentials.
       *
       * Registered so the name resolves for routing; the platform's own
       * ANTHROPIC_API_KEY configures it when present, and it is skipped by the
       * chain when absent (isConfigured). Its real purpose is BYOK: a client
       * who wants their strategy deck on their OWN Anthropic account supplies a
       * key, and anthropic-vertex has nowhere to put one — it authenticates
       * with Application Default Credentials.
       */
      makeAnthropicApiAdapter({ apiKey: config.anthropicApiKey, model: process.env.ANTHROPIC_MODEL }),
      makeOpenAiAdapter({ apiKey: config.openaiApiKey }),
    ],
    meter: dbMeter,
    limitCheck,
    frontendConfig: {
      devAuth,
      firebase:
        process.env.FIREBASE_API_KEY && process.env.FIREBASE_AUTH_DOMAIN
          ? {
              apiKey: process.env.FIREBASE_API_KEY,
              authDomain: process.env.FIREBASE_AUTH_DOMAIN,
            }
          : null,
    },
    serveFrontendDir: devAuth ? frontendDir : undefined,
    // null (billing routes still mount, but respond "not configured") until
    // STRIPE_SECRET_KEY is set — see billing/stripeClient.ts.
    stripe: makeStripeClient(config.stripeSecretKey),
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(
    `VYNE API listening on :${config.port} (${config.env}${devAuth ? ", DEV AUTH" : ""}, errors ${[errorReportingOn ? "cloud" : null, sentryOn ? "sentry" : null].filter(Boolean).join("+") || "off"}, billing ${config.stripeSecretKey ? "on" : "off"}, paywall ${enforcePaywall ? "on" : "off"})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
