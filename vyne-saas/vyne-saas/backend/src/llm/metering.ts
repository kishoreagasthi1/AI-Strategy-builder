/**
 * Metering sinks + plan-limit checks, backed by usage_events.
 * These rows are the raw material for billing later — do not lose them.
 */
import { withTenant } from "../db/pool.js";
import { normClient } from "../auth/clients.js";
import type { Meter, MeterEvent, LimitCheck } from "./gateway.js";

export const dbMeter: Meter = async (e: MeterEvent) => {
  await withTenant(e.tenantId, async (c) => {
    await c.query(
      `INSERT INTO usage_events
         (tenant_id, user_id, module, task, provider, model,
          tokens_in, tokens_out, cost_est_usd, latency_ms, ok,
          client_name, client_norm)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
export const dbLimitCheck: LimitCheck = async (tenantId: string) => {
  return withTenant(tenantId, async (c) => {
    // hashtextextended gives a stable 64-bit key from (tenant, month) so
    // the lock naturally rolls over each calendar month with the quota.
    await c.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || to_char(now(), 'YYYY-MM'), 0))`,
      [tenantId]
    );
    const res = await c.query<{ monthly_token_limit: string | null; used: string }>(
      `SELECT t.monthly_token_limit,
              COALESCE((SELECT SUM(tokens_in + tokens_out)
                          FROM usage_events u
                         WHERE u.tenant_id = t.id
                           AND u.created_at >= date_trunc('month', now())), 0) AS used
         FROM tenants t
        WHERE t.id = current_setting('app.tenant_id', true)::uuid`
    );
    const row = res.rows[0];
    if (!row || row.monthly_token_limit === null) return { allowed: true };
    const allowed = Number(row.used) < Number(row.monthly_token_limit);
    return allowed
      ? { allowed: true }
      : { allowed: false, reason: "monthly_token_limit_exceeded" };
  });
};
