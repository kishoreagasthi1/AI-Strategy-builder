/**
 * Neither interviewer tells the client what the firm thinks of them. (v5.34.90)
 *
 * ── What happened ───────────────────────────────────────────────────────────
 *
 * There are two interviewers. The VOICE one is built in interviewerPersona.ts
 * and has carried a confidentiality rule since v5.32.33: it never reveals,
 * quotes, summarises or hints at the firm's own analysis. The TEXT one is built
 * in interview_agent.html from the same seven dimensions, the same briefing and
 * the same candid hypotheses — and carried no such rule at all. It was
 * additionally instructed:
 *
 *     "- After every 4-5 exchanges, offer a brief diagnostic insight"
 *
 * On 2026-09-14, in production, it did exactly that, unprompted, to a client
 * executive mid-interview:
 *
 *     "Here is a quick diagnostic insight based on what we have covered so far:
 *      you are in a common but risky position for manufacturing firms. Moving
 *      fast with vendor-built models delivers quick wins, but without MLOps
 *      infrastructure or a clear governance framework, you build up technical
 *      debt and risk exposure very quickly."
 *
 * Two harms, and the second is the one that costs evidence. A client hears the
 * firm's verdict in draft, from the instrument still collecting the evidence
 * for it, before any consultant has reviewed a word — and an executive who has
 * just been told they are "risky" spends the rest of the hour defending rather
 * than describing.
 *
 * ── And the panel beside the conversation ───────────────────────────────────
 *
 * Worse in the same direction: only the consultant SETUP was hidden from an
 * interviewee, never the side panel. So a client executive watched the live
 * scorecard mark them "Governance & Risk 1.0 / 5 · AI Unaware" while the
 * Findings tab filled with the firm's findings about them, in real time.
 *
 * ── Why a parity test ───────────────────────────────────────────────────────
 *
 * One rule, two files, one of them a browser page that cannot import the other.
 * That is precisely the shape that let the scoring rubric drift, and the same
 * answer applies: pin the text of both to one exported definition.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONFIDENTIALITY_RULE, buildInterviewerInstruction } from "../src/llm/interviewerPersona.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const page = readFileSync(join(root, "frontend", "interview_agent.html"), "utf8");

describe("v5.34.90 — one confidentiality rule, both interviewers", () => {
  it("the rule says the thing it needs to say", () => {
    // Guards the assertions below from passing against an emptied constant.
    expect(CONFIDENTIALITY_RULE).toMatch(/never reveal, quote, summarise, or hint/);
    expect(CONFIDENTIALITY_RULE).toMatch(/analysis, hypotheses, or expectations/);
    expect(CONFIDENTIALITY_RULE, "it must also say what to do when asked outright")
      .toMatch(/only here to listen and understand/);
  });

  it("the VOICE interviewer carries it", () => {
    const out = buildInterviewerInstruction({ context: "briefing" });
    expect(out).toContain(CONFIDENTIALITY_RULE);
  });

  it("the VOICE interviewer carries it AFTER the data fence", () => {
    /*
     * Position is the point. The background block is the one part of this
     * prompt an interviewee can influence; a confidentiality rule that could be
     * argued with by the material it protects is not a rule.
     */
    const out = buildInterviewerInstruction({ context: "briefing" });
    expect(out.indexOf("--- BEGIN BACKGROUND ---")).toBeLessThan(out.indexOf(CONFIDENTIALITY_RULE));
  });

  it("the TEXT interviewer carries the identical words", () => {
    /*
     * Verbatim, not paraphrased. The page cannot import the module, so the only
     * thing keeping them honest is this assertion — and a rule that is "roughly
     * the same" in two places is a rule that will be different in six months.
     */
    expect(page, "interview_agent.html does not define the shared rule")
      .toContain("var CONFIDENTIALITY_RULE");
    /*
     * EVALUATE the page's literal rather than substring-match the file. Both
     * copies are written as concatenated string literals across source lines,
     * so the assembled value never appears contiguously in either file — a
     * plain toContain compares the runtime string against source formatting and
     * fails on identical text.
     */
    const m = /var CONFIDENTIALITY_RULE =([\s\S]*?);\n/.exec(page);
    expect(m, "could not read the page's CONFIDENTIALITY_RULE").toBeTruthy();
    const pageRule = new Function(`return (${m![1]});`)() as string;
    expect(pageRule, "the text path's copy has drifted from the exported definition")
      .toBe(CONFIDENTIALITY_RULE);
    expect(page, "the rule is defined but never put into the prompt")
      .toMatch(/\+ CONFIDENTIALITY_RULE \+/);
  });

  it("the TEXT interviewer is no longer told to volunteer its assessment", () => {
    const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "the diagnostic-insight instruction is back")
      .not.toMatch(/offer a brief diagnostic insight/);
  });

  it("keeps the conversational give, without the assessment", () => {
    /*
     * The instruction existed for a real reason: an interview that only takes
     * and never gives feels like an interrogation. Replaced rather than
     * deleted — playing back what they SAID does the same work, reveals
     * nothing, and invites a correction, which is better evidence than
     * agreement.
     */
    expect(page).toMatch(/play back what you have understood/);
    expect(page).toMatch(/Describe only what THEY told you/);
    /*
     * Each half asserted on its own: the sentence is split across concatenated
     * source lines, so no single regex spans it. Both halves matter — the first
     * forbids the assessment, the second names the forms it would otherwise
     * arrive in.
     */
    expect(page, "it must forbid offering an assessment")
      .toMatch(/Never offer your assessment, /);
    expect(page, "it must name the forms the assessment would take")
      .toMatch(/a score, a maturity level, a comparison to other firms, or what any of it implies/);
  });
});

