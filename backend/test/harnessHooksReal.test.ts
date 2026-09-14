/**
 * Every callback the voice harness registers must be one something calls. (v5.34.78)
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * deploy/voice-record.mjs passed `onAgentText` to vyneLiveInterview.create().
 * That is a vyne-live.js callback name. vyne-live-interview.js INTERCEPTS it —
 * it accumulates the fragment into pendingAgent and re-emits it under a
 * different name — and never forwards it to opts. So the harness's handler was
 * never once called.
 *
 * The handler was the interview-close detector. Which means `closed by agent`
 * in every verdict this harness has ever printed was not a measurement: it was
 * a field that could only print "no". On 2026-09-14 it printed "no — ran to the
 * time limit" about a run in which the interviewer closed the interview at 112
 * seconds, and the remaining twenty-eight minutes of paid model time were spent
 * reading scripted answers at an interviewer that kept saying "we covered that
 * already". Two earlier sessions were spent widening that regex — twice — to
 * fix a failure that was never in the regex at all.
 *
 * A silent-no-op hook is the worst failure mode a test rig has, because the rig
 * keeps producing confident output. Nothing in the harness could catch it: the
 * handler not firing looks exactly like the condition not occurring.
 *
 * ── What this asserts ───────────────────────────────────────────────────────
 *
 * The names, read out of the two files, on both sides:
 *
 *   1. Every `onX:` key the harness hands to create() is a name
 *      vyne-live-interview.js actually invokes as self.opts.onX.
 *   2. onTurns specifically — the close detector's new home — is invoked, and
 *      is invoked with WHOLE turns rather than the sub-word fragments the old
 *      handler was matching multi-word patterns against.
 *
 * Static, by design. Standing up a browser, a fake Gemini and a thirty-minute
 * conversation to discover a typo'd key is how this went unnoticed for three
 * versions; reading the two files takes milliseconds and cannot be fooled by
 * a run that happens not to reach the condition.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const HARNESS = read("deploy/voice-record.mjs");
const INTERVIEW = read("frontend/vyne-live-interview.js");
const LIVE = read("frontend/vyne-live.js");

/** The `onX:` keys the harness passes into vyneLiveInterview.create({...}). */
function harnessHooks(): string[] {
  const at = HARNESS.indexOf("vyneLiveInterview.create({");
  expect(at, "the harness no longer calls vyneLiveInterview.create — update this test").toBeGreaterThan(-1);
  /*
   * Bounded to the create() call. Scanning the whole file would sweep up the
   * `onX` names quoted in comments — including, deliciously, this bug's own
   * post-mortem — and the test would then pass by matching its own prose.
   */
  const body = HARNESS.slice(at, HARNESS.indexOf("\n});", at));
  return [...new Set([...body.matchAll(/^\s{2}(on[A-Z]\w*)\s*:/gm)].map((m) => m[1]))];
}

/** The `onX` names a module forwards to its own caller, as self.opts.onX / this.opts.onX. */
function forwarded(src: string): Set<string> {
  return new Set([...src.matchAll(/(?:self|this)\.opts\.(on[A-Z]\w*)/g)].map((m) => m[1]));
}

