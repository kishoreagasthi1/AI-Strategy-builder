/**
 * App assembly — separated from index.ts so tests can build a server with
 * injected fakes (token verifier, adapters, meter) and no GCP dependency.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import type { AppConfig } from "./config.js";
import type { TokenVerifier } from "./auth/verify.js";
import { makeAuthHook } from "./auth/middleware.js";
import { LlmGateway, redactProviderDetail, type Meter, type LimitCheck } from "./llm/gateway.js";
import { makeByokResolver } from "./llm/byok/resolve.js";
import { makeByokLiveResolver } from "./llm/byok/resolveLive.js";
import { deactivateKey, recordResolveError, clearResolveError } from "./llm/byok/byokRepo.js";
import { routingFor } from "./llm/byok/clientRouting.js";
import { hasFallbackGrant } from "./llm/byok/fallbackGrant.js";
import type { ProviderAdapter } from "./llm/types.js";
import { DEV_POLICY, PROD_POLICY } from "./llm/router.js";
import { healthRoutes } from "./routes/health.js";
import { signupRoutes } from "./routes/signup.js";
import { firmRoutes, firmEmailLookupRoutes, operatorKeyMatches } from "./routes/firms.js";
import { engagementRoutes } from "./routes/engagements.js";
import { llmRoutes } from "./routes/llm.js";
import { moduleStateRoutes } from "./routes/moduleState.js";
import { interviewRoutes } from "./routes/interviews.js";
import { assignmentRoutes } from "./routes/assignments.js";
import { voiceRoutes } from "./routes/voice.js";
import { syntheticRoutes } from "./routes/synthetic.js";
import { scorecardRoutes } from "./routes/scorecard.js";
import { billingRoutes } from "./routes/billing.js";
import { byokRoutes, byokPublicRoutes } from "./routes/byok.js";
import { auditRoutes } from "./routes/audit.js";
import { subscriptionRoutes, stripeWebhookRoutes } from "./routes/subscriptions.js";
import { solutionDesignRoutes } from "./routes/solutionDesign.js";
import type { StripeClient } from "./billing/stripeClient.js";
import { configRoutes, type FrontendConfig } from "./routes/config.js";
import { devAuthRoutes } from "./routes/devAuth.js";
import type { DevVerifier } from "./auth/devVerifier.js";
import { requireRole } from "./auth/middleware.js";
import { makeTts } from "./llm/tts.js";
import { makeLiveSession } from "./llm/liveSession.js";
import { captureError, scrubUrl } from "./monitoring/errors.js";

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

/**
 * What to trust when resolving req.ip — named and exported so a test can assert
 * on the REAL decision (v5.32.72).
 *
 * The first version of this fix lived inline in the Fastify options, and the
 * tests written for it built their own Fastify instances with the setting
 * hard-coded. Reverting server.ts to the exploitable hop count did not fail a
 * single assertion: the suite was testing proxy-addr's behaviour, not this
 * application's configuration. Anything a test needs to pin has to be reachable
 * from the test.
 *
 * See the block comment at the call site for why this is a list and not a
 * number.
 */
export function resolveTrustProxy(
  env: string,
  hopsOverride: string | undefined
): boolean | number | string[] {
  if (hopsOverride !== undefined) return Number(hopsOverride);
  return env === "production" ? ["loopback", "linklocal", "uniquelocal"] : false;
}

