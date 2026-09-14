-- =============================================================================
-- 037 — BYOK binds to the ENGAGEMENT, not to the client's name.
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- byok_keys (031), client_routing (035) and byok_fallback_grant (036) are all
-- keyed on (tenant_id, client_norm) — the client's NAME, normalised. Renaming a
-- client therefore stranded all three: /api/clients/rename updates
-- module_state, engagements, interviews, client_assignments and usage_events,
-- and has never touched these tables. After a rename, activeKeyFor() finds
-- nothing, the client silently stops being a BYOK client, every call runs on
-- the FIRM's credential, and the keys screen still shows the key as healthy
-- under a name that no longer exists.
--
-- "Nestle" -> "Nestlé USA" was enough to start the firm paying.
--
-- ── Why this is worse than an oversight ──────────────────────────────────────
--
-- Migration 025 settled this question in v5.32.96, and said so in as many
-- words:
--
--     "THE CLIENT'S NAME WAS THE IDENTITY ... Renaming a client was therefore
--      not a field update but a bulk key migration across a dozen families, and
--      every bug in the long rename saga (v5.32.7 through v5.32.95) was debris
--      or drift from one of those migrations ... A name that is a key cannot be
--      renamed safely; a name that is a display string can."
--
-- It made engagements.code a real, server-minted, consultant-unwritable column
-- precisely so new work could stop using the name. BYOK was built across
-- v5.34.55-64 — months later — and went onto client_norm anyway, reasoning that
-- it matched usage_events. usage_events is an append-only ledger of things that
-- already happened; a stored credential is live configuration, and it is much
-- closer to the engagement RECORD, which 025 had already moved.
--
-- ── What this migration does, and does not, do ───────────────────────────────
--
-- Adds engagement_id to all three tables and backfills it by matching the
-- stored client_norm against engagements. Lookups resolve by engagement_id
-- first and fall back to client_norm, so:
--
--   * a rename becomes a no-op for BYOK — nothing in the binding mentions the
--     name, so there is nothing to migrate;
--   * rows whose engagement cannot be resolved (a key attached before the
--     client was created) keep working exactly as before, on the norm.
--
-- client_norm and client_name are deliberately KEPT. 025 kept client_name for
-- the same reason: it is the display string, and a screen that could only show
-- a uuid would be worse than one that shows a stale name.
--
-- Authorization is still NOT moved onto engagements here. That remains on
-- client_assignments.client_norm, exactly as 025 left it — it is covered by a
-- 4000-case fuzz suite and belongs in its own release, not bundled into a
-- credential-binding fix.
-- =============================================================================

ALTER TABLE byok_keys           ADD COLUMN IF NOT EXISTS engagement_id uuid;
ALTER TABLE client_routing      ADD COLUMN IF NOT EXISTS engagement_id uuid;
ALTER TABLE byok_fallback_grant ADD COLUMN IF NOT EXISTS engagement_id uuid;

-- ON DELETE SET NULL, not CASCADE. Deleting a client must not silently destroy
-- the record that they supplied a key, who attested to it, and when — that is
-- the audit trail behind a charge the client already paid. The row degrades to
-- its client_norm binding, which is what it had before this migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'byok_keys_engagement_fk') THEN
    ALTER TABLE byok_keys ADD CONSTRAINT byok_keys_engagement_fk
      FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_routing_engagement_fk') THEN
    ALTER TABLE client_routing ADD CONSTRAINT client_routing_engagement_fk
      FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'byok_fallback_grant_engagement_fk') THEN
    ALTER TABLE byok_fallback_grant ADD CONSTRAINT byok_fallback_grant_engagement_fk
      FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE SET NULL;
  END IF;
END $$;

/*
 * The SQL twin of auth/clients.ts's normClient(): lowercase, strip everything
 * that is not a letter or digit, cap at 100 characters. It exists so the
 * backfill below matches the application's own notion of "same client" rather
 * than an approximation of it — the two disagreeing is precisely the class of
 * bug this migration is closing.
 *
 * IMMUTABLE so it can be used in an index expression later if the authorization
 * move (see the header) ever needs one.
 */
CREATE OR REPLACE FUNCTION vyne_norm_client(name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT left(lower(regexp_replace(coalesce(name, ''), '[^A-Za-z0-9]', '', 'g')), 100)
$$;

-- Backfill. RLS is not in play here: this runs as the migration owner, and the
-- join is tenant-scoped explicitly so it cannot bind one firm's key to another
-- firm's engagement even if it were.
UPDATE byok_keys k SET engagement_id = e.id
  FROM engagements e
 WHERE k.engagement_id IS NULL
   AND e.tenant_id = k.tenant_id
   AND vyne_norm_client(e.client_name) = k.client_norm;

UPDATE client_routing r SET engagement_id = e.id
  FROM engagements e
 WHERE r.engagement_id IS NULL
   AND e.tenant_id = r.tenant_id
   AND vyne_norm_client(e.client_name) = r.client_norm;

UPDATE byok_fallback_grant g SET engagement_id = e.id
  FROM engagements e
 WHERE g.engagement_id IS NULL
   AND e.tenant_id = g.tenant_id
   AND vyne_norm_client(e.client_name) = g.client_norm;

CREATE INDEX IF NOT EXISTS idx_byok_keys_engagement
  ON byok_keys (tenant_id, engagement_id, provider) WHERE engagement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_client_routing_engagement
  ON client_routing (tenant_id, engagement_id) WHERE engagement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_byok_fallback_grant_engagement
  ON byok_fallback_grant (tenant_id, engagement_id) WHERE engagement_id IS NOT NULL;

COMMENT ON COLUMN byok_keys.engagement_id IS
  'v5.34.67: the binding. client_norm is kept as the fallback for keys attached before the client existed, and client_name purely for display.';
COMMENT ON COLUMN client_routing.engagement_id IS
  'v5.34.67: see byok_keys.engagement_id.';
COMMENT ON COLUMN byok_fallback_grant.engagement_id IS
  'v5.34.67: see byok_keys.engagement_id.';
