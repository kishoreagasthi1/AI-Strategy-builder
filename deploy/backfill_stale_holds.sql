-- =============================================================================
-- ONE-TIME backfill: release live-session holds stranded before v5.34.48.
--
-- From v5.34.48 onward admitLiveSession sweeps automatically, so this is only
-- needed for holds already in the ledger. Safe to run more than once — the
-- unique index from migration 015 makes a second release impossible.
--
-- Run it inside psql with app.tenant_id set to the firm you are correcting.
-- usage_events is FORCE row-level security: with no tenant set this quietly
-- does nothing, which looks exactly like success. Set it.
--
--   SET app.tenant_id = '<tenant uuid>';
--   \i deploy/backfill_stale_holds.sql
--
-- It prints the voice-line total before and after so the correction is visible.
-- The before/after readings filter by tenant EXPLICITLY rather than leaning on
-- row-level security. Run as a superuser (postgres, or an owner with
-- BYPASSRLS) the policy does not apply, and an unfiltered total would silently
-- sum every firm — making a correct correction look like it removed far too
-- much. Found while testing this script, by exactly that route.
-- =============================================================================

SELECT 'before' AS when, count(*) AS rows, round(sum(cost_est_usd)::numeric, 2) AS voice_usd
  FROM usage_events
 WHERE provider = 'gemini-live'
   AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid;

INSERT INTO usage_events
  (tenant_id, user_id, module, task, provider, model,
   tokens_in, tokens_out, cost_est_usd, latency_ms, ok,
   client_name, client_norm, session_id)
SELECT DISTINCT ON (h.session_id)
       h.tenant_id, h.user_id, h.module, 'live_session_hold_release', h.provider, h.model,
       -h.tokens_in, -h.tokens_out, -h.cost_est_usd, 0, true,
       h.client_name, h.client_norm, h.session_id
  FROM usage_events h
 WHERE h.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
   AND h.task = 'live_session_hold'
   AND h.session_id IS NOT NULL
   AND h.created_at < now() - make_interval(secs => 3300)
   AND NOT EXISTS (
         SELECT 1 FROM usage_events r
          WHERE r.tenant_id = h.tenant_id
            AND r.session_id = h.session_id
            AND r.task = 'live_session_hold_release')
 ORDER BY h.session_id, h.created_at
ON CONFLICT DO NOTHING;

SELECT 'after' AS when, count(*) AS rows, round(sum(cost_est_usd)::numeric, 2) AS voice_usd
  FROM usage_events
 WHERE provider = 'gemini-live'
   AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid;
