/**
 * scoringParity.test.ts — proves the browser and the server compute the same
 * score, to the decimal place, for the same round.
 *
 * v5.32.59 (F6/F23). The product has two runtimes and neither can import the
 * other's code, so "one formula" can only be a claim unless something executes
 * both and compares. This does: it evaluates frontend/vyne-scoring.js in a
 * real VM with a stub window, imports backend/src/tenant/scoring.ts, and runs
 * every case through both.
 *
 * The randomised battery matters more than the fixed cases. The original
 * divergence was NOT visible on tidy inputs — both implementations agreed on
 * "CEO 4, CTO 3" and disagreed only where a weighted mean landed on an exact
 * half at the second decimal, or where a coverage weight was reported by some
 * interviews and not others. Those are the shapes a hand-written case list
 * does not think to include.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import * as srv from "../src/tenant/scoring.js";
import { roleWeight } from "../src/tenant/engagementMerge.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const scoringPath = path.resolve(here, "../../frontend/vyne-scoring.js");

/** Load the browser module the way a browser would, minus the browser. */
function loadBrowserScoring(): any {
  const src = readFileSync(scoringPath, "utf8");
  const sandbox: any = { module: { exports: {} }, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: scoringPath });
  const api = sandbox.module.exports;
  if (!api || typeof api.computeRoundScores !== "function") {
    throw new Error("vyne-scoring.js did not export computeRoundScores");
  }
  // Same shape must also have landed on window, or the pages that rely on the
  // global would get a ReferenceError at runtime while this test passed.
  if (!sandbox.VyneScoring || sandbox.VyneScoring !== api) {
    throw new Error("vyne-scoring.js did not publish window.VyneScoring");
  }
  return api;
}

const web = loadBrowserScoring();

/* Both sides get the SAME weight function so this test isolates the formula.
 * Weight-table parity is roleWeightParity.test.ts's job; if that regressed,
 * mixing the two failures here would make neither diagnosable. */
const rw = (dim: string, role: string | undefined) => roleWeight(dim, role);

const ROLES = [
  "CEO", "CTO", "CFO", "COO", "CDO", "CHRO", "IT_Director", "VP_Sales",
  "Operations_Manager", "General_Counsel",
  "COO / VP Operations", "Operations / Frontline Manager", "Chief Vibes Officer", "",
];

