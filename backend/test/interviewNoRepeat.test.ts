/**
 * A question asked and answered is never asked again. (v5.34.79)
 *
 * ── What happened ───────────────────────────────────────────────────────────
 *
 * On the 2026-09-14 live recording the interviewer asked the same required
 * question three times in 43 seconds — turns 5, 7 and 8, near-verbatim — and
 * re-asked a second required question two turns later. The persona has carried
 * "Never ask the same question twice" since v5.34.73. It was not enough, and
 * four separate things were wrong underneath it:
 *
 *   1. markAskedMandatoryQuestions() read S.messages, which only the TEXT path
 *      writes. On a VOICE interview it saw an empty conversation and marked
 *      nothing, ever. (S.displayMessages is written by both — renderWelcome()
 *      already relies on exactly that fact a few hundred lines away.)
 *   2. It ran only on Finish, so nothing was marked DURING the interview.
 *   3. buildLiveContext() listed every required question every time, answered
 *      or not — which is an instruction to ask it again — and mandatoryCount
 *      sent the total rather than what was left.
 *   4. `context` was captured once at create() and re-sent unchanged at every
 *      renewal. The ~10-minute handover starts a session with no memory of the
 *      conversation, so it was told the interview as it stood at minute zero:
 *      nothing asked yet. The one moment the history matters most was the one
 *      moment it was guaranteed stale.
 *
 * Any one of those alone produces the repetition. These tests pin all four,
 * plus the restart semantics: "Start over from the beginning" must ask
 * everything again, while "Continue where you left off" must not.
 *
 * ── Why these execute the page's own functions ──────────────────────────────
 *
 * Same reason as liveInterviewContext.test.ts: a source-text match cannot tell
 * you that a detector reads the wrong array. Bug 1 would have passed every
 * grep-shaped assertion ever written about it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildInterviewerInstruction } from "../src/llm/interviewerPersona.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const page = readFileSync(join(root, "frontend", "interview_agent.html"), "utf8");
const live = readFileSync(join(root, "frontend", "vyne-live.js"), "utf8");

function fnSrc(src: string, name: string): string {
  const i = src.indexOf(`function ${name}(`);
  expect(i, `function ${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(i);
  const next = rest.slice(1).search(/\n(?:async )?function [A-Za-z_]/);
  return next > 0 ? rest.slice(0, next + 1) : rest;
}

/**
 * A top-level `var NAME = ...;` from the page, matched to its closing newline.
 *
 * fnSrc only finds functions, and the matcher's threshold and stopword list are
 * vars — compiling the functions without them throws ReferenceError at call
 * time, not at compile time, so the failure surfaces inside whichever test runs
 * first and reads like a bug in that test.
 */
function varSrc(src: string, name: string): string {
  const m = new RegExp(`^var ${name} = .*?;$`, "m").exec(src);
  expect(m, `var ${name} not found`).toBeTruthy();
  return m![0];
}
/** The matcher's shared preamble — used wherever its functions are compiled. */
const MQ_PREAMBLE = (src: string) =>
  `${varSrc(src, "MQ_OVERLAP")}\n${varSrc(src, "MQ_STOP")}\n` +
  `${fnSrc(src, "mqStem")}\n${fnSrc(src, "mqTokens")}\n${fnSrc(src, "mqOverlap")}\n`;

type Msg = { role: string; text?: string; content?: string };

/** Compile the page's question-tracking functions against a stub `S`. */
function load(S: Record<string, unknown>) {
  const factory = new Function(
    "S",
    MQ_PREAMBLE(page) +
      `${fnSrc(page, "allInterviewTurns")}\n${fnSrc(page, "askedQuestionsBlock")}\n` +
      `${fnSrc(page, "markAskedMandatoryQuestions")}\n` +
      "return { allInterviewTurns, askedQuestionsBlock, markAskedMandatoryQuestions };"
  );
  return factory(S) as {
    allInterviewTurns: () => Array<{ role: string; text: string }>;
    askedQuestionsBlock: (budget: number) => string;
    markAskedMandatoryQuestions: () => void;
  };
}

const voice = (pairs: Array<[string, string]>): Msg[] =>
  pairs.flatMap(([q, a]) => (a ? [{ role: "ai", text: q }, { role: "user", text: a }] : [{ role: "ai", text: q }]));

