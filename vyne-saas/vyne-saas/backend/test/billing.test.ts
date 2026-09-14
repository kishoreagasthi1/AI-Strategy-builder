/**
 * Client cost-recovery billing (v5.27).
 *
 *   Pure-function coverage: buildBillingSummary / buildBillingStatement
 *   (no DB needed — same "aggregate in JS, test without Postgres" pattern
 *   as scorecard.test.ts).
 *
 *   RLS-gated HTTP coverage: GET /api/billing/summary and
 *   GET /api/billing/statement through the real app — owner sees every
 *   client plus the unattributed bucket, a restricted consultant sees only
 *   their assigned client and never unattributed, and interviewees are
 *   blocked outright. Client scoping itself (allowedClientNorms/normClient)
 *   is already covered generically in test/clients.test.ts; this just
 *   confirms billing.ts wires into that the same way scorecard.ts does.
 *
 * Run: RLS_TEST=1 ... npx vitest run test/billing.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import { buildBillingSummary, buildBillingStatement, UNATTRIBUTED, type UsageEventLite } from "../src/routes/billing.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/verify.js";
import type { ProviderAdapter } from "../src/llm/types.js";
import type { FastifyInstance } from "fastify";

function ev(over: Partial<UsageEventLite>): UsageEventLite {
  return {
    clientName: null, clientNorm: null, module: "m", task: "t", provider: "p", model: "mo",
    tokensIn: 100, tokensOut: 50, costEstUsd: 0.01, ok: true, createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("buildBillingSummary", () => {
  it("groups by client, sums cost/tokens, ignores failed calls", () => {
    const out = buildBillingSummary([
      ev({ clientName: "Acme", clientNorm: "acme", costEstUsd: 0.01, tokensIn: 100, tokensOut: 50 }),
      ev({ clientName: "Acme", clientNorm: "acme", costEstUsd: 0.02, tokensIn: 200, tokensOut: 100 }),
      ev({ clientName: "Acme", clientNorm: "acme", ok: false, costEstUsd: 0 }), // failed — excluded
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].clientName).toBe("Acme");
    expect(out[0].callCount).toBe(2);
    expect(out[0].costEstUsd).toBeCloseTo(0.03);
    expect(out[0].tokensIn).toBe(300);
    expect(out[0].tokensOut).toBe(150);
  });

  it("buckets calls with no client under UNATTRIBUTED, sorted last", () => {
    const out = buildBillingSummary([
      ev({ clientName: "Zed", clientNorm: "zed" }),
      ev({ clientName: null, clientNorm: null }),
      ev({ clientName: "Acme", clientNorm: "acme" }),
    ]);
    expect(out.map((c) => c.clientNorm)).toEqual(["acme", "zed", UNATTRIBUTED]);
    expect(out[2].clientName).toBeNull();
  });

  it("tracks the most recent activity timestamp per client", () => {
    const out = buildBillingSummary([
      ev({ clientName: "Acme", clientNorm: "acme", createdAt: "2026-01-01T00:00:00Z" }),
      ev({ clientName: "Acme", clientNorm: "acme", createdAt: "2026-03-01T00:00:00Z" }),
      ev({ clientName: "Acme", clientNorm: "acme", createdAt: "2026-02-01T00:00:00Z" }),
    ]);
    expect(out[0].lastActivity).toBe("2026-03-01T00:00:00Z");
  });
});

describe("buildBillingStatement", () => {
  it("returns sorted line items and totals, excluding failed calls", () => {
    const out = buildBillingStatement([
      ev({ createdAt: "2026-01-02T00:00:00Z", costEstUsd: 0.02, tokensIn: 50, tokensOut: 20 }),
      ev({ createdAt: "2026-01-01T00:00:00Z", costEstUsd: 0.01, tokensIn: 100, tokensOut: 50 }),
      ev({ ok: false, costEstUsd: 0 }),
    ]);
    expect(out.callCount).toBe(2);
    expect(out.lineItems.map((li) => li.createdAt)).toEqual(["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"]);
    expect(out.totalCostUsd).toBeCloseTo(0.03);
    expect(out.totalTokensIn).toBe(150);
    expect(out.totalTokensOut).toBe(70);
  });

  it("returns zeroed totals for no events", () => {
    const out = buildBillingStatement([]);
    expect(out).toEqual({ lineItems: [], callCount: 0, totalTokensIn: 0, totalTokensOut: 0, totalCostUsd: 0 });
  });
});

/* ── RLS-gated HTTP coverage ─────────────────────────────────────────────── */

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:change-me-via-ops@localhost:5432/vyne";

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

