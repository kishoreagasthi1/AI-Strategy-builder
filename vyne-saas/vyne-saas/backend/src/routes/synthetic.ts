/**
 * Synthetic engagement generator — test data for the Synthesis Dashboard.
 *
 * POST /api/synthetic/engagement  (consultant/owner only)
 *   { clientName, industry, includeRefresh }
 *
 * Generates a full engagement the REAL pipeline could have produced:
 *   • 5 executive interviews (CEO, COO, CTO, CDO, CHRO) with per-role
 *     perspective bias, seeded CONTRADICTIONS (CEO optimism vs CTO reality
 *     on data readiness; COO vs CDO on process automation) and a seeded
 *     BLIND SPOT (nobody owns governance) — so Synthesis has real work to do.
 *   • Optionally a refresh round: 6 months later, D2/D6 improved, with
 *     per-dimension coverage, exercising multi-round blended scoring.
 *   • A minimal briefing context (hypotheses) so the verdict panel works.
 *   • Tracker rows marked [Synthetic] and completed, so the data is visible
 *     and deletable from the Interview Tracker.
 *
 * Data lands in the shared 'workspace' module_state in EXACTLY the key
 * shapes the Synthesis Dashboard reads (engagement index → engagement record
 * with flat interviews[]; its loader distributes rounds and computes scores).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { requireRole } from "../auth/middleware.js";
import { allowedClientNorms, clientAllowed, normClient } from "../auth/clients.js";
import { GatewayError, type LlmGateway } from "../llm/gateway.js";

const Body = z.object({
  clientName: z.string().min(2).max(120),
  /** Optional — falls back to the client's Pre-Engagement briefing, then "Manufacturing". */
  industry: z.string().min(2).max(80).optional(),
  includeRefresh: z.boolean().default(true),
});

interface Persona {
  role: string;
  name: string;
  bias: string;
}

const PERSONAS: Persona[] = [
  { role: "CEO",  name: "Victoria Hale",  bias: "Optimistic about AI's strategic potential; overestimates the company's data readiness; frames everything in growth terms; vague on execution detail." },
  { role: "COO",  name: "Marcus Webb",    bias: "Pragmatic and process-focused; skeptical about automation hype; believes operations are further along than the CDO thinks; frustrated by IT bottlenecks." },
  { role: "CTO",  name: "Priya Sharma",   bias: "Technically candid; contradicts the CEO's rosy view of data quality (three warehouses, no single source of truth); confident about infrastructure, worried about talent." },
  { role: "CDO",  name: "Daniel Osei",    bias: "Newest executive; sees data fragmentation clearly; contradicts the COO on process automation maturity; pushing for governance nobody else prioritises." },
  { role: "CHRO", name: "Elena Rodriguez", bias: "People-focused; candid that AI skills are thin and change fatigue is real; nobody has discussed reskilling budgets; culture is cautious." },
];

/** Personas built from the client's OWN Pre-Engagement role setup — so the
 *  synthetic engagement exercises exactly the roles (and their priority
 *  dimensions) the consultant configured. Falls back to the default
 *  executive set when no briefing exists yet. */
interface BriefingRole { value?: string; display?: string; priorityDims?: string[] }
const SYNTH_NAMES = [
  "Victoria Hale", "Marcus Webb", "Priya Sharma", "Daniel Osei", "Elena Rodriguez",
  "James Chen", "Sofia Marino", "David Okafor", "Hannah Weiss", "Lucas Ferreira",
];
const PERSONA_FLAVORS = [
  "Leans optimistic about the organisation's AI readiness overall; frames answers in strategic growth terms; vague on execution detail.",
  "Technically candid; describes fragmented data (multiple warehouses, no single source of truth), contradicting more optimistic colleagues.",
  "Pragmatic and process-focused; believes operations are more automated than the data specialists think; frustrated by IT bottlenecks.",
  "Sees data fragmentation and manual handoffs clearly; contradicts operational optimism; pushing for governance nobody else prioritises.",
  "People-focused; candid that AI skills are thin and change fatigue is real; nobody has discussed reskilling budgets; culture is cautious.",
];
export function personasFromRoles(roles: BriefingRole[]): Persona[] | null {
  if (!Array.isArray(roles) || roles.length === 0) return null;
  return roles.slice(0, 10).map((r, i) => {
    const label = r.display || r.value || `Executive ${i + 1}`;
    const dims = r.priorityDims && r.priorityDims.length ? r.priorityDims.join(", ") : "their functional area";
    return {
      role: label,
      name: SYNTH_NAMES[i % SYNTH_NAMES.length],
      bias: `Answers strictly from the ${label} vantage point; deepest and most opinionated on ${dims}, only high-level views elsewhere. ${PERSONA_FLAVORS[i % PERSONA_FLAVORS.length]}`,
    };
  });
}

