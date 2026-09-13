/**
 * Client → engagement resolution, and the diagnostic evidence for one client.
 *
 * v5.32.21. Written because the Solution Design Studio's build/buy/partner
 * generator was producing confident, specific, entirely invented claims about
 * a client's current state — naming their SCM and their requirements tool,
 * asserting how they test today — from a prompt whose only real inputs were a
 * company name and an industry label. The diagnostic data that would have
 * grounded it was already in the store, one key away, and unused.
 *
 * Two things live here:
 *
 *   resolveEngagementCode() — the client-name → engagement-code lookup that
 *   was previously inlined in three routes (interviews.ts twice, synthetic.ts).
 *   It reads vynora_engagement_index, then falls back to scanning the
 *   vynora_engagement_* records and matching on normalised client name,
 *   because the index goes stale after imports and renames often enough that
 *   synthesis.html carries its own repair code for exactly this.
 *
 *   loadClientEvidence() — everything factually known about a client,
 *   assembled from the engagement record, the pre-engagement briefing, and
 *   (when it exists) the synthesis output.
 *
 * EVERY field is optional by design. A client with no completed interviews has
 * no scores and no findings, and that is a normal state, not an error — the
 * caller is expected to degrade rather than fail, and to tell the model what
 * it does NOT know so it can mark its own guesses.
 */
import { withTenant } from "../db/pool.js";
import { normClient } from "../auth/clients.js";
import { DIMENSION_NAMES, overallOf, maturityLabel } from "../routes/scorecard.js";
import { corroborateFindings, findingsOf, type RawFinding } from "./findings.js";
import { latestScoredRound } from "./scoring.js";

interface RawInterview {
  role?: string;
  interviewee?: string;
  scores?: Record<string, number>;
  findings?: { dimension: string; text: string }[];
  interviewDate?: string;
}
interface RawRound {
  roundNumber?: number;
  label?: string;
  date?: string;
  scores?: Record<string, number>;
  benchmarks?: Record<string, { avg?: number; best?: number; laggard?: number }>;
  interviews?: RawInterview[];
}
interface RawEngagement {
  code?: string;
  client?: string;
  clientName?: string;
  industry?: string;
  revenue?: string;
  clientProblem?: string;
  peContext?: string;
  rounds?: RawRound[];
}

/** A finding corroborated by two or more distinct roles — same CLAIM, not
 *  merely the same dimension (F13). */
export interface ConfirmedFinding {
  dimension: string;
  dimensionName: string;
  roles: string[];
  texts: string[];
}

/** Several roles raised this dimension, on different points. NOT agreement. */
export interface ThematicFinding {
  dimension: string;
  dimensionName: string;
  roles: string[];
  texts: string[];
}

export interface ClientEvidence {
  code: string | null;
  /** True when there is at least ONE real datum below. Drives "is any of this grounded?" */
  hasAny: boolean;
  industry?: string;
  revenue?: string;
  clientProblem?: string;
  peContext?: string;
  scores?: Record<string, number>;
  overall?: number;
  maturity?: string;
  benchmarks?: Record<string, { avg?: number; best?: number; laggard?: number }>;
  rolesInterviewed: string[];
  interviewCount: number;
  confirmedFindings: ConfirmedFinding[];
  /** Dimensions several roles engaged with on different points (F13). */
  thematicFindings: ThematicFinding[];
  /** Present only when a synthesis has been run AND returned parseable JSON. */
  criticalGaps: { dimension?: string; observation?: string; rootCause?: string; vsIndustry?: string }[];
  strengths: { dimension?: string; observation?: string; vsIndustry?: string }[];
  blindSpots: { topic?: string; whyItMatters?: string }[];
  overallPattern?: string;
  hasSynthesis: boolean;
}

function emptyEvidence(): ClientEvidence {
  return {
    code: null, hasAny: false, rolesInterviewed: [], interviewCount: 0,
    confirmedFindings: [], thematicFindings: [], criticalGaps: [], strengths: [], blindSpots: [], hasSynthesis: false,
  };
}

function parseStoredValue<T>(raw: { v: string } | undefined): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw.v) as T; } catch { return null; }
}

/**
 * Resolve a client's engagement code. Index first, then a scan-and-heal pass
 * over the engagement records themselves — the index is a convenience map, the
 * records are the authority.
 */
