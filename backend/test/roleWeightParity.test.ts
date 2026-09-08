/**
 * v5.32.25 — the role-weighting table existed in SIX places and no two agreed.
 *
 *   frontend/synthesis.html      lines 629, 677, 1032, 2762  (ten roles at 629,
 *                                                             four or five elsewhere)
 *   frontend/interview_agent.html lines 2373, 3520            (four/five roles)
 *   backend/src/tenant/engagementMerge.ts                     (four/five roles)
 *
 * Everything absent fell through to a 0.5 default, so every CFO, CHRO,
 * IT_Director, VP_Sales, Operations_Manager and General_Counsel interview was
 * weighted 0.5 by the writer and by the server-side merge — the numbers that
 * get PERSISTED and served by /api/scorecard — and at its real weight by the
 * Synthesis dashboard. A D7 round with CHRO=5.0 and CEO=1.0 reads 3.0
 * "AI Capable" on screen and 2.3 "AI Exploring" in the stored score that the
 * client deck and the Solution Design generator both treat as measured fact.
 *
 * There is now one table in the browser (VYNE_ROLE_WEIGHTS in vyne-client.js)
 * and one on the server. They cannot import each other — a browser script and
 * an ESM module — so this test is the only thing keeping them identical. If it
 * fails, do not "fix" it by editing the expectation: make the two sources match.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ROLE_WEIGHTS, roleWeight } from "../src/tenant/engagementMerge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FE = (p: string) => readFileSync(join(__dirname, "..", "..", "frontend", p), "utf8");

/** Pull VYNE_ROLE_WEIGHTS out of the browser bundle and evaluate it. */
function browserTable(): Record<string, Record<string, number>> {
  const src = FE("vyne-client.js");
  const start = src.indexOf("var VYNE_ROLE_WEIGHTS = {");
  expect(start, "VYNE_ROLE_WEIGHTS not found in vyne-client.js").toBeGreaterThan(-1);
  const end = src.indexOf("};", start) + 2;
  const literal = src.slice(start + "var VYNE_ROLE_WEIGHTS = ".length, end - 1);
  return JSON.parse(
    literal.replace(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '"$1":').replace(/,\s*}/g, "}")
  ) as Record<string, Record<string, number>>;
}

describe("role weights are identical on both sides (v5.32.25)", () => {
  it("the browser table and the server table match exactly", () => {
    expect(browserTable()).toEqual(ROLE_WEIGHTS);
  });

  it("all seven dimensions are present with the full ten-role set", () => {
    const roles = [
      "CEO", "CFO", "COO", "CTO", "CDO", "CHRO",
      "VP_Sales", "IT_Director", "Operations_Manager", "General_Counsel",
    ];
    ["D1", "D2", "D3", "D4", "D5", "D6", "D7"].forEach((d) => {
      expect(Object.keys(ROLE_WEIGHTS[d]).sort(), d).toEqual([...roles].sort());
    });
  });

  it("the roles that were silently defaulting to 0.5 now carry real weights", () => {
    // These six were absent from every copy except synthesis.html's line 629.
    expect(roleWeight("D7", "CHRO")).toBe(1.0);
    expect(roleWeight("D6", "General_Counsel")).toBe(1.0);
    expect(roleWeight("D5", "Operations_Manager")).toBe(0.9);
    expect(roleWeight("D2", "IT_Director")).toBe(0.9);
    expect(roleWeight("D3", "CFO")).toBe(0.8);
    expect(roleWeight("D5", "VP_Sales")).toBe(0.6);
  });

  it("display-label roles resolve instead of collapsing to the 0.5 default", () => {
    // Synthetic and imported engagements store "COO / VP Operations", not "COO".
    // A raw table lookup missed every one of them, which turned the weighting
    // scheme into an unweighted mean for those engagements.
    expect(roleWeight("D5", "COO / VP Operations")).toBe(1.0);
    expect(roleWeight("D1", "CDO / Chief Data Officer")).toBe(1.0);
    expect(roleWeight("D7", "CEO — Group")).toBe(1.0);
  });

  it("an unknown role still falls back to 0.5 rather than throwing", () => {
    expect(roleWeight("D1", "Head of Widgets")).toBe(0.5);
    expect(roleWeight("D1", undefined)).toBe(0.5);
    expect(roleWeight("NOPE", "CEO")).toBe(0.5);
  });

  it("no local copy of the table survives in the frontend", () => {
    // The literal fingerprint of every old copy.
    ["synthesis.html", "interview_agent.html"].forEach((f) => {
      expect(FE(f), f).not.toContain("D1:{CDO:1.0");
    });
    expect(FE("synthesis.html")).toContain("(window.VYNE_ROLE_WEIGHTS||{})");
  });

  it("weight lookups go through the canonicalising helper, not the raw table", () => {
    ["synthesis.html", "interview_agent.html"].forEach((f) => {
      const src = FE(f);
      expect(src, f).toContain("vyneRoleWeight(");
      expect(src, f).not.toMatch(/\]\[i\.role\]\|\|0\.5/);
    });
  });
});
