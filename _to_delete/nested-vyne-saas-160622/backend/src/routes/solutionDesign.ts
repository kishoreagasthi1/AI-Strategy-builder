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
import { LlmGateway, GatewayError, redactProviderDetail } from "../llm/gateway.js";
import { loadClientEvidence, formatEvidenceForPrompt, type ClientEvidence } from "../tenant/engagementLookup.js";

export interface SolutionDesignDoc {
  problemStatement: string;
  currentState: string;
  targetState: string;
  recommendation: { approach: "build" | "buy" | "partner"; rationale: string };
  dataAndIntegrationRequirements: string[];
  phasedPlan: { phase: number; name: string; description: string; durationWeeks: number; assumed?: boolean }[];
  risksAndDependencies: { risk: string; mitigation: string }[];
  successMetrics: { metric: string; target: string; assumed?: boolean }[];
  /**
   * v5.32.21 provenance. All optional so documents generated before this
   * release still validate and still open.
   *
   * currentStateBasis is the one that matters most: "how this is handled
   * today" is the section a client will read as research, and until now it
   * was written from the company's name and an industry label alone.
   */
  currentStateBasis?: "evidenced" | "assumed" | "mixed";
  evidenceUsed?: string[];
  assumptions?: string[];
}

/* v5.32.20: the DOC_SCHEMA JSON-Schema literal that used to live here fed
   gateway `jsonSchema`, which is no longer used (see the generate handler for
   why). The authoritative shape is DocShape below — one definition, used both
   to validate the model's output and to validate a consultant's hand-edit on
   PUT, instead of two that could drift. */

/**
 * v5.32.20: this used to be a bare JSON.parse after stripping fences, which
 * throws on the two things models actually do — wrap the object in a sentence
 * ("Here is the design document: {...}"), or emit a trailing comma. The six
 * Design Studio generators that go through /api/llm/generate have always used
 * a tolerant parser client-side; this one didn't, and was the only generator
 * in the studio that failed.
 */
export function parseJsonLoose(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall back to the outermost {...} span, then to a trailing-comma repair.
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const span = cleaned.slice(first, last + 1);
      try {
        return JSON.parse(span);
      } catch {
        try {
          return JSON.parse(span.replace(/,(\s*[}\]])/g, "$1"));
        } catch { /* fall through to the throw below */ }
      }
    }
    // A response cut off mid-object has an opening brace and no matching close.
    // Saying so is worth the extra branch: "it ran out of room" and "it didn't
    // produce JSON" need different fixes, and conflating them is what sent the
    // last round of debugging down the wrong path.
    const opens = (cleaned.match(/\{/g) ?? []).length;
    const closes = (cleaned.match(/\}/g) ?? []).length;
    if (opens > closes) throw new Error("the response was cut off before the document was finished");
    throw new Error("the model did not return a parseable JSON object");
  }
}

