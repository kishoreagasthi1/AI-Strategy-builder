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
  /**
   * Why the model stopped. v5.32.23 — this did not exist, and neither adapter
   * captured it, so the nine frontend checks for `stop_reason === 'max_tokens'`
   * were comparing against undefined and were dead code. Every "this may have
   * been cut off — try Regenerate" hint in the app was unreachable, and
   * `brief.truncated` was permanently false.
   *
   * Normalised across providers: "length" means the output hit the token
   * ceiling (Anthropic `max_tokens`, Gemini `MAX_TOKENS`), "stop" means the
   * model finished on its own. Anything else is passed through verbatim.
   */
  finishReason?: string;
}

/** Normalise a provider's stop/finish token onto our vocabulary. */
export function normalizeFinishReason(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const v = String(raw).toLowerCase();
  if (v === "max_tokens" || v === "length" || v === "max_token") return "length";
  if (v === "end_turn" || v === "stop" || v === "stop_sequence") return "stop";
  return v;
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

/**
 * USD per 1M tokens (input, output) — kept in one place, easy to update.
 *
 * V225-audit LOW fix: adapters/geminiVertex.ts and adapters/geminiAiStudio.ts
 * both default `model` to "gemini-flash-latest" (Google's rolling alias for
 * the newest Flash — see those files' own comments on why: pinned ids like
 * "gemini-2.5-flash" get retired for new accounts). This table only had the
 * pinned id, so a real, billed Vertex call on the default model silently
 * estimated $0.00 cost (estimateCost() below returns 0 for any unlisted
 * key) — invoices built from usage_events would have quietly undercounted
 * every default-model call. Priced the same as gemini-2.5-flash, since
 * that's what "latest" resolves to today; update both together if Google's
 * Flash pricing changes.
 */
export const PRICE_TABLE: Record<string, { in: number; out: number }> = {
  "gemini-2.5-flash": { in: 0.30, out: 2.50 },
  "gemini-2.5-flash-lite": { in: 0.10, out: 0.40 },
  "gemini-flash-latest": { in: 0.30, out: 2.50 },
  "claude-sonnet-4-5": { in: 3.00, out: 15.00 },
  "gpt-4o-mini": { in: 0.15, out: 0.60 },
  /*
   * v5.32.1 carried these forward from the prior generation as same-tier
   * placeholders, flagged UNCONFIRMED, so that a real billed call would not
   * meter at $0.00. They stayed placeholders through fifty releases, and every
   * usage_events row and every client cost figure for these two models
   * inherited the guess.
   *
   * v5.32.69: checked against the vendors' published rates and corrected. The
   * error was not small — Gemini 3.6 Flash was understated fivefold on input
   * and threefold on output, so the model this product routes MOST traffic to
   * was the one billed most wrongly. Claude Sonnet 5 was overstated, which is
   * the safer direction but still wrong on an invoice.
   *
   *   gemini-3.6-flash   was 0.30 / 2.50   → 1.50 / 7.50
   *   claude-sonnet-5    was 3.00 / 15.00  → 2.00 / 10.00
   *
   * Sonnet 5's $2/$10 was introductory through 31 Aug 2026 and has since been
   * confirmed as the standard rate; the scheduled rise to $3/$15 was cancelled.
   * Re-check both when a model id changes — a stale number here is invisible
   * until someone reconciles an invoice.
   */
  "gemini-3.6-flash": { in: 1.50, out: 7.50 },
  "claude-sonnet-5": { in: 2.00, out: 10.00 },

  // v5.32.32 — REALTIME VOICE. Audio bills very differently from text: output
  // runs 20x input, because generated speech is the expensive direction.
  // These MUST be present before the first live session ships. estimateCost()
  // returns 0 for any unlisted model, so an unlisted live model would meter a
  // real, billed 45-minute interview at $0.00 and the client invoice built
  // from usage_events would omit it entirely — the same silent-undercount
  // failure the two entries above already document once, but on the most
  // expensive call the product makes.
  //
  // Audio tokenises at ~25 tokens/second, so 1M output tokens is roughly 11
  // hours of speech — about $1.80 per hour the model actually talks. A typical
  // 45-minute interview where the interviewer speaks ~15 minutes lands near
  // $0.50 all-in. Cheap, but only if it is counted at all.
  "gemini-live-2.5-flash-preview": { in: 1.00, out: 20.00 },
  "gemini-live-2.5-flash": { in: 1.00, out: 20.00 },
  // v5.32.41 — the NATIVE AUDIO family, which is what the account actually
  // exposes for bidiGenerateContent and what production now runs. Confirmed by
  // querying the key's own model list rather than assuming a name; the earlier
  // guessed id did not exist on this project at all. Priced with the live
  // audio rates — without an entry here a real billed interview meters $0.00.
  "gemini-2.5-flash-native-audio-latest": { in: 1.00, out: 20.00 },
  "gemini-2.5-flash-native-audio-preview-09-2025": { in: 1.00, out: 20.00 },
  "gemini-2.5-flash-native-audio-preview-12-2025": { in: 1.00, out: 20.00 },

  "gemini-3.1-flash-live-preview": { in: 1.00, out: 20.00 },

  // Current-generation batch TTS, replacing the retired May-2025 preview the
  // TTS path was still pinned to.
  //
  // v5.32.65 (audit V2-L5): these entries were already correct and already
  // here. What was wrong was upstream — routes/voice.ts never called
  // estimateCost for TTS at all, passing a literal costEstUsd: 0 and a guessed
  // `text.length / 4` for input with no output token count, so this table was
  // never consulted for the one AI call a consultant can trigger repeatedly by
  // clicking replay. The route now meters the provider's own token counts
  // through estimateCost, which is what makes these numbers reach an invoice.
  "gemini-2.5-flash-tts": { in: 0.15, out: 6.00 },
  "gemini-2.5-pro-tts": { in: 1.25, out: 20.00 },
  "gemini-3.1-flash-tts-preview": { in: 1.00, out: 20.00 },
};

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  // GEMINI_LIVE_MODEL is set to a fully-qualified name ("models/gemini-..."),
  // because that is what the API's own model list returns. PRICE_TABLE is keyed
  // on the bare id, so strip the prefix — otherwise every live session silently
  // meters at $0.00, which is the exact undercount this table exists to prevent.
  const key = model.startsWith("models/") ? model.slice(7) : model;
  const p = PRICE_TABLE[key];
  if (!p) return 0;
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}
