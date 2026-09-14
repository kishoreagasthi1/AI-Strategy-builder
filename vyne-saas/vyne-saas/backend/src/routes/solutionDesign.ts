/**
 * Solution Design Studio (v5.30) — the AI-generated, editable, exportable
 * "build/buy/partner" doc for one Roadmap use case.
 *
 *   POST   /api/solution-design/generate  — AI-generate (and save) a doc for a use case
 *   GET    /api/solution-design?client=…  — every saved doc for a client, keyed by use case id
 *   PUT    /api/solution-design           — save a consultant's hand-edit of a doc
 *   DELETE /api/solution-design           — remove one saved doc
 *
 * Storage: module_state key `vynora_solution_design_<normClient>` (registered
 * in auth/clients.ts's CODE_SUFFIX list — same "suffixed by norm client, not
 * an engagement code" shape as vynora_uc_overrides_/vynora_uc_stages_), value
 * `{ [useCaseId]: { useCaseName, generatedAt, editedAt, model, doc } }`.
 *
 * The prompt and JSON schema are owned SERVER-SIDE (not client-driven via
 * raw vyneLLM, unlike some of roadmap.html's older AI calls) — same pattern
 * as routes/synthetic.ts and routes/scorecard.ts, so the structure of a
 * design doc is one place to change, not scattered across frontend code.
 *
 * Client scoping matches every other module: owners see/generate for every
 * client, consultants only for clients they're assigned to.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { allowedClientNorms, clientAllowed, normClient } from "../auth/clients.js";
import { requireRole } from "../auth/middleware.js";
import { LlmGateway, GatewayError } from "../llm/gateway.js";

export interface SolutionDesignDoc {
  problemStatement: string;
  currentState: string;
  targetState: string;
  recommendation: { approach: "build" | "buy" | "partner"; rationale: string };
  dataAndIntegrationRequirements: string[];
  phasedPlan: { phase: number; name: string; description: string; durationWeeks: number }[];
  risksAndDependencies: { risk: string; mitigation: string }[];
  successMetrics: { metric: string; target: string }[];
}

const DOC_SCHEMA = {
  type: "object",
  properties: {
    problemStatement: { type: "string" },
    currentState: { type: "string" },
    targetState: { type: "string" },
    recommendation: {
      type: "object",
      properties: {
        approach: { type: "string", enum: ["build", "buy", "partner"] },
        rationale: { type: "string" },
      },
      required: ["approach", "rationale"],
    },
    dataAndIntegrationRequirements: { type: "array", items: { type: "string" } },
    phasedPlan: {
      type: "array",
      items: {
        type: "object",
        properties: {
          phase: { type: "number" },
          name: { type: "string" },
          description: { type: "string" },
          durationWeeks: { type: "number" },
        },
        required: ["phase", "name", "description", "durationWeeks"],
      },
    },
    risksAndDependencies: {
      type: "array",
      items: {
        type: "object",
        properties: { risk: { type: "string" }, mitigation: { type: "string" } },
        required: ["risk", "mitigation"],
      },
    },
    successMetrics: {
      type: "array",
      items: {
        type: "object",
        properties: { metric: { type: "string" }, target: { type: "string" } },
        required: ["metric", "target"],
      },
    },
  },
  required: [
    "problemStatement", "currentState", "targetState", "recommendation",
    "dataAndIntegrationRequirements", "phasedPlan", "risksAndDependencies", "successMetrics",
  ],
} as const;

function parseJsonLoose(text: string): SolutionDesignDoc {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned) as SolutionDesignDoc;
}

function buildPrompt(input: {
  clientName: string; industry?: string; useCaseName: string; useCaseDescription?: string;
  impact?: string; complexity?: string; businessValue?: string;
}): string {
  return `You are a senior AI transformation consultant writing a solution design document for a client
deliverable. Be concrete and specific to the use case described — never generic boilerplate.

Client: ${input.clientName}${input.industry ? ` (${input.industry})` : ""}
Use case: ${input.useCaseName}
${input.useCaseDescription ? `Description: ${input.useCaseDescription}\n` : ""}${input.impact ? `Impact rating: ${input.impact}\n` : ""}${input.complexity ? `Complexity rating: ${input.complexity}\n` : ""}${input.businessValue ? `Expected business value: ${input.businessValue}\n` : ""}
Produce a JSON object with exactly these fields:
- problemStatement: 2-4 sentences on the business problem this use case addresses, specific to this client/industry.
- currentState: 2-4 sentences on how this is handled today (manual process, legacy tooling, or absence of capability).
- targetState: 2-4 sentences on the future state once this use case is implemented.
- recommendation: {approach: one of "build"|"buy"|"partner", rationale: 2-3 sentences justifying the choice for THIS use case and client size/maturity}.
- dataAndIntegrationRequirements: 3-6 concrete bullet strings (data sources, systems to integrate, data quality prerequisites).
- phasedPlan: 3-5 phases, each {phase: 1-based number, name, description (1-2 sentences), durationWeeks}. Phases should sum to a realistic implementation timeline.
- risksAndDependencies: 3-5 {risk, mitigation} pairs, specific to this use case.
- successMetrics: 3-5 {metric, target} pairs — measurable, with a concrete target (percentage, dollar figure, or time reduction).

Return ONLY the JSON object, no markdown fences, no commentary.`;
}

const GenerateBody = z.object({
  clientName: z.string().min(1).max(200),
  useCaseId: z.string().min(1).max(200),
  useCaseName: z.string().min(1).max(300),
  useCaseDescription: z.string().max(2000).optional(),
  industry: z.string().max(100).optional(),
  impact: z.string().max(50).optional(),
  complexity: z.string().max(50).optional(),
  businessValue: z.string().max(500).optional(),
});

const DocShape = z.object({
  problemStatement: z.string(),
  currentState: z.string(),
  targetState: z.string(),
  recommendation: z.object({ approach: z.enum(["build", "buy", "partner"]), rationale: z.string() }),
  dataAndIntegrationRequirements: z.array(z.string()),
  phasedPlan: z.array(z.object({
    phase: z.number(), name: z.string(), description: z.string(), durationWeeks: z.number(),
  })),
  risksAndDependencies: z.array(z.object({ risk: z.string(), mitigation: z.string() })),
  successMetrics: z.array(z.object({ metric: z.string(), target: z.string() })),
});

const SaveBody = z.object({
  clientName: z.string().min(1).max(200),
  useCaseId: z.string().min(1).max(200),
  useCaseName: z.string().min(1).max(300).optional(),
  doc: DocShape,
});

const DeleteBody = z.object({ clientName: z.string().min(1).max(200), useCaseId: z.string().min(1).max(200) });

interface StoredEntry {
  useCaseName: string;
  generatedAt: string | null;
  editedAt: string | null;
  model: string | null;
  doc: SolutionDesignDoc;
}

async function readStore(tenantId: string, norm: string): Promise<Record<string, StoredEntry>> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query<{ value: { v: string } }>(
      `SELECT value FROM module_state WHERE module = 'workspace' AND key = $1`,
      ["vynora_solution_design_" + norm]
    );
    if (!r.rows[0]) return {};
    try { return JSON.parse(r.rows[0].value.v) as Record<string, StoredEntry>; } catch { return {}; }
  });
}

async function writeStore(tenantId: string, norm: string, userId: string, store: Record<string, StoredEntry>): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO module_state (tenant_id, module, key, value, updated_by)
       VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid, 'workspace', $1, $2, $3)
       ON CONFLICT (tenant_id, module, key)
       DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      ["vynora_solution_design_" + norm, JSON.stringify({ v: JSON.stringify(store) }), userId]
    );
  });
}

export async function solutionDesignRoutes(app: FastifyInstance, gateway: LlmGateway): Promise<void> {
  app.post(
    "/api/solution-design/generate",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const parsed = GenerateBody.safeParse(req.body);
      if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      const { clientName, useCaseId, useCaseName } = parsed.data;

      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      if (!clientAllowed(allowed, clientName)) {
        reply.code(403).send({ error: "client_not_assigned", detail: `You are not assigned to client "${clientName}".` });
        return;
      }
      const norm = normClient(clientName);

      let doc: SolutionDesignDoc;
      let model = "unknown";
      try {
        const result = await gateway.generate(
          { tenantId: ctx.tenantId, userId: ctx.userId, module: "solution_design", clientName },
          {
            task: "solution_design",
            temperature: 0.5,
            maxTokens: 3000,
            jsonSchema: DOC_SCHEMA,
            messages: [{ role: "user", content: buildPrompt(parsed.data) }],
          }
        );
        doc = parseJsonLoose(result.text);
        model = `${result.provider}/${result.model}`;
      } catch (err) {
        if (err instanceof GatewayError && err.detail) {
          req.log.error({ detail: err.detail }, "solution design generation: provider error detail");
        }
        req.log.error({ err }, "solution design generation failed");
        reply.code(502).send({ error: "generation_failed" });
        return;
      }

      const store = await readStore(ctx.tenantId, norm);
      const now = new Date().toISOString();
      store[useCaseId] = { useCaseName, generatedAt: now, editedAt: null, model, doc };
      await writeStore(ctx.tenantId, norm, ctx.userId, store);

      return { useCaseId, entry: store[useCaseId] };
    }
  );

  app.get("/api/solution-design", { preHandler: requireRole("owner", "consultant") }, async (req, reply) => {
    const ctx = req.ctx!;
    const q = z.object({ client: z.string().min(1).max(200) }).safeParse(req.query);
    if (!q.success) { reply.code(400).send({ error: "invalid_input" }); return; }
    const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
    if (!clientAllowed(allowed, q.data.client)) {
      reply.code(403).send({ error: "client_not_assigned" });
      return;
    }
    const store = await readStore(ctx.tenantId, normClient(q.data.client));
    return { designs: store };
  });

  app.put("/api/solution-design", { preHandler: requireRole("owner", "consultant") }, async (req, reply) => {
    const ctx = req.ctx!;
    const parsed = SaveBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
    const { clientName, useCaseId, doc } = parsed.data;
    const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
    if (!clientAllowed(allowed, clientName)) {
      reply.code(403).send({ error: "client_not_assigned" });
      return;
    }
    const norm = normClient(clientName);
    const store = await readStore(ctx.tenantId, norm);
    const existing = store[useCaseId];
    store[useCaseId] = {
      useCaseName: parsed.data.useCaseName ?? existing?.useCaseName ?? useCaseId,
      generatedAt: existing?.generatedAt ?? null,
      editedAt: new Date().toISOString(),
      model: existing?.model ?? null,
      doc,
    };
    await writeStore(ctx.tenantId, norm, ctx.userId, store);
    return { ok: true, entry: store[useCaseId] };
  });

  app.delete("/api/solution-design", { preHandler: requireRole("owner", "consultant") }, async (req, reply) => {
    const ctx = req.ctx!;
    const parsed = DeleteBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
    const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
    if (!clientAllowed(allowed, parsed.data.clientName)) {
      reply.code(403).send({ error: "client_not_assigned" });
      return;
    }
    const norm = normClient(parsed.data.clientName);
    const store = await readStore(ctx.tenantId, norm);
    if (!(parsed.data.useCaseId in store)) { reply.code(404).send({ error: "not_found" }); return; }
    delete store[parsed.data.useCaseId];
    await writeStore(ctx.tenantId, norm, ctx.userId, store);
    return { ok: true };
  });
}
