/**
 * scoring.ts — the one definition of what a round's dimension scores are.
 *
 * v5.32.59 (F6/F23). Before this file there were FOUR implementations writing
 * to `round.scores`, and they did not agree:
 *
 *   engagementMerge.ts        weighted mean, Math.round to 1dp, NO blend
 *   synthesis.html:1088       weighted mean at 2dp, then a coverage blend
 *                             prior*(1-w) + raw*w with w defaulting to 0.3
 *   synthesis.html            computeWeightedScores — weighted mean, toFixed(2)
 *   roadmap.html              per-persona unweighted mean across dimensions
 *
 * The first two both PERSIST. A consultant completing an interview writes the
 * unblended number from the server; opening Synthesis rewrites the same round
 * with the blended one; the scorecard, the client document and the Solution
 * Design generator then read whichever ran last. Two people looking at the
 * same round on the same day could legitimately read different maturity
 * levels, and neither number was wrong on its own terms — which is exactly why
 * nothing ever surfaced it as a bug.
 *
 * The blend is a real feature, not an accident: a refresh round only re-asks
 * some of the questions, so a dimension that round barely touched should move
 * the stored score proportionally to how much of it was actually covered.
 * The defect was that only one of the two writers knew about it.
 *
 * So this module is the formula, and it includes the blend. The browser has a
 * byte-for-byte counterpart at frontend/vyne-scoring.js — the browser cannot
 * import this module and this module cannot import a browser script, so
 * test/scoringParity.test.ts EXECUTES both against a shared battery of cases
 * (including randomised ones) and fails if any single number differs. That is
 * a real guarantee rather than a comment asking future readers to be careful.
 *
 * Role weights stay where they are (engagementMerge.ts and vyne-client.js,
 * held together by roleWeightParity.test.ts) and are injected here, so there
 * is still exactly one weight table per runtime and now exactly one formula.
 */

export const DIMS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"] as const;

/** Rounding used for every persisted score.
 *
 * Deliberately Math.round(x*10)/10 and not toFixed(1): the two disagree on
 * exact .x5 values (toFixed consults the binary representation, Math.round
 * rounds half away from zero on the scaled integer), and "2.25 became 2.2 in
 * one module and 2.3 in another" is precisely the class of divergence this
 * file exists to remove. Both runtimes use this identical expression. */
export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export type RoleWeightFn = (dim: string, role: string | undefined) => number;

export interface ScoringInterview {
  role?: string;
  scores?: Record<string, number> | null;
  coverageByDim?: Record<string, number> | null;
  isRefresh?: boolean;
  [key: string]: unknown;
}

export interface BlendAudit {
  prior: number;
  raw: number;
  weight: number;
  blended: number;
}

export interface RoundScoreResult {
  /** The round's persisted scores. Dimensions with no evidence anywhere are absent. */
  scores: Record<string, number>;
  /** Per-dimension audit for blended dimensions. Empty when nothing blended. */
  blend: Record<string, BlendAudit>;
  /** Dimensions whose value came from a prior round rather than this round. */
  carried: string[];
  /** Dimensions this round actually measured (scored by >= 1 interview). */
  measured: string[];
}

export interface RoundScoreOptions {
  /** Scores of the nearest prior round, per dimension, for carry-forward and blending. */
  priorScores?: Record<string, number> | null | undefined;
  /**
   * Whether this round is a refresh of an earlier one. Blending only applies
   * to refresh rounds: a first assessment has nothing to blend against, and a
   * dimension's first measurement must stand on its own.
   */
  isRefreshRound?: boolean;
  /** Injected so each runtime keeps its own single weight table. */
  roleWeight: RoleWeightFn;
}

/** Default coverage weight when a refresh interview reports no coverage at all.
 *
 * Low on purpose. "We re-asked about this dimension but did not say how much
 * of it we covered" should nudge the stored score, not replace it. */
export const DEFAULT_COVERAGE_WEIGHT = 0.3;

function finite(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!isFinite(v)) return null;
  return v;
}

/**
 * Is this round a refresh of an earlier one?
 *
 * Canonical because synthesis.html and engagementMerge.ts had different
 * answers: the browser used ARRAY INDEX > 0, which after v5.32.57 (rounds can
 * arrive out of numeric order) could call round 2 a first assessment and
 * round 1 a refresh. Round NUMBER is the only thing that means what it says.
 */
export function isRefreshRound(
  round: { roundNumber?: number; interviews?: ScoringInterview[] | null },
  lowestRoundNumber: number
): boolean {
  const n = finite(round.roundNumber);
  if (n === null || n <= lowestRoundNumber) return false;
  return (round.interviews ?? []).some(
    (i) => Boolean(i && (i.isRefresh || (i.coverageByDim && typeof i.coverageByDim === "object")))
  );
}

