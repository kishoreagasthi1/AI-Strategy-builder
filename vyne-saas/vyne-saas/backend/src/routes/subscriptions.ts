/**
 * SaaS subscription billing (v5.30) — what a TENANT FIRM pays to use VYNE
 * itself, via Stripe Checkout + the Stripe customer billing portal.
 *
 * Distinct from routes/billing.ts (client cost-recovery — the firm passing
 * its own AI usage cost through to ITS clients, at cost). This is the
 * other direction: Vynora charging the firm a subscription to run the
 * platform at all.
 *
 *   GET  /api/plans                  — the plan catalog (any owner/consultant)
 *   GET  /api/subscription           — this tenant's current plan/status (owner)
 *   POST /api/subscription/checkout  — start a Stripe Checkout session (owner)
 *   POST /api/subscription/portal    — open the Stripe billing portal (owner)
 *
 * POST /api/webhooks/stripe (Stripe → us, subscription lifecycle) is a
 * SEPARATE export, stripeWebhookRoutes() below — it must be registered
 * outside the auth-hooked protected scope (see its own doc comment).
 *
 * Fully inert with no STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET configured
 * (config.stripeSecretKey/stripeWebhookSecret undefined, stripe === null
 * throughout this file) — /api/plans still works read-only (useful for a
 * pricing page before billing is even wired up), everything else responds
 * with a clear "billing_not_configured" error instead of ever touching the
 * Stripe SDK.
 *
 * Checkout/portal redirect URLs are built server-side from config.appBaseUrl
 * — deliberately NEVER taken from client input (an owner-supplied redirect
 * URL fed straight into Stripe's success_url/cancel_url would be an open
 * redirect through a Stripe-hosted page).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/middleware.js";
import type { StripeClient } from "../billing/stripeClient.js";
import {
  listPlans, getTenantSubscription, startCheckout, startPortal, applyWebhookEvent, SubscriptionError,
} from "../billing/subscriptions.js";

export interface SubscriptionRoutesOptions {
  stripe: StripeClient | null;
  appBaseUrl: string | undefined;
}

const CheckoutBody = z.object({ planKey: z.string().min(1).max(100) });

export async function subscriptionRoutes(app: FastifyInstance, opts: SubscriptionRoutesOptions): Promise<void> {
  app.get("/api/plans", { preHandler: requireRole("owner", "consultant") }, async () => {
    return { plans: await listPlans() };
  });

  app.get("/api/subscription", { preHandler: requireRole("owner") }, async (req, reply) => {
    const ctx = req.ctx!;
    try {
      return await getTenantSubscription(ctx.tenantId);
    } catch (err) {
      req.log.error({ err }, "subscription lookup failed");
      reply.code(500).send({ error: "subscription_lookup_failed" });
    }
  });

  app.post("/api/subscription/checkout", { preHandler: requireRole("owner") }, async (req, reply) => {
    const ctx = req.ctx!;
    if (!opts.stripe || !opts.appBaseUrl) { reply.code(503).send({ error: "billing_not_configured" }); return; }
    const parsed = CheckoutBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
    try {
      const { url } = await startCheckout(
        opts.stripe, ctx.tenantId, parsed.data.planKey,
        ctx.email ?? "", ctx.email ?? "",
        `${opts.appBaseUrl}/billing.html?checkout=success`,
        `${opts.appBaseUrl}/billing.html?checkout=cancelled`
      );
      return { url };
    } catch (err) {
      if (err instanceof SubscriptionError) { reply.code(400).send({ error: err.code, detail: err.message }); return; }
      req.log.error({ err }, "checkout session creation failed");
      reply.code(500).send({ error: "checkout_failed" });
    }
  });

  app.post("/api/subscription/portal", { preHandler: requireRole("owner") }, async (req, reply) => {
    const ctx = req.ctx!;
    if (!opts.stripe || !opts.appBaseUrl) { reply.code(503).send({ error: "billing_not_configured" }); return; }
    try {
      const { url } = await startPortal(opts.stripe, ctx.tenantId, `${opts.appBaseUrl}/billing.html`);
      return { url };
    } catch (err) {
      if (err instanceof SubscriptionError) { reply.code(400).send({ error: err.code, detail: err.message }); return; }
      req.log.error({ err }, "billing portal session creation failed");
      reply.code(500).send({ error: "portal_failed" });
    }
  });

}

export interface StripeWebhookRoutesOptions {
  stripe: StripeClient | null;
  webhookSecret: string | undefined;
}

/**
 * Registered SEPARATELY from subscriptionRoutes() above, and MUST be
 * registered in server.ts's public section (outside the auth-hooked
 * protected scope) — Stripe never sends a Bearer token, so this route
 * would 401 on every real webhook delivery if it inherited that hook.
 * Signature verification against webhookSecret is the actual auth here.
 */
export async function stripeWebhookRoutes(app: FastifyInstance, opts: StripeWebhookRoutesOptions): Promise<void> {
  await app.register(async (webhookScope) => {
    // Override the default JSON body parser for JUST this encapsulated
    // scope: signature verification needs the exact raw bytes Stripe
    // signed, not a re-serialized JSON.parse() of them (which can differ
    // byte-for-byte from the original and fail verification).
    webhookScope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });

    webhookScope.post("/api/webhooks/stripe", async (req, reply) => {
      if (!opts.stripe || !opts.webhookSecret) { reply.code(503).send({ error: "billing_not_configured" }); return; }
      const sig = req.headers["stripe-signature"];
      if (typeof sig !== "string") { reply.code(400).send({ error: "missing_signature" }); return; }
      let event;
      try {
        event = opts.stripe.constructWebhookEvent(req.body as Buffer, sig, opts.webhookSecret);
      } catch (err) {
        req.log.warn({ err }, "stripe webhook signature verification failed");
        reply.code(400).send({ error: "invalid_signature" });
        return;
      }
      try {
        await applyWebhookEvent(opts.stripe, event);
      } catch (err) {
        // A 500 here tells Stripe to retry — correct for a transient DB
        // hiccup, since the event itself was already verified genuine.
        req.log.error({ err, eventType: event.type }, "stripe webhook handling failed");
        reply.code(500).send({ error: "webhook_processing_failed" });
        return;
      }
      return { received: true };
    });
  });
}
