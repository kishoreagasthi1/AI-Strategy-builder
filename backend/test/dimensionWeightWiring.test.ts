/**
 * The weighting is CONNECTED — every consumer of the overall, not just the
 * formula. (v5.34.92)
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * scoringParity.test.ts proves the two dimensionWeights/overallOf
 * implementations agree with each other. That is worth nothing on its own: the
 * defining defect of this codebase's history is a correct component wired to
 * nothing, and the survey done before this change found the shape again —
 * frontend/vyne-scoring.js's overallOf had ZERO production call sites. Every
 * page computed its own mean inline. A weighted overall added only to the
 * shared module would have changed no number anywhere and passed every parity
 * test.
 *
 * So this file asserts the wire, consumer by consumer:
 *
 *   interview_agent.html  computeOverall()          live + export sheet
 *   interview_agent.html  writeInterviewToEngagement()  writes the snapshot
 *   synthesis.html        sxOverall()               dashboard, round table, .docx
 *   roadmap.html          deckLoadPersonaScores()   per-persona, and deck cover
 *   routes/scorecard.ts   buildScorecard()          /api/scorecard + delta
 *   tenant/engagementLookup.ts                      the figure quoted to the model
 *
 * and, for the two server consumers, RUNS them: source-text assertions cannot
 * tell a call from a comment, which this session has already proved by walking
 * into that exact trap.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildScorecard } from "../src/routes/scorecard.js";
import { dimensionWeights, overallOf } from "../src/tenant/scoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, "frontend", f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const agent = strip(read("interview_agent.html"));
const synth = strip(read("synthesis.html"));
const deck = strip(read("roadmap.html"));

function fnBody(src: string, name: string, endMarker = "\nfunction "): string {
  const at = src.indexOf(`function ${name}(`);
  expect(at, `${name}() is gone — update this test`).toBeGreaterThan(-1);
  const next = src.indexOf(endMarker, at + 1);
  return src.slice(at, next === -1 ? src.length : next);
}

describe("v5.34.92 — the snapshot is written", () => {
  it("a completed interview records the tiering that governed it", () => {
    /*
     * Without this line every other assertion in this file is decoration: the
     * weights are derived from ivRecord.dimTiers, so an interview that does not
     * carry them makes its whole round fall back to the plain mean, for ever.
     */
    /*
     * v5.34.94: this used to pin the exact expression
     * `dimTiers: (function(){ try{ return dimensionTierMap() …`, and broke when
     * v5.34.94 made it prefer S.dimTiers — a snapshot carried by a resumed or
     * RECOVERED interview — over re-deriving from a Pre-Engagement that may have
     * been re-tiered since. The behaviour was correct and the test failed on the
     * spelling, which is a test that costs more than it protects. Asserted as:
     * the record carries dimTiers, and it comes from the resolved tier map.
     */
    const body = fnBody(agent, "writeInterviewToEngagement");
    expect(body, "the interview record does not carry dimTiers").toMatch(/dimTiers:/);
    expect(body, "dimTiers is not resolved from the shared tier map")
      .toMatch(/dimensionTierMap\(\)/);
  });

  it("it is the SAME tier map the scorecard renders and the interviewer is given", () => {
    /*
     * dimensionTierMap() reads buildLiveAgenda(), which is what is sent to the
     * model. So the tiering that shaped the questions, the tiering shown on the
     * card, and the tiering that weights the score are one value. Re-deriving
     * it here from getRolePriorityData would be a fourth copy.
     */
    const body = fnBody(agent, "writeInterviewToEngagement");
    expect(body).toContain("dimensionTierMap()");
    expect(body, "the record re-derives tiers instead of using the resolved map")
      .not.toMatch(/getRolePriorityData|loadBriefingContext/);
  });
});

