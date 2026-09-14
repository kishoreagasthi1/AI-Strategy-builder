/**
 * Tenant-scoped database access.
 *
 * The ONLY sanctioned way for request handlers to touch tenant-owned tables
 * is withTenant(): it opens a transaction and sets the app.tenant_id session
 * variable with SET LOCAL, which the RLS policies key off. When the
 * transaction ends the variable dies with it — no leakage across pooled
 * connections.
 *
 * withoutTenant() exists solely for provisioning/system paths (creating a
 * tenant, resolving a user's membership at login) and must never be used in
 * module data routes.
 */
import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function initPool(databaseUrl: string): pg.Pool {
  /*
   * v5.32.58 — timeouts, because none of these had a value and every default
   * is the wrong one for Cloud Run.
   *
   * pg's default connectionTimeoutMillis is 0, which means WAIT FOREVER. Cloud
   * Run's default concurrency is 80 requests per instance and each of ours
   * takes one to three SEQUENTIAL checkouts (auth → client scoping → the route
   * itself). Against a 10-connection pool, a burst puts requests into an
   * unbounded queue: the instance looks healthy, requests hang until the
   * 180-second request timeout kills them, and autoscaling adds four more
   * instances that are all blocked on their own pools in exactly the same way.
   *
   * Failing in five seconds is far better than hanging for three minutes — the
   * caller retries, the load shedding is visible, and Cloud Run's own metrics
   * show a real error rate instead of latency.
   *
   * statement_timeout is the backstop for the other direction: one accidental
   * unbounded scan should not hold a connection open indefinitely and starve
   * everything else. Thirty seconds is far above any legitimate query here.
   */
  pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PGPOOL_MAX || 20),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Applied per connection; belongs with the pool rather than sprinkled
    // through call sites that would forget it.
    options: "-c statement_timeout=30000",
  });
  // A pool error with no listener takes the process down in Node. A dropped
  // backend connection is routine on a managed database (failover, maintenance)
  // and must not be a restart.
  pool.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[db] idle client error:", err.message);
  });
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("DB pool not initialised — call initPool() first");
  return pool;
}

/** Run `fn` inside a transaction scoped to one tenant (RLS enforced). */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Parameterised via set_config to avoid any injection through tenantId.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** System-level access with NO tenant context. Provisioning/auth-resolution only. */
export async function withoutTenant<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/**
 * V225-audit H2 fix: RLS as implemented here (withTenant()'s SET LOCAL +
 * FORCE ROW LEVEL SECURITY policies) is airtight against the app's own
 * queries — but it is a property of the CONNECTING ROLE, not of the code.
 * A superuser, or any role with BYPASSRLS, ignores RLS policies entirely
 * (Postgres does this unconditionally — FORCE ROW LEVEL SECURITY does not
 * override it). Before this fix there was no check anywhere that the role
 * initPool() connects as is actually subject to RLS, so a deploy pointed at
 * the wrong connection string (the migration-owner role `vyne` instead of
 * the restricted `vyne_app` — this is in fact this repo's own local dev
 * default, see config.ts's dev fallback DATABASE_URL) would silently lose
 * tenant isolation: every withTenant() call would still "succeed" and
 * return data, just without any cross-tenant filtering, and nothing would
 * look wrong until row data from another tenant showed up in a response.
 *
 * This call is meant to run once at process startup (see index.ts), right
 * after initPool(). In production (`strict: true`) it throws and the
 * process must not start serving traffic. In dev/test (`strict: false`) it
 * only warns, because the general (non-RLS) test suite and the default
 * docker-compose setup intentionally connect as the owner role for
 * simplicity — RLS enforcement itself is covered separately by
 * test/rls.test.ts against the real vyne_app role (RLS_APP_URL). Migrations
 * are unaffected: migrate.ts opens its own pg.Client and never calls
 * initPool(), so this guard never runs during `npm run migrate`.
 */
