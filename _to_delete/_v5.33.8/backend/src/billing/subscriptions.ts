/**
 * SaaS subscription billing (v5.30) — business logic sitting between
 * routes/subscriptions.ts and the injectable StripeClient (stripeClient.ts).
 *
 * tenants.plan / monthly_token_limit / subscription_status / stripe_* are
 * all read/written here via withoutTenant() — the tenants table has no
 * tenant_id column of its own to RLS-scope on (it IS the tenant), the same
 * trust boundary tenant/provisioning.ts and routes/assignments.ts's
 * memberByEmail() already rely on for this exact table.
 *
 * Webhook idempotency: every handler here overwrites tenant columns to the
 * latest known state rather than incrementing/appending anything, so
 * processing the same Stripe event twice (Stripe retries on non-2xx, and
 * can send near-duplicate events around a single lifecycle change) is
 * harmless — no dedupe table needed.
 */
import type Stripe from "stripe";
import { withoutTenant } from "../db/pool.js";
import { auditLog } from "../audit/log.js";
import type { LimitCheck } from "../llm/gateway.js";
import type { StripeClient, StripeWebhookEvent } from "./stripeClient.js";

export interface PlanView {
  key: string;
  name: string;
  monthlyPriceUsd: number | null;
  purchasable: boolean;
  /** false when an operator hasn't set a real Stripe Price ID yet — the
   *  frontend should show the plan but disable "Subscribe". */
  configured: boolean;
}

export interface TenantSubscriptionView {
  planKey: string;
  planName: string | null;
  subscriptionStatus: string;
  currentPeriodEnd: string | null; // ISO
  cancelAtPeriodEnd: boolean;
  hasStripeCustomer: boolean;
}

export async function listPlans(): Promise<PlanView[]> {
  return withoutTenant(async (c) => {
    const r = await c.query<{
      key: string; name: string; monthly_price_usd: string | null;
      stripe_price_id: string | null; is_purchasable: boolean;
    }>(`SELECT key, name, monthly_price_usd, stripe_price_id, is_purchasable
          FROM subscription_plans ORDER BY sort_order`);
    return r.rows.map((row) => ({
      key: row.key,
      name: row.name,
      monthlyPriceUsd: row.monthly_price_usd === null ? null : Number(row.monthly_price_usd),
      purchasable: row.is_purchasable,
      configured: row.stripe_price_id !== null,
    }));
  });
}

export async function getTenantSubscription(tenantId: string): Promise<TenantSubscriptionView> {
  return withoutTenant(async (c) => {
    const r = await c.query<{
      plan: string; subscription_status: string; current_period_end: string | null;
      cancel_at_period_end: boolean; stripe_customer_id: string | null; plan_name: string | null;
    }>(
      `SELECT t.plan, t.subscription_status, t.current_period_end, t.cancel_at_period_end,
              t.stripe_customer_id, p.name AS plan_name
         FROM tenants t
         LEFT JOIN subscription_plans p ON p.key = t.plan
        WHERE t.id = $1`,
      [tenantId]
    );
    const row = r.rows[0];
    if (!row) throw new Error("tenant_not_found");
    return {
      planKey: row.plan,
      planName: row.plan_name,
      subscriptionStatus: row.subscription_status,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      hasStripeCustomer: row.stripe_customer_id !== null,
    };
  });
}

