-- =============================================================================
-- APPLY migrations 026 + 027 BY HAND, ledger included  (v5.33.3)
--
-- WHEN TO USE THIS. `npm run migrate` through cloud-sql-proxy has now failed
-- twice on this project with `read ECONNRESET` — once for 025, again here. The
-- proxy is not the point; getting the columns into the database is. This file
-- is the two migration files concatenated, VERBATIM, plus the two
-- schema_migrations rows the runner would have written, wrapped in ONE
-- transaction.
--
--   Cloud Shell (no proxy, no local Node, no password to paste):
--     gcloud sql connect vyne-sql --user=vyne --database=vyne \
--       --project=vyne-platform-prod
--     \i apply_026_027_manual.sql      -- or just paste the whole file
--
--   or through a working psql:
--     psql "postgres://vyne:$OWNER_PW@127.0.0.1:5433/vyne" -f deploy/apply_026_027_manual.sql
--
-- MUST RUN AS THE OWNER ROLE (`vyne`), not vyne_app: it toggles RLS and alters
-- tables. That is the same role `npm run migrate` uses.
--
-- ── Why ONE transaction ─────────────────────────────────────────────────────
--
-- Both files disable RLS on live tables to backfill and re-enable it at the
-- end. If the session dies in between, those tables are left with tenant
-- isolation OFF — which is far worse than the bug being fixed. BEGIN/COMMIT
-- means a failure anywhere rolls back to a fully-protected state, exactly as
-- the migration runner does it. Do not run these statements piecemeal.
--
-- SAFE TO RE-RUN. Every DDL is IF NOT EXISTS / IF EXISTS, the backfills are
-- idempotent UPDATEs, and the ledger inserts are ON CONFLICT DO NOTHING. If 026
-- already applied, this is a no-op that costs one transaction.
--
-- AFTERWARDS, verify — the ledger saying "applied" is not the same as the
-- backfill having matched anything:
--     \i verify_026_027.sql
-- =============================================================================

BEGIN;

\echo '── applying 026_synthetic_flag_column.sql ──'
-- =============================================================================
-- 026 — syntheticity becomes a COLUMN, and the audit table stops trusting a
--        display name
--
-- v5.33.3, from an external audit that PROVED this against real Postgres.
--
-- WHAT 024 DID. Migration 017 deliberately granted the application no DELETE on
-- interview_transcripts: "an audit record the application can erase is not much
-- of an audit record." 024 needed to delete SYNTHETIC transcripts when a
-- practice engagement is regenerated, so it granted DELETE back and narrowed it
-- with an RLS policy:
--
--     USING (tenant_id = … AND interviewee_name LIKE '%[Synthetic]')
--
-- and asserted, in its own comment, that '[Synthetic]' "is appended by the
-- generator and by nothing else".
--
-- THAT ASSERTION IS FALSE. interviewee_name is caller input — routes/
-- interviews.ts accepts `z.string().min(1).max(200)` and writes it verbatim
-- into the transcript. So any consultant who can create an interview can name
-- an interviewee "Mallory Vance [Synthetic]", and that real interview's
-- transcript becomes deletable through the synthetic-only policy. The audit
-- demonstrated it as the non-owner vyne_app role with RLS forced: two real
-- transcripts in, one gone. It also fires by ACCIDENT on any genuine
-- interviewee whose name happens to end that way.
--
-- The general shape: a security boundary keyed on a DISPLAY STRING. The same
-- shape as the engagement code living in tenant-writable JSON, which 025 fixed
-- the same way — move the fact into a column the application cannot forge.
--
-- WHAT THIS DOES.
--   1. interviews.synthetic and interview_transcripts.synthetic, both
--      NOT NULL DEFAULT false.
--   2. Backfill from state_module, NOT from the name. state_module is
--      server-generated in both paths and never echoes caller input:
--        routes/interviews.ts   'iv_'       || the row's own uuid
--        routes/synthetic.ts    'iv_synth_' || code || role slug || round || seq
--      A caller cannot make a real interview's state_module start with
--      'iv_synth_', so this discriminator cannot be spoofed the way the name
--      could. Rows whose name ends '[Synthetic]' but whose state_module does
--      NOT are exactly the spoofed/accidental rows, and they are backfilled
--      false — i.e. this migration also REPAIRS an already-exploited table.
--   3. The DELETE policy is re-keyed onto the column, and the name test is
--      dropped entirely.
--
-- The application is never granted UPDATE on either table, so it cannot flip
-- `synthetic` on a real row to make it deletable. That is what makes the column
-- a boundary and the name never was.
-- =============================================================================

