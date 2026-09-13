/**
 * The SCHEMA boot guard (v5.33.5).
 *
 * ── What it is for ─────────────────────────────────────────────────────────
 *
 * v5.33.3 shipped code that reads and writes `interviews.synthetic` and
 * `interview_transcripts.synthetic`, plus migration 026 which creates them. The
 * API was deployed. The migration was not run. Nothing complained — the
 * revision passed its health check and served traffic — until a consultant
 * clicked Generate on a practice engagement for ACME INDUSTRIAL and got:
 *
 *     Generation failed: internal_error
 *
 * which is server.ts's global catch-all for any unhandled route error, and so
 * names nothing. The actual `column "synthetic" does not exist` was only ever in
 * Cloud Logging.
 *
 * The deploy runbook already said to run migrations. That is exactly why a
 * louder runbook is not the fix: `deploy.sh api` and `npm run migrate` are
 * separate commands against separate endpoints, and a deploy that skips the
 * second one SUCCEEDS. The process has to refuse.
 *
 * ── What this file asserts ─────────────────────────────────────────────────
 *
 * Two of these cases run against a REAL Postgres (RLS_TEST=1 + TEST_DATABASE_URL,
 * same gate as rls.test.ts) because a guard that reads information_schema can
 * only be honestly tested against an information_schema. The rest are static and
 * run everywhere — they exist because the most likely way this guard dies is not
 * a bug in it, but somebody removing the call from index.ts and leaving the
 * function behind, at which point every dynamic test still passes.
 *
 * VERIFIED by running it against two real databases built from this repo's own
 * migrations — one with 026 applied, one deliberately stopped at 025:
 *
 *     ──── MIGRATED (026 applied) ────   BOOT ALLOWED — schema is current
 *     ──── BEHIND  (026 missing) ────   BOOT REFUSED: … Missing:
 *                                        interviews.synthetic,
 *                                        interview_transcripts.synthetic
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const poolSrc = readFileSync(join(ROOT, "src", "db", "pool.ts"), "utf8");
const indexSrc = readFileSync(join(ROOT, "src", "index.ts"), "utf8");

describe("the schema boot guard is wired into startup", () => {
  /* The failure mode this block exists for: the function survives, the CALL is
   * removed, and every behavioural test of the function still passes while
   * nothing runs it. Same shape as the audit's rlsGate finding — a check whose
   * green depends on a wiring fact it cannot see. */
  it("index.ts actually calls it", () => {
    expect(indexSrc).toContain("assertSchemaCurrent(getPool()");
  });

  it("it is STRICT in production, so a bad revision never goes live", () => {
    // Non-strict would warn and serve — which is the current behaviour it is
    // replacing, with extra steps.
    expect(indexSrc).toMatch(/assertSchemaCurrent\(getPool\(\),\s*\{\s*strict:\s*config\.env === "production"\s*\}\)/);
  });

  it("it runs BEFORE the server listens", () => {
    // After listen() it would still log, but the revision would already be
    // taking traffic and Cloud Run would call the deploy a success.
    const at = indexSrc.indexOf("assertSchemaCurrent");
    const listen = indexSrc.search(/\.listen\(/);
    expect(at).toBeGreaterThan(0);
    if (listen > 0) expect(at).toBeLessThan(listen);
  });
});

