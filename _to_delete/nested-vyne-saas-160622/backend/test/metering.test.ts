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

  // ── The daily per-user cap and live-session holds (v5.32.49) ──────────────
  //
  // Reproduces the production lockout exactly: a consultant denied at 501,590
  // "used" tokens, of which 21,590 was real work and the rest was live-session
  // hold accounting — a legacy partial-refund pair plus a hold whose release
  // never arrived. The MONTHLY sum had always aged these out; the daily sum had
  // no task filter at all, and nothing tested it.
  it("stale live-session holds do NOT consume the daily per-user cap", async () => {
    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name, monthly_token_limit, daily_user_token_limit)
       VALUES ('Metering Holds', 100000000, 500000) RETURNING id`);
    const tenant = t.rows[0].id;
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-holds', 'holds@firm.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    const user = u.rows[0].id;

    // Written directly and backdated an hour: dbMeter stamps now(), and the
    // whole point is a hold older than any session that could still be running.
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    for (const [task, tin, tout] of [
      ["live_session_reserve", 877500, 877500],   // legacy scheme
      ["live_session_refund", -675000, -675000],  // legacy PARTIAL refund
      ["live_session_hold", 37500, 37500],        // release never arrived
    ] as [string, number, number][]) {
      await admin.query(
        `INSERT INTO usage_events (tenant_id, user_id, module, task, provider, model,
                                   tokens_in, tokens_out, cost_est_usd, latency_ms, ok, created_at)
         VALUES ($1,$2,'interview_agent',$3,'gemini-live','m',$4,$5,0,0,true, now() - interval '1 hour')`,
        [tenant, user, task, tin, tout]);
    }
    await admin.query("COMMIT");

    // 480,000 by the old arithmetic before a single word was spoken.
    const holdsOnly = await dbLimitCheck(tenant, user);
    expect(holdsOnly.allowed).toBe(true);

    // Plus the real work, this is the 501,590 that got the account denied.
    await dbMeter({
      tenantId: tenant, userId: user, module: "interview_agent", task: "legacy",
      provider: "p", model: "m", tokensIn: 10795, tokensOut: 10795, costEstUsd: 0,
      latencyMs: 1, ok: true,
    });
    const withRealWork = await dbLimitCheck(tenant, user);
    expect(withRealWork.allowed).toBe(true);

    // A hold placed RIGHT NOW must still count, though. It reserves budget for
    // a session that could genuinely be running, and dropping it would let
    // concurrent sessions each see money the others have already claimed.
    await dbMeter({
      tenantId: tenant, userId: user, module: "interview_agent", task: "live_session_hold",
      provider: "gemini-live", model: "m", tokensIn: 250000, tokensOut: 250000,
      costEstUsd: 0, latencyMs: 0, ok: true,
    });
    const withFreshHold = await dbLimitCheck(tenant, user);
    expect(withFreshHold.allowed).toBe(false);
    expect(withFreshHold.reason).toBe("daily_user_token_limit_exceeded");

    await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
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
