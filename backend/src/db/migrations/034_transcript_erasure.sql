-- =============================================================================
-- 034 — deleting an interview deletes its transcript, and nothing else can.
--
-- ── The state this leaves behind today ───────────────────────────────────────
--
-- DELETE /api/interviews/:id removes the interview row and its module_state
-- namespace. interview_transcripts keeps the actual CONVERSATION — a named
-- executive at a named client, their verbatim answers, the findings drawn from
-- them — and there is no code path anywhere in the product that can remove it.
--
-- So "delete this interview" does not delete the interview, and a firm asked to
-- honour an erasure request has no way to honour it. That is the gap.
--
-- ── Why the fix is NOT to loosen 024 ─────────────────────────────────────────
--
-- Migration 024 restricted DELETE on this table to synthetic rows (by the
-- '[Synthetic]' name suffix then; by the `synthetic` boolean since 026 — check
-- pg_policies, not 024's prose, if you need the current predicate).
-- That was not an oversight to undo: the synthetic generator wipes and
-- regenerates a client's fixtures, and a blanket DELETE grant would let a
-- regeneration destroy real interview records as a side effect. The protection
-- worth keeping is "no ordinary code path can delete a real transcript", and
-- that stays exactly as it is.
--
-- What is added is one DELIBERATE path, and it has to announce itself:
--
--   SET LOCAL app.erase_transcripts = 'on';
--
-- inside the transaction that does the deleting. A statement that has not said
-- that still cannot touch a real transcript — so the generator, a future
-- careless cascade, and anything written by someone who has not read this file
-- all fail exactly as they do now. SET LOCAL ends with the transaction, so the
-- permission cannot leak to the next statement on a pooled connection.
--
-- This is a control, not a ceremony: it converts "the application cannot delete
-- transcripts" into "the application cannot delete transcripts ACCIDENTALLY",
-- which is the property that was actually wanted.
--
-- ── What is deliberately not done ────────────────────────────────────────────
--
-- No soft delete, no redaction-in-place. An erasure request means the words are
-- gone; a row retaining turn_count and a blanked transcript is a different
-- promise from the one "erased" makes. The audit_log entry the route writes is
-- what survives: who erased what, for which client, and when — a record OF the
-- erasure that contains none of the erased content.
-- =============================================================================

DROP POLICY IF EXISTS tenant_delete_erasure ON interview_transcripts;
CREATE POLICY tenant_delete_erasure ON interview_transcripts
  FOR DELETE
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND current_setting('app.erase_transcripts', true) = 'on'
  );

-- 024's synthetic-only policy stays. Postgres ORs permissive policies, so a row
-- is deletable if it is synthetic (the generator's own cleanup) OR the
-- transaction has explicitly asked for erasure. Both remain tenant-scoped.
