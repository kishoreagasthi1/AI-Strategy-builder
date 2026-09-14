/**
 * One scale, or the arithmetic is meaningless (v5.32.68).
 *
 * The Maturity Targets tab asks a model to weight capability gaps in SCORE
 * POINTS, and then adds those weights to a dimension score produced by an
 * interview. That addition is only meaningful if both numbers were assigned on
 * the same rubric. If the interviewer's scale drifts — a level renamed, a band
 * redefined — and the gap generator keeps prompting with the old wording, the
 * two quietly stop being the same unit and the tab starts producing scores that
 * look precise and mean nothing. Nothing would fail; the numbers would just be
 * wrong.
 *
 * So the scale lives in ONE place, exported from vyne-scoring.js, and this test
 * asserts the interviewer's prompt still carries that exact string. It is a
 * drift alarm, not a style check: if it fires, the two prompts have diverged
 * and someone has to decide which is right before the next release.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dirname, "..", "..", "frontend");
const read = (f: string) => readFileSync(join(FRONTEND, f), "utf8");

/** Pull a single-quoted JS string literal assigned to `name`. */
function literal(src: string, name: string): string {
  const m = new RegExp(`var\\s+${name}\\s*=\\s*\\n?\\s*'([^']*)'`).exec(src);
  if (!m) throw new Error(`could not find ${name} in vyne-scoring.js`);
  return m[1];
}

describe("the scoring scale has exactly one definition (v5.32.68)", () => {
  const scoring = read("vyne-scoring.js");
  const agent = read("interview_agent.html");
  const roadmap = read("roadmap.html");
  /* v5.34.85: the realtime scorer, which this file never covered. */
  const live = read("vyne-live-interview.js");

  it("vyne-scoring.js exports the scale and the benchmark calibration", () => {
    expect(literal(scoring, "SCALE")).toContain("1=Not Started");
    expect(literal(scoring, "SCALE")).toContain("5=Leading/Optimized");
    expect(literal(scoring, "BENCHMARK_CALIBRATION")).toContain("requires deeper evidence");
  });

  it("the INTERVIEWER prompt still uses that exact scale", () => {
    // Both the text path and the realtime path carry it; the interviewer is the
    // origin of every dimension score in the product, so it is the reference.
    const scale = literal(scoring, "SCALE");
    const occurrences = agent.split(scale).length - 1;
    expect(
      occurrences,
      `interview_agent.html no longer contains the scale exported from vyne-scoring.js.\n` +
      `Expected: ${scale}\n` +
      `If the interviewer's scale changed deliberately, update VyneScoring.SCALE to match — ` +
      `the Maturity Targets tab adds model-assigned weights to interview scores and needs both on one rubric.`
    ).toBeGreaterThanOrEqual(1);
  });

  it("the INTERVIEWER prompt still uses that exact benchmark calibration", () => {
    expect(agent).toContain(literal(scoring, "BENCHMARK_CALIBRATION"));
  });

  it("the VOICE scorer reads the scale from the shared module, not a copy", () => {
    /*
     * v5.34.85. This file pinned interview_agent.html and roadmap.html and
     * never looked at vyne-live-interview.js — so the realtime scorer, which
     * now produces most of the product's scores, carried a hand-written copy of
     * the scale and no benchmark calibration at all, free to drift from the
     * definition every other path shares.
     *
     * It is not cosmetic: computeRoundScores averages voice and text interviews
     * into ONE round score. Two rubrics behind one number means the number
     * describes neither.
     */
    expect(live, "the voice scorer does not read VyneScoring.SCALE").toContain("VyneScoring.SCALE");
    expect(live, "the voice scorer does not read the benchmark calibration")
      .toContain("VyneScoring.BENCHMARK_CALIBRATION");
  });

  it("the voice scorer asks for COVERAGE on a follow-up round", () => {
    /*
     * tenant/scoring.ts blends a refresh round against the prior one in
     * proportion to reported coverage, and applyScoreData reads it from
     * scoreData.coverage. The voice prompt had no coverage key, so every voice
     * refresh fell through to the DEFAULT_COVERAGE_WEIGHT fallback regardless
     * of what the conversation actually re-examined — the delta-scoring feature
     * inert on the path that produces most interviews.
     */
    expect(live).toMatch(/state\.isRefreshMode/);
    expect(live).toContain('"coverage"');
    expect(live, "coverage must be explained, or the scorer invents the scale")
      .toMatch(/0 if it never came up/);
  });

  it("the gap generator reads the scale from the shared module, not a copy", () => {
    // A hardcoded duplicate in roadmap.html would pass the assertions above and
    // still drift, so what matters is that it READS the export.
    expect(roadmap).toContain("VyneScoring.SCALE");
    expect(roadmap).toContain("VyneScoring.BENCHMARK_CALIBRATION");
    // And that it does not carry its own copy of the wording.
    const scale = literal(scoring, "SCALE");
    expect(
      roadmap.includes(scale),
      "roadmap.html hardcodes the scale text instead of using VyneScoring.SCALE"
    ).toBe(false);
  });
});