export class SubscriptionError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function startCheckout(
  stripe: StripeClient,
  tenantId: string,
  planKey: string,
  ownerEmail: string,
  ownerName: string,
  successUrl: string,
  cancelUrl: string
): Promise<{ url: string }> {
  const plan = await withoutTenant(async (c) => {
    const r = await c.query<{ stripe_price_id: string | null; is_purchasable: boolean }>(
      `SELECT stripe_price_id, is_purchasable FROM subscription_plans WHERE key = $1`, [planKey]
    );
    return r.rows[0];
  });
  if (!plan || !plan.is_purchasable) throw new SubscriptionError("unknown_plan", "No such purchasable plan.");
  if (!plan.stripe_price_id) throw new SubscriptionError("plan_not_configured", "This plan has no Stripe price configured yet — set one in subscription_plans before offering it for checkout.");

  const existingCustomerId = await withoutTenant(async (c) => {
    const r = await c.query<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`, [tenantId]
    );
    return r.rows[0]?.stripe_customer_id ?? null;
  });

  const customerId = await stripe.ensureCustomer({
    existingCustomerId, email: ownerEmail, name: ownerName, tenantId,
  });
  if (customerId !== existingCustomerId) {
    await withoutTenant(async (c) => {
      await c.query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [customerId, tenantId]);
    });
  }

  const { url } = await stripe.createCheckoutSession({
    customerId, priceId: plan.stripe_price_id, successUrl, cancelUrl,
    metadata: { tenantId, planKey },
  });
  if (!url) throw new SubscriptionError("checkout_failed", "Stripe did not return a checkout URL.");
  await auditLog(tenantId, null, "subscription_checkout_started", { planKey });
  return { url };
}

export async function startPortal(
  stripe: StripeClient,
  tenantId: string,
  returnUrl: string
): Promise<{ url: string }> {
  const customerId = await withoutTenant(async (c) => {
    const r = await c.query<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`, [tenantId]
    );
    return r.rows[0]?.stripe_customer_id ?? null;
  });
  if (!customerId) throw new SubscriptionError("no_subscription", "No billing account yet — subscribe to a plan first.");
  return stripe.createPortalSession(customerId, returnUrl);
}

function toIso(unixSeconds: number | null): string | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000).toISOString();
}

/** Resolve which tenant a subscription-lifecycle event belongs to: prefer
 *  the metadata stamped at checkout, fall back to the stripe_customer_id
 *  we stored — covers events Stripe sends without echoing metadata back. */
async function resolveTenantId(metadataTenantId: string | null, customerId: string | null): Promise<string | null> {
  if (metadataTenantId) return metadataTenantId;
  if (!customerId) return null;
  return withoutTenant(async (c) => {
    const r = await c.query<{ id: string }>(`SELECT id FROM tenants WHERE stripe_customer_id = $1`, [customerId]);
    return r.rows[0]?.id ?? null;
  });
}

/** Look up subscription_plans.key by stripe_price_id — lets the webhook
 *  keep tenants.plan in sync even if the price was changed from the Stripe
 *  dashboard rather than through our checkout flow. */
async function planKeyForPrice(priceId: string | null): Promise<string | null> {
  if (!priceId) return null;
  return withoutTenant(async (c) => {
    const r = await c.query<{ key: string }>(`SELECT key FROM subscription_plans WHERE stripe_price_id = $1`, [priceId]);
    return r.rows[0]?.key ?? null;
  });
}

/**
 * V225-audit billing Low fix: Stripe does not guarantee webhook delivery
 * order (retries, multiple endpoints, network jitter can all reorder
 * events). Without a check, a delayed older event arriving AFTER a newer
 * one already applied could momentarily overwrite subscription_status with
 * stale data — self-correcting once the newer event's retry lands, but a
 * real (if narrow) window. The two subscription-lifecycle branches below
 * fold a guard directly into their UPDATE's WHERE clause: the update only
 * applies when the incoming event's own `created` timestamp is at least as
 * new as the last one this tenant recorded (migration 010's
 * stripe_last_event_at), and that column is bumped atomically in the same
 * statement — no separate read-then-write race.
 */
