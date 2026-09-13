/**
 * Where a client's own API key lives. (v5.34.50)
 *
 * Secret Manager, one secret per tenant, NEVER a column in our database. A
 * database backup is copied, restored into staging, handed to a contractor and
 * attached to a support ticket; a client credential must not travel with it.
 * Secret Manager also gives access logs and rotation-by-version for free,
 * which a column would have to grow by hand.
 *
 * ── Why REST rather than @google-cloud/secret-manager ───────────────────────
 *
 * The official client pulls gRPC and a large dependency tree into a Cloud Run
 * image for four calls. `google-auth-library` is already a dependency — the
 * Vertex adapters authenticate through it — so this reuses that and adds
 * nothing to the image.
 *
 * ── The key is never logged, never returned in an error, never thrown ───────
 *
 * Every error path here is written to say what FAILED without saying what the
 * value was. The one place a key exists in memory is the return of
 * getTenantKey(), and the caller is expected to hand it straight to an adapter.
 */
import { GoogleAuth } from "google-auth-library";

const SM = "https://secretmanager.googleapis.com/v1";
const TIMEOUT_MS = 15_000;

/**
 * How long a fetched key is reused before Secret Manager is asked again.
 *
 * Zero cache would mean a network round trip on every generate() call — slow,
 * and billed per access. An unbounded cache would mean a rotated or revoked
 * key keeps working indefinitely, which is the opposite of what rotation is
 * for. Five minutes bounds the blast radius of a revocation while removing
 * essentially all of the per-request cost; putTenantKey() and
 * disableTenantKey() also evict immediately, so a rotation this server
 * performs takes effect at once. The stale window only applies to a change
 * made elsewhere — in the console, or by another instance.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { key: string; expires: number }>();

export interface SecretStoreOptions {
  projectId: string;
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string>;
  now?: () => number;
}

/**
 * One secret per (tenant, CLIENT, PROVIDER).
 *
 * ── The bug this replaces, found in an external audit of v5.34.55 ───────────
 *
 * This function took only a tenant id and returned `vyne-byok-<tenant>`. The
 * DATABASE moved to client grain in migration 031; the SECRET STORE did not.
 * So every client's key in a firm was written as a successive VERSION of one
 * shared secret, and getTenantKey read `versions/latest`.
 *
 * Consequence: within a firm, the last client to supply a key became the key
 * every client resolved to. Client A's interview transcripts would have been
 * processed through Client B's Google account, and B billed for A — the exact
 * cross-client leak migration 031 was written to prevent, reintroduced one
 * layer below where it was fixed.
 *
 * Latent rather than live only because no caller resolves a stored key yet.
 * It would have become real the day the gateway resolver shipped.
 *
 * Secret Manager ids allow [A-Za-z0-9_-] up to 255 characters. A uuid (36) plus
 * a normalised client (≤30, already [a-z0-9] only) plus a provider name fits
 * with room to spare.
 */
export function secretIdFor(tenantId: string, clientNorm: string, provider: string): string {
  /*
   * Check the TYPE before the shape. `/^[a-z0-9]+$/.test(undefined)` coerces to
   * the string "undefined" and passes — so a caller that forgot an argument
   * would have produced a real, wrong, shared secret id rather than an error.
   * Found by a test that expected a throw and did not get one.
   */
  for (const [name, v] of [["tenantId", tenantId], ["clientNorm", clientNorm], ["provider", provider]] as const) {
    if (typeof v !== "string" || v.length === 0) throw new Error(`byok: ${name} is required`);
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(tenantId)) throw new Error("byok: tenantId is not a uuid");
  if (!/^[a-z0-9]{1,40}$/.test(clientNorm)) throw new Error("byok: clientNorm is not normalised");
  if (!/^[a-z0-9-]{1,40}$/.test(provider)) throw new Error("byok: provider is not a known name");
  return `vyne-byok-${tenantId}-${clientNorm}-${provider}`;
}

function tokenGetter(opts: SecretStoreOptions): () => Promise<string> {
  if (opts.getAccessToken) return opts.getAccessToken;
  const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  return async () => {
    const client = await auth.getClient();
    const t = await client.getAccessToken();
    const token = typeof t === "string" ? t : t?.token;
    if (!token) throw new Error("byok: could not obtain a Google access token");
    return token;
  };
}

