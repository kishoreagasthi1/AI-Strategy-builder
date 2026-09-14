/**
 * App assembly — separated from index.ts so tests can build a server with
 * injected fakes (token verifier, adapters, meter) and no GCP dependency.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import type { AppConfig } from "./config.js";
import type { TokenVerifier } from "./auth/verify.js";
import { makeAuthHook } from "./auth/middleware.js";
import { LlmGateway, type Meter, type LimitCheck } from "./llm/gateway.js";
import type { ProviderAdapter } from "./llm/types.js";
import { DEV_POLICY, PROD_POLICY } from "./llm/router.js";
import { healthRoutes } from "./routes/health.js";
import { signupRoutes } from "./routes/signup.js";
import { firmRoutes, firmEmailLookupRoutes } from "./routes/firms.js";
import { engagementRoutes } from "./routes/engagements.js";
import { llmRoutes } from "./routes/llm.js";
import { moduleStateRoutes } from "./routes/moduleState.js";
import { interviewRoutes } from "./routes/interviews.js";
import { assignmentRoutes } from "./routes/assignments.js";
import { voiceRoutes } from "./routes/voice.js";
import { syntheticRoutes } from "./routes/synthetic.js";
import { scorecardRoutes } from "./routes/scorecard.js";
import { billingRoutes } from "./routes/billing.js";
import { auditRoutes } from "./routes/audit.js";
import { subscriptionRoutes, stripeWebhookRoutes } from "./routes/subscriptions.js";
import { solutionDesignRoutes } from "./routes/solutionDesign.js";
import type { StripeClient } from "./billing/stripeClient.js";
import { configRoutes, type FrontendConfig } from "./routes/config.js";
import { devAuthRoutes } from "./routes/devAuth.js";
import type { DevVerifier } from "./auth/devVerifier.js";
import { requireRole } from "./auth/middleware.js";
import { makeTts } from "./llm/tts.js";
import { captureError } from "./monitoring/sentry.js";

export interface BuildDeps {
  config: AppConfig;
  verifier: TokenVerifier;
  adapters: ProviderAdapter[];
  meter: Meter;
  limitCheck?: LimitCheck;
  frontendConfig?: FrontendConfig;
  /** When set (dev), serve the frontend directory on / for same-origin local runs. */
  serveFrontendDir?: string;
  /** SaaS subscription billing (Stripe). Omitted/null = billing routes stay
   *  up but respond "billing_not_configured" — see routes/subscriptions.ts. */
  stripe?: StripeClient | null;
  /** Set ONLY in dev-auth mode (DEV_AUTH=1, non-production) — when present,
   *  mounts POST /api/dev/mint-token so the frontend can obtain a signed
   *  dev token without ever holding DEV_AUTH_SECRET itself. See
   *  auth/devVerifier.ts and routes/devAuth.ts. */
  devVerifier?: DevVerifier;
}

