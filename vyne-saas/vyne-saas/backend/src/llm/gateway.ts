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
}

export type Meter = (event: MeterEvent) => Promise<void>;
export type LimitCheck = (tenantId: string) => Promise<{ allowed: boolean; reason?: string }>;

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
  async checkLimit(tenantId: string): Promise<void> {
    if (this.opts.limitCheck) {
      const limit = await this.opts.limitCheck(tenantId);
      if (!limit.allowed) {
        throw new GatewayError(429, limit.reason ?? "plan_limit_exceeded");
      }
    }
  }

  async generate(ctx: GatewayCallContext, req: GenerateRequest): Promise<GenerateResult> {
    await this.checkLimit(ctx.tenantId);

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

  /** Metering must never take down a successful generation. */
  private async safeMeter(e: MeterEvent): Promise<void> {
    try {
      await this.opts.meter(e);
    } catch {
      // Deliberately swallowed; surfaced via logs in the route layer.
    }
  }
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
