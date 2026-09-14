/**
 * Metering sinks + plan-limit checks, backed by usage_events.
 * These rows are the raw material for billing later — do not lose them.
 */
import { withTenant } from "../db/pool.js";
import type { Meter, MeterEvent, LimitCheck } from "./gateway.js";

export const dbMeter: Meter = async (e: MeterEvent) => {
  await withTenant(e.tenantId, async (c) => {
    await c.query(
      `INSERT INTO usage_events
         (tenant_id, user_id, module, task, provider, model,
          tokens_in, tokens_out, cost_est_usd, latency_ms, ok)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
      ]
    );
  });
};

/**
 * Monthly token limit from tenants.monthly_token_limit (NULL = unlimited).
 * Simple and readable now; move to a cached counter if it ever gets hot.
 */
export const dbLimitCheck: LimitCheck = async (tenantId: string) => {
  return withTenant(tenantId, async (c) => {
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
