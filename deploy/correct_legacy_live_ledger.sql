-- =============================================================================
-- ONE-TIME: retire the pre-migration-015 live-session reservations.
--
-- v5.34.48's sweeper pairs a hold to its release by session_id. Rows written
-- before migration 015 have none — the column did not exist — so they can
-- never be paired, never be released, and never leave the client's invoice.
-- Measured on production 2026-09-12: 10 holds, 6 unmatched releases, 13
-- reserves and 10 refunds, all with session_id NULL, all around 11 August,
-- netting about $2.36 of reservations that were never reconciled against
-- anything. There are no actual-usage rows from that period at all, so what
-- those sessions really cost is not recoverable.
--
-- Same principle as the sweeper: a reservation that was never reconciled is
-- not evidence of consumption, and an honest undercount beats billing a
-- worst-case estimate. This writes ONE correcting row rather than trying to
-- release each orphan, because with no session_id there is nothing to pair
-- them to and no way to make per-row releases idempotent.
--
-- Idempotent: the row carries a fixed session_id, so migration 015's
-- uq_usage_one_release_per_session refuses a second one. Run it twice and the
-- second is a no-op.
--
-- Scope is deliberately narrow and cannot grow: session_id IS NULL, this
-- provider, only the four non-billable reservation tasks. Real metered
-- consumption (task 'live_session') is untouched.
--
--   SET app.tenant_id = '<tenant uuid>';
--   \i deploy/correct_legacy_live_ledger.sql
-- The before/after readings filter by tenant EXPLICITLY rather than leaning on
-- row-level security. Run as a superuser (postgres, or an owner with
-- BYPASSRLS) the policy does not apply, and an unfiltered total would silently
-- sum every firm — making a correct correction look like it removed far too
-- much. Found while testing this script, by exactly that route.
-- =============================================================================

SELECT 'before' AS when, round(sum(cost_est_usd)::numeric,4) AS voice_usd
  FROM usage_events
 WHERE provider = 'gemini-live'
   AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid;

INSERT INTO usage_events
  (tenant_id, module, task, provider, model,
   tokens_in, tokens_out, cost_est_usd, latency_ms, ok, session_id)
SELECT h.tenant_id,
       'legacy_correction',
       'live_session_hold_release',
       'gemini-live',
       'legacy',
       -SUM(h.tokens_in),
       -SUM(h.tokens_out),
       -SUM(h.cost_est_usd),
       0, true,
       'legacy-pre015-correction'
  FROM usage_events h
 WHERE h.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
   AND h.provider = 'gemini-live'
   AND h.session_id IS NULL
   AND h.task IN ('live_session_hold', 'live_session_hold_release',
                  'live_session_reserve', 'live_session_refund')
 GROUP BY h.tenant_id
HAVING SUM(h.cost_est_usd) <> 0
ON CONFLICT DO NOTHING;

SELECT 'after' AS when, round(sum(cost_est_usd)::numeric,4) AS voice_usd
  FROM usage_events
 WHERE provider = 'gemini-live'
   AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid;
