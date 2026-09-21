/**
 * The voice interviewer does not talk itself into finishing. (v5.34.111)
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * The v5.34.110 soak closed at 4.4 minutes after 22 questions, on a --loop run
 * where the tape was not the limit. The INTERVIEWER decided it was done.
 *
 * Five causes, all the same shape — two sides of a seam that do not agree.
 * FINDINGS-early-close.md has the full write-up; what matters here is that
 * every one of them is a property of the instruction text, so every one of
 * them can be pinned without spending a cent on a live model.
 *
 *   F1  The consultant picks an interview SIZE (vyne-depth.js: Quick 20-25,
 *       Standard 28-35, Deep Dive 40-50, defaulting to Deep Dive). The TEXT
 *       interviewer is told it. The VOICE interviewer never was — there was no
 *       field for it on InterviewerContext, none on the wire, none in the mint
 *       body. 22 questions was an unguided guess against a 40-50 booking.
 *
 *   F2  `evidenced` is computed as `score > 0` and rendered as "You already
 *       have real evidence on D1...D5". CLOSING_RULES keys DONE on "when you
 *       have real evidence across the dimensions". The agenda block asserted
 *       the closing rule's own premise, in its own words.
 *
 *   F3  As the interview progresses the only text asserting that work REMAINS
 *       (the firm's required questions) is deleted, while nine prohibition
 *       sentences are added. Measured: 10 sentences out, all reasons to
 *       continue; 9 in, all reasons to stop. Strictly one-directional drift.
 *
 *   F4  A `lead` dimension — "most of the interview should live here" — was
 *       closed off by "do not ask about those again" on its first score.
 *
 *   F5  "If you are TOLD that time is running short" — nothing ever told it.
 *
 * ── What these tests protect ────────────────────────────────────────────────
 *
 * The invariant, stated once: **while the interview still has ground to cover,
 * the instruction must say so.** Everything below is that property checked
 * from a different angle, including a sweep over the whole question range
 * rather than the two or three points somebody happened to observe.
 *
 * Deliberately NOT pinned: the exact wording of any sentence. Two tests were
 * lost this session to pinning prose that was then correctly rewritten. These
 * assert what the instruction must MEAN.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildInterviewerInstruction } from "../src/llm/interviewerPersona.js";
import type { InterviewerContext } from "../src/llm/interviewerPersona.js";

const FENCE = "--- BEGIN BACKGROUND ---";

/** A mid-interview context: scorer has fired, required questions are done. */
const midInterview = (over: Record<string, unknown> = {}): InterviewerContext => ({
  interviewerName: "Vyn",
  intervieweeRole: "VP Operations",
  clientName: "Northwind Foods",
  agenda: {
    lead: ["D2", "D3"],
    cover: ["D1", "D4"],
    light: ["D5", "D6", "D7"],
    evidenced: ["D1", "D2", "D3", "D4", "D5"],
  },
  mandatoryCount: 0,
  askedCount: 22,
  questionTargetLow: 40,
  questionTargetHigh: 50,
  ...over,
}) as InterviewerContext;

/** Text above the data fence — the only part that carries authority. */
const aboveFence = (s: string) => s.split(FENCE)[0];

/*
 * The AGENDA paragraph, isolated.
 *
 * Every assertion about interview PROGRESS has to be scoped to this block.
 * The first draft of these tests searched the whole instruction for words like
 * "outstanding" and "left", and passed before the fix was written — because
 * CLOSING_RULES already contains "nothing left worth asking" and "questions
 * outstanding". That is the same failure that cost this session two probes:
 * matching prose that happens to contain the word, rather than the sentence
 * that carries the meaning. Anchored on the one sentence that opens the
 * agenda and has never moved.
 */
const AGENDA_ANCHOR = "This interview exists to gather evidence";
const agendaBlock = (s: string) => {
  const para = s.split("\n\n").find((p) => p.includes(AGENDA_ANCHOR));
  if (!para) throw new Error("agenda block not found — the anchor sentence moved");
  return para;
};

