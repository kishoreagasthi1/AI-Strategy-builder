/**
 * v5.32.17 — two related fixes requested together:
 *
 *  1. pre_engagement.html's BENCHMARKS / HYPOTHESES_DB dictionaries used keys
 *     ("Energy", "Technology") that didn't match the actual dropdown values
 *     VYNE_CONFIG.industries offers ("Energy & Utilities", "Technology / SaaS"),
 *     and had no entries at all for two real, dropdown-suggested industries
 *     ("Professional Services", "Insurance"). Because renderBenchmarks() and
 *     renderHypotheses() did a bare `dict[industry] || dict['Other']` exact-match
 *     lookup, any client in one of those four industries was silently shown the
 *     generic "Other" benchmark/hypothesis content with no indication anything
 *     was wrong — confirming the user's suspicion that industry values weren't
 *     consistent across modules.
 *
 *  2. generateIndustryCatalog() (the AI-generated custom-industry use-case
 *     catalog, cached firm-wide) had the same "5-7 use cases each" style cap
 *     baked into its own prompt that was originally flagged when auditing the
 *     built-in 204-use-case catalog and the Strategy Deck. Leaning on this
 *     generator more (per the user's own suggestion to always use it, even for
 *     built-in industries) would have just relocated the restriction rather
 *     than removing it, so its prompt needed the same "typically N, don't pad,
 *     don't omit" treatment already applied elsewhere.
 *
 * Static source-text regression guard — no frontend test runner in this repo,
 * same pattern as clientDropdowns.test.ts / deckAndFindingsCapsRemoved.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dirname, "..", "..", "frontend");

function readPreEngagement(): string {
  return readFileSync(join(FRONTEND, "pre_engagement.html"), "utf8");
}
function readRoadmap(): string {
  return readFileSync(join(FRONTEND, "roadmap.html"), "utf8");
}

describe("pre_engagement.html — BENCHMARKS/HYPOTHESES_DB keys match the real dropdown values (v5.32.17)", () => {
  it("BENCHMARKS uses the dropdown's actual industry labels, not the old mismatched short names", () => {
    const src = readPreEngagement();
    expect(src).toContain('"Energy & Utilities":{revenueRanges:');
    expect(src).toContain('"Technology / SaaS":{revenueRanges:');
    // the old mismatched keys must be gone, not just shadowed
    expect(src).not.toMatch(/const BENCHMARKS=\{[\s\S]*?"Energy":\{revenueRanges:/);
    expect(src).not.toMatch(/const BENCHMARKS=\{[\s\S]*?"Technology":\{revenueRanges:/);
  });

  it("HYPOTHESES_DB uses the same renamed keys as BENCHMARKS", () => {
    const src = readPreEngagement();
    expect(src).toContain('"Energy & Utilities":["Asset IoT sensor data exists');
    expect(src).toContain('"Technology / SaaS":["AI features in core product');
  });

  it("both dictionaries now have real entries for Professional Services and Insurance, not just a fallback to Other", () => {
    const src = readPreEngagement();
    expect(src).toContain('"Professional Services":{revenueRanges:');
    expect(src).toContain('"Insurance":{revenueRanges:');
    expect(src).toContain('"Professional Services":["Engagement and client data live in separate systems');
    expect(src).toContain('"Insurance":["Policy, claims, and underwriting data live in separate legacy systems');
  });
});

describe("pre_engagement.html — nearestIndustryKey fuzzy matcher generalized and actually used (v5.32.17)", () => {
  it("defines a generic nearestIndustryKey(dict, industry) helper", () => {
    const src = readPreEngagement();
    expect(src).toContain("function nearestIndustryKey(dict, industry){");
  });

  it("nearestBenchKey is now a thin wrapper over nearestIndustryKey instead of its own logic", () => {
    const src = readPreEngagement();
    expect(src).toContain("function nearestBenchKey(industry){ return nearestIndustryKey(BENCHMARKS, industry); }");
  });

  it("renderBenchmarks() routes the client's industry through the fuzzy matcher instead of an exact-match-only lookup", () => {
    const src = readPreEngagement();
    const fn = src.match(/function renderBenchmarks\(industry,revenue\)\{([\s\S]*?)\n\}/);
    expect(fn, "expected to find renderBenchmarks()").toBeTruthy();
    const body = fn![1];
    expect(body).not.toContain("const bench=BENCHMARKS[industry]||BENCHMARKS['Other'];");
    expect(body).toContain("const key=nearestBenchKey(industry);");
    expect(body).toContain("const bench=BENCHMARKS[key]||BENCHMARKS['Other'];");
    expect(body).toContain("setBenchBasisNote(key!==industry");
  });

  it("renderHypotheses() routes the client's industry through the fuzzy matcher instead of an exact-match-only lookup", () => {
    const src = readPreEngagement();
    const fn = src.match(/async function renderHypotheses\(industry,apiKey,client,clientProblem,peContext\)\{([\s\S]*?)hypothesesState=\{\};/);
    expect(fn, "expected to find renderHypotheses()").toBeTruthy();
    const body = fn![1];
    expect(body).not.toContain("const baseHyps=HYPOTHESES_DB[industry]||HYPOTHESES_DB['Other'];");
    expect(body).toContain("const hypKey=nearestIndustryKey(HYPOTHESES_DB, industry);");
    expect(body).toContain("const baseHyps=HYPOTHESES_DB[hypKey]||HYPOTHESES_DB['Other'];");
  });

  it("saveBriefingContext()'s benchmark lookup (feeds the AI briefing/round-summary context) also uses the fuzzy matcher", () => {
    const src = readPreEngagement();
    expect(src).not.toContain("var bench=BENCHMARKS[industry]||BENCHMARKS['Other'];");
    expect(src).toContain("var bench=BENCHMARKS[nearestBenchKey(industry)]||BENCHMARKS['Other'];");
  });

  it("the offline AI-refresh fallback (fallbackBench) already used the fuzzy matcher and is unchanged", () => {
    const src = readPreEngagement();
    expect(src).toContain("var key = nearestBenchKey(industry);");
    expect(src).toContain("var fallback = BENCHMARKS[key]||BENCHMARKS['Other'];");
  });
});

describe("roadmap.html — custom-industry catalog generator no longer caps functions/use-cases at a fixed count (v5.32.17)", () => {
  it("removes the flat '6-8 depts, 5-7 use cases each' cap from generateIndustryCatalog's prompt", () => {
    const src = readRoadmap();
    expect(src).not.toContain("Provide 6-8 depts, 5-7 use cases each, 2-4 subUcs per use case.");
  });

  it("replaces it with value-chain-driven guidance that explicitly forbids padding or omitting to hit a count", () => {
    const src = readRoadmap();
    expect(src).toContain("typically 6-10 functions for a real industry, but let the value chain decide, not a fixed count");
    expect(src).toContain("typically 5-10, but do not pad to hit a number and do not omit a real one to stay under an old cap");
    expect(src).toContain("Provide 2-4 subUcs per use case.");
  });

  // v5.32.27 supersedes the original form of this test. It used to assert the
  // single-call ceiling had been RAISED (16000 -> 24000), which was the right
  // move at the time but the wrong shape of answer: an uncapped catalog has no
  // ceiling that is reliably big enough, and overflowing one silently produced
  // a thinner catalog that the toast then reported as the full result. The
  // generator is now split across calls (see generatorChunking.test.ts, which
  // executes it), so what matters here is that the anti-cap GUIDANCE survived
  // the restructure — that is what this test was really protecting.
  it("no longer relies on a single call with a big ceiling", () => {
    const src = readRoadmap();
    expect(src).not.toContain("model:'claude-sonnet-4-5',max_tokens:24000,messages:[{role:'user',content:prompt}]})});");
    expect(src).not.toContain("model:'claude-sonnet-4-5',max_tokens:16000,messages:[{role:'user',content:prompt}]})});");
    expect(src).toContain("function buildCatalogSkeletonPrompt(label){");
    expect(src).toContain("function buildCatalogDetailPrompt(label, dept){");
  });

  it("keeps the uncapped guidance in pass 1, where the counts are decided", () => {
    const src = readRoadmap();
    const skeleton = src.slice(
      src.indexOf("function buildCatalogSkeletonPrompt(label){"),
      src.indexOf("function buildCatalogDetailPrompt(label, dept){")
    );
    expect(skeleton).toContain("typically 6-10 functions for a real industry, but let the value chain decide, not a fixed count");
    expect(skeleton).toContain("typically 5-10, but do not pad to hit a number and do not omit a real one to stay under an old cap");
  });
});
