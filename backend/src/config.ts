/**
 * Central configuration — everything env-driven so the same container image
 * runs locally (docker-compose Postgres, AI Studio free Gemini) and on
 * Cloud Run (Cloud SQL, Vertex AI, Secret Manager-injected env vars).
 *
 * No provider key is EVER sent to the browser. Secrets arrive here via
 * environment variables (locally from .env, on Cloud Run from Secret Manager).
 */

export interface AppConfig {
  port: number;
  env: "development" | "test" | "production";
  databaseUrl: string;
  gcpProject: string | undefined;
  /** Passed only to the anthropic-vertex adapter. Default "global" matches
   *  Claude on Vertex's current serving location (see adapters/
   *  anthropicVertex.ts) — "us-east5" was this codebase's original
   *  assumption when the adapter was first written and is now stale. */
  vertexLocation: string;
  /** Google AI Studio key (free-tier Gemini). Dev/sandbox ONLY — see routing policy. */
  geminiApiKey: string | undefined;
  /** Optional direct-API keys for additional providers. */
  openaiApiKey: string | undefined;
  anthropicApiKey: string | undefined;
  /** Default provider chain override, comma-separated adapter names. */
  llmDefaultChain: string[] | undefined;
  /** When true (production), free-tier adapters are excluded from every chain. */
  blockFreeTier: boolean;
  /**
   * GEMINI_PAID=1 → geminiApiKey is a billed Google AI Studio account (higher
   * quotas, prompts not used for training, allowed in production). Read once
   * here so every free-tier-aware construction site (LLM adapters, TTS) uses
   * the same source of truth instead of re-reading process.env individually
   * (V225-audit CRITICAL fix: TTS used to skip this check entirely).
   */
  geminiPaidTier: boolean;
  /**
   * Error monitoring (Sentry). Optional (not required) so every existing
   * inline AppConfig literal across the test suite keeps compiling
   * unchanged — monitoring is opt-in and off by default with no DSN.
   */
  sentryDsn?: string;
  /**
   * SaaS subscription billing (Stripe) — all optional for the same reason
   * as sentryDsn above. With stripeSecretKey unset, routes/subscriptions.ts
   * serves plan info read-only and refuses checkout/portal with a clear
   * "billing not configured" error instead of ever calling Stripe.
   */
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  /** Trusted origin Checkout/portal redirect URLs are built from — never
   *  taken from client input (see routes/subscriptions.ts doc comment). */
  appBaseUrl?: string;
}

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadConfig(): AppConfig {
  const env = (process.env.NODE_ENV ?? "development") as AppConfig["env"];
  return {
    port: Number(process.env.PORT ?? 8080),
    env,
    databaseUrl: req(
      "DATABASE_URL",
      env === "production" ? undefined : "postgres://vyne:vyne@localhost:5432/vyne"
    ),
    gcpProject: process.env.GOOGLE_CLOUD_PROJECT,
    vertexLocation: process.env.VERTEX_LOCATION ?? "global",
    geminiApiKey: process.env.GEMINI_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    llmDefaultChain: process.env.LLM_DEFAULT_CHAIN?.split(",").map((s) => s.trim()),
    blockFreeTier: env === "production" && process.env.ALLOW_FREE_TIER !== "1",
    geminiPaidTier: process.env.GEMINI_PAID === "1",
    sentryDsn: process.env.SENTRY_DSN,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    appBaseUrl: process.env.APP_BASE_URL,
  };
}
