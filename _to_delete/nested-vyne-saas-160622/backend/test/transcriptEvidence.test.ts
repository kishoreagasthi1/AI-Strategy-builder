/**
 * The evidence beside a transcript (v5.32.66).
 *
 * A transcript answered "what was said" — which is not the question anyone
 * asks. They ask "why is D6 a 2.4", and that was answerable only by reading the
 * whole conversation and inferring, because the scores lived in the engagement
 * record and the words lived in interview_transcripts with nothing joining
 * them.
 *
 * What makes the join possible is something that has been thrown away since the
 * beginning: the interviewer model appends a full seven-dimension score block
 * to EVERY turn, and the transcript stripped it out as machine formatting. The
 * browser now journals each movement as it happens, and this module is the
 * server's half — shaping that journal, and reconstructing it from the raw
 * model messages for the interviews that complete on a page loaded before the
 * deploy.
 */
import { describe, it, expect } from "vitest";
import {
  normaliseScoreEvents,
  normaliseFindings,
  deriveScoreEventsFromMessages,
  transcriptEvidenceFor,
} from "../src/tenant/transcriptEvidence.js";

/** An assistant turn carrying the score envelope the interviewer emits. */
const turn = (scores: Record<string, number>, text = "Thanks — and how is that governed?") =>
  ({
    role: "assistant",
    content: `${text}\n<<<SCORES>>>\n${JSON.stringify({ scores })}\n<<<END_SCORES>>>`,
  });

describe("shaping the browser's journal", () => {
  it("keeps a well-formed movement whole", () => {
    const out = normaliseScoreEvents([
      { dimension: "D6", from: 2, to: 3, afterTurn: 8, at: 1_700_000_000_000 },
    ]);
    expect(out).toEqual([
      { dimension: "D6", from: 2, to: 3, afterTurn: 8, at: 1_700_000_000_000 },
    ]);
  });

  it("treats a first score as first evidence, not a move from zero", () => {
    // `from: null` renders as "first evidence" rather than "0.0 → 2.5". A
    // dimension arriving at 2.5 having never been scored is a different event
    // from one that was assessed at zero, and zero is not on the scale.
    const out = normaliseScoreEvents([{ dimension: "D1", from: null, to: 2.5, afterTurn: 2 }]);
    expect(out[0].from).toBeNull();
    expect(out[0].to).toBe(2.5);
  });

  it("clamps a score the model put outside the scale", () => {
    // coerceScore's reason for existing, restated here because this path is a
    // second consumer of model output: a 7 renders a 140% bar and drags a
    // round's weighted average into a client's scorecard.
    expect(normaliseScoreEvents([{ dimension: "D1", to: 7, afterTurn: 1 }])[0].to).toBe(5);
    expect(normaliseScoreEvents([{ dimension: "D1", to: "4", afterTurn: 1 }])[0].to).toBe(4);
  });

  it("drops entries that are not movements at all", () => {
    expect(normaliseScoreEvents([
      null, 7, "nope", {}, { dimension: "D1" }, { to: 3 }, { dimension: "D1", to: 0 },
    ])).toEqual([]);
  });

  it("is bounded — a runaway journal cannot be written into the row", () => {
    const huge = Array.from({ length: 5_000 }, (_, i) => ({ dimension: "D1", to: 3, afterTurn: i }));
    expect(normaliseScoreEvents(huge).length).toBe(2_000);
  });

  it("survives junk instead of an array", () => {
    for (const junk of [null, undefined, "", 42, {}]) {
      expect(normaliseScoreEvents(junk)).toEqual([]);
      expect(normaliseFindings(junk)).toEqual([]);
    }
  });

  it("keeps findings with their conversation position and truncates runaway text", () => {
    const out = normaliseFindings([
      { dimension: "D6", text: "Nobody owns governance.", afterTurn: 12, at: 1 },
      { dimension: "D1", text: "x".repeat(9_000), afterTurn: 4 },
      { dimension: "D1", text: "   " },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].afterTurn).toBe(12);
    expect(out[1].text.length).toBe(2_000);
  });
});

