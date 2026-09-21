/**
 * Shared request/response translation for the two Gemini adapters
 * (AI Studio free tier and Vertex paid). Handles multimodal content:
 * Anthropic-style base64 image/document blocks → Gemini inline_data parts.
 * Gemini reads PDFs natively, so `document` blocks map the same way.
 */
import { normalizeFinishReason } from "../types.js";
import type { GenerateRequest, LlmMessage, ContentBlock } from "../types.js";

type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

function toParts(content: LlmMessage["content"]): GeminiPart[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map((b: ContentBlock): GeminiPart => {
    if (b.type === "text") return { text: b.text };
    return { inline_data: { mime_type: b.source.media_type, data: b.source.data } };
  });
}

/**
 * ── v5.34.102: maxTokens means two different things on the two sides ────────
 *
 * Every caller in this codebase sets maxTokens as "how long an ANSWER do I
 * need" — 400 for a field summary, 900 for a seven-number scorecard, 8000 for
 * a strategy deck. On Gemini's thinking models `maxOutputTokens` is not that:
 * it is the budget for the reasoning AND the reply together, and the reasoning
 * is spent first.
 *
 * Measured against production on 2026-09-14, task interview_score,
 * gemini-3.6-flash, the same prompt twice:
 *
 *   maxTokens  900 -> tokensOut  35, finishReason "length"  (truncated JSON)
 *   maxTokens 4000 -> tokensOut 159, finishReason "stop"    (correct answer)
 *
 * Thirty-five visible tokens out of nine hundred: roughly 865 went on
 * thinking. Under the old translation, every caller asking for a tight answer
 * was quietly asking the model to think in the same breath, and the ones with
 * small budgets got a sentence and a half.
 *
 * Where this actually bit: exactly one caller. vyne-client.js floors every
 * budget that passes through vyneLLM at 8192 (16384 for synthesis) and has
 * since v5.32.23, for this very reason — so the 400s and 900s at the module
 * call sites are inert and were never at risk. The scoring pass in
 * vyne-live-interview.js is the only code in the product that calls
 * /api/llm/generate raw, and it sent its 900 through unfloored.
 *
 * That makes this a defence, not the fix for a widespread fault, and it is
 * worth being clear about which. The narrow fix is the caller's own budget.
 * This exists so that the NEXT raw caller — and the browser floor shows that
 * a raw caller is exactly what gets written eventually — cannot reintroduce
 * it silently. A difference between what the caller means and what the
 * provider's field means belongs in the translation layer, which is the only
 * place that sees both sides.
 *
 * The thinking is deliberately NOT disabled. thinkingConfig: { thinkingBudget:
 * 0 } would also stop the truncation and would cost output quality on every
 * hypothesis, sequencing and design call in the product. The reserve buys the
 * room instead of taking it away.
 *
 * It costs nothing when unused: maxOutputTokens is a ceiling, and billing
 * follows tokens actually produced. GEMINI_THINKING_RESERVE overrides it if a
 * future model needs more (or none).
 */
const THINKING_RESERVE_DEFAULT = 4000;
/** Gemini rejects an out-of-range maxOutputTokens outright, so the sum is capped. */
const MAX_OUTPUT_CEILING = 64_000;

export function geminiThinkingReserve(): number {
  const raw = process.env.GEMINI_THINKING_RESERVE;
  if (raw === undefined || raw === "") return THINKING_RESERVE_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.warn(
      `[geminiShared] GEMINI_THINKING_RESERVE="${raw}" ignored — must be a non-negative integer`,
    );
    return THINKING_RESERVE_DEFAULT;
  }
  return n;
}

export function buildGeminiBody(req: GenerateRequest): Record<string, unknown> {
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  const contents = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: toParts(m.content) }));

  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: {
      // The caller's answer budget PLUS room to think. See the note above.
      maxOutputTokens: Math.min(
        (req.maxTokens ?? 4096) + geminiThinkingReserve(),
        MAX_OUTPUT_CEILING,
      ),
      temperature: req.temperature ?? 0.7,
      ...(req.jsonSchema
        ? { responseMimeType: "application/json", responseSchema: req.jsonSchema }
        : {}),
    },
  };
}

export interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  /**
   * Present when the PROMPT was refused outright, in which case `candidates`
   * is absent entirely. Read only to build a useful error message.
   */
  promptFeedback?: { blockReason?: string };
}

export function parseGeminiResponse(data: GeminiResponse): {
  text: string;
  tokensIn: number;
  tokensOut: number;
  finishReason?: string;
} {
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";

  /*
   * v5.32.65 (audit V2-M5). An empty body used to come back as a SUCCESS.
   *
   * A 200 from Gemini does not mean there is a completion in it. A blocked
   * prompt returns `promptFeedback.blockReason` and no candidates at all; a
   * blocked or recited completion returns a candidate with a finishReason and
   * no parts. Both landed here as text: "" and were returned up the stack as a
   * successful generation — metered, billed, and handed to a caller that then
   * wrote an empty interview summary or an empty solution-design section and
   * showed it to a consultant as finished work.
   *
   * Only the jsonSchema path noticed, and only by accident: JSON.parse("")
   * throws. Every prose call — interview turns, synthesis, the client document
   * — did not.
   *
   * Throwing is the right shape because of what the gateway does with it: an
   * adapter error is metered as a failed attempt and the chain falls through to
   * the next provider, which is exactly the desired behaviour when one provider
   * refuses. Returning "" instead spends the budget and produces nothing.
   *
   * Deliberately in the SHARED parser, not in the two adapters. "The twin was
   * missed" is a recurring defect in this repo, and a third Gemini adapter
   * should inherit this rather than have to remember it.
   */
  if (!text.trim()) {
    const blocked = data.promptFeedback?.blockReason;
    const finish = data.candidates?.[0]?.finishReason;
    const why = blocked
      ? `prompt blocked (${blocked})`
      : finish
      ? `no content returned (finishReason ${finish})`
      : "no content returned";
    throw new Error(`gemini: ${why}`);
  }

  return {
    text,
    tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
    // v5.32.23: Gemini reports MAX_TOKENS here; it was being dropped on the
    // floor, which is why nothing downstream could tell a complete response
    // from a truncated one.
    finishReason: normalizeFinishReason(data.candidates?.[0]?.finishReason),
  };
}
