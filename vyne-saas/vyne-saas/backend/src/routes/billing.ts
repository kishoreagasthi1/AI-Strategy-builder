/**
 * Client cost-recovery billing (v5.27).
 *
 * The firm passes AI usage cost straight through to its own clients — no
 * markup, no margin logic. usage_events already records the real cost of
 * every LLM/TTS/transcription call (metering.ts's doc comment: "these rows
 * are the raw material for billing later"); migration 007 added
 * client_name/client_norm so those rows can be split per client.
 *
 *   GET /api/billing/summary               — per-client totals (dashboard)
 *   GET /api/billing/statement?client=...   — one client's line items (export)
 *
 * Client scoping matches scorecard.ts / every other client-scoped module:
 * owners see everything (including the "unattributed" bucket — calls made
 * with no client selected, e.g. cross-client admin work); consultants only
 * see clients they're assigned to (client_assignments) and never the
 * unattributed bucket, since it can hold other consultants' activity too.
 *
 * Deliberately NOT billed (see routes/synthetic.ts): persona-preview and
 * synthetic-engagement-generation calls never carry a clientName, so they
 * never appear here — sandbox/QA work, not real client work.
 *
 * Pre-existing gap this inherits (not introduced here): TTS cost is always
 * metered as $0 (routes/voice.ts's tts handler hard-codes costEstUsd: 0 —
 * Gemini TTS pricing was never wired in). A statement for a voice-heavy
 * interview will under-report true cost until that's fixed separately.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { allowedClientNorms, clientAllowed, normClient } from "../auth/clients.js";

/** Sentinel bucket key for calls with no client attribution at all. */
export const UNATTRIBUTED = "__unattributed__";

export interface UsageEventLite {
  clientName: string | null;
  clientNorm: string | null;
  module: string;
  task: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costEstUsd: number;
  ok: boolean;
  createdAt: string; // ISO
}

export interface BillingClientSummary {
  /** normClient(name), or UNATTRIBUTED for the no-client bucket. */
  clientNorm: string;
  /** Display name — null only for the unattributed bucket. */
  clientName: string | null;
  callCount: number;
  tokensIn: number;
  tokensOut: number;
  costEstUsd: number;
  lastActivity: string | null;
}

/**
 * Pure aggregation — testable without the DB. Only successful calls (ok)
 * are billed: a failed attempt's cost is always metered as $0 (gateway.ts),
 * so including it would add a zero-cost line with nothing to show for it.
 */
export function buildBillingSummary(events: UsageEventLite[]): BillingClientSummary[] {
  const byNorm = new Map<string, BillingClientSummary>();
  for (const e of events) {
    if (!e.ok) continue;
    const key = e.clientNorm ?? UNATTRIBUTED;
    let entry = byNorm.get(key);
    if (!entry) {
      entry = {
        clientNorm: key,
        clientName: e.clientNorm ? e.clientName : null,
        callCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        costEstUsd: 0,
        lastActivity: null,
      };
      byNorm.set(key, entry);
    }
    entry.callCount += 1;
    entry.tokensIn += e.tokensIn;
    entry.tokensOut += e.tokensOut;
    entry.costEstUsd = round6(entry.costEstUsd + e.costEstUsd);
    if (!entry.lastActivity || e.createdAt > entry.lastActivity) entry.lastActivity = e.createdAt;
  }
  const out = [...byNorm.values()];
  out.sort((a, b) => {
    if (a.clientNorm === UNATTRIBUTED) return 1;
    if (b.clientNorm === UNATTRIBUTED) return -1;
    return (a.clientName ?? "").localeCompare(b.clientName ?? "");
  });
  return out;
}

export interface BillingLineItem {
  createdAt: string;
  module: string;
  task: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costEstUsd: number;
}

export interface BillingStatement {
  lineItems: BillingLineItem[];
  callCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
}

