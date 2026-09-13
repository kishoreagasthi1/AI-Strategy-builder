/**
 * Which credential serves THIS call. (v5.34.59 — BYOK slice 2)
 *
 * Slice 1 stored a client's key. Nothing read it: `activeKeyFor()` and
 * `getTenantKey()` had no callers, so a client could hand over a credential and
 * it changed nothing about who Google billed. This is the half that spends it.
 *
 * ── The bleed this is designed against ──────────────────────────────────────
 *
 * Every ProviderAdapter in this codebase is a boot-time singleton that CLOSES
 * OVER one credential (`opts.apiKey` in geminiAiStudio.ts, anthropicApi.ts).
 * The obvious way to add BYOK — swap the key on the singleton, or cache an
 * adapter per client in a module-level Map — is also the way to bill client A's
 * interview to client B: two concurrent requests share the same object, and
 * whichever mutated it last wins for both. That is the exact fault migration
 * 031 and secretIdFor() were each written to prevent, one layer further up.
 *
 * So: this module NEVER mutates a singleton and NEVER caches an adapter. It
 * builds a fresh adapter, closing over the resolved key, on every call, and
 * hands it back as a per-call value that the gateway holds in a local map for
 * the duration of one generate(). A per-call value cannot bleed into another
 * call because nothing else can reach it.
 *
 * The KEY itself is cached (secretStore.ts, 5 minutes, keyed on the versioned
 * secret resource name — which contains the tenant, the client and the
 * provider). That cache is safe for the same reason the adapter cache would not
 * be: its key identifies exactly one client's credential, so a hit can only
 * ever return the value that was stored for it.
 *
 * ── Substitution, not re-routing ────────────────────────────────────────────
 *
 * A client's key is used where the ROUTER ALREADY WANTED THAT VENDOR, in the
 * router's own order of preference. If the chain for a task is
 * ["anthropic-vertex", "gemini-vertex"], a client who brought both keys gets
 * ["anthropic-api", "gemini-aistudio", ...] in front of it — Claude still
 * first, because that is what the task's policy says a strategy deck deserves.
 *
 * The alternative (prepend every key the client has) would mean a client's
 * Anthropic key silently moving a Gemini-routed task onto Claude: a different
 * model behind a client deliverable, chosen by who happened to supply a
 * credential. Vendor substitution keeps the routing decision where it belongs.
 *
 * A key for a vendor the task's chain never mentions simply goes unused for
 * that task. That is the correct outcome, not a gap.
 *
 * ── Fallback is never failure ───────────────────────────────────────────────
 *
 * Every failure here — no row, no secret, Secret Manager down, a revoked key —
 * falls back to the platform credential and the firm's own bill. An interview
 * must not stop because a client's key lapsed; the firm eats that cost until
 * someone fixes it, which is the right way round (byokRepo.ts says the same).
 */
import type { ProviderAdapter } from "../types.js";
import { makeGeminiAiStudioAdapter } from "../adapters/geminiAiStudio.js";
import { makeAnthropicApiAdapter } from "../adapters/anthropicApi.js";
import { activeKeyFor, type ByokProvider } from "./byokRepo.js";
import { getTenantKey, type SecretStoreOptions } from "./secretStore.js";

/**
 * Adapter names a BYOK provider can be served through.
 *
 * gemini-aistudio-2 is the same Google AI Studio key on a second model — a
 * separate quota pool, which is why it is a useful fallback rather than a
 * duplicate. Both are built from the client's key when the client has one.
 *
 * Vertex adapter names are ABSENT and must stay absent: they authenticate with
 * the platform's Application Default Credentials and have nowhere to put an API
 * key, so listing one here would silently run a client's work on the firm's
 * account while telling everyone it was the client's. Migration 031's CHECK
 * constraint says the same thing about the database; byokAdapterNames.test.ts
 * asserts it about this table.
 */
export const BYOK_ADAPTER_NAMES: Record<ByokProvider, readonly string[]> = {
  "gemini-aistudio": ["gemini-aistudio", "gemini-aistudio-2"],
  "anthropic-api": ["anthropic-api"],
};

