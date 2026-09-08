-- =============================================================================
-- 004 — Per-consultant client assignments (Phase 5)
--
-- Client-data separation WITHIN a firm, enforced server-side:
--   owner       — sees every client of the firm, manages assignments
--   consultant  — sees ONLY the clients an owner has assigned to them.
--                 No assignment → no client data. Deny by default.
--   interviewee — unchanged: exactly their own interview (their client's
--                 sanitized briefing only — never any other client's).
--
-- Clients are identified by a normalized name (client_norm), matching the
-- normClient() convention used across all modules:
--   lower, strip non-alphanumerics, first 30 chars.
-- =============================================================================

CREATE TABLE IF NOT EXISTS client_assignments (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_name text NOT NULL,            -- display name as entered
  client_norm text NOT NULL,            -- normalized key used for matching
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, client_norm)
);
CREATE INDEX IF NOT EXISTS idx_client_assignments_user
  ON client_assignments(tenant_id, user_id);

ALTER TABLE client_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_assignments FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON client_assignments;
CREATE POLICY tenant_isolation ON client_assignments
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON client_assignments TO vyne_app;
