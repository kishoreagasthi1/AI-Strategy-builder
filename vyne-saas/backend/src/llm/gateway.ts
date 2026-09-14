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

  async generate(ctx: GatewayCallContext, req: GenerateRequest): Promise<GenerateResult> {
    if (this.opts.limitCheck) {
      const limit = await this.opts.limitCheck(ctx.tenantId);
      if (!limit.allowed) {
        throw new GatewayError(429, limit.reason ?? "plan_limit_exceeded");
      }
    }

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

    if (sawTransient) {
      throw new GatewayError(
        503,
        `The AI service is briefly at capacity — please try again in a few seconds. (${errors.join(" | ")})`
      );
    }
    throw new GatewayError(502, `all providers failed: ${errors.join(" | ")}`);
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
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}
