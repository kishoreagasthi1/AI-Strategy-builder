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
import { allowedClientNorms, clientAllowed, normClient } from "../auth/clients.js";
import { overallOf as canonicalOverallOf, sortRounds, type ScoringInterview } from "../tenant/scoring.js";

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

/* v5.32.59 (F6). This had its own mean, and it counted a stored 0 as a score
 * of zero while every other module in the product treats 0 as "no evidence for
 * this dimension". A legacy record with a zeroed dimension therefore read a
 * whole maturity band lower on the portfolio scorecard than on the dashboard
 * showing the same engagement. Delegated to the canonical implementation. */
export function overallOf(scores: Record<string, number> | null | undefined): number | null {
  return canonicalOverallOf(scores);
}

interface EngagementRoundLite {
  roundNumber: number;
  label?: string;
  date?: string;
  scores?: Record<string, number>;
  interviews?: ScoringInterview[];
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
    /* v5.32.59 (F23/F21). Two problems, both of which put the wrong number on
     * a portfolio card.
     *
     * The sort was `a.roundNumber - b.roundNumber` on a field older records do
     * not have; NaN makes the comparator inconsistent, and V8's sort is free
     * to return any order for that — so for legacy engagements "latest" was
     * effectively arbitrary. sortRounds keeps unnumbered rounds in creation
     * order instead.
     *
     * And "latest" was the last round FULL STOP. A round is created empty the
     * moment a consultant plans it, so planning round 3 replaced the client's
     * portfolio card with a row of blanks and a null maturity band — the
     * engagement looked unassessed the day after it was assessed. The card
     * shows the latest round that was actually SCORED, and the delta compares
     * it against the scored round before that (not merely the previous array
     * element, which could itself be an empty planned round and would have
     * produced a delta against nothing). */
    const rounds = sortRounds(eng.rounds ?? []);
    if (!rounds.length) continue;
    const scored = rounds.filter((r) => r.scores && Object.keys(r.scores).length);
    if (!scored.length) continue;
    const latest = scored[scored.length - 1];
    const prior = scored.length > 1 ? scored[scored.length - 2] : null;
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
          if (!clientAllowed(allowed, eng.client)) continue;
          engagements.push(eng);
        } catch { /* skip malformed */ }
      }
      return buildScorecard(engagements);
    });
    return { engagements: entries, dimensionNames: DIMENSION_NAMES };
  });
}
