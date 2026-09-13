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
 * The live session a client's own Google key should mint, or null to mean
 * "use the platform's".
 *
 * Null on every failure — no key, inactive key, unreadable secret, Secret
 * Manager down. An interview must not fail because a client's credential
 * cannot be read; the firm pays for that one and the Owner sees why.
 */
export function makeByokLiveResolver(opts: ByokLiveOptions) {
  const lookup = opts.lookup ?? activeKeyFor;
  const fetchKey = opts.fetchKey ?? getTenantKey;

  return async function resolveByokLive(
    tenantId: string,
    clientName: string | undefined
  ): Promise<ByokLiveBinding | null> {
    if (!clientName) return null;   // unattributed work is the firm's own
    try {
      const row = await lookup(tenantId, clientName, "gemini-aistudio");
      if (!row || row.status !== "active" || !row.secretName) return null;

      const key = await fetchKey(opts.secretStore, row.secretName);
      if (!key) {
        // Recorded against the row, not just logged — see resolve.ts and
        // migration 033 for the production incident this closes.
        const why = "the key could not be read from Secret Manager — check the service account's permissions";
        opts.onResolveError?.({ tenantId, clientName, err: new Error(why), clientNorm: row.clientNorm, reason: why });
        return null;
      }
      opts.onResolveOk?.({ tenantId, clientNorm: row.clientNorm });
      return {
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
      };
    } catch (err) {
      opts.onResolveError?.({
        tenantId, clientName, err,
        reason: `the key could not be resolved: ${(err as Error)?.message ?? "unknown error"}`,
      });
      return null;
    }
  };
}
