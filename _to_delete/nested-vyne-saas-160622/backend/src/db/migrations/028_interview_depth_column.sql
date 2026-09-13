-- =============================================================================
-- 028 — Interview DEPTH lives on the INTERVIEW, not on the consultant's screen
--
-- v5.33.8. Exactly the defect 014 fixed for interviewer name and voice, in the
-- one remaining field that has it. Depth — the question budget the agent works
-- to, and therefore how long an executive is in the chair — was chosen on
-- interview_agent.html's setup screen and stored nowhere at all.
--
-- Two consequences, established by driving both sides in a real browser rather
-- than by reading the code:
--
--   1. The setup screen is hidden outright for interviewees (see the
--      DOMContentLoaded block in interview_agent.html), so an invited executive
--      never sees the control.
--   2. The consultant's choice persisted to no key, no column and no field on
--      the invite. Probed directly: a consultant selecting "Quick Screen" wrote
--      `depth` into zero workspace keys, and the interviewee's session still
--      reported S.depth === 'deep', budget 50.
--
-- So every distributed interview ran as a 40–50 question Deep Dive whatever the
-- consultant intended, and the preview sheet's estimate of how long it would
-- take could be wrong by an hour — always long.
--
-- WHY NOT NULL DEFAULT 'deep', where 014 chose nullable
--
-- 014's fields have a meaningful "unset" — NULL means "firm default voice", and
-- a consultant must be able to get back to it. Depth has no such state: an
-- interview always runs to some budget, and today that budget is always deep.
-- Backfilling every existing row to 'deep' therefore changes nothing for
-- anybody — it writes down what was already happening. The consultant now picks
-- it per invite, and 'deep' stays the default they get if they do not.
--
-- The CHECK is the same belt-and-braces as 014's length bounds: the route
-- validates the enum, and the column refuses anything else regardless.
-- =============================================================================

ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS depth text NOT NULL DEFAULT 'deep';

ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_depth_valid;
ALTER TABLE interviews ADD  CONSTRAINT interviews_depth_valid
  CHECK (depth IN ('quick', 'standard', 'deep'));

COMMENT ON COLUMN interviews.depth IS
  'Question budget the agent works to: quick ~25, standard ~35, deep ~50. For '
  'follow-up interviews it scales the agenda-derived budget instead — see '
  'computeRefreshQuestionBudget in frontend/interview_agent.html. Chosen by the '
  'consultant on the invite; defaults to deep, which is what every interview '
  'ran as before this column existed.';
