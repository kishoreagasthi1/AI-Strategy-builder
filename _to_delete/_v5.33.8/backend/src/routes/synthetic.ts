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
import { GatewayError, type LlmGateway, redactProviderDetail } from "../llm/gateway.js";
import { computeRoundScores } from "../tenant/scoring.js";
import { roleWeight } from "../tenant/engagementMerge.js";
import { corroborateFindings, findingsOf } from "../tenant/findings.js";

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

/** One persona's round-N output, as far as the seeding of round N+1 cares. */
export interface RoundResult {
  persona: { name: string; role: string };
  scores: Record<string, number>;
  findings: { dimension: string; text: string }[];
}

const DIM_KEYS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"] as const;

/**
 * Round N's seeds, built from round N−1's ACTUAL findings (v5.32.83).
 *
 * ── Read this before changing it. ──
 *
 * docs/CHUNKED_SYNTHETIC_SPEC.md states that round 2 "already" draws its seeds
 * from the prior round's findings, calls that "the existing round mechanism",
 * and instructs the implementer to preserve it rather than invent it. That was
 * not true of the code it describes. Until this version `seeds` was
 * `seedsFor(personas)` — a pure function of the persona LIST, computed once and
 * passed to every call in both rounds. The only thing distinguishing a refresh
 * round was the `refresh` boolean flipping one paragraph of the prompt.
 *
 * The consequence was invisible in a way worth naming: a round-2 interview was
 * generated from the same seeded contradictions as round 1, so it read as a
 * re-run of the initial diagnostic with a "six months later" sentence on top,
 * and nothing in it could reference what the first round actually surfaced.
 * The spec's most emphasised constraint — that rounds must generate in order —
 * was a real requirement resting on a mechanism that did not exist, so it was
 * being satisfied by accident.
 *
 * This function is that mechanism. It takes what round N−1 genuinely produced
 * and turns it into follow-on material: the contradictions that actually
 * emerged (rather than the ones we asked for), the dimensions that actually
 * scored lowest, and a sample of real findings attributed to the roles that
 * gave them. The ordering constraint is now load-bearing: pass an empty prior
 * round and you get round 1's static seeds back, which is the honest answer,
 * not a silent half-measure.
 */
export function seedsFromPriorRound(prior: RoundResult[], personas: Persona[], priorRoundNumber: number): string {
  const usable = prior.filter((r) => r?.persona?.role && r.scores);
  if (!usable.length) return seedsFor(personas);

  // Contradictions that actually emerged: same dimension, two roles far apart.
  const contradictions: string[] = [];
  const weak: { dim: string; avg: number }[] = [];
  for (const dim of DIM_KEYS) {
    const pts = usable
      .map((r) => ({ role: r.persona.role, v: Number(r.scores[dim]) }))
      .filter((x) => Number.isFinite(x.v) && x.v > 0);
    if (!pts.length) continue;
    weak.push({ dim, avg: pts.reduce((s, x) => s + x.v, 0) / pts.length });
    if (pts.length < 2) continue;
    const hi = pts.reduce((a, x) => (x.v > a.v ? x : a));
    const lo = pts.reduce((a, x) => (x.v < a.v ? x : a));
    if (hi.v - lo.v >= 1.0) {
      contradictions.push(
        `- ${dim}: the ${hi.role} scored this ${hi.v.toFixed(1)} in round ${priorRoundNumber} while the ${lo.role} scored it ${lo.v.toFixed(1)}. That disagreement is unresolved; it should still be audible, even if narrowed.`
      );
    }
  }
  contradictions.sort();
  weak.sort((a, b) => a.avg - b.avg);

  // Real findings, attributed, capped so the prompt stays a prompt.
  const quoted: string[] = [];
  for (const r of usable) {
    for (const f of (r.findings ?? []).slice(0, 2)) {
      if (!f?.text) continue;
      quoted.push(`- The ${r.persona.role} said, in round ${priorRoundNumber}: "${String(f.text).slice(0, 240)}" (${f.dimension})`);
    }
  }

  return `What the round-${priorRoundNumber} interviews ACTUALLY established (this is the ground truth this round follows on from — reference it as things already on the record, do not restate it as new discovery):
${quoted.slice(0, 12).join("\n") || "- (round " + priorRoundNumber + " produced no attributable findings)"}

Disagreements carried forward from round ${priorRoundNumber}:
${contradictions.slice(0, 4).join("\n") || "- None material: the round was broadly consistent, which is itself worth a remark."}

Weakest dimensions in round ${priorRoundNumber}: ${weak.slice(0, 3).map((w) => `${w.dim} (${w.avg.toFixed(1)} avg)`).join(", ")}.
Movement since then should be PARTIAL and specific — name what changed and what conspicuously did not.`;
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
 "summary":"2-3 sentence interview summary in a consultant's voice",
 "transcript":[{"who":"Interviewer","text":"question the interviewer asked"},{"who":"Interviewee","text":"this persona's answer, in their own voice"}],
 "scoreEvents":[{"dimension":"D1","from":null,"to":2.5,"afterTurn":4}]}
Provide 6-9 findings spread across dimensions (always include at least one D6 finding reflecting the ${refresh ? "new governance council" : "governance blind spot"}).

The scoreEvents array is the SCORE TRAIL: where in this conversation each dimension's reading became clear. One entry per dimension you scored, in the order the conversation establishes them, with afterTurn being the 1-based index of the transcript turn after which you could first justify that number, and from set to null for a first reading (or to the previous value if your view of a dimension moved during the conversation). This is what lets a consultant answer "why is D6 a 1.5?" by pointing at the turn rather than re-reading the whole interview.

The transcript is the conversation those findings and scores CAME FROM, so it has to be consistent with them: 12-16 turns, strictly alternating Interviewer/Interviewee and starting with the Interviewer, with every finding above traceable to something this persona actually says. Where a score is low, the interviewee's own words should show why. Keep them in character (the bias above) — hedging, deflecting or over-claiming where that persona would.`;
}

/**
 * Build the synthesis the dashboard would have produced, WITHOUT an LLM call.
 *
 * v5.32.60. A synthetic engagement previously stopped at raw interviews, so
 * every downstream module that reads a persisted synthesis — the Synthesis
 * box on reload, the strategy deck, the roadmap's full-synthesis loader — had
 * nothing to show until the consultant spent a real ~90s AI call. That made
 * the generator useless for rehearsing exactly the parts of the product that
 * come AFTER interviewing.
 *
 * Derived, not invented: contradictions come from real score spreads across
 * the generated interviews, the fingerprint from the canonical weighted
 * scores, and hypothesis verdicts from whether findings actually landed on
 * the dimension each hypothesis is about. It is marked synthetic so nobody
 * mistakes it for a real reading.
 */
