/**
 * Claude via Vertex AI Model Garden — the PREMIUM path for money artifacts
 * (cross-interview synthesis, the 26-slide Strategy Deck).
 * Runs on GCP under enterprise/no-training terms; auth via ADC like Gemini
 * Vertex, so no Anthropic API key needs managing.
 *
 * JSON mode note: Claude has no responseSchema parameter; we instruct via a
 * system suffix and parse. The gateway treats parse failure as adapter
 * failure so the fallback chain can take over.
 */
import { GoogleAuth } from "google-auth-library";
import type { GenerateRequest, ProviderAdapter } from "../types.js";
import { estimateCost, textOf } from "../types.js";

interface VertexClaudeOptions {
  project: string | undefined;
  /** Defaults to "global" — see the default assignment below for why. */
  location?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string>;
}

export function makeAnthropicVertexAdapter(opts: VertexClaudeOptions): ProviderAdapter {
  // "claude-sonnet-4-5" (the previous default) 404s — confirmed via the
  // model's own Vertex Model Garden page (Versions table): the current GA
  // release id is "claude-sonnet-5". Anthropic's own Vertex SDK docs for
  // this model also confirm: model is never a request parameter — the
  // Google Cloud endpoint URL is the only place it's specified — matching
  // this adapter's existing URL-only placement.
  const model = opts.model ?? "claude-sonnet-5";
  // Confirmed from the same page's SDK sample (LOCATION = "global"): this
  // model is served from location "global", not a specific region like
  // the old "us-east5" default (a stale assumption from when this adapter
  // was first written — Claude on Vertex has since moved to a global
  // endpoint, same newer pattern as gemini-vertex). See host computation
  // in generate() below for how "global" changes the request hostname.
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
    name: "anthropic-vertex",
    model,
    freeTier: false,
    isConfigured: () => Boolean(opts.project),

    async generate(req: GenerateRequest) {
      // Content blocks are already in Anthropic wire format — pass through.
      let system = req.messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
      if (req.jsonSchema) {
        system +=
          `\n\nRespond ONLY with a single JSON object valid against this JSON Schema, ` +
          `no markdown fences, no commentary:\n${JSON.stringify(req.jsonSchema)}`;
      }
      const messages = req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content }));

      const body = {
        anthropic_version: "vertex-2023-10-16",
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.7,
        ...(system ? { system } : {}),
        messages,
      };

      // The global endpoint has no regional hostname prefix — only
      // per-region endpoints do (matches gemini-vertex.ts's same fix).
      const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
      const url =
        `https://${host}/v1/projects/${opts.project}` +
        `/locations/${location}/publishers/anthropic/models/${model}:rawPredict`;

      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await getToken()}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`anthropic-vertex ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (data.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      const tokensIn = data.usage?.input_tokens ?? 0;
      const tokensOut = data.usage?.output_tokens ?? 0;

      let json: unknown;
      if (req.jsonSchema) {
        const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        try {
          json = JSON.parse(cleaned);
        } catch {
          throw new Error("anthropic-vertex: response was not valid JSON for requested schema");
        }
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
