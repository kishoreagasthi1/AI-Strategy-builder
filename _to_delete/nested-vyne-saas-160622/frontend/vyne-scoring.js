/**
 * vyne-scoring.js — the browser half of the one scoring formula.
 *
 * v5.32.59 (F6/F23). Byte-for-byte counterpart of
 * backend/src/tenant/scoring.ts. Read that file's header for why this exists;
 * the short version is that four different implementations were writing to
 * `round.scores` and two of them PERSISTED different numbers for the same
 * round, so which maturity level a client was shown depended on whether
 * Synthesis or the interview-completion merge had run last.
 *
 * backend/test/scoringParity.test.ts loads THIS FILE in node and runs every
 * case through both implementations, including randomised ones. If the two
 * drift by a single decimal place, that test fails. Change one, change both.
 *
 * Role weights are not defined here. They live in vyne-client.js
 * (window.vyneRoleWeight) for the browser and engagementMerge.ts for the
 * server, held together by roleWeightParity.test.ts — one weight table per
 * runtime, one formula for both.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.VyneScoring = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function () {
  "use strict";

  var DIMS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"];

  /* Deliberately Math.round(x*10)/10 and not toFixed(1) — see scoring.ts. The
   * two disagree on exact .x5 values and that disagreement is the bug. */
  function round1(x) { return Math.round(x * 10) / 10; }
  function round2(x) { return Math.round(x * 100) / 100; }

  var DEFAULT_COVERAGE_WEIGHT = 0.3;

  function finite(v) {
    if (typeof v !== "number") return null;
    if (!isFinite(v)) return null;
    return v;
  }

  /* Resolved at CALL time, never at load time: vyne-scoring.js and
   * vyne-client.js are included in different orders by different pages, and a
   * load-time capture would silently bind undefined on half of them. */
  function defaultRoleWeight(dim, role) {
    if (typeof window !== "undefined" && typeof window.vyneRoleWeight === "function") {
      return window.vyneRoleWeight(dim, role);
    }
    return 0.5;
  }

  function isRefreshRound(round, lowestRoundNum) {
    if (!round) return false;
    var n = finite(round.roundNumber);
    if (n === null || n <= lowestRoundNum) return false;
    var ivs = round.interviews || [];
    for (var i = 0; i < ivs.length; i++) {
      var iv = ivs[i];
      if (iv && (iv.isRefresh || (iv.coverageByDim && typeof iv.coverageByDim === "object"))) return true;
    }
    return false;
  }

  function computeRoundScores(interviews, opts) {
    opts = opts || {};
    var list = [];
    if (Object.prototype.toString.call(interviews) === "[object Array]") {
      for (var q = 0; q < interviews.length; q++) if (interviews[q]) list.push(interviews[q]);
    }
    var prior = opts.priorScores || {};
    var rw = typeof opts.roleWeight === "function" ? opts.roleWeight : defaultRoleWeight;
    var scores = {}, blend = {}, carried = [], measured = [];

    for (var di = 0; di < DIMS.length; di++) {
      var d = DIMS[di];
      var entries = [];
      for (var i = 0; i < list.length; i++) {
        var iv = list[i];
        var s = finite(iv.scores ? iv.scores[d] : undefined);
        // 0 means "no evidence", not "scored zero".
        if (s === null || s <= 0) continue;
        var w = rw(d, iv.role);
        if (!isFinite(w) || w < 0) w = 0;
        var covRaw = finite(iv.coverageByDim ? iv.coverageByDim[d] : undefined);
        var cov = covRaw === null ? null : Math.max(0, Math.min(1, covRaw));
        entries.push({ score: s, weight: w, cov: cov });
      }

      if (!entries.length) {
        var pc = finite(prior[d]);
        if (pc !== null) { scores[d] = pc; carried.push(d); }
        continue;
      }
      measured.push(d);

      var tw = 0, k;
      for (k = 0; k < entries.length; k++) tw += entries[k].weight;
      var raw, acc = 0;
      if (tw > 0) {
        for (k = 0; k < entries.length; k++) acc += entries[k].score * entries[k].weight;
        raw = acc / tw;
      } else {
        /* Every contributing role weighed zero — impossible with the shipped
         * table, possible if a firm edits it. Unweighted mean beats NaN. */
        for (k = 0; k < entries.length; k++) acc += entries[k].score;
        raw = acc / entries.length;
      }

      var p = finite(prior[d]);
      if (opts.isRefreshRound && p !== null) {
        var covEntries = [];
        for (k = 0; k < entries.length; k++) if (entries[k].cov !== null) covEntries.push(entries[k]);
        var w2;
        if (covEntries.length) {
          var cw = 0, cacc = 0;
          for (k = 0; k < covEntries.length; k++) { cw += covEntries[k].weight; cacc += covEntries[k].cov * covEntries[k].weight; }
          w2 = cw > 0 ? cacc / cw : DEFAULT_COVERAGE_WEIGHT;
        } else {
          w2 = DEFAULT_COVERAGE_WEIGHT;
        }
        w2 = Math.max(0, Math.min(1, w2));
        var blended = p * (1 - w2) + raw * w2;
        scores[d] = round1(blended);
        blend[d] = { prior: p, raw: round2(raw), weight: round2(w2), blended: round1(blended) };
      } else {
        scores[d] = round1(raw);
      }
    }

    return { scores: scores, blend: blend, carried: carried, measured: measured };
  }

  // ── F23: one definition of "latest round" ────────────────────────────────

  function sortRounds(rounds) {
    var list = [];
    if (Object.prototype.toString.call(rounds) === "[object Array]") {
      for (var i = 0; i < rounds.length; i++) if (rounds[i]) list.push(rounds[i]);
    }
    return list
      .map(function (r, i) { return { r: r, i: i, n: finite(r.roundNumber) }; })
      .sort(function (a, b) {
        if (a.n !== null && b.n !== null && a.n !== b.n) return a.n - b.n;
        if (a.n !== null && b.n === null) return -1;
        if (a.n === null && b.n !== null) return 1;
        return a.i - b.i;
      })
      .map(function (x) { return x.r; });
  }

  function latestRound(rounds) {
    var s = sortRounds(rounds);
    return s.length ? s[s.length - 1] : null;
  }

  /* Anything that DISPLAYS a number wants this; anything that WRITES to a
   * round wants latestRound(). A round is created empty when it is planned,
   * so the latest round is routinely the unscored one. */
  function latestScoredRound(rounds) {
    var s = sortRounds(rounds);
    for (var i = s.length - 1; i >= 0; i--) {
      var sc = s[i].scores;
      if (sc && Object.keys(sc).length) return s[i];
    }
    return null;
  }

  function priorRoundsBefore(rounds, roundNumber) {
    var n = finite(roundNumber);
    if (n === null) return [];
    return sortRounds(rounds).filter(function (r) {
      var rn = finite(r.roundNumber);
      return rn !== null && rn < n;
    }).reverse();
  }

  function priorScoresFor(rounds, roundNumber) {
    var out = {};
    var prs = priorRoundsBefore(rounds, roundNumber);
    for (var i = 0; i < prs.length; i++) {
      var sc = prs[i].scores;
      if (!sc) continue;
      for (var d = 0; d < DIMS.length; d++) {
        var k = DIMS[d];
        if (out[k] != null) continue;
        var v = finite(sc[k]);
        if (v !== null) out[k] = v;
      }
    }
    return out;
  }

  function lowestRoundNumber(rounds) {
    var lo = null;
    var list = Object.prototype.toString.call(rounds) === "[object Array]" ? rounds : [];
    for (var i = 0; i < list.length; i++) {
      var n = finite(list[i] && list[i].roundNumber);
      if (n === null) continue;
      if (lo === null || n < lo) lo = n;
    }
    return lo === null ? 1 : lo;
  }

  /* F22: rounds.length + 1 collides the moment a round is deleted or a
   * consultant pins a higher number by hand. */
  function nextRoundNumber(rounds) {
    var hi = 0;
    var list = Object.prototype.toString.call(rounds) === "[object Array]" ? rounds : [];
    for (var i = 0; i < list.length; i++) {
      var n = finite(list[i] && list[i].roundNumber);
      if (n !== null && n > hi) hi = n;
    }
    return hi + 1;
  }

  /* Unweighted mean ACROSS dimensions — role weights rank people within a
   * dimension and say nothing about how dimensions compare to each other. */
  function overallOf(scores) {
    if (!scores) return null;
    var acc = 0, n = 0;
    for (var i = 0; i < DIMS.length; i++) {
      var v = finite(scores[DIMS[i]]);
      if (v === null || v <= 0) continue;
      acc += v; n++;
    }
    return n ? round1(acc / n) : null;
  }

  /**
   * Recompute EVERY round of an engagement in numeric order, feeding each
   * round the prior round's freshly-computed scores.
   *
   * This is what synthesis.html's migration path used to do inline with array
   * indices, and it is the only correct order: round 3's blend depends on
   * round 2's stored value, so recomputing them out of order blends against a
   * number that is about to change. Mutates the rounds in place and returns
   * the engagement, matching how every caller already used it.
   */
  function recomputeAllRounds(engagement, opts) {
    opts = opts || {};
    if (!engagement || !engagement.rounds || !engagement.rounds.length) return engagement;
    var ordered = sortRounds(engagement.rounds);
    var lo = lowestRoundNumber(engagement.rounds);
    var running = {};
    for (var i = 0; i < ordered.length; i++) {
      var rd = ordered[i];
      /* A round with NO interviews is left exactly as stored.
       *
       * computeRoundScores would happily return the prior round's numbers for
       * it — every dimension carried forward — and writing those back is F22:
       * a round nobody has been interviewed for yet ends up holding a full set
       * of maturity scores, and the portfolio card, the roadmap and the client
       * document all read it as measured. Carry `running` past it unchanged so
       * a LATER round still blends against the last round that was real. */
      if (!rd.interviews || !rd.interviews.length) continue;
      var res = computeRoundScores(rd.interviews, {
        priorScores: running,
        isRefreshRound: isRefreshRound(rd, lo),
        roleWeight: opts.roleWeight
      });
      rd.scores = res.scores;
      if (Object.keys(res.blend).length) rd.scoreBlend = res.blend; else delete rd.scoreBlend;
      for (var d = 0; d < DIMS.length; d++) {
        var k = DIMS[d];
        if (res.scores[k] != null) running[k] = res.scores[k];
      }
    }
    return engagement;
  }

  /**
   * The scale every dimension score in this product is assigned on
   * (v5.32.68).
   *
   * Lifted verbatim from the interviewer's own system prompt, and exported so
   * that anything ELSE producing a number on this scale is calibrated the same
   * way. That is not tidiness: the Maturity Targets tab asks a model to weight
   * capability gaps in score-points and then ADDS those weights to a measured
   * interview score. If the two are assigned on different rubrics, the addition
   * is arithmetic on incompatible units and the result is a number that looks
   * precise and means nothing.
   *
   * scoringRubricParityCheck in the test suite asserts interview_agent.html
   * still carries this exact line, so the two cannot drift apart silently.
   */
  var SCALE = '1=Not Started, 2=Early/Ad Hoc, 3=Developing, 4=Advanced, 5=Leading/Optimized';

  /** The benchmark-calibration instruction the interviewer scores under. */
  var BENCHMARK_CALIBRATION =
    'Use these to calibrate scores. A claim of 4.5 where best-in-class is 3.8 requires deeper evidence.';

  return {
    DIMS: DIMS,
    SCALE: SCALE,
    BENCHMARK_CALIBRATION: BENCHMARK_CALIBRATION,
    DEFAULT_COVERAGE_WEIGHT: DEFAULT_COVERAGE_WEIGHT,
    round1: round1,
    round2: round2,
    computeRoundScores: computeRoundScores,
    isRefreshRound: isRefreshRound,
    sortRounds: sortRounds,
    latestRound: latestRound,
    latestScoredRound: latestScoredRound,
    priorRoundsBefore: priorRoundsBefore,
    priorScoresFor: priorScoresFor,
    lowestRoundNumber: lowestRoundNumber,
    nextRoundNumber: nextRoundNumber,
    overallOf: overallOf,
    recomputeAllRounds: recomputeAllRounds
  };
});