/**
 * Which vendor's credential an adapter name spends.
 *
 * This is the substitution table: a chain entry maps to the BYOK provider that
 * can stand in for it. Vertex entries map to their vendor because a client's
 * key for that VENDOR is a legitimate substitute for the firm's Vertex access —
 * same model family, same vendor, different payer. `openai` is deliberately
 * absent: no BYOK provider exists for it, so nothing substitutes.
 */
export const VENDOR_OF_ADAPTER: Readonly<Record<string, ByokProvider>> = {
  "gemini-vertex": "gemini-aistudio",
  "gemini-aistudio": "gemini-aistudio",
  "gemini-aistudio-2": "gemini-aistudio",
  "anthropic-vertex": "anthropic-api",
  "anthropic-api": "anthropic-api",
};

/** What a resolved client credential is, minus the credential. */
export interface ByokBinding {
  provider: ByokProvider;
  clientNorm: string;
  clientName: string;
  /** Last four characters — what the Owner sees. Never the key. */
  keyHint: string;
}

export interface ResolvedByok {
  /** adapter name → an adapter bound to the CLIENT's credential, for THIS call. */
  adapters: Map<string, ProviderAdapter>;
  /** adapter name → which client credential backs it (payer + failure handling). */
  backing: Map<string, ByokBinding>;
}

export interface ByokResolverOptions {
  secretStore: SecretStoreOptions;
  /** Models the client's key runs — same as the platform's, unless overridden. */
  geminiModel?: string;
  geminiModel2?: string;
  anthropicModel?: string;
  /** Test seams. Nothing in production passes these. */
  lookup?: typeof activeKeyFor;
  fetchKey?: typeof getTenantKey;
  fetchImpl?: typeof fetch;
  /**
   * A key was on file but could not be used. Never throws upward.
   *
   * `clientNorm` and `reason` are present when the failure is attributable to a
   * specific stored key, so the caller can record it against that row — which
   * is what puts it on the Owner's screen instead of only in a log.
   */
  onResolveError?: (info: {
    tenantId: string; provider: ByokProvider; clientName: string; err: unknown;
    clientNorm?: string; reason?: string;
  }) => void;
  /** The key resolved cleanly — clear any failure recorded against it. */
  onResolveOk?: (info: { tenantId: string; provider: ByokProvider; clientNorm: string }) => void;
}

export interface ByokCallContext {
  tenantId: string;
  clientName?: string;
}

/** Every provider a client can bring a key for. */
const ALL_PROVIDERS: readonly ByokProvider[] = ["gemini-aistudio", "anthropic-api"];

/**
 * Build the per-call credential override set for one (tenant, client).
 *
 * Returns an empty result — never null, never a throw — when the client brought
 * nothing, or when what they brought cannot be read right now.
 */
export function makeByokResolver(opts: ByokResolverOptions) {
  const lookup = opts.lookup ?? activeKeyFor;
  const fetchKey = opts.fetchKey ?? getTenantKey;

  return async function resolveByok(ctx: ByokCallContext): Promise<ResolvedByok> {
    const adapters = new Map<string, ProviderAdapter>();
    const backing = new Map<string, ByokBinding>();
    // Unattributed work is the firm's own — there is no client to bill and no
    // client key to look for. Returning early also keeps cross-client admin
    // work off any one client's account.
    if (!ctx.clientName) return { adapters, backing };

    await Promise.all(ALL_PROVIDERS.map(async (provider) => {
      try {
        const row = await lookup(ctx.tenantId, ctx.clientName, provider);
        if (!row || row.status !== "active" || !row.secretName) return;

        const key = await fetchKey(opts.secretStore, row.secretName);
        if (!key) {
          /*
           * A row says active but the secret cannot be read — deleted,
           * disabled, or a project this service lost permission on. Falling
           * back to the platform credential is right, and the failure is
           * RECORDED (v5.34.61) rather than only logged.
           *
           * This exact state ran unnoticed in production on 2026-09-13: one
           * missing IAM permission, a screen still saying "active", and every
           * call for that client quietly billed to the firm. See migration 033.
           */
          const why = "the key could not be read from Secret Manager — check the service account's permissions";
          opts.onResolveError?.({ tenantId: ctx.tenantId, provider, clientName: ctx.clientName!, err: new Error(why), clientNorm: row.clientNorm, reason: why });
          return;
        }

        const binding: ByokBinding = {
          provider,
          clientNorm: row.clientNorm,
          clientName: row.clientName,
          keyHint: row.keyHint ?? "",
        };
        for (const [name, adapter] of buildAdapters(provider, key, opts)) {
          adapters.set(name, adapter);
          backing.set(name, binding);
        }
        // Resolved cleanly — retire any failure standing against this key.
        opts.onResolveOk?.({ tenantId: ctx.tenantId, provider, clientNorm: row.clientNorm });
      } catch (err) {
        opts.onResolveError?.({
          tenantId: ctx.tenantId, provider, clientName: ctx.clientName!, err,
          reason: `the key could not be resolved: ${(err as Error)?.message ?? "unknown error"}`,
        });
      }
    }));

    return { adapters, backing };
  };
}

