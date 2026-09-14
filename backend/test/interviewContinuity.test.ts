/**
 * The interviewer never loses the thread. (v5.34.87)
 *
 * ── Why a scenario matrix rather than more unit tests ───────────────────────
 *
 * An interview is not one conversation with one context. It is a sequence of
 * SESSIONS — a fresh start, a ~10-minute handover, a transport reconnect, a
 * pause and return the next day, a restart, a follow-up round months later —
 * and each one begins with a model that knows nothing except what the mint
 * sends it. Every defect in this area has been the same shape: one of those
 * scenarios silently carrying less than the others, and reading to the
 * interviewee as an interviewer who was not listening.
 *
 * Each of those was found separately, after the fact, from a recording or an
 * audit. This walks the scenarios instead, executing the page's own context
 * builder against a state shaped like each one and asserting what the model
 * would actually be told.
 *
 * ── The ones already paid for ───────────────────────────────────────────────
 *
 *   · v5.34.79: `context` was captured at create() and re-sent unchanged, so
 *     every handover described the interview as it stood at minute zero.
 *   · v5.34.84: agenda / mandatoryCount / askedCount were never forwarded by
 *     _sessionOpts at all, so the dimension agenda, the mandatory-question
 *     rules and the no-repeat rule reached no live interview for eleven
 *     versions.
 *   · v5.34.85: a resumed REFRESH interview did not know it was a refresh, and
 *     overwrote the round-1 record it existed to be compared against.
 *   · v5.34.87: the interviewer's own voice and name were not saved, so a
 *     resumed interview could come back as a different person.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const page = readFileSync(join(root, "frontend", "interview_agent.html"), "utf8");

function fnSrc(src: string, name: string): string {
  const i = src.indexOf(`function ${name}(`);
  expect(i, `function ${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(i);
  const next = rest.slice(1).search(/\n(?:async )?function [A-Za-z_]/);
  return next > 0 ? rest.slice(0, next + 1) : rest;
}
function varSrc(src: string, name: string): string {
  const m = new RegExp(`^var ${name} = .*?;$`, "m").exec(src);
  expect(m, `var ${name} not found`).toBeTruthy();
  return m![0];
}

const BUDGET = Number(/var LIVE_CONTEXT_BUDGET = (\d+)/.exec(page)?.[1]);

interface Scenario {
  S: Record<string, unknown>;
  briefing?: Record<string, unknown> | null;
  briefingSection?: string;
  rolePriority?: { lead?: string[]; cover?: string[]; light?: string[] };
}

/** buildLiveContext + the real collaborators it needs, against a stub state. */
function contextFor(sc: Scenario): string {
  const factory = new Function(
    "S", "loadBriefingContext", "buildBriefingPromptSection", "getRolePriorityData", "LIVE_CONTEXT_BUDGET",
    `${varSrc(page, "MQ_OVERLAP")}\n${varSrc(page, "MQ_STOP")}\n` +
      `${fnSrc(page, "mqStem")}\n${fnSrc(page, "mqTokens")}\n${fnSrc(page, "mqOverlap")}\n` +
      `${fnSrc(page, "allInterviewTurns")}\n${fnSrc(page, "askedQuestionsBlock")}\n` +
      `${fnSrc(page, "priorTranscriptBlock")}\n${fnSrc(page, "buildLiveContext")}\n` +
      "return buildLiveContext;"
  );
  return factory(
    sc.S,
    () => (sc.briefing === undefined ? {} : sc.briefing),
    () => sc.briefingSection ?? "",
    () => sc.rolePriority ?? {},
    BUDGET
  )() as string;
}

const exchange = (q: string, a: string) => [
  { role: "ai", text: q }, { role: "user", text: a },
];

/** A conversation that has been running a while — past any transcript tail. */
function longConversation(n: number) {
  const out: Array<{ role: string; text: string }> = [];
  for (let i = 1; i <= n; i++) {
    out.push(...exchange(
      `Question number ${i}: how does that work across the plants?`,
      `Answer number ${i}. ` + "It varies quite a lot by site and by system. ".repeat(8)
    ));
  }
  return out;
}

describe("v5.34.87 — scenario 1: a fresh interview", () => {
  it("carries the firm's briefing into the very first mint", () => {
    const ctx = contextFor({
      S: { client: "Acme", scores: {} },
      briefingSection: "PRE-ENGAGEMENT BRIEFING\nIndustry: Manufacturing\nHypothesis: data is siloed",
    });
    expect(ctx).toContain("PRE-ENGAGEMENT BRIEFING");
    expect(ctx).toContain("data is siloed");
  });

  it("says nothing about a conversation that has not happened", () => {
    // An empty "already asked" block would tell a fresh interviewer it has
    // history it does not have, which is its own kind of confusion.
    const ctx = contextFor({ S: { client: "Acme", scores: {}, displayMessages: [] } });
    expect(ctx).not.toContain("ALREADY asked");
    expect(ctx).not.toContain("being CONTINUED");
  });
});

