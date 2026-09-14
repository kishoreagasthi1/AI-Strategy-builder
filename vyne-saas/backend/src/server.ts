/**
 * App assembly — separated from index.ts so tests can build a server with
 * injected fakes (token verifier, adapters, meter) and no GCP dependency.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type { AppConfig } from "./config.js";
import type { TokenVerifier } from "./auth/verify.js";
import { makeAuthHook } from "./auth/middleware.js";
import { LlmGateway, type Meter, type LimitCheck } from "./llm/gateway.js";
import type { ProviderAdapter } from "./llm/types.js";
import { DEV_POLICY, PROD_POLICY } from "./llm/router.js";
import { healthRoutes } from "./routes/health.js";
import { signupRoutes } from "./routes/signup.js";
import { firmRoutes } from "./routes/firms.js";
import { engagementRoutes } from "./routes/engagements.js";
import { llmRoutes } from "./routes/llm.js";
import { moduleStateRoutes } from "./routes/moduleState.js";
import { interviewRoutes } from "./routes/interviews.js";
import { assignmentRoutes } from "./routes/assignments.js";
import { voiceRoutes } from "./routes/voice.js";
import { syntheticRoutes } from "./routes/synthetic.js";
import { configRoutes, type FrontendConfig } from "./routes/config.js";
import { requireRole } from "./auth/middleware.js";
import { makeTts } from "./llm/tts.js";

export interface BuildDeps {
  config: AppConfig;
  verifier: TokenVerifier;
  adapters: ProviderAdapter[];
  meter: Meter;
  limitCheck?: LimitCheck;
  frontendConfig?: FrontendConfig;
  /** When set (dev), serve the frontend directory on / for same-origin local runs. */
  serveFrontendDir?: string;
}

export async function buildServer(deps: BuildDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({ logger: config.env !== "test", bodyLimit: 32 * 1024 * 1024 });

  await app.register(cors, { origin: true });

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

  // Public routes
  await app.register(healthRoutes);
  await app.register(signupRoutes);
  await app.register(firmRoutes);
  await configRoutes(
    app,
    deps.frontendConfig ?? { devAuth: false, firebase: null }
  );

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
    await llmRoutes(protectedScope, gateway);
    await moduleStateRoutes(protectedScope);
    await interviewRoutes(protectedScope);
    await assignmentRoutes(protectedScope);
    await syntheticRoutes(protectedScope, gateway);
    await voiceRoutes(
      protectedScope,
      gateway,
      makeTts({ apiKey: config.geminiApiKey }),
      deps.meter
    );
  });

  return app;
}
