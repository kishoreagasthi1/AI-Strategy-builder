/**
 * Gemini via Vertex AI — the PRODUCTION low-cost path.
 * Paid endpoint, per-project quotas, no-training terms. Auth via ADC
 * (service account on Cloud Run; GOOGLE_APPLICATION_CREDENTIALS locally).
 */
import { GoogleAuth } from "google-auth-library";
import type { GenerateRequest, ProviderAdapter } from "../types.js";
import { estimateCost } from "../types.js";
import { buildGeminiBody, parseGeminiResponse, type GeminiResponse } from "./geminiShared.js";

interface VertexGeminiOptions {
  project: string | undefined;
  location?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Injectable token getter for tests. */
  getAccessToken?: () => Promise<string>;
}

export function makeGeminiVertexAdapter(opts: VertexGeminiOptions): ProviderAdapter {
  const model = opts.model ?? "gemini-flash-latest";
  const location = opts.location ?? "us-central1";
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
      const url =
        `https://${location}-aiplatform.googleapis.com/v1/projects/${opts.project}` +
        `/locations/${location}/publishers/google/models/${model}:generateContent`;

      const res = await fetchImpl(url, {
        method: "POST",
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
        usage: { tokensIn, tokensOut, costEstUsd: estimateCost(model, tokensIn, tokensOut) },
      };
    },
  };
}
