/**
 * The endpoint the frontend modules call INSTEAD of api.anthropic.com.
 * Phase 1 rewires Pre-Engagement's seven fetch() calls to POST here.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GatewayError, type LlmGateway } from "../llm/gateway.js";

const Base64Source = z.object({
  type: z.literal("base64"),
  media_type: z.string().max(100),
  data: z.string().max(30_000_000), // ~22MB binary — PDFs/diagrams from doc intelligence
});

const ContentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(400_000) }),
  z.object({ type: z.literal("image"), source: Base64Source }),
  z.object({ type: z.literal("document"), source: Base64Source }),
  z.object({ type: z.literal("audio"), source: Base64Source }),
]);

const GenerateBody = z.object({
  task: z.string().min(1).max(80),
  module: z.string().min(1).max(80),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.union([z.string().max(400_000), z.array(ContentBlock).min(1).max(20)]),
      })
    )
    .min(1),
  jsonSchema: z.record(z.unknown()).optional(),
  maxTokens: z.number().int().positive().max(64_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export async function llmRoutes(app: FastifyInstance, gateway: LlmGateway): Promise<void> {
  app.get("/api/llm/providers", async () => ({ providers: gateway.availableProviders() }));

  app.post("/api/llm/generate", async (req, reply) => {
    const ctx = req.ctx!;
    const parsed = GenerateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_input", detail: parsed.error.flatten() });
      return;
    }
    const { task, module, messages, jsonSchema, maxTokens, temperature } = parsed.data;
    try {
      const result = await gateway.generate(
        { tenantId: ctx.tenantId, userId: ctx.userId, module },
        { task, messages, jsonSchema, maxTokens, temperature }
      );
      return {
        text: result.text,
        json: result.json,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        latencyMs: result.latencyMs,
      };
    } catch (err) {
      if (err instanceof GatewayError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      req.log.error({ err }, "llm generate failed");
      reply.code(500).send({ error: "llm_failed" });
    }
  });
}
