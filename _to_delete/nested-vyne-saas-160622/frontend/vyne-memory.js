/**
 * vyne-memory.js — what the engagement knows, per person and per dimension.
 *
 * v5.32.88.
 *
 * ── Why this exists ──
 *
 * Context for an interview was assembled at four separate sites, from three
 * stores, under three different privacy rules, and none of them read the
 * richest material in the product:
 *
 *   · interview_transcripts.turns — the conversation itself
 *   · .score_events (v5.32.66)    — every score MOVEMENT and where in the
 *                                   conversation it happened. Migration 023's
 *                                   own comment calls this "the part nobody has
 *                                   ever been able to see"; nothing read it back
 *   · .findings                   — observations sitting next to the words that
 *                                   produced them
 *   · coverageByDim               — how thoroughly a dimension was actually
 *                                   re-evidenced. Computed, used in scoring,
 *                                   never fed FORWARD
 *
 * A round-2 interview got one line — "you assessed this around 4/5" — and a
 * follow-up got a sentence identical for every engagement in the product.
 *
 * ── The two rules that make this trustworthy ──
 *
 * DERIVED, NEVER AUTHORED. Everything here is recomputed from the engagement
 * record. Nothing writes to it by hand, so a bad derivation is a bug to fix
 * rather than corrupted state to migrate, and the engagement record and the
 * transcripts remain the only sources of truth. `vynora_memory_<CODE>` is a
 * cache; deleting it must cost nothing but a recompute.
 *
 * EVERY ENTRY CARRIES PROVENANCE. Each claim knows the round it came from and
 * the interview that produced it. Without that, a summary in a prompt is
 * unfalsifiable — and an unfalsifiable summary ends up as a sentence in a board
 * deck that nobody can trace to anything anyone said. That is the failure
 * findings.ts was written to stop, and a memory layer is a much better place to
 * reintroduce it.
 *
 * ── Recency ──
 *
 * As rounds accumulate, old material stops being context and starts being
 * noise. The rule here: the LATEST round a person spoke on a dimension is
 * carried verbatim; earlier rounds survive only as a trajectory (the scores and
 * the direction), not as text. A dimension the person has not been asked about
 * since an earlier round is flagged `stale`, which is the signal that a
 * carried-forward score needs re-evidencing rather than restating.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.VyneMemory = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function () {
  "use strict";

  var DIM_CODES = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"];

  /** How many rounds of verbatim text to keep per person per dimension. */
  var VERBATIM_ROUNDS = 1;
  /** Cap on other people's de-attributed lines offered per dimension. */
  var AMBIENT_PER_DIM = 2;

  function str(v) { return String(v == null ? "" : v).trim(); }
  /**
   * A number, or null when there is no number.
   *
   * `Number(null)` is 0 and `Number("")` is 0, so the obvious one-liner turns
   * "nobody recorded a coverage figure" into "coverage was measured at zero" —
   * a claim, and the opposite of the truth. Coverage is precisely the field
   * that has to distinguish those two, since its whole job is telling a
   * carried-forward score from a freshly evidenced one.
   */
  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function isArr(v) { return Object.prototype.toString.call(v) === "[object Array]"; }

  /** Ascending by round number; unnumbered rounds keep array order, after
   *  numbered ones. Mirrors VyneScoring.sortRounds deliberately — two orderings
   *  of the same rounds is how the follow-up draft came to read the wrong one
   *  (v5.32.87). */
  function sortRounds(rounds) {
    var list = isArr(rounds) ? rounds.filter(Boolean) : [];
    return list
      .map(function (r, i) { return { r: r, i: i, n: num(r.roundNumber) }; })
      .sort(function (a, b) {
        if (a.n !== null && b.n !== null && a.n !== b.n) return a.n - b.n;
        if (a.n !== null && b.n === null) return -1;
        if (a.n === null && b.n !== null) return 1;
        return a.i - b.i;
      })
      .map(function (x) { return x.r; });
  }

  function personKey(iv) {
    if (!iv) return "";
    var role = str(iv.role);
    var name = str(iv.interviewee || iv.name);
    return name ? role + "||" + name : role;
  }

  /** Role alone where it identifies one person; "Role (Person)" where it does
   *  not. Same rule as vyneLabelFor in vyne-client.js — restated here so this
   *  module has no load-order dependency, and asserted identical by test. */
  function labelIndex(interviews) {
    var byRole = {};
    for (var i = 0; i < interviews.length; i++) {
      var role = str(interviews[i].role), name = str(interviews[i].interviewee || interviews[i].name);
      if (!role || !name) continue;
      if (!byRole[role]) byRole[role] = [];
      if (byRole[role].indexOf(name) === -1) byRole[role].push(name);
    }
    return function (iv) {
      var role = str(iv.role), name = str(iv.interviewee || iv.name);
      if (!role) return name;
      if (!name) return role;
      return (byRole[role] && byRole[role].length > 1) ? role + " (" + name + ")" : role;
    };
  }

  /**
   * Derive the memory from an engagement record.
   *
   * Reads only what the record already holds — scores, findings, coverageByDim,
   * and the round each came from. Transcript-derived enrichment (the actual
   * turns, and the score-movement journal) is a server-side concern and is
   * merged in separately; this stays runnable in the browser at Close Round.
   */
  function build(engagement) {
    var eng = engagement || {};
    var rounds = sortRounds(eng.rounds);
    var flat = [];
    for (var r = 0; r < rounds.length; r++) {
      var rn = num(rounds[r].roundNumber);
      var ivs = isArr(rounds[r].interviews) ? rounds[r].interviews : [];
      for (var k = 0; k < ivs.length; k++) {
        if (ivs[k]) flat.push({ round: rn === null ? (r + 1) : rn, roundId: rounds[r].roundId, iv: ivs[k] });
      }
    }
    var labelFor = labelIndex(flat.map(function (x) { return x.iv; }));

    var byPerson = {};
    var byDimension = {};
    var fromRounds = [];

    for (var f = 0; f < flat.length; f++) {
      var round = flat[f].round, iv = flat[f].iv;
      if (fromRounds.indexOf(round) === -1) fromRounds.push(round);
      var key = personKey(iv);
      if (!key) continue;

      if (!byPerson[key]) {
        byPerson[key] = {
          key: key, role: str(iv.role), person: str(iv.interviewee || iv.name),
          label: labelFor(iv), roundsParticipated: [], byDimension: {},
        };
      }
      var P = byPerson[key];
      if (P.roundsParticipated.indexOf(round) === -1) P.roundsParticipated.push(round);

      // Findings, indexed by dimension. The LATEST wins as the verbatim claim.
      var textByDim = {};
      var findings = isArr(iv.findings) ? iv.findings : [];
      for (var q = 0; q < findings.length; q++) {
        var fd = findings[q]; if (!fd) continue;
        var fdim = str(fd.dimension), ftext = str(fd.text != null ? fd.text : fd);
        if (!fdim || !ftext) continue;
        if (!textByDim[fdim]) textByDim[fdim] = ftext;
      }

      for (var d = 0; d < DIM_CODES.length; d++) {
        var dim = DIM_CODES[d];
        var score = num(iv.scores ? iv.scores[dim] : null);
        var cov = num(iv.coverageByDim ? iv.coverageByDim[dim] : null);
        var text = textByDim[dim] || "";
        // Nothing said and nothing scored: this person did not address it.
        if ((score === null || score <= 0) && !text) continue;

        if (!P.byDimension[dim]) P.byDimension[dim] = { history: [] };
        P.byDimension[dim].history.push({
          round: round,
          score: (score !== null && score > 0) ? score : null,
          coverage: cov,
          text: text || null,
          // Provenance. Without it a line in a prompt cannot be traced to the
          // interview that produced it.
          source: { roundId: flat[f].roundId || null, interviewId: str(iv.sourceInterviewId) || null },
        });

        if (!byDimension[dim]) byDimension[dim] = { contributors: [], lastMeasuredRound: null };
        if (byDimension[dim].contributors.indexOf(key) === -1) byDimension[dim].contributors.push(key);
        if (score !== null && score > 0) {
          if (byDimension[dim].lastMeasuredRound === null || round > byDimension[dim].lastMeasuredRound) {
            byDimension[dim].lastMeasuredRound = round;
          }
        }
      }
    }

    /*
     * Drop anyone who turned out to have no evidence on any dimension — a
     * person who scored every dimension 0 and recorded no findings. The record
     * is created optimistically above, before the dimensions are walked, so
     * without this an empty shell survives.
     *
     * An empty shell is not harmless: `selfView` would return a person with no
     * dimensions rather than null, and the caller cannot tell "this person said
     * nothing" from "this person was never interviewed". Those are different
     * facts and only one of them is worth putting in a prompt.
     */
    Object.keys(byPerson).forEach(function (pk) {
      if (!Object.keys(byPerson[pk].byDimension).length) delete byPerson[pk];
    });

    fromRounds.sort(function (a, b) { return a - b; });
    var newestRound = fromRounds.length ? fromRounds[fromRounds.length - 1] : null;

    // Second pass: recency. Latest verbatim, older as trajectory, staleness.
    Object.keys(byPerson).forEach(function (pk) {
      var P = byPerson[pk];
      P.roundsParticipated.sort(function (a, b) { return a - b; });
      var newestForPerson = P.roundsParticipated[P.roundsParticipated.length - 1];
      Object.keys(P.byDimension).forEach(function (dim) {
        var D = P.byDimension[dim];
        D.history.sort(function (a, b) { return a.round - b.round; });
        var scored = D.history.filter(function (h) { return h.score !== null; });
        var latest = D.history[D.history.length - 1];
        var latestScored = scored.length ? scored[scored.length - 1] : null;

        D.latest = latest;
        D.lastMeasuredRound = latestScored ? latestScored.round : null;
        D.score = latestScored ? latestScored.score : null;
        D.coverage = latestScored ? latestScored.coverage : null;

        /*
         * STALE means: this person has taken part in a round more recent than
         * the one where this dimension was last actually measured for them. Its
         * score is being carried forward, and the interview should re-evidence
         * it rather than accept the number restated back.
         *
         * This is the distinction round-2 scoring could not previously draw —
         * "unchanged because we asked and it is the same" versus "unchanged
         * because nobody asked".
         */
        D.stale = D.lastMeasuredRound !== null && newestForPerson > D.lastMeasuredRound;
        D.roundsSinceMeasured = D.lastMeasuredRound === null ? null
          : (newestRound === null ? 0 : newestRound - D.lastMeasuredRound);

        // Trajectory over ALL scored rounds; text kept only for the newest.
        D.trajectory = scored.map(function (h) { return { round: h.round, score: h.score }; });
        D.movement = scored.length > 1
          ? Math.round((scored[scored.length - 1].score - scored[0].score) * 10) / 10
          : null;
        var keepFrom = D.history.length - VERBATIM_ROUNDS;
        D.history.forEach(function (h, i) { if (i < keepFrom) h.text = null; });
      });
    });

    return {
      code: str(eng.code) || null,
      client: str(eng.client || eng.clientName) || null,
      derivedAt: null,   // stamped by the caller; this module stays pure
      fromRounds: fromRounds,
      newestRound: newestRound,
      byPerson: byPerson,
      byDimension: byDimension,
    };
  }

  /* ── Projections ──────────────────────────────────────────────────────────
   *
   * The privacy rule is a property of WHICH PROJECTION you ask for, not a
   * filter re-applied at each read site. Four sites with four slightly
   * different filters is exactly how one person's material came to be shown
   * under another person's name (v5.32.85) and how two holders of one role
   * came to share a context entry (v5.32.86).
   */

  /** Everything, attributed. For the consultant only. */
  function consultantView(memory) { return memory; }

  /**
   * One person's OWN material. Safe to quote verbatim in a prompt they will
   * see: quoting somebody back to themselves discloses nothing, which is why
   * this projection can be specific where `ambientView` cannot.
   */
  function selfView(memory, key, dims) {
    var P = memory && memory.byPerson ? memory.byPerson[key] : null;
    if (!P) return null;
    var want = isArr(dims) && dims.length ? dims : null;
    var out = { key: P.key, role: P.role, person: P.person, label: P.label,
                roundsParticipated: P.roundsParticipated.slice(), dimensions: {} };
    Object.keys(P.byDimension).forEach(function (dim) {
      if (want && want.indexOf(dim) === -1) return;
      var D = P.byDimension[dim];
      out.dimensions[dim] = {
        score: D.score, coverage: D.coverage,
        lastMeasuredRound: D.lastMeasuredRound, roundsSinceMeasured: D.roundsSinceMeasured,
        stale: D.stale, movement: D.movement,
        trajectory: D.trajectory.slice(),
        text: D.latest ? D.latest.text : null,
        source: D.latest ? D.latest.source : null,
      };
    });
    return out;
  }

  /**
   * What the ENGAGEMENT holds on these dimensions, with every attribution
   * removed and the asking person's own material excluded.
   *
   * Deliberately thin. This is the projection that can reach somebody who
   * should not know who said what, so it carries claim text and nothing that
   * identifies a speaker — no role, no name, no label, no counts by role.
   * Newest first, capped, because old rounds stop being context and become
   * noise.
   */
  function ambientView(memory, key, dims) {
    var want = isArr(dims) && dims.length ? dims : DIM_CODES;
    var out = {};
    want.forEach(function (dim) {
      var lines = [];
      Object.keys(memory.byPerson || {}).forEach(function (pk) {
        if (pk === key) return;                       // never their own
        var D = memory.byPerson[pk].byDimension[dim];
        if (!D || !D.latest || !D.latest.text) return;
        lines.push({ round: D.latest.round, text: D.latest.text });
      });
      lines.sort(function (a, b) { return b.round - a.round; });
      if (lines.length) out[dim] = lines.slice(0, AMBIENT_PER_DIM).map(function (l) { return l.text; });
    });
    return out;
  }

  /**
   * Rank context candidates for a prompt with a fixed budget.
   *
   * A prompt containing everything scores worse, not better — the model spreads
   * attention across material that does not matter. Order: on today's agenda,
   * then unresolved/stale, then their own prior words, then low coverage, then
   * recency.
   */
  function rankDimensions(self, agendaDims, limit) {
    var dims = Object.keys((self && self.dimensions) || {});
    var onAgenda = isArr(agendaDims) ? agendaDims : [];
    var scored = dims.map(function (d) {
      var D = self.dimensions[d];
      var w = 0;
      if (onAgenda.indexOf(d) !== -1) w += 1000;
      if (D.stale) w += 100;
      if (D.text) w += 50;
      if (D.coverage !== null && D.coverage < 0.5) w += 25;
      w += (D.lastMeasuredRound || 0);
      return { dim: d, w: w };
    });
    scored.sort(function (a, b) { return b.w - a.w || a.dim.localeCompare(b.dim); });
    var n = (typeof limit === "number" && limit > 0) ? limit : scored.length;
    return scored.slice(0, n).map(function (x) { return x.dim; });
  }

  return {
    DIM_CODES: DIM_CODES,
    VERBATIM_ROUNDS: VERBATIM_ROUNDS,
    AMBIENT_PER_DIM: AMBIENT_PER_DIM,
    personKey: personKey,
    sortRounds: sortRounds,
    build: build,
    consultantView: consultantView,
    selfView: selfView,
    ambientView: ambientView,
    rankDimensions: rankDimensions,
  };
});
