/**
 * Short-TTL in-memory caches for the two auth/scoping lookups that ran,
 * uncached, on EVERY protected request (perf review, P1):
 *
 *   · the membership row     — authHook: verified uid → {tenantId, role, email}
 *   · allowedClientNorms()   — moduleState/billing/scorecard scoping
 *
 * Both re-fetched the same rows from Postgres on every call, multiplying DB
 * load ~3× for zero new information (metering.ts even flagged the pattern).
 *
 * PER-INSTANCE, by design. On Cloud Run each instance keeps its own copy, so
 * the short TTL is the cross-instance safety net: an assignment/role change an
 * instance did not observe self-heals within TTL_MS. Explicit invalidation
 * (invalidate* below, wired at the known mutation sites in assignments.ts)
 * clears the LOCAL instance immediately; peers rely on the TTL. If strong
 * cross-instance invalidation is ever required, swap the maps for Redis — the
 * call sites do not change.
 *
 * SECURITY posture:
 *   · Only SUCCESSFUL lookups are cached. A "no membership" / empty result is
 *     never memoised, so a just-added user is not stuck behind a negative cache.
 *   · allowedClientNorms hands back a FRESH Set on every hit (the stored value
 *     is a plain array), so a caller can never mutate another request's scope.
 *   · Owners never touch normsCache — allowedClientNorms() returns null before
 *     any cache read for them.
 */

const TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS || 30_000);
const MAX_ENTRIES = Number(process.env.AUTH_CACHE_MAX || 5_000);
/** Set AUTH_CACHE=0 to disable both caches (loaders run every call). */
const ENABLED = process.env.AUTH_CACHE !== "0";

interface Entry<T> {
  v: T;
  exp: number;
}

/** Tiny TTL + LRU map. Not a hot-path bottleneck; clarity over cleverness. */
class TtlCache<T> {
  private m = new Map<string, Entry<T>>();

  get(key: string): T | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.exp <= Date.now()) {
      this.m.delete(key);
      return undefined;
    }
    // Touch for LRU recency.
    this.m.delete(key);
    this.m.set(key, e);
    return e.v;
  }

  set(key: string, v: T): void {
    if (this.m.has(key)) this.m.delete(key);
    this.m.set(key, { v, exp: Date.now() + TTL_MS });
    // Evict oldest until under the cap (Map preserves insertion/rescheduling order).
    while (this.m.size > MAX_ENTRIES) {
      const oldest = this.m.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.m.delete(oldest);
    }
  }

  delete(key: string): void {
    this.m.delete(key);
  }

  deleteWhere(pred: (key: string) => boolean): void {
    for (const k of [...this.m.keys()]) if (pred(k)) this.m.delete(k);
  }

  clear(): void {
    this.m.clear();
  }

  get size(): number {
    return this.m.size;
  }
}

const SEP = "\u0000"; // NUL — cannot appear in a uid, tenant id or user id.

/* ── Membership: verified identity → tenant/role/email ─────────────────────── */

export interface MembershipRow {
  user_id: string;
  tenant_id: string;
  role: string;
  email: string;
}

const membershipCache = new TtlCache<MembershipRow>();

function mKey(uid: string, idpTenantId: string | null): string {
  return uid + SEP + (idpTenantId ?? "");
}

/**
 * Cache the membership resolution keyed on (verified uid, idp tenant) — the
 * exact inputs to the authHook query. Only a real row is cached; a missing
 * membership always re-queries.
 */
export async function cachedMembership(
  uid: string,
  idpTenantId: string | null,
  loader: () => Promise<MembershipRow | undefined>
): Promise<MembershipRow | undefined> {
  if (!ENABLED) return loader();
  const k = mKey(uid, idpTenantId);
  const hit = membershipCache.get(k);
  if (hit) return hit;
  const row = await loader();
  if (row) membershipCache.set(k, row);
  return row;
}

/** Drop every cached membership for a uid (role/tenant change, removal). */
export function invalidateMembershipUid(uid: string): void {
  membershipCache.deleteWhere((k) => k === uid || k.startsWith(uid + SEP));
}

/* ── allowedClientNorms: tenant+user → the set of norms they may see ────────── */

const normsCache = new TtlCache<string[]>();

function nKey(tenantId: string, userId: string): string {
  return tenantId + SEP + userId;
}

/**
 * Cache a consultant's allowed-norm set. The stored value is an array; every
 * hit is materialised into a NEW Set so no caller can poison the cache by
 * mutating the returned set.
 */
export async function cachedAllowedNorms(
  tenantId: string,
  userId: string,
  loader: () => Promise<Set<string>>
): Promise<Set<string>> {
  if (!ENABLED) return loader();
  const k = nKey(tenantId, userId);
  const hit = normsCache.get(k);
  if (hit) return new Set(hit);
  const set = await loader();
  normsCache.set(k, [...set]);
  return set;
}

/** One user's scope changed (assignment add/remove, team removal). */
export function invalidateNorms(tenantId: string, userId: string): void {
  normsCache.delete(nKey(tenantId, userId));
}

/** A tenant-wide scope change (client delete/rename moves many users' norms). */
export function invalidateTenantNorms(tenantId: string): void {
  normsCache.deleteWhere((k) => k.startsWith(tenantId + SEP));
}

/** Test hook: wipe everything. */
export function _resetAuthCaches(): void {
  membershipCache.clear();
  normsCache.clear();
}
