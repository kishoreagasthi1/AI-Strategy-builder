-- =============================================================================
-- APPLY migration 028 BY HAND, ledger included  (v5.33.8)
--
-- WHEN TO USE THIS. `npm run migrate` through cloud-sql-proxy has now failed
-- three times on this project with `read ECONNRESET` — 025, then 026/027, now
-- 028. This time it is accompanied by gcloud itself failing TLS verification
-- against oauth2.googleapis.com, which means the proxy cannot authenticate
-- either; the ECONNRESET is the proxy resetting a connection it could never
-- complete. The proxy is not the point. Getting the column into the database
-- is.
--
-- This file is 028 VERBATIM plus the schema_migrations row the runner would
-- have written, in ONE transaction.
--
--   Cloud Shell (no proxy, no local Node, no gcloud on your Mac involved):
--     gcloud sql connect vyne-sql --user=vyne --database=vyne \
--       --project=vyne-platform-prod
--     \i apply_028_manual.sql          -- or just paste the whole file
--
-- MUST RUN AS THE OWNER ROLE (`vyne`), not vyne_app: it alters a table. That is
-- the same role `npm run migrate` uses.
--
-- SAFE TO RE-RUN. The DDL is IF NOT EXISTS / IF EXISTS and the ledger insert is
-- ON CONFLICT DO NOTHING. If 028 already applied, this is a no-op costing one
-- transaction.
--
-- NO RLS TOGGLING HERE, unlike 026/027 — 028 adds a column with a default and
-- touches no policy, so there is no window in which tenant isolation is off.
-- The transaction is still the right shape: the column and its ledger row land
-- together or not at all.
--
-- AFTERWARDS, verify (see the block at the end): every interview must have a
-- depth, and it must be 'deep' — that is what they were all running as before
-- the column existed, so anything else means something wrote to it early.
-- =============================================================================

BEGIN;

\echo '── applying 028_interview_depth_column.sql ──'

-- =============================================================================
-- 028 — Interview DEPTH lives on the INTERVIEW, not on the consultant's screen
--
-- v5.33.8. Exactly the defect 014 fixed for interviewer name and voice, in the
-- one remaining field that has it. Depth — the question budget the agent works
-- to, and therefore how long an executive is in the chair — was chosen on
-- interview_agent.html's setup screen and stored nowhere at all.
--
-- Two consequences, established by driving both sides in a real browser rather
-- than by reading the code:
--
--   1. The setup screen is hidden outright for interviewees (see the
--      DOMContentLoaded block in interview_agent.html), so an invited executive
--      never sees the control.
--   2. The consultant's choice persisted to no key, no column and no field on
--      the invite. Probed directly: a consultant selecting "Quick Screen" wrote
--      `depth` into zero workspace keys, and the interviewee's session still
--      reported S.depth === 'deep', budget 50.
--
-- So every distributed interview ran as a 40–50 question Deep Dive whatever the
-- consultant intended, and the preview sheet's estimate of how long it would
-- take could be wrong by an hour — always long.
--
-- WHY NOT NULL DEFAULT 'deep', where 014 chose nullable
--
-- 014's fields have a meaningful "unset" — NULL means "firm default voice", and
-- a consultant must be able to get back to it. Depth has no such state: an
-- interview always runs to some budget, and today that budget is always deep.
-- Backfilling every existing row to 'deep' therefore changes nothing for
-- anybody — it writes down what was already happening. The consultant now picks
-- it per invite, and 'deep' stays the default they get if they do not.
--
-- The CHECK is the same belt-and-braces as 014's length bounds: the route
-- validates the enum, and the column refuses anything else regardless.
-- =============================================================================

ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS depth text NOT NULL DEFAULT 'deep';

ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_depth_valid;
ALTER TABLE interviews ADD  CONSTRAINT interviews_depth_valid
  CHECK (depth IN ('quick', 'standard', 'deep'));

COMMENT ON COLUMN interviews.depth IS
  'Question budget the agent works to: quick ~25, standard ~35, deep ~50. For '
  'follow-up interviews it scales the agenda-derived budget instead — see '
  'computeRefreshQuestionBudget in frontend/interview_agent.html. Chosen by the '
  'consultant on the invite; defaults to deep, which is what every interview '
  'ran as before this column existed.';

INSERT INTO schema_migrations (filename) VALUES ('028_interview_depth_column.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
\echo ''
\echo '════ VERIFY ════'

BEGIN;

-- 1. The column exists, is NOT NULL, and defaults to deep.
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'interviews' AND column_name = 'depth';

-- 2. The CHECK constraint is on.
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'interviews'::regclass AND conname = 'interviews_depth_valid';

-- 3. Every existing interview is 'deep'.
--
--    THE RLS GATE. `interviews` is FORCE ROW LEVEL SECURITY, and FORCE binds
--    the TABLE OWNER too. A plain `SELECT ... FROM interviews` run as `vyne`
--    with no app.tenant_id set returns ZERO ROWS on a database with thousands
--    — no error, no warning. The first draft of this file did exactly that and
--    printed "(0 rows)" against a table with interviews in it, which is
--    indistinguishable from "there are none". That is the identical failure
--    that made verify_026_027.sql report a false CLEAN in v5.33.3.
--
--    So: loop the tenants, set the GUC for each, and aggregate. `tenants` is
--    not RLS-protected (verified: relrowsecurity = false), so the loop itself
--    sees everything. The result is an exact global distribution rather than a
--    number that depends on a session setting nobody remembered to make.
CREATE TEMP TABLE _depth_counts (tenant uuid, depth text, n bigint) ON COMMIT DROP;

DO $verify$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    INSERT INTO _depth_counts
      SELECT t.id, i.depth, count(*) FROM interviews i GROUP BY i.depth;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$verify$;

SELECT depth, sum(n) AS interviews
  FROM _depth_counts
 GROUP BY depth
 ORDER BY depth;

-- ...and the honest total, so "0 rows above" can be told apart from "no data".
SELECT (SELECT count(*) FROM tenants)              AS tenants_scanned,
       COALESCE((SELECT sum(n) FROM _depth_counts), 0) AS interviews_seen;

-- 4. The ledger agrees, so `npm run migrate` will not try again once the
--    connection problem is fixed.
SELECT filename, applied_at
  FROM schema_migrations
 WHERE filename LIKE '02%'
 ORDER BY filename;

COMMIT;

\echo 'DONE. 028 applied and recorded. Deploy the API only after this succeeds.'
