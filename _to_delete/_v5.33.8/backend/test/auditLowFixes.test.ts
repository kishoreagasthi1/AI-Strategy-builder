/**
 * The Low-severity tail of the second audit (V2-L1 … L9), v5.32.65.
 *
 * Individually small; together they are one theme, which is why they are in one
 * file. Every one of them is a place where the system reported something
 * cheerier than the truth — a cancelled subscription that still carried a paid
 * allowance, an audit row for a change that did not happen, a billed call
 * costed at $0.00, a truncated answer that looked complete, an identity that
 * matched any firm, a proxy address that was the same for everybody, and a
 * health check that quietly spent a database connection per request.
 *
 * L3 is not here. The audit reported that `vynora_code_index` has no ownership
 * check; it has one, differently shaped, and that is settled with its own tests
 * in workspaceIndexOwnership.test.ts rather than assumed either way.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import pg from "pg";
import Fastify from "fastify";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import { healthRoutes } from "../src/routes/health.js";
import { applyWebhookEvent } from "../src/billing/subscriptions.js";
import { makeGeminiAiStudioAdapter } from "../src/llm/adapters/geminiAiStudio.js";
import { makeOpenAiAdapter } from "../src/llm/adapters/openai.js";
import { voiceRoutes } from "../src/routes/voice.js";
import { LlmGateway } from "../src/llm/gateway.js";
import type { Tts } from "../src/llm/tts.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/verify.js";
import type { ProviderAdapter, MeterEvent } from "../src/llm/types.js";
import type { FastifyInstance } from "fastify";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5433/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:apppw@localhost:5433/vyne";

/* ── L6, L7 — what an adapter says a call cost and how it ended ───────────── */

function jsonFetch(body: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  })) as unknown as typeof fetch;
}

