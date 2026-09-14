/**
 * Migration 037 on a database that already has name-keyed rows. (v5.34.67)
 *
 * ── Why this is separate from every other migration test ────────────────────
 *
 * Every other test in this suite migrates an EMPTY database, where a backfill
 * has nothing to find and passes vacuously. Production is the opposite case:
 * it is a v5.34.66 database with real keys, preferences and grants already
 * attached by client_norm, and the whole value of 037 is whether those rows end
 * up bound to their engagement. A backfill that silently matches nothing leaves
 * every existing key on the old behaviour — a rename still detaches it, the
 * firm still starts paying — while the migration reports success and the schema
 * verifier reports the column present.
 *
 * So this builds the world as it was BEFORE this release (001 through 036,
 * seeded with rows), then applies 037 through the real runner and looks at what
 * moved.
 *
 * ── What it caught ─────────────────────────────────────────────────────────
 *
 * Written as a throwaway check, it reported NOT BOUND on all three tables. The
 * fault was in the check's own seed data — normClient("Nestlé USA") is
 * "nestlusa", not "nestleusa", because the normaliser STRIPS the accented
 * character rather than folding it to "e". Worth keeping precisely for that:
 * the norm is easy to predict wrongly, and a backfill that matches nothing
 * looks identical to one that matches everything unless something checks.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { normClient } from "../src/auth/clients.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "db", "migrations");

const DB = `vyne_bf_${process.pid}_${Date.now().toString(36)}`;
const urlFor = (db: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${db}`; return u.toString(); };

/** The release this upgrade starts from. */
const UPGRADE_FROM = "037";

describe.skipIf(!ENABLED)("v5.34.67 — 037 on a database that predates it", () => {
  let admin: pg.Client;
  let tenantId = "";
  let engagementId = "";

  const CLIENT = "Nestlé USA";
  const NORM = normClient(CLIENT);          // "nestlusa" — derived, never typed

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${DB}`);

    const c = new pg.Client({ connectionString: urlFor(DB) });
    await c.connect();
    try {
      // ── the world as of v5.34.66 ──────────────────────────────────────────
      await c.query(`CREATE TABLE schema_migrations (
        filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
        if (f.startsWith(UPGRADE_FROM)) break;
        await c.query(readFileSync(join(MIGRATIONS, f), "utf8"));
        await c.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [f]);
      }

      tenantId = (await c.query(
        `INSERT INTO tenants (name) VALUES ('Backfill Firm') RETURNING id`)).rows[0].id;
      await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
      engagementId = (await c.query(
        `INSERT INTO engagements (tenant_id, code, client_name)
         VALUES ($1, 'BF-1', $2) RETURNING id`, [tenantId, CLIENT])).rows[0].id;

      // Rows attached the old way: by name, with no engagement_id column yet.
      await c.query(
        `INSERT INTO byok_keys (tenant_id, client_norm, client_name, provider, status,
           secret_name, key_hint, paid_tier_attested, attested_by_email, attested_at, attestation_text)
         VALUES ($1, $2, $3, 'gemini-aistudio', 'active', 'projects/p/s/versions/1', 'wxyz',
                 true, 'a@b.com', now(), 'attested')`, [tenantId, NORM, CLIENT]);
      await c.query(
        `INSERT INTO client_routing (tenant_id, client_norm, client_name, text_vendor)
         VALUES ($1, $2, $3, 'anthropic-api')`, [tenantId, NORM, CLIENT]);
      await c.query(
        `INSERT INTO byok_fallback_grant (tenant_id, client_norm, client_name, reason)
         VALUES ($1, $2, $3, 'pilot')`, [tenantId, NORM, CLIENT]);
      // And a key for a client nobody ever registered — the flaw v5.34.67 also
      // closes going forward, but whose existing rows must keep working.
      await c.query(
        `INSERT INTO byok_keys (tenant_id, client_norm, client_name, provider, status,
           secret_name, key_hint, paid_tier_attested, attested_by_email, attested_at, attestation_text)
         VALUES ($1, $2, 'Ghost Co', 'anthropic-api', 'active', 'projects/p/s/versions/2', 'ghst',
                 true, 'a@b.com', now(), 'attested')`, [tenantId, normClient("Ghost Co")]);
    } finally {
      await c.end();
    }

    // ── the upgrade, through the real runner ────────────────────────────────
    const applied = await migrate(urlFor(DB));
    expect(applied, "037 did not apply to the pre-release database").toContain(
      "037_byok_engagement_binding.sql");
  }, 180_000);

  afterAll(async () => {
    if (!admin) return;
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [DB]);
      await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  const one = async (table: string, norm: string) => {
    const c = new pg.Client({ connectionString: urlFor(DB) });
    await c.connect();
    try {
      const r = await c.query<{ engagement_id: string | null }>(
        `SELECT engagement_id FROM ${table} WHERE client_norm = $1`, [norm]);
      return r.rows[0];
    } finally { await c.end(); }
  };

  it("binds an existing KEY to its engagement", async () => {
    expect((await one("byok_keys", NORM)).engagement_id).toBe(engagementId);
  });

  it("binds an existing PREFERENCE", async () => {
    expect((await one("client_routing", NORM)).engagement_id).toBe(engagementId);
  });

  it("binds an existing GRANT", async () => {
    expect((await one("byok_fallback_grant", NORM)).engagement_id).toBe(engagementId);
  });

  it("leaves a key for an unregistered client unbound, not wrongly bound", async () => {
    /*
     * The safe direction. A key attached to a name no engagement matches has
     * nothing to bind to, and guessing would be worse than leaving it: it keeps
     * matching on the norm exactly as it did before, which is what it has.
     */
    expect((await one("byok_keys", normClient("Ghost Co"))).engagement_id).toBeNull();
  });

  it("the backfill's normaliser is the application's, not an approximation", async () => {
    /*
     * The whole backfill is one equality: vyne_norm_client(engagements.client_name)
     * = the stored client_norm. If those two disagree on even one shape, the
     * rows quietly stay unbound and the migration still reports success.
     *
     * "Nestlé USA" is the case that proves it is not obvious — the normaliser
     * STRIPS the accented character rather than folding it, so the norm is
     * "nestlusa" and not "nestleusa". Seeding this test with the intuitive
     * spelling made every assertion above fail while the migration was correct.
     */
    const c = new pg.Client({ connectionString: urlFor(DB) });
    await c.connect();
    try {
      for (const name of ["Nestlé USA", "Acme Industrial", " Newell  Brands ",
                          "ZZ BYOK Test", "Ünïcodé & Co.", "L'Oréal", "3M", ""]) {
        const r = await c.query<{ n: string }>(`SELECT vyne_norm_client($1) AS n`, [name]);
        expect(r.rows[0].n, `disagreement on ${JSON.stringify(name)}`).toBe(normClient(name));
      }
    } finally { await c.end(); }
  });
});
