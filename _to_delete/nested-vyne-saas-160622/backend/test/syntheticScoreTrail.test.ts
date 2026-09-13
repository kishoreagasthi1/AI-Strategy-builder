/**
 * synthScoreEvents — the generator's score trail, validated (v5.32.89).
 *
 * This file exists because of a gap in the test that shipped with the fix.
 *
 * `synthetic.test.ts` asserts that every synthetic transcript carries a
 * non-null `score_events`. It passes. But its fake adapter returns
 * `{scores, findings, summary}` and no `scoreEvents` at all — so the only path
 * it ever walks is the FALLBACK, the one that manufactures a trail from the
 * final scores when the model gave nothing usable. The path that runs in
 * production, where a real model returns a trail that must be parsed and
 * bounded, had no coverage whatsoever, while the suite read as though the
 * feature were tested.
 *
 * That is the same failure mode as the bug being fixed: a check reporting
 * something narrower than it appears. So the normaliser is tested here
 * directly, against a model that returns a trail — including the ways a model
 * gets one wrong — and `synthetic.test.ts`'s adapter now emits a trail too, so
 * the integration path is the real one.
 *
 * No database: this is a pure function.
 */
import { describe, it, expect } from "vitest";
import { synthScoreEvents } from "../src/routes/synthetic.js";

const SCORES = { D1: 2.1, D2: 2.4, D3: 3.1, D4: 2.0, D5: 2.5, D6: 1.4, D7: 2.6 };

describe("synthScoreEvents — a trail the model supplied", () => {
  it("keeps a well-formed event exactly as given", () => {
    const out = synthScoreEvents(
      [{ dimension: "D6", from: 3, to: 1, afterTurn: 4 }], 8, SCORES);
    expect(out).toEqual([
      { dimension: "D6", from: 3, to: 1, afterTurn: 4, at: null },
    ]);
  });

  it("accepts a first sighting, where there is no prior score to move from", () => {
    // from:null is not a defect. It is "this is the first time the dimension
    // was evidenced", and the viewer renders it differently from a movement.
    const out = synthScoreEvents([{ dimension: "D1", to: 2, afterTurn: 2 }], 6, SCORES);
    expect(out[0].from).toBeNull();
    expect(out[0].to).toBe(2);
  });

  it("uppercases a lowercase dimension rather than dropping the event", () => {
    const out = synthScoreEvents([{ dimension: "d3", to: 3, afterTurn: 1 }], 5, SCORES);
    expect(out[0].dimension).toBe("D3");
  });

  it("preserves the model's ordering, which is the order the turns happened in", () => {
    const out = synthScoreEvents([
      { dimension: "D5", to: 2, afterTurn: 2 },
      { dimension: "D1", to: 3, afterTurn: 5 },
      { dimension: "D7", to: 4, afterTurn: 7 },
    ], 8, SCORES);
    expect(out.map((e) => e.dimension)).toEqual(["D5", "D1", "D7"]);
  });
});

