/**
 * Thin injectable wrapper over the Stripe SDK (v5.30 — SaaS subscription
 * billing: what TENANT FIRMS pay to use VYNE itself. Distinct from
 * routes/billing.ts, which is the firm passing its own AI usage cost
 * through to ITS clients).
 *
 * Same DI shape as ProviderAdapter/TokenVerifier/Meter elsewhere in this
 * codebase: a narrow interface the rest of the app depends on, a real
 * implementation that wraps the third-party SDK, and — in tests — a fake
 * that implements the same interface with no network calls. Only the exact
 * calls subscriptions.ts needs are exposed; nothing here leaks the raw
 * Stripe SDK type into route/business logic.
 */
import Stripe from "stripe";

export interface StripeCheckoutParams {
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  /** Carried on both the Session and the resulting Subscription so the
   *  webhook handler can always resolve which tenant this belongs to, even
   *  from an event that only carries a Stripe customer id. */
  metadata: { tenantId: string; planKey: string };
}

export interface StripeSubscriptionSnapshot {
  id: string;
  status: string;
  currentPeriodEnd: number | null; // unix seconds
  cancelAtPeriodEnd: boolean;
  priceId: string | null;
  tenantId: string | null; // from subscription metadata, if set
  customerId: string;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  raw: Stripe.Event;
}

export interface StripeClient {
  /** Finds or creates the one Stripe Customer for a tenant. */
  ensureCustomer(opts: { existingCustomerId: string | null; email: string; name: string; tenantId: string }): Promise<string>;
  createCheckoutSession(params: StripeCheckoutParams): Promise<{ url: string | null }>;
  createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }>;
  /** Throws if the signature doesn't verify — callers must reject the request (400), never process an unverified body. */
  constructWebhookEvent(rawBody: Buffer, signature: string, webhookSecret: string): StripeWebhookEvent;
  snapshotSubscription(sub: Stripe.Subscription): StripeSubscriptionSnapshot;
}

/**
 * Real implementation. Returns null (rather than throwing) when
 * STRIPE_SECRET_KEY isn't set — every call site treats a null client as
 * "subscription billing not configured yet" and responds accordingly
 * (mirrors how a missing GEMINI_API_KEY disables that adapter instead of
 * crashing the process).
 */
export function makeStripeClient(secretKey: string | undefined): StripeClient | null {
  if (!secretKey) return null;
  const stripe = new Stripe(secretKey);

  return {
    async ensureCustomer(opts) {
      if (opts.existingCustomerId) return opts.existingCustomerId;
      const customer = await stripe.customers.create({
        email: opts.email,
        name: opts.name,
        metadata: { tenantId: opts.tenantId },
      });
      return customer.id;
    },

    async createCheckoutSession(params) {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: params.customerId,
        client_reference_id: params.metadata.tenantId,
        line_items: [{ price: params.priceId, quantity: 1 }],
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        metadata: params.metadata,
        subscription_data: { metadata: params.metadata },
      });
      return { url: session.url };
    },

    async createPortalSession(customerId, returnUrl) {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });
      return { url: session.url };
    },

    constructWebhookEvent(rawBody, signature, webhookSecret) {
      const raw = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
      return { id: raw.id, type: raw.type, raw };
    },

    snapshotSubscription(sub: Stripe.Subscription): StripeSubscriptionSnapshot {
      const item = sub.items.data[0];
      // V5.30: current_period_end lives on each SubscriptionItem, not on the
      // Subscription root, as of this SDK's API version — read it off the
      // first item or this silently reads undefined.
      return {
        id: sub.id,
        status: sub.status,
        currentPeriodEnd: item?.current_period_end ?? null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        priceId: item?.price?.id ?? null,
        tenantId: (sub.metadata && sub.metadata.tenantId) || null,
        customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
      };
    },
  };
}
