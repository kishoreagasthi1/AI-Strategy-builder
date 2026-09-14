/**
 * The single internal LLM interface the whole platform talks to.
 * Modules never know (or care) which provider served them.
 */

/**
 * Content blocks use the Anthropic wire shape (the legacy modules already
 * speak it); adapters translate to their own provider's format.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "audio"; source: { type: "base64"; media_type: string; data: string } };

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
}

/** Flatten message content to text (for providers/paths that need it). */
export function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export interface GenerateRequest {
  /** Logical task name — drives routing (e.g. "hypotheses", "synthesis"). */
  task: string;
  messages: LlmMessage[];
  /** Ask the provider for strict JSON conforming to this JSON Schema. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateUsage {
  tokensIn: number;
  tokensOut: number;
  costEstUsd: number;
}

export interface GenerateResult {
  text: string;
  /** Parsed JSON when jsonSchema was requested and parsing succeeded. */
  json?: unknown;
  provider: string;
  model: string;
  usage: GenerateUsage;
  latencyMs: number;
}

/**
 * A provider adapter normalizes ONE provider's quirks: auth, request shape,
 * JSON mode, token accounting. Adding a new LLM = one new file implementing
 * this interface + a registry entry. Nothing else changes.
 */
export interface ProviderAdapter {
  readonly name: string;
  readonly model: string;
  /** Free tiers may train on inputs → never allowed for confidential work. */
  readonly freeTier: boolean;
  /** True when required config (keys/project) is present. */
  isConfigured(): boolean;
  generate(req: GenerateRequest): Promise<Omit<GenerateResult, "provider" | "latencyMs">>;
}

/** USD per 1M tokens (input, output) — kept in one place, easy to update. */
export const PRICE_TABLE: Record<string, { in: number; out: number }> = {
  "gemini-2.5-flash": { in: 0.30, out: 2.50 },
  "gemini-2.5-flash-lite": { in: 0.10, out: 0.40 },
  "claude-sonnet-4-5": { in: 3.00, out: 15.00 },
  "gpt-4o-mini": { in: 0.15, out: 0.60 },
};

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICE_TABLE[model];
  if (!p) return 0;
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}