/** Contradictions + blind spot phrased with the ACTUAL roles in play. */
function seedsFor(personas: Persona[]): string {
  const r = (i: number) => personas[Math.min(i, personas.length - 1)].role;
  return `Seeded engagement dynamics (weave these in naturally):
- CONTRADICTION 1: the ${r(0)} says data is "basically ready"; the ${r(1)} describes three disconnected warehouses and no single source of truth.
- CONTRADICTION 2: the ${r(2)} believes core processes are largely automated; the ${r(3)} says most "automation" is spreadsheets and manual handoffs.
- BLIND SPOT: AI governance (D6) has no owner — every executive assumes someone else covers it; scores there should be low with thin, vague findings.
- STRENGTH: leadership alignment on AI strategy intent (D3) is genuinely decent.`;
}

function synthPrompt(p: Persona, client: string, industry: string, refresh: boolean, seeds: string, hypotheses: string[]): string {
  return `You are generating REALISTIC synthetic test data for an AI-readiness diagnostic interview.
Company: ${client} (${industry}, ~$1B-$2B revenue). Interviewee: ${p.name}, ${p.role}.
Perspective bias for this persona: ${p.bias}
${seeds}
${hypotheses.length ? "The consulting team's working hypotheses for this engagement (several findings should provide concrete evidence FOR or AGAINST these):\n" + hypotheses.map((h, i) => `H${i + 1}: ${h}`).join("\n") : ""}
${refresh ? "CONTEXT: this is a REFRESH interview ~6 months after the initial round. Data platform consolidation (D2) genuinely improved (+0.5 to +1.0), a governance council was stood up (D6 improved, now has an owner), other dimensions moved only slightly. The persona references what changed." : "CONTEXT: this is the INITIAL diagnostic round."}

Dimensions: D1 Data, D2 Technology, D3 AI Strategy, D4 People, D5 Process, D6 Governance, D7 Culture. Scores are 1.0-5.0 (one decimal), seen FROM THIS PERSONA'S BIASED PERSPECTIVE.

Return ONLY valid JSON, no markdown fences, exactly this shape:
{"scores":{"D1":2.5,"D2":2.5,"D3":3.0,"D4":2.0,"D5":2.5,"D6":1.5,"D7":2.5},
 "findings":[{"dimension":"D1","text":"specific finding phrased as an observed condition, function-level, never blaming individuals"}],
 "summary":"2-3 sentence interview summary in a consultant's voice"}
Provide 6-9 findings spread across dimensions (always include at least one D6 finding reflecting the ${refresh ? "new governance council" : "governance blind spot"}).`;
}

function parseJsonLoose(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned) as Record<string, unknown>;
}

const PersonaPreviewBody = z.object({
  clientName: z.string().min(2).max(120),
  /** An existing role label from the client's Pre-Engagement roleCatalog (e.g. "CFO"). */
  role: z.string().min(1).max(100).optional(),
  /** Or a fully custom, one-off persona — no role lookup. */
  personaName: z.string().min(1).max(100).optional(),
  personaBias: z.string().min(1).max(2000).optional(),
  industry: z.string().min(2).max(80).optional(),
});