async function call(
  opts: SecretStoreOptions,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = await tokenGetter(opts)();
  const res = await fetchImpl(`${SM}${path}`, {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error bodies happen */ }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Store (or rotate) a tenant's key. Creates the secret on first use, then adds
 * a version — so rotation keeps the history rather than overwriting it.
 *
 * Returns the resource name to persist on tenants.byok_secret_name, and the
 * last four characters as a hint the UI can show. The hint is four characters
 * on purpose: enough for a person to recognise which key they pasted, not
 * enough to be useful to anyone else.
 */
export async function putTenantKey(
  opts: SecretStoreOptions,
  ref: { tenantId: string; clientNorm: string; provider: string },
  key: string
): Promise<{ secretName: string; version: string; keyHint: string }> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("byok: refusing to store an empty key");
  const id = secretIdFor(ref.tenantId, ref.clientNorm, ref.provider);
  const secretName = `projects/${opts.projectId}/secrets/${id}`;

  // Create is idempotent enough: 409 ALREADY_EXISTS is the normal path on
  // every rotation after the first, and is not an error.
  const created = await call(opts, "POST", `/projects/${opts.projectId}/secrets?secretId=${id}`, {
    replication: { automatic: {} },
    labels: { app: "vyne", purpose: "byok" },
  });
  if (!created.ok && created.status !== 409) {
    throw new Error(`byok: could not create the secret (HTTP ${created.status})`);
  }

  const added = await call(opts, "POST", `/${secretName}:addVersion`, {
    payload: { data: Buffer.from(trimmed, "utf8").toString("base64") },
  });
  if (!added.ok) throw new Error(`byok: could not store the key (HTTP ${added.status})`);

  /*
   * Return the VERSIONED resource name, and persist that.
   *
   * Reading `versions/latest` was the second half of the audit finding: even
   * with per-client secrets, "latest" is whatever was written most recently,
   * so a rotation racing a read serves the wrong key. A pinned version is
   * unambiguous, and it makes the cache key change on rotation for free —
   * a stale cached key becomes impossible rather than merely short-lived.
   */
  const version = String(added.json?.name ?? "").split("/").pop() || "latest";
  cache.delete(secretName);
  cache.delete(`${secretName}/versions/${version}`);
  return { secretName: `${secretName}/versions/${version}`, version, keyHint: trimmed.slice(-4) };
}

/** Fetch a tenant's key, briefly cached. Returns null when there is none. */
export async function getTenantKey(
  opts: SecretStoreOptions,
  secretName: string
): Promise<string | null> {
  const now = (opts.now ?? Date.now)();
  const hit = cache.get(secretName);
  if (hit && hit.expires > now) return hit.key;

  /*
   * secretName is expected to be VERSIONED (…/versions/7). The unversioned
   * fallback exists only so a name written before v5.34.57 still resolves; it
   * reads `latest`, which is what the audit flagged, and nothing writes that
   * shape any more.
   */
  const path = secretName.includes("/versions/") ? secretName : `${secretName}/versions/latest`;
  const res = await call(opts, "GET", `/${path}:access`);
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`byok: could not read the key (HTTP ${res.status})`);

  const b64 = res.json?.payload?.data;
  if (typeof b64 !== "string") throw new Error("byok: secret payload was not readable");
  const key = Buffer.from(b64, "base64").toString("utf8").trim();
  if (!key) return null;

  cache.set(secretName, { key, expires: now + CACHE_TTL_MS });
  return key;
}

/**
 * Turn a tenant's key off. Disables the latest version rather than deleting
 * the secret, so the event remains visible in Secret Manager's own history and
 * can be undone if it was a mistake.
 */
export async function disableTenantKey(
  opts: SecretStoreOptions,
  secretName: string
): Promise<void> {
  cache.delete(secretName);
  const path = secretName.includes("/versions/") ? secretName : `${secretName}/versions/latest`;
  const res = await call(opts, "POST", `/${path}:disable`, {});
  // Already gone or already disabled is the desired end state either way.
  if (!res.ok && res.status !== 404 && res.status !== 400) {
    throw new Error(`byok: could not disable the key (HTTP ${res.status})`);
  }
}

/** Test seam: drop everything cached. Not used in production paths. */
export function _clearByokCache(): void {
  cache.clear();
}
