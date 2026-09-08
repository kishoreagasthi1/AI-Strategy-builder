/**
 * INTERVIEW DEPTH — one definition, three readers (v5.33.8).
 *
 * Depth is the question budget an interview runs to. It is chosen by the
 * consultant on the invite (interviews.html), stored on the interview row
 * (migration 028), and enforced by the agent (interview_agent.html). Before
 * v5.33.8 it was a `<select>` on a screen interviewees never see, persisted
 * nowhere, so every distributed interview ran as a Deep Dive whatever the
 * consultant picked.
 *
 * The numbers live HERE rather than in the pages because there are now three
 * places that need them — the invite form, the row editor and the agent — and a
 * fourth that quotes them at the client (the preview sheet). Three copies of a
 * table of numbers is three chances for the sheet to promise forty minutes
 * while the agent runs ninety.
 *
 * ── Two different budgets ─────────────────────────────────────────────────
 *
 * An INITIAL interview covers seven dimensions from nothing, so its budget is a
 * flat count. A FOLLOW-UP is a narrow round-close conversation against an
 * agenda, so its budget scales with the number of open agenda items — a
 * one-item follow-up should be short whatever depth says. Depth still applies,
 * but it moves the questions-per-item and the ceiling rather than replacing
 * them.
 *
 * ── Why `deep` reproduces the old numbers exactly ─────────────────────────
 *
 * 028 defaults the column to 'deep' and backfills every existing row to it. So
 * `deep` MUST be what the product did before the column existed, or the
 * migration silently changes the length of every interview in flight. It is:
 *
 *   initial   deep → 50            (interview_agent.html's old
 *                                   `S.depth==='deep'?50:...`)
 *   follow-up deep → 3/item, floor 6, cap 30, + mandatory
 *                                  (the old computeRefreshQuestionBudget)
 *
 * vyneDepth.test.ts pins both, so a later tidy-up of these tables cannot
 * quietly rewrite history.
 */
(function (root) {
  "use strict";

  var DEFAULT = "deep";

  /**
   * label   — what the consultant reads on the control
   * range   — the human range quoted in the UI and the preview sheet
   * initial — the agent's question budget for a first-round interview
   * prompt  — the instruction the model is given (was interview_agent's depthMap)
   * followUp — { perItem, floor, cap } for an agenda-driven refresh
   */
  var DEPTHS = {
    quick: {
      label: "Quick Screen",
      range: "20–25 questions",
      initial: 25,
      prompt: "20-25 questions -- prioritize highest-impact questions only",
      /* One question per topic, floored at 3 so even a single-item agenda gets
       * the question, a follow-up and a close. A quick follow-up is a
       * confirmation, not an exploration. */
      followUp: { perItem: 1, floor: 3, cap: 8 },
    },
    standard: {
      label: "Standard",
      range: "28–35 questions",
      initial: 35,
      prompt: "28-35 questions -- full coverage of priority dimensions",
      /* v5.33.8: this was 3 per item on its first draft, which made standard
       * and deep produce the SAME number for any agenda under the cap — they
       * differed only in a ceiling most follow-ups never reach. The unit test
       * that compares them at six items caught it. Two per item is a real
       * difference at every agenda size. */
      followUp: { perItem: 2, floor: 5, cap: 20 },
    },
    deep: {
      label: "Deep Dive",
      range: "40–50 questions",
      initial: 50,
      prompt: "40-50 questions -- comprehensive coverage of the in-scope dimensions (deep, not broad-for-its-own-sake)",
      /* DO NOT CHANGE without reading vyneDepth.test.ts. These three numbers
       * are the pre-028 computeRefreshQuestionBudget, and 028 backfills every
       * existing row to 'deep' — so moving them retroactively changes the
       * length of interviews that are already in flight. */
      followUp: { perItem: 3, floor: 6, cap: 30 },
    },
  };

  var ORDER = ["deep", "standard", "quick"];   // the order the controls offer

  /** Anything unrecognised — null, "", an old row, a typo — resolves to the default. */
  function normalize(d) {
    var k = String(d == null ? "" : d).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(DEPTHS, k) ? k : DEFAULT;
  }

  function spec(d) { return DEPTHS[normalize(d)]; }

  /** The agent's question budget for a first-round interview. */
  function initialBudget(d) { return spec(d).initial; }

  /**
   * The agent's question budget for an agenda-driven follow-up.
   *
   * `mandatory` questions are obligatory, so they are added ON TOP of the base
   * rather than counted against it — the same rule as before this module, and
   * the reason `high` and `low` differ.
   */
  function followUpBudget(d, items, mandatory) {
    var f = spec(d).followUp;
    var n = (typeof items === "number" && items > 0) ? items : 0;
    var base = Math.min(f.cap, Math.max(f.floor, n * f.perItem));
    var mq = (typeof mandatory === "number" && mandatory > 0) ? mandatory : 0;
    return { low: base, high: base + mq, items: n, mandatory: mq };
  }

  var api = {
    DEFAULT: DEFAULT,
    ORDER: ORDER,
    all: function () { return ORDER.map(function (k) {
      return { value: k, label: DEPTHS[k].label, range: DEPTHS[k].range };
    }); },
    normalize: normalize,
    label: function (d) { return spec(d).label; },
    range: function (d) { return spec(d).range; },
    prompt: function (d) { return spec(d).prompt; },
    initialBudget: initialBudget,
    followUpBudget: followUpBudget,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;              // Node / vitest
  }
  if (root) {
    root.VyneDepth = api;              // browser
  }
})(typeof window !== "undefined" ? window : this);