function buildSynthesis(
  interviews: Record<string, unknown>[],
  hypotheses: { text: string }[],
  roleWeightFn: (dim: string, role: string | undefined) => number
): Record<string, unknown> {
  const DIM_NAMES: Record<string, string> = {
    D1: "Data & Data Management", D2: "Technology & Infrastructure",
    D3: "AI Strategy & Vision", D4: "People & Skills",
    D5: "Process & Operations", D6: "Governance & Risk",
    D7: "Culture & Change Readiness",
  };
  const latest = interviews.filter((i) => !i.isRefresh).length
    ? interviews.filter((i) => (interviews.some((x) => x.isRefresh) ? i.isRefresh : !i.isRefresh))
    : interviews;
  const { scores } = computeRoundScores(latest as never, { roleWeight: roleWeightFn });

  // Contradictions: the same dimension read very differently by two roles.
  const spreads: { dim: string; hi: { role: string; v: number }; lo: { role: string; v: number }; spread: number }[] = [];
  for (const d of Object.keys(DIM_NAMES)) {
    const pts = latest
      .map((i) => ({ role: String(i.role ?? ""), v: Number((i.scores as Record<string, number>)?.[d]) }))
      .filter((x) => x.role && isFinite(x.v) && x.v > 0);
    if (pts.length < 2) continue;
    const hi = pts.reduce((a, x) => (x.v > a.v ? x : a));
    const lo = pts.reduce((a, x) => (x.v < a.v ? x : a));
    const spread = Math.round((hi.v - lo.v) * 10) / 10;
    if (spread >= 1.0) spreads.push({ dim: d, hi, lo, spread });
  }
  spreads.sort((a, b) => b.spread - a.spread);

  const ranked = Object.keys(scores).sort((a, b) => scores[a] - scores[b]);
  const weakest = ranked.slice(0, 3);
  const strongest = ranked.slice(-2).reverse();

  const allFindings = corroborateFindings(
    // v5.32.86: the person goes through too. This map dropped it, so a
    // synthetic engagement with two people in one role could never produce a
    // corroborated finding — the generator's own contradictions rely on
    // distinct sources, and the synthesis it persists is what every downstream
    // screen reads.
    findingsOf(latest.map((i) => ({
      role: String(i.role ?? ""),
      interviewee: String(i.interviewee ?? i.name ?? ""),
      findings: i.findings as never,
    })))
  );

  const verdictFor = (text: string): { verdict: string; evidence: string } => {
    const t = text.toLowerCase();
    const dim = t.includes("data") || t.includes("warehouse") ? "D1"
      : t.includes("governance") || t.includes("risk") ? "D6"
      : t.includes("process") || t.includes("automat") ? "D5"
      : t.includes("talent") || t.includes("skill") || t.includes("literate") ? "D4" : "D3";
    const sc = scores[dim];
    const support = allFindings.corroborated.filter((c) => c.dimension === dim);
    if (support.length) {
      return {
        verdict: "confirmed",
        evidence: `${support[0].roles.join(" and ")} independently described the same condition on ${DIM_NAMES[dim]}: "${support[0].text}"${sc != null ? ` (round score ${sc}/5)` : ""}.`,
      };
    }
    const thematic = allFindings.thematic.filter((c) => c.dimension === dim);
    if (thematic.length) {
      return {
        verdict: "unresolved",
        evidence: `${thematic[0].roles.join(", ")} all raised ${DIM_NAMES[dim]}, but on different points — attention without agreement, which is not yet evidence either way.`,
      };
    }
    return { verdict: "unresolved", evidence: `No interview in this round produced attributable evidence on ${DIM_NAMES[dim]}.` };
  };

  return {
    synthetic: true,
    hypothesisVerdict: hypotheses.slice(0, 4).map((h) => ({ hypothesis: h.text, ...verdictFor(h.text) })),
    blindSpots: [
      {
        topic: "Nobody owns AI governance end to end",
        whyItMatters: "Model risk, data residency and vendor exposure are each somebody's partial responsibility and nobody's whole one, so the first real incident has no established owner.",
        whoShouldAddress: "General Counsel with the CDO — the gap is authority, not awareness.",
      },
      {
        topic: "Reskilling has no budget line",
        whyItMatters: "Every plan assumes the workforce adapts, and no plan funds it. The capability gap widens quietly while the technology programme reports green.",
        whoShouldAddress: "CHRO and CFO together, before the next planning cycle.",
      },
    ],
    maturityFingerprint: {
      overallPattern: spreads.length
        ? `Capability is uneven rather than uniformly low, and the leadership team does not yet share one picture of it — ${DIM_NAMES[spreads[0].dim]} alone spans ${spreads[0].spread} points between the ${spreads[0].hi.role} and the ${spreads[0].lo.role}. The binding constraint is agreement about the current state, not ambition.`
        : "Capability is broadly consistent across dimensions, with no single function far ahead or behind.",
      strengths: strongest.map((d) => ({
        dimension: d,
        observation: `${DIM_NAMES[d]} is the firmest ground in this assessment at ${scores[d]}/5 — the place a first initiative can stand without needing something else fixed first.`,
        vsIndustry: "at or near sector median",
      })),
      criticalGaps: weakest.map((d) => ({
        dimension: d,
        observation: `${DIM_NAMES[d]} scores ${scores[d]}/5.`,
        rootCause: spreads.find((sp) => sp.dim === d)
          ? `Contested rather than simply weak: the ${spreads.find((sp) => sp.dim === d)!.hi.role} reads it ${spreads.find((sp) => sp.dim === d)!.spread} points higher than the ${spreads.find((sp) => sp.dim === d)!.lo.role}, so remediation has no agreed starting point.`
          : "Consistently reported as weak across roles — an execution gap rather than a disagreement.",
        vsIndustry: "below sector median",
      })),
    },
    sequencedRecommendations: [
      { priority: 1, horizon: "0-90 days", title: "Establish a single source of truth for the metrics AI will act on",
        rationale: "Every downstream initiative inherits the data layer's ambiguity. Narrow this to the handful of measures decisions actually turn on rather than attempting a full consolidation.",
        owner: "CDO", linkedDimensions: ["D1", "D2"] },
      { priority: 2, horizon: "3-6 months", title: "Give the governance council authority to stop work, not only to review it",
        rationale: "A review body that convenes after decisions are made documents risk rather than managing it. The change needed is delegated authority, which is a board-level decision, not a process one.",
        owner: "General Counsel", linkedDimensions: ["D6"] },
      { priority: 3, horizon: "6-12 months", title: "Fund role-specific AI capability rather than general awareness training",
        rationale: "Generic literacy programmes reliably raise comfort and not capability. Tie the spend to the specific decisions each function is being asked to change.",
        owner: "CHRO", linkedDimensions: ["D4", "D7"] },
    ],
    strategicImplications: spreads.slice(0, 3).map((sp, i) => ({
      contradiction: `${sp.hi.role} reads ${DIM_NAMES[sp.dim]} at ${sp.hi.v} while ${sp.lo.role} reads it at ${sp.lo.v}`,
      clientSpecificImpact: `Investment in ${DIM_NAMES[sp.dim]} will be sized against whichever of those two views the sponsor holds. A ${sp.spread}-point gap is the difference between a tuning exercise and a rebuild, and the plan cannot be costed until it is closed.`,
      urgency: i === 0 ? "high" : "medium",
    })),
  };
}

interface TranscriptTurn { who: string; text: string; at: number | null }
export interface SynthScoreEvent { dimension: string; from: number | null; to: number; afterTurn: number; at: number | null }
interface TrackerRow {
  name: string; role: string; round: number; transcript: TranscriptTurn[];
  findings: { dimension: string; text: string }[];
  scoreEvents: SynthScoreEvent[];
}

/**
 * The generator's score trail, validated (v5.32.89).
 *
 * Migration 023 added `score_events` so a consultant can answer "why is D6 a
 * 1.5?" by pointing at a turn. The synthetic generator wrote neither that
 * column nor `findings` — its transcript insert named only turns, count and
 * mode — so every synthetic interview rendered "No score trail was kept",
 * whatever version produced it. v5.32.60's whole argument for persisting a
 * synthesis was that a synthetic engagement must let a consultant rehearse the
 * parts of the product that come AFTER interviewing, and this is one of them.
 *
 * `findings` need no invention at all: the same list is already on the
 * interview. The trail is asked of the model alongside the transcript, so it
 * is a fixture in exactly the way the conversation is — anchored to turns the
 * generator itself produced, which is why these are not flagged `derived`
 * (that flag means "reconstructed after the fact, positions approximate", and
 * these positions are exact within the fixture).
 *
 * Everything is bounded here rather than trusted: a dimension outside D1-D7, a
 * score outside 1-5 or a turn anchor past the end of the transcript is the
 * model getting it wrong, and a trail that points at a turn that does not
 * exist is worse than no trail.
 *
 * Exported for direct test. The integration test can only reach this through
 * whatever its fake adapter happens to return, and a fake that omits
 * `scoreEvents` exercises the fallback while reading as though it covered the
 * model path — which is what it did until this was pulled out.
 */
