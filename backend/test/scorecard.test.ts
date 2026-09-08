/**
 * Scorecard aggregation — pure-function coverage for src/routes/scorecard.ts
 * (the HTTP route itself is a thin, client-scoped wrapper over this; scoping
 * behavior is the same allowedClientNorms()/normClient() pattern already
 * covered for every other module in test/clients.test.ts).
 */
import { describe, it, expect } from "vitest";
import { buildScorecard, maturityLabel, overallOf } from "../src/routes/scorecard.js";

describe("overallOf / maturityLabel", () => {
  it("averages present dimensions and rounds to one decimal", () => {
    expect(overallOf({ D1: 3, D2: 4 })).toBeCloseTo(3.5);
  });
  it("returns null with no scores", () => {
    expect(overallOf(undefined)).toBeNull();
    expect(overallOf({})).toBeNull();
  });
  it("maps overall scores to the same bands as interview_agent.html's MATURITY table", () => {
    expect(maturityLabel(4.6)).toBe("AI-Native");
    expect(maturityLabel(3.6)).toBe("AI-Led");
    expect(maturityLabel(2.6)).toBe("AI Capable");
    expect(maturityLabel(1.6)).toBe("AI Exploring");
    expect(maturityLabel(0.5)).toBe("AI Unaware");
    expect(maturityLabel(null)).toBeNull();
  });
});

describe("buildScorecard", () => {
  it("skips engagements with no rounds", () => {
    expect(buildScorecard([{ code: "X", client: "Empty Co", rounds: [] }])).toHaveLength(0);
  });

  it("reports the latest round's scores, overall, and maturity", () => {
    const [entry] = buildScorecard([{
      code: "ACME-1", client: "Acme", industry: "Manufacturing",
      rounds: [{ roundNumber: 1, label: "Initial", date: "2026-01-01", scores: { D1: 3, D2: 3 }, interviews: [1, 2] }],
    }]);
    expect(entry.overall).toBeCloseTo(3.0);
    expect(entry.maturity).toBe("AI Capable");
    expect(entry.interviewCount).toBe(2);
    expect(entry.deltaOverall).toBeNull(); // no prior round to compare
  });

  it("computes deltas against the immediately prior round, per dimension and overall", () => {
    const [entry] = buildScorecard([{
      code: "ACME-1", client: "Acme",
      rounds: [
        { roundNumber: 1, scores: { D1: 2.0, D2: 2.0 } },
        { roundNumber: 2, scores: { D1: 3.0, D2: 1.5 } },
      ],
    }]);
    // Round 2 overall (3.0+1.5)/2=2.25 rounds to 2.3; Round 1 overall is 2.0.
    expect(entry.deltaOverall).toBeCloseTo(0.3);
    expect(entry.deltaScores.D1).toBeCloseTo(1.0);
    expect(entry.deltaScores.D2).toBeCloseTo(-0.5);
  });

  it("sorts by client name", () => {
    const out = buildScorecard([
      { code: "B", client: "Zeta Co", rounds: [{ roundNumber: 1, scores: { D1: 3 } }] },
      { code: "A", client: "Acme", rounds: [{ roundNumber: 1, scores: { D1: 3 } }] },
    ]);
    expect(out.map((e) => e.client)).toEqual(["Acme", "Zeta Co"]);
  });
});

describe("buildScorecard — the portfolio card must not go blank (v5.32.59, F21/F23)", () => {
  it("keeps showing the last SCORED round after the next one is planned", () => {
    /* A round is created empty the moment a consultant plans it. This used to
     * take the last round outright, so planning round 3 replaced a fully
     * assessed client's portfolio row with blanks and a null maturity band —
     * the day after the assessment. */
    const [entry] = buildScorecard([{
      code: "ACME-1", client: "Acme",
      rounds: [
        { roundNumber: 1, scores: { D1: 2.0, D2: 2.0 } },
        { roundNumber: 2, scores: { D1: 3.0, D2: 3.0 } },
        { roundNumber: 3, scores: {} },            // planned, nobody interviewed yet
      ],
    }]);
    expect(entry.roundNumber).toBe(2);
    expect(entry.scores.D1).toBe(3.0);
    expect(entry.overall).toBe(3.0);
    expect(entry.maturity).toBe("AI Capable");
    // And the delta still compares two SCORED rounds, not "round 2 vs nothing".
    expect(entry.deltaOverall).toBeCloseTo(1.0);
  });

  it("orders by round NUMBER even when the array is in completion order", () => {
    // v5.32.55 lets a consultant pin round 3 before round 2 completes, so the
    // stored array really does arrive as [1, 3, 2].
    const [entry] = buildScorecard([{
      code: "ACME-1", client: "Acme",
      rounds: [
        { roundNumber: 1, scores: { D1: 1 } },
        { roundNumber: 3, scores: { D1: 3 } },
        { roundNumber: 2, scores: { D1: 2 } },
      ],
    }]);
    expect(entry.roundNumber).toBe(3);
    expect(entry.scores.D1).toBe(3);
    expect(entry.deltaScores.D1).toBeCloseTo(1);   // vs round 2, not round 1
  });

  it("does not let a round with no roundNumber scramble the ordering", () => {
    /* `a.roundNumber - b.roundNumber` on a missing field is NaN, and a
     * comparator that returns NaN leaves V8 free to produce any order — so for
     * records written before roundNumber existed, "latest" was arbitrary. */
    const [entry] = buildScorecard([{
      code: "OLD-1", client: "Legacy Co",
      rounds: [
        { roundNumber: undefined as unknown as number, scores: { D1: 1 } },
        { roundNumber: undefined as unknown as number, scores: { D1: 2 } },
        { roundNumber: undefined as unknown as number, scores: { D1: 3 } },
      ],
    }]);
    expect(entry.scores.D1).toBe(3);   // creation order preserved
  });

  it("omits an engagement whose only round is an empty planned one", () => {
    // Nothing measured is not the same as measured-at-zero; the row would
    // otherwise read as a real assessment with no findings.
    expect(buildScorecard([{
      code: "NEW-1", client: "Newco", rounds: [{ roundNumber: 1, scores: {} }],
    }])).toEqual([]);
  });

  it("treats a stored 0 as no evidence, matching every other module", () => {
    const [entry] = buildScorecard([{
      code: "ACME-1", client: "Acme",
      rounds: [{ roundNumber: 1, scores: { D1: 4, D2: 4, D3: 0 } }],
    }]);
    // Not (4+4+0)/3 = 2.7 "AI Capable" — which is what this used to say while
    // the dashboard showed 4.0 "AI-Led" for the same engagement.
    expect(entry.overall).toBe(4.0);
    expect(entry.maturity).toBe("AI-Led");
  });
});