function buildPrompt(
  input: {
    clientName: string; industry?: string; useCaseName: string; useCaseDescription?: string;
    impact?: string; complexity?: string; businessValue?: string;
  },
  evidence: ClientEvidence
): string {
  const evidenceBlock = formatEvidenceForPrompt(evidence);

  // v5.32.21. Two changes, both aimed at the same failure: the generator was
  // writing confident, specific claims about a client's current state — naming
  // their source control and their requirements tool, describing how they test
  // today — with nothing behind it but the company name and "Automotive".
  //
  //   1. It now receives the client's OWN diagnostic where one exists:
  //      measured D1-D7 scores against sector benchmarks, findings corroborated
  //      by two or more interviewees, synthesis gaps and root causes, and the
  //      client's stated problem in their own words.
  //   2. It must now declare its own provenance. Anything it could not ground
  //      in that evidence has to be listed in `assumptions` and, for the
  //      timeline and the metrics, flagged per row — because those are where
  //      invented numbers hide most convincingly.
  const groundingRules = evidenceBlock
    ? `GROUNDING RULES — these govern the whole document:
- The DIAGNOSTIC EVIDENCE below is the only thing you actually know about this client. Everything else is inference.
- currentState MUST be built from that evidence. Cite the dimension or the role where it came from. Do NOT invent specific vendors, tools, systems or org structures the evidence does not name.
- If the evidence is thin, write a shorter currentState. A short grounded paragraph beats a long invented one.
- Set currentStateBasis to "evidenced" if every claim traces to the evidence, "mixed" if some do, "assumed" if none do.
- List in evidenceUsed the specific evidence points you actually relied on.
- List in assumptions the 6-10 most important claims a client could challenge that the evidence does not support — named tools, current practices, org details, and quantified figures you chose yourself. One short line each.
- On each phasedPlan row and each successMetrics row, set assumed:true unless that number comes from the evidence. Durations you estimated are assumed:true. Targets you chose are assumed:true.`
    : `GROUNDING RULES — these govern the whole document:
- There is NO diagnostic data for this client yet: no interviews, no scores, no synthesis. You know only the client's name, their industry, and this use case.
- You therefore cannot know how anything is handled today. Write currentState as the typical starting position for an organisation of this type, phrased as such ("Organisations at this stage typically..."), NOT as a statement about this client.
- Set currentStateBasis to "assumed".
- Leave evidenceUsed empty.
- List in assumptions the 6-10 MOST important claims to confirm — the ones a client would challenge first. One short line each. Cover: current practices you assumed, any system or tool you referred to, and every quantified figure you chose.
- Set assumed:true on every phasedPlan row and every successMetrics row.
- Do NOT name specific vendors, products or internal systems as if the client uses them.`;

  return `You are a senior AI transformation consultant writing a solution design document for a client
deliverable. Be concrete and specific to the use case described — never generic boilerplate.

Client: ${input.clientName}${input.industry ? ` (${input.industry})` : ""}
Use case: ${input.useCaseName}
${input.useCaseDescription ? `Description: ${input.useCaseDescription}\n` : ""}${input.impact ? `Impact rating: ${input.impact}\n` : ""}${input.complexity ? `Complexity rating: ${input.complexity}\n` : ""}${input.businessValue ? `Expected business value (NOTE: this is a planning target carried from the roadmap, not a measured result — treat it as an assumption, not evidence): ${input.businessValue}\n` : ""}
${groundingRules}
${evidenceBlock ? `\nDIAGNOSTIC EVIDENCE FOR ${input.clientName.toUpperCase()} — gathered in this engagement:\n${evidenceBlock}\n` : ""}
Produce a JSON object with exactly these fields:
- problemStatement: 2-4 sentences on the business problem this use case addresses, specific to this client/industry.
- currentState: 2-4 sentences on how this is handled today, per the grounding rules above.
- targetState: 2-4 sentences on the future state once this use case is implemented.
- recommendation: {approach: one of "build"|"buy"|"partner", rationale: 2-3 sentences justifying the choice for THIS use case and client size/maturity}.
- dataAndIntegrationRequirements: 3-6 concrete bullet strings (data sources, systems to integrate, data quality prerequisites). Describe them by ROLE ("the ERP holding invoice records") unless the evidence names the actual system.
- phasedPlan: 3-5 phases, each {phase: 1-based number, name, description (1-2 sentences), durationWeeks, assumed}. Phases should sum to a realistic implementation timeline.
- risksAndDependencies: 3-5 {risk, mitigation} pairs, specific to this use case.
- successMetrics: 3-5 {metric, target, assumed} pairs — measurable, with a concrete target (percentage, dollar figure, or time reduction).
- currentStateBasis: "evidenced" | "mixed" | "assumed", per the grounding rules.
- evidenceUsed: array of up to 8 short strings — the evidence points you relied on, one line each. Empty array if none.
- assumptions: array of 6-10 short strings — the claims to confirm before this goes in front of a client. ONE LINE each, no sub-clauses, e.g. "Assumes defect triage is currently manual — not confirmed by any interview".

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
  // v5.32.20: coerced, not bare z.number(). Without a provider-enforced schema
  // a model will sometimes emit "phase": "1" as a string, and rejecting the
  // whole document over a quoted digit would be a bad trade. Coercion still
  // rejects genuine garbage — z.coerce.number() on "abc" yields NaN, which
  // fails the number check — so this widens the accepted input, not the shape.
  phasedPlan: z.array(z.object({
    phase: z.coerce.number(), name: z.string(), description: z.string(), durationWeeks: z.coerce.number(),
    assumed: z.boolean().optional(),
  })),
  risksAndDependencies: z.array(z.object({ risk: z.string(), mitigation: z.string() })),
  successMetrics: z.array(z.object({ metric: z.string(), target: z.string(), assumed: z.boolean().optional() })),
  // Provenance — optional so pre-v5.32.21 saved documents still load and still
  // save. Absent means "unknown provenance", which the UI renders as such
  // rather than silently implying the content was evidenced.
  currentStateBasis: z.enum(["evidenced", "assumed", "mixed"]).optional(),
  evidenceUsed: z.array(z.string()).optional(),
  assumptions: z.array(z.string()).optional(),
});

const SaveBody = z.object({
  clientName: z.string().min(1).max(200),
  useCaseId: z.string().min(1).max(200),
  useCaseName: z.string().min(1).max(300).optional(),
  doc: DocShape,
});

const DeleteBody = z.object({ clientName: z.string().min(1).max(200), useCaseId: z.string().min(1).max(200) });

export interface EvidenceBasis {
  hadEvidence: boolean;
  interviewCount: number;
  rolesInterviewed: string[];
  confirmedFindingCount: number;
  hasSynthesis: boolean;
  hasScores: boolean;
}

interface StoredEntry {
  useCaseName: string;
  generatedAt: string | null;
  editedAt: string | null;
  model: string | null;
  doc: SolutionDesignDoc;
  evidenceBasis?: EvidenceBasis;
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

/**
 * Read, change and write the client's design store as ONE operation
 * (v5.32.65, audit V2-M2).
 *
 * Every use case for a client lives in a single module_state row, so "save one
 * use case" is really "rewrite the whole store". That was a read in one
 * transaction, a change in JavaScript, and a write in another — the textbook
 * lost update. Two consultants working the same client at once, or one
 * consultant with the Design Studio open in two tabs, and the slower write puts
 * back a store that never saw the faster one's use case. Nothing errors; the
 * work is simply gone, and it looks like the save silently failed.
 *
 * The advisory lock is the same device the budget path uses: keyed on the row
 * this call is about, held for the transaction, released at commit. A row lock
 * would not do, because the first write for a client has no row to lock and
 * that is exactly when two concurrent generations collide.
 *
 * `mutate` runs inside the transaction. It must stay pure and quick — no
 * network, no model calls — or it holds the lock for the length of whatever it
 * waits on. Generation happens BEFORE this is called, and the result is passed
 * in.
 */
async function mutateStore<T>(
  tenantId: string,
  norm: string,
  userId: string,
  mutate: (store: Record<string, StoredEntry>) => T
): Promise<T> {
  const key = "vynora_solution_design_" + norm;
  return withTenant(tenantId, async (c) => {
    await c.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`,
      [tenantId, key]
    );
    const r = await c.query<{ value: { v: string } }>(
      `SELECT value FROM module_state WHERE module = 'workspace' AND key = $1`, [key]
    );
    let store: Record<string, StoredEntry> = {};
    if (r.rows[0]) {
      try { store = JSON.parse(r.rows[0].value.v) as Record<string, StoredEntry>; } catch { store = {}; }
    }
    const out = mutate(store);
    await c.query(
      `INSERT INTO module_state (tenant_id, module, key, value, updated_by)
       VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid, 'workspace', $1, $2, $3)
       ON CONFLICT (tenant_id, module, key)
       DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify({ v: JSON.stringify(store) }), userId]
    );
    return out;
  });
}

/** Sentinel for a mutation that decided there was nothing to write. */
const NOT_FOUND = Symbol("not_found");

export async function solutionDesignRoutes(app: FastifyInstance, gateway: LlmGateway): Promise<void> {
  app.post(
    "/api/solution-design/generate",
    {
      preHandler: requireRole("owner", "consultant"),
      // v5.32.29 (audit CR-3, corrected): a per-ROUTE ceiling on the endpoints
      // that fan out to many billed generations. An earlier shape put these in
      // an encapsulated scope, which also swept in the solution-design GET /
      // PUT / DELETE — so a consultant simply editing several use cases in the
      // Design Studio would have been throttled at six requests a minute.
      // Reads and saves stay on the 300/min baseline; only generation is
      // expensive, so only generation is tightly capped.
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const ctx = req.ctx!;
      const parsed = GenerateBody.safeParse(req.body);
      if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      // Bind once: the safeParse narrowing doesn't survive into attempt()'s
      // closure below, and re-reading parsed.data there widens it back to
      // possibly-undefined.
      const input = parsed.data;
      const { clientName, useCaseId, useCaseName } = input;

      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      if (!clientAllowed(allowed, clientName)) {
        reply.code(403).send({ error: "client_not_assigned", detail: `You are not assigned to client "${clientName}".` });
        return;
      }
      const norm = normClient(clientName);

      // Load whatever this client's engagement actually established. Never
      // fatal: a client with no completed interviews yields empty evidence,
      // and the prompt has a branch that says so plainly rather than letting
      // the model fill the silence with invention.
      let evidence: ClientEvidence;
      try {
        evidence = await loadClientEvidence(ctx.tenantId, clientName);
      } catch (e) {
        req.log.warn({ err: e }, "solution design: evidence load failed, generating unevidenced");
        evidence = {
          code: null, hasAny: false, rolesInterviewed: [], interviewCount: 0,
          confirmedFindings: [], thematicFindings: [], criticalGaps: [], strengths: [], blindSpots: [], hasSynthesis: false,
        };
      }

      let doc: SolutionDesignDoc;
      let model = "unknown";

      // One retry, and only for a SHAPE failure — a response that arrived but
      // didn't parse or didn't validate. Provider/transport failures are the
      // gateway's job and it already retries and falls through the chain;
      // retrying those here would just multiply the wait.
      //
      // The retry asks for a tighter document rather than repeating the same
      // request, because the failure this exists to absorb is length: the model
      // spent its budget on prose and stopped mid-object. Asking again
      // identically would mostly reproduce it.
      const COMPACT_SUFFIX =
        "\n\nIMPORTANT: your previous attempt was cut off before the JSON was complete. " +
        "Produce the SAME structure but noticeably shorter — 2 sentences per prose field, " +
        "3 phases, 3 risks, 3 metrics, at most 6 assumptions, one short line each. " +
        "Completeness of the JSON object matters more than richness of the prose.";

      async function attempt(compact: boolean): Promise<{ doc: SolutionDesignDoc; model: string }> {
        const prompt = buildPrompt(input, evidence) + (compact ? COMPACT_SUFFIX : "");
        const result = await gateway.generate(
          { tenantId: ctx.tenantId, userId: ctx.userId, module: "solution_design", clientName },
          {
            task: "solution_design",
            temperature: 0.5,
            // v5.32.21 added three output fields (currentStateBasis,
            // evidenceUsed, assumptions) on top of the eight already here, and
            // a longer prompt to go with them — which pushed this past 4000 and
            // produced exactly the failure the previous bump was meant to fix:
            // a response truncated mid-JSON, surfacing as "not parseable"
            // rather than as an explicit length error. On a thinking-capable
            // model the reasoning tokens come out of this same budget too.
            // This is the largest single output in the studio; size it like it.
            maxTokens: 8000,
            // NOTE: deliberately NO jsonSchema. This route was the only caller in
            // the codebase that set one, and the only Design Studio generator that
            // failed in production while the other six — same models, same gateway,
            // same deployment, JSON requested in the prompt instead — all
            // succeeded. Gemini maps jsonSchema onto responseSchema, an OpenAPI
            // subset that rejects constructs plain JSON Schema allows; rather than
            // guess which one it objected to, this now uses the mechanism already
            // proven in this deployment. The field contract is spelled out in the
            // prompt and enforced below by DocShape, so nothing is loosened: an
            // off-spec response still fails, it just fails with a reason.
            messages: [{ role: "user", content: prompt }],
          }
        );
        const usedModel = `${result.provider}/${result.model}`;
        let raw: unknown;
        try {
          raw = parseJsonLoose(result.text);
        } catch (e) {
          // Log a bounded head/tail of what actually came back. Without this,
          // "not parseable" is a dead end for whoever debugs it next — which is
          // exactly where the last two rounds of this went.
          req.log.error(
            {
              reason: (e as Error).message,
              chars: result.text.length,
              head: result.text.slice(0, 200),
              tail: result.text.slice(-120),
            },
            "solution design: unparseable model response"
          );
          throw e;
        }
        const shaped = DocShape.safeParse(raw);
        if (!shaped.success) {
          const where = shaped.error.issues
            .slice(0, 3)
            .map((i) => i.path.join(".") || "(root)")
            .join(", ");
          throw new Error(`the model's response was missing or malformed at: ${where}`);
        }
        const built = shaped.data;
        // Backstop the model's self-report. If we handed it nothing, the
        // document is assumed regardless of what it claims — a model marking
        // its own homework is exactly the thing this feature exists to stop.
        if (!evidence.hasAny) {
          built.currentStateBasis = "assumed";
          built.evidenceUsed = [];
          built.phasedPlan = built.phasedPlan.map((p) => ({ ...p, assumed: true }));
          built.successMetrics = built.successMetrics.map((m) => ({ ...m, assumed: true }));
        } else if (!built.currentStateBasis) {
          built.currentStateBasis = "mixed";
        }
        return { doc: built, model: usedModel };
      }

      try {
        let out: { doc: SolutionDesignDoc; model: string };
        try {
          out = await attempt(false);
        } catch (first) {
          // Only a shape failure earns a second call. A GatewayError means the
          // providers themselves failed; the gateway already exhausted its own
          // chain and retrying would just double the wait for the same answer.
          if (first instanceof GatewayError) throw first;
          req.log.warn({ err: first }, "solution design: first attempt unusable, retrying compact");
          out = await attempt(true);
        }
        doc = out.doc;
        model = out.model;
      } catch (err) {
        // The raw provider text stays server-side (it can carry quota and
        // account specifics — see GatewayError). What goes back is a short,
        // client-safe reason, because "generation_failed" with nothing else
        // left both the consultant and the next engineer with no thread to pull.
        if (err instanceof GatewayError && err.detail) {
          req.log.error({ detail: redactProviderDetail(err.detail) }, "solution design generation: provider error detail");
        }
        req.log.error({ err }, "solution design generation failed");
        const detail =
          err instanceof GatewayError
            ? err.message
            : `The model responded, but ${(err as Error).message}. Try again — this is usually transient.`;
        reply.code(err instanceof GatewayError ? err.statusCode : 502).send({ error: "generation_failed", detail });
        return;
      }

      const now = new Date().toISOString();
      const entry = await mutateStore(ctx.tenantId, norm, ctx.userId, (store) => {
        store[useCaseId] = {
        useCaseName, generatedAt: now, editedAt: null, model, doc,
        // Snapshot of what was actually available at generation time — so a
        // doc opened weeks later still says whether it was grounded, without
        // re-deriving evidence that may have changed since.
          evidenceBasis: {
            hadEvidence: evidence.hasAny,
            interviewCount: evidence.interviewCount,
            rolesInterviewed: evidence.rolesInterviewed,
            confirmedFindingCount: evidence.confirmedFindings.length,
            hasSynthesis: evidence.hasSynthesis,
            hasScores: Boolean(evidence.scores),
          },
        };
        return store[useCaseId];
      });

      return { useCaseId, entry };
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
    const entry = await mutateStore(ctx.tenantId, norm, ctx.userId, (store) => {
      const existing = store[useCaseId];
      store[useCaseId] = {
        useCaseName: parsed.data.useCaseName ?? existing?.useCaseName ?? useCaseId,
        generatedAt: existing?.generatedAt ?? null,
        editedAt: new Date().toISOString(),
        model: existing?.model ?? null,
        doc,
        evidenceBasis: existing?.evidenceBasis,
      };
      return store[useCaseId];
    });
    return { ok: true, entry };
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
    // The existence check has to happen under the lock too, or a delete can
    // race a concurrent generate and 404 on a use case that now exists.
    const outcome = await mutateStore(ctx.tenantId, norm, ctx.userId, (store) => {
      if (!(parsed.data.useCaseId in store)) return NOT_FOUND;
      delete store[parsed.data.useCaseId];
      return "deleted" as const;
    });
    if (outcome === NOT_FOUND) { reply.code(404).send({ error: "not_found" }); return; }
    return { ok: true };
  });
}
