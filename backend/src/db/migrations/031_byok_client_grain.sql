-- =============================================================================
-- 031 — BYOK moves from the FIRM to the CLIENT, and from one key to one key
--       PER PROVIDER.
--
-- ── Why 030's grain was wrong ────────────────────────────────────────────────
--
-- 030 put the key on `tenants`: one key per consulting firm. That is not how
-- the business works. A firm runs engagements for several clients at once, and
-- it is the CLIENT whose pilot should pay for the client's own interviews. A
-- firm-wide key bills Nestlé's interviews to whoever set the key up.
--
-- A client is not a table in this schema — it is `engagements.client_name`,
-- normalised to `client_norm`, which is already what usage_events attributes
-- cost to and what client_assignments scopes access by. So BYOK keys on
-- (tenant_id, client_norm), the same grain billing already uses.
--
-- ── Why PER PROVIDER, which 030 did not anticipate ───────────────────────────
--
-- A client can reasonably say "Gemini for the voice interviews, Claude for the
-- strategy deck". Those are different vendors with different credentials: a
-- Google AI Studio key cannot pay for Claude. So "does this client bring their
-- own key" is not one question — it is one question per provider, and the
-- answer can be yes for one and no for another.
--
-- The unanswered half then falls back to the platform's own credential and
-- onto the client's INVOICE, which usage_events already supports: every row
-- carries client_norm and cost_est_usd, and /api/billing/statement already
-- totals per client. That matters because the realistic case is a client who
-- will never open a Google Cloud account — BYOK is for the enterprise that
-- insists its data runs on its own tenancy, and cost recovery is for everyone
-- else.
--
-- ── The 030 columns are DROPPED, not deprecated ──────────────────────────────
--
-- Nothing has ever written them: 030 shipped the schema and two modules, and
-- no code path sets them. Leaving a constrained, unused set of columns on
-- `tenants` would be a trap for whoever reads the schema next and reasonably
-- assumes firm-level BYOK exists. Verified before dropping — a grep for
-- "byok_" across backend/src returns only a doc comment.
-- =============================================================================

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS byok_active_requires_attestation;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS byok_status_known;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS byok_provider_known;

ALTER TABLE tenants
  DROP COLUMN IF EXISTS byok_provider,
  DROP COLUMN IF EXISTS byok_secret_name,
  DROP COLUMN IF EXISTS byok_key_hint,
  DROP COLUMN IF EXISTS byok_status,
  DROP COLUMN IF EXISTS byok_verified_at,
  DROP COLUMN IF EXISTS byok_probe,
  DROP COLUMN IF EXISTS byok_paid_tier_attested,
  DROP COLUMN IF EXISTS byok_attested_by,
  DROP COLUMN IF EXISTS byok_attested_at,
  DROP COLUMN IF EXISTS byok_attestation_text;

