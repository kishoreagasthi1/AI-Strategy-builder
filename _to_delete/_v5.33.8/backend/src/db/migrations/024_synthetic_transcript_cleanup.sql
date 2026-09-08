-- =============================================================================
-- 024 — let the synthetic generator clean up its OWN transcripts, and only
--       its own
--
-- v5.32.83. Two things in this repo contradicted each other, and both looked
-- correct on their own.
--
-- Migration 017 ends:
--
--     -- No DELETE grant. An audit record that the application can erase is not
--     -- much of an audit record; removal is an operator action [...]
--     GRANT SELECT, INSERT ON interview_transcripts TO vyne_app;
--
-- That reasoning is right and this migration does not weaken it.
--
-- Meanwhile routes/synthetic.ts, in the regeneration path, runs:
--
--     DELETE FROM interview_transcripts WHERE interview_id = ANY($1::uuid[])
--
-- with a comment explaining that transcripts must go FIRST because 017
-- deliberately declines to add a foreign key. Sound reasoning, and the
-- statement cannot execute: vyne_app has no DELETE on that table. So
-- regenerating synthetic data for a client that already had some has always
-- failed with `permission denied for table interview_transcripts` — a 500,
-- after the interviews were already deleted inside the same transaction, so
-- the whole thing rolls back and the consultant sees an unexplained error.
--
-- It survived because nothing ever generated twice for the same client name.
-- test/synthetic.test.ts uses a fresh client per case — TestCo Industrial,
-- Followup Testco, RoleCo — so "regeneration replaces the previous synthetic
-- set" was a property the code asserted in a comment, the tests reported as
-- held, and no execution had ever reached.
--
-- The fix is not to hand vyne_app a blanket DELETE — that would trade a broken
-- generator for a weaker audit record. Instead the tenant_isolation policy is
-- split per command, and DELETE is permitted ONLY for rows whose interviewee
-- carries the '[Synthetic]' marker the generator itself writes. Real
-- transcripts stay exactly as undeletable by the application as 017 intended;
-- fixtures the product generated become the product's to clean up.
--
-- SELECT and INSERT are unchanged in effect: the two policies below reproduce
-- the FOR ALL policy they replace. There is still no UPDATE grant and no
-- UPDATE policy, so a transcript remains unmodifiable in place.
-- =============================================================================

GRANT DELETE ON interview_transcripts TO vyne_app;

DROP POLICY IF EXISTS tenant_isolation ON interview_transcripts;

CREATE POLICY tenant_read ON interview_transcripts
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_write ON interview_transcripts
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The narrow one. Tenant isolation as before, AND the row must be synthetic.
-- '[Synthetic]' is appended by the generator (routes/synthetic.ts) and by
-- nothing else; a real interviewee's name reaches this table from the
-- interview record, never with that suffix.
CREATE POLICY tenant_delete_synthetic_only ON interview_transcripts
  FOR DELETE
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND interviewee_name LIKE '%[Synthetic]'
  );
