-- =============================================================================
-- 010 — V225-audit follow-up hardening (H1/H2 fixes are frontend/app-code
-- only, no schema change needed for those; this migration covers the two
-- schema-touching Lows from the same review round).
-- =============================================================================

-- Stripe webhook ordering guard (v5.30 billing Low): Stripe does not
-- guarantee webhook delivery order, and a delayed/out-of-order event
-- (a retried older delivery arriving after a newer one already applied)
-- could otherwise momentarily overwrite a tenant's subscription_status
-- with stale data. billing/subscriptions.ts now stamps the event's own
-- `created` timestamp here on every subscription-lifecycle update and only
-- applies an update when the incoming event is at least as new as what's
-- already recorded — see applyWebhookEvent()'s doc comment.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_last_event_at timestamptz;

-- audit_log WORM (v5.30 billing Low): the blanket grant in 001_core.sql
-- gave vyne_app UPDATE/DELETE on every tenant table that existed at the
-- time, including audit_log — meaning the application's own DB role could
-- silently rewrite or erase its own audit trail (by design intent audit_log
-- is meant to be append-only; nothing enforced that at the grant level).
-- Revoking those two privileges makes tampering require a role change, not
-- just a bug or a compromised app process — the audit route (routes/audit.ts)
-- and every write site (audit/log.ts's auditLog()) only ever INSERT/SELECT.
REVOKE UPDATE, DELETE ON audit_log FROM vyne_app;
