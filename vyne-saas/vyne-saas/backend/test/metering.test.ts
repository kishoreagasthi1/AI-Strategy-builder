/**
 * V225-audit MEDIUM fix: dbLimitCheck now takes a per-tenant advisory lock
 * before reading `used` (see llm/metering.ts's doc comment for exactly
 * what this does and doesn't close). These tests run against real Postgres
 * to prove the new pg_advisory_xact_lock query is valid SQL and doesn't
 * change the check's actual allow/deny behavior, then exercise concurrent
 * calls for the same tenant to prove they don't deadlock or error.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool, withTenant } from "../src/db/pool.js";
import { dbLimitCheck, dbMeter } from "../src/llm/metering.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:change-me-via-ops@localhost:5432/vyne";

describe.skipIf(!ENABLED)("dbLimitCheck (with advisory lock)", () => {
  let admin: pg.Client;
  let unlimitedTenant: string;
  let limitedTenant: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const a = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name, monthly_token_limit) VALUES ('Metering Unlimited', NULL) RETURNING id`);
    unlimitedTenant = a.rows[0].id;
    const b = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name, monthly_token_limit) VALUES ('Metering Limited', 100) RETURNING id`);
    limitedTenant = b.rows[0].id;
    initPool(APP_URL);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[unlimitedTenant, limitedTenant]]);
    await admin.end();
    await closePool();
  });

  it("allows when monthly_token_limit is NULL (unlimited)", async () => {
    const r = await dbLimitCheck(unlimitedTenant);
    expect(r.allowed).toBe(true);
  });

  it("allows under the limit, denies once usage_events push it over", async () => {
    const before = await dbLimitCheck(limitedTenant);
    expect(before.allowed).toBe(true);

    await dbMeter({
      tenantId: limitedTenant, userId: undefined, module: "test", task: "test",
      provider: "test", model: "test", tokensIn: 60, tokensOut: 60, costEstUsd: 0,
      latencyMs: 1, ok: true,
    });

    const after = await dbLimitCheck(limitedTenant);
    expect(after.allowed).toBe(false);
    expect(after.reason).toBe("monthly_token_limit_exceeded");
  });

  it("concurrent calls for the same tenant don't deadlock or error (advisory lock serializes them)", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => dbLimitCheck(unlimitedTenant))
    );
    expect(results.every((r) => r.allowed === true)).toBe(true);
  });

  it("dbMeter still writes usage_events normally alongside the new limit-check query", async () => {
    await dbMeter({
      tenantId: unlimitedTenant, userId: undefined, module: "test", task: "test",
      provider: "test", model: "test", tokensIn: 5, tokensOut: 5, costEstUsd: 0,
      latencyMs: 1, ok: true,
    });
    const count = await withTenant(unlimitedTenant, async (c) => {
      const r = await c.query(`SELECT count(*) FROM usage_events WHERE tenant_id = $1`, [unlimitedTenant]);
      return Number(r.rows[0].count);
    });
    expect(count).toBeGreaterThan(0);
  });
});
