/**
 * "Nothing to apply — up to date." is ambiguous. (v5.34.63)
 *
 * The migration runner records filenames in schema_migrations and skips any it
 * has already seen. So that message means one of two very different things:
 *
 *   1. the migrations really are applied to the database you are pointed at, or
 *   2. you are pointed at a DIFFERENT database that happens to have its own
 *      schema_migrations rows — a local Postgres, a staging instance, a proxy
 *      forwarding somewhere other than you think.
 *
 * Case 2 reports success and changes nothing in production, which is the most
 * expensive failure mode this project has. This script removes the ambiguity by
 * asking the database three things the runner never asks:
 *
 *   - who and where it actually is (host, port, database, user, server version)
 *   - which migration filenames it has recorded, and when
 *   - whether the OBJECTS those migrations create are really present
 *
 * The last one matters most: a schema_migrations row is a claim, the object is
 * the fact. They disagree whenever someone has restored a dump, pointed at the
 * wrong instance, or hand-edited the table.
 *
 * Usage (run it from backend/, which is where `pg` is installed):
 *   cd backend
 *   DATABASE_URL=postgres://... node ../deploy/check-schema.mjs
 */
import { createRequire } from "node:module";

/*
 * A bare `import pg from "pg"` resolves from THIS FILE's directory, and
 * deploy/ has no node_modules — the dependency lives in backend/. Resolving
 * from the working directory instead lets the script sit with the other deploy
 * tooling while borrowing the backend's installed pg, with no second copy of
 * the driver and no package.json in deploy/ to keep in step.
 */
const requireFromCwd = createRequire(`${process.cwd()}/`);
let pg;
try {
  pg = requireFromCwd("pg");
} catch {
  console.error("Cannot find the 'pg' driver from here.");
  console.error("Run this from the backend directory:");
  console.error("  cd backend && DATABASE_URL=... node ../deploy/check-schema.mjs");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// Expected objects, keyed by the migration that introduces them. Add a line here
// whenever a migration creates something a deploy depends on.
const EXPECTED = [
  { migration: "030_byok.sql", kind: "table", name: "byok_keys" },
  { migration: "031_byok_client_grain.sql", kind: "column", name: "byok_keys.client_norm" },
  { migration: "032_usage_payer.sql", kind: "column", name: "usage_events.payer" },
  { migration: "033_byok_key_health.sql", kind: "column", name: "byok_keys.last_error" },
  { migration: "033_byok_key_health.sql", kind: "column", name: "byok_invites.revoked_at" },
  { migration: "034_transcript_erasure.sql", kind: "policy", name: "interview_transcripts.tenant_delete_erasure" },
  { migration: "035_client_routing.sql", kind: "table", name: "client_routing" },
  { migration: "035_client_routing.sql", kind: "column", name: "client_routing.text_vendor" },
];

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  // ── 1. Which database is this, really? ──────────────────────────────────────
  // inet_server_addr() is null over a unix socket and set over TCP, which alone
  // distinguishes a local socket connection from one through the proxy.
  const who = await client.query(`
    SELECT current_database() AS db,
           current_user       AS "user",
           inet_server_addr()::text AS server_addr,
           inet_server_port() AS server_port,
           version()          AS version`);
  const w = who.rows[0];
  console.log("── connection ─────────────────────────────────────────────");
  console.log(`  database   : ${w.db}`);
  console.log(`  user       : ${w.user}`);
  console.log(`  server     : ${w.server_addr ?? "(unix socket)"}:${w.server_port}`);
  console.log(`  version    : ${w.version.split(" ").slice(0, 2).join(" ")}`);
  // Cloud SQL reports a distinctive build string; a Homebrew Postgres does not.
  const cloudish = /Google|Cloud SQL|Debian/i.test(w.version);
  console.log(`  looks like : ${cloudish ? "a managed/Linux server" : "NOT a managed server — likely local Postgres"}`);

  // ── 2. What does it claim has been applied? ─────────────────────────────────
  const rows = await client.query(
    `SELECT filename, applied_at FROM schema_migrations ORDER BY filename`);
  console.log("\n── schema_migrations ──────────────────────────────────────");
  if (!rows.rowCount) {
    console.log("  (empty — this database has never been migrated)");
  } else {
    for (const r of rows.rows) {
      console.log(`  ${r.filename.padEnd(34)} ${new Date(r.applied_at).toISOString()}`);
    }
  }
  const recorded = new Set(rows.rows.map((r) => r.filename));

  // ── 3. Do the objects actually exist? ───────────────────────────────────────
  console.log("\n── objects ────────────────────────────────────────────────");
  let missing = 0;
  for (const e of EXPECTED) {
    let present = false;
    if (e.kind === "table") {
      const q = await client.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1`, [e.name]);
      present = !!q.rowCount;
    } else if (e.kind === "column") {
      const [table, column] = e.name.split(".");
      const q = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, column]);
      present = !!q.rowCount;
    } else if (e.kind === "policy") {
      const [table, policy] = e.name.split(".");
      const q = await client.query(
        `SELECT 1 FROM pg_policies
          WHERE schemaname = 'public' AND tablename = $1 AND policyname = $2`,
        [table, policy]);
      present = !!q.rowCount;
    }
    const claim = recorded.has(e.migration) ? "recorded" : "NOT recorded";
    const fact = present ? "present" : "MISSING";
    if (!present) missing++;
    const flag = present && recorded.has(e.migration) ? "  "
      : present ? "~ "   // object exists but no migration row: restored dump?
      : "! ";
    console.log(`${flag}${e.kind.padEnd(7)} ${e.name.padEnd(44)} ${fact.padEnd(8)} (${e.migration}: ${claim})`);
  }

  console.log("\n── verdict ────────────────────────────────────────────────");
  if (missing === 0 && cloudish) {
    console.log("  Every expected object is present on a managed server.");
    console.log("  \"Nothing to apply\" was truthful — the schema is current.");
  } else if (missing === 0 && !cloudish) {
    console.log("  Objects are present, but this does not look like Cloud SQL.");
    console.log("  Check that the proxy is the thing listening on this port.");
  } else {
    console.log(`  ${missing} expected object(s) MISSING.`);
    console.log("  If schema_migrations claims those files are applied, you are");
    console.log("  connected to a different database than the one you deployed.");
  }
  process.exit(missing === 0 && cloudish ? 0 : 1);
} finally {
  await client.end();
}
