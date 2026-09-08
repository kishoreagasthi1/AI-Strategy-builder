/**
 * Tracker → Synthesis auto-flow — pure-function coverage for
 * src/tenant/engagementMerge.ts (no DB needed; the route-level wiring is
 * exercised through test/interviews.test.ts's RLS-gated HTTP suite).
 */
import { describe, it, expect } from "vitest";
import { mergeSessionIntoEngagement, pickLatestSession, type EngagementRecord } from "../src/tenant/engagementMerge.js";

describe("pickLatestSession", () => {
  it("returns null when no vynora_session_* keys are present", () => {
    expect(pickLatestSession({ vynora_other_key: "{}" })).toBeNull();
  });

  it("picks the session with the greatest lastSaved among several", () => {
    const state = {
      vynora_session_a: JSON.stringify({ sessionId: "a", lastSaved: 100 }),
      vynora_session_b: JSON.stringify({ sessionId: "b", lastSaved: 300 }),
      vynora_session_c: JSON.stringify({ sessionId: "c", lastSaved: 200 }),
    };
    expect(pickLatestSession(state)?.sessionId).toBe("b");
  });

  it("skips malformed JSON rather than throwing", () => {
    const state = {
      vynora_session_bad: "{not json",
      vynora_session_ok: JSON.stringify({ sessionId: "ok", lastSaved: 1 }),
    };
    expect(pickLatestSession(state)?.sessionId).toBe("ok");
  });
});

