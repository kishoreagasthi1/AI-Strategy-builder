-- =============================================================================
-- Duplicate interview cleanup — APPLY (v5.34.11)
--
-- DELETES the duplicate rows identified by dedup_interviews_dryrun.sql, using
-- the IDENTICAL grouping and keep-rule. Run ONLY after reviewing the dry run.
--
-- Wrapped in a transaction: it prints the count, and you COMMIT or ROLLBACK.
-- Different rounds and different clients are never touched.
-- =============================================================================

BEGIN;

WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, interviewee_user_id, lower(client_name), round_number
      ORDER BY
        CASE status WHEN 'completed' THEN 3 WHEN 'in_progress' THEN 2 ELSE 1 END DESC,
        created_at DESC
    ) AS rn
  FROM interviews
)
DELETE FROM interviews
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Review the row count above. Then:
--   COMMIT;    -- to make it permanent
--   ROLLBACK;  -- to undo and change nothing
