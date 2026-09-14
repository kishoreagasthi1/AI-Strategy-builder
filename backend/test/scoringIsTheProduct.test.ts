/**
 * An interview that is not scoring is not an interview. (v5.34.85)
 *
 * ── What this is protecting ─────────────────────────────────────────────────
 *
 * VYNE's output is an AI-readiness assessment: dimension scores, findings,
 * benchmarks, a roadmap. The interview is how the evidence is gathered, and
 * scores are the only part of it that reaches the scorecard, the synthesis or
 * the deck. A conversation that produces none has cost a senior executive an
 * hour and contributed nothing.
 *
 * Four things were letting exactly that happen, all of them quiet:
 *
 *   1. A throw inside the page's onScore handler was swallowed, so a scoring
 *      pass could be lost with scoreFailures still 0 — an outage that looked
 *      like a clean interview.
 *   2. A scoring outage did not stop the interview. It carried on to the end
 *      producing a transcript nobody could turn into an assessment.
 *   3. The unscored-submission guard was a speed bump: one warning, then the
 *      second click submitted anyway. The person clicking is usually the
 *      interviewee, who has no idea what the warning means.
 *   4. Every failure signal rendered in the INTERVIEWEE's browser. The
 *      consultant — whose deliverable it is — was told nothing and found out by
 *      opening an empty scorecard.
 *
 * ── Why these read source ───────────────────────────────────────────────────
 *
 * The page has no test runner, and the behaviour being pinned is a policy
 * decision rather than a computation: what the product does when its central
 * mechanism fails. Where there IS logic — the health record — it is compiled
 * and executed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const page = readFileSync(join(root, "frontend", "interview_agent.html"), "utf8");
const live = readFileSync(join(root, "frontend", "vyne-live-interview.js"), "utf8");

function fnSrc(src: string, name: string): string {
  const i = src.indexOf(`function ${name}(`);
  expect(i, `function ${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(i);
  const next = rest.slice(1).search(/\n(?:async )?function [A-Za-z_]/);
  return next > 0 ? rest.slice(0, next + 1) : rest;
}

describe("v5.34.85 — a lost scoring pass is counted as a failure", () => {
  it("does not swallow a throw from the page's score handler", () => {
    /*
     * `try { onScore(parsed); } catch(e) {}` meant applyScoreData or
     * renderScorecard throwing lost the pass AND skipped the autosave beside
     * it, while leaving every counter reading success. Failing to apply a
     * score is failing to score.
     */
    expect(live).toContain("score_apply_failed");
    /*
     * Comments stripped first. The initial version of this assertion matched
     * the post-mortem comment directly above the fix, which quotes the old
     * swallowing form verbatim — a test failing on its own explanation of why
     * it exists. harnessHooksReal.test.ts documents this exact trap and this
     * walked into it anyway, so: never pattern-match a file's prose for code.
     */
    const code = live.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "onScore is still wrapped in a swallowing catch")
      .not.toMatch(/onScore\(parsed\);\s*\}\s*catch\s*\([\w$]*\)\s*\{\s*\}/);
    expect(code, "the failure must be rethrown so the counters see it")
      .toMatch(/catch \(e\) \{ throw Object\.assign\(new Error\('score_apply_failed'\)/);
  });

  it("the page no longer wraps its own score handler in a bare catch", () => {
    expect(page).toMatch(/onScore: function\(sd\)\{ applyScoreData\(sd\); recordScoringHealth\(true\); autoSave\(\); \}/);
  });
});