/**
 * Compute one round's scores. Pure — takes interviews and the prior round's
 * numbers, returns what should be stored. Every writer in the product calls
 * this and nothing else.
 */
export function computeRoundScores(
  interviews: ScoringInterview[] | null | undefined,
  opts: RoundScoreOptions
): RoundScoreResult {
  const list = Array.isArray(interviews) ? interviews.filter(Boolean) : [];
  const prior = opts.priorScores ?? {};
  const rw = opts.roleWeight;
  const scores: Record<string, number> = {};
  const blend: Record<string, BlendAudit> = {};
  const carried: string[] = [];
  const measured: string[] = [];

  for (const d of DIMS) {
    const entries: { score: number; weight: number; cov: number | null }[] = [];
    for (const iv of list) {
      const s = finite(iv.scores ? iv.scores[d] : undefined);
      // 0 means "no evidence for this dimension", not "scored zero". Every
      // module in the product has agreed on that since v5.31; it is the
      // reason an un-asked dimension does not drag an average down.
      if (s === null || s <= 0) continue;
      /*
       * The weight is the ROLE's, and every interview gets it — so a role held
       * by several people contributes several entries at that weight.
       *
       * v5.32.86, stated because it was never stated. On a client with three
       * divisional COOs, the COO view carries three times the weight of a
       * single-holder role in every dimension where COO is weighted heavily.
       * That is deliberate and it is kept: three executives are three
       * observations, and averaging them into one "COO opinion" would discard
       * the disagreement between divisions that is often the finding.
       *
       * The alternative — normalising each role to one vote — is defensible
       * and was considered. It is rejected because it would make a round's
       * score depend on how a firm happens to slice its org chart, and because
       * the consultant chooses who to interview: adding a third COO is a
       * decision to hear operations three times.
       *
       * Pinned by test/scoringParity.test.ts so nobody changes it by accident
       * while tidying something else.
       */
      let w = rw(d, iv.role);
      if (!isFinite(w) || w < 0) w = 0;
      const covRaw = finite(iv.coverageByDim ? iv.coverageByDim[d] : undefined);
      const cov = covRaw === null ? null : Math.max(0, Math.min(1, covRaw));
      entries.push({ score: s, weight: w, cov });
    }

    if (!entries.length) {
      // Nothing this round. Carry the prior round's value forward so a
      // dimension does not vanish from the scorecard just because this round
      // did not re-ask about it.
      const p = finite(prior[d]);
      if (p !== null) {
        scores[d] = p;
        carried.push(d);
      }
      continue;
    }
    measured.push(d);

    let tw = 0;
    for (const e of entries) tw += e.weight;
    let raw: number;
    if (tw > 0) {
      let acc = 0;
      for (const e of entries) acc += e.score * e.weight;
      raw = acc / tw;
    } else {
      /* Every contributing role weighed zero. That cannot happen with the
       * shipped table (its lowest entry is 0.1 and unknown roles fall back to
       * 0.5), but a firm editing weights could produce it, and dividing by
       * zero would put NaN into a client's scorecard. Fall back to the
       * unweighted mean — "we have evidence but no basis to rank it". */
      let acc = 0;
      for (const e of entries) acc += e.score;
      raw = acc / entries.length;
    }

    const p = finite(prior[d]);
    if (opts.isRefreshRound && p !== null) {
      // Coverage weight: how much of this dimension the refresh actually
      // covered, itself role-weighted so the authoritative voice's coverage
      // counts for more.
      const covEntries = entries.filter((e) => e.cov !== null);
      let w: number;
      if (covEntries.length) {
        let cw = 0;
        let acc = 0;
        for (const e of covEntries) {
          cw += e.weight;
          acc += (e.cov as number) * e.weight;
        }
        w = cw > 0 ? acc / cw : DEFAULT_COVERAGE_WEIGHT;
      } else {
        w = DEFAULT_COVERAGE_WEIGHT;
      }
      w = Math.max(0, Math.min(1, w));
      const blended = p * (1 - w) + raw * w;
      scores[d] = round1(blended);
      blend[d] = { prior: p, raw: round2(raw), weight: round2(w), blended: round1(blended) };
    } else {
      scores[d] = round1(raw);
    }
  }

  return { scores, blend, carried, measured };
}

// ─────────────────────────────────────────────────────────────────────────────
// F23 — one definition of "latest round".
//
// There were three:
//   scorecard.ts        sorted by roundNumber (correct, but NaN-unstable when
//                       roundNumber was absent, which older records allow)
//   engagementLookup.ts walked the array BACKWARDS by index
//   roadmap.html        rounds[rounds.length - 1]
//
// Array order is insertion order — the order interviews completed — so from
// v5.32.55 (a consultant can pin round 3 before round 2 exists) the last
// element is routinely not the latest round. The portfolio scorecard would
// show round 3 while the roadmap generated from round 2's numbers, for the
// same client, on the same screen refresh.
// ─────────────────────────────────────────────────────────────────────────────

