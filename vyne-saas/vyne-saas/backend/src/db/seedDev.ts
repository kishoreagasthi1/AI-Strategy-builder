/**
 * Local dev seed — creates a dev firm + owner user + membership directly in
 * the DB (no Identity Platform), matching the DevVerifier's "dev:<uid>"
 * tokens. Run once after migrations:
 *
 *   DATABASE_URL=postgres://vyne:vyne@localhost:5432/vyne npm run seed:dev
 *
 * Then sign in on the shell page in dev mode as uid "dev-owner".
 */
import pg from "pg";

const DEV_UID = process.env.DEV_UID ?? "dev-owner";
const FIRM = process.env.DEV_FIRM ?? "Dev Firm";

export async function main(): Promise<void> {
  // V225-audit LOW fix: this creates an owner account tied to DevVerifier's
  // "dev:<uid>" token scheme, which accepts ANY uid as authenticated with
  // no real credential check — that's fine in dev (DEV_AUTH=1 already
  // disables it outside development in index.ts), but this script itself
  // had no such guard: pointing DATABASE_URL at a real production database
  // by mistake (a copy-pasted connection string, a misconfigured CI job)
  // would silently plant a trivially-known backdoor owner account. Refuse
  // outright when NODE_ENV says production, regardless of what DATABASE_URL
  // points at.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "seedDev refuses to run with NODE_ENV=production — this seeds a dev-only " +
      "backdoor account (DevVerifier's unauthenticated dev:<uid> token scheme) " +
      "that must never exist in a real environment."
    );
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("BEGIN");
    const t = await c.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ($1)
       ON CONFLICT DO NOTHING RETURNING id`,
      [FIRM]
    );
    const tenantId =
      t.rows[0]?.id ??
      (await c.query<{ id: string }>(`SELECT id FROM tenants WHERE name = $1`, [FIRM])).rows[0].id;

    const u = await c.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email, name)
       VALUES ($1, $2, 'Dev Owner')
       ON CONFLICT (identity_platform_uid)
       DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [DEV_UID, `${DEV_UID}@dev.local`]
    );
    await c.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')
       ON CONFLICT DO NOTHING`,
      [u.rows[0].id, tenantId]
    );
    await c.query("COMMIT");
    console.log(`Seeded: firm "${FIRM}" (${tenantId}), owner uid "${DEV_UID}"`);
    console.log(`Dev sign-in token: dev:${DEV_UID}`);
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    await c.end();
  }
}

// Only auto-run when executed directly as a script (npm run seed:dev), not
// when imported — e.g. by a test exercising the NODE_ENV=production guard
// above without wanting a real DB connection attempt as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
