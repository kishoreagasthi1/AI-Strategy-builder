/**
 * Release live-session holds that no /close ever arrived for. (v5.34.48)
 *
 * The reasoning, the measurement that prompted it, and the safety argument for
 * the statement itself all live in sweepStaleHolds.sql next to this file. Read
 * that first — this module only decides WHEN the statement runs.
 *
 * ── Where it runs, and why not a cron ───────────────────────────────────────
 *
 * Opportunistically, at the top of admitLiveSession, inside the transaction
 * that admission already holds for this tenant. That placement is deliberate:
 *
 *   · No new endpoint, so no new authenticated surface to get wrong.
 *   · No dependency on Cloud Scheduler, which is another thing to provision,
 *     monitor and discover has been silently failing.
 *   · It runs immediately BEFORE the concurrency count and the spend-cap
 *     check, both of which read sums over usage_events. A phantom hold does
 *     not only overstate the invoice — it eats the firm's monthly budget and
 *     counts against the concurrent-session guard. Sweeping first means all
 *     three read a corrected ledger.
 *
 * The cost is that a tenant who stops using voice entirely is never swept
 * again, so their statement keeps whatever phantoms it has. That is what the
 * one-time backfill in deploy/ is for; ongoing, a firm that runs interviews
 * cleans itself up the next time it runs one.
 *
 * ── Failure is not allowed to refuse an interview ───────────────────────────
 *
 * A tidy-up must never be the reason a consultant cannot start a session. But
 * a plain try/catch is NOT sufficient here: this runs inside an open
 * transaction, and in Postgres a failed statement poisons the whole
 * transaction — every subsequent query returns "current transaction is
 * aborted", so a swallowed sweep error would take admission down with it while
 * looking handled. Hence the SAVEPOINT: a failure rolls back to it and
 * admission proceeds on a healthy transaction.
 */
import { MAX_SESSION_SECONDS } from "./liveSession.js";

/*
 * The statement is INLINE, not read from a .sql file beside this module.
 *
 * It was a file first, and that would have taken production down on deploy:
 * the Dockerfile copies only `src/db/migrations` into the image
 * ("COPY src/db/migrations ./dist/db/migrations"), and tsc does not copy .sql
 * at all — so readFileSync would have thrown at import time and the service
 * would never have booted. Caught before shipping, but the lesson is that a
 * runtime file read is a build-configuration dependency; a string constant is
 * not. Keep it inline.
 *
 * $1 = age floor in seconds (MAX_SESSION_SECONDS + grace).
 * Requires app.tenant_id to be set — usage_events is FORCE row-level security,
 * so an unset tenant matches no rows and this quietly does nothing.
 */
export const SWEEP_SQL = `
INSERT INTO usage_events
  (tenant_id, user_id, module, task, provider, model,
   tokens_in, tokens_out, cost_est_usd, latency_ms, ok,
   client_name, client_norm, session_id, payer, payer_key_hint)
SELECT DISTINCT ON (h.session_id)
       h.tenant_id, h.user_id, h.module, 'live_session_hold_release', h.provider, h.model,
       -h.tokens_in, -h.tokens_out, -h.cost_est_usd, 0, true,
       h.client_name, h.client_norm, h.session_id,
       -- v5.34.59: INHERITED from the hold, never defaulted. A release must
       -- cancel the row it compensates: a 'platform' release against a
       -- 'client_key' hold would leave a positive reservation on the invoice
       -- with nothing to cancel it, which is precisely the stranded-charge
       -- shape this sweep exists to clean up.
       h.payer, h.payer_key_hint
  FROM usage_events h
 WHERE h.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
   AND h.task = 'live_session_hold'
   AND h.session_id IS NOT NULL
   AND h.created_at < now() - make_interval(secs => $1::double precision)
   AND NOT EXISTS (
         SELECT 1 FROM usage_events r
          WHERE r.tenant_id = h.tenant_id
            AND r.session_id = h.session_id
            AND r.task = 'live_session_hold_release')
 ORDER BY h.session_id, h.created_at
ON CONFLICT DO NOTHING
RETURNING session_id, cost_est_usd;`;

/**
 * How old a hold must be before it cannot possibly belong to a live session.
 *
 * MAX_SESSION_SECONDS is the hard ceiling the ephemeral token is minted with
 * (expireTime), so Google itself closes the socket at that point — a hold
 * older than that has no session behind it. The grace margin is for clock skew
 * and for a close that is in flight as we look.
 */
export const SWEEP_GRACE_SECONDS = 600;
export const SWEEP_AGE_SECONDS = MAX_SESSION_SECONDS + SWEEP_GRACE_SECONDS;

/** The slice of a pg client this needs — same shape metering.ts uses. */
type PoolClientLike = {
  query: <R = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
};

export interface SweepResult {
  swept: number;
  releasedUsd: number;
  sessionIds: string[];
  failed?: string;
}

/**
 * Release every stale hold for the CURRENT tenant. The caller must already be
 * inside withTenant() — app.tenant_id is what the statement and the row-level
 * security policy both key on, and an unset tenant sweeps nothing rather than
 * sweeping everything.
 *
 * Never throws. A failure is reported in the result for logging and the
 * transaction is left usable.
 */
export async function sweepStaleHolds(
  c: PoolClientLike,
  ageSeconds: number = SWEEP_AGE_SECONDS
): Promise<SweepResult> {
  await c.query("SAVEPOINT vyne_sweep");
  try {
    const r = await c.query<{ session_id: string; cost_est_usd: string }>(SWEEP_SQL, [ageSeconds]);
    await c.query("RELEASE SAVEPOINT vyne_sweep");
    return {
      swept: r.rows.length,
      // The released rows are negative; report the magnitude that came off the
      // statement, which is the number a human wants to see in a log line.
      releasedUsd: -r.rows.reduce((a, row) => a + Number(row.cost_est_usd), 0),
      sessionIds: r.rows.map((row) => row.session_id),
    };
  } catch (err) {
    // ROLLBACK TO leaves the savepoint in place and the transaction healthy;
    // RELEASE afterwards drops it. Both are needed.
    await c.query("ROLLBACK TO SAVEPOINT vyne_sweep").catch(() => {});
    await c.query("RELEASE SAVEPOINT vyne_sweep").catch(() => {});
    return { swept: 0, releasedUsd: 0, sessionIds: [], failed: (err as Error).message };
  }
}
