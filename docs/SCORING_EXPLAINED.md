VYNE SCORING — HOW A NUMBER IS PRODUCED, WITH A WORKED EXAMPLE
==============================================================
v5.34.92 · 14 Sep 2026

Every figure in the worked example below was computed by running the actual
product code (frontend/vyne-scoring.js with the real VYNE_ROLE_WEIGHTS table),
not by hand. If the code changes, this document is wrong and should be redone
the same way.


THE SHORT VERSION
-----------------

There are FIVE stages, and they are easy to confuse because three of them
produce something called "a score".

  Stage 1   Per dimension, inside one interview     · the LLM scorer, 1–5
  Stage 2   That interview's own overall            · TIER-WEIGHTED mean
  Stage 3   Per dimension, across the round         · ROLE-WEIGHTED mean
  Stage 4   The engagement's overall                · TIER-WEIGHTED mean
  Stage 5   A follow-up round                       · coverage-weighted blend

Two different weightings exist and they do DIFFERENT jobs. People mix them up
constantly, so it is worth being blunt about it:

  · ROLE WEIGHTS (0.1 – 1.0) decide HOW MUCH ONE PERSON'S ANSWER COUNTS when
    several people are asked about the same dimension. They operate WITHIN a
    dimension — stage 3.

  · TIERS (lead / cover / light / excluded) do two things. They decide HOW
    MUCH OF THE INTERVIEW is spent on a dimension, and — since v5.34.92 —
    summed across the roles interviewed, they decide HOW MUCH EACH DIMENSION
    COUNTS toward the overall. They operate ACROSS dimensions — stages 2 and 4.

A dimension can be a LEAD dimension for a role and still carry a low role
weight, and vice versa. They are set independently and they are both correct:
"how much do we ask this person about D6" and "how much do we trust this
person on D6" are different questions.

Before v5.34.92 the overall was a plain mean across the seven dimensions, so a
low score on a dimension the engagement barely cared about counted exactly as
much as one on its central dimension. That is now fixed. It is a correctness
fix, not a re-scoring: on a typical roster the derived weights are fairly flat
and the overall moves by around 0.1 (2.8 → 2.7 in the example below).

Engagements scored BEFORE v5.34.92 keep the number they were delivered with.
The weights come from a snapshot stored on each interview record, and a round
containing any interview without one falls back to the plain mean.


THE SEVEN DIMENSIONS
--------------------

  D1  Data & Data Management
  D2  Technology & Infrastructure
  D3  AI Strategy & Vision
  D4  People & Skills
  D5  Process & Operations
  D6  Governance & Risk
  D7  Culture & Change Readiness


THE 1–5 SCALE
-------------

  1 = Not Started
  2 = Early / Ad Hoc
  3 = Developing
  4 = Advanced
  5 = Leading / Optimized

  0 is NOT a score. 0 means "no evidence yet". Everywhere in the code a
  dimension at 0 is skipped rather than averaged in as a zero. This matters:
  a dimension nobody spoke about must not drag a client's number down.

Maturity bands (applied to any score, per dimension or overall):

  4.5+   AI-Native
  3.5+   AI-Led
  2.5+   AI Capable
  1.5+   AI Exploring
  0+     AI Unaware


===============================================================================
STAGE 1 — WHAT ONE INTERVIEW PRODUCES
===============================================================================

During the interview, a scoring pass runs roughly every 20 seconds. It is
given the transcript so far and asked, for each dimension, either a 1–5 score
or "no evidence yet". It is also given the client's industry benchmarks, with
the instruction: "A claim of 4.5 where best-in-class is 3.8 requires deeper
evidence."

Scores go DOWN as well as up. If an executive says "we have a data platform"
and then, four questions later, describes three teams keeping their own
spreadsheets, D1 is revised downward. The number tracks the evidence, not the
first impression.

WHERE TIERS COME IN
-------------------

Before the interview starts, each role has its seven dimensions sorted into
three tiers. The default comes from the role table; Pre-Engagement can
override it per role, and a round can narrow it further.

For a CTO the default is:

    LEAD    D2, D1, D6      4–5 questions each
    COVER   D3, D5          2–3 questions each
    LIGHT   D4, D7          asked in passing, if it comes up

And critically: A DIMENSION THAT APPEARS IN NONE OF THE THREE TIERS IS
EXCLUDED. It is not "scored zero" — it is not part of this interview at all.
That happens when a consultant switches a dimension off for a role in
Pre-Engagement, or when a round's scope covers only some dimensions.

