/**
 * v5.32.28 — two things a client would have noticed before we did.
 *
 * 1. The governance package called hardware a protected class. The prompt's
 *    JSON schema hardcoded `fairness.protectedConcerns`, so the model filled it
 *    whether or not a person was anywhere near the system. On an automotive
 *    vECU test-generation pipeline that produced "protected-class concerns"
 *    about legacy hardware variants and vehicle trim configurations. The
 *    concerns themselves were real — coverage is genuinely uneven across
 *    variants — but "protected class" is a legal term about people, and the
 *    functional safety managers and compliance lawyers this document is written
 *    for know exactly what it means. Misusing it costs the whole package its
 *    credibility, including the parts that were right.
 *
 * 2. The Word report was being built and then effectively hidden. It surfaced
 *    only as a small pill in the top bar, and both the card title and the
 *    placeholder said the run would "produce the Word report" without saying
 *    where it appeared. The reasonable conclusion — and the one the user
 *    reached — is that no report was produced.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FE = (p: string) => readFileSync(join(__dirname, "..", "..", "frontend", p), "utf8");

const DESIGN = FE("solution_design.html");
const SYNTH = FE("synthesis.html");

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = Record<string, any>;

/** Extract fairnessHeadings() and run it for real. */
function headings(): (f: Any) => Any {
  const i = DESIGN.indexOf("function fairnessHeadings(f){");
  expect(i, "fairnessHeadings not found").toBeGreaterThan(-1);
  const j = DESIGN.indexOf("\n}\n", i);
  const ctx: Any = {};
  vm.createContext(ctx);
  vm.runInContext(DESIGN.slice(i, j + 3), ctx);
  return ctx.fairnessHeadings;
}

describe("the governance fairness section knows what it is talking about (v5.32.28)", () => {
  const fh = headings();

  it("a people-affecting system still gets the fairness and protected-class framing", () => {
    const r = fh({ subject: "people", concerns: ["a"], metrics: [], methods: [] });
    expect(r.human).toBe(true);
    expect(r.section).toContain("Fairness");
    expect(r.concernsLabel).toBe("Protected-class concerns");
    expect(r.metricsLabel).toBe("Fairness metrics");
  });

  it("a non-human system is relabelled as coverage, and never says protected class", () => {
    const r = fh({ subject: "non-human", concerns: ["legacy vECU variants"] });
    expect(r.human).toBe(false);
    expect(r.section).toContain("Coverage");
    expect(r.concernsLabel).toBe("Coverage concerns");
    expect(r.metricsLabel).toBe("Coverage metrics");
    expect(JSON.stringify(r).toLowerCase()).not.toContain("protected");
  });

  it("a package generated before this release renders exactly as it did", () => {
    // Re-labelling saved client artifacts retroactively would be worse than
    // leaving them alone — the consultant can regenerate for the new framing.
    const legacy = fh({ protectedConcerns: ["x", "y"] });
    expect(legacy.human).toBe(true);
    expect(legacy.section).toContain("Fairness");
    expect(legacy.concerns).toEqual(["x", "y"]);
  });

  it("reads concerns from either the new or the old field name", () => {
    expect(fh({ subject: "non-human", concerns: ["new"] }).concerns).toEqual(["new"]);
    expect(fh({ subject: "people", protectedConcerns: ["old"] }).concerns).toEqual(["old"]);
    expect(fh({ subject: "people" }).concerns).toBeNull();
  });

  it("the prompt makes the model classify the subject before writing the section", () => {
    expect(DESIGN).toContain('"fairness":{"subject":"people|non-human"');
    expect(DESIGN).toContain("FAIRNESS SECTION — decide this before you write it.");
    expect(DESIGN).toContain('never use the phrase at all when subject is "non-human"');
    // The old schema forced the people framing regardless.
    expect(DESIGN).not.toContain('"fairness":{"protectedConcerns":["..."]');
  });

  it("the section is still always produced — uneven coverage is a real risk", () => {
    // The fix is re-labelling, not deletion. Dropping the section for
    // non-human systems would lose a genuine finding.
    expect(DESIGN).toContain("Do not skip the section either way");
  });

  it("the client-facing export uses the same vocabulary as the screen", () => {
    // This is the copy that actually reaches the client, so it matters more
    // here, not less. Both call sites go through fairnessHeadings().
    expect((DESIGN.match(/fairnessHeadings\(/g) || []).length).toBe(3); // 1 def + 2 call sites
    expect(DESIGN).not.toContain("<h3 class=\"subpart\">Fairness — protected-class concerns</h3><ul>'+g.fairness.protectedConcerns");
  });
});

describe("the Word report is findable (v5.32.28)", () => {
  it("there is a download link under the summary, not just a pill in the top bar", () => {
    expect(SYNTH).toContain('<div id="report-result"');
    expect(SYNTH).toContain("Download the Word report");
    expect(SYNTH).toContain("var rr=document.getElementById('report-result');");
  });

  it("the copy says where the report lands and that it is not auto-saved", () => {
    expect(SYNTH).toContain("puts a download link right under it");
    expect(SYNTH).toContain("it is not saved automatically");
    // The old copy promised a report and never said where it went.
    expect(SYNTH).not.toContain("automatically produce the Word report.</div>");
  });

  it("a build failure is stated inline, not only in a toast that disappears", () => {
    expect(SYNTH).toContain("The Word report could not be built");
    expect(SYNTH).toContain("The synthesis above is unaffected; re-run to try again.");
  });

  it("a stale link from a previous run is cleared when a new run starts", () => {
    expect(SYNTH).toContain("Building the Word report…");
  });

  it("the top-bar pill draws the eye when the report appears", () => {
    expect(SYNTH).toContain("@keyframes reportPulse");
    expect(SYNTH).toContain("openBtn.style.animation='reportPulse 1.6s ease-in-out 3'");
  });

  it("the filename is escaped before it reaches innerHTML", () => {
    // It is built from engagement.client, which is consultant-entered.
    expect(SYNTH).toContain('download="\'+esc(filename)+\'"');
  });

  it("the dead generateReport() is gone along with its orphaned helper", () => {
    // It referenced #btn-report and a progress bar that are not in the markup,
    // so it threw on its first line; and on the happy path it awaited
    // buildReport() and discarded the ArrayBuffer without offering a download.
    expect(SYNTH).not.toContain("function generateReport(){");
    expect(SYNTH).not.toContain("function hideReportProgress(){");
    expect(SYNTH).not.toContain("btn.textContent='Generate Word Report';");
    // The live path is untouched.
    expect(SYNTH).toContain("var buf=await buildReport(synthesisText);");
  });

  it("nothing else still calls the removed functions", () => {
    // Assert on CODE, not on the file text: the replacement comments name both
    // functions while explaining why they went, and a bare toContain would
    // match its own tombstone.
    const code = SYNTH.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).not.toContain("generateReport(");
    expect(code).not.toContain("hideReportProgress(");
  });
});