/** Pure aggregation for one client's exportable statement. */
export function buildBillingStatement(events: UsageEventLite[]): BillingStatement {
  const lineItems = events
    .filter((e) => e.ok)
    .map((e) => ({
      createdAt: e.createdAt,
      module: e.module,
      task: e.task,
      provider: e.provider,
      model: e.model,
      tokensIn: e.tokensIn,
      tokensOut: e.tokensOut,
      costEstUsd: e.costEstUsd,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    lineItems,
    callCount: lineItems.length,
    totalTokensIn: lineItems.reduce((s, i) => s + i.tokensIn, 0),
    totalTokensOut: lineItems.reduce((s, i) => s + i.tokensOut, 0),
    totalCostUsd: round6(lineItems.reduce((s, i) => s + i.costEstUsd, 0)),
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// V228-audit fix: this used to accept any 1-40 char string and rely on the
// DB call's catch block to report bad input — which meant a genuine query
// failure (wrong DB permissions, a missing column, a connection error) got
// mislabeled "invalid_date_range" too, hiding the real cause. Validating
// the shape here means a 400 from this schema really is a bad date, and
// anything that fails past this point is a real server error (500).
const isoDateish = z
  .string()
  .min(1)
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "not a parseable date" });

const RangeQuery = z.object({
  from: isoDateish.optional(),
  to: isoDateish.optional(),
});

const StatementQuery = RangeQuery.extend({
  client: z.string().min(1).max(200),
});

async function fetchUsageEvents(
  tenantId: string,
  from: string | undefined,
  to: string | undefined
): Promise<UsageEventLite[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query<{
      client_name: string | null;
      client_norm: string | null;
      module: string;
      task: string;
      provider: string;
      model: string;
      tokens_in: number;
      tokens_out: number;
      cost_est_usd: string;
      ok: boolean;
      created_at: string;
    }>(
      `SELECT client_name, client_norm, module, task, provider, model,
              tokens_in, tokens_out, cost_est_usd, ok, created_at
         FROM usage_events
        WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
          AND ($2::timestamptz IS NULL OR created_at <  $2::timestamptz)
        ORDER BY created_at ASC`,
      [from ?? null, to ?? null]
    );
    return r.rows.map((row) => ({
      clientName: row.client_name,
      clientNorm: row.client_norm,
      module: row.module,
      task: row.task,
      provider: row.provider,
      model: row.model,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      costEstUsd: Number(row.cost_est_usd),
      ok: row.ok,
      createdAt: row.created_at,
    }));
  });
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/billing/summary", async (req, reply) => {
    const ctx = req.ctx!;
    if (ctx.role === "interviewee") { reply.code(403).send({ error: "forbidden" }); return; }
    const q = RangeQuery.safeParse(req.query);
    if (!q.success) { reply.code(400).send({ error: "invalid_input" }); return; }

    const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
    let events: UsageEventLite[];
    try {
      events = await fetchUsageEvents(ctx.tenantId, q.data.from, q.data.to);
    } catch (err) {
      // V228-audit fix: from/to already passed isoDateish validation above,
      // so a failure here is NOT a bad date range — it's a real query
      // failure (missing migration, DB permissions, connection issue).
      // Reporting it as 400 invalid_date_range actively hid the true cause
      // in production once already. 500 + full server-side log detail.
      req.log.error({ err }, "billing summary: query failed");
      reply.code(500).send({ error: "billing_query_failed" });
      return;
    }
    // Deny by default: a restricted consultant sees only their assigned
    // clients' rows, never another client's and never the unattributed bucket.
    const scoped = allowed === null ? events : events.filter((e) => e.clientNorm !== null && allowed.has(e.clientNorm));
    return { clients: buildBillingSummary(scoped), from: q.data.from ?? null, to: q.data.to ?? null };
  });

  app.get("/api/billing/statement", async (req, reply) => {
    const ctx = req.ctx!;
    if (ctx.role === "interviewee") { reply.code(403).send({ error: "forbidden" }); return; }
    const q = StatementQuery.safeParse(req.query);
    if (!q.success) { reply.code(400).send({ error: "invalid_input" }); return; }

    const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
    if (!clientAllowed(allowed, q.data.client)) {
      reply.code(403).send({ error: "client_not_assigned" });
      return;
    }
    const norm = normClient(q.data.client);
    let events: UsageEventLite[];
    try {
      events = await fetchUsageEvents(ctx.tenantId, q.data.from, q.data.to);
    } catch (err) {
      req.log.error({ err }, "billing statement: query failed");
      reply.code(500).send({ error: "billing_query_failed" });
      return;
    }
    const clientEvents = events.filter((e) => e.clientNorm === norm);
    const statement = buildBillingStatement(clientEvents);
    return { client: q.data.client, from: q.data.from ?? null, to: q.data.to ?? null, ...statement };
  });
}