describe("v5.34.90 — the interviewee does not watch their own assessment", () => {
  it("hides the scorecard and findings panel from an interviewee", () => {
    /*
     * Only #setup-screen was ever hidden. The side panel — live dimension
     * scores and the findings list — stayed on screen throughout, so the
     * subject of the diagnostic watched it being written.
     */
    const at = page.indexOf("if (!window.vyneInterview || !vyneInterview.isInterviewee()) return;");
    expect(at, "the interviewee bootstrap moved — update this test").toBeGreaterThan(-1);
    const body = page.slice(at, at + 6000);
    expect(body).toMatch(/querySelector\('\.side-panel'\)/);
    expect(body).toMatch(/panel\.style\.display = 'none'/);
  });

  it("gives the conversation the full width once the panel is gone", () => {
    // Otherwise the layout keeps a 320px empty column beside the transcript.
    const at = page.indexOf("if (!window.vyneInterview || !vyneInterview.isInterviewee()) return;");
    const body = page.slice(at, at + 6000);
    expect(body).toMatch(/gridTemplateColumns = '1fr'/);
  });

  it("leaves the CONSULTANT's own view untouched", () => {
    /*
     * The cut is exactly isInterviewee(). A consultant running an interview in
     * their own browser still needs the live meter — it is their working view,
     * and since v5.34.85 it is also the only signal that scoring is alive.
     */
    const guardAt = page.indexOf("if (!window.vyneInterview || !vyneInterview.isInterviewee()) return;");
    expect(guardAt).toBeGreaterThan(-1);
    /*
     * Search from the guard forward. An unrelated handleRoleChange() hides a
     * custom-role panel with the same statement much earlier in the file, and
     * a bare indexOf finds that one — the assertion then passes or fails for a
     * reason that has nothing to do with what it is checking.
     */
    const hideAt = page.indexOf("panel.style.display = 'none'", guardAt);
    expect(hideAt, "the side panel is not hidden inside the interviewee-only block")
      .toBeGreaterThan(guardAt);
    expect(page.slice(guardAt, hideAt), "the hide is too far from the guard to be inside it")
      .toMatch(/side-panel/);
    // And the panel still exists in the markup for everyone else.
    expect(page).toMatch(/<div class="side-panel">/);
  });
});

/**
 * v5.34.91 — the interviewer has ONE name, and both paths say it.
 *
 * Observed in production on 5.34.89, text path: the agent opened with "I'm
 * VYNE" while every bubble it spoke in was labelled "Jack Smith". v5.34.41 had
 * fixed the LABEL to read the assigned identity, and interviewerPersona.ts has
 * told the voice interviewer "Your name is <me>" since v5.32.33 — but
 * buildSystemPrompt() in the page still opened with the hardcoded literal
 * 'You are VYNE, the AI interview agent...'. Two of the three places agreed,
 * which is why it survived: the fix looked done.
 */
describe("v5.34.91 — one interviewer, one name", () => {
  const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the text prompt no longer hardcodes the product name as the interviewer", () => {
    expect(code, "buildSystemPrompt still introduces the interviewer as 'VYNE'")
      .not.toMatch(/You are VYNE, the AI interview agent/);
  });

  it("it uses the assigned identity instead", () => {
    expect(code).toMatch(/function textInterviewerName\(\)/);
    expect(code, "the prompt does not use the assigned name")
      .toMatch(/'You are ' \+ me \+ ', an AI interview agent/);
    expect(code, "textInterviewerName must read the same identity the bubbles are labelled from")
      .toMatch(/S\.interviewerName \|\| \(assignedInterviewerIdentity\(\)\|\|\{\}\)\.name/);
  });

  it("sanitises it — this string lands ABOVE the data fence", () => {
    /*
     * The page is the interviewee's browser during an interview. An unsanitised
     * name interpolated into the system prompt is an injection point, and the
     * voice path has always run it through safeIdentity(). Same character class,
     * same 40-char clamp.
     */
    const body = /function textInterviewerName\(\)([\s\S]*?)\n\}/.exec(code);
    expect(body, "textInterviewerName moved — update this test").toBeTruthy();
    expect(body![1]).toMatch(/\\p\{L\}\\p\{N\}/);
    expect(body![1], "an unbounded name can push the rest of the prompt out of the window")
      .toMatch(/slice\(0, ?40\)/);
  });

  it("falls back to the SAME default the voice persona uses", () => {
    // interviewerPersona.ts: safeIdentity(ctx.interviewerName, 40) || "Vyn"
    expect(code, "the text path's no-identity default has drifted from the voice path's")
      .toMatch(/return n \|\| 'Vyn';/);
    expect(code, "the chat bubble label still says 'VYNE Agent' while the agent says 'Vyn'")
      .toMatch(/S\.interviewerName \|\| 'Vyn'/);
  });
});
