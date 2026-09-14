/**
 * A client's own key, for REALTIME VOICE. (v5.34.59 — BYOK slice 2)
 *
 * ── Why this is separate from resolve.ts ────────────────────────────────────
 *
 * Live voice does not go through the gateway at all. There is no
 * ProviderAdapter and no generate(): the server mints an ephemeral token
 * against `auth_tokens` and the BROWSER then holds the WebSocket to Google
 * directly, so the audio never crosses this server (llm/liveSession.ts explains
 * why). The credential is spent at mint time and nowhere else.
 *
 * It is also where the money is. Text generation for an engagement costs cents;
 * a 90-minute interview is about $2 of live audio, and a client running a pilot
 * can hold dozens. "Gemini for the voice interviews" is the BYOK request this
 * product actually receives — resolving keys for text and not for voice would
 * be answering a different question from the one asked.
 *
 * ── Same bleed rule as resolve.ts ───────────────────────────────────────────
 *
 * A LiveSession closes over one API key exactly as an adapter does. Nothing
 * here is cached or shared: one is built per mint and discarded. The KEY comes
 * from secretStore's cache, which is keyed on the versioned secret resource
 * name — tenant, client and provider — so a cache hit can only ever return the
 * credential belonging to the client being resolved.
 */
import { makeLiveSession, type LiveSession } from "../liveSession.js";
import { activeKeyFor } from "./byokRepo.js";
import { getTenantKey, type SecretStoreOptions } from "./secretStore.js";

export interface ByokLiveOptions {
  secretStore: SecretStoreOptions;
  /** The model the client's session runs — the same one the platform uses. */
  model?: string;
  voice?: string;
  /** Test seams. Nothing in production passes these. */
  lookup?: typeof activeKeyFor;
  fetchKey?: typeof getTenantKey;
  fetchImpl?: typeof fetch;
  /** See resolve.ts — `clientNorm`/`reason` let the caller record it on the row. */
  onResolveError?: (info: { tenantId: string; clientName: string; err: unknown; clientNorm?: string; reason?: string }) => void;
  /** The key resolved cleanly — clear any failure recorded against it. */
  onResolveOk?: (info: { tenantId: string; clientNorm: string }) => void;
}

export interface ByokLiveBinding {
  live: LiveSession;
  /** Last four characters, for the metering row. Never the key. */
  keyHint: string;
  clientName: string;
}

/**
 * What a client's own Google key can do for this interview. (v5.34.64)
 *
 * ── Why three outcomes and not two ──────────────────────────────────────────
 *
 * This used to return `ByokLiveBinding | null`, and null meant two completely
 * different things: "this client has no key, the firm pays, business as usual"
 * and "this client HAS a key and it does not work". Collapsing them is what let
 * a revoked key turn into a firm-funded interview with nobody deciding that —
 * the caller could not tell the two apart, so it treated both as the ordinary
 * case.
 *
 * They now differ, because they have different right answers: `none` falls
 * through to the platform, `unusable` fails the mint unless the firm has
 * granted fallback for that client (migration 036).
 */
export type ByokLiveResolution =
  /** No key on file for this client. The firm's credential is correct here. */
  | { kind: "none" }
  /** Their key resolved; this session will be minted on it and billed to them. */
  | { kind: "ok"; binding: ByokLiveBinding }
  /**
   * A key IS on file and the vendor REFUSED it, or its secret cannot be read.
   * Whoever called must decide whether the firm covers it.
   *
   * v5.34.69 narrowed this: a key the Owner deliberately switched off, or one
   * never supplied, is `none` — the firm pays, which is what the Owner asked
   * for. Only a credential that stopped working belongs here.
   */
  | { kind: "unusable"; reason: string; clientName: string };

/**
 * Resolve a client's own Google key for a live interview.
 *
 * The failure modes are unchanged from v5.34.59 — no key, inactive key,
 * unreadable secret, Secret Manager down — but they are no longer all reported
 * as "use the platform's". See ByokLiveResolution.
 */
