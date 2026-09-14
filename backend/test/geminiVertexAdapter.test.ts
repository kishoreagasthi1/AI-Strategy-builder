/**
 * v5.32.1 fix: production's gemini-vertex adapter was 404ing on every call
 * — "gemini-flash-latest" (the old default) is an AI Studio-only rolling
 * alias, invalid on Vertex's publishers/google/models endpoint, which wants
 * a specific model id. Confirmed against the real Vertex Model Garden page:
 * GA id is "gemini-3.6-flash", served from location "global" (a newer
 * Vertex pattern for some models — no regional hostname prefix, unlike
 * "us-central1-aiplatform.googleapis.com" for region-pinned models).
 * These tests pin both facts so neither can silently drift back to a
 * broken default.
 */
import { describe, it, expect } from "vitest";
import { makeGeminiVertexAdapter } from "../src/llm/adapters/geminiVertex.js";

const OK_BODY = { candidates: [{ content: { parts: [{ text: "hi" }] } }] };

function captureFetch() {
  let capturedUrl: string | undefined;
  const fetchImpl = async (url: string) => {
    capturedUrl = url;
    return new Response(JSON.stringify(OK_BODY), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, getUrl: () => capturedUrl };
}

describe("gemini-vertex adapter — model/location defaults", () => {
  it("defaults to the GA model id gemini-3.6-flash, not the AI-Studio-only alias", async () => {
    const { fetchImpl, getUrl } = captureFetch();
    const adapter = makeGeminiVertexAdapter({
      project: "proj",
      getAccessToken: async () => "fake-token",
      fetchImpl,
    });
    await adapter.generate({ task: "test", messages: [{ role: "user", content: "hi" }] });
    expect(getUrl()).toContain("/publishers/google/models/gemini-3.6-flash:generateContent");
  });

  it("defaults to location 'global' and drops the regional hostname prefix", async () => {
    const { fetchImpl, getUrl } = captureFetch();
    const adapter = makeGeminiVertexAdapter({
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
    const adapter = makeGeminiVertexAdapter({
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