export function synthScoreEvents(raw: unknown, turnCount: number, scores: unknown): SynthScoreEvent[] {
  const DIMS = new Set(["D1", "D2", "D3", "D4", "D5", "D6", "D7"]);
  const out: SynthScoreEvent[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const dim = String(e.dimension ?? "").trim().toUpperCase();
    if (!DIMS.has(dim) || seen.has(dim)) continue;
    const to = Number(e.to);
    if (!isFinite(to) || to < 1 || to > 5) continue;
    const fromRaw = Number(e.from);
    const from = isFinite(fromRaw) && fromRaw >= 1 && fromRaw <= 5 ? fromRaw : null;
    const turnRaw = Number(e.afterTurn);
    // Clamp rather than drop: a trail whose anchor is off is still worth more
    // than no trail, and the alternative is discarding the whole entry over a
    // position.
    const afterTurn = isFinite(turnRaw) && turnRaw >= 1
      ? Math.min(Math.round(turnRaw), Math.max(1, turnCount))
      : Math.max(1, turnCount);
    seen.add(dim);
    out.push({ dimension: dim, from, to, afterTurn, at: null });
  }
  /*
   * Fall back to the scores themselves when the model returned no usable
   * trail. "Where each score ended up" is a real fact we hold, anchored at the
   * end of the conversation, and it is what the viewer's summary line reads.
   * Better than an empty panel that reads as "nothing was measured".
   */
  if (!out.length && scores && typeof scores === "object") {
    for (const [dim, v] of Object.entries(scores as Record<string, unknown>)) {
      const d = String(dim).trim().toUpperCase();
      const to = Number(v);
      if (!DIMS.has(d) || !isFinite(to) || to < 1 || to > 5) continue;
      out.push({ dimension: d, from: null, to, afterTurn: Math.max(1, turnCount), at: null });
    }
  }
  return out.slice(0, 40);
}

/**
 * Normalise the model's transcript into the shape interview_transcripts holds
 * and the tracker's viewer renders — and, when the model omits it or returns
 * something unusable, build a minimal one from the findings instead.
 *
 * The fallback matters (v5.32.60). A synthetic engagement whose whole purpose
 * is to let a consultant exercise the transcript feature must not silently
 * produce an interview with no transcript because one generation came back a
 * field short. A thin transcript that is honestly derived from the findings is
 * a working demo; an absent one looks like the feature is broken.
 */
function turnsOf(raw: unknown, p: Persona, d: Record<string, unknown>): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  // Spread the timestamps across a plausible 40-minute sitting so the viewer's
  // elapsed column is not a column of zeroes.
  const base = Date.now() - 40 * 60000;
  const stamp = (i: number) => base + i * 90000;
  if (Array.isArray(raw)) {
    for (const t of raw as Array<Record<string, unknown>>) {
      if (!t) continue;
      const text = String(t.text ?? "").trim();
      if (!text) continue;
      const whoRaw = String(t.who ?? "").trim().toLowerCase();
      const who = whoRaw.startsWith("interviewer") || whoRaw === "vyne" || whoRaw === "ai"
        ? "Interviewer" : "Interviewee";
      out.push({ who, text, at: stamp(out.length) });
      if (out.length >= 40) break;   // a transcript, not a novel
    }
  }
  if (out.length >= 4) return out;

  const findings = Array.isArray(d.findings) ? (d.findings as Array<Record<string, unknown>>) : [];
  const derived: TranscriptTurn[] = [{
    who: "Interviewer",
    text: `Thanks for making the time. I'd like to walk through how things work today across data, technology, strategy, people, process, governance and culture — starting wherever you have the strongest view.`,
    at: stamp(0),
  }];
  for (const f of findings.slice(0, 8)) {
    const text = String(f?.text ?? "").trim();
    const dim = String(f?.dimension ?? "").trim();
    if (!text) continue;
    derived.push({ who: "Interviewer", text: `Tell me about ${dim || "that area"} — what does it actually look like day to day?`, at: stamp(derived.length) });
    derived.push({ who: "Interviewee", text: text, at: stamp(derived.length) });
  }
  const summary = String(d.summary ?? "").trim();
  if (summary) derived.push({ who: "Interviewee", text: summary, at: stamp(derived.length) });
  derived.push({ who: "Interviewer", text: "That's everything I had. Thank you for your time.", at: stamp(derived.length) });
  // Marked so nobody mistakes a reconstruction for a real exchange.
  derived.splice(1, 0, {
    who: "Interviewer",
    text: `[Reconstructed from ${p.role} findings — the generator did not return a verbatim transcript for this interview.]`,
    at: stamp(1),
  });
  return derived;
}

function parseJsonLoose(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned) as Record<string, unknown>;
}

/**
 * Why a persona generation failed, as a code that is safe to put on the wire.
 *
 * v5.32.83. The retry loop used to be `catch { /* retry *\/ }`, so a failure
 * reached the client as "generation failed for VP Sales / Revenue" and reached
 * the log as nothing at all. Not knowing whether that was a truncated response,
 * a well-formed response missing `findings`, a provider outage or a refusal is
 * the difference between a five-minute fix and a guess.
 *
 * The categories are deliberately COARSE and fixed. v5.32.29 (audit Low)
 * established that a raw `JSON.parse` message carries a snippet of the model
 * output — which can carry prompt content, which can carry client material —
 * so the raw error is logged and never returned. A category is not a snippet:
 * it names the shape of the failure without quoting anything the model wrote.
 * Adding a case here is fine; interpolating a message into one is not.
 */
export type PersonaFailureCategory =
  | "parse_failed" | "missing_fields" | "provider_error" | "timeout" | "refused";

export function classifyPersonaFailure(err: unknown): PersonaFailureCategory {
  if (err instanceof MissingFieldsError) return "missing_fields";
  if (err instanceof GatewayError) {
    // 504/408 from the adapter is a timeout; everything else the gateway
    // raises is the provider failing or refusing us, not a parse problem.
    if (err.statusCode === 504 || err.statusCode === 408) return "timeout";
    if (err.statusCode === 403 || err.statusCode === 451) return "refused";
    return "provider_error";
  }
  if (err instanceof SyntaxError) return "parse_failed";
  const name = (err as { name?: string })?.name;
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  return "provider_error";
}