/** The sentence in the agenda that names dimensions already covered, if any. */
const coveredSentence = (s: string) =>
  agendaBlock(s)
    .split(/(?<=\.)\s+/)
    .find((x) => /\bD\d\b/.test(x) && /already|covered|have\b/i.test(x) && !/Go deep on|Cover properly|Touch briefly|gather evidence across/i.test(x));

describe("F1 — the interview's size reaches the voice interviewer", () => {
  it("states the question target when the caller supplies one", () => {
    const s = buildInterviewerInstruction(midInterview());
    expect(s).toMatch(/\b40\b/);
    expect(s).toMatch(/\b50\b/);
  });

  it("puts the target above the data fence, where the rules are", () => {
    const s = buildInterviewerInstruction(
      midInterview({ context: "BRIEFING: mid-ERP-migration." }),
    );
    expect(aboveFence(s)).toMatch(/\b40\b/);
  });

  it("says how many have been asked, so the target has a reference point", () => {
    const s = buildInterviewerInstruction(midInterview({ askedCount: 22 }));
    expect(s).toMatch(/\b22\b/);
  });

  it("omits the target entirely when the caller does not supply one", () => {
    // A missing budget must not become a fabricated one — an interview with no
    // configured depth should behave exactly as it did before this change.
    const s = buildInterviewerInstruction(
      midInterview({ questionTargetLow: undefined, questionTargetHigh: undefined }),
    );
    expect(s).not.toMatch(/\b40\b/);
  });

  it("survives a garbage target without emitting one", () => {
    for (const bad of [0, -5, NaN, Infinity, "40" as unknown as number]) {
      const s = buildInterviewerInstruction(
        midInterview({ questionTargetLow: bad, questionTargetHigh: bad }),
      );
      expect(typeof s).toBe("string");
      expect(s).not.toMatch(/NaN|Infinity|undefined|null/);
    }
  });

  it("never lets the low bound exceed the high bound in what it prints", () => {
    const s = buildInterviewerInstruction(
      midInterview({ questionTargetLow: 50, questionTargetHigh: 40 }),
    );
    const m = s.match(/(\d+)\s*(?:to|–|-|and)\s*(\d+) questions/i);
    if (m) expect(Number(m[1])).toBeLessThanOrEqual(Number(m[2]));
  });
});

describe("F2 — the agenda does not assert the closing rule's premise", () => {
  /*
   * CLOSING_RULES makes DONE conditional on "real evidence across the
   * dimensions". If the agenda block says the interviewer HAS real evidence,
   * the condition is satisfied by the prompt rather than by the interview.
   * The covered-dimensions sentence must therefore not claim evidence is real,
   * complete or sufficient — it exists to stop repetition, nothing more.
   */
  it("does not tell the interviewer it has 'real evidence' on scored dimensions", () => {
    const s = buildInterviewerInstruction(midInterview());
    const claim = /you (?:already )?have real evidence on/i;
    expect(s).not.toMatch(claim);
  });

  it("still tells it not to re-ask what is already covered", () => {
    // The anti-repetition job of `evidenced` must survive the fix.
    const s = buildInterviewerInstruction(midInterview());
    expect(s).toMatch(/D1|D4/);
    expect(s.toLowerCase()).toMatch(/again|already|covered/);
  });

  it("keeps the DONE condition itself in the instruction", () => {
    const s = buildInterviewerInstruction(midInterview());
    expect(s).toMatch(/DONE/);
  });
});

