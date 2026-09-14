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
import {
  applyByokToChain,
  confineToClientCredentials,
  isCredentialRejection,
  type ByokCallContext,
  type ResolvedByok,
} from "./byok/resolve.js";
import { applyClientVendorPreference } from "./byok/clientRouting.js";
import type { ByokProvider } from "./byok/byokRepo.js";

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
  /**
   * WHO PAID for this call (v5.34.59, BYOK slice 2).
   *
   *   "platform"   — the firm's own credential. The cost is recoverable and
   *                  belongs on the invoice the firm sends this client.
   *   "client_key" — the client's own credential. Google or Anthropic billed
   *                  them DIRECTLY. The row is still written, because the firm
   *                  needs to see the volume and because a plan cap must count
   *                  the work — but putting it on the invoice would charge the
   *                  client a second time for something they have already paid.
   *
   * Absent means "platform": every row written before this field existed, and
   * every path that never had a client credential to begin with.
   */
  payer?: Payer;
  /** Last four characters of the client key that served it. Never the key. */
  payerKeyHint?: string;
}

export type Payer = "platform" | "client_key";

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
  /**
   * Resolve the CLIENT's own credentials for this call (v5.34.59, BYOK slice 2).
   *
   * Injected rather than imported so the gateway keeps knowing nothing about
   * Secret Manager or the database, and so a test can hand it a fake without a
   * network. Returns per-call adapters; see llm/byok/resolve.ts for why they
   * must be per-call and never cached.
   *
   * Absent (every test that predates this, and any deployment without a GCP
   * project) means the gateway behaves exactly as it did before: one chain, the
   * platform's credentials, payer "platform".
   */
  byok?: (ctx: ByokCallContext) => Promise<ResolvedByok>;
  /**
   * A client's key was REFUSED by its vendor — wrong, revoked, or its project
   * lost access. Called once per failed provider per call; the implementation
   * is expected to mark the key failed so the Owner's screen stops claiming it
   * is active. Never awaited into the request path: the call already fell back
   * to the platform credential and must not also wait on a bookkeeping write.
   */
  onByokRejected?: (info: {
    tenantId: string;
    clientName: string;
    provider: ByokProvider;
    adapter: string;
    detail: string;
  }) => void;
  /**
   * The CLIENT's stated model preference, where they have one (v5.34.63).
   *
   * Applied to the chain BEFORE the BYOK substitution, and strictly as a
   * reorder: see llm/byok/clientRouting.ts for why a preference may move
   * vendors around inside the firm's policy but may never step outside it.
   *
   * Absent, or resolving to null, means the firm's policy stands — which is
   * every client who has not asked for anything, i.e. almost all of them.
   */
  clientRouting?: (ctx: ByokCallContext) => Promise<ByokProvider | null>;
  /**
   * May the FIRM's credential cover this client when their own key fails?
   * (v5.34.64 — migration 036)
   *
   * Absent, or resolving false, is the safe answer and the default for every
   * client: a client who supplied a key runs on that key alone, and a refused
   * credential fails the call instead of quietly moving the charge back onto
   * the firm. Resolving true restores the pre-v5.34.64 behaviour for that one
   * client, because the firm decided it should.
   *
   * A lookup that throws is treated as no grant. That direction is deliberate:
   * a database blip must not be able to start spending the firm's money.
   */
  fallbackGrant?: (ctx: ByokCallContext) => Promise<boolean>;
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