export async function resolveEngagementCode(tenantId: string, clientName: string): Promise<string | null> {
  const norm = normClient(clientName);
  return withTenant(tenantId, async (c) => {
    const idxRow = await c.query<{ value: { v: string } }>(
      `SELECT value FROM module_state WHERE module = 'workspace' AND key = 'vynora_engagement_index'`
    );
    const idx = parseStoredValue<Record<string, string>>(idxRow.rows[0]?.value) ?? {};
    const fromIndex = idx[norm];
    if (fromIndex) {
      const exists = await c.query<{ n: string }>(
        `SELECT '1' AS n FROM module_state WHERE module = 'workspace' AND key = $1`,
        ["vynora_engagement_" + fromIndex]
      );
      if (exists.rows[0]) return fromIndex;
    }
    // Stale or missing index entry: find the record whose client name matches.
    const scan = await c.query<{ key: string; value: { v: string } }>(
      `SELECT key, value FROM module_state
        WHERE module = 'workspace'
          AND key LIKE 'vynora_engagement_%'
          AND key <> 'vynora_engagement_index'`
    );
    for (const row of scan.rows) {
      const eng = parseStoredValue<RawEngagement>(row.value);
      if (!eng) continue;
      const name = eng.client ?? eng.clientName ?? "";
      if (name && normClient(name) === norm) return eng.code ?? row.key.replace("vynora_engagement_", "");
    }
    return null;
  });
}

/**
 * v5.32.59 (F13). This used to promote a DIMENSION the moment two different
 * roles had said anything about it, and hand the result to the model under the
 * heading "these are ESTABLISHED FACT about this client".
 *
 * So a CFO's "we cannot get a straight answer on data lineage" and a CHRO's
 * "nobody trusts the reporting team" — two unrelated observations that share a
 * category — became one corroborated finding with two named sources. The
 * client document generator then wrote it up as agreed fact, and "your CFO and
 * CHRO both told us X" is a sentence a client repeats to their board.
 *
 * Corroboration now means two roles made substantially the SAME point, decided
 * by tenant/findings.ts (shared with the browser, parity-tested). Findings that
 * share a dimension but not a claim are still returned — separately, as
 * thematic — so the signal survives without the assertion.
 *
 * Still deliberately not weakened to a single role: one person's account of how
 * something works is exactly the claim this whole path exists to stop
 * presenting as fact, however many times they repeat it.
 */
export function deriveConfirmedFindings(rounds: RawRound[]): ConfirmedFinding[] {
  const all: RawFinding[] = [];
  rounds.forEach((r) => { all.push(...findingsOf((r.interviews ?? []) as never)); });
  return corroborateFindings(all).corroborated.map((c) => ({
    dimension: c.dimension,
    dimensionName: DIMENSION_NAMES[c.dimension] ?? c.dimension,
    roles: c.roles,
    // Cap lives in findings.ts: this rides into a prompt with a finite budget,
    // and the point is corroboration, not a transcript.
    texts: c.texts,
  }));
}

/**
 * Dimensions several roles engaged with on DIFFERENT points. Real signal — it
 * is where the room's attention is — but not agreement, and the prompt labels
 * it accordingly.
 */
export function deriveThematicFindings(rounds: RawRound[]): ThematicFinding[] {
  const all: RawFinding[] = [];
  rounds.forEach((r) => { all.push(...findingsOf((r.interviews ?? []) as never)); });
  return corroborateFindings(all).thematic.map((t) => ({
    dimension: t.dimension,
    dimensionName: DIMENSION_NAMES[t.dimension] ?? t.dimension,
    roles: t.roles,
    texts: t.clusters.map((c) => c.text).slice(0, 4),
  }));
}