ALTER TABLE interviews             ADD COLUMN IF NOT EXISTS synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE interview_transcripts  ADD COLUMN IF NOT EXISTS synthetic boolean NOT NULL DEFAULT false;

-- ── RLS OFF for the backfill ────────────────────────────────────────────────
--
-- Same trap as 025, and it is worth restating because it has cost a production
-- run once already: both tables are FORCE ROW LEVEL SECURITY keyed on
-- current_setting('app.tenant_id'). FORCE binds the table OWNER too, so a
-- migration connected as `vyne` with no tenant set reads ZERO rows — silently.
-- The UPDATEs below would match nothing, report success, and leave every
-- synthetic row flagged false, at which point regeneration would quietly stop
-- being able to clean up after itself.
--
-- The runner wraps each file in one transaction. Applying this by hand REQUIRES
-- BEGIN/COMMIT, or a failure below leaves RLS off on two tables.
ALTER TABLE interviews            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE interviews            DISABLE  ROW LEVEL SECURITY;
ALTER TABLE interview_transcripts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE interview_transcripts DISABLE  ROW LEVEL SECURITY;

UPDATE interviews
   SET synthetic = true
 WHERE state_module LIKE 'iv\_synth\_%';

UPDATE interview_transcripts t
   SET synthetic = true
  FROM interviews i
 WHERE i.id = t.interview_id
   AND i.synthetic;

-- What the old policy would have allowed to be deleted, versus what the new one
-- will. A non-zero difference means this table was reachable by the spoof — or
-- that a real interviewee is named unluckily. Either way somebody should see it
-- rather than have it pass in silence.
DO $$
DECLARE by_name int; by_flag int; spoofed int;
BEGIN
  SELECT count(*) INTO by_name FROM interview_transcripts WHERE interviewee_name LIKE '%[Synthetic]';
  SELECT count(*) INTO by_flag FROM interview_transcripts WHERE synthetic;
  SELECT count(*) INTO spoofed FROM interview_transcripts
   WHERE interviewee_name LIKE '%[Synthetic]' AND NOT synthetic;
  RAISE NOTICE '026: % transcripts matched the OLD name rule, % match the new column rule', by_name, by_flag;
  IF spoofed > 0 THEN
    RAISE WARNING '026: % transcript(s) were deletable under 024''s name rule and are NOT synthetic. They are now protected. Review them: SELECT id, interviewee_name FROM interview_transcripts WHERE interviewee_name LIKE ''%%[Synthetic]'' AND NOT synthetic;', spoofed;
  END IF;
END $$;

-- ── RLS back ON ─────────────────────────────────────────────────────────────
ALTER TABLE interview_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_transcripts FORCE  ROW LEVEL SECURITY;
ALTER TABLE interviews            ENABLE ROW LEVEL SECURITY;
ALTER TABLE interviews            FORCE  ROW LEVEL SECURITY;

-- ── The policy, re-keyed off the display name ───────────────────────────────
DROP POLICY IF EXISTS tenant_delete_synthetic_only ON interview_transcripts;

CREATE POLICY tenant_delete_synthetic_only ON interview_transcripts
  FOR DELETE
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND synthetic
  );

-- interviews already permitted DELETE (it is not the audit record); narrowing
-- its cleanup path to the flag as well keeps the two halves of a regeneration
-- from disagreeing about which rows are practice data.
CREATE INDEX IF NOT EXISTS idx_interviews_synthetic
  ON interviews (tenant_id, client_name) WHERE synthetic;

INSERT INTO schema_migrations (filename) VALUES ('026_synthetic_flag_column.sql')
  ON CONFLICT (filename) DO NOTHING;

\echo '── applying 027_engagement_code_reclaim.sql ──'
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

INSERT INTO schema_migrations (filename) VALUES ('027_engagement_code_reclaim.sql')
  ON CONFLICT (filename) DO NOTHING;

-- The runner creates this if absent; a hand-run against a database that somehow
-- lacks it would otherwise fail on the INSERTs above.
COMMIT;

\echo ''
\echo 'DONE. Both migrations applied and recorded in schema_migrations.'
\echo 'Now run verify_026_027.sql — especially CHECK 3, which asks whether the'
\echo 'backfill actually MATCHED anything rather than merely running.'