/** Shared empty maps — read-only by construction, so sharing them is safe. */
const EMPTY_ADAPTERS: ResolvedByok["adapters"] = new Map();
const EMPTY_BACKING: ResolvedByok["backing"] = new Map();

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

    /*
     * The client's own credentials, for THIS call only (v5.34.59).
     *
     * `byokAdapters` is a LOCAL — a fresh Map built by the resolver on every
     * call and dropped when this function returns. It is deliberately not
     * merged into `this.byName`, and no adapter here is ever cached: a shared
     * adapter object is how one client's key ends up serving another client's
     * interview, which is the whole failure this feature exists to prevent.
     * See llm/byok/resolve.ts.
     *
     * A resolver failure is not a call failure. Falling back to the platform
     * credential costs the firm money; failing the request costs them an
     * interview.
     */
    let byokAdapters: ResolvedByok["adapters"] = EMPTY_ADAPTERS;
    let byokBacking: ResolvedByok["backing"] = EMPTY_BACKING;
    /*
     * v5.34.69. Keys ON FILE that cannot be spent — see ResolvedByok.unusable.
     *
     * Without this, v5.34.64's confinement protected exactly one call: the
     * refusal marked the key `failed`, the next lookup found no ACTIVE key,
     * reported a client with no key at all, and the firm's chain ran silently
     * from then on. The protection has to survive the thing it protects against.
     */
    let byokUnusable: ResolvedByok["unusable"] = [];
    if (this.opts.byok) {
      try {
        const resolved = await this.opts.byok({ tenantId: ctx.tenantId, clientName: ctx.clientName });
        byokAdapters = resolved.adapters;
        byokBacking = resolved.backing;
        byokUnusable = resolved.unusable ?? [];
      } catch {
        // Deliberately swallowed — the resolver reports its own failures
        // through onResolveError, and this path must degrade, not throw.
      }
    }

    /*
     * The chain is built in three steps, and the order of them is the design:
     *
     *   1. the FIRM's policy for this task            (chainForTask)
     *   2. the CLIENT's preference, as a reorder      (applyClientVendorPreference)
     *   3. the CLIENT's own credentials, interleaved  (applyByokToChain)
     *
     * Step 2 can only permute what step 1 produced, so a client can say which
     * of the firm's allowed vendors they would rather have and can never reach
     * one the firm excluded. Step 3 then puts their credential ahead of the
     * firm's for the same vendor. Preference decides WHICH vendor among those
     * allowed; the key decides WHO PAYS. Neither decides the other.
     */
    let preferred: ByokProvider | null = null;
    if (this.opts.clientRouting) {
      try {
        preferred = await this.opts.clientRouting({ tenantId: ctx.tenantId, clientName: ctx.clientName });
      } catch {
        // A preference lookup failing must not fail the call; the firm's
        // policy is the correct thing to fall back to.
      }
    }

    const baseChain = applyClientVendorPreference(
      chainForTask(this.opts.policy, req.task, { defaultChain: this.opts.defaultChainOverride }),
      preferred
    );
    const interleaved = byokAdapters.size
      ? applyByokToChain(baseChain, new Set(byokAdapters.keys()))
      : baseChain;

    /*
     * Step 4 (v5.34.64): confine the chain to the client's OWN credentials
     * unless the firm has granted otherwise for this client.
     *
     * This is what makes step 2's promise true. A preference reorders the
     * chain, and until now a client holding a Google key who asked for
     * Anthropic got the FIRM's Anthropic adapter first — their key untouched,
     * the firm billed, and the screen asserting that a preference "never
     * changes who pays". Confinement removes the firm's adapters from that
     * client's chain entirely, so a preference can only ever permute
     * credentials the client themselves is paying for.
     *
     * It also ends the silent fallback: a refused client key used to carry on
     * down the chain to the platform credential, turning a revoked key into an
     * invoice nobody approved. Now it fails, and says whose key failed.
     */
    let fallbackGranted = false;
    if ((byokAdapters.size || byokUnusable.length) && this.opts.fallbackGrant) {
      try {
        fallbackGranted = await this.opts.fallbackGrant({
          tenantId: ctx.tenantId, clientName: ctx.clientName,
        });
      } catch {
        // No grant on error — a failed lookup must not authorise spending.
      }
    }
    const confined = (byokAdapters.size > 0 || byokUnusable.length > 0) && !fallbackGranted;

    /*
     * A client whose ONLY credentials are unusable has nothing left to try, so
     * there is no chain to walk — refuse here rather than falling through to a
     * chain that would be the firm's. The message names the key's own reason
     * (recorded on the row by v5.34.61) rather than a generic failure.
     */
    if (!byokAdapters.size && byokUnusable.length && !fallbackGranted) {
      const u = byokUnusable[0];
      throw new GatewayError(
        402,
        `${u.clientName} runs on their own API key, and ${u.reason}. ` +
        `Nothing was charged to your account. Fix the key on the Client API keys screen — ` +
        `or turn on the fallback grant for this client if you would rather cover their work ` +
        `while their key is down.`,
        // detail is server-side only, which is where raw upstream text belongs.
        byokUnusable.map((x) => `${x.provider}: ${x.reason}${x.detail ? ` — ${x.detail}` : ""}`).join(" | ")
      );
    }
    const chain = confineToClientCredentials(
      interleaved, new Set(byokAdapters.keys()), { granted: fallbackGranted }
    );
    /** Providers whose credential the vendor has just refused — see below. */
    const rejectedProviders = new Set<ByokProvider>();
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const maxAttempts = 1 + (this.opts.transientRetries ?? 1);
    const errors: string[] = [];
    let sawTransient = false;

    for (const name of chain) {
      /*
       * The client's adapter wins over the platform singleton of the same name.
       * `binding` is non-null exactly when this attempt spends the CLIENT's
       * credential, which is what makes the payer on the metering row below a
       * fact about this attempt rather than a guess about the chain.
       */
      const binding = byokBacking.get(name);
      const adapter = byokAdapters.get(name) ?? this.byName.get(name);
      const payer: Payer = binding ? "client_key" : "platform";
      if (binding && rejectedProviders.has(binding.provider)) {
        // The same credential was refused moments ago by a sibling adapter
        // (gemini-aistudio-2 is the same key on a second model). Retrying it
        // buys a second 403 and a second second of the caller's time.
        errors.push(`${name}: client key already refused by ${binding.provider}`);
        continue;
      }
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
            payer,
            payerKeyHint: binding?.keyHint || undefined,
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
            payer,
            payerKeyHint: binding?.keyHint || undefined,
          });
          /*
           * The client's key was REFUSED (not merely rate-limited). Report it
           * so the Owner's screen stops saying "active", and stop trying this
           * credential for the rest of the call. The request itself carries on
           * down the chain to the platform credential — a lapsed client key
           * must never be the reason an interview stops.
           */
          if (binding && isCredentialRejection(message)) {
            rejectedProviders.add(binding.provider);
            try {
              this.opts.onByokRejected?.({
                tenantId: ctx.tenantId,
                clientName: binding.clientName,
                provider: binding.provider,
                adapter: name,
                detail: message,
              });
            } catch {
              // A bookkeeping reporter must not escalate into the call path.
            }
            errors.push(`${name}: client key refused (${binding.provider})`);
            break; // next adapter — never retry a refused credential
          }
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

    /*
     * v5.34.64. A confined chain reaching this point means the CLIENT's key
     * failed and the firm's was deliberately out of reach. That is a different
     * event from "the AI is down", it has a different remedy, and it must not
     * be reported as an outage — a consultant who reads "all providers failed"
     * will go looking at the platform instead of at their client's key.
     *
     * A transient 429/503 on the client's own key is still transient: their
     * project is being rate-limited, retrying is the right advice, and nothing
     * about that implicates the grant. So the capacity case is checked first.
     */
    if (confined && !sawTransient) {
      const who = ctx.clientName ?? "this client";
      throw new GatewayError(
        402,
        `${who} runs on their own API key, and that key was refused. ` +
        `Nothing was charged to your account. Check the key on the Client API keys screen — ` +
        `or, if you want this client's work to continue on your key when theirs fails, ` +
        `turn on the fallback grant for them there.`,
        detail
      );
    }
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