So a CTO's D4 score of 1.2 means "we asked two questions in passing and the
answers were thin". A CTO's D2 score of 1.2 means something much harder,
because four or five questions were spent on it. SAME NUMBER, DIFFERENT
WEIGHT OF EVIDENCE BEHIND IT.

That is what v5.34.91 put on the scorecard: every dimension card now carries
its tier, LIGHT and EXCLUDED dimensions never get a maturity label at all,
and no dimension gets one until the interview is closed.


===============================================================================
STAGE 2 — THAT INTERVIEW'S OWN OVERALL
===============================================================================

  Weighted mean across the dimensions that have evidence, using THIS ROLE'S
  OWN TIERS as the weights:

      lead 1.0   ·   cover 0.6   ·   light 0.3   ·   excluded 0

  No role weighting at this stage — it is one person, so there is nothing to
  weigh against anything. But the tiers still matter: a CTO's overall should
  lean on D2/D1/D6, because that is where the questions went.

  Example. A CTO interview scores D1 4.5, D2 1.0, D3 3.2, D6 2.0.
  D1/D2/D6 are lead (1.0 each), D3 is cover (0.6), D7 excluded.

      (4.5×1.0 + 1.0×1.0 + 3.2×0.6 + 2.0×1.0) ÷ (1.0+1.0+0.6+1.0)
      = 9.42 ÷ 3.6 = 2.62 → 2.6        (the plain mean would be 2.7)

This is the number on the interview's export sheet, and it is labelled "this
interview only". It is not the client's AI readiness score.


===============================================================================
STAGE 3 — THE ROUND SCORE PER DIMENSION (THE ROLE-WEIGHTED PART)
===============================================================================

This is where several interviews become one number per dimension.

    dimension score  =  Σ (person's score × that role's weight for that dim)
                        ────────────────────────────────────────────────────
                                   Σ (those same weights)

The weight table (VYNE_ROLE_WEIGHTS, one copy for the browser and one for the
server, held identical by a parity test):

           CDO   CTO   IT_D  CEO   CFO   COO   CHRO  VP_S  Ops_M  GC
    D1     1.0   0.8   0.7   0.4   0.4   0.5   0.3   0.3   0.3    0.2
    D2     0.7   1.0   0.9   0.3   0.3   0.4   0.2   0.2   0.4    0.1
    D3     0.9   0.7   0.3   1.0   0.8   0.6   0.4   0.5   0.3    0.3
    D4     0.7   0.5   0.4   0.6   0.4   0.5   1.0   0.4   0.6    0.2
    D5     0.5   0.5   0.4   0.5   0.7   1.0   0.4   0.6   0.9    0.2
    D6     0.9   0.8   0.8   0.5   0.6   0.4   0.3   0.2   0.3    1.0
    D7     0.6   0.5   0.3   1.0   0.4   0.7   1.0   0.5   0.8    0.2

Read it as: "how much should I trust this person on this subject." The CTO on
infrastructure is 1.0. The CTO on culture is 0.5. The General Counsel on
governance is 1.0 and on infrastructure is 0.1. A role not in the table gets
0.5.

If only one person was asked about a dimension, the weighting cancels out and
their score IS the dimension score — the weight only ever matters relatively.


===============================================================================
THE WORKED EXAMPLE
===============================================================================

Client:  Meridian Manufacturing
Round 1: three interviews

    Priya Raman    CTO
    Dan Whitfield  CFO
    Lena Okafor    CHRO

WHAT EACH INTERVIEW PRODUCED (stage 1)

    Dim   CTO    CFO    CHRO    notes
    ---------------------------------------------------------------
    D1    4.0    2.0    --      CHRO: not in her tiers, never asked
    D2    3.5    2.0    --      same
    D3    2.5    3.0    2.0
    D4    2.0    2.5    4.0
    D5    --     3.0    2.5     CTO: no evidence surfaced
    D6    1.5    2.0    --
    D7    2.0    2.0    3.5

"--" is no evidence, not zero. It contributes nothing and pulls nothing down.

THE ROUND SCORE, DIMENSION BY DIMENSION (stage 3)

D1 — Data & Data Management
    CTO   4.0 × 0.8 = 3.20
    CFO   2.0 × 0.4 = 0.80
                      ────
                      4.00  ÷ (0.8 + 0.4 = 1.2)  =  3.33  →  3.3

    Note what happened: the CTO and CFO disagreed by two full points, and the
    answer landed at 3.3 rather than at the midpoint 3.0, because on data the
    CTO is trusted twice as much as the CFO.

