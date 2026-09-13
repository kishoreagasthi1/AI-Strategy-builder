/**
 * V225-audit LOW fix: PRICE_TABLE (llm/types.ts) used to only have the
 * pinned "gemini-2.5-flash" id, but both Gemini adapters default their
 * model to "gemini-flash-latest" (Google's rolling alias). estimateCost()
 * silently returns 0 for any model not in the table, so every default-model
 * Vertex call (real, billed) was recorded with costEstUsd: 0.
 */
import { describe, it, expect } from "vitest";
import { estimateCost } from "../src/llm/types.js";

describe("estimateCost", () => {
  it("prices the default Gemini adapter model (gemini-flash-latest), not just the pinned id", () => {
    const cost = estimateCost("gemini-flash-latest", 1_000_000, 1_000_000);
    expect(cost).toBeGreaterThan(0);
    // Same price as the pinned id it's an alias for.
    expect(cost).toBe(estimateCost("gemini-2.5-flash", 1_000_000, 1_000_000));
  });

  it("still returns 0 for a genuinely unknown model (no silent guess)", () => {
    expect(estimateCost("some-future-model-nobody-priced-yet", 1000, 1000)).toBe(0);
  });
});
