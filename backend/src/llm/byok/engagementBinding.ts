/**
 * What "this client" means, for everything BYOK stores. (v5.34.67)
 *
 * ── One question, asked once ────────────────────────────────────────────────
 *
 * byok_keys, client_routing and byok_fallback_grant each answer "is this row
 * about that client?". Until v5.34.67 each answered it with the client's
 * normalised NAME, which made a rename silently detach all three — the key, the
 * model preference and the fallback grant — and put the firm back on the bill
 * without any screen saying so.
 *
 * Migration 025 had already settled this for the engagement record in
 * v5.32.96: "A name that is a key cannot be renamed safely; a name that is a
 * display string can." This module is the same settlement applied to
 * credentials, and it lives in one file so the three tables cannot drift apart
 * on the answer.
 *
 * ── Why the norm is still here ──────────────────────────────────────────────
 *
 * A key can be attached before the client exists as an engagement — the setup
 * link is issued by the Owner, the engagement is created later by a consultant
 * filling in Pre-Engagement. Those rows have no engagement to point at, and
 * refusing to read them would break every key attached before this release.
 * So a lookup resolves by engagement first and falls back to the norm, and a
 * row is upgraded to the engagement binding the moment one can be resolved.
 */
import { withTenant } from "../../db/pool.js";
import { normClient } from "../../auth/clients.js";

/**
 * Clients that BYOK may act on. (v5.34.67)
 *
 * Engagements, PLUS any client that already has a key, a preference or a grant
 * on file — even one with no engagement behind them.
 *
 * That second set exists because of what live testing found the moment the
 * pickers shipped: "ZZ BYOK Test" had an active key and a fallback grant, and
 * no engagement row. The key kept working — it falls back to the norm — but the
 * client had vanished from every dropdown, so their grant could not be
 * re-issued and their preference could not be set. Tightening what may be
 * ATTACHED had silently made existing configuration unmanageable, which is a
 * worse failure than the typo it was closing.
 *
 * `registered` says which set a name came from, so the screen can show the
 * difference rather than presenting an unregistered client as if nothing were
 * unusual about them.
 */
export async function byokClients(
  tenantId: string
): Promise<Array<{ clientName: string; registered: boolean }>> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query<{ client_name: string; registered: boolean }>(
      `WITH e AS (
         SELECT client_name, true AS registered FROM engagements
          WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
       ), legacy AS (
         SELECT client_name FROM byok_keys
          WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
         UNION SELECT client_name FROM client_routing
          WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
         UNION SELECT client_name FROM byok_fallback_grant
          WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
       )
       SELECT client_name, registered FROM e
       UNION
       SELECT l.client_name, false FROM legacy l
        WHERE NOT EXISTS (
          SELECT 1 FROM e WHERE vyne_norm_client(e.client_name) = vyne_norm_client(l.client_name))
       ORDER BY client_name`
    );
    return r.rows.map((x) => ({ clientName: x.client_name, registered: x.registered }));
  });
}

/** The engagement this client name refers to, or null if there is not one. */
export async function engagementIdFor(
  tenantId: string,
  clientName: string | undefined
): Promise<string | null> {
  if (!clientName) return null;
  const norm = normClient(clientName);
  if (!norm) return null;
  return withTenant(tenantId, async (c) => {
    /*
     * Matched through the application's own normClient(), via its SQL twin
     * (migration 037), rather than on client_name directly: "Nestlé USA" and
     * "nestle usa" are the same client everywhere else in this product, and a
     * binding that disagreed with that would reintroduce the split identity
     * this file exists to remove.
     */
    const r = await c.query<{ id: string }>(
      `SELECT id FROM engagements
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND vyne_norm_client(client_name) = $1
        ORDER BY created_at
        LIMIT 1`,
      [norm]
    );
    return r.rows[0]?.id ?? null;
  });
}

/**
 * The WHERE fragment that identifies one client's row, and its parameters.
 *
 * Returns SQL positioned from $1, so callers append their own parameters after
 * the ones returned here. Deliberately not a whole query: the three tables
 * select different columns and one of them needs an extra `provider` predicate.
 *
 * When an engagement is known the match is `engagement_id = $1 OR (engagement_id
 * IS NULL AND client_norm = $2)` — the second arm is what keeps pre-v5.34.67
 * rows, and rows attached before the client existed, readable. Without an
 * engagement it degrades to the norm alone, which is exactly the old behaviour.
 */
export function clientMatch(
  engagementId: string | null,
  clientNorm: string
): { sql: string; params: unknown[] } {
  if (engagementId) {
    return {
      sql: `(engagement_id = $1 OR (engagement_id IS NULL AND client_norm = $2))`,
      params: [engagementId, clientNorm],
    };
  }
  /*
   * No engagement resolves for this name — either the client does not exist
   * yet, or the name is stale.
   *
   * `engagement_id IS NULL` is the important half. Without it, a row that IS
   * bound to an engagement stayed reachable through its OLD name after a
   * rename: the rename does not rewrite client_norm, so "nestle" still matched
   * a key now belonging to "Nestlé USA". Two live names for one credential is
   * precisely the ambiguity migration 025 removed, and it would have let a
   * stale reference keep spending a client's key under a name they no longer
   * go by.
   *
   * A row bound to an engagement is therefore reachable ONLY through that
   * engagement. Unbound rows — pre-v5.34.67 keys, and keys attached before the
   * client existed — keep matching on the norm, which is what they have.
   */
  return { sql: `(engagement_id IS NULL AND client_norm = $1)`, params: [clientNorm] };
}
