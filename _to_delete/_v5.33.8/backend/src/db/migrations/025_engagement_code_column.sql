-- =============================================================================
-- 025 — the engagement CODE becomes a real column
--
-- v5.32.96. Until now ENG-XXXX-XXXX existed ONLY inside module_state JSON:
-- as the values of vynora_engagement_index and as the suffix of
-- vynora_engagement_<CODE>. Two consequences, both of which this migration
-- exists to end.
--
-- 1. THE CLIENT'S NAME WAS THE IDENTITY. Because the code had no home the
--    server could rely on, every per-client workspace key was suffixed with
--    normClient(name) instead — vynora_briefing_meridianfoods and ~8 other
--    families. Renaming a client was therefore not a field update but a bulk
--    key migration across a dozen families, and every bug in the long rename
--    saga (v5.32.7 through v5.32.95) was debris or drift from one of those
--    migrations: duplicate index entries, keys stranded under an old norm,
--    orphans blocking a rename back to a name used before, a record patched
--    "only if it already agrees". A name that is a key cannot be renamed
--    safely; a name that is a display string can.
--
-- 2. THE BINDING WAS FORGEABLE. code → client is read from
--    vynora_engagement_index, which lives in the tenant's own workspace state
--    and is therefore writable by any consultant who can PUT module state.
--    auth/clients.ts's scopeWorkspaceWrite() carries a whole guard for this
--    (the CR-1 code-ownership check, hardened again in v5.32.64 / V2-H4)
--    precisely because a restricted consultant could otherwise rebind a code
--    to their own norm and read another client's data. With the code in a
--    column consultants cannot write, buildWorkspaceMaps() can be SEEDED from
--    the database and stop trusting the JSON at all for codes it knows.
--
-- Authorization itself is NOT moved onto codes here. That still runs on
-- client_assignments.client_norm, which is indexed, non-user-writable and
-- covered by the 4000-case fuzz suite. This migration is what makes that move
-- possible later, on a base where the code is trustworthy.
--
-- Nothing is dropped. client_name stays exactly where it is — it is the
-- display name, and the rename path still updates it.
-- =============================================================================

ALTER TABLE engagements ADD COLUMN IF NOT EXISTS code text;

-- ── RLS OFF for the backfill ────────────────────────────────────────────────
--
-- `engagements` and `module_state` are FORCE ROW LEVEL SECURITY keyed on
-- current_setting('app.tenant_id'). FORCE means the TABLE OWNER is subject to
-- them too, so a migration connected as `vyne` with no tenant set reads ZERO
-- rows from both — with no error. The backfill below would run happily, match
-- nothing, and report success, while ALTER COLUMN ... SET NOT NULL (which is
-- DDL and is NOT row-filtered) would then fail on the NULLs it can still see.
--
-- That is not hypothetical: it is exactly how this migration failed the first
-- time it was run against production. Migration 011 established the pattern
-- for a data migration that must see every tenant's rows; this follows it.
--
-- The runner wraps each migration file in a single transaction, so a failure
-- anywhere below rolls this back and RLS is never left off. Anyone applying
-- this file by hand MUST wrap it in BEGIN/COMMIT for the same reason.
ALTER TABLE engagements  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE engagements  DISABLE  ROW LEVEL SECURITY;
ALTER TABLE module_state NO FORCE ROW LEVEL SECURITY;
ALTER TABLE module_state DISABLE  ROW LEVEL SECURITY;

