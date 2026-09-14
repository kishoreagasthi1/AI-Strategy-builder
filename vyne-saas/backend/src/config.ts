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
    vertexLocation: process.env.VERTEX_LOCATION ?? "us-east5",
    geminiApiKey: process.env.GEMINI_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    llmDefaultChain: process.env.LLM_DEFAULT_CHAIN?.split(",").map((s) => s.trim()),
    blockFreeTier: env === "production" && process.env.ALLOW_FREE_TIER !== "1",
  };
}
