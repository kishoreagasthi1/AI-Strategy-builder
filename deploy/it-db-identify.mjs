/**
 * Prove the integration suite is talking to the database it thinks it is. (v5.34.82)
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 *
 * docker-compose.yml publishes 5432:5432. A developer machine very often
 * already has Postgres on 5432 — this project's own runbook tells you to use
 * 5433 for the cloud-sql-proxy precisely because 5432 is taken by a local
 * Postgres.app. When it is, the container cannot own the port, and every
 * connection to localhost:5432 lands in the LOCAL database instead.
 *
 * Nothing downstream notices. it-db.sh waits for readiness with
 * `docker compose exec postgres pg_isready`, which runs INSIDE the container
 * and passes regardless of who owns the published port. The migrations then
 * apply cleanly to the local database, and the suite runs against it.
 *
 * On 2026-09-14 that produced 77 failures across 18 files, almost all of them
 * "new row violates row-level security policy for table interviews" on a seed
 * INSERT made as the admin role. The reasoning goes: in the container, `vyne`
 * is POSTGRES_USER and therefore a SUPERUSER, and superusers bypass RLS — even
 * FORCE ROW LEVEL SECURITY. In a local Postgres, `vyne` is an ordinary role
 * that happens to own the tables, so FORCE RLS binds it and every seed fails.
 *
 * The failures read as a product regression. They were a port collision, and
 * the same suite passed on identical code against a correctly-provisioned
 * database. That is a whole debugging session spent on a message that was
 * telling the truth about the wrong server.
 *
 * ── What it checks ──────────────────────────────────────────────────────────
 *
 * Over TCP, as the tests connect — not through `docker compose exec`, which is
 * what made the collision invisible in the first place:
 *
 *   1. data_directory is the container's /var/lib/postgresql/data. A local
 *      Postgres.app reports a path under the user's Library folder, and a
 *      Homebrew one something under /opt or /usr/local. This is the single
 *      most direct "am I inside the container" signal available over SQL.
 *   2. the connecting role is a SUPERUSER. The suite's admin connection seeds
 *      rows in tables that carry FORCE RLS; without superuser it cannot, and
 *      the resulting errors look like policy bugs.
 *
 * Exits non-zero with an explanation naming the likely cause. Used by
 * it-db.sh; runnable by hand when a run looks wrong:
 *
 *   cd backend && node ../deploy/it-db-identify.mjs "$TEST_DATABASE_URL"
 */
/*
 * `pg` lives in backend/node_modules, and ESM resolves a bare specifier from
 * THIS file's directory — deploy/ — not from the working directory. A plain
 * `import pg from "pg"` therefore fails with ERR_MODULE_NOT_FOUND however the
 * script is invoked. Anchor the resolution at the backend package instead.
 */
import { createRequire } from "node:module";
const require = createRequire(new URL("../backend/package.json", import.meta.url));
const pg = require("pg");

const url = process.argv[2];
/*
 * --expect-container: only when THIS script's caller started the compose
 * container. it-db.sh documents a second, supported path — point
 * TEST_DATABASE_URL at any Postgres 16 you run — and on that path the data
 * directory is legitimately not the image's. Refusing it would break a
 * documented workflow to fix a different one. The superuser check below
 * applies either way, because the suite cannot seed without it.
 */
const expectContainer = process.argv.includes("--expect-container");
if (!url) {
  console.error("usage: node it-db-identify.mjs <postgres-url> [--expect-container]");
  process.exit(2);
}

/** The container's data directory, from the postgres:16 image. */
const CONTAINER_DATA_DIR = "/var/lib/postgresql/data";

const c = new pg.Client({ connectionString: url });
try {
  await c.connect();
} catch (e) {
  console.error(`!! could not connect to the integration database: ${e.message}`);
  process.exit(2);
}

/*
 * Two queries, in this order, because reading data_directory ITSELF requires
 * superuser — Postgres raises "must be superuser or have privileges of
 * pg_read_all_settings" rather than returning null, even with the missing_ok
 * argument. Asking for both at once crashed the script on exactly the database
 * this check exists to diagnose, which would have replaced one confusing
 * failure with another.
 */
let row;
try {
  row = (await c.query(`
    SELECT current_user AS role,
           (SELECT usesuper FROM pg_user WHERE usename = current_user) AS is_super,
           current_setting('server_version', true) AS version`)).rows[0];
  if (row.is_super) {
    try {
      row.data_dir = (await c.query(`SELECT current_setting('data_directory', true) AS d`)).rows[0].d;
    } catch { row.data_dir = null; }
  }
} finally {
  await c.end();
}

console.log(`>> integration database: role=${row.role} superuser=${row.is_super ? "yes" : "NO"} ` +
            `postgres=${row.version}${row.data_dir ? ` data_directory=${row.data_dir}` : ""}`);

/* Superuser first: it is both the more consequential finding and a
 * precondition for knowing where the server's data lives. */
if (!row.is_super) {
  console.error("");
  console.error(`!! the admin role '${row.role}' is NOT a superuser.`);
  console.error("   The suite seeds rows as this role into tables carrying FORCE ROW LEVEL SECURITY,");
  console.error("   which binds even the table owner. Without superuser every seed fails with");
  console.error("   'new row violates row-level security policy' and the failures read as product bugs.");
  console.error("");
  if (expectContainer) {
    console.error("   In the ephemeral container this role is POSTGRES_USER and a superuser by");
    console.error("   construction. Seeing it here means localhost is NOT reaching that container —");
    console.error("   almost always because a local Postgres.app or Homebrew postgres already holds");
    console.error("   port 5432, so the container could not publish it. Quit the local Postgres and");
    console.error("   re-run, or point TEST_DATABASE_URL / RLS_APP_URL at a Postgres 16 on another");
    console.error("   port where the vyne role is a superuser.");
  } else {
    console.error("   Grant it superuser on the server you supplied, or supply a different one.");
  }
  process.exit(3);
}

const inContainer = String(row.data_dir || "").startsWith(CONTAINER_DATA_DIR);

if (expectContainer && !inContainer) {
  console.error("");
  console.error("!! THIS IS NOT THE EPHEMERAL CONTAINER. The suite would run against a different server.");
  console.error(`   Expected data_directory ${CONTAINER_DATA_DIR}, got ${row.data_dir}`);
  console.error("");
  console.error("   Almost always: something else already holds port 5432 — a local Postgres.app or");
  console.error("   Homebrew postgres — so the container could not publish it and localhost:5432");
  console.error("   reaches that server instead. The migrations then apply to YOUR database and the");
  console.error("   suite tests it, which is both wrong and destructive.");
  console.error("");
  console.error("   Do one of:");
  console.error("     · stop the local Postgres for the run (quit Postgres.app), then re-run; or");
  console.error("     · run the suite against a different port:");
  console.error("         TEST_DATABASE_URL=postgres://vyne:vyne@localhost:5433/vyne \\");
  console.error("         RLS_APP_URL=postgres://vyne_app:apppw@localhost:5433/vyne \\");
  console.error("         bash deploy/it-db.sh");
  console.error("       (and publish 5433:5432 in docker-compose.yml, or point these at any");
  console.error("        Postgres 16 you control where the vyne role is a superuser)");
  process.exit(3);
}

console.log(expectContainer
  ? ">> database identity OK — the ephemeral container, admin is superuser"
  : ">> database identity OK — caller-supplied server, admin is superuser");
