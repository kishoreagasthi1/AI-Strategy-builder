
/**
 * v5.32.29 (audit Low). No outbound provider call had a timeout and Fastify's
 * requestTimeout was unset, so a provider that accepts a connection and then
 * stalls held a request and the caller's tab for as long as the socket stayed
 * open (Cloud Run's own ceiling is ~20 minutes). 120s is well beyond the
 * slowest legitimate generation this app makes.
 */
const PROVIDER_TIMEOUT_MS = 120_000;

/**
 * Natural text-to-speech for the Interview Agent, via Gemini's TTS models.
 *
 * Why here and not in the browser: browser speechSynthesis is the robotic
 * voice the users complained about. Gemini TTS produces natural, human-like
 * speech, runs on the same AI Studio key / Vertex project the gateway
 * already uses, and stays server-side + metered like every other AI call.
 *
 * Voice is configurable per deployment: GEMINI_TTS_VOICE (default "Kore" —
 * warm, professional). Other prebuilt options include Puck, Charon, Aoede,
 * Fenrir, Leda, Orus, Zephyr.
 *
 * Output: Gemini returns raw 16-bit PCM @ 24kHz; we wrap it in a WAV header
 * so the browser can play it with a plain <audio> element.
 */

export interface TtsOptions {
  apiKey: string | undefined;
  model?: string;
  voice?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /**
   * V225-audit CRITICAL fix: TTS calls generativelanguage.googleapis.com
   * directly (see synthesize() below) rather than going through an
   * llm/adapters/* ProviderAdapter, so it used to have no equivalent of the
   * `freeTier`/blockFreeTier gate every other AI call honors — a free-tier
   * key would silently serve traffic in production. Same meaning as
   * adapters/geminiAiStudio.ts's `paidTier`: true when apiKey is a billed
   * Google AI Studio account. The route layer (routes/voice.ts) checks the
   * resulting `freeTier` flag against the gateway's blockFreeTier policy
   * before calling synthesize().
   */
  paidTier?: boolean;
}

export interface TtsUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface TtsResult {
  /** Base64 WAV audio, ready for data: URL playback. */
  audioBase64: string;
  mime: "audio/wav";
  /**
   * What the provider says this cost, in tokens (v5.32.65, audit V2-L5).
   *
   * The route used to meter TTS as `tokensIn: text.length / 4, tokensOut: 0,
   * costEstUsd: 0`. Audio OUTPUT is the expensive direction — the live-voice
   * pricing in types.ts puts it at twenty times input — so counting only a
   * guess at the input and none of the output recorded the cheap half of a
   * paid call and dropped the rest. Every usage_events row for a TTS call, and
   * therefore every client invoice built from them, understated it to zero.
   *
   * Reported by the API rather than estimated here, so the number in the ledger
   * is the provider's own.
   */
  usage: TtsUsage;
  voice: string;
  model: string;
}

/** Wrap raw PCM (s16le) in a RIFF/WAV container. */
export function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);             // fmt chunk size
  header.writeUInt16LE(1, 20);              // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function makeTts(opts: TtsOptions) {
  // v5.32.33: was pinned to "gemini-2.5-flash-preview-tts", the May-2025
  // preview, which has since gone GA and been superseded. Preview ids get
  // retired — this is exactly the drift version.ts's doc comment warns about,
  // and it is why the id is env-overridable rather than only a literal.
  const model = opts.model ?? process.env.GEMINI_TTS_MODEL ?? "gemini-2.5-flash-tts";

  /**
   * Gemini-TTS is prompt-steered: Google documents the natural-language
   * instruction as "the primary driver of the overall emotional tone and
   * delivery". Sending bare text — which is what this did until v5.32.33 —
   * gets the flat default read, and no voice choice compensates for it.
   *
   * Set GEMINI_TTS_STYLE to "" to disable instantly if a model ever speaks the
   * instruction aloud instead of acting on it. That is the one failure mode
   * worth watching, and it is a config change rather than a deploy.
   */
  const style = process.env.GEMINI_TTS_STYLE
    ?? "Say the following warmly and conversationally, like a senior consultant talking with a peer — unhurried, curious, and natural, not like reading aloud:";
  const defaultVoice = opts.voice ?? process.env.GEMINI_TTS_VOICE ?? "Kore";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com";

  return {
    isConfigured: () => Boolean(opts.apiKey),
    model,
    defaultVoice,
    /** See TtsOptions.paidTier doc comment. */
    freeTier: !opts.paidTier,

    async synthesize(text: string, voice?: string): Promise<TtsResult> {
      const voiceName = voice ?? defaultVoice;
      const res = await fetchImpl(
        `${baseUrl}/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
          // v5.32.3: see geminiAiStudio.ts's adapter for the full
          // explanation — Google's newer "AQ."-prefixed keys 401 with
          // ACCESS_TOKEN_TYPE_UNSUPPORTED via `?key=`; the `x-goog-api-key`
          // header works for both old and new key formats.
          headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey ?? "" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: style ? style + "\n\n" + text : text }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName } },
              },
            },
          }),
        }
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`tts ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (!inline?.data) throw new Error("tts: no audio in response");

      // Gemini returns audio/L16 (raw PCM) at 24kHz — parse rate if present.
      const rateMatch = /rate=(\d+)/.exec(inline.mimeType ?? "");
      const rate = rateMatch ? Number(rateMatch[1]) : 24000;
      const wav = pcmToWav(Buffer.from(inline.data, "base64"), rate);
      return {
        audioBase64: wav.toString("base64"), mime: "audio/wav", voice: voiceName, model,
        usage: {
          tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
          tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    },
  };
}

export type Tts = ReturnType<typeof makeTts>;
