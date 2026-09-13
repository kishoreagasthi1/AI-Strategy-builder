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

describe("a model id that is not in this key's catalogue (v5.34.37)", () => {
  /** ListModels shaped like the one that exposed this: no GA flash-tts. */
  const CATALOGUE = {
    models: [
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.5-pro-preview-tts", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.1-flash-tts-preview", supportedGenerationMethods: ["generateContent"] },
    ],
  };
  const audio = {
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: "AAAA" } }] } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
  };

  it("recovers from a 404 by using a TTS model the key really has", async () => {
    const calls: string[] = [];
    const t = makeTts({
      apiKey: "k",
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        if (String(url).includes("/models?")) return { ok: true, status: 200, json: async () => CATALOGUE };
        if (String(url).includes("gemini-2.5-flash-tts:")) {
          return { ok: false, status: 404, text: async () => "not found for API version v1beta" };
        }
        return { ok: true, status: 200, json: async () => audio };
      }) as any,
    });

    const r = await t.synthesize("hello");
    // The audio came back, from a DIFFERENT model than the pinned default.
    expect(r.mime).toBe("audio/wav");
    expect(r.model).toBe("gemini-2.5-flash-preview-tts");
    expect(t.effectiveModel()).toBe("gemini-2.5-flash-preview-tts");
    // …and the sequence was: try the default, ask the catalogue, retry.
    expect(calls.length).toBe(3);
    expect(calls[0]).toContain("gemini-2.5-flash-tts:generateContent");
    expect(calls[1]).toContain("/models?");
    expect(calls[2]).toContain("gemini-2.5-flash-preview-tts:generateContent");
  });

  it("asks the catalogue ONCE — the second call goes straight to what worked", async () => {
    let lists = 0;
    const t = makeTts({
      apiKey: "k",
      fetchImpl: (async (url: string) => {
        if (String(url).includes("/models?")) { lists++; return { ok: true, status: 200, json: async () => CATALOGUE }; }
        if (String(url).includes("gemini-2.5-flash-tts:")) return { ok: false, status: 404, text: async () => "nope" };
        return { ok: true, status: 200, json: async () => audio };
      }) as any,
    });
    await t.synthesize("one");
    await t.synthesize("two");
    expect(lists).toBe(1);
  });

  it("a 404 with no usable TTS model in the catalogue still fails loudly", async () => {
    const t = makeTts({
      apiKey: "k",
      fetchImpl: (async (url: string) => {
        if (String(url).includes("/models?")) {
          return { ok: true, status: 200, json: async () => ({ models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }] }) };
        }
        return { ok: false, status: 404, text: async () => "not found" };
      }) as any,
    });
    await expect(t.synthesize("hello")).rejects.toThrow(/tts 404 \(gemini-2\.5-flash-tts\)/);
  });

  it("a non-404 failure is NOT treated as a wrong model name", async () => {
    // A 429 or a 500 says nothing about the id; re-asking the catalogue would
    // add a pointless round trip to every rate-limited call.
    let lists = 0;
    const t = makeTts({
      apiKey: "k",
      fetchImpl: (async (url: string) => {
        if (String(url).includes("/models?")) { lists++; return { ok: true, status: 200, json: async () => CATALOGUE }; }
        return { ok: false, status: 429, text: async () => "quota" };
      }) as any,
    });
    await expect(t.synthesize("hello")).rejects.toThrow(/tts 429/);
    expect(lists).toBe(0);
  });

  it("an explicit GEMINI_TTS_MODEL is used as-is, with no lookup", async () => {
    const prev = process.env.GEMINI_TTS_MODEL;
    process.env.GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
    try {
      const calls: string[] = [];
      const t = makeTts({
        apiKey: "k",
        fetchImpl: (async (url: string) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => audio }; }) as any,
      });
      const r = await t.synthesize("hello");
      expect(r.model).toBe("gemini-3.1-flash-tts-preview");
      expect(calls.some((c) => c.includes("/models?"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_TTS_MODEL;
      else process.env.GEMINI_TTS_MODEL = prev;
    }
  });
});