describe("v5.34.87 — scenario 2: the ~10-minute handover", () => {
  /*
   * The session on the far side of a handover has NO memory of the
   * conversation. Everything it knows arrives in this string. This is where
   * the v5.34.79 and .84 defects lived, and it is the scenario most likely to
   * produce the "it asked me that already" complaint.
   */
  const midInterview = {
    client: "Acme",
    stakeholderName: "Dana",
    scores: { D1: 3, D6: 2 },
    displayMessages: longConversation(20),
  };

  it("tells the new session the interview is already under way", () => {
    const ctx = contextFor({ S: { ...midInterview } });
    expect(ctx).toContain("being CONTINUED");
    expect(ctx).toContain("Do not start over");
  });

  it("carries the whole question history, not just the recent tail", () => {
    /*
     * The transcript block is capped at 3,200 characters — roughly the last
     * eight exchanges. After twenty, the earliest questions have fallen out of
     * it entirely, and those are precisely the ones at risk of being asked
     * again. The bare-question list is what covers them.
     */
    const ctx = contextFor({ S: { ...midInterview } });
    expect(ctx, "the first question is no longer anywhere in the context")
      .toContain("Question number 1:");
    expect(ctx, "the most recent question must be there too")
      .toContain("Question number 20:");
  });

  it("names the dimensions that already have evidence", () => {
    const ctx = contextFor({ S: { ...midInterview } });
    expect(ctx).toMatch(/Dimensions with evidence already: .*D1.*D6/);
  });
});

describe("v5.34.87 — scenario 3: paused mid-question, resumed later", () => {
  /*
   * The single most common real interruption: a question is asked, the person
   * has to go, and they come back the next day. The question they never
   * answered is the one thing that SHOULD be repeated, and everything else
   * must not be.
   */
  const paused = {
    client: "Acme",
    stakeholderName: "Dana",
    scores: { D2: 3 },
    displayMessages: [
      ...exchange("How is your data organised across the plants?", "Centralised about two years ago."),
      ...exchange("Who signs off before a model reaches production?", "No formal body yet."),
      { role: "ai", text: "And how far along is the shop floor migration?" },
    ],
  };

  it("puts the unanswered question back, once", () => {
    const ctx = contextFor({ S: { ...paused } });
    expect(ctx).toContain("NOT answered");
    expect(ctx).toContain("And how far along is the shop floor migration?");
  });

  it("does not re-ask what was already answered", () => {
    const ctx = contextFor({ S: { ...paused } });
    const answered = ctx.slice(0, ctx.indexOf("NOT answered"));
    expect(answered).toContain("How is your data organised across the plants?");
    expect(answered).toContain("Who signs off before a model reaches production?");
  });

  it("keeps the interviewer's own identity across the break", () => {
    /*
     * Not part of the context string — part of the saved session. Losing it
     * means the interviewer returns in a different VOICE with a different NAME
     * and reads the interviewee's role as a raw slug. The conversation
     * continues; the person conducting it has been swapped.
     */
    const blob = page.slice(page.indexOf("function saveSession()"), page.indexOf("function saveSession()") + 3000);
    for (const f of ["interviewerName", "interviewerVoice", "stakeholderDisplayLabel"]) {
      expect(blob, `${f} is not saved, so a resumed interview loses it`).toContain(`${f}:S.${f}`);
    }
  });
});

describe("v5.34.87 — scenario 4: a follow-up round", () => {
  it("tells the interviewer it is a follow-up and what to focus on", () => {
    const ctx = contextFor({
      S: {
        client: "Acme", scores: {},
        isRefreshMode: true, refreshScope: ["D1", "D6"],
        displayMessages: [],
      },
      briefingSection: "PRIOR ROUND: D1 scored 2.4, D6 scored 1.8",
    });
    expect(ctx).toContain("follow-up round");
    expect(ctx).toMatch(/Focus on: D1, D6/);
    expect(ctx, "the prior round's scores are the whole point of a follow-up")
      .toContain("PRIOR ROUND");
  });

  it("survives a resume still knowing it is a follow-up", () => {
    /*
     * saveSession wrote `isRefresh` and the app reads `isRefreshMode`, so a
     * resumed follow-up believed it was an initial interview and overwrote the
     * round-1 record for that role — the baseline it existed to be compared
     * against. Both spellings are written now.
     */
    /*
     * v5.34.91: this read a fixed 4000-character window from the top of
     * saveSession(), so adding three lines anywhere above the refresh block
     * pushed `data.isRefreshMode=true` outside it and failed this test for a
     * reason with nothing to do with follow-up rounds. Bounded by the next
     * top-level function instead — the window is now the function.
     */
    const from = page.indexOf("function saveSession()");
    expect(from, "saveSession() moved — update this test").toBeGreaterThan(-1);
    const to = page.indexOf("\nfunction ", from + 1);
    const blob = page.slice(from, to === -1 ? page.length : to);
    expect(blob).toContain("data.isRefreshMode=true");
    expect(blob).toContain("data.refreshRoundLabel=");
    expect(blob).toContain("data.coverage=");
  });
});

