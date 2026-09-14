/**
 * Shared request/response translation for the two Gemini adapters
 * (AI Studio free tier and Vertex paid). Handles multimodal content:
 * Anthropic-style base64 image/document blocks → Gemini inline_data parts.
 * Gemini reads PDFs natively, so `document` blocks map the same way.
 */
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
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export function parseGeminiResponse(data: GeminiResponse): {
  text: string;
  tokensIn: number;
  tokensOut: number;
} {
  return {
    text: data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "",
    tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}
