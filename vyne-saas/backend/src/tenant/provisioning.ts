/**
 * Firm (tenant) provisioning — the Option-B signup path.
 *
 * Creates, atomically from the caller's perspective:
 *   1. An Identity Platform tenant (the firm's isolated user pool)
 *   2. Our tenants row linking to it
 *   3. The first user in that pool + a users row + an 'owner' membership
 *
 * Runs with system DB access (no tenant context exists yet) and requires
 * GCP credentials — locally use a service-account JSON via
 * GOOGLE_APPLICATION_CREDENTIALS, on Cloud Run it's automatic.
 */
import { getAuth } from "firebase-admin/auth";
import { withoutTenant } from "../db/pool.js";

export interface ProvisionInput {
  firmName: string;
  ownerEmail: string;
  ownerPassword: string;
  ownerName?: string;
}

export interface ProvisionResult {
  tenantId: string;
  idpTenantId: string;
  ownerUserId: string;
  /** Human-friendly firm handle for login links: /?firm=<slug>. */
  slug: string;
}

/** "Meridian Advisors LLC" → "meridian-advisors-llc". */
export function slugifyFirmName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "firm";
}

export async function provisionFirm(input: ProvisionInput): Promise<ProvisionResult> {
  // 1. Identity Platform tenant (display name: alphanumeric + hyphens, 4-20 chars)
  const display = input.firmName.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 20).padEnd(4, "0");
  const idpTenant = await getAuth().tenantManager().createTenant({
    displayName: display,
    emailSignInConfig: { enabled: true, passwordRequired: true },
  });

  try {
    // 2. First user inside that tenant's pool
    const idpUser = await getAuth()
      .tenantManager()
      .authForTenant(idpTenant.tenantId)
      .createUser({
        email: input.ownerEmail,
        password: input.ownerPassword,
        displayName: input.ownerName,
      });

    // 3. Our rows
    return await withoutTenant(async (c) => {
      await c.query("BEGIN");
      try {
        // Unique slug: base name, then -2, -3… on collision.
        const base = slugifyFirmName(input.firmName);
        const taken = await c.query<{ slug: string }>(
          `SELECT slug FROM tenants WHERE slug = $1 OR slug LIKE $1 || '-%'`, [base]
        );
        const have = new Set(taken.rows.map((r) => r.slug));
        let slug = base;
        for (let n = 2; have.has(slug); n++) slug = `${base}-${n}`;

        const t = await c.query<{ id: string }>(
          `INSERT INTO tenants (name, idp_tenant_id, slug) VALUES ($1, $2, $3) RETURNING id`,
          [input.firmName, idpTenant.tenantId, slug]
        );
        const u = await c.query<{ id: string }>(
          `INSERT INTO users (identity_platform_uid, email, name)
           VALUES ($1, $2, $3) RETURNING id`,
          [idpUser.uid, input.ownerEmail, input.ownerName ?? null]
        );
        await c.query(
          `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`,
          [u.rows[0].id, t.rows[0].id]
        );
        await c.query(
          `INSERT INTO audit_log (tenant_id, user_id, action, detail)
           VALUES ($1, $2, 'tenant_provisioned', $3)`,
          [t.rows[0].id, u.rows[0].id, JSON.stringify({ firmName: input.firmName })]
        );
        await c.query("COMMIT");
        return {
          tenantId: t.rows[0].id,
          idpTenantId: idpTenant.tenantId,
          ownerUserId: u.rows[0].id,
          slug,
        };
      } catch (err) {
        await c.query("ROLLBACK");
        throw err;
      }
    });
  } catch (err) {
    // Roll back the orphaned Identity Platform tenant on DB failure.
    await getAuth().tenantManager().deleteTenant(idpTenant.tenantId).catch(() => {});
    throw err;
  }
}
