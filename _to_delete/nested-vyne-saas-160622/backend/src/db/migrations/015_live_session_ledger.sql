-- =============================================================================
-- 015 — Make a live-session hold releasable exactly once, by its owner
--
-- v5.32.54 SECURITY (CRITICAL). POST /api/voice/live-session/close took
-- `sessionId`, `maxSeconds`, `tokensIn` and `tokensOut` from the REQUEST BODY
-- and passed them to reconcileSession, which unconditionally wrote a
-- compensating NEGATIVE usage row of -maxSeconds*25 tokens in each direction.
--
-- Nothing checked that a matching hold existed, that it belonged to the caller,
-- or that it had not already been released. `sessionId` was never used in a
-- query at all — usage_events had no column to put it in. So the least
-- privileged role in the product could call close in a loop, having never
-- opened a session, and drive the tenant's `used` total arbitrarily negative:
--
--   {"sessionId":"anything","maxSeconds":2700,"tokensIn":0,"tokensOut":0,"seconds":0}
--     → usage_events row: tokens_in -67500, tokens_out -67500
--     → at the 60/min route limit, roughly -8.1M tokens per minute
--
-- Both spend caps (llm/metering.ts) and the concurrent-session guard
-- (routes/voice.ts countRecentGrants) read sums and counts over this table, so
-- that single unauthenticated arithmetic primitive disabled the monthly tenant
-- cap, the per-user daily cap, and the concurrency limit — for every user in
-- the firm, on every metered path. It was invisible on invoices, because
-- billing correctly excludes the non-billable hold tasks.
--
-- The fix needs the ledger to be able to answer two questions it could not:
-- "which session is this row about" and "has this hold already been released".
-- Hence a session_id column, and a partial unique index that makes a second
-- release for the same session physically impossible rather than merely
-- unlikely — a check-then-insert would still lose to two concurrent requests.
-- =============================================================================

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS session_id text;

-- Find a session's rows without scanning the table. Partial, because the vast
-- majority of usage_events (every text generation, every TTS call) have no
-- session and should not be carried in this index.
CREATE INDEX IF NOT EXISTS idx_usage_session
  ON usage_events (tenant_id, session_id)
  WHERE session_id IS NOT NULL;

-- One release per session, enforced by the database.
--
-- Deliberately scoped to the release task only. Holds are already one-per-mint
-- and the ACTUAL usage row is written once per close alongside the release, so
-- constraining the release alone is sufficient to make the compensating entry
-- idempotent — which is the property the exploit depended on lacking.
CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_one_release_per_session
  ON usage_events (tenant_id, session_id)
  WHERE session_id IS NOT NULL AND task = 'live_session_hold_release';
