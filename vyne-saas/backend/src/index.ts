/**
 * Production entrypoint — wires real implementations into buildServer().
 * DEV_AUTH=1 (non-production only) swaps in the dev verifier and serves the
 * frontend directory same-origin so the whole stack runs locally sans GCP.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { initPool } from "./db/pool.js";
import { buildServer } from "./server.js";
import { IdentityPlatformVerifier } from "./auth/verify.js";
import { DevVerifier } from "./auth/devVerifier.js";
import { dbMeter, dbLimitCheck } from "./llm/metering.js";
import { makeGeminiAiStudioAdapter } from "./llm/adapters/geminiAiStudio.js";
import { makeGeminiVertexAdapter } from "./llm/adapters/geminiVertex.js";
import { makeAnthropicVertexAdapter } from "./llm/adapters/anthropicVertex.js";
import { makeOpenAiAdapter } from "./llm/adapters/openai.js";

async function main(): Promise<void> {
  const config = loadConfig();
  initPool(config.databaseUrl);

  const devAuth = config.env !== "production" && process.env.DEV_AUTH === "1";
  const frontendDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../frontend"
  );

  const app = await buildServer({
    config,
    verifier: devAuth ? new DevVerifier() : new IdentityPlatformVerifier(),
    adapters: [
      // GEMINI_PAID=1 → the key is on a billed Google AI account: higher
      // quotas, prompts not used for training, allowed in production.
      makeGeminiAiStudioAdapter({
        apiKey: config.geminiApiKey,
        model: process.env.GEMINI_MODEL,
        paidTier: process.env.GEMINI_PAID === "1",
      }),
      // Secondary adapter on a FULL Flash model: separate quota
      // pool (absorbs 503/429 on the primary) + audio-capable for
      // transcription when the primary is a lite model.
      makeGeminiAiStudioAdapter({
        apiKey: config.geminiApiKey,
        name: "gemini-aistudio-2",
        model: process.env.GEMINI_MODEL_2 ?? "gemini-3.5-flash",
        paidTier: process.env.GEMINI_PAID === "1",
      }),
      makeGeminiVertexAdapter({ project: config.gcpProject, model: process.env.GEMINI_MODEL }),
      makeAnthropicVertexAdapter({ project: config.gcpProject, location: config.vertexLocation }),
      makeOpenAiAdapter({ apiKey: config.openaiApiKey }),
    ],
    meter: dbMeter,
    limitCheck: dbLimitCheck,
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
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(
    `VYNE API listening on :${config.port} (${config.env}${devAuth ? ", DEV AUTH" : ""})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
