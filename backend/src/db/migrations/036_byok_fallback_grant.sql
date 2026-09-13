-- =============================================================================
-- 036 — a client's key failing must not silently become the firm's bill.
--
-- ── The behaviour this ends ──────────────────────────────────────────────────
--
-- Through v5.34.63 a client who supplied their own key ran on it until it
-- stopped working, and then — with no announcement, no approval and no visible
-- event — the SAME work carried on down the chain to the firm's credential.
-- gateway.ts said so in as many words:
--
--     "The request itself carries on down the chain to the platform credential
--      — a lapsed client key must never be the reason an interview stops."
--
-- That sentence weighs one risk (an interview stopping) and ignores the other
-- (a consultancy absorbing a client's inference costs without deciding to). A
-- revoked key, a project that lost API access, a billing account that lapsed:
-- all of them read as "everything is fine" from the consultant's side while the
-- cost quietly moves back onto the firm. The screen turned the key red — after
-- the work had already run on the firm's account.
--
-- ── The rule from v5.34.64 ───────────────────────────────────────────────────
--
-- A client with an active key on file runs ONLY on their own credentials. If
-- that credential is refused, the call FAILS, with an error that names the
-- client and the reason. The firm's key is not reachable for that client at
-- all — not as a fallback, not for a vendor the client did not key, not for a
-- model they expressed a preference for.
--
-- A row in this table is the firm explicitly deciding otherwise for one client:
-- "if their key fails, use ours." It is off for every client until someone
-- turns it on, it names who turned it on, and it can be withdrawn.
--
-- ── The case that was weighed against this, and lost ─────────────────────────
--
-- A live voice interview cannot be retried. If a key lapses mid-session with
-- the client's executive in the room, a hard stop ends the interview in front
-- of them, and the cost of that is plainly larger than $2 of audio. The
-- argument for letting live audio fall back automatically is real.
--
-- It was rejected because it makes the expensive path the automatic one. Live
-- audio is where the money is — roughly $2 for a 90-minute interview against
-- cents for a deck — so "fall back silently, but only for the costly thing"
-- inverts the protection. A firm that wants continuity for a client can say so
-- here in advance, per client, which is the same decision made deliberately
-- instead of by default.
--
-- ── Grain ───────────────────────────────────────────────────────────────────
--
-- (tenant, client_norm), matching byok_keys, client_routing and usage_events.
-- Presence of a row means granted; withdrawal DELETEs it, so there is no
-- "granted = false" state to misread. revoked history lives in audit_log.
-- =============================================================================

CREATE TABLE IF NOT EXISTS byok_fallback_grant (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_norm  text NOT NULL,
  client_name  text NOT NULL,
  -- Why the firm agreed to carry this client's failures. Free text, shown on
  -- the keys screen beside the grant so the reason outlives the person.
  reason       text,
  granted_by   uuid REFERENCES users(id),
  granted_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_byok_fallback_grant
  ON byok_fallback_grant (tenant_id, client_norm);

ALTER TABLE byok_fallback_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE byok_fallback_grant FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON byok_fallback_grant;
CREATE POLICY tenant_isolation ON byok_fallback_grant
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON byok_fallback_grant TO vyne_app;

-- ── The routing preference is now bounded by the keys on file ────────────────
--
-- v5.34.63 let a client state a vendor preference that reordered the firm's
-- chain. Combined with BYOK it had a consequence nobody chose: a client holding
-- a GOOGLE key who preferred Anthropic moved every document, deck and synthesis
-- onto the firm's Anthropic account, because the preference reordered the chain
-- before the client's credential was interleaved into it. The panel said, in
-- those words, that a preference "never changes who pays". For that one
-- combination it was false.
--
-- The chain is confined to the client's own credentials from v5.34.64, so a
-- preference for an unkeyed vendor can no longer move the money. This column
-- records the check at the point it is made, so a preference saved before the
-- confinement existed is visible as one that predates the rule.
ALTER TABLE client_routing
  ADD COLUMN IF NOT EXISTS checked_against_keys boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN client_routing.checked_against_keys IS
  'v5.34.64: true when this preference was validated against the client''s keys on file at save time. False on rows written before the rule existed.';
