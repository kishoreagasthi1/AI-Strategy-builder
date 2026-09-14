/**
 * OpenAI adapter — proof that "other popular LLMs" drop in as one file.
 * Disabled unless OPENAI_API_KEY is set; add it to a chain in routing config
 * to activate. Same pattern extends to Mistral, DeepSeek, Groq, etc.
 */
import type { GenerateRequest, ProviderAdapter } from "../types.js";
import { estimateCost } from "../types.js";

interface OpenAiOptions {
  apiKey: string | undefined;
  model?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function makeOpenAiAdapter(opts: OpenAiOptions): ProviderAdapter {
  const model = opts.model ?? "gpt-4o-mini";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? "https://api.openai.com";

  return {
    name: "openai",
    model,
    freeTier: false,
    isConfigured: () => Boolean(opts.apiKey),

    async generate(req: GenerateRequest) {
      // Translate content blocks: text + images map to OpenAI's shapes;
      // base64 documents are unsupported here → throw so the fallback chain
      // hands the call to a provider that can read documents.
      const messages = req.messages.map((m) => {
        if (typeof m.content === "string") return { role: m.role, content: m.content };
        const parts = m.content.map((b) => {
          if (b.type === "text") return { type: "text" as const, text: b.text };
          if (b.type === "image")
            return {
              type: "image_url" as const,
              image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
            };
          throw new Error("openai: base64 document blocks not supported by this adapter");
        });
        return { role: m.role, content: parts };
      });

      const body: Record<string, unknown> = {
        model,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.7,
        messages,
        ...(req.jsonSchema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: "vyne_output", schema: req.jsonSchema, strict: true },
              },
            }
          : {}),
      };

      const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`openai ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content ?? "";
      const tokensIn = data.usage?.prompt_tokens ?? 0;
      const tokensOut = data.usage?.completion_tokens ?? 0;

      // V225-audit MEDIUM fix: see adapters/geminiAiStudio.ts's matching
      // comment — silently swallowing a parse failure here used to return
      // a "successful" result with json missing instead of surfacing the
      // failure so the gateway can fall through to the next adapter.
      let json: unknown;
      if (req.jsonSchema) {
        try { json = JSON.parse(text); }
        catch { throw new Error("openai: response was not valid JSON for requested schema"); }
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
