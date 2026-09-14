/**
 * The tiering survives the DISTRIBUTED path, not just the consultant's browser.
 * (v5.34.93)
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * v5.34.92 weights the overall by the lead/cover/light tiering each interview
 * carries, and wired it through all six consumers. Every test passed. It was
 * dead in production on the path the product is built around.
 *
 * Two ways an interview reaches the engagement record:
 *
 *   CONSULTANT-RUN   interview_agent.html's writeInterviewToEngagement() writes
 *                    the record directly, dimTiers included. This is what
 *                    v5.34.92 tested.
 *
 *   INTERVIEWEE-RUN  the browser saves a session blob; POST
 *                    /api/interviews/mine/complete reads it back and
 *                    mergeSessionIntoEngagement() REBUILDS the interview record
 *                    field by field, server-side. Any field it does not name is
 *                    gone. It did not name dimTiers.
 *
 * And because dimensionWeights() is all-or-nothing per round (deliberately —
 * see its comment), ONE interviewee-run interview was enough to drop the entire
 * round back to the plain mean. The invite flow is the normal flow, so the
 * feature would have been off almost everywhere while looking shipped.
 *
 * ── This is the third instance of one bug ───────────────────────────────────
 *
 * The comment directly above the fix in engagementMerge.ts records the second:
 * coverageByDim was declared on SessionRecord, read by the blend, and never
 * copied through this same function — so every distributed refresh silently
 * took the 0.3 default. Same function, same omission, one version apart. The
 * first was `overallOf` existing in the browser with no caller at all.
 *
 * So this file tests the SEAM rather than either side of it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mergeSessionIntoEngagement,
  pickLatestSession,
  sanitizeIntervieweeSession,
  type SessionRecord,
  type EngagementRecord,
} from "../src/tenant/engagementMerge.js";
import { computeRoundScores, dimensionWeights, overallOf } from "../src/tenant/scoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const page = readFileSync(join(root, "frontend", "interview_agent.html"), "utf8");

const TIERS = {
  D1: "lead", D2: "lead", D6: "lead",
  D3: "cover", D5: "cover",
  D4: "light", D7: "light",
};
const SCORES = { D1: 4.0, D2: 4.0, D4: 1.0 };

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "s1",
    sessionCode: "VYNE-AAAA-BBBB",
    client: "Meridian",
    stakeholderRole: "CTO",
    stakeholderName: "Priya Raman",
    industry: "Manufacturing",
    scores: { ...SCORES },
    findings: [],
    dimTiers: { ...TIERS },
    ...over,
  } as SessionRecord;
}

const OPTS = { sourceInterviewId: "iv-1", kind: "initial" as const };

describe("v5.34.93 — the browser puts the tiering in the session blob", () => {
  it("saveSession writes dimTiers, not only writeInterviewToEngagement", () => {
    /*
     * The blob is what crosses to the server. writeInterviewToEngagement never
     * runs on the interviewee path, so its copy of dimTiers is irrelevant
     * there — this line is the whole wire.
     */
    const from = page.indexOf("function saveSession()");
    expect(from, "saveSession() moved — update this test").toBeGreaterThan(-1);
    const to = page.indexOf("\nfunction ", from + 1);
    const blob = page.slice(from, to === -1 ? page.length : to);
    expect(blob, "the session blob carries no tiering, so the distributed flow loses it")
      .toMatch(/data\.dimTiers\s*=\s*dimensionTierMap\(\)/);
  });

  it("it survives being written and read back as JSON", () => {
    // pickLatestSession JSON.parses whatever module_state holds.
    const raw = { "vynora_session_s1": JSON.stringify(session({ lastSaved: 5 } as never)) };
    const back = pickLatestSession(raw as Record<string, string>);
    expect(back?.dimTiers).toEqual(TIERS);
  });
});

