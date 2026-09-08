/**
 * Gateway unit tests — routing, fallback, free-tier blocking, metering.
 * Pure in-memory; no network, no DB.
 */
import { describe, it, expect } from "vitest";
import { LlmGateway, type MeterEvent } from "../src/llm/gateway.js";
import { DEV_POLICY, PROD_POLICY } from "../src/llm/router.js";
import type { ProviderAdapter, GenerateRequest } from "../src/llm/types.js";

function fakeAdapter(
  name: string,
  opts: { freeTier?: boolean; configured?: boolean; fail?: boolean } = {}
): ProviderAdapter {
  return {
    name,
    model: `${name}-model`,
    freeTier: opts.freeTier ?? false,
    isConfigured: () => opts.configured ?? true,
    async generate(_req: GenerateRequest) {
      if (opts.fail) throw new Error("boom");
      return {
        text: `from-${name}`,
        model: `${name}-model`,
        usage: { tokensIn: 10, tokensOut: 20, costEstUsd: 0.001 },
      };
    },
  };
}

function collectMeter(events: MeterEvent[]) {
  return async (e: MeterEvent) => {
    events.push(e);
  };
}

const CTX = { tenantId: "t-1", userId: "u-1", module: "test" };

describe("LlmGateway", () => {
  it("uses the first configured adapter in the default chain", async () => {
    const events: MeterEvent[] = [];
    const gw = new LlmGateway({
      adapters: [fakeAdapter("gemini-aistudio", { freeTier: true }), fakeAdapter("gemini-vertex")],
      policy: DEV_POLICY,
      meter: collectMeter(events),
      blockFreeTier: false,
    });
    const res = await gw.generate(CTX, { task: "hypotheses", messages: [{ role: "user", content: "x" }] });
    expect(res.provider).toBe("gemini-aistudio");
    expect(res.text).toBe("from-gemini-aistudio");
  });

  it("falls back to the next provider when the first fails, metering both attempts", async () => {
    const events: MeterEvent[] = [];
    const gw = new LlmGateway({
      adapters: [
        fakeAdapter("gemini-aistudio", { freeTier: true, fail: true }),
        fakeAdapter("gemini-vertex"),
      ],
      policy: DEV_POLICY,
      meter: collectMeter(events),
      blockFreeTier: false,
    });
    const res = await gw.generate(CTX, { task: "hypotheses", messages: [{ role: "user", content: "x" }] });
    expect(res.provider).toBe("gemini-vertex");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ provider: "gemini-aistudio", ok: false });
    expect(events[1]).toMatchObject({ provider: "gemini-vertex", ok: true, tokensIn: 10, tokensOut: 20 });
  });

  it("routes premium tasks to Claude first (task override)", async () => {
    const events: MeterEvent[] = [];
    const gw = new LlmGateway({
      adapters: [
        fakeAdapter("gemini-aistudio", { freeTier: true }),
        fakeAdapter("gemini-vertex"),
        fakeAdapter("anthropic-vertex"),
      ],
      policy: DEV_POLICY,
      meter: collectMeter(events),
      blockFreeTier: false,
    });
    const res = await gw.generate(CTX, { task: "synthesis", messages: [{ role: "user", content: "x" }] });
    expect(res.provider).toBe("anthropic-vertex");
  });

  it("hard-excludes free-tier adapters when blockFreeTier is set (production)", async () => {
    const events: MeterEvent[] = [];
    const gw = new LlmGateway({
      adapters: [fakeAdapter("gemini-aistudio", { freeTier: true }), fakeAdapter("gemini-vertex")],
      policy: PROD_POLICY,
      meter: collectMeter(events),
      blockFreeTier: true,
    });
    const res = await gw.generate(CTX, { task: "hypotheses", messages: [{ role: "user", content: "x" }] });
    expect(res.provider).toBe("gemini-vertex");
    expect(gw.availableProviders()).not.toContain("gemini-aistudio");
  });

  it("skips unconfigured adapters", async () => {
    const gw = new LlmGateway({
      adapters: [
        fakeAdapter("gemini-aistudio", { freeTier: true, configured: false }),
        fakeAdapter("gemini-vertex"),
      ],
      policy: DEV_POLICY,
      meter: async () => {},
      blockFreeTier: false,
    });
    const res = await gw.generate(CTX, { task: "hypotheses", messages: [{ role: "user", content: "x" }] });
    expect(res.provider).toBe("gemini-vertex");
  });

  it("throws 502 when every provider in the chain fails", async () => {
    const gw = new LlmGateway({
      adapters: [
        fakeAdapter("gemini-aistudio", { freeTier: true, fail: true }),
        fakeAdapter("gemini-vertex", { fail: true }),
        fakeAdapter("anthropic-vertex", { fail: true }),
      ],
      policy: DEV_POLICY,
      meter: async () => {},
      blockFreeTier: false,
    });
    await expect(
      gw.generate(CTX, { task: "hypotheses", messages: [{ role: "user", content: "x" }] })
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("blocks generation when the tenant plan limit is exceeded", async () => {
    const gw = new LlmGateway({
      adapters: [fakeAdapter("gemini-vertex")],
      policy: DEV_POLICY,
      meter: async () => {},
      blockFreeTier: false,
      limitCheck: async () => ({ allowed: false, reason: "monthly_token_limit_exceeded" }),
    });
    await expect(
      gw.generate(CTX, { task: "hypotheses", messages: [{ role: "user", content: "x" }] })
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("honors LLM_DEFAULT_CHAIN override for non-premium tasks", async () => {
    const gw = new LlmGateway({
      adapters: [fakeAdapter("gemini-aistudio", { freeTier: true }), fakeAdapter("openai")],
      policy: DEV_POLICY,
      meter: async () => {},
      blockFreeTier: false,
      defaultChainOverride: ["openai"],
    });
    const res = await gw.generate(CTX, { task: "hypotheses", messages: [{ role: "user", content: "x" }] });
    expect(res.provider).toBe("openai");
  });

  it("survives a failing meter (metering never breaks generation)", async () => {
    const gw = new LlmGateway({
      adapters: [fakeAdapter("gemini-vertex")],
      policy: DEV_POLICY,
      meter: async () => {
        throw new Error("db down");
      },
      blockFreeTier: false,
    });
    const res = await gw.generate(CTX, { task: "hypotheses", messages: [{ role: "user", content: "x" }] });
    expect(res.text).toBe("from-gemini-vertex");
  });

  it("retries the SAME adapter on transient 503 'high demand', then succeeds", async () => {
    const events: MeterEvent[] = [];
    let calls = 0;
    const flaky: ProviderAdapter = {
      name: "gemini-aistudio", model: "flash", freeTier: true,
      isConfigured: () => true,
      async generate() {
        calls++;
        if (calls === 1) throw new Error('gemini-aistudio 503: {"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}');
        return { text: "recovered", model: "flash", usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0 } };
      },
    };
    const gw = new LlmGateway({
      adapters: [flaky],
      policy: DEV_POLICY,
      meter: collectMeter(events),
      blockFreeTier: false,
      sleep: async () => {}, // no real waiting in tests
    });
    const res = await gw.generate(CTX, { task: "hypotheses", messages: [{ role: "user", content: "x" }] });
    expect(res.text).toBe("recovered");
    expect(calls).toBe(2);
    expect(events.filter((e) => !e.ok)).toHaveLength(1); // failed attempt still metered
  });

  it("transient failures across the whole chain surface as a friendly 503", async () => {
    const busy: ProviderAdapter = {
      name: "gemini-aistudio", model: "flash", freeTier: true,
      isConfigured: () => true,
      async generate() { throw new Error("503 UNAVAILABLE high demand"); },
    };
    const gw = new LlmGateway({
      adapters: [busy],
      policy: DEV_POLICY,
      meter: collectMeter([]),
      blockFreeTier: false,
      sleep: async () => {},
      defaultChainOverride: ["gemini-aistudio"],
    });
    await expect(
      gw.generate(CTX, { task: "hypotheses", messages: [{ role: "user", content: "x" }] })
    ).rejects.toMatchObject({ statusCode: 503 });
    try {
      await gw.generate(CTX, { task: "hypotheses", messages: [{ role: "user", content: "x" }] });
    } catch (e) {
      expect((e as Error).message).toContain("briefly at capacity");
    }
  });
});