/** Deterministic LCG — a failing run must be reproducible. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomInterviews(rnd: () => number, n: number, withCoverage: boolean) {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const scores: Record<string, number> = {};
    const coverageByDim: Record<string, number> = {};
    for (const d of srv.DIMS) {
      const r = rnd();
      if (r < 0.15) continue;                       // dimension not asked
      if (r < 0.22) { scores[d] = 0; continue; }    // explicit "no evidence"
      // Quarter-point scores land on exact .x5 halves after weighting far more
      // often than random floats do — which is where toFixed and Math.round
      // used to part company.
      scores[d] = Math.round(rnd() * 16 + 4) / 4;
      if (withCoverage && rnd() < 0.7) coverageByDim[d] = Math.round(rnd() * 20) / 20;
    }
    const iv: any = { role: ROLES[Math.floor(rnd() * ROLES.length)], scores };
    if (withCoverage) {
      iv.isRefresh = true;
      if (Object.keys(coverageByDim).length) iv.coverageByDim = coverageByDim;
    }
    out.push(iv);
  }
  return out;
}

function randomPrior(rnd: () => number): Record<string, number> {
  const p: Record<string, number> = {};
  for (const d of srv.DIMS) {
    if (rnd() < 0.25) continue;
    p[d] = Math.round(rnd() * 40 + 10) / 10;
  }
  return p;
}

describe("scoring parity — frontend/vyne-scoring.js vs backend/src/tenant/scoring.ts", () => {
  it("exposes the same surface", () => {
    for (const fn of [
      "computeRoundScores", "isRefreshRound", "sortRounds", "latestRound",
      "latestScoredRound", "priorRoundsBefore", "priorScoresFor",
      "lowestRoundNumber", "nextRoundNumber", "overallOf", "round1", "round2",
      "dimensionWeights",
    ]) {
      expect(typeof web[fn], `frontend is missing ${fn}`).toBe("function");
      expect(typeof (srv as any)[fn], `backend is missing ${fn}`).toBe("function");
    }
    expect(web.DIMS).toEqual([...srv.DIMS]);
    expect(web.DEFAULT_COVERAGE_WEIGHT).toBe(srv.DEFAULT_COVERAGE_WEIGHT);
    /* v5.34.92: the tier→weight table is the new thing that can drift, and it
     * is three numbers, so it would drift silently and be visible only as a
     * client's overall differing between the browser and /api/scorecard. */
    expect(web.TIER_WEIGHT).toEqual(srv.TIER_WEIGHT);
  });

  it("agrees on 400 randomised rounds (no coverage reported)", () => {
    const rnd = lcg(20250801);
    for (let t = 0; t < 400; t++) {
      const ivs = randomInterviews(rnd, 1 + Math.floor(rnd() * 6), false);
      const prior = randomPrior(rnd);
      const isRefresh = rnd() < 0.5;
      const a = srv.computeRoundScores(ivs, { priorScores: prior, isRefreshRound: isRefresh, roleWeight: rw });
      const b = web.computeRoundScores(ivs, { priorScores: prior, isRefreshRound: isRefresh, roleWeight: rw });
      expect(b.scores, `case ${t}`).toEqual(a.scores);
      expect(b.blend, `case ${t} blend`).toEqual(a.blend);
      expect(b.carried, `case ${t} carried`).toEqual(a.carried);
      expect(b.measured, `case ${t} measured`).toEqual(a.measured);
    }
  });

  it("agrees on 400 randomised refresh rounds with partial coverage", () => {
    const rnd = lcg(864231);
    for (let t = 0; t < 400; t++) {
      const ivs = randomInterviews(rnd, 1 + Math.floor(rnd() * 6), true);
      const prior = randomPrior(rnd);
      const a = srv.computeRoundScores(ivs, { priorScores: prior, isRefreshRound: true, roleWeight: rw });
      const b = web.computeRoundScores(ivs, { priorScores: prior, isRefreshRound: true, roleWeight: rw });
      expect(b.scores, `case ${t}`).toEqual(a.scores);
      expect(b.blend, `case ${t} blend`).toEqual(a.blend);
    }
  });

  it("agrees on round ordering for 300 randomised round arrays", () => {
    const rnd = lcg(551);
    for (let t = 0; t < 300; t++) {
      const rounds: any[] = [];
      const n = Math.floor(rnd() * 6);
      for (let i = 0; i < n; i++) {
        const r: any = { roundId: "r" + i, scores: rnd() < 0.4 ? {} : { D1: 3 } };
        if (rnd() < 0.85) r.roundNumber = 1 + Math.floor(rnd() * 5); // duplicates on purpose
        rounds.push(r);
      }
      expect(web.sortRounds(rounds).map((r: any) => r.roundId))
        .toEqual(srv.sortRounds(rounds).map((r) => r.roundId));
      expect(web.latestRound(rounds)?.roundId ?? null).toEqual(srv.latestRound(rounds)?.roundId ?? null);
      expect(web.latestScoredRound(rounds)?.roundId ?? null).toEqual(srv.latestScoredRound(rounds)?.roundId ?? null);
      expect(web.nextRoundNumber(rounds)).toBe(srv.nextRoundNumber(rounds));
      expect(web.lowestRoundNumber(rounds)).toBe(srv.lowestRoundNumber(rounds));
      expect(web.priorScoresFor(rounds, 4)).toEqual(srv.priorScoresFor(rounds, 4));
    }
  });

  it("agrees on overall across randomised score sets", () => {
    const rnd = lcg(99991);
    for (let t = 0; t < 300; t++) {
      const s = randomPrior(rnd);
      if (rnd() < 0.2) s.D3 = 0;
      expect(web.overallOf(s)).toBe(srv.overallOf(s));
    }
  });

  /* ── v5.34.92: the WEIGHTED overall ────────────────────────────────────────
   *
   * The weighted path is the one a client actually sees — it feeds the deck
   * cover, the Word document, the portfolio card and the figure quoted to the
   * model as the client's measured maturity. Two implementations, four
   * consumers, so it gets the same randomised treatment as computeRoundScores
   * rather than a couple of hand-picked cases.
   */
  it("agrees on dimensionWeights across randomised rosters", () => {
    const rnd = lcg(4242);
    const TIERS = ["lead", "cover", "light", "off", undefined] as const;
    for (let t = 0; t < 400; t++) {
      const n = 1 + Math.floor(rnd() * 4);
      const interviews: any[] = [];
      for (let i = 0; i < n; i++) {
        // 15% of interviews are legacy — no dimTiers at all. The whole round
        // must then fall back, and both sides must fall back identically.
        if (rnd() < 0.15) { interviews.push({ role: "CTO" }); continue; }
        const dimTiers: Record<string, string> = {};
        for (const d of srv.DIMS) {
          const pick = TIERS[Math.floor(rnd() * TIERS.length)];
          if (pick !== undefined) dimTiers[d] = pick;   // "off" is a tier name nothing recognises → weight 0
        }
        interviews.push({ role: "CTO", dimTiers });
      }
      expect(web.dimensionWeights(interviews)).toEqual(srv.dimensionWeights(interviews));
    }
  });

  it("agrees on the WEIGHTED overall across randomised score sets", () => {
    const rnd = lcg(777001);
    const TIERS = ["lead", "cover", "light"] as const;
    for (let t = 0; t < 400; t++) {
      const s = randomPrior(rnd);
      if (rnd() < 0.2) s.D3 = 0;
      const interviews: any[] = [];
      const n = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const dimTiers: Record<string, string> = {};
        for (const d of srv.DIMS) if (rnd() < 0.8) dimTiers[d] = TIERS[Math.floor(rnd() * 3)];
        interviews.push({ dimTiers });
      }
      const wWeb = web.dimensionWeights(interviews);
      const wSrv = srv.dimensionWeights(interviews);
      expect(wWeb).toEqual(wSrv);
      expect(web.overallOf(s, wWeb)).toBe(srv.overallOf(s, wSrv));
    }
  });

  it("omitting the weights is EXACTLY today's plain mean, on both sides", () => {
    /*
     * The migration guarantee. Every call site that does not opt in must be
     * bit-identical to v5.34.91, or the version that added weighting silently
     * restated numbers that had already been delivered to clients.
     */
    const rnd = lcg(13579);
    for (let t = 0; t < 300; t++) {
      const s = randomPrior(rnd);
      expect(web.overallOf(s, null)).toBe(web.overallOf(s));
      expect(web.overallOf(s, undefined)).toBe(web.overallOf(s));
      expect(srv.overallOf(s, null)).toBe(srv.overallOf(s));
      expect(srv.overallOf(s, undefined)).toBe(srv.overallOf(s));
    }
  });
});