describe("F3 — the instruction never stops saying there is ground left", () => {
  /*
   * The regression that produced the 4.4-minute close. Swept rather than
   * sampled: at every question count below the target, with every required
   * question already asked and every dimension already scored — the worst
   * case, and the one the soak actually hit — the instruction must still
   * assert outstanding work.
   */
  const OUTSTANDING = /still|remain|outstanding|left|not (?:yet|finished)|more to/i;
  /** Scoped to the agenda — CLOSING_RULES contains these words already. */
  const saysGroundRemains = (s: string) => OUTSTANDING.test(agendaBlock(s));

  it("asserts outstanding ground at every count below the target", () => {
    for (let asked = 0; asked < 40; asked++) {
      const s = buildInterviewerInstruction(midInterview({ askedCount: asked }));
      expect(
        saysGroundRemains(s),
        `askedCount=${asked} produced an agenda with nothing outstanding`,
      ).toBe(true);
    }
  });

  it("asserts it even with every dimension scored and no required questions left", () => {
    const s = buildInterviewerInstruction(
      midInterview({
        agenda: {
          lead: ["D2", "D3"],
          cover: ["D1", "D4"],
          light: ["D5", "D6", "D7"],
          evidenced: ["D1", "D2", "D3", "D4", "D5", "D6", "D7"],
        },
        mandatoryCount: 0,
        askedCount: 10,
      }),
    );
    expect(saysGroundRemains(s)).toBe(true);
  });

  it("stops asserting it once the target is genuinely reached", () => {
    // The fix must not simply make the interviewer unstoppable — the padding
    // failure this closing block was written for (40 repetitions of one
    // question) is worse than closing early.
    const s = buildInterviewerInstruction(midInterview({ askedCount: 55 }));
    expect(s).toMatch(/DONE|close|finish/i);
  });

  it("does not lose the required-question block's job when the count hits zero", () => {
    /*
     * F3 proper: the "firm requires" block was the ONLY outstanding-work text,
     * and it is deleted at mandatoryCount 0. Whatever replaces it must not be
     * conditional on the same thing.
     */
    const withMandatory = buildInterviewerInstruction(midInterview({ mandatoryCount: 2 }));
    const without = buildInterviewerInstruction(midInterview({ mandatoryCount: 0 }));
    expect(saysGroundRemains(withMandatory)).toBe(true);
    expect(saysGroundRemains(without)).toBe(true);
  });
});

describe("F4 — a lead dimension is never closed off by its first score", () => {
  it("does not put a lead dimension on the do-not-ask list", () => {
    /*
     * "Go deep on D2, D3 — most of the interview should live here" and "do not
     * ask about D2, D3 again" cannot both be true. The lead dimensions are the
     * interview; a first score on one means go further, not stop.
     */
    const s = buildInterviewerInstruction(midInterview());
    const covered = coveredSentence(s);
    expect(covered, "no covered-dimensions sentence found in the agenda").toBeTruthy();
    expect(covered).not.toMatch(/\bD2\b/);
    expect(covered).not.toMatch(/\bD3\b/);
  });

  it("still closes off a non-lead dimension that has been scored", () => {
    const covered = coveredSentence(buildInterviewerInstruction(midInterview()));
    expect(covered).toMatch(/\bD1\b/);
    expect(covered).toMatch(/\bD5\b/);
  });

  it("handles a lead dimension that is the ONLY evidenced one", () => {
    const s = buildInterviewerInstruction(
      midInterview({
        agenda: { lead: ["D2"], cover: ["D1"], light: ["D7"], evidenced: ["D2"] },
      }),
    );
    expect(typeof s).toBe("string");
    expect(s.length).toBeGreaterThan(100);
  });
});