describe("v5.34.79 — the interviewer can see what it already asked", () => {
  it("reads a VOICE interview, which it could not before", () => {
    /*
     * The whole bug in one assertion. displayMessages is the only array a voice
     * interview writes; the old code read S.messages and therefore saw nothing.
     */
    const { allInterviewTurns } = load({
      messages: [],
      displayMessages: voice([["How is your data organised?", "Centralised two years ago."]]),
    });
    expect(allInterviewTurns()).toEqual([
      { role: "ai", text: "How is your data organised?" },
      { role: "user", text: "Centralised two years ago." },
    ]);
  });

  it("still reads a TEXT interview", () => {
    const { allInterviewTurns } = load({
      displayMessages: [],
      messages: [{ role: "assistant", content: "Who signs off?" }, { role: "user", content: "Nobody, formally." }],
    });
    expect(allInterviewTurns().map((t) => t.role)).toEqual(["ai", "user"]);
    expect(allInterviewTurns()[0].text).toBe("Who signs off?");
  });

  it("lists questions that were answered, and not the one that was not", () => {
    /*
     * A pause leaves the last question hanging. Suppressing it would lose it
     * silently — and it is the single question that SHOULD come again on
     * resume, which is why it is named separately rather than just omitted.
     */
    const { askedQuestionsBlock } = load({
      displayMessages: [
        ...voice([
          ["How is your data organised?", "Centralised two years ago."],
          ["Who signs off before a model reaches a production line?", "No formal body."],
        ]),
        { role: "ai", text: "And how far along is the shop floor migration?" },
      ],
    });
    const b = askedQuestionsBlock(3000);
    expect(b).toContain("How is your data organised?");
    expect(b).toContain("Who signs off before a model reaches a production line?");
    expect(b).toContain("NOT answered");
    expect(b).toContain("And how far along is the shop floor migration?");
    // The unanswered one must not also appear in the answered list.
    const answeredHalf = b.slice(0, b.indexOf("NOT answered"));
    expect(answeredHalf).not.toContain("shop floor migration");
  });

  it("says nothing at all before the first answer", () => {
    const { askedQuestionsBlock } = load({ displayMessages: [] });
    expect(askedQuestionsBlock(3000)).toBe("");
  });

  it("does not list the same question twice when it was asked twice", () => {
    // Defence in depth: the repetition this whole change exists to stop must
    // not also corrupt the record of it.
    const { askedQuestionsBlock } = load({
      displayMessages: voice([
        ["Who signs off before a model affects a production line?", "No formal body."],
        ["Who signs off before a model affects a production line?", "As I said, no formal body."],
      ]),
    });
    const b = askedQuestionsBlock(3000);
    expect(b.split("Who signs off").length - 1).toBe(1);
  });

  it("keeps the OLDEST-risk questions when it has to trim", () => {
    /*
     * A tight budget must drop the most recent questions, not the earliest:
     * what the model just asked is still in its context window, and what it
     * asked twenty minutes ago is what it is about to ask again.
     */
    const pairs: Array<[string, string]> = [];
    for (let i = 1; i <= 20; i++) pairs.push([`Question number ${i} about the operation?`, `Answer ${i}.`]);
    const { askedQuestionsBlock } = load({ displayMessages: voice(pairs) });
    const trimmed = askedQuestionsBlock(200);
    expect(trimmed).toContain("omitted for length");
    expect(trimmed, "the newest questions are the ones that must survive").toContain("number 20");
    expect(trimmed).not.toContain("number 1 about");
  });

  it("carries the WHOLE interview where a transcript tail could not", () => {
    // The reason this is a separate block rather than more transcript: bare
    // questions are small enough that thirty minutes fits in a few thousand
    // characters, which is exactly what priorTranscriptBlock(3200) cannot do.
    const pairs: Array<[string, string]> = [];
    for (let i = 1; i <= 60; i++) {
      pairs.push([`Question number ${i} about the operation?`, `A fairly long answer number ${i}. `.repeat(12)]);
    }
    const { askedQuestionsBlock } = load({ displayMessages: voice(pairs) });
    const b = askedQuestionsBlock(3000);
    expect(b).toContain("number 1 about");
    expect(b).toContain("number 60 about");
    expect(b).not.toContain("omitted for length");
  });
});

