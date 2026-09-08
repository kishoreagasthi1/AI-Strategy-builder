-- =============================================================================
-- 003 — Distributed interviews (Phase 2.5)
--
-- The Interview Agent becomes multi-user: client interviewees get their own
-- logins (membership role 'interviewee'), each completes their interview
-- independently in a PRIVATE state namespace, and consultants track all
-- interviews (invited / in_progress / completed) per engagement.
--
-- Role model from here on:
--   owner       — firm admin (everything a consultant can, plus admin)
--   consultant  — full workspace: briefing, all interviews, synthesis
--   interviewee — exactly ONE interview: their own. No workspace access,
--                 no briefing, no other sessions. Enforced in routes AND
--                 by the private per-interview state namespace.
-- =============================================================================

CREATE TABLE IF NOT EXISTS interviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_name      text NOT NULL,               -- the firm's client this interview belongs to
  interviewee_name text NOT NULL,
  interviewee_role text NOT NULL,               -- e.g. CFO, COO (drives dimension weighting)
  -- The platform user account the interviewee signs in with
  interviewee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'invited',   -- invited | in_progress | completed
  -- Private module_state namespace for this interview's session data
  state_module     text NOT NULL,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_interviews_tenant ON interviews(tenant_id);
CREATE INDEX IF NOT EXISTS idx_interviews_user   ON interviews(interviewee_user_id);

ALTER TABLE interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE interviews FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON interviews;
CREATE POLICY tenant_isolation ON interviews
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON interviews TO vyne_app;