describe("reconstructing the trajectory from the model's own messages", () => {
  it("recovers a movement per change, not per restatement", () => {
    // The whole reason this is not a naive dump: the model restates all seven
    // dimensions every single turn. Recording each reported score would bury
    // the four real movements of an interview under three hundred repeats.
    const events = deriveScoreEventsFromMessages([
      { role: "user", content: "We have a warehouse but no catalogue." },
      turn({ D1: 2, D6: 0 }),
      { role: "user", content: "Nobody signs off on models." },
      turn({ D1: 2, D6: 1.5 }),
      { role: "user", content: "Actually there is a data council now." },
      turn({ D1: 2.5, D6: 1.5 }),
    ]);
    expect(events.map((e) => `${e.dimension} ${e.from ?? "-"}>${e.to}`))
      .toEqual(["D1 ->2", "D6 ->1.5", "D1 2>2.5"]);
  });

  it("marks reconstructed events as reconstructed", () => {
    // Their positions are approximate — `messages` and `displayMessages` are
    // different arrays. The UI says so, and it can only say so if this flag is
    // here, so a missing flag is a silent accuracy claim.
    const events = deriveScoreEventsFromMessages([turn({ D1: 3 })]);
    expect(events[0].derived).toBe(true);
  });

  it("ignores a turn whose score block is malformed", () => {
    const events = deriveScoreEventsFromMessages([
      { role: "assistant", content: "hello <<<SCORES>>> {not json <<<END_SCORES>>>" },
      turn({ D1: 3 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].dimension).toBe("D1");
  });

  it("ignores turns with no block, and the interviewee's own messages", () => {
    expect(deriveScoreEventsFromMessages([
      { role: "assistant", content: "Just a question, no envelope." },
      { role: "user", content: "<<<SCORES>>>{\"scores\":{\"D1\":5}}<<<END_SCORES>>>" },
    ])).toEqual([]);
  });

  it("returns nothing for a spoken interview, which writes no messages", () => {
    // Not a failure — the realtime path scores in a separate pass and never
    // stores `messages`. There is genuinely nothing to reconstruct, and the
    // viewer says "no trail was kept" rather than showing an empty panel.
    expect(deriveScoreEventsFromMessages(undefined)).toEqual([]);
    expect(deriveScoreEventsFromMessages([])).toEqual([]);
  });
});

describe("choosing what to store for one completed session", () => {
  it("prefers the browser's journal over reconstruction", () => {
    // The journal is accurate about position; reconstruction is not. When both
    // are available the accurate one has to win, or the fallback silently
    // degrades every interview.
    const out = transcriptEvidenceFor({
      scoreEvents: [{ dimension: "D6", from: 2, to: 3, afterTurn: 9, at: 5 }],
      messages: [turn({ D1: 4 })],
    });
    expect(out.scoreEvents).toHaveLength(1);
    expect(out.scoreEvents[0].dimension).toBe("D6");
    expect(out.scoreEvents[0].derived).toBeUndefined();
  });

  it("falls back to reconstruction when the journal is absent", () => {
    // The deploy window. A page loaded before the release finishes its
    // interview on old code and sends no journal; without this those
    // transcripts would have no trail for a reason that has nothing to do with
    // the interview.
    const out = transcriptEvidenceFor({ messages: [turn({ D1: 2 }), turn({ D1: 3 })] });
    expect(out.scoreEvents.map((e) => e.to)).toEqual([2, 3]);
    expect(out.scoreEvents.every((e) => e.derived)).toBe(true);
  });

  it("falls back to unanchored findings when the anchored ones are absent", () => {
    const out = transcriptEvidenceFor({
      findings: [{ dimension: "D6", text: "Nobody owns governance." }],
    });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].afterTurn).toBeNull();
  });

  it("prefers anchored findings when both are present", () => {
    const out = transcriptEvidenceFor({
      findingEvents: [{ dimension: "D6", text: "Anchored.", afterTurn: 11 }],
      findings: [{ dimension: "D6", text: "Flat." }],
    });
    expect(out.findings[0].text).toBe("Anchored.");
    expect(out.findings[0].afterTurn).toBe(11);
  });

  it("returns empty for a session with nothing in it, without throwing", () => {
    expect(transcriptEvidenceFor({})).toEqual({ findings: [], scoreEvents: [] });
  });
});
