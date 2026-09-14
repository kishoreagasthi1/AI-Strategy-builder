/**
 * Voice endpoints — the natural-speech upgrade for the Interview Agent.
 *
 *   POST /api/voice/tts         { text, voice? } → { audioBase64, mime }
 *   POST /api/voice/transcribe  { audioBase64, mimeType, module? } → { text }
 *
 * Both are authenticated (all roles — interviewees are the primary users)
 * and metered into usage_events like every other AI call. Transcription
 * rides the normal gateway (Gemini reads audio natively), so fallback
 * chains and free-tier policy apply automatically.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LlmGateway } from "../llm/gateway.js";
import { GatewayError } from "../llm/gateway.js";
import type { Tts } from "../llm/tts.js";
import type { Meter } from "../llm/gateway.js";

const TtsBody = z.object({
  text: z.string().min(1).max(5_000),
  voice: z.string().max(40).optional(),
  module: z.string().max(80).default("interview_agent"),
});

const TranscribeBody = z.object({
  audioBase64: z.string().max(30_000_000), // ~22MB — several minutes of webm/opus
  mimeType: z.string().max(60),
  module: z.string().max(80).default("interview_agent"),
});

export async function voiceRoutes(
  app: FastifyInstance,
  gateway: LlmGateway,
  tts: Tts,
  meter: Meter
): Promise<void> {
  app.post("/api/voice/tts", async (req, reply) => {
    const ctx = req.ctx!;
    const parsed = TtsBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_input" });
      return;
    }
    if (!tts.isConfigured()) {
      reply.code(503).send({ error: "tts_not_configured" });
      return;
    }
    const started = Date.now();
    try {
      const out = await tts.synthesize(parsed.data.text, parsed.data.voice);
      await meter({
        tenantId: ctx.tenantId, userId: ctx.userId, module: parsed.data.module,
        task: "tts", provider: "gemini-tts", model: out.model,
        tokensIn: Math.ceil(parsed.data.text.length / 4), tokensOut: 0, costEstUsd: 0,
        latencyMs: Date.now() - started, ok: true,
      }).catch(() => {});
      return { audioBase64: out.audioBase64, mime: out.mime, voice: out.voice };
    } catch (err) {
      await meter({
        tenantId: ctx.tenantId, userId: ctx.userId, module: parsed.data.module,
        task: "tts", provider: "gemini-tts", model: tts.model,
        tokensIn: 0, tokensOut: 0, costEstUsd: 0,
        latencyMs: Date.now() - started, ok: false,
      }).catch(() => {});
      req.log.warn({ err }, "tts failed");
      reply.code(502).send({ error: "tts_failed" });
    }
  });

  app.post("/api/voice/transcribe", async (req, reply) => {
    const ctx = req.ctx!;
    const parsed = TranscribeBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_input" });
      return;
    }
    try {
      const result = await gateway.generate(
        { tenantId: ctx.tenantId, userId: ctx.userId, module: parsed.data.module },
        {
          task: "transcribe",
          maxTokens: 8192,
          // Slightly above 0: greedy decoding on quiet audio produces
          // degenerate repetition loops ("the the the…").
          temperature: 0.3,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "audio",
                  source: {
                    type: "base64",
                    media_type: parsed.data.mimeType,
                    data: parsed.data.audioBase64,
                  },
                },
                {
                  type: "text",
                  text:
                    "Transcribe this audio recording exactly as spoken, in the original language. " +
                    "Return ONLY the transcript text — no commentary, no timestamps, no speaker labels. " +
                    "Never output the same word repeated many times. " +
                    "If the audio is silent, unclear, or contains no discernible speech, return exactly: [no speech detected]",
                },
              ],
            },
          ],
        }
      );
      return { text: result.text.trim(), provider: result.provider };
    } catch (err) {
      if (err instanceof GatewayError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      req.log.error({ err }, "transcribe failed");
      reply.code(500).send({ error: "transcribe_failed" });
    }
  });
}
