-- =============================================================================
-- 012 — Give the spend cap a value (v5.32.29, audit CR-3)
--
-- llm/metering.ts has enforced tenants.monthly_token_limit since the platform
-- was built, on every AI path, with an advisory lock to narrow a TOCTOU race,
-- and routes/voice.ts was wired through it by an earlier audit fix. All of
-- that was enforcing a limit that was never set: the column has no DEFAULT and
-- no code path ever wrote it. dbLimitCheck therefore always hit
--
--     if (row.monthly_token_limit === null) return { allowed: true }
--
-- so the documented cost control was inert on every tenant, from the first
-- deploy. Combined with an unbounded `messages` array and rate limiting on
-- four routes out of forty, an interviewee — the least-privileged role in the
-- product — could bill a firm without limit.
--
-- The limit belongs to the PLAN, so it lives beside the price rather than
-- being typed into each tenant by hand. Figures below are deliberately
-- generous relative to real diagnostic usage (a full 10-interview engagement
-- with synthesis, roadmap and design studio runs on the order of 2-4M tokens):
-- the cap is a blast-radius bound on abuse and runaway loops, not a
-- usage-shaping device. Adjust them against your own metering data before
-- go-live — and note they are a CEILING, not an entitlement.
-- =============================================================================

ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS monthly_token_limit bigint;

UPDATE subscription_plans SET monthly_token_limit = 3000000    WHERE key = 'trial'          AND monthly_token_limit IS NULL;
UPDATE subscription_plans SET monthly_token_limit = 20000000   WHERE key = 'sprint'         AND monthly_token_limit IS NULL;
UPDATE subscription_plans SET monthly_token_limit = 60000000   WHERE key = 'transformation' AND monthly_token_limit IS NULL;
UPDATE subscription_plans SET monthly_token_limit = 200000000  WHERE key = 'caio'           AND monthly_token_limit IS NULL;

-- A tenant created before this migration has NULL — i.e. unlimited. Backfill
-- from its plan, and give the column a DEFAULT so a future INSERT that forgets
-- it lands on the trial ceiling rather than silently on "no limit at all".
-- That default is the important half: it makes the safe state the automatic
-- one, which is what was missing.
--
-- NOTE: no RLS toggling here, unlike migration 011. `tenants` is deliberately
-- NOT an RLS table — it is the table the tenant context is RESOLVED from, so
-- 001_core.sql never enabled RLS on it and no policy exists for it anywhere.
-- An earlier draft of this file copied 011's disable/enable pattern by rote,
-- which flipped `tenants` from "no RLS" to "RLS forced with zero policies" —
-- and in Postgres that means deny everything. It made every authenticated
-- request 403 (the membership join reads `tenants`), blocked firm creation,
-- and broke the Stripe webhook's tenant resolution. CI missed it because the
-- migration user in the container image is a superuser and superusers bypass
-- RLS unconditionally, FORCE or not.

UPDATE tenants t
   SET monthly_token_limit = COALESCE(p.monthly_token_limit, 3000000)
  FROM subscription_plans p
 WHERE p.key = t.plan
   AND t.monthly_token_limit IS NULL;

UPDATE tenants SET monthly_token_limit = 3000000 WHERE monthly_token_limit IS NULL;

ALTER TABLE tenants ALTER COLUMN monthly_token_limit SET DEFAULT 3000000;

-- Per-user daily ceiling, enforced in llm/metering.ts alongside the tenant
-- cap. The tenant cap bounds the month; this bounds how fast any ONE account
-- — including an interviewee's — can consume it. Without it, a single
-- compromised or hostile account can burn a firm's entire monthly allowance
-- in an afternoon and deny service to everyone else in the firm.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS daily_user_token_limit bigint NOT NULL DEFAULT 500000;

CREATE INDEX IF NOT EXISTS idx_usage_events_user_day
  ON usage_events(tenant_id, user_id, created_at);