export interface RoundLike {
  roundId?: string;
  roundNumber?: number;
  scores?: Record<string, number> | null;
  interviews?: ScoringInterview[] | null;
}

/**
 * Ascending by round number. Rounds with no number sort by their position in
 * the array, after any numbered round they follow, which keeps legacy records
 * (written before roundNumber existed) in the order they were created.
 * Stable: equal numbers keep array order, so a duplicate round number resolves
 * to "the one created first is earlier", which is the only defensible reading.
 */
export function sortRounds<T extends RoundLike>(rounds: T[] | null | undefined): T[] {
  const list = Array.isArray(rounds) ? rounds.filter(Boolean) : [];
  return list
    .map((r, i) => ({ r, i, n: finite(r.roundNumber) }))
    .sort((a, b) => {
      if (a.n !== null && b.n !== null && a.n !== b.n) return a.n - b.n;
      if (a.n !== null && b.n === null) return -1;
      if (a.n === null && b.n !== null) return 1;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/** The highest-numbered round, or null. */
export function latestRound<T extends RoundLike>(rounds: T[] | null | undefined): T | null {
  const s = sortRounds(rounds);
  return s.length ? s[s.length - 1] : null;
}

/**
 * The highest-numbered round that actually has scores.
 *
 * F21/F22: a round is created EMPTY when a consultant plans it, so the latest
 * round is frequently the one nobody has been interviewed for yet. Reading
 * `latestRound().scores` for a portfolio card, a roadmap or a client document
 * therefore blanked the client the moment their next round was planned — the
 * scorecard showed a firm with three completed rounds as having no maturity
 * data at all. Anything that DISPLAYS a number wants this; anything that
 * WRITES to a round wants latestRound().
 */
export function latestScoredRound<T extends RoundLike>(rounds: T[] | null | undefined): T | null {
  const s = sortRounds(rounds);
  for (let i = s.length - 1; i >= 0; i--) {
    const sc = s[i].scores;
    if (sc && Object.keys(sc).length) return s[i];
  }
  return null;
}

/** Rounds strictly before `roundNumber`, nearest first. */
export function priorRoundsBefore<T extends RoundLike>(
  rounds: T[] | null | undefined,
  roundNumber: number | undefined
): T[] {
  const n = finite(roundNumber);
  if (n === null) return [];
  return sortRounds(rounds)
    .filter((r) => {
      const rn = finite(r.roundNumber);
      return rn !== null && rn < n;
    })
    .reverse();
}

/** The nearest prior round's scores, merged nearest-first per dimension. */
export function priorScoresFor<T extends RoundLike>(
  rounds: T[] | null | undefined,
  roundNumber: number | undefined
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pr of priorRoundsBefore(rounds, roundNumber)) {
    const sc = pr.scores;
    if (!sc) continue;
    for (const d of DIMS) {
      if (out[d] != null) continue;
      const v = finite(sc[d]);
      if (v !== null) out[d] = v;
    }
  }
  return out;
}

/** The lowest round number present, used to decide what counts as a refresh. */
export function lowestRoundNumber<T extends RoundLike>(rounds: T[] | null | undefined): number {
  let lo: number | null = null;
  for (const r of Array.isArray(rounds) ? rounds : []) {
    const n = finite(r?.roundNumber);
    if (n === null) continue;
    if (lo === null || n < lo) lo = n;
  }
  return lo === null ? 1 : lo;
}

/**
 * The next free round number.
 *
 * F22: `rounds.length + 1` collides the moment a round is deleted or a
 * consultant pins a higher number by hand — two rounds called "Round 3", one
 * of which the carry-forward then treats as prior to the other.
 */
export function nextRoundNumber<T extends RoundLike>(rounds: T[] | null | undefined): number {
  let hi = 0;
  for (const r of Array.isArray(rounds) ? rounds : []) {
    const n = finite(r?.roundNumber);
    if (n !== null && n > hi) hi = n;
  }
  return hi + 1;
}

/** Overall = unweighted mean ACROSS dimensions (role weights rank people
 *  within a dimension; they say nothing about how dimensions compare). */
export function overallOf(scores: Record<string, number> | null | undefined): number | null {
  if (!scores) return null;
  let acc = 0;
  let n = 0;
  for (const d of DIMS) {
    const v = finite(scores[d]);
    if (v === null || v <= 0) continue;
    acc += v;
    n++;
  }
  return n ? round1(acc / n) : null;
}
