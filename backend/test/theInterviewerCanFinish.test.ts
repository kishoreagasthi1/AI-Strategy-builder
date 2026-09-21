/**
 * Resuming, and finishing. (v5.34.121)
 *
 * ── Six symptoms from one resumed interview, 2026-09-18 ─────────────────────
 *
 *   "The clock seemed to start from zero and not where we left off last time
 *    though the previous text was there."
 *   "Even after finish and submission, the clock continues and does not exit me
 *    from the screen."
 *   "And again it started speaking to me after sometime the screen was open."
 *   "Also the progress bar was at 18% after completing the interview."
 *
 * and, in the transcript he pasted, two he did not name: every restored message
 * appearing TWICE, and the closing line ending
 *
 *   "...Thank you so much for your time, Avery.I'm sorry, I missed that last
 *    part, could you tell me one more time?"
 *
 * Four defects.
 *
 * ── D1: the replay appended a second copy of the whole transcript ───────────
 *
 * launchInterviewScreen replayed with S.displayMessages.forEach(m =>
 * addMessage(...)), and addMessage's last line pushes into S.displayMessages.
 * One resume doubles it; two quadruple it.
 *
 * This is the v5.32.54 findings bug, unfixed for the transcript — and the
 * comment describing that fix sits nine lines below the line that still had it.
 * Worth naming plainly: the fix was known, written down, and not applied to the
 * thing next to it.
 *
 * Not cosmetic. On the voice path the submitted record, the archive and the
 * scoring pass are all built from S.displayMessages, so the firm received every
 * answer twice, conversationTurns was double, and buildLiveContext spent half
 * of a 15,000-character budget on repeats — truncating real material to make
 * room for duplicates.
 *
 * ── D2: replayed messages were stamped with the resume time ────────────────
 *
 * addMessage computed its own timestamp and ignored the stored one, so a
 * two-day-old first half all read 07:22.
 *
 * ── D3: elapsed time was never persisted ───────────────────────────────────
 *
 * It was in no blob, so the clock could only start at zero. elapsedMin is
 * minted into the interviewer's instruction, so a resumed interview told the
 * persona it was three minutes into a deep dive when it was twenty-five.
 *
 * ── D4: questionsAsked was assigned from a model's estimate ────────────────
 *
 * `S.questionsAsked = scoreData.questionsAsked` — not incremented, assigned,
 * from whatever the scoring model counted in the window it saw. The second
 * sitting's nine overwrote the first sitting's, and 9/50 is 18%.
 *
 * ── D5: nothing noticed the interviewer saying goodbye ─────────────────────
 *
 * There was no close detection on the page and no onInterviewClosed from the
 * live layer — grep for onClosed, closingDetected, interviewClosed, farewell,
 * goodbye returned nothing at all. So the clock ran on, the room stayed open,
 * the session stayed live, and ten minutes later the goAway handover fired and
 * appended its recovery nudge to the closing line. The harness has had a
 * closing detector since v5.34.77; the product it tests never got one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const page = readFileSync(join(root, "frontend", "interview_agent.html"), "utf8");
const live = readFileSync(join(root, "frontend", "vyne-live-interview.js"), "utf8");
const rig = readFileSync(join(root, "deploy", "voice-record.mjs"), "utf8");

/** Lift one top-level function's source out of the page. */
function fnSrc(src: string, name: string): string {
  const i = src.indexOf(`function ${name}(`);
  expect(i, `function ${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(i);
  const next = rest.slice(1).search(/\n(?:async )?function [A-Za-z_]/);
  return next > 0 ? rest.slice(0, next + 1) : rest;
}

describe("v5.34.121 — the page's JavaScript parses", () => {
  it("every inline script block is syntactically valid", () => {
    /*
     * Forty-four test files read this page, all of them as TEXT. None parsed
     * it, so a syntax error anywhere in six thousand lines would have shipped
     * with a green suite — and this change edits four separate places in it.
     * Cheap, and it closes the widest hole in this file's coverage.
     */
    const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m: RegExpExecArray | null, blocks = 0;
    while ((m = re.exec(page))) {
      const src = m[1];
      if (!src.trim()) continue;
      blocks++;
      expect(() => new Function(src), `inline script block at offset ${m!.index} does not parse`).not.toThrow();
    }
    expect(blocks, "no inline script blocks found — the extraction is wrong, not the page").toBeGreaterThan(0);
  });
});

describe("v5.34.121 — a resume draws the history without re-storing it", () => {
  it("the replay passes replay:true and iterates a snapshot", () => {
    const m = /S\.displayMessages\.slice\(\)\.forEach\(m=>\{[\s\S]{0,400}?\}\);/.exec(page);
    expect(m, "the resume replay is gone or no longer iterates a snapshot").toBeTruthy();
    expect(m![0]).toMatch(/replay:true/);
  });

  it("addMessage returns before storing when replaying", () => {
    /*
     * The guard has to sit BEFORE the push and AFTER the DOM append, or it
     * either stores anyway or draws nothing. Asserted by position, because both
     * mistakes leave a `replay` flag in the source and would satisfy a
     * presence-only check.
     */
    const i = page.indexOf("function addMessage(");
    const body = page.slice(i, i + 8000);
    const guard = body.indexOf("if(replay) return;");
    const push = body.indexOf("S.displayMessages.push(");
    const append = body.indexOf("wrap.appendChild");
    expect(guard, "the replay guard is gone").toBeGreaterThan(-1);
    expect(push, "the store is gone").toBeGreaterThan(-1);
    expect(guard, "the guard is after the push — the duplicate is still stored").toBeLessThan(push);
    if (append > -1) expect(guard, "the guard is before the bubble is drawn — a replay would render nothing").toBeGreaterThan(append);
  });

  it("the replayed message keeps its own timestamp", () => {
    const i = page.indexOf("function addMessage(");
    expect(page.slice(i, i + 8000)).toMatch(/const timestamp=extra\.timestamp\|\|new Date\(\)/);
    const m = /S\.displayMessages\.slice\(\)\.forEach\(m=>\{[\s\S]{0,400}?\}\);/.exec(page)!;
    expect(m[0], "the stored timestamp is not passed through").toMatch(/timestamp:m\.timestamp/);
  });

  it("the findings replay that this copies is still correct", () => {
    // v5.32.54. If that one ever regresses the same way, this file should say so.
    expect(page).toMatch(/S\.findings\.slice\(\)\.forEach\(function\(f\)\{ renderFinding\(f\); \}\);/);
  });
});

describe("v5.34.121 — the clock survives a resume", () => {
  it("elapsed time is written into the saved session", () => {
    expect(page).toMatch(/elapsedMs:\(function\(\)\{ try\{ return clockElapsedMs\(\)/);
  });

  /**
   * The real clock, lifted and run.
   *
   * A source assertion that `IV_CLOCK.adopted` appears is not enough: changing
   * the guard to `if(true)` passed it, and that mutation is the actual bug —
   * accumulated is ALSO the pause total, so re-adopting on each unpause adds
   * the whole prior sitting again every time. Three coffee breaks would report
   * four times the length. This executes the page's own functions instead.
   */
  function clock(priorMs: number) {
    const src = [
      /^var IV_CLOCK = .*?;$/m.exec(page)![0],
      fnSrc(page, "clockElapsedMs"),
      fnSrc(page, "renderClock"),
      fnSrc(page, "startClock"),
      fnSrc(page, "stopClock"),
    ].join("\n");
    // eslint-disable-next-line no-new-func
    const mk = new Function("S", "document", "VL", "setInterval", "clearInterval", `
      ${src}
      return { startClock, stopClock, elapsed: clockElapsedMs, IV_CLOCK };`);
    return mk({ elapsedMs: priorMs }, { getElementById: () => null }, () => {}, () => 1, () => {}) as
      { startClock: () => void; stopClock: () => void; elapsed: () => number; IV_CLOCK: Record<string, number> };
  }

  it("a fresh interview starts at zero", () => {
    const c = clock(0);
    c.startClock();
    expect(c.elapsed()).toBeLessThan(50);
  });

  it("a resumed interview starts from the prior elapsed", () => {
    const c = clock(600000);   // ten minutes in the first sitting
    c.startClock();
    expect(c.elapsed()).toBeGreaterThanOrEqual(600000);
    expect(c.elapsed()).toBeLessThan(600500);
  });

  it("pausing and resuming does NOT re-adopt the prior sitting", () => {
    /*
     * M97. The clock is stopped and started on every pause (setInterviewPaused
     * calls stopClock/startClock), so this path runs many times per interview.
     */
    const c = clock(600000);
    c.startClock();
    c.stopClock();
    c.startClock();
    c.stopClock();
    c.startClock();
    expect(c.elapsed(), "the prior sitting was counted more than once").toBeLessThan(601000);
  });

  it("time accumulated in this sitting is kept across a pause", () => {
    const c = clock(600000);
    c.startClock();
    c.IV_CLOCK.startedAt -= 30000;   // thirty seconds of talking
    c.stopClock();
    expect(c.elapsed()).toBeGreaterThanOrEqual(630000);
    c.startClock();
    expect(c.elapsed()).toBeGreaterThanOrEqual(630000);
    expect(c.elapsed()).toBeLessThan(631000);
  });

  it("stopClock still banks the running segment", () => {
    // The adoption must not have disturbed the pause accounting it shares.
    const i = page.indexOf("function stopClock(");
    expect(page.slice(i, i + 300)).toMatch(/IV_CLOCK\.accumulated \+= Date\.now\(\) - IV_CLOCK\.startedAt/);
  });
});

describe("v5.34.121 — the progress bar cannot go backwards", () => {
  it("questionsAsked is raised, never assigned downward", () => {
    expect(page).toMatch(/S\.questionsAsked=Math\.max\(S\.questionsAsked\|\|0,scoreData\.questionsAsked\)/);
    expect(page, "the bare assignment is still there somewhere")
      .not.toMatch(/if\(scoreData\.questionsAsked\)S\.questionsAsked=scoreData\.questionsAsked;/);
  });

  it("the bar is still drawn from it", () => {
    expect(page).toMatch(/const pct=Math\.min\(100,Math\.round\(\(S\.questionsAsked\/total\)\*100\)\)/);
  });
});

describe("v5.34.121 — the interviewer can finish the interview", () => {
  it("the live layer detects a close and tells the page once", () => {
    expect(live).toMatch(/LiveInterview\.prototype\._checkInterviewerClosed = function/);
    expect(live).toMatch(/if \(this\._closedByAgent \|\| this\.stopped\) return;/);
    expect(live).toMatch(/this\._closedByAgent = true;/);
    expect(live).toMatch(/opts\.onInterviewClosed/);
  });

  it("it is checked after the turn is banked and before scoring", () => {
    /*
     * Before _flushPending the closing line is not in turns[] yet, so the check
     * sees the previous turn. After _score the page would tear the session down
     * underneath a scoring pass in flight.
     */
    const i = live.indexOf("onTurnComplete: function () {");
    const body = live.slice(i, i + 700);
    const flush = body.indexOf("self._flushPending();");
    const check = body.indexOf("self._checkInterviewerClosed();");
    const score = body.indexOf("self._score();");
    expect(flush).toBeGreaterThan(-1);
    expect(check, "the close check is gone").toBeGreaterThan(flush);
    expect(check, "the close check runs after scoring").toBeLessThan(score);
  });

  it("an interview cannot close before it has started", () => {
    /*
     * The 2026-09-14 harness run ended at ELEVEN SECONDS because "thanks for
     * taking the time" is also a greeting. Tightening the pattern is the wrong
     * fix — every closing wording appears in pleasantries — so the guard is
     * structural and counts ANSWERED turns, not all turns: an interviewer's
     * greeting and its follow-up are one-sided.
     */
    expect(live).toMatch(/MIN_TURNS_BEFORE_CLOSE/);
    const i = live.indexOf("_checkInterviewerClosed = function");
    const body = live.slice(i, i + 1400);
    expect(body).toMatch(/if \(this\.turns\[i\]\.who === 'You'\) answered\+\+;/);
    expect(body).toMatch(/if \(answered < MIN_TURNS_BEFORE_CLOSE\)/);
  });

  it("the closing pattern matches the real closing line and not the real greeting", () => {
    const m = /var CLOSING_RE = new RegExp\(\[([\s\S]*?)\]\.join\('\|'\)\);/.exec(live);
    expect(m, "CLOSING_RE moved — update this test").toBeTruthy();
    // eslint-disable-next-line no-new-func
    const re = new Function(`return new RegExp([${m![1]}].join("|"));`)() as RegExp;

    // The 2026-09-18 close, and the 2026-09-14 one that defeated a contiguous pattern.
    expect(re.test("we've covered a lot of ground today. thank you so much for your time, avery.")).toBe(true);
    expect(re.test("i think i've covered everything i came for. thanks again for your time, alex. take care.")).toBe(true);
    expect(re.test("that concludes our interview.")).toBe(true);
    // The greeting that ended a run at eleven seconds. It MATCHES — which is
    // the point: the regex cannot separate these, only the turn count can.
    expect(re.test("hello, alex. i'm jack smith. thanks for taking the time today.")).toBe(true);
    // Ordinary mid-interview turns must not match at all.
    expect(re.test("got it. where does your data sit right now?")).toBe(false);
    expect(re.test("that's helpful, thank you. who owns that vision?")).toBe(false);
  });

  it("the duplicated pattern agrees with the harness's", () => {
    /*
     * Copied from deploy/voice-record.mjs rather than shared: the rig is a node
     * script and this is a browser file. A constant copied into two files is
     * this project's most reliable source of defects, so parity is asserted
     * rather than trusted — same call as GOAWAY_HANDOVER_COST_MS.
     */
    /*
     * Compared as EVALUATED patterns, not as text. The first cut normalised the
     * source strings and failed on `\'ve` versus String.raw`'ve` — two
     * spellings of the same character, in files that quote differently by
     * necessity. A parity test that fires on quoting style is a parity test
     * nobody will keep.
     */
    const a = /var CLOSING_RE = new RegExp\(\[([\s\S]*?)\]\.join\('\|'\)\);/.exec(live);
    const b = /const CLOSING_RE = new RegExp\(\[([\s\S]*?)\]\.join\("\|"\)\);/.exec(rig);
    expect(a, "CLOSING_RE moved in vyne-live-interview.js").toBeTruthy();
    expect(b, "CLOSING_RE moved in voice-record.mjs").toBeTruthy();
    // eslint-disable-next-line no-new-func
    const build = (parts: string) => (new Function(`return new RegExp([${parts}].join("|"));`)() as RegExp).source;
    expect(build(a![1]), "the page and the harness disagree about what closing looks like").toBe(build(b![1]));
  });

  it("the page stops the clock and the session, and scores BEFORE stopping", () => {
    /*
     * v5.32.55: stop() sets `stopped`, which suppresses further scoring and
     * discards a pass in flight. The closing exchange is where a stakeholder
     * often says the thing that matters, so it is scored first.
     */
    const i = page.indexOf("onInterviewClosed: function(text){");
    expect(i, "the page no longer handles a closed interview").toBeGreaterThan(-1);
    const body = page.slice(i, i + 1200);
    expect(body).toMatch(/stopClock\(\)/);
    const score = body.indexOf("finalScore");
    const stop = body.indexOf("LIVE.stop(");
    expect(score, "the closing exchange is no longer scored").toBeGreaterThan(-1);
    expect(score, "the session is stopped before the last exchange is scored").toBeLessThan(stop);
    expect(body).toMatch(/interview_closed_by_agent/);
  });

  it("it does NOT submit or navigate on its own", () => {
    /*
     * The chosen behaviour: stop the room, leave the decision. An automatic
     * jump to the export screen takes the room away from an interviewee with
     * one more thing to say, and submission is irreversible.
     */
    const i = page.indexOf("onInterviewClosed: function(text){");
    const body = page.slice(i, i + 1200);
    expect(body, "the close handler submits by itself").not.toMatch(/finishInterview\(/);
    expect(body, "the close handler navigates by itself").not.toMatch(/export-screen/);
  });

  it("it tells the interviewee, without an innerHTML sink", () => {
    // indirectHtmlSinks.test.ts ratchets the unresolvable innerHTML count in
    // this file. A ratchet is only worth having if new code is held to it.
    const i = page.indexOf("function showInterviewFinishedBanner(");
    expect(i, "nothing tells the interviewee the room is closed").toBeGreaterThan(-1);
    const body = page.slice(i, i + 1400);
    expect(body).toMatch(/textContent/);
    expect(body, "the banner uses innerHTML").not.toMatch(/innerHTML/);
    expect(body, "the banner can be appended twice").toMatch(/if\(document\.getElementById\('iv-finished-banner'\)\) return;/);
  });
});
