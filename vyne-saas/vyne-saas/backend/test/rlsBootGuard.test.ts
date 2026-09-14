/**
 * V225-audit H2 fix — unit coverage for assertRlsEnforceable() (db/pool.ts).
 *
 * This doesn't need a real database: the function's entire job is "read one
 * row back from the connection and decide whether to throw or warn", so a
 * fake pg.Pool-like object standing in for the real thing is enough to
 * exercise every branch without RLS_TEST/a live Postgres.  End-to-end RLS
 * enforcement itself (the actual SET LOCAL + FORCE ROW LEVEL SECURITY
 * behavior) is covered separately by test/rls.test.ts against a real
 * vyne_app connection.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { assertRlsEnforceable } from "../src/db/pool.js";
import type pg from "pg";

function fakePool(row: { is_superuser: boolean; bypass_rls: boolean; role_name: string }) {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [row] }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  };
  return { pool: pool as unknown as pg.Pool, client };
}

describe("assertRlsEnforceable (V225-audit H2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves quietly when the role is neither superuser nor BYPASSRLS", async () => {
    const { pool, client } = fakePool({ is_superuser: false, bypass_rls: false, role_name: "vyne_app" });
    await expect(assertRlsEnforceable(pool, { strict: true })).resolves.toBeUndefined();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("throws in strict mode when the role is a superuser", async () => {
    const { pool } = fakePool({ is_superuser: true, bypass_rls: false, role_name: "vyne" });
    await expect(assertRlsEnforceable(pool, { strict: true })).rejects.toThrow(/superuser/i);
  });

  it("throws in strict mode when the role has BYPASSRLS", async () => {
    const { pool } = fakePool({ is_superuser: false, bypass_rls: true, role_name: "some_admin_role" });
    await expect(assertRlsEnforceable(pool, { strict: true })).rejects.toThrow(/BYPASSRLS/i);
  });

  it("warns but does not throw in non-strict mode", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pool } = fakePool({ is_superuser: true, bypass_rls: false, role_name: "vyne" });
    await expect(assertRlsEnforceable(pool, { strict: false })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/RLS BOOT GUARD/);
  });

  it("always releases the client, even when it throws", async () => {
    const { pool, client } = fakePool({ is_superuser: true, bypass_rls: false, role_name: "vyne" });
    await expect(assertRlsEnforceable(pool, { strict: true })).rejects.toThrow();
    expect(client.release).toHaveBeenCalledOnce();
  });
});