/**
 * ── THE SCHEMA BOOT GUARD (v5.33.5) ────────────────────────────────────────
 *
 * WHAT HAPPENED. v5.33.3 shipped code that reads and writes
 * `interviews.synthetic` and `interview_transcripts.synthetic`, plus migration
 * 026 that creates them. The API was deployed; the migration was not run. The
 * code was live against a schema that did not have the columns, and the only
 * symptom was a consultant clicking "Generate" on a practice engagement and
 * getting:
 *
 *     Generation failed: internal_error
 *
 * That string is server.ts's global catch-all for ANY unhandled route error.
 * It is deliberately opaque — it must not leak an internal message to a browser
 * — so from the outside a missing column, a null dereference and a broken JSON
 * parse are indistinguishable. The real error (`column "synthetic" does not
 * exist`) was only ever in Cloud Logging, and nobody had a reason to look.
 *
 * WHY A DOC OR A CHECKLIST IS NOT THE FIX. The deploy runbook DID say to run
 * migrations. The gap is that `deploy.sh api` and `npm run migrate` are separate
 * commands against separate endpoints, and nothing connects them: a deploy that
 * skips the migration succeeds, reports success, and serves traffic. Making the
 * instructions louder does not change that. Making the process REFUSE TO BOOT
 * does.
 *
 * WHAT THIS DOES. Before the server accepts a request, assert that every column
 * the code depends on actually exists. In production a mismatch throws, so the
 * Cloud Run revision fails its health check and the previous, WORKING revision
 * keeps serving. Outside production it warns, because a developer mid-migration
 * should not be locked out of their own machine.
 *
 * A deploy that forgets the migration now fails loudly, in the deploy, naming
 * the file to run — instead of quietly breaking one feature for whoever finds
 * it first.
 *
 * ADDING TO THIS LIST is the price of a migration that adds a column the code
 * requires. That is the intended cost: it is one line, and it is paid by the
 * person who has the context, at the moment they have it.
 */
const REQUIRED_COLUMNS: { table: string; column: string; migration: string }[] = [
  { table: "engagements",           column: "code",      migration: "025_engagement_code_column.sql" },
  { table: "interviews",            column: "synthetic", migration: "026_synthetic_flag_column.sql" },
  { table: "interview_transcripts", column: "synthetic", migration: "026_synthetic_flag_column.sql" },
  { table: "interviews",            column: "depth",     migration: "028_interview_depth_column.sql" },
  /*
   * v5.34.67. Without engagement_id every BYOK lookup silently degrades to the
   * pre-v5.34.67 behaviour — matching on the client's NAME — which is exactly
   * the bug 037 exists to close: a rename detaches the key and the firm starts
   * paying, with nothing on screen to say so. A missing column here is not a
   * crash, it is a quiet return to the wrong answer, which is the class this
   * guard exists to catch at boot rather than in an invoice.
   */
  { table: "byok_keys",           column: "engagement_id", migration: "037_byok_engagement_binding.sql" },
  { table: "client_routing",      column: "engagement_id", migration: "037_byok_engagement_binding.sql" },
  { table: "byok_fallback_grant", column: "engagement_id", migration: "037_byok_engagement_binding.sql" },
  /*
   * v5.34.59. Without these the damage is worse than a broken screen:
   * admitLiveSession's INSERT names `payer`, so every live voice session fails
   * to open; dbMeter's INSERT names it too, and safeMeter SWALLOWS that failure
   * by design — so every usage row in the firm would be silently lost while the
   * product looked fine. Money spent and nothing recording it is the one
   * outcome this file exists to make impossible.
   */
  { table: "usage_events", column: "payer",          migration: "032_usage_payer.sql" },
  { table: "usage_events", column: "payer_key_hint", migration: "032_usage_payer.sql" },
  // v5.34.61. The keys screen reads last_error to say whether a key ACTUALLY
  // worked; findInvite reads revoked_at before honouring a setup link. Without
  // the latter a withdrawn link would still be redeemable, which is the whole
  // point of the column.
  { table: "byok_keys",    column: "last_error",     migration: "033_byok_key_health.sql" },
  { table: "byok_invites", column: "revoked_at",     migration: "033_byok_key_health.sql" },
];

/**
 * Whole TABLES the code requires, not just columns.
 *
 * v5.34.59, from a live failure this morning. Migrations 030 and 031 added
 * byok_keys and byok_invites; `deploy.sh all` does not run migrations, and
 * nothing noticed. The Client API keys screen answered "Could not load:
 * internal_error" and the boot guard above stayed silent, because it only ever
 * looked at COLUMNS and a missing table has none to miss.
 *
 * Diagnosing that cost a round trip through information_schema to discover
 * production was two releases behind on schema. The guard should have said so
 * at boot, in the deploy, naming the file.
 */
const REQUIRED_TABLES: { table: string; migration: string }[] = [
  { table: "byok_keys",      migration: "031_byok_client_grain.sql" },
  { table: "byok_invites",   migration: "031_byok_client_grain.sql" },
  { table: "client_routing", migration: "035_client_routing.sql" },
  /*
   * v5.34.64, and this one fails in the direction that costs money. Absent the
   * table, hasFallbackGrant() throws, server.ts catches and returns false, and
   * every BYOK client is treated as having no grant — so an unmigrated database
   * refuses live interviews for clients the firm explicitly agreed to cover.
   * Fail-closed is the right default for a missing grant; failing at boot with
   * the filename is better than discovering it from a consultant whose
   * interview would not start.
   */
  { table: "byok_fallback_grant", migration: "036_byok_fallback_grant.sql" },
];

