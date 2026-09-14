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

async function main(): Promise<void> {
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

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