export async function buildServer(deps: BuildDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    /*
     * v5.32.72: log the RAW X-Forwarded-For chain beside the resolved address.
     *
     * The frontend is served from Firebase Hosting, which rewrites /api/* to
     * Cloud Run — and Firebase TERMINATES the visitor's connection and
     * re-originates from Google's own infrastructure. Measured on production:
     * Cloud Run's own httpRequest.remoteIp reads 192.178.15.195, 64.233.172.72,
     * 74.125.215.227 — all Google ranges — while the app resolved those same
     * requests to 169.254.169.126, a link-local hop. The real client is in
     * NEITHER log. No value of TRUST_PROXY_HOPS recovers it, because the
     * information is not present to be recovered.
     *
     * Rate limiting is unaffected: every authenticated scope keys on
     * ctx.userId, not on the address — see protectedScope and llmVoiceScope
     * below. What was actually lost is FORENSICS. For a product holding other
     * firms' client data, "which machine did this" has to be answerable after
     * the fact, and remoteAddress alone cannot answer it here.
     *
     * So the header is recorded verbatim. It is EVIDENCE, never authorization:
     * a client can put anything in X-Forwarded-For before Google appends to it,
     * which is exactly why trustProxy is a hop COUNT and not `true`. Nothing
     * reads this field to make a decision; it exists so that a human
     * investigating an incident has the whole chain rather than one hop of it.
     */
    logger: config.env === "test" ? false : {
      serializers: {
        req(request: FastifyRequest) {
          return {
            method: request.method,
            /* v5.32.76 (audit Low): the query string is dropped here too, not
             * only on the Sentry path. `?client=Acme%20Manufacturing`,
             * `?code=ACME01`, `?email=...` — a consulting product's URLs name
             * the CUSTOMER'S customers, and an access log is readable by
             * anyone with Cloud Logging read on the project, which is a much
             * wider audience than an incident responder. The PATH identifies
             * the endpoint, which is all a request log needs. */
            url: scrubUrl(request.url) as string,
            hostname: request.hostname,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort,
            xff: request.headers["x-forwarded-for"],
          };
        },
      },
    },
    bodyLimit: 32 * 1024 * 1024,
    // v5.32.29 (audit Low): unset meant a stalled request could occupy a
    // server slot until Cloud Run's own ~20-minute ceiling. Comfortably above
    // the 120s provider timeout so a slow generation still completes.
    requestTimeout: 180_000,
    /*
     * v5.32.72 SECURITY. This was `Number(TRUST_PROXY_HOPS ?? 2)` and the hop
     * count was exploitable — by the exact mechanism the v5.32.65 comment it
     * replaces claimed it prevented.
     *
     * That comment reasoned about a THREE-entry chain
     *     X-Forwarded-For: <client-supplied>, <real client>, <load balancer>
     * and concluded 2 skips the invented entry. It does, for that length. But
     * proxy-addr truncates the chain at the first UNtrusted hop and returns
     * whatever is leftmost in what remains — so when the chain is SHORTER than
     * the count, the count runs off the end and returns the attacker's entry.
     *
     * Cloud Run appends the connecting peer to X-Forwarded-For. A caller who
     * hits the run.app URL directly with `X-Forwarded-For: 6.6.6.6` therefore
     * produces exactly two entries, "6.6.6.6, <their real address>". Measured:
     *
     *   trustProxy: 2   "6.6.6.6, 198.51.100.7"  -> req.ip = 6.6.6.6
     *
     * req.ip is attacker-chosen, and rotating the header gives a fresh value
     * per request. That defeats both IP-keyed limiters: the operator scope
     * (20/min on FAILED platform-key attempts — the credential that PROVISIONS
     * FIRMS) and the firm-email lookup (10/min anti-enumeration). Exactly the
     * "broken-absent" outcome the old comment warned about, introduced by the
     * setting meant to avoid it.
     *
     * The fix is to stop counting and start naming. Trust is now a LIST of
     * infrastructure address classes, so proxy-addr walks right-to-left and
     * stops at the first address that is not infrastructure — which is the
     * peer Cloud Run itself appended, and cannot be forged because the caller
     * does not choose it. Anything further left is ignored no matter how many
     * entries were invented:
     *
     *   infrastructure-only  "6.6.6.6, 198.51.100.7"        -> 198.51.100.7
     *   infrastructure-only  "6.6.6.6, 7.7.7.7, 198.51.100.7" -> 198.51.100.7
     *
     * This rests on Cloud Run appending the peer, which is documented and is
     * pinned by test/trustProxyForgery.test.ts rather than assumed here.
     *
     * Behind Firebase Hosting nothing changes: production logs show no
     * X-Forwarded-For on that path at all, so req.ip stays the link-local peer.
     * That address is useless for forensics — which is what the xff field in
     * the serializer above exists to cover — but it is not forgeable, and no
     * hop count could have recovered a client address that was never sent.
     *
     * TRUST_PROXY_HOPS still overrides, as a number, for deployments behind a
     * different proxy arrangement. It is off outside production, where there is
     * no proxy and trusting a header would be the only way to spoof an address.
     */
    trustProxy: resolveTrustProxy(config.env, process.env.TRUST_PROXY_HOPS),
  });

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
    // scrubUrl (v5.32.65, audit V2-M3): the path identifies the endpoint; the
    // query string identifies the client. Only the first belongs to a vendor.
    captureError(err, { url: scrubUrl(req.url), method: req.method });
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
  // v5.32.29 SECURITY (audit H-4). `: true` reflects ANY origin, and
  // APP_BASE_URL appears nowhere in deploy/ — so a service brought up by the
  // shipped script ran with wide-open CORS. In production the absence of an
  // explicit origin is now a boot failure rather than a silent fallback to
  // "allow everything"; outside production it stays permissive so local dev
  // and tests are unaffected.
  if (config.env === "production" && !config.appBaseUrl) {
    throw new Error(
      "APP_BASE_URL is required in production — it is the CORS allow-list. " +
      "Set it on the Cloud Run service (deploy/deploy.sh does this) and redeploy."
    );
  }
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
        "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://apis.google.com https://generativelanguage.googleapis.com wss://generativelanguage.googleapis.com; " +
        "media-src 'self' data: blob:; " +
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
    // v5.32.65 (audit V2-M4). A dropped usage_events row is money that was
    // spent and never recorded. It still must not fail the request, so it is
    // logged at error and sent to Sentry, where it can be alerted on.
    onMeterError: (err, event) => {
      app.log.error(
        { err, tenantId: event.tenantId, task: event.task, provider: event.provider,
          model: event.model, tokensIn: event.tokensIn, tokensOut: event.tokensOut },
        "metering write FAILED — usage not recorded for this call"
      );
      captureError(err, { where: "safeMeter", tenantId: event.tenantId, task: event.task });
    },
    /*
     * BYOK slice 2 (v5.34.59). Wired only when a GCP project is configured,
     * because without one there is no Secret Manager to read a client's key
     * from — and an unconfigured resolver that throws on every call would turn
     * a feature nobody is using into a tax on every generation.
     *
     * The models match the platform adapters' so a client's own key produces
     * the same deliverable the firm's would; only the payer changes.
     */
    byok: config.gcpProject
      ? makeByokResolver({
          secretStore: { projectId: config.gcpProject },
          geminiModel: process.env.GEMINI_MODEL,
          geminiModel2: process.env.GEMINI_MODEL_2,
          anthropicModel: process.env.ANTHROPIC_MODEL,
          /*
           * Record it on the row, not only in the log (v5.34.61).
           *
           * On 2026-09-13 this exact callback fired for several minutes while
           * the keys screen said "active" and every call was silently billed to
           * the firm. A log line nobody watches is not a signal.
           */
          onResolveError: ({ tenantId, provider, clientName, clientNorm, reason, err }) => {
            app.log.error({ err, provider, clientName },
              "byok: a client key is on file but could not be used — falling back to the platform credential");
            if (clientNorm && reason) void recordResolveError(tenantId, clientNorm, provider, reason);
          },
          onResolveOk: ({ tenantId, provider, clientNorm }) => {
            void clearResolveError(tenantId, clientNorm, provider);
          },
        })
      : undefined,
    /*
     * A client's stated preference (v5.34.63). Same condition as byok above is
     * NOT applied: this needs no Secret Manager, only the database, so it works
     * for a firm that has no BYOK clients at all — a client can prefer Claude
     * while still running on the firm's own credentials.
     */
    clientRouting: async ({ tenantId, clientName }) => {
      try {
        return (await routingFor(tenantId, clientName))?.textVendor ?? null;
      } catch (err) {
        app.log.error({ err, clientName }, "client routing preference could not be read — using firm policy");
        return null;
      }
    },
    /*
     * Has the firm agreed to carry this client's key failures (v5.34.64)?
     *
     * Wired unconditionally, like clientRouting and for the same reason: it is
     * a database read, not a Secret Manager one. It is consulted only when a
     * client actually has credentials resolved for the call, so a firm with no
     * BYOK clients never pays for the lookup.
     */
    fallbackGrant: async ({ tenantId, clientName }) => {
      try {
        return await hasFallbackGrant(tenantId, clientName);
      } catch (err) {
        // No grant on error. A database blip must not start spending the
        // firm's money on a client who is supposed to be paying their own way.
        app.log.error({ err, clientName }, "fallback grant could not be read — assuming none");
        return false;
      }
    },
    onByokRejected: ({ tenantId, clientName, provider, detail }) => {
      /*
       * Mark the key failed so the Owner's screen stops saying "active", and
       * so the next call does not pay for another round trip to discover the
       * same refusal. Deliberately not awaited — the request has already
       * fallen back and must not wait on bookkeeping — so the rejection is
       * logged whether or not the write lands.
       */
      app.log.warn({ clientName, provider, detail: redactProviderDetail(detail) },
        "byok: a client's key was refused by its vendor — marking it failed");
      void deactivateKey(tenantId, clientName, provider, "failed", undefined,
                         "refused by the provider during a call")
        .catch((err) => app.log.error({ err, clientName, provider },
          "byok: could not mark the refused key failed"));
    },
  });

  const stripe = deps.stripe ?? null;

  // Public routes
  await healthRoutes(app, { env: config.env });
  // v5.32.29 (audit Low): the operator endpoints provision firms and had no
  // rate limit, so the platform key could be guessed at line speed. Keyed on
  // IP because these callers are unauthenticated by construction.
  await app.register(async (operatorScope) => {
    await operatorScope.register(rateLimit, {
      max: 20,
      timeWindow: "1 minute",
      keyGenerator: (req) => req.ip,
      // The threat here is brute-forcing the platform key, so count only the
      // attempts that FAIL it. A holder of the correct key is an operator
      // doing legitimate work — throttling them at 20/min would break a
      // routine burst of firm edits while doing nothing extra for security,
      // since a valid key already means the attacker has won.
      // v5.32.59 (L1): this was a plain equality check on the operator key,
      // which short-circuits on the first differing byte and runs on EVERY
      // request to this scope — the same timing leak requireOperator() closed,
      // reintroduced one layer up. One constant-time comparison, used by both.
      allowList: (req) => operatorKeyMatches(req.headers["x-signup-key"]),
    });
    await operatorScope.register(signupRoutes);
    await operatorScope.register(firmRoutes);
  });
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
  /*
   * v5.34.55 — the client's half of BYOK. Public on purpose: the client's
   * administrator has no account here, and requiring one to hand over their own
   * credential would be absurd. The trust boundary is the token — 32 random
   * bytes, stored only as a hash, single-use, expiring — not the auth hook.
   * Rate-limited by IP because it is an unauthenticated endpoint that does
   * real work (a provider probe and a Secret Manager write).
   */
  await app.register(async (byokScope) => {
    await byokScope.register(rateLimit, {
      max: 10,
      timeWindow: "1 minute",
      keyGenerator: (req) => req.ip,
    });
    await byokPublicRoutes(byokScope, {
      secretStore: { projectId: config.gcpProject ?? "" },
      appBaseUrl: config.appBaseUrl,
    });
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

    /*
     * v5.32.65 (audit V2-M6). This block used to sit BELOW the route
     * definitions that follow it. Fastify applies a hook to the routes
     * registered AFTER it within the same encapsulation context, so /api/me and
     * every engagement route — declared above the old position — inherited
     * nothing at all. The comment below said "a baseline now applies to EVERY
     * authenticated route" and it was true of most of them, which is the kind
     * of gap that survives review: the sentence is right, the ordering is not.
     *
     * /api/me is not an idle target. It is the cheapest authenticated probe in
     * the product, it touches the database on every call, and it is the natural
     * loop for enumerating whether a stolen token is still live.
     *
     * Nothing below may be moved above this line without losing its limit.
     */
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
    // v5.32.29 SECURITY (audit CR-3). The limiter used to live in a nested
    // scope holding only llmRoutes and voiceRoutes, so it covered four routes
    // out of roughly forty. Everything else — including
    // POST /api/synthetic/engagement and POST /api/solution-design/generate,
    // which BOTH call gateway.generate() and the former of which fans out to
    // ~40 billed generations per request — was registered as a sibling on
    // protectedScope and inherited nothing. /api/module-state and
    // /api/interviews/mine/state were likewise unlimited, which is what made
    // the DB-pool exhaustion in audit M-7 practical.
    //
    // A baseline now applies to EVERY authenticated route, with a tighter
    // ceiling on the expensive ones. Both are keyed on the authenticated user
    // (hook 'preHandler' runs after protectedScope's auth hook, so req.ctx is
    // populated), because several users legitimately share one NAT'd IP.
    //
    // Known limitation, deliberately not papered over: @fastify/rate-limit's
    // default store is per-process, so on Cloud Run the effective ceiling is
    // this number times the instance count, and load causes scale-up. It is a
    // brake, not a wall — the real wall is the per-user daily token budget in
    // llm/metering.ts, which is backed by Postgres and therefore global.
    await protectedScope.register(rateLimit, {
      max: 300,
      timeWindow: "1 minute",
      hook: "preHandler",
      keyGenerator: (req) => req.ctx?.userId ?? req.ip,
    });

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

    await protectedScope.register(async (llmVoiceScope) => {
      // v5.34.6: empty-body-tolerant JSON parser, scoped to the voice/LLM
      // routes only (same encapsulated-scope technique the Stripe webhook
      // uses in subscriptions.ts). Fastify's default parser throws
      // "Unsupported Media Type" on a zero-length application/json body,
      // which surfaced as a 500 internal_error and broke the realtime voice
      // session. Scoping it here avoids colliding with the root default and
      // the webhook's buffer parser.
      llmVoiceScope.addContentTypeParser(
        "application/json",
        { parseAs: "string" },
        (_req, body, done) => {
          const s = typeof body === "string" ? body.trim() : body;
          if (s === "" || s == null) { done(null, {}); return; }
          try {
            done(null, JSON.parse(s as string));
          } catch (err) {
            (err as { statusCode?: number }).statusCode = 400;
            done(err as Error, undefined);
          }
        }
      );
      await llmVoiceScope.register(rateLimit, {
        max: 60,
        timeWindow: "1 minute",
        hook: "preHandler",
        keyGenerator: (req) => "llm:" + (req.ctx?.userId ?? req.ip),
      });
      await llmRoutes(llmVoiceScope, gateway);
      await voiceRoutes(
        llmVoiceScope,
        gateway,
        makeTts({ apiKey: config.geminiApiKey, paidTier: config.geminiPaidTier }),
        deps.meter,
        // Realtime voice. Registered only when a key exists; with none, the
        // routes simply are not there and the client falls back to the
        // existing text + TTS path rather than erroring.
        config.geminiApiKey
          ? makeLiveSession({ apiKey: config.geminiApiKey, paidTier: config.geminiPaidTier })
          : undefined,
        /*
         * BYOK for realtime voice (v5.34.59) — the expensive path, and the one
         * clients actually ask about. Same condition as the gateway resolver:
         * no GCP project, no Secret Manager, no client keys.
         */
        config.gcpProject
          ? {
              forClient: makeByokLiveResolver({
                secretStore: { projectId: config.gcpProject },
                onResolveError: ({ tenantId, clientName, clientNorm, reason, err }) => {
                  app.log.error({ err, clientName },
                    "byok(live): a client key is on file but could not be used — the session is refused unless this client has a fallback grant");
                  if (clientNorm && reason) {
                    void recordResolveError(tenantId, clientNorm, "gemini-aistudio", reason);
                  }
                },
                onResolveOk: ({ tenantId, clientNorm }) => {
                  void clearResolveError(tenantId, clientNorm, "gemini-aistudio");
                },
              }),
              /*
               * v5.34.64: the voice route asks this before letting the firm's
               * credential mint a session for a BYOK client whose own key
               * cannot be spent. Same fail-closed rule as the gateway's.
               */
              fallbackGrant: async (tenantId, clientName) => {
                try {
                  return await hasFallbackGrant(tenantId, clientName);
                } catch (err) {
                  app.log.error({ err, clientName },
                    "byok(live): fallback grant could not be read — assuming none");
                  return false;
                }
              },
              onRejected: ({ tenantId, clientName, detail }) => {
                app.log.warn({ clientName, detail: redactProviderDetail(detail) },
                  "byok(live): a client's key was refused by Google — marking it failed");
                void deactivateKey(tenantId, clientName, "gemini-aistudio", "failed", undefined,
                                   "refused by Google when minting a live session")
                  .catch((err) => app.log.error({ err, clientName },
                    "byok(live): could not mark the refused key failed"));
              },
            }
          : undefined
      );
    });
    // The two generation endpoints that fan out to many billed calls carry a
    // tighter PER-ROUTE ceiling (config.rateLimit on the route itself) rather
    // than living in their own scope — an encapsulated scope would also have
    // covered the solution-design read/save routes, throttling ordinary Design
    // Studio editing at six requests a minute.
    await syntheticRoutes(protectedScope, gateway);
    await solutionDesignRoutes(protectedScope, gateway);
    await moduleStateRoutes(protectedScope);
    await interviewRoutes(protectedScope);
    await assignmentRoutes(protectedScope);
    await scorecardRoutes(protectedScope);
    await billingRoutes(protectedScope);
    await byokRoutes(protectedScope, {
      secretStore: { projectId: config.gcpProject ?? "" },
      appBaseUrl: config.appBaseUrl,
    });
    await auditRoutes(protectedScope);
    await subscriptionRoutes(protectedScope, { stripe, appBaseUrl: config.appBaseUrl });
  });

  return app;
}
