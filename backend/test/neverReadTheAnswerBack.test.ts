/**
 * The interviewee's own answer is never handed back to them. (v5.34.119)
 *
 * ── Reported from the 2026-09-17 live interview ─────────────────────────────
 *
 *   "Jack Smith was parroting what I said back to me."
 *
 * Every one of the ten interviewer turns in that transcript opens the same way:
 *
 *   "Right, so it's a core pillar. But concretely..."
 *   "Interesting, so both efficiency and growth. You mentioned a three-year..."
 *   "Got it, so start with quick wins for R O I and build from there."
 *   "Okay, so global data lake and warehouse, some regional parts, and
 *    functional data domains too, and sounds like some are still siloed."
 *   "Right, so definitely federated."
 *   "Got it, Databricks Unity and Open Metadata."
 *   "Makes sense, so embedded in the data pipelines."
 *   "Interesting, so guidance from a Chief A I Officer, but use cases bubble
 *    up from the business units."
 *   "Interesting, so complexity depends on scale."
 *   "Got it, so managing recommendation guardrails across those systems is key"
 *
 * Ten for ten. It is in the v5.34.116 transcript too — "Right, so you've built
 * tools that let business units create their own models..." — so it is not a
 * regression from any recent build. It has been there the whole time and this
 * is the first time anyone named it.
 *
 * ── The instruction that asked for it does not exist ────────────────────────
 *
 * The obvious move is to find the reflective-listening line and delete it. The
 * persona was grepped for reflect, mirror, paraphrase, restate, acknowledge,
 * "show understanding", "in your own words", "what you heard". The only rule in
 * this territory is:
 *
 *   "React briefly before moving on — 'got it', 'that's helpful',
 *    'interesting' — the way a person does. Do not over-praise every answer."
 *
 * which asks for two words. Nothing asked for the summary. Reflective
 * listening is simply the default register a native-audio model adopts for an
 * interviewer persona, and no rule contradicted it.
 *
 * So this file guards an ADDITION, not the removal of a bad line — worth
 * stating because a defect with no instruction behind it is the kind this
 * project has repeatedly mistaken for a code bug.
 *
 * ── The distinction that has to hold ────────────────────────────────────────
 *
 * Naming something they said in order to ask about it is good interviewing, and
 * the same transcript has it: "You mentioned a three-year roadmap. Is that
 * formally funded now?" That must survive. Recapping their answer before
 * asking must not. A rule that kills both would make the interviewer worse,
 * and the tests below hold each half separately for that reason.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildInterviewerInstruction } from "../src/llm/interviewerPersona.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const INTERVIEW = readFileSync(join(root, "frontend", "vyne-live-interview.js"), "utf8");
const joined = (s: string) => s.replace(/'\s*\+\s*'/g, "");

const FENCE = "--- BEGIN BACKGROUND ---";
const instruction = () => buildInterviewerInstruction({
  interviewerName: "Jack Smith",
  intervieweeName: "Avery Keller",
  intervieweeRole: "Chief Data Officer",
  clientName: "Northwind Foods",
});

describe("v5.34.119 — do not recap their answer", () => {
  it("forbids restating, summarising and paraphrasing the answer", () => {
    expect(instruction()).toMatch(
      /Do not restate, summarise or paraphrase their answer back to them before asking your next question/i);
  });

  it("forbids saying their words back verbatim", () => {
    /*
     * The separate, worse failure — see the 05:38 turn in
     * dyingConnectionStopsAnswering's v5.34.119 section. A paraphrase ban alone
     * does not cover a recitation, because a recitation is not a paraphrase.
     */
    expect(instruction()).toMatch(/Never say their words back to them verbatim/i);
    expect(instruction()).toMatch(/never read any part of this conversation out loud/i);
  });

  it("names the opener that actually appeared, so the model can recognise it", () => {
    /*
     * A general prohibition is easy to comply with in spirit and miss in
     * practice. The transcript produced five distinct variants of one shape:
     * acknowledgement + "so" + their answer. Naming them is what makes the rule
     * actionable rather than aspirational.
     */
    const s = instruction();
    for (const opener of ["so what you're saying is", "right, so", "got it, so", "okay, so", "makes sense, so"]) {
      expect(s, `the rule does not name the '${opener}' opener`).toContain(opener);
    }
  });

  it("KEEPS the good behaviour — naming one thing they raised in order to ask about it", () => {
    /*
     * "You mentioned a three-year roadmap. Is that formally funded now?" is the
     * interviewer working properly. A rule that forbade referring to their
     * answers at all would remove the follow-up, which is most of the value of
     * a live interview over a form.
     */
    const s = instruction();
    expect(s).toMatch(/Naming something they said in order to ask about it is good and you should keep doing it/i);
    expect(s, "the permitted case is not illustrated, so the rule reads as a blanket ban")
      .toMatch(/you mentioned a three-year roadmap/i);
  });

  it("bounds the 'react briefly' rule that the summary grew out of", () => {
    /*
     * The parroting is that rule over-served. Left unbounded, the prohibitions
     * above and the instruction to react sit in tension and the model gets to
     * choose; saying how long a reaction may be resolves it.
     */
    const s = instruction();
    expect(s).toMatch(/React briefly before moving on/);
    expect(s).toMatch(/Two or three words is the whole reaction/i);
    expect(s).toMatch(/do not extend it into an account of what they just told you/i);
  });

  it("keeps all of it ABOVE the data fence", () => {
    // The interviewee can steer what goes into the transcript; rules about how
    // to treat the transcript cannot live inside it.
    const above = instruction().split(FENCE)[0];
    expect(above).toMatch(/Do not restate, summarise or paraphrase/i);
    expect(above).toMatch(/Never say their words back to them verbatim/i);
    expect(above).toMatch(/Two or three words is the whole reaction/i);
  });

  it("does not contradict the rules it sits among", () => {
    const s = instruction();
    // Still following what they say, still pressing for specifics, and still
    // not attributing the firm's briefing to them (v5.34.116).
    expect(s).toMatch(/Follow what they actually say/);
    expect(s).toMatch(/Push politely for specifics/);
    expect(s).toMatch(/None of it is something this person told you/i);
  });

  it("adds no question mark above the fence", () => {
    /*
     * interviewNoRepeat.test.ts forbids any '?' above the data fence, and the
     * illustration in these rules is one edit away from wanting one — the
     * v5.34.116 rule already had to be rephrased for exactly this. Asserted
     * here too so the reason is visible at the place the temptation arises.
     */
    expect(instruction().split(FENCE)[0]).not.toContain("?");
  });
});