-- ── Backfill 1: adopt the code this tenant is already using ─────────────────
--
-- vynora_engagement_index is { "<normalized client name>": "<CODE>" }. Adopting
-- the existing code matters more than it looks: every code-suffixed key already
-- in module_state (vynora_engagement_<CODE>, the synthesis and roadmap blobs,
-- the refresh agendas) is addressed by it, so minting a fresh code here would
-- orphan all of them.
--
-- DISTINCT ON is load-bearing. Production has been observed with TWO norms
-- pointing at one code:
--   {"meridianfoodsnew":"ENG-GSC6-Y7ME","meridianfoodstest":"ENG-GSC6-Y7ME"}
-- which is exactly the debris the rename bug left behind. Without the dedupe,
-- two engagements rows would claim one code and the unique index at the bottom
-- of this file would fail the whole migration. The most recently updated row
-- wins; the loser gets a fresh code from backfill 2 and keeps its own data.
--
-- The index value is read defensively: a tenant whose index is malformed JSON
-- must not abort a migration for every other tenant.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT ms.tenant_id, ms.value->>'v' AS raw
      FROM module_state ms
     WHERE ms.module = 'workspace'
       AND ms.key = 'vynora_engagement_index'
  LOOP
    BEGIN
      WITH idx AS (
        SELECT kv.key AS norm, kv.value AS code
          FROM jsonb_each_text(r.raw::jsonb) AS kv(key, value)
         WHERE kv.value ~ '^[A-Za-z0-9_-]{1,64}$'
      ),
      pick AS (
        SELECT DISTINCT ON (i.code) i.code, e.id
          FROM idx i
          JOIN engagements e
            ON e.tenant_id = r.tenant_id
           AND vyne_norm_client(e.client_name) = i.norm
         WHERE e.code IS NULL
         ORDER BY i.code, e.updated_at DESC NULLS LAST, e.id
      )
      UPDATE engagements e
         SET code = pick.code
        FROM pick
       WHERE e.id = pick.id;
    EXCEPTION WHEN others THEN
      RAISE NOTICE '025: skipping unreadable engagement index for tenant % (%)', r.tenant_id, SQLERRM;
    END;
  END LOOP;
END $$;

-- ── Backfill 2: mint a code for every engagement that still has none ────────
--
-- Clients created before a code was ever minted for them — which is most of
-- them, because until v5.32.96 a code appeared only when the first interview
-- completed (routes/interviews.ts) or a synthetic set was generated. A client
-- with a briefing and no interviews had no code at all, which is the window
-- that made name-keyed storage feel unavoidable in the first place.
--
-- Derived from the row's own uuid so it is deterministic and re-runnable, in
-- the same ENG-XXXX-XXXX shape the UI shows. Retried on the off-chance of a
-- collision within a tenant rather than failing the migration.
DO $$
DECLARE
  r RECORD;
  candidate text;
  attempt int;
BEGIN
  FOR r IN SELECT id, tenant_id FROM engagements WHERE code IS NULL LOOP
    attempt := 0;
    LOOP
      candidate := 'ENG-' ||
        upper(substr(md5(r.id::text || attempt::text), 1, 4)) || '-' ||
        upper(substr(md5(r.id::text || attempt::text), 5, 4));
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM engagements
         WHERE tenant_id = r.tenant_id AND code = candidate
      );
      attempt := attempt + 1;
      IF attempt > 50 THEN
        RAISE EXCEPTION '025: could not mint a unique engagement code for %', r.id;
      END IF;
    END LOOP;
    UPDATE engagements SET code = candidate WHERE id = r.id;
  END LOOP;
END $$;

-- ── Confirmation, while the rows are still visible ─────────────────────────
--
-- Counted HERE, before RLS is restored, and raised as a NOTICE rather than
-- SELECTed. A SELECT placed after the ENABLE below would report 0 rows to the
-- table's own owner and look like a clean run over a migration that did
-- nothing — the same lie that made the first attempt at this file fail. The
-- EXCEPTION is what turns "backfill matched nothing" into a rollback instead
-- of a NOT NULL error forty lines later.
DO $$
DECLARE total int; coded int;
BEGIN
  SELECT count(*), count(code) INTO total, coded FROM engagements;
  RAISE NOTICE '025: % engagements, % with a code', total, coded;
  IF total <> coded THEN
    RAISE EXCEPTION '025: % engagements still have no code — backfill did not match', total - coded;
  END IF;
END $$;

-- ── RLS back ON, before anything else ──────────────────────────────────────
ALTER TABLE module_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_state FORCE  ROW LEVEL SECURITY;
ALTER TABLE engagements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagements  FORCE  ROW LEVEL SECURITY;

-- Every engagement now has one. NOT NULL is the point of the exercise: it is
-- what lets the rest of the codebase stop asking "what if there is no code?"
-- and start treating the code as the identity.
ALTER TABLE engagements ALTER COLUMN code SET NOT NULL;

-- One code per tenant. Not globally unique — codes are shown to consultants and
-- a collision across firms is harmless, while a global constraint would leak
-- the existence of another firm's engagement through an insert failure.
CREATE UNIQUE INDEX IF NOT EXISTS idx_engagements_tenant_code
  ON engagements (tenant_id, code);

