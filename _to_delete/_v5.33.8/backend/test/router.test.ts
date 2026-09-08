/**
 * v5.32.2: production temporarily prefers gemini-vertex for every task,
 * including the three "premium" ones (synthesis/strategy_deck/
 * solution_design) that used to prefer anthropic-vertex — an explicit,
 * temporary request made during end-to-end testing (see router.ts's doc
 * comment on PROD_POLICY for the full rationale and how to revert).
 * DEV_POLICY is intentionally unchanged — still Claude-first for those
 * three tasks — so this test also guards against the temporary change
 * accidentally leaking into dev/test behavior.
 */
import { describe, it, expect } from "vitest";
import { chainForTask, DEV_POLICY, PROD_POLICY } from "../src/llm/router.js";

describe("PROD_POLICY routing (v5.32.2 temporary Gemini-first)", () => {
  it("prefers gemini-vertex first for the general default chain", () => {
    expect(chainForTask(PROD_POLICY, "hypotheses")).toEqual(["gemini-vertex", "anthropic-vertex"]);
  });

  it("prefers gemini-vertex first for the three premium tasks too, with anthropic-vertex still as fallback", () => {
    for (const task of ["synthesis", "strategy_deck", "solution_design"]) {
      expect(chainForTask(PROD_POLICY, task)).toEqual(["gemini-vertex", "anthropic-vertex"]);
    }
  });
});

describe("DEV_POLICY routing (unchanged — still Claude-first for premium tasks)", () => {
  it("still prefers anthropic-vertex first for the three premium tasks", () => {
    for (const task of ["synthesis", "strategy_deck", "solution_design"]) {
      expect(chainForTask(DEV_POLICY, task)[0]).toBe("anthropic-vertex");
    }
  });
});