D2 — Technology & Infrastructure
    CTO   3.5 × 1.0 = 3.50
    CFO   2.0 × 0.3 = 0.60
                      ────
                      4.10  ÷ 1.3  =  3.15  →  3.2

    Here the CTO's weight is 1.0 against the CFO's 0.3, so the CFO's dissent
    barely moves it. That is deliberate: the CFO's view of the stack is worth
    recording, not worth averaging equally.

D3 — AI Strategy & Vision
    CTO 2.5 × 0.7 = 1.75
    CFO 3.0 × 0.8 = 2.40
    CHRO 2.0 × 0.4 = 0.80
                     ────
                     4.95  ÷ 1.9  =  2.61  →  2.6

D4 — People & Skills
    CTO 2.0 × 0.5 = 1.00
    CFO 2.5 × 0.4 = 1.00
    CHRO 4.0 × 1.0 = 4.00
                     ────
                     6.00  ÷ 1.9  =  3.16  →  3.2

    The plain average of 2.0, 2.5 and 4.0 is 2.83. The weighted answer is 3.2,
    because on people the CHRO carries 1.0 and the other two carry half that
    between them. This is the single clearest illustration of why the table
    exists.

D5 — Process & Operations
    CFO 3.0 × 0.7 = 2.10
    CHRO 2.5 × 0.4 = 1.00
                     ────
                     3.10  ÷ 1.1  =  2.82  →  2.8

    No COO was interviewed. D5's highest-weighted role (COO 1.0, Operations
    Manager 0.9) is missing from this round, so 2.8 rests on two secondary
    views. The number is honest; the roster is thin. This is the kind of gap
    that belongs in the Synthesis discussion, not in a footnote.

D6 — Governance & Risk
    CTO 1.5 × 0.8 = 1.20
    CFO 2.0 × 0.6 = 1.20
                     ────
                     2.40  ÷ 1.4  =  1.71  →  1.7

    1.7 is "AI Exploring", the lowest dimension in the engagement — and no
    General Counsel was interviewed, who would have carried 1.0 here. The two
    people who did answer both carry substantial weight on governance, so it
    is a real finding, but the authoritative voice is absent.

D7 — Culture & Change Readiness
    CTO 2.0 × 0.5 = 1.00
    CFO 2.0 × 0.4 = 0.80
    CHRO 3.5 × 1.0 = 3.50
                     ────
                     5.30  ÷ 1.9  =  2.79  →  2.8

THE ROUND SCORECARD

    D1  3.3   AI Capable
    D2  3.2   AI Capable
    D3  2.6   AI Capable
    D4  3.2   AI Capable
    D5  2.8   AI Capable
    D6  1.7   AI Exploring      ← the finding
    D7  2.8   AI Capable

STAGE 4 — THE ENGAGEMENT OVERALL

    Weighted mean of the seven dimension scores. The role weighting has
    already done its work inside each dimension and is NOT applied again —
    that would count it twice. What weights this level is the TIERING, summed
    across the three roles interviewed (lead 1.0, cover 0.6, light 0.3,
    excluded 0):

        Dim   CTO     CFO     CHRO    weight
        ------------------------------------
        D1    lead    cover   light    1.9
        D2    lead    light   light    1.6
        D3    cover   lead    cover    2.2
        D4    light   light   lead     1.6
        D5    cover   lead    cover    2.2
        D6    lead    lead    light    2.3
        D7    light   light   lead     1.6

    Read the weight column as "how much of this engagement's interviewing was
    aimed at this dimension". D6 is highest because two of the three roles
    lead on governance; D2 and D4 are lowest because only one role each leads
    on them.

        (3.3×1.9 + 3.2×1.6 + 2.6×2.2 + 3.2×1.6 + 2.8×2.2 + 1.7×2.3 + 2.8×1.6)
        ÷ (1.9 + 1.6 + 2.2 + 1.6 + 2.2 + 2.3 + 1.6)
        = 36.53 ÷ 13.4 = 2.73 → 2.7

    OVERALL: 2.7 — AI Capable      (the plain mean would have been 2.8)

    Note how little it moved, and why: with three roles the weights span
    1.6–2.3, a range of about 1.4×. The weighting stops a peripheral dimension
    counting as much as a central one; it does not restate the engagement.
    D6's low 1.7 pulls slightly harder now, which is correct — governance is
    what two of these three executives were principally there to talk about.


===============================================================================
STAGE 5 — A FOLLOW-UP ROUND
===============================================================================

A refresh interview does not replace the prior round. It blends into it, in
proportion to how much of the dimension it actually covered:

    new  =  prior × (1 − coverage)  +  fresh × coverage

