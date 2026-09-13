-- =============================================================================
-- 018 — Optimistic concurrency for module_state
--
-- v5.32.58. PUT /api/module-state/:module was an unconditional
--   ON CONFLICT (tenant_id, module, key) DO UPDATE SET value = EXCLUDED.value
-- with no precondition of any kind, and the browser hydrates its cache ONCE at
-- page load and never refreshes it. Every module then does read-modify-write on
-- whole JSON blobs from that snapshot.
--
-- So: two consultants open Synthesis for the same client at 09:00. A edits the
-- dimension notes at 09:02. B edits a different round and flushes at 09:05,
-- writing the whole engagement blob from B's 09:00 snapshot. A's work is gone,
-- the server returns 200, and A's screen keeps showing their own version until
-- they reload. Nobody is told anything.
--
-- Worse, POST /api/interviews/mine/complete writes the SAME key server-side, so
-- a consultant's routine flush can erase a just-completed interview's merged
-- scores and findings — and the reverse.
--
-- A version column turns that silent overwrite into a detectable conflict. The
-- write becomes "update if you are still on the version you read", and a loser
-- gets 409 WITH the current value so the client can re-hydrate and re-apply
-- rather than guess.
--
-- Version rather than updated_at on purpose: timestamps collide at the
-- resolution real conflicts happen in, and clock skew between an app instance
-- and the database makes "newer" a question nobody should have to answer.
-- =============================================================================

ALTER TABLE module_state ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;

-- Existing rows all start at version 1, which is correct: any client holding a
-- pre-upgrade snapshot has no version to send, and the route treats an absent
-- expected version as "no opinion" so nothing breaks mid-session. The guarantee
-- arrives for clients that DO send one, and becomes universal once every open
-- tab has reloaded.
COMMENT ON COLUMN module_state.version IS
  'Optimistic-concurrency token. Incremented on every write; a client that sends '
  'an expectedVersion different from this one is rejected with 409 and the '
  'current value, rather than silently overwriting a colleague''s work.';
