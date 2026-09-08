/**
 * auth/cache.ts — the short-TTL membership + allowed-norms caches (v5.34.0).
 *
 * These sit in front of the two lookups that ran on every protected request,
 * so their correctness is a security property, not just a speed one. The tests
 * pin: a hit skips the loader, a miss runs it, a MISS (empty membership) is
 * never cached, the returned norm set is a fresh copy (no cross-request
 * poisoning), and every invalidation entry point actually drops the entry.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  cachedMembership, invalidateMembershipUid,
  cachedAllowedNorms, invalidateNorms, invalidateTenantNorms,
  _resetAuthCaches,
  type MembershipRow,
} from "../src/auth/cache.js";

const ROW: MembershipRow = { user_id: "u1", tenant_id: "t1", role: "consultant", email: "c@firm.com" };

describe("cachedMembership", () => {
  beforeEach(() => _resetAuthCaches());

  it("runs the loader on a miss and caches a real row", async () => {
    let calls = 0;
    const load = async () => { calls++; return ROW; };
    expect(await cachedMembership("uid", "idp", load)).toEqual(ROW);
    expect(await cachedMembership("uid", "idp", load)).toEqual(ROW);
    expect(calls).toBe(1); // second call served from cache
  });

  it("keys on (uid, idpTenantId) — a different tenant is a different entry", async () => {
    let calls = 0;
    const load = async () => { calls++; return ROW; };
    await cachedMembership("uid", "idpA", load);
    await cachedMembership("uid", "idpB", load);
    expect(calls).toBe(2);
  });

  it("never caches an absent membership (no negative cache)", async () => {
    let calls = 0;
    const load = async () => { calls++; return undefined; };
    await cachedMembership("uid", null, load);
    await cachedMembership("uid", null, load);
    expect(calls).toBe(2); // re-queried every time until a real row appears
  });

  it("invalidateMembershipUid drops every entry for the uid", async () => {
    let calls = 0;
    const load = async () => { calls++; return ROW; };
    await cachedMembership("uid", "idpA", load);
    await cachedMembership("uid", "idpB", load);
    expect(calls).toBe(2);
    invalidateMembershipUid("uid");
    await cachedMembership("uid", "idpA", load);
    await cachedMembership("uid", "idpB", load);
    expect(calls).toBe(4); // both re-loaded after invalidation
  });

  it("invalidating one uid leaves a different uid cached", async () => {
    let a = 0, b = 0;
    await cachedMembership("uidA", null, async () => { a++; return ROW; });
    await cachedMembership("uidB", null, async () => { b++; return ROW; });
    invalidateMembershipUid("uidA");
    await cachedMembership("uidA", null, async () => { a++; return ROW; });
    await cachedMembership("uidB", null, async () => { b++; return ROW; });
    expect(a).toBe(2); // uidA reloaded
    expect(b).toBe(1); // uidB still cached
  });
});

describe("cachedAllowedNorms", () => {
  beforeEach(() => _resetAuthCaches());

  it("caches the set and skips the loader on a hit", async () => {
    let calls = 0;
    const load = async () => { calls++; return new Set(["acme"]); };
    expect([...(await cachedAllowedNorms("t1", "u1", load))]).toEqual(["acme"]);
    expect([...(await cachedAllowedNorms("t1", "u1", load))]).toEqual(["acme"]);
    expect(calls).toBe(1);
  });

  it("returns a FRESH set each hit — mutating it cannot poison the cache", async () => {
    const load = async () => new Set(["acme", "globex"]);
    const first = await cachedAllowedNorms("t1", "u1", load);
    first.add("evilcorp");      // caller tampering with its copy
    first.delete("acme");
    const second = await cachedAllowedNorms("t1", "u1", load);
    expect([...second].sort()).toEqual(["acme", "globex"]); // unaffected
    expect(second).not.toBe(first);
  });

  it("invalidateNorms drops just that user", async () => {
    let calls = 0;
    const load = async () => { calls++; return new Set(["acme"]); };
    await cachedAllowedNorms("t1", "u1", load);
    invalidateNorms("t1", "u1");
    await cachedAllowedNorms("t1", "u1", load);
    expect(calls).toBe(2);
  });

  it("invalidateTenantNorms drops every user in the tenant but no other tenant", async () => {
    let t1a = 0, t1b = 0, t2 = 0;
    await cachedAllowedNorms("t1", "uA", async () => { t1a++; return new Set(["a"]); });
    await cachedAllowedNorms("t1", "uB", async () => { t1b++; return new Set(["b"]); });
    await cachedAllowedNorms("t2", "uC", async () => { t2++; return new Set(["c"]); });
    invalidateTenantNorms("t1");
    await cachedAllowedNorms("t1", "uA", async () => { t1a++; return new Set(["a"]); });
    await cachedAllowedNorms("t1", "uB", async () => { t1b++; return new Set(["b"]); });
    await cachedAllowedNorms("t2", "uC", async () => { t2++; return new Set(["c"]); });
    expect(t1a).toBe(2);
    expect(t1b).toBe(2);
    expect(t2).toBe(1); // other tenant untouched
  });
});
