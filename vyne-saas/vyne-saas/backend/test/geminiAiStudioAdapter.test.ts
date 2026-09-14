/**
 * v5.32.3 fix: the AI Studio adapter was sending the API key as a `?key=`
 * query-string param. Google's newer "AQ."-prefixed keys — which AI Studio
 * now issues by default, replacing the legacy "AIzaSy..." format — 401 with
 * ACCESS_TOKEN_TYPE_UNSUPPORTED when passed that way. Confirmed against a
 * real production 401 (Cloud Run logs) and Google's current docs, which
 * pass the key via the `x-goog-api-key` header instead. That header form
 * works for both old and new key formats, so this is a straight fix, not a
 * conditional-on-key-format branch.
 */
import { describe, it, expect } from "vitest";
import { makeGeminiAiStudioAdapter } from "../src/llm/adapters/geminiAiStudio.js";

const OK_BODY = { candidates: [{ content: { parts: [{ text: "hi" }] } }] };

function captureFetch() {
  let capturedUrl: string | undefined;
  let capturedHeaders: Record<string, string> | undefined;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedHeaders = init?.headers as Record<string, string> | undefined;
    return new Response(JSON.stringify(OK_BODY), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, getUrl: () => capturedUrl, getHeaders: () => capturedHeaders };
}

describe("gemini-aistudio adapter — key transport (v5.32.3)", () => {
  it("sends the API key via the x-goog-api-key header, not a ?key= query param", async () => {
    const { fetchImpl, getUrl, getHeaders } = captureFetch();
    const adapter = makeGeminiAiStudioAdapter({ apiKey: "AQ.fake-key-value", fetchImpl });
    await adapter.generate({ task: "test", messages: [{ role: "user", content: "hi" }] });
    expect(getUrl()).not.toContain("key=");
    expect(getHeaders()?.["x-goog-api-key"]).toBe("AQ.fake-key-value");
  });
});