describe("v5.34.119 — the handover nudge stops pointing at the transcript", () => {
  const stalled = joined(
    /self\.open\(self\._replyStalled([\s\S]*?)self\._cutOffInterviewee/.exec(INTERVIEW)![1]);

  it("no longer tells the model the answer is visible to it", () => {
    /*
     * THE cause of the 05:38 recitation. v5.34.117 said "it is there in the
     * conversation you can see ... respond to that answer now, directly". The
     * answer is already in context and needs no pointing at; pointing at it is
     * what turned "respond" into "read out".
     */
    expect(stalled, "the nudge still points the model at the transcript")
      .not.toMatch(/there in the conversation you can see|already given you a full answer/i);
    expect(stalled, "the nudge still says to respond to that answer")
      .not.toMatch(/Respond to that answer now/i);
  });

  it("names the action as carrying on, not as responding to what is on record", () => {
    expect(stalled).toMatch(/Take it as heard and carry straight on/i);
    expect(stalled).toMatch(/ask your next question/i);
  });

  it("forbids reading it back, in the nudge as well as the persona", () => {
    /*
     * Belt and braces on purpose: the nudge is delivered as a one-turn
     * instruction and is therefore the most specific thing in front of the
     * model at exactly the moment the recitation happened. A persona rule two
     * thousand tokens away did not win that argument last time.
     */
    expect(stalled).toMatch(/Do not read their answer back to them/i);
    expect(stalled).toMatch(/do not summarise it/i);
    expect(stalled).toMatch(/do not repeat any of their words/i);
  });

  it("still holds v5.34.117's requirement — they are not asked to repeat themselves", () => {
    expect(stalled).toMatch(/do not ask them to repeat anything/i);
    expect(stalled).toMatch(/do not apologise/i);
    expect(stalled).not.toMatch(/say it again/i);
  });

  it("still does not announce itself", () => {
    expect(stalled).toMatch(/do not say you are still there/i);
    expect(stalled).toMatch(/do not greet them again/i);
  });
});

/**
 * ── The detector, proved against the real transcript ────────────────────────
 *
 * A detector that has never fired is not a detector. These lift the rig's
 * RECAP_OPENER and longestSharedRun out of deploy/voice-record.mjs and run them
 * over the actual 2026-09-17 turns, so the regex is known to catch the thing it
 * was written for — and known not to catch a clean turn.
 */
describe("v5.34.119 — the harness can see parroting when it happens", () => {
  const RIG = readFileSync(join(root, "deploy", "voice-record.mjs"), "utf8");

  function detector() {
    const re = /const RECAP_OPENER = (\/.*\/i);/.exec(RIG);
    expect(re, "RECAP_OPENER moved — update this test").toBeTruthy();
    const fn = /function longestSharedRun\(a, b\) \{[\s\S]*?\n\}/.exec(RIG);
    expect(fn, "longestSharedRun moved — update this test").toBeTruthy();
    const words = /const VERBATIM_RUN_WORDS = (\d+);/.exec(RIG);
    expect(words).toBeTruthy();
    // eslint-disable-next-line no-new-func
    const mk = new Function(`${fn![0]}\nreturn { opener: ${re![1]}, run: longestSharedRun, min: ${words![1]} };`);
    return mk() as { opener: RegExp; run: (a: string, b: string) => number; min: number };
  }

  /** Verbatim, from the interview he sent. */
  const REPORTED_OPENERS = [
    "Right, so it's a core pillar. But concretely, what major business problems",
    "Got it, so start with quick wins for R O I and build from there.",
    "Okay, so global data lake and warehouse, some regional parts, and functional data domains too",
    "Right, so definitely federated. You mentioned similar standards and tooling",
    "Makes sense, so embedded in the data pipelines. Moving a bit, your strategy",
    "Interesting, so both efficiency and growth. You mentioned a three-year roadmap.",
    "Interesting, so complexity depends on scale. Can you describe one of those",
    "Interesting, so guidance from a Chief A I Officer, but use cases bubble up",
    "Got it, so managing recommendation guardrails across those systems is key",
  ];

  it("catches every recap opener in the reported interview", () => {
    const { opener } = detector();
    for (const line of REPORTED_OPENERS) {
      expect(opener.test(line), `missed: "${line}"`).toBe(true);
    }
  });

  it("does not fire on a clean turn", () => {
    /*
     * False positives would be worse than no detector: they would train us to
     * ignore the line. "Got it, Databricks Unity and Open Metadata" is from the
     * same transcript and IS a light recap, but it has no "so" — the rule is
     * deliberately narrow, catching the shape that appeared nine times rather
     * than every possible acknowledgement.
     */
    const { opener } = detector();
    for (const line of [
      "You mentioned a three-year roadmap. Is that formally funded now?",
      "Got it. Where does your data sit right now?",
      "That's helpful. Who owns that vision?",
      "Interesting. Can you give me an example from last quarter?",
      "So, where does your data sit right now?",
    ]) {
      expect(opener.test(line), `false positive on: "${line}"`).toBe(false);
    }
  });

  it("catches the verbatim echo at the handover", () => {
    /*
     * The 05:38 turn: Jack read Avery's answer out, ending with "I forget what
     * the second part of your question was", then appended the missing half of
     * his own question.
     */
    const { run, min } = detector();
    const answer = "there is a committee that sits and discusses this for initiatives that " +
      "especially touch customers and employees. We we definitely take a serious look at that. " +
      "I forget what the second part of your question was.";
    const echoed = "Yeah, when it comes to the responsible A I, " + answer +
      " When you're linking all those systems, does your technology stack make that easy?";
    expect(run(echoed, answer)).toBeGreaterThanOrEqual(min);
  });

  it("does not call a normal follow-up an echo", () => {
    /*
     * A good follow-up reuses the interviewee's nouns — it has to, to be about
     * the same thing — so the threshold has to sit above that and below a
     * recited sentence. Eight words is the gap.
     */
    const { run, min } = detector();
    const answer = "We have a global data lake and a global data warehouse in which we have " +
      "most of our data that is meaningful from a global standpoint.";
    const followUp = "With all that spread out, how do you keep an eye on data quality " +
      "and who can access what in the global data lake?";
    expect(run(followUp, answer)).toBeLessThan(min);
  });
});

/**
 * ── v5.34.120: the rules about when to stop pushing ─────────────────────────
 *
 * From the 2026-09-17 08:13 interview. The last five interviewer turns all sat
 * on responsible-AI review and model monitoring, re-entered from four angles,
 * after the interviewee had twice said there was nothing more:
 *
 *   "Yes, AS I SAID, there is a responsible AI committee..."
 *   "I'M NOT PRIVY to the very specifics of any project."
 *
 * Nothing covered it. "Push politely for specifics" says press; the
 * asked-and-answered list forbids repeating a QUESTION, and none of these
 * repeated a question — they repeated the GROUND in new words.
 */
describe("v5.34.120 — knowing when to stop pushing", () => {
  it("treats 'I don't know' and 'as I said' as the answer", () => {
    const s = instruction();
    expect(s).toMatch(/If they tell you they do not know, are not close enough to the detail, or have already answered it/i);
    expect(s).toMatch(/Do not ask it again in another shape/i);
  });

  it("allows exactly one press for a specific example", () => {
    /*
     * "Press once" has to survive alongside "Push politely for specifics",
     * which is the rule that produced the pressing. One is the bound on the
     * other, so both must be present or the pair is incoherent.
     */
    const s = instruction();
    expect(s).toMatch(/Push politely for specifics/);
    expect(s).toMatch(/Press once for a specific example/i);
    expect(s).toMatch(/Asking a third time in a new form/i);
  });

  it("caps consecutive turns on one narrow point, without forbidding depth", () => {
    /*
     * Depth is the product. The v5.34.111 rules tell it to "go deeper there —
     * press for the specifics, the exceptions and the examples"; a rule that
     * banned returning to a subject would delete that. The cap is on circling
     * ONE detail, and the exemption for going deeper on a dimension is stated
     * in the same breath so the two cannot be read as contradicting.
     */
    const s = instruction();
    expect(s).toMatch(/Do not spend more than three turns in a row on the same narrow point/i);
    expect(s).toMatch(/Going deeper on a dimension is right; circling one detail is not/i);
  });

  it("keeps the v5.34.119 attribution rule the loop exploited", () => {
    /*
     * Both looping openers used "You mentioned..." — the form v5.34.119
     * deliberately protected. The rule is right and stays; v5.34.120 bounds it
     * rather than withdrawing it. Asserted here so a later reading of this
     * defect does not remove the wrong thing.
     */
    expect(instruction()).toMatch(/Naming something they said in order to ask about it is good/i);
  });

  it("puts the new rules above the data fence", () => {
    const above = instruction().split(FENCE)[0];
    expect(above).toMatch(/Press once for a specific example/i);
    expect(above).toMatch(/same narrow point/i);
    expect(above).not.toContain("?");
  });
});

describe("v5.34.120 — the detector's hole is closed", () => {
  const RIG2 = readFileSync(join(root, "deploy", "voice-record.mjs"), "utf8");

  /*
   * Lifts the rig's OWN classifyAgentTurn, not a rebuild of it.
   *
   * The first version of this reconstructed the branch inside the test, and
   * three mutations of the real code — dropping the restate shape, dropping the
   * attributed-form exemption, dropping the overlap threshold to 2 — all
   * survived a green suite. A test that reimplements the thing it checks proves
   * only that the test works. The rig now exposes one pure function and this
   * evaluates that function's actual source.
   */
  function detector2() {
    const fn = /function classifyAgentTurn\(turn, lastAnswer\) \{[\s\S]*?\n\}/.exec(RIG2);
    expect(fn, "classifyAgentTurn moved — update this test").toBeTruthy();
    const run = /function longestSharedRun\(a, b\) \{[\s\S]*?\n\}/.exec(RIG2);
    const opener = /const RECAP_OPENER = (\/.*\/i);/.exec(RIG2);
    const attr = /const ATTRIBUTED_OPENER = (\/.*\/i);/.exec(RIG2);
    const ovl = /const RECAP_OVERLAP_WORDS = (\d+);/.exec(RIG2);
    for (const [name, m] of [["longestSharedRun", run], ["RECAP_OPENER", opener],
                             ["ATTRIBUTED_OPENER", attr],
                             ["RECAP_OVERLAP_WORDS", ovl]] as const) {
      expect(m, `${name} moved — update this test`).toBeTruthy();
    }
    // eslint-disable-next-line no-new-func
    const mk = new Function(`
      const RECAP_OPENER = ${opener![1]};
      const ATTRIBUTED_OPENER = ${attr![1]};
      const RECAP_OVERLAP_WORDS = ${ovl![1]};
      ${run![0]}
      ${fn![0]}
      return classifyAgentTurn;`);
    return mk() as (turn: string, lastAnswer: string) => string | null;
  }

  it("the rig actually calls it, rather than deciding inline", () => {
    /* Without this, a correct function can sit beside a call site that ignores
     * it and every test above still passes. */
    expect(RIG2).toMatch(/const handedBack = classifyAgentTurn\(whole, lastAnswerSpoken\);/);
    expect(RIG2).toMatch(/handedBack === "opener"/);
    expect(RIG2).toMatch(/handedBack === "restate"/);
  });

  it("now catches 'I hear you, so ...'", () => {
    // The opener v5.34.119's list missed outright.
    expect(detector2()("I hear you, so you're tracking deviations from expected results. Could you give me an example?", "")).toBe("opener");
  });

  it("a question is never a recap, however much of their wording it reuses", () => {
    /*
     * The "?" guard. A question that quotes their phrasing back is the
     * interviewer being precise about what it is asking — the opposite of a
     * recap, which is a statement placed in front of a question. M90: removing
     * the guard survived every other test here.
     */
    const flag = detector2();
    const answer = "Yes, we we do have data governance teams and data stewards across different " +
      "functions and domains. It's their responsibility to maintain data quality.";
    expect(flag("Who maintains the data governance teams and data stewards across different functions?", answer)).toBe(null);
    expect(flag("Is it the data governance teams and data stewards across different functions who sign that off?", answer)).toBe(null);
  });

  it("the overlap threshold is high enough to spare a reused noun phrase", () => {
    /*
     * A good opening often names the subject the interviewee just named — it
     * has to, to be about the same thing. At a threshold of 2 this line is
     * flagged; at 5 it is not, and the difference decides whether the detector
     * argues for or against normal interviewing. M86: lowering the threshold to
     * 2 survived every other test in this file.
     */
    const flag = detector2();
    const answer = "Yes, we we do have data governance teams and data stewards across different " +
      "functions and domains. It's their responsibility to maintain data quality.";
    expect(flag("Data governance is where I would like to spend a moment before we move on.", answer)).toBe(null);
    expect(flag("Data quality is the thing most of these programmes come unstuck on.", answer)).toBe(null);
  });

  it("catches the praise-then-restate shape that has no 'so' in it", () => {
    const flag = detector2();
    const answer1 = "I think we we definitely had plans for much greater head count in terms of our " +
      "people strategy. I think we have slowed that down because we're seeing significant " +
      "productivity with the people that we already have on board.";
    expect(flag(
      "That's interesting that you're seeing such significant productivity with the people you already have on board. " +
      "Beyond that productivity boost, where else are you focusing?", answer1)).toBe("restate");

    const answer2 = "Yes, we we do have data governance teams and data stewards across different " +
      "functions and domains. It's their responsibility to maintain data quality.";
    expect(flag(
      "Having those data governance teams and data stewards across different functions is clearly essential. " +
      "With all that data being accessed through APIs, what controls are in place?", answer2)).toBe("restate");
  });

  it("still spares the attributed form v5.34.119 protects", () => {
    /*
     * The single most important false positive to avoid. If this fires, the
     * detector argues against the behaviour the persona is trying to keep, and
     * the next reading of the numbers removes the wrong rule.
     */
    const flag = detector2();
    const answer = "Yes, we follow the C I C D process, but on the machine learning model specifically, " +
      "we have drift monitoring as part of the process.";
    expect(flag("You mentioned that you follow the C I C D process. Beyond drift monitoring once models are live, how are you assessing them?", answer)).toBe(null);
    expect(flag("Going back to the C I C D process you follow, who owns the drift monitoring part of it?", answer)).toBe(null);
  });

  it("does not fire on a short reaction or a plain question", () => {
    const flag = detector2();
    const answer = "We have a global data lake and a global data warehouse in which we have most of " +
      "our data that is meaningful from a global standpoint.";
    for (const clean of [
      "Got it. Where does your data sit right now?",
      "That's helpful. Who owns that vision?",
      "How do you keep an eye on data quality across the global data lake and warehouse?",
      "Interesting. Can you give me an example from last quarter?",
    ]) {
      expect(flag(clean, answer), `false positive on: "${clean}"`).toBe(null);
    }
  });

  it("scores the reported interview higher than v5.34.119's rule did", () => {
    /*
     * The point of the change, stated as a number. Five of the turns in that
     * transcript hand the answer back; the old rule saw three.
     */
    const flag = detector2();
    const turns: Array<[string, string]> = [
      ["Got it. So, you're balancing dedicated funding with reallocating resources. When you say solid R O I, what returns?", ""],
      ["Interesting, so it's Azure for the cloud and specific models like OpenAI and Claude. For your own solutions, is there a standard process?", ""],
      ["I hear you, so you're tracking deviations from expected results. Could you give me a specific example?", ""],
      ["Understood, so the process is there. Since it's structured like that, do those processes include predefined roles?", ""],
      ["Right, so there's a discussion with the leaders and the committee gets involved. What are the guardrails designed to prevent?", ""],
    ];
    const caught = turns.filter(([t, a]) => flag(t, a) !== null).length;
    expect(caught, "the widened rule misses one of the five reported recaps").toBe(5);
  });
});