/**
 * Fresh adapters over the client's key. Built per call, held by the caller for
 * the length of one generate(), then discarded — see the header.
 *
 * paidTier: true on the Gemini adapters is the attestation doing its job. The
 * client's administrator confirmed in writing that the key belongs to a billed
 * project (ATTESTATION_TEXT, byok.ts), and byok_key_active_requires_attestation
 * makes an active key without that record impossible. Without this flag the
 * adapter would report freeTier and production's blockFreeTier would skip it —
 * the client would have supplied a key that never gets used, and the firm would
 * keep paying. It also switches on cost estimation, so the row still carries a
 * real number even though the charge lands on the client's own account.
 */
function buildAdapters(
  provider: ByokProvider,
  key: string,
  opts: ByokResolverOptions
): Array<[string, ProviderAdapter]> {
  if (provider === "gemini-aistudio") {
    return [
      ["gemini-aistudio", makeGeminiAiStudioAdapter({
        apiKey: key, model: opts.geminiModel, paidTier: true, fetchImpl: opts.fetchImpl,
      })],
      ["gemini-aistudio-2", makeGeminiAiStudioAdapter({
        apiKey: key, name: "gemini-aistudio-2",
        model: opts.geminiModel2 ?? "gemini-3.5-flash", paidTier: true, fetchImpl: opts.fetchImpl,
      })],
    ];
  }
  return [
    ["anthropic-api", makeAnthropicApiAdapter({
      apiKey: key, model: opts.anthropicModel, fetchImpl: opts.fetchImpl,
    })],
  ];
}

/**
 * Interleave the client's own credentials into the chain the router chose, each
 * immediately ahead of the platform adapter for the SAME vendor.
 *
 * ── Why interleaved and not prepended (v5.34.62) ────────────────────────────
 *
 * This used to emit every substitution at the FRONT of the chain, which broke
 * the rule the module header states. With the production chain
 * ["gemini-vertex", "anthropic-vertex"] — Gemini preferred, Claude as fallback
 * — a client who supplied an ANTHROPIC key got:
 *
 *     ["anthropic-api", "gemini-vertex", "anthropic-vertex"]
 *
 * so their strategy deck was written by Claude instead of the Flash model the
 * firm's policy chose, because of who they happened to bank with. A credential
 * decides WHO PAYS. It must not decide WHICH MODEL produces a client
 * deliverable — that is the routing policy's job, and PROD_POLICY says Gemini
 * first for every task.
 *
 * Interleaving gives ["gemini-vertex", "anthropic-api", "anthropic-vertex"]:
 * the vendor order the router asked for, with the client's credential
 * preferred over the firm's within each vendor. A Gemini key, which is the
 * common case, still lands first — because Gemini is first.
 *
 * The original chain stays intact throughout: a client key that fails falls
 * through to the firm's, which is a cost, not an outage.
 */
