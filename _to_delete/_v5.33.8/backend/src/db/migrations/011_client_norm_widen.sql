-- =============================================================================
-- 011 — Widen the client identity norm from 30 to 100 characters (v5.32.26)
--
-- normClient() truncated the normalized client name at 30 alphanumeric
-- characters. Two client names sharing a 30-character alphanumeric prefix
-- therefore collapsed onto ONE identity: a single assignment grant covered
-- both, one set of workspace keys held both clients' work, and the billing
-- statement summed their spend into one line. Realistic for firms carrying
-- several subsidiaries of the same group.
--
-- backend/src/auth/clients.ts now truncates at 100. This migration brings the
-- two flat client_norm COLUMNS up to the same rule by recomputing them from
-- the client_name that already sits beside them in the same row — no name
-- recovery needed, unlike the workspace KEYS (which embed the norm in the key
-- text and are migrated lazily by migrateLegacyNormKeys() on first read).
--
-- Only rows whose norm was actually truncated can change: the length guard
-- below restricts the rewrite to exactly those, and any name that is
-- naturally that long recomputes to the identical string anyway.
--
-- Widening can only SPLIT identities, never merge them, so no row can collide
-- with an existing one: client_assignments' primary key
-- (tenant_id, user_id, client_norm) held at most one row per legacy norm per
-- user, and it still holds at most one after the rewrite.
--
-- RLS: both tables are FORCE ROW LEVEL SECURITY and their policies key off
-- app.tenant_id, which is unset in the migration connection — every row would
-- be invisible and this would silently no-op. RLS is therefore disabled for
-- the duration of the two statements and restored immediately, inside the
-- same transaction the runner wraps each file in.
-- =============================================================================

-- Normalize exactly as normClient() does: lowercase, strip non-alphanumerics,
-- take the first 100 characters.
CREATE OR REPLACE FUNCTION vyne_norm_client(name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT substring(regexp_replace(lower(coalesce(name, '')), '[^a-z0-9]', '', 'g') FROM 1 FOR 100)
$$;

ALTER TABLE client_assignments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE client_assignments DISABLE ROW LEVEL SECURITY;

UPDATE client_assignments
   SET client_norm = vyne_norm_client(client_name)
 WHERE length(client_norm) = 30
   AND client_norm IS DISTINCT FROM vyne_norm_client(client_name);

ALTER TABLE client_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_assignments FORCE  ROW LEVEL SECURITY;

ALTER TABLE usage_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_events DISABLE ROW LEVEL SECURITY;

UPDATE usage_events
   SET client_norm = vyne_norm_client(client_name)
 WHERE client_name IS NOT NULL
   AND length(client_norm) = 30
   AND client_norm IS DISTINCT FROM vyne_norm_client(client_name);

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE  ROW LEVEL SECURITY;
