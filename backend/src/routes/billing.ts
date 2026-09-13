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
import { NON_BILLABLE_TASKS } from "../llm/liveSession.js";
import { withTenant } from "../db/pool.js";
import { allowedClientNorms, clientAllowed, normClient, normSetHas } from "../auth/clients.js";

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
  /**
   * v5.34.59 — "client_key" means the CLIENT's own credential paid the vendor
   * directly and this cost is NOT the firm's to recover. Absent/"platform" is
   * every row written before BYOK spent anything, and every call on the firm's
   * own keys.
   */
  payer?: string | null;
}

/** A cost the client has already paid on their own account. */
function isClientPaid(e: UsageEventLite): boolean {
  return e.payer === "client_key";
}

export interface BillingClientSummary {
  /** normClient(name), or UNATTRIBUTED for the no-client bucket. */
  clientNorm: string;
  /** Display name — null only for the unattributed bucket. */
  clientName: string | null;
  callCount: number;
  tokensIn: number;
  tokensOut: number;
  /**
   * What the firm may invoice this client: the cost of work that ran on the
   * FIRM's credentials. Work the client's own key paid for is excluded — see
   * clientPaidUsd.
   */
  costEstUsd: number;
  /**
   * What the client already paid their vendor directly, on their own key
   * (v5.34.59). Shown so the engagement's true cost is visible, and kept out
   * of costEstUsd so it can never reach an invoice. Zero for every client who
   * has not supplied a key, which is most of them.
   */
  clientPaidUsd: number;
  lastActivity: string | null;
}

/**
 * Pure aggregation — testable without the DB. Only successful calls (ok)
 * are billed: a failed attempt's cost is always metered as $0 (gateway.ts),
 * so including it would add a zero-cost line with nothing to show for it.
 *
 * v5.34.59: cost is now split by PAYER. A client running on their own key has
 * already been charged by Google or Anthropic; adding that to the firm's
 * invoice would bill them twice for the same tokens. The tokens still count in
 * tokensIn/tokensOut, because the work happened and the firm needs to see it.
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
        clientPaidUsd: 0,
        lastActivity: null,
      };
      byNorm.set(key, entry);
    }
    entry.callCount += 1;
    entry.tokensIn += e.tokensIn;
    entry.tokensOut += e.tokensOut;
    if (isClientPaid(e)) {
      entry.clientPaidUsd = round6(entry.clientPaidUsd + e.costEstUsd);
    } else {
      entry.costEstUsd = round6(entry.costEstUsd + e.costEstUsd);
    }
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
  /**
   * True when this line ran on the CLIENT's own credential and is therefore
   * NOT part of what the firm is invoicing (v5.34.59). Kept as a visible line
   * rather than dropped: the client can see the work happened, and can
   * reconcile it against their own Google or Anthropic bill.
   */
  clientPaid?: boolean;
}

export interface BillingStatement {
  lineItems: BillingLineItem[];
  callCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  /** The invoice total — firm-paid work only. */
  totalCostUsd: number;
  /** Already paid by the client on their own key. Never part of the invoice. */
  clientPaidUsd: number;
}

/**
 * Pure aggregation for one client's exportable statement.
 *
 * v5.34.59: totalCostUsd is the amount to invoice and excludes anything the
 * client's own key paid for. The excluded lines stay in lineItems, flagged, so
 * the statement remains a complete record of the work rather than a partial one
 * that quietly omits half an engagement.
 */
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
      ...(isClientPaid(e) ? { clientPaid: true } : {}),
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    lineItems,
    callCount: lineItems.length,
    totalTokensIn: lineItems.reduce((s, i) => s + i.tokensIn, 0),
    totalTokensOut: lineItems.reduce((s, i) => s + i.tokensOut, 0),
    totalCostUsd: round6(
      lineItems.filter((i) => !i.clientPaid).reduce((s, i) => s + i.costEstUsd, 0)
    ),
    clientPaidUsd: round6(
      lineItems.filter((i) => i.clientPaid).reduce((s, i) => s + i.costEstUsd, 0)
    ),
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
      payer: string | null;
    }>(
      /*
       * v5.32.58 SCALE. `from`/`to` are optional, so with no query parameters
       * this selected EVERY metered call the firm had ever made — one row per
       * LLM, TTS and transcription request — and aggregated them in JavaScript.
       * A firm working through a 20M-token plan generates tens of thousands of
       * rows a month; the heap spike and the connection held for the length of
       * the scan are both avoidable.
       *
       * The default window is THIRTEEN MONTHS, not the current one. A tighter
       * default was the first attempt and it was wrong for the same reason
       * half this release is: it silently hid data. A firm opening a statement
       * for a client whose engagement finished in January would have seen an
       * empty statement in August, with nothing saying why — a quiet omission
       * dressed up as a fact, which is the failure mode being hunted here.
       *
       * Thirteen months covers every billing question anyone actually asks
       * (this month, last month, the year, the same month last year) while
       * still bounding the scan. A caller who wants more passes `from`.
       */
      `SELECT client_name, client_norm, module, task, provider, model,
              tokens_in, tokens_out, cost_est_usd, ok, created_at, payer
         FROM usage_events
        WHERE NOT (task = ANY($3::text[]))
          AND created_at >= COALESCE($1::timestamptz, now() - interval '13 months')
          AND ($2::timestamptz IS NULL OR created_at <  $2::timestamptz)
        ORDER BY created_at ASC
        LIMIT 200000`,
      [from ?? null, to ?? null, NON_BILLABLE_TASKS]
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
      payer: row.payer,
      // node-postgres parses `timestamptz` columns into a JS Date object by
      // default, NOT a string — despite this query's row type (and
      // UsageEventLite.createdAt) declaring it as `string`. That mismatch
      // was silent almost everywhere downstream (buildBillingSummary
      // compares with `>`, which works fine on Date objects; JSON.stringify
      // serializes a Date to an ISO string automatically), but
      // buildBillingStatement's `.sort((a,b) => a.createdAt.localeCompare(...))`
      // calls a String-only method — `Date.prototype.localeCompare` doesn't
      // exist, so it threw a TypeError for any client with 2+ billable
      // calls (a `.sort()` comparator is never invoked for 0- or 1-item
      // arrays, which is exactly why this passed the original tests, each
      // client having exactly one seeded row). The exception escaped this
      // function's caller with no try/catch around it, past
      // routes/billing.ts's own error handling, straight to the generic
      // "internal_error" 500 — reported live as "View statement" failing.
      // Normalizing to an ISO string right at the DB boundary makes every
      // downstream consumer able to trust the type it's already declared.
      createdAt: new Date(row.created_at).toISOString(),
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
    const scoped = allowed === null
      ? events
      // normSetHas, not allowed.has: a usage_events row written before the
      // v5.32.26 norm widening still carries the 30-char norm until
      // migration 011 runs, and a consultant must still see their own line.
      : events.filter((e) => e.clientNorm !== null && normSetHas(allowed, e.clientNorm));
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
