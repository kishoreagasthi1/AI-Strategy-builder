-- =============================================================================
-- VERIFY migrations 026 and 027 (v5.33.3) actually applied
--
--   ~/cloud-sql-proxy --port 5433 vyne-platform-prod:us-central1:vyne-sql
--   psql "postgres://vyne:<OWNER_PW>@localhost:5433/vyne" -f deploy/verify_026_027.sql
--
-- READ-ONLY. Nothing here writes, locks or migrates. Safe against production
-- while the app is serving.
--
-- ── Why this file exists rather than "just check it ran" ────────────────────
--
-- `npm run migrate` prints the files it applied, and "Nothing to apply — up to
-- date." on a release that ships a migration means you are pointed at the wrong
-- database. That output was never captured for this release, and the failure it
-- would have caught is silent in a specific way:
--
--   · If 026 did NOT run, `interviews.synthetic` does not exist, and the
--     v5.33.3 code's `... AND synthetic` queries fail at runtime — every
--     synthetic-engagement operation 500s. Loud, but only once somebody uses
--     that feature.
--
--   · If 026 ran but its BACKFILL matched nothing — the FORCE-RLS trap that
--     broke migration 025 on its first production run — every column is false.
--     Nothing errors. Regeneration silently stops deleting the previous
--     practice set and starts stacking duplicates instead.
--
-- The second is the one worth a script. A migration that "succeeded" having
-- changed nothing is exactly the failure mode this codebase keeps hitting, so
-- CHECK 3 does not ask whether 026 ran; it asks whether it DID anything.
--
-- Every check prints PASS / FAIL / (a reason). Read the whole output — a later
-- FAIL is not made irrelevant by an earlier PASS.
-- =============================================================================

\pset border 2
\pset format aligned
\echo ''
\echo '════════ 0. Which database am I actually connected to? ════════'
\echo '(If this is not the Cloud SQL instance, every result below is fiction.)'
SELECT current_database() AS database,
       current_user       AS connected_as,
       inet_server_addr() AS server_ip,
       inet_server_port() AS port;

\echo ''
\echo '════════ 1. The migration ledger ════════'
\echo 'Both rows must be present. A missing row means the file never ran here.'
SELECT filename,
       applied_at,
       'PASS' AS status
  FROM schema_migrations
 WHERE filename IN ('026_synthetic_flag_column.sql', '027_engagement_code_reclaim.sql')
 UNION ALL
SELECT f, NULL,
       'FAIL — NEVER APPLIED to this database'
  FROM (VALUES ('026_synthetic_flag_column.sql'), ('027_engagement_code_reclaim.sql')) AS t(f)
 WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = t.f)
 ORDER BY 1;

\echo ''
\echo '════════ 2. Does the schema 026 promises actually exist? ════════'
\echo 'The ledger says a file ran. This says the file did what it claims.'
SELECT 'interviews.synthetic'            AS object,
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_name='interviews' AND column_name='synthetic')
            THEN 'PASS' ELSE 'FAIL — column missing; the API will 500 on every synthetic query' END AS status
UNION ALL
SELECT 'interview_transcripts.synthetic',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_name='interview_transcripts' AND column_name='synthetic')
            THEN 'PASS' ELSE 'FAIL — column missing' END
UNION ALL
SELECT 'DELETE policy keyed on the COLUMN, not the display name',
       COALESCE((SELECT CASE
                   WHEN pg_get_expr(pol.polqual, pol.polrelid) LIKE '%interviewee_name%'
                     THEN 'FAIL — still keyed on the [Synthetic] NAME; a real transcript is deletable by spoofing it'
                   WHEN pg_get_expr(pol.polqual, pol.polrelid) LIKE '%synthetic%'
                     THEN 'PASS'
                   ELSE 'FAIL — unrecognised policy expression' END
                 FROM pg_policy pol
                 JOIN pg_class c ON c.oid = pol.polrelid
                WHERE c.relname = 'interview_transcripts'
                  AND pol.polname = 'tenant_delete_synthetic_only'),
                'FAIL — policy tenant_delete_synthetic_only does not exist')
UNION ALL
SELECT 'the app still has NO UPDATE on interview_transcripts',
       CASE WHEN has_table_privilege('vyne_app','interview_transcripts','UPDATE')
            THEN 'FAIL — UPDATE granted; the app could flip `synthetic` on a real row and then delete it'
            ELSE 'PASS' END
UNION ALL
SELECT 'RLS is ENABLED and FORCED on interview_transcripts',
       COALESCE((SELECT CASE WHEN relrowsecurity AND relforcerowsecurity THEN 'PASS'
                             ELSE 'FAIL — 026 disables RLS to backfill; it did not turn it back on' END
                   FROM pg_class WHERE relname='interview_transcripts'), 'FAIL — table missing')