describe("v5.34.93 — the server merge carries it onto the interview record", () => {
  it("an interviewee-run interview arrives with its tiering intact", () => {
    const eng = mergeSessionIntoEngagement(null, "ENG-1", session(), OPTS);
    const iv = eng.rounds![0].interviews[0] as Record<string, unknown>;
    expect(iv.dimTiers, "mergeSessionIntoEngagement dropped dimTiers — the v5.34.92 weighting is dead on this path")
      .toEqual(TIERS);
  });

  it("and the round is therefore WEIGHTED, not silently plain-meaned", () => {
    /*
     * The assertion that would have caught the original bug. Not "the field is
     * present" but "the number the client sees is the weighted one".
     */
    const eng = mergeSessionIntoEngagement(null, "ENG-2", session(), OPTS);
    const round = eng.rounds![0];
    const w = dimensionWeights(round.interviews as never);
    expect(w, "the round cannot supply weights, so every consumer falls back").not.toBeNull();

    // D1 4.0 lead(1.0), D2 4.0 lead(1.0), D4 1.0 light(0.3)
    // (4+4+0.3) / 2.3 = 3.60  vs a plain mean of 3.0
    expect(overallOf(round.scores as never, w)).toBe(3.6);
    expect(overallOf(round.scores as never)).toBe(3.0);
  });

  it("it is carried for INITIAL interviews, not only refreshes", () => {
    /*
     * coverageByDim beside it is gated on isRefresh, because coverage only
     * means something for a re-interview. Copying that gate onto dimTiers would
     * have left every initial interview — i.e. round 1 of every engagement —
     * unweighted.
     */
    const eng = mergeSessionIntoEngagement(null, "ENG-3", session({ isRefresh: false }), OPTS);
    const iv = eng.rounds![0].interviews[0] as Record<string, unknown>;
    expect(iv.dimTiers).toEqual(TIERS);
  });

  it("a legacy blob with no tiering still merges, and falls back", () => {
    const s = session();
    delete (s as Record<string, unknown>).dimTiers;
    const eng = mergeSessionIntoEngagement(null, "ENG-4", s, OPTS);
    const round = eng.rounds![0];
    expect((round.interviews[0] as Record<string, unknown>).dimTiers).toBeNull();
    expect(dimensionWeights(round.interviews as never)).toBeNull();
    expect(overallOf(round.scores as never, null)).toBe(overallOf(round.scores as never));
  });
});

describe("v5.34.93 — the tiering is sanitised, because the blob is not ours", () => {
  /*
   * PUT /api/interviews/mine/state accepts z.record(z.string()) by design, so
   * every field here is authored by the interviewee's browser — and this one
   * lands in the weights behind the client's headline number.
   *
   * Worth stating plainly what this does and does not buy: the SCORES arrive in
   * the same blob and are accepted as given, so anyone able to forge a tiering
   * can already forge the number it weights. Sanitising keeps the value
   * well-formed and bounded; it is not a trust boundary, and the trust boundary
   * is unchanged by this version.
   */
  const merged = (over: Partial<SessionRecord>) =>
    (mergeSessionIntoEngagement(null, "ENG-X", session(over), OPTS)
      .rounds![0].interviews[0] as Record<string, unknown>).dimTiers;

  it("drops tier names the scoring has never heard of", () => {
    expect(merged({ dimTiers: { D1: "lead", D2: "critical", D3: "MUST" } as never }))
      .toEqual({ D1: "lead" });
  });

  it("drops keys that are not one of the seven dimensions", () => {
    expect(merged({ dimTiers: { D1: "lead", D9: "lead", __proto__: "lead", overall: "lead" } as never }))
      .toEqual({ D1: "lead" });
  });

  it("drops non-string values rather than coercing them", () => {
    expect(merged({ dimTiers: { D1: "lead", D2: 1, D3: null, D4: ["lead"] } as never }))
      .toEqual({ D1: "lead" });
  });

  it("a tiering with nothing usable in it becomes null, not an empty object", () => {
    // {} and null behave identically downstream; one representation, not two.
    expect(merged({ dimTiers: { D1: "nonsense" } as never })).toBeNull();
    expect(merged({ dimTiers: {} as never })).toBeNull();
    expect(merged({ dimTiers: "lead" as never })).toBeNull();
    expect(merged({ dimTiers: null as never })).toBeNull();
  });

  it("sanitizeIntervieweeSession still forces the role the CONSULTANT set", () => {
    /*
     * Not a new assertion — it guards the interaction. The tiering is derived
     * in the browser FROM the role, and the role is the upsert identity, so if
     * that ever stopped being overridden a forged blob could re-key the record
     * and bring a matching tiering with it.
     */
    const s = sanitizeIntervieweeSession(
      session({ stakeholderRole: "CEO", client: "Somebody Else" }),
      { client: "Meridian", role: "CTO", name: "Priya Raman" },
    );
    expect(s.stakeholderRole).toBe("CTO");
    expect(s.client).toBe("Meridian");
  });
});

describe("v5.34.93 — a mixed round behaves predictably", () => {
  it("one legacy interview in the round disables weighting for all of it", () => {
    /*
     * Pinned deliberately. This is the cost of the all-or-nothing rule, and it
     * means an engagement that began before v5.34.92 keeps the plain mean until
     * every interview in the round has been re-run — which is the correct
     * outcome (no delivered number moves under a consultant's feet) but is the
     * kind of behaviour that reads as a bug when met in the wild.
     */
    let eng: EngagementRecord | null = null;
    eng = mergeSessionIntoEngagement(eng, "ENG-5", session(), OPTS);
    const legacy = session({ stakeholderRole: "CFO", stakeholderName: "Dan" });
    delete (legacy as Record<string, unknown>).dimTiers;
    eng = mergeSessionIntoEngagement(eng, "ENG-5", legacy, { ...OPTS, sourceInterviewId: "iv-2" });

    const round = eng.rounds![0];
    expect(round.interviews.length).toBe(2);
    expect(dimensionWeights(round.interviews as never)).toBeNull();
  });
});

