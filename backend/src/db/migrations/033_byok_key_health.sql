-- =============================================================================
-- 033 — "active" must mean "it worked", and a setup link must be revocable.
--
-- ── Part 1: what `active` was allowed to mean ────────────────────────────────
--
-- Measured on production, 2026-09-13. The service account's Secret Manager
-- permissions were narrowed, and one permission was missed. For several
-- minutes:
--
--   · the keys screen said ACTIVE;
--   · every call for that client silently ran on the FIRM's credentials;
--   · the only trace was a Cloud Run log line nobody watches.
--
-- Nothing was broken in a way anyone could see. The output was correct, the
-- page was correct, and the cost quietly moved back onto the firm — which is
-- the exact outcome BYOK exists to prevent, presented as success.
--
-- The cause is a deliberate design choice that stays: llm/byok/secretStore.ts
-- treats a 403 or 404 from Secret Manager as "no key on file", so an
-- unreadable key falls back rather than failing an interview mid-sentence.
-- That is right. What was wrong is that the FALLBACK WAS INVISIBLE.
--
-- So `status` keeps meaning "a key was supplied and attested" — an
-- administrative fact — and these columns carry the operational one: did the
-- last attempt to actually USE it succeed. The screen can then say "active,
-- but we could not read this key 3 minutes ago", which is the sentence that
-- would have saved tonight.
--
-- Deliberately NOT flipping status to 'failed' on a read error: Secret Manager
-- being briefly unreachable is not a client's key going bad, and demoting a
-- good key over a blip would move a client's costs onto the firm for real.
-- Only the VENDOR refusing the credential does that (see routes/byok.ts and
-- LlmGateway.onByokRejected), which is a different, durable signal.
--
-- ── Part 2: an invite that cannot be called back ─────────────────────────────
--
-- byok_invites has no revocation. A link sent to the wrong address, or to
-- someone who has since left the client, stays live for 72 hours and there is
-- no way to withdraw it. The token is high-entropy and single-use, so the
-- practical risk is small — but "wait three days" is not an answer to "I sent
-- that to the wrong person", and it is one column.
--
-- revoked_at rather than deleting the row: who cancelled what, and when, is
-- exactly the kind of thing an audit asks about a credential-handling flow.
-- =============================================================================

-- Part 1 — key health.
ALTER TABLE byok_keys ADD COLUMN IF NOT EXISTS last_error      text;
ALTER TABLE byok_keys ADD COLUMN IF NOT EXISTS last_error_at   timestamptz;

-- Part 2 — revocable invites.
ALTER TABLE byok_invites ADD COLUMN IF NOT EXISTS revoked_at     timestamptz;
ALTER TABLE byok_invites ADD COLUMN IF NOT EXISTS revoked_by     uuid REFERENCES users(id);

-- The consultant's screen lists invites still worth showing: not used, not
-- revoked, not expired. Partial, because the rows it excludes are the ones
-- that accumulate.
CREATE INDEX IF NOT EXISTS idx_byok_invites_open
  ON byok_invites (tenant_id, expires_at DESC)
  WHERE used_at IS NULL AND revoked_at IS NULL;
