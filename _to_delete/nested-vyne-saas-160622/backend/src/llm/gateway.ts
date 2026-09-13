/**
 * The LLM Gateway — the one door every AI call in the platform goes through.
 *
 * Responsibilities:
 *   1. Resolve the provider chain for the task (routing policy)
 *   2. Enforce the free-tier ban for production/confidential work
 *   3. Try adapters in order until one succeeds (fallback)
 *   4. Meter every attempt's outcome into usage_events (metering-now,
 *      billing-later: these rows are what invoices will be built from)
 *   5. Enforce tenant plan token limits (monthly_token_limit on tenants)
 */
import type { GenerateRequest, GenerateResult, ProviderAdapter } from "./types.js";
import { chainForTask, type RoutingPolicy } from "./router.js";

export interface MeterEvent {
  tenantId: string;
  userId: string | undefined;
  module: string;
  task: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costEstUsd: number;
  latencyMs: number;
  ok: boolean;
  /** Client cost-recovery billing (v5.27) — which of the firm's own clients
   *  this call was for, when known. See routes/billing.ts. */
  clientName?: string;
  /**
   * Live-voice session this row belongs to (v5.32.54). Set on the hold, the
   * hold release and the actual-usage row so a reservation can be matched to
   * its release. Absent on every other kind of call, which is why the index
   * behind it is partial. See migration 015 for what its absence permitted.
   */
  sessionId?: string;
}

export type Meter = (event: MeterEvent) => Promise<void>;
/**
 * v5.32.29 (audit CR-3): userId is now passed so the check can enforce a
 * per-user daily ceiling as well as the tenant's monthly one. The tenant cap
 * bounds the month; without a per-user bound, one account can still burn the
 * whole firm's allowance in an afternoon and deny service to everyone else.
 */
export type LimitCheck = (
  tenantId: string,
  userId?: string | null
) => Promise<{ allowed: boolean; reason?: string }>;

export interface GatewayOptions {
  adapters: ProviderAdapter[];
  policy: RoutingPolicy;
  meter: Meter;
  blockFreeTier: boolean;
  limitCheck?: LimitCheck;
  defaultChainOverride?: string[];
  /** Injectable clock for tests. */
  now?: () => number;
  /** Extra attempts per adapter on transient 429/503 errors (default 1). */
  transientRetries?: number;
  /** Injectable delay for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called when a metering write throws (v5.32.65, audit V2-M4).
   *
   * safeMeter swallows, and it is right to: a billing write must not take down
   * a generation the user already paid for. But its comment claimed the failure
   * was "surfaced via logs in the route layer" and no route layer ever saw it —
   * the exception died inside this class. Since metering rows are, in
   * metering.ts's own words, "the raw material for billing later — do not lose
   * them", losing them silently is the worst available outcome: the money is
   * gone and nothing says so.
   *
   * Injected rather than importing a logger so the gateway stays free of
   * transport concerns and so a test can assert the call was made.
   */
  onMeterError?: (err: unknown, event: MeterEvent) => void;
}

