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
