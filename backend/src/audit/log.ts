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
  | "client_renamed"
  // v5.32.57 SECURITY. Reusing an existing Identity Platform login resets its
  // PASSWORD, which is a credential change on an account this request did not
  // create. Both places that do it were silent; a firm owner had no way to see
  // that their own login had been re-issued. See routes/interviews.ts and
  // routes/assignments.ts.
  | "idp_credential_reset"
  | "idp_credential_reset_refused"
  // SaaS subscription billing (v5.30) — see billing/subscriptions.ts.
  | "subscription_checkout_started"
  | "subscription_checkout_completed"
  | "subscription_status_changed"
  | "subscription_canceled"
  /*
   * v5.34.63. Deleting an interview now erases its transcript — the verbatim
   * conversation with a named executive — which until 034 no code path could
   * remove at all. The content goes; this row is what is left to say it
   * happened, and it carries names and a count but never any of the words.
   */
  | "transcript_erased";

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
