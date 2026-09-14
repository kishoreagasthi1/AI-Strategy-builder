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

  /* ── v5.34.92: how much each DIMENSION counts toward the overall ───────────
   *
   * Role weights rank PEOPLE within one dimension. They deliberately say
   * nothing about how dimensions compare, so the overall was a plain mean
   * across the seven — and a 1.7 on a dimension the engagement barely cared
   * about counted exactly as much as a 1.7 on its central one.
   *
   * The weights are NOT a new input. Pre-Engagement already asks the
   * consultant to tier every dimension per role — lead / cover / light, and a
   * dimension in none of them is excluded — and that tiering is the statement
   * of what this engagement is actually about. Summing it across the roles who
   * were interviewed gives a per-dimension weight for free.
   *
   * Three properties this shape was chosen for:
   *
   *  · It is a SNAPSHOT. Each interview carries the tiers that governed it
   *    (interview_agent.html writes ivRecord.dimTiers at completion), so the
   *    weights cannot drift from what the interviews actually did, and editing
   *    Pre-Engagement later does not silently restate a delivered score.
   *
   *  · It degrades to today's number. An interview recorded before v5.34.92
   *    has no dimTiers; if ANY scored interview in the round is missing them
   *    this returns null and overallOf falls back to the plain mean. Every
   *    existing engagement therefore reads exactly as it did before — no
   *    client's delivered maturity level moves retroactively.
   *
   *  · A dimension excluded by every role weighs 0 and leaves the mean
   *    entirely, which is what "we turned it off in Pre-Engagement" means.
   *
   * A note on what this does NOT buy, because the number matters: on a roster
   * of three the derived weights are fairly flat (roughly 1.6–2.3 on the
   * example in docs/SCORING_EXPLAINED.md), so the overall typically moves by
   * about 0.1. It is a correctness fix, not a re-scoring.
   */
  var TIER_WEIGHT = { lead: 1.0, cover: 0.6, light: 0.3 };

  /* ── v5.34.96: THE MATURITY BANDS, ONCE ────────────────────────────────────
   *
   * These thresholds and these five words are what a client is actually told.
   * They existed in four places, all agreeing by luck rather than by anything:
   *
   *   backend/src/routes/scorecard.ts   MATURITY      (/api/scorecard, the deck)
   *   frontend/interview_agent.html     MATURITY      (live panel, export sheet)
   *   frontend/synthesis.html  :2067    inline ternary (dashboard headline)
   *   frontend/synthesis.html  ml()     inline ternary (the Word document)
   *
   * — plus a fifth, frontend/scorecard.html, holding a COLOUR map keyed by the
   * label strings, which silently loses its colours if a label is reworded.
   *
   * No test compared any of them. scorecard.test.ts hardcodes the five expected
   * labels and never reads the frontend, so editing the browser table alone
   * left the suite green; scoreMeaningAndWeight.test.ts stubs its own bands
   * entirely. A consultant renaming "AI Capable" in one file would have shipped
   * a client deck and a dashboard that disagreed about the client's maturity.
   *
   * Nothing about the bands changes here. This is de-duplication: one table,
   * mirrored in backend/src/tenant/scoring.ts, pinned by scoringParity.test.ts.
   * Colours stay in the pages — those are presentation and legitimately differ
   * between a dark side-panel and a light portfolio card — but they are keyed
   * by these labels, and maturityBandParity.test.ts checks the key sets match.
   */
  var MATURITY_BANDS = [
    { min: 4.5, label: "AI-Native" },
    { min: 3.5, label: "AI-Led" },
    { min: 2.5, label: "AI Capable" },
    { min: 1.5, label: "AI Exploring" },
    { min: 0,   label: "AI Unaware" }
  ];

  /** The band a score falls in. Always returns one; 0 is "AI Unaware". */
  function maturityBand(score) {
    var v = finite(score);
    if (v === null) return MATURITY_BANDS[MATURITY_BANDS.length - 1];
    for (var i = 0; i < MATURITY_BANDS.length; i++) {
      if (v >= MATURITY_BANDS[i].min) return MATURITY_BANDS[i];
    }
    return MATURITY_BANDS[MATURITY_BANDS.length - 1];
  }

  /**
   * The band's label, or null when there is no score to band.
   *
   * null and 0 are different answers and both callers of this matter: a round
   * with no scores at all has no maturity (null → the caller says "Pending" or
   * "Not assessed"), while a round measured at 0 genuinely is AI Unaware.
   */
  function maturityLabel(score) {
    var v = finite(score);
    return v === null ? null : maturityBand(v).label;
  }

  /* ── v5.34.96: THE ⚡ MARKER WAS WRITTEN AT THE WRONG LEVEL ────────────────
   *
   * synthesis.html marks a dimension whose score moved because of an external
   * event — a breach, a funding round, a new CTO — so the shift is explainable
   * rather than mysterious. It reads `round.eventDriven` and
   * `round.eventCoveredDims` (synthesis.html:818 and :1043).
   *
   * NOTHING HAS EVER WRITTEN THOSE. Both builders set eventDriven /
   * eventCoveredDims / eventContext on the INTERVIEW record
   * (interview_agent.html writeInterviewToEngagement, engagementMerge.ts
   * mergeSessionIntoEngagement); no code anywhere assigns them to a round. So
   * the `&&` at :1043 could never be true and the marker has never rendered —
   * written on both sides of the boundary and consumed by nobody, which is the
   * isRefresh/isRefreshMode defect with a level substituted for a spelling.
   *
   * Fixed by DERIVING the round's flags from its interviews rather than by
   * adding a fourth place that writes them. A derivation cannot drift from the
   * data it is derived from; a copy can, and this codebase has the scars.
   *
   * A round is event-driven if any interview in it was, and the covered
   * dimensions are the union — several interviews in one round can each be
   * tagged with the same event and re-score different dimensions.
   */
  function roundEventRollup(interviews) {
    var list = [];
    if (Object.prototype.toString.call(interviews) === "[object Array]") {
      for (var q = 0; q < interviews.length; q++) if (interviews[q]) list.push(interviews[q]);
    }
    var driven = false, ctx = null, dims = [], i, j;
    for (i = 0; i < list.length; i++) {
      var iv = list[i];
      if (!iv.eventDriven) continue;
      driven = true;
      if (!ctx && iv.eventContext) ctx = iv.eventContext;
      var cov = Object.prototype.toString.call(iv.eventCoveredDims) === "[object Array]"
        ? iv.eventCoveredDims : [];
      for (j = 0; j < cov.length; j++) {
        var d = String(cov[j]);
        if (DIMS.indexOf(d) >= 0 && dims.indexOf(d) < 0) dims.push(d);
      }
    }
    // Stable order, so a round record does not churn on every recompute.
    dims.sort();
    return { eventDriven: driven, eventContext: ctx, eventCoveredDims: dims };
  }

  /**
   * Per-dimension weights for a round, or null when the round cannot supply
   * them (no interviews, a legacy interview with no tiers, or tiers that
   * exclude everything).
   *
   * All-or-nothing on purpose: weighting a round from the two interviews that
   * happen to carry tiers, while ignoring the third, is a number nobody can
   * explain and nobody would notice was wrong.
   */
  function dimensionWeights(interviews) {
    var list = [];
    if (Object.prototype.toString.call(interviews) === "[object Array]") {
      for (var q = 0; q < interviews.length; q++) if (interviews[q]) list.push(interviews[q]);
    }
    if (!list.length) return null;
    var w = {}, i, d;
    for (i = 0; i < DIMS.length; i++) w[DIMS[i]] = 0;
    for (i = 0; i < list.length; i++) {
      var t = list[i].dimTiers;
      if (!t || typeof t !== "object") return null;
      for (d = 0; d < DIMS.length; d++) {
        var tier = t[DIMS[d]];
        var tw = Object.prototype.hasOwnProperty.call(TIER_WEIGHT, tier) ? TIER_WEIGHT[tier] : 0;
        w[DIMS[d]] += tw;
      }
    }
    var any = false;
    for (d = 0; d < DIMS.length; d++) if (w[DIMS[d]] > 0) any = true;
    return any ? w : null;
  }

  /**
   * Overall across dimensions. With `weights`, a weighted mean; without them,
   * the plain mean this has always been.
   *
   * The second argument is optional so that every existing call site keeps its
   * exact current behaviour — a caller opts in by passing weights, never by
   * accident.
   */
  function overallOf(scores, weights) {
    if (!scores) return null;
    var acc = 0, n = 0, wacc = 0, wsum = 0, i, v, w;
    for (i = 0; i < DIMS.length; i++) {
      v = finite(scores[DIMS[i]]);
      if (v === null || v <= 0) continue;
      if (weights) {
        w = finite(weights[DIMS[i]]);
        if (w === null || w <= 0) continue;   // excluded by every role
        wacc += v * w; wsum += w;
      } else {
        acc += v; n++;
      }
    }
    if (weights) return wsum > 0 ? round1(wacc / wsum) : null;
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
  /* ── v5.34.92: WHOSE answers each dimension score rests on ─────────────────
   *
   * The round score for a dimension is a role-weighted mean across the people
   * who answered — and it is arithmetically correct whoever those people were.
   * What the number cannot say is that the person the weight table trusts most
   * on that dimension was never in the room.
   *
   * The worked example in docs/SCORING_EXPLAINED.md is the case: D6 Governance
   * & Risk comes out at 1.7, the lowest score in the engagement and the one the
   * deck will lead with, from a CTO (0.8) and a CFO (0.6). The General Counsel
   * carries 1.0 on D6 and was not interviewed. Nothing anywhere in the product
   * said so, and the weighting added in this same version makes it matter MORE,
   * not less — D6 now pulls harder on the overall precisely because two of the
   * three roles led on it.
   *
   * So this is a roster audit, not a scoring change. It reads the same weight
   * table the scores were computed with and reports, per dimension, the highest
   * authority that actually answered against the highest authority that exists.
   * It changes no number.
   *
   * Pure and table-injected for the same reason computeRoundScores is: the
   * weight table lives in vyne-client.js (browser) and engagementMerge.ts
   * (server) and this file must not acquire a third copy.
   *
   * @param interviews  round.interviews — each {role, scores}
   * @param table       VYNE_ROLE_WEIGHTS-shaped {D1:{CTO:0.8,...},...}
   * @param roleKeyFn   optional normaliser for display-label roles
   *                    ("COO / VP Operations" → "COO")
   * @returns one entry per dimension, in DIMS order
   */
  function rosterCoverage(interviews, table, roleKeyFn) {
    var list = [];
    if (Object.prototype.toString.call(interviews) === "[object Array]") {
      for (var q = 0; q < interviews.length; q++) if (interviews[q]) list.push(interviews[q]);
    }
    var tbl = table || {};
    var norm = typeof roleKeyFn === "function" ? roleKeyFn : function (r) {
      /* Mirrors vyneRoleWeight's last-resort match so a display label does not
       * silently read as an unknown role weighing the 0.5 default — which would
       * report every dimension as thinly covered on exactly the engagements
       * whose rosters came from synthetic data or an import. */
      var s = String(r || "").trim();
      return s.split(/[\/(—-]/)[0].trim().replace(/\s+/g, "_");
    };

    var out = [];
    for (var i = 0; i < DIMS.length; i++) {
      var d = DIMS[i];
      var row = tbl[d] || {};

      // The highest authority that EXISTS for this dimension.
      var best = 0, bestRoles = [], r;
      for (r in row) {
        if (!Object.prototype.hasOwnProperty.call(row, r)) continue;
        var v = finite(row[r]);
        if (v === null) continue;
        if (v > best) { best = v; bestRoles = [r]; }
        else if (v === best && v > 0) bestRoles.push(r);
      }

      // The highest authority that actually ANSWERED on this dimension.
      var have = 0, haveRole = null, contributors = [], seen = {};
      for (var k = 0; k < list.length; k++) {
        var iv = list[k];
        var sc = finite(iv.scores ? iv.scores[d] : undefined);
        if (sc === null || sc <= 0) continue;          // 0 = no evidence
        var key = norm(iv.role);
        var w = finite(row[key]);
        if (w === null) w = 0.5;                       // same default as vyneRoleWeight
        contributors.push({ role: key, weight: w, score: sc });
        if (!seen[key] || w > seen[key]) seen[key] = w;
        if (w > have) { have = w; haveRole = key; }
      }

      /* `missing` is only meaningful when the roster FALLS SHORT of the best
       * available authority. Several roles can tie at the top — D7 is CEO 1.0
       * and CHRO 1.0 — and interviewing either one covers the dimension; a
       * naive "top roles not in the roster" list then named the CEO on a
       * dimension the CHRO had already answered authoritatively, so the panel
       * flagged "well covered" and explained that the key voice was missing, in
       * the same row. */
      var missing = [];
      if (have < best) {
        for (var b = 0; b < bestRoles.length; b++) {
          if (!Object.prototype.hasOwnProperty.call(seen, bestRoles[b])) missing.push(bestRoles[b]);
        }
      }

      /* Severity. `none` is not a warning about WHO answered — nobody did, and
       * the coverage map already says so; it is here so the two panels cannot
       * disagree about which dimensions have evidence. */
      var status;
      if (!contributors.length) status = "none";
      else if (have < 0.5 || (best - have) >= 0.4) status = "gap";
      else if (have < best) status = "thin";
      else status = "ok";

      out.push({
        dim: d, status: status,
        have: round2(have), haveRole: haveRole,
        best: round2(best), bestRoles: bestRoles,
        missing: missing,
        contributors: contributors
      });
    }
    return out;
  }

  var SCALE = '1=Not Started, 2=Early/Ad Hoc, 3=Developing, 4=Advanced, 5=Leading/Optimized';

  /** The benchmark-calibration instruction the interviewer scores under. */
  var BENCHMARK_CALIBRATION =
    'Use these to calibrate scores. A claim of 4.5 where best-in-class is 3.8 requires deeper evidence.';

  return {
    DIMS: DIMS,
    TIER_WEIGHT: TIER_WEIGHT,
    MATURITY_BANDS: MATURITY_BANDS,
    maturityBand: maturityBand,
    maturityLabel: maturityLabel,
    dimensionWeights: dimensionWeights,
    roundEventRollup: roundEventRollup,
    rosterCoverage: rosterCoverage,
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
