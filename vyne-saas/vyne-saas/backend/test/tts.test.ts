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
