-- =============================================================================
-- 002 — Module state store (the strangler-fig replacement for localStorage)
--
-- Legacy modules keep their existing key/value persistence shape; keys move
-- from the browser's localStorage to this tenant-scoped table. This gives
-- cross-device persistence + RLS isolation with minimal surgery inside the
-- 3,000-50,000-line module files. Normalisation into typed tables (e.g.
-- pre_engagement_briefings from 001) happens per-module in later passes.
-- =============================================================================

CREATE TABLE IF NOT EXISTS module_state (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module     text NOT NULL,                -- e.g. 'pre_engagement'
  key        text NOT NULL,                -- the module's own key, verbatim
  value      jsonb NOT NULL,               -- {"v": "<raw string the module stored>"}
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module, key)
);

ALTER TABLE module_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_state FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON module_state;
CREATE POLICY tenant_isolation ON module_state
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON module_state TO vyne_app;
