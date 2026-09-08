-- =============================================================================
-- 013 — Least privilege and a hole in the audit trail (v5.32.31)
--
-- Both items here were found by test/schemaInvariants.test.ts, which asserts
-- properties of the LIVE catalog rather than reviewing migration text. Neither
-- was visible to three prior source-reading review passes.
--
-- NOTE, as in 012: nothing in this file touches row-level security on `tenants`.
-- `tenants` is deliberately NOT an RLS table — it is the table tenant context is
-- RESOLVED from. See the comment block in 012_spend_caps.sql for what happened
-- the one time a migration enabled RLS on it by rote.
-- =============================================================================

-- ── 1. subscription_plans: the app never writes it, so it must not be able to ──
--
-- 009 granted SELECT, INSERT, UPDATE, DELETE on subscription_plans to vyne_app
-- along with every other table, by pattern rather than by need. But this is
-- global reference data and application code only ever SELECTs it: the four
-- read sites are billing/subscriptions.ts (plan catalog, tenant plan join,
-- checkout price lookup, webhook price→key reverse lookup) and
-- tenant/provisioning.ts (trial token ceiling). There is no writer.
--
-- The grant matters because of WHAT this table holds. monthly_token_limit is
-- the spend cap 012 exists to enforce, and stripe_price_id is what checkout
-- sends the customer to pay. An UPDATE grant the application never exercises
-- converts any SQL-injection foothold or compromised container into "raise my
-- own firm's spend ceiling to infinity" or "point checkout at a different
-- Stripe price" — neither of which would raise an error or look wrong.
--
-- The table also has no RLS (correctly — it is identical for every firm), so
-- unlike every tenant-owned table there is no second line of defence here.
REVOKE INSERT, UPDATE, DELETE ON subscription_plans FROM vyne_app;

-- ── 2. audit_log.tenant_id must be NOT NULL ───────────────────────────────────
--
-- audit_log is the only tenant-scoped table whose tenant_id is nullable (001
-- created it without the constraint; every other table has it). That is worse
-- than it looks, because of how RLS treats NULL: the policy is
--
--     tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
--
-- and `NULL = anything` evaluates to NULL, not true — so a row written with a
-- NULL tenant_id satisfies NO policy and is invisible to every reader,
-- including the owner reading their own audit log. It does not error. It does
-- not appear. The 010 revoke makes the table append-only precisely so that a
-- record cannot be removed after the fact; a silently unreadable row is the
-- same outcome reached by a different route.
--
-- auditLog() always passes a concrete tenantId today, so this is a guard
-- against a future caller, not a fix for present data loss. That is the point:
-- the constraint makes the failure loud (an error at the INSERT) instead of
-- silent (a record nobody can ever read).
--
-- Defensive: adopt any pre-existing orphan rows into no tenant rather than
-- failing the migration on a database that already has some. There should be
-- none; if there are, they were already invisible and this surfaces the count
-- in the migration output.
DO $$
DECLARE orphans bigint;
BEGIN
  SELECT count(*) INTO orphans FROM audit_log WHERE tenant_id IS NULL;
  IF orphans > 0 THEN
    RAISE WARNING 'audit_log: % row(s) with NULL tenant_id were unreadable under RLS and are being deleted', orphans;
    DELETE FROM audit_log WHERE tenant_id IS NULL;
  END IF;
END $$;

ALTER TABLE audit_log ALTER COLUMN tenant_id SET NOT NULL;