const GEMINI_OK = {
  candidates: [{ content: { parts: [{ text: "an answer" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 },
};

describe("a paid AI Studio key is not metered as free (V2-L6)", () => {
  it("costs a paid-tier call at the model's real rate", async () => {
    const a = makeGeminiAiStudioAdapter({
      apiKey: "k", model: "gemini-flash-latest", paidTier: true,
      fetchImpl: jsonFetch(GEMINI_OK), baseUrl: "https://x",
    });
    const out = await a.generate({ task: "t", messages: [{ role: "user", content: "hi" }] });
    // 1M in at $0.30 + 1M out at $2.50. The exact figure matters less than it
    // not being zero, but pinning it catches a units slip in PRICE_TABLE.
    expect(out.usage.costEstUsd).toBeCloseTo(2.80, 6);
  });

  it("still costs a FREE-tier call at zero, because it is zero", async () => {
    // The fix has to derive from the flag, not just stop being zero. An adapter
    // that bills the free tier would be a worse bug than the one being fixed.
    const a = makeGeminiAiStudioAdapter({
      apiKey: "k", model: "gemini-flash-latest",
      fetchImpl: jsonFetch(GEMINI_OK), baseUrl: "https://x",
    });
    const out = await a.generate({ task: "t", messages: [{ role: "user", content: "hi" }] });
    expect(out.usage.costEstUsd).toBe(0);
    expect(a.freeTier).toBe(true);
  });
});

describe("the OpenAI adapter keeps the finish reason (V2-L7)", () => {
  const openAiBody = (finish: string) => ({
    choices: [{ message: { content: "half an ans" }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });

  it("surfaces a truncated response as truncated", async () => {
    // Dropped, exactly as the Gemini adapters dropped it before v5.32.23, and
    // at the same cost: a summary cut off at max_tokens read as finished work.
    const a = makeOpenAiAdapter({
      apiKey: "k", fetchImpl: jsonFetch(openAiBody("length")), baseUrl: "https://x",
    });
    const out = await a.generate({ task: "t", messages: [{ role: "user", content: "hi" }] });
    // "length" is the canonical word normalizeFinishReason maps onto —
    // Anthropic's "max_tokens" and Gemini's "MAX_TOKENS" land here too, which
    // is the point of normalising at the adapter rather than at each caller.
    expect(out.finishReason).toBe("length");
  });

  it("reports a normal completion as complete, in the same vocabulary as the others", async () => {
    const a = makeOpenAiAdapter({
      apiKey: "k", fetchImpl: jsonFetch(openAiBody("stop")), baseUrl: "https://x",
    });
    const out = await a.generate({ task: "t", messages: [{ role: "user", content: "hi" }] });
    expect(out.finishReason).toBe("stop");
  });
});

/* ── L5 — TTS is a billed call and must be metered as one ─────────────────── */

describe("TTS is metered at what it cost (V2-L5)", () => {
  function fakeTts(): Tts {
    return {
      isConfigured: () => true,
      model: "gemini-2.5-flash-tts",
      defaultVoice: "Kore",
      freeTier: false,
      synthesize: vi.fn(async () => ({
        audioBase64: "AAAA", mime: "audio/wav" as const, voice: "Kore",
        model: "gemini-2.5-flash-tts",
        // A minute or so of speech: audio output is the expensive direction,
        // and it is the one the old code counted as nothing at all.
        usage: { tokensIn: 200, tokensOut: 1_500_000 },
      })),
    } as unknown as Tts;
  }

  it("records the provider's own token counts and a non-zero cost", async () => {
    const metered: MeterEvent[] = [];
    const app = Fastify({ logger: false });
    app.addHook("preHandler", async (req) => {
      req.ctx = { userId: "u-1", tenantId: "t-1", role: "consultant", email: "c@f.com" };
    });
    await voiceRoutes(
      app,
      new LlmGateway({
        adapters: [] as ProviderAdapter[],
        policy: { defaultChain: [], taskChains: {} },
        meter: async () => {},
        blockFreeTier: false,
      }),
      fakeTts(),
      async (e: MeterEvent) => { metered.push(e); }
    );

    const res = await app.inject({
      method: "POST", url: "/api/voice/tts",
      payload: { text: "Good morning.", module: "interview_agent" },
    });
    expect(res.statusCode).toBe(200);

    const tts = metered.find((m) => m.task === "tts");
    expect(tts, JSON.stringify(metered)).toBeTruthy();
    expect(tts!.tokensOut).toBe(1_500_000);
    // The whole point: this row used to say $0.00 on a real, billed call.
    expect(tts!.costEstUsd).toBeGreaterThan(0);
    await app.close();
  });
});

/* ── L9 — the health check stops being a free database probe ──────────────── */

describe("/api/health does not spend a connection per request (V2-L9)", () => {
  it("collapses a burst onto one query, and caches the result", async () => {
    // Unauthenticated by necessity — Cloud Run has to be able to call it — so
    // "one DB round trip per request" made the cheapest public endpoint a lever
    // on the resource the whole firm shares.
    let queries = 0;
    vi.resetModules();
    vi.doMock("../src/db/pool.js", () => ({
      getPool: () => ({ query: async () => { queries++; return { rows: [] }; } }),
    }));
    const { healthRoutes: routes } = await import("../src/routes/health.js");

    const app = Fastify({ logger: false });
    await routes(app, { env: "test" });

    const burst = await Promise.all(
      Array.from({ length: 50 }, () => app.inject({ method: "GET", url: "/api/health" }))
    );
    expect(burst.every((r) => r.statusCode === 200)).toBe(true);
    expect(burst[0].json().db).toBe("up");
    // 50 requests, one probe. Before the fix this was 50.
    expect(queries).toBe(1);

    // Still fresh, so still no new probe.
    await app.inject({ method: "GET", url: "/api/health" });
    expect(queries).toBe(1);

    await app.close();
    vi.doUnmock("../src/db/pool.js");
    vi.resetModules();
  });

  it("still reports a real answer rather than a cached optimism", async () => {
    // A cache that never re-probes is a status page that says "ok" through an
    // outage. The route must be honest about a down database.
    vi.resetModules();
    vi.doMock("../src/db/pool.js", () => ({
      getPool: () => ({ query: async () => { throw new Error("db down"); } }),
    }));
    const { healthRoutes: routes } = await import("../src/routes/health.js");
    const app = Fastify({ logger: false });
    await routes(app, { env: "test" });
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.json().db).toBe("down");
    expect(r.json().status).toBe("degraded");
    await app.close();
    vi.doUnmock("../src/db/pool.js");
    vi.resetModules();
  });
});

/* ── L1, L2, L4 — against a real database ─────────────────────────────────── */

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
  async generate() {
    return { text: "ok", model: "fake", usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0 } };
  },
};

describe.skipIf(!ENABLED)("subscription lifecycle tells the truth (V2-L1, V2-L2)", () => {
  let admin: pg.Client;
  let tenant: string;

  const stripeStub = {
    snapshotSubscription: (sub: Record<string, unknown>) => ({
      id: "sub_1",
      tenantId: sub.tenantId as string,
      customerId: "cus_1",
      status: "canceled",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      priceId: null,
    }),
  };

  const planOf = async () => {
    const r = await admin.query<{ plan: string; monthly_token_limit: string | null }>(
      `SELECT plan, monthly_token_limit FROM tenants WHERE id = $1`, [tenant]);
    return r.rows[0];
  };

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name, plan, monthly_token_limit)
       VALUES ('Cancelling Firm', 'caio', 200000000) RETURNING id`);
    tenant = t.rows[0].id;
    initPool(APP_URL);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await admin.end();
    await closePool();
  });

  it("cancellation takes the entitlement with it", async () => {
    // The finding. This used to set subscription_status = 'canceled' and stop,
    // so a cancelled CAIO firm kept a 200,000,000-token monthly allowance — and
    // STRIPE_ENFORCE_PAYWALL is off by default, which made the status field on
    // its own decorative.
    expect((await planOf()).plan).toBe("caio");

    await applyWebhookEvent(stripeStub as never, {
      type: "customer.subscription.deleted",
      raw: { created: Math.floor(Date.now() / 1000), data: { object: { tenantId: tenant } } },
    } as never);

    const after = await planOf();
    expect(after.plan).toBe("trial");
    expect(Number(after.monthly_token_limit)).toBe(3_000_000);
    // Not zero and not NULL: NULL means UNLIMITED in this schema, so writing it
    // here would have turned a cancellation into an upgrade.
    expect(after.monthly_token_limit).not.toBeNull();
  });

  it("a stale checkout event writes no audit row (V2-L2)", async () => {
    // The out-of-order guard already refused to apply the UPDATE; the audit row
    // was written anyway, leaving the one record whose job is to be trustworthy
    // asserting a plan change that never happened.
    const before = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE tenant_id = $1 AND action = 'subscription_checkout_completed'`,
      [tenant]);

    // Older than the cancellation just applied, so the guard must skip it.
    await applyWebhookEvent({} as never, {
      type: "checkout.session.completed",
      raw: {
        created: Math.floor(Date.now() / 1000) - 86_400,
        data: { object: { metadata: { tenantId: tenant, planKey: "caio" }, client_reference_id: tenant } },
      },
    } as never);

    const after = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE tenant_id = $1 AND action = 'subscription_checkout_completed'`,
      [tenant]);
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
    // And the stale event did not resurrect the paid plan either.
    expect((await planOf()).plan).toBe("trial");
  });
});

describe.skipIf(!ENABLED)("an identity with no IdP tenant matches only a tenant-less firm (V2-L4)", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let plainFirm: string;
  let idpFirm: string;

  beforeAll(async () => {
    process.env.DEV_AUTH = "1";
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    const a = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Plain Firm') RETURNING id`);
    plainFirm = a.rows[0].id;
    const b = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name, idp_tenant_id) VALUES ('IdP Firm', 'idp-tenant-xyz') RETURNING id`);
    idpFirm = b.rows[0].id;

    // One user, one membership, in the IdP-scoped firm only. The membership is
    // created LAST so that "newest membership wins" would pick it — which is
    // exactly how the wildcard used to hand it out.
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-l4', 'l4@firm.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')
       ON CONFLICT (user_id, tenant_id) DO NOTHING`, [u.rows[0].id, idpFirm]);

    initPool(APP_URL);
    app = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier({
        // No idpTenantId: the shape the wildcard let through.
        "tok-tenantless": { uid: "uid-l4", email: "l4@firm.com", idpTenantId: undefined },
        "tok-right": { uid: "uid-l4", email: "l4@firm.com", idpTenantId: "idp-tenant-xyz" },
        "tok-wrong": { uid: "uid-l4", email: "l4@firm.com", idpTenantId: "idp-tenant-other" },
      }),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [[plainFirm, idpFirm]]);
    await admin.query(`DELETE FROM users WHERE identity_platform_uid = 'uid-l4'`);
    await admin.end();
    await app.close();
    await closePool();
  });

  const me = (tok: string) =>
    app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${tok}` } });

  it("refuses a token with no IdP tenant against an IdP-scoped firm", async () => {
    const r = await me("tok-tenantless");
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("no_membership");
  });

  it("refuses a token naming the WRONG IdP tenant", async () => {
    expect((await me("tok-wrong")).statusCode).toBe(403);
  });

  it("still admits a token naming the right one", async () => {
    // The other half: a predicate that refuses everybody is not a fix.
    const r = await me("tok-right");
    expect(r.statusCode).toBe(200);
    expect(r.json().role).toBe("owner");
  });

  it("a tenant-less identity still works for a tenant-less firm", async () => {
    // Single-tenant and dev deployments leave idp_tenant_id NULL, and the
    // wildcard existed to serve them. IS NOT DISTINCT FROM keeps that working;
    // NULL = NULL would not.
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-l4b', 'l4b@firm.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'consultant')
       ON CONFLICT (user_id, tenant_id) DO NOTHING`, [u.rows[0].id, plainFirm]);

    const local = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier({
        "tok-plain": { uid: "uid-l4b", email: "l4b@firm.com", idpTenantId: undefined },
      }),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
    const r = await local.inject({
      method: "GET", url: "/api/me", headers: { authorization: "Bearer tok-plain" },
    });
    expect(r.statusCode).toBe(200);
    await local.close();
    await admin.query(`DELETE FROM users WHERE identity_platform_uid = 'uid-l4b'`);
  });
});