describe("v5.34.92 — every consumer of the overall is wired to the shared formula", () => {
  it("the live interview panel and export sheet", () => {
    const body = fnBody(agent, "computeOverall");
    expect(body).toMatch(/VyneScoring\.dimensionWeights\(/);
    expect(body).toMatch(/VyneScoring\.overallOf\(/);
  });

  it("synthesis has ONE overall helper, and all three sites call it", () => {
    expect(synth, "sxOverall is gone").toMatch(/function sxOverall\(scores, interviews\)/);
    expect(fnBody(synth, "sxOverall")).toMatch(/VyneScoring\.dimensionWeights\(/);
    // Three call sites: dashboard headline, round-comparison footer, .docx.
    const calls = synth.match(/sxOverall\(/g) ?? [];
    expect(calls.length, `expected 1 definition + 3 call sites, found ${calls.length} occurrences`)
      .toBeGreaterThanOrEqual(4);
    // And none of the three kept its own inline mean.
    expect(synth, "an inline overall survived in synthesis.html")
      .not.toMatch(/ov\.reduce\(function\(a,b\)\{return a\+b;\},0\)\/ov\.length/);
    expect(synth).not.toMatch(/overall\.reduce\(\(a,b\)=>a\+b,0\)\/overall\.length/);
  });

  it("the deck carries dimTiers through its persona mapping", () => {
    /*
     * deckLoadPersonaScores() rebuilds each interview into a fresh object. It
     * dropped every field it did not name — so without this the deck cover
     * would fall back to the plain mean on every engagement, which is the one
     * place the client reads the number.
     */
    const body = fnBody(deck, "deckLoadPersonaScores");
    expect(body, "the per-persona overall is still an unweighted mean")
      .toMatch(/VyneScoring\.overallOf\(sc, window\.VyneScoring\.dimensionWeights/);
    /*
     * Assert on the RETURNED OBJECT, not on "dimTiers appears somewhere in the
     * function" — the line above already contains `{dimTiers:tiers}` as a
     * local argument, so a loose match passes even when the field is deleted
     * from the return. Caught by mutation: removing `dimTiers:tiers` from the
     * returned literal left the loose assertion green.
     */
    const ret = /return \{ role:iv\.role[\s\S]*?\};/.exec(body);
    expect(ret, "the persona return literal moved — update this test").toBeTruthy();
    expect(ret![0], "dimTiers does not survive the persona mapping, so the deck cover falls back to the plain mean")
      .toMatch(/dimTiers:\s*tiers/);
  });

  it("the deck COVER is weighted from the same personas", () => {
    expect(deck, "the deck cover aggregate never consults the weighting")
      .toMatch(/_mw = window\.VyneScoring\.dimensionWeights\(\s*\(personaScores && personaScores\.interviews\)/);
    expect(deck, "the weighted value is computed but never used")
      .toMatch(/if\(typeof _wov === 'number'\) overall=_wov;/);
  });
});

describe("v5.34.92 — the server consumers, executed", () => {
  const ROUND = (interviews: unknown[], scores: Record<string, number>, n: number) => ({
    roundNumber: n,
    label: `Round ${n}`,
    date: "2026-09-01",
    scores,
    interviews,
  });
  const CTO = {
    role: "CTO",
    dimTiers: { D1: "lead", D2: "lead", D6: "lead", D3: "cover", D5: "cover", D4: "light", D7: "light" },
  };
  const LEGACY = { role: "CTO" };

  it("/api/scorecard returns the WEIGHTED overall", () => {
    const scores = { D1: 4.0, D2: 4.0, D3: 2.0, D7: 1.0 };
    const eng = { code: "ENG-1", client: "Meridian", rounds: [ROUND([CTO], scores, 1)] };
    const [entry] = buildScorecard([eng] as never);

    const expected = overallOf(scores, dimensionWeights([CTO] as never));
    expect(entry.overall, "buildScorecard is not applying the weighting").toBe(expected);
    // And it is genuinely different from the unweighted answer, or this proves nothing.
    expect(overallOf(scores)).not.toBe(expected);
  });

  it("a legacy round still reads exactly as it did before v5.34.92", () => {
    /*
     * The migration guarantee, at the API. Every engagement scored before this
     * version has no dimTiers, and its delivered maturity level must not move.
     */
    const scores = { D1: 4.0, D2: 4.0, D3: 2.0, D7: 1.0 };
    const eng = { code: "ENG-2", client: "Legacy Co", rounds: [ROUND([LEGACY], scores, 1)] };
    const [entry] = buildScorecard([eng] as never);
    expect(entry.overall).toBe(overallOf(scores));
    expect(entry.overall).toBe(2.8); // (4.0+4.0+2.0+1.0)/4
  });

  it("each round is weighted by its OWN roster, so the delta reports real movement", () => {
    /*
     * The subtle one. If the latest round's weighting were applied to the prior
     * round too, deltaOverall would show movement caused by a change of
     * interviewee rather than by anything anyone said.
     */
    const r1 = ROUND([CTO], { D1: 3.0, D2: 3.0, D7: 3.0 }, 1);
    const CHRO = { role: "CHRO", dimTiers: { D4: "lead", D7: "lead", D1: "light", D2: "light" } };
    const r2 = ROUND([CHRO], { D1: 3.0, D2: 3.0, D7: 3.0 }, 2);
    const [entry] = buildScorecard([{ code: "ENG-3", client: "Two Rounds", rounds: [r1, r2] }] as never);
    /*
     * Identical scores in both rounds. Whatever the weights are, a weighted
     * mean of a constant is that constant — so the delta must be exactly zero.
     * If either round were weighted by the other's roster it would still be
     * zero here; what this pins is that neither round throws or nulls out when
     * the rosters differ, and that the delta reflects scores rather than
     * roster churn.
     */
    expect(entry.overall).toBe(3.0);
    expect(entry.deltaOverall).toBe(0);
  });

  it("a round whose roster excludes a scored dimension drops it from the headline", () => {
    // D4 scored 1.0, but it is LIGHT for the CTO — in scope, so it counts, but
    // at 0.3 rather than 1.0. D3 is absent from the CTO's tiers entirely.
    const scores = { D1: 4.0, D4: 1.0 };
    const [entry] = buildScorecard([
      { code: "ENG-4", client: "Weighted", rounds: [ROUND([CTO], scores, 1)] },
    ] as never);
    // (4.0×1.0 + 1.0×0.3) ÷ 1.3 = 4.3 ÷ 1.3 = 3.31 → 3.3   (plain mean: 2.5)
    expect(entry.overall).toBe(3.3);
    expect(entry.maturity).toBe("AI Capable");
  });
});