export async function applyWebhookEvent(stripe: StripeClient, event: StripeWebhookEvent): Promise<void> {
  const eventCreated = event.raw.created; // unix seconds, set by Stripe
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.raw.data.object as Stripe.Checkout.Session;
      const tenantId = (session.metadata && session.metadata.tenantId) || session.client_reference_id;
      const planKey = session.metadata && session.metadata.planKey;
      if (!tenantId) return; // nothing we can attribute this to
      /*
       * v5.32.65 (audit V2-L2). `applied` rather than a bare await: the WHERE
       * below can match nothing when a newer event already landed, and the
       * audit row was written regardless. That produced an audit trail saying
       * the firm was moved onto a plan it was never moved onto — the one record
       * whose job is to be trustworthy, disagreeing with the tenants row it
       * describes. The other two branches already returned early on a stale
       * event; this one now agrees with them.
       */
      const applied = await withoutTenant(async (c) => {
        const res = await c.query(
          // v5.32.29 (audit CR-3): the plan moved and the spend cap did not,
          // because nothing ever wrote it. Both move together now.
          /*
           * v5.32.58: the out-of-order guard, which the other two lifecycle
           * branches have and this one did not.
           *
           * Stripe retries and can deliver out of order. Without the guard, a
           * delayed checkout.session.completed landing AFTER a
           * customer.subscription.updated downgrade re-applied the old plan and
           * the old, higher spend ceiling — and nothing corrected it, because
           * no further event was coming. A firm keeps a Sprint-tier token cap
           * on a Starter subscription indefinitely.
           *
           * Same predicate and the same stamp as the other branches, so all
           * three now agree about what "newer" means.
           */
          `UPDATE tenants SET
             stripe_customer_id = COALESCE($2, stripe_customer_id),
             stripe_subscription_id = COALESCE($3, stripe_subscription_id),
             plan = COALESCE($4, plan),
             monthly_token_limit = COALESCE(
               (SELECT monthly_token_limit FROM subscription_plans WHERE key = COALESCE($4, tenants.plan)),
               monthly_token_limit),
             stripe_last_event_at = to_timestamp($5)
           WHERE id = $1
             AND (stripe_last_event_at IS NULL OR stripe_last_event_at <= to_timestamp($5))`,
          [
            tenantId,
            typeof session.customer === "string" ? session.customer : session.customer?.id ?? null,
            typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null,
            planKey ?? null,
            eventCreated,
          ]
        );
        return (res.rowCount ?? 0) > 0;
      });
      if (!applied) return; // a newer event already landed — this one is stale
      await auditLog(tenantId, null, "subscription_checkout_completed", { planKey: planKey ?? null });
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.raw.data.object as Stripe.Subscription;
      const snap = stripe.snapshotSubscription(sub);
      const tenantId = await resolveTenantId(snap.tenantId, snap.customerId);
      if (!tenantId) return;
      const resolvedPlanKey = await planKeyForPrice(snap.priceId);
      const applied = await withoutTenant(async (c) => {
        const res = await c.query(
          `UPDATE tenants SET
             stripe_subscription_id = $2,
             subscription_status = $3,
             current_period_end = $4,
             cancel_at_period_end = $5,
             plan = COALESCE($6, plan),
             monthly_token_limit = COALESCE(
               (SELECT monthly_token_limit FROM subscription_plans WHERE key = COALESCE($6, tenants.plan)),
               monthly_token_limit),
             stripe_last_event_at = to_timestamp($7)
           WHERE id = $1
             AND (stripe_last_event_at IS NULL OR stripe_last_event_at <= to_timestamp($7))`,
          [tenantId, snap.id, snap.status, toIso(snap.currentPeriodEnd), snap.cancelAtPeriodEnd, resolvedPlanKey, eventCreated]
        );
        return (res.rowCount ?? 0) > 0;
      });
      if (!applied) return; // a newer event already landed — this one is stale, ignore it
      await auditLog(tenantId, null, "subscription_status_changed", { status: snap.status, planKey: resolvedPlanKey });
      return;
    }

    case "customer.subscription.deleted": {
      const sub = event.raw.data.object as Stripe.Subscription;
      const snap = stripe.snapshotSubscription(sub);
      const tenantId = await resolveTenantId(snap.tenantId, snap.customerId);
      if (!tenantId) return;
      /*
       * v5.32.65 (audit V2-L1). This used to move the STATUS and nothing else,
       * leaving `plan` and `monthly_token_limit` at whatever tier the firm had
       * been paying for. A cancelled CAIO firm kept a 200,000,000-token monthly
       * allowance, permanently — and STRIPE_ENFORCE_PAYWALL is off by default,
       * so `subscription_status = 'canceled'` was, on its own, decorative. The
       * entitlement has to travel with the subscription in both directions;
       * every other branch already moves the limit with the plan.
       *
       * Reset to 'trial' rather than to zero: cancelling should return a firm
       * to the unpaid tier the product already defines (tenants.plan DEFAULTs
       * to it), not lock them out of data they own. The limit is read from
       * subscription_plans so there is one place that decides what a tier is
       * worth, and COALESCE keeps the current value if that row were ever
       * missing rather than writing NULL, which this schema reads as UNLIMITED.
       */
      const applied = await withoutTenant(async (c) => {
        const res = await c.query(
          `UPDATE tenants SET
             subscription_status = 'canceled',
             cancel_at_period_end = false,
             plan = 'trial',
             monthly_token_limit = COALESCE(
               (SELECT monthly_token_limit FROM subscription_plans WHERE key = 'trial'),
               monthly_token_limit),
             stripe_last_event_at = to_timestamp($2)
           WHERE id = $1
             AND (stripe_last_event_at IS NULL OR stripe_last_event_at <= to_timestamp($2))`,
          [tenantId, eventCreated]
        );
        return (res.rowCount ?? 0) > 0;
      });
      if (!applied) return;
      await auditLog(tenantId, null, "subscription_canceled", { revertedToPlan: "trial" });
      return;
    }

    default:
      return; // not a lifecycle event we track — ignored, not an error
  }
}

