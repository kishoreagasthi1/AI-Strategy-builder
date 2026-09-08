-- =============================================================================
-- 009 — SaaS subscription billing (Stripe): the platform charging TENANT
-- FIRMS to use VYNE itself.
-- =============================================================================
-- Distinct from migration 007's client cost-recovery billing (a firm
-- passing its own AI usage cost through to ITS clients, at cost, no
-- markup) — this is the other direction: what a tenant firm pays VYNE/
-- Vynora to run the platform at all.
--
-- tenants.plan and tenants.monthly_token_limit have existed since
-- 001_core.sql ("Plan limits stubbed NOW so billing can attach later
-- without a schema change") — this migration is that attachment. The four
-- plan keys below (trial/sprint/transformation/caio) are exactly the values
-- 001_core.sql's own inline comment already documented for tenants.plan, so
-- this is completing an existing design, not inventing a new one.
--
-- No hard FK from tenants.plan → subscription_plans.key: tenants.plan is a
-- live production column (every provisioned tenant already has a value in
-- it, default 'trial') and this migration can't inspect real prod data
-- before running — a stray legacy value would fail the whole migration.
-- Application code is the enforcement point for which keys are valid
-- (routes/subscriptions.ts), the same trust boundary already used for
-- tenants.status ('active'/'suspended', also un-constrained).
-- =============================================================================

CREATE TABLE IF NOT EXISTS subscription_plans (
  key               text PRIMARY KEY,
  name              text NOT NULL,
  -- NULL = not billed at all (the trial tier). Populate/adjust these before
  -- go-live — see routes/subscriptions.ts's doc comment: these are
  -- placeholder figures, not confirmed pricing.
  monthly_price_usd numeric(10,2),
  -- NULL until an operator creates the matching Price in the Stripe
  -- dashboard and sets it here. Checkout for a plan with no stripe_price_id
  -- is refused with a clear error rather than silently failing at Stripe.
  stripe_price_id   text,
  is_purchasable    boolean NOT NULL DEFAULT true,
  sort_order        smallint NOT NULL DEFAULT 0
);

INSERT INTO subscription_plans (key, name, monthly_price_usd, stripe_price_id, is_purchasable, sort_order) VALUES
  ('trial',          'Trial',          NULL,     NULL, false, 0),
  ('sprint',         'Sprint',         495.00,   NULL, true,  1),
  ('transformation', 'Transformation', 1495.00,  NULL, true,  2),
  ('caio',           'CAIO',           3995.00,  NULL, true,  3)
ON CONFLICT (key) DO NOTHING;

-- A brand-new table needs its own grant — 001_core.sql's blanket GRANT only
-- covered the tables that existed at the time (see 002/003/004_*.sql for
-- the same pattern on every table added since). subscription_plans has no
-- tenant_id column (it's global reference data, same trust tier as
-- everything already reached through withoutTenant() in this file's
-- companion, billing/subscriptions.ts) so it gets no RLS policy — just a
-- grant, like tenants/users/memberships already have.
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_plans TO vyne_app;

-- Stripe linkage + subscription lifecycle state, attached directly to
-- tenants (not a separate table) — there is exactly one billing account per
-- tenant, and tenants.plan/monthly_token_limit already live here.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_customer_id     text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  -- Mirrors Stripe's own subscription.status values (trialing, active,
  -- past_due, canceled, incomplete, incomplete_expired, unpaid) plus 'none'
  -- for a tenant that has never started checkout. Source of truth is
  -- Stripe; this is a synced cache updated by the webhook handler.
  ADD COLUMN IF NOT EXISTS subscription_status    text NOT NULL DEFAULT 'trialing',
  ADD COLUMN IF NOT EXISTS current_period_end     timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end   boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_stripe_customer_id
  ON tenants(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_stripe_subscription_id
  ON tenants(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