describe("v5.34.78 — the voice harness registers no dead hooks", () => {
  it("finds the hooks the harness actually registers", () => {
    // Guards the regex above: a silent zero-match here would make every
    // assertion below vacuously true, which is this bug's exact shape.
    const hooks = harnessHooks();
    expect(hooks.length).toBeGreaterThan(6);
    expect(hooks).toContain("onTurnState");
  });

  it("every hook the harness passes is one vyne-live-interview.js calls", () => {
    const emitted = forwarded(INTERVIEW);
    const dead = harnessHooks().filter((h) => !emitted.has(h));
    expect(dead, `these callbacks are never invoked — the harness is measuring nothing through them: ${dead.join(", ")}`)
      .toEqual([]);
  });

  it("does not register onAgentText, which that module swallows", () => {
    /*
     * The specific regression. vyne-live.js DOES emit onAgentText, so the name
     * looks right in isolation and greps clean against the wrong file; it is
     * only dead through vyne-live-interview.js, which is what the harness
     * drives. Pinned by name so a future edit cannot quietly restore it.
     */
    expect(forwarded(LIVE).has("onAgentText"), "vyne-live.js is expected to emit onAgentText").toBe(true);
    expect(forwarded(INTERVIEW).has("onAgentText"), "vyne-live-interview.js consumes onAgentText; it must not be forwarded")
      .toBe(false);
    expect(harnessHooks()).not.toContain("onAgentText");
  });

  it("detects the interview closing through onTurns, on whole turns", () => {
    /*
     * Position AND payload. onTurns fires from onTurnComplete, after
     * _flushPending() has assembled the fragments into {who, text} — so the
     * close pattern is tested against a finished sentence. The old handler was
     * handed sub-word fragments (" your", " time"), which no multi-word
     * pattern could match even if it had been called: two independent bugs,
     * one of which would have survived fixing the other.
     */
    expect(harnessHooks(), "the close detector must be on a hook that fires").toContain("onTurns");
    expect(INTERVIEW).toMatch(/_flushPending\(\);\s*\n\s*if \(self\.opts\.onTurns\)/);
    expect(INTERVIEW).toMatch(/turns\.push\(\{ who: 'VYNE', text: this\.pendingAgent\.trim\(\) \}\)/);
    // And the harness reads the last VYNE turn, not the last turn of any kind.
    expect(HARNESS).toMatch(/last\.who !== "VYNE"/);
  });

  it("still recognises the closings the interviewer actually used", () => {
    /*
     * The pattern, lifted from the harness and exercised against transcript
     * lines from real recordings. Three of these are verbatim from runs that
     * the harness reported as "closed by agent: no".
     */
    const m = HARNESS.match(/const CLOSING_RE = new RegExp\(\[([\s\S]*?)\]\.join\("\|"\)\)/);
    expect(m, "the closing pattern moved — update this test").toBeTruthy();
    const parts = [...m![1].matchAll(/String\.raw`([^`]*)`/g)].map((x) => x[1]);
    expect(parts.length).toBeGreaterThanOrEqual(4);
    const re = new RegExp(parts.join("|"));
    const closings = [
      "that's all the topics i needed to cover with you, unless you have anything else you'd like to add? thanks for your time.",
      "i think i've covered everything i came for. thanks again for your time, alex. take care.",
      "i think i have a good picture of how things work across technology, data, and potential governance. thanks for your time.",
      "that concludes our interview.",
      "i really appreciate you taking the time today.",
    ];
    for (const c of closings) expect(re.test(c), `missed a real closing: "${c}"`).toBe(true);
    // And must NOT fire mid-interview, which would end a paid run early.
    for (const c of [
      "thanks, that's helpful. how do you handle model sign off?",
      "got it. so who actually signs off before a model affects a production line?",
      "that's useful — can you say more about the shop floor systems?",
    ]) expect(re.test(c), `would have ended the run early on: "${c}"`).toBe(false);
  });
});

describe("v5.34.78 — the rig stops instead of billing for its own repetition", () => {
  it("ends the run when the scripted interviewee is out of material", () => {
    /*
     * Eight answers, about fourteen seconds a cycle: the script is spent inside
     * two minutes. Every run before this looped it to the wall clock, so a
     * thirty-minute run was twenty-eight minutes of the interviewer being read
     * the same eight answers — billed at the live model's output rate, and
     * producing "repetition" in the verdict that was entirely the rig's.
     */
    expect(HARNESS).toMatch(/if \(answerIndex >= ANSWERS\.length && !LOOP\)/);
    expect(HARNESS).toMatch(/finish\("the scripted interviewee ran out of material"\)/);
  });

  it("keeps the soak available, and labels what it is worth", () => {
    // The ~10-minute handover cannot be reached in one pass, so --loop stays.
    expect(HARNESS).toMatch(/const LOOP = has\("loop"\) \|\| SELFTEST/);
    expect(HARNESS).toMatch(/Do NOT judge question/);
    expect(HARNESS).toMatch(/this line is not evidence/);
  });

  it("does not let a handover be mistaken for a stall, or hide one forever", () => {
    /*
     * The watchdog fired at 26s during the self-check's deliberate 4+8+16s
     * retry ladder and cued an answer into the stage whose subject is that
     * ladder's timing. The pass is bounded: a handover that never completes
     * must not disable the dead-uplink watchdog for the rest of the run.
     */
    expect(HARNESS).toMatch(/renewingSince !== null && Date\.now\(\) - renewingSince < RENEW_GRACE_MS/);
    expect(HARNESS).toMatch(/renewingSince = Date\.now\(\)/);
    expect(HARNESS).toMatch(/renewingSince = null/);
  });

  it("cannot mistake a GREETING for a close", () => {
    /*
     * The 2026-09-14 03:40 run ended at ELEVEN SECONDS with zero replies. The
     * opening was "Hello, Alex. I'm Jack Smith. Thanks for taking the time
     * today." — which is the closing pattern, because at the end of an
     * interview that is precisely what those words mean.
     *
     * The pattern is not the thing to fix: every phrase that ends an interview
     * also appears in pleasantries, and each narrowing trades a false stop for
     * a missed one — the failure that wasted twenty-eight minutes two versions
     * ago. Position is what separates them, so the guard is structural: an
     * interview cannot close before it has started. This asserts the guard
     * exists, reads the SAME pattern the detector reads, and sits BEFORE the
     * detector rather than after it.
     */
    expect(HARNESS, "the closing pattern must be one shared constant, not two copies")
      .toMatch(/const CLOSING_RE = new RegExp\(/);
    expect(HARNESS).toMatch(/const MIN_TURNS_BEFORE_CLOSE = Number\(/);
    const guard = HARNESS.indexOf("if (turns.length < MIN_TURNS_BEFORE_CLOSE)");
    const detect = HARNESS.indexOf("if (!CLOSING_RE.test(s)) return;");
    expect(guard, "no early-close guard — a greeting will end the run").toBeGreaterThan(-1);
    expect(detect).toBeGreaterThan(-1);
    expect(guard, "the guard must run BEFORE the detector, or it guards nothing").toBeLessThan(detect);

    // The real greeting, verbatim, does match the pattern — which is exactly
    // why the structural guard has to carry the weight.
    const m = HARNESS.match(/const CLOSING_RE = new RegExp\(\[([\s\S]*?)\]\.join\("\|"\)\)/);
    const parts = [...m![1].matchAll(/String\.raw`([^`]*)`/g)].map((x) => x[1]);
    const re = new RegExp(parts.join("|"));
    expect(re.test("hello, alex. i'm jack smith. thanks for taking the time today.")).toBe(true);
  });
});
