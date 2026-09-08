-- =============================================================================
-- 014 — Interviewer identity lives on the INTERVIEW, not in a browser
--
-- v5.32.47. The realtime interviewer's name and voice were being chosen on the
-- Interview Agent's own setup screen and stashed in workspace state. Two things
-- were wrong with that, one cosmetic and one fatal:
--
--   1. The wrong person was choosing. The interviewer is the consultant's
--      instrument — its name and its tone are part of how the firm presents
--      itself to the client. Leaving that to whoever opens the page meant an
--      interviewee could rename the consultant's interviewer.
--
--   2. It could not possibly work. Workspace state is CONSULTANT state;
--      interviewees are locked out of it by design (see the bootstrap route and
--      003's isolation model). So a consultant who picked a male voice wrote it
--      to a namespace the interviewee's browser can never read, and every
--      distributed interview ran on the API default regardless.
--
-- Putting both fields on the interviews row fixes the second by construction:
-- the interviewee's bootstrap already returns their interview record, so the
-- consultant's choice travels with the invite.
--
-- Nullable on purpose. NULL means "firm default" — existing interviews keep
-- behaving exactly as they do today, and a consultant who never touches these
-- fields never has to.
-- =============================================================================

ALTER TABLE interviews ADD COLUMN IF NOT EXISTS interviewer_name  text;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS interviewer_voice text;

-- Names are spoken aloud by the model and shown in the transcript, so a long
-- one is a UX problem rather than a storage one — but the ceiling belongs in
-- the schema too, so a route that forgets to bound it cannot write a novel.
ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_interviewer_name_len;
ALTER TABLE interviews ADD  CONSTRAINT interviews_interviewer_name_len
  CHECK (interviewer_name IS NULL OR char_length(interviewer_name) <= 40);

-- The voice is an identifier from a fixed vendor allowlist (see
-- llm/liveSession.ts VOICES). It is validated in the route against that list;
-- this bound is only here so a bad write cannot be unbounded.
ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_interviewer_voice_len;
ALTER TABLE interviews ADD  CONSTRAINT interviews_interviewer_voice_len
  CHECK (interviewer_voice IS NULL OR char_length(interviewer_voice) <= 40);
