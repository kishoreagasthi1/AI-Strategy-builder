/**
 * Scorecard (Phase 6, part 1) — a firm-wide maturity view.
 *
 * Every individual engagement already has a scorecard (the Scorecard tab
 * inside interview_agent.html, and the Synthesis Dashboard) — but nothing
 * before this showed a consultant or owner all their engagements' scores
 * side by side. GET /api/scorecard aggregates every workspace engagement
 * record (vynora_engagement_<code>) the caller is allowed to see into one
 * portfolio list: latest-round dimension scores, overall score, maturity
 * band, and the delta vs the previous round (so movement — not just a
 * snapshot — is visible at a glance).
 *
 * Client scoping matches every other module: owners see everything,
 * consultants only the clients they're assigned to (client_assignments).
 */
import type { FastifyInstance } from "fastify";
import { withTenant } from "../db/pool.js";
import { allowedClientNorms, normClient } from "../auth/clients.js";

const DIMS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"] as const;

export const DIMENSION_NAMES: Record<string, string> = {
  D1: "Data & Data Management",
  D2: "Technology & Infrastructure",
  D3: "AI Strategy & Vision",
  D4: "People & Skills",
  D5: "Process & Operations",
  D6: "Governance & Risk",
  D7: "Culture & Change Readiness",
};

/** Same bands as interview_agent.html's MATURITY table. */
const MATURITY = [
  { min: 4.5, label: "AI-Native" },
  { min: 3.5, label: "AI-Led" },
  { min: 2.5, label: "AI Capable" },
  { min: 1.5, label: "AI Exploring" },
  { min: 0, label: "AI Unaware" },
];

export function maturityLabel(overall: number | null): string | null {
  if (overall == null) return null;
  return (MATURITY.find((m) => overall >= m.min) ?? MATURITY[MATURITY.length - 1]).label;
}

export function overallOf(scores: Record<string, number> | undefined): number | null {
  if (!scores) return null;
  const vals = DIMS.map((d) => scores[d]).filter((v): v is number => typeof v === "number");
  if (!vals.length) return null;
  return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
}

interface EngagementRoundLite {
  roundNumber: number;
  label?: string;
  date?: string;
  scores?: Record<string, number>;
  interviews?: unknown[];
}
interface EngagementLite {
  code: string;
  client: string;
  industry?: string;
  rounds?: EngagementRoundLite[];
}

export interface ScorecardEntry {
  code: string;
  client: string;
  industry: string | null;
  roundNumber: number | null;
  roundLabel: string | null;
  roundDate: string | null;
  interviewCount: number;
  scores: Record<string, number>;
  overall: number | null;
  maturity: string | null;
  deltaOverall: number | null;
  deltaScores: Record<string, number>;
}

/** Pure aggregation — testable without the DB. */
export function buildScorecard(
  engagements: EngagementLite[]
): ScorecardEntry[] {
  const out: ScorecardEntry[] = [];
  for (const eng of engagements) {
    const rounds = (eng.rounds ?? []).slice().sort((a, b) => a.roundNumber - b.roundNumber);
    if (!rounds.length) continue;
    const latest = rounds[rounds.length - 1];
    const prior = rounds.length > 1 ? rounds[rounds.length - 2] : null;
    const overall = overallOf(latest.scores);
    const priorOverall = prior ? overallOf(prior.scores) : null;
    const deltaScores: Record<string, number> = {};
    if (prior) {
      for (const d of DIMS) {
        const a = latest.scores?.[d];
        const b = prior.scores?.[d];
        if (typeof a === "number" && typeof b === "number") {
          deltaScores[d] = Math.round((a - b) * 10) / 10;
        }
      }
    }
    out.push({
      code: eng.code,
      client: eng.client,
      industry: eng.industry ?? null,
      roundNumber: latest.roundNumber ?? null,
      roundLabel: latest.label ?? null,
      roundDate: latest.date ?? null,
      interviewCount: latest.interviews?.length ?? 0,
      scores: latest.scores ?? {},
      overall,
      maturity: maturityLabel(overall),
      deltaOverall:
        overall != null && priorOverall != null ? Math.round((overall - priorOverall) * 10) / 10 : null,
      deltaScores,
    });
  }
  out.sort((a, b) => a.client.localeCompare(b.client));
  return out;
}

export async function scorecardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/scorecard", async (req, reply) => {
    const ctx = req.ctx!;
    if (ctx.role === "interviewee") { reply.code(403).send({ error: "forbidden" }); return; }
    const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
    const entries = await withTenant(ctx.tenantId, async (c) => {
      const r = await c.query<{ key: string; value: { v: string } }>(
        `SELECT key, value FROM module_state
          WHERE module = 'workspace' AND key LIKE 'vynora_engagement_%' AND key <> 'vynora_engagement_index'`
      );
      const engagements: EngagementLite[] = [];
      for (const row of r.rows) {
        try {
          const eng = JSON.parse(row.value.v) as EngagementLite;
          if (!eng.client || !eng.code) continue;
          if (allowed !== null && !allowed.has(normClient(eng.client))) continue;
          engagements.push(eng);
        } catch { /* skip malformed */ }
      }
      return buildScorecard(engagements);
    });
    return { engagements: entries, dimensionNames: DIMENSION_NAMES };
  });
}