describe("v5.34.87 — scenario 5: required questions, across every session", () => {
  it("stops listing a required question once it has been answered", () => {
    const asked = {
      client: "Acme", scores: {},
      mandatoryQuestions: [
        { id: "mq-1", text: "Who signs off before a model affects a production line?", asked: true },
        { id: "mq-2", text: "If the data team disappeared tomorrow, which reports stop first?", asked: false },
      ],
      displayMessages: exchange("Who signs off before a model affects a production line?", "Nobody formally."),
    };
    const ctx = contextFor({ S: asked });
    const outstanding = ctx.slice(ctx.indexOf("must be asked before the interview ends"));
    expect(outstanding).toContain("If the data team disappeared tomorrow");
    expect(outstanding, "an answered required question is still being demanded")
      .not.toContain("Who signs off before a model affects a production line?");
  });

  it("drops the section entirely when they are all done", () => {
    // An empty "must be asked" heading reads as an instruction with no content
    // and invites the model to invent something to satisfy it.
    const ctx = contextFor({
      S: {
        client: "Acme", scores: {},
        mandatoryQuestions: [{ id: "mq-1", text: "Who signs off?", asked: true }],
        displayMessages: exchange("Who signs off?", "Nobody."),
      },
    });
    expect(ctx).not.toContain("must be asked before the interview ends");
  });
});

describe("v5.34.87 — scenario 6: a very long interview", () => {
  it("shortens the briefing before it shortens the conversation", () => {
    /*
     * Priority order under pressure. A truncated briefing costs depth on one
     * answer; a truncated history costs the interviewer its memory and it
     * starts repeating — which is the failure the interviewee actually
     * notices and the one that makes the product look stupid.
     */
    const ctx = contextFor({
      S: { client: "Acme", scores: {}, displayMessages: longConversation(40) },
      briefingSection: "BRIEFING LINE. ".repeat(2000),
    });
    expect(ctx).toContain("being CONTINUED");
    expect(ctx).toContain("ALREADY asked");
    expect(ctx.length).toBeLessThanOrEqual(BUDGET + 400);
  });

  it("says what it had to leave out rather than trimming in silence", () => {
    const ctx = contextFor({
      S: { client: "Acme", scores: {}, displayMessages: longConversation(40) },
      briefingSection: "BRIEFING LINE. ".repeat(2000),
    });
    expect(ctx).toMatch(/shortened to fit|Not included, for length/);
  });
});

describe("v5.34.87 — no scenario silently carries nothing", () => {
  /*
   * The backstop. Every defect in this area was one scenario quietly carrying
   * less than the others, so the matrix is worth asserting as a whole: a
   * continuing interview must always tell the model that it is continuing.
   */
  const continuing = [
    { name: "handover", S: { client: "A", scores: {}, displayMessages: longConversation(12) } },
    { name: "resume after pause", S: { client: "A", scores: { D1: 3 }, displayMessages: longConversation(3) } },
    {
      name: "follow-up round", S: {
        client: "A", scores: {}, isRefreshMode: true, refreshScope: ["D1"],
        displayMessages: longConversation(2),
      },
    },
  ];
  for (const c of continuing) {
    it(`${c.name}: the model is told the conversation is already running`, () => {
      const ctx = contextFor({ S: c.S });
      expect(ctx, "this session would open as though nothing had been said")
        .toContain("being CONTINUED");
      expect(ctx).toContain("ALREADY asked");
    });
  }

  it("a genuine restart carries none of it", () => {
    // The other direction: "Start over from the beginning" must not inherit
    // the previous sitting's history, or it is not a restart.
    const ctx = contextFor({ S: { client: "A", scores: {}, displayMessages: [] } });
    expect(ctx).not.toContain("being CONTINUED");
    expect(ctx).not.toContain("ALREADY asked");
  });
});
