-- =============================================================================
-- 008 — Audit log: close the RLS gap, add the owner-facing query surface
-- =============================================================================
-- audit_log has existed since 001_core.sql ("Audit log for security-relevant
-- events") but was never RLS-protected like every other tenant-owned table,
-- and had exactly one write site (tenant provisioning). This migration
-- closes the gap: RLS forced, same tenant_isolation policy as every other
-- table. See src/audit/log.ts for the write-side helper and
-- src/routes/audit.ts for the owner-only GET /api/audit-log surface this
-- protects.
-- =============================================================================

DROP POLICY IF EXISTS tenant_isolation ON audit_log;
CREATE POLICY tenant_isolation ON audit_log
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_time ON audit_log(tenant_id, created_at DESC);