export function makeByokLiveResolver(opts: ByokLiveOptions) {
  const lookup = opts.lookup ?? activeKeyFor;
  const fetchKey = opts.fetchKey ?? getTenantKey;

  return async function resolveByokLive(
    tenantId: string,
    clientName: string | undefined
  ): Promise<ByokLiveResolution> {
    if (!clientName) return { kind: "none" };   // unattributed work is the firm's own
    try {
      const row = await lookup(tenantId, clientName, "gemini-aistudio");
      if (!row) return { kind: "none" };
      /*
       * v5.34.69. `disabled` and `pending` are NOT unusable.
       *
       * v5.34.64 treated every non-active status as "on file and unspendable",
       * which over-applied the rule it was written for. `disabled` means the
       * Owner pressed "turn off" — a deliberate decision to take this client
       * off BYOK and back onto the firm's account — and `pending` means they
       * never supplied a key at all. Refusing an interview in either case
       * contradicts the Owner's own instruction, and contradicted the keys
       * screen, which said in as many words "disabled — running on your key".
       *
       * Only `failed` belongs here: the vendor refused the credential, which is
       * the silent-bill-shift this rule exists to stop. Text does the same —
       * see ResolvedByok.unusable in resolve.ts — so the two paths now agree.
       */
      if (row.status === "failed") {
        /*
         * v5.34.70. row.lastError is NOT interpolated here. It is raw text from
         * whichever writer last touched the column, and recordResolveError
         * stores driver and Secret Manager messages verbatim — see
         * ResolvedByok.unusable in resolve.ts for the full reasoning. The Owner
         * reads it on the keys screen, which is owner-only; this string reaches
         * whoever was in the interview.
         */
        return {
          kind: "unusable", clientName: row.clientName,
          reason: "their key was refused by Google and switched off automatically",
        };
      }
      if (row.status !== "active") return { kind: "none" };
      if (!row.secretName) {
        return {
          kind: "unusable", clientName: row.clientName,
          reason: "their key is on file but was never stored — it has no secret behind it",
        };
      }

      const key = await fetchKey(opts.secretStore, row.secretName);
      if (!key) {
        // Recorded against the row, not just logged — see resolve.ts and
        // migration 033 for the production incident this closes.
        const why = "the key could not be read from Secret Manager — check the service account's permissions";
        opts.onResolveError?.({ tenantId, clientName, err: new Error(why), clientNorm: row.clientNorm, reason: why });
        return { kind: "unusable", clientName: row.clientName, reason: why };
      }
      opts.onResolveOk?.({ tenantId, clientNorm: row.clientNorm });
      return { kind: "ok", binding: {
        /*
         * paidTier: true is the attestation being honoured — the client's
         * administrator confirmed in writing that this key belongs to a billed
         * project, and an active key without that record is impossible
         * (byok_key_active_requires_attestation). Without the flag the route's
         * free-tier lockdown would refuse the session in production, and a
         * client who supplied a key would find their interviews still running
         * on — and billed to — the firm.
         */
        live: makeLiveSession({
          apiKey: key,
          model: opts.model,
          voice: opts.voice,
          paidTier: true,
          fetchImpl: opts.fetchImpl,
        }),
        keyHint: row.keyHint ?? "",
        clientName: row.clientName,
      } };
    } catch (err) {
      const reason = `the key could not be resolved: ${(err as Error)?.message ?? "unknown error"}`;
      opts.onResolveError?.({ tenantId, clientName, err, reason });
      /*
       * v5.34.64. This used to return null — "use the platform's" — for any
       * thrown error, including a Secret Manager outage or a database blip. A
       * client who has supplied a key is a client who is paying; an
       * infrastructure fault on our side must not quietly move their bill onto
       * the firm. `unusable` lets the caller decide, and the safe default at
       * that decision is to stop.
       */
      return { kind: "unusable", clientName, reason };
    }
  };
}
