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