describe("v5.34.79 — required questions are marked off during the interview", () => {
  it("marks a required question answered on a VOICE interview", () => {
    /*
     * Before this, q.asked stayed false through an entire voice interview, so
     * the Finish backstop force-asked every required question again at the end
     * of a sitting in which they had all been answered.
     */
    const S: Record<string, unknown> = {
      client: "", stakeholderRole: "CTO", stakeholderName: "Alex",
      displayMessages: voice([["Who signs off before a model affects a production line?", "No formal body yet."]]),
      mandatoryQuestions: [
        { id: "mq-1", text: "Who signs off before a model affects a production line?", asked: false },
        { id: "mq-2", text: "If the data team disappeared tomorrow, which reports would stop first?", asked: false },
      ],
    };
    load(S).markAskedMandatoryQuestions();
    const mq = S.mandatoryQuestions as Array<{ asked: boolean }>;
    expect(mq[0].asked, "the answered one must be marked").toBe(true);
    expect(mq[1].asked, "an unasked one must NOT be marked").toBe(false);
  });

  it("does not mark a question that was asked but never answered", () => {
    const S: Record<string, unknown> = {
      client: "", stakeholderRole: "CTO", stakeholderName: "Alex",
      displayMessages: [{ role: "ai", text: "Who signs off before a model affects a production line?" }],
      mandatoryQuestions: [
        { id: "mq-1", text: "Who signs off before a model affects a production line?", asked: false },
      ],
    };
    load(S).markAskedMandatoryQuestions();
    expect((S.mandatoryQuestions as Array<{ asked: boolean }>)[0].asked).toBe(false);
  });

  it("runs on every turn, not only at Finish", () => {
    // Marking at Finish is too late for both things that matter: the next
    // handover, and a pause-and-return.
    const onTurns = page.slice(page.indexOf("onTurns: function(){"), page.indexOf("onTurns: function(){") + 900);
    expect(onTurns).toContain("markAskedMandatoryQuestions()");
  });

  it("sends the OUTSTANDING count, not the total", () => {
    const at = page.indexOf("mandatoryCount: function()");
    expect(at).toBeGreaterThan(-1);
    const block = page.slice(at, at + 400);
    expect(block).toContain("markAskedMandatoryQuestions()");
    expect(block).toMatch(/filter\(function\(q\)\{ return !q\.asked; \}\)\.length/);
  });

  it("lists only the outstanding required questions in the context", () => {
    expect(page).toMatch(/var dueMandatory = \(S\.mandatoryQuestions \|\| \[\]\)\.filter\(function\(q\)\{ return !q\.asked; \}\)/);
    expect(page).toContain("dueMandatory.forEach");
  });
});

describe("v5.34.79 — the history reaches the session that needs it", () => {
  it("resolves context at MINT time, like the agenda", () => {
    /*
     * The handover is the whole point. A fresh live session has no memory of
     * the conversation, so it learns what has been asked only from the context
     * sent with its grant — and that context was frozen at create().
     */
    const at = live.indexOf("context: (function(c){");
    expect(at, "context is not resolved at mint — a handover will re-send minute zero").toBeGreaterThan(-1);
    expect(live.slice(at, at + 200)).toContain("typeof c === 'function' ? c() : c");
  });

  it("the page passes a function, so there is something to resolve", () => {
    expect(page).toMatch(/context: function\(\)\{ try\{ return buildLiveContext\(\); \}/);
  });

  it("puts the asked list above the briefing in the budget order", () => {
    // If anything must be shortened it must not be this: a truncated briefing
    // costs depth, a truncated question list costs repetition.
    const body = page.slice(page.indexOf("function buildLiveContext()"));
    const asked = body.indexOf("askedQuestionsBlock");
    const briefing = body.indexOf("buildBriefingPromptSection");
    expect(asked).toBeGreaterThan(-1);
    expect(briefing).toBeGreaterThan(-1);
    expect(asked, "the briefing is claiming budget ahead of the asked list").toBeLessThan(briefing);
  });
});

describe("v5.34.79 — restart releases the holds, resume does not", () => {
  it("getDueMandatoryQuestions ignores the completed store when told to", () => {
    const factory = new Function(
      "loadMandatoryStore", "mqPersonKey", "mqAnswerers",
      `${fnSrc(page, "getDueMandatoryQuestions")}\nreturn getDueMandatoryQuestions;`
    );
    const store = {
      questions: [
        { id: "mq-1", text: "Who signs off?", roles: ["CTO"], dimensions: ["D6"] },
        { id: "mq-2", text: "Which reports stop first?", roles: ["CTO"], dimensions: ["D1"] },
      ],
      completed: { "mq-1": { "CTO||Alex": { role: "CTO", person: "Alex", at: "2026-09-13T00:00:00Z" } } },
    };
    const fn = factory(
      () => store,
      (role: string, person: string) => `${role}||${String(person || "").trim()}`,
      (st: typeof store, qid: string) =>
        Object.keys(st.completed[qid as keyof typeof st.completed] || {}).map((k) => ({
          key: k, role: "CTO", person: "Alex", at: null, legacy: false,
        }))
    ) as (c: string, r: string, p: string, release?: boolean) => Array<{ id: string }>;

    // Resume / normal: mq-1 is answered by this person, so it is not due.
    expect(fn("Acme", "CTO", "Alex").map((q) => q.id)).toEqual(["mq-2"]);
    // Restart: "from the beginning" means from the beginning.
    expect(fn("Acme", "CTO", "Alex", true).map((q) => q.id)).toEqual(["mq-1", "mq-2"]);
  });

  it("only startNewInterview releases the holds", () => {
    /*
     * The release is a read-time argument rather than a wipe of the store,
     * because the store is the record of who answered what and when. A restart
     * is a reason to stop it suppressing, never a reason to lose it.
     */
    const calls = [...page.matchAll(/getDueMandatoryQuestions\(([^)]*)\)/g)].map((m) => m[1]);
    const releasing = calls.filter((c) => /,\s*true\s*$/.test(c));
    expect(releasing.length, `exactly one caller may release holds; found ${releasing.length}`).toBe(1);
    const fresh = page.slice(page.indexOf("async function startNewInterview()"));
    expect(fresh.slice(0, 2500)).toMatch(/getDueMandatoryQuestions\([^)]*,\s*true\)/);
  });
});

