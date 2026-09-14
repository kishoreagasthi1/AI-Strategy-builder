/**
 * V225-audit MEDIUM fix: adapters/geminiAiStudio.ts, geminiVertex.ts, and
 * openai.ts used to swallow a JSON.parse failure when the caller requested
 * jsonSchema — returning a "successful" GenerateResult with `json` silently
 * undefined instead of surfacing the failure. A caller that asked for
 * structured output and gets back { json: undefined, text: "<garbage>" }
 * with a 200-equivalent success has no signal anything went wrong. These
 * now throw (matching adapters/anthropicVertex.ts, which already did),
 * which lets LlmGateway.generate() treat it like any other adapter failure
 * — meter it, and fall through to the next adapter in the chain.
 */
import { describe, it, expect } from "vitest";
import { makeGeminiAiStudioAdapter } from "../src/llm/adapters/geminiAiStudio.js";
import { makeGeminiVertexAdapter } from "../src/llm/adapters/geminiVertex.js";
import { makeOpenAiAdapter } from "../src/llm/adapters/openai.js";

const REQ_WITH_SCHEMA = {
  task: "test",
  jsonSchema: { type: "object" as const },
  messages: [{ role: "user" as const, content: "hi" }],
};

function fakeFetch(body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("adapters throw (not silently succeed) on malformed JSON when jsonSchema was requested", () => {
  it("geminiAiStudio", async () => {
    const adapter = makeGeminiAiStudioAdapter({
      apiKey: "fake",
      fetchImpl: fakeFetch({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }),
    });
    await expect(adapter.generate(REQ_WITH_SCHEMA)).rejects.toThrow(/not valid JSON/);
  });

  it("geminiAiStudio still succeeds and parses when the model DOES return valid JSON", async () => {
    const adapter = makeGeminiAiStudioAdapter({
      apiKey: "fake",
      fetchImpl: fakeFetch({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }),
    });
    const result = await adapter.generate(REQ_WITH_SCHEMA);
    expect(result.json).toEqual({ ok: true });
  });

  it("geminiVertex", async () => {
    const adapter = makeGeminiVertexAdapter({
      project: "proj", location: "us-east5",
      getAccessToken: async () => "fake-token",
      fetchImpl: fakeFetch({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }),
    });
    await expect(adapter.generate(REQ_WITH_SCHEMA)).rejects.toThrow(/not valid JSON/);
  });

  it("openai", async () => {
    const adapter = makeOpenAiAdapter({
      apiKey: "fake",
      fetchImpl: fakeFetch({ choices: [{ message: { content: "not json" } }] }),
    });
    await expect(adapter.generate(REQ_WITH_SCHEMA)).rejects.toThrow(/not valid JSON/);
  });
});