describe("v5.34.92 — dimension weighting, derived from the tiers already set", () => {
  const tiers = (o: Record<string, string>) => ({ dimTiers: o });

  it("sums lead/cover/light across the roles interviewed", () => {
    const w = srv.dimensionWeights([
      tiers({ D1: "lead", D2: "lead", D3: "cover", D6: "lead" }),          // CTO-shaped
      tiers({ D1: "cover", D3: "lead", D5: "lead", D6: "lead" }),          // CFO-shaped
    ]);
    expect(w).not.toBeNull();
    expect(w!.D1).toBeCloseTo(1.6);   // lead + cover
    expect(w!.D6).toBeCloseTo(2.0);   // lead + lead
    expect(w!.D3).toBeCloseTo(1.6);   // cover + lead
    expect(w!.D4, "a dimension nobody tiered is excluded, not light").toBe(0);
  });

  it("a dimension excluded by everyone leaves the mean, it does not score 0", () => {
    const w = srv.dimensionWeights([tiers({ D1: "lead", D2: "lead" })]);
    // D7 carries a low score but is out of scope for every role interviewed.
    expect(srv.overallOf({ D1: 4.0, D2: 4.0, D7: 1.0 }, w)).toBe(4.0);
    // Without weights — i.e. a legacy round — it still drags the number down.
    expect(srv.overallOf({ D1: 4.0, D2: 4.0, D7: 1.0 })).toBe(3.0);
  });

  it("ONE legacy interview disables weighting for the whole round", () => {
    /*
     * All-or-nothing. Weighting a round from the two interviews that happen to
     * carry tiers, and silently ignoring the third, produces a number that is
     * neither the weighted nor the plain mean and that nobody could reconcile
     * against either.
     */
    expect(srv.dimensionWeights([tiers({ D1: "lead" }), { role: "CFO" }])).toBeNull();
    expect(srv.dimensionWeights([{ role: "CFO" }])).toBeNull();
    expect(srv.dimensionWeights([])).toBeNull();
    expect(srv.dimensionWeights(null)).toBeNull();
  });

  it("tiers that exclude every dimension fall back rather than returning zeros", () => {
    // Otherwise overallOf would divide by a zero weight sum and report null —
    // an engagement that HAS scores would render as unassessed.
    expect(srv.dimensionWeights([tiers({})])).toBeNull();
    expect(srv.dimensionWeights([tiers({ D1: "nonsense" })])).toBeNull();
  });

  it("moves a real scorecard by about a tenth, not by a band", () => {
    /*
     * The worked example in docs/SCORING_EXPLAINED.md — CTO + CFO + CHRO on
     * default tiers. Pinned because the honest claim made to the user was
     * "this is a correctness fix, not a re-scoring", and that claim should
     * fail loudly if the weighting ever starts swinging the headline number.
     */
    const round = { D1: 3.3, D2: 3.2, D3: 2.6, D4: 3.2, D5: 2.8, D6: 1.7, D7: 2.8 };
    const w = srv.dimensionWeights([
      tiers({ D2: "lead", D1: "lead", D6: "lead", D3: "cover", D5: "cover", D4: "light", D7: "light" }),
      tiers({ D3: "lead", D6: "lead", D5: "lead", D1: "cover", D2: "light", D4: "light", D7: "light" }),
      tiers({ D4: "lead", D7: "lead", D3: "cover", D5: "cover", D1: "light", D2: "light", D6: "light" }),
    ]);
    expect(srv.overallOf(round)).toBe(2.8);        // plain
    expect(srv.overallOf(round, w)).toBe(2.7);     // weighted
  });
});

