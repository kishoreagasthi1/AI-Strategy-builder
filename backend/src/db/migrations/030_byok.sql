-- =============================================================================
-- 030 — Bring-your-own-key: a client's Google AI Studio key pays for their own
--       engagement, so a pilot does not run on the firm's bill.
--
-- ── Why the columns are named the way they are ───────────────────────────────
--
-- The design wanted to REFUSE a free-tier key, because free-tier content may be
-- used by Google for product improvement and an interview transcript is the
-- most confidential thing this product handles. That check cannot be built.
--
-- Measured, 2026-09-12, with deploy/byok-probe.mjs against a billed key and an
-- unbilled key created in a fresh project:
--
--                             billed      unbilled
--   generateContent           200         200
--   models.list               200, 55     200, 55
--     live/native-audio       six         the same six
--   auth_tokens               200         200
--   rate-limit headers        none        none
--
-- Identical. Nothing observable at save time separates them. (It also disproved
-- a belief held in this codebase's own comments: Google does NOT refuse a
-- free-tier key at auth_tokens. `live_free_tier_blocked` is our policy,
-- enforced by GEMINI_PAID=1, not an upstream gate.)
--
-- So the tier is an ATTESTATION by the client, and every name here says so.
-- `byok_paid_tier_attested`, never `byok_paid_tier`. `byok_probe` holds the
-- evidence the probe actually collected, not a verdict derived from it. A field
-- name that overstates its evidence is how a checkbox becomes "the system
-- verified it" in someone's memory a year later — and that memory would be
-- load-bearing in a conversation about a client's confidential data.
--
-- The key itself is NOT stored here. Only the Secret Manager resource name is,
-- so a database backup never contains a client credential.
-- =============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS byok_provider            text,
  ADD COLUMN IF NOT EXISTS byok_secret_name         text,
  ADD COLUMN IF NOT EXISTS byok_key_hint            text,
  ADD COLUMN IF NOT EXISTS byok_status              text,
  ADD COLUMN IF NOT EXISTS byok_verified_at         timestamptz,
  ADD COLUMN IF NOT EXISTS byok_probe               jsonb,
  ADD COLUMN IF NOT EXISTS byok_paid_tier_attested  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS byok_attested_by         uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS byok_attested_at         timestamptz,
  ADD COLUMN IF NOT EXISTS byok_attestation_text    text;

-- The attestation is not paperwork that can be skipped by a code path that
-- forgot about it. A BYOK key cannot be ACTIVE unless a named person attested,
-- at a recorded time, to text we kept a copy of.
--
-- Enforced here rather than in the route because there will be more than one
-- way to write this row before long — an admin tool, a migration, a support
-- fix — and each of those is a chance to set the key and skip the record.
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS byok_active_requires_attestation;
ALTER TABLE tenants ADD CONSTRAINT byok_active_requires_attestation CHECK (
  byok_status IS DISTINCT FROM 'active'
  OR (
    byok_paid_tier_attested = true
    AND byok_attested_by IS NOT NULL
    AND byok_attested_at IS NOT NULL
    AND byok_attestation_text IS NOT NULL
    AND byok_secret_name IS NOT NULL
    AND byok_provider IS NOT NULL
  )
);

-- Only statuses we handle. NULL means "this firm does not use BYOK".
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS byok_status_known;
ALTER TABLE tenants ADD CONSTRAINT byok_status_known CHECK (
  byok_status IS NULL OR byok_status IN ('active', 'disabled', 'failed')
);

-- Only providers we can actually route to. Vertex cannot take an API key at
-- all — it authenticates with service-account credentials — so a Vertex BYOK
-- row would be a promise the router cannot keep.
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS byok_provider_known;
ALTER TABLE tenants ADD CONSTRAINT byok_provider_known CHECK (
  byok_provider IS NULL OR byok_provider IN ('gemini-aistudio')
);

-- Every change to a BYOK key is an event someone may have to account for
-- later: who set it, who rotated it, who turned it off, and what the client
-- was shown when they attested. tenants holds only the CURRENT state.
CREATE TABLE IF NOT EXISTS byok_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id     uuid REFERENCES users(id),
  action            text NOT NULL,      -- attached | rotated | disabled | verify_failed
  provider          text,
  key_hint          text,
  paid_tier_attested boolean,
  attestation_text  text,
  probe             jsonb,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_byok_events_tenant
  ON byok_events (tenant_id, created_at DESC);

ALTER TABLE byok_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE byok_events FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON byok_events;
CREATE POLICY tenant_isolation ON byok_events
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON byok_events TO vyne_app;
-- No UPDATE or DELETE: an audit trail that can be edited is not one.