UNION ALL
SELECT 'RLS is ENABLED and FORCED on interviews',
       COALESCE((SELECT CASE WHEN relrowsecurity AND relforcerowsecurity THEN 'PASS'
                             ELSE 'FAIL — RLS left off after the backfill' END
                   FROM pg_class WHERE relname='interviews'), 'FAIL — table missing')
UNION ALL
SELECT 'RLS is ENABLED and FORCED on engagements  (027 also toggles it)',
       COALESCE((SELECT CASE WHEN relrowsecurity AND relforcerowsecurity THEN 'PASS'
                             ELSE 'FAIL — RLS left off after 027' END
                   FROM pg_class WHERE relname='engagements'), 'FAIL — table missing')
UNION ALL
SELECT 'RLS is ENABLED and FORCED on module_state (025/027 toggle it)',
       COALESCE((SELECT CASE WHEN relrowsecurity AND relforcerowsecurity THEN 'PASS'
                             ELSE 'FAIL — RLS left off; THIS IS A TENANT ISOLATION FAILURE, fix before anything else' END
                   FROM pg_class WHERE relname='module_state'), 'FAIL — table missing');

\echo ''
\echo '════════ 2b. CAN THIS SESSION SEE ANY ROWS AT ALL? ════════'
\echo 'Everything below counts rows. If RLS is hiding them, the counts are 0 and'
\echo 'every verdict reads CLEAN — which is the exact lie this file exists to stop.'
--
-- ── The bug this check fixes, which was in THIS FILE ────────────────────────
--
-- interviews, interview_transcripts, engagements and module_state are all
-- FORCE ROW LEVEL SECURITY keyed on current_setting('app.tenant_id'). FORCE
-- binds the TABLE OWNER too. So `vyne`, connected by psql with no app.tenant_id
-- set, sees ZERO rows from all four — with no error.
--
-- CHECK 3 then reported:
--     "N/A — this database has no synthetic interviews, so there was nothing
--      to backfill"
-- against a production database where the migration had just flagged 31.
--
-- I did not catch this before shipping the file because I tested it with a
-- LOCAL `vyne` role created as SUPERUSER, and superusers bypass RLS entirely.
-- The test environment differed from production in the one way that mattered,
-- so the script passed for the wrong reason. That is the same shape as every
-- finding in the v5.33.3 audit: a green that means something narrower than it
-- appears.
--
-- Three ways to see rows: be a superuser, be a BYPASSRLS role, or set
-- app.tenant_id. This asks which (if any) applies, and CHECK 3/4 refuse to
-- render a verdict when the answer is none.
SELECT
  COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '(not set)') AS app_tenant_id,
  current_setting('is_superuser') = 'on'                                    AS is_superuser,
  COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS bypasses_rls,
  CASE
    WHEN current_setting('is_superuser') = 'on'
      OR COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false)
      THEN 'OK — this role bypasses RLS, so the counts below are complete'
    WHEN COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '') <> ''
      THEN 'OK — scoped to one tenant; the counts below cover THAT TENANT ONLY'
    ELSE 'BLIND — RLS is hiding every row. CHECK 3 and 4 below are MEANINGLESS. '
         || 'Pick a tenant and re-run: see the SET command printed underneath.'
  END AS status;

SELECT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = current_user
     AND (rolsuper OR rolbypassrls)
) OR COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '') <> '' AS can_see_rows \gset

\if :can_see_rows
\else
\echo ''
\echo '  ⚠  THIS SESSION CANNOT SEE ROWS. Run these, then re-run this file:'
\echo ''
\echo '     SELECT id, name FROM tenants ORDER BY name;   -- tenants is not RLS-protected'
\echo '     SET app.tenant_id = ''<paste-a-tenant-id-here>'';'
\echo ''
\echo '  Repeat per tenant if the firm has more than one. CHECKS 1, 2 and 2b are'
\echo '  catalog-level and stay valid; 3 and 4 are skipped below.'
\endif

\echo ''
-- Guard the row-level checks on the COLUMN existing. Without this, a database
-- that never got 026 answers CHECK 3 with a raw
--     ERROR:  column "synthetic" does not exist
-- which is true, unreadable, and easy to scroll past. The first draft of this
-- file did exactly that. A verification script whose failure mode is a stack of
-- Postgres errors is one somebody stops running.
SELECT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='interviews' AND column_name='synthetic') AS has_flag \gset

