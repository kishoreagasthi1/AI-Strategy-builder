-- =============================================================================
-- VYNE SaaS — Core schema + Row-Level Security (Phase 0)
--
-- Tenant isolation contract:
--   * Every tenant-owned table carries tenant_id.
--   * RLS policies compare tenant_id to current_setting('app.tenant_id').
--   * The API sets that variable per-transaction (SET LOCAL) after verifying
--     the caller's JWT. The database therefore enforces isolation even if
--     application code has a bug.
--
-- IMPORTANT (ops): the application must connect as a NON-OWNER role
-- (vyne_app below). Table owners and superusers bypass RLS unless FORCE is
-- set — we set FORCE anyway, belt and braces.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- --- Application role (created idempotently; password set by ops) ------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vyne_app') THEN
    CREATE ROLE vyne_app LOGIN PASSWORD 'change-me-via-ops';
  END IF;
END $$;

-- --- Tenants (firms). Not RLS-protected per-row for the provisioning path; --
--     the API only ever exposes the caller's own tenant row. ------------------
CREATE TABLE IF NOT EXISTS tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  -- Identity Platform tenant that backs this firm's user pool
  idp_tenant_id  text UNIQUE,
  plan           text NOT NULL DEFAULT 'trial',      -- trial | sprint | transformation | caio
  status         text NOT NULL DEFAULT 'active',     -- active | suspended
  -- Plan limits stubbed NOW so billing can attach later without a schema change
  monthly_token_limit bigint,                        -- NULL = unlimited
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_platform_uid text NOT NULL UNIQUE,
  email                 text NOT NULL,
  name                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'consultant',    -- owner | consultant  (client_viewer: later phase)
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS engagements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_name text NOT NULL,
  industry    text,
  status      text NOT NULL DEFAULT 'active',       -- active | archived
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_engagements_tenant ON engagements(tenant_id);

-- Metering: one row per LLM call. Billing attaches to this later.
CREATE TABLE IF NOT EXISTS usage_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id),
  module      text NOT NULL,                        -- e.g. pre_engagement
  task        text NOT NULL,                        -- e.g. hypotheses, synthesis
  provider    text NOT NULL,                        -- adapter name
  model       text NOT NULL,
  tokens_in   integer NOT NULL DEFAULT 0,
  tokens_out  integer NOT NULL DEFAULT 0,
  cost_est_usd numeric(10,6) NOT NULL DEFAULT 0,
  latency_ms  integer,
  ok          boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_time ON usage_events(tenant_id, created_at);

-- Phase 1 table (created now so the shape is settled): Pre-Engagement state.
CREATE TABLE IF NOT EXISTS pre_engagement_briefings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  engagement_id    uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  hypotheses       jsonb NOT NULL DEFAULT '{}',
  benchmarks       jsonb NOT NULL DEFAULT '{}',
  issue_tree       jsonb NOT NULL DEFAULT '{}',
  doc_intelligence jsonb NOT NULL DEFAULT '{}',
  source_docs      jsonb NOT NULL DEFAULT '[]',     -- GCS object references
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id)
);
CREATE INDEX IF NOT EXISTS idx_preeng_tenant ON pre_engagement_briefings(tenant_id);

-- Audit log for security-relevant events (login, provisioning, role change).
CREATE TABLE IF NOT EXISTS audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid,
  user_id    uuid,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Row-Level Security
-- =============================================================================
ALTER TABLE engagements              ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagements              FORCE  ROW LEVEL SECURITY;
ALTER TABLE usage_events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events             FORCE  ROW LEVEL SECURITY;
ALTER TABLE pre_engagement_briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pre_engagement_briefings FORCE  ROW LEVEL SECURITY;

-- current_setting(..., true) returns NULL (not error) when unset → no rows.
DROP POLICY IF EXISTS tenant_isolation ON engagements;
CREATE POLICY tenant_isolation ON engagements
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON usage_events;
CREATE POLICY tenant_isolation ON usage_events
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON pre_engagement_briefings;
CREATE POLICY tenant_isolation ON pre_engagement_briefings
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Grants for the app role (NOT owner → RLS applies).
GRANT USAGE ON SCHEMA public TO vyne_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, users, memberships, engagements, usage_events,
  pre_engagement_briefings, audit_log
TO vyne_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vyne_app;
