import { describe, it, expect } from "vitest";
import { pcmToWav, makeTts } from "../src/llm/tts.js";

describe("pcmToWav", () => {
  it("produces a valid RIFF/WAV header around the PCM payload", () => {
    const pcm = Buffer.alloc(4800, 7); // 100ms of 24kHz mono s16le
    const wav = pcmToWav(pcm, 24000);
    expect(wav.length).toBe(44 + 4800);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(24000);      // sample rate
    expect(wav.readUInt16LE(22)).toBe(1);          // mono
    expect(wav.readUInt32LE(40)).toBe(4800);       // data size
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });
});

/**
 * v5.32.3 fix: synthesize() sent the API key as a `?key=` query-string
 * param. Google's newer "AQ."-prefixed keys — which AI Studio now issues by
 * default in place of the legacy "AIzaSy..." format — 401 with
 * ACCESS_TOKEN_TYPE_UNSUPPORTED when passed that way (confirmed against a
 * real production 401 pulled from Cloud Run logs). The `x-goog-api-key`
 * header works for both key formats, so this test pins the header form to
 * stop it drifting back to the query-param transport.
 */
describe("makeTts — key transport (v5.32.3)", () => {
  it("sends the API key via the x-goog-api-key header, not a ?key= query param", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers as Record<string, string> | undefined;
      const body = {
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: "AAAA" } }] } }],
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const tts = makeTts({ apiKey: "AQ.fake-key-value", fetchImpl });
    await tts.synthesize("hello");
    expect(capturedUrl).not.toContain("key=");
    expect(capturedHeaders?.["x-goog-api-key"]).toBe("AQ.fake-key-value");
  });
});

describe("TTS delivery (v5.32.33)", () => {
  it("defaults to a current GA model, not the retired preview", async () => {
    const { makeTts } = await import("../src/llm/tts.js");
    const t = makeTts({ apiKey: "k" });
    // The May-2025 preview id was still pinned here until v5.32.33. Preview
    // ids get retired; a retired one fails at runtime, not at deploy.
    expect(t.model).not.toContain("preview-tts");
    expect(t.model).toBe("gemini-2.5-flash-tts");
  });

  it("prepends a style instruction — bare text gets the flat default read", async () => {
    const { makeTts } = await import("../src/llm/tts.js");
    let body: any;
    const fetchImpl = (async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [
        { inlineData: { mimeType: "audio/L16;rate=24000", data: Buffer.alloc(64).toString("base64") } } ] } }] }) };
    }) as any;
    const t = makeTts({ apiKey: "k", fetchImpl });
    await t.synthesize("We have three warehouses.");
    const sent = body.contents[0].parts[0].text;
    // Google documents the natural-language prompt as the primary driver of
    // tone and delivery. The content must still be present and last.
    expect(sent).toMatch(/conversationally|warmly/i);
    expect(sent.trim().endsWith("We have three warehouses.")).toBe(true);
  });
});
