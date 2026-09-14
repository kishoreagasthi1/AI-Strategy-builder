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
  pool = new Pool({ connectionString: databaseUrl, max: 10 });
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
