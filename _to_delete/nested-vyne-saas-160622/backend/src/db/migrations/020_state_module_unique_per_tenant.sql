-- =============================================================================
-- 020 — uq_interviews_state_module was GLOBAL. It must be per-tenant.
--
-- v5.32.60, and this is a correction to migration 019 shipped in v5.32.58.
--
-- 019 added:
--
--   CREATE UNIQUE INDEX uq_interviews_state_module
--     ON interviews (state_module) WHERE state_module <> 'pending';
--
-- with a comment arguing that state_module is derived from the interview's own
-- uuid and so genuinely is unique. That is true of interviews created through
-- the invite flow, and it is NOT true of every row in the table.
--
-- routes/synthetic.ts builds state_module DETERMINISTICALLY, from the client
-- name and the role:
--
--   iv_synth_<engagementcode>_<roleslug>_r<round>_<n>
--
-- Nothing in that string is tenant-scoped. So the moment two firms on the
-- platform generate a synthetic engagement for a client whose name yields the
-- same code — "Acme", "Northwind", any common name — the SECOND firm's
-- generation dies on a unique-violation and returns a 500 with no explanation.
-- One tenant's test data makes a feature permanently unavailable to another
-- tenant, which is precisely the class of cross-tenant coupling the whole RLS
-- design exists to prevent. An index is not subject to row-level security:
-- the constraint sees every tenant's rows whether or not the querying role can.
--
-- Found by test/full-flow-e2e.mts on its second run, when the first run's rows
-- were still on disk under a different tenant. It was invisible to every
-- single-tenant test in the suite, including the one that covers this route.
--
-- Uniqueness is still worth enforcing — two interviews sharing a private
-- namespace would be a cross-contamination bug — but the scope is the tenant,
-- which is the scope in which state_module is actually resolved (see
-- routes/moduleState.ts, which looks it up with the tenant already pinned).
-- =============================================================================

DROP INDEX IF EXISTS uq_interviews_state_module;

CREATE UNIQUE INDEX IF NOT EXISTS uq_interviews_tenant_state_module
  ON interviews (tenant_id, state_module)
  WHERE state_module <> 'pending';

COMMENT ON INDEX uq_interviews_tenant_state_module IS
  'A private interview namespace must be unique WITHIN a firm. Deliberately not '
  'globally unique: state_module is not always uuid-derived (see the synthetic '
  'generator), and a global constraint lets one tenant''s rows block another''s '
  'writes — an index is not subject to row-level security.';
