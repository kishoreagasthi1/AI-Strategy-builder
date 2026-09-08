/**
 * v5.32.16 — removes a cluster of hard-coded display/generation caps across
 * the Synthesis Dashboard and the AI Strategy Deck exporter that were
 * silently dropping real client data once an engagement had "enough" of
 * something (findings, blind spots, recommendations, selected initiatives,
 * shared capability gaps...).
 *
 * Two different kinds of cap existed and both needed fixing:
 *
 *  1. DISPLAY caps — the data existed but only the first N were ever shown
 *     (synthesis.html's findings lists hard-capped at 3; the deck's
 *     Value Framework table hard-capped at 13 initiatives; Maturity
 *     Fingerprint always dropped exactly 1 of the 7 VYNE dimensions).
 *  2. GENERATION caps — the AI prompt itself was instructed to cap how much
 *     content it produced in the first place (synthesis.html's "Run AI
 *     Synthesis" prompt: "blindSpots... Max 3", "sequencedRecommendations:
 *     max 4", etc; roadmap.html's narrative-synthesis prompt only fed the
 *     AI the first 12 of potentially many shared capability gaps).
 *
 * Fixing (1) without fixing (2) would have left the deck/dashboard capable
 * of showing more, with nothing more to show. Both are covered below.
 *
 * There's no frontend test runner in this repo (static HTML+JS pages, no
 * bundler — see frontendXssGuards.test.ts / roleCanon.test.ts for the same
 * pattern), so this is a static source-text regression guard from the
 * backend's vitest suite, matching roadmapUseCaseAdd.test.ts /
 * synthesisPersistence.test.ts / confirmedFindingsFormatting.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dirname, "..", "..", "frontend");

function readSynthesis(): string {
  return readFileSync(join(FRONTEND, "synthesis.html"), "utf8");
}
function readRoadmap(): string {
  return readFileSync(join(FRONTEND, "roadmap.html"), "utf8");
}

describe("synthesis.html — findings lists paginate instead of hard-capping at 3 (v5.32.16)", () => {
  it("defines a reusable paginated-findings renderer with a 3-per-batch 'show more' pattern", () => {
    const src = readSynthesis();
    expect(src).toContain("function renderFindingsPaginated(items, textFn, itemClass){");
    expect(src).toContain("function revealMoreFindings(containerId){");
    expect(src).toContain("var chunkSize=3;");
  });

  it("the conflict-drilldown vs-card findings list is no longer sliced to 3", () => {
    const src = readSynthesis();
    // Check the actual statement, not just the bare fragment — this file's own explanatory
    // comments above the fix legitimately mention "entry.findings.slice(0,3)" in prose while
    // describing what was removed, so a bare-fragment check would false-fail against itself.
    expect(src).not.toContain("const findings=entry.findings.slice(0,3);");
    expect(src).toContain("const findings=entry.findings;");
    expect(src).toContain("renderFindingsPaginated(findings, f=>f.text, 'vs-finding')");
  });

  it("the per-role dimension-drilldown findings list is no longer sliced to 3", () => {
    const src = readSynthesis();
    expect(src).not.toContain("e.findings.slice(0,3).map(f=>");
    expect(src).toContain("renderFindingsPaginated(e.findings, f=>f.text, 'role-finding-item')");
  });

  it("has CSS for the 'show more' button so it doesn't render unstyled", () => {
    const src = readSynthesis();
    expect(src).toContain(".findings-more-btn{");
  });
});

describe("synthesis.html — 'Run AI Synthesis' prompt no longer caps how much the AI generates (v5.32.16)", () => {
  it("removes the hard count caps on blindSpots / maturityFingerprint / sequencedRecommendations / strategicImplications", () => {
    const src = readSynthesis();
    expect(src).not.toContain("blindSpots: topics important for this industry that NO interviewee addressed. Max 3.");
    expect(src).not.toContain("Max 2 strengths, max 3 criticalGaps.");
    expect(src).not.toContain("sequencedRecommendations: max 4.");
    expect(src).not.toContain("strategicImplications: max 3.");
  });

  it("no longer hardcodes 'insurance' industry norms regardless of the actual client industry", () => {
    const src = readSynthesis();
    expect(src).not.toContain("compare explicitly to insurance industry norms");
    expect(src).toContain("compare explicitly to '+engagement.industry+' industry norms");
  });

  it("raises max_tokens so the now-uncapped JSON response has room to avoid truncation", () => {
    const src = readSynthesis();
    expect(src).not.toContain("max_tokens:3500,messages:[{role:'user',content:prompt}]}),\n      signal:synthCtrl.signal");
    expect(src).toContain("max_tokens:6500,messages:[{role:'user',content:prompt}]}),\n      signal:synthCtrl.signal");
  });
});

describe("roadmap.html — narrative synthesis prompt no longer truncates shared gaps at 12 (v5.32.16)", () => {
  it("removes the sharedGaps.slice(0,12) cap in buildNarrativePrompt", () => {
    const src = readRoadmap();
    // Full statement, not the bare fragment — the fix's own comment legitimately mentions
    // "ctx.sharedGaps.slice(0,12)" in prose while explaining what was removed.
    expect(src).not.toContain("var sharedStr = ctx.sharedGaps.slice(0,12).map(function(g){");
    // v5.32.23: still uncapped, but now fitted rather than concatenated —
    // this block is O(gaps x initiatives) because each gap line also lists
    // every initiative it blocks, so on a large engagement it was the single
    // biggest prompt in the app. Overflow is summarised in, never dropped.
    expect(src).toContain("var _gapFit = await vyneFit(ctx.sharedGaps, function(g){");
    expect(src).toContain("var sharedStr = _gapFit.text;");
  });
});

describe("roadmap.html — AI Strategy Deck: tables paginate instead of silently dropping rows (v5.32.16)", () => {
  it("defines a generic paginated-table-slides helper", () => {
    const src = readRoadmap();
    expect(src).toContain("function addPaginatedTableSlides(kicker, baseTitle, headerRow, bodyRows, colW, opts){");
  });

  it("Value Framework no longer hard-caps at the first 13 initiatives", () => {
    const src = readRoadmap();
    // Full statement, not the bare fragment — the helper's own doc comment legitimately
    // mentions "inits.slice(0,13)" in prose as an example of the pattern being replaced.
    expect(src).not.toContain("inits.slice(0,13).forEach(function(it,i){");
    expect(src).toContain("addPaginatedTableSlides('Section 7 · Value & Architecture','Value Framework',");
  });

  it("Confirmed Findings, Blind Spots, Strategic Implications, Quick Wins, Foundation Investments, and Synthesis Priorities all route through the paginated helper", () => {
    const src = readRoadmap();
    const expectedTitles = [
      "Confirmed Findings",
      "Blind Spots",
      "Strategic Implications",
      "Quick Wins — Phase 1 Ready",
      "Foundation Investments",
      "Synthesis Priorities",
    ];
    expectedTitles.forEach((title) => {
      expect(src).toContain(`addPaginatedTableSlides(`);
    });
    // spot-check a couple of the actual call sites by title string, not just the helper name
    expect(src).toContain("'Confirmed Findings',");
    expect(src).toContain("'Blind Spots',");
    expect(src).toContain("'Strategic Implications',");
    expect(src).toContain("'Quick Wins — Phase 1 Ready',");
    expect(src).toContain("'Foundation Investments',");
    expect(src).toContain("'Synthesis Priorities',");
  });

  it("Blind Spots and Strategic Implications no longer use the old shrink-to-fit-one-slide row height formula", () => {
    const src = readRoadmap();
    expect(src).not.toContain("Math.min(1.0, Math.max(0.65,(DK.H-1.0-contentTop())/rows.length))");
    expect(src).not.toContain("Math.min(1.0, Math.max(0.7,(DK.H-1.0-contentTop())/rows.length))");
  });
});

describe("roadmap.html — Maturity Fingerprint shows all 7 VYNE dimensions, not a fixed 3-and-3 split (v5.32.16)", () => {
  it("splits the ranked dimension list at its midpoint instead of slicing to exactly 3 per side", () => {
    const src = readRoadmap();
    expect(src).not.toContain("var strengths=sorted.slice(0,3), gaps=sorted.slice(-3).reverse();");
    expect(src).toContain("var splitAt=Math.ceil(sorted.length/2);");
    expect(src).toContain("var strengths=sorted.slice(0,splitAt), gaps=sorted.slice(splitAt).reverse();");
  });
});

describe("roadmap.html — AI Strategy Deck now includes the Executive Narrative (v5.32.16)", () => {
  it("the 600-800 word AI-generated narrative, previously shown only in the Roadmap tab UI, is now rendered into the deck", () => {
    const src = readRoadmap();
    expect(src).toContain("EXECUTIVE NARRATIVE");
    expect(src).toContain("var narrative=(sr.narrative||'').trim();");
    expect(src).toContain("var WORDS_PER_SLIDE=170;");
  });
});

describe("roadmap.html — Impact/Complexity Matrix cells summarise instead of silently overflowing (v5.32.16)", () => {
  it("shrinks font and truncates with a '+N more' note once a cell's initiative list would overflow", () => {
    const src = readRoadmap();
    expect(src).toContain("var cellFont = names.length>16?7:(names.length>11?8:9.5);");
    expect(src).toContain("extraNote='\\n+'+(names.length-displayNames.length)+' more';");
  });
});

describe("roadmap.html — Technical Architecture cell truncates long initiative lists (v5.32.16)", () => {
  it("summarises with '+N more' instead of an unbounded joined string per pattern", () => {
    const src = readRoadmap();
    expect(src).toContain("names.length>8 ? names.slice(0,8).join(', ')+' +'+(names.length-8)+' more' : names.join(', ')");
  });
});

describe("roadmap.html — Phase 1 Mobilisation no longer silently drops actions beyond 3 (v5.32.16)", () => {
  it("adds a '+N more' pointer to where the full Phase 1 list lives when there are more than 3", () => {
    const src = readRoadmap();
    expect(src).toContain("if(p1Names.length>3){");
    expect(src).toContain("more Phase 1 item(s) — full list on the Full Initiative List and Synthesis Priorities slides.");
  });
});