-- One row per (firm, client, provider). The KEY ITSELF IS NOT HERE — only the
-- Secret Manager resource name — so a database backup never carries a client
-- credential.
CREATE TABLE IF NOT EXISTS byok_keys (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_norm          text NOT NULL,
  client_name          text NOT NULL,
  provider             text NOT NULL,
  secret_name          text,
  key_hint             text,
  status               text NOT NULL DEFAULT 'pending',
  probe                jsonb,
  verified_at          timestamptz,
  -- The tier is ATTESTED, never verified: a billed key and an unbilled key are
  -- indistinguishable at save time (measured 2026-09-12, deploy/byok-probe.mjs).
  paid_tier_attested   boolean NOT NULL DEFAULT false,
  attested_by_email    text,
  attested_by_user_id  uuid REFERENCES users(id),
  attested_at          timestamptz,
  attestation_text     text,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- One key per client per provider. A second one is a rotation, not a new row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_byok_client_provider
  ON byok_keys (tenant_id, client_norm, provider);

CREATE INDEX IF NOT EXISTS idx_byok_keys_tenant ON byok_keys (tenant_id, status);

-- Same guarantee as 030, at the new grain: a key cannot be ACTIVE without a
-- named attester, a time, and a copy of the text they agreed to.
--
-- attested_by_email rather than only a user id, because the person who can
-- honestly attest that a key is billed is the CLIENT's administrator, and they
-- are not a user of this application. An Owner attesting on the client's behalf
-- is the paperwork theatre this constraint exists to prevent — so the email is
-- recorded, and it should be the client's, not the consultant's.
ALTER TABLE byok_keys DROP CONSTRAINT IF EXISTS byok_key_active_requires_attestation;
ALTER TABLE byok_keys ADD CONSTRAINT byok_key_active_requires_attestation CHECK (
  status IS DISTINCT FROM 'active'
  OR (
    paid_tier_attested = true
    AND attested_by_email IS NOT NULL
    AND attested_at IS NOT NULL
    AND attestation_text IS NOT NULL
    AND secret_name IS NOT NULL
  )
);

ALTER TABLE byok_keys DROP CONSTRAINT IF EXISTS byok_key_status_known;
ALTER TABLE byok_keys ADD CONSTRAINT byok_key_status_known CHECK (
  status IN ('pending', 'active', 'disabled', 'failed')
);

-- Providers a credential can actually be supplied for.
--
-- gemini-vertex and anthropic-vertex are absent on purpose: Vertex
-- authenticates with service-account credentials, not an API key, so a Vertex
-- row would be a promise the router cannot keep. anthropic-api is here because
-- a client asking for Claude on their own account supplies an Anthropic key,
-- which is a different vendor and a different credential from their Google one.
ALTER TABLE byok_keys DROP CONSTRAINT IF EXISTS byok_key_provider_known;
ALTER TABLE byok_keys ADD CONSTRAINT byok_key_provider_known CHECK (
  provider IN ('gemini-aistudio', 'anthropic-api')
);

ALTER TABLE byok_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE byok_keys FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON byok_keys;
CREATE POLICY tenant_isolation ON byok_keys
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON byok_keys TO vyne_app;

-- byok_events gains the client it refers to. Existing rows have none, which is
-- correct: none exist.
ALTER TABLE byok_events ADD COLUMN IF NOT EXISTS client_norm text;
ALTER TABLE byok_events ADD COLUMN IF NOT EXISTS client_name text;

-- =============================================================================
-- The one-time link a client uses to supply their own key.
--
-- The key must never travel by email. A key pasted into a message lands in two
-- inboxes, a mail server, someone's phone and possibly a CRM — and it is the
-- CLIENT's credential, not the consultant's to route. So the Owner sends a
-- link, the client's administrator opens it and pastes the key into a form
-- that posts straight to the backend, and the Owner never sees the value.
--
-- Only a HASH of the token is stored. A database reader cannot mint a working
-- link, which is the same reason password hashes exist.
-- =============================================================================
CREATE TABLE IF NOT EXISTS byok_invites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_norm   text NOT NULL,
  client_name   text NOT NULL,
  provider      text NOT NULL,
  token_hash    text NOT NULL,
  created_by    uuid REFERENCES users(id),
  sent_to_email text,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_byok_invite_token ON byok_invites (token_hash);
CREATE INDEX IF NOT EXISTS idx_byok_invites_tenant
  ON byok_invites (tenant_id, client_norm, created_at DESC);

ALTER TABLE byok_invites DROP CONSTRAINT IF EXISTS byok_invite_provider_known;
ALTER TABLE byok_invites ADD CONSTRAINT byok_invite_provider_known CHECK (
  provider IN ('gemini-aistudio', 'anthropic-api')
);

-- NOT row-level-security scoped on purpose, and this is the one deliberate
-- exception in the schema.
--
-- The client's administrator is not a user of this application and has no
-- tenant context — the whole point of the link is that they need no account.
-- The route that redeems a token therefore looks it up before any tenant is
-- known, and RLS would make that lookup return nothing.
--
-- What protects it instead: the token is a high-entropy secret, only its hash
-- is stored, it expires, and it is single-use (used_at). The redeeming route
-- must set app.tenant_id from the ROW it found and do nothing else with the
-- token. Access is withheld from vyne_app except the two operations that flow
-- needs.
GRANT SELECT, INSERT, UPDATE ON byok_invites TO vyne_app;
