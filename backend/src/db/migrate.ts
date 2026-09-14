/**
 * Minimal ordered-file migration runner (manual-deploy friendly).
 * Usage: DATABASE_URL=... npm run migrate
 * Applied files are recorded in schema_migrations; each runs in a transaction.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * One arbitrary but FIXED key, so every migrator in every process contends for
 * the same lock. Advisory locks live in a single global namespace keyed by this
 * number; the value means nothing beyond "this is the VYNE schema migration".
 */
const MIGRATION_LOCK_KEY = 5340064;

export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  let locked = false;
  try {
    /*
     * ── Why a lock (v5.34.64) ─────────────────────────────────────────────
     *
     * `CREATE TABLE IF NOT EXISTS` is NOT atomic. Two sessions can both pass
     * the existence check and both attempt the create; the loser fails with
     * `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`
     * — the composite type Postgres makes for every table — and the migration
     * aborts. The same race exists for the `INSERT INTO schema_migrations`
     * that records the file.
     *
     * This was latent from the beginning and invisible for a simple reason:
     * the suite's many `migrate()` calls almost always run against a database
     * that is ALREADY migrated, so every call is a no-op and nothing races.
     * It surfaced the first time the whole suite ran in parallel against a
     * genuinely empty Postgres — the Docker runner's first real execution, on
     * 2026-09-13. The failure named 036 only because 036 happened to be the
     * file two workers collided on; every CREATE TABLE migration is equally
     * exposed.
     *
     * pg_advisory_lock is the right instrument: it is session-scoped rather
     * than transaction-scoped, so it spans the whole file loop rather than one
     * migration; it queues instead of failing, so the second migrator simply
     * waits and then finds every row already recorded and applies nothing; and
     * it costs one round trip against a database that is already current.
     *
     * Taken BEFORE the schema_migrations create, because that statement is
     * itself a CREATE TABLE IF NOT EXISTS and races exactly the same way.
     */
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    locked = true;

    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const done = await client.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [file]);
      if (done.rowCount) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    /*
     * Released explicitly rather than left to the disconnect. `client.end()`
     * does drop the lock, but a pooled or reused connection would not — and
     * the unlock must not be able to mask the migration error that brought us
     * here, so it is swallowed on its own.
     */
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]); }
      catch { /* the disconnect below releases it regardless */ }
    }
    await client.end();
  }
  return applied;
}

// CLI entry
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  migrate(url)
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Nothing to apply — up to date.");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