/* ── L8 — the proxy address ───────────────────────────────────────────────── */

describe("req.ip is the caller, not Google's front end (V2-L8)", () => {
  it("resolves the real client from X-Forwarded-For in production", async () => {
    // Unset, req.ip was the socket peer — identical for every caller on Cloud
    // Run — so every IP-keyed limiter in server.ts shared one bucket.
    const app = await buildServer({
      config: {
        port: 0, env: "production", databaseUrl: APP_URL,
        appBaseUrl: "https://app.example.com",
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      } as never,
      verifier: new FakeVerifier({}),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
    app.get("/__ip", async (req) => ({ ip: req.ip }));

    // Google's front end produces: <client-supplied>, <real client>, <lb>.
    const r = await app.inject({
      method: "GET", url: "/__ip",
      headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7, 10.0.0.1" },
    });
    // One hop trusted: the load balancer is skipped, the real client is taken,
    // and the value the CALLER invented is ignored. Trusting the whole chain
    // (`trustProxy: true`) would have returned 9.9.9.9 and handed an attacker a
    // free IP-rotation knob.
    expect(r.json().ip).toBe("203.0.113.7");
    await app.close();
  });

  it("ignores the header outside production, where there is no proxy to trust", async () => {
    const app = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier({}),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
    app.get("/__ip", async (req) => ({ ip: req.ip }));
    const r = await app.inject({
      method: "GET", url: "/__ip", headers: { "x-forwarded-for": "9.9.9.9" },
    });
    expect(r.json().ip).not.toBe("9.9.9.9");
    await app.close();
  });
});

/* ── L3 — settled, not fixed ──────────────────────────────────────────────── */

describe("V2-L3 — the vynora_code_index twin", () => {
  it("is covered where the claim can actually be tested", async () => {
    // The audit reported this index as having "no ownership check at all". It
    // has one, of a different shape: the index is keyed by CODE, so an unknown
    // code resolves to "UNKNOWN" and is refused by the norm check every entry
    // passes through. Rather than restate that here, this points at the file
    // that exercises it — a duplicate assertion in two files drifts, and the
    // one that drifts is the one nobody is reading.
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "workspaceIndexOwnership.test.ts"), "utf8");
    expect(src).toContain("the vynora_code_index twin");
    expect(src).toContain("already refuses an unknown code");
  });
});