/**
 * RLS POLICIES the code depends on, not just tables and columns.
 *
 * v5.34.63, and this one is here because of how it fails. Migration 034 adds a
 * policy that lets the interview-delete path remove a real transcript. Without
 * it the DELETE is not an error — row-level security simply filters every row
 * out, the statement reports zero rows affected, and the route happily returns
 * `{ ok: true, transcriptsErased: 0 }`.
 *
 * So an unmigrated database would tell a firm it had erased an interviewee's
 * transcript when it had done nothing of the kind. A missing column throws
 * somewhere; a missing policy quietly answers "nothing to do", which is worse,
 * and is exactly the class of silent wrongness this guard exists to catch.
 */
const REQUIRED_POLICIES: { table: string; policy: string; migration: string }[] = [
  { table: "interview_transcripts", policy: "tenant_delete_erasure", migration: "034_transcript_erasure.sql" },
];

export async function assertSchemaCurrent(
  targetPool: pg.Pool,
  opts: { strict: boolean }
): Promise<void> {
  const client = await targetPool.connect();
  try {
    const res = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (${
            REQUIRED_COLUMNS.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ")
          })`,
      REQUIRED_COLUMNS.flatMap((r) => [r.table, r.column])
    );
    const present = new Set(res.rows.map((r) => `${r.table_name}.${r.column_name}`));
    const missing = REQUIRED_COLUMNS.filter((r) => !present.has(`${r.table}.${r.column}`));

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [REQUIRED_TABLES.map((t) => t.table)]
    );
    const haveTables = new Set(tables.rows.map((r) => r.table_name));
    const missingTables = REQUIRED_TABLES.filter((t) => !haveTables.has(t.table));

    const policies = await client.query<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'`
    );
    const havePolicies = new Set(policies.rows.map((r) => `${r.tablename}.${r.policyname}`));
    const missingPolicies = REQUIRED_POLICIES.filter((p) => !havePolicies.has(`${p.table}.${p.policy}`));

    if (!missing.length && !missingTables.length && !missingPolicies.length) return;

    const files = [...new Set([...missing, ...missingTables, ...missingPolicies].map((m) => m.migration))];
    const msg =
      `DATABASE SCHEMA IS BEHIND THIS BUILD. Missing: ` +
      [...missing.map((m) => `${m.table}.${m.column}`),
       ...missingTables.map((t) => `table ${t.table}`),
       ...missingPolicies.map((p) => `policy ${p.table}.${p.policy}`)].join(", ") + `. ` +
      `This code reads and writes those columns, so the affected features will ` +
      `fail with a generic 500 ("internal_error") that names nothing. ` +
      `Run the migration(s) that create them — ${files.join(", ")} — against THIS ` +
      `database:\n\n` +
      `    ~/cloud-sql-proxy --port 5433 <project>:<region>:<instance>\n` +
      `    cd backend && DATABASE_URL='postgres://vyne:<OWNER_PW>@localhost:5433/vyne' npm run migrate\n\n` +
      `Expect it to NAME those files. "Nothing to apply — up to date." means the ` +
      `connection is pointed at a different database (port 5432 is the local one).`;

    if (opts.strict) throw new Error(msg);
    // eslint-disable-next-line no-console
    console.warn(
      `[SCHEMA BOOT GUARD] ${msg}\n\nContinuing because this is a non-production ` +
        `environment — the features above WILL fail until the migration is run.`
    );
  } finally {
    client.release();
  }
}

export async function assertRlsEnforceable(
  targetPool: pg.Pool,
  opts: { strict: boolean }
): Promise<void> {
  const client = await targetPool.connect();
  try {
    const res = await client.query<{
      is_superuser: boolean;
      bypass_rls: boolean;
      role_name: string;
    }>(
      `SELECT current_setting('is_superuser') = 'on' AS is_superuser,
              COALESCE(
                (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user),
                false
              ) AS bypass_rls,
              current_user AS role_name`
    );
    const row = res.rows[0];
    if (!row) return; // defensive — query always returns exactly one row
    if (row.is_superuser || row.bypass_rls) {
      const reason = row.is_superuser ? "a superuser" : "a BYPASSRLS role";
      const msg =
        `Database connection for serving requests is using role "${row.role_name}", ` +
        `which is ${reason} — row-level security is inert on this connection, so ` +
        `withTenant()'s tenant isolation silently degrades to "trust every query's own ` +
        `filtering" instead of being enforced by Postgres. The application must connect ` +
        `as a restricted, non-superuser, non-BYPASSRLS role (vyne_app — see ` +
        `src/db/migrations/001_core.sql) for any connection string used to SERVE requests. ` +
        `(Migrations are expected to run as the owner role; that's a separate connection.)`;
      if (opts.strict) {
        throw new Error(msg);
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[RLS BOOT GUARD] ${msg} Continuing because this is a non-production environment — ` +
          `this MUST be fixed before this configuration is used in production.`
      );
    }
  } finally {
    client.release();
  }
}
