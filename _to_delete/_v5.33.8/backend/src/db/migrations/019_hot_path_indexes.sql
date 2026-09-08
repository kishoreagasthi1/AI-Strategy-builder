-- =============================================================================
-- 019 — Indexes for predicates that are hot and currently unindexed
--
-- v5.32.58. Each of these is a sequential scan on a path that runs constantly.
-- None of them hurt today at the current data volume, which is precisely why
-- they are worth adding now: the first firm with a few hundred interviews and
-- a few thousand users is not the moment to discover them.
-- =============================================================================

-- routes/moduleState.ts runs `WHERE state_module = $1` on EVERY read and write
-- of an iv_* namespace by a client-restricted consultant — so on every autosave
-- during every interview a consultant is watching. Only idx_interviews_tenant
-- existed, which does not help this predicate at all.
--
-- UNIQUE because it genuinely is: state_module is derived from the interview's
-- own uuid ("iv_" + id without hyphens). Making the constraint explicit means a
-- collision becomes an error instead of two interviews quietly sharing a
-- namespace — which would be a cross-contamination bug of exactly the kind this
-- release has been hunting.
CREATE UNIQUE INDEX IF NOT EXISTS uq_interviews_state_module
  ON interviews (state_module)
  WHERE state_module <> 'pending';

-- routes/firms.ts's /api/firm/by-email is PUBLIC (rate-limited per IP) and
-- routes/assignments.ts resolves members the same way. Both do
-- `lower(u.email) = ...` against the GLOBAL users table — every user of every
-- firm — with no functional index, so each call is a full scan.
CREATE INDEX IF NOT EXISTS idx_users_lower_email
  ON users (lower(email));

-- client_assignments' primary key is (tenant_id, user_id, client_norm), so
-- client_norm is not a usable leading column. Several lookups filter by
-- tenant + norm without a user, most importantly the client-deletion and
-- rename paths.
CREATE INDEX IF NOT EXISTS idx_client_assignments_tenant_norm
  ON client_assignments (tenant_id, client_norm);

-- routes/audit.ts paginates with `ORDER BY a.id DESC LIMIT $n` while the only
-- index is (tenant_id, created_at DESC). The planner falls back to a backward
-- scan of the primary key filtering on tenant_id — for a quiet tenant on an
-- append-only table that is never pruned, that means scanning the whole table
-- to find fifty rows.
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_id_desc
  ON audit_log (tenant_id, id DESC);

-- routes/billing.ts aggregates usage per client. The existing
-- idx_usage_events_client covers (tenant_id, client_norm, created_at); this
-- adds the task dimension, which both spend caps filter on when excluding the
-- non-billable live-session hold rows.
CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_task_time
  ON usage_events (tenant_id, task, created_at DESC);
