/**
 * Permission for the firm's key to cover a BYOK client's failure. (v5.34.64)
 *
 * ── What this is ────────────────────────────────────────────────────────────
 *
 * From v5.34.64 a client with an active key on file runs ONLY on their own
 * credentials. When that credential is refused the call fails and says so. A
 * grant here is the firm choosing, per client and in advance, to carry that
 * client's failures on its own account instead.
 *
 * Presence is the grant. There is no boolean column and therefore no
 * "granted = false" row to misread as permission — withdrawal deletes, and the
 * absence of a row is the safe state. Every read is a plain existence check.
 *
 * ── Why not a firm-wide switch ──────────────────────────────────────────────
 *
 * Because the decision is not uniform. A firm may well want continuity for the
 * client mid-pilot whose procurement is still sorting out a billing account,
 * and emphatically not for the client who supplied a key six months ago and has
 * not looked at it since. A single switch would be set once, for the first
 * case, and then silently apply to the second.
 */
import { withTenant } from "../../db/pool.js";
import { normClient } from "../../auth/clients.js";

export interface FallbackGrant {
  clientNorm: string;
  clientName: string;
  reason: string | null;
  grantedAt: string;
}

type Row = {
  client_norm: string; client_name: string; reason: string | null; granted_at: Date;
};

const shape = (r: Row): FallbackGrant => ({
  clientNorm: r.client_norm,
  clientName: r.client_name,
  reason: r.reason,
  grantedAt: r.granted_at.toISOString(),
});

/**
 * May the firm's credential cover this client?
 *
 * Returns false for unattributed work as well — but that path never reaches
 * here, because a call with no client has no client key to confine it to and
 * the firm's chain is the only chain there is.
 */
export async function hasFallbackGrant(
  tenantId: string,
  clientName: string | undefined
): Promise<boolean> {
  if (!clientName) return false;
  const norm = normClient(clientName);
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT 1 FROM byok_fallback_grant
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND client_norm = $1`,
      [norm]
    );
    return (r.rowCount ?? 0) > 0;
  });
}

/** Every grant on file, for the keys screen. */
export async function listFallbackGrants(tenantId: string): Promise<FallbackGrant[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query<Row>(
      `SELECT client_norm, client_name, reason, granted_at
         FROM byok_fallback_grant
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
        ORDER BY client_name`
    );
    return r.rows.map(shape);
  });
}

/** Grant, or re-state an existing grant with a new reason. */
export async function grantFallback(a: {
  tenantId: string; clientName: string; reason?: string; grantedBy?: string;
}): Promise<FallbackGrant> {
  const norm = normClient(a.clientName);
  return withTenant(a.tenantId, async (c) => {
    const r = await c.query<Row>(
      `INSERT INTO byok_fallback_grant (tenant_id, client_norm, client_name, reason, granted_by)
       VALUES (current_setting('app.tenant_id', true)::uuid, $1, $2, $3, $4)
       ON CONFLICT (tenant_id, client_norm) DO UPDATE SET
         client_name = EXCLUDED.client_name,
         reason      = EXCLUDED.reason,
         granted_by  = EXCLUDED.granted_by,
         granted_at  = now()
       RETURNING client_norm, client_name, reason, granted_at`,
      [norm, a.clientName, a.reason ?? null, a.grantedBy ?? null]
    );
    return shape(r.rows[0]);
  });
}

/** Withdraw. The client's work goes back to failing when their key fails. */
export async function revokeFallback(tenantId: string, clientName: string): Promise<boolean> {
  const norm = normClient(clientName);
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `DELETE FROM byok_fallback_grant
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid AND client_norm = $1`,
      [norm]
    );
    return (r as { rowCount?: number }).rowCount === 1;
  });
}
