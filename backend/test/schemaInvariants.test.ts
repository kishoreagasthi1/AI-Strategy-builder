/**
 * SCHEMA INVARIANTS — asserted against the LIVE database, generically.
 *
 * Why this file exists (v5.32.31).
 *
 * Migration 012 shipped in v5.32.29 with a defect that would have taken the
 * whole platform down on the next `migrate`: it copied 011's disable/restore
 * RLS pattern onto `tenants`, a table that never had RLS, flipping it from
 * "no RLS" to "RLS forced with ZERO policies" — which in Postgres means deny
 * everything. Every authenticated request would have 403'd, because the auth
 * middleware's membership query joins `tenants`.
 *
 * Three separate review passes read that file and did not catch it, because
 * the SQL reads correctly. It is only visible if you APPLY the migrations and
 * then INTROSPECT the resulting catalog — and only as a non-superuser, since
 * superusers bypass RLS unconditionally (FORCE does not override that), which
 * is exactly why CI's migration step was blind to it.
 *
 * A test asserting "012 must not touch tenants" would only guard the one
 * mistake already made. These assert the PROPERTY instead, so the whole class
 * is covered — including migrations not written yet.
 *
 * Needs a real Postgres:
 *   RLS_TEST=1 TEST_DATABASE_URL=... RLS_APP_URL=... npm run test:full
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:change-me-via-ops@localhost:5432/vyne";

/**
 * Tables that legitimately carry no RLS. Each entry is a DECISION, not an
 * oversight, and the reason is recorded here so that adding to this list is a
 * deliberate act a reviewer can challenge.
 */
const NO_RLS_BY_DESIGN: Record<string, string> = {
  tenants: "IS the tenant — the table tenant context is resolved FROM. Reached only via withoutTenant().",
  users: "Global identity; a user may belong to more than one firm.",
  memberships: "The tenant-resolution join itself; read via withoutTenant() before any tenant context exists.",
  subscription_plans: "Global reference data (the plan catalog), identical for every firm.",
  schema_migrations: "Migration bookkeeping, written by the owner role only.",
  /*
   * byok_invites (migration 031) — the one deliberate exception in the schema,
   * and the reason this list needs a long entry rather than a short one.
   *
   * The row is looked up BEFORE any tenant is known. A client's administrator
   * has no account here and never will: the whole point of the setup link is
   * that supplying their own API key must not require being onboarded into
   * someone else's consulting platform. So the redemption route resolves the
   * token first and sets app.tenant_id FROM the row it finds — under RLS that
   * lookup would match nothing and the feature could not exist.
   *
   * What guards it instead is not weaker, it is different: the token is 32
   * random bytes, only its SHA-256 hash is stored (a database reader cannot
   * mint a working link), it expires in 72 hours, and it is single-use. The
   * route must set the tenant from the row and never from anything the caller
   * sent — byokRoutes.test.ts is where that is held to account.
   *
   * Listed here rather than silently tolerated: an unexplained table without
   * RLS is how the next one gets added.
   */
  byok_invites: "Looked up by token hash before any tenant is known — see migration 031.",
};

