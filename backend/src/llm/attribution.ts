/**
 * Who gets billed for this call? (v5.32.26)
 *
 * `clientName` on POST /api/llm/generate and the two voice endpoints is
 * attached automatically by vyneLLM in vyne-client.js, and every call site in
 * the app leaves it alone — so it LOOKED like a best-effort label rather than
 * an input worth checking. It is not: it flows to llm/metering.ts, becomes
 * usage_events.client_norm, and that column is what routes/billing.ts groups
 * and sums to produce the cost-recovery statement a firm invoices its client
 * from.
 *
 * These are HTTP endpoints, not UI affordances. Any authenticated user —
 * including an interviewee, whose whole role is to answer questions for ONE
 * client — could put an arbitrary string there and push their spend onto a
 * client they have no assignment to. Nothing leaks in that direction: it is a
 * one-way corruption of someone else's invoice, which is worse in a way,
 * because the number is wrong and looks authoritative and nobody gets an
 * error to investigate.
 *
 * The rule below is the same one every other client-scoped route already
 * follows — derive identity from the verified token, never the body:
 *   owner       → unrestricted, take the body's value.
 *   consultant  → only a client they are assigned to; otherwise unattributed.
 *   interviewee → the body is ignored entirely. Their client comes from their
 *                 own interviews row, which is also the only client they can
 *                 possibly be generating for.
 *
 * A rejected attribution falls back to UNATTRIBUTED rather than a 403. The
 * work the user asked for still happens and the spend is still metered
 * against the tenant — it just doesn't land on a client line it doesn't
 * belong to. Failing the generation instead would turn a billing-hygiene
 * check into a way to break someone's session.
 */
import { withTenant } from "../db/pool.js";
import { allowedClientNorms, clientAllowed } from "../auth/clients.js";
import type { RequestContext } from "../auth/middleware.js";

/** The interviewee's own client, from the interview row. */
async function ownInterviewClient(ctx: RequestContext): Promise<string | undefined> {
  return withTenant(ctx.tenantId, async (c) => {
    const r = await c.query<{ client_name: string }>(
      `SELECT client_name FROM interviews
        WHERE interviewee_user_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [ctx.userId]
    );
    return r.rows[0]?.client_name;
  });
}

/**
 * Resolve the client a metered call may be attributed to.
 * Returns undefined for "unattributed" — never throws, for an unauthorized
 * name (see above) or for a failed lookup. Attribution is a label on a
 * metering row; it is not worth failing the user's actual work over, and
 * "unattributed" is the safe direction to fail in.
 */
export async function resolveBillingClient(
  ctx: RequestContext,
  requested: string | undefined
): Promise<string | undefined> {
  // No attribution asked for → nothing to check, and no query to run. This
  // also keeps the common interviewee path off the database entirely.
  if (!requested) return undefined;
  if (ctx.role === "owner") return requested;
  try {
    if (ctx.role === "interviewee") return await ownInterviewClient(ctx);
    const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
    return clientAllowed(allowed, requested) ? requested : undefined;
  } catch {
    return undefined;
  }
}