describe("v5.34.79 — the rules above the fence say not to repeat", () => {
  it("tells it to read the asked list and never re-ask from it", () => {
    const out = buildInterviewerInstruction({ askedCount: 7, context: "background" });
    expect(out).toContain("7 questions");
    expect(out).toContain("never ask any of them again");
    expect(out).toContain("not in different words");
  });

  it("handles the singular", () => {
    expect(buildInterviewerInstruction({ askedCount: 1 })).toMatch(/the question you have already asked/);
  });

  it("says nothing when nothing has been asked yet", () => {
    const out = buildInterviewerInstruction({ askedCount: 0 });
    expect(out).not.toContain("never ask any of them again");
  });

  it("tells it to put back the one question that was interrupted", () => {
    // Pause semantics: resume repeats the question you were on, and only that.
    expect(buildInterviewerInstruction({ askedCount: 3 })).toContain("asked but never answered");
  });

  it("says the required list is maintained, so every entry still needs asking", () => {
    /*
     * Without this, a model that remembers asking one still sees it listed as
     * required and asks again — which is precisely what the recording showed.
     */
    const out = buildInterviewerInstruction({ mandatoryCount: 2 });
    expect(out).toContain("only what is still outstanding");
    expect(out).toContain("exactly once");
  });

  it("keeps all of it ABOVE the data fence", () => {
    /*
     * Position, as everywhere else in this prompt. The questions themselves are
     * the interviewer's own words and an interviewee can steer those, so the
     * TEXT stays fenced and only the COUNT comes up here to give the rule
     * something to point at.
     */
    const out = buildInterviewerInstruction({ askedCount: 4, mandatoryCount: 1, context: "briefing" });
    const fence = out.indexOf("--- BEGIN BACKGROUND ---");
    expect(fence).toBeGreaterThan(-1);
    expect(out.indexOf("never ask any of them again")).toBeLessThan(fence);
    expect(out.indexOf("only what is still outstanding")).toBeLessThan(fence);
  });

  it("never puts a question's text above the fence", () => {
    // The count is the entire payload. If a question could ride up here, the
    // fence would be decorative.
    const out = buildInterviewerInstruction({ askedCount: 3, mandatoryCount: 2, context: "x" });
    const above = out.slice(0, out.indexOf("--- BEGIN BACKGROUND ---"));
    expect(above).not.toContain("?");
  });
});