export async function loadClientEvidence(tenantId: string, clientName: string): Promise<ClientEvidence> {
  const ev = emptyEvidence();
  const norm = normClient(clientName);
  let code: string | null = null;
  try {
    code = await resolveEngagementCode(tenantId, clientName);
  } catch {
    return ev;
  }
  ev.code = code;

  try {
    await withTenant(tenantId, async (c) => {
      const keys = ["vynora_briefing_" + norm];
      if (code) keys.push("vynora_engagement_" + code, "vynora_synthesis_full_" + code);
      const rows = await c.query<{ key: string; value: { v: string } }>(
        `SELECT key, value FROM module_state WHERE module = 'workspace' AND key = ANY($1::text[])`,
        [keys]
      );
      const byKey = new Map(rows.rows.map((r) => [r.key, r.value]));

      // ── Briefing: the client's own words about why we're here ────────────
      const briefing = parseStoredValue<Record<string, unknown>>(byKey.get("vynora_briefing_" + norm));
      if (briefing) {
        const s = (k: string) => (typeof briefing[k] === "string" ? (briefing[k] as string).trim() : "");
        // Prefer the AI summary of an over-long field, same as the interview agent does.
        ev.clientProblem = s("clientProblemSummary") || s("clientProblem") || undefined;
        ev.peContext = s("peContextSummary") || s("peContext") || undefined;
        ev.industry = s("industry") || undefined;
        ev.revenue = s("revenue") || undefined;
      }

      // ── Engagement: scores, benchmarks, who was interviewed, findings ────
      const eng = code ? parseStoredValue<RawEngagement>(byKey.get("vynora_engagement_" + code)) : null;
      if (eng) {
        ev.industry = ev.industry || eng.industry || undefined;
        ev.revenue = ev.revenue || eng.revenue || undefined;
        ev.clientProblem = ev.clientProblem || eng.clientProblem || undefined;
        ev.peContext = ev.peContext || eng.peContext || undefined;

        const rounds = eng.rounds ?? [];
        /* Latest round that actually has scores — a round is created empty at
         * briefing time, so the last one is often not the scored one.
         *
         * v5.32.59 (F23): this walked the array BACKWARDS BY INDEX, and array
         * order is the order interviews completed, not round order. Since
         * v5.32.55 a consultant can pin round 3 before round 2 completes, so
         * [1, 3, 2] is a real array — and this returned round 2's scores while
         * /api/scorecard, which sorted by number, showed round 3's for the same
         * client. Both now go through latestScoredRound(). */
        const scoredRound = latestScoredRound(rounds as never);
        if (scoredRound) {
          ev.scores = scoredRound.scores as Record<string, number>;
          ev.benchmarks = (scoredRound as unknown as RawRound).benchmarks;
        }
        if (ev.scores) {
          const o = overallOf(ev.scores);
          if (o !== null) { ev.overall = o; ev.maturity = maturityLabel(o) ?? undefined; }
        }
        // v5.32.25: this summed interviews across EVERY round, so five
        // executives interviewed over three rounds were reported to the model as
        // "Diagnostic basis: 15 interview(s)" — and it calibrates its confidence
        // language to that number. /api/scorecard counts the latest round only;
        // match it, and count distinct PEOPLE rather than sittings.
        const roles = new Set<string>();
        const people = new Set<string>();
        rounds.forEach((r) => (r.interviews ?? []).forEach((iv) => {
          if (iv.role) roles.add(iv.role);
          people.add(String(iv.interviewee || iv.role || "").trim().toLowerCase() || String(people.size));
        }));
        ev.rolesInterviewed = [...roles];
        ev.interviewCount = people.size;
        ev.confirmedFindings = deriveConfirmedFindings(rounds);
        ev.thematicFindings = deriveThematicFindings(rounds);
      }

      // ── Synthesis: present only if it was run and returned clean JSON ────
      const full = code
        ? parseStoredValue<{ synthesis?: Record<string, unknown> }>(byKey.get("vynora_synthesis_full_" + code))
        : null;
      const syn = full?.synthesis;
      if (syn) {
        ev.hasSynthesis = true;
        const fp = syn.maturityFingerprint as
          | { strengths?: unknown[]; criticalGaps?: unknown[]; overallPattern?: string }
          | undefined;
        if (fp) {
          ev.criticalGaps = Array.isArray(fp.criticalGaps) ? (fp.criticalGaps as ClientEvidence["criticalGaps"]).slice(0, 6) : [];
          ev.strengths = Array.isArray(fp.strengths) ? (fp.strengths as ClientEvidence["strengths"]).slice(0, 4) : [];
          ev.overallPattern = typeof fp.overallPattern === "string" ? fp.overallPattern : undefined;
        }
        if (Array.isArray(syn.blindSpots)) {
          ev.blindSpots = (syn.blindSpots as ClientEvidence["blindSpots"]).slice(0, 4);
        }
      }
    });
  } catch {
    // A read failure must not take down generation — it degrades to "no
    // evidence", which the prompt already knows how to handle honestly.
    return ev;
  }

  // v5.32.25: clientProblem and peContext used to count as evidence, so a client
  // with zero interviews, zero scores and zero synthesis — but one sentence typed
  // into the pre-engagement form — skipped the "assumed" backstop entirely. The
  // model then self-reported currentStateBasis:"evidenced" and every plan row
  // kept assumed:false, and the document rendered as grounded research. Those two
  // fields are the client's own framing of the problem; they are useful CONTEXT
  // but they establish nothing about how the client works today, which is the
  // claim the backstop exists to police.
  ev.hasAny = Boolean(
    ev.scores || ev.confirmedFindings.length || ev.thematicFindings.length || ev.criticalGaps.length || ev.strengths.length
  );
  return ev;
}