describe.skipIf(!ENABLED)("schema invariants (live catalog introspection)", () => {
  let admin: pg.Client;
  let app: pg.Client;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    app = new pg.Client({ connectionString: APP_URL });
    await app.connect();
  });
  afterAll(async () => { await admin?.end(); await app?.end(); });

  it("no table has RLS enabled with zero policies (the migration-012 deny-everything trap)", async () => {
    const r = await admin.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
          AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)`
    );
    expect(r.rows.map((x) => x.relname)).toEqual([]);
  });

  it("every table with a tenant_id has RLS, FORCE, and at least one policy", async () => {
    const r = await admin.query<{ relname: string; rls: boolean; forced: boolean; pols: string }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS pols
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM information_schema.columns col
                      WHERE col.table_schema = 'public' AND col.table_name = c.relname
                        AND col.column_name = 'tenant_id')`
    );
    const bad = r.rows.filter(
      (t) => !(t.rls && t.forced && Number(t.pols) > 0) && !(t.relname in NO_RLS_BY_DESIGN)
    );
    expect(bad.map((t) => `${t.relname} rls=${t.rls} forced=${t.forced} policies=${t.pols}`)).toEqual([]);
  });

  it("every RLS policy keys off app.tenant_id on every expression that applies to it", async () => {
    const r = await admin.query<{
      tablename: string; policyname: string; cmd: string | null; qual: string | null; with_check: string | null;
    }>(
      `SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public'`
    );
    expect(r.rows.length).toBeGreaterThan(0);

    /*
     * v5.32.83. This required BOTH qual and with_check on every policy, which
     * silently also required every policy to be `FOR ALL`: a FOR SELECT policy
     * has no WITH CHECK to give and a FOR INSERT policy has no USING. Migration
     * 024 splits interview_transcripts per command so DELETE can be narrowed to
     * synthetic rows, and this reported the three resulting policies as three
     * missing tenant checks that are not missing.
     *
     * Made command-aware rather than relaxed. The property defended is exactly
     * the one the original comment names — no policy may leave a write path
     * unguarded — and for ALL and UPDATE a WITH CHECK is still mandatory,
     * because Postgres falls back to USING when it is absent on an UPDATE and a
     * policy that reads strictly while writing loosely is the shape this exists
     * to catch.
     */
    const NEEDS_QUAL = new Set(["ALL", "SELECT", "UPDATE", "DELETE"]);
    const NEEDS_CHECK = new Set(["ALL", "INSERT", "UPDATE"]);
    const keyed = (e: string | null) => (e ?? "").includes("app.tenant_id");

    const bad = r.rows.filter((p) => {
      const cmd = (p.cmd ?? "ALL").toUpperCase();
      if (NEEDS_QUAL.has(cmd) && !keyed(p.qual)) return true;
      if (NEEDS_CHECK.has(cmd) && !keyed(p.with_check)) return true;
      return false;
    });
    expect(bad.map((p) => `${p.tablename}.${p.policyname} (${p.cmd})`)).toEqual([]);

    // The rule above is only as good as its command list: a cmd not in either
    // set would fall through both checks and be silently exempt from all of
    // them, which is how a "no policy may be unguarded" test comes to pass an
    // unguarded policy.
    const known = new Set(["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"]);
    expect(r.rows.filter((p) => !known.has((p.cmd ?? "ALL").toUpperCase())).map((p) => p.policyname))
      .toEqual([]);
  });

  it("the application role can neither bypass nor disable row-level security", async () => {
    const who = await app.query<{ u: string; s: boolean; b: boolean }>(
      `SELECT current_user AS u,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS b`
    );
    expect(who.rows[0].s, `${who.rows[0].u} must not be a superuser`).toBe(false);
    expect(who.rows[0].b, `${who.rows[0].u} must not have BYPASSRLS`).toBe(false);

    for (const sql of [
      `ALTER TABLE engagements DISABLE ROW LEVEL SECURITY`,
      `CREATE POLICY pwn_test ON engagements USING (true)`,
      `ALTER ROLE ${who.rows[0].u} BYPASSRLS`,
    ]) {
      await expect(app.query(sql), `app role must be refused: ${sql}`).rejects.toThrow();
    }
  });

  it("audit_log is append-only at the GRANT level, not merely by convention", async () => {
    const r = await admin.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'vyne_app' AND table_schema = 'public' AND table_name = 'audit_log'`
    );
    const privs = r.rows.map((x) => x.privilege_type).sort();
    expect(privs).toEqual(["INSERT", "SELECT"]);
  });

  it("the application role holds no write grant it does not use", async () => {
    // subscription_plans is the plan catalog: prices, Stripe price ids and the
    // monthly token ceilings. Application code only ever SELECTs it. A write
    // grant it never exercises turns any SQL-injection or compromised-process
    // foothold into "raise my own spend cap" or "redirect a Stripe price".
    const r = await admin.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'vyne_app' AND table_schema = 'public'
          AND table_name = 'subscription_plans'`
    );
    expect(r.rows.map((x) => x.privilege_type).sort()).toEqual(["SELECT"]);
  });

  it("the spend cap cannot be created NULL by a future insert", async () => {
    const r = await admin.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tenants'
          AND column_name = 'monthly_token_limit'`
    );
    // No DEFAULT is how the cap sat inert on every tenant from the first deploy
    // until v5.32.29: the column existed, metering read it, and it was never set.
    expect(r.rows[0]?.column_default).not.toBeNull();
  });

  it("a tenant-scoped row can never be written with a NULL tenant_id", async () => {
    // A NULL tenant_id satisfies no policy (NULL = x is NULL, not true), so such
    // a row is invisible to every reader including the owner — a silent hole in
    // the audit trail rather than a visible error.
    const r = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id' AND is_nullable = 'YES'`
    );
    expect(r.rows.map((x) => x.table_name)).toEqual([]);
  });
});