/** Capacity blips worth retrying: rate limits and "high demand" 503s. */
export function isTransientError(message: string): boolean {
  return /\b(429|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|try again later/i.test(message);
}

export interface GatewayCallContext {
  tenantId: string;
  userId?: string;
  module: string;
  /** Client cost-recovery billing (v5.27) — see MeterEvent.clientName. */
  clientName?: string;
}

export class LlmGateway {
  private byName = new Map<string, ProviderAdapter>();

  constructor(private opts: GatewayOptions) {
    for (const a of opts.adapters) this.byName.set(a.name, a);
  }

  /** Adapters that are configured and allowed under current policy. */
  availableProviders(): string[] {
    return [...this.byName.values()]
      .filter((a) => a.isConfigured() && !(this.opts.blockFreeTier && a.freeTier))
      .map((a) => a.name);
  }

  /**
   * Whether free-tier providers are excluded under current policy. Exposed
   * (V225-audit CRITICAL fix) so non-adapter AI paths — currently just TTS,
   * which calls the Gemini AI Studio endpoint directly rather than through a
   * ProviderAdapter — can honor the same production lockdown generate()
   * enforces internally for every other AI call.
   */
  get blockFreeTier(): boolean {
    return this.opts.blockFreeTier;
  }

  /**
   * The same tenant plan/budget pre-flight check generate() runs before
   * every call, exposed standalone (V225-audit CRITICAL fix) for the TTS
   * route, which doesn't go through generate() at all and so used to skip
   * this check entirely — unmetered-before-the-fact, uncapped spend.
   */
  async checkLimit(tenantId: string, userId?: string | null): Promise<void> {
    if (this.opts.limitCheck) {
      const limit = await this.opts.limitCheck(tenantId, userId);
      if (!limit.allowed) {
        throw new GatewayError(429, limit.reason ?? "plan_limit_exceeded");
      }
    }
  }

  async generate(ctx: GatewayCallContext, req: GenerateRequest): Promise<GenerateResult> {
    await this.checkLimit(ctx.tenantId, ctx.userId);

    const chain = chainForTask(this.opts.policy, req.task, {
      defaultChain: this.opts.defaultChainOverride,
    });
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const maxAttempts = 1 + (this.opts.transientRetries ?? 1);
    const errors: string[] = [];
    let sawTransient = false;

    for (const name of chain) {
      const adapter = this.byName.get(name);
      if (!adapter) {
        errors.push(`${name}: unknown adapter`);
        continue;
      }
      if (!adapter.isConfigured()) {
        errors.push(`${name}: not configured`);
        continue;
      }
      if (this.opts.blockFreeTier && adapter.freeTier) {
        errors.push(`${name}: free tier blocked in this environment`);
        continue;
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const started = now();
        try {
          const out = await adapter.generate(req);
          const latencyMs = now() - started;
          await this.safeMeter({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            module: ctx.module,
            clientName: ctx.clientName,
            task: req.task,
            provider: adapter.name,
            model: out.model,
            tokensIn: out.usage.tokensIn,
            tokensOut: out.usage.tokensOut,
            costEstUsd: out.usage.costEstUsd,
            latencyMs,
            ok: true,
          });
          return { ...out, provider: adapter.name, latencyMs };
        } catch (err) {
          const latencyMs = now() - started;
          const message = (err as Error).message;
          await this.safeMeter({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            module: ctx.module,
            clientName: ctx.clientName,
            task: req.task,
            provider: adapter.name,
            model: adapter.model,
            tokensIn: 0,
            tokensOut: 0,
            costEstUsd: 0,
            latencyMs,
            ok: false,
          });
          // Capacity blip (429/503): back off briefly and retry the SAME
          // adapter before falling through — free-tier "high demand" spikes
          // usually clear within a second or two.
          if (isTransientError(message)) {
            sawTransient = true;
            if (attempt < maxAttempts) {
              await sleep(1200 * attempt);
              continue;
            }
          }
          errors.push(`${name}: ${message}`);
          break; // next adapter in the chain
        }
      }
    }

    // V225-audit MEDIUM fix: `errors` accumulates each adapter's raw thrown
    // message, which for HTTP failures includes up to 300 chars of the
    // upstream provider's actual response body (adapters/*.ts's `${status}:
    // ${detail.slice(0,300)}`) — internal infra details, quota/account
    // specifics, occasionally request content reflected back. That used to
    // go straight into the client-facing GatewayError message via routes
    // that do `reply.send({ error: err.message })`. Now it's client-safe
    // by default; the raw detail rides along on `.detail` for server-side
    // logging only (see GatewayError below and its call sites in
    // routes/llm.ts and routes/voice.ts, which log `.detail` via
    // req.log.error but never forward it in the HTTP response).
    const detail = errors.join(" | ");
    if (sawTransient) {
      throw new GatewayError(
        503,
        "The AI service is briefly at capacity — please try again in a few seconds.",
        detail
      );
    }
    throw new GatewayError(502, "All configured AI providers failed to respond.", detail);
  }

  /**
   * Metering must never take down a successful generation — but a lost billing
   * row must never be silent either (v5.32.65, audit V2-M4). Swallow, report.
   */
  private async safeMeter(e: MeterEvent): Promise<void> {
    try {
      await this.opts.meter(e);
    } catch (err) {
      try {
        this.opts.onMeterError?.(err, e);
      } catch {
        // The reporter itself failing must not escalate into the generation
        // path. There is nowhere left to report to at this point.
      }
    }
  }
}

/**
 * v5.32.29 (audit M-5). GatewayError.detail carries up to 300 characters of
 * the provider's raw response, and by that field's own doc comment the
 * provider "occasionally reflects request content back" — which for this
 * product means interview text, briefing content or client names. The v5.25
 * fix correctly stopped that reaching the HTTP response and then routed it
 * straight to Cloud Run logs, which have a broader access model than the
 * database the same content is otherwise protected by.
 *
 * What is actually useful for debugging is the SHAPE of the failure, not the
 * echoed prompt: the error class, the status, quota/model identifiers. This
 * keeps those and drops long free-text runs, which is where reflected content
 * lives. It is a reduction, not a guarantee — logs are still not the place to
 * go looking for provider payloads.
 */
export function redactProviderDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  return String(detail)
    .slice(0, 300)
    // A run of five or more PLAIN ALPHABETIC words separated by single spaces
    // is prose — that is the shape reflected prompt content takes. Identifiers
    // survive because they carry punctuation that breaks the run:
    // RESOURCE_EXHAUSTED, quota=tokens, model=claude-sonnet-4-5.
    .replace(/(?:\b[A-Za-z]{2,}\b ){4,}\b[A-Za-z]{2,}\b/g, "[redacted-text]")
    .replace(/\s+/g, " ")
    .trim();
}

export class GatewayError extends Error {
  /**
   * Server-side-only diagnostic detail (raw adapter/provider error text).
   * NEVER send this in an HTTP response — route handlers should log it
   * (req.log.error({ detail: err.detail }, ...)) and send only `.message`
   * to the client. See the V225-audit MEDIUM fix note where this is thrown.
   */
  public detail?: string;

  constructor(public statusCode: number, message: string, detail?: string) {
    super(message);
    this.detail = detail;
  }
}