describe("scoring — the behaviour the four old implementations disagreed about", () => {
  it("0 means 'no evidence', not a score of zero", () => {
    const r = srv.computeRoundScores(
      [{ role: "CEO", scores: { D3: 4 } }, { role: "CTO", scores: { D3: 0 } }],
      { roleWeight: rw }
    );
    // CEO alone at D3 (weight 1.0) — the zero contributes nothing rather than
    // halving the score.
    expect(r.scores.D3).toBe(4);
  });

  it("weights by role rather than taking a plain mean", () => {
    // D7: CEO 1.0, IT_Director 0.3.  (5*1.0 + 1*0.3) / 1.3 = 4.08 -> 4.1
    const r = srv.computeRoundScores(
      [{ role: "CEO", scores: { D7: 5 } }, { role: "IT_Director", scores: { D7: 1 } }],
      { roleWeight: rw }
    );
    expect(r.scores.D7).toBe(4.1);
    expect(r.scores.D7).not.toBe(3);   // the unweighted answer
  });

  it("does not blend on a first assessment even when a prior score exists", () => {
    // A prior score can exist for a dimension the FIRST round of a re-engagement
    // never measured. Blending there would invent a number.
    const r = srv.computeRoundScores(
      [{ role: "CEO", scores: { D3: 2 } }],
      { priorScores: { D3: 5 }, isRefreshRound: false, roleWeight: rw }
    );
    expect(r.scores.D3).toBe(2);
    expect(r.blend).toEqual({});
  });

  it("blends a refresh round against the prior score using reported coverage", () => {
    // prior 5, raw 2, coverage 0.5  ->  5*0.5 + 2*0.5 = 3.5
    const r = srv.computeRoundScores(
      [{ role: "CEO", scores: { D3: 2 }, coverageByDim: { D3: 0.5 }, isRefresh: true }],
      { priorScores: { D3: 5 }, isRefreshRound: true, roleWeight: rw }
    );
    expect(r.scores.D3).toBe(3.5);
    expect(r.blend.D3).toEqual({ prior: 5, raw: 2, weight: 0.5, blended: 3.5 });
  });

  it("falls back to a low coverage weight when a refresh reports none", () => {
    // prior 5, raw 1, default w=0.3 -> 5*0.7 + 1*0.3 = 3.8
    const r = srv.computeRoundScores(
      [{ role: "CEO", scores: { D3: 1 }, isRefresh: true }],
      { priorScores: { D3: 5 }, isRefreshRound: true, roleWeight: rw }
    );
    expect(r.scores.D3).toBe(3.8);
  });

  it("carries a prior score forward for a dimension this round did not measure", () => {
    const r = srv.computeRoundScores(
      [{ role: "CEO", scores: { D1: 3 } }],
      { priorScores: { D5: 4.2 }, roleWeight: rw }
    );
    expect(r.scores.D5).toBe(4.2);
    expect(r.carried).toEqual(["D5"]);
    expect(r.measured).toEqual(["D1"]);
  });

  it("omits a dimension with no evidence in this round or any prior one", () => {
    const r = srv.computeRoundScores([{ role: "CEO", scores: { D1: 3 } }], { roleWeight: rw });
    expect(Object.keys(r.scores)).toEqual(["D1"]);
    expect("D5" in r.scores).toBe(false);
  });

  it("never produces NaN when every contributing role weighs zero", () => {
    const zero = () => 0;
    const r = srv.computeRoundScores(
      [{ role: "X", scores: { D1: 2 } }, { role: "Y", scores: { D1: 4 } }],
      { roleWeight: zero }
    );
    expect(r.scores.D1).toBe(3);
    expect(Number.isNaN(r.scores.D1)).toBe(false);
  });

  it("orders rounds by number, not by the order interviews happened to complete", () => {
    // v5.32.55 lets a consultant pin round 3 before round 2 exists, so the
    // array really does arrive as [1, 3, 2].
    const rounds = [
      { roundId: "a", roundNumber: 1, scores: { D1: 1 } },
      { roundId: "c", roundNumber: 3, scores: { D1: 3 } },
      { roundId: "b", roundNumber: 2, scores: { D1: 2 } },
    ];
    expect(srv.latestRound(rounds)?.roundId).toBe("c");
    expect(srv.sortRounds(rounds).map((r) => r.roundId)).toEqual(["a", "b", "c"]);
    expect(srv.priorRoundsBefore(rounds, 3).map((r) => r.roundId)).toEqual(["b", "a"]);
  });

  it("latestScoredRound skips a freshly planned empty round (F21)", () => {
    const rounds: srv.RoundLike[] = [
      { roundId: "r1", roundNumber: 1, scores: { D1: 3, D2: 4 } },
      { roundId: "r2", roundNumber: 2, scores: {} },     // planned, nobody interviewed yet
    ];
    expect(srv.latestRound(rounds)?.roundId).toBe("r2");        // for writing
    expect(srv.latestScoredRound(rounds)?.roundId).toBe("r1");  // for displaying
  });

  it("nextRoundNumber does not collide after a round is deleted (F22)", () => {
    const rounds = [{ roundNumber: 1 }, { roundNumber: 3 }];   // round 2 deleted
    expect(srv.nextRoundNumber(rounds)).toBe(4);
    expect(rounds.length + 1).toBe(3);   // what the old code would have said
  });

  it("keeps legacy rounds with no roundNumber in creation order, after numbered ones", () => {
    const rounds = [
      { roundId: "legacyA" },
      { roundId: "n2", roundNumber: 2 },
      { roundId: "legacyB" },
    ];
    expect(srv.sortRounds(rounds).map((r) => r.roundId)).toEqual(["n2", "legacyA", "legacyB"]);
  });

  it("resolves duplicate round numbers to creation order rather than at random", () => {
    const rounds = [
      { roundId: "first", roundNumber: 2, scores: { D1: 1 } },
      { roundId: "second", roundNumber: 2, scores: { D1: 5 } },
    ];
    expect(srv.sortRounds(rounds).map((r) => r.roundId)).toEqual(["first", "second"]);
    expect(srv.latestRound(rounds)?.roundId).toBe("second");
  });

  it("overall is the mean across measured dimensions and ignores zeroes", () => {
    expect(srv.overallOf({ D1: 3, D2: 4, D3: 0 })).toBe(3.5);
    expect(srv.overallOf({})).toBe(null);
    expect(srv.overallOf(null)).toBe(null);
  });

  /**
   * A role held by SEVERAL people counts once per person (v5.32.86).
   *
   * Stated here because it was never stated anywhere: the weight belongs to
   * the ROLE and every interview receives it, so three divisional COOs carry
   * three times the weight of a single-holder role. That is the intended
   * behaviour — three executives are three observations, and averaging them
   * into one "COO opinion" would erase the disagreement between divisions,
   * which is frequently the finding. The alternative, one vote per role, would
   * make a score depend on how a firm slices its org chart.
   *
   * Pinned so the decision cannot be reversed silently while tidying.
   */
  it("counts each PERSON in a shared role, rather than averaging them into one vote", () => {
    const rw = (_d: string, role: string | undefined) => (role === "COO" ? 1.0 : 1.0);
    const twoCoos = srv.computeRoundScores(
      [
        { role: "COO", scores: { D5: 2 } },
        { role: "COO", scores: { D5: 4 } },
        { role: "CFO", scores: { D5: 5 } },
      ] as never,
      { roleWeight: rw }
    );
    // (2 + 4 + 5) / 3 = 3.67 — the COOs are two of three voices, not one.
    expect(twoCoos.scores.D5).toBeCloseTo(3.7, 1);

    const oneCoo = srv.computeRoundScores(
      [
        { role: "COO", scores: { D5: 2 } },
        { role: "CFO", scores: { D5: 5 } },
      ] as never,
      { roleWeight: rw }
    );
    // (2 + 5) / 2 = 3.5. Different from the above, which is the whole point:
    // if these matched, the second COO would be contributing nothing.
    expect(oneCoo.scores.D5).toBeCloseTo(3.5, 1);
    expect(twoCoos.scores.D5).not.toBeCloseTo(oneCoo.scores.D5, 2);
  });

});

