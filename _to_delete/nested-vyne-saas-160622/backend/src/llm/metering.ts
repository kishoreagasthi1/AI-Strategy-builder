/**
 * Metering sinks + plan-limit checks, backed by usage_events.
 * These rows are the raw material for billing later — do not lose them.
 */
import { withTenant } from "../db/pool.js";
import { normClient } from "../auth/clients.js";
import { NON_BILLABLE_TASKS, MAX_SESSION_SECONDS, TASK_HOLD, TASK_HOLD_RELEASE, reserveTokensFor } from "./liveSession.js";
import { estimateCost } from "./types.js";
import type { Meter, MeterEvent, LimitCheck } from "./gateway.js";

/** The slice of a pg client these helpers need — keeps them usable with any
 *  connection the caller already has open inside a transaction. */
type PoolClientLike = { query: <R = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

export const dbMeter: Meter = async (e: MeterEvent) => {
  await withTenant(e.tenantId, async (c) => {
    await c.query(
      `INSERT INTO usage_events
         (tenant_id, user_id, module, task, provider, model,
          tokens_in, tokens_out, cost_est_usd, latency_ms, ok,
          client_name, client_norm, session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        e.tenantId,
        e.userId ?? null,
        e.module,
        e.task,
        e.provider,
        e.model,
        e.tokensIn,
        e.tokensOut,
        e.costEstUsd,
        e.latencyMs,
        e.ok,
        e.clientName ?? null,
        e.clientName ? normClient(e.clientName) : null,
        e.sessionId ?? null,
      ]
    );
  });
};

/**
 * Monthly token limit from tenants.monthly_token_limit (NULL = unlimited).
 * Simple and readable now; move to a cached counter if it ever gets hot.
 *
 * V225-audit MEDIUM note on a known TOCTOU race: this reads `used` and
 * decides `allowed` in one query, but the actual usage_events row for the
 * call this check is gating gets written LATER, by a separate transaction
 * (LlmGateway.generate()'s post-call safeMeter(), possibly seconds later
 * after the provider responds). N concurrent requests from the same tenant
 * can each read the same pre-call `used` value and all pass, overshooting
 * the limit by up to N calls' worth of tokens. A fully atomic fix needs a
 * reserve-then-commit budget (decrement an atomic counter before the call,
 * refund on failure) — a real schema/flow change, tracked as a follow-up
 * rather than done here.
 *
 * What IS done here: an advisory lock scoped to this tenant + calendar
 * month, held for the lifetime of this transaction. It serializes
 * concurrent limitCheck calls for the SAME tenant (each waits its turn to
 * read `used` rather than all reading it in parallel), which closes the
 * race for the most common real trigger — a user firing off several
 * requests in quick succession (double-clicks, multiple open tabs). It
 * does NOT close the race against the later metering write, since that
 * happens in a different transaction after this one has already committed
 * and released the lock — hence "narrows", not "closes", above.
 */
/**
 * Which usage rows count toward a spend cap — one definition, used by both the
 * monthly firm cap and the per-user daily cap.
 *
 * v5.32.63 (audit V2-CR-1). A live session writes a positive HOLD when it opens
 * and a negative RELEASE when it closes. Both are non-billable, and the aging
 * clause was applied to each ROW independently:
 *
 *   AND (NOT (task = ANY(...)) OR created_at > now() - window)
 *
 * The release is always newer than its hold, so a session held open longer than
 * the grant window closes into a state where the hold has aged OUT of the sum
 * and the negative release is still IN it. Each such session contributes about
 * minus 135,000 tokens, and they stack. Measured, not theorised: one aged
 * session took a tenant from 400 to −134,600; eight took it to −1,214,600.
 *
 * A negative sum makes `used >= limit` false, so the monthly firm cap and the
 * per-user daily cap both switch off — for every user in the tenant, not just
 * whoever caused it. The least-privileged role in the product can do it with
 * nothing but patience.
 *
 * The fix ages the PAIR, not the row. A session is aged out on the timestamp of
 * its FIRST non-billable row (its hold), and when it ages out BOTH halves leave
 * the sum together, netting to zero rather than to minus the whole grant. What
 * that session actually consumed is recorded separately as a billable row, so
 * nothing real is lost by dropping the pre-authorisation.
 *
 * The behaviour the clause was written for is preserved exactly: an abandoned
 * hold whose release never arrived still ages out and stops occupying the
 * budget, and a hold from a session that could still be running still counts,
 * because concurrent sessions must not each see a budget the others have
 * already claimed.
 *
 * Legacy rows carry no session_id — those keep the original per-row rule, which
 * is all that can be said about a row with nothing to pair it to.
 *
 * ── v5.32.83. The SECOND half of the same bug: the window boundary. ──
 *
 * Pairing a session by its first non-billable row only works if BOTH halves are
 * inside the accounting window. They are not, at a boundary. Both this CTE and
 * the sums that use it are scoped `created_at >= date_trunc(...)`, so a session
 * that opened at 23:52 and closed at 00:03 puts its positive hold in yesterday
 * and leaves the negative release ALONE in today. The CTE then sees one row for
 * that session, whose MIN(created_at) is the release — seconds old, therefore
 * NOT aged — so the release is judged live and counted, at minus the whole
 * grant.
 *
 * v5.32.77 clamped the total with GREATEST(..., 0) and reasoned that the
 * residual was "a new month briefly under-counting by one session's hold". It
 * is not. Clamping a negative subtotal to zero does not subtract one hold from
 * the total — it discards every REAL token in the window along with it. A
 * tenant genuinely over its cap reads as having spent nothing, and the cap is
 * off, for the whole first MAX_SESSION_SECONDS after each boundary. Measured
 * against real Postgres: 51,000 billable tokens against a 50,000 daily cap plus
 * one straddling release returned `{allowed: true}`. The clamp changed the
 * symptom (a negative number) and left the hole.
 *
 * The fix is the same principle as the v5.32.63 one, applied at the boundary:
 * a session whose non-billable rows net NEGATIVE inside the window is, by
 * definition, a fragment of a session whose opening row is somewhere else. It
 * cannot be spare capacity, so it does not count — the whole session drops out,
 * exactly as an aged one does. This needs no lookback outside the window and no
 * classification of which task names open versus close a session, so it holds
 * for the legacy reserve/refund pair too.
 *
 * The GREATEST clamp stays as a backstop, but nothing should now reach it.
 */
function excludedSessionsCte(tenantExpr: string, tasksParam: string, windowParam: string, sinceExpr: string): string {
  return `WITH excluded_sessions AS (
            SELECT session_id
              FROM usage_events
             WHERE tenant_id = ${tenantExpr}
               AND created_at >= ${sinceExpr}
               AND task = ANY(${tasksParam})
               AND session_id IS NOT NULL
             GROUP BY session_id
            HAVING MIN(created_at) <= now() - make_interval(secs => ${windowParam})
                OR SUM(tokens_in + tokens_out) < 0
          )`;
}

/** The predicate itself. `alias` is the usage_events alias in the outer query. */
function countsTowardCap(alias: string, tasksParam: string, windowParam: string): string {
  return `(NOT (${alias}.task = ANY(${tasksParam}))
           OR (${alias}.session_id IS NOT NULL
               AND ${alias}.session_id NOT IN (SELECT session_id FROM excluded_sessions))
           OR (${alias}.session_id IS NULL
               AND ${alias}.created_at > now() - make_interval(secs => ${windowParam})))`;
}

/**
 * The cap checks themselves, on a caller-supplied client.
 *
 * v5.32.65 (audit V2-H2). Split out of dbLimitCheck so the live-session open
 * path can run the concurrency count, the cap check and the reservation write
 * inside ONE transaction under ONE advisory lock. Previously those were three
 * separate transactions: two opens could both count the pre-existing state,
 * both pass, and both reserve — the code's own comment conceded the lock
 * "narrows, not closes" the race, because the reservation that would make a
 * new session visible to the next counter landed after the lock was gone.
 */
export async function capsCheckOn(
  c: PoolClientLike,
  userId?: string | null
): Promise<{ allowed: boolean; reason?: string }> {
/*
 * v5.32.77 SECURITY (external audit, proven against real Postgres).
 *
 * `used` is a count of tokens spent. It cannot legitimately be negative, and
 * yet it could go deeply negative — which read as unlimited headroom and
 * admitted every caller in the firm.
 *
 * The reserve-then-commit design writes a POSITIVE TASK_HOLD when a live
 * session is admitted and a NEGATIVE TASK_HOLD_RELEASE when it ends, so the two
 * net to zero. Both the aging CTE and this SUM are scoped by
 * `date_trunc('month', now())`. A session opened at 23:55 on the last day of a
 * month and closed at 00:05 leaves its positive hold in the OLD month and its
 * negative release ALONE in the new one. The auditor measured one straddling
 * session driving `used` to -135,000, and forty driving it to -5,400,000
 * against a 3,000,000 cap — "ALLOWED for entire firm".
 *
 * It fires organically for any legitimate session spanning midnight; no
 * attacker is required. The window is roughly the first MAX_SESSION_SECONDS
 * after each boundary — each month end for this cap, each midnight for the
 * daily one below — because the aging CTE then stops counting the straddling
 * session at all and the artifact clears itself.
 *
 * Clamped at zero rather than reworked into session-scoped windows. A negative
 * subtotal here is by definition an accounting artifact, and the only thing
 * that must never happen is reading one as spare capacity. The residual — a
 * new month briefly under-counting by one session's hold — is bounded, expires
 * with the aging window, and errs toward charging the firm less than they used
 * rather than toward letting them spend past their cap.
 */
    const res = await c.query<{
      monthly_token_limit: string | null; daily_user_token_limit: string | null; used: string;
    }>(
      `${excludedSessionsCte("current_setting('app.tenant_id', true)::uuid", "$1::text[]", "$2", "date_trunc('month', now())")}
        SELECT t.monthly_token_limit, t.daily_user_token_limit,
               GREATEST(COALESCE((SELECT SUM(tokens_in + tokens_out)
                           FROM usage_events u
                          WHERE u.tenant_id = t.id
                            AND u.created_at >= date_trunc('month', now())
                            AND ${countsTowardCap("u", "$1::text[]", "$2")}), 0), 0) AS used
          FROM tenants t
         WHERE t.id = current_setting('app.tenant_id', true)::uuid`,
      [NON_BILLABLE_TASKS, MAX_SESSION_SECONDS]
    );
    const row = res.rows[0];
    // v5.32.29 (audit CR-3). This early-returned `allowed` whenever the column
    // was NULL — and NOTHING ever set it, so the branch below was dead on
    // every tenant since the first deploy. Migration 012 gives the column a
    // value, a plan-derived backfill and a DEFAULT; provisioning and the
    // Stripe webhook now keep it current. A NULL that somehow survives all of
    // that is treated as the trial ceiling rather than as "unlimited", because
    // failing open on a spend cap is the wrong direction to fail in.
    if (!row) return { allowed: true };            // tenant row missing: not our call to make
    const monthly = row.monthly_token_limit === null ? 3_000_000 : Number(row.monthly_token_limit);
    if (Number(row.used) >= monthly) {
      return { allowed: false, reason: "monthly_token_limit_exceeded" };
    }

    // Per-user daily ceiling. The monthly cap bounds the firm's exposure over
    // a month; this bounds how fast any single account can consume it. The
    // realistic abuse case is an interviewee login — the least-privileged role
    // — driving the LLM endpoint in a loop, which without this can exhaust a
    // firm's whole allowance in an afternoon and deny service to the
    // consultants actually doing the work.
    if (userId) {
      const daily = Number(row.daily_user_token_limit ?? 500_000);
      if (daily > 0) {
        const u = await c.query<{ used: string }>(
          // v5.32.49. This sum used to have no task filter at all, while the
          // monthly sum above ages live-session holds out after no session
          // could still be alive. That asymmetry locked out a real account:
          //
          //   live_session_reserve  +1,755,000   (legacy partial-refund scheme)
          //   live_session_refund   −1,350,000
          //   live_session_hold        +75,000   (releases that never arrived)
          //   everything actually spent  21,590
          //   ────────────────────────────────
          //   counted against a 500,000 daily cap:  501,590 → denied
          //
          // 96% of that is accounting exhaust. The cap is meant to bound how
          // fast one account can spend the firm's allowance; a pre-authorisation
          // that was released, or one for a session that can no longer be
          // running, is not spend. Same predicate as the monthly sum on purpose
          // — two caps reading the same table disagreeing about what counts is
          // how this got shipped.
          `${excludedSessionsCte("current_setting('app.tenant_id', true)::uuid", "$2::text[]", "$3", "date_trunc('day', now())")}
           -- Clamped for the same reason as the monthly cap above: a session
           -- straddling midnight leaves an orphaned negative release here.
           SELECT GREATEST(COALESCE(SUM(u.tokens_in + u.tokens_out), 0), 0) AS used
             FROM usage_events u
            WHERE u.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND u.user_id = $1
              AND u.created_at >= date_trunc('day', now())
              AND ${countsTowardCap("u", "$2::text[]", "$3")}`,
          [userId, NON_BILLABLE_TASKS, MAX_SESSION_SECONDS]
        );
        if (Number(u.rows[0]?.used ?? 0) >= daily) {
          return { allowed: false, reason: "daily_user_token_limit_exceeded" };
        }
      }
    }
    return { allowed: true };
}

/** Serialise every budget decision for a tenant-month on one key. */
async function takeBudgetLock(c: PoolClientLike, tenantId: string): Promise<void> {
  await c.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || to_char(now(), 'YYYY-MM'), 0))`,
    [tenantId]
  );
}

export const dbLimitCheck: LimitCheck = async (tenantId: string, userId?: string | null) => {
  return withTenant(tenantId, async (c) => {
    await takeBudgetLock(c, tenantId);
    return capsCheckOn(c, userId);
  });
};


/**
 * Admit a live session: concurrency count, spend caps and the reservation
 * write, all in ONE transaction under ONE advisory lock.
 *
 * v5.32.65 (audit V2-H2). These were three separate transactions —
 * countRecentGrants, then gateway.checkLimit, then reserveSession — and the
 * write that makes a new session visible to the next counter landed after the
 * lock from the check had already been released. Two opens fired together both
 * counted the pre-existing state, both passed, and both reserved. The comment
 * in the old code conceded it: "narrows, not closes".
 *
 * Holding the lock across all three closes it. The lock key is the same
 * tenant-month key dbLimitCheck uses, so a live-session open and an ordinary
 * LLM budget check serialise against each other too — two callers cannot both
 * read the same `used` and both commit against it.
 *
 * The reservation is written here rather than by the caller for the same
 * reason: a reservation that commits outside the lock is exactly the race
 * being fixed.
 */
export async function admitLiveSession(args: {
  tenantId: string; userId: string; module: string; model: string;
  clientName?: string; sessionId: string; maxSeconds: number;
  maxConcurrent: number; openWindowSeconds: number;
  /**
   * v5.34.33 — the sessionId this grant CONTINUES, if any.
   *
   * Google ends a Live connection about every ten minutes, so one interview
   * needs a fresh grant per ten minutes of conversation: twelve for a
   * two-hour deep dive. Each of those looked like a brand-new session to the
   * concurrency guard, so a long interview raced its own cap and died
   * mid-sentence at the handover — the guard refusing the continuation of the
   * very session it had just admitted. That is not a runaway tab, which is
   * the only thing this guard exists to stop.
   *
   * A continuation is therefore exempt from the CONCURRENCY check only, and
   * only when the caller can name a hold this same user genuinely holds:
   * spend control (capsCheck) and the reservation below are untouched, so the
   * exemption cannot buy budget — it can only stop a live interview being cut
   * off by a nuisance counter. Naming someone else's session, or one outside
   * the window, is not a renewal and falls back to the normal check.
   */
  renewalOf?: string;
}): Promise<{ allowed: boolean; reason?: string; renewal?: boolean }> {
  return withTenant(args.tenantId, async (c) => {
    await takeBudgetLock(c, args.tenantId);

    // Concurrency: holds issued inside the window, minus their releases.
    const g = await c.query<{ n: string }>(
      `SELECT
         count(*) FILTER (WHERE task = $3) AS n,
         count(*) FILTER (WHERE task = $4) AS released
       FROM usage_events
        WHERE user_id = $1
          AND created_at > now() - make_interval(secs => $2)`,
      [args.userId, args.openWindowSeconds, TASK_HOLD, TASK_HOLD_RELEASE]
    );
    const row = g.rows[0] as unknown as { n: string; released: string };
    const open = Math.max(0, Number(row?.n ?? 0) - Number(row?.released ?? 0));

    let renewal = false;
    if (args.renewalOf && args.renewalOf !== args.sessionId) {
      const prior = await c.query(
        `SELECT 1 FROM usage_events
          WHERE user_id = $1 AND session_id = $2 AND task = $3
            AND created_at > now() - make_interval(secs => $4)
          LIMIT 1`,
        [args.userId, args.renewalOf, TASK_HOLD, Math.max(args.openWindowSeconds, MAX_SESSION_SECONDS)]
      );
      renewal = prior.rowCount === 1;
    }

    if (!renewal && open >= args.maxConcurrent) {
      return { allowed: false, reason: "too_many_live_sessions" };
    }

    const caps = await capsCheckOn(c, args.userId);
    if (!caps.allowed) return caps;

    const { tokensIn, tokensOut } = reserveTokensFor(args.maxSeconds);
    await c.query(
      `INSERT INTO usage_events
         (tenant_id, user_id, module, task, provider, model,
          tokens_in, tokens_out, cost_est_usd, latency_ms, ok,
          client_name, client_norm, session_id)
       VALUES ($1,$2,$3,$4,'gemini-live',$5,$6,$7,$8,0,true,$9,$10,$11)`,
      [
        args.tenantId, args.userId, args.module, TASK_HOLD, args.model,
        tokensIn, tokensOut, estimateCost(args.model, tokensIn, tokensOut),
        args.clientName ?? null,
        args.clientName ? normClient(args.clientName) : null,
        args.sessionId,
      ]
    );
    return { allowed: true, renewal };
  });
}
