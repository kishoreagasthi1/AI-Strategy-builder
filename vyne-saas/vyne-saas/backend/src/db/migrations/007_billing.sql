-- =============================================================================
-- 007 — Client cost-recovery billing
--
-- usage_events already records every LLM/TTS/transcription call's real cost
-- (metering.ts's doc comment: "these rows are the raw material for billing
-- later") but had no notion of WHICH of the firm's own clients (Acme
-- Industrial, etc.) a call was for — only which tenant (firm) and module.
-- A firm wanting to pass AI cost through on their own client invoice had no
-- way to split the total.
--
-- client_name/client_norm mirror every other client-scoped table's
-- convention (see auth/clients.ts's normClient()): nullable, because not
-- every call is attributable to one client (a consultant doing cross-client
-- admin work, or a call made before a client was selected) — those rows
-- stay in an honest "unattributed" bucket rather than being guessed at.
-- =============================================================================

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS client_norm text;

CREATE INDEX IF NOT EXISTS idx_usage_events_client
  ON usage_events(tenant_id, client_norm, created_at);