describe("synthScoreEvents — the ways a model gets a trail wrong", () => {
  it("drops a dimension outside D1-D7", () => {
    const out = synthScoreEvents([
      { dimension: "D9", to: 3, afterTurn: 1 },
      { dimension: "governance", to: 3, afterTurn: 1 },
      { dimension: "D2", to: 3, afterTurn: 1 },
    ], 4, null);
    expect(out.map((e) => e.dimension)).toEqual(["D2"]);
  });

  it("drops a score outside 1-5, including 0", () => {
    // 0 has meant "no evidence" everywhere in this product since v5.31. An
    // event that lands a dimension on 0 is the model misreading the scale,
    // not a real movement to record.
    const out = synthScoreEvents([
      { dimension: "D1", to: 0, afterTurn: 1 },
      { dimension: "D2", to: 6, afterTurn: 1 },
      { dimension: "D3", to: -1, afterTurn: 1 },
      { dimension: "D4", to: "three", afterTurn: 1 },
      { dimension: "D5", to: 5, afterTurn: 1 },
    ], 4, null);
    expect(out.map((e) => e.dimension)).toEqual(["D5"]);
  });

  it("ignores an out-of-range `from` without losing the event", () => {
    // The destination is the fact worth keeping. A bad origin degrades the
    // event to a first sighting rather than discarding a real movement.
    const out = synthScoreEvents([{ dimension: "D1", from: 9, to: 3, afterTurn: 1 }], 4, null);
    expect(out).toHaveLength(1);
    expect(out[0].from).toBeNull();
    expect(out[0].to).toBe(3);
  });

  it("clamps an anchor past the end of the transcript to the last turn", () => {
    // A trail pointing at turn 40 of an 8-turn conversation renders as a
    // citation to nothing. Clamping keeps the movement and loses only the
    // position, which was already wrong.
    const out = synthScoreEvents([{ dimension: "D1", to: 3, afterTurn: 40 }], 8, null);
    expect(out[0].afterTurn).toBe(8);
  });

  it("anchors a missing or nonsense turn at the end of the conversation", () => {
    const out = synthScoreEvents([
      { dimension: "D1", to: 3 },
      { dimension: "D2", to: 3, afterTurn: 0 },
      { dimension: "D3", to: 3, afterTurn: "late" },
    ], 6, null);
    expect(out.map((e) => e.afterTurn)).toEqual([6, 6, 6]);
  });

  it("never anchors below turn 1, even for an empty transcript", () => {
    const out = synthScoreEvents([{ dimension: "D1", to: 3, afterTurn: 5 }], 0, null);
    expect(out[0].afterTurn).toBe(1);
  });

  it("keeps the first event per dimension and drops repeats", () => {
    const out = synthScoreEvents([
      { dimension: "D1", to: 2, afterTurn: 2 },
      { dimension: "D1", to: 4, afterTurn: 6 },
    ], 8, null);
    expect(out).toHaveLength(1);
    expect(out[0].to).toBe(2);
  });

  it("survives junk in place of the array, and junk inside it", () => {
    expect(synthScoreEvents(null, 5, null)).toEqual([]);
    expect(synthScoreEvents("D1 went up", 5, null)).toEqual([]);
    expect(synthScoreEvents({ dimension: "D1" }, 5, null)).toEqual([]);
    expect(synthScoreEvents([null, 7, "x", { dimension: "D1", to: 3, afterTurn: 1 }], 5, null))
      .toHaveLength(1);
  });

  it("caps the trail so one runaway response cannot bloat a transcript row", () => {
    // Dedupe alone bounds this at 7 in practice; the cap is the belt to that
    // brace, and is asserted so a future change to dedupe cannot quietly
    // remove the bound.
    const many = Array.from({ length: 200 }, (_, i) => ({
      dimension: "D" + ((i % 7) + 1), to: 3, afterTurn: 1,
    }));
    expect(synthScoreEvents(many, 5, null).length).toBeLessThanOrEqual(40);
  });
});

describe("synthScoreEvents — the fallback, when the model gave nothing usable", () => {
  it("derives a trail from the final scores, anchored at the last turn", () => {
    const out = synthScoreEvents(undefined, 9, { D1: 2, D6: 4 });
    expect(out).toEqual([
      { dimension: "D1", from: null, to: 2, afterTurn: 9, at: null },
      { dimension: "D6", from: null, to: 4, afterTurn: 9, at: null },
    ]);
  });

  it("falls back when every supplied event was rejected, not only when none were sent", () => {
    // An all-invalid trail and an absent one leave the reader in the same
    // place: an evidence panel reading "nothing was measured" for an interview
    // that plainly measured something.
    const out = synthScoreEvents([{ dimension: "D9", to: 99 }], 4, { D2: 3 });
    expect(out).toEqual([
      { dimension: "D2", from: null, to: 3, afterTurn: 4, at: null },
    ]);
  });

  it("does not fall back when even one event survived", () => {
    // The model's own trail is anchored to turns; the fallback is not. Mixing
    // them would present derived positions as though the model had placed
    // them.
    const out = synthScoreEvents([{ dimension: "D1", to: 2, afterTurn: 3 }], 8, SCORES);
    expect(out).toHaveLength(1);
    expect(out[0].afterTurn).toBe(3);
  });

  it("skips unscored dimensions rather than inventing a zero", () => {
    const out = synthScoreEvents(null, 5, { D1: 0, D2: 3, D9: 4, D3: "x" });
    expect(out.map((e) => e.dimension)).toEqual(["D2"]);
  });

  it("returns an empty trail when there is genuinely nothing to say", () => {
    // Empty, not a placeholder event. The insert writes NULL for this, and
    // the viewer's "no trail was stored" line is then true rather than a
    // fabricated trail nobody can trace.
    expect(synthScoreEvents(null, 5, null)).toEqual([]);
    expect(synthScoreEvents([], 5, {})).toEqual([]);
    expect(synthScoreEvents([], 5, { D1: 0 })).toEqual([]);
  });
});