describe("mergeSessionIntoEngagement", () => {
  it("creates a fresh engagement record and Round 1 for a first interview", () => {
    const eng = mergeSessionIntoEngagement(null, "ACME-1", {
      client: "Acme Industrial", stakeholderRole: "CDO",
      scores: { D1: 3.0, D2: 2.5 }, findings: [{ dimension: "D1", text: "Three warehouses, no single source of truth." }],
    }, { sourceInterviewId: "iv-1", kind: "initial" });

    expect(eng.code).toBe("ACME-1");
    expect(eng.rounds).toHaveLength(1);
    expect(eng.rounds![0].roundNumber).toBe(1);
    expect(eng.rounds![0].interviews).toHaveLength(1);
    expect(eng.rounds![0].scores.D1).toBeCloseTo(3.0);
    expect(eng.rounds![0].scores.D2).toBeCloseTo(2.5);
  });

  it("re-running a NAMED initial interview for the same person replaces the prior entry", () => {
    let eng: EngagementRecord | null = mergeSessionIntoEngagement(null, "ACME-1", {
      client: "Acme", stakeholderRole: "CEO", stakeholderName: "Victoria Hale",
      scores: { D3: 2.0 }, findings: [],
    }, { sourceInterviewId: "iv-1", kind: "initial" });
    eng = mergeSessionIntoEngagement(eng, "ACME-1", {
      client: "Acme", stakeholderRole: "CEO", stakeholderName: "Victoria Hale",
      scores: { D3: 4.0 }, findings: [],
    }, { sourceInterviewId: "iv-1-rerun", kind: "initial" });

    expect(eng.rounds![0].interviews).toHaveLength(1); // replaced, not appended
    expect(eng.rounds![0].scores.D3).toBeCloseTo(4.0);
  });

  it("two ANONYMOUS interviews for the same role are kept, not silently merged", () => {
    // v5.32.29 (audit CR-2). This used to replace, because an empty name fell
    // through the identity check and left role alone as the key — which is how
    // an interviewee could submit {"stakeholderRole":"CEO","stakeholderName":""}
    // and overwrite the real CEO's record. Identity now has to be positive:
    // same person only when both names are known and equal.
    //
    // The cost is a duplicate row when nobody is named, which a consultant can
    // see and delete. The alternative cost was silent destruction of evidence.
    // Distributed interviews always carry a name (interviewee_name is required
    // at invite and pinned server-side), so this only affects unnamed
    // consultant-run sessions.
    let eng: EngagementRecord | null = mergeSessionIntoEngagement(null, "ACME-1", {
      client: "Acme", stakeholderRole: "CEO", scores: { D3: 2.0 }, findings: [],
    }, { sourceInterviewId: "iv-1", kind: "initial" });
    eng = mergeSessionIntoEngagement(eng, "ACME-1", {
      client: "Acme", stakeholderRole: "CEO", scores: { D3: 4.0 }, findings: [],
    }, { sourceInterviewId: "iv-2", kind: "initial" });

    expect(eng.rounds![0].interviews).toHaveLength(2);
  });

  it("the SAME interview re-completed is still idempotent", () => {
    // sourceInterviewId dedupe is what makes re-completion safe; it is checked
    // before the name/role path and is unaffected by the change above.
    let eng: EngagementRecord | null = mergeSessionIntoEngagement(null, "ACME-1", {
      client: "Acme", stakeholderRole: "CEO", scores: { D3: 2.0 }, findings: [],
    }, { sourceInterviewId: "iv-1", kind: "initial" });
    eng = mergeSessionIntoEngagement(eng, "ACME-1", {
      client: "Acme", stakeholderRole: "CEO", scores: { D3: 4.0 }, findings: [],
    }, { sourceInterviewId: "iv-1", kind: "initial" });

    expect(eng.rounds![0].interviews).toHaveLength(1);
    expect(eng.rounds![0].scores.D3).toBeCloseTo(4.0);
  });

  it("a FOLLOW-UP for the same role appends alongside the initial interview instead of replacing it", () => {
    let eng: EngagementRecord | null = mergeSessionIntoEngagement(null, "ACME-1", {
      client: "Acme", stakeholderRole: "COO", scores: { D5: 2.0 }, findings: [],
    }, { sourceInterviewId: "iv-initial", kind: "initial" });
    eng = mergeSessionIntoEngagement(eng, "ACME-1", {
      client: "Acme", stakeholderRole: "COO", scores: { D5: 3.5 }, findings: [],
    }, { sourceInterviewId: "iv-followup", kind: "follow_up", parentInterviewId: "iv-initial" });

    expect(eng.rounds![0].interviews).toHaveLength(2);
    const followUpEntry = eng.rounds![0].interviews.find((i) => (i as any).followUp) as any;
    expect(followUpEntry).toBeTruthy();
    expect(followUpEntry.parentInterviewId).toBe("iv-initial");
    // The follow-up's newer D5 read wins in the round's blended score (both
    // entries share the same role weight, so the average moves toward it).
    expect(eng.rounds![0].scores.D5).toBeGreaterThan(2.0);
  });

  it("routes a refresh session into its own round and carries forward unscored dimensions", () => {
    let eng: EngagementRecord | null = mergeSessionIntoEngagement(null, "ACME-1", {
      client: "Acme", stakeholderRole: "CTO", scores: { D1: 2.0, D2: 2.5 }, findings: [],
    }, { sourceInterviewId: "iv-1", kind: "initial" });
    eng = mergeSessionIntoEngagement(eng, "ACME-1", {
      client: "Acme", stakeholderRole: "CTO", scores: { D2: 3.5 }, findings: [],
      isRefresh: true, refreshRound: 2,
    }, { sourceInterviewId: "iv-2", kind: "initial" });

    expect(eng.rounds).toHaveLength(2);
    const round2 = eng.rounds!.find((r) => r.roundNumber === 2)!;
    /* v5.32.59 (F6). This asserted a bare 3.5 — the refresh's raw weighted
     * mean — because this module did not blend. synthesis.html DID, and wrote
     * to the same field, so the stored value flipped between 3.5 and 2.8
     * depending on which had run most recently. Both writers now go through
     * tenant/scoring.ts, and 2.8 is the answer:
     *
     *   the refresh reported no per-dimension coverage, so it gets the low
     *   default weight of 0.3 — "we re-asked about D2 but did not say how much
     *   of it we covered" should nudge the stored score, not replace it —
     *   giving 2.5*0.7 + 3.5*0.3 = 2.8.
     */
    expect(round2.scores.D2).toBeCloseTo(2.8);
    expect((round2 as Record<string, any>).scoreBlend.D2)
      .toEqual({ prior: 2.5, raw: 3.5, weight: 0.3, blended: 2.8 });
    // D1 wasn't touched in the refresh — carried forward from Round 1.
    expect(round2.scores.D1).toBeCloseTo(2.0);
  });

  it("a refresh that reports full coverage stands on its own reading", () => {
    let eng: EngagementRecord | null = mergeSessionIntoEngagement(null, "ACME-1", {
      client: "Acme", stakeholderRole: "CTO", scores: { D2: 2.5 }, findings: [],
    }, { sourceInterviewId: "iv-1", kind: "initial" });
    eng = mergeSessionIntoEngagement(eng, "ACME-1", {
      client: "Acme", stakeholderRole: "CTO", scores: { D2: 3.5 }, findings: [],
      isRefresh: true, refreshRound: 2, coverageByDim: { D2: 1 },
    }, { sourceInterviewId: "iv-2", kind: "initial" });

    // Coverage 1.0 — the refresh re-asked the whole dimension, so none of the
    // prior number survives.
    const round2 = eng.rounds!.find((r) => r.roundNumber === 2)!;
    expect(round2.scores.D2).toBeCloseTo(3.5);
  });

  it("the FIRST round never blends", () => {
    // Blending a first assessment would invent a number nobody measured.
    const eng = mergeSessionIntoEngagement(null, "ACME-1", {
      client: "Acme", stakeholderRole: "CTO", scores: { D2: 4.0 }, findings: [],
    }, { sourceInterviewId: "iv-1", kind: "initial" });
    expect(eng.rounds![0].scores.D2).toBeCloseTo(4.0);
    expect((eng.rounds![0] as Record<string, any>).scoreBlend).toBeUndefined();
  });

  it("re-merging the SAME source interview id is idempotent (dedupes, never duplicates)", () => {
    let eng: EngagementRecord | null = mergeSessionIntoEngagement(null, "ACME-1", {
      client: "Acme", stakeholderRole: "CHRO", scores: { D4: 2.0 }, findings: [],
    }, { sourceInterviewId: "iv-x", kind: "initial" });
    eng = mergeSessionIntoEngagement(eng, "ACME-1", {
      client: "Acme", stakeholderRole: "CHRO", scores: { D4: 2.5 }, findings: [],
    }, { sourceInterviewId: "iv-x", kind: "initial" });

    expect(eng.rounds![0].interviews).toHaveLength(1);
    expect(eng.rounds![0].scores.D4).toBeCloseTo(2.5);
  });
});
