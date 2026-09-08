-- 029 — covering index for the per-call spend-cap SUM (perf review, Phase 3)
--
-- capsCheckOn() (llm/metering.ts) runs on EVERY LLM call and is the hottest read
-- in the product. Its monthly cap SUM and its aging CTE both read usage_events
-- for (tenant_id, current month), summing tokens_in + tokens_out and filtering
-- on task / session_id.
--
-- idx_usage_tenant_time (tenant_id, created_at) — from 001_core.sql — already
-- restricts that scan to the current month, so cost does NOT grow with the total
-- table size (a point the review slightly overstated). What it does NOT avoid is
-- a heap fetch per matched row to read tokens_in/out, task and session_id. This
-- INCLUDE index carries those non-key columns in the btree leaf, so the whole
-- aggregation becomes INDEX-ONLY: no heap traffic, cost proportional only to the
-- current month's row count, on the path that gates every generation.
--
-- It REPLACES idx_usage_tenant_time rather than sitting beside it: the btree key
-- is identical (tenant_id, created_at), so this index serves everything the old
-- one did — including billing's tenant+time range reads — and more, while
-- keeping the write-side index count flat (one per usage_events insert, not two).
-- Dropped and recreated in the same migration transaction, so there is never a
-- moment where neither exists.
--
-- No data change, no RLS interaction (index DDL runs as the owner, unaffected by
-- the row policies), fully reversible: DROP idx_usage_cap_cover + recreate
-- idx_usage_tenant_time restores the prior state exactly.
--
-- NOTE for future scale: on a large usage_events this CREATE INDEX takes a brief
-- write lock. The migration runner wraps each file in one transaction, so a
-- CONCURRENTLY build (which cannot run inside a transaction) is not possible
-- here; if the table is ever large enough for the lock to matter, build the new
-- index CONCURRENTLY out-of-band first, then reduce this file to the DROP.

DROP INDEX IF EXISTS idx_usage_tenant_time;

CREATE INDEX IF NOT EXISTS idx_usage_cap_cover
  ON usage_events (tenant_id, created_at)
  INCLUDE (tokens_in, tokens_out, task, session_id, user_id);
