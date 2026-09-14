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
}

export interface TtsResult {
  /** Base64 WAV audio, ready for data: URL playback. */
  audioBase64: string;
  mime: "audio/wav";
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
  const model = opts.model ?? process.env.GEMINI_TTS_MODEL ?? "gemini-2.5-flash-preview-tts";
  const defaultVoice = opts.voice ?? process.env.GEMINI_TTS_VOICE ?? "Kore";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com";

  return {
    isConfigured: () => Boolean(opts.apiKey),
    model,
    defaultVoice,

    async synthesize(text: string, voice?: string): Promise<TtsResult> {
      const voiceName = voice ?? defaultVoice;
      const res = await fetchImpl(
        `${baseUrl}/v1beta/models/${model}:generateContent?key=${opts.apiKey}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text }] }],
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
      };
      const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (!inline?.data) throw new Error("tts: no audio in response");

      // Gemini returns audio/L16 (raw PCM) at 24kHz — parse rate if present.
      const rateMatch = /rate=(\d+)/.exec(inline.mimeType ?? "");
      const rate = rateMatch ? Number(rateMatch[1]) : 24000;
      const wav = pcmToWav(Buffer.from(inline.data, "base64"), rate);
      return { audioBase64: wav.toString("base64"), mime: "audio/wav", voice: voiceName, model };
    },
  };
}

export type Tts = ReturnType<typeof makeTts>;