/**
 * ── THE SEAM ITSELF ─────────────────────────────────────────────────────────
 *
 * Two builders construct the same interview record — interview_agent.html's
 * writeInterviewToEngagement() for a consultant-run interview, and
 * engagementMerge.ts's mergeSessionIntoEngagement() for an interviewee-run one
 * — and every consumer downstream reads whichever one happened to write it.
 *
 * This exact seam has now produced three defects:
 *
 *   v5.32.59  coverageByDim reached the SERVER builder but not the browser's
 *             (fixed server-side then; the browser half was still missing when
 *             this test was written, and is fixed in v5.34.93).
 *   v5.34.92  dimTiers reached the BROWSER builder but not the server's.
 *   v5.34.93  the coverageByDim half above, found by diffing the two field
 *             lists rather than by any test failing.
 *
 * Each was invisible because both sides were individually correct. So the test
 * is the DIFFERENCE between them, not either one: a field added to either
 * builder must be added to the other, or named here as deliberately one-sided.
 */
describe("v5.34.93 — the two interview-record builders do not drift", () => {
  const srv = readFileSync(join(root, "backend", "src", "tenant", "engagementMerge.ts"), "utf8");

  /** Top-level keys of an object literal, ignoring anything nested deeper. */
  function literalFields(src: string, open: string): Set<string> {
    const at = src.indexOf(open);
    expect(at, `could not find "${open}" — update this test`).toBeGreaterThan(-1);
    const end = src.indexOf("\n  };", at);
    expect(end, "could not find the end of the literal").toBeGreaterThan(at);
    const body = src.slice(at, end);
    return new Set([...body.matchAll(/^\s{2,6}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
  }

  /**
   * Fields that legitimately exist on ONE side only, each with the reason.
   * Adding to this list is the deliberate act the test exists to force; adding
   * to it without a reason is how the guard becomes decoration.
   */
  const SERVER_ONLY = new Set([
    // Auto-flow bookkeeping. A consultant-run interview has no invite row
    // behind it, so none of these have a value to carry.
    "sourceInterviewId",
    "followUp",
    "parentInterviewId",
    "distributed",
  ]);
  const BROWSER_ONLY = new Set<string>([]);

  it("every field is written by BOTH builders, or is listed as one-sided", () => {
    const browser = literalFields(page, "var ivRecord = {");
    const server = literalFields(srv, "const ivRecord: Record<string, unknown> = {");

    expect(browser.size, "the browser builder parsed as near-empty — the test is broken, not the code")
      .toBeGreaterThan(10);
    expect(server.size).toBeGreaterThan(10);

    const missingFromServer = [...browser].filter((f) => !server.has(f) && !BROWSER_ONLY.has(f));
    const missingFromBrowser = [...server].filter((f) => !browser.has(f) && !SERVER_ONLY.has(f));

    expect(
      missingFromServer,
      "these fields are written by a CONSULTANT-run interview and lost by an interviewee-run one. " +
      "Add them to mergeSessionIntoEngagement (sanitised — that blob is interviewee-authored), " +
      "or to BROWSER_ONLY with the reason.",
    ).toEqual([]);

    expect(
      missingFromBrowser,
      "these fields are written by an interviewee-run interview and lost by a CONSULTANT-run one. " +
      "Add them to writeInterviewToEngagement, or to SERVER_ONLY with the reason.",
    ).toEqual([]);
  });

  it("coverageByDim specifically — the v5.32.59 defect, on the other side", () => {
    /*
     * Called out on its own because the field-diff above would go green if
     * someone "resolved" it by adding coverageByDim to SERVER_ONLY. It is not
     * bookkeeping: it is the refresh blend weight, and losing it silently
     * understates how far a client has moved.
     */
    const from = page.indexOf("var ivRecord = {");
    const rec = page.slice(from, page.indexOf("\n  };", from));
    expect(rec, "a consultant-run refresh writes no coverage, so the blend takes the 0.3 default")
      .toMatch(/coverageByDim:\s*S\.isRefreshMode\s*\?/);
  });

  it("and losing it is worth 0.6 on a fully re-covered dimension", () => {
    /*
     * The consequence, as a number, so the test says why it matters rather
     * than only that a string is present. Prior 3.3, refresh scores 4.5 having
     * covered 80% of the dimension.
     */
    const prior = { D1: 3.3 };
    const opts = { priorScores: prior, isRefreshRound: true, roleWeight: () => 1 };
    const kept = computeRoundScores(
      [{ role: "CTO", isRefresh: true, scores: { D1: 4.5 }, coverageByDim: { D1: 0.8 } }],
      opts as never,
    );
    const lost = computeRoundScores(
      [{ role: "CTO", isRefresh: true, scores: { D1: 4.5 } }],
      opts as never,
    );
    expect(kept.scores.D1).toBe(4.3);
    expect(lost.scores.D1).toBe(3.7);   // DEFAULT_COVERAGE_WEIGHT = 0.3
  });
});
