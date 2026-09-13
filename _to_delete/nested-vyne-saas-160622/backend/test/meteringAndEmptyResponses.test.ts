/**
 * Two ways a failure was being reported as a success (audit V2-M4, V2-M5).
 *
 * V2-M4 — a lost billing row said nothing. gateway.safeMeter() swallowed every
 * exception from the metering write, which is the right call: a generation the
 * user already paid for must not fail because a bookkeeping INSERT did. But its
 * comment claimed the failure was "surfaced via logs in the route layer", and
 * nothing in the route layer ever saw it — the exception died inside the class.
 * metering.ts says of these rows: "the raw material for billing later — do not
 * lose them." Losing them silently is the worst available outcome, because the
 * revenue is gone AND nobody is told.
 *
 * V2-M5 — an empty completion was returned as a finished document. A 200 from
 * Gemini does not mean there is a completion in it: a refused prompt comes back
 * with promptFeedback.blockReason and no candidates, a blocked or recited
 * completion comes back with a finishReason and no parts. Both parsed to
 * text: "" and travelled up the stack as a success. The jsonSchema path
 * happened to notice, because JSON.parse("") throws; every prose path — the
 * interview turns, the synthesis, the client-facing document — did not, and
 * wrote an empty section that a consultant would have to catch by reading.
 */
import { describe, it, expect, vi } from "vitest";
import { LlmGateway } from "../src/llm/gateway.js";
import { parseGeminiResponse, type GeminiResponse } from "../src/llm/adapters/geminiShared.js";
import type { ProviderAdapter } from "../src/llm/types.js";

const ok: ProviderAdapter = {
  name: "gemini-aistudio", model: "fake", freeTier: true,
  isConfigured: () => true,
  async generate() {
    return { text: "a real answer", model: "fake", usage: { tokensIn: 5, tokensOut: 7, costEstUsd: 0 } };
  },
};

const POLICY = { defaultChain: ["gemini-aistudio"], taskChains: {} };

const gatewayWith = (meter: () => Promise<void>, onMeterError?: (e: unknown, ev: unknown) => void) =>
  new LlmGateway({
    adapters: [ok],
    policy: POLICY,
    meter: meter as never,
    blockFreeTier: false,
    onMeterError: onMeterError as never,
  });

// generate(ctx, req) — the context first. Worth stating, because writing these
// the other way round produces a call that type-checks under `as never` and
// then silently generates from an empty prompt.
const ctx = { tenantId: "t-1", userId: "u-1", module: "pre_engagement" };
const req = { task: "benchmarks", messages: [{ role: "user" as const, content: "hi" }] };

describe("a metering failure is swallowed but never silent (V2-M4)", () => {
  it("still returns the generation — a bookkeeping failure must not cost the user their answer", async () => {
    const g = gatewayWith(async () => { throw new Error("db down"); }, () => {});
    const out = await g.generate(ctx, req);
    expect(out.text).toBe("a real answer");
  });

  it("reports the failure, with enough context to find the missing money", async () => {
    const seen: Array<[unknown, Record<string, unknown>]> = [];
    const g = gatewayWith(
      async () => { throw new Error("db down"); },
      (err, ev) => seen.push([err, ev as Record<string, unknown>])
    );
    await g.generate(ctx, req);

    expect(seen).toHaveLength(1);
    expect((seen[0][0] as Error).message).toBe("db down");
    // Which tenant, which task, and how much was spent — a report saying only
    // "metering failed" cannot be reconciled against anything afterwards.
    expect(seen[0][1].tenantId).toBe("t-1");
    expect(seen[0][1].task).toBe("benchmarks");
    expect(Number(seen[0][1].tokensIn)).toBeGreaterThan(0);
  });

  it("a reporter that itself throws does not escalate into the generation", async () => {
    // There is nowhere left to report to at that point, and taking down a
    // successful generation because the error channel broke would be absurd.
    const g = gatewayWith(
      async () => { throw new Error("db down"); },
      () => { throw new Error("sentry is also down"); }
    );
    const out = await g.generate(ctx, req);
    expect(out.text).toBe("a real answer");
  });

  it("does not report anything when metering succeeds", async () => {
    const spy = vi.fn();
    const g = gatewayWith(async () => {}, spy);
    await g.generate(ctx, req);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("an empty Gemini response is a failure, not a document (V2-M5)", () => {
  const usable: GeminiResponse = {
    candidates: [{ content: { parts: [{ text: "real content" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
  };

  it("parses a normal response exactly as before", () => {
    // The guard must not have changed the happy path; every other assertion
    // here is worthless if it did.
    const out = parseGeminiResponse(usable);
    expect(out.text).toBe("real content");
    expect(out.tokensIn).toBe(10);
    expect(out.tokensOut).toBe(20);
  });

  it("throws when the PROMPT was blocked (no candidates at all)", () => {
    expect(() => parseGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } }))
      .toThrow(/SAFETY/);
  });

  it("throws when the COMPLETION was blocked (a candidate with no parts)", () => {
    expect(() => parseGeminiResponse({ candidates: [{ finishReason: "RECITATION" }] }))
      .toThrow(/RECITATION/);
  });

  it("throws on an empty body with no explanation offered", () => {
    expect(() => parseGeminiResponse({})).toThrow(/no content/i);
    expect(() => parseGeminiResponse({ candidates: [] })).toThrow(/no content/i);
  });

  it("treats whitespace-only output as empty", () => {
    // "\n\n" is not a solution design. Trimming is what makes the guard catch
    // the shape a truncated stream actually leaves behind.
    expect(() => parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: "  \n " }] }, finishReason: "STOP" }],
    })).toThrow(/no content/i);
  });

  it("lets the gateway fail over instead of returning nothing", async () => {
    // This is why throwing is the right shape rather than returning a flag: an
    // adapter error is metered as a failed attempt and the chain moves on, so a
    // provider refusing one prompt costs a retry rather than the request.
    const refusing: ProviderAdapter = {
      name: "gemini-vertex", model: "fake", freeTier: false,
      isConfigured: () => true,
      async generate() {
        return parseGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } }) as never;
      },
    };
    const g = new LlmGateway({
      adapters: [refusing, ok],
      policy: { defaultChain: ["gemini-vertex", "gemini-aistudio"], taskChains: {} },
      meter: async () => {},
      blockFreeTier: false,
    });
    const out = await g.generate(ctx, req);
    expect(out.text).toBe("a real answer");
    expect(out.provider).toBe("gemini-aistudio");
  });
});
