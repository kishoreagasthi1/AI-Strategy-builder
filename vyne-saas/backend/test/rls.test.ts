/**
 * THE Phase 0 acceptance test: Row-Level Security tenant isolation, proven at
 * the database — Tenant A physically cannot read or write Tenant B's rows.
 *
 * Needs a real Postgres. Run with:
 *   docker compose up -d postgres
 *   cd backend && RLS_TEST=1 TEST_DATABASE_URL=postgres://vyne:vyne@localhost:5432/vyne \
 *     RLS_APP_URL=postgres://vyne_app:change-me-via-ops@localhost:5432/vyne npm run test:rls
 *
 * TEST_DATABASE_URL — superuser/owner (runs migrations, seeds tenants)
 * RLS_APP_URL       — the NON-OWNER vyne_app role (what the API uses; RLS applies)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:change-me-via-ops@localhost:5432/vyne";

describe.skipIf(!ENABLED)("Row-Level Security tenant isolation", () => {
  let admin: pg.Client;
  let app: pg.Client;
  let tenantA: string;
  let tenantB: string;
  let engagementB: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    const a = await admin.query(`INSERT INTO tenants (name) VALUES ('Firm A') RETURNING id`);
    const b = await admin.query(`INSERT INTO tenants (name) VALUES ('Firm B') RETURNING id`);
    tenantA = a.rows[0].id;
    tenantB = b.rows[0].id;

    // Seed one engagement per tenant AS the app role, inside tenant context.
    app = new pg.Client({ connectionString: APP_URL });
    await app.connect();
    for (const [tid, name] of [
      [tenantA, "Client of A"],
      [tenantB, "Client of B"],
    ] as const) {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [tid]);
      const r = await app.query(
        `INSERT INTO engagements (tenant_id, client_name)
         VALUES (current_setting('app.tenant_id', true)::uuid, $1) RETURNING id`,
        [name]
      );
      if (tid === tenantB) engagementB = r.rows[0].id;
      await app.query("COMMIT");
    }
  });

  afterAll(async () => {
    if (admin) {
      await admin.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [[tenantA, tenantB]]);
      await admin.end();
    }
    await app?.end();
  });

  async function asTenant<T>(tid: string, fn: () => Promise<T>): Promise<T> {
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [tid]);
    try {
      return await fn();
    } finally {
      await app.query("COMMIT");
    }
  }

  it("Tenant A sees only its own engagements", async () => {
    const rows = await asTenant(tenantA, async () => {
      const r = await app.query(`SELECT client_name FROM engagements`);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].client_name).toBe("Client of A");
  });

  it("Tenant A cannot read Tenant B's engagement even by exact id", async () => {
    const rows = await asTenant(tenantA, async () => {
      const r = await app.query(`SELECT * FROM engagements WHERE id = $1`, [engagementB]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("Tenant A cannot UPDATE or DELETE Tenant B's engagement", async () => {
    const updated = await asTenant(tenantA, async () => {
      const r = await app.query(`UPDATE engagements SET client_name = 'hacked' WHERE id = $1`, [
        engagementB,
      ]);
      return r.rowCount;
    });
    expect(updated).toBe(0);

    const deleted = await asTenant(tenantA, async () => {
      const r = await app.query(`DELETE FROM engagements WHERE id = $1`, [engagementB]);
      return r.rowCount;
    });
    expect(deleted).toBe(0);
  });

  it("Tenant A cannot INSERT a row claiming Tenant B's tenant_id (WITH CHECK)", async () => {
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    await expect(
      app.query(`INSERT INTO engagements (tenant_id, client_name) VALUES ($1, 'smuggled')`, [tenantB])
    ).rejects.toThrow(/row-level security/i);
    await app.query("ROLLBACK");
  });

  it("With NO tenant context set, the app role sees zero rows", async () => {
    const r = await app.query(`SELECT count(*)::int AS n FROM engagements`);
    expect(r.rows[0].n).toBe(0);
  });
});