describe.skipIf(!ENABLED)("Billing HTTP — client scoping", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;
  const verifierMap: Record<string, VerifiedIdentity> = {
    "tok-owner": { uid: "uid-billing-owner", email: "billing-owner@firm.com", idpTenantId: undefined },
    "tok-cons": { uid: "uid-billing-cons", email: "billing-cons@firm.com", idpTenantId: undefined },
    "tok-iv": { uid: "uid-billing-iv", email: "billing-iv@client.com", idpTenantId: undefined },
  };

  beforeAll(async () => {
    process.env.DEV_AUTH = "1";
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    const t = await admin.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ('Billing Firm') RETURNING id`);
    tenant = t.rows[0].id;

    const owner = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-billing-owner', 'billing-owner@firm.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, [owner.rows[0].id, tenant]);

    const cons = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-billing-cons', 'billing-cons@firm.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'consultant')`, [cons.rows[0].id, tenant]);

    const iv = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-billing-iv', 'billing-iv@client.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'interviewee')`, [iv.rows[0].id, tenant]);

    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    // Consultant is assigned only to Acme — never Beta, never unattributed.
    await admin.query(
      `INSERT INTO client_assignments (tenant_id, user_id, client_name, client_norm) VALUES ($1, $2, 'Acme', 'acme')`,
      [tenant, cons.rows[0].id]);
    // Seed usage_events directly (bypassing the gateway/meter — this is a
    // read-side test) for two clients plus one unattributed row.
    await admin.query(
      `INSERT INTO usage_events (tenant_id, module, task, provider, model, tokens_in, tokens_out, cost_est_usd, ok, client_name, client_norm)
       VALUES ($1,'m','t','p','mo',100,50,0.01,true,'Acme','acme'),
              ($1,'m','t','p','mo',200,100,0.02,true,'Beta','beta'),
              ($1,'m','t','p','mo',10,10,0.001,true,NULL,NULL)`,
      [tenant]);
    await admin.query("COMMIT");

    initPool(APP_URL);
    app = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier(verifierMap),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await admin.end();
    await app.close();
    await closePool();
  });

  it("owner sees every client plus the unattributed bucket", async () => {
    const r = await app.inject({ method: "GET", url: "/api/billing/summary", headers: { authorization: "Bearer tok-owner" } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    const norms = body.clients.map((c: any) => c.clientNorm);
    expect(norms).toEqual(["acme", "beta", UNATTRIBUTED]);
  });

  it("restricted consultant sees only their assigned client, never unattributed or other clients", async () => {
    const r = await app.inject({ method: "GET", url: "/api/billing/summary", headers: { authorization: "Bearer tok-cons" } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.clients.map((c: any) => c.clientNorm)).toEqual(["acme"]);
  });

  it("interviewees are blocked outright", async () => {
    const r = await app.inject({ method: "GET", url: "/api/billing/summary", headers: { authorization: "Bearer tok-iv" } });
    expect(r.statusCode).toBe(403);
  });

  it("statement: consultant can pull their own client's line items", async () => {
    const r = await app.inject({ method: "GET", url: "/api/billing/statement?client=Acme", headers: { authorization: "Bearer tok-cons" } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.callCount).toBe(1);
    expect(body.totalCostUsd).toBeCloseTo(0.01);
  });

  it("statement: consultant is 403'd for a client they aren't assigned to", async () => {
    const r = await app.inject({ method: "GET", url: "/api/billing/statement?client=Beta", headers: { authorization: "Bearer tok-cons" } });
    expect(r.statusCode).toBe(403);
  });

  it("statement: owner can pull any client", async () => {
    const r = await app.inject({ method: "GET", url: "/api/billing/statement?client=Beta", headers: { authorization: "Bearer tok-owner" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().totalCostUsd).toBeCloseTo(0.02);
  });

  // V228-audit regression: a garbage 'from' must be rejected as 400
  // invalid_input by the schema BEFORE ever reaching the DB — not surface
  // as a mislabeled query failure the way it used to.
  it("rejects a non-date 'from' with 400 invalid_input", async () => {
    const r = await app.inject({
      method: "GET", url: "/api/billing/summary?from=not-a-date",
      headers: { authorization: "Bearer tok-owner" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_input");
  });

  it("a date range that excludes all seeded rows returns an empty summary, not an error", async () => {
    const r = await app.inject({
      method: "GET", url: "/api/billing/summary?from=2099-01-01&to=2099-01-02",
      headers: { authorization: "Bearer tok-owner" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().clients).toEqual([]);
  });

  it("a wide date range covering now still returns the seeded rows", async () => {
    const r = await app.inject({
      method: "GET", url: "/api/billing/summary?from=2020-01-01&to=2099-01-01",
      headers: { authorization: "Bearer tok-owner" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().clients.map((c: any) => c.clientNorm)).toEqual(["acme", "beta", UNATTRIBUTED]);
  });
});
