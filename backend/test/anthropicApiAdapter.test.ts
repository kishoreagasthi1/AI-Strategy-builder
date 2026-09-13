/**
 * v5.34.54 — Claude on an API key, which is the only way a CLIENT can pay for
 * their own Claude work.
 *
 * anthropic-vertex authenticates with GCP Application Default Credentials and
 * has nowhere to put a client's key. Migration 031 allows `anthropic-api` as a
 * BYOK provider; until this adapter existed that was a provider the router
 * could not serve — the exact fault the migration excludes both Vertex
 * providers for.
 */
import { describe, it, expect } from "vitest";
import { makeAnthropicApiAdapter } from "../src/llm/adapters/anthropicApi.js";

const reply = (over: Record<string, unknown> = {}) => ({
  ok: true, status: 200,
  json: async () => ({
    content: [{ type: "text", text: "A deck outline." }],
    usage: { input_tokens: 1200, output_tokens: 800 },
    stop_reason: "end_turn",
    ...over,
  }),
});

function spy(res: any = reply()) {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => { calls.push({ url, init }); return res; }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const REQ = { task: "strategy_deck", messages: [
  { role: "system" as const, content: "You are a strategy consultant." },
  { role: "user" as const, content: "Outline the deck." },
] };

describe("v5.34.54 — a client's own Anthropic key", () => {
  it("sends the key as x-api-key, which is what makes BYOK possible at all", async () => {
    const s = spy();
    const a = makeAnthropicApiAdapter({ apiKey: "sk-ant-client", fetchImpl: s.fetchImpl });
    await a.generate(REQ as any);

    expect(s.calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(s.calls[0].init.headers["x-api-key"]).toBe("sk-ant-client");
    expect(s.calls[0].init.headers["anthropic-version"]).toBe("2023-06-01");
    // No bearer token: this path must not depend on GCP credentials.
    expect(s.calls[0].init.headers.authorization).toBeUndefined();
  });

  it("puts the model in the BODY — the Vertex adapter puts it in the URL", async () => {
    const s = spy();
    const a = makeAnthropicApiAdapter({ apiKey: "k", model: "claude-sonnet-5", fetchImpl: s.fetchImpl });
    await a.generate(REQ as any);
    expect(JSON.parse(s.calls[0].init.body).model).toBe("claude-sonnet-5");
  });

  it("lifts system messages out of the turn list, as this API requires", async () => {
    const s = spy();
    const a = makeAnthropicApiAdapter({ apiKey: "k", fetchImpl: s.fetchImpl });
    await a.generate(REQ as any);
    const body = JSON.parse(s.calls[0].init.body);
    expect(body.system).toContain("strategy consultant");
    expect(body.messages.map((m: any) => m.role)).toEqual(["user"]);
  });

  it("reports usage so the call still lands on the right client's statement", async () => {
    // BYOK changes whose card is charged; it must NOT stop the work being
    // attributed and costed per client.
    const s = spy();
    const a = makeAnthropicApiAdapter({ apiKey: "k", fetchImpl: s.fetchImpl });
    const out = await a.generate(REQ as any);
    expect(out.usage.tokensIn).toBe(1200);
    expect(out.usage.tokensOut).toBe(800);
    expect(out.usage.costEstUsd).toBeGreaterThan(0);
  });

  it("is not free tier — there is no training-eligible tier to guard against", () => {
    // Materially unlike Google AI Studio, where a free key is indistinguishable
    // from a billed one and may be trained on. That asymmetry is why Gemini
    // BYOK needs an attestation and this does not.
    expect(makeAnthropicApiAdapter({ apiKey: "k" }).freeTier).toBe(false);
  });

  it("is skipped by the chain when no key is configured", () => {
    expect(makeAnthropicApiAdapter({ apiKey: undefined }).isConfigured()).toBe(false);
    expect(makeAnthropicApiAdapter({ apiKey: "k" }).isConfigured()).toBe(true);
  });

  it("a rejected client key surfaces its status and never the key", async () => {
    const s = spy({ ok: false, status: 401, text: async () => "invalid x-api-key" });
    const a = makeAnthropicApiAdapter({ apiKey: "sk-ant-secret-value", fetchImpl: s.fetchImpl });
    await expect(a.generate(REQ as any)).rejects.toThrow(/anthropic-api 401/);
    await expect(a.generate(REQ as any)).rejects.not.toThrow(/sk-ant-secret-value/);
  });

  it("a schema request that comes back as prose fails rather than returning junk", async () => {
    const s = spy(reply({ content: [{ type: "text", text: "Sorry, I cannot." }] }));
    const a = makeAnthropicApiAdapter({ apiKey: "k", fetchImpl: s.fetchImpl });
    await expect(a.generate({ ...REQ, jsonSchema: { type: "object" } } as any))
      .rejects.toThrow(/not valid JSON/);
  });

  it("strips markdown fences a model wraps JSON in", async () => {
    const s = spy(reply({ content: [{ type: "text", text: '```json\n{"ok":true}\n```' }] }));
    const a = makeAnthropicApiAdapter({ apiKey: "k", fetchImpl: s.fetchImpl });
    const out = await a.generate({ ...REQ, jsonSchema: { type: "object" } } as any);
    expect(out.json).toEqual({ ok: true });
  });

  it("can be registered under a per-tenant name, for BYOK instances", () => {
    // Slice 2 builds one adapter per tenant key; the name must not collide.
    const a = makeAnthropicApiAdapter({ apiKey: "k", name: "anthropic-api:byok:nestle" });
    expect(a.name).toBe("anthropic-api:byok:nestle");
  });

  it("every provider migration 031 allows now has an adapter that can serve it", async () => {
    /*
     * The check that would have caught this release's own mistake: 031's
     * CHECK allows anthropic-api, and for one release no adapter by that name
     * existed. A BYOK row pointing at a provider the router cannot resolve is
     * a promise to a client that silently fails.
     */
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const mig = readFileSync(join(here, "..", "src", "db", "migrations", "031_byok_client_grain.sql"), "utf8");
    const allowed = /provider IN \(([^)]*)\)/.exec(mig)![1]
      .split(",").map((s) => s.trim().replace(/'/g, ""));
    const boot = readFileSync(join(here, "..", "src", "index.ts"), "utf8");
    const factories: Record<string, string> = {
      "gemini-aistudio": "makeGeminiAiStudioAdapter",
      "anthropic-api": "makeAnthropicApiAdapter",
    };
    for (const p of allowed) {
      expect(factories[p], `031 allows "${p}" but no adapter factory is mapped for it`).toBeTruthy();
      expect(boot, `"${p}" has a factory that is never registered at boot`).toContain(factories[p]);
    }
  });
});