describe("v5.34.85 — a dead scorer ends the sitting", () => {
  it("has two thresholds, and they differ for a reason", () => {
    /*
     * Three failures after a success is a provider that went down. Never having
     * scored is more often a thin opening — a model correctly reporting no
     * evidence from two sentences of pleasantries — so it waits longer before
     * concluding the pipe is broken rather than the conversation young.
     */
    expect(live).toMatch(/var STOP_AFTER_CONSECUTIVE = (\d+);/);
    expect(live).toMatch(/var STOP_IF_NEVER_SCORED_BY = (\d+);/);
    const after = Number(/var STOP_AFTER_CONSECUTIVE = (\d+);/.exec(live)![1]);
    const never = Number(/var STOP_IF_NEVER_SCORED_BY = (\d+);/.exec(live)![1]);
    expect(never, "a never-scored interview must be given MORE rope, not less").toBeGreaterThan(after);
    expect(after).toBeGreaterThanOrEqual(3);
  });

  it("fires once per sitting, on either trigger", () => {
    /* The condition now spans lines and carries the duration clause too; the
     * full shape is asserted in the v5.34.88 block below. Here, just that both
     * branches exist and each is anchored to its own success state. */
    expect(live).toMatch(/self\.scoreSuccesses > 0 &&\s*\n?\s*self\.scoreFailures >= STOP_AFTER_CONSECUTIVE/);
    expect(live).toMatch(/self\.scoreSuccesses === 0 &&\s*\n?\s*self\.scoreFailures >= STOP_IF_NEVER_SCORED_BY/);
    expect(live, "without a latch the callback fires on every later failure too")
      .toContain("_scoringDeadFired");
  });

  it("closes through the INTERVIEWER rather than cutting the audio", () => {
    /*
     * The interviewee has been talking to a voice for half an hour. Ending that
     * by silence is the product breaking in their hands; ending it with an
     * apology in the same voice is a conversation being wound up. The persona
     * already carries the rule for this (v5.34.75, written for a time limit —
     * the same situation arriving for a different reason).
     */
    const at = page.indexOf("onScoringDead: function(info)");
    expect(at, "the page does not handle onScoringDead").toBeGreaterThan(-1);
    const body = page.slice(at, at + 3500);
    expect(body, "must speak before stopping").toMatch(/LIVE\.say\(/);
    /* The sentence is split across source lines, so match only the contiguous
     * half — concatenation boundaries are not something a test should encode. */
    expect(body).toContain("up exactly where we left off");
    /*
     * v5.34.86 — it must NAME the reason, not hide it. The first version told
     * the interviewer to say nothing about what went wrong, which leaves an
     * executive who gave up an hour with an unexplained withdrawal. The fault
     * is the firm's; concealing it is worse than owning it.
     */
    expect(body, "the interviewee must be told what actually failed")
      .toMatch(/problem with our scoring mechanism/);
    expect(body, "must say it is not their fault").toContain("not anything");
    expect(body, "must commit to fixing it and coming back").toMatch(/fixing it and will come back/);
    expect(body, "must reassure them nothing is lost").toMatch(/nothing they have said is lost/);
    // Saved before AND after, and the stop comes after the line has played.
    expect(body).toMatch(/saveSession\(\)/);
    expect(body).toMatch(/LIVE\.stop\('scoring_unavailable'\)/);
    const sayAt = body.indexOf("LIVE.say(");
    const stopAt = body.indexOf("LIVE.stop(");
    expect(sayAt, "it stops before it speaks — the interviewee hears nothing").toBeLessThan(stopAt);
  });

  it("ends the SITTING, not the interview", () => {
    // Everything is saved and resumable: this must never be a way to lose an
    // hour of conversation on top of losing the scores.
    const at = page.indexOf("onScoringDead: function(info)");
    const body = page.slice(at, at + 3500);
    expect(body).toMatch(/Everything you have said is saved/);
    expect(body).toMatch(/pick up where you left off/);
  });
});

describe("v5.34.85 — an unscored interview cannot be submitted", () => {
  it("is a stop, not a speed bump", () => {
    /*
     * `_forcedSubmitUnscored` let the second click through. The interviewee
     * reads a warning about a subsystem they have never heard of, clicks again
     * to clear it, and the firm receives an interview worth nothing.
     */
    const code = page.slice(page.indexOf("var everScoredOk"), page.indexOf("var everScoredOk") + 1400);
    expect(code, "the force-submit escape hatch is back").not.toContain("_forcedSubmitUnscored = true");
    expect(code).toMatch(/cannot be submitted/);
    expect(code, "must not invite a retry that cannot work").toMatch(/rather than resubmitting/);
    expect(code, "the conversation must be saved before refusing").toMatch(/saveSession\(\)/);
  });

  it("uses everScored() to say WHICH failure it was", () => {
    /*
     * everScored() was defined, documented as "checked before an interview is
     * submitted", and called from nowhere. The two cases need different
     * responses: no successful pass is an outage to escalate; passes that
     * scored nothing is a short or evasive interview, which is a conversation
     * problem.
     */
    const code = page.slice(page.indexOf("var everScoredOk"), page.indexOf("var everScoredOk") + 1400);
    expect(code).toMatch(/LIVE\.everScored\(\)/);
    expect(code).toMatch(/the scoring passes did not succeed/);
    expect(code).toMatch(/did not give enough evidence to score any dimension/);
  });
});

describe("v5.34.85 — scoring health reaches the consultant", () => {
  const load = () => {
    const S: Record<string, unknown> = {};
    const f = new Function("S", `${fnSrc(page, "recordScoringHealth")}\nreturn recordScoringHealth;`);
    return { S, rec: f(S) as (ok: boolean, info?: { code?: string; consecutive?: number }) => void };
  };

  it("counts passes and failures and keeps the last reason", () => {
    const { S, rec } = load();
    rec(true);
    rec(false, { code: "http_503", consecutive: 1 });
    rec(false, { code: "unparseable_score_response", consecutive: 2 });
    const h = S.scoreHealth as Record<string, unknown>;
    expect(h.passes).toBe(1);
    expect(h.failures).toBe(2);
    expect(h.everSucceeded).toBe(true);
    expect(h.lastError).toBe("unparseable_score_response");
    expect(h.maxConsecutive).toBe(2);
    /*
     * Both failures can land in the same millisecond, so comparing the two
     * timestamps to each other proves nothing. What matters is that the FIRST
     * one is not reassigned by a later failure — capture it and check it again.
     */
    expect(h.firstFailureAt, "the first failure time was never recorded").toBeTruthy();
  });

  it("never overwrites the time of the FIRST failure", () => {
    const { S, rec } = load();
    rec(false, { code: "http_503", consecutive: 1 });
    const first = (S.scoreHealth as Record<string, unknown>).firstFailureAt;
    (S.scoreHealth as Record<string, unknown>).lastFailureAt = "2099-01-01T00:00:00.000Z";
    rec(false, { code: "http_503", consecutive: 2 });
    const h = S.scoreHealth as Record<string, unknown>;
    expect(h.firstFailureAt, "a later failure moved the first-failure time").toBe(first);
    expect(h.lastFailureAt, "the last-failure time did not advance").not.toBe("2099-01-01T00:00:00.000Z");
  });

  it("records a total outage distinguishably from a partial one", () => {
    // everSucceeded is the difference between "the scorer went down mid-way"
    // and "the scorer never worked at all", which are different escalations.
    const { S, rec } = load();
    rec(false, { code: "http_404", consecutive: 1 });
    expect((S.scoreHealth as Record<string, unknown>).everSucceeded).toBe(false);
  });

  it("stays bounded over a three-hour sitting", () => {
    // Written once a minute for the life of the interview, and saved with the
    // session on every change — so it must not accumulate per-failure detail.
    const { S, rec } = load();
    for (let i = 0; i < 500; i++) rec(false, { code: "http_503", consecutive: i });
    expect(Object.keys(S.scoreHealth as object).length).toBeLessThanOrEqual(9);
  });

  it("is saved with the session, so the consultant sees it", () => {
    /*
     * The whole point. The badge renders in the interviewee's browser; the
     * record is what reaches the firm.
     */
    expect(page).toMatch(/data\.scoreHealth\s*=\s*S\.scoreHealth/);
  });
});

describe("v5.34.85 — a resumed refresh interview stays a refresh interview", () => {
  it("persists the refresh fields under the names the app reads back", () => {
    /*
     * THE data-loss defect. saveSession wrote `isRefresh`, `roundLabel` and
     * `coverageByDim`; the app reads `isRefreshMode`, `refreshRoundLabel` and
     * `coverage`, and resume restores by blind spread. So a resumed follow-up
     * believed it was an initial interview: writeInterviewToEngagement stamped
     * isRefresh:false and routed it to the CURRENT round, replacing that role's
     * original round-1 record — the baseline the follow-up existed to be
     * compared against.
     *
     * Both spellings are written. The outward ones are what the server merge
     * and every already-stored record use; the inward ones are what a resume
     * needs. Dropping either breaks something that already works.
     */
    const at = page.indexOf("if(S.isRefreshMode){");
    expect(at).toBeGreaterThan(-1);
    const block = page.slice(at, at + 900);
    for (const [out, back] of [
      ["data.isRefresh=true", "data.isRefreshMode=true"],
      ["data.roundLabel=", "data.refreshRoundLabel="],
      ["data.coverageByDim=", "data.coverage="],
    ]) {
      expect(block, `${out} is written but ${back} is not — a resume will lose it`).toContain(out);
      expect(block, `${back} missing: the resumed interview will not know it is a follow-up`).toContain(back);
    }
  });
});

describe("v5.34.86 — the scorecard is a live meter", () => {
  it("scores often enough to respond to the conversation", () => {
    /*
     * The seven dimension bars sit beside the conversation. At the old 60s
     * floor a dimension could be raised, evidenced and left behind before the
     * meter acknowledged it — the panel read as broken rather than as an
     * assessment forming while you watch.
     *
     * Bounded on purpose: a pass is ~3k tokens in and ~150 out on flash-lite
     * ($0.10/$0.40 per M), about $0.00036 each, so a 60-minute interview costs
     * roughly seven cents of scoring at this floor. Going much below this stops
     * buying responsiveness — people do not answer every five seconds — and
     * starts paying for re-scoring the same window.
     */
    const m = /var SCORE_MIN_INTERVAL_MS = (\d+);/.exec(live);
    expect(m, "the scoring floor moved — update this test").toBeTruthy();
    const ms = Number(m![1]);
    expect(ms, "too slow: a dimension can be covered and gone between passes").toBeLessThanOrEqual(30000);
    expect(ms, "too fast: this pays to re-score a window that has barely moved").toBeGreaterThanOrEqual(10000);
  });

  it("is a floor, not a schedule — an unchanged window still costs nothing", () => {
    // Passes are driven by completed turns; the dedupe is what keeps a quiet
    // stretch free. Lowering the floor without this would bill for silence.
    expect(live).toMatch(/text === this\._lastScored/);
  });

  it("shows a pass in flight, so a live meter and a dead one differ", () => {
    /*
     * Between passes the panel is still. A working scorer and a failed one
     * therefore looked identical — which matters now that a dead scorer ends
     * the sitting: the consultant must be able to tell "nothing evidenced yet"
     * from "nothing being scored".
     */
    expect(live).toMatch(/onScoringState/);
    expect(page).toMatch(/onScoringState: function\(active\)/);
    expect(page).toContain("function setScoringIndicator(active)");
  });

  it("says nothing technical, because the interviewee is reading it", () => {
    // This panel renders in the interviewee's browser on a distributed
    // interview. A diagnostic here reads as the product breaking mid-sentence.
    const at = page.indexOf("function setScoringIndicator(active)");
    const body = page.slice(at, at + 1200);
    expect(body).toMatch(/listening · updating scores/);
    for (const jargon of ["error", "failed", "pass", "LLM", "token"]) {
      expect(body.toLowerCase(), `the indicator says "${jargon}" to an interviewee`)
        .not.toContain(`'${jargon.toLowerCase()}`);
    }
  });
});

describe("v5.34.88 — the stop is measured in TIME, not in passes", () => {
  /*
   * v5.34.85 picked the counts reasoning "a pass runs at most once a minute, so
   * these are minutes". v5.34.86 then lowered the scoring floor from 60s to 20s
   * for the live meter and did not revisit them, so "five passes without a
   * score" silently became a hundred seconds — an interview endable, in front of
   * a client, over a ninety-second wobble. Two correct changes, wrong together.
   *
   * The fix is to stop deriving a duration from a cadence constant that lives
   * elsewhere and is tuned for other reasons.
   */
  it("requires a wall-clock stretch of failure, not just a count", () => {
    expect(live).toMatch(/var STOP_AFTER_MS = (\d+);/);
    expect(live).toMatch(/var STOP_IF_NEVER_SCORED_AFTER_MS = (\d+);/);
    expect(live, "the count alone still decides, so the cadence still sets the timeout")
      .toMatch(/scoreFailures >= STOP_AFTER_CONSECUTIVE && failingMs >= STOP_AFTER_MS/);
    expect(live)
      .toMatch(/scoreFailures >= STOP_IF_NEVER_SCORED_BY && failingMs >= STOP_IF_NEVER_SCORED_AFTER_MS/);
  });

  it("gives a never-scored interview longer than a broken one", () => {
    const a = Number(/var STOP_AFTER_MS = (\d+);/.exec(live)![1]);
    const n = Number(/var STOP_IF_NEVER_SCORED_AFTER_MS = (\d+);/.exec(live)![1]);
    expect(n).toBeGreaterThan(a);
    expect(a, "under two minutes ends interviews over ordinary provider wobbles")
      .toBeGreaterThanOrEqual(120000);
  });

  it("cannot be reached by isolated blips accumulating over an hour", () => {
    /*
     * _failingSince marks the start of the CURRENT unbroken run and is cleared
     * by any success. Without that, one failure every ten minutes across a long
     * interview would eventually satisfy both conditions and end a sitting that
     * was scoring perfectly well between them.
     */
    expect(live).toMatch(/self\._failingSince = null;\s*\/\/ a success breaks the run/);
    expect(live).toMatch(/if \(!self\._failingSince\) self\._failingSince = Date\.now\(\);/);
  });

  it("survives a future change to the scoring cadence", () => {
    // The point of the whole change: the stop must not silently retune itself
    // when someone adjusts the meter's responsiveness.
    const floor = Number(/var SCORE_MIN_INTERVAL_MS = (\d+);/.exec(live)![1]);
    const a = Number(/var STOP_AFTER_MS = (\d+);/.exec(live)![1]);
    expect(a, "the timeout is still just a multiple of the cadence")
      .not.toBe(floor * Number(/var STOP_AFTER_CONSECUTIVE = (\d+);/.exec(live)![1]));
  });
});
