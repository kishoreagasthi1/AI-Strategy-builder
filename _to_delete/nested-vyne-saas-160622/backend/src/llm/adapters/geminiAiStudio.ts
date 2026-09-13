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
import { estimateCost } from "../types.js";
import { buildGeminiBody, parseGeminiResponse, type GeminiResponse } from "./geminiShared.js";

/**
 * v5.32.29 (audit Low). No outbound provider call had a timeout, and Fastify's
 * requestTimeout was unset — so a degraded provider that accepts a connection
 * and then stalls held a request, a DB-free but real server slot, and the
 * caller's browser tab for as long as the socket stayed open (Cloud Run's own
 * ceiling is ~20 minutes). Two of these in flight per pool connection is a
 * self-inflicted outage. 120s is well beyond the slowest legitimate
 * generation observed in this app.
 */
const PROVIDER_TIMEOUT_MS = 120_000;


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
        `${baseUrl}/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
          // v5.32.3: Google's newer "AQ."-prefixed AI Studio keys 401 with
          // ACCESS_TOKEN_TYPE_UNSUPPORTED when passed as a `?key=` query
          // param — that transport only worked for the legacy "AIzaSy..."
          // key format. The header form works for both, per Google's
          // current docs (https://ai.google.dev/gemini-api/docs/api-key).
          headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey ?? "" },
          body: JSON.stringify(buildGeminiBody(req)),
        }
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`gemini-aistudio ${res.status}: ${detail.slice(0, 300)}`);
      }
      const { text, tokensIn, tokensOut, finishReason } = parseGeminiResponse(
        (await res.json()) as GeminiResponse
      );

      // V225-audit MEDIUM fix: this used to swallow a JSON.parse failure
      // and return a "successful" result with json left undefined — a
      // caller that requested jsonSchema gets a 200 with silently missing
      // structured output instead of a clear failure. Throwing here lets
      // gateway.generate() treat it like any other adapter failure: meter
      // it as a failed attempt and fall through to the next adapter in the
      // chain (matching adapters/anthropicVertex.ts, which already did
      // this correctly).
      let json: unknown;
      if (req.jsonSchema) {
        try { json = JSON.parse(text); }
        catch { throw new Error(`${opts.name ?? "gemini-aistudio"}: response was not valid JSON for requested schema`); }
      }
      return {
        finishReason,
        text,
        json,
        model,
        usage: {
          tokensIn, tokensOut,
          /*
           * v5.32.65 (audit V2-L6). Hardcoded 0 with the comment "free tier",
           * which stopped being true when GEMINI_PAID=1 was added: the same
           * adapter, on a billed Google AI account, still wrote $0.00 into
           * every usage_events row. `freeTier: !opts.paidTier` two dozen lines
           * above already knows the difference; the cost line did not.
           *
           * Free tier still meters at zero, because it is zero — and that is
           * now derived from the flag rather than asserted by a comment.
           */
          costEstUsd: opts.paidTier ? estimateCost(model, tokensIn, tokensOut) : 0,
        },
      };
    },
  };
}
