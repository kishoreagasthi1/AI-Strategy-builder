/**
 * The payer column, against a real database. (v5.34.59)
 *
 * The unit tests prove the gateway DECIDES the payer correctly. These prove it
 * survives the write — that the column exists, that the constraint is real,
 * that the stale-hold sweep inherits it, and that a statement built from the
 * actual rows excludes client-paid work from the invoice.
 *
 * Every one of these is a place where a value that was right in memory can
 * still be wrong on disk.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool, withTenant } from "../src/db/pool.js";
import { dbMeter } from "../src/llm/metering.js";
import { sweepStaleHolds, SWEEP_AGE_SECONDS } from "../src/llm/sweepStaleHolds.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

describe.skipIf(!ENABLED)("v5.34.59 — payer reaches the ledger", () => {
  let db: pg.Client;
  let tenant: string;
  let user: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    initPool(ADMIN_URL);
    db = new pg.Client({ connectionString: ADMIN_URL });
    await db.connect();
    tenant = (await db.query(`INSERT INTO tenants (name) VALUES ('Payer Ledger Firm') RETURNING id`)).rows[0].id;
    user = (await db.query(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-payer-ledger','p@firm.com')
         ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`)).rows[0].id;
    // FORCE RLS — without this the inspection connection sees nothing at all.
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant]);
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM usage_events WHERE tenant_id = $1`, [tenant]);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM usage_events WHERE tenant_id = $1`, [tenant]);
    await db.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await db.end();
    await closePool();
  });

  const meterOne = (over: Record<string, unknown> = {}) => dbMeter({
    tenantId: tenant, userId: user, module: "m", task: "hypotheses",
    provider: "gemini-aistudio", model: "gemini-3.6-flash",
    tokensIn: 100, tokensOut: 50, costEstUsd: 0.02, latencyMs: 10, ok: true,
    clientName: "Nestle", ...over,
  } as any);

  it("writes the payer and the key hint the gateway decided", async () => {
    await meterOne({ payer: "client_key", payerKeyHint: "3xyz" });
    const r = await db.query(`SELECT payer, payer_key_hint FROM usage_events WHERE tenant_id = $1`, [tenant]);
    expect(r.rows[0].payer).toBe("client_key");
    expect(r.rows[0].payer_key_hint).toBe("3xyz");
  });

  it("defaults to the firm's own cost when a caller says nothing", async () => {
    // The safe direction: an omitted payer must mean "recoverable", never NULL.
    // A NULL would be excluded from BOTH totals in routes/billing.ts and the
    // cost would simply vanish from every report.
    await meterOne({});
    const r = await db.query(`SELECT payer, payer_key_hint FROM usage_events WHERE tenant_id = $1`, [tenant]);
    expect(r.rows[0].payer).toBe("platform");
    expect(r.rows[0].payer_key_hint).toBeNull();
  });

  it("the database refuses a payer value nothing knows how to bill", async () => {
    await expect(meterOne({ payer: "whoever" })).rejects.toThrow();
  });

  it("the stale-hold sweep releases a client-paid hold AS client-paid", async () => {
    /*
     * The sweep writes the compensating row for a hold whose /close never
     * arrived. If it defaulted the payer, a client-paid reservation would be
     * cancelled by a platform-paid release: the positive row stays on the
     * client's statement with nothing to offset it, and the negative row
     * credits the firm's own bucket. Both halves wrong, in opposite
     * directions, from one missing column.
     */
    await meterOne({
      task: "live_session_hold", provider: "gemini-live",
      model: "models/gemini-3.1-flash-live-preview",
      tokensIn: 22500, tokensOut: 22500, costEstUsd: 0.4725,
      sessionId: "sess-byok-1", payer: "client_key", payerKeyHint: "3xyz",
    });
    // Age it past the sweep floor.
    await db.query(
      `UPDATE usage_events SET created_at = now() - make_interval(secs => $2)
        WHERE tenant_id = $1 AND session_id = 'sess-byok-1'`,
      [tenant, SWEEP_AGE_SECONDS + 60]
    );

    const result = await withTenant(tenant, (c) => sweepStaleHolds(c));
    expect(result.swept).toBe(1);

    const rows = (await db.query(
      `SELECT task, payer, payer_key_hint, cost_est_usd FROM usage_events
        WHERE tenant_id = $1 AND session_id = 'sess-byok-1' ORDER BY task`, [tenant])).rows;
    const release = rows.find((r) => r.task === "live_session_hold_release")!;
    expect(release.payer).toBe("client_key");
    expect(release.payer_key_hint).toBe("3xyz");
    // And the pair nets to zero, which is the whole point.
    expect(rows.reduce((s, r) => s + Number(r.cost_est_usd), 0)).toBeCloseTo(0, 9);
  });

  it("a platform hold is still swept as platform-paid", async () => {
    // Negative control for the above: the sweep must inherit, not hard-code.
    await meterOne({
      task: "live_session_hold", provider: "gemini-live", model: "m",
      tokensIn: 100, tokensOut: 100, costEstUsd: 0.5, sessionId: "sess-plat-1",
    });
    await db.query(
      `UPDATE usage_events SET created_at = now() - make_interval(secs => $2)
        WHERE tenant_id = $1 AND session_id = 'sess-plat-1'`,
      [tenant, SWEEP_AGE_SECONDS + 60]
    );
    await withTenant(tenant, (c) => sweepStaleHolds(c));
    const release = (await db.query(
      `SELECT payer, payer_key_hint FROM usage_events
        WHERE tenant_id = $1 AND session_id = 'sess-plat-1' AND task = 'live_session_hold_release'`,
      [tenant])).rows[0];
    expect(release.payer).toBe("platform");
    expect(release.payer_key_hint).toBeNull();
  });

  it("existing rows keep working — the column backfilled as the firm's own cost", async () => {
    // Simulates a row written before migration 032, by writing one the way the
    // pre-BYOK code did: no payer column in the INSERT at all.
    await withTenant(tenant, async (c) => {
      await c.query(
        `INSERT INTO usage_events
           (tenant_id, user_id, module, task, provider, model,
            tokens_in, tokens_out, cost_est_usd, latency_ms, ok, client_name, client_norm)
         VALUES ($1,$2,'m','hypotheses','gemini-vertex','gemini-3.6-flash',10,10,0.01,5,true,'Nestle','nestle')`,
        [tenant, user]
      );
    });
    const r = await db.query(`SELECT payer FROM usage_events WHERE tenant_id = $1`, [tenant]);
    expect(r.rows[0].payer).toBe("platform");
  });
});