export async function buildServer(deps: BuildDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({ logger: config.env !== "test", bodyLimit: 32 * 1024 * 1024 });

  // V225-audit MEDIUM fix: without this, an error that escapes a route
  // handler uncaught (a thrown exception not wrapped in try/catch, an
  // unexpected DB driver error, a bug) falls through to Fastify's default
  // error handler, which serializes `err.message` straight into the JSON
  // response — that can be a raw Postgres error (table/column names, query
  // fragments) or any other internal detail, not something meant for a
  // client. This is a backstop for the routes that don't already have
  // their own try/catch (every route in this app that calls an external
  // service does), not a replacement for those — full detail is always
  // logged server-side either way.
  app.setErrorHandler((err, req, reply) => {
    // V225-audit M5 follow-up: @fastify/rate-limit throws a well-formed,
    // already-safe 429 (no internal detail in its message — see
    // node_modules/@fastify/rate-limit's defaultErrorResponse) when a
    // client is over its limit. That's an expected, client-actionable
    // condition, not the kind of unexpected-internal-error this backstop
    // exists to hide — collapsing it to a generic 500 would both mislabel
    // it and stop clients from ever seeing (or backing off on) 429s.
    // Everything else keeps the original fail-safe behavior below.
    if ((err as { statusCode?: number }).statusCode === 429) {
      reply.code(429).send({ error: "rate_limited" });
      return;
    }
    req.log.error({ err }, "unhandled route error");
    // Best-effort — a no-op unless SENTRY_DSN was set at process startup
    // (see monitoring/sentry.ts; index.ts is the only place that calls
    // initSentry(), so this is always a no-op in tests).
    captureError(err, { url: req.url, method: req.method });
    reply.code(500).send({ error: "internal_error" });
  });

  // V225-audit billing Low fix: this was `origin: true` (reflects ANY
  // request Origin back), which is broader than the app ever actually
  // needs — in production the frontend and API are same-origin (Firebase
  // Hosting rewrites /api/** to this service, see frontend/firebase.json),
  // and locally the API can serve the frontend directly too
  // (serveFrontendDir below). config.appBaseUrl already exists as "the one
  // trusted origin" for Stripe redirect URLs (routes/subscriptions.ts) —
  // reusing it here pins CORS to that same origin once it's configured,
  // while falling back to permissive only when it's unset (local dev,
  // where appBaseUrl is typically never set and a cross-port dev frontend
  // is a normal setup).
  await app.register(cors, { origin: config.appBaseUrl ? [config.appBaseUrl] : true });

  // V225-audit H1 fix (defense-in-depth): the primary fix for LLM/interviewee
  // -text XSS is escaping at every render site (see synthesis.html/
  // interview_agent.html's esc()), applied alongside this. This CSP is a
  // second layer: even if some future sink misses escaping, script-src still
  // allows 'unsafe-inline' (this app is built from inline <script> blocks
  // throughout — removing that is a larger follow-up refactor), so injected
  // markup can still execute. What this DOES stop is the exfiltration step —
  // connect-src 'self' blocks fetch/XHR/beacon calls to an attacker's origin,
  // which is exactly how a token-theft payload gets the stolen session out.
  // In production the frontend is served by Firebase Hosting (see
  // frontend/firebase.json's matching header block), not this server — this
  // hook only takes effect when deps.serveFrontendDir serves the frontend
  // directly (local/dev) or for this API's own JSON responses (harmless).
  app.addHook("onSend", async (_req, reply) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://www.gstatic.com https://apis.google.com; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; " +
        "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://apis.google.com; " +
        "frame-src https://vyne-platform-prod.firebaseapp.com; " +
        "frame-ancestors 'none'; base-uri 'self'; " +
        "form-action 'self'; object-src 'none'"
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  });

  if (deps.serveFrontendDir) {
    await app.register(fastifyStatic, { root: deps.serveFrontendDir, prefix: "/" });
  }

  const gateway = new LlmGateway({
    adapters: deps.adapters,
    policy: config.env === "production" ? PROD_POLICY : DEV_POLICY,
    meter: deps.meter,
    blockFreeTier: config.blockFreeTier,
    limitCheck: deps.limitCheck,
    defaultChainOverride: config.llmDefaultChain,
  });

  const stripe = deps.stripe ?? null;

  // Public routes
  await healthRoutes(app, { env: config.env });
  await app.register(signupRoutes);
  await app.register(firmRoutes);
  // v5.32: email-based firm lookup — a fresh, unauthenticated visitor can
  // probe "does this email have an account" by timing/volume even without
  // ever getting a real answer back, so this gets its own tight rate limit
  // (unlike GET /api/firm above, which is keyed on a slug/host/id that
  // already requires an invite link or custom domain to know in the first
  // place — nothing to enumerate there).
  await app.register(async (firmLookupScope) => {
    await firmLookupScope.register(rateLimit, {
      max: 10,
      timeWindow: "1 minute",
      keyGenerator: (req) => req.ip,
    });
    await firmEmailLookupRoutes(firmLookupScope);
  });
  await configRoutes(
    app,
    deps.frontendConfig ?? { devAuth: false, firebase: null }
  );
  if (deps.devVerifier) {
    await devAuthRoutes(app, deps.devVerifier);
  }
  // Stripe → us. Public: Stripe never sends a Bearer token, and signature
  // verification (not the auth hook) is the trust boundary — see its own
  // doc comment for why this must NOT be registered inside protectedScope.
  await stripeWebhookRoutes(app, { stripe, webhookSecret: config.stripeWebhookSecret });

  // Protected routes — auth hook scoped to this encapsulated context
  await app.register(async (protectedScope) => {
    protectedScope.addHook("preHandler", makeAuthHook(deps.verifier));

    // Who am I — drives the role-aware launcher.
    protectedScope.get("/api/me", async (req) => {
      const ctx = req.ctx!;
      return { userId: ctx.userId, role: ctx.role, email: ctx.email };
    });

    // Consultant/owner surface
    await protectedScope.register(async (consultantScope) => {
      consultantScope.addHook("preHandler", requireRole("owner", "consultant"));
      await engagementRoutes(consultantScope);
    });

    // All roles (module-state does its own interviewee gating; the LLM
    // gateway serves interviewees too — their interview needs it).
    //
    // V225-audit M5 fix: LLM/voice calls are the expensive, directly
    // metered surface (real provider $$ per request) and had no rate
    // limiting at all — a compromised/buggy client, or someone probing the
    // task allow-list from M4, could hammer these endpoints without limit.
    // Scoped to just this nested context (not the whole app) so cheap
    // routes like /api/me or /api/engagements are unaffected. `hook:
    // 'preHandler'` runs this AFTER the auth preHandler already registered
    // on protectedScope (ancestor hooks fire before descendant hooks for
    // the same phase in Fastify), so req.ctx.userId is available to key on
    // — rate limiting per authenticated user rather than per IP, since
    // multiple users can legitimately share an IP (NAT, office network).
    await protectedScope.register(async (llmVoiceScope) => {
      await llmVoiceScope.register(rateLimit, {
        max: 60,
        timeWindow: "1 minute",
        hook: "preHandler",
        keyGenerator: (req) => req.ctx?.userId ?? req.ip,
      });
      await llmRoutes(llmVoiceScope, gateway);
      await voiceRoutes(
        llmVoiceScope,
        gateway,
        makeTts({ apiKey: config.geminiApiKey, paidTier: config.geminiPaidTier }),
        deps.meter
      );
    });
    await moduleStateRoutes(protectedScope);
    await interviewRoutes(protectedScope);
    await assignmentRoutes(protectedScope);
    await syntheticRoutes(protectedScope, gateway);
    await scorecardRoutes(protectedScope);
    await billingRoutes(protectedScope);
    await auditRoutes(protectedScope);
    await subscriptionRoutes(protectedScope, { stripe, appBaseUrl: config.appBaseUrl });
    await solutionDesignRoutes(protectedScope, gateway);
  });

  return app;
}
