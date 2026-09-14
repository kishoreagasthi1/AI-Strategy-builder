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

  it("re-running an INITIAL interview for the same role replaces the prior entry", () => {
    let eng: EngagementRecord | null = mergeSessionIntoEngagement(null, "ACME-1", {
      client: "Acme", stakeholderRole: "CEO", scores: { D3: 2.0 }, findings: [],
    }, { sourceInterviewId: "iv-1", kind: "initial" });
    eng = mergeSessionIntoEngagement(eng, "ACME-1", {
      client: "Acme", stakeholderRole: "CEO", scores: { D3: 4.0 }, findings: [],
    }, { sourceInterviewId: "iv-1-rerun", kind: "initial" });

    expect(eng.rounds![0].interviews).toHaveLength(1); // replaced, not appended
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
    expect(round2.scores.D2).toBeCloseTo(3.5);
    // D1 wasn't touched in the refresh — carried forward from Round 1.
    expect(round2.scores.D1).toBeCloseTo(2.0);
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
