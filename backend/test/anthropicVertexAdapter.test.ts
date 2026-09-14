/**
 * v5.32.1 fix: production's anthropic-vertex adapter was 404ing on every
 * call — "claude-sonnet-4-5" (the old default) isn't a valid Vertex model
 * id, and "us-east5" (the old default location) is a stale assumption from
 * when this adapter was first written. Confirmed against the real Vertex
 * Model Garden page for Claude Sonnet: GA resource id is "claude-sonnet-5",
 * served from location "global" (per Anthropic's own Vertex SDK sample:
 * `LOCATION = "global"`). These tests pin both facts so neither can
 * silently drift back to a broken default.
 */
import { describe, it, expect } from "vitest";
import { makeAnthropicVertexAdapter } from "../src/llm/adapters/anthropicVertex.js";

const OK_BODY = { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } };

function captureFetch() {
  let capturedUrl: string | undefined;
  const fetchImpl = async (url: string) => {
    capturedUrl = url;
    return new Response(JSON.stringify(OK_BODY), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, getUrl: () => capturedUrl };
}

describe("anthropic-vertex adapter — model/location defaults", () => {
  it("defaults to the GA model id claude-sonnet-5, not the stale claude-sonnet-4-5", async () => {
    const { fetchImpl, getUrl } = captureFetch();
    const adapter = makeAnthropicVertexAdapter({
      project: "proj",
      getAccessToken: async () => "fake-token",
      fetchImpl,
    });
    await adapter.generate({ task: "test", messages: [{ role: "user", content: "hi" }] });
    expect(getUrl()).toContain("/publishers/anthropic/models/claude-sonnet-5:rawPredict");
  });

  it("defaults to location 'global' and drops the regional hostname prefix", async () => {
    const { fetchImpl, getUrl } = captureFetch();
    const adapter = makeAnthropicVertexAdapter({
      project: "proj",
      getAccessToken: async () => "fake-token",
      fetchImpl,
    });
    await adapter.generate({ task: "test", messages: [{ role: "user", content: "hi" }] });
    const url = getUrl()!;
    expect(url.startsWith("https://aiplatform.googleapis.com/")).toBe(true);
    expect(url).toContain("/locations/global/");
  });

  it("still uses the regional hostname prefix for an explicit non-global location", async () => {
    const { fetchImpl, getUrl } = captureFetch();
    const adapter = makeAnthropicVertexAdapter({
      project: "proj",
      location: "us-east5",
      getAccessToken: async () => "fake-token",
      fetchImpl,
    });
    await adapter.generate({ task: "test", messages: [{ role: "user", content: "hi" }] });
    const url = getUrl()!;
    expect(url.startsWith("https://us-east5-aiplatform.googleapis.com/")).toBe(true);
    expect(url).toContain("/locations/us-east5/");
  });
});
