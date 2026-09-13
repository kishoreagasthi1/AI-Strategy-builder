-- =============================================================================
-- 032 — WHO PAID for each metered call.
--
-- ── The double-billing this prevents ─────────────────────────────────────────
--
-- Migrations 030/031 let a client supply their own API key; v5.34.59 makes the
-- gateway actually SPEND it. When it does, Google or Anthropic bills the client
-- directly — the charge never touches the firm's account.
--
-- usage_events is, in metering.ts's own words, "the raw material for billing
-- later", and /api/billing/statement totals cost_est_usd per client to produce
-- the invoice the firm sends. Without this column that invoice would include
-- work the client HAS ALREADY PAID FOR, on their own card, and the firm would
-- be charging them a second time for it. Not an approximation error — a bill
-- for money that was never spent by the party sending the bill.
--
-- ── Why the row is written at all ────────────────────────────────────────────
--
-- It would be simpler to write nothing for a client-paid call. That would be
-- wrong twice over:
--
--   · the plan cap (tenants.monthly_token_limit) counts tokens, and a firm
--     whose clients all brought keys would have an uncapped, unmeasured
--     platform — the concurrency and spend guards in metering.ts all read
--     these rows;
--   · the firm still needs to SEE the volume. "Nestlé ran 40 interviews on
--     their own key" is a fact about the engagement, and a consultant who
--     cannot see it cannot manage it.
--
-- So the row is written in full, including cost_est_usd — which is the real
-- estimated cost, just not the firm's to recover. `payer` is what separates
-- "recorded" from "recoverable", and routes/billing.ts reads it to split the
-- two totals rather than dropping one.
--
-- ── Default 'platform', because that is what every existing row is ───────────
--
-- Nothing has ever spent a client credential before this release, so every row
-- already in the table was paid for by the firm. A NOT NULL DEFAULT backfills
-- them correctly by construction rather than by a guess in an UPDATE.
-- =============================================================================

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS payer text NOT NULL DEFAULT 'platform';

-- The last four characters of the client key that served the call, when one
-- did. Four characters is the same hint the Owner already sees on the keys
-- screen: enough to recognise which key was in use when a client rotates one,
-- useless to anyone else. The key itself is never here, and never in this
-- database at all — see llm/byok/secretStore.ts.
ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS payer_key_hint text;

ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_events_payer_known;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_payer_known CHECK (
  payer IN ('platform', 'client_key')
);

-- The statement query already filters on (created_at, task) and then splits in
-- JavaScript, so this index is not for it. It is for the question an Owner asks
-- when a client's key stops working — "what ran on their key, and when did it
-- stop" — which would otherwise scan the whole month.
CREATE INDEX IF NOT EXISTS idx_usage_events_client_payer
  ON usage_events (tenant_id, client_norm, payer, created_at DESC)
  WHERE payer <> 'platform';
