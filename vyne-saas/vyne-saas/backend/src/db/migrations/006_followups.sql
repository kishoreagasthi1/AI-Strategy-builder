-- =============================================================================
-- 006 — Follow-up interviews (post-synthesis, distributed)
--
-- A follow-up is a SECOND interview row for the SAME interviewee_user_id
-- (their login already exists — no re-invite), tagged kind='follow_up' with
-- parent_interview_id pointing at the interview it follows.
--
-- Critical design constraint (see NEXT_SESSION_SPEC.md): follow-up agendas
-- are derived from OTHER interviewees' answers, so nothing may reach a
-- client member that exposes a colleague's specific statements. Two
-- safeguards, both enforced here and in routes/interviews.ts:
--   1. Agenda items are drafted function-level (conditions, never "X said").
--   2. A consultant must REVIEW AND APPROVE the agenda (agenda_status:
--      'draft' -> 'approved') before the interviewee's bootstrap ever
--      includes it. No approval -> the follow-up interview is invisible to
--      them (GET /api/interviews/mine/bootstrap keeps returning their most
--      recent interview only once it's approved).
-- =============================================================================

ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'initial',
  ADD COLUMN IF NOT EXISTS parent_interview_id uuid REFERENCES interviews(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agenda jsonb,
  ADD COLUMN IF NOT EXISTS agenda_status text NOT NULL DEFAULT 'none';

-- kind: 'initial' | 'follow_up'
-- agenda_status: 'none' (initial interviews) | 'draft' | 'approved'
-- agenda: jsonb array of { dimension, text } items, consultant-approved,
--         phrased function-level (no interviewee attribution).

CREATE INDEX IF NOT EXISTS idx_interviews_parent ON interviews(parent_interview_id);
