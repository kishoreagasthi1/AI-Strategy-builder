/**
 * The recovery feature actually recovers something. (v5.34.94)
 *
 * ── What it did ─────────────────────────────────────────────────────────────
 *
 * restoreScoresToSynthesis() exists to salvage an interview that would
 * otherwise be lost. It rebuilt S from the archived record, called
 * saveSession(), and reported:
 *
 *     "✓ Restored … into storage. Open the Synthesis Dashboard and load this
 *      client to see the scores."
 *
 * saveSession() writes `vynora_session_<id>`. Synthesis scores from
 * `vynora_engagement_<code>`; the only place it touches a session key is the
 * client-scoped DELETE predicate (synthesis.html:3325). So the restore wrote to
 * a key nothing reads, declared success, and changed nothing the consultant
 * could see. The one path whose entire job is not losing an interview lost it
 * and said it hadn't.
 *
 * ── And the fields the archive never carried ────────────────────────────────
 *
 * restoreScoresToSynthesis reads rec.refreshRound, rec.refreshScope and
 * rec.refreshQuestionBudget. recoverRecord wrote none of them — it wrote
 * `isRefreshMode` and stopped. Every one of those reads therefore took its `||`
 * fallback, and a recovered FOLLOW-UP came back as isRefreshMode:true with
 * refreshRound:null.
 *
 * writeInterviewToEngagement() routes a refresh with no round number into the
 * CURRENT round, where the by-role upsert replaces that role's existing
 * interview. So the moment the write was connected, a well-meant recovery of a
 * round-2 follow-up would have deleted the round-1 baseline it was measured
 * against. Connecting the write without carrying the fields would have turned a
 * silent no-op into silent data loss — which is why both halves are one change.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const page = readFileSync(join(root, "frontend", "interview_agent.html"), "utf8");
const synth = readFileSync(join(root, "frontend", "synthesis.html"), "utf8");
const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function fnBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  expect(at, `${name}() is gone — update this test`).toBeGreaterThan(-1);
  const next = src.indexOf("\nfunction ", at + 1);
  return src.slice(at, next === -1 ? src.length : next);
}

/** The recoverRecord object literal, which is what archiveInterview persists. */
function recoverRecordLiteral(): string {
  const at = code.indexOf("var recoverRecord = {");
  expect(at, "recoverRecord moved — update this test").toBeGreaterThan(-1);
  const end = code.indexOf("\n  };", at);
  expect(end).toBeGreaterThan(at);
  return code.slice(at, end);
}

describe("v5.34.94 — the restore reaches the place Synthesis actually reads", () => {
  it("Synthesis does NOT score from session blobs — the premise of the bug", () => {
    /*
     * Pinned so this test stays honest if that ever changes. If Synthesis
     * starts reading vynora_session_*, the fix below becomes unnecessary rather
     * than wrong, and this assertion is where that gets noticed.
     */
    const uses = [...synth.matchAll(/vynora_session_/g)];
    expect(uses.length, "synthesis.html's use of session keys changed — re-check whether the restore still needs the engagement write")
      .toBe(1);
    const at = synth.indexOf("vynora_session_");
    const around = synth.slice(at - 400, at + 300);
    expect(around, "the one use should still be the client-scoped delete predicate")
      .toMatch(/nrmClient|SHARED_INDEX_KEYS/);
  });

  it("restoreScoresToSynthesis writes the ENGAGEMENT record, not only the session", () => {
    const body = fnBody(code, "restoreScoresToSynthesis");
    expect(body, "the restore still only calls saveSession(), so Synthesis will never see it")
      .toMatch(/writeInterviewToEngagement\(\)/);
    expect(body, "saveSession must still run too — the session blob is what a resume reads")
      .toMatch(/saveSession\(\)/);
  });

  it("and it does not claim success when the engagement write failed", () => {
    /*
     * The original bug was a success message for work that had not happened.
     * Replacing it with a success message for work that THREW would be the same
     * defect with extra steps.
     */
    const body = fnBody(code, "restoreScoresToSynthesis");
    expect(body).toMatch(/wrote\s*=\s*true/);
    expect(body).toMatch(/setRecoverStatus\(wrote/);
    expect(body, "the failure branch must say the dashboard will not show it")
      .toMatch(/will not show it/);
  });
});

describe("v5.34.94 — the archive carries what the restore reads", () => {
  const lit = recoverRecordLiteral();
  const restore = fnBody(code, "restoreScoresToSynthesis");

  it("every field the restore reads off the record is written into it", () => {
    /*
     * The generic form, so the next added field is caught rather than noticed.
     * Any `rec.X` in restoreScoresToSynthesis must appear as a key of the
     * recoverRecord literal.
     */
    const read = [...new Set([...restore.matchAll(/\brec\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
    expect(read.length, "found no rec.X reads — the parser is broken").toBeGreaterThan(5);
    const written = new Set([...lit.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
    const missing = read.filter((f) => !written.has(f));
    expect(
      missing,
      "restoreScoresToSynthesis reads these off the archived record and recoverRecord never " +
      "writes them, so each one silently takes its || fallback on every restore.",
    ).toEqual([]);
  });

  it("the refresh fields specifically — losing refreshRound destroys a baseline", () => {
    for (const f of ["refreshRound", "refreshScope", "refreshQuestionBudget", "coverage"]) {
      expect(lit, `recoverRecord does not carry ${f}`).toMatch(new RegExp(`${f}\\s*:`));
    }
  });

  it("and dimTiers, or a recovered interview un-weights its whole round", () => {
    // dimensionWeights() is all-or-nothing per round (v5.34.92), so one
    // recovered interview without tiering reverts that engagement's overall to
    // the plain mean.
    expect(lit).toMatch(/dimTiers\s*:/);
  });

  it("a pre-v5.34.94 refresh record is REFUSED, not guessed at", () => {
    /*
     * The dangerous case, and the reason this is a refusal rather than a
     * default. An older archive says isRefreshMode:true and cannot say which
     * round. Routing that into the current round is precisely the data loss
     * described at the top of this file, so the restore stops and says why.
     */
    const body = fnBody(code, "restoreScoresToSynthesis");
    expect(body).toMatch(/if\(!S\.refreshRound\)\{/);
    expect(body, "it must explain WHY it is refusing, not just fail")
      .toMatch(/could overwrite the original/);
    expect(body, "the refusal must return before the engagement write")
      .toMatch(/return;/);
    const guardAt = body.indexOf("if(!S.refreshRound){");
    const writeAt = body.indexOf("writeInterviewToEngagement()");
    expect(guardAt, "the guard runs after the write — it would refuse only after doing the damage")
      .toBeLessThan(writeAt);
  });

  it("the snapshot is preferred over re-deriving the tiering", () => {
    /*
     * writeInterviewToEngagement() normally resolves dimTiers live. On a
     * recovery that would re-derive from a Pre-Engagement that may have been
     * re-tiered since, restating an interview conducted under the old tiering.
     */
    const body = fnBody(code, "writeInterviewToEngagement");
    expect(body).toMatch(/S\.dimTiers \|\| dimensionTierMap\(\)/);
  });
});
