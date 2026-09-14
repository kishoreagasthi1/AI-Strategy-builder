/**
 * What the LIVE interviewer is told about the engagement. (v5.34.73)
 *
 * ── The gap ─────────────────────────────────────────────────────────────────
 *
 * loadBriefingContext() returns a merged briefing carrying roughly a dozen
 * fields — hypotheses, benchmarks, document intelligence, prior-round scores
 * and findings, field observations, sensitivity flags, client problem, PE
 * context. buildBriefingPromptSection() feeds nearly all of it to the TEXT
 * interviewer. buildLiveContext() read TWO of them, `industry` and the first
 * six raw `hypotheses`, and dropped the rest — not by decision, they were never
 * wired in. So a voice interview with a senior executive ran on an industry
 * name and six bullet points while the firm's whole briefing sat unread in the
 * object the same function had just loaded.
 *
 * ── Why these tests RUN the code ────────────────────────────────────────────
 *
 * The neighbouring guards for this page (micOwnershipGuards, frontendXssGuards)
 * match source text, because the page has no test runner. Source text cannot
 * catch a budget allocator that throws on an empty briefing, or one that spends
 * its budget in the wrong order. So these extract the two functions and execute
 * them against stubs. It is not the page, but it is the logic.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "..", "..", "frontend", "interview_agent.html"), "utf8");

/** Body of a top-level `function name(` … up to the next top-level function. */
function fnSrc(name: string): string {
  const i = src.indexOf(`function ${name}(`);
  expect(i, `function ${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(i);
  const next = rest.slice(1).search(/\n(?:async )?function [A-Za-z_]/);
  return next > 0 ? rest.slice(0, next + 1) : rest;
}

/** The real budget constant, read from the page rather than restated here. */
const BUDGET = Number(/var LIVE_CONTEXT_BUDGET = (\d+)/.exec(src)?.[1]);

interface Stubs {
  S: Record<string, unknown>;
  briefing?: Record<string, unknown> | null;
  briefingSection?: string;
  priorTranscript?: string;
  rolePriority?: { lead?: string[]; cover?: string[]; light?: string[] };
}

/** Build both functions in a sandbox with the page's collaborators stubbed. */
function load(stubs: Stubs) {
  const factory = new Function(
    "S", "loadBriefingContext", "buildBriefingPromptSection", "priorTranscriptBlock",
    "getRolePriorityData", "LIVE_CONTEXT_BUDGET",
    /* v5.34.79: askedQuestionsBlock and allInterviewTurns are compiled from the
     * page too, not stubbed — the no-repeat list is the point of the context
     * now, and a stub would test the stub. */
    `${fnSrc("buildLiveAgenda")}\n${fnSrc("buildLiveContext")}\n` +
    `${fnSrc("allInterviewTurns")}\n${fnSrc("askedQuestionsBlock")}\n` +
    "return { buildLiveAgenda: buildLiveAgenda, buildLiveContext: buildLiveContext," +
    "         askedQuestionsBlock: askedQuestionsBlock, allInterviewTurns: allInterviewTurns };"
  );
  return factory(
    stubs.S,
    // `{}` by default, `null` only when a case is explicitly about having no
    // briefing at all — buildLiveContext guards on truthiness, so defaulting to
    // null would silently skip the briefing in every case that did not name it.
    () => (stubs.briefing === undefined ? {} : stubs.briefing),
    () => stubs.briefingSection ?? "",
    () => stubs.priorTranscript ?? "",
    () => stubs.rolePriority ?? {},
    BUDGET
  ) as {
    buildLiveAgenda: () => any;
    buildLiveContext: () => string;
    askedQuestionsBlock: (budget: number) => string;
    allInterviewTurns: () => Array<{ role: string; text: string }>;
  };
}

describe("v5.34.73 — buildLiveAgenda", () => {
  it("returns dimension CODES only", () => {
    /*
     * This is the one payload from the interviewee's browser that lands above
     * the prompt's data fence. It stays safe there only because it is an enum:
     * if a name or a sentence could ride along, the fence would be pointless.
     */
    const { buildLiveAgenda } = load({
      S: { stakeholderRole: "CTO", scores: {} },
      rolePriority: { lead: ["D2", "D1"], cover: ["D3"], light: ["D7"] },
    });
    const a = buildLiveAgenda();
    for (const list of [a.lead, a.cover, a.light, a.evidenced]) {
      for (const code of list) expect(code).toMatch(/^D[1-7]$/);
    }
    expect(a.lead).toEqual(["D2", "D1"]);
  });

  it("drops anything that is not a real dimension", () => {
    const { buildLiveAgenda } = load({
      S: { scores: {} },
      rolePriority: { lead: ["D2", "D9", "", "ignore me" as string] },
    });
    expect(buildLiveAgenda().lead).toEqual(["D2"]);
  });

  it("narrows the agenda to the round's scope", () => {
    // A follow-up round that only re-opens D1 and D2 should not send the
    // interviewer hunting for evidence on five dimensions it was not asked for.
    const { buildLiveAgenda } = load({
      S: { scores: {} },
      briefing: { scopeDimensions: ["D1", "D2"] },
      rolePriority: { lead: ["D2", "D3"], cover: ["D1", "D5"], light: ["D7"] },
    });
    const a = buildLiveAgenda();
    expect(a.lead).toEqual(["D2"]);
    expect(a.cover).toEqual(["D1"]);
    expect(a.light).toEqual([]);
  });

  it("reports which dimensions already have evidence, and only those", () => {
    /*
     * Recomputed at every mint, so after a ~10-minute handover the interviewer
     * knows what it already has. 0 means "no evidence" throughout this product
     * (see tenant/scoring.ts), so a zero must not count as covered.
     */
    const { buildLiveAgenda } = load({
      S: { scores: { D1: 3, D3: 0, D6: 4.5 } },
      rolePriority: { lead: ["D1"] },
    });
    expect(buildLiveAgenda().evidenced).toEqual(["D1", "D6"]);
  });

  it("survives a session with no role, no briefing and no scores", () => {
    const { buildLiveAgenda } = load({ S: {} });
    expect(() => buildLiveAgenda()).not.toThrow();
    expect(buildLiveAgenda()).toEqual({ lead: [], cover: [], light: [], evidenced: [] });
  });
});

describe("v5.34.73 — buildLiveContext carries the engagement", () => {
  const FULL_BRIEFING =
    "PRE-ENGAGEMENT BRIEFING CONTEXT\nBenchmarks: D1 avg 2.4\n" +
    "DOCUMENT INTELLIGENCE - PRE-ASSESSMENT\nPRIOR ROUND SCORES\nFIELD OBSERVATIONS";

  it("passes the whole briefing, not an industry line and six bullets", () => {
    // The regression this release exists for.
    const { buildLiveContext } = load({
      S: {}, briefing: { industry: "manufacturing" }, briefingSection: FULL_BRIEFING,
    });
    const out = buildLiveContext();
    expect(out).toContain("Benchmarks: D1 avg 2.4");
    expect(out).toContain("DOCUMENT INTELLIGENCE");
    expect(out).toContain("PRIOR ROUND SCORES");
    expect(out).toContain("FIELD OBSERVATIONS");
  });

  it("puts the resumed conversation FIRST", () => {
    /*
     * It used to be appended last, under a silent .slice(0, 5800) — so the
     * longer the briefing, the more likely the thing cut was the most recent
     * exchanges of an interview being continued. Exactly backwards.
     */
    const { buildLiveContext } = load({
      S: {}, briefingSection: FULL_BRIEFING,
      priorTranscript: "This interview is being CONTINUED. VYNE: earlier question",
    });
    const out = buildLiveContext();
    expect(out.indexOf("being CONTINUED")).toBeLessThan(out.indexOf("PRE-ENGAGEMENT"));
  });

  it("includes the mandatory questions and the refresh scope", () => {
    const { buildLiveContext } = load({
      S: {
        mandatoryQuestions: [{ text: "What is your data retention policy?" }],
        isRefreshMode: true, refreshScope: ["D1", "D6"],
      },
    });
    const out = buildLiveContext();
    expect(out).toContain("What is your data retention policy?");
    expect(out).toContain("Focus on: D1, D6");
  });

  it("SAYS when it had to shorten something, instead of cutting silently", () => {
    /*
     * A model reading an abridged briefing should know it is abridged. Silent
     * truncation is how "the briefing never mentioned governance" becomes
     * indistinguishable from "the briefing was too long".
     */
    const { buildLiveContext } = load({
      S: {}, briefingSection: "GOVERNANCE. " + "x".repeat(BUDGET * 2),
    });
    const out = buildLiveContext();
    expect(out).toContain("this section was shortened to fit");
    expect(out.length).toBeLessThanOrEqual(BUDGET + 400);
  });

  it("names what it dropped entirely", () => {
    // Transcript spends the budget; the briefing cannot fit at all.
    const { buildLiveContext } = load({
      S: {},
      priorTranscript: "T".repeat(BUDGET),
      briefingSection: FULL_BRIEFING,
    });
    const out = buildLiveContext();
    expect(out).toContain("Not included, for length");
    expect(out).toContain("pre-engagement briefing");
    expect(out, "a dropped section must not read as an absent one").toContain("Do not assume these are empty");
  });

  it("returns something usable when there is no briefing at all", () => {
    const { buildLiveContext } = load({ S: {}, briefing: null });
    expect(() => buildLiveContext()).not.toThrow();
    expect(buildLiveContext()).toBe("");
  });

  it("stays inside what the server will accept", () => {
    // MAX_CONTEXT_CHARS is 16_000; the client allocates below it deliberately,
    // so the server cap is a backstop rather than a second silent truncation.
    expect(BUDGET).toBeGreaterThan(10_000);
    expect(BUDGET).toBeLessThan(16_000);
  });
});