Coverage is a 0–1 figure recorded per dimension by the refresh interview
(0.3 by default when it is not recorded). Half an hour revisiting D1 earns a
high coverage; one passing question earns a low one.

Continuing the example — Priya (CTO) is re-interviewed six weeks later, on D1
and D6 only:

    D1:  fresh 4.5, coverage 0.8
         3.3 × 0.2  +  4.5 × 0.8  =  0.66 + 3.60  =  4.26  →  4.3

    D6:  fresh 3.0, coverage 0.6
         1.7 × 0.4  +  3.0 × 0.6  =  0.68 + 1.80  =  2.48  →  2.5

    D2–D5 and D7 were not revisited and carry forward unchanged.

    New scorecard: 4.3, 3.2, 2.6, 3.2, 2.8, 2.5, 2.8
    New overall:   3.0 — AI Capable   (plain mean would be 3.1)

    The weights come from the round's own interview records, so a refresh
    round is weighted by whoever was re-interviewed in it.

    D6 moved from AI Exploring to AI Capable on the strength of one interview
    that covered 60% of the dimension. It did not jump to 3.0, because 40% of
    what is known about D6 still comes from the original round.


===============================================================================
THE THREE THINGS THAT ARE MOST OFTEN MISREAD
===============================================================================

1.  A LOW SCORE ON A LIGHT DIMENSION IS NOT A LOW MATURITY RATING.
    It usually means the dimension was barely asked about. As of v5.34.91 the
    scorecard will not print a maturity label on a light or excluded dimension
    at all, at any point — because the interview ending does not retroactively
    make two passing questions into an assessment.

2.  A LIVE NUMBER IS NOT A VERDICT.
    During the interview the meter moves, and it should — it is the evidence
    landing. But no maturity level is named until the interview is closed, and
    the engagement-level maturity is only set in Synthesis, across everyone.
    As of v5.34.91 the interviewee never sees the panel at all, and the
    interviewer will not discuss the firm's view of them if asked.

3.  A MISSING ROLE IS INVISIBLE IN THE NUMBER — so Synthesis now says it.
    D5 at 2.8 with no COO interviewed, and D6 at 1.7 with no General Counsel,
    are both arithmetically correct and both standing on the wrong people, and
    the Coverage Map beside them says "2 interviews — good", because it counts
    sittings rather than authority.

    As of v5.34.92 the Synthesis dashboard carries a ROSTER COVERAGE panel that
    reads the same weight table the scores were computed with and reports, per
    dimension, the highest authority that actually answered against the highest
    that exists:

        D6 · Governance & Risk     Scored by Chief Technology Officer (0.8),
                                   Chief Financial Officer (0.6). The
                                   highest-weighted voice on this dimension —
                                   General Counsel (1.0) — has not been
                                   interviewed.                        [THIN]

    Four states:

        WELL COVERED    the highest-weighted voice for this dimension is in
                        the roster (a tie at the top is covered by either one)
        THIN            someone answered, but not the most qualified role
        AUTHORITY GAP   the best voice that answered carries under 0.5, or
                        falls 0.4 or more below the best available
        NO EVIDENCE     nothing has scored this dimension; the panel names who
                        is best placed to answer it

    It changes no score. It is the sentence the score cannot say, and it is
    worth resolving before a round is finalised or a deck is generated.


===============================================================================
WHERE THIS LIVES IN THE CODE
===============================================================================

    frontend/vyne-scoring.js           the formula (browser)
    backend/src/tenant/scoring.ts      the formula (server) — byte-equivalent,
                                       held together by scoringParity.test.ts
    frontend/vyne-client.js            VYNE_ROLE_WEIGHTS (browser)
    backend/src/tenant/engagementMerge.ts
                                       VYNE_ROLE_WEIGHTS (server), held
                                       together by roleWeightParity.test.ts
    frontend/interview_agent.html      getRolePriorityData()  — the tiers
                                       buildLiveAgenda()      — tiers + scope
                                       dimensionTierMap()     — what the
                                         scorecard renders, read from the same
                                         agenda the interviewer is given
                                       computeOverall()       — stage 2
                                       writeInterviewToEngagement() — stores
                                         ivRecord.dimTiers, the snapshot every
                                         downstream weight is derived from

    dimensionWeights() / overallOf(scores, weights) live in the two scoring
    files above and are called by: interview_agent.html computeOverall,
    synthesis.html sxOverall (dashboard, round comparison, Word document),
    roadmap.html deckLoadPersonaScores + the deck cover, and on the server
    routes/scorecard.ts buildScorecard and tenant/engagementLookup.ts.
    backend/test/dimensionWeightWiring.test.ts asserts each of those wires.
