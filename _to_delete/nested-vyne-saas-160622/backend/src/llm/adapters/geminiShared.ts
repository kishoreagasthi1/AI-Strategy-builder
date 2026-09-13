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
      maxOutputTokens: req.maxTokens ?? 4096,
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
