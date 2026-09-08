-- =============================================================================
-- 017 — Interview transcripts as a first-class, auditable record
--
-- v5.32.58. "Can we prove what was actually said?" is the question a client
-- asks when a finding is challenged, and until now the honest answer was
-- "sort of". The transcript existed only as `displayMessages` inside a JSON
-- session blob in the interview's private module_state namespace — retrievable
-- through the tracker's Session button as a file download, but not a record:
-- not queryable, not listed, and deleted along with everything else the moment
-- the interview row was removed.
--
-- The engagement record — which is what Synthesis, the scorecard and the client
-- document all read — carries scores and findings and NO transcript at all. So
-- the evidence behind a number in a board deck was one step further away than
-- anyone assumed.
--
-- Why a table rather than a field on the engagement record: that record is
-- already a single unbounded jsonb value rewritten in full on every interview
-- completion. Adding full transcripts to it would multiply its size by an order
-- of magnitude and make every workspace hydration carry them. A transcript is
-- read rarely and deliberately — when someone is checking something — which is
-- exactly the access pattern a separate table serves well.
--
-- The interview row is deliberately NOT a foreign key with ON DELETE CASCADE.
-- Deleting an interview should not silently destroy the audit trail of a
-- conversation that actually happened; the transcript keeps the client, the
-- person and the round it belonged to, so it stands on its own.
-- =============================================================================

CREATE TABLE IF NOT EXISTS interview_transcripts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- No FK: the transcript outlives the interview row on purpose (see above).
  interview_id      uuid,
  client_name       text NOT NULL,
  interviewee_name  text NOT NULL,
  interviewee_role  text NOT NULL,
  round_number      integer,
  -- [{who:'You'|'VYNE', text, at}] — the conversation as it was displayed,
  -- which for the realtime path is the transcription of what was spoken.
  turns             jsonb NOT NULL DEFAULT '[]'::jsonb,
  turn_count        integer NOT NULL DEFAULT 0,
  -- Whether this came from the speech-native path or the text one. A reviewer
  -- reading a flat exchange should know which they are looking at.
  mode              text NOT NULL DEFAULT 'text',
  captured_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transcripts_tenant_time
  ON interview_transcripts (tenant_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcripts_interview
  ON interview_transcripts (tenant_id, interview_id);

ALTER TABLE interview_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_transcripts FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON interview_transcripts;
CREATE POLICY tenant_isolation ON interview_transcripts
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- No DELETE grant. An audit record that the application can erase is not much
-- of an audit record; removal is an operator action, taken deliberately, in
-- response to a retention policy or a data-subject request.
GRANT SELECT, INSERT ON interview_transcripts TO vyne_app;
