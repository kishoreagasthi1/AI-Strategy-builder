-- =============================================================================
-- 027 — reclaim an engagement code that migration 025 minted over
--
-- v5.33.3, from an external audit (MEDIUM).
--
-- WHAT 025 GOT WRONG. Its first backfill adopts the code the tenant is already
-- using, by joining the workspace index to the engagements table on the name:
--
--     JOIN engagements e ON vyne_norm_client(e.client_name) = i.norm
--
-- vyne_norm_client() is the 100-CHARACTER norm (migration 011). But
-- vynora_engagement_index keys were written by the browser, and a tenant that
-- has not been re-read as an owner since migrateLegacyNormKeys() shipped still
-- has 30-CHARACTER legacy keys in it. For any client whose normalized name is
-- longer than 30 characters, `i.norm` is the truncation and the join misses.
--
-- 025's second backfill then MINTS A FRESH CODE for that engagement, and the
-- NOT NULL confirmation passes — every row has a code, so nothing looks wrong.
-- But every code-suffixed workspace blob for that client is addressed by the
-- OLD code: vynora_synthesis_full_<OLD>, vynora_interview_archive_<OLD>,
-- vynora_refresh_agenda_<OLD>, the roadmap families. The engagement now points
-- somewhere those blobs are not. The consultant sees an engagement with its
-- synthesis, transcripts and roadmap gone.
--
-- Availability, not isolation — no data crosses a client boundary. It needs a
-- client whose name normalizes to more than 30 characters AND an index that had
-- not been migrated when 025 ran. "Managed Healthcare & Health Insurance"
-- normalizes to 34.
--
-- WHY A NEW FILE RATHER THAN A FIX TO 025. 025 has already been applied to
-- production. Editing an applied migration changes nothing that has run and
-- silently diverges the file from the database — so the repair has to be its
-- own forward step, and it has to be safe to run where 025 worked correctly
-- (which is the common case, and where this file does nothing at all).
--
-- WHAT THIS DOES. For every engagement whose code is referenced by NO index
-- entry, look for an index entry — under either norm width — whose code is
-- claimed by no engagement in that tenant. That pairing is unambiguous: an
-- orphaned engagement and an orphaned code, for the same client name. Adopt it.
-- Anything that does not pair up cleanly is left exactly as it is.
-- =============================================================================

-- Same RLS trap as 025 and 026. FORCE ROW LEVEL SECURITY binds the table owner,
-- so a migration with no app.tenant_id set reads zero rows and "succeeds"
-- having done nothing. See 025's header for how that failed in production.
ALTER TABLE engagements  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE engagements  DISABLE  ROW LEVEL SECURITY;
ALTER TABLE module_state NO FORCE ROW LEVEL SECURITY;
ALTER TABLE module_state DISABLE  ROW LEVEL SECURITY;

DO $$
DECLARE
  r RECORD;
  fixed int := 0;
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
      -- An index code that NO engagement in this tenant holds. If some
      -- engagement already holds it, there is nothing orphaned about it.
      orphan_code AS (
        SELECT i.norm, i.code
          FROM idx i
         WHERE NOT EXISTS (
           SELECT 1 FROM engagements e
            WHERE e.tenant_id = r.tenant_id AND e.code = i.code
         )
      ),
      -- An engagement whose code appears nowhere in the index — i.e. one that
      -- 025 minted rather than adopted.
      orphan_eng AS (
        SELECT e.id, e.client_name, e.updated_at
          FROM engagements e
         WHERE e.tenant_id = r.tenant_id
           AND NOT EXISTS (SELECT 1 FROM idx i WHERE i.code = e.code)
      ),
      -- Pair them by NAME, accepting either norm width. left(…, 30) is the
      -- legacy norm exactly: migration 011's widening changed only the length.
      -- DISTINCT ON keeps this deterministic if a name somehow pairs twice.
      pick AS (
        SELECT DISTINCT ON (oe.id) oe.id, oc.code
          FROM orphan_eng oe
          JOIN orphan_code oc
            ON oc.norm = vyne_norm_client(oe.client_name)
            OR oc.norm = left(vyne_norm_client(oe.client_name), 30)
         ORDER BY oe.id, oc.norm
      )
      UPDATE engagements e
         SET code = pick.code, updated_at = now()
        FROM pick
       WHERE e.id = pick.id
         -- Never take a code another engagement in this tenant already holds;
         -- the unique index would fail the whole migration and the loser would
         -- be worse off than before.
         AND NOT EXISTS (
           SELECT 1 FROM engagements x
            WHERE x.tenant_id = e.tenant_id AND x.code = pick.code AND x.id <> e.id
         );
      GET DIAGNOSTICS fixed = ROW_COUNT;
      IF fixed > 0 THEN
        RAISE NOTICE '027: reclaimed % engagement code(s) for tenant %', fixed, r.tenant_id;
      END IF;
    EXCEPTION WHEN others THEN
      -- One tenant's malformed index must not abort the migration for the rest.
      RAISE NOTICE '027: skipping unreadable engagement index for tenant % (%)', r.tenant_id, SQLERRM;
    END;
  END LOOP;
END $$;

-- Restated afterwards, because "did 025 orphan anything here" is the question
-- an operator will actually want answered and it is invisible otherwise.
DO $$
DECLARE stranded int;
BEGIN
  SELECT count(*) INTO stranded
    FROM engagements e
   WHERE NOT EXISTS (
     SELECT 1
       FROM module_state ms,
            LATERAL jsonb_each_text((ms.value->>'v')::jsonb) AS kv(k, v)
      WHERE ms.module = 'workspace'
        AND ms.key = 'vynora_engagement_index'
        AND ms.tenant_id = e.tenant_id
        AND kv.v = e.code
   );
  -- Not an error: an engagement created after 025 legitimately has a code that
  -- the browser has never written an index entry for. This is a number to read,
  -- not a gate.
  RAISE NOTICE '027: % engagement(s) hold a code no index entry references', stranded;
END $$;

ALTER TABLE module_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_state FORCE  ROW LEVEL SECURITY;
ALTER TABLE engagements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagements  FORCE  ROW LEVEL SECURITY;
