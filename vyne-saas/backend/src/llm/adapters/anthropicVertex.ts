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
  /** Claude models live in specific regions; us-east5 is the common one. */
  location?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string>;
}

export function makeAnthropicVertexAdapter(opts: VertexClaudeOptions): ProviderAdapter {
  const model = opts.model ?? "claude-sonnet-4-5";
  const location = opts.location ?? "us-east5";
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

      const url =
        `https://${location}-aiplatform.googleapis.com/v1/projects/${opts.project}` +
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