/** A response that parsed but did not carry the fields the caller needs. */
export class MissingFieldsError extends Error {
  constructor(public present: { scores: boolean; findings: boolean; transcript: boolean }) {
    super("model response was missing required fields");
    this.name = "MissingFieldsError";
  }
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

/**
 * A login for a synthetic interviewee (v5.32.81).
 *
 * WHY THIS EXISTS. Synthetic interviews were inserted with no
 * `interviewee_user_id`, and the follow-up draft route refuses on exactly that:
 *
 *     if (!p.interviewee_user_id) return "no_login";
 *     → 409 "This interview has no interviewee login to reuse for a follow-up."
 *
 * So every synthetic interview showed a "Request follow-up" button that could
 * not succeed. The whole point of synthetic data is rehearsing the workflow
 * without real people, and the one step it could not rehearse was the follow-up
 * — which is the most intricate part of the product and the part most worth
 * testing before a client sees it.
 *
 * These are DELIBERATELY UNUSABLE as real credentials. The address is on
 * `.invalid`, which RFC 2606 reserves precisely so it can never resolve or
 * receive mail, and the identity-platform uid is prefixed `synthetic:` so no
 * real Identity Platform sign-in can ever collide with one. Nobody can sign in
 * as these people; they exist so a row can point at something.
 *
 * Deterministic in the engagement code and the persona, so regenerating the
 * same engagement reuses the same logins instead of accumulating a new set.
 */
/*
 * ── TENANT-KEYED (v5.33.4, audit 5332-9) ───────────────────────────────────
 *
 * `users` is a GLOBAL table — no tenant_id, no RLS, one row per
 * identity_platform_uid. The uid used to be `synthetic:<code>:<person>`, and
 * engagement codes are unique per TENANT, not globally (migration 025's index
 * is on (tenant_id, code), deliberately: a code is shown to consultants and a
 * collision across firms is harmless). So two firms that generated a practice
 * engagement with the same code and the same persona name landed on the same
 * users row, and the insert's `ON CONFLICT DO UPDATE SET name` meant each one
 * overwrote the other's.
 *
 * The direct consequence is small — these are unusable `.invalid` logins and
 * all interview data is RLS-scoped by tenant, which is why the audit rated it
 * Low. What is NOT small is the shape: a backfill in one firm writing a row
 * another firm's rows point at. Every other identity in this product is
 * tenant-scoped and this one was not.
 *
 * TRANSITION. Existing synthetic users keep their old uid and keep working —
 * interviews.interviewee_user_id still points at them, so follow-ups on an
 * already-generated practice engagement are unaffected. Only NEW generations
 * and backfills mint the tenant-keyed form. The old rows become unreferenced
 * once an engagement is regenerated; they are inert (`.invalid` addresses
 * cannot authenticate) and are left rather than deleted, because deleting rows
 * on a global table from inside one tenant's request is the exact coupling this
 * change exists to remove.
 */
function syntheticLogin(
  tenantId: string, code: string, name: string, role: string
): { uid: string; email: string } {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "").slice(0, 32);
  const c = code.toLowerCase().replace(/[^a-z0-9]/g, "");
  const t = String(tenantId || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const person = slug(name) || slug(role) || "interviewee";
  return {
    // ~90 chars worst case, comfortably inside Identity Platform's 128 limit.
    uid: "synthetic:" + t + ":" + c + ":" + person,
    // The address is never deliverable and never authenticates (.invalid is
    // reserved by RFC 2606). Carrying the tenant keeps it as unambiguous as the
    // uid when it shows up in a log line.
    email: person + "@" + c + "." + t.slice(0, 12) + ".synthetic.invalid",
  };
}


/**
 * Everything a synthetic engagement WRITES, once the personas exist.
 *
 * v5.32.83. Lifted verbatim out of POST /api/synthetic/engagement so that the
 * chunked flow (POST /api/synthetic/commit) and the single-request flow write
 * through exactly the same code. That sameness is the point: it is what lets
 * the existing /engagement tests stand as coverage of the new route's writer,
 * and it removes the possibility of the two paths drifting into producing
 * subtly different engagements — which would show up as a Synthesis bug months
 * later, not as a test failure now.
 *
 * Nothing about the behaviour changed in the lift. The two values the original
 * closed over rather than took — the round count, and whether a real briefing
 * already exists — are parameters here and nothing else moved.
 */
async function commitSyntheticEngagement(args: {
  ctx: { tenantId: string; userId: string };
  clientName: string;
  norm: string;
  industry: string;
  code: string;
  existingCode: string | undefined;
  hasRealBriefing: boolean;
  interviews: Record<string, unknown>[];
  trackerRows: TrackerRow[];
  initialDate: string;
  roundCount: number;
}): Promise<Record<string, unknown>> {
  const { ctx, clientName, norm, industry, code, existingCode, hasRealBriefing,
          interviews, trackerRows, initialDate, roundCount } = args;
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
    if (!hasRealBriefing) {
      await upsert("vynora_briefing_" + norm, JSON.stringify(briefing));
    }
    /* Persist the synthesis too (v5.32.60), so the Synthesis box, the
     * strategy deck and the roadmap's full-synthesis loader all have
     * something to read the moment the engagement is opened — instead of
     * requiring a real, paid, ~90-second AI call before any of those
     * screens can be looked at. */
    {
      const synth = buildSynthesis(interviews, briefing.hypotheses, roleWeight);
      await upsert("vynora_synthesis_full_" + code,
        JSON.stringify({ synthesis: synth, savedAt: Date.now(), synthetic: true }));
    }

    // Tracker rows: visible, completed, deletable. Regeneration replaces
    // the previous synthetic rows for this client instead of stacking.
    /* Regeneration replaces the previous synthetic set. Transcripts are
     * deleted FIRST and by interview id, because interview_transcripts
     * deliberately has no foreign key (a transcript outlives its
     * interview, see migration 017) — so deleting the interviews first
     * would strand every transcript row with nothing pointing at it and
     * no way to identify it later. */
    /* ── One regeneration per client at a time (v5.33.3, audit MEDIUM) ─────
     *
     * This is delete-then-insert with no unique key on either table. Under
     * READ COMMITTED two concurrent POST /api/synthetic/commit for one client
     * each see an empty set after their own delete and each insert the full
     * set — doubling the interviews, transcripts and tracker sittings — while
     * the upserted vynora_engagement_<code> array stays singular. The tracker
     * and Synthesis then disagree about how many people were interviewed, and
     * nothing in the product says why.
     *
     * A transaction-scoped advisory lock is the smallest thing that makes this
     * correct: taken inside withTenant's transaction, released at COMMIT or
     * ROLLBACK with no cleanup path to forget. Keyed on tenant + client so two
     * different clients still regenerate in parallel. hashtextextended is
     * stable across sessions, unlike hashtext's 32-bit sibling on some
     * platforms, and two args avoid collapsing tenant and client into one
     * hashable string. */
    await c.query(
      /* ── ONE key, not two (v5.33.6) ──────────────────────────────────────
       *
       * This was written as the TWO-argument form:
       *
       *     pg_advisory_xact_lock(hashtextextended(tenant,0), hashtextextended(client,0))
       *
       * which does not exist. pg_advisory_xact_lock comes in exactly two
       * shapes — (bigint) and (int4, int4) — and hashtextextended returns
       * BIGINT. int8→int4 is not an implicit cast, so Postgres finds no
       * candidate and raises:
       *
       *     ERROR: function pg_advisory_xact_lock(bigint, bigint) does not exist
       *
       * Every synthetic commit therefore 500'd at the save step, AFTER all the
       * model calls had succeeded — so a consultant watched ten personas
       * generate and then lost the lot to "Generation failed: internal_error".
       *
       * The single-bigint form takes one 64-bit key, so tenant and client are
       * combined before hashing. '|' is a safe separator here specifically
       * because app.tenant_id is a UUID — fixed length, no delimiters — so
       * (tenant, client) cannot be re-partitioned into a different pair.
       * COALESCE, not NULLIF alone: a NULL key would make the whole SELECT
       * NULL and the lock silently not be taken.
       *
       * WHY THE TEST DID NOT CATCH IT: syntheticDeleteBoundary.test.ts asserted
       * that the source CONTAINS 'pg_advisory_xact_lock'. It does. A string
       * match cannot tell a valid function call from an invalid one — only
       * executing it can, which is what the case in that file now does. */
      `SELECT pg_advisory_xact_lock(
         hashtextextended(
           COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '') || '|' || $1,
           0))`,
      [clientName]
    );

    /* Keyed on interviews.synthetic (migration 026), NOT on the display name.
     * The name test that used to be here was the same predicate as 024's RLS
     * DELETE policy, and an audit proved a real transcript could be destroyed
     * by naming an interviewee "… [Synthetic]" — caller input, written verbatim
     * into the audit table. A boundary keyed on a display string is not a
     * boundary. */
    const prior = await c.query<{ id: string }>(
      `SELECT id FROM interviews WHERE client_name = $1 AND synthetic`,
      [clientName]
    );
    if (prior.rows.length) {
      await c.query(
        `DELETE FROM interview_transcripts WHERE interview_id = ANY($1::uuid[]) AND synthetic`,
        [prior.rows.map((r) => r.id)]);
    }
    await c.query(
      `DELETE FROM interviews WHERE client_name = $1 AND synthetic`,
      [clientName]
    );

    /* v5.32.60. This used to insert round-1 rows only, with no round
     * number, no interviewer identity, no kind, and no transcript — so a
     * synthetic engagement could not exercise the Round column, the
     * interviewer voice assignment, the follow-up flow, or the Transcript
     * button. Those are the four things a consultant most needs to
     * rehearse before a real engagement, and they were the four things
     * the test-data generator could not produce. */
    const VOICES = ["Charon", "Kore", "Orus", "Aoede", "Puck"];
    let seq = 0;
    const inserted: { id: string; row: TrackerRow }[] = [];
    /* One login per PERSONA, not per interview: the same person appearing in
       rounds 1 and 2 is the same interviewee, and a follow-up reuses their
       login. Keyed on name+role for that reason. */
    const loginFor = new Map<string, string>();
    for (const t of trackerRows) {
      const slug = t.role.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "role";
      const personaKey = t.name + "|" + t.role;
      let userId = loginFor.get(personaKey);
      if (!userId) {
        const login = syntheticLogin(ctx.tenantId, code, t.name, t.role);
        const u = await c.query<{ id: string }>(
          `INSERT INTO users (identity_platform_uid, email, name) VALUES ($1, $2, $3)
           ON CONFLICT (identity_platform_uid) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [login.uid, login.email, t.name]
        );
        userId = u.rows[0].id;
        await c.query(
          `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'interviewee')
           ON CONFLICT (user_id, tenant_id) DO NOTHING`,
          [userId, ctx.tenantId]
        );
        loginFor.set(personaKey, userId);
      }
      const r = await c.query<{ id: string }>(
        /* `synthetic` is the fact this row is practice data (migration 026).
         * It is set HERE, by the generator, and the application is never
         * granted UPDATE on interviews — so it cannot be turned on for a real
         * interview later. That is what makes it a boundary the [Synthetic]
         * name suffix never was. */
        `INSERT INTO interviews
           (tenant_id, client_name, interviewee_name, interviewee_role,
            status, state_module, created_by, started_at, completed_at,
            round_number, interviewer_name, interviewer_voice, kind,
            interviewee_user_id, synthetic)
         VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                 $1, $2, $3, 'completed', $4, $5, now(), now(),
                 $6, $7, $8, 'initial', $9, true)
         RETURNING id`,
        [clientName, t.name, t.role,
         "iv_synth_" + code.toLowerCase().replace(/[^a-z0-9]/g, "") + "_" + slug + "_r" + t.round + "_" + seq++,
         ctx.userId, t.round, "Vyn", VOICES[seq % VOICES.length], userId]
      );
      inserted.push({ id: r.rows[0].id, row: t });
    }

    /* One genuine FOLLOW-UP, hung off a round-2 interview. A follow-up is
     * a different row shape from a repeat interview — kind='follow_up'
     * with a parent and an approved agenda — and nothing in the product
     * could produce one for testing. */
    const parent = inserted.find((x) => x.row.round === 2) ?? inserted[inserted.length - 1];
    if (parent) {
      const fu = await c.query<{ id: string }>(
        `INSERT INTO interviews
           (tenant_id, client_name, interviewee_name, interviewee_role,
            status, state_module, created_by, started_at, completed_at,
            round_number, interviewer_name, interviewer_voice,
            kind, parent_interview_id, agenda_status, interviewee_user_id)
         VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                 $1, $2, $3, 'completed', $4, $5, now(), now(),
                 $6, $7, $8, 'follow_up', $9, 'approved', $10)
         RETURNING id`,
        [clientName, parent.row.name, parent.row.role,
         "iv_synth_" + code.toLowerCase().replace(/[^a-z0-9]/g, "") + "_followup",
         ctx.userId, parent.row.round, "Vyn", "Charon", parent.id,
         loginFor.get(parent.row.name + "|" + parent.row.role) ?? null]
      );
      inserted.push({
        id: fu.rows[0].id,
        row: {
          name: parent.row.name, role: parent.row.role, round: parent.row.round,
          transcript: [
            { who: "Interviewer", text: "Thanks for the follow-up slot. I want to close two gaps from our last conversation rather than cover new ground.", at: Date.now() - 1800000 },
            { who: "Interviewee", text: "Go ahead — I had a chance to check some of what I was guessing at last time.", at: Date.now() - 1740000 },
            { who: "Interviewer", text: "You said governance ownership was 'being worked out'. Has that landed anywhere concrete?", at: Date.now() - 1680000 },
            { who: "Interviewee", text: "It has a name now and a monthly meeting. What it does not have is the authority to stop anything, so in practice it reviews after the fact.", at: Date.now() - 1620000 },
            { who: "Interviewer", text: "And the data platform consolidation — is that one warehouse now, or three with a view over the top?", at: Date.now() - 1560000 },
            { who: "Interviewee", text: "Honestly, three with a view over the top. The reporting layer is unified, which is what people see, so it gets described as consolidated more confidently than I would describe it.", at: Date.now() - 1500000 },
            { who: "Interviewer", text: "That is a useful distinction. Thank you.", at: Date.now() - 1440000 },
          ],
          /* The specimen follow-up carries its own small trail (v5.32.89), so
           * the evidence panel has something to show on the one row in a
           * synthetic engagement whose whole purpose is demonstrating what a
           * follow-up looks like. Anchored to the turns above: governance
           * lands at turn 4, the data-platform correction at turn 6. */
          findings: [
            { dimension: "D6", text: "The governance council reviews after the fact and cannot stop a release." },
            { dimension: "D2", text: "Reporting is unified over three warehouses, which is described as consolidation." },
          ],
          scoreEvents: [
            { dimension: "D6", from: null, to: 2, afterTurn: 4, at: null },
            { dimension: "D2", from: 3, to: 2.5, afterTurn: 6, at: null },
          ],
        },
      });
    }

    for (const { id, row } of inserted) {
      if (!row.transcript.length) continue;
      await c.query(
        /* v5.32.89: findings and score_events too. They were omitted since
         * migration 023 shipped, so every synthetic transcript rendered "No
         * score trail was kept" — including ones generated seventeen versions
         * after the trail existed. NULL is stored as NULL, not as an empty
         * array: "no journal" and "a journal with nothing in it" are different
         * facts and the viewer says so. */
        `INSERT INTO interview_transcripts
           (tenant_id, interview_id, client_name, interviewee_name, interviewee_role,
            round_number, turns, turn_count, mode, findings, score_events, synthetic)
         VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                 $1, $2, $3, $4, $5, $6::jsonb, $7, 'voice', $8::jsonb, $9::jsonb, true)`,
        [id, clientName, row.name, row.role, row.round,
         JSON.stringify(row.transcript), row.transcript.length,
         row.findings && row.findings.length ? JSON.stringify(row.findings) : null,
         row.scoreEvents && row.scoreEvents.length ? JSON.stringify(row.scoreEvents) : null]
      );
    }
  });

  return {
    ok: true, code, clientName,
    interviews: interviews.length,
    rounds: roundCount,
    trackerRows: trackerRows.length + 1,   // + the follow-up
    transcripts: trackerRows.length + 1,
    followUps: 1,
    synthesis: true,
    next: `Open the Synthesis Dashboard, enter "${clientName}", and click Load Engagement. `
      + `The Interview Tracker shows every sitting with its round and a Transcript button; `
      + `the Roadmap module picks the scores up from the engagement picker.`,
  };
}

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
          req.log.error({ detail: redactProviderDetail(err.detail) }, "persona preview: provider error detail");
        }
        // v5.32.29 (audit Low): the raw message for a JSON.parse failure
        // includes a snippet of the model output, which can carry prompt
        // content. Logged in full, returned as a stable code.
        req.log.error({ err }, "persona preview failed");
        reply.code(502).send({ error: "generation_failed" });
        return;
      }
    }
  );

  app.post(
    "/api/synthetic/engagement",
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
      async function generateOne(p: Persona, refresh: boolean, roundSeeds: string): Promise<Record<string, unknown>> {
        let last: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          /*
           * The provider call stays OUTSIDE the retry's catch on purpose. The
           * loop has always existed to retry a response that came back and was
           * unusable; a GatewayError is the call itself failing, it propagates
           * to the handler below, and that handler is what redacts and logs
           * `err.detail`. Pulling it inside would silently double every billed
           * call during a provider outage and swallow the detail path.
           */
          const result = await gateway.generate(
            { tenantId: ctx.tenantId, userId: ctx.userId, module: "synthetic_data" },
            {
              task: "synthetic_interview",
              temperature: 0.7,
              // v5.32.60: the response now carries a 12-16 turn transcript as
              // well as scores and findings. At 2000 it truncated mid-array,
              // parseJsonLoose threw, and the retry produced the same length.
              maxTokens: 4000,
              messages: [{ role: "user", content: synthPrompt(p, clientName, industry, refresh, roundSeeds, hypotheses) }],
            }
          );
          try {
            const data = parseJsonLoose(result.text);
            if (data.scores && data.findings) return data;
            throw new MissingFieldsError({
              scores: Boolean(data.scores),
              findings: Boolean(data.findings),
              transcript: Boolean(data.transcript),
            });
          } catch (err) {
            last = err;
            /*
             * v5.32.83 (handoff item 2). This was `catch { /* retry *\/ }`, and
             * a discarded reason is why "generation failed for VP Sales /
             * Revenue" was undiagnosable in production: the response said only
             * that it failed, and the server log said nothing at all.
             *
             * Per ATTEMPT, because the interesting case is the one where the
             * two attempts fail DIFFERENTLY — a truncation followed by a
             * refusal is a different problem from the same parse error twice,
             * and only per-attempt logging can tell them apart.
             *
             * `err` goes to the log in full and never to the client; the
             * category is what the client is allowed to see.
             */
            req.log.error(
              {
                err,
                category: classifyPersonaFailure(err),
                role: p.role,
                round: refresh ? 2 : 1,
                attempt: attempt + 1,
                present: err instanceof MissingFieldsError ? err.present : undefined,
              },
              "synthetic persona generation attempt failed"
            );
          }
        }
        const e = new Error(`generation failed for ${p.role}${refresh ? " (refresh)" : ""}`);
        (e as Error & { category?: PersonaFailureCategory }).category = classifyPersonaFailure(last);
        throw e;
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
        refresh: boolean,
        roundSeeds: string
      ): Promise<{ ok: { p: Persona; d: Record<string, unknown> }[]; failures: string[] }> {
        const settled = await Promise.allSettled(personas.map((p) => generateOne(p, refresh, roundSeeds).then((d) => ({ p, d }))));
        const ok: { p: Persona; d: Record<string, unknown> }[] = [];
        const failures: string[] = [];
        for (const s of settled) {
          if (s.status === "fulfilled") ok.push(s.value);
          else failures.push((s.reason as Error).message);
        }
        return { ok, failures };
      }

      const interviews: Record<string, unknown>[] = [];
      const trackerRows: TrackerRow[] = [];
      try {
        const initial = await generateRound(false, seeds);
        for (const { p, d } of initial.ok) {
          interviews.push({
            role: p.role, name: p.name + " [Synthetic]",
            interviewee: p.name + " [Synthetic]",
            scores: d.scores, findings: d.findings, summary: d.summary,
            date: initialDate, synthetic: true,
          });
          const _t1 = turnsOf(d.transcript, p, d);
          trackerRows.push({
            name: p.name + " [Synthetic]", role: p.role, round: 1,
            transcript: _t1,
            findings: (Array.isArray(d.findings) ? d.findings : []) as { dimension: string; text: string }[],
            scoreEvents: synthScoreEvents(d.scoreEvents, _t1.length, d.scores),
          });
        }
        if (initial.failures.length) throw new Error(initial.failures.join(" | "));

        if (includeRefresh) {
          /* Round 2's seeds come from round 1's findings (v5.32.83) — see
           * seedsFromPriorRound. This is the ordering constraint the chunked
           * spec insists on, and until this version there was nothing here for
           * it to constrain: both rounds got the same static seeds. Round 1's
           * results are in hand at this point, so nothing has to be re-read. */
          const refreshSeeds = seedsFromPriorRound(
            initial.ok.map(({ p, d }) => ({
              persona: { name: p.name, role: p.role },
              scores: (d.scores ?? {}) as Record<string, number>,
              findings: (Array.isArray(d.findings) ? d.findings : []) as { dimension: string; text: string }[],
            })),
            personas,
            1
          );
          const refresh = await generateRound(true, refreshSeeds);
          for (const { p, d } of refresh.ok) {
            interviews.push({
              role: p.role, name: p.name + " [Synthetic]",
              interviewee: p.name + " [Synthetic]",
              scores: d.scores, findings: d.findings, summary: d.summary,
              date: today.toISOString().slice(0, 10), synthetic: true,
              isRefresh: true, refreshRound: 2,
              coverageByDim: { D1: 0.8, D2: 1.0, D3: 0.6, D4: 0.7, D5: 0.8, D6: 1.0, D7: 0.6 },
            });
            /* Round 2 gets tracker rows too (v5.32.60). It never did, so a
             * synthetic engagement showed five interviews in the tracker and
             * ten in Synthesis — and the Round column, added in v5.32.55, had
             * nothing to show a second value for. */
            const _t2 = turnsOf(d.transcript, p, d);
            trackerRows.push({
              name: p.name + " [Synthetic]", role: p.role, round: 2,
              transcript: _t2,
              findings: (Array.isArray(d.findings) ? d.findings : []) as { dimension: string; text: string }[],
              scoreEvents: synthScoreEvents(d.scoreEvents, _t2.length, d.scores),
            });
          }
          if (refresh.failures.length) throw new Error(refresh.failures.join(" | "));
        }
      } catch (err) {
        // V225-audit MEDIUM fix: gateway.generate() throws GatewayError with
        // a client-safe .message now (see gateway.ts) — the raw provider
        // error text, if any, rides on .detail for logs only, never sent.
        if (err instanceof GatewayError && err.detail) {
          req.log.error({ detail: redactProviderDetail(err.detail) }, "synthetic engagement: provider error detail");
        }
        // v5.32.29 (audit Low): the raw message for a JSON.parse failure
        // includes a snippet of the model output, which can carry prompt
        // content. Logged in full, returned as a stable code.
        req.log.error({ err }, "synthetic engagement failed");
        reply.code(502).send({ error: "generation_failed", generated: interviews.length });
        return;
      }

      return await commitSyntheticEngagement({
        ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
        clientName, norm, industry, code, existingCode,
        hasRealBriefing: Boolean(briefing0),
        interviews, trackerRows, initialDate,
        roundCount: includeRefresh ? 2 : 1,
      });
    }
  );

  /* ════════════════════════════════════════════════════════════════════════
   * CHUNKED GENERATION (v5.32.83) — docs/CHUNKED_SYNTHETIC_SPEC.md
   *
   * /engagement above generates every persona in one request. Two live
   * failures follow from that shape: Firebase Hosting cuts the response at 60
   * seconds (upstream of anything we configure — our requestTimeout is 180s),
   * and one persona failing aborts the whole batch, which is how Nissan lost
   * nine good interviews to one bad one.
   *
   * The fan-out moves to the browser: one request per persona, failures
   * collected rather than fatal, a separate commit at the end. /engagement
   * stays, unchanged and sharing this file's writer, so a regression in the
   * new path is distinguishable from the refactor.
   *
   * ── One deliberate departure from the spec's API shape. ──
   *
   * The spec has the browser POST `seeds`, `hypotheses`, `industry` and the
   * persona's bias to /persona. These routes take `clientName`, a round and a
   * persona INDEX, and re-derive all of it server-side on every call.
   *
   * Two reasons, one of them security. Everything in that list is prompt
   * content for a billed LLM call, and accepting it from the client turns a
   * server-composed prompt into a client-composed one for anyone holding a
   * consultant token — a strictly wider surface than exists today, bought for
   * nothing. The second is drift: a briefing edited midway through a ten-
   * persona run would leave the browser generating against a briefing that no
   * longer exists, silently. Re-deriving costs one indexed module_state read
   * next to a multi-second model call, and `expect` below turns the drift case
   * into a 409 instead of a wrong engagement.
   * ════════════════════════════════════════════════════════════════════════ */

  /** Round labels, in order. Index 0 is round 1. */
  const ROUND_PLAN = [
    { round: 1, label: "Initial Diagnostic", refresh: false },
    { round: 2, label: "Refresh (6 months on)", refresh: true },
  ];

  /**
   * Resolve everything a synthetic generation needs from the client's own
   * Pre-Engagement record. Shared by all three chunked routes so they cannot
   * disagree about what the personas or the engagement code are.
   */
  async function loadClientContext(
    ctx: { tenantId: string; userId: string },
    clientName: string,
    industryOverride?: string
  ) {
    const norm = normClient(clientName);
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

    const industry = industryOverride ?? briefing0?.industry ?? "Manufacturing";
    const personas = personasFromRoles(briefing0?.roleCatalog ?? []) ?? PERSONAS;
    const hypotheses = (briefing0?.hypotheses ?? [])
      .map((h) => (typeof h === "string" ? h : h?.text))
      .filter((t): t is string => Boolean(t))
      .slice(0, 6);
    const existingCode = idx0[norm];
    const code = existingCode ?? ((clientName.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4) || "SYNT") + "-SYN1");
    return { norm, briefing0, industry, personas, hypotheses, existingCode, code };
  }

  /** Guard shared by every chunked route. Returns null when it has replied. */
  async function scopeOrDeny(
    req: { ctx?: { tenantId: string; userId: string; role: string } },
    reply: { code: (n: number) => { send: (b: unknown) => void } },
    clientName: string
  ): Promise<{ tenantId: string; userId: string; role: string } | null> {
    const ctx = req.ctx!;
    const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
    if (!clientAllowed(allowed, clientName)) {
      reply.code(403).send({
        error: "client_not_assigned",
        detail: `You are not assigned to client "${clientName}". Ask a firm owner to assign you.`,
      });
      return null;
    }
    return ctx;
  }

  const PersonasBody = z.object({
    clientName: z.string().min(2).max(120),
    industry: z.string().min(2).max(80).optional(),
  });

  /**
   * The work-list. Resolving personas is the one piece the browser cannot do
   * for itself, because it comes from the briefing's roleCatalog.
   *
   * Not rate-limited with the generation routes: it costs one indexed read and
   * no model call, and throttling it would throttle the act of finding out how
   * much work there is.
   */
  app.post(
    "/api/synthetic/personas",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const parsed = PersonasBody.safeParse(req.body);
      if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      const { clientName, industry: industryOverride } = parsed.data;
      const ctx = await scopeOrDeny(req, reply, clientName);
      if (!ctx) return;

      const { industry, personas, code } = await loadClientContext(ctx, clientName, industryOverride);
      return {
        code, clientName, industry,
        // Bias is NOT returned: it is prompt content, the browser has no use
        // for it, and anything returned here is something a later version is
        // tempted to accept back.
        personas: personas.map((p, index) => ({ index, name: p.name, role: p.role })),
        rounds: ROUND_PLAN,
      };
    }
  );

  const OnePersonaBody = z.object({
    clientName: z.string().min(2).max(120),
    industry: z.string().min(2).max(80).optional(),
    round: z.number().int().min(1).max(ROUND_PLAN.length),
    personaIndex: z.number().int().min(0).max(49),
    /** What the browser believes is at that index — see the 409 below. */
    expect: z.object({ name: z.string().max(120), role: z.string().max(120) }).optional(),
    /**
     * Round N−1's results, for N > 1. Model-generated content that has been
     * round-tripped through the browser, so it is shape-validated and bounded
     * rather than trusted: dimensions must be real dimensions, scores must be
     * in range, and text is truncated. The seeds string itself is composed
     * server-side from this, never accepted directly.
     */
    priorRound: z.array(z.object({
      persona: z.object({ name: z.string().max(120), role: z.string().max(120) }),
      scores: z.record(z.enum(DIM_KEYS), z.number().min(0).max(5)),
      findings: z.array(z.object({
        dimension: z.enum(DIM_KEYS),
        text: z.string().max(1000),
      })).max(20).default([]),
    })).max(40).optional(),
  });

  /**
   * ONE persona, one round, one model call.
   *
   * A failure here is a 502 carrying a CATEGORY and nothing else. v5.32.29
   * (audit Low) established why: the raw message for a parse failure quotes the
   * model's output, which can quote the prompt, which can quote the client's
   * briefing. The full error goes to the log; the caller gets a code it can
   * branch on and show.
   */
  app.post(
    "/api/synthetic/persona",
    {
      preHandler: requireRole("owner", "consultant"),
      /*
       * Deliberately far above /engagement's 6/min. This route IS the fan-out
       * that route did internally — ten personas across two rounds is twenty
       * calls, and a limit tuned for whole engagements would stall the run it
       * exists to enable. The spend caps in metering.ts are what bound cost;
       * this bounds request rate, and 60/min is roughly one full engagement's
       * worth of personas per minute.
       */
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const parsed = OnePersonaBody.safeParse(req.body);
      if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      const { clientName, industry: industryOverride, round, personaIndex, expect, priorRound } = parsed.data;
      const ctx = await scopeOrDeny(req, reply, clientName);
      if (!ctx) return;

      const { industry, personas, hypotheses } = await loadClientContext(ctx, clientName, industryOverride);
      const p = personas[personaIndex];
      if (!p) { reply.code(400).send({ error: "persona_out_of_range", personas: personas.length }); return; }
      if (expect && (expect.name !== p.name || expect.role !== p.role)) {
        // The briefing's roleCatalog changed underneath a run in progress.
        // Better a visible stop than half an engagement generated against one
        // set of roles and half against another.
        reply.code(409).send({ error: "personas_changed", role: p.role, index: personaIndex });
        return;
      }

      const plan = ROUND_PLAN[round - 1];
      /*
       * The ordering rule, enforced rather than assumed. The spec asks for
       * rounds in order because round N reads round N−1; that is only true if
       * something refuses to generate round N without it. Before this version
       * nothing did — and nothing needed to, because the seeds were static, so
       * an out-of-order run produced no visible symptom at all. Now it is a
       * 400, and the ordering constraint is a property the tests can observe.
       */
      if (round > 1 && !(priorRound && priorRound.length)) {
        reply.code(400).send({ error: "prior_round_required", round });
        return;
      }
      const seeds = round > 1
        ? seedsFromPriorRound(priorRound as RoundResult[], personas, round - 1)
        : seedsFor(personas);

      let last: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        let result: { text: string };
        try {
          result = await gateway.generate(
            { tenantId: ctx.tenantId, userId: ctx.userId, module: "synthetic_data" },
            {
              task: "synthetic_interview",
              temperature: 0.7,
              maxTokens: 4000,
              messages: [{ role: "user", content: synthPrompt(p, clientName, industry, plan.refresh, seeds, hypotheses) }],
            }
          );
        } catch (err) {
          if (err instanceof GatewayError && err.detail) {
            req.log.error({ detail: redactProviderDetail(err.detail) }, "synthetic persona: provider error detail");
          }
          req.log.error({ err, category: classifyPersonaFailure(err), role: p.role, round, attempt: attempt + 1 },
            "synthetic persona generation failed at the provider");
          reply.code(502).send({
            error: "persona_failed", category: classifyPersonaFailure(err), role: p.role, round,
          });
          return;
        }
        try {
          const data = parseJsonLoose(result.text);
          if (data.scores && data.findings) {
            return {
              persona: { name: p.name, role: p.role },
              round,
              roundLabel: plan.label,
              scores: data.scores,
              findings: data.findings,
              summary: data.summary,
              transcript: turnsOf(data.transcript, p, data),
              scoreEvents: synthScoreEvents(data.scoreEvents, turnsOf(data.transcript, p, data).length, data.scores),
            };
          }
          throw new MissingFieldsError({
            scores: Boolean(data.scores),
            findings: Boolean(data.findings),
            transcript: Boolean(data.transcript),
          });
        } catch (err) {
          last = err;
          req.log.error(
            {
              err,
              category: classifyPersonaFailure(err),
              role: p.role, round, attempt: attempt + 1,
              present: err instanceof MissingFieldsError ? err.present : undefined,
            },
            "synthetic persona generation attempt failed"
          );
        }
      }
      reply.code(502).send({
        error: "persona_failed", category: classifyPersonaFailure(last), role: p.role, round,
      });
    }
  );

  const CommitBody = z.object({
    clientName: z.string().min(2).max(120),
    industry: z.string().min(2).max(80).optional(),
    results: z.array(z.object({
      persona: z.object({ name: z.string().min(1).max(120), role: z.string().min(1).max(120) }),
      round: z.number().int().min(1).max(ROUND_PLAN.length),
      scores: z.record(z.enum(DIM_KEYS), z.number().min(0).max(5)),
      findings: z.array(z.object({
        dimension: z.enum(DIM_KEYS),
        text: z.string().max(1000),
      })).max(20),
      summary: z.string().max(4000).optional(),
      transcript: z.array(z.object({
        who: z.string().max(40),
        text: z.string().max(4000),
        at: z.number().nullable().optional(),
      })).max(60).optional(),
      /* v5.32.89: the score trail, revalidated here by synthScoreEvents even
       * though the persona route already normalised it — this payload came
       * back through a browser, and a bound applied once on the way out is not
       * a bound. */
      scoreEvents: z.array(z.object({
        dimension: z.enum(DIM_KEYS),
        from: z.number().nullable().optional(),
        to: z.number(),
        afterTurn: z.number().optional(),
      })).max(40).optional(),
    })).min(1).max(40),
  });

  /**
   * Write what the browser collected.
   *
   * The whole of the writing is commitSyntheticEngagement, the same function
   * /engagement calls — including the per-persona login that makes Request
   * follow-up work (v5.32.81) and the delete-then-insert that stops a
   * regeneration stacking. Nothing about persistence is reimplemented here;
   * this route's only job is to turn validated results into the two arrays
   * that function takes.
   */
  app.post(
    "/api/synthetic/commit",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const parsed = CommitBody.safeParse(req.body);
      if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      const { clientName, industry: industryOverride, results } = parsed.data;
      const ctx = await scopeOrDeny(req, reply, clientName);
      if (!ctx) return;

      const { norm, briefing0, industry, code, existingCode } =
        await loadClientContext(ctx, clientName, industryOverride);

      const roundCount = Math.max(...results.map((r) => r.round));
      const today = new Date();
      // Same spacing as /engagement: a single round reads as a week old, a
      // two-round engagement puts the initial diagnostic six months back.
      const initialDate = new Date(today.getTime() - (roundCount > 1 ? 182 : 7) * 86400000)
        .toISOString().slice(0, 10);

      const interviews: Record<string, unknown>[] = [];
      const trackerRows: TrackerRow[] = [];
      // Round order matters to buildSynthesis, which reads the LAST round as
      // current — so sort rather than trusting the order they arrived in.
      for (const r of [...results].sort((a, b) => a.round - b.round)) {
        const displayName = r.persona.name + " [Synthetic]";
        const isRefresh = r.round > 1;
        interviews.push({
          role: r.persona.role, name: displayName, interviewee: displayName,
          scores: r.scores, findings: r.findings, summary: r.summary,
          date: isRefresh ? today.toISOString().slice(0, 10) : initialDate,
          synthetic: true,
          ...(isRefresh
            ? {
                isRefresh: true,
                refreshRound: r.round,
                coverageByDim: { D1: 0.8, D2: 1.0, D3: 0.6, D4: 0.7, D5: 0.8, D6: 1.0, D7: 0.6 },
              }
            : {}),
        });
        const _tc = turnsOf(
          r.transcript,
          { name: r.persona.name, role: r.persona.role, bias: "" },
          { findings: r.findings, summary: r.summary } as Record<string, unknown>
        );
        trackerRows.push({
          name: displayName, role: r.persona.role, round: r.round,
          findings: r.findings,
          scoreEvents: synthScoreEvents(r.scoreEvents, _tc.length, r.scores),
          // turnsOf still runs on the way in: it is what guarantees a usable
          // transcript exists even when the model returned none, and a
          // browser-assembled payload needs that guarantee as much as a
          // model response does.
          transcript: _tc,
        });
      }

      const out = await commitSyntheticEngagement({
        ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
        clientName, norm, industry, code, existingCode,
        hasRealBriefing: Boolean(briefing0),
        interviews, trackerRows, initialDate, roundCount,
      });
      return { ...out, chunked: true };
    }
  );

  const BackfillBody = z.object({
    /** Omit to repair every client this caller can reach. */
    clientName: z.string().min(2).max(120).optional(),
  });

  /**
   * Give pre-v5.32.81 synthetic interviews the login they were created without.
   *
   * Until v5.32.81 the generator inserted synthetic interviews with a NULL
   * `interviewee_user_id`, and the follow-up draft route refuses on exactly
   * that — `if (!p.interviewee_user_id) return "no_login"` → 409. Every
   * synthetic sitting generated before .81 therefore shows a "Request
   * follow-up" button that cannot succeed, and the only remedy has been to
   * regenerate the engagement, which throws away whatever the consultant had
   * already done with it.
   *
   * This repairs them in place. It is idempotent by construction rather than
   * by convention: the WHERE clause selects only rows that are still NULL, so
   * a second run finds nothing and reports zero.
   *
   * The uid comes from `syntheticLogin(tenantId, code, name, role)`, the same function
   * the generator uses, fed the code slug recovered from `state_module`. That
   * matters more than it looks: syntheticLogin is deterministic in exactly
   * those three inputs, so a repaired row and a later REGENERATION of the same
   * engagement resolve to the same uid, and the regeneration reuses the
   * existing user instead of stranding this one and minting a second.
   */
  app.post(
    "/api/synthetic/backfill-logins",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const parsed = BackfillBody.safeParse(req.body ?? {});
      if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      const { clientName } = parsed.data;

      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      if (clientName && !clientAllowed(allowed, clientName)) {
        reply.code(403).send({
          error: "client_not_assigned",
          detail: `You are not assigned to client "${clientName}". Ask a firm owner to assign you.`,
        });
        return;
      }

      const result = await withTenant(ctx.tenantId, async (c) => {
        /*
         * `_` is a single-character wildcard in LIKE, so the obvious
         * 'iv_synth_%' also matches 'ivXsynthY…'. Escaped, because a backfill
         * that writes an interviewee login onto a row it merely resembles is a
         * far worse outcome than one that repairs nothing.
         */
        const rows = await c.query<{
          id: string; client_name: string; interviewee_name: string;
          interviewee_role: string; state_module: string;
        }>(
          `SELECT id, client_name, interviewee_name, interviewee_role, state_module
             FROM interviews
            WHERE state_module LIKE 'iv\\_synth\\_%'
              AND interviewee_user_id IS NULL
            ORDER BY id`
        );

        const repaired: { id: string; clientName: string; role: string }[] = [];
        const skipped: { id: string; reason: string }[] = [];
        /*
         * A within-run cache, and only that. What actually guarantees one login
         * per person is that syntheticLogin() is deterministic in
         * (tenantId, code, name, role) and the users insert is
         * ON CONFLICT (identity_platform_uid) DO UPDATE — so the same person
         * resolves to the same row whether or not this map is consulted,
         * including across separate runs, which is the case that matters.
         *
         * Worth stating plainly, because a cache that looks load-bearing
         * invites someone to simplify the derivation behind it. With this map
         * in place, a per-ROW uid derivation still yields one login per person
         * within a single run — and a different one on the next.
         */
        const loginFor = new Map<string, string>();

        for (const row of rows.rows) {
          // A consultant repairs only their own clients; an owner reaches all.
          if (!clientAllowed(allowed, row.client_name)) {
            skipped.push({ id: row.id, reason: "not_assigned" });
            continue;
          }
          if (clientName && normClient(row.client_name) !== normClient(clientName)) continue;

          // iv_synth_<codeslug>_<roleslug>_r<n>_<seq>, and for the follow-up
          // row iv_synth_<codeslug>_followup. Index 2 either way.
          const codeSlug = row.state_module.split("_")[2];
          if (!codeSlug) { skipped.push({ id: row.id, reason: "no_code_in_state_module" }); continue; }

          const personaKey = codeSlug + "|" + row.interviewee_name + "|" + row.interviewee_role;
          let userId = loginFor.get(personaKey);
          if (!userId) {
            const login = syntheticLogin(ctx.tenantId, codeSlug, row.interviewee_name, row.interviewee_role);
            const u = await c.query<{ id: string }>(
              `INSERT INTO users (identity_platform_uid, email, name) VALUES ($1, $2, $3)
               ON CONFLICT (identity_platform_uid) DO UPDATE SET name = EXCLUDED.name
               RETURNING id`,
              [login.uid, login.email, row.interviewee_name]
            );
            userId = u.rows[0].id;
            await c.query(
              `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'interviewee')
               ON CONFLICT (user_id, tenant_id) DO NOTHING`,
              [userId, ctx.tenantId]
            );
            loginFor.set(personaKey, userId);
          }

          await c.query(
            `UPDATE interviews SET interviewee_user_id = $1
              WHERE id = $2 AND interviewee_user_id IS NULL`,
            [userId, row.id]
          );
          repaired.push({ id: row.id, clientName: row.client_name, role: row.interviewee_role });
        }
        return { repaired, skipped };
      });

      req.log.info(
        { repaired: result.repaired.length, skipped: result.skipped.length, clientName },
        "synthetic login backfill"
      );
      return {
        ok: true,
        repaired: result.repaired.length,
        logins: new Set(result.repaired.map((r) => r.clientName)).size,
        skipped: result.skipped.length,
        clients: [...new Set(result.repaired.map((r) => r.clientName))],
      };
    }
  );
}
