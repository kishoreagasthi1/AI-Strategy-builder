/**
 * Two migrators, one empty database. (v5.34.64)
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 *
 * `CREATE TABLE IF NOT EXISTS` is not atomic. Two sessions can both pass the
 * existence check and both attempt the create; the loser fails with
 *
 *     duplicate key value violates unique constraint "pg_type_typname_nsp_index"
 *
 * — the composite type Postgres creates for every table — and the whole
 * migration aborts. Every CREATE TABLE migration in this repo is exposed, and
 * has been since 001.
 *
 * ── Why it took until now to see ────────────────────────────────────────────
 *
 * The suite calls migrate() from a dozen beforeAll hooks, but nearly always
 * against a database that is ALREADY migrated: every call is a no-op, nothing
 * is created, nothing races. It surfaced on 2026-09-13, the first time the full
 * suite ran in parallel against a genuinely empty Postgres — inside the Docker
 * runner, on its first real execution. Two test files reported
 * "Migration 036_byok_fallback_grant.sql failed"; 036 was simply the file the
 * two workers happened to collide on.
 *
 * ── What this test does ─────────────────────────────────────────────────────
 *
 * Creates a REAL empty database and runs several migrate() calls concurrently
 * against it — the condition that produced the failure, rather than a
 * simulation of it. Without the advisory lock in migrate.ts this fails
 * essentially every run; with it, one migrator applies everything and the rest
 * wait and find nothing to do.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

/** A throwaway database name, unique per run so parallel files never collide. */
const DB = `vyne_migrace_${process.pid}_${Date.now().toString(36)}`;

const urlFor = (db: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};

describe.skipIf(!ENABLED)("v5.34.64 — concurrent migrators on an empty database", () => {
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    // CREATE DATABASE cannot run inside a transaction block, and the name is
    // built here rather than taken from input, so interpolation is safe.
    await admin.query(`CREATE DATABASE ${DB}`);
  }, 60_000);

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

  it("all of them succeed, and exactly one applies each migration", async () => {
    const url = urlFor(DB);
    /*
     * Four, because the failure is a race and one extra contender makes it far
     * likelier to land. They start together — no awaits between — so they are
     * genuinely concurrent rather than merely overlapping.
     */
    const results = await Promise.allSettled([
      migrate(url), migrate(url), migrate(url), migrate(url),
    ]);

    const rejected = results.filter((r) => r.status === "rejected");
    expect(
      rejected.map((r) => (r as PromiseRejectedResult).reason?.message).join(" | "),
      "a concurrent migrator failed — the advisory lock in migrate.ts is missing or ineffective"
    ).toBe("");

    // Every file applied exactly once across all four callers. A file applied
    // twice would mean the lock is held but the skip check is not seeing the
    // other migrator's committed rows.
    const appliedBy = results.map((r) => (r as PromiseFulfilledResult<string[]>).value);
    const all = appliedBy.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(30);      // the real migration set

    // And exactly one of them did the work; the rest found it done.
    expect(appliedBy.filter((a) => a.length > 0)).toHaveLength(1);
  }, 180_000);

  it("the resulting schema is the same one a single migrator produces", async () => {
    // A lock that serialised but skipped something would pass the test above.
    const c = new pg.Client({ connectionString: urlFor(DB) });
    await c.connect();
    try {
      const files = await c.query(`SELECT count(*)::int AS n FROM schema_migrations`);
      const tables = await c.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`);
      expect(files.rows[0].n).toBeGreaterThan(30);
      expect(tables.rows[0].n).toBeGreaterThan(10);
      // Spot-check the newest objects rather than every one — the schema
      // verifier (deploy/check-schema.mjs) is the exhaustive check.
      const grant = await c.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'byok_fallback_grant'`);
      expect(grant.rowCount).toBe(1);
    } finally {
      await c.end();
    }
  }, 60_000);
});