describe("recomputeAllRounds — browser-only, so tested here where it can be executed", () => {
  it("recomputes every round in NUMERIC order, not array order", () => {
    // Array order [2, 1] is what the store really holds once a consultant can
    // pin round 3 before round 2 completes.
    const eng = {
      rounds: [
        { roundId: "r2", roundNumber: 2, interviews: [{ role: "CEO", scores: { D3: 4 }, isRefresh: true }], scores: {} as Record<string, number> },
        { roundId: "r1", roundNumber: 1, interviews: [{ role: "CEO", scores: { D3: 2 } }], scores: {} as Record<string, number> },
      ],
    };
    web.recomputeAllRounds(eng, { roleWeight: rw });
    const r1 = eng.rounds.find((r: any) => r.roundNumber === 1)!;
    const r2 = eng.rounds.find((r: any) => r.roundNumber === 2)!;
    expect(r1.scores.D3).toBe(2);
    // Round 2 blended against round 1's FRESHLY computed 2 (no coverage
    // reported, so w = 0.3): 2*0.7 + 4*0.3 = 2.6. If it had run in array
    // order it would have blended against nothing and stored 4.
    expect(r2.scores.D3).toBe(2.6);
  });

  it("leaves a planned round with no interviews exactly as stored (F22)", () => {
    const eng = {
      rounds: [
        { roundId: "r1", roundNumber: 1, interviews: [{ role: "CEO", scores: { D3: 3 } }], scores: {} },
        { roundId: "r2", roundNumber: 2, interviews: [], scores: {} },
      ],
    };
    web.recomputeAllRounds(eng, { roleWeight: rw });
    expect(eng.rounds[0].scores).toEqual({ D3: 3 });
    // NOT { D3: 3 } carried forward — nobody has been interviewed for round 2,
    // and a round holding a full set of scores reads as measured everywhere
    // downstream.
    expect(eng.rounds[1].scores).toEqual({});
  });

  it("carries the running baseline PAST an empty round to a later real one", () => {
    const eng = {
      rounds: [
        { roundId: "r1", roundNumber: 1, interviews: [{ role: "CEO", scores: { D3: 2 } }], scores: {} as Record<string, number> },
        { roundId: "r2", roundNumber: 2, interviews: [], scores: {} as Record<string, number> },
        { roundId: "r3", roundNumber: 3, interviews: [{ role: "CEO", scores: { D3: 4 }, isRefresh: true }], scores: {} as Record<string, number> },
      ],
    };
    web.recomputeAllRounds(eng, { roleWeight: rw });
    // Round 3 blends against round 1's 2, not against nothing: 2*0.7 + 4*0.3.
    expect(eng.rounds[2].scores.D3).toBe(2.6);
  });

  it("stores the blend audit only where something actually blended", () => {
    const eng = {
      rounds: [
        { roundId: "r1", roundNumber: 1, interviews: [{ role: "CEO", scores: { D3: 2 } }], scores: {}, scoreBlend: { stale: true } },
        { roundId: "r2", roundNumber: 2, interviews: [{ role: "CEO", scores: { D3: 4 }, isRefresh: true }], scores: {} },
      ],
    };
    web.recomputeAllRounds(eng, { roleWeight: rw });
    expect((eng.rounds[0] as any).scoreBlend).toBeUndefined();   // stale audit cleared
    expect((eng.rounds[1] as any).scoreBlend.D3.prior).toBe(2);
  });

  it("does nothing to an engagement with no rounds", () => {
    expect(web.recomputeAllRounds({ rounds: [] }, { roleWeight: rw })).toEqual({ rounds: [] });
    expect(web.recomputeAllRounds(null, { roleWeight: rw })).toBe(null);
  });
});