export async function syntheticRoutes(app: FastifyInstance, gateway: LlmGateway): Promise<void> {
  // ── Persona Simulator (Phase 6, part 2) ──────────────────────────────────
  // A lightweight, SIDE-EFFECT-FREE sibling to /api/synthetic/engagement:
  // generates ONE simulated interview turn for a single persona and returns
  // it directly — nothing is written to the workspace or the tracker. Lets a
  // consultant preview how a role (or an entirely custom persona) might
  // answer before running a real interview, or sanity-check a briefing's
  // hypotheses/roleCatalog, without polluting the client's real engagement
  // data the way a full synthetic engagement generation would.
  app.post(
    "/api/synthetic/persona-preview",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const parsed = PersonaPreviewBody.safeParse(req.body);
      if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      const { clientName, role, personaName, personaBias } = parsed.data;
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      if (!clientAllowed(allowed, clientName)) {
        reply.code(403).send({ error: "client_not_assigned", detail: `You are not assigned to client "${clientName}". Ask a firm owner to assign you.` });
        return;
      }
      const norm = normClient(clientName);

      const ws = await withTenant(ctx.tenantId, async (c) => {
        const r = await c.query<{ key: string; value: { v: string } }>(
          `SELECT key, value FROM module_state WHERE module = 'workspace' AND key = $1`,
          ["vynora_briefing_" + norm]
        );
        return r.rows[0]?.value.v;
      });
      let briefing0: { industry?: string; roleCatalog?: BriefingRole[]; hypotheses?: { text?: string }[] } | null = null;
      try { briefing0 = ws ? JSON.parse(ws) : null; } catch { /* none */ }

      const industry = parsed.data.industry ?? briefing0?.industry ?? "Manufacturing";
      const hypotheses = (briefing0?.hypotheses ?? [])
        .map((h) => (typeof h === "string" ? h : h?.text))
        .filter((t): t is string => Boolean(t))
        .slice(0, 6);

      let persona: Persona;
      if (personaName || personaBias) {
        persona = {
          role: role || personaName || "Custom Persona",
          name: personaName || "Simulated Persona",
          bias: personaBias || "Answers candidly from their functional vantage point.",
        };
      } else if (role) {
        const catalog = briefing0?.roleCatalog ?? [];
        const match = catalog.find((r) => r.value === role || r.display === role);
        const built = personasFromRoles(match ? [match] : [{ value: role, display: role }]);
        persona = (built && built[0]) || { role, name: "Simulated Persona", bias: `Answers strictly from the ${role} vantage point.` };
      } else {
        reply.code(400).send({ error: "invalid_input", detail: "Provide either an existing role or a custom personaName/personaBias." });
        return;
      }

      try {
        // Client cost-recovery billing (v5.27, routes/billing.ts): deliberately
        // NOT attributing this call's cost to `clientName` — a persona preview
        // is sandbox/prep work for the CONSULTANT, not billable client work
        // (see scorecard.html's own "never writes anything... a sandbox, not a
        // substitute for the real interview" copy). It still meters into
        // usage_events under module="persona_simulator" for the firm's own
        // cost awareness — just outside any client's pass-through statement.
        const result = await gateway.generate(
          { tenantId: ctx.tenantId, userId: ctx.userId, module: "persona_simulator" },
          {
            task: "synthetic_interview",
            temperature: 0.7,
            maxTokens: 2000,
            messages: [{
              role: "user",
              content: synthPrompt(persona, clientName, industry, false,
                "This is a STANDALONE preview — no seeded contradictions or blind spots; answer naturally in character.",
                hypotheses),
            }],
          }
        );
        const data = parseJsonLoose(result.text);
        return { persona, industry, ...data };
      } catch (err) {
        if (err instanceof GatewayError && err.detail) {
          req.log.error({ detail: err.detail }, "persona preview: provider error detail");
        }
        reply.code(502).send({ error: (err as Error).message });
        return;
      }
    }
  );

  app.post(
    "/api/synthetic/engagement",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_input" });
        return;
      }
      const { clientName, includeRefresh } = parsed.data;
      // Client scoping: consultants can only generate data for assigned clients.
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      if (!clientAllowed(allowed, clientName)) {
        reply.code(403).send({ error: "client_not_assigned", detail: `You are not assigned to client "${clientName}". Ask a firm owner to assign you.` });
        return;
      }
      const norm = normClient(clientName);

      // ── Anchor on the client's Pre-Engagement setup (if it exists) ────────
      // Roles + priority dimensions + hypotheses + industry all come from the
      // briefing the consultant configured; a pre-existing engagement code is
      // reused so synthetic interviews land in the SAME engagement record.
      const ws = await withTenant(ctx.tenantId, async (c) => {
        const r = await c.query<{ key: string; value: { v: string } }>(
          `SELECT key, value FROM module_state
            WHERE module = 'workspace' AND key IN ($1, 'vynora_engagement_index')`,
          ["vynora_briefing_" + norm]
        );
        const out: Record<string, string> = {};
        for (const row of r.rows) out[row.key] = row.value.v;
        return out;
      });
      let briefing0: { industry?: string; roleCatalog?: BriefingRole[]; hypotheses?: { text?: string }[] } | null = null;
      try { briefing0 = JSON.parse(ws["vynora_briefing_" + norm] ?? "null"); } catch { /* none */ }
      let idx0: Record<string, string> = {};
      try { idx0 = JSON.parse(ws["vynora_engagement_index"] ?? "{}"); } catch { /* none */ }

      const industry = parsed.data.industry ?? briefing0?.industry ?? "Manufacturing";
      const personas = personasFromRoles(briefing0?.roleCatalog ?? []) ?? PERSONAS;
      const seeds = seedsFor(personas);
      const hypotheses = (briefing0?.hypotheses ?? [])
        .map((h) => (typeof h === "string" ? h : h?.text))
        .filter((t): t is string => Boolean(t))
        .slice(0, 6);
      const existingCode = idx0[norm];
      const code = existingCode ?? ((clientName.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4) || "SYNT") + "-SYN1");
      const today = new Date();
      const initialDate = new Date(today.getTime() - (includeRefresh ? 182 : 7) * 86400000)
        .toISOString().slice(0, 10);

      // ── Generate interviews via the gateway ───────────────────────────────
      // Client cost-recovery billing (v5.27): same reasoning as the persona
      // preview above — this generates FAKE test-fixture interviews for QA/
      // demos, so its cost is never attributed to the client's pass-through
      // statement even though the interviews are (deliberately) tagged with
      // the client's name inside the engagement record itself.
      async function generateOne(p: Persona, refresh: boolean): Promise<Record<string, unknown>> {
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await gateway.generate(
            { tenantId: ctx.tenantId, userId: ctx.userId, module: "synthetic_data" },
            {
              task: "synthetic_interview",
              temperature: 0.7,
              maxTokens: 2000,
              messages: [{ role: "user", content: synthPrompt(p, clientName, industry, refresh, seeds, hypotheses) }],
            }
          );
          try {
            const data = parseJsonLoose(result.text);
            if (data.scores && data.findings) return data;
          } catch { /* retry */ }
        }
        throw new Error(`generation failed for ${p.role}${refresh ? " (refresh)" : ""}`);
      }

      // v5.32.4: this used to run each persona's generateOne() sequentially —
      // 5 personas x 2 rounds (default includeRefresh=true) is 10 sequential
      // LLM round trips in a single request. Firebase Hosting imposes a hard
      // 60-second timeout on anything it proxies to Cloud Run (separate from,
      // and shorter than, Cloud Run's own configurable timeout) and returns
      // an HTML 504 page — not JSON — when it's hit. The frontend's
      // interviews.html then fails trying to JSON-parse that HTML
      // ("Unexpected token '<' ... not valid JSON"), which it misreported as
      // a free-tier rate-limit issue since it's a generic catch-all message.
      // Running each round's personas concurrently (they're independent —
      // nothing here depends on another persona's output) cuts wall-clock
      // time by roughly the persona count instead of multiplying it, keeping
      // the whole request comfortably inside the 60s window.
      async function generateRound(
        refresh: boolean
      ): Promise<{ ok: { p: Persona; d: Record<string, unknown> }[]; failures: string[] }> {
        const settled = await Promise.allSettled(personas.map((p) => generateOne(p, refresh).then((d) => ({ p, d }))));
        const ok: { p: Persona; d: Record<string, unknown> }[] = [];
        const failures: string[] = [];
        for (const s of settled) {
          if (s.status === "fulfilled") ok.push(s.value);
          else failures.push((s.reason as Error).message);
        }
        return { ok, failures };
      }

      const interviews: Record<string, unknown>[] = [];
      const trackerRows: { name: string; role: string }[] = [];
      try {
        const initial = await generateRound(false);
        for (const { p, d } of initial.ok) {
          interviews.push({
            role: p.role, name: p.name + " [Synthetic]",
            scores: d.scores, findings: d.findings, summary: d.summary,
            date: initialDate, synthetic: true,
          });
          trackerRows.push({ name: p.name + " [Synthetic]", role: p.role });
        }
        if (initial.failures.length) throw new Error(initial.failures.join(" | "));

        if (includeRefresh) {
          const refresh = await generateRound(true);
          for (const { p, d } of refresh.ok) {
            interviews.push({
              role: p.role, name: p.name + " [Synthetic]",
              scores: d.scores, findings: d.findings, summary: d.summary,
              date: today.toISOString().slice(0, 10), synthetic: true,
              isRefresh: true, refreshRound: 2,
              coverageByDim: { D1: 0.8, D2: 1.0, D3: 0.6, D4: 0.7, D5: 0.8, D6: 1.0, D7: 0.6 },
            });
          }
          if (refresh.failures.length) throw new Error(refresh.failures.join(" | "));
        }
      } catch (err) {
        // V225-audit MEDIUM fix: gateway.generate() throws GatewayError with
        // a client-safe .message now (see gateway.ts) — the raw provider
        // error text, if any, rides on .detail for logs only, never sent.
        if (err instanceof GatewayError && err.detail) {
          req.log.error({ detail: err.detail }, "synthetic engagement: provider error detail");
        }
        reply.code(502).send({ error: (err as Error).message, generated: interviews.length });
        return;
      }

      // ── Compose workspace keys in the exact shapes Synthesis reads ────────
      const engagement = {
        client: clientName, code, industry, revenue: "$1B-$2B",
        createdAt: initialDate, synthetic: true,
        rounds: [{
          roundId: "round-1-synth", roundNumber: 1, date: initialDate,
          label: "Initial Diagnostic", status: "complete", interviews: [], scores: {},
        }],
        currentRoundId: "round-1-synth",
        interviews, // flat: the Synthesis loader distributes + scores these
      };

      const briefing = {
        client: clientName, industry, revenue: "$1B-$2B",
        generatedAt: Date.now(), engagementCode: code, synthetic: true,
        clientProblem: "Leadership believes AI can unlock margin, but initiatives keep stalling after pilots.",
        hypotheses: [
          { index: 0, text: "Data fragmentation across warehouses is the primary blocker to AI scale-up.", status: "open", note: "" },
          { index: 1, text: "AI governance has no clear ownership, creating unmanaged model risk.", status: "open", note: "" },
          { index: 2, text: "Operational processes are less automated than leadership believes.", status: "open", note: "" },
          { index: 3, text: "The organisation lacks AI-literate talent outside the technology function.", status: "open", note: "" },
        ],
      };

      await withTenant(ctx.tenantId, async (c) => {
        const upsert = async (key: string, value: string) => {
          await c.query(
            `INSERT INTO module_state (tenant_id, module, key, value, updated_by)
             VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid, 'workspace', $1, $2, $3)
             ON CONFLICT (tenant_id, module, key)
             DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [key, JSON.stringify({ v: value }), ctx.userId]
          );
        };
        // Merge the engagement index rather than clobbering it.
        const idxRow = await c.query<{ value: { v: string } }>(
          `SELECT value FROM module_state WHERE module = 'workspace' AND key = 'vynora_engagement_index'`
        );
        let idx: Record<string, string> = {};
        try { idx = JSON.parse(idxRow.rows[0]?.value.v ?? "{}"); } catch { /* fresh */ }
        idx[norm] = code;
        await upsert("vynora_engagement_index", JSON.stringify(idx));

        if (existingCode) {
          // A REAL engagement exists (from Pre-Engagement): append the
          // synthetic interviews into it instead of replacing it, so the
          // consultant's rounds/roles/settings survive.
          const engRow = await c.query<{ value: { v: string } }>(
            `SELECT value FROM module_state WHERE module = 'workspace' AND key = $1`,
            ["vynora_engagement_" + existingCode]
          );
          let eng: Record<string, unknown> = {};
          try { eng = JSON.parse(engRow.rows[0]?.value.v ?? "{}"); } catch { /* fresh */ }
          const existingIv = Array.isArray(eng.interviews) ? (eng.interviews as Record<string, unknown>[]) : [];
          // Replace any previous synthetic entries; keep real interviews.
          const realIv = existingIv.filter((iv) => !iv.synthetic);
          eng.interviews = realIv.concat(interviews);
          if (!eng.industry) eng.industry = industry;
          await upsert("vynora_engagement_" + existingCode, JSON.stringify(eng));
        } else {
          await upsert("vynora_engagement_" + code, JSON.stringify(engagement));
        }
        // Never overwrite a real Pre-Engagement briefing — only create the
        // canned one when the client has none yet.
        if (!briefing0) {
          await upsert("vynora_briefing_" + norm, JSON.stringify(briefing));
        }

        // Tracker rows: visible, completed, deletable. Regeneration replaces
        // the previous synthetic rows for this client instead of stacking.
        await c.query(
          `DELETE FROM interviews WHERE client_name = $1 AND interviewee_name LIKE '%[Synthetic]'`,
          [clientName]
        );
        let seq = 0;
        for (const t of trackerRows) {
          const slug = t.role.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "role";
          await c.query(
            `INSERT INTO interviews
               (tenant_id, client_name, interviewee_name, interviewee_role,
                status, state_module, created_by, started_at, completed_at)
             VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                     $1, $2, $3, 'completed', $4, $5, now(), now())`,
            [clientName, t.name, t.role, "iv_synth_" + code.toLowerCase().replace(/[^a-z0-9]/g, "") + "_" + slug + "_" + seq++, ctx.userId]
          );
        }
      });

      return {
        ok: true, code, clientName,
        interviews: interviews.length,
        rounds: includeRefresh ? 2 : 1,
        next: `Open the Synthesis Dashboard, enter "${clientName}", and click Load Engagement.`,
      };
    }
  );
}
