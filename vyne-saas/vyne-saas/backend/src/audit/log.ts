/**
 * Structured audit logging — writes to audit_log (RLS-protected as of
 * migration 008; see that file's doc comment for why it wasn't before).
 *
 * Scope, honestly stated: this covers events OUR backend can actually
 * observe cleanly — tenant provisioning, team/role membership changes,
 * client-assignment changes, and destructive actions (client deletion).
 * It deliberately does NOT try to log "login success/failure" — in
 * production, credential checking happens client-side against Identity
 * Platform directly (see frontend/index.html's sign-in flow), so our
 * backend never witnesses the actual authentication event. The closest
 * proxies (logging every GET /api/me, or every 401/403 from the auth hook)
 * would either fire on ordinary session-restore/polling traffic (noisy,
 * not a real "login") or lack a resolved tenant to scope the row to
 * (invalid/expired tokens never reach a membership lookup). Rather than
 * ship a misleading "login" audit trail, this is left as a known gap —
 * closing it properly needs a dedicated backend-observed login exchange,
 * which is a bigger auth-flow change than fits here.
 *
 * Best-effort by design, same philosophy as gateway.ts's safeMeter(): a
 * logging failure must never take down the operation it's recording.
 */
import { withTenant } from "../db/pool.js";

export type AuditAction =
  | "tenant_provisioned"
  | "consultant_added"
  | "consultant_removed"
  | "client_assignment_added"
  | "client_assignment_removed"
  | "client_deleted"
  // SaaS subscription billing (v5.30) — see billing/subscriptions.ts.
  | "subscription_checkout_started"
  | "subscription_checkout_completed"
  | "subscription_status_changed"
  | "subscription_canceled";

/**
 * Deliberately opens its OWN transaction rather than accepting an existing
 * client — decouples audit writes from the mutation they're recording
 * (same tradeoff safeMeter makes: an audit-log failure must never roll
 * back, or even fail, the real operation). Call this AFTER the operation
 * you're recording has committed successfully.
 */
export async function auditLog(
  tenantId: string,
  userId: string | null,
  action: AuditAction,
  detail: Record<string, unknown> = {}
): Promise<void> {
  try {
    await withTenant(tenantId, async (c) => {
      await c.query(
        `INSERT INTO audit_log (tenant_id, user_id, action, detail) VALUES ($1, $2, $3, $4)`,
        [tenantId, userId, action, JSON.stringify(detail)]
      );
    });
  } catch {
    // Deliberately swallowed — surfaced only via logs at the call site if
    // the caller chooses to .catch() and log; never lets audit logging
    // break the request it's recording. Mirrors gateway.ts's safeMeter().
  }
}
