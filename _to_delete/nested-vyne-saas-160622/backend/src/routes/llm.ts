/**
 * The endpoint the frontend modules call INSTEAD of api.anthropic.com.
 * Phase 1 rewires Pre-Engagement's seven fetch() calls to POST here.
 *
 * V225-audit M4 fix: `task` used to be an unrestricted free-form string that
 * any authenticated caller — including an interviewee — could set directly,
 * and llm/router.ts's taskChains routes specific task names to the premium
 * Claude-first chain (synthesis, strategy_deck) instead of the cheap
 * default. Nothing stopped a crafted request (bypassing the frontend
 * entirely — this is an HTTP endpoint, not something enforced by the UI)
 * from setting task:"synthesis" on every call to force expensive routing.
 * Two allow-lists below close that: SERVER_ONLY_TASKS covers task labels
 * that legitimate frontend code never sends via THIS endpoint at all (they
 * have their own dedicated routes that call gateway.generate() directly —
 * solution_design via routes/solutionDesign.ts, transcribe/tts via
 * routes/voice.ts — so accepting them here has no legitimate caller, ever).
 * CONSULTANT_ONLY_TASKS covers labels real frontend pages DO send here
 * (synthesis.html/roadmap.html set window.VYNE_TASK_DEFAULT), but only
 * consultant/owner-role users ever load those pages.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GatewayError, type LlmGateway, redactProviderDetail } from "../llm/gateway.js";
import { resolveBillingClient } from "../llm/attribution.js";

const SERVER_ONLY_TASKS = new Set(["solution_design", "transcribe", "tts"]);
// v5.32.18: the Design Studio's six generators (intake suggestion, design
// brief, L3 component spec, governance package, MLOps/runbook artifacts, tool
// candidates) each have their own prompt and their own response schema, so
// they go through this endpoint via vyneLLM() rather than six new server
// routes — the same call shape roadmap.html and synthesis.html already use.
// They are consultant-only for the same reason strategy_deck is: only
// owner/consultant users can load solution_design.html at all.
const CONSULTANT_ONLY_TASKS = new Set([
  "synthesis",
  "strategy_deck",
  "design_studio",
  "design_intake",
  "design_brief",
  "design_l3",
  "design_governance",
  "design_artifact",
  "design_tools",
]);

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
  // Client cost-recovery billing (v5.27) — see routes/billing.ts. Attached
  // automatically by vyneLLM in vyne-client.js; call sites never set this
  // directly. v5.32.26: this is now VALIDATED rather than trusted — it feeds
  // usage_events.client_norm, which is what the cost-recovery statement a
  // firm invoices from is grouped by. See llm/attribution.ts.
  clientName: z.string().min(1).max(200).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.union([z.string().max(400_000), z.array(ContentBlock).min(1).max(20)]),
      })
    )
    // v5.32.29 (audit CR-3): .min(1) with no ceiling meant the only bound on a
    // prompt was the 32 MB bodyLimit — each element could carry 400 000
    // characters and there could be any number of them. No legitimate call
    // site sends more than a handful of turns.
    .min(1)
    .max(50),
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
    const { task, module, clientName, messages, jsonSchema, maxTokens, temperature } = parsed.data;
    if (SERVER_ONLY_TASKS.has(task)) {
      reply.code(403).send({ error: "task_not_allowed" });
      return;
    }
    if (CONSULTANT_ONLY_TASKS.has(task) && ctx.role !== "owner" && ctx.role !== "consultant") {
      reply.code(403).send({ error: "task_not_allowed" });
      return;
    }
    const billTo = await resolveBillingClient(ctx, clientName);
    if (clientName && billTo === undefined) {
      req.log.warn({ userId: ctx.userId, role: ctx.role, requested: clientName },
        "llm generate: billing attribution rejected — call metered as unattributed");
    }
    try {
      const result = await gateway.generate(
        { tenantId: ctx.tenantId, userId: ctx.userId, module, clientName: billTo },
        { task, messages, jsonSchema, maxTokens, temperature }
      );
      return {
        text: result.text,
        json: result.json,
        // v5.32.23: relayed so the browser can tell a complete response from a
        // truncated one. Nine frontend call sites already tested for this and
        // had been comparing against undefined since they were written.
        finishReason: result.finishReason,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        latencyMs: result.latencyMs,
      };
    } catch (err) {
      if (err instanceof GatewayError) {
        // V225-audit MEDIUM fix: err.message is client-safe; the raw
        // provider error text (which can include internal infra/account
        // detail) lives on err.detail and is logged, never sent.
        if (err.detail) req.log.error({ detail: redactProviderDetail(err.detail) }, "llm generate: provider error detail");
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      req.log.error({ err }, "llm generate failed");
      reply.code(500).send({ error: "llm_failed" });
    }
  });
}
