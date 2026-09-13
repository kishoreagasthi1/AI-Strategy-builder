-- =============================================================================
-- 022 — module_state.version becomes unforgettable
--
-- v5.32.65 (audit V2-M2). Migration 018 added `version` so a client could write
-- conditionally: send the version you read, and the UPDATE only lands if nobody
-- has changed the row since. PUT /api/module-state implements exactly that, and
-- bumps the counter itself.
--
-- It was the only writer that did. Six others reach the same table and none of
-- them touched `version`:
--
--   routes/solutionDesign.ts   writeStore
--   routes/assignments.ts      the workspace-write loop
--   routes/synthetic.ts        upsert
--   routes/moduleState.ts      migrateNorms (the client-norm widening)
--   routes/interviews.ts       interviewee state PUT
--   routes/interviews.ts       the completion merge's engagement upsert
--
-- So a consultant's browser could read a key at version 4, the Design Studio or
-- a completing interview could rewrite that key underneath it, and the browser's
-- next conditional write would still match on version 4 and be accepted. The
-- guard did not fail loudly; it silently stopped guarding, which is the worse
-- of the two failure modes and the reason this is a database change rather than
-- six edits. The seventh writer would have forgotten too.
--
-- The trigger derives `version` from OLD, so no statement can set it to
-- anything else — including the conditional PUT's own `version + 1`, which now
-- computes the same number the trigger would and is therefore harmless. The
-- WHERE clause that implements the conditional write is evaluated against OLD
-- before the trigger runs, so optimistic concurrency is unaffected.
--
-- A no-op rewrite (same value) deliberately does NOT bump: saving a document
-- twice with no edits should not invalidate a colleague's read token.
-- =============================================================================

CREATE OR REPLACE FUNCTION module_state_bump_version() RETURNS trigger AS $$
BEGIN
  IF NEW.value IS DISTINCT FROM OLD.value THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_module_state_version ON module_state;
CREATE TRIGGER trg_module_state_version
  BEFORE UPDATE ON module_state
  FOR EACH ROW EXECUTE FUNCTION module_state_bump_version();
