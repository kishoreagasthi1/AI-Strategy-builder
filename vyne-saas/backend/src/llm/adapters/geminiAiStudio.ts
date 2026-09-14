/**
 * Gemini via Google AI Studio (generativelanguage.googleapis.com).
 *
 * FREE TIER — marked freeTier: true. The router excludes it in production
 * because (a) limits are per-account (1,500 req/day, 15 RPM on Flash), not
 * per-tenant, and (b) free-tier prompts may be used by Google for product
 * improvement — unacceptable for confidential client engagements.
 * It is the DEFAULT for dev/testing, per the platform decision.
 */
import type { GenerateRequest, ProviderAdapter } from "../types.js";
import { buildGeminiBody, parseGeminiResponse, type GeminiResponse } from "./geminiShared.js";

interface GeminiOptions {
  apiKey: string | undefined;
  model?: string;
  /** Register under a custom adapter name (allows several AI Studio
   *  adapters on different models — separate quota pools + capabilities). */
  name?: string;
  /** Set when the key belongs to a BILLED Google AI account (GEMINI_PAID=1):
   *  paid-tier AI Studio has per-key higher quotas and its prompts are not
   *  used for product improvement, so production no longer blocks it. */
  paidTier?: boolean;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function makeGeminiAiStudioAdapter(opts: GeminiOptions): ProviderAdapter {
  // 'gemini-flash-latest' is Google's rolling alias for the newest Flash —
  // pinned model ids (e.g. gemini-2.5-flash) get retired for new accounts.
  const model = opts.model ?? "gemini-flash-latest";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com";

  return {
    name: opts.name ?? "gemini-aistudio",
    model,
    freeTier: !opts.paidTier,
    isConfigured: () => Boolean(opts.apiKey),

    async generate(req: GenerateRequest) {
      const res = await fetchImpl(
        `${baseUrl}/v1beta/models/${model}:generateContent?key=${opts.apiKey}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildGeminiBody(req)),
        }
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`gemini-aistudio ${res.status}: ${detail.slice(0, 300)}`);
      }
      const { text, tokensIn, tokensOut } = parseGeminiResponse(
        (await res.json()) as GeminiResponse
      );

      let json: unknown;
      if (req.jsonSchema) {
        try { json = JSON.parse(text); } catch { /* caller sees raw text */ }
      }
      return {
        text,
        json,
        model,
        usage: { tokensIn, tokensOut, costEstUsd: 0 /* free tier */ },
      };
    },
  };
}