/**
 * The paywall: gates LLM usage on having a live subscription. Composed
 * with the existing token-quota dbLimitCheck (metering.ts) rather than
 * replacing it — see index.ts, the only place this is wired in.
 *
 * OFF unless config.stripeEnforcePaywall (STRIPE_ENFORCE_PAYWALL=1) is set
 * — every tenant provisioned before this feature existed defaults to
 * subscription_status='trialing' with no current_period_end, and turning
 * this on with no grace period would instantly lock all of them out.
 * With it on:
 *   - 'active'                                            → allowed
 *   - 'trialing' with a real Stripe trial period (current_period_end set,
 *     e.g. a Checkout session created with a trial) → allowed until it ends
 *   - 'trialing' with no Stripe data yet (the default state for a tenant
 *     that has never started checkout) → allowed for trialDays from
 *     tenants.created_at, the pre-Stripe grace period
 *   - anything else (past_due, canceled, incomplete, unpaid, or an expired
 *     trial in either shape above) → blocked
 */
/**
 * Compose the paywall gate with the token caps.
 *
 * v5.32.63 (audit V2-H1). index.ts built this inline as
 *
 *   async (tenantId) => { const gate = await ...(tenantId);
 *                         return gate.allowed ? dbLimitCheck(tenantId) : gate; }
 *
 * — one parameter. LimitCheck takes TWO, and dbLimitCheck's entire per-user
 * daily-cap block is gated on `if (userId)`. So turning the paywall on, which
 * is the intended production posture, silently switched the daily cap off for
 * every user in every firm. The monthly cap kept working, which is what made it
 * survive: spend was still bounded, just not per-person, so one account could
 * drain the firm's whole month in an afternoon and deny service to the
 * consultants doing the actual work.
 *
 * Tests never saw it because they run with the paywall OFF, where dbLimitCheck
 * is used directly and does receive userId — the daily cap passed its own tests
 * while being bypassed in production.
 *
 * Exported and composed here rather than assembled inline in index.ts so it can
 * be tested at all.
 */
export function withSubscriptionGate(gate: LimitCheck, inner: LimitCheck): LimitCheck {
  return async (tenantId, userId) => {
    const verdict = await gate(tenantId, userId);
    return verdict.allowed ? inner(tenantId, userId) : verdict;
  };
}

export function makeSubscriptionLimitCheck(trialDays: number): LimitCheck {
  return async (tenantId: string) => {
    const row = await withoutTenant(async (c) => {
      const r = await c.query<{
        subscription_status: string; current_period_end: string | null; created_at: string;
      }>(`SELECT subscription_status, current_period_end, created_at FROM tenants WHERE id = $1`, [tenantId]);
      return r.rows[0];
    });
    if (!row) return { allowed: false, reason: "tenant_not_found" };
    if (row.subscription_status === "active") return { allowed: true };
    if (row.subscription_status === "trialing") {
      if (row.current_period_end) {
        return new Date(row.current_period_end).getTime() > Date.now()
          ? { allowed: true }
          : { allowed: false, reason: "trial_expired" };
      }
      const trialEndsAt = new Date(row.created_at).getTime() + trialDays * 24 * 60 * 60 * 1000;
      return trialEndsAt > Date.now()
        ? { allowed: true }
        : { allowed: false, reason: "trial_expired" };
    }
    return { allowed: false, reason: `subscription_${row.subscription_status}` };
  };
}