describe("the required-column list is meaningful", () => {
  const block = poolSrc.slice(
    poolSrc.indexOf("const REQUIRED_COLUMNS"),
    poolSrc.indexOf("export async function assertSchemaCurrent")
  );

  it("the list was found and is not empty", () => {
    expect(block.length).toBeGreaterThan(100);
  });

  it("covers the columns whose absence caused this incident", () => {
    expect(block).toContain(`table: "interviews",            column: "synthetic"`);
    expect(block).toContain(`table: "interview_transcripts", column: "synthetic"`);
  });

  it("covers engagements.code, which 025 made NOT NULL and the code assumes", () => {
    expect(block).toContain(`table: "engagements",           column: "code"`);
  });

  it("every entry names the migration that creates it", () => {
    // Without this the error says what is missing but not what to run, and the
    // person reading it at 6pm has to go and find out.
    const entries = [...block.matchAll(/\{ table: "([^"]+)",\s+column: "([^"]+)",\s+migration: "([^"]+)" \}/g)];
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const [, table, column, migration] of entries) {
      expect(migration, `${table}.${column} has no migration filename`).toMatch(/^\d{3}_.*\.sql$/);
    }
  });

  it("every named migration file actually exists", () => {
    /* A filename typo turns the one actionable sentence in the error into a
     * wild goose chase, and nothing else would ever catch it. */
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const files = new Set(readdirSync(join(ROOT, "src", "db", "migrations")));
    for (const m of [...block.matchAll(/migration: "([^"]+)"/g)].map((x) => x[1])) {
      expect(files.has(m), `REQUIRED_COLUMNS names a migration that does not exist: ${m}`).toBe(true);
    }
  });

  it("guards whole TABLES too, not only columns", () => {
    /*
     * v5.34.59. The guard checked columns only, and a missing TABLE has no
     * columns to miss — so when migrations 030/031 were never run against
     * production, byok_keys simply did not exist, the Client API keys screen
     * answered "Could not load: internal_error", and this guard said nothing
     * at boot. Finding out cost a trip through information_schema to discover
     * the database was two releases behind.
     */
    const tableBlock = poolSrc.slice(
      poolSrc.indexOf("const REQUIRED_TABLES"),
      poolSrc.indexOf("export async function assertSchemaCurrent")
    );
    expect(tableBlock).toContain(`table: "byok_keys"`);
    expect(tableBlock).toContain(`table: "byok_invites"`);
    const fn = poolSrc.slice(poolSrc.indexOf("export async function assertSchemaCurrent"));
    expect(fn).toContain("REQUIRED_TABLES");
    expect(fn).toContain("information_schema.tables");
  });

  it("covers usage_events.payer, whose absence would silently lose every billing row", () => {
    // dbMeter's INSERT names it, and safeMeter swallows a metering failure by
    // design — so a missing column here means money spent and nothing
    // recording it, with the product looking perfectly healthy.
    expect(block).toContain(`table: "usage_events", column: "payer"`);
    expect(block).toContain(`table: "usage_events", column: "payer_key_hint"`);
  });

  it("the error text tells the operator what to actually run", () => {
    const fn = poolSrc.slice(poolSrc.indexOf("export async function assertSchemaCurrent"));
    expect(fn).toContain("npm run migrate");
    expect(fn).toContain("5433");
    // The specific trap that has now cost two migration runs on this project.
    expect(fn).toContain("Nothing to apply");
  });
});

/* ── Against a real database ────────────────────────────────────────────────
 *
 * Gated exactly like rls.test.ts. Skipped rather than faked: a fake
 * information_schema would assert that the mock behaves, which is not the
 * question. rlsGate.test.ts is what stops these skipping silently in CI.
 */
const ENABLED = process.env.RLS_TEST === "1" && !!process.env.TEST_DATABASE_URL;

describe.skipIf(!ENABLED)("assertSchemaCurrent against real Postgres", () => {
  it("passes on a fully migrated database", async () => {
    const pg = (await import("pg")).default;
    const { assertSchemaCurrent } = await import("../src/db/pool.js");
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      await expect(assertSchemaCurrent(pool, { strict: true })).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it("REFUSES when a required column is missing, and names it", async () => {
    /* Drops the column inside a transaction that is always rolled back, so the
     * test database is unchanged whether it passes, fails or throws. */
    const pg = (await import("pg")).default;
    const { assertSchemaCurrent } = await import("../src/db/pool.js");
    const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    await client.query("BEGIN");
    try {
      await client.query("ALTER TABLE interviews DROP COLUMN IF EXISTS synthetic");
      const fakePool = { connect: async () => ({ query: client.query.bind(client), release() {} }) };
      await expect(
        assertSchemaCurrent(fakePool as never, { strict: true })
      ).rejects.toThrow(/interviews\.synthetic/);
      await expect(
        assertSchemaCurrent(fakePool as never, { strict: true })
      ).rejects.toThrow(/026_synthetic_flag_column\.sql/);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });

  it("REFUSES when a required TABLE is missing, and names the migration", async () => {
    /*
     * The negative control for v5.34.59's table check. Without it this whole
     * mechanism could be present, well-commented, and never actually fire —
     * which is indistinguishable from today, when it did not.
     *
     * Dropped inside a transaction that is always rolled back.
     */
    const pg = (await import("pg")).default;
    const { assertSchemaCurrent } = await import("../src/db/pool.js");
    const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    await client.query("BEGIN");
    try {
      await client.query("DROP TABLE IF EXISTS byok_keys");
      const fakePool = { connect: async () => ({ query: client.query.bind(client), release() {} }) };
      await expect(
        assertSchemaCurrent(fakePool as never, { strict: true })
      ).rejects.toThrow(/table byok_keys/);
      await expect(
        assertSchemaCurrent(fakePool as never, { strict: true })
      ).rejects.toThrow(/031_byok_client_grain\.sql/);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });

  it("REFUSES when the payer column is missing — the silent-billing-loss case", async () => {
    const pg = (await import("pg")).default;
    const { assertSchemaCurrent } = await import("../src/db/pool.js");
    const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    await client.query("BEGIN");
    try {
      await client.query("ALTER TABLE usage_events DROP COLUMN IF EXISTS payer");
      const fakePool = { connect: async () => ({ query: client.query.bind(client), release() {} }) };
      await expect(
        assertSchemaCurrent(fakePool as never, { strict: true })
      ).rejects.toThrow(/usage_events\.payer/);
      await expect(
        assertSchemaCurrent(fakePool as never, { strict: true })
      ).rejects.toThrow(/032_usage_payer\.sql/);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
