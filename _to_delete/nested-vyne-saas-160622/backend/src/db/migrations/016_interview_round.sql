-- =============================================================================
-- 016 — An interview knows which ROUND it belongs to
--
-- v5.32.55. The VYNE diagnostic is meant to be run more than once: an initial
-- read, then a refresh a quarter or two later, and the delta between them is
-- the product. Re-interviewing the same executive is the normal case.
--
-- It was destroying the earlier read. mergeSessionIntoEngagement targets the
-- engagement's CURRENT round, and nothing on the distributed path ever advances
-- currentRoundId — the only two writers are a refresh flag interviewees cannot
-- set, and a Synthesis import path that no longer runs. So a second interview
-- with the same person and role resolved to the SAME round entry as the first
-- and replaced it outright: seven dimension scores and every finding gone, the
-- round's aggregate recomputed from the new numbers, and the "Initial
-- Diagnostic" pill in Synthesis quietly showing this quarter's data.
--
-- Nothing warned, because from the merge's point of view it was doing exactly
-- what the v5.32.25 upsert asked: same person, same role, replace.
--
-- The missing fact is which round an interview is FOR, and only the consultant
-- knows it at invite time — they are the one deciding whether this is a fresh
-- diagnostic or a correction to the current one. So it is recorded on the
-- invite, not inferred later from timing or from names.
--
-- NULL means "whatever round is current", which is exactly today's behaviour —
-- so every existing interview keeps working and a consultant who never touches
-- the field never has to think about it.
-- =============================================================================

ALTER TABLE interviews ADD COLUMN IF NOT EXISTS round_number integer;

-- A round number is a small positive ordinal. The bound is here as well as in
-- the route because a stray value silently creates a phantom round in the
-- engagement record, which is tedious to unpick afterwards.
ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_round_number_range;
ALTER TABLE interviews ADD  CONSTRAINT interviews_round_number_range
  CHECK (round_number IS NULL OR (round_number >= 1 AND round_number <= 50));

-- Answers "what has this client had so far" without scanning every row.
CREATE INDEX IF NOT EXISTS idx_interviews_client_round
  ON interviews (tenant_id, client_name, round_number);
