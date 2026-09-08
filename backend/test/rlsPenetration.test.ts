/**
 * ADVERSARIAL RLS PENETRATION TEST (v5.32.31).
 *
 * rls.test.ts is the Phase 0 acceptance test: it proves the happy-path
 * isolation contract on the tables it names. This file is its adversarial
 * counterpart — it connects as the real production role and ATTACKS, covering
 * three things acceptance testing does not:
 *
 *   · every tenant-scoped table, enumerated from the catalog rather than from
 *     a hand-written list, so a table added later is covered automatically;
 *   · privilege escalation — can the app role turn RLS off, write itself a
 *     permissive policy, drop the isolation policy, or grant itself BYPASSRLS?
 *     Isolation that the attacker can switch off is not isolation;
 *   · connection hygiene — does a tenant context survive COMMIT and leak into
 *     the next checkout of a pooled connection?
 *
 * Runs as RLS_APP_URL (the non-superuser vyne_app). If that URL points at a
 * superuser, every assertion here passes vacuously — which is exactly how CI
 * missed the migration-012 defect — so the first test refuses to continue
 * unless the role genuinely cannot bypass RLS.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:change-me-via-ops@localhost:5432/vyne";

describe.skipIf(!ENABLED)("adversarial RLS penetration (as the production app role)", () => {
  let admin: pg.Client;
  let app: pg.Client;
  let A: string;
  let B: string;
  let uA: string;
  /** Tenant-scoped tables, read from the catalog — not hand-listed. */
  let scoped: string[] = [];

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    app = new pg.Client({ connectionString: APP_URL });
    await app.connect();

    scoped = (
      await admin.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
          ORDER BY c.relname`
      )
    ).rows.map((r) => r.relname);

    A = (await admin.query(`INSERT INTO tenants (name) VALUES ('Pen A') RETURNING id`)).rows[0].id;
    B = (await admin.query(`INSERT INTO tenants (name) VALUES ('Pen B') RETURNING id`)).rows[0].id;
    uA = (await admin.query(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('pen-uid-a','pen-a@example.com') RETURNING id`
    )).rows[0].id;
    for (const t of [A, B]) {
      // engagements.code is NOT NULL since migration 025; unique per tenant here.
      await admin.query(`INSERT INTO engagements (tenant_id, code, client_name, industry) VALUES ($1,$2,'Pen Client','tech')`, [t, 'PEN-' + t.slice(0, 8)]);
      await admin.query(
        `INSERT INTO module_state (tenant_id, module, key, value) VALUES ($1,'workspace','vynora_briefing_pen','{"v":"secret"}')`, [t]);
      await admin.query(
        `INSERT INTO interviews (tenant_id, client_name, interviewee_name, interviewee_role, state_module)
         VALUES ($1,'Pen Client','Pen Exec','CEO',$2)`,
        [t, `iv_pen_${t.slice(0, 8)}`]);
      await admin.query(`INSERT INTO audit_log (tenant_id, action, detail) VALUES ($1,'client_deleted','{}')`, [t]);
    }
  });

  afterAll(async () => {
    for (const t of [A, B]) {
      await admin?.query(`DELETE FROM audit_log WHERE tenant_id=$1`, [t]).catch(() => {});
      await admin?.query(`DELETE FROM module_state WHERE tenant_id=$1`, [t]).catch(() => {});
      await admin?.query(`DELETE FROM interviews WHERE tenant_id=$1`, [t]).catch(() => {});
      await admin?.query(`DELETE FROM engagements WHERE tenant_id=$1`, [t]).catch(() => {});
      await admin?.query(`DELETE FROM tenants WHERE id=$1`, [t]).catch(() => {});
    }
    await admin?.query(`DELETE FROM users WHERE id=$1`, [uA]).catch(() => {});
    await admin?.end();
    await app?.end();
  });

  it("the attacking role genuinely cannot bypass RLS (guards against a vacuous pass)", async () => {
    const r = await app.query<{ u: string; s: boolean; b: boolean }>(
      `SELECT current_user AS u,
              (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS s,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS b`
    );
    expect(r.rows[0].s, `RLS_APP_URL points at superuser ${r.rows[0].u} — every test in this file would pass vacuously`).toBe(false);
    expect(r.rows[0].b).toBe(false);
  });

  it("with no tenant context, every RLS table returns zero rows", async () => {
    for (const t of scoped) {
      const n = Number((await app.query(`SELECT count(*) c FROM ${t}`)).rows[0].c);
      expect(n, `${t} leaked ${n} rows with no tenant context`).toBe(0);
    }
  });

  it("tenant A sees only tenant A, on every RLS table", async () => {
    for (const t of scoped) {
      await app.query("BEGIN");
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [A]);
      const rows = (await app.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${t}`)).rows;
      await app.query("COMMIT");
      const foreign = rows.filter((r) => r.tenant_id !== A);
      expect(foreign, `${t} returned ${foreign.length} rows belonging to another tenant`).toEqual([]);
    }
  });

  it("tenant A cannot UPDATE or DELETE tenant B's rows", async () => {
    for (const t of ["engagements", "module_state", "interviews"]) {
      await app.query("BEGIN");
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [A]);
      const upd = await app.query(`UPDATE ${t} SET tenant_id = tenant_id WHERE tenant_id = $1`, [B]);
      const del = await app.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [B]);
      await app.query("ROLLBACK");
      expect(upd.rowCount, `${t}: updated ${upd.rowCount} of tenant B's rows`).toBe(0);
      expect(del.rowCount, `${t}: deleted ${del.rowCount} of tenant B's rows`).toBe(0);
    }
  });

  it("tenant A cannot forge tenant B's id on INSERT, nor move a row across the boundary", async () => {
    const attacks: [string, string][] = [
      // code supplied so RLS WITH CHECK is what rejects it, not the NOT NULL column.
      ["INSERT forging B", `INSERT INTO engagements (tenant_id, code, client_name) VALUES ('${B}','PENF','forged')`],
      ["UPDATE moving own row to B", `UPDATE engagements SET tenant_id = '${B}'`],
    ];
    for (const [label, sql] of attacks) {
      await app.query("BEGIN");
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [A]);
      let msg = "";
      try { await app.query(sql); } catch (e) { msg = (e as Error).message; }
      await app.query("ROLLBACK");
      expect(msg, `${label} was not rejected by WITH CHECK`).toMatch(/row-level security/i);
    }
  });

  it("the audit log cannot be rewritten or erased by the app role", async () => {
    await app.query("BEGIN");
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [A]);
    for (const sql of [`UPDATE audit_log SET action='forged'`, `DELETE FROM audit_log`]) {
      let msg = "";
      await app.query("SAVEPOINT sp");           // each refusal aborts the transaction
      try { await app.query(sql); } catch (e) { msg = (e as Error).message; }
      await app.query("ROLLBACK TO SAVEPOINT sp");
      expect(msg, `audit_log accepted: ${sql}`).toMatch(/permission denied/i);
    }
    await app.query("ROLLBACK");
  });

  it("a bogus or empty tenant context opens nothing", async () => {
    for (const bogus of ["00000000-0000-0000-0000-000000000000", ""]) {
      await app.query("BEGIN");
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [bogus]);
      let n = -1;
      try { n = Number((await app.query(`SELECT count(*) c FROM engagements`)).rows[0].c); } catch { n = 0; }
      await app.query("ROLLBACK");
      expect(n, `context ${JSON.stringify(bogus)} exposed ${n} rows`).toBe(0);
    }
  });

  it("a tenant context does not survive COMMIT (no leak across a pooled connection)", async () => {
    await app.query("BEGIN");
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [A]);
    await app.query("COMMIT");
    const n = Number((await app.query(`SELECT count(*) c FROM engagements`)).rows[0].c);
    expect(n, "tenant context survived the transaction — SET LOCAL semantics are broken").toBe(0);
  });

  it("the app role cannot switch isolation off", async () => {
    for (const sql of [
      `ALTER TABLE engagements DISABLE ROW LEVEL SECURITY`,
      `ALTER TABLE engagements NO FORCE ROW LEVEL SECURITY`,
      `CREATE POLICY pen_pwn ON engagements USING (true)`,
      `DROP POLICY tenant_isolation ON engagements`,
      `ALTER ROLE vyne_app BYPASSRLS`,
    ]) {
      await expect(app.query(sql), `app role was permitted to: ${sql}`).rejects.toThrow();
    }
  });
});
