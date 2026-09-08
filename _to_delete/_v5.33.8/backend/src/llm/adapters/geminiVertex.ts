/**
 * Gemini via Vertex AI — the PRODUCTION low-cost path.
 * Paid endpoint, per-project quotas, no-training terms. Auth via ADC
 * (service account on Cloud Run; GOOGLE_APPLICATION_CREDENTIALS locally).
 */
import { GoogleAuth } from "google-auth-library";
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


interface VertexGeminiOptions {
  project: string | undefined;
  location?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Injectable token getter for tests. */
  getAccessToken?: () => Promise<string>;
}

export function makeGeminiVertexAdapter(opts: VertexGeminiOptions): ProviderAdapter {
  // "gemini-flash-latest" (the previous default) is an AI Studio-only
  // rolling alias — it 404s on Vertex's publishers/google/models endpoint,
  // which requires a specific, non-aliased model id. Confirmed via the
  // model's own Vertex Model Garden page (Versions table): GA release id
  // is "gemini-3.6-flash". NOTE: if GEMINI_MODEL is ever set explicitly
  // (index.ts passes it to this adapter AND both AI Studio adapters), it
  // overrides this default too — an AI-Studio-style alias set there would
  // 404 here the same way. Leave GEMINI_MODEL unset unless pinning to a
  // Vertex-valid id specifically.
  const model = opts.model ?? "gemini-3.6-flash";
  // Confirmed from the same Model Garden sample: this model is called via
  // location "global", not a specific region — a newer Vertex pattern for
  // some models. The global endpoint drops the regional hostname prefix
  // (see the host computation in generate() below).
  const location = opts.location ?? "global";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  const getToken =
    opts.getAccessToken ??
    (async () => {
      const client = await auth.getClient();
      const t = await client.getAccessToken();
      if (!t.token) throw new Error("vertex: failed to obtain access token");
      return t.token;
    });

  return {
    name: "gemini-vertex",
    model,
    freeTier: false,
    isConfigured: () => Boolean(opts.project),

    async generate(req: GenerateRequest) {
      // The global endpoint has no regional hostname prefix — only
      // per-region endpoints do (e.g. us-central1-aiplatform...).
      const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
      const url =
        `https://${host}/v1/projects/${opts.project}` +
        `/locations/${location}/publishers/google/models/${model}:generateContent`;

      const res = await fetchImpl(url, {
        method: "POST",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await getToken()}`,
        },
        body: JSON.stringify(buildGeminiBody(req)),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`gemini-vertex ${res.status}: ${detail.slice(0, 300)}`);
      }
      const { text, tokensIn, tokensOut, finishReason } = parseGeminiResponse(
        (await res.json()) as GeminiResponse
      );

      // V225-audit MEDIUM fix: see adapters/geminiAiStudio.ts's matching
      // comment — silently swallowing a parse failure here used to return
      // a "successful" result with json missing instead of surfacing the
      // failure so the gateway can fall through to the next adapter.
      let json: unknown;
      if (req.jsonSchema) {
        try { json = JSON.parse(text); }
        catch { throw new Error("gemini-vertex: response was not valid JSON for requested schema"); }
      }
      return {
        finishReason,
        text,
        json,
        model,
        usage: { tokensIn, tokensOut, costEstUsd: estimateCost(model, tokensIn, tokensOut) },
      };
    },
  };
}
