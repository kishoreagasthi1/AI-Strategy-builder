-- =============================================================================
-- Duplicate interview cleanup — DRY RUN (v5.34.11)
--
-- Shows which interview rows are duplicates within the SAME
-- (interviewee_user_id, client_name, round_number) group. A NULL round matches
-- NULL; a different round_number is a LEGITIMATELY separate interview and is
-- NEVER grouped with another round. Within each group it KEEPS one row —
-- highest status (completed > in_progress > invited), newest as tie-break —
-- and lists the rest as deletion candidates.
--
-- THIS SCRIPT DELETES NOTHING. It only SELECTs. Review the output, then run
-- dedup_interviews_apply.sql if (and only if) the candidate list is correct.
--
-- Run against production (Cloud SQL) from a context that can reach the DB,
-- e.g. Cloud Shell with the proxy, as the app/owner role. Set the tenant if
-- your connection enforces RLS.
-- =============================================================================

WITH ranked AS (
  SELECT
    id, tenant_id, interviewee_user_id, client_name, round_number,
    status, interviewee_name, created_at,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, interviewee_user_id, lower(client_name), round_number
      ORDER BY
        CASE status WHEN 'completed' THEN 3 WHEN 'in_progress' THEN 2 ELSE 1 END DESC,
        created_at DESC
    ) AS rn,
    COUNT(*) OVER (
      PARTITION BY tenant_id, interviewee_user_id, lower(client_name), round_number
    ) AS group_size
  FROM interviews
)
SELECT
  CASE WHEN rn = 1 THEN 'KEEP' ELSE 'DELETE' END AS action,
  interviewee_name, client_name,
  COALESCE(round_number::text, 'current(NULL)') AS round,
  status, created_at, id
FROM ranked
WHERE group_size > 1          -- only show rows that are part of a duplicate group
ORDER BY interviewee_name, lower(client_name), round_number NULLS FIRST,
         CASE WHEN rn = 1 THEN 0 ELSE 1 END, created_at DESC;