describe("v5.34.83 — matching a required question to the turn that asked it", () => {
  /** The page's matcher, compiled from source. */
  function pageMatcher() {
    const f = new Function(MQ_PREAMBLE(page) + "return { mqOverlap, mqTokens };");
    return f() as { mqOverlap: (t: string, q: string) => number; mqTokens: (t: string) => string[] };
  }
  /** The harness's copy, compiled from ITS source. */
  function harnessMatcher() {
    const h = readFileSync(join(root, "deploy", "voice-record.mjs"), "utf8");
    const grab = (name: string) => {
      const m = new RegExp(`const ${name} = [\\s\\S]*?;\\n`).exec(h);
      expect(m, `${name} not found in the harness`).toBeTruthy();
      return m![0];
    };
    const fn = /function mqOverlap\(turnText, questionText\) \{[\s\S]*?\n\}/.exec(h);
    expect(fn, "harness mqOverlap not found").toBeTruthy();
    const f = new Function(
      `const MQ_STOP = new Set(${/const MQ_STOP = new Set\((.*)\);/.exec(h)![1]});\n` +
      grab("mqStem") + grab("mqTokens") + fn![0] + "\nreturn { mqOverlap };"
    );
    return f() as { mqOverlap: (t: string, q: string) => number };
  }

  const MQ = "Who signs off before a model is allowed to affect a customer or a production line?";
  const MQ2 = "If the data team disappeared tomorrow, which reports would stop working first?";

  it("matches the question asked almost verbatim", () => {
    const { mqOverlap } = pageMatcher();
    expect(mqOverlap("So who actually signs off before a model is allowed to affect a customer or a production line?", MQ))
      .toBeGreaterThanOrEqual(0.7);
  });

  it("survives ordinary inflection, which it did not before", () => {
    /*
     * The old matcher compared raw tokens, so "models" did not satisfy "model"
     * and "affecting" did not satisfy "affect". Light stemming is what turns a
     * near-miss into a match without lowering the threshold.
     */
    const { mqOverlap } = pageMatcher();
    expect(mqOverlap(
      "Who signed off before those models were allowed to affect customers or the production lines?", MQ))
      .toBeGreaterThanOrEqual(0.7);
    expect(mqOverlap("If the data teams disappeared tomorrow, which report would stop working first?", MQ2))
      .toBeGreaterThanOrEqual(0.7);
  });

  it("no longer counts a word that merely CONTAINS a question word", () => {
    /*
     * indexOf matching let "line" be satisfied by "airline" and "sign" by
     * "design". Those false hits pushed unrelated turns toward the threshold,
     * which is the more dangerous direction: marking a required question done
     * when it was never asked loses it entirely.
     */
    const { mqOverlap } = pageMatcher();
    const bogus = "Our airline designs streamline customer models allowed production lineage affects";
    expect(mqOverlap(bogus, MQ)).toBeLessThan(0.7);
  });

  it("does NOT mark an unrelated question as the required one", () => {
    const { mqOverlap } = pageMatcher();
    for (const t of [
      "How is your data organised across the plants?",
      "What does your cloud migration look like on the shop floor?",
      "Which analytics projects have failed and why?",
    ]) expect(mqOverlap(t, MQ), `false positive on: ${t}`).toBeLessThan(0.7);
  });

  it("admits what it still cannot see: a true paraphrase", () => {
    /*
     * The 2026-09-14 miss, kept as a test rather than papered over. "signs off"
     * and "makes the final decision" share no words, so no token method scores
     * this above the threshold, and lowering the threshold until it did would
     * start marking unasked questions as done — the error that loses a required
     * question rather than merely repeating one.
     *
     * This is why interviewerPersona.ts carries the reconciliation rule below.
     * When that rule is what closes the gap, this test is the record of WHY it
     * exists — delete the rule and nothing else in the suite explains the hole.
     */
    const { mqOverlap } = pageMatcher();
    const paraphrase = "When it comes to models, who actually makes the final decision to let it start affecting production or customers?";
    expect(mqOverlap(paraphrase, MQ)).toBeLessThan(0.7);
    expect(buildInterviewerInstruction({ mandatoryCount: 1 }))
      .toContain("already put the same question to them in your own words");
  });

  it("the harness and the page score identically", () => {
    /*
     * Two copies, one browser and one Node, with no module boundary between
     * them. If they drift, the harness reports coverage the product does not
     * see — a rig that agrees with itself and not with what ships.
     */
    const p = pageMatcher(), h = harnessMatcher();
    const turns = [
      "So who actually signs off before a model is allowed to affect a customer or a production line?",
      "Who signed off before those models were allowed to affect customers or the production lines?",
      "How is your data organised across the plants?",
      "If the data teams disappeared tomorrow, which report would stop working first?",
      "Our airline designs streamline customer models allowed production lineage affects",
      "When it comes to models, who actually makes the final decision to let it start affecting production?",
    ];
    for (const t of turns) for (const q of [MQ, MQ2]) {
      expect(h.mqOverlap(t, q), `drift on "${t.slice(0, 40)}…"`).toBeCloseTo(p.mqOverlap(t, q), 10);
    }
  });
});

describe("v5.34.83 — covered ground", () => {
  it("allows pressing further but not re-asking what an answer already gave", () => {
    /*
     * Turn 9 of the 2026-09-14 run asked whether plants still keep their own
     * spreadsheets, after turns 2 and 5 had covered plant figures diverging
     * from the warehouse. No sentence repeated, so the asked-questions list
     * could not catch it; it is the same ground in new words.
     */
    const out = buildInterviewerInstruction({ askedCount: 4 });
    expect(out).toContain("pressing for something the answer did not give you");
    expect(out).toContain("If you can already answer it from what they told you, move on");
  });
});