export function applyByokToChain(chain: readonly string[], available: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (n: string) => { if (!seen.has(n)) { seen.add(n); out.push(n); } };

  const emitted = new Set<ByokProvider>();
  for (const name of chain) {
    const vendor = VENDOR_OF_ADAPTER[name];
    if (vendor && !emitted.has(vendor)) {
      // Only substitute for a vendor this client actually brought a key for.
      const names = BYOK_ADAPTER_NAMES[vendor].filter((n) => available.has(n));
      if (names.length) {
        emitted.add(vendor);
        /*
         * Order the vendor's own adapters by the CHAIN's preference, not by
         * this table's. `transcribe` puts gemini-aistudio-2 first
         * deliberately: audio understanding needs a full Flash model and a
         * lite primary rejects it (router.ts). Emitting the table's order
         * would hand a client's own key a model that cannot do the job, and
         * the failure would look like the key being broken. Adapters the chain
         * does not mention keep table order.
         */
        const rank = (n: string) => { const i = chain.indexOf(n); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
        for (const n of [...names].sort((a, b) => rank(a) - rank(b))) push(n);
      }
    }
    push(name);
  }
  return out;
}

/**
 * Confine a chain to the CLIENT's own credentials. (v5.34.64)
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * A client who has supplied a key runs on that key and nothing else. If it is
 * refused, the call fails. The firm's credential is not reachable for that
 * client — not as a fallback when their key lapses, not for a vendor they never
 * keyed, and not because they stated a model preference.
 *
 * ── What this replaces, and why ─────────────────────────────────────────────
 *
 * Until v5.34.63 applyByokToChain left the firm's adapters in place behind the
 * client's, and the comment above it called a client key that fails "a cost,
 * not an outage". That framing had the firm absorbing the cost of a decision it
 * never made: a revoked key, a project that lost API access or a lapsed billing
 * account all read as business as usual from the consultant's side, while every
 * call moved back onto the firm's account. The key turned red on the screen
 * AFTER the work had already been paid for.
 *
 * The same gap had a second mouth. A preference reorders the chain before
 * substitution, so a client holding a GOOGLE key who asked for Anthropic got
 * the firm's Anthropic adapter first — their key untouched, the firm billed,
 * and the panel asserting in plain text that a preference "never changes who
 * pays". Confinement closes both with one rule instead of two special cases.
 *
 * ── When it does nothing ────────────────────────────────────────────────────
 *
 * `available` empty means this client brought no key: they are on the firm's
 * account by arrangement, the chain is already correct, and nothing here
 * applies. `granted` means the firm has explicitly decided to carry this
 * client's failures (migration 036) — the full chain stands, fallback included.
 *
 * ── The failure this deliberately allows ────────────────────────────────────
 *
 * A live interview CAN now stop because a client's key stopped working. That is
 * the point, and it is a real cost: the interview ends with the client's
 * executive in the room. The grant exists so a firm can choose continuity for a
 * named client in advance. What is no longer available is having that choice
 * made silently, for every client, by a fallback nobody remembered was there.
 */
export function confineToClientCredentials(
  chain: readonly string[],
  available: ReadonlySet<string>,
  opts: { granted: boolean }
): string[] {
  if (!available.size) return [...chain];   // not a BYOK client
  if (opts.granted) return [...chain];      // the firm chose to carry this one
  return chain.filter((name) => available.has(name));
}

/**
 * Is this failure the credential being refused, rather than the service being
 * busy?
 *
 * The distinction decides whether a client's key gets marked failed. A 429 is
 * Google rate-limiting a perfectly good key and must never demote it — doing so
 * would move a client onto the firm's bill because they were briefly popular.
 * A 401/403 means the key is wrong, revoked, or its project lost API access,
 * and the Owner needs to see that on the screen rather than discovering it in
 * an invoice.
 *
 * Checked against the exact strings the two adapters throw:
 *   `gemini-aistudio 403: {...PERMISSION_DENIED...}`
 *   `anthropic-api 401: {...authentication_error...}`
 */
export function isCredentialRejection(message: string): boolean {
  if (/\b(429|500|502|503|504|529)\b/.test(message)) return false;
  return /\b(401|403)\b|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED|authentication_error|invalid[_ ]api[_ ]key|invalid x-api-key/i
    .test(message);
}