describe("F5 — the clock is supplied, so the time rule is reachable", () => {
  it("states elapsed minutes when the caller supplies them", () => {
    const s = buildInterviewerInstruction(midInterview({ elapsedMin: 24 }));
    expect(s).toMatch(/\b24\b/);
  });

  it("omits the clock when the caller does not supply one", () => {
    const s = buildInterviewerInstruction(midInterview({ elapsedMin: undefined }));
    expect(s).not.toMatch(/minutes into/i);
  });

  it("ignores a nonsense clock rather than printing it", () => {
    for (const bad of [-1, NaN, Infinity, 100000]) {
      const s = buildInterviewerInstruction(midInterview({ elapsedMin: bad }));
      expect(s).not.toMatch(/NaN|Infinity|-1 minutes/);
    }
  });

  it("treats a clock of ZERO as a real value, because it is one", () => {
    /*
     * The bound this asserts disagreed with routes/voice.ts on the first cut
     * of v5.34.111: the schema validates elapsedMin as min(0), and
     * normalizeSize required >= 1, so every interview's FIRST mint had its
     * clock silently discarded. Found by the first live run reporting
     * "elapsed clock in the last instruction: NO" on a single-mint run.
     *
     * Zero is the honest answer at the open, so it must produce a sentence —
     * just not the sentence "about 0 minutes", which is not how anyone speaks.
     */
    const s = buildInterviewerInstruction(midInterview({ elapsedMin: 0 }));
    expect(s).toMatch(/start of this interview/i);
    expect(s).not.toMatch(/about 0 minutes/);
  });

  it("says minute, not minutes, at one", () => {
    const s = buildInterviewerInstruction(midInterview({ elapsedMin: 1 }));
    expect(s).toMatch(/about 1 minute into/);
  });

  it("agrees with the route schema about what a valid clock is", () => {
    /*
     * Read the bound out of voice.ts rather than restating it, so the two
     * cannot drift apart again. This is the whole finding, as a test.
     */
    const route = readFileSync(
      new URL("../src/routes/voice.ts", import.meta.url), "utf8");
    const m = /elapsedMin: z\.number\(\)\.int\(\)\.min\((\d+)\)\.max\((\d+)\)/.exec(route);
    expect(m, "the elapsedMin schema moved — update this test").toBeTruthy();
    const [, lo, hi] = m!;
    // Every value the route accepts must survive into the instruction.
    for (const v of [Number(lo), Number(lo) + 1, Number(hi)]) {
      const s = buildInterviewerInstruction(midInterview({ elapsedMin: v }));
      expect(s, `the route accepts elapsedMin=${v} and the persona drops it`)
        .toMatch(/this interview/i);
    }
  });
});

describe("the drift itself — measured, not argued", () => {
  /*
   * The probe that found F3, promoted to a test. The instruction at minute 4
   * must not be strictly more stop-biased than the instruction at open.
   *
   * "Stop-biased" is counted crudely and on purpose: the number of sentences
   * that assert completion or forbid a question. The exact number does not
   * matter and is not asserted — what matters is that the balance does not
   * collapse to "everything says stop, nothing says continue", which is what
   * produced the 4.4-minute close.
   */
  const atOpen = () =>
    buildInterviewerInstruction({
      ...midInterview({
        agenda: { lead: ["D2", "D3"], cover: ["D1", "D4"], light: ["D5", "D6", "D7"], evidenced: [] },
        mandatoryCount: 2,
        askedCount: 0,
      }),
    });

  const atMinute4 = () => buildInterviewerInstruction(midInterview());

  const countGo = (s: string) =>
    agendaBlock(s)
      .split(/(?<=\.)\s+/)
      .filter((x) => /still|remain|outstanding|left to|more to|go deeper|keep going/i.test(x)).length;

  it("does not lose every keep-going sentence between the open and minute 4", () => {
    expect(countGo(atOpen())).toBeGreaterThan(0);
    expect(countGo(atMinute4())).toBeGreaterThan(0);
  });

  it("the interviewer is never told both to go deep on a dimension and to drop it", () => {
    const s = atMinute4();
    const deep = s.match(/Go deep on: ([^.]+)\./);
    const covered = coveredSentence(s);
    expect(deep, "the go-deep sentence moved").toBeTruthy();
    expect(covered, "the covered-dimensions sentence moved").toBeTruthy();
    for (const code of ["D2", "D3"]) {
      if (deep![1].includes(code)) expect(covered).not.toContain(code);
    }
  });
});
