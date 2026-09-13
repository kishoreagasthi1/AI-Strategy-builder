-- =============================================================================
-- 035 — a client may state a model preference, inside the firm's policy.
--
-- ── The question this answers ────────────────────────────────────────────────
--
-- "What if the client says I want Gemini for voice and Claude for other things
-- like PPT and text generation?" — asked at the start of the BYOK work and left
-- unanswered through five releases, because until v5.34.59 a client's key was
-- not spent at all and the question was hypothetical.
--
-- ── What a preference can and cannot do ──────────────────────────────────────
--
-- It REORDERS the vendors already in the firm's chain for a task. It cannot add
-- one the firm has excluded, and it cannot remove the fallback.
--
-- The alternative — a client's preference overriding routing outright — was
-- considered and rejected: the firm's policy is what keeps a deliverable's
-- quality the firm's responsibility, and a client should not be able to move
-- their strategy deck onto a model the firm has deliberately not qualified. A
-- preference that reorders inside the allowed set gives the client a real
-- choice while the boundary stays where accountability sits.
--
-- ── Why only ONE preference, and only for text ───────────────────────────────
--
-- Voice is not a choice. Live audio runs on Gemini because that is the only
-- provider in this product that does bidiGenerateContent at all; offering a
-- client "Claude for voice" would be offering something that cannot be
-- delivered. So the stored preference covers the tasks where a genuine choice
-- exists — synthesis, strategy decks, solution design, the Design Studio
-- artifacts, and ordinary text — and voice is simply not part of it.
--
-- ── Grain ───────────────────────────────────────────────────────────────────
--
-- (tenant, client_norm), matching byok_keys and usage_events. A client is not a
-- table in this schema — it is engagements.client_name normalised — and every
-- other per-client fact in this product is keyed the same way.
-- =============================================================================

CREATE TABLE IF NOT EXISTS client_routing (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_norm  text NOT NULL,
  client_name  text NOT NULL,
  -- Which vendor this client would rather have for the tasks where a choice
  -- exists. NULL is not stored: a client with no preference has no row.
  text_vendor  text NOT NULL,
  note         text,
  set_by       uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_client_routing ON client_routing (tenant_id, client_norm);

-- The same two vendors BYOK recognises, named the same way, so one vocabulary
-- runs from the setup screen through the router to the metering row.
ALTER TABLE client_routing DROP CONSTRAINT IF EXISTS client_routing_vendor_known;
ALTER TABLE client_routing ADD CONSTRAINT client_routing_vendor_known CHECK (
  text_vendor IN ('gemini-aistudio', 'anthropic-api')
);

ALTER TABLE client_routing ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_routing FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON client_routing;
CREATE POLICY tenant_isolation ON client_routing
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON client_routing TO vyne_app;
