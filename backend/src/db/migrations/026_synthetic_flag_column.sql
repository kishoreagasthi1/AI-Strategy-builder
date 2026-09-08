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