/**
 * Render the evidence as the prompt's EVIDENCE block. Returns null when there
 * is nothing real to show, so the caller can say so explicitly instead of
 * emitting an empty heading that reads like an absence of problems.
 */
export function formatEvidenceForPrompt(ev: ClientEvidence): string | null {
  if (!ev.hasAny) return null;
  const L: string[] = [];
  if (ev.clientProblem) L.push(`Client's stated problem: ${ev.clientProblem}`);
  if (ev.peContext) L.push(`PE / value-creation context: ${ev.peContext}`);
  if (ev.revenue) L.push(`Revenue band: ${ev.revenue}`);
  if (ev.scores) {
    const parts = Object.keys(ev.scores).sort().map((d) => {
      const b = ev.benchmarks?.[d];
      const vs = b && typeof b.avg === "number" ? ` (sector avg ${b.avg})` : "";
      return `${d} ${DIMENSION_NAMES[d] ?? d}: ${ev.scores![d]}/5${vs}`;
    });
    L.push(`Measured AI-readiness scores${ev.maturity ? ` — overall ${ev.overall} (${ev.maturity})` : ""}:\n  ${parts.join("\n  ")}`);
  }
  if (ev.interviewCount) {
    L.push(`Diagnostic basis: ${ev.interviewCount} interview(s) across ${ev.rolesInterviewed.length} role(s): ${ev.rolesInterviewed.join(", ")}`);
  }
  if (ev.confirmedFindings.length) {
    /* v5.32.59 (F13). The heading is unchanged in strength but is now TRUE:
     * until this release "2+ roles" meant two roles had mentioned the same
     * DIMENSION, and the model was told that constituted established fact. It
     * duly wrote it up that way, naming both executives. */
    L.push(
      "Corroborated findings (the SAME point made independently by 2+ roles — these are ESTABLISHED FACT about this client):\n  " +
        ev.confirmedFindings
          .map((f) => `${f.dimension} ${f.dimensionName} [${f.roles.join(", ")}]: ${f.texts.join(" / ")}`)
          .join("\n  ")
    );
  }
  if (ev.thematicFindings.length) {
    /* Kept separate and labelled rather than dropped. Several executives
     * choosing to raise the same area IS signal — it is just not agreement,
     * and the model must not be free to upgrade it into agreement. */
    L.push(
      "Areas raised by multiple roles on DIFFERENT points (attention, NOT agreement — do not present these as corroborated or as consensus):\n  " +
        ev.thematicFindings
          .map((f) => `${f.dimension} ${f.dimensionName} [${f.roles.join(", ")}]: ${f.texts.join(" / ")}`)
          .join("\n  ")
    );
  }
  if (ev.criticalGaps.length) {
    L.push(
      "Critical gaps identified in synthesis:\n  " +
        ev.criticalGaps
          .map((g) => `${g.dimension ?? "?"}: ${g.observation ?? ""}${g.rootCause ? ` — root cause: ${g.rootCause}` : ""}`)
          .join("\n  ")
    );
  }
  if (ev.strengths.length) {
    L.push(
      "Strengths to build on:\n  " +
        ev.strengths.map((s) => `${s.dimension ?? "?"}: ${s.observation ?? ""}`).join("\n  ")
    );
  }
  if (ev.overallPattern) L.push(`Overall pattern: ${ev.overallPattern}`);
  if (ev.blindSpots.length) {
    L.push("Blind spots: " + ev.blindSpots.map((b) => b.topic ?? "").filter(Boolean).join("; "));
  }
  return L.join("\n");
}