\echo '════════ 3. Did the BACKFILL do anything? (the silent failure) ════════'
\echo 'A migration that ran, reported success and matched zero rows is how 025'
\echo 'failed the first time. This asks about ROWS, not about files.'
\if :can_see_rows
\if :has_flag
SELECT count(*) FILTER (WHERE state_module LIKE 'iv\_synth\_%')                  AS synthetic_by_state_module,
       count(*) FILTER (WHERE synthetic)                                        AS flagged_synthetic,
       count(*) FILTER (WHERE state_module LIKE 'iv\_synth\_%' AND NOT synthetic) AS missed_by_backfill,
       CASE
         WHEN count(*) FILTER (WHERE state_module LIKE 'iv\_synth\_%') = 0
           THEN 'N/A — this database has no synthetic interviews, so there was nothing to backfill'
         WHEN count(*) FILTER (WHERE state_module LIKE 'iv\_synth\_%' AND NOT synthetic) > 0
           THEN 'FAIL — the backfill did not see these rows (the FORCE-RLS trap). Re-run 026.'
         ELSE 'PASS'
       END AS status
  FROM interviews;
\else
\echo '  SKIPPED — interviews.synthetic does not exist, so there is nothing to'
\echo '  count. See CHECK 2: migration 026 has not been applied here.'
\endif
\else
\echo '  NOT RUN — RLS is hiding every row from this session (see CHECK 2b).'
\echo '  A zero here would mean "cannot see", not "nothing to find".'
\endif

\echo ''
\echo '════════ 4. Was the [Synthetic] spoof ever exercised here? ════════'
\echo 'Rows whose NAME ends [Synthetic] but which are NOT synthetic were deletable'
\echo 'under 024s rule and are protected now. Non-zero is not an error — but'
\echo 'somebody should look at what they are.'
\if :can_see_rows
\if :has_flag
SELECT count(*) AS protected_rows_formerly_deletable,
       CASE WHEN count(*) = 0
            THEN 'CLEAN — no real transcript was ever named to look synthetic'
            ELSE 'REVIEW — list them with the query printed below' END AS status
  FROM interview_transcripts
 WHERE interviewee_name LIKE '%[Synthetic]' AND NOT synthetic;
\else
\echo '  SKIPPED — no `synthetic` column to compare the name against. Every'
\echo '  transcript whose name ends [Synthetic] is deletable right now.'
\endif
\else
\echo '  NOT RUN — RLS is hiding every row from this session (see CHECK 2b).'
\endif
\echo 'If REVIEW:  SELECT id, client_name, interviewee_name, round_number, created_at'
\echo '              FROM interview_transcripts'
\echo '             WHERE interviewee_name LIKE ''%[Synthetic]'' AND NOT synthetic;'

\echo ''
\echo '════════ 5. 027 — engagement codes vs the workspace index ════════'
\echo 'An engagement whose code no index entry references had its code MINTED by'
\echo '025 rather than adopted, which orphans its vynora_*_<OLDCODE> blobs.'
\echo 'Engagements created after 025 legitimately appear here, so read the names.'
SELECT EXISTS (SELECT 1 FROM schema_migrations
                WHERE filename='025_engagement_code_column.sql') AS has_025 \gset
\if :has_025
SELECT e.id,
       e.client_name,
       e.code,
       e.created_at,
       CASE WHEN e.created_at > (SELECT applied_at FROM schema_migrations
                                  WHERE filename='025_engagement_code_column.sql')
            THEN 'OK — created after 025, so no index entry is expected'
            ELSE 'REVIEW — predates 025 and holds an unreferenced code; its synthesis/roadmap blobs may be orphaned' END AS note
  FROM engagements e
 WHERE NOT EXISTS (
   SELECT 1
     FROM module_state ms,
          LATERAL jsonb_each_text((ms.value->>'v')::jsonb) AS kv(k, v)
    WHERE ms.module = 'workspace'
      AND ms.key = 'vynora_engagement_index'
      AND ms.tenant_id = e.tenant_id
      AND kv.v = e.code)
 ORDER BY e.created_at;
\else
\echo '  SKIPPED — migration 025 is not in the ledger either. This database is'
\echo '  further behind than 026/027; check what release it is actually on.'
\endif

\echo ''
\echo '════════ 6. Every engagement still has a code (025s NOT NULL holds) ════════'
SELECT count(*) AS engagements,
       count(code) AS with_a_code,
       CASE WHEN count(*) = count(code) THEN 'PASS'
            ELSE 'FAIL — NOT NULL was dropped or 025 was rolled back' END AS status
  FROM engagements;

\echo ''
\echo '════════ SUMMARY ════════'
\echo 'Every status column above must read PASS, N/A, OK or CLEAN.'
\echo 'Any FAIL: do not deploy the v5.33.3+ API until it is resolved — the code'
\echo 'assumes these columns exist and will 500 on synthetic operations.'
\echo ''
