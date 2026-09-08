/**
 * SaaS subscription billing (v5.30) — what a tenant firm pays to use VYNE
 * itself (Stripe), as distinct from routes/billing.ts's client cost-
 * recovery billing.
 *
 *   DB-only coverage: listPlans() returns the seeded catalog untouched by
 *   Stripe at all.
 *
 *   RLS-gated HTTP coverage, with a fake StripeClient (same DI shape as
 *   ProviderAdapter/TokenVerifier elsewhere — no real network calls):
 *   owner-only checkout/portal/subscription endpoints, consultant/
 *   interviewee blocked, "not configured" (503) when no Stripe client is
 *   injected, and the full webhook lifecycle (checkout completed →
 *   subscription updated → subscription deleted) landing correctly on the
 *   tenants row plus a matching audit_log entry for each.
 *
 * Run: RLS_TEST=1 ... npx vitest run test/subscriptions.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool, withTenant } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import { listPlans, makeSubscriptionLimitCheck } from "../src/billing/subscriptions.js";
import type {
  StripeClient, StripeCheckoutParams, StripeWebhookEvent,
} from "../src/billing/stripeClient.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/verify.js";
import type { ProviderAdapter } from "../src/llm/types.js";
import type { FastifyInstance } from "fastify";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:change-me-via-ops@localhost:5432/vyne";
const FAKE_WEBHOOK_SECRET = "whsec_test_fake";
const APP_BASE_URL = "https://app.test";

class FakeVerifier implements TokenVerifier {
  constructor(private map: Record<string, VerifiedIdentity>) {}
  async verify(t: string): Promise<VerifiedIdentity> {
    const id = this.map[t];
    if (!id) throw new Error("bad token");
    return id;
  }
}

const fakeAdapter: ProviderAdapter = {
  name: "gemini-aistudio", model: "fake", freeTier: true,
  isConfigured: () => true,
  async generate() { return { text: "ok", model: "fake", usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0 } }; },
};

/** No real network calls — same DI shape as every other fake provider in this suite. */
function makeFakeStripe(): StripeClient {
  let seq = 0;
  return {
    async ensureCustomer(opts) {
      if (opts.existingCustomerId) return opts.existingCustomerId;
      return `cus_fake_${++seq}`;
    },
    async createCheckoutSession(params: StripeCheckoutParams) {
      return { url: `https://checkout.stripe.test/session?tenant=${params.metadata.tenantId}&plan=${params.metadata.planKey}` };
    },
    async createPortalSession(customerId: string, returnUrl: string) {
      return { url: `https://billing.stripe.test/portal?customer=${customerId}&return=${encodeURIComponent(returnUrl)}` };
    },
    constructWebhookEvent(rawBody: Buffer, signature: string, webhookSecret: string): StripeWebhookEvent {
      if (signature !== `test-sig:${webhookSecret}`) throw new Error("invalid test signature");
      const parsed = JSON.parse(rawBody.toString("utf8"));
      return { id: parsed.id, type: parsed.type, raw: parsed };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshotSubscription(sub: any) {
      const item = sub.items?.data?.[0];
      return {
        id: sub.id,
        status: sub.status,
        currentPeriodEnd: item?.current_period_end ?? null,
        cancelAtPeriodEnd: !!sub.cancel_at_period_end,
        priceId: item?.price?.id ?? null,
        tenantId: (sub.metadata && sub.metadata.tenantId) || null,
        customerId: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
      };
    },
  };
}

describe.skipIf(!ENABLED)("listPlans() — DB only, no Stripe", () => {
  beforeAll(async () => {
    await migrate(ADMIN_URL);
    initPool(ADMIN_URL);
  });
  afterAll(async () => { await closePool(); });

  it("returns the seeded catalog", async () => {
    const plans = await listPlans();
    expect(plans.map((p) => p.key)).toEqual(["trial", "sprint", "transformation", "caio"]);
    expect(plans.find((p) => p.key === "trial")?.purchasable).toBe(false);
    expect(plans.find((p) => p.key === "sprint")?.purchasable).toBe(true);
  });
});

describe.skipIf(!ENABLED)("Subscription HTTP — owner-only, webhook lifecycle", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let unconfiguredApp: FastifyInstance;
  let tenant: string;
  const verifierMap: Record<string, VerifiedIdentity> = {
    "tok-owner": { uid: "uid-sub-owner", email: "sub-owner@firm.com", idpTenantId: undefined },
    "tok-cons": { uid: "uid-sub-cons", email: "sub-cons@firm.com", idpTenantId: undefined },
    "tok-iv": { uid: "uid-sub-iv", email: "sub-iv@client.com", idpTenantId: undefined },
  };

  beforeAll(async () => {
    process.env.DEV_AUTH = "1";
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    // Give 'sprint' a real-looking Stripe price id so checkout has a
    // configured plan to exercise the success path against.
    await admin.query(`UPDATE subscription_plans SET stripe_price_id = 'price_test_sprint' WHERE key = 'sprint'`);

    const t = await admin.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ('Subscription Firm') RETURNING id`);
    tenant = t.rows[0].id;

    const owner = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-sub-owner', 'sub-owner@firm.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, [owner.rows[0].id, tenant]);

    const cons = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-sub-cons', 'sub-cons@firm.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'consultant')`, [cons.rows[0].id, tenant]);

    const iv = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-sub-iv', 'sub-iv@client.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'interviewee')`, [iv.rows[0].id, tenant]);

    initPool(APP_URL);
    const baseDeps = {
      config: {
        port: 0, env: "test" as const, databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
        appBaseUrl: APP_BASE_URL, stripeWebhookSecret: FAKE_WEBHOOK_SECRET,
      },
      verifier: new FakeVerifier(verifierMap),
      adapters: [fakeAdapter],
      meter: async () => {},
    };
    app = await buildServer({ ...baseDeps, stripe: makeFakeStripe() });
    unconfiguredApp = await buildServer({ ...baseDeps, stripe: null });
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await admin.end();
    await app.close();
    await unconfiguredApp.close();
    await closePool();
  });

  it("GET /api/plans is visible to both owner and consultant", async () => {
    for (const tok of ["tok-owner", "tok-cons"]) {
      const r = await app.inject({ method: "GET", url: "/api/plans", headers: { authorization: `Bearer ${tok}` } });
      expect(r.statusCode).toBe(200);
      expect(r.json().plans).toHaveLength(4);
    }
  });

  it("GET /api/subscription: a freshly provisioned tenant starts on trial, no Stripe customer yet", async () => {
    const r = await app.inject({ method: "GET", url: "/api/subscription", headers: { authorization: "Bearer tok-owner" } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.planKey).toBe("trial");
    expect(body.subscriptionStatus).toBe("trialing");
    expect(body.hasStripeCustomer).toBe(false);
  });

  it("consultants and interviewees are blocked from /api/subscription", async () => {
    for (const tok of ["tok-cons", "tok-iv"]) {
      const r = await app.inject({ method: "GET", url: "/api/subscription", headers: { authorization: `Bearer ${tok}` } });
      expect(r.statusCode).toBe(403);
    }
  });

  it("checkout rejects a non-purchasable plan (trial)", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/subscription/checkout",
      headers: { authorization: "Bearer tok-owner" }, payload: { planKey: "trial" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("unknown_plan");
  });

  it("checkout rejects a purchasable plan with no Stripe price configured (transformation)", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/subscription/checkout",
      headers: { authorization: "Bearer tok-owner" }, payload: { planKey: "transformation" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("plan_not_configured");
  });

  it("checkout succeeds for a configured plan, creates a Stripe customer, and audit-logs it", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/subscription/checkout",
      headers: { authorization: "Bearer tok-owner" }, payload: { planKey: "sprint" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().url).toContain("checkout.stripe.test");

    const t = await admin.query<{ stripe_customer_id: string | null }>(`SELECT stripe_customer_id FROM tenants WHERE id = $1`, [tenant]);
    expect(t.rows[0].stripe_customer_id).toMatch(/^cus_fake_/);

    const audit = await withTenant(tenant, async (c) => {
      const r2 = await c.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'subscription_checkout_started'`, [tenant]);
      return r2.rowCount;
    });
    expect(audit).toBeGreaterThan(0);
  });

  it("consultants and interviewees cannot start checkout", async () => {
    for (const tok of ["tok-cons", "tok-iv"]) {
      const r = await app.inject({
        method: "POST", url: "/api/subscription/checkout",
        headers: { authorization: `Bearer ${tok}` }, payload: { planKey: "sprint" },
      });
      expect(r.statusCode).toBe(403);
    }
  });

  it("portal succeeds once a Stripe customer exists (after the checkout test above)", async () => {
    const r = await app.inject({ method: "POST", url: "/api/subscription/portal", headers: { authorization: "Bearer tok-owner" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().url).toContain("billing.stripe.test");
  });

  it("billing routes respond billing_not_configured when no Stripe client is injected", async () => {
    const r = await unconfiguredApp.inject({
      method: "POST", url: "/api/subscription/checkout",
      headers: { authorization: "Bearer tok-owner" }, payload: { planKey: "sprint" },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe("billing_not_configured");
  });

  describe("POST /api/webhooks/stripe", () => {
    it("rejects a request with no stripe-signature header", async () => {
      const r = await app.inject({
        method: "POST", url: "/api/webhooks/stripe",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } }),
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("missing_signature");
    });

    it("rejects a bad signature", async () => {
      const r = await app.inject({
        method: "POST", url: "/api/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": "not-the-right-sig" },
        payload: JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } }),
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_signature");
    });

    it("503s when Stripe isn't configured, even with a correctly-shaped call", async () => {
      const r = await unconfiguredApp.inject({
        method: "POST", url: "/api/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": `test-sig:${FAKE_WEBHOOK_SECRET}` },
        payload: JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } }),
      });
      expect(r.statusCode).toBe(503);
    });

    it("checkout.session.completed sets plan + stripe ids from event metadata", async () => {
      const event = {
        id: "evt_checkout_1",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_webhook_test",
            subscription: "sub_webhook_test",
            metadata: { tenantId: tenant, planKey: "transformation" },
          },
        },
      };
      const r = await app.inject({
        method: "POST", url: "/api/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": `test-sig:${FAKE_WEBHOOK_SECRET}` },
        payload: JSON.stringify(event),
      });
      expect(r.statusCode).toBe(200);

      const t = await admin.query(`SELECT plan, stripe_customer_id, stripe_subscription_id FROM tenants WHERE id = $1`, [tenant]);
      expect(t.rows[0].plan).toBe("transformation");
      expect(t.rows[0].stripe_customer_id).toBe("cus_webhook_test");
      expect(t.rows[0].stripe_subscription_id).toBe("sub_webhook_test");
    });

    it("customer.subscription.updated syncs status/current_period_end/cancel_at_period_end and re-derives plan from price id", async () => {
      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
      const event = {
        id: "evt_sub_updated_1",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_webhook_test",
            status: "active",
            cancel_at_period_end: true,
            customer: "cus_webhook_test",
            metadata: { tenantId: tenant },
            items: { data: [{ current_period_end: periodEnd, price: { id: "price_test_sprint" } }] },
          },
        },
      };
      const r = await app.inject({
        method: "POST", url: "/api/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": `test-sig:${FAKE_WEBHOOK_SECRET}` },
        payload: JSON.stringify(event),
      });
      expect(r.statusCode).toBe(200);

      const t = await admin.query(`SELECT plan, subscription_status, cancel_at_period_end, current_period_end FROM tenants WHERE id = $1`, [tenant]);
      expect(t.rows[0].plan).toBe("sprint"); // re-derived from price_test_sprint, not the checkout-time metadata plan
      expect(t.rows[0].subscription_status).toBe("active");
      expect(t.rows[0].cancel_at_period_end).toBe(true);
      expect(t.rows[0].current_period_end).not.toBeNull();
    });

    it("customer.subscription.deleted marks the tenant canceled", async () => {
      const event = {
        id: "evt_sub_deleted_1",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_webhook_test",
            status: "canceled",
            cancel_at_period_end: false,
            customer: "cus_webhook_test",
            metadata: { tenantId: tenant },
            items: { data: [] },
          },
        },
      };
      const r = await app.inject({
        method: "POST", url: "/api/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": `test-sig:${FAKE_WEBHOOK_SECRET}` },
        payload: JSON.stringify(event),
      });
      expect(r.statusCode).toBe(200);

      const t = await admin.query(`SELECT subscription_status FROM tenants WHERE id = $1`, [tenant]);
      expect(t.rows[0].subscription_status).toBe("canceled");

      const audit = await withTenant(tenant, async (c) => {
        const r2 = await c.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'subscription_canceled'`, [tenant]);
        return r2.rowCount;
      });
      expect(audit).toBeGreaterThan(0);
    });

    // V225-audit billing Low fix: an out-of-order (delayed/retried) webhook
    // must not overwrite a newer already-applied status with stale data.
    it("ignores an out-of-order webhook event older than the last one applied", async () => {
      const now = Math.floor(Date.now() / 1000);
      const newerEvent = {
        id: "evt_order_newer", type: "customer.subscription.updated", created: now,
        data: { object: {
          id: "sub_webhook_test", status: "active", cancel_at_period_end: false,
          customer: "cus_webhook_test", metadata: { tenantId: tenant },
          items: { data: [{ current_period_end: now + 1000, price: { id: "price_test_sprint" } }] },
        } },
      };
      const olderEvent = {
        id: "evt_order_older", type: "customer.subscription.updated", created: now - 3600,
        data: { object: {
          id: "sub_webhook_test", status: "past_due", cancel_at_period_end: false,
          customer: "cus_webhook_test", metadata: { tenantId: tenant },
          items: { data: [{ current_period_end: now + 1000, price: { id: "price_test_sprint" } }] },
        } },
      };

      const r1 = await app.inject({
        method: "POST", url: "/api/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": `test-sig:${FAKE_WEBHOOK_SECRET}` },
        payload: JSON.stringify(newerEvent),
      });
      expect(r1.statusCode).toBe(200);
      let t = await admin.query(`SELECT subscription_status FROM tenants WHERE id = $1`, [tenant]);
      expect(t.rows[0].subscription_status).toBe("active");

      // A delayed/retried delivery of an OLDER event arrives after the newer
      // one already landed — must be ignored, not overwrite "active" with
      // the stale "past_due".
      const r2 = await app.inject({
        method: "POST", url: "/api/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": `test-sig:${FAKE_WEBHOOK_SECRET}` },
        payload: JSON.stringify(olderEvent),
      });
      expect(r2.statusCode).toBe(200); // still 200 — a stale event is not an error, just ignored
      t = await admin.query(`SELECT subscription_status FROM tenants WHERE id = $1`, [tenant]);
      expect(t.rows[0].subscription_status).toBe("active"); // unchanged, NOT "past_due"
    });

    it("ignores event types it doesn't track, returning 200", async () => {
      const r = await app.inject({
        method: "POST", url: "/api/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": `test-sig:${FAKE_WEBHOOK_SECRET}` },
        payload: JSON.stringify({ id: "evt_unrelated", type: "invoice.paid", data: { object: {} } }),
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().received).toBe(true);
    });
  });
});

describe.skipIf(!ENABLED)("makeSubscriptionLimitCheck — the paywall gate", () => {
  let admin: pg.Client;
  const TRIAL_DAYS = 14;
  const tenants: Record<string, string> = {};

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    initPool(ADMIN_URL);

    async function makeTenant(name: string, createdDaysAgo: number, overrides: Partial<{
      subscription_status: string; current_period_end: string | null;
    }>): Promise<string> {
      const t = await admin.query<{ id: string }>(
        `INSERT INTO tenants (name, created_at) VALUES ($1, now() - ($2 || ' days')::interval) RETURNING id`,
        [name, createdDaysAgo]
      );
      const id = t.rows[0].id;
      if (overrides.subscription_status || overrides.current_period_end !== undefined) {
        await admin.query(
          `UPDATE tenants SET subscription_status = COALESCE($2, subscription_status), current_period_end = $3 WHERE id = $1`,
          [id, overrides.subscription_status ?? null, overrides.current_period_end ?? null]
        );
      }
      return id;
    }

    tenants.freshNoStripe = await makeTenant("Fresh, never subscribed", 1, {});
    tenants.expiredGraceTrial = await makeTenant("Expired grace trial", TRIAL_DAYS + 5, {});
    tenants.activeSubscriber = await makeTenant("Active subscriber", 100, { subscription_status: "active" });
    tenants.pastDue = await makeTenant("Past due", 100, { subscription_status: "past_due" });
    tenants.canceled = await makeTenant("Canceled", 100, { subscription_status: "canceled" });
    tenants.realStripeTrialActive = await makeTenant("Real Stripe trial, not yet ended", 1, {
      subscription_status: "trialing",
      current_period_end: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    tenants.realStripeTrialExpired = await makeTenant("Real Stripe trial, ended", 1, {
      subscription_status: "trialing",
      current_period_end: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [Object.values(tenants)]);
    await admin.end();
    await closePool();
  });

  it("a fresh tenant with no Stripe data is allowed within the grace trial window", async () => {
    const gate = await makeSubscriptionLimitCheck(TRIAL_DAYS)(tenants.freshNoStripe);
    expect(gate.allowed).toBe(true);
  });

  it("a tenant past the grace trial with no subscription is blocked", async () => {
    const gate = await makeSubscriptionLimitCheck(TRIAL_DAYS)(tenants.expiredGraceTrial);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("trial_expired");
  });

  it("an active subscriber is always allowed", async () => {
    const gate = await makeSubscriptionLimitCheck(TRIAL_DAYS)(tenants.activeSubscriber);
    expect(gate.allowed).toBe(true);
  });

  it("past_due and canceled tenants are blocked", async () => {
    expect((await makeSubscriptionLimitCheck(TRIAL_DAYS)(tenants.pastDue)).allowed).toBe(false);
    expect((await makeSubscriptionLimitCheck(TRIAL_DAYS)(tenants.canceled)).allowed).toBe(false);
  });

  it("a real Stripe trial is allowed until its own current_period_end, independent of tenants.created_at", async () => {
    const gate = await makeSubscriptionLimitCheck(TRIAL_DAYS)(tenants.realStripeTrialActive);
    expect(gate.allowed).toBe(true);
  });

  it("an ended real Stripe trial is blocked even though the tenant is only 1 day old", async () => {
    const gate = await makeSubscriptionLimitCheck(TRIAL_DAYS)(tenants.realStripeTrialExpired);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("trial_expired");
  });

  it("an unknown tenant id is blocked, not thrown", async () => {
    const gate = await makeSubscriptionLimitCheck(TRIAL_DAYS)("00000000-0000-0000-0000-000000000000");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("tenant_not_found");
  });
});
